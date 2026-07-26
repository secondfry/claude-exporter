import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONTENT_SCRIPT_FILES,
  ensureContentScript,
  injectInto,
  injectIntoOpenClaudeTabs,
} from './injection';

// Characterization tests for content-script re-injection.
//
// Every path here is one the user never sees: injection runs on install and
// just before the popup messages the tab. So the contract that matters is that
// a failure is swallowed rather than propagated — and, on the other side, that
// the file list is complete, because a partial one leaves the page throwing
// "X is not defined" (CLAUDE.md rule 5).

const setTabs = (tabs: unknown[]): void => {
  vi.mocked(chrome.tabs.query).mockImplementation(((
    _query: unknown,
    callback?: (found: unknown[]) => void,
  ) => {
    if (callback) return callback(tabs);
    return Promise.resolve(tabs);
  }) as typeof chrome.tabs.query);
};

const setInjectResult = (respond: () => unknown): void => {
  vi.mocked(chrome.scripting.executeScript).mockImplementation(async () => {
    return respond();
  });
};

describe('background/injection', () => {
  beforeEach(() => {
    setTabs([]);
    setInjectResult(() => []);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Locked to the manifest's content_scripts[0].js. If the build ever emits a
  // second content-script chunk, this test and the manifest change together.
  describe('CONTENT_SCRIPT_FILES', () => {
    it('is exactly the one bundle the manifest declares', () => {
      expect(CONTENT_SCRIPT_FILES).toEqual(['content.js']);
    });
  });

  describe('injectInto', () => {
    it('injects every listed bundle into the given tab', async () => {
      await injectInto(42);
      expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
        files: CONTENT_SCRIPT_FILES,
        target: { tabId: 42 },
      });
    });

    // queryTabs can hand back a tab with no id; asking to inject into
    // `undefined` would throw somewhere far less legible.
    it('does nothing at all when the tab has no id', async () => {
      await injectInto(undefined);
      expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    });

    // The tab may be a restricted URL, or may have navigated away
    // mid-injection. Neither is recoverable and neither is worth failing over.
    it('resolves rather than rejecting when injection fails', async () => {
      setInjectResult(() => {
        throw new Error('Cannot access contents of the page');
      });
      await expect(injectInto(42)).resolves.toBeUndefined();
    });

    it('logs the swallowed failure as an Error carrying the original', async () => {
      const underlying = new Error('Cannot access contents of the page');
      setInjectResult(() => {
        throw underlying;
      });
      await injectInto(42);

      const logged = vi.mocked(console.warn).mock.calls[0]?.[0];
      expect(logged).toBeInstanceOf(Error);
      expect(logged).toMatchObject({ cause: underlying });
    });
  });

  describe('injectIntoOpenClaudeTabs', () => {
    it('injects into every claude.ai tab that was already open', async () => {
      setTabs([{ id: 1 }, { id: 2 }]);
      await injectIntoOpenClaudeTabs();
      expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(2);
    });

    it('queries only claude.ai tabs', async () => {
      await injectIntoOpenClaudeTabs();
      expect(chrome.tabs.query).toHaveBeenCalledWith({
        url: 'https://claude.ai/*',
      });
    });

    // One restricted tab must not stop the others from getting the script.
    it('keeps going when one tab refuses injection', async () => {
      setTabs([{ id: 1 }, { id: 2 }]);
      let calls = 0;
      setInjectResult(() => {
        calls += 1;
        if (calls === 1) throw new Error('restricted');
        return [];
      });
      await expect(injectIntoOpenClaudeTabs()).resolves.toBeUndefined();
      expect(calls).toBe(2);
    });

    it('resolves rather than rejecting when the tabs cannot be enumerated', async () => {
      vi.mocked(chrome.tabs.query).mockRejectedValue(
        new Error('no tabs permission'),
      );
      await expect(injectIntoOpenClaudeTabs()).resolves.toBeUndefined();
    });
  });

  describe('ensureContentScript', () => {
    it('injects into the active tab and reports success', async () => {
      setTabs([{ id: 7 }]);
      expect(await ensureContentScript()).toEqual({ success: true });
      expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
        files: CONTENT_SCRIPT_FILES,
        target: { tabId: 7 },
      });
    });

    // The popup calls this before every message, so an already-injected tab is
    // the common case. Reporting success is correct — the content script's own
    // double-injection guard makes the second injection a no-op.
    it('reports success even when there is no tab to inject into', async () => {
      setTabs([]);
      expect(await ensureContentScript()).toEqual({ success: true });
      expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    });

    // The popup awaits this before messaging; a rejection here would surface as
    // an unhandled error in the popup rather than the usual "no content script".
    it('reports success even when injection itself fails', async () => {
      setTabs([{ id: 7 }]);
      setInjectResult(() => {
        throw new Error('restricted');
      });
      expect(await ensureContentScript()).toEqual({ success: true });
    });
  });
});
