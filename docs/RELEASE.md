# Release Process

**Only create releases when explicitly asked.** Never auto-release.

A release requires running the build — `dist/` is the artifact, not the source tree.

1. **Verify version** — bump `version` in `package.json`; both manifests derive from it
2. **Build** — `npm run build` produces `dist/chrome/` and `dist/firefox/`
3. **Verify the built manifests** — correct version and target-appropriate `background`
   key (`service_worker` for Chrome, `scripts` for Firefox), and check that _every_
   file the manifest references actually exists in the output. Do not trust a green
   build log: the second Rollup pass that emits `content.js` and `background.js` runs
   in `closeBundle`, after the main build has already printed its success summary, so
   a failure there is easy to read past. `content.js` must also be a plain IIFE —
   `grep -cE '^(import|export)' dist/*/content.js` must report 0.
4. **Create release directory** — `mkdir -p releases/vX.Y.Z`
5. **ZIP each target** — zip the _contents_ of `dist/chrome/` and `dist/firefox/`
   (Firefox unsigned; the user handles .xpi signing via AMO)
6. **Git tag** — `git tag vX.Y.Z -m "Release vX.Y.Z"`
7. **Push tag** — `git push origin vX.Y.Z`
8. **Create GitHub release** — `gh release create vX.Y.Z releases/vX.Y.Z/* --title "vX.Y.Z" --notes "..."`
   — notes are all changes since the last `_Published_` marker
9. **Mark as published** — add `_Published_` after the released version's entries in
   `docs/CHANGELOG.md`, commit

`node_modules/`, `dist/`, `releases/` and `package-lock.json` are gitignored and are
never part of release ZIPs.

The CHANGELOG doubles as store update notes: everything between the current version
and the last `_Published_` marker is what goes into the store listing update.

## Recovering history across file moves

Git has no copy command; file history is reconstructed by rename/copy detection at
read time. When a file was split into several modules, recover its history with
`git blame -C -C -C` and `git log --find-copies-harder`.
