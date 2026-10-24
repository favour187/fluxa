/**
 * Generates Fluxa's application icons from the product mark.
 *
 * The mark is rendered in headless Chromium (the same renderer the app ships
 * with) at 1024×1024, then converted into the platform formats:
 *   build/icon.png      1024×1024 master (Linux, and the source for macOS)
 *   build/icon.ico      multi-size Windows icon (PNG-compressed entries)
 *   build/icons/NxN.png Linux icon set used by electron-builder
 *   build/android/      Android launcher icon sizes + launch screens
 *
 * Run: node scripts/make-icons.mjs
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(root, 'build');
const iconDir = path.join(buildDir, 'icons');

const SVG = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#151129"/>
      <stop offset="52%" stop-color="#0a0b14"/>
      <stop offset="100%" stop-color="#06121a"/>
    </linearGradient>
    <linearGradient id="flow" x1="96" y1="352" x2="416" y2="160" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#8B7CFF"/>
      <stop offset="55%" stop-color="#4FD1FF"/>
      <stop offset="100%" stop-color="#5AF2C6"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="34%" r="56%">
      <stop offset="0%" stop-color="#8B7CFF" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="#8B7CFF" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" rx="116" fill="url(#bg)"/>
  <rect width="512" height="512" rx="116" fill="url(#glow)"/>
  <rect x="14" y="14" width="484" height="484" rx="104" fill="none" stroke="#8B7CFF" stroke-opacity="0.28" stroke-width="3"/>
  <path d="M118 348c58 0 92-38 112-100 22-68 56-96 132-96"
        fill="none" stroke="url(#flow)" stroke-width="34" stroke-linecap="round"/>
  <circle cx="368" cy="152" r="30" fill="url(#flow)"/>
  <circle cx="368" cy="152" r="12" fill="#07131a" fill-opacity="0.55"/>
  <path d="M118 348c58 0 92-38 112-100" fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="8" stroke-linecap="round"/>
</svg>`;

const SIZES = [16, 24, 32, 48, 64, 72, 96, 128, 144, 192, 256, 512, 1024];

/** Launch screen: brand background with the mark centred, no wordmark. */
const SPLASH = (width, height) => {
  const mark = Math.round(Math.min(width, height) * 0.34);
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <!-- Flat brand background keeps the launch screens a few kB each; the mark
       carries the gradient. -->
  <rect width="${width}" height="${height}" fill="#0A0B14"/>
  <svg x="${(width - mark) / 2}" y="${(height - mark) / 2}" width="${mark}" height="${mark}" viewBox="0 0 512 512">
    ${SVG(mark).replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')}
  </svg>
</svg>`;
};

/** Android launch-screen sizes, in the portrait/landscape pairs Capacitor expects. */
const SPLASHES = {
  'drawable': [480, 320],
  'drawable-port-mdpi': [320, 480],
  'drawable-port-hdpi': [480, 800],
  'drawable-port-xhdpi': [720, 1280],
  'drawable-port-xxhdpi': [960, 1600],
  'drawable-port-xxxhdpi': [1280, 1920],
  'drawable-land-mdpi': [480, 320],
  'drawable-land-hdpi': [800, 480],
  'drawable-land-xhdpi': [1280, 720],
  'drawable-land-xxhdpi': [1600, 960],
  'drawable-land-xxxhdpi': [1920, 1280],
};

async function renderSplash(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:#0A0B14">${SPLASH(width, height)}</body></html>`,
    { waitUntil: 'load' },
  );
  return page.screenshot({ clip: { x: 0, y: 0, width, height } });
}

async function renderPng(page, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">${SVG(size)}</body></html>`,
    { waitUntil: 'load' },
  );
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

/** Build a multi-resolution .ico containing PNG-compressed entries (Vista+). */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = 6 + directory.length;
  entries.forEach((entry, index) => {
    const size = entry.size >= 256 ? 0 : entry.size; // 0 means 256 in the ICO spec
    const base = index * 16;
    directory.writeUInt8(size, base + 0);
    directory.writeUInt8(size, base + 1);
    directory.writeUInt8(0, base + 2); // palette
    directory.writeUInt8(0, base + 3); // reserved
    directory.writeUInt16LE(1, base + 4); // colour planes
    directory.writeUInt16LE(32, base + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

await mkdir(iconDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

const rendered = new Map();
for (const size of SIZES) rendered.set(size, await renderPng(page, size));
await browser.close();

for (const size of SIZES) {
  await writeFile(path.join(iconDir, `${size}x${size}.png`), rendered.get(size));
}
await writeFile(path.join(buildDir, 'icon.png'), rendered.get(1024));
await writeFile(
  path.join(buildDir, 'icon.ico'),
  buildIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: rendered.get(size) }))),
);

// Android adaptive icon foreground (Capacitor/Android res folders are generated
// from these by scripts/make-android-icons.mjs).
await mkdir(path.join(buildDir, 'android'), { recursive: true });
for (const size of [48, 72, 96, 144, 192, 512]) {
  await writeFile(path.join(buildDir, 'android', `icon-${size}.png`), rendered.get(size));
}

// Android launch screens (Capacitor ships a placeholder logo splash by default).
const splashBrowser = await chromium.launch();
const splashPage = await splashBrowser.newPage({ deviceScaleFactor: 1 });
await mkdir(path.join(buildDir, 'android'), { recursive: true });
for (const [folder, [width, height]] of Object.entries(SPLASHES)) {
  const png = await renderSplash(splashPage, width, height);
  await writeFile(path.join(buildDir, 'android', `splash-${folder}.png`), png);
}
await splashBrowser.close();

console.log('fluxa icons written to build/ (png + ico + android icons and launch screens)');
