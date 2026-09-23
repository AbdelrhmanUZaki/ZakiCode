/**
 * agent-vm VM 生命周期执行（被 vmRuntimeProvider 使用）。
 *
 * 身份派生（alias/VM 名）、agent-vm 命令封装、规格旗标、端口读回与
 * endpoint 收尾，以及 ensureUp / reconfigure 两条完整序列。序列只消费
 * 已解析的身份与参数；实例事实（存在/状态/规格）由调用方从 limactl 查得。
 */
import { homedir, userInfo } from "node:os";
import path from "node:path";
import type {
  VmEnsureUpResult,
  VmResourceSpec,
  VmRuntimeEndpoint,
  VmRuntimeState,
} from "@zcode/shared";
import { describeCommandFailure, runVmCommand } from "./vmRuntimeProcess.js";
import {
  pinVmPort,
  readPinnedPort,
  waitForSshEndpoint,
} from "./vmRuntimePort.js";
import { refreshSshConfigAlias } from "./vmRuntimeSshConfig.js";

/** 首次 clone / --reset 重克隆 基础模板可能要几分钟；给足上限避免误杀。 */
export const VM_CREATE_TIMEOUT_MS = 15 * 60_000;
export const VM_START_TIMEOUT_MS = 3 * 60_000;
export const VM_STOP_TIMEOUT_MS = 3 * 60_000;
export const VM_FAST_TIMEOUT_MS = 30_000;
const PORT_READ_BACK_RETRIES = 5;
const PORT_READ_BACK_RETRY_DELAY_MS = 1_000;
const SSH_ENDPOINT_WAIT_TIMEOUT_MS = 90_000;

const LIMA_DIR = path.join(homedir(), ".lima");
const LIMA_USER_KEY = path.join(LIMA_DIR, "_config", "user");

export type VmRuntimeLogLine = (
  message: string,
  level?: "info" | "warn" | "error",
) => void;

export function mapLimaStatusToVmState(
  limaStatus: string | undefined,
): VmRuntimeState {
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

/** 与 vmup 一致：vm-<basename 收敛为 [a-zA-Z0-9-]>，空结果视为无法派生。 */
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

/** VM 名以 agent-vm 的命名为准（终端侧 stop/rm/list 依赖同一命名，不能自行重算）。 */
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

/** agent-vm 的 VM 选项是命令前的全局旗标；只拼调用方显式提供的字段，缺省即默认。 */
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
): Promise<void> {
  const result = await runAgentVm(
    [...buildAgentVmSpecArgs(spec), "shell", "-c", "true"],
    {
      cwd: workspacePath,
      timeoutMs:
        phase === "create" ? VM_CREATE_TIMEOUT_MS : VM_START_TIMEOUT_MS,
      onLog,
    },
  );
  if (result.code !== 0) {
    throw new Error(
      describeCommandFailure(`agent-vm shell (${phase})`, result),
    );
  }
}

export async function stopVm(
  workspacePath: string,
  onLog?: VmRuntimeLogLine,
): Promise<void> {
  const result = await runAgentVm(["stop"], {
    cwd: workspacePath,
    timeoutMs: VM_STOP_TIMEOUT_MS,
    onLog,
  });
  if (result.code !== 0) {
    throw new Error(describeCommandFailure("agent-vm stop", result));
  }
}

async function readBackPinnedPort(
  vmName: string,
  onLog?: VmRuntimeLogLine,
): Promise<number> {
  for (let attempt = 0; attempt < PORT_READ_BACK_RETRIES; attempt += 1) {
    const port = await readPinnedPort(vmName);
    if (port !== null) {
      return port;
    }
    if (attempt < PORT_READ_BACK_RETRIES - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, PORT_READ_BACK_RETRY_DELAY_MS),
      );
    }
  }
  const detail = `could not read back the pinned SSH port from ${vmName}/lima.yaml`;
  onLog?.(detail, "error");
  throw new Error(detail);
}

/** 读回端口 → 等 SSH banner → 组 endpoint → 刷新 alias；ensureUp/reconfigure 共用收尾。 */
async function finalizeEndpoint(
  vmName: string,
  alias: string,
  onLog: VmRuntimeLogLine,
): Promise<VmRuntimeEndpoint> {
  const port = await readBackPinnedPort(vmName, onLog);
  // start 返回 ≠ sshd 就绪：guest 早期端口转发可能先于 sshd 监听，
  // 立刻 connectRemote 会得到 ECONNREFUSED/断开（automation VM 实测复现）。
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

/** 三个分支与 vmup 一致：不存在（创建→pin→start）/ 已停止（补 pin→start）/ 运行但未 pin（stop→pin→start）。 */
export async function ensureUpSequence(
  workspacePath: string,
  identity: { vmName: string; alias: string; hashSegment: string },
  facts: VmInstanceFacts,
  onLog: VmRuntimeLogLine,
  spec?: VmResourceSpec,
  instanceSpec?: VmResourceSpec,
): Promise<VmEnsureUpResult> {
  const { vmName, alias, hashSegment } = identity;
  if (!facts.exists) {
    onLog(
      `==> Creating VM '${vmName}' with ${describeVmSpec(spec ?? {})} (first run clones the base template; this can take minutes)`,
    );
    await startVm(workspacePath, "create", onLog, spec);
    onLog("==> Pinning SSH port");
    await stopVm(workspacePath, onLog);
    await pinVmPort(vmName, hashSegment);
    await startVm(workspacePath, "start", onLog);
  } else if (spec) {
    // 规格只在创建时消费；既有实例的调整走 reconfigure。
    onLog(
      `==> VM exists; keeping its resources (${describeVmSpec(instanceSpec ?? {})})`,
    );
  }
  if (facts.exists && !facts.running) {
    if (facts.pinnedPort === null) {
      onLog("==> Pinning SSH port");
      await pinVmPort(vmName, hashSegment);
    }
    onLog(`==> Starting VM '${vmName}'`);
    await startVm(workspacePath, "start", onLog);
  } else if (facts.exists && facts.running && facts.pinnedPort === null) {
    onLog("==> VM running without a pinned port; restarting once to pin it");
    await stopVm(workspacePath, onLog);
    await pinVmPort(vmName, hashSegment);
    await startVm(workspacePath, "start", onLog);
  }
  return {
    success: true,
    endpoint: await finalizeEndpoint(vmName, alias, onLog),
  };
}

/** 调整规格 = --reset 重克隆（新规格旗标）→ stop → 重新 pin（新实例丢 pin）→ start。 */
export async function reconfigureSequence(
  workspacePath: string,
  identity: { vmName: string; alias: string; hashSegment: string },
  spec: VmResourceSpec,
  onLog: VmRuntimeLogLine,
): Promise<VmEnsureUpResult> {
  const { vmName, alias, hashSegment } = identity;
  onLog(
    `==> Re-creating VM '${vmName}' with ${describeVmSpec(spec)} (clones the base template; this can take minutes)`,
  );
  const result = await runAgentVm(
    [...buildAgentVmSpecArgs(spec), "--reset", "shell", "-c", "true"],
    { cwd: workspacePath, timeoutMs: VM_CREATE_TIMEOUT_MS, onLog },
  );
  if (result.code !== 0) {
    throw new Error(
      describeCommandFailure("agent-vm shell (reconfigure --reset)", result),
    );
  }
  onLog("==> Pinning SSH port");
  await stopVm(workspacePath, onLog);
  await pinVmPort(vmName, hashSegment);
  await startVm(workspacePath, "start", onLog);
  return {
    success: true,
    endpoint: await finalizeEndpoint(vmName, alias, onLog),
  };
}
