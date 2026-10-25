import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor host for the Android and iOS application projects.
 *
 * Both native apps use the *same* client bundle as the web and desktop builds
 * (webDir: public), running inside the system WebView with a native filesystem
 * plugin for saving received files outside the app sandbox. There is no second
 * UI implementation to keep in sync.
 *
 * Mobile needs a signalling server: the app has no embedded one, so it pairs
 * against either the desktop app's embedded server on the LAN or a deployed
 * Fluxa server. That endpoint is configurable in the app (Settings → Signalling
 * server) and is stored per device.
 */
const config: CapacitorConfig = {
  appId: 'com.fluxa.transfer',
  appName: 'Fluxa',
  webDir: 'public',
  android: {
    // The packaged https://localhost origin must be allowed to connect to a
    // user-selected ws:// private-LAN desktop signalling server. Public ws://
    // hosts are rejected by normaliseSignalUrl; use wss:// across the internet.
    allowMixedContent: true,
    captureInput: false,
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    CapacitorHttp: { enabled: false },
  },
};

export default config;
