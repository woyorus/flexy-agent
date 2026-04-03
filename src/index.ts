/**
 * Flexie — Entry point.
 *
 * Boots the Telegram bot with all dependencies wired together:
 * 1. Load environment config
 * 2. Initialize LLM provider (OpenAI)
 * 3. Load recipe database from disk
 * 4. Initialize state store (Supabase)
 * 5. Create orchestrator (LLM + state machine + sub-agents + solver)
 * 6. Create and start the Telegram bot
 *
 * v0.0.1 is single-user with hardcoded targets. The bot only responds
 * to messages from the configured TELEGRAM_CHAT_ID.
 */

import 'dotenv/config';
import { OpenAIProvider } from './ai/openai.js';
import { RecipeDatabase } from './recipes/database.js';
import { StateStore } from './state/store.js';
import { Orchestrator } from './agents/orchestrator.js';
import { createBot } from './telegram/bot.js';
import { config } from './config.js';

async function main() {
  console.log('Starting Flexie v0.0.1...');

  // Initialize LLM provider
  const llm = new OpenAIProvider();
  console.log('  LLM provider: OpenAI (GPT-5.4 + GPT-5.4-mini + Whisper)');

  // Load recipe database
  const recipes = new RecipeDatabase(config.recipesDir);
  await recipes.load();
  console.log(`  Recipes loaded: ${recipes.size}`);

  // Initialize state store
  const store = new StateStore();
  console.log('  State store: Supabase');

  // Create orchestrator
  const orchestrator = new Orchestrator(llm, recipes, store);
  await orchestrator.init();
  console.log('  Orchestrator initialized');

  // Create and start bot
  const bot = createBot(orchestrator);

  bot.catch((err) => {
    console.error('Bot error:', err);
  });

  await bot.start({
    onStart: () => {
      console.log(`  Bot started. Listening for chat ID: ${config.telegram.chatId}`);
      console.log('Flexie is running.');
    },
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
