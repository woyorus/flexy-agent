/**
 * Scenario-local assertions for 035-navigation-progress-log-prompt.
 *
 * Plan 032 Wave E — sibling to 030 covering the one `LastRenderedView`
 * variant 030 cannot reach: progress/log_prompt. Single-step scenario:
 * tap 📊 Progress with no measurement today → log_prompt.
 */

import { assertLastRenderedView } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'With no measurement logged today, tapping 📊 Progress sets ' +
  'lastRenderedView to { surface: "progress", view: "log_prompt" }. Covers ' +
  'the one navigation-state variant scenario 030 cannot reach.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertLastRenderedView(ctx, { surface: 'progress', view: 'log_prompt' });
}
