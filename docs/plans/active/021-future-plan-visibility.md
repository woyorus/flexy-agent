# Plan 021: Future plan visibility

## Context

A confirmed plan with a future start date is completely invisible. The user creates a plan (e.g., Apr 8-14 while today is Apr 7), and then:
- Menu shows "Plan Week" instead of "My Plan"
- Shopping List says "No plan yet"
- No way to view meals, cook days, or the week overview

This violates JTBD A1 (know my next action), A2 (shopping list), and A4 (browse week). The user planned and the product gives nothing back.

**Root cause:** `getRunningPlanSession(today)` requires `horizon_start <= today <= horizon_end`. A future plan fails this check → lifecycle = `no_plan` → everything cascades.

## Approach

Add lifecycle state `'upcoming'` + a `getVisiblePlanSession()` helper that returns the running plan OR the nearest future plan. All handlers that display plan data switch from `getRunningPlanSession()` to `getVisiblePlanSession()`. Existing formatters (Next Action, Week Overview, Shopping List) need zero changes — they already handle dates with no meals gracefully.

Also fix a timezone bug: `getFuturePlanSessions()` and `getLatestHistoricalPlanSession()` use UTC internally while all menu handlers use local time. In Spain (UTC+1/+2), this causes off-by-one near midnight.

## Changes

### 1. `src/plan/helpers.ts` — lifecycle + new helper

**1a.** Add `'upcoming'` to `PlanLifecycle` (line 48):
```typescript
export type PlanLifecycle = 'no_plan' | 'planning' | 'upcoming' | 'active_early' | 'active_mid' | 'active_ending';
```

**1b.** Update `getPlanLifecycle()` (lines 72-75) — check future plans before returning `'no_plan'`:
```typescript
const runningSession = await store.getRunningPlanSession(today);
if (!runningSession) {
  const future = await store.getFuturePlanSessions(today);
  return future.length > 0 ? 'upcoming' : 'no_plan';
}
```

**1c.** Add `getVisiblePlanSession()` — new export after `getPlanLifecycle`:
```typescript
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

Add `PlanSession` to the types import (line 17).

### 2. `src/state/store.ts` — timezone fix

**2a.** `StateStoreLike` interface: add `today?` param to `getFuturePlanSessions` (line 73) and `getLatestHistoricalPlanSession` (line 76).

**2b.** `StateStore.getFuturePlanSessions()` (line 223): add `today?: string` param, use `today ?? new Date().toISOString().slice(0, 10)`.

**2c.** `StateStore.getLatestHistoricalPlanSession()` (line 236): same pattern.

### 3. `src/harness/test-store.ts` — mirror timezone fix

**3a.** `TestStateStore.getFuturePlanSessions()` (line 185): add `today?: string` param, use `today ?? this.getToday()`.

**3b.** `TestStateStore.getLatestHistoricalPlanSession()` (line 198): same.

### 4. `src/telegram/core.ts` — fix all handlers

**4a.** Import `getVisiblePlanSession` from `../plan/helpers.js`.

**4b.** `my_plan` handler (lines 1031-1032):
- `store.getRunningPlanSession(today)` → `getVisiblePlanSession(store, today)`
- Guard: `lifecycle.startsWith('active_')` → `lifecycle.startsWith('active_') || lifecycle === 'upcoming'`

**4c.** Plan view callbacks `na_show`/`wo_show`/`dd_*` (line 753):
- `store.getRunningPlanSession(today)` → `getVisiblePlanSession(store, today)`

**4d.** Shopping list `sl_*` callback (line 831):
- `store.getRunningPlanSession(today)` → `getVisiblePlanSession(store, today)`

**4e.** My Recipes "COOKING SOON" (lines 1203-1204):
- Guard: add `|| lifecycle === 'upcoming'`
- `store.getRunningPlanSession(today)` → `getVisiblePlanSession(store, today)`

**4f.** `plan_replan_cancel` message (line 506):
- `'Plan kept. Tap Plan Week again to plan the week after.'` → `'Plan kept.'`

**4g.** `doStartPlanFlow` (line 907):
- `store.getRunningPlanSession()` → `store.getRunningPlanSession(toLocalISODate(new Date()))`

### 5. `src/agents/plan-flow.ts` — timezone fix

**5a.** `computeNextHorizonStart()` (lines 188, 193):
- `store.getFuturePlanSessions()` → `store.getFuturePlanSessions(toLocalISODate(new Date()))`
- `store.getRunningPlanSession()` → `store.getRunningPlanSession(toLocalISODate(new Date()))`

### 6. `src/telegram/keyboards.ts` — no changes needed

`buildMainMenuKeyboard` already handles `'upcoming'` correctly via fall-through: it's not 'planning' or 'no_plan', so it gets "📋 My Plan".

## What the user sees after the fix

**Today is Apr 7. Plan exists for Apr 8-14.**

- Menu shows "📋 My Plan"
- Tapping "My Plan" → Next Action screen:
  ```
  Today, Monday Apr 7
  —
  —

  Tomorrow, Tuesday Apr 8
  🔪 Cook Lunch: Greek Lemon Chicken — 3 servings
  
  Wednesday Apr 9
  Greek Lemon Chicken (reheat)
  ```
- Tapping "Shopping List" → generates needs list for first cook day (Apr 8)
- Tapping "View full week" → shows the full 7-day overview
- Tapping "Plan Week" (if typed manually) → "You already have a plan... Replan it?"

## Verification

1. `npx tsc --noEmit` — type check
2. `npm test` — all existing scenarios pass (no regressions)
3. Author scenario `test/scenarios/NNN-upcoming-plan-view/spec.ts` — clock before plan start, verify My Plan, shopping list, week overview all work
4. Manual `npm run dev` sanity check on real Telegram
