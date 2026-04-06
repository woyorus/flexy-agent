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

The product is always in exactly one of these states. The state determines what the user sees when they open the chat, what the main menu does, and which jobs are active.

### State 1: No plan

The user has never planned, or their last plan has expired and no new one exists.

**When:** First launch, or week ended without replanning, or vacation return.

**Primary job:** B1 (Plan my week).

**What the user sees:**
- Opening the chat: a welcome/prompt message encouraging planning. Not aggressive — the product doesn't guilt. Something like: "No plan for this week. Ready to plan?"
- Main menu: [Plan Week] is the primary action. Other buttons (Shopping List, My Plan) show contextual "no plan" states.

**Emotional tone:** Inviting, not scolding. The user might be returning from vacation. "Welcome back" energy, not "you missed your plan" energy.

### State 2: Planning in progress

The user is mid-flow in the weekly planning session.

**When:** User tapped [Plan Week] and is going through the phases (breakfast confirmation → events → proposal → approval).

**Primary job:** B1 (Plan my week).

**What the user sees:**
- The planning conversation dominates the chat. Inline keyboards guide each step.
- Main menu buttons should still work (user might tap [My Recipes] to check something mid-planning), but the planning flow resumes when they return.
- This state already works well in the current product — the suggestive-first flow is solid.

### State 3: Active plan — early week

The plan was just confirmed (today or yesterday). The user is in execution mode — first cook sessions, first grocery runs.

**When:** Plan confirmed within the last 1-2 days. Most meals are still ahead.

**Primary jobs:** A1 (next action), A2 (shopping list), A3 (cook from plan), A4 (browse week).

**What the user sees:**
- Opening the chat after confirmation: the "next action" summary — what to cook next, what to shop for.
- Main menu: [My Plan] (renamed from [Plan Week]) shows the plan surface. [Shopping List] generates/shows the list.

**Emotional tone:** Energized, prepared. "Here's your week. First up: shop for Monday's lunch."

### State 4: Active plan — mid-week

Several days into the plan. Some meals consumed, some ahead. The rhythm is established.

**When:** Day 3-5 of the plan.

**Primary jobs:** A1 (next action — still #1), A3 (cook from plan), A5 (flex meal approaching?).

**What the user sees:**
- Opening the chat: the "what's next" view — focused on today and the next 2 days.
- Past days fade — the user doesn't need to see Monday's meals on Thursday.

**Emotional tone:** Steady, calm. "You're on track. Tomorrow: cook dinner."

### State 5: Active plan — week ending

1-2 days left in the plan. Most meals consumed.

**When:** Day 6-7 of the plan.

**Primary jobs:** A1 (next action for remaining days), B1/B2 (plan next week).

**What the user sees:**
- The "what's next" view shows remaining meals + a natural prompt: "Your plan ends Sunday. Want to plan next week?"
- Not a separate notification (yet — that's v0.0.6). Just contextual awareness in the existing view.

**Emotional tone:** Wrapping up, forward-looking. "One day left. Saturday dinner is flex night. Ready to plan next week?"

### State 6: Mid-cook

The user has opened a specific recipe to cook from.

**When:** User drilled into a meal from the plan view and is now looking at the cook-time recipe.

**Primary job:** A3 (cook from plan).

**What the user sees:**
- The cook-time recipe view (batch totals, inline ingredients in steps, servings count).
- A way to get back to the plan view.
- Future: ability to say "I don't have salmon" (C1) — but for MVP, just the recipe.

### State 7: Shopping

The user has opened the shopping list and is (or will be) at the store.

**When:** User tapped [Shopping List] or navigated there from the plan view.

**Primary job:** A2 (build shopping list).

**What the user sees:**
- Grouped ingredient list, copy-friendly.
- Future: interactive checkboxes. For MVP: a clean text list they copy to Apple Notes.

---

## Main menu (reply keyboard)

The reply keyboard is the only persistent navigation. It must serve every product state without being cluttered.

### Current menu
```
[ Plan Week ]     [ Shopping List ]
[ My Recipes ]    [ Weekly Budget ]
```

### Proposed menu
```
[ My Plan ]       [ Shopping List ]
[ My Recipes ]    [ Track ]
```

**Changes and rationale:**

| Button | Old | New | Why |
|---|---|---|---|
| Top-left | Plan Week | **My Plan** | This button serves double duty: starts planning when no plan exists, shows the plan when one does. "My Plan" works in both states. "Plan Week" only makes sense for the planning action. |
| Top-right | Shopping List | **Shopping List** | Unchanged. This is the #2 daily job. |
| Bottom-left | My Recipes | **My Recipes** | Unchanged. Recipe library access. |
| Bottom-right | Weekly Budget | **Track** | "Weekly Budget" is a static view that's only interesting after deviations. "Track" becomes the entry point for measurements (D2: weight/waist) and eventually treat logging (A6) and budget checking (D1). It's where the user goes to record and reflect. |

### State-driven button behavior

**[My Plan]** adapts to product state:
- **No plan / expired plan:** Shows "No plan for this week" message + inline [Plan new week] button to start planning.
- **Planning in progress:** Resumes the planning flow where they left off.
- **Active plan (early/mid-week):** Shows the plan view (next action + week overview).
- **Active plan (ending, 1-2 days left):** Shows the plan view with a contextual [Plan next week] button embedded in the Next Action screen. The transition from "living the plan" to "planning the next one" happens naturally inside the plan view — not as a separate navigation action. The user sees "Your plan ends Sunday. Saturday dinner is your last cook. Ready to plan next week?" right where they're already looking.

**[Shopping List]** adapts to product state:
- **No plan:** "No plan yet — plan your week first to see what you'll need."
- **Active plan:** Shows the needs list for upcoming cook sessions — everything the recipes call for, grouped and sorted. The user cross-references against their kitchen and copies what they actually need to buy. If no cook sessions are imminent (all meals are prepped), says so.

**[Track]** adapts to product state:
- **Always available** regardless of plan state. Weight/waist tracking is independent of the meal plan.
- Default action: prompt for measurements if none today, show weekly summary if already logged.
- Future: also handles treat logging and budget checking. Note: weight tracking and food tracking are different moments — weight is a once-daily morning ritual, food tracking is reactive (just ate something, any time of day). [Track] serves both through contextual copy (leads with the right prompt based on time of day and what's already done), not by asking "what do you want to track?" Food logging will also work via free-text from any screen once the freeform conversation layer lands — the user shouldn't need to navigate to [Track] to say "had a Snickers."

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
- [Get shopping list] generates the needs list for upcoming cook sessions. Only shown when a cook session is upcoming (no point showing it if everything is prepped).
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

~800 cal/serving · Treats ~850 cal
**Weekly: 17,050 cal | 1,050g P ✓**

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
- Per-meal calories shown once as a uniform header ("each ~800 cal"), not per line. Aligns with "per-meal calories are informational."
- Weekly totals at the bottom — this is the number that matters.
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
- Avocados — 7 (breakfast)
- Lemons — 4 (breakfast)

**FISH**
- Salmon fillet — 600g

**DAIRY & EGGS**
- Eggs — 14 (breakfast)

**PANTRY**
- Penne pasta — 225g

_Check you have:
Ground cumin, chili flakes, smoked paprika_

Copy to Notes, remove what you already have

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
- **Copy button** — Telegram supports a copy-to-clipboard action. This is the critical UX affordance for the "take it to Apple Notes" job.
- **Context-aware:** when accessed from [My Plan], shows the next upcoming cook session. When accessed from a specific day's [Shopping list for this], scoped to that cook session. When accessed from main menu [Shopping List], shows the full remaining week.
- **Breakfast ingredients included** — the user told us this is essential and easy to forget.

---

### Screen: Track (serves D2, future: A6, D1)

**Entry:** User taps [Track] from main menu.

**v0.0.4 content (measurements only):**
```
Good morning! Drop your weight (and waist if you track it):

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

**Weekly report (shown once per week, end of week):**
```
**Week of Mar 30 – Apr 5**

Weight: **82.1 kg** avg (↓0.4 from last week)
Waist: **90.5 cm** avg (↓0.3 from last week)

Steady and sustainable. _0.2-0.5 kg/week
means you're losing fat, not muscle._
```

The weekly report is the only place averages and comparisons appear. It's delivered once, at the end of the week — not available on demand mid-week. This prevents the "let me check how I'm doing" anxiety loop.

**Tone by scenario:**
- **Losing 0.2-0.5 kg/week:** "Steady and sustainable. This pace means you're losing fat, not muscle."
- **Losing >0.5 kg/week:** "Great progress. If this pace holds, we might ease up slightly — sustainability matters more than speed."
- **Plateau (±0.1 kg):** Contextualize using waist data if available ("Weight is stable but your waist is down 0.5 cm — you're recomposing, the scale will catch up"). If no waist data: "Weight is stable — normal. Fluctuations mask fat loss. Keep going." Exact copy at implementation time.
- **Up 0.3+ kg:** "Week-to-week fluctuations happen — water, food volume, stress. One week doesn't define the trend. Keep going."

**Key design decisions:**
- **Input is natural language: one or two numbers.** "82.3 / 91", "82.3 91", or just "82.3" for weight only. No forms, no buttons, no follow-ups. Under 5 seconds. Waist is optional — some users won't have a tape measure, and that's fine.
- **Disambiguation:** Two numbers could be ambiguous (is 98/104 weight 98 waist 104, or the reverse?). The product uses previous measurements to resolve: if last weight was 97.5 and last waist was 103, then 98/104 is unambiguous. If genuinely unclear (first entry, or numbers are close), ask once: "Is that 98 kg weight and 104 cm waist?" Never guess wrong silently.
- **Weight-only is first-class.** The product gently encourages waist tracking (better fat loss signal, less fluctuation) but never nags. The waist tip appears a few times early on, then stops.
- **Daily logging response is just a confirmation** — no averages, no comparisons, no "so far this week." The user logs and moves on. Showing mid-week stats invites daily checking and anxiety about partial data.
- **Weekly report is the only place averages appear** — delivered once at end of week, not available on demand mid-week. This is where the user sees their trend and gets contextual encouragement. The tone adapts to the scenario (steady loss, plateau, or temporary gain) — always non-judgmental, always contextualizing.
- **Weekly report is the primary output** — strict weekly average compared to last week's average. Simple trend: ↓ good, → plateau (contextualized as normal), ↑ contextualized gently.
- **Tone is always encouraging and contextualizing.** Weight up? "Normal fluctuation." Plateau? "Your body is adjusting — waist is still trending down." No alarm, no judgment.
- **First month strategy:** Product celebrates early (water-weight) progress enthusiastically. When progress slows, explains this is actually better — "now you're losing fat, not just water."
- Future: this screen also handles treat logging ("had a small Snickers") and budget checking.

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
1. **In your plan (by next cook date)** — recipes with upcoming cook sessions, sorted by how soon you'll cook them. The recipe you're cooking tomorrow appears first.
2. **Everything else** — alphabetical. Simple, predictable, easy to scan.

**List display:**
```
Your recipes (12 total):

IN YOUR PLAN
🔪 Moroccan Beef Tagine — cooking tomorrow
   Chicken Pepperonata — cooking Thursday
   Greek Lemon Chicken — reheat (cooked Tue)

ALL RECIPES
   Chicken Pepperonata
   Greek Lemon Chicken
   Moroccan Beef Tagine
   Salmon Pasta
   Spiced Lamb Bowl
   ...
```

The plan section shows only recipes with upcoming action (cook or active reheat batches). The full alphabetical list below includes everything, including the plan recipes — because the user might be browsing to edit or just looking around, not cooking.

**Inline keyboard:**
Each recipe is a tappable button (existing implementation). Paginated with prev/next if needed.
```
[🔪 Moroccan Beef Tagine]
[Chicken Pepperonata]
[Greek Lemon Chicken]
[Salmon Pasta]
[Spiced Lamb Bowl]
[← Prev]  [Next →]
```

When the user taps a plan recipe, it opens the library view with the [🔪 Cook N servings] banner prominent at the top — the natural next step. When they tap a non-plan recipe, normal library view without the banner.

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

- **From [My Recipes]:** The recipe opens in library mode — per-serving amounts, cuisine/tags, edit/delete options. But if this recipe is in the active plan, a banner appears at the top:
  ```
  You're cooking this Wed–Fri dinner
  [🔪 Cook 3 servings]
  ```
  Tapping [🔪 Cook 3 servings] shows the recipe with batch totals and inline amounts — the same view they'd get from the plan. The language is about what the user is about to DO ("cook 3 servings"), not about the product's internals. No mention of "scaled," "template," or "cook-time."

- **From the cook view → editing:** The cook view includes a subtle [Edit this recipe] link at the bottom. This opens the library view with edit/delete options — for when the user wants to permanently change an ingredient or fix a step. "Edit this recipe" is self-explanatory; it's the only reason to go from cooking to the library.

**The rule:** the product never uses the words "template," "scaled," "cook-time version," or "library version" in any user-facing text. These are internal concepts. The user just has recipes, and the product shows them the right way at the right moment.

---

## Navigation map

```
Main Menu (reply keyboard - always visible)
│
├─ [My Plan]
│   ├─ No plan → "No plan" + [Plan Week] button
│   ├─ Planning → resumes planning flow
│   └─ Active plan → Next Action screen
│       ├─ [Get shopping list] → Shopping List (scoped)
│       └─ [View full week] → Week Overview
│           ├─ [Day button] → Day Detail
│           │   ├─ [Open recipe] → Cook-Time Recipe
│           │   └─ [Shopping list] → Shopping List (scoped to this cook session)
│           └─ (tap meal → Day Detail for that day)
│
├─ [Shopping List]
│   ├─ No plan → "No plan" message
│   └─ Active plan → Shopping List (full remaining week)
│
├─ [My Recipes]
│   └─ Recipe Library → Recipe View → Edit/Delete
│
└─ [Track]
    ├─ No measurements today → prompt for numbers
    ├─ Already logged → "Already logged today ✓"
    └─ [Weekly report] → weekly summary
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

### 4. Weekly totals over daily totals

Calories and protein shown as weekly numbers. Per-meal calories shown once as a uniform header ("each ~800 cal"), never per-line in the overview. This aligns with "weekly control > daily perfection."

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

### The core problem

At any point in any flow — mid-planning, reviewing a recipe, looking at the plan view — the user might type something instead of tapping a button. What they type falls into three categories:

1. **Flow-relevant input** — the flow expects free-text here (e.g., "I'm eating out Friday dinner" during event collection, or "swap Tuesday lunch for something with lamb" during plan review). This already works — the current flow handlers process it.

2. **Contextual question** — the user is referencing something visible in the conversation and asking about it. "How many calories is that?" "Can I freeze this?" "What's the protein in the salmon pasta?" They expect the product to understand what "that" refers to from the messages above.

3. **Unrelated question** — "What time does Mercadona close?" "How much protein is in 100g of chicken?" "What's a good substitute for tahini?" Not about the current flow, but the user expects an answer because they're talking to an AI.

### Design rules

**Rule 1: Never ignore free-text.** Every typed message gets a response. The worst possible behavior is silence or "I don't understand, please tap a button."

**Rule 2: Context travels with the branch.** When a side conversation starts, it carries the full context: what flow the user is in, what phase, what's on screen, what messages preceded the question. The LLM needs this context to understand references like "that recipe" or "this meal."

**Rule 3: The flow never dies.** A side conversation is a branch, not a replacement. The underlying flow state is preserved. When the side conversation ends (naturally or via the back button), the user returns exactly where they were.

**Rule 4: Persistent [← Back to ...] button.** Every side-conversation response includes an inline button to return to the active flow. The user is never trapped in a conversational dead end without a way back to what they were doing.

**Rule 5: The transition must feel seamless.** Branching into a side conversation and returning should feel like asking a friend a quick question while cooking — natural interruption, natural return. No "entering conversation mode" / "exiting conversation mode" ceremony.

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
  └── unrelated_question → branch into side conversation
        LLM receives: question + minimal context
        Same UX as contextual_question
```

### Implementation phasing

- **v0.0.4:** Free-text that doesn't match the current flow phase gets a graceful fallback: "I'm not sure what you mean. You can {describe what buttons do} or ask me anything." Not great, but not silence.
- **v0.0.5:** Full freeform conversation layer with intent classification, context injection, and seamless branching/return. This is when the product starts feeling truly conversational.

### Why this matters so much

The product is a Telegram bot. Users talk to bots. If the bot can only respond to button taps, it's an app wearing a chat costume — and a bad app at that, because it lacks the visual affordances of a real app. The freeform layer is what makes the chat format an advantage rather than a limitation. It's not a nice-to-have — it's what makes the product feel intelligent rather than scripted.

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
- First treat budget mention: "You have ~850 cal for treats this week. Spend whenever."
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
