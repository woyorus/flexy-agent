/**
 * Plan-proposer sub-agent.
 *
 * The intelligence layer for weekly meal planning. Takes the user's recipe database,
 * recent plan history, and this week's constraints, and proposes a complete plan:
 * which recipes go where, which flex meals to suggest, and whether new recipes
 * need to be generated for variety.
 *
 * The proposer does NOT do calorie math — it assigns recipes to slots based on
 * variety, nutrition, and user preferences. The solver handles the math.
 *
 * Key design principles:
 * - No recipe repeats from the last 2 weeks
 * - Rotate protein sources (chicken → fish → beef → veggie)
 * - Rotate cuisines across weeks
 * - Ensure micronutrient diversity through food group variety (LLM heuristic)
 * - Propose exactly config.planning.flexSlotsPerWeek flex slots (currently 1)
 * - Identify recipe gaps when the DB lacks variety for a good plan
 * - Keep suggestions simple — home cook meals, not restaurant complexity
 *
 * Uses mini model with high reasoning — analytical decision-making, not creative writing.
 */

import type { LLMProvider } from '../ai/provider.js';
import type { Recipe, MealEvent, Macros, FlexSlot, PlanSession, Batch } from '../models/types.js';
import type { PlanProposal, ProposedBatch, RecipeGap, PreCommittedSlot } from '../solver/types.js';
import { config } from '../config.js';
import { log } from '../debug/logger.js';
import { restoreMealSlot, computeUnexplainedOrphans } from './plan-utils.js';

// ─── Input/Output types ────────────────────────────────────────────────────────

/**
 * Compact recipe summary for the proposer's context.
 * Keeps the LLM context small — slug, name, cuisine, protein source, macros.
 */
export interface RecipeSummary {
  slug: string;
  name: string;
  mealTypes: Array<'breakfast' | 'lunch' | 'dinner'>;
  cuisine: string;
  tags: string[];
  calories: number;
  protein: number;
  /** Primary protein source derived from tags/name/ingredients */
  proteinSource: string;
}

/**
 * Summary of a recent plan for the variety engine.
 * Tells the proposer what was used recently so it can avoid repeats.
 */
export interface RecentPlanSummary {
  weekStart: string;
  recipeSlugs: string[];
  cuisines: string[];
  proteinSources: string[];
}

export interface PlanProposerInput {
  /** Legacy — use horizonStart in new code. */
  weekStart: string;
  /** Legacy — use horizonDays in new code. */
  weekDays: string[];
  breakfast: {
    recipeSlug: string;
    name: string;
    caloriesPerDay: number;
    proteinPerDay: number;
  };
  events: MealEvent[];
  availableRecipes: RecipeSummary[];
  recentPlans: RecentPlanSummary[];
  weeklyTargets: Macros;

  // ─── Plan 007: rolling-horizon fields (optional during strangler-fig) ───

  /** ISO date — first day of the horizon. Falls back to weekStart if absent. */
  horizonStart?: string;
  /** 7 ISO dates. Falls back to weekDays if absent. */
  horizonDays?: string[];
  /** Pre-committed meal slots carried over from prior plan sessions. */
  preCommittedSlots?: PreCommittedSlot[];
}

export interface PlanProposerOutput {
  proposal: PlanProposal;
  /** LLM's explanation of its choices — logged for debugging, not shown to user */
  reasoning: string;
}

// ─── Main function ──────────────────────────────────────────────────────────────

/**
 * Generate a plan proposal using the LLM.
 *
 * @param input - Week context, available recipes, recent history
 * @param llm - LLM provider (uses mini model with high reasoning)
 * @returns Plan proposal with recipe assignments, flex slots, and recipe gaps
 */
export async function proposePlan(
  input: PlanProposerInput,
  llm: LLMProvider,
): Promise<PlanProposerOutput> {
  const systemPrompt = buildSystemPrompt(input);
  const userPrompt = buildUserPrompt(input);

  log.debug('PLAN', `proposing plan for week starting ${input.weekStart}, ${input.availableRecipes.length} recipes available`);

  const result = await llm.complete({
    model: 'mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    json: true,
    reasoning: 'high',
    context: 'plan-proposal',
  });

  let parsed = JSON.parse(result.content);
  let proposal = mapToProposal(parsed);

  log.debug('PLAN', `proposal: ${proposal.batches.length} batches, ${proposal.flexSlots.length} flex slots, ${proposal.recipesToGenerate.length} gaps`);

  // Hard-enforce the flex slot constraint. The LLM is told exactly once in the
  // prompt; if it still returns the wrong count, retry once with a correction
  // message (preserves conversation context). Truncating silently would create
  // orphan slots, which would confuse the user.
  const expectedFlex = config.planning.flexSlotsPerWeek;
  if (proposal.flexSlots.length !== expectedFlex) {
    log.warn('PLAN', `proposer returned ${proposal.flexSlots.length} flex slots, expected ${expectedFlex}. Retrying with correction.`);

    const retryResult = await llm.complete({
      model: 'mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: result.content },
        {
          role: 'user',
          content: `You returned ${proposal.flexSlots.length} flex slots, but the hard constraint is EXACTLY ${expectedFlex}. Rebuild the proposal: cover every non-event, non-flex slot with a batch (prefer 3-serving over 2-serving), and propose exactly ${expectedFlex} flex slot(s). Return the complete corrected JSON.`,
        },
      ],
      json: true,
      reasoning: 'high',
      context: 'plan-proposal-retry',
    });

    parsed = JSON.parse(retryResult.content);
    proposal = mapToProposal(parsed);
    log.debug('PLAN', `retry proposal: ${proposal.batches.length} batches, ${proposal.flexSlots.length} flex slots, ${proposal.recipesToGenerate.length} gaps`);

    if (proposal.flexSlots.length !== expectedFlex) {
      log.error('PLAN', `retry also returned wrong flex count (${proposal.flexSlots.length}). QA validator will surface orphan slots.`);
    }
  }

  // Deterministic orphan fill (Plan 011): cover any slots the LLM missed.
  fillOrphanSlots(proposal, input);

  return {
    proposal,
    reasoning: parsed.reasoning ?? '',
  };
}

// ─── Context builders ───────────────────────────────────────────────────────────

function buildSystemPrompt(input: PlanProposerInput): string {
  const hasPreCommitted = (input.preCommittedSlots ?? []).length > 0;
  // Use the rolling-horizon prompt only when there are pre-committed slots
  // or other rolling-specific content. During the strangler-fig, fresh plans
  // (no carry-over) still use the legacy prompt so existing scenario fixtures
  // match. Phase 7b re-records all scenarios and switches everything to rolling.
  const isRolling = hasPreCommitted;

  if (!isRolling) {
    return buildLegacySystemPrompt();
  }

  return `You are a meal planning assistant that creates 7-day meal plans optimized for nutritional variety, adherence, and simplicity.

## YOUR JOB

Given a recipe database, recent meal history, and this horizon's constraints, propose a complete 7-day meal plan. Assign recipes to lunch and dinner slots, suggest flex meals, and identify gaps where new recipes should be generated.

## HORIZON STRUCTURE

- 7-day planning horizon, 3 meals each day: breakfast (fixed), lunch, dinner
- Lunch and dinner are meal-prepped in batches of 2-3 servings (consecutive days)
- Some slots may be taken by restaurant events (provided in the constraints)${hasPreCommitted ? '\n- Some slots are pre-committed from a prior plan session (provided below) — do NOT plan new batches for those slots' : ''}
- Exactly ${config.planning.flexSlotsPerWeek} slot(s) per horizon is a "flex meal" — the user eats something fun instead of meal prep
- The cook day for each batch is always the first day of its eating days (eating_days[0]). Do NOT propose separate cook days.

## FLEX SLOTS (HARD CONSTRAINT)

- Propose EXACTLY ${config.planning.flexSlotsPerWeek} flex meal slot(s) per week — not 0, not 2+
- Each additional flex slot beyond this shrinks every meal prep slot by ~25 cal, which hurts meal satisfaction
- Preferred day: Friday or Saturday dinner (social/weekend context)
- Flex bonus: 300-400 extra calories on top of normal meal budget
- A flex slot replaces one meal-prep slot — don't assign a recipe batch to that slot

## BATCH SIZING STRATEGY

You must cover this many meal prep slots with batches:
  meal_prep_slots = 14 - (event slots) - ${config.planning.flexSlotsPerWeek} (flex)

Preference order for filling those slots:
1. **Prefer 3-serving batches** over 2-serving. A 3-serving batch covers 3 days from one cooking session — fewer cook days, less fridge churn, easier adherence.
2. **Mix 2 and 3 serving batches** to hit the exact slot count. Example: with 13 slots and 6 recipes, use five 2-serving batches + one 3-serving batch.
3. **Generate new recipes** ONLY if existing recipes cannot cover all slots even with 3-serving batches (i.e., recipe_count × 3 < slots_needed). This is a last resort.

Rules:
- A recipe can only appear in ONE batch per week
- Each batch covers consecutive days for the same meal type (e.g., lunch Mon-Wed)
- Don't leave slots uncovered — every non-event, non-flex slot must have a batch

## VARIETY RULES (CRITICAL)

1. **No repeats**: Do NOT use any recipe that appears in the recent plan history
2. **Protein source rotation**: If recent weeks used chicken + fish + beef, prefer pork, legumes, or different preparations this week. Aim for at least 2-3 different protein sources across the week.
3. **Cuisine rotation**: If recent weeks were Mediterranean + Italian, prefer Asian, Latin American, or other profiles this week
4. **Within-week variety**: Don't use the same protein source for both lunch and dinner on the same day block. If lunch Mon-Wed is chicken, dinner Mon-Wed should be fish or beef, not chicken.
5. **Pre-committed slot recipes count as used**: Recipes appearing in PRE-COMMITTED SLOTS count as already-used for THIS horizon. Do NOT propose a new batch using a recipe that already appears in a pre-committed slot — the user would see the same meal on two non-adjacent days.${hasPreCommitted ? `

## PRE-COMMITTED SLOTS

Some meal slots in this horizon are already covered by batches from a prior plan session. These are FIXED — you cannot move, replace, or plan on top of them. Plan new batches only for uncovered slots.

Pre-committed slots will be listed in the user message below. Treat them as taken (like events) when counting available slots.` : ''}

## CROSS-HORIZON BATCHES

A 2- or 3-serving batch started on day 6 or 7 of the horizon can have eating days that extend into days 8 or 9 (belonging to the next plan session). This is preferred over creating a 1-day orphan at the horizon edge. When a batch extends past the horizon end:
- Use \`eating_days\` to list ALL days (including overflow past the horizon)
- Use \`overflow_days\` to list the subset of days that fall past the horizon end
- The solver only sees in-horizon days; overflow days become pre-committed slots in the next session

## USER FOOD PROFILE
The user lives in ${config.foodProfile.region}. Shopping: ${config.foodProfile.storeAccess}
${config.foodProfile.ingredientNotes}
When suggesting new recipes to generate, respect this profile — suggest cuisines and ingredients natural to the user's region and store access.

## RECIPE GAPS

If the recipe database doesn't have enough variety to fill the week without repeating recent meals:
- Identify which slots can't be filled
- Suggest what KIND of recipe to generate (cuisine, protein source, style)
- Base suggestions on what's MISSING — if the DB is heavy on Mediterranean chicken, suggest Asian fish or Latin American pork
- Keep suggestions practical — simple home cooking, not restaurant complexity

## MICRONUTRIENT AWARENESS

Ensure the week's recipes together cover diverse food groups:
- At least one fish meal for omega-3 (if available in DB)
- Varied vegetables across recipes (not all peppers and tomatoes)
- Mix of food preparation methods
- If the DB is thin on vegetable variety, mention it in your reasoning

## OUTPUT FORMAT

Respond with ONLY valid JSON:
{
  "batches": [
    {
      "recipe_slug": "string — from the available recipes list",
      "recipe_name": "string",
      "meal_type": "lunch" | "dinner",
      "eating_days": ["ISO date strings — ALL consecutive days this batch covers, including overflow"],
      "overflow_days": ["ISO dates past horizon end, if any — empty array or omit if none"],
      "servings": number
    }
  ],
  "flex_slots": [
    {
      "day": "ISO date string",
      "meal_time": "lunch" | "dinner",
      "flex_bonus": number (300-400),
      "note": "string — e.g., 'fun dinner night'"
    }
  ],
  "recipes_to_generate": [
    {
      "meal_type": "lunch" | "dinner",
      "days": ["ISO date strings"],
      "servings": number,
      "suggestion": "string — what kind of recipe to generate",
      "reason": "string — why this gap exists"
    }
  ],
  "reasoning": "string — brief explanation of your choices (protein rotation, cuisine variety, etc.)"
}`;
}

/**
 * Legacy system prompt — exact copy of the pre-Plan-007 prompt text.
 * Used when horizonDays is absent so existing scenario fixtures still match.
 * Will be deleted in Phase 7b when all scenarios are re-recorded.
 */
function buildLegacySystemPrompt(): string {
  return `You are a meal planning assistant that creates weekly meal plans optimized for nutritional variety, adherence, and simplicity.

## YOUR JOB

Given a recipe database, recent meal history, and this week's constraints, propose a complete weekly meal plan. Assign recipes to lunch and dinner slots, suggest flex meals, and identify gaps where new recipes should be generated.

## WEEK STRUCTURE

- 7 days, 3 meals each: breakfast (fixed), lunch, dinner
- Lunch and dinner are meal-prepped in batches of 2-3 servings (consecutive days)
- Some slots may be taken by restaurant events (provided in the constraints)
- Exactly ${config.planning.flexSlotsPerWeek} slot(s) per week is a "flex meal" — the user eats something fun instead of meal prep

## FLEX SLOTS (HARD CONSTRAINT)

- Propose EXACTLY ${config.planning.flexSlotsPerWeek} flex meal slot(s) per week — not 0, not 2+
- Each additional flex slot beyond this shrinks every meal prep slot by ~25 cal, which hurts meal satisfaction
- Preferred day: Friday or Saturday dinner (social/weekend context)
- Flex bonus: 300-400 extra calories on top of normal meal budget
- A flex slot replaces one meal-prep slot — don't assign a recipe batch to that slot

## BATCH SIZING STRATEGY

You must cover this many meal prep slots with batches:
  meal_prep_slots = 14 - (event slots) - ${config.planning.flexSlotsPerWeek} (flex)

Preference order for filling those slots:
1. **Prefer 3-serving batches** over 2-serving. A 3-serving batch covers 3 days from one cooking session — fewer cook days, less fridge churn, easier adherence.
2. **Mix 2 and 3 serving batches** to hit the exact slot count. Example: with 13 slots and 6 recipes, use five 2-serving batches + one 3-serving batch.
3. **Generate new recipes** ONLY if existing recipes cannot cover all slots even with 3-serving batches (i.e., recipe_count × 3 < slots_needed). This is a last resort.

Rules:
- A recipe can only appear in ONE batch per week
- Each batch covers consecutive days for the same meal type (e.g., lunch Mon-Wed)
- Don't leave slots uncovered — every non-event, non-flex slot must have a batch

## VARIETY RULES (CRITICAL)

1. **No repeats**: Do NOT use any recipe that appears in the recent plan history
2. **Protein source rotation**: If recent weeks used chicken + fish + beef, prefer pork, legumes, or different preparations this week. Aim for at least 2-3 different protein sources across the week.
3. **Cuisine rotation**: If recent weeks were Mediterranean + Italian, prefer Asian, Latin American, or other profiles this week
4. **Within-week variety**: Don't use the same protein source for both lunch and dinner on the same day block. If lunch Mon-Wed is chicken, dinner Mon-Wed should be fish or beef, not chicken.

## USER FOOD PROFILE
The user lives in ${config.foodProfile.region}. Shopping: ${config.foodProfile.storeAccess}
${config.foodProfile.ingredientNotes}
When suggesting new recipes to generate, respect this profile — suggest cuisines and ingredients natural to the user's region and store access.

## RECIPE GAPS

If the recipe database doesn't have enough variety to fill the week without repeating recent meals:
- Identify which slots can't be filled
- Suggest what KIND of recipe to generate (cuisine, protein source, style)
- Base suggestions on what's MISSING — if the DB is heavy on Mediterranean chicken, suggest Asian fish or Latin American pork
- Keep suggestions practical — simple home cooking, not restaurant complexity

## MICRONUTRIENT AWARENESS

Ensure the week's recipes together cover diverse food groups:
- At least one fish meal for omega-3 (if available in DB)
- Varied vegetables across recipes (not all peppers and tomatoes)
- Mix of food preparation methods
- If the DB is thin on vegetable variety, mention it in your reasoning

## OUTPUT FORMAT

Respond with ONLY valid JSON:
{
  "batches": [
    {
      "recipe_slug": "string — from the available recipes list",
      "recipe_name": "string",
      "meal_type": "lunch" | "dinner",
      "days": ["ISO date strings — consecutive days this batch covers"],
      "servings": number
    }
  ],
  "flex_slots": [
    {
      "day": "ISO date string",
      "meal_time": "lunch" | "dinner",
      "flex_bonus": number (300-400),
      "note": "string — e.g., 'fun dinner night'"
    }
  ],
  "recipes_to_generate": [
    {
      "meal_type": "lunch" | "dinner",
      "days": ["ISO date strings"],
      "servings": number,
      "suggestion": "string — what kind of recipe to generate",
      "reason": "string — why this gap exists"
    }
  ],
  "reasoning": "string — brief explanation of your choices (protein rotation, cuisine variety, etc.)"
}`;
}

function buildUserPrompt(input: PlanProposerInput): string {
  const parts: string[] = [];
  const isRolling = (input.preCommittedSlots ?? []).length > 0;
  const effectiveDays = input.horizonDays ?? input.weekDays;
  const effectiveStart = input.horizonStart ?? input.weekStart;
  const preCommitted = input.preCommittedSlots ?? [];

  // Horizon/Week info
  const dayNames = effectiveDays.map((d) => {
    const date = new Date(d + 'T00:00:00');
    return `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${d}`;
  });
  if (isRolling) {
    parts.push(`## THIS HORIZON: ${effectiveStart} to ${effectiveDays[effectiveDays.length - 1]}`);
  } else {
    parts.push(`## THIS WEEK: ${effectiveStart} to ${effectiveDays[effectiveDays.length - 1]}`);
  }
  parts.push(`Days: ${dayNames.join(', ')}`);
  parts.push('');

  // Events
  if (input.events.length > 0) {
    parts.push('## EVENTS (these slots are taken — do NOT assign recipes to them)');
    for (const e of input.events) {
      parts.push(`- ${e.day} ${e.mealTime}: ${e.name} (~${e.estimatedCalories} cal)${e.notes ? ` — ${e.notes}` : ''}`);
    }
    parts.push('');
  } else {
    parts.push('## EVENTS: None this week');
    parts.push('');
  }

  // Available recipes
  parts.push('## AVAILABLE RECIPES');
  if (input.availableRecipes.length === 0) {
    parts.push('No recipes in database — all slots will need new recipes generated.');
  } else {
    for (const r of input.availableRecipes) {
      parts.push(`- ${r.slug}: "${r.name}" | ${r.mealTypes.join('/')} | ${r.cuisine} | ${r.proteinSource} | ${r.calories} cal, ${r.protein}g P | tags: ${r.tags.join(', ')}`);
    }
  }
  parts.push('');

  // Recent plan history
  if (input.recentPlans.length > 0) {
    parts.push('## RECENT PLANS (avoid repeating these recipes)');
    for (const plan of input.recentPlans) {
      parts.push(`Week of ${plan.weekStart}:`);
      parts.push(`  Recipes used: ${plan.recipeSlugs.join(', ') || 'none'}`);
      parts.push(`  Cuisines: ${plan.cuisines.join(', ') || 'unknown'}`);
      parts.push(`  Protein sources: ${plan.proteinSources.join(', ') || 'unknown'}`);
    }
    parts.push('');
  } else {
    parts.push('## RECENT PLANS: None (first week — no repeat constraints)');
    parts.push('');
  }

  // Pre-committed slots from prior plan sessions
  if (preCommitted.length > 0) {
    parts.push('## PRE-COMMITTED SLOTS (from prior plan — FIXED, do NOT plan on these)');
    for (const s of preCommitted) {
      parts.push(`- ${s.day} ${s.mealTime}: ${s.recipeSlug} (${s.calories} cal, ${s.protein}g P)`);
    }
    parts.push('');
  }

  // Slot math — explicit arithmetic so the proposer knows exactly what to cover
  const totalSlots = 14; // 7 lunches + 7 dinners
  const eventSlots = input.events.length;
  const preCommittedCount = preCommitted.length;
  const flexSlots = config.planning.flexSlotsPerWeek;
  const mealPrepSlotsNeeded = totalSlots - eventSlots - preCommittedCount - flexSlots;
  const maxCoverageWith3Serving = input.availableRecipes.length * 3;
  parts.push('## SLOT MATH (do this arithmetic carefully)');
  parts.push(`- Total non-breakfast slots: ${totalSlots} (7 lunches + 7 dinners)`);
  parts.push(`- Event slots taken: ${eventSlots}`);
  if (preCommittedCount > 0) {
    parts.push(`- Pre-committed slots (from prior plan): ${preCommittedCount}`);
  }
  parts.push(`- Flex slots to propose (required): ${flexSlots}`);
  if (preCommittedCount > 0) {
    parts.push(`- Meal prep slots to cover with NEW batches: ${totalSlots} - ${eventSlots} - ${preCommittedCount} - ${flexSlots} = ${mealPrepSlotsNeeded}`);
  } else {
    parts.push(`- Meal prep slots to cover with batches: ${mealPrepSlotsNeeded}`);
  }
  parts.push(`- Available recipes: ${input.availableRecipes.length}`);
  parts.push(`- Max coverage if all batches are 3-serving: ${maxCoverageWith3Serving}`);
  if (maxCoverageWith3Serving >= mealPrepSlotsNeeded) {
    parts.push(`- ✓ Existing recipes CAN cover all slots — mix 2 and 3 serving batches to hit exactly ${mealPrepSlotsNeeded}. Do NOT generate new recipes.`);
  } else {
    parts.push(`- ✗ Existing recipes cannot cover all slots even with 3-serving batches — you MUST generate ${Math.ceil((mealPrepSlotsNeeded - maxCoverageWith3Serving) / 3)} new recipe(s).`);
  }
  parts.push('');

  const label = isRolling ? 'horizon' : 'week';
  parts.push(`Create the best plan for this ${label}. Use existing recipes with a mix of 2 and 3 serving batches to cover exactly ${mealPrepSlotsNeeded} meal prep slots + ${flexSlots} flex slot(s). Prefer 3-serving batches where possible.`);

  return parts.join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build compact recipe summaries from full Recipe objects.
 * Extracts the primary protein source from tags, name, and ingredients.
 */
export function buildRecipeSummaries(recipes: Recipe[]): RecipeSummary[] {
  return recipes
    .filter((r) => r.mealTypes.includes('lunch') || r.mealTypes.includes('dinner'))
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      mealTypes: r.mealTypes,
      cuisine: r.cuisine,
      tags: r.tags,
      calories: r.perServing.calories,
      protein: r.perServing.protein,
      proteinSource: extractProteinSource(r),
    }));
}

/**
 * Extract the primary protein source from a recipe.
 * Checks tags first, then ingredient names with protein role, then the recipe name.
 */
function extractProteinSource(recipe: Recipe): string {
  // Check tags for common protein sources
  const proteinTags = ['chicken', 'beef', 'pork', 'fish', 'salmon', 'tuna', 'shrimp', 'turkey', 'lamb', 'tofu', 'legumes', 'lentils', 'chickpea', 'egg'];
  for (const tag of recipe.tags) {
    const lower = tag.toLowerCase();
    for (const pt of proteinTags) {
      if (lower.includes(pt)) return pt;
    }
  }

  // Check protein-role ingredients
  const proteinIngredients = recipe.ingredients.filter((i) => i.role === 'protein');
  if (proteinIngredients.length > 0) {
    const name = proteinIngredients[0]!.name.toLowerCase();
    for (const pt of proteinTags) {
      if (name.includes(pt)) return pt;
    }
    // Return the first protein ingredient name as fallback
    return proteinIngredients[0]!.name.toLowerCase().split(' ')[0]!;
  }

  // Check recipe name
  const nameLower = recipe.name.toLowerCase();
  for (const pt of proteinTags) {
    if (nameLower.includes(pt)) return pt;
  }

  return 'unknown';
}



/**
 * Build recent plan summaries from PlanSession[] + batches (Plan 007 rolling path).
 *
 * PlanSession doesn't embed batches, so the caller provides pre-loaded batches
 * per session (an N-queries pattern — acceptable at current scale of limit=2).
 */
export function buildRecentPlanSummariesFromSessions(
  sessions: PlanSession[],
  batchesBySession: Map<string, Batch[]>,
  recipeDb: { getBySlug: (slug: string) => Recipe | undefined },
): RecentPlanSummary[] {
  return sessions.map((session) => {
    const batches = batchesBySession.get(session.id) ?? [];
    const slugs = batches.map((b) => b.recipeSlug).filter(Boolean);

    const cuisines = new Set<string>();
    const proteinSources = new Set<string>();

    for (const slug of slugs) {
      const recipe = recipeDb.getBySlug(slug);
      if (recipe) {
        cuisines.add(recipe.cuisine.toLowerCase());
        proteinSources.add(extractProteinSource(recipe));
      }
    }

    return {
      weekStart: session.horizonStart,
      recipeSlugs: slugs,
      cuisines: Array.from(cuisines),
      proteinSources: Array.from(proteinSources),
    };
  });
}

/**
 * Generate the 7 ISO date strings for a week starting on the given date.
 */
export function getWeekDays(weekStart: string): string[] {
  const days: string[] = [];
  const start = new Date(weekStart + 'T00:00:00');
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(toLocalISODate(d));
  }
  return days;
}

/**
 * Re-export from canonical location (`src/plan/helpers.ts`).
 * Kept here for backward compatibility — existing imports from plan-flow.ts
 * and plan-utils.ts continue to work without churn.
 *
 * Also used internally by `getWeekDays()` above, so the import is load-bearing.
 */
import { toLocalISODate } from '../plan/helpers.js';
export { toLocalISODate };

/**
 * Map the raw LLM JSON response to a typed PlanProposal.
 *
 * Plan 007: the LLM emits `eating_days` (full day list) and `overflow_days`
 * (days past horizon end). We map into ProposedBatch.days (in-horizon, for the
 * solver) and ProposedBatch.overflowDays. Falls back to the legacy `days` field
 * if `eating_days` is absent (backward compat with old recordings).
 */
function mapToProposal(raw: Record<string, unknown>): PlanProposal {
  const batches = (raw.batches as Array<Record<string, unknown>>).map((b) => {
    const eatingDays = (b.eating_days ?? b.days) as string[];
    const overflowDays = (b.overflow_days ?? []) as string[];
    // In-horizon days = eatingDays minus overflowDays
    const overflowSet = new Set(overflowDays);
    const inHorizonDays = eatingDays.filter((d) => !overflowSet.has(d));

    return {
      recipeSlug: b.recipe_slug as string,
      recipeName: b.recipe_name as string,
      mealType: b.meal_type as 'lunch' | 'dinner',
      days: inHorizonDays,
      servings: (b.servings as number),
      overflowDays: overflowDays.length > 0 ? overflowDays : undefined,
    };
  }) satisfies ProposedBatch[];

  const flexSlots = ((raw.flex_slots ?? []) as Array<Record<string, unknown>>).map((f) => ({
    day: f.day as string,
    mealTime: f.meal_time as 'lunch' | 'dinner',
    flexBonus: f.flex_bonus as number,
    note: (f.note as string) ?? undefined,
  })) satisfies FlexSlot[];

  const recipesToGenerate = ((raw.recipes_to_generate ?? []) as Array<Record<string, unknown>>).map((g) => ({
    mealType: g.meal_type as 'lunch' | 'dinner',
    days: g.days as string[],
    servings: g.servings as number,
    suggestion: g.suggestion as string,
    reason: g.reason as string,
  })) satisfies RecipeGap[];

  return { batches, flexSlots, recipesToGenerate };
}

// ─── Orphan fill (Plan 011) ───────────────────────────────────────────────────

/**
 * Deterministic post-processing: fill any meal slots the LLM forgot to cover.
 *
 * Computes the set of (day, mealType) pairs not covered by batches, flex slots,
 * events, pre-committed slots, or pending recipe gaps. For each orphan:
 * 1. Try restoreMealSlot — extends an adjacent batch if one exists with < 3 servings.
 * 2. If that fails, emit a RecipeGap — routes through the gap-resolution flow.
 *
 * Mutates `proposal` in place (same pattern as the flex-count retry above).
 */
function fillOrphanSlots(
  proposal: PlanProposal,
  input: PlanProposerInput,
): void {
  const horizonDays = input.horizonDays ?? input.weekDays;
  const orphans = computeUnexplainedOrphans(
    proposal,
    horizonDays,
    input.events,
    input.preCommittedSlots ?? [],
  );

  if (orphans.length === 0) return;

  for (const { day, mealType } of orphans) {
    const absorbed = restoreMealSlot(proposal, day, mealType);
    if (absorbed) {
      log.warn('PLAN', `orphan fill: ${day} ${mealType} → extended adjacent batch`);
    } else {
      // No adjacent batch can absorb — emit a RecipeGap for the gap-resolution flow.
      const gap: RecipeGap = {
        mealType,
        days: [day],
        servings: 1,
        suggestion: `Fill uncovered ${mealType} slot.`,
        reason: `Proposer left ${day} ${mealType} uncovered — no adjacent batch available to extend.`,
      };
      proposal.recipesToGenerate.push(gap);
      log.warn('PLAN', `orphan fill: ${day} ${mealType} → recipe gap`);
    }
  }

  log.debug('PLAN', `orphan fill complete: ${orphans.length} orphan(s) processed`);
}
