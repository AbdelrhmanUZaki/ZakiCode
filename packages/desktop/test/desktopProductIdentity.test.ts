import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopProductIdentities,
  isForkIdentityRequested,
  resolveDesktopProductFlavor,
  resolveDesktopProductIdentity,
} from "../scripts/desktop-product-identity.mjs";
import { resolveLinuxDesktopEntryIdentity } from "../src/main/desktopLinuxDeepLinkRegistration.js";

test("production backend without switches keeps the production flavor", () => {
  assert.equal(resolveDesktopProductFlavor({ ZCODE_ENV: "production" }), "production");
});

test("ZCODE_PREVIEW_IDENTITY=1 on production keeps selecting preview", () => {
  assert.equal(
    resolveDesktopProductFlavor({ ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: "1" }),
    "preview",
  );
});

test("ZCODE_FORK_IDENTITY=1 on production selects zakicode", () => {
  assert.equal(
    resolveDesktopProductFlavor({ ZCODE_ENV: "production", ZCODE_FORK_IDENTITY: "1" }),
    "zakicode",
  );
});

test("the fork switch wins when both identity switches are set", () => {
  assert.equal(
    resolveDesktopProductFlavor({
      ZCODE_ENV: "production",
      ZCODE_PREVIEW_IDENTITY: "1",
      ZCODE_FORK_IDENTITY: "1",
    }),
    "zakicode",
  );
});

test("a test backend is always preview, even with the fork switch", () => {
  assert.equal(resolveDesktopProductFlavor({ ZCODE_FORK_IDENTITY: "1" }), "preview");
  assert.equal(
    resolveDesktopProductFlavor({ ZCODE_ENV: "test", ZCODE_FORK_IDENTITY: "1" }),
    "preview",
  );
});

test("ZCODE_FORK_IDENTITY accepts only strict 1/0/empty spellings", () => {
  assert.equal(isForkIdentityRequested({ ZCODE_FORK_IDENTITY: "0" }), false);
  assert.equal(isForkIdentityRequested({}), false);
  assert.throws(() => isForkIdentityRequested({ ZCODE_FORK_IDENTITY: "true" }), /expected 1 or 0/);
});

test("the zakicode identity carries side-by-side naming", () => {
  const identity = resolveDesktopProductIdentity({
    ZCODE_ENV: "production",
    ZCODE_FORK_IDENTITY: "1",
  });
  assert.equal(identity.productName, "ZakiCode");
  assert.equal(identity.appId, "dev.zakicode.app");
  assert.equal(identity.linuxExecutableName, "zakicode");
  assert.equal(identity.linuxPackageName, "zakicode");
  assert.equal(desktopProductIdentities.zakicode, identity);
});

test("linux desktop entry identity is fork-specific for zakicode and unchanged otherwise", () => {
  const fork = resolveLinuxDesktopEntryIdentity("zakicode");
  assert.equal(fork.desktopFileBaseName, "zakicode");
  assert.equal(fork.iconName, "zakicode");
  assert.equal(fork.ownershipMarker, "Comment=ZakiCode Desktop App");

  const upstream = resolveLinuxDesktopEntryIdentity("production");
  assert.equal(upstream.desktopFileBaseName, "zcode");
  assert.equal(upstream.iconName, "zcode");
  assert.equal(upstream.ownershipMarker, "Comment=ZCode Desktop App");

  assert.deepEqual(resolveLinuxDesktopEntryIdentity("preview"), upstream);
  assert.deepEqual(resolveLinuxDesktopEntryIdentity(), upstream);
});
