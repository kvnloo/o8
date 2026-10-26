import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { IntentContractRef } from '@/lib/orchestrator/aodl-validation';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

// The real prompt assembly and durable mission/intent stores run; unrelated
// contextual model-memory and project-verification suggestions are isolated.
vi.mock('@/lib/codebase-memory/build-context', () => ({
  buildContextBlock: vi.fn(async () => ''),
}));
vi.mock('@/lib/orchestrator/project-verification-prompt', () => ({
  buildProjectVerificationPrompt: vi.fn(async () => null),
}));
vi.mock('@/lib/mcp/worker-injection', () => ({
  workerMcpInjectionSupported: vi.fn(() => false),
  resolveWorkerMcpInjection: vi.fn(async () => ({ servers: [] })),
}));

const root = mkdtempSync(join(tmpdir(), 'o8-worker-continuity-'));
process.env.CORTEX_IDE_DATA_DIR = join(root, 'data');
mkdirSync(process.env.CORTEX_IDE_DATA_DIR, { recursive: true });

const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { persistIntentContract } = await import('@/lib/orchestrator/intent-contract-store');
const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');

afterAll(() => rmSync(root, { recursive: true, force: true }));

interface ContinuityBlock {
  schema: string;
  packetId: string;
  missionId: string | null;
  intent: { status: string; ref: IntentContractRef | null; document: string | null; reason: string | null };
  workspace: {
    status: string;
    files: Array<{ path: string; status: string; sha256: string | null; reason: string | null }>;
    truncated: boolean;
  };
}

function continuityFromPrompt(prompt: string): ContinuityBlock {
  const match = prompt.match(/<worker-intent-continuity>([\s\S]*?)<\/worker-intent-continuity>/);
  expect(match, 'the real worker prompt must carry a machine-readable continuity block').not.toBeNull();
  return JSON.parse(match![1]!) as ContinuityBlock;
}

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

async function arrange(caseId: string) {
  const repoPath = join(root, caseId);
  const sourceFile = join(repoPath, 'src', 'feature.ts');
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  const original = "export const layout = 'preserved';\n";
  writeFileSync(sourceFile, original, 'utf8');

  const document = JSON.stringify({
    graphId: 'continuity.demo',
    revision: 1,
    provenance: { sourceHash: 'a'.repeat(64) },
    requirements: [
      { id: 'R1', text: 'Preserve the existing layout and behavior.' },
      { id: 'R2', text: 'Keep the response target at 120 ms and never deploy.' },
    ],
  });
  const ref: IntentContractRef = {
    id: 'continuity.demo',
    revision: 1,
    sourceHash: 'a'.repeat(64),
    semanticFingerprint: 'aodl-canon-1:' + 'b'.repeat(64),
    validatorRevision: 'c'.repeat(16),
    inputSha256: digest(document),
  };
  await persistIntentContract({ ref, document });

  const packet: OrchestratorPacket = {
    id: 'packet-' + caseId,
    referenceLabel: 'P1',
    title: 'Optimize without changing behavior',
    summary: 'A summary is not the approved requirements. Move quickly.',
    workspaceTargetPath: repoPath,
    branchTarget: 'continuity-fixture',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    readBudget: { requiredReads: ['src/feature.ts'], minToolCalls: 1, planBeforeWrite: true },
  };
  const state: OrchestratorMissionState = createEmptyOrchestratorMissionState();
  state.missionId = 'mission-' + caseId;
  state.repoPath = repoPath;
  state.packets = [packet];
  state.creationReceipt = {
    missionId: state.missionId,
    packets: [{ id: packet.id, title: packet.title, wave: 1 }],
    branchPreparation: [],
    authoredIntentRef: ref,
  };
  writeOrchestratorControlPlaneState(state);
  return { packet, state, repoPath, sourceFile, original, document, ref };
}

describe('orchestrator to worker intent continuity (upstream acceptance case 1)', () => {
  it('keeps the exact admitted revision, original requirements and bounded source evidence when unchanged', async () => {
    const setup = await arrange('unchanged');
    const prompt = await buildPacketPrompt(setup.packet, [setup.packet], 'main', setup.repoPath);
    const carried = continuityFromPrompt(prompt);

    expect(carried.schema).toBe('o8/worker-intent-continuity/v1');
    expect(carried.packetId).toBe(setup.packet.id);
    expect(carried.missionId).toBe(setup.state.missionId);
    expect(carried.intent).toMatchObject({ status: 'available', ref: setup.ref, document: setup.document });
    expect(carried.workspace).toMatchObject({
      status: 'observed',
      truncated: false,
      files: [{ path: 'src/feature.ts', status: 'observed', sha256: digest(setup.original), reason: null }],
    });
    expect(prompt).toContain('The carried evidence does not grant permission');
    expect(prompt).toContain('The original authored requirements outrank this packet summary');

    // The unchanged source is current, so no operator restatement or full
    // narrative replay is required. Re-checking a digest is not a new grant.
    const { checkSourceEvidenceFreshness } = await import('@/lib/orchestrator/dispatch-intent-continuity');
    await expect(checkSourceEvidenceFreshness(carried.workspace, setup.repoPath))
      .resolves.toEqual({ status: 'current', stalePaths: [], unavailablePaths: [] });

    // A damaged admitted ref must stay explicitly unavailable, not become a
    // requirements-free summary or an inferred authorization.
    setup.state.creationReceipt = {
      ...setup.state.creationReceipt!,
      authoredIntentRef: { ...setup.ref, inputSha256: 'malformed' },
    };
    writeOrchestratorControlPlaneState(setup.state);
    const malformed = continuityFromPrompt(await buildPacketPrompt(setup.packet, [setup.packet], 'main', setup.repoPath));
    expect(malformed.intent).toMatchObject({ status: 'unavailable', ref: null, document: null, reason: 'malformed_intent_ref' });

    setup.state.creationReceipt = {
      ...setup.state.creationReceipt!,
      authoredIntentRef: setup.ref,
    };
    writeOrchestratorControlPlaneState(setup.state);
    const missing = { ...setup.packet, readBudget: { requiredReads: ['src/missing.ts'], minToolCalls: 1, planBeforeWrite: true } };
    const absent = continuityFromPrompt(await buildPacketPrompt(missing, [missing], 'main', setup.repoPath));
    expect(absent.workspace).toMatchObject({
      status: 'unavailable',
      files: [{ path: 'src/missing.ts', status: 'unavailable', sha256: null, reason: 'missing_file' }],
    });
  });

  it('rejects a changed source claim before the first dependent edit, then re-observes the file', async () => {
    const setup = await arrange('changed');
    const dispatched = continuityFromPrompt(await buildPacketPrompt(
      setup.packet, [setup.packet], 'main', setup.repoPath,
    ));
    expect(dispatched.intent).toMatchObject({ status: 'available', ref: setup.ref, document: setup.document });

    const changedSource = "export const layout = 'operator-updated';\n";
    writeFileSync(setup.sourceFile, changedSource, 'utf8'); // Between dispatch and worker action.

    const { checkSourceEvidenceFreshness, reobserveSourceEvidence } = await import('@/lib/orchestrator/dispatch-intent-continuity');
    const preEdit = await checkSourceEvidenceFreshness(dispatched.workspace, setup.repoPath);
    expect(preEdit).toEqual({
      status: 'stale',
      stalePaths: ['src/feature.ts'],
      unavailablePaths: [],
    });

    // A dependent edit is blocked by the stale claim. The worker cannot
    // substitute the older prompt summary or assume permission from a digest.
    let dependentEditMade = false;
    if (preEdit.status === 'current') {
      writeFileSync(setup.sourceFile, 'unauthorized dependent edit\n', 'utf8');
      dependentEditMade = true;
    }
    expect(dependentEditMade).toBe(false);
    expect(readFileSync(setup.sourceFile, 'utf8')).toBe(changedSource);

    const reobserved = await reobserveSourceEvidence(dispatched.workspace, setup.repoPath);
    expect(reobserved.observations).toEqual([{ path: 'src/feature.ts', content: changedSource }]);
    expect(reobserved.evidence.files[0]).toMatchObject({
      path: 'src/feature.ts', status: 'observed', sha256: digest(changedSource),
    });
    await expect(checkSourceEvidenceFreshness(reobserved.evidence, setup.repoPath))
      .resolves.toEqual({ status: 'current', stalePaths: [], unavailablePaths: [] });
    expect(dispatched.intent.ref).toEqual(setup.ref);
    expect(dispatched.intent.document).toBe(setup.document);
  });
});
