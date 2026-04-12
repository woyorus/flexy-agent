# UI Architecture

> Scope: The product's UI surface area — product states, screen inventory, navigation, information hierarchy, and state-driven behavior. This is the map that individual screen designs fill in. Every screen traces back to a job in [jtbd.md](./jtbd.md). See also: [ui.md](./ui.md) for Telegram-specific implementation (keyboards, callbacks), [flows.md](./flows.md) for conversation state machines.

## Telegram as a UI platform

Telegram is a chat interface, not an app with tabs and screens. This creates constraints and affordances that shape every design decision:

**Constraints:**
- No persistent screens — every "view" is a message in the chat history. Old messages scroll up and become stale.
- Inline keyboards (buttons below a message) can only be attached to one message. When the product sends a new message with buttons, the old buttons become orphans.
- Callback data is limited to 64 bytes — complex state must be encoded compactly.
- No pull-to-refresh, no loading states, no client-side routing. Every interaction is: user taps/types → bot sends a message.
- Messages can be edited in-place (update text + keyboard of a sent message), which is the closest thing to "refreshing a screen."

**Affordances:**
- Text, voice, and images are all native inputs — first-class, zero-friction. Images matter for future tracking (meal photos) and restaurant preparation (menu scanning).
- Reply keyboards (persistent buttons at the bottom) act like a tab bar — always available, state-independent.
- Messages can be forwarded, copied, shared — any message is inherently portable.
- The chat history is a natural activity log — the user can scroll up to see past plans, recipes, conversations.

**Design principles for Telegram:**
1. **The reply keyboard IS the navigation.** It's the only persistent UI element. Every other "screen" is ephemeral.
2. **Each message should be self-contained.** Don't rely on the user reading the previous message — they might have scrolled up, restarted the app, or come back hours later.
3. **Edit in place when possible.** When a user action updates the current view (e.g., checking off a shopping item), edit the existing message instead of sending a new one. This prevents chat clutter.
4. **Copy-friendly formatting for portable content.** Messages the user might take outside Telegram (shopping list, recipe) should copy cleanly. Use markdown formatting for visual hierarchy, but ensure the underlying text is still readable when pasted into Notes.
   - **Use Telegram markdown deliberately** to create visual hierarchy in long messages:
     - **Bold** for headers, recipe names, day names, key numbers — anything the user should see first when scanning.
     - _Italic_ for secondary context, tips, status notes.
     - `Monospace` sparingly — ingredient amounts in recipes, calorie numbers.
   - Don't over-format. A message with everything bolded is the same as nothing bolded. The goal is to guide the eye to what matters.
5. **Reliable "go back" navigation.** When the user leaves a flow to check something (e.g., taps [My Recipes] mid-planning, or drills into a recipe from the plan view), they must always have a clear way back. Every detour screen shows a [← Back to planning] or [← Back to plan] button. The user should never feel lost or worry that they've lost their in-progress session. This applies to any active flow — planning, recipe creation, shopping.
6. **The product must feel conversational, not robotic.** Users are accustomed to AI chatbots. They will type natural language at any moment — mid-planning, mid-recipe-review, mid-anything. The product must never ignore free-text or respond with "please tap a button." See the Freeform Conversation Layer section below for the full design.

---

## Product states

The product state has two dimensions: a **plan lifecycle** (where the user is in their weekly rhythm) and a **surface context** (what screen they're currently looking at). The lifecycle is durable across screen changes — it advances on planning events and calendar boundaries (not on every tap). The surface context is transient — it changes with every tap.

### Plan lifecycle

The lifecycle determines the main menu labels, the default screen when opening the chat, and which jobs are primary.

**no_plan** — No plan exists (first launch, expired plan, vacation return).
- Primary job: B1 (Plan my week).
- What the user sees on open: "No plan for this week. Ready to plan?"
- Emotional tone: Inviting, not scolding. "Welcome back" energy, not "you missed your plan."

**planning** — User is mid-flow in the planning session.
- Primary job: B1 (Plan my week).
- The planning conversation dominates. Inline keyboards guide each step.
- Main menu buttons still work (user might tap [My Recipes] to check something mid-planning), but the planning flow resumes when they return.

**active_early** — Plan confirmed within the last 1-2 days. First cook sessions, first grocery runs.
- Primary jobs: A1 (next action), A2 (shopping list), A3 (cook from plan), A4 (browse week).
- Emotional tone: Energized, prepared. "Here's your week. First up: shop for Monday's lunch."

**active_mid** — Day 3-5 of the plan. Rhythm established.
- Primary jobs: A1 (next action — still #1), A3 (cook from plan), A5 (flex meal approaching?).
- Past days fade — the user doesn't need Monday's meals on Thursday.
- Emotional tone: Steady, calm. "You're on track. Tomorrow: cook dinner."

**active_ending** — 1-2 days left. Most meals consumed.
- Primary jobs: A1 (next action for remaining days), B1/B2 (plan next week).
- The "what's next" view shows remaining meals + contextual prompt: "Your plan ends Sunday. Ready to plan next week?"
- Emotional tone: Wrapping up, forward-looking.

### Surface context

The surface context is what the user is currently looking at. It's a temporary layer on top of the lifecycle — the user enters a context, does something, and returns. Multiple contexts can be visited within any lifecycle state.

**plan** — Next Action screen or Week Overview. The default surface when the lifecycle is active.

**cooking** — User is viewing a recipe to cook from. Entered from the plan surface. [← Back to plan] returns.

**shopping** — User is viewing the needs list. Entered from plan or main menu. [← Back to plan] returns.

**recipes** — User is browsing the recipe library. Entered from main menu. 🔪 plan recipes open cook view directly; non-plan recipes open library view.

**progress** — User is logging measurements or viewing weekly report. Entered from main menu.

**side_conversation** — User asked a free-text question during any flow. The underlying lifecycle and previous surface context are preserved. [← Back to ...] returns to where they were.

This two-dimensional model makes navigation cleaner: the lifecycle never changes because you opened a recipe or checked the shopping list. Back buttons always return to the previous surface context. The freeform layer becomes just another surface context, not a special case.

### Navigation state (Plan 027)

The bot's in-memory session carries two layers of navigation state:

1. **`surfaceContext`** — coarse five-value enum (`'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null`) used by the free-text fallback to pick a contextual hint.
2. **`lastRenderedView`** — precise discriminated union that captures the exact render target AND its parameters. Defined in `src/telegram/navigation-state.ts`.

Every handler that produces a navigation render (Next Action, Week Overview, Day Detail, Cook view, Shopping list at any scope, Recipe library or detail, Progress log prompt or weekly report) calls `setLastRenderedView(session, view)` immediately before its `sink.reply(...)`. The helper mutates both fields atomically so `surfaceContext` always matches `lastRenderedView.surface`.

**What `lastRenderedView` is for.** It is the source of truth for "what the user was last looking at" and will be read by the dispatcher in Plan C (freeform conversation layer) to compute dynamic back-button targets and to answer questions like "show me that recipe again". Plan 027 lays the state rails; the dispatcher that reads them is a later plan. **Back-button callbacks remain hardcoded in v0.0.5 Plan B** — `cookViewKeyboard` still targets `na_show`, `buildShoppingListKeyboard` still targets `na_show`, day detail still targets `wo_show`, etc.

**What `lastRenderedView` does NOT track.**

- In-flow transitional messages (breakfast confirmation, events prompt, proposal review, measurement confirmation, recipe generation review) are flow progressions, not navigation views. They do not update `lastRenderedView`.
- Recipe library pagination is tracked separately on `session.recipeListPage`; `lastRenderedView` only records that the user is on the library page.
- `lastRecipeSlug` (legacy field) continues to be managed independently by the recipe-view handler and the free-text fallback — `setLastRenderedView` does not touch it. This is deliberate to avoid changing the fallback behavior in Plan B.

**Variants** (see `src/telegram/navigation-state.ts` for the authoritative definition):

- `{ surface: 'plan', view: 'next_action' }`
- `{ surface: 'plan', view: 'week_overview' }`
- `{ surface: 'plan', view: 'day_detail', day: <ISO-date> }`
- `{ surface: 'cooking', view: 'cook_view', batchId, recipeSlug }`
- `{ surface: 'shopping', view: 'next_cook' }`
- `{ surface: 'shopping', view: 'day', day: <ISO-date> }`
- `{ surface: 'recipes', view: 'library' }`
- `{ surface: 'recipes', view: 'recipe_detail', slug }`
- `{ surface: 'progress', view: 'log_prompt' }`
- `{ surface: 'progress', view: 'weekly_report' }`

New render targets (e.g., `full_week` and `recipe` shopping scopes added by Plan 030, product-question answers in a future plan) will be added here as new variants.

---

## Main menu (reply keyboard)

The reply keyboard is the only persistent navigation. It must serve every product state without being cluttered.

### Current menu
```
[ Plan Week ]     [ Shopping List ]
[ My Recipes ]    [ Weekly Budget ]
```

### Proposed menu

The reply keyboard label for the top-left button changes based on plan lifecycle — Telegram supports updating reply keyboards dynamically:

No plan / expired:
```
[ Plan Week ]     [ Shopping List ]
[ My Recipes ]    [ Progress ]
```

Planning in progress:
```
[ Resume Plan ]   [ Shopping List ]
[ My Recipes ]    [ Progress ]
```

Active plan:
```
[ My Plan ]       [ Shopping List ]
[ My Recipes ]    [ Progress ]
```

**Changes and rationale:**

| Button | Old | New | Why |
|---|---|---|---|
| Top-left | Plan Week | **Plan Week / Resume Plan / My Plan** | State-sensitive label. "Plan Week" when there's nothing (clear call to action). "Resume Plan" during planning (reminds user they have an in-progress session). "My Plan" once a plan exists (it's their plan, they're living it). |
| Top-right | Shopping List | **Shopping List** | Unchanged. This is the #2 daily job. |
| Bottom-left | My Recipes | **My Recipes** | Unchanged. Recipe library access. |
| Bottom-right | Weekly Budget | **Progress** | "Weekly Budget" is a static view only interesting after deviations. "Track" was considered but implies a tracker, which violates PRODUCT_SENSE ("this is not a tracker"). "Progress" is about outcomes — weight trend, waist trend, weekly report. It's where the user goes to see that the effort is paying off. Treat logging and budget checking are NOT here — treat logging should be free-text from anywhere (freeform layer), budget checking belongs in the plan view after deviations. |

### State-driven button behavior

**[Plan Week / Resume Plan / My Plan]** (label changes with lifecycle):
- **no_plan:** Label is [Plan Week]. Shows "No plan for this week" message + inline [Plan Week] button to start.
- **planning:** Label is [Resume Plan]. Resumes the planning flow where they left off.
- **active_early / active_mid:** Label is [My Plan]. Shows the plan view (Next Action screen).
- **active_ending:** Label is [My Plan]. Shows the plan view with a contextual [Plan next week] button embedded in the Next Action screen. The user sees "Your plan ends Sunday. Ready to plan next week?" right where they're already looking.

**[Shopping List]** adapts to product state:
- **no_plan:** "No plan yet — plan your week first to see what you'll need."
- **Active plan:** Defaults to the **next shopping need** — ingredients for the next cook day + breakfast. This matches the real job: "I'm about to go to the store, what do I need for my next cook?" Not the full remaining week. The user cross-references against their kitchen and copies what they actually need to buy. If no upcoming cook days remain (all meals are prepped), says so.

**[Progress]** adapts to product state:
- **Always available** regardless of plan lifecycle. Weight/waist tracking is independent of the meal plan.
- Default action: prompt for measurements if none today. If already logged: "Already logged today ✓."
- Narrowly scoped to weight/waist measurements and the weekly progress report. This is NOT a general tracking destination. Treat logging happens via free-text from any screen (freeform layer, v0.0.5). Budget checking belongs in the plan view after deviations, not here. "Progress" = "is the effort paying off?", not "log everything."

**[My Recipes]** is state-independent — always shows the recipe library.

---

## Screen inventory

Every distinct "view" the product can show, mapped to its JTBD and navigation path.

### Screen: Next Action (serves A1)

**Entry:** User taps [My Plan] during an active plan, or opens the chat and the product shows this proactively.

**Content:**
```
**Today, Monday Apr 6**

Lunch: Beef Tagine _(reheat)_
Dinner: Chicken Pepperonata _(reheat)_

**Tomorrow, Tuesday Apr 7**
🔪 Cook lunch: **Greek Lemon Chicken** — 3 servings

**Wednesday Apr 8**
Dinner: **Flex** (~1,150 cal)
```

**Inline keyboard (adapts to context):**

If next cook session is upcoming:
```
[🔪 Greek Lemon Chicken — 3 servings]
[Get shopping list]  [View full week]
```

If no cook session imminent (all reheat):
```
[View full week]
```

**Key design decisions:**
- Shows today + next 2 days. No further. The user said Saturday doesn't matter on Wednesday.
- Each meal is one line: recipe name + status (reheat / cook / flex / event).
- Cook days are visually distinct (🔪 marker) — they require action.
- The 🔪 recipe button appears when there's an upcoming cook session — this is the #1 action on cook days and must be one tap away, not buried behind View full week → Day → Recipe.
- [Get shopping list] generates the needs list for the next cook day. Only shown when a cook day is upcoming (no point showing it if everything is prepped).
- [View full week] opens the Week Overview.
- Breakfast is NOT shown — it's fixed, memorized, invisible by design. Breakfast ingredients are covered by the shopping list (always included there), so the Next Action screen doesn't need to mention breakfast at all.
- No back button needed — the main menu reply keyboard is always visible at the bottom of Telegram, so the user can always navigate to any top-level section.

---

### Screen: Week Overview (serves A4)

**Entry:** User taps [View full week] from the Next Action screen.

**Content:**
```
**Your week:** Mon Apr 6 – Sun Apr 12

_Breakfast: Avocado Toast & Eggs (daily)_

**Mon** 🔪
L: Beef Tagine · D: Chicken Pepperonata

**Tue**
L: Beef Tagine · 🔪 D: Greek Lemon Chicken

**Wed**
L: Beef Tagine · D: Greek Lemon Chicken

**Thu** 🔪
L: Salmon Pasta · D: Greek Lemon Chicken

**Fri**
L: Salmon Pasta · 🍽️ D: Dinner at Maria's

**Sat**
L: Salmon Pasta · D: **Flex**

**Sun** 🔪
L: Spiced Lamb Bowl · D: Veggie Stir-fry

**Weekly target: on track ✓**

_Tap a day for details:_
```

**Inline keyboard:**
```
[Mon]  [Tue]  [Wed]  [Thu]
[Fri]  [Sat]  [Sun]
[← Back]
```

Each day button shows that day's detail view (Day Detail screen). [← Back] returns to the Next Action screen.

**Key design decisions:**
- Compact: day header with 🔪 if any cook that day, then lunch · dinner on the next line. Uses `·` separator instead of column alignment — renders consistently across all phone widths and font sizes.
- 🔪 = cook day (needs action), no marker = reheat (no action), 🍽️ = event, **Flex** (bold text, no emoji — flex meals are a normal part of the system, not a special reward).
- Breakfast shown once at top as a constant.
- No per-meal calorie numbers in the overview. The user wants the vibe of the week (A4), not a calorie dashboard. A simple "Weekly target: on track ✓" is enough. No warnings or ⚠️ in this view — it's a curiosity screen whose job is excitement, not anxiety. Warning-style statuses belong in post-deviation contexts only. Exact calorie/protein breakdowns are shown only on request or after deviations — not in the curiosity view. This aligns with PRODUCT_SENSE ("not a tracker") and JTBD A4 ("feel excited about upcoming meals").
- Day buttons are the only way to drill in — Telegram doesn't support tappable text in messages. Short labels (Mon/Tue/Wed) so they fit in one row of 4.
- This view is intentionally read-only for MVP. Future: day detail could offer [Change this] inline.

---

### Screen: Day Detail (serves A1 + A3 entry point)

**Entry:** User taps a day button from Week Overview.

**Content:**
```
**Thursday, Apr 10**

🔪 Lunch: **Salmon Pasta**
Cook 3 servings (Thu–Sat) · ~800 cal each

Dinner: Greek Lemon Chicken
_Reheat (cooked Tue) · serving 3 of 3_
```

**Inline keyboard:**
```
[🔪 Salmon Pasta — 3 servings]
[Get shopping list]
[← Back to week]
```

**Key design decisions:**
- Shows both meals for the day with their status.
- Cook meals show servings count, day range. The inline button leads to the recipe.
- Reheat meals show which batch they're from and which serving number (so user knows "this is the last one").
- [🔪 {Recipe name} — N servings] opens the recipe view. The button label is just the recipe name + batch size — context (🔪 marker, "Cook 3 servings" in the message) makes it clear this is for cooking. Button only appears for cook-day meals, not reheats.
- [Get shopping list] generates the needs list scoped to this cook session.
- [← Back to week] returns to the Week Overview.

---

### Screen: Cook-Time Recipe (serves A3)

**Entry:** User taps [Open recipe] from Day Detail or drills into a cook-day meal.

**Content:**
```
**Salmon Pasta** — 3 servings
_~800 cal/serving · 52g protein_
_Divide into 3 equal portions_

**Ingredients** (total for batch):
· Salmon fillet — `600g`
· Penne pasta — `225g` (dry)
· Cherry tomatoes — `450g`
· Garlic — 3 cloves
· Olive oil — `45ml`
· Fresh basil — `15g`
· Salt, pepper, chili flakes

**Steps:**
1. Bring a large pot of salted water to boil.
Cook `225g` penne until al dente, **10-11 min**.
Drain, reserve 100ml pasta water.

2. While pasta cooks, cut `600g` salmon into
bite-size cubes. Season with salt and pepper.

3. Heat `30ml` olive oil in a large skillet over
medium-high heat. Sear salmon cubes without
moving, **2 min per side**. Remove, set aside.

4. In the same skillet, add `15ml` olive oil and
3 cloves minced garlic. Cook **30 sec** until
fragrant. Add `450g` halved cherry tomatoes.
Cook **4-5 min** until softened.

5. Return salmon to skillet. Add pasta and a
splash of reserved pasta water. Toss gently,
**1 min**. Remove from heat.

6. Tear `15g` fresh basil over the top.
Season with chili flakes to taste.

_Total cook time: ~25 min_

_Storage: Fridge 3 days. Reheat in pan, medium
heat, 3-4 min. Add a splash of water if dry._

[← Back to plan]  [Edit this recipe]
```

**Key design decisions:**
- **Total batch amounts everywhere** — not per-serving. The user cooks the whole batch and divides.
- **Group seasonings on one line** — salt, pepper, and spices that don't need precise amounts are listed together on a single line (e.g., "Salt, pepper, chili flakes") rather than as separate items. This keeps the ingredient list short and scannable. Only seasonings with specific amounts (e.g., "2 tsp smoked paprika") get their own line. This rule applies to both the ingredient list and the recipe generation prompt.
- **Amounts are inlined in steps via placeholders** — Recipe templates use `{ingredient_name}` placeholders in steps (e.g., "Cut {salmon fillet} into bite-size cubes"). The renderer replaces these with the actual amount based on context: cook-time view uses batch totals from scaled ingredients, library view uses per-serving amounts from the base recipe. The placeholder name must match the ingredient's `name` field in the YAML frontmatter. Seasonings without meaningful amounts (salt, pepper) are plain text — no placeholder. This solves the #1 UX pain point (scrolling between ingredients and steps) without duplicating content or making templates unreadable. The recipe QA validation gate must verify that every `{placeholder}` in the steps matches an ingredient `name` in the YAML frontmatter — a broken placeholder means missing amounts at cook time.
- **Every heat step has a duration** — "2 min per side", "4-5 min", "30 sec". No "until golden" without a time anchor.
- **Ingredients list kept as a reference section** at the top — useful for the shopping/prep check before cooking starts, even though amounts are also in the steps.
- **Servings count and portioning instruction** at the very top — "3 servings, divide into 3 equal portions."
- **Storage instructions** at the bottom — how long it keeps, how to reheat.
- Per-serving calories shown once in the header, not emphasized.
- **This is plain text** — copies cleanly if the user wants to paste it somewhere.

---

### Screen: Shopping List (serves A2)

**Entry:** User taps [Shopping List] from main menu, or [Get shopping list] from plan view.

**Content:**
```
**What you'll need** — Thu Apr 10
_For: Salmon Pasta (3 servings) + Breakfast_

**PRODUCE**
- Cherry tomatoes — 450g
- Fresh basil — 1 bunch
- Garlic — 1 head
- Avocados — 4 (breakfast, remaining days)
- Lemons — 2 (breakfast, remaining days)

**FISH**
- Salmon fillet — 600g

**DAIRY & EGGS**
- Eggs — 8 (breakfast, remaining days)

**PANTRY**
- Penne pasta — 225g

_Check you have:
Ground cumin, chili flakes, smoked paprika_

_Long-press to copy. Paste into Notes,
then remove what you already have._

[← Back to plan]
```

**Key design decisions:**
- **Grouped by category** — maps to store sections (produce, fish, dairy, pantry, etc.). The user decides which store to buy from.
- **Shows what the list is for** — "For: Salmon Pasta (3 servings) + Breakfast restocking." The user knows why each item is there.
- **List format with dashes (-)** — simple, readable, copies cleanly as plain text. The user converts to checkboxes in Apple Notes if they want (Notes supports this natively).
- **Three-tier ingredient intelligence** — not magic, just practical:
  1. **Never shown:** Universal basics the user always has — water, salt, black pepper. These never appear on any shopping list. Hardcoded exclusion list.
  2. **"Check you have" section:** Long-lasting pantry items — spices, olive oil, vinegar, soy sauce. Bought once, last weeks/months. Shown in a separate section at the bottom, not in the main buy list. The user glances at it and skips if stocked. This prevents the annoying pattern where ground cumin appears on every shopping list for a year after one purchase, but also prevents the painful moment of discovering you're out of cumin at cook time.
  3. **Main buy list:** Perishables and items consumed per batch — proteins, produce, dairy, grains/pasta. These are the actual shopping items with quantities and checkboxes.
  The ingredient `role` field in the recipe system (seasoning, base, protein, carb, fat, vegetable) provides the starting heuristic: `seasoning` → tier 2, everything else → tier 3 by default. A small hardcoded exclusion list handles tier 1 (salt, pepper, water). No smart pantry tracking needed.
- **Aggregated across meals** — if two recipes use garlic, show one combined amount.
- **Copy action** — Telegram bots cannot copy to clipboard programmatically. The user long-presses the message and selects "Copy" manually — the list is plain text so this works cleanly. Flow: long-press → copy → paste in Apple Notes → remove what you have → add extras → shop. The "Long-press to copy, paste into Notes, remove what you already have" line in the message is the only affordance needed.
- **Context-aware, defaults to next shopping need:** From any entry point, defaults to the next upcoming cook day + breakfast. **Batching rule:** include the next cook day only (at most two cook sessions if both lunch and dinner are cooked that day). Cap: never more than one day's cooking. This keeps the list tight and matches JTBD A2's job: "my next cook session" and "one efficient grocery run" — not a multi-day wholesale trip. When accessed from a specific day's [Get shopping list], scoped to that day's cook session + prorated remaining breakfast (breakfast is always included regardless of entry point). If the user wants more, they can check individual days via the Week Overview.
- **Breakfast ingredients prorated to remaining days** — included in every shopping list, but only for the remaining plan days (not the full week). If it's Thursday with 4 days left, show 4 avocados, not 7. This is stateless — no tracking of prior shopping lists needed. Breakfast is suggested, not pantry-aware; the user removes what they already have during manual reconciliation, same as any other ingredient. Don't overengineer this — the manual reconciliation model handles it.

---

### Screen: Progress (serves D2)

**Entry:** User taps [Progress] from main menu.

**v0.0.4 content (measurements only):**
```
Drop your weight (and waist if you track it):

Examples: "82.3 / 91" or just "82.3"
```

After logging:
```
Logged ✓ 82.3 kg / 91 cm
```

Weight-only:
```
Logged ✓ 82.3 kg
```

That's it — no averages, no stats, no mid-week numbers. Just a clean confirmation. The user logs and moves on with their day.

Already logged today (user taps [Progress] again):
```
Already logged today ✓
```

**Inline keyboard (if a completed weekly report exists):**
```
[Last weekly report]
```

This lets the user replay the most recent completed report without exposing mid-week partial data.

**Weekly report (shown once per week, end of week):**
```
**Week of Mar 30 – Apr 5**

Weight: **82.1 kg** avg (↓0.4 from last week)
Waist: **90.5 cm** avg (↓0.3 from last week)

Steady and sustainable. _0.2-0.5 kg/week
is a healthy, sustainable pace._
```

The weekly report is the only place averages and comparisons appear. It's delivered once, at the end of the week — not available on demand mid-week. This prevents the "let me check how I'm doing" anxiety loop.

**Tone by scenario:**
- **Losing 0.2-0.5 kg/week:** "Steady and sustainable. This is a healthy pace."
- **Losing >0.5 kg/week:** "Great progress. If this pace holds, we might ease up slightly — sustainability matters more than speed."
- **Plateau (±0.1 kg):** Contextualize using waist data if available ("Weight is stable but your waist is down 0.5 cm — you're recomposing, the scale will catch up"). If no waist data: "Weight is stable — normal. Fluctuations mask fat loss. Keep going." Exact copy at implementation time.
- **Up 0.3+ kg:** "Week-to-week fluctuations happen — water, food volume, stress. One week doesn't define the trend. Keep going."

**Key design decisions:**
- **Input is natural language: one or two numbers.** "82.3 / 91", "82.3 91", or just "82.3" for weight only. No forms, no buttons, no follow-ups. Under 5 seconds. Waist is optional — some users won't have a tape measure, and that's fine.
- **Disambiguation:** Two numbers could be ambiguous (is 98/104 weight 98 waist 104, or the reverse?). The product uses previous measurements to resolve: if last weight was 97.5 and last waist was 103, then 98/104 is unambiguous. If genuinely unclear (first entry, or numbers are close), ask once: "Is that 98 kg weight and 104 cm waist?" Never guess wrong silently.
- **Weight-only is first-class.** The product gently encourages waist tracking (better fat loss signal, less fluctuation) but never nags.
- **Time-aware prompt:** If local time is afternoon or later, add a qualifier: "If this is your morning weight, drop it here." Morning measurements (before eating) are the only consistent data point; afternoon weights include food, water, and activity noise.
- **Daily logging response is just a confirmation** — no averages, no comparisons, no "so far this week." The user logs and moves on. Showing mid-week stats invites daily checking and anxiety about partial data.
- **Weekly report is the only place averages appear** — delivered once at end of week. The last completed weekly report can be replayed on request, but if the current week is incomplete the product says "Your next report is ready Sunday" — no mid-week partial averages. The tone adapts to the scenario (steady loss, plateau, or temporary gain) — always non-judgmental, always contextualizing.
- **Weekly report is the primary output** — strict weekly average compared to last week's average. Simple trend: ↓ good, → plateau (contextualized as normal), ↑ contextualized gently.
- **Tone is always encouraging and contextualizing.** Weight up? "Normal fluctuation." Plateau? "Your body is adjusting — waist is still trending down." No alarm, no judgment.
- **First month strategy:** Product celebrates early (water-weight) progress enthusiastically. When progress slows, explains this is actually better — "now you're losing fat, not just water."
- Treat logging and budget checking do NOT live here — treat logging is free-text from any screen (freeform layer), budget checking belongs in the plan view after deviations.

---

### Screen: Post-Confirmation (serves B1 → A1 transition)

**Entry:** User just confirmed a plan (tapped "Looks good!").

This is a critical transition moment. The current product says "Plan locked for Mon – Sun. Shopping list ready." — which is a dead end. The new design bridges immediately into the next action.

**Content:**
```
Plan locked for Mon Apr 6 – Sun Apr 12 ✓

Your first cook day is Monday:
🔪 Lunch: Moroccan Beef Tagine (3 servings)
🔪 Dinner: Chicken Pepperonata (3 servings)

You'll need to shop for both + breakfast.

[Get shopping list]  [View full week]
```

**Key design decisions:**
- Immediately answers "what's next?" — doesn't just confirm the plan and stop.
- Surfaces the first cook session and the need to shop.
- Two actions: shopping list (the most likely next step) and view the full week (curiosity).
- No wall of text — just the actionable minimum.

---

### Screen: Recipe Library (plan-aware)

**Entry:** User taps [My Recipes] from main menu.

Paginated recipe list, tap to view, edit, delete. When an active plan exists, the list becomes plan-aware:

**Sort order:**
1. **Cooking soon (by next cook date)** — recipes with upcoming cook days, sorted by how soon you'll cook them. The recipe you're cooking tomorrow appears first.
2. **Everything else** — alphabetical. Simple, predictable, easy to scan.

**List display:**
```
Your recipes (12 total):

COOKING SOON
🔪 Moroccan Beef Tagine — cooking tomorrow
🔪 Chicken Pepperonata — cooking Thursday

ALL RECIPES
   Chicken Pepperonata
   Greek Lemon Chicken
   Moroccan Beef Tagine
   Salmon Pasta
   Spiced Lamb Bowl
   ...
```

The "Cooking soon" section shows only recipes with upcoming cook days — not reheats. Reheat days are zero-interaction (JTBD), so promoting them in the recipe library adds noise. Reheats are visible in [My Plan], not here. The full alphabetical list below includes all recipes for browsing and editing — including recipes that also appear in Cooking Soon. If a recipe appears in both sections, the 🔪 button (Cooking Soon) opens cook view; the same recipe's button in ALL RECIPES opens library view.

**Inline keyboard:**
Each recipe is a tappable button (existing implementation). Paginated with prev/next if needed.
```
[🔪 Moroccan Beef Tagine]
[🔪 Chicken Pepperonata]
[Salmon Pasta]
[Spiced Lamb Bowl]
[← Prev]  [Next →]
```

When the user taps a 🔪 plan recipe, it opens the **cook view directly** — batch totals, inline amounts, ready to cook. The 🔪 on the button promises a cook action, so it should deliver one. A [View in my recipes] link at the bottom bridges to the library view if needed. When the user taps a non-plan recipe (no 🔪), it opens the normal library view.

### Recipe presentation: two contexts, one recipe

Internally, the product distinguishes between template recipes (library) and scaled recipes (plan). The user must never see this distinction — it's an implementation detail. The product presents the same recipe differently based on **where the user came from**:

| Entry point | What the user sees | Why |
|---|---|---|
| **[My Recipes] → recipe** | Library view: per-serving amounts, original macros, cuisine/tags, edit/delete options | Browsing the cookbook, managing recipes |
| **[My Plan] → recipe** | Cook-time view: total batch amounts, inline in steps, servings count, scaled macros, storage instructions | Standing in the kitchen, cooking this specific batch |

**No labels.** No "template recipe" / "scaled recipe" language. No explanations about scaling. The user sees "my recipe" in the library and "what I'm cooking" in the plan. The product handles the difference silently.

**How the recipe adapts to context:**

The user sees one recipe, not two versions. The product adjusts what it shows based on context:

- **From [My Plan]:** The recipe opens ready to cook — batch totals, inline amounts in steps, servings count. This is the natural context: the user is looking at their plan, they tap a meal, they want to cook.

- **From [My Recipes]:** Depends on the button the user tapped:
  - **🔪 plan recipe** → opens the cook view directly (batch totals, inline amounts, ready to cook). The 🔪 promises a cook action, so it delivers one. [View in my recipes] at the bottom bridges to the library view if the user wants to edit or browse.
  - **Non-plan recipe (no 🔪)** → opens the normal library view (per-serving amounts, cuisine/tags, edit/delete options).
  
  One rule: 🔪 = cook view. No 🔪 = library view. No exceptions, no banners, no mixed signals.

- **From the cook view → editing:** The cook view includes a subtle [Edit this recipe] link at the bottom. This opens the library view with edit/delete options — for when the user wants to permanently change an ingredient or fix a step. "Edit this recipe" is self-explanatory; it's the only reason to go from cooking to the library.

**The rule:** the product never uses the words "template," "scaled," "cook-time version," or "library version" in any user-facing text. These are internal concepts. The user just has recipes, and the product shows them the right way at the right moment.

---

## Navigation map

```
Main Menu (reply keyboard - always visible, top-left label adapts to lifecycle)
│
├─ [Plan Week / Resume Plan / My Plan]
│   ├─ no_plan → "No plan for this week" + [Plan Week] button
│   ├─ planning → resumes planning flow
│   └─ active → Next Action screen
│       ├─ [🔪 Recipe — N servings] → Cook-Time Recipe
│       ├─ [Get shopping list] → Shopping List (next cook session)
│       └─ [View full week] → Week Overview
│           ├─ [Day button] → Day Detail
│           │   ├─ [🔪 Recipe — N servings] → Cook-Time Recipe
│           │   └─ [Get shopping list] → Shopping List (scoped)
│           └─ [← Back] → Next Action
│
├─ [Shopping List]
│   ├─ no_plan → "No plan" message
│   └─ active → Shopping List (next cook session + breakfast)
│
├─ [My Recipes]
│   └─ Recipe Library
│       ├─ [🔪 plan recipe] → Cook-Time Recipe → [View in my recipes] → Library View
│       └─ [non-plan recipe] → Library View → Edit/Delete
│
└─ [Progress]
    ├─ No measurements today → prompt for numbers
    ├─ Already logged → "Already logged today ✓"
    └─ Weekly report → delivered end of week (last completed report viewable on request)
```

---

## Information hierarchy principles

These rules govern what information appears, in what order, across all screens:

### 1. Action at the bottom, context above

In Telegram, long messages appear with the **bottom visible first** — the user sees the end of the message and the inline keyboard without scrolling. This inverts typical web design. The most important action or takeaway should be near the bottom, close to the buttons. Supporting context and detail lives above — the user scrolls up if they want it. "Cook lunch tomorrow" and the buttons should be what the user sees without scrolling; the full day-by-day breakdown is above for those who want it.

### 2. Near horizon over far horizon

Today and tomorrow are always visible. The rest of the week is one tap away. Next week doesn't exist until this week is ending.

### 3. Batch context over meal granularity

The user thinks in batches ("I'm cooking Moroccan Beef Tagine, 3 servings") not in individual meals ("Monday lunch is 803 cal, Tuesday lunch is 803 cal"). Show batch info: recipe name, servings count, day range, cook-or-reheat status.

### 4. Weekly target status over calorie numbers

Avoid daily calorie totals. Show recipe-level per-serving numbers only where they help cooking or flex-meal decisions (cook-time recipe header, day detail). Use weekly target status ("on track ✓") for plan-level surfaces like the Week Overview — no exact numbers, no warnings. This aligns with "weekly control > daily perfection" and "not a tracker."

### 5. Progressive disclosure

Next Action (3 days) → Week Overview (7 days) → Day Detail (one day) → Cook-Time Recipe (full recipe). Each level adds detail. The user drills in only when they need to.

### 6. Status through visual markers

- 🔪 = cook (requires action)
- No marker = reheat (no action needed)
- 🍽️ = restaurant/event
- **Flex** = flex meal (bold text, no emoji — it's normal, not a reward)
- Dash (-) = shopping list item

Minimal, scannable. The user reads the markers before the text.

---

## Freeform conversation layer

This is one of the most important architectural decisions in the product. The product runs on deterministic state-machine rails — but it lives in a chat UI where users expect to type anything at any time and be understood. If the product can't handle this, it feels dumb, and that friction violates the #1 product principle.

> **Plan 027 (Navigation state model)** lays the precise state-tracking rails this freeform layer will read. See the Navigation state section above.

### The core problem

At any point in any flow — mid-planning, reviewing a recipe, looking at the plan view — the user might type something instead of tapping a button. What they type falls into three categories:

1. **Flow-relevant input** — the flow expects free-text here (e.g., "I'm eating out Friday dinner" during event collection, or "swap Tuesday lunch for something with lamb" during plan review). This already works — the current flow handlers process it.

2. **Contextual question** — the user is referencing something visible in the conversation and asking about it. "How many calories is that?" "Can I freeze this?" "What's the protein in the salmon pasta?" They expect the product to understand what "that" refers to from the messages above.

3. **Domain question** — "How much protein is in 100g of chicken?" "What's a good substitute for tahini?" Not about the current flow but within the product's domain (food, nutrition, cooking, meal planning). The product answers briefly and routes back to the active flow — it doesn't become a general nutrition-coaching thread. For questions outside the domain entirely ("What time does Mercadona close?", "What's the weather?"), the product is honest: "I can't help with that — I do meal planning, recipes, and nutrition. Try: 'change Thursday dinner' or tap a button." Never ignore, never pretend to have live data, never become a general assistant.

### Design rules

**Rule 1: Never ignore free-text.** Every typed message gets a response. The worst possible behavior is silence or "I don't understand, please tap a button."

**Rule 2: Context travels with the branch.** When a side conversation starts, it carries the full context: what flow the user is in, what phase, what's on screen, what messages preceded the question. The LLM needs this context to understand references like "that recipe" or "this meal."

**Rule 3: The flow never dies.** A side conversation is a branch, not a replacement. The underlying flow state is preserved. When the side conversation ends (naturally or via the back button), the user returns exactly where they were.

**Rule 4: Persistent [← Back to ...] button.** Every side-conversation response includes an inline button to return to the active flow. The user is never trapped in a conversational dead end without a way back to what they were doing.

**Rule 5: The transition must feel seamless.** Branching into a side conversation and returning should feel like asking a friend a quick question while cooking — natural interruption, natural return. No "entering conversation mode" / "exiting conversation mode" ceremony.

**Rule 6: Domain answers are read-only.** Informational questions ("What's a substitute for tahini?", "How much protein in chicken?") get informational answers. They must never mutate plan state — no recipe swaps, no ingredient changes, no budget adjustments unless the user explicitly asks for a plan change. This prevents "What's a good substitute for salmon?" from accidentally becoming a recipe swap.

### How it works (target architecture)

```
User types free-text during any flow
  ↓
Intent classifier (nano LLM, fast)
  ├── flow_input → route to current flow handler (existing behavior)
  ├── contextual_question → branch into side conversation
  │     LLM receives: question + flow state + recent message history
  │     Response includes: answer + [← Back to {flow name}] button
  │     Multi-turn follow-ups supported until user returns
  └── domain_question →
        ├── food/nutrition/cooking related → answer briefly, route back to flow
        └── outside product domain → "I can't help with that — I do meal planning, recipes, and nutrition."
        Both include [← Back to {flow name}] button
```

### Implementation phasing

- **v0.0.4:** Free-text that doesn't match the current flow phase gets a graceful fallback. The fallback examples must be lifecycle-aware — don't suggest plan actions when no plan exists:
  - **no_plan:** "I can help you plan your week, browse recipes, or log measurements. Tap Plan Week to get started."
  - **active plan:** "I can help with your plan, recipes, shopping, or measurements. Try: 'change Thursday dinner' or tap a button."
  - **recipe context:** "I can help with this recipe or your plan. Try: 'can I freeze this?' or tap a button."
  Don't promise "ask me anything" when the full freeform layer isn't built yet — only invite capabilities the product can actually deliver.
- **v0.0.5:** Full freeform conversation layer with intent classification, context injection, and seamless branching/return. This is when the product starts feeling truly conversational.

### Why this matters so much

The product is a Telegram bot. Users talk to bots. If the bot can only respond to button taps, it's an app wearing a chat costume — and a bad app at that, because it lacks the visual affordances of a real app. The freeform layer is what makes the chat format an advantage rather than a limitation. It's not a nice-to-have — it's what makes the product feel intelligent rather than scripted.

### Inbound message routing (Plan 028 — dispatcher front door, v0.0.5 minimal slice)

Plan 028 implements the infrastructure + the minimal action set for the freeform conversation layer. Every inbound text and voice message that isn't a slash command, an inline callback, or a reply-keyboard main-menu tap is routed through a single LLM-driven **dispatcher** that picks exactly one action from a small catalog. Plans D and E extend the catalog with `mutate_plan`, answers, navigation, and measurement logging.

#### Where the dispatcher sits

`core.dispatch()` branches by update type:

- `command` → `handleCommand` (slash commands; bypass the dispatcher)
- `callback` → `handleCallback` (inline button taps; bypass)
- `text` → `matchMainMenu` first (reply-keyboard main-menu buttons bypass), then `runDispatcherFrontDoor`
- `voice` → `runDispatcherFrontDoor` directly (transcription happens in `bot.ts`)

`runDispatcherFrontDoor` (in `src/telegram/dispatcher-runner.ts`) is the integration layer. It:

1. Runs the narrow **numeric pre-filter** — when `progressFlow.phase === 'awaiting_measurement'` and the text is parseable as a measurement, the measurement is logged inline without an LLM call and WITHOUT recentTurns bookkeeping. See `tryNumericPreFilter`.
2. Short-circuits **planning meta-intents** — "nevermind", "forget it", "start over" etc. reach the existing cancel/restart handler BEFORE the dispatcher runs when `planFlow` is active. The raw sink is used here (not the bot-turn wrapper); cancel is a flow termination, not a conversational turn, so `recentTurns` stays untouched. See `matchPlanningMetaIntent` and the Plan 028 precedence doc comment in `plan-flow.ts`.
3. Wraps the sink in `wrapSinkForBotTurnCapture` so every downstream action branch (flow_input, clarify, out_of_scope, return_to_flow) contributes a bot turn uniformly. The wrapper buffers each `sink.reply` (overwriting the previous capture) and the runner commits the most recent one via `flushBotTurn` in a `try/finally` after the action handler returns. This handles multi-message branches like the recipe flow (holding message + substantive reply) correctly: only the substantive reply lands in `recentTurns`.
4. Builds the **context bundle** via `buildDispatcherContext` — surface, lifecycle, active flow summary, recent turns, plan summary, recipe index, allowed actions.
5. Pushes the user turn onto `session.recentTurns` (ring-buffered at 6).
6. Calls `dispatchMessage` (the pure agent in `src/agents/dispatcher.ts`) with the context and user text.
7. Dispatches the returned `DispatcherDecision` to the action handler inside a `try/finally`. `flushBotTurn(sink)` runs in the `finally` block so the most recent `sink.reply` from the handler lands in `recentTurns` even if the handler throws.
8. On `DispatcherFailure`, falls back to `replyFreeTextFallback` (still routed through the wrapped sink — the fallback message also lands in recentTurns so the dispatcher sees it on the next turn).

#### v0.0.5 minimal action catalog (Plan 028)

Only four actions are implemented. The dispatcher's prompt describes the full proposal-003 catalog (including deferred actions) with availability markers, so Plans D and E only flip the marker without rewriting the prompt.

| Action | Implemented | Behavior |
|---|---|---|
| `flow_input` | ✅ Plan 028 | Forward text to the active flow's text handler unchanged. |
| `clarify` | ✅ Plan 028 | Dispatcher asks a clarifying question; state unchanged. |
| `out_of_scope` | ✅ Plan 028 | Dispatcher declines honestly and offers the menu. |
| `return_to_flow` | ✅ Plan 028 | Re-render the active flow's last view, or `lastRenderedView`. |
| `mutate_plan` | ✅ Plan 029 | Classifies any plan-change request. In-session: delegates to handleMutationText. Post-confirmation: runs the split-aware adapter + re-proposer in post-confirmation mode + solver + diff, shows `[Confirm] [Adjust]`, persists via confirmPlanSessionReplacing. |
| `answer_plan_question` / `answer_recipe_question` / `answer_domain_question` | ✅ Plan 030 | LLM-generated answers scoped to plan context, recipe context, or general food/nutrition domain. Read-only — never mutates state. |
| `show_recipe` / `show_plan` / `show_shopping_list` / `show_progress` | ✅ Plan 030 | Natural-language navigation: resolves slugs, day names, and scopes to existing view renderers. `show_recipe` picks cook view for in-plan slugs, library view otherwise; multi-batch picks soonest cook day. `show_plan` resolves natural-language day references to ISO dates. `show_shopping_list` supports `recipe` and `full_week` scopes. |
| `log_measurement` | ✅ Plan 030 | Logs a measurement from any surface (not just `awaiting_measurement`). Numeric pre-filter still handles the fast path; dispatcher handles the conversational path. `surfaceContext` preserved across the logging side-trip. |
| `log_eating_out` / `log_treat` | 🚫 Deferred beyond v0.0.5 | Proposal-committed but not scoped for v0.0.5. |

#### State preservation invariants (Plan 028)

The runner and its action handlers enforce:

1. **The dispatcher never clears `planFlow` or `recipeFlow`.** Side conversations leave flow state untouched. Only explicit flow completions, explicit cancellations, and natural terminations clear flow state.
2. **`flow_input` during an active planning proposal routes to the same `handleMutationText` path** — never starts a new planning session.
3. **Cancel precedence:** meta-intent cancel phrases short-circuit the dispatcher when a planning flow is active. See the Plan 028 doc comment above `CANCEL_PATTERNS` in `src/agents/plan-flow.ts` and scenario 041's regression lock.
4. **Pending sub-agent clarifications are preserved across side conversations.** The re-proposer's `pendingClarification` is carried into the dispatcher's context so the LLM knows there's an open question, and the clarification stays on `planFlow` state until the user eventually answers it via `flow_input`.
5. **`return_to_flow` re-renders; it does not start fresh.** Fidelity is three-tiered in Plan 028:
   - **Byte-identical** for `planFlow.phase === 'proposal'` (reads stored `proposalText`) and `recipeFlow.phase === 'reviewing'` (reads `currentRecipe` via `renderRecipe`). Scenarios 039 and 043 are the regression locks.
   - **Phase-canonical prompt** for every other active-flow phase. The `getPlanFlowResumeView` / `getRecipeFlowResumeView` helpers (`src/telegram/flow-resume-views.ts`) emit a short re-entry prompt keyed on phase + structural state. Semantically correct, not byte-identical.
   - **Placeholder reply** for the no-flow case — "Back to X. Tap 📋 My Plan for the current view." plus the main menu reply keyboard.
   Plan 030 (Task 19) promoted tiers 2 and 3 to byte-identical via `rerenderLastView` delegation to the view-renderers module.
6. **Natural-language back commands are equivalent to back-button taps (invariant #7).** Both typed "back to the plan" and the inline `[← Back to planning]` button delegate to `handleReturnToFlowAction` from the runner, with the callback path wrapping its sink for `recentTurns` capture so both paths contribute equivalent context for the next dispatcher call. Scenarios 039 and 043 lock this in jointly.
7. **Recent turns are ring-buffered at 6 entries and capture both sides.** `recentTurns` records the user's message plus the **last** bot reply for every dispatcher-handled turn — including replies produced by downstream flow handlers (`flow_input` → re-proposer output, recipe renders) via `wrapSinkForBotTurnCapture`. Bot turns are truncated to `BOT_TURN_TEXT_MAX` (500) chars at capture time. The cancel meta-intent short-circuit and the numeric pre-filter are the two documented bypasses: they run with the raw sink and add nothing to `recentTurns` because they are flow terminations / parse-only fast paths, not conversational turns.

#### Numeric measurement pre-filter

One narrow exception to "dispatcher is the front door": during `progressFlow.phase === 'awaiting_measurement'`, the runner first tries `parseMeasurementInput(text)`. If it returns a non-null result, the measurement is logged (possibly after disambiguation) and the runner returns WITHOUT calling the dispatcher. If parsing fails, the runner proceeds to the dispatcher normally. The `recentTurns` buffer is NOT updated for pre-filter-handled turns.

### Post-confirmation mutation lifecycle (Plan 029)

When the dispatcher picks `mutate_plan` AND the session has no active planning flow AND the store has an active or upcoming plan, the applier runs the **post-confirmation branch**:

1. **Load the active plan.** `getRunningPlanSession(today)` first, falling back to `getFuturePlanSessions(today)[0]` if no running session.
2. **Split at the (date, mealType) cutoff.** Plan 026's `sessionToPostConfirmationProposal` produces `activeProposal`, `preservedPastBatches`, and `nearFutureDays`.
3. **Call the re-proposer in `post-confirmation` mode** with the meal-type lane rule and near-future safety rule enforced.
4. **Run the solver** on the re-proposer's active output.
5. **Diff against the pre-mutation active view** using `diffProposals`.
6. **Stash `PendingMutation` on `BotCoreSession.pendingMutation`.**
7. **Show `[Confirm] [Adjust]`** — `mutateConfirmKeyboard`.

The user then taps:
- **`mp_confirm`** — `applyMutationConfirmation` calls `buildReplacingDraft` + `confirmPlanSessionReplacing`. Old session tombstoned, new session inserted with extended `mutationHistory`. User sees "Plan updated" + calorie-tracking disclaimer.
- **`mp_adjust`** — `pendingMutation` cleared, user prompted for a new description.

Post-confirmation clarifications persist via `BotCoreSession.pendingPostConfirmationClarification` (invariant #5). The user answers the question on the next turn without re-stating the full request.

### Secondary actions (Plan 030)

Plan 030 promotes the remaining eight catalog actions from deferred to implemented, completing the v0.0.5 freeform conversation layer.

**Answer actions** (`answer_plan_question`, `answer_recipe_question`, `answer_domain_question`): The dispatcher classifies the user's question into one of three scopes and routes to an LLM-generated answer. Plan-scoped questions receive the active plan summary as context. Recipe-scoped questions receive the recipe the user is currently viewing (via `lastRenderedView`). Domain-scoped questions are answered from general food/nutrition/cooking knowledge. All three are strictly read-only — they never mutate plan or session state. Each answer includes a `[← Back to ...]` inline button so the user can return to their previous surface.

**Navigation actions** (`show_recipe`, `show_plan`, `show_shopping_list`, `show_progress`): The dispatcher extracts structured parameters (slug, date, scope) from the user's natural-language request and delegates to the existing view renderers.

- `show_recipe` resolves a slug. If the slug appears in an active batch, the cook view renders (same as tapping the batch button from the plan). If not, the library detail view renders. When a recipe appears in multiple batches, the soonest cook day is picked.
- `show_plan` resolves natural-language day references ("Thursday", "tomorrow", "next cook day") to ISO dates and renders the day-detail view.
- `show_shopping_list` supports two scopes: `recipe` (filters ingredients to one recipe) and `full_week` (aggregates across all cook days — the same output as the main shopping list button but reachable conversationally).
- `show_progress` renders the weekly summary report.

**Measurement logging** (`log_measurement`): Extends the numeric pre-filter's capability to any surface. When the dispatcher picks `log_measurement`, the handler persists the measurement and confirms without requiring the user to navigate to the Progress screen first. `surfaceContext` is preserved so the user's previous view is undisturbed.

**State preservation across secondary actions**: All secondary actions inherit the Plan 028 state-preservation invariants. `planFlow`, `recipeFlow`, `pendingClarification`, and `pendingPostConfirmationClarification` are never cleared by a secondary action. The user can ask a question, navigate to a recipe, log a measurement, and return to an in-progress planning session — all without losing state.

---

## First week experience

The first week is disproportionately important — more than any other week. Not because of weight loss (first-week results are mostly water), but because of **adherence formation**. If the first week feels smooth, the user builds momentum and stays. If it feels clunky, confusing, or effortful, they drop off — and then the product fails at its core job (sustained weight loss) and its business job (conversion to paid).

This is not about onboarding, education, or tutorials (those come later with multi-user). This is about the core product experience being frictionless from day one.

### What "smooth as silk" means for week one

**Planning session:** The user's first planning session must feel guided and fast. They shouldn't have to figure out what the product wants from them. Every step should feel obvious. The suggestive-first model (system proposes, user approves) is already the right foundation — but the copy, button labels, and transitions must be polished enough that a first-time user never hesitates.

**Post-confirmation:** The moment after the first plan is confirmed is critical. The user just invested effort in planning — if the product says "Plan locked" and goes quiet, the momentum dies. The Post-Confirmation screen must immediately surface the next action and make the user feel "okay, I know exactly what to do next."

**First cook session:** The user opens the recipe for the first time. If the recipe is confusing, if the amounts are wrong, if they can't find what they need — they lose trust in the product. The cook-time recipe view must be flawless on first encounter.

**First shopping trip:** If the shopping list is incomplete, badly grouped, or missing breakfast items — the user arrives home without what they need, and the plan breaks on day one.

**First measurement:** Logging weight/waist for the first time should take under 10 seconds and feel rewarding. "Logged ✓. Come back tomorrow — we'll start tracking your trend." No setup, no forms, no configuration.

### Light-touch education

The product should teach its method through the experience, not through instructions. A few contextual hints — not a tutorial:

- First plan: "I'll suggest a complete week — you just approve or tweak."
- First flex meal: "This is your flex meal — eat something fun, ~1,150 cal budget."
- First treat budget mention (v0.0.5, when treat tracking lands): "You have ~850 cal for treats this week. Spend whenever."
- First measurement: "We track weekly averages, not daily — so don't worry about day-to-day swings."

Each hint appears once, in context, at the moment it's relevant. Not a sequence of screens the user has to tap through before using the product.

---

## Copy and messaging tone

The product's voice should be:

- **Calm and confident** — "You're set" not "Don't forget to..."
- **Brief** — every message should be as short as it can be while remaining useful. No filler.
- **Action-oriented** — tell the user what to do, not what the system did. "Cook lunch tomorrow" not "The system has generated your meal plan for the following week."
- **Non-judgmental** — deviations are normal, not failures. "Your treat budget absorbed it" not "You exceeded your daily target."
- **Anti-anxious** — the product's job is to reduce food anxiety, not create it. When in doubt, reassure.

**Avoid:**
- Exclamation marks on routine actions ("Plan saved!" → "Plan locked ✓")
- Calorie-forward messaging ("Your lunch is 803 calories" → "Lunch: Moroccan Beef Tagine")
- Guilt or urgency language ("You haven't planned yet!" → "No plan for this week. Ready to plan?")
- Technical/enterprise language in user-facing copy — "active plan", "plan session", "cook session", "template", "scaled", "batch target". These are internal concepts. The user has "my plan", "my recipes", and "what I'm cooking." Verify every message, button label, and prompt against this rule.
- Over-explaining ("The system will now generate..." → just do it)
- Emoji overuse — markers (🔪🍽️🎉) are functional, not decorative.

### Recipe naming

Every recipe needs two names:

- **Short name** (max ~25 chars) — used in plan views, week overview, shopping list headers, anywhere space is tight. Examples: "Beef Tagine", "Chicken Pepperonata", "Salmon Pasta", "Avocado Toast & Eggs".
- **Full name** — used inside the recipe view itself. Can be more descriptive: "Moroccan Beef Tagine with Preserved Lemon", "Chicken Pepperonata Skillet with Basmati Rice".

The short name is what the user sees 90% of the time. It must be instantly recognizable — the user should know which recipe it is from 2-3 words. The full name adds color when they're reading the actual recipe. The recipe generator prompt must produce both.
