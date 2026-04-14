/**
 * Runtime execution trace primitives for the behavioral certification harness.
 *
 * Plan 031 introduces a tiny observability surface inside `BotCore` and
 * surrounding modules: each handler entry, dispatcher decision, validator
 * retry, and store mutation emits a `TraceEvent`. The harness wires a
 * `HarnessTraceCollector` to those emissions; production (`grammY` adapter)
 * does not pass an `onTrace` callback, so emission is a no-op.
 *
 * The trace is a RUNTIME-only surface: it is NOT persisted to
 * `recorded.json` and NOT compared via `deepStrictEqual`. It is available
 * to `assertBehavior(ctx)` via `ctx.execTrace` and to the `npm run review`
 * probe report.
 */

/**
 * A single observable event emitted during dispatch. The tagged union keeps
 * each variant specific; assertions pattern-match against `kind` to pull
 * out the fields they care about.
 */
export type TraceEvent =
  | { kind: 'handler'; name: string }
  | { kind: 'dispatcher'; action: string; params?: unknown }
  | { kind: 'retry'; validator: string; attempt: number; errors: string[] }
  | { kind: 'persist'; op: string; argSummary?: string }
  | {
      /**
       * Emergency ingredient swap observability (Plan 033). `op` names the
       * applier / pre-filter step so scenario assertions can verify the
       * swap followed the expected path (e.g., prefilter_confirm vs
       * dispatched-agent apply). `targetId` is the batch id or the literal
       * `'breakfast'` sentinel; `reason` only appears on preview outcomes
       * and surfaces why the agent asked first.
       */
      kind: 'swap';
      op:
        | 'apply'
        | 'preview'
        | 'help_me_pick'
        | 'clarification'
        | 'hard_no'
        | 'prefilter_confirm'
        | 'prefilter_cancel'
        | 'prefilter_pick';
      targetId?: string;
      reason?: string;
    };

/**
 * Grouped view over the event sequence. Order is preserved within each
 * group (i.e. `handlers[0]` is the first handler event emitted).
 */
export interface ExecTrace {
  readonly handlers: readonly string[];
  readonly dispatcherActions: readonly { action: string; params?: unknown }[];
  readonly validatorRetries: readonly { validator: string; attempt: number; errors: string[] }[];
  readonly persistenceOps: readonly { op: string; argSummary?: string }[];
  /** Plan 033: ordered swap-related events — applier decisions + pre-filter branches. */
  readonly swapOps: readonly { op: string; targetId?: string; reason?: string }[];
}

/**
 * Thin accumulator that the runner attaches to `BotCoreDeps.onTrace`.
 * `record` is bound so the caller can pass it as a plain function reference
 * without worrying about `this`. `summarize()` returns the grouped view
 * used by assertions and the review CLI.
 */
export class HarnessTraceCollector {
  private events: TraceEvent[] = [];

  record = (event: TraceEvent): void => {
    this.events.push(event);
  };

  summarize(): ExecTrace {
    const handlers: string[] = [];
    const dispatcherActions: { action: string; params?: unknown }[] = [];
    const validatorRetries: { validator: string; attempt: number; errors: string[] }[] = [];
    const persistenceOps: { op: string; argSummary?: string }[] = [];
    const swapOps: { op: string; targetId?: string; reason?: string }[] = [];
    for (const e of this.events) {
      switch (e.kind) {
        case 'handler':
          handlers.push(e.name);
          break;
        case 'dispatcher':
          dispatcherActions.push({ action: e.action, params: e.params });
          break;
        case 'retry':
          validatorRetries.push({ validator: e.validator, attempt: e.attempt, errors: e.errors });
          break;
        case 'persist':
          persistenceOps.push({ op: e.op, argSummary: e.argSummary });
          break;
        case 'swap':
          swapOps.push({ op: e.op, targetId: e.targetId, reason: e.reason });
          break;
      }
    }
    return { handlers, dispatcherActions, validatorRetries, persistenceOps, swapOps };
  }
}
