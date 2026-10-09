import assert from 'node:assert/strict';

export function validateWire(rows, facts) {
  const prompts = rows.filter((r) => r.direction === 'in' && r.method === 'session/prompt');
  assert.equal(prompts.length, 4, 'first, second, interrupted, and resumed prompts only');
  assert.equal(prompts[0].pid, prompts[1].pid, 'second turn must reuse actual Hermes process');
  assert.equal(prompts[1].pid, prompts[2].pid, 'cancel target must be the same live process');
  assert.notEqual(prompts[2].pid, prompts[3].pid, 'resume must use a new Hermes process');
  assert.equal(new Set(prompts.map((p) => p.sessionHash)).size, 1, 'durable remote session identity');
  assert.ok(prompts[0].sessionHash, 'remote session evidence exists');
  for (const prompt of prompts) {
    const before = rows.slice(0, rows.indexOf(prompt)).filter((r) => r.pid === prompt.pid);
    const pin = before.findLast((r) => r.method === 'session/set_model' && r.direction === 'in' && r.sessionHash === prompt.sessionHash);
    assert.equal(pin?.model, facts.model, 'requested pin precedes every prompt');
    const afterPin = before.slice(before.indexOf(pin) + 1);
    const ack = afterPin.find((r) => r.reply && r.direction === 'out' && r.method === 'session/set_model' && r.id === pin.id && r.sessionHash === prompt.sessionHash && !r.error);
    assert.ok(ack, 'pin acknowledged before prompt');
    const witness = afterPin.findLast((r) => r.currentModel && r.sessionHash === prompt.sessionHash && r.direction === 'out' && !r.error);
    assert.ok(witness && ['hermes-active-model', 'acp-model-state'].includes(witness.modelEvidence), 'server-origin model evidence must follow this session pin');
    assert.ok((witness === ack) || (witness.method === 'session/update' && !witness.reply && afterPin.indexOf(witness) > afterPin.indexOf(ack)), 'model witness must confirm this pin, not a delayed earlier response');
    assert.equal(witness.currentModel, facts.model, 'latest actual current model must be reported, not just an empty acknowledgement');
  }
  const initial = rows.find((r) => r.pid === prompts[0].pid && r.defaultModel);
  assert.ok(initial?.defaultModel, 'installed ACP must report its default model');
  assert.notEqual(initial.defaultModel, facts.model, 'acceptance requires a non-default model pin');
  const resumed = rows.findIndex((r) => r.pid === prompts[3].pid && r.direction === 'in' && r.method === 'session/resume');
  assert.ok(resumed >= 0 && resumed < rows.indexOf(prompts[3]), 'durable resume before prompt');
  assert.equal(rows[resumed].sessionHash, prompts[3].sessionHash);
  assert.ok(rows.slice(resumed, rows.indexOf(prompts[3])).some((r) => r.pid === prompts[3].pid && r.reply && r.direction === 'out' && r.method === 'session/resume' && !r.error));
  const cancel = rows.findIndex((r) => r.pid === prompts[2].pid && r.direction === 'in' && r.method === 'session/cancel');
  assert.ok(cancel > rows.indexOf(prompts[2]) && cancel < resumed, 'cancellation must interrupt an in-flight prompt');
  assert.equal(rows[cancel].sessionHash, prompts[2].sessionHash);
  const retired = rows.findIndex((r, i) => i > cancel && r.pid === prompts[2].pid && r.method === 'observer/exit');
  assert.ok(retired > cancel && retired < resumed, 'cancelled actual process must be retired before resume');
  assert.ok(!rows.slice(retired + 1).some((r) => r.pid === prompts[2].pid && r.method === 'session/update'), 'no output after old process retirement');
  for (const prompt of [prompts[0], prompts[1], prompts[3]]) {
    assert.ok(rows.some((r, i) => i > rows.indexOf(prompt) && r.pid === prompt.pid && r.id === prompt.id && r.direction === 'out' && r.reply && r.method === 'session/prompt' && r.stopReason === 'end_turn' && !r.error), 'completed provider turn required');
  }
  assert.ok(!rows.slice(rows.indexOf(prompts[2]), cancel).some((r) => r.pid === prompts[2].pid && r.reply && r.method === 'session/prompt' && r.id === prompts[2].id), 'cancel must precede prompt settlement');
  const rejected = rows.find((r) => r.direction === 'in' && r.method === 'session/set_model' && r.model === facts.unsupportedModel);
  assert.ok(rejected, 'unsupported model attempted');
  assert.ok(rows.some((r) => r.pid === rejected.pid && r.direction === 'out' && r.method === 'session/set_model' && r.reply && r.id === rejected.id && r.error), 'unsupported model rejected by installed Hermes');
  assert.ok(!prompts.some((r) => r.pid === rejected.pid), 'no prompt sent after unsupported model');
  const spawns = rows.filter((r) => r.method === 'observer/spawn');
  assert.equal(spawns.length, 3, 'unsupported, initial, and resumed actual processes required');
  assert.equal(new Set(spawns.map((r) => r.pid)).size, 3);
  assert.deepEqual(new Set(spawns.map((r) => r.pid)), new Set([rejected.pid, prompts[0].pid, prompts[3].pid]));
  for (const spawn of spawns) {
    assert.deepEqual(spawn.argv, ['acp', '--accept-hooks']);
    assert.equal(spawn.cwdHash, facts.cwdHash);
    assert.equal(spawn.homeHash, facts.homeHash, 'normal HOME preserved');
    assert.ok(facts.workerHomeHashes.includes(spawn.hermesHomeHash), 'isolated worker HERMES_HOME');
  }
  const initialized = rows.filter((r) => r.reply && r.method === 'initialize');
  assert.equal(initialized.length, 3);
  assert.deepEqual(new Set(initialized.map((r) => r.pid)), new Set(spawns.map((r) => r.pid)));
  assert.ok(initialized.every((r) => r.protocolVersion === 1 && /hermes/i.test(r.agentName) && r.agentVersion && !/fixture|mock/i.test(r.agentVersion)), 'real installed Hermes identity/version required');
  assert.ok(initialized.every((r) => r.resumeAdvertised), 'durable resume capability required');
  assert.ok(Array.isArray(facts.persistedToolHashes) && facts.persistedToolHashes.length >= 3);
  assert.equal(new Set(facts.persistedToolHashes).size, facts.persistedToolHashes.length, 'no tool replay appended to new run');
  const liveTools = prompts.flatMap((prompt) => {
    const start = rows.indexOf(prompt);
    const end = rows.findIndex((r, i) => i > start && r.pid === prompt.pid && ((r.reply && r.method === 'session/prompt' && r.id === prompt.id) || r.method === 'observer/exit'));
    assert.ok(end > start);
    return rows.slice(start, end).filter((r) => r.pid === prompt.pid && r.direction === 'out' && r.update === 'tool_call').map((r) => r.toolHash);
  });
  assert.deepEqual([...liveTools].sort(), [...facts.persistedToolHashes].sort(), 'persisted tools must match live output exactly, excluding resume replay');
  assert.ok(!rows.some((r) => r.method === 'observer/invalid-json' || r.method === 'observer/spawn-error'));
}

export const UI_CHECKS = [
  'worker-picker-and-model', 'packet-dispatch-cwd', 'fleet-transcript-review',
  'ripple-choice-manual-send', 'ripple-edit-dismiss-invalidation',
  'ripple-chat-repo-scope-and-late-response', 'ripple-offline-reconnect-exactly-once',
  'ripple-stale-or-malformed-receipt-blocked', 'ripple-no-authority-expansion',
];
export function validateUi(evidence, runId, commit, startedAt) {
  assert.equal(evidence.runId, runId, 'UI evidence must belong to this run');
  assert.ok(evidence.reviewer && evidence.appCommit && evidence.device && evidence.observedAt);
  assert.ok(Number.isFinite(Date.parse(evidence.observedAt)));
  assert.equal(evidence.appCommit, commit, 'UI app must match tested source commit');
  assert.ok(Date.parse(evidence.observedAt) >= Date.parse(startedAt) && Date.parse(evidence.observedAt) <= Date.now() + 60_000, 'UI observation must be current and after run start');
  assert.equal(evidence.physicalPairedDevice, true);
  for (const check of UI_CHECKS) {
    const row = evidence.checks?.[check];
    assert.equal(row?.status, 'PASS', `${check} remains unverified`);
    assert.ok(Array.isArray(row.artifacts) && row.artifacts.length, `${check} needs captured evidence`);
    for (const artifact of row.artifacts) {
      assert.ok(typeof artifact.path === 'string' && artifact.path.length);
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    }
  }
}
