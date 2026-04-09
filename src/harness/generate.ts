/**
 * Scenario fixture generator.
 *
 * A standalone CLI that runs a scenario's `spec.ts` against the REAL LLM,
 * captures every call's request/response pair as an `LLMFixture`, and
 * writes the complete expectations to `recorded.json` in the scenario
 * directory.
 *
 * ## Why this is a separate script, not part of `node:test`
 *
 * Generate mode is a fixture-writing side-effect, not an assertion. It:
 *   - Talks to the real OpenAI API (spends money, takes real time).
 *   - Must never be triggered implicitly by `npm test` — a silent
 *     auto-generate would burn credits during routine test runs, exactly
 *     the bug class the harness should actively prevent.
 *   - Prompts for confirmation before running and refuses to overwrite
 *     existing recordings without `--regenerate`.
 *
 * None of that fits the unit-test model. A plain CLI at
 * `src/harness/generate.ts` invoked via `npm run test:generate -- <name>`
 * keeps the operation explicit and conscious.
 *
 * ## What it reuses from the runner
 *
 * Everything structural: `freezeClock`, `TestStateStore`, `RecipeDatabase`,
 * `BotCore`, `CapturingOutputSink`. The only difference is the LLM
 * provider — this path wraps the real `OpenAIProvider` in a
 * `RecordingLLMProvider` that logs every call's inputs and outputs as it
 * flies past, so after the event loop finishes we have a complete
 * fixture list ready to serialize.
 *
 * ## Invocation
 *
 *   npm run test:generate -- <scenario-name>                 # first generate
 *   npm run test:generate -- <scenario-name> --regenerate    # overwrite existing
 *   npm run test:generate -- <scenario-name> --regenerate --yes   # skip confirm prompt
 *
 * Exit 0 on success; exit 1 on any error (missing spec, refused overwrite,
 * LLM failure, etc.) so CI can eventually gate on this once it lands.
 */

import { writeFile, readFile, stat, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { copyRecipeSetToTmp } from './recipe-sandbox.js';
import { pathToFileURL } from 'node:url';
import { createBotCore, type BotCoreDeps, type HarnessUpdate } from '../telegram/core.js';
import { RecipeDatabase } from '../recipes/database.js';
import { OpenAIProvider } from '../ai/openai.js';
import { hashRequest, type LLMFixture } from '../ai/fixture.js';
import type {
  LLMProvider,
  CompletionOptions,
  CompletionResult,
} from '../ai/provider.js';
import { CapturingOutputSink } from './capturing-sink.js';
import { TestStateStore } from './test-store.js';
import { freezeClock } from './clock.js';
import { hashSpec } from './define.js';
import { normalizeUuids } from './normalize.js';
import type { Scenario, ScenarioEvent, RecordedScenario } from './types.js';

const SCENARIOS_ROOT = 'test/scenarios';
const RECIPE_FIXTURES_ROOT = 'test/fixtures/recipes';

// ─── CLI arg parsing ──────────────────────────────────────────────────────────

interface CliArgs {
  scenarioName: string;
  regenerate: boolean;
  yes: boolean;
}

/**
 * Parse `process.argv` into the CLI shape. Accepts `<name>` as the first
 * positional arg and `--regenerate` / `--yes` as flags. Any unknown flag
 * fails loudly rather than being silently dropped — the operation is too
 * expensive to tolerate typos.
 */
function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let scenarioName: string | undefined;
  let regenerate = false;
  let yes = false;

  for (const arg of args) {
    if (arg === '--regenerate') regenerate = true;
    else if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}\nUsage: npm run test:generate -- <scenario-name> [--regenerate] [--yes]`);
    } else if (!scenarioName) {
      scenarioName = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }

  if (!scenarioName) {
    throw new Error('Missing scenario name.\nUsage: npm run test:generate -- <scenario-name> [--regenerate] [--yes]');
  }

  return { scenarioName, regenerate, yes };
}

// ─── Recording LLM wrapper ────────────────────────────────────────────────────

/**
 * Wraps a real `LLMProvider` and captures every `complete()` call as an
 * `LLMFixture`. `transcribe()` is passed through untouched because voice
 * scenarios pre-transcribe in the spec — generate mode should never
 * actually invoke Whisper.
 *
 * Each captured fixture stores the request hash (so replay can look it
 * up) alongside enough original-request metadata (`messages`, `model`,
 * etc.) to enable diagnostic diffs in `MissingFixtureError`.
 */
class RecordingLLMProvider implements LLMProvider {
  readonly fixtures: LLMFixture[] = [];
  private callIndex = 0;

  constructor(private readonly inner: LLMProvider) {}

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    this.callIndex += 1;
    const hash = hashRequest(options);
    const result = await this.inner.complete(options);
    this.fixtures.push({
      hash,
      callIndex: this.callIndex,
      model: options.model,
      reasoning: options.reasoning,
      json: options.json,
      maxTokens: options.maxTokens,
      messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
      response: result.content,
      usage: result.usage,
    });
    return result;
  }

  async transcribe(audioBuffer: Buffer): Promise<string> {
    // Generate mode should not see voice events at all — `voice()` helpers
    // in specs carry pre-transcribed text. If we ever hit this, something
    // is wrong upstream.
    return this.inner.transcribe(audioBuffer);
  }
}

// ─── Dispatch translation ─────────────────────────────────────────────────────

/**
 * Same as the runner's `toUpdate` helper — scenario events translate
 * straight into `HarnessUpdate` variants. Duplicated rather than extracted
 * because the runner and the generator have slightly different concerns
 * and keeping them self-contained avoids a generic helper that neither
 * fully owns.
 */
function toUpdate(event: ScenarioEvent): HarnessUpdate {
  switch (event.type) {
    case 'command':
      return event.args !== undefined
        ? { type: 'command', command: event.command, args: event.args }
        : { type: 'command', command: event.command };
    case 'text':
      return { type: 'text', text: event.text };
    case 'callback':
      return { type: 'callback', data: event.data };
    case 'voice':
      return { type: 'voice', transcribedText: event.transcribedText };
  }
}

// ─── Confirmation prompt ──────────────────────────────────────────────────────

/**
 * Print a warning and wait for a single keystroke on stdin. Returns
 * immediately if stdin isn't a TTY (e.g., piped from a script) — the
 * assumption is that non-interactive invocations already know what
 * they're doing. `--yes` also bypasses the prompt.
 */
async function confirmOrExit(message: string, yes: boolean): Promise<void> {
  console.log(`⚠ ${message}`);
  if (yes) {
    console.log('  (--yes supplied, skipping confirmation)');
    return;
  }
  if (!process.stdin.isTTY) {
    console.log('  (stdin is not a TTY, proceeding automatically)');
    return;
  }
  process.stdout.write('  Press any key to proceed, or Ctrl-C to abort... ');
  await new Promise<void>((resolvePromise) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      resolvePromise();
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Load a scenario spec file from its directory. Throws with an actionable
 * error if the file is missing or doesn't export a default Scenario.
 */
async function loadSpec(dir: string): Promise<Scenario> {
  const specPath = join(dir, 'spec.ts');
  const mod = await import(pathToFileURL(specPath).href);
  const spec: Scenario | undefined = mod.default;
  if (!spec) {
    throw new Error(`${specPath} must export a default Scenario via defineScenario`);
  }
  return spec;
}

/**
 * Run the generate pipeline for a single scenario. Returns on success;
 * throws on any failure so `main` can exit with a non-zero code.
 */
async function generateScenario(args: CliArgs): Promise<void> {
  const dir = resolve(SCENARIOS_ROOT, args.scenarioName);
  const dirStat = await stat(dir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    throw new Error(`Scenario directory not found: ${dir}`);
  }

  const recordedPath = join(dir, 'recorded.json');
  const recordedStat = await stat(recordedPath).catch(() => null);
  if (recordedStat && !args.regenerate) {
    throw new Error(
      `Recording already exists at ${recordedPath}.\n` +
        'Use --regenerate to overwrite (reviews the diff carefully before committing).',
    );
  }

  const spec = await loadSpec(dir);
  console.log(`Scenario: ${spec.name}`);
  console.log(`  ${spec.description}`);
  console.log(`  clock: ${spec.clock}`);
  console.log(`  recipeSet: ${spec.recipeSet}`);
  console.log(`  events: ${spec.events.length}`);

  await confirmOrExit(
    'Generating fixtures calls the real LLM and may cost money.',
    args.yes,
  );

  // ─── Wire up the scenario ─────────────────────────────────────────────
  const clock = freezeClock(spec.clock);
  try {
    // Recipe database loaded from a temp copy so recipe generation
    // during the scenario doesn't pollute the shared fixture set.
    const fixtureRecipePath = join(RECIPE_FIXTURES_ROOT, spec.recipeSet);
    const tmpRecipeDir = await copyRecipeSetToTmp(fixtureRecipePath);
    const recipes = new RecipeDatabase(tmpRecipeDir);
    await recipes.load();
    if (recipes.size === 0) {
      throw new Error(
        `Recipe set "${spec.recipeSet}" has no recipes at ${fixtureRecipePath}`,
      );
    }

    const llm = new RecordingLLMProvider(new OpenAIProvider());
    const store = new TestStateStore({
      session: spec.initialState.session ?? null,
      planSessions: spec.initialState.planSessions,
      batches: spec.initialState.batches,
      measurements: spec.initialState.measurements,
    });
    const deps: BotCoreDeps = { llm, recipes, store };
    const core = createBotCore(deps);
    const sink = new CapturingOutputSink();

    // ─── Drive the event loop ───────────────────────────────────────────
    console.log(`\nRunning ${spec.events.length} events through BotCore...`);
    for (let i = 0; i < spec.events.length; i++) {
      const event = spec.events[i]!;
      const summary = summarizeEvent(event);
      console.log(`  ${i + 1}/${spec.events.length}: ${summary}`);
      await core.dispatch(toUpdate(event), sink);
    }

    // ─── Serialize and write ────────────────────────────────────────────
    // Normalize UUIDs to placeholder tokens before writing the recording,
    // matching the runner's normalization so replay comparisons succeed.
    // See `src/harness/normalize.ts` for the full rationale.
    const recorded: RecordedScenario = {
      generatedAt: new Date().toISOString(),
      specHash: hashSpec(spec),
      llmFixtures: llm.fixtures,
      expected: {
        outputs: normalizeUuids(JSON.parse(JSON.stringify(sink.captured))),
        finalSession: normalizeUuids(JSON.parse(JSON.stringify(core.session))),
        finalStore: normalizeUuids(JSON.parse(JSON.stringify(store.snapshot()))),
      },
    };

    await mkdir(dirname(recordedPath), { recursive: true });
    await writeFile(recordedPath, JSON.stringify(recorded, null, 2) + '\n', 'utf-8');

    // ─── Summary ────────────────────────────────────────────────────────
    const inputTokens = llm.fixtures.reduce((sum, f) => sum + f.usage.inputTokens, 0);
    const outputTokens = llm.fixtures.reduce((sum, f) => sum + f.usage.outputTokens, 0);
    console.log('\n✓ Recording written');
    console.log(`  path:          ${recordedPath}`);
    console.log(`  outputs:       ${sink.captured.length}`);
    console.log(`  llm fixtures:  ${llm.fixtures.length}`);
    console.log(`  input tokens:  ${inputTokens.toLocaleString()}`);
    console.log(`  output tokens: ${outputTokens.toLocaleString()}`);
    console.log(`  specHash:      ${recorded.specHash.slice(0, 12)}…`);
    // Check for fixture-edits.md — scenarios with manually edited fixtures
    // need the edits re-applied after every regeneration.
    const fixtureEditsPath = join(dir, 'fixture-edits.md');
    const hasFixtureEdits = await stat(fixtureEditsPath).catch(() => null);
    if (hasFixtureEdits) {
      const editsContent = await readFile(fixtureEditsPath, 'utf-8');
      console.log('\n' + '='.repeat(70));
      console.log('⚠⚠⚠  THIS SCENARIO HAS MANUAL FIXTURE EDITS  ⚠⚠⚠');
      console.log('='.repeat(70));
      console.log(`\nYou MUST apply the edits described in:\n  ${fixtureEditsPath}\n`);
      console.log(`Then run: npm run test:replay -- ${spec.name}`);
      console.log('Review recorded.json via `git diff`, then run `npm test`.');
      console.log('Never run --regenerate after applying edits; it will destroy them.\n');
      console.log(editsContent);
      console.log('='.repeat(70));
    } else {
      console.log(
        '\nNext: review recorded.json via `git diff`, then commit if the transcript looks right.',
      );
    }
  } finally {
    clock.restore();
  }
}

/** Compact one-line description of a scenario event for progress output. */
function summarizeEvent(event: ScenarioEvent): string {
  switch (event.type) {
    case 'command':
      return `command /${event.command}${event.args ? ' ' + event.args : ''}`;
    case 'text':
      return `text "${truncateForLog(event.text)}"`;
    case 'callback':
      return `click ${event.data}`;
    case 'voice':
      return `voice "${truncateForLog(event.transcribedText)}"`;
  }
}

function truncateForLog(s: string): string {
  const flat = s.replace(/\s+/g, ' ');
  return flat.length > 60 ? flat.slice(0, 60) + '…' : flat;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv);
    await generateScenario(args);
  } catch (err) {
    console.error('\n✗ ' + (err instanceof Error ? err.message : String(err)));
    if (err instanceof Error && err.stack) {
      console.error(err.stack.split('\n').slice(1).join('\n'));
    }
    process.exit(1);
  }
}

main();
