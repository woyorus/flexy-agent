/**
 * Clock-freeze utility for scenario replay.
 *
 * Monkey-patches the global `Date` so every `Date.now()` and `new Date()`
 * call inside core logic returns the scenario's fixed timestamp. This is
 * load-bearing: prompts contain date references like `THIS WEEK: 2026-04-06
 * to 2026-04-12` generated from `new Date()`, and if that drifts between
 * record and replay the fixture hashes miss.
 *
 * ## Scope of the patch
 *
 * `Date.now()` is replaced to return the fixed epoch.
 *
 * The `Date` constructor is replaced with a proxy that:
 *   - `new Date()` (zero args) → the fixed instant
 *   - `new Date(arg)` (any args) → a normal Date with those args
 *   - `Date.now()` (static) → the fixed epoch
 *   - `Date.UTC`, `Date.parse`, `Date.prototype.*` → delegated unchanged
 *
 * `setTimeout`, `setInterval`, and `performance.now` are left alone — they
 * aren't calendar-based and the bot's async flow depends on them working
 * normally.
 *
 * ## Process-global, not re-entrant
 *
 * This is the one remaining blocker on scenario parallelism: the patch
 * mutates a process-wide global, so two scenarios running concurrently
 * would clobber each other's clocks. Scenarios therefore run serially in
 * `test/scenarios.test.ts` via a plain `for` loop. See the "serial
 * execution" decision in plan 006 for the rationale and the path to
 * eliminating this restriction (AsyncLocalStorage or worker-thread
 * sandboxing) if it ever becomes a bottleneck.
 *
 * The utility is always used with a `try/finally` so that a scenario
 * failing (thrown error) still restores the real `Date` before any
 * subsequent test runs.
 */

/**
 * Handle returned by `freezeClock`. Call `.restore()` to put the real
 * `Date` back — MUST be called in a `finally` block so the clock is
 * restored even if the scenario body throws.
 */
export interface FrozenClock {
  /** Restore the original global Date. Idempotent. */
  restore(): void;
}

/**
 * Freeze the global clock at the given instant.
 *
 * @param iso - An ISO-8601 timestamp string. Must parse via `Date.parse`.
 * @throws if the string isn't a valid timestamp, so the scenario fails
 *         loudly at setup rather than producing garbled prompts.
 */
export function freezeClock(iso: string): FrozenClock {
  const frozen = Date.parse(iso);
  if (Number.isNaN(frozen)) {
    throw new Error(`freezeClock: "${iso}" is not a valid ISO timestamp`);
  }

  const RealDate = globalThis.Date;
  let restored = false;

  // Constructor proxy. `new Date()` returns a RealDate pointing at the
  // frozen instant; every other form delegates to RealDate unchanged.
  // We reassign `globalThis.Date` to this proxy for the duration of the
  // scenario, then put RealDate back in `restore()`.
  const FrozenDate = function (this: unknown, ...args: unknown[]) {
    if (args.length === 0) {
      // new Date() — frozen
      return new RealDate(frozen);
    }
    // new Date(arg[, ...]) — delegate to the real constructor. We can't
    // spread into `new RealDate(...args)` with full type safety, so we
    // switch on arity (matches the Date constructor's declared overloads).
    switch (args.length) {
      case 1:
        return new RealDate(args[0] as number | string | Date);
      case 2:
        return new RealDate(args[0] as number, args[1] as number);
      case 3:
        return new RealDate(args[0] as number, args[1] as number, args[2] as number);
      case 4:
        return new RealDate(
          args[0] as number,
          args[1] as number,
          args[2] as number,
          args[3] as number,
        );
      case 5:
        return new RealDate(
          args[0] as number,
          args[1] as number,
          args[2] as number,
          args[3] as number,
          args[4] as number,
        );
      case 6:
        return new RealDate(
          args[0] as number,
          args[1] as number,
          args[2] as number,
          args[3] as number,
          args[4] as number,
          args[5] as number,
        );
      default:
        return new RealDate(
          args[0] as number,
          args[1] as number,
          args[2] as number,
          args[3] as number,
          args[4] as number,
          args[5] as number,
          args[6] as number,
        );
    }
  } as unknown as DateConstructor;

  // Share the real Date prototype so `instanceof Date` still works and
  // every method (`.toISOString()`, `.getTime()`, etc.) lives on real
  // Date instances returned from the constructor proxy. `prototype` on a
  // function object is read-only under strict mode, so we use
  // Object.defineProperty to set it. Static members (`UTC`, `parse`) are
  // inherited via setPrototypeOf; `now` is the only one we override.
  Object.setPrototypeOf(FrozenDate, RealDate);
  Object.defineProperty(FrozenDate, 'prototype', {
    value: RealDate.prototype,
    writable: false,
  });
  FrozenDate.now = () => frozen;

  globalThis.Date = FrozenDate;

  return {
    restore() {
      if (restored) return;
      globalThis.Date = RealDate;
      restored = true;
    },
  };
}
