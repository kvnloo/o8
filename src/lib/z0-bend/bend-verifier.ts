import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { isAbsolute, join } from 'node:path';

export const DEFAULT_BEND_VERSION = '2.0.35';
export const BEND_PROOF_RELATIVE = 'integrations/bend/o8-z0-shadow/PROOF.bend';
const BEND_PASS = 'ALL PROOFS CHECK';

export interface BendShadowVerdict {
  configured: boolean;
  ok: boolean;
  version: string | null;
  proofSha256: string | null;
  latencyMs: number | null;
  cached: boolean;
  error: string | null;
}

export interface BendExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
}

export type BendExecutor = (
  file: string,
  args: string[],
  options: BendExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

const cache = new Map<string, BendShadowVerdict>();

function defaultExecutor(
  file: string,
  args: string[],
  options: BendExecOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((error.message + '\n' + stderr).slice(0, 1000)));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function cleanBendEnv(source: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BENDTT;
  delete env.BEND_ORIGIN;
  env.BEND_NO_TELEMETRY = '1';
  if (source.PATH) env.PATH = source.PATH;
  return env;
}

export async function verifyBendShadowLaws(options: {
  env?: Readonly<Record<string, string | undefined>>;
  repoRoot?: string;
  run?: BendExecutor;
  cache?: boolean;
} = {}): Promise<BendShadowVerdict> {
  const env = options.env ?? process.env;
  const bin = env.O8_BEND_BIN?.trim();
  if (!bin) {
    return {
      configured: false, ok: false, version: null, proofSha256: null,
      latencyMs: null, cached: false, error: 'bend_not_configured',
    };
  }
  if (!isAbsolute(bin)) {
    return {
      configured: true, ok: false, version: null, proofSha256: null,
      latencyMs: null, cached: false, error: 'O8_BEND_BIN must be an absolute path',
    };
  }

  const repoRoot = options.repoRoot ?? process.cwd();
  const proofPath = join(repoRoot, BEND_PROOF_RELATIVE);
  let proof: string;
  try {
    proof = await readFile(proofPath, 'utf8');
  } catch (error) {
    return {
      configured: true, ok: false, version: null, proofSha256: null,
      latencyMs: null, cached: false,
      error: error instanceof Error ? error.message.slice(0, 500) : 'cannot read Bend proof',
    };
  }

  const proofSha256 = createHash('sha256').update(proof).digest('hex');
  const expected = env.O8_BEND_EXPECTED_VERSION?.trim() || DEFAULT_BEND_VERSION;
  const key = bin + '\0' + expected + '\0' + proofSha256;
  if (options.cache !== false) {
    const prior = cache.get(key);
    if (prior) return { ...prior, cached: true };
  }

  const run = options.run ?? defaultExecutor;
  const startedAt = performance.now();
  try {
    const bendEnv = cleanBendEnv(env);
    const common = { cwd: repoRoot, env: bendEnv, timeout: 30_000, maxBuffer: 64 * 1024 };
    const versionRun = await run(bin, ['version'], common);
    const match = /^bend\s+(\d+\.\d+\.\d+)\s*$/m.exec(versionRun.stdout);
    const version = match?.[1] ?? null;
    if (version !== expected) {
      return {
        configured: true, ok: false, version, proofSha256,
        latencyMs: Math.round(performance.now() - startedAt), cached: false,
        error: 'expected Bend ' + expected + ', got ' + (version ?? 'unknown'),
      };
    }

    const verdict = await run(bin, [proofPath, '--verdict'], common);
    const combined = verdict.stdout + '\n' + verdict.stderr;
    const ok = combined.split(/\r?\n/).some((line) => line.trim() === BEND_PASS);
    const result: BendShadowVerdict = {
      configured: true,
      ok,
      version,
      proofSha256,
      latencyMs: Math.round(performance.now() - startedAt),
      cached: false,
      error: ok ? null : 'Bend verdict did not report ALL PROOFS CHECK',
    };
    if (options.cache !== false) cache.set(key, result);
    return result;
  } catch (error) {
    return {
      configured: true, ok: false, version: null, proofSha256,
      latencyMs: Math.round(performance.now() - startedAt), cached: false,
      error: error instanceof Error ? error.message.slice(0, 500) : 'Bend verification failed',
    };
  }
}
