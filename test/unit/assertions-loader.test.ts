/**
 * Unit tests for the scenario-local assertions loader.
 *
 * Plan 031 renamed `fixture-assertions.ts` to `assertions.ts` and extended
 * the contract: a valid module exports `purpose` (string) and
 * `assertBehavior` (function), and MAY additionally export
 * `assertFixtureEdits`. This test suite covers:
 *
 *   - Absence of `assertions.ts` → `runFixtureEditAssertions` silently no-ops.
 *   - A valid module with `assertFixtureEdits` → the fixture-edit guardrail runs.
 *   - Missing `purpose` or `assertBehavior` → loader throws clearly.
 *   - Non-function `assertFixtureEdits` → loader throws clearly.
 *   - The scenario 014 fixture assertion still passes against its recording.
 *   - The scenario 014 fixture assertion still flags a valid regenerated
 *     recording (i.e. the fixture-edit guardrail is preserved byte-for-byte).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadAssertions,
  runFixtureEditAssertions,
} from '../../src/harness/assertions-loader.js';
import type { RecordedScenario } from '../../src/harness/types.js';
import { assertFixtureEdits as assertScenario014FixtureEdits } from '../scenarios/014-proposer-orphan-fill/assertions.js';

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
  return mkdtemp(join(tmpdir(), 'assertions-loader-'));
}

async function writeAssertions(dir: string, body: string): Promise<void> {
  await writeFile(join(dir, 'assertions.ts'), body, 'utf-8');
}

test('loadAssertions returns undefined when no assertions.ts exists', async () => {
  const dir = await makeTempScenarioDir();
  const loaded = await loadAssertions(dir);
  assert.equal(loaded, undefined);
});

test('runFixtureEditAssertions no-ops when no assertions.ts exists', async () => {
  const dir = await makeTempScenarioDir();
  await runFixtureEditAssertions(dir, makeRecorded());
});

test('loadAssertions throws when assertions.ts lacks purpose', async () => {
  const dir = await makeTempScenarioDir();
  await writeAssertions(
    dir,
    `export function assertBehavior() {}\n`,
  );
  await assert.rejects(() => loadAssertions(dir), /must export `purpose: string`/);
});

test('loadAssertions throws when assertions.ts lacks assertBehavior', async () => {
  const dir = await makeTempScenarioDir();
  await writeAssertions(
    dir,
    `export const purpose = 'x';\n`,
  );
  await assert.rejects(() => loadAssertions(dir), /must export `assertBehavior\(ctx\)`/);
});

test('loadAssertions throws when assertFixtureEdits is not a function', async () => {
  const dir = await makeTempScenarioDir();
  await writeAssertions(
    dir,
    `export const purpose = 'x';
     export function assertBehavior() {}
     export const assertFixtureEdits = 'not a function';\n`,
  );
  await assert.rejects(() => loadAssertions(dir), /must be a function/);
});

test('runFixtureEditAssertions runs a passing assertion module', async () => {
  const dir = await makeTempScenarioDir();
  await writeAssertions(
    dir,
    `export const purpose = 'test scenario';
     export function assertBehavior() {}
     export function assertFixtureEdits(recorded) {
       if (recorded.specHash !== 'test-hash') throw new Error('wrong recording');
     }\n`,
  );

  await runFixtureEditAssertions(dir, makeRecorded());
});

test('runFixtureEditAssertions surfaces scenario-specific assertion errors', async () => {
  const dir = await makeTempScenarioDir();
  await writeAssertions(
    dir,
    `export const purpose = 'test';
     export function assertBehavior() {}
     export function assertFixtureEdits() {
       throw new Error('fixture edits are missing');
     }\n`,
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
