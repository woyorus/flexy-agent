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

**Critical constraint: this plan runs last.** The strings and files referenced in Steps 2–4 are based on the pre-v0.0.4 codebase and serve as examples of issue types, not an exhaustive change list. At execution time, the coding agent MUST:
1. Re-audit all user-visible strings fresh against the post-v0.0.4 codebase (Step 1 is the real work).
2. Verify which messages from Steps 2–4 still exist vs. were rewritten by other tasks.
3. **Review** new messages created by other tasks (Agent A's screens, Agent B's cook view, Agent C's shopping list) for quality issues — this pass audits their output. Fix any jargon, exclamation-mark, or tone violations. Do NOT do full rewrites of strings that are otherwise correct — targeted fixes only.
4. Skip dead-code formatters in `formatters.ts` unless other tasks have wired them up.

**Line numbers are pre-v0.0.4 and will not be valid at execution time.** Use the searchable string anchors or function/case names provided in each step to locate the actual code.

### Step 1: Audit and catalog every user-visible string

Before changing anything, build the complete inventory. Every `sink.reply(...)`, every `text:` return in flow handlers, every formatter output, every button label.

**Files to audit:**

- `src/telegram/core.ts` — all `sink.reply(...)` calls (~30 call sites)
- `src/telegram/formatters.ts` — check which formatters are still live (wired up) vs. dead code before touching anything
- `src/agents/plan-flow.ts` — all `text:` returns in FlowResponse (~25 call sites)
- `src/agents/recipe-flow.ts` — all `text:` returns in FlowResponse (~10 call sites)
- `src/recipes/renderer.ts` — `renderRecipe()` and `renderRecipeSummary()`
- `src/telegram/keyboards.ts` — all button labels
- Any NEW files added by other v0.0.4 tasks: Plan 013's `src/agents/progress-flow.ts` and progress report formatter (weekly report has user-facing copy with tone and formatting implications), Plan 016's Agent A screen formatters, Agent B's cook view, Agent C's shopping list

**Dead-code note:** At the time of writing, `formatBudgetReview()`, `formatShoppingList()`, `formatRecipe()`, `formatRecipeList()`, and `formatCookingSchedule()` in `formatters.ts` are not imported or called anywhere in the codebase. Verify their status before touching them — if still dead after other tasks land, skip them.

**Scope rule for other-task strings:** This plan is a quality pass — it reviews everything. Full rewrites of strings that are architecturally correct but stylistically suboptimal are out of scope. Jargon violations, banned exclamation marks, and calorie-forward messaging are always in scope regardless of which task introduced the string.

### Step 2: Jargon removal

Replace internal terminology with user language. Each item below is a specific code change:

**`src/telegram/formatters.ts`:**
- Line 60: `"All batches sized. Calories and protein on target."` → `"Calories and protein on target."` (remove "batches sized" — meaningless to user)
- Line 23: `"Here's your week:\n\n"` → `"*Here's your week:*\n\n"` (bold header using MarkdownV2 `*bold*`, see Step 3)
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
- Search for `"Plan locked for"` — but note: the ui-architecture spec uses "Plan locked for Mon Apr 6 – Sun Apr 12" as approved copy in its Post-Confirmation screen example, and Agent A will rewrite this entire message for the Post-Confirmation bridge. **Do not change this string** — it is owned by Agent A's Post-Confirmation work and the spec endorses it.
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

**MarkdownV2 prerequisite work (must be done first in this step):**

**First, inspect OutputSink after Plan 013 lands.** Plan 013 (Progress screen, step 4f) widens `OutputSink.reply` to `options?: { reply_markup?: ...; parse_mode?: string }` and updates the grammY adapter. It also explicitly says `CapturingOutputSink` requires no change (additional options are silently ignored). Therefore:

1. **If Plan 013 has already landed** (check `OutputSink` in `src/telegram/`): skip the OutputSink/adapter extension — it is already done. The type is `parse_mode?: string`, which is broad enough for `'MarkdownV2'`. Do NOT narrow it to `'MarkdownV2' | 'HTML'`.
2. **If Plan 013 has NOT landed**: extend `OutputSink.reply` to `options?: { reply_markup?: Keyboard | InlineKeyboard; parse_mode?: string }` and update the grammY adapter to pass it through.
3. **CapturingOutputSink:** Plan 013 says no change is needed. However, since Plan 015 adds `parse_mode` to multiple message types, consider whether harness test fidelity requires capturing it. If yes, add `parse_mode?: string` to `CapturedOutput` and read it in `CapturingOutputSink`. If no, recordings simply won't assert parse mode (acceptable if the code path is tested via real-Telegram run). Document the decision.
4. Write an `escapeMarkdownV2(text: string): string` utility that escapes `\`, `.`, `!`, `-`, `(`, `)`, `_`, `*`, `[`, `]`, `` ` ``, `>`, `#`, `+`, `=`, `|`, `{`, `}`, `~` per the Telegram MarkdownV2 spec. **Backslash (`\`) must be escaped first** (as `\\`) before escaping any other character, to avoid double-escaping. All dynamic interpolated values AND literal text fragments with reserved characters must be passed through this utility.
5. Add `parseMode?: 'MarkdownV2'` to **both** `FlowResponse` interfaces (`plan-flow.ts` and `recipe-flow.ts`). Renderers/formatters that return markdown-formatted text must also set `parseMode: 'MarkdownV2'`. **All callers** that send `result.text` must forward it: `await sink.reply(result.text, { reply_markup: kb, ...(result.parseMode && { parse_mode: result.parseMode }) })`.
6. **`renderRecipe` call sites — two paths, treat differently:**
   - **Direct `sink.reply()` calls in `core.ts`** (currently `core.ts:323` and `core.ts:861`): `renderRecipe()` output is passed directly to `sink.reply()`. These must explicitly add `parse_mode: 'MarkdownV2'` to the options: `await sink.reply(renderRecipe(recipe), { reply_markup: kb, parse_mode: 'MarkdownV2' })`.
   - **Calls inside flow handlers** (currently `recipe-flow.ts:289`, `recipe-flow.ts:328`, `plan-flow.ts:688`, `plan-flow.ts:1042`): these store the result in a local variable and return it via `FlowResponse.text`. The `parseMode` field on `FlowResponse` (added in step 5) handles propagation — the flow handler sets `parseMode: 'MarkdownV2'` and `core.ts` forwards it at the `result.text` send site. Do NOT add `parse_mode` directly inside the flow handler; that is the caller's job.
   Verify all six sites are covered — missing any one causes raw asterisks in that view.
7. Add `parse_mode` only to the specific messages being formatted in this pass — do NOT retroactively add it to all ~60 call sites.

**Critical syntax note — Telegram MarkdownV2 vs GitHub Markdown:** Telegram MarkdownV2 uses **single** asterisk for bold (`*bold*`) and underscore for italic (`_italic_`). GitHub-style double-asterisk (`**bold**`) is NOT valid Telegram syntax and will render as literal asterisks. All formatting examples in this step use Telegram MarkdownV2 syntax.

Also fix the misleading doc comment in `src/telegram/formatters.ts` (file-level, near top): it currently claims "Uses Telegram's MarkdownV2 formatting where beneficial" but no parse_mode is set. Update it to accurately describe the file's current state (or its state after this pass).

**Option B (fallback): plain-text visual hierarchy** — If the OutputSink extension proves too risky or complex given end-of-sprint time pressure, use plain-text structural signals instead: ALL-CAPS section headers, em-dash (—) separators, bullet points. This achieves 80% of the formatting goal without MarkdownV2 risk and zero escaping work. Document the choice in the Decision log if Option B is chosen.

**Specific formatting changes (scope: only live formatters and messages touched in this pass):**

**`src/telegram/formatters.ts`:**
- Only format functions that are actually called at execution time. If `formatBudgetReview`, `formatShoppingList`, `formatRecipe`, `formatRecipeList`, `formatCookingSchedule` are still dead code after other tasks land, skip them.
- For any live formatters: bold headers (e.g., "Here's your week:", category names, "Cooking schedule:"), bold day names in breakdowns, italic for secondary context lines.

**`src/recipes/renderer.ts`:**
- `renderRecipe` (line 35): Bold recipe name: `*${escapeMarkdownV2(recipe.name)}*`
- Line 36: Italic macro line: `_${cal} cal \| ${prot}g P \| ${fat}g F \| ${carbs}g C_` (pipe `|` is a MarkdownV2 reserved character and must be escaped as `\|`; all numeric values are safe since digits are not reserved)
- Line 41: Bold "Ingredients" header: `*Ingredients*`
- Component names bold if multi-component: `*${escapeMarkdownV2(component.name)}*`

**`src/agents/plan-flow.ts` — `formatPlanProposal`:**
- Bold week header: `*Your week: ...*`
- Bold "Breakfast": `*Breakfast* (daily): ${name}`
- Bold "Meal prep" header: `*Meal prep*`
- Bold "Events" header: `*Events*`
- Bold "Cook:" header: `*Cook*`
- Bold weekly totals line

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

**Hard gate: Step 5 cannot begin until Plan 012 is merged.** `src/plan/helpers.ts` does not exist in the pre-v0.0.4 codebase — it is created by Plan 012. Attempting Step 5 before Plan 012 lands will produce broken imports and TypeScript errors.

**Prerequisite check — do not proceed if any of the following are missing:**

| Symbol | Expected source |
|---|---|
| `getPlanLifecycle(session, store, today: string)` | `src/plan/helpers.ts`, created by Plan 012 (Phase 0) |
| `toLocalISODate(date: Date): string` | `src/plan/helpers.ts`, moved there by Plan 012 (was in plan-proposer.ts) |
| `session.surfaceContext` | Session type, delivered by Plan 012 (Phase 0) |
| `session.lastRecipeSlug` | Session type, delivered by Plan 012 (Phase 0) |
| `buildMainMenuKeyboard(lifecycle)` | `src/telegram/keyboards.ts`, delivered by Plan 012 (Phase 0 shared infrastructure) |

If any prerequisite is absent, stop, file a note in the Decision log, and skip Step 5. The existing fallback is tolerable; shipping a broken import is not.

**Silent-drop gap:** Before replacing the end-of-handler fallback, also handle the `return;` at `core.ts` (comment "Plan flow active but not awaiting text — ignore"). Currently, any text typed while the plan proposal or review is on screen is silently discarded without any user feedback. Extract the lifecycle-aware fallback reply into a shared helper function (e.g., `replyFreeTextFallback(session, sink, store, menu)`), and call it from that silent-drop point as well. This ensures the lifecycle-aware message is consistently shown regardless of whether the user is in a flow or not.

Replace the generic fallback (search for `'Use the menu buttons below to get started.'` in `core.ts`):

```typescript
// Current:
await sink.reply('Use the menu buttons below to get started.', { reply_markup: mainMenuKeyboard });

// New (requires Phase 0's getPlanLifecycle, surfaceContext, lastRecipeSlug):
// getPlanLifecycle takes today as a local ISO string (e.g. "2026-04-07"), not a Date object.
// Use toLocalISODate() from src/plan/helpers.ts (moved there by Plan 012).
const today = toLocalISODate(new Date());
const lifecycle = await getPlanLifecycle(session, store, today);
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

This is ~15 lines of dispatch logic, not a new flow. The three branches cover all lifecycle states:
1. **recipe on screen** — `lastRecipeSlug` set AND `surfaceContext` is `cooking` or `recipes`
2. **no_plan** — lifecycle is `no_plan`
3. **all other states** (`planning`, `active_early`, `active_mid`, `active_ending`) — the else branch copy ("I can help with your plan...") must be safe for in-progress planning as well, not just an active locked plan. The `planning` state occurs when a plan flow is active but not awaiting text — this is exactly the silent-drop scenario where the fallback helper is also called. The copy is intentionally generic enough to cover it.

### Step 6: New scenarios, unit tests, and regeneration

#### 6a. New scenario: free-text fallback (required)

Step 5 introduces a new code path not covered by any existing scenario. Author `test/scenarios/019-free-text-fallback/spec.ts` with three sequential events against a single session to exercise all branches:

1. Send random text with no plan → expect "I can help you plan your week..." copy
2. Complete a plan (or seed initial state with an active plan), send random text → expect "I can help with your plan..." copy
3. (If harness supports seeding `surfaceContext` + `lastRecipeSlug`) send random text while `surfaceContext = 'recipes'` and `lastRecipeSlug` set → expect the recipe-context copy

If branch 3 requires session fields that aren't seedable via `initialState`, cover it with a real-Telegram run note in `docs/plans/tech-debt.md` and test branches 1 and 2 via the harness only.

After authoring: `npm run test:generate -- 019-free-text-fallback`, review the recorded transcript, then add a row to `test/scenarios/index.md`.

#### 6b. Unit test: escapeMarkdownV2 (required if Step 3 MarkdownV2 path is chosen)

Add `test/unit/escape-markdown-v2.test.ts`. Minimum test cases:
- Backslash: `\` → `\\` (must be first)
- Pipe: `|` → `\|`
- Period: `.` → `\.`
- Exclamation: `!` → `\!`
- Parentheses: `(foo)` → `\(foo\)`
- Clean string passes through unchanged
- Mixed dynamic content: a recipe name like "Thai Basil (Quick)" produces the correct escaped form

This test runs in `npm test` (no fixtures needed — pure function).

#### 6c. Regenerate affected existing scenarios

**Discovery:** Run `npm test`. The assertion diffs identify exactly which scenarios diverge — that is the authoritative list. Do not try to predict from scenario names.

**Expected blast radius:**
- Plan proposal formatting changes (Step 3) will cause **all plan scenarios (001–014) to fail** because the proposal text appears in nearly every recording.
- Welcome message change (`core.ts:248`, Step 2) affects scenarios 001 and 004 which start with `/start`.
- Recipe flow message change (Step 2) affects any scenario that exercises recipe generation — none of the current 001–014 do, so only the new scenario 019 captures it.
- If `CapturingOutputSink` is updated to capture `parse_mode` (Step 3 decision), **all formatted-message outputs in recordings gain a new `parse_mode` field** — this is an expected structural change, not a blast-radius defect. Confirm it appears only on the messages that were intentionally formatted with MarkdownV2.

**Scenario 014 has fixture edits (special workflow):** Scenario `014-proposer-orphan-fill` has a `fixture-edits.md`. Follow the 3-step process:
1. `npm run test:generate -- 014-proposer-orphan-fill --regenerate`
2. Apply the edits in `fixture-edits.md`
3. `npm run test:generate -- 014-proposer-orphan-fill --regenerate` again
Then `npm test` to confirm.

**For all other affected scenarios:** `npm run test:generate -- <name> --regenerate` one by one, then review.

#### 6d. Verify each regenerated recording

Per `docs/product-specs/testing.md` § Verifying recorded output:
- Read `expected.outputs[].text` sequentially — do the messages read correctly as a user?
- For plan scenarios: text of messages should change (formatting/jargon fixes), but **keyboard shapes, session state, and store snapshots must NOT change**. If they do, the change has unexpected blast radius and must be narrowed before committing.
- For the new scenario 019: verify all three branches produce the correct copy for their lifecycle state.

#### 6e. Final gate

`npm test` passes clean. Commit all of: code changes, `spec.ts`, all `recorded.json` updates, `test/scenarios/index.md` update, and any new unit test files together in one commit.

## Progress

- [ ] Step 1: Audit all user-visible strings (build inventory; verify which formatters are live vs. dead)
- [ ] Step 2: Jargon removal across all files (using string anchors, not line numbers)
- [ ] Step 3: Telegram markdown formatting (extend OutputSink first; or choose Option B plain-text fallback)
- [ ] Step 4: Tone alignment pass
- [ ] Step 5: Lifecycle-aware free-text fallback (depends on Phase 0 + Plan 016; skip if prerequisites missing)
- [ ] Step 6: New scenario 019-free-text-fallback + escapeMarkdownV2 unit test + regenerate all affected scenarios (use `npm test` failures to identify them, not `ls`)

## Decision log

- Decision: Remove raw macro targets from the recipe flow meal-type selection message (recipe-flow.ts:260).
  Rationale: The ui-architecture spec says "no calorie-forward messaging." Showing "targets: 804 cal, 66g P, 27g F, 80g C" when the user picks a meal type is calorie-forward — the system needs those numbers internally, but the user just wants to describe what they want. The targets still govern generation; they're just hidden from the prompt.
  Date: 2026-04-07

- Decision: Treat Telegram markdown formatting as requiring explicit OutputSink extension work, not just a parse_mode flag.
  Rationale: `OutputSink.reply()` currently only accepts `{ reply_markup }`. Enabling MarkdownV2 requires extending the interface, updating the grammY adapter, updating the harness sink, and writing an escape utility. This is explicit subtask work in Step 3, not a discovery step. A plain-text fallback (Option B) is available if time pressure is high.
  Date: 2026-04-07

- Decision: Keep "Meal prep:" as the plan proposal section header.
  Rationale: "Meal prep" is user language — people say "I need to do my meal prep." It's not jargon like "batch" or "solver." The spec's jargon list doesn't include it.
  Date: 2026-04-07

- Decision: Do NOT change "Plan locked" to "Plan set."
  Rationale: The ui-architecture spec explicitly endorses "Plan locked for Mon Apr 6 – Sun Apr 12" as approved copy in its Post-Confirmation screen example, and lists `"Plan saved!" → "Plan locked ✓"` in the Avoid section (meaning "Plan locked" is the preferred form). Additionally, Agent A owns this string as part of the Post-Confirmation bridge rewrite — this plan should not touch it.
  Date: 2026-04-07

## Validation

1. **Jargon check:** Search for the banned terms inside string literals in `sink.reply()` calls, `text:` return values, and formatter output strings specifically. Do NOT flag variable names like `batch.servings` or code comments — only user-visible strings. Banned terms: `"active plan"`, `"plan session"`, `"cook session"`, `"template"`, `"scaled"`, `"batch target"`, `"batches sized"`, `"solver"`, `"QA"`. A useful grep pattern: search for each term inside quoted strings adjacent to `sink.reply(` or `text:` return sites. Zero hits in user-visible strings required.

2. **Exclamation mark check:** Search all `sink.reply()` calls and `text:` returns for `!` in routine messages. Only acceptable in genuine celebration contexts (e.g., a major milestone).

3. **Tone review:** Read every changed message as if you were the user. Does it sound calm, brief, and action-oriented? Does it avoid guilt, urgency, or over-explaining?

4. **Free-text fallback:** Manually test (or verify via scenario) the three fallback branches:
   - Type random text with no plan → "I can help you plan your week..."
   - Type random text with an active plan → "I can help with your plan..."
   - Type random text while viewing a recipe → "I can help with this recipe..."

5. **`npm test` passes** after scenario regeneration. Diff review confirms only text content changed — no keyboard shapes, session states, or store snapshots diverged.

