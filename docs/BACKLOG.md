# Backlog

> Scope: What the current version delivers, what's out of scope, and the versioned feature roadmap. See also: [product-specs/](./product-specs/) for what IS built, [PRODUCT_SENSE.md](./PRODUCT_SENSE.md) for the vision, [jtbd.md](./product-specs/jtbd.md) for user jobs, [ui-architecture.md](./product-specs/ui-architecture.md) for the UI surface area.

## Current version: v0.0.5

### What v0.0.5 delivers

**Freeform conversation layer (Plans 026–030 — landed):**
- Dispatcher front door: single reasoning LLM call routes all inbound text/voice to the right action. Button taps bypass it unchanged.
- 13-action catalog: `flow_input`, `return_to_flow`, `clarify`, `out_of_scope`, `answer_plan_question`, `answer_recipe_question`, `answer_domain_question`, `show_plan`, `show_recipe`, `show_shopping_list`, `log_measurement`, `navigate_back`, `mutate_plan`. `log_treat` and `log_eating_out` are architecturally committed in the catalog but handlers deferred to v0.0.6.
- Navigation state model: `LastRenderedView` tracks current surface for state-preserving side questions and natural-language "back to X" navigation.
- Post-confirmation plan mutations: confirmed plan routes to the same re-proposer as planning-session mutations. Data model adapter converts persisted `PlanSession + Batch[]` to in-memory `PlanProposal`; round-trip via `confirmPlanSessionReplacing` preserves past-slot batches. Mutation history persisted across sessions.
- Secondary action handlers: recipe/plan/domain Q&A, recipe and plan view navigation, shopping list with day/week/recipe scope, measurement logging.
- Re-proposer rules extended: meal-type lanes (never crossed by mutations), near-future soft-lock (next ~2 days), mutation history context.
- 29 new dispatcher + mutation scenarios (037–065) added to the harness.

**Planning and mutation architecture (Plans 024–025 — v0.0.4):**
- Flexible batch model: non-consecutive eating days, fridge-life as the hard constraint
- Proposal validator (13 invariants) — pre-solver gate with LLM retry on failure
- Re-proposer agent: single LLM call replaces all deterministic mutation handlers
- Change summary generator (deterministic diff) shows what moved after each mutation
- Recipe generation handshake: user asks for a recipe → re-proposer offers to create it → generated, persisted, placed in plan
- Rolling 7-day horizons with pre-committed carry-over slots

**UI/UX overhaul (JTBD-informed):**
- Plan view surfaces: Next Action, Week Overview, Day Detail, Cook view
- Post-confirmation bridge (first cook day + shopping surface)
- State-sensitive main menu ([Plan Week] / [Resume Plan] / [My Plan])
- Cook-time recipe view with batch totals, inlined ingredient amounts, timings, storage instructions
- Recipe library with "Cooking Soon" section tied to upcoming cook days
- Three-tier shopping list (never-show basics / pantry check / main buy list), scoped to next cook day
- Progress screen: weight/waist logging, weekly report with tone-adaptive copy, replayable last report

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

### v0.0.6 — Deviation accounting and self-care

The product understands when real life diverges from the plan and responds proportionally. Items listed roughly in priority order.

- **Treat tracking** (`log_treat` handler): "had a small Snickers" → calorie estimate + running treat budget update + remaining-budget reply. Catalog entry exists; handler deferred from v0.0.5.
- **Eating-out tracking** (`log_eating_out`): restaurant/social-meal reporting with automatic batch shift and calorie absorption (flex → treats → accept hierarchy). Retroactive support ("last night I went to Indian"). Depends on running-budget landing first.
- **Running budget (actual vs. planned)**: per-day actual state that drifts from the plan as the user reports deviations. Foundation for both logging actions above.
- **Three-tier deviation response**: silent <300 cal / informational 300–800 cal / replan offer 800+ cal.
- **Treats visibility**: surface the protected treat budget on plan / progress / next-action views. Display only.
- **Flex meal guidance**: slot-driven helper — "tomorrow is a flex day, help me spend the calories".
- **Shopping list polish**: breakfast weekly-stock model (stop resurfacing eggs/oats every refresh); filter by meal type; unit semantics for countable items (eggs in counts); ingredient consolidation across spelling variants; name normalization; category bugs (olive oil in two groups, avocado in Fats).
- **Recipe density bias**: generator prompt fix — prefer calorie-dense fats over 1 kg of tuna salad.
- **Breakfast variety + selection**: user picks the week's breakfast before confirming; rotate 2–3 learned options across weeks.
- **Restaurant preparation**: event-driven helper — "I'm going to an Italian place tonight, what should I order?"
- **Recipe rotation**: avoid repeating recipes too soon.
- **Planning nudge**: single non-nagging notification 1–2 days before plan ends.
- **Week-end review**: brief, non-judgmental weekly summary.
- **Messaging overhaul**: treats stance, method education, light-touch tone.

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
- **Flex meal education**: In-product explanation of what flex meals are, why they exist, and how to use them.
- **User preferences**: Stored dietary/cuisine/ingredient preferences.
- **Multi-user state**: Supabase schema supports multiple users.
- **Persistent session state**: Flow state currently lives in-memory — a bot restart drops in-progress conversations. Serialize per-chat flow state to disk, rehydrate on startup.
- **Supabase persistence parity tests**: Direct coverage for store query shapes and write ordering. Deferred until multi-user because single-user doesn't earn the cost.
- **Alternative UI**: Web UI or mobile app if there's traction.

### Follow-ups from Plan 033 (emergency ingredient swap)

- **PRODUCT_SENSE "bot has no location" principle**: the emergency-swap proposal calls out that the bot never asserts or infers the user's physical location (kitchen vs store vs car) — the surface the user is on is the only signal. Promoting this into `docs/PRODUCT_SENSE.md` as a named principle was deferred out of Plan 033's scope; do it when the next touch on PRODUCT_SENSE happens.
