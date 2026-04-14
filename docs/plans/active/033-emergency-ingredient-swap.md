# Plan 033: Emergency Ingredient Swap

**Status:** Active
**Date:** 2026-04-13
**Affects:** `src/models/types.ts`, `supabase/migrations/`, `supabase/schema.sql`, `src/state/store.ts`, `src/agents/dispatcher.ts`, `src/agents/ingredient-swap.ts` (new), `src/plan/swap-applier.ts` (new), `src/telegram/dispatcher-runner.ts`, `src/telegram/core.ts`, `src/telegram/keyboards.ts`, `src/recipes/renderer.ts`, `src/utils/swap-format.ts` (new), `test/scenarios/`, `docs/design-docs/`, `docs/product-specs/`

> Implements design proposal `docs/design-docs/proposals/006-emergency-ingredient-swap.md` (status: draft as of 2026-04-13). Per `FEATURE-LIFECYCLE.md`, the proposal must be promoted to `docs/design-docs/006-emergency-ingredient-swap.md` (status: accepted) before code lands; that promotion is **Phase 0** of this plan and must complete before Phase 1.

## Problem

Real life diverges from the plan at the kitchen counter and at the grocery store. Today the bot can talk *about* swap suggestions but cannot *apply* them: the recipe card, the macros, and the shopping list keep showing what was originally planned, while the user is left translating "a small splash of stock" onto a screen that still says "60ml dry white wine." The proposal documents the verbatim debug-log failure on 2026-04-13 14:00–14:03 — four exchanges, zero updates — and names this as the exact PRODUCT_SENSE failure mode of "a system that only works at home, in ideal conditions, is not enough."

The proposal asks for a single new capability: **batch-level ingredient editing** that mutates a specific batch's contents (ingredient list, step text, per-serving macros, optional name) without touching the library recipe and without going through the recipe-level re-proposer path. Auto-apply when the change is unambiguous, non-structural, and uses a named common substitute; ask first when the target batch is ambiguous, the user hedged, the substitute is unknown, or the swap is structural (main protein / recipe-identity ingredient). Render the full updated card with a delta block at the bottom in both modes. Persist the swap on the batch the moment it commits; the shopping list, which already reads from `batch.scaledIngredients`, becomes a live projection.

The dispatcher already routes free-text messages to a small action catalog. `mutate_plan` covers recipe-level swaps via the re-proposer (different recipe in a slot), but ingredient-level edits are explicitly **out of scope** for `mutate_plan` (proposal 003 § Flow 3 note). This plan adds the missing capability as a new dispatcher action with its own sub-agent.

## Plan of work

The work is sequenced so each phase produces working, harness-testable software on its own. Phases 1–2 build the data model and agent in isolation (no UI). Phase 3 adds the dispatcher route. Phase 4 wires the applier and the auto-apply / ask-first policy. Phases 5–6 update rendering. Phase 7 adds reversal. Phase 8 covers edge cases on the batch-only surface. Phase 9 bolts on breakfast parity by extending the dispatcher summary, target resolution, persistence branch, rendering, and shopping-list generation end-to-end. Phases 3–8 stand on their own without breakfast; Phase 9 is the slice that flips breakfast swaps on. Phase 10 is the new-scenario test suite (21 scenarios across six tiers including fixture-edited guardrails). Phase 10a is the regression sweep — regenerate and behaviorally re-review every existing scenario touched by Phase 3.4 / 6 / 9.5's cross-cutting changes (≥32 dispatcher scenarios + ~6 shopping-list scenarios). Phase 11 is docs and spec promotion.

Phase 1 lands the full data model (batch fields + `PlanSession.breakfastOverride` + the migration + `store.updatePlanSessionBreakfast`) in one commit. That's on purpose — a single migration is cleaner than two, and an unused breakfast column / store method is harmless until Phase 9 wires it up. Phase 2's agent is polymorphic over `SwapTarget.kind`; `'breakfast'` targets are defined but no caller constructs them until Phase 9.

---

### Phase 0 — Promote proposal to accepted design doc (precondition)

Per `FEATURE-LIFECYCLE.md` Stage 3, no implementation begins until the proposal is promoted.

1. Move `docs/design-docs/proposals/006-emergency-ingredient-swap.md` → `docs/design-docs/006-emergency-ingredient-swap.md`. Change `Status: draft` to `Status: accepted` and add the implementation reference: `Implementation: Plan 033`.
2. Add an entry to `docs/design-docs/index.md` under the catalog, keyed `006`, with a one-line summary that names JTBD C1 as the served job.
3. Remove the proposal entry from `docs/design-docs/proposals/README.md` § Current proposals.
4. Confirm JTBD C1 ("Handle missing ingredients at cook time") exists in `docs/product-specs/jtbd.md`. If absent or under-described, add/expand it in the same commit — the proposal calls C1 the primary job and references A2 (shopping list) as the in-store variant.

Commit: `Design doc 006: Emergency Ingredient Swap — promote to accepted`.

---

### Phase 1 — Data model and persistence

The batch-level edit needs to survive process restarts and round-trip through Supabase. Today `Batch` already carries `scaledIngredients` and `actualPerServing` — those become writable post-confirmation. New optional fields cover name and step text, and a swap history enables the reversal rules from the proposal's edge-case "Swap, then another swap, then undo."

#### 1.1 — Extend `Batch` and `PlanSession.breakfast` in `src/models/types.ts`

Add three optional fields to `Batch` AND a parallel `breakfastOverride?` to `PlanSession` (NOT to `DraftPlanSession` / proposer types — drafts never have swaps):

```ts
export interface SwapRecord {
  /** ISO timestamp when the swap was applied. */
  appliedAt: string;
  /** Verbatim user message that triggered this swap. */
  userMessage: string;
  /**
   * Discriminator on the swap shape so reversals can name what to undo.
   * 'replace' = ingredient X → ingredient Y
   * 'remove'  = ingredient X removed (no replacement)
   * 'add'     = ingredient added (e.g., the helper acid for a wine→stock swap)
   * 'rename'  = batch display name changed (e.g., "Salmon Calamari Pasta" → "Cod Calamari Pasta")
   * 'rebalance' = a pantry-staple amount changed for macro rebalance
   */
  changes: SwapChange[];
  /** Per-serving macros AFTER this swap (snapshot for delta reasoning). */
  resultingMacros: MacrosWithFatCarbs;
}

export type SwapChange =
  | { kind: 'replace'; from: string; to: string; fromAmount: number; fromUnit: string; toAmount: number; toUnit: string }
  | { kind: 'remove'; ingredient: string; amount: number; unit: string }
  | { kind: 'add'; ingredient: string; amount: number; unit: string; reason: 'helper' | 'rebalance' }
  | { kind: 'rebalance'; ingredient: string; fromAmount: number; toAmount: number; unit: string }
  | { kind: 'rename'; from: string; to: string };

// Append to Batch:
export interface Batch {
  // ... existing fields unchanged ...
  /** Display name override applied by an emergency swap. Falls back to recipe.name when absent. */
  nameOverride?: string;
  /** Step-text override applied by an emergency swap. Falls back to recipe.body when absent. */
  bodyOverride?: string;
  /** Ordered swap history. Empty array on every freshly-created batch; appended on each commit. */
  swapHistory?: SwapRecord[];
}

/**
 * Per-session override of the locked breakfast recipe's content.
 *
 * Breakfast on `PlanSession.breakfast` today stores only `recipeSlug`,
 * `caloriesPerDay`, and `proteinPerDay` — no ingredient list, no step
 * text, no macros beyond calories/protein. The emergency swap flow
 * (proposal 006 § "Breakfast recipes": *"Swaps work identically"*)
 * needs all of those so a swap can rewrite ingredients, steps, and
 * macros. We materialize the breakfast recipe into this override the
 * first time a swap is committed on the current session; subsequent
 * swaps mutate the override in place.
 *
 * `scaledIngredientsPerDay` carries PER-DAY amounts (breakfast runs
 * one "serving" per day) so the shopping list generator can multiply
 * them by `horizonDayCount` with the existing proration math.
 */
export interface BreakfastOverride {
  /** Display-name override. Falls back to the library breakfast recipe's name when absent. */
  nameOverride?: string;
  /** Body/step-text override. Falls back to the library recipe's body when absent. */
  bodyOverride?: string;
  /** Per-day scaled ingredients (one "serving"). */
  scaledIngredientsPerDay: ScaledIngredient[];
  /** Per-day macros after the swap. */
  actualPerDay: MacrosWithFatCarbs;
  /** Ordered swap history on the breakfast target. */
  swapHistory: SwapRecord[];
}

// Append to PlanSession:
export interface PlanSession {
  // ... existing fields unchanged ...
  /**
   * Set the first time an emergency swap commits against this session's
   * breakfast. Absent means "breakfast matches the library recipe
   * scaled by `caloriesPerDay` / `proteinPerDay`." When present, the
   * renderer, the shopping-list generator, and the dispatcher's plan
   * summary all read from this override instead of the library recipe.
   */
  breakfastOverride?: BreakfastOverride;
}

// Extend the DraftPlanSession Omit list — drafts must NEVER carry an
// override (swaps only apply to confirmed sessions). The existing alias
// at src/models/types.ts:228 already omits the DB-managed fields +
// mutationHistory; append `breakfastOverride` to that Omit list:
export type DraftPlanSession = Omit<
  PlanSession,
  'confirmedAt' | 'superseded' | 'createdAt' | 'updatedAt' | 'mutationHistory' | 'breakfastOverride'
> & { mutationHistory?: MutationRecord[] };
```

`scaledIngredients` and `actualPerServing` are already mutable on `Batch`; emergency swap mutates them in place via `store.updateBatch`. Breakfast uses a dedicated `store.updatePlanSessionBreakfast` path (Phase 1.3) so the plan session's other fields are never touched by a swap.

#### 1.2 — Migration `supabase/migrations/006_batch_and_breakfast_swap_overrides.sql`

```sql
-- Plan 033: per-batch overrides for emergency ingredient swap.
alter table batches add column name_override text;
alter table batches add column body_override text;
alter table batches add column swap_history jsonb not null default '[]';

-- Plan 033: breakfast override on plan sessions — materialized when the
-- first emergency swap commits against a session's breakfast.
alter table plan_sessions add column breakfast_override jsonb;
```

Update `supabase/schema.sql` in the same commit (per memory rule "Supabase schema changes" — every migration also updates the canonical snapshot).

#### 1.3 — Store — `src/state/store.ts`

Add two methods to `StateStoreLike`:

```ts
/**
 * Update specific fields on an existing batch in place. Used by the
 * emergency ingredient swap applier (Plan 033). The fields parameter is
 * a partial of the mutable batch state; unspecified fields are not touched.
 *
 * Throws if the batch does not exist or has status='cancelled'.
 */
updateBatch(
  batchId: string,
  fields: {
    scaledIngredients?: ScaledIngredient[];
    actualPerServing?: MacrosWithFatCarbs;
    nameOverride?: string | null;
    bodyOverride?: string | null;
    /** When provided, replaces the array (caller is responsible for appending). */
    swapHistory?: SwapRecord[];
  },
): Promise<Batch>;

/**
 * Write (or clear) the breakfast override on an existing plan session.
 * Used by the emergency swap flow when the target is `'breakfast'`
 * (Phase 9). Pass `null` to clear the override and restore the library
 * recipe (reset-to-original, Phase 7).
 *
 * Throws if the session does not exist or is superseded.
 */
updatePlanSessionBreakfast(
  planSessionId: string,
  override: BreakfastOverride | null,
): Promise<PlanSession>;
```

Implement on `StateStore`:
- `updateBatch`: one `update().eq('id', batchId).eq('status', 'planned').select().single()` call.
- `null` values for `nameOverride` / `bodyOverride` clear the column (resets to library recipe). The `undefined` case skips the field.
- Map `swapHistory` ↔ `swap_history` JSONB column via existing row mappers.
- `updatePlanSessionBreakfast`: one `update({ breakfast_override: <json|null> }).eq('id', planSessionId).eq('superseded', false).select().single()`. Error on `rowCount === 0`.

Implement on `TestStateStore` (`src/harness/test-store.ts`): mutate the in-memory batch / session and persist on the existing per-scenario store map. Throw on missing/cancelled batch or missing/superseded session — the harness must surface this loudly, not silently no-op.

#### 1.4 — Update row mappers

`toBatchRow` / `fromBatchRow` (in `src/state/store.ts`) gain three columns. `swap_history` defaults to `[]` on read when null. `name_override` / `body_override` map to `null` when empty.

`toPlanSessionRow` / `fromPlanSessionRow` gain the `breakfast_override` column: write `null` when `breakfastOverride` is absent, write the full JSON otherwise. Read defaults to `undefined` when the column is null.

#### 1.5 — Validation

- Add a check to `qa/validators/plan.ts` (if it walks batches) that `nameOverride.length <= 80` and `bodyOverride.length <= 8000` to bound prompt sizes.
- No changes needed to `qa/validators/proposal.ts` — proposals never carry swaps.

#### 1.6 — Config entry

Add `swapNoisePctOfTarget: 10` to `config.planning` in `src/config.ts` (typed in `src/config.ts`'s existing `planning` block). Documented in `docs/product-specs/core-concepts.md` as the noise floor that determines when a swap's macro drift is "within noise" vs requires a rebalance line. Referenced by the swap-applier in Phase 4.3.

Commit: `Plan 033 phase 1: Batch override fields, migration, store.updateBatch`.

---

### Phase 2 — Ingredient-swap sub-agent

A focused single-call LLM agent that takes one batch + the user's verbatim message and returns one of: an apply-now plan, an ask-first preview, a help-me-pick option list, a clarification question, or a hard-no with a routing hint.

Modeled after `recipe-scaler.ts` (single-call, structured JSON, role-aware adjustments) and `plan-reproposer.ts` (validation, retry, mode flag).

#### 2.1 — New file `src/agents/ingredient-swap.ts`

Skeleton:

```ts
/**
 * Ingredient-swap sub-agent — Plan 033 / proposal 006.
 *
 * Single LLM call that reads ONE batch + the user's verbatim message and
 * returns a structured swap decision. The caller (src/plan/swap-applier.ts)
 * applies the decision deterministically: persists to the batch when auto-
 * apply, stashes a pending preview when ask-first, sends a clarifying
 * question otherwise.
 *
 * No session state, no store access — pure function of (batch, recipe,
 * userMessage, mode). The applier owns persistence and rendering.
 */

import type { LLMProvider } from '../ai/provider.js';
import type {
  Batch,
  Recipe,
  ScaledIngredient,
  MacrosWithFatCarbs,
  SwapChange,
} from '../models/types.js';

/**
 * A unified swap target — either a persisted Batch or the per-session
 * breakfast shape. The agent treats them identically for swap decisions;
 * the applier dispatches persistence based on the discriminator.
 */
export type SwapTarget =
  | {
      kind: 'batch';
      targetId: string; // batch.id
      recipe: Recipe;
      servings: number;
      /** Per-serving target macros from the solver. */
      targetMacros: Macros;
      /** Current per-serving macros (post any prior swaps). */
      currentMacros: MacrosWithFatCarbs;
      currentIngredients: ScaledIngredient[];
      currentName: string;   // batch.nameOverride ?? recipe.name
      currentBody: string;   // batch.bodyOverride ?? recipe.body
      swapHistory: SwapRecord[];
    }
  | {
      kind: 'breakfast';
      targetId: 'breakfast'; // literal sentinel
      recipe: Recipe;
      /** Per-day macros target (matches `PlanSession.breakfast.caloriesPerDay` / `proteinPerDay`). */
      targetMacros: Macros;
      /** Current per-day macros (post any prior swaps). */
      currentMacros: MacrosWithFatCarbs;
      /** Per-day ingredients. */
      currentIngredients: ScaledIngredient[];
      currentName: string;
      currentBody: string;
      swapHistory: SwapRecord[];
      /** Horizon day count — drives the shopping list's breakfast proration delta. */
      horizonDays: number;
    };

export interface IngredientSwapInput {
  target: SwapTarget;
  userMessage: string;
  /** Verbatim user surface context — e.g., 'cooking', 'shopping', 'plan'. Drives the help-me-pick framing only. */
  surface: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null;
  /**
   * Whether the dispatcher already knows the target is unambiguous (user is
   * on a cook view of this batch, or the ingredient matched exactly one
   * candidate in the plan). The applier sets this; the agent uses it to
   * decide whether to preview vs apply when the user's message doesn't
   * name a batch.
   */
  targetIsUnambiguous: boolean;
  /** ~±10% noise floor on per-serving / per-day calories — drives the "drama" threshold for rebalance. */
  noisePctOfTarget: number;
}

export type IngredientSwapDecision =
  | {
      kind: 'apply';
      /**
       * New scaled ingredients. For a batch target, these are per-serving
       * amounts (with `totalForBatch = amount × batch.servings`). For a
       * breakfast target, these are per-day amounts with
       * `totalForBatch = amount × horizonDays` (one "serving" per day).
       */
      scaledIngredients: ScaledIngredient[];
      /**
       * New macros snapshot. For a batch target: per-serving. For a
       * breakfast target: per-day. The unified field name `actualMacros`
       * mirrors the `PendingSwap.proposed.actualMacros` contract so the
       * applier can pass through without reshaping.
       */
      actualMacros: MacrosWithFatCarbs;
      /** Optional rewritten name; null/undefined preserves current value. */
      nameOverride?: string | null;
      /** Optional rewritten step text; null/undefined preserves current value. */
      bodyOverride?: string | null;
      /** Atomic SwapChange records for this commit, in display order. */
      changes: SwapChange[];
      /** Pre-computed delta lines for the rendered footer (one per change + macro line). */
      deltaLines: string[];
      reasoning: string;
    }
  | {
      kind: 'preview';
      /** Same payload shape as 'apply' — applier stashes it and waits for "go ahead". */
      proposed: {
        scaledIngredients: ScaledIngredient[];
        actualMacros: MacrosWithFatCarbs;
        nameOverride?: string | null;
        bodyOverride?: string | null;
        changes: SwapChange[];
      };
      /** One-paragraph preview message + an explicit "OK to apply, or want a different X?" prompt. */
      previewText: string;
      /** Why the agent picked preview over apply (one of: 'ambiguous_target', 'hedged', 'unknown_substitute', 'structural', 'stale_view'). */
      reason: 'ambiguous_target' | 'hedged' | 'unknown_substitute' | 'structural' | 'stale_view';
      reasoning: string;
    }
  | {
      kind: 'help_me_pick';
      /** Two or three named options for the user to pick from. */
      optionsText: string;
      reasoning: string;
    }
  | {
      kind: 'clarification';
      question: string;
      reasoning: string;
    }
  | {
      kind: 'hard_no';
      /** Renderable message explaining why and suggesting next step (e.g., recipe-level swap). */
      message: string;
      /** When set, the applier surfaces a routing hint to mutate_plan or library-edit. */
      routingHint?: 'recipe_level_swap' | 'library_edit' | 'no_target';
      reasoning: string;
    };

export async function decideIngredientSwap(
  input: IngredientSwapInput,
  llm: LLMProvider,
): Promise<IngredientSwapDecision> {
  // Builds system + user prompt; calls llm.complete with model: 'mini',
  // reasoning: 'high', json: true, context: 'ingredient-swap'.
  // Parses JSON, validates discriminator, retries once on parse failure.
  // Returns structured decision.
}
```

#### 2.2 — System prompt content (concrete)

The prompt must encode every rule from the proposal § Design decisions. Verbatim sections to include:

- **Auto-apply when ALL three hold**: target is unambiguous AND substitute is named-and-common AND change is non-structural. Otherwise → preview.
- **Pantry-staple definition**: fats, salt, stocks, vinegars, acids, herbs, spices, sugar. The agent may flex amounts of pantry staples and add a pantry-staple helper (wine → stock + acid; cream → milk + butter; buttermilk → milk + vinegar). It may NOT introduce a new precisely-bought ingredient or change the amount of an already-bought precisely-bought ingredient.
- **Precisely-bought definition**: weighed proteins, pasta by weight, packaged portions, produce with specific gram targets. Hard invariant: name and amount unchanged unless the user explicitly named that ingredient as the swap target.
- **Substitute-amount scaling**: 20–30% bump on protein substitutes (tofu for chicken, chickpeas for beef) when sensible — never force a protein match. Beyond that, state the protein landing honestly and stop.
- **Noise floor**: per-serving calorie drift within ±`noisePctOfTarget`% of `targetPerServing.calories` is "within noise" — print one calm reassurance line ("on pace", "on target", "within noise"), no rebalance. Beyond noise → rebalance with a pantry staple OR state the gap.
- **Atwater check**: the new `actualPerServing` numbers must satisfy `calories ≈ 4·protein + 4·carbs + 9·fat` within ±5%. Same retry pattern as `recipe-scaler.ts`.
- **Step rewriting**: any step that mentions a swapped ingredient by name is rewritten so that the ingredient name in the step matches the new ingredient (e.g., "reduce the white wine until the alcohol cooks off" → "simmer the stock and lemon juice for 2 min").
- **Delta lines** (the agent emits these pre-formatted, the renderer drops them in verbatim):
  - Replacement: `Swapped: <from> (<amt><unit>) → <to> (<amt><unit>)[ + <helper> (<amt><unit>)]`
  - Removal: `Removed: <ingredient> (<amt><unit>)`
  - Rebalance: `Rebalanced: <ingredient> <fromAmt><unit> → <toAmt><unit>, to <reason>.`
  - Macros: `Macros: <delta sign><N> cal/serving — <within noise|on pace|on target>.` for noise band; `Macros: <kcal>/<protein>g protein per serving — <message>` outside noise.
  - Acknowledgment-only (per Screen 3): list every removal the user named, even when no rebalance was triggered for that one.
- **Help-me-pick mode**: when the user's message is help-seeking ("they don't have salmon, what should I get?"), return `kind: 'help_me_pick'` with 2–3 options, each with the substitute amount and a one-line macro impact. The user's next message ("got the cod, 320g") routes back through the dispatcher → swap_ingredient → apply.
- **Hard-no triggers**: the swap empties out the recipe identity (Screen "Swap that catastrophically breaks the recipe identity": "skip the salmon AND the calamari" on a salmon-calamari pasta). Return `kind: 'hard_no'` with `routingHint: 'recipe_level_swap'` and the proposal's verbatim two-option message.
- **No tracking layer**: never write a step like "consume the bought salmon first, then" — the kitchen is the source of truth, the bot does not maintain a parallel purchase log.

Output shape (JSON, no markdown):

```json
{
  "kind": "apply" | "preview" | "help_me_pick" | "clarification" | "hard_no",
  "scaled_ingredients": [...],          // apply / preview only
  "actual_macros": {...},               // apply / preview only — per-serving for batch targets, per-day for breakfast
  "name_override": string | null,       // optional
  "body_override": string | null,       // optional
  "reset_to_original": boolean,         // optional, apply only — Phase 7 reset path
  "changes": [...],                     // apply / preview only
  "delta_lines": [...],                 // apply only
  "preview_text": string,               // preview only
  "options_text": string,               // help_me_pick only
  "question": string,                   // clarification only
  "message": string,                    // hard_no only
  "routing_hint": string | null,        // hard_no only
  "reason": string | null,              // preview only
  "reasoning": string                   // always required
}
```

#### 2.3 — User prompt content

The per-call user prompt carries:
- Surface + `targetIsUnambiguous` flag.
- The batch: `recipeSlug`, `mealType`, `eatingDays`, `servings`, `targetPerServing`, current `actualPerServing`.
- The current `scaledIngredients` (full list, with name/amount/unit/role).
- The recipe's `structure`, `ingredients` (for role inference on the substitute), `body` (so step rewrites preserve voice), `storage` (for fridge-life sanity).
- Pre-existing `swapHistory[]` so the agent knows what was already swapped.
- The user's verbatim message.

#### 2.4 — Validation and retry

- Parse failure → retry once with the parse error appended; on second failure, return `{ kind: 'hard_no', message: "I couldn't read that swap cleanly — try rephrasing.", reasoning: 'parse_failure' }` so the applier can render a fallback.
- Atwater inconsistency → same retry pattern as `recipe-scaler.ts`. On second failure, log warn and proceed with best effort (matches existing scaler tolerance).
- Schema violation (missing required field for the picked `kind`) → treat as parse failure.

#### 2.5 — Unit-coverable behavior

The agent file is pure (no store, no session). The harness can drive it in unit-style scenarios with hand-built batches. No new unit test framework needed — the existing scenario harness covers it through Phase 10's scenarios.

Commit: `Plan 033 phase 2: ingredient-swap sub-agent`.

---

### Phase 3 — Dispatcher action `swap_ingredient`

Add the action to the catalog so the dispatcher can route ingredient-level intent to the new applier. Recipe-level swaps stay on `mutate_plan`; the dispatcher prompt teaches the LLM the boundary.

#### 3.1 — Extend types in `src/agents/dispatcher.ts`

```ts
export type DispatcherAction =
  | 'flow_input'
  | 'clarify'
  | 'out_of_scope'
  | 'return_to_flow'
  | 'mutate_plan'
  | 'swap_ingredient'        // NEW (Plan 033)
  | 'answer_plan_question'
  | 'answer_recipe_question'
  | 'answer_domain_question'
  | 'show_recipe'
  | 'show_plan'
  | 'show_shopping_list'
  | 'show_progress'
  | 'log_measurement';

export const AVAILABLE_ACTIONS_V0_0_5 = [
  // ... existing entries ...
  'swap_ingredient',
] as const;
```

Add to `DispatcherDecision` union:

```ts
| {
    action: 'swap_ingredient';
    /**
     * `request` is the user's raw natural-language swap message, passed
     * through verbatim. `target_batch_id` is set when the dispatcher can
     * unambiguously bind to one batch (user is on a cook view OR a single
     * batch in the plan contains every named ingredient). When unset, the
     * applier disambiguates against the active plan.
     */
    params: {
      request: string;
      target_batch_id?: string;
    };
    response?: undefined;
    reasoning: string;
  };
```

#### 3.2 — System-prompt action description

Add a new section between `mutate_plan` and `answer_plan_question`. The description must:

- State the boundary explicitly: `swap_ingredient` mutates ONE batch's contents; `mutate_plan` rearranges WHICH batches/recipes go where. (Phase 9 extends this to also cover the per-session breakfast via a `'breakfast'` sentinel `target_batch_id`; Phases 3–8 are batch-only.)
- List the trigger phrases from the proposal's debug-log examples ("no white wine, use beef stock instead", "skip the raisins", "they don't have salmon, what should I get?", "got the cod, 320g").
- Tell the LLM to set `target_batch_id` when (a) `lastRenderedView.surface === 'cooking'` AND `lastRenderedView.batchId` is present, OR (b) the named ingredient appears in exactly one active batch's `scaledIngredients`.
- Tell the LLM NOT to set `target_batch_id` when the message is help-seeking ("what should I use instead of X?") or clearly names multiple batches — let the applier's multi-batch preview path handle that.
- **Pending-swap framing**: when `pendingSwap` is present in the context (see Phase 3.4 below for the field), interpret every inbound message under the frame "the user is responding to the previewed swap." A message that rewrites the swap ("actually use chickpeas", "no, cod instead, 320g") is a fresh `swap_ingredient` with `request` = the user's full text and `target_batch_id` = `pendingSwap.targetIdHint` when that field is set. The applier will drop the prior `pendingSwap` and re-decide. Bare confirmations and cancellations are caught by `trySwapPreFilter` (Phase 4.7) before this prompt runs — the LLM will never see them.
- Show the boundary cases:
  - "swap tomorrow's dinner for fish" → `mutate_plan` (changes which RECIPE is in the slot).
  - "no white wine, use beef stock" → `swap_ingredient` (changes the contents of the current batch).
  - "I'm out of salmon, what should I get?" on a cook view → `swap_ingredient` (help-me-pick mode).
  - "I'm out of salmon" on the plan view, when salmon is in two batches → `swap_ingredient` (applier does the multi-batch ambiguity preview).

#### 3.3 — Extend `DispatcherContext` with `pendingSwap` summary

Today the dispatcher sees `pendingPostConfirmationClarification` but not `pendingSwap`. Without this, the dispatcher cannot frame a rewrite like "actually use cod instead" as a response to the preview — it would likely land as `clarify` or `out_of_scope`.

Extend `DispatcherContext` in `src/agents/dispatcher.ts`:

```ts
export interface DispatcherContext {
  // ... existing fields unchanged ...
  /**
   * Plan 033: Set when the applier previewed an ingredient swap and is
   * waiting for natural-language confirm / rewrite / cancel. The dispatcher
   * reads this so it can frame the next message as "a response to the
   * preview" and route rewrites to swap_ingredient. Bare confirmations
   * and cancellations are caught by `trySwapPreFilter` before the
   * dispatcher runs.
   */
  pendingSwap?: {
    kind: 'single' | 'multi_batch';
    /** For `single`: the batch (or 'breakfast') the preview targets. */
    targetIdHint?: string;
    /** For `multi_batch`: short descriptors per candidate, for the LLM's framing. */
    candidates?: Array<{ id: string; description: string }>;
    /** Verbatim user message that produced the preview. */
    originalRequest: string;
    /** Why the agent previewed. */
    reason: 'ambiguous_target' | 'hedged' | 'unknown_substitute' | 'structural' | 'stale_view';
  };
}
```

`buildDispatcherContext` reads `session.pendingSwap` (Phase 4.6) and projects it into this compact summary. The prompt's user-prompt builder (new section): `## PENDING SWAP\n${formatPendingSwap(ctx.pendingSwap)}` immediately after `## Outstanding clarification`.

Add a few-shot example to the prompt:

```
(pendingSwap: single, targetIdHint: batch-abc-…, reason: structural)
User: "actually use chickpeas instead"
→ { "action": "swap_ingredient", "params": { "request": "actually use chickpeas instead", "target_batch_id": "batch-abc-…" }, "response": null, "reasoning": "Rewrite of the previewed swap; carry the target forward, let the applier drop the prior pending and re-decide." }
```

#### 3.4 — Extend `DispatcherPlanSummary.batchLines` and load overlapping batches

Today the line shape is `${b.recipeSlug} (${name}), ${b.servings} servings, ${days} ${b.mealType}`, and `buildDispatcherContext` (`src/telegram/dispatcher-runner.ts:226`) only calls `store.getBatchesByPlanSessionId(planSession.id)` — it misses carried-over batches from earlier sessions that still have eating days in the current horizon (handled elsewhere by `src/telegram/view-renderers.ts:138` `loadVisiblePlanAndBatches`).

Two coordinated changes:

1. **Combined batch load**: replace the single `getBatchesByPlanSessionId` call with the own + overlapping pattern used by the view renderers:
   ```ts
   const ownBatches = await store.getBatchesByPlanSessionId(planSession.id);
   const overlapBatches = await store.getBatchesOverlapping({
     horizonStart: planSession.horizonStart,
     horizonEnd: planSession.horizonEnd,
     statuses: ['planned'],
   });
   const seen = new Set<string>();
   const plannedBatches = [...ownBatches, ...overlapBatches]
     .filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)))
     .filter((b) => b.status === 'planned');
   ```
   This guarantees the dispatcher's view of "what batches are in scope" matches what the user actually sees on the plan and shopping surfaces. The same combined set is what the swap applier uses for ingredient resolution (Phase 4.2 step 5).

2. **Line format** — emit:
   ```
   ${b.id}|${b.recipeSlug} (${name}), ${b.servings} servings, ${days} ${b.mealType}, ingredients: <comma-separated top-5 by role-priority>
   ```
   The `id` prefix lets the LLM produce a `target_batch_id` it knows is valid; the ingredient signature lets it match "no white wine" to a specific batch when the user isn't on a cook view. Top-5 by role-priority (protein first, then carb, fat, vegetable, base, seasoning) keeps the prompt size bounded.

*(Phase 9 adds a third change: a `breakfastLine` row in `DispatcherPlanSummary` using the `'breakfast'` sentinel, plus an updated action-catalog example for "no yogurt, use cottage cheese". Phases 3–8 operate without breakfast surface — breakfast-targeted messages in those phases route through `mutate_plan` or fall through to `clarify` until Phase 9 flips the switch. This keeps each phase independently shippable.)*

> Phase 9 adds a third change verbatim: a `breakfastLine` row on `DispatcherPlanSummary` with the `'breakfast'` sentinel as its id, plus wiring in `formatRecipeRow`/`buildPlanSummary`. That row is the hook the dispatcher uses to bind breakfast-only ingredients (e.g., "no yogurt") to the breakfast target.

#### 3.5 — Few-shot examples

Append four examples to the dispatcher prompt:

```
(Active flow: none / lifecycle: active_mid / lastRenderedView: cooking/cook_view, batchId: batch-abc-…)
User: "no white wine, use beef stock instead"
→ { "action": "swap_ingredient", "params": { "request": "no white wine, use beef stock instead", "target_batch_id": "batch-abc-…" }, "response": null, "reasoning": "Ingredient-level edit on the cook view's batch; auto-apply criteria look met (substitute is named and common, target unambiguous)." }

(Active flow: none / lifecycle: active_mid / lastRenderedView: shopping/next_cook)
User: "they don't have salmon, what should I get?"
→ { "action": "swap_ingredient", "params": { "request": "they don't have salmon, what should I get?" }, "response": null, "reasoning": "Help-me-pick at the grocery store; target is the unique active batch containing salmon. Applier resolves." }

(Active flow: none / lifecycle: active_mid / lastRenderedView: plan/week_overview)
User: "skip the raisins, I ran out — also no parsley"
→ { "action": "swap_ingredient", "params": { "request": "skip the raisins, I ran out — also no parsley", "target_batch_id": "batch-tagine-…" }, "response": null, "reasoning": "Compound removal; both ingredients appear together in exactly one active batch (tagine), which is the unambiguous target." }

(Active flow: none / lifecycle: active_mid)
User: "swap tomorrow's dinner for something lighter"
→ { "action": "mutate_plan", "params": { "request": "swap tomorrow's dinner for something lighter" }, "response": null, "reasoning": "Recipe-level swap (different recipe in the slot), not an ingredient edit. Stays on mutate_plan." }
```

#### 3.6 — Dispatcher unit coverage

Existing dispatcher tests (scenarios 037–065) cover the routing surface. New ingredient-swap routing is exercised end-to-end in Phase 10's scenarios.

Commit: `Plan 033 phase 3: dispatcher swap_ingredient action`.

---

### Phase 4 — Swap applier and ask-first / auto-apply policy

Mirrors `src/plan/mutate-plan-applier.ts`'s shape: a single entry function returning a discriminated `SwapResult`, with `dispatcher-runner.ts` handling the result.

#### 4.1 — New file `src/plan/swap-applier.ts`

```ts
/**
 * Emergency ingredient swap applier — Plan 033 / proposal 006.
 *
 * Resolves the target batch, calls the ingredient-swap agent, persists the
 * swap immediately when the agent returns 'apply', or stashes a
 * `PendingSwap` and waits for natural-language confirm when it returns
 * 'preview'. Help-me-pick and clarification paths surface text only.
 */

import type { LLMProvider } from '../ai/provider.js';
import type { RecipeDatabase } from '../recipes/database.js';
import type { StateStoreLike } from '../state/store.js';
import type { Batch, SwapRecord } from '../models/types.js';
import type { TraceEvent } from '../harness/trace.js';

export type PendingSwap = PendingSwapSingle | PendingSwapMultiBatch;

export interface PendingSwapSingle {
  kind: 'single';
  /** Batch the preview targets — a batch ID OR the literal `'breakfast'` for the per-session breakfast target (Phase 9). */
  targetId: string;
  /** Verbatim user message that proposed the swap. */
  originalRequest: string;
  /** The agent's proposed payload, ready to apply on confirm. */
  proposed: {
    scaledIngredients: import('../models/types.js').ScaledIngredient[];
    /**
     * For a batch target: per-serving macros after the swap.
     * For a breakfast target: per-day macros after the swap (the
     * `scaledIngredients` are ALSO per-day, mirroring the breakfast
     * model where one day = one serving).
     */
    actualMacros: import('../models/types.js').MacrosWithFatCarbs;
    nameOverride?: string | null;
    bodyOverride?: string | null;
    changes: import('../models/types.js').SwapChange[];
  };
  /** Why the agent previewed (drives any future telemetry; not user-visible). */
  reason: 'ambiguous_target' | 'hedged' | 'unknown_substitute' | 'structural' | 'stale_view';
  createdAt: string;
}

export interface PendingSwapMultiBatch {
  kind: 'multi_batch';
  /** Verbatim user message that hit multiple batches. */
  originalRequest: string;
  /**
   * Candidates in display order. Each carries its own pre-computed proposed
   * payload so the commit path doesn't re-call the agent when the user picks.
   * See Phase 2.1 note: multi-batch preview costs N agent calls at preview
   * time (one per candidate) and zero additional calls at commit.
   */
  candidates: Array<{
    /** Batch ID or 'breakfast' sentinel. */
    targetId: string;
    /** One-line descriptor for the pre-filter scorer and the preview text (e.g., "Chicken Black Bean Bowl — lunch Sun–Tue"). */
    description: string;
    /** The short-name match string the pre-filter's ordinal/descriptor regex searches. */
    shortName: string;
    /** The meal type, for `mealType`-based picks ("just the lunch one"). */
    mealType: 'lunch' | 'dinner' | 'breakfast';
    proposed: PendingSwapSingle['proposed'];
  }>;
  /** Aggregate preview text ("Swapping chicken → tofu would bump portion ~30%…"). */
  previewText: string;
  reason: 'ambiguous_target' | 'hedged' | 'unknown_substitute' | 'structural' | 'stale_view';
  createdAt: string;
}

export type SwapResult =
  | { kind: 'applied'; targetId: string; recipeSlug: string; cookViewText: string }
  | {
      kind: 'applied_multi';
      /** One entry per committed candidate, in the order the pre-filter picked them. */
      applied: Array<{ targetId: string; recipeSlug: string; cookViewText: string }>;
    }
  | { kind: 'preview'; previewText: string; pending: PendingSwap }
  | { kind: 'help_me_pick'; optionsText: string }
  | { kind: 'clarification'; question: string }
  | { kind: 'hard_no'; message: string; routingHint?: 'recipe_level_swap' | 'library_edit' | 'no_target' }
  | { kind: 'no_target'; message: string };

export interface ApplySwapRequestArgs {
  request: string;
  targetBatchId?: string;
  session: {
    pendingSwap?: PendingSwap;
    surfaceContext: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null;
    lastRenderedView?: import('../telegram/navigation-state.js').LastRenderedView;
  };
  store: StateStoreLike;
  recipes: RecipeDatabase;
  llm: LLMProvider;
  now?: Date;
  onTrace?: (event: TraceEvent) => void;
}

export async function applySwapRequest(args: ApplySwapRequestArgs): Promise<SwapResult>;
/** See Phase 4.4 for full signatures. */
export async function commitPendingSwap(args: { pending: PendingSwapSingle; /* ... */ }): Promise<{ targetId: string; recipeSlug: string; cookViewText: string }>;
export async function commitPendingSwapMulti(args: { pending: PendingSwapMultiBatch; selectedIds: string[]; /* ... */ }): Promise<Array<{ targetId: string; recipeSlug: string; cookViewText: string }>>;
```

#### 4.2 — Target resolution rules (exact, in order)

Steps 1–3 below assume `trySwapPreFilter` (Phase 4.7) did NOT handle the message — the pre-filter intercepts confirm/cancel/multi-batch-pick paths deterministically before the dispatcher runs, so by the time the applier is invoked via the dispatcher's `swap_ingredient` route, the message is either a fresh swap, a rewrite, or a multi-batch "both" expansion that the pre-filter dispatched here.

1. If `args.session.pendingSwap` is set AND the pre-filter did not consume the message, treat the message as a **rewrite**: clear `pendingSwap`, preserve the original `targetIdHint` in `args.targetBatchId` if unset, and re-enter step 4 with the new message (the agent will produce a fresh preview or apply). The pre-filter already handled bare confirmations and cancellations.
2. *(Removed — handled by `trySwapPreFilter`.)*
3. *(Removed — covered by step 1.)*
4. If `args.targetBatchId` is set, load that batch via `store.getBatch`. Verify `status === 'planned'` and that **at least one** eating day is `>= today` (the "all eating days strictly before today" rejection rule lives in step 6 below — a batch on day 2 of 3 still has leftover servings and is a valid swap target per the proposal's mid-cook edge case). On status failure, return `hard_no`.
5. If `targetBatchId` is unset, resolve from context:
   - `lastRenderedView.surface === 'cooking'` → the `batchId` is on the view; use it.
   - Otherwise, search the active plan's **combined batch set** (own batches of the visible session PLUS overlapping carried-over batches from prior sessions, loaded via `store.getBatchesOverlapping` and deduplicated — this mirrors `src/telegram/view-renderers.ts` `loadVisiblePlanAndBatches`) for the user's named ingredient (case-insensitive substring match against `scaledIngredients[].name`). Phase 9 extends this search to include the breakfast recipe's ingredients.
   - Zero matches → `clarification` ("I don't see that ingredient in this week's plan. Which batch did you mean?").
   - One match → use it.
   - Multiple matches → run the ingredient-swap agent ONCE per candidate (parallel `Promise.all`, each with `targetIsUnambiguous: false`). Assemble a `PendingSwapMultiBatch` whose `candidates[].proposed` is the per-candidate agent output, and whose `previewText` is an aggregate message generated by a final mini-tier LLM call or a deterministic template ("Chicken is in two batches this week: …"). Return `preview` with that `pending`. The follow-up ("both" / "just the lunch one" / candidate name / "neither") is resolved by `trySwapPreFilter` (Phase 4.7) before the dispatcher fires — since every candidate's proposed payload is pre-computed, commit is a pure persist with zero additional LLM calls.
6. After target resolution, if every eating day on the resolved batch is strictly less than today (`batch.eatingDays.every(d => d < today)`), return the Phase 8.5 `hard_no` with the verbatim "That batch is already done" message and `routingHint: 'library_edit'`. Breakfast targets (Phase 9) skip this check — breakfast is per-day and the "next" day is always in scope while the plan horizon is active.

#### 4.3 — Agent → result mapping

Once the target batch is resolved:

- Build the agent input (unified `SwapTarget`; batch path in this phase, breakfast path added in Phase 9). Derive:
  - `targetIsUnambiguous = args.targetBatchId !== undefined || (lastRenderedView?.surface === 'cooking' && lastRenderedView.batchId === resolvedTarget.targetId)`.
  - `noisePctOfTarget` from a new entry `config.planning.swapNoisePctOfTarget` (default `10`, matching the proposal's "~±10%"). Add the config entry in Phase 1's commit so the agent can read it from day one.
  - `surface = args.session.surfaceContext`.
- Call `decideIngredientSwap(...)`.
- `kind: 'apply'` → call `store.updateBatch` (or, for breakfast in Phase 9, `store.updatePlanSessionBreakfast`) with the new payload, append a `SwapRecord` to `swapHistory`, render the cook view (Phase 5), and return `{ kind: 'applied', targetId, recipeSlug, cookViewText }`.
- `kind: 'preview'` → return `{ kind: 'preview', previewText, pending: PendingSwap{...} }`. The runner stashes `pending` on `session.pendingSwap`.
- `kind: 'help_me_pick'` → return `{ kind: 'help_me_pick', optionsText }`. No state change.
- `kind: 'clarification'` → return `{ kind: 'clarification', question }`. No state change.
- `kind: 'hard_no'` → return `{ kind: 'hard_no', message, routingHint }`. The runner appends the routing hint as a one-line follow-up if present (e.g., "Tap *🔄 Plan Week* or say 'swap tomorrow's dinner for X' to swap the whole recipe.").

#### 4.4 — `commitPendingSwap` implementation

Two entry points on the same file:

```ts
/** Commit a `single` pending swap. Returns the rendered cook view. */
export async function commitPendingSwap(args: {
  pending: PendingSwapSingle;
  store: StateStoreLike;
  recipes: RecipeDatabase;
  now?: Date;
  onTrace?: (event: TraceEvent) => void;
}): Promise<{ targetId: string; recipeSlug: string; cookViewText: string }>;

/**
 * Commit selected candidates from a `multi_batch` pending swap. `selectedIds`
 * carries the candidate `targetId`s in the order they were picked — "both"
 * passes every candidate; an ordinal pick passes one. Returns one
 * cook-view render per committed candidate.
 */
export async function commitPendingSwapMulti(args: {
  pending: PendingSwapMultiBatch;
  selectedIds: string[];
  store: StateStoreLike;
  recipes: RecipeDatabase;
  now?: Date;
  onTrace?: (event: TraceEvent) => void;
}): Promise<Array<{ targetId: string; recipeSlug: string; cookViewText: string }>>;
```

Both entries: for each `targetId`, dispatch to either `store.updateBatch` (when the id is a batch ID) or `store.updatePlanSessionBreakfast` (when the id is the `'breakfast'` sentinel — Phase 9 defines the method). Append a `SwapRecord` to `swapHistory` on whichever record was updated. Pre-filter step 2 calls `commitPendingSwap`; pre-filter step 4's "both" / ordinal branches call `commitPendingSwapMulti`.

#### 4.5 — Dispatcher-runner handler `handleSwapIngredientAction`

Add to `src/telegram/dispatcher-runner.ts`, mirroring `handleMutatePlanAction`:

```ts
export async function handleSwapIngredientAction(
  decision: Extract<DispatcherDecision, { action: 'swap_ingredient' }>,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void>;
```

Branches:
- `applied` → send the cook view with MarkdownV2 parse mode. Keyboard choice:
  - `targetId === 'breakfast'` → the lifecycle-aware main menu keyboard (`buildMainMenuKeyboard(lifecycle)`). Breakfast has no per-batch cook callback.
  - Otherwise → `cookViewKeyboard(recipeSlug)`, same as the existing `cv_<batchId>` callback.
- `applied_multi` → iterate `result.applied`; render each as its own reply in order (each with its own keyboard selected per the `applied` rule above and MarkdownV2 parse mode). Telegram stacks the replies bottom-up, so the last batch's delta is what the user sees first. This is the "both" branch of the multi-batch pre-filter.
- `preview` → stash `session.pendingSwap = result.pending`, send `previewText` with the standard side-conversation keyboard.
- `help_me_pick` → send `optionsText` with the side-conversation keyboard.
- `clarification` → send `question` with side-conversation keyboard. (Used only for honest bot-doesn't-know paths; the multi-batch ambiguity uses `preview` so the pre-filter can resolve the user's pick.)
- `hard_no` → send `message` with the main menu keyboard, plus a routing-hint line per Phase 4.3.
- `no_target` → send `message` with the main menu keyboard.

Wire the new handler into the existing `dispatch(decision)` switch.

#### 4.6 — Session field

Add to `BotCoreSession` in `src/telegram/core.ts`:

```ts
/**
 * Plan 033: A previewed-but-not-applied ingredient swap, awaiting natural-
 * language confirm. The swap-applier consumes this on the next user
 * message (confirm → commit, cancel → clear, rewrite → drop and re-decide).
 *
 * Cleared on the same lifecycle hooks as pendingMutation: planFlow start,
 * recipeFlow start, plan confirm/replan callback, /start, /cancel, etc.
 * Cross-search every `session.pendingMutation = undefined;` site and add
 * `session.pendingSwap = undefined;` next to it.
 */
pendingSwap?: import('../plan/swap-applier.js').PendingSwap;
```

The cross-search yields ~14 sites in `core.ts`; each gets the parallel clear.

Also extend `DispatcherSession` in `dispatcher-runner.ts` with the optional `pendingSwap?: PendingSwap` field so the runner reads it.

#### 4.7 — `trySwapPreFilter` — deterministic confirmation / cancel / pick parser

Mirrors `tryNumericPreFilter` in `src/telegram/dispatcher-runner.ts:358`. Runs BEFORE the dispatcher LLM call on every inbound text, returns `true` if it consumed the message.

```ts
export async function trySwapPreFilter(
  text: string,
  session: DispatcherSession,
  deps: { store: StateStoreLike; recipes: RecipeDatabase; llm: LLMProvider },
  sink: DispatcherOutputSink,
  onTrace?: (event: TraceEvent) => void,
): Promise<boolean>;
```

Behavior (in order):

1. If `!session.pendingSwap`, return `false` immediately.

2. **Single-kind confirmation** — `pendingSwap.kind === 'single'` AND `text` matches `/^\s*(go ahead|yes|do it|apply|sure|ok|okay|yep|yeah|confirm|please do|go for it)\s*\.?\s*$/i`:
   - Call `commitPendingSwap({ pending: session.pendingSwap, store, recipes, now })`.
   - `session.pendingSwap = undefined`.
   - `sink.reply(cookViewText, { reply_markup: cookViewKeyboard(slug), parse_mode: 'MarkdownV2' })`.
   - Return `true`.

3. **Cancellation** — any `pendingSwap` AND `text` matches `/^\s*(no|nope|nevermind|never mind|cancel|forget it|stop|not now|leave it)\s*\.?\s*$/i`:
   - `session.pendingSwap = undefined`.
   - `sink.reply("OK, no swap. Tell me when you want one.", { reply_markup: <side-conversation keyboard> })`.
   - Return `true`.

4. **Multi-batch pick** — `pendingSwap.kind === 'multi_batch'`. Parse `text` against the candidate list:
   - **"both"** / **"all of them"** / **"yes to both"** (`/^\s*(both|all(?: of them)?|yes(?: to)? both)\s*\.?\s*$/i`): apply the swap to every candidate sequentially (see Phase 4.4 `commitPendingSwap` multi-branch). Concatenate each resulting cook-view text separated by a blank line and a thin horizontal rule.
   - **Ordinal / descriptor pick** (`/^\s*(just |only )?(the )?(first|second|third|lunch(?: one)?|dinner(?: one)?|<recipeShortName>)\s*\.?\s*$/i`): score each candidate against the text. The scorer is deterministic — exact match on `mealType`, on ordinal position in the candidates list, or case-insensitive substring match on `description`. On a unique best match, commit only that candidate. On no match or a tie, fall through to step 5.
   - **"neither"** / **"none"** / **"skip it"**: treat as cancellation (step 3).

5. **Fallthrough** — none of the above matched. Return `false`. The dispatcher LLM call runs next with `pendingSwap` in context so it can frame the message as a rewrite.

Wire the pre-filter into `runDispatcherFrontDoor` in `src/telegram/core.ts` (or wherever `tryNumericPreFilter` is wired today) — it must run BEFORE `tryNumericPreFilter` only if there's a `pendingSwap` (cheap early return keeps latency flat for the common case).

#### 4.8 — Trace events

Append to `src/harness/trace.ts` (if it has a closed enum):
- `{ kind: 'swap', op: 'apply' | 'preview' | 'help_me_pick' | 'clarification' | 'hard_no' | 'prefilter_confirm' | 'prefilter_cancel' | 'prefilter_pick'; batchId?: string }`
- `{ kind: 'persist', op: 'updateBatch' | 'updatePlanSessionBreakfast' }` — reuse the existing `persist` shape if present, or extend it.

Use them at:
- Agent-call return inside `applySwapRequest`.
- `store.updateBatch` / `store.updatePlanSessionBreakfast` call sites.
- `commitPendingSwap` flow.
- Every pre-filter branch that returns `true`.

Commit: `Plan 033 phase 4: swap applier and dispatcher wiring`.

---

### Phase 5 — Cook-view rendering with delta block

The proposal is explicit: full updated card above, delta line at the bottom. Telegram auto-scrolls to the newest message; the bottom of the message is what the user sees first.

#### 5.1 — Update `renderCookView` in `src/recipes/renderer.ts`

Change the signature to accept an optional explicit `deltaLines?: string[]`:

```ts
export function renderCookView(
  recipe: Recipe,
  batch: Batch,
  options?: { deltaLines?: string[] },
): string;
```

Behavior:
- When `batch.nameOverride` is set, use it in the header instead of `recipe.name`.
- When `batch.bodyOverride` is set, use it instead of `recipe.body` for the body section. Placeholder resolution still runs against `batch.scaledIngredients`.
- When `options?.deltaLines` is present and non-empty, append a footer block:
  ```
  ———
  <each line, MarkdownV2-escaped>
  ```
  The horizontal rule (`———` em-dashes) matches the proposal's screens verbatim.
- When `options?.deltaLines` is absent (re-renders triggered by `cv_<batchId>` after the swap is already persisted), do NOT append the delta — the user is just re-opening the card, the swap was already acknowledged. The `nameOverride` and `bodyOverride` are still honored (the card permanently reflects the swapped state).

Breakfast parallels this in `renderBreakfastCookView` (Phase 9.4) — `planSession.breakfastOverride?.nameOverride` / `bodyOverride` / `scaledIngredientsPerDay` take precedence over the library recipe when present; `options.deltaLines` is appended identically.

#### 5.2 — Update `view-renderers.ts`

`renderCookViewForBatch` already loads the batch and recipe and calls `renderCookView`. Pass `deltaLines: undefined` from this path (re-renders) — explicit.

Add a new helper `renderCookViewWithDelta(session, deps, sink, batchId, deltaLines)` that the swap applier calls. Internally just `renderCookView(recipe, batch, { deltaLines })`. Same `setLastRenderedView` and same `cookViewKeyboard` reply.

#### 5.3 — Delta-line formatter `src/utils/swap-format.ts`

Extract delta-line formatting so both the agent and the applier produce the same text:

```ts
export function formatSwapChange(change: SwapChange): string;
export function formatMacroDelta(args: {
  beforeCalories: number;
  afterCalories: number;
  afterProtein: number;
  targetCalories: number;
  noisePctOfTarget: number;
}): string;
```

The agent emits `delta_lines` directly (Phase 2.2), but the applier still calls `formatMacroDelta` independently to add the macro line if the agent omitted it (defense-in-depth on the prompt contract). Always emit at most one macro line per render.

#### 5.4 — Shopping-list line for in-aisle swaps (Screen 5)

When the swap was applied while `surfaceContext === 'shopping'` (or `lastRenderedView.surface === 'shopping'`), append a one-line shopping summary to the delta block:

```
Shopping list updated: <oldIngredient> removed, <newIngredient> added. Rest of your list is unchanged.
```

Generated by the applier (not the agent), driven from the `SwapChange[]` array. Only emitted when at least one `replace` change touched a precisely-bought ingredient (i.e., the substitute is something the user would have bought).

Commit: `Plan 033 phase 5: cook-view delta rendering`.

---

### Phase 6 — Shopping-list propagation

Per the proposal § "The shopping list is a live projection, not a past-purchase record," the list must reflect the swap immediately.

**Batches**: `generateShoppingList*` already reads from `batch.scaledIngredients`; a successful `store.updateBatch` automatically propagates. No code change for batch-side propagation.

**Breakfast**: today the shopping generators accept `breakfastRecipe: Recipe | undefined` and prorate library amounts. With `PlanSession.breakfastOverride` in play (Phase 9.5), the signature must change to take the session + recipe DB and internally prefer `breakfastOverride.scaledIngredientsPerDay` over the library recipe. That change lands in Phase 9.5 and is exercised here.

Work:

1. Extend two existing scenarios (021 and 022 are good candidates for batch propagation; pick one that exercises breakfast proration for the breakfast path) with a follow-up turn that runs a swap and re-renders the shopping list — assert the list reflects the swap.
2. Confirm `generateShoppingListForRecipe` is unchanged (recipe-scoped, excludes breakfast).
3. Regenerate any scenario whose fixture reflects the old shopping-generator signature.

If verification surfaces a bug (e.g., aggregation key collision when `name` changes case), fix in place; document in the plan's Surprises section.

Commit: `Plan 033 phase 6: shopping list propagation for swaps (batch + breakfast)`.

---

### Phase 7 — Reversal: "swap back" / "undo" / "reset to original"

The proposal's "Swap, then another swap, then undo" edge case spells out four explicit reversal patterns. Implement them as a small parser + a reverse-application path on the agent.

#### 7.1 — Detection in the dispatcher

Reversal is just another swap. The dispatcher routes "actually I found the wine, swap back" to `swap_ingredient` like any other ingredient message. The agent decides what "back" means — but with help: the user prompt to the agent already includes `swapHistory`. Add an explicit instruction in the agent's system prompt:

> When the user's message contains a reversal phrase ("swap back", "undo", "revert", "put X back", "use X again", "reset to original", "back to the library recipe"), interpret it against `swapHistory` per these rules:
> - Unqualified "swap back" / "undo" / "revert" → reverse only the most recent `SwapRecord`. Build the reverse `changes` so the batch returns to the pre-most-recent state.
> - Named reference ("the wine is back" / "put the passata back") → search `swapHistory` for the matching `SwapChange.from` field (case-insensitive). Reverse only that record. Other swaps stay.
> - "Reset to original" / "back to the library recipe" / "undo all my swaps" → return `nameOverride: null`, `bodyOverride: null`, the recipe's per-serving `actualPerServing` from the recipe scaler's original output (re-run the scaler with the recipe's intended targets — the agent emits a sentinel `kind: 'apply'` with `changes: [{ kind: 'rename', from: currentName, to: recipe.name }]` and a marker the applier inspects). For the macro/ingredients reset, the applier (not the agent) re-runs `scaleRecipe` against the batch's `targetPerServing` and writes the result.
> - Ambiguous "undo" with multiple swaps and no name → return `kind: 'clarification'` listing each swap one-per-line and asking which to undo.

#### 7.2 — Reset-to-original implementation

The agent cannot reliably regenerate the original `scaledIngredients` from prompt context. The applier owns this path:

- When the agent returns `apply` with the `reset_to_original: true` marker (a top-level boolean in the JSON), the applier ignores `scaled_ingredients` / `actual_per_serving` / `body_override` from the agent and instead:
  1. Calls `scaleRecipe({ recipe, targetCalories: batch.targetPerServing.calories, calorieTolerance, targetProtein: batch.targetPerServing.protein, servings: batch.servings }, llm)`.
  2. Writes the scaler's output to the batch via `store.updateBatch`.
  3. Sets `nameOverride: null`, `bodyOverride: null`, `swapHistory: []`.
  4. Renders cook view with delta line `Reset: returned to library recipe.`

#### 7.3 — Auto-apply vs ask-first for reversals

The proposal's last sentence in the reversal section: *"Auto-apply and ask-first rules from the 'When the bot asks first' design decision apply to reversals exactly as they apply to forward swaps."* Reuse the same agent decision pipeline; the agent's prompt explicitly applies the auto-apply criteria to the reversal.

Commit: `Plan 033 phase 7: swap reversal — undo, named, reset-to-original`.

---

### Phase 8 — Edge cases

Each edge case from the proposal § Edge cases is a concrete code or scenario change.

#### 8.1 — Unknown substitute (no macro knowledge)

Already handled by Phase 2: the agent returns `kind: 'preview'` with `reason: 'unknown_substitute'`, the preview text states the macro assumption explicitly. Test in scenario `0XX-swap-unknown-substitute`.

#### 8.2 — Mid-cook swap

No code change needed — the cook view re-renders on demand from `cv_<batchId>` callbacks. Steps before the swap point are stale on re-read; the proposal accepts this. Test in scenario `0XX-swap-mid-cook` to lock in the behavior.

#### 8.3 — User uses different units

The agent prompt must include the conversion table for common units (oz ↔ g, tbsp ↔ ml). Plain unit conversions are silent (`apply`); a structural scale shift (e.g., "two 10 oz fillets" when the recipe wants 280 g) triggers `preview` with the proposal's two-option text (scale to 4 servings vs keep 2 servings with bigger portions). Test in scenario `0XX-swap-unit-conversion-scale-shift`.

#### 8.4 — Ingredient appears in multiple batches

Handled end-to-end by Phase 4.2 (multi-candidate resolution → `PendingSwapMultiBatch`) and Phase 4.7 (pre-filter's multi-batch pick branch). The pre-filter accepts `"both"`, `"all"`, and `"all of them"` as synonyms for "every candidate" (useful when 3+ candidates match — rare but possible), plus ordinal picks ("the first", "the lunch one") and short-name matches. `"the next two"` and other subset-picks beyond those explicit phrases fall through to the dispatcher, which can clarify or treat the message as a rewrite. Test in scenario `071-swap-ambiguous-multi-batch` with at least "both" coverage; if seeding 3+ candidates is feasible, add an "all of them" assertion.

#### 8.5 — Batch already consumed (cook day in the past)

In `applySwapRequest` step 4 (target resolution), check whether every `eatingDay` of the matched batch is strictly less than today. If so, return:

```ts
{
  kind: 'hard_no',
  message:
    "That batch is already done — nothing left to cook. " +
    "If the same ingredient is in an upcoming batch and you want to swap " +
    "it there, tell me which one. Or if you want this swap baked into the " +
    "recipe across future weeks, edit the library recipe itself — that's " +
    "a separate conversation.",
  routingHint: 'library_edit',
}
```

Verbatim per proposal. Test in scenario `0XX-swap-batch-already-consumed`.

#### 8.6 — Catastrophic recipe-identity break

Already handled by Phase 2 (`hard_no` with `routingHint: 'recipe_level_swap'`). The agent decides; it errs on the side of `hard_no` when removing the only protein ingredients would empty out the recipe. Test in scenario `0XX-swap-no-protein-left`.

#### 8.7 — Voice input

No new code: voice transcription already runs upstream of the dispatcher (existing Whisper path in `bot.ts`). The dispatcher sees text identically. Test in scenario `0XX-swap-voice-input` to confirm parity.

Commit: `Plan 033 phase 8: edge cases (mid-cook, unit conversion, multi-batch, past batch, no protein, voice)`.

---

### Phase 9 — Breakfast swaps

Per proposal § Edge cases: *"Swaps work identically: 'no yogurt, use cottage cheese instead' updates the breakfast recipe scaling for the rest of the week. Same dispatcher, same mechanics. No special breakfast surface."*

Breakfast is locked weekly and stored on `PlanSession.breakfast` (`recipeSlug` + `caloriesPerDay` + `proteinPerDay`), not on a batch. Implementing swaps "identically" means the user-visible shape is the same — a single natural-language message mutates the breakfast for the rest of the week, the cook view (or equivalent breakfast detail view) re-renders with the delta — but the persistence path routes to `PlanSession.breakfastOverride` (Phase 1.1) instead of a batch row.

Phase 9 extends three surfaces that Phases 3–8 left batch-only:

- **Dispatcher context + prompt** — add the `breakfastLine` row to `DispatcherPlanSummary` (`breakfast|${slug} (${shortName}), locked, ingredients: <top-5>`); extend the action-catalog description to name breakfast as a legal target; add a "no yogurt, use cottage cheese" few-shot with `target_batch_id: 'breakfast'`.
- **Applier** — extend target resolution (9.1) and commit path (9.3) to dispatch on `targetId === 'breakfast'`.
- **Renderer + shopping list** — add `renderBreakfastCookView` and update `generateShoppingList*` to read `planSession.breakfastOverride` when set.

Shipping only Phase 9 on top of a tagged Phase 8 release produces breakfast swap parity with no other behavior change.

#### 9.1 — Target resolution

In `applySwapRequest` (`src/plan/swap-applier.ts`):

- `targetBatchId === 'breakfast'` → load the active plan session via `getVisiblePlanSession`. Build a `SwapTarget` with `kind: 'breakfast'`. The `currentIngredients` come from `planSession.breakfastOverride?.scaledIngredientsPerDay` when set; otherwise, materialize them by calling `scaleRecipe` against `breakfast.caloriesPerDay` / `breakfast.proteinPerDay` (servings=1) on the library recipe. Cache the materialized shape so the agent always sees a consistent input.
- Ingredient search in Phase 4.2 step 5 also scans the breakfast recipe's ingredients (or the override's `scaledIngredientsPerDay`). On a unique breakfast match the resolver produces `targetBatchId = 'breakfast'`.
- The past-batch rule (Phase 4.2 step 6) is skipped for breakfast — breakfast always has "future days" while the horizon is active.

#### 9.2 — Agent input

No new agent code. The agent sees a `SwapTarget` with `kind: 'breakfast'`. Phase 2's system prompt gets one added paragraph:

> When `target.kind === 'breakfast'`, the ingredients in `currentIngredients` are PER-DAY (not per-serving). A "servings" concept does not apply — each day is one serving. All macro comparisons (noise floor, Atwater check) apply to `currentMacros` as per-day numbers. The result's `scaledIngredients` are per-day amounts. Name overrides still apply ("no yogurt, use cottage cheese" may rename the breakfast display name to e.g. "Cottage Cheese Toast" if that change is unambiguous). Step rewrites apply the same way — steps referencing the swapped ingredient get rewritten.

#### 9.3 — Commit path

`commitPendingSwap` and `commitPendingSwapMulti` already branch on `targetId`:

- `targetId === 'breakfast'` → build the `BreakfastOverride` from the pending `proposed` payload (`scaledIngredientsPerDay = proposed.scaledIngredients`, `actualPerDay = proposed.actualMacros`, `nameOverride`, `bodyOverride`, append a new `SwapRecord` to the existing override's `swapHistory` — or start a new list when the override is being created for the first time). Call `store.updatePlanSessionBreakfast(planSessionId, override)`.
- Any other `targetId` → `store.updateBatch(...)` as usual.

#### 9.4 — Rendering

Breakfast does not have a `cv_<batchId>` cook view today. The proposal shows cook-card-shaped replies for all swap responses including breakfast, so we add `renderBreakfastCookView` in `src/recipes/renderer.ts`:

```ts
/**
 * Render the breakfast as a cook-view-shaped card. Matches the shape of
 * `renderCookView` but uses per-day amounts and the session's
 * `breakfastOverride` when present. Always emits the delta block footer
 * when `options.deltaLines` is non-empty, identical to the batch cook view.
 */
export function renderBreakfastCookView(
  recipe: Recipe,
  planSession: PlanSession,
  options?: { deltaLines?: string[] },
): string;
```

The swap applier calls `renderBreakfastCookView` in place of `renderCookView` when the committed target is `'breakfast'`. The keyboard is a new `breakfastViewKeyboard(planSessionId)` (or simply the main-menu keyboard — there's no "cook this" button for breakfast since it's daily). Default to the main-menu keyboard for v1; a dedicated breakfast-view callback can come later if needed.

#### 9.5 — Shopping list propagation

`src/shopping/generator.ts` today reads breakfast ingredients from the library recipe and prorates by `horizonDays`. After Phase 9, update `generateShoppingList` and friends to check `planSession.breakfastOverride?.scaledIngredientsPerDay` first — when present, use those amounts (they're already per-day like the library recipe) and the `breakfastOverride.nameOverride` as the aggregation-map name seed.

Pass the plan session (not just the recipe) into the shopping generators that include breakfast. Signature change:

```ts
export function generateShoppingList(
  batches: Batch[],
  planSession: PlanSession | undefined,  // was: breakfastRecipe: Recipe | undefined
  recipes: RecipeDatabase,                // NEW — needed to resolve breakfast.recipeSlug when override is absent
  options: { targetDate: string; remainingDays: number },
): ShoppingList;
```

Apply the same change to `generateShoppingListForWeek` and `generateShoppingListForDay`. Update every call site (`dispatcher-runner.ts`, `view-renderers.ts`, `core.ts`). `generateShoppingListForRecipe` is unchanged — recipe-scoped shopping excludes breakfast by contract.

#### 9.6 — Reset-to-original for breakfast

Phase 7's "reset to original" on a breakfast target clears `breakfastOverride` via `store.updatePlanSessionBreakfast(planSessionId, null)`. The renderer then falls through to library-recipe rendering. Same user-visible shape as batch reset.

#### 9.7 — Scenario coverage

Add a breakfast scenario to Phase 10 (see table update). Minimum coverage: one auto-apply swap on breakfast, one rewrite follow-up, one reset-to-original.

Commit: `Plan 033 phase 9: breakfast swap parity with batch swaps`.

---

### Phase 10 — Test harness scenarios

Per the project's testing contract (`docs/product-specs/testing.md`), every user-visible behavior gets a scenario, and every hard product invariant gets a fixture-edited scenario that exercises the guardrail. Emergency swap is a high-surface-area feature — auto-apply + ask-first + reversal + multi-batch + breakfast + pantry-staple rules — so the scenario set has to be extensive. Shallow happy-path-only coverage would miss the exact failure modes the proposal's guardrails exist to prevent.

This phase ships **21 scenarios across six tiers**:

1. **Core happy paths** (7) — the proposal's seven screens, one scenario each.
2. **Reversal** (3) — every reversal form described in the proposal's edge case.
3. **Agent decision paths** (4) — structural edges the agent must resolve correctly.
4. **Pre-filter & state** (2) — deterministic routing and lifecycle-clear invariants.
5. **Dispatcher boundary** (1) — `swap_ingredient` vs `mutate_plan` disambiguation.
6. **Fixture-edited guardrails** (3) — the proposal's hard invariants, tested by INJECTING violating LLM responses and asserting the applier catches them.

Plus a breakfast-dedicated scenario that covers Phase 9 end-to-end.

Scenario numbering is sequential from 066; confirm with `ls test/scenarios/` immediately before authoring and re-number forward if collisions exist. Recipe-set choice: `six-balanced` for most; scenarios that require a specific recipe (e.g., 076 salmon-calamari-pasta for identity-break) pick from the existing fixture sets — do not author new recipe-set fixtures just for this plan.

#### 10.1 — Core happy paths (Screens 1–7)

| # | Scenario | Maps to proposal | Key assertions |
|---|---|---|---|
| 066 | `swap-simple-auto-apply` | Screen 1 — wine → stock on cook view | delta block renders with "Swapped: dry white wine → beef stock + lemon juice"; `batch.scaledIngredients` reflects both; `swapHistory` has one record with `changes` matching; `body` has no "white wine" mentions; `actualPerServing.calories` within noise floor of target |
| 067 | `swap-compound-rebalance` | Screen 2 — two swaps in one message + olive-oil rebalance | delta block has BOTH "Swapped" lines AND the "Rebalanced: olive oil 15g → 18g" line; macro drift beyond noise triggered the rebalance; step 7 rewritten for cherry-tomato crushing |
| 068 | `swap-removal-acknowledgment` | Screen 3 — two removals, one rebalances, one doesn't | delta lists both removals (acknowledgment rule: "confirm every user-named change"); only the caloric removal shows a rebalance line; parsley removal is acknowledged silently on the macro front |
| 069 | `swap-help-me-pick` | Screen 4 — shopping aisle "what should I get?" | reply contains 2–3 named options with amounts + per-option macro impact lines; `batch.scaledIngredients` UNCHANGED (help-me-pick does not persist); `swapHistory` still empty |
| 070 | `swap-aisle-applied` | Screen 5 — follow-up "got the cod, 320g" after help-me-pick | applied swap with rename ("Cod and Calamari Linguine"); delta includes "Shopping list updated: salmon removed, cod added" line (Phase 5.4); shopping list re-render after the swap has cod and not salmon (assert via a follow-up `sl_next` callback in the same scenario) |
| 071 | `swap-ambiguous-multi-batch` | Screen 6 — chicken → tofu across two batches | first reply is aggregate preview text; `session.pendingSwap.kind === 'multi_batch'` with two candidates, each carrying its own pre-computed `proposed`; after `text("both")`, `applied_multi` commits both — each candidate's `batch.scaledIngredients` now has tofu, each `swapHistory` has a record, and the shopping list across both batches reflects the change |
| 072 | `swap-structural-ask-first` | Screen 7 — "use tofu instead of chicken breast" on cook view | preview text mentions the 30% portion bump and the protein-gap honesty; `session.pendingSwap.reason === 'structural'`; after `text("go ahead")` the pre-filter commits (no dispatcher LLM call — assert via `execTrace` that only the applier's agent call fired, not a dispatcher call); final batch state reflects tofu + bumped portion |

#### 10.2 — Reversal (§ "Swap, then another swap, then undo")

| # | Scenario | Maps to proposal | Key assertions |
|---|---|---|---|
| 073 | `swap-undo-most-recent` | Reversal §1 | Seed a batch with `swapHistory` of two records (wine→stock then passata→cherry). User types `"undo"`. Resulting batch has one `swapHistory` record (the wine swap), the passata is back, steps reflect the passata version |
| 074 | `swap-reset-to-original` | Reversal §3 | Seed a batch with three swap records and `nameOverride`/`bodyOverride`. User types `"reset to original"`. After commit: `nameOverride = null`, `bodyOverride = null`, `swapHistory = []`, `scaledIngredients` match what `recipe-scaler` would produce against `batch.targetPerServing`. Assert `execTrace` shows a `recipe-scaling` call was made during the reset (the applier re-ran the scaler per Phase 7.2) |
| 075 | `swap-named-and-ambiguous-undo` | Reversal §2 + §4 — combined in one scenario with two turns | Seed a batch with three swaps (wine, passata, parsley-removal). Turn 1: user types `"put the passata back"` → named undo, only the passata swap is reversed, wine+parsley swaps preserved. Turn 2: user types `"undo"` → ambiguous (two remain); agent returns `kind: 'clarification'` with both swaps enumerated; assert the clarification lists the remaining swaps one-per-line |

#### 10.3 — Agent decision paths

| # | Scenario | Maps to proposal | Key assertions |
|---|---|---|---|
| 076 | `swap-batch-already-consumed` | Edge — past batch | Seed a batch whose every `eatingDay` is strictly before the clock. User types a swap. Applier returns `hard_no` with the verbatim "That batch is already done" message + `routingHint: 'library_edit'`. `batch.scaledIngredients` unchanged; `session.pendingSwap` absent |
| 077 | `swap-catastrophic-no-protein` | Edge — recipe identity break | On salmon-calamari pasta cook view, user says `"skip the salmon AND the calamari"`. Agent returns `kind: 'hard_no'` with `routingHint: 'recipe_level_swap'`. Reply contains both option (a) and option (b) from the proposal verbatim. No persistence |
| 078 | `swap-unknown-substitute-preview` | Edge — unknown substitute | User says `"use my grandma's pickled wild garlic"` on a cook view with parsley. Agent returns `kind: 'preview'` with `reason: 'unknown_substitute'`; preview text explicitly states the macro assumption ("reading this as ~12 cal/tbsp pickled garlic"); `pendingSwap` stashed. User responds `"12 cal is right, go ahead"` — pre-filter's confirm branch applies the swap. Final state shows pickled garlic in ingredients with the stated macros |
| 079 | `swap-unit-conversion-scale-shift` | Edge — different units | User says `"two 10 oz salmon fillets, I grabbed two"` on salmon-calamari pasta cook view. Agent recognizes ~566g salmon is a structural scale shift from the recipe's 280g. Returns `kind: 'preview'` with the two-option text (4-serving scale vs 2-serving bigger portions). User picks one via pre-filter or free text; assert the committed batch's `servings` + `scaledIngredients` reflect the pick |

#### 10.4 — Pre-filter & state preservation

| # | Scenario | Maps to proposal | Key assertions |
|---|---|---|---|
| 080 | `swap-cancel-and-rewrite` | Phase 4.7 + Phase 3.3 | Three-turn scenario: (1) user says `"use tofu instead of chicken"` → preview, `pendingSwap` set. (2) user says `"actually, use chickpeas instead"` — the pre-filter does NOT match (it's not a cancel/confirm/pick), message falls through to the dispatcher which sees `pendingSwap` in context and re-routes to `swap_ingredient` carrying `target_batch_id=pendingSwap.targetIdHint`; applier drops the prior pending and produces a new preview for chickpeas. (3) user says `"nevermind"` — pre-filter's cancel branch clears `pendingSwap`; assert `session.pendingSwap === undefined` in `finalSession` and the final reply is the cancel acknowledgment |
| 081 | `swap-pending-cleared-by-lifecycle` | Phase 4.6 state-preservation invariant | Four-turn scenario on a confirmed plan: (1) user triggers a structural preview → `pendingSwap` set. (2) user taps `📋 Plan Week` button to start a new planning flow → assert `session.pendingSwap === undefined` (planFlow start clears it). (3) bail out of the planFlow; trigger another preview → `pendingSwap` set again. (4) user types `/start` → assert `pendingSwap === undefined`. (Covers two of the ~14 sites where the parallel clear lives — pick the two most-error-prone; the remaining sites are audited by grep-based static verification listed in §10.7.) |

#### 10.5 — Dispatcher boundary

| # | Scenario | Maps to proposal | Key assertions |
|---|---|---|---|
| 082 | `swap-dispatcher-boundary` | Phase 3.2 boundary rules — 2-turn scenario | Turn 1: user on cook view says `"swap tomorrow's dinner for something lighter"` → dispatcher picks `mutate_plan` (recipe-level), NOT `swap_ingredient`. Assert `execTrace` shows `mutate_plan` action and the re-proposer was called. Turn 2: same cook view, user says `"no white wine, use beef stock"` → dispatcher picks `swap_ingredient`; assert `execTrace` shows `swap_ingredient` action and the ingredient-swap agent was called. This scenario pins the boundary that otherwise drifts every time the prompt is retuned |

#### 10.6 — Fixture-edited guardrails (HIGHEST VALUE)

These scenarios follow the fixture-edit protocol (CLAUDE.md § "Fixture-edited scenarios: NEVER `--regenerate` after applying edits"). Each has `spec.ts`, `fixture-edits.md` documenting the manual edit, `fixture-assertions.ts` that runs in both `test:replay` and `npm test`, and a `recorded.json` captured after the edit via `npm run test:replay`. They test hard product invariants from the proposal that the real LLM may or may not violate on any given day — the only reliable way to confirm the applier's guardrail catches the violation is to inject it.

| # | Scenario | Invariant tested | Fixture edit | Expected applier behavior |
|---|---|---|---|---|
| 083 | `swap-guardrail-precisely-bought-unchanged` | Proposal § "Untouched stays untouched" — precisely-bought items keep exact name + amount unless the user named them | Edit the recorded ingredient-swap agent response so that a precisely-bought ingredient the user DID NOT name (e.g., chicken breast weight in a beef-swap scenario) silently changes from 200g to 180g | Applier rejects the agent output — either logs a warning and reverts the unnamed-ingredient change before persisting, or returns `hard_no` with an honest "I tried to change something you didn't ask about — try again." Scenario asserts that after the turn, the chicken amount is still 200g (unchanged from seed) |
| 084 | `swap-guardrail-helper-named-in-delta` | Proposal § "pantry-staple helper may be introduced... always named openly in the delta" | Edit agent response so the ingredient list gains `"lemon juice 1/2 tsp"` (helper for a wine→stock swap) but `delta_lines` does NOT mention it | Applier detects the delta/ingredient mismatch and either rejects the swap OR regenerates the delta line from the diff before rendering. Scenario asserts the rendered reply contains the "+ lemon juice" text in the delta block |
| 085 | `swap-guardrail-no-new-precisely-bought` | Proposal § "introducing a new precisely-bought ingredient... is a hard no" | Edit agent response to add a new precisely-bought ingredient the user did not name (e.g., `"pine nuts 30g"` appears in the output) | Applier rejects the swap with `hard_no`. Scenario asserts `batch.scaledIngredients` unchanged from seed; rendered reply explains the rejection honestly ("That swap would add pine nuts to your shopping list — I can't add ingredients you didn't ask for. Want to try again?") |

Implementing the guardrails requires adding a post-agent validation step in `src/plan/swap-applier.ts` (Phase 4.3) that checks the agent's output against the seed batch's `scaledIngredients` and the pantry-staple list (from Phase 2.2's prompt rules codified into a shared constant). The validator returns either `ok` or a specific rejection reason. This validator is a Phase 4 deliverable made concrete by Phase 10.6's scenarios — it must land with Phase 4 even though its tests live here.

#### 10.7 — Breakfast (Phase 9)

| # | Scenario | Maps to proposal | Key assertions |
|---|---|---|---|
| 086 | `swap-breakfast-full-lifecycle` | Edge — breakfast (Phase 9) | Three-turn scenario: (1) user types `"no yogurt, use cottage cheese instead"` — dispatcher picks `swap_ingredient` with `target_batch_id='breakfast'`; auto-apply path updates `PlanSession.breakfastOverride.scaledIngredientsPerDay` AND `actualPerDay`; reply is `renderBreakfastCookView` with delta block. (2) user types `"actually, use ricotta instead"` — rewrite path; fresh preview or apply; override's `swapHistory` has two entries. (3) user types `"reset to original"` — `breakfastOverride === null` after this; reply renders from library recipe. Also assert that the shopping list (via follow-up `sl_next`) reflects cottage cheese after step 1, ricotta after step 2, and yogurt after step 3 — the live-projection invariant holds for breakfast identically to batches |

#### 10.8 — Scenario authoring protocol

For every scenario (including fixture-edited ones):

1. Author `spec.ts` with seeded `planSessions` + `batches` (mirror scenario 045's seeding pattern for persisted-plan tests; mirror scenario 044 for in-session tests).
2. **Standard scenarios**: run `npm run test:generate -- <name>` to capture `recorded.json` against the real LLM.
3. **Fixture-edited scenarios (083–085)**: after step 2, apply the edit described in `fixture-edits.md`, then run `npm run test:replay -- <name>` to re-record expected outputs from the edited fixtures. NEVER run `--regenerate` on these — it would silently destroy the edits.
4. Behavioral validation per `docs/product-specs/testing.md` § "Verifying recorded output" — read the recording as the user, verify delta block correctness, ingredient-list correctness, no ghost references in steps, swap history appended correctly, shopping-list propagation where applicable.
5. Add `assertions.ts` for behavior-level assertions beyond `deepStrictEqual`. Minimum helpers to extract into `src/harness/swap-assertions.ts` (or add to existing assertion helpers):
   - `assertBatchIngredient(store, batchId, name, { amount, unit })` — single-field check.
   - `assertBatchDoesNotHaveIngredient(store, batchId, name)`.
   - `assertSwapHistoryAppended(store, batchId, expected: Partial<SwapRecord>[])`.
   - `assertBreakfastOverride(store, planSessionId, expected: Partial<BreakfastOverride> | null)`.
   - `assertPendingSwap(session, expected: Partial<PendingSwap> | undefined)`.
   - `assertExecTraceContains(trace, kind, op?)` — for the fixture-edited scenarios and the boundary scenario.
6. Add `certification.json` with status `certified` once the recording passes review.
7. Update `test/scenarios/index.md` with the new entry.

**Parallel regen, serial review** (per the project's debug-workflow rule): run `npm run test:generate` for all 21 scenarios IN PARALLEL (delete each target `recorded.json` first, launch concurrently, wait). Then do the 5-step behavioral validation ONE BY ONE, serially — never in parallel. Fixture-edited scenarios (083–085) skip the parallel regen step and are done fully serially after their base fixtures exist.

**Static lifecycle-clear audit** (complements scenario 081): grep `core.ts` for every `session.pendingMutation = undefined;` site. Every such site must have a sibling `session.pendingSwap = undefined;` line. Record the audit list in the plan's Progress section as a checklist of line numbers. Any site missed is a runtime state-leak waiting for a user to trigger.

Commits: one per scenario, message format `Plan 033 phase 10: scenario NNN-<name>`. The static-audit checklist gets its own commit: `Plan 033 phase 10: lifecycle-clear audit`.

---

### Phase 10a — Regression sweep on cross-cutting changes

Three phases in this plan change shared infrastructure; every existing scenario that exercises the touched surface must be regenerated and behaviorally reviewed. Skipping this step is how silent regressions reach production.

#### 10a.1 — Scenarios affected by Phase 3.4 (dispatcher context)

Phase 3.4 changes `buildDispatcherContext` in two ways: it loads own + overlapping batches (not just own), and it extends `batchLines` format with `${b.id}|` and an ingredient signature. Both changes mutate the dispatcher's prompt content, which changes the fixture-recorded LLM response hash. Every dispatcher-exercising scenario needs regeneration:

- `017-free-text-fallback`
- `020-planning-intents-from-text`
- `021-planning-cancel-intent`
- `037-dispatcher-flow-input-planning`
- `038-dispatcher-out-of-scope`
- `039-dispatcher-return-to-flow`
- `040-dispatcher-clarify-multiturn`
- `041-dispatcher-cancel-precedence`
- `042-dispatcher-numeric-prefilter`
- `043-dispatcher-plan-resume-callback`
- `044-mutate-plan-in-session`
- `045-mutate-plan-eat-out-tonight`
- `046-mutate-plan-flex-move`
- `047-mutate-plan-recipe-swap`
- `048-mutate-plan-side-conversation-mid-planning`
- `049-mutate-plan-adjust-loop`
- `050-mutate-plan-no-target`
- `051-mutate-plan-meal-type-lane`
- `052-mutate-plan-retroactive-honest`
- `053-mutate-plan-post-confirm-clarification-resume`
- `054-answer-plan-question`
- `055-answer-recipe-question`
- `056-answer-domain-question`
- `057-show-recipe-in-plan`
- `058-show-recipe-library-only`
- `059-show-recipe-multi-batch`
- `060-show-plan-day-detail-natural-language`
- `061-show-shopping-list-recipe-scope`
- `062-show-shopping-list-full-week`
- `063-show-progress-weekly-report`
- `064-log-measurement-cross-surface`
- `065-answer-then-mutate-state-preservation`

**Count: 32 scenarios.** Confirm the list with `grep -l "dispatchMessage\|dispatcher" test/scenarios/*/spec.ts` immediately before running; append any new scenarios authored after this plan was written.

#### 10a.2 — Scenarios affected by Phase 9.5 (shopping-list signature change)

Phase 9.5 changes `generateShoppingList` / `generateShoppingListForWeek` / `generateShoppingListForDay` to take `PlanSession | undefined` + `RecipeDatabase` instead of `Recipe | undefined`. This is a TypeScript-level change (compile-time caught) AND a runtime-behavior change (when `breakfastOverride` is set, the list reads from it instead of the library recipe). Scenarios that render any shopping list need fixture regen because the internal call sequence changes even when the rendered output is identical:

- `001-plan-week-happy-path` (if shopping list is rendered; otherwise skip)
- `019-shopping-list-tiered`
- `022-upcoming-plan-view`
- `031-shopping-list-mid-planning-audit`
- `061-show-shopping-list-recipe-scope`
- `062-show-shopping-list-full-week`

Any scenario that calls `sl_next` / `sl_<date>` callbacks.

#### 10a.3 — Scenarios affected by Phase 4.6 (session field additions)

Phase 4.6 adds `session.pendingSwap` to `BotCoreSession`. Every scenario's `finalSession` assertion compares the whole session object, so an added-but-undefined field should be backward-compatible via the `TestStateStore`'s snapshot serialization. Confirm this with ONE scenario run first — if `finalSession` assertions break across the board because `pendingSwap: undefined` leaks into the snapshot, fix the snapshot serializer (drop `undefined` keys) before regenerating everything.

#### 10a.4 — Sweep protocol

1. **Baseline**: run `npm test` on the branch immediately before starting the sweep. Confirm all affected scenarios are green — this is the reference point for "what broke due to the sweep" vs "what broke due to Phase 3/9.5."
2. **Batch delete + parallel regen**: delete every affected scenario's `recorded.json` in one command, then launch `npm run test:generate -- <name> --regenerate --yes` for every scenario concurrently. **Do NOT include fixture-edited scenarios** in this batch — they must be replayed, not regenerated. `014-proposer-orphan-fill` (if it has fixture edits) is an example; search for `fixture-edits.md` files before running.
3. **Serial behavioral review**: for each regenerated scenario, run the 5-step protocol from `docs/product-specs/testing.md`. Any scenario whose transcript changed in an unexpected way is a regression that must be debugged before the sweep completes. Expected shape of change for dispatcher scenarios: the dispatcher's reasoning text may differ (harmless) and any plan summary rendered inline will include `batch-id|` prefixes (harmless cosmetic). The user-facing reply text should NOT change for any correctly-functioning scenario.
4. **Certification refresh**: after each scenario's review passes, bump its `certification.json` to the new hash.
5. **`npm run review` sanity**: with all scenarios re-certified, run `npm run review` (no args) and confirm every row is `certified`. Any `needs-review` or `uncertified` row blocks the sweep's completion.

Commit cadence: one commit per scenario when review passes (so a mid-sweep interruption doesn't lose work), OR one batch commit for all-green scenarios when the sweep completes cleanly. Either is fine — the constraint is that no intermediate commit leaves `npm test` red.

---

### Phase 11 — Specs, docs, and final wiring

The product specs ARE the source of truth — update them in the same plan that ships the code.

#### 11.1 — Update `docs/product-specs/data-models.md`

- **`Batch` interface**: document the three new optional fields (`nameOverride`, `bodyOverride`, `swapHistory`) and the corresponding `batches` table columns (`name_override`, `body_override`, `swap_history`).
- **`PlanSession` interface**: document the new optional `breakfastOverride` field and the corresponding `plan_sessions.breakfast_override` column. State explicitly that `breakfastOverride` is absent on all drafts (per the `DraftPlanSession` `Omit` list) and is only materialized when the first emergency swap commits against a session's breakfast.
- **New types**: add `SwapRecord`, `SwapChange` (with its discriminated variants: `replace`, `remove`, `add`, `rebalance`, `rename`), and `BreakfastOverride` to the type reference.
- **Invariants**: note the per-batch vs per-session override boundary — the library recipe stays canonical; overrides are per-plan-instance; a reset clears the override back to `null`/`undefined` on its carrier.
- **Migration reference**: mention migration `006_batch_and_breakfast_swap_overrides.sql` and its role as the canonical schema-change point for this feature.

#### 11.2 — Update `docs/product-specs/flows.md`

New top-level section: **Emergency ingredient swap flow**. Document:
- The auto-apply vs ask-first decision rules.
- The five user-visible response shapes (apply, preview, help-me-pick, clarification, hard_no).
- The reversal vocabulary ("swap back" / named / "reset to original" / ambiguous).
- Breakfast swap parity (per-day semantics, `'breakfast'` target).
- Pointers to scenarios 066–077.

#### 11.3 — Update `docs/product-specs/ui.md`

Add a section: **Cook-view delta block**. Document the format (em-dash separator, one line per change, optional macro line, optional shopping-list line). Reference both renderers (`renderCookView` for batches, `renderBreakfastCookView` for breakfast — same footer shape, different inputs).

#### 11.4 — Update `docs/product-specs/recipes.md`

One paragraph: how `nameOverride` / `bodyOverride` interact with library recipes — the library recipe is canonical; the batch (or `PlanSession.breakfastOverride` for breakfast) carries per-instance overrides; library recipes are never touched by emergency swap. Cross-reference `docs/product-specs/data-models.md` for the type definitions.

#### 11.5 — Update `docs/ARCHITECTURE.md`

In the "Where to look for specific tasks" table:
- "Change emergency ingredient swap behavior" → `src/agents/ingredient-swap.ts`, `src/plan/swap-applier.ts`, `src/recipes/renderer.ts`.

In the dependency flow diagram, add `agents/ingredient-swap.ts` and `plan/swap-applier.ts` under the dispatcher branch.

#### 11.6 — CLAUDE.md — no change

The new sub-agent and applier follow the existing patterns (re-proposer, mutate-plan-applier). No new conventions to teach.

#### 11.7 — Update `docs/PRODUCT_SENSE.md` — deferred

Per proposal § Out of scope, promoting the "bot has no location" principle is a follow-up doc edit, not part of this plan. Add a one-line entry to `docs/BACKLOG.md` instead so it's tracked.

#### 11.8 — Move the plan to `completed/`

Per the project plans README, set status to `Completed` and move the file once every phase ships and `npm test` is green.

Commit: `Plan 033 phase 11: specs, architecture, backlog updates`.

## Progress

- [x] Phase 0: Promote proposal to design doc
- [x] Phase 1: Data model + persistence (Batch fields, migration, store.updateBatch)
- [x] Phase 2: Ingredient-swap sub-agent
- [x] Phase 3: Dispatcher `swap_ingredient` action
- [x] Phase 4: Swap applier + ask-first/auto-apply policy
- [x] Phase 5: Cook-view rendering with delta block  (delivered inside Phase 4 commit — renderCookView now takes `options.deltaLines` + honors `nameOverride`/`bodyOverride`)
- [x] Phase 6: Shopping-list verification  (no code change — `generateShoppingList*` reads `batch.scaledIngredients`; breakfast-side change is Phase 9.5)
- [x] Phase 7: Reversal (undo / named / reset-to-original)  (agent prompt carries the reversal rules; applier's `applyResetToOriginal` re-runs scaleRecipe and clears overrides)
- [x] Phase 8: Edge cases (mid-cook, unit, multi-batch, past, no-protein, voice)  (agent prompt + past-batch check + multi-batch resolver + guardrail validator cover these)
- [x] Phase 9: Breakfast swaps (parity with batch swaps via `'breakfast'` targetId)
- [ ] Phase 10: 21 scenarios (7 core + 3 reversal + 4 agent-decision + 2 pre-filter/state + 1 dispatcher-boundary + 3 fixture-edited guardrails + 1 breakfast)
  - [ ] 066–072 core happy paths
  - [ ] 073–075 reversal
  - [ ] 076–079 agent decision paths
  - [ ] 080–081 pre-filter & state
  - [ ] 082 dispatcher boundary
  - [ ] 083–085 fixture-edited guardrails
  - [ ] 086 breakfast full lifecycle
  - [ ] `pendingSwap` lifecycle-clear grep audit (record line numbers)
- [ ] Phase 10a: Regression sweep (≥32 dispatcher scenarios + ~6 shopping-list scenarios)
  - [ ] 10a.1 dispatcher-context regen (017, 020, 021, 037–065)
  - [ ] 10a.2 shopping-list regen (001, 019, 022, 031, 061, 062)
  - [ ] 10a.3 `pendingSwap` snapshot-serializer check
  - [ ] 10a.4 serial 5-step behavioral review on every regenerated scenario
  - [ ] `npm run review` shows every row `certified`
- [ ] Phase 11: Specs, architecture, backlog updates
- [ ] Move plan to `completed/`

## Decision log

- **Decision: separate `swap_ingredient` action vs folding into `mutate_plan`.**
  Rationale: The proposal explicitly distinguishes ingredient-level edits (mutates ONE batch's contents) from recipe-level swaps (different recipe in a slot). `mutate_plan` runs the re-proposer over the WHOLE plan and is the right home for "swap tomorrow's dinner for fish." Ingredient swaps run a focused sub-agent over ONE batch and never touch other batches. Folding them would force `mutate_plan` to grow a discriminator and would lose the precision of having two different prompts and two different result types. Separation also keeps each agent's prompt small enough to reason about.
  Date: 2026-04-13.

- **Decision: implement breakfast swaps with a `'breakfast'` sentinel targetId (not a separate dispatcher action or a separate applier).**
  Rationale: The proposal's "Breakfast recipes" edge case is explicit — *"Swaps work identically. Same dispatcher, same mechanics. No special breakfast surface."* A deferral would be a scope cut relative to the proposal. A separate dispatcher action or applier would multiply code paths for what is, semantically, one feature. Using a sentinel `targetId` keeps the dispatcher's output shape uniform, keeps the pre-filter / agent / renderer dispatch readable (one `if (targetId === 'breakfast')` branch per site), and lets every test scenario exercise the same end-to-end flow against either target. The persistence difference (`PlanSession.breakfastOverride` vs `Batch` fields) is localized to Phase 1.3's `updatePlanSessionBreakfast` method.
  Date: 2026-04-14.

- **Decision: pre-compute per-candidate proposed payloads at preview time for multi-batch swaps.**
  Rationale: The alternative — stash only candidate descriptors at preview time, re-run the agent per committed candidate at commit — makes the "both" path asymmetric (one LLM call at preview, N calls at commit). Pre-computing means N calls at preview, zero at commit. This yields a deterministic commit (no LLM failure between preview and "both"), keeps total call count identical (`1 + N` either way when counting the aggregate preview call), and lets the pre-filter commit synchronously without any async agent retry loops. The user-visible effect is a slightly slower preview and a snappy commit, which is the right tradeoff — the preview is the moment the user is reading the diff anyway.
  Date: 2026-04-14.

- **Decision: `trySwapPreFilter` runs before the dispatcher LLM call for every inbound text when `pendingSwap` is set.**
  Rationale: Without the pre-filter, bare confirmations ("go ahead", "yes") would go through the dispatcher LLM and could land as `clarify`, `out_of_scope`, or even `flow_input` — none of which is the commit path. The pre-filter's regex set is small and deterministic. Mirroring `tryNumericPreFilter` keeps the architectural shape consistent. Rewrite messages ("actually use cod") intentionally fall through to the dispatcher, which sees `pendingSwap` in its context and routes them to `swap_ingredient` with the preserved `targetIdHint`.
  Date: 2026-04-14.

- **Decision: full updated cook view as the response, even in the grocery aisle.**
  Rationale: Per proposal § "Full updated card above, delta line at the bottom" — predictable formatting beats context-sensitive trimming. Telegram auto-scrolls to the bottom; the delta line answers "what just changed?" first; the card sits above for cook night. Adding a terse aisle-only mode is explicitly listed as out-of-scope in the proposal.
  Date: 2026-04-13.

- **Decision: reuse the existing `recipe-scaler` for "reset to original".**
  Rationale: The agent cannot reliably regenerate the original `scaledIngredients` from prompt context (the LLM doesn't have a perfect memory of every roundoff). Re-running the scaler against `batch.targetPerServing` produces a deterministic answer with the same code path that built the batch in the first place. Cost is one extra mini-tier call on a path the user explicitly invoked ("reset to original") — the right tradeoff for correctness.
  Date: 2026-04-13.

- **Decision: pendingSwap is in-memory only, not persisted.**
  Rationale: Same as `pendingMutation` (Plan 029). A bot restart drops the preview; the user re-types if needed. Persisting would require a new table and a TTL strategy for stale previews — over-engineering for a transient state that lives between two messages.
  Date: 2026-04-13.

- **Decision: confirmation / cancellation / multi-batch-pick phrases are matched deterministically (regex + candidate-set scorer), not via LLM classification.**
  Rationale: When `pendingSwap` is set, phrases like "go ahead" / "yes" / "do it" / "both" / "just the lunch one" are unambiguous in context — they target the pending preview specifically. Routing them through the dispatcher's reasoning LLM would cost latency and money for a short-phrase classification that a pinned regex set handles with no ambiguity. The match lives in `trySwapPreFilter` (Phase 4.7), which runs BEFORE the dispatcher LLM on every inbound text when `pendingSwap` is set — mirroring the placement of `tryNumericPreFilter` for measurement input. The dispatcher still sees `pendingSwap` in its context (Phase 3.3) for the rewrite path ("actually use cod instead"), because rewrites are free-form and benefit from the LLM's framing.
  Date: 2026-04-14.

## Validation

The implementation is correct when:

1. **`npm test` is green** with all 21 new scenarios (066–086) AND every regenerated scenario from Phase 10a in `certified` state per `npm run review`. No row in `npm run review` (no args) is `needs-review` or `uncertified`.
2. **Behavioral validation** per `docs/product-specs/testing.md` § "Verifying recorded output" passes for each of scenarios 066–086: the recorded transcripts match the proposal's screens (1–7) + reversal + agent decision paths + pre-filter paths + dispatcher boundary + breakfast. Fixture-edited scenarios (083–085) specifically assert the applier catches the injected violation rather than silently persisting it.
3. **Regression sweep validation** (Phase 10a) — every dispatcher-exercising scenario (≥32) and every shopping-list-rendering scenario (~6) is regenerated, behaviorally re-reviewed, and certified. For each regenerated scenario, the user-facing reply text is either identical to pre-sweep or differs in an expected, documented way. Unexpected transcript drift is a regression and blocks the sweep.
3. **Round-trip** through the harness `TestStateStore` writes and reads the new batch override fields AND the `PlanSession.breakfastOverride` (both with non-empty `swapHistory`). The migration `006_batch_and_breakfast_swap_overrides.sql` matches `supabase/schema.sql`.
4. **Real-Telegram smoke test** (`npm run dev`): walk the four canonical paths from the proposal's debug log:
   - Cook view: "no white wine, use beef stock instead" → auto-apply, delta visible.
   - Cook view: "no white wine and no passata — use beef stock and cherry tomatoes" → compound auto-apply with rebalance line.
   - Shopping view: "they don't have salmon, what should I get?" → 2–3 options.
   - Cook view: "use tofu instead of chicken breast" → preview with protein-gap honesty, then "go ahead" → apply.
5. **No regression** in any pre-existing scenario (1–065) — `npm test` baseline holds before and after each phase per the project's debug workflow rule.
6. **Specs match code** — `docs/product-specs/data-models.md`, `flows.md`, `ui.md`, `recipes.md`, and `ARCHITECTURE.md` all reflect the shipped behavior in the same commit as the relevant code.
7. **Library recipes are unchanged** — grep `data/recipes/*.md` for any change in this plan: there should be zero. The library is never touched by emergency swap.
