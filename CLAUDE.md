# Claude Exporter

Chrome + Firefox MV3 extension. One TypeScript source tree in `src/`, built by Vite
into `dist/chrome/` and `dist/firefox/`. The repo root *is* the extension project.

## Critical rules

1. **NEVER reintroduce parallel `chrome/` + `firefox/` source trees.** Browser
   divergence lives ONLY in `src/platform/` and the two manifest templates.
   Hand-syncing parallel trees was this project's largest source of drift bugs.
2. **ALWAYS bump `version` in `package.json`** on every change. Both manifests
   derive from it; nothing else is a version source.
3. **Any export producing more than one file MUST be a ZIP.** Never trigger
   individual browser downloads.
4. **NEVER write Chat Cache migration code.** A cache-schema or request-signature
   change means dropping the object store. See ADR-0002 — migration's best case
   equals `clear()`, worst case is silently exporting stale data.
5. **background MUST inject every content-script bundle the manifest declares**
   when re-injecting into already-open tabs. A partial list causes
   `X is not defined`. Update the list whenever content-script output changes.
6. **NEVER `git merge`.** Integrate with `git rebase` only. `master` is the only
   long-lived branch.
7. **NEVER mix a file move with a content change in one commit** — rename
   detection fails and history is lost. `git mv` in one commit, rewrite in the next.

## Commands

| | |
|---|---|
| `npm test` / `npm run test:watch` | Vitest, from repo root |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | both targets into `dist/` |
| `npm run dev` | chrome build, watch mode |

## Code style (differs from defaults — the rest is standard TS)

- **Never use inline `export`.** Declarations stay bare; each file ends with a
  single `export { ... }` block.
- `.ts` only. No `.js` source files, no JSDoc typing.
- Tests colocate with sources as `*.spec.ts`. There is no `tests/` directory.
- **There is no `shared/` or `utils/`.** Those names have no admission criteria and
  are how the old 1,065-line `utils.js` happened. If it doesn't fit an existing
  feature, it needs a new one.
- Entrypoints are thin: they wire UI and call `features/`. Logic lives in `features/`.

## Domain language

Read **[CONTEXT.md](CONTEXT.md)** and use its terms exactly. In particular **Export
Record** (the user got a file) and **Chat Cache** (we hold the bytes) are independent
concepts, and "exported" is ambiguous between them.

Read **[docs/adr/](docs/adr/)** before proposing any change to the build, the storage
layer, or the browser targets — the rejected alternatives are the useful part.

## Gotchas

- Content and background build as **one self-contained IIFE each** (no ESM in
  content-script context) via a second Rollup pass in `vite.config.ts`.
  `inlineDynamicImports` is what forbids shared chunks, and Rollup rejects it with
  more than one input — so that pass runs **once per entry**. Extension pages may use ESM.
- Each page's HTML must reference its script as exactly
  `<script type="module" src="./index.ts">`. Any other form is silently not bundled.
- The build prints "✓ built" *before* emitting `content.js`/`background.js` — a green
  log does not mean they exist. Check the output dir.
- One export pipeline (`features/export/`), two callers: popup via the content script,
  browse directly from the extension origin. They each had a private copy once and
  drifted badly. They must not diverge again.
- All claude.ai HTTP lives in `features/conversation/api.ts`. `CONVERSATION_QUERY`
  must keep exactly one definition — ADR-0002 ties the Chat Cache's
  `requestSignature` to that exact string.
- The Chat Cache lives on the **extension origin only**. IndexedDB is partitioned by
  origin, so the content script (claude.ai) relays through background rather than
  opening its own — a second cache would duplicate hundreds of MB. ADR-0003.
- A cache hit needs an `updated_at` the caller got from the conversation list. Never
  loosen that to `>=`: it is the only variant that can serve a conversation missing
  its newest messages while reporting success.
- Firefox MV3 host permissions are optional and user-revocable, so the extension can
  be installed yet unable to reach claude.ai. Detect and request; never fail silently.
  Chrome always reports granted.
- The content script has a double-injection guard
  (`window.claudeExporterContentScriptLoaded`).

## After each change

Commit immediately without being asked — message says **why**, not which files moved.
Then update `docs/TODO.md` and `docs/CHANGELOG.md`. Don't push unless asked.

Releases run only when explicitly requested — never automatically. The procedure
lives in **[docs/RELEASE.md](docs/RELEASE.md)**.

This file is shared project memory — update it when a rule, structure, or recurring
bug pattern changes. Keep it short; edit existing sections rather than appending.

---

**Most-violated, repeated on purpose:** bump the version, rebase never merge,
multi-file export is always a ZIP, and the Chat Cache is never migrated.
