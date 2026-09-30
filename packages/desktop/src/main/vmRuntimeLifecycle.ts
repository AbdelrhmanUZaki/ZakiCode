/**
 * agent-vm VM lifecycle execution (used by vmRuntimeProvider).
 *
 * Identity derivation (alias/VM name), agent-vm command wrappers, spec flags, port read-back and
 * endpoint finalization, plus the full ensureUp / reconfigure sequences. A sequence only consumes
 * resolved identity and parameters; instance facts (existence/state/specs) are queried from limactl by the caller.
 */
import { homedir, userInfo } from "node:os";
import path from "node:path";
import type {
  VmEnsureUpResult,
  VmResourceSpec,
  VmRuntimeEndpoint,
  VmRuntimeState,
  VmTemplateToolsChoice,
} from "@zcode/shared";
import { resolveVmTemplatePreinstall } from "@zcode/shared";
import { describeCommandFailure, runVmCommand } from "./vmRuntimeProcess.js";
import { pickPinnedPort, readPinnedPort, waitForSshEndpoint } from "./vmRuntimePort.js";
import { refreshSshConfigAlias } from "./vmRuntimeSshConfig.js";

/** A first clone / --reset re-clone of the base template can take minutes; generous caps avoid killing it early. */
export const VM_CREATE_TIMEOUT_MS = 15 * 60_000;
export const VM_START_TIMEOUT_MS = 3 * 60_000;
export const VM_STOP_TIMEOUT_MS = 3 * 60_000;
export const VM_FAST_TIMEOUT_MS = 30_000;
/** The base image build downloads the distro image, runs cloud-init, then installs the default tool set and agent CLIs;
 * measured ~29 min for the full set on a real build (the README's ~10 min is optimistic), so the cap is 45 min. */
export const VM_TEMPLATE_TIMEOUT_MS = 45 * 60_000;
const PORT_READ_BACK_RETRIES = 5;
const PORT_READ_BACK_RETRY_DELAY_MS = 1_000;
const SSH_ENDPOINT_WAIT_TIMEOUT_MS = 90_000;

const LIMA_DIR = path.join(homedir(), ".lima");
const LIMA_USER_KEY = path.join(LIMA_DIR, "_config", "user");

export type VmRuntimeLogLine = (message: string, level?: "info" | "warn" | "error") => void;

export function mapLimaStatusToVmState(limaStatus: string | undefined): VmRuntimeState {
  if (!limaStatus) {
    return "none";
  }
  if (limaStatus.startsWith("Running")) {
    return "running";
  }
  if (limaStatus === "Starting" || limaStatus === "Creating") {
    return "starting";
  }
  return "stopped";
}

/** Same as vmup: vm-<basename collapsed to [a-zA-Z0-9-]>; an empty result means the alias cannot be derived. */
export function deriveVmAlias(workspacePath: string): string {
  const base = path.basename(workspacePath).replace(/[^a-zA-Z0-9-]+/g, "-");
  const trimmed = base.replace(/^-+|-+$/g, "");
  if (trimmed.length === 0) {
    throw new Error(`cannot derive a VM alias from ${workspacePath}`);
  }
  return `vm-${trimmed}`;
}

function resolveVmUsername(): string {
  return process.env.USER?.trim() || userInfo().username;
}

/** The VM name follows agent-vm's own naming (terminal-side stop/rm/list depend on it; never recompute it). */
export async function resolveVmName(workspacePath: string): Promise<string> {
  const result = await runVmCommand("agent-vm", ["name", workspacePath], {
    timeoutMs: VM_FAST_TIMEOUT_MS,
  });
  const name = result.stdout.trim();
  if (result.code !== 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(describeCommandFailure("agent-vm name", result));
  }
  return name;
}

/** Whether the base image exists (the machine-readable base_exists field from agent-vm info).
 * A failed probe is treated as ready so the create branch surfaces its raw error instead of a
 * false "missing template" report. */
export async function readBaseTemplateExists(workspacePath: string): Promise<boolean> {
  const result = await runAgentVm(["info", workspacePath], {
    cwd: workspacePath,
    timeoutMs: VM_FAST_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    return true;
  }
  return /^base_exists=1$/m.test(result.stdout);
}

/** First-machine bootstrap: when the base image is missing run `agent-vm setup` first (stdin is not a TTY,
 * so agent-vm skips its wizard and installs per --preinstall; unspecified means agent-vm's default set),
 * streaming output into the same log panel. On an existing template this is a cheap no-op re-check. */
export async function ensureBaseTemplate(
  workspacePath: string,
  onLog: VmRuntimeLogLine,
  templateTools?: VmTemplateToolsChoice,
): Promise<void> {
  if (await readBaseTemplateExists(workspacePath)) {
    return;
  }
  const preinstall = resolveVmTemplatePreinstall(templateTools);
  const toolSummary = preinstall
    ? `preinstall: ${preinstall}`
    : "agent-vm full default set (includes the AI-agent CLIs)";
  onLog(`==> Building base image (one-time, can take 10-30 min; ${toolSummary})`);
  const args = preinstall ? ["setup", `--preinstall=${preinstall}`] : ["setup"];
  const result = await runAgentVm(args, {
    cwd: workspacePath,
    timeoutMs: VM_TEMPLATE_TIMEOUT_MS,
    onLog,
  });
  if (result.code !== 0) {
    throw new Error(describeCommandFailure("agent-vm setup (base image)", result));
  }
  onLog("==> Base image ready");
}

/** agent-vm's VM options are global flags before the command; only caller-provided fields are added, absent means default. */
export function buildAgentVmSpecArgs(spec?: VmResourceSpec): string[] {
  const args: string[] = [];
  if (spec?.memoryGb !== undefined) {
    args.push("--memory", String(spec.memoryGb));
  }
  if (spec?.cpus !== undefined) {
    args.push("--cpus", String(spec.cpus));
  }
  if (spec?.diskGb !== undefined) {
    args.push("--disk", String(spec.diskGb));
  }
  return args;
}

export function describeVmSpec(spec: VmResourceSpec): string {
  return `${spec.memoryGb ?? 3} GB / ${spec.cpus ?? 1} CPU / ${spec.diskGb ?? 10} GB disk`;
}

/** The pinned SSH port rides the agent-vm command itself (a global flag before the command); agent-vm writes
 * `.ssh.localPort` — at clone time on create/`--reset`, or on a stopped instance right before it starts. */
export function buildAgentVmPortArgs(pinnedPort?: number): string[] {
  return pinnedPort === undefined ? [] : ["--ssh-port", String(pinnedPort)];
}

export async function runAgentVm(
  args: string[],
  options: { cwd: string; timeoutMs: number; onLog?: VmRuntimeLogLine },
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return runVmCommand("agent-vm", args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    onLine: options.onLog ? (line) => options.onLog?.(line) : undefined,
  });
}

export async function startVm(
  workspacePath: string,
  phase: "create" | "start",
  onLog: VmRuntimeLogLine,
  spec?: VmResourceSpec,
  pinnedPort?: number,
): Promise<void> {
  const result = await runAgentVm(
    [...buildAgentVmSpecArgs(spec), ...buildAgentVmPortArgs(pinnedPort), "shell", "-c", "true"],
    {
      cwd: workspacePath,
      timeoutMs: phase === "create" ? VM_CREATE_TIMEOUT_MS : VM_START_TIMEOUT_MS,
      onLog,
    },
  );
  if (result.code !== 0) {
    throw new Error(describeCommandFailure(`agent-vm shell (${phase})`, result));
  }
}

export async function stopVm(workspacePath: string, onLog?: VmRuntimeLogLine): Promise<void> {
  const result = await runAgentVm(["stop"], {
    cwd: workspacePath,
    timeoutMs: VM_STOP_TIMEOUT_MS,
    onLog,
  });
  if (result.code !== 0) {
    throw new Error(describeCommandFailure("agent-vm stop", result));
  }
}

async function readBackPinnedPort(vmName: string, onLog?: VmRuntimeLogLine): Promise<number> {
  for (let attempt = 0; attempt < PORT_READ_BACK_RETRIES; attempt += 1) {
    const port = await readPinnedPort(vmName);
    if (port !== null) {
      return port;
    }
    if (attempt < PORT_READ_BACK_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, PORT_READ_BACK_RETRY_DELAY_MS));
    }
  }
  const detail = `could not read back the pinned SSH port from ${vmName}/lima.yaml`;
  onLog?.(detail, "error");
  throw new Error(detail);
}

/** Read back the port → wait for the SSH banner → build the endpoint → refresh the alias; shared finalization for ensureUp/reconfigure. */
async function finalizeEndpoint(
  vmName: string,
  alias: string,
  onLog: VmRuntimeLogLine,
): Promise<VmRuntimeEndpoint> {
  const port = await readBackPinnedPort(vmName, onLog);
  // start returning does not mean sshd is ready: early guest port-forwarding can precede sshd listening,
  // and an immediate connectRemote gets ECONNREFUSED/disconnect (reproduced on a real VM).
  if (
    !(await waitForSshEndpoint("127.0.0.1", port, {
      timeoutMs: SSH_ENDPOINT_WAIT_TIMEOUT_MS,
    }))
  ) {
    const detail = `SSH endpoint 127.0.0.1:${port} did not become ready in time`;
    onLog(detail, "error");
    throw new Error(detail);
  }
  const endpoint: VmRuntimeEndpoint = {
    vm: vmName,
    alias,
    host: "127.0.0.1",
    port,
    username: resolveVmUsername(),
    privateKeyPath: LIMA_USER_KEY,
  };
  await refreshSshConfigAlias(alias, endpoint);
  return endpoint;
}

export interface VmInstanceFacts {
  exists: boolean;
  running: boolean;
  pinnedPort: number | null;
}

/** Three branches, same as vmup: missing (create+pin+start in one command) / stopped (start, pinning via --ssh-port when unpinned) /
 * running without pin (stop first — a running VM never takes a differing --ssh-port — then start with the pin). */
export async function ensureUpSequence(
  workspacePath: string,
  identity: { vmName: string; alias: string; hashSegment: string },
  facts: VmInstanceFacts,
  onLog: VmRuntimeLogLine,
  spec?: VmResourceSpec,
  instanceSpec?: VmResourceSpec,
  templateTools?: VmTemplateToolsChoice,
): Promise<VmEnsureUpResult> {
  const { vmName, alias, hashSegment } = identity;
  if (!facts.exists) {
    // Pre-create bootstrap: build the base image first when missing (one-time), otherwise create fails with a
    // raw agent-vm error — the last remaining reason to open a terminal.
    await ensureBaseTemplate(workspacePath, onLog, templateTools);
    const port = await pickPinnedPort(hashSegment, vmName);
    onLog(
      `==> Creating VM '${vmName}' with ${describeVmSpec(spec ?? {})} and pinned SSH port ${port} (first run clones the base template; this can take minutes)`,
    );
    await startVm(workspacePath, "create", onLog, spec, port);
  } else if (spec) {
    // Specs are consumed at creation only; resizing an existing instance goes through reconfigure.
    onLog(`==> VM exists; keeping its resources (${describeVmSpec(instanceSpec ?? {})})`);
  }
  if (facts.exists && !facts.running) {
    if (facts.pinnedPort === null) {
      // A stopped instance takes a differing --ssh-port right before it starts, so pin+start is one command.
      const port = await pickPinnedPort(hashSegment, vmName);
      onLog(`==> Starting VM '${vmName}' (pinning SSH port ${port} via --ssh-port)`);
      await startVm(workspacePath, "start", onLog, undefined, port);
    } else {
      onLog(`==> Starting VM '${vmName}'`);
      await startVm(workspacePath, "start", onLog);
    }
  } else if (facts.exists && facts.running && facts.pinnedPort === null) {
    // agent-vm prompts on /dev/tty and aborts to "current settings" when a running VM is asked for a new port,
    // so the one restart this branch already owed is where the pin gets applied.
    onLog("==> VM running without a pinned port; restarting once to pin it");
    await stopVm(workspacePath, onLog);
    const port = await pickPinnedPort(hashSegment, vmName);
    await startVm(workspacePath, "start", onLog, undefined, port);
  }
  return {
    success: true,
    endpoint: await finalizeEndpoint(vmName, alias, onLog),
  };
}

/** Resize = one `--reset` re-clone command with the new spec flags; --ssh-port re-pins the fresh instance at clone time. */
export async function reconfigureSequence(
  workspacePath: string,
  identity: { vmName: string; alias: string; hashSegment: string },
  spec: VmResourceSpec,
  onLog: VmRuntimeLogLine,
): Promise<VmEnsureUpResult> {
  const { vmName, alias, hashSegment } = identity;
  const port = await pickPinnedPort(hashSegment, vmName);
  onLog(
    `==> Re-creating VM '${vmName}' with ${describeVmSpec(spec)} and pinned SSH port ${port} (clones the base template; this can take minutes)`,
  );
  const result = await runAgentVm(
    [
      ...buildAgentVmSpecArgs(spec),
      ...buildAgentVmPortArgs(port),
      "--reset",
      "shell",
      "-c",
      "true",
    ],
    { cwd: workspacePath, timeoutMs: VM_CREATE_TIMEOUT_MS, onLog },
  );
  if (result.code !== 0) {
    throw new Error(describeCommandFailure("agent-vm shell (reconfigure --reset)", result));
  }
  return {
    success: true,
    endpoint: await finalizeEndpoint(vmName, alias, onLog),
  };
}
