# Single TypeScript source tree with a bundler, Firefox on MV3

The extension shipped as two hand-synced near-duplicate trees (`chrome/`, `firefox/`) with no build step. Actual divergence measured at ~15 lines — `executeScript` API shape, three `browser.` vs `chrome.` calls, whitespace drift, and one unintended `min-width` difference — while `browse.js`/`utils.js`/`options.js` were byte-identical. We are collapsing to one TypeScript source tree built by Vite/Rollup into `dist/chrome/` and `dist/firefox/`, and migrating Firefox from MV2 to MV3 so the last code-level difference (the `executeScript` adapter) disappears and the browsers differ only by manifest template.

## Considered options

- **Keep two trees, add TypeScript to each.** Rejected: preserves the hand-sync rule that is itself the recurring bug source, and leaves `firefox/utils.js` permanently outside test coverage.
- **Keep Firefox on MV2.** Rejected once it was established there is no existing user base. The argument for staying — that MV3 would not unify the background model anyway, since Chrome requires a service worker and Firefox uses an event page — remains true, but it is a manifest difference rather than a code one. Firefox MV3 retains blocking `webRequest` and uses event pages, so the usual MV3 objections are Chrome-specific and do not apply to this extension, which uses neither `webRequest` nor persistent background state.

## Consequences

- Firefox MV3 makes host permissions optional and user-revocable at install. The extension is useless without `https://claude.ai/*`, so it must detect the not-granted state and request it rather than silently doing nothing.
- The release process no longer zips source. `dist/<target>/` is the artifact, so producing a release now _requires_ running the build — the "source is the artifact" property, and the ability to load the shipped code unpacked for debugging, is lost and only partly recovered by sourcemaps.
- Git history for `firefox/*` effectively ends.
- The per-branch manifest name (`Claude Exporter` vs `Claude Exporter Beta`) is gone entirely. It existed to distinguish the `testing` build from the `main` build at a glance; with `master` as the only branch there is nothing to distinguish, so the name is a constant.
- `jszip` becomes an npm dependency rather than a vendored `jszip.min.js`.
