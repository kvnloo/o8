/**
 * Tauri Desktop — Barrel Export
 */

export {
  isTauri,
  getDesktopInfo,
  getDisplayRefresh,
  checkPort,
  startWsServer,
  cortexAvailable,
  getAppDataDir,
  notify,
  showWindow,
  hideWindow,
  storeGet,
  storeSet,
} from './bridge';

export type {
  DesktopInfo,
  DisplayRefreshInfo,
  SidecarResult,
} from './bridge';
