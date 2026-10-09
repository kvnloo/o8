import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntentContractRef } from '@/lib/orchestrator/aodl-validation';

// Real AODL Python subprocess and real o8 route + store. Only the existing
// operator principal and isolated data-root boundaries are fixture-controlled.
const state = vi.hoisted(() => ({
  root: '', role: 'operator', authenticated: true, principalChecks: 0, revokeAt: Infinity,
}));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.root }));
vi.mock('@/lib/panel/auth', () => ({
  requirePanelAuth: () => state.authenticated ? null : NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/auth/principal', () => ({
  resolveRequestPrincipalContext: () => ({ role: ++state.principalChecks >= state.revokeAt ? 'worker' : state.role }),
}));
const { POST, GET } = await import('@/app/api/orchestrator/intent-contract/route');
const { POST: RESOLVE } = await import('@/app/api/orchestrator/intent-contract/resolve/route');

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
function resolveRaw(body: string | ArrayBuffer) {
  state.principalChecks = 0;
  return RESOLVE(new NextRequest(`${origin}/resolve`, { method: 'POST', body }));
}
function resolveRef(ref: unknown) { return resolveRaw(JSON.stringify(ref)); }
async function storedRef(): Promise<IntentContractRef> {
  const result = await post(doc());
  expect(result.status).toBe(200);
  return (await result.json()).record.ref;
}
function storedPath() {
  const id = createHash('sha256').update('intent-consumer').digest('hex');
  return join(state.root, 'intent-contracts', id, '0.json');
}

let previousRevision: string | undefined;
beforeEach(async () => {
  previousRevision = process.env.O8_AODL_VALIDATOR_REVISION;
  const py = process.env.O8_AODL_PYTHON;
  const source = process.env.O8_AODL_SOURCE_DIR;
  if (!py || !source) throw new Error('Pinned AODL source + Python required for this real-path lane');
  const version = execFileSync(py, ['-m', 'aodl_contract.cli', '-V'], { cwd: source, encoding: 'utf8', timeout: 5_000 });
  const match = /wire=hotl-0\.2 semantic=([a-f0-9]{16})/.exec(version);
  if (!match) throw new Error('Pinned AODL semantic revision unavailable');
  process.env.O8_AODL_VALIDATOR_REVISION = match[1];
  state.root = await mkdtemp(join(tmpdir(), 'o8-aodl-real-route-'));
  state.role = 'operator'; state.authenticated = true; state.principalChecks = 0; state.revokeAt = Infinity;
});
afterEach(async () => {
  if (state.root) await rm(state.root, { recursive: true, force: true });
  state.root = '';
  if (previousRevision === undefined) delete process.env.O8_AODL_VALIDATOR_REVISION;
  else process.env.O8_AODL_VALIDATOR_REVISION = previousRevision;
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

describe('exact authored-intent reference resolution', () => {
  it('resolves exact R0 after R1 exists, without updating either revision', async () => {
    const ref = await storedRef();
    expect((await post(doc(1, 200))).status).toBe(200);
    const before = await readFile(storedPath(), 'utf8');
    const response = await resolveRef(ref);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    const result = await response.json();
    expect(result.record.ref).toEqual(ref);
    expect(result.record.document).toBe(doc());
    expect(await readFile(storedPath(), 'utf8')).toBe(before);
    expect((await (await get(1)).json()).record.document).toBe(doc(1, 200));
  });

  it.each(['sourceHash', 'inputSha256', 'validatorRevision', 'semanticFingerprint'] as const)(
    'rejects mismatched %s even when id/revision exist', async (key) => {
      const ref = await storedRef();
      const replacement = key === 'semanticFingerprint' ? `aodl-canon-1:${'b'.repeat(64)}`
        : 'b'.repeat(key === 'validatorRevision' ? 16 : 64);
      const result = await resolveRef({ ...ref, [key]: replacement });
      expect(result.status).toBe(409);
      expect(await result.json()).toEqual({ ok: false, error: 'intent_ref_mismatch' });
    },
  );

  it('does not alias a missing id or revision to the current revision', async () => {
    const ref = await storedRef();
    for (const missing of [{ ...ref, id: 'absent' }, { ...ref, revision: 99 }]) {
      const result = await resolveRef(missing);
      expect(result.status).toBe(404);
      expect(await result.json()).toEqual({ ok: false, error: 'intent_not_found' });
    }
  });

  it('rejects incomplete references, coercions and extra authority fields', async () => {
    const ref = await storedRef();
    for (const value of [null, [], {}, { id: ref.id, revision: 0 }, { ...ref, revision: '0' },
      { ...ref, revision: -1 }, { ...ref, revision: 1.5 }, { ...ref, authority: 'dispatch' },
      { ...ref, semanticFingerprint: `unknown:${'b'.repeat(64)}` }]) {
      const result = await resolveRef(value);
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({ ok: false, error: 'invalid_intent_ref' });
    }
  });

  it('bounds streamed bytes and rejects invalid JSON/UTF-8', async () => {
    const oversized = await resolveRaw(' '.repeat(1025));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ ok: false, error: 'intent_ref_too_large' });
    for (const body of ['{', new Uint8Array([0xff]).buffer]) {
      const result = await resolveRaw(body);
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({ ok: false, error: 'invalid_intent_ref' });
    }
  });

  it.each(['worker', 'device'])('refuses %s callers before returning a stored document', async (role) => {
    const ref = await storedRef(); state.role = role;
    const result = await resolveRef(ref);
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ ok: false, error: 'operator_required' });
  });

  it('refuses unauthenticated callers and rechecks principal after validation', async () => {
    const ref = await storedRef(); state.authenticated = false;
    expect((await resolveRef(ref)).status).toBe(401);
    state.authenticated = true; state.revokeAt = 2;
    const result = await resolveRef(ref);
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ ok: false, error: 'operator_required' });
  });

  it('fails closed when canonical verification is not configured', async () => {
    const ref = await storedRef();
    delete process.env.O8_AODL_VALIDATOR_REVISION;
    const result = await resolveRef(ref);
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ ok: false, error: 'aodl_not_configured' });
  });

  it('recomputes identity instead of trusting matching caller/store fingerprints', async () => {
    await storedRef();
    const record = JSON.parse(await readFile(storedPath(), 'utf8'));
    record.ref.semanticFingerprint = `aodl-canon-1:${'b'.repeat(64)}`;
    const damaged = JSON.stringify(record);
    await writeFile(storedPath(), damaged);
    const result = await resolveRef(record.ref);
    expect(result.status).toBe(500);
    expect(await result.json()).toEqual({ ok: false, error: 'intent_record_identity_mismatch' });
    expect(await readFile(storedPath(), 'utf8')).toBe(damaged);
  });

  it('rejects malformed persisted state rather than repairing it', async () => {
    const ref = await storedRef();
    await writeFile(storedPath(), '{');
    const result = await resolveRef(ref);
    expect(result.status).toBe(500);
    expect(await result.json()).toEqual({ ok: false, error: 'invalid_intent_record' });
    expect(await readFile(storedPath(), 'utf8')).toBe('{');
  });
});
