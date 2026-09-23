/**
 * agent-vm sandbox VM runtime provider — a TypeScript port of the vmup script's logic.
 *
 * Rationale: vmup is a 120-line bash script doing four things — derive VM/alias from the path,
 * pin the SSH port, drive the agent-vm/limactl lifecycle, and maintain the managed
 * ~/.ssh/config alias block. Ported verbatim per docs/plan-open-in-vm.md §2.1;
 * the port algorithm and ssh-config markers must stay byte-compatible with the script (dual writers, see R6).
 *
 * State owner: this module (desktop main). The renderer only reads results over IPC.
 * Lifecycle sequences live in vmRuntimeLifecycle.ts; instance inventory/host resources in vmRuntimeHostResources.ts;
 * process execution base in vmRuntimeProcess.ts; port probing/pinning in vmRuntimePort.ts;
 * ssh config writes in vmRuntimeSshConfig.ts.
 */
import type {
  VmEnsureUpResult,
  VmResourceSpec,
  VmRuntimeStatus,
  VmRuntimeUnavailabilityReason,
  VmStopResult,
  VmTemplateToolsChoice,
} from "@zcode/shared";
import { logger } from "./logger.js";
import { readPinnedPort } from "./vmRuntimePort.js";
import { describeCommandFailure, runVmCommand } from "./vmRuntimeProcess.js";
import { hostResources, limactlListInstances } from "./vmRuntimeHostResources.js";
import {
  VM_STOP_TIMEOUT_MS,
  deriveVmAlias,
  ensureUpSequence,
  mapLimaStatusToVmState,
  readBaseTemplateExists,
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

async function resolveVmIdentity(workspacePath: string): Promise<ResolvedVmIdentity> {
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

/** Long operations per workspace (ensureUp/reconfigure) share one single-flight slot so --reset and boot never overlap. */
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
      onLog(`VM tooling unavailable (${unavailability}); install agent-vm and Lima first`, "error");
    }
    return unavailability;
  });
}

async function ensureUp(
  workspacePath: string,
  onLog: VmRuntimeLogLine = () => {},
  spec?: VmResourceSpec,
  templateTools?: VmTemplateToolsChoice,
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
      const instance = instances.find((entry) => entry.name === identity.vmName);
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
        templateTools,
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

/** Base image readiness probe (machine-level fact), cached 30 s so opening the panel does not spawn a subprocess each time. */
let templateReadyCache: { value: boolean; checkedAt: number } | null = null;

async function templateReady(workspacePath: string): Promise<boolean> {
  if (templateReadyCache && Date.now() - templateReadyCache.checkedAt < 30_000) {
    return templateReadyCache.value;
  }
  const value = await readBaseTemplateExists(workspacePath);
  templateReadyCache = { value, checkedAt: Date.now() };
  return value;
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

  const instance = (await limactlListInstances()).find((entry) => entry.name === identity.vmName);
  const state = mapLimaStatusToVmState(instance?.status);
  // The panel only cares about the template when the VM does not exist; other states skip this subprocess query.
  const needsTemplateProbe = !instance || state === "none";
  const templateReadyValue = needsTemplateProbe
    ? await templateReady(workspacePath).catch(() => true)
    : true;
  if (!instance || state === "none") {
    return {
      available: true,
      state: "none",
      vm: identity.vmName,
      alias: identity.alias,
      templateReady: templateReadyValue,
    };
  }
  const port = await readPinnedPort(identity.vmName);
  return {
    available: true,
    state,
    vm: identity.vmName,
    alias: identity.alias,
    ...(port !== null ? { port } : {}),
    // The instance's actual specs are the settings panel's source of truth (the marker can drift, see R5).
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
