import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ZCODE_PRODUCT_FLAVOR } from "@zcode/shared";
import { setDataBaseDir } from "@zcode/services/node";
import { isElectronAppPackaged } from "./desktopElectronApp.js";

const ZAKICODE_DEFAULT_DATA_BASE_DIR_NAME = ".zakicode";

// The zakicode flavor keeps its app-layer state (credentials, settings, task
// index, logs, crash dumps) away from an upstream install, while the agent CLI
// layer stays on the shared ~/.zcode/cli session pool. This flag tells the host
// env builder that the active data root is a flavor default rather than a user
// override, so it must NOT be forwarded as ZCODE_DATA_BASE_DIR — forwarding it
// would root spawned agents at the fork dir and split the shared session pool.
let flavorDefaultDataBaseDirActive = false;

function isZakicodePackagedRuntime(): boolean {
  return ZCODE_PRODUCT_FLAVOR === "zakicode" && isElectronAppPackaged();
}

export function resolveZakicodeDefaultDataBaseDir(): string | null {
  return isZakicodePackagedRuntime() ? join(homedir(), ZAKICODE_DEFAULT_DATA_BASE_DIR_NAME) : null;
}

export function isFlavorDefaultDataBaseDirActive(): boolean {
  return flavorDefaultDataBaseDirActive;
}

/**
 * Apply a user-chosen data base dir (settings UI or settings file). User
 * overrides always win over the flavor default and are forwarded to spawned
 * hosts/agents, matching the long-standing custom-directory semantics.
 */
export function applyUserDataBaseDir(dataBaseDir: string): void {
  flavorDefaultDataBaseDirActive = false;
  setDataBaseDir(dataBaseDir);
}

function resolveBootstrapSettingsFile(homePath: string = homedir()): string {
  // The zakicode flavor reads its settings from its own data root; every other
  // flavor keeps the historical ~/.zcode/v2/setting.json location.
  const flavorDefaultDir = resolveZakicodeDefaultDataBaseDir();
  const baseDir = flavorDefaultDir ?? homePath;
  return join(baseDir, ".zcode", "v2", "setting.json");
}

function extractBootstrapDataBaseDir(rawValue: unknown): string | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const dataBaseDir = (rawValue as { dataBaseDir?: unknown }).dataBaseDir;
  if (typeof dataBaseDir !== "string") {
    return null;
  }

  const trimmed = dataBaseDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBootstrapDataBaseDirFromDisk(
  settingsFile: string = resolveBootstrapSettingsFile(),
): string | null {
  if (!existsSync(settingsFile)) {
    return null;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapDataBaseDir(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function applyEarlyDataBaseDirBootstrap(): string | null {
  const userDataBaseDir = readBootstrapDataBaseDirFromDisk();
  if (userDataBaseDir) {
    // 启动早期就把 dataBaseDir 注入进来，避免 logger / crashReporter 先按默认 HOME 建目录，
    // 导致后续再切换到自定义目录时，日志和 crash dump 落在两套路径里。
    applyUserDataBaseDir(userDataBaseDir);
    return userDataBaseDir;
  }

  if (process.env.ZCODE_DATA_BASE_DIR?.trim()) {
    // An externally provided ZCODE_DATA_BASE_DIR is a user override; the
    // services paths module already honors it, only record the kind.
    flavorDefaultDataBaseDirActive = false;
    return null;
  }

  const flavorDefaultDir = resolveZakicodeDefaultDataBaseDir();
  if (flavorDefaultDir) {
    flavorDefaultDataBaseDirActive = true;
    setDataBaseDir(flavorDefaultDir);
  }
  return null;
}
