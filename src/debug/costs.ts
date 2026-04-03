/**
 * AI cost tracker.
 *
 * Records every AI API call with token usage and calculated cost to `logs/costs.jsonl`.
 * The JSONL file is append-only across sessions, building a full cost history over time.
 * Maintains session-level totals in memory for console output.
 *
 * Pricing is hardcoded per model tier. Update the PRICING constant when OpenAI changes prices.
 * Source: https://developers.openai.com/api/docs/models
 *
 * Designed for the dev workflow: run the bot, test features, then analyze costs
 * by grepping/summing the JSONL file to see which operations are expensive.
 *
 * Example costs.jsonl entry:
 * {"ts":"2026-04-03T14:23:05Z","model":"gpt-5.4","tier":"primary","reasoning":"high",
 *  "in_tok":1500,"out_tok":800,"cost_usd":0.01575,"duration_s":3.4,"context":"recipe-generation"}
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './logger.js';

const LOGS_DIR = join(process.cwd(), 'logs');
const COSTS_FILE = join(LOGS_DIR, 'costs.jsonl');

/**
 * Price per million tokens (USD).
 * Source: https://developers.openai.com/api/docs/models (as of 2026-04-03)
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-5.4':      { input: 2.50,  output: 15.00 },
  'gpt-5.4-mini': { input: 0.75,  output: 4.50  },
  'gpt-5.4-nano': { input: 0.20,  output: 1.25  },
};

/** Whisper pricing: ~$0.006 per minute of audio. */
const WHISPER_COST_PER_MINUTE = 0.006;

/** Session-level cost accumulator. Reset on each app restart. */
let sessionCost = 0;
let sessionCalls = 0;
const costsByContext = new Map<string, { calls: number; cost: number; inTok: number; outTok: number }>();

/**
 * Calculate and record cost for an LLM completion call.
 * Writes a JSON line to costs.jsonl and updates session totals.
 * Logs to console in debug mode.
 *
 * @param opts.model - Concrete model ID (e.g., 'gpt-5.4')
 * @param opts.tier - Abstract tier ('primary', 'mini', 'nano')
 * @param opts.reasoning - Reasoning mode used
 * @param opts.inputTokens - Prompt tokens consumed
 * @param opts.outputTokens - Completion tokens generated
 * @param opts.durationMs - Wall-clock time for the API call
 * @param opts.context - What triggered this call (e.g., 'recipe-generation')
 */
export function recordCompletionCost(opts: {
  model: string;
  tier: string;
  reasoning: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  context: string;
}): void {
  const pricing = PRICING[opts.model];
  if (!pricing) {
    log.warn('COST', `No pricing configured for model "${opts.model}"`);
    return;
  }

  const inCost = (opts.inputTokens / 1_000_000) * pricing.input;
  const outCost = (opts.outputTokens / 1_000_000) * pricing.output;
  const totalCost = inCost + outCost;
  const durationS = Math.round((opts.durationMs / 1000) * 10) / 10;

  sessionCost += totalCost;
  sessionCalls++;

  const ctx = costsByContext.get(opts.context) ?? { calls: 0, cost: 0, inTok: 0, outTok: 0 };
  ctx.calls++;
  ctx.cost += totalCost;
  ctx.inTok += opts.inputTokens;
  ctx.outTok += opts.outputTokens;
  costsByContext.set(opts.context, ctx);

  writeEntry({
    ts: new Date().toISOString(),
    model: opts.model,
    tier: opts.tier,
    reasoning: opts.reasoning,
    in_tok: opts.inputTokens,
    out_tok: opts.outputTokens,
    cost_usd: roundCost(totalCost),
    duration_s: durationS,
    context: opts.context,
  });

  log.debug(
    'AI:COST',
    `${opts.model} $${totalCost.toFixed(4)} (in:${opts.inputTokens} $${inCost.toFixed(4)} + out:${opts.outputTokens} $${outCost.toFixed(4)}) | session: $${sessionCost.toFixed(4)} (${sessionCalls} calls)`,
  );
}

/**
 * Record cost for a Whisper transcription call.
 * Estimates audio duration from buffer size (Opus at ~4 KB/sec).
 *
 * @param opts.audioBytes - Size of the audio buffer in bytes
 * @param opts.durationMs - Wall-clock time for the API call
 */
export function recordWhisperCost(opts: {
  audioBytes: number;
  durationMs: number;
}): void {
  const estimatedMinutes = opts.audioBytes / (4 * 1024 * 60);
  const cost = estimatedMinutes * WHISPER_COST_PER_MINUTE;
  const durationS = Math.round((opts.durationMs / 1000) * 10) / 10;

  sessionCost += cost;
  sessionCalls++;

  const ctx = costsByContext.get('whisper-stt') ?? { calls: 0, cost: 0, inTok: 0, outTok: 0 };
  ctx.calls++;
  ctx.cost += cost;
  costsByContext.set('whisper-stt', ctx);

  writeEntry({
    ts: new Date().toISOString(),
    model: 'whisper-1',
    tier: 'whisper',
    reasoning: 'none',
    in_tok: 0,
    out_tok: 0,
    audio_bytes: opts.audioBytes,
    est_minutes: Math.round(estimatedMinutes * 100) / 100,
    cost_usd: roundCost(cost),
    duration_s: durationS,
    context: 'whisper-stt',
  });

  log.debug(
    'AI:COST',
    `whisper-1 $${cost.toFixed(4)} (~${estimatedMinutes.toFixed(1)}min audio) | session: $${sessionCost.toFixed(4)} (${sessionCalls} calls)`,
  );
}

/**
 * Get current session cost totals.
 * Useful for summary output or Telegram commands.
 */
export function getSessionCostSummary(): {
  totalCost: number;
  totalCalls: number;
  byContext: Map<string, { calls: number; cost: number; inTok: number; outTok: number }>;
} {
  return {
    totalCost: sessionCost,
    totalCalls: sessionCalls,
    byContext: costsByContext,
  };
}

/** Round cost to 6 decimal places to avoid floating-point noise in JSONL. */
function roundCost(cost: number): number {
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Append a JSON entry to costs.jsonl. Silently ignores write failures. */
function writeEntry(entry: Record<string, unknown>): void {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(COSTS_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Don't crash the app on log write failure
  }
}
