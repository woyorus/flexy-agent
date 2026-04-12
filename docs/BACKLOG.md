# Backlog

> Scope: What the current version delivers, what's out of scope, and the versioned feature roadmap. See also: [product-specs/](./product-specs/) for what IS built, [PRODUCT_SENSE.md](./PRODUCT_SENSE.md) for the vision, [jtbd.md](./product-specs/jtbd.md) for user jobs, [ui-architecture.md](./product-specs/ui-architecture.md) for the UI surface area.

## Current version: v0.0.4

### What v0.0.4 delivers

**Planning and mutation architecture (Plans 024 + 025 — landed):**
- Flexible batch model: non-consecutive eating days, fridge-life as the hard constraint (not calendar consecutiveness)
- Proposal validator (13 invariants) — pre-solver gate with LLM retry on failure
- Re-proposer agent: single LLM call replaces all deterministic mutation handlers (flex_move, recipe_swap, event add/remove). Users type adjustments directly in the proposal phase
- Change summary generator (deterministic diff) shows the user what moved after each mutation
- Recipe generation handshake: user asks for a recipe not in the DB → re-proposer offers to create it → recipe generated, persisted, placed in the plan
- Mutation history per planning session
- Rolling 7-day horizons with pre-committed carry-over slots from prior sessions

**UI/UX overhaul (JTBD-informed):**
- Plan view surfaces: Next Action, Week Overview, Day Detail, Cook view
- Post-confirmation bridge (first cook day + shopping surface)
- State-sensitive main menu ([Plan Week] / [Resume Plan] / [My Plan])
- Cook-time recipe view with batch totals, inlined ingredient amounts, explicit timings, storage instructions
- Recipe library with "Cooking Soon" section tied to upcoming cook days
- Three-tier shopping list (never-show basics, check-you-have pantry items, main buy list), scoped to next cook day
- Progress screen: weight/waist logging, weekly report with tone-adaptive copy, replayable last report
- Copy and messaging quality pass across all surfaces

**Agent harness and base capabilities:**
- Guided weekly planning session via Telegram (suggestive-first)
- Budget solver with protected treat budget upfront, uniform per-slot targets
- Plan-proposer sub-agent with variety engine
- Recipe database (markdown files) with CRUD via Telegram
- Recipe generation with multi-turn refinement and macro correction loop
- Recipe scaling to solver targets at approval time
- Voice input via Whisper for all free-form inputs
- Scenario test harness with fixture-replayed LLM calls + recipe sandbox isolation
- Debug logging system (full AI call traces, flow state transitions)

## Roadmap

### v0.0.5 — The plan survives real life

v0.0.4 proved the architecture: a reasoning LLM handles plan arrangement and mutations, deterministic code handles math and validation. v0.0.5 extends this agentic loop across the entire product lifecycle so the plan keeps adapting after confirmation — not just during planning.

The re-proposer already exists and works. v0.0.5 opens new entry points to it via a freeform conversation layer that routes any inbound text or voice message to the right capability. The post-confirmation entry point is the load-bearing feature — it's what turns the confirmed plan into a living document.

Authoritative design: **[`design-docs/proposals/003-freeform-conversation-layer.md`](./design-docs/proposals/003-freeform-conversation-layer.md)** (status: approved). Architectural foundation: [`design-docs/002-plans-that-survive-real-life.md`](./design-docs/002-plans-that-survive-real-life.md).

**Freeform conversation layer (the entry-point mechanism)**:

A single reasoning LLM call sits as the front door for all inbound text and voice. It picks one action from a 13-action catalog spanning flow passthrough, read-only Q&A (plan / recipe / domain), navigation (recipe view, plan view, shopping list, progress, natural-language "back to X"), plan mutation, freeform measurement logging, clarification, and honest out-of-scope decline. Two additional actions (`log_treat`, `log_eating_out`) are architecturally committed in the catalog but deferred from v0.0.5 implementation — see "Deferred from v0.0.5 scope" below.

Button taps bypass the dispatcher (unchanged). Voice messages reuse the existing Whisper → text path.

Proposal 003 specifies the full design: context hydration, state-preservation invariants, navigation state model extensions, confirmation model by action class, the cross-doc supersession of `ui-architecture.md § Freeform conversation layer`, and an implementation-planning appendix with a 5-plan decomposition (A→E) organized for agent context clarity and isolated testability.

**Post-confirmation plan mutations** (the v0.0.5 headline capability):

Once a plan is confirmed, mid-week adjustments route to the **same re-proposer** that handles planning-session mutations. The entry point changes; the agent is identical. The work splits across three layers per proposal 003:

- **Data model adapter** that converts a persisted `PlanSession + Batch[]` into the in-memory `PlanProposal` shape the re-proposer understands, split at the **(date, mealType)** level so today's already-eaten lunch stays frozen while tonight's dinner is still active (server-local wall-clock cutoffs). Round-trip back via `confirmPlanSessionReplacing` (save-before-destroy), preserving past-slot batches verbatim so `formatWeekOverview` and `formatNextAction` still render the full session horizon after the write.
- **Mutation history persistence** via a new `mutation_history` JSON column on `plan_sessions`. The current in-memory shape `{ constraint, appliedAt }` gets carried across save-before-destroy writes so post-confirmation mutations accumulate history instead of losing it on every revision.
- **New re-proposer rules** added to the prompt AND the proposal validator: meal-type lanes (`batch.mealType ∈ recipe.mealTypes`, never crossed by mutations) and near-future safety (next ~2 days soft-locked unless the user's request explicitly targets them).

Example mutations this unlocks:
- "I got invited to dinner Friday" → re-proposer adds the event, shifts affected dinner batches forward in the dinner lane
- "I don't have salmon, use chicken" → re-proposer swaps the recipe on the affected batch
- "Move flex to Sunday" → re-proposer rearranges slots around the moved flex

**Test coverage expansion**:

Solver + plan validator unit tests, recipe scaling + shopping list unit tests, recipe flow scenarios, voice smoke-test scenario, plus the adapter round-trip tests and post-confirmation mutation scenarios specified by proposal 003's implementation-planning appendix. Scheduled here because the freeform layer and the adapter exercise this code fresh.

**Deferred from v0.0.5 scope** (belong to a future "deviation accounting" body of work, requires its own proposal → plan cycle):

The items below were listed in the original v0.0.5 scope but are NOT delivered by proposal 003. Most share a common dependency — a running-budget / actual-vs-planned state model — that's big enough to deserve its own design pass.

- **Running budget (actual vs. planned)**: a per-day actual state that drifts from the plan as the user reports deviations. Foundation for the logging actions below. **Moved to v0.0.6** (see "Treats tracking").
- **Treat tracking** (`log_treat` handler): "Had a small Snickers" → calorie estimate + running treat budget update + remaining-budget reply. Architecturally committed in proposal 003's catalog but handler not built in v0.0.5. **Moved to v0.0.6.**
- **Eating-out tracking** (`log_eating_out` compound handler): restaurant/social-meal reporting with automatic batch shift and calorie absorption (flex → treats → accept hierarchy). Includes retroactive support ("last night I went to Indian"). Architecturally committed in proposal 003's catalog but handler not built in v0.0.5. Remains deferred — depends on running-budget landing in v0.0.6 first.
- **Three-tier deviation response** (silent <300 cal / informational 300-800 cal / replan offer 800+ cal). Depends on running-budget state. Remains deferred.
- **Cook-time ingredient adjustment** ("I have 500g of beef, not 440g" → rescale the recipe): ingredient-level plan recipe updates. Explicitly out of scope per proposal 003 — it's a capability extension of the re-proposer scoped separately.
- **Contextual quick-fix suggestions** (LLM-generated quick-fix buttons prioritized for the current plan state). Builds on top of the dispatcher but is its own design work and not specified in proposal 003.
- **`answer_product_question` action** (answers about product concepts and methodology like "what's a flex meal?") with a small opinionated knowledge base. Proposal 003 routes such questions through `out_of_scope` in v0.0.5.

**What stays deferred to later versions:**
- Proactive nudges (v0.0.6)
- Flex meal guidance / restaurant preparation (v0.0.6)
- Meal composition rework — add-ons, smaller plates, fruits (v0.0.7)
- Photo tracking (v0.0.8)

### v0.0.6 — Proactivity and polish

The product reaches out at the right moments. Daily-friction items from v0.0.4 self-use get fixed. Items listed roughly in priority order.

- **Treats visibility**: surface the protected treat budget on plan / progress / next-action views. Display only, no logging.
- **Flex meal guidance**: slot-driven helper — "tomorrow is a flex day, help me spend the calories". Distinct from restaurant preparation.
- **Shopping list polish**:
  - Breakfast weekly-stock model — stop resurfacing eggs/oats every refresh; breakfast is a weekly buy, not per-cook-day.
  - Filter by meal type (breakfast / lunch / dinner slices).
  - Unit semantics for countable items (eggs in counts, not grams).
  - Ingredient consolidation across spelling variants.
  - Name normalization (strip qualifiers, parentheticals).
  - Category bugs — olive oil in two groups, avocado in Fats, etc.
- **Recipe density bias**: generator prompt fix — prefer calorie-dense fats over 1 kg of tuna salad. Short-term patch ahead of v0.0.7 meal composition rework.
- **Breakfast variety + selection**: user picks the week's breakfast before confirming; rotate 2-3 learned options across weeks.
- **Restaurant preparation**: event-driven helper — "I'm going to an Italian place tonight, what should I order?"
- **Treats tracking** (`log_treat`): "had a small Snickers" → budget update. Pulled from v0.0.5 deferred. Depends on running-budget state model landing first.
- **Recipe rotation**: avoid repeating recipes too soon.
- **Planning nudge**: single non-nagging notification 1-2 days before plan ends.
- **Week-end review**: brief, non-judgmental weekly summary.
- **Messaging overhaul**: treats stance, method education, light-touch.

### v0.0.7 — The plate you actually want to eat

A meal stops being "one recipe, one plate". Food volume drops, nutrition variety rises. Architectural rework — needs its own design proposal before planning.

- **Meal composition rework**: main + side/fruit/snack instead of one 800 kcal tuna salad. Smaller plates, fruit in the rotation, less volume for the same calories.
- **Recipe schema extension** to describe add-ons / components.
- **Solver multi-component awareness**: budget split across main + add-ons within a slot.
- **Cook view, shopping list, recipe library** updates to reflect the new shape.

### v0.0.8 — Intelligence

The product gets smarter about the user's patterns and available ingredients.

- **Photo tracking**: Snap a meal photo, vision model estimates calories.
- **Ingredient-aware suggestions**: "I have zucchini and peppers to use up."
- **Recipe import**: Send a URL, photo, or text of a recipe. Agent parses and structures it.
- **Pattern learning**: Agent notices trends and adjusts planning defaults.
- **Carry-over logic**: Smart surplus/deficit handling between weeks.

### v0.1.0 — Multi-user readiness

The product works for more than one person.

- **Onboarding flow**: Calculate personalized targets from user data.
- **Flex meal education**: In-product explanation of what flex meals are, why they exist, and how to use them. New users need this — the single-user prototype doesn't.
- **User preferences**: Stored dietary/cuisine/ingredient preferences.
- **Multi-user state**: Supabase schema supports multiple users.
- **Persistent session state**: Flow state currently lives in-memory — a bot restart drops in-progress conversations. Serialize per-chat flow state to disk, rehydrate on startup.
- **Supabase persistence parity tests**: Direct coverage for store query shapes and write ordering. Deferred until multi-user because single-user doesn't earn the cost.
- **Alternative UI**: Web UI or mobile app if there's traction.
