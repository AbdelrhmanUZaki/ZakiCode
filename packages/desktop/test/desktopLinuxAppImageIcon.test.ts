import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLinuxIconInstallSources } from "../src/main/desktopLinuxAppImageIcon.js";

function createTempResourcesDir(): string {
  return mkdtempSync(join(tmpdir(), "zakicode-icon-test-"));
}

test("installs every packaged size and does not duplicate the 512 fallback", () => {
  const resourcesDir = createTempResourcesDir();
  try {
    writeFileSync(join(resourcesDir, "icon_512x512.png"), "single");
    const sizesDir = join(resourcesDir, "zakicode-icons");
    mkdirSync(sizesDir);
    for (const size of ["16x16", "32x32", "512x512"]) {
      writeFileSync(join(sizesDir, `${size}.png`), `icon-${size}`);
    }
    writeFileSync(join(sizesDir, "README.md"), "not an icon");

    const sources = resolveLinuxIconInstallSources(join(resourcesDir, "icon_512x512.png"));
    assert.deepEqual(sources.map((source) => source.sizeDirName).sort(), [
      "16x16",
      "32x32",
      "512x512",
    ]);
    const source512 = sources.find((source) => source.sizeDirName === "512x512");
    assert.equal(source512?.sourcePath, join(sizesDir, "512x512.png"));
  } finally {
    rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test("falls back to the single packaged 512 resource without a size set", () => {
  const resourcesDir = createTempResourcesDir();
  try {
    const iconSourcePath = join(resourcesDir, "icon_512x512.png");
    writeFileSync(iconSourcePath, "single");

    const sources = resolveLinuxIconInstallSources(iconSourcePath);
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.sizeDirName, "512x512");
    assert.equal(sources[0]?.sourcePath, iconSourcePath);
  } finally {
    rmSync(resourcesDir, { recursive: true, force: true });
  }
});
