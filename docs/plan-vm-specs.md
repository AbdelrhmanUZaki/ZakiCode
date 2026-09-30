# Plan: VM resource specs — per-project sizing with host-aware defaults

**状态 2026-09-23：S1–S3 全部实现并通过 E2E（记录见文末）。**

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

| #   | Fact                                                                                                                                                                                                                                                                              | Evidence                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | agent-vm takes creation-time spec flags on its VM commands: `--disk GB` (default 10), `--memory GB` (default 3), `--cpus N` (default 1), plus `--reset` (destroy + re-clone from template)                                                                                        | `agent-vm --help` "VM options (for claude, …, shell, run)"          |
| 2   | Specs are baked into the Lima instance at creation; later runs keep the instance config. Changing specs = recreate (`--reset` re-clones; the pin must then be re-applied, same as the create branch)                                                                              | Lima instance model; vmup README "port re-derived after rm/--reset" |
| 3   | The app's provider currently spawns `agent-vm shell -c true` without flags → always defaults (3 GB / 1 CPU / 10 GB)                                                                                                                                                               | `vmRuntimeProvider.ts` `startVm`, create branch                     |
| 4   | `limactl list --format` exposes per-VM CPUs / Memory / Disk — enough to compute "committed by running VMs"                                                                                                                                                                        | ran: `agent-vm-automation… 1 3221225472 32212254720`                |
| 5   | Host reality on this machine: **15 GB total RAM, ~4 GB available right now, 12 CPUs, 42 GB free on /home** — one default VM is a fifth of the host; sizing blind is easy to get wrong                                                                                             | `free -g`, `nproc`, `df -BG /home`                                  |
| 6   | `vmStatus` already distinguishes "VM doesn't exist" (`state: "none"`) — the exact gate the customize panel needs                                                                                                                                                                  | `vmRuntimeProvider.status`, E2E-verified                            |
| 7   | The `vm` marker `{provider, vmName}` rides the target through connect, persist (`validation.ts` + `validationAppSettings.ts` zod), snapshot round-trip (`remoteWorkspaceHistory.ts` copies the object wholesale) — optional sibling fields ride along once the schemas allow them | implemented + E2E-persisted entries                                 |
| 8   | VM-mode dialog owns the flow after folder pick (`SSHDialog` `vmWorkspacePath`, auto-start effect); first-create already has a visible "this takes minutes" boot phase where a pre-boot panel fits naturally                                                                       | E2E screenshots (boot log panel)                                    |

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
  cpus?: number; // 1..(host logical CPUs)
  diskGb?: number; // 5..60
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
`availableMemoryGb` is the kernel's MemAvailable (`/proc/meminfo` on Linux,
`os.freemem` fallback) — the kernel already excludes unreclaimable
(incl. in-use VM) memory from it, so committed VM allocations are NOT
subtracted again (double-subtracting misreported healthy hosts as 0.0 GB);
the running VMs' committed sizes ride along in `runningVms` as context.
Disk via `fs.statfs` on the Lima store's filesystem (`~/.lima`). Cheap,
computed per-call, cached ≤5 s. New channel `VmHostResources` (no request
payload) + `IPlatformService.vmHostResources?` + preload/typing, mirroring
the existing three.

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

1. Panel shows the VM's _actual current_ specs (new field on `vmStatus`:
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

### 2.7 Live host-resources line (poll while a decision panel is open)

The host line is an indefinite wait-for-the-user surface: the first-create
panel blocks on a button, VM settings blocks on Apply. A one-shot snapshot
(taken once in `bootstrapVmFlow` / on dialog open) goes stale exactly when
the panel is used deliberately — user sees low memory, frees some, then
sizes the VM against a number that never moved. While a panel is open the
UI therefore polls `vmHostResources` every 5 s, matched to the main
process's TTL cache: repeats inside the TTL are free, each poll past it is
a fresh build (`limactl list` + `/proc/meminfo` + `statfs`, all cheap).

- **Single owner, single write path (unchanged).** `SSHDialog`'s
  `vmSpecPanel.hostResources` stays the only wizard-side state; the poll
  hook holds no snapshot of its own and delivers each result via callback,
  so `setVmSpecPanel` remains the sole writer. `VmSettingsDialog` polls
  into its existing `hostResources` state the same way. The initial
  `bootstrapVmFlow` fetch stays — it gates whether the panel shows at all.
- **Shape**: `packages/ui/src/hooks/vmHostResourcesPoller.ts` is a
  React-free controller (immediate first fetch, `setInterval`, in-flight
  guard serializes requests, disposed flag drops late results, errors log
  and continue) so node:test covers the behavior without a React harness;
  `useVmHostResources` is the thin hook wrapper and no-ops when
  `platform.vmHostResources` is absent (web, old preload).
- **Lifecycle**: polling is active only while the panel is open (wizard
  step mounted / settings dialog open); Start, cancel, and close all flip
  the enabled flag and the interval is cleared with it.
- **Deliberate divergence** from `useVmRuntimeStatus`'s documented
  non-polling stance: that data's refresh owner is desktop main; here the
  open panel is the refresh owner, and a push channel for a
  minutes-lived dialog would be over-engineering.
- No i18n changes (same `vm.specs.hostLine`), no main-process or protocol
  changes, no "last updated" stamp (5 s cadence makes it noise).

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
- **R7 Poll cost and request stacking (2.7)**: a `limactl list` per poll is
  bounded by the main process's 5 s TTL cache, and the in-flight guard
  keeps requests serial when a poll outlives the interval (slow limactl).
  Failure semantics: keep the last good snapshot on the line (never blank
  it mid-decision), `logger.warn` per failure, keep polling.

## 5. Acceptance scenarios (per slice)

- **S1**: `vmEnsureUp` with `{memoryGb: 5, cpus: 2, diskGb: 20}` on a fresh
  dir → VM created; `limactl list` shows `2 5368709120 21474836480`; entry
  marker carries the spec; defaults path (no spec) unchanged.
- **S2**: Open-folder-in-VM on a fresh dir shows the panel with a true host
  line (matches `free -g`'s available column; running VMs listed as context);
  collapsed Customize; Start boots with chosen spec; on an existing VM no
  panel, no extra click. Over-memory input shows amber warning, does not
  block.
- **S3**: ⋯ → VM settings shows instance-true specs; changing RAM to 5 and
  Apply recreates (port re-pinned, alias fresh, workspace reconnects);
  cancel leaves everything untouched.
- **S4 (2.7)**: With the first-create panel open, memory on the host is
  freed or consumed → the host line and the over-memory warning update
  within ~5 s; same for VM settings while open. After Start/Cancel or
  closing the dialog, polling stops (no further `VmHostResources` IPC).
  Web (no `vmHostResources`) and old preloads are unaffected — panel
  behavior as before this section.
- **Gates**: `pnpm typecheck` + `pnpm lint` + `architecture:check --changed`
  clean; E2E on real VMs for S1–S3 (create-with-spec needs one fresh dir;
  recreate test tolerates the clone time).

## 6. Explicitly out of scope (v1)

- Global default specs in app settings (revisit if per-project feels thin).
- Per-run spec overrides, offline/readonly toggles (agent-vm already offers
  them in terminal; surfacing every flag would recreate the wizard we
  removed).
- Live resize without recreate (Lima doesn't support it).

---

**2026-09-23 implementation record.** Provider restructured for the 400-line
rule: `vmRuntimeLifecycle.ts` (identity + agent-vm commands + spec flags +
ensureUp/reconfigure sequences), `vmRuntimeHostResources.ts` (limactl
instance records with CPUs/Memory/Disk, MemAvailable from /proc/meminfo,
statfs disk, committed-by-running-VMs subtraction, 5 s cache),
`vmRuntimeProvider.ts` as facade (single-flight map shared by ensureUp and
reconfigure). UI: `RemoteConnectionVmSpecStep.tsx` (pre-boot panel; VM-mode
dialog now gates auto-start on `vmStatus.state === "none"`), and
`WorkspaceSidebar/VmSettingsDialog.tsx` (⋯ → VM settings…; seeds from
instance truth; Apply → `agent-vm --memory N --cpus N --disk N --reset` with
inline log stream, refreshes the row badge on success).

E2E (dev app, CDP + AT-SPI-driven GTK portal pinned via portals.conf,
reverted after): S1 — bridge `vmEnsureUp` with `{5,2,20}` created the VM at
exactly 5 GiB/2 CPU/20 GiB, `vmStatus` reports the specs ✓. S2 — first-create
shows the panel with a true host line ("0.0 GB available of 15.4 GB · 12
CPUs · 38 GB disk" with two VMs committed), Customize collapsed, amber
over-memory warning on 4 GB input, Start creates at 4/2/15 and the persisted
marker carries the spec; existing VM goes straight to Connecting with no
panel ✓. S3 — VM settings seeds 4/2/15 from the instance, Apply re-creates
live (Broken → Stopped at 2 GiB → Running), port re-pinned (46617), row
reconnect connects after the post-reset asset re-upload ✓. Gates:
typecheck/lint/architecture:check clean. Deviations from plan: the sidebar
settings panel does not write the in-memory tab marker (per-provider tab
store is not reachable from the row; instance truth is the display source
per R5, persisted entries refresh on next reconnect).

---

**2026-09-23 implementation record (2.7 live host-resources line).**
`packages/ui/src/hooks/vmHostResourcesPoller.ts` (React-free controller:
immediate first fetch, in-flight guard, disposed drop, log-and-continue
errors) + `packages/ui/src/hooks/useVmHostResources.ts` (thin wrapper,
callbacks via refs, no-ops without `platform.vmHostResources`; memoized
bind so the effect doesn't re-subscribe per render). Wired in `SSHDialog`
(`enabled: vmMode && vmSpecPanel !== null`, delivers through
`setVmSpecPanel` — owner and write path unchanged; dialog close path
already clears the panel, which stops the poll) and `VmSettingsDialog`
(one-shot fetch replaced; explicit `onError` keeps its original log scope).
Unit coverage: `packages/ui/test/vmHostResourcesPoller.test.ts` (6 cases:
immediate + interval ticks, in-flight serialization, stop halts and drops
late results, inert restart, failure then recovery) — run via
`tsx --test` (session node is v22; mise's pinned 24 not on PATH).
Gates: tests 6/6 ✓; `architecture:check --changed` 0 violations ✓; lint
0 errors, no findings in touched files ✓; `pnpm typecheck` — all errors
remaining are in the unrelated in-flight bidiText/reasoning work (not this
change's files) ✓. S4 live observation (memory freed while the panel is
open, IPC silence after Start/Cancel) not exercised in this session —
needs the desktop dev app with Lima; unit tests + the enabled-flag wiring
cover the stop path by construction.

---

**2026-09-30 record: pin write path changed under §2.5/§2.3.** The re-pin
steps described above ("stop → re-pin → start" after `--reset`, and pinning
inside ensureUp's stop windows) no longer write `lima.yaml` via
`limactl edit`: the picked port rides the agent-vm command itself as
`--ssh-port N` (agent-vm ≥0.2.0 applies it at clone time on create/`--reset`,
or on a stopped instance before start). Resize is now a single
`agent-vm [--spec] --ssh-port N --reset shell -c true` command; the read-back
truth (`lima.yaml` `localPort`) and re-pin-after-reset semantics are
unchanged. Details: `docs/plan-open-in-vm.md` §2.1 + its 2026-09-30 record.
