/**
 * Orchestrator — the central agent that ties all components together.
 *
 * This is the LLM + state machine pattern described in spec Section 8.2.
 * The orchestrator is two things working together:
 *
 * 1. State machine (the rails) — deterministic code that defines flow structure,
 *    valid transitions, and data gates. See `state/machine.ts`.
 *
 * 2. Orchestrator LLM (the driver) — interprets free-form user input in context
 *    of the current state, generates natural responses, extracts structured data.
 *
 * Button taps bypass the LLM entirely. Only free-form text/voice goes through it.
 *
 * The orchestrator's context contains: current flow state, user's recent messages,
 * and condensed results from sub-agents. It does NOT contain raw recipe files,
 * full plan data, or stale tool output history.
 *
 * Not responsible for: calorie arithmetic (solver), recipe generation (sub-agents),
 * plan validation (QA gate), message formatting (telegram/formatters).
 */

import { v4 as uuid } from 'uuid';
import { InlineKeyboard, Keyboard } from 'grammy';
import type { LLMProvider } from '../ai/provider.js';
import type { WeeklyPlan, FunFoodItem, MealEvent, Recipe } from '../models/types.js';
import type { RecipeRequest } from '../solver/types.js';
import { config } from '../config.js';
import {
  type SessionState,
  createInitialState,
  startPlanning,
  startFirstRun,
  advancePlanningStep,
  advanceFirstRunStep,
  cancelFlow,
  enterFlow,
  isActionValid,
} from '../state/machine.js';
import { solve } from '../solver/solver.js';
import { qaGate } from '../qa/gate.js';
import { validatePlan } from '../qa/validators/plan.js';
import { RecipeDatabase } from '../recipes/database.js';
import { StateStore } from '../state/store.js';
import { generateRecipe } from './recipe-generator.js';
import { scaleRecipe } from './recipe-scaler.js';
import { estimateRestaurantMeal } from './restaurant-estimator.js';
import { generateShoppingList } from '../shopping/generator.js';
import {
  formatBudgetReview,
  formatShoppingList,
  formatRecipe,
  formatRecipeList,
  formatCookingSchedule,
} from '../telegram/formatters.js';
import {
  mainMenuKeyboard,
  breakfastKeyboard,
  noEventsKeyboard,
  moreEventsKeyboard,
  funFoodKeyboard,
  funFoodConfirmKeyboard,
  skipFunFoodKeyboard,
  recipesKeyboard,
  cookingScheduleKeyboard,
  reviewKeyboard,
  planLockedKeyboard,
  shoppingListKeyboard,
  recipeBrowseKeyboard,
  recipeSaveKeyboard,
} from '../telegram/keyboards.js';

/** The shape of every response the orchestrator returns to the bot. */
export interface OrchestratorResponse {
  text: string;
  keyboard?: Keyboard;
  inlineKeyboard?: InlineKeyboard;
}

/**
 * The orchestrator manages the conversation flow, delegates to sub-agents,
 * and coordinates between the state machine, solver, and LLM.
 */
export class Orchestrator {
  private state: SessionState;
  private llm: LLMProvider;
  private recipes: RecipeDatabase;
  private store: StateStore;

  /** Condensed context for the orchestrator LLM (recent exchanges). */
  private conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  constructor(llm: LLMProvider, recipes: RecipeDatabase, store: StateStore) {
    this.state = createInitialState();
    this.llm = llm;
    this.recipes = recipes;
    this.store = store;
  }

  /**
   * Initialize: load session state from Supabase if it exists.
   * Called once at startup.
   */
  async init(): Promise<void> {
    const saved = await this.store.loadSession();
    if (saved) {
      this.state = saved;
    }
  }

  // ─── Entry points (called by the bot) ──────────────────────────────────

  /** Handle /start command. */
  async handleStart(): Promise<OrchestratorResponse> {
    // Check if first run (no recipes in database)
    if (this.recipes.size === 0) {
      startFirstRun(this.state);
      await this.persistState();
      return {
        text: `Welcome to Flexie! 🎯\n\nI'll help you plan your weekly meals around a calorie budget — with room for fun foods, restaurants, and real life.\n\nLet's get you set up. First, what do you usually have for breakfast? Describe it or send a voice note.`,
        keyboard: mainMenuKeyboard,
      };
    }

    return {
      text: `Welcome back! What would you like to do?`,
      keyboard: mainMenuKeyboard,
    };
  }

  /** Handle /cancel command. */
  async handleCancel(): Promise<OrchestratorResponse> {
    cancelFlow(this.state);
    await this.persistState();
    return { text: 'Cancelled. What would you like to do?', keyboard: mainMenuKeyboard };
  }

  /** Handle main menu button taps. */
  async handleMainMenu(action: string): Promise<OrchestratorResponse> {
    switch (action) {
      case 'plan_week':
        return this.startPlanningFlow();
      case 'shopping_list':
        return this.showShoppingList();
      case 'my_recipes':
        return this.showRecipes();
      case 'weekly_budget':
        return this.showBudget();
      default:
        return { text: "I didn't understand that. Use the menu buttons below.", keyboard: mainMenuKeyboard };
    }
  }

  /** Handle inline button taps (bypass LLM — direct state machine transitions). */
  async handleButtonTap(action: string): Promise<OrchestratorResponse> {
    if (!isActionValid(this.state, action)) {
      return { text: "That action isn't available right now." };
    }

    return this.processAction(action);
  }

  /** Handle transcribed voice input (processed identically to text). */
  async handleVoice(audioBuffer: Buffer): Promise<OrchestratorResponse> {
    const text = await this.llm.transcribe(audioBuffer);
    console.log(`[orchestrator] voice transcribed: "${text}"`);
    return this.handleText(text);
  }

  /** Handle free-form text input — goes through the orchestrator LLM. */
  async handleText(text: string): Promise<OrchestratorResponse> {
    console.log(`[orchestrator] handleText flow=${this.state.flow} step=${this.state.planningStep ?? this.state.firstRunStep ?? '-'} weekStart=${this.state.weekStart ?? 'unset'}`);
    this.conversationHistory.push({ role: 'user', content: text });
    this.trimHistory();

    // First-run: handle setup steps
    if (this.state.flow === 'first_run') {
      return this.handleFirstRunInput(text);
    }

    // Planning flow: interpret input in context of current step
    if (this.state.flow === 'planning') {
      return this.handlePlanningInput(text);
    }

    // Recipe add flow
    if (this.state.flow === 'recipe_add') {
      return this.handleRecipeAddInput(text);
    }

    // Idle: try to interpret as a menu action
    return { text: "Use the menu buttons to get started, or tap 📋 Plan Week to plan your week.", keyboard: mainMenuKeyboard };
  }

  // ─── Flow handlers ─────────────────────────────────────────────────────

  private async startPlanningFlow(): Promise<OrchestratorResponse> {
    // Calculate next week start (next Monday)
    const today = new Date();
    const dayOfWeek = today.getDay();
    const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek);
    const nextMonday = new Date(today);
    nextMonday.setDate(today.getDate() + daysUntilMonday);
    const weekStart = nextMonday.toISOString().split('T')[0]!;

    startPlanning(this.state, weekStart);

    // Step 0: Breakfast
    const breakfastRecipe = this.findLockedBreakfast();
    if (breakfastRecipe) {
      this.state.planningData.breakfast = {
        locked: true,
        recipeSlug: breakfastRecipe.slug,
        caloriesPerDay: breakfastRecipe.perServing.calories,
        proteinPerDay: breakfastRecipe.perServing.protein,
      };
      await this.persistState();
      return {
        text: `Breakfast — keep your usual ${breakfastRecipe.name} (~${breakfastRecipe.perServing.calories} cal)?`,
        inlineKeyboard: breakfastKeyboard(breakfastRecipe.name),
      };
    }

    // No locked breakfast — ask for one
    await this.persistState();
    return {
      text: "What do you usually have for breakfast? Describe it or send a voice note, and I'll set it as your daily breakfast.",
    };
  }

  private async processAction(action: string): Promise<OrchestratorResponse> {
    switch (action) {
      // ── Step 0: Breakfast ──
      case 'keep_breakfast': {
        advancePlanningStep(this.state);
        await this.persistState();
        return this.promptEvents();
      }
      case 'change_breakfast': {
        return { text: "What would you like instead? Describe it or send a voice note." };
      }

      // ── Step 1: Events ──
      case 'no_events':
      case 'events_done': {
        advancePlanningStep(this.state);
        await this.persistState();
        return this.promptFunFoods();
      }
      case 'add_event': {
        return { text: "Which day and meal? Type it or send a voice note.\nExample: \"Thursday dinner, restaurant with coworkers, probably Italian\"" };
      }

      // ── Step 2: Fun foods ──
      case 'different_fun_foods': {
        return { text: "What fun foods do you want this week? List them with days.\nExample: \"Ice cream Monday and Wednesday, chocolate on Saturday\"" };
      }
      case 'skip_fun_foods': {
        advancePlanningStep(this.state);
        await this.persistState();
        return this.proposeRecipes();
      }
      case 'fun_foods_done':
      case 'same_as_last_week': {
        if (action === 'same_as_last_week') {
          await this.copyLastWeekFunFoods();
        }
        advancePlanningStep(this.state);
        await this.persistState();
        return this.proposeRecipes();
      }
      case 'add_more_fun_foods': {
        return { text: "What else? List additional fun foods with days." };
      }

      // ── Step 3: Recipes ──
      case 'approve_recipes': {
        advancePlanningStep(this.state);
        await this.persistState();
        return this.showCookingSchedule();
      }
      case 'swap_recipe': {
        return { text: "Which recipe do you want to swap? Tell me the meal and what you'd prefer instead." };
      }

      // ── Step 4: Cooking schedule ──
      case 'approve_schedule': {
        this.state.planningData.cookingScheduleApproved = true;
        advancePlanningStep(this.state);
        await this.persistState();
        return this.showBudgetReview();
      }
      case 'change_schedule': {
        return { text: "How would you prefer to organize your cooking days? Tell me what works better." };
      }

      // ── Step 5: Review ──
      case 'confirm_plan': {
        return this.confirmPlan();
      }
      case 'adjust_something': {
        return { text: "What would you like to adjust? You can change recipes, fun foods, events, or cooking schedule." };
      }

      // ── Post-plan ──
      case 'view_shopping_list': {
        return this.showShoppingList();
      }
      case 'view_recipes': {
        return this.showRecipes();
      }

      default:
        return { text: "I didn't understand that action." };
    }
  }

  // ─── Planning step prompts ─────────────────────────────────────────────

  private promptEvents(): OrchestratorResponse {
    const weekStart = this.state.weekStart ?? 'next week';
    return {
      text: `Let's plan your week (${formatWeekRange(weekStart)}).\nAny meals out or social events?`,
      inlineKeyboard: noEventsKeyboard,
    };
  }

  private async promptFunFoods(): Promise<OrchestratorResponse> {
    const weeklyBudget = config.targets.weekly.calories;
    const breakfastCal = (this.state.planningData.breakfast?.caloriesPerDay ?? 0) * 7;
    const eventCal = this.state.planningData.events.reduce((s, e) => s + e.estimatedCalories, 0);
    const funBudget = Math.round((weeklyBudget - breakfastCal - eventCal) * 0.20);

    const lastPlan = await this.store.getLastCompletedPlan();
    const hasLastWeek = (lastPlan?.funFoodBudget?.items?.length ?? 0) > 0;

    let text = `Time for the good stuff. You've got ~${funBudget.toLocaleString()} cal of fun food budget this week. What are we including?`;

    if (hasLastWeek && lastPlan) {
      const lastFoods = lastPlan.funFoodBudget.items.map((f) => f.name).join(', ');
      text += `\n\nLast week you had: ${lastFoods}.`;
    }

    return {
      text,
      inlineKeyboard: funFoodKeyboard(hasLastWeek),
    };
  }

  private async proposeRecipes(): Promise<OrchestratorResponse> {
    const weekDays = this.getWeekDays();
    const events = this.state.planningData.events;

    // Build recipe requests for all lunch/dinner slots not covered by events
    const requests = this.buildRecipeRequests(weekDays, events);
    this.state.planningData.recipes = requests;

    // Build proposal text
    const allRecipes = this.recipes.getAll();
    let text = `For meal preps, here's what I'm thinking:\n\n`;

    for (const req of requests) {
      const dayRange = req.days.map(formatDayShort).join('-');
      const recipeName = req.recipeSlug
        ? (this.recipes.getBySlug(req.recipeSlug)?.name ?? req.recipeSlug)
        : '(new recipe to generate)';
      text += `${capitalizeFirst(req.mealType)} ${dayRange}: ${recipeName} (${req.servings} servings)\n`;
    }

    // Note any event-replaced slots
    for (const event of events) {
      text += `(${formatDayShort(event.day)} ${event.mealTime} = ${event.name})\n`;
    }

    await this.persistState();
    return { text, inlineKeyboard: recipesKeyboard };
  }

  private async showCookingSchedule(): Promise<OrchestratorResponse> {
    // Run solver to get cooking schedule
    const solverInput = this.buildSolverInput();
    const output = solve(solverInput);

    const recipeSlugs = new Map<string, string>();
    for (const r of this.recipes.getAll()) {
      recipeSlugs.set(r.slug, r.name);
    }

    const text = formatCookingSchedule(output, recipeSlugs);
    return { text, inlineKeyboard: cookingScheduleKeyboard };
  }

  private async showBudgetReview(): Promise<OrchestratorResponse> {
    const solverInput = this.buildSolverInput();
    const output = solve(solverInput);

    // QA gate
    const gateResult = await qaGate(
      output,
      (o) => {
        const result = validatePlan(o, config.targets.weekly);
        return { valid: result.valid, errors: result.errors, warnings: result.warnings };
      },
    );

    let text = formatBudgetReview(gateResult.output, config.targets.weekly);
    if (!gateResult.passed) {
      text += `\n\n⚠️ Note: Some targets are slightly off. Errors:\n${gateResult.errors.join('\n')}`;
    }

    return { text, inlineKeyboard: reviewKeyboard };
  }

  private async confirmPlan(): Promise<OrchestratorResponse> {
    const solverInput = this.buildSolverInput();
    const output = solve(solverInput);

    // Build and save the full weekly plan
    const plan = await this.buildWeeklyPlan(output);
    await this.store.savePlan(plan);

    this.state.activePlanId = plan.id;
    this.state.flow = 'idle';
    this.state.planningStep = undefined;
    await this.persistState();

    return {
      text: `Plan locked. Shopping list ready.`,
      inlineKeyboard: planLockedKeyboard,
    };
  }

  // ─── Free-form input handlers ──────────────────────────────────────────

  private async handlePlanningInput(text: string): Promise<OrchestratorResponse> {
    const step = this.state.planningStep;

    if (step === 'breakfast') {
      return this.handleBreakfastInput(text);
    }

    if (step === 'events') {
      return this.handleEventInput(text);
    }

    if (step === 'fun_foods') {
      return this.handleFunFoodInput(text);
    }

    if (step === 'recipes') {
      return this.handleRecipeSwapInput(text);
    }

    return { text: "Use the buttons to continue with the current step." };
  }

  private async handleBreakfastInput(text: string): Promise<OrchestratorResponse> {
    // Use LLM to interpret breakfast description and generate a recipe
    const recipe = await generateRecipe({
      targetCalories: config.targets.daily.calories * 0.27, // ~27% for breakfast
      targetProtein: config.targets.daily.protein * 0.27,
      mealType: 'breakfast',
      cuisineHint: text,
    }, this.llm);

    await this.recipes.save(recipe);

    this.state.planningData.breakfast = {
      locked: true,
      recipeSlug: recipe.slug,
      caloriesPerDay: recipe.perServing.calories,
      proteinPerDay: recipe.perServing.protein,
    };
    advancePlanningStep(this.state);
    await this.persistState();

    return {
      text: `Got it! I've created:\n\n${recipe.name}\n${recipe.perServing.calories} cal | ${recipe.perServing.protein}g protein\n\nThis will be your locked breakfast. Let's move on to events.`,
      inlineKeyboard: noEventsKeyboard,
    };
  }

  private async handleEventInput(text: string): Promise<OrchestratorResponse> {
    // Use LLM to parse event description
    const result = await this.llm.complete({
      model: 'mini',
      messages: [
        {
          role: 'system',
          content: `Extract restaurant/social meal event details from user input.
Respond with JSON: { "name": "string", "day": "ISO date", "meal_time": "lunch"|"dinner", "notes": "string" }
The planning week starts on ${this.state.weekStart}. Interpret day names relative to this week.`,
        },
        { role: 'user', content: text },
      ],
      json: true,
    });

    const parsed = JSON.parse(result.content);

    // Estimate calories
    const estimate = await estimateRestaurantMeal({
      description: `${parsed.name}${parsed.notes ? ` — ${parsed.notes}` : ''}`,
      mealTime: parsed.meal_time,
    }, this.llm);

    const event: MealEvent = {
      name: parsed.name,
      day: parsed.day,
      mealTime: parsed.meal_time,
      estimatedCalories: estimate.estimatedCalories,
      notes: parsed.notes,
    };

    this.state.planningData.events.push(event);
    await this.persistState();

    return {
      text: `Got it — ${parsed.name} on ${formatDayShort(parsed.day)}.\nI'll budget ~${estimate.estimatedCalories} cal for that.\nAny other events?`,
      inlineKeyboard: moreEventsKeyboard,
    };
  }

  private async handleFunFoodInput(text: string): Promise<OrchestratorResponse> {
    // Use LLM to parse fun food list
    const result = await this.llm.complete({
      model: 'mini',
      messages: [
        {
          role: 'system',
          content: `Extract fun food items from user input.
Respond with JSON: { "items": [{ "name": "string", "day": "ISO date", "estimated_calories": number, "meal_time": "snack"|"dessert"|"with-lunch"|"with-dinner" }] }
The planning week starts on ${this.state.weekStart}. Interpret day names relative to this week.
Estimate calories for common fun foods (ice cream ~300, chocolate bar ~250, churros ~350, pizza slice ~300, etc).`,
        },
        { role: 'user', content: text },
      ],
      json: true,
    });

    const parsed = JSON.parse(result.content);
    const items: FunFoodItem[] = parsed.items.map((item: Record<string, unknown>) => ({
      name: item.name as string,
      day: item.day as string,
      estimatedCalories: item.estimated_calories as number,
      mealTime: item.meal_time as FunFoodItem['mealTime'],
    }));

    this.state.planningData.funFoods.push(...items);
    await this.persistState();

    const totalFun = this.state.planningData.funFoods.reduce((s, f) => s + f.estimatedCalories, 0);
    const funPercent = (totalFun / config.targets.weekly.calories * 100).toFixed(1);

    let text2 = `Nice. I'll budget:\n`;
    for (const item of items) {
      text2 += `- ${item.name}: ~${item.estimatedCalories} cal (${formatDayShort(item.day)})\n`;
    }
    text2 += `\nThat's ${totalFun} cal fun food (~${funPercent}% of weekly budget).`;

    return { text: text2, inlineKeyboard: funFoodConfirmKeyboard };
  }

  private async handleRecipeSwapInput(text: string): Promise<OrchestratorResponse> {
    // Use LLM to interpret swap request
    const result = await this.llm.complete({
      model: 'mini',
      messages: [
        {
          role: 'system',
          content: `The user wants to swap a recipe in their meal plan.
Current recipes: ${this.state.planningData.recipes.map((r) => `${r.mealType} ${r.days.map(formatDayShort).join('-')}: ${r.recipeSlug ?? 'new'}`).join(', ')}
Available recipes: ${this.recipes.getAll().map((r) => r.slug).join(', ')}

Respond with JSON: { "swap_index": number (0-based index of recipe to swap), "new_slug": "string or null for generate new", "cuisine_hint": "string or null" }`,
        },
        { role: 'user', content: text },
      ],
      json: true,
    });

    const parsed = JSON.parse(result.content);
    const idx = parsed.swap_index as number;
    if (idx >= 0 && idx < this.state.planningData.recipes.length) {
      const req = this.state.planningData.recipes[idx]!;
      req.recipeSlug = parsed.new_slug ?? undefined;
      req.cuisineHint = parsed.cuisine_hint ?? undefined;
    }

    await this.persistState();
    return this.proposeRecipes();
  }

  private async handleFirstRunInput(text: string): Promise<OrchestratorResponse> {
    const step = this.state.firstRunStep;

    if (step === 'welcome' || step === 'set_breakfast') {
      // Generate breakfast recipe from description
      const recipe = await generateRecipe({
        targetCalories: Math.round(config.targets.daily.calories * 0.27),
        targetProtein: Math.round(config.targets.daily.protein * 0.27),
        mealType: 'breakfast',
        cuisineHint: text,
      }, this.llm);

      await this.recipes.save(recipe);
      advanceFirstRunStep(this.state);
      await this.persistState();

      return {
        text: `Great! I've created your breakfast:\n\n${recipe.name}\n${recipe.perServing.calories} cal | ${recipe.perServing.protein}g protein\n\nNow let's build your recipe database. Tell me 3-4 dishes you like for lunch and dinner. Describe them or just list names.`,
      };
    }

    if (step === 'generate_recipes') {
      // Generate starter recipes from descriptions
      const result = await this.llm.complete({
        model: 'mini',
        messages: [
          {
            role: 'system',
            content: `Extract dish names/descriptions from the user's input. Respond with JSON: { "dishes": [{ "name": "string", "meal_type": "lunch"|"dinner", "cuisine_hint": "string" }] }`,
          },
          { role: 'user', content: text },
        ],
        json: true,
      });

      const parsed = JSON.parse(result.content);
      const dishes = parsed.dishes as Array<{ name: string; meal_type: 'lunch' | 'dinner'; cuisine_hint: string }>;

      const targetCal = Math.round((config.targets.daily.calories - config.targets.daily.calories * 0.27) / 2);
      const targetProtein = Math.round((config.targets.daily.protein - config.targets.daily.protein * 0.27) / 2);

      for (const dish of dishes) {
        const recipe = await generateRecipe({
          targetCalories: targetCal,
          targetProtein: targetProtein,
          mealType: dish.meal_type,
          cuisineHint: dish.cuisine_hint || dish.name,
        }, this.llm);
        await this.recipes.save(recipe);
      }

      advanceFirstRunStep(this.state); // transitions to planning flow
      await this.persistState();

      return {
        text: `Created ${dishes.length} recipes! Your recipe database is ready.\n\nLet's plan your first week.`,
        inlineKeyboard: breakfastKeyboard(this.findLockedBreakfast()?.name ?? 'breakfast'),
      };
    }

    return { text: "Use the menu to get started.", keyboard: mainMenuKeyboard };
  }

  private async handleRecipeAddInput(text: string): Promise<OrchestratorResponse> {
    const targetCal = Math.round((config.targets.daily.calories - config.targets.daily.calories * 0.27) / 2);
    const targetProtein = Math.round((config.targets.daily.protein - config.targets.daily.protein * 0.27) / 2);

    const recipe = await generateRecipe({
      targetCalories: targetCal,
      targetProtein: targetProtein,
      mealType: 'dinner',
      cuisineHint: text,
    }, this.llm);

    // Store temporarily for save/discard decision
    this.state.planningData.recipes = [{
      recipeSlug: recipe.slug,
      mealType: 'dinner',
      days: [],
      servings: 3,
    }];
    await this.persistState();

    // Temporarily save recipe for potential confirmation
    await this.recipes.save(recipe);

    return {
      text: `Here's what I got:\n\n${formatRecipe(recipe)}`,
      inlineKeyboard: recipeSaveKeyboard,
    };
  }

  // ─── Read-only views ───────────────────────────────────────────────────

  private async showShoppingList(): Promise<OrchestratorResponse> {
    const plan = await this.store.getCurrentPlan();
    if (!plan) {
      return { text: "No active plan. Plan your week first!", keyboard: mainMenuKeyboard };
    }

    const breakfastRecipe = plan.breakfast.recipeSlug
      ? this.recipes.getBySlug(plan.breakfast.recipeSlug)
      : undefined;

    const list = generateShoppingList(plan, breakfastRecipe);
    return { text: formatShoppingList(list), inlineKeyboard: shoppingListKeyboard };
  }

  private async showRecipes(): Promise<OrchestratorResponse> {
    const allRecipes = this.recipes.getAll();
    if (allRecipes.length === 0) {
      return {
        text: "No recipes yet. Add your first recipe!",
        inlineKeyboard: new InlineKeyboard().text('Add new recipe', 'add_recipe'),
      };
    }
    return { text: formatRecipeList(allRecipes), inlineKeyboard: recipeBrowseKeyboard };
  }

  private async showBudget(): Promise<OrchestratorResponse> {
    const plan = await this.store.getCurrentPlan();
    if (!plan) {
      return { text: "No active plan. Plan your week first!", keyboard: mainMenuKeyboard };
    }

    // Re-derive budget view from plan data
    const solverInput = this.buildSolverInputFromPlan(plan);
    const output = solve(solverInput);
    return { text: formatBudgetReview(output, config.targets.weekly) };
  }

  // ─── Internal helpers ──────────────────────────────────────────────────

  private findLockedBreakfast(): Recipe | undefined {
    const breakfasts = this.recipes.getByMealType('breakfast');
    return breakfasts[0]; // In v0.0.1, the first breakfast recipe is the locked one
  }

  private getWeekDays(): string[] {
    const start = this.state.weekStart;
    if (!start) return [];
    const days: string[] = [];
    const d = new Date(start);
    for (let i = 0; i < 7; i++) {
      days.push(d.toISOString().split('T')[0]!);
      d.setDate(d.getDate() + 1);
    }
    return days;
  }

  /**
   * Build recipe requests for all uncovered lunch/dinner slots.
   * Assigns existing recipes from the database, avoiding recent repeats.
   */
  private buildRecipeRequests(weekDays: string[], events: MealEvent[]): RecipeRequest[] {
    const requests: RecipeRequest[] = [];
    const lunchRecipes = this.recipes.getByMealType('lunch');
    const dinnerRecipes = this.recipes.getByMealType('dinner');

    // Group consecutive non-event days into batches of 3 (or 2 for remainder)
    for (const mealType of ['lunch', 'dinner'] as const) {
      const available = mealType === 'lunch' ? lunchRecipes : dinnerRecipes;
      const openDays = weekDays.filter(
        (day) => !events.some((e) => e.day === day && e.mealTime === mealType)
      );

      let recipeIdx = 0;
      for (let i = 0; i < openDays.length; i += 3) {
        const batchDays = openDays.slice(i, i + 3);
        const recipe = available[recipeIdx % Math.max(available.length, 1)];
        requests.push({
          recipeSlug: recipe?.slug,
          mealType,
          days: batchDays,
          servings: batchDays.length,
        });
        recipeIdx++;
      }
    }

    return requests;
  }

  private buildSolverInput() {
    return {
      weeklyTargets: config.targets.weekly,
      events: this.state.planningData.events,
      funFoods: this.state.planningData.funFoods,
      mealPrepPreferences: { recipes: this.state.planningData.recipes },
      breakfast: this.state.planningData.breakfast ?? {
        locked: true,
        caloriesPerDay: 650,
        proteinPerDay: 40,
      },
    };
  }

  private buildSolverInputFromPlan(plan: WeeklyPlan) {
    const recipes: RecipeRequest[] = plan.cookDays.flatMap((cd) =>
      cd.batches.map((b) => ({
        recipeSlug: b.recipeSlug,
        mealType: b.mealType,
        days: plan.mealSlots
          .filter((s) => s.batchId === b.id)
          .map((s) => s.day),
        servings: b.servings,
      }))
    );

    return {
      weeklyTargets: plan.targets,
      events: plan.events,
      funFoods: plan.funFoodBudget.items,
      mealPrepPreferences: { recipes },
      breakfast: plan.breakfast,
    };
  }

  private async buildWeeklyPlan(output: import('../solver/types.js').SolverOutput): Promise<WeeklyPlan> {
    const planId = uuid();
    const now = new Date().toISOString();

    // Scale recipes for each batch target
    const cookDays: WeeklyPlan['cookDays'] = [];
    const mealSlots: WeeklyPlan['mealSlots'] = [];

    for (const cookDay of output.cookingSchedule) {
      const batches = [];
      for (const batchId of cookDay.batchIds) {
        const target = output.batchTargets.find((b) => b.id === batchId);
        if (!target) continue;

        const recipe = target.recipeSlug
          ? this.recipes.getBySlug(target.recipeSlug)
          : undefined;

        let scaledResult;
        if (recipe) {
          scaledResult = await scaleRecipe({
            recipe,
            targetCalories: target.targetPerServing.calories,
            targetProtein: target.targetPerServing.protein,
            servings: target.servings,
          }, this.llm);
        }

        batches.push({
          id: batchId,
          recipeSlug: target.recipeSlug ?? 'generated',
          mealType: target.mealType,
          servings: target.servings,
          targetPerServing: target.targetPerServing,
          actualPerServing: scaledResult?.actualPerServing ?? {
            calories: target.targetPerServing.calories,
            protein: target.targetPerServing.protein,
            fat: 0,
            carbs: 0,
          },
          scaledIngredients: scaledResult?.scaledIngredients ?? [],
        });

        // Create meal slots for each day in the batch
        for (const day of target.days) {
          mealSlots.push({
            id: uuid(),
            day,
            mealTime: target.mealType,
            source: 'meal-prep',
            batchId,
            plannedCalories: target.targetPerServing.calories,
            plannedProtein: target.targetPerServing.protein,
          });
        }
      }
      cookDays.push({ day: cookDay.day, batches });
    }

    // Add breakfast and event meal slots
    const weekDays = this.getWeekDays();
    for (const day of weekDays) {
      // Breakfast
      mealSlots.push({
        id: uuid(),
        day,
        mealTime: 'breakfast',
        source: 'fresh',
        plannedCalories: this.state.planningData.breakfast?.caloriesPerDay ?? 650,
        plannedProtein: this.state.planningData.breakfast?.proteinPerDay ?? 40,
      });

      // Event meal slots
      for (const event of this.state.planningData.events.filter((e) => e.day === day)) {
        mealSlots.push({
          id: uuid(),
          day,
          mealTime: event.mealTime,
          source: 'restaurant',
          plannedCalories: event.estimatedCalories,
          plannedProtein: 25,
        });
      }
    }

    return {
      id: planId,
      weekStart: this.state.weekStart!,
      status: 'active',
      targets: config.targets.weekly,
      funFoodBudget: {
        total: output.weeklyTotals.funFoodCalories,
        items: this.state.planningData.funFoods,
      },
      breakfast: {
        locked: this.state.planningData.breakfast?.locked ?? true,
        recipeSlug: this.state.planningData.breakfast?.recipeSlug ?? '',
        caloriesPerDay: this.state.planningData.breakfast?.caloriesPerDay ?? 650,
        proteinPerDay: this.state.planningData.breakfast?.proteinPerDay ?? 40,
      },
      events: this.state.planningData.events,
      cookDays,
      mealSlots,
      customShoppingItems: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async copyLastWeekFunFoods(): Promise<void> {
    const lastPlan = await this.store.getLastCompletedPlan();
    if (lastPlan?.funFoodBudget?.items) {
      // Copy items but update days to new week
      const weekDays = this.getWeekDays();
      this.state.planningData.funFoods = lastPlan.funFoodBudget.items.map((item, i) => ({
        ...item,
        day: weekDays[Math.min(i, weekDays.length - 1)] ?? weekDays[0]!,
      }));
    }
  }

  private async persistState(): Promise<void> {
    await this.store.saveSession(this.state);
  }

  /** Keep conversation history under 20 exchanges to prevent context bloat. */
  private trimHistory(): void {
    if (this.conversationHistory.length > 40) {
      this.conversationHistory = this.conversationHistory.slice(-20);
    }
  }
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function formatDayShort(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short' });
}

function formatWeekRange(weekStart: string): string {
  const start = new Date(weekStart + 'T00:00:00');
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} - ${end.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
