# Plan 014: Recipe Format Evolution

**Status:** Complete
**Date:** 2026-04-07
**Affects:** `src/models/types.ts`, `src/recipes/parser.ts`, `src/agents/recipe-generator.ts`, `src/agents/recipe-flow.ts`, `src/qa/validators/recipe.ts`, `recipes/*.md`, `test/fixtures/recipes/**/*.md`

## Problem

The recipe format lacks several capabilities needed for cook-time rendering (Agent B) and compact UI displays:

1. **No short names.** Recipe names like "Mediterranean Tuna, Chickpea and Feta Rice Bowl" (52 chars) are too long for plan views, week overviews, and shopping list headers. The UI architecture spec calls for short names (~25 chars, e.g., "Tuna Chickpea Bowl") used in 90% of surfaces, with the full name reserved for the recipe detail view.

2. **No ingredient placeholders in steps.** Steps currently reference ingredients by name only with no amounts (e.g., "Add the ground beef"). Cook-time rendering needs `{ingredient_name}` placeholders in the step text so the renderer can inline batch-total or per-serving amounts contextually. Without placeholders, the user has to scroll between the ingredient list and the steps — the #1 UX pain point identified in ui-architecture.md.

3. **No explicit timing on heat steps.** Steps like "cook until softened" or "until browned" give no time anchor. Every heat step must include a duration (e.g., "**4-5 min**") for a user who doesn't know what "golden" looks like.

4. **Seasonings not grouped in prose.** To-taste seasonings (salt, pepper, chili flakes) appear as separate lines in steps. The generator should group them on one line in the recipe body (e.g., "Season with salt, pepper, and chili flakes"). The YAML ingredient list keeps them as separate entries — only the prose changes.

This task produces the new recipe data shape that Agent B (Coordinated Task: Recipe Display Contexts) depends on. It has no dependencies itself and can run immediately.

## Plan of work

### Step 1: Add `shortName` to the Recipe interface

**File:** `src/models/types.ts` (line 37–51, `Recipe` interface)

Add `shortName?: string` as an optional field after `name`:

```typescript
export interface Recipe {
  name: string;
  shortName?: string;  // NEW — max ~25 chars, for compact display
  slug: string;
  // ... rest unchanged
}
```

Optional so that existing recipes parse without breaking and `npm test` stays green before any other changes.

**Also update doc comments in `types.ts`:**
- Recipe type doc block (lines 25–36): Mention the `{ingredient_name}` placeholder system — clarify that the `body` field may contain `{ingredient_name}` placeholders resolved at render time, while raw amounts still live in YAML only.
- `body` field comment (line 49): Update from "No amounts" to note that `{ingredient_name}` placeholders may appear and are resolved at render time by the caller; raw amounts remain in YAML.

### Step 2: Update parser to read/write `short_name`

**File:** `src/recipes/parser.ts`

**In `parseRecipe()` (line 23–52):** After reading `meta.name`, add `shortName` conditionally using spread syntax:
```typescript
...(meta.short_name !== undefined && { shortName: meta.short_name }),
```

**Why spread and not `shortName: meta.short_name`:** When `meta.short_name` is absent, `shortName: meta.short_name` creates an own property with value `undefined`. The database round-trip test (`deepStrictEqual(loaded, recipe)`) compares own-property sets — a `{ shortName: undefined }` object is NOT equal to an object without the property. The spread form only adds the property when a value is present.

**In `serializeRecipe()` (line 57–91):** Add `short_name` to the frontmatter object, conditional on presence. Match the actual code pattern (plain object literal, not `Record<string, unknown>`):
```typescript
const frontmatter = {
  name: recipe.name,
  ...(recipe.shortName !== undefined && { short_name: recipe.shortName }),
  slug: recipe.slug,
  // ... rest unchanged
};
```

Putting `short_name` right after `name` in YAML keeps the frontmatter readable.

**Also update the parser header comment (parser.ts:1–11):** The current header says "Amounts live only in YAML. Steps reference ingredients by name, not amount." After this plan, new recipe bodies contain `{ingredient_name}` placeholders resolved at render time. Update the header to clarify that bodies may contain `{ingredient_name}` placeholders; raw amounts still live in YAML only.

### Step 3: Update recipe generator prompt

**File:** `src/agents/recipe-generator.ts`

**3a: Add `short_name` to output schema (in `buildSystemPrompt()`, line 231–304).**

In the OUTPUT FORMAT JSON schema block (line 293, after the `"name"` field), add:
```json
"short_name": "string — max 25 chars, 2-3 word recognizable identity (e.g., 'Beef Tagine', 'Salmon Pasta')",
```

**3b: Update the `body` field description in the OUTPUT FORMAT JSON schema block.**

The current `body` description at line 303 reads: `"No ingredient amounts in the text."` This contradicts the placeholder instructions being added in step 3c. Update it to:
```json
"body": "string — the full recipe text (description + steps + storage notes + tips). Use {ingredient_name} placeholders in steps (see RECIPE TEXT RULES). Use newlines for formatting. Steps as numbered list."
```

**3c: Add placeholder instruction to RECIPE TEXT RULES section (line 280–288).**

Replace the current step-amount rule with expanded instructions:

```
## RECIPE TEXT RULES
- Write the recipe body as natural, human-readable text.
- Include a brief description of the dish (1-2 sentences — what it is, what makes it good).
- Steps are numbered and use `{ingredient_name}` placeholders for amounts:
  CORRECT: "Cook {penne pasta} until al dente, **10-11 min**."
  CORRECT: "Heat {olive oil} in a large skillet."
  WRONG: "Cook 65g penne pasta until al dente." (hardcoded amount)
  WRONG: "Cook the pasta until al dente." (no placeholder — user can't know the amount)
  The placeholder name MUST exactly match an ingredient's `name` field in the ingredients array.
  "To-taste" seasoning — ingredients that a cook applies freely without measuring (salt, pepper,
  chili flakes) — stay as-is in prose even though they have YAML amounts. No placeholder.
  Use `role: seasoning` as the signal: if it's a role-seasoning ingredient with a small nominal
  YAML amount (e.g., 1g salt, 0.5g pepper) that doesn't materially affect macros, treat it as to-taste.
  Only ingredients whose amount directly affects macros or cooking outcome get a placeholder:
  proteins, carbs, oils, specific spices in meaningful amounts (e.g., "2 tsp smoked paprika")
  → those DO get a placeholder: "Add {smoked paprika}, stir **1 min**."
- Every heat step MUST include an explicit duration:
  CORRECT: "Sear salmon cubes without moving, **2 min per side**."
  CORRECT: "Cook **4-5 min** until softened."
  WRONG: "Cook until golden." (no time anchor)
  WRONG: "Simmer until thickened." (needs "**15-20 min** until thickened")
- Group to-taste seasonings on one line in the prose:
  CORRECT: "Season with salt, pepper, and chili flakes."
  WRONG: "Add the salt. Add the pepper. Add the chili flakes." (three lines for to-taste items)
  Only seasonings with specific amounts (e.g., "2 tsp smoked paprika") get called out individually.
- Include: prep time, equipment needed, storage, reheating instructions.
- Include practical tips or simple variations if relevant.
```

**3d: Add `shortName` to the `mapToRecipe()` function (line 315–347).**

Add after `name: raw.name` using conditional spread (same reason as parser — avoid own `undefined` property):
```typescript
...(raw.short_name !== undefined && { shortName: raw.short_name as string }),
```

**3e: Update `recipeToRawJson()` in `src/agents/recipe-flow.ts` (line 78–97).**

`recipeToRawJson()` serializes a `Recipe` back to the LLM's raw JSON format for multi-turn refinement. Without `short_name` here, the LLM won't see the short name during edits and will omit it from its response — the field would be lost on every refinement.

After `name: recipe.name`, add:
```typescript
...(recipe.shortName !== undefined && { short_name: recipe.shortName }),
```

This conditionally includes `short_name` so the LLM can preserve or refine it during recipe editing.

### Step 4: Update QA validator

**File:** `src/qa/validators/recipe.ts`

**4a: Add placeholder validation.** Before the `return` statement (line 142), add a new validation block:

```typescript
// Placeholder validation: every {placeholder} in the body must match an ingredient name
if (recipe.body) {
  const placeholders = recipe.body.match(/\{([^}]+)\}/g) ?? [];
  const ingredientNames = new Set(
    (recipe.ingredients ?? []).map((ing) => ing.name.toLowerCase())
  );
  for (const ph of placeholders) {
    const name = ph.slice(1, -1).toLowerCase(); // strip { }
    if (!ingredientNames.has(name)) {
      errors.push(`Placeholder ${ph} in recipe body does not match any ingredient name.`);
    }
  }
}
```

**4b: Add `short_name` validation.** After the placeholder check:

```typescript
// Short name validation
if (!recipe.shortName) {
  warnings.push('Missing short_name (recommended for compact display).');
}
if (recipe.shortName && recipe.shortName.length > 25) {
  errors.push(`short_name "${recipe.shortName}" exceeds 25 chars (${recipe.shortName.length}).`);
}
```

Note: missing `shortName` is a warning (migration period), but exceeding the length limit is an error.

**4c: Write unit tests for the new QA rules.** Create `test/unit/recipes-validator.test.ts` following the pattern of `test/unit/recipes-parser.test.ts`. It will be auto-discovered by `npm test`. Tests to write:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRecipe } from '../../src/qa/validators/recipe.js';

// Helper: minimal valid Recipe for testing
function makeRecipe(overrides = {}) { /* slug, name, body, ingredients, perServing, ... */ }

test('validateRecipe: valid {olive oil} placeholder → no error', () => {
  const recipe = makeRecipe({ body: 'Heat {olive oil}.', ingredients: [{ name: 'olive oil', ... }] });
  const result = validateRecipe(recipe);
  assert.ok(!result.errors.some(e => e.includes('Placeholder')));
});

test('validateRecipe: {nonexistent} placeholder → error', () => {
  const recipe = makeRecipe({ body: 'Heat {nonexistent}.', ingredients: [{ name: 'olive oil', ... }] });
  const result = validateRecipe(recipe);
  assert.ok(result.errors.some(e => e.includes('{nonexistent}')));
});

test('validateRecipe: shortName > 25 chars → error', () => {
  const recipe = makeRecipe({ shortName: 'A'.repeat(26) });
  assert.ok(validateRecipe(recipe).errors.some(e => e.includes('exceeds 25')));
});

test('validateRecipe: missing shortName → warning, not error', () => {
  const recipe = makeRecipe({ shortName: undefined });
  const result = validateRecipe(recipe);
  assert.ok(result.warnings.some(w => w.includes('short_name')));
  assert.ok(!result.errors.some(e => e.includes('short_name')));
});

test('validateRecipe: case-insensitive placeholder match → no error', () => {
  const recipe = makeRecipe({ body: 'Heat {Olive Oil}.', ingredients: [{ name: 'olive oil', ... }] });
  assert.ok(!validateRecipe(recipe).errors.some(e => e.includes('Placeholder')));
});
```

**Note on test scenarios:** None of the 14 existing scenarios exercise the recipe generation QA path — they are all planning-flow scenarios. The `shortName` warning will not surface in any `recorded.json` comparison. `npm test` will remain green immediately after Step 4. Backfilling fixture recipe files (Step 5) is for parser correctness (so `shortName` is available when recipes are loaded), not for suppressing QA warnings.

### Step 5: Backfill existing recipes with `short_name`

**Production recipes** (7 files in `recipes/`):

| File | Current name | Short name |
|---|---|---|
| `ground-beef-rigatoni-bolognese.md` | Ground Beef Rigatoni Bolognese | Beef Bolognese |
| `creamy-salmon-and-shrimp-linguine.md` | Creamy Salmon and Shrimp Linguine | Salmon Shrimp Linguine |
| `moroccan-beef-tagine-style-skillet-with-lemon-couscous.md` | Moroccan Beef Tagine-Style Skillet with Lemon Couscous | Beef Tagine |
| `soy-ginger-pork-rice-bowls-broccoli-carrots-scallions.md` | Soy Ginger Pork Rice Bowls with Broccoli, Carrots and Scallions | Soy Ginger Pork Bowls |
| `chicken-black-bean-avocado-rice-bowl.md` | Chicken, Black Bean, Corn and Avocado Rice Bowl with Tomato-Lime Salsa | Chicken Black Bean Bowl |
| `mediterranean-tuna-chickpea-feta-rice-bowl.md` | Mediterranean Tuna, Chickpea and Feta Rice Bowl | Tuna Chickpea Bowl |
| `salmon-avocado-toast-soft-eggs-cinnamon-yogurt.md` | Salmon-Avocado Toast with Soft Eggs and Cinnamon Yogurt | Salmon Toast & Eggs |

Add `short_name: <value>` to each file's YAML frontmatter, immediately after the `name:` line.

**Fixture recipes** (10 recipe `.md` files across `test/fixtures/recipes/six-balanced/` and `test/fixtures/recipes/minimal/`, excluding any `README.md` files):

Same recipes duplicated in fixture sets. Apply identical `short_name` values. The `six-balanced/` set has all 7 recipes; the `minimal/` set has 3 (bolognese, breakfast, chicken bowl).

**Note:** Existing recipes do NOT get `{placeholder}` or timing/grouping updates. Those rules apply to newly generated recipes only. Backfilling placeholders into 7 hand-written recipe bodies would change their text, which would break scenario recordings (the harness compares exact body text). The short_name is a frontmatter-only addition that doesn't affect body text or scenario output.

### Step 6: Verify

**6a: Run scenario tests:**
```
npm test
```
Confirms all planning-flow scenarios still pass. None of these exercise recipe generation or QA, so they should be green immediately.

**6b: Run parser, database, and validator unit tests:**
```
npx tsx --test --import ./test/setup.ts test/unit/recipes-parser.test.ts test/unit/recipes-database.test.ts test/unit/recipes-validator.test.ts
```
These tests do parser round-trips, `deepStrictEqual(loaded, recipe)` save/load checks, and QA validator coverage. Must pass after Steps 2, 4, and 5. (These are also run by `npm test` — running them separately is optional, useful for faster iteration during implementation.)

Why changes are safe:
- `shortName` is optional on Recipe, so existing parsing works.
- Parser and `mapToRecipe` use conditional spread — no `shortName: undefined` own property on legacy recipes.
- Generator prompt changes only affect new LLM calls — existing scenario recordings are fixture-based.
- QA validator additions are additive.
- Recipe body text is unchanged in all existing files.

## Progress

- [x] Step 1: Add `shortName` to Recipe interface + update `types.ts` doc comments
- [x] Step 2: Update parser (`parseRecipe` + `serializeRecipe` + parser header comment)
- [x] Step 3a: Add `short_name` to generator output schema
- [x] Step 3b: Update `body` field description in generator output schema
- [x] Step 3c: Add placeholder + timing + grouping instructions to generator prompt
- [x] Step 3d: Add `shortName` mapping in `mapToRecipe()` (conditional spread)
- [x] Step 3e: Update `recipeToRawJson()` in `recipe-flow.ts` to include `short_name`
- [x] Step 4a: Add placeholder validation to QA validator
- [x] Step 4b: Add `shortName` validation to QA validator
- [x] Step 4c: Write `test/unit/recipes-validator.test.ts` (placeholder + shortName unit tests)
- [x] Step 5: Backfill `short_name` in production recipes (7 files)
- [x] Step 5: Backfill `short_name` in fixture recipes (10 recipe files)
- [x] Step 6a: Run `npm test` (scenarios) — green
- [x] Step 6b: Run parser + database unit tests — green

## Decision log

- **Decision:** Make `shortName` optional on the Recipe interface, not required.
  **Rationale:** The backlog explicitly says "optional so existing recipes parse without breaking." This also means consumers must use `recipe.shortName ?? recipe.name` as a fallback. A future cleanup can make it required once all recipes have short names.
  **Date:** 2026-04-07

- **Decision:** Do NOT backfill `{placeholder}` syntax into existing recipe bodies.
  **Rationale:** Existing recipe bodies are captured in scenario recordings (`recorded.json`). Changing body text would invalidate recordings. The placeholder format applies to newly generated recipes only. When the user generates new recipes post-0.0.4, they'll have placeholders natively. Existing recipes still work — they just won't have inline amounts in cook-time view until they're regenerated.
  **Date:** 2026-04-07

- **Decision:** Placeholder match is case-insensitive.
  **Rationale:** The LLM may produce `{Olive Oil}` while the ingredient is `olive oil`. Case-insensitive matching prevents false QA failures from capitalization variance. The QA validator lowercases both sides.
  **Date:** 2026-04-07

- **Decision:** Grouped seasonings are a prompt-only change, no schema change.
  **Rationale:** Per the backlog: "no schema change." Individual seasonings remain separate entries in YAML for shopping list aggregation and scaling. Only the generated prose groups them on one line. No new field like `displayGroup` needed.
  **Date:** 2026-04-07

- **Decision:** `recipe-scaler.ts` is NOT in scope.
  **Rationale:** Confirmed by reading the file. The scaler returns `ScaleRecipeOutput` (scaledIngredients + actualPerServing), not a Recipe object. It has no recipe metadata to preserve. `shortName` lives on the Recipe in the DB, untouched by scaling. No changes needed.
  **Date:** 2026-04-07

## Validation

1. **Automated: `npm test`** — runs all 14 planning-flow scenarios + all unit tests in `test/unit/` (including the new `recipes-validator.test.ts` from Step 4c). Everything must be green before the plan is considered done.

2. **Automated: parser + database unit tests** — covered by `npm test` via Step 6b. The round-trip test in `recipes-parser.test.ts` reads the backfilled fixture files and exercises `short_name` parse → serialize → parse for all 7 six-balanced recipes. The database test exercises `deepStrictEqual(loaded, recipe)` which catches any own-property drift from the spread changes in parser/mapToRecipe.

3. **Automated: QA validator unit tests** — covered by `npm test` via `test/unit/recipes-validator.test.ts` written in Step 4c. Tests the placeholder validation (valid match, broken placeholder, case-insensitive match) and `shortName` rules (too long → error, missing → warning).

4. **Manual: generator prompt and `recipeToRawJson` end-to-end.** Run `npm run dev` and generate one real recipe of each meal type (at minimum one lunch/dinner). Verify the generated recipe:
   - Has a `short_name` in YAML frontmatter (≤25 chars, recognizable)
   - Has `{ingredient_name}` placeholders in step text for measured ingredients
   - Every heat step has an explicit duration in bold (`**N-N min**`)
   - To-taste seasonings are grouped on one line ("Season with salt, pepper, and chili flakes.")
   - Then open the recipe in the bot's edit flow (if accessible) and confirm `shortName` persists through a refinement cycle (tests `recipeToRawJson` in recipe-flow.ts).

5. **Backfill spot-check:** Open 2-3 backfilled recipes and confirm `short_name` is present, ≤25 chars, and recognizable.
