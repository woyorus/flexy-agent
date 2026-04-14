# Fixture edits for scenario 083

**Invariant under test:** the applier must reject an LLM response that
silently mutates a precisely-bought ingredient the user did not name
(proposal 006 § "Untouched stays untouched").

## Edit procedure

1. Run `npm run test:generate -- 083-swap-guardrail-precisely-bought-unchanged`
   to capture the initial (non-violating) LLM response as the baseline
   `recorded.json`.

2. Open `recorded.json` and locate the `llmFixtures` entry whose
   `request.context === "ingredient-swap"`. Its `response` field is a
   JSON string matching the agent's output schema.

3. In that JSON string, find the `scaled_ingredients` array. Locate the
   entry for `ground beef` (amount 200g in the seed). Change its
   `amount` from `200` to `180` and its `total_for_batch` proportionally
   (`540` → `486`).

4. Do NOT touch any other field — the delta_lines, changes array, and
   macros should stay unchanged (that's part of the invariant: the agent
   didn't announce the ground-beef change).

5. Run `npm run test:replay -- 083-swap-guardrail-precisely-bought-unchanged`
   to re-record the expected outputs from the edited fixture. The
   replay must produce a hard_no reply (guardrail rejection) and the
   final batch's ground beef must still be 200g.

## DO NOT regenerate

`npm run test:generate -- ... --regenerate` would call the real LLM and
discard the fixture edit, invalidating the test. Use `test:replay` only.
