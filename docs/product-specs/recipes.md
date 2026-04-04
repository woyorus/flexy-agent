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
- QA: max 2 correction rounds. Checks cal within 3%, protein within 5%. Corrections adjust fat first, carb side second, never reduce protein source.

### Slug constraints

Recipe slugs must be max 50 chars (enforced in the generator prompt). This ensures they fit in Telegram callback data after truncation.

## Refinement

Multi-turn refinement via conversation history. The LLM sees the recipe as its own prior output and makes targeted changes (e.g., "swap avocado oil with olive oil") without regenerating from scratch.

## Scaling

Recipe scaler sub-agent (`src/agents/recipe-scaler.ts`):
- Model: GPT-5.4-mini
- Input: original recipe + target macros
- Output: scaled ingredient list with adjusted amounts
- Uses ingredient roles to decide what to adjust

## Database (`src/recipes/database.ts`)

In-memory recipe database backed by markdown files. Loaded at startup from `recipes/` directory.

- `getAll()` — all recipes
- `getBySlug(slug)` — exact match
- `findBySlugPrefix(prefix)` — prefix match (for truncated callback data)
- `getByMealType(type)` — filter by meal type
- `save(recipe)` — write to markdown file + add to in-memory cache

## Nutritional source of truth

The LLM's training knowledge is the source for calorie/macro estimates. The QA gate checks internal consistency (do ingredient amounts plausibly match stated totals?) but does not validate against an external nutritional database.
