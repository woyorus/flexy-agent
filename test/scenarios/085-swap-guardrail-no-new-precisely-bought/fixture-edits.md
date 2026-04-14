# Fixture edits for scenario 085

**Invariant under test:** the applier must reject an LLM response that
adds a NEW precisely-bought ingredient (not a pantry staple, not named
by the user).

## Edit procedure

1. Run `npm run test:generate -- 085-swap-guardrail-no-new-precisely-bought`.

2. Open `recorded.json`, find the `ingredient-swap` LLM fixture, and in
   its `response` JSON:
   - Add a new entry to `scaled_ingredients`:
     `{ "name": "pine nuts", "amount": 30, "unit": "g", "total_for_batch": 90, "role": "fat" }`.
   - Add a matching `changes` entry:
     `{ "kind": "add", "ingredient": "pine nuts", "amount": 30, "unit": "g", "reason": "helper" }`.
     (Technically the agent would emit "helper" to try to sneak past; the
     guardrail's pantry-staple list does NOT include pine nuts, so the
     validator still catches it.)

3. Run `npm run test:replay -- 085-swap-guardrail-no-new-precisely-bought`.
   Expected: hard_no reply; batch scaledIngredients unchanged.

## DO NOT regenerate

`--regenerate` re-calls the LLM and drops the edit. Use `test:replay`.
