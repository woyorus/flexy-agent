/**
 * Plan week flow handler.
 *
 * Orchestrates the weekly planning session through Telegram. The flow is
 * suggestive-first: the system proposes a complete plan, the user approves
 * or tweaks. Target: 2-3 exchanges, under 2 minutes for a happy path.
 *
 * Flow phases:
 *   context → awaiting_events → generating_proposal → [recipe_suggestion →
 *   awaiting_recipe_prefs → generating_recipe → reviewing_recipe →]
 *   proposal → [awaiting_swap →] confirmed
 *
 * Follows the recipe-flow.ts pattern: exported state type, factory function,
 * and pure handler functions that return FlowResponse (text + updated state).
 *
 * Not responsible for: calorie math (solver does that), recipe generation
 * (recipe-generator sub-agent does that), plan validation (QA gate does that),
 * Telegram message sending (bot.ts does that).
 */

import type { LLMProvider, ChatMessage } from '../ai/provider.js';
import type { Recipe, MealEvent, FlexSlot, ScaledIngredient, DraftPlanSession } from '../models/types.js';
import { scaleRecipe } from './recipe-scaler.js';
import type { PlanProposal, ProposedBatch, RecipeGap, SolverInput, PreCommittedSlot } from '../solver/types.js';
import { config } from '../config.js';
import { log } from '../debug/logger.js';
import { solve } from '../solver/solver.js';
import { validatePlan } from '../qa/validators/plan.js';
import {
  proposePlan,
  buildRecipeSummaries,
  buildRecentPlanSummariesFromSessions,
  getWeekDays,
  toLocalISODate,
  type PlanProposerInput,
} from './plan-proposer.js';
import type { Batch as NewBatch } from '../models/types.js';
import {
  generateRecipe,
  correctRecipeMacros,
  type GenerateResult,
} from './recipe-generator.js';
import { targetsForMealType } from './recipe-flow.js';
import { validateRecipe } from '../qa/validators/recipe.js';
import type { RecipeDatabase } from '../recipes/database.js';
import type { StateStoreLike } from '../state/store.js';
import { v4 as uuid } from 'uuid';

// ─── Flow state ─────────────────────────────────────────────────────────────────

export type PlanFlowPhase =
  | 'context'               // Showing breakfast confirm + events question
  | 'awaiting_events'       // User adding events (text/voice loop)
  | 'generating_proposal'   // Loading state while plan generates
  | 'recipe_suggestion'     // Asking about generating a recipe for a gap
  | 'awaiting_recipe_prefs' // User providing preferences for gap recipe
  | 'generating_recipe'     // Recipe being generated for a gap
  | 'reviewing_recipe'      // User reviewing generated recipe
  | 'proposal'              // Full plan displayed
  | 'awaiting_swap'         // User typing swap request
  | 'confirmed';            // Plan locked

/**
 * State for an in-progress plan week session.
 * Persisted in memory during the conversation (same pattern as RecipeFlowState).
 */
export interface PlanFlowState {
  phase: PlanFlowPhase;
  weekStart: string;
  weekDays: string[];
  breakfast: {
    recipeSlug: string;
    name: string;
    caloriesPerDay: number;
    proteinPerDay: number;
  };
  events: MealEvent[];
  /** The current plan proposal (set after plan-proposer runs) */
  proposal?: PlanProposal;
  /** Unresolved recipe gaps from the proposal */
  pendingGaps?: RecipeGap[];
  /** Index of the gap currently being resolved */
  activeGapIndex?: number;
  /** Conversation history for in-flow recipe generation */
  recipeGenMessages?: ChatMessage[];
  /** Recipe being reviewed within the flow (for gap resolution) */
  currentRecipe?: Recipe;

  // ─── Plan 007: rolling-horizon fields (strangler-fig — coexist with weekStart/weekDays) ───

  /** ISO date — first day of the 7-day horizon. */
  horizonStart?: string;
  /** 7 ISO date strings covering [horizonStart, horizonStart+6]. */
  horizonDays?: string[];
  /**
   * When replanning a future-only session (D27), this holds the session ID
   * being replaced. The old session stays live until confirmPlanSessionReplacing
   * runs at approve time (save-before-destroy).
   */
  replacingSessionId?: string;
  /** Pre-committed slots from prior sessions, loaded at proposal time (read-only display). */
  preCommittedSlots?: PreCommittedSlot[];
}

export interface FlowResponse {
  text: string;
  state: PlanFlowState;
}

// ─── Factory ────────────────────────────────────────────────────────────────────

/**
 * Create a fresh plan flow state.
 *
 * @param weekStart - ISO date for the Monday of the week to plan
 * @param breakfast - The locked breakfast configuration
 */
export function createPlanFlowState(
  weekStart: string,
  breakfast: PlanFlowState['breakfast'],
): PlanFlowState {
  return {
    phase: 'context',
    weekStart,
    weekDays: getWeekDays(weekStart),
    breakfast,
    events: [],
  };
}

/**
 * Create a plan flow state for a rolling horizon (Plan 007).
 *
 * Populates both the legacy weekStart/weekDays (for backward-compat during
 * strangler-fig) and the new horizonStart/horizonDays.
 */
export function createPlanFlowStateFromHorizon(
  horizonStart: string,
  breakfast: PlanFlowState['breakfast'],
  replacingSessionId?: string,
): PlanFlowState {
  const days = getWeekDays(horizonStart);
  return {
    phase: 'context',
    weekStart: horizonStart,
    weekDays: days,
    horizonStart,
    horizonDays: days,
    breakfast,
    events: [],
    replacingSessionId,
  };
}

/**
 * Compute the start date for the next planning horizon (Plan 007 D27).
 *
 * Uses three explicit store queries in fallback order:
 * 1. Future sessions → replan the earliest one
 * 2. Running session → continuous rolling (day after horizonEnd)
 * 3. Historical/none → tomorrow
 */
export async function computeNextHorizonStart(
  store: StateStoreLike,
): Promise<{
  start: string;
  replacingSession?: import('../models/types.js').PlanSession;
  runningSession?: import('../models/types.js').PlanSession;
}> {
  const future = await store.getFuturePlanSessions();
  if (future.length > 0) {
    return { start: future[0]!.horizonStart, replacingSession: future[0]! };
  }

  const running = await store.getRunningPlanSession();
  if (running) {
    const nextDay = addDays(running.horizonEnd, 1);
    return { start: nextDay, runningSession: running };
  }

  const last = await store.getLatestHistoricalPlanSession();
  // Fallback: tomorrow
  const tomorrow = addDays(toLocalISODate(new Date()), 1);
  return { start: tomorrow };
}

/** Add N days to an ISO date string and return the result as ISO date. */
function addDays(isoDate: string, n: number): string {
  const d = new Date(isoDate + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toLocalISODate(d);
}

// ─── Phase handlers ─────────────────────────────────────────────────────────────

/**
 * User confirmed breakfast and has no events. Advance to plan generation.
 */
export function handleNoEvents(state: PlanFlowState): FlowResponse {
  state.events = [];
  state.phase = 'generating_proposal';
  log.debug('PLAN-FLOW', 'no events, advancing to proposal generation');
  return {
    text: 'No events this week. Generating your plan...',
    state,
  };
}

/**
 * User wants to add an event. Set phase to collect event details.
 */
export function handleAddEvent(state: PlanFlowState): FlowResponse {
  state.phase = 'awaiting_events';
  log.debug('PLAN-FLOW', 'phase → awaiting_events');
  return {
    text: 'Describe the event — which day, which meal, and what kind of place. (e.g., "Thursday dinner, Italian restaurant with coworkers")',
    state,
  };
}

/**
 * Handle free-form text during event collection.
 *
 * First classifies whether the message is a new event or a correction to the
 * last one (e.g., "it's not going to be 1000 cal, more like 500"). Then routes
 * to the appropriate handler.
 */
export async function handleEventText(
  state: PlanFlowState,
  text: string,
  llm: LLMProvider,
): Promise<FlowResponse> {
  log.debug('PLAN-FLOW', `event text: "${text}"`);

  // If there's a previous event, classify: is this a correction, reclassification, or a new event?
  const lastEvent = state.events.length > 0 ? state.events[state.events.length - 1]! : null;
  if (lastEvent) {
    const intent = await classifyEventIntent(text, lastEvent, llm);
    log.debug('PLAN-FLOW', `event intent: ${intent.type}`);

    if (intent.type === 'reclassify_as_treat') {
      // User clarified that the last "event" is actually a treat, not a meal replacement.
      // Remove it from state.events so the solver doesn't delete their meal slot.
      const removed = state.events.pop()!;
      const treatBudget = Math.round(config.targets.weekly.calories * config.targets.treatBudgetPercent);
      log.debug('PLAN-FLOW', `event reclassified as treat, removed: ${removed.name}`);
      return {
        text: `Got it — that's a treat, not a meal replacement. Your treat budget (~${treatBudget} cal/week) covers it and you still eat your regular meals.\n\nAny actual meals out?`,
        state,
      };
    }

    if (intent.type === 'correction') {
      // Apply the correction to the last event
      if (intent.newCalories !== undefined) {
        lastEvent.estimatedCalories = intent.newCalories;
      }
      if (intent.newMealTime !== undefined) {
        lastEvent.mealTime = intent.newMealTime;
      }
      if (intent.newName !== undefined) {
        lastEvent.name = intent.newName;
      }
      log.debug('PLAN-FLOW', `event corrected: ${lastEvent.name} → ~${lastEvent.estimatedCalories} cal`);

      return {
        text: `Updated — ${lastEvent.name} on ${formatDayShort(lastEvent.day)} ${lastEvent.mealTime} (~${lastEvent.estimatedCalories} cal). Any other meals out?`,
        state,
      };
    }
  }

  // It's a new event — parse it
  return parseNewEvent(state, text, llm);
}

/**
 * Classify a follow-up message during event collection.
 * Three possible intents: correction to last event, reclassification as treat
 * (user says it's actually a snack, not a meal replacement), or a new event.
 */
async function classifyEventIntent(
  text: string,
  lastEvent: MealEvent,
  llm: LLMProvider,
): Promise<EventIntent> {
  const result = await llm.complete({
    model: 'nano',
    json: true,
    context: 'event-intent',
    messages: [
      {
        role: 'system',
        content: `The user is adding meals-out events to their weekly meal plan. They just added this event:
"${lastEvent.name}" — ${lastEvent.day} ${lastEvent.mealTime}, ~${lastEvent.estimatedCalories} cal

Now they sent a follow-up message. Determine their intent:
1. CORRECTION — changing calories, meal time, name, or other details of the same event
2. RECLASSIFY_AS_TREAT — clarifying that this was NOT a meal replacement but just snacks/drinks/dessert that don't replace their regular meal (e.g. "actually those were just cookies", "no, I still eat dinner normally", "it's just a snack")
3. NEW_EVENT — describing a separate, additional meal out

Respond with JSON:
- correction: {"type":"correction","new_calories":number|null,"new_meal_time":"lunch"|"dinner"|null,"new_name":"string"|null}
- reclassify: {"type":"reclassify_as_treat"}
- new event: {"type":"new_event"}`,
      },
      { role: 'user', content: text },
    ],
    maxTokens: 80,
  });

  try {
    const parsed = JSON.parse(result.content);
    if (parsed.type === 'correction') {
      return {
        type: 'correction',
        newCalories: parsed.new_calories ?? undefined,
        newMealTime: parsed.new_meal_time ?? undefined,
        newName: parsed.new_name ?? undefined,
      };
    }
    if (parsed.type === 'reclassify_as_treat') {
      return { type: 'reclassify_as_treat' };
    }
  } catch { /* fall through */ }

  return { type: 'new_event' };
}

type EventIntent =
  | { type: 'correction'; newCalories?: number; newMealTime?: 'lunch' | 'dinner'; newName?: string }
  | { type: 'reclassify_as_treat' }
  | { type: 'new_event' };

/**
 * Parse a new event from free-form text using the LLM.
 * Classifies as meal_replacement (replaces a slot) or treat (treat budget debit).
 */
async function parseNewEvent(
  state: PlanFlowState,
  text: string,
  llm: LLMProvider,
): Promise<FlowResponse> {
  log.debug('PLAN-FLOW', `parsing new event: "${text}"`);

  const treatBudget = Math.round(config.targets.weekly.calories * config.targets.treatBudgetPercent);

  const result = await llm.complete({
    model: 'nano',
    json: true,
    context: 'event-parsing',
    messages: [
      {
        role: 'system',
        content: `Parse a meal event description. The week runs ${state.weekDays[0]} to ${state.weekDays[6]}.
Day names map to: ${state.weekDays.map((d) => `${formatDayShort(d)}=${d}`).join(', ')}.

CLASSIFY the event type:
- "meal_replacement": eating a full meal somewhere else (restaurant, dinner party, lunch out, takeout replacing a home meal). The meal prep for that slot is skipped.
- "treat": snacks, desserts, or extras alongside regular meals (cookies at work, birthday cake, conference snacks, drinks at happy hour). Does NOT replace any meal.

Respond with JSON:
{
  "type": "meal_replacement" | "treat",
  "name": "string — short description",
  "day": "ISO date string",
  "meal_time": "lunch" | "dinner",
  "estimated_calories": number (reasonable estimate based on what's described),
  "notes": "string or null"
}`,
      },
      { role: 'user', content: text },
    ],
    maxTokens: 150,
  });

  try {
    const parsed = JSON.parse(result.content);

    if (parsed.type === 'treat') {
      log.debug('PLAN-FLOW', `treat detected (not a meal replacement): ${parsed.name} ~${parsed.estimated_calories} cal`);
      return {
        text: `That's a treat — your treat budget (~${treatBudget} cal/week) covers it. You still eat your regular meals that day.\n\nAny meals you'll eat out?`,
        state,
      };
    }

    const event: MealEvent = {
      name: parsed.name,
      day: parsed.day,
      mealTime: parsed.meal_time,
      estimatedCalories: parsed.estimated_calories,
      notes: parsed.notes ?? undefined,
    };
    state.events.push(event);
    log.debug('PLAN-FLOW', `meal-replacement event added: ${event.name} on ${event.day} ${event.mealTime} (~${event.estimatedCalories} cal)`);

    return {
      text: `Got it — ${event.name} on ${formatDayShort(event.day)} ${event.mealTime} (~${event.estimatedCalories} cal). Any other meals out?`,
      state,
    };
  } catch {
    return {
      text: "I couldn't parse that. Try something like: \"Thursday dinner, Italian restaurant\" or \"Saturday lunch with friends\"",
      state,
    };
  }
}

/**
 * User is done adding events. Advance to plan generation.
 */
export function handleEventsDone(state: PlanFlowState): FlowResponse {
  state.phase = 'generating_proposal';
  log.debug('PLAN-FLOW', `events done (${state.events.length} events), advancing to proposal generation`);
  return {
    text: `${state.events.length} event${state.events.length === 1 ? '' : 's'} noted. Generating your plan...`,
    state,
  };
}

/**
 * Generate the plan proposal. This is the heavy async operation:
 * 1. Load available recipes and recent plan history
 * 2. Call plan-proposer sub-agent
 * 3. Run solver on the proposal
 * 4. Validate the solver output
 * 5. Check for recipe gaps
 *
 * Returns either a recipe gap prompt or the full plan proposal.
 */
export async function handleGenerateProposal(
  state: PlanFlowState,
  llm: LLMProvider,
  recipes: RecipeDatabase,
  store: StateStoreLike,
): Promise<FlowResponse> {
  log.debug('PLAN-FLOW', 'generating proposal');

  // Plan 007: load pre-committed slots from prior sessions
  let preCommittedSlots: PreCommittedSlot[] = [];
  if (state.horizonDays) {
    const carriedBatches = await store.getBatchesOverlapping({
      horizonStart: state.horizonDays[0]!,
      horizonEnd: state.horizonDays[6]!,
      statuses: ['planned'],
    });
    // In replan flows, filter out the session being replaced (D27)
    const effectiveBatches = state.replacingSessionId
      ? carriedBatches.filter((b: NewBatch) => b.createdInPlanSessionId !== state.replacingSessionId)
      : carriedBatches;
    preCommittedSlots = materializeSlotsFromBatches(effectiveBatches, state.horizonDays);
  }

  // Build context for the proposer
  const availableRecipes = buildRecipeSummaries(recipes.getAll());

  // Variety engine: load recent sessions for recipe history
  const recentSessions = await store.getRecentPlanSessions(2);
  const batchesBySession = new Map<string, NewBatch[]>();
  for (const s of recentSessions) {
    batchesBySession.set(s.id, await store.getBatchesByPlanSessionId(s.id));
  }
  const recentSummaries = buildRecentPlanSummariesFromSessions(recentSessions, batchesBySession, recipes);

  const proposerInput: PlanProposerInput = {
    weekStart: state.weekStart,
    weekDays: state.weekDays,
    breakfast: state.breakfast,
    events: state.events,
    availableRecipes,
    recentPlans: recentSummaries,
    weeklyTargets: config.targets.weekly,
    // Plan 007 fields (only populated on rolling path)
    horizonStart: state.horizonStart,
    horizonDays: state.horizonDays,
    preCommittedSlots: preCommittedSlots.length > 0 ? preCommittedSlots : undefined,
  };

  // Call plan-proposer
  const { proposal, reasoning } = await proposePlan(proposerInput, llm);
  log.debug('PLAN', `proposer reasoning: ${reasoning}`);

  // Run solver on the proposal using real recipe macros
  const solverInput = buildSolverInput(state, proposal, recipes, preCommittedSlots);
  const solverOutput = solve(solverInput);
  proposal.solverOutput = solverOutput;

  // Validate
  const validation = validatePlan(solverOutput, config.targets.weekly, preCommittedSlots);
  if (!validation.valid) {
    log.warn('QA', `plan validation warnings: ${validation.errors.join('; ')}`);
  }

  state.proposal = proposal;
  if (preCommittedSlots.length > 0) {
    state.preCommittedSlots = preCommittedSlots;
  }

  // Check for recipe gaps
  if (proposal.recipesToGenerate.length > 0) {
    state.pendingGaps = [...proposal.recipesToGenerate];
    state.activeGapIndex = 0;
    return presentRecipeGap(state);
  }

  // No gaps — present the full plan
  state.phase = 'proposal';
  return {
    text: formatPlanProposal(state),
    state,
  };
}

/**
 * User chose how to handle a recipe gap.
 *
 * @param action - 'generate' (use the system's suggestion), 'idea' (user has preferences), 'skip' (use best available)
 * @param userPrefs - Optional user preferences (only when action is 'idea')
 */
export async function handleGapResponse(
  state: PlanFlowState,
  action: 'generate' | 'idea' | 'skip',
  llm: LLMProvider,
  recipes: RecipeDatabase,
  userPrefs?: string,
): Promise<FlowResponse> {
  const gap = state.pendingGaps?.[state.activeGapIndex ?? 0];
  if (!gap) {
    state.phase = 'proposal';
    return { text: formatPlanProposal(state), state };
  }

  if (action === 'skip') {
    // Pick best available from DB
    const available = recipes.getByMealType(gap.mealType);
    const usedSlugs = new Set(state.proposal?.batches.map((b) => b.recipeSlug) ?? []);
    const unused = available.filter((r) => !usedSlugs.has(r.slug));
    const pick = unused[0] ?? available[0];

    if (pick) {
      addBatchFromGap(state, gap, pick.slug, pick.name);
      log.debug('PLAN-FLOW', `gap resolved with existing recipe: ${pick.slug}`);
    } else {
      log.warn('PLAN-FLOW', `no recipes available for gap, leaving unresolved`);
    }

    return advanceGapOrPresent(state, recipes);
  }

  if (action === 'idea') {
    state.phase = 'awaiting_recipe_prefs';
    log.debug('PLAN-FLOW', 'phase → awaiting_recipe_prefs');
    return {
      text: 'Describe what you have in mind — cuisine, protein, style, or anything specific.',
      state,
    };
  }

  // action === 'generate' — use the system's suggestion as preferences
  return generateGapRecipe(state, gap.suggestion, llm);
}

/**
 * User provided preferences for a gap recipe. Generate it.
 */
export async function handleGapRecipePrefs(
  state: PlanFlowState,
  prefs: string,
  llm: LLMProvider,
): Promise<FlowResponse> {
  const gap = state.pendingGaps?.[state.activeGapIndex ?? 0];
  if (!gap) {
    state.phase = 'proposal';
    return { text: formatPlanProposal(state), state };
  }
  return generateGapRecipe(state, prefs, llm);
}

/**
 * User reviewed the generated gap recipe.
 *
 * @param action - 'use' (save and use in plan) or 'different' (regenerate)
 */
export async function handleGapRecipeReview(
  state: PlanFlowState,
  action: 'use' | 'different',
  recipes: RecipeDatabase,
  llm: LLMProvider,
): Promise<FlowResponse> {
  if (action === 'use' && state.currentRecipe) {
    // Save recipe to DB and add to proposal
    await recipes.save(state.currentRecipe);
    const gap = state.pendingGaps?.[state.activeGapIndex ?? 0];
    if (gap) {
      addBatchFromGap(state, gap, state.currentRecipe.slug, state.currentRecipe.name);
    }
    log.debug('PLAN-FLOW', `gap recipe saved: ${state.currentRecipe.slug}`);
    state.currentRecipe = undefined;
    state.recipeGenMessages = undefined;

    return advanceGapOrPresent(state, recipes);
  }

  // action === 'different' — regenerate with the same hint
  const gap = state.pendingGaps?.[state.activeGapIndex ?? 0];
  if (!gap) {
    state.phase = 'proposal';
    return { text: formatPlanProposal(state), state };
  }
  return generateGapRecipe(state, gap.suggestion, llm);
}

/**
 * User typed a refinement request while reviewing a gap recipe.
 * Uses multi-turn conversation to refine the recipe without regenerating from scratch.
 * (e.g., "swap avocado oil with olive oil", "use normal green peas instead")
 */
export async function handleGapRecipeRefinement(
  state: PlanFlowState,
  feedback: string,
  llm: LLMProvider,
): Promise<FlowResponse> {
  if (!state.recipeGenMessages || !state.currentRecipe) {
    return { text: 'No recipe to refine. Something went wrong.', state };
  }

  log.debug('PLAN-FLOW', `refining gap recipe: "${feedback}"`);

  const { refineRecipe } = await import('./recipe-generator.js');

  const refined = await refineRecipe(state.recipeGenMessages, feedback, llm);

  // Quick macro validation — use the same target as the standalone recipe flow
  const gapMealType = state.pendingGaps?.[state.activeGapIndex ?? 0]?.mealType ?? 'lunch';
  const targets = targetsForMealType(gapMealType);
  const corrected = await validateAndCorrectRecipe(refined, targets, llm);

  state.currentRecipe = corrected.recipe;
  state.recipeGenMessages = corrected.messages;
  state.phase = 'reviewing_recipe';

  const { renderRecipe } = await import('../recipes/renderer.js');
  const rendered = renderRecipe(corrected.recipe);

  return {
    text: `Updated:\n\n${rendered}\n\nUse this recipe in the plan?`,
    state,
  };
}

/**
 * User approved the plan proposal. Build PlanSession + Batches and persist.
 */
export async function handleApprove(
  state: PlanFlowState,
  store: StateStoreLike,
  recipes: RecipeDatabase,
  llm: LLMProvider,
): Promise<FlowResponse> {
  if (!state.proposal?.solverOutput) {
    return { text: 'No plan to approve. Something went wrong.', state };
  }

  // Plan 007: persist as PlanSession + Batch[] (rolling model)
  const { session, batches } = await buildNewPlanSession(state, recipes, llm);
  if (state.replacingSessionId) {
    await store.confirmPlanSessionReplacing(session, batches, state.replacingSessionId);
    log.info('PLAN-FLOW', `plan confirmed (replacing ${state.replacingSessionId}): session ${session.id} for ${session.horizonStart}`);
  } else {
    await store.confirmPlanSession(session, batches);
    log.info('PLAN-FLOW', `plan confirmed: session ${session.id} for ${session.horizonStart}`);
  }

  state.phase = 'confirmed';

  return {
    text: `Plan locked for ${formatDayShort(state.weekStart)} – ${formatDayShort(state.weekDays[6]!)}. Shopping list ready.`,
    state,
  };
}

/**
 * User wants to swap something. Set phase to collect swap description.
 */
export function handleSwapRequest(state: PlanFlowState): FlowResponse {
  state.phase = 'awaiting_swap';
  log.debug('PLAN-FLOW', 'phase → awaiting_swap');
  return {
    text: 'What would you like to change? (e.g., "different lunch for Thu-Sat", "swap the beef for fish", "add a flex meal on Friday")',
    state,
  };
}

/**
 * Process a swap request from free-form text.
 * Classifies the intent, modifies the proposal, re-runs the solver, re-presents.
 */
export async function handleSwapText(
  state: PlanFlowState,
  text: string,
  llm: LLMProvider,
  recipes: RecipeDatabase,
  store: StateStoreLike,
): Promise<FlowResponse> {
  if (!state.proposal) {
    return { text: 'No plan to swap. Something went wrong.', state };
  }

  log.debug('PLAN-FLOW', `swap request: "${text}"`);

  // Classify the swap intent
  const intent = await classifySwapIntent(text, state, llm);
  log.debug('PLAN-FLOW', `swap intent: ${intent.type}`);

  switch (intent.type) {
    case 'flex_add': {
      // Enforce config.planning.flexSlotsPerWeek. If already at max, treat this
      // as a MOVE: drop existing flex slots (restoring their meal prep days)
      // before adding the new one.
      // Plan 009: same deferred orphan resolution — pool freed days with orphans.
      if (state.proposal.flexSlots.length >= config.planning.flexSlotsPerWeek) {
        log.debug('PLAN-FLOW', `flex_add at capacity (${state.proposal.flexSlots.length}/${config.planning.flexSlotsPerWeek}) — treating as move`);

        // 1. Snapshot for rollback
        const snapshot = {
          proposal: JSON.parse(JSON.stringify(state.proposal)) as PlanProposal,
          pendingGaps: state.pendingGaps ? JSON.parse(JSON.stringify(state.pendingGaps)) as RecipeGap[] : undefined,
          activeGapIndex: state.activeGapIndex,
          phase: state.phase,
        };

        // 2. Capture dissolved recipe from the batch at the target position
        const dissolvedBatch = findBatchForDay(state.proposal, intent.day, intent.mealTime);
        const dissolvedRecipe = dissolvedBatch
          ? { slug: dissolvedBatch.recipeSlug, name: dissolvedBatch.recipeName }
          : undefined;

        // 3. Collect freed flex days (same meal type pooled, cross-type independent)
        const existingFlexes = [...state.proposal.flexSlots];
        state.proposal.flexSlots = [];

        const pooledFreedDays: string[] = [];
        const horizonEnd = state.horizonDays?.[6];
        for (const existing of existingFlexes) {
          if (existing.mealTime === intent.mealTime) {
            const isOverflow = horizonEnd ? existing.day > horizonEnd : false;
            if (!isOverflow) {
              pooledFreedDays.push(existing.day);
            }
            // overflow freed days are edge-case — absorb individually
            if (isOverflow && !absorbFreedDay(state, existing.day, existing.mealTime)) {
              state.proposal = snapshot.proposal;
              state.pendingGaps = snapshot.pendingGaps;
              state.activeGapIndex = snapshot.activeGapIndex;
              state.phase = snapshot.phase;
              return {
                text: "Can't place flex there — it would strand next week's meals with no home. Try a different day.",
                state,
              };
            }
          } else {
            absorbFreedDay(state, existing.day, existing.mealTime);
          }
        }

        // 4. Add new flex and carve
        state.proposal.flexSlots.push({
          day: intent.day,
          mealTime: intent.mealTime,
          flexBonus: 350,
          note: 'flex meal',
        });
        const { orphanDays, overflowOrphanDays } = removeBatchDay(
          state.proposal, intent.day, intent.mealTime, horizonEnd,
        );

        // 5. Pool freed days with carved orphans
        const allOrphans = [...orphanDays, ...pooledFreedDays];
        const allOverflowOrphans = [...overflowOrphanDays];

        // 6. Resolve pool
        const resolved = resolveOrphanPool(
          state, allOrphans, allOverflowOrphans, intent.mealTime, dissolvedRecipe,
        );
        if (!resolved) {
          state.proposal = snapshot.proposal;
          state.pendingGaps = snapshot.pendingGaps;
          state.activeGapIndex = snapshot.activeGapIndex;
          state.phase = snapshot.phase;
          return {
            text: "Can't place flex there — it would strand next week's meals with no home. Try a different day.",
            state,
          };
        }
        break;
      }

      // Not at capacity — simple add
      state.proposal.flexSlots.push({
        day: intent.day,
        mealTime: intent.mealTime,
        flexBonus: 350,
        note: 'flex meal',
      });

      // Remove the new flex day from any existing batch; handle any orphan days.
      {
        const horizonEnd = state.horizonDays?.[6];
        const dissolvedBatch = findBatchForDay(state.proposal, intent.day, intent.mealTime);
        const dissolvedRecipe = dissolvedBatch
          ? { slug: dissolvedBatch.recipeSlug, name: dissolvedBatch.recipeName }
          : undefined;
        const { orphanDays, overflowOrphanDays } = removeBatchDay(state.proposal, intent.day, intent.mealTime, horizonEnd);
        // Even for simple add, use deferred resolution to merge contiguous orphans
        const resolved = resolveOrphanPool(
          state, orphanDays, overflowOrphanDays, intent.mealTime, dissolvedRecipe,
        );
        if (!resolved) {
          return {
            text: "Can't place flex there — it would strand next week's meals with no home. Try a different day.",
            state,
          };
        }
      }
      break;
    }
    case 'flex_move': {
      // Plan 009: Deferred orphan resolution with contiguous merging.
      // Snapshot mutation-relevant state for rollback on failure, capture the
      // dissolved recipe, pool freed days with orphans, resolve together.
      const fromDay = intent.fromDay ?? state.proposal.flexSlots[0]?.day;
      const fromMealTime = intent.fromMealTime ?? state.proposal.flexSlots[0]?.mealTime;

      // 1. Snapshot for rollback (deep copy mutation-relevant state)
      const snapshot = {
        proposal: JSON.parse(JSON.stringify(state.proposal)) as PlanProposal,
        pendingGaps: state.pendingGaps ? JSON.parse(JSON.stringify(state.pendingGaps)) as RecipeGap[] : undefined,
        activeGapIndex: state.activeGapIndex,
        phase: state.phase,
      };

      // 2. Capture dissolved recipe from the batch at the "to" position
      const dissolvedBatch = findBatchForDay(state.proposal, intent.toDay, intent.toMealTime);
      const dissolvedRecipe = dissolvedBatch
        ? { slug: dissolvedBatch.recipeSlug, name: dissolvedBatch.recipeName }
        : undefined;

      // 3. Remove "from" flex
      if (fromDay && fromMealTime) {
        state.proposal.flexSlots = state.proposal.flexSlots.filter(
          (f) => !(f.day === fromDay && f.mealTime === fromMealTime),
        );
      }

      // 4. Add "to" flex and carve the batch
      state.proposal.flexSlots.push({
        day: intent.toDay,
        mealTime: intent.toMealTime,
        flexBonus: 350,
        note: 'flex meal',
      });
      const horizonEnd = state.horizonDays?.[6];
      const { orphanDays, overflowOrphanDays } = removeBatchDay(
        state.proposal, intent.toDay, intent.toMealTime, horizonEnd,
      );

      // 5. Pool freed fromDay with orphans if same meal type
      const allOrphans = [...orphanDays];
      const allOverflowOrphans = [...overflowOrphanDays];
      if (fromDay && fromMealTime) {
        if (fromMealTime === intent.toMealTime) {
          // Same meal type — pool the freed day with carved orphans
          const isFromOverflow = horizonEnd ? fromDay > horizonEnd : false;
          if (isFromOverflow) {
            allOverflowOrphans.push(fromDay);
          } else {
            allOrphans.push(fromDay);
          }
        } else {
          // Cross-meal-type — resolve fromDay independently
          absorbFreedDay(state, fromDay, fromMealTime);
        }
      }

      // 6. Resolve pool — contiguous runs merge, singletons get carry-over or gap
      const resolved = resolveOrphanPool(
        state, allOrphans, allOverflowOrphans, intent.toMealTime, dissolvedRecipe,
      );

      if (!resolved) {
        // Rollback: restore full mutation-relevant state from snapshot
        state.proposal = snapshot.proposal;
        state.pendingGaps = snapshot.pendingGaps;
        state.activeGapIndex = snapshot.activeGapIndex;
        state.phase = snapshot.phase;
        return {
          text: "Can't move flex there — it would strand next week's meals with no home. Try a different day.",
          state,
        };
      }
      break;
    }
    case 'flex_remove': {
      state.proposal.flexSlots = state.proposal.flexSlots.filter(
        (f) => !(f.day === intent.day && f.mealTime === intent.mealTime),
      );
      // The flex slot was replacing a meal-prep slot. Now that it's removed,
      // we need to assign a recipe for that day. Try to extend an adjacent batch
      // of the same meal type, or create a recipe gap.
      const restored = restoreMealSlot(state.proposal, intent.day, intent.mealTime);
      if (!restored) {
        // No adjacent batch can absorb it — create a gap
        const gap: RecipeGap = {
          mealType: intent.mealTime,
          days: [intent.day],
          servings: 1,
          suggestion: 'any recipe that fits',
          reason: `Flex slot removed on ${formatDayShort(intent.day)} — need a recipe for this meal.`,
        };
        state.proposal.recipesToGenerate.push(gap);
        state.pendingGaps = [gap];
        state.activeGapIndex = 0;
        return presentRecipeGap(state);
      }
      break;
    }
    case 'recipe_swap': {
      // Find matching batch and try to swap it
      const swapped = await handleRecipeSwap(state, intent, llm, recipes, store);
      if (swapped) return swapped;
      break;
    }
    case 'unclear':
      return {
        text: "I'm not sure what to change. Try something like:\n- \"swap lunch Mon-Wed for something with fish\"\n- \"add a flex dinner on Friday\"\n- \"remove the flex meal\"",
        state,
      };
  }

  // Surface any recipe gaps created by the mutation. Mirrors the initial
  // proposal path at line 393-398: if absorbFreedDay or a recipe_swap pushed
  // gaps into recipesToGenerate, route through the gap-resolution sub-flow
  // instead of silently showing a plan with uncovered slots. flex_remove and
  // recipe_swap already handle this themselves; flex_move and flex_add reach
  // this tail and rely on this conditional.
  if (state.proposal.recipesToGenerate.length > 0) {
    state.pendingGaps = [...state.proposal.recipesToGenerate];
    state.activeGapIndex = 0;
    return presentRecipeGap(state);
  }

  // Re-run solver with updated proposal
  const solverInput = buildSolverInput(state, state.proposal, recipes);
  const solverOutput = solve(solverInput);
  state.proposal.solverOutput = solverOutput;

  state.phase = 'proposal';
  return {
    text: formatPlanProposal(state),
    state,
  };
}

// ─── Internal helpers ───────────────────────────────────────────────────────────

/** Generate a recipe for a gap using the recipe-generator sub-agent. */
async function generateGapRecipe(
  state: PlanFlowState,
  preferences: string,
  llm: LLMProvider,
): Promise<FlowResponse> {
  const gap = state.pendingGaps?.[state.activeGapIndex ?? 0];
  if (!gap) {
    state.phase = 'proposal';
    return { text: formatPlanProposal(state), state };
  }

  state.phase = 'generating_recipe';
  log.debug('PLAN-FLOW', `generating gap recipe: ${preferences}`);

  const targets = targetsForMealType(gap.mealType);

  const genResult = await generateRecipe({
    mealType: gap.mealType,
    targets,
    preferences,
  }, llm);

  // Quick macro validation + correction
  const corrected = await validateAndCorrectRecipe(genResult, targets, llm);

  state.currentRecipe = corrected.recipe;
  state.recipeGenMessages = corrected.messages;
  state.phase = 'reviewing_recipe';

  const { renderRecipe } = await import('../recipes/renderer.js');
  const rendered = renderRecipe(corrected.recipe);

  return {
    text: `Here's what I came up with:\n\n${rendered}\n\nUse this recipe in the plan?`,
    state,
  };
}

/** Validate a generated recipe and correct macros if needed. */
async function validateAndCorrectRecipe(
  result: GenerateResult,
  targets: { calories: number; protein: number; fat: number; carbs: number },
  llm: LLMProvider,
): Promise<GenerateResult> {
  const MAX_CORRECTIONS = 2;
  let current = result;

  for (let i = 0; i < MAX_CORRECTIONS; i++) {
    const calDelta = current.recipe.perServing.calories - targets.calories;
    const calDevPct = Math.abs(calDelta) / targets.calories;
    const protDelta = current.recipe.perServing.protein - targets.protein;
    const protDevPct = Math.abs(protDelta) / targets.protein;

    if (calDevPct <= 0.03 && protDevPct <= 0.05) break;

    const issues: string[] = [];
    if (calDevPct > 0.03) {
      issues.push(`Calories: ${current.recipe.perServing.calories} (target ${targets.calories}, ${calDelta > 0 ? 'over' : 'under'} by ${Math.abs(Math.round(calDelta))})`);
    }
    if (protDevPct > 0.05) {
      issues.push(`Protein: ${current.recipe.perServing.protein}g (target ${targets.protein}g, ${protDelta > 0 ? 'over' : 'under'} by ${Math.abs(Math.round(protDelta))}g)`);
    }

    log.debug('QA', `gap recipe correction ${i + 1}/${MAX_CORRECTIONS}: ${issues.join(', ')}`);
    log.addOperationEvent(`correction ${i + 1}/${MAX_CORRECTIONS}`);

    const correctionPrompt = `CORRECTIONS NEEDED:\n${issues.join('\n')}\n\nFix by adjusting ingredient amounts. Priority: fat first, carb side second, never reduce protein source. Respond with the full corrected recipe JSON.`;
    current = await correctRecipeMacros(current.messages, correctionPrompt, llm);
  }

  return current;
}

/** Present the next recipe gap to the user. */
function presentRecipeGap(state: PlanFlowState): FlowResponse {
  const gap = state.pendingGaps?.[state.activeGapIndex ?? 0];
  if (!gap) {
    state.phase = 'proposal';
    return { text: formatPlanProposal(state), state };
  }

  state.phase = 'recipe_suggestion';
  const dayRange = gap.days.map(formatDayShort).join('-');

  return {
    text: `${gap.reason}\n\nI'd suggest: ${gap.suggestion} for ${gap.mealType} ${dayRange} (${gap.servings} servings).\n\nWant me to generate one, or do you have something specific in mind?`,
    state,
  };
}

/** Advance to the next gap or present the plan if all gaps are resolved. */
function advanceGapOrPresent(state: PlanFlowState, recipeDb?: RecipeDatabase): FlowResponse {
  const nextIndex = (state.activeGapIndex ?? 0) + 1;
  if (state.pendingGaps && nextIndex < state.pendingGaps.length) {
    state.activeGapIndex = nextIndex;
    return presentRecipeGap(state);
  }

  // All gaps resolved — re-run solver and present
  if (state.proposal) {
    const solverInput = buildSolverInput(state, state.proposal, recipeDb);
    const solverOutput = solve(solverInput);
    state.proposal.solverOutput = solverOutput;
  }

  state.phase = 'proposal';
  state.pendingGaps = undefined;
  state.activeGapIndex = undefined;
  return { text: formatPlanProposal(state), state };
}

/** Add a batch to the proposal from a resolved recipe gap.
 * Removes any existing batch that covers the same (days, mealType) to prevent
 * ghost duplicates when the gap was also included as a placeholder batch.
 */
function addBatchFromGap(
  state: PlanFlowState,
  gap: RecipeGap,
  recipeSlug: string,
  recipeName: string,
): void {
  if (!state.proposal) return;

  // Remove any existing batch that covers the same days and mealType (prevents duplicates)
  const gapDaySet = new Set(gap.days);
  state.proposal.batches = state.proposal.batches.filter((b) => {
    if (b.mealType !== gap.mealType) return true;
    const overlap = b.days.some((d) => gapDaySet.has(d));
    return !overlap;
  });

  state.proposal.batches.push({
    recipeSlug,
    recipeName,
    mealType: gap.mealType,
    days: gap.days,
    servings: gap.servings,
  });
  // Remove the gap from recipesToGenerate
  state.proposal.recipesToGenerate = state.proposal.recipesToGenerate.filter((g) => g !== gap);
}

// ─── Plan 009: deferred orphan resolution helpers ────────────────────────────

/**
 * Find the batch that covers a given day and meal type.
 * Used to capture the dissolved recipe BEFORE any mutation so we can reuse it
 * when re-batching orphans. Returns undefined if no batch covers that day.
 */
function findBatchForDay(
  proposal: PlanProposal,
  day: string,
  mealType: 'lunch' | 'dinner',
): ProposedBatch | undefined {
  return proposal.batches.find(
    (b) => b.mealType === mealType && b.days.includes(day),
  );
}

/**
 * Resolve a single orphan day. Tries in order:
 * 1. Extend an adjacent batch (restoreMealSlot)
 * 2. If within 2 days of horizonEnd AND dissolved recipe available:
 *    create a carry-over batch directly (silent — no gap surfaced).
 *    This matches the proposer's cross-horizon behavior (Plan 007).
 * 3. Otherwise: create a standard recipe gap.
 *
 * Returns false ONLY if the day is past horizonEnd and cannot be absorbed
 * (overflow orphan with no adjacent batch → caller must reject the mutation).
 */
function resolveSingletonOrphan(
  state: PlanFlowState,
  day: string,
  mealType: 'lunch' | 'dinner',
  dissolvedRecipe: { slug: string; name: string } | undefined,
): boolean {
  const horizonEnd = state.horizonDays?.[6];
  const isOverflow = horizonEnd ? day > horizonEnd : false;

  // 1. Try extending an adjacent batch
  const restored = restoreMealSlot(state.proposal!, day, mealType, horizonEnd);
  if (restored) return true;

  // Overflow orphan — can't create a gap for a day the user can't see.
  if (isOverflow) return false;

  // 2. Near horizon edge with dissolved recipe → silent carry-over batch
  if (horizonEnd && dissolvedRecipe) {
    const dayDate = new Date(day + 'T00:00:00');
    const endDate = new Date(horizonEnd + 'T00:00:00');
    const diffMs = endDate.getTime() - dayDate.getTime();
    const daysToEnd = Math.round(diffMs / (24 * 60 * 60 * 1000));

    // Within 2 days of horizon end: cook day is in-horizon, overflow days
    // extend past the end. Create batch directly — same as proposer carry-over.
    if (daysToEnd >= 0 && daysToEnd <= 2) {
      const overflowDays: string[] = [];
      const nextDate = new Date(dayDate);
      for (let i = 1; i <= 2 - daysToEnd; i++) {
        nextDate.setDate(nextDate.getDate() + 1);
        overflowDays.push(toLocalISODate(nextDate));
      }
      if (overflowDays.length > 0) {
        state.proposal!.batches.push({
          recipeSlug: dissolvedRecipe.slug,
          recipeName: dissolvedRecipe.name,
          mealType,
          days: [day],
          servings: 1 + overflowDays.length,
          overflowDays,
        });
        return true;
      }
    }
  }

  // 3. Standard in-horizon gap
  const gap: RecipeGap = {
    mealType,
    days: [day],
    servings: 1,
    suggestion: 'any recipe that fits this slot',
    reason: `${mealType} on ${formatDayShort(day)} needs a recipe after a flex slot change.`,
  };
  state.proposal!.recipesToGenerate.push(gap);
  if (!state.pendingGaps) state.pendingGaps = [];
  state.pendingGaps.push(gap);
  return true;
}

/**
 * Pool orphan days and resolve them together instead of individually.
 *
 * Plan 009: contiguous orphans (e.g., Fri+Sat freed from a dissolved 3-day batch)
 * should merge into a multi-serving batch reusing the dissolved recipe — not
 * become separate 1-serving gaps. This is the core fix for the re-batching bug.
 *
 * Algorithm:
 * 1. Sort in-horizon orphans, group into contiguous runs
 * 2. Runs >= 2 days: create batch directly with dissolved recipe (no gap/prompt)
 * 3. Singletons: delegate to resolveSingletonOrphan()
 * 4. Overflow orphans: try absorb individually (reject mutation on failure)
 *
 * Returns false if any overflow orphan is unabsorbable (caller must rollback).
 */
function resolveOrphanPool(
  state: PlanFlowState,
  orphanDays: string[],
  overflowOrphanDays: string[],
  mealType: 'lunch' | 'dinner',
  dissolvedRecipe: { slug: string; name: string } | undefined,
): boolean {
  // Group in-horizon orphans into contiguous runs
  const runs = splitIntoContiguousRuns(orphanDays);

  for (const run of runs) {
    if (run.length >= 2 && dissolvedRecipe) {
      // Multi-day contiguous run: create batch directly with dissolved recipe
      const horizonEnd = state.horizonDays?.[6];
      let overflowDays: string[] | undefined;

      // Check if the last day of the run is near horizon end — extend with overflow
      if (horizonEnd) {
        const lastRunDay = new Date(run[run.length - 1]! + 'T00:00:00');
        const endDate = new Date(horizonEnd + 'T00:00:00');
        const daysToEnd = Math.round(
          (endDate.getTime() - lastRunDay.getTime()) / (24 * 60 * 60 * 1000),
        );
        // If the run ends at or near horizon edge, extend with overflow days
        // but respect the 3-serving cap
        if (daysToEnd >= 0 && daysToEnd <= 1) {
          const maxOverflow = 3 - run.length;
          if (maxOverflow > 0) {
            overflowDays = [];
            const nextDate = new Date(lastRunDay);
            for (let i = 0; i < Math.min(maxOverflow, 1 + (1 - daysToEnd)); i++) {
              nextDate.setDate(nextDate.getDate() + 1);
              const overflowDay = toLocalISODate(nextDate);
              if (overflowDay > horizonEnd) {
                overflowDays.push(overflowDay);
              }
            }
            if (overflowDays.length === 0) overflowDays = undefined;
          }
        }
      }

      state.proposal!.batches.push({
        recipeSlug: dissolvedRecipe.slug,
        recipeName: dissolvedRecipe.name,
        mealType,
        days: run,
        servings: run.length + (overflowDays?.length ?? 0),
        overflowDays,
      });
    } else {
      // Singleton (or multi-day without dissolved recipe): resolve individually
      for (const day of run) {
        if (!resolveSingletonOrphan(state, day, mealType, dissolvedRecipe)) {
          return false; // shouldn't happen for in-horizon days, but be safe
        }
      }
    }
  }

  // Overflow orphans: try to absorb individually
  for (const day of overflowOrphanDays) {
    if (!absorbFreedDay(state, day, mealType)) {
      return false;
    }
  }

  return true;
}

/**
 * Absorb a freed day (orphan from a batch split, or a day where a flex was just
 * removed) back into the plan. First tries to extend an adjacent batch, then
 * falls back to creating a recipe gap for in-horizon days.
 *
 * Plan 007: overflow orphans (past horizonEnd) are absorb-only — if no adjacent
 * batch can take them, the mutation should be rejected by the caller (D30).
 * In-horizon orphans fall back to gap-surfacing as before.
 *
 * Returns true if absorbed, false if an overflow orphan couldn't be absorbed
 * (caller should reject the mutation).
 */
function absorbFreedDay(
  state: PlanFlowState,
  day: string,
  mealTime: 'lunch' | 'dinner',
): boolean {
  const horizonEnd = state.horizonDays?.[6];
  const isOverflow = horizonEnd ? day > horizonEnd : false;

  const restored = restoreMealSlot(state.proposal!, day, mealTime, horizonEnd);
  if (restored) return true;

  if (isOverflow) {
    // Overflow orphan — can't create a gap for a day the user can't see.
    // Caller must reject the mutation.
    return false;
  }

  // In-horizon orphan — create a recipe gap.
  const gap: RecipeGap = {
    mealType: mealTime,
    days: [day],
    servings: 1,
    suggestion: 'any recipe that fits this slot',
    reason: `${mealTime} on ${formatDayShort(day)} needs a recipe after a flex slot change.`,
  };
  state.proposal!.recipesToGenerate.push(gap);
  if (!state.pendingGaps) state.pendingGaps = [];
  state.pendingGaps.push(gap);
  return true;
}

/**
 * Try to restore a meal-prep slot by extending an adjacent batch.
 * Returns true if successful, false if a recipe gap is needed instead.
 *
 * Plan 007: if the day is past the horizon end, it goes into overflowDays
 * instead of days. The total serving count (days + overflowDays) must not
 * exceed 3. Forward extension past horizonEnd is allowed; backward extension
 * into a prior horizon is not (D27).
 */
function restoreMealSlot(
  proposal: PlanProposal,
  day: string,
  mealTime: 'lunch' | 'dinner',
  horizonEnd?: string,
): boolean {
  const dayDate = new Date(day + 'T00:00:00');
  const prevDay = new Date(dayDate);
  prevDay.setDate(dayDate.getDate() - 1);
  const nextDay = new Date(dayDate);
  nextDay.setDate(dayDate.getDate() + 1);

  const prevStr = toLocalISODate(prevDay);
  const nextStr = toLocalISODate(nextDay);
  const isOverflow = horizonEnd ? day > horizonEnd : false;

  for (const batch of proposal.batches) {
    if (batch.mealType !== mealTime) continue;
    // Total servings = in-horizon days + overflow days
    const totalServings = batch.days.length + (batch.overflowDays?.length ?? 0);
    if (totalServings >= 3) continue; // don't exceed 3-serving max

    // Check all days including overflow for adjacency
    const allDays = [...batch.days, ...(batch.overflowDays ?? [])];
    const lastDay = allDays[allDays.length - 1];
    const firstDay = batch.days[0]; // backward extension uses in-horizon first day only

    // Can extend forward: batch ends the day before
    if (lastDay === prevStr) {
      if (isOverflow) {
        batch.overflowDays = [...(batch.overflowDays ?? []), day];
      } else {
        batch.days.push(day);
      }
      batch.servings = batch.days.length + (batch.overflowDays?.length ?? 0);
      return true;
    }
    // Can extend backward: batch starts the day after (in-horizon only)
    if (!isOverflow && firstDay === nextStr) {
      batch.days.unshift(day);
      batch.servings = batch.days.length + (batch.overflowDays?.length ?? 0);
      return true;
    }
  }

  return false;
}

/**
 * Remove a day from a batch when a flex slot replaces it.
 * If removing from the middle of a batch (e.g., Tue from Mon-Wed), splits it
 * into two contiguous batches (Mon and Wed) so the cooking schedule stays valid.
 *
 * Returns orphan days split into two classes (Plan 007 D30):
 * - orphanDays: in-horizon orphans (absorb-or-gap)
 * - overflowOrphanDays: past-horizon orphans (absorb-only, reject mutation on failure)
 *
 * Also detects the D30 violation case: if removing a day would leave a batch
 * with zero in-horizon days but non-empty overflow, the batch is dropped entirely
 * and ALL its days become orphans.
 */
function removeBatchDay(
  proposal: PlanProposal,
  day: string,
  mealTime: 'lunch' | 'dinner',
  horizonEnd?: string,
): { orphanDays: string[]; overflowOrphanDays: string[] } {
  const newBatches: ProposedBatch[] = [];
  const orphanDays: string[] = [];
  const overflowOrphanDays: string[] = [];

  for (const batch of proposal.batches) {
    if (batch.mealType === mealTime && batch.days.includes(day)) {
      const remaining = batch.days.filter((d) => d !== day);
      const overflow = batch.overflowDays ?? [];

      if (remaining.length === 0 && overflow.length === 0) continue; // batch fully consumed

      // D30 violation: removing the last in-horizon day strands overflow days
      // with no cook day inside the horizon. Drop the entire batch.
      if (remaining.length === 0 && overflow.length > 0) {
        overflowOrphanDays.push(...overflow);
        continue;
      }

      // Split remaining in-horizon days into contiguous runs
      const runs = splitIntoContiguousRuns(remaining);
      // The first run gets the overflow days (it's closest to the horizon end)
      let overflowAssigned = false;
      for (const run of runs) {
        const totalWithOverflow = run.length + (!overflowAssigned ? overflow.length : 0);
        if (run.length < 2 && totalWithOverflow < 2) {
          orphanDays.push(...run);
          if (!overflowAssigned && overflow.length > 0) {
            overflowOrphanDays.push(...overflow);
            overflowAssigned = true;
          }
        } else {
          const batchOverflow = !overflowAssigned ? overflow : undefined;
          overflowAssigned = true;
          newBatches.push({
            ...batch,
            days: run,
            servings: run.length + (batchOverflow?.length ?? 0),
            overflowDays: batchOverflow && batchOverflow.length > 0 ? batchOverflow : undefined,
          });
        }
      }
      // If overflow was never assigned (all runs were orphans), it becomes overflow orphans
      if (!overflowAssigned && overflow.length > 0) {
        overflowOrphanDays.push(...overflow);
      }
    } else {
      newBatches.push(batch);
    }
  }

  proposal.batches = newBatches;
  return { orphanDays, overflowOrphanDays };
}

/**
 * Split an array of ISO date strings into groups of consecutive days.
 * E.g., ['2026-04-06', '2026-04-08'] → [['2026-04-06'], ['2026-04-08']]
 */
function splitIntoContiguousRuns(days: string[]): string[][] {
  if (days.length === 0) return [];
  const sorted = [...days].sort();
  const runs: string[][] = [[sorted[0]!]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1]! + 'T00:00:00');
    const curr = new Date(sorted[i]! + 'T00:00:00');
    const diffMs = curr.getTime() - prev.getTime();
    const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));

    if (diffDays === 1) {
      runs[runs.length - 1]!.push(sorted[i]!);
    } else {
      runs.push([sorted[i]!]);
    }
  }

  return runs;
}

/** Build solver input from the plan flow state and proposal, using real recipe macros. */
function buildSolverInput(
  state: PlanFlowState,
  proposal: PlanProposal,
  recipeDb?: RecipeDatabase,
  preCommittedSlots?: PreCommittedSlot[],
): SolverInput {
  return {
    weeklyTargets: config.targets.weekly,
    events: state.events,
    flexSlots: proposal.flexSlots,
    mealPrepPreferences: {
      recipes: proposal.batches.map((b) => {
        const recipe = recipeDb?.getBySlug(b.recipeSlug);
        return {
          recipeSlug: b.recipeSlug,
          mealType: b.mealType,
          days: b.days,
          servings: b.servings,
        };
      }),
    },
    breakfast: {
      locked: true,
      recipeSlug: state.breakfast.recipeSlug,
      caloriesPerDay: state.breakfast.caloriesPerDay,
      proteinPerDay: state.breakfast.proteinPerDay,
    },
    // Plan 007: explicit horizon days and carry-over
    horizonDays: state.horizonDays,
    carriedOverSlots: preCommittedSlots,
  };
}

/**
 * Materialize pre-committed slots from carried-over batches (Plan 007).
 *
 * Walks each batch's eatingDays, filters to those within the given horizon,
 * and emits one PreCommittedSlot per matching day.
 */
function materializeSlotsFromBatches(
  batches: NewBatch[],
  horizonDays: string[],
): PreCommittedSlot[] {
  const horizonSet = new Set(horizonDays);
  const slots: PreCommittedSlot[] = [];
  for (const batch of batches) {
    for (const day of batch.eatingDays) {
      if (horizonSet.has(day)) {
        slots.push({
          day,
          mealTime: batch.mealType,
          recipeSlug: batch.recipeSlug,
          calories: batch.actualPerServing.calories,
          protein: batch.actualPerServing.protein,
          sourceBatchId: batch.id,
        });
      }
    }
  }
  return slots;
}

/**
 * Build a DraftPlanSession + Batch[] from the confirmed proposal (Plan 007).
 *
 * Constructs the in-memory draft session and its batches, scales each recipe,
 * and asserts D30's invariant (eatingDays[0] inside the session's horizon)
 * on every batch before returning.
 */
async function buildNewPlanSession(
  state: PlanFlowState,
  recipeDb: RecipeDatabase,
  llm: LLMProvider,
): Promise<{ session: DraftPlanSession; batches: Array<Omit<NewBatch, 'createdAt' | 'updatedAt'>> }> {
  const proposal = state.proposal!;
  const solver = proposal.solverOutput!;
  const sessionId = uuid();
  const horizonStart = state.horizonStart ?? state.weekStart;
  const horizonEnd = state.horizonDays?.[6] ?? state.weekDays[6]!;

  const session: DraftPlanSession = {
    id: sessionId,
    horizonStart,
    horizonEnd,
    breakfast: {
      locked: true,
      recipeSlug: state.breakfast.recipeSlug,
      caloriesPerDay: state.breakfast.caloriesPerDay,
      proteinPerDay: state.breakfast.proteinPerDay,
    },
    treatBudgetCalories: solver.weeklyTotals.treatBudget,
    flexSlots: proposal.flexSlots,
    events: state.events,
  };

  const batches: Array<Omit<NewBatch, 'createdAt' | 'updatedAt'>> = [];

  for (const batchTarget of solver.batchTargets) {
    // Plan 009: include days[0] in predicate — after re-batching, the same
    // (recipeSlug, mealType) pair can appear in two batches. The first eating
    // day uniquely differentiates them.
    const proposedBatch = proposal.batches.find(
      (b) => b.recipeSlug === batchTarget.recipeSlug
        && b.mealType === batchTarget.mealType
        && b.days[0] === batchTarget.days[0],
    );
    const recipe = batchTarget.recipeSlug ? recipeDb.getBySlug(batchTarget.recipeSlug) : undefined;

    let actualPerServing = { calories: 0, protein: 0, fat: 0, carbs: 0 };
    let scaledIngredients: ScaledIngredient[] = [];

    if (recipe) {
      try {
        const scaled = await scaleRecipe({
          recipe,
          targetCalories: batchTarget.targetPerServing.calories,
          calorieTolerance: config.planning.scalerCalorieTolerance,
          targetProtein: batchTarget.targetPerServing.protein,
          servings: batchTarget.servings,
        }, llm);
        actualPerServing = scaled.actualPerServing;
        scaledIngredients = scaled.scaledIngredients;
      } catch (err) {
        log.warn('PLAN-FLOW', `scaler failed for ${recipe.slug}, using unscaled: ${err}`);
        actualPerServing = recipe.perServing;
        scaledIngredients = recipe.ingredients.map((ing) => ({
          name: ing.name,
          amount: ing.amount,
          unit: ing.unit,
          totalForBatch: ing.amount * batchTarget.servings,
        }));
      }
    }

    // Full eating days = in-horizon days + overflow days
    const overflowDays = proposedBatch?.overflowDays ?? [];
    const eatingDays = [...batchTarget.days, ...overflowDays];

    // D30 invariant: cook day (eatingDays[0]) must be inside the session's horizon
    if (eatingDays.length > 0) {
      const cookDay = eatingDays[0]!;
      if (cookDay < horizonStart || cookDay > horizonEnd) {
        throw new Error(
          `D30 invariant violation: batch ${batchTarget.recipeSlug} has cook day ${cookDay} outside horizon [${horizonStart}, ${horizonEnd}]`,
        );
      }
    }

    batches.push({
      id: batchTarget.id,
      recipeSlug: batchTarget.recipeSlug ?? '',
      mealType: batchTarget.mealType,
      eatingDays,
      servings: eatingDays.length,
      targetPerServing: batchTarget.targetPerServing,
      actualPerServing,
      scaledIngredients,
      status: 'planned',
      createdInPlanSessionId: sessionId,
    });
  }

  return { session, batches };
}

// ─── Swap classification ────────────────────────────────────────────────────────

type SwapIntent =
  | { type: 'flex_add'; day: string; mealTime: 'lunch' | 'dinner' }
  | { type: 'flex_remove'; day: string; mealTime: 'lunch' | 'dinner' }
  | {
      type: 'flex_move';
      toDay: string;
      toMealTime: 'lunch' | 'dinner';
      /** Optional — if omitted, the handler moves the only existing flex slot. */
      fromDay?: string;
      fromMealTime?: 'lunch' | 'dinner';
    }
  | { type: 'recipe_swap'; batchIndex: number; preference: string }
  | { type: 'unclear' };

async function classifySwapIntent(
  text: string,
  state: PlanFlowState,
  llm: LLMProvider,
): Promise<SwapIntent> {
  const batchDescriptions = (state.proposal?.batches ?? []).map((b, i) =>
    `${i}: ${b.mealType} ${b.days.map(formatDayShort).join('-')}: ${b.recipeName}`,
  ).join('\n');

  const flexDescriptions = (state.proposal?.flexSlots ?? []).map((f) =>
    `${f.mealTime} ${formatDayShort(f.day)}: flex meal`,
  ).join('\n');

  const result = await llm.complete({
    model: 'nano',
    json: true,
    context: 'swap-classification',
    messages: [
      {
        role: 'system',
        content: `Classify a plan swap request. The week is ${state.weekDays[0]} to ${state.weekDays[6]}.
Day names: ${state.weekDays.map((d) => `${formatDayShort(d)}=${d}`).join(', ')}.

Current batches:
${batchDescriptions}

Current flex slots:
${flexDescriptions || '(none)'}

Classify into ONE of:
- {"type":"flex_move","to_day":"ISO date","to_meal_time":"lunch|dinner","from_day":"ISO date|null","from_meal_time":"lunch|dinner|null"} — user wants to move an existing flex meal to a different day. Use this when the user says things like "put flex on Saturday instead" or "move flex to Fri" or "let's put the flex on Sunday". If "from" is clear from context use it, otherwise set from_day and from_meal_time to null (the only existing flex slot will be moved).
- {"type":"flex_add","day":"ISO date","meal_time":"lunch|dinner"} — user wants to ADD a flex meal (only when no flex slot currently exists, or when they explicitly want an additional one).
- {"type":"flex_remove","day":"ISO date","meal_time":"lunch|dinner"} — user wants to remove a flex meal and cook that day instead.
- {"type":"recipe_swap","batch_index":number,"preference":"string"} — user wants to change a specific meal prep recipe (batch_index from the list above).
- {"type":"unclear"} — can't determine intent.

CRITICAL: if a flex slot ALREADY exists in the plan and the user mentions putting flex on a different day, that is flex_move, NOT flex_add. flex_add is only for creating the first flex slot or adding an extra one.

Respond with JSON only.`,
      },
      { role: 'user', content: text },
    ],
    maxTokens: 100,
  });

  try {
    const parsed = JSON.parse(result.content);
    switch (parsed.type) {
      case 'flex_add':
        return { type: 'flex_add', day: parsed.day, mealTime: parsed.meal_time };
      case 'flex_remove':
        return { type: 'flex_remove', day: parsed.day, mealTime: parsed.meal_time };
      case 'flex_move':
        return {
          type: 'flex_move',
          toDay: parsed.to_day,
          toMealTime: parsed.to_meal_time,
          fromDay: parsed.from_day ?? undefined,
          fromMealTime: parsed.from_meal_time ?? undefined,
        };
      case 'recipe_swap':
        return { type: 'recipe_swap', batchIndex: parsed.batch_index, preference: parsed.preference };
      default:
        return { type: 'unclear' };
    }
  } catch {
    return { type: 'unclear' };
  }
}

/** Handle a recipe swap by picking a different recipe or regenerating the proposal for that batch. */
async function handleRecipeSwap(
  state: PlanFlowState,
  intent: { batchIndex: number; preference: string },
  llm: LLMProvider,
  recipes: RecipeDatabase,
  store: StateStoreLike,
): Promise<FlowResponse | null> {
  const batch = state.proposal?.batches[intent.batchIndex];
  if (!batch) return null;

  // Try to find a matching recipe from the DB
  const available = recipes.getByMealType(batch.mealType);
  const usedSlugs = new Set(state.proposal?.batches.map((b) => b.recipeSlug) ?? []);

  // Use nano to pick the best match from available recipes based on user preference
  const candidates = available
    .filter((r) => !usedSlugs.has(r.slug) || r.slug === batch.recipeSlug)
    .map((r) => `${r.slug}: ${r.name} (${r.cuisine}, ${r.tags.join(', ')})`);

  if (candidates.length > 0) {
    const pickResult = await llm.complete({
      model: 'nano',
      json: true,
      context: 'recipe-pick',
      messages: [
        {
          role: 'system',
          content: `Pick the best recipe matching the user's preference. Respond with JSON: {"slug":"the-slug"} or {"slug":"none"} if nothing fits.\n\nAvailable:\n${candidates.join('\n')}`,
        },
        { role: 'user', content: intent.preference },
      ],
      maxTokens: 50,
    });

    try {
      const picked = JSON.parse(pickResult.content);
      if (picked.slug && picked.slug !== 'none') {
        const recipe = recipes.getBySlug(picked.slug);
        if (recipe) {
          batch.recipeSlug = recipe.slug;
          batch.recipeName = recipe.name;
          log.debug('PLAN-FLOW', `swapped batch ${intent.batchIndex} to ${recipe.slug}`);
          return null; // caller will re-run solver and present
        }
      }
    } catch { /* fall through to gap creation */ }
  }

  // No matching recipe found — create a gap
  state.proposal!.recipesToGenerate.push({
    mealType: batch.mealType,
    days: batch.days,
    servings: batch.servings,
    suggestion: intent.preference,
    reason: `User requested: "${intent.preference}"`,
  });
  // Remove the old batch
  state.proposal!.batches.splice(intent.batchIndex, 1);
  state.pendingGaps = [...state.proposal!.recipesToGenerate];
  state.activeGapIndex = state.pendingGaps.length - 1;
  return presentRecipeGap(state);
}

// ─── Plan formatting ────────────────────────────────────────────────────────────

/**
 * Format the plan proposal for Telegram display.
 * Shows: breakfast, meal prep batches, events, flex budget, cooking schedule, weekly totals.
 */
function formatPlanProposal(state: PlanFlowState): string {
  const proposal = state.proposal!;
  const solver = proposal.solverOutput!;
  const preCommitted = state.preCommittedSlots ?? [];
  const parts: string[] = [];

  // Header
  parts.push(`Your week: ${formatDayShort(state.weekStart)} ${formatDateShort(state.weekStart)} – ${formatDayShort(state.weekDays[6]!)} ${formatDateShort(state.weekDays[6]!)}`);
  parts.push('');

  // Breakfast
  parts.push(`Breakfast (daily): ${state.breakfast.name} — ${state.breakfast.caloriesPerDay} cal`);
  parts.push('');

  // Pre-committed slots from prior plan sessions
  if (preCommitted.length > 0) {
    parts.push('From prior plan:');
    for (const slot of preCommitted) {
      parts.push(`  ${capitalize(slot.mealTime)} ${formatDayShort(slot.day)}: ${slot.recipeSlug} (${slot.calories} cal)`);
    }
    parts.push('');
  }

  // Meal prep batches — solver assigns uniform per-serving calories
  const batchCals = proposal.batches
    .map((b) => {
      const target = solver.batchTargets.find((bt) =>
        bt.mealType === b.mealType && bt.days.length === b.days.length &&
        bt.days[0] === b.days[0],
      );
      return target?.targetPerServing.calories;
    })
    .filter((c): c is number => c !== undefined);
  const allSameCal = batchCals.length > 0 && batchCals.every((c) => c === batchCals[0]);
  const uniformCal = allSameCal ? Math.round(batchCals[0]! / 10) * 10 : undefined;

  parts.push(uniformCal !== undefined ? `Meal prep (each ~${uniformCal} cal/serving):` : 'Meal prep:');
  for (const batch of proposal.batches) {
    const dayRange = batch.days.map(formatDayShort).join(batch.days.length === 2 ? '+' : '-');
    const overflowCount = batch.overflowDays?.length ?? 0;
    const overflowNote = overflowCount > 0 ? `, +${overflowCount} into next week` : '';
    if (uniformCal !== undefined) {
      parts.push(`  ${capitalize(batch.mealType)} ${dayRange}: ${batch.recipeName} (${batch.servings} servings${overflowNote})`);
    } else {
      const target = solver.batchTargets.find((bt) =>
        bt.mealType === batch.mealType && bt.days.length === batch.days.length &&
        bt.days[0] === batch.days[0],
      );
      const cal = target?.targetPerServing.calories ?? '?';
      parts.push(`  ${capitalize(batch.mealType)} ${dayRange}: ${batch.recipeName} (${batch.servings} servings, ~${cal} cal${overflowNote})`);
    }
  }
  parts.push('');

  // Events
  if (state.events.length > 0) {
    parts.push('Events:');
    for (const e of state.events) {
      parts.push(`  ${formatDayShort(e.day)} ${e.mealTime}: ${e.name} (~${e.estimatedCalories} cal)`);
    }
    parts.push('');
  }

  // Fun budget
  if (proposal.flexSlots.length > 0) {
    for (const flex of proposal.flexSlots) {
      const dayBreakdown = solver.dailyBreakdown.find((d) => d.day === flex.day);
      const slotData = flex.mealTime === 'lunch' ? dayBreakdown?.lunch : dayBreakdown?.dinner;
      const totalCal = slotData?.calories ?? flex.flexBonus;
      parts.push(`Flex meal: ${formatDayShort(flex.day)} ${flex.mealTime} (~${totalCal} cal — ${flex.note ?? 'eat something fun'})`);
    }
  }

  const treat = solver.weeklyTotals.treatBudget;
  if (treat > 0) {
    const occasions = Math.round(treat / 350);
    if (occasions >= 2) {
      parts.push(`Treats: ${occasions} this week (~${Math.round(treat / occasions)} cal each)`);
    } else {
      parts.push(`Treats: 1 this week (~${treat} cal)`);
    }
    parts.push(`  Spend whenever cravings hit — not assigned to specific days`);
  }
  parts.push('');

  // Cooking schedule — derived from batch.days[0] (cook day = first eating day)
  const cookDayMap = new Map<string, string[]>();
  for (const batch of proposal.batches) {
    if (batch.days.length === 0) continue;
    const cookDay = batch.days[0]!;
    const existing = cookDayMap.get(cookDay) ?? [];
    existing.push(batch.recipeName);
    cookDayMap.set(cookDay, existing);
  }
  const sortedCookDays = [...cookDayMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  parts.push('Cook:');
  for (const [day, names] of sortedCookDays) {
    parts.push(`  ${formatDayShort(day)}: ${names.join(' + ')}`);
  }
  parts.push('');

  // Weekly totals
  const proteinCheck = solver.weeklyTotals.protein >= config.targets.weekly.protein ? '✓' : '⚠️';
  parts.push(`Weekly: ${solver.weeklyTotals.calories.toLocaleString()} cal | ${solver.weeklyTotals.protein}g protein ${proteinCheck}`);

  if (solver.warnings.length > 0) {
    parts.push('');
    for (const w of solver.warnings) {
      parts.push(`⚠️ ${w}`);
    }
  }

  return parts.join('\n');
}

// ─── Formatting helpers ─────────────────────────────────────────────────────────

function formatDayShort(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short' });
}

function formatDateShort(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
