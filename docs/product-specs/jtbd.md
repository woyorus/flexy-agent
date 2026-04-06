# Jobs To Be Done

> Scope: The real-life moments where the user reaches for the product, what they're trying to accomplish, and what "done" feels like. This is the demand-side lens — it describes the user's world, not the product's features. Every screen, button, and message should trace back to a job listed here. See also: [PRODUCT_SENSE.md](../PRODUCT_SENSE.md) for the "why" behind the product, [flows.md](./flows.md) for how jobs map to conversation flows.

Source: User interview, 2026-04-06.

## How to read this document

Each job follows the format:

- **When** — the real-life trigger (situation + context)
- **I want to** — the action the user seeks
- **So I can** — the outcome / emotional resolution
- **"Done" looks like** — the concrete end state
- **Priority** — how frequently this occurs and how much pain it causes if unserved

Jobs are grouped by the product state the user is in. Within each group, jobs are ranked by importance (frequency x pain).

---

## Group A: I have an active plan and I'm living my week

These are the daily, high-frequency jobs. The plan exists — the user is executing it.

### A1. Know my next action

**When** I wake up, or it's midday, or I just finished a meal — any moment food logistics cross my mind.

**I want to** see what's immediately ahead: do I have food ready, do I need to shop, do I need to cook?

**So I can** feel calm and in control instead of anxious about logistics.

**"Done" looks like:** "Today: food in fridge, just reheat. Tomorrow: shop + cook lunch. I'm covered."

**Priority:** Highest. This is the #1 anxiety-reducer. Happens multiple times per day, every day of the plan. The emotional arc is anxiety → calm. The product's most important job is turning "do I have food?" uncertainty into "you're covered, here's what's next."

**Design implications:**
- Horizon is 2-3 days ahead, not the full week. Saturday doesn't matter on Wednesday.
- The answer is action-oriented: cook / shop / reheat / flex meal — not a data dashboard.
- Reheat days need near-zero interaction ("food in fridge, eat it").
- Cook days need a clear "what to cook" + "do I have ingredients?" signal.

---

### A2. Build a shopping list for my next cook session

**When** I have an upcoming cook day and I don't have the ingredients.

**I want to** see everything my recipes need — for the meal(s) I'm about to cook AND for breakfast — grouped by category. Then I cross-reference against what's already in my kitchen, remove what I have, maybe add non-food items, and copy the result to Apple Notes as my actual shopping list.

**So I can** do one efficient grocery run and not forget anything.

**"Done" looks like:** A checklist in Apple Notes, grouped by produce / protein / dairy / pantry (maps to store sections and potentially different shops — butcher, fish shop before 2pm, supermarket for the rest). Includes breakfast items. Manually edited to remove things I already have and add non-food items (dishwashing liquid, etc.).

**Priority:** Very high. Happens 2-4 times per week. Directly gates the ability to cook. Anxiety-adjacent: if the list is wrong or incomplete, the cook session fails.

**Design implications:**
- What the product generates is a **needs list**, not a shopping list. It shows everything the recipes call for. The user turns it into a shopping list by checking against their kitchen and copying what they actually need to buy. This is a manual reconciliation step — the product doesn't know what's in the user's kitchen, and asking would add friction.
- Grouping by category is essential (not a flat list). User shops at multiple stores.
- Must be copy-pasteable to Apple Notes (plain text with structure, not Telegram-only formatting).
- Must aggregate across all meals being shopped for in one trip (lunch + dinner + breakfast).
- Future (v0.0.5+): voice-based kitchen scan ("I have peppers, I have beef, I don't have chicken") could automate the reconciliation step. But for MVP, manual is fine.

---

### A3. Cook from the plan

**When** I'm in the kitchen, ingredients on the counter, ready to cook a batch.

**I want to** see the recipe with total batch amounts, step-by-step instructions with inline ingredient quantities and cooking times, and how many servings to portion into.

**So I can** cook without scrolling between ingredients and steps, and portion correctly.

**"Done" looks like:** A single-screen recipe view where each step includes the ingredient amounts and duration right in the instruction text. "Dice 200g onion. Sear in 15ml olive oil over high heat, 3-4 min." Total batch amounts, not per-serving. Clear servings count at the top ("3 servings — divide into equal portions").

**Priority:** Very high. Happens every cook session (2-4 times/week). The recipe is always needed — even for familiar recipes (20-25 in rotation, not memorized). Current pain: ingredients and steps are separate, requiring constant scrolling. Vague timing ("until golden") causes uncertainty.

**Design implications:**
- Recipe display for cooking is fundamentally different from recipe display for browsing. Cook-time view must inline amounts into steps and show batch totals.
- Every heat step needs an explicit duration in the recipe generation prompt.
- Per-serving calories are informational context (shown once as a header), not the focus. Weekly targets are what matter.
- The user doesn't weigh individual portions — they eyeball equal splits. Servings count is the key number.

---

### A4. Browse my week (curiosity)

**When** I've just confirmed a plan, or it's a quiet moment mid-week.

**I want to** see what I'm eating this week — the full picture, all meals.

**So I can** feel excited about upcoming meals, or notice something I want to swap ("hmm, I don't want chicken this week, I want lamb").

**"Done" looks like:** A compact week overview — each day with its lunch and dinner, cook days marked, flex meal and events visible. Enough to get the vibe, not a wall of text.

**Priority:** Moderate. Happens 1-2 times per week, usually right after planning. The emotion is curiosity and anticipation, not anxiety. Lower stakes than A1-A3, but contributes to engagement and plan buy-in. Also the entry point for swaps ("I don't want that recipe").

**Design implications:**
- Week-at-a-glance, not day-by-day navigation. The user wants the whole shape.
- Light on detail — recipe names, meal types, cook vs. reheat indicators. Not calories per meal.
- Should enable action: tapping a meal to see its recipe or to trigger a swap.
- Breakfast is a constant — show it once at the top, not repeated 7 times.

---

### A5. Know my flex meal budget

**When** a flex meal day is approaching (or I'm deciding where to go).

**I want to** know how many calories I have for this meal and get a sense of what fits.

**So I can** pick something fun that doesn't blow my budget — enjoy it without guilt or guesswork.

**"Done" looks like:** "Flex meal: ~1,200 cal. A Big Mac meal is ~1,100. A large Domino's pizza is ~2,000 (too much). Two slices + a side would work."

**Priority:** Moderate. Happens once per week (one flex slot). The emotion is fun anticipation, not anxiety. But without guidance, the user might accidentally overshoot by 2x, which undermines trust in the system.

**Design implications:**
- This is advisory, not restrictive. The product helps the user make an informed choice.
- Future: discussion-style ("I want Italian" → "here are options that fit your budget").
- For MVP: showing the calorie budget for the flex meal + the note is sufficient.

---

### A6. Track a treat

**When** I just ate something outside the plan — a Snickers, an ice cream, a cookie at work.

**I want to** log it quickly ("small Snickers") and see how much treat budget I have left.

**So I can** make informed choices about whether I can have another treat this week without stressing.

**"Done" looks like:** "Logged: small Snickers (~245 cal). Treat budget remaining: ~608 cal this week (~1-2 more treats)."

**Priority:** Moderate. Happens 2-3 times per week. Low friction is critical — if logging a treat takes more than one message, the user won't do it. The emotion is "I want to stay aware without obsessing."

**Design implications:**
- One message in, one message out. No barcode scanners, no food database lookups, no follow-up questions.
- The LLM estimates calories from the description. Good enough beats precise.
- Show remaining budget in terms of "how many more treats" — not just raw calories.
- This is a v0.0.5 feature (requires running budget / tracking). Captured here for design continuity.

---

## Group B: I need a plan

The user either has no plan or the current plan is ending. The product's job shifts from execution support to plan generation.

### B1. Plan my week

**When** the current plan is ending (1-2 days left), or has already ended, or I've never planned before.

**I want to** generate a new weekly plan that accounts for my known events, flex meals, and preferences.

**So I can** start the new week feeling prepared — knowing what I'll eat, when I'll cook, and what I need to buy.

**"Done" looks like:** Plan confirmed. I see my next action (first cook session + what to shop for). I feel set.

**Priority:** High. Happens once per week. It's the foundational ritual — without a plan, no other job works. But it's not urgent every day; it's urgent once per week at a specific transition point.

**Design implications:**
- Ideally done 1 day before the new week starts, so breakfast ingredients can be shopped in advance.
- Post-confirmation, the product should immediately surface the next action (A1), not just "Plan locked."
- The planning session itself should be fast and suggestive-first (system proposes, user approves/tweaks). This already exists.

---

### B2. Get nudged to plan

**When** the current plan is ending in 1-2 days and I haven't started planning yet.

**I want to** receive a single, non-nagging reminder that it's time to plan.

**So I can** plan ahead and not end up on Monday morning with no plan and no breakfast ingredients.

**"Done" looks like:** One notification: "Your plan ends in 2 days — want to plan next week?" with a button to start. No follow-ups if ignored.

**Priority:** Moderate. Happens once per week. Prevents the worst-case scenario (Monday morning with nothing). But must not become annoying — one reminder, one button, that's it. Vacation mode = just don't respond.

**Design implications:**
- Single proactive message, not a nag sequence.
- If the user ignores it, that's fine. No guilt, no streak-breaking.
- v0.0.6 feature (requires scheduled messages). Captured here for completeness.

---

## Group C: Real life breaks the plan

The plan is active but something unexpected happened. The product's job is to absorb the disruption.

### C1. Handle missing ingredients at cook time

**When** I'm about to cook (or shopping) and discover I can't get a planned ingredient — "I don't have salmon."

**I want to** tell the product and get an immediate substitution or recipe swap.

**So I can** keep cooking without abandoning the plan or improvising blindly.

**"Done" looks like:** "No salmon? Use 200g tuna instead — same prep, similar macros." Or: "Here's an alternative recipe that uses what you have."

**Priority:** High when it happens (maybe once every 1-2 weeks). The moment is stressful — you're standing in the kitchen or at the store and the plan just broke. Fast resolution matters.

**Design implications:**
- Conversational: user says what happened, product responds with options.
- Substitution-first (minimal disruption), full recipe swap as fallback.
- Must re-run scaling if ingredients change. Updated shopping list if pre-shop.
- v0.0.5 feature (part of the freeform conversation layer).

---

### C2. Handle an unplanned restaurant or social meal

**When** I get an unexpected dinner invitation, or plans change and I'm eating out.

**I want to** tell the product and have it adjust the plan — absorb the calorie impact across remaining days.

**So I can** say yes to life without feeling like I ruined my week.

**"Done" looks like:** "Added: dinner out Thursday (~900 cal). Your remaining meals adjusted to ~760 cal/serving. Weekly target still on track."

**Priority:** Moderate (happens 0-2 times per week). Emotionally important — this is the moment the product either proves its "flexibility" promise or feels like a rigid diet app.

**Design implications:**
- Adding a mid-week event should be as easy as the initial event collection in planning.
- The system re-solves and adjusts remaining portions. No drama, no guilt messaging.
- v0.0.5 feature (requires mid-week replanning + running budget).

---

### C3. Prepare for a restaurant meal

**When** I know I'm eating at a restaurant (planned or just decided).

**I want to** get guidance on what to order to stay within my calorie budget for that meal.

**So I can** enjoy the restaurant without anxiety and without accidentally ordering a 2,500-cal dish when my budget is 1,200.

**"Done" looks like:** Ideally: product pulls the restaurant menu (from Google Maps or a photo I take), estimates calories for options, and recommends dishes that fit my budget. Minimum: cuisine-based guidance ("At an Italian restaurant with 1,200 cal budget: grilled fish + vegetables or a single-portion pasta. Avoid cream sauces and shared antipasti plates.").

**Priority:** High emotional importance (restaurants are the #1 plan-breaking moment), but moderate frequency (1-2 times per week at most). Planning-first is critical: guidance BEFORE ordering beats tracking AFTER eating. Snapping a photo of food already on my plate is a worse option — by then it's too late.

**Design implications:**
- Planning-first, not logging-after. The product should help choose, not just record.
- Menu scanning (photo or pulled from Google Maps) is the ideal UX.
- Cuisine-based heuristics as a fallback when no menu is available.
- v0.0.5+ feature. Captured here because it shapes how restaurant events are modeled.

---

## Group D: Reflection and course correction

The user wants to understand how they're doing — either because something went off-plan or out of general awareness.

### D1. Check my budget after a deviation

**When** I ate something unplanned, or had a big restaurant meal, or snacked heavily.

**I want to** see where I stand against my weekly calorie and protein targets.

**So I can** decide whether I need to adjust remaining meals or if the buffer absorbed it.

**"Done" looks like:** "You've used 12,400 of 17,052 weekly cal (73%). 4 days left, ~1,160 cal/day remaining. You're fine — no adjustment needed." Or: "You're 800 cal over pace. Want to trim remaining dinners by ~200 cal each?"

**Priority:** Low-to-moderate. Only interesting when off-plan. If the user follows the plan faithfully, this view is static and boring. But when it matters, it really matters — it's the difference between "I screwed up, the week is ruined" and "you're fine, keep going."

**Design implications:**
- Only valuable with tracking data (v0.0.5+). Without tracking, budget view is just the planned numbers.
- The tone must be non-judgmental. Adjustment, not punishment. Aligned with PRODUCT_SENSE.
- Show in terms of "what it means for the rest of my week" — not just numbers.

### D2. See that what I'm doing is working

**When** it's morning, I've had my coffee, used the bathroom — or it's the end of the week and I want to check progress.

**I want to** log my weight and waist measurement (two numbers, fast), and periodically see that the trend is going in the right direction.

**So I can** feel validated that the effort is paying off and stay motivated to continue.

**"Done" looks like:**
- **Daily input:** Drop two numbers in the chat. "82.3 / 91" (kg / cm). Under 5 seconds. No forms, no buttons.
- **Weekly report:** "This week's average: 82.1 kg (↓0.4 from last week), waist 90.5 cm (↓0.3). You're on track." Shown once per week, not daily comparisons.
- **Bad day contextualization:** If today's weight is up 0.8kg from yesterday, the product does NOT show that comparison. It shows only the weekly average, and if asked, contextualizes: "Day-to-day fluctuations (water, food volume, glycogen) are normal. Your weekly trend is what matters, and it's still down."

**Priority:** High. This is the "is the product working?" signal. Without it, the user is meal-prepping on faith. The measurement habit needs to be built (not yet established), so the product should make it frictionless. Waist is especially valuable — less volatile than weight, better proxy for fat loss and visual change.

**Design implications:**
- Input: one message, two numbers. No follow-up questions. The product confirms and stores.
- Output: weekly averages only. Never show daily weight-to-weight comparison — it causes psychological noise.
- Rolling averages are questionable — they create "is it fast enough?" anxiety. Prefer strict weekly averages in a weekly report format.
- Skipped days are fine — average whatever measurements exist that week.
- **First month strategy:** Early weight loss is mostly water/glycogen, not fat. The product leans into this ("great progress!") for engagement and product trust. When the inevitable slowdown hits after 2-3 weeks, the product contextualizes: "This is normal and actually good — you're now losing fat, not just water. Fat loss is slower but permanent."
- Waist circumference is the stronger signal for visual change and actual fat loss. The product should treat it as equally important to weight, not secondary.
- This is a habit the product helps build — the daily prompt should be simple and non-punishing if skipped.

---

## Cross-cutting insights

These patterns emerged across multiple jobs and should guide all design decisions:

### The primary emotional arc is anxiety → calm

The product's most important function is not information display — it's anxiety resolution. "Am I covered? What do I need to do? When?" The answer should be immediate, action-oriented, and reassuring.

### The relevant horizon is 2-3 days, not 7

Users don't think in full weeks during execution. They think about today, tomorrow, and maybe the day after. The full week overview is curiosity, not operations. Design for the near horizon first.

### The plan is a living document, not a contract

Mid-week changes are normal, not failures. Missing ingredients, unexpected restaurants, cravings — the plan must absorb these without drama. "Flexible" is in the product name.

### Per-meal calories are informational; weekly targets are what matter

The user cares that the week is on track. Individual meal calories are background context, not primary information. Don't lead with per-meal numbers.

### Breakfast is invisible by design

Fixed recipe, memorized, cooked on autopilot. The product should stay out of the way. Future: rotate 2-3 learned recipes across weeks, but always "one per week, no thinking required."

### Reheat days are zero-interaction

Food is in the fridge. The product has nothing to add. These are the easy days.

### Shopping is the real artifact, not the plan

The shopping list is what the user actually takes into the world. It must be portable (copyable to Apple Notes), grouped by category (maps to store sections and different shops), and aggregated across all meals including breakfast.

### Cook-time recipe display is different from browse-time

Cooking needs: total batch amounts, inline ingredient quantities in steps, explicit timing on every heat step, servings count. Browsing needs: recipe name, cuisine, tags, per-serving macros. These are different views of the same data.

### One notification, not a nag sequence

The product earns trust by being helpful exactly once at the right moment. "Your plan ends in 2 days — want to plan?" No follow-ups. Vacation mode = silence.
