// Background: injects the content script where the manifest could not.
//
// Must stay valid for both Chrome (service worker) and Firefox (event page):
// no DOM, and no module-level state that has to survive a restart — the worker
// is torn down between events, so anything held here is gone by the next one.

import type { EnsureContentScriptRequest } from '$entrypoints/content/messages';
import {
  cacheStats,
  clearCache,
  readConversation,
  writeConversation,
} from '$features/cache';
import type { CacheRequest } from '$features/cache/messages';
import { onInstalled, onMessage } from '$platform';

import { ensureContentScript, injectIntoOpenClaudeTabs } from './injection';

// Fresh page loads are handled by the manifest; this covers claude.ai tabs
// that were already open when the extension was installed or updated.
onInstalled(() => {
  console.log(
    'Claude Exporter installed/updated — re-injecting into open claude.ai tabs',
  );
  void injectIntoOpenClaudeTabs();
});

onMessage((request: EnsureContentScriptRequest) => {
  if (request?.action !== 'ensureContentScript') return undefined;
  return ensureContentScript();
});

/**
 * The Chat Cache, on behalf of the content script.
 *
 * IndexedDB is partitioned by origin, so the content script's claude.ai origin
 * cannot see the cache the browse page and this worker share. Without this
 * relay the popup path would build a second copy of every conversation — and
 * the cache's size is the entire reason ADR-0002 keeps it out of
 * chrome.storage.local. Serving it from here costs one structured clone of the
 * JSON per conversation, which is cheap next to the fetch it replaces.
 */
const routeCache = (request: CacheRequest): Promise<unknown> | undefined => {
  switch (request?.action) {
    case 'cacheClear':
      return clearCache().then(() => ({ success: true }));

    case 'cacheRead':
      return readConversation(request.uuid, request.updatedAt).then(
        (conversation) => ({
          conversation,
          success: true,
        }),
      );

    case 'cacheStats':
      return cacheStats().then((stats) => ({ stats, success: true }));

    case 'cacheWrite':
      return writeConversation(request.conversation).then((status) => ({
        status,
        success: true,
      }));

    default:
      return undefined;
  }
};

onMessage(routeCache);

export { routeCache };
