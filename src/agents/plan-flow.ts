/**
 * Plan week flow handler.
 *
 * Orchestrates the weekly planning session through Telegram. The flow is
 * suggestive-first: the system proposes a complete plan, the user approves
 * or tweaks. Target: 2-3 exchanges, under 2 minutes for a happy path.
 *
 * Flow phases:
 *   context → awaiting_events → generating_proposal → proposal → confirmed
 *
 * In the `proposal` phase, user text is routed through the re-proposer agent
 * (handleMutationText) which handles flex moves, recipe swaps, event changes,
 * and any other plan adjustments in a single LLM call.
 *
 * Meta intents (pattern-matched, any phase):
 *   "start over" → resets flow, restarts planning from scratch
 *   "cancel"     → clears flow, returns to main menu
 *
 * Follows the recipe-flow.ts pattern: exported state type, factory function,
 * and pure handler functions that return FlowResponse (text + updated state).
 *
 * Not responsible for: calorie math (solver does that), recipe generation
 * (recipe-generator sub-agent does that), plan validation (QA gate does that),
 * Telegram message sending (bot.ts does that).
 */

import type { LLMProvider } from '../ai/provider.js';
import type { MealEvent, ScaledIngredient, DraftPlanSession } from '../models/types.js';
import { scaleRecipe } from './recipe-scaler.js';
import type { PlanProposal, SolverInput, PreCommittedSlot } from '../solver/types.js';
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
import type { RecipeDatabase } from '../recipes/database.js';
import type { StateStoreLike } from '../state/store.js';
import { v4 as uuid } from 'uuid';
import { formatDayRange } from '../plan/helpers.js';
import { reProposePlan, type MutationRecord } from './plan-reproposer.js';
import { diffProposals } from './plan-diff.js';

// ─── Flow state ─────────────────────────────────────────────────────────────────

export type PlanFlowPhase =
  | 'context'               // Showing breakfast confirm + events question
  | 'awaiting_events'       // User adding events (text/voice loop)
  | 'generating_proposal'   // Loading state while plan generates
  | 'proposal'              // User reviewing plan (can send adjustments or approve)
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
  /** The formatted proposal text, stored for resume view reconstruction. */
  proposalText?: string;

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

  // ─── Plan 025: re-proposer mutation state ───

  /** Accumulated mutation history for this planning session. Clears on confirm. */
  mutationHistory?: MutationRecord[];
  /**
   * When the re-proposer returned a clarification, stores the context needed
   * to continue the conversation on the next user message.
   * Cleared when the clarification is resolved (next reProposePlan call).
   */
  pendingClarification?: {
    originalMessage: string;
    question: string;
  };
  /** When the re-proposer asked to generate a recipe, stores generation context. */
  pendingRecipeGeneration?: {
    description: string;
    mealType: 'lunch' | 'dinner';
  };
}

export interface FlowResponse {
  text: string;
  state: PlanFlowState;
  /** When set, the caller must forward this as `parse_mode` to the sink. */
  parseMode?: 'MarkdownV2';
  /** Set by handleApprove() — structured data for the post-confirmation UI. */
  postConfirmData?: {
    firstCookDay: string;
    cookBatches: import('../models/types.js').Batch[];
  };
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
 * 3. Historical/none → tomorrow (user plans today, shops today, cooks tomorrow)
 */
export async function computeNextHorizonStart(
  store: StateStoreLike,
): Promise<{
  start: string;
  replacingSession?: import('../models/types.js').PlanSession;
  runningSession?: import('../models/types.js').PlanSession;
}> {
  const today = toLocalISODate(new Date());
  const future = await store.getFuturePlanSessions(today);
  if (future.length > 0) {
    return { start: future[0]!.horizonStart, replacingSession: future[0]! };
  }

  const running = await store.getRunningPlanSession(today);
  if (running) {
    const nextDay = addDays(running.horizonEnd, 1);
    return { start: nextDay, runningSession: running };
  }

  await store.getLatestHistoricalPlanSession(today);
  // Plan starts tomorrow: user plans today, shops today, cooks tomorrow.
  // With upcoming plan visibility the plan is fully visible before it starts.
  return { start: addDays(today, 1) };
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

  // Plan 024: call proposer with recipeDb for validator fridge-life checks
  const proposerResult = await proposePlan(proposerInput, llm, recipes);

  // Plan 024: handle graceful abort on double validation failure
  if (proposerResult.type === 'failure') {
    log.error('PLAN', `proposer failed: ${proposerResult.errors.join('; ')}`);
    state.phase = 'context';
    return {
      text: "I couldn't build a complete plan — try adjusting your events or adding more recipes.",
      state,
    };
  }

  const { proposal, reasoning } = proposerResult;
  log.debug('PLAN', `proposer reasoning: ${reasoning}`);

  // Run solver on the proposal using real recipe macros
  const solverInput = buildSolverInput(state, proposal, recipes, preCommittedSlots);
  const solverOutput = solve(solverInput);
  proposal.solverOutput = solverOutput;

  // Validate solver output
  const validation = validatePlan(solverOutput, config.targets.weekly, preCommittedSlots);
  if (!validation.valid) {
    log.warn('QA', `plan validation warnings: ${validation.errors.join('; ')}`);
  }

  state.proposal = proposal;
  if (preCommittedSlots.length > 0) {
    state.preCommittedSlots = preCommittedSlots;
  }

  // Present the full plan
  state.phase = 'proposal';
  return {
    text: formatPlanProposal(state),
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

  // Plan 025: clear session-scoped mutation state
  state.mutationHistory = undefined;
  state.pendingClarification = undefined;
  state.pendingRecipeGeneration = undefined;

  // Find the first cook day among the freshly persisted batches
  const plannedBatches = batches.filter(b => b.status === 'planned');
  const cookDays = plannedBatches
    .filter(b => b.eatingDays.length > 0)
    .map(b => b.eatingDays[0]!)
    .sort();
  const firstCookDay = cookDays[0] ?? state.weekStart;
  const firstCookBatches = plannedBatches.filter(b => b.eatingDays[0] === firstCookDay);

  return {
    text: `Plan locked for ${formatDayShort(state.weekStart)} – ${formatDayShort(state.weekDays[6]!)}. Shopping list ready.`,
    state,
    postConfirmData: {
      firstCookDay,
      cookBatches: firstCookBatches,
    },
  };
}

/**
 * Process a plan adjustment from free-form text via the re-proposer agent.
 *
 * Plan 025: replaces all deterministic mutation handlers (flex_move, flex_add,
 * recipe_swap, event_remove, etc.) with a single LLM call. The re-proposer
 * receives the current plan + user message and returns a complete new proposal
 * or a clarification question.
 *
 * Also handles the recipe generation handshake: if the re-proposer previously
 * asked to generate a recipe and the user confirmed, generates it first, then
 * re-runs the re-proposer with the updated recipe DB.
 */
export async function handleMutationText(
  state: PlanFlowState,
  text: string,
  llm: LLMProvider,
  recipes: RecipeDatabase,
): Promise<FlowResponse> {
  if (!state.proposal) {
    return { text: 'No plan to adjust. Something went wrong.', state };
  }

  // 0. Recipe generation handshake — if a prior clarification asked to
  //    generate a recipe and the user confirmed, generate it first, then
  //    re-run the re-proposer with the updated DB.
  if (state.pendingRecipeGeneration) {
    const isAffirmative = /^(yes|yeah|sure|ok|create|do it|go ahead)/i.test(text.trim());
    if (isAffirmative) {
      const desc = state.pendingRecipeGeneration.description;
      const mealType = state.pendingRecipeGeneration.mealType;
      const originalRequest = state.pendingClarification?.originalMessage ?? desc;
      state.pendingRecipeGeneration = undefined;
      state.pendingClarification = undefined;

      // Generate + validate + persist the recipe
      const targets = targetsForMealType(mealType);
      const genResult = await generateRecipe({ mealType, targets, preferences: desc }, llm);
      const corrected = await validateAndCorrectRecipe(genResult, targets, llm);
      await recipes.save(corrected.recipe);
      log.debug('PLAN-FLOW', `recipe generated and saved: ${corrected.recipe.slug}`);

      // Re-run re-proposer with updated DB — the new recipe is now available
      return handleMutationText(state, originalRequest, llm, recipes);
    }

    // User declined — clear state, keep current plan
    state.pendingRecipeGeneration = undefined;
    state.pendingClarification = undefined;
    return { text: 'OK, keeping the current plan.', state };
  }

  // 1. Build the user message for the re-proposer.
  //    If there's a pending clarification, combine original request + answer.
  let userMessage: string;
  const priorClarification = state.pendingClarification;
  const mutationIntent = priorClarification
    ? priorClarification.originalMessage
    : text;

  if (priorClarification) {
    userMessage = [
      `Original request: ${priorClarification.originalMessage}`,
      `You asked: ${priorClarification.question}`,
      `User answered: ${text}`,
    ].join('\n');
    state.pendingClarification = undefined;
  } else {
    userMessage = text;
  }

  log.debug('PLAN-FLOW', `mutation request: "${userMessage.slice(0, 80)}"`);

  // 2. Call re-proposer
  const result = await reProposePlan({
    currentProposal: state.proposal,
    userMessage,
    mutationHistory: state.mutationHistory ?? [],
    availableRecipes: buildRecipeSummaries(recipes.getAll()),
    horizonDays: state.horizonDays ?? state.weekDays,
    preCommittedSlots: state.preCommittedSlots ?? [],
    breakfast: state.breakfast,
    weeklyTargets: config.targets.weekly,
    mode: 'in-session',
  }, llm, recipes);

  // 3. Handle clarification — store context, stay in proposal phase
  if (result.type === 'clarification') {
    state.pendingClarification = {
      originalMessage: priorClarification
        ? priorClarification.originalMessage
        : text,
      question: result.question,
    };
    if (result.recipeNeeded) {
      // Infer meal type: trust the LLM's field if present, otherwise guess
      // from which batches the user's message likely targets. If the message
      // mentions "lunch" → lunch; otherwise default to dinner (more common
      // for recipe swaps). This avoids generating with wrong-slot macros.
      let mealType: 'lunch' | 'dinner' = result.recipeMealType ?? 'dinner';
      if (!result.recipeMealType) {
        const msg = (priorClarification?.originalMessage ?? text).toLowerCase();
        if (msg.includes('lunch')) mealType = 'lunch';
      }
      state.pendingRecipeGeneration = {
        description: result.recipeNeeded,
        mealType,
      };
    }
    return { text: result.question, state };
  }

  // 4. Handle failure — keep prior plan, ask user to rephrase
  if (result.type === 'failure') {
    return { text: result.message, state };
  }

  // 5. New proposal — run solver
  const proposal = result.proposal;
  const solverInput = buildSolverInput(state, proposal, recipes, state.preCommittedSlots);
  const solverOutput = solve(solverInput);
  proposal.solverOutput = solverOutput;

  // 6. Generate change summary
  const summary = diffProposals(state.proposal, proposal);

  // 7. Update state — store new proposal and append to history
  state.proposal = proposal;
  state.events = [...proposal.events]; // sync state.events from proposal
  state.mutationHistory = [
    ...(state.mutationHistory ?? []),
    { constraint: mutationIntent, appliedAt: new Date().toISOString() },
  ];

  // 8. Present updated plan with change summary
  state.phase = 'proposal';
  return {
    text: `${summary}\n\n${formatPlanProposal(state)}`,
    state,
  };
}

// ─── Internal helpers ───────────────────────────────────────────────────────────

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

// Plan 025: gap resolution helpers (presentRecipeGap, advanceGapOrPresent, addBatchFromGap)
// and all deterministic mutation handlers (findBatchForDay, resolveSingletonOrphan,
// resolveOrphanPool, absorbFreedDay, removeBatchDay, splitIntoContiguousRuns)
// removed — replaced by reProposePlan() in plan-reproposer.ts.

/** Build solver input from the plan flow state and proposal, using real recipe macros. */
/** @internal Exported for regression testing (Plan 010). */
export function buildSolverInput(
  state: PlanFlowState,
  proposal: PlanProposal,
  recipeDb?: RecipeDatabase,
  preCommittedSlots?: PreCommittedSlot[],
): SolverInput {
  return {
    weeklyTargets: config.targets.weekly,
    events: proposal.events,  // Plan 024: proposal is single source of truth for events
    flexSlots: proposal.flexSlots,
    mealPrepPreferences: {
      recipes: proposal.batches.map((b) => {
        const recipe = recipeDb?.getBySlug(b.recipeSlug);
        return {
          recipeSlug: b.recipeSlug,
          mealType: b.mealType,
          days: b.days,
          servings: b.days.length,       // in-horizon eating occasions only (Plan 010)
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
    events: proposal.events,  // Plan 024: proposal is single source of truth for events
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

    // Plan 010: compute total eating days BEFORE scaling — the scaler needs the
    // total portion count (in-horizon + overflow) to produce enough food.
    const overflowDays = proposedBatch?.overflowDays ?? [];
    const eatingDays = [...batchTarget.days, ...overflowDays];

    let actualPerServing = { calories: 0, protein: 0, fat: 0, carbs: 0 };
    let scaledIngredients: ScaledIngredient[] = [];

    if (recipe) {
      try {
        const scaled = await scaleRecipe({
          recipe,
          targetCalories: batchTarget.targetPerServing.calories,
          calorieTolerance: config.planning.scalerCalorieTolerance,
          targetProtein: batchTarget.targetPerServing.protein,
          servings: eatingDays.length,           // Plan 010: total portions, not solver servings
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
          totalForBatch: ing.amount * eatingDays.length,  // Plan 010: total portions
          role: ing.role,
        }));
      }
    }

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

// ─── Planning meta intents (pattern-matched, no LLM) ──────────────────────────

/**
 * Classify a free-text message as a planning meta intent.
 *
 * "start_over" — user wants to restart the planning flow from scratch.
 * "cancel"     — user wants to exit planning entirely (back to main menu).
 * "none"       — not a meta intent; continue with phase-specific handling.
 *
 * Uses simple regex patterns — no LLM call needed.
 * Order matters: "cancel the plan" must match start_over before the bare
 * "cancel" matches the cancel intent.
 */
export type PlanningMetaIntent = 'start_over' | 'cancel' | 'none';

const START_OVER_PATTERNS: RegExp[] = [
  /\bstart\s*over\b/i,
  /\bstart\s*(from\s*)?scratch\b/i,
  /\bscrap\s*(this|the\s*plan)?\b/i,
  /\bre-?do\b/i,
  /\bre-?plan\b/i,
  /\bcancel\s+the\s+plan\b/i,
];

/**
 * Plan 028 precedence rule (Plan C): cancel phrases always win over the
 * dispatcher's `return_to_flow` action. The runner (`dispatcher-runner.ts`
 * `runDispatcherFrontDoor`) calls `matchPlanningMetaIntent` BEFORE invoking
 * the dispatcher when `session.planFlow` is active, so a "nevermind" typed
 * during planning reaches the cancel branch below — never the dispatcher.
 *
 * The phrase sets are disjoint: cancel phrases contain "never", "forget",
 * "later", "stop", or bare "cancel"; return_to_flow phrases contain "back",
 * "continue", "resume", "keep going", or "again". Any new phrase added to
 * either set must preserve this disjointness — see Plan 028 Task 12 for
 * the verification protocol.
 */
const CANCEL_PATTERNS: RegExp[] = [
  /\bnever\s*mind\b/i,
  /\bnevermind\b/i,
  /\bforget\s*it\b/i,
  /\bi'?ll\s*do\s*(this|it)\s*later\b/i,
  /\bnot\s*now\b/i,
  /\bstop\s*(planning)?\b/i,
  /^\s*cancel\s*$/i,
];

export function matchPlanningMetaIntent(text: string): PlanningMetaIntent {
  const trimmed = text.trim();
  for (const p of START_OVER_PATTERNS) {
    if (p.test(trimmed)) return 'start_over';
  }
  for (const p of CANCEL_PATTERNS) {
    if (p.test(trimmed)) return 'cancel';
  }
  return 'none';
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
    parts.push('Carried over:');
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
    const dayRange = formatDayRange(batch.days);
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

  // Events — Plan 024: read from proposal.events (single source of truth)
  if (proposal.events.length > 0) {
    parts.push('Events:');
    for (const e of proposal.events) {
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

  const text = parts.join('\n');
  state.proposalText = text;
  return text;
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
