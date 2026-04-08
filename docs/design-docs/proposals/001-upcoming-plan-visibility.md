# Upcoming Plan Visibility

> Status: draft
> Date: 2026-04-08
> JTBD: A1 (Know my next action), A2 (Shopping list), A4 (Browse my week)
> PRODUCT_SENSE alignment: The primary emotional arc is anxiety → calm. A confirmed plan that the user can't see creates anxiety, not calm. This directly violates "low friction comes first" and the planning-first principle — the user planned, and the product ignores it.

## Problem

The user creates a meal plan. The product says "Plan locked." And then — nothing. The plan is invisible.

The user can't see what they're eating this week. They can't get a shopping list. They can't browse the week. They can't see the first cook day. The product acts like the plan doesn't exist.

This happens because the plan starts tomorrow, not today. But the user doesn't think in database date ranges. They think: "I just planned. Show me my plan."

This breaks the three highest-priority daily jobs:
- **A1 (Know my next action):** "Do I need to shop? Do I need to cook?" — the product can't answer.
- **A2 (Shopping list):** "I need to buy ingredients for tomorrow's cook." — the product says "No plan yet."
- **A4 (Browse my week):** "I want to see what I'm eating." — the product has no way to show it.

The emotional arc is supposed to be: plan → feel prepared → calm. Instead it's: plan → can't see anything → anxiety and frustration.

This is especially devastating for first-time users. The very first thing they do after onboarding is create a plan. The very first response from the product is to hide it from them.

## Current experience

### Moment 1: After plan confirmation

User finishes the planning flow. The product shows:

```
Plan locked for Wed, Apr 8 – Tue, Apr 14 ✓

Your first cook day is Wednesday, Apr 8:
  🔪 Salmon Pasta — 3 servings
  🔪 Chicken Rice — 2 servings

You'll need to shop for both + breakfast.

  [🛒 Shopping list]  [📖 View recipes]
```

User taps [🛒 Shopping list]:

```
Shopping list generation is coming soon.
```

User feels: "Wait, what? I just confirmed my plan. Where's my shopping list?"

### Moment 2: Coming back to the app

The menu shows:

```
[📋 Plan Week]     [🛒 Shopping List]
[📖 My Recipes]    [📊 Progress]
```

The button says "Plan Week" — as if no plan exists.

User taps [📋 Plan Week]:

```
You already have a plan for Wed, Apr 8 – Tue, Apr 14. Replan it?
  [Replan it]  [Keep current plan]
```

User thinks: "I don't want to replan, I want to SEE my plan!" Taps [Keep current plan]:

```
Plan kept. Tap Plan Week again to plan the week after.
```

User feels: "But I don't want to plan the week after. I want to see THIS week."

### Moment 3: Trying the shopping list

User taps [🛒 Shopping List]:

```
No plan yet — plan your week first to see what you'll need.
```

User feels: "I literally JUST planned. The product told me I have a plan 30 seconds ago. Now it says I don't have one?"

### The emotional summary

The product creates a plan, confirms it, acknowledges it exists when asked to replan, but then denies its existence on every other screen. The user is trapped: they have a plan they can't see, a shopping list they can't access, and a week they can't browse. The only action available is to destroy the plan and start over.

## Proposed experience

### Principle: A confirmed plan is a real plan

The product treats a confirmed plan the same whether it started yesterday or starts tomorrow. The user confirmed it. It's theirs. They can see it, shop for it, browse it, cook from it. The plan's start date is a scheduling detail, not a visibility gate.

### Moment 1: After plan confirmation

Same confirmation message, but the buttons actually work:

```
Plan locked for Wed, Apr 8 – Tue, Apr 14 ✓

Your first cook day is Wednesday, Apr 8:
  🔪 Salmon Pasta — 3 servings
  🔪 Chicken Rice — 2 servings

You'll need to shop for both + breakfast.

  [🛒 Get shopping list]  [📅 View full week]
```

**[🛒 Get shopping list]** opens the shopping list for the first cook day. Works immediately.

**[📅 View full week]** opens the week overview. The user sees their whole week.

User feels: "Great, I can see what's coming. Let me get the shopping list and go buy groceries."

### Moment 2: Coming back to the app

The menu shows:

```
[📋 My Plan]       [🛒 Shopping List]
[📖 My Recipes]    [📊 Progress]
```

The button says **"My Plan"** — because they have one.

### Moment 3: Tapping "My Plan" (Next Action screen)

The Next Action screen shows the standard 3-day window: today + next 2 days. Today has no plan meals (the plan starts tomorrow), so the screen provides context instead of bare dashes:

```
Today, Tuesday Apr 7
No meals — your plan starts tomorrow

Tomorrow, Wednesday Apr 8
🔪 Cook lunch: Salmon Pasta — 3 servings
🔪 Cook dinner: Chicken Rice — 2 servings

Thursday Apr 9
Salmon Pasta (reheat)
Chicken Rice (reheat)

  [🔪 Salmon Pasta — 3 servings]
  [🔪 Chicken Rice — 2 servings]
  [🛒 Get shopping list]  [📅 View full week]
```

User thinks: "OK, today I'm free. Tomorrow I cook. I need to shop today. Let me get the list."

The emotional arc works: uncertainty ("what's happening with food?") → clarity ("tomorrow I cook, today I shop") → calm ("I'm prepared").

### Moment 4: Tapping "Shopping List"

Works exactly as designed for active plans. Shows ingredients for the next cook day + breakfast, grouped by category, copy-pasteable.

```
What you'll need — Wed Apr 8
For: Salmon Pasta (3 servings) + Chicken Rice (2 servings) + Breakfast

PRODUCE
- Cherry tomatoes — 450g
- Fresh basil — 1 bunch
...

FISH
- Salmon fillet — 600g
...

Check you have:
Ground cumin, chili flakes, smoked paprika

Long-press to copy. Paste into Notes,
then remove what you already have.

  [← Back to plan]
```

The user copies the list to Apple Notes, goes shopping. The product did its job.

### Moment 5: Browsing the week

User taps [📅 View full week] from the Next Action screen:

```
Your week: Wed Apr 8 – Tue Apr 14

Breakfast: Oats & Eggs (daily)

Wed 🔪
L: Salmon Pasta · D: Chicken Rice

Thu
L: Salmon Pasta · D: Chicken Rice

Fri 🔪
L: Greek Lemon Chicken · D: Chicken Rice

Sat
L: Greek Lemon Chicken · D: Flex

Sun 🔪
L: Spiced Lamb Bowl · D: Greek Lemon Chicken

Mon
L: Spiced Lamb Bowl · D: Greek Lemon Chicken

Tue
L: Spiced Lamb Bowl · 🍽️ D: Dinner out

Weekly target: on track ✓

  [Wed] [Thu] [Fri] [Sat]
  [Sun] [Mon] [Tue]
  [← Back]
```

User feels: "This looks great. I'm excited about next week." (JTBD A4: curiosity and anticipation)

### Moment 6: The plan starts (next day)

When tomorrow arrives and the plan's first day begins, the experience transitions seamlessly. The Next Action screen now shows today's meals:

```
Today, Wednesday Apr 8
🔪 Cook lunch: Salmon Pasta — 3 servings
🔪 Cook dinner: Chicken Rice — 2 servings

Tomorrow, Thursday Apr 9
Salmon Pasta (reheat)
Chicken Rice (reheat)

Friday Apr 10
🔪 Cook lunch: Greek Lemon Chicken — 3 servings
...
```

No jarring change. The same screen, the same format. Today just went from "no meals" to "cook day." The user doesn't notice a state transition — they just see their plan advancing.

## Design decisions

### Use the same screens, not a special "upcoming" view

The Next Action screen, Week Overview, Shopping List, and Cook View all work for upcoming plans without modification to their visual design. The data is the same shape — batches, meals, recipes, dates. The only difference is that "today" might have no meals.

Creating a separate "upcoming plan" screen would add cognitive overhead (a new mental model for the user) and development overhead (a new screen to maintain). The existing screens already handle empty meal slots gracefully.

### "No meals — your plan starts tomorrow" instead of bare dashes

When today is before the plan, showing two dashes ("—" / "—") for lunch and dinner looks broken. The user would think something is wrong. A single contextual line explains why today is empty and when things start. It's informational, not alarming.

### Shopping list works before the plan starts

The user shops BEFORE they cook. They cook on day 1 of the plan. Therefore they shop on day 0 — before the plan starts. Blocking the shopping list until the plan is "running" is backwards. It means the user has to wing their first grocery run or manually extract ingredients from recipes.

The shopping list generator already works by finding the "next cook day" — it doesn't care whether that day is today or tomorrow. The only barrier is visibility.

### The menu button says "My Plan" whenever a confirmed plan exists

The button label reflects the user's reality: "I have a plan." Whether that plan starts today or tomorrow is irrelevant to the button. The user created it, it's confirmed, it's theirs.

"Plan Week" means "you should create a plan." "My Plan" means "you have a plan, here it is." A confirmed plan should always show "My Plan."

## Edge cases

### Plan starts more than 2 days from now

When does this happen? Only when the user has a running plan with 3+ days left and creates next week's plan early. In that case, "My Plan" shows the running plan (the one they're living). The future plan is not the primary view.

For the upcoming-only scenario (no running plan), the plan always starts tomorrow — `computeNextHorizonStart` uses "tomorrow" as the default. So the 3-day window (today + 2 days) always includes the plan's first day.

### Active plan exists AND a future plan exists

"My Plan" shows the active/running plan — the user is living it, it's the priority. The future plan is visible during the planning confirmation moment but not yet in the main navigation.

Future enhancement (out of scope for this proposal): During `active_ending` (1-2 days left on current plan), if a future plan exists, show a "Next week's plan is ready — peek?" link in the Next Action screen.

### User manually types "Plan Week" when they have an upcoming plan

Existing behavior is correct: "You already have a plan for [dates]. Replan it?" with [Replan it] / [Keep current plan]. After "Keep current plan," the message says "Plan kept." and the menu shows "My Plan."

### Post-confirmation buttons

The buttons shown right after "Plan locked ✓" must connect to the real screens. [🛒 Get shopping list] should open the actual shopping list (not "coming soon"). [📅 View full week] should open the week overview. These are the natural next actions after confirming a plan.

## Out of scope

- **Mid-week replanning** (C2: Handle unplanned restaurant): requires running budget, deferred to v0.0.5.
- **Proactive notifications** (B2: Get nudged to plan): requires scheduled messages, deferred to v0.0.6.
- **Peeking at next week's plan from an active plan**: nice-to-have, separate proposal.
- **The transition from upcoming to active**: happens automatically when the date changes. No special handling needed — the same screens, the same data, just "today" has meals now.
