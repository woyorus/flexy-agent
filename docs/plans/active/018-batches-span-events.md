# Plan 018: Batches must span events and flex slots — eating days ≠ consecutive days

**Status:** Active — problem definition only, plan of work TBD
**Date:** 2026-04-07
**Affects:** `src/agents/plan-proposer.ts`, `src/agents/plan-flow.ts`, `src/models/types.ts`, `src/shopping/generator.ts`, `src/telegram/formatters.ts`, scenarios TBD

## Problem

### The false assumption

The entire batch model is built on the assumption that **a batch's eating days must be consecutive calendar days**. This assumption is baked into:

1. **The data model** — `types.ts:11`: "A Batch is a first-class entity: one recipe, 2-3 servings, 2-3 consecutive eating days." `types.ts:219`: "ISO dates this batch is eaten on (2-3 contiguous days)."
2. **The proposer prompt** — `plan-proposer.ts:191`: "Lunch and dinner are meal-prepped in batches of 2-3 servings (consecutive days)." Line 216: "Each batch covers consecutive days for the same meal type (e.g., lunch Mon-Wed)."
3. **The flex_move handler** — `plan-flow.ts:1433-1455`: `removeBatchDay()` splits remaining days into contiguous runs via `splitIntoContiguousRuns()`. A day removed from the middle of a 3-day batch produces two singleton orphans, which become recipe gaps the user must fill.
4. **The orphan resolution system** — `plan-flow.ts:1281-1349`: `resolveOrphanPool()` groups orphans into contiguous runs, only auto-creates batches for runs ≥ 2 days, and punts singletons to `resolveSingletonOrphan()` which creates recipe gaps.

**This assumption is wrong.** Cooking a batch and eating it on consecutive days are different things. A 3-serving batch cooked on Wednesday can be eaten Wed, skip Thursday (event dinner), then Fri and Sat. The food sits in the fridge — it doesn't expire because the user went to a birthday party on Thursday.

### What the user experienced

The plan proposer created this week:

```
Lunch Wed-Thu-Fri: Chicken Rice Bowl (3 servings)
Lunch Sat-Sun: Pork Rice Bowls (2 servings)  
Lunch Mon-Tue: Tuna Rice Bowl (2 servings)
Dinner Fri-Sat: Salmon Linguine (2 servings)
Dinner Sun-Mon-Tue: Moroccan Beef Tagine (3 servings)
Flex: Wed dinner
Event: Thu dinner (Rune's birthday BBQ)
```

The user said: "I don't want to begin my week with a flex meal. Make it on Sunday."

**What should happen:** Move flex from Wed dinner to Sun dinner. The Moroccan Beef Tagine batch (originally Sun-Mon-Tue, 3 servings) now has a flex slot on Sunday. But the batch doesn't need to shrink — it just skips Sunday. The correct result:

```
Dinner Wed: [some recipe or extended existing batch]
Dinner Thu: EVENT (birthday BBQ)
Dinner Fri-Sat: Salmon Linguine (2 servings)
Dinner Sun: FLEX
Dinner Mon-Tue + [overflow or extend]: Moroccan Beef Tagine (still 3 servings, cooked Mon, eaten Mon-Tue-Wed-of-next-week or eaten Mon+Tue with one serving pre-eaten before Sun)
```

Or more naturally: cook the Tagine on Friday, eat serving 1 on Friday, skip Sat (Salmon Linguine covers Sat as a separate batch), eat serving 2 on Monday, serving 3 on Tuesday. The exact arrangement depends on the solver, but the point is: **the batch doesn't break just because one of its calendar days has a different meal**.

**What actually happened:** The system treated the flex-move as removing Sun from the Moroccan Beef Tagine batch (Sun-Mon-Tue). `removeBatchDay()` split the remaining days [Mon, Tue] into one contiguous run, which got auto-batched. But the freed Wed dinner (where flex used to be) became a singleton orphan. `resolveSingletonOrphan()` couldn't extend an adjacent batch (Thu is an event), so it created a recipe gap: "dinner on Wed needs a recipe after a flex slot change."

The user was then dumped into a dead-end flow asking them to pick a recipe for a 1-serving dinner on Wednesday. They tried "Start over", tried "Remove event on Thursday" — both ignored. They abandoned the session.

### The deeper design problem

The consecutive-days constraint doesn't just break flex_move. It constrains the proposer too. When the proposer places a 3-serving batch, it MUST find 3 consecutive free days for that meal type. Events and flex slots fragment the calendar, forcing the proposer into smaller batches and more cook days — the opposite of what the system should optimize for.

**The real-world model is:**
- You cook a batch of N servings
- You eat those servings over the next several days
- Events, flex meals, and other batches are interleaved — they don't break the batch
- What matters is: the cook day, the total servings, and a fridge-life constraint (typically 3 days from cook day)
- The eating days are the non-event, non-flex days within the fridge-life window

**The correct constraint is fridge-life, not consecutive days.** A 3-serving batch cooked Wednesday with 3-day fridge life can cover any 3 meal-prep slots between Wed and Sat (inclusive). If Thu dinner is an event and Fri dinner is flex, the 3 servings go to Wed, Sat, and (if fridge life allows) even Sun.

### Scope of the problem

This is not a local fix in `flex_move`. The consecutive-days assumption is structural:

- **Proposer**: The LLM prompt tells the proposer to assign consecutive days. It needs to instead assign batches based on fridge-life windows, allowing events and flex to be interleaved.
- **Data model**: The `eatingDays` array and all documentation say "contiguous." The model itself doesn't enforce this (it's just an array), but every consumer assumes it.
- **`removeBatchDay()` / `splitIntoContiguousRuns()`**: The entire orphan machinery exists because removing a day from the middle of a "consecutive" batch creates fragments. With fridge-life semantics, removing a day from a batch doesn't break it — the batch just has fewer servings, or the remaining servings spread across the remaining eligible days.
- **Formatters**: "Dinner Fri-Sat" display format assumes contiguous ranges. Non-contiguous batches need different display (e.g., "Dinner Fri+Sun" or day-by-day display).
- **Shopping list**: Uses `eatingDays[0]` as cook day. This is fine — cook day stays the first eating day. But the generator may need to understand that a batch's eating days aren't necessarily a continuous range.

### What this plan does NOT cover

This plan defines the problem. The plan of work — how to change the proposer prompt, the data model semantics, the orphan resolution, the formatter, and the test scenarios — will be written after alignment on the problem definition.
