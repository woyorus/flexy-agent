/**
 * Scenario-local assertions for 019-shopping-list-tiered.
 *
 * Plan 032 Wave F — three-tier shopping list (sl_next from menu, then
 * sl_<date> callback). The tiered rendering carries role-enriched
 * ingredients (protein/carb/fat/vegetable/seasoning).
 */

import { assertLastRenderedView } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Tapping 🛒 Shopping List from an active plan renders the next-cook-day ' +
  'list; the sl_<date> callback renders a day-scoped list; both reflect ' +
  'role-enriched ingredients and the final lastRenderedView carries the ' +
  'navigation state for the last-tapped view.';

export function assertBehavior(ctx: AssertionsContext): void {
  const handlers = ctx.execTrace.handlers;
  if (!handlers.includes('callback:sl_next')) {
    throw new Error('Expected callback:sl_next in trace; not found.');
  }
  const slDayHit = handlers.some((h) => h.startsWith('callback:sl_2026-'));
  if (!slDayHit) {
    throw new Error('Expected a callback:sl_<date> in trace; not found.');
  }

  // Final state (after na_show which is the last event): back to next_action.
  assertLastRenderedView(ctx, { surface: 'plan', view: 'next_action' });
}
