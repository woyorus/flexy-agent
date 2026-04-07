/**
 * Progress flow — measurement input parsing and disambiguation.
 *
 * Pure functions: state in, { text, state } out. No side effects.
 * The calling code in core.ts handles persistence and keyboard attachment.
 *
 * Follows the pattern of recipe-flow.ts and plan-flow.ts: pure-function flow
 * handlers imported by core.ts. Keeps core.ts as a thin dispatcher.
 */

import type { Measurement } from '../models/types.js';

/**
 * Parse measurement input text into one or two numeric values.
 *
 * Accepts formats: "82.3", "82.3 / 91", "82.3, 91", "82.3 91".
 * Returns null if the text doesn't match (not a valid measurement input).
 * Rejects inputs with more than two numbers, negative values, or zero.
 *
 * Does NOT assign weight vs waist meaning — that is left to `assignWeightWaist`.
 */
export function parseMeasurementInput(text: string): { values: [number] | [number, number] } | null {
  // Extract all number-like tokens (positive, non-zero)
  const numberRegex = /\d+(?:\.\d+)?/g;
  const matches = text.match(numberRegex);
  if (!matches) return null;

  const numbers = matches.map(Number).filter((n) => n > 0);
  if (numbers.length === 0) return null;
  if (numbers.length > 2) return null;
  // Reject if the original text contains negative signs before numbers
  if (/(?:^|[^.\d])-\d/.test(text)) return null;

  if (numbers.length === 1) {
    return { values: [numbers[0]!] };
  }
  return { values: [numbers[0]!, numbers[1]!] };
}

/**
 * Determine which of two numbers is weight and which is waist, using proximity
 * to the user's last measurement as the disambiguation heuristic.
 *
 * @param a - First number from the parser
 * @param b - Second number from the parser
 * @param lastMeasurement - User's most recent measurement (or null if first-ever)
 * @returns weight, waist, and whether the assignment is ambiguous
 */
export function assignWeightWaist(
  a: number,
  b: number,
  lastMeasurement: Measurement | null,
): { weight: number; waist: number; ambiguous: boolean } {
  // No prior data or no waist anchor → ambiguous, default a=weight b=waist
  if (!lastMeasurement || lastMeasurement.waistCm == null) {
    return { weight: a, waist: b, ambiguous: true };
  }

  const priorWeight = lastMeasurement.weightKg;
  const priorWaist = lastMeasurement.waistCm;

  const aDiffWeight = Math.abs(a - priorWeight);
  const aDiffWaist = Math.abs(a - priorWaist);
  const bDiffWeight = Math.abs(b - priorWeight);
  const bDiffWaist = Math.abs(b - priorWaist);

  // a closer to weight AND b closer to waist → unambiguous
  if (aDiffWeight < aDiffWaist && bDiffWaist < bDiffWeight) {
    return { weight: a, waist: b, ambiguous: false };
  }
  // a closer to waist AND b closer to weight → swap, unambiguous
  if (aDiffWaist < aDiffWeight && bDiffWeight < bDiffWaist) {
    return { weight: b, waist: a, ambiguous: false };
  }

  // Conflict (both closer to same prior value) or equidistant → ambiguous
  return { weight: a, waist: b, ambiguous: true };
}

/**
 * Format the disambiguation confirmation prompt.
 *
 * Returns text only — the keyboard is a separate export from keyboards.ts.
 */
export function formatDisambiguationPrompt(weight: number, waist: number): string {
  return `Is that ${weight} kg weight and ${waist} cm waist?`;
}
