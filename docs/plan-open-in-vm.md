# Plan: "Open in VM" — native agent-vm/Lima runtime in the desktop app

**Goal.** Make per-project sandbox VMs a first-class workspace runtime in the
desktop app: from the new-workspace flow, choosing a folder offers
**Local / VM**; Reconnect auto-starts a stopped VM; the sidebar shows VM state
and can stop it. The terminal dance (`cd <project> && vmup`, wait, then
Remote-Connection wizard → pick alias → connect) disappears.

**Scope note.** This is fork material, not an upstream slice (it depends on a
personal tool chain: agent-vm → Lima). vmup itself (created today, a thin
120-line wrapper) is merged into the app as native TypeScript rather than
required as an external tool. Keep it off the upstream PR slices for the
browser relay.

**VM toolchain layers:** vmup (merged into this repo, see 2.1) → `agent-vm`
(github.com/sylvinus/agent-vm, external CLI) → Lima (`limactl`) → QEMU/KVM.
The app calls `agent-vm` / `limactl` directly and owns the
alias/port/ssh-config orchestration itself. The original standalone `vmup` script
stays as an optional terminal CLI (private repo, not published); both writers must keep the
ssh-config managed-block markers (and the port-pin algorithm) identical so
they remain interchangeable.

---

## 1. Verified current state (2026-09-22, this fork)

The manual flow we are replacing, end to end:

1. `cd ~/github/<project> && vmup` — creates/starts the project VM, pins the
   SSH port, rewrites the `~/.ssh/config` alias block. Idempotent no-op when
   already up. Output tells the user which alias to pick.
2. ZCode: Projects **+** → Remote Connection → SSH → pick alias
   `vm-<project>` (wizard auto-fills host/port/user/key) → connect → wait for
   one-time server provisioning → select the project dir as workspace.

Facts pinned in this repo / on this machine:

| #   | Fact                                                                                                                                                                              | Evidence                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Everything the wizard fills is derivable from the folder path alone: alias `vm-<basename>`, host `127.0.0.1`, port (pinned), user `$USER`, key `~/.lima/_config/user`             | `vmup` script: alias derivation ~line 30, port pin `46000 + hash%1000` lines 17–53, managed `~/.ssh/config` block lines 89–112                                                                       |
| 2   | The port is deterministic per path and survives stop/start AND `rm`/recreate; collisions are nudged +1 (so reconnect must re-read it, not trust a frozen value)                   | vmup README "How the fixed port works"                                                                                                                                                               |
| 3   | `RemoteTarget` (the connect contract) is a tagged union with SSH fields `host/port/username/sshConfigAlias/privateKeyPath/assetInstallMode`                                       | `packages/shared/src/remoteTarget.ts:4-28`                                                                                                                                                           |
| 4   | The renderer bridge exposes `connectRemote(target, requestId, context)` — the wizard only exists to produce that object                                                           | `packages/desktop/src/preload/index.ts:247`                                                                                                                                                          |
| 5   | Persisted workspace entries already carry the full target (`remote:ssh:127.0.0.1:<port>:<user>:<path>` + target object) and reconnect through it                                  | `~/.zcode/v2/setting.json` `lastWorkspaceSession[]`; reconnect flow `packages/ui/src/root/useRemoteWorkspaceHistory.ts` (`runReconnectRemoteWorkspace` ~902, `handleReconnectRemoteWorkspace` ~1035) |
| 6   | A live per-line connect log surface exists and is where VM boot output belongs                                                                                                    | `onRemoteConnectionLog` (preload ~311), rendered in the reconnect panel                                                                                                                              |
| 7   | The app already enumerates SSH config aliases (would show all `vm-*` entries)                                                                                                     | `listSSHConfigAliases` → `packages/desktop/src/main/desktopRuntimeEnv.ts:109`                                                                                                                        |
| 8   | Sidebar workspace rows already render per-row actions (the `Reconnect` button used during the relay E2E)                                                                          | `packages/ui/src/WorkspaceSidebarItem.tsx` (~430)                                                                                                                                                    |
| 9   | VM states are queryable host-side: `limactl list --format '{{.Name}} {{.Status}}'`, port from `~/.lima/<vm>/lima.yaml` `ssh.localPort`, vm name via `agent-vm name` (cwd-derived) | vmup script internals                                                                                                                                                                                |
| 10  | Deliberate constraint: VMs never auto-start on boot; starts are per-action, on demand (a running VM holds its 3 GiB whether used or not)                                          | vmup README "After a reboot"                                                                                                                                                                         |

## 2. Design

**Principle: app = orchestrator + UI, vmup = single source of truth.**

### 2.1 Native orchestration (port of vmup into this repo)

No `vmup --json` patch and no dependency on the external script: the provider
implements vmup's algorithm in TypeScript, spawning `agent-vm` / `limactl`
directly. Ported contract (reference: the vmup script, lines 17–112):

- vm name: `agent-vm name <dir>` (stays authoritative — names must remain
  compatible with the agent-vm CLI used from the terminal); `hash8` = the last
  `-` segment of the name (first 8 hex of sha256(abs-path)).
- alias: `vm-<basename sanitized to [a-zA-Z0-9-]>`.
- port pick: `46000 + (parseInt(hash8, 16) % 1000)`, nudged +1 (wrapping
  within the 1000-port span) while the port is listening (`ss` — Linux-first;
  fall back to a TCP connect-probe where unavailable) or pinned in any
  _other_ `~/.lima/*/lima.yaml` `ssh.localPort`.
- lifecycle: `agent-vm shell -c true` both creates (clone) and starts; the pin
  rides the same command as `--ssh-port <p>` (agent-vm ≥0.2.0 writes
  `.ssh.localPort` itself — at clone time on create/`--reset`, or on the
  stopped instance right before start). The app never writes `lima.yaml`
  directly. Never pass a differing `--ssh-port` while the VM runs: agent-vm
  prompts on /dev/tty and silently aborts to "current settings" without a
  TTY. Branches (same three as the script): create → one command
  (create+pin+start) / stopped-unpinned → one command (pin+start) /
  running-unpinned → stop → that command. agent-vm also refuses a port
  another VM already holds, so a failed pick surfaces as a command error.
- read-back: parse the last `ssh.localPort` from `~/.lima/<vm>/lima.yaml` —
  the source of truth, never the computed value.
- ssh config: rewrite the `# BEGIN/END agent-vm alias: <alias>` managed block
  in `~/.ssh/config` with the fresh port — same markers as the script, so the
  standalone CLI and the app never fight over stale blocks. The block sets
  `ForwardAgent no`: ssh takes the first obtained value, so without it a
  `ForwardAgent yes` under `Host *` elsewhere in the user's file would
  forward the SSH agent into the VM — the leak agent-vm's model exists to
  prevent (agent-vm README guidance; the vmup script should grow the same
  line to keep blocks interchangeable).

The provider resolves `{vm, alias, host:"127.0.0.1", port, user, key, state}`
with `state` ∈ `none|creating|starting|running|stopped` (from `agent-vm info`

- `limactl list`). Idempotency unchanged: `ensureUp` is a safe pre-connect
  step even when already up.

### 2.2 Host-side VM provider (new module in this repo)

`packages/desktop/src/main/vmRuntimeProvider.ts` (main process — needs
`child_process` + `fs` on `~/.lima`):

- `status(workspacePath)` → `{state, alias, port, vm}` — cheap; `agent-vm info`
  (machine-readable key=value lines) + read `localPort` from
  `~/.lima/<vm>/lima.yaml`.
- `ensureUp(workspacePath, {onLog})` → run the 2.1 sequence, streaming
  `agent-vm` / `limactl` stdout lines into `onLog` (wired to the existing
  remote-connection log channel), resolve the final result object.
  Long-running by design (first create: minutes; start: ~30 s; running:
  instant).
- `stop(workspacePath)` → `agent-vm stop` (spawned with cwd = workspacePath;
  port stays pinned).
- `isVmBacked(target)` → bool (see 2.4).

Availability gate: `agent-vm` + `limactl` on PATH (`command -v`); absent ⇒ VM
option hidden / shows a one-line setup hint linking the agent-vm setup README. Never fatal. A `vmup` binary is NOT required.

IPC surface: bridge methods in the preload alongside `connectRemote`
(fact #4) — e.g. `vmStatus` / `vmEnsureUp` / `vmStop` — with ensureUp log
lines piggybacking on the existing `onRemoteConnectionLog` channel (fact #6),
scoped by the same requestId the reconnect/connect flow already uses.

### 2.3 Folder flow: Local / VM

In the new-workspace flow, after a folder is picked, offer runtime location
(**Local** | **VM — isolated Linux (agent-vm)**). VM branch:

1. `ensureUp(path)` with progress streamed into the connect panel ("Creating
   VM… / Pinning SSH port… / Starting…"). First-ever run must set expectation
   (~minutes; template build is a one-time prerequisite done outside the app).
2. Build the `RemoteTarget` directly from the returned JSON
   (`{kind:"ssh", host, port, username, sshConfigAlias, privateKeyPath,
assetInstallMode:"local-download-upload"}`) and call the existing
   `connectRemote` path. The SSH wizard is skipped entirely.
3. The workspace path equals the host path (live mount, same-path by design).

### 2.4 Reconnect auto-start + endpoint freshness

Persist VM-backedness on the workspace entry: extend `SSHConnectOptions` with
optional `vm?: {provider:"agent-vm"; vmName: string}` (schema change — see
R2). On Reconnect for a VM-backed target:

1. `ensureUp(path)` first, streaming boot lines into the reconnect panel
   (turns "After a reboot: vmup + refresh" into one click — the click IS the
   on-demand command, consistent with constraint #10).
2. **Always re-read the port** from the vmup result before connecting
   (collision nudges can move it after recreation). Update the stored target
   with the fresh port, then connect as today.

Bulk/lazy auto-start (on app launch, or starting every listed workspace)
stays forbidden — per-action only.

### 2.5 Sidebar: state + stop

Workspace rows for VM-backed targets show a VM state badge
(`none/creating/starting/running/stopped`, from `status()`, refreshed with the
connection status it already tracks) and a row action **Stop VM** (confirm;
calls `stop()`). `agent-vm rm` stays out of the app for now — destructive,
terminal-only.

## 3. Workstreams / slices

**状态 2026-09-23：全部实现并通过 E2E（见 §5）。** 资源规格（RAM/CPU/磁盘）
定制为后续独立计划：`docs/plan-vm-specs.md`。

- **Slice 1 — reconnect auto-start** (highest daily value, smallest UI):
  provider module including the native vmup port (2.1) + IPC surface (2.2) +
  VM marker in target + ensureUp hook in `runReconnectRemoteWorkspace` +
  port re-read + log streaming. No new dialogs.
  Acceptance: stopped VM + Reconnect ⇒ boots with streamed log, stored port
  refreshed if it moved, then connects; running VM ⇒ instant connect, no
  restart; `agent-vm` absent ⇒ today's direct-connect path unchanged; two
  windows on one VM ⇒ serialized (R5).
- **Slice 2 — Local/VM choice** in the new-workspace flow +
  create-with-progress.
  Acceptance: pick folder → VM branch → progress panel → connected workspace
  at the same path; the SSH wizard is never shown.
- **Slice 3 — polish**: sidebar badge + Stop, `agent-vm`/`limactl` version
  diagnostics, optional "Open VM shell" (system terminal on the alias).
  Acceptance: badge tracks the live limactl state; Stop asks once and frees
  the VM (port stays pinned).

Verification per slice: `pnpm typecheck` + `pnpm lint`; Slices 1–2 additionally
get a manual E2E against the real test VM (§5) — stop it, Reconnect, watch the
log panel.

## 4. Risks / open questions

- **R1 Long first run**: VM clone takes minutes with little structured
  progress; stream raw agent-vm/limactl lines and set copy expectations.
  Template build (one-time ~10 min) stays a documented prerequisite, not app
  functionality.
- **R2 Schema ripple**: adding `vm` to `SSHConnectOptions` must pass the zod
  target validation used on save/reconnect and not leak into upstream-merged
  code paths awkwardly (keep the field optional + provider-tagged).
- **R3 Whitespace paths**: Lima can't mount them (vmup errors out) — surface
  the vmup error verbatim in the log panel rather than pre-validating.
- **R4 Process lifetime**: app quit mid-`ensureUp` (child `agent-vm` /
  `limactl` processes) — kill the child tree on window close, or spawn
  detached; a half-pinned port is benign because the next `ensureUp`
  re-verifies and re-pins (ported script behavior, unchanged).
- **R5 Multi-window / same VM**: two windows reconnecting one VM — provider
  must serialize `ensureUp` per vmName (single-flight map).
- **R6 Dual writers**: the standalone `vmup` script may still be run from a
  terminal against the same VMs — the TS port must keep the port-pin
  algorithm and the ssh-config managed-block markers byte-compatible, or the
  two writers fight over stale ports/aliases.
- **R7 Dev CDP port conflict (found in E2E)**: Lima's default port-forward
  grabs host `127.0.0.1:9229` when an agent-vm VM starts, and the dev app
  hardcodes `remote-debugging-port=9229` (`main/index.ts`). Whoever binds
  first wins — start the dev app before VMs, or the renderer loses CDP.
- **R8 sshd readiness race (found in E2E)**: `agent-vm shell -c true`
  returning does NOT mean the guest sshd is accepting connections on the
  pinned port; an immediate `connectRemote` got "远程连接已断开 exitCode=-1".
  `ensureUp` now waits for the SSH banner on the pinned port (≤90 s) before
  delivering the endpoint.

## 5. Session quick-start (environment hard-won on 2026-09-22)

**2026-09-23 implementation record.** Files: shared
`vmRuntime.ts` + `vm` field on SSH target/snapshot (validation.ts,
validationAppSettings.ts, protocol.ts, remoteTarget.ts) + 3 channels
(channels.ts) + `IPlatformService.vm{Status,EnsureUp,Stop}` (platform.ts);
desktop main `vmRuntimeProvider.ts` (+ `vmRuntimeProcess/Port/SshConfig.ts`
split for the 400-line rule) + `desktopVmIpc.ts` (logs ride the existing
`RemoteConnectionLog` channel, requestId-scoped); preload bridge +
`client/globals.d.ts` typing + renderer `desktopPlatform.ts`; UI reconnect
hook (`reconnectRemoteWorkspaceHistoryEntry.ts` + `lib/vmRuntime.ts`),
SSHDialog VM mode (`vmWorkspacePath` → auto ensureUp → connect → same-path
auto workspace select), "+" menu "Open folder in VM" (App →
WorkspaceShellLayout → WorkspaceSidebar), sidebar Box icon + state badge +
"Stop VM" menu action with confirm, i18n en/zh.

E2E (dev app + real VMs, CDP-driven): vmStatus running/stopped ✓; reconnect
auto-start from stopped VM (demo + automation) boots VM, waits for SSH
banner, connects, persists `vm` marker + re-read port ✓; reconnect fast path
on running VM (no restart) ✓; badge stopped→running→stopped transitions ✓;
UI Stop VM with confirm dialog stops VM (~10 s) and refreshes badge ✓;
"+" menu item renders ✓.

**Full "Open folder in VM" happy path executed 2026-09-23** (GTK portal
dialog driven via AT-SPI + `portals.conf` pinned to the gtk backend for the
test, reverted after): + → Open folder in VM → pick `~/github/automation` →
dialog auto-boots the stopped VM with streamed `==>` log lines in the
Connecting step, SSH wizard never shown → workspace opens at the same path,
entry persisted with marker + port 34345 ✓. **First-create branch also
executed** on a fresh dir (`~/github/vm-fresh-create-e2e`): clone → stop →
pin (46343, nudged past other VMs' pins) → start → first-run asset upload →
connected workspace at the same path ✓. Found & fixed during this run: the
VM-mode auto-start guard (`vmFlowStartedRef`) wasn't reset when the flow
completed via auto-select, so a second Open-in-VM opened a blank dialog —
now reset on completion and on path change (SSHDialog). Multi-window
single-flight (R5) remains implemented-but-not-E2E'd.

**2026-09-30 pin write path + ForwardAgent hardening.** agent-vm 0.2.0 made
`--ssh-port N` first-class (applied at clone time on create/`--reset`, or on a
stopped instance before start; prompt-and-abort on a running VM without a
TTY — never pass it while running). `pinVmPort` (direct `limactl edit` write
into `lima.yaml`) is gone; port selection (`pickPinnedPort`) stays ours and
the value rides the agent-vm command. Sequences shrink: create and
stopped-unpinned become one command (create+pin+start / pin+start),
running-unpinned keeps its stop first, and reconfigure's stop→re-pin→start
tail collapses into the `--reset` command itself. The managed alias block
gains `ForwardAgent no` (first-obtained-value wins against `Host *`; without
it the user's SSH agent would be forwarded into the VM — agent-vm README
guidance). vmup (private script) should mirror the line to keep rewritten
blocks identical.

- After rebasing onto a new upstream version, re-run
  `node scripts/prepare-prebuilds.mjs` BEFORE any VM connect E2E: mock-cdn
  staging carries the zcode-server bundle the app deploys, and a stale
  release deploys an old server that crashes on new host-side RPC events
  (verified 2026-09-25: a 3.14.0-era bundle without the browser-relay event
  killed the remote server mid-connect, and the poisoned window Host then
  hung every later connect in that app session — fresh launch works).
- Node: `PATH=$HOME/.local/share/nodejs/node-v24.14.0-linux-x64/bin:$PATH`
  (repo pins 24.14.0 via mise.toml; system node 22 breaks vite config load).
- Run: `pnpm run dev:desktop` — NEVER `dev:desktop:remote-prod` (pushes
  unpatched CDN server to VMs). Dev app speaks CDP on `127.0.0.1:9229`;
  driver helper: `~/github/zcode-dev-cdp.mjs`.
- Real test VM: `agent-vm-automation-623dafe2` (ssh
  `-i ~/.lima/_config/user -p 34345 $USER@127.0.0.1`); fleet via `agent-vm list`.
- Browser-relay work state (done, E2E-verified): see
  an internal status doc (not published).
