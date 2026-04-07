# Plan 013: Progress Screen

**Status:** Active
**Date:** 2026-04-07
**Affects:** `src/state/store.ts`, `src/harness/test-store.ts`, `src/harness/types.ts`, `src/telegram/core.ts`, `src/telegram/bot.ts`, `src/telegram/formatters.ts`, `src/telegram/keyboards.ts`, `src/models/types.ts`, `src/agents/progress-flow.ts` (new), `src/utils/dates.ts` (new), `supabase/schema.sql`, `supabase/migrations/`

## Problem

Flexie has no way to track whether the effort is paying off. The user plans meals and cooks, but there is no measurement logging, no weekly trend, no feedback loop. The "Weekly Budget" button (bottom-right) is a placeholder that replies "No active plan yet." The Progress screen is the outcome signal: weight and waist tracking with weekly reports.

This task builds the complete Progress feature: measurement persistence, input parsing, daily confirmation, disambiguation, weekly report, and the inline `[Last weekly report]` button. It is independent of plan view, recipe, and shopping code.

**Depends on:** Plan 012 (Phase 0) for:
- `surfaceContext` on `BotCoreSession` (Phase 0 scope item 5)
- `'progress'` action in `matchMainMenu()` (Phase 0 scope item 3)
- Dynamic `buildMainMenuKeyboard()` with "Progress" label (Phase 0 scope item 2)

This plan assumes Phase 0 has landed. If `surfaceContext` does not exist on `BotCoreSession` yet, Phase 0 must be completed first.

> **Preflight check — run before starting any step:**
> 1. `grep 'surfaceContext' src/telegram/core.ts` — must find the field on `BotCoreSession`.
> 2. `grep 'buildMainMenuKeyboard' src/telegram/keyboards.ts` — must find the function (not the old static `mainMenuKeyboard` const).
> 3. `grep "'progress'" src/telegram/core.ts` — must find `progress` as a handled action in `matchMainMenu()`.
> 4. `test -f src/plan/helpers.ts` — must exist (Plan 012 creates it with `toLocalISODate` and plan lifecycle helpers).
>
> If any check fails, **stop** and implement Plan 012 first.

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
  /** Server-generated timestamp (Supabase default now()). Read-only — omit from insert rows. */
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

**1f. Implement in-memory measurement storage in `src/harness/test-store.ts` and wire into harness:**

- Add `measurements?: Measurement[]` to `TestStateStoreSeed` (line 30-37) and `TestStateStoreSnapshot` (line 39-46). Optional with default `[]`.
- Add `measurements?: Measurement[]` to `ScenarioInitialState` in `src/harness/types.ts` (line 42-49). This allows scenarios to seed prior measurement history.
- Update `src/harness/runner.ts` constructor call (line ~104-106) to pass `measurements: spec.initialState.measurements` to `TestStateStore`.
- Update `src/harness/generate.ts` constructor call (line ~263-265) identically.
- Add a private `measurements: Measurement[]` array to `TestStateStore` (initialized from seed, default `[]`).
- Implement all four methods with in-memory array operations:
  - `logMeasurement`: find existing by userId+date, replace or push.
  - `getTodayMeasurement`: find by userId+date.
  - `getMeasurements`: filter by userId + date range, sort by date ASC.
  - `getLatestMeasurement`: filter by userId, sort date DESC, return first.
- Add `measurements` to `snapshot()` return value (line 251-257).
- **Note:** Adding `measurements: []` to every snapshot means all existing scenario `recorded.json` files will include `"measurements": []` in `finalStore`. Regenerate all existing scenarios with `npm run test:generate -- <name> --regenerate` after this step, or design `snapshot()` to omit `measurements` when the array is empty (preferred — keeps diffs clean). If omitting empty arrays, use `...(this.measurements.length > 0 ? { measurements: this.measurements } : {})` in the snapshot return.

### Step 2: Progress flow state on session

**2a. Add `progressFlow` to `BotCoreSession` in `src/telegram/core.ts` (line 167-173):**

This is an **additive change only** — Plan 012 (Phase 0) already extended `BotCoreSession` with `surfaceContext` and `lastRecipeSlug`. Do NOT rewrite the interface from scratch; add `progressFlow` alongside those fields. The full interface after both plans have landed:

```typescript
export interface BotCoreSession {
  recipeFlow: RecipeFlowState | null;
  planFlow: PlanFlowState | null;
  recipeListPage: number;
  pendingReplan?: { replacingSession: import('../models/types.js').PlanSession };
  // Added by Plan 012 (Phase 0):
  surfaceContext: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null;
  lastRecipeSlug?: string;
  // Added by Plan 013 (this plan):
  /** Progress measurement flow — explicit phase prevents input hijacking after logging. */
  progressFlow: {
    phase: 'awaiting_measurement' | 'confirming_disambiguation';
    pendingWeight?: number;
    pendingWaist?: number;
    /** ISO date when the user entered the numbers — store at parse time so midnight-crossing doesn't shift the log date. */
    pendingDate?: string;
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

**`parseMeasurementInput(text: string): { values: [number] | [number, number] } | null`**
- Parse "82.3 / 91", "82.3, 91", "82.3 91", or just "82.3".
- Regex: extract **exactly** one or two positive non-zero numbers (int or decimal). Reject inputs with more than two numbers, negative values, or zero — callers in the flow context handle null by nudging and staying in `awaiting_measurement`.
- Return null if the text doesn't match (i.e., is not a measurement input). When `progressFlow.phase === 'awaiting_measurement'`, Step 4c handles null by replying with a gentle nudge and staying in phase. When `progressFlow` is null, null falls through to normal dispatch.
- Returns `{ values: [number] }` for a single value or `{ values: [number, number] }` for two values.
- Do NOT assign weight vs waist meaning — that is left to `assignWeightWaist`.

**`assignWeightWaist(a: number, b: number, lastMeasurement: Measurement | null): { weight: number; waist: number; ambiguous: boolean }`**
- Called only when two numbers are present. Callers destructure `values[0]` and `values[1]` from the parser.
- If no prior measurements: ambiguous. Default assumption: first is weight, second is waist, but ask for confirmation.
- If prior measurements exist but `lastMeasurement.waistCm` is null (user has only logged weight before): there is no waist anchor to compare against. Treat this as ambiguous and ask for confirmation.
- If prior measurements exist with both values: use ordinal proximity — assign each number to the prior value it is closest to. If `a` is closer to `lastMeasurement.weightKg` AND `b` is closer to `lastMeasurement.waistCm`, it is unambiguous. If the assignments conflict (both closer to the same prior value) or if both are equidistant, it is ambiguous.
- No arbitrary numeric threshold — proximity comparison is the only criterion.
- Return `ambiguous: true` when the user needs to confirm.

**`formatDisambiguationPrompt(weight: number, waist: number): string`**
- Returns text only: "Is that {weight} kg weight and {waist} cm waist?"
- The keyboard is NOT returned by this function — it is a separate export `progressDisambiguationKeyboard` from `keyboards.ts` (defined in Step 6a). Core.ts calls `sink.reply(formatDisambiguationPrompt(w, ws), { reply_markup: progressDisambiguationKeyboard })`. This keeps the formatter pure and the keyboard collocated with other keyboard exports.

### Step 4: Progress menu handler + text routing

**4a. Replace the Phase 0 `'progress'` stub case in `handleMenu()` at `src/telegram/core.ts` with the full Progress handler (Plan 012 Step 4 adds a stub `'Progress is coming soon.'` — replace it, do not add a second `case 'progress'` branch):**

Note: the handler uses `new Date()` for both the current date and the hour. This is correct in the harness because the test harness globally freezes `Date` to the scenario's pinned clock — no injected date parameter is needed.

Use `toLocalISODate(new Date())` (imported from `../plan/helpers.js` — Plan 012 moves it there from `plan-proposer.ts` and re-exports for compatibility) instead of `new Date().toISOString().slice(0, 10)`. `toISOString()` shifts dates back by one day in positive-UTC-offset timezones like Europe/Madrid — using `toLocalISODate` avoids this.

The `[Last weekly report]` button must only appear when a completed prior calendar week has measurements. A "completed week" means `lastWeekEnd <= today` (Sunday itself counts as complete — matching the backlog and ui-architecture copy "ready Sunday"). Use `getCalendarWeekBoundaries` (Step 5) and `store.getMeasurements` to check. This matches the ui-architecture spec: "Inline keyboard (if a completed weekly report exists)."

```typescript
case 'progress': {
  session.surfaceContext = 'progress';

  // Use local-date helper to avoid UTC timezone shift (toISOString shifts
  // dates back one day in positive-offset timezones like Europe/Madrid).
  const today = toLocalISODate(new Date());
  const existing = await store.getTodayMeasurement('default', today);

  if (existing) {
    session.progressFlow = null;
    // Show [Last weekly report] only if a completed prior week has data.
    const { lastWeekStart, lastWeekEnd } = getCalendarWeekBoundaries(today);
    const lastWeekData = await store.getMeasurements('default', lastWeekStart, lastWeekEnd);
    const hasCompletedWeekReport = lastWeekData.length > 0;
    const text = 'Already logged today ✓';
    if (hasCompletedWeekReport) {
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
2. If one number: weight only. Call `store.logMeasurement('default', today, weight, null)`. Set `progressFlow = null`. After logging, check for a completed prior week (`getCalendarWeekBoundaries` + `getMeasurements`) — if one exists, include `{ reply_markup: progressReportKeyboard }` with the confirmation reply. This matches the ui-architecture spec: the inline keyboard appears "if a completed weekly report exists" — not just on repeat taps of Progress, but also immediately after a successful log if a prior completed week has data.
3. If two numbers: destructure `const [a, b] = parsed.values` and call `assignWeightWaist(a, b, lastMeasurement)`.
   - If not ambiguous: log immediately. Set `progressFlow = null`. Reply with confirmation.
   - If ambiguous: set `progressFlow = { phase: 'confirming_disambiguation', pendingWeight, pendingWaist, pendingDate: today }`. Store `today` at parse time to handle the edge case where the user enters numbers before midnight but taps [Yes] after midnight. Reply with `sink.reply(formatDisambiguationPrompt(pendingWeight, pendingWaist), { reply_markup: progressDisambiguationKeyboard })`.

**4d. Add disambiguation callback handlers in `handleCallback()` (after existing callback routing):**

Guard first: if `session.progressFlow?.phase !== 'confirming_disambiguation'` or any of `pendingWeight`, `pendingWaist`, `pendingDate` are missing, reply "That measurement confirmation expired. Tap Progress to log again." and set `progressFlow = null`. This handles stale buttons from previous sessions, double taps, or taps after `/cancel`.

- `pg_disambig_yes`: read `session.progressFlow.pendingDate` (log that date, not today). Check `getLatestMeasurement` before logging — if null, this is the first measurement; append the first-measurement hint to the confirmation. Call `store.logMeasurement('default', pendingDate, pendingWeight, pendingWaist)`. Set `progressFlow = null`. Reply with confirmation (+ hint if first).
- `pg_disambig_no`: swap pendingWeight/pendingWaist, log with `pendingDate`. Same first-measurement hint check. Set `progressFlow = null`. Reply with confirmation.

**Text in `confirming_disambiguation` phase:** If the user types text instead of tapping a button, reply: "Use the buttons above to confirm." Stay in `confirming_disambiguation`. Do not parse the text as new measurement input.

**4f. Widen `OutputSink.reply` to support `parse_mode` — prerequisite for the weekly report formatter (Step 5):**

The weekly report uses `parse_mode: 'Markdown'`. The current `OutputSink` interface only allows `{ reply_markup?: Keyboard | InlineKeyboard }` — passing `parse_mode` causes an excess-property TypeScript error.

Changes:
- In `src/telegram/core.ts` line 145, widen options to:
  ```typescript
  reply(text: string, options?: { reply_markup?: Keyboard | InlineKeyboard; parse_mode?: string }): Promise<void>;
  ```
- In `src/telegram/bot.ts` `grammyOutputSink`, the cast on line 85 already uses `as ... | undefined` — update it to include `parse_mode?: string` so the real grammY `ctx.reply` receives it.
- `CapturingOutputSink` (`src/harness/capturing-sink.ts`) requires no change — it already reads only `options?.reply_markup`, so additional options are silently ignored in harness runs. `parse_mode` does not affect harness transcript fidelity.

**4e. Clear `progressFlow` when entering other flows:**

Three locations:
1. In `handleMenu()`, the existing `session.recipeFlow = null; session.planFlow = null;` at line 643-644 (which Phase 0 will modify to be smarter) should also clear `progressFlow = null`.
2. In `handleCommand()` for `/start` (core.ts ~line 247): add `session.progressFlow = null` alongside the existing `session.recipeFlow = null`.
3. In `handleCommand()` for `/cancel` (core.ts ~line 253-254): add `session.progressFlow = null` alongside the existing `session.recipeFlow = null`.

This prevents stale flow state when the user restarts or cancels mid-flow.

### Step 5: Formatters

**5a. Add to `src/telegram/formatters.ts`:**

**`formatMeasurementConfirmation(weight: number, waist: number | null): string`**
- Weight + waist: `"Logged ✓ 82.3 kg / 91 cm"`
- Weight only: `"Logged ✓ 82.3 kg"`

**`formatWeeklyReport(currentWeek: Measurement[], previousWeek: Measurement[], weekStart: string, weekEnd: string): string`**
- Compute averages for current and previous weeks.
- The existing `src/telegram/formatters.ts` file header says "Uses Telegram's MarkdownV2" — add a local comment above `formatWeeklyReport` clarifying: `// Note: this formatter uses legacy Markdown mode (parse_mode: 'Markdown'), not MarkdownV2.`
- **No previous week data** (`previousWeek.length === 0`): show current week averages only, no delta arrows, no tone message that requires a previous baseline. Append: `_Next report ready Sunday._ _(delta shown once you have two weeks of data)_`
- **Previous week has weight but no waist** (`previousAvgWaist` is null): compute weight delta normally; skip waist delta line (as if no previous waist).
- **Current week has weight but no waist** (`currentWeek` has no waist measurements): omit waist line entirely from the report — do not compare waist.
- Format (when previous data exists): `*Week of Mar 30 – Apr 5*\n\nWeight: *82.1 kg* avg (↓0.4 from last week)\nWaist: *90.5 cm* avg (↓0.3 from last week)\n\n{tone message}`
- Uses `parse_mode: 'Markdown'` (legacy Telegram Markdown). Bold syntax is `*text*` (single asterisk), NOT `**text**`. Italic is `_text_`. Do not use MarkdownV2 — its escaping requirements make the formatter brittle for numbers with dots and dashes.
- Omit waist line entirely if no waist measurements exist in the current week.
- Append: `_Next report ready Sunday._`

**`pickWeeklyReportTone(currentAvgWeight: number, previousAvgWeight: number, currentAvgWaist: number | null, previousAvgWaist: number | null): string`**

Only called when `previousWeek.length > 0` (previous data exists). Delta = currentAvgWeight − previousAvgWeight:
- Loss > 0.5 kg: "Great progress. If this pace holds, we might ease up slightly -- sustainability matters more than speed."
- Loss 0.1–0.5 kg (i.e. delta ≤ −0.1): "Steady and sustainable. 0.2-0.5 kg/week is a healthy, sustainable pace."
- Plateau (−0.1 < delta < 0.3 kg): if both `currentAvgWaist` and `previousAvgWaist` are non-null and waist is down, use: "Weight is stable but your waist is down {waistDelta} cm -- you're recomposing, the scale will catch up." Otherwise: "Weight is stable -- normal. Fluctuations mask fat loss. Keep going."
- Up 0.3+ kg (delta ≥ 0.3): "Week-to-week fluctuations happen -- water, food volume, stress. One week doesn't define the trend. Keep going."

This covers every range without gaps: loss (> 0.5, 0.1–0.5), plateau (±0.1 to 0.3 gain, treated as noise), and meaningful gain (≥ 0.3).

**`getCalendarWeekBoundaries(today: string): { currentWeekStart: string; currentWeekEnd: string; lastWeekStart: string; lastWeekEnd: string; prevWeekStart: string; prevWeekEnd: string }`**
- Calendar weeks are Mon-Sun.
- "Last completed week" = the most recent Mon-Sun where `lastWeekEnd <= today`. Sunday counts as completed (if today is Sunday Apr 6, `lastWeekEnd` = Apr 6, the week is complete). The report NEVER shows data from the current in-progress week — if today is Wednesday, the last completed week ended the previous Sunday.
- "Previous week" = the week before the last completed week (for delta computation). Export as `prevWeekStart` / `prevWeekEnd`.
- **This utility must be exported from its module.** Step 4a imports it to check whether a completed weekly report exists before showing the `[Last weekly report]` button. Put it in `src/utils/dates.ts` (new file) rather than `formatters.ts` — it is needed by both the formatter and the menu handler, and importing from `formatters.ts` inside the core handler would create a circular-ish coupling. `src/utils/dates.ts` is a neutral home for pure date math.

### Step 6: Weekly report callback

**6a. Add progress inline keyboards in `src/telegram/keyboards.ts`:**

```typescript
/** Progress screen: disambiguation prompt — confirm which number is weight vs waist. */
export const progressDisambiguationKeyboard = new InlineKeyboard()
  .text('Yes', 'pg_disambig_yes')
  .text('No, swap them', 'pg_disambig_no');

/** Progress screen: show the last completed weekly report. */
export const progressReportKeyboard = new InlineKeyboard()
  .text('Last weekly report', 'pg_last_report');
```

**6b. Handle `pg_last_report` callback in `handleCallback()` in `src/telegram/core.ts`:**

Three cases:
1. **Completed week with data:** Compute `getCalendarWeekBoundaries(today)`. "Completed" means `lastWeekEnd <= today` (Sunday counts as complete — a user logging on Sunday gets the report). Query `store.getMeasurements('default', lastWeekStart, lastWeekEnd)` and `store.getMeasurements('default', prevWeekStart, prevWeekEnd)`. If last week has data, format and reply with `formatWeeklyReport(...)` passing `{ parse_mode: 'Markdown' }` to `sink.reply()`.
2. **No completed week with data:** "Not enough data for a report yet -- keep logging and your first report will be ready Sunday." (plain text reply, no parse_mode needed)
3. **No measurements at all:** Same message as case 2 (defensive; button shouldn't appear, but handle gracefully).

### Step 7: First measurement education

On the very first measurement ever (no prior measurements from `getLatestMeasurement`), append a one-time hint after the confirmation:

```
Logged ✓ 82.3 kg / 91 cm

We track weekly averages, not daily -- so don't worry about day-to-day swings. Come back tomorrow -- we'll start tracking your trend.
```

Check `getLatestMeasurement('default')` before logging. If null, this is the first. Append the hint to the confirmation message. Do not persist a "has seen hint" flag — checking "was there a prior measurement" is equivalent and stateless.

### Step 8: Test scenario

**8a. Author scenario `test/scenarios/015-progress-logging/spec.ts`:**

Next available number is **015** (014 is `proposer-orphan-fill`). Spec skeleton:

```typescript
import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '015-progress-logging',
  description: 'Progress: first log, first-measurement hint, already-logged same day, defensive pg_last_report with no completed week',
  clock: '2026-04-09T10:00:00Z',   // Wednesday — clearly mid-week, no completed prior week
  recipeSet: 'minimal',             // generate.ts throws on empty; progress is recipe-independent
  initialState: {},                 // fresh user — no measurements, no plan
  events: [
    command('start'),
    text('📊 Progress'),            // reply keyboard button → text(), NOT click()
    text('82.3 / 91'),              // measurement input
    text('📊 Progress'),            // same day — already logged
    click('pg_last_report'),        // defensive: no completed week → "not enough data"
  ],
});
```

**Important:** `text('📊 Progress')` not `click(...)` — "Progress" is a reply keyboard button (main menu). Reply keyboard buttons arrive as plain text messages; `click()` is for inline keyboard callbacks only.

Expected outputs (verify after generate):
- Step 2 (`text('📊 Progress')`): prompt with examples. No keyboard.
- Step 3 (`text('82.3 / 91')`): "Logged ✓ 82.3 kg / 91 cm" + first-measurement hint. No inline keyboard (no completed prior week).
- Step 4 (`text('📊 Progress')`): "Already logged today ✓". No inline keyboard — clock is mid-week, no completed calendar week with data.
- Step 5 (`click('pg_last_report')`): "Not enough data for a report yet — keep logging and your first report will be ready Sunday."

**8b. Author scenario `test/scenarios/016-progress-weekly-report/spec.ts`:**

This scenario seeds a full prior week of measurements to exercise the weekly report callback and tone logic end-to-end through the harness. It is the only way to verify that `formatWeeklyReport`, `pickWeeklyReportTone`, and `getCalendarWeekBoundaries` work correctly together through real harness dispatch.

```typescript
import { defineScenario, text, click } from '../../../src/harness/define.js';
import type { Measurement } from '../../../src/models/types.js';

// Clock: Monday Apr 13 — last completed week is Mon Apr 6 – Sun Apr 12.
// Previous week: Mon Mar 30 – Sun Apr 5.
const LAST_WEEK_MEASUREMENTS: Measurement[] = [
  { id: 'meas-1', userId: 'default', date: '2026-04-06', weightKg: 82.5, waistCm: 91.5, createdAt: '2026-04-06T08:00:00Z' },
  { id: 'meas-2', userId: 'default', date: '2026-04-07', weightKg: 82.3, waistCm: 91.2, createdAt: '2026-04-07T08:00:00Z' },
  { id: 'meas-3', userId: 'default', date: '2026-04-08', weightKg: 82.1, waistCm: 91.0, createdAt: '2026-04-08T08:00:00Z' },
  { id: 'meas-4', userId: 'default', date: '2026-04-09', weightKg: 82.4, waistCm: 91.1, createdAt: '2026-04-09T08:00:00Z' },
  { id: 'meas-5', userId: 'default', date: '2026-04-10', weightKg: 82.2, waistCm: 90.9, createdAt: '2026-04-10T08:00:00Z' },
  { id: 'meas-6', userId: 'default', date: '2026-04-11', weightKg: 82.0, waistCm: 90.8, createdAt: '2026-04-11T08:00:00Z' },
  { id: 'meas-7', userId: 'default', date: '2026-04-12', weightKg: 81.9, waistCm: 90.7, createdAt: '2026-04-12T08:00:00Z' },
];
const PREV_WEEK_MEASUREMENTS: Measurement[] = [
  { id: 'meas-8', userId: 'default', date: '2026-03-30', weightKg: 83.1, waistCm: 92.0, createdAt: '2026-03-30T08:00:00Z' },
  { id: 'meas-9', userId: 'default', date: '2026-03-31', weightKg: 82.9, waistCm: 91.8, createdAt: '2026-03-31T08:00:00Z' },
];

export default defineScenario({
  name: '016-progress-weekly-report',
  description: 'Progress: tap [Last weekly report] with a full completed week seeded — verifies tone, averages, and delta computation',
  clock: '2026-04-13T10:00:00Z',   // Monday — last completed week Apr 6–12 is fully past
  recipeSet: 'minimal',
  initialState: {
    measurements: [...LAST_WEEK_MEASUREMENTS, ...PREV_WEEK_MEASUREMENTS],
  },
  events: [
    text('📊 Progress'),           // already logged? no — Apr 13 not in seed. Gets prompt.
    text('82.0'),                  // log today (weight only)
    click('pg_last_report'),       // completed week Apr 6–12 exists → show report
  ],
});
```

**Note:** `initialState.measurements` requires Step 1f to add `measurements?: Measurement[]` to `ScenarioInitialState` in `src/harness/types.ts`. Author this spec after Step 1f lands.

Expected outputs (verify after generate):
- Step 1: measurement prompt (Monday morning, no time qualifier).
- Step 2: "Logged ✓ 82.0 kg" — weight only. Inline keyboard with `[Last weekly report]` (Apr 6–12 completed week exists). No first-measurement hint (prior measurements exist in seed).
- Step 3: weekly report showing Apr 6–12 avg vs Mar 30–Apr 5 avg. Tone: steady-loss range (avg ~82.2 vs ~83.0, delta ~−0.8 → "Great progress" path). Append `_Next report ready Sunday._`

**8c. Unit tests — `test/unit/progress.test.ts`:**

The pure functions are high-risk, not exercised at granularity by the scenarios above. Create `test/unit/progress.test.ts` (follows the pattern of `test/unit/solver.test.ts`):

- **`parseMeasurementInput`**: "82.3" → `{values:[82.3]}`, "82.3 / 91" → `{values:[82.3,91]}`, "82.3, 91" → same, "82.3 91" → same, "82.3 / 91 / 40" → null, "-5" → null, "0" → null, "hello" → null.
- **`assignWeightWaist`**: unambiguous (prior 82kg/91cm → 82.5/91.5 → weight=82.5, waist=91.5, ambiguous=false); null waistCm prior → ambiguous=true; conflict (both closer to weight) → ambiguous=true; no prior → ambiguous=true.
- **`getCalendarWeekBoundaries`**: Wednesday Apr 9 → lastWeek=Mar30–Apr5, prevWeek=Mar23–Mar29; Sunday Apr 6 → lastWeek=Mar30–Apr6 (inclusive, `<=`), prevWeek=Mar23–Mar29; Monday Apr 7 → lastWeek=Mar31–Apr6, prevWeek=Mar24–Mar30; year-crossing (Jan 2 → lastWeek=Dec22–Dec28, prevWeek=Dec15–Dec21).
- **`formatWeeklyReport`** / **`pickWeeklyReportTone`**: loss >0.5, loss 0.1–0.5, plateau with waist down, plateau no waist, gain ≥0.3; no-previous-week shows no delta; waist absent from current week omits waist line.

**8d. Generate recordings:**

```bash
npm run test:generate -- 015-progress-logging
npm run test:generate -- 016-progress-weekly-report
```

These call the real LLM only if new LLM calls are needed — progress scenarios make no LLM calls (pure dispatch/store logic), so generate will record zero LLM fixtures but will still capture outputs, finalSession, and finalStore. Verify both `recorded.json` files as per `docs/product-specs/testing.md`.

**8e. Update `test/scenarios/index.md`:** Add rows for 015 and 016.

**8f. `npm test` must pass** — all 16 scenarios + unit tests green.

## Progress

- [x] Step 1: Measurement data model + persistence (schema, migration, types, store, test-store)
- [x] Step 2: Progress flow state on BotCoreSession
- [x] Step 3: Measurement input parsing (progress-flow.ts)
- [x] Step 4: Progress menu handler + text routing + disambiguation callbacks
- [x] Step 5: Formatters (confirmation, weekly report, tone, date boundaries)
- [x] Step 6: Weekly report callback handler
- [x] Step 7: First measurement education hint
- [x] Step 8: Test (015-progress-logging scenario, 016-progress-weekly-report scenario, progress.test.ts unit tests, update index.md)
- [x] Final: `npm test` passes, all acceptance criteria met

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

- **Decision:** Weekly report uses Telegram legacy markdown (`parse_mode: 'Markdown'`), not MarkdownV2 and not plain text.
  **Rationale:** The ui-architecture spec shows bold formatting in the weekly report. Legacy `Markdown` mode uses `*bold*` (single asterisk) and `_italic_` — simpler than MarkdownV2 which requires escaping every `.`, `-`, `(`, `)`, and digit. **Note: Telegram legacy bold is `*text*`, not `**text**`.** MarkdownV2 is avoided because the report content (numbers with dots, weight deltas with `↓`) would require pervasive escaping. All other formatters remain plain text — `parse_mode: 'Markdown'` is scoped to `formatWeeklyReport` and its `sink.reply()` call only.
  **Date:** 2026-04-07

- **Decision:** `parseMeasurementInput` returns `{ values: [number] | [number, number] } | null`, not `{ weight, waist }`.
  **Rationale:** The parser must not assign weight/waist meaning — disambiguation may be needed. Returning a positional tuple preserves raw values without implying semantic roles. Callers destructure `values[0]` and `values[1]` explicitly and pass them to `assignWeightWaist`.
  **Date:** 2026-04-07

- **Decision:** `assignWeightWaist` uses ordinal proximity comparison, not an arbitrary numeric threshold.
  **Rationale:** Any fixed threshold (e.g., "within 5") is physically meaningless since weight and waist are measured in different units at different scales. Proximity comparison — which number is closer to the prior weight, which is closer to the prior waist — is scale-independent and unambiguous. If the nearest-neighbor assignments conflict, or if no prior data exists, it is ambiguous and the user is asked to confirm.
  **Date:** 2026-04-07

## Validation

1. **`npm test` passes** — but note: Step 1f adds `progressFlow` to `BotCoreSession` and optionally `measurements` to `TestStateStore.snapshot()`. If `measurements` is included in snapshots even when empty, all existing `recorded.json` files will include `"measurements": []` in `finalStore` and `"progressFlow": null` in `finalSession`. After Step 1f and Step 2, regenerate all existing scenarios: `for each scenario in test/scenarios: npm run test:generate -- <name> --regenerate`. Preferred approach: omit `measurements` from snapshot when empty (see Step 1f) to minimize diff blast radius.
2. **New scenario covers the happy path**: tap Progress, enter measurements, see confirmation, tap Progress again same day, see "already logged" with no keyboard (no completed prior week), defensive `pg_last_report` click returns "not enough data."
3. **Manual verification** (`npm run dev`):
   - Tap [Progress] first time — see prompt with examples.
   - Type "82.3 / 91" — see "Logged ✓ 82.3 kg / 91 cm" + first-measurement hint.
   - Tap [Progress] again — see "Already logged today ✓" (no button for a fresh user; button appears after a full completed prior week has data).
   - After a full completed prior week of logging: tap [Progress] → see "Already logged today ✓" + `[Last weekly report]` button. Tap it → see weekly averages + tone.
   - Test afternoon time-aware prompt (after 14:00 local time).
4. **Disambiguation**: enter two close numbers on first measurement (no prior data) — confirm disambiguation prompt appears. On subsequent days with prior data, close numbers resolve silently.
