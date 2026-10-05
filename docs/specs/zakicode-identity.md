# Spec: ZakiCode product flavor (side-by-side with upstream ZCode)

Status 2026-10-05: implemented. `v3.14.3-zaki.2` introduced the flavor; `v3.14.3-zaki.3` adds the fork's own icon artwork (amber Z) and the multi-size user-level icon install. Selected at build time via `ZCODE_FORK_IDENTITY=1` (strict `"1"`/`"0"` spelling, same validation style as `ZCODE_PREVIEW_IDENTITY`); release builds use `ZCODE_ENV=production ZCODE_FORK_IDENTITY=1`.

## Goal

A downloaded fork build runs next to an installed upstream ZCode with zero setup: its own name in the app launcher, its own window/userData/single-instance lock, its own login — while **both apps show the same sessions**, because the agent CLI layer stays on the shared `~/.zcode/cli`. This is the user-confirmed behavior ("I want to have both sessions on both instances, this is good") and the reason the flavor must not isolate the agent data root.

## Product rules

1. **Separate (per flavor):** product name `ZakiCode`, appId `dev.zakicode.app`, Linux executable/package/desktop-entry/icon name `zakicode`, Electron userData (`~/.config/ZakiCode`) and single-instance lock, app-layer services data root `~/.zakicode/.zcode/v2` (credentials, settings, tasks index, logs, crash dumps), `deb`/`rpm`/`pacman` package names, Windows AUMID, auto-update UI/updater (hidden — fork ships no update feed; all `flavor === "production"` gates exclude zakicode).
2. **Shared with upstream (unchanged):** the agent CLI runtime (`~/.zcode/cli`: sessions DB, rollouts, logs — fork-spawned agents are NOT given a separate data root) and the `zcode://` deep-link scheme (last registrant becomes the default handler, same trade-off upstream accepts for its Preview flavor).
3. **Data-root precedence:** user-set `dataBaseDir` in settings > `ZCODE_DATA_BASE_DIR` env > flavor default (`~/.zakicode` for packaged zakicode builds; `HOME` otherwise). Only a genuine user override is forwarded to spawned hosts/agents as `ZCODE_DATA_BASE_DIR`; the flavor default is not, because forwarding it would split the shared session pool.
4. **Dev runtime unchanged:** local development stays `ZCode Dev`; `ZCODE_DESKTOP_APPLICATION_NAME` and the e2e env overrides keep priority over the flavor default.
5. The `preview` flavor's semantics are untouched; `zakicode` is a third peer in `desktopProductIdentities`, not a modification of the existing two.
6. **Icon artwork.** Fork builds use amber-tinted Z artwork — window/tray icon, Linux desktop entry, and the user-level hicolor set — generated from upstream's monochrome icon by `packages/desktop/scripts/make-zakicode-icons.mjs` (re-run it when upstream artwork changes). The packaged app carries the full size set at `resources/zakicode-icons/`, and the user-level icon installer writes **every** size: a single 512px file left the fork with a blank paper icon in the KDE Wayland taskbar/launcher. Installer-only artwork (dmg/nsis) keeps upstream's.

## State ownership

| Concern                  | Owner                                                   | Mechanism                                                                       |
| ------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Build-time flavor        | `ZCODE_FORK_IDENTITY` env                               | `resolveDesktopProductFlavor` → `__ZCODE_PRODUCT_FLAVOR__` define (tsup + vite) |
| Identity table           | `packages/desktop/scripts/desktop-product-identity.mjs` | frozen per-flavor records                                                       |
| Runtime app name         | `desktopRuntimeEnv.ts` `runtimeApplicationName`         | packaged zakicode → `ZakiCode`; env override still wins                         |
| Services data root       | `desktopDataBaseDirBootstrap.ts`                        | flavor default `~/.zakicode`; override flag exported for env forwarding         |
| Linux desktop entry/icon | deep-link registration + AppImage icon modules          | filenames derived from flavor, MIME stays `x-scheme-handler/zcode`              |

## Acceptance scenarios

- On a machine with upstream ZCode installed: launch the ZakiCode AppImage — both apps run simultaneously (distinct single-instance locks), the app list shows both **ZCode** and **ZakiCode**, and the session list is identical in both.
- First fork launch starts with its own login/onboarding (fresh `~/.zakicode/.zcode/v2`) and no session history is lost — sessions reappear from the shared agent layer.
- `dpkg -l zcode zakicode` lists both packages after installing both debs; neither upgrade removes the other.
- A build with `ZCODE_FORK_IDENTITY=true` (or any spelling other than `1`/`0`/empty) fails at build time with an explicit error.
- `ZCODE_ENV=test` builds keep Preview identity regardless of `ZCODE_FORK_IDENTITY`.
