import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { isAbsolute, join } from 'node:path';

export const Z0_BRIDGE_PROTOCOL = 'o8.z0.bridge.v1';

const DEFAULT_TIMEOUT_MS = 2_500;
const MAX_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const PYTHON_BRIDGE =
  'import json,sys; from z0int.o8_bridge import handle_bridge_request; '
  + 'req=json.load(sys.stdin); '
  + 'print(json.dumps(handle_bridge_request(req), separators=(",",":")))';

export type Z0Transport =
  | { kind: 'python'; python: string; sourceDir: string; timeoutMs: number }
  | { kind: 'http'; url: URL; timeoutMs: number };

export interface Z0ShadowCallResult {
  ok: boolean;
  transport: Z0Transport['kind'] | 'none';
  latencyMs: number;
  route: unknown | null;
  replayed: boolean;
  requestSha256: string | null;
  error: string | null;
}

function timeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  const parsed = Number(env.O8_Z0_SHADOW_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.max(100, Math.min(MAX_TIMEOUT_MS, Math.round(parsed)));
}

export function validateLoopbackBridgeUrl(raw: string): URL {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  if (url.protocol !== 'http:' || !loopback || url.username || url.password) {
    throw new Error('O8_Z0_SHADOW_URL must be unauthenticated loopback HTTP');
  }
  if (url.pathname !== '/v1/o8' || url.search || url.hash) {
    throw new Error('O8_Z0_SHADOW_URL must point exactly to /v1/o8');
  }
  return url;
}

export function resolveZ0Transport(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Z0Transport | null {
  const python = env.O8_Z0_PYTHON?.trim();
  const sourceDir = env.O8_Z0_SOURCE_DIR?.trim();
  if (python || sourceDir) {
    if (!python || !sourceDir) {
      throw new Error('O8_Z0_PYTHON and O8_Z0_SOURCE_DIR must be set together');
    }
    if (!isAbsolute(python) || !isAbsolute(sourceDir)) {
      throw new Error('O8_Z0_PYTHON and O8_Z0_SOURCE_DIR must be absolute paths');
    }
    return { kind: 'python', python, sourceDir, timeoutMs: timeoutMs(env) };
  }
  const rawUrl = env.O8_Z0_SHADOW_URL?.trim();
  if (rawUrl) return { kind: 'http', url: validateLoopbackBridgeUrl(rawUrl), timeoutMs: timeoutMs(env) };
  return null;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

function runBoundedProcess(
  command: string,
  args: string[],
  input: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    const add = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('z0 bridge output exceeded limit'));
      }
    };
    child.stdout.on('data', (chunk: Buffer) => add('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => add('stderr', chunk));
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error('z0 bridge exited ' + String(code) + (signal ? ' (' + signal + ')' : '') + ': ' + stderr.slice(0, 500)));
      } else {
        finish();
      }
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('z0 bridge timed out'));
    }, options.timeoutMs);
    child.stdin.end(input);
  });
}

async function callPython(
  transport: Extract<Z0Transport, { kind: 'python' }>,
  payload: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.PYTHONHOME;
  delete childEnv.PYTHONPATH;
  childEnv.PYTHONPATH = join(transport.sourceDir, 'src');
  childEnv.PYTHONNOUSERSITE = '1';
  childEnv.PYTHONDONTWRITEBYTECODE = '1';
  if (env.Z0INT_HOME) childEnv.Z0INT_HOME = env.Z0INT_HOME;
  const result = await runBoundedProcess(
    transport.python,
    ['-c', PYTHON_BRIDGE],
    payload,
    { cwd: transport.sourceDir, env: childEnv, timeoutMs: transport.timeoutMs },
  );
  return result.stdout.trim();
}

async function callHttp(
  transport: Extract<Z0Transport, { kind: 'http' }>,
  payload: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(transport.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: payload,
    signal: AbortSignal.timeout(transport.timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error('z0 bridge HTTP ' + response.status + ': ' + text.slice(0, 500));
  return text;
}

export async function callZ0ShadowBridge(
  request: Record<string, unknown>,
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Z0ShadowCallResult> {
  const env = options.env ?? process.env;
  let transport: Z0Transport | null;
  try {
    transport = resolveZ0Transport(env);
  } catch (error) {
    return {
      ok: false, transport: 'none', latencyMs: 0, route: null, replayed: false,
      requestSha256: null, error: error instanceof Error ? error.message : 'invalid z0 transport',
    };
  }
  if (!transport) {
    return {
      ok: false, transport: 'none', latencyMs: 0, route: null, replayed: false,
      requestSha256: null, error: 'z0_not_configured',
    };
  }

  const startedAt = performance.now();
  try {
    const payload = JSON.stringify(request);
    const raw = transport.kind === 'python'
      ? await callPython(transport, payload, env)
      : await callHttp(transport, payload, options.fetchImpl ?? fetch);
    const body = JSON.parse(raw) as Record<string, unknown>;
    const latencyMs = Math.round(performance.now() - startedAt);

    if (body.protocol_version !== Z0_BRIDGE_PROTOCOL || body.mode !== 'shadow') {
      throw new Error('z0 bridge protocol/mode mismatch');
    }
    if (body.trace_id !== request.trace_id) throw new Error('z0 bridge trace mismatch');
    if (body.executed !== false) throw new Error('shadow_executed');
    if (body.ok !== true) throw new Error('z0 bridge returned ok=false');

    return {
      ok: true,
      transport: transport.kind,
      latencyMs,
      route: body.route ?? null,
      replayed: body.replayed === true,
      requestSha256: typeof body.request_sha256 === 'string' ? body.request_sha256 : null,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      transport: transport.kind,
      latencyMs: Math.round(performance.now() - startedAt),
      route: null,
      replayed: false,
      requestSha256: null,
      error: error instanceof Error ? error.message.slice(0, 500) : 'z0 bridge failed',
    };
  }
}
