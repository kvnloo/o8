// These are harness qualification fixtures, NEVER installed/native acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { digest, observeLines, summarize } from './hermes-observer.mjs';
import { UI_CHECKS, validateUi, validateWire } from './hermes-evidence.mjs';

function sample() {
  const facts = { model: 'chosen', unsupportedModel: 'unavailable', cwdHash: 'cwd', homeHash: 'home', workerHomeHashes: ['private'], persistedToolHashes: ['a', 'b', 'c'] };
  const rows = [];
  const add = (pid, row) => rows.push({ pid, ...row });
  const start = (pid, resume = false) => {
    add(pid, { method: 'observer/spawn', argv: ['acp', '--accept-hooks'], cwdHash: 'cwd', homeHash: 'home', hermesHomeHash: 'private' });
    add(pid, { method: 'initialize', direction: 'out', reply: true, protocolVersion: 1, agentName: 'hermes', agentVersion: 'qualification-version', resumeAdvertised: true });
    add(pid, { method: resume ? 'session/resume' : 'session/new', direction: 'in', sessionHash: 'session' });
    add(pid, { method: resume ? 'session/resume' : 'session/new', direction: 'out', reply: true, defaultModel: resume ? undefined : 'default' });
    add(pid, { method: 'session/set_model', direction: 'in', sessionHash: 'session', model: pid === 1 ? 'unavailable' : 'chosen', id: 2 });
    add(pid, { method: 'session/set_model', direction: 'out', reply: true, id: 2, sessionHash: 'session', modelEvidence: 'acp-model-state', error: pid === 1, currentModel: pid === 1 ? undefined : 'chosen' });
  };
  const prompt = (pid, id, finish = true) => {
    add(pid, { method: 'session/prompt', direction: 'in', sessionHash: 'session', id });
    if (finish) add(pid, { method: 'session/update', direction: 'out', update: 'tool_call', toolHash: pid === 3 ? 'c' : id === 3 ? 'a' : 'b' });
    if (finish) add(pid, { method: 'session/prompt', direction: 'out', reply: true, id, stopReason: 'end_turn' });
  };
  start(1); start(2); prompt(2, 3); prompt(2, 4); prompt(2, 5, false);
  add(2, { method: 'session/cancel', direction: 'in', sessionHash: 'session' });
  add(2, { method: 'observer/exit', code: 0 });
  start(3, true); prompt(3, 3);
  return { rows, facts };
}
test('qualification positive control validates only synthetic evidence', () => {
  const { rows, facts } = sample(); validateWire(rows, facts);
});
for (const [name, mutate] of [
  ['missing spawn observations', (s) => { s.rows = s.rows.filter((r) => r.method !== 'observer/spawn'); }],
  ['missing completed turns', (s) => { s.rows = s.rows.filter((r) => !r.stopReason); }],
  ['missing cancel', (s) => { s.rows = s.rows.filter((r) => r.method !== 'session/cancel'); }],
  ['missing process retirement', (s) => { s.rows = s.rows.filter((r) => r.method !== 'observer/exit'); }],
  ['cancel wrong session', (s) => { s.rows.find((r) => r.method === 'session/cancel').sessionHash = 'other'; }],
  ['resume wrong session', (s) => { s.rows.find((r) => r.method === 'session/resume').sessionHash = 'other'; }],
  ['same process after resume', (s) => { s.rows.forEach((r) => { if (r.pid === 3) r.pid = 2; }); }],
  ['changed normal HOME', (s) => { s.rows.find((r) => r.method === 'observer/spawn').homeHash = 'wrong'; }],
  ['shared Hermes state', (s) => { s.rows.find((r) => r.method === 'observer/spawn').hermesHomeHash = 'home'; }],
  ['default model instead of pin', (s) => { s.facts.model = 'default'; }],
  ['model changed after pin', (s) => { s.rows.splice(s.rows.findIndex((r) => r.method === 'session/prompt'), 0, { pid: 2, direction: 'out', sessionHash: 'session', modelEvidence: 'acp-model-state', currentModel: 'wrong' }); }],
  ['fixture identity', (s) => { s.rows.find((r) => r.method === 'initialize').agentVersion = 'fixture-1'; }],
  ['no resume capability', (s) => { s.rows.find((r) => r.method === 'initialize').resumeAdvertised = false; }],
  ['wrong rejection direction', (s) => { s.rows.find((r) => r.error).direction = 'in'; }],
  ['replayed tool output', (s) => { s.facts.persistedToolHashes = ['a', 'a', 'c']; }],
  ['duplicate initialize identity', (s) => { s.rows.find((r) => r.method === 'initialize' && r.pid === 3).pid = 2; }],
]) test(`rejects ${name}`, () => {
  const input = sample(); mutate(input); assert.throws(() => validateWire(input.rows, input.facts));
});
test('observer handles split frames and never includes payload secrets', () => {
  const rows = []; const pending = new Map();
  const receive = observeLines((frame) => rows.push(summarize(frame, 'in', pending)));
  receive(Buffer.from('{"id":1,"method":"session/prom'));
  receive(Buffer.from('pt","params":{"prompt":[{"text":"SECRET"}]}}\n'));
  assert.equal(rows.length, 1); assert.equal(rows[0].method, 'session/prompt');
  assert.ok(!JSON.stringify(rows).includes('SECRET'));
});
test('binary artifact hashing preserves original bytes', () => {
  assert.notEqual(digest(Buffer.from([0xff])), digest(Buffer.from([0xfe])));
});
const now = new Date().toISOString();
const ui = () => ({ runId: 'run', appCommit: 'commit', observedAt: now, reviewer: 'operator', device: 'paired phone', physicalPairedDevice: true,
  checks: Object.fromEntries(UI_CHECKS.map((check) => [check, { status: 'PASS', artifacts: [{ path: 'proof.png', sha256: 'a'.repeat(64) }] }])) });
test('UI manifest requires current exact scope and every manual check', () => {
  validateUi(ui(), 'run', 'commit', now);
  for (const patch of [{ runId: 'other' }, { appCommit: 'other' }, { observedAt: '2000-01-01' }, { physicalPairedDevice: false }, { checks: {} }]) {
    assert.throws(() => validateUi({ ...ui(), ...patch }, 'run', 'commit', now));
  }
});
test('launcher preflight fails closed without installed prerequisites and never prompts', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hermes-preflight-test-'));
  try {
    const result = spawnSync(process.execPath, ['scripts/acceptance/hermes-installed.mjs', '--output', path.join(root, 'run')],
      { encoding: 'utf8', env: { PATH: '/nonexistent', HOME: root } });
    assert.equal(result.status, 2);
    const report = JSON.parse(readFileSync(path.join(root, 'run/receipt.json'), 'utf8'));
    assert.equal(report.installedRuntime, 'BLOCKED'); assert.equal(report.overall, 'BLOCKED');
    assert.ok(report.blockers.some((s) => s.includes('binary absent')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('verify refuses a claimed PASS with missing runtime evidence', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hermes-verify-test-'));
  try {
    writeFileSync(path.join(root, 'receipt.json'), JSON.stringify({ runId: 'run', commit: 'commit', observedAt: now, installedRuntime: 'PASS', blockers: [] }));
    const result = spawnSync(process.execPath, ['scripts/acceptance/hermes-installed.mjs', '--verify', root], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(readFileSync(path.join(root, 'receipt.json'), 'utf8')).installedRuntime, 'FAIL');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('observer preserves split Unicode frame bytes', () => {
  const rows = []; const receive = observeLines((frame) => rows.push(frame));
  const bytes = Buffer.from(JSON.stringify({ model: '模型' }) + '\n');
  const split = bytes.indexOf(Buffer.from('模')) + 1;
  receive(bytes.subarray(0, split)); receive(bytes.subarray(split));
  assert.equal(rows[0].model, '模型');
});

test('observer subprocess relays actual bytes without logging payload or stderr', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hermes-observer-test-'));
  try {
    const peer = path.join(root, 'peer.mjs');
    const executable = path.join(root, 'fixture-hermes');
    const wire = path.join(root, 'wire.jsonl');
    writeFileSync(peer, "process.stdin.pipe(process.stdout); process.stderr.write('PRIVATE_STDERR');\n");
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${peer}' "$@"\n`, { mode: 0o700 });
    const payload = '{"id":1,"method":"session/prompt","params":{"prompt":[{"text":"SECRET_模型"}]}}\n';
    const result = spawnSync(process.execPath, ['scripts/acceptance/hermes-observer.mjs', 'acp', '--accept-hooks'], {
      input: payload, encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, O8_HERMES_ACCEPTANCE_REAL_BIN: executable, O8_HERMES_ACCEPTANCE_WIRE: wire },
    });
    assert.equal(result.status, 0); assert.equal(result.stdout, payload);
    assert.ok(result.stderr.includes('PRIVATE_STDERR'));
    const metadata = readFileSync(wire, 'utf8');
    assert.ok(!metadata.includes('SECRET') && !metadata.includes('PRIVATE_STDERR'));
    const rows = metadata.trim().split('\n').map(JSON.parse);
    assert.ok(rows.some((row) => row.method === 'observer/spawn'));
    assert.ok(rows.some((row) => row.method === 'observer/exit'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('observer reads correlated Hermes post-switch live-state metadata', () => {
  const pending = new Map();
  summarize({ id: 4, method: 'session/set_model', params: { sessionId: 's', modelId: 'requested' } }, 'in', pending);
  const row = summarize({ id: 4, result: { _meta: { hermes: { activeModelId: 'provider:actual' } } } }, 'out', pending);
  assert.equal(row.currentModel, 'provider:actual');
  assert.equal(row.sessionHash, digest('s'));
  assert.equal(row.modelEvidence, 'hermes-active-model');
  assert.equal(summarize({ id: 4, result: { _meta: { hermes: { activeModelId: 'provider:actual' } } } }, 'out', pending).currentModel, undefined);
});

test('observer refuses client echoes, errors and unrecognized model-shaped updates', () => {
  for (const direction of ['in', 'out']) {
    const pending = new Map();
    summarize({ id: 4, method: 'session/set_model', params: { sessionId: 's', modelId: 'requested' } }, 'in', pending);
    const row = summarize({ id: 4, error: { code: -32602 }, result: { _meta: { hermes: { activeModelId: 'requested' } } } }, direction, pending);
    assert.equal(row.currentModel, undefined);
  }
  const row = summarize({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', currentModelId: 'requested' } } }, 'out', new Map());
  assert.equal(row.currentModel, undefined);
});

for (const [name, mutate] of [
  ['empty model ACK', (s) => { s.rows.forEach((r) => { if (r.method === 'session/set_model' && r.reply) delete r.currentModel; }); }],
  ['wrong-session model witness', (s) => { s.rows.find((r) => r.pid === 2 && r.currentModel).sessionHash = 'other'; }],
  ['client model echo', (s) => { s.rows.find((r) => r.pid === 2 && r.currentModel).direction = 'in'; }],
  ['delayed older model reply after latest ACK', (s) => {
    const index = s.rows.findIndex((r) => r.pid === 2 && r.currentModel);
    s.rows.splice(index, 0,
      { pid: 2, direction: 'in', method: 'session/set_model', sessionHash: 'session', model: 'chosen', id: 20 },
      { pid: 2, direction: 'out', method: 'session/set_model', sessionHash: 'session', reply: true, id: 20 });
  }],
  ['model witness from before latest pin', (s) => {
    const index = s.rows.findIndex((r) => r.method === 'session/prompt');
    s.rows.splice(index, 0,
      { pid: 2, direction: 'in', method: 'session/set_model', sessionHash: 'session', model: 'chosen', id: 20 },
      { pid: 2, direction: 'out', method: 'session/set_model', sessionHash: 'session', reply: true, id: 20 });
  }],
]) test(`rejects ${name}`, () => {
  const input = sample(); mutate(input); assert.throws(() => validateWire(input.rows, input.facts));
});
