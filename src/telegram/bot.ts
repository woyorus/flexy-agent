/**
 * grammY adapter for the Flexie Telegram bot.
 *
 * This file is the ONLY place that talks to grammY. All conversation logic
 * lives in `src/telegram/core.ts` (`BotCore`). This adapter does three things:
 *
 *   1. Register grammY middlewares (inbound logging, auth).
 *   2. Register grammY handlers (`bot.command`, `bot.on('callback_query:data')`,
 *      `bot.on('message:voice')`, `bot.on('message:text')`) that translate
 *      the grammY `Context` into a `HarnessUpdate` and call
 *      `core.dispatch(update, sink)`.
 *   3. Provide a `grammyOutputSink` that forwards `sink.reply` to
 *      `ctx.reply`, appends the DEBUG-mode timing footer, and logs the
 *      outbound message to `data/logs/debug.log`.
 *
 * Everything the core used to do directly — handling button taps, building
 * menu responses, routing free-form text to flows — now happens inside
 * `BotCore.dispatch`. This split exists so the test harness can drive the
 * same core without going through grammY (see `src/harness/runner.ts`).
 *
 * The debug footer is appended inside this adapter (not in the core) so that
 * captured scenario transcripts are byte-stable regardless of whether DEBUG
 * mode is on. See the "BotCore.dispatch produces clean text" decision in
 * plan 006 for the full rationale.
 *
 * Voice transcription also lives here. The adapter downloads the audio from
 * Telegram, calls `llm.transcribe()`, then dispatches a pre-transcribed
 * `{ type: 'voice', transcribedText }` update so the harness never has to
 * deal with audio bytes or Whisper determinism.
 */

import { Bot, Context, InlineKeyboard, Keyboard } from 'grammy';
import { config } from '../config.js';
import { log } from '../debug/logger.js';
import type { LLMProvider } from '../ai/provider.js';
import type { RecipeDatabase } from '../recipes/database.js';
import type { StateStore } from '../state/store.js';
import { createBotCore, type BotCore, type HarnessUpdate, type OutputSink } from './core.js';

interface BotDeps {
  llm: LLMProvider;
  recipes: RecipeDatabase;
  store: StateStore;
}

/**
 * Keep the typing indicator alive during long operations.
 * Telegram's typing action expires after ~5 seconds, so we re-send every 4 seconds.
 * Returns a stop function to call when the operation completes.
 */
function startTypingIndicator(ctx: Context): () => void {
  ctx.replyWithChatAction('typing').catch(() => {});
  const interval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);
  return () => clearInterval(interval);
}

/**
 * Extract button labels from a grammY keyboard for debug logging.
 * Handles both InlineKeyboard (.inline_keyboard) and Keyboard (.keyboard).
 * Returns rows of button label strings, or undefined if no keyboard.
 */
function extractButtons(markup: unknown): string[][] | undefined {
  if (!markup || typeof markup !== 'object') return undefined;
  const m = markup as { inline_keyboard?: { text: string }[][]; keyboard?: { text: string }[][] };
  const rows = m.inline_keyboard ?? m.keyboard;
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  return rows.map((row) => row.map((btn) => btn.text));
}

/**
 * Build the grammY output sink for a given `Context`. This is the ONLY
 * implementation that appends the debug footer, calls `log.telegramOut`,
 * and actually talks to Telegram. Every call delegated by the core runs
 * through here when the adapter is in production.
 */
function grammyOutputSink(ctx: Context): OutputSink {
  return {
    async reply(text, options) {
      const debugFooter = log.getDebugFooter();
      // MarkdownV2 messages have pre-escaped content — the debug footer contains
      // reserved chars (|, ., -) that would cause Telegram to reject the message.
      // Skip the footer for MarkdownV2; it's a dev convenience, not worth breaking output.
      const fullText = options?.parse_mode === 'MarkdownV2' ? text : text + debugFooter;
      const buttons = extractButtons(options?.reply_markup as unknown);
      log.telegramOut(fullText, buttons);
      await ctx.reply(fullText, options as { reply_markup?: InlineKeyboard | Keyboard; parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML' } | undefined);
    },
    async answerCallback() {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    },
    startTyping() {
      return startTypingIndicator(ctx);
    },
  };
}

/**
 * Create and configure the Telegram bot.
 *
 * Wires a single `BotCore` instance into every incoming update. The core is
 * shared across all handlers because v0.0.1 is single-user and session state
 * lives in the core closure — the middleware already rejects anything that
 * isn't from the authorized chat, so there's no multi-tenancy concern.
 */
export function createBot(deps: BotDeps): Bot {
  const { llm } = deps;
  const bot = new Bot(config.telegram.botToken);

  // Single shared core instance for the lifetime of the process.
  const core: BotCore = createBotCore(deps);

  // ─── Logging + operation-timer middleware ──────────────────────────────
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id?.toString() ?? '?';
    const type = ctx.callbackQuery
      ? 'callback'
      : ctx.message?.voice
      ? 'voice'
      : ctx.message?.text
      ? 'text'
      : 'other';
    const data = ctx.callbackQuery?.data ?? ctx.message?.text?.slice(0, 80) ?? '(voice/other)';
    log.telegramIn(type, `chat=${chatId} ${data}`);
    // Start a fresh operation timer for every inbound update. If the
    // handler triggers LLM calls, they append to this operation; the final
    // reply's debug footer reads the accumulated events.
    log.startOperation();
    await next();
  });

  // ─── Auth middleware ───────────────────────────────────────────────────
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id?.toString();
    if (chatId !== config.telegram.chatId) {
      log.debug('AUTH', `Rejected message from chat ${chatId}`);
      return;
    }
    await next();
  });

  // Each grammY handler wraps dispatch in a try/catch that logs the error
  // and sends a friendly "Something went wrong" reply. This is the
  // production-only safety net — the harness runner deliberately lets
  // errors propagate so scenarios fail loudly instead of poisoning the
  // captured transcript. See the comment on `BotCore.dispatch` in
  // `src/telegram/core.ts` for the full rationale.
  async function runDispatch(update: HarnessUpdate, ctx: Context, context: string): Promise<void> {
    try {
      await core.dispatch(update, grammyOutputSink(ctx));
    } catch (err) {
      log.error('BOT', `${context} error`, err);
      await grammyOutputSink(ctx).reply('Something went wrong. Try again.');
    }
  }

  // ─── Commands ──────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    await runDispatch({ type: 'command', command: 'start' }, ctx, 'start command');
  });

  bot.command('cancel', async (ctx) => {
    await runDispatch({ type: 'command', command: 'cancel' }, ctx, 'cancel command');
  });

  // ─── Callback queries (inline button taps) ─────────────────────────────
  bot.on('callback_query:data', async (ctx) => {
    await runDispatch({ type: 'callback', data: ctx.callbackQuery.data }, ctx, 'callback');
  });

  // ─── Voice messages ────────────────────────────────────────────────────
  // Transcription happens in the adapter so the core (and the harness) never
  // see raw audio. The core receives a `voice` update with transcribedText,
  // which it routes through the same handler as free-form text input.
  bot.on('message:voice', async (ctx) => {
    try {
      const stopTyping = startTypingIndicator(ctx);
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
      const audioResponse = await fetch(url);
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
      const text = await llm.transcribe(audioBuffer);
      stopTyping();
      log.debug('FLOW', `voice transcribed: "${text}"`);
      await runDispatch({ type: 'voice', transcribedText: text }, ctx, 'voice');
    } catch (err) {
      log.error('BOT', 'Voice message error', err);
      await grammyOutputSink(ctx).reply('Something went wrong with the voice message. Try typing instead.');
    }
  });

  // ─── Text messages ─────────────────────────────────────────────────────
  bot.on('message:text', async (ctx) => {
    await runDispatch({ type: 'text', text: ctx.message.text }, ctx, 'text');
  });

  return bot;
}
