# Plan 007: Rolling 7-day horizon + batches as first-class entities

**Status:** Active
**Date:** 2026-04-05 (last revised 2026-04-05, post-review)
**Affects:** `src/models/types.ts`, `src/solver/types.ts`, `src/solver/solver.ts`, `src/agents/plan-flow.ts`, `src/agents/plan-proposer.ts`, `src/state/store.ts`, `src/state/machine.ts`, `src/shopping/generator.ts`, `src/telegram/bot.ts`, `src/telegram/core.ts`, `src/telegram/formatters.ts`, `src/telegram/keyboards.ts`, `src/harness/test-store.ts`, all scenarios in `test/scenarios/`, `docs/product-specs/*`, Supabase schema

**Not in this plan:** the 3-line cook-day hotfix at `src/solver/solver.ts:307` (`cookDay = dayBefore(firstEatDay)` → `cookDay = firstEatDay`). That lands as a separate pre-Monday hotfix to prevent shipping v0.0.4 with a wrong cook schedule on day one. Plan 007 does NOT depend on the hotfix — they share a destination (`cookDay === eatingDays[0]`) but the hotfix solves the symptom with minimal code churn while Plan 007 solves the underlying architectural issue (weekly silo → rolling horizons, embedded batches → first-class batches). By the time Plan 007 implementation starts, the hotfix will already be in `master`.

---

## Problem

### The immediate trigger: a 1-serving Sunday dinner gap

From `logs/debug.log` during weekend v0.0.4 testing: the user planned the week starting Mon 2026-04-06 and accepted the initial proposal. Then they asked to move the flex slot from Friday dinner to Saturday dinner. The fix landed in Plan 005 (`docs/plans/completed/005-swap-gap-surfacing.md`) correctly surfaces the resulting recipe gaps instead of silently showing a broken plan. But the gap it surfaced was absurd: *"dinner on Sun needs a recipe... any recipe that fits this slot for dinner Sun (1 serving)."*

A 1-serving dinner recipe for a single Sunday is not how anyone meal preps. The symptom is a 1-day orphan at the week edge. The disease is deeper.

### The disease: the weekly silo

The current system treats a "week" (Mon-Sun calendar week) as the atomic planning unit. Batches, cook days, and eating days must all fit within a single `WeeklyPlan`. This is a direct inheritance from a calendar-first mental model, and it doesn't match how meal prep actually works.

Real meal prep has no concept of Mon-Sun. A cook session produces 2-3 days of food starting from the cook day. That food might span Sunday → Tuesday, or Thursday → Saturday, or any other 2-3 day window. The "week" is an artifact of the calendar, not the cooking cadence.

When the planning horizon is a hard Mon-Sun window, several things break:

1. **Edge orphans.** Any mutation (flex move, recipe swap, event insertion) that disturbs a batch near the week's end can leave a 1-day residual. The system has to either absurdly cook for 1 day, create a fake "generate a new 1-serving recipe" prompt, or silently drop the day. All three are wrong.

2. **Hidden cross-week cooks.** Even without mutations, the natural cook rhythm crosses week boundaries constantly. If the user cooks Sunday for Sun+Mon+Tue, the Sunday cook belongs to *two* plan weeks in reality, but the data model forces it into one. The "other" week either loses visibility of the cook or has to duplicate knowledge.

3. **Sunday meal-prep ritual misalignment.** The current proposer optimizes for "few cook days per week," and in the solver at `src/solver/solver.ts:307` the code hardcodes `cookDay = dayBefore(firstEatDay)`. Every cook day is the day *before* the first eating day — the classic "cook the night before" pattern.

   **But the user does not cook that way.** Quoted directly from the design discussion: *"I always cook on the day when the batch starts. If I cook on Sunday, this is what I will eat on Sunday. I never cook on Sunday to first eat it on Monday, because I want my food always to be fresh, as fresh as possible."*

   The 3-line fix at `solver.ts:307` is shipping as a separate pre-Monday hotfix (see note at the top of this plan). That alone resolves the cook-day display bug. What this plan fixes is the *architectural* consequence: the current model has `CookDay` as a persisted type with its own `day` field, so "cook day = first eat day" is an assumption that can drift from the data. Deriving cook day from batches at display time (`groupBy(batches, b => b.eatingDays[0])`) removes that drift class entirely.

4. **Onboarding friction.** For the future multi-user case, "sign up today, plan starts tomorrow" is the natural onboarding UX. A Mon-Sun weekly grid makes this awkward: if a user signs up on Wednesday, do they plan a 5-day partial week? A full week starting next Monday (so nothing to eat until then)? The weekly grid has no clean answer.

5. **Vacations and irregular schedules.** Real life has gaps — travel, illness, short trips. The weekly grid treats a 4-day vacation as a broken week; the rolling model treats it as a 4-day gap between horizons.

### The thesis, stated plainly

**The week is a fiction. The actual unit of planning is a rolling 7-day horizon starting from whatever day the user chooses, and the actual unit of cooking is a 2-3 day batch that can start on any day and may span horizon boundaries.**

This is not a minor refactor. It's a reframing of the planning model. But it aligns the system with how meal prep actually works, and every downstream feature on the v0.0.5+ roadmap (tracking, running budget, mid-week adjustment, slow-path re-proposer, onboarding) becomes simpler and more natural once this shift is made.

### Why now, not v0.0.5+

Two reasons (the Monday-deadline argument was removed when the cook-day hotfix was split out; see the note at the top of the plan and D22 in the decision log):

1. **The weekly silo actively shapes every v0.0.5 feature.** Tracking asks "which batch did I consume from" — the answer is cleaner when batches are first-class, cross-horizon entities. Running budget asks "what's scheduled vs consumed" — same. Mid-week replanning asks "mutate the remaining batches" — much cleaner when batches aren't owned by a week. The plan-mutation fast/slow refactor in the v0.0.5 backlog assumes the proposer can take "current state" as input — in the weekly model, "current state" is ambiguous at week edges; in the rolling model, it's unambiguous. Building v0.0.5 features on top of the weekly model means designing around an abstraction we've already decided is wrong, then porting. Double work.

2. **There is no production data to migrate.** The user hasn't used v0.0.3/v0.0.4 in production yet — Monday will be the first real use, and that first week runs on the hotfixed-but-still-weekly model. The Supabase `weekly_plans` table contains at most test data. Hard-cut the schema when Plan 007 lands, regenerate fresh. Migration cost: zero.

With the Monday deadline decoupled, Plan 007 has room to breathe: it can ship when it's ready — Sunday evening, Wednesday, the following weekend — without jeopardizing the user's first production week. The only real deadline is "before v0.0.5 features start landing on top of the weekly model."

### PRODUCT_SENSE check

From `docs/PRODUCT_SENSE.md`, the principles this refactor serves:

- **"Adherence is the main variable."** A system that silently dissolves a flex move into a broken 1-serving orphan erodes trust. Trust erosion → disengagement → loss of adherence.
- **"Low friction comes first."** Every downstream feature becomes lower-friction on the rolling model. Week-edge gaps, orphan meals, and cross-week cooks all disappear as problem categories.
- **"The system should work around the user's actual life. Real life is the main environment."** Mon-Sun weeks are not real life for anyone who meal preps. The rolling model *is* the real-life shape of cooking.
- **"The system should bend without breaking."** Today's flex_move on the week edge creates a bad state the solver silently papers over (calorie clamping). That's breaking. Rolling horizons bend.
- **"The system should feel guided... should adapt quickly... should work around the user's actual life."** The proposer should be dynamic by nature — able to balance a plan around whatever already exists. This is stated directly in the design discussion: *"adaptivity to real life is the main idea of the whole product."* The current weekly silo fights adaptivity; rolling horizons enable it.

Every filter in the "What matters most" section of PRODUCT_SENSE points the same direction. This refactor is not a premature optimization; it is the product direction resolving an architectural mistake surfaced by a specific user interaction.

### What this plan is NOT

- Not a rewrite of the Telegram UI. Copy changes only where the old copy references "week" in a way that misleads.
- Not a shopping list redesign. Current shopping generator keeps working against the new batch model. Per-cook-session shopping trips is a separate, deferred concern.
- Not a tracking implementation. No `cooked` / `consumed` batch states. No explicit tracking buttons. Those are v0.0.5+ features that will build on this foundation.
- Not a multi-user refactor. Still single user, still the default user ID. Preference system is YAGNI until real feedback arrives from real users.
- Not a solver rewrite. The solver's algorithm (reserve treat budget, distribute remainder uniformly, enforce min/max) stays the same. Only its inputs and outputs change shape.
- Not a recipe model change. Recipes stay as markdown files with YAML frontmatter. The scaler still runs on each batch at confirmation time.

---

## Principles

These principles guide every decision in this plan and should guide every decision made *during* implementation. If an implementation decision conflicts with one of these, stop and escalate — it probably means the principle needs refinement.

### P1 — Batches are first-class entities with their own lifecycle

A batch is a cook session's output: one recipe, 2-3 servings, 2-3 consecutive eating days, owned by exactly one plan session but visible to any plan session whose horizon overlaps its eating days. Batches live in a dedicated Supabase table with stable IDs. They are not embedded in plans.

### P2 — Cook day is always the first eating day

Static rule for v0.0.4. No preference plumbing, no configurability, no `cookStyle` column. `cookDay === batch.eating_days[0]` — derived at display time, never stored. When real users in the future ask for Sunday-batch-cooking behavior, we will add a preference then, not now. YAGNI.

### P3 — Meal-level carry-over, not batch-level carry-over

When planning horizon B, what "carries over" from horizon A is a set of pre-committed meal slots, not whole batches. A batch is **owned by the plan session that created it** (recorded as `createdInPlanSessionId`, immutable after creation). By construction, every persisted batch has `eatingDays[0]` inside its owning session's horizon — the cook day is always in the creating session. Other plan sessions whose horizons overlap the batch's later eating days see those meals as pre-committed slots and plan around them; they never become owners.

Display rules use cook-day as a *filter* on ownership, not as an ownership definition: "batches shown in this horizon's Cook section" means *"batches `WHERE createdInPlanSessionId = currentSession.id`"* (which, by the invariant above, automatically have their cook day in the current horizon). Ownership and display filtering are kept separate so mutations during the planning phase cannot silently reassign ownership. See D30 for the invariant that enforces this at confirm time.

### P4 — Plan sessions are markers, batches are the substance

A plan session is a lightweight record: horizon_start, horizon_end, breakfast config, treat budget, embedded flex slots, embedded events, confirmed_at timestamp. It does not own its batches — batches reference back to it via `created_in_plan_session_id`. "What's in plan session X" is a query, not an embedded array.

### P5 — Derived views over denormalized persistence

`CookDay` and `MealSlot` stop being persisted entities. Cook days are `groupBy(batches, b => b.eating_days[0])`. Meal slots are computed at display time from batches + flex slots + events + breakfast. One source of truth per concept, no sync hazards.

### P6 — The proposer adapts around existing reality

The proposer's input includes a list of pre-committed meal slots from prior plan sessions. The proposer plans only uncovered slots. When the new horizon has no pre-commitments (first-ever plan, or after a vacation gap), the proposer runs as it does today. When there are pre-commitments, the proposer treats them as fixed constraints and balances the new batches around them. This is *the* central product behavior: adaptivity to existing reality.

### P7 — Horizon is fixed 7 days, always

Not variable, not user-configurable, not context-dependent. 7 days from start, always. When vacations or partial weeks eventually matter, they become a separate concern (skip days within a horizon), not a variable-length horizon.

### P8 — Hard cut on Supabase schema

No migration. No dual-write. No compatibility shim. Drop `weekly_plans`, create `batches` and `plan_sessions` fresh. Existing v0.0.3 plan data in Supabase is discarded.

### P9 — KISS / YAGNI unless there's a concrete need

When a design question surfaces a "we might want this later" option, default to not building it until we have the concrete need. Examples: `cook_day` column (derived, not stored), `cookStyle` preference (not plumbed), `recipe_name` on batch (derived from slug), batch tracking states `cooked`/`consumed` (not modeled). When real feedback demands it, we add it then.

---

## Target data model

### Supabase schema

```sql
-- NEW: plan sessions replace weekly_plans. Only user-confirmed sessions live here
-- (drafts are in-memory only per D15/D33). The `superseded` flag is a tombstone
-- for D27's replace-future-only flow, not a lifecycle status (see D9 revision).
create table plan_sessions (
  id uuid primary key,
  user_id text not null,
  horizon_start date not null,
  horizon_end date not null,
  breakfast jsonb not null,              -- {recipeSlug, caloriesPerDay, proteinPerDay}
  treat_budget_calories int not null,
  flex_slots jsonb not null default '[]', -- FlexSlot[]
  events jsonb not null default '[]',     -- MealEvent[]
  confirmed_at timestamptz not null default now(),
  superseded boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index plan_sessions_user_horizon on plan_sessions (user_id, horizon_start desc)
  where not superseded;

-- NEW: first-class batches. FK to plan_sessions with ON DELETE RESTRICT —
-- sessions with live batches cannot be physically deleted; D27's replace flow
-- marks the session `superseded = true` and cancels its batches rather than
-- deleting rows, preserving audit history. See D31 for the client-side
-- write-ordering contract that provides save-before-destroy semantics.
create table batches (
  id uuid primary key,
  user_id text not null,
  recipe_slug text not null,
  meal_type text not null check (meal_type in ('lunch', 'dinner')),
  eating_days date[] not null,
  servings int not null check (servings between 2 and 3),
  target_per_serving jsonb not null,
  actual_per_serving jsonb not null,
  scaled_ingredients jsonb not null,
  status text not null check (status in ('planned', 'cancelled')),
  created_in_plan_session_id uuid not null references plan_sessions(id) on delete restrict,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index batches_eating_days_gin on batches using gin (eating_days);
create index batches_user_status on batches (user_id, status);
create index batches_session_id on batches (created_in_plan_session_id);

-- DROPPED in migration 002: weekly_plans (hard cut, no migration)
```

The `eating_days` column is a Postgres `date[]` with a GIN index so we can query "batches with eating_days overlapping a given horizon" via `eating_days && ARRAY[...]::date[]` efficiently. The partial index on `plan_sessions` (filtered to `NOT superseded`) keeps the common-path queries fast — superseded rows are just audit history that normal code paths never scan.

**No pl/pgsql RPC functions.** An earlier draft of this plan proposed wrapping the confirm and replace flows in Supabase RPC functions for full transactional safety. That was rejected as overkill for a single-user prototype — the real failure mode (mid-write error on a healthy Supabase connection from Madrid with ~6 rows per confirm) is nearly nonexistent, and the cost of maintaining pl/pgsql in the codebase (new language, stringified Postgres errors, migration/type drift, harder local debugging) is higher than the benefit. Instead, `StateStore` uses client-side write ordering via the standard Supabase JS client, documented in D31. The `ON DELETE RESTRICT` FK stays — it's cheap and genuinely useful as a safety net.

### TypeScript types

```typescript
// NEW shape of Batch (replaces current Batch in src/models/types.ts).
// Only persisted (confirmed) batches ever exist as instances of this type.
// In-memory drafts use ProposedBatch (see solver/types.ts) until confirmation.
export interface Batch {
  id: string;
  recipeSlug: string;
  mealType: 'lunch' | 'dinner';
  /** ISO dates this batch is eaten on (2-3 contiguous days). Cook day = eatingDays[0].
      By invariant D30, eatingDays[0] is always inside the creating session's horizon. */
  eatingDays: string[];
  servings: number;
  targetPerServing: Macros;
  actualPerServing: MacrosWithFatCarbs;
  scaledIngredients: ScaledIngredient[];
  /** 'planned' = confirmed and scheduled to cook.
      'cancelled' = tombstoned by D27's supersede flow. Never 'proposed' — drafts
      live in memory only (D33) and do not reach this type. */
  status: 'planned' | 'cancelled';
  createdInPlanSessionId: string;  // immutable, per D30
}

// NEW shape of PlanSession (replaces WeeklyPlan in src/models/types.ts).
// Represents a PERSISTED (confirmed) session. Per D33, there is no such thing as
// an unpersisted PlanSession — drafts live in memory as a different shape (see below).
export interface PlanSession {
  id: string;
  horizonStart: string;      // ISO date
  horizonEnd: string;        // ISO date (horizonStart + 6 days)
  breakfast: {
    locked: boolean;
    recipeSlug: string;
    caloriesPerDay: number;
    proteinPerDay: number;
  };
  treatBudgetCalories: number;
  flexSlots: FlexSlot[];
  events: MealEvent[];
  confirmedAt: string;       // required — populated by the DB's `default now()` on insert (D31/D33)
  superseded: boolean;       // tombstone flag from D27's replace-future-only flow (D31)
  createdAt: string;
  updatedAt: string;
}

/** Shape of an in-memory draft session during the planning flow (D33). Also the input
    shape accepted by `store.confirmPlanSession(...)` and returned by `buildPlanSession(...)`.
    Never persisted until the user taps Confirm and `StateStore.confirmPlanSession` (or
    `confirmPlanSessionReplacing` in the replan case) runs its sequential writes, at which
    point the DB fills in `confirmedAt` (via `default now()`), `superseded` (via
    `default false`), `createdAt`, and `updatedAt`, returning a full `PlanSession`. The
    `id` is assigned client-side at draft creation time so batches can reference their
    parent via `createdInPlanSessionId` before the confirm sequence writes the whole
    bundle. */
export type DraftPlanSession = Omit<
  PlanSession,
  'confirmedAt' | 'superseded' | 'createdAt' | 'updatedAt'
>;

// DROPPED types: WeeklyPlan, CookDay, MealSlot
// CookDay and MealSlot become in-memory derived views, not persisted types.
```

### Query patterns

```typescript
// "What batches are pre-committed in my new horizon?"
// Returns batches owned by a PRIOR (already-confirmed) plan session whose
// eating_days intersect the new horizon. Per D33, the current session's draft
// batches are in-memory only and never appear in the store, so no "exclude
// current session" filter is needed.
const carriedOverBatches = await store.getBatchesOverlapping({
  horizonStart: 'YYYY-MM-DD',
  horizonEnd: 'YYYY-MM-DD',
  statuses: ['planned'], // exclude cancelled batches from superseded sessions
});

// "What are the pre-committed meal slots for my new horizon?"
// Derived from carriedOverBatches by intersecting eating_days with horizon days.
function preCommittedSlots(batches: Batch[], horizonDays: string[]): PreCommittedSlot[] {
  const slots: PreCommittedSlot[] = [];
  for (const batch of batches) {
    for (const day of batch.eatingDays) {
      if (horizonDays.includes(day)) {
        slots.push({
          day,
          mealTime: batch.mealType,
          recipeSlug: batch.recipeSlug,
          calories: batch.actualPerServing.calories,
          protein: batch.actualPerServing.protein,
          sourceBatchId: batch.id,
        });
      }
    }
  }
  return slots;
}
```

### Two-shape representation: `Batch` vs `PreCommittedSlot`

Meals that are already planned appear in the system under two distinct types:

1. **`Batch` / `ProposedBatch`** — the current session's batches. Carry slug + day list + serving count; macros are populated only after the solver + scaler run.
2. **`PreCommittedSlot`** — a materialized projection of *prior sessions'* batches into the current horizon. Carries slug + day + mealTime + frozen macros (copied from the source batch's `actualPerServing`).

These shapes are intentionally different. `PreCommittedSlot` simplifies the solver's budget-subtraction math (it sees a flat list of slots with known macros, not a list of batches it would have to unpack) and makes it impossible for session B to accidentally mutate session A's batches. The cost is that `formatPlanProposal` has to merge two representations into a unified display grid — a known, localized trade-off.

Future maintainers reading this: do NOT unify the types. The separation is load-bearing for solver simplicity and cross-session ownership clarity. See D29.

### Solver cross-horizon handling (rule (a))

A batch's `eatingDays` can extend past the current horizon's end into days that will belong to the next plan session (e.g., a 3-serving batch cooked on day 7 of horizon A, eaten days 7 + 8 + 9, where 8 and 9 are horizon B's first two days). The solver's handling follows **rule (a)**:

- `SolverInput.mealPrepPreferences.recipes[i].days` contains ONLY in-horizon days — the subset of the batch's eating days that fall inside `[horizonStart, horizonEnd]`.
- The full `eatingDays` array lives on the persisted `Batch` object and on `ProposedBatch.overflowDays` (new field) during the proposal phase. It is NOT visible to the solver.
- The solver's per-slot math, weekly totals, and daily breakdown operate strictly on in-horizon days. A 3-serving batch with 1 in-horizon day contributes **1** slot to the solver's slot count; its other 2 servings are invisible to session A's solver and will become session B's pre-committed slots when session B runs.
- At persistence time, `buildPlanSession` writes the full `eatingDays` (= in-horizon `days` + `overflowDays`) to the `batches` table.
- `ProposedBatch.servings` equals `eatingDays.length` including overflow days, so the batch that gets persisted is the correct multi-day shape. But the solver slot count uses `days.length` (in-horizon only).

This keeps the solver stateless about horizons beyond its own. The `batches` table and the cross-session `getBatchesOverlapping` query carry all cross-horizon information.

**Alternatives considered:** (b) solver sees full days but iterates only horizon days internally; (c) cross-session budget deduction where session A reserves horizon B's slots upfront. Both introduce coupling the solver doesn't need. Rule (a) keeps responsibility at the boundary (`buildSolverInput` filters, solver trusts).

**Subtlety worth naming: frozen per-slot macros across horizon boundaries.** Session A solved at, say, 790 cal/serving for its in-horizon slots. A 3-serving batch cooked day A7 stores `actualPerServing.calories = 790`. When session B runs, it sees 2 pre-committed slots at 790 cal each. Session B's own new-batch per-slot target may be 820 cal (different constraint mix). So the user's session B week has some meals at 790 and others at 820. This is mathematically correct (frozen commitments from session A, new budget for session B) and the Telegram display should show the actual macros per slot so the user understands the difference is intentional.

### Explicit `horizonDays` on SolverInput (closes a latent bug)

The current solver derives its day set from `recipes[].days + flexSlots[].day` (`src/solver/solver.ts:176-186`). That derivation has always been brittle: a day covered only by an event (no batch, no flex) is silently missing from `dailyBreakdown`, and the validator's orphan check never fires for it. Today that bug is masked because real plans always have a batch or flex on every day. Under rolling horizons with pre-committed slots, the brittleness becomes load-bearing — a horizon can legitimately have days whose only source is a carried-over slot or a restaurant event.

To fix this class of bug once and permanently, **`SolverInput` gains a required `horizonDays: string[]` field of length exactly 7.** The solver iterates `horizonDays` directly for `buildDailyBreakdown` and for orphan checks, with no derivation from recipe/flex inputs. The old `getWeekDays` helper is deleted.

- `buildSolverInput` in `plan-flow.ts` populates `horizonDays` from `state.horizonDays` (the 7 ISO dates computed from `horizonStart`).
- The solver asserts `horizonDays.length === 7` at entry. A wrong-length input is a programmer error, not a runtime condition to accommodate.
- Every one of the 7 days produces a row in `dailyBreakdown`, even if that row has zero sources — which then surfaces cleanly to `validatePlan` as a genuine orphan, rather than being invisible to the validator entirely.

This is a strict tightening of the solver contract. See D32 for the decision record.

---

## Plan of work

Eight phases, structured as a **strangler-fig refactor**: new types coexist with old types throughout, call sites migrate module-by-module, every intermediate commit stays `npm run build` green and bisectable. Phase 8 (scenarios) runs alongside phases 1–7 and provides the test feedback loop. The entire plan ships as one atomic release.

### Phase 1 — Types and schema (strangler-fig: additive only)

**Files**: `src/models/types.ts`, `src/solver/types.ts`, `supabase/schema.sql`

This phase ADDS the new types alongside the old ones. Nothing is deleted yet — the old types (`WeeklyPlan`, `CookDay`, `MealSlot`, current `Batch`, etc.) stay in place, fully imported and compilable, because downstream code still uses them. Subsequent phases migrate call sites one module at a time; a final cleanup step (folded into Phase 7) deletes the old types once the last consumer is gone.

1. Add `PlanSession` type per the shapes above. Do NOT remove `WeeklyPlan`.
2. Resolve the `Batch` name collision by renaming the **old** type. In `src/models/types.ts`, rename the existing `Batch` interface to `LegacyBatch`. Update the 5 importers in one sweep (`src/agents/plan-flow.ts`, `src/solver/solver.ts`, `src/shopping/generator.ts`, `src/qa/validators/shopping-list.ts`, plus the type definition itself). Then add the new batch shape under the clean name `Batch` — this becomes the canonical name from day one, and every subsequent phase migrates call sites from `LegacyBatch` to `Batch`. Phase 7b deletes `LegacyBatch` once no importers remain. Rationale: renaming the old type once in Phase 1 is a smaller and less risky edit than renaming the new type across every file at Phase 7b after they've all been touched by the refactor.
3. Add `PreCommittedSlot` type in `src/solver/types.ts`:
   ```typescript
   export interface PreCommittedSlot {
     day: string;
     mealTime: 'lunch' | 'dinner';
     recipeSlug: string;
     calories: number;
     protein: number;
     sourceBatchId: string;
   }
   ```
4. Add `overflowDays: string[]` to `ProposedBatch` (in `src/solver/types.ts`). Defaults to `[]` so existing code that constructs `ProposedBatch` without this field keeps working until migrated in Phase 4/5. Used by the proposer to express cross-horizon extension intent (see "Solver cross-horizon handling" above). Not used by the solver itself.
5. Leave `CookDay` and `MealSlot` exports in place. They'll be deleted in the Phase 7 cleanup step once `plan-flow.ts` and `formatPlanProposal` stop constructing them.
6. Note: `customShoppingItems` on `WeeklyPlan` is confirmed dead (initialized to `[]` at `src/agents/plan-flow.ts:1143`, read at `src/shopping/generator.ts:98`, never written by any UX path). Do NOT port it to `PlanSession`. It gets deleted along with `WeeklyPlan` in the Phase 7 cleanup step.
7. Create a new Supabase migration file at `supabase/migrations/001_create_plan_sessions_and_batches.sql` (this is the first-ever migration file in the repo — the folder doesn't exist yet, create it). The file contains, in order:
   - `CREATE TABLE plan_sessions` with `confirmed_at timestamptz not null default now()` and `superseded boolean not null default false` (per Finding 4 / D33).
   - `CREATE TABLE batches` with `status text not null check (status in ('planned', 'cancelled'))` (no `'proposed'` — drafts are in-memory only) and `created_in_plan_session_id uuid not null references plan_sessions(id) on delete restrict` (the FK is a cheap safety net — see D31 for the full write-ordering story).
   - The GIN index on `eating_days`, the partial index on `plan_sessions(user_id, horizon_start desc) where not superseded`, and the supporting indexes from the "Target data model" SQL block.
   That's it — no pl/pgsql functions. Transactional safety for multi-row writes is provided by client-side ordering in the `StateStore` class (see Phase 2 and D31), not by RPCs. The earlier draft of this phase wrapped confirm and replace flows in `confirm_plan_session` / `supersede_plan_session` / `confirm_plan_session_replacing` RPC functions; that was rejected as overkill for a single-user prototype (see the "No pl/pgsql RPC functions" note in the Target data model section).
   The migration file does NOT drop `weekly_plans` — that happens in the second migration at Phase 7b. The user runs this file manually in the Supabase dashboard at the start of Phase 2 (before any code is written that depends on the new tables existing). `supabase/schema.sql` stays unchanged in this phase; it gets a full refresh at plan completion (Phase 7b cleanup) to reflect the final post-migration state.

**Exit criterion**: `npm run build` is **green**. New types are exported and importable. No call site has migrated yet. Running the test suite (`npm test`) still passes because nothing structural changed — the scenarios still exercise the old types. A follow-up phase can start work against either shape.

### Phase 2 — Persistence layer (additive on StateStoreLike)

**Files**: `src/state/store.ts`, `src/state/machine.ts`, `src/harness/test-store.ts`

Strangler-fig continues: ADD the new methods to `StateStoreLike` without removing the old ones. `StateStore` and `TestStateStore` both implement the extended interface. No call sites migrate in this phase — that's Phases 3–5.

1. Extend `StateStoreLike` interface in `store.ts` with the new operations (keeping the existing `savePlan`, `getCurrentPlan`, `getLastCompletedPlan`, `getRecentCompletedPlans`, `completeActivePlans` in place during the strangler-fig window). All new queries filter `NOT superseded` so D27's tombstoned sessions are invisible to the normal path:
   ```typescript
   // NEW — rolling-horizon surface

   /** Confirm a fresh draft. Implemented as two sequential Supabase calls:
       (1) insert the session row into `plan_sessions`, (2) bulk-insert all
       batches into `batches`. Supabase wraps bulk inserts server-side in a
       single transaction, so step (2) is atomic for N batches. Step (1) is a
       single row insert. The FK constraint guarantees step (2) can only
       succeed if step (1) already succeeded. The only failure mode is step (2)
       failing AFTER step (1) succeeded, which produces an orphan session row
       with zero batches — detectable and recoverable, and extremely unlikely
       at prototype volumes (see D31). Returns the persisted session with
       DB-populated `confirmedAt`, `superseded = false`, `createdAt`,
       `updatedAt`. Input uses `DraftPlanSession` (omits the four DB-filled
       fields). */
   confirmPlanSession(
     session: DraftPlanSession,
     batches: Array<Omit<Batch, 'createdAt' | 'updatedAt'>>,
   ): Promise<PlanSession>;

   /** Save-before-destroy replan for D27's replace-future-only flow (Finding 1
       third-review resolution). Implemented as four sequential Supabase calls
       in this exact order, chosen so that the OLD session stays live until the
       NEW one is fully saved:
         1. Insert new `plan_sessions` row.
         2. Bulk-insert new `batches` rows (atomic for N batches via
            Supabase's server-side transaction on the insert call).
         3. `UPDATE batches SET status = 'cancelled' WHERE
            created_in_plan_session_id = replacingSessionId AND status =
            'planned'`. Cancels the old session's batches so they stop
            appearing as pre-committed slots in subsequent queries.
         4. `UPDATE plan_sessions SET superseded = true WHERE id =
            replacingSessionId`. Tombstones the old session so it stops
            appearing in `getFuturePlanSessions` / `getRunningPlanSession` /
            `getLatestHistoricalPlanSession`.
       If any step throws, subsequent steps do not run. Failure-mode analysis:
         - Steps 1 or 2 fail: nothing in the old session changed. User sees
           an error and retries or abandons. Old session intact. ✓
         - Step 3 fails (new session + batches exist, old batches still
           `planned`): D27 intent mostly achieved. User sees the new plan.
           On next "Plan Week" tap, the old session is still returned by
           `getFuturePlanSessions` (since `superseded = false`), the replan
           prompt fires again, and the user can retry — step 3 is idempotent
           (cancelling already-cancelled batches is a no-op) so the retry
           cleanly completes.
         - Step 4 fails (new session + batches exist, old batches cancelled,
           old session still `superseded = false`): `getFuturePlanSessions`
           still returns the old session; next Plan Week tap re-triggers the
           replan prompt; user re-confirms and step 4 is retried. Idempotent.
       Both partial-failure modes are self-healing on user retry. A cleanup
       script can also be run manually to finish any hung state — see the
       tech-debt note in D31. Returns the newly-persisted session.

       Rationale for this ordering: we always write the NEW state in full
       before touching the OLD state. If any step fails, the old state is
       still queryable in some form, the user has not lost their prior plan,
       and the next iteration can resume the process. Save-before-destroy is
       guaranteed by step order, not by transaction boundaries. */
   confirmPlanSessionReplacing(
     session: DraftPlanSession,
     batches: Array<Omit<Batch, 'createdAt' | 'updatedAt'>>,
     replacingSessionId: string,
   ): Promise<PlanSession>;

   // Note: no `supersedeFuturePlanSession` on the public interface. The only
   // production code path that supersedes a session is
   // `confirmPlanSessionReplacing`, which enforces save-before-destroy via
   // step ordering. A standalone supersede from production would reopen the
   // destructive-before-save issue Finding 1 caught.

   getPlanSession(id: string): Promise<PlanSession | null>;

   /** The one session whose horizon contains today (by the D15 sequential
       invariant there is at most one). Returns null during gaps or for
       brand-new users. Filters WHERE horizon_start <= today <= horizon_end
       AND NOT superseded. */
   getRunningPlanSession(): Promise<PlanSession | null>;

   /** All sessions whose horizon starts strictly in the future (horizon_start
       > today), earliest first. Filters NOT superseded. Used by Phase 5a's
       entry logic to detect the replan-future-only case (D27). Returns an
       empty array when the user hasn't planned ahead. */
   getFuturePlanSessions(): Promise<PlanSession[]>;

   /** The most recent session whose horizon has fully ended (horizon_end <
       today), ordered by horizon_end DESC. Used for breakfast fallback when
       there is no running or future session. Filters NOT superseded. */
   getLatestHistoricalPlanSession(): Promise<PlanSession | null>;

   /** Up to `limit` most recent sessions ordered by horizon_end DESC,
       filtered only by NOT superseded — NO temporal filter. Includes running,
       future, and historical sessions indiscriminately. Used by the variety
       engine in buildRecentPlanSummaries: "what recipes are recently in the
       user's rotation, regardless of whether they're past, present, or soon."
       Future-committed sessions count because the user will eat them soon;
       currently-running sessions count because the user is eating them right
       now (skipping them would let the proposer suggest a repeat of tonight's
       dinner for next Monday, which is a variety failure). The only sessions
       excluded are superseded ones, which don't reflect real user intent. */
   getRecentPlanSessions(limit?: number): Promise<PlanSession[]>;

   getBatchesOverlapping(opts: {
     horizonStart: string;
     horizonEnd: string;
     /** In practice this is always `['planned']` for carry-over queries —
         cancelled batches are filtered out so they don't become pre-committed
         slots for the new horizon. Kept parameterized for test introspection. */
     statuses: Array<'planned' | 'cancelled'>;
   }): Promise<Batch[]>;
   // Note: no `excludePlanSessionId` parameter. Drafts are in-memory only (D33),
   // so there are no "current session's own batches" to filter out — the query
   // can only return batches belonging to OTHER (already-confirmed) sessions.

   getBatchesByPlanSessionId(id: string): Promise<Batch[]>;
   ```

   Notes:
   - `saveBatch` / `saveBatches` / `updateBatchStatus` / `deletePlanSession` / `supersedeFuturePlanSession` are NOT exposed on the public `StateStoreLike` interface. The only mutations production code can perform on `plan_sessions` and `batches` go through the two bundled methods on the public surface: `confirmPlanSession` (for fresh confirms) and `confirmPlanSessionReplacing` (for save-before-destroy replan flows). Each method is internally a short sequence of Supabase JS client calls in a fixed order — the atomicity guarantee is at the method level (all-or-fail-and-retry), not at the database-transaction level (see D31). This prevents production code from producing partially-applied multi-row changes, and prevents destroying a future session without simultaneously replacing it. The harness `TestStateStore` may expose lower-level mutation helpers for test seeding, but production code never touches them.
   - No `getCurrentPlanSession()` method. "Current" is ambiguous in the rolling model (running vs future vs historical) and the three explicit methods above replace it. See D34.
2. Implement the new methods in `StateStore`:
   - `confirmPlanSession` is two sequential Supabase calls: `.from('plan_sessions').insert(session)` then `.from('batches').insert(batches)`. Bulk insert in step 2 is server-side-atomic for N batches. On any error, the method throws; the caller's draft stays in memory and can retry. Log each step with `log.debug('STORE', ...)` so partial failures are visible in `logs/debug.log`.
   - `confirmPlanSessionReplacing` is four sequential Supabase calls in the exact order specified in the JSDoc above: (1) insert new session, (2) bulk-insert new batches, (3) update old batches to `cancelled`, (4) update old session to `superseded = true`. Each step logs on success and on failure. A throw at any step aborts the sequence; the caller surfaces the error to the user. Save-before-destroy is enforced by the ordering — steps 3 and 4 (which touch the old session) never run unless steps 1 and 2 (which save the new) succeeded.
   - `getRunningPlanSession` / `getFuturePlanSessions` / `getLatestHistoricalPlanSession` each run a single SELECT with a clearly-stated WHERE + ORDER BY matching the JSDoc on the interface. All three filter `superseded = false`.
   - `getBatchesOverlapping` uses Postgres `eating_days && ARRAY[...]::date[]` via Supabase's `.overlaps('eating_days', horizonDays)` — or raw SQL via `.rpc` if the JS client's helper doesn't compose with the other filters cleanly.
3. Implement the new methods in `TestStateStore` (in-memory mirror):
   - Deep-clone both stored and returned data to match production's copy-on-insert semantics.
   - `confirmPlanSession` is a synchronous two-step sequence on the in-memory arrays (insert session, insert batches). A throw at either step leaves the in-memory store in whatever state the partial sequence produced — harness scenarios that want to test error recovery can use this directly; scenarios that want happy-path behavior should not inject failures.
   - `confirmPlanSessionReplacing` is a synchronous four-step sequence matching production's exact ordering (insert new session, insert new batches, cancel old batches, supersede old session). Critically, the in-memory mirror honors the save-before-destroy contract: step 1 or 2 failing leaves the old session untouched, step 3 or 4 failing leaves the new session fully saved. Scenarios 011 (happy path) and the new 012 (abandon path — see Phase 8) exercise these cases.
   - Every method mirrors production semantics with a cross-reference comment pointing at the `StateStore` method name it shadows (same discipline as the existing methods in `src/harness/test-store.ts`).
   - Test seeding for `superseded = true` or `status = 'cancelled'` batches is exposed via a separate `TestStateStore.seed(...)` method, NOT via the public `StateStoreLike` surface. Production code has no way to write those states except via `confirmPlanSessionReplacing`.
4. Extend `TestStateStoreSnapshot` to include `planSessions: PlanSession[]` and `batches: Batch[]` fields alongside the existing `plans`. Scenarios assert on the full snapshot, so both the old and new shapes appear in recordings during the migration window. Phase 7b cleanup drops the legacy `plans` / `currentPlan` fields.
5. Extend `SessionState` in `machine.ts` with new fields `horizonStart?: string` and `horizonDays?: string[]`. Do NOT remove the existing `weekStart` / `activePlanId`. Phase 5a switches `plan-flow.ts` to populate the new fields; the old ones get deleted in the Phase 7 cleanup.
6. `completeActivePlans()` stays in place for now — it's called only from `plan-flow.ts:559` in `handleApprove`, which gets rewritten in Phase 5c. Once that rewrite lands, `completeActivePlans()` has no callers and gets deleted in Phase 7 cleanup.

**Exit criterion**: `npm run build` is green. `StateStoreLike` has both the old (weekly) and new (rolling, atomic-only) surfaces. `TestStateStore` implements both. `npm test` still passes — all existing scenarios exercise the old surface. New targeted unit tests in `test/unit/test-store.test.ts` verify: (a) `getBatchesOverlapping` respects GIN-equivalent overlap semantics, (b) `getRunningPlanSession` / `getFuturePlanSessions` / `getLatestHistoricalPlanSession` each return the right rows for seeded multi-session state, (c) `confirmPlanSession` is visibly atomic (all-or-nothing) on in-memory state, and (d) `confirmPlanSessionReplacing` is visibly atomic AND implements save-before-destroy — a throw simulated mid-sequence leaves the old session untouched AND the new session absent.

### Phase 3 — Solver (add rolling-aware path, keep old path alive)

**Files**: `src/solver/solver.ts`, `src/solver/types.ts`, `src/qa/validators/plan.ts`

Strangler-fig: extend `SolverInput` and `SolverOutput` with the rolling-aware fields; `solve()` handles both shapes. The old code path continues to work for `plan-flow.ts` until Phase 5b migrates it.

1. Extend `SolverInput` with two new fields:
   - `horizonDays: string[]` — **required** going forward (7 ISO dates in chronological order). See D32 and the "Explicit `horizonDays`" section in the data model. This closes a latent bug in the existing solver (days covered only by events were silently missing from `dailyBreakdown`) and makes the 7-day horizon a first-class contract. During the strangler-fig window the field is typed as required but `buildSolverInput` on the old code path populates it by computing the 7 dates from the existing `weekStart`, so old scenarios keep working.
   - `carriedOverSlots?: PreCommittedSlot[]` — optional (defaults to `[]` if undefined). Only populated by the new code path in Phase 5b.
   Extend `SolverOutput.dailyBreakdown` rows so a single row per day reflects all sources (pre-committed + new batch + event + flex). No separate `preCommittedBreakdown` field — one row per day is the one source of truth per day.
2. Update `solve()` to subtract pre-committed slot calories and protein from the weekly budget before distributing to new batches:
   ```typescript
   const carried = input.carriedOverSlots ?? [];
   const preCommittedCal = carried.reduce((s, x) => s + x.calories, 0);
   const preCommittedProtein = carried.reduce((s, x) => s + x.protein, 0);
   // mealPrepBudget = weeklyTarget − breakfast×7 − events − flexBonuses − treatBudget − preCommittedCal
   ```
3. **Slot math with cross-horizon caveat**: total in-horizon slots is still 14 (7 days × 2 lunch/dinner). The solver divides this as `14 = events + flexSlots + carriedOverSlots.length + newBatchInHorizonServings`. The *newBatchInHorizonServings* count comes from summing `req.days.length` across `mealPrepPreferences.recipes` (where `req.days` is already filtered to in-horizon days per rule (a) — the solver trusts this contract, does not filter). A new batch whose full serving count is 3 but whose in-horizon day count is 1 contributes **1** to the solver's slot math, not 3. The remaining 2 servings are invisible to the solver and will become pre-committed slots in session B.
4. Drop the separate `CookingScheduleDay[]` output field (introduce it as deprecated first — see step 7). Cook days are derived at display time via `groupBy(batches, b => b.eatingDays[0])`. The `buildCookingSchedule` helper and `dayBefore` helper in `solver.ts` are deleted at Phase 7 cleanup.
5. **Replace `getWeekDays` with explicit horizon iteration.** Today's `getWeekDays` at `solver.ts:176` derives a day set from `recipes[].days + flexSlots[].day`, silently missing any day covered only by events. Rewrite (or replace) it as `resolveHorizonDays(input: SolverInput): string[] { assert(input.horizonDays.length === 7); return input.horizonDays; }`. `buildDailyBreakdown` iterates exactly these 7 days — no derivation. Days with zero sources still get rendered as rows (with `totalCalories: 0`) so the validator's orphan check can catch them.
6. Update `buildDailyBreakdown` so each day row reflects *all* sources: pre-committed slots, new batch servings, events, flex slots. A pre-committed slot's calories come from its stored value (frozen from session A's scaling), NOT the session B solver's per-slot target. This means per-day totals aren't uniform across horizon days when pre-committed slots exist — that's intentional and correct (see the "frozen per-slot macros" subtlety in the Solver cross-horizon handling section above).
7. Update `validatePlan` (the QA validator in `src/qa/validators/plan.ts`) so the "no orphaned meal slots" check accepts four source types: batch in this session OR event OR flex slot OR pre-committed slot. Day × mealTime is covered if any of the four is present. With the explicit `horizonDays` contract from step 5, this check now fires reliably for every one of the 7 days.
8. **Backward compatibility during the strangler-fig window**: keep `cookingSchedule: CookingScheduleDay[]` on `SolverOutput` but populate it from the derived cook-day groupBy for the duration. Old callers (`plan-flow.ts:1038` iterates `solver.cookingSchedule`) continue to work unchanged until Phase 5e migrates them. Phase 7 cleanup removes the field. Similarly, keep `getWeekDays` available as a thin wrapper around `resolveHorizonDays` during the migration window if any old caller imports it directly (verify with grep — probably zero external callers).

**Exit criterion**: `npm run build` is green. `npm test` still passes — old scenarios still produce their recorded output because (a) the old `buildSolverInput` path now passes an explicit `horizonDays` array computed from `weekStart`, which for the old happy-path scenarios exactly matches what `getWeekDays` used to derive; (b) `carriedOverSlots` defaults to `[]` on the old path, so the carry-over subtraction math is a no-op. Add a new targeted unit test in `test/unit/solver.test.ts` (new file) that constructs a `SolverInput` with 3 pre-committed slots + explicit `horizonDays` and verifies the budget subtraction, slot count, daily breakdown math, and that a day with only a pre-committed slot (no new batch) still produces a row in `dailyBreakdown`.

### Phase 4 — Plan proposer (prompt + variety engine + smoke test via scenario)

**Files**: `src/agents/plan-proposer.ts`, `test/scenarios/005-rolling-continuous/*`

1. Extend `PlanProposerInput` with new optional fields: `horizonStart?: string`, `horizonDays?: string[]`, `preCommittedSlots?: PreCommittedSlot[]`. Old `weekStart` / `weekDays` stay in place as deprecated aliases — if the new fields are populated, use them; otherwise fall back to the old ones. This lets Phase 5b migrate call sites one at a time.
2. Update the system prompt (add new sections; do not delete the existing ones until all scenarios have been re-generated against the new prompt and reviewed):
   - Replace all "week" / "weekly" language with "horizon" / "7-day horizon." E.g., "Given a recipe database, recent meal history, and this horizon's constraints, propose a complete 7-day meal plan."
   - Add a new section `## PRE-COMMITTED SLOTS` — explains that some slots in the horizon are already covered by carried-over meals from prior plan sessions. The proposer MUST NOT plan a new batch on any (day, mealTime) already covered by a pre-committed slot. Double-booking is a hard error.
   - Restate cook day rule: "The cook day for each batch is always the first day of its eating days (`eating_days[0]`). Do NOT propose separate cook days."
   - Explicitly allow batches whose eating days extend past the horizon end. Add a `## CROSS-HORIZON BATCHES` section: "A 2- or 3-serving batch started on day 6 or 7 of the horizon can have eating days that extend into days 8 or 9 (belonging to the next plan session). This is preferred over creating a 1-day orphan at the horizon edge. Use `eating_days` to list all days (including overflow), and set `overflow_days` to the subset of days that fall past the horizon end."
3. **Variety rule extension for pre-committed slots** (addresses S8 from the review): add a rule to the `## VARIETY RULES (CRITICAL)` section — "Recipes used in PRE-COMMITTED SLOTS count as already-used for THIS horizon. Do not propose a new batch using a recipe that already appears in a pre-committed slot for this horizon — the user would see the same meal on two non-adjacent days." This extends the existing "no repeats from recent plan history" rule to the current horizon's own carry-over.
4. Update the user message template: add the `## PRE-COMMITTED SLOTS` section when any exist, listing them as `- {day} {mealTime}: {recipeName} ({calories} cal, {protein}g P)`. Adjust the SLOT MATH section to subtract pre-committed slots from the meal-prep-slots-to-fill count:
   ```
   - Total non-breakfast slots: 14 (7 lunches + 7 dinners)
   - Event slots taken: {eventCount}
   - Pre-committed slots (from prior plan): {preCommittedCount}
   - Flex slots to propose (required): {flexCount}
   - Meal prep slots to cover with NEW batches: 14 - events - preCommitted - flex = {N}
   ```
5. Update `buildRecentPlanSummaries` to work against `PlanSession[]`. Since `PlanSession` doesn't embed batches, this function now needs access to `store.getBatchesByPlanSessionId(session.id)` to pull the slug list per session. Accepts a `store: Pick<StateStoreLike, 'getBatchesByPlanSessionId'>` parameter (or is called from the flow layer with pre-loaded batches — decide at implementation time based on which is cleaner). Note for the implementer: this adds an N-queries pattern (one per recent session, default limit 2 → 2 queries). Acceptable at current scale; if it ever matters, add a tech-debt item.
6. Update the proposer's output parsing (`mapToProposal` at `plan-proposer.ts:446`) to match the new `ProposedBatch` shape: the LLM emits `eating_days` (full day list) and `overflow_days` (subset past the horizon end); map into `ProposedBatch.days` (in-horizon intersection) and `ProposedBatch.overflowDays`. This is the filtering step that enforces rule (a) — the solver never sees overflow days.

#### Phase 4 exit: smoke test via scenario 005 (addresses S6 from the review)

Before moving to Phase 5, the implementer MUST author and generate scenario `005-rolling-continuous` and self-review its recording against the real LLM. This is the "live smoke test" — not a manual ad-hoc API call the user runs, but a repeatable scenario the implementer records, reviews, and commits.

**What the scenario does**: seeds the `TestStateStore` with one confirmed `PlanSession` + its batches (where the last batch of session A has `overflowDays` extending 1–2 days into what will be session B's horizon). Then drives through the plan-week flow for session B. The harness captures the proposer's prompt (via the existing `[AI:REQ]` fixture) and the proposer's response.

**What the implementer reviews in the generated `recorded.json`** (by reading the file, not by asking the user):
- The proposer's system message contains the `## PRE-COMMITTED SLOTS` section.
- The proposer's user message lists the expected pre-committed slots with correct day/mealTime/recipe/macros.
- The proposer's response (captured in the LLM fixture) does NOT propose any batch overlapping a pre-committed (day, mealTime).
- The proposer's response does NOT reuse a recipe slug that appears in a pre-committed slot.
- The proposer's `reasoning` field (if present) mentions or at least implies awareness of the carry-over. Soft signal only — do not fail on this alone.
- The proposed batches' in-horizon calorie total + pre-committed slot calorie total + breakfast×7 + events + flex bonus + treat budget lands within ±3% of the weekly target. Arithmetic check.

**Decision gate**: if the review surfaces issues (model ignores slots, reuses recipes, drifts on budget), iterate on the prompt BEFORE recording any other scenarios. Recording scenarios 006–010 against a broken prompt is wasted work and produces permanent regression tests that lock in bad behavior. Only proceed to Phase 5 when scenario 005's recording passes eyeball review.

**Why this works as a smoke test**: the harness has been designed exactly for this. `npm run test:generate -- 005-rolling-continuous` runs the real LLM, captures the fixture, and produces a deterministic artifact. Committing the passing recording is both the smoke test result AND the permanent regression test for carry-over behavior — no duplicate work.

**Exit criterion**: `npm run build` green. Scenario 005 is authored, its recording is generated against the real LLM, the implementer has read the recording end-to-end and confirms it passes the review checklist above. `npm test` includes scenario 005 and it passes.

### Phase 5 — Plan flow (split into 5a–5e)

**Files**: `src/agents/plan-flow.ts`, `src/telegram/core.ts` (menu entry)

`plan-flow.ts` is 1419 lines and touches too many concerns to land as one phase. Split into five sub-phases, each with its own exit criterion and scenario coverage. Each sub-phase leaves `npm run build` and `npm test` green — scenarios touched by that sub-phase get regenerated at the sub-phase boundary, not all at once at the end.

#### Phase 5a — State rename, entry logic, plan-ahead guard

**Files**: `src/agents/plan-flow.ts` (state type + factory), `src/telegram/core.ts` (`plan_week` menu handler)

1. Add new fields `horizonStart: string` and `horizonDays: string[]` on `PlanFlowState`. Keep the old `weekStart` / `weekDays` as deprecated aliases populated with the same values during the migration window.
2. Add `createPlanFlowStateFromHorizon(horizonStart, breakfast)` as a sibling of the existing `createPlanFlowState`. The telegram menu handler (Phase 5a-5 below) calls the new factory.
3. Add `computeNextHorizonStart(store): Promise<{ start: string; replacingSession?: PlanSession; runningSession?: PlanSession }>` — implements the D27 rule using the three explicit store queries from Phase 2:
   1. `const future = await store.getFuturePlanSessions()` — all confirmed, not-superseded sessions with `horizon_start > today`, ordered ASC.
   2. **If `future.length > 0`**: return `{ start: future[0].horizonStart, replacingSession: future[0] }`. The caller will prompt "You already have a plan for {dateRange}. Replan it?" — but will NOT supersede the old session yet (see step 4 / Finding 1 resolution). The full session object is returned (not just the id) so the caller can read `replacingSession.breakfast` for the Finding 3 inheritance rule in step 6.
   3. **Else `const running = await store.getRunningPlanSession()`**. If it exists, return `{ start: iso(running.horizonEnd + 1 day), runningSession: running }`. Continuous rolling — the breakfast fallback uses `running.breakfast`.
   4. **Else `const last = await store.getLatestHistoricalPlanSession()`**. Return `{ start: iso(today + 1 day) }`. Breakfast fallback (if needed by the caller) comes from `last.breakfast` if non-null, otherwise the first breakfast recipe in the DB.
4. **Save-before-destroy: the replace-future flow does NOT supersede the old session when the user confirms "Replan it?".** Instead, the flow starts a fresh planning draft with `state.replacingSessionId = replacingSession.id` stored in `PlanFlowState`. The old session stays live in the DB throughout the new flow — if the user abandons the draft (taps /cancel, the bot restarts, the session times out), the old session is untouched. The supersede happens at Phase 5c's confirm step, inside the `confirmPlanSessionReplacing` method's four-step sequence (which writes the new state in full before touching the old — see D31). This is the Finding 1 resolution from the third review.
5. Update `src/telegram/core.ts:575` (`plan_week` menu handler) to use `computeNextHorizonStart`. If the result includes a `replacingSession`, the handler shows a confirmation prompt ("You already have a plan for {dateRange}. Replan it?") with Confirm / Cancel inline buttons. On Confirm, start the planning flow with the returned `start` AND seed `state.replacingSessionId = replacingSession.id` + `state.replacingSessionBreakfast = replacingSession.breakfast`. **The store is not touched at this stage** — the old session stays live until Phase 5c's `confirmPlanSessionReplacing` runs at Approve time. On Cancel, return to idle with a "Plan kept. Tap again to plan the week after." message.
6. Update the breakfast-fallback logic that previously lived at `src/telegram/core.ts:592`. There are **two distinct cases** the flow must handle, and they use different sources:
   - **Normal case** (no replace, `computeNextHorizonStart` did not return a `replaceSessionId`): use the running → historical fallback:
     ```typescript
     const running = await store.getRunningPlanSession();
     const last = running ?? (await store.getLatestHistoricalPlanSession());
     const breakfast = last?.breakfast ?? /* DB default */;
     ```
     The running session's breakfast is the right answer if one exists; otherwise fall back to the most recent historical session; otherwise DB default.
   - **Replan-future-only case** (`computeNextHorizonStart` returned `replaceSessionId`): inherit from the session being replaced, NOT from running/historical. When the user originally planned that future session they made a deliberate breakfast choice, and the Replan flow is a revision of *that specific session* — defaulting to some other session's breakfast would silently reset their prior choice. Pseudocode:
     ```typescript
     const future = await store.getFuturePlanSessions();
     const replacing = future.find(s => s.id === replaceSessionId);
     const breakfast = replacing?.breakfast ?? /* running → historical → DB default as above */;
     ```
     The user can still change breakfast during the draft via the normal "Change" button in the planning flow — this rule only governs the *default* the draft starts with.
   - Implementation: `computeNextHorizonStart` returns the full `PlanSession` object of the future session when there's a replace case (not just its id), so the caller has direct access to `replacing.breakfast` without a second query. Update the return type accordingly: `{ start: string; replacingSession?: PlanSession; runningSession?: PlanSession }`.
   - Rationale: Finding 3 (second review) caught a silent breakfast-reset regression in the replan path — the original fallback logic excluded future sessions entirely, which is correct for the normal case but wrong when the future session IS the one being revised.
7. Update `SessionState.weekStart` in `machine.ts` — the Phase 2 additions already introduced `horizonStart`. This sub-phase wires the flow to populate it.

**Exit criterion**: build green. Scenario 004 (`004-rolling-first-plan`) is authored and regenerates successfully against the new entry flow (no pre-committed slots, `horizonStart = tomorrow`). Scenario 011 (`011-rolling-replan-future-only`, new — see Phase 8) is authored and regenerates, covering the "tap Plan Week when a future-only session exists" case.

#### Phase 5b — Carry-over loading and proposer input

**Files**: `src/agents/plan-flow.ts` (proposal generation phase)

1. In `handleGenerateProposal` (`plan-flow.ts:353`), before calling `proposePlan`, load pre-committed slots:
   ```typescript
   const carriedBatches = await store.getBatchesOverlapping({
     horizonStart: state.horizonStart,
     horizonEnd: state.horizonDays[6]!,
     statuses: ['planned'],
   });

   // In save-before-destroy replan flows (Finding 1 / D27), the session we're
   // about to replace is still in the DB — its batches would otherwise show up
   // as "pre-committed slots" to the draft we're building, which is wrong
   // (we're replacing them, not inheriting them). Filter them out in memory.
   // The replacing session's batches become irrelevant the moment the user
   // confirmed "Replan it?"; they'll be flipped to `cancelled` by the atomic
   // `confirmPlanSessionReplacing` RPC at confirm time.
   const effectiveCarriedBatches = state.replacingSessionId
     ? carriedBatches.filter(b => b.createdInPlanSessionId !== state.replacingSessionId)
     : carriedBatches;

   const preCommittedSlots: PreCommittedSlot[] = materializeSlotsFromBatches(
     effectiveCarriedBatches,
     state.horizonDays,
   );
   ```
   No `excludePlanSessionId` parameter is added to the store API. The filter stays in memory (cheap: few batches per session) and only applies when the draft is in replace mode. Per D33, the draft's *own* batches are not persisted and cannot show up in this query at all — so the filter's only job is stripping the session being replaced.
2. Pass `preCommittedSlots` into `proposerInput` (the new field added in Phase 4).
3. Also extend `buildSolverInput` (`plan-flow.ts:993`) to thread `preCommittedSlots` into `SolverInput.carriedOverSlots`. This is the hand-off point where the filter-for-in-horizon-days rule (a) is enforced: each `ProposedBatch.days` is intersected with `state.horizonDays` before being passed to the solver; the overflow days (`batch.overflowDays`) stay on the proposed batch object but are NOT in the solver input.
4. Extend `materializeSlotsFromBatches` (new helper) to walk each carried-over batch's `eatingDays`, filter to `horizonDays`, and emit one `PreCommittedSlot` per matching day with calories/protein copied from `batch.actualPerServing`.
5. Session B's variety engine — since `buildRecentPlanSummaries` is already updated in Phase 4 to query batches per session, make sure this sub-phase calls it against the new `PlanSession` shape. Pass the resulting `RecentPlanSummary[]` to the proposer as today.

**Exit criterion**: build green. Scenario 005 (authored and reviewed at the end of Phase 4) still passes when re-run through the new carry-over loading path. Scenario 007 (`007-rolling-cross-horizon-batch`) is authored and regenerates, verifying a cross-horizon batch produced in session A is visible as pre-committed slots in session B.

#### Phase 5c — buildPlanSession, persistence, confirm

**Files**: `src/agents/plan-flow.ts` (build + confirm helpers)

1. Add `buildPlanSession(state, recipeDb, llm): Promise<{ session: DraftPlanSession; batches: Array<Omit<Batch, 'createdAt' | 'updatedAt'>> }>` as a sibling of the existing `buildWeeklyPlan`. Constructs an in-memory session shell using the `DraftPlanSession` type (horizon range, breakfast, treat budget, flex slots, events — plus the client-assigned `id` so batches can link to it via `createdInPlanSessionId`). The RPC fills in `confirmedAt` (via `default now()`), `superseded` (via `default false`), `createdAt`, and `updatedAt` at insert time — the caller never supplies those. Also constructs a list of `Batch` objects (one per proposal batch, with `eatingDays = inHorizonDays ∪ overflowDays`, `actualPerServing` + `scaledIngredients` populated by the recipe scaler, `status = 'planned'` from construction, `createdInPlanSessionId = session.id`). No in-memory `'proposed'` status — drafts never leave TypeScript-land as batch objects; they live as `ProposedBatch` in the plan-flow state and become `Batch` only at confirm time.
2. **Assert D30's invariant on every batch** before handing off to the store: `assert(batch.eatingDays[0] >= state.horizonStart && batch.eatingDays[0] <= state.horizonDays[6])`. A violation is a programmer error in a swap handler and throws immediately — no partial confirm, no corrupted store.
3. Add `handleApproveRolling` (temporary name for the sub-phase, folded into `handleApprove` in Phase 7 cleanup). Calls `buildPlanSession`, runs the invariant assertions from step 2, then persists via one of two paths depending on whether the draft is in replace mode:
   ```typescript
   if (state.replacingSessionId) {
     await store.confirmPlanSessionReplacing(session, batches, state.replacingSessionId);
   } else {
     await store.confirmPlanSession(session, batches);
   }
   ```
   Both store methods are implemented as sequential Supabase JS client calls (see Phase 2 / D31) — no pl/pgsql RPCs. `confirmPlanSession` is two steps (insert session, bulk-insert batches); `confirmPlanSessionReplacing` is four steps in the save-before-destroy order (insert new session, insert new batches, cancel old batches, supersede old session). If any call throws, the flow surfaces the error to the user and the draft stays in memory for retry. The ordering guarantees that in the replace flow, the old session is never touched until the new one is fully saved.
4. **Partial-failure story** (addresses the remaining concern from Finding 2 of the second review, now simplified per the user's "RPCs are overkill" direction): each store method logs every step to `logs/debug.log` so any partial-failure state is diagnosable. Both store methods are idempotent on retry for the mutation steps (inserts will fail on duplicate UUID — caller detects this and skips — and the cancel/supersede updates are no-ops when re-applied). A tech-debt item in `docs/plans/tech-debt.md` tracks "add an orphan-session cleanup script if partial writes ever show up in the logs during production use." At v0.0.4 single-user prototype volumes, the expected hit rate for this failure mode is effectively zero.
5. Stop calling `completeActivePlans()` — no longer needed. "Current" is derived from the three explicit store queries (running / future / historical). The call stays in the old `handleApprove` (legacy path) until Phase 7 cleanup deletes it entirely.

**Exit criterion**: build green. Existing scenarios (001, 002, 003) still pass against the old path (not yet migrated). A new focused harness test asserts that after `handleApproveRolling`, the test store snapshot contains exactly one `PlanSession` (with `confirmedAt` set and `superseded = false`) and N `Batch` rows (all `status = 'planned'`, all linked to the session, all satisfying D30's cook-day-in-horizon invariant). A second harness test simulates a D30 violation (a swap handler that produces a batch with an out-of-horizon cook day) and asserts the invariant check throws *before* any RPC call — no store writes happen.

#### Phase 5d — Swap handlers with cross-horizon extension (S5 option 1)

**Files**: `src/agents/plan-flow.ts` (`flex_add`, `flex_remove`, `flex_move`, `recipe_swap`, `restoreMealSlot`, `absorbFreedDay`, `removeBatchDay`)

This sub-phase resolves S5 from the review with **option 1: extend swap handlers to produce cross-horizon batches at horizon edges.** The alternatives (prompt-only handling, gap-surfacing-only) were rejected because they create a UX inconsistency — same user intent yields different results depending on whether the mutation happens during the proposer phase or the post-proposal swap phase.

1. Update `restoreMealSlot` (`plan-flow.ts:886`). Current logic tries to extend a same-meal-type batch whose day range is adjacent to the freed day. Add a third extension path:
   - If the freed day is exactly `horizonEnd + 1` (one day past the horizon's last day) and there's a same-meal-type batch whose `days[days.length - 1] === horizonEnd`, and that batch has fewer than 3 servings, extend it by appending the next day to its `eatingDays` and incrementing `overflowDays` on the proposed batch. The batch now spans horizonEnd → horizonEnd+1, with the +1 day living in `overflowDays` (not in-horizon `days`).
   - Symmetric case: if the batch's first day is `horizonStart` and a freed day sits at `horizonStart - 1`... actually no. Backward extension into a prior horizon is rejected by D27's "no modifying past sessions" stance. A horizon can only extend *forward* into the next horizon, not backward into the previous one. The symmetric case does not apply.
2. Update `absorbFreedDay` (`plan-flow.ts:861`). The existing logic calls `restoreMealSlot` and falls back to a recipe gap if extension isn't possible. With `restoreMealSlot` upgraded per (1), the gap-fallback path fires less often — only for genuinely orphaned days with no adjacent batch in any direction, or when every adjacent batch is already at the 3-serving cap.
3. Update `removeBatchDay` (`plan-flow.ts:930`). Today, removing a middle day from a batch splits into contiguous runs and marks 1-day runs as orphans. With cross-horizon batches possible, a run at the horizon edge may be 1-day in-horizon but extendable into the next horizon. Handle this: if a contiguous run is 1-day AND that day is at the horizon edge AND a different batch exists that could absorb it by extending across the horizon, mark it as an orphan for `absorbFreedDay` to process (same flow as today, but now the extension step succeeds more often).
4. Update `flex_add`, `flex_remove`, `flex_move` to work correctly when a batch has `overflowDays`, while preserving D30's invariant that **every persisted batch has its cook day (`eatingDays[0]`) inside its creating session's horizon**. The handler rules:
   - Treat `batch.eatingDays` (in-horizon days union `overflowDays`) as the logical "what days this batch covers" when computing orphans and extensions, but ownership is always determined by `createdInPlanSessionId` — never by cook day.
   - Carry `overflowDays` through mutations that preserve the invariant. E.g., a batch with `days = [6, 7]` and `overflow = [8]` can become `days = [6]` with `overflow = [8]` after day 7 is carved — cook day stays at day 6, still in session A's horizon, invariant preserved.
   - **Reject** mutations that would violate the invariant. The specific illegal case: `days = [7]` + `overflow = [8, 9]` would become `days = []` + `overflow = [8, 9]` after day 7 is carved. Cook day would shift to day 8, which is in session B's horizon. This would require session A to persist a batch whose cook day is outside its own horizon — contradicting D30. Instead, `removeBatchDay` detects this case and signals the caller that the entire batch must be dropped.
   - **Orphan day handling after a batch drop — two classes.** When the caller (`absorbFreedDay`) drops a batch, the batch's eating days split into two classes:
     - **In-horizon orphans** (days inside `[horizonStart, horizonEnd]`, e.g. day 7 in the example above): absorbed via `restoreMealSlot`; if absorption fails, fall back to gap-surfacing via the existing `RecipeGap` flow (same path as today).
     - **Overflow orphans** (days past `horizonEnd`, e.g. days 8–9 in the example above): **absorb-only**. `restoreMealSlot` may extend an adjacent same-meal-type batch forward into those days (the standard cross-horizon extension from step 1). **If no absorption is possible, the entire mutation is rejected and the draft rolls back to its pre-mutation state.** The user sees a message like "Can't move flex there — it would strand next week's meals with no home. Try a different day or remove a pre-committed slot first." Overflow orphans cannot be gap-surfaced because session A's display grid doesn't render out-of-horizon days (see Phase 5e step 1c), so a "generate a recipe for day 8" prompt would be referencing a day the user can't see.
     - Rationale: a mutation that would strand meals into the next horizon with no batch to carry them is itself invalid, regardless of the invariant-preservation rule on cook days. Rejecting it at mutation time is cleaner than silently losing meals or showing gap prompts for invisible days. This is a rare path (requires a 3-serving cross-horizon batch whose only in-horizon day gets carved AND no adjacent forward-extension slot exists) but the plan must specify what happens when it fires.
   - Concrete implementation: `removeBatchDay` returns `{ orphanDays: string[], overflowOrphanDays: string[], droppedBatchIds: string[] }` (three classes, not two). `absorbFreedDay` processes each class with its respective rule: in-horizon orphans → absorb-or-gap; overflow orphans → absorb-or-reject-mutation. The mutation rollback path is surfaced via a new `MutationRejected` return variant on the swap handlers (`flex_add`, `flex_remove`, `flex_move`, `recipe_swap`), carrying an error message for the UI.
5. `recipe_swap` — no changes needed beyond the rename. Doesn't touch day lists.
6. **Invariant assertion at confirm time** (`buildPlanSession` in Phase 5c): for every batch about to be persisted, assert `batch.eatingDays[0] >= horizonStart AND batch.eatingDays[0] <= horizonEnd`. A failure here is a programmer error — one of the swap handlers produced a batch that violates D30. Throwing at confirm time surfaces the bug loudly in the scenario harness rather than letting it corrupt the store.

**The user-visible outcome**: the original bug scenario (Plan A's Fri-Sat dinner batch gets carved by a flex move that pushes the flex to Sat dinner) now produces a clean result: the old Friday dinner batch absorbs the carved Sunday dinner by extending into Monday+Tuesday of the next horizon if needed, or is converted to a cross-horizon batch starting Sat. No 1-serving orphan prompt.

**Exit criterion**: scenario 008 (`008-rolling-flex-move-at-edge`) is authored and regenerates cleanly with the expected cross-horizon extension behavior captured in the recording. Scenario 009 (`009-rolling-swap-recipe-with-carryover`) is authored and passes. Existing scenario 002 (original flex-move bug, re-recorded against the new model) shows the bug is gone — the carved Sunday dinner no longer surfaces as a gap prompt; it's absorbed or extends into next horizon.

#### Phase 5e — Display derivation (cook days, meal rows, pre-committed markers)

**Files**: `src/agents/plan-flow.ts` (`formatPlanProposal`), `src/telegram/formatters.ts`

1. `formatPlanProposal` (`plan-flow.ts:1305`) — rewrite the meal-row derivation and cook-schedule derivation to operate on `{ batches, preCommittedSlots, flexSlots, events, breakfast }` without reading persisted `CookDay` / `MealSlot`. The derivation is:
   - For each of the 7 horizon days, for each of `[lunch, dinner]`: find the source (in order) — event → flex slot → pre-committed slot → in-horizon batch serving → orphan marker. Render one row per (day, mealTime).
   - Cook days: `groupBy(session's own batches, b => b.eatingDays[0])`. Only batches owned by the current session appear in the Cook section (carried-over batches were cooked in a prior session).
   - Cross-horizon batches in the current session: show the batch on its cook day with an annotation like `Moroccan Beef (cook Sun, eats Sun–Tue, 2 into next week)`. The overflow days do NOT appear as separate rows inside this horizon's grid (they'll appear in session B's display when session B runs).
2. Pre-committed slot rendering: each pre-committed slot appears in its day row with a marker distinguishing it from the current session's batches. Proposed format: `Lunch Mon: Moroccan Beef (from prior plan, 790 cal)`. The calorie number is shown explicitly for pre-committed slots so the user sees the frozen macro (see "frozen per-slot macros" subtlety in the data-model section). This is the one place where the UX intentionally exposes the cross-session math.
3. If `formatPlanProposal` grows too large during this rewrite, extract helpers (`deriveDayRows`, `deriveCookSchedule`, `renderPreCommittedSlot`). Don't extract prematurely.
4. The `formatters.ts` weekly summary formatter needs a rename but otherwise no logic changes. Keep the function name (`formatWeeklySummary`) since "weekly" still describes the 7-day sum.

**Exit criterion**: build green. All rolling-specific scenarios (004, 005, 007, 008, 009, 010, 011) regenerate cleanly and their recorded display output is eyeball-verified — pre-committed slot markers present, cook section shows only current session's cooks, cross-horizon batches are annotated correctly. This is the point at which the rolling model is fully live in the UI.

### Phase 6 — Display and UX (structural only — copy rewrite is a separate session)

**Files**: `src/telegram/formatters.ts`, `src/telegram/keyboards.ts`, `src/telegram/core.ts`

Most of the display work landed in Phase 5e (derivation logic inside `formatPlanProposal`). This phase covers the remaining structural display changes only. Full copy polish — tone, phrasing, "week" → "your next 7 days" language pass, menu text rewrites — is explicitly out of scope for Plan 007 and will happen in a dedicated copy session afterward. The goal here is: make the plan structurally renderable against the new model, don't try to make every string beautiful.

1. `formatPlanProposal` header: ensure the header can render a horizon that starts on any day, not just Monday. Minimum viable change — e.g., "Apr 6 – Apr 12" or "Mon Apr 6 – Sun Apr 12" depending on whether `horizonStart` is a Monday. Do NOT rewrite all week-related copy; the separate copy session will own that.
2. Pre-committed slot marker: settled in Phase 5e (format: `Lunch Mon: Moroccan Beef (from prior plan, 790 cal)`). No additional work here beyond ensuring the marker text is consistent across display code paths.
3. Keyboard labels: unchanged. `Plan Week` stays as the reply-button label. The internal model changes; the user-facing label is the copy session's call.
4. `src/telegram/formatters.ts` — the `formatWeeklySummary` helper keeps its name and signature but now accepts the new `PlanSession` + `Batch[]` shape instead of `WeeklyPlan`. Logic unchanged.
5. Menu text: leave as-is. The copy session will rewrite help text, command descriptions, and menu labels as a batch.

**Exit criterion**: all scenarios render correctly through the new derivation and formatter paths. No copy polish done. Any remaining "week" phrasings that confuse users are filed as copy-session TODOs, not fixed here.

### Phase 7 — Shopping list migration + strangler-fig cleanup

**Files**: `src/shopping/generator.ts`, `src/models/types.ts`, `src/solver/types.ts`, `src/state/store.ts`, `src/state/machine.ts`, `src/harness/test-store.ts`, `src/agents/plan-flow.ts`, `supabase/schema.sql`

Two independent sub-steps: migrate the shopping generator to the new shape (7a), then sweep through and delete everything the old code path still holds (7b). 7b is the strangler-fig cleanup — every phase before this has been adding new code alongside old. This phase removes the old.

#### Phase 7a — Shopping generator

1. Update `generator.ts` to accept `{ session: PlanSession; batches: Batch[] }` instead of `WeeklyPlan`. (Per D24, `Batch` is the new shape's canonical name from day one — the old type was renamed to `LegacyBatch` back in Phase 1. There was never a `PlannedBatch` intermediate.) Walk `batches`, aggregate `scaledIngredients`. Logic unchanged.
2. Remove the dead read of `plan.customShoppingItems` at line 98. The field is not ported to `PlanSession` (see D12).
3. Leave `ShoppingList` / `ShoppingCategory` / `ShoppingItem` unchanged. The shopping redesign is a separate v0.0.5+ concern.

#### Phase 7b — Strangler-fig cleanup (delete old types and old code path)

After Phase 7a, every call site that used to consume `WeeklyPlan` / `CookDay` / `MealSlot` / `LegacyBatch` has been migrated to the new shapes. Now delete:

1. Delete `WeeklyPlan`, `CookDay`, `MealSlot`, and `LegacyBatch` type exports from `src/models/types.ts`. Also delete `customShoppingItems`, `FunFoodItem` (already legacy per `data-models.md`), and any other types that only existed to support the old shape. No renames are needed in this step — `Batch` has been the canonical new-shape name since Phase 1 (per D24).
2. Verify via grep that no importer still references `LegacyBatch` before deleting it: `grep -rn "LegacyBatch" src test` must return zero matches. If any remain, finish migrating their call sites first.
3. Delete the deprecated alias fields on `PlanProposerInput` (`weekStart`, `weekDays`) and `PlanFlowState` (`weekStart`, `weekDays`). Everything uses `horizonStart` / `horizonDays` directly.
4. Delete the deprecated methods on `StateStoreLike`: `savePlan`, `getPlan`, `getCurrentPlan`, `getLastCompletedPlan`, `getRecentCompletedPlans`, `completeActivePlans`. The class-level implementations in `StateStore` and `TestStateStore` get deleted in the same commit. `getPlan` was unused in prod anyway (see existing comments in `store.ts` about currently-unused surface).
5. Delete `completeActivePlans()` callers — `plan-flow.ts:559` is the only one, replaced by `handleApproveRolling` in Phase 5c; the old `handleApprove` gets inlined/merged into the new one at this step.
6. Delete `buildCookingSchedule` and `dayBefore` helpers in `src/solver/solver.ts`. Delete the `cookingSchedule: CookingScheduleDay[]` field on `SolverOutput` and its `CookingScheduleDay` type export. Every display path has migrated to deriving cook days from batches.
7. Delete `TestStateStoreSnapshot.plans` / `currentPlan`. Scenarios have been regenerated to use `planSessions` / `batches` on the snapshot. If any scenario's recording still references old-shape fields, regenerate it.
8. Drop the `weekly_plans` table from Supabase via a second migration file: `supabase/migrations/002_drop_weekly_plans.sql`. Contents: `DROP TABLE weekly_plans;` plus a comment noting Plan 007 as the origin. The user runs this file manually in the Supabase dashboard as part of the Phase 7b commit. Also refresh `supabase/schema.sql` in the same commit to reflect the final post-migration state (the canonical snapshot now shows `plan_sessions` and `batches`, no `weekly_plans`).
9. `src/harness/types.ts`: `ScenarioInitialState.plans` becomes `planSessions` / `batches`. Re-export the new types.

**Exit criterion**: `grep -rn "WeeklyPlan\|customShoppingItems\|CookDay\|MealSlot\|cookingSchedule\|completeActivePlans\|LegacyBatch" src test` returns ZERO matches. `npm run build` green. `npm test` green. The codebase contains only the new model end-to-end.

### Phase 8 — Test scenarios and verification

**Files**: `test/scenarios/`, `src/harness/*`, `test/unit/*`

Scenarios are authored and regenerated throughout Phases 4–5 as each sub-phase lands (scenario 005 in Phase 4's smoke test, 004/011 in 5a, 007 in 5b, 008/009 in 5d, remaining scenarios in 5e). This phase collects the final scenario set, re-records existing scenarios that drift against the new model, and runs the comprehensive verification pass.

1. **Re-record all existing scenarios** against the new data model:
   - `001-plan-week-happy-path` — regenerate with `npm run test:generate --regenerate`. Behavior stays "fresh user plans a week," but the recorded shapes (PlanSession instead of WeeklyPlan, first-class batches, derived cook days) change.
   - `002-plan-week-flex-move-regression` — regenerate. Behavior changes: the original bug surfaced as a 1-serving Sun dinner gap prompt. With Phase 5d's cross-horizon extension, the flex move absorbs cleanly into an adjacent batch (possibly crossing the horizon). The updated recording locks in the new correct behavior as the regression test.
   - `003-plan-week-minimal-recipes` — regenerate. Same flow as before but against the new shapes.
2. **Author new scenarios** covering rolling-specific behavior (all are MUST-HAVE; none deferred):
   - `004-rolling-first-plan` — first-ever plan from empty state; `horizonStart = tomorrow`; user completes the flow. (Phase 5a.)
   - `005-rolling-continuous` — two sessions back-to-back; session B inherits pre-committed slots from session A; proposer correctly plans around them; budget math hits target with the carry-over subtraction. **Doubles as the Phase 4 smoke test** — first scenario generated, first scenario eyeball-reviewed.
   - `006-rolling-gap-vacation` — a plan ends Friday; next plan is created the following Tuesday; horizon_start falls back to "tomorrow" (Wednesday); no carry-overs; behaves like a first plan.
   - `007-rolling-cross-horizon-batch` — proposer creates a batch with eating days extending past the horizon (e.g., day 7 cook for days 7, 8, 9); next session treats days 8 and 9 as pre-committed. (Phase 5b.)
   - `008-rolling-flex-move-at-edge` — the exact original bug scenario (flex move Fri→Sat) in the new model. With Phase 5d's cross-horizon extension enabled, the carved Sunday dinner is absorbed into the Saturday dinner batch (extending into next horizon if needed) rather than surfacing as a 1-serving gap. The scenario locks in the no-gap behavior as the permanent regression test against S5 option 1.
   - `009-rolling-swap-recipe-with-carryover` — plan B has pre-committed slots; user performs a `recipe_swap` on a non-pre-committed batch; the swap succeeds and doesn't touch carry-overs. Verifies that swap handlers don't accidentally mutate slots they don't own.
   - `010-rolling-events-in-rolling-horizon` — a restaurant event on day 3 + pre-committed slots on days 1-2 + flex slot on day 6; proposer respects all three constraint types simultaneously.
   - `011-rolling-replan-future-only` — user has a confirmed plan A currently running + a confirmed plan B entirely in the future (future-only). User taps Plan Week. System offers to replan plan B ("You already have a plan for {B dates}. Replan it?"). User confirms. The replan draft starts with `state.replacingSessionId = B.id` — **plan B is still live in the store at this point**. The user proceeds through the draft (breakfast confirm, events, proposal, approve). On approval, `confirmPlanSessionReplacing(newSession, newBatches, B.id)` runs the four-step save-before-destroy sequence: insert new session, insert new batches, cancel B's batches, mark B superseded. Final state snapshot: new session confirmed and live; B still in the store with `superseded = true`; B's batches with `status = 'cancelled'`. Verifies D27 + D31 end-to-end, including the save-before-destroy ordering and breakfast inheritance from B (Finding 3).
   - `012-rolling-replan-abandon` — same seeded state as 011 (plan A running, plan B future). User taps Plan Week, confirms "Replan it?", starts the draft, but then taps Cancel during the draft (instead of Approve). Final state snapshot: **plan B is still live and unchanged** (still `superseded = false`, batches still `planned`). No new session was persisted. Verifies the save-before-destroy guarantee from Finding 1: abandonment during the draft does not destroy the session being replaced.
3. **Unit tests** (targeted, not exhaustive):
   - `test/unit/solver.test.ts` (new): carry-over budget subtraction math, slot-count arithmetic with pre-committed slots, cross-horizon batch in-horizon serving count, and — per D32 — at least one case where a day is covered only by a pre-committed slot or only by an event, verifying that day still produces a row in `dailyBreakdown`.
   - `test/unit/test-store.test.ts` (extend existing): `getBatchesOverlapping` with `eating_days` array intersection; the three explicit query methods (`getRunningPlanSession` / `getFuturePlanSessions` / `getLatestHistoricalPlanSession`) each returning the right rows for seeded multi-session state (including a seeded `superseded = true` session that every query must filter out); `confirmPlanSession` two-step sequence end-state (session + all batches present after success); `confirmPlanSessionReplacing` four-step save-before-destroy sequence (new session + batches fully saved before old is touched; a simulated throw at step 1 or 2 leaves the old session untouched and no new data present; a simulated throw at step 3 or 4 leaves the new session saved and the old partially cleaned up — retry is safe); and D30 invariant enforcement (the harness can construct an illegal batch and verify the store layer does not write it — though the primary enforcement lives in `buildPlanSession`, not the store).
   - Shopping generator unit tests if the existing coverage is thin (judgment call at implementation time).
4. **Build + test green**: `npm run build` passes; `npm test` passes.
5. **Per-scenario human review of `recorded.json`** (addresses the review's S6 concern about deepStrictEqual locking in low-quality LLM output). For every newly-authored scenario AND every re-recorded scenario, the implementer opens the JSON and reads the captured proposer output end-to-end. Checks:
   - Proposed plan composition passes eyeball test for variety (protein rotation, cuisine mix, no unexpected repeats).
   - Pre-committed slot handling (where applicable): proposer does not double-book any (day, mealTime) already covered by a slot, and does not reuse recipe slugs that appear in slots.
   - Cross-horizon batches (where applicable): overflow days are populated correctly, the batch is visible on its cook day (= first eating day), the Cook section displays the annotation format.
   - Cook day = first eating day everywhere (should be automatic from the derivation, but eyeball the Cook section for any Sun-cook-Mon-eat leftovers).
   - Budget math: `solverOutput.weeklyTotals.calories` within ±3% of `config.targets.weekly.calories`, `protein` meets 97%.
   - Copy sanity: no obvious placeholder leakage, no undefined strings, no broken day-name formatting for non-Monday horizons.
   
   This review step is the quality gate that `deepStrictEqual` cannot enforce. `git diff` catches structural drift; eyeballing catches quality drift that would otherwise become locked-in regressions.
6. **Manual Telegram verification** (the one unavoidable human-in-the-loop check): `DEBUG=1 npm run dev`, run the first-plan flow end-to-end, confirm the plan, verify the plan displays correctly on a real device. Immediately plan the *next* session to exercise continuous rolling and pre-committed slots in the real UI. Bonus: test the replan-future-only flow by confirming a plan for next week and then tapping Plan Week again. Keyboard shapes, spacing, line breaks, and any Telegram-specific rendering quirks only reveal themselves on a real client.
7. **Debug log check**: `tail -500 logs/debug.log` after the manual run. Verify the `[AI:REQ] ... context=plan-proposal` entry for the second plan includes the `## PRE-COMMITTED SLOTS` section in its user message. Verify no "calorie clamped" or "invariant violation" warnings appear in normal paths.

**Exit criterion**: all 12 scenarios green (`npm test`). Every recording eyeball-reviewed per step 5. Manual Telegram verification passes on a real device. Debug log shows expected prompt shapes for carry-over cases. The plan is ready for the strangler-fig cleanup in Phase 7b if not already done.

---

## Progress

- [ ] Phase 1: Types + schema (additive strangler-fig baseline, migration file 001 with table DDL + FK with ON DELETE RESTRICT + `superseded` flag + indexes; no pl/pgsql RPC functions per D31)
- [ ] Phase 2: Persistence layer additions (atomic-at-method-level mutation surface — `confirmPlanSession` (2 sequential writes) + `confirmPlanSessionReplacing` (4 sequential save-before-destroy writes); three explicit queries `getRunningPlanSession` / `getFuturePlanSessions` / `getLatestHistoricalPlanSession`; TestStateStore parity; targeted test-store unit tests for write ordering and save-before-destroy guarantee)
- [ ] Phase 3: Solver rolling-aware path (explicit `horizonDays` input replacing `getWeekDays` derivation, carry-over budget math, cross-horizon rule (a), solver unit test including zero-source-day row rendering)
- [ ] Phase 4: Plan proposer prompt + variety engine + scenario 005 smoke test (authored, generated, eyeball-reviewed)
- [ ] Phase 5a: PlanFlow entry — `computeNextHorizonStart` using three explicit queries, save-before-destroy replan-future-only flow (no store mutation at "Replan it?" confirm), scenarios 004 + 011 + 012
- [ ] Phase 5b: Carry-over loading, solver input filter for rule (a), horizonDays plumbed through `buildSolverInput`, scenario 007
- [ ] Phase 5c: `buildPlanSession` + D30 invariant assertion at confirm time + atomic persistence via `confirmPlanSession` RPC, `handleApproveRolling`
- [ ] Phase 5d: Swap handlers with cross-horizon extension (S5 option 1) + D30 invariant enforcement in `removeBatchDay` (reject empty-in-horizon mutations), scenarios 008 + 009
- [ ] Phase 5e: Display derivation (cook days, meal rows, pre-committed markers), scenario 010 + 001/002/003 re-records
- [ ] Phase 6: Structural display updates (copy polish explicitly deferred to a separate session)
- [ ] Phase 7a: Shopping generator migration to new shapes
- [ ] Phase 7b: Strangler-fig cleanup (delete old types, drop `weekly_plans` table via migration 002, delete old `StateStoreLike` methods, delete `LegacyBatch`)
- [ ] Phase 8: Final scenario sweep — all 12 scenarios recorded and human-reviewed, unit tests landed, manual Telegram verification (including Flow 6 save-before-destroy replan + abandon), debug log audit
- [ ] `npm run build` clean
- [ ] `npm test` green (all 12 scenarios + targeted unit tests: solver carry-over math + zero-source-day rows, test-store `confirmPlanSession` + `confirmPlanSessionReplacing` ordering, save-before-destroy guarantee on abandonment, test-store three-query semantics)
- [ ] Manual Telegram verification: first plan + continuous rolling + gap fallback + replan-future-only (supersede path)
- [ ] Docs: update `docs/product-specs/data-models.md`, `docs/product-specs/flows.md`, `docs/product-specs/solver.md`, `docs/ARCHITECTURE.md` per the new model
- [ ] Backlog: update `docs/BACKLOG.md` to reflect Phase 8 test additions and any v0.0.5 implications
- [ ] Design doc: post-implementation, extract rationale + outcomes (including D30–D34 post-review resolutions) into `docs/design-docs/` per the user's feedback rule. Candidate title: "Rolling horizons and first-class batches: the death of the weekly silo."

---

## Decision log

Each entry captures a decision made during the 2026-04-05 design discussion. The design doc that comes out of this plan at completion will synthesize these into durable rationale.

### D1 — Rolling 7-day horizon replaces Mon-Sun weekly grid
- **Decision**: Plan sessions are 7-day rolling horizons starting from a user-chosen or continuous-rolling start day, not calendar-week (Mon-Sun) grids.
- **Rationale**: The calendar week is an artifact of the Gregorian calendar, not how meal prep works. Real cooks operate in 2-3 day batches from arbitrary start days. Forcing batches into Mon-Sun buckets creates edge cases (1-day orphans at week ends), misaligns with onboarding UX ("sign up today, plan starts tomorrow"), and breaks the adaptivity principle from PRODUCT_SENSE.
- **Date**: 2026-04-05

### D2 — Cook day equals first eating day, statically
- **Decision**: For v0.0.4, `cookDay === batch.eatingDays[0]` is a hardcoded rule. No preference column, no configurability.
- **Rationale**: The user cooks today and eats today. "Cook Sunday for Mon-Wed eating" is the current system's assumption and is wrong for this user. Other cooking styles (Sunday meal prep for the full week, freeze-ahead) exist and might matter for future users, but they're YAGNI until real users ask for them. Plumbing the preference now means speculative complexity; adding it when a real user complains is cheap.
- **Date**: 2026-04-05
- **Supersedes**: an earlier decision in the same discussion to plumb `cookStyle` as a preference. Reversed in favor of KISS / YAGNI.

### D3 — Batches are first-class Supabase entities
- **Decision**: Dedicated `batches` table with stable UUIDs. Batches reference the plan session that created them via `created_in_plan_session_id`, but are not embedded in plan sessions.
- **Rationale**: Batches outlive plan sessions (a batch cooked on day 7 of session A is eaten on days 7-9, where 8-9 are in session B). Embedding batches in plan sessions would require duplication or complex cross-session references. First-class entities with their own lifecycle match the real-world concept: a batch is a cook session's output, owned by whoever cooked it, visible to anyone whose horizon sees its eating days.
- **Date**: 2026-04-05

### D4 — Meal-level carry-over, not batch-level carry-over
- **Decision**: When planning a new horizon, the proposer sees "pre-committed meal slots" (day + mealTime + recipeName + calories + protein), not "carried-over batches." The batch is owned by its originating plan session; what crosses the horizon boundary is some subset of its meals.
- **Rationale**: A batch is 2-3 meals. What's "carried over" is usually 1-2 meals from the tail of a batch, not the whole batch. Framing the carry-over in meal units avoids ambiguity about batch ownership and makes the proposer's input simpler (slot-level constraints instead of batch-level concepts).
- **Date**: 2026-04-05

### D5 — Carry-over is read-only in the new horizon's planning UI
- **Decision**: The user cannot edit pre-committed meal slots via a new plan session's swap flow. They're displayed with a "(from last plan)" marker but are treated as fixed constraints by the proposer and by all swap handlers.
- **Rationale**: KISS. Editing carried-over meals would require mutating batches owned by a prior plan session, which opens questions about how far back such mutations are allowed, whether already-cooked food can be "un-cooked," and how tracking reconciles mid-plan changes. Tracking and mid-plan adjustment are v0.0.5+ concerns. For v0.0.4, a carried-over slot is fixed by the prior session's intent.
- **Date**: 2026-04-05

### D6 — Continuous rolling by default with "tomorrow" fallback
- **Decision**: When computing the start day of a new plan session: if there's an existing plan session whose `horizonEnd` is today or in the future, new `horizonStart = lastSession.horizonEnd + 1` (continuous rolling). Otherwise (first-ever plan, or there's a gap because the user skipped planning for a vacation), new `horizonStart = tomorrow`.
- **Rationale**: The user shouldn't have to think about start dates in the common case. Continuous rolling is the natural default; "tomorrow" is the natural fallback for edge cases. No configurability, no date picker.
- **Date**: 2026-04-05

### D7 — Plan session persistence is a lightweight marker, not a container
- **Decision**: A `plan_sessions` row stores horizon range, breakfast config, treat budget, embedded flex slots and events, and a `confirmed_at` timestamp. It does NOT store batches — batches reference the session via `created_in_plan_session_id`.
- **Rationale**: Plans are markers of "the user confirmed this horizon on this date with these constraints." Batches are the real content. A plan's "batches" are a query (`where created_in_plan_session_id = ?`), not an embedded array. This matches the principle that batches outlive plans.
- **Date**: 2026-04-05

### D8 — Drop `CookDay` and `MealSlot` from persistence
- **Decision**: Neither `CookDay` nor `MealSlot` is persisted in the new model. Cook days are derived as `groupBy(batches, b => b.eatingDays[0])`. Meal slots are derived at display time from batches + flex slots + events + breakfast.
- **Rationale**: Both are denormalized views. Persisting them creates sync hazards (e.g., Plan 005's silent gap bug was partly a consequence of denormalized state drifting from source of truth). Derived views can't drift. The only loss is stable meal-slot IDs for future tracking, which can be satisfied by synthetic composite keys `(planSessionId, day, mealTime)` when tracking is built.
- **Date**: 2026-04-05

### D9 — No *lifecycle* status column on plan_sessions; "current" is three explicit queries (revised)
- **Decision**: No lifecycle status column on `plan_sessions` (no `'active' | 'completed'` enum tracking where the horizon sits relative to today). Running / future / historical are derived from `horizon_start` and `horizon_end` vs. today. The single boolean `superseded` column exists solely as a tombstone flag for D27's replace-future-only flow (Finding 2 / D31 / D34) and is not a lifecycle status — it records user intent to replace a session, not the session's temporal position.
- **"Current" is not a single concept** in the rolling model. It splits into three explicit store queries:
  - `getRunningPlanSession()` — `WHERE horizon_start <= today <= horizon_end AND NOT superseded LIMIT 1`. At most one result by the D15 sequential invariant.
  - `getFuturePlanSessions()` — `WHERE horizon_start > today AND NOT superseded ORDER BY horizon_start ASC`.
  - `getLatestHistoricalPlanSession()` — `WHERE horizon_end < today AND NOT superseded ORDER BY horizon_end DESC LIMIT 1`.
- **Rationale**: Lifecycle status columns introduce state-transition logic (when does active become completed?); derivation from timestamps sidesteps that. The original D9 wording proposed an ambiguous `ORDER BY confirmed_at DESC LIMIT 1` for a single "current" query, which breaks when the user has both a running session AND a future-only session (the most recently confirmed is often the future-only one, not the one that's actually running). Splitting into three explicit queries with deterministic WHERE + ORDER BY makes every consumer's intent clear and eliminates the semantic drift Finding 5 caught.
- **`completeActivePlans()`** in the current store is a maintenance hack that the derived model eliminates. It stays in place during the strangler-fig window and gets deleted in Phase 7b cleanup.
- **Date**: 2026-04-05
- **Revised**: 2026-04-05 post-review — original wording used `ORDER BY confirmed_at DESC` for "current session," which conflicted with D27's earliest-future-first logic and the existing `src/telegram/core.ts:592` breakfast-fallback semantics. Reconciled by splitting into three explicit queries. See D34.

### D10 — Batch status enum is minimal: `planned | cancelled` (revised)
- **Decision**: Batch `status` field has exactly two persisted values: `planned` (user confirmed, scheduled to cook) and `cancelled` (superseded by D27's replace-future-only flow, kept for audit trail). No `proposed`, no `cooked`, no `consumed`.
- **Rationale**: Drafts are in-memory only (D15 / D33), so there is no such thing as a "proposed but not yet confirmed" persisted batch — if a batch exists in the DB, the user confirmed it. Collapsing the enum from three values to two eliminates the lifecycle inconsistency Finding 4 caught (schema allowed `proposed`, API parameterized over it, but D15 said drafts aren't persisted). In-memory draft batches use the `ProposedBatch` type from `src/solver/types.ts` and never reach the persisted `Batch` type until the user taps Confirm. Tracking is v0.0.5+ and will not use explicit "mark as cooked" buttons (that's friction, violating PRODUCT_SENSE principle #2). Whatever tracking looks like later, it will either infer state from time passing or integrate with photo/voice tracking. We don't need to pre-model those states.
- **Date**: 2026-04-05
- **Revised**: 2026-04-05 post-review — original three-value enum (`proposed | planned | cancelled`) contradicted D15's "drafts are in-memory only." See D33 for the full draft-lifecycle decision.

### D11 — Hard cut on Supabase schema, no migration
- **Decision**: Drop `weekly_plans`, create `batches` and `plan_sessions` fresh. Any existing plan data is discarded.
- **Rationale**: The user hasn't used v0.0.3/v0.0.4 in production. There's no real data to preserve. Migration code is expensive and pointless for zero migrants.
- **Date**: 2026-04-05

### D12 — `custom_shopping_items` field is removed
- **Decision**: The `WeeklyPlan.customShoppingItems` field is not ported to `PlanSession`. The dead read in `src/shopping/generator.ts:98` is also removed.
- **Rationale**: Verified by grep: the field exists in the type, is initialized to `[]` at one site (`src/agents/plan-flow.ts:1143`), and is read as passthrough in the shopping generator. There is no UX path that ever writes to it. It's vestigial. Its concept (custom shopping items) also doesn't belong on a plan session — if it ever exists as a feature, it belongs on a shopping list.
- **Date**: 2026-04-05

### D13 — Proposer behavior: freely cross horizon boundaries
- **Decision**: The proposer's prompt encourages batches whose eating days extend past `horizon_end` into what will be the next session's horizon. Cross-horizon batches are normal, not exceptional.
- **Rationale**: The whole point of rolling horizons is to treat the week boundary as a fiction. The proposer should plan for natural cook cadence regardless of where that lands relative to the horizon end. A 3-serving batch cooked on day 7 is a perfectly reasonable thing to do even if days 8-9 are technically "next horizon."
- **Date**: 2026-04-05

### D14 — Pre-committed slots participate in flex-placement constraints
- **Decision**: The proposer is told that flex slots cannot be placed on days/meal-times already covered by pre-committed slots. Same logic applies to events (already part of the current model).
- **Rationale**: A pre-committed slot means "something is already cooked for this meal." Placing a flex slot on top would double-book. The constraint is obvious once stated; we need to state it in the prompt explicitly.
- **Date**: 2026-04-05

### D15 — One plan session at a time (sequential, not overlapping)
- **Decision**: A user cannot start plan session B until plan session A is either confirmed or abandoned. In-progress draft sessions are held in memory, not persisted. Only confirmed sessions exist in the database.
- **Rationale**: Concurrent in-progress sessions would be confusing (what's "the current plan" if two are in-progress?). Sequential is simpler and matches real user behavior (you plan, then you plan again later).
- **Date**: 2026-04-05

### D16 — Scenario coverage: re-record existing + author 9 new (total 12)
- **Decision**: Phase 8 re-records all 3 existing scenarios against the new model (001, 002, 003) and adds 9 new scenarios covering rolling-specific behavior: `004-rolling-first-plan`, `005-rolling-continuous`, `006-rolling-gap-vacation`, `007-rolling-cross-horizon-batch`, `008-rolling-flex-move-at-edge`, `009-rolling-swap-recipe-with-carryover`, `010-rolling-events-in-rolling-horizon`, `011-rolling-replan-future-only`, `012-rolling-replan-abandon`. All 12 are MUST-HAVE for plan exit — none are deferred. Scenario 005 doubles as the Phase 4 proposer smoke test per D26.
- **Rationale**: The user explicitly asked for extensive test coverage: *"at least. but you will need more to test the system extensively — dont hesitate to do that. better to test extensively than ship broken software."* The nine new scenarios cover every primary rolling-specific behavior (first plan, continuous rolling, gap fallback, cross-horizon batches, flex-move-at-edge regression with the new cross-horizon extension, swap-with-carryover, events+carryover composition, the replan-future-only happy path from D27, and the replan-abandon path that locks in the save-before-destroy guarantee from Finding 1 of the third review). The re-recordings lock in that existing happy paths still behave correctly against the new shapes.
- **Date**: 2026-04-05
- **Revised (first)**: 2026-04-05 post-review — added scenario 011 to cover D27 (plan-ahead replan flow) which was not in the original plan.
- **Revised (second)**: 2026-04-05 third review — added scenario 012 to lock in the save-before-destroy behavior (abandoning a replan draft must leave the replaced session intact). This is the regression test for Finding 1 of the third review.

### D17 — Mid-plan replan (tapping Plan Week while a currently-running plan has days left) is out of scope
- **Decision**: If the user taps "Plan Week" while their currently-running plan session still has days remaining AND there is no future-only session, the system proceeds with continuous rolling (the new horizon starts the day after the running session's horizon end). Mid-plan replan of the running session itself — going back and changing a session you're already consuming from — stays out of scope for Plan 007 and remains a v0.0.5 concern tied to running budget and tracking.
- **Rationale**: Mid-plan replan requires knowing what's been cooked/consumed to reason about what's safe to change. That's v0.0.5+. Planning ahead (next horizon) is a different and simpler question, handled by continuous rolling + D27.
- **Date**: 2026-04-05
- **Supersedes**: earlier version that said "behavior is left unspecified" — clarified after post-review S7 discussion that the *planning ahead* case has a clean answer (continuous rolling), and only the *mid-plan edit* case is deferred.

### D18 — Design doc extraction is a post-implementation exit criterion
- **Decision**: This plan does not ship with a design doc. At plan completion (before moving to `plans/completed/`), the implementer extracts the decision log + surprises + outcomes into a design doc under `docs/design-docs/`.
- **Rationale**: The user's own feedback rule saved in memory (`feedback_design_docs_post_impl.md`): implementation refines pre-execution decisions; writing a design doc upfront creates two sources of truth. The plan is the pre-execution record; the design doc is the post-execution synthesis.
- **Date**: 2026-04-05

### D19 — `recipe_name` is not stored on batches
- **Decision**: The `batches` table does not include a `recipe_name` column. Display derives the name from the recipe database via `recipeSlug`.
- **Rationale**: Following current `Batch` shape (which also doesn't store recipe_name — only `recipeSlug`). Names can change if a recipe is edited, and the batch should reflect the current name. No need to snapshot.
- **Date**: 2026-04-05

### D20 — Cross-horizon batches display their "outgoing" days clearly
- **Decision**: When rendering a plan that contains batches extending past `horizon_end`, the display notes the extension (e.g., "Moroccan Beef Sun (+ 2 days into next week)"). The extra days are NOT shown as separate rows inside the current horizon — they belong to the next horizon conceptually.
- **Rationale**: Honesty about the cook session's actual scope without cluttering the current horizon's view. The user sees "this cook will feed you into next week" without being confused by days that aren't in this horizon's timeframe.
- **Date**: 2026-04-05

### D21 — Pre-committed slots are visually marked
- **Decision**: Pre-committed slots in the rendered plan carry a marker like "(from prior plan, N cal)" so the user understands why the slot isn't editable via the current session's swap flow AND sees the frozen macro value directly.
- **Rationale**: Transparency about what's mutable, plus explicit macro display so the user understands why some meals in the same week are different sizes (frozen session-A macros vs. session-B's new-batch per-slot target).
- **Date**: 2026-04-05

### D22 — Cook-day hotfix ships separately from Plan 007
- **Decision**: The 3-line fix at `src/solver/solver.ts:307` (`cookDay = dayBefore(firstEatDay)` → `cookDay = firstEatDay`) plus a plan-validator comment fix plus regenerating existing scenarios lands as an isolated pre-Monday hotfix, independent of Plan 007. Plan 007 drops its Monday-deadline framing and proceeds without timeline pressure.
- **Rationale**: The hotfix solves the v0.0.4 symptom (trust-breaking wrong cook display on first use). Plan 007 solves the architectural disease (weekly silo, edge orphans, cross-horizon invisibility). Bundling them conflated a 3-line patch with an 8-phase refactor and concentrated risk against a weekend deadline for no architectural gain. Splitting gives the hotfix its small blast radius and gives Plan 007 breathing room to ship correctly before v0.0.5 features start landing.
- **Date**: 2026-04-05
- **Supersedes**: the original "Why now, not v0.0.5+" framing in the Problem section, which listed the cook-day bug as a v0.0.4 blocker requiring the full refactor before Monday.

### D23 — Solver cross-horizon handling follows rule (a): solver sees only in-horizon days
- **Decision**: `SolverInput.mealPrepPreferences.recipes[i].days` contains only the in-horizon subset of the batch's eating days. Overflow days (days past `horizonEnd`) live on `ProposedBatch.overflowDays` and on the persisted `Batch.eatingDays`, but are invisible to the solver itself. The filter is applied at the boundary (`buildSolverInput` in plan-flow), not inside the solver. A 3-serving batch with 1 in-horizon day contributes 1 slot to the solver's slot count; its other 2 servings appear as session B's pre-committed slots when session B runs.
- **Rationale**: Keeps the solver stateless about horizons beyond its own. Alternatives (solver sees full days but filters internally; cross-session budget deduction) add coupling without clarity. Rule (a) puts responsibility at the boundary where the caller already knows the horizon shape. The solver's budget math, daily breakdown, and weekly totals all operate on the 7-day horizon window as they do today.
- **Date**: 2026-04-05

### D24 — Strangler-fig refactor, not big-bang replacement
- **Decision**: Phase 1 adds new types alongside old types rather than replacing them. Every intermediate commit stays `npm run build` green. Call sites migrate module-by-module in Phases 2–6. Phase 7b is the final cleanup commit that deletes the old types, drops the `weekly_plans` table, and removes the deprecated `StateStoreLike` methods.
- **Naming**: resolve the `Batch` name collision by renaming the **old** type once in Phase 1: `Batch` → `LegacyBatch` (5 importers — verified). The new shape takes the clean name `Batch` from day one. Phase 7b is pure deletion of `LegacyBatch`, no further renames. The alternative (introduce the new shape as `PlannedBatch`, rename to `Batch` at cleanup) was rejected because it requires a large rename across every migrated file at the end of the refactor — riskier and less reviewable than one rename up front.
- **Rationale**: The original Phase 1 exit criterion was "build is broken for several phases — fix it later." That makes debugging harder: a typo introduced in Phase 1 surfaces during Phase 4 or Phase 5 against 500+ lines of diff across multiple modules. Strangler-fig keeps commits bisectable and lets scenarios incrementally validate each migration step.
- **Date**: 2026-04-05
- **Supersedes**: the original Phase 1 exit criterion. The "atomic release from the user's perspective" property is preserved — nothing ships until the branch merges — but development proceeds against a buildable baseline throughout.

### D25 — Swap handlers extend batches into the next horizon at horizon edges (S5 option 1)
- **Decision**: `restoreMealSlot` / `absorbFreedDay` / `removeBatchDay` in `plan-flow.ts` are upgraded so that when a mutation would create a 1-day orphan at the horizon edge, the orphan is absorbed by extending an adjacent same-meal-type batch *forward into the next horizon* (the batch acquires an overflow day). This is in addition to the existing in-horizon extension logic. The gap-surfacing fallback from Plan 005 still applies for genuinely orphaned days with no adjacent batch.
- **Rationale**: Without this, the initial proposer can produce cross-horizon batches (D13) but post-proposal swap handlers cannot, creating a user-visible inconsistency: same user action ("move flex to Saturday") yields a clean plan if done during proposal phase, a 1-serving gap prompt if done after. That is exactly the class of inconsistency that erodes trust. Option 1 closes the gap by making swap handlers equally capable. Option 2 (slow-path re-proposer) was rejected as v0.0.5 scope. Option 3 (accept inconsistency, improve gap-prompt copy) was rejected as a cover-up. Option 4 (do nothing) was the original plan's position and is what the review flagged.
- **Constraints**: extension is forward-only into the next (not yet confirmed) horizon. A batch cannot extend backward into a past horizon — that would require mutating a prior confirmed session, which D5 forbids. The 2–3 serving cap still applies.
- **Date**: 2026-04-05
- **Supersedes**: the original Phase 5 step 4 text ("swap handlers still use existing removeBatchDay/absorbFreedDay logic, the gap-surfacing fix from Plan 005 still applies") which left the inconsistency unresolved.

### D26 — Proposer smoke test is a committed scenario, not a manual API call
- **Decision**: Phase 4 ends with authoring and generating scenario `005-rolling-continuous` against the real LLM. The implementer reads the generated `recorded.json` directly (without asking the user) and verifies the proposer's prompt contains the pre-committed slots section, the response respects the slots, and the budget math lands within tolerance. The scenario is then committed. It is both the Phase 4 smoke test AND the permanent regression test for carry-over behavior.
- **Rationale**: The original Plan 007 review surfaced a concern that the proposer prompt rewrite could regress quality in ways `deepStrictEqual` wouldn't catch. The obvious fix — manual API calls before scenario recording — would have required the user to run ad-hoc commands and eyeball output. But the harness is built exactly to avoid that: `npm run test:generate` captures real LLM behavior deterministically. Using the scenario IS the smoke test. Self-review replaces human-in-the-loop review.
- **Date**: 2026-04-05
- **Supersedes**: an earlier review suggestion to run a 5-minute manual API check before Phase 8. Rejected in favor of this cleaner, more reusable approach.

### D27 — Plan Week during a future-only session offers to replan it (revised twice)
- **Decision**: When the user taps "Plan Week" and `store.getFuturePlanSessions()` returns a non-empty array (at least one confirmed, not-superseded session with `horizon_start > today`), the flow does NOT create a new horizon *after* that session. Instead it offers: "You already have a plan for {date range}. Replan it?" On confirm, **the old session is NOT touched** — a fresh planning flow starts with `horizonStart = futureSession.horizonStart` and `state.replacingSessionId = futureSession.id` carried through the draft. The old session stays fully live in the DB throughout the draft. Only at confirm time — when the user approves the new plan and `handleApproveRolling` runs — does the store's `confirmPlanSessionReplacing(newSession, newBatches, oldSessionId)` method run. That method saves the new state first (insert session, insert batches), then marks the old session's batches `cancelled` and the old session `superseded = true`. Save-before-destroy is guaranteed by write ordering, not by a database transaction. See D31.
- **Abandonment is safe.** If the user taps /cancel, or the bot restarts, or the session times out, or any network error aborts the draft — the old future session is still in the DB, still `superseded = false`, still returned by `getFuturePlanSessions`. No data loss. This is the Finding 1 resolution from the third review: the earlier destructive-first ordering (supersede on confirm, start new flow, confirm at end) would have stranded the user with no plan if they abandoned the draft.
- **No physical delete.** The old session row stays in the database as an audit record with `superseded = true` once the replacement is committed. All queries in the production store (`getRunningPlanSession`, `getFuturePlanSessions`, `getLatestHistoricalPlanSession`, `getRecentPlanSessions`) filter `NOT superseded` so superseded rows are invisible to normal code paths. This preserves history without complicating the common-path queries.
- **Breakfast inheritance** (Finding 3 from the third review): the replanned draft inherits its starting breakfast from the session being replaced, NOT from the running/historical fallback chain used in the normal (non-replace) case. The user's deliberate breakfast choice for that future session is preserved as the default; they can still change it via the normal "Change" button during the draft. See Phase 5a step 6 for the implementation split.
- **Rationale**: If the user has planned ahead (already confirmed next week's plan) and taps Plan Week again, the continuous-rolling rule would otherwise place them three weeks out — confusing and unhelpful. The user's real intent is almost always "I want to revise the not-yet-started plan." Replacing it cleanly via save-before-destroy ordering is the simplest response. Mid-plan replan of a *running* session remains out of scope (D17) because that requires consumption/tracking awareness; future-only sessions have no consumption yet and can be freely replaced.
- **Edge cases**: if multiple future-only sessions exist (unusual but possible), `getFuturePlanSessions()` orders by `horizon_start ASC`, and the flow offers to replan the earliest one. If only a running session exists (no future-only), normal continuous rolling applies (new horizon starts after the running session ends).
- **Date**: 2026-04-05
- **Revised (first)**: 2026-04-05 post-review — original flow described as "cancel batches, then delete session" (two separate operations, partial-write risk). Replaced with an atomic Postgres RPC.
- **Revised (second)**: 2026-04-05 third review — the RPC-based "atomic supersede then start new flow" approach still destroyed the old session before the replacement existed, losing data on abandonment. Fixed by keeping the old session live through the entire draft phase and moving the supersede into a save-before-destroy-ordered `confirmPlanSessionReplacing` at confirm time.
- **Revised (third)**: 2026-04-05 user direction — dropped pl/pgsql RPCs as overkill for the prototype. Save-before-destroy ordering is now implemented in client-side sequential Supabase calls per D31. No behavioral change from the second revision — same ordering, same guarantees, less code.

### D28 — Pre-committed slot recipes count against variety rules for the current horizon
- **Decision**: The proposer prompt's `## VARIETY RULES (CRITICAL)` section is extended to state that recipes appearing in pre-committed slots for the current horizon count as already-used. The proposer must not propose a new batch using a recipe that already appears in a pre-committed slot.
- **Rationale**: The existing "no repeats from recent plan history" rule covers past horizons but not the current horizon's own carry-over. Without this extension, the proposer could propose Moroccan Beef for Thu-Fri while pre-committed slots already carry Moroccan Beef on Mon-Tue — the user would see the same recipe twice in the same week on non-adjacent days, which is a variety failure. The rule is obvious once stated; it just has to be stated.
- **Date**: 2026-04-05

### D29 — The two-shape representation (Batch vs PreCommittedSlot) is load-bearing
- **Decision**: The system maintains two distinct types for "a meal that's planned" — `Batch` / `ProposedBatch` (current session's own batches) and `PreCommittedSlot` (projections of prior sessions' batches into the current horizon). These are NOT unified even though they describe overlapping concepts. The separation is enforced at the type level and documented in the data-model section.
- **Rationale**: Unification would either force the solver to unpack batches to extract per-meal macros (coupling the solver to batch ownership rules) or force prior sessions' batches into a mutable shape on the current session's proposal (breaking cross-session ownership). The current separation keeps the solver simple (flat list of slots with known macros) and makes it impossible for session B to accidentally mutate session A's batches. The cost is that `formatPlanProposal` merges two representations at display time — a known, localized trade-off.
- **Future maintainers**: do NOT unify these types without also rethinking solver input shape and cross-session ownership invariants. This comes up more often than you'd think in type cleanups.
- **Date**: 2026-04-05

### D30 — Immutable creating-session ownership + cook-day-in-horizon invariant + overflow-orphan rejection
- **Decision**: A batch's `createdInPlanSessionId` is set at creation and never changes. The authoritative ownership query is *"which session created this batch"* — not *"which session's horizon currently contains its cook day."* An additional invariant holds: **every persisted batch has `eatingDays[0]` inside its creating session's `[horizonStart, horizonEnd]`**. Together these give ownership a single definition and ensure display rules can use cook-day as a secondary filter without ambiguity.
- **Enforced by**: an assertion in `buildPlanSession` at confirm time. A swap handler that would produce a batch with an out-of-horizon cook day is a programmer error — `removeBatchDay` detects the specific case and signals the caller (`absorbFreedDay`) to drop the entire batch instead of persisting it with an invalid cook day.
- **Orphan day handling after a batch drop — two classes:**
  - **In-horizon orphans** (days inside the current horizon): absorb-or-gap. `restoreMealSlot` tries to extend an adjacent batch; if that fails, the day is surfaced as a `RecipeGap` via the normal flow. Same behavior as today.
  - **Overflow orphans** (days past `horizonEnd`): **absorb-only, with mutation rejection on failure.** `restoreMealSlot` tries to extend an adjacent same-meal-type batch forward into the overflow day(s); if that fails, the entire mutation is rejected and the draft rolls back to its pre-mutation state. The user sees a message explaining that the move would strand meals with no home, and is asked to choose a different day. Overflow orphans cannot be gap-surfaced because session A's display doesn't render out-of-horizon days (Phase 5e step 1c) — a "generate a recipe for day 8" prompt would reference a day the user can't see.
  - Rationale: a mutation that would strand meals into the next horizon with no carrier batch is itself invalid. Rejecting it at mutation time is cleaner than silently losing meals or showing gap prompts for invisible days.
- **Why this specific resolution**: the original Phase 5d step 4 text allowed a mutation that would leave a batch with `eatingDays = [8, 9]` (cook day 8, in session B's horizon) still owned by session A. This contradicted P3's language and made the Phase 5e display rule ambiguous. The first-round fix forbade the mutation at the batch level and dropped the batch — correct, but it left the downstream question "what happens to the dropped batch's eating days" under-specified (Finding 1 of the second review). The second-round fix adds the two-class orphan rule: in-horizon orphans keep their existing absorb-or-gap behavior; overflow orphans are absorb-or-reject. Rejecting rare pathological mutations is better UX than silently losing out-of-horizon meals.
- **Rare path expected frequency**: requires a 3-serving cross-horizon batch whose only in-horizon day gets carved by a flex move, AND no adjacent batch exists that could absorb the overflow servings by forward-extension. Low expected hit rate in normal use — but the plan must specify what happens when it fires, so it does.
- **Date**: 2026-04-05 (post-review, revised 2026-04-05 after second review)
- **Supersedes**: the original Phase 5d step 4 paragraph about `days = [], overflow = [8, 9]` ownership leakage (rejected first round) AND the first-round "treat every eating day including overflow as orphans requiring absorption or gap-surfacing" language, which left overflow-only orphans with no valid handler (rejected second round).

### D31 — Save-before-destroy via client-side write ordering (not pl/pgsql)
- **Decision**: All multi-row writes to `plan_sessions` and `batches` go through two methods on `StateStoreLike`: `confirmPlanSession(session, batches)` for fresh confirms, and `confirmPlanSessionReplacing(session, batches, replacingSessionId)` for D27's replace-future-only flow. Both are implemented as sequential Supabase JS client calls — **no pl/pgsql RPC functions**. Save-before-destroy semantics are guaranteed by the *order* of the writes, not by database transaction boundaries.
- **`confirmPlanSession` ordering** (2 steps): (1) insert session row, (2) bulk-insert batches. Bulk insert is server-side-atomic for N batches via Supabase's standard behavior. The FK constraint (`created_in_plan_session_id references plan_sessions(id)`) ensures step 2 can only succeed if step 1 already did. Only failure mode is step 2 failing after step 1 succeeded → orphan session row, detectable and cleanable.
- **`confirmPlanSessionReplacing` ordering** (4 steps, save-before-destroy): (1) insert NEW session, (2) bulk-insert NEW batches, (3) `UPDATE batches SET status='cancelled'` for the OLD session's batches, (4) `UPDATE plan_sessions SET superseded=true` for the OLD session. The NEW state is written in full before the OLD state is touched. If steps 1 or 2 fail, the old session is completely untouched. If steps 3 or 4 fail after the new is saved, the next Plan Week tap re-enters the replan flow and retries the cleanup (steps 3 and 4 are idempotent). Save-before-destroy is the *point* of this ordering — Finding 1 of the third review caught that the earlier destructive-first ordering could strand the user with no plan at all if they abandoned the new draft.
- **FK enforcement**: `batches.created_in_plan_session_id` has `REFERENCES plan_sessions(id) ON DELETE RESTRICT`. Sessions are never physically deleted; the replace flow marks them `superseded` instead. The RESTRICT is a cheap safety net against accidental future DELETE calls.
- **`StateStoreLike` surface**: production code accesses mutations ONLY through `confirmPlanSession` and `confirmPlanSessionReplacing`. No `saveBatch` / `saveBatches` / `updateBatchStatus` / `deletePlanSession` / `supersedeFuturePlanSession` on the public interface. This keeps the atomic-at-the-method-level contract visible in the type system — there is no public way to produce a partially-applied multi-row change, even though the underlying implementation uses sequential calls.
- **Why not pl/pgsql RPCs** (rejected alternative): an earlier draft of this plan wrapped both flows in Supabase Postgres RPC functions (`confirm_plan_session`, `supersede_plan_session`, `confirm_plan_session_replacing`) to get full transactional atomicity. That was rejected as overkill for a single-user prototype. Cost of pl/pgsql: new language in the codebase, stringified Postgres errors instead of structured JS exceptions, schema/type drift risk, harder local debugging, two places to change when the shape evolves. Benefit: safety against a failure mode (mid-write error on a healthy Supabase connection with ~6 rows per confirm, one user) that is effectively never going to fire. Net negative for v0.0.4.
- **Failure-mode audit trail**: every step in `confirmPlanSession` and `confirmPlanSessionReplacing` is logged to `logs/debug.log` via `log.debug('STORE', ...)`. If partial-write drift ever shows up in production logs, the trail is there to diagnose and a manual cleanup query can be run.
- **Tech-debt hook**: add a one-line entry to `docs/plans/tech-debt.md`: *"If partial-write failures show up in logs/debug.log, add an orphan-session cleanup script (session row with zero planned batches, or session with `superseded=true` but still-planned batches) and optionally migrate the confirm flows to pl/pgsql RPC functions for full transactional atomicity."* Graduates to a plan when the first incident lands. Until then, the client-side-ordering approach is correct and cheaper.
- **TestStateStore parity**: mirrors production's ordering — a throw at step N leaves the in-memory store in the same partial state production would be in. Harness scenarios 011 (happy-path replan) and 012 (abandon-mid-draft) lock the save-before-destroy behavior into the regression suite.
- **Date**: 2026-04-05 (post-review, revised 2026-04-05 again after the user pushed back on RPC overkill)
- **Supersedes**: (a) the original Phase 5c step 3 acceptance of partial writes (rejected in the first post-review pass as contradicting the drift-removal thesis), and (b) the pl/pgsql RPC approach introduced in the second post-review pass (rejected in the third pass as overkill for a single-user prototype — the client-side ordering provides the same save-before-destroy guarantee with less code to maintain).

### D32 — Explicit `horizonDays` on SolverInput closes a latent bug
- **Decision**: `SolverInput` gains a required `horizonDays: string[]` field of length exactly 7. The solver iterates `horizonDays` directly for `buildDailyBreakdown` and orphan checks. The old `getWeekDays` helper (which derived the day set from `recipes[].days + flexSlots[].day`) is replaced by a thin assertion helper `resolveHorizonDays(input)` that just validates and returns `input.horizonDays`.
- **Rationale**: `getWeekDays` at `src/solver/solver.ts:176-186` ignores `events[]` — a day covered only by an event (no batch, no flex) is missing from `dailyBreakdown` and the validator's orphan check never fires for it. Today this is a latent bug masked by the invariant that real plans have a batch or flex on every day. Under rolling horizons with carried-over slots, days can legitimately be covered *only* by a pre-committed slot or a restaurant event, and the bug becomes load-bearing — the solver would silently omit those days. The fix is to make the 7-day horizon an explicit contract instead of a derived set.
- **Strangler-fig compatibility**: during the migration window, the old code path in `buildSolverInput` populates `horizonDays` from `weekStart` (7 sequential dates) so existing scenarios keep passing with no behavioral change. The new code path in Phase 5b populates it from `state.horizonDays`. The solver's internal behavior is unchanged for inputs that match the old pattern (every day covered by a batch or flex); it's only different for the new rolling-horizon cases that exercise the previously-latent code path.
- **Date**: 2026-04-05 (post-review)
- **Closes**: a pre-existing bug in `src/solver/solver.ts:176-186`. Not introduced by Plan 007, but would have been made visible and harmful without this fix.

### D33 — Drafts are in-memory only (the lifecycle collapses to one model)
- **Decision**: Draft plan sessions and their batches exist only as in-memory TypeScript objects during the planning flow. Nothing is persisted to Supabase until the user taps Confirm. All rows in `plan_sessions` have `confirmed_at NOT NULL` (default `now()`). All rows in `batches` have `status IN ('planned', 'cancelled')`. There is no `'proposed'` status, no nullable `confirmed_at`, no concept of a "draft row" in the DB.
- **What in-memory drafts look like**: `PlanFlowState` holds the draft session as a TypeScript object with `horizonStart`, `horizonDays`, `breakfast`, `events`, `proposal` (containing `batches: ProposedBatch[]`, `flexSlots`, etc.). `ProposedBatch` is the in-memory draft type (defined in `src/solver/types.ts`, with mutable `days` and `overflowDays`). When the user confirms, `buildPlanSession` converts `ProposedBatch[]` to `Batch[]` and the atomic `confirmPlanSession` RPC persists them.
- **Rationale**: The original plan had two lifecycle models fighting each other. D15 said drafts are in-memory only. But the schema had a nullable `confirmed_at`, the status enum had `'proposed'`, and the store API was parameterized over all three statuses. Finding 4 was correct: the plan was paying the complexity cost of persisted drafts without clearly wanting them. Collapsing to "drafts are in-memory only" simplifies the schema, the status enum, the query contract, and the mental model. Draft rehydration across bot restarts is a v0.1.0 concern per `BACKLOG.md` — not blocking for v0.0.4.
- **Date**: 2026-04-05 (post-review)
- **Supersedes**: the nullable `confirmed_at` column and the `'proposed'` batch status from the original schema. Both removed.

### D34 — Three explicit store queries replace the ambiguous "current session"
- **Decision**: `StateStoreLike` exposes three distinct queries for the "where does the user sit relative to today" question:
  - `getRunningPlanSession()` — `WHERE horizon_start <= today <= horizon_end AND NOT superseded LIMIT 1`. At most one result.
  - `getFuturePlanSessions()` — `WHERE horizon_start > today AND NOT superseded ORDER BY horizon_start ASC`. Array, earliest first.
  - `getLatestHistoricalPlanSession()` — `WHERE horizon_end < today AND NOT superseded ORDER BY horizon_end DESC LIMIT 1`.
  There is NO `getCurrentPlanSession()` method on the new interface. "Current" is not a single concept in the rolling model — it splits into running / future / historical, and the caller picks the one that matches its intent.
- **Call-site mapping**:
  - Phase 5a entry logic (D27): `getFuturePlanSessions() → getRunningPlanSession() → getLatestHistoricalPlanSession()` fallback chain. Picks the replan-future target if any, else falls through to continuous-rolling or fresh-start.
  - Breakfast fallback at `src/telegram/core.ts:592` (old `getCurrentPlan() ?? getLastCompletedPlan()`): becomes `(await getRunningPlanSession()) ?? (await getLatestHistoricalPlanSession())`. Future sessions are NOT consulted for breakfast because if a future session exists, the flow is routed into the D27 replan path and inherits breakfast from the running/historical fallback instead.
  - Variety engine (`buildRecentPlanSummaries`): `getRecentPlanSessions(limit)` — ordered by `horizon_end DESC`, filtered `NOT superseded`, NO temporal filter. Includes running, future, and historical sessions indiscriminately. Rationale: variety is temporally symmetric — the user equally cares about not repeating recipes they're eating now (running session), will eat soon (future sessions), or ate recently (historical sessions). The original Phase 2 docstring said "historical only," which is wrong because it would let the proposer suggest a repeat of a meal the user is currently eating. The only sessions excluded from the variety signal are superseded ones, which don't reflect real user intent.
- **Rationale**: Finding 5 caught three different orderings in the original plan (Phase 2 docstring ambiguous, D9 `ORDER BY confirmed_at DESC`, D27 `ORDER BY horizon_start ASC`) and the existing code at `src/telegram/core.ts:592` using a fourth implicit ordering. Consolidating into three explicit queries with deterministic WHERE + ORDER BY eliminates the ambiguity and makes every consumer's intent clear. `confirmed_at` is not used as an ordering key anywhere in the new interface — it only exists as a timestamp for audit purposes.
- **Date**: 2026-04-05 (post-review)
- **Supersedes**: the `getCurrentPlanSession()` and `getUpcomingPlanSessions()` methods from the earlier Phase 2 draft. Both removed in favor of the three explicit queries.

---

## Out of scope (explicit)

- **Shopping list redesign** — per-cook-session trips, grouped shopping around cook days, the shift from weekly-single-list to multi-trip lists. Deferred. Current shopping generator will keep working against the new batch model.
- **Tracking** — no `cooked` or `consumed` states, no "mark as done" buttons, no running budget. v0.0.5+.
- **Mid-plan replan / mid-plan adjustment** — user re-planning while their current plan still has days remaining. v0.0.5+.
- **Recurring commitments** — "Fridays are always takeout" as explicit user configuration. Future auto-derivation from plan history is preferred.
- **Notifications / event system** — automatic nudges to plan, reminders, etc. Out of scope for v0.0.4 entirely.
- **Multi-user support** — the SINGLE_USER_ID constant stays. Preference system is not plumbed.
- **Variable-length horizons** — always 7 days. Vacation gaps become gaps *between* plan sessions, not variable-length plans.
- **Partial-day plans** — no skipping days within a horizon. If the user has a 3-day vacation, they just don't plan for those days (or they plan a horizon that starts after the vacation).
- **Cross-horizon flex slots** — flex slots are per-plan-session and don't carry over. Events same.
- **Editing carried-over meals from a new plan session** — read-only, per D5.

---

## Validation

### Build and test gates

1. `npm run build` — zero TypeScript errors.
2. `npm test` — all scenarios green. The scenario harness is the primary verification mechanism (per CLAUDE.md Debug Workflow).
3. Git diff review on `recorded.json` for each re-recorded scenario — changes should match phase-level expectations and nothing else. If a scenario's recording shows unexpected changes, the fix has wider blast radius than intended.
4. If any unit tests exist (shopping generator, solver primitives), they pass against the new types.

### Manual Telegram verification

1. `DEBUG=1 npm run dev` — real bot.
2. Fresh state: no plan sessions in Supabase (or manually delete).
3. Flow 1 — First plan:
   - User taps "Plan Week."
   - System proposes a 7-day plan starting tomorrow.
   - Cook schedule shows cooks on days where batches start (cook day = first eating day).
   - No pre-committed slots (first plan has nothing to carry over).
   - User confirms; plan + batches persist.
4. Flow 2 — Continuous rolling:
   - User taps "Plan Week" again.
   - System proposes a 7-day plan starting the day after the previous plan's `horizon_end`.
   - Pre-committed slots from the first plan appear in the new plan's display, marked "(from last plan)."
   - Proposer plans only uncovered slots. Budget math subtracts pre-committed calories.
   - User confirms; new batches persist.
5. Flow 3 — Gap fallback:
   - Manually shift the clock forward past the second plan's horizon by multiple days (or set horizon_end to a past date).
   - User taps "Plan Week."
   - System defaults to `horizonStart = tomorrow` (the gap fallback).
   - No pre-committed slots from the now-stale plans.
6. Flow 4 — Cross-horizon batch:
   - During a plan, observe that the proposer creates at least one batch whose `eating_days` extends past `horizon_end` (cook on day 6 or 7, eating days into days 8-9).
   - In the next plan, verify those days appear as pre-committed slots.
7. Flow 5 — Flex move regression (the original bug):
   - Plan a horizon.
   - Swap → "Move flex slot to Saturday" (or wherever creates the carve scenario at the horizon edge).
   - Verify the carved orphan day is absorbed into an adjacent batch (possibly as an overflow day into the next horizon per D25). **No 1-serving gap prompt should appear.** No calorie clamping warnings. No silent dissolution.
8. Flow 6 — Replan-future-only, happy path (D27 + Finding 1 third-review resolution):
   - Plan a horizon for next week (confirm; now there's a future-only confirmed session B in the store).
   - While still on today's date (so session B is still `horizon_start > today`), tap Plan Week again.
   - Verify the system prompts "You already have a plan for {date range}. Replan it?" with Confirm / Cancel inline buttons.
   - Tap Confirm on the prompt. **Verify that session B is still in the store at this point** (`superseded = false`, batches still `planned`) — save-before-destroy means the old session stays live through the draft phase.
   - Proceed through the draft: confirm breakfast (should default to B's breakfast per Finding 3), set events, review proposal, tap Approve.
   - At Approve time, `confirmPlanSessionReplacing` runs the four-step sequence. Verify the final state:
     - A new session C exists with `superseded = false` and its own new batches.
     - Session B now has `superseded = true` (still present in the DB for audit, not deleted).
     - Session B's batches all have `status = 'cancelled'`.
     - `getFuturePlanSessions()` returns [C] only.
     - `getRunningPlanSession()` still returns plan A (the running one, unaffected).
9. Flow 7 — Replan-future-only, abandon path (Finding 1 third-review):
   - Start from the same state: plan A running, plan B future-only.
   - Tap Plan Week → tap Confirm on "Replan it?" → enter the draft.
   - Before reaching Approve, tap /cancel (or close the Telegram thread, or simulate a bot restart).
   - **Verify that session B is still completely intact**: `superseded = false`, all its batches still `status = 'planned'`. No new session was persisted. The save-before-destroy guarantee held.
10. Flow 8 — Replan-future-only, decline path:
    - Start from the same state.
    - Tap Plan Week → get the "Replan it?" prompt → tap Cancel.
    - Verify nothing changed in the store; the user is back to idle.

### Debug log sanity

After the manual run, `tail -500 logs/debug.log`:
- `[AI:REQ] ... context=plan-proposal` entries should show `## PRE-COMMITTED SLOTS` section in the user message for the second-plus plan sessions.
- `[PLAN-FLOW] swap intent: ...` entries continue to work without errors.
- No "invariant violation" or "calorie clamped" warnings in normal paths.

### Docs updates (part of exit criteria)

- [ ] `docs/product-specs/data-models.md` — rewrite the data model section with the new types. Drop `WeeklyPlan`, add `PlanSession` and `Batch` (new shape).
- [ ] `docs/product-specs/flows.md` — rewrite the plan week flow section. "Week" becomes "7-day horizon" in copy where the distinction matters. Document the continuous-rolling + tomorrow-fallback logic.
- [ ] `docs/product-specs/solver.md` — add the pre-committed slots input, document the carry-over budget subtraction.
- [ ] `docs/ARCHITECTURE.md` — update the data flow diagram to show the new entities (batches, plan sessions).
- [ ] `docs/BACKLOG.md` — mark v0.0.5 items that become simpler because of this refactor (plan-mutation slow-path, tracking, running budget). Add a note that `cookStyle='batch'` preference is a future feature when real users request it.

### Design doc extraction

- [ ] Create `docs/design-docs/rolling-horizons-and-first-class-batches.md` synthesizing D1–D34 (the full decision log including D22–D29 added after the first-pass review, and D30–D34 added after the second-pass critical review) into durable rationale. The second-pass additions (ownership invariant, transactional persistence, explicit horizon input, draft-lifecycle collapse, explicit session queries) deserve particular emphasis in the design doc because they resolved real architectural issues the first-pass plan missed. Include any surprises or discoveries found during implementation. Add the file to `docs/design-docs/index.md` and `CLAUDE.md`'s docs index table.

---

## Surprises & discoveries

*(To be filled in during implementation. Log anything that contradicts or refines a decision above.)*

---

## Outcomes & retrospective

*(To be filled in at plan completion. Summarize what actually shipped, what changed from the plan, and what to fold into the design doc.)*

---

## Implementation notes (resolved during planning)

This section captures resolutions to questions that came up during review so the implementer doesn't have to rediscover them. None are open — they're all decided. If one turns out to be wrong during implementation, update it here and log the rationale in "Surprises & discoveries."

1. **Supabase migration mechanics.** Two migration files under `supabase/migrations/` (a new folder — first-ever migrations in the repo):
   - `001_create_plan_sessions_and_batches.sql` — created in Phase 1, run manually in the Supabase dashboard at the start of Phase 2.
   - `002_drop_weekly_plans.sql` — created in Phase 7b, run manually as part of the cleanup commit.
   `supabase/schema.sql` stays as-is during the refactor and gets a full refresh at Phase 7b to reflect the post-migration canonical state.

2. **Proposer prompt length.** Current prompt is ~5000 chars. The new sections (`## PRE-COMMITTED SLOTS`, `## CROSS-HORIZON BATCHES`, extended variety rules) add ~500–1000 chars. Well within the GPT-5.4-mini context window; not a concern. If the Phase 4 smoke test via scenario 005 surfaces any truncation issue (it won't at this size), trim the BATCH SIZING STRATEGY explanation rather than reducing carry-over info, which is load-bearing.

3. **`eating_days` array query performance.** Not a concern at v0.0.4 scale. Single user generates ~5 batches/week → ~260 batches/year. GIN index on `date[]` with `&&` operator is O(log n) per lookup; at 260 rows the query is trivially fast. Revisit only if multi-user ever lands and per-user batch counts climb into the thousands. No bucketing strategy needed.

4. **Scenario regeneration cost.** Re-recording scenarios requires real LLM calls (cost + wall-time, non-deterministic if the model updates). This is accepted cost, budgeted into Phases 4 and 8. D26 (proposer smoke test via scenario 005) absorbs the initial risk by validating the prompt against the real model *before* the bulk recording pass, so regeneration work on scenarios 006–011 doesn't get wasted on a broken prompt.

5. **`formatPlanProposal` complexity threshold.** Concrete rule: if the function exceeds ~250 lines after Phase 5e's derivation rewrite, extract helpers (`deriveCookSchedule(batches)`, `deriveDayRows(batches, preCommittedSlots, flexSlots, events, breakfast)`, `renderPreCommittedSlot(slot)`). Otherwise keep the derivation inline. Don't extract prematurely. The existing function is ~100 lines; adding ~50–80 lines of derivation plus pre-committed slot rendering lands around ~180–200 lines, probably inline-acceptable.

6. **Batch mutation isolation during swap flow.** Enforced structurally, not via runtime guards: `PlanFlowState` holds `proposal.batches` (the current session's mutable batch list) and `preCommittedSlots` (a read-only `readonly PreCommittedSlot[]` snapshot loaded once from the store at proposal time). Swap handlers accept `proposal.batches` only and never receive `preCommittedSlots` as a parameter — the type signature prevents accidental mutation. The handlers' signature looks like `flexMove(proposal: PlanProposal, intent: SwapIntent)` with no access to the pre-committed array. Display code reads both but never mutates either.

7. **Telegram display space for pre-committed slot markers.** Deferred to the separate copy session. For Plan 007 implementation, use the format `(from prior plan, N cal)` — verbose but explicit. The copy session will shorten it if screen-space becomes an issue; Plan 007 doesn't need to optimize for that.

8. **Strangler-fig naming choice.** Resolved in D24: rename old `Batch` → `LegacyBatch` in Phase 1 (5 importers, verified by grep), use `Batch` as the target name from day one. Phase 7b deletes `LegacyBatch`, no further renames needed.
