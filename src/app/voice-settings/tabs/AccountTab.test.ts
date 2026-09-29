// @vitest-environment jsdom

/**
 * Named invariant: account_tab_founder_uses_paid_path
 *
 * Voice settings AccountTab must treat plan:'founder' as paid (via shared
 * isPaidPlan), so a lifetime-paid member never sees the free Upgrade path.
 * Hermetic jsdom only — mocks entitlement fetch + tauri version.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => '0.0.0-test'),
}));

import AccountTab from './AccountTab';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

function mockEntitlement(plan: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ plan }),
    })),
  );
}

describe('account_tab_founder_uses_paid_path', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('does not treat founder as free — paid path, no Upgrade', async () => {
    mockEntitlement('founder');
    await act(async () => {
      root.render(createElement(AccountTab));
    });
    // Flush the entitlement fetch + setState.
    await act(async () => {});

    expect(container.textContent).toContain('Founder');
    expect(container.textContent).toContain('Active');
    expect(container.textContent).toContain('Pro features unlocked across o8.');
    expect(container.textContent).not.toContain(
      'Voice, dictation, and history are free forever.',
    );
    const upgrade = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Upgrade',
    );
    expect(upgrade).toBeUndefined();
  });

  it('still shows Upgrade on free plan', async () => {
    mockEntitlement('free');
    await act(async () => {
      root.render(createElement(AccountTab));
    });
    await act(async () => {});

    const upgrade = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Upgrade',
    );
    expect(upgrade).toBeDefined();
    expect(container.textContent).toContain(
      'Voice, dictation, and history are free forever.',
    );
    expect(container.textContent).not.toContain('Active');
  });
});
