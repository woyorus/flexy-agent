# Flexie — Product Spec v0.0.1

## 1. Overview

Flexie is an AI agent that helps users lose weight by managing a weekly calorie budget with built-in flexibility for fun foods, restaurants, and real life. It is planning-first, not tracking-first.

The core product is the **agent harness** — the state management, budget solver, recipe database, and conversational flows. Telegram is the UI.

For the full vision, see [PROJECT.md](./PROJECT.md).

### What v0.0.1 delivers

A working prototype that can:
- Run a guided weekly planning session via Telegram
- Solve a weekly calorie and protein budget with 80/20 fun food allocation
- Generate or select properly-sized balanced recipes from a personal database
- Produce a shopping list
- Display the weekly plan and budget

v0.0.1 is **intentionally a planning-only prototype**. The full product thesis is "planning AND adjustment," but planning must work before adjustment can build on it. This version validates: does the weekly budget model work? Do the solver and recipes produce good output? Does the flow feel low-friction? The adjustment thesis (tracking, mid-week replanning, three-tier notifications) is validated in v0.0.2.

What v0.0.1 does **not** include: meal tracking, mid-week adjustments, photo tracking, proactive nudges. (Note: voice *input* for planning is in scope; voice *tracking* of meals is not.)

---

## 2. Core Concepts

### Weekly calorie budget

The fundamental unit is the **week**, not the day. The user has a weekly calorie and protein target. Individual days can vary — what matters is the weekly total landing in the right ballpark.

- Weekly calories: daily target x 7 (e.g., 2,436 x 7 = 17,052)
- Weekly protein: daily target x 7 (e.g., 150 x 7 = 1,050g)

### 80/20 allocation

Roughly 80% of weekly calories come from planned, healthy meals (meal preps and fresh breakfasts). Roughly 20% is reserved for fun foods — ice cream, pizza, chocolate, pastries. This isn't a strict split; it's a planning guideline that ensures psychological sustainability.

Restaurant meals are a **separate budget category** from fun foods. They are estimated at planning time and allocated independently. The 20% fun food budget does not include restaurant meals — it's purely for discretionary treats. However, when budget pressure occurs, the fun food budget absorbs overages first (see Overconsumption priority).

Note: Alcohol is allowed if the user includes it, but the product never suggests or promotes it. The agent does not mention alcohol in examples, suggestions, or nudges.

### Planning-first

The system front-loads intelligence into the weekly planning session. Because meal preps are cooked in batches and can't be resized after cooking, the plan must be correct at cook time. Fun foods, restaurant meals, and variable days are accounted for **before** recipes are generated and portions are sized.

### Overconsumption priority: fun food absorbs first

When budget pressure exists — whether from a large restaurant estimate at planning time or from actual overconsumption at tracking time (v0.0.2+) — the excess is absorbed by reducing the **fun food budget first**, not the healthy meal structure. The 20% fun food allocation is the flexible buffer. The 80% healthy structure (meal preps, breakfasts) should be the last thing to shrink, because that's the nutritional foundation. Only if the fun food budget is fully consumed does the system touch planned meals.

In v0.0.1, this rule applies at **planning time only** (e.g., when a large restaurant event squeezes the budget, the solver trims fun food allocation before reducing meal prep portions). In v0.0.2+, it extends to **tracking time** (actual overconsumption triggers the same priority when rebalancing).

### No food waste

All servings in a meal prep batch must be consumed. The solver sizes portions at planning time so that fun foods and restaurant meals are already budgeted. You never need to throw away half a meal to make room for ice cream.

### Flexible cooking schedule

The cooking schedule adapts to the week's shape. Restaurant meals, social events, and preferences naturally create batch boundaries. Some weeks it's one big cook day; others it's two smaller ones. The solver proposes the most efficient schedule; the user approves or adjusts.

---

## 3. User Profile (v0.0.1)

v0.0.1 is single-user with hardcoded targets. Future versions will have an onboarding flow that calculates personalized targets.

### Authentication (v0.0.1)

Single-user authentication via hardcoded Telegram chat ID in environment config. The bot only responds to messages from this chat ID; all other messages are ignored. Multi-user auth is a v0.1.0 concern.

### Starting configuration

```
Product-facing targets (what the user sees):
  Daily calories: 2436 kcal
  Daily protein: 150g
  Weekly calories: 17052 kcal
  Weekly protein: 1050g

Internal recipe-generation targets (balanced by the system, not shown to user):
  Daily fat: 131g
  Daily carbs: 164g

Priority when tradeoffs happen:
  1. Calories (most important for deficit)
  2. Protein (satiety, muscle preservation)
  3. Fat (set appropriate levels)
  4. Carbs (fill remaining calories)
```

**Product vs backend distinction:** The product presents itself in terms of calories and protein only. These are what the user sees in the budget review, planning flow, and weekly summary. Fat and carbs are handled internally by the recipe generator to produce balanced meals — the user never needs to think about fat/carb math. The system ensures nutritional balance without burdening the user with the details.

### Meal structure

- **Breakfast**: Fresh daily. Not meal-prepped. Typically 2 components, 5-15 min prep. Can be **locked** as a repeating daily recipe (most common — many people eat the same breakfast every day for simplicity). Locked breakfast is the default in v0.0.1; breakfast variety is in the backlog.
- **Lunch**: Meal-prepped. Default 3 servings per batch (option for 2). One-pan/one-pot by default.
- **Dinner**: Meal-prepped. Default 3 servings per batch (option for 2). One-pan/one-pot by default.
- **Fun food**: Placed on specific days during planning. Comes from the 20% budget.
- **Restaurant/social meals**: Replace a meal slot. Estimated at planning time with a calorie buffer.

---

## 4. Architecture

### Three layers

```
+-----------------------------------+
|  Telegram Bot                     |  UI, buttons, notifications
+-----------------------------------+
|  Agent Harness (the product)      |  State, flows, solver, recipes
+-----------------------------------+
|  AI Layer (tools)                 |  LLM for conversation/recipes,
|                                   |  vision for photo estimates (future)
+-----------------------------------+
```

**Telegram Bot** — Handles messaging UI, buttons, notifications. Directly uses Telegram Bot API.

**Agent Harness** — The core product. An orchestrator (LLM constrained by a deterministic state machine) manages conversation and flow logic. Sub-agents handle heavy isolated work (recipe generation, scaling) and return condensed results. The budget solver and QA gate are pure deterministic code. See Section 8.2 for the full agent architecture.

**AI Layer** — LLM providers behind a simple interface. OpenAI API for v0.0.1. The interface is provider-agnostic so we can switch LLM providers without rewriting business logic.

### Key design principles

- **Deterministic math, creative AI.** The budget solver is code, not prompts. The LLM never does calorie arithmetic. It handles: understanding user input, generating recipes to hit a target, estimating restaurant meals, and making conversation natural.
- **LLM-agnostic.** All LLM calls go through a provider interface. Switching from Claude to GPT or Gemini should require only a new provider implementation.
- **Validate before committing.** Nothing reaches the user without passing a QA gate. Every plan, recipe, and shopping list is validated against hard constraints before being shown. If validation fails, the harness loops back to fix and re-validates — the user never sees a broken output. See Section 6.2 for details.
- **Context is a scarce resource.** The orchestrator's context window rots over time. Fight this with sub-agents (isolated context for heavy work), compaction (summarize and clear stale tool outputs), and just-in-time retrieval (load recipes/data when needed, not upfront). See Section 8.2.
- **State lives in Supabase.** Weekly plans, user preferences, and budget state are persisted in Supabase (Postgres). Recipes live as markdown files in the repo. Externalizing state means the context window doesn't need to carry it.
- **Documentation is for LLMs.** Every file, class, and function is documented with explicit intent, constraints, and relationships. The `docs/` folder is structured so coding agents can load a single relevant file instead of the full project context. Product logic changes must update docs in the same change. See `CLAUDE.md` for the full documentation requirements.

### Tech stack

- **Runtime**: Node.js + TypeScript
- **Delivery**: Telegram Bot API (grammy or node-telegram-bot-api)
- **AI**: OpenAI API via OpenAI SDK (behind LLM provider interface). Models: **GPT-5.4** (recipe generation, complex tasks) and **GPT-5.4-mini** (input parsing, estimation, simple tasks). Both support reasoning modes: none, low, medium, high, xhigh.
- **Speech-to-text**: OpenAI Whisper API (voice messages → text)
- **Persistence**: Supabase (plans, state) + markdown files (recipes)
- **Deployment**: VPS (user's existing infrastructure)

---

## 5. Data Models

### 5.1 Recipe (markdown files)

Recipes are stored as markdown files with YAML frontmatter in a `recipes/` directory. They are both human-readable (browsable, editable) and machine-readable (parseable by the agent).

```
recipes/
  chicken-pepperonata-skillet.md
  carbonara-healthy.md
  salmon-traybake-potatoes.md
  ...
```

#### Recipe format

```yaml
---
name: Chicken Pepperonata Skillet
slug: chicken-pepperonata-skillet
meal_types: [lunch, dinner]
cuisine: italian
tags: [one-pan, chicken, meal-prep]
prep_time_minutes: 30
per_serving:
  calories: 780
  protein: 52
  fat: 38
  carbs: 50
ingredients:
  - name: chicken breast
    amount: 200
    unit: g
    role: protein
  - name: bell peppers (mixed)
    amount: 200
    unit: g
    role: vegetable
  - name: canned tomatoes
    amount: 150
    unit: g
    role: base
  - name: olive oil
    amount: 15
    unit: ml
    role: fat
  - name: onion
    amount: 80
    unit: g
    role: base
  - name: garlic
    amount: 2
    unit: cloves
    role: seasoning
  - name: dried oregano
    amount: 1
    unit: tsp
    role: seasoning
storage:
  fridge_days: 3
  freezable: true
  reheat: Pan on medium heat, 3-4 min. Add splash of water if dry.
---

## Steps

1. Cut chicken into bite-sized pieces. Season with salt, pepper, oregano.
2. Heat olive oil in a large skillet over medium-high heat.
3. Cook chicken until golden, about 5-6 minutes. Remove and set aside.
4. In same skillet, cook sliced onion and peppers until softened, ~5 min.
5. Add minced garlic, cook 30 seconds.
6. Add canned tomatoes, stir, bring to simmer.
7. Return chicken. Cook together 5 minutes.

## Notes

- Can swap chicken for turkey breast (similar macros)
- Works well with zucchini instead of peppers
```

#### Ingredient roles

The `role` field tells the solver which ingredients to adjust when scaling to a different calorie target:

| Role | Behavior when scaling | Examples |
|---|---|---|
| `protein` | Adjust last (protect protein) | Chicken, fish, eggs, legumes |
| `carb` | Adjust first (main calorie lever) | Pasta, rice, potatoes, bread |
| `fat` | Adjust second | Olive oil, cheese, nuts |
| `vegetable` | Keep stable (volume, nutrition) | Peppers, tomatoes, onion |
| `base` | Keep stable (recipe structure) | Canned tomatoes, broth |
| `seasoning` | Keep stable | Salt, herbs, spices, garlic |

When the solver needs a recipe at 650 cal instead of 780, it reduces `carb` and `fat` role ingredients proportionally, while keeping `protein` stable and `vegetable`/`base`/`seasoning` unchanged.

### 5.2 Weekly Plan (Supabase)

```typescript
interface WeeklyPlan {
  id: string;
  weekStart: string;            // ISO date, user chooses start day
  status: 'planning' | 'active' | 'completed';

  targets: {
    calories: number;           // weekly total
    protein: number;
  };

  funFoodBudget: {
    total: number;              // calories allocated to fun food
    items: FunFoodItem[];
  };

  breakfast: {
    locked: boolean;              // true = same recipe every day (v0.0.1 default)
    recipeSlug: string;           // locked breakfast recipe
    caloriesPerDay: number;
    proteinPerDay: number;
  };

  events: MealEvent[];          // restaurants, social meals
  cookDays: CookDay[];          // when to cook what
  mealSlots: MealSlot[];        // every meal for the week

  createdAt: string;
  updatedAt: string;
}

interface FunFoodItem {
  name: string;                 // "ice cream", "chocolate"
  estimatedCalories: number;
  day: string;                  // ISO date
  mealTime: 'snack' | 'dessert' | 'with-lunch' | 'with-dinner';
}

interface MealEvent {
  name: string;                 // "dinner with friends"
  day: string;
  mealTime: 'lunch' | 'dinner';
  estimatedCalories: number;
  notes?: string;               // "probably Italian"
}

interface CookDay {
  day: string;                  // ISO date
  batches: Batch[];
}

interface Batch {
  id: string;
  recipeSlug: string;           // links to recipe markdown file
  mealType: 'lunch' | 'dinner';
  servings: number;             // 2 or 3
  targetPerServing: {
    calories: number;           // from solver (hard constraint)
    protein: number;            // from solver (hard constraint)
  };
  actualPerServing: {           // from recipe generator (balanced internally)
    calories: number;
    protein: number;
    fat: number;
    carbs: number;
  };
  scaledIngredients: ScaledIngredient[];  // recipe ingredients adjusted to target
}

interface ScaledIngredient {
  name: string;
  amount: number;
  unit: string;
  totalForBatch: number;        // amount x servings (for shopping list)
}

interface MealSlot {
  id: string;
  day: string;
  mealTime: 'breakfast' | 'lunch' | 'dinner';
  source: 'fresh' | 'meal-prep' | 'restaurant' | 'skipped';
  batchId?: string;             // if source is meal-prep
  eventId?: string;             // if source is restaurant
  plannedCalories: number;
  plannedProtein: number;
}
```

### 5.3 Shopping List (derived)

Generated from the active weekly plan by aggregating `scaledIngredients` across all batches, plus breakfast recipe ingredients (x7 if locked). The ingredient list is derived and not stored separately.

User-added custom items (non-food like water, paper towels, or extra ingredients) are stored on the weekly plan:

```typescript
// Add to WeeklyPlan interface:
customShoppingItems: string[];  // user-added items ("water", "paper towels")
```

---

## 6. Budget Solver

The solver is **deterministic code** — no LLM involved. It takes structured inputs and produces a budget allocation that the recipe engine then fills.

### Inputs

```typescript
interface SolverInput {
  weeklyTargets: {
    calories: number;
    protein: number;
  };
  events: MealEvent[];          // restaurant/social meals with estimates
  funFoods: FunFoodItem[];      // planned fun foods with estimates
  mealPrepPreferences: {
    recipes: RecipeRequest[];
  };
  breakfast: {
    locked: boolean;
    recipeSlug?: string;
    caloriesPerDay: number;
    proteinPerDay: number;
  };
}

interface RecipeRequest {
  recipeSlug?: string;          // from database, or null for "generate new"
  mealType: 'lunch' | 'dinner';
  days: string[];               // ISO dates this batch covers
  servings: number;             // 2 or 3, per-batch
  cuisineHint?: string;         // "Italian", "something with chicken"
}
```

### Algorithm

1. **Allocate breakfast**: If locked, subtract (breakfast cal x 7) from weekly budget. This is fixed and predictable.
2. **Allocate fixed slots**: Sum restaurant meal estimates + fun food estimates.
3. **Calculate remaining budget**: Weekly target - breakfast - restaurants - fun food = budget for lunch + dinner meal preps.
4. **Lay out the week grid**: 7 days x 3 meals. Mark restaurant slots, fun food days, and locked breakfasts.
5. **Calculate meal prep budget**: Remaining budget distributed **evenly** across all lunch + dinner meal prep slots. Every meal prep meal gets roughly the same calorie target by default.
6. **Distribute across batches**: Group slots into batches. Each batch has N servings at equal calories per serving (since all slots are roughly equal, this falls out naturally).
7. **Balance**: Ensure no batch target drops below a minimum viable meal (~500 cal) or exceeds reasonable maximum (~950 cal). Redistribute if needed.
8. **Verify**: Check weekly totals. Calories within +/- 2% of target. Protein meets minimum.

### Output

```typescript
interface SolverOutput {
  isValid: boolean;
  weeklyTotals: {
    calories: number;
    protein: number;
    funFoodCalories: number;
    funFoodPercent: number;     // should be ~20% or less
  };
  dailyBreakdown: DailyBreakdown[];
  batchTargets: BatchTarget[];
  cookingSchedule: CookDay[];
  warnings: string[];           // "Fun food is 28% this week — higher than usual"
}

interface DailyBreakdown {
  day: string;                  // ISO date
  totalCalories: number;
  totalProtein: number;
  breakfast: { calories: number; protein: number };
  lunch: { calories: number; protein: number; batchId?: string };
  dinner: { calories: number; protein: number; batchId?: string };
  funFoods: FunFoodItem[];      // fun foods placed on this day
  events: MealEvent[];          // restaurant/social meals (can have both lunch and dinner events)
}

interface BatchTarget {
  id: string;
  recipeSlug?: string;          // null if new recipe needs to be generated
  mealType: 'lunch' | 'dinner';
  days: string[];               // which days this batch covers
  servings: number;
  targetPerServing: {
    calories: number;           // hard constraint (solver enforces)
    protein: number;            // hard constraint (solver enforces)
    // fat and carbs are NOT solver constraints — they are derived
    // by the recipe generator internally to produce balanced meals
  };
}
```

### Constraints

- All servings in a batch must have the same calorie target (no waste)
- Protein minimum: weekly target must be met
- Fun food should not exceed ~25% of weekly calories (soft limit, warn but allow)
- No meal slot below 400 cal (undereating signal)
- No meal slot above 1000 cal for planned meals (overshooting signal)
- **Budget pressure priority** (planning-time): When large restaurant/social meal estimates squeeze the budget, solver reduces fun food allocation before meal prep portions.
- Weekly calories within +/- 3% of target

### 6.2 QA Gate

Every output the harness produces — weekly plans, scaled recipes, shopping lists — must pass a validation step before reaching the user. This is a core reliability mechanism. If the agent serves a plan with wrong macros or an impossible cooking schedule, the user loses trust and the product adds friction instead of removing it.

#### How it works

```
LLM / Solver produces output
        │
        ▼
   ┌─────────┐
   │ QA Gate  │──── PASS ───▶ Show to user
   └─────────┘
        │
       FAIL
        │
        ▼
   Fix + retry (max 3 attempts)
        │
        ▼
   Still failing? ──▶ Show best attempt + warning to user
```

#### Validation rules

**Weekly plan validation:**
- Weekly calories within +/- 3% of target
- Weekly protein meets minimum
- No meal slot below 400 cal or above 1000 cal
- All servings in a batch have equal calorie targets
- Fun food budget not exceeded
- Budget pressure priority respected (fun food reduced before meal prep when budget is tight)
- Cooking days are before eating days
- No orphaned meal slots (every meal has a source)

**Recipe validation:**
- Calories per serving within +/- 5% of target
- Protein per serving within +/- 5% of target
- Fat and carbs are present and reasonable (not validated against hard targets — they are recipe-generation aids, not solver constraints)
- Ingredient amounts are reasonable (no 500g of salt, no 5g of chicken)
- All required fields present (name, ingredients, macros, steps)
- Ingredient roles are assigned
- Total ingredient calories approximately match stated macros (internal consistency check)

**Nutritional source of truth (v0.0.1):** The LLM's training knowledge is the source for calorie/macro estimates in recipe generation and fun food/restaurant estimation. The QA gate checks internal consistency (do ingredient amounts plausibly match stated totals?) but does not validate against an external nutritional database. Future versions may add a nutritional API for higher precision.

**Shopping list validation:**
- Every recipe ingredient from the plan is included
- Amounts are aggregated correctly across batches
- Units are consistent (no mixing g and kg for same item)

#### Fix loop

When validation fails, the harness identifies which constraints are violated and:

1. **For solver outputs**: Re-runs the solver with adjusted parameters (e.g., redistribute calories if a batch target is out of range).
2. **For LLM-generated recipes**: Sends the recipe back to the LLM with the specific failures ("protein is 38g, needs to be 48-55g — adjust chicken amount") and asks for a corrected version.
3. **For shopping lists**: Deterministic recalculation — these should never fail if the plan and recipes are valid.

Maximum 3 retry attempts. If still failing, the harness shows the best attempt to the user with a visible warning about what's off, so the user can make an informed decision.

---

## 7. Flows

### 7.1 Planning Session

The main weekly ritual. Agent-led, guided conversation with inline buttons. Happy-path target: **under 5 minutes, ~6 exchanges** (one tap per step, no swaps). Complex weeks with recipe swaps, multiple events, or cooking schedule changes will take longer.

#### Step 0: Breakfast

Quick check — one tap if nothing changes.

```
Agent: Breakfast — keep your usual Oats + Yogurt Bowl (~650 cal)?

       [Keep it]    [Change this week]
```

If locked (default in v0.0.1), the user taps [Keep it] and breakfast is budgeted at 650 cal x 7 = 4,550 cal for the week. The solver subtracts this upfront.

If the user taps [Change this week], they can pick a different recipe or ask for suggestions. This is a rare path — most weeks it's one tap.

#### Step 1: Events and social meals

```
Agent: Let's plan your week (Mon Apr 6 - Sun Apr 12).
       Any meals out or social events?

       [No events this week]    [Add event]

User:  [Add event]
Agent: Which day and meal? Type it or send a voice note.
User:  🎤 "Thursday dinner, restaurant with coworkers, probably Italian"
Agent: Got it — Thursday dinner out, Italian place.
       I'll budget ~1000 cal for that.
       Any other events?

       [No, that's all]    [Add another]
```

#### Step 2: Fun foods

Fun foods are not optional extras — they are a core part of the system's adherence strategy. The flow assumes fun foods will be included and actively encourages them. The agent should never present skipping fun foods as an equal option.

```
Agent: Time for the good stuff. You've got ~3,400 cal of fun food
       budget this week. What are we including?
       
       Last week you had: ice cream x2, Friday churros.
       
       [Same as last week]    [Something different]

User:  Ice cream twice, chocolate on Saturday
Agent: Nice. I'll budget:
       - Ice cream x2: ~600 cal (which days?)
       - Saturday chocolate: ~250 cal
       
       That's 850 cal fun food (~5% of weekly budget).
       Still 2,550 cal of fun budget unused — room to add more
       later if you want.
       
       [Looks good]    [Add more]
```

If the user explicitly says they don't want fun foods, the agent reminds them of the available budget once, then accepts their choice:

```
User:  No fun foods this week
Agent: No problem. Just so you know, you've got ~3,400 cal
       of fun budget available if you change your mind later.
       
       [Add something]    [Skip this week]
```

#### Step 3: Recipe selection

The agent proposes recipes using this priority:
1. **User's database first** — prefer existing recipes the user has saved and likes
2. **Avoid recent repeats** — don't propose what was used last week if alternatives exist
3. **Generate new when needed** — if the database is thin or the user wants variety, the recipe generator sub-agent creates new recipes to hit the target macros
4. **Respect user requests** — if the user asks for something specific ("carbonara," "something with chicken"), that overrides the above

```
Agent: For meal preps, here's what I'm thinking:
       
       Lunch Mon-Wed: Chicken pepperonata (your recipe, 3 servings)
       Lunch Thu-Sat: Lemon tuna pasta (new, 3 servings)
       Dinner Mon-Wed: Salmon traybake (your recipe, 3 servings)
       Dinner Fri-Sun: Chicken & chickpea stew (new, 3 servings)
       (Thu dinner = restaurant)
       
       [Approve]    [Swap something]

User:  Swap tuna pasta for carbonara
Agent: Done — carbonara for Thu-Sat lunches.
```

#### Step 4: Cooking schedule

```
Agent: Cooking schedule:
       
       Sunday: Cook lunch + dinner for Mon-Wed
       Wednesday: Cook lunch for Thu-Sat
       Friday: Cook dinner for Fri-Sun
       
       [Approve]    [I'd rather cook differently]
```

#### Step 5: Budget review and confirmation

```
Agent: Here's your week:
       
       Weekly budget: 17,052 cal | 1,050g protein
       Planned meals: 14,952 cal (87.7%)
       Fun food: 1,100 cal (6.5%)
       Restaurant: 1,000 cal (5.9%)
       
       Protein: 1,068g planned (target: 1,050g) ✓
       
       Mon  2,450 cal  148g P | Bfast 650 | Lunch 750 | Dinner 780 | Ice cream 270
       Tue  2,430 cal  152g P | Bfast 650 | Lunch 750 | Dinner 780 | -
       Wed  2,430 cal  152g P | Bfast 650 | Lunch 750 | Dinner 780 | -
       ...
       
       All batches sized. Calories and protein on target.
       
       [Confirm plan]    [Adjust something]

User:  [Confirm plan]
Agent: Plan locked. Shopping list ready.
       
       [View shopping list]    [View recipes]
```

### 7.2 Shopping List

Generated after plan confirmation. Shows aggregated ingredients grouped by category.

```
Agent: Shopping list for this week:
       
       PROTEIN
       - Chicken breast: 1.2 kg
       - Salmon fillet: 600g
       - Eggs: 12
       
       CARBS & GRAINS
       - Spaghetti: 450g
       - Potatoes: 800g
       
       VEGETABLES
       - Bell peppers: 600g
       - Onions: 3
       - Green beans: 400g
       ...
       
       [Add items]    [Share list]
```

`[Add items]` opens a text input for non-food items (water, paper towels, etc.).
`[Share list]` forwards the list as a message (to self or another chat).

### 7.3 Recipe Management

Browse and add recipes through Telegram.

**Browse:**
```
Agent: Your recipes (12 total):
       
       LUNCH & DINNER
       - Chicken Pepperonata Skillet
       - Carbonara (Healthy)
       - Salmon Traybake
       - Tuna Chickpea Stew
       ...
       
       BREAKFAST
       - Oats + Yogurt Bowl
       - Eggs & Toast
       ...
       
       [View recipe]    [Add new recipe]
```

**Add new recipe:**
```
Agent: Describe a dish — type it out or send a voice note.
       Tell me the rough ingredients and I'll structure it
       and calculate macros.

User:  [sends text or voice note]
Agent: Here's what I got:
       
       Chicken & Mushroom Rice Skillet
       780 cal | 48g protein | 35g fat | 62g carbs
       [full recipe details]
       
       [Save]    [Edit something]    [Discard]
```

---

## 8. Telegram UI

### Main menu

Persistent reply keyboard with the core actions:

```
[ Plan Week ]     [ Shopping List ]
[ My Recipes ]    [ Weekly Budget ]
```

- **Plan Week** — Enters the planning session flow (Section 7.1)
- **Shopping List** — Shows the current week's shopping list (Section 7.2)
- **My Recipes** — Browse and manage recipes (Section 7.3)
- **Weekly Budget** — Shows the current plan's budget allocation (read-only in v0.0.1)

### Interaction patterns

- **Inline keyboards** for choices within a flow (approve/swap/adjust buttons)
- **Reply keyboard** (persistent) for main navigation
- **Voice input** for any free-form input. Telegram voice messages are transcribed via Whisper and processed identically to text. Voice is the preferred low-friction input — speaking "ice cream twice and churros on Saturday" is faster than typing it.
- **Free-form text** when the user prefers typing (recipe name, event description, fun food list)
- The agent drives the conversation — users mostly tap buttons and occasionally speak or type short inputs

The harness treats voice and text identically after transcription. Every flow that accepts text input also accepts voice. No special voice-only flows.

### 8.2 Agent Architecture and Context Engineering

Reference: [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

The agent harness uses an **LLM + state machine** orchestrator pattern with **sub-agents** for heavy isolated work.

#### Orchestrator: LLM constrained by a deterministic state machine

The orchestrator is two things working together:

1. **State machine (the rails)** — Deterministic code that defines: which flow is active, which step we're on, what transitions are valid, what data is required before moving forward. The state machine never hallucinates. It enforces the flow structure.

2. **Orchestrator LLM (the driver)** — Interprets free-form user input (text or voice transcription) in the context of the current state. Generates natural, contextual responses. Extracts structured data from unstructured input (e.g., "ice cream twice and churros on Saturday" → list of fun foods with estimated calories).

The interaction loop:

```
User input (text / voice / button tap)
        │
        ▼
State machine provides current state context
(flow, step, valid actions, required data)
        │
        ▼
Orchestrator LLM interprets input
against the current state
        │
        ▼
State machine validates the interpreted action
and transitions to the next state
        │
        ▼
Orchestrator LLM generates the response
for the new state (with buttons, data, etc.)
```

**What the state machine controls:**
- Flow progression (Step 0 → Step 1 → ... → Step 5 → plan locked)
- Valid transitions (can't skip to budget review before picking recipes)
- Required data gates (can't confirm plan until all batches have recipes)
- Guard rails (rejects actions that don't match the current step)

**What the orchestrator LLM handles:**
- Interpreting free-form text/voice ("Thursday dinner out, sushi place" → MealEvent)
- Estimating calories for fun foods and restaurant meals
- Generating natural conversational responses
- Making the guided flow feel like a conversation, not a form

**What the orchestrator LLM does NOT do:**
- Decide what step comes next (state machine does this)
- Do calorie arithmetic (budget solver does this)
- Generate or scale recipes (sub-agents do this)
- Validate plans (QA gate does this)

The orchestrator's context should contain: the current flow state, the user's recent messages, and condensed results from sub-agents. It should **not** contain: raw recipe files, full plan data, tool output history from previous flows.

**Button taps bypass the LLM entirely** — they map directly to state machine transitions. Only free-form text/voice input goes through the LLM for interpretation.

#### Sub-agents

Sub-agents run with isolated context windows. They receive a focused task, do deep work, and return a condensed result (typically under 2,000 tokens). The orchestrator never sees the sub-agent's full working context.

| Sub-agent | Model | Trigger | Input | Returns |
|---|---|---|---|---|
| Recipe generator | GPT-5.4 | Planning session needs a new recipe | Target macros, cuisine preferences, meal type, constraints | Structured recipe (markdown format) |
| Recipe scaler | GPT-5.4-mini | Solver needs a recipe at a different calorie target | Original recipe + target macros | Scaled ingredient list with adjusted amounts |
| Restaurant estimator | GPT-5.4-mini | User describes a restaurant meal | Description or photo + meal context | Calorie/protein estimate with confidence |

Note: there is no separate "input interpreter" sub-agent. The orchestrator LLM handles input interpretation directly, since it already has the conversation context needed to understand what the user means.

The budget solver and QA gate are **not** sub-agents — they are deterministic code that runs in the harness directly.

#### Context compaction

The orchestrator's context rots as conversations grow. The harness implements compaction to fight this:

1. **Tool output clearing**: Raw tool outputs (recipe files, database query results, solver dumps) deep in the message history are replaced with short summaries. This is the safest, lightest-touch form of compaction.

2. **Flow boundary compaction**: When a flow completes (e.g., planning session finishes), the full conversation of that flow is compacted into a summary: "Planning session completed. Plan for Apr 6-12 created with 4 batches, 1,100 cal fun food, 1 restaurant event. Plan ID: xyz."

3. **Just-in-time retrieval**: The orchestrator holds lightweight references (recipe slugs, plan IDs), not full data. When it needs a recipe's details, it loads them on demand. This mirrors how humans use indexes rather than memorizing everything.

4. **External state as memory**: The weekly plan, budget state, and recipe database all live outside the context window (Supabase + markdown files). The orchestrator reads from them when needed rather than carrying the data in context. This means a fresh conversation can pick up exactly where the last one left off by reading external state.

#### Conversation routing

Each flow (planning, shopping, recipes) is a distinct conversation context. The orchestrator tracks which flow is active and routes messages accordingly. The `/cancel` command exits any flow and returns to the main menu.

#### First-run experience (cold start)

On first interaction, the bot has no recipes, no locked breakfast, and no previous week to reference. The first run enters a brief setup flow before the normal planning session:

1. **Welcome** — Brief intro, show main menu
2. **Set breakfast** — "What do you usually have for breakfast? Describe it or send a voice note, and I'll create your locked breakfast recipe."
3. **Generate starter recipes** — "Let's build your recipe database. Tell me 3-4 dishes you like for lunch and dinner, and I'll create recipes that hit your targets."
4. **First planning session** — Normal planning flow with the newly created recipes

After the first run, the bot drops into the standard main menu on every subsequent interaction.

---

## 9. MVP Scope

### In scope (v0.0.1)

| Feature | Description |
|---|---|
| Planning session | Full guided weekly planning flow via Telegram |
| Budget solver | Deterministic weekly budget allocation |
| Recipe database | Markdown files with CRUD via Telegram |
| Recipe scaling | Adjust portions to hit solver targets |
| Recipe generation | LLM generates new recipes to hit a calorie/protein target |
| Shopping list | Aggregated from weekly plan |
| Budget view | Read-only view of planned weekly allocation |
| Voice input | Whisper STT for all free-form inputs (planning, recipes, etc.) |
| QA gate | Validation loop for plans, recipes, and shopping lists |
| Single user | Hardcoded macro targets |

### Explicitly out of scope (v0.0.1)

| Feature | Reason | Planned for |
|---|---|---|
| Photo tracking | Needs vision model integration | v0.0.2 |
| Voice note tracking | Needs tracking/budget system (STT already available via Whisper) | v0.0.2 |
| Text-based tracking | Needs running budget state | v0.0.2 |
| Mid-week adjustment | Needs tracking first | v0.0.2 |
| Three-tier notifications | Needs tracking + adjustment | v0.0.2 |
| Proactive nudges | Needs scheduled messages | v0.0.3 |
| Breakfast variety | Nice-to-have, not core | v0.0.3 |
| Ingredient-aware suggestions | Needs ingredient inventory | v0.0.4 |
| Recipe import from URL/photo | Nice-to-have | v0.0.4 |
| User onboarding (macro calc) | Needed for multi-user | v0.1.0 |
| Multi-user support | Not needed for prototype | v0.1.0 |
| Alternative UI (web/app) | Telegram is sufficient for now | v0.1.0+ |

---

## 10. Backlog

Prioritized by value to the prototype feedback loop.

### v0.0.2 — Tracking and adjustment

The system becomes dynamic. The user can report what actually happened, and the agent rebalances.

- **Photo tracking**: Snap a meal photo, vision model estimates calories. Two taps: send photo, confirm estimate.
- **Voice note tracking**: "Had a big carbonara at that Italian place." Agent extracts estimate from voice transcription.
- **Text tracking**: Quick text message for simple tracking ("ice cream, ~300 cal").
- **Running budget**: Planned vs. actual, updated as tracking comes in.
- **Three-tier adjustment system**:
  - Silent (< 300 cal): Budget updates, no notification
  - Informational (300-800 cal cumulative): Gentle FYI with optional lever
  - Replan offer (800+ cal event or budget-threatening drift): Explicit offer to rebalance
- **Mid-week replanning**: When a deviation is large enough, agent proposes minimal adjustments to remaining uncooked days.

### v0.0.3 — Polish and proactivity

- **Planning nudge**: Agent sends one message when it's time to plan next week (configurable day/time).
- **Breakfast variety**: Agent suggests different breakfasts based on what you've had recently.
- **Recipe rotation**: Track when recipes were last used, avoid repeating too soon.
- **Week-end review**: Brief, non-judgmental summary of the week. What happened, what to adjust.

### v0.0.4 — Intelligence

- **Ingredient-aware suggestions**: "I have zucchini and peppers to use up" — agent filters recipes by ingredients.
- **Recipe import**: Send a URL, photo, or unstructured text of a recipe. Agent parses and structures it.
- **Pattern learning**: Agent notices trends (always over on Fridays, skips breakfast when busy) and adjusts planning defaults.
- **Carry-over logic**: Smart surplus/deficit handling between weeks with guardrails for large deviations.

### v0.1.0 — Multi-user readiness

- **Onboarding flow**: Calculate personalized calorie/protein targets from user data (weight, height, age, activity, goal).
- **User preferences**: Stored dietary preferences, cuisine preferences, disliked ingredients.
- **Multi-user state**: Supabase schema supports multiple users.
- **Alternative UI**: Web UI or custom app if needed. Refactor Telegram coupling at that point, not before.
