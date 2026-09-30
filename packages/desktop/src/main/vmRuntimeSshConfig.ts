/**
 * Maintenance of the agent-vm managed alias block in ~/.ssh/config (used by vmRuntimeProvider).
 *
 * The block markers (# BEGIN/END agent-vm alias: <alias>) are byte-identical to the vmup script:
 both the standalone CLI and this app write the same VM; identical markers prevent stale ports from lingering (R6).
 */
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { VmRuntimeEndpoint } from "@zcode/shared";

const SSH_CONFIG_PATH = path.join(homedir(), ".ssh", "config");
const SSH_BLOCK_BEGIN_PREFIX = "# BEGIN agent-vm alias: ";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildSshAliasBlock(
  alias: string,
  endpoint: Pick<VmRuntimeEndpoint, "host" | "port" | "username" | "privateKeyPath">,
): string {
  return [
    `${SSH_BLOCK_BEGIN_PREFIX}${alias}`,
    `Host ${alias}`,
    `  HostName ${endpoint.host}`,
    `  Port ${endpoint.port}`,
    `  User ${endpoint.username}`,
    `  IdentityFile ${endpoint.privateKeyPath}`,
    "  IdentitiesOnly yes",
    // ssh keeps the first value it obtains: without this line a ForwardAgent yes under Host * elsewhere in the
    // user's file would forward the SSH agent into the VM — the exact leak agent-vm's model exists to prevent.
    "  ForwardAgent no",
    "  StrictHostKeyChecking no",
    "  UserKnownHostsFile /dev/null",
    "  ServerAliveInterval 30",
    "  ControlMaster auto",
    "  ControlPath ~/.ssh/cm-%r@%h:%p",
    "  ControlPersist 10m",
    `# END agent-vm alias: ${alias}`,
  ].join("\n");
}

/** Remove the old block and rewrite with the fresh port via temp-file + rename so a partial write cannot break the alias. */
export async function refreshSshConfigAlias(
  alias: string,
  endpoint: Pick<VmRuntimeEndpoint, "host" | "port" | "username" | "privateKeyPath">,
): Promise<void> {
  const beginMarker = `${SSH_BLOCK_BEGIN_PREFIX}${alias}`;
  const endMarker = `# END agent-vm alias: ${alias}`;
  let existing = "";
  try {
    existing = await fs.readFile(SSH_CONFIG_PATH, "utf8");
  } catch {
    await fs.mkdir(path.dirname(SSH_CONFIG_PATH), { recursive: true });
    await fs.chmod(path.dirname(SSH_CONFIG_PATH), 0o700);
  }

  const blockPattern = new RegExp(
    `[\\n^]*${escapeRegExp(beginMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}[\\n]?`,
    "g",
  );
  const cleaned = existing.replace(blockPattern, "").replace(/\n{3,}$/, "\n");
  const nextContent = `${cleaned}${cleaned.endsWith("\n") || cleaned.length === 0 ? "" : "\n"}\n${buildSshAliasBlock(alias, endpoint)}\n`;

  const tempPath = `${SSH_CONFIG_PATH}.zcode-vm.tmp`;
  await fs.writeFile(tempPath, nextContent, { mode: 0o600 });
  await fs.rename(tempPath, SSH_CONFIG_PATH);
}
