/**
 * Telegram MarkdownV2 escape utility.
 *
 * Telegram's MarkdownV2 parse mode requires escaping a specific set of reserved
 * characters. This utility is used to safely interpolate dynamic user content
 * (recipe names, event descriptions, etc.) into MarkdownV2-formatted messages.
 *
 * Usage: wrap any dynamic string with `esc()` before embedding it in a
 * MarkdownV2 template. Literal formatting tokens (`*`, `_`, etc.) in the
 * template itself must NOT be escaped — only interpolated values.
 */

/**
 * Reserved characters in Telegram MarkdownV2.
 * Backslash MUST be escaped first to avoid double-escaping.
 */
const RESERVED = ['\\', '_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];

/**
 * Escape a string for safe use inside a Telegram MarkdownV2 message.
 *
 * Backslash is escaped first (as `\\`) so that subsequent character escapes
 * don't produce `\\X` sequences.
 *
 * @param text - The raw string to escape
 * @returns The escaped string safe for MarkdownV2
 */
export function escapeMarkdownV2(text: string): string {
  let result = text;
  for (const char of RESERVED) {
    result = result.split(char).join('\\' + char);
  }
  return result;
}

/** Short alias for escapeMarkdownV2, used in template expressions. */
export const esc = escapeMarkdownV2;

/**
 * Escape a recipe body for MarkdownV2, converting `**bold**` (GitHub-style)
 * to Telegram MarkdownV2 `*bold*` while escaping all other reserved chars.
 *
 * LLM-generated recipe bodies use `**1 min**` for cooking times. Naive
 * `esc()` would turn those into literal `\*\*1 min\*\*`. This function
 * splits on bold markers, escapes the parts, and reassembles with single
 * asterisks that MarkdownV2 interprets as bold.
 */
export function escapeRecipeBody(body: string): string {
  const parts = body.split(/(\*\*[^*]+?\*\*)/g);
  return parts.map(part => {
    const boldMatch = part.match(/^\*\*(.+)\*\*$/);
    if (boldMatch) {
      return `*${esc(boldMatch[1]!)}*`;
    }
    return esc(part);
  }).join('');
}
