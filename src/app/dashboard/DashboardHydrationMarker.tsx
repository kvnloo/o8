'use client';

import { useEffect } from 'react';
import { installLongLivedFetchBudgetGuard } from '@/lib/connection-budget';
import { keepWaitingForPaint } from '@/lib/motion/paint-deadline';
import { getDisplayRefresh, isTauri } from '@/lib/tauri/bridge';

// The pre-ship boot gate (scripts/preship-webview-gate.mjs) treats
// `data-o8-dashboard-hydrated` as proof the dashboard booted cleanly. We only
// stamp it once the workspace subtree has actually PAINTED — i.e. the
// [data-o8-workspace] anchor (TileContainer's root) exists with a real box —
// not merely once an effect ran. A white-screen or empty render that never
// throws therefore cannot report healthy, and a route-boundary mount error
// (data-o8-mount-error) suppresses it outright.
export function DashboardHydrationMarker() {
  useEffect(() => {
    installLongLivedFetchBudgetGuard();

    const root = document.documentElement;
    root.removeAttribute('data-o8-dashboard-hydrated');

    let raf = 0;
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();

    const check = () => {
      const crashed = root.getAttribute('data-o8-mount-error') === '1';
      const ws = document.querySelector('[data-o8-workspace]');
      const painted = ws instanceof HTMLElement && ws.offsetHeight > 0 && ws.offsetWidth > 0;
      if (painted) {
        root.setAttribute('data-o8-dashboard-hydrated', '1');
        return;
      }
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (keepWaitingForPaint(now - started, painted, crashed)) {
        raf = window.requestAnimationFrame(check);
      }
    };
    raf = window.requestAnimationFrame(check);

    if (isTauri()) {
      void getDisplayRefresh().then((info) => {
        if (!info) return;
        const hz = info.native_hz == null ? 'unknown' : `${info.native_hz}Hz`;
        console.info(
          `[display-refresh] compositor=${info.compositor} gpu=${info.gpu_backend} native=${hz} scale=${info.scale_factor ?? 'n/a'}`,
        );
      });
    }

    return () => window.cancelAnimationFrame(raf);
  }, []);

  return null;
}
