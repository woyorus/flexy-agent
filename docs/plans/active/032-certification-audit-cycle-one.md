# Plan 032: Certification Audit Cycle One — Migrate Legacy Scenarios

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Active
**Date:** 2026-04-13
**Depends on:** Plan 031 (Behavioral Certification Harness) fully merged.
**Affects:** `test/scenarios/*/assertions.ts` (61 new files), `test/scenarios/*/certification.json` (61 new files), `src/harness/domain-helpers.ts` (expected additions as waves surface new reusable checks), possibly `src/harness/assertions-context.ts` (additional convenience accessors as needed), `test/scenarios/index.md` (optional column for certification status if decided during Wave A), `docs/plans/scenario-migration-tech-debt.md` (new — log of bugs discovered during audit that don't block certification of the specific scenario).

---

## Goal

Migrate every legacy scenario in `test/scenarios/` (everything except `014-proposer-orphan-fill`, already migrated in Plan 031) to the behavioral certification model: each scenario gets an `assertions.ts` exporting `purpose` + `assertBehavior`, then gets stamped via `npm run review -- <scenario> --accept`. After this plan lands, `npm run review` reports zero `uncertified` scenarios.

## Non-goals

- **No new scenarios.** Audit migrates what exists. New scenario authoring is normal feature work and lives in the relevant feature plan.
- **No code changes beyond domain-helper additions** surfaced by audit needs. If the audit discovers a product bug (recording captures wrong behavior), fix the code + regenerate + re-verify as part of that scenario's migration; do not bundle unrelated refactors.
- **No re-certification discipline** beyond what Plan 031 already ships. Once a scenario is stamped, future work that shifts hashes produces `needs-review` status; resolving that is owned by whoever makes the change, not by this plan.

## Why this is its own plan

Plan 031 explicitly scoped audit cycle one as separate work (design doc 004 § "Out of scope": "Sequencing of audit cycle one — how many scenarios per session, which classes first, etc. (separate implementation plan)"). Two reasons justify the split:

1. **Attention-bound work.** Each scenario requires the agent to read the recording behaviorally, identify the load-bearing claim, and translate it into deterministic code. CLAUDE.md § "Debug workflow" — "Regenerate in parallel, review serially" — names this pattern explicitly: mechanical steps batch, attention steps serialize. Plan 031's machinery unblocks this plan; the actual migration sits on the attention path.

2. **Natural review checkpoints.** Grouping scenarios into waves (below) creates commit-sized units the agent can stop, review, and re-evaluate between. A single 61-scenario PR would be unreviewable; nine waves is tractable.

---

## Plan of work

### Wave overview

| Wave | Class | Scenarios | Expected helpers used | Expected helper additions |
|---|---|---|---|---|
| A | Planning happy path | 001, 003, 004 | `assertPlanningHealthy` | none |
| B | Rolling horizon | 005, 006, 009, 010, 011, 012, 013 | `assertPlanningHealthy` + pre-committed carry-over checks | `assertPreCommittedRespected`, `assertNoBatchOverlapsPriorSession` |
| C | Planning mutations (re-proposer) | 002, 020, 023, 024, 025, 026, 027, 028 | `assertPlanningHealthy` + execTrace checks for `plan-reproposer` call | `assertMutationHistoryLength`, `assertReProposerCalled` |
| D | Progress | 015, 016 | none (new helpers) | `assertProgressWellFormed`, `assertMeasurementPersisted`, `assertWeeklyReportShape` |
| E | Navigation + views | 018, 022, 030, 031, 032, 033, 035, 036 | sessionAt accessors | `assertLastRenderedView`, `assertSessionAtVariant` |
| F | Shopping + recipes | 019, 029, 061, 062 | none (new helpers) | `assertShoppingListCoverage`, `assertRecipeFlowPersisted` |
| G | Dispatcher front door | 037, 038, 039, 040, 041, 042, 043 | execTrace `dispatcherActions` | `assertDispatcherActions`, `assertNoDispatcherCallFor` (cancel/numeric short-circuit cases) |
| H | Mutate plan (Plan 029) | 044, 045, 046, 047, 048, 049, 050, 051, 052, 053 | `assertPlanningHealthy` + dispatcher + `assertMutationHistoryLength` | reuses H + some C helpers |
| I | Secondary actions (Plan E) + cross-cutting | 017, 021, 054, 055, 056, 057, 058, 059, 060, 063, 064, 065 | mix of dispatcher + navigation + planning + measurement helpers | `assertAnsweredInline`, `assertRenderedScope` |

Total: **61 scenarios** across 9 waves. Count matches `ls test/scenarios/` minus 014 minus `index.md`.

Scenario numbers not in any row of the table (007, 008, 034) do not exist on disk — the numbering has gaps from prior plan iterations where scenarios were renamed or removed.

### General migration recipe (applies to every scenario)

For each scenario under migration, the agent follows a six-step recipe. Variations per wave are called out in the per-wave sections below.

1. **Read** the scenario's recording and spec. `recorded.json` is the single source of truth for what happened. `spec.ts` is what the user did. The scenario's description is a starting hint for its purpose but not authoritative — the behavior in `recorded.json` is. **While reading, actively look for bugs** — apply the 5-step verification protocol from `docs/product-specs/testing.md` § "Verifying recorded output" as a bug-detection pass, not just a context-loading pass.
2. **Triage any suspected bug** against the four-way classification in § "When migration surfaces a bug" above. If the bug is load-bearing for this scenario's purpose, decide whether to inline-fix, mark obsolete, or defer the scenario. If the bug is adjacent / cross-scenario / LLM-quality, append an entry to `docs/plans/scenario-migration-tech-debt.md` (or `docs/plans/tech-debt.md` for LLM-quality) and continue.
3. **State the purpose** in one sentence. "When the user does X from state Y, the bot should do Z." The purpose is load-bearing: it names what about this scenario must remain true on every future replay. Anything the scenario happens to capture but isn't load-bearing (exact wording of a confirmation, order of inline buttons, etc.) belongs to `deepStrictEqual`, not to the purpose. **If the scenario has an adjacent bug logged in tech-debt, the purpose must not claim the buggy behavior is correct** — phrase around it (e.g., "the plan covers every slot" rather than "the plan covers every slot with the correct emoji spacing").
4. **Translate the purpose into `assertBehavior`** using existing helpers wherever possible. For planning scenarios, `assertPlanningHealthy(ctx)` covers 80% of the work. Scenario-specific claims (specific batch present, specific event added, dispatcher chose action X) are bespoke checks against `ctx.outputs` / `ctx.finalSession` / `ctx.finalStore` / `ctx.execTrace`.
5. **Run `npm run review -- <scenario>`** to preview. The probe report either passes every check or prints the specific failure. If it fails, investigate: is the assertion wrong (overclaims) or is there a real bug in the code / recording? If assertion is wrong, fix it. If it's a new load-bearing bug, loop back to step 2.
6. **Run `npm run review -- <scenario> --accept`** to verify + stamp. `--accept` re-runs the full pipeline (Plan 031 Step 10.1); if step 5 was clean and nothing changed between 5 and 6, this writes `certification.json`. If the scenario is one the agent decided to defer (load-bearing bug not yet fixed), skip `--accept` — the scenario remains `uncertified` and its blocker is on record in the tech-debt file.
7. **Add to the wave's commit** or commit immediately (agent's choice). Commit message: `cert: migrate scenario <name>` or, for wave-level batch, `cert: wave <letter> — N scenarios certified`. Any tech-debt file additions are part of the same commit as the scenario they were discovered in.

### When to add a new domain helper

Add to `src/harness/domain-helpers.ts` when **two or more** scenarios would use the same bespoke check. One-off checks live in the scenario's `assertBehavior` body. The "expected helper additions" column above is the agent's starting hypothesis; the real list emerges during each wave and should be updated in this plan's decision log as it does.

### When to mark a scenario obsolete

If during migration the agent concludes a scenario no longer represents a meaningful claim (e.g., the flow it tested has been deleted, or the claim is subsumed by a newer scenario), mark it `status: obsolete` instead of writing assertions. Steps:

1. Hand-write `certification.json` with `{ reviewedAt: '<now>', specHash: '', assertionsHash: '', recordingHash: '', status: 'obsolete' }` (empty hash strings are fine — obsolete is sticky regardless of drift per Plan 031 § "Certification stamp").
2. Add a short `README.md` or comment explaining why obsolete.
3. Commit with message `cert: mark scenario <name> as obsolete — <reason>`.

Only mark obsolete with a clear reason. "The purpose is unclear" is not a reason — it's a signal to brainstorm the intent, not to give up.

### When to delete a scenario outright

If a scenario is truly irrelevant (tested a feature that was fully removed; not kept as regression history), delete the directory. This is a stronger action than obsolete and should be rare during audit cycle one. Prefer obsolete for anything ambiguous; deletion is for cleanup the agent is confident about.

### When migration surfaces a bug

The audit will surface bugs. Plan 031's Goal § "Reliability is existential for a self-use tracker" guarantees this — the whole point of reading 61 recordings behaviorally is to find the places where recorded behavior diverges from correct behavior. The audit is also a bug-discovery pass, not just a stamping pass.

**The rule for certified status does not move:** a scenario can only be stamped `certified` if its `assertBehavior` passes on the current on-disk recording AND the recording represents behavior the agent is willing to defend as correct. A certified stamp on knowingly-buggy behavior poisons the trust surface the entire plan is building.

**But:** inline-fixing every bug as it surfaces serializes the audit against arbitrary feature work and can derail the wave cadence for weeks. The audit needs a way to move forward without rubber-stamping bad behavior.

**The resolution** is to classify each suspected bug at discovery time and route it to the right destination:

| Classification | Example | What happens to the scenario | What happens to the bug |
|---|---|---|---|
| **Load-bearing bug** | Scenario's purpose IS the broken behavior (e.g., "mutation history grows by 1" but the recording shows it didn't grow). | **Cannot certify.** Fix code → regenerate → review → certify. OR mark `obsolete` with a clear "depends on broken feature X" reason. OR skip certification for this scenario and move on; the plan's Phase J counts this as a known unstamped scenario. | Fixed inline as part of the scenario's migration commit. |
| **Adjacent bug** | Scenario captures a typo, misaligned keyboard, off-by-one day in an output unrelated to the scenario's load-bearing claim. | **Certify.** `assertBehavior` doesn't reference the buggy part; `deepStrictEqual` still locks the current (buggy) output so a future fix surfaces as a diff. | Log in `docs/plans/scenario-migration-tech-debt.md` with scenario slug and symptom; fix later as its own unit of work. |
| **Cross-scenario bug** | Same symptom visible in many scenarios (e.g., emoji-spacing bug in every planning proposal). | **Certify each.** Scenarios move forward individually as above. | Log once in `docs/plans/scenario-migration-tech-debt.md` with `scope: cross-scenario` and the list of known-affected scenarios. One fix closes many entries. |
| **LLM output quality issue** (not a code bug) | Proposer made an odd-but-legal recipe choice; confirmation copy is fine but could be better. | **Certify.** LLM outputs are what they are; the scenario exercises the code path correctly. | Log in the existing `docs/plans/tech-debt.md` per CLAUDE.md § "If the issue is LLM output quality" — NOT in the scenario-migration file, which is for code bugs only. |

**When in doubt**, prefer the "log and move on" path. The tech-debt file's job is to be a complete inventory of known-but-deferred issues. Stopping the audit for inline fixes is appropriate only when the bug blocks a specific scenario from being honestly certified.

**Format for a tech-debt entry:** see `docs/plans/scenario-migration-tech-debt.md` — the template there (created empty at the start of this plan) has the fields to fill in. Each entry gets discovered-in scenario, classification, severity, symptom, scope, fix direction, and whether it blocks the scenario's certification.

**Reading back:** every Phase J run of `npm run review` that reports unstamped scenarios must match a blocking entry in the tech-debt file (and vice versa — a blocking entry must name the unstamped scenario). This keeps the two artifacts consistent.

---

### Phase 0: Tech-debt file scaffold

**Goal:** Before any wave begins, create the empty `docs/plans/scenario-migration-tech-debt.md` so every wave has a place to append discovered bugs without each wave having to invent the format.

**Steps:**

- [ ] **Step 0.1** — Create `docs/plans/scenario-migration-tech-debt.md` with the skeleton below (Open/Closed sections, no entries). Commit as `docs: scaffold scenario-migration-tech-debt.md`.

  ```markdown
  # Scenario Migration Tech Debt
  
  Bugs and oddities discovered during Plan 032's audit cycle one that do not
  block certification of the specific scenario in which they were found.
  Load-bearing bugs (ones that DO block certification) are fixed inline
  during the audit and do not appear here.
  
  This file is a running inventory. Entries are opened during the audit and
  closed as follow-up work lands. The file is NOT part of a plan lifecycle
  and does not move between `active/` and `completed/`; it lives at
  `docs/plans/scenario-migration-tech-debt.md` as long as any entry is open.
  
  See Plan 032 § "When migration surfaces a bug" for the triage rules that
  route bugs into this file vs. `docs/plans/tech-debt.md` vs. an inline fix.
  
  ## Entry format
  
  Each entry uses this template:
  
  ```
  ### <short-slug>
  
  - **Discovered in:** scenario NNN-name (Wave X)
  - **Classification:** adjacent | cross-scenario
  - **Severity:** cosmetic | functional | unclear-intent
  - **Symptom:** What the recording shows vs. what it should show. Name
    specific output indices, session fields, or store entries where
    relevant.
  - **Scope:** Which scenarios are affected. "Only this scenario" or a
    listed set, or "unknown — sweep needed".
  - **Fix direction:** Short hint where to look. If no hypothesis,
    "needs investigation".
  - **Blocked certification?** No (scenario certified around this) | Yes
    (scenario NNN remains uncertified; listed here so Phase J can
    reconcile).
  ```
  
  ## Open
  
  (No entries yet.)
  
  ## Closed
  
  (No entries yet.)
  ```

---

### Wave A: Planning happy path

**Scope:** Three scenarios that exercise the "fresh user completes a full planning flow end-to-end" pattern with no prior state. Simplest scenarios to start with; establish the template for how to migrate planning scenarios.

**Scenarios:**

- **001-plan-week-happy-path** — Fresh user: `/start` → Plan Week → keep breakfast → no events → approve on first try.
  - Purpose seed: "From an empty state, the planning flow produces a complete 7-day plan that covers every slot, passes validation, persists via `confirmPlanSession`, and renders a concise confirmation."
  - Checks: `assertPlanningHealthy(ctx)`; `ctx.execTrace.persistenceOps` includes `confirmPlanSession`; `ctx.finalSession.planFlow === null` (flow completes and clears).

- **003-plan-week-minimal-recipes** — A 2-recipe library forces the proposer to reuse recipes. Plan 024: no gap resolution needed.
  - Purpose seed: "When the recipe library is too small for unique-per-slot coverage, the proposer reuses recipes to fill every slot without creating gaps or ghost batches."
  - Checks: `assertPlanningHealthy(ctx)`; at least one batch appears more than once by recipe slug (derivable from `ctx.finalStore.batches`); no batch has a generated recipe (`recipesToGenerate` empty in the proposal).

- **004-rolling-first-plan** — First-ever plan from completely empty state. `horizonStart` falls back to "tomorrow" (D30 cold-start rule).
  - Purpose seed: "With no prior plan session, the first session's `horizonStart` is tomorrow (not today), and the plan fills tomorrow-through-D6."
  - Checks: `assertPlanningHealthy(ctx)`; `ctx.activeSession().horizonStart === tomorrow-relative-to-spec.clock`; no pre-committed slots.

**Steps:**

- [ ] **Step A.1** — Author `assertions.ts` for each of 001, 003, 004 following the recipe above.
- [ ] **Step A.2** — Run `npm run review -- <scenario>` for each; resolve any failures.
- [ ] **Step A.3** — Run `npm run review -- <scenario> --accept` for each.
- [ ] **Step A.4** — Run `npm run review` (no arg) and confirm Wave A scenarios now show `[certified]`.
- [ ] **Step A.5** — Commit: `cert: wave A — planning happy path (3 scenarios)`.

---

### Wave B: Rolling horizon

**Scope:** Seven scenarios testing the rolling-horizon mechanics introduced in Plan 007: continuation, carry-over, vacation fallback, replan, abandon.

**Scenarios:**

- **005-rolling-continuous** — Session B plans 7 days with session A's carry-over pre-committed.
- **006-rolling-gap-vacation** — Session A is historical; `computeNextHorizonStart` falls back to tomorrow with no carry-over.
- **009-rolling-swap-recipe-with-carryover** — Recipe swap via re-proposer on a non-pre-committed batch; carry-over stays intact.
- **010-rolling-events-with-carryover** — Proposer simultaneously respects pre-committed carry-over, a restaurant event, and flex with no double-booking.
- **011-rolling-replan-future-only** — Replanning a future session; old superseded and batches cancelled only after new session fully saved.
- **012-rolling-replan-abandon** — Replan then cancel; original session remains fully intact (save-before-destroy).
- **013-flex-move-rebatch-carryover** — Flex move to Sunday via re-proposer; batches rearrange cleanly.

**Purpose template for this wave:** "In a rolling-horizon context with [specific prior state], the planning flow [produces / mutates / abandons] the new session while respecting [pre-committed slots / the save-before-destroy guarantee / carry-over semantics]."

**Common checks (factored into helpers on first use):**

- `assertPreCommittedRespected(ctx)` — every pre-committed slot in `ctx.finalSession.planFlow?.preCommittedSlots` has the same day/mealTime as a slot in the prior session's batch output; none get overwritten in the new session.
- `assertNoBatchOverlapsPriorSession(ctx, priorSessionId)` — no new batch shares a `(day, mealType)` tuple with a batch from a prior session whose slot is pre-committed.
- `assertSaveBeforeDestroy(ctx, oldSessionId)` — if a replan happens, `ctx.finalStore.planSessions` shows the new session first, then the old session marked `superseded: true`. Batches from the old session are `status: 'cancelled'`.

**Steps:**

- [ ] **Step B.1** — Scenarios 005 and 010 first: the purest "respect pre-committed" case. Land the helpers `assertPreCommittedRespected` and `assertNoBatchOverlapsPriorSession` in `src/harness/domain-helpers.ts` as part of this step.
- [ ] **Step B.2** — Scenario 006 (vacation fallback): verify no pre-committed slots, horizon starts tomorrow.
- [ ] **Step B.3** — Scenarios 011 and 012 (replan / abandon): land `assertSaveBeforeDestroy` helper; 012 verifies the complement — no new session, old session fully intact.
- [ ] **Step B.4** — Scenarios 009 and 013 (re-proposer within rolling): combine mutation checks (Wave C patterns) with rolling checks. If the re-proposer helper lands in Wave C, revisit 009/013 in that wave instead — coordinate ordering with Wave C.
- [ ] **Step B.5** — Run `--accept` on every Wave B scenario.
- [ ] **Step B.6** — Commit: `cert: wave B — rolling horizon (7 scenarios); add pre-committed + save-before-destroy helpers`.

---

### Wave C: Planning mutations via re-proposer (Plan 025)

**Scope:** Eight scenarios exercising mid-proposal mutations: text-driven flex moves, recipe swaps, event add/remove, clarification, recipe generation.

**Scenarios:**

- **002-plan-week-flex-move-regression** — User types "move flex to Wednesday"; re-proposer rearranges.
- **020-planning-intents-from-text** — Mutation from proposal phase (no button tap) via re-proposer; "start over" resets.
- **023-reproposer-event-add** — "Dinner with friends Friday" added mid-review.
- **024-reproposer-recipe-swap** — "Salmon instead of beef"; re-proposer picks replacement.
- **025-reproposer-event-remove** — "Friday dinner got cancelled"; re-proposer fills freed slot.
- **026-reproposer-multi-mutation** — Two sequential mutations (flex move then recipe swap); history preserves first.
- **027-reproposer-clarification** — Vague request → clarification → user's answer → plan updates.
- **028-reproposer-recipe-generation** — "Thai green curry" not in DB; re-proposer asks to generate; recipe created and placed.

**Purpose template:** "When the user types [natural-language mutation] during the proposal phase, the re-proposer produces a new complete plan that [incorporates the change] while [preserving other constraints]; mutation history grows by one entry."

**Common checks (new helpers):**

- `assertReProposerCalled(ctx)` — `ctx.execTrace.handlers` shows at least one call routed through re-proposer (check for presence of `retry` entries with `validator: 'plan-reproposer'` OR for the re-proposer's signature handler name in `handlers`).
- `assertMutationHistoryLength(ctx, expected)` — `ctx.activeSession().mutationHistory.length === expected`.

**Notes:**

- Scenario 028 exercises recipe generation mid-flow — the recipe is created as a side effect of the plan. `assertRecipeFlowPersisted` (from Wave F) may be useful here; coordinate ordering.
- Scenario 027 (clarification) has two variants: the re-proposer returns a `clarification` response, the user answers, and the second re-proposer call lands the change. Assert both exchanges happened (via `handlers` or `recentTurns` inspection).

**Steps:**

- [ ] **Step C.1** — Land `assertReProposerCalled` and `assertMutationHistoryLength` in `src/harness/domain-helpers.ts` via scenario 002.
- [ ] **Step C.2** — Scenarios 020, 023, 024, 025: single-mutation cases. Each verifies `mutationHistoryLength === 1` (for fresh planning) or the pre-mutation count plus one.
- [ ] **Step C.3** — Scenarios 026, 027, 028: multi-step cases. 026 asserts history length 2; 027 asserts clarification round-trip; 028 asserts recipe persistence in addition to planning.
- [ ] **Step C.4** — Run `--accept` on each.
- [ ] **Step C.5** — If B.4 was deferred (scenarios 009 and 013), re-visit and stamp them now using the helpers landed in C.1.
- [ ] **Step C.6** — Commit: `cert: wave C — planning mutations (8 scenarios) + optional tail from wave B`.

---

### Wave D: Progress

**Scope:** Two scenarios covering progress logging + weekly report. New territory for the helper library — no progress-flavored helpers exist yet.

**Scenarios:**

- **015-progress-logging** — First log with disambiguation, first-measurement hint, already-logged same day, defensive `pg_last_report` with no completed week.
- **016-progress-weekly-report** — `[Last weekly report]` with a full completed week seeded; verifies tone, averages, delta computation.

**Purpose:**

- 015: "The progress flow accepts a measurement from the canonical entry path, disambiguates weight vs waist when ambiguous, persists the measurement, and behaves gracefully when no completed week exists."
- 016: "Given a complete week's measurements, the weekly report renders averages and deltas in the expected tone without producing `undefined` values in the output."

**New helpers:**

- `assertProgressWellFormed(ctx)` — no "undefined" in outputs (already covered by GI-03, but the helper composes additional progress-specific checks); measurement date resolves to a valid ISO date.
- `assertMeasurementPersisted(ctx, expected: { date, weight, waist? })` — `ctx.finalStore.measurements` contains the expected measurement.
- `assertWeeklyReportShape(ctx)` — output contains the expected delta fields (weight avg, waist avg, weekly delta); no raw `null`/`undefined` leaking.

**Steps:**

- [ ] **Step D.1** — Land three progress helpers in `src/harness/domain-helpers.ts`.
- [ ] **Step D.2** — Author 015 assertions — tricky because it exercises multiple branches (disambiguation + first-measurement hint + already-logged + no-report-available). The purpose should name the unifying claim ("the progress flow handles these four adjacent cases without errors"); the body can assert each branch fired (via `ctx.outputs` content checks).
- [ ] **Step D.3** — Author 016 assertions — simpler: one measurement seeded, one report requested.
- [ ] **Step D.4** — `--accept` both.
- [ ] **Step D.5** — Commit: `cert: wave D — progress (2 scenarios) + progress helpers`.

---

### Wave E: Navigation + views

**Scope:** Eight scenarios that walk through the navigation-state model (Plan 027). Several use `captureStepState: true` and assert on `sessionAt[]`.

**Scenarios:**

- **018-plan-view-navigation** — Active plan navigation: My Plan → Next Action → Week Overview → Day Detail → Cook view → back.
- **022-upcoming-plan-view** — Upcoming plan visibility before plan starts; "No meals" for pre-plan days; replan prompt when tapping Plan Week.
- **030-navigation-state-tracking** — Walks every render surface; asserts every intermediate `lastRenderedView` variant via per-step snapshots. Covers 9 of 10 variants.
- **031-shopping-list-mid-planning-audit** — Regression lock for "tap 🛒 Shopping List mid-planning clears planFlow".
- **032-discard-recipe-audit** — Regression lock for "tap Discard during recipe flow clears recipeFlow".
- **033-recipe-edit-clears-planflow-audit** — Regression lock for "tap re_<slug> with planFlow alive clears planFlow".
- **035-navigation-progress-log-prompt** — Single-step sibling to 030 covering the one `LastRenderedView` variant 030 can't reach.
- **036-day-detail-back-button-audit** — Regression lock: `my_plan → wo_show → dd_<date>` → back → lands on week_overview.

**Purpose template:** "From [state], tapping [inputs] navigates through [view sequence] and ends in [final state]; intermediate `lastRenderedView` variants match the expected sequence."

**New helpers:**

- `assertLastRenderedView(ctx, expected: LastRenderedView)` — asserts `ctx.finalSession.lastRenderedView` equals `expected` (deep-equal discriminated union variant).
- `assertSessionAtVariants(ctx, variants: LastRenderedView[])` — asserts `ctx.sessionAt[i].lastRenderedView === variants[i]` for every step. Fails with index-pointing diff.

**Notes:**

- Scenarios 031, 032, 033 are specifically regression locks for Plan 027 audit decisions. The `purpose` should explicitly name "Plan 027 audit decision X" so future readers know why the scenario exists.
- Scenario 030 has 10+ per-step assertions already locked in `sessionAt[]`. The `assertBehavior` body can delegate most of the work to `assertSessionAtVariants` rather than duplicating per-step lists.

**Steps:**

- [ ] **Step E.1** — Land `assertLastRenderedView` and `assertSessionAtVariants` helpers.
- [ ] **Step E.2** — Scenarios 018, 022: straightforward navigation.
- [ ] **Step E.3** — Scenarios 030, 035, 036: per-step state scenarios.
- [ ] **Step E.4** — Scenarios 031, 032, 033: audit regression locks. Each `purpose` names the Plan 027 audit decision it locks.
- [ ] **Step E.5** — `--accept` each.
- [ ] **Step E.6** — Commit: `cert: wave E — navigation + views (8 scenarios) + navigation helpers`.

---

### Wave F: Shopping + recipes

**Scope:** Four scenarios covering shopping list tiers/scopes and the standalone recipe flow.

**Scenarios:**

- **019-shopping-list-tiered** — Three-tier shopping list: `sl_next` + `sl_<date>` with role-enriched ingredients.
- **029-recipe-flow-happy-path** — Standalone recipe flow: main menu → list → Add new recipe → meal type → preferences → Save.
- **061-show-shopping-list-recipe-scope** — "Shopping list for the tagine"; dispatcher `show_shopping_list({ scope: 'recipe' })`.
- **062-show-shopping-list-full-week** — "Full shopping list for the week"; dispatcher `show_shopping_list({ scope: 'full_week' })`.

**New helpers:**

- `assertShoppingListCoverage(ctx, scope: 'next_cook' | 'full_week' | 'recipe' | 'day')` — verifies the rendered list carries the expected ingredient roles and counts for the scope (specific checks vary by scope).
- `assertRecipeFlowPersisted(ctx, expected: { slug, mealType })` — recipe flow's resulting recipe file lands in the recipe DB with the expected metadata.

**Steps:**

- [ ] **Step F.1** — Land both helpers.
- [ ] **Step F.2** — Scenario 019: assert tier-1/2/3 structure of `sl_next` + `sl_<date>`.
- [ ] **Step F.3** — Scenario 029: assert recipe persistence + `ctx.finalSession.recipeFlow === null`.
- [ ] **Step F.4** — Scenarios 061, 062: assert dispatcher chose `show_shopping_list` with the expected scope + handler produced the right list.
- [ ] **Step F.5** — `--accept` each.
- [ ] **Step F.6** — Commit: `cert: wave F — shopping + recipes (4 scenarios) + shopping/recipe helpers`.

---

### Wave G: Dispatcher front door

**Scope:** Seven scenarios covering the dispatcher's routing logic (Plan 028). The scenarios here exercise flow_input, out_of_scope, return_to_flow, clarify, cancel-precedence, numeric-prefilter, plan_resume.

**Scenarios:**

- **037-dispatcher-flow-input-planning** — Mutation text during planning proposal phase routes to `flow_input` → re-proposer.
- **038-dispatcher-out-of-scope** — Out-of-domain request → `out_of_scope` + menu.
- **039-dispatcher-return-to-flow** — Side question → `out_of_scope`; "ok back to the plan" → `return_to_flow` re-renders proposal.
- **040-dispatcher-clarify-multiturn** — `clarify` with follow-up turn; recentTurns carries clarification.
- **041-dispatcher-cancel-precedence** — Cancel phrase short-circuits dispatcher; **no dispatcher fixture** for the cancel turn.
- **042-dispatcher-numeric-prefilter** — Numeric pre-filter short-circuits for `awaiting_measurement`; subsequent text dispatches normally.
- **043-dispatcher-plan-resume-callback** — `plan_resume` inline button re-renders proposal via `handleReturnToFlowAction` — **no dispatcher fixture** (callback path).

**Purpose template:** "From [surface], [user input] routes to dispatcher action [action], which produces [outcome] and preserves [state]."

**New helpers:**

- `assertDispatcherActions(ctx, expected: string[])` — `ctx.execTrace.dispatcherActions.map(a => a.action)` matches `expected` exactly. Order-sensitive.
- `assertNoDispatcherCallFor(ctx, turnIndex)` — the Nth text-input event did NOT reach the dispatcher. Use for 041 (cancel) and 043 (callback bypass). Implement by checking `ctx.execTrace.handlers` for `dispatch:text` at that index; if present without a corresponding `dispatcher` entry, the short-circuit fired.

**Notes:**

- Scenarios 041, 042, 043 are the "dispatcher is NOT called" scenarios. Their assertions assert absence; this is a well-formed claim per design doc 004 § "Edge cases" ("Scenarios whose load-bearing claim is 'nothing happened.' Supported.").
- Scenario 042 (numeric pre-filter) should also assert the measurement was persisted via `assertMeasurementPersisted` (helper from Wave D).

**Steps:**

- [ ] **Step G.1** — Land `assertDispatcherActions` and `assertNoDispatcherCallFor` helpers.
- [ ] **Step G.2** — Scenarios 037, 038, 039, 040: dispatcher-called cases.
- [ ] **Step G.3** — Scenarios 041, 042, 043: dispatcher-NOT-called cases.
- [ ] **Step G.4** — `--accept` each.
- [ ] **Step G.5** — Commit: `cert: wave G — dispatcher (7 scenarios) + dispatcher-action helpers`.

---

### Wave H: Mutate plan (Plan 029)

**Scope:** Ten scenarios covering the `mutate_plan` dispatcher action and its appliers (in-session + post-confirmation). The design of these scenarios already covers a broad matrix of mutation shapes.

**Scenarios:**

- **044-mutate-plan-in-session** — In-session mutation via `mutate_plan`; applier's in-session branch delegates to `handleMutationText`.
- **045-mutate-plan-eat-out-tonight** — **THE core Plan D scenario.** Post-confirmation mutation: "I'm eating out tonight"; adapter+re-proposer+solver+diff pipeline; `mp_confirm` persists via `confirmPlanSessionReplacing`.
- **046-mutate-plan-flex-move** — Post-confirmation flex move.
- **047-mutate-plan-recipe-swap** — Post-confirmation recipe swap.
- **048-mutate-plan-side-conversation-mid-planning** — State preservation: off-topic question mid-planning preserves planFlow.
- **049-mutate-plan-adjust-loop** — User taps [Adjust] → types new mutation → [Confirm]; only the second mutation persists.
- **050-mutate-plan-no-target** — Mutation text with no active plan → `no_target` response.
- **051-mutate-plan-meal-type-lane** — Regression lock: lane-crossing mutation caught by re-proposer invariant #14.
- **052-mutate-plan-retroactive-honest** — Retroactive "last night I went to Indian"; past slots frozen; eat-out calories not tracked.
- **053-mutate-plan-post-confirm-clarification-resume** — Ambiguous post-confirmation mutation → clarification → auto-resume → forward-shift → confirm. **Harness lock for invariant #5.**

**Purpose template:** "From [plan state], dispatcher picks `mutate_plan({ ... })`; applier's [in-session | post-confirmation] branch produces [outcome]; mutation history [shows expected entries]; persistence happens via [confirmPlanSession | confirmPlanSessionReplacing | no-op]."

**Common checks (mostly reusing helpers from waves A/B/C/G):**

- `assertDispatcherActions(ctx, ['mutate_plan', ...])` — Wave G helper.
- `assertMutationHistoryLength(ctx, n)` — Wave C helper.
- `assertPlanningHealthy(ctx)` — after mutation lands.
- `assertPreCommittedRespected(ctx)` — for post-confirmation mutations where past slots are frozen.

**Notes:**

- Scenarios 045 and 053 are named as invariant-harness locks in the dispatcher design work. Their `purpose` strings should explicitly name "Plan D Flow 1" (045) and "invariant #5" (053).
- Scenario 050 (`no_target`) asserts the ABSENCE of a plan session in `finalStore` and the presence of the expected advisory text.
- Scenario 052 (retroactive) asserts the measurement persistence does NOT happen for eat-out (no calorie tracking) — subtle but load-bearing.

**Steps:**

- [ ] **Step H.1** — Start with 044 and 045 (simplest + most canonical). Confirm existing helpers suffice.
- [ ] **Step H.2** — Scenarios 046, 047: mutation-shape variants.
- [ ] **Step H.3** — Scenarios 048, 049: state-preservation cases.
- [ ] **Step H.4** — Scenarios 050, 051: rejection / lane-enforcement cases.
- [ ] **Step H.5** — Scenarios 052, 053: retroactive + clarification-resume. If these surface new reusable checks, land them before continuing.
- [ ] **Step H.6** — `--accept` each.
- [ ] **Step H.7** — Commit: `cert: wave H — mutate plan (10 scenarios)`.

---

### Wave I: Secondary actions + cross-cutting

**Scope:** Twelve scenarios covering Plan E's answer/show actions, the log_measurement cross-surface case, cross-action state preservation, and the two free-text/cancel scenarios deferred from earlier waves.

**Scenarios:**

- **017-free-text-fallback** — Lifecycle-aware free-text fallback: no-plan branch + shopping-list-with-no-plan branch.
- **021-planning-cancel-intent** — "Nevermind" during proposal exits planning cleanly — planFlow null, surfaceContext null, main menu.
- **054-answer-plan-question** — Dispatcher picks `answer_plan_question` for "when's my next cook day?".
- **055-answer-recipe-question** — Dispatcher picks `answer_recipe_question` for "can I freeze this?".
- **056-answer-domain-question** — Dispatcher picks `answer_domain_question` for "substitute for tahini?".
- **057-show-recipe-in-plan** — `show_recipe` renders cook view when slug is in active batch.
- **058-show-recipe-library-only** — `show_recipe` falls back to library view when slug is not in plan.
- **059-show-recipe-multi-batch** — `show_recipe` multi-batch picks soonest cook day.
- **060-show-plan-day-detail-natural-language** — `show_plan` resolves "Thursday" to next Thursday's ISO.
- **063-show-progress-weekly-report** — `show_progress({ view: 'weekly_report' })`.
- **064-log-measurement-cross-surface** — `log_measurement` persists from any surface; `surfaceContext` preserved.
- **065-answer-then-mutate-state-preservation** — Cross-action state preservation (clarify + mutate preserves planFlow).

**Purpose template varies by sub-class:**

- Answer actions (054, 055, 056): "Dispatcher picks `answer_X`; the reply is an inline answer; session state unchanged."
- Show actions (057-060, 063): "Dispatcher picks `show_X({ params })`; the renderer produces the expected view; `lastRenderedView` reflects the resulting surface."
- 017: "Free-text that the dispatcher declines as out-of-scope produces lifecycle-aware guidance, not a generic fallback."
- 021: "The cancel meta-intent short-circuits the dispatcher and cleanly exits planning state."
- 064: "Measurement logging works from a non-progress surface; `surfaceContext` stays on the originating surface."
- 065: "Cross-action sequences (e.g., answer then mutate) preserve the planning flow state across both actions."

**New helpers:**

- `assertAnsweredInline(ctx, substring: string)` — the output contains the expected answer substring AND no downstream handler was invoked (so the answer is "just" a reply).
- `assertRenderedScope(ctx, expectedScope: { surface, view })` — `ctx.finalSession.lastRenderedView` matches the expected (surface, view) shape.

**Steps:**

- [ ] **Step I.1** — Land `assertAnsweredInline` and `assertRenderedScope` helpers.
- [ ] **Step I.2** — Scenarios 054-056 (answer actions).
- [ ] **Step I.3** — Scenarios 057-060, 063 (show actions).
- [ ] **Step I.4** — Scenario 017 (free-text fallback): nuanced — two branches in one scenario. Purpose names the lifecycle-aware behavior.
- [ ] **Step I.5** — Scenario 021 (cancel intent): reuses `assertNoDispatcherCallFor` from Wave G for the cancel turn.
- [ ] **Step I.6** — Scenario 064: cross-surface measurement. Reuses `assertMeasurementPersisted` (Wave D) + surfaceContext check.
- [ ] **Step I.7** — Scenario 065: the cross-action state-preservation lock. Asserts `planFlow` survives both a `clarify` and a `mutate_plan` dispatch.
- [ ] **Step I.8** — `--accept` each.
- [ ] **Step I.9** — Commit: `cert: wave I — secondary actions + cross-cutting (12 scenarios)`.

---

### Phase J: Finalization

**Goal:** Confirm the audit landed cleanly, reconcile stamped vs. unstamped scenarios against the tech-debt file, update docs, close out the plan.

**Steps:**

- [ ] **Step J.1** — Run `npm run review` and collect the status distribution:
  - 62 scenarios listed (61 migrated in this plan + 014 from Plan 031).
  - Count of `[certified]`, `[uncertified]`, `[needs-review]`, `[obsolete]`.
  - Expected: `certified + obsolete == 62`, `uncertified + needs-review == 0` in the happy case. Any `[needs-review]` means something drifted during the audit (likely a late helper change shifted `assertionsHash`) — run a final `--accept` on the affected scenarios.

- [ ] **Step J.2** — Reconcile unstamped scenarios against `docs/plans/scenario-migration-tech-debt.md`:
  - Every `[uncertified]` scenario MUST have a corresponding open tech-debt entry with `Blocked certification? Yes` naming that scenario. If a scenario is uncertified without a matching entry, the audit missed it — loop back and either add the entry or certify the scenario.
  - Every tech-debt entry marked `Blocked certification? Yes` MUST name a real `[uncertified]` scenario in the review output. Orphan entries (claiming to block something that's already certified) mean the blocker was resolved without the entry being closed — close the entry now.
  - Having some `[uncertified]` scenarios at the end of audit cycle one is acceptable if each one is a documented blocker. The goal is "every scenario is either certified or has a known-documented reason it isn't," not "zero uncertified at all costs."

- [ ] **Step J.3** — Run `npm test` — all scenarios pass with global invariants + `assertBehavior` + the existing three `deepStrictEqual` checks. Uncertified scenarios still pass `npm test` via replay + invariants + `deepStrictEqual` (they just don't have an `assertBehavior` body asserting their load-bearing claim).

- [ ] **Step J.4** — Update `test/scenarios/index.md` — optional: add a "Certified" column and mark every row. Decide in Wave A whether to include this column; if yes, populate it during each wave's commit; if no, skip J.4.

- [ ] **Step J.5** — Update `docs/product-specs/testing.md` — add a one-line note under § "Certification workflow" that audit cycle one is complete. If some scenarios remain uncertified, say so and point to `docs/plans/scenario-migration-tech-debt.md`.

- [ ] **Step J.6** — Update `CLAUDE.md` — if relevant, promote `npm run review` to a more prominent debug workflow step now that every scenario has a purpose string worth reading. Add a pointer to `docs/plans/scenario-migration-tech-debt.md` under the debug workflow section if the tech-debt file has meaningful entries.

- [ ] **Step J.7** — Move `docs/plans/active/032-certification-audit-cycle-one.md` → `docs/plans/completed/032-certification-audit-cycle-one.md`. Update status to `Completed`. `docs/plans/scenario-migration-tech-debt.md` stays in `docs/plans/` (not under `active/` or `completed/`) — it's a running inventory, not a plan. Items get closed as bugs are fixed in follow-up work; the file retains history via the "Closed" section.

- [ ] **Step J.8** — Commit: `cert: finalize audit cycle one — <N> scenarios certified, <M> deferred to tech-debt`.

---

## Progress

- [ ] Phase 0: Tech-debt file scaffold
- [ ] Wave A: Planning happy path (3 scenarios)
- [ ] Wave B: Rolling horizon (7 scenarios)
- [ ] Wave C: Planning mutations via re-proposer (8 scenarios)
- [ ] Wave D: Progress (2 scenarios)
- [ ] Wave E: Navigation + views (8 scenarios)
- [ ] Wave F: Shopping + recipes (4 scenarios)
- [ ] Wave G: Dispatcher front door (7 scenarios)
- [ ] Wave H: Mutate plan (10 scenarios)
- [ ] Wave I: Secondary actions + cross-cutting (12 scenarios)
- [ ] Phase J: Finalization + tech-debt reconciliation

Running total: 61 scenarios to certify.

---

## Decision log

- **Decision:** Scenarios migrate in waves grouped by class, not sequentially by number.
  **Rationale:** Adjacent scenarios by number are not usually adjacent by semantic class (e.g., 029 is recipe flow, wedged between navigation (028) and navigation-state-tracking (030)). Grouping by class lets the agent land a helper once and reuse it across a whole wave. Sequential-by-number would require jumping helper contexts constantly.
  **Date:** 2026-04-13

- **Decision:** Domain helpers are added incrementally, per wave, not up-front.
  **Rationale:** The complete list of needed helpers is not knowable without reading scenarios. Adding them as waves surface needs means the helper library reflects real usage, not speculation. The "expected helper additions" column in the wave overview is a starting hypothesis, not a commitment.
  **Date:** 2026-04-13

- **Decision:** Commit at wave granularity, not per-scenario.
  **Rationale:** Per-scenario commits produce 61 tiny commits whose history is hard to read. Per-wave commits produce 9 meaningful chunks that map to the wave table. If a specific scenario's migration is particularly noteworthy (surfaces a bug, needs multiple helpers), the agent can commit it standalone before the wave-level commit; default is wave-level.
  **Date:** 2026-04-13

- **Decision:** Scenarios 009 and 013 are deferred from Wave B to Wave C if the re-proposer helpers don't land in B.4.
  **Rationale:** These two scenarios sit at the intersection of rolling-horizon and re-proposer mutations. Either wave could own them. Writing assertions for them BEFORE Wave C's helpers land would force duplication of the re-proposer checks inline; waiting until C makes the code DRY.
  **Date:** 2026-04-13

- **Decision:** "Dispatcher NOT called" scenarios (041, 043) are asserted via trace absence, not presence.
  **Rationale:** Design doc 004 § "Edge cases" explicitly supports absence claims. `assertNoDispatcherCallFor(ctx, turnIndex)` is the idiomatic helper; it inspects `ctx.execTrace` and fails if a dispatcher event is present for a turn that should have short-circuited. Much cleaner than trying to assert the presence of alternate code paths.
  **Date:** 2026-04-13

- **Decision:** Obsolete scenarios are kept on disk with a stamped `certification.json { status: 'obsolete' }`, not deleted.
  **Rationale:** Design doc 004 § "Edge cases": obsolete scenarios "replay (so future code changes don't break them silently) but are filtered out of `--needs-review`. Preserves history without cluttering the review backlog." Deletion is reserved for scenarios that are truly irrelevant — a stronger claim than obsolete.
  **Date:** 2026-04-13

- **Decision:** Regenerations required during the audit (to fix bugs surfaced by behavioral review) use the serial-review rule from CLAUDE.md.
  **Rationale:** CLAUDE.md § "Regenerate in parallel, review serially" — when an audit turns up a real code bug, fix + regenerate + review + `--accept` must stay a per-scenario serial sequence. Parallelizing the review step is the exact failure mode the project's debug workflow exists to prevent.
  **Date:** 2026-04-13

- **Decision:** Bugs discovered during the audit get classified and routed at discovery time; only load-bearing bugs block certification, the rest go to `docs/plans/scenario-migration-tech-debt.md` and the scenario is certified around them.
  **Rationale:** Two tensions collide in this audit: (a) a certified stamp must not rubber-stamp broken behavior, (b) inline-fixing every discovered bug serializes the 61-scenario audit against arbitrary feature work and derails the wave cadence. Classification resolves the tension — load-bearing bugs DO block certification (so the stamp's trust surface stays honest), but adjacent/cross-scenario bugs get parked in a visible inventory and the scenario can honestly be certified on the non-buggy part of its claim. `deepStrictEqual` still locks the current (buggy) output so a future fix surfaces as a diff, which is the regression-net behavior the harness was designed to deliver. The new tech-debt file is deliberately separate from `docs/plans/tech-debt.md` so audit-discovered debt doesn't mix with LLM-quality debt or unrelated deferred cleanup.
  **Date:** 2026-04-13

- **Decision:** `docs/plans/scenario-migration-tech-debt.md` lives directly under `docs/plans/`, not in `active/` or `completed/`.
  **Rationale:** It's a running inventory, not a plan with a lifecycle. Bugs get logged and closed over time independently of the audit plan's completion. Parallels the existing `docs/plans/tech-debt.md` which also lives at that level. The "Open" and "Closed" sections inside the file carry the lifecycle; moving the whole file between directories would misrepresent what's in it.
  **Date:** 2026-04-13

---

## Validation

End-to-end:

1. `npm run review` reports 62 scenarios. Every scenario has an explicit status: `certified`, `obsolete` (with a documented reason), or `uncertified` (with a matching open entry in `docs/plans/scenario-migration-tech-debt.md`). Zero `[needs-review]`. `uncertified` count matches the count of `Blocked certification? Yes` entries in the tech-debt file.
2. `npm test` passes with the full verification pipeline: global invariants + `assertBehavior` + `deepStrictEqual` + per-step checks for `captureStepState` scenarios. Uncertified scenarios still pass `npm test` — they just lack an `assertBehavior` body.
3. `src/harness/domain-helpers.ts` has grown to ~15-20 helpers covering planning, rolling horizon, mutations, progress, navigation, shopping, dispatcher, and secondary actions. Every helper has a unit test in `test/unit/domain-helpers.test.ts`.
4. `test/scenarios/*/assertions.ts` exists for every scenario directory that was certified (or explicitly obsolete with documented reason). Uncertified scenarios may have no `assertions.ts` — the tech-debt entry explains what's missing.
5. `test/scenarios/*/certification.json` exists for every certified or obsolete scenario directory.
6. Reading any `assertions.ts` makes the scenario's purpose obvious in <30 seconds. The one-sentence `purpose` export is sufficient to understand the scenario without reading `spec.ts` or the recording.
7. Running `git log` over this plan shows ~9-11 commits, each mapping to a wave or a standalone scenario.
8. `docs/plans/scenario-migration-tech-debt.md` exists and has entries for every bug discovered during the audit. Each entry names scenarios affected, severity, and fix direction. The file's "Open" section is a complete inventory of audit-discovered deferred work.

Spot checks:

- Pick 3 random scenarios from 3 different waves. For each, confirm:
  - `purpose` is a single sentence and makes sense in isolation.
  - `assertBehavior` calls at least one domain helper.
  - `certification.json` is present with `status: certified` and current hashes.
- Pick a regression target: change a telegram reply string in code that several scenarios capture. Run `npm test` — those scenarios fail loudly on `deepStrictEqual` (the regression net still works post-audit). Run `npm run review` — those scenarios transition to `needs-review` (hash drift). Revert the change; scenarios return to green + certified.
- Temporarily break `assertPlanningHealthy` (set a fake error threshold). Run `npm run review -- 001-plan-week-happy-path --accept` — `--accept` refuses because `assertBehavior` fails, no stamp rewrite. Revert.

---

## Feedback
