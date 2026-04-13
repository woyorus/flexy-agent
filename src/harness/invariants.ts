/**
 * Global scenario invariants.
 *
 * Plan 031 — a small fixed set of checks that MUST hold for every scenario.
 * These are truly global: any scenario where one of these fails is either
 * ill-formed (the recording was hand-edited wrong) or has a latent product
 * bug that the suite should surface, not tolerate.
 *
 * Invariants run on every scenario during `npm test` BEFORE the three
 * `deepStrictEqual` checks so semantic failures surface ahead of byte-diff
 * output.
 *
 * The current set (GI-01..GI-06) is deliberately conservative. Adding a
 * new invariant requires the same "truly global" bar: if any current
 * scenario breaks it legitimately, it does not belong here and should live
 * in that scenario's `assertions.ts`.
 */

import type { CapturedKeyboard, CapturedOutput, RecordedScenario } from './types.js';

export interface InvariantResult {
  id: string;
  passed: boolean;
  message?: string;
}

/**
 * Canonical UUID pattern (versions 1-5, RFC 4122 variant). Deliberately
 * stricter than a blanket `[0-9a-f]{8}-...` match: several scenarios seed
 * stable test-owned IDs of the form `session-a-00000000-0000-0000-0000-
 * 000000000001` where the tail is a *nil-like* placeholder (version
 * nibble 0 — impossible for a real UUID). Matching only v1-v5 skips
 * those placeholders while still catching any runtime-generated UUID
 * that leaks past `normalizeUuids` (which uses `uuid.v4()` — version 4).
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T/;
const SHA256_RE = /^[0-9a-f]{64}$/i;

/**
 * Run every global invariant against a recording + captured output pair.
 * Returns one `InvariantResult` per invariant; the caller aggregates and
 * reports. This shape (list of results, not first-failure) lets the test
 * body surface every failing invariant at once, which is useful when
 * multiple are broken in the same recording.
 */
export function runGlobalInvariants(
  recorded: RecordedScenario,
  outputs: readonly CapturedOutput[],
): InvariantResult[] {
  return [
    invariantRecordingWellFormed(recorded),
    invariantNoFallbackMessages(outputs),
    invariantNoUndefinedOrStringifiedObjects(outputs),
    invariantNoEmptyReplies(outputs),
    invariantKeyboardsNonEmpty(outputs),
    invariantUuidsNormalized(recorded),
  ];
}

// ─── GI-01 recording-well-formed ──────────────────────────────────────────────

/**
 * The recording itself has the shape the runner expects: ISO `generatedAt`,
 * 64-char hex `specHash`, array `llmFixtures`, and an `expected` block
 * with an `outputs` array and a `finalSession` field.
 *
 * Failure modes: a hand-edited or corrupted `recorded.json` with missing
 * top-level fields — the replay would still partially work but the suite
 * should not trust it.
 */
function invariantRecordingWellFormed(recorded: RecordedScenario): InvariantResult {
  const id = 'GI-01-recording-well-formed';

  if (typeof recorded.generatedAt !== 'string' || !ISO_DATE_RE.test(recorded.generatedAt)) {
    return {
      id,
      passed: false,
      message: `recorded.generatedAt must be an ISO timestamp (got: ${JSON.stringify(recorded.generatedAt)})`,
    };
  }
  if (typeof recorded.specHash !== 'string' || !SHA256_RE.test(recorded.specHash)) {
    return {
      id,
      passed: false,
      message: `recorded.specHash must be a 64-char hex sha256 (got: ${JSON.stringify(recorded.specHash)})`,
    };
  }
  if (!Array.isArray(recorded.llmFixtures)) {
    return {
      id,
      passed: false,
      message: `recorded.llmFixtures must be an array (got: ${typeof recorded.llmFixtures})`,
    };
  }
  if (!recorded.expected || typeof recorded.expected !== 'object') {
    return { id, passed: false, message: `recorded.expected is missing or not an object` };
  }
  if (!Array.isArray(recorded.expected.outputs)) {
    return {
      id,
      passed: false,
      message: `recorded.expected.outputs must be an array (got: ${typeof recorded.expected.outputs})`,
    };
  }
  if (recorded.expected.finalSession === undefined) {
    return { id, passed: false, message: `recorded.expected.finalSession must be present (can be null, but not undefined)` };
  }
  return { id, passed: true };
}

// ─── GI-02 no-fallback-messages ───────────────────────────────────────────────

/**
 * The string "Something went wrong" is the error fallback path in the
 * bot. A recording that captures it signals a real bug reached the user;
 * the harness must not lock such a transcript as the expected outcome.
 */
function invariantNoFallbackMessages(outputs: readonly CapturedOutput[]): InvariantResult {
  const id = 'GI-02-no-fallback-messages';
  for (let i = 0; i < outputs.length; i += 1) {
    const text = outputs[i]?.text ?? '';
    if (/Something went wrong/i.test(text)) {
      return {
        id,
        passed: false,
        message: `outputs[${i}] contains fallback error text "Something went wrong": ${text.slice(0, 120)}`,
      };
    }
  }
  return { id, passed: true };
}

// ─── GI-03 no-undefined-or-stringified-objects ────────────────────────────────

/**
 * `undefined` and `[object Object]` in user-visible text are tell-tale
 * signs of a template that received the wrong shape (e.g. printing an
 * object instead of a field, or a missing `??` fallback on a union type).
 */
function invariantNoUndefinedOrStringifiedObjects(
  outputs: readonly CapturedOutput[],
): InvariantResult {
  const id = 'GI-03-no-undefined-or-stringified-objects';
  for (let i = 0; i < outputs.length; i += 1) {
    const text = outputs[i]?.text ?? '';
    if (/\bundefined\b/.test(text)) {
      return {
        id,
        passed: false,
        message: `outputs[${i}] contains literal "undefined": ${text.slice(0, 120)}`,
      };
    }
    if (text.includes('[object Object]')) {
      return {
        id,
        passed: false,
        message: `outputs[${i}] contains "[object Object]": ${text.slice(0, 120)}`,
      };
    }
  }
  return { id, passed: true };
}

// ─── GI-04 no-empty-replies ───────────────────────────────────────────────────

/**
 * Telegram rejects empty replies outright; producing one in the harness
 * means the code would crash at runtime. Trim first so whitespace-only
 * replies (almost always a bug) also fail this check.
 */
function invariantNoEmptyReplies(outputs: readonly CapturedOutput[]): InvariantResult {
  const id = 'GI-04-no-empty-replies';
  for (let i = 0; i < outputs.length; i += 1) {
    const text = outputs[i]?.text ?? '';
    if (typeof text !== 'string' || text.trim().length === 0) {
      return {
        id,
        passed: false,
        message: `outputs[${i}] has empty or whitespace-only text`,
      };
    }
  }
  return { id, passed: true };
}

// ─── GI-05 keyboards-non-empty ────────────────────────────────────────────────

/**
 * Every present keyboard has ≥ 1 row and every row has ≥ 1 button.
 * An empty keyboard is ignored by Telegram silently, so this is the
 * class of bug that passes a green `deepStrictEqual` yet shows an odd
 * empty-button message on the user's phone.
 */
function invariantKeyboardsNonEmpty(outputs: readonly CapturedOutput[]): InvariantResult {
  const id = 'GI-05-keyboards-non-empty';
  for (let i = 0; i < outputs.length; i += 1) {
    const keyboard = outputs[i]?.keyboard;
    if (keyboard === undefined) continue;
    const reason = keyboardViolation(keyboard);
    if (reason) {
      return { id, passed: false, message: `outputs[${i}].keyboard: ${reason}` };
    }
  }
  return { id, passed: true };
}

function keyboardViolation(keyboard: CapturedKeyboard): string | undefined {
  if (keyboard.kind === 'reply') {
    if (!Array.isArray(keyboard.buttons) || keyboard.buttons.length === 0) {
      return 'reply keyboard has no rows';
    }
    for (let r = 0; r < keyboard.buttons.length; r += 1) {
      const row = keyboard.buttons[r];
      if (!Array.isArray(row) || row.length === 0) {
        return `reply keyboard row ${r} is empty`;
      }
    }
    return undefined;
  }
  // inline
  if (!Array.isArray(keyboard.buttons) || keyboard.buttons.length === 0) {
    return 'inline keyboard has no rows';
  }
  for (let r = 0; r < keyboard.buttons.length; r += 1) {
    const row = keyboard.buttons[r];
    if (!Array.isArray(row) || row.length === 0) {
      return `inline keyboard row ${r} is empty`;
    }
  }
  return undefined;
}

// ─── GI-06 uuids-normalized ───────────────────────────────────────────────────

/**
 * Recorded expectations must go through `normalizeUuids` (or equivalent)
 * so that the non-deterministic UUIDs produced by `uuid.v4()` at plan
 * creation time don't leak into the golden transcript. A stray raw UUID
 * signals a normalization path was skipped.
 */
function invariantUuidsNormalized(recorded: RecordedScenario): InvariantResult {
  const id = 'GI-06-uuids-normalized';
  const serialized = JSON.stringify(recorded.expected);
  const match = UUID_RE.exec(serialized);
  if (match) {
    const start = Math.max(0, match.index - 40);
    const context = serialized.slice(start, match.index + 120);
    return {
      id,
      passed: false,
      message: `raw UUID in recorded.expected near: …${context}…`,
    };
  }
  return { id, passed: true };
}
