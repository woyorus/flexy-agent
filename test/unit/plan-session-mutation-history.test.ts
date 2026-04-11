/**
 * Unit test for Plan 026: PlanSession.mutationHistory round-trips through
 * TestStateStore. Verifies both the default-empty path (draft omits the field)
 * and the explicit-history path (draft sets the field and the replace-flow
 * carries it unchanged).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestStateStore } from '../../src/harness/test-store.js';
import type { DraftPlanSession, MutationRecord } from '../../src/models/types.js';

function draft(id: string, history?: MutationRecord[]): DraftPlanSession {
  return {
    id,
    horizonStart: '2026-04-06',
    horizonEnd: '2026-04-12',
    breakfast: { locked: true, recipeSlug: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
    treatBudgetCalories: 800,
    flexSlots: [],
    events: [],
    ...(history !== undefined ? { mutationHistory: history } : {}),
  };
}

test('confirmPlanSession defaults mutationHistory to [] when draft omits it', async () => {
  const store = new TestStateStore();
  const persisted = await store.confirmPlanSession(draft('session-1'), []);
  assert.deepStrictEqual(persisted.mutationHistory, []);

  const reloaded = await store.getPlanSession('session-1');
  assert.ok(reloaded);
  assert.deepStrictEqual(reloaded.mutationHistory, []);
});

test('confirmPlanSession persists mutationHistory when draft sets it', async () => {
  const store = new TestStateStore();
  const history: MutationRecord[] = [
    { constraint: 'move flex to Sunday', appliedAt: '2026-04-05T10:00:00.000Z' },
    { constraint: 'swap tagine for fish', appliedAt: '2026-04-05T10:05:00.000Z' },
  ];
  const persisted = await store.confirmPlanSession(draft('session-2', history), []);
  assert.deepStrictEqual(persisted.mutationHistory, history);
});

test('confirmPlanSessionReplacing carries mutationHistory from the new draft', async () => {
  const store = new TestStateStore();
  await store.confirmPlanSession(draft('old', [{ constraint: 'initial', appliedAt: '2026-04-05T09:00:00.000Z' }]), []);

  const newHistory: MutationRecord[] = [
    { constraint: 'initial', appliedAt: '2026-04-05T09:00:00.000Z' },
    { constraint: 'eating out tonight', appliedAt: '2026-04-07T19:00:00.000Z' },
  ];
  const persisted = await store.confirmPlanSessionReplacing(
    draft('new', newHistory),
    [],
    'old',
  );
  assert.deepStrictEqual(persisted.mutationHistory, newHistory);

  const oldReloaded = await store.getPlanSession('old');
  assert.ok(oldReloaded);
  assert.equal(oldReloaded.superseded, true);

  const newReloaded = await store.getPlanSession('new');
  assert.ok(newReloaded);
  assert.deepStrictEqual(newReloaded.mutationHistory, newHistory);
});
