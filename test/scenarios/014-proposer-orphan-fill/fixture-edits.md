# Fixture Edits — 014-proposer-validator-retry

Plan 024: reworked from orphan-fill to validator-retry.
This scenario tests the validateProposal() retry loop in the proposer.

## What to edit

In `recorded.json`, find the **first LLM fixture** (callIndex 1 — the proposer response).
Its `response` field contains a JSON string with `batches`, `flex_slots`, etc.

### Edit 1: Remove Wed from chicken lunch batch

In the proposer response JSON, find the chicken-black-bean batch (meal_type: lunch).
Change its eating_days from `["2026-04-06", "2026-04-07", "2026-04-08"]` to `["2026-04-06", "2026-04-07"]`
and its servings from `3` to `2`.

This makes **Wed 2026-04-08 lunch** uncovered. The validator catches invariant #1
(slot coverage) and triggers a retry.

### Edit 2: Add retry fixture

After fixture 1, insert a NEW fixture (callIndex 2) representing the validator retry:
- Messages: [system prompt, user prompt, assistant(edited response), user(correction with validation errors)]
- Response: the ORIGINAL (unedited) proposer response (valid complete plan)
- Compute the hash from the messages using the standard hashRequest function

The retry fixture response should have the chicken batch restored to 3 servings
covering Mon-Wed, so the validator passes on the second attempt.

### Edit 3: Bump callIndex for subsequent fixtures

All fixtures after the inserted retry fixture must have their callIndex incremented by 1.

## Automation

Run `node /tmp/edit-014-fixture.mjs <path-to-recorded.json>` to apply all edits automatically.
The script handles computing the retry hash and inserting the fixture.

## After editing

Run `npm run test:replay -- 014-proposer-orphan-fill` to re-record expected
outputs from the edited fixtures without calling the real LLM.

Then review `recorded.json` via `git diff`, and verify with `npm test`.
Do not run `--regenerate` after editing — it rewrites `llmFixtures` and destroys
the manual edits.
