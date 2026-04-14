/**
 * Delta-line formatters + guardrail helpers for the emergency ingredient
 * swap flow (Plan 033 / design doc 006).
 *
 * The agent emits pre-formatted `delta_lines` strings in its response, but
 * the applier defensively computes its own line set from the `SwapChange[]`
 * array so the rendered footer is never blank and the formatting stays
 * consistent even when the agent's delta_lines disagree with its changes.
 * The formatters are also reused by the fixture-edited guardrail validator
 * (Phase 10.6) — when the LLM response has a helper ingredient in
 * `scaled_ingredients` but fails to mention it in `delta_lines`, the
 * applier can regenerate the line from the diff rather than rejecting the
 * whole swap.
 *
 * Also exposes `PANTRY_STAPLES` — the canonical set the guardrail
 * validator uses to decide whether a mutated ingredient is a "precisely-
 * bought" item (which would be a hard invariant violation unless the
 * user explicitly named it).
 */

import type { SwapChange, ScaledIngredient, SwapRecord } from '../models/types.js';

/**
 * A pair of replacement endpoints — e.g. the `from` and `to` of a
 * `replace` change, or the `ingredient` of a `remove` / `add`. Used by
 * the guardrail validator to give the agent's own `changes` array
 * authority over "is this ingredient name explainable in the diff" —
 * when the agent explicitly declares `replace cottage cheese → ricotta`,
 * the validator should not also require the user to have typed
 * "cottage cheese" verbatim. The agent's change IS the explanation.
 */
interface ChangeEndpoints {
  readonly introduced: ReadonlySet<string>;
  readonly removed: ReadonlySet<string>;
}

function endpointsOf(changes: ReadonlyArray<SwapChange> | undefined): ChangeEndpoints {
  const introduced = new Set<string>();
  const removed = new Set<string>();
  if (!changes) return { introduced, removed };
  for (const c of changes) {
    if (c.kind === 'replace') {
      removed.add(c.from.toLowerCase());
      introduced.add(c.to.toLowerCase());
    } else if (c.kind === 'remove') {
      removed.add(c.ingredient.toLowerCase());
    } else if (c.kind === 'add') {
      introduced.add(c.ingredient.toLowerCase());
    } else if (c.kind === 'rebalance') {
      // rebalance keeps the ingredient — not an introduce or a remove
    }
  }
  return { introduced, removed };
}

/**
 * Canonical pantry-staple set. Mirrors the definition in the swap agent's
 * system prompt (src/agents/ingredient-swap.ts) so the guardrail validator
 * and the agent stay aligned. Lower-case; match via substring containment
 * against `ingredient.name.toLowerCase()`.
 */
export const PANTRY_STAPLES: readonly string[] = [
  'oil', 'olive oil', 'butter', 'ghee', 'salt', 'pepper', 'stock', 'broth',
  'vinegar', 'lemon juice', 'lime juice', 'acid', 'herb', 'parsley', 'basil',
  'cilantro', 'thyme', 'rosemary', 'spice', 'cumin', 'paprika', 'chili',
  'sugar', 'honey', 'milk', 'cream', 'yogurt', 'garlic', 'onion', 'water',
  'wine', 'soy sauce', 'mustard', 'mayo', 'mayonnaise', 'tomato paste',
  'flour',
];

/**
 * Returns true when `name` contains a pantry-staple substring. Used by
 * the guardrail validator to classify whether a diff-introduced
 * ingredient needed to be explicitly named by the user (precisely-bought,
 * hard invariant) or is a free-to-flex pantry item.
 */
export function isPantryStaple(name: string): boolean {
  const lower = name.toLowerCase();
  return PANTRY_STAPLES.some((staple) => lower.includes(staple));
}

/**
 * Pre-formatted delta line for a single SwapChange. Matches the proposal
 * screens verbatim: "Swapped: X → Y", "Removed: Z", "Rebalanced: …".
 */
export function formatSwapChange(change: SwapChange): string {
  switch (change.kind) {
    case 'replace':
      return `Swapped: ${change.from} (${formatAmount(change.fromAmount, change.fromUnit)}) → ${change.to} (${formatAmount(change.toAmount, change.toUnit)})`;
    case 'remove':
      return `Removed: ${change.ingredient} (${formatAmount(change.amount, change.unit)})`;
    case 'add':
      return `+ ${change.ingredient} (${formatAmount(change.amount, change.unit)})`;
    case 'rebalance':
      return `Rebalanced: ${change.ingredient} ${formatAmount(change.fromAmount, change.unit)} → ${formatAmount(change.toAmount, change.unit)}`;
    case 'rename':
      return `Renamed: "${change.from}" → "${change.to}"`;
  }
}

/** Compact "Xunit" — "200g", "1tbsp" — matches the proposal's terse screens. */
function formatAmount(amount: number, unit: string): string {
  // Keep one decimal place only when it matters.
  const rounded = Math.round(amount * 10) / 10;
  const display = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${display}${unit}`;
}

/**
 * Macro-delta line. Inside the noise band emits a calm reassurance;
 * outside, prints the gap honestly. Used by the applier when the agent
 * omitted a macro line from delta_lines (defense-in-depth on the prompt
 * contract).
 */
export function formatMacroDelta(args: {
  beforeCalories: number;
  afterCalories: number;
  afterProtein: number;
  targetCalories: number;
  noisePctOfTarget: number;
  perUnit: 'serving' | 'day';
}): string {
  const { beforeCalories, afterCalories, afterProtein, targetCalories, noisePctOfTarget, perUnit } = args;
  const diff = Math.round(afterCalories - beforeCalories);
  const noiseBand = Math.round((targetCalories * noisePctOfTarget) / 100);
  const driftFromTarget = Math.abs(afterCalories - targetCalories);
  if (driftFromTarget <= noiseBand) {
    const sign = diff === 0 ? '±0' : diff > 0 ? `+${diff}` : `${diff}`;
    return `Macros: ${sign} cal/${perUnit} — within noise.`;
  }
  return `Macros: ${Math.round(afterCalories)} cal / ${Math.round(afterProtein)}g protein per ${perUnit} — ${afterCalories > targetCalories ? 'above' : 'below'} target.`;
}

/**
 * Guardrail validator for the agent's proposed ingredient list (Plan 10.6).
 *
 * Compares `proposed` against the current ingredient list `current` and the
 * user's verbatim message. Returns `{ ok: true }` when every diff can be
 * explained by the message (the user named it) OR involves only a pantry
 * staple. Returns `{ ok: false, reason }` when a precisely-bought
 * ingredient was introduced or mutated without the user's mention — a
 * hard invariant from the design doc.
 *
 * The check is lenient on substring matches against `userMessage` because
 * LLMs may re-canonicalize names ("chicken breast" → "chicken"). Matching
 * is case-insensitive.
 */
export function validateSwapAgainstGuardrails(args: {
  current: ReadonlyArray<ScaledIngredient>;
  proposed: ReadonlyArray<ScaledIngredient>;
  userMessage: string;
  /**
   * The agent's declared changes[] (when available). A change that
   * explicitly names a `from` / `ingredient` counts as "the agent
   * acknowledged this" — the validator only rejects when a diff is
   * both unexplained by the user's message AND unnamed in changes[].
   * Rewrite turns ("actually use ricotta instead") legitimately drop
   * the prior substitute without re-typing its name.
   */
  changes?: ReadonlyArray<SwapChange>;
  /**
   * Plan 033: the batch's prior swap history. An ingredient that
   * appears in any prior SwapRecord's `from` field (or as the target
   * of a `remove`) was once a recipe-canonical ingredient that a swap
   * displaced — restoring it on a reversal turn is LEGITIMATE even
   * when the user's message doesn't name it ("undo" reverses without
   * re-typing what to put back). Without this signal, the guardrail
   * would reject every reversal that restores a precisely-bought
   * ingredient.
   */
  swapHistory?: ReadonlyArray<SwapRecord>;
}): { ok: true } | { ok: false; reason: string } {
  const { current, proposed, userMessage, changes, swapHistory } = args;
  const userLower = userMessage.toLowerCase();
  const { introduced: declaredIntroduced, removed: declaredRemoved } = endpointsOf(changes);

  // Build the set of ingredients that any prior swap displaced — these
  // are valid "restore" targets on a reversal turn.
  const historicallyDisplaced = new Set<string>();
  for (const rec of swapHistory ?? []) {
    for (const c of rec.changes) {
      if (c.kind === 'replace') historicallyDisplaced.add(c.from.toLowerCase());
      else if (c.kind === 'remove') historicallyDisplaced.add(c.ingredient.toLowerCase());
    }
  }
  const byNameLower = (list: ReadonlyArray<ScaledIngredient>): Map<string, ScaledIngredient> => {
    const m = new Map<string, ScaledIngredient>();
    for (const i of list) m.set(i.name.toLowerCase(), i);
    return m;
  };
  const currentByName = byNameLower(current);
  const proposedByName = byNameLower(proposed);

  // Introduced ingredients (in proposed, not in current). The agent's
  // `changes` entries do NOT legitimize a new precisely-bought item
  // (design-doc rule "introducing a new precisely-bought ingredient is
  // a hard no"). EXCEPTION: an ingredient that any prior SwapRecord
  // displaced is a legitimate restore on a reversal turn — the user
  // typed "undo" / "swap back" / "put X back" and we're returning the
  // batch to a prior state. Pantry staples and user-named substitutes
  // also pass.
  void declaredIntroduced;
  for (const p of proposed) {
    if (currentByName.has(p.name.toLowerCase())) continue;
    if (isPantryStaple(p.name)) continue;
    if (userMentions(p.name, userLower)) continue;
    if (historicallyDisplaced.has(p.name.toLowerCase())) continue;
    return {
      ok: false,
      reason: `new precisely-bought ingredient "${p.name}" was not named by the user`,
    };
  }

  // Mutated ingredients (in both current and proposed, amount changed).
  // STRICT match — the agent must not silently change "ground beef" 200g
  // → 180g just because the user's substitute "beef stock" shares the
  // word "beef".
  for (const p of proposed) {
    const prior = currentByName.get(p.name.toLowerCase());
    if (!prior) continue;
    if (prior.amount === p.amount && prior.unit === p.unit) continue;
    if (isPantryStaple(p.name)) continue;
    if (userMentionsStrict(p.name, userLower)) continue;
    return {
      ok: false,
      reason: `precisely-bought ingredient "${p.name}" amount changed (${prior.amount}${prior.unit} → ${p.amount}${p.unit}) but the user did not name it`,
    };
  }

  // Removed ingredients (in current, not in proposed) — must be named OR a
  // pantry staple OR explicitly named in the agent's changes[] (e.g., a
  // `replace` change whose `from` is the removed ingredient — a rewrite
  // where the user said "actually use X" without re-naming the prior
  // substitute). The agent's own change is the justification. Strict
  // match here for the user-named criterion.
  for (const c of current) {
    if (proposedByName.has(c.name.toLowerCase())) continue;
    if (isPantryStaple(c.name)) continue;
    if (userMentionsStrict(c.name, userLower)) continue;
    if (declaredRemoved.has(c.name.toLowerCase())) continue;
    return {
      ok: false,
      reason: `precisely-bought ingredient "${c.name}" was removed but the user did not name it`,
    };
  }

  return { ok: true };
}

/**
 * Case-insensitive substring match of an ingredient name against the user's
 * message. Also accepts a few token-boundary fragments so "salmon fillet"
 * is mentioned by a user typing "no salmon" (the reverse direction is
 * covered by the substring check).
 */
/**
 * Does the user's message mention this ingredient name? Exact substring
 * wins; for multi-token names, the FIRST token must appear (prevents
 * "beef" in "beef stock" from falsely matching "ground beef"). Tokens
 * shorter than 4 chars don't qualify — "red" in "red pepper" is too
 * ambiguous to rely on. Single-word names fall back to the ≥4-char
 * length test.
 */
/**
 * State / form modifiers that don't change which ingredient an item is
 * (a "ground" beef is still beef; "extra-firm" tofu is still tofu).
 * The user typing "tofu" or "beef" should match the canonical-name
 * core token even when the recipe stores a more-specified variant.
 */
const NAME_MODIFIERS = new Set([
  'raw', 'cooked', 'drained', 'canned', 'fresh', 'frozen', 'dry', 'dried',
  'extra', 'firm', 'soft', 'silken', 'ground', 'minced', 'sliced', 'diced',
  'small', 'large', 'medium', 'baby', 'organic',
  'boneless', 'skinless', 'whole', 'fillet', 'fillets',
]);

const STOPWORDS = new Set([
  'and', 'the', 'for', 'with', 'into', 'from', 'that', 'this',
  'but', 'not', 'use', 'got', 'has', 'are', 'can', 'too',
]);

/**
 * Loose name match — "user said something close to this ingredient".
 * Used by the introduction check, where the agent may have specified a
 * variant ("extra-firm tofu") of a user-named ingredient ("tofu"). A
 * single core token match is enough.
 */
function userMentionsLoose(ingredientName: string, userLower: string): boolean {
  const nameLower = ingredientName.toLowerCase();
  if (userLower.includes(nameLower)) return true;
  const cores = coreTokens(nameLower);
  if (cores.length === 0) return false;
  const userHasToken = (token: string): boolean => {
    const re = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return re.test(userLower);
  };
  return cores.some(userHasToken);
}

/**
 * Strict name match — "user explicitly named this exact ingredient".
 * Used by the mutation/removal checks where the agent must NOT silently
 * change/remove a precisely-bought ingredient. "ground beef" requires
 * both "ground" AND "beef" in the user message — prevents "beef stock"
 * (the substitute) from looking like a reference to "ground beef" (the
 * untouched protein). Modifier-only names fall back to loose matching.
 */
function userMentionsStrict(ingredientName: string, userLower: string): boolean {
  const nameLower = ingredientName.toLowerCase();
  if (userLower.includes(nameLower)) return true;
  const cores = coreTokens(nameLower);
  if (cores.length === 0) return false;
  // Strict: the user must mention the FULL ingredient name's meaningful
  // tokens (including modifiers like "ground", "extra-firm"). The full
  // tokenization preserves modifiers so collisions with substitute
  // names sharing one core token are rejected.
  const fullTokens = nameLower
    .replace(/[,;:.()'"!?]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const userHasToken = (token: string): boolean => {
    const re = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return re.test(userLower);
  };
  return fullTokens.every(userHasToken);
}

function coreTokens(nameLower: string): string[] {
  const allTokens = nameLower
    .replace(/[,;:.()'"!?]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const cores = allTokens.filter((t) => !NAME_MODIFIERS.has(t));
  return cores.length > 0 ? cores : allTokens;
}

/**
 * Backward-compatible alias used by introductions (loose). Preserved
 * because the existing call sites pass an ingredient + the user's
 * message and expect a single boolean.
 */
function userMentions(ingredientName: string, userLower: string): boolean {
  return userMentionsLoose(ingredientName, userLower);
}
