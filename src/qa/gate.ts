/**
 * QA gate — the reliability mechanism that validates all outputs before they reach the user.
 *
 * Every output the harness produces — weekly plans, scaled recipes, shopping lists —
 * must pass validation before being shown. If validation fails, the gate retries up to
 * 3 times with fix instructions. If still failing, the best attempt is returned with
 * a visible warning.
 *
 * This file provides the retry-loop wrapper. Actual validation rules live in
 * `qa/validators/plan.ts`, `qa/validators/recipe.ts`, and `qa/validators/shopping-list.ts`.
 *
 * Flow (see docs/product-specs/solver.md § QA gate):
 *   Output → QA Gate → PASS → show to user
 *                    → FAIL → fix + retry (max 3) → still failing → show best + warning
 */

const MAX_RETRIES = 3;

export interface GateResult<T> {
  output: T;
  passed: boolean;
  errors: string[];
  warnings: string[];
  attempts: number;
}

/**
 * Run an output through the QA gate with a retry loop.
 *
 * @param initialOutput - The first attempt at the output
 * @param validate - Function that checks constraints, returns errors/warnings
 * @param fix - Function that attempts to fix a failed output given the errors.
 *              Receives the failed output and the error list. Returns a corrected output.
 *              Only called for LLM/solver outputs — shopping lists are deterministic
 *              and should never need fixing.
 * @returns The best output, whether it passed or not, plus metadata
 */
export async function qaGate<T>(
  initialOutput: T,
  validate: (output: T) => { valid: boolean; errors: string[]; warnings: string[] },
  fix?: (output: T, errors: string[]) => Promise<T>,
): Promise<GateResult<T>> {
  let current = initialOutput;
  let attempts = 1;

  const result = validate(current);
  if (result.valid) {
    return {
      output: current,
      passed: true,
      errors: [],
      warnings: result.warnings,
      attempts,
    };
  }

  // Retry loop
  let lastErrors = result.errors;
  let lastWarnings = result.warnings;

  while (attempts < MAX_RETRIES && fix) {
    attempts++;
    current = await fix(current, lastErrors);
    const retryResult = validate(current);
    lastErrors = retryResult.errors;
    lastWarnings = retryResult.warnings;

    if (retryResult.valid) {
      return {
        output: current,
        passed: true,
        errors: [],
        warnings: retryResult.warnings,
        attempts,
      };
    }
  }

  // Failed after all retries — return best attempt with warning
  return {
    output: current,
    passed: false,
    errors: lastErrors,
    warnings: lastWarnings,
    attempts,
  };
}
