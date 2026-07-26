// Background: injects the content script where the manifest could not.
//
// Must stay valid for both Chrome (service worker) and Firefox (event page):
// no DOM, and no module-level state that has to survive a restart — the worker
// is torn down between events, so anything held here is gone by the next one.

import { injectScript, onInstalled, onMessage, queryTabs } from '../../platform';
import type { EnsureContentScriptRequest } from '../content/messages';

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
  console.log('Claude Exporter installed/updated — re-injecting into open claude.ai tabs');
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

export { CONTENT_SCRIPT_FILES, ensureContentScript };
