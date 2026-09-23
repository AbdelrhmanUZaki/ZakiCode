/**
 * agent-vm VM runtime IPC —— vmStatus / vmEnsureUp / vmStop / vmHostResources /
 * vmReconfigure 的窗口级注册。
 *
 * ensureUp / reconfigure 的子进程输出通过现有 RemoteConnectionLog 频道回流
 * （按 requestId 归属到发起流程的日志面板），不新开日志通道。
 */
import { BrowserWindow, ipcMain } from "electron";
import { PlatformChannels, type VmResourceSpec } from "@zcode/shared";
import { vmRuntimeProvider } from "./vmRuntimeProvider.js";
import type { VmRuntimeLogLine } from "./vmRuntimeLifecycle.js";
import { logger } from "./logger.js";

function readWorkspacePath(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const value = (payload as { workspacePath?: unknown }).workspacePath;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readRequestId(payload: unknown): string | undefined {
  const value = (payload as { requestId?: unknown } | null)?.requestId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readResourceSpec(payload: unknown): VmResourceSpec | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const raw = (payload as { spec?: Record<string, unknown> }).spec;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const spec: VmResourceSpec = {};
  for (const key of ["memoryGb", "cpus", "diskGb"] as const) {
    const value = raw[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      spec[key] = value;
    }
  }
  return Object.keys(spec).length > 0 ? spec : undefined;
}

function createWindowLogSink(
  senderId: number,
  requestId?: string,
): VmRuntimeLogLine {
  return (message, level = "info") => {
    const win = BrowserWindow.fromId(senderId);
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      return;
    }
    win.webContents.send(PlatformChannels.RemoteConnectionLog, {
      label: "vm-runtime",
      requestId,
      level,
      source: "vm-runtime",
      message,
      timestamp: new Date().toISOString(),
    });
  };
}

export function registerVmIpcHandlers(): void {
  ipcMain.handle(
    PlatformChannels.VmStatus,
    async (_event, payload: unknown) => {
      const workspacePath = readWorkspacePath(payload);
      if (!workspacePath) {
        return { available: false, state: "none" } as const;
      }
      try {
        return await vmRuntimeProvider.status(workspacePath);
      } catch (error) {
        logger.warn("[vmRuntimeIpc] vmStatus 查询失败", {
          workspacePath,
          error: error instanceof Error ? error.message : String(error),
        });
        return { available: true, state: "none" } as const;
      }
    },
  );

  ipcMain.handle(
    PlatformChannels.VmEnsureUp,
    async (event, payload: unknown) => {
      const workspacePath = readWorkspacePath(payload);
      if (!workspacePath) {
        return { success: false, error: "workspacePath is required" } as const;
      }
      const requestId = readRequestId(payload);
      const spec = readResourceSpec(payload);
      const onLog = createWindowLogSink(event.sender.id, requestId);
      return vmRuntimeProvider.ensureUp(workspacePath, onLog, spec);
    },
  );

  ipcMain.handle(PlatformChannels.VmStop, async (_event, payload: unknown) => {
    const workspacePath = readWorkspacePath(payload);
    if (!workspacePath) {
      return { success: false, error: "workspacePath is required" } as const;
    }
    return vmRuntimeProvider.stop(workspacePath);
  });

  ipcMain.handle(PlatformChannels.VmHostResources, async () => {
    return vmRuntimeProvider.hostResources();
  });

  ipcMain.handle(
    PlatformChannels.VmReconfigure,
    async (event, payload: unknown) => {
      const workspacePath = readWorkspacePath(payload);
      if (!workspacePath) {
        return {
          success: false,
          error: "workspacePath is required",
        } as const;
      }
      const spec = readResourceSpec(payload);
      if (!spec) {
        return { success: false, error: "spec is required" } as const;
      }
      const requestId = readRequestId(payload);
      const onLog = createWindowLogSink(event.sender.id, requestId);
      return vmRuntimeProvider.reconfigure(workspacePath, spec, onLog);
    },
  );
}
