# LLM-first text understanding — stop inventing NLP ourselves

> Status: draft
> Date: 2026-04-14
> JTBD: All jobs in `jtbd.md` that involve natural-language input — this is a cross-cutting architectural rule, not a single job. Most acutely: C1 (missing-ingredient at cook time), A3 (cook from the plan), B2 (real-life deviation), and every future feature that accepts text or voice.
> PRODUCT_SENSE alignment: "Low friction comes first." "The system should bend without breaking." "Planning not tracking." The rule this proposal codifies is the architectural shape of an LLM-native product: the LLM is our natural-language interface, not a fallback we reach for when regex fails. Also directly extends the existing `feedback_agentic_over_deterministic.md` auto-memory — that memory says "plan arrangement/mutations = LLM; only solver/scaling = deterministic." This proposal makes it binding across the codebase, not just for plan arrangement.

## Problem

We keep rebuilding NLP by hand and paying for it with brittle behavior, bugs the real LLM would never make, English-only code that blocks future internationalisation, and multi-hour regen-fix-regen cycles when a hardcoded phrase list mis-matches something a real user would type.

Plan 033 (emergency ingredient swap, 2026-04-14) shipped with ~12 product bugs discovered during scenario review, four of which traced directly to hand-rolled text matching:

1. `userMentions("ground beef", "no white wine, use beef stock instead")` returned `true` because "beef" was a substring of "beef stock". The guardrail then rejected legitimate swaps.
2. `userMentions("cod fillet", "got cod instead of the salmon")` returned `false` because "cod" was 3 chars and the token filter required ≥4. Real user, blocked.
3. `isBareReversalPhrase(text)` failed on slight paraphrases ("actually undo that last change") because the regex didn't list every variant.
4. `CONFIRM = /^\s*(go ahead|yes|do it|apply|sure|ok|okay|yep|yeah|confirm|please do|go for it)\s*\.?\s*$/i` — the hardcoded confirmation phrase list. Every `yess`, `sí`, `dale`, `let's go` that isn't on the list falls through to the dispatcher LLM which then re-interprets it from scratch, often incorrectly. This is English-only by construction and will need to be rebuilt from scratch for any non-English user.

The fix cycle for each of these was: see a failing scenario → inspect transcript → add more words to the list OR tweak the regex → regenerate 20+ scenarios (prompt changes invalidate fixture hashes broadly) → discover the fix introduced a different false positive → repeat. The LLM-based path would have handled these natively.

This is not the first time. The `feedback_agentic_over_deterministic.md` auto-memory exists precisely because a previous plan hit the same shape and we learned then that agentic > deterministic for plan arrangement. But the principle wasn't codified in product docs, wasn't part of CLAUDE.md, and wasn't enforced during code review — so we did it again in Plan 033, across a new surface (text intent, ingredient resolution, reversal phrase detection, confirmation classification).

The cost is not just a fixed 2 hours per occurrence. The hand-rolled NLP also:

- Encodes English as an architectural assumption into the codebase. A user typing in Spanish gets "I don't understand" for what should be a commonplace swap. We add a BACKLOG entry for i18n and it stays there, accreting scope, because "add i18n" now means "rebuild every regex list, including the ones nobody remembers exist."
- Turns documentation stale as the word lists drift. `NAME_MODIFIERS` has 17 entries today; tomorrow someone adds another ingredient variety and we don't know the list exists.
- Makes every scenario failure ambiguous: is it a real bug, or did my matcher miss a phrasing? During Plan 033 I spent much longer than necessary on this question because the answer kept turning out to be "matcher, not bug."
- Spreads across files. The swap applier, the guardrail validator, the pre-filter, and the dispatcher runner all ended up with their own flavour of word-based intent detection. Each one has its own word list, its own tokenizer, its own edge cases.

The deeper issue: we have an LLM that will read a user's message and report what it means, with what intent, against what entities in the plan, in any language the LLM speaks. Every regex-based intent matcher in this codebase is an assertion that we do not trust the LLM to do the thing the LLM is objectively best at. That assertion is wrong, and it is costing us features.

## Current experience

Coding agents (Claude Code, future contributors) look at a scenario failure. The reflex is:

1. "The dispatcher picked clarify. The user's message was unambiguous. Let me add a few-shot."
2. "The guardrail rejected a legitimate reversal. Let me widen the word list."
3. "The pre-filter missed 'yes, do that' — let me add it to the CONFIRM regex."

Each reflex adds another hardcoded branch. Then the prompt change invalidates 40 fixture recordings. The recordings regenerate, some new edge case surfaces, another word gets added, another regen wave. During Plan 033 this loop ran 11 times.

The agent is not being lazy. The reflex is wrong because **there is no rule telling it otherwise.** CLAUDE.md says "scenarios validate the product, not the assertions" (good), but says nothing about where intent parsing belongs architecturally. An agent facing a failing test defaults to "narrow fix" — and for text-intent problems, the narrow fix is always "add another regex branch," because that's what the surrounding code models.

## Proposed experience — the rule

**All intent, entity, and semantic interpretation of user text goes through an LLM. Hand-rolled NLP is forbidden.**

Concretely:

- **Intent classification** on user messages → the dispatcher LLM, already our single front-door. It has the recipe library, the plan summary, the pending state. It should classify confirm / cancel / reversal / substitution / help-me-pick / out-of-scope in one place with full context.
- **Entity recognition** on user messages (did they name an ingredient? which one? as the FROM or the TO of a swap?) → the agent that acts on the entity, with the full ingredient list in its prompt. Not a separate regex pass in the applier.
- **Paraphrase / variant matching** ("extra-firm tofu" vs user's "tofu", "ground beef" vs "beef stock") → the LLM, which has a semantic model. Not token-intersection with a modifier word list.
- **Confirmation / cancellation phrasing** → the dispatcher, with pendingSwap in its context, can classify "go ahead" / "actually no wait" / "sure why not" / "dale" uniformly.
- **Reversal phrasing** ("undo", "swap back the wine", "actually I found the wine") → same path. The dispatcher sees swap_history summaries and routes to `swap_ingredient`, which then handles reversal via the ingredient-swap agent's prompt rules (already in place).

The LLM is not a fallback. It is the interface.

### What IS allowed to stay deterministic (not NLP)

This rule is about interpreting natural language. It does NOT restrict:

- **Pure numeric parsing** — `parseMeasurementInput` pulling "82.3" and "91" out of a string. Numbers are not intent.
- **Callback data parsing** — `rv_<slug>`, `mp_confirm`, `cv_<batchId>`. Structured callback strings emitted by our own buttons.
- **Command parsing** — `/start`, `/cancel`. Structured Telegram commands, user-terminated.
- **Shopping-list ingredient-category classification** — maps an ingredient name (structured data, not a user message) to a grocery category. Not user-intent; reclassify as data normalization. (The proposal should still audit this layer — if it's over-hardcoded where the recipe generator could emit the category, that's a separate improvement, but it's not a violation of this rule.)
- **Date / time / unit conversion** — ISO date parsing, gram-to-oz math.
- **Template rendering / MarkdownV2 escaping** — output formatting, not input parsing.

The test for whether a check belongs in this rule: **is the input a natural-language message from the user?** If yes, LLM. If it's a callback, a number, a date, a structured field, or a recipe-database entry, deterministic is fine.

### The no-regex-for-intent rule, stated plainly

> A code change that introduces a regex, phrase list, or token-matching function that runs against `text` from a user message, in order to detect what the user means, is a design rejection. The path is: dispatcher prompt (for routing), sub-agent prompt (for entity work). When tempted to hardcode, extend the prompt instead.

This applies to new code AND to refactors of existing code that violates the rule.

## Design decisions

**LLM calls cost money and time — is this efficient?** The concerns have well-understood answers:
- For common confirmations ("yes" / "no"), the dispatcher already runs. Adding these classifications to its existing response doesn't add a call.
- For low-signal routing, we can use `model: 'mini'` with short prompts. Fast and cheap. Much cheaper than engineering hours on word-list maintenance across a multi-week time horizon.
- Cache hit rate stays high because the system prompt is stable; only the user message changes between turns. The pre-filter optimisation saves a tiny amount of per-turn latency at the cost of brittleness that dominates.

**"But regex IS deterministic, and determinism helps testing."** Determinism is not a goal; correctness is. Our LLM calls are fixture-replayed in tests — deterministic via the harness, non-deterministic only during `test:generate`, which is exactly when we WANT LLM judgment. The deterministic-regex argument was the core reason we did this in the first place; Plan 033 demonstrated it costs more than it saves.

**"But a regex is faster."** On any surface the user can type text on, network round-trips to OpenAI dominate. Shaving 2ms of regex off a 1500ms LLM turn is noise. The pre-filter's "free" short-circuit exists only because the regex cases would otherwise also hit the LLM — and if the LLM handles them in the same round, the pre-filter adds nothing.

**Boundary case: what about `matchPlanningMetaIntent`?** The plan-flow's cancel/start-over matcher runs BEFORE the dispatcher, intentionally, to cover the proposal-003-documented precedence: cancel phrases during active planning route to the planning flow, not to the dispatcher's return_to_flow. This is a regex-based flow-precedence decision, not an intent classifier on free text — it matches a narrow phrase set ("cancel", "start over") in the specific context of an active planning flow. It's a gray area. The proposal's stance: **audit it**. If the dispatcher, with the right prompt and active-flow context, can do the same job, delete the matcher. If not, document explicitly in `plan-flow.ts` why it exists and when it can go away.

**What happens during LLM outages?** The dispatcher's existing fallback path (`replyFreeTextFallback`) already handles LLM failure. No new behaviour needed.

## Implementation — this proposal authorizes the work to happen as a dedicated plan

This proposal authorizes exactly ONE plan: a codebase-wide refactor + documentation update that makes the rule real.

### Phase A — Full codebase scan (MANDATORY first step of the implementation plan)

Before any code changes, the implementing agent MUST produce a catalog of every existing violation. The scan covers:

1. **Hardcoded phrase regexes / word lists parsing user text** — every `/^(yes|no|ok|...)/.test(text)`-style check, every phrase list used for intent.
2. **Ingredient / entity matching on user messages** — every `text.includes(ingredientName)` / `userMentions`-style function / token-overlap helper.
3. **Pre-filters** that short-circuit before the dispatcher — enumerate all `try*PreFilter` functions under `src/telegram/**`.
4. **Specific known sites to include** (from Plan 033): `src/telegram/dispatcher-runner.ts` `trySwapPreFilter`; `src/utils/swap-format.ts` (`userMentionsStrict`, `userMentionsLoose`, `NAME_MODIFIERS`, `STOPWORDS`, `isPantryStaple`); `src/plan/swap-applier.ts` (`isBareReversalPhrase`, `batchMentionsUserIngredient`, `nameAppearsInUser`, `breakfastMentionsUserIngredient`); `src/agents/plan-flow.ts` `matchPlanningMetaIntent`.
5. **Boundary notes** — every site the scan finds gets classified:
   - `violation` — refactor to LLM.
   - `borderline` — document why it stays, add a dated review reminder, OR refactor (decide per-site).
   - `exempt` — structured-data parsing (numbers, dates, callback data, templates). Listed for completeness so nothing is overlooked, not marked for refactor.

The scan output is a concrete checklist stored in the plan, ordered by blast radius. No refactor PR merges without the scan checklist attached.

### Phase B — Refactor each violation, in order of blast radius

Each violation in the scan gets one of:

- **Delete and route through the dispatcher prompt.** The default. The dispatcher is already running on every user message; extending its responsibilities is how we consolidate.
- **Delete and route through the relevant sub-agent prompt.** E.g., the ingredient-swap agent already inspects the user's message + current ingredients; moving `userMentions` logic INTO the agent's own self-check means one less duplicate analysis.
- **Delete entirely as unnecessary** — some hardcoded branches are relics of an earlier design and don't need a replacement.

Each refactor commits must include:
- The deletion of the hardcoded matcher.
- The prompt change that subsumes its behaviour.
- The regen of affected scenarios (parallel, per CLAUDE.md) and serial behavioral review.

### Phase C — Lock the rule in documentation so no future agent repeats this

**This is the most load-bearing step. Skipping it guarantees we re-live Plan 033 within two features.**

The implementation plan MUST update every channel a coding agent reads so the rule is unmissable:

1. **`CLAUDE.md`** — add a top-level section "LLM-first text understanding" with the rule, the forbidden anti-patterns (regex on user text for intent, phrase lists, token matchers), and the explicit exceptions (numbers, dates, callbacks, templates). Reference design doc 007. This must be high in the file, not buried — directly under the debug workflow section.
2. **`docs/PRODUCT_SENSE.md`** — promote the rule to a named principle: "The LLM is the interface, not a fallback." Frame it as: when we skip the LLM for user text, we build an English-only product that costs hours per feature in NLP maintenance. Link to this design doc.
3. **`docs/ARCHITECTURE.md`** — add a "Where NOT to put intent detection" paragraph, naming the prohibited patterns, with pointers to the refactored reference examples after Phase B is done.
4. **Auto-memory** (`feedback_agentic_over_deterministic_validated.md` already exists — the implementation plan should extend it or add a sibling memory `feedback_llm_first_text_understanding.md` that frames this as BINDING, not merely validated). The memory should include a one-line anti-pattern checklist the agent runs through before any PR that touches user-text handling.
5. **`docs/DOCS-GUIDE.md`** — add a pointer: "design doc 007 is the canonical architectural rule on LLM-first intent handling." This is the doc that governs doc placement; anchoring the rule here makes it discoverable.

No part of Phase C is optional. The rule sticks only if it is documented EVERYWHERE a future agent might look for guidance. Missing one channel is how we got here — `feedback_agentic_over_deterministic.md` was in auto-memory but NOT in CLAUDE.md, NOT in PRODUCT_SENSE, NOT in ARCHITECTURE — so during Plan 033 the binding force was weak and the anti-pattern re-emerged.

### Phase D — Enforcement: a harness check

To make this rule enforceable rather than a hope, add a lightweight lint-style check to `npm test`: a grep-based scan of `src/**` for patterns like `/^\s*(yes|no|ok|confirm)` on user-text variables, phrase-list constants with names like `CONFIRM_PHRASES`, regexes tested directly against a parameter named `text`. Any hit fails CI with a pointer to design doc 007. Not a perfect linter — the goal is to catch the obvious reflex before it enters the codebase, not to machine-prove compliance.

## Edge cases

**i18n readiness.** This proposal does NOT ship i18n, but removes the architectural obstacle. After the refactor, adding a second language is "change the prompt language and the recipe strings"; without this refactor, it's "change the prompt language AND rebuild every regex." The proposal should call out in the docs: we're not i18n'd yet, but after this refactor we ARE architecturally ready.

**Existing scenario recordings remain valid.** Refactoring a hardcoded matcher into the dispatcher prompt changes the LLM input, which invalidates fixture hashes. This is already the case for any prompt change. Phase B regenerations are the fixed cost of the refactor and are budgeted for.

**LLM cost / latency increase.** Some cases that were free before now require a dispatcher call. The dispatcher already runs; the regen cost is a one-time scenario spend, not a per-user ongoing cost. For rare cases where a pre-filter genuinely saves a call (bare "yes" after a preview), the proposal allows a thin exception IF it is documented in-line with the file reference to design doc 007. The default is still to route through the dispatcher.

**Test-time determinism.** The test harness's `FixtureLLMProvider` already makes LLM calls deterministic during replay. Refactoring regex → LLM does not make tests less deterministic, only more honest about which behaviour is LLM-derived.

## Out of scope

- Shopping-list ingredient-category classification (a recipe-data normalization task, not a user-message intent task). Touched in the scan for completeness only.
- i18n itself — the proposal enables i18n readiness, does not ship it.
- Removing `FixtureLLMProvider` or changing the test harness shape.
- Extending this rule to code generation or internal tool use. This proposal is specifically about user-facing text intent.
- The separate question of "should our pre-filter ALSO handle numeric measurements" — the numeric pre-filter is explicitly exempt because it processes numbers, not words.

## Success criteria

The refactor is complete when:

1. The Phase A scan catalog's `violation` entries are all deleted, with their behaviour re-routed through the dispatcher or a sub-agent prompt.
2. No production `src/**/*.ts` file contains a phrase-list regex, token-matcher function, or word-overlap check on a `text: string` user-message parameter — verified by the Phase D lint.
3. CLAUDE.md, PRODUCT_SENSE.md, ARCHITECTURE.md, and the auto-memory file all cite design doc 007 as the governing rule.
4. `npm test` is green, with every affected scenario behaviorally reviewed.
5. A future coding agent, dropping into a random spot in the codebase and writing text-handling code, sees the rule within the first doc they open.

If any of these is missed, the proposal has failed even if the code appears to work — because the rule won't hold and we will do this again.
