/**
 * Conversation dispatcher — the single structured LLM call that classifies
 * every inbound text/voice message into one of a small catalog of actions.
 *
 * Plan 028 (Plan C from proposal `003-freeform-conversation-layer.md`).
 *
 * ## Architecture position
 *
 * This module is the **pure LLM agent** — it takes a context bundle in and
 * returns a decision out, with no side effects and no session-state access.
 * The integration layer that builds the context bundle, calls this module,
 * and routes the resulting decision to deterministic handlers lives in
 * `src/telegram/dispatcher-runner.ts`.
 *
 * ## Why one structured call, not a tool loop
 *
 * At Flexie's current scale everything the dispatcher needs fits in a single
 * prompt (recipe index ~50 lines, plan summary ~30 lines, recent turns
 * ~15 lines, action catalog ~50 lines — well under the mini-tier context
 * budget). The re-proposer (Plan 025) validated this pattern: one structured
 * call replaces a deterministic router and performs better on ambiguous
 * input. See proposal 003 § "Why one structured LLM call, not a tool-calling
 * loop" for the long-form rationale.
 *
 * ## Minimal action set (Plan 028 / v0.0.5 slice)
 *
 * Plan 028 implements exactly four actions — the ones that make the
 * dispatcher exercisable without any new capability beyond what already
 * exists today:
 *
 *   - `flow_input` — the text belongs to an active flow (recipe or plan);
 *     forward to the existing flow text handler unchanged.
 *   - `clarify` — the dispatcher can't commit to an action; ask a question.
 *   - `out_of_scope` — the text is outside the product's domain; decline
 *     honestly and offer the menu.
 *   - `return_to_flow` — the user typed a natural-language "back" command
 *     ("ok back to the plan", "let's continue planning"); re-render the
 *     last view they were on.
 *
 * Plan D will add `mutate_plan`; Plan E will add the answers / navigation /
 * measurement actions. Adding a new action means: (a) extend
 * `DispatcherAction`, (b) extend `DispatcherDecision`'s `params` union,
 * (c) add the action's description to `buildSystemPrompt`, (d) add a
 * handler in the runner. Nothing else changes.
 *
 * ## Failure modes
 *
 * The LLM can hallucinate an action outside the catalog or return
 * malformed JSON. Both cases retry once with the error fed back into the
 * conversation, then throw `DispatcherFailure`. The runner catches the
 * failure and falls back to `replyFreeTextFallback` — the same
 * surface-aware hint users get today when the legacy `handleTextInput`
 * router can't classify their message.
 */

import type { LLMProvider } from '../ai/provider.js';
import { log } from '../debug/logger.js';

// ─── Action catalog (v0.0.5 minimal slice) ─────────────────────────────────

/**
 * The set of actions the dispatcher can pick from in Plan 028. String-literal
 * union so adding an action in Plan D/E is a compile-time-breaking extension
 * (every switch on action type must be updated or TypeScript will complain).
 */
export type DispatcherAction =
  | 'flow_input'
  | 'clarify'
  | 'out_of_scope'
  | 'return_to_flow'
  | 'mutate_plan'
  | 'answer_plan_question'
  | 'answer_recipe_question'
  | 'answer_domain_question'
  | 'show_recipe'
  | 'show_plan'
  | 'show_shopping_list'
  | 'show_progress'
  | 'log_measurement';

/**
 * The set of all actions the dispatcher knows about in v0.0.5. `mutate_plan`,
 * the answer actions, the navigation actions, and `log_measurement` are all
 * listed in proposal 003's catalog but are NOT implemented in Plan 028 —
 * they belong to Plans D and E. `log_eating_out` and `log_treat` are the
 * proposal's "deferred architectural commitments" and also not in v0.0.5.
 *
 * The dispatcher's prompt enumerates the FULL proposal catalog with short
 * descriptions of every action (including the deferred ones), but marks
 * each unimplemented action with a clear "NOT AVAILABLE in v0.0.5" note.
 * The LLM's decision is then filtered: if it picks an unavailable action,
 * the runner rejects the decision and retries once with an instruction to
 * pick from the available set. This keeps the prompt consistent with the
 * proposal's full design (so Plan D/E extensions only need to flip the
 * availability flag) while the runtime behavior matches v0.0.5's scope.
 */
export const AVAILABLE_ACTIONS_V0_0_5: readonly DispatcherAction[] = [
  'flow_input',
  'clarify',
  'out_of_scope',
  'return_to_flow',
  'mutate_plan',
  'answer_plan_question',
  'answer_recipe_question',
  'answer_domain_question',
  'show_recipe',
  'show_plan',
  'show_shopping_list',
  'show_progress',
  'log_measurement',
] as const;

// ─── Context bundle ──────────────────────────────────────────────────────────

/**
 * A single entry in the recent-turns history passed into the dispatcher
 * prompt. Mirrors `ConversationTurn` from `dispatcher-runner.ts` but avoids
 * a circular import — the runner converts its internal `ConversationTurn[]`
 * into this shape when it builds the context.
 */
export interface DispatcherTurn {
  role: 'user' | 'bot';
  text: string;
}

/**
 * A minimal summary of the active flow (if any) that the dispatcher needs
 * to decide whether text is flow input or a side conversation.
 *
 * The runner builds this from `session.planFlow` / `session.recipeFlow`
 * and trims it to what the dispatcher's prompt actually uses. The shape
 * is intentionally small — full flow state is unnecessary because the
 * dispatcher never mutates it.
 */
export type ActiveFlowSummary =
  | { kind: 'none' }
  | {
      kind: 'plan';
      phase:
        | 'context'
        | 'awaiting_events'
        | 'generating_proposal'
        | 'proposal'
        | 'confirmed';
      horizonStart?: string;
      horizonEnd?: string;
      /**
       * Set when the re-proposer previously returned a clarification and
       * is waiting for the user's answer. If the user types a side
       * question instead of answering, the dispatcher must preserve this
       * field in the context for its next decision.
       */
      pendingClarification?: { question: string; originalMessage: string };
    }
  | { kind: 'recipe'; phase: 'awaiting_preferences' | 'awaiting_refinement' | 'reviewing' | 'other' }
  | { kind: 'progress'; phase: 'awaiting_measurement' | 'confirming_disambiguation' };

/**
 * A compact row for each recipe in the library, small enough to fit the
 * entire index in the dispatcher's prompt. The runner assembles this from
 * `RecipeDatabase.getAll()` — see `dispatcher-runner.ts` `buildRecipeIndex`.
 */
export interface DispatcherRecipeRow {
  slug: string;
  name: string;
  cuisine: string;
  mealTypes: ReadonlyArray<'breakfast' | 'lunch' | 'dinner'>;
  fridgeDays: number;
  freezable: boolean;
  /** Short reheat note from the recipe's YAML frontmatter. */
  reheat: string;
  /** Per-serving calories. */
  calories: number;
  /** Per-serving protein grams. */
  protein: number;
}

/**
 * A minimal summary of the active plan (if any). The dispatcher uses this
 * to answer plan questions in Plans D/E; in Plan C it's only used to decide
 * `out_of_scope` vs `clarify` when there's no obvious intent.
 */
export interface DispatcherPlanSummary {
  horizonStart: string;
  horizonEnd: string;
  /** Per-batch one-line summaries: "recipe-slug, 3 servings, Thu–Sat dinner". */
  batchLines: string[];
  /** Flex slots as "day mealTime (+N cal flex)". */
  flexLines: string[];
  /** Events as "day mealTime: name (~N cal)". */
  eventLines: string[];
  /** Weekly calorie target (from config). */
  weeklyCalorieTarget: number;
  /** Weekly protein target (from config). */
  weeklyProteinTarget: number;
}

/**
 * The input passed to `dispatchMessage` on every call. Everything the agent
 * knows about the world lives here. The runner builds it fresh for every
 * inbound message.
 */
export interface DispatcherContext {
  /** Server-local ISO date for "today" — proposal 003's single-user simplification. */
  today: string;
  /** Server-local ISO timestamp for "right now". */
  now: string;
  /** Coarse five-value surface enum from `BotCoreSession`. */
  surface: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null;
  /**
   * Precise last-view descriptor from Plan 027. May be `undefined` if the
   * user has not yet seen any navigation view (e.g., fresh session after
   * `/start` with no menu tap).
   */
  lastRenderedView?: {
    surface: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress';
    view: string;
    [key: string]: unknown;
  };
  lifecycle: 'no_plan' | 'planning' | 'upcoming' | 'active_early' | 'active_mid' | 'active_ending';
  activeFlow: ActiveFlowSummary;
  recentTurns: DispatcherTurn[];
  /** `null` when no plan exists; present for `upcoming` and `active_*`. */
  planSummary: DispatcherPlanSummary | null;
  recipeIndex: DispatcherRecipeRow[];
  /** Which actions are currently reachable — enforced after parsing the LLM response. */
  allowedActions: readonly DispatcherAction[];
  /**
   * Plan 029: Set when the post-confirmation mutation applier returned a
   * clarification ("lunch or dinner?") and the user's next message is likely
   * the answer. The dispatcher uses this to route the terse answer to
   * `mutate_plan` rather than treating it as unrelated text.
   */
  pendingPostConfirmationClarification?: {
    question: string;
    originalRequest: string;
  };
}

// ─── Decision output ──────────────────────────────────────────────────────────

/**
 * The dispatcher's structured output. Discriminated on `action`. `params` is
 * narrow in Plan 028 because the four minimal actions don't need many
 * parameters; Plan D/E extensions will carry richer params (e.g., `request`
 * for `mutate_plan`, `recipe_slug` for `show_recipe`).
 */
export type DispatcherDecision =
  | {
      action: 'flow_input';
      params: Record<string, never>;
      /**
       * Always undefined for `flow_input` — the downstream flow handler
       * authors the user-visible response, not the dispatcher.
       */
      response?: undefined;
      reasoning: string;
    }
  | {
      action: 'clarify';
      params: Record<string, never>;
      /** The clarifying question the dispatcher wants to ask. Required for this action. */
      response: string;
      reasoning: string;
    }
  | {
      action: 'out_of_scope';
      params: { category?: string };
      /** The dispatcher-authored decline message. Required for this action. */
      response: string;
      reasoning: string;
    }
  | {
      action: 'return_to_flow';
      params: Record<string, never>;
      /** Always undefined — the handler re-renders the last view, it doesn't emit new text. */
      response?: undefined;
      reasoning: string;
    }
  | {
      action: 'mutate_plan';
      /**
       * Plan 029: `request` is the user's raw natural-language mutation. The
       * applier forwards it unchanged to the re-proposer (in the in-session
       * case) or to the post-confirmation applier (which wraps the re-proposer
       * with the split-aware adapter). The dispatcher does NOT resolve dates,
       * meal times, or recipe references — the re-proposer has strictly more
       * context for that work. The dispatcher's only job is to classify the
       * intent and pass through the request verbatim.
       */
      params: { request: string };
      response?: undefined;
      reasoning: string;
    }
  | {
      action: 'answer_plan_question';
      params: { question: string };
      /** The dispatcher-authored answer text. Required. */
      response: string;
      reasoning: string;
    }
  | {
      action: 'answer_recipe_question';
      params: { question: string; recipe_slug?: string };
      response: string;
      reasoning: string;
    }
  | {
      action: 'answer_domain_question';
      params: { question: string };
      response: string;
      reasoning: string;
    }
  | {
      action: 'show_recipe';
      params: { recipe_slug: string };
      response?: undefined;
      reasoning: string;
    }
  | {
      action: 'show_plan';
      params: {
        screen: 'next_action' | 'week_overview' | 'day_detail';
        /** Required when screen='day_detail'; ISO date YYYY-MM-DD. */
        day?: string;
      };
      response?: undefined;
      reasoning: string;
    }
  | {
      action: 'show_shopping_list';
      params: {
        scope: 'next_cook' | 'full_week' | 'recipe' | 'day';
        /** Required when scope='recipe'. */
        recipe_slug?: string;
        /** Required when scope='day'; ISO date YYYY-MM-DD. */
        day?: string;
      };
      response?: undefined;
      reasoning: string;
    }
  | {
      action: 'show_progress';
      params: { view: 'log_prompt' | 'weekly_report' };
      response?: undefined;
      reasoning: string;
    }
  | {
      action: 'log_measurement';
      params: {
        /** Optional weight in kg (positive number). */
        weight?: number;
        /** Optional waist in cm (positive number). */
        waist?: number;
      };
      response?: undefined;
      reasoning: string;
    };

/**
 * Thrown when `dispatchMessage` fails twice in a row (parse error, invalid
 * action choice, or LLM error). The runner catches this and falls back to
 * `replyFreeTextFallback`.
 */
export class DispatcherFailure extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DispatcherFailure';
  }
}

// ─── Prompt building ─────────────────────────────────────────────────────────

/**
 * System prompt — stable across every call. Describes the full proposal 003
 * catalog (including deferred actions) but marks each one with its v0.0.5
 * availability. Keeping deferred entries in the prompt is deliberate: it
 * gives the LLM the full mental model of the product's intended vocabulary
 * so it can clarify honestly when a user asks for something that isn't built
 * yet ("I want to log a Snickers" → `clarify` with an honest "coming later"
 * response, not a confused flow_input).
 */
function buildSystemPrompt(): string {
  return `You are Flexie's conversation dispatcher. Every inbound user message is routed through you. You read the user's message plus a context bundle (surface, active flow, recent turns, plan summary, recipe library) and pick exactly ONE action from a catalog. You output a JSON object with the action, its parameters, and (for inline-answer actions) the user-visible response text.

Flexie is a flexible-diet meal planning bot. Your job is to classify intent accurately, preserve in-progress flow work, and decline honestly when a request is outside the product's current scope.

## OUTPUT SHAPE

You MUST return a single JSON object with exactly these fields:

{
  "action": string,          // one of the action names listed below
  "params": object,          // action-specific parameters (may be empty: {})
  "response": string | null, // user-visible reply for inline-answer actions; null otherwise
  "reasoning": string        // brief explanation, never shown to the user
}

Do not wrap the JSON in markdown. Do not add text before or after. Return JSON only.

## ACTION CATALOG

Each action has a v0.0.5 availability marker. If you would otherwise pick an action marked NOT AVAILABLE, pick "clarify" or "out_of_scope" with an honest message about the capability not being built yet.

### flow_input  (AVAILABLE)
The user's text is input the active flow expects: an event description during plan_awaiting_events, a mutation request during plan_proposal, a preference description during recipe_awaiting_preferences, a refinement request during recipe_awaiting_refinement, or a question during recipe_reviewing.
Params: {} (empty)
Response: null
When to pick: the active flow is in a text-accepting phase AND the user's message is structurally what that phase expects.
When NOT to pick: no active flow; or the user is clearly asking a side question that does not advance the flow; or the user is cancelling / returning to a prior view.

### clarify  (AVAILABLE)
You cannot confidently pick one action. Ask the user a clarifying question. Leave all state unchanged — the next message will be dispatched fresh with your question in the recent-turns history.
Params: {} (empty)
Response: the clarifying question text (required, user-visible)
When to pick: truly ambiguous phrasings, missing anchors ("earlier"), requests that could mean multiple catalog entries, or capabilities not yet built in v0.0.5 ("log my Snickers" → clarify with honest deferral).
When NOT to pick: obvious in-domain requests with enough context to act.

### out_of_scope  (AVAILABLE)
The user's message is outside Flexie's domain — weather, stock prices, general chit-chat, live web data, unrelated small talk. Decline honestly, briefly, and offer the menu.
Params: { "category": optional short label for the topic, e.g., "weather" }
Response: a short, specific decline (required, user-visible). Template: "I help with meal planning, recipes, and nutrition — not {category}. Try: 'change Thursday dinner' or tap a button."
When to pick: the message is clearly not about meal planning, recipes, nutrition, cooking, shopping for groceries, or the user's weight/measurements.
When NOT to pick: food / nutrition / plan / recipe / shopping / measurement questions, even if the exact capability isn't built (use clarify for those).

### return_to_flow  (AVAILABLE)
Natural-language back button. The user typed a phrase like "ok back to the plan", "let's continue planning", "resume planning", "keep going", "back to my recipes", "show me the plan again". Your handler will re-render the user's last view (active flow's last rendered screen, or the navigation view captured in lastRenderedView).
Params: {} (empty)
Response: null (the handler renders the previous view, no new text needed)
When to pick: short phrases expressing "go back" intent AND there is something to go back to (active flow OR recent lastRenderedView).
When NOT to pick: phrases matching the cancel set — "never mind", "forget it", "not now", "stop", "i'll do this later", "cancel". Those phrases route through the planning flow's cancel handler BEFORE this dispatcher runs; you will never see them when a planning flow is active. If you see "nevermind" without an active flow, prefer out_of_scope over return_to_flow (there is nothing to cancel and nothing meaningful to return to).

### mutate_plan  (AVAILABLE)
The user wants to change the plan in any way that requires the re-proposer agent: move a flex meal, swap a recipe, add or remove an event, shift a batch, absorb a real-life deviation like "I'm eating out tonight", "friend invited me for dinner", "I'm out of salmon", "my partner ate half the tagine", etc.
Params: { "request": "<user's raw natural-language mutation — pass through verbatim, do NOT resolve dates or recipe refs>" }
Response: null (the applier renders the proposed change with a Confirm/Adjust keyboard)
When to pick:
  - During active planning (phase=proposal): any mutation request, any rephrasing of "change the plan", including things the user could have said through the re-proposer before — "move the flex", "swap the chicken", "add an event".
  - Post-confirmation (no active flow, lifecycle=active_*): any real-life deviation statement or plan-change request. "I'm eating out tonight." "Swap tomorrow's dinner for fish." "Move the flex to Sunday." "I already ate the chicken." "Skip Thursday's cooking." All mutate_plan, all the time.
  - During awaiting_events: rarely — the user's text there is usually event input for flow_input, but if they clearly say "actually, change the plan to X" or "forget the events, just do Y" it's mutate_plan.
When NOT to pick:
  - Pure questions without an imperative request ("why so much pasta?" → clarify, answer actions deferred).
  - Requests that name specific recipes but are read-only ("show me the tagine recipe" → NOT mutate_plan — that's show_recipe in Plan E; for v0.0.5, out_of_scope or clarify with a "tap a button" hint).
  - Requests that are clearly events the planning flow is already expecting ("dinner out Friday" during awaiting_events → flow_input to reach the event parser).
  - Navigation ("back to the plan" → return_to_flow).
  - Out-of-domain ("what's the weather?" → out_of_scope).

Precedence with flow_input: during an active planning proposal phase, "move the flex to Sunday" is structurally a mutation request that the existing re-proposer path handles. The applier's in-session branch delegates to the same re-proposer that flow_input would have reached. Pick mutate_plan in both cases — the applier routes by session state, not by the dispatcher's choice. Picking mutate_plan during active planning is NOT a mistake; the applier handles both modes uniformly.

### answer_plan_question  (AVAILABLE)
The user is asking a factual question about their current plan that can be answered from the PLAN SUMMARY in your context — "when's my next cook day?", "what's planned for Thursday dinner?", "what's my weekly target?", "which days am I cooking?". You author the answer inline.
Params: { "question": string }  (echo the user's question for downstream logging)
Response: the answer text (required, user-visible). Be brief, factual, and ONLY use numbers/facts that are in the PLAN SUMMARY context. NEVER invent quantities, dates, or recipe names that aren't in the context. If the question asks for something not in the summary (e.g., "what ingredients do I still need?"), pick show_shopping_list with scope=next_cook instead.
When to pick: factual questions about the plan whose answer is mechanically derivable from the summary.
When NOT to pick: "why" questions about plan composition (the summary has no reasoning history — pick clarify with an honest "I can tell you what's in your plan but not why"); ingredient-level questions (route to show_shopping_list); product-meta questions like "what's a flex meal?" (pick out_of_scope with an honest "I don't explain product concepts yet").

### answer_recipe_question  (AVAILABLE)
The user is asking about a recipe — storage ("can I freeze the tagine?"), reheating ("how do I reheat the salmon pasta?"), basic technique, or substitutions. The recipe data you can use is in the RECIPE LIBRARY index in your context, which carries fridgeDays, freezable, reheat, mealTypes, and per-serving macros. For substitution questions, your general food knowledge is acceptable as long as the answer doesn't claim to know the recipe's specific ingredient list.
Params: { "question": string, "recipe_slug": string? }  (set recipe_slug when the question references a specific recipe by name or when the user is on a recipe view)
Response: the answer text (required). Use ONLY recipe-index data for storage/freezable/reheat questions. For substitution questions, give a brief generic answer.
When to pick: recipe-specific questions whose answer is in the recipe index data, OR generic substitution questions.
When NOT to pick: questions about how the recipe fits the plan (route to answer_plan_question); requests to modify the recipe in the plan (route to mutate_plan).

### answer_domain_question  (AVAILABLE)
The user is asking a general food/nutrition question that isn't specifically about their plan or library recipes — "protein in 100g chicken?", "what's the difference between brown and white rice?", "why does protein make me full?". Your general food knowledge is the answer source.
Params: { "question": string }
Response: the answer text (required). Brief. Non-judgmental. Non-lecturing. Aligned with Flexie's tone — flexible, no food demonization, hyper-palatable/ultra-processed foods are the only category we're skeptical of.
When to pick: in-domain food/nutrition questions outside the user's specific plan + library scope.
When NOT to pick: out-of-domain (weather, stock prices, etc. → out_of_scope); plan-specific questions (→ answer_plan_question); recipe-specific (→ answer_recipe_question).

### show_recipe  (AVAILABLE)
The user wants to see a specific recipe by name — "show me the calamari pasta", "let me see the lemon chicken", "the tagine one". You fuzzy-match against the RECIPE LIBRARY index in your context and pick the slug. The handler will render the cook view if the recipe is in an active batch, or the library view otherwise.
Params: { "recipe_slug": string }  (the slug from the RECIPE LIBRARY, not a free-form name)
Response: null (the handler renders the view)
When to pick: any natural-language request to "see" / "show" / "view" / "look at" a specific recipe.
When NOT to pick: requests to modify a recipe (→ mutate_plan); requests to see the plan or shopping list (→ show_plan / show_shopping_list); requests to browse the library generally (→ out_of_scope with "tap 📖 My Recipes").
**Disambiguation:** if the user's reference matches multiple library slugs (e.g., "the chicken one" with two chicken recipes), pick clarify with the candidate names. The handler's multi-batch tie-break picks soonest cook day automatically — you don't need to specify it.

### show_plan  (AVAILABLE)
The user wants to see their plan — "show me the plan", "what's tomorrow looking like?", "what's for dinner Thursday?". You pick the appropriate screen and (for day_detail) resolve the day to an ISO date.
Params: { "screen": "next_action" | "week_overview" | "day_detail", "day": string? }
- "next_action" — the user wants the brief "what's next" view ("what's next?", "what should I do?")
- "week_overview" — the full week view ("show me the week", "the whole plan", "everything")
- "day_detail" — a specific day's detail ("Thursday", "tomorrow", "Friday's meals"). REQUIRES "day" as ISO date YYYY-MM-DD. Resolve relative day names against the PLAN SUMMARY's horizon dates: "tomorrow" = today + 1, "Thursday" = the next Thursday in or after the horizon. If genuinely ambiguous, pick clarify.
Response: null
When to pick: any "show / view / what's" request about the plan structure.
When NOT to pick: questions about a specific batch's recipe (→ show_recipe); modifications (→ mutate_plan); shopping (→ show_shopping_list).

### show_shopping_list  (AVAILABLE)
The user wants the shopping list — "shopping list", "what do I need to buy?", "shopping for Friday", "everything I need this week", "shopping for the tagine".
Params: { "scope": "next_cook" | "full_week" | "recipe" | "day", "recipe_slug": string?, "day": string? }
- "next_cook" — the default "what to buy for the next cook day" ("shopping list", "what do I need to buy?")
- "full_week" — the entire horizon ("shopping for the week", "everything for this week", "the full list")
- "recipe" — one recipe across all batches ("shopping for the tagine", "what do I need for the calamari pasta?"). REQUIRES recipe_slug.
- "day" — one specific day ("shopping for Friday", "what to buy on Wednesday"). REQUIRES day as ISO date.
Response: null
When to pick: any shopping-list request.
When NOT to pick: ingredient-level questions about a specific batch ("how much beef in the tagine?" → answer_recipe_question).

### show_progress  (AVAILABLE)
The user wants to see or interact with progress (weight/waist measurements).
Params: { "view": "log_prompt" | "weekly_report" }
- "log_prompt" — open the measurement input prompt ("log my weight", "I want to log a measurement")
- "weekly_report" — show the weekly progress report ("how am I doing?", "show me the report", "weekly progress")
Response: null
When to pick: explicit "log" / "show progress" / "report" requests.
When NOT to pick: actually-typed-numeric measurements ("82.3", "82.3 / 91" — see log_measurement). When the user asks "log my weight" without giving a number, pick show_progress({view: 'log_prompt'}).

### log_measurement  (AVAILABLE)
The user typed numeric values that look like a weight and/or waist — "82.3", "82.3 today", "weight 82.3 waist 91", "82.3 / 91", "log 82.3". You extract the numbers into params.
Params: { "weight": number?, "waist": number? }  (one or both)
Response: null
When to pick: text contains a number that looks like a weight or waist measurement.
When NOT to pick: numbers that are clearly part of a different intent ("move dinner to day 3" — that's a mutation_plan request); numbers without unit context that could be anything else.
**Numeric pre-filter note:** when progressFlow.phase === 'awaiting_measurement', the runner pre-filter handles numeric input BEFORE you run — you will only see log_measurement-shaped messages from OTHER surfaces (the user types "82.3" while looking at the plan view, not after tapping 📊 Progress).
**Day:** the day is always today (server-local). No day parameter.

### log_eating_out  (DEFERRED — proposal commitment, no implementation in v0.0.5)
### log_treat  (DEFERRED — proposal commitment, no implementation in v0.0.5)
Future: record restaurant meals / treats. For v0.0.5, pick clarify with honest deferral.

## NO-FABRICATION RULES (load-bearing)

For answer_plan_question: NEVER invent batches, days, recipes, or numbers that aren't in PLAN SUMMARY. If the answer requires a number not in the summary, pick clarify with "I can't tell from your plan summary alone" or pick show_shopping_list / show_plan / show_recipe to render the actual data instead.

For answer_recipe_question: NEVER invent ingredient quantities, calorie counts, or recipe steps. The recipe index has macros, freezability, fridge days, and reheat instructions — use those. For everything else, give a brief generic answer that doesn't claim to know the specific recipe's content.

For answer_domain_question: NEVER cite specific studies, brands, or fabricate authoritative claims. Brief, generic, common-sense answers only. If the question genuinely needs lookup ("how much vitamin C in 100g kiwi?"), give your best general estimate with appropriate hedge.

A wrong answer that ADMITS uncertainty is much better than a confident wrong answer.

## STATE PRESERVATION — LOAD-BEARING RULES

1. You never clear planFlow or recipeFlow. Your decision is a classification, not a mutation. The runner enforces this.
2. flow_input during an active flow routes back into that flow — it does NOT start a new flow. Never pick flow_input when there is no active flow.
3. When the active flow has a pendingClarification (a sub-agent is waiting for an answer), and the user's text looks like that answer, pick flow_input so the flow consumes it. If the user's text is clearly a side question instead, pick the appropriate side action — the pendingClarification stays preserved for a later turn.
4. recent turns give you referential threads. "What about the lamb?" after "can I freeze the tagine?" is a follow-up question, not an ambiguous orphan.

## FEW-SHOT EXAMPLES

(Active flow: plan / phase: proposal)
User: "Put the flex meal on Sunday instead"
→ { "action": "mutate_plan", "params": { "request": "Put the flex meal on Sunday instead" }, "response": null, "reasoning": "Plan mutation during active proposal phase; applier's in-session branch delegates to the re-proposer." }

(Active flow: none / lifecycle: active_mid)
User: "I'm eating out tonight, friend invited me"
→ { "action": "mutate_plan", "params": { "request": "I'm eating out tonight, friend invited me" }, "response": null, "reasoning": "Real-life deviation on a confirmed plan; applier's post-confirmation branch runs the adapter + re-proposer and presents a diff for confirmation." }

(Active flow: none / lifecycle: active_mid)
User: "swap tomorrow's dinner for something lighter"
→ { "action": "mutate_plan", "params": { "request": "swap tomorrow's dinner for something lighter" }, "response": null, "reasoning": "Post-confirmation recipe swap request; pass through verbatim." }

(Active flow: none / lifecycle: active_mid)
User: "move the flex to Sunday"
→ { "action": "mutate_plan", "params": { "request": "move the flex to Sunday" }, "response": null, "reasoning": "Post-confirmation flex move." }

(Active flow: plan / phase: proposal)
User: "why so much pasta this week?"
→ { "action": "clarify", "params": {}, "response": "I can tell you what's in your plan but not why — the plan summary doesn't include composition reasoning. Want to swap a recipe or make a change?", "reasoning": "'Why' question about plan composition — the summary has no reasoning history, so answer_plan_question can't answer. Clarify honestly." }

(Active flow: none / lifecycle: active_mid)
User: "ok back to the plan"
→ { "action": "return_to_flow", "params": {}, "response": null, "reasoning": "Natural-language back command with recent plan view in lastRenderedView." }

(Active flow: none / lifecycle: active_mid)
User: "what's the weather today?"
→ { "action": "out_of_scope", "params": { "category": "weather" }, "response": "I help with meal planning, recipes, and nutrition — not weather. Try: 'change Thursday dinner' or tap a button.", "reasoning": "Clearly out-of-domain request." }

(Active flow: none / lifecycle: no_plan)
User: "hmm"
→ { "action": "clarify", "params": {}, "response": "What would you like to do? I can help you plan a week of meals, browse your recipes, or log a measurement.", "reasoning": "Too short to classify; no active flow and no clear intent." }

(Active flow: plan / phase: awaiting_events, pendingClarification: null)
User: "dinner out with friends on Friday"
→ { "action": "flow_input", "params": {}, "response": null, "reasoning": "Event description during awaiting_events — forward to event handler." }

(Active flow: plan / phase: awaiting_events)
User: "is the breakfast locked?"
→ { "action": "answer_plan_question", "params": { "question": "is the breakfast locked?" }, "response": "Yes — your breakfast recipe is fixed for the week. It's the same every day and doesn't change between proposals.", "reasoning": "Factual plan question during awaiting_events; answer_plan_question is available." }

(Active flow: none / lifecycle: active_mid)
User: "when's my next cook day?"
→ { "action": "answer_plan_question", "params": { "question": "when's my next cook day?" }, "response": "Your next cook day is Thursday — you're cooking the Greek lemon chicken batch (3 servings, Thu/Fri/Sat dinner).", "reasoning": "Mechanical answer from the plan summary: scan batches for soonest eatingDays[0] in the future." }

(Active flow: none / lifecycle: active_mid / lastRenderedView: cooking/cook_view)
User: "can I freeze this?"
→ { "action": "answer_recipe_question", "params": { "question": "can I freeze this?", "recipe_slug": "tagine" }, "response": "Yes — beef tagine freezes well. Cool fully, portion into containers, and reheat from frozen in a covered pan with a splash of water. The recipe index marks it freezable=true.", "reasoning": "User is on a tagine cook view; recipe index shows freezable=true." }

(Active flow: none / lifecycle: active_mid)
User: "what's a substitute for tahini?"
→ { "action": "answer_domain_question", "params": { "question": "what's a substitute for tahini?" }, "response": "Cashew butter or sunflower seed butter both work — similar nutty flavor and texture. Greek yogurt is a thinner option if you want a looser sauce.", "reasoning": "Generic substitution question, no plan or specific recipe context needed." }

(Active flow: none / lifecycle: active_mid)
User: "show me the calamari pasta"
→ { "action": "show_recipe", "params": { "recipe_slug": "calamari-pasta" }, "response": null, "reasoning": "Fuzzy match in recipe index → calamari-pasta. Handler renders cook view if in active plan, library view otherwise." }

(Active flow: none / lifecycle: active_mid)
User: "what's Thursday looking like?"
→ { "action": "show_plan", "params": { "screen": "day_detail", "day": "2026-04-09" }, "response": null, "reasoning": "Today is 2026-04-07 (Tue), next Thursday is 2026-04-09. Resolve the day name against the plan horizon and pick day_detail." }

(Active flow: none / lifecycle: active_mid)
User: "shopping list for the tagine"
→ { "action": "show_shopping_list", "params": { "scope": "recipe", "recipe_slug": "tagine" }, "response": null, "reasoning": "Recipe-scoped shopping list request." }

(Active flow: none / lifecycle: active_mid)
User: "how am I doing this week?"
→ { "action": "show_progress", "params": { "view": "weekly_report" }, "response": null, "reasoning": "Weekly report request." }

(Active flow: none / lifecycle: active_mid / surface: plan)
User: "82.3 today"
→ { "action": "log_measurement", "params": { "weight": 82.3 }, "response": null, "reasoning": "Numeric weight input from a non-progress surface; cross-surface measurement logging." }

Return only the JSON object. No prose.`;
}

/**
 * Builds the per-call user prompt carrying the full context bundle plus the
 * user's current message. The ordering is: date → surface + lifecycle →
 * active flow → recent turns → plan summary → recipe index → allowed
 * actions → user message. Placing the user message LAST is deliberate: it
 * anchors the model's attention on what to classify while the earlier
 * sections establish the frame.
 *
 * Recipe index is formatted as one line per recipe, compact enough that 50
 * recipes fit in under 400 tokens. Plan summary reuses the pre-formatted
 * lines the runner built.
 */
function buildUserPrompt(ctx: DispatcherContext, userText: string): string {
  const parts: string[] = [];

  parts.push(`## TODAY\n${ctx.today}  (server-local; assume single-user.)`);

  parts.push(
    `## SURFACE\nsurfaceContext: ${ctx.surface ?? 'none'}\nlifecycle: ${ctx.lifecycle}\nlastRenderedView: ${
      ctx.lastRenderedView ? JSON.stringify(ctx.lastRenderedView) : 'none'
    }`,
  );

  parts.push(`## ACTIVE FLOW\n${formatActiveFlow(ctx.activeFlow)}`);

  if (ctx.pendingPostConfirmationClarification) {
    parts.push(
      `## Outstanding clarification (post-confirmation mutation)\n` +
      `The re-proposer asked: "${ctx.pendingPostConfirmationClarification.question}"\n` +
      `Original request: "${ctx.pendingPostConfirmationClarification.originalRequest}"\n` +
      `The user's next message is likely the answer to this question. ` +
      `Pick mutate_plan with the user's text as the request — the applier ` +
      `will prepend the original request automatically.`,
    );
  }

  parts.push(
    `## RECENT TURNS (oldest first)\n${
      ctx.recentTurns.length === 0
        ? '(no prior turns)'
        : ctx.recentTurns
            .map((t) => `[${t.role}] ${t.text.slice(0, 300)}`)
            .join('\n')
    }`,
  );

  parts.push(`## PLAN SUMMARY\n${formatPlanSummary(ctx.planSummary)}`);

  parts.push(
    `## RECIPE LIBRARY (${ctx.recipeIndex.length} recipes)\n${
      ctx.recipeIndex.length === 0
        ? '(no recipes yet)'
        : ctx.recipeIndex.map(formatRecipeRow).join('\n')
    }`,
  );

  parts.push(
    `## ALLOWED ACTIONS\n${ctx.allowedActions.join(', ')}\n(If you would pick a NOT AVAILABLE action, choose clarify or out_of_scope instead with an honest deferral.)`,
  );

  parts.push(`## USER MESSAGE\n${userText}`);

  return parts.join('\n\n');
}

function formatActiveFlow(flow: ActiveFlowSummary): string {
  switch (flow.kind) {
    case 'none':
      return 'none';
    case 'plan': {
      const parts = [`plan / phase=${flow.phase}`];
      if (flow.horizonStart && flow.horizonEnd) {
        parts.push(`horizon=${flow.horizonStart}..${flow.horizonEnd}`);
      }
      if (flow.pendingClarification) {
        parts.push(
          `pendingClarification: ${flow.pendingClarification.question} (original: ${flow.pendingClarification.originalMessage})`,
        );
      }
      return parts.join(' / ');
    }
    case 'recipe':
      return `recipe / phase=${flow.phase}`;
    case 'progress':
      return `progress / phase=${flow.phase}`;
  }
}

function formatPlanSummary(plan: DispatcherPlanSummary | null): string {
  if (!plan) return '(no active plan)';
  const lines = [
    `horizon: ${plan.horizonStart}..${plan.horizonEnd}`,
    `weekly target: ${plan.weeklyCalorieTarget} kcal / ${plan.weeklyProteinTarget}g protein`,
    `batches:`,
    ...(plan.batchLines.length ? plan.batchLines.map((l) => `  - ${l}`) : ['  (none)']),
    `flex slots:`,
    ...(plan.flexLines.length ? plan.flexLines.map((l) => `  - ${l}`) : ['  (none)']),
    `events:`,
    ...(plan.eventLines.length ? plan.eventLines.map((l) => `  - ${l}`) : ['  (none)']),
  ];
  return lines.join('\n');
}

function formatRecipeRow(r: DispatcherRecipeRow): string {
  return `${r.slug} | ${r.name} | ${r.cuisine} | ${r.mealTypes.join('/')} | ${r.calories}kcal ${r.protein}gP | fridge=${r.fridgeDays}d freezable=${r.freezable} | reheat: ${r.reheat.slice(0, 50)}`;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parses the raw LLM response into a `DispatcherDecision` and validates:
 *
 *   1. The top-level shape has `action`, `params`, `reasoning`.
 *   2. The action is a known member of `DispatcherAction`.
 *   3. The action is in `allowedActions` (v0.0.5 minimal set).
 *   4. Inline-answer actions (clarify, out_of_scope) have a non-empty
 *      `response` string.
 *   5. flow_input and return_to_flow have `response === null` (or absent,
 *      which we treat as null).
 *
 * Throws on any failure so the retry loop can feed the error back into
 * the LLM conversation.
 */
function parseDecision(
  raw: string,
  allowedActions: readonly DispatcherAction[],
): DispatcherDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Dispatcher response was not valid JSON: ${(err as Error).message}. Response body: ${raw.slice(0, 500)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Dispatcher response must be a JSON object.');
  }
  const obj = parsed as Record<string, unknown>;

  const action = obj.action;
  if (typeof action !== 'string') {
    throw new Error('Dispatcher response missing string "action" field.');
  }

  const knownActions: readonly DispatcherAction[] = [
    'flow_input',
    'clarify',
    'out_of_scope',
    'return_to_flow',
    'mutate_plan',
    'answer_plan_question',
    'answer_recipe_question',
    'answer_domain_question',
    'show_recipe',
    'show_plan',
    'show_shopping_list',
    'show_progress',
    'log_measurement',
  ];
  if (!knownActions.includes(action as DispatcherAction)) {
    throw new Error(
      `Dispatcher picked unknown action "${action}". Must be one of: ${knownActions.join(', ')}.`,
    );
  }

  if (!allowedActions.includes(action as DispatcherAction)) {
    throw new Error(
      `Dispatcher picked disallowed action "${action}" — not in current allowedActions [${allowedActions.join(', ')}]. Choose from the allowed list.`,
    );
  }

  const params = (obj.params ?? {}) as Record<string, unknown>;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('Dispatcher response "params" must be an object.');
  }

  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';

  const rawResponse = obj.response;
  let response: string | undefined;
  if (typeof rawResponse === 'string') {
    response = rawResponse;
  } else if (rawResponse === null || rawResponse === undefined) {
    response = undefined;
  } else {
    throw new Error('Dispatcher response "response" field must be a string or null.');
  }

  // Per-action validation.
  switch (action) {
    case 'flow_input':
      if (response !== undefined && response !== '') {
        throw new Error('flow_input must have response: null (the flow handler authors the reply).');
      }
      return { action: 'flow_input', params: {}, reasoning };

    case 'clarify':
      if (!response) {
        throw new Error('clarify requires a non-empty "response" string (the clarifying question).');
      }
      return { action: 'clarify', params: {}, response, reasoning };

    case 'out_of_scope': {
      if (!response) {
        throw new Error('out_of_scope requires a non-empty "response" string (the decline message).');
      }
      const category = typeof params.category === 'string' ? params.category : undefined;
      return {
        action: 'out_of_scope',
        params: category ? { category } : {},
        response,
        reasoning,
      };
    }

    case 'return_to_flow':
      if (response !== undefined && response !== '') {
        throw new Error('return_to_flow must have response: null (the handler re-renders the last view).');
      }
      return { action: 'return_to_flow', params: {}, reasoning };

    case 'mutate_plan': {
      if (response !== undefined && response !== '') {
        throw new Error('mutate_plan must have response: null (the applier renders the confirmation UI).');
      }
      const request = typeof params.request === 'string' ? params.request.trim() : '';
      if (!request) {
        throw new Error('mutate_plan requires a non-empty "request" string in params.');
      }
      return {
        action: 'mutate_plan',
        params: { request },
        reasoning,
      };
    }

    case 'answer_plan_question': {
      if (!response) {
        throw new Error('answer_plan_question requires a non-empty "response" string (the answer text).');
      }
      const question = typeof params.question === 'string' ? params.question : undefined;
      if (!question) {
        throw new Error('answer_plan_question requires params.question (string).');
      }
      return {
        action: 'answer_plan_question',
        params: { question },
        response,
        reasoning,
      };
    }

    case 'answer_recipe_question': {
      if (!response) {
        throw new Error('answer_recipe_question requires a non-empty "response" string.');
      }
      const question = typeof params.question === 'string' ? params.question : undefined;
      if (!question) {
        throw new Error('answer_recipe_question requires params.question (string).');
      }
      const recipe_slug = typeof params.recipe_slug === 'string' ? params.recipe_slug : undefined;
      return {
        action: 'answer_recipe_question',
        params: recipe_slug ? { question, recipe_slug } : { question },
        response,
        reasoning,
      };
    }

    case 'answer_domain_question': {
      if (!response) {
        throw new Error('answer_domain_question requires a non-empty "response" string.');
      }
      const question = typeof params.question === 'string' ? params.question : undefined;
      if (!question) {
        throw new Error('answer_domain_question requires params.question (string).');
      }
      return {
        action: 'answer_domain_question',
        params: { question },
        response,
        reasoning,
      };
    }

    case 'show_recipe': {
      if (response !== undefined && response !== '') {
        throw new Error('show_recipe must have response: null (the handler renders the view).');
      }
      const recipe_slug = typeof params.recipe_slug === 'string' ? params.recipe_slug : undefined;
      if (!recipe_slug) {
        throw new Error('show_recipe requires params.recipe_slug (string).');
      }
      return {
        action: 'show_recipe',
        params: { recipe_slug },
        reasoning,
      };
    }

    case 'show_plan': {
      if (response !== undefined && response !== '') {
        throw new Error('show_plan must have response: null.');
      }
      const screen = params.screen;
      if (screen !== 'next_action' && screen !== 'week_overview' && screen !== 'day_detail') {
        throw new Error('show_plan requires params.screen ∈ {next_action, week_overview, day_detail}.');
      }
      const day = typeof params.day === 'string' ? params.day : undefined;
      if (screen === 'day_detail' && !day) {
        throw new Error('show_plan with screen=day_detail requires params.day (ISO date string).');
      }
      if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        throw new Error('show_plan params.day must be ISO date YYYY-MM-DD.');
      }
      return {
        action: 'show_plan',
        params: day ? { screen, day } : { screen },
        reasoning,
      };
    }

    case 'show_shopping_list': {
      if (response !== undefined && response !== '') {
        throw new Error('show_shopping_list must have response: null.');
      }
      const scope = params.scope;
      if (scope !== 'next_cook' && scope !== 'full_week' && scope !== 'recipe' && scope !== 'day') {
        throw new Error('show_shopping_list requires params.scope ∈ {next_cook, full_week, recipe, day}.');
      }
      const recipe_slug = typeof params.recipe_slug === 'string' ? params.recipe_slug : undefined;
      const day = typeof params.day === 'string' ? params.day : undefined;
      if (scope === 'recipe' && !recipe_slug) {
        throw new Error('show_shopping_list with scope=recipe requires params.recipe_slug (string).');
      }
      if (scope === 'day' && !day) {
        throw new Error('show_shopping_list with scope=day requires params.day (ISO date string).');
      }
      if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        throw new Error('show_shopping_list params.day must be ISO date YYYY-MM-DD.');
      }
      const out: { scope: typeof scope; recipe_slug?: string; day?: string } = { scope };
      if (recipe_slug) out.recipe_slug = recipe_slug;
      if (day) out.day = day;
      return {
        action: 'show_shopping_list',
        params: out,
        reasoning,
      };
    }

    case 'show_progress': {
      if (response !== undefined && response !== '') {
        throw new Error('show_progress must have response: null.');
      }
      const view = params.view;
      if (view !== 'log_prompt' && view !== 'weekly_report') {
        throw new Error('show_progress requires params.view ∈ {log_prompt, weekly_report}.');
      }
      return {
        action: 'show_progress',
        params: { view },
        reasoning,
      };
    }

    case 'log_measurement': {
      if (response !== undefined && response !== '') {
        throw new Error('log_measurement must have response: null.');
      }
      const weight = typeof params.weight === 'number' ? params.weight : undefined;
      const waist = typeof params.waist === 'number' ? params.waist : undefined;
      if (weight === undefined && waist === undefined) {
        throw new Error('log_measurement requires at least one of params.weight or params.waist (numbers).');
      }
      if (weight !== undefined && (weight <= 0 || weight > 500)) {
        throw new Error('log_measurement params.weight must be a positive number under 500.');
      }
      if (waist !== undefined && (waist <= 0 || waist > 300)) {
        throw new Error('log_measurement params.waist must be a positive number under 300.');
      }
      const out: { weight?: number; waist?: number } = {};
      if (weight !== undefined) out.weight = weight;
      if (waist !== undefined) out.waist = waist;
      return {
        action: 'log_measurement',
        params: out,
        reasoning,
      };
    }
  }

  // Unreachable — the action type check above narrows to the known actions.
  throw new Error(`Dispatcher: unexpected action "${action as string}" after validation.`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Classify the user's inbound text and return a structured decision.
 *
 * Builds prompts, calls `llm.complete`, parses the structured output,
 * validates the action is in `allowedActions`, retries once on parse
 * failure with the error fed back into the conversation, throws
 * `DispatcherFailure` on second failure.
 */
export async function dispatchMessage(
  context: DispatcherContext,
  userText: string,
  llm: LLMProvider,
): Promise<DispatcherDecision> {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(context, userText);

  log.debug(
    'DISPATCHER',
    `dispatch request: surface=${context.surface ?? 'none'} lifecycle=${context.lifecycle} activeFlow=${context.activeFlow.kind} turns=${context.recentTurns.length} recipes=${context.recipeIndex.length} user="${userText.slice(0, 80)}"`,
  );

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userPrompt },
  ];

  const firstResult = await llm.complete({
    model: 'mini',
    reasoning: 'high',
    json: true,
    context: 'dispatcher',
    messages,
  });

  try {
    const decision = parseDecision(firstResult.content, context.allowedActions);
    log.debug(
      'DISPATCHER',
      `decision (first pass): action=${decision.action} reasoning="${decision.reasoning.slice(0, 120)}"`,
    );
    return decision;
  } catch (firstErr) {
    log.warn(
      'DISPATCHER',
      `first-pass parse/validate failed: ${(firstErr as Error).message.slice(0, 200)}. Retrying.`,
    );

    // Feed the error back into a retry conversation so the LLM can correct itself.
    const retryMessages = [
      ...messages,
      { role: 'assistant' as const, content: firstResult.content },
      {
        role: 'user' as const,
        content: `Your previous response was rejected: ${(firstErr as Error).message}\n\nReturn a corrected JSON object following the output shape and the allowed-actions constraint.`,
      },
    ];

    const retryResult = await llm.complete({
      model: 'mini',
      reasoning: 'high',
      json: true,
      context: 'dispatcher-retry',
      messages: retryMessages,
    });

    try {
      const decision = parseDecision(retryResult.content, context.allowedActions);
      log.debug(
        'DISPATCHER',
        `decision (retry): action=${decision.action} reasoning="${decision.reasoning.slice(0, 120)}"`,
      );
      return decision;
    } catch (retryErr) {
      log.error(
        'DISPATCHER',
        `retry also failed: ${(retryErr as Error).message.slice(0, 200)}`,
      );
      throw new DispatcherFailure(
        `Dispatcher failed twice. First error: ${(firstErr as Error).message}. Retry error: ${(retryErr as Error).message}`,
        retryErr,
      );
    }
  }
}
