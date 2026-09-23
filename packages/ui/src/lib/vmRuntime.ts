import { isVmBackedRemoteTarget, type IPlatformService, type RemoteTarget } from "@zcode/shared";

/**
 Pre-connect step for VM-backed SSH targets: ensureUp brings the corresponding agent-vm VM up
 and overwrites the target with the provider's read-back endpoint (the port may have drifted on collision).
 *
 Non-VM targets and platforms without vmEnsureUp (web/older preloads) are returned unchanged, keeping the existing direct-connect path.
 Throws on failure so the caller's reconnect-failure branch can persist/toast it.
 */
export async function ensureVmRuntimeForRemoteTarget(params: {
  vmEnsureUp?: IPlatformService["vmEnsureUp"];
  target: RemoteTarget;
  workspacePath: string;
  requestId?: string;
}): Promise<RemoteTarget> {
  const { vmEnsureUp, target, workspacePath, requestId } = params;
  if (target.kind !== "ssh" || !isVmBackedRemoteTarget(target) || !vmEnsureUp) {
    return target;
  }

  const result = await vmEnsureUp({ workspacePath, requestId });
  if (!result.success || !result.endpoint) {
    throw new Error(result.error || "Failed to start the project VM");
  }

  return {
    ...target,
    host: result.endpoint.host,
    port: result.endpoint.port,
    username: result.endpoint.username,
    sshConfigAlias: result.endpoint.alias,
    privateKeyPath: result.endpoint.privateKeyPath,
    vm: { provider: "agent-vm", vmName: result.endpoint.vm },
  };
}
