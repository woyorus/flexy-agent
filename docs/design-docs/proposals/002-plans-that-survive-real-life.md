# Plans That Survive Real Life

> Status: draft
> Date: 2026-04-09
> Supersedes: 002-flexible-batch-model.md (reframed — flexible batches are a prerequisite, not the full problem)
> JTBD: B1 (Plan my week — anxiety to calm), A1 (Know my next action), C2 (Handle unplanned social meals)
> PRODUCT_SENSE alignment: Flexibility is required (principle 4), real life is the main environment (principle 7), the system should bend without breaking, adherence is the main variable (principle 1).

## Problem

The plan architecture has two structural flaws that must be fixed before the product can deliver on its core promise.

**Flaw 1: Batches are calendar structures, not physical food.** A batch of 3 must occupy 3 adjacent days. A BBQ on Thursday splits the batch. An event in the middle creates orphans. This constrains the proposer, breaks mutations, and prevents adaptation.

**Flaw 2: Mutations are handled by deterministic handlers that shatter on edge cases.** Intent classification routes to rigid handlers (removeBatchDay, resolveOrphanPool, etc.). Each edge case spawns more handlers, which spawn more edge cases. A trivial request like "move flex to Sunday" can trigger orphan cascades, dead-end recipe gap flows, and abandoned sessions.

These flaws also block the product's future: mid-week adaptation (v0.0.5) is impossible without a flexible batch model and an agent-driven mutation system. The architecture introduced here is designed for both planning-session mutations (shipping now) and mid-week adaptation (v0.0.5 — same re-proposer, different entry point).

**What motivated this rewrite:** The product shipped to production on 2026-04-08 and the plan didn't survive the first day. The user planned a week, cooked lunch, then went to an unplanned Indian restaurant dinner with friends. The planned dinner batch should have shifted forward. The restaurant meal should have been absorbed as a flex meal. Instead, the plan became fiction — every future day was wrong. This scenario requires mid-week mutation support (v0.0.5), but the current architecture can't even support it. The batch model and mutation system must change first.

### What ships in this proposal

- Flexible batch model (non-consecutive, fridge-life constrained)
- Re-proposer agent replacing all deterministic mutation handlers
- Proposal validator (hard gate)
- Planning-session mutations via the re-proposer

### What this enables for v0.0.5 (not shipping now)

- Mid-week plan adjustment (same re-proposer, post-confirmation entry point)
- Calorie absorption for unplanned meals (requires running budget tracking)
- Pre-restaurant guidance (separate sub-agent)

## Current experience

### Batch rigidity

The product models batches as calendar structures — "this recipe on these consecutive days." A batch of 3 must occupy 3 adjacent days. A birthday BBQ on Thursday splits the batch. An event in the middle creates orphans. This false assumption:

- **Constrains the proposer** — it must find consecutive free days, forcing smaller batches and more cook sessions
- **Breaks mutations** — moving a flex meal into a batch's range triggers orphan cascades, dead-end recipe gap flows, and abandoned sessions
- **Prevents adaptation** — the re-arranger can't span food over events because the model says it's impossible

### Mutation fragility

The user says "move flex to Sunday." The system treats this as removing Sunday from a batch. `removeBatchDay()` splits the remaining days. `resolveOrphanPool()` tries to pool fragments. `resolveSingletonOrphan()` can't extend an adjacent batch. The user gets dumped into a dead-end flow asking them to pick a recipe for a 1-serving orphan.

A trivial request ("put flex on Sunday") broke the entire plan.

### No post-confirmation adjustment (v0.0.5 motivation)

Once the plan is confirmed, it's frozen. The user's only option is to start a new planning session — losing the current plan, the shopping they've already done, the food they've already cooked. The system has no concept of "life happened, adjust the remaining days." This proposal doesn't add post-confirmation mutations, but the architecture it introduces (agent + sidecar, flexible batches, re-proposer) is specifically designed so that v0.0.5 can add them by opening a new entry point to the same re-proposer.

## Proposed experience

### Core architecture: Agent + Deterministic Sidecar

| Layer | Responsibility | Nature |
|---|---|---|
| **Agent** (reasoning LLM) | Arrangement decisions — which meals on which days, how to adapt when life changes, food logistics reasoning | Judgment, flexible, context-aware |
| **Deterministic sidecar** | Calorie math, structural validation, recipe scaling | Mathematical, rule-based, hard constraints |

The agent proposes. The sidecar validates and calculates. The agent is never trusted with math. The sidecar is never trusted with judgment.

**What this replaces:** The current architecture uses LLM intent classification → deterministic mutation handlers (removeBatchDay, splitIntoContiguousRuns, resolveOrphanPool, etc.). This is structurally incapable of handling real-life adaptation. Intent classification is removed entirely. All deterministic mutation handlers are removed. They are replaced by a single re-proposer agent call.

### The batch model

A batch is a physical quantity of food:

- **N servings** of one recipe (1-3 preferred; 1 allowed only when no multi-serving arrangement fits; 4+ not allowed — food boredom causes cravings and rebounds)
- **Cooked on the first eating day**
- **Eating days** = available slots within a fridge-life window from the cook day. Not necessarily consecutive. Events and flex in the middle are fine — they're days you eat something else.
- **The batch is done when all servings are consumed.** Not when a calendar window expires.
- **Fridge life is a hard wall:** span (last eating day minus cook day in calendar days) must be ≤ `recipe.storage.fridgeDays`. If an arrangement would exceed this, the agent must split into two batches or choose a different recipe. No exceptions.

No freezing mechanism. Backlogged — rare in practice (used once in weeks of manual meal prep), and the complexity isn't justified yet.

#### Why 2-3 servings stays firm (not 4)

Food boredom is psychologically worse than extra cooking. Eating the same meal for 4+ days — especially when a gap makes it feel like almost a week — causes cravings and rebounds. This directly violates the product's psychological sustainability principle.

### The re-proposer

The re-proposer is the single facility that keeps the plan alive when anything changes. It is a single structured-output LLM call (reasoning model) that receives the current plan + the user's natural language message and outputs a new arrangement.

Not a tool-using agent. Not a multi-step loop. Not an intent classifier. One call, structured output, deterministic validation.

#### Inputs

| Input | Source | Purpose |
|---|---|---|
| Current proposal (batches, flex slots, events) | Plan state | The current arrangement |
| Recipe DB | Recipe DB | Full recipe library for recipe selection + `fridgeDays` per recipe for fridge-life constraint |
| Pre-committed slots | Plan state | Carry-overs from prior session, immutable |
| User's message | Natural language (text or voice transcription) | What happened or what they want changed |
| Mutation history | Plan state (accumulated this session) | Prior user-approved changes, so the agent doesn't undo them |
| Week context | Calendar | Horizon dates, which days are past vs. future |

#### Output (one of two shapes)

1. **New arrangement:** A complete proposal — `batches` (ProposedBatch[]) + `flexSlots` (FlexSlot[]) + `events` (MealEvent[]) + `reasoning` (logged, not shown). Every slot is filled. No gaps. The same validator, solver, and display pipeline handles output from both the initial proposer and re-proposer.
2. **Clarification:** `question` string — when the agent can't confidently rearrange ("Did you mean lunch or dinner on Thursday?")

The clarification path is a safety valve, not the norm. Most mutations are unambiguous. When clarification is needed, the user answers, and the re-proposer is called again with more context.

**Always complete:** The proposer and re-proposer always output a complete plan with every slot filled. There is no "gap" concept — no holes, no separate gap-resolution flow. The full recipe DB is passed as summarized context in the prompt (the library is small enough — tens of recipes). The agent picks recipes from this context directly in a single call.

**Recipe generation via clarification:** When the user requests something the DB doesn't have ("I want Bolognese without meat"), the re-proposer uses the clarification output path: "I don't have a meatless Bolognese in the recipe library. Want me to create one?" The user approves → the orchestration layer generates the recipe (using the existing recipe generator) and persists it to the DB → the re-proposer runs again with the updated DB context → outputs a complete plan. Recipe generation is rare, explicit (user approves it), and happens as a separate orchestration step — the re-proposer itself stays a single structured-output call.

**Change summary:** The user-visible summary of what changed is generated deterministically by diffing the old and new proposals — not by the LLM. The LLM's `reasoning` is logged for debugging but never shown to the user. The diff-based summary is reliable: it compares batch assignments, flex slot positions, events, and recipes between old and new, and describes the actual structural changes.

#### Authority

**What the re-proposer CAN change:**
- Batch eating days (move, shift, rearrange within fridge-life constraints)
- Batch serving counts (within 1-3)
- Flex slot placement
- Cook days (derived — moves with first eating day)
- **Events:** add, remove, or modify events based on the user's message. Events are not rigid calendar entries — they're fuzzy, often unplanned, and sometimes retroactive. "Oh wait, I have dinner with friends Friday" → event added. "The BBQ got cancelled" → event removed. The re-proposer rearranges batches around the updated events.
- **Recipes:** when the user explicitly requests a recipe change ("I want lamb instead of chicken"), the re-proposer picks a matching recipe from the DB context. If no match exists, it uses the clarification path to ask about generating one.

**What the re-proposer CANNOT change:**
- **Pre-committed slots:** carried from prior session, fixed
- **Breakfast:** fixed
- **Total flex count:** stays at `config.planning.flexSlotsPerWeek`
- **Calorie targets:** the solver's domain, not the agent's
- **Recipes (without user intent):** the re-proposer should not swap recipes unless the user's message implies a recipe change. Rearranging batches in time is fine; silently replacing a recipe is not — the user may have already bought ingredients.

#### Mutation history

Each time the user approves a re-proposed plan, the mutation is appended: `{ constraint: "move flex to Sunday", appliedAt: "2026-04-09T..." }`. The full history is passed to the re-proposer so it knows which prior choices are load-bearing. On rollback (user rejects), nothing is appended.

**Lifecycle:** History is scoped to the planning session and clears when the plan is confirmed. This is correct for v0.0.4 where mutations only happen during planning. When v0.0.5 adds post-confirmation mutations, history will need to persist across confirmation boundaries — approved re-proposals become plan revisions with their own history.

#### Retry on validation failure

Same pattern as the initial proposer. If the validator rejects the output, the re-proposer retries with validation errors as feedback. Two failures → keep the prior valid plan, tell the user the change couldn't be applied cleanly, ask them to rephrase or adjust.

#### Relationship to proposePlan()

Separate facilities with different prompts but the same output contract (complete proposal — batches + flex slots + events as `MealEvent[]`). The initial proposer generates from scratch (recipe library, variety constraints, full week). The re-proposer adjusts an existing plan (current arrangement, user's change, mutation history). Same validator, same solver, same display — different input context. Both always produce complete plans with every slot filled.

**Events source of truth:** After the proposer/re-proposer returns, `proposal.events` becomes the canonical event set for solve, display, and confirm. Flow state mirrors it only as transport/UI state. There is no dual-state — the proposal is the single source of truth for the plan arrangement including events.

The initial proposer also changes in one way: its current deterministic orphan-fill post-processing (`fillOrphanSlots()`, which uses `restoreMealSlot()` and `computeUnexplainedOrphans()`) is removed. Instead, the new proposal validator catches uncovered slots and the LLM retries — same "agent proposes, sidecar validates" pattern as the re-proposer.

#### Flow

```
User message (text or voice transcription)
  → reProposePlan(currentPlan, message, mutationHistory, recipes, context)
  → LLM returns new PlanProposal or clarification
  → [if clarification: show question, wait for answer, call again]
  → validateProposal(proposal, recipeDb, horizon, preCommitted)
  → [if invalid: retry with errors, max 2]
  → solve(buildSolverInput(proposal))
  → generate deterministic change summary (diff old vs new proposal)
  → present updated plan + change summary
  → user confirms or adjusts further
```

### Friction model

**Happy path = zero friction.** When life goes according to plan (most days), the user's only interaction is checking what's next (A1). No confirmations, no "did you eat this?", no daily check-ins. Silence from the user means the plan is being followed. This is a planning-first product, not a tracker.

**Planning-session mutations = one message.** During planning, when the user wants to adjust the proposed plan, they send one natural language message. The re-proposer handles it. One message in, one updated plan out, one confirmation tap.

**Mid-week exception path (v0.0.5) = same pattern.** When life deviates post-confirmation, the user will send one message. The same re-proposer handles it. This doesn't ship now, but the friction model is identical — the architecture supports it without changes.

**Confirm everything (for now).** Every re-proposer output is presented for approval. One button press is cheap; a bad auto-adjustment that breaks the week is expensive. We earn the right to auto-adjust later by proving reliability.

**No explicit state tracking.** No "consumed / unconsumed / skipped" status per slot. The plan is the arrangement. When the user requests a change, the re-proposer produces a new arrangement. V0.0.5's mid-week mutations will need a minimal notion of actual deviations (flex budget spent, meals replaced) — that's scoped to v0.0.5's running budget tracking, not this proposal.

### Calorie absorption hierarchy (v0.0.5 design principle — not shipping now)

When v0.0.5 adds mid-week mutations and running budget tracking, the system will need to absorb the calorie impact of unplanned meals. The design principle established here:

1. **Flex meal budget absorbs first.** An unplanned restaurant IS a flex meal. The flex budget was designed for exactly this.
2. **Treat budget absorbs overflow.** If the restaurant meal exceeded the flex budget, the remaining calories come from the weekly treat budget.
3. **Accept the overshoot.** If flex + treats can't cover it, the week was slightly over. Reflect it next week. Do NOT squeeze remaining meals to compensate — that's the restrictive diet behavior the product fights.

This hierarchy requires knowing what has actually been consumed (running budget), which is v0.0.5 work. It's captured here as a product decision so v0.0.5 implementation doesn't need to re-derive it. For v0.0.4 (planning-session mutations), nothing has been consumed yet, so this doesn't apply.

### Proposal validator

A new deterministic function (`validateProposal()`) that acts as a hard gate between the agent and the user. Every arrangement must pass before reaching the solver or the user. Separate from the existing `validatePlan()` which operates on `SolverOutput` post-solver.

**Invariants:**

| Invariant | Rule |
|---|---|
| Slot coverage | Every day × meal type has exactly one source: batch, event, flex, or pre-committed slot |
| No overlap | No day × meal type claimed by two sources |
| Complete plan | No uncovered slots — every slot is filled (no gaps) |
| Eating days sorted | Ascending ISO order |
| Servings match | `servings === eatingDays.length` (accounting for `overflowDays` in pre-persist shape) |
| Servings range | `1 ≤ servings ≤ 3` (warn on 1-serving) |
| Cook day in horizon | `eatingDays[0]` within the plan's horizon |
| Fridge life respected | Span ≤ `recipe.storage.fridgeDays` |
| Flex count | Exactly `config.planning.flexSlotsPerWeek` flex slots |
| Pre-committed slots intact | Unchanged from input |
| Recipes exist | Every `recipeSlug` in the proposal references a recipe that exists in the DB (either pre-existing or just generated) |
| Event dates in horizon | Every event's `day` is within the plan's horizon |
| Event fields valid | Every event has a non-empty `name`, valid `mealTime` ('lunch' \| 'dinner'), and positive `estimatedCalories` |
| No duplicate events | No two events share the same `(day, mealTime)` pair |

**Failure handling:** First failure → retry with errors. Second failure → keep prior valid plan, ask user to rephrase. Invalid proposals never reach the user.

### Display

**Week overview** — unchanged. Already day-by-day, naturally handles non-consecutive batches.

**Day detail** — non-contiguous batch notation for cook days:

```
🔪 Dinner: **Moroccan Beef Tagine**
Cook 3 servings (Wed, Fri–Sat) · ~800 cal each
```

Reheat days show serving progress:

```
Dinner: Moroccan Beef Tagine
_Reheat · serving 2 of 3_
```

**Day range formatting** — non-contiguous formatter:
- `[Wed, Thu, Fri]` → "Wed–Fri" (unchanged for contiguous)
- `[Wed, Fri, Sat]` → "Wed, Fri–Sat"
- `[Mon, Wed, Fri]` → "Mon, Wed, Fri"

### Plan lifecycle

**v0.0.4 (this proposal):**

```
Planning session
  → proposePlan() generates arrangement (validator gates output)
  → user reviews, adjusts via re-proposer (0 or more rounds)
  → user confirms → plan is live and static until week ends
  → week ends → next planning session
```

**v0.0.5 (enabled by this architecture, not shipping now):**

```
Plan is live and adaptive
  → happy path: user follows plan, zero interaction
  → exception: user sends message → re-proposer adjusts → user confirms
  → week ends → next planning session
```

## Design decisions

### Why the re-proposer replaces all deterministic mutation handlers

Deterministic mutation handlers (removeBatchDay, splitIntoContiguousRuns, resolveOrphanPool) are the root cause of the dead-end flows. Every edge case spawns more handlers, which spawn more edge cases. A reasoning LLM handles the long tail naturally because it understands real-life food logistics. The codebase gets smaller, not bigger.

### Why intent classification is removed

Intent classification was an artifact of the deterministic handler architecture — each handler needed a typed input. With a single re-proposer that takes natural language, there's nothing to classify. The user talks to the agent. The agent figures it out.

### Why confirm everything (for now)

Auto-adjusting small changes is nicer UX but risky until we trust the re-proposer's reliability. One confirmation tap is cheap friction. A bad auto-adjustment that messes up the user's week is expensive. We earn auto-adjustment by proving the re-proposer works in 99% of cases.

### Why the gap resolution flow is removed

The gap flow (proposer leaves holes → per-recipe approval → generation → review → repeat) was high friction and unnecessary. The agent should always produce a complete plan by picking from the recipe DB context. If the user wants something the DB doesn't have, the agent asks via clarification, the orchestration generates the recipe, and the agent runs again. This is one extra interaction in a rare case — far simpler than the multi-step gap resolution flow. If the user doesn't like a recipe choice, they say so — same re-proposer flow as any other adjustment.

### Why events are part of the re-proposer output

Events are not rigid calendar entries. They're fuzzy, often unplanned, and sometimes retroactive. A multi-hour meetup with snacks, an unplanned restaurant, a cancelled BBQ — events are part of real life, and adjusting them is no different from adjusting any other part of the plan. Treating events as immutable external inputs that require a separate flow to modify adds friction and doesn't match how real life works. The re-proposer handles events like everything else: user says what happened, agent rearranges, user confirms.

### Why mutation authority is enforced by the user, not the validator

The re-proposer should not silently swap recipes or alter events the user didn't ask about. But enforcing this deterministically (e.g., a `mayChangeRecipes` flag checked against the diff) would reintroduce intent classification — we'd need to parse the user's message to determine which categories of change are allowed.

Instead, the deterministic change summary is the enforcement mechanism. It diffs old vs. new proposal and shows exactly what changed: "Moved tagine to Thu-Sat. Added event: dinner with friends Friday." The user sees every change before confirming. If the re-proposer made an unwanted change, the user says so — that feedback goes into mutation history and the re-proposer adjusts.

This works because we confirm everything. When v0.0.5 adds auto-confirm for small changes, a formal mutation envelope (flags checked by the validator) becomes relevant — at that point we need to define "small change" without user review.

### What stays deterministic

The solver (calorie math, uniform distribution, budget allocation), recipe scaling (hit calorie targets), and the proposal validator (invariant checking) stay deterministic. The line is: **the LLM proposes, deterministic systems validate and calculate.** The LLM is not trusted with math. It's trusted with arrangement judgment.

### Why no freezing mechanism (for now)

Freezing adds significant complexity (storage plans, defrost scheduling, validator rules) for a scenario that occurs rarely in practice. In weeks of manual meal prep, the user froze food once. Fridge life as a hard wall is simpler and sufficient. Freezing is backlogged.

## What changes (high level)

**Removed:**
- Intent classification system and all intent types
- All deterministic mutation handlers: `removeBatchDay()`, `splitIntoContiguousRuns()`, `resolveOrphanPool()`, `resolveSingletonOrphan()`, `absorbFreedDay()`
- `restoreMealSlot()` in event_remove handler
- The entire orphan concept — including `fillOrphanSlots()` and `computeUnexplainedOrphans()` in the initial proposer. The new validator catches uncovered slots and the LLM retries, replacing deterministic patch-up in both the initial proposer and mutation paths.
- The gap resolution flow (`recipe_suggestion`, `awaiting_recipe_prefs`, `generating_recipe`, `reviewing_recipe` phases). Recipe selection and generation are now internal to the agent — it always produces a complete plan.
- `RecipeGap` type and `recipesToGenerate` from `PlanProposal`

**New:**
- `reProposePlan()` — re-proposer agent (new LLM call, own prompt, structured output)
- `validateProposal()` — hard-gate proposal validator
- DB migration: widen `batches.servings` constraint to allow 1-serving batches
- `mutationHistory` field on plan flow state
- Non-contiguous day-range formatter
- Deterministic change summary generator (diffs old vs new proposal to describe what changed)

**Modified:**
- Initial proposer (`proposePlan()`): gains `fridgeDays` in recipe context for fridge-life awareness. Deterministic orphan fill (`fillOrphanSlots()`) is removed — replaced by the new proposal validator + LLM retry. Same "agent proposes, sidecar validates" pattern as the re-proposer. Now always produces a complete plan (picks from DB context; uses clarification path if generation is needed).
- `PlanProposal` type: becomes `batches` + `flexSlots` + `events`. No more `recipesToGenerate`.
- All mutation paths collapse into: user message → `reProposePlan()` → validate → solve → present → confirm
- Event mutations (add/remove/modify) handled by the re-proposer directly — no separate event flow during adjustments
- `event_remove` routed through re-proposer

**Unchanged:**
- Solver — deterministic budget allocation
- Recipe scaler
- Draft/confirm pattern
- Shopping list generation
- Cook-time recipe display

## Edge cases

### Batch spans beyond fridge life after rearrangement

The re-proposer respects `recipe.storage.fridgeDays` as a hard constraint. If a rearrangement would push a batch beyond fridge life, the agent splits into two batches or finds a different arrangement. The validator enforces this — the agent cannot produce an invalid span.

### Moving flex creates no available days for a batch

The re-proposer rearranges the full plan around the new constraint. It may change which recipe goes where, shift other batches, or pick a different recipe from the DB. The output is always a complete plan. The user sees the updated plan and can adjust further.

### 1-serving batch

Allowed but discouraged. The re-proposer should prefer extending an adjacent batch or rearranging to avoid it. Valid when no multi-serving arrangement fits (e.g., a single uncovered day between two events). The validator passes it but logs a warning.

### User's message is ambiguous

The re-proposer returns a clarification question instead of guessing. User answers, second call with more context. Two-round-trip ceiling — if still ambiguous after one clarification, the re-proposer makes its best judgment and presents for confirmation.

### Batch's cook day changes after a mutation

If the re-proposer moves eating days such that the first eating day changes, the cook day changes too. Shopping list updates accordingly. The user sees the new cook day in the updated plan.

### User requests a recipe the DB doesn't have

User says "I want Bolognese without meat." The re-proposer checks the recipe summaries in its context — nothing matches. Instead of guessing, it returns a clarification: "I don't have a meatless Bolognese. Want me to create one?" User says yes → orchestration generates the recipe using the existing recipe generator → persists to DB → re-proposer runs again with updated context → outputs a complete plan including the new recipe. One extra interaction, but only when the DB genuinely lacks what the user wants.

### User adds/removes an event during planning session

User says "oh wait, I also have dinner with friends on Friday." The re-proposer adds the event and rearranges batches around it. Same flow as any other adjustment — complete plan out, user confirms. No need to bounce back to the event collection phase.

### Re-proposer can't satisfy the constraint

Two validation failures → keep the prior valid plan, tell the user the change couldn't be applied cleanly, ask them to rephrase or try a different adjustment. The user's last-confirmed plan is never lost.

## Out of scope

- **Freezing / storage plans** — backlogged, rare in practice
- **Mid-week mutations** — v0.0.5. The architecture supports it (same re-proposer, different entry point), but the entry point isn't built yet.
- **Pre-restaurant guidance** — v0.0.5. This is a separate sub-agent (menu analysis, calorie estimation, ordering advice). Its output feeds back into the re-proposer for mid-week plan adjustment.
- **Running budget tracking** — v0.0.5. The calorie absorption hierarchy (flex → treats → accept) requires tracking what was actually consumed vs. planned.
- **Conversational event collection** — v0.0.5. Replace phased event flow with natural language ("here's my week").
- **Auto-confirming small adjustments** — after the re-proposer proves reliable at ~99% accuracy.

## Connection to v0.0.5

| Capability | v0.0.4 (this proposal) | v0.0.5 |
|---|---|---|
| Architecture | Agent + deterministic sidecar | Same |
| Batch model | Flexible (serving-count + fridge-life, no freezing) | Add freezing if needed |
| Plan mutations | Re-proposer via planning session | Re-proposer from anywhere (voice/text), mid-week |
| Mutation UI | Confirm everything | Auto-confirm small changes once trust is earned |
| Pre-restaurant guidance | Out of scope | Separate sub-agent, output feeds re-proposer |
| Running budget | Out of scope (design principle captured in this doc) | Flex → treats → accept absorption hierarchy |
| Event collection | Current phased flow | Conversational |
| Intent classification | Removed | Stays removed — agent handles natural language |

**Nothing built now gets thrown away.** The re-proposer becomes the core of v0.0.5's plan agent. The validator stays. The flexible batch model stays. The "confirm everything" pattern relaxes once trust is established. The v0.0.4 → v0.0.5 transition is additive, not rewrite.
