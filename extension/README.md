# Fluxa Tab Handoff extension (Manifest V3)

An explicit, one-click **current-tab URL/title** companion for Chrome/Chromium, Edge and Firefox-compatible Manifest V3 environments. It never reads cookies, passwords, page content, browser history, or tabs in the background; permissions are only `activeTab` and local `storage`. It does **not** copy a third-party login or entire browser session. The receiving device signs in independently.

## Use without a browser-store account

- **Chrome / Edge / Chromium:** visit `chrome://extensions` or `edge://extensions`, turn on Developer mode, choose **Load unpacked**, and select this `extension/` directory (or unzip the companion archive and select the unzipped directory). Keep Fluxa open in the same browser profile, paired and SAS-verified with the destination.
- **Firefox:** in a development installation, visit `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → choose `manifest.json`. Temporary extensions disappear on restart. Persistent public Firefox distribution requires a signed AMO/self-distributed `.xpi`; this repository has not submitted or signed one.
- Click the Fluxa extension while viewing an ordinary HTTP(S) tab. Choose **Fluxa web** and configure the exact web address used by your paired Fluxa tab, or choose **Installed Fluxa desktop app**. Click **Open Fluxa to review**. In Fluxa, inspect the full URL (queries/fragments may contain private tokens), select a verified destination and request handoff. On the other device, approve, then tap **Open link**. Neither approval automatically signs in or opens the URL.

The web option opens a URL **fragment** at your Fluxa origin; the fragment is not sent to the server. If a paired Fluxa tab is already open in that browser profile, a same-origin `BroadcastChannel` hands it the draft without replacing its live WebRTC connection. If no tab is open, the new Fluxa page holds the draft until you pair/verify a device. A local HTTP address is allowed only for a private/loopback host; public deployments require HTTPS.

The installed desktop option uses `fluxa://handoff?...` and your browser's external-app confirmation. Protocol registration depends on an installed desktop build/OS association; the browser may reject it on an unpacked or unregistered app. Switch to the web option when this happens. No native-messaging daemon, background service or commercial account is required. A browser may reject custom-scheme `tabs.create` outright; **this desktop-target invocation has not been validated in a real installed Windows/macOS/Linux desktop browser** (Electron's receiving handler was exercised in a Linux test).

## Developer checks

```sh
npm run test:extension
# Chrome/Chromium headful: load the extension unpacked and confirm it appears;
# web-handoff end-to-end: npx playwright test e2e/handoff-extension.spec.ts
```

No extension-store listing, store signing, notarisation or Firefox AMO signature has been produced by these tests.
