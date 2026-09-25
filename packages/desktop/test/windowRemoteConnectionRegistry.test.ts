import assert from "node:assert/strict";
import test from "node:test";

import type { RemoteTarget } from "@zcode/shared";

import { createWindowRemoteConnectionRegistry } from "../src/host/windowRemoteConnectionRegistry.js";

const sshTarget: RemoteTarget = {
  kind: "ssh",
  host: "test-host",
  port: 22,
  username: "tester",
};

const flush = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface CloseEvent {
  exitCode: number | null;
  signal: string | null;
}

function createRegistryHarness() {
  let closeListener: ((event: CloseEvent) => void) | null = null;
  let disposeCallCount = 0;
  const closedEvents: { remoteSessionId: string; exitCode: number | null }[] = [];
  const registry = createWindowRemoteConnectionRegistry<Record<string, never>>({
    connect: async () => ({
      services: {},
      dispose() {
        disposeCallCount += 1;
      },
      onDidClose(listener) {
        closeListener = listener;
        return {
          dispose() {
            closeListener = null;
          },
        };
      },
    }),
    createId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    onSessionClosed: (event) => {
      closedEvents.push({ remoteSessionId: event.remoteSessionId, exitCode: event.exitCode });
    },
  });
  return {
    registry,
    fireClose: (event: CloseEvent) => closeListener?.(event),
    getDisposeCallCount: () => disposeCallCount,
    closedEvents,
  };
}

test("connection close disposes the dead handle and settles the session", async () => {
  const harness = createRegistryHarness();
  const descriptor = await harness.registry.connect({
    requestId: "req-1",
    target: sshTarget,
    remoteAssets: {},
  });
  assert.equal(harness.getDisposeCallCount(), 0);

  harness.fireClose({ exitCode: 1, signal: null });
  await flush();

  assert.equal(harness.getDisposeCallCount(), 1, "dead handle must be disposed on close");
  assert.deepEqual(harness.closedEvents, [
    { remoteSessionId: descriptor.remoteSessionId, exitCode: 1 },
  ]);
  const session = harness.registry.getSession(descriptor.remoteSessionId);
  assert.equal(session?.state, "disconnected");
  assert.equal(session?.sourceAvailability, "offline");
  assert.equal(harness.registry.getStats().connectionCount, 0);
  await harness.registry.dispose();
});

test("close is idempotent and reaches every session sharing the entry", async () => {
  const harness = createRegistryHarness();
  const first = await harness.registry.connect({
    requestId: "req-1",
    target: sshTarget,
    remoteAssets: {},
  });
  const second = await harness.registry.connect({
    requestId: "req-2",
    target: sshTarget,
    remoteAssets: {},
  });

  harness.fireClose({ exitCode: 1, signal: null });
  harness.fireClose({ exitCode: 1, signal: null });
  await flush();

  assert.equal(harness.getDisposeCallCount(), 1, "dispose must run exactly once");
  assert.equal(harness.closedEvents.length, 2);
  assert.equal(harness.registry.getSession(first.remoteSessionId)?.state, "disconnected");
  assert.equal(harness.registry.getSession(second.remoteSessionId)?.state, "disconnected");
  await harness.registry.dispose();
});

test("explicit registry dispose keeps working after a close", async () => {
  const harness = createRegistryHarness();
  await harness.registry.connect({
    requestId: "req-1",
    target: sshTarget,
    remoteAssets: {},
  });
  harness.fireClose({ exitCode: 0, signal: null });
  await flush();
  await harness.registry.dispose();
  assert.equal(harness.getDisposeCallCount(), 1, "second dispose must be a no-op");
  assert.equal(harness.registry.getStats().logicalSessionCount, 0);
});
