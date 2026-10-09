/** Worker-written verification code runs through the same OS confinement as
 * o8's governed Pi commands. No helper/sandbox means no command executes.
 * Retain the existing materialization identity guard inside the sandbox.
 *
 * Linux's Landlock denies writes outside the lane/private tmp and TCP, but
 * cannot restrict pathname Unix sockets. #3414 tracks that separate boundary.
 */
import type { ExecFileOptions } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { runPiCommand } from '@/lib/pi/sdk/command';
import { materializationGuardedInvocationForCwd } from '@/lib/worktree/materialization-execution';

interface VerificationExecOptions extends ExecFileOptions { cwd: string }

function quote(arg: string): string {
  return "'" + arg.replaceAll("'", "'\"'\"'") + "'";
}

function failure(message: string, stdout = '', stderr = '', code: number | string = 'VERIFICATION_CONFINEMENT_REQUIRED') {
  // Preserve child channels. Infrastructure failures with no output still need
  // a diagnostic so callers cannot mistake a refusal for a skipped compiler.
  return Object.assign(new Error(message), { stdout, stderr: stderr || (stdout ? '' : message), code });
}

/** execFile-compatible result, with actual exit/status from trusted native supervision. */
export async function confinedVerificationExecFile(
  command: string,
  args: readonly string[],
  options: VerificationExecOptions,
): Promise<{ stdout: string; stderr: string }> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw failure('Untrusted lane verification needs native confinement; unsupported host platform.');
  }
  const timeoutMs = options.timeout ?? 120_000;
  const maxOutputBytes = options.maxBuffer ?? 4 * 1024 * 1024;
  try {
    const cwd = await realpath(options.cwd);
    // Materialization rev/snapshot is checked by the original guard just before
    // exec inside the OS sandbox; the sandbox adds write/network restrictions.
    const invocation = materializationGuardedInvocationForCwd(command, args, options.cwd);
    const line = [invocation.command, ...invocation.args].map(quote).join(' ');
    const result = await runPiCommand(cwd, line, AbortSignal.timeout(timeoutMs), {
      confined: true, structuredResult: true, timeoutMs,
      maxOutputBytes,
    });
    if (result.stopped !== null) {
      throw failure(`Confined lane verification stopped: ${result.stopped}`, result.stdout, result.stderr);
    }
    if (result.code !== 0) {
      throw failure(`Confined lane verification exited ${result.code ?? 'unknown'}`, result.stdout, result.stderr, result.code ?? 'UNKNOWN');
    }
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error instanceof Error && 'stdout' in error) throw error;
    throw failure(`Refused unconfined lane verification (#3414): ${error instanceof Error ? error.message : String(error)}`);
  }
}
