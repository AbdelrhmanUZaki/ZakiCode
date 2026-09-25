# Spec: Remote server event-listen compatibility and stale-bundle refresh

Status 2026-09-25: implemented; unit/type/arch checks pass; live SSH E2E pending (user-owned operational step — see verification log).

## Goal

A desktop client must never kill a remote `zcode-server` by subscribing to a protocol event the deployed server bundle does not implement, and a remote server bundle that is stale relative to the fork (same version string, older content) must be refreshed automatically instead of poisoning the connection. This spec codifies the fix for the 2026-09-25 incident: a fork client subscribing to `onDynamicBrowserRelayRequest` against a v3.14.3 upstream bundle crashed the remote server with an uncaught `Error: Event not found` about one second after handshake, and the SSH session appeared frozen. The same failure was observed earlier and recorded in `docs/plan-open-in-vm.md` ("a 3.14.0-era bundle without the browser-relay event killed the remote server mid-connect").

## Product rules

1. **An event-listen for an unknown event or an unreachable channel must never terminate the server.** The server logs the failure and keeps serving; it sends **no wire response** for the failed event subscription. Rationale: event request ids and promise request ids share one counter namespace, and the client's event handler fires its emitter with the payload of _any_ response frame for that id (`channelClient.ts` handlers are type-blind), so an error frame would be misinterpreted as event data. Silence matches the existing semantics for unknown-channel event listens (logged, never answered).
2. **Failure is one-way.** The client cannot distinguish a failed subscription from a silent one — there is no error path for `EventListen` on the wire. Degradation is observable only through server-side logs (forwarded to the client log panel as `[remote]` lines on stdio remotes).
3. **Fork-only server bundle markers are probed only when the deploy source is the fork's own local build** — i.e. a development mock-cdn release directory exists for the current version and the install mode is not `remote-download`. CDN-sourced bundles (the `remote-download` SSH mode, and the production CDN cache fallback) are upstream builds that can never contain fork-only markers; probing fork markers there would force a redeploy on every connect that never converges.
4. Upstream markers (`skill-sync`, `mcp-sync`, …) keep their current unconditional probe semantics for all install sources.
5. The browser-relay subscription remains the capability negotiation: an old server that never receives (or rejects) the subscription keeps its pre-relay behavior for `browserList`/`browserExecute` with no other behavior change.

## State ownership

| Concern                                                | Owner                                                                                                                                                                                                      | Mechanism                                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| RPC dispatch failure semantics for event listens       | `ChannelServer.onEventListen` (`packages/rpc/src/channelServer.ts`)                                                                                                                                        | try/catch around `channel.listen` mirroring `onPromise`; logs via `console.error`; no response frame; no `activeRequests` entry |
| Wire semantics for event subscriptions (no error path) | `ChannelClient.requestEvent` (`packages/rpc/src/channelClient.ts`)                                                                                                                                         | unchanged; failed subscriptions leave the client emitter silent                                                                 |
| Server bundle freshness vs fork features               | `REQUIRED_SERVER_BUNDLE_MARKERS` + `FORK_SERVER_BUNDLE_MARKERS` (`packages/server/src/remote/serverBundleDeployCheck.ts`), applied in `checkServerDeployDecision` (`packages/server/src/remote/deploy.ts`) | remote `node -e` probe of the deployed bundle text on every same-version connect; fork markers gated by install source          |

Event order (old-server + new-client, after the fix):

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

- A `remote-download` SSH target pulls the server bundle from the upstream CDN, so fork-only server features (e.g. browser relay) cannot ever be delivered to it; the connection now survives with relay unavailable. To run fork features on such a remote, switch the target's asset install mode to `local-download-upload`.
- A production (non-mock-cdn) `local-download-upload` connect sources the bundle from the upstream CDN cache, so fork markers are skipped there too, per rule 3.
- The remote server's crash log for the pre-fix failure named the missing event but gave no client/server version skew context; the new server-side log line names the channel and event so the gap is attributable from the client log panel.

## Acceptance scenarios

1. New client + old remote server (missing `onDynamicBrowserRelayRequest`): connect completes; the subscription is caught and logged server-side; the server process stays alive; unrelated RPC calls continue to work; relay silently unavailable.
2. Same-version stale bundle + local (mock-cdn) install source: the fork marker probe fails → full redeploy uploads the fork-built bundle → on the next connect the event exists and relay works.
3. `remote-download` target (CDN source): no fork markers probed → no redeploy loop; the connection survives an upstream bundle with relay unavailable.
4. Regression: known events still fire end-to-end; unknown-channel promise requests still receive the "timed out" `PromiseError`; unknown-channel event listens stay logged-and-silent.

## Verification log

- `node scripts/check-workspace-freshness.mjs`: pass (browser-relay-remote, ahead 20 / behind 0).
- `pnpm architecture:context rpc` / `pnpm architecture:context server`: both modules `managed: false`, no contract packages; no new cross-module imports introduced (rpc gained none; server-internal only). `pnpm architecture:check --changed` before edits: OK, 0 violations. After edits: OK, 0 new violations. `pnpm verify:pre-push`: pass.
- Unit tests (`packages/rpc/test/channelServer.test.ts`, 5 cases: missing-event survival + log assertion, no-wire-response silence, existing-event regression, unknown-channel promise timeout survival, unknown-channel event silence): 5/5 pass via `pnpm exec tsx --test`. Bug-detection check: reverting only the `onEventListen` guard (`git stash push -- packages/rpc/src/channelServer.ts`) makes 2/5 fail — the suite demonstrably catches the original crash.
- `pnpm typecheck`: pass. Note: per repo convention `packages/*/test/` directories are outside the package tsconfigs (same for `services/test`, `ui/test`), so the new test is validated by execution and oxlint rather than `tsc`.
- `pnpm lint`: 0 errors; 70 warnings, all pre-existing and none in changed files. `oxfmt --check` on the five changed files: clean (spec table auto-formatted by oxfmt).
- **Not run**: live SSH E2E (scenarios 1–3 against the real `203.0.113.10` target) — requires the password-authenticated remote and the desktop app runtime, and the target's install-mode switch is a user setting. Scenario 1 is covered by the unit suite; scenario 2/3 semantics are covered by the decision gate plus the probe script behavior. Reproduce: switch the target to `local-download-upload`, reconnect, and expect a `deploy` log line about missing fork markers followed by a `zcode-server.cjs` SFTP upload.
