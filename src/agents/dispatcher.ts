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

// ─── Entry point (prompt + call + parse wiring lands in Task 4) ──────────────

/**
 * Classify the user's inbound text and return a structured decision.
 *
 * **Task 3** scaffold: throws `DispatcherFailure('not implemented')`. Task 4
 * fills in `buildSystemPrompt`, `buildUserPrompt`, the `llm.complete` call,
 * `parseDecision`, and the retry loop. Keeping the interface frozen here
 * unblocks Task 4 from dependency-on-dependency uncertainty.
 */
export async function dispatchMessage(
  context: DispatcherContext,
  userText: string,
  llm: LLMProvider,
): Promise<DispatcherDecision> {
  void context;
  void userText;
  void llm;
  log.debug('DISPATCHER', 'dispatchMessage scaffold (Task 3) — not yet wired');
  throw new DispatcherFailure('dispatchMessage is not wired yet (Plan 028 Task 3 scaffold)');
}
