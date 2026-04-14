# Honest Past Logging — Shift Forward, Preserve Reality

> Status: accepted
> Date: 2026-04-13
> JTBD: C2 "Handle an unplanned restaurant or social meal" (retroactive variant), C1 "Handle missing ingredients at cook time", D1 "Check my budget after a deviation".
> PRODUCT_SENSE alignment: "Planning-first, not tracking-first." "The right response is adjustment, not punishment." "The system should bend without breaking." The product accepts honest reports of what actually happened and reshapes the plan around them — without interrogating the user, shrinking meal preps, or wasting food.

## Problem

The user tells the product what actually happened — *"last night I went to an Indian restaurant"*, *"I skipped lunch today"*, *"the cook day got pushed — I made Tuesday's tagine on Wednesday"*. The product's job is to absorb that report, update the plan, and keep the week moving without drama.

Today, the product cannot do this. When the user reports a past deviation, one of three things happens:

1. **The report is silently dropped.** The product acknowledges "plan updated" but the Indian restaurant never enters the record — the re-proposer hit an illegal-displacement error, retried, and landed on something unrelated.
2. **The re-proposer fails several validation checks** (coverage, displacement, out-of-horizon), retries, and presents a weekend lunch swap with no mention of the restaurant.
3. **The product invents a meaningless plan change** to satisfy an internal consistency rule the user never asked about.

None of these are acceptable for a product whose identity is flexibility-first and anti-punishment. A user who honestly reports a deviation and sees their input vanish will stop reporting. The product degrades into a one-way channel that only accepts plans, not reality.

This proposal introduces the **shift-forward mechanic**: when the user reports that a past slot did not go to plan, the product pushes the affected meal prep forward in time, cascades downstream batches as needed, and (in v0.0.5+) absorbs the deviation into the week's flex or treat budget — without ever modifying the batch's content or servings and without asking the user to confirm anything.

## Current experience

**The scene.** It is Tuesday morning. Yesterday (Monday) was the cook day and first eating day for a Mon–Wed tagine batch. A friend invited the user out last night; they went to an Indian restaurant instead of cooking. The tagine ingredients are still in the fridge, raw and uncooked. The user opens the bot to tell it so — honestly, without self-judgement.

**The user types:** "last night I went to an Indian restaurant"

**What the user expects.**

- Acknowledgement of what happened
- A plan that absorbs it without drama — the uncooked tagine is cooked today instead of yesterday, the week's rhythm shifts forward by one day, groceries aren't wasted
- Whatever happens to the downstream meals is the product's problem to sort, not the user's

**What actually happens today.** The re-proposer runs against the retroactive input, hits a validation failure because it cannot legally modify a past slot, retries, and silently drops the Indian event from the proposal. The resulting diff might say:

> Added Chicken, Black Bean Bowl on Sat–Sun (2 servings)
>
> Tap Confirm to lock this in, or Adjust to change something.

The user sees a change to Saturday and Sunday lunches with no explanation and no mention of Monday's restaurant. If they tap Confirm, the plan updates; the Indian restaurant never enters the record. The emotional arc:

- "I told the bot what happened."
- "It's showing me something about next weekend's lunch. Why?"
- "Did it understand? Did it log the restaurant? I can't tell."
- "I'll stop reporting these. I'll just eat what I eat and hope for the best."

This is the exact failure mode `PRODUCT_SENSE.md` frames as the enemy: a system that works under ideal conditions but collapses the moment real life enters the picture.

## Core invariants

The product must obey these five rules whenever a retroactive deviation is reported. They hold regardless of v0.0.4 vs v0.0.5+ scope.

### 1. Current-horizon food is sacred

Within the current horizon, the product never changes:

- What's in a batch (recipe, ingredients)
- How many servings a batch yields
- The identity of a batch

The user may have already shopped for the entire horizon. Modifying a batch's content means pretending groceries the user actually bought don't exist — which is the exact "plan that works only in ideal conditions" failure the product exists to prevent.

### 2. Time is the only mutable dimension

Within the horizon, the only legal mutation is **when** a batch is cooked and eaten. Shifting forward in time is allowed. Shrinking servings, swapping ingredients, or dropping a batch is not.

### 3. Shift-forward cascades; the horizon is permeable forward

If a deviation displaces a cook/eat day, the affected lane slides forward by one day. Downstream batches cascade to accommodate. If the cascade pushes meal preps past day 7, those days become **pre-committed cook days in the next horizon's plan**. The next horizon starts with them locked and plans around them.

There is no "cascade blocked because next horizon is full" — the next horizon is not yet planned when the cascade runs. Degenerate case: seven consecutive deviations in one week produce seven pre-committed cook days next horizon. Normal operation.

### 4. Flex slots are absorbed by the cascade

If a flex slot exists in the current horizon and the cascade reaches it, the flex slot is **absorbed** — the shifted meal prep takes its place. The flex does not spill into next horizon. Semantically, the eat-out event has become this week's flex.

If no flex slot is inside the cascade path, the cascade spills into next horizon per rule 3.

### 5. Default: assume the batch was not cooked

When the user reports eating out on a day that was a cook day, assume the batch was not cooked. Shift the cook day forward to today and shift eating days accordingly. The product never asks "did you cook?".

Cook day is a UI affordance (the scaled-recipe button in plan view, shopping list, and recipe library) — not a tracked state. The button shows on the cook day **and for one day after**, as a safety margin for real-life slippage. If the user did cook yesterday, the only side effect of this default is an extra recipe button today — harmless. Never showing a button when the user needs it would be worse.

## The shift mechanic (v0.0.4 scope)

The v0.0.4 scope of this proposal is the shift mechanic itself — acceptance, classification, computation, and transparent communication. No calorie estimation, no budget absorption, no "on pace" framing. That's v0.0.5+.

1. **Dispatcher routing.** The freeform conversation layer (design doc 003) classifies the message as a retroactive meal-replacement event. Small-magnitude reports ("I had ice cream") route to the treat-log flow instead.
2. **Slot identification.** The dispatcher identifies the affected (day, mealTime) slot from the user's text: "last night" → yesterday, dinner inferred if unspecified, cuisine/calories recorded for v0.0.5+ estimation.
3. **Shift computation.** The re-proposer pushes the displaced cook/eat days forward by one day, cascades downstream batches, and absorbs the first flex slot it encounters. Meals that don't fit in the horizon become pre-committed cook days for next horizon.
4. **Transparent communication.** The product replies with an explicit description of every slot that changed and why — flex absorbed, cascade spilling into next horizon, etc. No silent shifts.
5. **Natural-language override.** If the user disagrees with the shift ("cancel the tagine, I'll eat at restaurants this week"), they say so. The follow-up routes through the normal plan-mutation flow. There is no "skip shift" button — grocery loss is strictly worse than a one-day shift, so the default has no opt-out affordance.

### Screen 1 — Standard shift (dinner out, cook day displaced)

**User types:** "last night I went to an Indian restaurant"

**Product replies:**

> Got it — logged Mon dinner as Indian restaurant.
>
> Shifted the week:
> • Tagine: cook today (Tue), eat Tue–Thu
> • Pork: cook Fri, eat Fri–Sun
> • Flex slot absorbed — Sunday becomes pork instead of flex.

No buttons. The plan is already updated. The standard keyboard (edit plan, shopping list) appears because the plan changed, but the message itself doesn't ask for confirmation. If the user wants to change further, they speak.

### Screen 2 — Cascade spills into next horizon

**User types:** "I ate out last night" (today is Friday; Thursday was salmon's cook day)

**Product replies:**

> Got it — logged Thu dinner as a restaurant.
>
> Shifted the week:
> • Salmon: cook today (Fri), eat Fri–Sun
> • Pasta cook day moves into next week — I'll start next horizon with it pre-committed for Mon.

### Screen 3 — Multiple deviations at once

**User types:** "I ate out Mon and Tue" (today is Wednesday)

**Product replies:**

> Got it — logged Mon and Tue dinner as restaurants.
>
> Shifted the week:
> • Tagine: cook today (Wed), eat Wed–Fri
> • Pork: cook Sat, eat Sat–Sun (one serving carries into next Mon)
> • Flex slot absorbed — Sunday is pork instead of flex.

### Screen 4 — Ambiguous report

**User types:** "I ate out yesterday"

**Product replies:**

> Yesterday was Monday. Lunch, dinner, or both? And a rough sense of what — cuisine or calories — helps me estimate.

If the user's reply is still ambiguous, the product takes its best guess and shows what it assumed ("logged as Mon dinner, Italian, ~1,200 cal — tap *Not quite* if that's off") rather than asking a second question. One clarification round max.

### Screen 5 — Routing to treat-log

Small-magnitude reports route to the treat-log flow (JTBD A6), not here. The dispatcher distinguishes on magnitude + language:

- "I had [small item]" with estimated calories under ~400 → treat log
- "I ate out / went to [restaurant] / had [big meal]" or estimated ≥400 cal → retroactive event (this proposal)

The user does not need to know which flow they hit; the acknowledgment is equivalent.

## Budget absorption (v0.0.5+ future work)

This section sketches the v0.0.5+ extension. It is **not** v0.0.4 scope. It depends on calorie estimation, which is separate machinery.

### Input: rough calorie estimate

v0.0.5+ estimates calories (primary) and protein (secondary) for the reported event from:

- Voice note describing the food (*"masala, rice, butter chicken"*)
- Photo of the meal
- User's own estimate (*"about 900 cal"*)

Accuracy target: ±30%. Anything is better than nothing. Accurate estimation (restaurant database lookup, menu OCR, curated nutritional databases) is a dedicated future workstream — not part of this proposal.

### Absorption priority

When calorie data is available, the event is absorbed in this order:

1. **Flex slot remaining in horizon** → the event *is* the flex. The cascade already absorbs the flex slot (invariant 4); the flex budget calories are spent on the reported event. There is no surplus framing. The planned flex later in the week is gone.

2. **Flex slot already used this horizon** → the treat budget absorbs the event, heavily. Treat budget is ~850 cal and exists precisely to soak a real meal moment. Message to the user: "you've eaten through this week's treat budget — no more treats until next week."

3. **Flex and treat budgets both exhausted** → the product does **not** shrink meal preps to compensate (that starves the user and violates the sustainability principle). Instead, the product frames the week honestly: "you're over pace this week — the week continues, next week restarts fresh."

Meal prep servings are never reduced. Ever.

### Weekly framing

With calorie data, the acknowledgment gains a second paragraph:

> Got it — logged Mon dinner as Indian restaurant (~900 cal).
>
> Shifted the week: [same as v0.0.4]
>
> Absorbed into this week's flex — you hadn't used it yet. Still on pace: 8,400 / 17,052 cal used.

Over-treat-budget case:

> Got it — logged Mon dinner as pizza (~1,800 cal).
>
> Shifted the week: [same as v0.0.4]
>
> Absorbed into this week's treat budget. That's the treat budget spent — best to skip extras through Sunday.

Over-everything case:

> Got it — logged Sat dinner as a restaurant (~2,100 cal).
>
> Shifted the week: [same as v0.0.4]
>
> That puts you ~400 cal over this week. Meal preps stay as planned — the week's over, next week restarts fresh. The weekly direction is what matters.

## Design decisions

### 1. Planning product, not tracking product

The product never asks the user to confirm what they did. The plan is designed to survive real life without check-ins. Cook days, meal prep consumption, scheduled events — the product treats its own schedule as the source of truth for UI and planning, not as a set of checkboxes to verify. It never asks "did you cook the tagine?" or "did you eat lunch today?"

The only exception is **calorie-affecting events that aren't already in the plan** — restaurants, treats, unplanned meals. The weekly budget cannot be computed without that input. Here, and only here, the user must tell the product what happened.

This principle is elevated into `PRODUCT_SENSE.md` as a refinement of the existing "planning-first" principle.

### 2. Retroactive events shift time, not content

Modifying a batch's recipe, ingredients, or servings inside the horizon breaks the user's physical grocery state. Shifting the batch forward preserves that state at the cost of a one-day rhythm change — which the user has already accepted by reporting the deviation. No-op on content, adjustment on timing. Always.

### 3. Cook day is a UI affordance, not a tracked state

The data "Monday was the cook day" exists to drive a single behavior: show the scaled-recipe button in plan view, shopping list, and recipe library for that meal. It is not a source of truth for "was it cooked?". The button shows on the cook day **and for one day after** — absorbs real-life slippage (user cooked later, user came back to the button after the fact). We never ask the user to tap "I cooked this."

This generalizes: the schedule drives affordances; tracking verifies nothing.

### 4. Shift is automatic; override is conversational

The product applies the shift and tells the user what changed. No confirmation button. No "skip shift" opt-out. If the user wants different behavior — "cancel the tagine, I'll eat at restaurants all week" — they say so in natural language, and the request routes through the normal plan-mutation flow (design doc 003's freeform conversation layer, re-proposer).

Tossing food is never the default. Grocery loss is strictly worse than a one-day shift, so there is no affordance that suggests otherwise.

### 5. Cascade always fits

The next horizon is planned *after* the current horizon closes. When the cascade spills meal preps past day 7, they become pre-committed cook days for the next horizon's planner. There is no "cascade blocked by capacity" — capacity is flexible because planning hasn't happened yet.

Degenerate case: seven consecutive deviations in one week produce seven pre-committed cook days next horizon. The planner accepts them and adds no new meals.

### 6. Flex absorbs, doesn't spill

When a flex slot is inside the cascade path, the shifted meal prep takes its place. The flex slot does not push into next horizon. Semantically, the reported eat-out event becomes this week's flex — the system's calendar and the user's actual eating align, which is the whole point.

### 7. Meal preps are never shrunk to compensate

Reducing a batch from 3 servings to 2 because the user had a big meal yesterday is a form of punishment-by-arithmetic. It leaves the user under-fed for two days, violates the grocery invariant, and worsens adherence. The answer to over-consumption is **weekly framing** — "the week's over, next week restarts fresh" — not "cook less."

### 8. Treat-log vs. retroactive-event routing

The dispatcher (design doc 003) decides on language + magnitude. Small items at low calorie estimates route to treat-log. Meals at higher calorie estimates route to this flow. The user doesn't know which flow they hit; the acknowledgment is equivalent.

## Edge cases

**The user reports a deviation on a day that is still active.** *"I'm grabbing lunch out today"* at 13:00 local, before lunch's cutoff. That's a forward mutation, not a retroactive event. The existing re-proposer path handles it with design doc 002's near-future soft-lock rules. This proposal does not change that flow.

**The user reports deviations from multiple days.** *"I went out for dinner Sunday and Monday"* on Tuesday. Each deviation independently triggers its shift logic; the cascades compose (Screen 3).

**The user reports a deviation on a flex day.** *"I used my flex Friday — I had Thai"* when Friday was already a flex slot. This is logging what the flex was, not a surprise event. Mark the flex as used with the actual meal + calories. No cascade, no shift. The treat-log flow handles the calorie recording (v0.0.5+).

**The user reports eating *less* than planned.** *"I had a small salad last night, maybe 400 cal, instead of the tagine"*. Under-eating is a deviation too. The tagine batch stays uncooked per invariant 5's default; the cascade proceeds as normal. Budget-wise, the user ate under their planned total — no absorption needed.

**The user reports a deviation on an eating-only day (batch already cooked earlier).** *"I ate out Wednesday"* when Wednesday was day 3 of a Mon-cooked Mon–Wed tagine batch. The batch was cooked Monday; the Wed serving is still in the fridge (day 3 of fridge life). Shift the eating day (Wed → Thu), cascade downstream by one day. Fridge life is tight but fits (cook day + 3 days = Thu end). If the recipe has a 2-day fridge life, the shift may push the last serving past freshness — the product points this out explicitly: *"heads up: one serving pushes past fridge life. Eat it today or it'll need to be tossed."* Rare branch; the default flow handles the common case.

**The user retroactively adds something not tied to a planned slot.** *"I forgot — I had a smoothie Tuesday afternoon, ~500 cal"*. No planned slot to replace. Route through the treat-log flow (JTBD A6).

**The user wants to undo a retroactive report.** *"Actually, I did eat the tagine — ignore the Indian restaurant thing"*. Natural-language request through the plan-mutation flow. The retroactive event is removed; the cascade is reverted. Undo must be available because honest self-correction is part of the adherence loop.

**The user reports every night of the week.** Seven deviations, seven pre-committed cook days for next horizon, no meals cooked this horizon. Extreme but handled by the same mechanic as a single deviation.

## Out of scope

- Calorie estimation from photo or voice note (v0.0.5+ dedicated workstream)
- Restaurant menu OCR, database lookup, curated nutrition database
- Budget absorption flow requiring calorie data (the v0.0.5+ extension described above)
- Weekly pace messaging (*"on pace"* / *"a bit tight"* / *"over budget"*) — depends on budget absorption
- Treat-budget / flex-budget magnitude thresholds (v0.0.5+)
- Protein-specific framing — secondary to calories per PRODUCT_SENSE
- The exact data model for planned-past vs. actual-past representation
- UI for browsing past retroactive events as a list — weekly framing is the primary surface
- Automatic nudges for patterns (*"you've eaten out every Tuesday"*) — reflection territory, separate proposal
- Restaurant-preparation flow (helping the user pick what to order before going out) — JTBD C3, future proposal
- How retroactive-event cascade interacts with next-horizon generation (beyond "pre-committed cook days appear at the start") — detailed when the planner update is specced
- Measurement log integration (JTBD D2 — weight, waist)
