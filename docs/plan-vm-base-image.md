# Plan: VM base image bootstrap — first-run without a terminal

**状态 2026-09-23：已实现并通过真实首机 E2E（记录见文末）。**

**Goal.** Close the last "go open a terminal" gap: on a machine without the
agent-vm base template, the app's first "Open folder in VM" fails with a raw
`agent-vm` error mid-boot. Instead, the app detects the missing template,
says so in the pre-boot panel, and builds it automatically on Start —
streamed into the same log panel, then proceeds to create + connect.

**Scope note.** Auto-bootstrap of the _default_ template only. No preinstall
checkbox UI, no custom provisioning, no template rebuild manager — those
stay terminal-side (rare, machine-level, one-time decisions get the
lightest possible surface).

---

## 1. Verified current state (2026-09-23, this fork)

| #   | Fact                                                                                                                                                                                                                              | Evidence                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | `agent-vm info` is machine-readable and includes `base_exists` (plus `template=agent-vm-base`)                                                                                                                                    | ran: `agent-vm info <dir>` → `template=agent-vm-base`, `base_exists=1` |
| 2   | `agent-vm setup` "Runs an interactive wizard by default" **but** "When stdin is not a terminal (e.g. CI), the wizard is skipped automatically and the default set is installed" — default = everything except opt-in Ruby/Rust/Go | `agent-vm setup --help`                                                |
| 3   | `--preinstall=LIST` exists for explicit subsets; setup also takes `--disk/--memory/--cpus` for the template itself                                                                                                                | same help                                                              |
| 4   | Our `runVmCommand` spawns with `stdio: ["ignore", "pipe", "pipe"]` → stdin is not a TTY → the auto-default path applies with zero extra flags                                                                                     | `vmRuntimeProcess.ts`                                                  |
| 5   | The template build is one-time, network-dependent, minutes-scale (~10 min typical), and can fail on slow routes (nerdctl digest issue in the vmup README troubleshooting)                                                         | vmup README                                                            |
| 6   | Today the provider's create branch (`agent-vm shell -c true`) fails opaquely when `base_exists=0`; nothing pre-checks it                                                                                                          | `vmRuntimeLifecycle.ts` ensureUpSequence                               |
| 7   | The pre-boot spec panel already exists exactly at the right moment (first create only, before Start)                                                                                                                              | `RemoteConnectionVmSpecStep.tsx`                                       |

## 2. Design

**Principle: the app owns the happy path end-to-end; template absence
becomes a visible, one-click step — not an error.**

### 2.1 Provider: template readiness + setup

- `vmRuntimeProvider.templateReady(): Promise<boolean>` — parse
  `agent-vm info <dir>` (any dir; the template is machine-global) for
  `base_exists`. Cheap; cache ≤30 s alongside availability.
- `ensureUpSequence` gains a **template branch**: when the VM doesn't exist
  AND the template doesn't exist, run `agent-vm setup` first (stdin ignored
  per fact #4 → default set, no wizard), streaming output through `onLog`
  with the marker line
  `==> Building base image (one-time, ~10 min; installs the default tool set)`.
  Setup timeout: 30 min (network variance). On success, continue with the
  normal create branch.
- `vmStatus` gains `templateReady: boolean` so the panel can render state
  without running the boot.

### 2.2 Panel: one line, one click

The pre-boot spec panel shows (between host line and Customize) when
`templateReady === false`:

```
  ⚠ Base image required — built once on this machine (~10 min),
    then every project VM clones it with the tools preinstalled.
```

Start VM remains the single button; if the template is missing it first
builds (logs stream in the Connecting phase, `==>` lines included), then
creates the VM and connects. No separate flow, no second confirm.

### 2.3 Shared plumbing

`VmRuntimeStatus` gains `templateReady?: boolean`; channel/persisted schemas
unchanged (status is a query, not persisted). i18n keys (en/zh/ar):
`vm.template.requiredTitle`, `vm.template.requiredDescription`,
`vm.template.building`.

## 3. Workstreams / slices

Single slice: provider `templateReady` + setup branch (+30-min timeout,
log markers) → status field → panel line → i18n. Followed by gates
(typecheck/lint/architecture/prettier) and E2E.

## 4. Risks / open questions

- **R1 Setup interactivity**: if a future agent-vm version prompts even
  without a TTY, the run hangs until timeout. Mitigation: our stdin is
  already `ignore`; keep the 30-min cap and surface the timeout error
  verbatim. Do not pass `--preinstall` (the default set is the
  documented happy path; subsets stay CLI).
- **R2 Network failures**: digest/download errors stream into the log panel
  (same as boot); the retry button re-enters ensureUp, which re-checks the
  template (idempotent — setup on an existing template is a cheap no-op or
  fast re-verify).
- **R3 Template disk/memory**: setup uses its own defaults (3 GB / 1 CPU /
  10 GB); the _project_ spec chosen in the panel does not apply to the
  template. Out of scope to couple them.
- **R4 Rebuild**: rebuilding the template only affects future creates;
  existing VMs keep their clone. Stays terminal-side by design.

## 5. Acceptance scenarios

- Fresh-machine simulation (`limactl delete agent-vm-base` on a scratch
  machine or `base_exists=0`): panel shows the required-template line;
  Start streams `==> Building base image…` then the normal create lines;
  workspace opens; `base_exists=1` afterwards; `templateReady: true` in
  `vmStatus`.
- Existing template: panel line absent, zero new clicks, no setup call.
- Simulated setup failure (PATH stub returning error): error text appears
  in the log panel; retry re-runs cleanly.
- Gates clean; folded into existing feature commits where history allows
  (user preference), else a single new commit.

## 6. Explicitly out of scope

- Preinstall subset picker, custom provisioning scripts, template rebuild
  UI (terminal remains the tool for all three).
- Applying project VM specs to the template.

---

**2026-09-23 implementation record.** Lifecycle gained
`readBaseTemplateExists` (`agent-vm info` → `base_exists`，探测失败按就绪
处理让原始错误浮现) and `ensureBaseTemplate` (plain `agent-vm setup` —
stdin non-TTY auto-skips the wizard and installs the default set);
ensureUp's create branch calls it first. Provider exposes cached (30 s)
template readiness and `vmStatus.templateReady` (probed only when the VM
doesn't exist). The spec panel renders the one-time-build notice between
the host line and Customize; Start remains the single button. i18n: en+zh
(the app ships no Arabic locale — plan's "ar" was aspirational).

E2E (real first-machine simulation: `limactl delete agent-vm-base`, then
Open-folder-in-VM on a fresh dir): `vmStatus` reported `templateReady:false`
✓; panel showed the notice ✓; Start streamed `==> Building base image…`
plus live setup output ✓; setup finished, VM cloned/pinned/started,
workspace connected at the same path, `base_exists=1` restored ✓.

**Timing finding (changed the code):** the default install set took
**~29 minutes** on this machine (downloads + cloud-init + Claude/OpenCode/
etc.), far over the ~10 min the vmup README suggests — the original
30-min cap left ~1 min of margin. `VM_TEMPLATE_TIMEOUT_MS` raised to
45 min accordingly.

**Follow-up (same day): base-image tools choice.** The default set ships
AI-agent CLIs (claude/opencode/codex/vibe) which ZCode never invokes (it
runs its own runtime over SSH), so the spec panel gains a collapsed
"Base image tools" control shown only when the template is missing:
Default (agent-vm's interactive default) / Minimal (`python,node,docker,gh`)
/ Custom list — mapped to `agent-vm setup --preinstall=...` via
`resolveVmTemplatePreinstall` (validated `^[a-z0-9,-]+$`, invalid input
falls back to the default). IPC carries `templateTools` on VmEnsureUpRequest
(strict allow-list parse in the handler); lifecycle logs the chosen set in
the build marker line.
