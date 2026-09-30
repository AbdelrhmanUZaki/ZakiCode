import assert from "node:assert/strict";
import test from "node:test";
import { parsePinnedPort } from "../src/main/vmRuntimePort.js";

test("parses the last localPort value as the pinned port", () => {
  assert.equal(parsePinnedPort("ssh:\n  localPort: 46343\n"), 46343);
  assert.equal(parsePinnedPort("ssh:\n  localPort: 46100\nother:\n  localPort: 46200\n"), 46200);
  assert.equal(parsePinnedPort("ssh: {}\n"), null);
});

test("localPort 0 is agent-vm's un-pinned state, not a port", () => {
  assert.equal(parsePinnedPort("ssh:\n  localPort: 0\n"), null);
  assert.equal(parsePinnedPort("ssh:\n  localPort: 46343\n  localPort: 0\n"), null);
});
