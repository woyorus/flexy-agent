# Recipe fixture libraries

Curated recipe sets used by scenario tests. Each scenario's `spec.ts` references one of these sets by directory name via the `recipeSet` field; the runner constructs a `RecipeDatabase` rooted at `test/fixtures/recipes/<set>/`.

Scenarios never read from the production `recipes/` directory — they are bound entirely to the set they reference. This decouples the test suite from wherever production recipes live (today: markdown files; tomorrow: possibly Supabase). Fixture sets are plain markdown recipe files identical in format to production recipes.

## Available sets

| Set | Purpose |
|---|---|
| `six-balanced/` | Realistic baseline. Snapshot of the production `recipes/` directory at plan-006 commit time: 1 breakfast + 6 lunch/dinner recipes across varied cuisines. Use for happy-path scenarios and regression tests that need a realistic recipe library. |
| `minimal/` | Edge-case set with intentionally insufficient coverage: 1 breakfast + 2 lunch/dinner recipes. Used to exercise the "not enough recipes, must generate" path in the plan proposer and gap-resolution sub-flow. |

## Adding a new set

1. Create a new directory under `test/fixtures/recipes/<name>/`.
2. Copy or hand-author recipe markdown files using the same format as production recipes (see `src/recipes/parser.ts` for the expected frontmatter).
3. Reference the set from a scenario's `spec.ts` via `recipeSet: '<name>'`.
4. Document the new set in the table above — include a one-line purpose that explains which code path it stresses.

Git deduplicates identical recipe files across sets automatically, so copying a recipe into a new set is cheap.

## Why not symlink back to production?

Symlinks tie the test suite to the current state of `recipes/`. Any recipe edit would invalidate every scenario that depends on stable recipe text (prompt hashes, scaled ingredient amounts). Fixture sets are frozen copies by design — recipe edits in production don't cascade to tests.
