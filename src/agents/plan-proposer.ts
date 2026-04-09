/**
 * Plan-proposer sub-agent.
 *
 * The intelligence layer for weekly meal planning. Takes the user's recipe database,
 * recent plan history, and this horizon's constraints, and proposes a COMPLETE plan:
 * which recipes go where, which flex meals to suggest, and events pass-through.
 *
 * Plan 024: the proposer always outputs complete plans — no recipe gaps.
 * Batches need not be consecutive (fridge-life constrained, not calendar-consecutive).
 * validateProposal() gates every proposal before the solver sees it.
 * On validation failure, the proposer retries once with errors fed back to the LLM.
 *
 * Key design principles:
 * - No recipe repeats from the last 2 weeks
 * - Rotate protein sources (chicken → fish → beef → veggie)
 * - Rotate cuisines across weeks
 * - Ensure micronutrient diversity through food group variety (LLM heuristic)
 * - Propose exactly config.planning.flexSlotsPerWeek flex slots (currently 1)
 * - Prefer unique recipes; reuse when DB is too small for full coverage
 * - Keep suggestions simple — home cook meals, not restaurant complexity
 *
 * Uses mini model with high reasoning — analytical decision-making, not creative writing.
 */

import type { LLMProvider } from '../ai/provider.js';
import type { Recipe, MealEvent, Macros, FlexSlot, PlanSession, Batch } from '../models/types.js';
import type { PlanProposal, ProposedBatch, PreCommittedSlot } from '../solver/types.js';
import { config } from '../config.js';
import { log } from '../debug/logger.js';
import { validateProposal } from '../qa/validators/proposal.js';
import type { RecipeDatabase } from '../recipes/database.js';

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
  /** How many days the recipe lasts in the fridge (Plan 024 fridge-life constraint) */
  fridgeDays: number;
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

/**
 * Plan 024: discriminated union — the proposer can succeed or fail gracefully.
 * On failure, returns structured errors so the caller can abort with a user-facing message.
 */
export type PlanProposerOutput =
  | { type: 'proposal'; proposal: PlanProposal; reasoning: string }
  | { type: 'failure'; errors: string[] };

// ─── Main function ──────────────────────────────────────────────────────────────

/**
 * Generate a plan proposal using the LLM.
 *
 * Plan 024: the proposer always outputs complete plans. After mapping the LLM
 * response, validateProposal() gates the result. On validation failure, retries
 * once with errors fed back to the LLM. On double failure, returns a structured
 * failure so the caller can abort gracefully.
 *
 * @param input - Horizon context, available recipes, recent history
 * @param llm - LLM provider (uses mini model with high reasoning)
 * @param recipeDb - Recipe database for validator fridge-life checks
 * @returns Discriminated union: { type: 'proposal', proposal, reasoning } or { type: 'failure', errors }
 */
export async function proposePlan(
  input: PlanProposerInput,
  llm: LLMProvider,
  recipeDb: RecipeDatabase,
): Promise<PlanProposerOutput> {
  const systemPrompt = buildSystemPrompt(input);
  const userPrompt = buildUserPrompt(input);
  const horizonDays = input.horizonDays ?? input.weekDays;
  const preCommitted = input.preCommittedSlots ?? [];

  log.debug('PLAN', `proposing plan for horizon starting ${input.weekStart}, ${input.availableRecipes.length} recipes available`);

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
  let proposal = mapToProposal(parsed, input.events);

  log.debug('PLAN', `proposal: ${proposal.batches.length} batches, ${proposal.flexSlots.length} flex slots, ${proposal.events.length} events`);

  // Validate the proposal against all 13 invariants
  let validation = validateProposal(proposal, recipeDb, horizonDays, preCommitted);

  if (!validation.valid) {
    log.warn('PLAN', `proposal validation failed (${validation.errors.length} errors). Retrying with correction.`);
    for (const err of validation.errors) {
      log.warn('PLAN', `  validation error: ${err}`);
    }

    // Retry: feed validation errors back to the LLM as a correction
    const correctionMessage = [
      'Your proposal has validation errors:',
      ...validation.errors.map((e) => `- ${e}`),
      '',
      'Fix ALL errors and return the complete corrected JSON. Every non-event, non-flex, non-pre-committed slot must have a batch. No gaps.',
    ].join('\n');

    const retryResult = await llm.complete({
      model: 'mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: result.content },
        { role: 'user', content: correctionMessage },
      ],
      json: true,
      reasoning: 'high',
      context: 'plan-proposal-retry',
    });

    parsed = JSON.parse(retryResult.content);
    proposal = mapToProposal(parsed, input.events);
    log.debug('PLAN', `retry proposal: ${proposal.batches.length} batches, ${proposal.flexSlots.length} flex slots, ${proposal.events.length} events`);

    validation = validateProposal(proposal, recipeDb, horizonDays, preCommitted);
    if (!validation.valid) {
      log.error('PLAN', `retry also failed validation (${validation.errors.length} errors)`);
      for (const err of validation.errors) {
        log.error('PLAN', `  validation error: ${err}`);
      }
      return { type: 'failure', errors: validation.errors };
    }
  }

  for (const warn of validation.warnings) {
    log.warn('PLAN', `validation warning: ${warn}`);
  }

  return {
    type: 'proposal',
    proposal,
    reasoning: parsed.reasoning ?? '',
  };
}

// ─── Context builders ───────────────────────────────────────────────────────────

function buildSystemPrompt(input: PlanProposerInput): string {
  const hasPreCommitted = (input.preCommittedSlots ?? []).length > 0;

  return `You are a meal planning assistant that creates 7-day meal plans optimized for nutritional variety, adherence, and simplicity.

## YOUR JOB

Given a recipe database, recent meal history, and this horizon's constraints, propose a COMPLETE 7-day meal plan. Assign recipes to lunch and dinner slots, suggest flex meals, and pass through any events. Every slot must be covered — no gaps.

## HORIZON STRUCTURE

- 7-day planning horizon, 3 meals each day: breakfast (fixed), lunch, dinner
- Lunch and dinner are meal-prepped in batches of 1-3 servings
- Eating days in a batch need NOT be consecutive — events and flex meals in the middle are fine
- The hard constraint is fridge-life: the calendar span from the first eating day to the last must not exceed the recipe's \`fridge_days\` value
- Some slots may be taken by restaurant events (provided in the constraints)${hasPreCommitted ? '\n- Some slots are pre-committed from a prior plan session (provided below) — do NOT plan new batches for those slots' : ''}
- Exactly ${config.planning.flexSlotsPerWeek} slot(s) per horizon is a "flex meal" — the user eats something fun instead of meal prep
- The cook day for each batch is always the first day of its eating days (eating_days[0]). Do NOT propose separate cook days.

## FLEX SLOTS (HARD CONSTRAINT)

- Propose EXACTLY ${config.planning.flexSlotsPerWeek} flex meal slot(s) per week — not 0, not 2+
- Each additional flex slot beyond this shrinks every meal prep slot by ~25 cal, which hurts meal satisfaction
- Preferred day: Friday or Saturday dinner (social/weekend context)
- Flex bonus: 300-400 extra calories on top of normal meal budget
- A flex slot replaces one meal-prep slot — don't assign a recipe batch to that slot

## BATCH MODEL (Plan 024)

Batches are fridge-life constrained, NOT calendar-consecutive. A batch of 3 can span Wed, Fri, Sat — Thursday is a flex or event day. The constraints:

1. **Fridge life**: calendarSpan(first eating day, last eating day) ≤ recipe's \`fridge_days\`. Each recipe summary includes its \`fridge_days\`.
2. **Servings = eating days**: servings must equal the total number of eating days (including overflow).
3. **Servings range**: 1 to 3. Prefer 2-3 serving batches. 1-serving is allowed only when no multi-serving arrangement fits.
4. **Eating days sorted**: days must be in ascending ISO order.

## BATCH SIZING STRATEGY

Cover exactly the required number of meal prep slots with batches.

Preference order:
1. **Prefer 3-serving batches** — fewer cook days, less fridge churn, easier adherence.
2. **Mix 2 and 3 serving batches** to hit the exact slot count.
3. **1-serving batches** only as a last resort when multi-serving arrangements don't fit.

Rules:
- Prefer unique recipes across batches for maximum variety. When the recipe DB is too small to cover all slots with unique recipes, reuse recipes across batches — this is better than leaving gaps. Within the same day, avoid the same recipe for both lunch and dinner.
- Every non-event, non-flex, non-pre-committed slot MUST have a batch. Never leave gaps.

## VARIETY RULES (CRITICAL)

1. **No repeats**: Do NOT use any recipe that appears in the recent plan history
2. **Protein source rotation**: Aim for at least 2-3 different protein sources across the week
3. **Cuisine rotation**: Rotate cuisines across weeks
4. **Within-week variety**: Don't use the same protein source for both lunch and dinner on overlapping days${hasPreCommitted ? `
5. **Pre-committed slot recipes count as used**: Recipes in pre-committed slots count as already-used. Do NOT propose a new batch with the same recipe.` : ''}${hasPreCommitted ? `

## PRE-COMMITTED SLOTS

Some meal slots are already covered by batches from a prior plan session. These are FIXED — do NOT plan on top of them. Plan new batches only for uncovered slots.

Pre-committed slots will be listed in the user message below.` : ''}

## CROSS-HORIZON BATCHES

A 2- or 3-serving batch started on day 6 or 7 of the horizon can extend into days 8 or 9 (next session). This is preferred over a 1-serving orphan at the horizon edge.
- Use \`eating_days\` for ALL days (including overflow)
- Use \`overflow_days\` for days past the horizon end
- The solver only sees in-horizon days; overflow days become pre-committed in the next session

## USER FOOD PROFILE
The user lives in ${config.foodProfile.region}. Shopping: ${config.foodProfile.storeAccess}
${config.foodProfile.ingredientNotes}

## MICRONUTRIENT AWARENESS

Ensure the week's recipes cover diverse food groups:
- At least one fish meal for omega-3 (if available in DB)
- Varied vegetables across recipes
- Mix of food preparation methods

## OUTPUT FORMAT

Respond with ONLY valid JSON:
{
  "batches": [
    {
      "recipe_slug": "string — from the available recipes list",
      "recipe_name": "string",
      "meal_type": "lunch" | "dinner",
      "eating_days": ["ISO date strings — ALL days this batch covers (need not be consecutive), including overflow"],
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
  "events": [
    {
      "day": "ISO date string",
      "meal_time": "lunch" | "dinner",
      "name": "string",
      "estimated_calories": number
    }
  ],
  "reasoning": "string — brief explanation of your choices (protein rotation, cuisine variety, etc.)"
}`;
}

function buildUserPrompt(input: PlanProposerInput): string {
  const parts: string[] = [];
  const effectiveDays = input.horizonDays ?? input.weekDays;
  const effectiveStart = input.horizonStart ?? input.weekStart;
  const preCommitted = input.preCommittedSlots ?? [];

  // Horizon info
  const dayNames = effectiveDays.map((d) => {
    const date = new Date(d + 'T00:00:00');
    return `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${d}`;
  });
  parts.push(`## THIS HORIZON: ${effectiveStart} to ${effectiveDays[effectiveDays.length - 1]}`);
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
    parts.push('## EVENTS: None this horizon');
    parts.push('');
  }

  // Available recipes (now includes fridgeDays)
  parts.push('## AVAILABLE RECIPES');
  if (input.availableRecipes.length === 0) {
    parts.push('No recipes in database.');
  } else {
    for (const r of input.availableRecipes) {
      parts.push(`- ${r.slug}: "${r.name}" | ${r.mealTypes.join('/')} | ${r.cuisine} | ${r.proteinSource} | ${r.calories} cal, ${r.protein}g P | fridge_days: ${r.fridgeDays} | tags: ${r.tags.join(', ')}`);
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
    parts.push('## RECENT PLANS: None (first horizon — no repeat constraints)');
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
  parts.push(`- Cover exactly ${mealPrepSlotsNeeded} meal prep slots with batches. Prefer unique recipes; reuse if the DB is too small. Every slot must have a batch — no gaps.`);
  parts.push('');

  parts.push(`Create the best plan for this horizon. Cover exactly ${mealPrepSlotsNeeded} meal prep slots with batches + ${flexSlots} flex slot(s). Prefer 3-serving batches where possible. Include all events in the output.`);

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
      fridgeDays: r.storage.fridgeDays,
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
 * The LLM emits `eating_days` (full day list) and `overflow_days`
 * (days past horizon end). We map into ProposedBatch.days (in-horizon, for the
 * solver) and ProposedBatch.overflowDays. Falls back to the `days` field
 * if `eating_days` is absent (backward compat with old recordings).
 *
 * Plan 024: events are mapped from the raw output. recipesToGenerate is always [].
 */
function mapToProposal(raw: Record<string, unknown>, inputEvents: MealEvent[]): PlanProposal {
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

  // Plan 024: input events are always authoritative — the LLM may echo a
  // subset or tweak fields, so we never trust the raw output over the user's list.
  const events = inputEvents;

  // Plan 024: proposer always returns [] — the field stays for mutation handlers until Plan 025
  return { batches, flexSlots, events, recipesToGenerate: [] };
}

// fillOrphanSlots removed in Plan 024 — replaced by validateProposal() + retry loop
