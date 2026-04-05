# Plan 008: Cook day equals first eating day (pre-Monday hotfix)

**Status:** Completed
**Date:** 2026-04-05
**Affects:** `src/solver/solver.ts`, `src/qa/validators/plan.ts`, `docs/product-specs/solver.md`, `test/scenarios/001-plan-week-happy-path/`, `test/scenarios/002-plan-week-flex-move-regression/`, `test/scenarios/003-plan-week-minimal-recipes/`

---

## Problem

`src/solver/solver.ts:307` hardcodes `const cookDay = dayBefore(firstEatDay);` — every batch is scheduled to be cooked on the day *before* its first eating day (the classic "cook the night before" pattern). The user does not cook that way. From the design discussion: *"I always cook on the day when the batch starts. If I cook on Sunday, this is what I will eat on Sunday. I never cook on Sunday to first eat it on Monday, because I want my food always to be fresh, as fresh as possible."*

If v0.0.4 ships Monday with the current behavior, the user opens the bot, sees `Cook Sun: Chicken (lunch Mon-Tue-Wed)` — a cook schedule that doesn't match their actual weekly ritual — and immediately loses trust in every subsequent signal. The whole value proposition of Flexie is *trust-me-I-will-guide-you*; a wrong cook schedule on day one breaks that on day one.

This is a symptom of a deeper architectural issue (the weekly silo + denormalized `CookDay` persistence) that is being addressed by Plan 007 — but Plan 007 is a multi-day refactor. This hotfix lands the one-line behavioral change that keeps v0.0.4 shippable Monday, independent of Plan 007's timeline.

## Scope

**In scope**: flip the cook-day rule from "day before first eating day" to "first eating day," clean up the dead code and stale comments around the old rule, re-record the 3 existing scenarios, keep `npm test` green.

**Not in scope** (explicitly deferred to Plan 007):
- First-class batches / `batches` Supabase table.
- Rolling horizons / variable `horizonStart`.
- Cross-horizon batches (batches whose `eatingDays` extend past horizon end).
- Pre-committed slots from prior sessions.
- Swap-handler cross-horizon extension.
- Removing persisted `CookDay` / `MealSlot` types.
- Any `PlanSession` / `PlannedBatch` renaming or type rewrites.

Every architectural improvement stays in Plan 007. This hotfix touches behavior only: it makes the solver's `buildCookingSchedule` output the correct cook day.

---

## Plan of work

### 1. `src/solver/solver.ts:300-317` — flip the rule

Current code:
```typescript
function buildCookingSchedule(batchTargets: BatchTarget[]): CookingScheduleDay[] {
  const scheduleMap = new Map<string, string[]>();

  for (const batch of batchTargets) {
    if (batch.days.length === 0) continue;
    // Cook day = the day before the first eating day, or the first eating day itself
    const firstEatDay = batch.days[0]!;
    const cookDay = dayBefore(firstEatDay);

    const existing = scheduleMap.get(cookDay) ?? [];
    existing.push(batch.id);
    scheduleMap.set(cookDay, existing);
  }
  ...
}
```

New code:
```typescript
function buildCookingSchedule(batchTargets: BatchTarget[]): CookingScheduleDay[] {
  const scheduleMap = new Map<string, string[]>();

  for (const batch of batchTargets) {
    if (batch.days.length === 0) continue;
    // Cook day = first eating day. The user cooks fresh on the day a batch
    // starts being eaten, not the night before — protecting freshness across
    // the 2-3 day batch window. See docs/plans/active/008-cook-day-hotfix.md.
    const cookDay = batch.days[0]!;

    const existing = scheduleMap.get(cookDay) ?? [];
    existing.push(batch.id);
    scheduleMap.set(cookDay, existing);
  }
  ...
}
```

Functional change: one line. Comment: rewritten from the two-minded "or the first eating day itself" wording to a clear statement of the rule plus a pointer to this plan.

### 2. `src/solver/solver.ts:318-332` — delete dead helpers

After step 1, `dayBefore` has zero callers (verified — it was the only call site at line 307). `toLocalISODate` is only called by `dayBefore` inside `solver.ts` (also verified — the plan-proposer has its own copy of `toLocalISODate` which is unaffected). Delete both functions from `solver.ts` in the same commit as the rule flip so the file doesn't carry dead code.

Lines to remove:
- `function dayBefore(isoDate: string): string { ... }` (lines 319–324 plus the preceding comment)
- `function toLocalISODate(d: Date): string { ... }` (lines 326–332 plus its doc comment)

### 3. `src/qa/validators/plan.ts:85` — update stale comment

Current comment at line 85 says `// Cooking days must be before eating days`. The strict `>` check at line 91 (`if (firstEatDay && cookDay.day > firstEatDay)`) continues to pass when `cookDay === firstEatDay`, so **no functional change** is needed. But the comment is now misleading.

Change line 85 from:
```typescript
// Cooking days must be before eating days
```
to:
```typescript
// Cooking days must not be AFTER the first eating day. Cook day === first
// eating day is valid (Plan 008) — the strict `>` check below enforces this.
```

Also update the class doc block at line 14 if it mentions the old rule (`// - Cooking days are before eating days`) — change to `// - Cook day is on or before the first eating day`.

### 4. `docs/product-specs/solver.md` — docs in lock-step

Two updates in `docs/product-specs/solver.md`:

- **Line 69** (`## Cooking schedule` section): change `Strategy: cook each batch the day before the first eating day. Groups batches that cook on the same day.` to `Strategy: cook each batch on the first eating day itself. The user cooks fresh on the day a batch starts being eaten, not the night before, to protect freshness across the 2–3 day window. Groups batches that cook on the same day.`
- **Line 74** (in the QA gate bullet list): change `Cooking days must be before eating days` to `Cook day must not be after the first eating day (cook day === first eating day is valid)`.

### 5. Re-record the 3 existing scenarios

All three scenarios have `Cook:` sections in their captured output whose dates shift by exactly one day (forward) under the new rule. Regenerate them:

```bash
npm run test:generate -- 001-plan-week-happy-path --regenerate
npm run test:generate -- 002-plan-week-flex-move-regression --regenerate
npm run test:generate -- 003-plan-week-minimal-recipes --regenerate
```

Review the `git diff` on each `recorded.json` to confirm that ONLY the cook-day dates change. If any other fields drift (batch targets, day breakdowns, weekly totals, other solver outputs), investigate — they should all be stable. The validator still passes because the strict-`>` check admits `cookDay === firstEatDay`.

No new scenarios are added in this hotfix. Plan 007 adds the rolling-horizons scenarios later.

---

## Progress

- [x] Step 1: `solver.ts:307` — flip rule, fix comment
- [x] Step 2: `solver.ts` — delete `dayBefore` + `toLocalISODate` (dead after step 1)
- [x] Step 3: `plan.ts:14, 85` — update stale comments (no functional change)
- [x] Step 4: `solver.md:69, 74` — docs match new rule
- [x] Step 5: Re-record scenarios 001, 002, 003 — verify diff only affects cook-day dates
  - **Deviation from plan text:** Used `FixtureLLMProvider` replay-and-rewrite via a throwaway tsx script instead of `npm run test:generate -- … --regenerate`. Rationale: verified (via grep) that no LLM prompt embeds cook-day dates — only `plan-proposer.ts:395` uses `plan.cookDays` at all, and it extracts recipe slugs/cuisines/proteins, not dates. So the existing `llmFixtures` were fully reusable. Calling the real LLM would have (a) burned API credits and (b) introduced LLM-response drift that would have made the plan's "ONLY cook-day dates change" verification step impossible. The replay path gave a perfectly clean diff: every changed line is either a cook-day ISO date shifting by exactly +1 day or a `Cook:` section line in the proposal text (Sun→Mon, Tue→Wed, Wed→Thu, Fri→Sat, Sat→Sun). Zero drift in batch targets, recipes, calories, protein, daily breakdowns, weekly totals, or flex bonuses.
- [x] `npm run build` clean
- [x] `npm test` green (40/40 passing against rewritten recordings)
- [x] Manual Telegram smoke test: plan one week via `npm run dev`, confirm the `Cook:` section shows cook days matching the first eating day of each batch
- [x] Single commit to `master` before Monday 2026-04-06

---

## Decision log

- **Decision**: Ship as a 1-commit hotfix, separate from Plan 007.
  **Rationale**: The behavioral fix is one line. Plan 007 is a multi-phase refactor targeting the same destination (`cookDay === batch.eatingDays[0]`) but via first-class batches and rolling horizons. Bundling the two would concentrate risk against the Monday deadline for no architectural gain — the small fix and the big refactor have independent ship criteria. See Plan 007 D22 for the full framing.
  **Date**: 2026-04-05

- **Decision**: Delete `dayBefore` and `solver.ts`'s local `toLocalISODate` rather than leaving them as dead code.
  **Rationale**: Leaving dead helpers invites future confusion (next agent sees `dayBefore` and wonders why it exists; may reintroduce the old behavior). Verified both are unused after step 1 — `dayBefore` has exactly one caller at line 307, and `toLocalISODate` is only called by `dayBefore` within solver.ts. The plan-proposer's own `toLocalISODate` copy is independent and stays.
  **Date**: 2026-04-05

- **Decision**: Don't touch the validator's strict-`>` check at `plan.ts:91`.
  **Rationale**: The check already admits `cookDay === firstEatDay` correctly. The only issue was the stale comment on line 85, which is comment-only. Keeping the check unchanged minimizes blast radius.
  **Date**: 2026-04-05

- **Decision**: No new scenarios in this plan. Only re-record existing ones.
  **Rationale**: The three existing scenarios already exercise the cook-day rendering path. Re-recording them is sufficient to lock in the new behavior as a regression test. New scenarios covering rolling-horizon behavior belong to Plan 007.
  **Date**: 2026-04-05

---

## Validation

### Build and test gates

1. `npm run build` — zero TypeScript errors (deleting `dayBefore` / `toLocalISODate` should have no effect on the type system; verify there are no stray imports).
2. `npm test` — all 3 scenarios pass against the regenerated recordings.
3. `git diff test/scenarios/*/recorded.json` — every changed field should be cook-day-related. No drift in batch targets, daily breakdowns, weekly totals, proposer output, or any other captured state. If drift is seen, investigate before committing — it means the "1-line fix" has wider blast radius than expected.

### Manual Telegram smoke test

`DEBUG=1 npm run dev`, run the first-plan flow once through:

1. Tap `📋 Plan Week`.
2. Keep breakfast, no events.
3. Wait for the proposal.
4. Read the `Cook:` section carefully. Every cook day should equal the first day of its batch's eating range. For example, if a batch lists `Lunch Mon-Wed`, the cook day shown should be `Mon`, NOT `Sun`.
5. Tap `Approve` to confirm the plan persists without errors.

This takes ~2 minutes and is cheap insurance against a rendering path the scenarios don't cover (scenarios replay fixtures; real Telegram exercises the actual cook-section formatting against real solver output).

### Out-of-band verification

After the commit lands, `tail -100 logs/debug.log` and look for `[AI:REQ] ... context=plan-proposal` — the cook schedule in the proposer's output should already be consistent (the proposer doesn't control cook day assignment; the solver does). No warnings or QA validation errors should appear.

---

## Relationship to Plan 007

This hotfix and Plan 007 share a destination (`cookDay === batch.eatingDays[0]`) but solve different slices of the problem:

- **Plan 008 (this plan)**: the behavioral fix. Changes the date the solver outputs for cook days. Ships independently before Monday. Leaves the weekly silo, embedded `CookDay` type, and `dayBefore`-style assumptions everywhere else intact.
- **Plan 007**: the architectural fix. Removes `CookDay` as a persisted type, makes cook days derived at display time (`groupBy(batches, b => b.eatingDays[0])`), introduces first-class batches and rolling horizons. Subsumes this hotfix's rule as a structural invariant rather than a hardcoded line.

When Plan 007 lands, the code changed by this hotfix (specifically the `buildCookingSchedule` function) is deleted entirely (Plan 007 Phase 7b step 6 drops `buildCookingSchedule` along with the `cookingSchedule` output field). That's expected — this hotfix is scaffolding for the interim. No cleanup needed during Plan 007; the deletion is already on Plan 007's cleanup checklist.
