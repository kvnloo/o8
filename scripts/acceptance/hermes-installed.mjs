#!/usr/bin/env node
// Safe default: preflight only. No installation, provider prompt, or UI auto-send.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { digest } from './hermes-observer.mjs';
import { UI_CHECKS, validateUi, validateWire } from './hermes-evidence.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const live = args.includes('--live');
const verifying = option('--verify');
const root = verifying ? realpathSync(verifying) : option('--output')
  ? path.resolve(option('--output')) : mkdtempSync(path.join(tmpdir(), 'o8-hermes-acceptance-'));
if (!verifying && option('--output')) mkdirSync(root, { mode: 0o700 }); // Never overwrite a previous run.
const save = (name, data) => writeFileSync(path.join(root, name), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
const json = (name) => JSON.parse(readFileSync(path.join(root, name), 'utf8'));
const candidates = [process.env.O8_HERMES_BIN, ...((process.env.PATH ?? '').split(path.delimiter).map((p) => path.join(p, 'hermes')))];
const binary = candidates.find((p) => p && existsSync(p) && statSync(p).isFile());
const sourceHome = process.env.HERMES_HOME || path.join(process.env.HOME || '', '.hermes');
const blockers = [];
const sourceStatus = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
if (sourceStatus.status !== 0 || sourceStatus.stdout.trim()) blockers.push('Acceptance source must be a clean committed checkout');
if (Number(process.versions.node.split('.')[0]) !== 22) blockers.push('Node 22 required by this checkout');
if (process.platform === 'win32') blockers.push('This observer launcher requires POSIX; use the documented POSIX acceptance host');
if (!binary) blockers.push('Installed Hermes binary absent; install/configure it manually on the acceptance host');
if (!existsSync(path.join(sourceHome, 'config.yaml'))) blockers.push('Configured Hermes source profile absent; run hermes setup manually');
if (!existsSync(path.join(repo, 'node_modules/tsx/dist/loader.mjs'))) blockers.push('Repository dependencies absent; run npm ci with Node 22 / npm 11');
if (!process.env.O8_HERMES_ACCEPTANCE_MODEL) blockers.push('Set O8_HERMES_ACCEPTANCE_MODEL to an available non-default ACP model ID');
if (!['local', 'subscription'].includes(process.env.O8_HERMES_ACCEPTANCE_ROUTE)) blockers.push('Explicit reviewed non-metered route required: local or subscription');
if (process.env.O8_HERMES_ACCEPTANCE_AUTHORIZED !== 'yes') blockers.push('Operator must authorize bounded scratch prompts and review provider route/tool boundary');

let report;
if (verifying) {
  report = json('receipt.json');
  try {
    const facts = json('runtime-facts.json');
    if (report.mode !== 'installed' || report.sourceClean !== true || !facts.installedBinarySha256 || facts.runId !== report.runId || facts.commit !== report.commit) throw new Error('Runtime binding mismatch');
    validateWire(readFileSync(path.join(root, 'wire.jsonl'), 'utf8').trim().split('\n').map(JSON.parse), facts);
    report.installedRuntime = 'PASS';
  } catch { report.installedRuntime = 'FAIL'; report.blockers.push('Saved runtime evidence failed revalidation'); }
}
else {
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  report = { schema: 1, runId: randomUUID(), observedAt: new Date().toISOString(),
    commit: commit.status === 0 ? commit.stdout.trim() : 'unknown', sourceClean: sourceStatus.status === 0 && !sourceStatus.stdout.trim(), mode: live ? 'installed' : 'preflight',
    installedRuntime: 'BLOCKED', missionAndRippleUi: 'BLOCKED', overall: 'BLOCKED', blockers };
  save('ui-template.json', { runId: report.runId, reviewer: '', appCommit: '', device: '', observedAt: '', physicalPairedDevice: false,
    checks: Object.fromEntries(UI_CHECKS.map((key) => [key, { status: 'NOT_RUN', artifacts: [] }])) });
  if (live && !blockers.length) {
    const privateRoot = path.join(root, 'private'); mkdirSync(privateRoot, { mode: 0o700 });
    const log = path.join(privateRoot, 'driver.log');
    const { openSync, closeSync } = await import('node:fs');
    const fd = openSync(log, 'wx', 0o600);
    const result = spawnSync(process.execPath, ['--import', path.join(repo, 'scripts/register-server-only-stub.mjs'),
      '--import', 'tsx', path.join(repo, 'scripts/acceptance/hermes-installed-driver.ts')], {
      cwd: repo, timeout: 600_000, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env,
        O8_HERMES_ACCEPTANCE_ROOT: root, O8_HERMES_ACCEPTANCE_REAL_BIN: realpathSync(binary),
        O8_HERMES_ACCEPTANCE_RUN_ID: report.runId, O8_HERMES_ACCEPTANCE_COMMIT: report.commit,
        O8_DATA_DIR: privateRoot, CORTEX_IDE_DATA_DIR: privateRoot,
        O8_OWNED_HERMES_ROOT: path.join(privateRoot, 'sessions'),
      },
    }); closeSync(fd);
    if (result.status !== 0 && result.pid) {
      // This is a new session/process group owned only by this acceptance run.
      try { process.kill(-result.pid, 'SIGTERM'); } catch { /* already retired */ }
    }
    report.installedRuntime = 'FAIL';
    if (result.status === 0) {
      try {
        const facts = json('runtime-facts.json');
        const rows = readFileSync(path.join(root, 'wire.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        validateWire(rows, facts);
        report.installedRuntime = 'PASS'; report.runtime = facts;
      } catch { report.blockers.push('ACP evidence incomplete or contradictory; inspect private logs and wire metadata'); }
    } else report.blockers.push('Production runtime driver failed or timed out; inspect private/driver.log locally');
  }
}
const uiPath = option('--ui') || (verifying && existsSync(path.join(root, 'ui-evidence.json')) ? path.join(root, 'ui-evidence.json') : undefined);
report.missionAndRippleUi = 'BLOCKED';
if (uiPath) {
  try {
    const file = realpathSync(uiPath);
    const ui = JSON.parse(readFileSync(file, 'utf8'));
    validateUi(ui, report.runId, report.commit, report.observedAt);
    for (const row of Object.values(ui.checks)) for (const artifact of row.artifacts) {
      const target = realpathSync(path.resolve(path.dirname(file), artifact.path));
      const relative = path.relative(path.dirname(file), target);
      if (relative.startsWith('..') || path.isAbsolute(relative) || statSync(target).size > 20 * 1024 * 1024) throw new Error('Unbounded UI artifact');
      if (digest(readFileSync(target)) !== artifact.sha256) throw new Error('UI artifact digest mismatch');
    }
    report.missionAndRippleUi = 'PASS'; report.ui = ui;
  } catch { report.missionAndRippleUi = 'FAIL'; report.blockers.push('UI evidence missing, mismatched, or invalid'); }
}
report.overall = report.installedRuntime === 'FAIL' || report.missionAndRippleUi === 'FAIL' ? 'FAIL'
  : report.installedRuntime === 'PASS' && report.missionAndRippleUi === 'PASS' ? 'PASS' : 'BLOCKED';
save('receipt.json', report);
console.log(JSON.stringify({ status: report.overall, installedRuntime: report.installedRuntime,
  missionAndRippleUi: report.missionAndRippleUi, blockers: report.blockers, receipt: path.join(root, 'receipt.json') }, null, 2));
process.exitCode = report.overall === 'PASS' ? 0 : report.overall === 'FAIL' ? 1 : 2;
