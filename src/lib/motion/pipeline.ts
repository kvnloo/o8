/**
 * Frame pipeline for o8's desktop UI.
 *
 * o8 is a Tauri webview, not a game engine. Pixels reach the screen through
 * three layers that MUST stay decoupled:
 *
 *   1. OS compositor vsync
 *      macOS: Core Animation + Metal, CADisplayLink on the window's NSScreen
 *             (ProMotion 120, or a 540 Hz panel if that's the screen).
 *      Linux: Mutter/KWin/wlroots + WebKitGTK's EGL compositor.
 *      Windows: DWM + WebView2 (Chromium).
 *      CSS `transform`/`opacity` (and the `.o8-fam` / thought-shimmer
 *      keyframes) interpolate HERE. A 540 Hz display can make those marks
 *      look smoother without any JS running at 540 Hz.
 *
 *   2. WebView JavaScript (`requestAnimationFrame`)
 *      WKWebView / WebKitGTK may cap rAF below the display (historically 60,
 *      often 120 on ProMotion, not guaranteed at 540). Anything that
 *      `setState`s or redraws a canvas on every rAF will multiply CPU with
 *      refresh rate. JS motion therefore uses a 60 Hz *design cadence*
 *      (chat reveal, springs that must touch layout) and a 120 Hz *sim cap*
 *      for canvas/WebGL toys. Wall-clock `dt` keeps perceived speed stable
 *      when rAF is 30, 60, 120, or 540.
 *
 *   3. Optional GPU toys (canvas 2D, WebGL, future WebGPU)
 *      Preview labs (`/preview/canvas-glass`, `/preview/effects`) and boot
 *      ASCII. One context, pause on `document.hidden`, pixel-cap, never
 *      under the dashboard React tree. WebGPU is an effects backend on
 *      Linux/Chromium, not a replacement for WKWebView/WebKitGTK chrome.
 *      macOS already composites the UI on Metal; rewriting the dashboard
 *      in wgpu would fight the webview, not accelerate it.
 *
 * React layout at display refresh is a foot-gun: a 540 Hz panel would
 * otherwise run `useSmoothText` ~9× faster and 9× more often than the
 * 60 fps design those loops were written against.
 */

export const DESIGN_HZ = 60;
export const DESIGN_FRAME_MS = 1000 / DESIGN_HZ;
/** Ceiling for JS/canvas simulation. CSS compositor motion stays uncapped. */
export const JS_SIM_MAX_HZ = 120;
/** One-tick catch-up cap so a backgrounded tab does not dump queued work. */
export const MAX_CATCHUP_MS = 48;

export type CompositorId = 'core-animation' | 'webkitgtk' | 'webview2' | 'browser';
export type GpuBackendId = 'metal' | 'egl' | 'd3d' | 'unknown';

export function compositorForPlatform(
  platform: string | null | undefined,
): { compositor: CompositorId; gpuBackend: GpuBackendId } {
  switch (platform) {
    case 'macos':
    case 'darwin':
      return { compositor: 'core-animation', gpuBackend: 'metal' };
    case 'linux':
      return { compositor: 'webkitgtk', gpuBackend: 'egl' };
    case 'windows':
    case 'win32':
      return { compositor: 'webview2', gpuBackend: 'd3d' };
    default:
      return { compositor: 'browser', gpuBackend: 'unknown' };
  }
}

export function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}
