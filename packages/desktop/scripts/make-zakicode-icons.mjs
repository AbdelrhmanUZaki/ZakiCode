#!/usr/bin/env node
// Generate the ZakiCode fork icon set from the monochrome upstream Z artwork.
//
// The upstream icon is grayscale: high-luminance pixels form the "Z" letter,
// low-luminance pixels form the dark rounded-square background. This script
// tints the letter with the fork accent color (amber) while preserving shape
// and antialiasing via the per-pixel luminance ratio, and writes:
//   build/zakicode-icons/<N>x<N>.png  — full size set for Linux desktop entries
//   build/zakicode-icon.png           — window/tray icon (from build/icon.png)
// Re-run after replacing the upstream artwork in build/icons or build/icon.png.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(scriptDir, "..");
const buildDir = join(desktopRoot, "build");
const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");

// Warm amber — chosen to be instantly distinguishable from upstream's white Z
// at taskbar size (user decision, 2026-10-05).
const LETTER_COLOR = [255, 176, 32];

function tintLetter(png) {
  const { width, height, data } = png;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = data[i]; // grayscale source: r==g==b
      if (data[i + 3] === 0 || v < 120) {
        continue;
      }
      const ratio = v / 255;
      // subtle vertical gradient on the letter: slightly lighter on top
      const lift = 1 + 0.12 * (1 - y / height);
      data[i] = Math.min(255, Math.round(LETTER_COLOR[0] * ratio * lift));
      data[i + 1] = Math.min(255, Math.round(LETTER_COLOR[1] * ratio * lift));
      data[i + 2] = Math.min(255, Math.round(LETTER_COLOR[2] * ratio));
    }
  }
  return png;
}

function transformFile(sourcePath, targetPath) {
  const png = PNG.sync.read(readFileSync(sourcePath));
  writeFileSync(targetPath, PNG.sync.write(tintLetter(png)));
}

const sizesDir = join(buildDir, "zakicode-icons");
mkdirSync(sizesDir, { recursive: true });
for (const file of readdirSync(join(buildDir, "icons"))) {
  if (file.endsWith(".png")) {
    transformFile(join(buildDir, "icons", file), join(sizesDir, file));
  }
}
transformFile(join(buildDir, "icon.png"), join(buildDir, "zakicode-icon.png"));
console.log(`[zakicode-icons] wrote ${readdirSync(sizesDir).length} sizes + zakicode-icon.png`);
