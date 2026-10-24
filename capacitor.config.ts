import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor host for the Android build.
 *
 * The Android app is the *same* client bundle as the web and desktop builds
 * (webDir: public), running inside the system WebView with a native filesystem
 * plugin for saving received files outside the app sandbox. There is no second
 * UI implementation to keep in sync.
 *
 * Android needs a signalling server: the app has no embedded one, so it pairs
 * against either the desktop app's embedded server on the LAN or a deployed
 * Fluxa server. That endpoint is configurable in the app (Settings → Signalling
 * server) and is stored per device.
 */
const config: CapacitorConfig = {
  appId: 'com.fluxa.transfer',
  appName: 'Fluxa',
  webDir: 'public',
  bundledWebRuntime: false,
  android: {
    allowMixedContent: false,
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
