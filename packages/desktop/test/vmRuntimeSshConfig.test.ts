import assert from "node:assert/strict";
import test from "node:test";
import { buildSshAliasBlock } from "../src/main/vmRuntimeSshConfig.js";

const endpoint = {
  host: "127.0.0.1",
  port: 46343,
  username: "zaki",
  privateKeyPath: "/home/zaki/.lima/_config/user",
};

test("alias block carries the vmup-compatible markers and endpoint fields", () => {
  const block = buildSshAliasBlock("vm-ZCode", endpoint);
  assert.match(block, /^# BEGIN agent-vm alias: vm-ZCode$/m);
  assert.match(block, /^# END agent-vm alias: vm-ZCode$/m);
  assert.match(block, /^Host vm-ZCode$/m);
  assert.match(block, /^  HostName 127\.0\.0\.1$/m);
  assert.match(block, /^  Port 46343$/m);
  assert.match(block, /^  User zaki$/m);
  assert.match(block, /^  IdentityFile \/home\/zaki\/\.lima\/_config\/user$/m);
});

test("alias block pins ForwardAgent no (first-obtained-value beats a ForwardAgent yes under Host *)", () => {
  const block = buildSshAliasBlock("vm-ZCode", endpoint);
  assert.match(block, /^  ForwardAgent no$/m);
  assert.doesNotMatch(block, /ForwardAgent yes/);
});
