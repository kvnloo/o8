import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intentInputHash, type ValidatedIntent } from '@/lib/orchestrator/intent-contract-schema';

const state = vi.hoisted(() => ({ directory: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.directory }));
const { persistIntentContract, readIntentContract } = await import('./intent-contract-store');
function intent(revision = 0, budget = 100): ValidatedIntent {
  const document = JSON.stringify({ graphId: 'intent-example', revision,
    constraints: { budget }, provenance: { sourceHash: '0'.repeat(64) } });
  return { document, ref: { id: 'intent-example', revision, sourceHash: '0'.repeat(64),
    inputSha256: intentInputHash(document), validatorRevision: 'a'.repeat(16),
    semanticFingerprint: `aodl-canon-1:${intentInputHash(document)}` } };
}
function recordPath(revision = 0) {
  return join(state.directory, 'intent-contracts', intentInputHash('intent-example'), `${revision}.json`);
}
beforeEach(async () => {
  state.directory = await mkdtemp(join(tmpdir(), 'o8-intent-contract-'));
  vi.stubEnv('O8_AUTHORED_INTENT_ADMISSION', '1');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(state.directory, { recursive: true, force: true });
});
describe('immutable authored-intent store', () => {
  it.each([undefined, '', '0', 'true'])('is disabled without explicit opt-in (%s)', async (enabled) => {
    vi.stubEnv('O8_AUTHORED_INTENT_ADMISSION', enabled);
    await expect(persistIntentContract(intent())).rejects.toMatchObject({ code: 'intent_admission_disabled' });
    await expect(readIntentContract('intent-example', 0)).rejects.toMatchObject({ code: 'intent_admission_disabled' });
    expect(await readdir(state.directory)).toEqual([]);
  });
  it('creates a separate revision and leaves the old bytes and timestamp unchanged', async () => {
    const first = await persistIntentContract(intent());
    const bytes = await readFile(recordPath(), 'utf8');
    const revised = await persistIntentContract(intent(1, 200));
    expect(revised.ref.revision).toBe(1);
    expect(await readIntentContract('intent-example', 1)).toEqual(revised);
    expect(await readIntentContract('intent-example', 0)).toEqual(first);
    expect(await readFile(recordPath(), 'utf8')).toBe(bytes);
  });
  it('replays identical submissions and rejects conflicting content', async () => {
    const first = await persistIntentContract(intent());
    expect(await persistIntentContract(intent())).toEqual(first);
    await expect(persistIntentContract(intent(0, 200))).rejects.toMatchObject({ code: 'intent_revision_conflict' });
    expect(await readIntentContract('intent-example', 0)).toEqual(first);
  });
  it('publishes one winner for concurrent writers and cleans temporary files', async () => {
    const results = await Promise.allSettled([persistIntentContract(intent()), persistIntentContract(intent(0, 200))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'intent_revision_conflict' } });
    expect(await readdir(join(recordPath(), '..'))).toEqual(['0.json']);
    expect(await readIntentContract('intent-example', 0)).toEqual(results.find((r) => r.status === 'fulfilled')?.value);
  });
  it('reads durable records after the module reloads', async () => {
    const first = await persistIntentContract(intent());
    vi.resetModules();
    const fresh = await import('./intent-contract-store');
    expect(await fresh.readIntentContract('intent-example', 0)).toEqual(first);
  });
  it('rejects corrupt persisted content', async () => {
    const first = await persistIntentContract(intent());
    await writeFile(recordPath(), JSON.stringify({ ...first, document: intent(0, 200).document }));
    await expect(readIntentContract('intent-example', 0)).rejects.toMatchObject({ code: 'invalid_intent_record' });
  });
  it('rejects invalid identities and authored runtime projections before writing', async () => {
    await expect(readIntentContract('../outside', 0)).rejects.toMatchObject({ code: 'invalid_intent_identity' });
    const value = intent();
    value.document = JSON.stringify({ ...JSON.parse(value.document), observedGraph: {} });
    value.ref.inputSha256 = intentInputHash(value.document);
    await expect(persistIntentContract(value)).rejects.toMatchObject({ code: 'runtime_projection_not_authored_intent' });
    expect(await readdir(state.directory)).toEqual([]);
  });
  it('snapshots caller-owned input before asynchronous filesystem work', async () => {
    const value = intent();
    const expected = structuredClone(value);
    const pending = persistIntentContract(value);
    value.ref.revision = 9;
    value.document = intent(9).document;
    const saved = await pending;
    expect(saved.ref).toEqual(expected.ref);
    expect(saved.document).toBe(expected.document);
    expect(await readIntentContract('intent-example', 0)).toEqual(saved);
    expect(await readIntentContract('intent-example', 9)).toBeNull();
  });
  it.each([null, [], { ref: 'invalid' }])('rejects malformed stored schemas (%j)', async (invalid) => {
    await persistIntentContract(intent());
    await writeFile(recordPath(), JSON.stringify(invalid));
    await expect(readIntentContract('intent-example', 0)).rejects.toMatchObject({ code: 'invalid_intent_record' });
  });
  it('returns null for an absent revision', async () => {
    expect(await readIntentContract('intent-example', 0)).toBeNull();
  });
});
