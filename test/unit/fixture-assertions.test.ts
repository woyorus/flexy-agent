/**
 * Unit tests for optional scenario-local fixture edit assertions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runFixtureEditAssertions } from '../../src/harness/fixture-assertions.js';
import type { RecordedScenario } from '../../src/harness/types.js';
import { assertFixtureEdits as assertScenario014FixtureEdits } from '../scenarios/014-proposer-orphan-fill/fixture-assertions.js';

function makeRecorded(): RecordedScenario {
  return {
    generatedAt: '2026-04-07T00:00:00.000Z',
    specHash: 'test-hash',
    llmFixtures: [],
    expected: {
      outputs: [],
      finalSession: null,
      finalStore: null,
    },
  };
}

async function makeTempScenarioDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fixture-assertions-'));
}

test('runFixtureEditAssertions returns when no assertion module is present', async () => {
  const dir = await makeTempScenarioDir();
  await runFixtureEditAssertions(dir, makeRecorded());
});

test('runFixtureEditAssertions runs a passing assertion module', async () => {
  const dir = await makeTempScenarioDir();
  await writeFile(
    join(dir, 'fixture-assertions.ts'),
    `export function assertFixtureEdits(recorded) {
      if (recorded.specHash !== 'test-hash') throw new Error('wrong recording');
    }\n`,
    'utf-8',
  );

  await runFixtureEditAssertions(dir, makeRecorded());
});

test('runFixtureEditAssertions surfaces scenario-specific assertion errors', async () => {
  const dir = await makeTempScenarioDir();
  await writeFile(
    join(dir, 'fixture-assertions.ts'),
    `export function assertFixtureEdits() {
      throw new Error('fixture edits are missing');
    }\n`,
    'utf-8',
  );

  await assert.rejects(
    () => runFixtureEditAssertions(dir, makeRecorded()),
    /fixture edits are missing/,
  );
});

test('scenario 014 fixture assertion passes against the edited recording', async () => {
  const recorded = JSON.parse(
    await readFile(new URL('../scenarios/014-proposer-orphan-fill/recorded.json', import.meta.url), 'utf-8'),
  ) as RecordedScenario;

  assert.doesNotThrow(() => assertScenario014FixtureEdits(recorded));
});

test('scenario 014 fixture assertion fails against a valid regenerated proposer response', () => {
  const recorded = makeRecorded();
  recorded.llmFixtures = [
    {
      hash: 'hash',
      callIndex: 1,
      model: 'mini',
      json: true,
      messages: [],
      response: JSON.stringify({
        batches: [
          {
            recipe_slug: 'chicken-black-bean-avocado-rice-bowl',
            meal_type: 'lunch',
            days: ['2026-04-06', '2026-04-07', '2026-04-08'],
            servings: 3,
          },
          {
            recipe_slug: 'creamy-salmon-and-shrimp-linguine',
            meal_type: 'dinner',
            days: ['2026-04-06', '2026-04-07'],
            servings: 2,
          },
        ],
        flex_slots: [],
        recipes_to_generate: [],
      }),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  assert.throws(
    () => assertScenario014FixtureEdits(recorded),
    /Scenario 014 fixture edits are missing/,
  );
});
