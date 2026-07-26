# Changelog

## [1.19.3]

**Install-from-source instructions pointed at directories deleted in v1.11.0.** They told you to load the `chrome/` and `firefox/` folders, which ADR-0001 collapsed into a single `src/` tree built into `dist/`, and they never mentioned building at all — so the section could not work as written. Adds the build step, corrects both load targets, and records the two Firefox facts that make a fresh install look broken: host permissions are optional under MV3 and start ungranted, and an already-open claude.ai tab needs a refresh before the content script is there.

Also notes that a temporary add-on needs no signing, `.xpi` or ZIP — it loads from `dist/firefox/manifest.json` directly.

## [1.19.2]

**Docs caught up with the two commits before them.** CLAUDE.md still quoted a backlog of ~192 arrow-function violations against a tree that has none, and TODO.md still described `eslint-plugin-tsconfig-paths` as registered. Both read as live work. The TODO entry survives, restated as the gap the removal leaves: `no-restricted-imports` bans parent-relative paths, but nothing checks that an import which _could_ use an alias does.

Also ignores `.claude/`, which holds session state and git worktrees — committing those adds embedded-repo gitlinks that no clone can resolve.

## [1.19.1]

**Dropped `eslint-plugin-tsconfig-paths`.** Its rule had been registered but `off` since the tooling landed, and keeping it wired cost an ESLint-8 compatibility shim, an ambient type declaration and a dependency, all to serve a rule that never ran. Three things were wrong with it here: it calls `context.getFilename()`/`getSourceCode()`, removed in ESLint 10; it feeds `path.normalize`d patterns to picomatch v2, which reads the resulting `\` as an escape character, so on Windows no alias ever matches and every relative import is reported as having no candidates; and it rewrites sibling imports too, which this project keeps relative on purpose.

`no-restricted-imports`' `../*` pattern already expresses the actual rule — parent-relative imports are banned, siblings are not — and it works on every platform. `vite-tsconfig-paths`, which is a different package and does the alias resolution in both Vite passes, is untouched.

## [1.19.0]

**The one-function-form rule is now enforced.** No behaviour changes; the conversion is syntactic.

- The last 66 `function` declarations became `const … = () =>`: all of `src/entrypoints/**` (browse 33, background 3, content 6, options 6, popup 6, popup/theme 3), plus `vite.config.ts` (5), `vitest.setup.ts` (2) and `manifest.config.ts` (1). Names and signatures are unchanged, so every `export { … }` block and spec still refers to the same bindings.
- Nothing needed reordering, and this was the tree where it could have gone wrong. Arrows are not hoisted, and unlike `features/`, entrypoints do run code at load. But every load-time statement in them is either a listener registration whose callback fires later (`DOMContentLoaded`, `pageshow`, click handlers) or — in `options/index.ts` and `content/index.ts` — a direct call to a helper that already sat above it. The build config is the same story: every plugin factory is reached only from the `defineConfig` callback.
- The rule's selector now exempts `Property[kind='get']` and `[kind='set']`. ESTree marks an accessor `method: false`, so the method-shorthand exemption never covered it, and the `get size()` on the Export Record book was being reported with no legal fix — a getter has no arrow form, and computing it eagerly would change when it evaluates. `features/tracking` is unchanged.
- The temporary severity downgrade for the two arrow selectors is deleted; `no-restricted-syntax` is back to `error` as originally specified. The separate `recommendedTypeChecked` downgrade (77 findings) stays.

## [1.18.1]

**`features/` and `platform/` now use arrow functions only.** No behaviour changes; the conversion is syntactic.

- 126 `function` declarations across `src/features/**` and `src/platform/**` became `const … = () =>`. Names, signatures, type guards and comments are unchanged, so the `export { … }` blocks and every spec still refer to the same bindings.
- Declaration order was left as written. Arrows are not hoisted, so this would break any module that calls a helper while it is still evaluating — but no module-level code in either tree calls anything, and every backwards reference (in `features/artifacts` and `features/rendering` especially) sits inside another function body that only runs after the module finished loading.
- One site does not convert and is not meant to: the `get size()` accessor on the Export Record book in `features/tracking`. A getter has no arrow form; the rule's selector needs to exempt accessors the way it already exempts method shorthands.
- `src/entrypoints/**` is still to do, so the temporary severity downgrade in `eslint.config.ts` stays for now.

## [1.18.0]

**Formatting joined the lint gate.** No behaviour changes; the extension builds the same features.

- Prettier is now installed and configured (`.prettierrc.json` — pure data, so the ban on `.js` sources and JSDoc typing costs nothing; `prettier.config.ts` was skipped because TS config support is still experimental). `lint` and `format` each split into an `:eslint` and a `:prettier` half, and `lint:fix` is gone.
- The whole tree was reformatted in one mechanical pass. Large diff, zero behaviour.
- `.gitattributes` pins the working tree to LF. Git for Windows enables `core.autocrlf` system-wide, which would otherwise fight `endOfLine: 'lf'` forever: `format` would rewrite every file and `prettier --check` would fail on a fresh clone.
- `baseUrl` is gone from `tsconfig.json` — deprecated, and unnecessary since TypeScript 4.1, which resolves `paths` against the tsconfig's own directory. Verified against all four consumers that read it independently: `tsc`, both `vite-tsconfig-paths` passes, vitest, and perfectionist's `tsconfig-path` import group.
- `tseslint.config()` gave way to ESLint core's `defineConfig()`; the former is deprecated in favour of it.

## [1.17.0]

**The import rules are now enforced by the build rather than by review.** No behaviour changes; nothing ships differently.

- ESLint 9 flat config in `eslint.config.ts` (TypeScript, loaded through `jiti` — the project bans `.js` sources). `no-restricted-imports` makes parent-relative imports and the forbidden `utils`/`helpers` directory names hard errors, which is what CLAUDE.md always said and nothing ever checked.
- `$`-prefixed, per-area tsconfig path aliases give those imports somewhere to go: `$features/*`, `$entrypoints/*`, `$platform`. `$` rather than `@` so they cannot be mistaken for npm scopes. All 82 parent-relative specifiers across `src/` were rewritten; sibling imports stay relative on purpose.
- Alias resolution is wired with `vite-tsconfig-paths` in **both** Vite passes. The IIFE pass that emits `content.js` and `background.js` calls `viteBuild` with `configFile: false` and therefore inherits no plugins at all — an outer-only registration builds the pages fine and then fails to resolve a single aliased import in the two bundles that matter most.
- `src/manifest.config.ts` is exempted from the import rules: `vite.config.ts` imports it through Vite's bare esbuild config loader, which applies neither tsconfig paths nor plugins, so it is the one module that cannot use an alias.
- `perfectionist` sorts imports, object literals, interfaces and unions; `eslint-config-prettier` stands down on formatting.
- `eslint-plugin-tsconfig-paths` is registered but its rule is off — see docs/TODO.md for the three separate reasons.
- Two temporary severity downgrades sit at the bottom of the config so the gate could be switched on at all: 192 `function` declarations awaiting arrow conversion, and 78 pre-existing type-checked findings. Both are tracked in docs/TODO.md and are to be deleted, not tuned.

## [1.16.0]

**Feature imports now name what they depend on.** Nine of the ten import edges into `features/conversation` existed because that folder was being used as the place to put anything that mentioned a Conversation, not because callers needed the Conversation domain. No behaviour changes.

- `ExportFormat`, `ArtifactFormat` and `ArtifactFile` left `conversation/types.ts`, whose own header says it holds shapes returned by the claude.ai API. None of them are: nothing on the wire has those shapes, and what `'markdown'` or `'original'` means is decided entirely inside `features/export` and `features/artifacts`. They now live with the code that gives them meaning.
- The browse table's view-model moved from `features/conversation/list.ts` to its own `features/conversation-list`. Its imports of `features/tracking` and `features/models` looked like a domain feature reaching upward into presentation concerns; under a truthful name it is a view-model composing two domain features, which is the ordinary direction. The move also exposed a relative import (`./types`) that had been silently resolving to `conversation/types`.
- `features/conversation/index.ts` — one function under the banner "Shared utility functions", the `utils.js` smell CLAUDE.md bans by name — became `conversation/branch.ts`. No `index.ts` was left behind, so `from '../conversation'` no longer resolves and callers must name the file they want.
- `features/rendering/index.ts` carried the same inherited "Shared utility functions" banner; it now describes what it does.

## [1.15.0]

**Conversation List extraction.** The browse table's filtering, multi-key sort stack and Selection (shift-range math included) moved out of `browse/index.ts` into a testable `features/conversation/list.ts` — previously this logic only existed inline against the DOM and had no test coverage. 33 new tests now cover shift-range selection and multi-key sorting.

- Selection changes (checkbox click, select-all, "select new/updated") no longer rebuild the whole table. They used to call the same full re-render used for a real View change, which threw away `document.activeElement` on every click (a keyboard user tabbed to a checkbox, pressed Space, and lost their place, dropping to `<body>`) and re-parsed/re-rendered the entire table — a visible freeze on a large conversation list. They now patch the existing checkbox nodes in place.
- Setting the Export Record book no longer re-filters the View. With the "New/updated" filter active, an exported row used to vanish and the "Showing X of Y" count drop the instant an export completed, and the shift-range anchor silently reset — neither happened before this extraction, so both are now explicitly documented as not-a-recompute in `ConversationList.setExportRecords`.
- The browse entrypoint no longer keeps its own copies of the Export Record book and the model book alongside the list's — the render path reads them through `list.isStale()`/`list.display()`, so sorting/filtering and rendering can no longer be pointed at different data by a future setter that only updates one side.
- The list's placeholder Export Record book was a second, divergent definition of "empty" (`isStale: () => true`) from `features/tracking`'s `emptyExportRecords()` (all-false). It now imports the real one.

## [1.14.0]

**`features/tracking` deepened.** Callers now get a queryable Export Record book (`isStale`, `staleCount`, `size`) instead of a raw `{ uuid: timestamp }` map, and no longer own cache invalidation themselves — `recordExports`/`markExported`/`clearExportRecords` return the post-write book directly.

- Reads and writes are serialised through a single-tail promise chain, so concurrent record writes within one JavaScript context stop losing each other. This is scoped honestly: it only orders operations _within_ one context — the browse page and the content script are separate contexts and can still clobber each other across a storage round-trip. The window is one round-trip wide and the merge is additive (per-uuid stamping, not object replacement), so the worst case is a lost update, not corruption.
- The export pipeline now writes the Export Record for every Conversation it succeeds on, from inside `features/export/`, so the four call sites that previously each had to remember to call `recordExports` themselves can no longer forget.
- Browse no longer writes the `exportTimestamps` storage key directly — it goes through `features/tracking` like every other caller.
- Fixed: a first-seen Conversation showed its raw API model in the browse table until the page was reloaded, instead of picking up the snapshot recorded moments earlier.

## [1.12.0]

**Chat Cache.** Conversations already downloaded are kept locally, so re-exporting the same chats skips the network entirely. This is what the 1.11.0 restructure was groundwork for. See ADR-0002 and ADR-0003.

- Raw API JSON is stored in IndexedDB keyed by conversation UUID. Because it is the raw response rather than rendered output, one entry serves every combination of export options — switching format, toggling artifacts or metadata no longer costs a refetch.
- A cached copy is used only when its `updated_at` exactly matches what the conversation list reports, and only when it was fetched under the current request shape. Any doubt is resolved by refetching: the cache can produce a miss, never a stale export.
- Entries are written immediately after each fetch, before conversion. Cancelling a large export now keeps everything it had already downloaded, instead of discarding all of it.
- The batch delay is skipped for batches served entirely from the cache, so a fully warm re-export runs at local speed.
- Options page gains a Chat Cache section showing how many conversations are cached, with a Clear Cache button. Clearing loses nothing but speed.
- The cache is not included in Backup, which stays a small settings-and-export-history file.
- If local storage fills up, caching stops and the export still completes and downloads normally — the browse page says so after reporting success.

**Notes**

- The popup's single-conversation export always refetches: it exports whatever chat is on screen without loading the conversation list, so it has no `updated_at` to check a cached copy against. It still populates the cache for later runs.
- The content script relays cache access through the background worker, because IndexedDB is partitioned by origin and a claude.ai-origin cache would be a second full copy of everything. See ADR-0003.
- Test suite grew from 134 to 158 tests.

## [1.11.0]

Structural release. No new user-facing features; the parts that changed behaviour are listed under "Behaviour changes" below.

- **One source tree.** The hand-synced `chrome/` + `firefox/` duplicate trees are gone, replaced by a single TypeScript tree in `src/` built by Vite into `dist/chrome/` and `dist/firefox/`. Measured divergence between the two old trees was ~15 lines, but keeping them in sync was this project's largest historical source of bugs. See ADR-0001.
- **Firefox migrated MV2 → MV3.** Both targets are now MV3 and differ only by manifest: Chrome uses `background.service_worker`, Firefox an event page. Firefox `strict_min_version` is now 109.
- **`utils.js` is gone**, split into `src/features/` modules: `conversation/` (types + all claude.ai HTTP), `export/`, `rendering/`, `artifacts/`, `models/`, `tracking/`, `backup/`, `diagnostics/`. Browser API differences are confined to `src/platform/`.
- **One export pipeline.** `browse.js` and `content.js` each carried their own copy and had drifted: browse fetched 3-at-a-time with DEFLATE compression, filename sanitisation and a progress modal; content was strictly serial with 500 ms sleeps, no compression and no sanitisation. Both now call `features/export`, taking browse's behaviour.
- `jszip` is an npm dependency inlined into the bundles, not a vendored `jszip.min.js`.
- Test suite grew from 54 to 134 tests, now covering backup merge semantics, export filenames, the export pipeline, the API layer and Export Record tracking — all previously untested.

**Behaviour changes**

- Popup "Export All" now fetches 3 conversations at a time instead of 1-every-500 ms — roughly 7× faster, but correspondingly more likely to hit claude.ai rate limiting on very large accounts.
- Popup exports are now DEFLATE-compressed and have their filenames sanitised, matching what the browse page already did.
- The browse page no longer needs an open claude.ai tab: it fetches directly from the extension origin rather than relaying through the content script.
- A single conversation that produces exactly one file now downloads that file directly instead of a one-entry ZIP.
- An export with chats disabled and no artifact options now reports "Nothing to export" instead of silently producing an empty ZIP.
- Firefox: the options page opens in a tab (`options_ui` with `open_in_tab`) rather than embedded in `about:addons`, where its 810px layout overflowed.
- Firefox: host permissions are optional and user-revocable under MV3, so popup, browse and options now detect the not-granted state and prompt for access instead of failing silently.

**Fixes**

- Export Records are no longer written for conversations that produced no file. Exporting with chats disabled and artifacts flat previously marked every selected conversation as exported — including the ones with no artifacts, which then stopped showing as needing export.
- Export Records are keyed by UUID rather than matched by conversation name, so conversations sharing a name no longer suppress each other's records.
- Cancelling an export during ZIP compression no longer downloads the file anyway.
- Filenames now come from the conversation's own title as returned by the API, so a chat renamed since the list was loaded exports under its current name.

## [1.10.17]

- Import Backup now asks merge-vs-replace **before** opening the file picker (was after). Click Import Backup → modal asks "Merge with current data" or "Replace all current data" + "Choose File…" → file picker opens → import runs with the chosen mode. Lets you back out before navigating filesystem, and removes the awkward two-step confirmation. The modal no longer shows file contents (snapshot/export counts, creation date), since the file isn't selected yet — file validation still happens after selection.
- `importBackup(file, onComplete)` → `importBackup(file, mode, onComplete)`; the modal helper is now `showImportModeModal(onConfirm)` and lives at the caller layer (options.js / browse.js) rather than inside `importBackup`.

## [1.10.16]

- "Export Selected" now exports every checked conversation, including ones currently hidden by the funnel filter or search. Before, the export was intersected with `filteredConversations`, silently dropping checked-but-not-visible chats. The header checkbox still operates only on visible rows (unchanged).

## [1.10.15]

- Fixed artifact extraction silently dropping all artifacts in conversations where Anthropic's `enabled_artifacts_attachments` setting is false. In that mode Claude uses the skills-runner `create_file` MCP tool instead of the legacy `artifacts` tool — same `display_content` shape (json_block with language / code / filename), different `tool_use.name`. The v1.9.1 strict allowlist (`name === 'artifacts'`) was rejecting it. Allowlist now accepts `'artifacts'` or `'create_file'`. Added two regression tests covering the create_file pattern and a negative case for non-artifact skills tools (`view`, etc.) that share the same display shape.

_Published_

## [1.10.14]

- Single-conversation export toast now includes the artifact count when applicable: `Exported: X with N artifact(s)` when artifacts were extracted, `Exported: X` otherwise. Tracked via a function-scope `artifactCount` set inside the extraction branch so the unified post-save toast can read it without restoring the old double-toast pattern.

## [1.10.13]

- Fixed duplicate toast on single-conversation export. `exportConversation` was emitting three toasts on a successful export ("Exporting X...", then a branch-specific "Exported: X with N artifact(s)" or "Exported: X (no artifacts found)", then the unified "Exported: X" at the end). Removed the branch-specific toasts in Chrome — the unified post-save toast already covers all branches. Firefox already had this pattern; Chrome had regressed.

## [1.10.12]

- Chrome/Firefox parity sync — multiple files had quietly drifted out of sync over recent edits. Brought Firefox into line with Chrome (the canonical copy per CLAUDE.md):
  - `popup.html`: removed Chrome typo `dd` after `--error-text: #ff9999;`; synced Firefox `label { margin: 6px 0 }` → `6px`
  - `browse.html`: synced Firefox `td { padding: 15px }` → `15px 20px`; removed stale `.btn-view` CSS from Firefox (cleanup missed in v1.10.9); bumped Firefox body `min-width` 1140 → 1200 and added `min-width: 1200px` to `.container` to match Chrome's recent layout tweak
  - `browse.js`: synced Firefox tooltip label `"Now using"` → `"Currently"`
  - `options.html`: synced Firefox `width: 800px` → `810px`
  - `content.js`: removed Firefox-only `[Claude Exporter]` debug `console.log` statements from the top of the file
- Two functional differences left untouched pending direction: `browse.js` toast handling in `exportConversation` differs (Chrome emits inline `showToast` calls per branch; Firefox has them removed with a `// Toast handled below after timestamp save` comment).

## [1.10.11]

- Browse table: checkbox column now `text-align: right` so the checkbox stays anchored to the right edge with consistent padding when the table grows on wider viewports (was `text-align: center`, which drifted the checkbox toward the middle of an expanding cell).
- Browse table: column headers get `white-space: nowrap` and slightly more `padding-right` (25px) so the header text always stays on one line and never collides with the sort-direction arrow.

## [1.10.10]

- Browse page `body { min-width: 1140px }` so the page itself never shrinks below the table's natural width. When the viewport is narrower, the page (not the table) scrolls horizontally — the table always displays all columns at full width, no clipping, no shrinking.

## [1.10.9]

- Removed the redundant "View" button from the browse table — the chat name in the Name column already links to the conversation. Dropped the button, its click handler, and the `.btn-view` CSS.
- Browse table no longer scrolls horizontally on its own. `.conversations-table` is back to `overflow: hidden`, so when the viewport is narrower than the table's `min-width` (now 1100px, was 1200px), the **page** scrolls horizontally instead of the table container. Cleaner — single scrollbar.

## [1.10.8]

- Narrow-viewport fix follow-up: `flex-wrap: wrap` cascaded down into `.export-controls-wrapper`, `.export-settings`, `.export-row`, and `.export-section` so the individual export-options checkboxes and dropdowns can wrap to multiple lines instead of forcing the body wider than the viewport. With the page no longer overflowing, the table's own `overflow-x: auto` scrollbar now actually does the work for the table.

## [1.10.7]

- Better narrow-viewport behavior on the browse page:
  - Header `.controls` now wrap (`flex-wrap: wrap`) so search/filter/export controls flow to multiple rows on narrow windows instead of forcing the whole page wider than the viewport
  - Table given `min-width: 1200px` so the v1.10.6 `overflow-x: auto` on `.conversations-table` actually triggers — table scrolls horizontally within its container instead of getting cramped or clipped

## [1.10.6]

- Fixed browse table being cut off on the right when the browser window is narrower than the table — `.conversations-table` was `overflow: hidden`, which clipped and suppressed any scrollbar. Now `overflow-x: auto`, so the table scrolls horizontally when needed while keeping rounded corners.

## [1.10.5]

- Slimmed the Contact & Diagnostics section: replaced the three buttons (Email developer / Generate diagnostics / Clear log) with two inline links in a single sentence. "Clear log" removed entirely — and `clearDiagnosticsLog` dropped from `utils.js` since nothing calls it.
- Added a `.section a` link style so anchors inside option sections pick up the page's `--link-color` and `--primary-hover` instead of falling back to browser defaults

## [1.10.4]

- Browse page settings dropdown (and other UI controls) are now interactive immediately on page load — `setupEventListeners()` runs right after `initTheme()` instead of waiting for `loadConversations()` to finish. The settings gear, filter funnel, search bar, and sort headers all work while conversations are still loading.

## [1.10.3]

- New Options section: **Contact & Diagnostics**
  - **Email developer** — opens a mailto with a pre-filled subject including the version and a short body template
  - **Generate diagnostics** — downloads `claude-exporter-diagnostics-YYYYMMDD-HHMMSS.json` (extension/browser version, counts of stored records, current preferences, `orgIdConfigured` boolean, and the last 50 captured errors)
  - **Clear log** — wipes the captured error ring buffer
- Each context (popup / browse / content script / options) now registers `error` and `unhandledrejection` listeners that push sanitized entries to a 50-entry ring buffer in `chrome.storage.local` (`errorLog` key, FIFO). All UUIDs are replaced with `<id>` at capture time so identifiers are never persisted.
- Privacy stance: nothing is transmitted automatically. The diagnostics file stays local until the user chooses to attach it. Org ID itself is never included (only a boolean indicating whether one is configured). No conversation content is captured.

## [1.10.2]

- Removed "Test connection" from the browse settings dropdown — it's already available in Advanced Options (next to Save Settings)
- Model column "*" bounce marker now matches the badge color per family (Sonnet/Opus/Haiku/default), full opacity
- Tooltip on bounced model cells now fires when hovering the badge or the asterisk (wrapped in a `.model-cell` with the `title` attribute)
- Popup header title is now read from `manifest.name`, so the testing branch's "Claude Exporter Beta" appears in the popup automatically. CLAUDE.md updated.

## [1.10.1]

- Browse page funnel menu: new "Search projects" option (below the existing status filters, separated by a divider). When selected, the search bar matches against project names (placeholder updates to "Search projects by name...") and the table shows conversations whose project name matches. Status filters do not apply in this mode.

## [1.9.17]

- Reverted v1.9.16's two-column Model Display layout — the original stacked layout reads cleaner, especially with the longer descriptions

## [1.9.16]

- Browse dropdown's "Edit Org ID" and "Advanced Options" now open the options page in the **same tab** instead of a new one — the browser back button returns to the browse view
- Browse page reloads itself on bfcache-restored pageshow, so preference changes (model display, date/time format) take effect after hitting Back without needing a manual refresh
- Options page: Model Display radios laid out in a two-column grid

## [1.9.15]

- Backup filename revised to `claude-exporter-backup-YYYYMMDD-HHMMSS.json` (was `claude-database-YYYY-MM-DDTHH-MM-SS.json` in v1.9.14). Matches the YYYYMMDD-HHMMSS timestamp format used by conversation/artifact exports

## [1.9.14]

- Backup filename changed from `claude-exporter-backup-(timestamp).json` to `claude-database-(timestamp).json`
- Browse table Model column display is now configurable. Defaults to **Original** (first-seen model, the v1.9.4 behavior); a new "Model Display" section in Options lets you switch to **Current** (v1.9.12 behavior)
- Bounced chats keep the `*` marker in either mode; the tooltip now shows "Originally X" when displaying current, and "Now using X" when displaying original

## [1.9.13]

- Backup/Restore renamed throughout to **Export Backup** / **Import Backup** (options page buttons + browse dropdown items)
- Import now opens a custom modal showing backup contents (counts + creation date) with two modes:
  - **Merge** (default) — adds entries not present locally; keeps your current values when they overlap (per-sub-key for UUID-keyed records like exportTimestamps / modelSnapshots)
  - **Replace all** — overwrites everything with the backup's contents (the prior behavior)
- Modal supports keyboard (Esc to cancel, Enter to import) and closes when clicking outside

## [1.9.12]

- Browse table Model column now shows the chat's **current** model (was: original/first-seen, since v1.9.4). Bounced chats — where the current model differs from the first-seen one — get a `*` asterisk marker with a "Originally X" tooltip
- Rationale: the cell now reflects what model the chat will actually use if you reopen it; the original is still discoverable via the asterisk tooltip
- Sort by Model column follows the new (current) display name

## [1.9.11]

- Options page: merged "Test Connection" into the Organization ID section (next to Save Settings) and dropped the standalone "Test Your Settings" section
- Options page: button text now vertically centered (inline-flex + line-height reset; was inheriting body's 1.6 line-height)
- Options page: Date format and Time format now sit side-by-side in a two-column grid instead of stacked
- Mirrored prior `chrome/options.html` CSS tweaks (page width 800px, button padding, `.section h3` margins) into `firefox/options.html` — Firefox copy had fallen behind

## [1.9.10]

- Popup org-ID error now reads "Failed to obtain organization ID: Please set this value in Options." with "Options" as a clickable link that opens the options page
- Lowercased "Claude.ai" → "claude.ai" in all user-facing strings (popup, browse, options) to match the actual domain

## [1.9.9]

- Removed the "Organization ID not configured" setup banner from the popup — org ID is auto-detected from claude.ai on every export action, so the banner was redundant
- Updated the fallback error message when org ID detection fails: now suggests opening the popup from a claude.ai tab instead of pointing at the removed setup link

## [1.9.8]

- Markdown export now includes the `truncated` flag in the metadata block (when present in the conversation data)
- Markdown export now shows file attachment metadata per message (`file_name`, `file_size`, `file_type`) — not just `extracted_content`. File attachments render as `### Attachment: <name> _(size, type)_`; pasted content keeps the legacy `### Pasted` label.

## [1.9.7]

- Reorganized the browse settings dropdown: Date and Time format toggles moved to the options page; their slot now holds a "Backup/Restore Database" item with a hover submenu (Backup / Restore)
- Backup & Restore logic moved into shared `utils.js` so the options page and browse dropdown use one implementation
- Options page gains a "Date & Time Format" section

## [1.9.6]

- Added an "Advanced Options" link to the browse page settings dropdown (between Time and Test connection) — opens the options page, making Backup & Restore reachable directly from the browse view

## [1.9.5]

- Added Backup & Restore to the options page — download all extension data (model snapshots, export history, preferences) to a JSON file and restore it later
- Survives uninstall/reinstall, and lets you move data between browsers, devices, or extension builds (e.g. store version ↔ GitHub build)

## [1.9.4]

- Browse table's Model column now shows each chat's original (first-seen) model from the snapshot data, falling back to the current/inferred model when no snapshot exists
- Bounced chats (original model differs from current) get a `→` marker with a tooltip showing "Originally X, now Y"
- Model column sorting follows the displayed (original) model

_Published_

## [1.9.3]

- Snapshot each conversation's current model to `chrome.storage.local` whenever the conversation list is fetched (browse page load or popup "Export All") — preserves the model before a chat gets bounced to a new one on model retirement
- Records first-seen model, current model, and a change history per conversation; only the raw API model is stored, never an inferred guess

## [1.9.2]

- Added Vitest test harness for `utils.js` (52 tests covering export logic, model name parsing, artifact extraction)
- Extracted model utilities (`formatModelName`, `getModelBadgeClass`, `DEFAULT_MODEL_TIMELINE`) out of `content.js`/`browse.js` into shared `utils.js`
- Doc-linked the Anthropic model-ID schema in code comments

## [1.9.1]

- Fixed Model column header alignment with badge text on browse page
- Single-conversation "Export All" no longer wraps the file in a ZIP
- Progress modal now resets bar/stats/text on each open instead of carrying over from the previous run
- Progress modal closes immediately on Cancel instead of waiting for the in-flight batch
- Artifact extraction now filters by `tool_use.name === 'artifacts'` so bash/web_search/repl tool calls can't slip through as fake artifacts
- Fixed model name display when version has no minor (e.g. `claude-opus-4-20250514` now renders as "Claude Opus 4" instead of "Claude Opus 4.20250514")
- Light mode contrast pass: deeper model badge colors, View button border, refined palette aligned with popup
- Click the org ID row in the browse settings dropdown to copy it to the clipboard

_Published_

## [1.9.0]

- Settings dropdown menu on browse page (replaces theme toggle button)
  - Theme toggle (light/dark)
  - Org ID display with link to edit
  - Mark all as exported / Mark all as new
  - Test connection
- Settings gear icon in popup header (opens options page)

_Published_

## [1.8.13]

- Track export timestamps per conversation in chrome.storage.local
- Green dot indicator on browse page for new/updated conversations
- Status filter dropdown (All / New+Updated / Previously exported)
- Auto-select new/updated conversations on browse page load
- Stats bar shows new/updated count
- Timestamps recorded across all export flows (popup, browse, bulk)

## [1.8.12]

- Auto-detect organization ID from Claude.ai API on every export action
- No more stale org ID issues when users switch organizations
- Correctly selects the chat org (not API org) when multiple orgs exist
- Falls back to manually configured org ID if auto-detect fails
- Export buttons no longer disabled on popup load

## [1.8.11]

- 403/404 errors now show a helpful message with a link to org ID settings

## [1.8.10]

- Replaced PNG popup header with CSS gradient header
- Removed popup-header.png dependency
- Integrated version display into gradient header

## [1.8.9]

- Added version number display centered below popup header

_Published_

## [1.8.8]

- Export All from popup now always creates a ZIP for all formats (JSON, markdown, text)
- JSON Export All now fetches full conversation data (was only exporting summary list)
- background.js now re-injects all content scripts (jszip, utils, content) on install/update
- Removed stale export_summary.json toast reference

## [1.8.7]

- Added Claude Sonnet 4.6 model to default timeline
- Replaced hardcoded MODEL_DISPLAY_NAMES with smart model name parsing
- Fixed model name regex to handle dateless model strings (e.g., `claude-sonnet-4-6`)
- Removed `plaintext` language tag from thinking/pasted quadruple-backtick blocks
- Added Chrome Web Store and Firefox Add-ons links to README

## [1.8.6]

- Published to Chrome Web Store and Firefox Add-ons
- Bumped version for store submission

## [1.8.5]

- Switched to `### Thinking` / `### Pasted` headers with quadruple-backtick code blocks
- Fixed pasted text attachments missing from markdown export
- Removed redundant bug tracking from TODO

## [1.8.2]

- Multi-level sorting with shift+click
- Skip ZIP for single-file exports
- Shortened "Last Updated" table header to "Updated"

## [1.8.0 - 1.8.1]

- Full Firefox support with Manifest V2
- Mozilla-signed .xpi for permanent installation
- Theme syncing between popup and browse window
- Local timezone support in export filenames
- Cleaner filename format (YYYYMMDD-HHMMSS)
