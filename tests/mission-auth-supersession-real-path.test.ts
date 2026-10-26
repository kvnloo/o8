import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The route, mission lock, SQLite registry and AODL subprocess remain real.
// Only the temporary data root, principal, provider preflight and publisher
// are controlled. No packet is dispatched and no host data root is migrated.
const principal = vi.hoisted(() => ({
  root: '',
  role: 'operator',
  authenticated: true,
}));
vi.mock('@/lib/data-dir-migration', () => ({
  getDataDir: () => principal.root,
  migrateDataDirOnce: () => {},
}));
vi.mock('@/lib/panel/auth', () => ({
  requirePanelAuth: () => principal.authenticated
    ? null : NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/auth/principal', () => ({
  resolveRequestPrincipalContext: () => ({ role: principal.role }),
}));
vi.mock('@/lib/runtimes/shared/auth-detect', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  assertRuntimeDispatchable: vi.fn(async () => {}),
}));
vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));
vi.mock('@/lib/orchestrator/operator-mission-service/mission-routing-log', () => ({
  logBranchPreparation: () => {},
  logDispatchRoutingRecommendations: async () => {},
}));
vi.mock('@/lib/operator/defaults', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/operator/defaults')>();
  return {
    ...original,
    getOperatorDefaultsSync: () => {
      const defaults = original.getOperatorDefaultsSync();
      return {
        ...defaults,
        values: {
          ...defaults.values,
          subscriptionProfile: 'both',
          workerExecutionCarrier: null,
        },
      };
    },
  };
});

const missionUrl = 'http://localhost/api/orchestrator/create-mission';
const intentUrl = 'http://localhost/api/orchestrator/intent-contract';
const threadId = 'auth-supersession-race';
let previousValidatorRevision: string | undefined;
let previousDbPath: string | undefined;
let repoPath = '';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeAll(async () => {
  const python = process.env.O8_AODL_PYTHON;
  const source = process.env.O8_AODL_SOURCE_DIR;
  if (!python || !source) throw new Error('Pinned AODL source and Python are required');
  const version = execFileSync(python, ['-m', 'aodl_contract.cli', '-V'], {
    cwd: source, encoding: 'utf8', timeout: 5_000,
  });
  const revision = /wire=hotl-0\.2 semantic=([a-f0-9]{16})/.exec(version)?.[1];
  if (!revision) throw new Error('Pinned AODL semantic revision unavailable');

  previousValidatorRevision = process.env.O8_AODL_VALIDATOR_REVISION;
  previousDbPath = process.env.CORTEX_IDE_DB_PATH;
  principal.root = await mkdtemp(join(tmpdir(), 'o8-mission-auth-race-'));
  process.env.O8_AODL_VALIDATOR_REVISION = revision;
  process.env.CORTEX_IDE_DB_PATH = join(principal.root, 'mission-race.db');
  principal.role = 'operator';
  principal.authenticated = true;
  repoPath = join(principal.root, 'repo');
  await mkdir(repoPath);
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', repoPath]);
});

afterAll(async () => {
  if (principal.root) await rm(principal.root, { recursive: true, force: true });
  principal.root = '';
  if (previousValidatorRevision === undefined) delete process.env.O8_AODL_VALIDATOR_REVISION;
  else process.env.O8_AODL_VALIDATOR_REVISION = previousValidatorRevision;
  if (previousDbPath === undefined) delete process.env.CORTEX_IDE_DB_PATH;
  else process.env.CORTEX_IDE_DB_PATH = previousDbPath;
});

describe('mission supersession during bound operator revocation (real persistence)', () => {
  it('does not replace the mission or cancel its registry packets after access is revoked', async () => {
    const { POST: publishIntent } = await import('@/app/api/orchestrator/intent-contract/route');
    const { POST: createMission } = await import('@/app/api/orchestrator/create-mission/route');
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const registry = await import('@/lib/orchestrator/mission-registry');
    const supersession = await import('@/lib/orchestrator/operator-mission-service/mission-supersession');

    const doc = JSON.stringify({
      specVersion: '0.2', graphId: 'mission-auth-race', revision: 0,
      intentGraph: {
        nodes: [{ id: 'task', kind: 'task', ports: [], capabilities: ['read', 'execute'] }],
        edges: [],
      },
      policies: { kinds: [] },
      constraints: { budgets: { tokens: 100 }, termination: { on: 'verified' } },
      provenance: { sourceHash: '0'.repeat(64) },
    });
    const published = await publishIntent(new NextRequest(intentUrl, {
      method: 'POST', body: doc,
    }));
    expect(published.status).toBe(200);
    const ref = (await published.json()).record.ref;

    const baseRequest = {
      repoPath, requestedRuntime: 'codex', huddle: false,
      dispatchOnCreate: false, orchestratorThreadId: threadId,
      constraints: 'Test non-dispatched mission supersession.',
      issues: [{
        number: 91_318_502, title: 'supersession test packet',
        body: 'Held; no worker launch.', url: '',
      }],
    };
    const request = (clientMutationId: string, authoredIntentRef?: unknown) => (
      createMission(new NextRequest(missionUrl, {
        method: 'POST',
        body: JSON.stringify({
          ...baseRequest, clientMutationId,
          ...(authoredIntentRef ? { authoredIntentRef } : {}),
        }),
      }))
    );

    const seedResponse = await request('auth-race-seed');
    expect(seedResponse.status).toBe(201);
    const seedId = (await seedResponse.json()).result.missionId as string;
    expect(readOrchestratorControlPlaneState().missionId).toBe(seedId);
    const seedRegistry = registry.readMissionRegistryEntry(seedId, { includeArchived: true });
    expect(seedRegistry?.mission.packets).toHaveLength(1);
    expect(seedRegistry?.mission.packets[0].queueState).toBe('held');
    expect(seedRegistry?.mission.packets[0].blockedReason ?? null).toBeNull();
    const beforeIds = registry.listMissionRegistryEntries({ includeArchived: true })
      .map((entry) => entry.id).sort();

    const registryMutationReturned = deferred();
    const resumeMissionCreate = deferred();
    const originalCancel = supersession.cancelSupersededRegistryMissions;
    let supersessionCalls = 0;
    // Let the REAL SQLite registry cancellation finish, then hold the awaited
    // production call before its continuation can replace the current mission.
    const pause = vi.spyOn(supersession, 'cancelSupersededRegistryMissions')
      .mockImplementation(async (input) => {
        await originalCancel(input);
        supersessionCalls += 1;
        registryMutationReturned.resolve();
        await resumeMissionCreate.promise;
      });
    try {
      const pending = request('auth-race-successor', ref);
      try {
        await registryMutationReturned.promise;
        expect(supersessionCalls).toBe(1);
        expect(registry.readMissionRegistryEntry(seedId, { includeArchived: true })
          ?.mission.packets[0].blockedReason).toBe('superseded_by_newer_mission');
        principal.role = 'worker'; // Revoked while the mission's registry await is pending.
      } finally {
        resumeMissionCreate.resolve();
      }

      const denied = await pending;
      expect(denied.status).toBe(403);
      expect((await denied.json()).error.code).toBe('operator_required');

      // Response rejection is insufficient: both durable stores must still
      // describe the authorized seed, and no successor may be admitted.
      expect(readOrchestratorControlPlaneState().missionId).toBe(seedId);
      const registryAfter = registry.readMissionRegistryEntry(seedId, { includeArchived: true });
      expect(registryAfter?.mission.packets[0].operatorStopped ?? false).toBe(false);
      expect(registryAfter?.mission.packets[0].blockedReason ?? null).toBeNull();
      expect(registryAfter?.mission.packets[0].queueState).toBe('held');
      expect(registry.listMissionRegistryEntries({ includeArchived: true })
        .map((entry) => entry.id).sort()).toEqual(beforeIds);
    } finally {
      resumeMissionCreate.resolve();
      pause.mockRestore();
      principal.role = 'operator';
    }
  }, 60_000);
});
