// Re-injecting the content script into tabs the manifest never reached.
//
// Split out of index.ts, which registers listeners at module load: this module
// is inert on import, so a spec can drive it. No DOM and no module-level state
// that has to survive a worker restart.

import { injectScript, queryTabs } from '$platform';

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

/**
 * Inject into one tab, or do nothing.
 *
 * A failure here is survivable and expected in normal use: the tab may be a
 * restricted URL the extension has no host access to (a chrome:// page, the
 * Web Store, a PDF viewer), or it may have navigated away mid-injection. In
 * every one of those cases the tab simply has no content script, which is what
 * it had a moment ago — there is nothing to recover and nothing to tell the
 * user. Duplicate injection is not a failure mode: the content script's own
 * `claudeExporterContentScriptLoaded` guard covers it.
 */
const injectInto = async (tabId: number | undefined): Promise<void> => {
  if (tabId === undefined) return;
  try {
    await injectScript(tabId, CONTENT_SCRIPT_FILES);
  } catch (error) {
    console.warn(
      new Error(`Could not inject the content script into tab ${tabId}`, {
        cause: error,
      }),
    );
  }
};

/** Every claude.ai tab that was already open. Never rejects. */
const injectIntoOpenClaudeTabs = async (): Promise<void> => {
  try {
    const tabs = await queryTabs(CLAUDE_TABS_QUERY);
    await Promise.all(tabs.map((tab) => injectInto(tab.id)));
  } catch (error) {
    console.warn(
      new Error('Could not enumerate open claude.ai tabs', { cause: error }),
    );
  }
};

/**
 * Make sure the active tab has the content script.
 *
 * The popup asks for this before messaging the content script, since the tab
 * may predate the extension (or the script may have been evicted).
 */
const ensureContentScript = async (): Promise<{ success: true }> => {
  const tabs = await queryTabs({ active: true, currentWindow: true });
  await injectInto(tabs[0]?.id);
  return { success: true };
};

export {
  CONTENT_SCRIPT_FILES,
  ensureContentScript,
  injectInto,
  injectIntoOpenClaudeTabs,
};
