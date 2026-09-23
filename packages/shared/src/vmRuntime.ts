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

/** VM 创建时的资源规格；字段缺省 = agent-vm 默认（3 GB / 1 CPU / 10 GB 磁盘）。 */
export interface VmResourceSpec {
  memoryGb?: number;
  cpus?: number;
  diskGb?: number;
}

/** 规格静态上限（UI 在此之上再按宿主实际资源给出软警告）。 */
export const VM_RESOURCE_SPEC_LIMITS = {
  memoryGb: { min: 1, max: 8 },
  cpus: { min: 1, max: 16 },
  diskGb: { min: 5, max: 60 },
} as const;

/** SSH target 由本机 agent-vm/Lima VM 承载的标记。provider 固定为 agent-vm，预留未来扩展。
 * 规格字段只在创建时消费（ensureUp spec）；重连不改既有实例（调整走 vmReconfigure）。 */
export interface RemoteVmTargetInfo extends VmResourceSpec {
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
  /** 实例当前实际规格（来自 limactl list；设置面板以此为准，不读 marker）。 */
  memoryGb?: number;
  cpus?: number;
  diskGb?: number;
  /** 基础镜像是否就绪（机器级事实，仅在 VM 不存在时探测）；缺镜像时首次创建前会自动构建。 */
  templateReady?: boolean;
}

/** 宿主资源快照：availableMemoryGb 取内核 MemAvailable（已排除不可回收页）；
 * 在跑 VM 的整额分配单列在 runningVms，由 UI 作为提示展示而非从可用值中扣除。 */
export interface VmHostResources {
  totalMemoryGb: number;
  availableMemoryGb: number;
  logicalCpus: number;
  diskFreeGb: number;
  runningVms: Array<{ vm: string; memoryGb: number; cpus: number }>;
}

export interface VmEnsureUpRequest {
  workspacePath: string;
  /** 复用远程连接日志面板的 requestId，让 VM 启动行与连接日志流在同一处展示。 */
  requestId?: string;
  /** 仅在首次创建时生效；VM 已存在时忽略并记一行日志。 */
  spec?: VmResourceSpec;
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

/** 调整既有 VM 的规格：agent-vm --reset 重克隆 + 重新 pin 端口 + 启动。 */
export interface VmReconfigureRequest {
  workspacePath: string;
  spec: VmResourceSpec;
  requestId?: string;
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
