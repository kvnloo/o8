/**
 * `o8 verify` — run the o8 verification suite
 *
 * Validates core features, CLI commands, API endpoints, and development workflows.
 * Provides structured pass/fail/inconclusive evidence for quality gates.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT } from '../api.js';
import { printJson, printHumanHeading, printHumanKv, type OutputMode } from '../output.js';

interface VerifyCheck {
  check: string;
  description: string;
  status: 'passed' | 'failed' | 'inconclusive';
  exitCode: number;
  duration_ms: number;
  evidence: string;
  timestamp: string;
}

interface VerifyReport {
  schema: string;
  started: string;
  completed: string;
  evidenceDir: string;
  checks: VerifyCheck[];
  summary: {
    passed: number;
    failed: number;
    inconclusive: number;
    total: number;
  };
}

function parseVerifyArgs(rest: string[]): { report?: string; checks?: string[] } {
  let report: string | undefined;
  const checks: string[] = [];
  
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--report') {
      const next = rest[i + 1];
      if (!next || next.startsWith('--')) {
        throw new CliError('invalid_args', '--report requires a file path', EXIT.INVALID_ARGS);
      }
      report = next;
      i += 1;
    } else if (token === '--check') {
      const next = rest[i + 1];
      if (!next || next.startsWith('--')) {
        throw new CliError('invalid_args', '--check requires a check name', EXIT.INVALID_ARGS);
      }
      checks.push(next);
      i += 1;
    } else if (!token.startsWith('--')) {
      checks.push(token);
    } else {
      throw new CliError('invalid_args', `Unknown verify flag: ${token}`, EXIT.INVALID_ARGS);
    }
  }
  
  return { report, checks: checks.length > 0 ? checks : undefined };
}

function findVerifyScript(): string {
  // Try to locate the verify-all.sh script
  const candidates = [
    // Relative to CLI (when running from source)
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../.cursor/skills/verify-o8/verify-all.sh'),
    // Absolute workspace path
    '/workspace/.cursor/skills/verify-o8/verify-all.sh',
    // User home
    resolve(process.env.HOME || '~', '.cursor/skills/verify-o8/verify-all.sh'),
  ];
  
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  
  throw new CliError(
    'verify_script_not_found',
    'Could not find verify-all.sh. Expected at .cursor/skills/verify-o8/verify-all.sh',
    EXIT.NOT_FOUND,
  );
}

export async function runVerifySuite(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parseVerifyArgs(rest);
  const scriptPath = findVerifyScript();
  
  try {
    // Run the verification script
    const env = { ...process.env };
    if (args.report) {
      env.VERIFY_EVIDENCE_DIR = dirname(resolve(args.report));
    }
    
    const output = execFileSync('bash', [scriptPath], {
      encoding: 'utf8',
      env,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      windowsHide: true,
    });
    
    // Parse the report
    const reportMatch = output.match(/Report:\s+(.+\.json)/);
    if (!reportMatch) {
      throw new CliError('verify_failed', 'Could not parse verification report path', EXIT.CONFLICT);
    }
    
    const reportPath = reportMatch[1];
    const report: VerifyReport = JSON.parse(readFileSync(reportPath, 'utf8'));
    
    if (mode.human) {
      printHumanHeading('o8 verification suite');
      printHumanKv([
        ['started', report.started],
        ['completed', report.completed],
        ['evidence', report.evidenceDir],
      ]);
      
      printHumanHeading('summary');
      printHumanKv([
        ['passed', String(report.summary.passed)],
        ['failed', String(report.summary.failed)],
        ['inconclusive', String(report.summary.inconclusive)],
        ['total', String(report.summary.total)],
      ]);
      
      if (report.checks.length > 0) {
        printHumanHeading('checks');
        for (const check of report.checks) {
          const symbol = check.status === 'passed' ? '✓' : check.status === 'failed' ? '✗' : '?';
          const duration = `${check.duration_ms}ms`;
          process.stdout.write(`  ${symbol} ${check.check}: ${check.status} (${duration})\n`);
          if (check.status === 'failed' && mode.verbose) {
            try {
              const evidence = readFileSync(check.evidence, 'utf8').trim();
              const preview = evidence.slice(0, 200);
              process.stdout.write(`     ${preview}${evidence.length > 200 ? '...' : ''}\n`);
            } catch {
              // Evidence file might not exist
            }
          }
        }
      }
      
      const status = report.summary.failed === 0 ? 'PASSED' : 'FAILED';
      process.stdout.write(`\n${status}\n`);
    } else {
      printJson(report);
    }
    
    return report.summary.failed === 0 ? 0 : 1;
    
  } catch (error) {
    if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
      // execFileSync throws with status
      const exitCode = error.status;
      
      // Try to read the report even if the script failed
      const evidencePattern = /Evidence:\s+(.+)/;
      const reportPattern = /Report:\s+(.+\.json)/;
      
      const errorOutput = String(error);
      const evidenceMatch = errorOutput.match(evidencePattern);
      const reportMatch = errorOutput.match(reportPattern);
      
      if (reportMatch) {
        try {
          const reportPath = reportMatch[1];
          const report: VerifyReport = JSON.parse(readFileSync(reportPath, 'utf8'));
          
          if (mode.human) {
            printHumanHeading('o8 verification suite (FAILED)');
            printHumanKv([
              ['passed', String(report.summary.passed)],
              ['failed', String(report.summary.failed)],
              ['inconclusive', String(report.summary.inconclusive)],
            ]);
          } else {
            printJson(report);
          }
          
          return exitCode;
        } catch {
          // Fall through to generic error
        }
      }
      
      throw new CliError('verify_failed', `Verification script failed with exit ${exitCode}`, EXIT.CONFLICT);
    }
    
    throw error;
  }
}
