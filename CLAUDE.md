# Claude Exporter - Development Guide

> **Migration in progress.** This file describes the target structure agreed in
> [ADR-0001](docs/adr/0001-single-typescript-source-tree.md) and [ADR-0002](docs/adr/0002-chat-cache-in-indexeddb.md).
> Until the restructure commit lands, the tree on disk is still the legacy
> `chrome/` + `firefox/` layout. Delete this note once `src/` exists.

## Domain Documentation

- **[CONTEXT.md](CONTEXT.md)** — the glossary. Use these terms exactly; they are load-bearing. In particular **Export Record** (the user got a file) and **Chat Cache** (we hold the bytes) are independent concepts, and "exported" is ambiguous between them
- **[docs/adr/](docs/adr/)** — architectural decisions and, more usefully, the alternatives that were rejected and why. Read before proposing to change the build, the storage layer, or the browser targets

## Self-Maintenance

This file is the shared project memory. **Update it proactively** when:

- A new critical rule or recurring bug pattern is discovered
- Project structure changes (new files, renamed files, new architecture patterns)
- A decision is made about how something should always work (e.g., "exports > 1 file must ZIP")

Keep it concise. Don't duplicate what's already here — update existing sections instead.

There is **one copy** of this file, at the repo root. (Older revisions claimed a second copy under `src/`; there has never been a `src/CLAUDE.md` in this repo.)

## Project Structure

The repo root *is* the extension project — there is no wrapper directory.

```
/
├── CLAUDE.md, CONTEXT.md, README.md, LICENSE.md
├── docs/            TODO.md, CHANGELOG.md, INSTALL.md, adr/
├── src/
│   ├── entrypoints/ popup/ browse/ content/ background/ options/
│   ├── features/    conversation/ rendering/ artifacts/ export/
│   │                cache/ tracking/ backup/ diagnostics/
│   ├── platform/    browser-API adapter — the ONLY place browser differences live
│   └── manifest.chrome.ts, manifest.firefox.ts
├── dist/            build output — gitignored
│   ├── chrome/      MV3
│   └── firefox/     MV3
├── releases/        vX.Y.Z/*.zip — gitignored, built artifacts
├── package.json, vite.config.ts, tsconfig.json
```

**Entrypoints are thin.** They wire up UI and call into `features/`. Business logic lives in `features/`; anything an entrypoint needs twice belongs in a feature module.

**There is no `shared/` or `utils/`.** Those names have no admission criteria and are how the old 1,065-line `utils.js` happened. If something doesn't fit an existing feature, it needs a new one.

## Build & Tooling

- **TypeScript** (`.ts`, not JSDoc), bundled by **Vite/Rollup** into `dist/chrome/` and `dist/firefox/`
- Both targets are **Manifest V3**. Chrome uses `background.service_worker`; Firefox uses an event page (`background.scripts`) — this is a manifest difference only, the background code is identical
- Manifests are generated from `.ts` sources, so `manifest_version`, the background key, the gecko block, and the per-branch extension name are build variables, never manual edits
- `jszip` is an npm dependency, not a vendored `jszip.min.js`
- Content scripts must build as **IIFE** bundles (no ESM in content script context). Extension pages may use ESM

## Code Style

- **Never use inline `export`.** Declarations stay bare; each file ends with a single `export { ... }` block
- TypeScript everywhere. No `.js` source files

## Testing

- **Vitest.** Tests are colocated with sources as `*.spec.ts` — no separate `tests/` directory
- Run from the repo root: `npm test` (one-shot) or `npm run test:watch`
- Because there is now one source tree, a tested module is tested for both browsers. The old "`firefox/utils.js` is a mirror the tests don't cover" gap is gone — do not reintroduce a parallel tree
- `node_modules/`, `dist/`, `releases/` and `package-lock.json` are gitignored and are never part of release ZIPs

## Git & Commits

**Auto-commit after every completed change.** Don't wait for the user to ask. After finishing a task (bug fix, feature, refactor), commit immediately with a clear message.

- The git repo is the repo root — no `cd` needed
- Write concise, descriptive commit messages focused on **why**, not which files moved
- Not: `wip`, `fix stuff`, `update`, `final FINAL (1)`
- Group related changes into one commit
- Don't push unless asked
- **Branching**: Do all development on `testing`. Merge to `main` only when creating a release

### Preserving history across moves

Git has no copy command; file history is reconstructed by rename/copy detection at read time. So:

- Use `git mv` for one-to-one moves
- **Never mix a move with a content change in the same commit.** Move (or copy) in one commit, rewrite in the next — otherwise detection fails and the trail is lost
- For files split into several modules, recover history with `git blame -C -C -C` and `git log --find-copies-harder`

## Documentation Upkeep

**After each commit**, update these files:

- **`docs/TODO.md`** — Move completed items to the Completed section, update the current version number, clean up any stale entries
- **`docs/CHANGELOG.md`** — Append a short entry under the current version. Format: `## [X.Y.Z]` header, then bullet points. One line per change is fine
- The CHANGELOG doubles as store update notes. All changes between the current version and the last `_Published_` marker are what goes into the store listing update

## Release Process

**Only create releases when explicitly asked.** Never auto-release.

A release now **requires running the build** — `dist/` is the artifact, not the source tree.

1. **Verify version** — bump `version` in `package.json`; both manifests derive from it
2. **Build** — `npm run build` produces `dist/chrome/` and `dist/firefox/`
3. **Verify the built manifests** — correct version, and the name has no "Beta" suffix on `main`
4. **Create release directory** — `mkdir -p releases/vX.Y.Z`
5. **ZIP each target** — zip the *contents* of `dist/chrome/` and `dist/firefox/` (Firefox unsigned; user handles .xpi signing via AMO)
6. **Git tag** — `git tag vX.Y.Z -m "Release vX.Y.Z"`
7. **Push tag** — `git push origin vX.Y.Z`
8. **Create GitHub release** — `gh release create vX.Y.Z releases/vX.Y.Z/* --title "vX.Y.Z" --notes "..."` — notes are all changes since the last `_Published_` marker
9. **Mark as published** — add `_Published_` after the released version's entries in `docs/CHANGELOG.md`, commit

## Critical Rules

### Browser differences live in `platform/` only
There is one source tree. Chrome/Firefox divergence is confined to `src/platform/` and the two manifest templates. Never fork a feature module per browser, and never reintroduce parallel `chrome/` + `firefox/` source trees — hand-syncing them was the single largest source of drift bugs in this project's history.

### Always bump the version on every change
Update `version` in `package.json` (the single source; manifests derive from it).

### background must inject ALL content script bundles
When re-injecting into already-open tabs on install/update, background must inject every content-script bundle the manifest declares. Injecting only some of them causes `X is not defined` errors on already-open tabs. If the build's content-script output changes, update the injection list.

### Multi-file exports must always be ZIPped
Any export producing more than one file always creates a ZIP — never trigger individual browser downloads.

### Extension name differs by branch
The extension name must be `Claude Exporter` on `main` and `Claude Exporter Beta` on `testing`, so the user can tell at a glance which build is loaded. This is a build variable — do not edit manifests by hand. The popup header reads it from the manifest (`#header-title` in `popup.js`), so it follows automatically.

### The Chat Cache is never migrated
Any change to the cache schema, or to the export request's query string, drops the object store. See [ADR-0002](docs/adr/0002-chat-cache-in-indexeddb.md) — migration code here has a best case identical to `clear()` and a worst case of silently exporting stale data.

## Architecture Notes

### Content Script Injection
- On fresh page loads: manifest `content_scripts` handles injection
- On extension install/update: background re-injects into already-open claude.ai tabs
- The content script has a double-injection guard (`window.claudeExporterContentScriptLoaded`) to prevent duplicate message listeners

### Export Flow
There is **one** export pipeline, in `features/export/`. Both callers go through it:
- **Popup "Export Current" / "Export All"** → message to the content script
- **Browse page** → loads the conversation list via content script relay (`sendMessageToClaudeTab`), then exports directly via `fetch()` to the claude.ai API

(Historically `browse.js` and `content.js` each had their own copy of this pipeline. They must not diverge again.)

### Chat Cache
- IndexedDB in the **extension origin**, so `browse` and `background` share it directly; the content script reaches it by messaging background
- Stores raw conversation API JSON keyed by UUID; a hit requires an exact `updated_at` match *and* a matching `requestSignature`
- Written immediately after each successful fetch, so cancelling an export interrupts rather than discards
- Disposable: excluded from Backup, dropped on schema change. Entries whose conversation was deleted upstream are **Orphans** — see CONTEXT.md

### Firefox MV3 host permissions
Firefox MV3 makes host permissions optional and user-revocable. The extension is useless without `https://claude.ai/*`, so it must detect the not-granted state and request it rather than silently failing.
