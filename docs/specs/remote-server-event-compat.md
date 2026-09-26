# Spec: Remote server event-listen compatibility and stale-bundle refresh

Status 2026-09-25: implemented; unit/type/arch checks pass; verified differentially against real pre-fix and post-fix server bundles (crash reproduced pre-fix, survival proven post-fix); live SSH E2E pending on the user's target (install-mode switch is a user setting — see verification log).

## Goal

A desktop client must never kill a remote `zcode-server` by subscribing to a protocol event the deployed server bundle does not implement, and a remote server bundle that is stale relative to the fork (same version string, older content) must be refreshed automatically instead of poisoning the connection. This spec codifies the fix for the 2026-09-25 incident: a fork client subscribing to `onDynamicBrowserRelayRequest` against a v3.14.3 upstream bundle crashed the remote server with an uncaught `Error: Event not found` about one second after handshake, and the SSH session appeared frozen. The same failure was observed earlier and recorded in `docs/plan-open-in-vm.md` ("a 3.14.0-era bundle without the browser-relay event killed the remote server mid-connect").

## Product rules

1. **An event-listen for an unknown event or an unreachable channel must never terminate the server.** The server logs the failure and keeps serving; it sends **no wire response** for the failed event subscription. Rationale: event request ids and promise request ids share one counter namespace, and the client's event handler fires its emitter with the payload of _any_ response frame for that id (`channelClient.ts` handlers are type-blind), so an error frame would be misinterpreted as event data. Silence matches the existing semantics for unknown-channel event listens (logged, never answered).
2. **Failure is one-way.** The client cannot distinguish a failed subscription from a silent one — there is no error path for `EventListen` on the wire. Degradation is observable only through server-side logs (forwarded to the client log panel as `[remote]` lines on stdio remotes).
3. **Fork-only server bundle markers are probed only when the deploy source is the fork's own local build** — i.e. a development mock-cdn release directory exists for the current version and the install mode is not `remote-download`. CDN-sourced bundles (the `remote-download` SSH mode, and the production CDN cache fallback) are upstream builds that can never contain fork-only markers; probing fork markers there would force a redeploy on every connect that never converges. **Consequence:** a CDN-sourced server also lacks the RPC guard itself, so a fork client subscribing to a fork-only event still crashes it. The marker gate therefore only makes remotes self-healing when the install mode can deliver fork code; `remote-download` targets must switch to `local-download-upload` to be safe against this crash class.
4. Upstream markers (`skill-sync`, `mcp-sync`, …) keep their current unconditional probe semantics for all install sources.
5. The browser-relay subscription remains the capability negotiation: an old server that never receives (or rejects) the subscription keeps its pre-relay behavior for `browserList`/`browserExecute` with no other behavior change.
6. **A closed connection must settle everything it owns.** When a remote connection handle reports closed, the owning registry disposes the dead handle immediately: the RPC client's dispose rejects every in-flight request (`pendingRejections` fire only on dispose), sessions reach a terminal state, and the connect/attach flow surfaces an error. No UI flow may wait on a dead connection.
7. **Fork-only event subscriptions are capability-gated.** The host subscribes to a fork-only remote event only when the deploy layer asserts the remote bundle contains the fork markers _after_ the deploy decision: a performed deploy in a gated (local-source) mode counts as present; a skipped deploy counts as present only when the marker probe passed; non-gated modes (CDN sources) count as absent. When absent, the host logs a warning and skips the subscription — relay degrades to unavailable and an unguarded server can no longer be crashed by a fork client, whatever the install mode.

## State ownership

| Concern                                                | Owner                                                                                                                                                                                                      | Mechanism                                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| RPC dispatch failure semantics for event listens       | `ChannelServer.onEventListen` (`packages/rpc/src/channelServer.ts`)                                                                                                                                        | try/catch around `channel.listen` mirroring `onPromise`; logs via `console.error`; no response frame; no `activeRequests` entry |
| Wire semantics for event subscriptions (no error path) | `ChannelClient.requestEvent` (`packages/rpc/src/channelClient.ts`)                                                                                                                                         | unchanged; failed subscriptions leave the client emitter silent                                                                 |
| Server bundle freshness vs fork features               | `REQUIRED_SERVER_BUNDLE_MARKERS` + `FORK_SERVER_BUNDLE_MARKERS` (`packages/server/src/remote/serverBundleDeployCheck.ts`), applied in `checkServerDeployDecision` (`packages/server/src/remote/deploy.ts`) | remote `node -e` probe of the deployed bundle text on every same-version connect; fork markers gated by install source          |
| Fork-event capability flag                             | `RemoteServerDeployResult.forkBundleMarkersPresent` (`deploy.ts`) → `RemoteConnection` (`connect.ts`) → `createRemoteWorkspaceServiceCollection` (`remoteWorkspaceServiceCollection.ts`)                   | computed from the deploy decision after deploy; gates the relay subscription                                                    |
| Dead-connection disposal                               | `windowRemoteConnectionRegistry.handleConnectionClosed` → `disposeEntry`                                                                                                                                   | dispose on close rejects in-flight remote RPCs and removes the orphaned handle                                                  |

Event order (new client + **fork-built guarded server**, after the fix):

```
Desktop host                          Remote zcode-server
  connectRemote()
    ├─ deploy: version match → marker probe
    │    ├─ fork marker missing + local source → full redeploy (SFTP upload of local bundle)
    │    └─ remote-download/CDN source → skip fork markers (source can never satisfy them)
    ├─ exec server → handshake OK
    ├─ EventListen onDynamicBrowserRelayRequest ──► onEventListen
    │     OLD: throw → uncaught → process exit ✗
    │     NEW: catch → console.error → no wire response → connection survives ✓
    └─ RPC continues (relay silent until server bundle refreshed)
```

## Coverage

All `ChannelServer` consumers inherit the guard, since the fix is in the shared dispatch: the stdio remote server (`packages/server/src/stdio.ts`), the HTTP/WebSocket server (`packages/server/src/http.ts`, `packages/zcode-server-cli/src/server-core/http.ts`), the desktop window host (`packages/desktop/src/host/index.ts`), and `IPCServer` connections. The marker gating applies to every remote transport (SSH, WSL, Docker) because all deploy decisions funnel through `checkServerDeployDecision`.

## Known limitations (accepted)

- With the capability gate (rule 7), a `remote-download` target no longer crashes: the host skips the relay subscription against an unguarded server. The trade-off is that fork-only features stay unavailable on it — switching the target's asset install mode to `local-download-upload` is what delivers the fork bundle (and relay), it is no longer what prevents the crash.
- A production (non-mock-cdn) `local-download-upload` connect sources the bundle from the upstream CDN cache, so fork markers are skipped there too (per rule 3); relay stays unavailable there per rule 7.
- The client cannot distinguish a failed subscription from a silent one (no error frame for `EventListen` on the wire); on guarded servers degradation is observable only through server-side logs, forwarded to the client log panel as `[remote]` lines on stdio remotes.
- The remote server's crash log for the pre-fix failure named the missing event but gave no client/server version skew context; the new server-side log line names the channel and event so the gap is attributable from the client log panel.

## Acceptance scenarios

1. New client + old remote server running a **fork-built (guarded) bundle** that predates `onDynamicBrowserRelayRequest`: connect completes; the subscription is caught and logged server-side; the server process stays alive; unrelated RPC calls continue to work; relay silently unavailable.
2. Same-version stale bundle + local (mock-cdn) install source: the fork marker probe fails → full redeploy uploads the fork-built bundle → on the next connect the event exists and relay works.
3. `remote-download` target (CDN source): the marker gate stays off so no redeploy loop occurs; the capability flag resolves to absent, the host skips the relay subscription, and the upstream server survives — relay unavailable, connection healthy.
4. Regression: known events still fire end-to-end; unknown-channel promise requests still receive the "timed out" `PromiseError`; unknown-channel event listens stay logged-and-silent.
5. Connection dies mid-session (crash, network, server exit): the registry disposes the dead handle; in-flight remote RPCs reject instead of pending forever; sessions reach `disconnected`; the workspace UI surfaces an error or an offline state within seconds instead of spinning indefinitely.
6. Stale server + capability gate: the fork marker probe reports absent (or a non-gated install mode) → the host logs a warning naming the remedy and skips the `onDynamicBrowserRelayRequest` subscription → connect completes, no crash, relay unavailable.

## Verification log

- `node scripts/check-workspace-freshness.mjs`: pass (browser-relay-remote, ahead 20 / behind 0).
- `pnpm architecture:context rpc` / `pnpm architecture:context server`: both modules `managed: false`, no contract packages; no new cross-module imports introduced (rpc gained none; server-internal only). `pnpm architecture:check --changed` before edits: OK, 0 violations. After edits: OK, 0 new violations. `pnpm verify:pre-push`: pass.
- Unit tests (`packages/rpc/test/channelServer.test.ts`, 5 cases: missing-event survival + log assertion, no-wire-response silence, existing-event regression, unknown-channel promise timeout survival, unknown-channel event silence): 5/5 pass via `pnpm exec tsx --test`. Bug-detection check: reverting only the `onEventListen` guard (`git stash push -- packages/rpc/src/channelServer.ts`) makes 2/5 fail — the suite demonstrably catches the original crash.
- `pnpm typecheck`: pass. Note: per repo convention `packages/*/test/` directories are outside the package tsconfigs (same for `services/test`, `ui/test`), so the new test is validated by execution and oxlint rather than `tsc`.
- `pnpm lint`: 0 errors; 70 warnings, all pre-existing and none in changed files. `oxfmt --check` on the five changed files: clean (spec table auto-formatted by oxfmt).
- **Not run**: live SSH E2E against a real password-authenticated target — requires the remote and the app runtime; the target's install-mode switch is a user setting. Scenarios 1–3 are covered at the artifact level by the differential bundle verification below; reproduce live by switching the target to `local-download-upload` and reconnecting (expect a `deploy` log line about missing fork markers followed by a `zcode-server.cjs` SFTP upload).
- **Differential bundle verification (real process, real handshake, real wire)**: built `dist/remote/zcode-server.cjs` from the fixed tree (`5dc08761…`) and from the pre-fix tree (`f05cd881…` — byte-identical to the mock-cdn copy staged at the time, i.e. the artifact a deploy would have shipped). A harness spawned each bundle, performed the genuine `zcode-hello`/`zcode-hello-ack` handshake, attached `ChannelClient` over the real stdio framing, subscribed to `onDynamicDoesNotExist` on the `zcode-agent` channel, and attempted a follow-up wire round-trip:
  - pre-fix bundle: RPC initialized → subscription → **process exited code 1**, stderr stack `Error: Event not found: onDynamicDoesNotExist` at `Object.listen → ChannelServer.onEventListen → ChannelServer.onRawMessage` (identical shape to the production incident); round-trip got no response.
  - fixed bundle: RPC initialized → subscription → **process stayed alive**; stderr shows the new caught log line `event listen failed on channel "zcode-agent" for event "onDynamicDoesNotExist": Event not found`; follow-up call round-tripped (`Method not found` rejection = server answering).
  - Harness note: the handshake buffer must be replayed byte-exact (`Buffer`, not a UTF-8 string) before attaching the socket wrapper — a string round-trip corrupts the binary RPC frames and masks the result (first two harness attempts failed this way, matching why `connect.ts:213` unshifts a `Buffer`).
- **mock-cdn freshness**: `scripts/prepare-prebuilds.mjs` (`prepare:remote-assets`) rebuilds `build:remote` and copies `dist/remote/zcode-server.cjs` into `packages/desktop/mock-cdn/releases/<version>/server/`; the copy staged at diagnosis time predated the fix (byte-identical to the pre-fix bundle). Re-run `pnpm --filter @zcode/desktop prepare:remote-assets` after this change so the deploy source ships the guarded bundle.
- **Second round (rules 6–7), 2026-09-25**: `pnpm typecheck` pass; `pnpm lint` 0 errors (70 pre-existing warnings, none in changed files); `pnpm architecture:check --changed` OK, 0 new violations; `oxfmt --check` clean on all changed files. Registry unit tests (`packages/desktop/test/windowRemoteConnectionRegistry.test.ts`, 3 cases: close→dispose + session settlement, idempotent close across sessions sharing an entry, explicit dispose after close): 3/3 pass; rpc regression suite still 5/5 — 8/8 total via `pnpm exec tsx --test`. **Not run**: live SSH E2E against the real target (install-mode switch is a user setting); the capability flag's runtime behavior is covered by the decision paths plus the compile-time plumbing through `connect.ts` → host → service collection.
