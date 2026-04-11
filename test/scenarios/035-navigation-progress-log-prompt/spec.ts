/**
 * Scenario 035 — navigation state for progress/log_prompt variant.
 *
 * Part of Plan 027 (Navigation state model). Companion to scenario 030
 * which covers nine of ten `LastRenderedView` variants via per-step
 * assertions. Scenario 030 cannot cover `progress/log_prompt` because
 * its seed includes today's measurement (needed for steps 10 and 11 to
 * hit the "already logged" + `pg_last_report` branches that both set
 * `weekly_report`). This sibling uses the opposite seed — NO measurement
 * today — so the progress menu handler takes the "no measurement today"
 * branch that sets `lastRenderedView = { surface: 'progress', view: 'log_prompt' }`.
 *
 * Single-step scenario: tap 📊 Progress. Terminal variant is log_prompt.
 *
 * Clock: 2026-04-08T10:00:00Z. Zero LLM calls. No plan needed.
 */

import { defineScenario, text } from '../../../src/harness/define.js';

export default defineScenario({
  name: '035-navigation-progress-log-prompt',
  description:
    'Navigation state: single-step scenario asserting progress/log_prompt terminal variant (the one variant scenario 030 cannot cover).',
  clock: '2026-04-08T10:00:00Z',
  recipeSet: 'six-balanced',
  captureStepState: true,
  initialState: { session: null }, // no measurements seeded
  events: [
    text('📊 Progress'), // sessionAt[0] — progress/log_prompt
  ],
});
