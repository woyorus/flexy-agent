# Plan 013: Progress Screen

**Status:** Active
**Date:** 2026-04-07
**Affects:** `src/state/store.ts`, `src/harness/test-store.ts`, `src/telegram/core.ts`, `src/telegram/formatters.ts`, `src/telegram/keyboards.ts`, `src/models/types.ts`, `supabase/schema.sql`, `supabase/migrations/`

## Problem

Flexie has no way to track whether the effort is paying off. The user plans meals and cooks, but there is no measurement logging, no weekly trend, no feedback loop. The "Weekly Budget" button (bottom-right) is a placeholder that replies "No active plan yet." The Progress screen is the outcome signal: weight and waist tracking with weekly reports.

This task builds the complete Progress feature: measurement persistence, input parsing, daily confirmation, disambiguation, weekly report, and the inline `[Last weekly report]` button. It is independent of plan view, recipe, and shopping code.

**Depends on:** Plan 012 (Phase 0) for:
- `surfaceContext` on `BotCoreSession` (Phase 0 scope item 5)
- `'progress'` action in `matchMainMenu()` (Phase 0 scope item 3)
- Dynamic `buildMainMenuKeyboard()` with "Progress" label (Phase 0 scope item 2)

This plan assumes Phase 0 has landed. If `surfaceContext` does not exist on `BotCoreSession` yet, Phase 0 must be completed first.

## Plan of work

### Step 1: Measurement data model + persistence

**1a. Supabase schema — add `measurements` table to `supabase/schema.sql` (after line 49, before RLS section):**

```sql
create table measurements (
  id         uuid primary key,
  user_id    text not null,
  date       date not null,
  weight_kg  numeric(5,2) not null,
  waist_cm   numeric(5,2),
  created_at timestamptz default now()
);
create unique index measurements_user_date on measurements (user_id, date);
```

Add RLS policy for measurements alongside existing ones (lines 51-63):
```sql
alter table measurements enable row level security;
create policy "Allow all for anon" on measurements
  for all using (true) with check (true);
```

**1b. SQL migration — create `supabase/migrations/003_create_measurements.sql`:**

Following the naming pattern of existing migrations (`001_create_plan_sessions_and_batches.sql`, `002_drop_weekly_plans.sql`), create `003_create_measurements.sql` with the same DDL as above.

**1c. TypeScript type — add `Measurement` interface to `src/models/types.ts` (after `Batch` at line 230):**

```typescript
export interface Measurement {
  id: string;
  userId: string;
  date: string;       // ISO date
  weightKg: number;
  waistCm: number | null;
  createdAt: string;
}
```

**1d. Extend `StateStoreLike` interface in `src/state/store.ts` (after line 96, before the class):**

Add a new section to the interface:

```typescript
// --- Measurements ---

/** Upsert a measurement for the given date. */
logMeasurement(userId: string, date: string, weightKg: number, waistCm: number | null): Promise<void>;

/** Get today's measurement (or null). */
getTodayMeasurement(userId: string, date: string): Promise<Measurement | null>;

/** Get measurements for a date range (inclusive). Ordered by date ASC. */
getMeasurements(userId: string, startDate: string, endDate: string): Promise<Measurement[]>;

/** Get the most recent measurement for a user (for disambiguation). */
getLatestMeasurement(userId: string): Promise<Measurement | null>;
```

Note: the backlog lists `getWeekMeasurements` and `getLastWeekMeasurements` as separate methods, but these are just `getMeasurements` with different date ranges. A single `getMeasurements(userId, start, end)` is cleaner — callers compute Mon-Sun boundaries themselves.

**1e. Implement measurement methods on `StateStore` class (after `getBatchesByPlanSessionId` at line 270, before the Session State section at line 272):**

- `logMeasurement`: upsert into `measurements` using `.upsert()` with `{ onConflict: 'user_id,date' }`. Generate UUID client-side (`crypto.randomUUID()`).
- `getTodayMeasurement`: select from `measurements` where `user_id` and `date` match.
- `getMeasurements`: select from `measurements` where `user_id` and `date` between start/end, order by date ASC.
- `getLatestMeasurement`: select from `measurements` where `user_id`, order by date DESC, limit 1.

Add row mapping helpers `toMeasurementRow` / `fromMeasurementRow` alongside existing helpers (after line 381):
```typescript
function toMeasurementRow(userId: string, date: string, weightKg: number, waistCm: number | null): Record<string, any> {
  return {
    id: crypto.randomUUID(),
    user_id: userId,
    date,
    weight_kg: weightKg,
    waist_cm: waistCm,
  };
}

function fromMeasurementRow(row: any): Measurement {
  return {
    id: row.id,
    userId: row.user_id,
    date: row.date,
    weightKg: Number(row.weight_kg),
    waistCm: row.waist_cm != null ? Number(row.waist_cm) : null,
    createdAt: row.created_at,
  };
}
```

Add `import type { Measurement } from '../models/types.js'` to the import at line 17.

**1f. Implement in-memory measurement storage in `src/harness/test-store.ts`:**

- Add `measurements: Measurement[]` to `TestStateStoreSeed` (line 30-37) and `TestStateStoreSnapshot` (line 39-46).
- Add a private `measurements: Measurement[]` array to `TestStateStore`.
- Implement all four methods with in-memory array operations:
  - `logMeasurement`: find existing by userId+date, replace or push.
  - `getTodayMeasurement`: find by userId+date.
  - `getMeasurements`: filter by userId + date range, sort by date ASC.
  - `getLatestMeasurement`: filter by userId, sort date DESC, return first.
- Add `measurements` to `snapshot()` return value (line 251-257).

### Step 2: Progress flow state on session

**2a. Add `progressFlow` to `BotCoreSession` in `src/telegram/core.ts` (line 167-173):**

```typescript
export interface BotCoreSession {
  recipeFlow: RecipeFlowState | null;
  planFlow: PlanFlowState | null;
  recipeListPage: number;
  pendingReplan?: { replacingSession: import('../models/types.js').PlanSession };
  /** Progress measurement flow — explicit phase prevents input hijacking after logging. */
  progressFlow: {
    phase: 'awaiting_measurement' | 'confirming_disambiguation';
    pendingWeight?: number;
    pendingWaist?: number;
  } | null;
}
```

Initialize `progressFlow: null` in `createBotCore` at line 200-204.

Add `session.progressFlow = null` to `reset()` at line 869-873.

**Why `progressFlow` instead of just `surfaceContext`:** After logging or seeing "Already logged today", `surfaceContext` stays `'progress'`. Without a flow phase, any subsequent text would be parsed as measurement input. The flow state makes input expectation explicit: `awaiting_measurement` = parse numbers, `confirming_disambiguation` = parse yes/no, `null` = normal dispatch.

### Step 3: Measurement input parsing

**3a. Create `src/agents/progress-flow.ts` — pure functions for the progress flow:**

This follows the pattern of `recipe-flow.ts` and `plan-flow.ts`: pure functions that take state in and return `{ text, state }`.

```typescript
/**
 * Progress flow — measurement input parsing and disambiguation.
 *
 * Pure functions: state in, { text, state } out. No side effects.
 * The calling code in core.ts handles persistence and keyboard attachment.
 */
```

**`parseMeasurementInput(text: string): { weight: number; waist?: number } | null`**
- Parse "82.3 / 91", "82.3, 91", "82.3 91", or just "82.3".
- Regex: extract one or two positive numbers (int or decimal).
- Return null if the text doesn't match (let it fall through to normal dispatch).
- Do NOT assign weight vs waist yet — disambiguation may be needed.

**`assignWeightWaist(values: { a: number; b: number }, lastMeasurement: Measurement | null): { weight: number; waist: number; ambiguous: boolean }`**
- If only one number: it's weight (waist is optional).
- If two numbers and no prior measurements: ambiguous. Default assumption: first is weight, second is waist, but ask for confirmation.
- If two numbers and prior measurements exist: the number closer to last weight is weight, the number closer to last waist is waist. If the difference is too close to call (both within 5 of each previous value), it's ambiguous.
- Return `ambiguous: true` when the user needs to confirm.

**`formatDisambiguationPrompt(weight: number, waist: number): string`**
- "Is that {weight} kg weight and {waist} cm waist?"
- Inline keyboard: `[Yes]` / `[No, swap them]` (callbacks: `pg_disambig_yes`, `pg_disambig_no`)

### Step 4: Progress menu handler + text routing

**4a. Add `'progress'` case in `handleMenu()` at `src/telegram/core.ts` (after line 696, before the closing brace of the switch):**

```typescript
case 'progress': {
  session.surfaceContext = 'progress';

  // Check if already logged today
  const today = new Date().toISOString().slice(0, 10);
  const existing = await store.getTodayMeasurement('default', today);

  if (existing) {
    session.progressFlow = null;
    const latestMeasurement = await store.getLatestMeasurement('default');
    // Show "Already logged today" + optional [Last weekly report] button
    const text = 'Already logged today ✓';
    const hasAnyMeasurement = latestMeasurement != null;
    if (hasAnyMeasurement) {
      await sink.reply(text, { reply_markup: progressReportKeyboard });
    } else {
      await sink.reply(text);
    }
    return;
  }

  // No measurement today — prompt for input
  session.progressFlow = { phase: 'awaiting_measurement' };
  const hour = new Date().getHours();
  const timeQualifier = hour >= 14
    ? '\n\nIf this is your morning weight, drop it here.'
    : '';
  const prompt = `Drop your weight (and waist if you track it):\n\nExamples: "82.3 / 91" or just "82.3"${timeQualifier}`;
  await sink.reply(prompt);
  return;
}
```

**4b. Add progress flow text routing in `handleTextInput()` (insert before the plan flow check at line 713):**

The progress flow check must come before plan/recipe flow checks since `surfaceContext` and `progressFlow` are independent axes:

```typescript
// If in progress flow, route measurement input
if (session.progressFlow) {
  if (session.progressFlow.phase === 'awaiting_measurement') {
    // Parse input, disambiguate, log, respond
    // (see step 4c below for full logic)
    return;
  }
  if (session.progressFlow.phase === 'confirming_disambiguation') {
    // Parse "yes"/"no"/corrected values
    return;
  }
}
```

**4c. Measurement input handling logic (inside `awaiting_measurement` branch):**

1. Call `parseMeasurementInput(text)`. If null, reply with a gentle nudge ("I'm expecting a number like 82.3 or 82.3 / 91") and stay in `awaiting_measurement`.
2. If one number: weight only. Call `store.logMeasurement('default', today, weight, null)`. Set `progressFlow = null`. Reply with confirmation.
3. If two numbers: call `assignWeightWaist(values, lastMeasurement)`.
   - If not ambiguous: log immediately. Set `progressFlow = null`. Reply with confirmation.
   - If ambiguous: set `progressFlow = { phase: 'confirming_disambiguation', pendingWeight, pendingWaist }`. Reply with disambiguation prompt + inline keyboard.

**4d. Add disambiguation callback handlers in `handleCallback()` (after existing callback routing):**

- `pg_disambig_yes`: log with the pending values as-is. Set `progressFlow = null`. Reply with confirmation.
- `pg_disambig_no`: swap pendingWeight/pendingWaist, log. Set `progressFlow = null`. Reply with confirmation.

**4e. Clear `progressFlow` when entering other flows:**

In `handleMenu()`, the existing `session.recipeFlow = null; session.planFlow = null;` at line 643-644 (which Phase 0 will modify to be smarter) should also clear `progressFlow`:
```typescript
session.progressFlow = null;
```
This prevents stale flow state when the user navigates away.

### Step 5: Formatters

**5a. Add to `src/telegram/formatters.ts`:**

**`formatMeasurementConfirmation(weight: number, waist: number | null): string`**
- Weight + waist: `"Logged ✓ 82.3 kg / 91 cm"`
- Weight only: `"Logged ✓ 82.3 kg"`

**`formatWeeklyReport(currentWeek: Measurement[], previousWeek: Measurement[], weekStart: string, weekEnd: string): string`**
- Compute averages for current and previous weeks.
- If no previous week data: show just the current week averages, no delta.
- Format: `**Week of Mar 30 – Apr 5**\n\nWeight: **82.1 kg** avg (↓0.4 from last week)\nWaist: **90.5 cm** avg (↓0.3 from last week)\n\n{tone message}`
- Use MarkdownV2 or plain text depending on what the codebase uses (current formatters use plain text — follow that pattern).
- Omit waist line entirely if no waist measurements in the week.
- Append: `_Next report ready Sunday._`

**`pickWeeklyReportTone(currentAvgWeight: number, previousAvgWeight: number, currentAvgWaist: number | null, previousAvgWaist: number | null): string`**
- Losing 0.2-0.5 kg/week: "Steady and sustainable. 0.2-0.5 kg/week is a healthy, sustainable pace."
- Losing >0.5 kg/week: "Great progress. If this pace holds, we might ease up slightly -- sustainability matters more than speed."
- Plateau (+-0.1 kg): if waist is down, "Weight is stable but your waist is down {delta} cm -- you're recomposing, the scale will catch up." If no waist data: "Weight is stable -- normal. Fluctuations mask fat loss. Keep going."
- Up 0.3+ kg: "Week-to-week fluctuations happen -- water, food volume, stress. One week doesn't define the trend. Keep going."

**`getCalendarWeekBoundaries(today: string): { currentWeekStart: string; currentWeekEnd: string; lastWeekStart: string; lastWeekEnd: string }`**
- Calendar weeks are Mon-Sun.
- "Last completed week" = the most recent Mon-Sun that has fully passed.
- "Previous week" = the week before that (for delta).
- This is a pure date utility; put it in formatters or a new `src/utils/dates.ts` (formatters is fine for now).

### Step 6: Weekly report callback

**6a. Add `[Last weekly report]` inline keyboard in `src/telegram/keyboards.ts`:**

```typescript
/** Progress screen: show the last completed weekly report. */
export const progressReportKeyboard = new InlineKeyboard()
  .text('Last weekly report', 'pg_last_report');
```

**6b. Handle `pg_last_report` callback in `handleCallback()` in `src/telegram/core.ts`:**

Three cases:
1. **Completed week with data:** Compute `getCalendarWeekBoundaries(today)`. Query `store.getMeasurements('default', lastWeekStart, lastWeekEnd)` and `store.getMeasurements('default', prevWeekStart, prevWeekEnd)`. If last week has data, format and reply with `formatWeeklyReport(...)`. Append "Next report ready Sunday."
2. **No completed week with data:** "Not enough data for a report yet -- keep logging and your first report will be ready Sunday."
3. **No measurements at all:** Same message as case 2 (defensive; button shouldn't appear, but handle gracefully).

### Step 7: First measurement education

On the very first measurement ever (no prior measurements from `getLatestMeasurement`), append a one-time hint after the confirmation:

```
Logged ✓ 82.3 kg / 91 cm

We track weekly averages, not daily -- so don't worry about day-to-day swings.
```

Check `getLatestMeasurement('default')` before logging. If null, this is the first. Append the hint to the confirmation message. Do not persist a "has seen hint" flag — checking "was there a prior measurement" is equivalent and stateless.

### Step 8: Test scenario

**8a. Author scenario `test/scenarios/NNN-progress-logging/spec.ts`:**

Script (derived from acceptance criteria):
1. `/start` — get menu.
2. Tap `📊 Progress` — expect measurement prompt.
3. Send `"82.3 / 91"` — expect "Logged ✓ 82.3 kg / 91 cm" + first-measurement hint.
4. Tap `📊 Progress` — expect "Already logged today ✓" + `[Last weekly report]` button.
5. Tap `[Last weekly report]` — expect "Not enough data" message (only one day of data).

Freeze clock to a specific date. Use empty recipe fixtures (progress is independent of recipes/plans).

**8b. Generate recording:** `npm run test:generate -- progress-logging`

**8c. Review recording:** Verify confirmation copy, "already logged" path, weekly report boundary behavior. Follow the verification protocol in `docs/product-specs/testing.md`.

## Progress

- [ ] Step 1: Measurement data model + persistence (schema, migration, types, store, test-store)
- [ ] Step 2: Progress flow state on BotCoreSession
- [ ] Step 3: Measurement input parsing (progress-flow.ts)
- [ ] Step 4: Progress menu handler + text routing + disambiguation callbacks
- [ ] Step 5: Formatters (confirmation, weekly report, tone, date boundaries)
- [ ] Step 6: Weekly report callback handler
- [ ] Step 7: First measurement education hint
- [ ] Step 8: Test scenario (author, generate, review)
- [ ] Final: `npm test` passes, all acceptance criteria met

## Decision log

- **Decision:** Single `getMeasurements(userId, start, end)` instead of separate `getWeekMeasurements` / `getLastWeekMeasurements`.
  **Rationale:** The backlog lists them as separate methods, but they are identical queries with different date ranges. A single method with caller-computed boundaries is cleaner and avoids duplicating the same SQL/in-memory logic. The week boundary computation lives in the formatter/utility layer where it belongs.
  **Date:** 2026-04-07

- **Decision:** Put parsing + disambiguation logic in `src/agents/progress-flow.ts` (new file) rather than inline in core.ts.
  **Rationale:** Follows the existing pattern where `recipe-flow.ts` and `plan-flow.ts` are pure-function flow handlers imported by core.ts. Keeps core.ts as a thin dispatcher. Makes parsing testable independently.
  **Date:** 2026-04-07

- **Decision:** Use `'default'` as userId for all measurement methods (matching `SINGLE_USER_ID` constant in store.ts, line 21).
  **Rationale:** v0.0.4 is single-user. The interface accepts userId as a parameter for future multi-user support, but callers always pass `'default'`.
  **Date:** 2026-04-07

- **Decision:** No timezone configuration in v0.0.4 — time-aware prompt uses system clock's local hour.
  **Rationale:** config.ts has no timezone setting. The user (developer in southern Spain) runs the bot on their own machine. `new Date().getHours()` returns local time, which is correct. Multi-user timezone support is a future concern.
  **Date:** 2026-04-07

- **Decision:** Disambiguation inline keyboard uses `pg_disambig_yes` / `pg_disambig_no` callbacks rather than text parsing of "yes"/"no".
  **Rationale:** Button taps are unambiguous and bypass the LLM (architecture rule 2). Text-based "yes"/"no" would require fuzzy matching and risk collision with other text routing. The `confirming_disambiguation` phase still exists in case we need to handle edge cases, but primary flow uses buttons.
  **Date:** 2026-04-07

- **Decision:** Weekly report uses plain text (not MarkdownV2).
  **Rationale:** All existing formatters in `src/telegram/formatters.ts` output plain text. MarkdownV2 in Telegram requires aggressive escaping of special characters. Consistency with the codebase wins.
  **Date:** 2026-04-07

## Validation

1. **`npm test` passes** — existing scenarios are unaffected (progress touches no plan/recipe/shopping code).
2. **New scenario covers the happy path**: tap Progress, enter measurements, see confirmation, tap Progress again same day, see "already logged", tap weekly report button.
3. **Manual verification** (`npm run dev`):
   - Tap [Progress] first time — see prompt with examples.
   - Type "82.3 / 91" — see "Logged ✓ 82.3 kg / 91 cm" + first-measurement hint.
   - Tap [Progress] again — see "Already logged today ✓" + [Last weekly report] button.
   - Tap [Last weekly report] — see "Not enough data" message.
   - After a full week of logging: tap [Last weekly report] — see weekly averages + tone.
   - Test afternoon time-aware prompt (after 14:00 local time).
4. **Disambiguation**: enter two close numbers on first measurement (no prior data) — confirm disambiguation prompt appears. On subsequent days with prior data, close numbers resolve silently.

# Feedback

