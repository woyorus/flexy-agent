/**
 * `CapturingOutputSink` — the `OutputSink` implementation the harness uses
 * to record every reply the core makes during a scenario replay.
 *
 * The sink does NOT:
 *   - Talk to Telegram (no grammY dependency at runtime — only type imports).
 *   - Append the debug footer. `BotCore.dispatch` produces clean text; the
 *     footer is only appended inside the real grammY adapter (`bot.ts`).
 *     Keeping the harness sink footer-free is what makes captured
 *     transcripts deterministic regardless of DEBUG mode.
 *   - Write to `logs/debug.log`. Harness runs are silent by design;
 *     scenario failures surface through `deepStrictEqual` diffs, not log
 *     scraping.
 *
 * The sink DOES:
 *   - Record each `reply(text, { reply_markup })` as a `CapturedOutput`
 *     with the text and a tagged serialization of the keyboard.
 *   - Translate grammY `Keyboard` / `InlineKeyboard` instances into the
 *     comparison-friendly `CapturedKeyboard` shape defined in `types.ts`.
 *   - Make `answerCallback` and `startTyping` into no-ops that satisfy the
 *     interface without side-effects.
 *
 * The grammY types are imported as types only — the sink lives in the
 * harness and mustn't pull in grammY transitively during a test run beyond
 * what type-only imports require (zero runtime cost).
 */

import type { InlineKeyboard, Keyboard } from 'grammy';
import type { OutputSink } from '../telegram/core.js';
import type { CapturedKeyboard, CapturedOutput } from './types.js';

/**
 * An in-memory sink whose `captured` array grows with every `reply` call.
 * Pass it to `BotCore.dispatch`; read `sink.captured` after the event loop
 * finishes and compare against the recorded expected outputs.
 */
export class CapturingOutputSink implements OutputSink {
  readonly captured: CapturedOutput[] = [];

  async reply(
    text: string,
    options?: { reply_markup?: Keyboard | InlineKeyboard; parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML' },
  ): Promise<void> {
    const entry: CapturedOutput = { text };
    if (options?.reply_markup) {
      entry.keyboard = serializeKeyboard(options.reply_markup);
    }
    this.captured.push(entry);
  }

  async answerCallback(): Promise<void> {
    // No-op — inline callback acknowledgements don't affect observable
    // state and have no output text for the transcript.
  }

  startTyping(): () => void {
    // No-op — typing indicators are purely visual in Telegram and have no
    // effect on captured output.
    return () => {};
  }
}

/**
 * Convert a grammY keyboard instance into the tagged `CapturedKeyboard`
 * shape. Detects reply vs inline by looking at the shape of the internal
 * arrays — grammY exposes `inline_keyboard` on `InlineKeyboard` and
 * `keyboard` + optional layout flags on `Keyboard`.
 *
 * grammY's `Keyboard` class stores the rows on `.keyboard` and attaches
 * optional layout flags (`is_persistent`, `resize_keyboard`) as named
 * properties. We read those via a loose interface rather than depending on
 * grammY internals — the shape has been stable for many releases, and if
 * it ever changes, the test suite will fail loudly with a structural diff
 * pointing at this function.
 */
function serializeKeyboard(kb: Keyboard | InlineKeyboard): CapturedKeyboard {
  const raw = kb as unknown as {
    inline_keyboard?: { text: string; callback_data?: string }[][];
    keyboard?: { text: string }[][];
    is_persistent?: boolean;
    resize_keyboard?: boolean;
  };

  if (raw.inline_keyboard) {
    return {
      kind: 'inline',
      buttons: raw.inline_keyboard.map((row) =>
        row.map((btn) => ({ label: btn.text, callback: btn.callback_data ?? '' })),
      ),
    };
  }

  if (raw.keyboard) {
    const out: CapturedKeyboard = {
      kind: 'reply',
      buttons: raw.keyboard.map((row) => row.map((btn) => btn.text)),
    };
    if (raw.is_persistent) out.persistent = true;
    if (raw.resize_keyboard) out.resized = true;
    return out;
  }

  // Fallback: unknown keyboard shape. Emit an empty inline keyboard so the
  // diff at least shows WHERE the mismatch is rather than throwing mid-run.
  return { kind: 'inline', buttons: [] };
}
