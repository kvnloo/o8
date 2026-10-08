import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// This is only the npm-script result-contract unit suite. The real confinement
// side-effect regression runs separately against the installed native helper.
vi.mock('./confined-verification-exec', async () => {
  const { materializationAwareExecFile } = await import('@/lib/worktree/materialization-execution');
  return { confinedVerificationExecFile: materializationAwareExecFile };
});

import { runLaneRebaseTests } from './rebase-tests';

const tempDirs: string[] = [];

function scaffold(testScript: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'o8-rebase-tests-'));
  tempDirs.push(dir);
  const pkg: { name: string; scripts?: Record<string, string> } = { name: 'fixture' };
  if (testScript !== null) pkg.scripts = { test: testScript };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('runLaneRebaseTests', () => {
  const base = { actualBranch: 'branch', logPrefix: 'test' };

  it('passes when the configured test command exits zero', async () => {
    const cwd = scaffold('exit 0');
    const result = await runLaneRebaseTests({ ...base, cwd });
    expect(result).toEqual({ ok: true, skipped: false });
  });

  it('fails with output when the test command exits non-zero', async () => {
    const cwd = scaffold('echo boom-failure && exit 1');
    const result = await runLaneRebaseTests({ ...base, cwd });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.output).toContain('boom-failure');
  });

  it('skips (treats as pass) when there is no test script', async () => {
    const cwd = scaffold(null);
    const result = await runLaneRebaseTests({ ...base, cwd });
    expect(result).toEqual({ ok: true, skipped: true });
  });

  it('skips the create-react-app placeholder test script', async () => {
    const cwd = scaffold('echo "Error: no test specified" && exit 1');
    const result = await runLaneRebaseTests({ ...base, cwd });
    expect(result).toEqual({ ok: true, skipped: true });
  });

  it('skips when there is no package.json at all', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'o8-rebase-tests-empty-'));
    tempDirs.push(cwd);
    const result = await runLaneRebaseTests({ ...base, cwd });
    expect(result).toEqual({ ok: true, skipped: true });
  });
});
