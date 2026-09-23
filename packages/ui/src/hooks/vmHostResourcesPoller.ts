import type { VmHostResources } from "@zcode/shared";

/**
 * Host resources polling controller (plan-vm-specs.md 2.7).
 *
 * The spec panel is a persistent waiting-for-the-user surface: a one-shot snapshot goes stale exactly
 * while it is being used (free memory first, then pick a size — the numbers never move). Poll at a fixed
 * interval while open, aligned with desktop main's HOST_RESOURCES_CACHE_TTL_MS — repeats within the TTL are free,
 * and every expired read is a fresh build, so polling is effectively free.
 *
 * React-free so node:test can cover the behavior directly (immediate first fetch, serial non-stacking ticks,
 * late results dropped after stop, polling survives errors). useVmHostResources is a thin wrapper over it.
 */

/** Matches the 5s TTL cache in vmRuntimeHostResources.ts. */
export const VM_HOST_RESOURCES_POLL_INTERVAL_MS = 5_000;

export interface VmHostResourcesPollerOptions {
  fetchResources: () => Promise<VmHostResources>;
  /** Outlet for each fresh snapshot; the caller decides which state to write (single-owner rule). */
  onResources: (resources: VmHostResources) => void;
  /** Errors do not stop polling; the caller picks the severity. */
  onError: (error: unknown) => void;
  intervalMs?: number;
}

export interface VmHostResourcesPoller {
  start: () => void;
  stop: () => void;
}

export function createVmHostResourcesPoller(
  options: VmHostResourcesPollerOptions,
): VmHostResourcesPoller {
  const { fetchResources, onResources, onError } = options;
  const intervalMs = options.intervalMs ?? VM_HOST_RESOURCES_POLL_INTERVAL_MS;
  let disposed = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  // Serial, non-stacking: skip the tick while the previous fetch (a slow limactl) is still in flight.
  const tick = async () => {
    if (disposed || inFlight) {
      return;
    }
    inFlight = true;
    try {
      const resources = await fetchResources();
      if (disposed) {
        return;
      }
      onResources(resources);
    } catch (error) {
      if (disposed) {
        return;
      }
      onError(error);
    } finally {
      inFlight = false;
    }
  };

  return {
    start: () => {
      if (disposed || timer) {
        return;
      }
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
    },
    stop: () => {
      disposed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
