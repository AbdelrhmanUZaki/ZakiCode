# Spec: Automatic text direction (bidi) for chat content

Status 2026-09-23: S1–S6 implemented; unit/type/arch checks pass; bidi mechanism visually verified in Chromium; in-app E2E pending (environment lacks Node 24 — see verification log). Note: the first commit of this work (efbd285) shipped only the lib/spec/docs half — the renderer wiring landed in a follow-up commit after the app was observed not to render RTL.

## Goal

Any paragraph or line whose first strong character is RTL (Arabic and other RTL scripts) renders right-to-left with right alignment, so Arabic content is readable without manual toggles. Pure-Latin content must render exactly as before (the change is a no-op for it). Code, diffs, and terminal output always stay LTR.

## Product rules

1. Direction is **automatic and default-on**. No setting, no locale dependency: the browser's UAX #9 algorithm decides per text block via `unicode-bidi: plaintext` — first strong character wins; digits, emoji, and punctuation are neutral and never decide direction.
2. **Code stays LTR everywhere**: fenced code blocks, inline code, `CodeViewer` (file preview code view / .txt / .log), `CodeBlock` (non-markdown tool output, plain artifact bodies), `DiffViewer`/patch views, terminal, mermaid.
3. Markdown blocks (p, headings, li, blockquote, table cells) each resolve their own direction. A message may mix LTR and RTL paragraphs.
4. Plain-text surfaces (user bubble, reasoning) resolve direction **per source line** (`\n`-separated), because they are not split into block elements.
5. Composer input picks its base direction from the typed content (`dir="auto"`).
6. Never hardcode `left`/`right` alignment for content text; alignment follows resolved direction via `start`.

## State ownership

| Concern                                                                   | Owner                                                                                           | Mechanism                                                                                                                        |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Direction of markdown blocks (assistant + all `MessageResponse` surfaces) | CSS rule `.zcode-bidi` in `packages/ui/src/styles.css`                                          | `unicode-bidi: plaintext; text-align: start;` on text blocks; marker class added once in `MessageResponse`'s `responseClassName` |
| Direction of plain-text lines (user bubble, reasoning)                    | `packages/ui/src/lib/bidiText.ts` (pure splitter) + per-line `<span dir="auto">` at render time | No persisted state; deterministic transform of the text                                                                          |
| Composer base direction                                                   | `dir="auto"` attribute on the editable/textarea element                                         | Browser-managed                                                                                                                  |

No cross-package changes, no protocol changes, no persisted settings.

## Coverage (verified call sites)

All of the following route through `MessageResponse` and are covered by the single marker class: main chat assistant rows (`ConversationRowView`), file preview side pane markdown mode (`previewPaneMarkdownContent.tsx`), "View full plan" side pane (`PlanDetailSidePane.tsx`) and the collapsed plan card (`switch-mode.tsx`), inline markdown file preview / plan result in tool calls (`ToolCallBody.tsx`), workflow artifact markdown bodies and tile previews, readonly share timeline (`ConversationShareReadonlyTimeline.tsx`), session side panes (Selection / Subagent / WorkflowActor via `ConversationTimeline`), release notes tooltip, and the tool renderers (`agent`, `agentPromptSection`, `plan-guidance`, `read-session-context`).

Intentionally LTR: `CodeViewer` (preview pane code view and non-markdown text files), `CodeBlock`, `DiffViewer`/patch fallback, plain-text artifact bodies (monospace `<pre>`), terminal, mermaid blocks.

## Known limitations (accepted)

- Table column order and the table wrapper box keep container-level LTR; cells flip individually via the `.zcode-bidi` rule. Full box-level RTL table reordering would need per-block JS `dir` detection — out of scope.
- Plain-text fallback (markdown render error path) is whole-block `dir="auto"`, not per-line.

## Box-level direction (list markers, borders)

`unicode-bidi: plaintext` fixes text order and alignment but not the `direction` property, which decides `::marker` side and physical border/padding sides. Therefore markdown `ul`/`ol`/`li`/`blockquote` and the reasoning guide line carry `dir="auto"` (direction resolves from first strong character) and use logical properties (`ps-*`, `border-s`, `ms-*`) instead of physical `pl-*`/`border-l`/`ml-*`. Both changes are no-ops for LTR content. Verified in Chromium: Arabic list numbers/bullets render on the right without clipping (matches the explicit `dir="rtl"` reference rendering; the numeral sits rightmost with the period to its left, per Arabic convention), English lists unchanged.

## Acceptance scenarios

1. Assistant replies with a pure-Arabic paragraph → rendered RTL, right-aligned; following English paragraph in the same message stays LTR.
2. Arabic inside a fenced code block or inline code → stays LTR.
3. Arabic in a markdown table cell → cell text RTL; table structure unchanged.
   3a. Arabic ordered/unordered list → numbers/bullets on the right side, no clipping; English lists unchanged; Arabic blockquote vertical border flips to the right.
4. User sends a multi-line message: line 1 English, line 2 Arabic → line 1 LTR left-aligned, line 2 RTL right-aligned; mention chips stay inline in their line; copying the bubble preserves lines.
5. Reasoning block with Arabic lines → per-line direction.
6. Composer: typing Arabic first → input base direction flips to RTL; typing English after clearing → back to LTR.
7. Side panels: opening a `.md` file with Arabic content (preview mode) → RTL; "View full plan" on an Arabic plan → RTL; the same file in code view → stays LTR.
8. Regression: an English-only conversation renders pixel-identically to before the change.

## Verification log

- `node scripts/check-workspace-freshness.mjs --no-fetch`: pass (ahead 13 / behind 0).
- `pnpm architecture:check --changed` before edits: OK, 0 violations (baseline). After edits: OK, 0 new violations.
- Unit tests (`packages/ui/test/bidiText.test.ts`, 8 cases — mixed lines, CRLF, mentions per line, blank/trailing newlines, lone `\n`, empty parts): 8/8 pass via `tsx --test` (repo has no test script; `tsx` is the repo's TS runner; pinned Node 24 via mise is not installed in this environment, and system Node 22 lacks native TS stripping).
- `pnpm typecheck`: pass. `pnpm lint`: 0 errors (70 pre-existing warnings, none in changed files). `pnpm fmt:check`: my files formatted via `oxfmt`; 31 unrelated files already fail on this branch (untouched, reported as-is).
- Chromium mechanism check (headless Chrome, real renderer): fixture replicating the exact runtime DOM/CSS — `.zcode-bidi` blocks: Arabic paragraph/heading/li/blockquote/td render RTL right-aligned; English unchanged; code fence and inline code stay LTR; per-line `dir="auto"` spans: EN line left, AR line right, mixed "اكتب hello world" embeds correctly, number-leading line `123 رسالة…` resolves RTL (digits are neutral); `min-height:1lh` keeps blank-line height; `textarea dir="auto"` flips RTL with Arabic. Control surface without `.zcode-bidi` reproduced the old left-aligned rendering (the defect this change fixes). Screenshot: `/tmp/rtl-fixture.png` (ephemeral).
- **Not run**: in-app desktop E2E (`pnpm dev:desktop`) — the dev server requires the mise-pinned Node 24 (native TS stripping for the desktop vite config chain); this sandbox only has Node 22 and no mise. Reproduce with: `mise run dev`, then verify scenarios 1–8 above. Code-path integration is covered by the coverage audit in this spec plus typecheck.
