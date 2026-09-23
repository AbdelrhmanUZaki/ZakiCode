/**
 * agent-vm 沙箱 VM runtime provider —— vmup 脚本逻辑的 TypeScript 移植。
 *
 * 原因与依据：vmup（~/vmup/vmup）为 120 行 bash，
 * 只做四件事：按路径派生 VM/alias、pin SSH 端口、调用 agent-vm/limactl 生命周期、
 * 维护 ~/.ssh/config 受管 alias 块。这里按 docs/plan-open-in-vm.md §2.1 原样移植，
 * 端口算法与 ssh config 标记必须与脚本字节兼容（双写者可互换，见计划 R6）。
 *
 * 状态所有者：本模块（desktop main）。renderer 只通过 IPC 读取结果。
 * 进程执行底座在 vmRuntimeProcess.ts；端口探测/pin 在 vmRuntimePort.ts；
 * ssh config 写入在 vmRuntimeSshConfig.ts。
 */
import { homedir, userInfo } from "node:os";
import path from "node:path";
import type {
  VmEnsureUpResult,
  VmRuntimeEndpoint,
  VmRuntimeState,
  VmRuntimeStatus,
  VmRuntimeUnavailabilityReason,
  VmStopResult,
} from "@zcode/shared";
import { logger } from "./logger.js";
import { describeCommandFailure, runVmCommand } from "./vmRuntimeProcess.js";
import {
  pinVmPort,
  readPinnedPort,
  waitForSshEndpoint,
} from "./vmRuntimePort.js";
import { refreshSshConfigAlias } from "./vmRuntimeSshConfig.js";

/** 首次 clone 基础模板可能要几分钟；给足上限避免误杀。 */
const VM_CREATE_TIMEOUT_MS = 15 * 60_000;
const VM_START_TIMEOUT_MS = 3 * 60_000;
const VM_STOP_TIMEOUT_MS = 3 * 60_000;
const VM_FAST_TIMEOUT_MS = 30_000;
const PORT_READ_BACK_RETRIES = 5;
const PORT_READ_BACK_RETRY_DELAY_MS = 1_000;
const AVAILABILITY_CACHE_TTL_MS = 30_000;

const LIMA_DIR = path.join(homedir(), ".lima");
const LIMA_USER_KEY = path.join(LIMA_DIR, "_config", "user");

export type VmRuntimeLogLine = (
  message: string,
  level?: "info" | "warn" | "error",
) => void;

interface Availability {
  agentVm: boolean;
  limactl: boolean;
}

let availabilityCache: { value: Availability; checkedAt: number } | null = null;

async function checkVmTooling(): Promise<Availability> {
  if (
    availabilityCache &&
    Date.now() - availabilityCache.checkedAt < AVAILABILITY_CACHE_TTL_MS
  ) {
    return availabilityCache.value;
  }
  const [agentVm, limactl] = await Promise.all([
    runVmCommand("agent-vm", ["version"], { timeoutMs: 10_000 }),
    runVmCommand("limactl", ["--version"], { timeoutMs: 10_000 }),
  ]);
  const value = { agentVm: agentVm.code === 0, limactl: limactl.code === 0 };
  availabilityCache = { value, checkedAt: Date.now() };
  return value;
}

function resolveUnavailability(
  availability: Availability,
): VmRuntimeUnavailabilityReason | undefined {
  if (!availability.agentVm) {
    return "missing-agent-vm";
  }
  return availability.limactl ? undefined : "missing-limactl";
}

/** 与 vmup 一致：vm-<basename 收敛为 [a-zA-Z0-9-]>，空结果视为无法派生。 */
function deriveVmAlias(workspacePath: string): string {
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
async function resolveVmName(workspacePath: string): Promise<string> {
  const result = await runVmCommand("agent-vm", ["name", workspacePath], {
    timeoutMs: VM_FAST_TIMEOUT_MS,
  });
  const name = result.stdout.trim();
  if (result.code !== 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(describeCommandFailure("agent-vm name", result));
  }
  return name;
}

function limactlListStatuses(): Promise<Map<string, string>> {
  return runVmCommand(
    "limactl",
    ["list", "--format", "{{.Name}} {{.Status}}"],
    { timeoutMs: VM_FAST_TIMEOUT_MS },
  ).then((result) => {
    const instances = new Map<string, string>();
    if (result.code !== 0) {
      return instances;
    }
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const separator = trimmed.lastIndexOf(" ");
      if (separator > 0) {
        instances.set(
          trimmed.slice(0, separator),
          trimmed.slice(separator + 1),
        );
      }
    }
    return instances;
  });
}

function mapLimaStatusToVmState(
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

/** 读回 pin 的端口是唯一事实来源；持久化的旧端口只能当展示值（见 vmRuntimePort.ts）。 */

async function runAgentVm(
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

async function ensureUpSequence(
  workspacePath: string,
  onLog: VmRuntimeLogLine,
): Promise<VmEnsureUpResult> {
  const availability = await checkVmTooling();
  const unavailability = resolveUnavailability(availability);
  if (unavailability) {
    return {
      success: false,
      error: `VM tooling unavailable (${unavailability}); install agent-vm and Lima first`,
    };
  }

  const alias = deriveVmAlias(workspacePath);
  const vmName = await resolveVmName(workspacePath);
  const hashSegment = vmName.split("-").pop() ?? "";

  const startVm = async (phase: "create" | "start") => {
    const result = await runAgentVm(["shell", "-c", "true"], {
      cwd: workspacePath,
      timeoutMs:
        phase === "create" ? VM_CREATE_TIMEOUT_MS : VM_START_TIMEOUT_MS,
      onLog,
    });
    if (result.code !== 0) {
      throw new Error(
        describeCommandFailure(`agent-vm shell (${phase})`, result),
      );
    }
  };
  const stopVm = async () => {
    const result = await runAgentVm(["stop"], {
      cwd: workspacePath,
      timeoutMs: VM_STOP_TIMEOUT_MS,
      onLog,
    });
    if (result.code !== 0) {
      throw new Error(describeCommandFailure("agent-vm stop", result));
    }
  };

  const instances = await limactlListStatuses();
  const exists = instances.has(vmName);
  const running = mapLimaStatusToVmState(instances.get(vmName)) === "running";
  const pinnedPort = await readPinnedPort(vmName);

  // 三个分支与 vmup 一致：不存在（创建→pin→start）/ 已停止（补 pin→start）/ 运行但未 pin（stop→pin→start）。
  if (!exists) {
    onLog(
      `==> Creating VM '${vmName}' (first run clones the base template; this can take minutes)`,
    );
    await startVm("create");
    onLog("==> Pinning SSH port");
    await stopVm();
    await pinVmPort(vmName, hashSegment);
    await startVm("start");
  } else if (!running) {
    if (pinnedPort === null) {
      onLog("==> Pinning SSH port");
      await pinVmPort(vmName, hashSegment);
    }
    onLog(`==> Starting VM '${vmName}'`);
    await startVm("start");
  } else if (pinnedPort === null) {
    onLog("==> VM running without a pinned port; restarting once to pin it");
    await stopVm();
    await pinVmPort(vmName, hashSegment);
    await startVm("start");
  }

  const port = await readBackPinnedPort(vmName, onLog);
  // start 返回 ≠ sshd 就绪：guest 早期端口转发可能先于 sshd 监听，
  // 立刻 connectRemote 会得到 ECONNREFUSED/断开（automation VM 实测复现）。
  // 这里等到 SSH banner 再交付 endpoint。
  if (!(await waitForSshEndpoint("127.0.0.1", port, { timeoutMs: 90_000 }))) {
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
  return { success: true, endpoint };
}

/** 同 VM 并发 ensureUp 只跑一次（多窗口重连同一 VM 时复用同一承诺，计划 R5）。 */
const ensureUpInflight = new Map<string, Promise<VmEnsureUpResult>>();

async function ensureUp(
  workspacePath: string,
  onLog: VmRuntimeLogLine = () => {},
): Promise<VmEnsureUpResult> {
  const inflight = ensureUpInflight.get(workspacePath);
  if (inflight) {
    return inflight;
  }
  const operation = ensureUpSequence(workspacePath, onLog)
    .catch((error): VmEnsureUpResult => {
      const message = error instanceof Error ? error.message : String(error);
      onLog(message, "error");
      logger.warn("[vmRuntimeProvider] ensureUp 失败", {
        workspacePath,
        error: message,
      });
      return { success: false, error: message };
    })
    .finally(() => {
      ensureUpInflight.delete(workspacePath);
    });
  ensureUpInflight.set(workspacePath, operation);
  return operation;
}

async function status(workspacePath: string): Promise<VmRuntimeStatus> {
  const availability = await checkVmTooling();
  const unavailabilityReason = resolveUnavailability(availability);
  if (unavailabilityReason) {
    return { available: false, unavailabilityReason, state: "none" };
  }

  let alias: string;
  let vmName: string;
  try {
    alias = deriveVmAlias(workspacePath);
    vmName = await resolveVmName(workspacePath);
  } catch (error) {
    logger.warn("[vmRuntimeProvider] 解析 VM 名失败", {
      workspacePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return { available: true, state: "none" };
  }

  const instances = await limactlListStatuses();
  const state = mapLimaStatusToVmState(instances.get(vmName));
  if (state === "none") {
    return { available: true, state, vm: vmName, alias };
  }
  const port = await readPinnedPort(vmName);
  return {
    available: true,
    state,
    vm: vmName,
    alias,
    ...(port !== null ? { port } : {}),
  };
}

async function stop(workspacePath: string): Promise<VmStopResult> {
  const availability = await checkVmTooling();
  if (!availability.agentVm) {
    return {
      success: false,
      error: "agent-vm is not available on this machine",
    };
  }
  const result = await runAgentVm(["stop"], {
    cwd: workspacePath,
    timeoutMs: VM_STOP_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    const message = describeCommandFailure("agent-vm stop", result);
    logger.warn("[vmRuntimeProvider] stop 失败", {
      workspacePath,
      error: message,
    });
    return { success: false, error: message };
  }
  return { success: true };
}

export const vmRuntimeProvider = {
  status,
  ensureUp,
  stop,
};
