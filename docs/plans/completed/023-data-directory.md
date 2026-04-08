# Plan 023: Move runtime assets into `data/` directory

**Status:** Completed
**Date:** 2026-04-08
**Affects:** `src/config.ts`, `src/debug/logger.ts`, `src/debug/costs.ts`, `.gitignore`, `docs/`, `CLAUDE.md`, plan 022

## Problem

Runtime output files (`recipes/`, `logs/`, and the upcoming `feedback.md` + `feedback-assets/`) live at the repo root alongside source code. They're not repo assets — they're data produced at runtime. This clutters the root and conflates concerns.

Move everything under a single `data/` directory:

```
data/
  recipes/          ← recipe markdown library
  logs/             ← debug.log, costs.jsonl
  feedback.md       ← (plan 022, not yet implemented)
  feedback-assets/  ← (plan 022, not yet implemented)
```

## Plan of work

### 1. Move `recipes/` → `data/recipes/`

```bash
mkdir -p data && git mv recipes data/recipes
```

Update `src/config.ts:126`:
```typescript
recipesDir: "data/recipes",
```

That's the only source code change — `RecipeDatabase` takes the path from config, and `src/index.ts:33` passes `config.recipesDir`. Harness tests use `test/fixtures/recipes/` (unchanged).

### 2. Move `logs/` → `data/logs/`

`src/debug/logger.ts:35-36`:
```typescript
const LOGS_DIR = join(process.cwd(), 'data', 'logs');
```

`src/debug/costs.ts:23-24`:
```typescript
const LOGS_DIR = join(process.cwd(), 'data', 'logs');
```

Move existing logs:
```bash
mv logs data/logs
```

### 3. Update `.gitignore`

Replace `logs/` with `data/logs/`. Add `data/feedback.md` and `data/feedback-assets/` for plan 022.

### 4. Update plan 022 paths

In `docs/plans/active/022-feedback-command.md`, update all references:
- `feedback.md` → `data/feedback.md`
- `feedback-assets/` → `data/feedback-assets/`
- The `saveFeedback()` file path resolution
- The `bot.ts` photo handler `localPath` and `fs.mkdir` path
- The storage decision log entry

### 5. Update documentation references

Files with `logs/debug.log` or `logs/costs.jsonl` or `recipes/` path references:
- `CLAUDE.md` — debug workflow section (`tail logs/debug.log`)
- `docs/ARCHITECTURE.md:55-56,79-81` — directory tree
- `src/debug/logger.ts:5,16` — doc comments
- `src/debug/costs.ts:4` — doc comment
- `src/recipes/database.ts:4` — doc comment
- `src/recipes/parser.ts:4` — doc comment
- `src/telegram/core.ts:40` — doc comment
- `src/telegram/bot.ts:14` — doc comment
- `src/harness/capturing-sink.ts:11` — doc comment
- `src/ai/openai.ts:14` — doc comment

### 6. `npm test` — confirm no regressions

Harness tests use `test/fixtures/recipes/` (not the runtime `recipes/` dir), so they should be unaffected. The only runtime code change is the `LOGS_DIR` constant and `recipesDir` config value.

## Progress

- [x] `git mv recipes data/recipes` + update config.ts
- [x] Update logger.ts and costs.ts LOGS_DIR
- [x] Move `logs/` → `data/logs/`
- [x] Update .gitignore
- [x] Update plan 022 paths
- [x] Update doc comments across source files
- [x] Update CLAUDE.md and ARCHITECTURE.md
- [x] `npm test`

## Decision log

- Decision: Name the directory `data/`.
  Rationale: Simple, universally understood. Alternatives considered: `var/` (too Unix-specific), `store/` (vague), `local/` (implies local-only which is redundant).
  Date: 2026-04-08

- Decision: Move `logs/` into `data/` alongside recipes and feedback.
  Rationale: Also a runtime asset, same category. Keeps root clean with a single runtime output directory.
  Date: 2026-04-08

- Decision: Do NOT move `test/fixtures/recipes/` — those are test assets, not runtime data.
  Rationale: Test fixtures are part of the source tree. Only runtime-generated data moves.
  Date: 2026-04-08

## Validation

1. `npm test` — no regressions (harness uses fixture recipes, not `data/recipes/`).
2. `npm run dev` — bot starts, recipe database loads from `data/recipes/`.
3. `data/logs/debug.log` is written on bot startup.
4. Verify `recipes/` and `logs/` no longer exist at repo root.
