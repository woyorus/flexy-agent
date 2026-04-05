/**
 * Scenario 003 — minimal recipe set forces gap generation.
 *
 * The `minimal/` fixture set has 1 breakfast + 2 lunch/dinner recipes.
 * Six lunch/dinner slots across the week can't all be filled from the
 * existing library, so the plan-proposer emits `recipesToGenerate`
 * entries and the flow enters the gap-resolution sub-flow.
 *
 * The scenario exercises the "pick from existing recipes" path
 * (`plan_skip_gap_*`) rather than recipe generation because recipe
 * generation calls the expensive `primary` model and adds significant
 * cost to every regenerate. Scenario 001 already verifies the happy
 * proposal path; this scenario's job is to lock in the gap-handling
 * flow against regression.
 *
 * ## What happens at generate time
 *
 * We can't know in advance how many gaps the proposer emits with a
 * 2-recipe library. The `plan_skip_gap_*` sequence below is an
 * optimistic guess — if it's too long or too short, generate fails
 * loudly and we adjust. The failure mode is clear: either the skip
 * click lands on a wrong phase, or we run out of gaps to skip, both of
 * which produce an obvious diagnostic in the error output.
 *
 * Given a 2-recipe library and 6 lunch/dinner slots across 6 days (Mon-Sat,
 * Sunday is typically flex), gaps are almost certain; in practice the
 * proposer picks a distribution that minimizes gap count, so we start
 * with a modest skip chain and grow it if needed.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '003-plan-week-minimal-recipes',
  description:
    'Minimal recipe set (2 lunch/dinner recipes) forces recipe gaps; user skips through them.',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'minimal',
  initialState: {
    plans: [],
    session: null,
  },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    // Proposal returns with recipe gaps. Skip through them using existing
    // recipes — this exercises the gap-resolution sub-flow without
    // invoking the expensive primary-model recipe generator.
    click('plan_skip_gap_0'),
    click('plan_skip_gap_1'),
    click('plan_skip_gap_2'),
    click('plan_approve'),
  ],
});
