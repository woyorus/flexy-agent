/**
 * Scenario 030 — navigation state tracking across every render surface.
 *
 * Part of Plan 027 (Navigation state model). Drives the user through
 * nine of ten `LastRenderedView` variants via menu taps and inline
 * callbacks, and uses Task 4b's opt-in per-step session capture
 * (`captureStepState: true`) to assert EACH variant end-to-end at its
 * step — not just the terminal one. This satisfies proposal 003's
 * verification contract: "Scenarios that drive the user through existing
 * flows and verify the new state is tracked correctly"
 * (`docs/design-docs/proposals/003-freeform-conversation-layer.md:755`).
 *
 * The tenth variant — `progress/log_prompt` — requires a seed state
 * where NO measurement has been logged today, which is mutually
 * exclusive with this scenario's `progress/weekly_report` assertion at
 * step 10 (which needs today's measurement pre-logged). That variant is
 * covered by sibling scenario 035.
 *
 * The scenario walks (in order). `sessionAt[n]` is the session snapshot
 * captured immediately after event `n` (zero-based):
 *
 *   sessionAt[0]:  📋 My Plan       → { surface: 'plan', view: 'next_action' }
 *   sessionAt[1]:  wo_show          → { surface: 'plan', view: 'week_overview' }
 *   sessionAt[2]:  dd_2026-04-09    → { surface: 'plan', view: 'day_detail', day: '2026-04-09' }
 *   sessionAt[3]:  cv_<batchId>     → { surface: 'cooking', view: 'cook_view', batchId, recipeSlug }
 *   sessionAt[4]:  📖 My Recipes    → { surface: 'recipes', view: 'library' }
 *   sessionAt[5]:  rv_<slug>        → { surface: 'recipes', view: 'recipe_detail', slug }
 *   sessionAt[6]:  recipe_back      → { surface: 'recipes', view: 'library' }  (same variant, different call site)
 *   sessionAt[7]:  🛒 Shopping List → { surface: 'shopping', view: 'next_cook' }
 *   sessionAt[8]:  sl_2026-04-09    → { surface: 'shopping', view: 'day', day: '2026-04-09' }
 *   sessionAt[9]:  📊 Progress      → { surface: 'progress', view: 'weekly_report' }  (already-logged branch)
 *   sessionAt[10]: pg_last_report   → { surface: 'progress', view: 'weekly_report' }  (prior-week data branch)
 *
 * Clock: 2026-04-08T10:00:00Z (active_mid, same as scenario 018).
 */

import { defineScenario, text, click } from '../../../src/harness/define.js';
import type { PlanSession, Batch, Measurement } from '../../../src/models/types.js';

const activeSession: PlanSession = {
  id: 'session-030-0000-0000-0000-000000000001',
  horizonStart: '2026-04-06',
  horizonEnd: '2026-04-12',
  breakfast: {
    locked: true,
    recipeSlug: 'salmon-avocado-toast-soft-eggs-cinnamon-yogurt',
    caloriesPerDay: 390,
    proteinPerDay: 31,
  },
  treatBudgetCalories: 1050,
  flexSlots: [
    { day: '2026-04-12', mealTime: 'lunch' as const, flexBonus: 300, note: 'flex lunch' },
  ],
  events: [
    { name: 'Sunday dinner out', day: '2026-04-12', mealTime: 'dinner' as const, estimatedCalories: 900 },
  ],
  mutationHistory: [],
  confirmedAt: '2026-04-06T08:00:00.000Z',
  superseded: false,
  createdAt: '2026-04-06T08:00:00.000Z',
  updatedAt: '2026-04-06T08:00:00.000Z',
};

/**
 * Same batch layout as scenario 018. Thu Apr 9 is the next cook day
 * (batch 3 lunch, batch 4 dinner). Mon–Wed meals are reheats of
 * batches 1 and 2 (cooked Apr 6).
 */
const activeBatches: Batch[] = [
  // Batch 1: Mon–Wed Lunch (reheat phase on Apr 8)
  {
    id: 'batch-030-lunch1-0000-0000-000000000001',
    recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
    mealType: 'lunch',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
    servings: 3,
    targetPerServing: { calories: 893, protein: 56 },
    actualPerServing: { calories: 893, protein: 56, fat: 46, carbs: 68 },
    scaledIngredients: [
      { name: 'chicken breast, raw', amount: 190, unit: 'g', totalForBatch: 570, role: 'protein' as const },
      { name: 'black beans, canned, drained', amount: 75, unit: 'g', totalForBatch: 225, role: 'carb' as const },
      { name: 'small avocado', amount: 1, unit: 'whole', totalForBatch: 3, role: 'fat' as const },
      { name: 'olive oil', amount: 22, unit: 'ml', totalForBatch: 66, role: 'fat' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  // Batch 2: Mon–Wed Dinner
  {
    id: 'batch-030-dinner1-0000-0000-000000000002',
    recipeSlug: 'moroccan-beef-tagine-style-skillet-with-lemon-couscous',
    mealType: 'dinner',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
    servings: 3,
    targetPerServing: { calories: 720, protein: 48 },
    actualPerServing: { calories: 720, protein: 48, fat: 28, carbs: 72 },
    scaledIngredients: [
      { name: 'ground beef', amount: 200, unit: 'g', totalForBatch: 600, role: 'protein' as const },
      { name: 'couscous', amount: 80, unit: 'g', totalForBatch: 240, role: 'carb' as const },
      { name: 'olive oil', amount: 15, unit: 'ml', totalForBatch: 45, role: 'fat' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  // Batch 3: Thu–Sat Lunch (next cook day is Thu Apr 9)
  {
    id: 'batch-030-lunch2-0000-0000-000000000003',
    recipeSlug: 'ground-beef-rigatoni-bolognese',
    mealType: 'lunch',
    eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
    servings: 3,
    targetPerServing: { calories: 780, protein: 52 },
    actualPerServing: { calories: 780, protein: 52, fat: 32, carbs: 78 },
    scaledIngredients: [
      { name: 'ground beef', amount: 180, unit: 'g', totalForBatch: 540, role: 'protein' as const },
      { name: 'rigatoni', amount: 90, unit: 'g', totalForBatch: 270, role: 'carb' as const },
      { name: 'cherry tomatoes', amount: 150, unit: 'g', totalForBatch: 450, role: 'vegetable' as const },
      { name: 'olive oil', amount: 15, unit: 'ml', totalForBatch: 45, role: 'fat' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  // Batch 4: Thu–Sat Dinner
  {
    id: 'batch-030-dinner2-0000-0000-000000000004',
    recipeSlug: 'soy-ginger-pork-rice-bowls-broccoli-carrots-scallions',
    mealType: 'dinner',
    eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
    servings: 3,
    targetPerServing: { calories: 650, protein: 44 },
    actualPerServing: { calories: 650, protein: 44, fat: 22, carbs: 65 },
    scaledIngredients: [
      { name: 'pork tenderloin', amount: 180, unit: 'g', totalForBatch: 540, role: 'protein' as const },
      { name: 'broccoli', amount: 100, unit: 'g', totalForBatch: 300, role: 'vegetable' as const },
      { name: 'basmati rice', amount: 80, unit: 'g', totalForBatch: 240, role: 'carb' as const },
      { name: 'soy sauce', amount: 20, unit: 'ml', totalForBatch: 60, role: 'seasoning' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
];

/**
 * Measurements seed: one measurement today (so step 10's progress menu
 * tap takes the "already logged today" branch that sets `weekly_report`)
 * AND enough prior-week data that `getMeasurements(lastWeekStart, lastWeekEnd)`
 * returns a non-empty array — this triggers `progressReportKeyboard` on
 * step 10's output AND makes step 11's `pg_last_report` take the
 * "has data" branch rather than the "not enough data" error.
 *
 * Today (scenario clock) = 2026-04-08 (Wed). Current week starts Mon
 * 2026-04-06. `getCalendarWeekBoundaries(today)` returns last completed
 * week as Mon 2026-03-30 → Sun 2026-04-05. Seed at least 4 measurements
 * in that range so the weekly report is computable.
 */
const measurements: Measurement[] = [
  { id: 'meas-030-1', userId: 'default', date: '2026-04-08', weightKg: 82.5, waistCm: 91, createdAt: '2026-04-08T08:00:00Z' }, // today
  { id: 'meas-030-2', userId: 'default', date: '2026-04-05', weightKg: 82.7, waistCm: 91, createdAt: '2026-04-05T08:00:00Z' }, // prior week Sun
  { id: 'meas-030-3', userId: 'default', date: '2026-04-04', weightKg: 82.8, waistCm: 91, createdAt: '2026-04-04T08:00:00Z' }, // prior week Sat
  { id: 'meas-030-4', userId: 'default', date: '2026-04-02', weightKg: 83.0, waistCm: 92, createdAt: '2026-04-02T08:00:00Z' }, // prior week Thu
  { id: 'meas-030-5', userId: 'default', date: '2026-03-31', weightKg: 83.2, waistCm: 92, createdAt: '2026-03-31T08:00:00Z' }, // prior week Tue
];

export default defineScenario({
  name: '030-navigation-state-tracking',
  description:
    'Navigation state: walks through every render surface (plan subviews, cook view, shopping scopes, recipe library/detail, progress) with per-step session assertions that verify every LastRenderedView variant end-to-end.',
  clock: '2026-04-08T10:00:00Z',
  recipeSet: 'six-balanced',
  captureStepState: true,  // Plan 027 Task 4b — assert sessionAt[] per step
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
    measurements,
  },
  events: [
    text('📋 My Plan'),                                                  // sessionAt[0] — plan/next_action
    click('wo_show'),                                                     // sessionAt[1] — plan/week_overview
    click('dd_2026-04-09'),                                               // sessionAt[2] — plan/day_detail
    click('cv_batch-030-lunch2-0000-0000-000000000003'),                  // sessionAt[3] — cooking/cook_view
    text('📖 My Recipes'),                                                // sessionAt[4] — recipes/library
    click('rv_chicken-black-bean-avocado-rice-bowl'),                     // sessionAt[5] — recipes/recipe_detail
    click('recipe_back'),                                                 // sessionAt[6] — recipes/library (again)
    text('🛒 Shopping List'),                                             // sessionAt[7] — shopping/next_cook
    click('sl_2026-04-09'),                                               // sessionAt[8] — shopping/day
    text('📊 Progress'),                                                  // sessionAt[9] — progress/weekly_report (already-logged-today branch)
    click('pg_last_report'),                                              // sessionAt[10] — progress/weekly_report (pg_last_report handler)
  ],
});
