/**
 * agent-vm 沙箱 VM runtime provider —— vmup 脚本逻辑的 TypeScript 移植。
 *
 * 原因与依据：vmup（~/vmup/vmup）为 120 行 bash，
 * 只做四件事：按路径派生 VM/alias、pin SSH 端口、调用 agent-vm/limactl 生命周期、
 * 维护 ~/.ssh/config 受管 alias 块。这里按 docs/plan-open-in-vm.md §2.1 原样移植，
 * 端口算法与 ssh config 标记必须与脚本字节兼容（双写者可互换，见计划 R6）。
 *
 * 状态所有者：本模块（desktop main）。renderer 只通过 IPC 读取结果。
 * 生命周期序列在 vmRuntimeLifecycle.ts；实例清单/宿主资源在 vmRuntimeHostResources.ts；
 * 进程执行底座在 vmRuntimeProcess.ts；端口探测/pin 在 vmRuntimePort.ts；
 * ssh config 写入在 vmRuntimeSshConfig.ts。
 */
import type {
  VmEnsureUpResult,
  VmResourceSpec,
  VmRuntimeStatus,
  VmRuntimeUnavailabilityReason,
  VmStopResult,
} from "@zcode/shared";
import { logger } from "./logger.js";
import { readPinnedPort } from "./vmRuntimePort.js";
import { describeCommandFailure, runVmCommand } from "./vmRuntimeProcess.js";
import {
  hostResources,
  limactlListInstances,
} from "./vmRuntimeHostResources.js";
import {
  VM_STOP_TIMEOUT_MS,
  deriveVmAlias,
  ensureUpSequence,
  mapLimaStatusToVmState,
  reconfigureSequence,
  resolveVmName,
  runAgentVm,
  type VmRuntimeLogLine,
} from "./vmRuntimeLifecycle.js";

interface Availability {
  agentVm: boolean;
  limactl: boolean;
}

let availabilityCache: { value: Availability; checkedAt: number } | null = null;

async function checkVmTooling(): Promise<Availability> {
  if (availabilityCache && Date.now() - availabilityCache.checkedAt < 30_000) {
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

interface ResolvedVmIdentity {
  workspacePath: string;
  vmName: string;
  alias: string;
  hashSegment: string;
}

async function resolveVmIdentity(
  workspacePath: string,
): Promise<ResolvedVmIdentity> {
  const vmName = await resolveVmName(workspacePath);
  return {
    workspacePath,
    vmName,
    alias: deriveVmAlias(workspacePath),
    hashSegment: vmName.split("-").pop() ?? "",
  };
}

function bytesToGb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10;
}

/** 同一 workspace 的长耗时操作（ensureUp/reconfigure）共享单飞，避免 --reset 与 boot 交叠。 */
const inflightByWorkspace = new Map<string, Promise<VmEnsureUpResult>>();

function runSingleFlight(
  workspacePath: string,
  operation: () => Promise<VmEnsureUpResult>,
  onLog: VmRuntimeLogLine,
): Promise<VmEnsureUpResult> {
  const inflight = inflightByWorkspace.get(workspacePath);
  if (inflight) {
    return inflight;
  }
  const promise = operation()
    .catch((error): VmEnsureUpResult => {
      const message = error instanceof Error ? error.message : String(error);
      onLog(message, "error");
      logger.warn("[vmRuntimeProvider] 操作失败", {
        workspacePath,
        error: message,
      });
      return { success: false, error: message };
    })
    .finally(() => {
      inflightByWorkspace.delete(workspacePath);
    });
  inflightByWorkspace.set(workspacePath, promise);
  return promise;
}

function ensureTooling(
  onLog: VmRuntimeLogLine,
): Promise<VmRuntimeUnavailabilityReason | undefined> {
  return checkVmTooling().then((availability) => {
    const unavailability = resolveUnavailability(availability);
    if (unavailability) {
      onLog(
        `VM tooling unavailable (${unavailability}); install agent-vm and Lima first`,
        "error",
      );
    }
    return unavailability;
  });
}

async function ensureUp(
  workspacePath: string,
  onLog: VmRuntimeLogLine = () => {},
  spec?: VmResourceSpec,
): Promise<VmEnsureUpResult> {
  return runSingleFlight(
    workspacePath,
    async () => {
      if (await ensureTooling(onLog)) {
        return {
          success: false,
          error: "VM tooling unavailable; install agent-vm and Lima first",
        };
      }
      const identity = await resolveVmIdentity(workspacePath);
      const instances = await limactlListInstances();
      const instance = instances.find(
        (entry) => entry.name === identity.vmName,
      );
      return ensureUpSequence(
        workspacePath,
        identity,
        {
          exists: Boolean(instance),
          running: mapLimaStatusToVmState(instance?.status) === "running",
          pinnedPort: await readPinnedPort(identity.vmName),
        },
        onLog,
        spec,
        instance
          ? {
              memoryGb: bytesToGb(instance.memoryBytes),
              cpus: instance.cpus,
              diskGb: bytesToGb(instance.diskBytes),
            }
          : undefined,
      );
    },
    onLog,
  );
}

async function reconfigure(
  workspacePath: string,
  spec: VmResourceSpec,
  onLog: VmRuntimeLogLine = () => {},
): Promise<VmEnsureUpResult> {
  return runSingleFlight(
    workspacePath,
    async () => {
      if (await ensureTooling(onLog)) {
        return {
          success: false,
          error: "VM tooling unavailable; install agent-vm and Lima first",
        };
      }
      const identity = await resolveVmIdentity(workspacePath);
      return reconfigureSequence(workspacePath, identity, spec, onLog);
    },
    onLog,
  );
}

async function status(workspacePath: string): Promise<VmRuntimeStatus> {
  const availability = await checkVmTooling();
  const unavailabilityReason = resolveUnavailability(availability);
  if (unavailabilityReason) {
    return { available: false, unavailabilityReason, state: "none" };
  }

  let identity: ResolvedVmIdentity;
  try {
    identity = await resolveVmIdentity(workspacePath);
  } catch (error) {
    logger.warn("[vmRuntimeProvider] 解析 VM 名失败", {
      workspacePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return { available: true, state: "none" };
  }

  const instance = (await limactlListInstances()).find(
    (entry) => entry.name === identity.vmName,
  );
  const state = mapLimaStatusToVmState(instance?.status);
  if (!instance || state === "none") {
    return {
      available: true,
      state: "none",
      vm: identity.vmName,
      alias: identity.alias,
    };
  }
  const port = await readPinnedPort(identity.vmName);
  return {
    available: true,
    state,
    vm: identity.vmName,
    alias: identity.alias,
    ...(port !== null ? { port } : {}),
    // 实例实际规格是设置面板的唯一事实（marker 可能漂移，见计划 R5）。
    memoryGb: bytesToGb(instance.memoryBytes),
    cpus: instance.cpus,
    diskGb: bytesToGb(instance.diskBytes),
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
  reconfigure,
  stop,
  hostResources: () =>
    hostResources().catch((error) => {
      logger.warn("[vmRuntimeProvider] hostResources 查询失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        totalMemoryGb: 0,
        availableMemoryGb: 0,
        logicalCpus: 0,
        diskFreeGb: 0,
        runningVms: [],
      };
    }),
};
