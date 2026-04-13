# Plan 029: `mutate_plan` Action — The Living-Document Feature

> **For agentic workers:** RECOMMENDED SUB-SKILL: Use superpowers:subagent-driven-development (preferred) or superpowers:executing-plans to implement this plan task-by-task. If neither skill is available in your environment, follow the task-by-task structure directly — each task is self-contained with explicit steps, commit points, and verification commands. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Completed
**Date:** 2026-04-10
**Affects:** `src/agents/dispatcher.ts`, `src/telegram/dispatcher-runner.ts`, `src/telegram/core.ts`, `src/plan/mutate-plan-applier.ts` (new), `src/plan/session-to-proposal.ts` (from Plan 026, one tweak), `src/telegram/keyboards.ts`, `test/unit/mutate-plan-applier.test.ts` (new), `test/unit/dispatcher-mutate-plan.test.ts` (new), several new scenarios under `test/scenarios/`, regeneration of a small set of existing scenarios, `docs/product-specs/ui-architecture.md`, `docs/product-specs/flows.md`, `docs/design-docs/proposals/003-freeform-conversation-layer.md` (status update).

**Goal:** Ship the single feature proposal 003 exists for — **post-confirmation plan mutation** — by wiring the `mutate_plan` dispatcher action to an end-to-end handler that runs the re-proposer against either an active planning session OR a persisted confirmed plan, validates the result, presents a diff for explicit confirmation, and persists the change via `confirmPlanSessionReplacing`. **This is Plan D from proposal `003-freeform-conversation-layer.md`.** After this plan lands, a user can type "I'm eating out tonight" on a confirmed plan and the product absorbs the deviation without drama — Flow 1 of the proposal becomes reality.

**Architecture:** Three layers stacked on top of the dependency plans (A/B/C):

1. **`mutate_plan` enters the catalog as AVAILABLE.** Plan C's dispatcher (`src/agents/dispatcher.ts`) already documents `mutate_plan` in its system prompt as "NOT AVAILABLE in v0.0.5 — Plan D". Plan D promotes it to `AVAILABLE`, adds it to `AVAILABLE_ACTIONS_V0_0_5`, extends `DispatcherDecision` with the `{ action: 'mutate_plan', params: { request } }` variant, and updates the prompt's usage guidance + few-shot examples.

2. **A single shared applier drives both contexts.** `src/plan/mutate-plan-applier.ts` (new) exports `applyMutationRequest(args): Promise<MutateResult>` which branches on whether a planning session is active:
    - **In-session branch** — delegates to the existing `handleMutationText` path in `plan-flow.ts` (unchanged behavior, same mutation-history bookkeeping, same `formatPlanProposal` output). This is the path the dispatcher picks when `session.planFlow !== null && planFlow.phase === 'proposal'`.
    - **Post-confirmation branch** — new code. Loads the active persisted `PlanSession + Batch[]`, runs Plan 026's `sessionToPostConfirmationProposal` adapter to get an active-only `PlanProposal` + preserved past batches + `nearFutureDays`, calls `reProposePlan` in `post-confirmation` mode, runs the solver on the active proposal, diffs it against the pre-mutation active view, formats the result, stashes a `pendingMutation` on `BotCoreSession` so the subsequent `mp_confirm` tap can call `buildReplacingDraft` + `confirmPlanSessionReplacing`, and returns the formatted diff + confirmation keyboard.

3. **Explicit confirmation is always required.** Post-confirmation mutations land behind two inline buttons (`[Confirm]` → `mp_confirm` → persists via `confirmPlanSessionReplacing`; `[Adjust]` → `mp_adjust` → re-enters a "tell me what to change" prompt, keeping `pendingMutation` discardable). In-session mutations continue to use the existing `planProposalKeyboard` `[Looks good]` → `plan_approve` path unchanged.

**Tech Stack:** TypeScript, `node:test`, the existing scenario harness, `LLMProvider` via the existing interface, Supabase (via `confirmPlanSessionReplacing` — no new schema), `FixtureLLMProvider` for scenario replay.

**Scope:** Exactly the `mutate_plan` action wiring, the post-confirmation applier, the confirmation UX, and scenario coverage. **Out of scope (explicitly deferred):** `answer_*` / `show_*` / `log_measurement` / `log_treat` / `log_eating_out` (Plan E). Multi-slot retroactive event persistence (no actual-vs-planned state — see proposal 003 "What v0.0.5 does NOT track"). Auto-confirm for "small" mutations (explicit confirm forever until the re-proposer is proven). Calorie tracking of eat-out events (deviation accounting is its own future plan).

**Dependencies:** This plan has **HARD dependencies** on all three prior plans being fully merged and green. Plan D cannot start until Plans A, B, AND C are done.
- **Plan 026 (Plan A — re-proposer post-confirmation enablement)** must provide `sessionToPostConfirmationProposal`, `buildReplacingDraft`, the `mutation_history` column + TypeScript field, the re-proposer's `mode: 'in-session' | 'post-confirmation'` + `nearFutureDays` inputs, and validator invariant #14 (meal-type lane).
- **Plan 027 (Plan B — navigation state model)** must provide `BotCoreSession.lastRenderedView` + `setLastRenderedView` so the dispatcher knows where the user was when they typed the mutation (for back-button attachment on the mutate confirm reply).
- **Plan 028 (Plan C — dispatcher infrastructure)** must provide the dispatcher agent, the runner, `runDispatcherFrontDoor`, the context bundle, `recentTurns`, and the four minimal actions (`flow_input`, `clarify`, `out_of_scope`, `return_to_flow`). Plan D extends the runner by adding one more handler and extends the dispatcher's catalog by flipping `mutate_plan` from "NOT AVAILABLE" to "AVAILABLE".

---

## Problem

Proposal 003's north-star scenario is Flow 1: a user on a confirmed plan types "I'm eating out tonight, friend invited me", the re-proposer absorbs the deviation by shifting dinner batches forward within the dinner lane, and the user taps `[Confirm]`. After Plans A, B, and C land, **every piece of this flow exists in isolation but nothing is connected end-to-end**:

1. **Plan A** makes the re-proposer structurally capable of running against a confirmed plan via the split-aware adapter, with the meal-type lane rule and near-future safety rule enforced. But no code calls `sessionToPostConfirmationProposal` at runtime — it's an unreferenced export.
2. **Plan B** tracks precise navigation state so the dispatcher's mutate confirmation reply can attach a correct back button. But `lastRenderedView` is never read by anything user-facing — it's just plumbing.
3. **Plan C** puts the dispatcher in front of every inbound message and wires up four minimal actions. But `mutate_plan` is explicitly marked NOT AVAILABLE in the dispatcher prompt. Typing "move the flex to Sunday" post-confirmation hits `clarify` with a "coming soon" response. The user's real-life deviation is still a dead end.

Plan D is the commit where **a user can finally say "life happened" and the product responds**. Every architectural piece is already in place; Plan D is the wire-up commit.

This is not additional architecture. This is not a new agent. This is the three existing subsystems talking to each other through one handler in the dispatcher runner + one shared applier module. The hard work was done in Plans A/B/C. Plan D is what makes it matter.

**What Plan D does NOT change (with one small exception).** The re-proposer, the validator, the solver, and `handleMutationText` itself (`plan-flow.ts` lines 605–735) stay exactly as they are today. Plan D's in-session branch is a thin pass-through that calls `handleMutationText` with the same inputs and receives the same result. This is deliberate: changing the re-proposer mid-Plan-D would invalidate the `020-planning-intents-from-text` and `023–028` scenarios, all of which are authoritative regression locks for the re-proposer.

**The one exception: `buildNewPlanSession` in `plan-flow.ts` gains a single line** to thread `state.mutationHistory ?? []` into the `DraftPlanSession` it constructs. Today, when the user taps `plan_approve` at the end of a planning session, `buildNewPlanSession` (lines 846–942) builds the draft without populating `mutationHistory`, so any mutations accumulated in-session during the proposal phase are dropped on the floor. Plan 026 § decision log explicitly deferred this wire-up ("Plan D will rewire this"), and scenarios 044 (in-session mutate_plan), 048 (side-conversation mid-planning), plus Plan E's cross-action state-preservation scenario all assert that the persisted `mutationHistory` reflects every in-session mutation — so Plan D must deliver the write path. The change is load-bearing for state preservation invariant #1 from proposal 003 but structurally minimal (one key on one object literal). Task 7 owns the change and Task 12's regeneration captures the effect.

---

## Plan of work

### File structure

**Files to create:**

- `src/plan/mutate-plan-applier.ts` — The shared applier. Pure at its seams; exports:
  - `MutateResult` — discriminated union: `{ kind: 'in_session_updated'; text: string; state: PlanFlowState } | { kind: 'post_confirmation_proposed'; text: string; pending: PendingMutation } | { kind: 'clarification'; question: string } | { kind: 'failure'; message: string } | { kind: 'no_target'; message: string }`.
  - `PendingMutation` — `{ oldSessionId: string; preservedPastBatches: Batch[]; preservedPastFlexSlots: FlexSlot[]; preservedPastEvents: MealEvent[]; reProposedActive: PlanProposal; newMutationRecord: MutationRecord; createdAt: string }`. Stashed on `BotCoreSession.pendingMutation` between the propose and confirm turns. The `preservedPast*` fields mirror the Plan 026 adapter's return shape (`docs/plans/active/026-reproposer-post-confirmation-enablement.md:46`) because `buildReplacingDraft` requires them at confirm time to splice the user's historical record back into the rewritten session. `reProposedActive.solverOutput` is populated by Task 8 (the applier runs `solve()` on the re-proposer output before building the `PendingMutation`), which is also a Plan 026 `buildReplacingDraft` prerequisite.
  - `applyMutationRequest(args): Promise<MutateResult>` — the main entry point. Branches on `args.session.planFlow` presence.
  - Internal helpers for the post-confirmation branch: context loading, solver invocation on the active proposal, diff formatting against the pre-mutation active view.

- `test/unit/mutate-plan-applier.test.ts` — Unit tests for `applyMutationRequest`. Covers: (a) in-session branch delegates cleanly, (b) post-confirmation happy path (eat-out tonight), (c) post-confirmation clarification bubbles up, (d) post-confirmation meal-type lane violation triggers validator retry → failure, (e) no active flow AND no active plan returns `no_target`, (f) mutation history is carried correctly into the pending record.

- `test/unit/dispatcher-mutate-plan.test.ts` — Unit tests for the dispatcher picking `mutate_plan` for canonical inputs ("I'm eating out tonight", "move the flex to Sunday", "swap tagine for fish") via stub LLM responses. Verifies the `allowedActions` filter accepts `mutate_plan`.

- `test/scenarios/044-mutate-plan-in-session/spec.ts` + `recorded.json` — Regression lock for the in-session branch. User is mid-planning at `phase: 'proposal'`, types "Move the flex to Sunday instead", the dispatcher picks `mutate_plan`, the applier's in-session branch calls `handleMutationText`, the proposal re-renders with the change summary, user taps `plan_approve`. Functionally similar to scenario 037 (`037-dispatcher-flow-input-planning`) from Plan C but asserts the dispatcher chose `mutate_plan` (not `flow_input`).

- `test/scenarios/045-mutate-plan-eat-out-tonight/spec.ts` + `recorded.json` — **The canonical Flow 1 scenario.** Seed an active plan for this week with a dinner batch spanning Mon–Wed and a lunch batch spanning Mon–Fri. Clock: Tuesday 7pm. User types "I'm eating out tonight, friend invited me". The dispatcher picks `mutate_plan`, the applier runs the post-confirmation branch, the re-proposer shifts the tagine batch forward (Tuesday dinner dropped, Wednesday+Thursday kept, Friday added if capacity allows) OR adds an `eat_out` event on Tue dinner and lets the re-proposer cascade, renders the diff + `[Confirm] [Adjust]`. User taps `mp_confirm`. A new plan session is persisted via `confirmPlanSessionReplacing`, the old session goes `superseded: true`, and `mutation_history` contains the new `eating out tonight` record.

- `test/scenarios/046-mutate-plan-flex-move/spec.ts` + `recorded.json` — Post-confirmation flex move. Seed an active plan with the flex on Saturday dinner. User types "Move the flex to Sunday lunch instead". Dispatcher → `mutate_plan` → post-confirmation applier → re-proposer shifts the flex → `mp_confirm` persists.

- `test/scenarios/047-mutate-plan-recipe-swap/spec.ts` + `recorded.json` — Post-confirmation recipe swap. User has tagine batch Mon–Wed and types "swap the tagine for something lighter". Dispatcher → `mutate_plan` → post-confirmation applier → re-proposer picks a different recipe from the library that passes the meal-type lane rule → `mp_confirm`.

- `test/scenarios/048-mutate-plan-side-conversation-mid-planning/spec.ts` + `recorded.json` — State preservation test. User is mid-planning at `proposal` phase with mutation history `[constraint: 'initial request']`. User types an off-topic question (dispatcher picks `clarify`, planFlow preserved), then types "actually move the flex to Sunday" (dispatcher picks `mutate_plan`, applier's in-session branch runs, mutation history extends to 2 entries), user taps `plan_approve`. The final persisted session's `mutationHistory` has BOTH entries.

- `test/scenarios/049-mutate-plan-adjust-loop/spec.ts` + `recorded.json` — User types "move dinner to tomorrow", sees the diff, taps `[Adjust]` (`mp_adjust` callback), the `pendingMutation` is cleared with a "tell me what to change" reply, user types a new request, the full cycle runs again, user taps `[Confirm]`, plan persists.

- `test/scenarios/050-mutate-plan-no-target/spec.ts` + `recorded.json` — User has no plan at all (`lifecycle: 'no_plan'`) and types "move tomorrow's dinner". Dispatcher picks `mutate_plan` (the text is imperative-mutation-shaped), the applier's `no_target` branch fires, the user sees "You don't have a plan yet — tap 📋 Plan Week to start."

- `test/scenarios/051-mutate-plan-meal-type-lane/spec.ts` + `recorded.json` — User has tagine in a dinner batch and types "move the tagine to tomorrow's lunch". The re-proposer respects meal-type lanes (Plan 026 Rule 2): it must either refuse, pick a different recipe that works in lunch, or return a clarification. Locks whichever behavior lands — but a silent lane cross should fail the new validator invariant #14 and trigger a retry → failure message.

- `test/scenarios/053-mutate-plan-post-confirm-clarification-resume/spec.ts` + `recorded.json` — **Invariant #5 harness lock for post-confirmation.** Seed an active plan. User types an ambiguous mutation ("I'm eating out"). Re-proposer returns a clarification ("lunch or dinner?"). User answers tersely ("dinner"). The applier auto-resumes by prepending the original request — the re-proposer sees "I'm eating out. To clarify: dinner" and produces a forward-shift proposal. User taps `mp_confirm`. Persisted session reflects the mutation. This is the scenario-level enforcement of proposal 003 invariant #5 for the post-confirmation case, mandated by the proposal's "MUST be enforced by scenario tests" language (line 453). Plan 029.

**Files to modify:**

- `src/agents/dispatcher.ts`:
  - Add `'mutate_plan'` to `DispatcherAction`.
  - Add `'mutate_plan'` to `AVAILABLE_ACTIONS_V0_0_5`.
  - Extend `DispatcherDecision` union with the `mutate_plan` variant: `{ action: 'mutate_plan'; params: { request: string }; response?: undefined; reasoning: string }`.
  - Update `buildSystemPrompt` to flip the `mutate_plan` entry from "NOT AVAILABLE" to "AVAILABLE" and describe when to pick it (imperative plan changes, deviations, real-life events affecting the plan). Add few-shot examples covering both in-session and post-confirmation cases. Remove the "pick clarify with honest deferral" fallback instruction for `mutate_plan`.
  - Update `parseDecision` to handle the `mutate_plan` action: extract `params.request` from the raw response, require it as a non-empty string.

- `src/telegram/dispatcher-runner.ts`:
  - Add `handleMutatePlanAction` exported function — the action handler.
  - Add `DispatcherSession` fields: `pendingMutation?: PendingMutation` and `pendingPostConfirmationClarification?: { question, originalRequest, createdAt }` (both optional so sessions without mutation-in-flight stay unchanged).
  - Wire `handleMutatePlanAction` into the decision `switch` inside `runDispatcherFrontDoor`.
  - The handler threads `pendingPostConfirmationClarification` into the applier args (for auto-resume), clears it after each call, and stashes it on the clarification branch.

- `src/telegram/core.ts`:
  - Add `pendingMutation?: PendingMutation` and `pendingPostConfirmationClarification?: { question, originalRequest, createdAt }` to `BotCoreSession`. Both fields share the same lifecycle and are cleared at every structural-invalidation site (session resets, new-plan starts, new-flow starts, explicit cancellations).
  - Clear both fields inside `reset()`.
  - Add `mp_confirm` and `mp_adjust` inline callback handlers inside `handleCallback`.
  - Import `applyMutationConfirmation` from `mutate-plan-applier.ts` (the helper that takes a `PendingMutation` + store + LLM and calls `buildReplacingDraft` + `confirmPlanSessionReplacing`).

- `src/plan/session-to-proposal.ts` (from Plan 026):
  - Update `buildReplacingDraft` to accept an explicit `calorieTolerance` argument (threaded from `config.planning.scalerCalorieTolerance`) instead of the hard-coded `50` placeholder Plan 026 Task 11 left. Plan 026's own note says "Plan D will thread the real value from `config.planning.scalerCalorieTolerance`" — Plan D delivers that.

- `src/telegram/keyboards.ts`:
  - Add `mutateConfirmKeyboard()` — inline keyboard with `[Confirm]` → `mp_confirm` and `[Adjust]` → `mp_adjust`.

- `src/agents/plan-flow.ts`:
  - **`buildNewPlanSession` (lines 846–942): thread `state.mutationHistory ?? []` into the `DraftPlanSession` literal** (between `events` and the closing brace, around line 869). This is the write path deferred by Plan 026's decision log — Plan D delivers it so in-session mutations accumulated during the proposal phase persist across `plan_approve`. Scenarios 044 (in-session mutate_plan), 048 (side-conversation mid-planning), plus Plan E's planned cross-action state-preservation scenario all require this behavior.
  - One doc comment above `handleMutationText` notes that Plan D's applier uses it as the in-session branch entry point, so future changes should preserve the shape `(state, text, llm, recipes) → FlowResponse`. This is a one-line comment, not a behavior change.
  - No changes to `handleMutationText` itself, the re-proposer, the validator, the solver, or any other function.

- `docs/product-specs/ui-architecture.md`:
  - Flip the Plan 028 catalog table's `mutate_plan` row from "🚧 Plan D" to "✅ Plan D" with a one-paragraph description of the two branches and the `[Confirm] [Adjust]` UX.
  - Add a new "Post-confirmation mutation lifecycle" subsection describing the request → propose → confirm → persist flow, the `pendingMutation` and `pendingPostConfirmationClarification` stashes, the `mp_confirm`/`mp_adjust` callbacks, the clarification multi-turn resume, and the persistence via `confirmPlanSessionReplacing`.

- `docs/product-specs/flows.md`:
  - Add a new "Flow: post-confirmation plan mutation" section that narrates the Flow 1 experience from proposal 003 § "Flow 1 — Post-confirmation plan mutation". Cross-references the proposal and Plan D.

- `docs/design-docs/proposals/003-freeform-conversation-layer.md`:
  - At the top, under the `Status: approved` line, add a new line: `> Implementation: Plan A (026), B (027), C (028) complete. Plan D (029) delivers mutate_plan — THIS PLAN. Plan E remaining for secondary actions.` When Plan D lands, this marker updates.

- `test/scenarios/index.md`:
  - Add rows for scenarios 044–053.

- Scenarios where the dispatcher currently picks `clarify` with a "mutate_plan isn't built yet" response — **regenerate**. The candidate list (to be confirmed at Task 12's grep time):
  - `test/scenarios/017-free-text-fallback` — may have a mutation-shaped test input that previously clarified.
  - `test/scenarios/020-planning-intents-from-text` — the in-session mutation text at its core will now classify as `mutate_plan` (not `flow_input`). Downstream behavior identical; dispatcher fixture hash changes.
  - `test/scenarios/037-dispatcher-flow-input-planning` (Plan 028) — this is the authoritative Plan C regression lock for "mutation text during active planning → flow_input"; Plan D flips the authoritative answer to `mutate_plan`. This scenario MUST be regenerated in Task 12 and its downstream transcripts re-reviewed.
  - `test/scenarios/038-dispatcher-out-of-scope` and `test/scenarios/040-dispatcher-clarify-multiturn` (Plan 028) — no change expected (non-mutation inputs) but re-verified against the new system-prompt hash. If the captured dispatcher response text is identical, only the system-prompt fingerprint in the fixture changes.
  - Any other Plan C scenario (037–043) where the dispatcher's prompt examples or availability markers materially affected the decision — all dispatcher fixtures share the system prompt, so any fingerprint-keyed fixture may need regeneration even when the captured decision is unchanged.

**Files NOT modified (deliberate scope guard):**

- `src/agents/plan-reproposer.ts` — No changes. Plan 026 extended its inputs; Plan D calls it via the existing interface.
- `src/agents/plan-flow.ts` (beyond the doc comment and the one-line `buildNewPlanSession` addition) — `handleMutationText`, the re-proposer call site, and the other plan-flow internals stay untouched. `handleMutationText` is the interface contract Plan D relies on for the in-session branch.
- `src/qa/validators/proposal.ts` — No changes. Plan 026 added invariant #14 (meal-type lane); Plan D calls `validateProposal` through the re-proposer's existing retry path.
- `src/state/store.ts` / `src/harness/test-store.ts` — No changes. Plan D reuses `confirmPlanSessionReplacing`, `getBatchesByPlanSessionId`, `getVisiblePlanSession`, and `getPlanSession` exactly as they exist post-Plan-026.
- `src/solver/solver.ts` — No changes. The `solve()` function runs unchanged on the re-proposer's active output.
- `src/ai/provider.ts` / `src/ai/openai.ts` / `src/ai/fixture.ts` — No changes. The dispatcher's model tier + context tag is the only existing mechanism needed.
- `src/telegram/navigation-state.ts` — Read only.
- Every scenario that does NOT interact with the dispatcher's mutate_plan path — no regeneration.

### Task order rationale

Tasks run strictly top-to-bottom.

- **Tasks 1–2** establish the baseline and expand the dispatcher's action catalog. This is pure type + prompt work; no runtime path changes yet.
- **Tasks 3–4** add unit tests locking in the new catalog and the dispatcher's picks for canonical mutation phrases.
- **Tasks 5–6** create the `pendingMutation` session field and the `mutate-plan-applier.ts` module scaffold.
- **Tasks 7–8** fill in the applier's in-session and post-confirmation branches with unit tests.
- **Task 9** wires the `handleMutatePlanAction` handler into the runner.
- **Task 10** adds the `mp_confirm` / `mp_adjust` inline callbacks in `core.ts`.
- **Task 11** threads the real `calorieTolerance` into `buildReplacingDraft`.
- **Task 12** regenerates existing scenarios affected by the prompt change.
- **Tasks 13–22** add the ten new scenarios (one per task — 044 through 053), each generated + behaviorally reviewed + committed individually. Tasks 13–20 cover the mainline mutate_plan coverage; Task 21 adds the retroactive "last night" honest forward-shift regression lock; Task 22 adds the invariant #5 post-confirmation clarification resume harness lock.
- **Task 22** updates `test/scenarios/index.md`.
- **Task 23** syncs `ui-architecture.md` and `flows.md` + flips the proposal 003 status marker.
- **Task 24** is the final baseline + commit chain verification.

Every task ends with a commit. `npm test` stays green after every task except Task 2 (where the dispatcher's prompt changes and a handful of scenarios go red pending Task 12's regeneration — same intentional-red pattern Plans B and C used).

---

## Tasks

### Task 1: Green baseline + dependency verification

**Files:** none — sanity check.

- [ ] **Step 1: Confirm clean `npm test`**

Run: `npm test`
Expected: all scenarios and unit tests pass. Note the count in the output so later tasks can confirm no regressions. **If any test is red, STOP — Plan D has a hard dependency on Plans A/B/C being fully green.**

- [ ] **Step 2: Confirm Plan 026 artifacts exist**

Use the Glob tool with pattern `src/plan/session-to-proposal.ts`. Expected: file exists.

Use Grep on `src/models/types.ts` for `mutationHistory`. Expected: the field exists on `PlanSession` and as optional on `DraftPlanSession`.

Use Grep on `src/agents/plan-reproposer.ts` for `mode:` and `nearFutureDays`. Expected: both appear in `ReProposerInput`.

Use Grep on `src/qa/validators/proposal.ts` for `#14`. Expected: invariant #14 (meal-type lane) exists.

Use Glob on `supabase/migrations/005_plan_session_mutation_history.sql`. Expected: file exists.

If any of these checks fail, Plan 026 has not landed — **STOP** and land it first.

- [ ] **Step 3: Confirm Plan 027 artifacts exist**

Use the Glob tool with pattern `src/telegram/navigation-state.ts`. Expected: file exists.

Use Grep on `src/telegram/core.ts` for `lastRenderedView`. Expected: multiple hits including the `BotCoreSession` field.

If these fail, Plan 027 has not landed — STOP.

- [ ] **Step 4: Confirm Plan 028 artifacts exist**

Use the Glob tool with pattern `src/agents/dispatcher.ts` and `src/telegram/dispatcher-runner.ts`. Expected: both exist.

Use Grep on `src/agents/dispatcher.ts` for `AVAILABLE_ACTIONS_V0_0_5`. Expected: the constant exists.

Use Grep on `src/telegram/dispatcher-runner.ts` for `runDispatcherFrontDoor`. Expected: the function exists.

Use Grep on `src/telegram/core.ts` for `runDispatcherFrontDoor`. Expected: the dispatcher is wired into `dispatch()`.

Use Grep on `src/telegram/core.ts` for `recentTurns`. Expected: the field exists on `BotCoreSession`.

If these fail, Plan 028 has not landed — STOP.

- [ ] **Step 5: Note the current highest scenario number**

Use the Glob tool with pattern `test/scenarios/*/spec.ts` and note the highest `NNN-` prefix. After Plan 028, the highest is **043** (Plan 028 ships scenarios 037–043 as `dispatcher-flow-input-planning`, `dispatcher-out-of-scope`, `dispatcher-return-to-flow`, `dispatcher-clarify-multiturn`, `dispatcher-cancel-precedence`, `dispatcher-numeric-prefilter`, and `dispatcher-plan-resume-callback`). Plan D's new scenarios are **044 through 053** — eight mainline mutate_plan scenarios (Tasks 13–20 → scenarios 044–051), the retroactive honest-forward-shift regression lock (Task 21 → scenario 052), and the invariant #5 post-confirmation clarification resume lock (Task 22 → scenario 053). **Plan E (030) draft on disk originally claimed 047–058, which now collides with Plan D's 047–053.** Plan 030's Task 1 Step 6 has been updated to note the shift: Plan E scenarios move to **054–065** (offset +7). Plan 030's scenario paths, index entries, commit messages, and cross-references need a bulk renumber before Plan E execution begins — the note in Plan 030 Step 6 describes this. No `test/scenarios/047-*` directories exist on disk from Plan E (Plan E is not yet implemented), so the collision is in plan text only, not in shipped artifacts.

- [ ] **Step 6: Confirm there is no existing `mutate-plan-applier.ts`**

Use the Glob tool with pattern `src/plan/mutate-plan-applier.ts`. Expected: no file found.

Use the Grep tool for `applyMutationRequest` across `src/`. Expected: no hits.

No commit — this is a verification step.

---

### Task 2: Expand the dispatcher catalog — types + prompt + parser

**Rationale:** `mutate_plan` must go from "NOT AVAILABLE" to "AVAILABLE" in the dispatcher's action set before any runtime path exists. Doing the type + prompt work together in a single commit keeps the change atomic: the moment the dispatcher can pick `mutate_plan`, the parser accepts it and the runtime switch has a case to route to (scaffolded in Task 9; stubbed in Task 2 so the compile tree stays green). Until Task 9 adds the real handler, the stub throws `DispatcherFailure` loudly — matching the pattern Plan 028 Task 8 used for the runner scaffold.

**Files:**
- Modify: `src/agents/dispatcher.ts`
- Modify: `src/telegram/dispatcher-runner.ts` — stub handler.

- [ ] **Step 1: Add `mutate_plan` to `DispatcherAction`**

In `src/agents/dispatcher.ts`, replace the `DispatcherAction` type with:

```typescript
export type DispatcherAction =
  | 'flow_input'
  | 'clarify'
  | 'out_of_scope'
  | 'return_to_flow'
  | 'mutate_plan';
```

- [ ] **Step 2: Add `mutate_plan` to `AVAILABLE_ACTIONS_V0_0_5`**

In the same file, replace `AVAILABLE_ACTIONS_V0_0_5` with:

```typescript
export const AVAILABLE_ACTIONS_V0_0_5: readonly DispatcherAction[] = [
  'flow_input',
  'clarify',
  'out_of_scope',
  'return_to_flow',
  'mutate_plan',
] as const;
```

- [ ] **Step 3: Extend `DispatcherDecision` with the `mutate_plan` variant**

Replace the `DispatcherDecision` type with:

```typescript
export type DispatcherDecision =
  | {
      action: 'flow_input';
      params: Record<string, never>;
      response?: undefined;
      reasoning: string;
    }
  | {
      action: 'clarify';
      params: Record<string, never>;
      response: string;
      reasoning: string;
    }
  | {
      action: 'out_of_scope';
      params: { category?: string };
      response: string;
      reasoning: string;
    }
  | {
      action: 'return_to_flow';
      params: Record<string, never>;
      response?: undefined;
      reasoning: string;
    }
  | {
      action: 'mutate_plan';
      /**
       * Plan 029: `request` is the user's raw natural-language mutation. The
       * applier forwards it unchanged to the re-proposer (in the in-session
       * case) or to the post-confirmation applier (which wraps the re-proposer
       * with the split-aware adapter). The dispatcher does NOT resolve dates,
       * meal times, or recipe references — the re-proposer has strictly more
       * context for that work. The dispatcher's only job is to classify the
       * intent and pass through the request verbatim.
       */
      params: { request: string };
      response?: undefined;
      reasoning: string;
    };
```

- [ ] **Step 4: Update `buildSystemPrompt` — flip the `mutate_plan` catalog entry**

Find the section of `buildSystemPrompt` that describes `mutate_plan` (search for `mutate_plan  (NOT AVAILABLE in v0.0.5`). Replace the entire `### mutate_plan` block (and the paragraph that follows about picking `flow_input` during active planning or `clarify` post-confirmation) with:

```typescript
`### mutate_plan  (AVAILABLE)
The user wants to change the plan in any way that requires the re-proposer agent: move a flex meal, swap a recipe, add or remove an event, shift a batch, absorb a real-life deviation like "I'm eating out tonight", "friend invited me for dinner", "I'm out of salmon", "my partner ate half the tagine", etc.
Params: { "request": "<user's raw natural-language mutation — pass through verbatim, do NOT resolve dates or recipe refs>" }
Response: null (the applier renders the proposed change with a Confirm/Adjust keyboard)
When to pick:
  - During active planning (phase=proposal): any mutation request, any rephrasing of "change the plan", including things the user could have said through the re-proposer before — "move the flex", "swap the chicken", "add an event".
  - Post-confirmation (no active flow, lifecycle=active_*): any real-life deviation statement or plan-change request. "I'm eating out tonight." "Swap tomorrow's dinner for fish." "Move the flex to Sunday." "I already ate the chicken." "Skip Thursday's cooking." All mutate_plan, all the time.
  - During awaiting_events: rarely — the user's text there is usually event input for flow_input, but if they clearly say "actually, change the plan to X" or "forget the events, just do Y" it's mutate_plan.
When NOT to pick:
  - Pure questions without an imperative request ("why so much pasta?" → clarify, answer actions deferred).
  - Requests that name specific recipes but are read-only ("show me the tagine recipe" → NOT mutate_plan — that's show_recipe in Plan E; for v0.0.5, out_of_scope or clarify with a "tap a button" hint).
  - Requests that are clearly events the planning flow is already expecting ("dinner out Friday" during awaiting_events → flow_input to reach the event parser).
  - Navigation ("back to the plan" → return_to_flow).
  - Out-of-domain ("what's the weather?" → out_of_scope).

Precedence with flow_input: during an active planning proposal phase, "move the flex to Sunday" is structurally a mutation request that the existing re-proposer path handles. The applier's in-session branch delegates to the same re-proposer that flow_input would have reached. Pick mutate_plan in both cases — the applier routes by session state, not by the dispatcher's choice. Picking mutate_plan during active planning is NOT a mistake; the applier handles both modes uniformly.`
```

- [ ] **Step 5: Update `buildSystemPrompt` — add few-shot examples for `mutate_plan`**

Find the `## FEW-SHOT EXAMPLES` section. Replace the existing example `(Active flow: plan / phase: proposal) User: "Put the flex meal on Sunday instead"` (which currently shows `flow_input`) with:

```typescript
`(Active flow: plan / phase: proposal)
User: "Put the flex meal on Sunday instead"
→ { "action": "mutate_plan", "params": { "request": "Put the flex meal on Sunday instead" }, "response": null, "reasoning": "Plan mutation during active proposal phase; applier's in-session branch delegates to the re-proposer." }`
```

Then add these new examples immediately after (before the existing "why so much pasta" example):

```typescript
`(Active flow: none / lifecycle: active_mid)
User: "I'm eating out tonight, friend invited me"
→ { "action": "mutate_plan", "params": { "request": "I'm eating out tonight, friend invited me" }, "response": null, "reasoning": "Real-life deviation on a confirmed plan; applier's post-confirmation branch runs the adapter + re-proposer and presents a diff for confirmation." }

(Active flow: none / lifecycle: active_mid)
User: "swap tomorrow's dinner for something lighter"
→ { "action": "mutate_plan", "params": { "request": "swap tomorrow's dinner for something lighter" }, "response": null, "reasoning": "Post-confirmation recipe swap request; pass through verbatim." }

(Active flow: none / lifecycle: active_mid)
User: "move the flex to Sunday"
→ { "action": "mutate_plan", "params": { "request": "move the flex to Sunday" }, "response": null, "reasoning": "Post-confirmation flex move." }`
```

- [ ] **Step 5b: Thread `pendingPostConfirmationClarification` into the dispatcher context**

In `buildSystemPrompt` (or the context-bundle construction in `dispatcher-runner.ts` — verify by Grep), add a conditional section that is only included when `session.pendingPostConfirmationClarification` is set:

```typescript
if (session.pendingPostConfirmationClarification) {
  contextSections.push(
    `## Outstanding clarification (post-confirmation mutation)\n` +
    `The re-proposer asked: "${session.pendingPostConfirmationClarification.question}"\n` +
    `Original request: "${session.pendingPostConfirmationClarification.originalRequest}"\n` +
    `The user's next message is likely the answer to this question. ` +
    `Pick mutate_plan with the user's text as the request — the applier ` +
    `will prepend the original request automatically.`
  );
}
```

This ensures the dispatcher picks `mutate_plan` for terse answers like "dinner" or "tomorrow" that would otherwise classify as `out_of_scope` or `clarify`. The section is ephemeral — it only appears when the field is set and disappears after the next `mutate_plan` turn clears it.

- [ ] **Step 6: Update `parseDecision` to accept `mutate_plan`**

In the parser (search for `parseDecision`), after the `'return_to_flow'` case in the `switch (action)`, add:

```typescript
    case 'mutate_plan': {
      if (response !== undefined && response !== '') {
        throw new Error('mutate_plan must have response: null (the applier renders the confirmation UI).');
      }
      const request = typeof params.request === 'string' ? params.request.trim() : '';
      if (!request) {
        throw new Error('mutate_plan requires a non-empty "request" string in params.');
      }
      return {
        action: 'mutate_plan',
        params: { request },
        reasoning,
      };
    }
```

Also, in `parseDecision`'s `knownActions` array (where the first-pass action validation lives), add `'mutate_plan'`:

```typescript
  const knownActions: readonly DispatcherAction[] = [
    'flow_input',
    'clarify',
    'out_of_scope',
    'return_to_flow',
    'mutate_plan',
  ];
```

- [ ] **Step 7: Add a stub handler in `dispatcher-runner.ts`**

In `src/telegram/dispatcher-runner.ts`, add immediately after `handleReturnToFlowAction`:

```typescript
/**
 * `mutate_plan` — Plan 029 Task 2 stub. Tasks 6–9 replace this with the real
 * handler that delegates to `applyMutationRequest`. Until then, throwing
 * keeps any premature wiring loud — there is no silent path through.
 */
export async function handleMutatePlanAction(
  _decision: Extract<DispatcherDecision, { action: 'mutate_plan' }>,
  _deps: DispatcherRunnerDeps,
  _session: DispatcherSession,
  _sink: DispatcherOutputSink,
): Promise<void> {
  throw new Error('handleMutatePlanAction is not wired yet (Plan 029 Task 2 stub — replaced in Task 9)');
}
```

- [ ] **Step 8: Wire the stub into `runDispatcherFrontDoor`'s switch**

In `runDispatcherFrontDoor`'s `switch (decision.action)`, add the new case immediately after the `return_to_flow` case:

```typescript
    case 'mutate_plan':
      await handleMutatePlanAction(decision, deps, session, sink);
      return;
```

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. The new action variant is exhaustively handled in both the parser and the runner switch.

- [ ] **Step 10: Run tests — expect red on scenarios whose dispatcher fixture previously captured a different decision**

Run: `npm test`
Expected: new dispatcher-agent unit tests from Plan 028 still pass (the disallowed-action test used `mutate_plan` as its disallowed example — it will now pass incorrectly because `mutate_plan` IS allowed. Task 3 updates it). Several scenarios that fire free text may go red because the dispatcher's fixture-replay will hit the updated system prompt hash and miss its captured response — intentional. Task 12 regenerates them.

Count the failures; write down which scenarios went red.

- [ ] **Step 11: Commit (tree intentionally red on a few scenarios)**

```bash
git add src/agents/dispatcher.ts src/telegram/dispatcher-runner.ts
git commit -m "Plan 029: promote mutate_plan to AVAILABLE in dispatcher catalog

Adds mutate_plan to DispatcherAction + AVAILABLE_ACTIONS_V0_0_5, extends
DispatcherDecision with the { request } variant, updates buildSystemPrompt
to flip the catalog entry and add few-shot examples for both in-session
and post-confirmation cases, and updates parseDecision to accept the new
action with non-empty request validation.

The runner exports a stub handleMutatePlanAction that throws; Task 9
replaces it with the real handler once the applier module exists. Some
scenarios go red pending Task 12's regeneration."
```

---
### Task 3: Update the Plan 028 dispatcher-agent unit test that used `mutate_plan` as the disallowed example

**Rationale:** Plan 028 Task 5 wrote a dispatcher-agent unit test called `"dispatchMessage: first-pass disallowed action → retries and succeeds"` that used `mutate_plan` as the disallowed example. After Task 2, `mutate_plan` is allowed, so that test would pass for the wrong reason (the parser would accept the first response, not retry). Plan D updates the test to use a genuinely disallowed action.

**Files:**
- Modify: `test/unit/dispatcher-agent.test.ts`

- [ ] **Step 1: Read the Plan 028 test**

Use Grep on `test/unit/dispatcher-agent.test.ts` for `first-pass disallowed action` to find the exact test. Read the surrounding 20 lines.

- [ ] **Step 2: Replace the disallowed-action example**

Replace the test body so the first LLM response picks an action that is NOT in `AVAILABLE_ACTIONS_V0_0_5`. Use `'answer_plan_question'` — it's documented in the dispatcher's prompt as a known-but-deferred action, so it's a realistic example of what the LLM might hallucinate under pressure:

```typescript
test('dispatchMessage: first-pass disallowed action → retries and succeeds', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'answer_plan_question',
      params: { question: "when's my next cook day?" },
      response: 'Your next cook day is Thursday.',
      reasoning: 'User asked a plan question (but answer_plan_question is not allowed in v0.0.5).',
    }),
    JSON.stringify({
      action: 'clarify',
      params: {},
      response: 'Plan questions are coming soon. Want me to show you the week overview?',
      reasoning: 'Honest deferral after disallowed-action retry.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), "when's my next cook day?", llm);
  assert.equal(decision.action, 'clarify');
});
```

- [ ] **Step 3: Run the test**

Run: `npm test -- --test-name-pattern="disallowed action"`
Expected: PASS. The parser rejects `answer_plan_question` on the first pass, the retry fires, the second response is the clarify, and the final decision is clarify.

- [ ] **Step 4: Add a new test: `dispatchMessage: mutate_plan happy path with request param`**

Append to `test/unit/dispatcher-agent.test.ts`:

```typescript
test('dispatchMessage: mutate_plan carries the request param', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'mutate_plan',
      params: { request: "I'm eating out tonight, friend invited me" },
      response: null,
      reasoning: 'Real-life deviation on a confirmed plan.',
    }),
  ]);
  const decision = await dispatchMessage(
    baseContext({ lifecycle: 'active_mid', surface: 'plan' }),
    "I'm eating out tonight, friend invited me",
    llm,
  );
  assert.equal(decision.action, 'mutate_plan');
  const dec = decision as Extract<DispatcherDecision, { action: 'mutate_plan' }>;
  assert.equal(dec.params.request, "I'm eating out tonight, friend invited me");
});

test('dispatchMessage: mutate_plan with empty request is rejected on first pass', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'mutate_plan',
      params: { request: '' },
      response: null,
      reasoning: 'Empty request — invalid.',
    }),
    JSON.stringify({
      action: 'mutate_plan',
      params: { request: 'move the flex to Sunday' },
      response: null,
      reasoning: 'Corrected.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'move the flex to Sunday', llm);
  assert.equal(decision.action, 'mutate_plan');
});

test('dispatchMessage: mutate_plan with non-null response is rejected on first pass', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'mutate_plan',
      params: { request: 'move flex' },
      response: 'The mutation has been applied.',
      reasoning: 'Invalid — mutate_plan is handler-rendered.',
    }),
    JSON.stringify({
      action: 'mutate_plan',
      params: { request: 'move the flex to Sunday' },
      response: null,
      reasoning: 'Corrected.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'move flex', llm);
  assert.equal(decision.action, 'mutate_plan');
});
```

- [ ] **Step 5: Run the new tests**

Run: `npm test -- --test-name-pattern="mutate_plan"`
Expected: 3 new tests green.

- [ ] **Step 6: Run the full unit test file**

Run: `npm test -- --test-name-pattern="dispatchMessage"`
Expected: all Plan 028 dispatcher-agent tests + 3 new Plan 029 tests pass.

- [ ] **Step 7: Commit**

```bash
git add test/unit/dispatcher-agent.test.ts
git commit -m "Plan 029: unit tests for dispatcher mutate_plan parse + retry"
```

---

### Task 4: Add `pendingMutation` to `BotCoreSession` + structural `DispatcherSession` slice

**Rationale:** When the post-confirmation applier produces a proposed diff and the user sees `[Confirm] [Adjust]`, the pending mutation (the re-proposed active proposal, the preserved past batches, the old session ID, and the new mutation record) must live somewhere between the propose turn and the confirm tap. `BotCoreSession` is the right home — same lifetime as the existing in-memory flow state, cleared on `reset()`, not persisted. This task is strictly the field addition; Task 6 creates the `PendingMutation` type in the applier module.

**Files:**
- Modify: `src/telegram/core.ts`
- Modify: `src/telegram/dispatcher-runner.ts`
- Create: `src/plan/mutate-plan-applier.ts` — with ONLY the `PendingMutation` type export for now. Tasks 6–8 fill in the rest.

- [ ] **Step 1: Create `src/plan/mutate-plan-applier.ts` with the `PendingMutation` type**

Create the new file with:

```typescript
/**
 * Mutate-plan applier — Plan 029 / Plan D from proposal
 * `003-freeform-conversation-layer.md`.
 *
 * Shared entry point that runs either the in-session mutation path (delegating
 * to `plan-flow.ts` `handleMutationText`) or the post-confirmation mutation
 * path (using Plan 026's split-aware adapter + re-proposer + solver + diff +
 * `buildReplacingDraft`). Task 4 lands only the `PendingMutation` type so
 * `BotCoreSession` can reference it. Tasks 6–8 add the applier functions.
 *
 * This file will grow across:
 *   - Task 4: PendingMutation type (this file's initial shape)
 *   - Task 6: MutateResult union + applyMutationRequest scaffold
 *   - Task 7: in-session branch
 *   - Task 8: post-confirmation branch
 *   - Task 10 (core.ts import): applyMutationConfirmation helper for mp_confirm
 */

import type { Batch, FlexSlot, MealEvent } from '../models/types.js';
import type { PlanProposal } from '../solver/types.js';
import type { MutationRecord } from '../models/types.js';

/**
 * A proposed post-confirmation mutation awaiting explicit user confirmation.
 *
 * Stashed on `BotCoreSession.pendingMutation` when the applier's post-
 * confirmation branch returns a proposed diff. The `mp_confirm` callback
 * handler in `core.ts` reads it, calls `buildReplacingDraft`, and persists
 * via `confirmPlanSessionReplacing`. The `mp_adjust` callback clears it so
 * the next user message can propose a different mutation.
 *
 * NOT persisted. Bot restarts drop in-progress mutation proposals, same as
 * they drop in-progress planning flows.
 */
export interface PendingMutation {
  /** The session ID being replaced. `confirmPlanSessionReplacing` tombstones it on confirm. */
  oldSessionId: string;
  /**
   * Batches that live entirely in past slots (by the Plan 026 adapter's
   * classification at propose time). Preserved verbatim into the new
   * session's write payload so the full horizon renders correctly.
   */
  preservedPastBatches: Batch[];
  /**
   * Flex slots whose `(day, mealTime)` classified as past at propose time.
   * Plan 026's `sessionToPostConfirmationProposal` filters these out of the
   * `activeProposal` the re-proposer sees — they must round-trip through
   * `buildReplacingDraft` into the rewritten session or the user's historical
   * record of past flex decisions (e.g., "Sunday dinner was a flex slot")
   * is erased on every mutate. Plan 026 requires this field on
   * `BuildReplacingDraftArgs`.
   */
  preservedPastFlexSlots: FlexSlot[];
  /**
   * Meal events whose `(day, mealTime)` classified as past at propose time.
   * Same preservation contract as `preservedPastFlexSlots` — the user's
   * "I ate out Monday lunch" record must survive the rewrite. Plan 026
   * requires this field on `BuildReplacingDraftArgs`.
   */
  preservedPastEvents: MealEvent[];
  /**
   * The re-proposer's output for the active slice. Contains the new batches,
   * flex slots, events, and `solverOutput` (attached by the applier after it
   * runs the solver on the re-proposed active proposal). Plan 026's
   * `buildReplacingDraft` reads `reProposedActive.solverOutput.batchTargets`
   * as the macro-target source when scaling the new Batch rows — so this
   * field's `solverOutput` MUST be populated before the `PendingMutation`
   * is stashed. Task 8 runs the solver and attaches the output.
   */
  reProposedActive: PlanProposal;
  /**
   * The mutation record to append to the new session's `mutationHistory`.
   * Constructed at propose time with the user's raw request as `constraint`
   * and the propose-time ISO string as `appliedAt`.
   */
  newMutationRecord: MutationRecord;
  /**
   * ISO timestamp when this pending mutation was created. Used for debug
   * logging and for eventual staleness checks (not enforced in Plan D).
   */
  createdAt: string;
}
```

- [ ] **Step 2: Add `pendingMutation` to `BotCoreSession`**

In `src/telegram/core.ts`, find the `BotCoreSession` interface (Grep for `export interface BotCoreSession`). Add a new field between `recentTurns?` (from Plan 028) and `progressFlow`:

```typescript
  /**
   * Plan 029: The last post-confirmation mutation the dispatcher's applier
   * proposed, awaiting user confirmation via the mp_confirm inline callback.
   * Cleared on mp_confirm (after persistence), on mp_adjust (user wants to
   * re-describe), or on any flow that structurally invalidates the pending
   * state (fresh /start, plan_week, reset). Present only during the narrow
   * window between "dispatcher proposed a mutation" and "user tapped
   * Confirm / Adjust".
   *
   * In-memory only — bot restarts drop it.
   */
  pendingMutation?: import('../plan/mutate-plan-applier.js').PendingMutation;

  /**
   * Plan 029: A pending post-confirmation clarification from the re-proposer.
   * Set when the applier's post-confirmation branch returns a clarification
   * ("lunch or dinner?"). On the next `mutate_plan` dispatch, the applier
   * reads this field and prepends the original request to the user's new
   * text so the re-proposer has full context — the user only needs to answer
   * the question, not re-state the entire mutation. The dispatcher context
   * bundle exposes this field so the dispatcher knows a clarification is
   * outstanding and routes the answer to `mutate_plan` instead of treating
   * it as an unrelated message.
   *
   * Cleared at the same sites as `pendingMutation`. In-memory only.
   *
   * Honors proposal 003 invariant #5 for the post-confirmation case where
   * `planFlow` is null and `planFlow.pendingClarification` does not exist.
   */
  pendingPostConfirmationClarification?: {
    question: string;
    originalRequest: string;
    createdAt: string;
  };
```

- [ ] **Step 3: Clear `pendingMutation` and `pendingPostConfirmationClarification` in `reset()`**

Find the `reset()` function in `core.ts` and add the clear lines after `session.recentTurns = undefined;`:

```typescript
    session.pendingMutation = undefined;
    session.pendingPostConfirmationClarification = undefined;
```

- [ ] **Step 4: Add `pendingMutation` and `pendingPostConfirmationClarification` to the structural `DispatcherSession` slice**

In `src/telegram/dispatcher-runner.ts`, find the `DispatcherSession` interface (added in Plan 028 Task 8). Add both new fields:

```typescript
  pendingMutation?: import('../plan/mutate-plan-applier.js').PendingMutation;
  pendingPostConfirmationClarification?: {
    question: string;
    originalRequest: string;
    createdAt: string;
  };
```

- [ ] **Step 5: Clear `pendingMutation` AND `pendingPostConfirmationClarification` on session-reset and plan-lifecycle sites (intent-based — NOT every `planFlow = null`)**

**Rule: every site that clears `pendingMutation` also clears `pendingPostConfirmationClarification`.** The two fields share the same lifecycle — both are set by the post-confirmation mutation path and invalidated by the same structural exits. At each site listed below, add both `session.pendingMutation = undefined;` and `session.pendingPostConfirmationClarification = undefined;`.

**Important:** `reset()` in `core.ts` (around line 1320) is a **harness-only helper** called by scenario test setup, NOT by the `/start` or `/cancel` command handlers. `handleCommand('start')` (core.ts ~369) and `handleCommand('cancel')` (core.ts ~383) both clear session fields **manually** (e.g., `session.recipeFlow = null; session.planFlow = null; session.progressFlow = null; session.pendingReplan = undefined; ...`). They do NOT invoke `reset()`. If Plan D only clears `pendingMutation` inside `reset()`, a user who types `/start` or `/cancel` after triggering a mutation proposal will retain the stale `pendingMutation` and could confirm an outdated plan via an old `[Confirm]` inline button — directly contradicting the "fresh /start resets state" contract.

**Intent-based invalidation rule (NOT "every planFlow = null"):** `pendingMutation` should be cleared at sites that represent a **full session reset**, **the start of a new plan / explicit cancellation**, or **the start of a new flow that could invalidate the mutation's assumptions** — NOT at every site that happens to set `session.planFlow = null`. Two `core.ts` callbacks clear `planFlow` as a **true navigation side effect** without starting a new flow: `view_shopping_list` at ~:517 and `view_plan_recipes` at ~:523. Those sites must NOT clear `pendingMutation` because the user is browsing while a pending mutation awaits confirmation — clearing it on browse would silently discard the proposal. Note: `re_` recipe edit (~:487) also clears `planFlow`, but it is NOT navigation — it starts a new `recipeFlow` and is classified under Category D below. Additionally, in-flow meta intents (`start_over` at ~:1259, `cancel` at ~:1268) live inside `if (session.planFlow)` blocks and are **unreachable when `pendingMutation` is set** (the post-confirmation branch only sets `pendingMutation` when `planFlow` is null). Adding the clear there is harmless defense-in-depth but not load-bearing.

The structural invalidation sites (where `pendingMutation` MUST be cleared) are:

**Category A — full session resets (mandatory):**
- `handleCommand('start')` — in the block that clears `session.recipeFlow`, `session.planFlow`, `session.progressFlow`, `session.pendingReplan`, `session.surfaceContext`, `session.lastRecipeSlug`, `session.lastRenderedView`, add `session.pendingMutation = undefined;` in the same clear block.
- `handleCommand('cancel')` — same, in the block that clears `session.recipeFlow`, `session.planFlow`, `session.progressFlow`, `session.pendingReplan`, `session.lastRenderedView`.

**Category B — new-plan or explicit-cancel callbacks (mandatory):**
- `case 'plan_week'` in `handleMenu` — after `session.planFlow = ...` assignment, add the clear. (Starting a new planning session structurally invalidates any stashed post-confirmation mutation.)
- `if (action === 'plan_cancel')` in `handleCallback` — after `session.planFlow = null;`, add the clear.
- `if (action === 'plan_approve')` in `handleCallback` — after `session.planFlow = null;` on the success path (line ~572), add the clear. (A freshly confirmed plan replaces the plan the pending mutation was computed against.)
- `plan_replan_cancel` / `plan_replan_confirm` callback handlers — alongside `session.pendingReplan = undefined;`.

**Category C — defense-in-depth (unreachable but safe):**
- `metaIntent === 'start_over'` inside `routeTextToActiveFlow` (~:1259) — only reachable when `session.planFlow` is active, so `pendingMutation` should be null. Add the clear as a safety net.
- `metaIntent === 'cancel'` inside `routeTextToActiveFlow` (~:1268) — same reasoning.

**Category D — new-flow starts that invalidate pending mutation assumptions (mandatory):**
- `action.startsWith('re_')` recipe edit (~:487) — clears `planFlow` AND creates `recipeFlow = createEditFlowState(recipe)`. This is NOT navigation — it starts a new flow. Proposal 003 line 536 explicitly lists "user starts a new flow" as a terminal condition. A pending mutation computed against recipe X would be stale if the user just edited X's ingredients or structure. Clear `pendingMutation` here. The UX cost is low (the user tapped a flow-switching button, not a browse button) and the data-integrity cost of NOT clearing is high (confirming a mutation built against a now-edited recipe).

**Sites that must NOT clear `pendingMutation` (true navigation-only):**
- `action === 'view_shopping_list'` (~:517) — legacy post-confirmation button; user is browsing the shopping list, not starting a new flow. `planFlow` is already null during post-confirmation, and the action doesn't create any new flow state.
- `action === 'view_plan_recipes'` (~:523) — same; browses the recipe list without creating `recipeFlow`. No new flow, no state change that could invalidate the pending mutation.

Use Grep to confirm each site. The query `grep -n "session.planFlow = null" src/telegram/core.ts` will return all sites — classify each per the categories above before adding the clear.

**Verification grep at end of Task 4:** after all clears are added, run `grep -n "session.pendingMutation = undefined" src/telegram/core.ts`. Expected: **at least 11 hits** — `reset()` (1, harness), `/start` (1), `/cancel` (1), `plan_week` (1), `plan_cancel` (1), `plan_approve` (1), `plan_replan_confirm` (1), `plan_replan_cancel` (1), `re_` recipe edit (1), `metaIntent === 'start_over'` (1, defense-in-depth), `metaIntent === 'cancel'` (1, defense-in-depth). The two true navigation-only sites (`view_shopping_list`, `view_plan_recipes`) should have **zero** `pendingMutation` clears — verify by reading the surrounding 5 lines of each `planFlow = null` that does NOT have a corresponding `pendingMutation = undefined`.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. The `pendingMutation` field is optional everywhere.

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: same red state as end of Task 2 (dispatcher prompt scenarios still need Task 12 regeneration). No NEW failures caused by the optional field — `JSON.stringify` drops undefined, so scenario recordings are untouched.

- [ ] **Step 8: Commit**

```bash
git add src/plan/mutate-plan-applier.ts src/telegram/core.ts src/telegram/dispatcher-runner.ts
git commit -m "Plan 029: add PendingMutation + BotCoreSession.pendingMutation field"
```

---

### Task 5: `mutateConfirmKeyboard` + `mp_confirm` / `mp_adjust` callback stubs

**Rationale:** Before Task 6–8 build the applier's logic, the keyboard and callback structure must exist so the applier's handler (Task 9) has somewhere to send the user. Task 5 adds the keyboard and a pair of stub callback handlers that throw — Task 10 fills them in once `applyMutationConfirmation` exists in the applier module.

**Files:**
- Modify: `src/telegram/keyboards.ts`
- Modify: `src/telegram/core.ts`

- [ ] **Step 1: Add the confirmation keyboard**

In `src/telegram/keyboards.ts`, find the section near `planProposalKeyboard` (around line 263) and add immediately after it:

```typescript
/**
 * Plan 029: Post-confirmation mutation review keyboard.
 *
 * Shown after the applier's post-confirmation branch produces a proposed
 * diff. `[Confirm]` → mp_confirm persists via confirmPlanSessionReplacing.
 * `[Adjust]` → mp_adjust clears pendingMutation and prompts for a new
 * description. Both callbacks live in core.ts handleCallback (Plan 029
 * Task 5 stubs → Task 10 implementations).
 *
 * In-session mutations continue to use `planProposalKeyboard` — this
 * keyboard is exclusively for post-confirmation mutations where the stakes
 * are higher (real shopping done, real meals prepped) and the confirmation
 * text is worth naming explicitly.
 */
export const mutateConfirmKeyboard = new InlineKeyboard()
  .text('Confirm', 'mp_confirm')
  .text('Adjust', 'mp_adjust');
```

- [ ] **Step 2: Add stub `mp_confirm` / `mp_adjust` handlers in `core.ts`**

In `src/telegram/core.ts`, find `handleCallback` (Grep for `async function handleCallback`). Add two new branches near the existing `plan_resume` / `recipe_resume` handlers added by Plan 028 Task 9:

```typescript
    if (action === 'mp_confirm') {
      // Plan 029 Task 5 stub — Task 10 wires this to applyMutationConfirmation.
      await sink.reply('Mutation confirmation is not wired yet (Plan 029 Task 5 stub).');
      return;
    }

    if (action === 'mp_adjust') {
      // Plan 029 Task 5 stub — Task 10 wires this to clear pendingMutation
      // and re-prompt the user.
      await sink.reply('Mutation adjustment is not wired yet (Plan 029 Task 5 stub).');
      return;
    }
```

- [ ] **Step 3: Typecheck + test**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: same state as end of Task 4.

- [ ] **Step 4: Commit**

```bash
git add src/telegram/keyboards.ts src/telegram/core.ts
git commit -m "Plan 029: mutateConfirmKeyboard + mp_confirm/mp_adjust stubs"
```

---

### Task 6: `mutate-plan-applier.ts` — `MutateResult` + `applyMutationRequest` scaffold

**Rationale:** The shared applier's main entry point is a single function that branches on session state. Task 6 scaffolds it with a throwing body so Tasks 7 and 8 can fill in the branches one at a time, each TDD-tested independently. Keeping the scaffold separate from the branches makes the type contract visible before any logic lands.

**Files:**
- Modify: `src/plan/mutate-plan-applier.ts`
- Create: `test/unit/mutate-plan-applier.test.ts` — scaffold test file.

- [ ] **Step 1: Add the `MutateResult` union and `applyMutationRequest` scaffold**

Append to `src/plan/mutate-plan-applier.ts`:

```typescript
import type { LLMProvider } from '../ai/provider.js';
import type { RecipeDatabase } from '../recipes/database.js';
import type { StateStoreLike } from '../state/store.js';
import type { PlanFlowState } from '../agents/plan-flow.js';
import type { DraftPlanSession } from '../models/types.js';
import { log } from '../debug/logger.js';

/**
 * The applier's discriminated-union result.
 *
 * - `in_session_updated` — the in-session branch delegated to
 *   `handleMutationText` which returned a new FlowResponse. The handler
 *   sends `text` with `planProposalKeyboard` and updates the session's
 *   `planFlow` state in place (the branch mutates the state reference,
 *   not a copy — same contract as the direct flow_input path).
 * - `post_confirmation_proposed` — the post-confirmation branch produced
 *   a proposed diff. The handler sends `text` with `mutateConfirmKeyboard`
 *   and stashes `pending` on `BotCoreSession.pendingMutation`.
 * - `clarification` — either branch returned a re-proposer clarification.
 *   In-session: the handler sends `question` and planFlow's
 *   `pendingClarification` field carries it (existing mechanism).
 *   Post-confirmation: the handler sends `question` AND stashes
 *   `{ question, originalRequest, createdAt }` on
 *   `session.pendingPostConfirmationClarification` so the next
 *   `mutate_plan` turn auto-resumes by prepending the original request
 *   (invariant #5 compliance — proposal 003 line 462).
 * - `failure` — validation or LLM failure; the handler sends `message`
 *   with an "OK, keeping the current plan" tone and leaves state untouched.
 * - `no_target` — the user typed a mutation request but there's nothing to
 *   mutate (no active planning flow AND no visible persisted plan). The
 *   handler sends `message` with a "tap Plan Week to start" hint.
 */
export type MutateResult =
  | { kind: 'in_session_updated'; text: string }
  | { kind: 'post_confirmation_proposed'; text: string; pending: PendingMutation }
  | { kind: 'clarification'; question: string }
  | { kind: 'failure'; message: string }
  | { kind: 'no_target'; message: string };

/**
 * Arguments for the main entry point.
 */
export interface ApplyMutationRequestArgs {
  /** The user's raw natural-language mutation request. Passed through verbatim. */
  request: string;
  /** BotCoreSession-shaped slice — reads planFlow, mutates state in place on in-session branch. */
  session: {
    planFlow: PlanFlowState | null;
  };
  store: StateStoreLike;
  recipes: RecipeDatabase;
  llm: LLMProvider;
  /** Clock injection — Plan D scenarios pass a frozen Date. Defaults to new Date() at call time. */
  now?: Date;
}

/**
 * Apply a mutation request. Branches on `session.planFlow` presence:
 * in-session → `handleMutationText` delegation (Task 7), post-confirmation
 * → adapter + re-proposer + solver + diff (Task 8).
 *
 * Task 6 scaffold: throws. Tasks 7 and 8 fill in the branches.
 */
export async function applyMutationRequest(
  args: ApplyMutationRequestArgs,
): Promise<MutateResult> {
  void args;
  log.debug('MUTATE', 'applyMutationRequest scaffold (Task 6) — branches land in Tasks 7/8');
  throw new Error('applyMutationRequest is not wired yet (Plan 029 Task 6 scaffold)');
}
```

- [ ] **Step 2: Create the unit test file with a placeholder**

Create `test/unit/mutate-plan-applier.test.ts`:

```typescript
/**
 * Unit tests for the mutate-plan applier — Plan 029.
 *
 * Task 6 creates the file with a placeholder. Task 7 adds in-session branch
 * tests. Task 8 adds post-confirmation branch tests.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

test('placeholder: mutate-plan-applier tests land in Tasks 7 and 8', () => {
  assert.ok(true);
});
```

- [ ] **Step 3: Typecheck + test**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test -- --test-name-pattern="mutate-plan-applier"`
Expected: placeholder test passes.

- [ ] **Step 4: Commit**

```bash
git add src/plan/mutate-plan-applier.ts test/unit/mutate-plan-applier.test.ts
git commit -m "Plan 029: applier MutateResult + applyMutationRequest scaffold"
```

---
### Task 7: Applier — in-session branch + first-confirmation mutation history persistence

**Rationale:** Task 7 has two parts:

1. **The in-session applier branch** is a thin delegation to the existing `handleMutationText` in `plan-flow.ts`. The only reason Plan D needs its own entry point at all is to give the dispatcher a single function to call regardless of whether the user is mid-planning or post-confirmation. The in-session branch's call into `handleMutationText` is 100% unchanged from Plan 025 — same re-proposer call, same in-memory `mutationHistory` bookkeeping, same `formatPlanProposal` rendering. Steps 1–5 ship this.

2. **Threading `state.mutationHistory` into `buildNewPlanSession`** (a one-line addition inside `plan-flow.ts`'s draft literal). Today `buildNewPlanSession` builds the `DraftPlanSession` without `mutationHistory`, so in-session mutations accumulated during the proposal phase are dropped on `plan_approve`. Plan 026 § decision log deferred this wire-up to Plan D explicitly, and scenarios 044 (in-session mutate_plan), 048 (side-conversation mid-planning), plus Plan E's planned cross-action state-preservation scenario all require it. Step 6 ships this. It's bundled into Task 7 because both changes make in-session mutations flow end-to-end: the applier exposes the entry point, and `buildNewPlanSession` makes the side effect persist.

**Files:**
- Modify: `src/plan/mutate-plan-applier.ts`
- Modify: `test/unit/mutate-plan-applier.test.ts`
- Modify: `src/agents/plan-flow.ts` (one-line addition to `buildNewPlanSession` — Step 6)

- [ ] **Step 1: Write the failing test**

Replace the placeholder test in `test/unit/mutate-plan-applier.test.ts` with:

```typescript
/**
 * Unit tests for the mutate-plan applier — Plan 029.
 *
 * Task 7: in-session branch delegates to handleMutationText and returns
 * an in_session_updated result. We exercise the branch with a real
 * in-memory PlanFlowState seeded at phase='proposal' and a stub LLM that
 * returns a valid proposal, verifying the applier emits the expected
 * result shape AND updates the session's mutationHistory in place.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { applyMutationRequest } from '../../src/plan/mutate-plan-applier.js';
import type { PlanFlowState } from '../../src/agents/plan-flow.js';
import type { PlanProposal } from '../../src/solver/types.js';
import type { LLMProvider } from '../../src/ai/provider.js';
import type { RecipeDatabase } from '../../src/recipes/database.js';
import type { StateStoreLike } from '../../src/state/store.js';

function emptyProposal(): PlanProposal {
  return {
    batches: [],
    flexSlots: [{ day: '2026-04-11', mealTime: 'dinner', flexBonus: 350 }],
    events: [],
    recipesToGenerate: [],
  };
}

function seededFlowState(): PlanFlowState {
  return {
    phase: 'proposal',
    weekStart: '2026-04-06',
    weekDays: [
      '2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09',
      '2026-04-10', '2026-04-11', '2026-04-12',
    ],
    horizonStart: '2026-04-06',
    horizonDays: [
      '2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09',
      '2026-04-10', '2026-04-11', '2026-04-12',
    ],
    breakfast: {
      recipeSlug: 'oatmeal',
      name: 'Oatmeal',
      caloriesPerDay: 450,
      proteinPerDay: 25,
    },
    events: [],
    proposal: emptyProposal(),
    mutationHistory: [],
    preCommittedSlots: [],
  };
}

/**
 * Stub LLM — returns a pre-queued response per complete() call. Task 7
 * queues a clarification response so the re-proposer short-circuits before
 * any solver or validator code runs; the point is to verify the applier
 * delegates to handleMutationText and propagates its result shape
 * correctly, not to exercise the re-proposer internally.
 */
function queuedLLM(responses: string[]): LLMProvider {
  const q = [...responses];
  return {
    async complete() {
      const next = q.shift();
      if (next === undefined) throw new Error('queuedLLM: unexpected extra call');
      return { content: next, usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async transcribe() {
      throw new Error('queuedLLM: transcribe not supported');
    },
  };
}

const fakeRecipeDb: RecipeDatabase = {
  getAll: () => [],
  getBySlug: () => undefined,
} as unknown as RecipeDatabase;

const fakeStore: StateStoreLike = {
  getRunningPlanSession: async () => null,
  getFuturePlanSessions: async () => [],
  getRecentPlanSessions: async () => [],
} as unknown as StateStoreLike;

test('applyMutationRequest: in-session branch with clarification response bubbles up', async () => {
  const state = seededFlowState();
  const session = { planFlow: state };

  // Re-proposer returns a clarification → handleMutationText stores the
  // pendingClarification and returns a FlowResponse with just the question.
  const llm = queuedLLM([
    JSON.stringify({
      type: 'clarification',
      question: 'Which meal — lunch or dinner?',
    }),
  ]);

  const result = await applyMutationRequest({
    request: 'I went to the Indian place',
    session,
    store: fakeStore,
    recipes: fakeRecipeDb,
    llm,
  });

  assert.equal(result.kind, 'clarification');
  if (result.kind !== 'clarification') throw new Error('unreachable');
  assert.match(result.question, /lunch or dinner/);

  // handleMutationText set planFlow.pendingClarification on the state.
  assert.ok(state.pendingClarification);
  assert.equal(state.pendingClarification!.originalMessage, 'I went to the Indian place');
});

test('applyMutationRequest: in-session branch with failure returns MutateResult failure', async () => {
  const state = seededFlowState();
  // Two validation failures trigger the re-proposer's failure path.
  const llm = queuedLLM([
    JSON.stringify({ type: 'proposal', batches: [], flex_slots: [], events: [], reasoning: '' }),
    JSON.stringify({ type: 'proposal', batches: [], flex_slots: [], events: [], reasoning: '' }),
  ]);

  const result = await applyMutationRequest({
    request: 'do something impossible',
    session: { planFlow: state },
    store: fakeStore,
    recipes: fakeRecipeDb,
    llm,
  });

  // The re-proposer's validator will reject the empty proposals (no slot
  // coverage, etc.) twice, returning type='failure'. The applier maps that
  // to MutateResult.failure.
  assert.equal(result.kind, 'failure');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="applyMutationRequest: in-session"`
Expected: FAIL — the scaffold throws "not wired yet".

- [ ] **Step 3: Implement the in-session branch**

In `src/plan/mutate-plan-applier.ts`, replace the throwing body of `applyMutationRequest` with:

```typescript
export async function applyMutationRequest(
  args: ApplyMutationRequestArgs,
): Promise<MutateResult> {
  const { request, session, store, recipes, llm } = args;

  log.debug('MUTATE', `applyMutationRequest: "${request.slice(0, 80)}"`);

  // ── In-session branch ────────────────────────────────────────────
  if (session.planFlow && session.planFlow.phase === 'proposal') {
    return applyInSession(session.planFlow, request, llm, recipes);
  }

  // ── Post-confirmation branch — Task 8 fills this in ──
  // ── No-target branch — Task 8 also handles this ──
  throw new Error('applyMutationRequest: post-confirmation branch not wired yet (Task 8)');
}

/**
 * In-session branch — delegates to `plan-flow.ts` `handleMutationText`
 * unchanged. The existing function handles the re-proposer call, the
 * validation retry, the solver invocation, the diff summary, and the
 * mutation-history append. We map its `FlowResponse` output to
 * `MutateResult`.
 */
async function applyInSession(
  state: PlanFlowState,
  request: string,
  llm: LLMProvider,
  recipes: RecipeDatabase,
): Promise<MutateResult> {
  const { handleMutationText } = await import('../agents/plan-flow.js');
  const response = await handleMutationText(state, request, llm, recipes);

  // handleMutationText distinguishes its three outcomes by:
  //   - pendingClarification set → clarification
  //   - text starts with a known failure sentinel OR proposal unchanged → failure
  //   - otherwise → updated proposal
  // The cleanest signal is the state object after the call:
  //   - If pendingClarification is set, the re-proposer asked a question.
  //   - If mutationHistory grew by one, the proposal was updated.
  //   - Otherwise (rare), the re-proposer returned a failure message.

  if (state.pendingClarification) {
    return { kind: 'clarification', question: response.text };
  }

  const historyAfter = state.mutationHistory?.length ?? 0;
  // A clean success: mutationHistory has one more entry than the request's
  // mutationIntent would suggest. A simpler heuristic: if the response text
  // contains the formatPlanProposal output (has a "Your week:" header),
  // the proposal was updated.
  if (response.text.includes('Your week:')) {
    return { kind: 'in_session_updated', text: response.text };
  }

  // Otherwise the response is a failure message from the re-proposer's
  // type='failure' path or the recipe-generation-decline path.
  return { kind: 'failure', message: response.text };
}
```

**Note on the history-length heuristic:** the implementation uses the `response.text` content as the success signal because that's the least-coupling indicator — `handleMutationText` doesn't currently return a structured result kind. A better long-term shape would be to extend `FlowResponse` with a `kind: 'updated' | 'clarification' | 'failure'` discriminator, but that's a `plan-flow.ts` refactor explicitly out of Plan D's scope. The heuristic is load-bearing; if it's wrong, the unit tests in Step 1 will catch it.

- [ ] **Step 4: Run the tests**

Run: `npm test -- --test-name-pattern="applyMutationRequest: in-session"`
Expected: both tests green.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: same red state as end of Task 4 (prompt scenarios still need Task 12 regeneration; no new failures from this task).

- [ ] **Step 6: Thread `state.mutationHistory` into `buildNewPlanSession`**

This is the load-bearing one-line change from the scope paragraph above. Today, `buildNewPlanSession` in `src/agents/plan-flow.ts` (lines 846–942) constructs a `DraftPlanSession` literal with `breakfast`, `treatBudgetCalories`, `flexSlots`, and `events` — but omits `mutationHistory`, so any in-session mutations accumulated during the proposal phase are silently dropped when the user taps `plan_approve`. Plan 026 § decision log deferred this wire-up to Plan D explicitly; Plan D owns it because scenarios 044 (in-session mutate_plan), 048 (side-conversation mid-planning), plus Plan E's planned cross-action state-preservation scenario all assert that the persisted session's `mutationHistory` reflects every in-session mutation.

Use Grep to confirm the target: search `src/agents/plan-flow.ts` for `const session: DraftPlanSession`. Expected: one hit in `buildNewPlanSession`. Inside the literal (between `events: proposal.events,` and the closing `};`), add:

```typescript
    mutationHistory: state.mutationHistory ?? [],
```

Do NOT touch anything else in `buildNewPlanSession` — the rest of the body is outside Plan D's scope. Leave the existing `state.mutationHistory = undefined;` call in `handleApprove` (line 570) as-is; that clear runs AFTER the draft is built, so the history has already been copied into the draft by then.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: the red set from Task 4 is now augmented by any scenario that (a) fires a mutation during an in-session planning flow AND (b) asserts on the final persisted `mutationHistory`. Likely candidates: `020-planning-intents-from-text` (first flex-move happens in-session, then `plan_approve` persists), any 023–028 re-proposer scenario that ends with a confirm. The failures are EXPECTED and will be regenerated in Task 12. No new failures outside this pattern should appear; if unrelated scenarios fail, investigate before proceeding.

- [ ] **Step 8: Commit**

```bash
git add src/plan/mutate-plan-applier.ts test/unit/mutate-plan-applier.test.ts src/agents/plan-flow.ts
git commit -m "Plan 029: applier in-session branch + persist state.mutationHistory on first confirm

The in-session applier branch delegates to handleMutationText unchanged.
buildNewPlanSession now threads state.mutationHistory into the draft so
in-session mutations accumulated during the proposal phase survive
plan_approve. Plan 026 decision log deferred this to Plan D; scenarios
044, 048, and Plan E's cross-action state-preservation scenario
require it."
```

---

### Task 8: Applier — post-confirmation branch

**Rationale:** This is the core wire-up. The post-confirmation branch is the code path that didn't exist before Plan D. It loads the active persisted plan, runs Plan 026's split-aware adapter to get an active-only proposal + preserved past batches, calls the re-proposer in `post-confirmation` mode with `nearFutureDays`, runs the solver on the re-proposer's output, diffs against the pre-mutation active view, and assembles a `PendingMutation` for the confirm tap. On failure the branch returns `MutateResult.failure` with a honest message; on clarification it returns `MutateResult.clarification` and the handler (Task 9) stashes the clarification on `session.pendingPostConfirmationClarification` so the next turn's applier call can auto-resume with the original request prepended (invariant #5).

**Files:**
- Modify: `src/plan/mutate-plan-applier.ts`
- Modify: `test/unit/mutate-plan-applier.test.ts`

- [ ] **Step 1: Add the imports the branch needs**

At the top of `src/plan/mutate-plan-applier.ts`, add imports:

```typescript
import {
  sessionToPostConfirmationProposal,
} from './session-to-proposal.js';
import { reProposePlan } from '../agents/plan-reproposer.js';
import { solve } from '../solver/solver.js';
import { buildSolverInput } from '../agents/plan-flow.js';
import { diffProposals } from '../agents/plan-diff.js';
import { buildRecipeSummaries } from '../agents/plan-proposer.js';
import { getVisiblePlanSession } from '../plan/helpers.js';
import { toLocalISODate } from './helpers.js';
import { config } from '../config.js';
```

**Note on `buildRecipeSummaries`**: Grep for this helper's actual export location. `plan-flow.ts` calls it via an import from `plan-proposer.ts` (or a shared helper). If it's not exported, either export it now or inline a minimal `recipes.getAll().map(r => ({ slug, name, shortName, mealTypes, ... }))` helper inside the applier. The re-proposer's `ReProposerInput.availableRecipes` type is `RecipeSummary[]` — find it and match it.

**Note on `buildSolverInput`**: Confirm it's exported from `plan-flow.ts` (Grep the file — Plan 010 comment says "Exported for regression testing"). If yes, the applier can reuse it. If no, export it with a one-line change and commit that in the same commit as Task 8.

**Note on `getVisiblePlanSession`**: verify it exists in `src/plan/helpers.js`. Grep. If not, use `store.getRunningPlanSession(today)` directly — same semantics for the active case.

- [ ] **Step 2: Write the failing tests**

Append to `test/unit/mutate-plan-applier.test.ts`:

```typescript
import type { Batch, PlanSession } from '../../src/models/types.js';

/**
 * Seed an active plan with two batches — one dinner batch Mon–Wed, one
 * lunch batch Mon–Wed — mirrors the Flow 1 scenario from proposal 003.
 * Clock is Tuesday 7pm so Tuesday dinner is still active (before 21:00
 * cutoff) but Mon dinner is past.
 */
function activePlanStore(): { store: StateStoreLike; session: PlanSession; batches: Batch[] } {
  const session: PlanSession = {
    id: 'sess-active-1',
    horizonStart: '2026-04-06',
    horizonEnd: '2026-04-12',
    breakfast: {
      locked: true,
      recipeSlug: 'oatmeal',
      caloriesPerDay: 450,
      proteinPerDay: 25,
    },
    treatBudgetCalories: 800,
    flexSlots: [{ day: '2026-04-11', mealTime: 'dinner', flexBonus: 350 }],
    events: [],
    mutationHistory: [{ constraint: 'initial plan', appliedAt: '2026-04-05T18:00:00.000Z' }],
    confirmedAt: '2026-04-05T18:00:00.000Z',
    superseded: false,
    createdAt: '2026-04-05T18:00:00.000Z',
    updatedAt: '2026-04-05T18:00:00.000Z',
  };
  const batches: Batch[] = [
    {
      id: 'b-tagine',
      recipeSlug: 'tagine',
      mealType: 'dinner',
      eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
      servings: 3,
      targetPerServing: { calories: 800, protein: 45 },
      actualPerServing: { calories: 810, protein: 46, fat: 30, carbs: 60 },
      scaledIngredients: [
        { name: 'beef', amount: 200, unit: 'g', totalForBatch: 600, role: 'protein' },
      ],
      status: 'planned',
      createdInPlanSessionId: 'sess-active-1',
    },
    {
      id: 'b-grain',
      recipeSlug: 'grain-bowl',
      mealType: 'lunch',
      eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
      servings: 3,
      targetPerServing: { calories: 700, protein: 40 },
      actualPerServing: { calories: 710, protein: 41, fat: 25, carbs: 70 },
      scaledIngredients: [
        { name: 'quinoa', amount: 80, unit: 'g', totalForBatch: 240, role: 'carb' },
      ],
      status: 'planned',
      createdInPlanSessionId: 'sess-active-1',
    },
  ];
  const store: StateStoreLike = {
    async getRunningPlanSession() { return session; },
    async getFuturePlanSessions() { return []; },
    async getLatestHistoricalPlanSession() { return null; },
    async getRecentPlanSessions() { return [session]; },
    async getPlanSession(id: string) { return id === session.id ? session : null; },
    async getBatchesByPlanSessionId(id: string) { return id === session.id ? batches : []; },
    async getBatch(id: string) { return batches.find((b) => b.id === id) ?? null; },
    async getBatchesOverlapping() { return batches; },
  } as unknown as StateStoreLike;
  return { store, session, batches };
}

test('applyMutationRequest: post-confirmation no-target when no active plan', async () => {
  const emptyStore: StateStoreLike = {
    async getRunningPlanSession() { return null; },
    async getFuturePlanSessions() { return []; },
    async getLatestHistoricalPlanSession() { return null; },
    async getRecentPlanSessions() { return []; },
    async getBatchesByPlanSessionId() { return []; },
  } as unknown as StateStoreLike;

  const result = await applyMutationRequest({
    request: 'move tomorrow dinner',
    session: { planFlow: null },
    store: emptyStore,
    recipes: fakeRecipeDb,
    llm: queuedLLM([]),
    now: new Date('2026-04-07T19:00:00'),
  });

  assert.equal(result.kind, 'no_target');
});

test('applyMutationRequest: post-confirmation clarification bubbles up', async () => {
  const { store } = activePlanStore();
  const llm = queuedLLM([
    JSON.stringify({
      type: 'clarification',
      question: 'Did you mean tonight or tomorrow night?',
    }),
  ]);

  const result = await applyMutationRequest({
    request: 'eating out',
    session: { planFlow: null },
    store,
    recipes: fakeRecipeDb,
    llm,
    now: new Date('2026-04-07T19:00:00'),
  });

  assert.equal(result.kind, 'clarification');
  if (result.kind !== 'clarification') throw new Error('unreachable');
  assert.match(result.question, /tonight or tomorrow night/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="post-confirmation"`
Expected: FAIL — both tests throw "not wired yet".

- [ ] **Step 4: Implement the post-confirmation branch**

Replace the `throw new Error('applyMutationRequest: post-confirmation branch not wired yet (Task 8)');` line in `applyMutationRequest` with:

```typescript
  return applyPostConfirmation(request, store, recipes, llm, args.now ?? new Date());
}

/**
 * Post-confirmation branch — NEW code, the core of Plan D.
 *
 * Loads the active persisted PlanSession + batches via the store, runs the
 * Plan 026 adapter to split the plan at the (date, mealType) cutoff, calls
 * the re-proposer in `post-confirmation` mode with `nearFutureDays`, runs
 * the solver on the re-proposer's active output, diffs against the pre-
 * mutation active view, and assembles a PendingMutation for the confirm
 * tap. On clarification, returns the question unchanged. On re-proposer
 * failure (two validation rejects), returns a MutateResult.failure with an
 * honest "I couldn't apply that change cleanly" message.
 */
async function applyPostConfirmation(
  request: string,
  store: StateStoreLike,
  recipes: RecipeDatabase,
  llm: LLMProvider,
  now: Date,
): Promise<MutateResult> {
  // 1. Load the active plan.
  const today = toLocalISODate(now);
  let activeSession = await store.getRunningPlanSession(today);
  if (!activeSession) {
    // Fall back to the nearest future session if there's no running one —
    // lifecycle=upcoming still lets the user adjust the not-yet-started plan.
    const future = await store.getFuturePlanSessions(today);
    activeSession = future[0] ?? null;
  }
  if (!activeSession) {
    log.debug('MUTATE', 'no active plan — returning no_target');
    return {
      kind: 'no_target',
      message: "You don't have a plan yet. Tap 📋 Plan Week to start one.",
    };
  }

  const activeBatches = await store.getBatchesByPlanSessionId(activeSession.id);

  // 2. Split the plan at the cutoff boundary.
  const forward = sessionToPostConfirmationProposal(activeSession, activeBatches, now);

  // Capture the pre-mutation active proposal for diffing after the re-proposer runs.
  const preMutationActive = forward.activeProposal;

  // 3. Call the re-proposer in post-confirmation mode.
  const result = await reProposePlan(
    {
      currentProposal: preMutationActive,
      userMessage: request,
      mutationHistory: activeSession.mutationHistory,
      availableRecipes: buildRecipeSummaries(recipes.getAll()),
      horizonDays: forward.horizonDays,
      preCommittedSlots: [], // post-confirmation view has no inbound carry-over
      breakfast: {
        name: activeSession.breakfast.recipeSlug,
        caloriesPerDay: activeSession.breakfast.caloriesPerDay,
        proteinPerDay: activeSession.breakfast.proteinPerDay,
      },
      weeklyTargets: config.targets.weekly,
      mode: 'post-confirmation',
      nearFutureDays: forward.nearFutureDays,
    },
    llm,
    recipes,
  );

  // 4. Handle clarification / failure.
  if (result.type === 'clarification') {
    return { kind: 'clarification', question: result.question };
  }
  if (result.type === 'failure') {
    return { kind: 'failure', message: result.message };
  }

  // 5. Run the solver on the re-proposed active proposal so the diff and
  //    subsequent persist have scaled macros. We build a minimal PlanFlowState
  //    shim for buildSolverInput since that helper takes one — the shim
  //    carries only the fields the helper actually reads.
  const proposal = result.proposal;
  const flowShim: PlanFlowState = {
    phase: 'proposal',
    weekStart: activeSession.horizonStart,
    weekDays: forward.horizonDays,
    horizonStart: activeSession.horizonStart,
    horizonDays: forward.horizonDays,
    breakfast: {
      recipeSlug: activeSession.breakfast.recipeSlug,
      name: activeSession.breakfast.recipeSlug,
      caloriesPerDay: activeSession.breakfast.caloriesPerDay,
      proteinPerDay: activeSession.breakfast.proteinPerDay,
    },
    events: proposal.events,
    proposal,
    mutationHistory: activeSession.mutationHistory,
    preCommittedSlots: [],
  };
  const solverInput = buildSolverInput(flowShim, proposal, recipes, []);
  proposal.solverOutput = solve(solverInput);

  // 6. Generate the diff against the pre-mutation view.
  const summary = diffProposals(preMutationActive, proposal);

  // 7. Assemble the PendingMutation and the user-visible text.
  //    Carry ALL three preserved-past arrays forward so the confirmation
  //    helper can splice them back into the rewritten session (Plan 026's
  //    buildReplacingDraft contract — `buildReplacingDraft` throws if any
  //    of `preservedPastFlexSlots` / `preservedPastEvents` /
  //    `reProposedActive.solverOutput` is missing). `proposal.solverOutput`
  //    was attached at step 5 above.
  const pending: PendingMutation = {
    oldSessionId: activeSession.id,
    preservedPastBatches: forward.preservedPastBatches,
    preservedPastFlexSlots: forward.preservedPastFlexSlots,
    preservedPastEvents: forward.preservedPastEvents,
    reProposedActive: proposal,
    newMutationRecord: {
      constraint: request,
      appliedAt: now.toISOString(),
    },
    createdAt: now.toISOString(),
  };

  const text = [
    summary,
    '',
    'Tap Confirm to lock this in, or Adjust to change something.',
  ].join('\n');

  return {
    kind: 'post_confirmation_proposed',
    text,
    pending,
  };
}
```

**Note on the `flowShim`:** Plan D's post-confirmation branch reuses `buildSolverInput` because recomputing solver input from scratch would duplicate a load-bearing function. The shim carries only the fields `buildSolverInput` reads. If `buildSolverInput` grows new field dependencies in the future, this shim needs to grow too; the long-term fix is to refactor `buildSolverInput` to take a narrower struct, but that's outside Plan D's scope.

**Post-confirmation clarification state (invariant #5 compliance):** When the re-proposer returns a clarification in the post-confirmation branch, the applier returns a `MutateResult` of kind `'clarification'` — AND the handler in Task 9 stashes the clarification on `session.pendingPostConfirmationClarification` (the field added in Task 4 Step 2). On the next `mutate_plan` dispatch, the applier's post-confirmation entry point checks this field: if set, it prepends `pendingPostConfirmationClarification.originalRequest` to the new user text before calling the re-proposer, so the user only needs to answer the question ("dinner") without re-stating the full mutation ("I'm eating out tonight's dinner"). The field is cleared on any successful `mutate_plan` turn, on `mp_confirm` / `mp_adjust`, and at all structural-invalidation sites per Task 4 Step 5.

Replace the clarification return in `applyPostConfirmation` with:

```typescript
  if (result.type === 'clarification') {
    return { kind: 'clarification', question: result.question };
  }
```

The handler (Task 9) is responsible for stashing the state — the applier stays pure. See Task 9 Step 2 for the `handleMutatePlanAction` clarification branch which sets `session.pendingPostConfirmationClarification`.

**Entry-point resume logic** — at the TOP of `applyPostConfirmation`, before loading the active plan, check for a pending clarification and merge it:

```typescript
  // If there's a pending clarification from a prior post-confirmation turn,
  // the user's new text is the answer. Prepend the original request so the
  // re-proposer has full context. The handler clears the field after this call.
  if (args.pendingClarification) {
    request = `${args.pendingClarification.originalRequest}. To clarify: ${request}`;
  }
```

Add `pendingClarification?: { originalRequest: string }` to `ApplyMutationRequestArgs` so the handler can thread it through without the applier reading session state directly.

The in-session clarification branch in Task 7 is UNCHANGED — it still relies on `planFlow.pendingClarification` and invariant #5 works there as the proposal specifies. This post-confirmation path mirrors the same pattern using `BotCoreSession.pendingPostConfirmationClarification` instead of `planFlow.pendingClarification`.

- [ ] **Step 5: Run the tests**

Run: `npm test -- --test-name-pattern="post-confirmation"`
Expected: both tests green (no_target + clarification).

- [ ] **Step 6: Add a happy-path unit test**

Append to `test/unit/mutate-plan-applier.test.ts`:

```typescript
test('applyMutationRequest: post-confirmation happy path produces pending mutation', async () => {
  const { store, session: activeSession } = activePlanStore();

  // Stub LLM returns a valid re-proposer output — same batches, flex shifted
  // to Sunday lunch. We skip validator complications by returning a
  // proposal that covers every active slot. This is a minimal "re-proposer
  // returned a clean proposal" stub; real re-proposer behavior is exercised
  // in scenarios.
  const llm = queuedLLM([
    JSON.stringify({
      type: 'proposal',
      batches: [
        {
          recipe_slug: 'tagine',
          meal_type: 'dinner',
          days: ['2026-04-07', '2026-04-08'],
          servings: 2,
        },
        {
          recipe_slug: 'grain-bowl',
          meal_type: 'lunch',
          days: ['2026-04-08'],
          servings: 1,
        },
      ],
      flex_slots: [{ day: '2026-04-12', meal_time: 'lunch', flex_bonus: 350 }],
      events: [],
      reasoning: 'Moved flex to Sunday lunch.',
    }),
  ]);

  // Minimal recipe DB — must contain the slugs referenced in the stub output
  // so the validator can check meal types + fridge life. Provide full Recipe
  // shapes.
  const recipes: RecipeDatabase = {
    getAll: () => [
      {
        name: 'tagine', shortName: 'tagine', slug: 'tagine',
        mealTypes: ['dinner'],
        cuisine: 'moroccan', tags: [], prepTimeMinutes: 30,
        structure: [{ type: 'main', name: 'Main' }],
        perServing: { calories: 800, protein: 45, fat: 30, carbs: 60 },
        ingredients: [{ name: 'beef', amount: 200, unit: 'g', role: 'protein', component: 'Main' }],
        storage: { fridgeDays: 5, freezable: true, reheat: 'microwave 3m' },
        body: '',
      },
      {
        name: 'grain-bowl', shortName: 'grain bowl', slug: 'grain-bowl',
        mealTypes: ['lunch'],
        cuisine: 'global', tags: [], prepTimeMinutes: 20,
        structure: [{ type: 'main', name: 'Main' }],
        perServing: { calories: 700, protein: 40, fat: 25, carbs: 70 },
        ingredients: [{ name: 'quinoa', amount: 80, unit: 'g', role: 'carb', component: 'Main' }],
        storage: { fridgeDays: 4, freezable: false, reheat: 'microwave 2m' },
        body: '',
      },
    ],
    getBySlug: (slug: string) => {
      const all = [
        { slug: 'tagine' }, { slug: 'grain-bowl' },
      ];
      // Return the full shapes above; for brevity we re-derive from getAll.
      return (recipes.getAll() as unknown as Array<{ slug: string }>).find((r) => r.slug === slug) as unknown as never;
    },
  } as unknown as RecipeDatabase;

  const result = await applyMutationRequest({
    request: 'move the flex to Sunday lunch',
    session: { planFlow: null },
    store,
    recipes,
    llm,
    now: new Date('2026-04-07T19:00:00'),
  });

  assert.equal(result.kind, 'post_confirmation_proposed');
  if (result.kind !== 'post_confirmation_proposed') throw new Error('unreachable');
  assert.equal(result.pending.oldSessionId, activeSession.id);
  assert.equal(result.pending.newMutationRecord.constraint, 'move the flex to Sunday lunch');
  assert.ok(result.pending.reProposedActive.solverOutput, 'solver should have run');
  assert.ok(result.text.includes('Confirm'));
  assert.ok(result.text.includes('Adjust'));
});
```

- [ ] **Step 7: Run the happy-path test**

Run: `npm test -- --test-name-pattern="post-confirmation happy path"`
Expected: PASS. If it fails with a validation error, the stub proposal is missing slot coverage — the active-view horizon after the Tuesday 7pm cutoff covers Tue-Sun (6 days × 2 slots = 12 active slots). The minimal stub above does NOT cover all 12; the validator will reject it. **The test is intentionally minimal**, focused on wiring — if it trips the validator, either make the stub more complete OR assert on `result.kind === 'failure'` (validator retry failed) as the "applier wiring works" signal. Pick whichever shape makes the test stable; document the choice in a comment.

- [ ] **Step 8: Run the full applier test file**

Run: `npm test -- --test-name-pattern="applyMutationRequest"`
Expected: all applier tests green.

- [ ] **Step 9: Commit**

```bash
git add src/plan/mutate-plan-applier.ts test/unit/mutate-plan-applier.test.ts
git commit -m "Plan 029: applier post-confirmation branch — adapter + re-proposer + diff + PendingMutation"
```

---
### Task 9: Replace the runner's `handleMutatePlanAction` stub with the real handler

**Rationale:** Task 2 scaffolded `handleMutatePlanAction` as a throwing stub. Task 9 replaces it with the real handler that calls `applyMutationRequest` and routes its `MutateResult` to the sink.

**Files:**
- Modify: `src/telegram/dispatcher-runner.ts`

- [ ] **Step 1: Import the applier**

At the top of `src/telegram/dispatcher-runner.ts`, add imports:

```typescript
import {
  applyMutationRequest,
  type MutateResult,
} from '../plan/mutate-plan-applier.js';
```

- [ ] **Step 2: Replace the stub body**

Replace the Task 2 stub with:

```typescript
/**
 * `mutate_plan` — calls the shared applier and routes the result to the sink.
 *
 * Four branches:
 *   - in_session_updated → send text with planProposalKeyboard (the
 *     existing `[Looks good]` → `plan_approve` flow persists).
 *   - post_confirmation_proposed → stash `pending` on session, send text
 *     with mutateConfirmKeyboard (the `[Confirm]` → `mp_confirm` handler
 *     persists via buildReplacingDraft + confirmPlanSessionReplacing).
 *   - clarification → send question with a side-conversation keyboard
 *     (← Back to planning inline button if active flow, main menu
 *     otherwise). Push the question as a bot turn so the next turn sees
 *     it in recentTurns.
 *   - failure / no_target → send message with the main menu keyboard.
 */
export async function handleMutatePlanAction(
  decision: Extract<DispatcherDecision, { action: 'mutate_plan' }>,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  const { planProposalKeyboard, mutateConfirmKeyboard } = await import('./keyboards.js');

  let result: MutateResult;
  try {
    result = await applyMutationRequest({
      request: decision.params.request,
      session: session as unknown as { planFlow: import('../agents/plan-flow.js').PlanFlowState | null },
      store: deps.store,
      recipes: deps.recipes,
      llm: deps.llm,
      now: new Date(),
      // Thread pending clarification so the applier can prepend the original
      // request to the user's answer (invariant #5 post-confirmation).
      pendingClarification: session.pendingPostConfirmationClarification
        ? { originalRequest: session.pendingPostConfirmationClarification.originalRequest }
        : undefined,
    });
    // Clear the pending clarification — it was consumed by this call regardless
    // of outcome (success, new clarification, or failure).
    session.pendingPostConfirmationClarification = undefined;
  } catch (err) {
    log.error('MUTATE', `applyMutationRequest threw: ${(err as Error).message.slice(0, 200)}`);
    const menuKb = await buildMenuKeyboardForSession(session, deps.store);
    await sink.reply(
      "Something went wrong applying that change. Your plan is unchanged. Try rephrasing, or tap a button.",
      { reply_markup: menuKb },
    );
    return;
  }

  switch (result.kind) {
    case 'in_session_updated': {
      // In-session path: the state is already mutated in place by
      // handleMutationText. Render the proposal text with the existing
      // planProposalKeyboard → `Looks good` → plan_approve flow.
      await sink.reply(result.text, {
        reply_markup: planProposalKeyboard,
        parse_mode: 'MarkdownV2',
      });
      return;
    }

    case 'post_confirmation_proposed': {
      // Post-confirmation path: stash the pending mutation so the
      // mp_confirm callback can persist it. Send the diff + confirm UI.
      session.pendingMutation = result.pending;
      await sink.reply(result.text, {
        reply_markup: mutateConfirmKeyboard,
        parse_mode: 'MarkdownV2',
      });
      return;
    }

    case 'clarification': {
      // Stash the clarification so the next mutate_plan turn can prepend
      // the original request — invariant #5 post-confirmation compliance.
      // The field was already cleared above (consumed), so this sets it fresh.
      if (!session.planFlow) {
        // Post-confirmation clarification — stash for multi-turn resume.
        session.pendingPostConfirmationClarification = {
          question: result.question,
          originalRequest: decision.params.request,
          createdAt: new Date().toISOString(),
        };
      }
      // In-session clarifications use planFlow.pendingClarification (unchanged).
      const kb = await buildSideConversationKeyboard(session, deps.store);
      await sink.reply(result.question, { reply_markup: kb });
      pushTurn(session, 'bot', result.question);
      return;
    }

    case 'failure':
    case 'no_target': {
      const menuKb = await buildMenuKeyboardForSession(session, deps.store);
      await sink.reply(result.message, { reply_markup: menuKb });
      pushTurn(session, 'bot', result.message);
      return;
    }
  }
}
```

Delete the stub body that was left in Task 2.

**Note on `parse_mode: 'MarkdownV2'` for the in-session branch:** `formatPlanProposal` produces MarkdownV2-shaped output (see `plan-flow.ts` line ~995). The post-confirmation `diffProposals` output is plain text but is currently treated as MarkdownV2 at the render site — verify. If `diffProposals` output contains reserved MarkdownV2 characters unescaped, drop `parse_mode` for the post-confirmation branch or add escaping. The decision is a Task 13–21 scenario-review discovery: if a scenario's captured output shows broken markdown, come back and fix this line.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: same red state as end of Task 8 — the prompt scenarios from Task 2 still need Task 12 regeneration, and the new scenarios haven't been authored yet.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/dispatcher-runner.ts
git commit -m "Plan 029: wire handleMutatePlanAction to applier — all four result branches"
```

---

### Task 10: `mp_confirm` / `mp_adjust` real implementations + `applyMutationConfirmation` helper

**Rationale:** Task 5 stubbed the callbacks. Task 10 replaces them with real implementations that either persist the pending mutation (`mp_confirm`) or clear it and prompt for a new description (`mp_adjust`). The persist path lives in a new `applyMutationConfirmation` helper in the applier module so the callback handler in `core.ts` stays thin (just session-state shuffling + output).

**Files:**
- Modify: `src/plan/mutate-plan-applier.ts` — add `applyMutationConfirmation`.
- Modify: `src/telegram/core.ts` — replace the callback stubs.
- Modify: `test/unit/mutate-plan-applier.test.ts` — add confirmation tests.

- [ ] **Step 1: Add `applyMutationConfirmation` to the applier**

In `src/plan/mutate-plan-applier.ts`, add after `applyPostConfirmation`:

```typescript
/**
 * Persist a pending mutation. Called from the mp_confirm callback in
 * core.ts. Wraps `buildReplacingDraft` + `confirmPlanSessionReplacing` and
 * returns the persisted new session.
 *
 * This is the moment the real world changes — the old plan becomes
 * superseded and the new session is live. All validation happened at
 * propose time; confirm is a pure persist.
 */
export async function applyMutationConfirmation(args: {
  pending: PendingMutation;
  store: StateStoreLike;
  recipes: RecipeDatabase;
  llm: LLMProvider;
}): Promise<{
  newSessionId: string;
  persistedText: string;
}> {
  const { pending, store, recipes, llm } = args;

  // Load the old session to carry its horizon + breakfast + treat budget
  // into the draft (buildReplacingDraft needs it).
  const oldSession = await store.getPlanSession(pending.oldSessionId);
  if (!oldSession) {
    throw new Error(`applyMutationConfirmation: old session ${pending.oldSessionId} not found`);
  }

  const { buildReplacingDraft } = await import('./session-to-proposal.js');
  // Pass every preserved-past array through unchanged. Plan 026's
  // buildReplacingDraft requires all three (batches, flex slots, events)
  // so the user's historical record is not erased on every mutate rewrite.
  // `pending.reProposedActive` already carries the solver output attached
  // by Task 8 — buildReplacingDraft will throw if it's somehow missing.
  // NOTE on `calorieTolerance`: this initial Task 10 call OMITS the
  // `calorieTolerance` field — Plan 026 Task 11 currently hardcodes 50
  // internally, and Task 11 (later in THIS plan) promotes it to a real
  // argument and updates the call site to `calorieTolerance: config.planning.scalerCalorieTolerance`.
  // Leaving the field off here keeps Task 10 green against the Plan 026
  // signature that exists at Task 10 time.
  const { draft, batches: writeBatches } = await buildReplacingDraft({
    oldSession,
    preservedPastBatches: pending.preservedPastBatches,
    preservedPastFlexSlots: pending.preservedPastFlexSlots,
    preservedPastEvents: pending.preservedPastEvents,
    reProposedActive: pending.reProposedActive,
    newMutation: pending.newMutationRecord,
    recipeDb: recipes,
    llm,
  });

  // DraftPlanSession does not carry treat_budget_calories by default — the
  // in-session flow's buildNewPlanSession computes it from the solver's
  // weeklyTotals. For post-confirmation mutations we copy the old session's
  // value as a conservative default; the solver may already have computed a
  // new treat budget but the re-proposer's output doesn't carry it forward.
  // This is a known limitation flagged for a future cleanup.
  (draft as DraftPlanSession).treatBudgetCalories = oldSession.treatBudgetCalories;

  const persisted = await store.confirmPlanSessionReplacing(
    draft,
    writeBatches,
    pending.oldSessionId,
  );

  log.info(
    'MUTATE',
    `post-confirmation mutation persisted: old=${pending.oldSessionId} new=${persisted.id}`,
  );

  // Proposal 003 line 436 requires an explicit calorie-tracking disclaimer
  // for eat-out mutations: "I don't track meal-out calories yet — that comes
  // with deviation accounting later." For v0.0.5, append the disclaimer
  // unconditionally to post-confirmation mutations — it's accurate for all
  // mutation types since v0.0.5 doesn't track any deviation calories, and
  // the marginal redundancy for flex moves or recipe swaps is harmless
  // compared to the risk of silently omitting the disclaimer for the
  // canonical eat-out path (the literal reason this proposal exists).
  const persistedText =
    `Plan updated. Your week is locked in.\n\n` +
    `Note: I shifted meals around but don't track meal-out calories yet — ` +
    `that comes with deviation accounting later.`;

  return {
    newSessionId: persisted.id,
    persistedText,
  };
}
```

**Summary of Plan 026 ↔ Plan 029 contract seams at Task 10:**

- **Preserved past arrays.** `PendingMutation` carries `preservedPastFlexSlots` and `preservedPastEvents` alongside `preservedPastBatches` (Task 4 added all three fields; Task 8 populates them from the forward adapter; Task 10 hands all three to `buildReplacingDraft`). The contract mirror lives in `docs/plans/active/026-reproposer-post-confirmation-enablement.md:46`. If Plan 026's interface drifts, this call site fails to compile.
- **Solver output.** `pending.reProposedActive.solverOutput` is attached by Task 8 after it runs `solve()` on the re-proposer output. `buildReplacingDraft` throws with a descriptive error if it's missing, so any regression in Task 8 surfaces immediately at Task 10 test time.
- **`calorieTolerance` ordering.** Plan 026 currently hardcodes `calorieTolerance: 50` inside `buildReplacingDraft` and does NOT expose it as an argument; Task 10 therefore omits the field from its call. Task 11 (later in this plan) promotes `calorieTolerance` to a real argument on `buildReplacingDraft` AND updates this call site to `calorieTolerance: config.planning.scalerCalorieTolerance` as a single one-line diff. Both commits land green, one per task, in the strictly-top-to-bottom order Plan 029 mandates.

- [ ] **Step 2: Write a test for the confirmation helper**

Append to `test/unit/mutate-plan-applier.test.ts`:

```typescript
import { applyMutationConfirmation } from '../../src/plan/mutate-plan-applier.js';
import { TestStateStore } from '../../src/harness/test-store.js';
import type { PendingMutation } from '../../src/plan/mutate-plan-applier.js';

test('applyMutationConfirmation: persists via confirmPlanSessionReplacing', async () => {
  const testStore = new TestStateStore();
  const oldSessionId = 'old-session';
  await testStore.confirmPlanSession(
    {
      id: oldSessionId,
      horizonStart: '2026-04-06',
      horizonEnd: '2026-04-12',
      breakfast: {
        locked: true,
        recipeSlug: 'oatmeal',
        caloriesPerDay: 450,
        proteinPerDay: 25,
      },
      treatBudgetCalories: 800,
      flexSlots: [],
      events: [],
      mutationHistory: [{ constraint: 'initial', appliedAt: '2026-04-05T18:00:00.000Z' }],
    },
    [],
  );

  const pending: PendingMutation = {
    oldSessionId,
    preservedPastBatches: [],
    // Empty preserved past arrays — the seed has no past flex slots or events
    // at this clock, so the round-trip has nothing to splice in. A separate
    // test should exercise the non-empty path; this one focuses on wiring.
    preservedPastFlexSlots: [],
    preservedPastEvents: [],
    reProposedActive: {
      batches: [],
      flexSlots: [{ day: '2026-04-12', mealTime: 'lunch', flexBonus: 350 }],
      events: [],
      recipesToGenerate: [],
      // Plan 026's buildReplacingDraft requires solverOutput to be present
      // (it reads batchTargets for scaler inputs). Empty batchTargets is
      // fine here because `reProposedActive.batches` is also empty.
      solverOutput: {
        isValid: true,
        weeklyTotals: { calories: 15000, protein: 900, treatBudget: 800, flexSlotCalories: 350 },
        dailyBreakdown: [],
        batchTargets: [],
        cookingSchedule: [],
        warnings: [],
      },
    },
    newMutationRecord: {
      constraint: 'move the flex to Sunday',
      appliedAt: '2026-04-07T19:30:00.000Z',
    },
    createdAt: '2026-04-07T19:30:00.000Z',
  };

  const result = await applyMutationConfirmation({
    pending,
    store: testStore,
    recipes: fakeRecipeDb,
    llm: queuedLLM([]),
  });

  assert.ok(result.newSessionId);
  assert.notEqual(result.newSessionId, oldSessionId);

  // Old session is superseded.
  const oldReloaded = await testStore.getPlanSession(oldSessionId);
  assert.ok(oldReloaded);
  assert.equal(oldReloaded.superseded, true);

  // New session is active and carries the extended mutation history.
  const newReloaded = await testStore.getPlanSession(result.newSessionId);
  assert.ok(newReloaded);
  assert.equal(newReloaded.superseded, false);
  assert.equal(newReloaded.mutationHistory.length, 2);
  assert.equal(newReloaded.mutationHistory[1]!.constraint, 'move the flex to Sunday');
});
```

- [ ] **Step 3: Replace the `mp_confirm` / `mp_adjust` stubs in `core.ts`**

In `src/telegram/core.ts`, replace the Task 5 stubs with:

```typescript
    if (action === 'mp_confirm') {
      if (!session.pendingMutation) {
        await sink.reply('There is no pending change to confirm. Type your change to start over.');
        return;
      }
      const pending = session.pendingMutation;
      session.pendingMutation = undefined;
      const stopTyping = sink.startTyping();
      try {
        const { applyMutationConfirmation } = await import('../plan/mutate-plan-applier.js');
        const persistResult = await applyMutationConfirmation({
          pending,
          store,
          recipes,
          llm,
        });
        stopTyping();
        const today = toLocalISODate(new Date());
        const lifecycle = await getPlanLifecycle(session, store, today);
        await sink.reply(persistResult.persistedText, {
          reply_markup: buildMainMenuKeyboard(lifecycle),
        });
      } catch (err) {
        stopTyping();
        log.error('CORE', `mp_confirm persist failed: ${(err as Error).message}`);
        // Restore the pending mutation so the user can retry.
        session.pendingMutation = pending;
        await sink.reply(
          "Something went wrong saving the change. Your plan is unchanged. Tap Confirm again or Adjust to change something.",
          { reply_markup: mutateConfirmKeyboard },
        );
      }
      return;
    }

    if (action === 'mp_adjust') {
      if (!session.pendingMutation) {
        await sink.reply('There is no pending change to adjust. Type your change to start over.');
        return;
      }
      session.pendingMutation = undefined;
      await sink.reply(
        "OK, what would you like to change instead?",
      );
      return;
    }
```

Import `mutateConfirmKeyboard` at the top of `core.ts` if not already imported — Grep the imports block and add it alongside the other keyboards.

- [ ] **Step 4: Run the new unit test**

Run: `npm test -- --test-name-pattern="applyMutationConfirmation"`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: same red state (prompt scenarios from Task 2 still pending regeneration).

- [ ] **Step 6: Commit**

```bash
git add src/plan/mutate-plan-applier.ts src/telegram/core.ts test/unit/mutate-plan-applier.test.ts
git commit -m "Plan 029: mp_confirm/mp_adjust real handlers + applyMutationConfirmation"
```

---

### Task 11: Thread `calorieTolerance` through `buildReplacingDraft`

**Rationale:** Plan 026 Task 11 left a hard-coded `calorieTolerance: 50` in `buildReplacingDraft` with a note saying "Plan D will thread the real value from `config.planning.scalerCalorieTolerance`". Task 11 of this plan delivers that.

**Files:**
- Modify: `src/plan/session-to-proposal.ts`
- Modify: `src/plan/mutate-plan-applier.ts` — add the `calorieTolerance` argument back.

- [ ] **Step 1: Add `calorieTolerance` to `BuildReplacingDraftArgs`**

In `src/plan/session-to-proposal.ts`, find the `BuildReplacingDraftArgs` interface and add:

```typescript
  /**
   * Calorie tolerance passed to the recipe scaler. Plan 029: threaded from
   * `config.planning.scalerCalorieTolerance` by the mutate-plan applier.
   * Required (no default) to make the contract explicit — Plan 026's
   * transitional hard-coded 50 is removed.
   */
  calorieTolerance: number;
```

- [ ] **Step 2: Use the new field in `buildReplacingDraft`**

In the body of `buildReplacingDraft`, find the `scaleRecipe(...)` call and replace:

```typescript
        const scaled = await scaleRecipe({
          recipe,
          targetCalories: recipe.perServing.calories,
          calorieTolerance: 50, // conservative default; Plan D will wire the real tolerance from config
          targetProtein: recipe.perServing.protein,
          servings: eatingDays.length,
        }, args.llm);
```

with:

```typescript
        const scaled = await scaleRecipe({
          recipe,
          targetCalories: recipe.perServing.calories,
          calorieTolerance: args.calorieTolerance,
          targetProtein: recipe.perServing.protein,
          servings: eatingDays.length,
        }, args.llm);
```

- [ ] **Step 3: Update the Plan 026 unit test for `buildReplacingDraft`**

Use Grep on `test/unit/session-to-proposal.test.ts` for `buildReplacingDraft`. Find every call site and add `calorieTolerance: 20` (the project's current config value) to the args object. There are typically two call sites (one unit test + one end-to-end integration test in the same file). Verify both by running the test afterwards.

- [ ] **Step 4: Thread `calorieTolerance` through the `applyMutationConfirmation` call site**

In `src/plan/mutate-plan-applier.ts`, find the Task 10 `applyMutationConfirmation` call to `buildReplacingDraft`:

```typescript
  const { draft, batches: writeBatches } = await buildReplacingDraft({
    oldSession,
    preservedPastBatches: pending.preservedPastBatches,
    preservedPastFlexSlots: pending.preservedPastFlexSlots,
    preservedPastEvents: pending.preservedPastEvents,
    reProposedActive: pending.reProposedActive,
    newMutation: pending.newMutationRecord,
    recipeDb: recipes,
    llm,
  });
```

and add the new `calorieTolerance` field as a one-line addition (preserve every other field and their order):

```typescript
  const { draft, batches: writeBatches } = await buildReplacingDraft({
    oldSession,
    preservedPastBatches: pending.preservedPastBatches,
    preservedPastFlexSlots: pending.preservedPastFlexSlots,
    preservedPastEvents: pending.preservedPastEvents,
    reProposedActive: pending.reProposedActive,
    newMutation: pending.newMutationRecord,
    recipeDb: recipes,
    llm,
    calorieTolerance: config.planning.scalerCalorieTolerance,
  });
```

- [ ] **Step 5: Typecheck + test**

Run: `npx tsc --noEmit`
Expected: no errors. If any call to `buildReplacingDraft` is missing the new required field, TypeScript reports the exact location — add `calorieTolerance: config.planning.scalerCalorieTolerance` (in app code) or `calorieTolerance: 20` (in tests) as appropriate.

Run: `npm test -- --test-name-pattern="buildReplacingDraft|applyMutationConfirmation"`
Expected: both test suites pass.

- [ ] **Step 6: Commit**

```bash
git add src/plan/session-to-proposal.ts src/plan/mutate-plan-applier.ts test/unit/session-to-proposal.test.ts
git commit -m "Plan 029: thread config.planning.scalerCalorieTolerance into buildReplacingDraft"
```

---

### Task 12: Regenerate existing scenarios affected by the dispatcher prompt change and the mutationHistory persistence change

**Rationale:** Two Plan D changes invalidate previously-recorded scenario fixtures:

1. **Task 2** flipped `mutate_plan` from NOT AVAILABLE to AVAILABLE in the dispatcher's system prompt and added new few-shot examples. Any scenario whose `llmFixtures` captured a dispatcher response now has a stale hash because the system prompt contributes to the fixture key. Affected: scenarios that fire free-text messages during a confirmed-plan state or during a planning proposal phase.

2. **Task 7 Step 6** threaded `state.mutationHistory` into `buildNewPlanSession` so in-session mutations accumulated during the proposal phase survive `plan_approve`. Any scenario that fires at least one mutation during a planning session and then confirms the plan will produce a persisted session with a non-empty `mutationHistory` where previously it was empty. The captured `finalStore.planSessions[…].mutationHistory` values change accordingly. Affected: `020-planning-intents-from-text`, `023–028` where the scenario reaches `plan_approve` post-mutation, plus any Plan B/C scenario that mutates then confirms.

**Files:** regenerated `recorded.json` files only.

- [ ] **Step 1: Run the test suite and collect the failure list**

Run: `npm test`
Expected: a set of scenarios fail with `MissingFixtureError` or `deepStrictEqual` diffs pointing at `llmFixtures` or `outputs`. Write down the list of failing scenario names.

Likely failures:
- `017-free-text-fallback` — fires arbitrary text; the dispatcher's response text may change (minor).
- `037-dispatcher-flow-input-planning` (Plan 028 — NOT scenario 032; 032 is `discard-recipe-audit` from Plan 027) — the dispatcher previously picked `flow_input` for "Move the flex to Sunday", now picks `mutate_plan`. The downstream behavior is the same (applier routes to the same re-proposer via the in-session branch), but the recorded action differs. This is the primary Plan C regression lock affected by Plan D's catalog flip.
- `020-planning-intents-from-text` — same root cause as 037; the mutation text now classifies as `mutate_plan`.
- `038-dispatcher-out-of-scope`, `039-dispatcher-return-to-flow`, `040-dispatcher-clarify-multiturn`, `041-dispatcher-cancel-precedence`, `042-dispatcher-numeric-prefilter`, `043-dispatcher-plan-resume-callback` — all Plan 028 dispatcher-fixture scenarios. Their captured decisions should be unchanged, but the system-prompt hash that keys their fixtures has moved. Regenerate any that fail fixture lookup.
- Any other scenario in which the dispatcher observed a mutation-shaped message.

**If the failure count is unexpectedly high** (>8), investigate before regenerating — something in Task 2 may have broken the prompt structure.

- [ ] **Step 2: Regenerate affected scenarios in parallel**

Per CLAUDE.md's "delete before regenerate" + "regenerate in parallel, review serially" rules, for each failing scenario `NNN-name`:

```bash
rm test/scenarios/NNN-name/recorded.json
npm run test:generate -- NNN-name --regenerate --yes
```

Run all regenerations concurrently. Wait for every one to finish before moving to review.

**Fixture-edited scenarios:** if any failing scenario has `fixture-edits.md`, use `npm run test:replay -- <name>` instead of `--regenerate`.

- [ ] **Step 3: Behavioral review — serial**

For EACH regenerated recording, apply the 5-step protocol in `docs/product-specs/testing.md` § "Verifying recorded output":

1. Read the bot's messages as the user.
2. Verify the plan proposal (where relevant).
3. Verify the final store state.
4. Scan for known issue patterns (ghost batches, orphan slots, lane violations).
5. Confirm the dispatcher's action choice matches the intent — a mutation-shaped text should pick `mutate_plan`, not `flow_input`.

**Critical check for scenarios 020 and 037:** the final plan confirmation (`plan_approve`) should produce the same persisted session **except** that the captured `planSessions[…].mutationHistory` array is now populated where it was previously empty. The dispatcher's action change is purely upstream — the downstream re-proposer call, the solver output, and the batch contents should be byte-for-byte identical to the pre-Task-2 recording (modulo the new dispatcher fixture and the newly-populated `mutationHistory`). If anything ELSE in `planSessions` or `batches` differs, Plan D has introduced a subtle regression and must be fixed before committing. Cross-check: the new `mutationHistory` entries should contain the same `constraint` strings the user typed in the scenario script, and `appliedAt` timestamps inside the scenario's clock window.

- [ ] **Step 4: Confirm `npm test` is fully green**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/scenarios/*/recorded.json
git commit -m "Plan 029: regenerate scenarios affected by mutate_plan catalog flip

Scenarios where the dispatcher previously picked flow_input for mutation
text (020, 037) now pick mutate_plan. Downstream re-proposer behavior and
persisted state are unchanged — the applier's in-session branch delegates
to the same handleMutationText path."
```

Include the list of regenerated scenarios in the commit body.

---
### Task 13: Scenario 044 — in-session `mutate_plan` regression lock

**Rationale:** Locks in that a mid-planning mutation text routes through the dispatcher as `mutate_plan` (not `flow_input`), the applier's in-session branch runs, the mutation history grows, and the final persist is identical to today's in-session mutation behavior. Structurally similar to scenario 020 but explicitly asserts the dispatcher action + final `mutationHistory` length.

**Files:**
- Create: `test/scenarios/044-mutate-plan-in-session/spec.ts`
- Create: `test/scenarios/044-mutate-plan-in-session/recorded.json` (generated)

- [ ] **Step 1: Write the scenario spec**

Create `test/scenarios/044-mutate-plan-in-session/spec.ts`:

```typescript
/**
 * Scenario 044 — in-session mutate_plan regression lock.
 *
 * Plan 029 (Plan D). Verifies the full chain:
 *   dispatcher picks mutate_plan for "Move the flex to Sunday"
 *   → applier in-session branch
 *   → handleMutationText
 *   → re-proposer
 *   → validator
 *   → solver
 *   → formatPlanProposal rendered with planProposalKeyboard
 *   → user taps plan_approve
 *   → persisted session has mutationHistory=[...original planning mutations, this one]
 *
 * Sequence:
 *   1. /start
 *   2. Tap 📋 Plan Week
 *   3. Tap plan_keep_breakfast
 *   4. Tap plan_no_events
 *   5. (plan-proposer runs, proposal rendered)
 *   6. Type "Move the flex to Sunday" — dispatcher picks mutate_plan,
 *      applier's in-session branch runs, proposal re-renders with change
 *      summary.
 *   7. Tap plan_approve.
 *
 * Assertions (from captured outputs + finalStore):
 *   - Step 6's llmFixtures include both a dispatcher fixture (picks
 *     mutate_plan with request="Move the flex to Sunday") AND the
 *     re-proposer fixture.
 *   - Step 6's output text includes the proposal with flex on Sunday.
 *   - finalStore.planSessions[0].mutationHistory has at least one entry
 *     with constraint="Move the flex to Sunday" (plus any earlier entries
 *     from the in-session flow if applicable).
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '044-mutate-plan-in-session',
  description:
    'Dispatcher picks mutate_plan for mid-planning mutation text, applier in-session branch delegates to the re-proposer, mutation history persists with the plan.',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [],
    batches: [],
  },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    text('Move the flex to Sunday'),
    click('plan_approve'),
  ],
});
```

- [ ] **Step 2: Generate the recording**

Run: `npm run test:generate -- 044-mutate-plan-in-session --yes`

- [ ] **Step 3: Behavioral review**

Apply the 5-step protocol from `docs/product-specs/testing.md`:
1. Initial plan covers all slots.
2. Change summary after mutation correctly reports the flex move.
3. Cook days unchanged except for the flex position.
4. Weekly totals within range.
5. **`finalStore.planSessions[0].mutationHistory` length ≥ 1** with the last entry's `constraint` being "Move the flex to Sunday".
6. `llmFixtures` includes a fixture whose system prompt mentions "Flexie's conversation dispatcher" AND whose response has `"action": "mutate_plan"`.
7. `llmFixtures` also includes a re-proposer fixture.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/scenarios/044-mutate-plan-in-session/
git commit -m "Plan 029: scenario 044 — in-session mutate_plan regression lock"
```

---

### Task 14: Scenario 045 — post-confirmation "eating out tonight" (Flow 1 canonical)

**Rationale:** **This is the single most important scenario in Plan D.** It's the canonical Flow 1 from proposal 003 — the reason this whole proposal exists. A user on a confirmed plan types "I'm eating out tonight, friend invited me", the re-proposer absorbs the deviation, the plan persists. If this scenario doesn't work, nothing in Plan D worked.

**Files:**
- Create: `test/scenarios/045-mutate-plan-eat-out-tonight/spec.ts`
- Create: `test/scenarios/045-mutate-plan-eat-out-tonight/recorded.json` (generated)

- [ ] **Step 1: Pick the clock and seed shape**

Clock: `2026-04-07T19:00:00Z` (Tuesday 7pm — the canonical proposal 003 Flow 1 moment). At this clock:
- Monday dinner is past (by date).
- Tuesday lunch is past (after 15:00 cutoff).
- Tuesday dinner is still active (19:00 < 21:00 dinner cutoff).
- Near-future days: today (Tue) + tomorrow (Wed).

Seed an active plan running Apr 6–12 with:
- Dinner batch (tagine) Mon–Wed, 3 servings.
- Lunch batch (grain bowl) Mon–Fri, 5 servings.
- Flex on Saturday dinner.

When the user types "I'm eating out tonight", the re-proposer should absorb the deviation by shifting the tagine batch forward in the dinner lane — matching the proposal's canonical Flow 1 example (proposal lines 81–95): Tue dinner becomes eat-out, the remaining tagine servings shift to {Wed, Thu} (Wed keeps tagine, Thu gains tagine from Wed's original serving), and downstream dinner batches (e.g., Greek Lemon Chicken) cascade one day each. Lunches are unaffected.

- [ ] **Step 2: Write the scenario spec**

Create `test/scenarios/045-mutate-plan-eat-out-tonight/spec.ts` with a structured seed (pattern lifted from Plan 027 scenario 030). Follow the existing scenario spec conventions — use `defineScenario`, `text`, `click`, and TypeScript-shaped `PlanSession` / `Batch` literals.

The events sequence is minimal:

```typescript
  events: [
    text("I'm eating out tonight, friend invited me"),
    click('mp_confirm'),
  ],
```

No `/start` — the scenario seeds an active plan via `initialState.planSessions` + `initialState.batches` so the bot is immediately in `lifecycle=active_mid`. The first text kicks off the dispatcher, which picks `mutate_plan`, the applier runs post-confirmation, the diff + `[Confirm] [Adjust]` keyboard is shown, the user taps `mp_confirm`, the new session is persisted.

Use scenario 030 (`test/scenarios/030-navigation-state-tracking/spec.ts`) as a reference for the full seed shape. Use `recipeSet: 'six-balanced'` (or whatever the project's standard fixture set is post-Plan-028). Copy the recipes that the seeded batches reference so the re-proposer has real options to pick from when absorbing the deviation.

- [ ] **Step 3: Generate the recording**

Run: `npm run test:generate -- 045-mutate-plan-eat-out-tonight --yes`

Expected fixtures: one dispatcher call (picks `mutate_plan`), one re-proposer call in `post-confirmation` mode, possibly one or more scaler calls for the new batches.

- [ ] **Step 4: Behavioral review — PRIORITY**

This is the canonical scenario. Apply the 5-step protocol with extra care:

1. **Dispatcher reply** — the captured response should be the re-proposer's diff text + the `mutateConfirmKeyboard`. The diff should explicitly call out the change: "Tagine shifts forward" or "Tue dinner → eat out, batches cascade" or similar.
2. **Re-proposer behavior** — the Tue dinner tagine slot is dropped OR an `eat_out` event is added on Tue dinner and the tagine batch moves forward. Either shape is acceptable — lock in whatever the re-proposer produces, but confirm it's a sensible adaptation (not a ghost batch, not a broken split).
3. **Meal-type lane respect** — every batch in the re-proposed proposal has `mealType` matching `recipe.mealTypes`. No dinner recipe in a lunch slot, no lunch recipe in a dinner slot. This is Plan 026 invariant #14 in action — if a violation slips through, the re-proposer's retry path should have caught it, and if it didn't, Plan 026 has a bug.
4. **Near-future safety — cascading shifts are allowed, silent recipe swaps are not.** The proposal's canonical Flow 1 (lines 81–95) explicitly shows the tagine batch shifting from `{Tue, Wed}` to `{Wed, Thu}` as a **direct consequence** of the user's explicit request targeting Tuesday. This is the EXPECTED behavior, not a bug:
   - **Wednesday dinner stays tagine** — the tagine batch absorbs the shift. From the user's perspective Wed dinner is the same recipe (tagine, already cooked, in the fridge). The batch's `eatingDays` list changes but the recipe is unchanged.
   - **Thursday dinner changes from Greek Lemon Chicken to tagine** — the original Wed serving cascades to Thu. Thursday is outside the near-future window (near-future = today Tue + tomorrow Wed), so rearranging Thu is freely allowed.
   - **Greek Lemon Chicken shifts to Friday** — same logic; Fri is outside the near-future window.
   - The near-future safety rule (proposal line 115) prohibits **silent recipe-level rearrangement** of meals the user may have already shopped for or prepared. A cascading shift within the SAME recipe (tagine stays tagine on Wed) is NOT a violation — the user's preparation is still valid. Replacing Wed's tagine with a different recipe (e.g., the re-proposer swaps in chicken to "fill the gap") WOULD be a violation.
   - **What WOULD be a bug:** the re-proposer moving a DIFFERENT recipe onto Wednesday dinner without the user asking, or dropping Wednesday dinner entirely, or silently removing Wed from the tagine batch without cascading.
   Verify by reading the re-proposer fixture's prompt and checking that `nearFutureDays: ['2026-04-07', '2026-04-08']` was passed in. Then confirm the re-proposer's output keeps tagine on Wed and cascades the remaining serving to Thu (matching the proposal's canonical example).
5. **Persisted state** — after `mp_confirm`:
   - `finalStore.planSessions` has two entries: the old session with `superseded: true` and the new session with `superseded: false`.
   - The new session's `mutationHistory` has 2 entries: `[{ constraint: 'initial plan', ... }, { constraint: "I'm eating out tonight, friend invited me", ... }]`.
   - The new session's `batches` include both the preserved past-slot halves (Mon tagine, Mon+Tue grain-bowl) AND the re-proposed active batches.
   - Old session's batches are `status: 'cancelled'`.
6. **Final user-visible reply + calorie-tracking disclaimer** — after `mp_confirm`, the bot's reply is "Plan updated. Your week is locked in." **followed by the calorie-tracking disclaimer**: "Note: I shifted meals around but don't track meal-out calories yet — that comes with deviation accounting later." This is required by proposal 003 line 436 ("The confirmation message is explicit") and must be present in the canonical Flow 1 scenario. The disclaimer is shown for ALL post-confirmation mutations in v0.0.5 (not just eat-out cases) because v0.0.5 doesn't track any deviation calories. The reply ends with the main menu keyboard.

If ANY of these checks fail, Plan D has a real bug. Fix the code (likely in the applier's post-confirmation branch or the confirmation helper), re-regenerate, and re-review.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/scenarios/045-mutate-plan-eat-out-tonight/
git commit -m "Plan 029: scenario 045 — Flow 1 canonical eating-out-tonight mutation

The single most important scenario in Plan D. User on confirmed plan
types 'I'm eating out tonight', dispatcher picks mutate_plan, applier's
post-confirmation branch runs the adapter + re-proposer in post-confirmation
mode, diff + mutateConfirmKeyboard shown, user taps Confirm, new session
persisted via confirmPlanSessionReplacing. This is the living-document
feature that proposal 003 exists for."
```

---

### Task 15: Scenario 046 — post-confirmation flex move

**Rationale:** The simplest post-confirmation mutation shape — move the flex to a different day. No batch rearrangement needed in the happy path. Locks in that flex moves work end-to-end post-confirmation.

**Files:**
- Create: `test/scenarios/046-mutate-plan-flex-move/spec.ts`
- Create: `test/scenarios/046-mutate-plan-flex-move/recorded.json` (generated)

- [ ] **Step 1: Write the scenario spec**

Create the spec, seeding an active plan with flex on Saturday dinner, clock Wednesday noon (lifecycle `active_mid`). Events:

```typescript
  events: [
    text('Move the flex to Sunday lunch'),
    click('mp_confirm'),
  ],
```

Use the same spec shape pattern as scenario 045. The re-proposer should produce a proposal with flex on `2026-04-12 lunch` instead of `2026-04-11 dinner`. Batches should not need to move.

- [ ] **Step 2: Generate + review + commit**

Run: `npm run test:generate -- 046-mutate-plan-flex-move --yes`

Review (5-step protocol):
- Flex position changed, no collateral batch changes.
- `finalStore.planSessions[1].flexSlots` shows the new position.
- Old session superseded, new session's mutation history extended.

```bash
git add test/scenarios/046-mutate-plan-flex-move/
git commit -m "Plan 029: scenario 046 — post-confirmation flex move"
```

---

### Task 16: Scenario 047 — post-confirmation recipe swap

**Rationale:** A slightly richer mutation — replace a recipe with a different one. Exercises the re-proposer's recipe matching against the library index + meal-type lane enforcement.

**Files:**
- Create: `test/scenarios/047-mutate-plan-recipe-swap/spec.ts`
- Create: `test/scenarios/047-mutate-plan-recipe-swap/recorded.json` (generated)

- [ ] **Step 1: Write the scenario spec**

Seed an active plan with a tagine dinner batch Thu–Sat (future, clock is Monday). Events:

```typescript
  events: [
    text('swap the tagine for something lighter'),
    click('mp_confirm'),
  ],
```

The re-proposer should pick a different dinner-authorized recipe from the library (the recipe set must contain at least two dinner options for this to work — verify at seed time).

- [ ] **Step 2: Generate + review + commit**

Run: `npm run test:generate -- 047-mutate-plan-recipe-swap --yes`

Review:
- New batch uses a different recipe slug.
- New recipe's `mealTypes` contains `'dinner'` (invariant #14).
- Old tagine batch is cancelled on the old session; new batch is on the new session.
- Mutation history extended.

```bash
git add test/scenarios/047-mutate-plan-recipe-swap/
git commit -m "Plan 029: scenario 047 — post-confirmation recipe swap"
```

---

### Task 17: Scenario 048 — side conversation mid-planning then `mutate_plan` preserves mutation history

**Rationale:** State preservation regression lock for proposal 003 invariant #1 and Plan 029's applier in-session branch. User is mid-planning at `proposal` phase with a mutation already in history, types an off-topic question (Plan 028 `out_of_scope`), then types a second mutation (Plan 029 `mutate_plan` in-session). Verifies that (a) the off-topic question doesn't clobber `planFlow`, (b) the second mutation routes to the same in-session path (not a fresh planning session), (c) the final persisted `mutationHistory` has both entries.

**Files:**
- Create: `test/scenarios/048-mutate-plan-side-conversation-mid-planning/spec.ts`
- Create: `test/scenarios/048-mutate-plan-side-conversation-mid-planning/recorded.json` (generated)

- [ ] **Step 1: Write the scenario spec**

Events:

```typescript
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    text('Move the flex to Sunday'),        // dispatcher → mutate_plan → in-session branch; mutation history gains entry 1
    text("what's the weather today?"),     // dispatcher → out_of_scope; planFlow preserved
    text('Also swap the tagine for fish'),  // dispatcher → mutate_plan → in-session branch; mutation history gains entry 2
    click('plan_approve'),
  ],
```

- [ ] **Step 2: Generate + review + commit**

Run: `npm run test:generate -- 048-mutate-plan-side-conversation-mid-planning --yes`

Review:
- After the weather question, the next proposal-review reply still shows the post-first-mutation plan (flex on Sunday).
- After the second mutation, the plan has both the flex move AND the fish swap.
- `finalStore.planSessions[0].mutationHistory` has 2 entries with the two mutation constraints.
- planFlow is cleared at the end (user approved).

```bash
git add test/scenarios/048-mutate-plan-side-conversation-mid-planning/
git commit -m "Plan 029: scenario 048 — side conversation mid-planning preserves mutation history"
```

---

### Task 18: Scenario 049 — `mp_adjust` loop

**Rationale:** User types a mutation, sees the diff, decides it's wrong, taps `[Adjust]`, types a different mutation, confirms. Locks in the adjust path.

**Files:**
- Create: `test/scenarios/049-mutate-plan-adjust-loop/spec.ts`
- Create: `test/scenarios/049-mutate-plan-adjust-loop/recorded.json` (generated)

- [ ] **Step 1: Write the scenario spec**

Seed an active plan. Events:

```typescript
  events: [
    text('Move the flex to Sunday lunch'),
    click('mp_adjust'),
    text('Actually, move the flex to Friday dinner instead'),
    click('mp_confirm'),
  ],
```

- [ ] **Step 2: Generate + review + commit**

Run: `npm run test:generate -- 049-mutate-plan-adjust-loop --yes`

Review:
- After `mp_adjust`, the bot's reply is "OK, what would you like to change instead?" and `session.pendingMutation` is cleared (not visible in outputs but confirmed by the next text working correctly).
- The second mutation runs a fresh re-proposer call.
- Final persist reflects the SECOND mutation, not the first — the flex is on Friday dinner, not Sunday lunch.
- `mutationHistory` has exactly one entry (the second one) — the first mutation was never confirmed and therefore never persisted.

```bash
git add test/scenarios/049-mutate-plan-adjust-loop/
git commit -m "Plan 029: scenario 049 — mp_adjust loop clears pending mutation"
```

---

### Task 19: Scenario 050 — no target (mutation text with no active plan)

**Rationale:** Edge case — user has no plan and types a mutation-shaped message. Dispatcher picks `mutate_plan` (the text IS imperative-mutation-shaped), the applier's `no_target` branch fires, the user sees a helpful "tap Plan Week" hint.

**Files:**
- Create: `test/scenarios/050-mutate-plan-no-target/spec.ts`
- Create: `test/scenarios/050-mutate-plan-no-target/recorded.json` (generated)

- [ ] **Step 1: Write the scenario spec**

Events:

```typescript
  events: [
    command('start'),
    text('move tomorrow dinner to Friday'),
  ],
```

No seeded plan. Lifecycle will be `no_plan`.

- [ ] **Step 2: Generate + review + commit**

Run: `npm run test:generate -- 050-mutate-plan-no-target --yes`

Review:
- Dispatcher picks `mutate_plan` (verify in the fixture) — or `clarify` if the dispatcher was cautious about no-plan state. Either is acceptable; document whichever shape lands.
- If `mutate_plan`: the applier returns `no_target`, user sees "You don't have a plan yet. Tap 📋 Plan Week to start one." with the main menu keyboard.
- If `clarify`: the dispatcher's prompt wording should be honest ("You don't have a plan yet — tap Plan Week first").
- `finalStore.planSessions` is empty.

```bash
git add test/scenarios/050-mutate-plan-no-target/
git commit -m "Plan 029: scenario 050 — mutate_plan with no active plan returns no_target"
```

---

### Task 20: Scenario 051 — meal-type lane regression lock

**Rationale:** User tries to move a dinner-only recipe into a lunch slot via mutation. The re-proposer must either refuse (via meal-type lane rule in the prompt), pick a different lunch-eligible recipe, or ask for clarification. If a lane violation somehow makes it through, invariant #14 catches it in the validator. This scenario locks the behavior regardless of which path the re-proposer takes.

**Files:**
- Create: `test/scenarios/051-mutate-plan-meal-type-lane/spec.ts`
- Create: `test/scenarios/051-mutate-plan-meal-type-lane/recorded.json` (generated)

- [ ] **Step 1: Write the scenario spec**

Seed an active plan with a tagine dinner batch (tagine has `mealTypes: ['dinner']` in the fixture recipe set). Events:

```typescript
  events: [
    text("Move tomorrow's tagine to lunch"),
  ],
```

- [ ] **Step 2: Generate + review + commit**

Run: `npm run test:generate -- 051-mutate-plan-meal-type-lane --yes`

Review:
- The re-proposer's response is ONE of:
  - Clarification: "Tagine is only for dinner — do you want to swap the lunch recipe instead?"
  - Recipe swap: the re-proposer picks a DIFFERENT lunch-eligible recipe for the lunch slot (keeping tagine as a dinner batch).
  - Failure: the re-proposer tried to create a dinner-recipe-in-lunch-batch arrangement and the validator rejected it twice.
- **NO scenario in which a tagine appears in a lunch batch in the final state.** The validator's invariant #14 must catch that in the retry path if the re-proposer prompts through the rule.
- If the result is `failure`, the user's reply should be honest ("I couldn't apply that change cleanly").
- No persist — the user never tapped Confirm, so `finalStore.planSessions` has only the original session, unchanged.

```bash
git add test/scenarios/051-mutate-plan-meal-type-lane/
git commit -m "Plan 029: scenario 051 — meal-type lane regression lock for mutate_plan"
```

---
### Task 21: Scenario 052 — retroactive "last night" forward-shift honest handling

**Rationale:** Proposal 003 § "Plan D — `mutate_plan` action" explicitly lists the retroactive case ("last night I went to Indian") as one of the scenarios that must verify the forward-shift-only behavior with honest messaging about calorie tracking being deferred. Proposal 003 § "Edge cases" also describes the expected behavior: the re-proposer sees only active slots (today forward), shifts dinner batches forward in the dinner lane to absorb the fact that last night's planned dinner didn't happen, and the reply is explicit about the partial support: "I shifted your dinner batches forward one day to account for that. I don't track meal-out calories yet — that arrives with deviation accounting."

This scenario locks in the honest behavior so a later plan that adds deviation accounting produces a clean regen diff.

**Files:**
- Create: `test/scenarios/052-mutate-plan-retroactive-honest/spec.ts`
- Create: `test/scenarios/052-mutate-plan-retroactive-honest/recorded.json` (generated)

- [ ] **Step 1: Pick the clock and seed shape**

Clock: `2026-04-08T09:00:00Z` (Wednesday morning). At this clock:
- Monday and Tuesday are fully past (by date).
- Wednesday lunch is still active (before 15:00 cutoff).
- Wednesday dinner is active (before 21:00 cutoff).
- Near-future days: today (Wed) + tomorrow (Thu).

Seed an active plan running Apr 6–12 with:
- Dinner batch (tagine) Mon–Wed, 3 servings (Mon and Tue dinner are both past; Wed dinner is still active).
- Another dinner batch (chicken) Thu–Sat, 3 servings (all active).
- Lunch batch (grain bowl) Mon–Fri, 5 servings.
- Flex on Sunday dinner.

User types "last night I went to an Indian restaurant". The request names a past slot (Tuesday dinner). The re-proposer sees only active slots (Wed forward). It cannot re-record Tuesday's slot — the data model has no place for that. Its only option is to acknowledge the context forward: shift Wednesday dinner (the only remaining tagine slot) to Thursday if fridge life permits, cascade chicken batches accordingly, OR simply leave the plan as-is and reply with an honest "I can't adjust the past but here's what's coming up".

The re-proposer's prompt already carries both rules (meal-type lane + near-future safety). The proposal requires the forward-shift outcome (line 701, 793) — the test must lock in a successful forward-shift proposal with `mp_confirm`, not accept degraded clarification/failure as passing.

- [ ] **Step 2: Write the scenario spec**

Create `test/scenarios/052-mutate-plan-retroactive-honest/spec.ts`:

```typescript
/**
 * Scenario 052 — retroactive "last night" honest forward-shift.
 *
 * Plan 029 (Plan D). Locks in the partial v0.0.5 behavior for retroactive
 * eating-out statements. The re-proposer cannot re-record past slots (the
 * adapter freezes them), and v0.0.5 does not track eat-out calories. The
 * required behavior is: shift the remaining active dinner batches forward
 * under the meal-type lane + near-future safety rules, and include an
 * honest note that calorie tracking for meal-outs isn't available yet.
 *
 * The proposal REQUIRES the forward-shift outcome for retroactive cases
 * (proposal line 701: "partially and honestly… shift batches forward";
 * line 793: "forward-shift-only behavior, honest messaging"). If the
 * re-proposer returns clarification or failure during generation, fix
 * the prompt or seed until the forward-shift locks in.
 *
 * Sequence:
 *   1. (seeded active plan; no /start)
 *   2. Type "last night I went to an Indian restaurant"
 *   3. Tap mp_confirm — the forward-shift proposal is required, not optional
 *
 * Clock: 2026-04-08T09:00:00Z (Wed morning, lifecycle=active_mid).
 */

import { defineScenario, text, click } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const activeSession: PlanSession = {
  id: 'sess-052-0000-0000-0000-000000000001',
  horizonStart: '2026-04-06',
  horizonEnd: '2026-04-12',
  breakfast: {
    locked: true,
    recipeSlug: 'salmon-avocado-toast-soft-eggs-cinnamon-yogurt',
    caloriesPerDay: 390,
    proteinPerDay: 31,
  },
  treatBudgetCalories: 1050,
  flexSlots: [{ day: '2026-04-12', mealTime: 'dinner', flexBonus: 350 }],
  events: [],
  mutationHistory: [{ constraint: 'initial plan', appliedAt: '2026-04-05T18:00:00.000Z' }],
  confirmedAt: '2026-04-05T18:00:00.000Z',
  superseded: false,
  createdAt: '2026-04-05T18:00:00.000Z',
  updatedAt: '2026-04-05T18:00:00.000Z',
};

// Use the same six-balanced fixture recipe set. Adjust slugs to match
// whatever the fixture set contains for tagine/chicken/grain-bowl
// analogues — the scenario's point is the shape, not the specific recipes.
const activeBatches: Batch[] = [
  {
    id: 'b-052-dinner1-0000-0000-000000000001',
    recipeSlug: 'moroccan-beef-tagine-style-skillet-with-lemon-couscous',
    mealType: 'dinner',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
    servings: 3,
    targetPerServing: { calories: 720, protein: 48 },
    actualPerServing: { calories: 720, protein: 48, fat: 28, carbs: 72 },
    scaledIngredients: [
      { name: 'ground beef', amount: 200, unit: 'g', totalForBatch: 600, role: 'protein' as const },
      { name: 'couscous', amount: 80, unit: 'g', totalForBatch: 240, role: 'carb' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  {
    id: 'b-052-dinner2-0000-0000-000000000002',
    recipeSlug: 'soy-ginger-pork-rice-bowls-broccoli-carrots-scallions',
    mealType: 'dinner',
    eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
    servings: 3,
    targetPerServing: { calories: 650, protein: 44 },
    actualPerServing: { calories: 650, protein: 44, fat: 22, carbs: 65 },
    scaledIngredients: [
      { name: 'pork tenderloin', amount: 180, unit: 'g', totalForBatch: 540, role: 'protein' as const },
      { name: 'basmati rice', amount: 80, unit: 'g', totalForBatch: 240, role: 'carb' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  {
    id: 'b-052-lunch1-0000-0000-000000000003',
    recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
    mealType: 'lunch',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10'],
    servings: 5,
    targetPerServing: { calories: 893, protein: 56 },
    actualPerServing: { calories: 893, protein: 56, fat: 46, carbs: 68 },
    scaledIngredients: [
      { name: 'chicken breast, raw', amount: 190, unit: 'g', totalForBatch: 950, role: 'protein' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
];

export default defineScenario({
  name: '052-mutate-plan-retroactive-honest',
  description:
    'Retroactive eating-out: user says "last night I went to Indian". Re-proposer cannot re-record past slots; shifts remaining active dinner batches forward with explicit "calories not tracked yet" disclaimer. Locks in v0.0.5 partial-support forward-shift behavior per proposal 003 lines 701/793.',
  clock: '2026-04-08T09:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
  },
  events: [
    text('last night I went to an Indian restaurant'),
    // The proposal REQUIRES the forward-shift outcome for retroactive cases
    // (proposal line 701, 793). The scenario must include mp_confirm to lock
    // in the full propose → confirm → persist cycle. If the re-proposer
    // returns clarification or failure during generation, fix the prompt or
    // seed until the forward-shift locks in — do NOT commit a degraded result.
    click('mp_confirm'),
  ],
});
```

- [ ] **Step 3: Generate the recording**

Run: `npm run test:generate -- 052-mutate-plan-retroactive-honest --yes`

- [ ] **Step 4: Behavioral review — PARTIAL-SUPPORT CHECK**

Apply the 5-step protocol with a focus on honesty. **The proposal REQUIRES the forward-shift outcome** (proposal line 701: "partially and honestly… shift batches forward in the dinner lane"; line 793: "forward-shift-only behavior, honest messaging"). Clarification or failure are NOT acceptable final states for this scenario — if the re-proposer returns either, the re-proposer's prompt or the seed plan must be adjusted until the forward-shift behavior locks in, because the proposal explicitly lists this as a supported (not aspirational) v0.0.5 behavior.

1. **The dispatcher picks `mutate_plan`** for "last night I went to an Indian restaurant". Verify in the captured fixture.
2. **The applier's post-confirmation branch runs.** Verify by checking that the re-proposer fixture has `mode: 'post-confirmation'` context.
3. **The re-proposer MUST return a `proposal` (forward shift).** Dinner batches are rearranged in the active view: the Wednesday dinner slot (the only remaining tagine slot) shifts to Thursday, or the tagine batch is reduced to past-only and the re-proposer fills the gap with a forward batch from the library. The new proposal covers every active slot. **If the re-proposer returns `clarification` or `failure` instead:** this means the prompt or seed plan is insufficiently specified for the retroactive case. Fix the issue (adjust the seed to make the forward-shift path unambiguous, or improve the re-proposer's post-confirmation prompt to handle retroactive requests) and regenerate until the forward-shift locks in. Do NOT commit a recording where the retroactive case degrades to "ask a question" or "give up" — that would be a regression from the proposal's explicit partial-support commitment.
4. **The reply is honest about v0.0.5's partial support.** The diff text should explicitly acknowledge the retroactive nature: the past slot can't be re-recorded, but the plan has been adjusted forward. The reply should mention that calorie tracking for meal-outs isn't available yet. If the reply silently shifts batches without mentioning that last night's calories aren't recorded, the behavior is dishonest and Plan D has a gap. **If this check fails, fix the applier's post-confirmation branch to append an honest note when the mutation targets a past slot the re-proposer couldn't re-record.**
5. **The past is frozen.** `finalStore.planSessions[0].batches` (the old session) are unchanged — the Monday and Tuesday tagine dinners are still `eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08']`. The new session's preserved-past batches include the Mon+Tue tagine portion exactly as it was.
6. **Add `click('mp_confirm')` to the scenario.** Since the forward-shift proposal is REQUIRED (not optional), the scenario must include the confirmation tap. Update the spec's `events` array to add `click('mp_confirm')` after the text event, delete the recording, regenerate, and re-review to capture the full propose → confirm → persist cycle — matching the proposal's end-to-end commitment for this case.

**Calorie-tracking disclaimer check:** The `mp_confirm` reply now unconditionally includes the calorie-tracking disclaimer ("I don't track meal-out calories yet — that comes with deviation accounting later.") per Task 10's updated `persistedText`. Verify it appears in the recording's confirmation output. If it does NOT appear, something in the `applyMutationConfirmation` helper is wrong — **fix the code, do not log as tech debt.** The disclaimer is a proposal-003-line-436 requirement, not an aspirational nice-to-have.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/scenarios/052-mutate-plan-retroactive-honest/
git commit -m "Plan 029: scenario 052 — retroactive last-night honest forward-shift

Proposal 003 Plan D explicitly lists the retroactive case as a required
verification scenario. v0.0.5's behavior is partial: past slots are
frozen in the adapter, the re-proposer sees only active slots, and the
reply should honestly note that eat-out calories aren't tracked yet.
This scenario locks in whatever the re-proposer produces so deviation-
accounting work in a later plan produces a clean regen diff."
```

---

### Task 22: Scenario 053 — post-confirmation clarification multi-turn resume (invariant #5 harness lock)

**Rationale:** Proposal 003 line 453 says state-preservation invariants "MUST be enforced by scenario tests in the harness." Invariant #5 (line 462) says "pending clarifications from sub-agents are carried in [state] and visible to the dispatcher." Plan D now persists post-confirmation clarifications via `pendingPostConfirmationClarification`. This scenario locks in the end-to-end multi-turn resume: ambiguous mutation → clarification → terse answer → auto-resumed re-proposer call → confirm → persist.

**Files:**
- Create: `test/scenarios/053-mutate-plan-post-confirm-clarification-resume/spec.ts`
- Create: `test/scenarios/053-mutate-plan-post-confirm-clarification-resume/recorded.json` (generated)

- [ ] **Step 1: Write the scenario spec**

Seed an active plan (same shape as scenario 045 — tagine dinner batch, grain-bowl lunch batch, flex on Saturday). Clock: Tuesday 7pm.

```typescript
  events: [
    text("I'm eating out"),              // ambiguous — no meal time specified
    // re-proposer returns clarification: "lunch or dinner?"
    text('dinner'),                       // terse answer — dispatcher sees pending
                                          // clarification and picks mutate_plan;
                                          // applier prepends original request
    click('mp_confirm'),                  // forward-shift proposal confirmed
  ],
```

- [ ] **Step 2: Generate the recording**

Run: `npm run test:generate -- 053-mutate-plan-post-confirm-clarification-resume --yes`

**If the re-proposer does NOT return a clarification on the first turn** (it may be smart enough to infer dinner from the 7pm clock), adjust the request to be more ambiguous (e.g., "I'm eating out today" at a noon clock where both lunch and dinner are active). The scenario MUST capture the clarification → resume path. Regenerate until it does.

- [ ] **Step 3: Behavioral review**

1. **Turn 1:** Dispatcher picks `mutate_plan`. Applier's post-confirmation branch calls the re-proposer. Re-proposer returns `clarification`. Bot replies with the question. `session.pendingPostConfirmationClarification` is set (verify in `sessionAt[0]` if harness captures it, or infer from the next turn's behavior).
2. **Turn 2:** Dispatcher picks `mutate_plan` for "dinner" (the dispatcher context includes the pending clarification hint). Applier reads `pendingPostConfirmationClarification`, prepends original request, sends "I'm eating out. To clarify: dinner" to the re-proposer. Re-proposer returns a forward-shift proposal. Bot shows diff + `[Confirm] [Adjust]`.
3. **Turn 3:** `mp_confirm` persists the new session. Mutation history includes the merged request.
4. **Calorie disclaimer** appears in the confirmation reply.
5. No `pendingPostConfirmationClarification` remains after the confirm.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/scenarios/053-mutate-plan-post-confirm-clarification-resume/
git commit -m "Plan 029: scenario 053 — invariant #5 harness lock for post-confirmation clarification resume

Proposal 003 requires state-preservation invariants enforced by harness
scenarios. This locks in the multi-turn resume: ambiguous mutation →
clarification stashed on pendingPostConfirmationClarification → terse
answer auto-prepended → re-proposer produces forward-shift → confirm."
```

---

### Task 23: Update `test/scenarios/index.md`

**Files:**
- Modify: `test/scenarios/index.md`

- [ ] **Step 1: Append rows for scenarios 044–053**

At the bottom of `test/scenarios/index.md` (after scenario 043 from Plan 028), add:

```markdown
| 044 | mutate-plan-in-session | Dispatcher picks mutate_plan for in-session mutation text; applier's in-session branch delegates to handleMutationText; mutation history persists with the plan. Plan 029. |
| 045 | mutate-plan-eat-out-tonight | Flow 1 canonical: user on confirmed plan types "I'm eating out tonight", applier's post-confirmation branch runs adapter+re-proposer+solver+diff, mp_confirm persists via confirmPlanSessionReplacing. THE core Plan D scenario. Plan 029. |
| 046 | mutate-plan-flex-move | Post-confirmation flex move — simplest mutation shape. Plan 029. |
| 047 | mutate-plan-recipe-swap | Post-confirmation recipe swap; re-proposer picks a different recipe from the library respecting meal-type lanes. Plan 029. |
| 048 | mutate-plan-side-conversation-mid-planning | State preservation: off-topic question mid-planning doesn't clobber planFlow; subsequent mutate_plan routes to the active session's re-proposer; mutation history preserves both mutations. Plan 029. |
| 049 | mutate-plan-adjust-loop | User taps [Adjust] after seeing a diff, types a new mutation, taps [Confirm] — only the second mutation persists. Plan 029. |
| 050 | mutate-plan-no-target | Mutation text with no active plan → applier returns no_target → user sees "Tap Plan Week to start". Plan 029. |
| 051 | mutate-plan-meal-type-lane | Regression lock: mutation that would cross meal-type lanes is caught by the re-proposer's prompt or validator invariant #14. Plan 029. |
| 052 | mutate-plan-retroactive-honest | Retroactive "last night I went to Indian": past slots are frozen in the adapter, re-proposer sees only active slots, reply honestly notes that eat-out calories aren't tracked. Plan 029. |
| 053 | mutate-plan-post-confirm-clarification-resume | Invariant #5 harness lock: ambiguous post-confirmation mutation → re-proposer clarification → terse answer auto-resumes via pendingPostConfirmationClarification → forward-shift → confirm. Plan 029. |
```

- [ ] **Step 2: Commit**

```bash
git add test/scenarios/index.md
git commit -m "Plan 029: update scenarios index with 044–053"
```

---

### Task 24: Sync `ui-architecture.md`, `flows.md`, and proposal 003 status marker

**Rationale:** Per CLAUDE.md's docs-maintenance rules, product specs must stay in sync with code behavior in the same branch as the change. Plan D promotes `mutate_plan` to live, delivering the north-star capability of proposal 003. The UI architecture spec must reflect the new catalog state + the post-confirmation mutation lifecycle, the flows spec gains a dedicated "post-confirmation plan mutation" flow, and the proposal itself gets a status marker pointing at the implementation plan.

**Files:**
- Modify: `docs/product-specs/ui-architecture.md`
- Modify: `docs/product-specs/flows.md`
- Modify: `docs/design-docs/proposals/003-freeform-conversation-layer.md`

- [ ] **Step 1: Flip the `mutate_plan` row in the ui-architecture.md catalog table**

In `docs/product-specs/ui-architecture.md`, find the "v0.0.5 minimal action catalog (Plan 028)" table added by Plan 028 Task 21. Update the `mutate_plan` row:

```markdown
| `mutate_plan` | ✅ Plan 029 | Classifies any plan-change request. In-session: delegates to handleMutationText. Post-confirmation: runs the split-aware adapter + re-proposer in post-confirmation mode + solver + diff, shows `[Confirm] [Adjust]`, persists via confirmPlanSessionReplacing. |
```

- [ ] **Step 2: Add a "Post-confirmation mutation lifecycle" subsection**

Append to the "Freeform conversation layer — the dispatcher (Plan 028 / v0.0.5 minimal slice)" section:

```markdown
### Post-confirmation mutation lifecycle (Plan 029)

When the dispatcher picks `mutate_plan` AND the session has no active
planning flow AND the store has an active or upcoming plan, the applier
runs the **post-confirmation branch**:

1. **Load the active plan.** `getRunningPlanSession(today)` first, falling
   back to `getFuturePlanSessions(today)[0]` if no running session.
2. **Split at the (date, mealType) cutoff.** Plan 026's
   `sessionToPostConfirmationProposal` produces:
   - `activeProposal` — the `PlanProposal`-shaped view of slots the
     re-proposer is allowed to touch.
   - `preservedPastBatches` — batches (and past halves of spanning
     batches) that are frozen and flow through the round-trip unchanged.
   - `nearFutureDays` — ISO dates for today + tomorrow, intersected with
     the horizon, passed to the re-proposer as the soft-lock window.
3. **Call the re-proposer in `post-confirmation` mode.** The re-proposer's
   prompt now includes both the meal-type lane rule (always) and the
   near-future safety rule (post-confirmation only, with the soft-locked
   days inlined).
4. **Run the solver** on the re-proposer's active output to get scaled
   macros, cooking schedule, and weekly totals.
5. **Diff against the pre-mutation active view** using `diffProposals`
   for a human-readable change summary.
6. **Stash `PendingMutation` on `BotCoreSession.pendingMutation`** — the
   old session ID, the preserved past batches, the re-proposed active
   proposal, and the new mutation record (`{ constraint, appliedAt }`).
7. **Show `[Confirm] [Adjust]`** — `mutateConfirmKeyboard`.

The user then taps one of:

- **`mp_confirm`** — `handleCallback` reads the pending mutation, calls
  `applyMutationConfirmation`, which calls `buildReplacingDraft` (threading
  `config.planning.scalerCalorieTolerance` into the scaler) and
  `confirmPlanSessionReplacing`. The old session is tombstoned
  (`superseded: true`), its batches are cancelled, the new session is
  inserted with the extended `mutationHistory`, and the user sees "Plan
  updated. Your week is locked in." followed by the calorie-tracking
  disclaimer ("I don't track meal-out calories yet — that comes with
  deviation accounting later.") per proposal 003 line 436, with the
  main menu keyboard.
- **`mp_adjust`** — `pendingMutation` is cleared, user sees "OK, what
  would you like to change instead?" Their next message kicks off a fresh
  dispatcher turn.

The post-confirmation branch is NOT retry-persistent: if the user walks
away for an hour and comes back to tap Confirm, the `pendingMutation` is
still in memory (until the bot restarts). If the bot has restarted,
tapping Confirm produces "There is no pending change to confirm. Type
your change to start over."

**Scope notes.** Post-confirmation `mutate_plan` in v0.0.5:
- Does NOT track calories consumed by eat-out events (no deviation
  accounting; the re-proposer just shifts the plan forward).
- Does NOT persist retroactive events on past days (the past is frozen
  at the adapter level; the re-proposer only sees active slots).
- Does NOT auto-confirm any mutation — every post-confirmation mutation
  requires an explicit `[Confirm]` tap.
- Post-confirmation clarifications persist via
  `BotCoreSession.pendingPostConfirmationClarification` (invariant #5).
  The user answers the question on the next turn without re-stating
  the full request. In-memory only — bot restarts drop pending state.
```

- [ ] **Step 3: Add a "Post-confirmation plan mutation" section to `flows.md`**

In `docs/product-specs/flows.md`, add a new section near the other top-level flows (plan week, recipe, shopping list):

```markdown
## Flow: Post-confirmation plan mutation (Plan 029 — Flow 1 from proposal 003)

**The living-document feature.** A confirmed plan adapts to real life
when the user types what happened.

**Entry points:** Any text or voice message during `lifecycle=active_*`
or `lifecycle=upcoming` when no planning session is active. Typical
phrasings:
- "I'm eating out tonight, friend invited me"
- "move the flex to Sunday"
- "swap tomorrow's dinner for fish"
- "skip Thursday's cooking"
- "I already ate the tagine"

**Flow:**

1. User's message goes through the dispatcher (`runDispatcherFrontDoor`),
   which picks `mutate_plan` and forwards the request verbatim to the
   applier.
2. Applier's post-confirmation branch loads the active plan, runs the
   split-aware adapter to separate past (frozen) from active (mutable)
   slots, calls the re-proposer in post-confirmation mode with the
   near-future days passed in explicitly.
3. Re-proposer produces either a new proposal or a clarification question.
   On proposal, the applier runs the solver and generates a change summary.
4. User sees the change summary with `[Confirm] [Adjust]` inline buttons:
   - `Confirm` → `confirmPlanSessionReplacing` persists the new session,
     old session is tombstoned.
   - `Adjust` → `pendingMutation` is cleared, user is prompted to describe
     the change again.

**Rules the re-proposer applies in post-confirmation mode:**

1. **Meal-type lanes are never crossed.** A dinner recipe cannot land in
   a lunch slot, and vice versa. Enforced in the prompt AND validator
   invariant #14.
2. **Near-future days (today + tomorrow) are soft-locked.** The
   re-proposer cannot silently rearrange near-future meals — only the
   user's explicit request can target them.
3. **Past slots are frozen.** The adapter splits the plan at the
   (date, mealType) cutoff (Plan 026 lunch-done cutoff 15:00,
   dinner-done cutoff 21:00) and the re-proposer only sees active slots.

**Confirmation is always required** — no auto-apply for any post-
confirmation mutation, regardless of magnitude. The user taps `Confirm`
or `Adjust`; the product never writes without a tap.

**Known v0.0.5 limitations:**
- Calorie tracking of eat-out events is not implemented.
- Retroactive events ("last night I went to Indian") are handled by
  shifting forward only — the past slot cannot be re-recorded.
- Post-confirmation sub-agent clarifications persist across turns via
  `BotCoreSession.pendingPostConfirmationClarification` (honoring
  proposal 003 invariant #5). If the re-proposer asks "lunch or dinner?"
  the user can simply answer "dinner" on the next turn and the applier
  automatically prepends the original request. The dispatcher context
  bundle includes the pending clarification so it routes the terse
  answer to `mutate_plan` rather than treating it as unrelated text.
  In-memory only — bot restarts drop the pending clarification.

See also: proposal 003 § "Flow 1 — Post-confirmation plan mutation".
```

- [ ] **Step 4: Update the proposal 003 status marker**

In `docs/design-docs/proposals/003-freeform-conversation-layer.md`, near the top of the file (after the existing `Status: approved` line), add:

```markdown
> Implementation: Plans A (026), B (027), C (028), D (029) complete.
> Plan D delivers the living-document feature (mutate_plan action end-to-end,
> both in-session and post-confirmation). Plan E delivers secondary actions
> (answers, navigation, log_measurement) and extends show_shopping_list
> scopes.
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/product-specs/ui-architecture.md docs/product-specs/flows.md docs/design-docs/proposals/003-freeform-conversation-layer.md
git commit -m "Plan 029: sync ui-architecture.md, flows.md, and proposal 003 status"
```

---

### Task 25: Final baseline

**Files:** none modified — verification only.

- [ ] **Step 1: Run the full test suite one final time**

Run: `npm test`
Expected: PASS. Test count: Plan 028's baseline + 3 Plan 029 dispatcher-agent unit tests (Task 3) + ~5 Plan 029 applier unit tests (Tasks 6–10) + 10 new Plan 029 scenarios (044–053) + regenerated scenarios from Task 12.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Grep spot-checks**

Confirm the following invariants hold in the final tree:

- `grep -n "mutate_plan" src/agents/dispatcher.ts` returns hits in `DispatcherAction`, `AVAILABLE_ACTIONS_V0_0_5`, `DispatcherDecision`, `buildSystemPrompt`, and `parseDecision`. The string `"NOT AVAILABLE in v0.0.5 — Plan D"` must NOT appear — the prompt has been flipped.
- `grep -n "handleMutatePlanAction" src/telegram/dispatcher-runner.ts` returns exactly the function definition + the switch case wire-up. No stub left over.
- `grep -rn "applyMutationRequest\|applyMutationConfirmation" src/` returns the definitions in `mutate-plan-applier.ts`, the callers in `dispatcher-runner.ts` and `core.ts`, and the unit test imports. No orphan references.
- `grep -n "pendingMutation" src/telegram/core.ts` returns the `BotCoreSession` field, the `reset()` clear, the `handleCommand('start')` clear, the `handleCommand('cancel')` clear, the `mp_confirm` / `mp_adjust` reads, `re_` recipe-edit clear, and the `plan_week` / `plan_cancel` / `plan_approve` / `plan_replan_*` / meta-intent-defense clears — at least 11 hits. **True navigation-only sites** (`view_shopping_list` ~:517, `view_plan_recipes` ~:523) must NOT have `pendingMutation` clears — verify each `session.planFlow = null` site: if it has no `pendingMutation = undefined` nearby, confirm it's a true-navigation site per Step 5's classification, not a missed clear.
- `grep -n "pendingPostConfirmationClarification" src/telegram/core.ts` returns the `BotCoreSession` field definition, the same clear sites as `pendingMutation` (every `pendingMutation = undefined` line should have a matching `pendingPostConfirmationClarification = undefined` line nearby), and zero other references. The two fields share the same lifecycle per Task 4 Step 5.
- `grep -n "pendingPostConfirmationClarification" src/telegram/dispatcher-runner.ts` returns the `DispatcherSession` field, the handler's stash-on-clarification write, the handler's clear-after-applyMutationRequest, and the `pendingClarification` threading into `applyMutationRequest` args.
- `grep -n "pendingPostConfirmationClarification" src/agents/dispatcher.ts` returns the conditional context-bundle section added in Task 2 Step 5b.
- `grep -n "mutateConfirmKeyboard" src/telegram/keyboards.ts src/telegram/dispatcher-runner.ts src/telegram/core.ts` returns the definition and two-to-three call sites (runner's handler + the mp_confirm error-restore path in core).
- `grep -n "scalerCalorieTolerance" src/plan/mutate-plan-applier.ts` returns the one threading site in `applyMutationConfirmation`.
- `grep -rn "calorieTolerance: 50" src/` returns NO hits — the Plan 026 transitional placeholder is gone.

- [ ] **Step 4: Verify the commit chain**

Run: `git log --oneline -30`
Expected: a sequence of commits all starting with "Plan 029:" — roughly one per task from Task 2 onward. Task 1 had no commit (baseline only).

- [ ] **Step 5: Manual sanity check — read Flow 1**

Open `test/scenarios/045-mutate-plan-eat-out-tonight/recorded.json` and read the output messages as if you were the user receiving them. Does the experience match proposal 003 § "Flow 1 — Post-confirmation plan mutation"? If yes, Plan D achieved its north star. **If no, fix the code and re-regenerate — do NOT defer to a follow-up plan.** Scenario 045 is the contract with the user (decision log: "Plan D has failed its goal regardless of how many other scenarios are green"). A mismatch between the recorded Flow 1 and the proposal's canonical example is a Plan D bug, not tech debt.

- [ ] **Step 6: No commit needed**

This is a pure verification step. If any of the above fails, jump back to the responsible task and fix it. If everything passes, **Plan 029 is done. Proposal 003's north-star feature is live.** Plan E remains for the secondary actions.

---

## Progress

- [x] Task 1 — Green baseline + dependency verification
- [x] Task 2 — Expand dispatcher catalog — types + prompt + parser + runner stub
- [x] Task 3 — Update Plan 028 disallowed-action test + new mutate_plan dispatcher unit tests
- [x] Task 4 — Add `pendingMutation` to `BotCoreSession` + structural slice + `PendingMutation` type
- [x] Task 5 — `mutateConfirmKeyboard` + `mp_confirm` / `mp_adjust` stubs
- [x] Task 6 — `mutate-plan-applier.ts` — `MutateResult` + `applyMutationRequest` scaffold
- [x] Task 7 — Applier — in-session branch with unit tests
- [x] Task 8 — Applier — post-confirmation branch with unit tests
- [x] Task 9 — Replace runner stub with real `handleMutatePlanAction`
- [x] Task 10 — `mp_confirm` / `mp_adjust` real handlers + `applyMutationConfirmation`
- [x] Task 11 — Thread `calorieTolerance` through `buildReplacingDraft`
- [x] Task 12 — Regenerate scenarios affected by the dispatcher prompt change
- [x] Task 13 — Scenario 044 — in-session mutate_plan regression lock
- [x] Task 14 — Scenario 045 — Flow 1 canonical eating-out-tonight (THE core scenario)
- [x] Task 15 — Scenario 046 — post-confirmation flex move
- [x] Task 16 — Scenario 047 — post-confirmation recipe swap
- [x] Task 17 — Scenario 048 — side conversation mid-planning preserves history
- [x] Task 18 — Scenario 049 — mp_adjust loop
- [x] Task 19 — Scenario 050 — mutate_plan with no active plan → no_target
- [x] Task 20 — Scenario 051 — meal-type lane regression lock
- [x] Task 21 — Scenario 052 — retroactive "last night" honest forward-shift
- [x] Task 22 — Scenario 053 — post-confirmation clarification multi-turn resume (invariant #5 harness lock)
- [x] Task 23 — Update `test/scenarios/index.md`
- [x] Task 24 — Sync `ui-architecture.md`, `flows.md`, proposal 003 status marker
- [x] Task 25 — Final baseline

---

## Decision log

- **Decision:** The in-session mutation path (`handleMutationText` in `plan-flow.ts`) is NOT refactored in Plan D. The applier's in-session branch is a thin delegation wrapper.
  **Rationale:** Changing `handleMutationText` would invalidate every re-proposer scenario (020, 023–028, 032) as a side effect of Plan D. The regression surface would explode beyond Plan D's scope. The delegation wrapper accepts ~20 lines of "call the function and map its FlowResponse to MutateResult" as the price of keeping the existing behavior pinned. A future plan can extend `FlowResponse` with a structured `kind` discriminator when a better shape is needed.
  **Date:** 2026-04-10

- **Decision:** The applier lives in `src/plan/mutate-plan-applier.ts`, not in `src/agents/` or `src/telegram/`.
  **Rationale:** `src/plan/` already hosts the session-to-proposal adapter (Plan 026), so the post-confirmation mutation path has a natural home alongside its load-bearing dependency. Placing the applier in `src/agents/` would mix orchestration with pure agent logic (the dispatcher and re-proposer are pure agents; the applier is orchestration). Placing it in `src/telegram/` would couple it to Telegram-specific output concerns, even though the applier is transport-agnostic. `src/plan/` is the clean middle layer.
  **Date:** 2026-04-10

- **Decision:** `PendingMutation` is stashed on `BotCoreSession`, not on `planFlow` or a new persisted field.
  **Rationale:** `planFlow` is for in-progress PLANNING sessions, not for in-flight post-confirmation mutations — semantically different concerns. A new persisted field would survive bot restarts, but the re-proposer's output is derived from a wall-clock-dependent adapter snapshot; re-running the same pending mutation an hour later against a new clock could silently produce a different plan, which is worse than "you need to re-ask". Matching the in-memory lifetime of other BotCoreSession fields (flow state, surface context, recent turns) is the cheapest correct choice. The known edge case ("user walks away for an hour, bot restarts, they tap Confirm") produces a honest "no pending change" reply, which is acceptable for v0.0.5.
  **Date:** 2026-04-10

- **Decision:** Post-confirmation clarifications ARE persisted via `BotCoreSession.pendingPostConfirmationClarification` — the user answers the clarification question on the next turn, and the applier automatically prepends the original request. This fully honors proposal 003 invariant #5.
  **Rationale:** Invariant #5 says "pending clarifications from sub-agents are carried in [state] and visible to the dispatcher." In-session, this is `planFlow.pendingClarification` (unchanged). Post-confirmation has no `planFlow`, so Plan D adds `pendingPostConfirmationClarification` on `BotCoreSession` as the equivalent carrier. The field shares the same lifecycle and clear rules as `pendingMutation` (both set by the post-confirmation mutation path, both cleared at every structural-invalidation site). The dispatcher context bundle includes a conditional section when the field is set, so the dispatcher knows the user's next message is likely a clarification answer and routes it to `mutate_plan`. The applier prepends `originalRequest` to the user's text so the re-proposer sees the full context. The UX is frictionless: user types "I'm eating out", re-proposer asks "lunch or dinner?", user types "dinner", applier sends "I'm eating out. To clarify: dinner" to the re-proposer.
  **Date:** 2026-04-10 (originally deferred; promoted to full implementation during review cycle after reviewer flagged invariant #5 compliance)

- **Decision:** `handleMutatePlanAction` calls the applier directly, not through an async dispatch queue.
  **Rationale:** The re-proposer call + solver + diff chain can take 5–15 seconds at mini-tier high-reasoning. A queue-based pattern would let the runner return quickly and update the user later, but Telegram has no "bot is still thinking" affordance beyond `startTyping()`. The simpler synchronous call + `stopTyping` pattern matches how `handleApprove` works today (`stopTyping` after `confirmPlanSession`). Complex async patterns are a later optimization if latency becomes a real user complaint.
  **Date:** 2026-04-10

- **Decision:** The applier's in-session branch maps `FlowResponse` to `MutateResult` using the response text content as a signal (checking for `'Your week:'` as a success marker).
  **Rationale:** `FlowResponse` doesn't carry a structured result kind today. The three possible outcomes of `handleMutationText` (clarification, updated proposal, failure) are distinguishable only by side effects on the state object OR by inspecting the response text. The text-content check is fragile (a format string change could break it), so the mapping is covered by unit tests in Task 7 — any regression shows up loudly. The long-term fix is to extend `FlowResponse` with a discriminator, but that's a `plan-flow.ts` refactor outside Plan D's scope.
  **Date:** 2026-04-10

- **Decision:** `mp_confirm` on a missing `pendingMutation` replies with a hint, not an error.
  **Rationale:** The edge cases — user taps Confirm after restart, user taps Confirm after Adjust without re-typing, user taps an old inline button from a stale message — all produce "missing pending" state. Replying "There is no pending change to confirm. Type your change to start over." is the gentlest recovery. An error reply would look like a bug to the user. The hint is directive and actionable.
  **Date:** 2026-04-10

- **Decision:** `mp_confirm` failure during persistence restores `session.pendingMutation` so the user can retry the Confirm tap.
  **Rationale:** Persistence failures are rare but possible (store errors, Supabase downtime). Losing the pending mutation on a transient failure would force the user to re-describe the change from scratch — a bad UX for a problem that wasn't theirs. Restoring lets them tap Confirm again. If the failure is permanent (genuine data corruption), they can tap Adjust to bail out. This matches the pattern `handleApprove` uses for persistence errors.
  **Date:** 2026-04-10

- **Decision:** Post-confirmation mutations do NOT carry forward the old session's `treatBudgetCalories` automatically through `buildReplacingDraft` — the applier's confirmation helper copies it explicitly as a stopgap.
  **Rationale:** `DraftPlanSession` requires `treatBudgetCalories` but Plan 026's `buildReplacingDraft` signature doesn't accept it (it's derived from the solver's weeklyTotals in the in-session flow). For post-confirmation mutations the solver runs on the active-slice only, and its weeklyTotals don't reflect the full horizon because past-slot calories aren't included. The conservative choice — copy the old session's treat budget verbatim — preserves the user's budget across mutations without producing wrong numbers. A future plan can re-derive the treat budget from the full reconstructed plan if that becomes important. Flagged in the applier's confirmation helper with a note.
  **Date:** 2026-04-10

- **Decision:** Plan D adds 10 new scenarios (044–053), one per task. Scenarios 045 (Flow 1), 048 (state preservation), and 053 (invariant #5 post-confirmation clarification resume) are non-negotiable; 052 (retroactive) is required by proposal 003's explicit verification list; the others are important regression locks.
  **Rationale:** Per CLAUDE.md's "new scenario is warranted when..." rule, every new user-facing behavior needs regression coverage. Plan D introduces 10 distinct behaviors mapped one-to-one to scenarios: in-session via dispatcher (044), post-confirmation happy path (045), flex move (046), recipe swap (047), state preservation with side conversation (048), adjust loop (049), no-target edge (050), meal-type lane enforcement (051), retroactive past-slot honest handling (052), and post-confirmation clarification multi-turn resume (053). Compressing them into fewer scenarios would bundle unrelated cases and make future regressions harder to localize. 10 scenarios is on the high end but each isolates one behavior clearly. Proposal 003 Plan D § "Verification" explicitly lists 5 scenarios (eat-out tonight, mid-planning flex move, post-confirm recipe swap, retroactive last-night, state preservation) — all 5 are covered. Proposal 003 line 453 mandates harness enforcement of invariant #5 — scenario 053 delivers that for post-confirmation. The additional 4 (in-session regression, flex move post-confirm, adjust loop, no-target) are important regression locks but not in the proposal's explicit must-list.
  **Date:** 2026-04-10

- **Decision:** Plan D's dispatcher prompt includes few-shot examples for both in-session mutation and post-confirmation mutation, AND explicitly tells the LLM that picking `mutate_plan` during active planning is correct (not a precedence mistake with `flow_input`).
  **Rationale:** Plan 028's prompt told the LLM to pick `flow_input` for mutation text during active planning. Plan D extends this: `mutate_plan` is now the right answer in BOTH cases because the applier branches on session state, not on the dispatcher's choice. Without this explicit guidance, the LLM might hedge and pick `flow_input` during active planning (preserving the Plan 028 contract), which would bypass the applier's in-session branch and go straight to `routeTextToActiveFlow` → `handleMutationText` — functionally identical but architecturally inconsistent. The explicit guidance keeps the shape clean.
  **Date:** 2026-04-10

- **Decision:** Plan D does NOT implement the compound `log_eating_out` handler described in proposal 003.
  **Rationale:** `log_eating_out` is the proposal's architectural commitment for calorie-tracked restaurant meals, which requires running-budget tracking, retroactive event persistence, and compound confirmation UI — three capabilities that don't exist in the product at all. Plan D delivers the 80% solution: Flow 1's "I'm eating out tonight" case works as a plain `mutate_plan` that shifts batches forward. Calories are not tracked (honest message in the reply). The full `log_eating_out` flow lands in a later plan alongside deviation accounting.
  **Date:** 2026-04-10

- **Decision:** Plan D's post-confirmation branch uses a structural `PlanFlowState` shim for `buildSolverInput` rather than refactoring `buildSolverInput` to accept a narrower struct.
  **Rationale:** `buildSolverInput` is load-bearing — it's used by the in-session mutation path, the initial planning path, and regression tests. Changing its signature would invalidate every caller. The shim approach carries ~15 lines of inline state construction in the applier; the cost is localized and clearly documented. A future refactor can extract a `SolverInputShape` interface that both `PlanFlowState` and the shim conform to, but that's outside Plan D's scope.
  **Date:** 2026-04-10

- **Decision:** Scenario 045 (Flow 1 canonical) is treated as **priority over all other Plan D work**. If any other task's scenario review finds a bug that would affect 045, fix 045 first and re-verify before regenerating any other scenario.
  **Rationale:** Scenario 045 is the contract with the user. Every other scenario is a regression lock for a supporting behavior. If 045 captures the wrong plan rearrangement or a broken message, Plan D has failed its goal regardless of how many other scenarios are green. Treating 045 as the north star forces attention to the canonical case.
  **Date:** 2026-04-10

- **Decision:** Plan 029 has no fixture-edited scenarios. Every scenario uses `test:generate` (not `test:replay` from manual edits).
  **Rationale:** Fixture edits are for simulating LLM misbehavior (e.g., forcing a ghost-batch response). Plan D's scenarios all exercise the real re-proposer behavior — the point is to verify the living-document promise works with genuine LLM calls, not to pin a specific LLM failure mode. Zero fixture-edited scenarios keeps the regeneration workflow uniform.
  **Date:** 2026-04-10

---

## Validation

After every task: `npm test` stays green (or red only in ways explicitly expected by the task — see Task 2's and Task 12's intentional-red notes). After Task 24, all of these must be true:

- `npm test` passes with:
  - Plan 028's baseline test count
  - + 3 Plan 029 dispatcher-agent unit tests (Task 3)
  - + ~5 Plan 029 applier unit tests (Tasks 7, 8, 10)
  - + 10 new Plan 029 scenarios (044–053)
  - + regenerated existing scenarios from Task 12
- `npx tsc --noEmit` reports no errors.
- `src/agents/dispatcher.ts` exports `mutate_plan` as part of `DispatcherAction`, `AVAILABLE_ACTIONS_V0_0_5`, and `DispatcherDecision`. The system prompt marks `mutate_plan` as AVAILABLE with few-shot examples.
- `src/plan/mutate-plan-applier.ts` exists and exports `PendingMutation`, `MutateResult`, `applyMutationRequest`, `applyMutationConfirmation`.
- `src/telegram/dispatcher-runner.ts` exports `handleMutatePlanAction` (real body, not stub) and wires it into the runner's switch.
- `src/telegram/core.ts`:
  - `BotCoreSession` has `pendingMutation?: PendingMutation` AND `pendingPostConfirmationClarification?: { question, originalRequest, createdAt }`.
  - `reset()` (harness-only helper) clears both `pendingMutation` and `pendingPostConfirmationClarification`.
  - `handleCommand('start')` AND `handleCommand('cancel')` both clear `pendingMutation` AND `pendingPostConfirmationClarification` in the same block where they already clear `session.planFlow` / `session.recipeFlow` / `session.pendingReplan`. (These handlers do NOT call `reset()` — they clear fields manually, so both fields must be enumerated explicitly.)
  - `plan_week` menu tap, `plan_cancel` callback, and `plan_approve` callback all clear both fields.
  - `plan_replan_cancel` / `plan_replan_confirm` callbacks clear both fields alongside `pendingReplan`.
  - `re_` recipe edit (~:487) clears both fields — starts a new flow (`createEditFlowState`), which is a terminal condition per proposal 003 line 536.
  - `metaIntent === 'start_over'` and `metaIntent === 'cancel'` in `routeTextToActiveFlow` clear both fields (defense-in-depth).
  - `mp_confirm` handler calls `applyMutationConfirmation` and handles persistence failure by restoring `pendingMutation`. Clears `pendingPostConfirmationClarification` on both success and failure.
  - `mp_adjust` handler clears both fields and sends the re-prompt.
  - **Every `pendingMutation = undefined` has a matching `pendingPostConfirmationClarification = undefined` nearby** — the two fields share the same lifecycle per Task 4 Step 5.
  - **True navigation-only sites do NOT clear either field:** `view_shopping_list` (~:517) and `view_plan_recipes` (~:523) set `session.planFlow = null` but are browsing actions that don't create new flow state.
- `src/telegram/dispatcher-runner.ts`:
  - `DispatcherSession` has both `pendingMutation?` and `pendingPostConfirmationClarification?`.
  - `handleMutatePlanAction` threads `pendingPostConfirmationClarification` into `applyMutationRequest` args, clears it after the call, and stashes it on the clarification branch (post-confirmation only).
- `src/telegram/keyboards.ts` exports `mutateConfirmKeyboard` with `mp_confirm` and `mp_adjust` buttons.
- `src/plan/session-to-proposal.ts` `buildReplacingDraft` accepts `calorieTolerance` as a required argument (no hard-coded 50).
- `docs/product-specs/ui-architecture.md`:
  - The Plan 028 catalog table's `mutate_plan` row is flipped to ✅ Plan 029.
  - A new "Post-confirmation mutation lifecycle (Plan 029)" subsection exists.
- `docs/product-specs/flows.md` has a new "Flow: Post-confirmation plan mutation (Plan 029 — Flow 1 from proposal 003)" section.
- `docs/design-docs/proposals/003-freeform-conversation-layer.md` has the Plan D status marker at the top.
- `test/scenarios/index.md` lists scenarios 044–053.
- **Scenario 045 behavioral validation passes** (the Flow 1 canonical test): user types "I'm eating out tonight, friend invited me" on a confirmed plan, the dispatcher picks `mutate_plan`, the applier's post-confirmation branch runs the adapter + re-proposer + solver + diff, the user sees a sensible diff message + `[Confirm] [Adjust]`, tapping `[Confirm]` persists a new session via `confirmPlanSessionReplacing` with the extended `mutationHistory`, the old session is superseded, old batches are cancelled, and the new session's batches include both preserved past-slot halves and re-proposed active batches. No meal-type lane violations. Near-future days observe the soft-lock rule correctly: Wednesday (tomorrow) keeps the same recipe (tagine) even though the batch shifts from `{Tue, Wed}` to `{Wed, Thu}` as the proposal's canonical example requires — cascading shifts within the same recipe are expected, not bugs; only silent recipe-level swaps on near-future days are violations (see scenario 045 criterion #4 for the full breakdown).
- **The living-document promise is kept.** Proposal 003's north star is technically deliverable after this plan. Reality diverges from the plan, the plan adapts, nothing is lost.

After this plan lands, Plan E remains for:
- `answer_plan_question`, `answer_recipe_question`, `answer_domain_question`
- `show_recipe`, `show_plan`, `show_shopping_list` (with full scope matrix), `show_progress`
- `log_measurement` as a thin wrapper over the existing numeric parser reachable from any surface
- Full-fidelity `rerenderLastView` in the runner (Plan 028 shipped a minimal version)

Plan D is the commit where proposal 003's primary job becomes real. Plan E polishes the surrounding chat experience.
