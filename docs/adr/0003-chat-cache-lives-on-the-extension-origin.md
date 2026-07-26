# The Chat Cache lives on the extension origin, reached by message from the content script

The Chat Cache has two readers. The browse page runs on the extension origin; the content script, which serves the popup, runs on `https://claude.ai`. IndexedDB is partitioned by origin, so "the cache" is not one thing unless we make it one. The cache lives on the extension origin — shared by the browse page, the options page and the background worker, all of which open it directly — and the content script reaches it by sending `cacheRead`/`cacheWrite` messages to the background worker.

The deciding constraint is size. ADR-0002 puts the cache in IndexedDB precisely because a large account's raw conversation JSON is plausibly hundreds of megabytes. A per-origin cache would store all of it twice, once for each export caller, which contradicts the reason the storage was chosen at all.

## Considered options

- **A cache per origin.** Rejected: correct, simple, and it doubles the disk footprint of the one feature whose footprint is already the design's binding constraint. It also means the popup path starts cold no matter how much the browse page has already downloaded, which is the common case — users browse, then export.
- **Move the fetch into the background worker so only one origin ever holds conversations.** Rejected: the fetch needs claude.ai session cookies, and while `credentials: 'include'` from an extension background context can carry them, that makes every export depend on cookie behaviour the browsers do not treat identically, and Firefox's revocable host permissions make it revocable at a second layer. The content script fetching is the arrangement that has always worked.
- **Have the content script write into extension-origin storage via `chrome.storage.local`.** Rejected by ADR-0002 on size, and it would sweep the cache into Backup.

## Consequences

- Each conversation the content script caches or reads crosses the extension messaging boundary as a structured clone. That is real cost, but it is paid against a network fetch it replaces, and only on the popup path — the browse page, which does the bulk exporting, talks to IndexedDB directly.
- `exportConversations` takes the cache as an injected `CachePort` rather than importing one. Only the caller knows which context it is in, and a pipeline that guessed would be wrong in one of the two.
- The quota latch is per-context. The background worker is torn down between events, so a full-disk condition detected during a popup export is forgotten once the worker restarts and will be rediscovered on the next write. This is accepted: the latch exists to avoid retrying pointlessly within a run, not to remember anything.
- Messages carry whole conversations, so the extension's message traffic now includes user content. It never leaves the browser, but anything that logs messages wholesale would now be logging conversation text.
