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
  | 'return_to_flow';

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

### mutate_plan  (NOT AVAILABLE in v0.0.5 — Plan D)
Future: user describes a change to their plan ("move the flex to Sunday", "swap tagine for fish", "I'm eating out tonight"). For v0.0.5 during an active planning proposal phase, pick flow_input — the existing re-proposer path handles mutations. For post-confirmation mutations (no active flow), pick clarify with an honest "post-confirmation plan changes aren't available yet — that ships next" response.

### answer_plan_question  (NOT AVAILABLE in v0.0.5 — Plan E)
### answer_recipe_question  (NOT AVAILABLE in v0.0.5 — Plan E)
### answer_domain_question  (NOT AVAILABLE in v0.0.5 — Plan E)
Future: questions about the plan ("when's my next cook day?"), recipes ("can I freeze the tagine?"), or food/nutrition ("what's a substitute for tahini?"). For v0.0.5, pick clarify with an honest deferral: "answering questions isn't built yet — that's coming next. Want me to show you the plan / your recipes?"

### show_recipe  (NOT AVAILABLE in v0.0.5 — Plan E)
### show_plan  (NOT AVAILABLE in v0.0.5 — Plan E)
### show_shopping_list  (NOT AVAILABLE in v0.0.5 — Plan E)
### show_progress  (NOT AVAILABLE in v0.0.5 — Plan E)
Future: render a specific view by name. For v0.0.5, pick out_of_scope with a short hint pointing at the reply-keyboard buttons: "navigating by name isn't built yet — tap 📋 My Plan / 📖 My Recipes / 🛒 Shopping List / 📊 Progress to jump there."

### log_measurement  (NOT AVAILABLE in v0.0.5 — Plan E)
Future: parse weight/waist from any surface. For v0.0.5, if the user is NOT in the progress measurement phase, pick clarify with "I can only log measurements when you tap 📊 Progress first."
(Note: when the progress flow IS in awaiting_measurement phase and the user sent well-formed numeric input like "82.3", the runner's numeric pre-filter handles it BEFORE you run — you will never see such messages.)

### log_eating_out  (DEFERRED — proposal commitment, no implementation in v0.0.5)
### log_treat  (DEFERRED — proposal commitment, no implementation in v0.0.5)
Future: record restaurant meals / treats. For v0.0.5, pick clarify with honest deferral.

## STATE PRESERVATION — LOAD-BEARING RULES

1. You never clear planFlow or recipeFlow. Your decision is a classification, not a mutation. The runner enforces this.
2. flow_input during an active flow routes back into that flow — it does NOT start a new flow. Never pick flow_input when there is no active flow.
3. When the active flow has a pendingClarification (a sub-agent is waiting for an answer), and the user's text looks like that answer, pick flow_input so the flow consumes it. If the user's text is clearly a side question instead, pick the appropriate side action — the pendingClarification stays preserved for a later turn.
4. recent turns give you referential threads. "What about the lamb?" after "can I freeze the tagine?" is a follow-up question, not an ambiguous orphan.

## FEW-SHOT EXAMPLES

(Active flow: plan / phase: proposal)
User: "Put the flex meal on Sunday instead"
→ { "action": "flow_input", "params": {}, "response": null, "reasoning": "Mutation request during proposal phase — route to re-proposer via flow_input." }

(Active flow: plan / phase: proposal)
User: "why so much pasta this week?"
→ { "action": "clarify", "params": {}, "response": "I can't answer plan questions yet — that's coming soon. Want to keep reviewing the plan, or make a change?", "reasoning": "Side question during proposal; answer actions not available in v0.0.5; clarify honestly without losing the proposal." }

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
→ { "action": "clarify", "params": {}, "response": "I can't answer plan questions yet — that's coming soon. Want to keep adding events, or tap Done when you're ready?", "reasoning": "Side question during awaiting_events; answer actions not in v0.0.5." }

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
  }

  // Unreachable — the action type check above narrows to the four known actions.
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
