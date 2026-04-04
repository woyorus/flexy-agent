/**
 * Centralized debug logging facility for Flexie.
 *
 * Designed for the developer workflow: user tests the bot → sees an issue →
 * discusses with Claude → Claude reads `logs/debug.log` to get full context.
 *
 * All events (Telegram messages, AI calls, state transitions, validations)
 * are logged chronologically to a single file with structured tags.
 * The file is append-only — a single separator line marks each restart.
 * Boot-sequence messages go to stdout only (not the log file) to avoid
 * noise from hot-reload restarts.
 *
 * When DEBUG=1, also outputs verbose logs to console and appends a one-line
 * debug footer to Telegram messages showing AI models used and timing.
 *
 * Log file: logs/debug.log
 *
 * Tags:
 * - BOOT    — startup sequence
 * - TG:IN   — incoming Telegram message or callback
 * - TG:OUT  — outgoing Telegram message (full text logged to file)
 * - AI:REQ  — AI completion request (model, reasoning, prompt content)
 * - AI:RES  — AI completion response (content, tokens, duration)
 * - AI:STT  — speech-to-text transcription
 * - FLOW    — recipe flow / state machine transitions
 * - QA      — QA validation results
 * - DB      — recipe database operations
 * - WARN    — warnings
 * - ERROR   — errors
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LOGS_DIR = join(process.cwd(), 'logs');
const LOG_FILE = join(LOGS_DIR, 'debug.log');

let debugMode = false;
let initialized = false;

/** Operation tracking for Telegram debug footers. */
let operationEvents: string[] = [];
let operationStart: number = Date.now();

/**
 * Initialize the logger. Call once at startup before any logging.
 * Creates the logs directory and appends a one-line restart marker to the log file.
 * The verbose boot banner goes to stdout only — the log file stays clean across
 * hot-reload restarts.
 *
 * @param debug - Whether debug mode is enabled (from DEBUG env var)
 */
export function initLogger(debug: boolean): void {
  debugMode = debug;
  mkdirSync(LOGS_DIR, { recursive: true });

  appendFileSync(LOG_FILE, '', 'utf-8'); // ensure file exists
  initialized = true;
}

/** Whether debug mode is enabled. */
export function isDebug(): boolean {
  return debugMode;
}

/** Format current time as HH:MM:SS.mmm */
function timestamp(): string {
  const now = new Date();
  return (
    now.toTimeString().slice(0, 8) +
    '.' +
    String(now.getMilliseconds()).padStart(3, '0')
  );
}

/** Append a line to the log file. Silently ignores write failures. */
function writeLine(line: string): void {
  if (!initialized) return;
  try {
    appendFileSync(LOG_FILE, line + '\n', 'utf-8');
  } catch {
    // Don't crash the app on log write failure
  }
}

/**
 * Log a boot/startup message. Stdout only — not written to the log file.
 * Use for startup-sequence info that's useful during development but would
 * just be noise in the debug log (especially with hot-reload restarts).
 */
export function boot(message: string): void {
  console.log(`[${timestamp()}] [BOOT] ${message}`);
}

/**
 * Log a debug-level message.
 * Console: only in debug mode. File: always.
 *
 * @param tag - Log tag (e.g., 'FLOW', 'AI:REQ')
 * @param message - Main log line
 * @param data - Optional extra data logged on a separate line (string or object)
 */
export function debug(tag: string, message: string, data?: unknown): void {
  const line = `[${timestamp()}] [${tag}] ${message}`;
  if (debugMode) console.log(line);
  if (data !== undefined) {
    const dataStr =
      typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    writeLine(`${line}\n${dataStr}`);
  } else {
    writeLine(line);
  }
}

/**
 * Log an info-level message.
 * Console: always. File: always.
 */
export function info(tag: string, message: string): void {
  const line = `[${timestamp()}] [${tag}] ${message}`;
  console.log(line);
  writeLine(line);
}

/**
 * Log a warning.
 * Console: always. File: always.
 */
export function warn(tag: string, message: string): void {
  const line = `[${timestamp()}] [${tag}] ${message}`;
  console.warn(line);
  writeLine(line);
}

/**
 * Log an error with optional error object.
 * Console: always (with stack trace). File: always (with stack trace).
 */
export function error(tag: string, message: string, err?: unknown): void {
  const line = `[${timestamp()}] [ERROR:${tag}] ${message}`;
  console.error(line);
  if (err instanceof Error) {
    console.error(err);
    writeLine(`${line}\n${err.stack ?? err.message}`);
  } else if (err !== undefined) {
    console.error(err);
    writeLine(`${line}\n${String(err)}`);
  } else {
    writeLine(line);
  }
}

/**
 * Log an incoming Telegram message or callback.
 * Console: always (compact). File: always.
 */
export function telegramIn(type: string, data: string): void {
  const line = `[${timestamp()}] [TG:IN] ${type}: ${data}`;
  console.log(line);
  writeLine(line);
}

/**
 * Log an outgoing Telegram message.
 * Console: debug mode only (preview). File: always (full text + buttons).
 *
 * @param text - The message text
 * @param buttons - Optional button rows (each row is an array of button labels).
 *   Rendered in the log file as `[Label1] [Label2]` per row so the full
 *   reply context is visible when debugging.
 */
export function telegramOut(text: string, buttons?: string[][]): void {
  const preview =
    text.length > 150 ? text.slice(0, 150).replace(/\n/g, '\\n') + '...' : text.replace(/\n/g, '\\n');
  if (debugMode) console.log(`[${timestamp()}] [TG:OUT] ${preview}`);
  let entry = `[${timestamp()}] [TG:OUT]\n${text}`;
  if (buttons && buttons.length > 0) {
    const rendered = buttons.map((row) => '  ' + row.map((b) => `[${b}]`).join(' ')).join('\n');
    entry += `\n${rendered}`;
  }
  writeLine(`${entry}\n${'─'.repeat(40)}`);
}

/**
 * Start tracking a user-facing operation for the Telegram debug footer.
 * Call this before processing an incoming message that will trigger AI calls.
 * Resets the operation events and starts the timer.
 */
export function startOperation(): void {
  operationEvents = [];
  operationStart = Date.now();
}

/**
 * Record an event in the current operation (for the Telegram debug footer).
 * Called by the AI layer and flow handlers to track what happened.
 *
 * @param event - Short description, e.g., "primary/high 3.4s 2300tok"
 */
export function addOperationEvent(event: string): void {
  operationEvents.push(event);
}

/**
 * Get a debug footer string to append to a Telegram message.
 * Returns empty string if debug mode is off or no operation events were recorded.
 * Clears the operation events after reading.
 *
 * @returns Footer string like "\n\n─── debug: primary/high 3.4s → correction 1 | total 4.8s"
 */
export function getDebugFooter(): string {
  if (!debugMode || operationEvents.length === 0) return '';
  const elapsed = ((Date.now() - operationStart) / 1000).toFixed(1);
  const events = operationEvents.join(' → ');
  operationEvents = [];
  return `\n\n─── debug: ${events} | total ${elapsed}s`;
}

/**
 * Convenience namespace for all logger functions.
 * Import as: import { log } from '../debug/logger.js';
 */
export const log = {
  init: initLogger,
  isDebug,
  boot,
  debug,
  info,
  warn,
  error,
  telegramIn,
  telegramOut,
  startOperation,
  addOperationEvent,
  getDebugFooter,
};
