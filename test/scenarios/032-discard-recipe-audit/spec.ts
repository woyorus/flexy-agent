/**
 * Scenario 032 — `discard_recipe` callback clears `recipeFlow` (audit lock).
 *
 * Part of Plan 027 (Navigation state model / Plan B audit). Covers audit
 * site #4 from the plan's decision table. The user enters the recipe-creation
 * flow via 📖 My Recipes → Add new recipe → Lunch meal type (no LLM call;
 * the flow is parked at `phase === 'awaiting_preferences'`), then taps
 * Discard. The scenario asserts:
 *
 *   - `recipeFlow === null` after the discard tap (audit decision "leave
 *     alone" — current behavior preserved).
 *   - No plan state was disturbed (the user was not in a planFlow).
 *
 * Clock: 2026-04-08T10:00:00Z. Zero LLM calls (no recipe generation, no
 * plan lifecycle queries).
 */

import { defineScenario, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '032-discard-recipe-audit',
  description:
    'Audit regression lock: user enters recipe flow, taps Discard — recipeFlow cleared (Plan 027 decision "leave alone").',
  clock: '2026-04-08T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: { session: null },
  events: [
    text('📖 My Recipes'),          // library renders, recipeFlow unchanged
    click('add_recipe'),            // enters recipeFlow, meal-type keyboard
    click('meal_type_lunch'),       // phase → awaiting_preferences (no LLM yet)
    click('discard_recipe'),        // CLEARS recipeFlow
  ],
});
