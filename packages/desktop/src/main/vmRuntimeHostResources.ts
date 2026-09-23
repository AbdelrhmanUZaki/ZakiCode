/**
 * Host resources and Lima instance inventory queries (used by vmRuntimeProvider).
 *
 * limactl list is the single source of truth for instances (specs/state); host memory uses Linux
 * /proc/meminfo MemAvailable (includes reclaimable cache; os.freemem under-reports),
 * available memory = MemAvailable minus the full allocations of running VMs (a Lima VM holds its allocation while running).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { VmHostResources } from "@zcode/shared";
import { runVmCommand } from "./vmRuntimeProcess.js";

const VM_FAST_TIMEOUT_MS = 30_000;
const HOST_RESOURCES_CACHE_TTL_MS = 5_000;
const GIB = 1024 * 1024 * 1024;

export interface VmLimaInstanceRecord {
  name: string;
  status: string;
  cpus: number;
  memoryBytes: number;
  diskBytes: number;
}

function parseInstanceLine(line: string): VmLimaInstanceRecord | null {
  // --format output is single-space separated: name status cpus memoryBytes diskBytes (Memory/Disk in bytes).
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) {
    return null;
  }
  const cpus = Number.parseInt(parts[2] ?? "", 10);
  const memoryBytes = Number.parseInt(parts[3] ?? "", 10);
  const diskBytes = Number.parseInt(parts[4] ?? "", 10);
  if (!Number.isFinite(cpus) || !Number.isFinite(memoryBytes)) {
    return null;
  }
  return {
    name: parts[0] ?? "",
    status: parts[1] ?? "",
    cpus,
    memoryBytes,
    diskBytes: Number.isFinite(diskBytes) ? diskBytes : 0,
  };
}

export async function limactlListInstances(): Promise<VmLimaInstanceRecord[]> {
  const result = await runVmCommand(
    "limactl",
    ["list", "--format", "{{.Name}} {{.Status}} {{.CPUs}} {{.Memory}} {{.Disk}}"],
    { timeoutMs: VM_FAST_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => parseInstanceLine(line))
    .filter((record): record is VmLimaInstanceRecord => record !== null);
}

function roundGb(bytes: number): number {
  return Math.round((bytes / GIB) * 10) / 10;
}

/** Prefer Linux MemAvailable (includes reclaimable cache); fall back to os.freemem() when unreadable. */
async function readMemAvailableBytes(): Promise<number> {
  try {
    const meminfo = await fs.readFile("/proc/meminfo", "utf8");
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (match) {
      return Number.parseInt(match[1] ?? "", 10) * 1024;
    }
  } catch {
    // Non-Linux or read failure: fall back to os.freemem().
  }
  return os.freemem();
}

async function readDiskFreeBytes(dir: string): Promise<number> {
  try {
    const stats = await fs.statfs(dir);
    return stats.bsize * stats.bavail;
  } catch {
    return 0;
  }
}

/** Assemble the host resources snapshot.
 *
 * availableMemoryGb is the kernel's MemAvailable directly: a VM's used memory is unreclaimable anonymous pages,
 * which the kernel already excludes from MemAvailable — subtracting running VM allocations again double-counts
 * and mis-reports a host with plenty of free cache as 0.0 GB (reproduced). Running VMs' committed sizes are listed
 * separately in runningVms for the user to weigh (a new VM fills its allocation gradually). */
export async function buildHostResources(
  instances: VmLimaInstanceRecord[],
): Promise<VmHostResources> {
  const [memAvailable, diskFree, totalMemory] = await Promise.all([
    readMemAvailableBytes(),
    readDiskFreeBytes(path.join(os.homedir(), ".lima")),
    Promise.resolve(os.totalmem()),
  ]);
  const runningVms = instances
    .filter((instance) => instance.status.startsWith("Running"))
    .map((instance) => ({
      vm: instance.name,
      memoryGb: roundGb(instance.memoryBytes),
      cpus: instance.cpus,
    }));
  return {
    totalMemoryGb: roundGb(totalMemory),
    availableMemoryGb: roundGb(memAvailable),
    logicalCpus: os.cpus().length,
    diskFreeGb: roundGb(diskFree),
    runningVms,
  };
}

let hostResourcesCache: { value: VmHostResources; checkedAt: number } | null = null;

export async function hostResources(): Promise<VmHostResources> {
  if (
    hostResourcesCache &&
    Date.now() - hostResourcesCache.checkedAt < HOST_RESOURCES_CACHE_TTL_MS
  ) {
    return hostResourcesCache.value;
  }
  const value = await buildHostResources(await limactlListInstances());
  hostResourcesCache = { value, checkedAt: Date.now() };
  return value;
}
