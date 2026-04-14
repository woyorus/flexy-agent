/**
 * Ingredient-swap sub-agent — Plan 033 / design doc 006.
 *
 * Single LLM call that takes ONE swap target (a persisted Batch or the
 * per-session breakfast shape) + the user's verbatim message and returns a
 * structured decision: apply now, ask first with a preview, offer
 * help-me-pick options, ask a clarification, or hard-no with a routing hint.
 *
 * No session state, no store access, no persistence — pure function of
 * (target, userMessage, mode). The caller in `src/plan/swap-applier.ts`
 * owns ingredient-resolution, persistence, rendering, and the ask-first
 * stash (`session.pendingSwap`).
 *
 * Modeled after `src/agents/recipe-scaler.ts` (single-call JSON, Atwater
 * retry) and `src/agents/plan-reproposer.ts` (validation + structured-union
 * output). Uses mini-tier reasoning because the logic is mechanical once
 * the rules in the system prompt are applied.
 */

import type { LLMProvider } from '../ai/provider.js';
import type {
  Recipe,
  ScaledIngredient,
  MacrosWithFatCarbs,
  Macros,
  SwapChange,
  SwapRecord,
} from '../models/types.js';
import type { TraceEvent } from '../harness/trace.js';
import { computeMacroCalorieConsistency, MACRO_CAL_TOLERANCE } from '../qa/validators/recipe.js';
import { log } from '../debug/logger.js';

/**
 * A unified swap target. The agent treats both variants identically for
 * decision-making (auto-apply vs preview vs help-me-pick vs clarify vs
 * hard_no). The applier dispatches persistence on the discriminator:
 *   `kind === 'batch'`      → store.updateBatch
 *   `kind === 'breakfast'`  → store.updatePlanSessionBreakfast
 *
 * Per-serving vs per-day semantics: for a `batch` target, ingredient
 * amounts and macros are PER SERVING. For a `breakfast` target, they are
 * PER DAY — breakfast runs one "serving" per day; there is no multi-
 * serving breakfast batch. The agent's output mirrors the input's
 * semantics so the applier never has to reshape numbers.
 */
export type SwapTarget =
  | {
      kind: 'batch';
      /** Batch ID. */
      targetId: string;
      recipe: Recipe;
      servings: number;
      /** Per-serving target macros from the solver. */
      targetMacros: Macros;
      /** Current per-serving macros (post any prior swaps). */
      currentMacros: MacrosWithFatCarbs;
      /** Current per-serving ingredients. */
      currentIngredients: ScaledIngredient[];
      /** `batch.nameOverride ?? recipe.name`. */
      currentName: string;
      /** `batch.bodyOverride ?? recipe.body`. */
      currentBody: string;
      /** Pre-existing swap history on the batch; the reversal agent reads this. */
      swapHistory: SwapRecord[];
      /** ISO eating days on the batch — for context when the agent decides "mid-cook" rewrites. */
      eatingDays: string[];
    }
  | {
      kind: 'breakfast';
      /** Literal sentinel — not a UUID. */
      targetId: 'breakfast';
      recipe: Recipe;
      /** Per-day macros target (matches `PlanSession.breakfast.caloriesPerDay` / `proteinPerDay`). */
      targetMacros: Macros;
      /** Current per-day macros (post any prior swaps). */
      currentMacros: MacrosWithFatCarbs;
      /** Per-day ingredients. */
      currentIngredients: ScaledIngredient[];
      currentName: string;
      currentBody: string;
      /** Pre-existing swap history on the breakfast override. */
      swapHistory: SwapRecord[];
      /** Horizon day count — drives the shopping list's breakfast proration delta. */
      horizonDays: number;
    };

/** Input to {@link decideIngredientSwap}. */
export interface IngredientSwapInput {
  target: SwapTarget;
  /** Verbatim user message that triggered the swap — including any reversal phrasing. */
  userMessage: string;
  /** Which surface the user is on when they sent the message. Informs framing, not persistence. */
  surface: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null;
  /**
   * The applier sets this when target resolution was unambiguous — the user
   * was on a cook view of exactly this batch, or the named ingredient
   * matched exactly one candidate in the plan. The agent uses it to decide
   * whether to preview vs apply when the user's message doesn't explicitly
   * name a batch.
   */
  targetIsUnambiguous: boolean;
  /**
   * ~±10% noise floor on per-serving / per-day calories — drives the
   * "drama" threshold for rebalance. Sourced from
   * `config.planning.swapNoisePctOfTarget`.
   */
  noisePctOfTarget: number;
}

/** The structured decision the agent returns to the applier. */
export type IngredientSwapDecision =
  | {
      kind: 'apply';
      /**
       * New scaled ingredients, matching the input's per-serving (batch) or
       * per-day (breakfast) semantics.
       */
      scaledIngredients: ScaledIngredient[];
      /**
       * New macros snapshot. Per-serving for batch targets, per-day for
       * breakfast targets. Field name mirrors the future `PendingSwap`
       * shape so the applier can pass through without reshaping.
       */
      actualMacros: MacrosWithFatCarbs;
      /** Optional rewritten name; `null` clears any existing override; `undefined` preserves current. */
      nameOverride?: string | null;
      /** Optional rewritten step text; same semantics as nameOverride. */
      bodyOverride?: string | null;
      /** Atomic SwapChange records for this commit, in display order. */
      changes: SwapChange[];
      /** Pre-formatted delta lines for the renderer footer (one per change + optional macro line). */
      deltaLines: string[];
      /**
       * Reset-to-original marker. When true, the applier IGNORES
       * scaledIngredients/actualMacros/bodyOverride and instead re-runs
       * scaleRecipe against the batch's targetPerServing (or the session's
       * breakfast target macros), clears swap history, and clears name/body
       * overrides. The agent still emits a `changes: [{ kind: 'rename', ...
       * to: recipe.name }]` entry so the delta block has something to say.
       */
      resetToOriginal?: boolean;
      reasoning: string;
    }
  | {
      kind: 'preview';
      /**
       * Same payload shape as 'apply' — applier stashes it and waits for
       * a natural-language confirm/cancel/rewrite from the user.
       */
      proposed: {
        scaledIngredients: ScaledIngredient[];
        actualMacros: MacrosWithFatCarbs;
        nameOverride?: string | null;
        bodyOverride?: string | null;
        changes: SwapChange[];
      };
      /**
       * One-paragraph preview message + an explicit "OK to apply, or want a
       * different X?" prompt. Emitted verbatim by the applier.
       */
      previewText: string;
      /** Why the agent chose preview over apply. Drives telemetry; not user-visible. */
      reason: 'ambiguous_target' | 'hedged' | 'unknown_substitute' | 'structural' | 'stale_view';
      reasoning: string;
    }
  | {
      kind: 'help_me_pick';
      /** Two or three named options for the user to pick from. */
      optionsText: string;
      reasoning: string;
    }
  | {
      kind: 'clarification';
      question: string;
      reasoning: string;
    }
  | {
      kind: 'hard_no';
      /** Renderable message explaining why and suggesting next step. */
      message: string;
      /** When set, the applier surfaces a routing hint (e.g., "tap Plan Week to swap the whole recipe"). */
      routingHint?: 'recipe_level_swap' | 'library_edit' | 'no_target';
      reasoning: string;
    };

/** Which variants of {@link IngredientSwapDecision} can surface from a reversal. */
type Kind = IngredientSwapDecision['kind'];
const LEGAL_KINDS: readonly Kind[] = ['apply', 'preview', 'help_me_pick', 'clarification', 'hard_no'];

/**
 * Call the ingredient-swap agent and return a structured decision. Retries
 * once on a JSON parse failure; retries once on an Atwater inconsistency
 * when the decision is `apply` or `preview` (the only kinds that carry
 * macros). On a second failure, falls back to `hard_no` so the caller can
 * render an honest error rather than crash.
 */
export async function decideIngredientSwap(
  input: IngredientSwapInput,
  llm: LLMProvider,
  onTrace?: (event: TraceEvent) => void,
): Promise<IngredientSwapDecision> {
  const systemPrompt = buildSystemPrompt(input);
  const userPrompt = buildUserPrompt(input);

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userPrompt },
  ];

  let result = await llm.complete({
    model: 'mini',
    messages,
    json: true,
    reasoning: 'high',
    context: 'ingredient-swap',
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content);
  } catch (err) {
    onTrace?.({ kind: 'retry', validator: 'ingredient-swap-parse', attempt: 1, errors: [String(err)] });
    // One retry with the parse error echoed.
    result = await llm.complete({
      model: 'mini',
      messages: [
        ...messages,
        { role: 'assistant' as const, content: result.content },
        {
          role: 'user' as const,
          content: `That wasn't valid JSON (${String(err)}). Return the response as a single valid JSON object matching the schema.`,
        },
      ],
      json: true,
      reasoning: 'high',
      context: 'ingredient-swap-parse-retry',
    });
    try {
      parsed = JSON.parse(result.content);
    } catch {
      return {
        kind: 'hard_no',
        message: "I couldn't read that swap cleanly — try rephrasing it?",
        routingHint: 'no_target',
        reasoning: 'parse_failure',
      };
    }
  }

  let decision = normalizeDecision(parsed, input);
  if (!decision) {
    return {
      kind: 'hard_no',
      message: "I couldn't read that swap cleanly — try rephrasing it?",
      routingHint: 'no_target',
      reasoning: 'schema_violation',
    };
  }

  // Atwater check applies to decisions that carry macros (`apply` and `preview`).
  const macros = decision.kind === 'apply'
    ? decision.actualMacros
    : decision.kind === 'preview'
      ? decision.proposed.actualMacros
      : null;

  if (macros && !decision.kind.includes('reset')) {
    const consistency = computeMacroCalorieConsistency(macros);
    if (consistency.deviationPct > MACRO_CAL_TOLERANCE) {
      const ctx = input.target.kind === 'breakfast' ? 'per-day' : 'per-serving';
      log.warn(
        'SWAP',
        `Atwater mismatch (${ctx}): stated ${macros.calories} vs computed ${consistency.computed} (off ${(consistency.deviationPct * 100).toFixed(1)}%). Retrying.`,
      );
      onTrace?.({
        kind: 'retry',
        validator: 'ingredient-swap-atwater',
        attempt: 1,
        errors: [
          `stated ${macros.calories} cal but 4·${macros.protein}P + 4·${macros.carbs}C + 9·${macros.fat}F = ${consistency.computed} (${(consistency.deviationPct * 100).toFixed(1)}% off)`,
        ],
      });

      result = await llm.complete({
        model: 'mini',
        messages: [
          ...messages,
          { role: 'assistant' as const, content: result.content },
          {
            role: 'user' as const,
            content: `Your ${ctx} macros don't satisfy Atwater: ${macros.calories} cal but 4·${macros.protein}P + 4·${macros.carbs}C + 9·${macros.fat}F = ${consistency.computed} cal (off ${(consistency.deviationPct * 100).toFixed(1)}%). Recompute and return the full corrected JSON with consistent values.`,
          },
        ],
        json: true,
        reasoning: 'high',
        context: 'ingredient-swap-atwater-retry',
      });

      try {
        const retried = normalizeDecision(JSON.parse(result.content), input);
        if (retried) decision = retried;
      } catch {
        // keep prior decision on parse failure — log once and proceed.
        log.error('SWAP', 'Atwater retry produced unparseable JSON; proceeding with best effort.');
      }
    }
  }

  return decision;
}

/**
 * Normalize the raw LLM JSON into an {@link IngredientSwapDecision}. Returns
 * `null` when the schema is violated (missing required field for the
 * picked `kind`). The caller treats that as a hard-no fallback.
 *
 * Permissive on unknown fields (ignored); strict on required fields.
 */
function normalizeDecision(
  raw: unknown,
  input: IngredientSwapInput,
): IngredientSwapDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const kindRaw = obj.kind;
  if (typeof kindRaw !== 'string' || !(LEGAL_KINDS as readonly string[]).includes(kindRaw)) return null;
  const kind = kindRaw as Kind;
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';

  if (kind === 'apply') {
    const resetToOriginal = obj.reset_to_original === true;
    // When resetToOriginal is true, the applier re-runs scaleRecipe and
    // discards these fields. We still accept them from the agent so the
    // delta/rename surface renders.
    const scaled = parseScaledIngredients(obj.scaled_ingredients, input);
    const actualMacros = parseMacros(obj.actual_macros);
    const changes = parseChanges(obj.changes);
    const deltaLines = Array.isArray(obj.delta_lines) ? obj.delta_lines.filter((d): d is string => typeof d === 'string') : [];
    if (!resetToOriginal) {
      if (!scaled || !actualMacros || !changes) return null;
    }
    return {
      kind: 'apply',
      scaledIngredients: scaled ?? [],
      actualMacros: actualMacros ?? input.target.currentMacros,
      nameOverride: optionalOverride(obj.name_override),
      bodyOverride: optionalOverride(obj.body_override),
      changes: changes ?? [],
      deltaLines,
      ...(resetToOriginal ? { resetToOriginal: true } : {}),
      reasoning,
    };
  }

  if (kind === 'preview') {
    const scaled = parseScaledIngredients(obj.scaled_ingredients, input);
    const actualMacros = parseMacros(obj.actual_macros);
    const changes = parseChanges(obj.changes);
    const reason = typeof obj.reason === 'string' ? obj.reason : null;
    // Plan 033 defense-in-depth: previews carry user-facing text that
    // the LLM should emit, but parallel multi-batch calls occasionally
    // drop the preview_text field. Synthesize a brief default from the
    // changes array rather than discarding the whole decision (which
    // would lose a valid swap proposal). Fail only on missing
    // structural fields the applier truly needs.
    if (!scaled || !actualMacros || !changes || !reason) return null;
    const previewText = typeof obj.preview_text === 'string' && obj.preview_text.length > 0
      ? obj.preview_text
      : synthesizePreviewText(changes);
    return {
      kind: 'preview',
      proposed: {
        scaledIngredients: scaled,
        actualMacros,
        nameOverride: optionalOverride(obj.name_override),
        bodyOverride: optionalOverride(obj.body_override),
        changes,
      },
      previewText,
      reason: reason as 'ambiguous_target' | 'hedged' | 'unknown_substitute' | 'structural' | 'stale_view',
      reasoning,
    };
  }

  if (kind === 'help_me_pick') {
    const text = typeof obj.options_text === 'string' ? obj.options_text : null;
    if (!text) return null;
    return { kind: 'help_me_pick', optionsText: text, reasoning };
  }

  if (kind === 'clarification') {
    const question = typeof obj.question === 'string' ? obj.question : null;
    if (!question) return null;
    return { kind: 'clarification', question, reasoning };
  }

  if (kind === 'hard_no') {
    const message = typeof obj.message === 'string' ? obj.message : null;
    if (!message) return null;
    const hintRaw = obj.routing_hint;
    const hint = typeof hintRaw === 'string'
      && (hintRaw === 'recipe_level_swap' || hintRaw === 'library_edit' || hintRaw === 'no_target')
      ? hintRaw
      : undefined;
    return { kind: 'hard_no', message, ...(hint ? { routingHint: hint } : {}), reasoning };
  }

  return null;
}

function optionalOverride(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

function parseMacros(value: unknown): MacrosWithFatCarbs | null {
  if (!value || typeof value !== 'object') return null;
  const m = value as Record<string, unknown>;
  const c = Number(m.calories);
  const p = Number(m.protein);
  const f = Number(m.fat);
  const cb = Number(m.carbs);
  if (!Number.isFinite(c) || !Number.isFinite(p) || !Number.isFinite(f) || !Number.isFinite(cb)) return null;
  return { calories: c, protein: p, fat: f, carbs: cb };
}

function parseScaledIngredients(
  value: unknown,
  input: IngredientSwapInput,
): ScaledIngredient[] | null {
  if (!Array.isArray(value)) return null;
  const scale = input.target.kind === 'batch' ? input.target.servings : input.target.horizonDays;
  const out: ScaledIngredient[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name : null;
    const amount = Number(e.amount);
    const unit = typeof e.unit === 'string' ? e.unit : null;
    if (!name || !Number.isFinite(amount) || unit === null) return null;
    const totalRaw = Number(e.total_for_batch);
    const total = Number.isFinite(totalRaw) ? totalRaw : amount * scale;
    const roleRaw = typeof e.role === 'string' ? e.role : undefined;
    const legalRoles = new Set(['protein', 'carb', 'fat', 'vegetable', 'base', 'seasoning']);
    const role = (roleRaw && legalRoles.has(roleRaw) ? roleRaw : inferRole(name, input.target)) as ScaledIngredient['role'];
    out.push({ name, amount, unit, totalForBatch: total, role });
  }
  return out;
}

/**
 * Best-effort role inference for a swapped-in ingredient: prefer the role
 * of an existing ingredient with a matching name, then fall back to the
 * recipe's library entry, then 'base'. Keeps scaler/shopping-list role
 * priority consistent across swaps.
 */
function inferRole(
  name: string,
  target: SwapTarget,
): 'protein' | 'carb' | 'fat' | 'vegetable' | 'base' | 'seasoning' {
  const nameLower = name.toLowerCase();
  const currentMatch = target.currentIngredients.find(
    (i) => i.name.toLowerCase().includes(nameLower) || nameLower.includes(i.name.toLowerCase()),
  );
  if (currentMatch) return currentMatch.role;
  const libraryMatch = target.recipe.ingredients.find(
    (i) => i.name.toLowerCase().includes(nameLower) || nameLower.includes(i.name.toLowerCase()),
  );
  if (libraryMatch) return libraryMatch.role;
  return 'base';
}

function parseChanges(value: unknown): SwapChange[] | null {
  if (!Array.isArray(value)) return null;
  const out: SwapChange[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    const kind = e.kind;
    if (kind === 'replace') {
      out.push({
        kind: 'replace',
        from: String(e.from ?? ''),
        to: String(e.to ?? ''),
        fromAmount: Number(e.fromAmount ?? e.from_amount ?? 0),
        fromUnit: String(e.fromUnit ?? e.from_unit ?? ''),
        toAmount: Number(e.toAmount ?? e.to_amount ?? 0),
        toUnit: String(e.toUnit ?? e.to_unit ?? ''),
      });
    } else if (kind === 'remove') {
      out.push({
        kind: 'remove',
        ingredient: String(e.ingredient ?? ''),
        amount: Number(e.amount ?? 0),
        unit: String(e.unit ?? ''),
      });
    } else if (kind === 'add') {
      const reasonRaw = e.reason;
      const reason = reasonRaw === 'helper' || reasonRaw === 'rebalance' ? reasonRaw : 'helper';
      out.push({
        kind: 'add',
        ingredient: String(e.ingredient ?? ''),
        amount: Number(e.amount ?? 0),
        unit: String(e.unit ?? ''),
        reason,
      });
    } else if (kind === 'rebalance') {
      out.push({
        kind: 'rebalance',
        ingredient: String(e.ingredient ?? ''),
        fromAmount: Number(e.fromAmount ?? e.from_amount ?? 0),
        toAmount: Number(e.toAmount ?? e.to_amount ?? 0),
        unit: String(e.unit ?? ''),
      });
    } else if (kind === 'rename') {
      out.push({ kind: 'rename', from: String(e.from ?? ''), to: String(e.to ?? '') });
    } else {
      return null;
    }
  }
  return out;
}

/**
 * The system prompt encodes the full auto-apply / ask-first / pantry-staple /
 * guardrail policy from design doc 006. It is identical for batch and
 * breakfast targets; the per-serving-vs-per-day caveat is stated in one
 * sentence near the top.
 */
function buildSystemPrompt(input: IngredientSwapInput): string {
  const semantics = input.target.kind === 'breakfast'
    ? 'PER-DAY (breakfast runs one "serving" per day — there is no multi-serving batch concept)'
    : `PER-SERVING (the batch has ${(input.target as Extract<SwapTarget, { kind: 'batch' }>).servings} servings)`;

  return `You mutate ONE cooking-batch's (or breakfast's) contents in response to a real-life ingredient change at the kitchen counter or in the grocery aisle.

You are NOT allowed to:
- Change the library recipe. The library is canonical; you operate on an instance.
- Rearrange the plan (different recipe in a slot). That's a different action the caller already routed around.
- Introduce a new precisely-bought ingredient (one the user has to weigh or buy on purpose) they did not name.
- Change the amount of a precisely-bought ingredient they did not name.
- Invent "consume the bought X first" tracking language. The kitchen is the source of truth.

All macro/ingredient numbers in your output follow the target's semantics: ${semantics}.

DECISION KIND — pick exactly ONE:

1. apply — Auto-apply when ALL THREE hold:
   (a) the target is unambiguous (targetIsUnambiguous=true in input, OR the user named a specific named ingredient and context pins it),
   (b) the substitute is named and common (wine→stock, yogurt→cottage cheese, salmon→cod, chicken→tofu, cream→milk+butter, buttermilk→milk+vinegar),
   (c) the change is non-structural — does NOT remove every recipe-identity ingredient (e.g., removing both the salmon AND the calamari from "Salmon Calamari Pasta" IS structural → hard_no).
   When applying, include: scaled_ingredients (full post-swap list), actual_macros, optional name_override/body_override, changes[] (atomic SwapChange entries), delta_lines[] (one pre-formatted string per change + one macro line).

2. preview — Ask first when ANY of these hold:
   (a) target is ambiguous (user didn't name a batch and the context isn't pinning one),
   (b) user hedged ("maybe", "I was thinking", "what if"),
   (c) substitute is unknown or unusual ("my grandma's pickled wild garlic") — state your macro assumption explicitly in preview_text,
   (d) swap is STRUCTURAL — replacing the main protein, a recipe-identity ingredient, an ingredient that drives a portion scale shift, or a unit conversion that changes serving math. **MAIN-PROTEIN replacements ARE ALWAYS structural** — chicken breast → tofu, salmon → cod, beef → lentils, shrimp → chickpeas all preview, never auto-apply, even when the user phrasing is decisive ("use tofu instead of chicken breast"). Per design doc 006 Screen 7: the protein gap and portion bump need explicit user acknowledgment.
   (e) the view the user is looking at is stale for the intended target.
   Include the full proposed payload (scaled_ingredients, actual_macros, optional overrides, changes[]) so the applier can commit on "yes" with no second LLM call. **The preview_text field is REQUIRED — emit a one-paragraph user-facing message ending with an explicit confirmation prompt ("OK to apply, or want a different X?"). NEVER omit this field on a preview; the applier falls back to a synthesized line if you do, but that line is generic and worse UX.** Also include reason (one of: ambiguous_target | hedged | unknown_substitute | structural | stale_view).

3. help_me_pick — When the user is ASKING for options ("they don't have salmon, what should I get?"). Return 2–3 named options each with substitute amount and a one-line per-serving (or per-day) macro impact. DO NOT persist. The user's follow-up ("got the cod, 320g") will route back through this agent as a fresh apply/preview.

4. clarification — When the bot genuinely doesn't know what to do and needs one concrete piece of info. Short, specific question. NOT for ambiguous-batch-within-the-plan (that's preview with reason=ambiguous_target).

5. hard_no — When the swap empties out the recipe identity (removing all recipe-identity ingredients), or another invariant fails. Include message (explaining why and suggesting next step) and routing_hint (one of: recipe_level_swap | library_edit | no_target). **CATASTROPHIC IDENTITY BREAK is ALWAYS hard_no, never help_me_pick:** when the user asks to remove ALL of a recipe's protein-identity ingredients (e.g., "skip the salmon AND the shrimp" on a Salmon-Shrimp Linguine, "skip the chicken AND the chickpeas" on a chicken-chickpea bowl), removing them would leave the recipe unrecognisable. Even if the user phrased the request as "what should I do?", the right reply is hard_no with routing_hint=recipe_level_swap and a message giving exactly two options: (a) swap the whole recipe via mutate_plan, or (b) keep one of the proteins. Do NOT route to help_me_pick — the user's question deserves an honest "this swap would break the recipe" with concrete next-step routing, not a list of replacement proteins (which would be papering over the structural problem).

PANTRY-STAPLE POLICY:
Pantry staples = fats (oils, butter), salt, stocks, vinegars, acids (lemon/lime juice), herbs, spices, sugar, milk/cream, garlic, onion.
- You MAY flex amounts of pantry staples without asking.
- You MAY introduce a pantry-staple HELPER alongside a replacement when it preserves flavor/acidity (wine→stock + lemon juice; cream→milk + butter; buttermilk→milk + vinegar). Always name the helper openly in changes[] (kind: 'add', reason: 'helper') AND in delta_lines.
- You MAY NOT introduce a new PRECISELY-BOUGHT ingredient (pine nuts, a different protein, a different pasta) the user did not name.
- Precisely-bought = weighed proteins, pasta by weight, packaged portions, produce with specific gram targets. Name and amount stay unchanged unless the user explicitly named that ingredient as the swap target.

SUBSTITUTE-AMOUNT SCALING (proteins):
- 20–30% bump on protein substitutes (tofu for chicken, chickpeas for beef) is fine when sensible. NEVER force a protein match. Beyond that, state the protein landing honestly ("~25g P per serving vs the ~38g target") and move on.

NOISE FLOOR:
- Within ±${input.noisePctOfTarget}% of targetMacros.calories → emit ONE calm macro line ("within noise", "on pace", "on target"), no rebalance.
- Beyond ±${input.noisePctOfTarget}% → rebalance with a pantry staple (add 'rebalance' change) OR state the gap honestly in delta_lines.

ATWATER (CRITICAL):
- actual_macros MUST satisfy calories ≈ 4·protein + 4·carbs + 9·fat within ±5%. Before returning, compute it yourself. Retry the JSON if it doesn't add up.

STEP REWRITING:
- Any step (in body) mentioning a swapped ingredient by name gets rewritten so the step reads naturally with the new ingredient. Include the rewritten full body in body_override. If steps don't mention the swap subject, leave body_override as null (current body is fine).

REVERSAL ("swap back", "undo", "reset to original", "put X back"):
- "swap back" / "undo" / "revert" with no name → reverse only the MOST RECENT SwapRecord in the provided swap_history. Build changes[] that restore the pre-most-recent state. Emit the new ingredients + macros that result.
- Named ("put the passata back", "the wine is back") → find the matching SwapChange.from in swap_history (case-insensitive). Reverse ONLY that record. Other swaps stay.
- "reset to original" / "back to the library recipe" / "undo all my swaps" → return kind: 'apply' with reset_to_original: true and changes: [{ kind: 'rename', from: currentName, to: recipe.name }]. The applier will re-run the scaler and clear all override fields.
- Ambiguous "undo" with multiple swaps and no name → kind: 'clarification' listing each swap one-per-line.

DELTA LINE FORMATS (emit verbatim in delta_lines[] when kind='apply'):
- Replacement: "Swapped: <from> (<fromAmt><fromUnit>) → <to> (<toAmt><toUnit>)[ + <helper> (<amt><unit>)]"
- Removal:    "Removed: <ingredient> (<amt><unit>)"
- Add helper: "+ <ingredient> (<amt><unit>)"   (alternative when the replacement line is too long)
- Rebalance:  "Rebalanced: <ingredient> <fromAmt><unit> → <toAmt><unit>, to <reason>."
- Macros (noise): "Macros: <±N> cal/${input.target.kind === 'breakfast' ? 'day' : 'serving'} — <within noise|on pace|on target>."
- Macros (outside noise): "Macros: <kcal>/<protein>g protein per ${input.target.kind === 'breakfast' ? 'day' : 'serving'} — <message>."
- Reset:      "Reset: returned to library recipe."

ACKNOWLEDGMENT RULE:
- For every REMOVAL the user named, include a Removed line in delta_lines even when that specific removal didn't trigger a rebalance. Users must see every change they named.

OUTPUT — return ONLY valid JSON, no markdown. Schema:

{
  "kind": "apply" | "preview" | "help_me_pick" | "clarification" | "hard_no",
  "scaled_ingredients": [ { "name": string, "amount": number, "unit": string, "total_for_batch": number, "role": "protein"|"carb"|"fat"|"vegetable"|"base"|"seasoning" } ],   // apply + preview
  "actual_macros": { "calories": number, "protein": number, "fat": number, "carbs": number },   // apply + preview
  "name_override": string | null,     // optional on apply/preview; null clears an existing override
  "body_override": string | null,     // optional on apply/preview; null clears an existing override
  "reset_to_original": boolean,       // optional; apply only
  "changes": [ { "kind": "replace"|"remove"|"add"|"rebalance"|"rename", ... } ],   // apply + preview
  "delta_lines": [ string ],          // apply only
  "preview_text": string,             // preview only
  "options_text": string,             // help_me_pick only
  "question": string,                 // clarification only
  "message": string,                  // hard_no only
  "routing_hint": "recipe_level_swap" | "library_edit" | "no_target" | null,   // hard_no only
  "reason": "ambiguous_target" | "hedged" | "unknown_substitute" | "structural" | "stale_view" | null,   // preview only
  "reasoning": string                 // always — brief WHY you picked this kind
}
`;
}

function buildUserPrompt(input: IngredientSwapInput): string {
  const t = input.target;
  const ingredientLines = t.currentIngredients
    .map((i) => `  - ${i.name}: ${i.amount}${i.unit} (role: ${i.role}, total_for_batch: ${i.totalForBatch})`)
    .join('\n');

  const swapHistoryBlock = t.swapHistory.length === 0
    ? '  (no prior swaps)'
    : t.swapHistory
      .map((rec, idx) => {
        const changeSummary = rec.changes.map((c) => formatChangeForPrompt(c)).join('; ');
        return `  ${idx + 1}. ${rec.appliedAt}: "${rec.userMessage}" — ${changeSummary}`;
      })
      .join('\n');

  const structureLines = t.recipe.structure
    .map((c) => `  - ${c.type}: ${c.name}`)
    .join('\n');

  const libraryIngredients = t.recipe.ingredients
    .map((i) => `  - ${i.name} (role: ${i.role}, component: ${i.component})`)
    .join('\n');

  const targetContext = t.kind === 'batch'
    ? `Batch: ${t.targetId}\nMeal type: ${t.recipe.mealTypes.join(', ')}\nEating days: ${t.eatingDays.join(', ')}\nServings: ${t.servings}\nTarget per serving: ${t.targetMacros.calories} cal, ${t.targetMacros.protein}g protein`
    : `Target: breakfast (locked, per-session)\nHorizon days: ${t.horizonDays}\nTarget per day: ${t.targetMacros.calories} cal, ${t.targetMacros.protein}g protein`;

  return `# User message (verbatim)
"${input.userMessage}"

# Surface
${input.surface ?? 'unknown'}${input.targetIsUnambiguous ? '  (target resolver flagged this as unambiguous)' : '  (target resolver flagged this as ambiguous)'}

# Target
${targetContext}

## Current name
${t.currentName}

## Current per-${t.kind === 'breakfast' ? 'day' : 'serving'} macros
calories: ${t.currentMacros.calories}, protein: ${t.currentMacros.protein}, fat: ${t.currentMacros.fat}, carbs: ${t.currentMacros.carbs}

## Current ingredients
${ingredientLines}

## Current body (step text — may reference ingredient names)
${t.currentBody}

## Recipe structure (components)
${structureLines}

## Library recipe ingredients (for role inference on substitutes)
${libraryIngredients}

## Storage constraints
fridgeDays: ${t.recipe.storage.fridgeDays}, freezable: ${t.recipe.storage.freezable}, reheat: ${t.recipe.storage.reheat}

## Swap history (append-only; reverse by referencing an entry here)
${swapHistoryBlock}

Return the decision JSON per the schema in the system prompt.`;
}

/**
 * Synthesize a brief preview text from the agent's changes when the LLM
 * dropped the preview_text field. Defense-in-depth fallback so multi-
 * batch parallel agent calls still surface useful previews if one drops
 * the field. Mirrors the proposal's preview shape: compact + ends with
 * an explicit confirmation prompt.
 */
function synthesizePreviewText(changes: SwapChange[]): string {
  const summary = changes
    .map((c) => formatChangeForPrompt(c))
    .join('; ');
  return `Proposed swap: ${summary}. OK to apply, or want a different substitute?`;
}

/** Short textual summary of a SwapChange for the user prompt's swap history. */
function formatChangeForPrompt(c: SwapChange): string {
  switch (c.kind) {
    case 'replace':
      return `replace ${c.from}(${c.fromAmount}${c.fromUnit}) → ${c.to}(${c.toAmount}${c.toUnit})`;
    case 'remove':
      return `remove ${c.ingredient}(${c.amount}${c.unit})`;
    case 'add':
      return `add ${c.ingredient}(${c.amount}${c.unit}) [${c.reason}]`;
    case 'rebalance':
      return `rebalance ${c.ingredient} ${c.fromAmount}${c.unit} → ${c.toAmount}${c.unit}`;
    case 'rename':
      return `rename ${c.from} → ${c.to}`;
  }
}
