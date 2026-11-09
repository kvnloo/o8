import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';

import { verifyBendShadowLaws } from '../../src/lib/z0-bend/bend-verifier';
import { buildZ0ShadowRequest, type JudgmentShadowInput } from '../../src/lib/z0-bend/shadow';
import { callZ0ShadowBridge } from '../../src/lib/z0-bend/z0-client';

function flag(name: string): string | null {
  const prefix = '--' + name + '=';
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function has(name: string): boolean {
  return process.argv.slice(2).includes('--' + name);
}

function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}

function stats(values: number[]) {
  return { n: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) };
}

function fixture(id: string): JudgmentShadowInput {
  return {
    receiptId: id,
    state: { files_changed: 2, tests_run: false, user_asked_ship: true },
    questions: {
      verify: {
        type: 'choice',
        instructions: 'What bounded next verification action is appropriate?',
        criteria: { VERIFY: 'run an explicit verification pass', CONTINUE: 'continue without another pass' },
      },
    },
    context: { laneId: 'bench-lane', packetId: 'bench-packet', surface: 'z0-bend-bench' },
    incumbent: {
      answers: {
        verify: {
          choice: 'VERIFY',
          probabilities: { VERIFY: 0.9, CONTINUE: 0.1 },
          confidence: 0.9,
          abstain: false,
        },
      },
      model: 'jev-latest',
      route: 'direct',
      latencyMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    },
  };
}

function exec(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; ms: number }> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error((error.message + '\n' + stderr).slice(0, 1000)));
      else resolve({ stdout, ms: Math.round(performance.now() - started) });
    });
  });
}

async function gpuSmoke(bin: string) {
  const env = { ...process.env, BEND_NO_TELEMETRY: '1' };
  delete env.BENDTT;
  delete env.BEND_ORIGIN;
  const root = process.cwd();
  const cpuFile = join(root, 'integrations/bend/o8-z0-shadow/cpu_smoke.bend');
  const gpuFile = join(root, 'integrations/bend/o8-z0-shadow/gpu_smoke.bend');
  const cpu = await exec(bin, [cpuFile], env);
  const gpu = await exec(bin, [gpuFile], env);
  const lastNumber = (text: string) => text.match(/\d+/g)?.at(-1) ?? null;
  const cpuValue = lastNumber(cpu.stdout);
  const gpuValue = lastNumber(gpu.stdout);
  return {
    parity: cpuValue === '262144' && gpuValue === cpuValue,
    cpuMs: cpu.ms,
    gpuMs: gpu.ms,
    speedup: gpu.ms > 0 ? cpu.ms / gpu.ms : null,
    cpuValue,
    gpuValue,
  };
}

async function main() {
  const samples = Math.max(1, Math.min(100, Number(flag('samples') ?? 20)));
  const z0Latencies: number[] = [];
  const bendLatencies: number[] = [];
  const routes: Record<string, number> = {};
  let z0Ok = 0;
  let bendOk = 0;
  let authorityViolations = 0;

  for (let i = 0; i < samples; i += 1) {
    const input = fixture('bench-' + Date.now() + '-' + i);
    const request = buildZ0ShadowRequest(input, Date.now(), process.env.O8_DATA_DIR || '/tmp/o8-z0-bench');
    const z0 = await callZ0ShadowBridge(request);
    z0Latencies.push(z0.latencyMs);
    if (z0.ok) z0Ok += 1;
    if (z0.error === 'shadow_executed') authorityViolations += 1;
    const kind = z0.route && typeof z0.route === 'object'
      ? String((z0.route as Record<string, unknown>).kind ?? 'unknown')
      : 'unavailable';
    routes[kind] = (routes[kind] ?? 0) + 1;

    const bend = await verifyBendShadowLaws({ cache: false });
    if (bend.latencyMs !== null) bendLatencies.push(bend.latencyMs);
    if (bend.ok) bendOk += 1;
  }

  const result: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    samples,
    z0: { ok: z0Ok, ...stats(z0Latencies), routes },
    bend: { ok: bendOk, ...stats(bendLatencies) },
    authorityViolations,
  };

  if (has('gpu')) {
    const bin = process.env.O8_BEND_BIN;
    if (!bin) throw new Error('--gpu requires O8_BEND_BIN');
    result.gpu = await gpuSmoke(bin);
  }

  const maxZ0P95 = Number(flag('max-z0-p95-ms') ?? NaN);
  const maxBendP95 = Number(flag('max-bend-p95-ms') ?? NaN);
  const minGpuSpeedup = Number(flag('min-gpu-speedup') ?? NaN);
  const z0P95 = (result.z0 as { p95Ms: number | null }).p95Ms;
  const bendP95 = (result.bend as { p95Ms: number | null }).p95Ms;
  const gpu = result.gpu as { parity?: boolean; speedup?: number | null } | undefined;

  const failures: string[] = [];
  if (authorityViolations) failures.push('shadow authority violation');
  if (z0Ok !== samples) failures.push('z0 failures ' + (samples - z0Ok) + '/' + samples);
  if (bendOk !== samples) failures.push('Bend failures ' + (samples - bendOk) + '/' + samples);
  if (Number.isFinite(maxZ0P95) && z0P95 !== null && z0P95 > maxZ0P95) failures.push('z0 p95 regression');
  if (Number.isFinite(maxBendP95) && bendP95 !== null && bendP95 > maxBendP95) failures.push('Bend p95 regression');
  if (gpu && gpu.parity !== true) failures.push('CPU/GPU parity failed');
  if (gpu && Number.isFinite(minGpuSpeedup) && (gpu.speedup ?? 0) < minGpuSpeedup) failures.push('GPU speedup below threshold');

  result.failures = failures;
  const out = flag('out');
  if (out) await writeFile(out, JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write('[z0-bend-bench] ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
