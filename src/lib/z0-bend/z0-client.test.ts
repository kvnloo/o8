import { describe, expect, it } from 'vitest';

import { callZ0ShadowBridge, resolveZ0Transport, validateLoopbackBridgeUrl } from './z0-client';

const request = {
  protocol_version: 'o8.z0.bridge.v1',
  mode: 'shadow',
  trace_id: 'a'.repeat(64),
};

describe('z0 shadow transport', () => {
  it('accepts loopback only', () => {
    expect(validateLoopbackBridgeUrl('http://127.0.0.1:11501/v1/o8').hostname).toBe('127.0.0.1');
    expect(() => validateLoopbackBridgeUrl('https://example.com/v1/o8')).toThrow(/loopback/);
    expect(() => validateLoopbackBridgeUrl('http://127.0.0.1:11501/other')).toThrow(/exactly/);
  });

  it('requires the Python executable and checkout together', () => {
    expect(() => resolveZ0Transport({ O8_Z0_PYTHON: '/tmp/python' })).toThrow(/together/);
    expect(resolveZ0Transport({
      O8_Z0_PYTHON: '/tmp/python',
      O8_Z0_SOURCE_DIR: '/tmp/z0',
    })).toMatchObject({ kind: 'python', python: '/tmp/python', sourceDir: '/tmp/z0' });
  });

  it('fails closed if a shadow response claims execution', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      ok: true,
      protocol_version: 'o8.z0.bridge.v1',
      mode: 'shadow',
      trace_id: request.trace_id,
      executed: true,
      route: { kind: 'PARENT_ONLY' },
    }), { status: 200 });

    const result = await callZ0ShadowBridge(request, {
      env: { O8_Z0_SHADOW_URL: 'http://127.0.0.1:11501/v1/o8' },
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('shadow_executed');
  });
});
