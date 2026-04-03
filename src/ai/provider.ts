/**
 * LLM provider interface.
 *
 * All LLM calls in the system go through this interface. This makes the system
 * LLM-agnostic — switching from OpenAI to Claude or Gemini requires only a new
 * implementation of this interface, not changes to business logic.
 *
 * Two tiers of model:
 * - primary: complex tasks (recipe generation, orchestrator reasoning)
 * - mini: simple tasks (input parsing, estimation, scaling)
 *
 * Both support reasoning modes that control how much "thinking" the model does.
 */

/** How much internal reasoning the model should use. */
export type ReasoningMode = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionOptions {
  /** Which model tier to use */
  model: 'primary' | 'mini';
  messages: ChatMessage[];
  /** Reasoning effort — defaults to 'none' */
  reasoning?: ReasoningMode;
  /** If true, expect and parse JSON response */
  json?: boolean;
  /** Max tokens for the response */
  maxTokens?: number;
}

export interface CompletionResult {
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Provider interface for LLM operations.
 * Implementations: OpenAIProvider (v0.0.1).
 */
export interface LLMProvider {
  /**
   * Generate a chat completion.
   *
   * @param options - Model tier, messages, reasoning mode, etc.
   * @returns The model's response content and token usage
   */
  complete(options: CompletionOptions): Promise<CompletionResult>;

  /**
   * Transcribe a voice message to text.
   *
   * @param audioBuffer - Raw audio data (OGG/Opus from Telegram)
   * @returns Transcribed text
   */
  transcribe(audioBuffer: Buffer): Promise<string>;
}
