import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// These tests isolate warning-diff semantics. The resource integration lane
// separately uses the real native confined subprocess, not this mock.
vi.mock('./confined-verification-exec', async () => {
  const { materializationAwareExecFile } = await import('@/lib/worktree/materialization-execution');
  return { confinedVerificationExecFile: vi.fn(materializationAwareExecFile) };
});

import { materializationAwareExecFile } from '@/lib/worktree/materialization-execution';
import { confinedVerificationExecFile } from './confined-verification-exec';
import { runLaneRebaseLint } from './rebase-lint';

const tempDirs: string[] = [];

function makeDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `o8-rebase-lint-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ['add', '-A']);
  git(cwd, [
    '-c', 'user.name=o8-test',
    '-c', 'user.email=o8@example.test',
    'commit',
    '-m',
    message,
  ]);
}

function writePackage(cwd: string, lintScript = 'eslint .'): void {
  writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    private: true,
    scripts: lintScript ? { lint: lintScript } : {},
    devDependencies: { eslint: '^9.39.5' },
  }));
}

function initLintRepo(label: string): string {
  const repo = makeDir(label);
  git(repo, ['init', '-b', 'main']);
  writePackage(repo);
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(repo, 'eslint.config.mjs'), [
    'export default [{',
    "  files: ['**/*.js'],",
    "  rules: { 'no-console': 'warn', 'no-unused-vars': 'warn' },",
    '}];',
    '',
  ].join('\n'));
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(repo, 'node_modules'), 'junction');
  return repo;
}

afterEach(() => {
  vi.mocked(confinedVerificationExecFile).mockReset();
  vi.mocked(confinedVerificationExecFile).mockImplementation(materializationAwareExecFile);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runLaneRebaseLint', () => {
  it('skips when the repository has no lint script or ESLint config', async () => {
    const noScript = makeDir('no-script');
    writePackage(noScript, '');
    writeFileSync(path.join(noScript, 'eslint.config.mjs'), 'export default [];\n');
    await expect(runLaneRebaseLint({
      cwd: noScript,
      baseRef: 'main',
      actualBranch: 'packet/no-script',
      logPrefix: 'test',
    })).resolves.toEqual({ ok: true, skipped: 'package.json has no lint script' });

    const noConfig = makeDir('no-config');
    writePackage(noConfig);
    await expect(runLaneRebaseLint({
      cwd: noConfig,
      baseRef: 'main',
      actualBranch: 'packet/no-config',
      logPrefix: 'test',
    })).resolves.toEqual({ ok: true, skipped: 'no ESLint config was found' });
  });

  it('allows a changed file whose warning count does not increase and blocks a new warning', async () => {
    const repo = initLintRepo('warning-diff');
    writeFileSync(path.join(repo, 'src', 'packet.js'), 'console.log("base");\n');
    commitAll(repo, 'base');
    git(repo, ['checkout', '-b', 'packet/warnings']);
    writeFileSync(path.join(repo, 'src', 'packet.js'), 'console.log("base");\nexport const value = 1;\n');
    commitAll(repo, 'keep warning count');

    await expect(runLaneRebaseLint({
      cwd: repo,
      baseRef: 'main',
      actualBranch: 'packet/warnings',
      logPrefix: 'test',
    })).resolves.toEqual({ ok: true });

    writeFileSync(
      path.join(repo, 'src', 'packet.js'),
      'console.log("base");\nconsole.log("new");\nexport const value = 1;\n',
    );
    commitAll(repo, 'add warning');

    const result = await runLaneRebaseLint({
      cwd: repo,
      baseRef: 'main',
      actualBranch: 'packet/warnings',
      logPrefix: 'test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.output).toContain('src/packet.js:2:no-console');
  }, 20_000);

  it('blocks a new warning identity when a different base warning was fixed', async () => {
    const repo = initLintRepo('warning-swap');
    writeFileSync(path.join(repo, 'src', 'packet.js'), 'console.log("base");\n');
    commitAll(repo, 'base warning');
    git(repo, ['checkout', '-b', 'packet/warning-swap']);
    writeFileSync(path.join(repo, 'src', 'packet.js'), 'const replacement = 1;\nexport const value = 1;\n');
    commitAll(repo, 'swap warning');

    const result = await runLaneRebaseLint({
      cwd: repo,
      baseRef: 'main',
      actualBranch: 'packet/warning-swap',
      logPrefix: 'test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.output).toContain('src/packet.js:1:no-unused-vars');
      expect(result.output).not.toContain('no-console');
    }
  }, 20_000);

  it('allows an unchanged warning identity after its line shifts', async () => {
    const repo = initLintRepo('warning-shift');
    writeFileSync(path.join(repo, 'src', 'packet.js'), 'console.log("base");\n');
    commitAll(repo, 'base warning');
    git(repo, ['checkout', '-b', 'packet/warning-shift']);
    writeFileSync(
      path.join(repo, 'src', 'packet.js'),
      'export const value = 1;\n\nconsole.log("base");\n',
    );
    commitAll(repo, 'shift warning');

    await expect(runLaneRebaseLint({
      cwd: repo,
      baseRef: 'main',
      actualBranch: 'packet/warning-shift',
      logPrefix: 'test',
    })).resolves.toEqual({ ok: true });
  }, 20_000);

  it('turns the hard timeout into a skipped receipt', async () => {
    const repo = makeDir('timeout');
    git(repo, ['init', '-b', 'main']);
    writePackage(repo);
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    writeFileSync(path.join(repo, 'eslint.config.mjs'), 'export default [];\n');
    mkdirSync(path.join(repo, 'node_modules', 'eslint', 'bin'), { recursive: true });
    writeFileSync(path.join(repo, 'node_modules', 'eslint', 'package.json'), JSON.stringify({
      name: 'eslint',
      version: '9.0.0',
    }));
    const eslintScript = path.join(repo, 'node_modules', 'eslint', 'bin', 'eslint.js');
    writeFileSync(eslintScript, '#!/usr/bin/env node\nsetTimeout(() => {}, 10_000);\n');
    chmodSync(eslintScript, 0o755);
    writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    commitAll(repo, 'base');
    git(repo, ['checkout', '-b', 'packet/timeout']);
    writeFileSync(path.join(repo, 'packet.js'), 'export const value = 1;\n');
    commitAll(repo, 'packet');

    const result = await runLaneRebaseLint({
      cwd: repo,
      baseRef: 'main',
      actualBranch: 'packet/timeout',
      logPrefix: 'test',
      timeoutMs: 100,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skipped).toContain('timeout');
  });
});

interface ExitCase {
  name: string;
  headCode?: number;
  baseCode?: number;
  headKind?: 'warning' | 'error' | 'empty';
  baseKind?: 'warning' | 'empty';
  injected?: string;
  baselineOnly?: boolean;
  baseline?: boolean;
  expected: boolean;
}

const exitCases: ExitCase[] = [
  { name: 'head exit 2 cannot become pass', headCode: 2, expected: false },
  { name: 'head exit 125 cannot become pass', headCode: 125, expected: false },
  { name: 'confined output stop cannot become pass', injected: 'VERIFICATION_CONFINEMENT_REQUIRED', expected: false },
  { name: 'unknown supervisor status cannot become pass', injected: 'UNKNOWN', expected: false },
  { name: 'baseline exit 2 cannot become pass', headCode: 1, headKind: 'warning', baseCode: 2, baseKind: 'warning', expected: false, baseline: true },
  { name: 'baseline confinement refusal cannot become pass', injected: 'VERIFICATION_CONFINEMENT_REQUIRED', baselineOnly: true, headKind: 'warning', baseKind: 'warning', expected: false, baseline: true },
  { name: 'clean exit 0 remains pass', expected: true },
  { name: 'exit 1 lint error remains fail', headCode: 1, headKind: 'error', expected: false },
  { name: 'exit 1 unchanged warning remains pass', headCode: 1, baseCode: 1, headKind: 'warning', baseKind: 'warning', expected: true, baseline: true },
  { name: 'exit 1 new warning remains fail', headCode: 1, headKind: 'warning', baseKind: 'empty', expected: false, baseline: true },
];

// Real Git checkouts and Node CLI fixtures exercise the production lint gate.
// The existing process-boundary mock also injects supervisor refusal envelopes;
// these tests do not certify native OS confinement.
describe('runLaneRebaseLint execution status (#3414)', () => {
  it.each(exitCases)('$name', async (scenario) => {
    const repo = makeDir('exit-contract');
    git(repo, ['init', '-b', 'main']);
    writePackage(repo);
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    writeFileSync(path.join(repo, 'eslint.config.mjs'), 'export default [];\n');
    mkdirSync(path.join(repo, 'src'));
    const eslint = path.join(repo, 'node_modules', 'eslint');
    mkdirSync(path.join(eslint, 'bin'), { recursive: true });
    writeFileSync(path.join(eslint, 'package.json'), JSON.stringify({ name: 'eslint', version: '9.0.0' }));
    writeFileSync(path.join(eslint, 'bin', 'eslint.js'), [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const scenario = ${JSON.stringify(scenario)};`,
      "const phase = fs.readFileSync('.phase', 'utf8');",
      "const kind = scenario[phase + 'Kind'] || 'empty';",
      "const messages = [{ruleId:'fixture',severity:kind==='error'?2:1,message:'fixture diagnostic',line:1}];",
      "const rows = kind === 'empty' ? [] : [{filePath:path.join(process.cwd(),'src/packet.js'),messages}];",
      "process.stdout.write(JSON.stringify(rows), () => { process.exitCode = scenario[phase + 'Code'] || 0; });",
      '',
    ].join('\n'));
    writeFileSync(path.join(repo, 'src', 'packet.js'), 'export const value = 1;\n');
    writeFileSync(path.join(repo, '.phase'), 'base');
    commitAll(repo, 'base');
    git(repo, ['checkout', '-b', 'packet/exit-contract']);
    writeFileSync(path.join(repo, 'src', 'packet.js'), 'export const value = 2;\n');
    writeFileSync(path.join(repo, '.phase'), 'head');
    commitAll(repo, 'head');

    const phases: string[] = [];
    vi.mocked(confinedVerificationExecFile).mockImplementation(async (command, args, options) => {
      const phase = readFileSync(path.join(options.cwd, '.phase'), 'utf8');
      phases.push(phase);
      const reply = await materializationAwareExecFile(command, args, options);
      if (scenario.injected && (!scenario.baselineOnly || phase === 'base')) {
        throw Object.assign(new Error('Confined lane verification stopped: output'), {
          stdout: reply.stdout, stderr: reply.stderr, code: scenario.injected,
        });
      }
      return reply;
    });
    const result = await runLaneRebaseLint({
      cwd: repo, baseRef: 'main', actualBranch: 'packet/exit-contract', logPrefix: 'test',
    });
    expect(result.ok).toBe(scenario.expected);
    if (scenario.baseline) expect(phases).toEqual(['head', 'base']);
    else expect(phases).toEqual(['head']);
  }, 20_000);
});
