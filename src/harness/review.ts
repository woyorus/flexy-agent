/**
 * `npm run review` — scenario-level behavioral review CLI.
 *
 * Plan 031 Phase 7-10. Three modes, all accessible from the same entry
 * point:
 *
 *   1. Suite list    (no positional arg): list every scenario with its
 *      derived certification status.
 *   2. Probe report  (`npm run review <scenario>`): render a structured
 *      report — purpose, transcript, derived plan view, invariant results,
 *      `assertBehavior` result, execution-trace summary, certification
 *      status. (Phase 8.)
 *   3. --live / --accept — modifiers on the probe report that (Phase 9)
 *      swap the fixture LLM for the real one or (Phase 10) verify + stamp
 *      the scenario as `certified`.
 *
 * See `docs/product-specs/testing.md` § "Certification workflow" for the
 * user-facing doc and design doc 004 for rationale.
 */

import { basename, resolve } from 'node:path';
import {
  currentHashes,
  deriveStatus,
  loadStamp,
  writeStamp,
  type CertificationStamp,
  type CertificationStatus,
  type CertificationStoredStatus,
} from './certification.js';
import { discoverScenarios, loadScenario, type LoadedScenario } from './loader.js';
import { loadAssertions, type LoadedAssertions } from './assertions-loader.js';
import { runScenario } from './runner.js';
import { runGlobalInvariants, type InvariantResult } from './invariants.js';
import { buildAssertionsContext } from './assertions-context.js';
import { renderDerivedPlanView } from './domain-helpers.js';
import type { ExecTrace } from './trace.js';
import type { CapturedOutput, RecordedScenario, Scenario, ScenarioResult } from './types.js';
import assert from 'node:assert/strict';

const SCENARIOS_ROOT = 'test/scenarios';

// ─── CLI arg parsing ──────────────────────────────────────────────────────────

interface ReviewArgs {
  scenarioName?: string;
  live: boolean;
  accept: boolean;
  filterNeedsReview: boolean;
  filterStatus?: CertificationStoredStatus;
}

/**
 * Parse `process.argv` into the review CLI shape. Unknown flags fail
 * loudly; `--live` + `--accept` is explicitly rejected because certification
 * reflects on-disk state and live behavior is transient.
 */
function parseArgs(argv: string[]): ReviewArgs {
  const args = argv.slice(2);
  let scenarioName: string | undefined;
  let live = false;
  let accept = false;
  let filterNeedsReview = false;
  let filterStatus: CertificationStoredStatus | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--live') {
      live = true;
    } else if (arg === '--accept') {
      accept = true;
    } else if (arg === '--needs-review') {
      filterNeedsReview = true;
    } else if (arg === '--status') {
      const next = args[++i];
      if (next !== 'certified' && next !== 'obsolete') {
        throw new Error(
          `--status must be followed by 'certified' or 'obsolete' (got: ${next ?? '<missing>'})`,
        );
      }
      filterStatus = next;
    } else if (arg.startsWith('--status=')) {
      const val = arg.slice('--status='.length);
      if (val !== 'certified' && val !== 'obsolete') {
        throw new Error(`--status= must be 'certified' or 'obsolete' (got: ${val})`);
      }
      filterStatus = val;
    } else if (arg.startsWith('--')) {
      throw new Error(
        `Unknown flag: ${arg}\n` +
          `Usage: npm run review [<scenario-name>] [--live] [--accept] [--needs-review] [--status=certified|obsolete]`,
      );
    } else if (!scenarioName) {
      scenarioName = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }

  if (live && accept) {
    throw new Error(
      '--live and --accept do not combine — certification reflects on-disk state, not live behavior',
    );
  }

  return { scenarioName, live, accept, filterNeedsReview, filterStatus };
}

// ─── Suite list mode ─────────────────────────────────────────────────────────

interface RowSummary {
  name: string;
  status: CertificationStatus;
  purpose?: string;
}

async function buildRow(dir: string): Promise<RowSummary> {
  const name = basename(dir);
  const stamp = await loadStamp(dir);
  const hashes = await currentHashes(dir).catch(() => undefined);
  if (!hashes) {
    // Missing spec.ts or recorded.json — treat as uncertified with a note.
    return { name, status: 'uncertified' };
  }
  const status = deriveStatus(stamp, hashes);
  const loaded = await loadAssertions(dir).catch(() => undefined);
  return { name, status, purpose: loaded?.purpose };
}

function padStatus(status: CertificationStatus): string {
  // Longest status is 'needs-review' (12 chars).
  return status.padEnd(12);
}

async function listAllScenarios(args: ReviewArgs): Promise<void> {
  const dirs = await discoverScenarios(SCENARIOS_ROOT);
  const rows: RowSummary[] = [];
  for (const dir of dirs) rows.push(await buildRow(dir));

  const counts = {
    certified: 0,
    'needs-review': 0,
    uncertified: 0,
    obsolete: 0,
  };
  for (const r of rows) counts[r.status] += 1;

  const filtered = rows.filter((r) => {
    if (args.filterNeedsReview) {
      return r.status === 'uncertified' || r.status === 'needs-review';
    }
    if (args.filterStatus) {
      return r.status === args.filterStatus;
    }
    return true;
  });

  console.log(
    `Scenarios: ${rows.length} total — ` +
      `certified ${counts.certified}, needs-review ${counts['needs-review']}, ` +
      `uncertified ${counts.uncertified}, obsolete ${counts.obsolete}`,
  );
  for (const r of filtered) {
    const purposeSuffix = r.purpose ? `  — ${r.purpose}` : '';
    console.log(`  [${padStatus(r.status)}] ${r.name}${purposeSuffix}`);
  }
}

// ─── Probe report mode (Phase 8 + 9 + 10) ────────────────────────────────────

interface ProbeRenderInput {
  dir: string;
  scenarioName: string;
  spec: Scenario;
  recorded: RecordedScenario;
  result: ScenarioResult;
  loaded: LoadedAssertions | undefined;
  invariantResults: InvariantResult[];
  assertBehaviorOutcome: { ran: boolean; passed: boolean; error?: string };
  live: boolean;
}

async function renderProbeReport(input: ProbeRenderInput): Promise<void> {
  const { dir, scenarioName, spec, recorded, result, loaded, invariantResults, assertBehaviorOutcome, live } = input;

  console.log(`══ Scenario: ${scenarioName} ══`);
  if (live) {
    console.log('── LIVE mode (read-only; no writes) ──');
  }
  console.log('');

  // Purpose
  console.log('Purpose:');
  if (loaded?.purpose) {
    for (const line of wrap(loaded.purpose, 78)) console.log(`  ${line}`);
  } else {
    console.log('  (no assertions.ts — legacy scenario, uncertified)');
  }
  console.log('');

  // Transcript
  console.log(`── Transcript (${result.outputs.length} outputs) ──`);
  result.outputs.forEach((o, i) => renderOutput(i + 1, o));
  console.log('');

  // Derived plan view — only when the scenario has planning context.
  const assertionsCtx = buildAssertionsContext({
    spec,
    outputs: result.outputs,
    finalSession: result.finalSession,
    finalStore: result.finalStore,
    sessionAt: result.sessionAt,
    execTrace: result.execTrace ?? {
      handlers: [],
      dispatcherActions: [],
      validatorRetries: [],
      persistenceOps: [],
      swapOps: [],
    },
  });
  const derivedView = renderDerivedPlanView(assertionsCtx);
  if (derivedView) {
    console.log('── Derived plan view ──');
    console.log(derivedView);
    console.log('');
  }

  // Global invariants
  console.log('── Global invariants ──');
  for (const r of invariantResults) {
    const tag = r.passed ? 'PASS' : 'FAIL';
    const suffix = r.message ? ` — ${r.message}` : '';
    console.log(`  [${tag}] ${r.id}${suffix}`);
  }
  console.log('');

  // assertBehavior
  console.log('── assertBehavior ──');
  if (!assertBehaviorOutcome.ran) {
    console.log('  [SKIP] no assertions.ts (legacy scenario)');
  } else if (assertBehaviorOutcome.passed) {
    console.log('  [PASS] assertBehavior');
  } else {
    console.log('  [FAIL] assertBehavior');
    if (assertBehaviorOutcome.error) {
      for (const line of assertBehaviorOutcome.error.split('\n')) {
        console.log(`         ${line}`);
      }
    }
  }
  console.log('');

  // Execution trace
  const execTrace: ExecTrace = result.execTrace ?? {
    handlers: [],
    dispatcherActions: [],
    validatorRetries: [],
    persistenceOps: [],
      swapOps: [],
  };
  console.log('── Execution trace ──');
  renderTrace(execTrace);
  console.log('');

  // Certification status (always from on-disk state)
  await renderCertificationStatus(dir, loaded, live);
}

function renderOutput(n: number, o: CapturedOutput): void {
  const text = o.text.length > 180 ? o.text.slice(0, 177) + '…' : o.text;
  const firstLine = text.split('\n')[0];
  const multilineMarker = text.includes('\n') ? ' ⏎' : '';
  console.log(`  [${n}] text: ${JSON.stringify(firstLine)}${multilineMarker}`);
  if (!o.keyboard) return;
  if (o.keyboard.kind === 'reply') {
    const flat = o.keyboard.buttons.map((row) => row.join(' | ')).join(' / ');
    console.log(`      reply: [${flat}]`);
  } else {
    const flat = o.keyboard.buttons
      .map((row) => row.map((b) => b.label).join(' | '))
      .join(' / ');
    console.log(`      inline: [${flat}]`);
  }
}

function renderTrace(trace: ExecTrace): void {
  const handlers = trace.handlers.length > 0 ? trace.handlers.join(', ') : '(none)';
  const dispatcherActions =
    trace.dispatcherActions.length > 0
      ? trace.dispatcherActions.map((d) => d.action).join(', ')
      : '(none)';
  const validatorRetries =
    trace.validatorRetries.length > 0
      ? trace.validatorRetries
          .map((r) => `${r.validator}: attempt ${r.attempt} (${r.errors.length} error(s))`)
          .join('; ')
      : '(none)';
  const persistenceOps =
    trace.persistenceOps.length > 0
      ? trace.persistenceOps.map((p) => p.op).join(', ')
      : '(none)';
  console.log(`  Handlers:           ${handlers}`);
  console.log(`  Dispatcher actions: ${dispatcherActions}`);
  console.log(`  Validator retries:  ${validatorRetries}`);
  console.log(`  Persistence ops:    ${persistenceOps}`);
}

async function renderCertificationStatus(
  dir: string,
  _loaded: LoadedAssertions | undefined,
  live: boolean,
): Promise<void> {
  console.log('── Certification status ──');
  const stamp = await loadStamp(dir);
  const hashes = await currentHashes(dir).catch(() => undefined);
  if (!hashes) {
    console.log('  [uncertified] (missing spec.ts or recorded.json)');
    return;
  }
  const status = deriveStatus(stamp, hashes);
  if (!stamp) {
    console.log('  [uncertified] (no certification.json on disk)');
    return;
  }
  console.log(`  [${status}] (stamp reviewedAt: ${stamp.reviewedAt})`);
  const line = (label: string, stamped: string, current: string) => {
    const ok = stamped === current ? '(matches)' : '(differs)';
    const displayStamped = stamped ? stamped.slice(0, 12) + '…' : '<absent>';
    console.log(`  ${label}: ${displayStamped}  ${ok}`);
  };
  line('specHash      ', stamp.specHash, hashes.specHash);
  line('assertionsHash', stamp.assertionsHash, hashes.assertionsHash);
  line('recordingHash ', stamp.recordingHash, hashes.recordingHash);
  if (live) {
    console.log('');
    console.log('  (live mode made no writes; status reflects on-disk files)');
  }
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + 1 + word.length > width) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function probeScenario(args: ReviewArgs): Promise<void> {
  if (!args.scenarioName) throw new Error('probe mode requires a scenario name');
  const dir = resolve(SCENARIOS_ROOT, args.scenarioName);

  const loadedScenario = await loadScenario(dir);
  if (loadedScenario.error) {
    throw new Error(loadedScenario.error);
  }
  if (!loadedScenario.recorded) {
    throw new Error(`No recording at ${dir}/recorded.json`);
  }

  const { spec, recorded } = loadedScenario;

  // Phase 9: --live swaps the fixture LLM for real `OpenAIProvider` and
  // runs the scenario read-only. Otherwise we replay.
  let result: ScenarioResult;
  if (args.live) {
    await confirmOrExit(
      'Running --live calls the real LLM and costs money. Continue? [y/N] ',
    );
    const { runScenarioLive } = await import('./runner.js');
    result = await runScenarioLive(spec);
  } else {
    result = await runScenario(spec, recorded);
  }

  // Run the fixture-edit guardrail (no-op for scenarios without it).
  const { runFixtureEditAssertions } = await import('./assertions-loader.js');
  try {
    await runFixtureEditAssertions(dir, recorded);
  } catch (err) {
    // Don't abort — the probe report should still render. Surface the
    // error as a failed fixture-edit guardrail in the report.
    console.error('fixture-edit guardrail FAILED:', err instanceof Error ? err.message : err);
  }

  const loaded = await loadAssertions(dir);
  const invariantResults = runGlobalInvariants(recorded, result.outputs);

  const assertBehaviorOutcome: ProbeRenderInput['assertBehaviorOutcome'] = {
    ran: !!loaded?.assertBehavior,
    passed: true,
  };
  if (loaded?.assertBehavior) {
    const ctx = buildAssertionsContext({
      spec,
      outputs: result.outputs,
      finalSession: result.finalSession,
      finalStore: result.finalStore,
      sessionAt: result.sessionAt,
      execTrace: result.execTrace ?? {
        handlers: [],
        dispatcherActions: [],
        validatorRetries: [],
        persistenceOps: [],
      swapOps: [],
      },
    });
    try {
      await loaded.assertBehavior(ctx);
    } catch (err) {
      assertBehaviorOutcome.passed = false;
      assertBehaviorOutcome.error = err instanceof Error ? err.message : String(err);
    }
  }

  await renderProbeReport({
    dir,
    scenarioName: args.scenarioName,
    spec,
    recorded,
    result,
    loaded,
    invariantResults,
    assertBehaviorOutcome,
    live: args.live,
  });
}

// ─── --accept (Phase 10) ─────────────────────────────────────────────────────

async function acceptScenario(args: ReviewArgs): Promise<void> {
  if (!args.scenarioName) {
    throw new Error('--accept requires a scenario name');
  }
  if (args.live) {
    throw new Error('--live and --accept do not combine');
  }

  const dir = resolve(SCENARIOS_ROOT, args.scenarioName);
  const loadedScenario = await loadScenario(dir);
  if (loadedScenario.error) {
    throw new Error(`Cannot certify: ${loadedScenario.error}`);
  }
  if (!loadedScenario.recorded) {
    throw new Error(`Cannot certify: no recording at ${dir}/recorded.json`);
  }
  const { spec, recorded } = loadedScenario;

  const loaded = await loadAssertions(dir);
  if (!loaded || typeof loaded.assertBehavior !== 'function' || typeof loaded.purpose !== 'string') {
    throw new Error(
      `Cannot certify: ${dir}/assertions.ts is missing or does not export both ` +
        `\`purpose\` (string) and \`assertBehavior\` (function). Certification ` +
        `requires a full assertions module.`,
    );
  }

  // 1. Fixture-edit guardrail.
  const { runFixtureEditAssertions } = await import('./assertions-loader.js');
  await runFixtureEditAssertions(dir, recorded);

  // 2. Replay (NOT --live — certification reflects on-disk state).
  const result = await runScenario(spec, recorded);

  // 3. Global invariants.
  const invariantResults = runGlobalInvariants(recorded, result.outputs);
  const failedInvariants = invariantResults.filter((r) => !r.passed);
  if (failedInvariants.length > 0) {
    throw new Error(
      `Cannot certify: global invariants failed:\n` +
        failedInvariants.map((r) => `  [${r.id}] ${r.message ?? ''}`).join('\n'),
    );
  }

  // 4. assertBehavior.
  const ctx = buildAssertionsContext({
    spec,
    outputs: result.outputs,
    finalSession: result.finalSession,
    finalStore: result.finalStore,
    sessionAt: result.sessionAt,
    execTrace: result.execTrace ?? {
      handlers: [],
      dispatcherActions: [],
      validatorRetries: [],
      persistenceOps: [],
      swapOps: [],
    },
  });
  await loaded.assertBehavior(ctx);

  // 5. Three existing deepStrictEqual regression checks.
  const mismatches: string[] = [];
  try {
    assert.deepStrictEqual(result.outputs, recorded.expected.outputs);
  } catch {
    mismatches.push('outputs diverged from recorded transcript');
  }
  try {
    assert.deepStrictEqual(result.finalSession, recorded.expected.finalSession);
  } catch {
    mismatches.push('finalSession diverged from recorded state');
  }
  try {
    assert.deepStrictEqual(result.finalStore, recorded.expected.finalStore);
  } catch {
    mismatches.push('finalStore diverged from recorded state');
  }
  if (recorded.expected.sessionAt !== undefined) {
    try {
      assert.deepStrictEqual(result.sessionAt, recorded.expected.sessionAt);
    } catch {
      mismatches.push('sessionAt diverged from recorded per-step state');
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Cannot certify: replay diverges from recording:\n  - ${mismatches.join('\n  - ')}\n` +
        `Regenerate via \`npm run test:generate -- ${spec.name} --regenerate\` first.`,
    );
  }

  // 6. Stamp.
  const hashes = await currentHashes(dir);
  const stamp: CertificationStamp = {
    reviewedAt: new Date().toISOString(),
    specHash: hashes.specHash,
    assertionsHash: hashes.assertionsHash,
    recordingHash: hashes.recordingHash,
    status: 'certified',
  };
  await writeStamp(dir, stamp);

  console.log(`✓ Certified ${args.scenarioName} at ${stamp.reviewedAt}`);
  console.log(`  verification: replay ✓ invariants ✓ assertBehavior ✓ deepStrictEqual ✓`);
  console.log(`  specHash:       ${stamp.specHash.slice(0, 12)}…`);
  console.log(`  assertionsHash: ${stamp.assertionsHash.slice(0, 12)}…`);
  console.log(`  recordingHash:  ${stamp.recordingHash.slice(0, 12)}…`);
}

// ─── Prompt helper (Phase 9) ────────────────────────────────────────────────

async function confirmOrExit(prompt: string): Promise<void> {
  // Reuse generate.ts's pattern: read from stdin synchronously via readline.
  // If stdin is non-interactive, accept the first character of input; on
  // empty input we abort. Matches the policy "--live must be conscious".
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = (await rl.question(prompt)).trim().toLowerCase();
  rl.close();
  if (answer !== 'y' && answer !== 'yes') {
    console.log('Aborted.');
    process.exit(0);
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.accept) {
    await acceptScenario(args);
    return;
  }
  if (args.scenarioName) {
    await probeScenario(args);
    return;
  }
  await listAllScenarios(args);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
