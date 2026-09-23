/**
 * agent-vm/limactl child-process execution base (used by vmRuntimeProvider).
 *
 * Why a separate file: GUI-launched Electron often lacks ~/.local/bin (where agent-vm/limactl
 install), so PATH augmentation and line-streamed output are pure process concerns, kept apart from VM orchestration.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

export interface RunVmCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Line-streamed callback for child stdout/stderr (rendered directly in the VM boot panel). */
  onLine?: (line: string, source: "stdout" | "stderr") => void;
}

export interface RunVmCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Augment PATH with common agent-vm/limactl install locations so a GUI launch does not fail with ENOENT. */
export function buildVmProcessEnv(): NodeJS.ProcessEnv {
  const extraPaths = [path.join(homedir(), ".local", "bin"), "/usr/local/bin", "/opt/homebrew/bin"];
  const currentPaths = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const merged = [...currentPaths];
  for (const entry of extraPaths) {
    if (!merged.includes(entry)) {
      merged.push(entry);
    }
  }
  return { ...process.env, PATH: merged.join(path.delimiter) };
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function runVmCommand(
  command: string,
  args: string[],
  options: RunVmCommandOptions = {},
): Promise<RunVmCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: buildVmProcessEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        code: -1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutCarry = "";
    let stderrCarry = "";
    let timedOut = false;
    let settled = false;

    const emitLines = (chunk: string, source: "stdout" | "stderr") => {
      const carry = source === "stdout" ? (stdoutCarry += chunk) : (stderrCarry += chunk);
      const lines = carry.split("\n");
      const rest = lines.pop() ?? "";
      if (source === "stdout") {
        stdoutCarry = rest;
      } else {
        stderrCarry = rest;
      }
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed.length > 0 && options.onLine) {
          options.onLine(trimmed, source);
        }
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      emitLines(text, "stdout");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      emitLines(text, "stderr");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const settle = (result: RunVmCommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.once("error", (error) => {
      settle({
        code: -1,
        stdout,
        stderr: `${stderr}${stderr.length > 0 ? "\n" : ""}${error.message}`,
        timedOut,
      });
    });
    child.once("close", (code) => {
      if (options.onLine && stdoutCarry.trim().length > 0) {
        options.onLine(stdoutCarry.trimEnd(), "stdout");
      }
      if (options.onLine && stderrCarry.trim().length > 0) {
        options.onLine(stderrCarry.trimEnd(), "stderr");
      }
      settle({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

export function describeCommandFailure(command: string, result: RunVmCommandResult): string {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const suffix = output.length > 0 ? `: ${output.slice(0, 2000)}` : "";
  return result.timedOut
    ? `${command} timed out after exceeding the limit${suffix}`
    : `${command} failed with exit code ${result.code}${suffix}`;
}
