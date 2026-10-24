/**
 * Installs the generated Fluxa mark as the Android launcher icon set:
 *   - legacy square and round launcher icons for every density
 *   - adaptive icons for API 26+
 *
 * Requires build/android/icon-*.png from scripts/make-icons.mjs.
 */
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const resDir = path.join(root, 'android/app/src/main/res');
const source = path.join(root, 'build/android');

const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

for (const [density, size] of Object.entries(DENSITIES)) {
  const dir = path.join(resDir, `mipmap-${density}`);
  await mkdir(dir, { recursive: true });
  await copyFile(path.join(source, `icon-${size}.png`), path.join(dir, 'ic_launcher.png'));
  await copyFile(path.join(source, `icon-${size}.png`), path.join(dir, 'ic_launcher_round.png'));
  await copyFile(path.join(source, `icon-${size}.png`), path.join(dir, 'ic_launcher_foreground.png'));
  // Remove the Capacitor/Cordova placeholder variants so nothing generic ships.
  for (const name of await readdir(dir)) {
    if (/^ic_launcher_(background|foreground)\.(webp|xml)$/.test(name) || name.endsWith('.webp')) {
      await rm(path.join(dir, name), { force: true });
    }
  }
}

const anydpi = path.join(resDir, 'mipmap-anydpi-v26');
await mkdir(anydpi, { recursive: true });
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/fluxa_icon_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
await writeFile(path.join(anydpi, 'ic_launcher.xml'), adaptive);
await writeFile(path.join(anydpi, 'ic_launcher_round.xml'), adaptive);

// Adaptive icons inset the foreground; a solid brand colour sits behind it.
const values = path.join(resDir, 'values');
await mkdir(values, { recursive: true });
const colorsPath = path.join(values, 'fluxa_colors.xml');
let colors = '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="fluxa_icon_background">#0A0B14</color>\n</resources>\n';
await writeFile(colorsPath, colors);

// Launch screens: replace Capacitor's placeholder logo splash with the Fluxa
// mark on the brand background for every density/orientation.
const SPLASH_FOLDERS = [
  'drawable',
  'drawable-port-mdpi',
  'drawable-port-hdpi',
  'drawable-port-xhdpi',
  'drawable-port-xxhdpi',
  'drawable-port-xxxhdpi',
  'drawable-land-mdpi',
  'drawable-land-hdpi',
  'drawable-land-xhdpi',
  'drawable-land-xxhdpi',
  'drawable-land-xxxhdpi',
];
for (const folder of SPLASH_FOLDERS) {
  const targetDir = path.join(resDir, folder);
  await mkdir(targetDir, { recursive: true });
  await copyFile(path.join(source, `splash-${folder}.png`), path.join(targetDir, 'splash.png'));
}

// Splash screen should not be the Capacitor default either.
const stylesPath = path.join(values, 'styles.xml');
try {
  const styles = await readFile(stylesPath, 'utf8');
  await writeFile(
    stylesPath,
    styles.replace(/<item name="android:background">[^<]*<\/item>/, '<item name="android:background">@color/fluxa_icon_background</item>'),
  );
} catch {
  /* styles.xml always exists in a Capacitor project; ignore if not */
}

console.log('android launcher icons installed from build/android');
