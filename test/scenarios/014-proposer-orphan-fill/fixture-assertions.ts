import type { RecordedScenario } from '../../../src/harness/types.js';

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

interface ProposerFlexSlot {
  day?: string;
  meal_time?: string;
}

interface ProposerGeneratedRecipe {
  days?: unknown;
  meal_type?: string;
}

interface ProposerResponse {
  batches?: unknown;
  flex_slots?: unknown;
  recipes_to_generate?: unknown;
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

function assertBatchUnderfill(
  batches: unknown[],
  recipeSlug: string,
  mealType: 'lunch' | 'dinner',
  missingDay: string,
  servings: number,
): void {
  const batch = findBatch(batches, recipeSlug, mealType);
  if (!batch) {
    fail(`Missing ${mealType} batch for ${recipeSlug}.`);
  }

  const days = batchDays(batch);
  if (days.includes(missingDay) || batch.servings !== servings) {
    fail(
      `${recipeSlug} ${mealType} must omit ${missingDay} and have servings=${servings}; ` +
        `got days=${JSON.stringify(days)} servings=${String(batch.servings)}.`,
    );
  }
}

function assertSlotNotReassigned(
  response: ProposerResponse,
  day: string,
  mealType: 'lunch' | 'dinner',
): void {
  const flexSlots = asArray(response.flex_slots) as ProposerFlexSlot[];
  const flexHit = flexSlots.some((slot) => slot.day === day && slot.meal_time === mealType);
  if (flexHit) {
    fail(`${day} ${mealType} must not be present in flex_slots.`);
  }

  const generatedRecipes = asArray(response.recipes_to_generate) as ProposerGeneratedRecipe[];
  const generatedHit = generatedRecipes.some((gap) => {
    const days = Array.isArray(gap.days) ? gap.days : [];
    return gap.meal_type === mealType && days.includes(day);
  });
  if (generatedHit) {
    fail(`${day} ${mealType} must not be present in recipes_to_generate.`);
  }
}

export function assertFixtureEdits(recorded: RecordedScenario): void {
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
  assertBatchUnderfill(
    batches,
    'chicken-black-bean-avocado-rice-bowl',
    'lunch',
    '2026-04-08',
    2,
  );
  assertBatchUnderfill(
    batches,
    'creamy-salmon-and-shrimp-linguine',
    'dinner',
    '2026-04-07',
    1,
  );

  assertSlotNotReassigned(response, '2026-04-08', 'lunch');
  assertSlotNotReassigned(response, '2026-04-07', 'dinner');
}
