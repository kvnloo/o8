import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real AODL Python subprocess and real o8 route + store. Only the existing
// operator principal and isolated data-root boundaries are fixture-controlled.
const state = vi.hoisted(() => ({ root: '', role: 'operator' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.root }));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/auth/principal', () => ({
  resolveRequestPrincipalContext: () => ({ role: state.role }),
}));
const { POST, GET } = await import('@/app/api/orchestrator/intent-contract/route');

const origin = 'http://localhost/api/orchestrator/intent-contract';
function doc(revision = 0, tokens = 100) {
  return JSON.stringify({
    specVersion: '0.2', graphId: 'intent-consumer', revision,
    intentGraph: {
      nodes: [{ id: 'task', kind: 'task', ports: [], capabilities: ['read', 'execute'] }],
      edges: [],
    },
    policies: { kinds: [] },
    constraints: { budgets: { tokens }, termination: { on: 'verified' } },
    provenance: { sourceHash: '0'.repeat(64) },
  });
}
function post(raw: string) {
  return POST(new NextRequest(origin, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw }));
}
function get(revision = 0) {
  return GET(new NextRequest(`${origin}?id=intent-consumer&revision=${revision}`));
}

beforeEach(async () => {
  const py = process.env.O8_AODL_PYTHON;
  const source = process.env.O8_AODL_SOURCE_DIR;
  if (!py || !source) throw new Error('Pinned AODL source + Python required for this real-path lane');
  const version = execFileSync(py, ['-m', 'aodl_contract.cli', '-V'], { cwd: source, encoding: 'utf8', timeout: 5_000 });
  const match = /wire=hotl-0\.2 semantic=([a-f0-9]{16})/.exec(version);
  if (!match) throw new Error('Pinned AODL semantic revision unavailable');
  process.env.O8_AODL_VALIDATOR_REVISION = match[1];
  state.root = await mkdtemp(join(tmpdir(), 'o8-aodl-real-route-'));
  state.role = 'operator';
});
afterEach(async () => {
  if (state.root) await rm(state.root, { recursive: true, force: true });
  state.root = '';
  delete process.env.O8_AODL_VALIDATOR_REVISION;
});

describe('AODL subprocess → authenticated o8 intent route → durable record', () => {
  it('validates exact bytes, publishes immutable R0 and preserves it across R1', async () => {
    const first = await post(doc());
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.record.document).toBe(doc());
    expect(firstBody.record.ref.semanticFingerprint).toMatch(/^aodl-canon-1:[a-f0-9]{64}$/);
    expect(firstBody.record.ref.validatorRevision).toBe(process.env.O8_AODL_VALIDATOR_REVISION);
    expect(await (await get()).json()).toEqual(firstBody);
    expect(await (await post(doc())).json()).toEqual(firstBody);
    expect((await post(doc(0, 200))).status).toBe(409);
    expect((await post(doc(1, 200))).status).toBe(200);
    expect(await (await get()).json()).toEqual(firstBody);
  });

  it('rejects malformed semantic inputs and duplicate JSON keys before publication', async () => {
    const bad = JSON.parse(doc()) as Record<string, unknown>;
    (bad.intentGraph as {nodes: Array<{kind: string}>}).nodes[0].kind = 'invalid_kind';
    const rejected = await post(JSON.stringify(bad));
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toBe('aodl_rejected');
    const duplicate = doc().replace('"revision":0', '"revision":0,"revision":0');
    const duplicateResult = await post(duplicate);
    expect(duplicateResult.status).toBe(400);
    expect((await duplicateResult.json()).error).toBe('aodl_rejected');
    expect((await get()).status).toBe(404);
  });

  it('rejects an untrusted principal without invoking the validator or storing content', async () => {
    state.role = 'device';
    const result = await post(doc());
    expect(result.status).toBe(403);
    expect((await get()).status).toBe(403);
  });

  it('rejects mutable runtime projections rather than pretending they are authored intent', async () => {
    const mutated = JSON.parse(doc()) as Record<string, unknown>;
    mutated.eventLog = [];
    const result = await post(JSON.stringify(mutated));
    expect(result.status).toBe(400);
    expect((await result.json()).error).toBe('runtime_projection_not_authored_intent');
    expect((await get()).status).toBe(404);
  });
});
