/**
 * Desktop bridge (Electron preload). Absent in the browser build, where every
 * helper here degrades to `null`/no-op so the same client bundle serves both.
 */
export interface NearbyPeer {
  instanceId: string;
  name: string;
  platform: string;
  host: string;
  port: number;
  url: string;
  version: string;
}

export interface DesktopInfo {
  version: string;
  platform: string;
  arch: string;
  localUrl: string;
  serverPort: number | null;
  signalUrl: string | null;
  isPackaged: boolean;
  instanceId: string;
}

export interface DesktopBridge {
  isDesktop: true;
  info(): Promise<DesktopInfo>;
  setIdentity(identity: { deviceId: string; name: string; platform: string }): Promise<{ ok: boolean }>;
  nearby(): Promise<NearbyPeer[]>;
  onNearby(callback: (peers: NearbyPeer[]) => void): () => void;
  notify(title: string, body: string): Promise<{ ok: boolean }>;
  saveDialog(name: string): Promise<{ canceled: boolean; filePath: string | null }>;
  beginSave(filePath: string, size: number): Promise<{ ok: boolean; token?: string; error?: string }>;
  writeSave(token: string, offset: number, bytes: Uint8Array): Promise<{ ok: boolean; bytes?: number; error?: string }>;
  commitSave(token: string, sha256: string): Promise<{ ok: boolean; filePath?: string; bytes?: number; error?: string }>;
  abortSave(token: string): Promise<{ ok: boolean }>;
  /** Limited compatibility adapter; new exports always use the streaming API. */
  saveFile(filePath: string, bytes: Uint8Array): Promise<{ ok: boolean; filePath?: string; bytes?: number; error?: string }>;
  logLines(): Promise<string[]>;
}

declare global {
  interface Window {
    fluxaDesktop?: DesktopBridge;
  }
}

export function desktopBridge(): DesktopBridge | null {
  const bridge = typeof window !== 'undefined' ? window.fluxaDesktop : undefined;
  return bridge && bridge.isDesktop ? bridge : null;
}

/** File System Access API: lets the user pick a real destination and streams to it. */
export interface SaveFilePickerWindow {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>;
  }>;
}

/**
 * True when the File System Access picker can actually complete. It needs a
 * secure context, and it opens a native OS dialog that automation cannot drive —
 * so we also require `navigator.webdriver` to be false. Without that guard a
 * scripted browser would block forever on a dialog nobody can answer, instead of
 * falling back to a normal download.
 */
export function hasFilePicker(): boolean {
  if (typeof window === 'undefined') return false;
  if (!window.isSecureContext) return false;
  if (navigator.webdriver) return false;
  return typeof (window as unknown as SaveFilePickerWindow).showSaveFilePicker === 'function';
}
