# Fixture edits for scenario 084

**Invariant under test:** a helper ingredient that appears in
`scaled_ingredients` must also appear in the rendered delta block, even
if the agent's `delta_lines` omits it. The applier regenerates delta
lines from `changes` when the agent's version is incomplete.

## Edit procedure

1. Run `npm run test:generate -- 084-swap-guardrail-helper-named-in-delta`
   to capture the initial (presumably-compliant) LLM response.

2. Open `recorded.json`, locate the `ingredient-swap` LLM fixture, and
   in its `response` JSON string:
   - Keep the lemon-juice entry in `scaled_ingredients` (helper added).
   - Keep the `changes` array entry `{ "kind": "add", "ingredient": "lemon juice", ..., "reason": "helper" }`.
   - REMOVE any line from `delta_lines` that mentions "lemon juice" (or "+ lemon"). Leave other delta lines untouched.

3. Run `npm run test:replay -- 084-swap-guardrail-helper-named-in-delta`.
   The replay should produce a cook-view reply where the delta block
   still mentions lemon juice — the applier derived it from `changes`.

## DO NOT regenerate

Same as 083: `--regenerate` would destroy the edit. Use `test:replay`.
