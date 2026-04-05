/**
 * Deterministic normalization of non-deterministic values in captured
 * scenario output.
 *
 * The plan-approval flow generates UUIDs (via the `uuid` package) for
 * batch ids and meal slot ids. Those IDs surface in the captured session
 * snapshot, the persisted plan, and the solver's `cookingSchedule` /
 * `dailyBreakdown` cross-references. Every run produces fresh UUIDs, so a
 * raw `deepStrictEqual` against a recorded fixture fails on UUID drift
 * even when the logic is unchanged.
 *
 * The alternative — patching `crypto.randomUUID` at scenario start to
 * return deterministic bytes — is invasive because the uuid package
 * captures a reference to `crypto.randomUUID` at module-load time. We
 * can't monkey-patch after the fact without intercepting the module loader.
 *
 * Normalization is simpler and has two secondary benefits:
 *   1. Recorded JSON uses human-readable placeholder tokens
 *      (`{{uuid:0}}`, `{{uuid:1}}`, ...) that diff much more clearly than
 *      random hex strings.
 *   2. The relationship between IDs is preserved — the same UUID appearing
 *      twice in the data gets the same placeholder both times. A bug that
 *      swaps cross-references (e.g., dailyBreakdown points at the wrong
 *      batch) still fires because the placeholder relationship diverges.
 *
 * ## Why in-order deterministic mapping works
 *
 * `normalizeUuids` walks the value with a stable traversal order (object
 * keys via `Object.entries`, arrays by index). On every run the UUIDs are
 * encountered in the same structural positions, so the first encountered
 * UUID becomes `{{uuid:0}}`, the second `{{uuid:1}}`, etc. Cross-references
 * land on the same placeholder because we memoize by the actual UUID
 * string. Result: two runs with semantically-identical output produce
 * byte-identical normalized output.
 */

/**
 * Match any canonical v1-v5 UUID string. The hex ranges are loose enough
 * to catch everything `uuid.v4()` produces (which sets the version nibble
 * to 4 and the variant nibbles to 8-b) and also accommodates values from
 * `crypto.randomUUID()` directly.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Walk `value` depth-first and replace every UUID string with a stable
 * placeholder token. Memoizes mappings so the same UUID appearing in
 * multiple positions gets the same token. Non-UUID strings, numbers,
 * booleans, null, and undefined are passed through unchanged.
 *
 * The function does not mutate `value` — it constructs a fresh tree.
 * Callers can feed the result directly into `JSON.stringify` or
 * `deepStrictEqual` without worrying about shared references.
 */
export function normalizeUuids<T>(value: T): T {
  const mapping = new Map<string, string>();
  let counter = 0;

  function walk(v: unknown): unknown {
    if (typeof v === 'string') {
      if (UUID_RE.test(v)) {
        let placeholder = mapping.get(v);
        if (!placeholder) {
          placeholder = `{{uuid:${counter++}}}`;
          mapping.set(v, placeholder);
        }
        return placeholder;
      }
      return v;
    }
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  }

  return walk(value) as T;
}
