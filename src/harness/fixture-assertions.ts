/**
 * Optional scenario-local assertions for manually edited LLM fixtures.
 *
 * A scenario can export `assertFixtureEdits(recorded)` from
 * `fixture-assertions.ts` next to its `spec.ts`. The harness calls it before
 * replaying fixtures so hand-edited malformed responses cannot be silently
 * replaced by a fresh valid LLM recording.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RecordedScenario } from './types.js';

export type FixtureEditAssertion = (
  recorded: RecordedScenario,
) => void | Promise<void>;

interface FixtureAssertionsModule {
  assertFixtureEdits?: FixtureEditAssertion;
}

export async function runFixtureEditAssertions(
  dir: string,
  recorded: RecordedScenario,
): Promise<void> {
  const assertionsPath = join(dir, 'fixture-assertions.ts');
  const assertionsStat = await stat(assertionsPath).catch(() => null);
  if (!assertionsStat?.isFile()) {
    return;
  }

  const mod = await import(pathToFileURL(assertionsPath).href) as FixtureAssertionsModule;
  if (typeof mod.assertFixtureEdits !== 'function') {
    throw new Error(`${assertionsPath} must export assertFixtureEdits(recorded)`);
  }

  await mod.assertFixtureEdits(recorded);
}
