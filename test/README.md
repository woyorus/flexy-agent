# Flexie test suite

> Scope: Quick-start checklist for running and authoring Flexie tests. See also: [docs/product-specs/testing.md](../docs/product-specs/testing.md) for full documentation, [docs/design-docs/test-harness-architecture.md](../docs/design-docs/test-harness-architecture.md) for design rationale.

## Run the suite

```bash
npm test
```

Runs every unit test in `test/unit/*.test.ts` and every scenario in `test/scenarios/*/`. No network required — scenarios replay from recorded LLM fixtures. Sub-second per scenario. Exits 0 on pass, 1 on fail.

Filter by name:

```bash
npm test -- --test-name-pattern="flex-move"
```

## Author a new scenario

1. `mkdir test/scenarios/004-my-scenario`
2. Create `test/scenarios/004-my-scenario/spec.ts`:
   ```typescript
   import { defineScenario, command, text, click } from '../../../src/harness/define.js';

   export default defineScenario({
     name: '004-my-scenario',
     description: 'Short summary',
     clock: '2026-04-05T10:00:00Z',
     recipeSet: 'six-balanced',
     initialState: { plans: [], session: null },
     events: [
       command('start'),
       text('📋 Plan Week'),
       click('plan_keep_breakfast'),
       // ...
     ],
   });
   ```
3. Generate fixtures (calls the real LLM — costs money):
   ```bash
   npm run test:generate -- 004-my-scenario
   ```
4. Inspect `recorded.json` via `git diff`. Confirm the captured transcript looks right.
5. `npm test` — the new scenario should pass.
6. Commit both `spec.ts` and `recorded.json`.

## Update a scenario after changing code

If the spec is unchanged but the bot's behavior is, scenarios fail with an assertion diff. Decide:
- **Intentional behavior change?** → `npm run test:generate -- <name> --regenerate`, review diff, commit.
- **Unintentional?** → fix the code.

If the spec itself changed, the `specHash` mismatch produces a clear "Stale recording" error pointing at the regenerate command.

## Fixture-edited scenarios

Some scenarios intentionally edit `recorded.json` after generation to simulate malformed LLM output. If a scenario directory contains `fixture-edits.md`:

1. Generate or regenerate the fresh valid fixture: `npm run test:generate -- <name> --regenerate`.
2. Apply only the documented `llmFixtures` edits from `fixture-edits.md`.
3. Run `npm run test:replay -- <name>` to recompute `expected` from the edited fixtures without calling the real LLM.
4. Review `recorded.json` via `git diff`, then run `npm test`.

Never run `--regenerate` after applying fixture edits; it rewrites `llmFixtures` and destroys the manual malformed response. Fixture-edited scenarios should also include `fixture-assertions.ts` so `test:replay` and `npm test` fail if the required malformed fixture is missing.

## Directory layout

```
test/
├── scenarios/         ← authored scenarios (spec.ts) + recordings (recorded.json)
├── fixtures/recipes/  ← curated recipe libraries scenarios reference by name
├── unit/              ← node:test unit tests for harness internals
├── setup.ts           ← dummy-env preload (loaded via --import)
└── scenarios.test.ts  ← node:test entry: discovers + runs unit and scenario tests
```

See [docs/product-specs/testing.md](../docs/product-specs/testing.md) for the full reference: keyboard types, UUID normalization, fixture queuing, missing-fixture diagnostics, and design decisions.
