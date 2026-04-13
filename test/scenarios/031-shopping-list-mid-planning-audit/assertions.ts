/**
 * Scenario-local assertions for 031-shopping-list-mid-planning-audit.
 *
 * Plan 032 Wave E — Plan 027 audit regression lock. Locks the current
 * behavior of `shopping_list` menu handler's conditional clear of
 * planFlow mid-planning. "Leave alone" audit decision — a future change
 * that flips this surfaces as a visible diff.
 */

import { assertLastRenderedView } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 027 audit lock: tapping 🛒 Shopping List during an open planFlow ' +
  'clears planFlow, sets surfaceContext to "shopping", and renders the ' +
  'next_cook view for the active plan — not the abandoned draft.';

interface SessionShape {
  planFlow?: unknown;
  surfaceContext?: string | null;
}

export function assertBehavior(ctx: AssertionsContext): void {
  const session = ctx.finalSession as SessionShape | null | undefined;

  // planFlow cleared.
  if (session?.planFlow !== null && session?.planFlow !== undefined) {
    throw new Error(
      `Expected planFlow=null after shopping-list tap mid-planning; got ${JSON.stringify(session?.planFlow)?.slice(0, 120)}.`,
    );
  }

  // surfaceContext = 'shopping'.
  if (session?.surfaceContext !== 'shopping') {
    throw new Error(
      `Expected surfaceContext='shopping'; got ${String(session?.surfaceContext)}.`,
    );
  }

  assertLastRenderedView(ctx, { surface: 'shopping', view: 'next_cook' });
}
