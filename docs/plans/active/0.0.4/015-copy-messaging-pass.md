# Plan 015: Copy and Messaging Quality Pass + Free-Text Fallback

**Status:** Active
**Date:** 2026-04-07
**Affects:** `src/telegram/formatters.ts`, `src/telegram/core.ts`, `src/agents/plan-flow.ts`, `src/agents/recipe-flow.ts`, `src/recipes/renderer.ts`, `src/telegram/keyboards.ts`

## Problem

The product's user-facing copy has three classes of issues:

1. **No Telegram markdown formatting.** Every message is plain text — no bold headers, no italic secondary context, no visual hierarchy. The user scanning a plan proposal or recipe sees a wall of undifferentiated text. The ui-architecture spec defines a clear hierarchy: **bold** for headers/names/key numbers, _italic_ for secondary context, `monospace` for amounts sparingly.

2. **Internal jargon leaks into user-visible messages.** Several strings use developer terminology the user should never see:
   - `formatters.ts:60` — "All batches sized. Calories and protein on target." ("batches sized" is solver jargon)
   - `core.ts:693` — "No active plan yet. Plan your week first!" ("active plan" is internal)
   - `core.ts:696` — "No active plan yet." (same)
   - `plan-flow.ts:1830` — "Meal prep:" / "Meal prep (each ~N cal/serving):" ("Meal prep" is acceptable but could be warmer)
   - `plan-flow.ts:1810` — "From prior plan:" (references internal concept of prior plan sessions)
   - `plan-flow.ts:722` — "Plan locked for ... Shopping list ready." (uses exclamation-mark-free language already, but "Plan locked" is system language)
   - `recipe-flow.ts:260` — "targets: 804 cal, 66g P, 27g F, 80g C" (exposes raw macro targets to user — calorie-forward)

3. **The free-text fallback is a dead end.** When the user types something outside a flow (core.ts:865), they get: `"Use the menu buttons below to get started."` — a dismissive one-liner regardless of whether they have a plan, are viewing a recipe, or just opened the app. The backlog specifies a lifecycle-aware replacement using Phase 0's `getPlanLifecycle()` and `session.surfaceContext`.

**Dependency:** This task depends on ALL other v0.0.4 tasks landing first. It is a final polish pass. If run before other tasks, it polishes messages that will be rewritten by those tasks. Phase 0 must deliver `getPlanLifecycle()`, `session.surfaceContext`, and `session.lastRecipeSlug` before the free-text fallback can be lifecycle-aware.

## Plan of work

### Step 1: Audit and catalog every user-visible string

Before changing anything, build the complete inventory. Every `sink.reply(...)`, every `text:` return in flow handlers, every formatter output, every button label.

**Files to audit:**

- `src/telegram/core.ts` — all `sink.reply(...)` calls (~30 call sites)
- `src/telegram/formatters.ts` — 5 exported formatters
- `src/agents/plan-flow.ts` — all `text:` returns in FlowResponse (~25 call sites)
- `src/agents/recipe-flow.ts` — all `text:` returns in FlowResponse (~10 call sites)
- `src/recipes/renderer.ts` — `renderRecipe()` and `renderRecipeSummary()`
- `src/telegram/keyboards.ts` — all button labels

### Step 2: Jargon removal

Replace internal terminology with user language. Each item below is a specific code change:

**`src/telegram/formatters.ts`:**
- Line 60: `"All batches sized. Calories and protein on target."` → `"Calories and protein on target."` (remove "batches sized" — meaningless to user)
- Line 23: `"Here's your week:\n\n"` → `"*Here's your week:*\n\n"` (bold header, see Step 3)
- Line 24: `"Weekly budget:"` — acceptable as-is (user understands "budget")
- Line 70: `"Shopping list for this week:\n"` — acceptable
- Line 93: Recipe display in `formatRecipe` — no jargon, but needs markdown (Step 3)
- Line 148: `formatCookingSchedule` — `"Cook ${batch.mealType} for ${days}: ${name} (${batch.servings} servings)"` — "batch" not visible to user but the phrasing "Cook lunch for Mon-Wed" is fine

**`src/telegram/core.ts`:**
- Line 248: `"Welcome to Flexie! Use the menu below to get started."` — tone check: the exclamation mark violates the spec ("no exclamation marks on routine actions"). → `"Welcome to Flexie. Use the menu below to get started."`
- Line 382: `"Shopping list generation is coming soon!"` — remove exclamation mark → `"Shopping list generation is coming soon."`
- Line 410: `"Plan kept. Tap Plan Week again to plan the week after."` — acceptable
- Line 420: `"✓ Breakfast: ${name}\n\nAny meals you'll eat out this week?"` — acceptable
- Line 651: `"No recipes yet. Let's create your first one!\n\nWhat type?"` — exclamation mark → `"No recipes yet. Let's create your first one.\n\nWhat type?"`
- Line 667: `"You need some lunch/dinner recipes first. Add a few, then come back to plan your week!"` — remove exclamation → `"You need some lunch/dinner recipes first. Add a few, then come back to plan your week."`
- Line 693: `"No active plan yet. Plan your week first!"` → `"No plan for this week. Tap Plan Week to get started."` (remove "active plan" jargon + exclamation)
- Line 696: `"No active plan yet."` → `"No plan for this week."` (remove "active plan" jargon)
- Line 786: `"Generating your recipe — this usually takes a minute or two..."` — acceptable tone

**`src/agents/plan-flow.ts`:**
- Line 722: `"Plan locked for ${...}. Shopping list ready."` → `"Plan set for ${...}. Shopping list ready."` ("locked" is system language; "set" is user language)
- Line 1805: `"Breakfast (daily): ${name} — ${cal} cal"` — the "cal" amount here is informational during planning review, acceptable
- Line 1810: `"From prior plan:"` → `"Carried over:"` (user doesn't think in "plan sessions")
- Line 1830: `"Meal prep:"` / `"Meal prep (each ~N cal/serving):"` — acceptable user language, keep as-is
- Line 1889: `"Cook:"` header — acceptable

**`src/agents/recipe-flow.ts`:**
- Line 260: `"${mealType} recipe — targets: ${cal} cal, ${prot}g P, ${fat}g F, ${carbs}g C.\n\nDescribe what you want..."` — This exposes raw macro targets. Per the spec, avoid calorie-forward messaging. → `"${capitalize(mealType)} recipe.\n\nDescribe what you want (cuisine, ingredients, style) or just say \"surprise me.\""` (remove target numbers — the system uses them internally but the user doesn't need to see them)

**`src/telegram/keyboards.ts`:**
- Button labels audit: "Keep it", "Change this week", "No events this week", "Add event", "Approve", "Swap something", "Confirm plan", "Adjust something", "View shopping list", "View recipes", "Save", "Refine", "New recipe", "Discard", "Breakfast/Lunch/Dinner", "Generate it", "I have an idea", "Pick from my recipes", "Use it", "Different one", "Replan it", "Keep current plan", "Looks good!", "← Prev", "Next →", "← Back to recipes", "Edit", "Delete", "Add new recipe"
- `"Looks good!"` (line 206) — exclamation mark on a routine action → `"Looks good"` (remove exclamation)
- All other labels are clean — no jargon found

### Step 3: Telegram markdown formatting pass

Apply the hierarchy defined in `ui-architecture.md` § Copy and messaging tone. The rule: **bold** for headers/recipe names/key numbers the user should see first when scanning. _Italic_ for secondary context, tips, status notes. `Monospace` sparingly for amounts. Don't over-format.

Note: Telegram uses MarkdownV2 syntax. The grammY `reply` method handles escaping when `parse_mode` is set. Check whether the existing `sink.reply` calls pass `parse_mode`. If not, this step may need to add `parse_mode: 'MarkdownV2'` to every reply, or the formatting will render as literal asterisks. **This is a critical discovery step** — if the codebase doesn't currently use parse_mode anywhere, enabling it across all messages is a non-trivial change (MarkdownV2 requires escaping special characters like `.`, `!`, `-`, `(`, `)` etc.).

If parse_mode is not viable without a large escaping overhaul, fall back to **plain-text visual hierarchy** using Unicode and whitespace: uppercase section headers, em-dash separators, bullet points. This achieves 80% of the formatting goal without MarkdownV2 risk.

**Specific formatting changes (assuming markdown is viable):**

**`src/telegram/formatters.ts`:**
- `formatBudgetReview`: Bold "Here's your week:" header. Bold day names in the breakdown. Italic for the protein check line.
- `formatShoppingList`: Bold category names. Italic for the "Shopping list for this week" header.
- `formatRecipe`: Bold recipe name. Italic for the macro line.
- `formatRecipeList`: Bold section headers ("LUNCH & DINNER", "BREAKFAST").
- `formatCookingSchedule`: Bold "Cooking schedule:" header. Bold day names.

**`src/recipes/renderer.ts`:**
- `renderRecipe` (line 35): Bold recipe name: `**${recipe.name}**`
- Line 36: Italic macro line: `_${cal} cal | ${prot}g P | ${fat}g F | ${carbs}g C_`
- Line 41: Bold "Ingredients" header
- Component names bold if multi-component

**`src/agents/plan-flow.ts` — `formatPlanProposal`:**
- Line 1801: Bold week header: `**Your week: ...**`
- Line 1805: Bold "Breakfast": `**Breakfast** (daily): ${name}`
- Line 1830: Bold "Meal prep" header
- Line 1848-1854: Bold "Events" header
- Line 1889: Bold "Cook:" header
- Line 1897: Bold weekly totals line

### Step 4: Tone alignment pass

Walk every message against the spec's avoid list:
- No exclamation marks on routine actions (identified above in Step 2)
- No calorie-forward messaging (recipe-flow targets removed in Step 2)
- No guilt or urgency ("You haven't planned yet!" patterns)
- No over-explaining ("The system will now generate..." patterns)
- Calm, brief, action-oriented, non-judgmental

Specific checks:
- `core.ts:507` — `"Planning cancelled."` — acceptable (brief, no judgment)
- `plan-flow.ts:405` — `"I couldn't parse that."` — acceptable (honest, helpful)
- `plan-flow.ts:514-516` — `"I couldn't build a complete plan for this week. Try again or adjust your recipe set."` — acceptable
- `plan-flow.ts:980` — `"I'm not sure what to change."` — acceptable

### Step 5: Lifecycle-aware free-text fallback

Replace the generic fallback at `core.ts:865`:

```typescript
// Current:
await sink.reply('Use the menu buttons below to get started.', { reply_markup: mainMenuKeyboard });

// New (requires Phase 0's getPlanLifecycle, surfaceContext, lastRecipeSlug):
const lifecycle = await getPlanLifecycle(session, store, new Date());
const menu = buildMainMenuKeyboard(lifecycle);

if (session.surfaceContext === 'cooking' || session.surfaceContext === 'recipes') {
  if (session.lastRecipeSlug) {
    await sink.reply(
      "I can help with this recipe or your plan. Try: 'can I freeze this?' or tap a button.",
      { reply_markup: menu },
    );
    return;
  }
}

if (lifecycle === 'no_plan') {
  await sink.reply(
    'I can help you plan your week, browse recipes, or log measurements. Tap Plan Week to get started.',
    { reply_markup: menu },
  );
} else {
  await sink.reply(
    "I can help with your plan, recipes, shopping, or measurements. Try: 'change Thursday dinner' or tap a button.",
    { reply_markup: menu },
  );
}
```

This is ~15 lines of dispatch logic, not a new flow. The three branches match the backlog spec exactly:
1. **recipe on screen** — `lastRecipeSlug` set AND `surfaceContext` is `cooking` or `recipes`
2. **no_plan** — lifecycle is `no_plan`
3. **active plan, no surface context** — all other cases (active plan with no recipe on screen)

### Step 6: Scenario regeneration and verification

All copy changes will cause existing scenario recordings to diverge. After all changes:

1. Run `npm test` — expect failures from changed copy.
2. Regenerate ALL affected scenarios: `npm run test:generate -- <name> --regenerate` for each.
3. Review every regenerated recording against the verification checklist (docs/product-specs/testing.md). The copy changes should only affect the text of messages, not their structure, keyboard shapes, or session state.
4. Run `npm test` again to confirm all green.

## Progress

- [ ] Step 1: Audit all user-visible strings (build inventory)
- [ ] Step 2: Jargon removal across all files
- [ ] Step 3: Telegram markdown formatting (requires parse_mode discovery first)
- [ ] Step 4: Tone alignment pass
- [ ] Step 5: Lifecycle-aware free-text fallback (depends on Phase 0)
- [ ] Step 6: Scenario regeneration and verification

## Decision log

- Decision: Remove raw macro targets from the recipe flow meal-type selection message (recipe-flow.ts:260).
  Rationale: The ui-architecture spec says "no calorie-forward messaging." Showing "targets: 804 cal, 66g P, 27g F, 80g C" when the user picks a meal type is calorie-forward — the system needs those numbers internally, but the user just wants to describe what they want. The targets still govern generation; they're just hidden from the prompt.
  Date: 2026-04-07

- Decision: Treat Telegram markdown formatting as conditional on a parse_mode discovery step.
  Rationale: MarkdownV2 requires escaping ~20 special characters in every message string. If the codebase doesn't already use parse_mode, enabling it across all messages is a significant change that could break existing output. The plan includes a discovery step and a plain-text fallback strategy (uppercase headers, Unicode separators) if markdown proves too risky for this pass.
  Date: 2026-04-07

- Decision: Keep "Meal prep:" as the plan proposal section header.
  Rationale: "Meal prep" is user language — people say "I need to do my meal prep." It's not jargon like "batch" or "solver." The spec's jargon list doesn't include it.
  Date: 2026-04-07

- Decision: Change "Plan locked" to "Plan set."
  Rationale: "Locked" implies the system did something irreversible and mechanical. "Set" is how you'd tell a friend: "You're set for the week." Matches the spec's "calm and confident" voice.
  Date: 2026-04-07

## Validation

1. **Jargon check:** Search all files for the banned terms: "active plan", "plan session", "cook session", "template", "scaled", "batch target", "batch" (in user-visible strings only — internal code comments and variable names are fine), "solver", "QA". Zero hits in any `sink.reply()`, `text:` return, or formatter output.

2. **Exclamation mark check:** Search all `sink.reply()` calls and `text:` returns for `!` in routine messages. Only acceptable in genuine celebration contexts (e.g., a major milestone).

3. **Tone review:** Read every changed message as if you were the user. Does it sound calm, brief, and action-oriented? Does it avoid guilt, urgency, or over-explaining?

4. **Free-text fallback:** Manually test (or verify via scenario) the three fallback branches:
   - Type random text with no plan → "I can help you plan your week..."
   - Type random text with an active plan → "I can help with your plan..."
   - Type random text while viewing a recipe → "I can help with this recipe..."

5. **`npm test` passes** after scenario regeneration. Diff review confirms only text content changed — no keyboard shapes, session states, or store snapshots diverged.

# Feedback

