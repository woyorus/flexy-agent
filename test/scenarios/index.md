# Test Scenarios

| # | Name | What it tests |
|---|------|---------------|
| 001 | plan-week-happy-path | Fresh user completes a full planning flow end-to-end: /start → keep breakfast → no events → approve on first try. |
| 002 | plan-week-flex-move-regression | flex_move swap dissolves a multi-day batch and orphaned days must surface as gaps rather than silently clamping calories. |
| 003 | plan-week-minimal-recipes | A 2-recipe library: the proposer reuses recipes to cover all slots (Plan 024 — no gap-resolution needed). |
| 004 | rolling-first-plan | First-ever plan from completely empty state: cold-start path where horizonStart falls back to "tomorrow". |
| 005 | rolling-continuous | Rolling horizon continuation: session B plans the next 7 days with session A's carry-over slots pre-committed in the proposer. |
| 006 | rolling-gap-vacation | Vacation fallback: session A is historical (ended before today), so computeNextHorizonStart falls back to "tomorrow" with no carry-over. |
| 008 | rolling-flex-move-at-edge | flex_move to Saturday dinner in the rolling model: carved orphan at the horizon edge must be absorbed or surfaced, not silently dissolved. |
| 009 | rolling-swap-recipe-with-carryover | Recipe swap on a non-pre-committed batch while session A carry-over slots are present: swap succeeds without touching carry-over. |
| 010 | rolling-events-with-carryover | Proposer must simultaneously respect pre-committed carry-over slots, a restaurant event, and the standard flex slot with no double-booking. |
| 011 | rolling-replan-future-only | Replanning a future-only session: old session is superseded and its batches cancelled only after the new session is fully saved. |
| 012 | rolling-replan-abandon | Replanning a future session then cancelling: the original session must remain fully intact after abandonment (save-before-destroy guarantee). |
| 013 | flex-move-rebatch-carryover | flex_move re-batching: contiguous orphans after batch dissolution merge into a multi-serving batch instead of individual 1-serving gaps. |
| 014 | proposer-orphan-fill | Validator retry: LLM underfills the week (fixture edited), validateProposal catches it, retry with correction succeeds (Plan 024). |
| 015 | progress-logging | Progress: first log with disambiguation, first-measurement hint, already-logged same day, defensive pg_last_report with no completed week. |
| 016 | progress-weekly-report | Progress: tap [Last weekly report] with a full completed week seeded — verifies tone, averages, and delta computation. |
| 017 | free-text-fallback | Lifecycle-aware free-text fallback: no-plan branch shows helpful guidance, shopping list with no plan shows jargon-free message. |
| 018 | plan-view-navigation | Active-plan navigation: My Plan → Next Action → Week Overview → Day Detail → Cook view → back to plan. Exercises plan view screens and cook view handler. |
| 019 | shopping-list-tiered | Three-tier shopping list: sl_next + sl_{date} with role-enriched ingredients. Verifies tier-1 exclusion, tier-2 checkYouHave, tier-3 category grouping, and breakfast annotation. |
| 020 | planning-intents-from-text | Swap from proposal phase (no button tap), "start over" mid-flow resets planning, second attempt approves. Plan 019 intents. |
| 021 | planning-cancel-intent | "Nevermind" during proposal exits planning cleanly — planFlow null, surfaceContext null, main menu shown. |
| 022 | upcoming-plan-view | Upcoming plan visibility: My Plan, Week Overview, Shopping List work before plan starts. Contextual "No meals" for pre-plan days. Replan prompt when tapping Plan Week. |
