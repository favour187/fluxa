import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Source guard complements the CI aapt2 check of the compiled APK manifest.
test('QR camera permission does not require camera hardware for manual-code pairing', () => {
  const xml = readFileSync(resolve(process.cwd(), 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  assert.match(xml, /<uses-permission\s+android:name="android\.permission\.CAMERA"\s*\/>/);
  for (const feature of ['android.hardware.camera', 'android.hardware.camera.any', 'android.hardware.camera.autofocus']) {
    const exact = feature.replace(/\./g, '\\.');
    assert.match(xml, new RegExp(`<uses-feature\\s+android:name="${exact}"\\s+android:required="false"\\s*\\/>`));
  }
});
