# Chat Cache stores raw API JSON in IndexedDB, validated by `updated_at`

Bulk export refetches every selected conversation every time, and the network round-trip is the only slow part — conversion is local CPU. We are adding a Chat Cache holding the **raw conversation API JSON** (not rendered output) in IndexedDB, keyed by conversation UUID, treated as a hit when the stored `updated_at` exactly equals the value from the conversation list.

Raw JSON rather than rendered files because every export option — format, metadata, thinking, artifacts, flattening — is then re-derived locally, so one entry serves all option combinations and toggling an option stays instant instead of invalidating the cache. IndexedDB rather than `chrome.storage.local` because the payload is plausibly hundreds of megabytes across a large account, which exceeds Chrome's 10 MB `storage.local` cap and would otherwise require adding `unlimitedStorage` to a listing that currently declares no data collection.

## Considered options

- **`>=` instead of exact equality on `updated_at`.** Rejected: it is the only variant that can produce a false _hit_, and a false hit means silently exporting a conversation missing its most recent messages. Both designs fail safe toward refetching; only strict equality fails safe in every direction.
- **Hashing the response body.** Rejected: evaluating the predicate requires the fetch, so it can never avoid one.
- **LRU eviction under a byte cap.** Rejected: the cache's natural ceiling is the account's total conversation volume, and eviction would routinely discard the entry about to be needed.

## Consequences

- Records carry a `requestSignature` covering the export query string (`tree=True&rendering_mode=messages&render_all_tools=true`). Without it, changing the request shape leaves records that still pass the `updated_at` check while holding a response the exporter no longer asks for — silently wrong output with no error.
- **The cache is never migrated.** Any schema or signature change drops the object store. Migration code here has a best case identical to `clear()` and a worst case of silently wrong exports.
- Excluded from Backup. Backup remains a small settings-and-Export-Records file; including the cache would make it hundreds of megabytes and hang the page on `JSON.stringify`. Note what actually enforces this: `backupExtensionData` calls `chrome.storage.local.get(null)` — a wholesale dump, _not_ an allowlist — so the exclusion holds only because the cache lives in IndexedDB. Anything cache-sized ever added to `chrome.storage.local` would be swept into Backup silently.
- Entries are written immediately after each successful fetch, before conversion. Cancelling an export therefore interrupts rather than destroys — currently a cancelled run discards everything it fetched.
- `QuotaExceededError` latches for the session, disables further cache writes, and shows a persistent banner. It must never fail the export itself: the bytes are already in memory and the ZIP is unaffected.
- Cached conversations deleted upstream become **Orphans**, for which the cache is the only remaining copy. This sits in tension with treating the cache as disposable; it is resolved by making Orphans exportable and visible rather than by making the cache durable.
