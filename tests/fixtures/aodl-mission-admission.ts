/** Actual create route/service, canonical AODL, Git repo, control-plane file and SQLite.
 * Provider preflight, caller principal and realtime publication are fixture-owned
 * in the resource-owning parent suite. No worker is dispatched.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, vi } from 'vitest';
import type { IntentContractRef } from '@/lib/orchestrator/aodl-validation';

export async function exerciseMissionIntentAdmission(input: {
  root: string;
  ref: IntentContractRef;
  setRole: (role: string) => void;
}) {
  const repoPath = join(input.root, 'mission-repo');
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', repoPath]);
  const { POST } = await import('@/app/api/orchestrator/create-mission/route');
  const { createMission } = await import('@/lib/orchestrator/operator-mission-service');
  const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  const { getMissionRecord } = await import('@/lib/db/missions-store');
  const { normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  const { readIntentContract, persistIntentContract } = await import('@/lib/orchestrator/intent-contract-store');
  const { validateAodlIntent } = await import('@/lib/orchestrator/aodl-validation');
  const resolution = await import('@/lib/orchestrator/intent-reference-resolution');
  const { assertMissionIntentReceipt } = await import('@/lib/orchestrator/mission-intent-admission');

  const base = {
    repoPath, requestedRuntime: 'codex', huddle: false, dispatchOnCreate: false,
    constraints: 'Record authored identity; no worker launch.',
    issues: [{ number: 91_318_501, title: 'exact authored identity', body: 'Preserve the admission reference.', url: '' }],
  };
  async function request(clientMutationId: string, authoredIntentRef: unknown = input.ref) {
    const response = await POST(new NextRequest('http://localhost/api/orchestrator/create-mission', {
      method: 'POST', body: JSON.stringify({ ...base, clientMutationId, authoredIntentRef }),
    }));
    return { status: response.status, body: await response.json() };
  }

  const first = await request('intent-admission-r0');
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  expect(first.body.result.authoredIntentRef).toEqual(input.ref);
  const missionId = first.body.result.missionId as string;
  const stored = readOrchestratorControlPlaneState();
  expect(stored.missionId).toBe(missionId);
  expect(stored.creationReceipt).toMatchObject({ authoredIntentRef: input.ref });
  expect(normalizeOrchestratorMissionState(JSON.parse(JSON.stringify(stored))).creationReceipt)
    .toMatchObject({ authoredIntentRef: input.ref });
  expect(getMissionRecord(missionId)?.missionState?.creationReceipt)
    .toMatchObject({ authoredIntentRef: input.ref });
  expect(stored.packets.length).toBeGreaterThan(0);
  expect(stored.packets.every((packet) => packet.queueState === 'held' && !packet.lane)).toBe(true);

  const again = await request('intent-admission-r0');
  expect(again.status).toBe(201);
  expect(again.body.result).toMatchObject({ missionId, authoredIntentRef: input.ref, replayed: true });
  const original = await readIntentContract(input.ref.id, input.ref.revision);
  expect(original).not.toBeNull();
  const nextDoc = { ...JSON.parse(original!.document), revision: input.ref.revision + 1 };
  const next = await persistIntentContract(await validateAodlIntent(JSON.stringify(nextDoc)));
  const changed = await request('intent-admission-r0', next.ref);
  expect(changed.status).toBe(409);
  expect(changed.body.error.code).toBe('idempotency_conflict');
  expect(readOrchestratorControlPlaneState().creationReceipt).toMatchObject({ authoredIntentRef: input.ref });
  expect(await readIntentContract(input.ref.id, input.ref.revision)).toEqual(original);

  for (const [label, ref, status, code] of [
    ['malformed', { id: input.ref.id, revision: 0 }, 400, 'invalid_intent_ref'],
    ['missing', { ...input.ref, revision: 99 }, 404, 'intent_not_found'],
    ['mismatch', { ...input.ref, inputSha256: 'b'.repeat(64) }, 409, 'intent_ref_mismatch'],
  ] as const) {
    const rejected = await request(`intent-${label}`, ref);
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(status);
    expect(rejected.body.error.code).toBe(code);
    expect(readOrchestratorControlPlaneState().missionId).toBe(missionId);
  }
  for (const role of ['worker', 'device']) {
    input.setRole(role);
    const rejected = await request(`intent-role-${role}`);
    expect(rejected.status).toBe(403);
    expect(rejected.body.error.code).toBe('operator_required');
    expect(readOrchestratorControlPlaneState().missionId).toBe(missionId);
  }
  input.setRole('operator');
  const revision = process.env.O8_AODL_VALIDATOR_REVISION;
  try {
    process.env.O8_AODL_VALIDATOR_REVISION = '';
    const rejected = await request('intent-validator-unavailable');
    expect(rejected.status).toBe(503);
    expect(rejected.body.error.code).toBe('aodl_not_configured');
    expect(readOrchestratorControlPlaneState().missionId).toBe(missionId);
  } finally {
    if (revision === undefined) delete process.env.O8_AODL_VALIDATOR_REVISION;
    else process.env.O8_AODL_VALIDATOR_REVISION = revision;
  }

  const originalResolve = resolution.resolveIntentContractRef;
  const spy = vi.spyOn(resolution, 'resolveIntentContractRef').mockImplementationOnce(async (value) => {
    const resolved = await originalResolve(value);
    input.setRole('worker');
    return resolved;
  });
  try {
    const revoked = await request('intent-auth-revoked');
    expect(revoked.status).toBe(403);
    expect(readOrchestratorControlPlaneState().missionId).toBe(missionId);
  } finally { spy.mockRestore(); input.setRole('operator'); }

  await expect(createMission({ ...base, runtime: 'codex', authoredIntentRef: input.ref }))
    .rejects.toMatchObject({ code: 'intent_operator_context_required' });
  expect(readOrchestratorControlPlaneState().missionId).toBe(missionId);
  expect(() => assertMissionIntentReceipt(input.ref, { missionId, authoredIntentRef: next.ref }))
    .toThrow('intent_creation_receipt_mismatch');
  expect(() => assertMissionIntentReceipt(input.ref, { missionId }))
    .toThrow('intent_creation_receipt_mismatch');

  expect(() => assertMissionIntentReceipt(input.ref, null))
    .toThrow('intent_creation_receipt_mismatch');

  // Legacy missions do not require configuration or acquire a binding by default.
  try {
    process.env.O8_AODL_VALIDATOR_REVISION = '';
    const response = await POST(new NextRequest('http://localhost/api/orchestrator/create-mission', {
      method: 'POST', body: JSON.stringify({ ...base, clientMutationId: 'unbound-legacy-control' }),
    }));
    expect(response.status).toBe(201);
    expect((await response.json()).result.authoredIntentRef).toBeUndefined();
  } finally {
    if (revision === undefined) delete process.env.O8_AODL_VALIDATOR_REVISION;
    else process.env.O8_AODL_VALIDATOR_REVISION = revision;
  }
}
