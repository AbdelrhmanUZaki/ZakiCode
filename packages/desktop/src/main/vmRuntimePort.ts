/**
 * agent-vm pinned SSH port probing and pinning (used by vmRuntimeProvider).
 *
 * The algorithm is byte-compatible with the vmup script: start at 46000 + (hash8 % 1000), nudge +1 while the port is
 +1 wraps within the span. The pin lives in the Lima instance config `.ssh.localPort` and stays deterministic across reboots/re-creates.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { describeCommandFailure, runVmCommand } from "./vmRuntimeProcess.js";

const PORT_BASE = 46000;
const PORT_SPAN = 1000;
const LIMA_DIR = path.join(homedir(), ".lima");

function limaInstanceConfigPath(vmName: string): string {
  return path.join(LIMA_DIR, vmName, "lima.yaml");
}

/** The read-back pinned port is the single source of truth; a persisted old port is display-only. */
function parsePinnedPort(limaYaml: string): number | null {
  const matches = limaYaml.matchAll(/^[ \t]*localPort:[ \t]*([0-9]{1,5})[ \t]*$/gm);
  let port: number | null = null;
  for (const match of matches) {
    const parsed = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(parsed)) {
      port = parsed;
    }
  }
  return port;
}

export async function readPinnedPort(vmName: string): Promise<number | null> {
  try {
    const content = await fs.readFile(limaInstanceConfigPath(vmName), "utf8");
    return parsePinnedPort(content);
  } catch {
    return null;
  }
}

/** A TCP connect probe, equivalent to vmup's `ss -ltnH sport = :<p>` without depending on Linux-only tools. */
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect({ host: "127.0.0.1", port, timeout: 500 });
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
    probe.once("timeout", () => {
      probe.destroy();
      resolve(false);
    });
  });
}

async function isPortPinnedByOtherVm(port: number, ownVmName: string): Promise<boolean> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(LIMA_DIR);
  } catch {
    return false;
  }
  const portPattern = new RegExp(`^[ \t]*localPort:[ \t]*${port}[ \t]*$`, "m");
  const checks = await Promise.all(
    entries
      .filter((entry) => entry !== ownVmName)
      .map(async (entry) => {
        const configPath = path.join(LIMA_DIR, entry, "lima.yaml");
        if (!existsSync(configPath)) {
          return false;
        }
        try {
          const content = await fs.readFile(configPath, "utf8");
          return portPattern.test(content);
        } catch {
          return false;
        }
      }),
  );
  return checks.some(Boolean);
}

/** Same deterministic start as vmup plus +1 on collision (wrapping within the 1000-port span). */
async function pickPinnedPort(hashSegment: string, ownVmName: string): Promise<number> {
  const hash = Number.parseInt(hashSegment, 16);
  let port = PORT_BASE + ((Number.isFinite(hash) ? hash : 0) % PORT_SPAN);
  for (let attempt = 0; attempt < PORT_SPAN; attempt += 1) {
    const [listening, pinnedElsewhere] = await Promise.all([
      isPortListening(port),
      isPortPinnedByOtherVm(port, ownVmName),
    ]);
    if (!listening && !pinnedElsewhere) {
      return port;
    }
    port = ((port - PORT_BASE + 1) % PORT_SPAN) + PORT_BASE;
  }
  throw new Error("no free port in the agent-vm pinned port range");
}

/** Pinning requires the VM to be stopped; the caller pins inside the stop window. */
export async function pinVmPort(vmName: string, hashSegment: string): Promise<number> {
  const port = await pickPinnedPort(hashSegment, vmName);
  const result = await runVmCommand(
    "limactl",
    ["edit", vmName, "--set", `.ssh.localPort = ${port}`],
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0) {
    throw new Error(describeCommandFailure("limactl edit (pin ssh port)", result));
  }
  return port;
}

function readSshBannerOnce(host: string, port: number, bannerTimeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (!settled) {
        settled = true;
        probe.destroy();
        resolve(value);
      }
    };
    const probe = net.connect({ host, port, timeout: bannerTimeoutMs }, () => {
      // A TCP accept does not mean sshd can serve: early guest port-forwarding can come up first.
      // Waiting for the SSH banner guarantees the following connectRemote is not immediately dropped.
      probe.once("data", (chunk: Buffer) => finish(chunk.toString("utf8").startsWith("SSH-")));
      probe.once("error", () => finish(false));
      probe.once("close", () => finish(false));
    });
    probe.once("error", () => finish(false));
    probe.once("timeout", () => finish(false));
  });
}

/** Wait until the VM's SSH endpoint actually serves (banner level) so connectRemote is not rejected right after start returns. */
export async function waitForSshEndpoint(
  host: string,
  port: number,
  options: { timeoutMs: number },
): Promise<boolean> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (await readSshBannerOnce(host, port, 5_000)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}
