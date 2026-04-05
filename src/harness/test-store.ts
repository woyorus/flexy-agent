/**
 * In-memory `StateStoreLike` implementation for the scenario harness.
 *
 * Acts as a drop-in replacement for the Supabase-backed `StateStore` during
 * test runs. Production code (`BotCore`) depends on `StateStoreLike`, so the
 * substitution is type-safe with zero production changes.
 *
 * The whole point of a test double at the persistence layer is that the
 * harness can assert on the final store state — not just captured Telegram
 * output. The plan-approval flow calls `completeActivePlans()` and
 * `savePlan()` as load-bearing side effects; a bug that produces a correct
 * transcript but skips persistence would slip past a transcript-only check.
 * `snapshot()` exposes the full internal state for that kind of assertion.
 *
 * ## Filter semantics must match production exactly
 *
 * Every query method here mirrors the equivalent `StateStore` SQL predicate
 * verbatim, with a cross-reference comment pointing at the production line
 * it shadows. Any drift (e.g. this class only tracks `'active'` while
 * production filters on `['active', 'planning']`) would silently invalidate
 * scenarios touching in-progress plans. Code review catches the drift via
 * the comments; the unit test suite in `test-store.test.ts` catches it via
 * behavioral assertions against known seed data.
 */

import type { WeeklyPlan } from '../models/types.js';
import type { SessionState } from '../state/machine.js';
import type { StateStoreLike } from '../state/store.js';

export interface TestStateStoreSeed {
  /** Pre-existing plans. Order is irrelevant — queries sort. */
  plans?: WeeklyPlan[];
  /** Pre-existing session slot. v0.0.1 has one session per single user. */
  session?: SessionState | null;
}

export interface TestStateStoreSnapshot {
  /** Every plan the store currently holds, in insertion order (stable). */
  plans: WeeklyPlan[];
  /** Result of `getCurrentPlan()` at the moment of snapshot. */
  currentPlan: WeeklyPlan | null;
  /** Current session slot, or null if never written. */
  session: SessionState | null;
}

/**
 * In-memory state store for scenario replay. `implements StateStoreLike`
 * makes TypeScript enforce signature parity with production.
 */
export class TestStateStore implements StateStoreLike {
  /** Keyed by plan.id so `savePlan` can upsert; iteration order = insertion order. */
  private readonly plansById: Map<string, WeeklyPlan>;
  private session: SessionState | null;

  constructor(seed: TestStateStoreSeed = {}) {
    this.plansById = new Map();
    if (seed.plans) {
      for (const plan of seed.plans) {
        // Deep clone to isolate scenario seed data from harness mutations.
        this.plansById.set(plan.id, cloneDeep(plan));
      }
    }
    this.session = seed.session ? cloneDeep(seed.session) : null;
  }

  // ─── Mutations ─────────────────────────────────────────────────────────

  /**
   * Upsert a plan by id. Deep-clones the incoming object so the harness
   * owns an isolated copy — the caller is free to keep mutating the
   * original without affecting stored state, matching Supabase's
   * copy-on-insert semantics.
   *
   * Mirrors `StateStore.savePlan` at `src/state/store.ts:38-51`.
   */
  async savePlan(plan: WeeklyPlan): Promise<void> {
    this.plansById.set(plan.id, cloneDeep(plan));
  }

  /**
   * Flip every plan with `status === 'active'` to `'completed'`.
   * Mirrors `StateStore.completeActivePlans` at `src/state/store.ts:124-134`.
   *
   * Note: production only flips `'active'` (not `'planning'`); this class
   * must match that exactly so scenarios with an in-progress plan during
   * approval see the same semantics they'd see in prod.
   */
  async completeActivePlans(): Promise<void> {
    for (const plan of this.plansById.values()) {
      if (plan.status === 'active') {
        plan.status = 'completed';
        plan.updatedAt = new Date().toISOString();
      }
    }
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  /**
   * Most recent plan with `status in ['active', 'planning']` by `weekStart`
   * descending. Mirrors `StateStore.getCurrentPlan` at
   * `src/state/store.ts:70-82` — note the dual-status filter, NOT just
   * `'active'`. A test store that only tracked `'active'` would diverge on
   * any scenario involving an in-progress plan.
   */
  async getCurrentPlan(): Promise<WeeklyPlan | null> {
    const candidates = [...this.plansById.values()].filter(
      (p) => p.status === 'active' || p.status === 'planning',
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0));
    return cloneDeep(candidates[0]!);
  }

  /**
   * Most recent `status === 'completed'` plan by `weekStart` descending.
   * Mirrors `StateStore.getLastCompletedPlan` at `src/state/store.ts:87-99`.
   */
  async getLastCompletedPlan(): Promise<WeeklyPlan | null> {
    const candidates = [...this.plansById.values()].filter((p) => p.status === 'completed');
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0));
    return cloneDeep(candidates[0]!);
  }

  /**
   * Up to `limit` most recent completed plans, `weekStart` descending.
   * Mirrors `StateStore.getRecentCompletedPlans` at
   * `src/state/store.ts:107-118`. Default limit matches production (2).
   */
  async getRecentCompletedPlans(limit: number = 2): Promise<WeeklyPlan[]> {
    const candidates = [...this.plansById.values()].filter((p) => p.status === 'completed');
    candidates.sort((a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0));
    return candidates.slice(0, limit).map(cloneDeep);
  }

  // ─── Harness introspection ─────────────────────────────────────────────

  /**
   * Return the full internal state for assertions. The harness runner calls
   * this at the end of each scenario and asserts the result matches the
   * recorded `expected.finalStore`. Deep-cloned so test code can hold onto
   * the snapshot without observing subsequent mutations.
   *
   * `currentPlan` re-runs `getCurrentPlan()`'s filter so assertions against
   * the snapshot match production query behavior exactly.
   */
  snapshot(): TestStateStoreSnapshot {
    const allPlans = [...this.plansById.values()].map(cloneDeep);
    const currentCandidates = [...this.plansById.values()].filter(
      (p) => p.status === 'active' || p.status === 'planning',
    );
    currentCandidates.sort((a, b) =>
      a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0,
    );
    return {
      plans: allPlans,
      currentPlan: currentCandidates[0] ? cloneDeep(currentCandidates[0]) : null,
      session: this.session ? cloneDeep(this.session) : null,
    };
  }
}

/**
 * Structured deep clone. Uses Node's built-in `structuredClone` (available
 * on Node 17+), which handles `Date`, `Map`, nested objects, and arrays.
 * Keeps stored data immune to caller mutations without pulling in lodash.
 */
function cloneDeep<T>(value: T): T {
  return structuredClone(value);
}
