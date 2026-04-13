/**
 * Scenario-local assertions for scenario 014 — proposer validator retry.
 *
 * Plan 024: reworked from orphan-fill to validator-retry.
 * Plan 031: renamed from `fixture-assertions.ts` to `assertions.ts` and
 *           extended with `purpose` + `assertBehavior` alongside the
 *           existing `assertFixtureEdits` fixture-edit guardrail. This
 *           scenario is the reference example for audit cycle one — the
 *           first scenario with a load-bearing `purpose` string and a
 *           composed behavioral check over `assertPlanningHealthy` + the
 *           `execTrace` retry + persist signals.
 *
 * `assertFixtureEdits` verifies that fixture 1 (proposer response) has
 * been edited to create an uncovered slot, and that fixture 2 (retry
 * response) exists with a valid complete plan.
 */

import { assertPlanningHealthy } from '../../../src/harness/domain-helpers.js';
import type {
  AssertionsContext,
  RecordedScenario,
} from '../../../src/harness/index.js';

// ─── Plan 031 behavioral contract ─────────────────────────────────────────────

export const purpose =
  'When the proposer underfills the week, the validator catches it and the ' +
  'proposer retries; the retry response covers every slot and the resulting ' +
  'plan is persisted via confirmPlanSession.';

/**
 * Assert the load-bearing behavioral claim named in `purpose`.
 *
 * Three checks:
 *   1. The resulting plan is healthy (composed domain primitives).
 *   2. `execTrace.validatorRetries` shows at least one `plan-proposer`
 *      entry — proof the retry loop fired, not just that the final plan
 *      happened to be valid.
 *   3. `execTrace.persistenceOps` shows a `confirmPlanSession` op — proof
 *      the confirmed plan was actually written to the store (the scenario
 *      is a replacement-less first confirmation, so the op is the unqualified
 *      `confirmPlanSession`, not `confirmPlanSessionReplacing`).
 */
export function assertBehavior(ctx: AssertionsContext): void {
  // 1. Planning health — covers slot coverage, ghost batches, serving
  //    sanity, cook-day derivation, weekly-totals absorption.
  assertPlanningHealthy(ctx);

  // 2. Retry must have actually happened.
  const retries = ctx.execTrace.validatorRetries.filter(
    (r) => r.validator === 'plan-proposer',
  );
  if (retries.length === 0) {
    throw new Error(
      'Expected at least one plan-proposer retry in execTrace.validatorRetries; got none. ' +
        'Did the fixture edits get replaced by a valid regeneration?',
    );
  }

  // 3. Persistence must have happened via the non-replacing path.
  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) {
    throw new Error(
      'Expected a `confirmPlanSession` persistence op in execTrace; got none.',
    );
  }
}

// ─── Fixture-edit guardrail (unchanged from Plan 017) ─────────────────────────

const FIXTURE_EDIT_ERROR = `Scenario 014 fixture edits are missing. Run:
  npm run test:generate -- 014-proposer-orphan-fill --regenerate
Then re-apply fixture-edits.md and run:
  npm run test:replay -- 014-proposer-orphan-fill`;

interface ProposerBatch {
  recipe_slug?: string;
  meal_type?: string;
  days?: unknown;
  eating_days?: unknown;
  servings?: unknown;
}

interface ProposerResponse {
  batches?: unknown;
}

function fail(detail: string): never {
  throw new Error(`${FIXTURE_EDIT_ERROR}\n\nDetails: ${detail}`);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function batchDays(batch: ProposerBatch | undefined): string[] {
  const days = batch?.days ?? batch?.eating_days;
  return Array.isArray(days) ? days.filter((d): d is string => typeof d === 'string') : [];
}

function findBatch(
  batches: unknown[],
  recipeSlug: string,
  mealType: 'lunch' | 'dinner',
): ProposerBatch | undefined {
  return batches.find((batch): batch is ProposerBatch => {
    const candidate = batch as ProposerBatch;
    return candidate.recipe_slug === recipeSlug && candidate.meal_type === mealType;
  });
}

export function assertFixtureEdits(recorded: RecordedScenario): void {
  // --- Fixture 1: edited proposer response with uncovered slot ---
  const proposerFixture = recorded.llmFixtures.find((fixture) => fixture.callIndex === 1);
  if (!proposerFixture) {
    fail('Missing first proposer LLM fixture.');
  }

  let response: ProposerResponse;
  try {
    response = JSON.parse(proposerFixture.response) as ProposerResponse;
  } catch (err) {
    fail(`First proposer fixture response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const batches = asArray(response.batches);

  // Edit 1: chicken lunch batch should only have Mon-Tue (Wed removed)
  const chickenBatch = findBatch(batches, 'chicken-black-bean-avocado-rice-bowl', 'lunch');
  if (!chickenBatch) {
    fail('Missing lunch batch for chicken-black-bean-avocado-rice-bowl.');
  }
  const chickenDays = batchDays(chickenBatch);
  if (chickenDays.includes('2026-04-08') || chickenBatch.servings !== 2) {
    fail(
      `chicken-black-bean-avocado-rice-bowl lunch must omit 2026-04-08 and have servings=2; ` +
      `got days=${JSON.stringify(chickenDays)} servings=${String(chickenBatch.servings)}.`,
    );
  }

  // --- Fixture 2: retry response should be a valid complete plan ---
  const retryFixture = recorded.llmFixtures.find((fixture) => fixture.callIndex === 2);
  if (!retryFixture) {
    fail('Missing retry proposer LLM fixture (callIndex 2). The validator retry fixture is required.');
  }

  // Verify the retry messages include the correction
  const lastUserMessage = retryFixture.messages?.[retryFixture.messages.length - 1];
  if (!lastUserMessage || !lastUserMessage.content.includes('validation errors')) {
    fail('Retry fixture last user message should contain validation error correction.');
  }

  // Verify the retry response is a complete plan (has all slots covered)
  let retryResponse: ProposerResponse;
  try {
    retryResponse = JSON.parse(retryFixture.response) as ProposerResponse;
  } catch (err) {
    fail(`Retry fixture response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const retryBatches = asArray(retryResponse.batches);
  // The retry should have the chicken batch with 3 days (restored)
  const retryChicken = findBatch(retryBatches, 'chicken-black-bean-avocado-rice-bowl', 'lunch');
  if (!retryChicken) {
    fail('Retry response missing lunch batch for chicken-black-bean-avocado-rice-bowl.');
  }
  const retryChickenDays = batchDays(retryChicken);
  if (!retryChickenDays.includes('2026-04-08')) {
    fail(
      `Retry response chicken lunch must include 2026-04-08; got days=${JSON.stringify(retryChickenDays)}.`,
    );
  }
}
