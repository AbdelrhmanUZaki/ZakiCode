import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentVmPortArgs, buildAgentVmSpecArgs } from "../src/main/vmRuntimeLifecycle.js";

test("port args ride the command only when a pin was picked", () => {
  assert.deepEqual(buildAgentVmPortArgs(), []);
  assert.deepEqual(buildAgentVmPortArgs(undefined), []);
  assert.deepEqual(buildAgentVmPortArgs(46343), ["--ssh-port", "46343"]);
});

test("spec args stay caller-provided fields only (agent-vm global flags before the command)", () => {
  assert.deepEqual(buildAgentVmSpecArgs(), []);
  assert.deepEqual(buildAgentVmSpecArgs({ memoryGb: 5, cpus: 2, diskGb: 20 }), [
    "--memory",
    "5",
    "--cpus",
    "2",
    "--disk",
    "20",
  ]);
  assert.deepEqual(buildAgentVmSpecArgs({ cpus: 4 }), ["--cpus", "4"]);
});
