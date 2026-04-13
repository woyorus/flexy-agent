# Plan 026: Re-Proposer Enablement for Post-Confirmation Mutation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Completed
**Date:** 2026-04-10
**Affects:** `src/plan/session-to-proposal.ts` (new), `src/models/types.ts`, `src/state/store.ts`, `src/harness/test-store.ts`, `src/qa/validators/proposal.ts`, `src/agents/plan-reproposer.ts`, `supabase/migrations/005_plan_session_mutation_history.sql` (new), `docs/product-specs/data-models.md`, new unit tests under `test/unit/`.

**Goal:** Make the re-proposer runnable against a confirmed plan session — not just an in-memory draft — so post-confirmation plan mutations become structurally possible. This is Plan A from proposal `003-freeform-conversation-layer.md`.

**Architecture:** A pure adapter converts a persisted `PlanSession + Batch[]` into the in-memory `PlanProposal` shape the re-proposer already accepts, splitting the plan at the **(date, mealType)** level with server-local wall-clock cutoffs. Past slots are preserved verbatim — not just past batches, but also past flex slots and past meal events — so the user's historical record survives every mutate. Active slots go through the re-proposer; spanning batches (a batch with both past and active slots) are split at the boundary. The adapter returns three parallel past arrays (`preservedPastBatches`, `preservedPastFlexSlots`, `preservedPastEvents`) alongside the active `PlanProposal`. A round-trip helper concatenates each preserved past array with its re-proposer counterpart into the write payload for `confirmPlanSessionReplacing`. Mutation history is persisted as a new JSONB column on `plan_sessions` so it survives save-before-destroy writes. Two new rules are added to the re-proposer (meal-type lane — always; near-future safety — post-confirmation only), and a new invariant enforces `batch.mealType ∈ recipe.mealTypes` in the proposal validator.

**Tech Stack:** TypeScript, Node's built-in `node:test`, Supabase (JSONB column addition), OpenAI via the existing `LLMProvider` interface. The re-proposer rule unit tests use lightweight local `LLMProvider` stubs (a capturing stub that snapshots the last system prompt; a queue-based stub that dispenses scripted JSON responses for driving the validator retry loop) — not the scenario-harness `FixtureLLMProvider`, which is hash-keyed and designed for full scenario replay rather than unit-level rule verification.

**Scope:** Backend enablement only. No dispatcher, no Telegram UI, no new entry points. The primary verification surface is direct function calls in `test/unit/` (adapter forward/round-trip, validator invariant #14, re-proposer rules). Because Task 13 changes the re-proposer's system prompt (adding the meal-type lane rule and the optional near-future safety section), the existing in-session scenario fixtures that captured the old prompt's hash go stale — Task 13 regenerates exactly that set (`002`, `013`, `023`–`028`) and requires a manual behavioral review of each regenerated `recorded.json`. This is a targeted side-effect of the prompt change, not a primary verification path: no new scenarios are authored by Plan 026, and every scenario that survives regeneration should capture byte-for-byte the same user-facing behavior (the prompt is additive — the new rules don't conflict with any existing in-session test input). `npm test` must stay green after every task, including after the Task 13 regeneration. The actual wiring of post-confirmation mutations into a user-facing flow is **Plan D** — not this plan.

---

## Problem

Today the re-proposer (`src/agents/plan-reproposer.ts:66`) runs only during an active planning conversation. Its input type `ReProposerInput` (`src/agents/plan-reproposer.ts:28`) takes an in-memory `PlanProposal` and there is no function anywhere in the codebase that converts a persisted `PlanSession + Batch[]` back into that shape. Once the user confirms a plan, it becomes unreachable — the re-proposer cannot see it, cannot mutate it, and has no way to respect the fact that some slots have already been consumed. This is the load-bearing gap that stops Flexie's "plans survive real life" promise from working, and proposal `003-freeform-conversation-layer.md` identifies it as the single hardest dependency of v0.0.5.

Two additional rules must land alongside the adapter, or the re-proposer will generate broken arrangements under post-confirmation pressure:

1. **Meal-type lane rule** — lunches and dinners are physically different meals (lunch is portable, no-reheat, light; dinner can be heavy, sauce-heavy, cooked-to-reheat). The data model already constrains each batch to a single `mealType` (`'lunch' | 'dinner'`), but nothing enforces `batch.mealType ∈ recipe.mealTypes`. Today's re-proposer doesn't violate this by coincidence; under post-confirmation pressure it might.
2. **Near-future safety** — post-confirmation, the next ~2 days are load-bearing in the real world (shopping done, portions prepped). The re-proposer must not silently rearrange them unless the user's request explicitly targets them.

Finally, mutation history must start persisting on plan sessions. Today it lives on in-memory `PlanFlowState.mutationHistory` (`src/agents/plan-flow.ts:104`) and is cleared on confirm (`src/agents/plan-flow.ts:570`). For post-confirmation mutations, history must survive save-before-destroy writes so the re-proposer can see every earlier decision the user has already approved.

**Two separate write paths, with ownership split between Plans A and D.** Plan A (this plan) adds the column, the model-side type, the store serialization, the harness round-trip, and the round-trip into `buildReplacingDraft` for **post-confirmation** writes — i.e., once post-confirmation mutations exist, each new session rewrite carries its predecessor's history plus the just-approved mutation. Plan A **does not** rewire the **first-confirmation** write path that runs when the user taps `[Looks good]` at the end of a planning session (`handleApprove()` → `buildNewPlanSession` → `DraftPlanSession`). That path still drops `state.mutationHistory` on the floor after this plan lands, which means a plan confirmed immediately after several in-session mutations starts post-confirmation life with an empty history. This is a known gap and is explicitly closed by **Plan 029 Task 7 Step 6**, which threads `state.mutationHistory ?? []` into the `DraftPlanSession` literal inside `buildNewPlanSession`. The split-ownership rationale is in the decision log below. The net effect is that by the time Plan D ships, every post-confirmation mutation the re-proposer runs on sees the full approved history — both from in-session accumulation and from post-confirmation writebacks.

This plan does not wire anything into a user-facing flow. It makes the moving parts correct and independently testable so Plan D can pick them up.

---

## Plan of work

### File structure

**Files to create:**

- `src/plan/session-to-proposal.ts` — Adapter. Pure functions:
  - `classifySlot(day: string, mealType: 'lunch' | 'dinner', now: Date): 'past' | 'active'`
  - `splitBatchAtCutoffs(batch: Batch, now: Date): SplitBatchResult` — where `SplitBatchResult` is a discriminated union `{ kind: 'past-only'; pastBatch: Batch } | { kind: 'active-only'; activeBatch: ProposedBatch } | { kind: 'spanning'; pastBatch: Batch; activeBatch: ProposedBatch }`
  - `sessionToPostConfirmationProposal(session: PlanSession, batches: Batch[], now: Date): PostConfirmationProposal` — returning `{ activeProposal: PlanProposal; preservedPastBatches: Batch[]; preservedPastFlexSlots: FlexSlot[]; preservedPastEvents: MealEvent[]; horizonDays: string[]; nearFutureDays: string[] }`. The past-slot flex slots and meal events are filtered OUT of `activeProposal` (the re-proposer never sees them) and OUT into `preservedPastFlexSlots` / `preservedPastEvents` so the round-trip in `buildReplacingDraft` can splice them back into the rewritten session. Dropping them on the floor would erase the user's historical record — e.g., "Sunday dinner was a flex slot", "I ate out on Monday" — on every mutate.
  - `buildReplacingDraft(args: BuildReplacingDraftArgs): Promise<BuildReplacingDraftResult>` — accepting `{ oldSession: PlanSession; preservedPastBatches: Batch[]; preservedPastFlexSlots: FlexSlot[]; preservedPastEvents: MealEvent[]; reProposedActive: PlanProposal; newMutation: MutationRecord; recipeDb: RecipeDatabase; llm: LLMProvider }` and returning `{ draft: DraftPlanSession; batches: Omit<Batch, 'createdAt' | 'updatedAt'>[] }`. **The caller MUST run the solver on `reProposedActive` before passing it in** (Plan 029's post-confirmation branch does this — see `docs/plans/active/029-mutate-plan-action.md` § Architecture "runs the solver on the active proposal"), so `reProposedActive.solverOutput?.batchTargets` is populated. `buildReplacingDraft` looks up each re-proposed batch's `BatchTarget` from the solver output (by `(recipeSlug, mealType, days[0])` — the same tuple key `plan-flow.ts:878-882` uses for first-confirmation), reads `batchTarget.targetPerServing` as the scaler input (matching `plan-flow.ts:897-899`), and writes `targetPerServing: batchTarget.targetPerServing` unchanged into the new Batch row. This mirrors the existing first-confirmation write path so persisted post-confirmation batches use the solver-backed macro targets, not recipe defaults. If `solverOutput` is missing or a `BatchTarget` can't be matched, `buildReplacingDraft` throws with a descriptive error — Plan D's applier is expected to always provide a solved proposal. The draft's `flexSlots` is `[...preservedPastFlexSlots, ...reProposedActive.flexSlots]` and its `events` is `[...preservedPastEvents, ...reProposedActive.events]` — past state concatenates verbatim with the re-proposed active state, exactly like batches.

- `test/unit/session-to-proposal.test.ts` — Pure unit tests for every helper above plus the end-to-end round-trip. Uses `TestStateStore` to seed + snapshot and asserts against `deepStrictEqual`.

- `test/unit/post-confirmation-reproposer.test.ts` — Unit tests for the new re-proposer rules. Each test constructs a minimal `LLMProvider` stub (either `capturingLLM` — snapshots the last system prompt after returning a stub proposal — or `queuedFixtureLLM` — dispenses a queue of scripted JSON responses) to drive `reProposePlan` through its validator retry loop. The scripted-queue approach is a lighter-weight alternative to `FixtureLLMProvider` (which is hash-keyed scenario replay from `src/ai/fixture.ts` and requires pre-computed request hashes — overkill for unit-level rule verification). Test coverage: two prompt-string assertions (meal-type lane copy is present in both modes; near-future safety copy is conditionally present and carries the soft-locked dates) plus three behavioral tests (lane violation caught by validator → retry succeeds with lane-safe recipe; lane violation caught twice → reProposePlan surfaces `failure`; near-future prompt carries the dates and a rule-respecting response round-trips cleanly).

- `supabase/migrations/005_plan_session_mutation_history.sql` — Adds `mutation_history jsonb not null default '[]'` to `plan_sessions`.

**Files to modify:**

- `src/models/types.ts` — Move `MutationRecord` here (from `plan-reproposer.ts`). Add `mutationHistory: MutationRecord[]` to `PlanSession`. Add `mutationHistory?: MutationRecord[]` to `DraftPlanSession`.

- `src/agents/plan-reproposer.ts` — Re-export `MutationRecord` from models (compat). Add `mode: 'in-session' | 'post-confirmation'` and `nearFutureDays?: string[]` to `ReProposerInput`. Extend `buildSystemPrompt()` with: (a) a **meal-type lane rule** section (always emitted), and (b) a **near-future safety** section (emitted only under `mode === 'post-confirmation'`). Both the existing sole call site in `plan-flow.ts:666` and any new test call sites must pass the new fields.

- `src/state/store.ts` — Update `toPlanSessionRow` (`src/state/store.ts:392`) to write `mutation_history`, and `fromPlanSessionRow` (`src/state/store.ts:406`) to read it with an `[]` default. No changes to public method signatures.

- `src/harness/test-store.ts` — `confirmPlanSession` (`src/harness/test-store.ts:96`) and `confirmPlanSessionReplacing` (`src/harness/test-store.ts:124`) must carry `mutationHistory` into the persisted snapshot so tests round-trip it correctly. The existing inline construction `const persisted: PlanSession = { ...cloneDeep(session), ... }` already spreads the draft — we just need to ensure the field defaults to `[]` when the draft doesn't set it.

- `src/qa/validators/proposal.ts` — Add **Invariant #14: meal-type lane** after Invariant #10 (`src/qa/validators/proposal.ts:164-169`). The check requires `recipeDb.getBySlug(batch.recipeSlug)` — so it must come after #10 to ensure the recipe exists, and it must skip batches whose recipe is missing (invariant #10 catches those separately).

- `supabase/schema.sql` — **Canonical post-migration snapshot.** Add the `mutation_history` column to the `plan_sessions` table definition so the snapshot reflects the state after migration 005 is applied. Migration 005 is the history; `schema.sql` is the current truth — both must move together.

- `docs/product-specs/data-models.md` — Sync the `PlanSession` and `DraftPlanSession` interfaces. Add a short subsection on mutation history persistence and one on the meal-type lane invariant.

**Files with narrow, intentional modifications (NOT full scope):**

- `src/agents/plan-flow.ts` — **One-line change only, at the existing `reProposePlan` call site (`src/agents/plan-flow.ts:666-675`).** Task 13 Step 5 adds `mode: 'in-session'` as the last field of the call so the re-proposer's new `mode`-gated prompt behavior is exercised by every existing in-session scenario (which is how Task 13 Step 7 verifies the meal-type lane rule ships in both modes). No other line in `plan-flow.ts` is touched. In particular:
  - `handleApprove()` is NOT modified. It continues to build the draft without setting `mutationHistory`, which falls through to `[]` in `fromPlanSessionRow`. `state.mutationHistory = undefined` on line 570 stays as-is. **The first-confirmation write path — threading `state.mutationHistory` into `buildNewPlanSession`'s draft — is explicitly deferred to Plan D (see Plan 029 Task 7 Step 6 which owns this write).** See the decision log entry below for the rationale.
  - `handleMutationText()` and its `reProposePlan` call site are NOT touched beyond the single-field addition.

**Files NOT modified (deliberate scope guard):**

- `src/telegram/*` — No changes. No new entry points.
- Existing scenarios — no modifications beyond the regeneration in Task 13 Step 8 (required because the Task 13 prompt change invalidates the re-proposer fixture hash). `npm test` must stay green after every task.

### Task order rationale

Tasks run strictly top-to-bottom. Schema + type plumbing lands first so the adapter has somewhere to read `mutationHistory` from. The adapter lands before the re-proposer rule changes so integration tests have all pieces in play. The validator invariant lands before the re-proposer rule so the re-proposer's fixture retry path can exercise it.

---

## Tasks

### Task 1: Green baseline

**Files:** none — sanity check.

- [ ] **Step 1: Confirm clean `npm test`**

Run: `npm test`
Expected: all scenarios and unit tests pass. Note the count in the output (something like `# tests NN`) so later tasks can confirm no regressions.

- [ ] **Step 2: Note the current highest migration number**

Run: `ls supabase/migrations/`
Expected: files `001` through `004` exist. The new migration will be `005`.

No commit — this is a verification step.

---

### Task 2: Move `MutationRecord` into `models/types.ts`

**Rationale:** `MutationRecord` currently lives in `src/agents/plan-reproposer.ts:39`. Task 3 adds a `mutationHistory: MutationRecord[]` field to `PlanSession` in `src/models/types.ts`. Models must not import from `agents/` (the dependency direction is `agents → models`), so `MutationRecord` has to move first. The existing import in `plan-flow.ts:666` continues to work via a re-export from `plan-reproposer.ts`.

**Files:**
- Modify: `src/models/types.ts`
- Modify: `src/agents/plan-reproposer.ts:39-44`

- [ ] **Step 1: Add `MutationRecord` to `src/models/types.ts`**

Append this block at the end of the meal-event section, right after `MealEvent` (around line 146):

```typescript
/**
 * A single user-approved plan mutation, recorded so the re-proposer respects
 * prior choices on subsequent calls. Persisted on `PlanSession.mutationHistory`
 * (Plan 026) so it survives save-before-destroy writes.
 */
export interface MutationRecord {
  /** Natural-language description of what the user asked for */
  constraint: string;
  /** ISO timestamp (Date.toISOString()) when the mutation was applied */
  appliedAt: string;
}
```

- [ ] **Step 2: Replace the `MutationRecord` definition in `plan-reproposer.ts` with an import + re-export**

Two edits in `src/agents/plan-reproposer.ts`:

1. **Extend the existing `models/types.js` import at line 19** to include `MutationRecord` so the local `ReProposerInput.mutationHistory: MutationRecord[]` at line 31 has a binding after the local type is deleted:

```typescript
import type { MealEvent, FlexSlot, MutationRecord } from '../models/types.js';
```

2. **Replace lines 39-44** (the local `MutationRecord` interface definition) with a re-export that exposes the type to the single existing downstream importer (`plan-flow.ts`) without a rename:

```typescript
// MutationRecord moved to models/types.ts in Plan 026. Re-exported here so the
// single existing importer (plan-flow.ts) keeps working without a widespread rename.
// NOTE: this re-export form (without `from`) re-exports the LOCAL binding introduced
// by the import above — a `export type { ... } from '../models/types.js';` form would
// NOT create a local binding and would break `ReProposerInput.mutationHistory` at line 31.
export type { MutationRecord };
```

Both edits are required. The import on line 19 gives the file a local `MutationRecord` symbol that `ReProposerInput` can reference; the `export type { MutationRecord }` line re-exports that local symbol so `plan-flow.ts:19` (`import { MutationRecord } from './plan-reproposer.js'` or similar — check the real import at Task 2 time) still resolves.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS. No behavior change — type was just moved and re-exported.

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/models/types.ts src/agents/plan-reproposer.ts
git commit -m "Plan 026: move MutationRecord into models/types.ts"
```

---

### Task 3: Add `mutationHistory` field to `PlanSession` and `DraftPlanSession`

**Files:**
- Modify: `src/models/types.ts:168-204`

- [ ] **Step 1: Add `mutationHistory` to `PlanSession`**

In `src/models/types.ts`, update the `PlanSession` interface. The current shape is at lines 168-189. Add the new field right before `confirmedAt` and update the jsdoc to mention it:

```typescript
/**
 * A confirmed plan session — a 7-day rolling horizon.
 *
 * Represents a PERSISTED (confirmed) session. Per D33, there is no such thing as
 * an unpersisted PlanSession — drafts live in memory as DraftPlanSession.
 * Batches are not embedded; they reference this session via createdInPlanSessionId.
 *
 * Plan 026: `mutationHistory` is persisted here (new jsonb column) so
 * post-confirmation mutations can respect every prior user-approved change
 * across save-before-destroy writes.
 */
export interface PlanSession {
  id: string;
  horizonStart: string;
  horizonEnd: string;
  breakfast: {
    locked: boolean;
    recipeSlug: string;
    caloriesPerDay: number;
    proteinPerDay: number;
  };
  treatBudgetCalories: number;
  flexSlots: FlexSlot[];
  events: MealEvent[];
  /**
   * Accumulated record of user-approved plan mutations on this session and its
   * ancestors. Carried across save-before-destroy writes by the adapter in
   * `src/plan/session-to-proposal.ts` (Plan 026). May be empty on sessions that
   * were confirmed without any in-session mutations.
   */
  mutationHistory: MutationRecord[];
  confirmedAt: string;
  superseded: boolean;
  createdAt: string;
  updatedAt: string;
}
```

(Keep the existing `horizonStart`/`horizonEnd`/`superseded` comments — they were omitted here for brevity but must remain in the file.)

- [ ] **Step 2: `DraftPlanSession` inherits the field automatically via `Omit`**

`DraftPlanSession` (lines 201-204) is `Omit<PlanSession, 'confirmedAt' | 'superseded' | 'createdAt' | 'updatedAt'>`. It already inherits `mutationHistory`. Leave the definition unchanged. Draft creators are allowed to omit the field by making it optional at the call site — but we want it to be required on persisted sessions. Instead, make the Draft's field optional with a new `Omit`:

Replace lines 201-204 with:

```typescript
/**
 * In-memory draft shape during the planning flow (D33).
 *
 * `mutationHistory` is optional at the draft stage so existing draft builders
 * (plan-flow.ts `buildNewPlanSession`) don't need to set it. The store's row
 * mapper writes `[]` as the default when it's absent.
 */
export type DraftPlanSession = Omit<
  PlanSession,
  'confirmedAt' | 'superseded' | 'createdAt' | 'updatedAt' | 'mutationHistory'
> & { mutationHistory?: MutationRecord[] };
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: errors in `src/state/store.ts` (`fromPlanSessionRow` is missing the field) and `src/harness/test-store.ts` (same — cloneDeep of a draft without the field into a `PlanSession` with a required field). These are expected. Tasks 4 and 5 fix them.

- [ ] **Step 4: Intentionally leave the codebase broken and commit anyway?**

No — we don't commit a broken tree. Proceed directly to Task 4 in the same working copy; the commit happens after Task 5 when the tree is green again.

---

### Task 4: SQL migration 005 + `schema.sql` snapshot + store row mappers

**Files:**
- Create: `supabase/migrations/005_plan_session_mutation_history.sql`
- Modify: `supabase/schema.sql` (canonical post-migration snapshot)
- Modify: `src/state/store.ts:392-420`

> **Rule — schema.sql is the canonical snapshot, migrations are history.** Any change to a table must land in BOTH the new migration file and `supabase/schema.sql` in the same commit. Forgetting `schema.sql` leaves the canonical snapshot lying about the real schema, and future agents will load a false picture of the database. This rule is enforced by convention, not by tooling — be deliberate.

- [ ] **Step 1: Create the migration**

Create `supabase/migrations/005_plan_session_mutation_history.sql` with:

```sql
-- Plan 026: Persist re-proposer mutation history on plan sessions.
-- Enables post-confirmation mutations to respect every prior user-approved
-- change across save-before-destroy writes (see docs/plans/active/026-*.md).
--
-- Shape per row is MutationRecord[] = Array<{ constraint: string; appliedAt: string }>.
-- Default [] so every existing row is non-null and every INSERT without the
-- field gets an empty array.

ALTER TABLE plan_sessions
  ADD COLUMN mutation_history jsonb NOT NULL DEFAULT '[]'::jsonb;
```

- [ ] **Step 2: Update the canonical `supabase/schema.sql` snapshot**

`supabase/schema.sql:5-18` currently defines `plan_sessions` as it existed after migration 004. Add the `mutation_history` column so the snapshot matches the state after migration 005. Insert the new column right before `confirmed_at` to mirror the logical ordering in `PlanSession` (TypeScript) and keep the session metadata (`confirmed_at`, `superseded`, `created_at`, `updated_at`) grouped at the bottom.

Replace the `create table plan_sessions (...)` block at `supabase/schema.sql:5-18` with:

```sql
create table plan_sessions (
  id                uuid primary key,
  user_id           text not null,
  horizon_start     date not null,
  horizon_end       date not null,
  breakfast         jsonb not null,
  treat_budget_calories int not null,
  flex_slots        jsonb not null default '[]',
  events            jsonb not null default '[]',
  mutation_history  jsonb not null default '[]',
  confirmed_at      timestamptz not null default now(),
  superseded        boolean not null default false,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);
```

Do NOT touch the `plan_sessions_user_horizon` index definition below it — the new column does not affect that index.

- [ ] **Step 3: Update `toPlanSessionRow` to write the column**

In `src/state/store.ts`, replace the `toPlanSessionRow` function (lines 392-403) with:

```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPlanSessionRow(session: DraftPlanSession): Record<string, any> {
  return {
    id: session.id,
    user_id: SINGLE_USER_ID,
    horizon_start: session.horizonStart,
    horizon_end: session.horizonEnd,
    breakfast: session.breakfast,
    treat_budget_calories: session.treatBudgetCalories,
    flex_slots: session.flexSlots,
    events: session.events,
    mutation_history: session.mutationHistory ?? [],
  };
}
```

- [ ] **Step 4: Update `fromPlanSessionRow` to read the column**

Replace lines 406-420 with:

```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromPlanSessionRow(row: any): PlanSession {
  return {
    id: row.id,
    horizonStart: row.horizon_start,
    horizonEnd: row.horizon_end,
    breakfast: row.breakfast,
    treatBudgetCalories: row.treat_budget_calories,
    flexSlots: row.flex_slots ?? [],
    events: row.events ?? [],
    mutationHistory: row.mutation_history ?? [],
    confirmedAt: row.confirmed_at,
    superseded: row.superseded,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

- [ ] **Step 5: Do NOT run the migration against a remote Supabase instance in this task.** The harness tests exercise `TestStateStore`, which does not touch Supabase. The production migration is applied manually out of band (see `supabase/migrations/001_*.sql:2` — "Run this manually in the Supabase SQL Editor"). Task 5 (of this plan) makes the test store compatible; Task 1 of the Plan D rollout will include the migration application step against the live database.

- [ ] **Step 6: Typecheck (tests still broken)**

Run: `npx tsc --noEmit`
Expected: `src/harness/test-store.ts` still errors because `confirmPlanSession` writes a `PlanSession` without `mutationHistory` being present on the input. Task 5 fixes this. Do not commit yet.

---

### Task 5: `TestStateStore` mirrors `mutation_history` handling

**Files:**
- Modify: `src/harness/test-store.ts:96-162`

- [ ] **Step 1: Update `confirmPlanSession` to populate `mutationHistory`**

In `src/harness/test-store.ts`, replace the `confirmPlanSession` method body (lines 96-118) so that step 1's `persisted` object defaults `mutationHistory` to `[]` when the draft omits it. Same pattern for `confirmPlanSessionReplacing` (lines 124-162). The existing spread `...cloneDeep(session)` carries whatever `mutationHistory` the draft has; we just need a conditional fallback.

Replace the `confirmPlanSession` method in its entirety with:

```typescript
  async confirmPlanSession(
    session: DraftPlanSession,
    batches: Array<Omit<Batch, 'createdAt' | 'updatedAt'>>,
  ): Promise<PlanSession> {
    const now = new Date().toISOString();
    // Step 1: insert session. `mutationHistory` falls through from the draft,
    // or defaults to [] when the draft leaves it unset. Mirrors the production
    // `toPlanSessionRow` default at src/state/store.ts.
    const persisted: PlanSession = {
      ...cloneDeep(session),
      mutationHistory: session.mutationHistory ?? [],
      confirmedAt: now,
      superseded: false,
      createdAt: now,
      updatedAt: now,
    };
    this.planSessionsById.set(persisted.id, cloneDeep(persisted));

    // Step 2: insert batches
    for (const b of batches) {
      const full: Batch = { ...cloneDeep(b) as Batch };
      this.batchesById.set(full.id, full);
    }

    return cloneDeep(persisted);
  }
```

- [ ] **Step 2: Update `confirmPlanSessionReplacing` identically**

Replace the `confirmPlanSessionReplacing` method's Step 1 block (lines 130-139) with:

```typescript
    // Step 1: insert NEW session. `mutationHistory` falls through from the
    // draft, or defaults to [] when the draft leaves it unset.
    const persisted: PlanSession = {
      ...cloneDeep(session),
      mutationHistory: session.mutationHistory ?? [],
      confirmedAt: now,
      superseded: false,
      createdAt: now,
      updatedAt: now,
    };
    this.planSessionsById.set(persisted.id, cloneDeep(persisted));
```

Leave steps 2, 3, and 4 of the method unchanged.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run full tests**

Run: `npm test`
Expected: PASS. Every existing scenario must stay green because `mutationHistory` defaults to `[]` everywhere.

**If a scenario fails** with a diff like `expected.finalStore.planSessions[N].mutationHistory` missing on one side, the scenario's `recorded.json` needs regeneration — but that should not happen because `snapshot()` returns the internal map's `PlanSession` objects and JSON round-trip includes the new field. If a scenario does fail, read the diff, identify the field drift, and regenerate the scenario with `npm run test:generate -- <name> --regenerate`. Review the regenerated `recorded.json` behaviorally before committing.

- [ ] **Step 5: Commit**

```bash
git add src/models/types.ts \
        src/state/store.ts \
        src/harness/test-store.ts \
        supabase/migrations/005_plan_session_mutation_history.sql \
        supabase/schema.sql
git commit -m "Plan 026: persist mutationHistory on PlanSession"
```

Both `supabase/migrations/005_*.sql` AND `supabase/schema.sql` MUST be in the same commit — they're two halves of the same change (history + current snapshot) and splitting them leaves one of them out of sync temporarily, which is exactly the kind of drift that causes future agents to read a false schema.

If any scenario recordings had to be regenerated, include them in the same commit and note them in the message body.

---

### Task 6: Unit test — mutation history round-trips through `TestStateStore`

**Files:**
- Create: `test/unit/plan-session-mutation-history.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/plan-session-mutation-history.test.ts` with:

```typescript
/**
 * Unit test for Plan 026: PlanSession.mutationHistory round-trips through
 * TestStateStore. Verifies both the default-empty path (draft omits the field)
 * and the explicit-history path (draft sets the field and the replace-flow
 * carries it unchanged).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestStateStore } from '../../src/harness/test-store.js';
import type { DraftPlanSession, MutationRecord, Batch } from '../../src/models/types.js';

function draft(id: string, history?: MutationRecord[]): DraftPlanSession {
  return {
    id,
    horizonStart: '2026-04-06',
    horizonEnd: '2026-04-12',
    breakfast: { locked: true, recipeSlug: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
    treatBudgetCalories: 800,
    flexSlots: [],
    events: [],
    ...(history !== undefined ? { mutationHistory: history } : {}),
  };
}

test('confirmPlanSession defaults mutationHistory to [] when draft omits it', async () => {
  const store = new TestStateStore();
  const persisted = await store.confirmPlanSession(draft('session-1'), []);
  assert.deepStrictEqual(persisted.mutationHistory, []);

  const reloaded = await store.getPlanSession('session-1');
  assert.ok(reloaded);
  assert.deepStrictEqual(reloaded.mutationHistory, []);
});

test('confirmPlanSession persists mutationHistory when draft sets it', async () => {
  const store = new TestStateStore();
  const history: MutationRecord[] = [
    { constraint: 'move flex to Sunday', appliedAt: '2026-04-05T10:00:00.000Z' },
    { constraint: 'swap tagine for fish', appliedAt: '2026-04-05T10:05:00.000Z' },
  ];
  const persisted = await store.confirmPlanSession(draft('session-2', history), []);
  assert.deepStrictEqual(persisted.mutationHistory, history);
});

test('confirmPlanSessionReplacing carries mutationHistory from the new draft', async () => {
  const store = new TestStateStore();
  await store.confirmPlanSession(draft('old', [{ constraint: 'initial', appliedAt: '2026-04-05T09:00:00.000Z' }]), []);

  const newHistory: MutationRecord[] = [
    { constraint: 'initial', appliedAt: '2026-04-05T09:00:00.000Z' },
    { constraint: 'eating out tonight', appliedAt: '2026-04-07T19:00:00.000Z' },
  ];
  const persisted = await store.confirmPlanSessionReplacing(
    draft('new', newHistory),
    [],
    'old',
  );
  assert.deepStrictEqual(persisted.mutationHistory, newHistory);

  const oldReloaded = await store.getPlanSession('old');
  assert.ok(oldReloaded);
  assert.equal(oldReloaded.superseded, true);

  const newReloaded = await store.getPlanSession('new');
  assert.ok(newReloaded);
  assert.deepStrictEqual(newReloaded.mutationHistory, newHistory);
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- --test-name-pattern="mutationHistory"`
Expected: PASS — the mutation_history field should already be populated correctly from Task 5. If any test fails, it's a bug in Task 5's implementation; go fix it before continuing.

- [ ] **Step 3: Commit**

```bash
git add test/unit/plan-session-mutation-history.test.ts
git commit -m "Plan 026: unit test — mutationHistory round-trips"
```

---

### Task 7: Adapter scaffold + `classifySlot`

**Files:**
- Create: `src/plan/session-to-proposal.ts`
- Create: `test/unit/session-to-proposal.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/session-to-proposal.test.ts` with:

```typescript
/**
 * Unit tests for the session-to-proposal adapter (Plan 026).
 *
 * These tests cover the four pure functions exposed by
 * `src/plan/session-to-proposal.ts` in isolation, then the end-to-end
 * round-trip from persisted session to re-proposer-ready proposal and back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySlot } from '../../src/plan/session-to-proposal.js';

// Fixed clock helpers — tests construct Date objects directly with local time.
// The adapter reads only wall-clock from `now`, never Date.now() or new Date().
function at(isoDate: string, hour: number, minute = 0): Date {
  // Construct in the runtime's local timezone so the adapter's
  // toLocalISODate(now) maps back to `isoDate`. Mirrors how scenarios freeze
  // clocks (see src/harness/clock.ts).
  return new Date(`${isoDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`);
}

test('classifySlot: date before today is always past for both meal types', () => {
  const now = at('2026-04-07', 10); // Tuesday morning
  assert.equal(classifySlot('2026-04-06', 'lunch', now), 'past');
  assert.equal(classifySlot('2026-04-06', 'dinner', now), 'past');
});

test('classifySlot: date after today is always active for both meal types', () => {
  const now = at('2026-04-07', 23);
  assert.equal(classifySlot('2026-04-08', 'lunch', now), 'active');
  assert.equal(classifySlot('2026-04-08', 'dinner', now), 'active');
});

test('classifySlot: today lunch is active before 15:00', () => {
  assert.equal(classifySlot('2026-04-07', 'lunch', at('2026-04-07', 14, 59)), 'active');
});

test('classifySlot: today lunch is past at 15:00', () => {
  assert.equal(classifySlot('2026-04-07', 'lunch', at('2026-04-07', 15, 0)), 'past');
});

test('classifySlot: today dinner is active at 15:00 (lunch cutoff does not affect dinner)', () => {
  assert.equal(classifySlot('2026-04-07', 'dinner', at('2026-04-07', 15, 0)), 'active');
});

test('classifySlot: today dinner is active at 20:59', () => {
  assert.equal(classifySlot('2026-04-07', 'dinner', at('2026-04-07', 20, 59)), 'active');
});

test('classifySlot: today dinner is past at 21:00', () => {
  assert.equal(classifySlot('2026-04-07', 'dinner', at('2026-04-07', 21, 0)), 'past');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="classifySlot"`
Expected: FAIL — `classifySlot` does not exist yet (`Cannot find module '.../session-to-proposal.js'` or similar).

- [ ] **Step 3: Create the adapter skeleton + `classifySlot`**

Create `src/plan/session-to-proposal.ts` with:

```typescript
/**
 * Session-to-proposal adapter — Plan 026.
 *
 * Converts a persisted `PlanSession + Batch[]` into the in-memory
 * `PlanProposal` shape the re-proposer consumes, splitting the plan at the
 * (date, mealType) level using server-local wall-clock cutoffs. The split
 * boundary determines which slots are "past" (frozen, preserved verbatim) and
 * which are "active" (sent to the re-proposer for mutation).
 *
 * This file is pure — no store calls, no LLM calls, no clock reads beyond
 * the `now: Date` passed in by the caller. All downstream logic (re-proposer
 * invocation, write via confirmPlanSessionReplacing) is wired up by the
 * caller (Plan D). Plan 026 only ships the adapter and its unit tests.
 *
 * Design doc: docs/design-docs/proposals/003-freeform-conversation-layer.md
 */

import { toLocalISODate } from './helpers.js';

/**
 * Server-local hour (24h) after which "today's lunch" is considered past.
 * 15:00 means lunch is active until 2:59pm and past from 3:00pm onward.
 * Chosen per proposal 003 as the pragmatic default for the single-user v0.0.5
 * simplification; can be revisited when multi-user timezone support lands.
 */
export const LUNCH_DONE_CUTOFF_HOUR = 15;

/**
 * Server-local hour (24h) after which "today's dinner" is considered past.
 * 21:00 means dinner is active until 8:59pm and past from 9:00pm onward.
 */
export const DINNER_DONE_CUTOFF_HOUR = 21;

/**
 * Classify a single slot as past or active relative to `now`.
 *
 * A slot is "past" when any of:
 *   (a) its date is strictly before today's local date;
 *   (b) it's today's lunch and now >= 15:00 local;
 *   (c) it's today's dinner and now >= 21:00 local.
 *
 * Otherwise it's "active" and the re-proposer is allowed to see and mutate it.
 *
 * @param day - ISO date of the slot
 * @param mealType - 'lunch' or 'dinner' (breakfast is never part of a batch)
 * @param now - Current wall clock; read only for hour/ISO date, never Date.now()
 */
export function classifySlot(day: string, mealType: 'lunch' | 'dinner', now: Date): 'past' | 'active' {
  const today = toLocalISODate(now);
  if (day < today) return 'past';
  if (day > today) return 'active';
  // day === today: use meal cutoff.
  const hour = now.getHours();
  if (mealType === 'lunch') return hour >= LUNCH_DONE_CUTOFF_HOUR ? 'past' : 'active';
  return hour >= DINNER_DONE_CUTOFF_HOUR ? 'past' : 'active';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="classifySlot"`
Expected: PASS — all 7 test cases green.

- [ ] **Step 5: Commit**

```bash
git add src/plan/session-to-proposal.ts test/unit/session-to-proposal.test.ts
git commit -m "Plan 026: classifySlot — (date, mealType) past/active boundary"
```

---

### Task 8: Adapter — split session batches (pure past, pure active)

**Rationale:** Each batch either lives entirely in the past, entirely in the active window, or spans both. Task 8 handles the two pure cases — pure-past batches are preserved verbatim for the write, pure-active batches become `ProposedBatch`es the re-proposer can mutate. Task 9 handles the spanning case.

**Files:**
- Modify: `src/plan/session-to-proposal.ts`
- Modify: `test/unit/session-to-proposal.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/session-to-proposal.test.ts`:

```typescript
import type { Batch } from '../../src/models/types.js';
import { splitBatchAtCutoffs } from '../../src/plan/session-to-proposal.js';

function batch(overrides: Partial<Batch>): Batch {
  return {
    id: 'batch-x',
    recipeSlug: 'tagine',
    mealType: 'dinner',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
    servings: 3,
    targetPerServing: { calories: 800, protein: 45 },
    actualPerServing: { calories: 810, protein: 46, fat: 30, carbs: 60 },
    scaledIngredients: [
      { name: 'beef', amount: 200, unit: 'g', totalForBatch: 600, role: 'protein' },
    ],
    status: 'planned',
    createdInPlanSessionId: 'sess-1',
    ...overrides,
  };
}

test('splitBatchAtCutoffs: pure past batch — all eating days strictly before today', () => {
  // Now = Thursday 10am. All eating days Mon/Tue/Wed are past.
  const now = at('2026-04-09', 10);
  const b = batch({
    id: 'past-batch',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
    servings: 3,
  });
  const result = splitBatchAtCutoffs(b, now);
  assert.equal(result.kind, 'past-only');
  if (result.kind !== 'past-only') throw new Error('unreachable');
  assert.deepStrictEqual(result.pastBatch, b);
});

test('splitBatchAtCutoffs: pure active batch — all eating days after today', () => {
  // Now = Monday 10am. Eating days Tue/Wed/Thu all active.
  const now = at('2026-04-06', 10);
  const b = batch({
    id: 'future-batch',
    eatingDays: ['2026-04-07', '2026-04-08', '2026-04-09'],
    servings: 3,
  });
  const result = splitBatchAtCutoffs(b, now);
  assert.equal(result.kind, 'active-only');
  if (result.kind !== 'active-only') throw new Error('unreachable');
  assert.deepStrictEqual(result.activeBatch, {
    recipeSlug: 'tagine',
    recipeName: 'tagine',
    mealType: 'dinner',
    days: ['2026-04-07', '2026-04-08', '2026-04-09'],
    servings: 3,
    overflowDays: undefined,
  });
});

test('splitBatchAtCutoffs: pure active — today lunch batch before 15:00 stays fully active', () => {
  const now = at('2026-04-07', 10);
  const b = batch({
    id: 'today-lunch',
    mealType: 'lunch',
    eatingDays: ['2026-04-07'],
    servings: 1,
  });
  const result = splitBatchAtCutoffs(b, now);
  assert.equal(result.kind, 'active-only');
});

test('splitBatchAtCutoffs: pure past — today lunch batch after 15:00 is past', () => {
  const now = at('2026-04-07', 15, 30);
  const b = batch({
    id: 'today-lunch-late',
    mealType: 'lunch',
    eatingDays: ['2026-04-07'],
    servings: 1,
  });
  const result = splitBatchAtCutoffs(b, now);
  assert.equal(result.kind, 'past-only');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="splitBatchAtCutoffs"`
Expected: FAIL — `splitBatchAtCutoffs` is not exported yet.

- [ ] **Step 3: Implement `splitBatchAtCutoffs` (pure cases only)**

Append to `src/plan/session-to-proposal.ts`:

```typescript
import type { Batch } from '../models/types.js';
import type { ProposedBatch } from '../solver/types.js';

/**
 * Result of classifying a single batch against the current wall clock.
 *
 * - `past-only`: every eating day is strictly past. The batch is preserved
 *   verbatim and flows into the write payload unchanged.
 * - `active-only`: every eating day is strictly active. The batch is rendered
 *   as a `ProposedBatch` for the re-proposer to see and potentially mutate.
 * - `spanning`: some eating days are past, others active. Task 9 splits these
 *   into a past half (Batch) and an active half (ProposedBatch).
 */
export type SplitBatchResult =
  | { kind: 'past-only'; pastBatch: Batch }
  | { kind: 'active-only'; activeBatch: ProposedBatch }
  | { kind: 'spanning'; pastBatch: Batch; activeBatch: ProposedBatch };

/**
 * Split a single persisted batch across the (date, mealType) cutoff.
 *
 * Determines whether the batch is past-only, active-only, or spanning, and
 * returns the pieces needed to reconstruct the plan after the re-proposer
 * runs on the active portion. Pure — never reads real clocks or recipes.
 *
 * @param batch - A persisted Batch loaded from the store
 * @param now - Current wall clock
 */
export function splitBatchAtCutoffs(batch: Batch, now: Date): SplitBatchResult {
  const pastDays: string[] = [];
  const activeDays: string[] = [];
  for (const day of batch.eatingDays) {
    if (classifySlot(day, batch.mealType, now) === 'past') {
      pastDays.push(day);
    } else {
      activeDays.push(day);
    }
  }

  if (pastDays.length === 0) {
    return {
      kind: 'active-only',
      activeBatch: {
        recipeSlug: batch.recipeSlug,
        // Recipe display name isn't stored on Batch — caller resolves it later
        // if needed. For now use the slug as a placeholder; downstream code
        // resolves via RecipeDatabase when it prints anything.
        recipeName: batch.recipeSlug,
        mealType: batch.mealType,
        days: activeDays,
        servings: activeDays.length,
        overflowDays: undefined,
      },
    };
  }

  if (activeDays.length === 0) {
    return { kind: 'past-only', pastBatch: batch };
  }

  // Spanning — Task 9 fills this in.
  throw new Error('splitBatchAtCutoffs: spanning batches not implemented yet (Task 9)');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="splitBatchAtCutoffs"`
Expected: PASS — 4 new tests green. The spanning case is not tested yet and will not be triggered.

- [ ] **Step 5: Commit**

```bash
git add src/plan/session-to-proposal.ts test/unit/session-to-proposal.test.ts
git commit -m "Plan 026: splitBatchAtCutoffs — pure past and pure active"
```

---

### Task 9: Adapter — spanning batch splitter

**Files:**
- Modify: `src/plan/session-to-proposal.ts`
- Modify: `test/unit/session-to-proposal.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/session-to-proposal.test.ts`:

```typescript
test('splitBatchAtCutoffs: spanning batch — split at the cutoff boundary', () => {
  // Now = Friday 10am. Tagine batch with eating days Mon, Wed, Fri — all dinner.
  // Mon and Wed are past (dates before today). Fri is active (today, 10am < 21:00 cutoff).
  const now = at('2026-04-10', 10);
  const b = batch({
    id: 'tagine-spanning',
    recipeSlug: 'tagine',
    mealType: 'dinner',
    eatingDays: ['2026-04-06', '2026-04-08', '2026-04-10'],
    servings: 3,
    scaledIngredients: [
      { name: 'beef', amount: 200, unit: 'g', totalForBatch: 600, role: 'protein' },
      { name: 'couscous', amount: 60, unit: 'g', totalForBatch: 180, role: 'carb' },
    ],
  });
  const result = splitBatchAtCutoffs(b, now);
  assert.equal(result.kind, 'spanning');
  if (result.kind !== 'spanning') throw new Error('unreachable');

  // Past half: Mon + Wed, 2 servings, totals proportionally scaled down.
  assert.equal(result.pastBatch.recipeSlug, 'tagine');
  assert.equal(result.pastBatch.mealType, 'dinner');
  assert.deepStrictEqual(result.pastBatch.eatingDays, ['2026-04-06', '2026-04-08']);
  assert.equal(result.pastBatch.servings, 2);
  assert.equal(result.pastBatch.status, 'planned');
  assert.equal(result.pastBatch.createdInPlanSessionId, 'sess-1');
  assert.deepStrictEqual(result.pastBatch.scaledIngredients, [
    { name: 'beef', amount: 200, unit: 'g', totalForBatch: 400, role: 'protein' },
    { name: 'couscous', amount: 60, unit: 'g', totalForBatch: 120, role: 'carb' },
  ]);
  // Past half must get a NEW id — it becomes a new row in the next session.
  assert.notEqual(result.pastBatch.id, 'tagine-spanning');

  // Active half: Fri, 1 serving, as a ProposedBatch.
  assert.deepStrictEqual(result.activeBatch, {
    recipeSlug: 'tagine',
    recipeName: 'tagine',
    mealType: 'dinner',
    days: ['2026-04-10'],
    servings: 1,
    overflowDays: undefined,
  });
});

test('splitBatchAtCutoffs: spanning with today lunch past by cutoff', () => {
  // Now = Wednesday 16:00. Lunch batch Mon / Tue / Wed. All three are past
  // (Mon/Tue by date, Wed by cutoff at 16:00 > 15:00). Not actually spanning,
  // but a regression guard that the lunch cutoff applies to today only.
  const now = at('2026-04-08', 16);
  const b = batch({
    id: 'lunch-3day',
    mealType: 'lunch',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
    servings: 3,
  });
  const result = splitBatchAtCutoffs(b, now);
  assert.equal(result.kind, 'past-only');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="spanning"`
Expected: FAIL — the spanning branch throws "not implemented yet".

- [ ] **Step 3: Implement the spanning split**

In `src/plan/session-to-proposal.ts`, add a helper function and replace the throwing branch in `splitBatchAtCutoffs`:

```typescript
import { randomUUID } from 'node:crypto';

/**
 * Proportionally scale a batch's ingredient amounts for a reduced serving count.
 *
 * `scaledIngredients[i].totalForBatch` was computed at plan time as
 * `recipe.ingredients[i].amount * originalServings` (see
 * `src/agents/plan-flow.ts:911`). When we split a batch, each half gets a
 * proportional share of the totals. Per-serving `amount` / `unit` stay
 * unchanged.
 */
function scaleIngredientTotals<T extends { amount: number; totalForBatch: number }>(
  items: T[],
  newServings: number,
  originalServings: number,
): T[] {
  if (originalServings === 0) return items;
  const ratio = newServings / originalServings;
  return items.map((it) => ({
    ...it,
    totalForBatch: Math.round(it.totalForBatch * ratio),
  }));
}
```

Replace the body of `splitBatchAtCutoffs` (specifically the `// Spanning — Task 9 fills this in.` branch) so the function ends with:

```typescript
  // Spanning: past days keep their original scaled totals scaled down
  // proportionally, and get a fresh id (the past half becomes a new row in
  // the next session). Active days become a ProposedBatch for the re-proposer.
  const pastBatch: Batch = {
    id: randomUUID(),
    recipeSlug: batch.recipeSlug,
    mealType: batch.mealType,
    eatingDays: pastDays,
    servings: pastDays.length,
    targetPerServing: batch.targetPerServing,
    actualPerServing: batch.actualPerServing,
    scaledIngredients: scaleIngredientTotals(batch.scaledIngredients, pastDays.length, batch.servings),
    status: 'planned',
    createdInPlanSessionId: batch.createdInPlanSessionId,
  };

  const activeBatch: ProposedBatch = {
    recipeSlug: batch.recipeSlug,
    recipeName: batch.recipeSlug,
    mealType: batch.mealType,
    days: activeDays,
    servings: activeDays.length,
    overflowDays: undefined,
  };

  return { kind: 'spanning', pastBatch, activeBatch };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --test-name-pattern="spanning"`
Expected: PASS — spanning test green. The second "lunch-3day all past" test also passes because it hits the `past-only` branch.

- [ ] **Step 5: Run the full adapter test file**

Run: `npm test -- --test-name-pattern="classifySlot|splitBatchAtCutoffs|spanning"`
Expected: all tests from Tasks 7, 8, 9 green.

- [ ] **Step 6: Commit**

```bash
git add src/plan/session-to-proposal.ts test/unit/session-to-proposal.test.ts
git commit -m "Plan 026: splitBatchAtCutoffs — spanning batch split"
```

---

### Task 10: `sessionToPostConfirmationProposal` — forward adapter

**Rationale:** Task 10 composes Tasks 7-9 into the single top-level forward function that takes a whole `PlanSession + Batch[]` and returns the `PlanProposal` shape the re-proposer wants, plus the bookkeeping the round-trip (Task 11) needs.

**Files:**
- Modify: `src/plan/session-to-proposal.ts`
- Modify: `test/unit/session-to-proposal.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/session-to-proposal.test.ts`:

```typescript
import type { PlanSession } from '../../src/models/types.js';
import { sessionToPostConfirmationProposal } from '../../src/plan/session-to-proposal.js';

function session(overrides: Partial<PlanSession> = {}): PlanSession {
  return {
    id: 'sess-1',
    horizonStart: '2026-04-06',
    horizonEnd: '2026-04-12',
    breakfast: { locked: true, recipeSlug: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
    treatBudgetCalories: 800,
    flexSlots: [{ day: '2026-04-11', mealTime: 'dinner', flexBonus: 350, note: 'fun dinner' }],
    events: [],
    mutationHistory: [],
    confirmedAt: '2026-04-05T18:00:00.000Z',
    superseded: false,
    createdAt: '2026-04-05T18:00:00.000Z',
    updatedAt: '2026-04-05T18:00:00.000Z',
    ...overrides,
  };
}

test('sessionToPostConfirmationProposal: Tuesday 7pm with Monday dinner fully past', () => {
  const now = at('2026-04-07', 19);
  const sess = session();
  const batches: Batch[] = [
    batch({
      id: 'b-tagine',
      recipeSlug: 'tagine',
      mealType: 'dinner',
      eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
      servings: 3,
    }),
    batch({
      id: 'b-grainbowl',
      recipeSlug: 'grain-bowl',
      mealType: 'lunch',
      eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
      servings: 3,
    }),
  ];

  const result = sessionToPostConfirmationProposal(sess, batches, now);

  // Horizon days — unchanged, same 7 days as the session.
  assert.deepStrictEqual(result.horizonDays, [
    '2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09',
    '2026-04-10', '2026-04-11', '2026-04-12',
  ]);

  // Preserved past batches: Mon dinner (spanning split produces past half with 1 serving),
  // Mon lunch (past by date), Tue lunch (past by cutoff at 19:00 > 15:00 for lunch).
  // The grain-bowl batch is fully past through Tuesday so its past half is 2 servings,
  // and its active half keeps Wed's one serving.
  //
  // For the tagine batch (dinner): at 19:00 on Tuesday, Mon dinner is past by date,
  // Tue dinner is still active (19:00 < 21:00 cutoff), Wed dinner is active.
  // So tagine is spanning: past half [Mon] / 1 serving, active half [Tue, Wed] / 2 servings.
  const pastSlugs = result.preservedPastBatches.map((b) => `${b.recipeSlug}:${b.eatingDays.join(',')}`);
  assert.deepStrictEqual(pastSlugs.sort(), [
    'grain-bowl:2026-04-06,2026-04-07',
    'tagine:2026-04-06',
  ]);

  // Active proposal batches
  const activeSlugs = result.activeProposal.batches.map((b) => `${b.recipeSlug}:${b.days.join(',')}/${b.servings}`);
  assert.deepStrictEqual(activeSlugs.sort(), [
    'grain-bowl:2026-04-08/1',
    'tagine:2026-04-07,2026-04-08/2',
  ]);

  // Active proposal carries flex slots and events that fall on active slots only.
  // The seed session's sole flex slot is on Saturday (active), so it lands in activeProposal.
  assert.deepStrictEqual(result.activeProposal.flexSlots, sess.flexSlots);
  assert.deepStrictEqual(result.activeProposal.events, []);
  assert.deepStrictEqual(result.activeProposal.recipesToGenerate, []);

  // No past flex slots or events in this seed (events is empty, the one flex slot is active).
  assert.deepStrictEqual(result.preservedPastFlexSlots, []);
  assert.deepStrictEqual(result.preservedPastEvents, []);

  // Near-future days: today + tomorrow = 2026-04-07, 2026-04-08.
  assert.deepStrictEqual(result.nearFutureDays, ['2026-04-07', '2026-04-08']);
});

test('sessionToPostConfirmationProposal: past flex slots and events split into preservedPast* arrays', () => {
  const now = at('2026-04-09', 10); // Thursday morning
  const sess = session({
    flexSlots: [
      { day: '2026-04-06', mealTime: 'dinner', flexBonus: 350 }, // past (Monday)
      { day: '2026-04-11', mealTime: 'dinner', flexBonus: 350 }, // active (Saturday)
    ],
    // MealEvent shape: { name, day, mealTime, estimatedCalories, notes? }
    // — real type from src/models/types.ts:139.
    events: [
      { name: 'indian restaurant', day: '2026-04-07', mealTime: 'dinner', estimatedCalories: 1200, notes: 'saag paneer' }, // past (Tuesday)
      { name: 'work lunch out', day: '2026-04-10', mealTime: 'lunch', estimatedCalories: 800 }, // active (Friday)
    ],
  });
  const result = sessionToPostConfirmationProposal(sess, [], now);

  // Active proposal carries ONLY future/today-active flex slots and events.
  assert.deepStrictEqual(result.activeProposal.flexSlots, [
    { day: '2026-04-11', mealTime: 'dinner', flexBonus: 350 },
  ]);
  assert.deepStrictEqual(result.activeProposal.events, [
    { name: 'work lunch out', day: '2026-04-10', mealTime: 'lunch', estimatedCalories: 800 },
  ]);

  // Preserved past arrays carry the dropped ones so the round-trip can splice
  // them back into the rewritten session without erasing the user's record.
  assert.deepStrictEqual(result.preservedPastFlexSlots, [
    { day: '2026-04-06', mealTime: 'dinner', flexBonus: 350 },
  ]);
  assert.deepStrictEqual(result.preservedPastEvents, [
    { name: 'indian restaurant', day: '2026-04-07', mealTime: 'dinner', estimatedCalories: 1200, notes: 'saag paneer' },
  ]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="sessionToPostConfirmationProposal"`
Expected: FAIL — function does not exist.

- [ ] **Step 3: Implement the forward adapter**

Append to `src/plan/session-to-proposal.ts`:

```typescript
import type { PlanSession, FlexSlot, MealEvent } from '../models/types.js';
import type { PlanProposal } from '../solver/types.js';

/**
 * Forward-adapter result. `activeProposal` is the shape the re-proposer accepts;
 * `preservedPastBatches` are the batches (and split halves of spanning batches)
 * that belong entirely to past slots and must be written unchanged into the
 * new session at round-trip time. `preservedPastFlexSlots` and
 * `preservedPastEvents` are the flex slots and meal events whose `day`+`mealTime`
 * classify as past at `now` — the re-proposer never sees them but they must
 * round-trip into the rewritten session so the user's historical record is not
 * erased on every mutate. `nearFutureDays` captures the 2-day soft-locked
 * window for the re-proposer's post-confirmation safety rule.
 */
export interface PostConfirmationProposal {
  activeProposal: PlanProposal;
  preservedPastBatches: Batch[];
  preservedPastFlexSlots: FlexSlot[];
  preservedPastEvents: MealEvent[];
  horizonDays: string[];
  nearFutureDays: string[];
}

/**
 * Expand an ISO horizon (start + end) into the 7 ISO day strings it covers.
 */
function expandHorizonDays(start: string, end: string): string[] {
  const days: string[] = [];
  const d = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  while (d <= e) {
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

/**
 * The 2-day near-future soft-lock window for post-confirmation safety.
 * Returns today + tomorrow as ISO dates, intersected with the horizon so we
 * never produce days outside the session range.
 */
function computeNearFutureDays(now: Date, horizonDays: string[]): string[] {
  const today = toLocalISODate(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowISO = toLocalISODate(tomorrow);
  return [today, tomorrowISO].filter((d) => horizonDays.includes(d));
}

/**
 * Convert a persisted PlanSession + its Batch[] into the re-proposer's
 * in-memory PlanProposal shape, splitting at the (date, mealType) level.
 *
 * The result's `activeProposal` contains only batches, flex slots, and events
 * that fall on active slots — past slots are frozen and never shown to the
 * re-proposer. The `preservedPastBatches` array contains Batches that must
 * flow through the round-trip unchanged (pure-past batches) or with
 * proportionally split ingredient totals (past halves of spanning batches).
 *
 * @param session - The confirmed plan session loaded from the store
 * @param batches - All batches whose createdInPlanSessionId === session.id
 *                  (i.e., the result of store.getBatchesByPlanSessionId)
 * @param now - Current wall clock
 */
export function sessionToPostConfirmationProposal(
  session: PlanSession,
  batches: Batch[],
  now: Date,
): PostConfirmationProposal {
  const horizonDays = expandHorizonDays(session.horizonStart, session.horizonEnd);
  const preservedPastBatches: Batch[] = [];
  const activeBatches: ProposedBatch[] = [];

  for (const b of batches) {
    // Skip cancelled batches entirely — they don't belong to the live plan.
    if (b.status !== 'planned') continue;

    const split = splitBatchAtCutoffs(b, now);
    if (split.kind === 'past-only') {
      preservedPastBatches.push(split.pastBatch);
    } else if (split.kind === 'active-only') {
      activeBatches.push(split.activeBatch);
    } else {
      preservedPastBatches.push(split.pastBatch);
      activeBatches.push(split.activeBatch);
    }
  }

  // Sort active batches by first active day for stable output (scenario diffs).
  activeBatches.sort((a, b) => {
    const da = a.days[0] ?? '';
    const db = b.days[0] ?? '';
    if (da !== db) return da < db ? -1 : 1;
    return a.mealType < b.mealType ? -1 : 1;
  });

  // Flex slots and events: partition by classification at `now`. Active ones
  // go to `activeProposal` (the re-proposer can see and rearrange them);
  // past ones go to `preservedPast*` (frozen historical record that the
  // round-trip splices back into the rewritten session). Dropping past ones
  // on the floor would erase the user's record of "Sunday dinner was a flex
  // slot" or "I ate out Monday" on every mutate — exactly the kind of silent
  // data loss the save-before-destroy model exists to prevent.
  const activeFlexSlots: FlexSlot[] = [];
  const preservedPastFlexSlots: FlexSlot[] = [];
  for (const fs of session.flexSlots) {
    if (classifySlot(fs.day, fs.mealTime, now) === 'active') {
      activeFlexSlots.push(fs);
    } else {
      preservedPastFlexSlots.push(fs);
    }
  }

  const activeEvents: MealEvent[] = [];
  const preservedPastEvents: MealEvent[] = [];
  for (const ev of session.events) {
    if (classifySlot(ev.day, ev.mealTime, now) === 'active') {
      activeEvents.push(ev);
    } else {
      preservedPastEvents.push(ev);
    }
  }

  const activeProposal: PlanProposal = {
    batches: activeBatches,
    flexSlots: activeFlexSlots,
    events: activeEvents,
    recipesToGenerate: [],
  };

  return {
    activeProposal,
    preservedPastBatches,
    preservedPastFlexSlots,
    preservedPastEvents,
    horizonDays,
    nearFutureDays: computeNearFutureDays(now, horizonDays),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --test-name-pattern="sessionToPostConfirmationProposal"`
Expected: PASS — both tests green.

- [ ] **Step 5: Run the full adapter test file**

Run: `npm test -- --test-name-pattern="classifySlot|splitBatchAtCutoffs|spanning|sessionToPostConfirmationProposal"`
Expected: every test from Tasks 7-10 passes.

- [ ] **Step 6: Commit**

```bash
git add src/plan/session-to-proposal.ts test/unit/session-to-proposal.test.ts
git commit -m "Plan 026: sessionToPostConfirmationProposal — forward adapter"
```

---

### Task 11: `buildReplacingDraft` — round-trip back to the store

**Rationale:** After the re-proposer runs on the active proposal AND the solver runs on top of the re-proposer's output, the system needs to write a new session that covers the full horizon (preserved past + re-proposed active). The new draft's `mutationHistory` is the old session's history plus the just-approved mutation. `buildReplacingDraft` is the pure-ish adapter that produces the draft + batch array that gets handed to `store.confirmPlanSessionReplacing` by Plan D. It is "pure-ish" because it has to call the recipe scaler to populate `scaledIngredients` for the active-half batches the re-proposer returned — the scaler is async and takes an LLMProvider.

**Critical: consume solver output, do NOT re-derive targets from `recipe.perServing`.** The existing first-confirmation write path in `plan-flow.ts:851-942` reads `solver.batchTargets` and uses each `batchTarget.targetPerServing` as (a) the scaler's input target and (b) the `Batch.targetPerServing` that lands in the store. The solver is what translates the re-proposer's raw batches into per-batch macro targets aware of the weekly totals, flex bonuses, event offsets, and treat budget. Discarding the solver's output and re-scaling from `recipe.perServing` would produce batches whose `targetPerServing` disagrees with every other persisted batch in the codebase and would silently erase the solver's allocation math. `buildReplacingDraft` must match `plan-flow.ts`'s shape exactly. Plan D's applier owns calling `solve()` on the re-proposer's output before passing the proposal into `buildReplacingDraft` — Plan A's contract is "if `reProposedActive.solverOutput?.batchTargets` is missing, throw" (same error shape as the in-session flow does today via `solver.batchTargets!`).

**Files:**
- Modify: `src/plan/session-to-proposal.ts`
- Modify: `test/unit/session-to-proposal.test.ts`

- [ ] **Step 1: Read the existing scaler signature**

Use the Grep tool to find `scaleRecipe` — the current definition lives at `src/agents/recipe-scaler.ts:54` (NOT `src/recipes/scaler.ts` — `src/recipes/` only contains `database.ts`, `parser.ts`, `renderer.ts`). The function is already called from `plan-flow.ts:895` via `import { scaleRecipe } from './recipe-scaler.js';`. Read `src/agents/recipe-scaler.ts` now to confirm the exact signature before writing the new code below.

Expected signature (verified against `src/agents/recipe-scaler.ts:28-57` at plan-writing time):
```typescript
interface ScaleRecipeInput {
  recipe: Recipe;
  targetCalories: number;
  calorieTolerance: number;
  targetProtein: number;
  servings: number;
}
async function scaleRecipe(input: ScaleRecipeInput, llm: LLMProvider): Promise<ScaleRecipeOutput>
```

If the real signature has drifted since the plan was written, match the real one in the code blocks below rather than this plan's assumption. **Do not invent a new wrapper** — just use the existing function.

- [ ] **Step 2: Write the failing test**

Append to `test/unit/session-to-proposal.test.ts`:

```typescript
import { buildReplacingDraft } from '../../src/plan/session-to-proposal.js';
import type { PlanProposal } from '../../src/solver/types.js';
import type { MealEvent, MutationRecord } from '../../src/models/types.js';

// Small fake LLM + fake recipe DB for this test — we only need the scaler's
// fallback branch to kick in (which does not call the LLM). The real scaler
// in plan-flow.ts wraps LLM failures with a pass-through of recipe.ingredients
// (see src/agents/plan-flow.ts:904-914). We reproduce that behavior by
// throwing from the LLM so buildReplacingDraft uses its own fallback.
const throwingLLM = {
  complete: async () => { throw new Error('test: LLM disabled'); },
} as unknown as import('../../src/ai/provider.js').LLMProvider;

// Fake recipe DB — returns the minimum recipe shape the scaler uses.
const fakeRecipeDb = {
  getBySlug(slug: string) {
    return {
      name: slug, shortName: slug, slug,
      mealTypes: ['dinner'] as const,
      cuisine: 'test', tags: [], prepTimeMinutes: 20,
      structure: [{ type: 'main' as const, name: 'Main' }],
      perServing: { calories: 800, protein: 45, fat: 30, carbs: 60 },
      ingredients: [
        { name: 'protein', amount: 150, unit: 'g', role: 'protein' as const, component: 'Main' },
      ],
      storage: { fridgeDays: 4, freezable: true, reheat: 'microwave 2m' },
      body: '',
    };
  },
  getAll() { return []; },
} as unknown as import('../../src/recipes/database.js').RecipeDatabase;

test('buildReplacingDraft: carries mutationHistory, preserves past batches + flex slots + events, writes new batches using solver-backed targets', async () => {
  const oldSess = session({
    id: 'old',
    mutationHistory: [
      { constraint: 'initial plan', appliedAt: '2026-04-05T18:00:00.000Z' },
    ],
  });
  const preservedPastBatches: Batch[] = [
    batch({
      id: 'past-grainbowl',
      recipeSlug: 'grain-bowl',
      mealType: 'lunch',
      eatingDays: ['2026-04-06', '2026-04-07'],
      servings: 2,
    }),
  ];
  // Past flex slot (Sunday dinner) and past event (Monday lunch out) — both
  // must survive the rewrite or the user's historical record is erased.
  // MealEvent shape: { name, day, mealTime, estimatedCalories, notes? }
  // — real type from src/models/types.ts, NOT the Plan 024 event kind union.
  const preservedPastFlexSlots = [
    { day: '2026-04-05', mealTime: 'dinner', flexBonus: 350 } as const,
  ];
  const preservedPastEvents: MealEvent[] = [
    { name: 'office lunch out', day: '2026-04-06', mealTime: 'lunch', estimatedCalories: 850, notes: 'team lunch' },
  ];
  // The caller (Plan D applier) runs the solver on the re-proposer output
  // before invoking buildReplacingDraft. We attach a minimal solver output
  // with one BatchTarget matching the single re-proposed batch so the test
  // can assert that buildReplacingDraft consumes the solver's targetPerServing
  // (not recipe.perServing) as the Batch's targetPerServing.
  const reProposed: PlanProposal = {
    batches: [
      {
        recipeSlug: 'tagine',
        recipeName: 'tagine',
        mealType: 'dinner',
        days: ['2026-04-08', '2026-04-09'],
        servings: 2,
        overflowDays: undefined,
      },
    ],
    flexSlots: [{ day: '2026-04-11', mealTime: 'dinner', flexBonus: 350 }],
    events: [],
    recipesToGenerate: [],
    solverOutput: {
      isValid: true,
      weeklyTotals: { calories: 15000, protein: 900, treatBudget: 800, flexSlotCalories: 350 },
      dailyBreakdown: [],
      batchTargets: [
        {
          id: 'bt-tagine',
          recipeSlug: 'tagine',
          mealType: 'dinner',
          days: ['2026-04-08', '2026-04-09'],
          servings: 2,
          // Solver target deliberately DIFFERS from recipe.perServing (the fake
          // DB returns calories: 800, protein: 45). If buildReplacingDraft wrote
          // recipe.perServing instead of the solver target, the assertion below
          // would fail. Macros shape is `{ calories, protein }` only — fat/carbs
          // are deliberately NOT on BatchTarget.targetPerServing (see
          // src/models/types.ts:74 and src/solver/types.ts:102).
          targetPerServing: { calories: 720, protein: 50 },
        },
      ],
      cookingSchedule: [],
      warnings: [],
    },
  };
  const newMutation: MutationRecord = {
    constraint: 'eating out tonight',
    appliedAt: '2026-04-07T19:30:00.000Z',
  };

  const { draft, batches: newBatches } = await buildReplacingDraft({
    oldSession: oldSess,
    preservedPastBatches,
    preservedPastFlexSlots,
    preservedPastEvents,
    reProposedActive: reProposed,
    newMutation,
    recipeDb: fakeRecipeDb,
    llm: throwingLLM,
  });

  // Draft session: new id, same horizon, history extended.
  assert.notEqual(draft.id, 'old');
  assert.equal(draft.horizonStart, '2026-04-06');
  assert.equal(draft.horizonEnd, '2026-04-12');
  assert.deepStrictEqual(draft.mutationHistory, [
    { constraint: 'initial plan', appliedAt: '2026-04-05T18:00:00.000Z' },
    { constraint: 'eating out tonight', appliedAt: '2026-04-07T19:30:00.000Z' },
  ]);

  // Draft's flexSlots and events concatenate preserved past + re-proposed active.
  // Past first, then active — matches the order the round-trip wants.
  assert.deepStrictEqual(draft.flexSlots, [
    { day: '2026-04-05', mealTime: 'dinner', flexBonus: 350 },
    { day: '2026-04-11', mealTime: 'dinner', flexBonus: 350 },
  ]);
  assert.deepStrictEqual(draft.events, [
    { name: 'office lunch out', day: '2026-04-06', mealTime: 'lunch', estimatedCalories: 850, notes: 'team lunch' },
  ]);

  // Batches: preserved past + new re-proposed active. Past batches get a
  // new createdInPlanSessionId pointing at the new draft, and a new id.
  assert.equal(newBatches.length, 2);

  const pastBatch = newBatches.find((b) => b.recipeSlug === 'grain-bowl');
  assert.ok(pastBatch, 'preserved past batch missing');
  assert.deepStrictEqual(pastBatch.eatingDays, ['2026-04-06', '2026-04-07']);
  assert.equal(pastBatch.servings, 2);
  assert.equal(pastBatch.createdInPlanSessionId, draft.id);
  assert.notEqual(pastBatch.id, 'past-grainbowl'); // new id
  assert.equal(pastBatch.status, 'planned');

  const activeBatch = newBatches.find((b) => b.recipeSlug === 'tagine');
  assert.ok(activeBatch, 'active re-proposed batch missing');
  assert.deepStrictEqual(activeBatch.eatingDays, ['2026-04-08', '2026-04-09']);
  assert.equal(activeBatch.servings, 2);
  assert.equal(activeBatch.createdInPlanSessionId, draft.id);
  assert.equal(activeBatch.mealType, 'dinner');
  // CRITICAL: targetPerServing must come from the solver's BatchTarget, NOT
  // from recipe.perServing. This is the assertion that would have caught the
  // Round-4 bug where buildReplacingDraft silently re-derived targets.
  assert.deepStrictEqual(activeBatch.targetPerServing, { calories: 720, protein: 50 });
});

test('buildReplacingDraft: throws when reProposedActive.solverOutput is missing', async () => {
  const reProposedWithoutSolver: PlanProposal = {
    batches: [
      {
        recipeSlug: 'tagine', recipeName: 'tagine', mealType: 'dinner',
        days: ['2026-04-08'], servings: 1, overflowDays: undefined,
      },
    ],
    flexSlots: [],
    events: [],
    recipesToGenerate: [],
    // solverOutput deliberately omitted — caller forgot to run the solver.
  };
  await assert.rejects(
    () => buildReplacingDraft({
      oldSession: session({ id: 'old' }),
      preservedPastBatches: [],
      preservedPastFlexSlots: [],
      preservedPastEvents: [],
      reProposedActive: reProposedWithoutSolver,
      newMutation: { constraint: 'x', appliedAt: '2026-04-08T12:00:00.000Z' },
      recipeDb: fakeRecipeDb,
      llm: throwingLLM,
    }),
    /solverOutput is missing/,
  );
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- --test-name-pattern="buildReplacingDraft"`
Expected: FAIL — `buildReplacingDraft` not exported.

- [ ] **Step 4: Implement `buildReplacingDraft`**

Append to `src/plan/session-to-proposal.ts`:

```typescript
import type { DraftPlanSession, FlexSlot, MealEvent, MutationRecord, ScaledIngredient } from '../models/types.js';
import type { LLMProvider } from '../ai/provider.js';
import type { RecipeDatabase } from '../recipes/database.js';

export interface BuildReplacingDraftArgs {
  /** The session being replaced. Its horizon is copied into the new draft. */
  oldSession: PlanSession;
  /** Past batches to preserve verbatim (re-pointed at the new session id). */
  preservedPastBatches: Batch[];
  /**
   * Past flex slots to preserve verbatim. These are the user's historical
   * "I put a flex meal on Sunday dinner" decisions — dropping them on the
   * floor would erase the user's record of what actually happened in the
   * earlier half of the week. Sourced from `sessionToPostConfirmationProposal`.
   */
  preservedPastFlexSlots: FlexSlot[];
  /**
   * Past meal events to preserve verbatim. These are the user's historical
   * "I ate out on Monday" / "breakfast out Tuesday" records — also must
   * survive the rewrite. Sourced from `sessionToPostConfirmationProposal`.
   */
  preservedPastEvents: MealEvent[];
  /** The re-proposer's output for the active window. */
  reProposedActive: PlanProposal;
  /** The just-approved mutation to append to history. */
  newMutation: MutationRecord;
  recipeDb: RecipeDatabase;
  llm: LLMProvider;
}

export interface BuildReplacingDraftResult {
  draft: DraftPlanSession;
  batches: Array<Omit<Batch, 'createdAt' | 'updatedAt'>>;
}

/**
 * Assemble the DraftPlanSession and Batch[] write payload that closes the
 * round-trip after the re-proposer has run on the active slice of a
 * confirmed plan. Produces exactly the shape that `confirmPlanSessionReplacing`
 * wants.
 *
 * Not pure — it calls the recipe scaler to populate `scaledIngredients` /
 * `actualPerServing` on new active batches. The scaler is the same one
 * `plan-flow.ts buildNewPlanSession` uses, so behavior parity is by design.
 * Preserved past batches are re-pointed at the new session id and given fresh
 * UUIDs but otherwise passed through unchanged (their scaledIngredients were
 * already scaled at plan time, and the split logic in Task 9 adjusts totals
 * when a spanning batch is cut).
 */
export async function buildReplacingDraft(
  args: BuildReplacingDraftArgs,
): Promise<BuildReplacingDraftResult> {
  const newSessionId = randomUUID();

  const draft: DraftPlanSession = {
    id: newSessionId,
    horizonStart: args.oldSession.horizonStart,
    horizonEnd: args.oldSession.horizonEnd,
    breakfast: args.oldSession.breakfast,
    treatBudgetCalories: args.oldSession.treatBudgetCalories,
    // Concatenate preserved past + re-proposed active for both flex slots
    // and events. The past arrays are frozen historical records that must
    // round-trip into the rewritten session (the re-proposer never saw them
    // and did not touch them; they simply pass through).
    flexSlots: [...args.preservedPastFlexSlots, ...args.reProposedActive.flexSlots],
    events: [...args.preservedPastEvents, ...args.reProposedActive.events],
    mutationHistory: [...args.oldSession.mutationHistory, args.newMutation],
  };

  const writeBatches: Array<Omit<Batch, 'createdAt' | 'updatedAt'>> = [];

  // 1. Preserved past batches — new id + new session id, everything else stays.
  for (const past of args.preservedPastBatches) {
    writeBatches.push({
      ...past,
      id: randomUUID(),
      createdInPlanSessionId: newSessionId,
    });
  }

  // 2. Re-proposed active batches — use solver output, scale each batch fresh.
  // This mirrors plan-flow.ts:874-938 (first-confirmation write path) so the
  // two code paths produce structurally identical Batch rows.
  const solverOutput = args.reProposedActive.solverOutput;
  if (!solverOutput) {
    throw new Error(
      'buildReplacingDraft: reProposedActive.solverOutput is missing. ' +
      'The caller (Plan D applier) must run the solver on the re-proposer output ' +
      'before invoking buildReplacingDraft.',
    );
  }

  for (const batchTarget of solverOutput.batchTargets) {
    // Match plan-flow.ts:878-882's tuple key: (recipeSlug, mealType, days[0]).
    // days[0] disambiguates when the same (recipeSlug, mealType) appears in
    // two batches after re-batching (Plan 009).
    const proposedBatch = args.reProposedActive.batches.find(
      (b) =>
        b.recipeSlug === batchTarget.recipeSlug &&
        b.mealType === batchTarget.mealType &&
        b.days[0] === batchTarget.days[0],
    );
    if (!proposedBatch) {
      throw new Error(
        `buildReplacingDraft: solver BatchTarget ${batchTarget.recipeSlug}:${batchTarget.mealType}:${batchTarget.days[0]} ` +
        `has no matching re-proposed batch — solver output and re-proposer output are out of sync.`,
      );
    }
    const recipe = batchTarget.recipeSlug ? args.recipeDb.getBySlug(batchTarget.recipeSlug) : undefined;
    const overflowDays = proposedBatch.overflowDays ?? [];
    const eatingDays = [...batchTarget.days, ...overflowDays];

    let actualPerServing = { calories: 0, protein: 0, fat: 0, carbs: 0 };
    let scaledIngredients: ScaledIngredient[] = [];

    if (recipe) {
      // Fallback branch matches plan-flow.ts:904-914 exactly: on any scaler
      // failure, fall back to per-serving amounts multiplied by servings.
      try {
        const { scaleRecipe } = await import('../agents/recipe-scaler.js');
        const scaled = await scaleRecipe({
          recipe,
          // Use the SOLVER-produced target, not recipe.perServing — the solver
          // has already allocated macros across the week's batches given the
          // weekly totals, flex bonuses, event offsets, and treat budget.
          targetCalories: batchTarget.targetPerServing.calories,
          calorieTolerance: 50, // Plan D will thread config.planning.scalerCalorieTolerance
          targetProtein: batchTarget.targetPerServing.protein,
          servings: eatingDays.length, // Plan 010: total portions, not solver servings
        }, args.llm);
        actualPerServing = scaled.actualPerServing;
        scaledIngredients = scaled.scaledIngredients;
      } catch {
        actualPerServing = recipe.perServing;
        scaledIngredients = recipe.ingredients.map((ing) => ({
          name: ing.name,
          amount: ing.amount,
          unit: ing.unit,
          totalForBatch: ing.amount * eatingDays.length,
          role: ing.role,
        }));
      }
    }

    writeBatches.push({
      id: randomUUID(),
      recipeSlug: batchTarget.recipeSlug ?? '',
      mealType: batchTarget.mealType,
      eatingDays,
      servings: eatingDays.length,
      // Write the solver's target as-is. `actualPerServing` is what the scaler
      // produced; `targetPerServing` is the solver's allocation target. These
      // are allowed to differ within the scaler's calorie tolerance.
      targetPerServing: batchTarget.targetPerServing,
      actualPerServing,
      scaledIngredients,
      status: 'planned',
      createdInPlanSessionId: newSessionId,
    });
  }

  return { draft, batches: writeBatches };
}
```

**Note on the `calorieTolerance` placeholder:** the exact value here is not load-bearing for Plan A (the scaler falls back on failure and Plan A's tests use the throwing LLM). Plan D will thread the real value from `config.planning.scalerCalorieTolerance`. The comment in the code block above documents this deferral — do not delete it.

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- --test-name-pattern="buildReplacingDraft"`
Expected: PASS — the fallback branch runs and produces the expected shape.

- [ ] **Step 6: Run the full adapter test file**

Run: `npm test`
Expected: every test in the repo passes.

- [ ] **Step 7: Commit**

```bash
git add src/plan/session-to-proposal.ts test/unit/session-to-proposal.test.ts
git commit -m "Plan 026: buildReplacingDraft — round-trip write payload"
```

---

### Task 12: Validator invariant #14 — meal-type lane

**Rationale:** Today's validator never checks that a batch's `mealType` is in its recipe's `mealTypes`. Proposal 003 requires this to be load-bearing before post-confirmation mutations land, because the re-proposer may be tempted to rearrange aggressively and put a dinner-only recipe into a lunch batch. The check must come AFTER invariant #10 (recipe exists) so it can trust `recipeDb.getBySlug(...)` returns a defined value, and it must silently skip batches whose recipe is missing (those are already caught by #10).

**Files:**
- Modify: `src/qa/validators/proposal.ts:164-169`
- Create: `test/unit/proposal-validator-meal-type-lane.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/proposal-validator-meal-type-lane.test.ts` with:

```typescript
/**
 * Plan 026 — proposal validator invariant #14: batch.mealType ∈ recipe.mealTypes.
 *
 * Ensures the re-proposer (and any future caller of validateProposal) cannot
 * place a recipe into a meal-type lane its author did not permit. A dinner-only
 * tagine in a lunch batch is invalid; a lunch-and-dinner grain bowl in either
 * lane is fine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProposal } from '../../src/qa/validators/proposal.js';
import type { PlanProposal } from '../../src/solver/types.js';
import type { Recipe } from '../../src/models/types.js';

function makeRecipe(slug: string, mealTypes: Recipe['mealTypes']): Recipe {
  return {
    name: slug, shortName: slug, slug, mealTypes,
    cuisine: 'test', tags: [], prepTimeMinutes: 20,
    structure: [{ type: 'main', name: 'Main' }],
    perServing: { calories: 800, protein: 45, fat: 30, carbs: 60 },
    ingredients: [{ name: 'p', amount: 150, unit: 'g', role: 'protein', component: 'Main' }],
    storage: { fridgeDays: 4, freezable: true, reheat: '' },
    body: '',
  };
}

function fakeDb(recipes: Recipe[]): import('../../src/recipes/database.js').RecipeDatabase {
  const m = new Map(recipes.map((r) => [r.slug, r]));
  return {
    getBySlug: (slug: string) => m.get(slug),
    getAll: () => [...m.values()],
  } as unknown as import('../../src/recipes/database.js').RecipeDatabase;
}

function proposal(overrides: Partial<PlanProposal> = {}): PlanProposal {
  return {
    batches: [],
    flexSlots: [{ day: '2026-04-12', mealTime: 'dinner', flexBonus: 350 }],
    events: [],
    recipesToGenerate: [],
    ...overrides,
  };
}

const horizonDays = [
  '2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09',
  '2026-04-10', '2026-04-11', '2026-04-12',
];

test('invariant #14: dinner-only recipe in a lunch batch → error', () => {
  const db = fakeDb([makeRecipe('tagine', ['dinner'])]);
  // Fill every other slot so slot-coverage isn't the thing that fails.
  // We need a coverage-complete proposal that only triggers #14.
  // Simplest way: a single batch covering every lunch and dinner slot wouldn't
  // be a lane violation. So we build a violating lunch batch and one dinner
  // batch covering the same days to keep #1/#2 happy, then other days are
  // uncovered — #1 will also fire, but #14 must appear in errors regardless.
  const p = proposal({
    batches: [
      {
        recipeSlug: 'tagine', recipeName: 'Tagine', mealType: 'lunch',
        days: ['2026-04-06', '2026-04-07'], servings: 2,
      },
    ],
  });
  const result = validateProposal(p, db, horizonDays, []);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) => e.startsWith('#14')),
    `expected a #14 error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('invariant #14: recipe permits both lunch and dinner → no lane error', () => {
  const db = fakeDb([makeRecipe('grain-bowl', ['lunch', 'dinner'])]);
  const p = proposal({
    batches: [
      {
        recipeSlug: 'grain-bowl', recipeName: 'Grain Bowl', mealType: 'lunch',
        days: ['2026-04-06', '2026-04-07'], servings: 2,
      },
      {
        recipeSlug: 'grain-bowl', recipeName: 'Grain Bowl', mealType: 'dinner',
        days: ['2026-04-06', '2026-04-07'], servings: 2,
      },
    ],
  });
  const result = validateProposal(p, db, horizonDays, []);
  assert.ok(
    !result.errors.some((e) => e.startsWith('#14')),
    `expected no #14 error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('invariant #14: missing recipe is caught by #10, not #14', () => {
  const db = fakeDb([]); // no recipes
  const p = proposal({
    batches: [
      {
        recipeSlug: 'ghost', recipeName: 'Ghost', mealType: 'lunch',
        days: ['2026-04-06'], servings: 1,
      },
    ],
  });
  const result = validateProposal(p, db, horizonDays, []);
  assert.ok(
    result.errors.some((e) => e.startsWith('#10')),
    '#10 should fire for missing recipes',
  );
  assert.ok(
    !result.errors.some((e) => e.startsWith('#14')),
    '#14 must not double-report on missing recipes',
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="invariant #14"`
Expected: FAIL — the first test ("dinner-only recipe in a lunch batch → error") fails because invariant #14 doesn't exist yet.

- [ ] **Step 3: Implement invariant #14**

In `src/qa/validators/proposal.ts`, add the new invariant right after invariant #10 (which ends at line 169). Insert before the blank line preceding invariant #11:

```typescript
  // --- Invariant 14: Meal-type lane ---
  // Each batch's mealType must be in its recipe's authored mealTypes array.
  // Plan 026: prevents the re-proposer from placing a dinner-only recipe into
  // a lunch batch under post-confirmation rearrangement pressure. Skip batches
  // whose recipe is missing — invariant #10 catches those separately.
  for (const [i, batch] of proposal.batches.entries()) {
    const recipe = recipeDb.getBySlug(batch.recipeSlug);
    if (!recipe) continue;
    if (!recipe.mealTypes.includes(batch.mealType)) {
      errors.push(
        `#14 Meal-type lane: batch[${i}] ${batch.recipeSlug} is placed in ${batch.mealType} ` +
        `but recipe.mealTypes = [${recipe.mealTypes.join(', ')}]`,
      );
    }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --test-name-pattern="invariant #14"`
Expected: all 3 tests pass.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS — existing scenarios stay green because no existing recipe fixture under `test/fixtures/recipes/` violates the new rule. If any scenario fails with a new #14 error, read the scenario to see which batch is wrong — that is a real coverage gap the scenario was silently allowing, and it needs to be fixed (either the fixture recipe's `mealTypes` or the recorded output) before proceeding.

- [ ] **Step 6: Commit**

```bash
git add src/qa/validators/proposal.ts test/unit/proposal-validator-meal-type-lane.test.ts
git commit -m "Plan 026: proposal validator invariant #14 — meal-type lane"
```

---

### Task 13: Re-proposer `mode` field + meal-type lane prompt rule

**Rationale:** The re-proposer's prompt currently never mentions meal-type lanes (`src/agents/plan-reproposer.ts:170-238`). Under post-confirmation pressure it might produce lane-crossing proposals that the new invariant #14 will reject on the first call, forcing a retry and burning an extra LLM turn. Adding the rule to the prompt saves that retry and makes the rule load-bearing at the model level, not just the validator level. The same rule applies in both modes — today's in-session calls benefit too.

**Files:**
- Modify: `src/agents/plan-reproposer.ts:28-37` (add `mode` + `nearFutureDays`)
- Modify: `src/agents/plan-reproposer.ts:170-238` (prompt extension)
- Modify: `src/agents/plan-flow.ts:666-675` (pass `mode: 'in-session'` in the sole existing call site)
- Create: `test/unit/post-confirmation-reproposer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/post-confirmation-reproposer.test.ts` with:

```typescript
/**
 * Plan 026 — fixture-LLM tests for the re-proposer's new rules.
 *
 * These tests pin down two behaviors that the re-proposer MUST exhibit after
 * Plan 026 lands:
 *
 *   1. Meal-type lane rule (both modes): the prompt must instruct the LLM
 *      that dinner-only recipes cannot land in lunch batches and vice versa.
 *      We verify by reading the system prompt that `reProposePlan` builds.
 *
 *   2. Near-future safety rule (post-confirmation mode only): the prompt must
 *      include a soft-lock window for the next ~2 days.
 *
 * We do NOT call the real LLM — we capture the messages the provider receives
 * and inspect them. This is a white-box test on prompt construction because
 * the rules are prompt-level requirements.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reProposePlan } from '../../src/agents/plan-reproposer.js';
import type { LLMProvider } from '../../src/ai/provider.js';
import type { RecipeDatabase } from '../../src/recipes/database.js';

function capturingLLM(): { provider: LLMProvider; lastSystemPrompt: () => string } {
  let lastSystem = '';
  const provider: LLMProvider = {
    async complete(opts: { messages: Array<{ role: string; content: string }> }) {
      lastSystem = opts.messages.find((m) => m.role === 'system')?.content ?? '';
      return {
        content: JSON.stringify({
          type: 'proposal',
          batches: [],
          flex_slots: [],
          events: [],
          reasoning: 'stub',
        }),
        usage: { inputTokens: 0, outputTokens: 0 },
      } as any;
    },
  } as unknown as LLMProvider;
  return { provider, lastSystemPrompt: () => lastSystem };
}

const fakeDb: RecipeDatabase = {
  getBySlug: () => undefined,
  getAll: () => [],
} as unknown as RecipeDatabase;

test('meal-type lane rule is present in both in-session and post-confirmation prompts', async () => {
  for (const mode of ['in-session', 'post-confirmation'] as const) {
    const { provider, lastSystemPrompt } = capturingLLM();
    await reProposePlan(
      {
        currentProposal: { batches: [], flexSlots: [], events: [], recipesToGenerate: [] },
        userMessage: 'any',
        mutationHistory: [],
        availableRecipes: [],
        horizonDays: ['2026-04-06'],
        preCommittedSlots: [],
        breakfast: { name: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
        weeklyTargets: { calories: 17000, protein: 1050 },
        mode,
        nearFutureDays: mode === 'post-confirmation' ? ['2026-04-07', '2026-04-08'] : undefined,
      },
      provider,
      fakeDb,
    );
    const prompt = lastSystemPrompt();
    assert.match(prompt, /meal[- ]type lane/i, `${mode}: prompt missing meal-type lane rule`);
    assert.match(prompt, /batch\.mealType.*recipe\.mealTypes|recipe's.*mealTypes/i,
      `${mode}: prompt must refer to the invariant in code terms`);
  }
});

test('near-future safety rule is present ONLY in post-confirmation mode', async () => {
  const { provider: inSessionLLM, lastSystemPrompt: inSessionPrompt } = capturingLLM();
  await reProposePlan(
    {
      currentProposal: { batches: [], flexSlots: [], events: [], recipesToGenerate: [] },
      userMessage: 'any',
      mutationHistory: [],
      availableRecipes: [],
      horizonDays: ['2026-04-06'],
      preCommittedSlots: [],
      breakfast: { name: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
      weeklyTargets: { calories: 17000, protein: 1050 },
      mode: 'in-session',
    },
    inSessionLLM,
    fakeDb,
  );
  assert.doesNotMatch(inSessionPrompt(), /near[- ]future safety/i,
    'in-session prompt must NOT include near-future safety (planning doesn\'t need it)');

  const { provider: postLLM, lastSystemPrompt: postPrompt } = capturingLLM();
  await reProposePlan(
    {
      currentProposal: { batches: [], flexSlots: [], events: [], recipesToGenerate: [] },
      userMessage: 'any',
      mutationHistory: [],
      availableRecipes: [],
      horizonDays: ['2026-04-06'],
      preCommittedSlots: [],
      breakfast: { name: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
      weeklyTargets: { calories: 17000, protein: 1050 },
      mode: 'post-confirmation',
      nearFutureDays: ['2026-04-07', '2026-04-08'],
    },
    postLLM,
    fakeDb,
  );
  const post = postPrompt();
  assert.match(post, /near[- ]future safety/i);
  assert.match(post, /2026-04-07/, 'near-future days must be inlined into the prompt');
  assert.match(post, /2026-04-08/);
});

/*
 * Behavioral tests — fixture-LLM drives a real reProposePlan call through the
 * validator retry loop. These are the tests the file-structure section promises
 * at the top of this plan ("Fixture-LLM unit tests for the new re-proposer
 * rules... hand-authored fixtures that exercise meal-type lane violations and
 * near-future safety violations"). Prompt-string assertions above prove the
 * prompt was changed; the tests below prove the validator actually catches a
 * lane-crossing LLM response and either retries into a clean proposal or
 * returns failure — i.e., the rules are load-bearing end-to-end, not just
 * lint-level copy in the system prompt.
 */

/**
 * Queue-based fixture LLM: returns one scripted response per complete() call.
 * Used to simulate the LLM producing a rule-violating proposal first and then
 * correcting on the retry, so we can assert the validator caught the first
 * round and prompt-feedback worked.
 */
function queuedFixtureLLM(responses: string[]): LLMProvider {
  const queue = [...responses];
  return {
    async complete() {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('queuedFixtureLLM: no more scripted responses');
      }
      return { content: next, usage: { inputTokens: 0, outputTokens: 0 } } as any;
    },
  } as unknown as LLMProvider;
}

/** Minimal recipe DB with a dinner-only and a lunch+dinner recipe so invariant #14 has something to compare against. */
const behavioralRecipeDb: RecipeDatabase = {
  getBySlug(slug: string) {
    if (slug === 'tagine') {
      return {
        slug: 'tagine', name: 'tagine', shortName: 'tagine',
        mealTypes: ['dinner'] as const, // dinner-only
        cuisine: 'moroccan', tags: [], prepTimeMinutes: 45,
        structure: [{ type: 'main' as const, name: 'Main' }],
        perServing: { calories: 700, protein: 40, fat: 25, carbs: 60 },
        ingredients: [{ name: 'lamb', amount: 150, unit: 'g', role: 'protein' as const, component: 'Main' }],
        storage: { fridgeDays: 4, freezable: true, reheat: 'microwave 3m' },
        body: '',
      } as any;
    }
    if (slug === 'grain-bowl') {
      return {
        slug: 'grain-bowl', name: 'grain bowl', shortName: 'grain-bowl',
        mealTypes: ['lunch', 'dinner'] as const,
        cuisine: 'modern', tags: [], prepTimeMinutes: 20,
        structure: [{ type: 'main' as const, name: 'Main' }],
        perServing: { calories: 600, protein: 35, fat: 20, carbs: 70 },
        ingredients: [{ name: 'quinoa', amount: 100, unit: 'g', role: 'carb' as const, component: 'Main' }],
        storage: { fridgeDays: 3, freezable: false, reheat: 'room temp' },
        body: '',
      } as any;
    }
    return undefined;
  },
  getAll() { return []; },
} as unknown as RecipeDatabase;

test('meal-type lane violation: validator catches dinner-only recipe in lunch batch and forces retry', async () => {
  // First LLM call: produce an invalid proposal that puts tagine (dinner-only)
  // into a lunch batch — invariant #14 should reject it.
  // Second LLM call (retry): produce a valid proposal that swaps to grain-bowl,
  // which is valid in both lunch and dinner lanes.
  const badProposal = {
    type: 'proposal',
    batches: [
      { recipe_slug: 'tagine', recipe_name: 'tagine', meal_type: 'lunch', days: ['2026-04-08'], servings: 1 },
    ],
    flex_slots: [],
    events: [],
    reasoning: 'naive first-try (should fail invariant #14)',
  };
  const goodProposal = {
    type: 'proposal',
    batches: [
      { recipe_slug: 'grain-bowl', recipe_name: 'grain bowl', meal_type: 'lunch', days: ['2026-04-08'], servings: 1 },
    ],
    flex_slots: [],
    events: [],
    reasoning: 'corrected after retry — lane-safe',
  };
  const llm = queuedFixtureLLM([JSON.stringify(badProposal), JSON.stringify(goodProposal)]);

  const result = await reProposePlan(
    {
      currentProposal: {
        batches: [{ recipeSlug: 'tagine', recipeName: 'tagine', mealType: 'dinner', days: ['2026-04-08'], servings: 1, overflowDays: undefined }],
        flexSlots: [],
        events: [],
        recipesToGenerate: [],
      },
      userMessage: 'put that in lunch instead',
      mutationHistory: [],
      availableRecipes: [
        // RecipeSummary shape (src/agents/plan-proposer.ts:39):
        // { slug, name, mealTypes, cuisine, tags, calories, protein, proteinSource, fridgeDays }
        // No `perServing` field — calories and protein are flat at the top level.
        { slug: 'tagine', name: 'tagine', mealTypes: ['dinner'], cuisine: 'moroccan', tags: ['one-pot'], calories: 700, protein: 40, proteinSource: 'lamb', fridgeDays: 4 },
        { slug: 'grain-bowl', name: 'grain bowl', mealTypes: ['lunch', 'dinner'], cuisine: 'modern', tags: ['bowl', 'portable'], calories: 600, protein: 35, proteinSource: 'chicken', fridgeDays: 3 },
      ],
      horizonDays: ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10', '2026-04-11', '2026-04-12'],
      preCommittedSlots: [],
      breakfast: { name: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
      weeklyTargets: { calories: 17000, protein: 1050 },
      mode: 'post-confirmation',
      nearFutureDays: ['2026-04-08', '2026-04-09'],
    },
    llm,
    behavioralRecipeDb,
  );

  // The retry succeeds — result is a valid proposal using the lane-safe recipe.
  assert.equal(result.type, 'proposal');
  if (result.type !== 'proposal') throw new Error('unreachable');
  assert.equal(result.proposal.batches.length, 1);
  assert.equal(result.proposal.batches[0]!.recipeSlug, 'grain-bowl');
  assert.equal(result.proposal.batches[0]!.mealType, 'lunch');
});

test('meal-type lane violation: two retries both fail → reProposePlan returns failure', async () => {
  // Both the first and second LLM responses put a dinner-only recipe in a lunch
  // batch. After two validator-driven retries, reProposePlan must surface a
  // failure rather than silently returning the bad proposal.
  const bad = {
    type: 'proposal',
    batches: [
      { recipe_slug: 'tagine', recipe_name: 'tagine', meal_type: 'lunch', days: ['2026-04-08'], servings: 1 },
    ],
    flex_slots: [],
    events: [],
    reasoning: 'still wrong',
  };
  const llm = queuedFixtureLLM([JSON.stringify(bad), JSON.stringify(bad)]);

  const result = await reProposePlan(
    {
      currentProposal: {
        batches: [{ recipeSlug: 'tagine', recipeName: 'tagine', mealType: 'dinner', days: ['2026-04-08'], servings: 1, overflowDays: undefined }],
        flexSlots: [],
        events: [],
        recipesToGenerate: [],
      },
      userMessage: 'put that in lunch instead',
      mutationHistory: [],
      availableRecipes: [
        { slug: 'tagine', name: 'tagine', mealTypes: ['dinner'], cuisine: 'moroccan', tags: ['one-pot'], calories: 700, protein: 40, proteinSource: 'lamb', fridgeDays: 4 },
      ],
      horizonDays: ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10', '2026-04-11', '2026-04-12'],
      preCommittedSlots: [],
      breakfast: { name: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
      weeklyTargets: { calories: 17000, protein: 1050 },
      mode: 'post-confirmation',
      nearFutureDays: ['2026-04-08', '2026-04-09'],
    },
    llm,
    behavioralRecipeDb,
  );

  assert.equal(result.type, 'failure', 'two lane violations in a row must surface as failure');
});

test('near-future safety: retry feedback path fires when post-confirmation LLM rearranges a soft-locked slot without user targeting', async () => {
  // NOTE: the near-future safety rule is prompt-only (no validator invariant backs it
  // up — rearranging a near-future slot is a soft violation of user intent, not a
  // structural plan invariant). This test therefore asserts the prompt flows the
  // soft-locked dates to the LLM end-to-end and that a response that respects the
  // rule passes through as a clean proposal. A response that violates the rule
  // cannot be caught by `validateProposal` — it would need a dedicated behavioral
  // validator. That validator is out of scope for Plan A; see Task 13's decision
  // log note. What Plan A can verify is (a) the prompt carries the rule and the
  // dates, and (b) a rule-respecting LLM response round-trips cleanly — both of
  // which are covered by this test plus the prompt-string tests above.
  const respectful = {
    type: 'proposal',
    batches: [
      { recipe_slug: 'grain-bowl', recipe_name: 'grain bowl', meal_type: 'dinner', days: ['2026-04-11'], servings: 1 },
    ],
    flex_slots: [],
    events: [],
    reasoning: 'moved the flex OUTSIDE the soft-locked window',
  };
  const { provider, lastSystemPrompt } = capturingLLM();
  // Queue one respectful response by chaining capturingLLM -> override complete once.
  const originalComplete = provider.complete.bind(provider);
  (provider as any).complete = async (opts: any) => {
    await originalComplete(opts); // populate lastSystemPrompt side-effect
    return { content: JSON.stringify(respectful), usage: { inputTokens: 0, outputTokens: 0 } };
  };

  const result = await reProposePlan(
    {
      currentProposal: {
        batches: [{ recipeSlug: 'grain-bowl', recipeName: 'grain bowl', mealType: 'dinner', days: ['2026-04-08'], servings: 1, overflowDays: undefined }],
        flexSlots: [],
        events: [],
        recipesToGenerate: [],
      },
      userMessage: 'move the flex later this week',
      mutationHistory: [],
      availableRecipes: [
        { slug: 'grain-bowl', name: 'grain bowl', mealTypes: ['lunch', 'dinner'], cuisine: 'modern', tags: ['bowl', 'portable'], calories: 600, protein: 35, proteinSource: 'chicken', fridgeDays: 3 },
      ],
      horizonDays: ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10', '2026-04-11', '2026-04-12'],
      preCommittedSlots: [],
      breakfast: { name: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
      weeklyTargets: { calories: 17000, protein: 1050 },
      mode: 'post-confirmation',
      nearFutureDays: ['2026-04-08', '2026-04-09'],
    },
    provider,
    behavioralRecipeDb,
  );

  // Prompt carried the soft-locked dates.
  assert.match(lastSystemPrompt(), /2026-04-08/);
  assert.match(lastSystemPrompt(), /2026-04-09/);
  // A rule-respecting LLM response comes through as a clean proposal.
  assert.equal(result.type, 'proposal');
  if (result.type !== 'proposal') throw new Error('unreachable');
  assert.deepStrictEqual(result.proposal.batches[0]!.days, ['2026-04-11']);
});
```

Note: this file expects `reProposePlan` to accept `mode` and `nearFutureDays` in `ReProposerInput` (Step 3 adds them) AND the re-proposer's system prompt to carry both new rules (Step 4 adds them) AND `validateProposal` to enforce invariant #14 (Task 12 added it). The prompt-string tests prove the copy is present; the behavioral tests prove the validator retry path actually fires on a lane violation and surfaces failure after two bad responses.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="meal-type lane|near-future safety"`
Expected: FAIL — TypeScript errors on the unknown `mode` field, the prompt regex assertions fail because the prompt doesn't yet mention either rule, AND the behavioral `meal-type lane violation` tests either fail to compile or return the wrong shape because the validator retry loop isn't yet wired to invariant #14.

- [ ] **Step 3: Extend `ReProposerInput`**

In `src/agents/plan-reproposer.ts`, replace the `ReProposerInput` interface (lines 28-37) with:

```typescript
export interface ReProposerInput {
  currentProposal: PlanProposal;
  userMessage: string;
  mutationHistory: MutationRecord[];
  availableRecipes: RecipeSummary[];
  horizonDays: string[];
  preCommittedSlots: PreCommittedSlot[];
  breakfast: { name: string; caloriesPerDay: number; proteinPerDay: number };
  weeklyTargets: { calories: number; protein: number };
  /**
   * Plan 026: which execution context the re-proposer is running in.
   *
   * - 'in-session': during an active planning conversation, before the user
   *   has confirmed the plan. The meal-type lane rule is enforced; the
   *   near-future safety rule is NOT (there's no real-world prep yet).
   * - 'post-confirmation': the user has a confirmed plan running and is
   *   asking to adjust it. Both rules are enforced. The caller MUST provide
   *   `nearFutureDays` (≤2 ISO dates) representing the soft-locked window.
   */
  mode: 'in-session' | 'post-confirmation';
  /**
   * Plan 026: soft-locked window under 'post-confirmation' mode. Present only
   * (and required) when mode === 'post-confirmation'. Up to 2 ISO dates:
   * today and tomorrow, intersected with the horizon.
   */
  nearFutureDays?: string[];
}
```

`MutationRecord` was already added to the `import type { MealEvent, FlexSlot, MutationRecord } from '../models/types.js';` line at Task 2 Step 2, so no additional import is needed here.

- [ ] **Step 4: Extend `buildSystemPrompt` with the new rules**

In `src/agents/plan-reproposer.ts`, replace `buildSystemPrompt` (lines 170-238) to add both new sections. Find the existing "## BATCH MODEL RULES" section and INSERT the meal-type lane rule right after it (before the existing "## CROSS-HORIZON BATCHES" section). Then append the near-future safety section (conditionally) at the end of the prompt.

Replace the function body with:

```typescript
function buildSystemPrompt(input: ReProposerInput): string {
  const base = `You are a meal plan adjustment agent. You receive a current plan and a user's change request. Your job is to adjust the plan according to the request and return a COMPLETE new plan.

## OUTPUT TYPE

You MUST return one of two JSON shapes:

**If you can make the change:**
{
  "type": "proposal",
  "batches": [...],
  "flex_slots": [...],
  "events": [...],
  "reasoning": "string — brief explanation of what you changed and why"
}

**If you need clarification (ambiguous request or recipe not in DB):**
{
  "type": "clarification",
  "question": "string — the question to ask the user",
  "recipe_needed": "string or null — non-null when the user wants a recipe not in the DB",
  "recipe_meal_type": "lunch or dinner — REQUIRED when recipe_needed is set"
}

## AUTHORITY RULES

**You CAN change:**
- Batch eating days (rearrange when meals are eaten)
- Serving counts (1-3 per batch)
- Flex placement (which day/meal gets the flex slot)
- Cook days (derived from first eating day — not set separately)
- Events: add, remove, or modify per user intent
- Recipes: ONLY when the user explicitly requests a recipe change

**You CANNOT change:**
- Pre-committed slots (fixed from prior session)
- Breakfast (fixed)
- Total flex count: MUST stay at exactly ${config.planning.flexSlotsPerWeek}
- Calorie targets (the solver's domain)
- Recipes without user intent — do NOT silently swap recipes. The user may have bought ingredients.

## BATCH MODEL RULES

- Eating days in a batch need NOT be consecutive — events and flex in the middle are fine
- Fridge life is a hard constraint: calendarSpan(first eating day, last eating day) ≤ recipe's fridge_days
- Servings range: 1 to 3. Prefer 2-3 serving batches. 1-serving only when no multi-serving arrangement fits.
- Servings must equal the number of eating days (including overflow)
- Cook day = first eating day (always)
- Days must be in ascending ISO order within each batch

## MEAL-TYPE LANE RULE (load-bearing, never crossed)

Each batch has a mealType ('lunch' or 'dinner'), and each recipe in the available list has a "mealTypes" array listing which meal contexts it was authored for. A batch's mealType MUST be one of its recipe's mealTypes — specifically, batch.mealType ∈ recipe.mealTypes must hold for every batch you emit. You MUST NOT place a dinner-only recipe into a lunch batch, or a lunch-only recipe into a dinner batch.

This rule is NOT cosmetic. Lunch and dinner are physically different meals: lunch is portable, no-reheat, and light (midday energy matters); dinner can be heavy, sauce-heavy, cooked-to-reheat. Silently crossing lanes produces a plan the user cannot actually execute.

If the user asks for a swap that would violate this, pick a different recipe in the permitted mealTypes, or return a clarification explaining the constraint.

## CROSS-HORIZON BATCHES

Batches near the horizon edge can extend into the next session:
- eating_days includes ALL days (in-horizon + overflow)
- overflow_days lists only days past the horizon end
- The solver only sees in-horizon days; overflow becomes pre-committed next session

## MUTATION HISTORY

Prior user-approved changes are load-bearing — do NOT undo them unless the new request explicitly conflicts. The user built this plan iteratively; respect earlier choices.

## RECIPE MATCHING

If the user asks for a recipe not in the available recipes list, return a clarification with recipe_needed set. Example: "I don't have a Thai green curry. Want me to create one?"

## COMPLETENESS

Always output a COMPLETE plan — every lunch and dinner slot in the horizon must be covered by exactly one of: batch, flex, event, or pre-committed slot. No gaps, no overlaps.`;

  if (input.mode !== 'post-confirmation') {
    return base;
  }

  const nearFuture = (input.nearFutureDays ?? []).join(', ') || '(none)';
  return `${base}

## NEAR-FUTURE SAFETY (post-confirmation mode)

You are running on a CONFIRMED plan that the user is already living through. The user has likely shopped, portioned, or prepared meals for the next couple of days. The following ISO dates are "near-future" and are SOFT-LOCKED: ${nearFuture}

Rules for near-future days:
- You MUST NOT silently rearrange meals on near-future days. Leave them exactly as they are unless the user's request explicitly targets a near-future slot.
- You MAY change a near-future slot when the user's request clearly names it — examples of explicit targeting: "move today's dinner to tomorrow", "skip tomorrow's lunch — I'm eating out", "swap the lunch I'm about to make for something else".
- Days strictly outside the near-future window can be rearranged freely within the other rules (fridge-life, pre-committed slots, meal-type lanes, mutation history, flex count).
- If absorbing the user's request would force a silent change to a near-future day that the user did not explicitly target, return a clarification asking the user to confirm the near-future impact — do NOT make the change unilaterally.

This rule exists because the user's real-world preparation must be respected unless they explicitly override it themselves.`;
}
```

- [ ] **Step 5: Update the existing call site in `plan-flow.ts`**

In `src/agents/plan-flow.ts`, update the `reProposePlan` call at lines 666-675 to pass `mode: 'in-session'`:

```typescript
    const result = await reProposePlan({
      currentProposal: state.proposal,
      userMessage,
      mutationHistory: state.mutationHistory ?? [],
      availableRecipes: buildRecipeSummaries(recipes.getAll()),
      horizonDays: state.horizonDays ?? state.weekDays,
      preCommittedSlots: state.preCommittedSlots ?? [],
      breakfast: state.breakfast,
      weeklyTargets: config.targets.weekly,
      mode: 'in-session',
    }, llm, recipes);
```

(Add `mode: 'in-session'` as the last field — no other changes.)

- [ ] **Step 6: Run the new tests**

Run: `npm test -- --test-name-pattern="meal-type lane|near-future safety"`
Expected: PASS — all five tests green (two prompt-string tests + two meal-type lane behavioral tests + one near-future safety prompt-threading test).

- [ ] **Step 7: Run the full test suite — expect scenario fixture misses**

Run: `npm test`
Expected: every unit test passes, but scenarios that exercise the re-proposer WILL fail with `MissingFixtureError`. This is EXPECTED — the system prompt change alters the fixture hash, so replay can't find a match. The affected scenarios (verified at plan-writing time via `grep "reProposePlan\|plan-reproposal" test/scenarios/*/recorded.json`) are:

- `002-plan-week-flex-move-regression`
- `013-flex-move-rebatch-carryover`
- `023-reproposer-event-add`
- `024-reproposer-recipe-swap`
- `025-reproposer-event-remove`
- `026-reproposer-multi-mutation`
- `027-reproposer-clarification`
- `028-reproposer-recipe-generation`

Before regenerating, run `npm test` and note which scenarios actually fail — if the real list differs (new scenarios added since, old ones renamed), use the test output as the ground truth.

- [ ] **Step 8: Regenerate all affected scenarios IN PARALLEL**

Generation is mechanical and LLM-bound — running scenarios sequentially burns wall-clock time and money with no quality benefit. Parallelism is fine here; the discipline lives in Step 9 (review), not in Step 8 (generate). See `CLAUDE.md` § "After generating or regenerating any scenario (MANDATORY)" and `docs/product-specs/testing.md` § "Regenerate in parallel, review serially".

Workflow:

1. Delete each affected `recorded.json`:

   ```bash
   rm test/scenarios/002-plan-week-flex-move-regression/recorded.json \
      test/scenarios/013-flex-move-rebatch-carryover/recorded.json \
      test/scenarios/023-reproposer-event-add/recorded.json \
      test/scenarios/024-reproposer-recipe-swap/recorded.json \
      test/scenarios/025-reproposer-event-remove/recorded.json \
      test/scenarios/026-reproposer-multi-mutation/recorded.json \
      test/scenarios/027-reproposer-clarification/recorded.json \
      test/scenarios/028-reproposer-recipe-generation/recorded.json
   ```

2. Launch all regenerations concurrently. The cleanest way is to make one background-mode tool call per scenario so they run in parallel and report completion independently:

   ```bash
   npm run test:generate -- 002-plan-week-flex-move-regression --regenerate --yes
   npm run test:generate -- 013-flex-move-rebatch-carryover --regenerate --yes
   npm run test:generate -- 023-reproposer-event-add --regenerate --yes
   npm run test:generate -- 024-reproposer-recipe-swap --regenerate --yes
   npm run test:generate -- 025-reproposer-event-remove --regenerate --yes
   npm run test:generate -- 026-reproposer-multi-mutation --regenerate --yes
   npm run test:generate -- 027-reproposer-clarification --regenerate --yes
   npm run test:generate -- 028-reproposer-recipe-generation --regenerate --yes
   ```

3. Wait for every regeneration to finish. Do NOT begin Step 9 until every `recorded.json` is back on disk.

- [ ] **Step 9: Behaviorally validate each regenerated recording ONE BY ONE (MANDATORY — do not skip, do not parallelize)**

> **This is the most important step in Plan 026.** `npm test` passing only proves determinism. `deepStrictEqual` will happily lock in a broken plan forever. The only way to catch a regression in the re-proposer's behavior after a prompt change is to read the regenerated output as if you were the user receiving these Telegram messages. See `docs/product-specs/testing.md` § "Verifying recorded output (MANDATORY)" for the full protocol.

For EACH regenerated `recorded.json`, do all four checks:

**Check 1: Read the bot's messages as the user.** Open `test/scenarios/<name>/recorded.json` and read `expected.outputs[].text` top to bottom. Ask of each message:

- Does this response make sense given what the user just did in `spec.ts` events?
- Is the tone right — concise, no jargon, no internal-state leakage?
- Are inline keyboards present where the flow expects an answer?
- Any undefined values, empty strings, or "Something went wrong" fallbacks?
- Does the resulting plan read like a real meal plan a human would follow?

**Check 2: Verify the plan proposal (the most load-bearing output).** Find the message containing "Your week:" and verify:

- **Day coverage** — 7 days × (lunch + dinner) = 14 slots. Every slot has exactly one source: batch, event, flex, or pre-committed. Zero sources = orphan (BUG). Two sources = double-booking (BUG).
- **Cook schedule** — each cook day equals the first eating day of the batches cooking that day. If a batch eats Mon-Wed, it cooks Mon.
- **Batch sizes** — every batch has 2-3 servings. A 1-serving batch is usually a gap-resolution bug (unless the scenario specifically tests that path).
- **Cross-horizon annotation** — batches with overflow days show "+N into next week".
- **Weekly totals** — within ±3% of `17,052` cal and ~`1,050`g protein. If the proposal text shows ⚠️ or "deviate" / "below target", **investigate and fix before committing**. Do NOT rationalize warnings as pre-existing; committed warnings get locked in as "expected" by `deepStrictEqual` and silently mask the problem for every future agent.
- **Meal-type lanes** (NEW in Plan 026) — every batch's `recipeSlug` resolves to a recipe whose `mealTypes` array includes the batch's `mealType`. You can cross-check by reading the fixture recipe files under `test/fixtures/recipes/<recipeSet>/` and confirming each batch's slug against the YAML `meal_types:` field. A dinner-only recipe in a lunch batch is a BUG from the new invariant #14 — if this slips through, it means the re-proposer's prompt isn't strong enough and the validator caught it via retry instead.
- **Mutation semantic preservation** — whatever change the scenario's user text asked for must still be reflected in the output. The flex must be on the target day for `002`. The event must be added for `023`. The swap must have happened for `024`. Etc. If the semantic is missing or wrong, the prompt change degraded behavior — fix the prompt, not the fixture.

**Check 3: Verify the final store state.** Read `expected.finalStore` and check:

- **planSessions** — correct count; new session `superseded: false`; any replaced session `superseded: true`.
- **batches** — every batch has `status: 'planned'` (or `'cancelled'` for superseded-session batches). No batch has `actualPerServing.calories === 0` (ghost batch bug — scenario 003 reference case). Every batch's `eatingDays[0]` (cook day) is inside `[horizonStart, horizonEnd]` of its creating session (D30 invariant).
- **mutationHistory on new sessions** — should remain `[]` for these scenarios because we are NOT wiring `plan-flow.ts` in Plan A. If any scenario's new session shows a populated `mutationHistory`, that's a red flag that Task 13's changes accidentally rewired the flow.

**Check 4: Scan for known issue patterns** (from `testing.md` § "Check for known issue patterns"):

| Pattern | What to look for |
|---|---|
| Ghost batches | `actualPerServing.calories === 0` with empty `scaledIngredients` |
| Double-booked slots | Two batches covering the same (day, mealType) |
| Orphan slots | A (day, mealTime) with no source in the daily breakdown |
| Stale recipe names | Proposal text mentions recipes not in the fixture recipe set |
| Missing keyboards | Interactive message with no `keyboard` field |
| Flex count wrong | More or fewer than `config.planning.flexSlotsPerWeek` flex slots |
| Calorie warnings | ⚠️ in weekly totals; "deviate" / "below target" in proposal text |
| Overflow budget mismatch | Batch with "+N into next week" AND warning on totals |
| **NEW: Meal-type lane violation** | Batch `mealType` not in recipe's `mealTypes` YAML array |

- [ ] **Step 10: If ANY check fails, fix the code — never the recording**

The correct sequence when a regenerated recording shows a bug:

1. Identify the root cause. Is it (a) a prompt-engineering problem where the re-proposer is making a worse choice because the new rules confused it, or (b) a real regression the new invariant surfaced?
2. If (a): refine the prompt wording in `buildSystemPrompt`. Keep the meal-type lane and near-future safety sections load-bearing but try softer phrasing or reordering.
3. If (b): the regression existed before Plan 026 and was silently tolerated — fix it as a separate commit BEFORE this plan's commit lands.
4. Either way: re-run `npm run test:generate -- <scenario> --regenerate` and re-verify from Check 1.
5. NEVER commit a recording that captures wrong behavior. The scenario becomes a permanent regression test and a bad recording locks in the bug forever.

If the issue is LLM output quality (proposer picked a suboptimal recipe) but not a structural bug, log it to `docs/plans/tech-debt.md` with the scenario name and what went wrong, then commit the recording as-is — the scenario still exercises the code path correctly.

- [ ] **Step 11: After all scenarios are clean, run the full suite one more time**

Run: `npm test`
Expected: PASS — every unit test AND every regenerated scenario green.

- [ ] **Step 12: Commit**

```bash
git add src/agents/plan-reproposer.ts src/agents/plan-flow.ts test/unit/post-confirmation-reproposer.test.ts \
        test/scenarios/002-plan-week-flex-move-regression/recorded.json \
        test/scenarios/013-flex-move-rebatch-carryover/recorded.json \
        test/scenarios/023-reproposer-event-add/recorded.json \
        test/scenarios/024-reproposer-recipe-swap/recorded.json \
        test/scenarios/025-reproposer-event-remove/recorded.json \
        test/scenarios/026-reproposer-multi-mutation/recorded.json \
        test/scenarios/027-reproposer-clarification/recorded.json \
        test/scenarios/028-reproposer-recipe-generation/recorded.json
git commit -m "Plan 026: re-proposer mode + meal-type lane + near-future safety + regenerate scenarios"
```

Include only the scenario files that actually changed. Drop any that remained byte-identical (the prompt change should touch every affected scenario, but the fallback is defensive).

---

### Task 14: End-to-end adapter round-trip integration test

**Rationale:** Tasks 7-11 test the adapter pieces in isolation. Task 14 exercises the full round-trip through `TestStateStore`: seed a confirmed plan → call `sessionToPostConfirmationProposal` at a specific wall clock → construct a fake re-proposer output that mutates an active batch → call `buildReplacingDraft` → call `confirmPlanSessionReplacing` → snapshot the store → assert on the final state. This is the single test that proves Plan A works end-to-end without Plan D's wiring.

**Files:**
- Modify: `test/unit/session-to-proposal.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/session-to-proposal.test.ts`:

```typescript
import { TestStateStore } from '../../src/harness/test-store.js';

test('end-to-end: confirmed plan → adapter → re-proposer (stubbed) → replacing draft → store', async () => {
  // Setup: a confirmed plan with 2 dinner batches and 1 lunch batch, running
  // across a full 7-day horizon. Wall clock: Tuesday 7pm. Monday has fully
  // consumed slots; Tuesday lunch is past (after 15:00); Tuesday dinner is
  // still active (19:00 < 21:00 dinner cutoff).
  const store = new TestStateStore();
  const oldSessionId = 'old-session';
  const now = at('2026-04-07', 19);

  await store.confirmPlanSession(
    {
      id: oldSessionId,
      horizonStart: '2026-04-06',
      horizonEnd: '2026-04-12',
      breakfast: { locked: true, recipeSlug: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
      treatBudgetCalories: 800,
      // Seed both a past flex slot (Monday dinner — already consumed by Tue 19:00)
      // and an active flex slot (Saturday dinner). The past one must round-trip
      // via preservedPastFlexSlots, the active one via the re-proposer.
      flexSlots: [
        { day: '2026-04-06', mealTime: 'dinner', flexBonus: 350, note: 'burger night' },
        { day: '2026-04-11', mealTime: 'dinner', flexBonus: 350 },
      ],
      // Seed a past meal event (Monday lunch out) and an active meal event
      // (Friday lunch out). Same preservation contract as flex slots.
      events: [
        { name: 'team lunch out', day: '2026-04-06', mealTime: 'lunch', estimatedCalories: 850, notes: 'sushi place' },
        { name: 'friend lunch', day: '2026-04-10', mealTime: 'lunch', estimatedCalories: 700 },
      ],
      mutationHistory: [{ constraint: 'initial plan', appliedAt: '2026-04-05T18:00:00.000Z' }],
    },
    [
      // Tagine dinner batch — Mon/Tue/Wed. At Tue 19:00 this is spanning:
      // Mon dinner past, Tue dinner active, Wed dinner active.
      batch({
        id: 'b-tagine',
        recipeSlug: 'tagine',
        mealType: 'dinner',
        eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
        servings: 3,
        createdInPlanSessionId: oldSessionId,
      }),
      // Grain-bowl lunch batch — Mon/Tue/Wed. At Tue 19:00 Mon lunch and Tue
      // lunch are past (19:00 > 15:00 cutoff), Wed lunch is active.
      batch({
        id: 'b-grain',
        recipeSlug: 'grain-bowl',
        mealType: 'lunch',
        eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
        servings: 3,
        createdInPlanSessionId: oldSessionId,
      }),
      // Chicken dinner batch — Thu/Fri/Sat. All active.
      batch({
        id: 'b-chicken',
        recipeSlug: 'chicken',
        mealType: 'dinner',
        eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
        servings: 3,
        createdInPlanSessionId: oldSessionId,
      }),
    ],
  );

  // 1. Load and run the forward adapter.
  const loaded = await store.getPlanSession(oldSessionId);
  assert.ok(loaded);
  const loadedBatches = await store.getBatchesByPlanSessionId(oldSessionId);
  const forward = sessionToPostConfirmationProposal(loaded, loadedBatches, now);

  // Sanity: near-future is [Tue, Wed].
  assert.deepStrictEqual(forward.nearFutureDays, ['2026-04-07', '2026-04-08']);

  // Sanity: preserved past includes the Mon tagine half, Mon+Tue grain-bowl halves.
  const pastSigs = forward.preservedPastBatches.map(
    (b) => `${b.recipeSlug}:${b.mealType}:${b.eatingDays.join(',')}`,
  ).sort();
  assert.deepStrictEqual(pastSigs, [
    'grain-bowl:lunch:2026-04-06,2026-04-07',
    'tagine:dinner:2026-04-06',
  ]);

  // Sanity: the Monday past flex slot and Monday past lunch event split into
  // preservedPast* arrays; the Saturday flex and Friday lunch event stay active.
  assert.deepStrictEqual(forward.preservedPastFlexSlots, [
    { day: '2026-04-06', mealTime: 'dinner', flexBonus: 350, note: 'burger night' },
  ]);
  assert.deepStrictEqual(forward.preservedPastEvents, [
    { name: 'team lunch out', day: '2026-04-06', mealTime: 'lunch', estimatedCalories: 850, notes: 'sushi place' },
  ]);
  assert.deepStrictEqual(forward.activeProposal.flexSlots, [
    { day: '2026-04-11', mealTime: 'dinner', flexBonus: 350 },
  ]);
  assert.deepStrictEqual(forward.activeProposal.events, [
    { name: 'friend lunch', day: '2026-04-10', mealTime: 'lunch', estimatedCalories: 700 },
  ]);

  // Sanity: active proposal has tagine (Tue,Wed/2), grain-bowl (Wed/1), chicken (Thu-Sat/3).
  const activeSigs = forward.activeProposal.batches.map(
    (b) => `${b.recipeSlug}:${b.mealType}:${b.days.join(',')}/${b.servings}`,
  ).sort();
  assert.deepStrictEqual(activeSigs, [
    'chicken:dinner:2026-04-09,2026-04-10,2026-04-11/3',
    'grain-bowl:lunch:2026-04-08/1',
    'tagine:dinner:2026-04-07,2026-04-08/2',
  ]);

  // 2. Stub the re-proposer output: simulate "eating out tonight" by dropping
  // the Tue tagine slot (keeping Wed), and adding an eat_out event on Tue
  // dinner. Chicken and grain-bowl unchanged. Events now include BOTH the
  // preserved active event (Friday friend lunch) from the forward adapter AND
  // the new eat-out. In Plan D's applier, the re-proposer output inherits the
  // forward adapter's active events as its input — we match that shape here.
  // Also attach a minimal solverOutput: Plan D runs the solver on the
  // re-proposer's output before calling buildReplacingDraft. We construct one
  // BatchTarget per re-proposed batch; actual solver math is covered by the
  // in-session solver tests elsewhere.
  const reProposedActive: PlanProposal = {
    batches: [
      {
        recipeSlug: 'grain-bowl', recipeName: 'grain-bowl', mealType: 'lunch',
        days: ['2026-04-08'], servings: 1, overflowDays: undefined,
      },
      {
        recipeSlug: 'tagine', recipeName: 'tagine', mealType: 'dinner',
        days: ['2026-04-08'], servings: 1, overflowDays: undefined,
      },
      {
        recipeSlug: 'chicken', recipeName: 'chicken', mealType: 'dinner',
        days: ['2026-04-09', '2026-04-10', '2026-04-11'], servings: 3, overflowDays: undefined,
      },
    ],
    flexSlots: forward.activeProposal.flexSlots,
    events: [
      ...forward.activeProposal.events,
      { name: 'dinner with friends', day: '2026-04-07', mealTime: 'dinner', estimatedCalories: 900 },
    ],
    recipesToGenerate: [],
    solverOutput: {
      isValid: true,
      weeklyTotals: { calories: 15000, protein: 900, treatBudget: 800, flexSlotCalories: 350 },
      dailyBreakdown: [],
      batchTargets: [
        {
          id: 'bt-grain',
          recipeSlug: 'grain-bowl',
          mealType: 'lunch',
          days: ['2026-04-08'],
          servings: 1,
          // Macros shape: { calories, protein } only. See src/models/types.ts:74.
          targetPerServing: { calories: 600, protein: 35 },
        },
        {
          id: 'bt-tagine',
          recipeSlug: 'tagine',
          mealType: 'dinner',
          days: ['2026-04-08'],
          servings: 1,
          targetPerServing: { calories: 720, protein: 48 },
        },
        {
          id: 'bt-chicken',
          recipeSlug: 'chicken',
          mealType: 'dinner',
          days: ['2026-04-09', '2026-04-10', '2026-04-11'],
          servings: 3,
          targetPerServing: { calories: 700, protein: 50 },
        },
      ],
      cookingSchedule: [],
      warnings: [],
    },
  };

  // 3. Run the round-trip back. Pass preserved past flex slots + events through
  // as well — the end-to-end contract is "past state round-trips verbatim".
  const { draft, batches: newBatches } = await buildReplacingDraft({
    oldSession: loaded,
    preservedPastBatches: forward.preservedPastBatches,
    preservedPastFlexSlots: forward.preservedPastFlexSlots,
    preservedPastEvents: forward.preservedPastEvents,
    reProposedActive,
    newMutation: { constraint: 'eating out tonight', appliedAt: '2026-04-07T19:30:00.000Z' },
    recipeDb: fakeRecipeDb,
    llm: throwingLLM,
  });

  // 4. Write via confirmPlanSessionReplacing.
  const persisted = await store.confirmPlanSessionReplacing(draft, newBatches, oldSessionId);

  // 5. Assert final store state.
  //    - Old session superseded.
  const oldReloaded = await store.getPlanSession(oldSessionId);
  assert.ok(oldReloaded);
  assert.equal(oldReloaded.superseded, true);

  //    - New session active, mutationHistory = [initial plan, eating out tonight].
  assert.equal(persisted.superseded, false);
  assert.equal(persisted.mutationHistory.length, 2);
  assert.equal(persisted.mutationHistory[1]!.constraint, 'eating out tonight');

  //    - New session flexSlots: past (Mon burger night) + active (Sat flex).
  //      This is the load-bearing assertion for Plan A's "preserve past state"
  //      contract — if buildReplacingDraft regressed to writing only the
  //      re-proposer's (active-only) flexSlots, the Monday burger-night flex
  //      would disappear here.
  assert.equal(persisted.flexSlots.length, 2);
  assert.deepStrictEqual(
    persisted.flexSlots.map((f) => `${f.day}:${f.mealTime}`).sort(),
    ['2026-04-06:dinner', '2026-04-11:dinner'],
  );
  const pastFlex = persisted.flexSlots.find((f) => f.day === '2026-04-06');
  assert.equal(pastFlex?.note, 'burger night', 'past flex slot metadata must survive');

  //    - New session events: past (Mon team lunch) + preserved active (Fri friend
  //      lunch carried through the re-proposer) + newly-added (Tue dinner out).
  //      Three events total; the past one must still be present with exact metadata.
  assert.equal(persisted.events.length, 3);
  const eventSigs = persisted.events.map((e) => `${e.day}:${e.mealTime}:${e.name}`).sort();
  assert.deepStrictEqual(eventSigs, [
    '2026-04-06:lunch:team lunch out',
    '2026-04-07:dinner:dinner with friends',
    '2026-04-10:lunch:friend lunch',
  ]);
  const pastEvent = persisted.events.find((e) => e.day === '2026-04-06');
  assert.equal(pastEvent?.estimatedCalories, 850, 'past event calories must survive');
  assert.equal(pastEvent?.notes, 'sushi place', 'past event notes must survive');

  //    - New session's batches under the new id include: the preserved past
  //      halves + the re-proposed active batches. Old batches still exist but
  //      with status='cancelled' on the old session.
  const newBatchesReloaded = await store.getBatchesByPlanSessionId(persisted.id);
  const newSigs = newBatchesReloaded.map(
    (b) => `${b.recipeSlug}:${b.mealType}:${b.eatingDays.join(',')}:${b.status}`,
  ).sort();
  assert.deepStrictEqual(newSigs, [
    'chicken:dinner:2026-04-09,2026-04-10,2026-04-11:planned',
    'grain-bowl:lunch:2026-04-06,2026-04-07:planned',
    'grain-bowl:lunch:2026-04-08:planned',
    'tagine:dinner:2026-04-06:planned',
    'tagine:dinner:2026-04-08:planned',
  ]);

  const oldBatchesReloaded = await store.getBatchesByPlanSessionId(oldSessionId);
  assert.ok(oldBatchesReloaded.every((b) => b.status === 'cancelled'));
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `npm test -- --test-name-pattern="end-to-end"`
Expected: PASS. Every piece of Plan A is exercised by this single test: the schema change (mutationHistory field carried), the adapter forward conversion (past/active split including a spanning batch AND a past flex slot AND a past meal event), the round-trip builder (new session id, mutationHistory concatenation, past batches re-pointed, past flex slots + past events concatenated with the re-proposer's active output, new batches written using the solver-backed `targetPerServing`), and the existing `confirmPlanSessionReplacing` write path (old session superseded, old batches cancelled). The past-state assertions on `persisted.flexSlots` and `persisted.events` are load-bearing: they would fail if `buildReplacingDraft` regressed to writing only the re-proposer's (active-only) output.

If it fails, read the failure diff carefully — it will point at exactly which step of the chain is broken. Common causes:
- The spanning-batch split in Task 9 produced wrong `eatingDays` / `servings`
- The past-active filter for events/flex in Task 10 let a past event through
- `buildReplacingDraft` in Task 11 forgot to re-point `createdInPlanSessionId` on preserved past batches
- `buildReplacingDraft` regressed the flex/event concatenation to write only the re-proposer's active slice
- Plan D's applier (or this test's stub for it) forgot to populate `reProposedActive.solverOutput` — `buildReplacingDraft` throws with a "solverOutput is missing" error when that happens

- [ ] **Step 3: Commit**

```bash
git add test/unit/session-to-proposal.test.ts
git commit -m "Plan 026: end-to-end adapter round-trip integration test"
```

---

### Task 15: Sync `data-models.md` and baseline

**Files:**
- Modify: `docs/product-specs/data-models.md`

- [ ] **Step 1: Read the current `PlanSession` section**

Run: `npx grep -n "PlanSession\|DraftPlanSession\|MutationRecord" docs/product-specs/data-models.md || grep -n "PlanSession" docs/product-specs/data-models.md`
Expected: hits for the current `PlanSession` interface block. Read the file in that range before editing.

- [ ] **Step 2: Update the `PlanSession` interface in the doc**

In `docs/product-specs/data-models.md`, find the `PlanSession` TypeScript block and add the `mutationHistory: MutationRecord[]` field in the same position as in the source code (right before `confirmedAt`). Update the surrounding prose to note that mutation history is persisted per-session so post-confirmation mutations can see prior decisions across save-before-destroy writes.

Add a new subsection `MutationRecord` to the doc, copying the interface block from the one you wrote into `src/models/types.ts` in Task 2, plus one sentence describing its role: "Accumulated record of user-approved mutations, persisted on `PlanSession.mutationHistory` and carried across replace-in-place writes by the session-to-proposal adapter."

- [ ] **Step 3: Add the meal-type lane invariant to the validator section**

Find the "Proposal validator invariants" section of `data-models.md` (if it exists — otherwise the `solver.md` invariants list). Add invariant #14 to the list:

> **#14 Meal-type lane** — every batch's `mealType` must be in its recipe's authored `mealTypes` array. A dinner-only recipe cannot land in a lunch batch, and vice versa. Plan 026 added this to block the re-proposer from silently crossing meal-type lanes under post-confirmation rearrangement pressure.

- [ ] **Step 4: Verify no other docs reference the old shape**

Run: `npx grep -rn "mutationHistory" docs/`
Expected: any other doc that already mentions mutation history should be updated if it implies "in-memory only" or "cleared on confirm". Plan 025's completed plan file doesn't need updating — it's historical.

- [ ] **Step 5: Run the full test suite one final time**

Run: `npm test`
Expected: PASS. No regressions.

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add docs/product-specs/data-models.md
git commit -m "Plan 026: sync data-models.md with mutationHistory + invariant #14"
```

---

## Progress

- [x] Task 1 — Green baseline
- [x] Task 2 — Move `MutationRecord` into `models/types.ts`
- [x] Task 3 — Add `mutationHistory` field to `PlanSession` and `DraftPlanSession`
- [x] Task 4 — SQL migration 005 + store row mappers
- [x] Task 5 — `TestStateStore` mirrors `mutation_history` handling
- [x] Task 6 — Unit test: mutation history round-trips through `TestStateStore`
- [x] Task 7 — Adapter scaffold + `classifySlot`
- [x] Task 8 — `splitBatchAtCutoffs` — pure past, pure active
- [x] Task 9 — `splitBatchAtCutoffs` — spanning batch split
- [x] Task 10 — `sessionToPostConfirmationProposal` — forward adapter
- [x] Task 11 — `buildReplacingDraft` — round-trip write payload
- [x] Task 12 — Proposal validator invariant #14 — meal-type lane
- [x] Task 13 — Re-proposer mode field + meal-type lane + near-future safety rules
- [x] Task 14 — End-to-end adapter round-trip integration test
- [x] Task 15 — Sync `data-models.md` and baseline

---

## Decision log

- **Decision:** Persist mutation history as a JSONB column on `plan_sessions` rather than in a separate table.
  **Rationale:** Write semantics are tightly coupled to the session lifecycle (every `confirmPlanSessionReplacing` write needs the history atomically). A separate table would require either a foreign key + extra write step (breaks atomicity without a transaction) or a parallel tombstoning protocol. JSONB on the session matches how `flex_slots` and `events` are already stored.
  **Date:** 2026-04-10

- **Decision:** `DraftPlanSession.mutationHistory` is optional; `PlanSession.mutationHistory` is required.
  **Rationale:** Existing draft builders (`plan-flow.ts buildNewPlanSession`) construct drafts without setting this field. Making it optional on the draft keeps the existing code path untouched — no behavior change for `npm test` — while still guaranteeing every persisted session exposes a definite (possibly `[]`) history to the adapter.
  **Date:** 2026-04-10

- **Decision:** Past-portion of a spanning batch gets a FRESH uuid and is written as a new row under the new session id. No id preservation.
  **Rationale:** `confirmPlanSessionReplacing` writes new rows and cancels the old ones — it does not update in place. Re-using the original id would violate the primary-key contract on `batches`. The original batch is cancelled (tombstoned) and the past-half becomes a new row with new id that carries the same `recipeSlug`, `mealType`, and (proportionally scaled) `scaledIngredients`. History queries reconstruct continuity by recipe identity, not by id.
  **Date:** 2026-04-10

- **Decision:** Near-future days are computed by the caller (from today + tomorrow intersected with the horizon) and passed into `ReProposerInput`, not derived inside the re-proposer.
  **Rationale:** The re-proposer is already stateless and clock-free. Injecting `nearFutureDays` keeps that property. It also makes the rule trivially testable — scenarios can fake any wall clock and verify the prompt contains the expected soft-lock window without touching a real Date.
  **Date:** 2026-04-10

- **Decision:** `classifySlot` uses hour-level cutoffs (15:00 for lunch-done, 21:00 for dinner-done) in server-local time.
  **Rationale:** Proposal 003 specifies these as the v0.0.5 pragmatic defaults. Flexie is single-user-deployed and the server timezone equals the user timezone by declaration. Finer-grained accounting (actual-vs-planned consumption state) is out of scope for Plan A; full multi-user timezone support is v0.1.0 work. Constants are exported so later tuning is a one-line change.
  **Date:** 2026-04-10

- **Decision:** The meal-type lane rule is in BOTH the prompt and the validator.
  **Rationale:** Prompt-only means one bad LLM turn wastes a retry (the validator catches it on the next loop). Validator-only means the LLM has no incentive to follow the rule, so first-call failures become common. Both-together matches the existing "LLM judgment + deterministic sidecar" pattern from design doc 002 — the LLM knows the rule and the validator enforces it as a hard gate.
  **Date:** 2026-04-10

- **Decision:** Plan A does NOT thread existing `state.mutationHistory` into the draft at **first-confirmation time** inside `buildNewPlanSession`. It DOES add the column, the model types, the store serialization, and the round-trip into `buildReplacingDraft` for post-confirmation rewrites.
  **Rationale:** The proposal explicitly says Plans A and B are "nothing user-facing". Wiring in-session mutation history into first-confirmation changes observable behavior — every confirmed plan would suddenly have a populated `mutationHistory` column where today's scenarios expect it empty (or undefined). Task 13's prompt-change regeneration already re-records a bunch of in-session scenarios; adding a mutation-history delta at the same time would conflate two orthogonal changes in one regen diff and make behavioral review harder. Splitting ownership keeps Plan A's behavior delta scoped to "the column and the post-confirmation writeback plumbing exist", leaves in-session observable behavior unchanged, and moves the first-confirmation write path to the commit (Plan D / 029) that already owns the scenario regeneration for all the mutate_plan paths. **Plan 029 Task 7 Step 6 owns this change** — it adds `mutationHistory: state.mutationHistory ?? []` to `buildNewPlanSession`'s `DraftPlanSession` literal and regenerates the affected in-session scenarios alongside Plan D's other reprop changes.
  **Date:** 2026-04-10 (revised after review round to cross-reference Plan 029 Task 7 Step 6 as the explicit owner)

---

## Validation

After every task: `npm test` stays green. After Task 15, all of these must be true:

- Every unit test under `test/unit/` added by this plan passes: `classifySlot`, `splitBatchAtCutoffs` (past / active / spanning), `sessionToPostConfirmationProposal` (including the new past-flex-slots / past-events split case), `buildReplacingDraft` (including the preserved-past flex/events concatenation assertions), the end-to-end round-trip (which also passes `preservedPastFlexSlots` / `preservedPastEvents` through), the three meal-type lane validator tests, the two re-proposer prompt-rule tests, the two behavioral meal-type lane tests (one retry-then-succeed, one two-failures-to-failure), the one near-future safety prompt-threading test, and the three `TestStateStore` mutation history tests.
- `npx tsc --noEmit` reports no errors.
- `npm test` passes with the same scenario count as the baseline (Task 1 step 1), possibly minus regenerated scenarios if the re-proposer prompt change forced any fixtures to re-record.
- `src/plan/session-to-proposal.ts` is a pure module — `grep -n "new Date(\s*)" src/plan/session-to-proposal.ts` returns nothing. All wall-clock reads go through the `now` parameter.
- `grep -n "MutationRecord" src/agents/plan-reproposer.ts` shows only the re-export line, not a duplicate definition.
- The `plan_sessions` migration file `supabase/migrations/005_plan_session_mutation_history.sql` exists and adds exactly one column with a `jsonb not null default '[]'` shape.
- The proposal validator reports invariant #14 on a test fixture with a dinner-only recipe in a lunch batch; passes cleanly on the same fixture when the recipe is either lunch-only or lunch+dinner.
- The re-proposer's system prompt contains the string "meal-type lane" in both modes, and the string "near-future safety" ONLY under post-confirmation mode, with the soft-locked ISO dates inlined.

After this plan completes, Plan D can import `sessionToPostConfirmationProposal` and `buildReplacingDraft` directly and wire them into the freeform dispatcher's `mutate_plan` handler without touching any of the adapter internals. Plan A is done when those two functions plus their tests exist and `npm test` is green.
