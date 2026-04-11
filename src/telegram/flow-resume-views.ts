/**
 * Flow resume views — the SINGLE source of truth for "where you left off"
 * bot copy across the planning and recipe flows.
 *
 * Plan 028 (Plan C). Proposal 003 invariant #6 requires
 * `return_to_flow` to "restore the exact view, not a fresh render". Both
 * the existing `plan_week` menu action (which today uses
 * `getPlanFlowResumeView` inside `core.ts`) and Plan 028's new dispatcher
 * `return_to_flow` handler (which lives in `dispatcher-runner.ts`) need to
 * emit the same bot copy for the same flow phase. Putting the resume
 * builders in their own leaf module makes "same bytes" structurally
 * guaranteed instead of relying on agents to manually mirror strings.
 *
 * This module is a LEAF: it imports flow state types, keyboards, the
 * recipe formatter, and a date util. It must NOT import `core.ts` or
 * `dispatcher-runner.ts` — both of those import this module, and a
 * back-edge would create a circular dependency.
 *
 * **Fidelity contract (Plan 028 / Plan C):**
 *
 * Task 8b ports the existing legacy behavior of `getPlanFlowResumeView`
 * from `core.ts` verbatim and adds a parallel `getRecipeFlowResumeView`
 * for the recipe side. Fidelity is THREE-TIERED:
 *
 * - Tier 1 (byte-identical): `planFlow.phase === 'proposal'` (reads
 *   `state.proposalText`) and `recipeFlow.phase === 'reviewing'` (reads
 *   `state.currentRecipe` via `renderRecipe`).
 * - Tier 2 (phase-canonical prompt): every other plan/recipe phase.
 *   The helper emits a short re-entry prompt keyed on structural state.
 *   Semantically correct, not byte-for-byte identical to the last message.
 * - Tier 3 (placeholder): no active flow. Not the helper's job — see
 *   `rerenderLastView` in `dispatcher-runner.ts`.
 *
 * Plan E Task 19 lifts Tier 2 to Tier 1 by adding `lastRenderedText`
 * persistence to flow state. Task 8b does NOT attempt that upgrade.
 */

import type { Keyboard, InlineKeyboard } from 'grammy';
import type { PlanFlowState } from '../agents/plan-flow.js';
import type { RecipeFlowState } from '../agents/recipe-flow.js';
import {
  planBreakfastKeyboard,
  planEventsKeyboard,
  planMoreEventsKeyboard,
  planProposalKeyboard,
  recipeReviewKeyboard,
  mealTypeKeyboard,
} from './keyboards.js';
import { renderRecipe } from '../recipes/renderer.js';
import { formatDateForMessage } from '../utils/dates.js';

export interface FlowResumeView {
  text: string;
  replyMarkup?: InlineKeyboard | Keyboard;
  parseMode?: 'MarkdownV2';
}

/**
 * Build a resume view for an in-progress planning flow.
 *
 * Ported verbatim from the previous local definition in `core.ts` so the
 * existing `plan_week` menu action's behavior is preserved. Plan 028
 * additionally uses this helper from `dispatcher-runner.ts`'s
 * `rerenderPlanFlow` for the dispatcher's natural-language return_to_flow
 * path.
 */
export function getPlanFlowResumeView(state: PlanFlowState): FlowResumeView {
  switch (state.phase) {
    case 'context': {
      const weekEnd = state.weekDays[6]!;
      return {
        text: `Planning ${formatDateForMessage(state.weekStart)} – ${formatDateForMessage(weekEnd)}. Breakfast: keep ${state.breakfast.name}?`,
        replyMarkup: planBreakfastKeyboard,
      };
    }
    case 'awaiting_events': {
      const kb = state.events.length === 0 ? planEventsKeyboard : planMoreEventsKeyboard;
      return {
        text: "You're adding events for the week. Send another event or tap Done.",
        replyMarkup: kb,
      };
    }
    case 'generating_proposal':
      return { text: 'Still working on it…' };
    case 'proposal':
      return {
        text: state.proposalText ?? 'Your plan is ready for review.',
        replyMarkup: planProposalKeyboard,
        parseMode: 'MarkdownV2',
      };
    case 'confirmed':
      // Should not reach here (handled by lifecycle guard)
      return { text: 'Plan already confirmed.' };
  }
}

/**
 * Build a resume view for an in-progress recipe flow.
 *
 * **Fidelity contract (Plan 028 / Plan C):**
 *
 * - `reviewing` → BYTE-IDENTICAL to the original render. The helper calls
 *   `renderRecipe(state.currentRecipe)`, the same pure MarkdownV2
 *   formatter `handlePreferencesAndGenerate` / `handleRefinement` use
 *   after generation/refinement. Keyboard is `recipeReviewKeyboard`,
 *   parse mode `MarkdownV2`.
 *
 * - Every OTHER recipe phase (`choose_meal_type`, `awaiting_preferences`,
 *   `awaiting_refinement`) → PHASE-CANONICAL PROMPT, NOT byte-identical
 *   to the actual last-rendered message. Plan E Task 19 promotes all
 *   phases to byte-identical via `lastRenderedText` persistence.
 *
 * Documented drift: `awaiting_refinement` emits the `refine_recipe`
 * example list regardless of entry path (library-edit users see the
 * refine-form examples instead of the edit-form examples).
 */
export function getRecipeFlowResumeView(state: RecipeFlowState): FlowResumeView {
  switch (state.phase) {
    case 'choose_meal_type':
      return {
        text: 'What type of recipe?',
        replyMarkup: mealTypeKeyboard,
      };
    case 'awaiting_preferences': {
      const mealType = state.mealType ?? 'dinner';
      const capitalized = mealType.charAt(0).toUpperCase() + mealType.slice(1);
      return {
        text: `${capitalized} recipe.\n\nDescribe what you want (cuisine, ingredients, style) or just say "surprise me."`,
      };
    }
    case 'reviewing': {
      if (!state.currentRecipe) {
        // Defensive — phase invariant guarantees currentRecipe but be safe.
        return {
          text: 'Back to recipe review.',
          replyMarkup: recipeReviewKeyboard,
        };
      }
      return {
        text: renderRecipe(state.currentRecipe),
        replyMarkup: recipeReviewKeyboard,
        parseMode: 'MarkdownV2',
      };
    }
    case 'awaiting_refinement':
      return {
        text: 'What would you like to change? (e.g., "simpler ingredients", "less fat", "swap chicken for fish")',
      };
  }
}
