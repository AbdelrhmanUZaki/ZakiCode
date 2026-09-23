/**
 * agent-vm 沙箱 VM 运行时契约。
 *
 * 状态唯一所有者是 desktop main 的 vmRuntimeProvider（直连 agent-vm/limactl），
 * renderer 只通过 IPC 读取结果；本文件只描述协议形状，不承载逻辑。
 */

/** VM 生命周期状态。creating/starting 只在 ensureUp 过程中短暂出现，查询侧通常只见 none/running/stopped。 */
export const VM_RUNTIME_STATES = [
  "none",
  "creating",
  "starting",
  "running",
  "stopped",
] as const;
export type VmRuntimeState = (typeof VM_RUNTIME_STATES)[number];

/** SSH target 由本机 agent-vm/Lima VM 承载的标记。provider 固定为 agent-vm，预留未来扩展。 */
export interface RemoteVmTargetInfo {
  provider: "agent-vm";
  vmName: string;
}

/** 可连接的 VM SSH endpoint。port 每次由 provider 从 lima.yaml 读回，调用方不得持久化后盲信。 */
export interface VmRuntimeEndpoint {
  vm: string;
  alias: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
}

export type VmRuntimeUnavailabilityReason =
  "missing-agent-vm" | "missing-limactl";

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
}

export interface VmEnsureUpRequest {
  workspacePath: string;
  /** 复用远程连接日志面板的 requestId，让 VM 启动行与连接日志流在同一处展示。 */
  requestId?: string;
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

/** agent-vm 私钥在宿主机上的固定位置（Lima 托管，vmup/agent-vm 共用）。 */
const AGENT_VM_PRIVATE_KEY_SUFFIX = ".lima/_config/user";
const AGENT_VM_ALIAS_PREFIX = "vm-";

/** SSH target / snapshot 的结构子集，isVmBackedRemoteTarget 只读这些字段。 */
interface VmBackedTargetLike {
  kind: string;
  host?: string;
  sshConfigAlias?: string;
  privateKeyPath?: string;
  vm?: RemoteVmTargetInfo;
}

/**
 * 判断 target 是否由本机 agent-vm VM 承载。
 *
 * 新条目带显式 `vm` 标记；旧向导建立的条目没有标记，只能按 agent-vm 独有特征
 * （127.0.0.1 + Lima 托管私钥 + vm- alias）识别，三者缺一不可，避免误判后
 * ensureUp 在普通 SSH 目录上凭空创建 VM。
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
