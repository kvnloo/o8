import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { confinedVerificationExecFile } from '@/lib/lane/confined-verification-exec';
import { runLaneRebaseLint } from '@/lib/lane/rebase-lint';
import { runLaneRebaseTests } from '@/lib/lane/rebase-tests';
import { runLaneRebaseTypecheck } from '@/lib/lane/rebase-typecheck';
import { runPiCommand } from '@/lib/pi/sdk/command';

// These tests execute the actual runner + native OS supervisor. They do NOT
// mock the security boundary. The CI runner must build o8-pi-write first.
const temporary: string[] = [];
function fixture(label: string): { lane: string; outside: string } {
  const root = mkdtempSync(path.join(tmpdir(), `o8-3414-${label}-`));
  temporary.push(root);
  const lane = path.join(root, 'lane');
  mkdirSync(lane);
  // Outside the allowed worktree and outside the runner's private temp dir.
  return { lane, outside: path.join(root, 'outside-marker') };
}

function git(cwd: string, args: string[]): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd, env, encoding: 'utf8',
  }).trim();
}
function commitAll(cwd: string, message: string) {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=test@example.test', 'commit', '-m', message]);
}
function lintRepo(lane: string, eslintConfig: string) {
  git(lane, ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(lane, 'package.json'), JSON.stringify({
    private: true, scripts: { lint: 'eslint .' },
  }));
  writeFileSync(path.join(lane, '.gitignore'), 'node_modules/\n');
  symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(lane, 'node_modules'), 'junction');
  writeFileSync(path.join(lane, 'eslint.config.mjs'), eslintConfig);
  mkdirSync(path.join(lane, 'src'));
  writeFileSync(path.join(lane, 'src', 'packet.js'), 'console.log("base");\n');
  commitAll(lane, 'base');
  git(lane, ['checkout', '-q', '-b', 'packet/3414']);
}
afterEach(() => {
  for (const p of temporary.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe('lane verification native confinement (#3414)', () => {
  it('allows a benign read/write inside the lane and reports a real exit status', async () => {
    const { lane } = fixture('positive');
    const result = await confinedVerificationExecFile(process.execPath, [
      '-e', "require('node:fs').writeFileSync('inside.txt', 'ok');process.stdout.write('INSIDE_OK')",
    ], { cwd: lane, timeout: 15_000 });
    expect(result.stdout).toContain('INSIDE_OK');
    expect(existsSync(path.join(lane, 'inside.txt'))).toBe(true);
  }, 30_000);

  it('refuses to run a command when the installed confinement helper is missing', async () => {
    const { lane, outside } = fixture('missing-helper');
    const before = process.env.O8_PI_WRITE_BIN;
    process.env.O8_PI_WRITE_BIN = path.join(lane, 'not-an-executable');
    try {
      await expect(confinedVerificationExecFile(process.execPath, [
        '-e', `require('node:fs').writeFileSync(${JSON.stringify(outside)}, 'escaped')`,
      ], { cwd: lane, timeout: 5_000 })).rejects.toThrow(/Refused unconfined lane verification/);
      expect(existsSync(outside)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.O8_PI_WRITE_BIN;
      else process.env.O8_PI_WRITE_BIN = before;
    }
  }, 15_000);

  it('rejects symlink escapes from inside the permitted lane', async () => {
    const { lane, outside } = fixture('symlink');
    symlinkSync(path.dirname(lane), path.join(lane, 'escape'), 'dir');
    await expect(confinedVerificationExecFile(process.execPath, [
      '-e', "require('node:fs').writeFileSync('started','yes');require('node:fs').writeFileSync('escape/outside-marker','escaped')",
    ], { cwd: lane, timeout: 15_000 })).rejects.toThrow();
    expect(existsSync(path.join(lane, 'started'))).toBe(true);
    expect(existsSync(outside)).toBe(false);
  }, 30_000);

  it('blocks an attempted host write from the npm test script', async () => {
    const { lane, outside } = fixture('npm');
    writeFileSync(path.join(lane, 'package.json'), JSON.stringify({
      name: 'probe',
      scripts: { test: `node -e "const f=require('node:fs');f.writeFileSync('started','yes');f.writeFileSync('${outside}','escaped')"` },
    }));
    const result = await runLaneRebaseTests({
      cwd: lane, actualBranch: 'packet/3414', logPrefix: '3414',
    });
    expect(existsSync(path.join(lane, 'started'))).toBe(true);
    expect(existsSync(outside)).toBe(false);
    expect(result.ok).toBe(false);
  }, 30_000);

  it('blocks an attempted host write from a packet-controlled ESLint config', async () => {
    const { lane, outside } = fixture('head-lint');
    lintRepo(lane, "export default [{files:['**/*.js'],rules:{'no-console':'warn'}}];\n");
    writeFileSync(path.join(lane, 'eslint.config.mjs'), [
      "import {writeFileSync} from 'node:fs';",
      "writeFileSync('lint-started', 'yes');",
      `writeFileSync(${JSON.stringify(outside)}, 'escaped');`,
      "export default [{files:['**/*.js'],rules:{'no-console':'warn'}}];",
      '',
    ].join('\n'));
    writeFileSync(path.join(lane, 'src', 'packet.js'), 'console.log("head");\n');
    commitAll(lane, 'malicious config');
    const result = await runLaneRebaseLint({
      cwd: lane, baseRef: 'main', actualBranch: 'packet/3414', logPrefix: '3414',
    });
    expect(existsSync(path.join(lane, 'lint-started'))).toBe(true);
    expect(existsSync(outside)).toBe(false);
    expect(result.ok).toBe(false);
  }, 30_000);

  it('blocks an attempted host write from the separately cloned baseline ESLint config', async () => {
    const { lane, outside } = fixture('baseline-lint');
    lintRepo(lane, [
      "import {writeFileSync} from 'node:fs';",
      "console.error('BASELINE_CONFIG_RAN');",
      `writeFileSync(${JSON.stringify(outside)}, 'escaped');`,
      "export default [{files:['**/*.js'],rules:{'no-console':'warn'}}];",
      '',
    ].join('\n'));
    writeFileSync(path.join(lane, 'eslint.config.mjs'),
      "export default [{files:['**/*.js'],rules:{'no-console':'warn'}}];\n");
    writeFileSync(path.join(lane, 'src', 'packet.js'), 'console.log("head");\n');
    commitAll(lane, 'safe head config with prior warnings');
    const result = await runLaneRebaseLint({
      cwd: lane, baseRef: 'main', actualBranch: 'packet/3414', logPrefix: '3414',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.output).toContain('BASELINE_CONFIG_RAN');
    expect(existsSync(outside)).toBe(false);
  }, 30_000);

  it('blocks an attempted host write from a packet-supplied local tsc', async () => {
    const { lane, outside } = fixture('typecheck');
    writeFileSync(path.join(lane, 'package.json'), JSON.stringify({private:true}));
    writeFileSync(path.join(lane, 'tsconfig.json'), '{"compilerOptions":{}}');
    const bin = path.join(lane, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'tsc'), [
      '#!/usr/bin/env node',
      "require('node:fs').writeFileSync('tsc-started','yes');",
      `require('node:fs').writeFileSync(${JSON.stringify(outside)},'escaped');`,
    ].join('\n'));
    chmodSync(path.join(bin, 'tsc'), 0o755);
    const result = await runLaneRebaseTypecheck({
      cwd: lane, actualBranch: 'packet/3414', logPrefix: '3414',
    });
    expect(existsSync(path.join(lane, 'tsc-started'))).toBe(true);
    expect(existsSync(outside)).toBe(false);
    expect(result.ok).toBe(false);
  }, 30_000);
});

// The same real native process boundary must preserve machine-readable stdout
// even when the CLI writes diagnostics to stderr. Keep the shared output cap.
describe('confined verification stream contract (#3414)', () => {
  it('keeps JSON stdout separate from diagnostic stderr on success', async () => {
    const { lane } = fixture('json-streams');
    const result = await confinedVerificationExecFile(process.execPath, [
      '-e', "process.stdout.write('[]');process.stderr.write('warning\\n');",
    ], { cwd: lane, timeout: 15_000 });
    expect(result).toEqual({ stdout: '[]', stderr: 'warning\n' });
  }, 30_000);

  it('preserves exit 1 JSON and diagnostics without merging the streams', async () => {
    const { lane } = fixture('exit-one-streams');
    await expect(confinedVerificationExecFile(process.execPath, [
      '-e', "process.stdout.write('[]');process.stderr.write('too many warnings\\n');process.exitCode=1;",
    ], { cwd: lane, timeout: 15_000 })).rejects.toMatchObject({
      code: 1, stdout: '[]', stderr: 'too many warnings\n',
    });
  }, 30_000);

  it('keeps a stderr-only failure off stdout', async () => {
    const { lane } = fixture('stderr-only');
    await expect(confinedVerificationExecFile(process.execPath, [
      '-e', "process.stderr.write('bad config\\n');process.exitCode=2;",
    ], { cwd: lane, timeout: 15_000 })).rejects.toMatchObject({
      code: 2, stdout: '', stderr: 'bad config\n',
    });
  }, 30_000);

  it('decodes split UTF-8 in its own stream despite interleaved diagnostics', async () => {
    const { lane } = fixture('utf8-streams');
    const result = await confinedVerificationExecFile(process.execPath, [
      '-e', "const b=Buffer.from('✓');process.stdout.write(b.subarray(0,1));setTimeout(()=>{process.stderr.write('diagnostic');setTimeout(()=>process.stdout.write(b.subarray(1)),20)},20);",
    ], { cwd: lane, timeout: 15_000 });
    expect(result).toEqual({ stdout: '✓', stderr: 'diagnostic' });
  }, 30_000);

  it('retains both streams in the existing text result', async () => {
    const { lane } = fixture('text-compat');
    const result = await runPiCommand(lane, 'printf stream-out; printf stream-err >&2',
      AbortSignal.timeout(15_000), { confined: true });
    expect(typeof result).toBe('string');
    expect(result).toContain('Exit code 0');
    expect(result).toContain('stream-out');
    expect(result).toContain('stream-err');
  }, 30_000);

  it('shares a single byte allowance across stdout and stderr', async () => {
    const { lane } = fixture('shared-cap');
    const result = await runPiCommand(lane, "printf '%0800d' 0; printf '%0800d' 0 >&2; sleep 2",
      AbortSignal.timeout(15_000), { confined: true, structuredResult: true, maxOutputBytes: 1000 });
    expect(result.stopped).toBe('output');
    expect(Buffer.byteLength(result.output)).toBe(1000);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(1000);
  }, 30_000);

  it('allows unchanged warnings through confined head and baseline lint', async () => {
    const { lane } = fixture('baseline-warning-control');
    lintRepo(lane, "export default [{files:['**/*.js'],rules:{'no-console':'warn'}}];\n");
    writeFileSync(path.join(lane, 'src', 'packet.js'), 'console.log("head");\n');
    commitAll(lane, 'same warning in changed file');
    const result = await runLaneRebaseLint({
      cwd: lane, baseRef: 'main', actualBranch: 'packet/3414', logPrefix: '3414',
    });
    expect(result).toEqual({ ok: true });
  }, 30_000);
});
