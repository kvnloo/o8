import { describe, expect, it } from 'vitest';

import { buildZ0ShadowRequest, observeZ0BendJudgmentShadow } from './shadow';

function input() {
  return {
    receiptId: 'jr-123',
    state: { tests_run: false, nested: { api_key: 'must-not-cross', keep: 1 } },
    questions: {
      verify: {
        type: 'choice' as const,
        instructions: 'Choose the next verification state',
        criteria: { VERIFY: 'verify', CONTINUE: 'continue' },
      },
    },
    context: { laneId: 'lane-1', packetId: 'packet-1', surface: 'test' },
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
      route: 'direct' as const,
      latencyMs: 42,
      inputTokens: 20,
      outputTokens: 3,
    },
  };
}

describe('o8 z0 + Bend shadow slice', () => {
  it('builds shadow/free-only evidence and strips credential-shaped fields', () => {
    const request = buildZ0ShadowRequest(input(), 1_000, '/tmp/o8-test');
    expect(request.mode).toBe('shadow');
    expect((request.policy as Record<string, unknown>).free_only).toBe(true);
    expect((request.policy as Record<string, unknown>).allow_remote_context).toBe(false);
    expect(JSON.stringify(request)).not.toContain('must-not-cross');
    expect(JSON.stringify(request)).not.toContain('api_key');
  });

  it('records z0 + Bend evidence without applying or minting verified success', async () => {
    let stored: unknown = null;
    const receipt = await observeZ0BendJudgmentShadow(input(), {
      dataDir: '/tmp/o8-test',
      env: {},
      callBridge: async () => ({
        ok: true,
        transport: 'python',
        latencyMs: 7,
        route: { kind: 'PARENT_ONLY', reason: 'fixture' },
        replayed: false,
        requestSha256: 'b'.repeat(64),
        error: null,
      }),
      verifyBend: async () => ({
        configured: true,
        ok: true,
        version: '2.0.35',
        proofSha256: 'c'.repeat(64),
        latencyMs: 9,
        cached: false,
        error: null,
      }),
      persist: async (value) => { stored = value; },
    });

    expect(receipt.applied).toBe(false);
    expect(receipt.verifiedSuccess).toBe(false);
    expect(receipt.z0.ok).toBe(true);
    expect(receipt.bend.ok).toBe(true);
    expect(stored).toEqual(receipt);
  });
});
