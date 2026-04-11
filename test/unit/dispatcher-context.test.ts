/**
 * Unit tests for buildDispatcherContext — Plan 028.
 *
 * Feeds hand-constructed session/store/recipes slices into the context
 * builder and asserts the resulting DispatcherContext has the correct
 * lifecycle, active-flow summary, plan summary, recipe index, and
 * allowed-actions set.
 *
 * Task 7 creates the file with a single placeholder test. Task 8 fills in
 * the real assertions once `buildDispatcherContext` is exported.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

test('placeholder: dispatcher-context tests land in Task 8', () => {
  assert.ok(true);
});
