# Flexie — Agent Coding Guidelines

## Documentation-first codebase

This codebase is designed for LLM coding agents. Every piece of documentation exists so that an agent can load only what it needs — not the entire project. CLAUDE.md is the map. Load a specific doc when you need depth.

### Code documentation requirements

Every file, class, and function must be documented. This is not optional.

- **Every file** starts with a doc comment: what it's for, its role in the architecture, how it connects to other parts.
- **Every class/function** has a doc comment: what it does, parameters, return values, non-obvious behavior.
- Documentation is written for LLMs. Be explicit about intent, constraints, and relationships.
- When modifying code, update documentation in the same change. Stale docs are worse than no docs.

### Docs index

| File | Purpose | When to reference |
|---|---|---|
| `docs/PRODUCT_SENSE.md` | Vision, principles, core beliefs. The "why" tiebreaker. | When making product tradeoff decisions. |
| `docs/ARCHITECTURE.md` | Codebase structure, modules, dependency flow, data flow. | When navigating the codebase or adding modules. Start here to find which file to edit. |
| `docs/product-specs/index.md` | Product specs entry point — links to focused spec files. | When implementing any feature. Load the specific spec you need. |
| `docs/product-specs/core-concepts.md` | Weekly budget, flex slots, planning-first, overconsumption priority. | When working on the product model or budget logic. |
| `docs/product-specs/flows.md` | Plan week flow, recipe flow, shopping list flow — all phases. | When changing user-facing conversation flows. |
| `docs/product-specs/solver.md` | Budget solver algorithm, constraints, inputs/outputs. | When fixing budget math or allocation. |
| `docs/product-specs/data-models.md` | TypeScript interfaces, Supabase schema. | When changing data shapes or persistence. |
| `docs/product-specs/ui.md` | Telegram UI, keyboards, message formatting, voice. | When modifying buttons, menus, or display. |
| `docs/product-specs/recipes.md` | Recipe format, generation, scaling, structure system. | When working on recipes. |
| `docs/product-specs/testing.md` | Scenario harness, `npm test`, authoring scenarios, generate mode. | When running tests, writing a new scenario, or updating a stale recording. |
| `docs/product-specs/jtbd.md` | Jobs To Be Done — real-life user moments, motivations, priority ranking. | When making product/UX decisions or designing new screens. |
| `docs/product-specs/ui-architecture.md` | Product states, screen inventory, navigation map, information hierarchy, copy tone. | When designing or modifying any UI surface. |
| `docs/BACKLOG.md` | Current version scope + versioned feature roadmap. | When checking what's in/out of scope. |
| `docs/FEATURE-LIFECYCLE.md` | Idea-to-production process: proposal → design doc → plan → code. | When starting any user-facing change. Read this FIRST. |
| `docs/DOCS-GUIDE.md` | Rules for creating and managing docs, plans, design docs, specs. | When creating new docs or unsure where something belongs. |
| `docs/design-docs/index.md` | Catalog of significant design decisions. | When making or reviewing architectural decisions. |
| `docs/design-docs/proposals/` | Working drafts for product/UX changes. | When designing a new feature or changing existing UX. Start here. |
| `docs/plans/active/` | Execution plans currently in progress or parked. | When planning or executing multi-step work. |
| `docs/plans/tech-debt.md` | Known technical debt and deferred cleanup items. | When deferring cleanup or checking what debt exists. |

When adding new docs, update this table. An unlisted doc is invisible to the agent.

### Plans go to `docs/plans/active/`, NEVER to `~/.claude/plans/`

All execution plans MUST be written to `docs/plans/active/NNN-topic.md` using the format in `docs/plans/README.md`. Never use `~/.claude/plans/` — that path is invisible to the project and to future agents. Check the highest plan number across `active/` and `completed/` before creating a new one.

### Design before code for user-facing changes

Any change that affects what the user sees or experiences MUST start with a design proposal (`docs/design-docs/proposals/`), not an implementation plan. The sequence is: design proposal → discussion → design doc → implementation plan → code. See `docs/FEATURE-LIFECYCLE.md`.

Do NOT jump from "problem identified" to "here's the code fix." Design the experience first. Describe screens, messages, buttons, and emotional arc. Only after the design is approved, write an implementation plan.

### Never start implementing a plan without explicit user approval

After writing a plan, STOP and wait for the user to review it and explicitly say to proceed. Exiting plan mode means the plan is ready for review — it does NOT mean "start coding." Do not begin implementation until the user gives clear approval (e.g., "go ahead", "implement it", "looks good, do it").

### Docs maintenance rules

See `docs/DOCS-GUIDE.md` for the full rules on when to create new files, where they go, and how to manage the docs lifecycle.

### Tech stack

- TypeScript / Node.js
- Telegram Bot API (grammy)
- OpenAI API behind provider interface: GPT-5.4 (complex), GPT-5.4-mini (generation/reasoning), GPT-5.4-nano (classification/parsing), Whisper (STT). Mini and primary support reasoning modes: none, low, medium, high, xhigh.
- Supabase (state, plans) + markdown files (recipes)

### Coding conventions

- Keep files focused. One responsibility per file.
- Prefer explicit over clever. An agent reading this for the first time should understand it without surrounding context.
- When in doubt about a product decision, read `docs/PRODUCT_SENSE.md`.
- Telegram callback data has a 64-byte limit. Recipe slugs truncated via `truncateSlug()` in keyboards.ts; handlers use `findBySlugPrefix()` as fallback.
- Recipe slugs must be max 50 chars (enforced in the generator prompt).
- When modifying code that changes product behavior, update the relevant doc in the same commit. Stale docs actively mislead the next agent.

## Debug workflow

The primary development loop is harness-driven. Scenarios in `test/scenarios/` replay fixture-recorded LLM responses in under a second each, and `npm test` is the main feedback signal for any code change. Real-Telegram testing via `npm run dev` stays as a final sanity check, not as the primary debugging tool.

See `docs/product-specs/testing.md` for the full harness reference. Read `test/scenarios/index.md` to see what each scenario tests — don't open individual spec files just to understand coverage.

### Baseline: `npm test` before and after every non-trivial change

Run `npm test` once before starting work to confirm a green baseline. Run it again after the change to verify no regressions. If a scenario fails, the `deepStrictEqual` diff points at the exact reply, session field, or persisted plan that diverged — usually enough to diagnose without any further tooling.

### Reviewing behavior: `npm run review`

When a scenario failure (or a recording you just regenerated) needs inspection, `npm run review -- <scenario>` prints a structured probe report: purpose, transcript, derived plan view (7×2 grid), global-invariant results, `assertBehavior` result, execution-trace summary, and certification status. This replaces the ad-hoc `node -e "..."` verification script and is the primary tool for the 5-step verification protocol in `docs/product-specs/testing.md`. `npm run review` (no arg) lists every scenario with its certification status — `certified`, `needs-review`, `uncertified`, or `obsolete`.

### After generating or regenerating any scenario (MANDATORY)

Every `npm run test:generate` — new or `--regenerate` — MUST be followed by a full behavioral review. Read the recorded output as if you were the user receiving these Telegram messages. Check that the plan makes sense, slots are covered, there are no ghost batches, cook days match first eating days, and weekly totals are reasonable. If something is wrong, fix the code and re-generate — never commit a recording that captures wrong behavior. See `docs/product-specs/testing.md` § "Verifying recorded output" for the full protocol with the step-by-step checklist and known-issue patterns.

This is not optional. `npm test` passing proves determinism. Verification proves correctness. The ghost batch bug (scenario 003) was caught by reading the output, not by `deepStrictEqual`.

### Scenarios test the PRODUCT, not the assertions

When a scenario assertion fails — OR when any recorded transcript shows unexpected behavior — STOP. Do NOT change the scenario, the user message in the spec, or the assertion as a first move. Carefully inspect what's happening: read the recorded transcript as if you were the user, trace the dispatcher decision and the persistence ops, ask "did the user just experience a bug?". The default conclusion is: failure = product bug. Fix the code, not the assertion.

Spec / user-message / assertion changes are LAST RESORT — only after you've ruled out a product issue. If you're tempted to "make the user message more obvious" or "accept multiple LLM routings", ask yourself first: would a real user blame the dispatcher / applier / state machine for the gap, not their phrasing?

Genuine relaxations exist (LLM truly has multiple defensible reactions to ambiguous input — e.g., random text "xyz" being declined as `out_of_scope` vs `clarify` are both honest declines) but they are RARE. Document the user-experience rationale in-line every time.

Common anti-patterns to watch for:
- "The dispatcher routed to clarify instead of swap_ingredient" → if the user's message clearly named an ingredient swap, the dispatcher prompt has a gap. Fix the prompt.
- "The pre-filter didn't fire because state was cleared" → if the user typed `nevermind` and got `out_of_scope` ("I don't do small talk"), that is a real UX bug in state preservation. Fix the lifecycle, not the assertion.
- "The agent applied directly when we expected preview" → check whether the applied result is correct for the user. Defensible only if the apply path is genuinely safe.

Document the rationale every time you relax an assertion. If the relaxation lasts more than one commit, file a follow-up in `docs/plans/tech-debt.md`.

**Regenerate in parallel, review serially. ALWAYS.** When more than ONE scenario needs regeneration (e.g., a prompt change invalidates every re-proposer fixture — or even just 2–3 scenarios drift together), run the regenerations IN PARALLEL: delete each target `recorded.json` first, then launch `npm run test:generate -- <name> --regenerate --yes` for every scenario concurrently (shell `&` or a small script) and `wait` for all to finish. Generation is mechanical and LLM-bound; parallelism saves wall-clock time and money with no quality cost. Sequential regeneration is a time-waste anti-pattern — never do it. For very large batches (20+ scenarios) throttle to ~8 concurrent to stay under LLM-provider rate limits, but still batch-parallel. Then do the behavioral validation ONE BY ONE, serially, using the 5-step protocol in `docs/product-specs/testing.md` § "Verifying recorded output". Reviewing in parallel erodes attention and is the exact failure mode the harness exists to prevent — behavioral validity IS the point of the scenarios, not just green `npm test`.

### Fixture-edited scenarios: NEVER `--regenerate` after applying edits

Some scenarios (e.g., 014) have a `fixture-edits.md` that describes manual edits to `recorded.json` to simulate LLM misbehavior. `--regenerate` **always calls the real LLM** and will silently destroy these edits. After applying fixture edits, use `npm run test:replay -- <name>` to re-record expected outputs from the edited fixtures. Fixture-edited scenarios should also include `fixture-assertions.ts`; the harness runs it in both `test:replay` and `npm test` so a fresh valid fixture cannot silently pass. See `docs/product-specs/testing.md` § "Scenarios with manually edited fixtures" for the full workflow.

### When the user reports an issue

1. **Read the end of `data/logs/debug.log` first.** Append-only, can grow large. Start from the last ~200 lines. This is the authoritative record of what happened in the user's actual session — every Telegram message, AI call (full prompts/responses/tokens/duration), flow state transition, and QA validation result. Tags: `[TG:IN]` / `[TG:OUT]` / `[AI:REQ]` / `[AI:RES]` / `[FLOW]` / `[QA]`. The log tells you *what the user did* (the `[TG:IN]` events that become the scenario spec) and *what happened internally* (prompts, state, solver output).

2. **Reproduce the bug as a scenario.** Author `test/scenarios/NNN-short-name/spec.ts` using the `[TG:IN]` entries from the log as the script: commands, reply-keyboard taps, inline button callbacks, transcribed voice. Pick a stable clock (anything in the current week) and the appropriate recipe fixture set. Run `npm run test:generate -- <name>` — this captures the current (still buggy) behavior as `recorded.json`. The scenario passes on the broken code because it locks in exactly what the code produces today.

3. **Fix the code, then regenerate the recording.** After the fix, run `npm run test:generate -- <name> --regenerate`. Review the `git diff` on `recorded.json` — the bug should disappear from the transcript exactly where you predicted, and nowhere else. If unrelated fields change, the fix has a broader blast radius than intended and needs narrowing. Commit `spec.ts`, `recorded.json`, and the code fix in one commit.

4. **The scenario becomes a permanent regression test.** Any future change that re-introduces the same bug class fails this scenario on the next `npm test`. Plan 005 → scenario `002-plan-week-flex-move-regression` is the reference example.

### When a new scenario is NOT needed

For code cleanups, refactors, renames, typo fixes, and bug fixes well-covered by existing scenarios, `npm test` alone is the verification — authoring a scenario per trivial change is noise. A new scenario is warranted when: the user caught a bug no existing scenario exercises, you're adding a new user-facing flow, or you want to lock in a regression class.

### When to use `npm run dev` (real Telegram)

Reserve for:
- Structural migrations where the harness cannot simulate grammY itself (e.g., verifying the `BotCore` extraction didn't break inbound routing).
- Final UX sanity check before handing work back — captured keyboard shapes are an imperfect proxy for how a message actually renders on a phone.
- Exploring unfamiliar flows to understand how to author a scenario.

Everything else runs through `npm test`.

### Debug mode (for real-Telegram runs only)

`DEBUG=1 npm run dev` or `npm run dev:debug` — adds verbose console output and a one-line debug footer on Telegram messages showing models used and timing. Only affects real-Telegram runs; harness replays are deterministic regardless of DEBUG mode because the footer is appended exclusively inside the grammY adapter.
