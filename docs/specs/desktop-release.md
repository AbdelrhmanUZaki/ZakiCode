# Spec: Fork release builds (GitHub Releases with installers)

Status 2026-10-03: implemented; first fork release `v3.14.3-zaki.1` ships `deb` + `AppImage` (linux x64). `rpm` and `pacman` are omitted this pass: their fpm backends need `rpmbuild` / `bsdtar`, not installable without sudo on the build host. A Windows NSIS cross-build needs wine and macOS needs a macOS host; both stay deferred until a proper build host or CI exists.

## Goal

A tag pushed to the fork produces a GitHub Release that people can install — never a source-only release. The README already promises `deb` / `AppImage` builds on the Releases page; this spec defines how they get there.

## Product rules

1. **Artifacts are mandatory.** A release whose only content is the auto-generated source archive is wrong and must not be published. The release gate is `pnpm bundle:desktop` completing its mechanical verification: runtime-dependency closure inside `app.asar`, native-package policy check, and the bundle-size audit.
2. **Version scheme.** Fork builds use `<upstream-base>-zaki.<N>` (e.g. `3.14.3-zaki.1`) so a fork build is never confused with the upstream release of the same number. Root `package.json` `version` is the single owner; the tag is `v${version}`.
3. **Build identity.** Releases build with `ZCODE_ENV=production`: product name `ZCode`, appId `dev.zcode.app`, no `_TEST` artifact suffix. The fork ships upstream branding until a rebrand spec exists; a fork build replacing an upstream install (same appId) is accepted behavior.
4. **Platforms.** linux x64 is the release platform: `AppImage` and `deb` by default; `rpm` / `pacman` additionally need `rpmbuild` / `bsdtar` on the build host. win x64 NSIS cross-build from Linux additionally needs wine; mac targets cannot be built on Linux at all and are deferred until a mac builder or CI exists.
5. **Build command.** `ZCODE_ENV=production pnpm bundle:desktop -- --os <os> --arch <arch>` from a workspace installed with the pinned toolchain (Node 24.14.0, pnpm 10.33.2 per `mise.toml`). Remote prebuild downloads come from public mirrors (`npmmirror` defaults, overridable via `ZCODE_NODE_DIST_MIRROR`), so the build needs no intranet access.
6. **Release notes must state:** binaries are unsigned (macOS Gatekeeper `xattr -cr` workaround / Windows SmartScreen warning), VM workspaces need [agent-vm](https://github.com/sylvinus/agent-vm), and this is a personal fork build of upstream ZCode.

## State ownership

| Concern       | Owner                                 | Mechanism                                                          |
| ------------- | ------------------------------------- | ------------------------------------------------------------------ |
| Version       | root `package.json` `version`         | single write path; tag mirrors it as `v${version}`                 |
| Tag           | git tag on the version-bump commit    | annotated tag pushed to `origin` (AbdelrhmanUZaki/ZakiCode)        |
| Installers    | `packages/desktop/dist/` after bundle | uploaded as GitHub Release assets, unmodified                      |
| Release notes | the GitHub Release body               | generated per release from the commits since the previous fork tag |

## Acceptance scenarios

- `gh release view` on the fork lists at least `*-linux-x64.AppImage` and `*-linux-x64.deb` assets alongside the release notes.
- A user on a clean Linux machine can install the `deb`, launch `ZCode`, and reach the first-run screen without building from source.
- Upstream's own release process is untouched: nothing in this spec changes `.release-it.mjs` or upstream scripts; fork releases are cut by tag + upload, not by `release-it`.
