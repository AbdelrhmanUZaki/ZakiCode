import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  runXdgCommand,
  XDG_COMMAND_TIMEOUT_MS,
  type LinuxDesktopCommandRunner,
  type LinuxDeepLinkRegistrationLogger,
} from "./desktopLinuxXdg.js";

// 从 desktopLinuxDeepLinkRegistration 拆出的 AppImage 用户级图标安装逻辑：
// 图标集成是可选的桌面增强，与 deep link 协议注册分属不同关注点，独立成模块便于各自演进。

const LINUX_APP_ICON_DEFAULT_NAME = "zcode";
const LINUX_APP_ICON_SIZE = "512x512";
// Packaged size set (resources/zakicode-icons/<N>x<N>.png). Taskbars and app
// launchers resolve icons per requested size; installing only a single 512px
// file left the fork with a blank paper icon in the KDE Wayland taskbar.
const LINUX_APP_ICON_SIZES_DIR_NAME = "zakicode-icons";
const LINUX_APP_ICON_SIZE_FILE_PATTERN = /^(\d+)x\1\.png$/;

interface LinuxIconInstallSource {
  sourcePath: string;
  sizeDirName: string;
}

function resolveLinuxUserIconFilePath(
  dataDir: string,
  iconName: string,
  sizeDirName: string,
): string {
  return join(dataDir, "icons", "hicolor", sizeDirName, "apps", `${iconName}.png`);
}

export function resolveLinuxIconInstallSources(iconSourcePath: string): LinuxIconInstallSource[] {
  const sources: LinuxIconInstallSource[] = [];
  const sizeDirRoot = join(dirname(iconSourcePath), LINUX_APP_ICON_SIZES_DIR_NAME);
  if (existsSync(sizeDirRoot)) {
    for (const entry of readdirSync(sizeDirRoot)) {
      if (LINUX_APP_ICON_SIZE_FILE_PATTERN.test(entry)) {
        sources.push({
          sourcePath: join(sizeDirRoot, entry),
          sizeDirName: entry.replace(/\.png$/, ""),
        });
      }
    }
  }
  // The single packaged 512 resource is the fallback when the size set is not
  // shipped (non-fork flavors keep the historical one-file behavior).
  if (!sources.some((source) => source.sizeDirName === LINUX_APP_ICON_SIZE)) {
    sources.push({ sourcePath: iconSourcePath, sizeDirName: LINUX_APP_ICON_SIZE });
  }
  return sources;
}

function copyFileIfChanged(sourcePath: string, targetPath: string): boolean {
  if (existsSync(targetPath) && readFileSync(sourcePath).equals(readFileSync(targetPath))) {
    return false;
  }

  copyFileSync(sourcePath, targetPath);
  return true;
}

function shouldInstallAppImageDesktopIcon(params: {
  env?: { APPIMAGE?: string };
  iconSourcePath?: string;
}): boolean {
  return Boolean(params.env?.APPIMAGE?.trim() && params.iconSourcePath);
}

function installLinuxAppImageDesktopIcon(params: {
  dataDir: string;
  iconName: string;
  iconSourcePath: string;
  logger: LinuxDeepLinkRegistrationLogger;
  runCommand?: LinuxDesktopCommandRunner;
}): { iconFilePath: string; installed: boolean; changed: boolean } {
  const iconSources = resolveLinuxIconInstallSources(params.iconSourcePath);
  const primarySource =
    iconSources.find((source) => source.sizeDirName === LINUX_APP_ICON_SIZE) ?? iconSources[0]!;
  const iconFilePath = resolveLinuxUserIconFilePath(
    params.dataDir,
    params.iconName,
    primarySource.sizeDirName,
  );

  let installedCount = 0;
  let anyChanged = false;
  for (const source of iconSources) {
    if (!existsSync(source.sourcePath)) {
      params.logger.warn("[deep-link] Linux AppImage 图标源文件不存在，跳过该尺寸", {
        iconSourcePath: source.sourcePath,
        sizeDirName: source.sizeDirName,
      });
      continue;
    }
    const targetPath = resolveLinuxUserIconFilePath(
      params.dataDir,
      params.iconName,
      source.sizeDirName,
    );
    mkdirSync(dirname(targetPath), { recursive: true });
    const changed = copyFileIfChanged(source.sourcePath, targetPath);
    anyChanged = anyChanged || changed;
    installedCount += 1;
  }

  if (installedCount === 0) {
    return { iconFilePath, installed: false, changed: false };
  }
  if (!anyChanged) {
    return { iconFilePath, installed: true, changed: false };
  }

  // AppImage 直跑不会像 deb 安装包一样把 Icon 写入 hicolor 图标主题。
  // 这里在用户级 hicolor 目录补齐同名图标，让任务栏/Dock 有机会按 desktop entry 命中真实图标。
  const runCommand = params.runCommand ?? runXdgCommand;
  const cacheResult = runCommand("gtk-update-icon-cache", [
    "-f",
    "-t",
    join(params.dataDir, "icons", "hicolor"),
  ]);
  if (cacheResult.error) {
    params.logger.warn("[deep-link] gtk-update-icon-cache 不可用，已跳过", {
      iconFilePath,
      message: cacheResult.error.message,
    });
  } else if (cacheResult.signal === "SIGTERM") {
    params.logger.warn("[deep-link] Linux 用户级图标缓存刷新超时，已跳过", {
      iconFilePath,
      timeoutMs: XDG_COMMAND_TIMEOUT_MS,
    });
  } else if (cacheResult.status !== 0) {
    params.logger.warn("[deep-link] Linux 用户级图标缓存刷新失败", {
      iconFilePath,
      status: cacheResult.status,
      stderr: cacheResult.stderr?.trim(),
    });
  }

  return { iconFilePath, installed: true, changed: true };
}

export function installLinuxAppImageDesktopIconBestEffort(params: {
  dataDir: string;
  env?: { APPIMAGE?: string };
  iconName?: string;
  iconSourcePath?: string;
  logger: LinuxDeepLinkRegistrationLogger;
  runCommand?: LinuxDesktopCommandRunner;
}): { iconFilePath: string; installed: boolean; changed: boolean } | null {
  if (
    !shouldInstallAppImageDesktopIcon({
      env: params.env,
      iconSourcePath: params.iconSourcePath,
    }) ||
    !params.iconSourcePath
  ) {
    return null;
  }

  try {
    return installLinuxAppImageDesktopIcon({
      dataDir: params.dataDir,
      // Per-flavor icon name: zakicode installs its own hicolor icon so it does
      // not overwrite the upstream app's launcher icon in shared icon dirs.
      iconName: params.iconName ?? LINUX_APP_ICON_DEFAULT_NAME,
      iconSourcePath: params.iconSourcePath,
      logger: params.logger,
      runCommand: params.runCommand,
    });
  } catch (error) {
    params.logger.warn("[deep-link] Linux AppImage 图标安装失败，已降级", {
      iconSourcePath: params.iconSourcePath,
      error,
    });
    return null;
  }
}
