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
import { injectScript, onInstalled, onMessage, queryTabs } from '$platform';

/**
 * Must list EVERY content-script bundle declared in `content_scripts` in
 * src/manifest.config.ts. The manifest injects on fresh page loads; this list
 * covers tabs that were already open on install/update. Injecting a subset
 * leaves those tabs throwing "X is not defined" — see CLAUDE.md.
 *
 * It is one file because content.js builds as a self-contained IIFE with jszip
 * bundled in. If the build ever emits a second content-script chunk, add it
 * to the manifest and to this array together.
 */
const CONTENT_SCRIPT_FILES = ['content.js'];

const CLAUDE_TABS_QUERY = { url: 'https://claude.ai/*' };

async function injectInto(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  try {
    await injectScript(tabId, CONTENT_SCRIPT_FILES);
  } catch (error) {
    // Expected for tabs we have no host access to, or that navigated away
    // mid-injection. The content script's own guard covers the duplicate case.
    console.log('Could not inject content script into tab', tabId, error);
  }
}

// Fresh page loads are handled by the manifest; this covers claude.ai tabs
// that were already open when the extension was installed or updated.
onInstalled(() => {
  console.log(
    'Claude Exporter installed/updated — re-injecting into open claude.ai tabs',
  );
  queryTabs(CLAUDE_TABS_QUERY)
    .then((tabs) => Promise.all(tabs.map((tab) => injectInto(tab.id))))
    .catch((error) => console.log('Could not enumerate claude.ai tabs', error));
});

// The popup asks for this before messaging the content script, since the tab
// may predate the extension (or the script may have been evicted).
async function ensureContentScript(): Promise<{ success: true }> {
  const tabs = await queryTabs({ active: true, currentWindow: true });
  await injectInto(tabs[0]?.id);
  return { success: true };
}

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
function routeCache(request: CacheRequest): Promise<unknown> | undefined {
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
}

onMessage(routeCache);

export { CONTENT_SCRIPT_FILES, ensureContentScript, routeCache };
