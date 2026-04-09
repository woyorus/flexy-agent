# Plan 021: Future plan visibility

**Status:** Completed
**Date:** 2026-04-08
**Affects:** `src/plan/helpers.ts`, `src/state/store.ts`, `src/harness/test-store.ts`, `src/telegram/core.ts`, `src/telegram/formatters.ts`, `src/agents/plan-flow.ts`
**Design:** `docs/design-docs/proposals/001-upcoming-plan-visibility.md`

## Problem

A confirmed plan with a future start date is completely invisible. The user creates a plan (e.g., Apr 8–14 while today is Apr 7), and then:
- Menu shows "Plan Week" instead of "My Plan"
- Shopping List says "No plan yet"
- No way to view meals, cook days, or the week overview

This violates JTBD A1 (know my next action), A2 (shopping list), and A4 (browse week). The user planned and the product gives nothing back.

**Root cause:** `getRunningPlanSession(today)` requires `horizon_start <= today <= horizon_end`. A future plan fails this check → lifecycle = `no_plan` → everything cascades.

**Secondary issue:** `getFuturePlanSessions()` and `getLatestHistoricalPlanSession()` use `new Date()` internally instead of accepting a caller-provided `today`. In Spain (UTC+1/+2) this causes off-by-one near midnight — all other handlers pass explicit `today` via `toLocalISODate`.

## Plan of work

### 1. Lifecycle type + detection (`src/plan/helpers.ts`)

**1a.** Add `'upcoming'` to `PlanLifecycle` (line 48):

```typescript
export type PlanLifecycle = 'no_plan' | 'planning' | 'upcoming' | 'active_early' | 'active_mid' | 'active_ending';
```

**1b.** Update `getPlanLifecycle()` — before returning `'no_plan'`, check for future plans (lines 72–75):

```typescript
const runningSession = await store.getRunningPlanSession(today);
if (!runningSession) {
  const future = await store.getFuturePlanSessions(today);
  return future.length > 0 ? 'upcoming' : 'no_plan';
}
```

**1c.** Add `getVisiblePlanSession()` — new export after `getPlanLifecycle`. Returns the running plan if one exists, otherwise the nearest future plan:

```typescript
/**
 * Get the plan session the user should see right now.
 *
 * Priority: running plan (horizon contains today) > nearest future plan.
 * Returns null if no confirmed plan exists at all.
 *
 * This is the visibility query — use it everywhere the user expects
 * to "see their plan." Contrast with getRunningPlanSession which is
 * strictly date-range-gated and used for budget/solver logic.
 */
export async function getVisiblePlanSession(
  store: StateStoreLike,
  today: string,
): Promise<PlanSession | null> {
  const running = await store.getRunningPlanSession(today);
  if (running) return running;
  const future = await store.getFuturePlanSessions(today);
  return future.length > 0 ? future[0]! : null;
}
```

Add `PlanSession` to the types import (line 17):

```typescript
import type { Batch, PlanSession } from '../models/types.js';
```

### 2. Timezone fix for store queries (`src/state/store.ts`)

**2a.** `StateStoreLike` interface — add `today?: string` param to `getFuturePlanSessions` (line 74) and `getLatestHistoricalPlanSession` (line 77):

```typescript
/** Sessions with horizon_start > today, earliest first. NOT superseded. */
getFuturePlanSessions(today?: string): Promise<PlanSession[]>;

/** Most recent session whose horizon has fully ended. NOT superseded. */
getLatestHistoricalPlanSession(today?: string): Promise<PlanSession | null>;
```

**2b.** `StateStore.getFuturePlanSessions()` impl (line 224) — use param:

```typescript
async getFuturePlanSessions(today?: string): Promise<PlanSession[]> {
  const effectiveToday = today ?? toLocalISODate(new Date());
  const { data, error } = await this.client
    .from('plan_sessions')
    .select('*')
    .eq('user_id', SINGLE_USER_ID)
    .eq('superseded', false)
    .gt('horizon_start', effectiveToday)
    .order('horizon_start', { ascending: true });
  if (error || !data) return [];
  return data.map(fromPlanSessionRow);
}
```

**2c.** `StateStore.getLatestHistoricalPlanSession()` impl (line 237) — same pattern:

```typescript
async getLatestHistoricalPlanSession(today?: string): Promise<PlanSession | null> {
  const effectiveToday = today ?? toLocalISODate(new Date());
  const { data, error } = await this.client
    .from('plan_sessions')
    .select('*')
    .eq('user_id', SINGLE_USER_ID)
    .eq('superseded', false)
    .lt('horizon_end', effectiveToday)
    .order('horizon_end', { ascending: false })
    .limit(1)
    .single();
  if (error) return null;
  return fromPlanSessionRow(data);
}
```

### 3. Mirror timezone fix in test store (`src/harness/test-store.ts`)

**3a.** `getFuturePlanSessions()` (line 185) — add `today?: string` param:

```typescript
async getFuturePlanSessions(today?: string): Promise<PlanSession[]> {
  const effectiveToday = today ?? this.getToday();
  const candidates = [...this.planSessionsById.values()].filter(
    (ps) => !ps.superseded && ps.horizonStart > effectiveToday,
  );
  candidates.sort((a, b) => (a.horizonStart < b.horizonStart ? -1 : a.horizonStart > b.horizonStart ? 1 : 0));
  return candidates.map(cloneDeep);
}
```

**3b.** `getLatestHistoricalPlanSession()` (line 198) — same:

```typescript
async getLatestHistoricalPlanSession(today?: string): Promise<PlanSession | null> {
  const effectiveToday = today ?? this.getToday();
  const candidates = [...this.planSessionsById.values()].filter(
    (ps) => !ps.superseded && ps.horizonEnd < effectiveToday,
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.horizonEnd < b.horizonEnd ? 1 : a.horizonEnd > b.horizonEnd ? -1 : 0));
  return cloneDeep(candidates[0]!);
}
```

### 4. Formatter: contextual message for pre-plan days (`src/telegram/formatters.ts`)

The design proposal specifies: when today is before the plan's start, show "No meals — your plan starts tomorrow" instead of bare dashes. This is an explicit design decision (see proposal § "Design decisions").

**4a.** Add `horizonStart?: string` parameter to `formatNextAction` (line 199):

```typescript
export function formatNextAction(
  batchViews: BatchView[],
  events: MealEvent[],
  flexSlots: FlexSlot[],
  today: string,
  horizonStart?: string,
): string {
```

**4b.** For each date in the 3-day window, when the date is before `horizonStart`, replace the per-meal rendering with a single contextual line. Insert this check at the top of the date loop body (inside the `for (const date of dates)` loop, after the day label line, before the meal-type loop):

```typescript
for (const date of dates) {
  const dayLabel = formatDayMdV2Short(date);
  lines.push(`*${esc(dayLabel)}*`);

  // Pre-plan day: show context instead of bare dashes
  if (horizonStart && date < horizonStart) {
    const startLabel = formatDayMdV2Short(horizonStart);
    lines.push(`_No meals — your plan starts ${esc(startLabel)}_`);
    lines.push('');
    continue;
  }

  for (const mealType of ['lunch', 'dinner'] as const) {
    // ... existing meal rendering unchanged ...
  }

  lines.push('');
}
```

### 5. Fix legacy post-confirmation callbacks (`src/telegram/core.ts`)

The legacy `planConfirmedKeyboard` (used as fallback at line 603 when `postConfirmData` is null) routes through `view_shopping_list` → "Shopping list generation is coming soon." This violates the design's requirement that post-confirmation buttons connect to real screens.

**5a.** Route `view_shopping_list` to `sl_next` (lines 472–478):

```typescript
// Post-plan-confirmation actions (legacy keyboard)
if (action === 'view_shopping_list') {
  session.planFlow = null;
  // Route to sl_next which handles both active and upcoming plans
  await handleCallback('sl_next', sink);
  return;
}
```

`view_plan_recipes` (line 479) already calls `showRecipeList(sink)` — no change needed.

### 6. Wire up handlers (`src/telegram/core.ts`)

**6a.** Add import (top of file, alongside existing `getPlanLifecycle` import):

```typescript
import { getPlanLifecycle, getVisiblePlanSession, ... } from '../plan/helpers.js';
```

**6b.** Plan view callbacks — `na_show`/`wo_show`/`dd_*` (lines 750–758):

Replace `store.getRunningPlanSession(today)` with `getVisiblePlanSession(store, today)`:

```typescript
if (action === 'na_show' || action === 'wo_show' || action.startsWith('dd_')) {
  const today = toLocalISODate(new Date());
  const lifecycle = await getPlanLifecycle(session, store, today);
  const planSession = await getVisiblePlanSession(store, today);
  if (!planSession) {
    await sink.reply('No active plan.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
    return;
  }
  // ... rest unchanged
```

**6c.** Next Action callback — pass `horizonStart` to formatter (line 763):

```typescript
if (action === 'na_show') {
  const text = formatNextAction(batchViews, planSession.events, planSession.flexSlots, today, planSession.horizonStart);
  // ... rest unchanged
```

**6d.** Shopping list callbacks — `sl_*` (line 831):

Replace `store.getRunningPlanSession(today)` with `getVisiblePlanSession(store, today)`:

```typescript
if (action.startsWith('sl_')) {
  const param = action.slice(3);
  const today = toLocalISODate(new Date());
  const lifecycle = await getPlanLifecycle(session, store, today);
  const planSession = await getVisiblePlanSession(store, today);
  if (!planSession) {
    await sink.reply('No plan for this week.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
    return;
  }
  // ... rest unchanged
```

**6e.** `my_plan` menu handler (lines 1025–1044):

Replace `store.getRunningPlanSession(today)` and update the guard:

```typescript
case 'my_plan': {
  session.surfaceContext = 'plan';
  session.lastRecipeSlug = undefined;
  const today = toLocalISODate(new Date());
  const lifecycle = await getPlanLifecycle(session, store, today);
  const planSession = await getVisiblePlanSession(store, today);
  if (planSession && (lifecycle.startsWith('active_') || lifecycle === 'upcoming')) {
    const { batchViews, allBatches } = await loadPlanBatches(planSession, recipes);
    const text = formatNextAction(batchViews, planSession.events, planSession.flexSlots, today, planSession.horizonStart);
    const nextCook = getNextCookDay(allBatches, today);
    const nextCookBatchViews = nextCook
      ? batchViews.filter(bv => bv.batch.eatingDays[0] === nextCook.date)
      : [];
    await sink.reply(text, { reply_markup: nextActionKeyboard(nextCookBatchViews, lifecycle), parse_mode: 'MarkdownV2' });
    return;
  }
  // Fallback: no plan at all — treat as plan_week
  await handleMenu('plan_week', sink);
  return;
}
```

**6f.** `shopping_list` menu handler (lines 1111–1128):

The lifecycle check already works: `lifecycle === 'no_plan'` rejects, `'upcoming'` passes through to `sl_next` callback. No code change needed — the `sl_next` callback (change 6d) handles the rest.

But update the comment on line 1125:

```typescript
// Active or upcoming plan → delegate to sl_next handler by dispatching a callback
await handleCallback('sl_next', sink);
```

**6g.** `showRecipeList` function — COOKING SOON section (lines 1203–1217):

Update guard and query:

```typescript
if (lifecycle.startsWith('active_') || lifecycle === 'upcoming') {
  const planSession = await getVisiblePlanSession(store, today);
  if (planSession) {
    const { batchViews } = await loadPlanBatches(planSession, recipes);
    cookingSoonBatchViews = batchViews
      .filter(bv => bv.batch.eatingDays.length > 0 && bv.batch.eatingDays[0]! >= today)
      .sort((a, b) => a.batch.eatingDays[0]!.localeCompare(b.batch.eatingDays[0]!));
  }
}
```

**6h.** `plan_replan_cancel` message (line 506):

```typescript
if (action === 'plan_replan_cancel') {
  session.pendingReplan = undefined;
  await sink.reply('Plan kept.', { reply_markup: await getMenuKeyboard() });
  return;
}
```

**6i.** `doStartPlanFlow` — pass explicit today to store call (line 907):

```typescript
const running = await store.getRunningPlanSession(toLocalISODate(new Date()));
```

### 7. Timezone fix + cold-start fallback (`src/agents/plan-flow.ts`)

**7a.** `computeNextHorizonStart()` — pass explicit today to all store calls AND change the cold-start fallback from `today` to `tomorrow` (lines 181–204):

```typescript
export async function computeNextHorizonStart(
  store: StateStoreLike,
): Promise<{
  start: string;
  replacingSession?: import('../models/types.js').PlanSession;
  runningSession?: import('../models/types.js').PlanSession;
}> {
  const today = toLocalISODate(new Date());
  const future = await store.getFuturePlanSessions(today);
  if (future.length > 0) {
    return { start: future[0]!.horizonStart, replacingSession: future[0]! };
  }

  const running = await store.getRunningPlanSession(today);
  if (running) {
    const nextDay = addDays(running.horizonEnd, 1);
    return { start: nextDay, runningSession: running };
  }

  await store.getLatestHistoricalPlanSession(today);
  // Plan starts tomorrow: user plans today, shops today, cooks tomorrow.
  // With upcoming plan visibility the plan is fully visible before it starts.
  return { start: addDays(today, 1) };
}
```

Remove the `// TEMPORARY` comment. The old `start: today` hack existed because plans starting tomorrow were invisible — this plan fixes that.

**Impact on existing scenarios:** Scenarios that go through the cold-start path (001, 004) will produce plans starting tomorrow instead of today. Re-record them after this change and verify the shifted horizon makes sense.

### 8. Keyboards — no changes needed

`buildMainMenuKeyboard` uses fall-through logic: `'upcoming'` is not `'planning'` or `'no_plan'`, so it gets `'📋 My Plan'`. Correct by construction.

### 9. Test scenario (`test/scenarios/022-upcoming-plan-view/spec.ts`)

Author a new scenario that seeds a future plan and exercises all visibility surfaces.

**Clock:** `2026-04-07T10:00:00Z` (Tue Apr 7 — one day before plan starts).

**Plan:** horizonStart `2026-04-08`, horizonEnd `2026-04-14` — the plan starts tomorrow.

**Script:**
1. `text('📋 My Plan')` — Next Action screen with contextual "No meals — your plan starts Wed, Apr 8" for today, cook info for tomorrow.
2. `click('wo_show')` — Week Overview showing the full 7-day plan.
3. `click('sl_next')` — Shopping list for the first cook day (Apr 8).
4. `click('na_show')` — Back to Next Action.
5. `text('📋 Plan Week')` — User manually types "Plan Week" while having an upcoming plan. Triggers `handleMenu('plan_week')` → detects future plan → shows "You already have a plan for ... Replan it?" with `planReplanKeyboard`. Covers design § "User manually types Plan Week."
6. `click('plan_replan_cancel')` — "Plan kept." with `getMenuKeyboard()` → `buildMainMenuKeyboard(lifecycle)`. The reply keyboard in the recorded output captures "📋 My Plan" (not "📋 Plan Week"), asserting the menu label is correct for upcoming lifecycle.

**Seed data:** Reuse the batch/session structure from scenario 018 but shift horizonStart to `2026-04-08` and set clock to Apr 7. Two cook days: Apr 8 (lunch + dinner) and Apr 11 (lunch + dinner). Flex slot + event on Apr 14.

After authoring, run `npm run test:generate -- 022-upcoming-plan-view` and verify the output:
- Today (Apr 7) shows the contextual "No meals" message, NOT bare dashes.
- Tomorrow (Apr 8) shows cook instructions.
- Shopping list contains ingredients for the first cook day.
- Week overview spans Apr 8–14.
- Step 6's reply includes a reply keyboard with "📋 My Plan" (not "📋 Plan Week") — this is the recorded output assertion that the menu label changes for upcoming plans.
- Step 5 shows the replan prompt, covering the design's "Plan Week with upcoming plan" edge case.

## Progress

- [x] 1. Add `'upcoming'` lifecycle + `getVisiblePlanSession()` to `src/plan/helpers.ts`
- [x] 2. Timezone fix: add `today?` param to `store.getFuturePlanSessions` + `getLatestHistoricalPlanSession`
- [x] 3. Mirror timezone fix in `src/harness/test-store.ts`
- [x] 4. Formatter: contextual message for pre-plan days in `formatNextAction`
- [x] 5. Fix legacy `view_shopping_list` callback → route to `sl_next`
- [x] 6. Wire up all handlers in `src/telegram/core.ts` to use `getVisiblePlanSession`
- [x] 7. Timezone fix + cold-start fallback → tomorrow in `computeNextHorizonStart` (`src/agents/plan-flow.ts`)
- [x] 8. `npx tsc --noEmit` — type check passes
- [x] 9. Scenarios 001–004 pass without re-recording (cold-start change aligned with fixture expectations; also fixed 10 pre-existing failures)
- [x] 10. `npm test` — all 121 existing scenarios pass (0 failures)
- [x] 11. Author scenario `022-upcoming-plan-view` + generate + verify output
- [x] 12. Final `npm test` — 122 tests pass (0 failures)

## Decision log

- Decision: Add `'upcoming'` as a new lifecycle state rather than broadening `active_early`.
  Rationale: Semantically distinct — the plan hasn't started yet. Callers that check `lifecycle.startsWith('active_')` (e.g., Next Action cook buttons, COOKING SOON section) need the distinction. `upcoming` is opt-in: only handlers that add `|| lifecycle === 'upcoming'` gain visibility.
  Date: 2026-04-08

- Decision: `getVisiblePlanSession()` lives in `helpers.ts`, not `store.ts`.
  Rationale: It's a policy function (what the user should *see*), not a data query. It composes two store queries. Putting it in the store would leak UI visibility policy into the data layer.
  Date: 2026-04-08

- Decision: Pass `horizonStart` into `formatNextAction` rather than a boolean `isUpcoming`.
  Rationale: The formatter needs to know *when* the plan starts to render "your plan starts [day]". A boolean loses that information. For active plans, horizonStart <= today so the new code path is never hit — backward compatible.
  Date: 2026-04-08

- Decision: Show "No meals — your plan starts [day]" as italic, not bold.
  Rationale: Italic signals informational/secondary content. Bold is for day headers. Matches the existing convention where reheat annotations use italic.
  Date: 2026-04-08

- Decision: Change `computeNextHorizonStart()` cold-start fallback from `today` to `addDays(today, 1)` (tomorrow).
  Rationale: The design proposal's primary scenario is "I just planned, show me my plan" — including first-time users. The old `start: today` hack was marked TEMPORARY because plans starting tomorrow were invisible and therefore useless. This plan fixes that visibility gap, so the hack is no longer needed. With upcoming visibility, plans starting tomorrow are fully usable: the user sees the plan, shops today, cooks tomorrow. This aligns with the plan → shop → cook sequence. Scenarios 001 and 004 will need re-recording.
  Date: 2026-04-08

- Decision: Route legacy `view_shopping_list` callback to `sl_next` instead of "coming soon" message.
  Rationale: The `planConfirmedKeyboard` is still used as a fallback (line 603) when `postConfirmData` is null. Its `view_shopping_list` button must work — the design proposal requires "post-confirmation buttons must connect to real screens." Routing to `sl_next` reuses the existing shopping list handler which already works for both active and upcoming plans after this plan's changes.
  Date: 2026-04-08

## Validation

1. `npx tsc --noEmit` — type check with the new `'upcoming'` literal and `today?` params.
2. Re-record scenarios 001 and 004 (cold-start horizon shifted to tomorrow). Verify the horizon dates shift by exactly 1 day and the rest of the plan logic is unchanged.
3. `npm test` — all 21 existing scenarios pass after re-recording.
4. Scenario 022 — exercises the full upcoming plan surface: Next Action (contextual message), Week Overview, Shopping List, "Plan Week" edge case, and menu label assertion. Steps 5–6 (`text('📋 Plan Week')` → `click('plan_replan_cancel')`) capture the reply keyboard in recorded output via `getMenuKeyboard()`, asserting "📋 My Plan" label for upcoming lifecycle.
5. Manual `npm run dev` — create a plan (first-time or rolling), verify it starts tomorrow, menu shows "My Plan", all buttons work.
