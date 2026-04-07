# Plan 014: Recipe Format Evolution

**Status:** Active
**Date:** 2026-04-07
**Affects:** `src/models/types.ts`, `src/recipes/parser.ts`, `src/agents/recipe-generator.ts`, `src/qa/validators/recipe.ts`, `recipes/*.md`, `test/fixtures/recipes/**/*.md`

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

### Step 2: Update parser to read/write `short_name`

**File:** `src/recipes/parser.ts`

**In `parseRecipe()` (line 23–52):** After reading `meta.name`, add:
```typescript
shortName: meta.short_name ?? undefined,
```

The `?? undefined` ensures missing `short_name` in YAML results in the field being absent on the object (matches the optional interface field).

**In `serializeRecipe()` (line 57–91):** Add `short_name` to the frontmatter object, conditional on presence:
```typescript
const frontmatter: Record<string, unknown> = {
  name: recipe.name,
  ...(recipe.shortName && { short_name: recipe.shortName }),
  slug: recipe.slug,
  // ... rest unchanged
};
```

Putting `short_name` right after `name` in YAML keeps the frontmatter readable.

### Step 3: Update recipe generator prompt

**File:** `src/agents/recipe-generator.ts`

**3a: Add `short_name` to output schema (in `buildSystemPrompt()`, line 231–304).**

In the OUTPUT FORMAT JSON schema block (line 292), add after `"name"`:
```json
"short_name": "string — max 25 chars, 2-3 word recognizable identity (e.g., 'Beef Tagine', 'Salmon Pasta')",
```

**3b: Add placeholder instruction to RECIPE TEXT RULES section (line 280–288).**

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
  Plain-text seasonings (salt, pepper) with no meaningful amount stay as-is — no placeholder.
  Only ingredients with a specific measured amount get a placeholder.
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

**3c: Add `short_name` to the `mapToRecipe()` function (line 315–347).**

Add after `name: raw.name`:
```typescript
shortName: raw.short_name,
```

### Step 4: Update QA validator

**File:** `src/qa/validators/recipe.ts`

**4a: Add placeholder validation.** After the existing checks (around line 126), add a new validation block:

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

### Step 5: Backfill existing recipes with `short_name`

**Production recipes** (7 files in `recipes/`):

| File | Current name | Short name |
|---|---|---|
| `ground-beef-rigatoni-bolognese.md` | Ground Beef Rigatoni Bolognese | Beef Bolognese |
| `creamy-salmon-and-shrimp-linguine.md` | Creamy Salmon and Shrimp Linguine | Salmon Shrimp Linguine |
| `moroccan-beef-tagine-style-skillet-with-lemon-couscous.md` | Moroccan Beef Tagine-Style Skillet with Lemon Couscous | Beef Tagine |
| `soy-ginger-pork-rice-bowls-broccoli-carrots-scallions.md` | Soy Ginger Pork Rice Bowls with Broccoli, Carrots and Scallions | Soy Ginger Pork Bowls |
| `chicken-black-bean-avocado-rice-bowl.md` | Chicken, Black Bean and Avocado Rice Bowl | Chicken Black Bean Bowl |
| `mediterranean-tuna-chickpea-feta-rice-bowl.md` | Mediterranean Tuna, Chickpea and Feta Rice Bowl | Tuna Chickpea Bowl |
| `salmon-avocado-toast-soft-eggs-cinnamon-yogurt.md` | Salmon-Avocado Toast with Soft Eggs and Cinnamon Yogurt | Salmon Toast & Eggs |

Add `short_name: <value>` to each file's YAML frontmatter, immediately after the `name:` line.

**Fixture recipes** (10 files across `test/fixtures/recipes/six-balanced/` and `test/fixtures/recipes/minimal/`):

Same recipes duplicated in fixture sets. Apply identical `short_name` values. The `six-balanced/` set has all 7 recipes; the `minimal/` set has 3 (bolognese, breakfast, chicken bowl).

**Note:** Existing recipes do NOT get `{placeholder}` or timing/grouping updates. Those rules apply to newly generated recipes only. Backfilling placeholders into 7 hand-written recipe bodies would change their text, which would break scenario recordings (the harness compares exact body text). The short_name is a frontmatter-only addition that doesn't affect body text or scenario output.

### Step 6: Verify

Run `npm test` to confirm all scenarios still pass. The changes are:
- `shortName` is optional on Recipe, so existing parsing works.
- Parser reads `short_name` from YAML (present in backfilled files) or returns `undefined` (harmless).
- Generator prompt changes only affect new generations — existing recordings are fixture-based.
- QA validator additions are additive (new checks, no removal of existing ones).
- Recipe body text is unchanged in all existing files.

## Progress

- [ ] Step 1: Add `shortName` to Recipe interface
- [ ] Step 2: Update parser (`parseRecipe` + `serializeRecipe`)
- [ ] Step 3a: Add `short_name` to generator output schema
- [ ] Step 3b: Add placeholder + timing + grouping instructions to generator prompt
- [ ] Step 3c: Add `shortName` mapping in `mapToRecipe()`
- [ ] Step 4a: Add placeholder validation to QA validator
- [ ] Step 4b: Add `shortName` validation to QA validator
- [ ] Step 5: Backfill `short_name` in production recipes (7 files)
- [ ] Step 5: Backfill `short_name` in fixture recipes (10 files)
- [ ] Step 6: Run `npm test` and verify green

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

1. **`npm test` passes** — all existing scenarios green. The parser change is backward-compatible (optional field), the generator prompt change only affects new LLM calls (not fixture replays), and recipe body text is unchanged.

2. **Manual verification of parser round-trip:** Parse a backfilled recipe, serialize it, and confirm `short_name` appears in YAML output at the correct position.

3. **Manual verification of QA validator:**
   - Create a test recipe body with a valid placeholder `{olive oil}` and confirm no error.
   - Create a test recipe body with a broken placeholder `{nonexistent}` and confirm it produces an error.
   - Create a recipe with `shortName` of 30 chars and confirm it produces an error.
   - Create a recipe with no `shortName` and confirm it produces a warning (not an error).

4. **Visual inspection of generator prompt:** Read the updated `buildSystemPrompt()` output and verify: `short_name` is in the JSON schema, placeholder rules are clear, timing requirement is stated, seasoning grouping is instructed.

5. **Backfill spot-check:** Open 2-3 backfilled recipes and confirm `short_name` is present, ≤25 chars, and recognizable.

# Feedback

