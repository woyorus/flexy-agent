/**
 * State machine for conversation flows.
 *
 * This is the deterministic backbone of the agent harness. It defines which flow
 * is active, which step we're on, what transitions are valid, and what data is
 * required before moving forward. The state machine never hallucinates.
 *
 * The orchestrator LLM interprets user input within the context provided by this
 * state machine. Button taps bypass the LLM entirely — they map directly to
 * state machine transitions.
 *
 * Flow structure (from spec Section 7.1):
 *   idle → planning:breakfast → planning:events → planning:fun_foods
 *        → planning:recipes → planning:cooking_schedule → planning:review
 *        → plan_locked
 *
 * Additional flows: shopping_list, recipe_browse, recipe_add, budget_view.
 * These are simpler (no multi-step wizard) and map to single states.
 *
 * State machine controls:
 * - Flow progression (Step 0 → 1 → ... → 5 → locked)
 * - Valid transitions (can't skip to review before picking recipes)
 * - Required data gates (can't confirm plan until all batches have recipes)
 * - Guard rails (rejects actions that don't match current step)
 *
 * State machine does NOT control:
 * - What step comes next based on free-form input (orchestrator LLM does that)
 * - Calorie arithmetic (solver does that)
 * - Recipe generation (sub-agents do that)
 */

import type { FunFoodItem, MealEvent } from '../models/types.js';
import type { RecipeRequest } from '../solver/types.js';

// ─── Flow and Step definitions ───────────────────────────────────────────────

export type Flow =
  | 'idle'
  | 'first_run'
  | 'planning'
  | 'shopping_list'
  | 'recipe_browse'
  | 'recipe_add'
  | 'budget_view';

export type PlanningStep =
  | 'breakfast'       // Step 0: confirm or change breakfast
  | 'events'          // Step 1: add restaurant/social events
  | 'fun_foods'       // Step 2: choose fun foods
  | 'recipes'         // Step 3: select/approve recipes
  | 'cooking_schedule'// Step 4: confirm cooking days
  | 'review';         // Step 5: budget review and confirm

export type FirstRunStep =
  | 'welcome'
  | 'set_breakfast'
  | 'generate_recipes'
  | 'first_plan';

// ─── Session state ───────────────────────────────────────────────────────────

/**
 * The complete state of a user's current session.
 * Persisted across messages within a conversation.
 * Reset when a flow completes or the user cancels.
 */
export interface SessionState {
  flow: Flow;
  planningStep?: PlanningStep;
  firstRunStep?: FirstRunStep;

  /** Data accumulated during the planning flow. */
  planningData: PlanningData;

  /** ID of the active weekly plan being created/viewed. */
  activePlanId?: string;

  /** Week start date for the plan being created. */
  weekStart?: string;
}

/**
 * Data collected progressively during the planning flow.
 * Each step fills in its portion; later steps depend on earlier data.
 */
export interface PlanningData {
  breakfast?: {
    locked: boolean;
    recipeSlug?: string;
    caloriesPerDay: number;
    proteinPerDay: number;
  };
  events: MealEvent[];
  funFoods: FunFoodItem[];
  recipes: RecipeRequest[];
  cookingScheduleApproved: boolean;
}

// ─── State machine ───────────────────────────────────────────────────────────

/** Create a fresh session state (idle, no data). */
export function createInitialState(): SessionState {
  return {
    flow: 'idle',
    planningData: {
      events: [],
      funFoods: [],
      recipes: [],
      cookingScheduleApproved: false,
    },
  };
}

/** Valid planning step transitions (linear flow). */
const PLANNING_STEP_ORDER: PlanningStep[] = [
  'breakfast', 'events', 'fun_foods', 'recipes', 'cooking_schedule', 'review',
];

const FIRST_RUN_STEP_ORDER: FirstRunStep[] = [
  'welcome', 'set_breakfast', 'generate_recipes', 'first_plan',
];

/**
 * Attempt to transition to the next step in the planning flow.
 *
 * @param state - Current session state (mutated in place)
 * @returns true if transition succeeded, false if blocked by a data gate
 */
export function advancePlanningStep(state: SessionState): boolean {
  if (state.flow !== 'planning' || !state.planningStep) return false;

  const currentIndex = PLANNING_STEP_ORDER.indexOf(state.planningStep);
  if (currentIndex === -1 || currentIndex >= PLANNING_STEP_ORDER.length - 1) return false;

  const nextStep = PLANNING_STEP_ORDER[currentIndex + 1]!;

  // Data gates: check prerequisites before allowing transition
  if (!canEnterStep(state, nextStep)) return false;

  state.planningStep = nextStep;
  return true;
}

/**
 * Attempt to advance the first-run flow to the next step.
 *
 * @param state - Current session state (mutated in place)
 * @returns true if transition succeeded
 */
export function advanceFirstRunStep(state: SessionState): boolean {
  if (state.flow !== 'first_run' || !state.firstRunStep) return false;

  const currentIndex = FIRST_RUN_STEP_ORDER.indexOf(state.firstRunStep);
  if (currentIndex === -1 || currentIndex >= FIRST_RUN_STEP_ORDER.length - 1) return false;

  state.firstRunStep = FIRST_RUN_STEP_ORDER[currentIndex + 1]!;

  // If we reach 'first_plan', transition into the normal planning flow
  if (state.firstRunStep === 'first_plan') {
    // Calculate next Monday as week start
    const today = new Date();
    const dayOfWeek = today.getDay();
    const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek);
    const nextMonday = new Date(today);
    nextMonday.setDate(today.getDate() + daysUntilMonday);
    const year = nextMonday.getFullYear();
    const month = String(nextMonday.getMonth() + 1).padStart(2, '0');
    const day = String(nextMonday.getDate()).padStart(2, '0');
    state.weekStart = `${year}-${month}-${day}`;

    state.flow = 'planning';
    state.planningStep = 'breakfast';
    state.firstRunStep = undefined;
  }

  return true;
}

/**
 * Check whether the required data exists to enter a planning step.
 */
function canEnterStep(state: SessionState, step: PlanningStep): boolean {
  const data = state.planningData;
  switch (step) {
    case 'breakfast':
      return true; // always allowed
    case 'events':
      return data.breakfast !== undefined;
    case 'fun_foods':
      return data.breakfast !== undefined; // events can be empty
    case 'recipes':
      return data.breakfast !== undefined;
    case 'cooking_schedule':
      return data.recipes.length > 0;
    case 'review':
      return data.recipes.length > 0 && data.cookingScheduleApproved;
    default:
      return false;
  }
}

/**
 * Start a new planning session.
 *
 * @param state - Session state to transition (mutated in place)
 * @param weekStart - ISO date for the week start
 */
export function startPlanning(state: SessionState, weekStart: string): void {
  state.flow = 'planning';
  state.planningStep = 'breakfast';
  state.weekStart = weekStart;
  state.planningData = {
    events: [],
    funFoods: [],
    recipes: [],
    cookingScheduleApproved: false,
  };
}

/**
 * Start the first-run experience for new users.
 */
export function startFirstRun(state: SessionState): void {
  state.flow = 'first_run';
  state.firstRunStep = 'welcome';
  state.planningData = {
    events: [],
    funFoods: [],
    recipes: [],
    cookingScheduleApproved: false,
  };
}

/**
 * Enter a simple flow (shopping list, recipe browse, etc.).
 */
export function enterFlow(state: SessionState, flow: Flow): void {
  state.flow = flow;
  state.planningStep = undefined;
  state.firstRunStep = undefined;
}

/**
 * Cancel the current flow and return to idle.
 */
export function cancelFlow(state: SessionState): void {
  state.flow = 'idle';
  state.planningStep = undefined;
  state.firstRunStep = undefined;
}

/**
 * Check if the current state allows a specific action.
 * Used by the orchestrator to validate button taps and interpreted actions.
 */
export function isActionValid(state: SessionState, action: string): boolean {
  if (action === 'cancel') return state.flow !== 'idle';

  if (state.flow === 'idle') {
    return ['plan_week', 'shopping_list', 'my_recipes', 'weekly_budget'].includes(action);
  }

  if (state.flow === 'planning') {
    // Within planning, actions are step-specific
    switch (state.planningStep) {
      case 'breakfast': return ['keep_breakfast', 'change_breakfast'].includes(action);
      case 'events': return ['no_events', 'add_event', 'events_done'].includes(action);
      case 'fun_foods': return ['same_as_last_week', 'different_fun_foods', 'skip_fun_foods', 'fun_foods_done', 'add_more_fun_foods'].includes(action);
      case 'recipes': return ['approve_recipes', 'swap_recipe'].includes(action);
      case 'cooking_schedule': return ['approve_schedule', 'change_schedule'].includes(action);
      case 'review': return ['confirm_plan', 'adjust_something'].includes(action);
      default: return false;
    }
  }

  return true;
}
