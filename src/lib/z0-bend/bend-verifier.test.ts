import { describe, expect, it } from 'vitest';

import { verifyBendShadowLaws, type BendExecutor } from './bend-verifier';

describe('native Bend shadow verifier', () => {
  it('pins the version, scrubs ambient verifier routing, and requires the kernel verdict', async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const run: BendExecutor = async (_file, args, options) => {
      calls.push({ args, env: options.env });
      if (args[0] === 'version') return { stdout: 'bend 2.0.35\n', stderr: '' };
      return { stdout: 'ALL PROOFS CHECK\n', stderr: '' };
    };

    const result = await verifyBendShadowLaws({
      env: {
        O8_BEND_BIN: '/opt/bend/bin/bend',
        O8_BEND_EXPECTED_VERSION: '2.0.35',
        BENDTT: '/tmp/poison',
      },
      repoRoot: process.cwd(),
      run,
      cache: false,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].env.BENDTT).toBeUndefined();
    expect(calls[1].env.BEND_NO_TELEMETRY).toBe('1');
    expect(calls[1].args.at(-1)).toBe('--verdict');
  });

  it('rejects an unqualified Bend version', async () => {
    const run: BendExecutor = async () => ({ stdout: 'bend 2.0.34\n', stderr: '' });
    const result = await verifyBendShadowLaws({
      env: { O8_BEND_BIN: '/opt/bend/bin/bend' },
      repoRoot: process.cwd(),
      run,
      cache: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/expected Bend 2.0.35/);
  });
});
