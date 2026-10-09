/** Production AgentRuntime acceptance, invoked only by the guarded launcher. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeTranscriptEntry } from '@/lib/runtimes/types';
import type { OwnedAcpSessionRecord } from '@/lib/runtimes/shared/owned-acp/types';

const root = process.env.O8_HERMES_ACCEPTANCE_ROOT!;
const sessions = process.env.O8_OWNED_HERMES_ROOT!;
const privateRoot = process.env.O8_DATA_DIR!;
const model = process.env.O8_HERMES_ACCEPTANCE_MODEL!;
const runId = process.env.O8_HERMES_ACCEPTANCE_RUN_ID!;
const workspace = path.join(privateRoot, 'packet-worktree');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const wire = path.join(root, 'wire.jsonl');
const wrapper = path.join(privateRoot, 'hermes');
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const json = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const save = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const wait = async (check: () => boolean | Promise<boolean>, label: string, timeout = 120_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`Timed out: ${label}`);
};
function sessionRecord(key: string): OwnedAcpSessionRecord {
  for (const dir of readdirSync(sessions)) {
    const file = path.join(sessions, dir, 'session.json');
    if (existsSync(file)) { const state = json<OwnedAcpSessionRecord>(file); if (state.surfaceId === key) return state; }
  }
  throw new Error('Persisted session missing');
}
function stablePrefix(before: RuntimeTranscriptEntry[], after: RuntimeTranscriptEntry[]) {
  assert.deepEqual(after.slice(0, before.length).map(({ id, role, text }) => ({ id, role, text })),
    before.map(({ id, role, text }) => ({ id, role, text })), 'prior transcript prefix changed/replayed');
  assert.equal(new Set(after.map((entry) => entry.id)).size, after.length, 'duplicate transcript IDs');
}
async function main() {
  assert.ok(root && sessions && privateRoot && model && runId);
  assert.equal(process.env.O8_HERMES_ACCEPTANCE_AUTHORIZED, 'yes');
  process.umask(0o077);
  const source = process.env.HERMES_HOME || path.join(process.env.HOME!, '.hermes');
  const sourceState = () => ['config.yaml', '.env', 'auth.json', 'models_dev_cache.json'].map((file) => {
    const target = path.join(source, file);
    if (!existsSync(target)) return null;
    const info = statSync(target); return [info.size, info.mtimeMs, info.ino];
  });
  const originalSourceState = sourceState();
  mkdirSync(workspace, { mode: 0o700 });
  execFileSync('git', ['init', '-q', workspace]);
  writeFileSync(path.join(workspace, 'acceptance.txt'), 'bounded scratch packet\n');
  execFileSync('git', ['-C', workspace, 'add', 'acceptance.txt']);
  execFileSync('git', ['-C', workspace, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.invalid', 'commit', '-qm', 'initialize scratch acceptance packet']);
  const observer = path.resolve('scripts/acceptance/hermes-observer.mjs');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(observer)} "$@"\n`, { mode: 0o700 });
  chmodSync(wrapper, 0o700);
  process.env.O8_HERMES_BIN = wrapper;
  process.env.O8_HERMES_ACCEPTANCE_WIRE = wire;
  // Environment isolation is set before any production module import/migration.
  const { hermesRuntime } = await import('@/lib/runtimes/hermes');
  const { getOwnedHermesReviewPacket } = await import('@/lib/hermes/owned');
  const { parseHermesSessionCost } = await import('@/lib/runtimes/hermes-cost-parser');
  const unsupportedModel = `o8-acceptance-unavailable-${runId}`;
  const denied = await hermesRuntime.launch({ cwd: workspace, prompt: 'THIS MUST NEVER REACH THE PROVIDER', model: unsupportedModel });
  // If the regression permits a prompt, stop the unexpected session before failing.
  if (denied.ok && denied.sessionKey) await hermesRuntime.interrupt(denied.sessionKey);
  assert.equal(denied.ok, false); assert.equal(denied.sideEffect, 'none');
  const tokens = [1, 2, 3].map((n) => `O8_ACCEPT_${runId}_${n}`);
  const probe = quote(`import json,os;from pathlib import Path;Path('worker-observation.json').write_text(json.dumps({'cwd':os.getcwd(),'home':os.environ.get('HOME'),'hermesHome':os.environ.get('HERMES_HOME')}));Path('acceptance.txt').write_text('first turn observed\\n')`);
  const cancelProbe = quote("import json,os,time;from pathlib import Path;Path('cancel-started.json').write_text(json.dumps({'pid':os.getpid(),'cwd':os.getcwd()}));time.sleep(60);Path('cancel-finished.txt').write_text('cancel did not stop tool')");
  const prompts = [
    `In this scratch packet only, run exactly: python3 -c ${probe}. Do not inspect credentials, contact services, delegate, or touch files outside cwd. Then reply exactly ${tokens[0]}.`,
    `In this scratch packet only, append the line "second turn observed" to acceptance.txt using your terminal tool. No other actions. Then reply exactly ${tokens[1]}.`,
    `In this scratch packet only, run exactly: python3 -c ${cancelProbe}. Do not perform any other action. This turn will be cancelled.`,
    `In this scratch packet only, append the line "durable resume observed" to acceptance.txt using your terminal tool. No other actions. Then reply exactly ${tokens[2]}.`,
  ];
  let key: string | undefined;
  try {
    const launched = await hermesRuntime.launch({ cwd: workspace, prompt: prompts[0], model,
      packetId: `acceptance-${runId}`, laneId: `acceptance-${runId}`, clientMutationId: runId });
    assert.equal(launched.ok, true); key = launched.sessionKey; assert.ok(key);
    const settled = async (count: number) => wait(async () => {
      const record = sessionRecord(key!);
      assert.notEqual(record.recentRuns[0]?.outcome, 'failed', 'provider/runtime turn failed');
      return record.recentRuns.filter((run) => run.outcome === 'finished').length === count;
    }, `completed turn ${count}`);
    await settled(1);
    assert.equal(readFileSync(path.join(workspace, 'acceptance.txt'), 'utf8'), 'first turn observed\n');
    const first = await hermesRuntime.readTranscript(key);
    assert.equal(first.filter((e) => e.role === 'assistant' && e.text.trim() === tokens[0]).length, 1);
    const observed = json<{ cwd: string; home: string; hermesHome: string }>(path.join(workspace, 'worker-observation.json'));
    assert.equal(observed.cwd, workspace); assert.equal(observed.home, process.env.HOME);
    assert.equal(observed.hermesHome, path.join(sessionRecord(key).sessionDir, 'hermes-home'));
    assert.notEqual(observed.hermesHome, process.env.HERMES_HOME);
    assert.equal((await hermesRuntime.resume(key, prompts[1])).ok, true);
    await settled(2);
    assert.equal(readFileSync(path.join(workspace, 'acceptance.txt'), 'utf8'), 'first turn observed\nsecond turn observed\n');
    const second = await hermesRuntime.readTranscript(key); stablePrefix(first, second);
    assert.equal(second.filter((e) => e.role === 'assistant' && e.text.trim() === tokens[1]).length, 1);
    assert.equal((await hermesRuntime.resume(key, prompts[2])).ok, true);
    await wait(() => {
      const run = sessionRecord(key!).recentRuns[0];
      assert.equal(run.outcome, 'running', 'cancellation probe settled too early');
      return existsSync(path.join(workspace, 'cancel-started.json')); 
    }, 'in-flight cancellation tool');
    const cancelState = json<{ pid: number; cwd: string }>(path.join(workspace, 'cancel-started.json'));
    assert.equal(cancelState.cwd, workspace); assert.ok(Number.isInteger(cancelState.pid) && cancelState.pid > 1);
    assert.equal((await hermesRuntime.interrupt(key)).ok, true);
    await wait(() => {
      try { process.kill(cancelState.pid, 0); return false; } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }, 'cancelled terminal tool process must exit', 10_000);
    assert.equal(existsSync(path.join(workspace, 'cancel-finished.txt')), false);
    const interrupted = sessionRecord(key);
    assert.equal(interrupted.recentRuns[0].outcome, 'interrupted');
    const beforeResume = await hermesRuntime.readTranscript(key);
    assert.equal((await hermesRuntime.resume(key, prompts[3])).ok, true);
    await settled(3);
    const final = await hermesRuntime.readTranscript(key); stablePrefix(beforeResume, final);
    assert.deepEqual(final.filter((e) => e.role === 'user').map((e) => e.text), prompts);
    for (const token of tokens) assert.equal(final.filter((e) => e.role === 'assistant' && e.text.trim() === token).length, 1);
    const state = sessionRecord(key);
    const toolIds = state.recentRuns.flatMap((run) => readFileSync(run.stdoutPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { params?: { update?: { sessionUpdate?: string; toolCallId?: string } } }).flatMap((frame) => frame.params?.update?.sessionUpdate === 'tool_call' ? [frame.params.update.toolCallId!] : []));
    assert.ok(toolIds.every(Boolean));
    assert.equal(new Set(toolIds).size, toolIds.length, 'tool replay must not be appended to new run');
    assert.equal(final.filter((entry) => entry.role === 'tool').length, toolIds.length, 'each persisted tool appears exactly once');
    assert.equal(state.model, model); assert.equal(state.supportsResume, true);
    assert.equal(state.packetId, `acceptance-${runId}`); assert.equal(state.cwd, workspace);
    const fleet = await hermesRuntime.discoverSessions();
    assert.ok(fleet.some((s) => s.sessionKey === key && s.runtimeId === 'hermes' && s.model === model && s.cwd === workspace));
    const review = await getOwnedHermesReviewPacket(key);
    assert.equal(review.runtime, 'hermes');
    assert.ok(review.changedFiles.some((file) => file.path === 'acceptance.txt'));
    const changes = await hermesRuntime.getChangedFiles(key);
    assert.ok(changes.some((file) => file.path === 'acceptance.txt'));
    const cost = await parseHermesSessionCost([], { fallbackModel: model });
    assert.equal(cost.costSource, 'unknown'); assert.equal(hermesRuntime.capabilities.costTelemetry, false);
    assert.equal(readFileSync(path.join(workspace, 'acceptance.txt'), 'utf8'), 'first turn observed\nsecond turn observed\ndurable resume observed\n');
    assert.deepEqual(sourceState(), originalSourceState, 'source Hermes profile must remain unchanged');
    save(path.join(root, 'runtime-facts.json'), { runId, commit: process.env.O8_HERMES_ACCEPTANCE_COMMIT,
      installedBinarySha256: createHash('sha256').update(readFileSync(process.env.O8_HERMES_ACCEPTANCE_REAL_BIN!)).digest('hex'),
      model, unsupportedModel,
      cwdHash: hash(workspace), homeHash: hash(process.env.HOME!),
      workerHomeHashes: readdirSync(sessions).map((dir) => hash(path.join(sessions, dir, 'hermes-home'))),
      persistedToolHashes: toolIds.map(hash),
      serverVersion: state.serverVersion, runCount: state.recentRuns.length,
      transcript: final.map(({ id, role, text }) => ({ idHash: hash(id), role, textHash: hash(text) })),
      fleet: true, review: true, costSource: cost.costSource, readiness: 'observed-provider-turns',
      sourceProfileUnchanged: true, toolCancellation: 'observed-process-exit', scratchMutationExactlyOnce: true,
      scope: 'production AgentRuntime with scratch packet metadata; mission UI is a separate gate',
    });
  } finally {
    if (key) await hermesRuntime.interrupt(key);
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
