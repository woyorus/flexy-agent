/**
 * Application configuration.
 *
 * Loads environment variables and defines hardcoded user targets for v0.0.1.
 * v0.0.1 is single-user with fixed targets. Future versions will calculate
 * personalized targets from an onboarding flow.
 *
 * Environment variables required:
 * - TELEGRAM_BOT_TOKEN: Bot token from @BotFather
 * - TELEGRAM_CHAT_ID: Authorized user's chat ID (single-user auth)
 * - OPENAI_API_KEY: OpenAI API key for LLM + Whisper
 * - SUPABASE_URL: Supabase project URL
 * - SUPABASE_ANON_KEY: Supabase anonymous key
 *
 * Optional:
 * - DEBUG: Set to "1" or "true" to enable verbose logging and Telegram debug footers.
 *          Launch with: DEBUG=1 npm run dev
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  /** Enable verbose debug logging and Telegram debug footers. */
  debug: process.env.DEBUG === '1' || process.env.DEBUG === 'true',

  telegram: {
    botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    /** Only messages from this chat ID are processed. All others are ignored. */
    chatId: requireEnv('TELEGRAM_CHAT_ID'),
  },

  openai: {
    apiKey: requireEnv('OPENAI_API_KEY'),
    /** Complex tasks: recipe generation, orchestrator reasoning */
    primaryModel: 'gpt-5.4' as const,
    /** Medium tasks: conversational answers, estimation */
    miniModel: 'gpt-5.4-mini' as const,
    /** Trivial tasks: classification, intent detection, input parsing */
    nanoModel: 'gpt-5.4-nano' as const,
    /** Voice message transcription */
    whisperModel: 'whisper-1' as const,
  },

  supabase: {
    url: requireEnv('SUPABASE_URL'),
    anonKey: requireEnv('SUPABASE_ANON_KEY'),
  },

  /**
   * Hardcoded user targets for v0.0.1.
   *
   * Product-facing: calories and protein (what the user sees).
   * Internal: fat and carbs (used by recipe generator for balanced meals).
   *
   * Priority when tradeoffs happen:
   * 1. Calories (most important for deficit)
   * 2. Protein (satiety, muscle preservation)
   * 3. Fat (set appropriate levels)
   * 4. Carbs (fill remaining calories)
   */
  targets: {
    daily: {
      calories: 2436,
      protein: 150,
      /** Internal — not shown to user */
      fat: 131,
      /** Internal — not shown to user */
      carbs: 164,
    },
    weekly: {
      calories: 2436 * 7, // 17052
      protein: 150 * 7,   // 1050
    },
  },

  /**
   * User food profile — shapes ingredient selection and cuisine choices
   * across recipe generation and plan proposals.
   *
   * v0.0.1: hardcoded for single user (southern Spain).
   * v0.1.0: moves to Supabase user profile, editable via onboarding.
   */
  foodProfile: {
    region: 'Southern Spain',
    storeAccess: 'Standard European supermarkets (Mercadona, Lidl, Carrefour). Good access to fresh seafood, Mediterranean produce, olive oil, Iberian pork, Spanish cheeses.',
    ingredientNotes: 'Prefer ingredients commonly available in Spanish supermarkets. Mediterranean, Spanish, and Southern European ingredients are natural choices. Asian ingredients are fine if they are the common ones found in any supermarket (soy sauce, rice, ginger, coconut milk) — avoid specialty Asian grocery items. Avoid niche North American ingredients (Cotija cheese, chipotle en adobo, ranch seasoning, American-style BBQ sauces). When a recipe calls for cheese, prefer commonly available European options (manchego, mozzarella, parmesan, feta, goat cheese).',
    avoided: [] as string[],
  },

  /** Recipe file storage path relative to project root */
  recipesDir: 'recipes',
} as const;
