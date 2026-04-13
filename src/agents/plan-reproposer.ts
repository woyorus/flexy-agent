/**
 * Re-proposer agent — adjusts an existing plan based on a user's change request.
 *
 * Replaces all deterministic mutation handlers (removeBatchDay, resolveOrphanPool,
 * classifySwapIntent, etc.) with a single structured-output LLM call. The re-proposer
 * receives the current plan, the user's message, and mutation history, then returns
 * either a complete new proposal or a clarification question.
 *
 * Same output contract as the initial proposer: complete plan (batches + flex slots +
 * events) validated by the same proposal validator. The flow is:
 *   user message → reProposePlan() → validate → retry on failure → return result
 *
 * Design doc: docs/design-docs/proposals/002-plans-that-survive-real-life.md
 * Plan: docs/plans/active/025-re-proposer-agent-and-flow-simplification.md
 */

import type { LLMProvider } from '../ai/provider.js';
import type { PlanProposal, ProposedBatch, PreCommittedSlot } from '../solver/types.js';
import type { MealEvent, FlexSlot, MutationRecord } from '../models/types.js';
import type { RecipeSummary } from './plan-proposer.js';
import type { RecipeDatabase } from '../recipes/database.js';
import { validateProposal } from '../qa/validators/proposal.js';
import { config } from '../config.js';
import { log } from '../debug/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface ReProposerInput {
  currentProposal: PlanProposal;
  userMessage: string;
  mutationHistory: MutationRecord[];
  availableRecipes: RecipeSummary[];
  horizonDays: string[];
  preCommittedSlots: PreCommittedSlot[];
  breakfast: { name: string; caloriesPerDay: number; proteinPerDay: number };
  weeklyTargets: { calories: number; protein: number };
  /**
   * Plan 026: which execution context the re-proposer is running in.
   *
   * - 'in-session': during an active planning conversation, before the user
   *   has confirmed the plan. The meal-type lane rule is enforced; the
   *   near-future safety rule is NOT (there's no real-world prep yet).
   * - 'post-confirmation': the user has a confirmed plan running and is
   *   asking to adjust it. Both rules are enforced. The caller MUST provide
   *   `nearFutureDays` (≤2 ISO dates) representing the soft-locked window.
   */
  mode: 'in-session' | 'post-confirmation';
  /**
   * Plan 026: soft-locked window under 'post-confirmation' mode. Present only
   * (and required) when mode === 'post-confirmation'. Up to 2 ISO dates:
   * today and tomorrow, intersected with the horizon.
   */
  nearFutureDays?: string[];
}

// MutationRecord moved to models/types.ts in Plan 026. Re-exported here so the
// single existing importer (plan-flow.ts) keeps working without a widespread rename.
// NOTE: this re-export form (without `from`) re-exports the LOCAL binding introduced
// by the import above — a `export type { ... } from '../models/types.js';` form would
// NOT create a local binding and would break `ReProposerInput.mutationHistory` at line 31.
export type { MutationRecord };

export type ReProposerOutput =
  | { type: 'proposal'; proposal: PlanProposal; reasoning: string }
  | { type: 'clarification'; question: string; recipeNeeded?: string; recipeMealType?: 'lunch' | 'dinner' }
  | { type: 'failure'; message: string };

// ─── Main entry point ───────────────────────────────────────────────────────────

/**
 * Re-propose a plan based on the user's change request.
 *
 * Makes a single LLM call with the current plan + user message. Validates the
 * output with the same proposal validator used by the initial proposer. On
 * validation failure, retries once with errors as feedback. Two failures return
 * a failure result so the orchestration can keep the prior plan.
 *
 * @param input - Current plan, user message, context
 * @param llm - LLM provider
 * @param recipeDb - Recipe database for validator fridge-life checks
 * @returns Proposal, clarification, or failure
 */
export async function reProposePlan(
  input: ReProposerInput,
  llm: LLMProvider,
  recipeDb: RecipeDatabase,
  onTrace?: (event: import('../harness/trace.js').TraceEvent) => void,
): Promise<ReProposerOutput> {
  const systemPrompt = buildSystemPrompt(input);
  const userPrompt = buildUserPrompt(input);

  log.debug('REPROPOSER', `re-proposing plan: "${input.userMessage.slice(0, 80)}"`);

  const result = await llm.complete({
    model: 'mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    json: true,
    reasoning: 'high',
    context: 'plan-reproposal',
  });

  const parsed = JSON.parse(result.content);

  // Handle clarification
  if (parsed.type === 'clarification') {
    log.debug('REPROPOSER', `clarification: "${parsed.question}"`);
    return {
      type: 'clarification',
      question: parsed.question,
      recipeNeeded: parsed.recipe_needed ?? undefined,
      recipeMealType: parsed.recipe_meal_type ?? undefined,
    };
  }

  // Map to proposal and validate
  let proposal = mapToProposal(parsed);
  let validation = validateProposal(proposal, recipeDb, input.horizonDays, input.preCommittedSlots);

  if (!validation.valid) {
    log.warn('REPROPOSER', `validation failed (${validation.errors.length} errors). Retrying.`);
    for (const err of validation.errors) {
      log.warn('REPROPOSER', `  error: ${err}`);
    }
    // Plan 031: record the retry in the harness execTrace.
    onTrace?.({
      kind: 'retry',
      validator: 'plan-reproposer',
      attempt: 2,
      errors: [...validation.errors],
    });

    // Retry with validation errors as feedback
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
      context: 'plan-reproposal-retry',
    });

    const retryParsed = JSON.parse(retryResult.content);

    // If retry returns a clarification, accept it
    if (retryParsed.type === 'clarification') {
      return {
        type: 'clarification',
        question: retryParsed.question,
        recipeNeeded: retryParsed.recipe_needed ?? undefined,
        recipeMealType: retryParsed.recipe_meal_type ?? undefined,
      };
    }

    proposal = mapToProposal(retryParsed);
    validation = validateProposal(proposal, recipeDb, input.horizonDays, input.preCommittedSlots);

    if (!validation.valid) {
      log.error('REPROPOSER', `retry also failed validation (${validation.errors.length} errors)`);
      for (const err of validation.errors) {
        log.error('REPROPOSER', `  error: ${err}`);
      }
      // Plan 031: record the terminal failure attempt in execTrace.
      onTrace?.({
        kind: 'retry',
        validator: 'plan-reproposer',
        attempt: 3,
        errors: [...validation.errors],
      });
      return {
        type: 'failure',
        message: "I couldn't apply that change cleanly. Try rephrasing or adjusting your request.",
      };
    }
  }

  for (const warn of validation.warnings) {
    log.warn('REPROPOSER', `validation warning: ${warn}`);
  }

  const reasoning = parsed.reasoning ?? '';
  log.debug('REPROPOSER', `proposal: ${proposal.batches.length} batches, ${proposal.flexSlots.length} flex, ${proposal.events.length} events`);

  return { type: 'proposal', proposal, reasoning };
}

// ─── Prompt builders ────────────────────────────────────────────────────────────

function buildSystemPrompt(input: ReProposerInput): string {
  const base = `You are a meal plan adjustment agent. You receive a current plan and a user's change request. Your job is to adjust the plan according to the request and return a COMPLETE new plan.

## OUTPUT TYPE

You MUST return one of two JSON shapes:

**If you can make the change:**
{
  "type": "proposal",
  "batches": [...],
  "flex_slots": [...],
  "events": [...],
  "reasoning": "string — brief explanation of what you changed and why"
}

**If you need clarification (ambiguous request or recipe not in DB):**
{
  "type": "clarification",
  "question": "string — the question to ask the user",
  "recipe_needed": "string or null — non-null when the user wants a recipe not in the DB",
  "recipe_meal_type": "lunch or dinner — REQUIRED when recipe_needed is set"
}

## AUTHORITY RULES

**You CAN change:**
- Batch eating days (rearrange when meals are eaten)
- Serving counts (1-3 per batch)
- Flex placement (which day/meal gets the flex slot)
- Cook days (derived from first eating day — not set separately)
- Events: add, remove, or modify per user intent
- Recipes: ONLY when the user explicitly requests a recipe change

**You CANNOT change:**
- Pre-committed slots (fixed from prior session)
- Breakfast (fixed)
- Total flex count: MUST stay at exactly ${config.planning.flexSlotsPerWeek}
- Calorie targets (the solver's domain)
- Recipes without user intent — do NOT silently swap recipes. The user may have bought ingredients.

## BATCH MODEL RULES

- Eating days in a batch need NOT be consecutive — events and flex in the middle are fine
- Fridge life is a hard constraint: calendarSpan(first eating day, last eating day) ≤ recipe's fridge_days
- Servings range: 1 to 3. Prefer 2-3 serving batches. 1-serving only when no multi-serving arrangement fits.
- Servings must equal the number of eating days (including overflow)
- Cook day = first eating day (always)
- Days must be in ascending ISO order within each batch

## MEAL-TYPE LANE RULE (load-bearing, never crossed)

Each batch has a mealType ('lunch' or 'dinner'), and each recipe in the available list has a "mealTypes" array listing which meal contexts it was authored for. A batch's mealType MUST be one of its recipe's mealTypes — specifically, batch.mealType ∈ recipe.mealTypes must hold for every batch you emit. You MUST NOT place a dinner-only recipe into a lunch batch, or a lunch-only recipe into a dinner batch.

This rule is NOT cosmetic. Lunch and dinner are physically different meals: lunch is portable, no-reheat, and light (midday energy matters); dinner can be heavy, sauce-heavy, cooked-to-reheat. Silently crossing lanes produces a plan the user cannot actually execute.

If the user asks for a swap that would violate this, pick a different recipe in the permitted mealTypes, or return a clarification explaining the constraint.

## CROSS-HORIZON BATCHES

Batches near the horizon edge can extend into the next session:
- eating_days includes ALL days (in-horizon + overflow)
- overflow_days lists only days past the horizon end
- The solver only sees in-horizon days; overflow becomes pre-committed next session

## MUTATION HISTORY

Prior user-approved changes are load-bearing — do NOT undo them unless the new request explicitly conflicts. The user built this plan iteratively; respect earlier choices.

## RECIPE MATCHING

If the user asks for a recipe not in the available recipes list, return a clarification with recipe_needed set. Example: "I don't have a Thai green curry. Want me to create one?"

## COMPLETENESS

Always output a COMPLETE plan — every lunch and dinner slot in the horizon must be covered by exactly one of: batch, flex, event, or pre-committed slot. No gaps, no overlaps.`;

  if (input.mode !== 'post-confirmation') {
    return base;
  }

  const nearFuture = (input.nearFutureDays ?? []).join(', ') || '(none)';
  return `${base}

## NEAR-FUTURE SAFETY (post-confirmation mode)

You are running on a CONFIRMED plan that the user is already living through. The user has likely shopped, portioned, or prepared meals for the next couple of days. The following ISO dates are "near-future" and are SOFT-LOCKED: ${nearFuture}

Rules for near-future days:
- You MUST NOT silently rearrange meals on near-future days. Leave them exactly as they are unless the user's request explicitly targets a near-future slot.
- You MAY change a near-future slot when the user's request clearly names it — examples of explicit targeting: "move today's dinner to tomorrow", "skip tomorrow's lunch — I'm eating out", "swap the lunch I'm about to make for something else".
- Days strictly outside the near-future window can be rearranged freely within the other rules (fridge-life, pre-committed slots, meal-type lanes, mutation history, flex count).
- If absorbing the user's request would force a silent change to a near-future day that the user did not explicitly target, return a clarification asking the user to confirm the near-future impact — do NOT make the change unilaterally.

This rule exists because the user's real-world preparation must be respected unless they explicitly override it themselves.`;
}

function buildUserPrompt(input: ReProposerInput): string {
  const parts: string[] = [];

  // Horizon
  const dayNames = input.horizonDays.map((d) => {
    const date = new Date(d + 'T00:00:00');
    return `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${d}`;
  });
  parts.push(`## HORIZON: ${input.horizonDays[0]} to ${input.horizonDays[input.horizonDays.length - 1]}`);
  parts.push(`Days: ${dayNames.join(', ')}`);
  parts.push('');

  // Current plan
  parts.push('## CURRENT PLAN');
  parts.push('');
  parts.push(`Breakfast (daily, fixed): ${input.breakfast.name} — ${input.breakfast.caloriesPerDay} cal`);
  parts.push('');

  // Batches
  parts.push('Batches:');
  for (const batch of input.currentProposal.batches) {
    const overflow = batch.overflowDays?.length ? `, overflow: ${batch.overflowDays.join(', ')}` : '';
    parts.push(`  ${batch.mealType} [${batch.days.join(', ')}]: ${batch.recipeName} (${batch.recipeSlug}) — ${batch.servings} servings${overflow}`);
  }
  parts.push('');

  // Flex
  parts.push('Flex slots:');
  for (const flex of input.currentProposal.flexSlots) {
    parts.push(`  ${flex.day} ${flex.mealTime}: ${flex.note ?? 'flex meal'}`);
  }
  parts.push('');

  // Events
  if (input.currentProposal.events.length > 0) {
    parts.push('Events:');
    for (const e of input.currentProposal.events) {
      parts.push(`  ${e.day} ${e.mealTime}: ${e.name} (~${e.estimatedCalories} cal)`);
    }
    parts.push('');
  }

  // Pre-committed
  if (input.preCommittedSlots.length > 0) {
    parts.push('Pre-committed slots (FIXED — do NOT change):');
    for (const s of input.preCommittedSlots) {
      parts.push(`  ${s.day} ${s.mealTime}: ${s.recipeSlug} (${s.calories} cal)`);
    }
    parts.push('');
  }

  // Mutation history
  if (input.mutationHistory.length > 0) {
    parts.push('## PRIOR CHANGES (load-bearing — do not undo unless explicitly asked)');
    for (const m of input.mutationHistory) {
      parts.push(`- "${m.constraint}" (${m.appliedAt})`);
    }
    parts.push('');
  }

  // Available recipes
  parts.push('## AVAILABLE RECIPES');
  for (const r of input.availableRecipes) {
    parts.push(`- ${r.slug}: "${r.name}" | ${r.mealTypes.join('/')} | ${r.cuisine} | ${r.proteinSource} | ${r.calories} cal, ${r.protein}g P | fridge_days: ${r.fridgeDays}`);
  }
  parts.push('');

  // User message
  parts.push('## USER REQUEST');
  parts.push(input.userMessage);
  parts.push('');

  // Output schema reminder
  parts.push('## OUTPUT FORMAT');
  parts.push('Return JSON with type "proposal" or "clarification". For proposals:');
  parts.push('{');
  parts.push('  "type": "proposal",');
  parts.push('  "batches": [{ "recipe_slug": "...", "recipe_name": "...", "meal_type": "lunch|dinner", "eating_days": ["ISO dates"], "overflow_days": ["ISO dates past horizon end"], "servings": N }],');
  parts.push('  "flex_slots": [{ "day": "ISO date", "meal_time": "lunch|dinner", "flex_bonus": 300-400, "note": "..." }],');
  parts.push('  "events": [{ "day": "ISO date", "meal_time": "lunch|dinner", "name": "...", "estimated_calories": N }],');
  parts.push('  "reasoning": "..."');
  parts.push('}');

  return parts.join('\n');
}

// ─── Mapping ────────────────────────────────────────────────────────────────────

/**
 * Map raw LLM JSON output to a PlanProposal.
 * Same logic as the initial proposer's mapToProposal but trusts the re-proposer's
 * events (it may have added/removed/modified them per user intent).
 */
function mapToProposal(raw: Record<string, unknown>): PlanProposal {
  const batches = (raw.batches as Array<Record<string, unknown>>).map((b) => {
    const eatingDays = (b.eating_days ?? b.days) as string[];
    const overflowDays = (b.overflow_days ?? []) as string[];
    const overflowSet = new Set(overflowDays);
    const inHorizonDays = eatingDays.filter((d) => !overflowSet.has(d));

    return {
      recipeSlug: b.recipe_slug as string,
      recipeName: b.recipe_name as string,
      mealType: b.meal_type as 'lunch' | 'dinner',
      days: inHorizonDays,
      servings: b.servings as number,
      overflowDays: overflowDays.length > 0 ? overflowDays : undefined,
    };
  }) satisfies ProposedBatch[];

  const flexSlots = ((raw.flex_slots ?? []) as Array<Record<string, unknown>>).map((f) => ({
    day: f.day as string,
    mealTime: f.meal_time as 'lunch' | 'dinner',
    flexBonus: f.flex_bonus as number,
    note: (f.note as string) ?? undefined,
  })) satisfies FlexSlot[];

  // Re-proposer's events are authoritative — it may add/remove/modify per user intent
  const events = ((raw.events ?? []) as Array<Record<string, unknown>>).map((e) => ({
    name: e.name as string,
    day: e.day as string,
    mealTime: e.meal_time as 'lunch' | 'dinner',
    estimatedCalories: e.estimated_calories as number,
    notes: (e.notes as string) ?? undefined,
  })) satisfies MealEvent[];

  return { batches, flexSlots, events, recipesToGenerate: [] };
}
