/**
 * Certification stamp format for scenario-level behavioral verification.
 *
 * Plan 031 Phase 6. A scenario's `certification.json` records that its
 * on-disk `spec.ts`, `assertions.ts`, and `recorded.json` passed the full
 * verification pipeline (replay + global invariants + `assertBehavior` +
 * fixture-edit guardrail + three `deepStrictEqual` checks) at a specific
 * point in time. If any of the three source files is touched after the
 * stamp is written, the stored hashes stop matching and the derived
 * status flips from `certified` to `needs-review`.
 *
 * ## Status state machine
 *
 * The stored status field is one of `'certified'` or `'obsolete'`. The
 * *derived* status returned by `deriveStatus` is one of:
 *
 *   - `'certified'`   — stamp exists, stored status is `certified`, all
 *                       three hashes still match on disk.
 *   - `'needs-review'`— stamp exists, stored status is `certified`, but
 *                       at least one on-disk hash differs.
 *   - `'uncertified'` — no stamp file present (or stamp is malformed).
 *   - `'obsolete'`    — stamp exists with stored status `obsolete`. This
 *                       is sticky: hash drift does NOT flip it back to
 *                       `needs-review`, because an obsolete scenario is
 *                       excluded from certification coverage regardless.
 *
 * ## Hash semantics
 *
 * Hashes are sha256 over the raw working-tree file bytes (NOT git HEAD).
 * The working tree is what the agent is about to `--accept` — HEAD may
 * lag or be empty on first-time stamping. Rationale in the Plan 031
 * decision log.
 *
 * Note: `recorded.json.specHash` is a different kind of hash (canonical
 * JSON of the scenario's input-defining fields, produced by `hashSpec`
 * in `define.ts`). The `specHash` field on `CertificationStamp` is a
 * whole-file hash of `spec.ts`. They answer different questions:
 *
 *   - `recorded.specHash`        → "scenario definition drifted, regenerate".
 *   - `certification.specHash`   → "spec.ts file touched since last review".
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export type CertificationStoredStatus = 'certified' | 'obsolete';
export type CertificationStatus =
  | 'certified'
  | 'needs-review'
  | 'uncertified'
  | 'obsolete';

export interface CertificationStamp {
  /** ISO timestamp at which the stamp was written. */
  reviewedAt: string;
  /** sha256 of `spec.ts` raw bytes at review time. */
  specHash: string;
  /** sha256 of `assertions.ts` raw bytes at review time. Empty string if none. */
  assertionsHash: string;
  /** sha256 of `recorded.json` raw bytes at review time. */
  recordingHash: string;
  /** Stored status — see module doc. */
  status: CertificationStoredStatus;
}

export interface CurrentHashes {
  specHash: string;
  assertionsHash: string;
  recordingHash: string;
}

/** sha256 hex over `path`'s raw bytes. Throws ENOENT for missing paths unless `optional`. */
export async function hashFile(path: string, optional = false): Promise<string> {
  const exists = await stat(path).catch(() => null);
  if (!exists?.isFile()) {
    if (optional) return '';
    throw new Error(`hashFile: not a file: ${path}`);
  }
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Compute current on-disk hashes for a scenario directory.
 *
 * `spec.ts` and `recorded.json` are required; a missing file throws. The
 * caller (review CLI, for example) handles the resulting error by
 * reporting the scenario as "cannot certify — missing file".
 *
 * `assertions.ts` is optional — if missing, `assertionsHash` is the empty
 * string. A stamp that was written when `assertions.ts` did NOT exist
 * will have `assertionsHash = ''`; `deriveStatus` compares strings, so
 * this Just Works.
 */
export async function currentHashes(dir: string): Promise<CurrentHashes> {
  const [specHash, assertionsHash, recordingHash] = await Promise.all([
    hashFile(join(dir, 'spec.ts')),
    hashFile(join(dir, 'assertions.ts'), /* optional */ true),
    hashFile(join(dir, 'recorded.json')),
  ]);
  return { specHash, assertionsHash, recordingHash };
}

/**
 * Load `<dir>/certification.json` if present. Returns `undefined` when the
 * file is absent OR when parsing fails (malformed files are treated as if
 * they don't exist — the derived status then surfaces as `uncertified`,
 * prompting the agent to regenerate the stamp).
 */
export async function loadStamp(dir: string): Promise<CertificationStamp | undefined> {
  const path = join(dir, 'certification.json');
  const exists = await stat(path).catch(() => null);
  if (!exists?.isFile()) return undefined;
  try {
    const text = await readFile(path, 'utf-8');
    const parsed = JSON.parse(text) as Partial<CertificationStamp>;
    if (!isValidStamp(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Write `<dir>/certification.json` — pretty-printed with a trailing newline
 * so the file plays nicely with git diffs.
 */
export async function writeStamp(dir: string, stamp: CertificationStamp): Promise<void> {
  const path = join(dir, 'certification.json');
  await writeFile(path, JSON.stringify(stamp, null, 2) + '\n', 'utf-8');
}

/**
 * Derive the review-surface status from a loaded stamp + current on-disk
 * hashes. See module doc for the full matrix.
 */
export function deriveStatus(
  stamp: CertificationStamp | undefined,
  current: CurrentHashes,
): CertificationStatus {
  if (!stamp) return 'uncertified';
  if (stamp.status === 'obsolete') return 'obsolete';
  // stamp.status === 'certified'
  const matches =
    stamp.specHash === current.specHash &&
    stamp.assertionsHash === current.assertionsHash &&
    stamp.recordingHash === current.recordingHash;
  return matches ? 'certified' : 'needs-review';
}

function isValidStamp(obj: unknown): obj is CertificationStamp {
  if (!obj || typeof obj !== 'object') return false;
  const s = obj as Partial<CertificationStamp>;
  return (
    typeof s.reviewedAt === 'string' &&
    typeof s.specHash === 'string' &&
    typeof s.assertionsHash === 'string' &&
    typeof s.recordingHash === 'string' &&
    (s.status === 'certified' || s.status === 'obsolete')
  );
}
