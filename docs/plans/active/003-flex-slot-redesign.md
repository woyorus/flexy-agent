# Plan 003: Flex Slot Redesign — Open Problems

**Status:** Parked — problems identified, not yet designed
**Date:** 2026-04-03
**Depends on:** Plan 001 (calorie budget redesign)

---

## Context

Flex slots (planned fun meals with a ~350 cal bonus, typically Friday/Saturday dinner) are a nice concept but have several unresolved design problems that need careful thought before v0.0.5 (tracking + rebalancing).

## Problem 1: Restaurant events already consume the flex budget

A restaurant dinner is typically 1,000-1,200 cal. A normal meal prep dinner is ~840 cal. The restaurant is already ~200-400 cal OVER the normal meal — that's the same magnitude as the flex bonus (350 cal). So if you have a restaurant event, you've effectively "spent" the flex budget on the restaurant, not on a fun meal you chose.

If both a restaurant event AND a flex slot exist in the same week, the total flex/event allocation might push the budget too hard, forcing either treat budget or meal prep to shrink.

## Problem 2: Removing a flex slot mid-week requires unplanned cooking

In v0.0.5, if the system needs to rebalance (e.g., restaurant overage), one option is removing a flex slot. But that means the user now needs a meal prep for that slot — a meal that wasn't planned, wasn't shopped for, and wasn't cooked. This creates friction at exactly the moment the system should be reducing friction.

Options to explore:
- Keep the flex slot but reduce its bonus to zero (just eat something, budget is normal-sized)
- Have a "fallback recipe" concept — a simple recipe always available for emergency meals
- Accept the flex removal but auto-add ingredients to a dynamic shopping list update

## Problem 3: Flex meal calorie precision is unrealistic at restaurants

A flex dinner is budgeted at ~1,190 cal (839 base + 350 bonus). But if the user takes the flex meal at a restaurant, hitting 1,190 cal is impossible to control. A burger might be 900 or 1,500 depending on the place. The concept of a "precise flex budget" clashes with the reality of uncontrolled eating environments.

This is especially relevant for v0.0.5 tracking: when the user snaps a photo of their restaurant flex meal and the vision model estimates 1,400 cal, what happens? The plan said 1,190. That's 210 over. Does the system rebalance? The flex slot was supposed to be the "free" meal.

Possible directions:
- Flex slots are NOT a calorie target — they're a "planned unstructured meal" with a rough estimate for planning purposes only. The treat budget absorbs the variance.
- Flex slots have a RANGE, not a point estimate (e.g., "900-1,400 cal, budgeted at 1,100")
- The flex bonus is just a planning offset — actual tracking against it in v0.0.5 should have wide tolerance

## Problem 4: Interaction between flex slots, events, and rebalancing (v0.0.5)

When v0.0.5 rebalancing arrives, the priority order for absorbing overages needs to be clear:

1. Treat budget absorbs first (it's the explicit flexibility buffer)
2. Flex slot bonuses absorb second (reduce the flex meal budget, but keep the slot)
3. Meal prep scaling absorbs third (scale down remaining uncooked meals)
4. Flex slot removal is last resort (requires cooking an unplanned meal)

This priority order should be designed and documented before v0.0.5 implementation.

## Next Steps

- Park this until plan 001 (budget redesign) is implemented and tested
- Revisit before v0.0.5 (tracking + rebalancing) design begins
- The flex slot concept may need significant rework based on real-world usage of v0.0.3/v0.0.4
