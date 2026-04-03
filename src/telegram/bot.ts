/**
 * Telegram bot setup and message routing.
 *
 * This is the UI layer of Flexie. It handles:
 * - Authentication (single-user via hardcoded chat ID)
 * - Message routing (text, voice, button taps)
 * - Main menu commands
 * - Voice message transcription via Whisper
 *
 * The bot does NOT contain business logic. It routes input to the orchestrator
 * and sends back the orchestrator's response. Button taps go directly to the
 * state machine (bypassing the LLM). Free-form text/voice goes through the
 * orchestrator LLM for interpretation.
 *
 * Architecture: Telegram Bot API → this file → Orchestrator → State Machine / Solver / Agents
 */

import { Bot, Context, session } from 'grammy';
import { config } from '../config.js';
import { mainMenuKeyboard } from './keyboards.js';
import type { Orchestrator } from '../agents/orchestrator.js';

/**
 * Create and configure the Telegram bot.
 *
 * @param orchestrator - The agent orchestrator that handles all business logic
 * @returns Configured Bot instance ready to start polling
 */
export function createBot(orchestrator: Orchestrator): Bot {
  const bot = new Bot(config.telegram.botToken);

  // ─── Logging middleware ─────────────────────────────────────────────────
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id?.toString() ?? '?';
    const type = ctx.callbackQuery ? 'callback' : ctx.message?.voice ? 'voice' : ctx.message?.text ? 'text' : 'other';
    console.log(`[incoming] chat=${chatId} type=${type} data=${ctx.callbackQuery?.data ?? ctx.message?.text?.slice(0, 50) ?? '(voice/other)'}`);
    await next();
  });

  // ─── Auth middleware: single-user gate ──────────────────────────────────
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id?.toString();
    if (chatId !== config.telegram.chatId) {
      console.log(`[auth] rejected chat=${chatId}`);
      return;
    }
    await next();
  });

  // ─── /start command ────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const response = await orchestrator.handleStart();
    await ctx.reply(response.text, {
      reply_markup: response.keyboard ?? mainMenuKeyboard,
      ...(response.inlineKeyboard && { reply_markup: response.inlineKeyboard }),
    });
  });

  // ─── /cancel command — exits any flow ──────────────────────────────────
  bot.command('cancel', async (ctx) => {
    const response = await orchestrator.handleCancel();
    await ctx.reply(response.text, { reply_markup: mainMenuKeyboard });
  });

  // ─── Callback queries (inline button taps) ────────────────────────────
  // These bypass the LLM — they map directly to state machine transitions.
  bot.on('callback_query:data', async (ctx) => {
    try {
      const action = ctx.callbackQuery.data;
      console.log(`[bot] callback: ${action}`);
      await ctx.answerCallbackQuery();

      const response = await orchestrator.handleButtonTap(action);
      await ctx.reply(response.text, {
        reply_markup: response.inlineKeyboard ?? response.keyboard,
      });
    } catch (err) {
      console.error('[bot] callback handler error:', err);
      await ctx.answerCallbackQuery();
      await ctx.reply('Something went wrong. Try again.');
    }
  });

  // ─── Voice messages ────────────────────────────────────────────────────
  // Transcribed via Whisper, then processed identically to text.
  bot.on('message:voice', async (ctx) => {
    try {
      await ctx.replyWithChatAction('typing');
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;

      // Download voice file
      const audioResponse = await fetch(url);
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

      const response = await orchestrator.handleVoice(audioBuffer);
      await ctx.reply(response.text, {
        reply_markup: response.inlineKeyboard ?? response.keyboard,
      });
    } catch (err) {
      console.error('[bot] voice handler error:', err);
      await ctx.reply('Something went wrong processing your voice message. Try again or type instead.');
    }
  });

  // ─── Text messages ─────────────────────────────────────────────────────
  // Reply keyboard taps come as text. Route main menu taps directly;
  // everything else goes through the orchestrator as free-form input.
  bot.on('message:text', async (ctx) => {
    try {
      const text = ctx.message.text;

      // Main menu reply keyboard buttons
      const menuAction = matchMainMenu(text);
      if (menuAction) {
        console.log(`[bot] menu: ${menuAction}`);
        const response = await orchestrator.handleMainMenu(menuAction);
        await ctx.reply(response.text, {
          reply_markup: response.inlineKeyboard ?? response.keyboard ?? mainMenuKeyboard,
        });
        return;
      }

      // Free-form text input → orchestrator LLM
      await ctx.replyWithChatAction('typing');
      const response = await orchestrator.handleText(text);
      await ctx.reply(response.text, {
        reply_markup: response.inlineKeyboard ?? response.keyboard,
      });
    } catch (err) {
      console.error('[bot] text handler error:', err);
      await ctx.reply('Something went wrong. Try again.');
    }
  });

  return bot;
}

/**
 * Match a text message against the main menu keyboard buttons.
 * Returns the action name, or null if no match.
 */
function matchMainMenu(text: string): string | null {
  const menuMap: Record<string, string> = {
    '📋 Plan Week': 'plan_week',
    '🛒 Shopping List': 'shopping_list',
    '📖 My Recipes': 'my_recipes',
    '📊 Weekly Budget': 'weekly_budget',
  };
  return menuMap[text] ?? null;
}
