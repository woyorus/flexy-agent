# Backlog

> Scope: What the current version delivers, what's out of scope, and the versioned feature roadmap. See also: [product-specs/](./product-specs/) for what IS built, [PRODUCT_SENSE.md](./PRODUCT_SENSE.md) for the vision.

## Current version: v0.0.3

### What v0.0.3 delivers

- Guided weekly planning session via Telegram (suggestive-first — system proposes, user approves)
- Budget solver using real per-serving recipe macros (not uniform distribution)
- Flex budget system (flex slots + treat budget, replacing individual fun food items)
- Plan-proposer sub-agent with variety engine and flex slot suggestions
- Inline recipe gap resolution during planning (generate recipes for variety gaps mid-session)
- Recipe database (markdown files) with CRUD via Telegram
- Paginated recipe list UI with view/edit/delete
- Recipe generation with multi-turn refinement and QA correction loop
- Recipe scaling to hit solver targets
- Restaurant meal estimation
- Shopping list aggregated from weekly plan
- Budget view (read-only)
- Voice input via Whisper for all free-form inputs
- Structured recipe components (breakfast + lunch/dinner)
- Debug logging system (full AI call traces, flow state transitions)

### Explicitly out of scope (v0.0.3)

| Feature | Reason | Planned for |
|---|---|---|
| Freeform conversation (Q&A escape hatch from flows) | Needs intent classifier + context injection | v0.0.5 |
| Photo tracking | Needs vision model integration | v0.0.5 |
| Voice/text tracking | Needs running budget state | v0.0.5 |
| Running budget (planned vs actual) | Needs tracking first | v0.0.5 |
| Mid-week adjustment | Needs tracking + running budget | v0.0.5 |
| Cook-time ingredient adjustment | Needs daily plan view + running budget | v0.0.5 |
| Three-tier notifications | Needs tracking + adjustment | v0.0.5 |
| Messaging overhaul (voice, treats stance, usage guide, method education) | Polish, not blocking daily use | v0.0.6 |
| Proactive nudges | Needs scheduled messages | v0.0.6 |
| Breakfast variety | Nice-to-have, not core | v0.0.6 |
| Ingredient-aware suggestions | Needs ingredient inventory | v0.0.7 |
| Recipe import from URL/photo | Nice-to-have | v0.0.7 |
| User onboarding (macro calc) | Needed for multi-user | v0.1.0 |
| Multi-user support | Not needed for prototype | v0.1.0 |
| Alternative UI (web/app) | Telegram is sufficient for now | v0.1.0+ |

## Roadmap

### v0.0.4 — Production-ready for personal use (target: 2026-04-06)

The minimum required to start using the product daily from Monday 2026-04-06. Focus: the one UI surface needed to actually cook from the plan. Everything else is deferred — we find out what's broken by using it.

- **Plan view with scaled recipes**: The backend is mostly done — the solver produces a valid weekly plan and scaling logic exists. What's missing is the UI to *see* it. Need an overall view of the current week's plan where every meal's recipe is already scaled to its day's targets (quantities, macros, calories). The recipe library stays as-is (original unscaled templates); scaling is applied when reading from the plan. Open question: daily-first vs week-first framing — is it "what do I cook today" (drill into one day) or "here's the whole week, tap any meal"? Don't lock the name "daily plan view" in yet. This is the only real UX work left in v0.0.4 — the rest of the sprint has been backend. Design the shape when we build it tonight.
- **Known broken: shopping list button**: The current shopping list implementation is bare-bones and not usable at the store. For v0.0.4 we accept this as a known gap — the button is either disabled or clearly labeled as not yet working. With the plan view showing scaled recipes, the user can derive shopping from the week manually until the proper overhaul lands (v0.0.6).
- **Recipe parser/database unit tests (landed)**: Round-trip (parse → serialize → parse across all fixture recipes), malformed-file resilience (bad file in the directory must not kill `load()`), save/load/remove/overwrite against a real temp directory. Targeted at the data-loss class of silent failure on Monday morning. See `test/unit/recipes-parser.test.ts` and `test/unit/recipes-database.test.ts`.

**Explicitly not in v0.0.4 (found scope, cut on 2026-04-05 night):**

- *Bug fixes / stability as a planned bucket* — we don't know what's broken yet. Real-life use starts Monday; bugs get triaged as they surface, not pre-allocated.
- *Daily measurements (weight/waist tracking)* — important for progress tracking but not blocking daily cooking. No time tonight, and v0.0.5 is already packed with tracking/adjustment work. Moved to v0.0.6.
- *Shopping list overhaul* — same reason: no time, and the plan view covers the "I need to know what to buy" job manually. Moved to v0.0.6.

### v0.0.5 — Tracking, adjustment, and natural conversation

The system becomes dynamic and conversational. User reports what happened, agent rebalances. User asks questions, agent answers without derailing the flow.

- **Freeform conversation layer**: An LLM intent classifier on every inbound message determines whether the user is continuing the current flow or asking an off-flow question. Off-flow messages branch into a freeform conversation with context from the current flow state (e.g., the recipe being viewed, the day being planned). Multi-turn follow-ups are supported. When the side conversation ends, the user returns seamlessly to the flow they were in. The state machine stays deterministic — this is an escape hatch, not a replacement. We solve one specific problem (meal planning), not general chat, but the product must feel natural in a chat UI where users expect to be able to just ask things.
- **Photo tracking**: Snap a meal photo, vision model estimates calories. Two taps.
- **Voice/text tracking**: "Had carbonara at that Italian place." Agent extracts estimate.
- **Running budget**: Planned vs. actual, updated as tracking comes in.
- **Three-tier adjustment system**:
  - Silent (< 300 cal): Budget updates, no notification
  - Informational (300-800 cal): Gentle FYI with optional lever
  - Replan offer (800+ cal or budget-threatening drift): Explicit rebalance offer
- **Mid-week replanning**: When deviation is large, agent proposes minimal adjustments to remaining days.
- **Cook-time ingredient adjustment**: Real-world quantities don't match plan quantities — you can't buy exactly 440g of beef, you get 500g and don't want to waste 60g. At cook time, the user tells the system what they actually have ("I have 500g of beef, not 440g") and the recipe rescales around that real quantity. Protein overshoot is acceptable — compensate by trimming carbs or fats to stay close to calorie target. This applies mainly to indivisible ingredients (meat, fish) where cutting to exact grams is wasteful. Vegetables and measurable ingredients can be portioned precisely. The system should be anti-food-waste: use what you bought, adjust the math, don't throw food away.
- **Plan mutation architecture — fast/slow path refactor**: The v0.0.4 swap flow uses a nano classifier to route to deterministic handlers (flex_add, flex_remove, flex_move, recipe_swap). This is the correct foundation but has two problems that should be fixed in v0.0.5 while we're already rebuilding the conversation layer:
  1. **"Unclear" is a dead end.** Currently when the classifier can't match an intent, it asks the user to rephrase. That's a failure mode. It should fall back to a **slow path**: re-run the plan-proposer (mini, high reasoning) with the current plan as context and the user's free-text request as a mutation instruction. The proposer returns a new valid plan respecting all constraints.
  2. **Swap handlers duplicate proposer logic.** `flex_add` knows about `flexSlotsPerWeek`. `removeBatchDay` knows about the 2-3 serving rule. `absorbFreedDay` knows batch extension priorities. All of this logic already lives in the proposer prompt — we're rebuilding it inside mutation handlers, which means plan invariants live in two places and will drift.

  **Target architecture (cheap/expensive fast-path pattern):**
  ```
  User input
    ↓
  Nano classifier (cheap, ~$0.0001, ~1-2s)
    ├── matches simple intent → fast-path handler
    │     (handlers express intent as a CONSTRAINT DELTA, not direct mutation;
    │      delegate plan restructuring to the proposer so invariants live in one place)
    └── unclear / complex / multi-operation → slow path
          ↓
        Mini re-proposer with current plan as context (~$0.05, ~30-60s)
          Handles anything the user can express. No intent limit.
  ```

  **Why this matters:** The fast path is deterministic, cheap, and precise — right for the common case (single swap, single flex move). The slow path has no shape limit — right for complex, multi-operation, or unusual requests. Together they scale without an intent explosion. The product shape is "reliable structure + LLM-powered flexibility" — the code should mirror that shape.

  **Do NOT restructure in v0.0.4.** The current handlers work for shipping. This is a v0.0.5 refactor tied to the freeform conversation layer — they share the classifier layer and should be designed together.

  **Open questions for v0.0.5 design:**
  - How does the classifier distinguish "unclear" (→ slow path) from "off-flow question" (→ side conversation)? Are they the same branch?
  - Should simple intents ALSO delegate to the proposer (for invariant consolidation), or keep mutating directly (for speed)?
  - What does a "constraint delta" look like as a prompt input to the proposer? (e.g., `currentPlan + "the flex slot must be on Saturday dinner"`)
  - How do we handle retry/rejection when the slow-path proposer returns an invalid plan?
- **Test coverage expansion**: The v0.0.4 weekend sprint landed recipe parser/database tests. v0.0.5 fills the remaining scenario and unit gaps surfaced by the QA audit on 2026-04-05 — scheduled here because tracking, running-budget, and the fast/slow path refactor all exercise this code fresh, so tests written now cover old + new behavior in one pass:
  - **Solver + plan validator unit tests**: Direct coverage for `src/solver/solver.ts` (boundary cases: low-budget clamping, flex/event precedence, protein protection, cook-day ordering) and `src/qa/validators/plan.ts` (hard checks: orphan slots, calorie-cap breaches, missing batch references). Today they're only exercised indirectly through recorded scenarios, which is weak for boundary cases.
  - **Recipe scaling + shopping list unit tests**: The remaining deterministic cores mentioned in the v0.0.3 backlog carry-over — must not break silently when the scaler or list aggregator is touched.
  - **Recipe flow scenarios**: Scenario coverage for create / refine / ask-a-question / save / discard / edit-existing. This is the largest user-facing scenario gap but was deliberately deferred from v0.0.4 — batch it with the fast/slow path refactor in this version since both touch recipe-adjacent code paths.
  - **Voice smoke-test scenario**: One scenario exercising voice → transcription → routing into a flow (the harness supports `voice()` events but no scenario uses it). Covers the main voice path without needing to fake the adapter-level audio download.

### v0.0.6 — Polish and proactivity

- **Shopping list overhaul**: Proper ingredient aggregation, unit handling, and a clean Telegram UI for use at the store. Deferred from v0.0.4 — the plan view lets the user derive shopping manually until this lands, so it's a quality-of-life upgrade rather than a blocker.
- **Daily measurements**: Body weight and waist circumference tracking via Telegram. Store daily entries, display rolling averages to track progress over time. Deferred from v0.0.4 (no time in the weekend sprint) and skipped in v0.0.5 (already packed with tracking/adjustment work). Fits naturally alongside week-end review since both are about reflecting on what actually happened.
- **Messaging overhaul**: Rework the product's communication style and voice across all flows.
  - Clear stance on treats: hyper-palatable and ultra-processed foods trigger addictive behavior and compulsiveness. The product should be opinionated about this, not neutral.
  - Product usage guide: in-bot instructions on how to use the system (planning rhythm, what to expect, how measurements work).
  - Method education: learning materials about the approach — why weekly budgets, why flex slots exist, why we track averages not daily numbers. Help the user understand the "why" so they trust the system.
- **Planning nudge**: Agent sends one message when it's time to plan next week.
- **Breakfast variety**: Agent suggests different breakfasts based on recent history.
- **Recipe rotation**: Track when recipes were last used, avoid repeating too soon.
- **Week-end review**: Brief, non-judgmental summary of the week.

### v0.0.7 — Intelligence

- **Ingredient-aware suggestions**: "I have zucchini and peppers to use up."
- **Recipe import**: Send a URL, photo, or text of a recipe. Agent parses and structures it.
- **Pattern learning**: Agent notices trends and adjusts planning defaults.
- **Carry-over logic**: Smart surplus/deficit handling between weeks.

### v0.1.0 — Multi-user readiness

- **Onboarding flow**: Calculate personalized targets from user data.
- **User preferences**: Stored dietary/cuisine/ingredient preferences.
- **Multi-user state**: Supabase schema supports multiple users.
- **Persistent session state**: Flow state (`planFlow`, `recipeFlow` in `src/telegram/bot.ts`) currently lives in-memory — a bot restart silently drops any in-progress conversation, so pressing a button on a pre-restart message does nothing. For multi-user we need state to survive restarts. MVP approach: serialize per-chat flow state to a flat file on disk (JSON per chat), rehydrate on startup. No Redis, no schema migrations — just enough to not lose in-flight sessions.
- **Supabase persistence parity tests**: Direct coverage for `src/state/store.ts` query shape, upsert semantics, and `completeActivePlans()` error handling. Deferred until multi-user because a single-user tool pointed at one Supabase project doesn't earn the cost of a test DB or heavy mock infrastructure — but as soon as multiple users share the schema, adapter-level bugs become silent cross-user corruption and this becomes load-bearing. `test/unit/test-store.test.ts` explicitly tests the in-memory double, not parity against the real class.
- **Alternative UI**: Web UI or app if needed.
