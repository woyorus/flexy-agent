# Test Scenarios

| # | Name | What it tests |
|---|------|---------------|
| 001 | plan-week-happy-path | Fresh user completes a full planning flow end-to-end: /start → keep breakfast → no events → approve on first try. |
| 002 | plan-week-flex-move-regression | Flex move via re-proposer ("move flex to Wednesday") — plan rearranges in one LLM call. Plan 025 rework. |
| 003 | plan-week-minimal-recipes | A 2-recipe library: the proposer reuses recipes to cover all slots (Plan 024 — no gap-resolution needed). |
| 004 | rolling-first-plan | First-ever plan from completely empty state: cold-start path where horizonStart falls back to "tomorrow". |
| 005 | rolling-continuous | Rolling horizon continuation: session B plans the next 7 days with session A's carry-over slots pre-committed in the proposer. |
| 006 | rolling-gap-vacation | Vacation fallback: session A is historical (ended before today), so computeNextHorizonStart falls back to "tomorrow" with no carry-over. |
| 009 | rolling-swap-recipe-with-carryover | Recipe swap via re-proposer on a non-pre-committed batch — carry-over stays intact. Plan 025 rework. |
| 010 | rolling-events-with-carryover | Proposer must simultaneously respect pre-committed carry-over slots, a restaurant event, and the standard flex slot with no double-booking. |
| 011 | rolling-replan-future-only | Replanning a future-only session: old session is superseded and its batches cancelled only after the new session is fully saved. |
| 012 | rolling-replan-abandon | Replanning a future session then cancelling: the original session must remain fully intact after abandonment (save-before-destroy guarantee). |
| 013 | flex-move-rebatch-carryover | Flex move to Sunday via re-proposer — batches rearrange cleanly, no orphan gaps. Plan 025 rework. |
| 014 | proposer-orphan-fill | Validator retry: LLM underfills the week (fixture edited), validateProposal catches it, retry with correction succeeds (Plan 024). |
| 015 | progress-logging | Progress: first log with disambiguation, first-measurement hint, already-logged same day, defensive pg_last_report with no completed week. |
| 016 | progress-weekly-report | Progress: tap [Last weekly report] with a full completed week seeded — verifies tone, averages, and delta computation. |
| 017 | free-text-fallback | Lifecycle-aware free-text fallback: no-plan branch shows helpful guidance, shopping list with no plan shows jargon-free message. |
| 018 | plan-view-navigation | Active-plan navigation: My Plan → Next Action → Week Overview → Day Detail → Cook view → back to plan. Exercises plan view screens and cook view handler. |
| 019 | shopping-list-tiered | Three-tier shopping list: sl_next + sl_{date} with role-enriched ingredients. Verifies tier-1 exclusion, tier-2 checkYouHave, tier-3 category grouping, and breakfast annotation. |
| 020 | planning-intents-from-text | Mutation from proposal phase (no button tap) via re-proposer, "start over" resets flow, second attempt approves. Plan 025 rework. |
| 021 | planning-cancel-intent | "Nevermind" during proposal exits planning cleanly — planFlow null, surfaceContext null, main menu shown. |
| 022 | upcoming-plan-view | Upcoming plan visibility: My Plan, Week Overview, Shopping List work before plan starts. Contextual "No meals" for pre-plan days. Replan prompt when tapping Plan Week. |
| 023 | reproposer-event-add | User adds event mid-review ("dinner with friends Friday") — re-proposer adds event and rearranges batches around it. Plan 025. |
| 024 | reproposer-recipe-swap | User swaps a recipe ("salmon instead of beef") — re-proposer picks replacement from DB. Plan 025. |
| 025 | reproposer-event-remove | User removes event mid-review ("Friday dinner got cancelled") — re-proposer fills freed slot. Plan 025. |
| 026 | reproposer-multi-mutation | Two sequential mutations (flex move then recipe swap) — history preserves first change. Plan 025. |
| 027 | reproposer-clarification | Vague request ("this doesn't work for me") triggers clarification, user answers with specific change, plan updates. Plan 025. |
| 028 | reproposer-recipe-generation | User asks for recipe not in DB ("Thai green curry") — re-proposer asks to generate, user confirms, recipe created and placed. Plan 025. |
| 029 | recipe-flow-happy-path | Standalone recipe flow from main menu → recipe list → [Add new recipe] → meal type → preferences → Save. Distinct from 028's re-proposer handshake. |
| 030 | navigation-state-tracking | Navigation state model: walks through every render surface (plan subviews, cook view, shopping scopes, recipe library/detail, progress) and asserts every intermediate `lastRenderedView` variant via per-step session snapshots (Task 4b harness extension). Covers 9 of 10 variants. Plan 027. |
| 031 | shopping-list-mid-planning-audit | Regression lock: user starts next-week planning, taps 🛒 Shopping List — planFlow is cleared (current behavior, Plan 027 leaves alone), shopping list of the ACTIVE plan renders. Locks in the audit decision for future freeform-model work. Plan 027. |
| 032 | discard-recipe-audit | Regression lock: user enters a recipe flow, taps Discard — recipeFlow cleared (Plan 027 audit decision "leave alone"). Plan 027. |
| 033 | recipe-edit-clears-planflow-audit | Regression lock: user has planFlow alive at phase=context, taps re_<slug> from a recipe view — planFlow cleared (Plan 027 audit decision "leave alone"; defensive clear because the non-dispatcher model can't cleanly return to planning after recipe edit). Plan 027. |
| 035 | navigation-progress-log-prompt | Single-step sibling to 030: covers the one `LastRenderedView` variant (progress/log_prompt) that 030 cannot reach because it requires mutually exclusive seed state (no today measurement). Plan 027. |
| 036 | day-detail-back-button-audit | Regression lock (proposal 003 §755 named audit outcome): user drills `my_plan → wo_show → dd_<date>`, taps "← Back to week" (which sends `wo_show`), and lands on week_overview. Per-step `sessionAt[]` assertions lock in the v0.0.5 hardcoded back-button outcome. Plan 027. |
| 037 | dispatcher-flow-input-planning | Dispatcher routes mutation text during planning proposal phase to flow_input → re-proposer. Validates state preservation and recentTurns bookkeeping. Plan 028. |
| 038 | dispatcher-out-of-scope | Dispatcher declines an out-of-domain request with out_of_scope and offers the menu. No downstream LLM calls. Plan 028. |
| 039 | dispatcher-return-to-flow | Side question during planning proposal phase routes to out_of_scope; "ok back to the plan" routes to return_to_flow and re-renders the proposal. planFlow survives the side trip. Plan 028. |
| 040 | dispatcher-clarify-multiturn | Dispatcher clarify with a follow-up turn; recentTurns carries the clarification into the second dispatch. Plan 028. |
| 041 | dispatcher-cancel-precedence | Cancel phrase short-circuits the dispatcher during active planning. No dispatcher fixture for the cancel turn. Plan 028. |
| 042 | dispatcher-numeric-prefilter | Numeric pre-filter short-circuits dispatcher for awaiting_measurement; subsequent text dispatches normally. Plan 028. |
| 043 | dispatcher-plan-resume-callback | plan_resume inline back-button re-renders the planning proposal via handleReturnToFlowAction delegation. Regression lock for proposal 003 invariant #7 (button-tap / natural-language equivalence). Plan 028. |
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
| 054 | answer-plan-question | Plan E: dispatcher picks answer_plan_question for "when's my next cook day?" |
| 055 | answer-recipe-question | Plan E: dispatcher picks answer_recipe_question for "can I freeze this?" |
| 056 | answer-domain-question | Plan E: dispatcher picks answer_domain_question for "substitute for tahini?" |
| 057 | show-recipe-in-plan | Plan E: show_recipe renders cook view when slug is in active batch |
| 058 | show-recipe-library-only | Plan E: show_recipe falls back to library view when slug is not in plan |
| 059 | show-recipe-multi-batch | Plan E: show_recipe multi-batch picks soonest cook day (regression lock) |
| 060 | show-plan-day-detail-natural-language | Plan E: show_plan resolves "Thursday" to next Thursday's ISO date |
| 061 | show-shopping-list-recipe-scope | Plan E: show_shopping_list scope=recipe filters to one recipe |
| 062 | show-shopping-list-full-week | Plan E: show_shopping_list scope=full_week aggregates across cook days |
| 063 | show-progress-weekly-report | Plan E: show_progress weekly_report renders the weekly summary |
| 064 | log-measurement-cross-surface | Plan E: log_measurement persists from any surface, surfaceContext preserved |
| 065 | answer-then-mutate-state-preservation | Plan E: cross-action state preservation (clarify + mutate preserves planFlow) |
