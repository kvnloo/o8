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
