import { useEffect, useMemo, useRef } from "react";
import type { VmHostResources } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import {
  createVmHostResourcesPoller,
  VM_HOST_RESOURCES_POLL_INTERVAL_MS,
} from "@/hooks/vmHostResourcesPoller.js";
import { logger } from "@/logger.js";

/**
 * Poll host resources while the panel is open (plan-vm-specs.md 2.7 / R7).
 *
 * This intentionally diverges from useVmRuntimeStatus's no-polling rule: VM state's refresh owner is
 * desktop main, while here the open decision panel (spec panel, VM settings) owns refreshing —
 * a push channel for a minutes-lived dialog is disproportionate. The poll interval matches main's TTL cache.
 *
 * The hook holds no snapshot state: each fresh reading goes to the caller's single owner via onResources
 * (setVmSpecPanel / setHostResources), avoiding a second copy of the truth.
 * No-op when platform.vmHostResources is missing (web, older preloads).
 */
export function useVmHostResources(params: {
  enabled: boolean;
  onResources: (resources: VmHostResources) => void;
  /** Defaults to a warn; callers can override for visible errors. */
  onError?: (error: unknown) => void;
}): void {
  const { enabled } = params;
  const platform = usePlatform();
  const onResourcesRef = useRef(params.onResources);
  const onErrorRef = useRef(params.onError);
  onResourcesRef.current = params.onResources;
  onErrorRef.current = params.onError;

  // bind creates a new reference every render; memoize it so the effect does not rebuild the poller each time.
  const fetchHostResources = useMemo(() => platform.vmHostResources?.bind(platform), [platform]);

  useEffect(() => {
    if (!enabled || !fetchHostResources) {
      return;
    }
    const poller = createVmHostResourcesPoller({
      fetchResources: fetchHostResources,
      onResources: (resources) => onResourcesRef.current(resources),
      onError: (error) => {
        if (onErrorRef.current) {
          onErrorRef.current(error);
          return;
        }
        logger.warn("[useVmHostResources] hostResources 查询失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      intervalMs: VM_HOST_RESOURCES_POLL_INTERVAL_MS,
    });
    poller.start();
    return () => {
      poller.stop();
    };
  }, [enabled, fetchHostResources]);
}
