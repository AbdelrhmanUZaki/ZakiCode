import assert from "node:assert/strict";
import test from "node:test";
import type { VmHostResources } from "../../shared/src/vmRuntime.js";
import {
  createVmHostResourcesPoller,
  VM_HOST_RESOURCES_POLL_INTERVAL_MS,
} from "../src/hooks/vmHostResourcesPoller.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const fakeResources = (): VmHostResources => ({
  totalMemoryGb: 15.4,
  availableMemoryGb: 3.2,
  logicalCpus: 12,
  diskFreeGb: 31,
  runningVms: [],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("poll interval matches the desktop main TTL cache", () => {
  assert.equal(VM_HOST_RESOURCES_POLL_INTERVAL_MS, 5_000);
});

test("start() fetches immediately and keeps polling each interval", async () => {
  const seen: VmHostResources[] = [];
  const poller = createVmHostResourcesPoller({
    fetchResources: async () => fakeResources(),
    onResources: (resources) => seen.push(resources),
    onError: () => assert.fail("should not error"),
    intervalMs: 20,
  });
  poller.start();
  await sleep(70);
  poller.stop();
  assert.ok(seen.length >= 2, `expected immediate + interval ticks, got ${seen.length}`);
});

test("a slow in-flight fetch blocks new ticks instead of stacking requests", async () => {
  let fetches = 0;
  const gate = deferred<VmHostResources>();
  const poller = createVmHostResourcesPoller({
    fetchResources: () => {
      fetches += 1;
      return gate.promise;
    },
    onResources: () => {},
    onError: () => assert.fail("should not error"),
    intervalMs: 10,
  });
  poller.start();
  await sleep(45);
  // The interval fires ~4 times within 45ms, but while the first round is in flight every tick must be skipped.
  assert.equal(fetches, 1);
  gate.resolve(fakeResources());
  await sleep(30);
  poller.stop();
  assert.ok(fetches >= 2, `expected polling to resume after the slow fetch, got ${fetches}`);
});

test("stop() halts polling and drops the late in-flight result", async () => {
  const seen: VmHostResources[] = [];
  let fetches = 0;
  const gate = deferred<VmHostResources>();
  const poller = createVmHostResourcesPoller({
    fetchResources: () => {
      fetches += 1;
      return gate.promise;
    },
    onResources: (resources) => seen.push(resources),
    onError: () => assert.fail("should not error"),
    intervalMs: 10,
  });
  poller.start();
  await sleep(5);
  poller.stop();
  gate.resolve(fakeResources());
  await sleep(30);
  assert.equal(fetches, 1, "no fetch after stop");
  assert.deepEqual(seen, [], "late in-flight result must be dropped");
});

test("start() after stop() stays inert (the hook creates a fresh poller per activation)", async () => {
  let fetches = 0;
  const poller = createVmHostResourcesPoller({
    fetchResources: async () => {
      fetches += 1;
      return fakeResources();
    },
    onResources: () => {},
    onError: () => assert.fail("should not error"),
    intervalMs: 10,
  });
  poller.start();
  await sleep(5);
  poller.stop();
  poller.start();
  await sleep(30);
  assert.equal(fetches, 1);
});

test("fetch failure reports onError and polling continues", async () => {
  const seen: VmHostResources[] = [];
  const errors: unknown[] = [];
  // Fail exactly once so interval timing cannot make the error count jitter.
  let failuresLeft = 1;
  const poller = createVmHostResourcesPoller({
    fetchResources: async () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("limactl list failed");
      }
      return fakeResources();
    },
    onResources: (resources) => seen.push(resources),
    onError: (error) => errors.push(error),
    intervalMs: 20,
  });
  poller.start();
  await sleep(70);
  poller.stop();
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, "limactl list failed");
  assert.ok(seen.length >= 1, "polling must resume delivering after a failure");
});
