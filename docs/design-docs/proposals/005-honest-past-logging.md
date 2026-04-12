# Honest Past Logging — Retroactive Plan Deviations

> Status: draft
> Date: 2026-04-12
> JTBD: C2 "Handle an unplanned restaurant or social meal" (retroactive variant), C1 "Handle missing ingredients at cook time", D1 "Check my budget after a deviation".
> PRODUCT_SENSE alignment: "Real life is the main environment." "The right response is adjustment, not punishment." The system must absorb honest reports of what actually happened without silently dropping them, lecturing the user, or inventing a different history than the one they lived.

## Problem

The user tells the product what actually happened — *"last night I went to an Indian restaurant"*, *"I skipped lunch today"*, *"the cook day got pushed — I made Tuesday's tagine on Wednesday"*. The product's job is to accept that report, record it honestly, and adjust going forward without drama.

Today, the product cannot do this. When the user reports a past deviation from the plan, one of three things happens:

1. The report is silently dropped. The product replies with a "Plan updated" confirmation that has nothing to do with what the user said. A restaurant visit never gets recorded. The user doesn't know their input was discarded unless they read the diff carefully.
2. The product asks to "override" the pre-committed slot — offering to do something its own rules forbid. The user picks an option, and the system either fails or produces confused output.
3. The product invents meaningless plan changes to satisfy an internal consistency check that the user never asked about.

None of these are acceptable for a product whose stated identity is flexibility-first and anti-punishment. A user who honestly reports a deviation and sees their input vanish will stop reporting. The product degrades into a one-way channel that only accepts plans, not reality.

This proposal is about the reverse direction: giving the user a first-class way to tell the product *what actually happened*, separate from *what was planned*.

## Current experience

**The scene.** It is Wednesday morning. Last night was the user's planned tagine dinner, but a friend invited them out to an Indian restaurant at the last minute. The user opens the bot to tell it so — honestly, without self-judgement.

**The user types:** "last night I went to an Indian restaurant"

**What the user expects.**

- Acknowledgement of what happened ("got it, logged ~900 cal Tuesday dinner")
- A quick read of where it leaves them for the week ("you're still on pace — no adjustments needed", or "you're ~500 cal over — want me to trim tonight's dinner?")
- Whatever happens to the rest of the plan is the product's problem to sort, not the user's

**What actually happens today (scenario 052's v2 recording).**

The product accepts the input, runs the re-proposer, hits a coverage/displacement/out-of-horizon validation failure, retries, and then — because the re-proposer can't legally touch a past slot — silently drops the Indian event from the proposal and presents a diff like:

> Added Chicken, Black Bean Bowl on Sat–Sun (2 servings)
>
> Tap Confirm to lock this in, or Adjust to change something.

This is what the user sees: a change to Saturday and Sunday lunches with no explanation, and no mention of Tuesday's restaurant. If the user taps Confirm, the plan updates; the restaurant dinner never enters the record.

The emotional arc:

- "I told the bot what happened."
- "It's showing me something about next weekend's lunch. Why?"
- "Did it understand? Did it log the restaurant? I can't tell."
- "I'll stop reporting these. I'll just eat what I eat and hope for the best."

This is the exact failure mode `PRODUCT_SENSE.md` frames as the enemy: the system works under ideal conditions but collapses the moment real life enters the picture.

**The architectural mandate already exists.** Design doc 002 ("Plans That Survive Real Life") explicitly states:

> Events are not rigid calendar entries. They're fuzzy, often unplanned, and sometimes retroactive. A multi-hour meetup with snacks, an unplanned restaurant, a cancelled BBQ — events are part of real life, and adjusting them is no different from adjusting any other part of the plan.

The product is supposed to handle retroactive events. It doesn't today, because the machinery that enforces "pre-committed slots are fixed" (correctly) prevents the agent from touching a past slot — and there's no alternative path that lets the user simply *report* what happened without trying to rewrite history.

## Proposed experience

The core framing change is this: the user is not asking the product to *modify the past*. The user is asking the product to *accept what actually happened* as a historical fact and adjust forward.

In product terms, past slots have two layers:

1. **Planned past** — what the plan said should happen. This stays immutable: the chicken bowl was planned for Tuesday lunch, the tagine was planned for Tuesday dinner. That's the plan's historical record.
2. **Actual past** — what the user reports actually happened. A retroactive event overlays the planned past with ground truth, for budget/reflection purposes, without rewriting the plan's record.

The user's interface with the product doesn't need to know these two layers exist separately. They just need to see: "Yes, I heard you. Here's what it means for your week."

### Screen 1 — Accept the report

**User types:** "last night I went to an Indian restaurant"

**Product replies:**

> Got it — Tue dinner was an Indian restaurant (~900 cal estimated).
>
> Your week so far: 8,400 / 17,052 cal used (49%). 4 days left, ~2,160 cal/day available. You're on pace — no changes needed.
>
> [ Looks right ] [ Estimate was off ]

**The user is thinking:** "Good, it logged it. I'm fine. Moving on."

**Design choices baked in:**

- The product **acknowledges the specific event** by day and meal — *Tue dinner* — so the user can see their input was parsed correctly.
- The product **estimates calories** without requiring the user to provide them. Estimation accuracy is advisory; the [ Estimate was off ] button lets the user correct if needed. Low friction is not optional.
- The product **frames the week in context** — cumulative usage, days left, per-day remaining — because a single meal without weekly framing tells the user nothing useful about adherence.
- The product **makes no mention of the planned tagine dinner**. That meal didn't happen. The record shows what happened, not what was supposed to.
- There is **no guilt**, no *"you were supposed to…"*, no *"to keep the plan complete I'd need to…"*. The plan absorbed it. That's the whole promise.

### Screen 2 — When the deviation is big enough to matter

**User types:** "I had a huge pizza last night, like 1,800 cal"

**Product replies:**

> Got it — Tue dinner was pizza (~1,800 cal). That's about 1,100 cal over the planned tagine.
>
> Your week: 9,200 / 17,052 cal used (54%). 4 days left, ~1,960 cal/day — a bit tight at normal portions (usually 2,160).
>
> Options:
> • Trim each remaining dinner by ~150 cal (easy: smaller portion)
> • Skip tomorrow's flex for now, redeploy to Sunday if the week stays clean
> • Leave it — one big meal won't derail the week
>
> [ Trim dinners ] [ Move flex ] [ Leave it ]

**The user is thinking:** "Three options. None of them feel like punishment. I'll pick 'leave it' and see how the week plays out."

**Design choices baked in:**

- **Options, not mandates.** The user chooses how to absorb the deviation, including "leave it alone" as a legitimate first-class option.
- **Realistic magnitudes.** The product says "a bit tight" at 1,960 cal/day, not "you've ruined the week". If the deviation is small (100–300 cal), the product skips the options entirely — "you're on pace" is the answer.
- **Weekly framing, always.** Per-day remaining is derived from weekly budget minus consumed — including the reported event. The user sees *what this means for the rest of the week*, not a raw calorie count.
- **The planned meal is not resurrected.** The tagine was supposed to happen Tuesday. It didn't. The meal prep is now one serving light going forward — the product mentions that ambiently (Screen 3) but doesn't dwell.

### Screen 3 — The meal prep implication

If the user reported a deviation on a day that had an active batch (e.g., the Tuesday tagine was one serving of a 3-serving Mon-Tue-Wed batch), the product mentions it briefly:

> Heads up: you have one extra serving of the Moroccan beef tagine in the fridge — from the Mon–Tue–Wed batch. You could eat it tonight in place of the planned pork, or it'll keep through Friday.

**The user is thinking:** "Right, the leftovers are still there. I'll have them tonight instead of cooking pork. Convenient."

**Design choices baked in:**

- **The fridge inventory is real.** Food was cooked. If the user ate elsewhere, the physical food didn't vanish. The product treats that honestly.
- **This is advisory, not a plan rewrite.** The suggestion doesn't auto-change tonight's dinner. If the user wants to act on it, they can type "use the tagine leftovers tonight" and the normal mutation flow kicks in.
- **Fridge-life is surfaced** so the user knows the real window to use the extra serving.

### Screen 4 — The "that was a treat" case

Some retroactive reports aren't deviations in the heavy sense — they're small, planned-for-flexibility moments: *"I had ice cream after dinner yesterday"*. These should route through the existing treat-budget flow (JTBD A6), not the restaurant-event flow. The product distinguishes by the user's language and the rough calorie magnitude:

- "I had [small food item]" with estimated cal under ~400 → treat log (A6)
- "I ate out / I went to [restaurant] / I had [big meal]" or estimated cal >= ~400 → retroactive event (this proposal)

Either path acknowledges the report, applies it to the appropriate budget (treat vs. weekly), and frames the week in context.

### Screen 5 — When the report is ambiguous

**User types:** "I ate out yesterday"

**Product replies:**

> Yesterday was Tuesday. Do you mean lunch, dinner, or both? And any sense of what it was — cuisine or rough calories helps me estimate.

**The user is thinking:** "Easy — dinner, Italian, maybe 1,200."

**Design choices baked in:**

- **One clarification round, at most.** If the user's reply is still ambiguous, the product takes its best guess and shows what it assumed — *"logged as Tue dinner, Italian, ~1,200 cal — tap [ Not quite ] if that's off"* — rather than asking a second question. Low friction.
- **The clarification is specific** — it names the day, asks for meal and cuisine, and offers an out ("rough calories helps"). It's not a generic "please clarify".

## Design decisions

### 1. Retroactive events overlay, not replace

A retroactive event does not modify the planned-past record. The plan still shows *"Tuesday dinner: tagine"* in the historical view, with a subscript like *"→ reported: Indian restaurant, ~900 cal"*. This preserves the user's ability to look back at what they meant to do, alongside what they did.

This matters for two reasons. First, the planned past is a source of learning — if the user consistently reports eating out on days where tagine was planned, the pattern tells the product something (tagine is not adherent for this user). Second, undoing a retroactive report should be possible: *"actually, I went with the tagine after all — ignore the Indian restaurant"*. If the plan's record was rewritten, undo would be lossy.

### 2. The weekly budget absorbs the report immediately

When the user confirms a retroactive event, the product updates the week's running totals and says what that means going forward. This is the anchor of the experience: the user reports, the product tells them where they stand, they move on.

If the report pushes the user over pace (typically a restaurant meal or a serious binge), the product offers lightweight adjustment options (Screen 2). Below a threshold (~300 cal over pace, roughly), the product says "you're on pace" without offering options at all. Adherence psychology matters more than precision here — frequent mini-adjustments fatigue the user.

### 3. No punishment, ever

The product does not:

- Frame the deviation as a failure ("you were supposed to…")
- Ask the user to justify the choice
- Suggest the user "make up for it" through restriction tomorrow
- Surface a running tally of past deviations
- Compare this week's deviations to prior weeks in a negative way

The product does:

- Acknowledge the report by its specific slot and magnitude
- Show the weekly context (cumulative cal, remaining days, per-day remaining)
- Offer optional lightweight adjustments when the magnitude warrants it
- Let "leave it" be a legitimate choice

### 4. Retroactive ≠ mutation of the past plan

This is the load-bearing decision. The re-proposer (the agent that rearranges the future plan) should not be asked to modify past slots. That conflicts with the "pre-committed slots are fixed" invariant for good reasons: the plan's historical record is the source of truth for fridge inventory, shopping, and reflection.

Instead, retroactive events should be modeled as a separate entity from plan mutations: a *historical log entry* that annotates what actually happened in a slot that was planned differently. The forward plan may or may not change in response, and if it does, that's a separate decision the user makes (Screens 2 and 3 offer it explicitly).

Practically: when the user says "I ate at an Indian restaurant last night", the product records a retroactive event tied to that (day, mealTime) slot. The weekly solver now sees:
- planned past: tagine dinner (as before)
- actual past: Indian restaurant event, ~900 cal
- weekly budget: uses actual past for calorie accounting, planned past for fridge inventory

The forward plan is only touched if the user picks an adjustment option. The default is "leave it".

### 5. Treat budget vs. weekly budget

Small-magnitude reports (*"I had ice cream yesterday"*, estimated 250 cal) route to the existing treat-budget flow, not the retroactive-event flow. Large-magnitude reports (*"I went to a restaurant last night"*, estimated 900 cal) route here. The routing is on magnitude + language, handled by the same dispatcher that already classifies intent (design doc 003's freeform conversation layer).

The user doesn't need to know which budget their report landed in. They need to see the acknowledgement and the weekly framing. The product picks the right bucket.

### 6. The conversation stays in one place

Retroactive reports are typed naturally — the user says what happened in one message, the product replies with one message (plus optional adjustment buttons). There is no dedicated "log a past meal" menu, no form to fill out, no separate surface. The product understands the user's intent from the language and routes appropriately.

This is a continuation of the principle from design doc 003: inbound text is classified by intent, not by menu state. "I ate out last night" is as valid an entry point as "/log_event" would be — and it matches how users actually think, which matters more than a clean API boundary.

## Edge cases

**The user reports a deviation on a day that's still active.** *"I'm grabbing lunch out today"* at 13:00 local on a day where lunch is still in the active horizon is a normal forward mutation, not a retroactive event. The existing re-proposer path handles it. The distinction is temporal: if the slot's cutoff has passed (15:00 for lunch, 21:00 for dinner in local TZ), the report is retroactive; if not, it's forward.

**The user reports a deviation from multiple days ago.** *"I went out for dinner Sunday and Monday"* on Thursday. The product acknowledges both, with a combined weekly framing. Each becomes its own retroactive event tied to its own slot. No special handling beyond iterating.

**The user reports a deviation on a day the plan had as a flex slot.** *"I used my flex Friday — I had Thai"* when Friday dinner was already a flex. This is just *logging what the flex was*, which is closer to the treat-log pattern than a surprise event. Record the actual meal + calories against the flex's budget, mark the flex as "used", done.

**The user reports a deviation that's smaller than the planned meal.** *"I had a salad last night — 400 cal — instead of the tagine"*. Under-eating is a deviation too. Record it, show weekly context. If the user is consistently under-eating, the product might later surface a note about that (adherence psychology — undereating is also not sustainable), but not in this screen and not in this proposal.

**The user reports a deviation that changes a batch's servings.** *"I didn't eat the tagine Monday — I went out"* when Monday was day 1 of a 3-day tagine batch, and the user has already cooked. The fridge has 3 servings still. This means the batch now covers days 2 and 3 with an extra serving available. Screen 3's "heads up" covers it: *"you have one extra serving of the tagine — could eat it Thursday or it'll keep through Saturday"*. No forced plan rewrite.

**The user retroactively adds something that wasn't planned at all.** *"I forgot to mention — I had a smoothie mid-afternoon Tuesday, ~500 cal"*. This isn't tied to a planned slot, so the retroactive-event model doesn't fit cleanly. Route through the treat-log flow instead (A6), which already handles "something I ate outside the plan". The dispatcher classifies on magnitude: 500 cal is at the boundary, either bucket works.

**The user disagrees with the estimated calories.** *"That pizza was more like 2,500"*. The [ Estimate was off ] button lets the user correct the estimate. The weekly totals recompute. The conversation stays in-place — no new turn, no re-asking.

**The user wants to undo a retroactive report.** *"Actually, I did eat the tagine — ignore the Indian restaurant thing"*. The product removes the retroactive event, restores the planned past as the source of truth for that slot, recomputes the weekly totals. Undo must be available because honest self-correction is part of the adherence loop.

**The user reports something on a day that's in the near-future soft-lock window** (today + tomorrow per design doc 002). This is a forward mutation, not a retroactive one — the existing re-proposer handles it with the near-future safety rule already in place. No new flow needed.

## Out of scope

- The exact data model for planned-past vs. actual-past overlay storage
- Whether retroactive events live in the same table as forward events or a separate one
- The precise threshold (in cal) that distinguishes treat-log from retroactive-event routing
- How the calorie estimator produces a number from a restaurant name + cuisine (v0.0.5+ work)
- Automatic nudges for patterns ("you've eaten out every Tuesday this month") — that's reflection territory, not this proposal
- Restaurant photo scanning and menu parsing (JTBD C3, separate proposal)
- How retroactive events affect the next week's plan generation (accounting for actual past consumption in recent-history prompts)
- Whether the measurement log (JTBD D2) should surface weekly calorie adherence alongside weight/waist
- UI for browsing past retroactive events as a list (*"show me everything I reported this week"*) — the weekly framing in Screen 1 is the primary surface for now
