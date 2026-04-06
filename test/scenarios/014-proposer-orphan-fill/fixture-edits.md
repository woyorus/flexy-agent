# Fixture Edits — 014-proposer-orphan-fill

This scenario requires manual edits to `recorded.json` after every regeneration.
The edits simulate an LLM underfill that the deterministic orphan fill must fix.

## What to edit

In `recorded.json`, find the **first LLM fixture** (callIndex 1 — the proposer response).
Its `response` field contains a JSON string with `batches`, `flex_slots`, etc.

### Edit 1: Remove Wed from chicken lunch batch

In the proposer response JSON, find the chicken-black-bean batch (meal_type: lunch).
Change its days from `["2026-04-06", "2026-04-07", "2026-04-08"]` to `["2026-04-06", "2026-04-07"]`
and its servings from `3` to `2`.

This orphans **Wed 2026-04-08 lunch**. The fill extends chicken forward (2 → 3 servings).

### Edit 2: Remove Tue from salmon-shrimp dinner batch

Find the creamy-salmon-and-shrimp-linguine batch (meal_type: dinner).
Change its days from `["2026-04-06", "2026-04-07"]` to `["2026-04-06"]`
and its servings from `2` to `1`.

This orphans **Tue 2026-04-07 dinner**. The fill extends salmon forward (1 → 2 servings).

## After editing

Run `npm run test:generate -- 014-proposer-orphan-fill --regenerate` to re-record
the expected outputs with the edited fixture, then verify with `npm test`.

## Why

The real LLM produces a correct plan — it doesn't underfill. The only way to exercise
the orphan fill code path is to manually break the fixture. See Plan 011 Phase 4.
