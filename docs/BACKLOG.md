# Backlog

> Scope: What the current version delivers, what's out of scope, and the versioned feature roadmap. See also: [product-specs/](./product-specs/) for what IS built, [PRODUCT_SENSE.md](./PRODUCT_SENSE.md) for the vision, [jtbd.md](./product-specs/jtbd.md) for user jobs, [ui-architecture.md](./product-specs/ui-architecture.md) for the UI surface area.

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
- Shopping list aggregated from weekly plan (bare-bones, not usable at the store)
- Budget view (read-only)
- Voice input via Whisper for all free-form inputs
- Structured recipe components (breakfast + lunch/dinner)
- Debug logging system (full AI call traces, flow state transitions)
- Recipe parser/database unit tests (landed in v0.0.4 sprint)

## Roadmap

### v0.0.4 — UI/UX overhaul (JTBD-informed)

The backend engine works. The UI doesn't serve the real jobs. This version makes the product usable and pleasant for daily cooking, shopping, and progress tracking. Every screen and message traces back to a job in `jtbd.md`. Design decisions are documented in `ui-architecture.md`.

**Plan view** (serves A1: know my next action, A4: browse my week):
- **Next Action screen** — the primary surface. Today + next 2 days. Cook days marked with 🔪. Inline button to the next recipe and shopping list. Shows only near-horizon, not the full week.
- **Week Overview** — compact day-by-day list. Recipe names, cook/reheat/flex/event markers. "Weekly target: on track ✓" — no calorie dashboard. Drill into any day via day buttons.
- **Day Detail** — one day's meals with cook-or-reheat status, servings count, day range. Button to open recipe or shopping list for that cook session.
- **Post-confirmation bridge** — replaces the current dead-end "Plan locked" message. Immediately surfaces first cook day and shopping need.
- **State-sensitive main menu** — [Plan Week] when no plan, [Resume Plan] during planning, [My Plan] when active. Telegram reply keyboard updates dynamically.

**Cook-time recipe view** (serves A3: cook from the plan):
- Batch totals (not per-serving). Servings count at the top ("3 servings — divide into equal portions").
- Ingredient amounts inlined in steps via `{ingredient_name}` placeholders — "Cook `225g` penne, **10-11 min**." No more scrolling between ingredients and steps.
- Explicit cooking duration on every heat step. No "until golden" without a time anchor.
- Storage instructions at the bottom (fridge days, reheat method).
- Telegram markdown formatting: **bold** for headers/timings, `monospace` for amounts, _italic_ for secondary info.

**Recipe generation prompt updates**:
- **Short names** (~25 chars) for compact views, in addition to full names inside the recipe.
- **Ingredient placeholders** `{ingredient_name}` in recipe steps — renderer resolves to the correct amount based on context (cook-time batch totals vs. library per-serving).
- **Step-by-step timing** — every heat step must include a duration.
- **Grouped seasonings** — salt, pepper, and to-taste spices on one line, not as separate ingredients.
- **QA validation** — verify every `{placeholder}` in steps matches an ingredient `name` in the YAML frontmatter.

**Shopping list** (serves A2: build a shopping list):
- Renamed from "shopping list" to "needs list" framing: "What you'll need — long-press to copy, paste into Notes, then remove what you already have."
- Grouped by category (produce, fish, dairy, pantry). User maps categories to their own stores.
- Three-tier ingredient intelligence: never-show basics (salt, water), "check you have" section for long-lasting pantry items (spices, olive oil), main buy list for perishables.
- Scoped to next cook day + prorated breakfast for remaining plan days. Not full remaining week.
- Breakfast always included regardless of entry point.
- Plain text, copies cleanly.

**Recipe library** (plan-aware):
- "Cooking Soon" section at the top — only upcoming cook-day recipes, sorted by next cook date, 🔪 on each button.
- 🔪 recipes open cook view directly. Non-🔪 recipes open library view. One rule, no exceptions.
- "All Recipes" section below — alphabetical, full library, browse/edit/delete.

**Progress screen** (serves D2: see that what I'm doing is working):
- Replaces [Weekly Budget] with [Progress] in main menu. Narrowly scoped: weight/waist measurements + weekly report. NOT a general tracking destination.
- Input: one or two numbers in natural language ("82.3 / 91" or just "82.3"). Under 5 seconds.
- Daily response: "Logged ✓" — no mid-week averages, no comparisons.
- Weekly report: delivered end of week, shows weekly averages compared to last week. Tone adapts to scenario (steady loss, plateau, temporary gain). Last completed report replayable on request.
- Time-aware: afternoon prompt adds "If this is your morning weight, drop it here."
- Waist is optional, weight-only is first-class.

**Copy and messaging quality pass**:
- Telegram markdown formatting across all messages (bold, italic, monospace for hierarchy).
- No internal jargon in user-facing copy ("active plan", "template", "scaled", "batch target", "cook session").
- Calm, brief, action-oriented, non-judgmental tone. See `ui-architecture.md` § Copy and messaging tone.
- Graceful free-text fallback: lifecycle-aware examples, doesn't promise capabilities that don't exist yet.

**Explicitly not in v0.0.4:**

- *Freeform conversation layer* — full intent classification + side conversations. v0.0.4 has a graceful fallback; v0.0.5 has the real thing.
- *Treat tracking / running budget* — requires the freeform conversation layer to work well (free-text from anywhere). v0.0.5.
- *Mid-week plan mutations* — unplanned restaurants, ingredient substitutions. v0.0.5.
- *Bug fixes as a planned bucket* — real-life use surfaces what's broken; bugs are triaged as they appear.

### v0.0.5 — Adaptivity and dynamicity

The plan bends without breaking. The product becomes conversational. Real life stops being an edge case.

- **Freeform conversation layer**: Intent classifier on every inbound message: flow_input (existing behavior), contextual_question (side conversation with context), domain_question (food/nutrition, answered briefly and routed back). Domain answers are read-only — informational questions never mutate plan state. Out-of-scope questions declined honestly. Persistent [← Back to ...] button on every side-conversation response. See `ui-architecture.md` § Freeform conversation layer.
- **Treat tracking**: One message in, one message out. "Had a small Snickers" → "Logged: ~245 cal. Treat budget remaining: ~608 cal (~1-2 more treats)." Works via free-text from any screen — no need to navigate to a specific button. LLM estimates calories from description.
- **Running budget**: Planned vs. actual, updated as treat tracking and restaurant reporting come in. Shown in plan view after deviations, not in the Progress screen.
- **Mid-week plan mutations**: Unplanned restaurant → absorb calorie impact across remaining days. Missing ingredient at cook time → substitution or recipe swap. Adding these as natural conversation: "I don't have salmon" or "I got invited to dinner Friday."
- **Cook-time ingredient adjustment**: "I have 500g of beef, not 440g" → recipe rescales around real quantity. Anti-food-waste: use what you bought, adjust the math.
- **Plan mutation architecture — fast/slow path refactor**: Nano classifier routes to deterministic fast-path handlers for simple intents (flex move, recipe change). "Unclear" falls back to a slow path: re-proposer with current plan as context. Handlers express intent as constraint deltas, not direct mutations — plan invariants live in one place (the proposer). See current backlog for full design notes.
- **Three-tier adjustment system**: Silent (< 300 cal) → budget updates quietly. Informational (300-800 cal) → gentle FYI. Replan offer (800+ cal) → explicit rebalance proposal.
- **Test coverage expansion**: Solver + plan validator unit tests, recipe scaling + shopping list unit tests, recipe flow scenarios, voice smoke-test scenario. Scheduled here because tracking and fast/slow path refactor exercise this code fresh.

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
