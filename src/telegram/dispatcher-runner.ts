/**
 * Dispatcher runner — the integration layer between the pure dispatcher LLM
 * agent (`src/agents/dispatcher.ts`) and the telegram core (`src/telegram/core.ts`).
 *
 * Plan 028 (Plan C from proposal 003-freeform-conversation-layer.md). The runner
 * owns everything that touches `BotCoreSession`: context assembly, action
 * handler dispatch, recent-turns bookkeeping, and the numeric pre-filter for
 * the progress measurement fast path. The pure agent module has no knowledge
 * of session state — it takes a context bundle in and returns a decision out.
 * Keeping the two layers separate means the agent is unit-testable against
 * plain objects and the runner is unit-testable against a fake LLM.
 *
 * This file grows across Task 2 (this file's initial shape), Task 8 (context
 * assembly + action handlers), and Task 10 (return_to_flow re-render helper).
 */

/**
 * A single conversation exchange. Written into `session.recentTurns` by the
 * runner around each dispatcher call, and read back by the runner when it
 * builds the next context bundle.
 *
 * - `role: 'user'` — the inbound message the dispatcher is about to classify
 *   OR just classified.
 * - `role: 'bot'` — the LAST reply the bot produced for this turn. Captured
 *   by `wrapSinkForBotTurnCapture` (Task 8) so it covers ALL action branches
 *   uniformly: dispatcher-authored replies (`clarify`, `out_of_scope`),
 *   re-rendered views (`return_to_flow`), AND downstream flow-handler
 *   replies (`flow_input` → re-proposer output, recipe-flow refinements,
 *   etc.). The proposal 003 context-hydration contract (line 257) calls
 *   for "last 3–5 user/bot exchanges"; recording bot turns from every
 *   branch is what makes that contract real for multi-turn threads like
 *   "what about the lamb?" right after a re-proposer reply that mentioned
 *   lamb.
 *
 *   The wrapper buffers each `sink.reply` and **overwrites** the previous
 *   capture, then commits the most recent one via `flushBotTurn` from a
 *   `try/finally` in the runner. This is what handles the recipe-flow
 *   pattern of `sink.reply('Generating your recipe...')` followed by the
 *   actual rendered recipe — a "first reply wins" policy would record the
 *   holding message and miss the substance, breaking referential threads.
 *
 *   Bot-turn text is truncated to `BOT_TURN_TEXT_MAX` chars at capture
 *   time (before `pushTurn`) so a long MarkdownV2 recipe body doesn't
 *   bloat the in-memory ring buffer or the next dispatcher prompt. The
 *   head of the reply is enough to resolve referential threads — the
 *   dispatcher already has full flow state via `planFlow`/`recipeFlow`
 *   summaries for anything it needs beyond the head.
 *
 * `at` is an ISO timestamp stamped when the turn is pushed; used for debug
 * logging and for expiring very-old turns if that becomes necessary later.
 */
export interface ConversationTurn {
  role: 'user' | 'bot';
  text: string;
  at: string;
}

/**
 * Ring-buffer cap for `session.recentTurns`. The dispatcher's context bundle
 * includes the last `RECENT_TURNS_MAX` turns verbatim. 6 = three user+bot
 * pairs, which the proposal document calls out as "last 3–5 user/bot
 * exchanges". At mini-tier prices, 6 short turns is a trivial prompt-size
 * contribution (~200 tokens) and buys enough context to follow referential
 * threads.
 */
export const RECENT_TURNS_MAX = 6;

/**
 * Truncation cap for bot-turn text captured by `wrapSinkForBotTurnCapture`
 * (Task 8). A long MarkdownV2 recipe body or a full plan proposal can be
 * several thousand characters; storing the full text in the in-memory ring
 * buffer is wasteful and inflates the next dispatcher prompt. 500 chars is
 * enough for the head of a reply to anchor referential threads — the
 * dispatcher already has `planFlow`/`recipeFlow` summaries for anything it
 * needs beyond the head. Truncation is applied at capture time, before
 * `pushTurn`, so the ring buffer never holds oversized entries.
 */
export const BOT_TURN_TEXT_MAX = 500;

/**
 * Append a turn to `session.recentTurns` in place, keeping at most
 * `RECENT_TURNS_MAX` items. The oldest turn is dropped when the buffer is
 * full.
 *
 * Mutates the session. Intentionally not pure so the runner can call it
 * without having to thread the array around.
 *
 * @param session - Any object carrying an optional
 *                  `recentTurns?: ConversationTurn[]` field. The helper
 *                  initializes the field to `[]` on first write, so callers
 *                  never have to check for undefined. Structurally typed so
 *                  unit tests can pass plain objects.
 * @param role - 'user' or 'bot' — see `ConversationTurn` doc.
 * @param text - Exact message body. Long messages are NOT truncated here;
 *               the context-bundle builder applies its own truncation when
 *               it serializes for the LLM prompt (Task 8).
 */
export function pushTurn(
  session: { recentTurns?: ConversationTurn[] },
  role: 'user' | 'bot',
  text: string,
): void {
  if (!session.recentTurns) {
    session.recentTurns = [];
  }
  session.recentTurns.push({
    role,
    text,
    at: new Date().toISOString(),
  });
  while (session.recentTurns.length > RECENT_TURNS_MAX) {
    session.recentTurns.shift();
  }
}
