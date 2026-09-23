# Plan: VM resource specs — per-project sizing with host-aware defaults

**Goal.** Let each project VM be sized (memory / CPUs / disk) without giving
up the zero-friction happy path: the default flow stays "pick folder → done";
customization appears exactly once — after the folder is picked, only when
the VM doesn't exist yet — backed by real host numbers. Existing VMs can be
resized later from the sidebar row, with recreate semantics stated plainly.

**Scope note.** Fork material, same as the Open-in-VM plan it extends
(`docs/plan-open-in-vm.md`, implemented 2026-09-23). No global settings page
in this slice — specs live on the workspace's `vm` marker; a settings-level
default remains a future option if the per-project field proves insufficient.

---

## 1. Verified current state (2026-09-23, this fork)

Facts pinned from the CLI / running system during the Open-in-VM E2E:

| # | Fact | Evidence |
|---|---|---|
| 1 | agent-vm takes creation-time spec flags on its VM commands: `--disk GB` (default 10), `--memory GB` (default 3), `--cpus N` (default 1), plus `--reset` (destroy + re-clone from template) | `agent-vm --help` "VM options (for claude, …, shell, run)" |
| 2 | Specs are baked into the Lima instance at creation; later runs keep the instance config. Changing specs = recreate (`--reset` re-clones; the pin must then be re-applied, same as the create branch) | Lima instance model; vmup README "port re-derived after rm/--reset" |
| 3 | The app's provider currently spawns `agent-vm shell -c true` without flags → always defaults (3 GB / 1 CPU / 10 GB) | `vmRuntimeProvider.ts` `startVm`, create branch |
| 4 | `limactl list --format` exposes per-VM CPUs / Memory / Disk — enough to compute "committed by running VMs" | ran: `agent-vm-automation… 1 3221225472 32212254720` |
| 5 | Host reality on this machine: **15 GB total RAM, ~4 GB available right now, 12 CPUs, 42 GB free on /home** — one default VM is a fifth of the host; sizing blind is easy to get wrong | `free -g`, `nproc`, `df -BG /home` |
| 6 | `vmStatus` already distinguishes "VM doesn't exist" (`state: "none"`) — the exact gate the customize panel needs | `vmRuntimeProvider.status`, E2E-verified |
| 7 | The `vm` marker `{provider, vmName}` rides the target through connect, persist (`validation.ts` + `validationAppSettings.ts` zod), snapshot round-trip (`remoteWorkspaceHistory.ts` copies the object wholesale) — optional sibling fields ride along once the schemas allow them | implemented + E2E-persisted entries |
| 8 | VM-mode dialog owns the flow after folder pick (`SSHDialog` `vmWorkspacePath`, auto-start effect); first-create already has a visible "this takes minutes" boot phase where a pre-boot panel fits naturally | E2E screenshots (boot log panel) |

## 2. Design

**Principle: defaults first; ask exactly once, where it matters, with the
real budget on screen.** Owner of VM truth stays `vmRuntimeProvider`
(desktop main); renderer only renders what it's told.

### 2.1 Spec shape (shared)

Extend `RemoteVmTargetInfo` (all optional; absent = agent-vm default):

```ts
interface RemoteVmTargetInfo {
  provider: "agent-vm";
  vmName: string;
  memoryGb?: number; // 1..8
  cpus?: number;     // 1..(host logical CPUs)
  diskGb?: number;   // 5..60
}
```

- Zod: same three optional ints with bounds in BOTH `sshConnectOptionsSchema`
  (`validation.ts`) and the persisted ssh arm (`validationAppSettings.ts`).
  Snapshot/persist code needs no change (fact #7).
- Reconnect ignores spec fields (VM exists ⇒ specs immutable; see 2.5 for
  the change-later path).

### 2.2 Host resources query (provider → one IPC)

`vmRuntimeProvider.hostResources()` → `{ totalMemoryGb, availableMemoryGb,
logicalCpus, diskFreeGb, runningVms: [{vm, memoryGb, cpus}] }` where
`availableMemoryGb` = host available (os.freemem + reclaimable, use
`/proc/meminfo MemAvailable` on Linux, `os.freemem` fallback) **minus** the
sum of memory committed by *running* lima VMs (fact #4). Disk via
`fs.statfs` on the Lima store's filesystem (`~/.lima`). Cheap, computed
per-call, cached ≤5 s. New channel `VmHostResources` (no request payload) +
`IPlatformService.vmHostResources?` + preload/typing, mirroring the
existing three.

### 2.3 ensureUp carries a spec (create branch only)

`VmEnsureUpRequest` gains optional `spec?: {memoryGb?, cpus?, diskGb?}`.
The create branch spawns
`agent-vm --memory N --cpus N --disk N shell -c true` (flags only for
provided fields). If the VM already exists the spec is ignored and one log
line says so ("VM exists; keeping 3 GB / 1 CPU"). All other branches
unchanged; single-flight, banner wait, alias rewrite stay as-is.

### 2.4 Dialog: pre-boot panel on first create only

In VM mode, before auto-starting, the dialog calls `vmStatus` (fast path is
the existing quick query):

- **VM exists** (stopped/running) → today's behavior unchanged: auto-boot
  straight into the Connecting step. Zero new clicks.
- **state === "none"** (first create) → render a compact **pre-boot panel**
  as the leading phase of the connecting step (no new wizard step; the
  stepper stays 4):

```
  New sandbox VM for ~/github/<project>
  ─────────────────────────────────────
  Host: 4.1 GB available of 15 GB   ·   12 CPUs   ·   42 GB disk free
        (1 running VM holds 3 GB)
  Default: 3 GB RAM · 1 CPU · 10 GB disk          [Customize ▾]

  ┌ Customize (collapsed by default) ──────────────────────┐
  │  RAM [3] GB   CPUs [1]   Disk [10] GB                  │
  │  ⚠ exceeds available memory (4.1 GB) — VM may thrash   │
  └─────────────────────────────────────────────────────────┘

                      [ Cancel ]   [ Start VM ]
```

  - Values default to agent-vm defaults; the resource line is always visible
    (uncollapsed) so even non-customizing users see what they're taking.
  - Warning (amber, non-blocking) when memory > available or cpus > logical;
    hard clamp only at schema bounds (2.1).
  - "Start VM" → `vmEnsureUp({workspacePath, requestId, spec})` → existing
    Connecting phase. The returned endpoint's target keeps the chosen spec
    on its `vm` marker (dialog attaches what it sent — the fields it owns).
  - Auto-start effect change: fire immediately only when `vmStatus.state !==
    "none"`; otherwise wait for the button. Guard the extra async hop
    (loading state "Checking VM…") so the panel never flashes for existing
    VMs.

### 2.5 Change later: row menu "VM settings…"

For VM-backed rows, the ⋯ menu gains **VM settings…** (between Stop VM and
Remove; enabled regardless of run state):

1. Panel shows the VM's *actual current* specs (new field on `vmStatus`:
   read CPUs/Memory/Disk from `limactl list` for this VM) + host resources
   line (2.2) + the mounted-folder note.
2. Editing any spec changes the button to **Apply — re-creates this VM**,
   with copy: "Re-clone from the base template with the new size. Everything
   outside the mounted project folder inside the VM is reset."
3. Apply → new provider op `reconfigure(workspacePath, spec)`:
   `agent-vm --memory N --cpus N --disk N --reset shell -c true` →
   stop → re-pin port (fresh instance loses the pin) → start → SSH banner
   wait → refresh alias. Reuses ensureUp's single-flight map. The persisted
   marker's spec fields are updated by the caller on success.
4. Dismissal of the confirm uses the existing confirm-dialog component.

### 2.6 i18n

en-US + zh-CN: `vm.specs.title`, `vm.specs.hostLine` (parameterized),
`vm.specs.customize`, `vm.specs.memory`/`cpus`/`disk`, `vm.specs.overMemory`,
`vm.specs.overCpus`, `vm.specs.startVm`, `vm.specs.checkingVm`,
`workspaceSidebar.vmSettings`, `vm.specs.applyRecreate`,
`vm.specs.recreateWarning`, `vm.specs.current`.

## 3. Workstreams / slices

- **Slice 1 — spec plumbing + host resources**: shared fields + schemas,
  `hostResources()` + channel + bridge, `ensureUp(spec)` create-branch
  flags. Verified by a CLI-shaped call (`window.zcode.vmEnsureUp` with spec
  on a fresh dir → `limactl list` shows chosen sizes).
- **Slice 2 — pre-boot panel in the dialog**: vmStatus gate, panel UI,
  warning logic, Start button, spec attached to the target marker.
- **Slice 3 — change later**: `vmStatus` spec fields, ⋯-menu entry, settings
  panel, `reconfigure()` op with re-pin, marker update on success.

## 4. Risks / open questions

- **R1 Wrong available-RAM source**: `os.freemem()` ignores reclaimable
  cache and understates reality on Linux; use `/proc/meminfo`
  `MemAvailable` first, fallback `os.freemem`. Overhead of running-VM sum
  must use committed (allocated) sizes, not guest usage (fact #4's columns).
- **R2 Recreate data loss messaging**: `--reset` wipes VM-local state
  outside the mount. The warning copy must say exactly that; the mounted
  project folder is untouched (live mount on the host).
- **R3 Pin after reset**: re-clone yields a fresh `lima.yaml`; port must be
  re-pinned or the alias points at a stale port. Reuse the create-branch
  pin sequence inside `reconfigure` (stop → pin → start) — covered by test.
- **R4 Dialog latency for existing VMs**: the extra `vmStatus` hop before
  auto-start must not regress the reconnect-fast-path feel; keep the probe
  under the existing quick-query path and render "Checking VM…" only if it
  exceeds ~300 ms (it won't).
- **R5 Spec drift between marker and instance**: marker may disagree with
  the instance (manual `agent-vm --reset` from terminal). `vmStatus` always
  reports instance truth; the settings panel reads it, never the marker.
- **R6 Disk shrink**: Lima disks grow, they don't shrink — lowering diskGb
  later is cosmetic until recreate; panel should disable lowering disk below
  current usage note (accept simple "cannot shrink" copy for v1).

## 5. Acceptance scenarios (per slice)

- **S1**: `vmEnsureUp` with `{memoryGb: 5, cpus: 2, diskGb: 20}` on a fresh
  dir → VM created; `limactl list` shows `2 5368709120 21474836480`; entry
  marker carries the spec; defaults path (no spec) unchanged.
- **S2**: Open-folder-in-VM on a fresh dir shows the panel with a true host
  line (matches `free -g` + running-VM commitments); collapsed Customize;
  Start boots with chosen spec; on an existing VM no panel, no extra click.
  Over-memory input shows amber warning, does not block.
- **S3**: ⋯ → VM settings shows instance-true specs; changing RAM to 5 and
  Apply recreates (port re-pinned, alias fresh, workspace reconnects);
  cancel leaves everything untouched.
- **Gates**: `pnpm typecheck` + `pnpm lint` + `architecture:check --changed`
  clean; E2E on real VMs for S1–S3 (create-with-spec needs one fresh dir;
  recreate test tolerates the clone time).

## 6. Explicitly out of scope (v1)

- Global default specs in app settings (revisit if per-project feels thin).
- Per-run spec overrides, offline/readonly toggles (agent-vm already offers
  them in terminal; surfacing every flag would recreate the wizard we
  removed).
- Live resize without recreate (Lima doesn't support it).
