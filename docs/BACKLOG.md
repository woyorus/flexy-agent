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
- Restaurant meal estimation
- Voice input via Whisper for all free-form inputs
- Scenario test harness with fixture-replayed LLM calls + recipe sandbox isolation
- Debug logging system (full AI call traces, flow state transitions)

## Roadmap

### v0.0.5 — The plan survives real life

v0.0.4 proved the architecture: a reasoning LLM handles plan arrangement and mutations, deterministic code handles math and validation. v0.0.5 extends this agentic loop across the entire product lifecycle so the plan keeps adapting after confirmation — not just during planning.

The re-proposer already exists and works. v0.0.5 is about opening new entry points to it, wiring a freeform conversation layer to route any inbound message to the right agent, and adding the state tracking (running budget, actual vs. planned) that makes mid-week adaptation meaningful. See design-docs/002-plans-that-survive-real-life.md for the architectural foundation.

**Freeform conversation layer (new — prerequisite for everything else)**:

Every inbound message from any screen is classified by a thin router agent. The router has two jobs: (1) decide which downstream handler owns the message, (2) preserve enough context that handlers can respond without re-asking the user. No new flow phases, no modal "type your command now" screens — the user talks, the product routes.

Intents the router produces:
- **flow_input** — message belongs to the active flow (planning, recipe generation, progress logging). Routed to the existing flow handler. Current behavior.
- **mutation_request** — user wants to change something about their plan. Routed to the re-proposer (post-confirmation entry point, see below). "Move flex to Sunday", "Swap the tagine for fish", "I'm out for dinner Friday".
- **treat_report** — user ate something off-plan and wants it absorbed. Routed to the treat tracker. "Had a Snickers", "Grabbed a coffee and pastry".
- **contextual_question** — side conversation with plan/recipe context. Routed to a read-only Q&A agent. "Why is there so much pasta this week?", "How long does the tagine keep?" Answer, offer [← Back to plan].
- **domain_question** — general food/nutrition question. Routed to the Q&A agent with explicit "read-only, no plan changes" framing. "Is rice better than pasta for weight loss?" Answer briefly, don't moralize, return to context.
- **out_of_scope** — not a food/plan/progress topic. Polite decline with no attempt to be clever.

Domain answers are **read-only** — informational questions never mutate plan state. The Q&A agent has no write access. Every side-conversation response ends with a persistent [← Back to ...] button so users never feel trapped in a dead-end chat.

Voice input goes through the same router after Whisper transcription — no separate voice path.

See `ui-architecture.md` § Freeform conversation layer for copy and interaction patterns.

**Post-confirmation plan mutations** (the v0.0.5 motivation from design doc 002):

Once a plan is confirmed, mid-week adjustments route to the **same re-proposer** that handles planning-session mutations. No new agent. The entry point changes; the agent is identical.

- "I got invited to dinner Friday" → re-proposer adds the event, rearranges remaining batches around it
- "I don't have salmon, use chicken" → re-proposer swaps the recipe on the affected batch
- "The plan ends Tuesday, I want to extend through Thursday" → re-proposer extends the horizon

The re-proposer operates on the **remaining days** of the active plan — past days are frozen. Mutation history persists across the plan lifecycle (not cleared on confirm like planning-session mutations are today). Each confirmed mutation creates a plan revision; the original plan stays in history.

**Running budget (actual vs. planned)**:

The product needs to know what the user actually ate vs. what was planned. Today the plan is frozen truth. v0.0.5 adds a per-day actual state that starts matching the plan and drifts as the user reports deviations. Running budget = sum of (actual − planned) across past and current days.

- Treat tracker adds to actual
- Mutation acceptance updates both planned and actual for affected days
- Restaurant reporting (user says "I had Italian lunch ~850 cal") adds to actual
- Plan view surfaces the running delta when non-zero ("~150 cal over this week so far — still within budget")

**Treat tracking**:

One message in, one message out. "Had a small Snickers" → "Logged: ~245 cal. Treat budget remaining: ~608 cal (~1-2 more treats)." LLM estimates calories from description. Works via freeform text from any screen — no navigation required, the router handles it.

**Three-tier deviation response**:

Not every deviation needs a replan offer. The product matches response intensity to deviation size:
- **Silent (<300 cal)**: absorbed into running budget, no UI interruption
- **Informational (300-800 cal)**: gentle FYI in plan view next time user opens it
- **Replan offer (800+ cal)**: explicit "want me to rebalance the remaining days?" — routes through the re-proposer

**Cook-time ingredient adjustment**:

"I have 500g of beef, not 440g" → recipe rescales around real quantity. Anti-food-waste: the product adjusts math to what the user actually has, not the other way around. Small recipe-level mutation that doesn't require the re-proposer (no batch rearrangement, just macro rescaling).

**Contextual quick-fix suggestions**:

Now that mutations are accessible from anywhere, the plan view can show LLM-generated quick-fix buttons prioritized for the current plan state (e.g., "Move flex to Sunday", "Extend tagine to cover Wednesday"). Not generic static buttons — the re-proposer suggests options based on the current arrangement.

**Test coverage expansion**:

Solver + plan validator unit tests, recipe scaling + shopping list unit tests, recipe flow scenarios, voice smoke-test scenario. Scheduled here because tracking and freeform routing exercise this code fresh.

**What stays deferred to later versions:**
- Proactive nudges (v0.0.6)
- Restaurant preparation / menu scanning (v0.0.6)
- Photo tracking (v0.0.7)

### v0.0.6 — Proactivity and polish

The product reaches out at the right moments. Communication quality rises.

- **Planning nudge**: Single non-nagging notification 1-2 days before plan ends. "Your plan ends Sunday — want to plan next week?" One message, one button. Ignore = fine.
- **Restaurant preparation**: Planning-first guidance before ordering. Cuisine-based heuristics as minimum ("At an Italian restaurant with 1,200 cal budget: grilled fish or single-portion pasta"). Menu scanning (photo or pulled from Google Maps) as stretch.
- **Breakfast variety**: Rotate 2-3 learned recipes across weeks. Still "one per week, no thinking" — but different weeks get different breakfasts.
- **Recipe rotation**: Track when recipes were last used, avoid repeating too soon.
- **Week-end review**: Brief, non-judgmental summary of the week. Pairs with the weekly progress report.
- **Messaging overhaul**: Treats stance (hyper-palatable foods trigger compulsiveness — the product is opinionated, not neutral). Method education (why weekly budgets, why flex, why averages not daily numbers). Light-touch, contextual, not a lecture.

### v0.0.7 — Intelligence

The product gets smarter about the user's patterns and available ingredients.

- **Photo tracking**: Snap a meal photo, vision model estimates calories. Two taps.
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
