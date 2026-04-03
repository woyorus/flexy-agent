/**
 * OpenAI provider implementation.
 *
 * Implements the LLMProvider interface using the OpenAI API:
 * - GPT-5.4 for complex tasks (recipe generation, orchestrator)
 * - GPT-5.4-mini for simple tasks (parsing, estimation)
 * - Whisper for voice message transcription
 *
 * Both GPT models support reasoning modes via the `reasoning` parameter.
 * Reasoning modes map to the OpenAI API's reasoning_effort parameter.
 */

import OpenAI from 'openai';
import { config } from '../config.js';
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
   * Generate a chat completion using GPT-5.4 or GPT-5.4-mini.
   *
   * Maps the abstract model tier to the concrete model ID from config.
   * Passes reasoning mode through to the API when not 'none'.
   */
  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const model = options.model === 'primary'
      ? config.openai.primaryModel
      : config.openai.miniModel;

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

    return {
      content: choice?.message?.content ?? '',
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  /**
   * Transcribe audio to text using Whisper.
   *
   * Telegram sends voice messages as OGG/Opus. Whisper accepts this format directly.
   *
   * @param audioBuffer - Raw audio bytes from Telegram
   * @returns Transcribed text
   */
  async transcribe(audioBuffer: Buffer): Promise<string> {
    const file = new File([audioBuffer], 'voice.ogg', { type: 'audio/ogg' });

    const response = await this.client.audio.transcriptions.create({
      model: config.openai.whisperModel,
      file,
    });

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
