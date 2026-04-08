/**
 * OpenAI provider implementation.
 *
 * Implements the LLMProvider interface using the OpenAI API:
 * - GPT-5.4 for complex tasks (recipe generation, orchestrator)
 * - GPT-5.4-mini for medium tasks (conversational answers, estimation)
 * - GPT-5.4-nano for trivial tasks (classification, intent detection, input parsing)
 * - Whisper for voice message transcription
 *
 * Both GPT models support reasoning modes via the `reasoning` parameter.
 * Reasoning modes map to the OpenAI API's reasoning_effort parameter.
 *
 * All AI calls are logged to the debug log with full prompt content, response,
 * token usage, and duration. Costs are calculated and recorded to `data/logs/costs.jsonl`
 * via the cost tracker.
 */

import OpenAI from 'openai';
import { config } from '../config.js';
import { log } from '../debug/logger.js';
import { recordCompletionCost, recordWhisperCost } from '../debug/costs.js';
import type {
  LLMProvider,
  CompletionOptions,
  CompletionResult,
  ReasoningMode,
} from './provider.js';

/**
 * OpenAI-backed LLM provider.
 * Instantiated once at startup and shared across the system.
 */
export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({ apiKey: config.openai.apiKey });
  }

  /**
   * Generate a chat completion using GPT-5.4, GPT-5.4-mini, or GPT-5.4-nano.
   *
   * Maps the abstract model tier to the concrete model ID from config.
   * Passes reasoning mode through to the API when not 'none'.
   * Logs the full request/response and records cost to costs.jsonl.
   */
  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const model = options.model === 'primary'
      ? config.openai.primaryModel
      : options.model === 'mini'
        ? config.openai.miniModel
        : config.openai.nanoModel;

    const reasoning = options.reasoning ?? 'none';
    const context = options.context ?? 'unknown';

    // Log request summary
    const msgSummary = options.messages
      .map((m) => `${m.role}:${m.content.length}ch`)
      .join(', ');
    log.debug(
      'AI:REQ',
      `model=${model} reasoning=${reasoning} json=${!!options.json} context=${context} msgs=[${msgSummary}]`,
    );

    // Log full prompt content to file
    for (const msg of options.messages) {
      log.debug('AI:REQ', `[${msg.role}] ${msg.content.slice(0, 2000)}${msg.content.length > 2000 ? `... (${msg.content.length} chars total)` : ''}`);
    }

    const start = Date.now();

    const params: OpenAI.Chat.ChatCompletionCreateParams = {
      model,
      messages: options.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      ...(options.maxTokens && { max_completion_tokens: options.maxTokens }),
      ...(options.json && { response_format: { type: 'json_object' as const } }),
      ...(options.reasoning && options.reasoning !== 'none' && {
        reasoning_effort: mapReasoningMode(options.reasoning),
      }),
    };

    const response = await this.client.chat.completions.create(params);
    const choice = response.choices[0];
    const content = choice?.message?.content ?? '';

    const durationMs = Date.now() - start;
    const duration = (durationMs / 1000).toFixed(1);
    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;

    // Log response summary and full content
    log.debug(
      'AI:RES',
      `model=${model} duration=${duration}s in=${inputTokens} out=${outputTokens}`,
    );
    log.debug('AI:RES', `response body:`, content);

    // Record cost
    recordCompletionCost({
      model,
      tier: options.model,
      reasoning,
      inputTokens,
      outputTokens,
      durationMs,
      context,
    });

    // Track for operation debug footer
    log.addOperationEvent(
      `${options.model}/${reasoning} ${duration}s ${inputTokens + outputTokens}tok`,
    );

    return {
      content,
      usage: {
        inputTokens,
        outputTokens,
      },
    };
  }

  /**
   * Transcribe audio to text using Whisper.
   *
   * Telegram sends voice messages as OGG/Opus. Whisper accepts this format directly.
   * Cost is estimated from audio buffer size (Opus at ~4 KB/sec).
   *
   * @param audioBuffer - Raw audio bytes from Telegram
   * @returns Transcribed text
   */
  async transcribe(audioBuffer: Buffer): Promise<string> {
    log.debug('AI:STT', `Transcribing voice message (${(audioBuffer.length / 1024).toFixed(1)} KB)`);
    const start = Date.now();

    const file = new File([audioBuffer], 'voice.ogg', { type: 'audio/ogg' });

    const response = await this.client.audio.transcriptions.create({
      model: config.openai.whisperModel,
      file,
    });

    const durationMs = Date.now() - start;
    const duration = (durationMs / 1000).toFixed(1);
    log.debug('AI:STT', `Transcribed in ${duration}s: "${response.text}"`);

    // Record cost
    recordWhisperCost({ audioBytes: audioBuffer.length, durationMs });

    log.addOperationEvent(`whisper ${duration}s`);

    return response.text;
  }
}

/**
 * Map our reasoning mode names to OpenAI API's reasoning_effort values.
 * OpenAI uses 'low', 'medium', 'high'. We add 'xhigh' which maps to 'high'
 * with a note that it may map differently in future API versions.
 */
function mapReasoningMode(mode: ReasoningMode): 'low' | 'medium' | 'high' {
  switch (mode) {
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh': return 'high'; // closest available
    default: return 'medium';
  }
}
