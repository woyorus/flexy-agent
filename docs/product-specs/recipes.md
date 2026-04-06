# Recipes

> Scope: Recipe format, generation constraints, scaling logic, meal types, structure system. See also: [data-models.md](./data-models.md) for the Recipe interface, [solver.md](./solver.md) for how the solver uses recipe macros.

Source: `src/recipes/parser.ts`, `src/recipes/database.ts`, `src/recipes/renderer.ts`, `src/agents/recipe-generator.ts`, `src/agents/recipe-scaler.ts`

## Storage format

Recipes are markdown files with YAML frontmatter in the `recipes/` directory. Both human-readable and machine-parseable.

### YAML frontmatter

```yaml
---
name: Chicken Pepperonata Skillet
slug: chicken-pepperonata-skillet        # max 50 chars
meal_types: [lunch, dinner]
cuisine: italian
tags: [one-pan, chicken, meal-prep]
prep_time_minutes: 30
structure:
  - type: main
    name: Chicken Pepperonata
  - type: carb_side
    name: Basmati Rice
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
    component: Chicken Pepperonata       # links to structure[].name
  - name: basmati rice
    amount: 75
    unit: g
    role: carb
    component: Basmati Rice
storage:
  fridge_days: 3
  freezable: true
  reheat: Pan on medium heat, 3-4 min.
---
```

### Markdown body

Free-form text: description, steps, notes, tips. Steps reference ingredients **by name only, never by amount** — amounts come from YAML and are rendered dynamically (supports scaling).

## Structure system

Every recipe has a `structure` array defining its meal composition:

| Type | Used by | Examples |
|---|---|---|
| `main` | Lunch, dinner | "Chicken Pepperonata", "Salmon Fillet" |
| `carb_side` | Lunch, dinner | "Basmati Rice", "Roasted Potatoes" |
| `side` | Lunch, dinner | "Side Salad", "Steamed Vegetables" |
| `breakfast_component` | Breakfast | "Avocado Toast", "Soft Scrambled Eggs" |

Each ingredient has a `component` field linking it to a structure entry by name. This enables:
- Structured display (renderer groups ingredients by component)
- Component-aware scaling (the scaler adjusts components independently)

Breakfast recipes use `breakfast_component` for all components. Lunch/dinner use `main` + optional `carb_side`/`side`.

## Ingredient roles

The `role` field tells the scaler which ingredients to adjust when scaling to a different calorie target:

| Role | Scaling behavior | Examples |
|---|---|---|
| `protein` | Adjust last (protect protein) | Chicken, fish, eggs, legumes |
| `carb` | Adjust first (main calorie lever) | Pasta, rice, potatoes, bread |
| `fat` | Adjust second | Olive oil, cheese, nuts |
| `vegetable` | Keep stable (volume, nutrition) | Peppers, tomatoes, onion |
| `base` | Keep stable (recipe structure) | Canned tomatoes, broth |
| `seasoning` | Keep stable | Salt, herbs, spices, garlic |

## Generation

Recipe generation uses the recipe-generator sub-agent (`src/agents/recipe-generator.ts`):
- Model: GPT-5.4 with high reasoning
- Input: meal type, target macros (cal/protein/fat/carbs), user preferences, food profile
- Output: complete Recipe object in JSON
- Target macros come from `targetsForMealType()` in `src/agents/recipe-flow.ts` (exported and reused by plan-flow.ts for gap recipes): breakfast = 27% of daily, lunch/dinner = 33% each of daily (~804 cal at 2,436 daily target). The remaining ~7% covers the protected treat budget (5%) and the flex bonus (~2%).
- QA correction loop (max 2 rounds) checks three things:
  1. **Calories vs target**: ±3% tolerance
  2. **Protein vs target**: ±5% tolerance
  3. **Atwater macro/calorie consistency** (`MACRO_CAL_TOLERANCE = 0.05`): stated calories must equal `4·protein + 4·carbs + 9·fat` within ±5%. This catches incoherent macros where the LLM picks numbers that don't math out.

Corrections adjust fat first, carb side second, never reduce protein source. The correction prompt explicitly tells the LLM to recompute the Atwater formula before returning.

### Slug constraints

Recipe slugs must be max 50 chars (enforced in the generator prompt). This ensures they fit in Telegram callback data after truncation.

## Refinement

Multi-turn refinement via conversation history. The LLM sees the recipe as its own prior output and makes targeted changes (e.g., "swap avocado oil with olive oil") without regenerating from scratch.

## Scaling

Recipe scaler sub-agent (`src/agents/recipe-scaler.ts`). Runs at plan approval time in `buildNewPlanSession` — every batch is scaled to its solver-assigned per-slot target before the plan session and batches are persisted.

- **Model**: GPT-5.4-mini, low reasoning
- **Input**: original recipe, target calories, `calorieTolerance` (±20 cal from `config.planning.scalerCalorieTolerance`), target protein, servings
- **Output**: scaled ingredient list with `{ name, amount, unit, totalForBatch }` per ingredient, plus `actualPerServing` macros
- **Uses ingredient roles** to decide what to adjust:
  - `carb` adjusted first (main calorie lever)
  - `fat` adjusted second
  - `protein` stays precise (±2g — satiety driver)
  - `vegetable`, `base`, `seasoning` stay stable
- **Tolerance is a feature**: the ±20 cal range lets the scaler pick clean, measurable amounts (45g dry pasta instead of 47g, whole or half teaspoons instead of 0.7 tbsp). LLM macro estimates are ±10% by nature, so false precision beyond ~20 cal is illusory. Natural variance across meals is absorbed by the treat budget and feels more human.
- **Atwater consistency check**: After the first call, the scaler validates `actualPerServing.calories ≈ 4·P + 4·C + 9·F` within ±5%. If off, retries once with a correction message in the conversation history. On second failure, logs an error and proceeds (best effort).
- **Failure fallback**: If the LLM call throws (timeout, malformed JSON), the caller falls back to `recipe.ingredients × servings` at base amounts. Shopping list generation still works; `actualPerServing` falls back to `recipe.perServing`.

## Database (`src/recipes/database.ts`)

In-memory recipe database backed by markdown files. Loaded at startup from `recipes/` directory.

- `getAll()` — all recipes
- `getBySlug(slug)` — exact match
- `findBySlugPrefix(prefix)` — prefix match (for truncated callback data)
- `getByMealType(type)` — filter by meal type
- `save(recipe)` — write to markdown file + add to in-memory cache

## Nutritional source of truth

The LLM's training knowledge is the source for calorie/macro estimates. The QA gate checks internal consistency (do ingredient amounts plausibly match stated totals?) but does not validate against an external nutritional database.
