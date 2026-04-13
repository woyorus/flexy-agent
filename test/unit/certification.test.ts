/**
 * Unit coverage for `deriveStatus` + `hashFile` + `loadStamp` / `writeStamp`.
 *
 * Plan 031 Phase 6. Focuses on the status derivation matrix:
 *
 *   - Absent stamp → `uncertified`
 *   - Stored `certified` + all hashes match → `certified`
 *   - Stored `certified` + any hash differs → `needs-review`
 *   - Stored `obsolete` + all hashes match → `obsolete`
 *   - Stored `obsolete` + hash drift → `obsolete` (sticky)
 *   - Malformed stamp file → `undefined` from `loadStamp` → `uncertified`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  hashFile,
  currentHashes,
  loadStamp,
  writeStamp,
  deriveStatus,
  type CertificationStamp,
  type CurrentHashes,
} from '../../src/harness/certification.js';

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'certification-'));
}

function stamp(overrides: Partial<CertificationStamp> = {}): CertificationStamp {
  return {
    reviewedAt: '2026-04-13T12:00:00.000Z',
    specHash: 'a'.repeat(64),
    assertionsHash: 'b'.repeat(64),
    recordingHash: 'c'.repeat(64),
    status: 'certified',
    ...overrides,
  };
}

function hashes(overrides: Partial<CurrentHashes> = {}): CurrentHashes {
  return {
    specHash: 'a'.repeat(64),
    assertionsHash: 'b'.repeat(64),
    recordingHash: 'c'.repeat(64),
    ...overrides,
  };
}

// ─── deriveStatus matrix ───────────────────────────────────────────────────

test('deriveStatus: absent stamp → uncertified', () => {
  assert.equal(deriveStatus(undefined, hashes()), 'uncertified');
});

test('deriveStatus: stored certified + matching hashes → certified', () => {
  assert.equal(deriveStatus(stamp(), hashes()), 'certified');
});

test('deriveStatus: stored certified + specHash drift → needs-review', () => {
  assert.equal(
    deriveStatus(stamp(), hashes({ specHash: 'z'.repeat(64) })),
    'needs-review',
  );
});

test('deriveStatus: stored certified + assertionsHash drift → needs-review', () => {
  assert.equal(
    deriveStatus(stamp(), hashes({ assertionsHash: 'z'.repeat(64) })),
    'needs-review',
  );
});

test('deriveStatus: stored certified + recordingHash drift → needs-review', () => {
  assert.equal(
    deriveStatus(stamp(), hashes({ recordingHash: 'z'.repeat(64) })),
    'needs-review',
  );
});

test('deriveStatus: stored obsolete + matching hashes → obsolete', () => {
  assert.equal(deriveStatus(stamp({ status: 'obsolete' }), hashes()), 'obsolete');
});

test('deriveStatus: stored obsolete + any hash drift → obsolete (sticky)', () => {
  assert.equal(
    deriveStatus(
      stamp({ status: 'obsolete' }),
      hashes({ specHash: 'z'.repeat(64) }),
    ),
    'obsolete',
  );
});

// ─── hashFile ──────────────────────────────────────────────────────────────

test('hashFile: returns deterministic sha256 over raw bytes', async () => {
  const dir = await makeDir();
  const path = join(dir, 'f.txt');
  await writeFile(path, 'hello world', 'utf-8');
  const h = await hashFile(path);
  // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
  assert.equal(h, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
});

test('hashFile: returns empty string for missing file when optional', async () => {
  const dir = await makeDir();
  const h = await hashFile(join(dir, 'nope.txt'), /* optional */ true);
  assert.equal(h, '');
});

test('hashFile: throws for missing file when not optional', async () => {
  const dir = await makeDir();
  await assert.rejects(() => hashFile(join(dir, 'nope.txt')), /not a file/);
});

// ─── currentHashes ─────────────────────────────────────────────────────────

test('currentHashes: reads spec.ts + assertions.ts + recorded.json', async () => {
  const dir = await makeDir();
  await writeFile(join(dir, 'spec.ts'), 'spec-body', 'utf-8');
  await writeFile(join(dir, 'assertions.ts'), 'assert-body', 'utf-8');
  await writeFile(join(dir, 'recorded.json'), '{}', 'utf-8');
  const h = await currentHashes(dir);
  assert.equal(h.specHash.length, 64);
  assert.equal(h.assertionsHash.length, 64);
  assert.equal(h.recordingHash.length, 64);
  // Different files MUST produce different hashes.
  assert.notEqual(h.specHash, h.assertionsHash);
  assert.notEqual(h.assertionsHash, h.recordingHash);
});

test('currentHashes: assertionsHash is empty string when assertions.ts missing', async () => {
  const dir = await makeDir();
  await writeFile(join(dir, 'spec.ts'), 'spec-body', 'utf-8');
  await writeFile(join(dir, 'recorded.json'), '{}', 'utf-8');
  const h = await currentHashes(dir);
  assert.equal(h.assertionsHash, '');
});

// ─── loadStamp / writeStamp round-trip ─────────────────────────────────────

test('loadStamp: returns undefined for missing stamp file', async () => {
  const dir = await makeDir();
  const loaded = await loadStamp(dir);
  assert.equal(loaded, undefined);
});

test('writeStamp + loadStamp round-trip preserves every field', async () => {
  const dir = await makeDir();
  const original = stamp({ reviewedAt: '2026-04-13T15:30:00.000Z' });
  await writeStamp(dir, original);
  const loaded = await loadStamp(dir);
  assert.deepEqual(loaded, original);
  // File is pretty-printed with trailing newline — light sanity check.
  const raw = await readFile(join(dir, 'certification.json'), 'utf-8');
  assert.ok(raw.endsWith('\n'), 'stamp file must end with newline');
  assert.ok(raw.includes('\n  '), 'stamp file must be pretty-printed');
});

test('loadStamp: returns undefined for malformed JSON', async () => {
  const dir = await makeDir();
  await writeFile(join(dir, 'certification.json'), '{ not json', 'utf-8');
  assert.equal(await loadStamp(dir), undefined);
});

test('loadStamp: returns undefined for JSON missing required fields', async () => {
  const dir = await makeDir();
  await writeFile(
    join(dir, 'certification.json'),
    JSON.stringify({ reviewedAt: 'x', status: 'certified' }),
    'utf-8',
  );
  assert.equal(await loadStamp(dir), undefined);
});

test('loadStamp: returns undefined for unknown status value', async () => {
  const dir = await makeDir();
  await writeStamp(dir, stamp());
  // Hand-corrupt the status field.
  const raw = await readFile(join(dir, 'certification.json'), 'utf-8');
  await writeFile(
    join(dir, 'certification.json'),
    raw.replace('"certified"', '"bogus"'),
    'utf-8',
  );
  assert.equal(await loadStamp(dir), undefined);
});
