/**
 * agent-vm VM runtime IPC —— vmStatus / vmEnsureUp / vmStop 的窗口级注册。
 *
 * ensureUp 的子进程输出通过现有 RemoteConnectionLog 频道回流（按 requestId 归属
 * 到发起重连/连接的 workspace 日志面板），不新开日志通道。
 */
import { BrowserWindow, ipcMain } from "electron";
import { PlatformChannels, type VmEnsureUpRequest } from "@zcode/shared";
import {
  vmRuntimeProvider,
  type VmRuntimeLogLine,
} from "./vmRuntimeProvider.js";
import { logger } from "./logger.js";

function readWorkspacePath(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const value = (payload as { workspacePath?: unknown }).workspacePath;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
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
      const requestId =
        typeof (payload as VmEnsureUpRequest).requestId === "string"
          ? (payload as VmEnsureUpRequest).requestId
          : undefined;
      const onLog = createWindowLogSink(event.sender.id, requestId);
      return vmRuntimeProvider.ensureUp(workspacePath, onLog);
    },
  );

  ipcMain.handle(PlatformChannels.VmStop, async (_event, payload: unknown) => {
    const workspacePath = readWorkspacePath(payload);
    if (!workspacePath) {
      return { success: false, error: "workspacePath is required" } as const;
    }
    return vmRuntimeProvider.stop(workspacePath);
  });
}
