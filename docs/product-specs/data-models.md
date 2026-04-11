# Data Models

> Scope: Core TypeScript interfaces and their relationships. See also: [recipes.md](./recipes.md) for recipe format details, [solver.md](./solver.md) for solver I/O types.

Source: `src/models/types.ts`, `src/solver/types.ts`

## Core types (`src/models/types.ts`)

### PlanSession

A confirmed 7-day planning horizon. Lightweight marker — batches reference it via `createdInPlanSessionId`, not embedded.

```typescript
interface PlanSession {
  id: string;
  horizonStart: string;              // ISO date — first day of 7-day horizon
  horizonEnd: string;                // ISO date — horizonStart + 6 days
  breakfast: {
    locked: boolean;
    recipeSlug: string;
    caloriesPerDay: number;
    proteinPerDay: number;
  };
  treatBudgetCalories: number;
  flexSlots: FlexSlot[];
  events: MealEvent[];
  mutationHistory: MutationRecord[]; // Plan 026 — accumulated user-approved mutations (jsonb)
  confirmedAt: string;               // DB default now() on insert
  superseded: boolean;               // tombstone for D27 replace-future-only flow
  createdAt: string;
  updatedAt: string;
}
```

`DraftPlanSession` omits `confirmedAt`, `superseded`, `createdAt`, `updatedAt` — these are filled by the DB on insert — and makes `mutationHistory` optional so existing draft builders (`buildNewPlanSession` in plan-flow.ts) don't need to set it. The store's row mapper writes `[]` as the default. The draft's `id` is assigned client-side so batches can reference their parent before the confirm sequence writes.

#### MutationHistory persistence (Plan 026)

`mutationHistory` is the accumulated record of user-approved plan mutations on this session and its ancestors. The session-to-proposal adapter (`src/plan/session-to-proposal.ts`) carries it across save-before-destroy writes — every post-confirmation rewrite of a session takes the predecessor's history, appends the just-approved mutation, and writes the new history into the new row. Without this column, a confirmed plan is unreachable to the re-proposer because in-memory `PlanFlowState.mutationHistory` is cleared on confirm.

The first-confirmation write path in `buildNewPlanSession` does NOT yet thread `state.mutationHistory` into the draft — that's owned by Plan 029 Task 7 Step 6.

### MutationRecord

A single user-approved plan mutation, recorded so the re-proposer respects prior choices on subsequent calls.

```typescript
interface MutationRecord {
  constraint: string;                // natural-language description of what the user asked for
  appliedAt: string;                 // ISO timestamp
}
```

Persisted on `PlanSession.mutationHistory` (Plan 026) so it survives save-before-destroy writes. Lives in `src/models/types.ts` (re-exported from `src/agents/plan-reproposer.ts` for backwards compat with the existing call site).

### Batch

A first-class cook session output: one recipe, 2-3 servings, 2-3 consecutive eating days. Cook day = `eatingDays[0]` (derived, never stored separately).

```typescript
interface Batch {
  id: string;
  recipeSlug: string;
  mealType: 'lunch' | 'dinner';
  eatingDays: string[];              // 2-3 ISO dates, ascending. Need NOT be contiguous — fridge-life is the constraint. Cook day = [0].
  servings: number;                  // DB: CHECK (servings BETWEEN 1 AND 3)
  targetPerServing: Macros;          // uniform solver target
  actualPerServing: MacrosWithFatCarbs; // scaled result from recipe-scaler
  scaledIngredients: ScaledIngredient[];
  status: 'planned' | 'cancelled';   // no 'proposed' — drafts are in-memory only
  createdInPlanSessionId: string;    // immutable FK (D30)
}
```

Batches can span horizon boundaries — a batch cooked on day 7 of session A may have `eatingDays` extending into session B's horizon. The solver sees only in-horizon days; overflow days become pre-committed slots for the next session.

### FlexSlot

A meal where the calorie target is boosted above the uniform meal-prep baseline. No specific food is assigned — the user decides in real-time. Currently hard-constrained to exactly 1 per week (`config.planning.flexSlotsPerWeek`).

```typescript
interface FlexSlot {
  day: string;                       // ISO date
  mealTime: 'lunch' | 'dinner';
  flexBonus: number;                 // ~350 extra cal on top of per-slot base
  note?: string;                     // e.g., "burger or pizza"
}
```

### MealEvent

A meal-replacement event — a restaurant or social meal that replaces a lunch or dinner slot. Treat events (cookies at work, snacks, drinks) are NOT stored as MealEvent — they're funded by the treat budget and never touch the slot grid.

```typescript
interface MealEvent {
  name: string;
  day: string;                       // ISO date
  mealTime: 'lunch' | 'dinner';
  estimatedCalories: number;
  notes?: string;
}
```

## Solver types (`src/solver/types.ts`)

### PreCommittedSlot

Projection of a prior session's batch into the current horizon. Carries frozen macros — the solver subtracts these from the weekly budget before distributing to new batches.

```typescript
interface PreCommittedSlot {
  day: string;
  mealTime: 'lunch' | 'dinner';
  recipeSlug: string;
  calories: number;
  protein: number;
  sourceBatchId: string;
}
```

### PlanProposal

Generated by the plan-proposer sub-agent. Contains recipe assignments, flex slot suggestions, events, and (deprecated) recipe gaps. The solver runs on this to compute exact calorie targets. Plan 024: the proposal is the single source of truth for the plan arrangement.

```typescript
interface PlanProposal {
  batches: ProposedBatch[];          // in-horizon day assignments (need not be consecutive)
  flexSlots: FlexSlot[];
  events: MealEvent[];               // Plan 024: single source of truth for events
  /** @deprecated Always []. Kept for structural compatibility. */
  recipesToGenerate: RecipeGap[];
  solverOutput?: SolverOutput;       // attached after solver runs
}
```

`ProposedBatch.days` contains in-horizon days only (need not be consecutive — Plan 024). `ProposedBatch.overflowDays` holds days past the horizon end (for cross-horizon batches). The fridge-life constraint is: `calendarSpan(days[0], lastEatingDay) ≤ recipe.storage.fridgeDays`.

`RecipeSummary` (internal to `src/agents/plan-proposer.ts`) — the condensed recipe view passed as LLM context. Includes `fridgeDays` (from `recipe.storage.fridgeDays`) so the proposer can arrange non-consecutive eating days within the fridge-life limit.

### Proposal validator invariants

`validateProposal` (`src/qa/validators/proposal.ts`) gates every PlanProposal before the solver sees it. Invariants 1–13 cover slot coverage, no overlap, sort order, servings range, cook day in horizon, fridge-life, flex count, pre-committed integrity, recipe existence, event date/field validity, and duplicate events.

**Invariant #14 — meal-type lane (Plan 026):** every batch's `mealType` must be in its recipe's authored `mealTypes` array. A dinner-only recipe cannot land in a lunch batch, and vice versa. Skips batches whose recipe is missing (#10 catches those separately). The check is positioned right after #10 so the recipe lookup is safe. Plan 026 added this to block the re-proposer from silently crossing meal-type lanes under post-confirmation rearrangement pressure — lunch is portable/no-reheat/light, dinner can be heavy/sauce-heavy/cooked-to-reheat, and crossing the lane produces a plan the user cannot actually execute.

## Persistence

- **Supabase `plan_sessions`**: Confirmed plan sessions (rolling 7-day horizons)
- **Supabase `batches`**: First-class batches with stable UUIDs, FK to plan_sessions
- **Supabase `session_state`**: Conversation session state (single-user)
- **Markdown files**: Recipes (YAML frontmatter + body in `recipes/`)
- **In-memory**: Flow state during active conversations (PlanFlowState, RecipeFlowState)

### Deleted types (Plan 007)

`WeeklyPlan`, `CookDay`, `MealSlot`, `LegacyBatch` — removed in the rolling-horizon migration. Cook days and meal slots are now derived views, not persisted entities.
