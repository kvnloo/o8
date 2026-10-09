#!/usr/bin/env node
// Transparent byte relay. Only allowlisted metadata is persisted; no prompts,
// tool arguments, response text, stderr, config, or credentials enter this log.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

export const digest = (value) => createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
export function summarize(frame, direction, pending) {
  if (!frame || typeof frame !== 'object') return null;
  const replyKey = `${direction === 'out' ? 'in' : 'out'}:${frame.id}`;
  const request = !frame.method ? pending.get(replyKey) : undefined;
  const method = frame.method ?? request?.method;
  if (!frame.method) pending.delete(replyKey);
  if (frame.method && frame.id !== undefined) pending.set(`${direction}:${frame.id}`, {
    method: frame.method, sessionId: frame.params?.sessionId,
  });
  const result = frame.result ?? {};
  const update = frame.params?.update ?? {};
  const content = update.content;
  const successfulReply = direction === 'out' && request && !frame.error;
  const sessionId = frame.params?.sessionId ?? result.sessionId ?? request?.sessionId;
  let currentModel; let modelEvidence;
  if (successfulReply && method === 'session/set_model') {
    currentModel = result._meta?.hermes?.activeModelId;
    modelEvidence = 'hermes-active-model';
  }
  if (!currentModel && successfulReply && ['session/new', 'session/resume', 'session/load', 'session/set_model', 'session/set_config_option'].includes(method)) {
    currentModel = result.models?.currentModelId ?? result.configOptions?.find((option) => option.id === 'model')?.currentValue;
    modelEvidence = 'acp-model-state';
  }
  if (direction === 'out' && frame.method === 'session/update' && update.sessionUpdate === 'current_model_update') {
    currentModel = update.currentModelId; modelEvidence = 'acp-model-state';
  }
  if (direction === 'out' && frame.method === 'session/update' && update.sessionUpdate === 'config_option_update') {
    currentModel = update.configOptions?.find((option) => option.id === 'model')?.currentValue;
    modelEvidence = 'acp-model-state';
  }
  if (typeof currentModel !== 'string' || !currentModel.trim()) {
    currentModel = undefined; modelEvidence = undefined;
  }
  return {
    direction, method, id: frame.id, reply: !frame.method,
    error: Boolean(frame.error), errorCode: frame.error?.code,
    sessionHash: sessionId ? digest(sessionId) : undefined,
    model: frame.params?.modelId,
    currentModel, modelEvidence,
    defaultModel: successfulReply && method === 'session/new' ? result.models?.currentModelId : undefined,
    protocolVersion: result.protocolVersion,
    agentName: result.agentInfo?.name, agentVersion: result.agentInfo?.version,
    resumeAdvertised: method === 'initialize' && !frame.method
      ? result.agentCapabilities?.loadSession === true
        || Object.hasOwn(result.agentCapabilities?.sessionCapabilities ?? {}, 'resume') : undefined,
    update: update.sessionUpdate, toolHash: update.toolCallId ? digest(update.toolCallId) : undefined,
    status: update.status, stopReason: result.stopReason,
    textHash: typeof content?.text === 'string' ? digest(content.text) : undefined,
  };
}
export function observeLines(onLine) {
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  return (chunk) => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) throw new Error('ACP observation frame exceeds 8 MiB');
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { onLine(JSON.parse(line)); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        onLine({ method: 'observer/invalid-json' });
      }
    }
  };
}
function main() {
  const binary = process.env.O8_HERMES_ACCEPTANCE_REAL_BIN;
  const log = process.env.O8_HERMES_ACCEPTANCE_WIRE;
  if (!binary || !log) throw new Error('Observer requires an explicit installed binary and private log');
  const pending = new Map();
  const child = spawn(binary, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'pipe'] });
  const record = (row) => appendFileSync(log, `${JSON.stringify({ pid: child.pid, at: Date.now(), ...row })}\n`, { mode: 0o600 });
  record({ method: 'observer/spawn', argv: process.argv.slice(2),
    cwdHash: digest(process.cwd()), homeHash: digest(process.env.HOME),
    hermesHomeHash: digest(process.env.HERMES_HOME) });
  const incoming = observeLines((frame) => record(summarize(frame, 'in', pending)));
  const outgoing = observeLines((frame) => record(summarize(frame, 'out', pending)));
  process.stdin.on('data', incoming); child.stdout.on('data', outgoing);
  process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.stdin.on('error', () => {});
  child.on('error', () => { record({ method: 'observer/spawn-error' }); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    record({ method: 'observer/exit', code, signal });
    process.stdin.unpipe(child.stdin); process.stdin.destroy();
    process.exitCode = code ?? 1;
  });
  // Closing ACP's wrapper must also retire the real child, not leave an orphan.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  process.stdin.on('end', () => {
    child.stdin.end();
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGTERM'); }, 1_000).unref();
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3_000).unref();
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
