/**
 * agent-vm sandbox VM runtime contract.
 *
 * The single state owner is desktop main's vmRuntimeProvider (talking to agent-vm/limactl directly);
 * the renderer only reads results over IPC. This file describes protocol shapes and carries no logic.
 */

/** VM lifecycle states. creating/starting appear only briefly during ensureUp; queries usually see none/running/stopped. */
export const VM_RUNTIME_STATES = ["none", "creating", "starting", "running", "stopped"] as const;
export type VmRuntimeState = (typeof VM_RUNTIME_STATES)[number];

/** Resource spec at VM creation; absent fields mean agent-vm defaults (3 GB / 1 CPU / 10 GB disk). */
export interface VmResourceSpec {
  memoryGb?: number;
  cpus?: number;
  diskGb?: number;
}

/** Static spec bounds (the UI additionally soft-warns against actual host resources). */
export const VM_RESOURCE_SPEC_LIMITS = {
  memoryGb: { min: 1, max: 8 },
  cpus: { min: 1, max: 16 },
  diskGb: { min: 5, max: 60 },
} as const;

/** Marks an SSH target backed by a local agent-vm/Lima VM. The provider is fixed to agent-vm; reserved for future extension.
 * Spec fields are consumed at creation only (ensureUp spec); reconnect never resizes an existing instance (use vmReconfigure). */
export interface RemoteVmTargetInfo extends VmResourceSpec {
  provider: "agent-vm";
  vmName: string;
}

/** A connectable VM SSH endpoint. The port is read back from lima.yaml every time; callers must not blindly trust a persisted value. */
export interface VmRuntimeEndpoint {
  vm: string;
  alias: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
}

export type VmRuntimeUnavailabilityReason = "missing-agent-vm" | "missing-limactl";

export interface VmRuntimeStatusRequest {
  workspacePath: string;
}

export interface VmRuntimeStatus {
  available: boolean;
  unavailabilityReason?: VmRuntimeUnavailabilityReason;
  state: VmRuntimeState;
  vm?: string;
  alias?: string;
  port?: number;
  /** The instance's actual specs (from limactl list; the settings panel trusts this, not the marker). */
  memoryGb?: number;
  cpus?: number;
  diskGb?: number;
  /** Whether the base image is ready (machine-level fact, probed only when the VM does not exist); it is built automatically before a first create. */
  templateReady?: boolean;
}

/** Host resources snapshot: availableMemoryGb is the kernel's MemAvailable (unreclaimable pages already excluded);
 * running VMs' full allocations are listed separately in runningVms as UI context, not subtracted from the available value. */
export interface VmHostResources {
  totalMemoryGb: number;
  availableMemoryGb: number;
  logicalCpus: number;
  diskFreeGb: number;
  runningVms: Array<{ vm: string; memoryGb: number; cpus: number }>;
}

/** Base image preinstall tool choice (one-time, machine-level; maps to agent-vm setup --preinstall).
 * preset "minimal" = the recommended dev set (python,node,docker,gh, no AI-agent CLIs) — also the
 *         fallback when no choice reaches the provider;
 *         "default" = agent-vm's full default set (everything except Ruby/Rust/Go, including the agent CLIs);
 *         with "custom", customList is passed through verbatim. */
export interface VmTemplateToolsChoice {
  preset: "default" | "minimal" | "custom";
  /** Consumed only when preset === "custom": comma-separated agent-vm tool names. */
  customList?: string;
}

export const VM_TEMPLATE_MINIMAL_PREINSTALL = "python,node,docker,gh";

/** Map the choice to a --preinstall value. No choice resolves to the minimal dev set:
 * ZakiCode ships its own agent runtime, so the AI-agent CLIs in agent-vm's full
 * default set are dead weight on a fresh machine. Invalid custom input falls back
 * to the minimal set as well. */
export function resolveVmTemplatePreinstall(choice?: VmTemplateToolsChoice): string | undefined {
  if (!choice || choice.preset === "minimal") {
    return VM_TEMPLATE_MINIMAL_PREINSTALL;
  }
  if (choice.preset === "default") {
    return undefined;
  }
  const list = choice.customList?.trim();
  return list && /^[a-z0-9,-]+$/i.test(list) ? list : undefined;
}

export interface VmEnsureUpRequest {
  workspacePath: string;
  /** Reuse the remote-connection log panel's requestId so VM boot lines and connection logs stream in one place. */
  requestId?: string;
  /** Applies on first create only; ignored with a log line when the VM already exists. */
  spec?: VmResourceSpec;
  /** Applies only for a first create with the base image missing: the base image preinstall choice. */
  templateTools?: VmTemplateToolsChoice;
}

export interface VmEnsureUpResult {
  success: boolean;
  error?: string;
  endpoint?: VmRuntimeEndpoint;
}

export interface VmStopRequest {
  workspacePath: string;
}

export interface VmStopResult {
  success: boolean;
  error?: string;
}

/** Resize an existing VM: agent-vm --reset re-clone + re-pin the port + start. */
export interface VmReconfigureRequest {
  workspacePath: string;
  spec: VmResourceSpec;
  requestId?: string;
}

/** The agent-vm private key's fixed host location (Lima-managed, shared by vmup/agent-vm). */
const AGENT_VM_PRIVATE_KEY_SUFFIX = ".lima/_config/user";
const AGENT_VM_ALIAS_PREFIX = "vm-";

/** Structural subset of an SSH target/snapshot; isVmBackedRemoteTarget only reads these fields. */
interface VmBackedTargetLike {
  kind: string;
  host?: string;
  sshConfigAlias?: string;
  privateKeyPath?: string;
  vm?: RemoteVmTargetInfo;
}

/**
 * Whether a target is backed by a local agent-vm VM.
 *
 * New entries carry an explicit `vm` marker; legacy wizard entries do not, and are recognized only by
 * agent-vm-specific traits (127.0.0.1 + the Lima-managed key + a vm- alias). All three are required so
 ensureUp never conjures a VM for an ordinary SSH directory.
 */
export function isVmBackedRemoteTarget(target: VmBackedTargetLike): boolean {
  if (target.kind !== "ssh") {
    return false;
  }
  if (target.vm) {
    return true;
  }
  return (
    target.host === "127.0.0.1" &&
    (target.privateKeyPath?.endsWith(AGENT_VM_PRIVATE_KEY_SUFFIX) ?? false) &&
    (target.sshConfigAlias?.startsWith(AGENT_VM_ALIAS_PREFIX) ?? false)
  );
}
