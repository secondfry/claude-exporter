# Claude Exporter

A Chrome and Firefox extension that pulls your claude.ai conversations off the
site and writes them to local files — one at a time, or thousands at once as a
ZIP.

It keeps track of what you have already exported and what has changed since, and
it caches conversation content locally so re-exporting the same chats does not
touch the network again.

> This is a fork of [agoramachina/claude-exporter](https://github.com/agoramachina/claude-exporter),
> which is itself a fork of [socketteer/Claude-Conversation-Exporter](https://github.com/socketteer/Claude-Conversation-Exporter).
> It has its own add-on identity and is **not** the build published in the browser
> stores. See [Installation](#installation).

---

## What it does

**Export**

- Export the conversation you are reading, straight from the claude.ai page
- Bulk export any selection of conversations as a single ZIP — never a flood of
  individual downloads
- Three formats: **JSON** (complete, all branches), **Markdown**, **Plain text**
- Extract artifacts as real files, nested per conversation or flattened into one
  folder, or both at once
- Choose what goes in: messages, extended thinking, metadata headers, attachments

**Browse**

- A sortable, searchable table of every conversation on your account
- Multi-column sort (shift-click), search by conversation name or by project
- Filter by export state: never exported, updated since export, previously
  exported, or everything still pending
- Model column that survives a model bounce — the extension snapshots which model
  a conversation used when it first saw it, so a chat started on an older model
  does not silently relabel itself when claude.ai moves it

**Remember**

- **Export Records** — a green dot marks conversations you have never exported and
  ones you have edited since. Bulk export auto-selects exactly those.
- **Chat Cache** — conversation content already downloaded is kept in IndexedDB
  and reused. A cached copy is only used while claude.ai still reports the same
  last-updated time, so an edited chat is always refetched. Clearing it loses
  nothing but speed.
- **Backup & Restore** — save your Export Records, model snapshots and preferences
  to a file and restore them in another browser or another build. Deliberately
  does not include the Chat Cache.

Everything runs in your browser against your own logged-in session. No data goes
anywhere else.

---

## Installation

Full instructions, including troubleshooting, are in
**[docs/INSTALL.md](docs/INSTALL.md)**.

The short version for this fork:

```bash
npm install
npm run build          # writes dist/chrome/ and dist/firefox/
```

- **Chrome** — `chrome://extensions/`, enable Developer mode, **Load unpacked**,
  select `dist/chrome/`.
- **Firefox, for development** — `about:debugging` → **Load Temporary Add-on**,
  select `dist/firefox/manifest.json` (the file, not the folder). Dropped on
  restart.
- **Firefox, permanently** — `npm run sign:firefox` signs the build through your
  own AMO account on the unlisted channel, then install the `.xpi` from
  `releases/signed/` via `about:addons`. Release and Beta Firefox will not load an
  unsigned add-on at all, whatever `about:config` claims.

Firefox users: MV3 host permissions are optional and start **ungranted**, so the
extension can install and still be unable to reach claude.ai. Grant access under
`about:addons` → Claude Exporter → Permissions, then refresh any open claude.ai
tab. Chrome grants them at install time.

Then set your Organization ID on the options page — or just export something; it
is auto-detected on every export action.

---

## Usage

**One conversation** — open it on claude.ai, click the extension icon, pick a
format, click Export Current Conversation.

**Many** — click the extension icon → Browse All Conversations. Filter and sort to
what you want, select rows (shift-click for ranges), pick your format and options,
Export Selected. A progress dialog reports how many came from the Chat Cache.

**Everything** — Export All from the popup, without opening the browse page.

---

## Formats

| Format         | Branches                        | Best for                                |
| -------------- | ------------------------------- | --------------------------------------- |
| **JSON**       | All, plus every message version | Preservation, scripting, re-import      |
| **Markdown**   | Current branch only             | Reading, documentation, sharing         |
| **Plain text** | Current branch only             | Pasting into another model or an editor |

Markdown renders thinking blocks, pasted text and attachment metadata under their
own headings. Code artifacts always keep their original file type; prose artifacts
follow your chosen format.

---

## Known limitations

- **Plain text and Markdown export the current branch only.** JSON is the only
  format that preserves alternate branches. If a conversation matters, export JSON.
- **The API does not record which model wrote which message.** `conversation.model`
  is the _current_ model. The extension's own snapshots are the only record of what
  a chat started on, and they only cover chats it has seen — for older ones the
  original model is unrecoverable.
- **Orphans are not yet reachable.** If a conversation is deleted from claude.ai,
  its Chat Cache entry may be the last copy in existence, but the browse table is
  built from the live conversation list, so it no longer appears. Do not treat the
  Chat Cache as an archive; the exported file is the archive.
- **Cancel is not immediate.** Stopping a bulk export hides the dialog, but fetches
  already in flight run to completion.
- **A VPN can produce 403s** from the claude.ai API.
- Very large exports take minutes, and very old conversations occasionally use data
  shapes that fail to convert — the ZIP includes a summary listing anything skipped.
- Development and testing happen primarily in Firefox.

---

## Development

One TypeScript source tree in `src/`, built by Vite into `dist/chrome/` and
`dist/firefox/`. Both targets are Manifest V3 and share identical JavaScript; they
differ only in `manifest.json`. Browser divergence is confined to `src/platform/`.

| Command                |                              |
| ---------------------- | ---------------------------- |
| `npm run build`        | both targets into `dist/`    |
| `npm run dev`          | Chrome build, watch mode     |
| `npm test`             | Vitest                       |
| `npm run typecheck`    | `tsc --noEmit`               |
| `npm run lint`         | ESLint                       |
| `npm run format`       | Prettier                     |
| `npm run sign:firefox` | build + AMO unlisted signing |

```
src/
├── entrypoints/   popup, browse, options, content script, background worker
├── features/      artifacts, backup, cache, conversation, conversation-list,
│                  diagnostics, export, models, rendering, tracking
└── platform/      the only place Chrome and Firefox differ in code
```

Entrypoints are thin — they wire UI and call into `features/`. There is one export
pipeline (`features/export/`) with two callers, and it must stay that way; the
private copies they used to have drifted badly.

Before changing anything structural, read:

- **[CONTEXT.md](CONTEXT.md)** — the domain glossary. _Export Record_ ("the user
  got a file") and _Chat Cache_ ("we hold the bytes") are independent concepts, and
  "exported" is ambiguous between them.
- **[docs/adr/](docs/adr/)** — why the single source tree, why IndexedDB, why the
  cache lives on the extension origin. The rejected alternatives are the useful
  part.
- **[CLAUDE.md](CLAUDE.md)** — the rules that are easy to violate by accident.

[docs/TODO.md](docs/TODO.md) is the backlog; [docs/CHANGELOG.md](docs/CHANGELOG.md)
records why each version changed.

---

## Privacy

The extension talks to claude.ai using your existing browser session and nothing
else. There is no server, no telemetry, and no third party. Exports are written by
your browser's own download mechanism; the Chat Cache never leaves your machine.

---

## Acknowledgments

- Forked from [agoramachina/claude-exporter](https://github.com/agoramachina/claude-exporter),
  originally [socketteer/Claude-Conversation-Exporter](https://github.com/socketteer/Claude-Conversation-Exporter)
- ZIP archives via [JSZip](https://stuk.github.io/jszip/)
- Written in collaboration with Claude Code

---

**Not affiliated with Anthropic.** This is a community tool built on the endpoints
the claude.ai web interface uses.
