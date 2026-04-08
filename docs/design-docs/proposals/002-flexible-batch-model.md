# Flexible Batch Model: Batches as Physical Food, Not Calendar Slots

> Status: draft
> Date: 2026-04-08
> JTBD: B1 (Plan my week — anxiety to calm), A1 (Know my next action), C2 (Handle unplanned social meals)
> PRODUCT_SENSE alignment: Flexibility is required (principle 4), real life is the main environment (principle 7), the system should bend without breaking.

## Problem

The product models batches as calendar structures — "this recipe on these consecutive days." Real life doesn't work that way. You cook 3 servings of food. You eat them when you can. A birthday BBQ on Thursday doesn't destroy the food in your fridge. But the product thinks it does.

This false assumption:
- **Constrains the proposer** — it must find consecutive free days for each batch, forcing smaller batches and more cook sessions when events/flex fragment the calendar
- **Breaks plan mutations** — moving a flex meal into a batch's range triggers orphan cascades, dead-end recipe gap flows, and abandoned sessions
- **Violates the core product promise** — the system collapses when real life happens, which is the exact opposite of what it should do

The consecutive-days assumption is baked into the data model documentation, the proposer prompt, the mutation handlers, and the display formatters. It is structural, not a local bug.

## Current experience

The user plans their week. The proposer creates:

```
Dinner Wed: [1-serving cook — some simple recipe]
Dinner Thu: 🍽️ BBQ at Rune's
Dinner Fri-Sat: Salmon Linguine (2 servings)
Dinner Sun-Mon-Tue: Moroccan Beef Tagine (3 servings)
Flex: Wed dinner
```

The user says: "I don't want flex on Wednesday. Put it on Sunday."

**What happens:** The system treats this as removing Sunday from the Moroccan Beef Tagine batch (Sun-Mon-Tue). `removeBatchDay()` splits the remaining days. The freed Wednesday becomes a singleton orphan. `resolveSingletonOrphan()` can't extend an adjacent batch (Thursday is an event), so it creates a recipe gap. The user gets dumped into a dead-end flow asking them to pick a recipe for a 1-serving Wednesday dinner.

The user tries "Start over." Tries "Remove event on Thursday." Both ignored. Session abandoned.

**What the user feels:** Frustrated, confused, out of control. The opposite of anxiety → calm. A trivial request ("put flex on Sunday") broke the entire plan.

## Proposed experience

### The batch model

A batch is a physical quantity of food:
- **N servings** of one recipe (2-3 preferred; 1 allowed only when no multi-serving arrangement fits; 4+ not allowed — food boredom causes cravings and rebounds)
- **Cooked on the first eating day**
- **Eating days** = available slots (non-event, non-flex) within a fridge-life window from the cook day
- **Fridge life** is a hard constraint per `recipe.storage.fridgeDays` — a batch's calendar span must not exceed it unless the recipe is freezable and a valid `storagePlan` is present
- Events and flex in the middle don't break the batch — they're days you eat something else

**The batch is done when all servings are consumed.** Not when a calendar window expires.

### Storage rules (deterministic, not prompt-only)

Recipes already have structured storage fields (`fridgeDays`, `freezable`, `reheat`). These become hard constraints on batch arrangement:

- **Span** = last eating day minus cook day (in calendar days). Example: cook Wed, last eating day Sat → span = 3.
- If `span ≤ recipe.storage.fridgeDays` → fridge only, no special handling.
- If `span > recipe.storage.fridgeDays` AND `recipe.storage.freezable === true` → batch requires a storage plan (freeze some portions on cook day, defrost before later eating days).
- If `span > recipe.storage.fridgeDays` AND `recipe.storage.freezable === false` → **invalid arrangement.** The proposer must not produce this. The validator rejects it.

**Persisted storage plan:** When a batch requires freezing, the Batch type gains an optional `storagePlan` field:

```
storagePlan?: {
  freezeAfterServing: number;    // freeze remaining portions after eating this many (e.g., 1)
  defrostBeforeDay: string;      // ISO date — defrost the morning of this day
}
```

This field exists on both `ProposedBatch` (draft/proposer shape, validated before persistence) and persisted `Batch`. The proposer produces it; the validator checks it; persistence copies it through.

This is derived by the proposer and validated deterministically. If the proposer says "freeze 2 portions," the storage plan captures exactly when to freeze and when to defrost. The day detail screen shows this: "Freeze 2 portions after cooking" on cook day, "Defrost this morning" on the defrost day.

If no freezing is needed (`span ≤ fridgeDays`), `storagePlan` is omitted.

### Initial proposal

The proposer (reasoning LLM) arranges batches to minimize cook sessions while respecting fridge life and variety. It can span batches over events and flex.

For the same week (BBQ Thursday, flex on Wednesday), instead of a 1-serving cook + a 2-serving batch, the proposer produces:

```
🔪 Dinner Wed, Fri-Sat: Moroccan Beef Tagine (3 servings)
   Dinner Thu: 🍽️ BBQ at Rune's
   Dinner Sun-Mon-Tue: Salmon Linguine (3 servings)
   Flex: Wed lunch (or wherever it fits best)
```

Or if the user specified flex on Wednesday dinner:

```
   Dinner Wed: Flex
   Dinner Thu: 🍽️ BBQ at Rune's
🔪 Dinner Fri-Sat-Sun: Moroccan Beef Tagine (3 servings)
🔪 Dinner Mon-Tue: Salmon Linguine (2 servings)
```

One cook session eliminated. The food spans the BBQ naturally.

When a batch spans longer than ~4 calendar days (e.g., due to multiple events in the middle), the proposer adds a storage note:

```
🔪 Dinner Mon, Thu-Fri: Beef Tagine (3 servings)
   Cook Mon, freeze 2 portions. Defrost Thu morning.
```

The proposer handles this naturally — it understands food storage because it's an LLM, not an algorithm.

### Plan mutations — re-proposer contract

**All mutations → re-run the proposer.** The user says what they want (voice or text), the reasoning LLM re-arranges the plan around that constraint and presents the updated version.

"Move flex to Sunday" → the re-proposer receives the current plan + the constraint, re-arranges dinner batches for the week, presents the new plan.

No orphan machinery. No cascade of edge cases. No dead-end flows.

If the result isn't quite right, the user sends another voice note: "Actually, I'd rather cook on Friday, not Thursday." The re-proposer re-arranges again. Low friction, always adaptive.

**What the re-proposer CAN change:**
- Batch arrangement: eating days, cook days, move existing approved recipes to different day ranges
- Batch serving counts (within 1-3)
- Flex slot placement (if the mutation involves flex)
- Storage plans (freeze/defrost scheduling)

**What the re-proposer CANNOT change:**
- Recipe slugs: it may not introduce, remove, or replace an approved recipe without surfacing it as a recipe gap for user approval. Moving an existing recipe's batch to different days is allowed; swapping it for a different recipe is not.
- Events (user-provided, immutable unless the user says otherwise)
- Breakfast (fixed)
- Total number of flex slots (stays at `config.planning.flexSlotsPerWeek`)

**Constraint preservation:** The re-proposer receives the full mutation history as context — every swap the user has made in this session. This prevents undoing a previous user choice while fixing a new one (e.g., "I moved flex to Sunday, now swap the salmon recipe" should not move flex back to Wednesday).

**Recipe gaps:** If re-arrangement means a meal type needs more coverage than existing recipes provide, the re-proposer flags a recipe gap. The existing inline gap resolution flow handles it — no change needed.

**Rollback:** The draft/save-before-destroy pattern (D27) still applies. The re-proposer produces a draft proposal. The user reviews and approves. The old plan stays live until approval. If the user abandons, nothing changes.

### Proposal validator (deterministic QA gate)

The proposer is agentic. But its output is validated deterministically before reaching the user — same pattern as the existing solver QA gate. The validator checks:

| Invariant | Rule |
|---|---|
| Slot coverage | Every day × meal type has exactly one source: batch, event, or flex |
| No overlap | No day × meal type is claimed by two batches, or by a batch and an event/flex |
| Eating days sorted | `eatingDays` is ascending ISO order |
| Servings match | `servings === eatingDays.length` |
| Servings range | `1 ≤ servings ≤ 3` (validator warns on 1-serving batches; valid but discouraged) |
| Cook day in horizon | `eatingDays[0]` is within the plan's horizon |
| Storage span valid | `span ≤ recipe.storage.fridgeDays` OR (`recipe.storage.freezable` AND `storagePlan` valid — see below) |
| Flex count | Exactly `config.planning.flexSlotsPerWeek` flex slots |
| No orphan days | No meal slot left uncovered |

**storagePlan validation** (when present):
- `freezeAfterServing` is in range `[1, servings - 1]` (freeze at least 1, keep at least 1 fresh)
- `defrostBeforeDay` is an ISO date that falls on or before one of the later eating days
- All eating days after defrost are within `recipe.storage.fridgeDays` of the defrost day (post-defrost fridge window is safe)

**Validation target:** The validator runs on `ProposedBatch` (which uses `days` + `overflowDays`) before persistence. The invariant is: `servings === days.length + (overflowDays?.length ?? 0)`. After materialization to persisted `Batch`, the equivalent is `servings === eatingDays.length`. Both stages are validated.

If validation fails, the proposer retries with the validation errors as feedback (same retry-with-correction pattern used today). If it fails twice: for mutations, keep the prior valid draft and tell the user the change couldn't be applied cleanly — ask them to adjust or retry. For initial proposals (no prior draft exists), fail gracefully and ask the user to retry, possibly with different constraints. Invalid proposals never reach the user — the deterministic QA gate is a hard gate, not advisory.

### Display

**Week overview** — unchanged. Already day-by-day, naturally handles non-consecutive batches:

```
**Your week:** Wed Apr 8 – Tue Apr 14

_Breakfast: Avocado Toast & Eggs (daily)_

**Wed** 🔪
L: Chicken Rice Bowl · D: Moroccan Beef Tagine

**Thu**
L: Chicken Rice Bowl · 🍽️ D: BBQ at Rune's

**Fri**
L: Chicken Rice Bowl · D: Moroccan Beef Tagine

**Sat** 🔪
L: Pork Rice Bowls · D: Moroccan Beef Tagine

**Sun** 🔪
L: Pork Rice Bowls · D: Salmon Linguine

**Mon**
L: Tuna Rice Bowl · D: Salmon Linguine

**Tue**
L: Tuna Rice Bowl · D: Salmon Linguine

**Weekly target: on track ✓**
```

The user sees tagine on Wed, Fri, Sat — reads naturally. No special notation needed for "non-consecutive batch."

**Day detail** — gap-aware notation for cook days:

```
**Wednesday, Apr 8**

🔪 Lunch: **Chicken Rice Bowl**
Cook 3 servings (Wed–Fri) · ~800 cal each

🔪 Dinner: **Moroccan Beef Tagine**
Cook 3 servings (Wed, Fri–Sat) · ~800 cal each
```

Reheat days show serving progress:

```
**Friday, Apr 10**

Lunch: Chicken Rice Bowl
_Reheat · serving 3 of 3_

Dinner: Moroccan Beef Tagine
_Reheat · serving 2 of 3_
```

**Day detail — storage notes** when a batch requires freezing:

Cook day:
```
🔪 Dinner: **Moroccan Beef Tagine**
Cook 3 servings (Mon, Thu–Fri) · ~800 cal each
_Freeze 2 portions after cooking_
```

Defrost day:
```
Dinner: Moroccan Beef Tagine
_Reheat · serving 2 of 3 · defrost this morning_
```

**Day range formatting** — the current `getDayRange()` formats as "first–last" which would show "Wed–Sat" for a Wed, Fri, Sat batch. This needs a non-contiguous formatter: group consecutive runs and join with commas. Examples:
- `[Wed, Thu, Fri]` → "Wed–Fri" (unchanged for contiguous)
- `[Wed, Fri, Sat]` → "Wed, Fri–Sat"
- `[Mon, Wed, Fri]` → "Mon, Wed, Fri"

**Cook-time recipe** — unchanged. "3 servings — divide into equal portions." The recipe doesn't care which days you eat them.

**Shopping list** — unchanged. Cook day is `eatingDays[0]`. Aggregation is the same.

## Design decisions

### Why 2-3 servings stays firm (not 4)

Food boredom is psychologically worse than extra cooking. Eating the same meal for 4+ days — especially when a gap makes it feel like almost a week — causes cravings and rebounds. This directly violates the product's psychological sustainability principle. A 1-serving cook is preferable to a 4-serving batch.

### Why mutations use the re-proposer, not deterministic handlers

Deterministic mutation handlers (removeBatchDay, splitIntoContiguousRuns, resolveOrphanPool) are the root cause of the dead-end flows. Every edge case spawns more handlers, which spawn more edge cases. A reasoning LLM handles the long tail naturally — including storage recommendations like freezing half a batch — because it understands real-life food logistics. The codebase gets smaller, not bigger.

The intent classification layer (flex_move, recipe_swap) stays as routing for now. But instead of each intent having its own deterministic handler, they all feed into the re-proposer. v0.0.5 removes the intent layer entirely in favor of agentic plan mutations.

### Why fridge life is a hard constraint with a freezing escape hatch

A batch's calendar span must not exceed `recipe.storage.fridgeDays` unless the recipe is freezable and a valid `storagePlan` is present. This is enforced by the validator, not left to the LLM's judgment. The "escape hatch" is freezing: when a batch needs to span longer than fridge life allows, the proposer produces a storage plan and the validator confirms it's structurally sound. This gives flexibility without ambiguity — the LLM decides when freezing makes sense, the validator confirms the plan is safe.

### What stays deterministic

The solver (calorie math, uniform distribution, budget allocation), recipe scaling (hit calorie targets), and the proposal validator (invariant checking) stay deterministic. The line is: **the LLM proposes, deterministic systems validate and calculate.** The LLM is not trusted to produce structurally valid output — it's trusted to make good arrangement decisions, then a validator confirms the structure is sound before the user sees it. Same pattern as the existing solver QA gate.

## Edge cases

### Batch spans beyond fridge life due to events

The proposer checks `recipe.storage.freezable` before spanning a batch beyond `fridgeDays`. If freezable, it produces a `storagePlan` (freeze N portions on cook day, defrost on day X). The validator confirms `storagePlan` is present when span exceeds `fridgeDays`. If the recipe isn't freezable, the proposer must split into two batches or pick a different recipe. Example: cook Monday, events Tue-Wed-Thu, eat Fri-Sat. Storage plan: freeze 2 portions Monday, defrost Friday morning.

### Moving flex creates no available days for a batch

If the user moves flex to a day that was the only remaining eating day for a batch, the re-proposer re-arranges — potentially changing which recipe goes where. The user sees the updated plan and can adjust further.

### 1-serving batch

Allowed but discouraged. The proposer should prefer extending an adjacent batch or rearranging to avoid it. Valid when no multi-serving arrangement fits (e.g., a single uncovered day between two events). The validator passes it but logs a warning.

### Batch's cook day changes after a mutation

If the re-proposer moves a batch's eating days such that the first eating day changes, the cook day changes too. The shopping list updates accordingly. The user sees the new cook day in the updated plan.

## Out of scope

- **Conversational event collection** — the current phased event flow stays for v0.0.4. v0.0.5's freeform conversation layer replaces it with "leave a voice note describing your week."
- **Voice-driven mutations as primary UX** — v0.0.4 still uses [Swap something] → text/voice input → re-proposer. v0.0.5 makes mutations accessible from anywhere.
- **LLM-generated contextual quick-fix buttons** — v0.0.5 replaces static [Swap something] with contextual suggestions.
- **Mid-week plan mutations** — this proposal covers mutations during the planning session only. Mid-week changes (unplanned restaurants, missing ingredients) are v0.0.5.
- **Shorter-than-7-day plans** — travel scenarios where the plan ends early are a separate problem.

## Connection to v0.0.5

This proposal introduces the re-proposer for plan mutations. v0.0.5's freeform conversation layer extends it:

| Capability | v0.0.4 (this proposal) | v0.0.5 |
|---|---|---|
| Batch model | Flexible (serving-count + fridge-life) | Unchanged |
| Proposer prompt | Updated for non-consecutive batches | Unchanged |
| Plan mutations | Re-proposer via [Swap something] flow | Re-proposer from anywhere (voice/text) |
| Mutation UI | Button-driven with text/voice input | Fully conversational, LLM-generated buttons |
| Event collection | Current phased flow | Conversational ("here's my week") |
| Intent classification | Routing to re-proposer | Removed — agent handles all mutations |

The re-proposer built for v0.0.4 becomes the core of v0.0.5's agentic plan mutation system. Nothing built here gets thrown away.

## Code that gets removed

The following deterministic mutation machinery becomes unnecessary:
- `removeBatchDay()` and batch-splitting logic
- `splitIntoContiguousRuns()`
- `resolveOrphanPool()` and orphan grouping
- `resolveSingletonOrphan()`
- `absorbFreedDay()` and adjacent-batch extension

These are replaced by a single re-proposer call.
