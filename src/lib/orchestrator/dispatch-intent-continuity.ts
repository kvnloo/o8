/**
 * A worker-prompt projection of the admitted mission intent. The existing
 * handoff.packet/v1 transport stays authoritative and unchanged (LavonTMCQ).
 * This projection is evidence, never an authorization or an ACT token.
 */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { IntentContractRef } from '@/lib/orchestrator/aodl-validation';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { readIntentContract } from '@/lib/orchestrator/intent-contract-store';
import { parseIntentContractRef } from '@/lib/orchestrator/intent-reference-resolution';
import { findMissionRegistryEntryByPacketId } from '@/lib/orchestrator/mission-registry';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

export const WORKER_INTENT_CONTINUITY_SCHEMA = 'o8/worker-intent-continuity/v1' as const;
const MAX_RELEVANT_FILES = 8;
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_AUTHORED_DOCUMENT_BYTES = 128 * 1024;

export type WorkerSourceEvidence = {
  path: string;
  status: 'observed' | 'unavailable';
  sha256: string | null;
  reason: string | null;
};

export interface WorkerWorkspaceEvidence {
  status: 'observed' | 'unavailable';
  files: WorkerSourceEvidence[];
  truncated: boolean;
}

export interface WorkerIntentContinuity {
  schema: typeof WORKER_INTENT_CONTINUITY_SCHEMA;
  packetId: string;
  missionId: string | null;
  intent: {
    status: 'available' | 'unavailable';
    ref: IntentContractRef | null;
    document: string | null;
    reason: string | null;
  };
  workspace: WorkerWorkspaceEvidence;
}

function unavailable(path: string, reason: string): WorkerSourceEvidence {
  return { path, status: 'unavailable', sha256: null, reason };
}

function isInside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

async function observeFile(
  workspacePath: string | null | undefined,
  path: string,
): Promise<{ evidence: WorkerSourceEvidence; content: string | null }> {
  const candidate = path.trim();
  if (!candidate || candidate.length > 240 || isAbsolute(candidate)
    || candidate.includes('\\') || candidate.split('/').some((part) => !part || part === '.' || part === '..')
    || /[\x00-\x1f]/.test(candidate) || /[*?\[\]{}]/.test(candidate)) {
    return { evidence: unavailable(path, 'malformed_source_path'), content: null };
  }
  if (!workspacePath) {
    return { evidence: unavailable(path, 'workspace_unavailable'), content: null };
  }
  try {
    const root = await realpath(workspacePath);
    const file = await realpath(resolve(root, candidate));
    if (!isInside(root, file)) {
      return { evidence: unavailable(path, 'source_outside_workspace'), content: null };
    }
    const metadata = await stat(file);
    if (!metadata.isFile()) {
      return { evidence: unavailable(path, 'not_regular_file'), content: null };
    }
    if (metadata.size > MAX_SOURCE_BYTES) {
      return { evidence: unavailable(path, 'source_too_large'), content: null };
    }
    const bytes = await readFile(file);
    if (bytes.length > MAX_SOURCE_BYTES) {
      return { evidence: unavailable(path, 'source_too_large'), content: null };
    }
    return {
      evidence: {
        path,
        status: 'observed',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        reason: null,
      },
      content: bytes.toString('utf8'),
    };
  } catch (error) {
    return {
      evidence: unavailable(
        path,
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing_file' : 'source_read_unavailable',
      ),
      content: null,
    };
  }
}

function evidencePaths(packet: OrchestratorPacket): string[] {
  const candidates = packet.readBudget?.requiredReads?.length
    ? packet.readBudget.requiredReads
    : packet.allowedFiles?.length
      ? packet.allowedFiles
      : packet.predictedFiles ?? [];
  return [...new Set(candidates.filter((entry): entry is string => typeof entry === 'string'))];
}

/**
 * A new dispatch is the only source of this snapshot. Missing evidence is
 * explicitly unavailable; no absent hash is interpreted as a clean checkout.
 */
export async function observeWorkerWorkspace(
  workspacePath: string | null | undefined,
  paths: string[],
): Promise<WorkerWorkspaceEvidence> {
  const unique = [...new Set(paths)];
  const truncated = unique.length > MAX_RELEVANT_FILES;
  const files = await Promise.all(unique.slice(0, MAX_RELEVANT_FILES)
    .map(async (path) => (await observeFile(workspacePath, path)).evidence));
  return {
    status: files.length > 0 && !truncated && files.every((file) => file.status === 'observed')
      ? 'observed'
      : 'unavailable',
    files,
    truncated,
  };
}

function missionForPacket(packet: OrchestratorPacket): OrchestratorMissionState | null {
  try {
    const current = readOrchestratorControlPlaneState();
    const mission = current.packets.some((member) => member.id === packet.id)
      ? current
      : findMissionRegistryEntryByPacketId(packet.id, { includeArchived: true })?.mission ?? null;
    // Never attach another mission's revision merely because a packet ID or
    // active control-plane state happened to resolve.
    return mission?.repoPath && mission.repoPath === packet.workspaceTargetPath
      && mission.packets.some((member) => member.id === packet.id)
      ? mission
      : null;
  } catch {
    return null;
  }
}

async function admittedIntent(
  receipt: Record<string, unknown>,
): Promise<WorkerIntentContinuity['intent']> {
  let ref: IntentContractRef;
  try {
    ref = parseIntentContractRef(receipt.authoredIntentRef);
  } catch {
    return { status: 'unavailable', ref: null, document: null, reason: 'malformed_intent_ref' };
  }
  try {
    const stored = await readIntentContract(ref.id, ref.revision);
    if (!stored) {
      return { status: 'unavailable', ref, document: null, reason: 'intent_record_missing' };
    }
    if (JSON.stringify(stored.ref) !== JSON.stringify(ref)) {
      return { status: 'unavailable', ref, document: null, reason: 'intent_identity_mismatch' };
    }
    if (Buffer.byteLength(stored.document, 'utf8') > MAX_AUTHORED_DOCUMENT_BYTES) {
      return { status: 'unavailable', ref, document: null, reason: 'intent_document_too_large' };
    }
    return { status: 'available', ref, document: stored.document, reason: null };
  } catch {
    return { status: 'unavailable', ref, document: null, reason: 'intent_record_unavailable' };
  }
}

/** Return null only for the genuinely legacy, no-authored-ref creation path. */
export async function captureWorkerIntentContinuity(
  packet: OrchestratorPacket,
  workspacePath: string | null | undefined,
): Promise<WorkerIntentContinuity | null> {
  const mission = missionForPacket(packet);
  const receipt = mission?.creationReceipt;
  if (!receipt || !Object.prototype.hasOwnProperty.call(receipt, 'authoredIntentRef')) return null;
  return {
    schema: WORKER_INTENT_CONTINUITY_SCHEMA,
    packetId: packet.id,
    missionId: mission?.missionId ?? null,
    intent: await admittedIntent(receipt as Record<string, unknown>),
    workspace: await observeWorkerWorkspace(workspacePath, evidencePaths(packet)),
  };
}

export type SourceFreshness = {
  status: 'current' | 'stale' | 'unavailable';
  stalePaths: string[];
  unavailablePaths: string[];
};

/** Revalidate immediately before a dependent action, not at prompt build time. */
export async function checkSourceEvidenceFreshness(
  carried: WorkerWorkspaceEvidence,
  workspacePath: string | null | undefined,
): Promise<SourceFreshness> {
  if (!carried || !Array.isArray(carried.files)) {
    return { status: 'unavailable', stalePaths: [], unavailablePaths: ['(malformed_source_evidence)'] };
  }
  if (carried.status !== 'observed' || carried.truncated !== false || carried.files.length === 0
    || carried.files.length > MAX_RELEVANT_FILES) {
    return {
      status: 'unavailable',
      stalePaths: [],
      unavailablePaths: carried.files.length
        ? carried.files.map((file) => typeof file?.path === 'string' ? file.path : '(malformed_source_evidence)')
        : ['(no_source_evidence)'],
    };
  }
  const stalePaths: string[] = [];
  const unavailablePaths: string[] = [];
  for (const file of carried.files) {
    if (!file || typeof file.path !== 'string' || file.status !== 'observed'
      || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) {
      unavailablePaths.push(typeof file?.path === 'string' ? file.path : '(malformed_source_evidence)');
      continue;
    }
    const observed = (await observeFile(workspacePath, file.path)).evidence;
    if (observed.status !== 'observed') unavailablePaths.push(file.path);
    else if (observed.sha256 !== file.sha256) stalePaths.push(file.path);
  }
  return {
    status: unavailablePaths.length ? 'unavailable' : stalePaths.length ? 'stale' : 'current',
    stalePaths,
    unavailablePaths,
  };
}

/** Actual source contents are read back before constructing any new claim. */
export async function reobserveSourceEvidence(
  carried: WorkerWorkspaceEvidence,
  workspacePath: string | null | undefined,
): Promise<{
  evidence: WorkerWorkspaceEvidence;
  observations: Array<{ path: string; content: string }>;
}> {
  if (!carried || !Array.isArray(carried.files) || carried.files.length > MAX_RELEVANT_FILES) {
    return {
      evidence: { status: 'unavailable', files: [], truncated: true },
      observations: [],
    };
  }
  const observed = await Promise.all(carried.files.map((file) => observeFile(
    workspacePath,
    typeof file?.path === 'string' ? file.path : '',
  )));
  const files = observed.map((entry) => entry.evidence);
  return {
    evidence: {
      status: files.length && !carried.truncated && files.every((file) => file.status === 'observed')
        ? 'observed' : 'unavailable',
      files,
      truncated: carried.truncated,
    },
    observations: observed.flatMap((entry) => entry.content === null
      ? [] : [{ path: entry.evidence.path, content: entry.content }]),
  };
}

export async function buildWorkerIntentContinuitySection(
  packet: OrchestratorPacket,
  workspacePath: string | null | undefined,
): Promise<string | null> {
  const snapshot = await captureWorkerIntentContinuity(packet, workspacePath);
  if (!snapshot) return null;
  return [
    'Admitted authored intent and bounded source evidence (NOT new authorization):',
    '<worker-intent-continuity>' + JSON.stringify(snapshot) + '</worker-intent-continuity>',
    'The original authored requirements outrank this packet summary. Do not replace, shorten, or reinterpret them using the summary.',
    'Before the first edit depending on a listed file, compare its current source SHA-256 with the carried hash. An unchanged source may continue without re-stating the approved goal.',
    'For changed, missing, malformed, or unavailable evidence, INVALIDATE the carried claim and OBSERVE current source contents BEFORE the first dependent edit. If observation cannot be completed, do not make the dependent edit. Retain the same authored intent revision.',
    'The carried evidence does not grant permission, expand authority, permit deployment, or replace current operator approvals and existing workspace/packet gates.',
  ].join('\n');
}
