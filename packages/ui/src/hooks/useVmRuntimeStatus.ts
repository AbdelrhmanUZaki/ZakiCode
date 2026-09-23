import { useCallback, useEffect, useState } from "react";
import type { VmRuntimeStatus } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

/**
 * Query the agent-vm VM state (data source for the sidebar badge).
 *
 * The state owner is desktop main; this hook only does one-shot/event-driven fetches, no polling —
 * refresh happens on reconnect success (remoteSessionId changing) and after a manual stop.
 */
export function useVmRuntimeStatus(params: {
  workspacePath: string;
  enabled: boolean;
  /** Re-fetch when this changes (e.g. sessionId going from empty to set after a reconnect). */
  refreshKey?: string | null;
}): { vmStatus: VmRuntimeStatus | null; refreshVmStatus: () => void } {
  const { workspacePath, enabled, refreshKey } = params;
  const platform = usePlatform();
  const [vmStatus, setVmStatus] = useState<VmRuntimeStatus | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!enabled || !platform.vmStatus) {
      return;
    }
    try {
      const status = await platform.vmStatus({ workspacePath });
      setVmStatus(status);
    } catch (error) {
      logger.warn("[useVmRuntimeStatus] vmStatus 查询失败", {
        workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [enabled, platform, workspacePath]);

  useEffect(() => {
    if (!enabled) {
      setVmStatus(null);
      return;
    }
    void fetchStatus();
  }, [enabled, fetchStatus, refreshKey]);

  return { vmStatus, refreshVmStatus: fetchStatus };
}
