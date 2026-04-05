/**
 * Test-run environment preload.
 *
 * Loaded by `node --import ./test/setup.ts` (via the `--import` flag in
 * the `test` and `test:generate` scripts) BEFORE any source module is
 * loaded. Its single job is to satisfy `src/config.ts`'s `requireEnv()`
 * checks so the harness's import chain — which transitively touches
 * `config.ts` via `plan-flow.ts`, `recipe-flow.ts`, `core.ts`, etc. —
 * can complete without a real `.env` file.
 *
 * ## Two-stage: dotenv first, then dummies
 *
 * 1. Load `.env` via `dotenv/config` so any real values the user has
 *    configured (most importantly `OPENAI_API_KEY` for generate mode)
 *    land in `process.env`.
 * 2. Fill in dummy values via `??=` for anything still unset — only the
 *    keys `src/config.ts` demands, nothing more.
 *
 * Without the dotenv step, `src/index.ts`'s `import 'dotenv/config'` is
 * the only place `.env` is loaded, and harness entry points
 * (`test/scenarios.test.ts`, `src/harness/generate.ts`) never import it,
 * so real credentials would be invisible and generate mode would hit
 * OpenAI with the dummy key.
 *
 * ## Why `??=` and not assignment
 *
 * Real environment values (from `.env` or the shell) take precedence —
 * the preload only fills in dummies when a variable is genuinely unset.
 * This matters for generate mode: the agent runs `npm run test:generate`
 * with a real `OPENAI_API_KEY` in `.env` because that path actually calls
 * OpenAI. Replay mode can run with no `.env` present at all because
 * every value here is ignored by the harness dependencies
 * (TestStateStore replaces StateStore, FixtureLLMProvider replaces
 * OpenAIProvider, BotCore is driven directly without grammY or
 * Supabase).
 *
 * ## Why dummy Supabase values don't cause network calls
 *
 * `@supabase/supabase-js` accepts any URL and any key at `createClient()`
 * time — the SDK only validates them when a query runs. TestStateStore
 * intercepts every call site that would touch the real client, so no
 * query ever runs in harness mode, so the dummy URL never matters.
 *
 * Same for `OPENAI_API_KEY`: the OpenAI SDK is only constructed inside
 * `OpenAIProvider`, which is never instantiated by the runner (it builds
 * `FixtureLLMProvider` instead).
 *
 * Same for `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`: the grammY `Bot`
 * constructor is only called by `createBot` in `src/telegram/bot.ts`,
 * which the runner doesn't import.
 */

import 'dotenv/config';

process.env.TELEGRAM_BOT_TOKEN ??= 'harness-dummy-no-network';
process.env.TELEGRAM_CHAT_ID ??= '0';
process.env.OPENAI_API_KEY ??= 'harness-dummy-no-network';
process.env.SUPABASE_URL ??= 'https://harness-dummy.invalid';
process.env.SUPABASE_ANON_KEY ??= 'harness-dummy-no-network';
