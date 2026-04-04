/**
 * Flexie — Entry point.
 *
 * Boots the Telegram bot with all dependencies wired together:
 * 1. Load environment config
 * 2. Initialize debug logger
 * 3. Initialize LLM provider (OpenAI)
 * 4. Load recipe database from disk
 * 5. Create and start the Telegram bot
 *
 * v0.0.1 is single-user with hardcoded targets. The bot only responds
 * to messages from the configured TELEGRAM_CHAT_ID.
 *
 * Debug mode: set DEBUG=1 to enable verbose logging to console and
 * `logs/debug.log`. Use `npm run dev:debug` as a shortcut.
 */

import 'dotenv/config';
import { OpenAIProvider } from './ai/openai.js';
import { RecipeDatabase } from './recipes/database.js';
import { StateStore } from './state/store.js';
import { createBot } from './telegram/bot.js';
import { config } from './config.js';
import { log } from './debug/logger.js';

async function main() {
  log.init(config.debug);
  log.boot(`Starting Flexie v0.0.1...${config.debug ? ' (DEBUG mode)' : ''}`);

  const llm = new OpenAIProvider();
  log.boot('LLM provider: OpenAI (GPT-5.4 + GPT-5.4-mini + Whisper)');

  const recipes = new RecipeDatabase(config.recipesDir);
  await recipes.load();
  log.boot(`Recipes loaded: ${recipes.size}`);

  const store = new StateStore();
  log.boot('State store: Supabase');

  const bot = createBot({ llm, recipes, store });

  bot.catch((err) => {
    log.error('BOT', 'Unhandled bot error', err);
  });

  await bot.start({
    onStart: () => {
      log.boot(`Bot started. Listening for chat ID: ${config.telegram.chatId}`);
      log.boot('Flexie is running.');
      if (config.debug) {
        log.boot('Debug log: logs/debug.log');
      }
    },
  });
}

main().catch((err) => {
  log.error('BOOT', 'Fatal error', err);
  process.exit(1);
});
