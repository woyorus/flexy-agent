# Plan 004: Event Type Classification — Meal Replacements vs Treats

**Status:** Complete — implemented
**Date:** 2026-04-04
**Depends on:** Plan 001 (calorie budget redesign, event semantics)
**Affects:** plan-flow event parsing, event step UX copy

---

## Problem

The event parser forces every user-described event into a meal-replacement structure (`meal_time: "lunch" | "dinner"`, estimated calories). When a user says "cookies at a work event on Monday," the system creates a MealEvent that replaces their Monday lunch slot — removing ~803 cal of real food and substituting 250 cal of cookies.

From the debug log:

```
[TG:IN] text: Snacks during mind circle event on Monday - only cookies in stuff
[AI:RES] {
  "name": "Cookies-only snacks during Mind Circle",
  "day": "2026-04-06",
  "meal_time": "lunch",
  "estimated_calories": 250
}
[PLAN-FLOW] event added: Cookies-only snacks during Mind Circle on 2026-04-06 lunch (~250 cal)
```

This violates the Event Semantics defined in Plan 001:
- **Meal-replacement events** (restaurants) replace a slot — correct for "dinner at Italian place"
- **Treat events** (cookies, cake, snacks) do NOT replace a slot — they come from the treat budget (853 cal/week)

Replacing an 803 cal protein-rich meal with 250 cal of cookies means under-eating, missing protein, and triggering psychological rebound.

## Root Cause

The `parseNewEvent` prompt in `plan-flow.ts` (line ~252) has no concept of event types. It only outputs `meal_time: "lunch" | "dinner"`, which implies every event replaces a meal. The LLM has no option to say "this is a snack, not a meal replacement."

The events step question ("Any meals out or social events this week?") is also too broad — "social events" includes snack situations that aren't meal replacements.

## Proposed Solution

### 1. Add type classification to the event parser

Update the `parseNewEvent` system prompt to classify the event before parsing:

```json
{
  "type": "meal_replacement" | "treat",
  "name": "string",
  "day": "ISO date string",
  "meal_time": "lunch" | "dinner",
  "estimated_calories": number,
  "notes": "string or null"
}
```

Classification guidance for the LLM:
- **meal_replacement**: the user is eating a full meal somewhere else — restaurant, dinner party, lunch out, takeout that replaces a home meal. The meal prep for that slot is skipped.
- **treat**: snacks, desserts, drinks, or extras that happen alongside regular meals — cookies at work, birthday cake, conference snacks, drinks at happy hour. The user still eats their normal meal prep.

### 2. Handle treats differently in the flow

When the parser returns `type: "treat"`:
- Do NOT add it to `state.events` (events = meal replacements only)
- Respond: "That's a treat — your treat budget (853 cal/week) covers it. You still eat your regular meals that day. Any actual meals out?"
- The treat is not stored during planning. It's spontaneous spending from the treat budget.

When the parser returns `type: "meal_replacement"`:
- Proceed exactly as today — add to `state.events`, show confirmation, ask for more.

### 3. Reword the events step question

Current: "Any meals out or social events this week?"

New: "Any meals you'll eat out this week? (restaurants, dinner parties, etc.)"

This subtly guides toward meal replacements. If the user still describes a treat, the parser catches it.

### 4. Update keyboard button text

Current: `[No events this week]  [Add event]`

New: `[No meals out]  [Add meal out]`

Reinforces that "events" = meals eaten outside the meal prep plan.

## Edge Cases

**"Pizza Friday night"** — ambiguous. Is it a flex meal (eating pizza instead of meal prep) or a treat (having a slice alongside meal prep)? The LLM should classify this as `meal_replacement` since pizza is a full dinner. The flex slot mechanism handles "fun dinner" scenarios separately during plan generation.

**"Drinks at happy hour Friday"** — treat. A few drinks don't replace dinner. The user still eats their meal prep.

**"Dinner and drinks at a bar Friday"** — meal_replacement. "Dinner" is the key word — the user is eating a full meal out.

**"Birthday cake at the office Wednesday"** — treat. A slice of cake doesn't replace lunch.

**"Brunch with friends Saturday"** — meal_replacement. Brunch replaces a meal (probably lunch-equivalent).

## Implementation Steps

Single phase — all changes are in 2 files and tightly coupled.

**Step 1: `src/agents/plan-flow.ts`** — update `parseNewEvent`

Update the system prompt (line ~252) to include type classification:

```
Parse a meal event description. The week runs {weekStart} to {weekEnd}.
Day names map to: Mon={...}, Tue={...}, ...

CLASSIFY the event type:
- "meal_replacement": eating a full meal somewhere else (restaurant, dinner party, lunch out). Replaces the meal prep for that slot.
- "treat": snacks, desserts, or extras alongside regular meals (cookies at work, birthday cake, drinks). Does NOT replace any meal — comes from the treat budget.

Respond with JSON:
{
  "type": "meal_replacement" | "treat",
  "name": "string — short description",
  "day": "ISO date string",
  "meal_time": "lunch" | "dinner" (for meal_replacement; pick closest for treats),
  "estimated_calories": number,
  "notes": "string or null"
}
```

Update the handler after parsing (line ~270):
- If `type === "treat"`: return a response explaining it's covered by the treat budget. Do not push to `state.events`.
- If `type === "meal_replacement"`: proceed as before.

Also update `classifyEventIntent` (line ~189) — the correction flow should also handle treat reclassification. If the user says "no, that's just a snack, I'm still eating my meal prep" after a meal_replacement was added, reclassify and remove the event.

**Step 2: `src/telegram/bot.ts`** — update the events step question

Change the prompt text (lines ~298, ~306):
```
"Any meals out or social events this week?"
→ "Any meals you'll eat out this week? (restaurants, dinner parties, etc.)"
```

**Step 3: `src/telegram/keyboards.ts`** — update button text

Change the plan events keyboards (lines ~191-197):
```
"No events this week"  → "No meals out"
"Add event"            → "Add meal out"
"That's all"           → "That's all"  (stays the same)
"Add another"          → "Add another" (stays the same)
```

**Verify:** Run the bot. Test with:
1. "Thursday dinner at Italian restaurant" → should classify as meal_replacement, add to events
2. "Cookies at work event Monday" → should classify as treat, explain treat budget, NOT add to events
3. "Pizza Friday night" → should classify as meal_replacement
4. "Birthday cake at office Wednesday" → should classify as treat

## Risks

- **Classification accuracy.** The nano model might misclassify edge cases. Mitigation: the prompt examples are explicit, and misclassification is recoverable (user can correct). Low risk — the distinction between "eating dinner at a restaurant" and "having cookies at a meeting" is clear to even the smallest model.
- **User confusion.** If the user doesn't understand why their "event" was treated as a treat, the explanation message must be clear. Mitigation: the response explicitly says "your treat budget covers it" and "you still eat your regular meals."

## What This Does NOT Change

- **The solver.** Events in `state.events` are still meal replacements only. The solver doesn't need to know about treats.
- **The treat budget.** Still 853 cal/week (5%). Still protected upfront.
- **The MealEvent type.** No schema change needed — treat events are simply not stored as MealEvents.
- **Plan 001 implementation.** Fully compatible, just fills a gap in the event parsing layer.
