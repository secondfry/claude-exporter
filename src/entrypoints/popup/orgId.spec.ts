import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getClaudeTab, getOrgId, getStoredOrgId } from './orgId';

// Characterization tests for the organization-ID fallback chain. The chain is
// three routes deep and every hop is a failure the user cannot see, so the
// order — and the fact that a success is always persisted — is the whole
// contract. It was previously inline in index.ts, where nothing could reach it.

const setActiveTab = (tab: unknown): void => {
  vi.mocked(chrome.tabs.query).mockImplementation(((
    _query: unknown,
    callback?: (tabs: unknown[]) => void,
  ) => {
    const tabs = tab === null ? [] : [tab];
    if (callback) return callback(tabs);
    return Promise.resolve(tabs);
  }) as typeof chrome.tabs.query);
};

const setTabResponse = (respond: () => unknown): void => {
  vi.mocked(chrome.tabs.sendMessage).mockImplementation(((
    _tabId: number,
    _message: unknown,
    callback?: (response: unknown) => void,
  ) => {
    const value = respond();
    if (callback) return callback(value);
    return Promise.resolve(value);
  }) as typeof chrome.tabs.sendMessage);
};

const CLAUDE_TAB = { id: 7, url: 'https://claude.ai/chat/abc' };

describe('popup/orgId', () => {
  beforeEach(() => {
    setActiveTab(CLAUDE_TAB);
    setTabResponse(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('no network in test')),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('getClaudeTab', () => {
    it('returns the active tab when it is a claude.ai page with an id', async () => {
      expect(await getClaudeTab()).toEqual(CLAUDE_TAB);
    });

    it('returns null when the active tab is not claude.ai', async () => {
      setActiveTab({ id: 7, url: 'https://example.com/' });
      expect(await getClaudeTab()).toBeNull();
    });

    it('returns null when the tab has no url', async () => {
      setActiveTab({ id: 7 });
      expect(await getClaudeTab()).toBeNull();
    });

    // A tab with no id cannot be messaged; treating it as usable would throw
    // deeper in, where the failure reads as a content-script bug.
    it('returns null when the tab has no id', async () => {
      setActiveTab({ url: 'https://claude.ai/' });
      expect(await getClaudeTab()).toBeNull();
    });

    it('returns null when there is no active tab at all', async () => {
      setActiveTab(null);
      expect(await getClaudeTab()).toBeNull();
    });
  });

  describe('getOrgId — route 1, the content script', () => {
    it('returns the org ID the content script reports', async () => {
      setTabResponse(() => ({ orgId: 'org-from-content', success: true }));
      expect(await getOrgId()).toBe('org-from-content');
    });

    it('persists what it found so the stored fallback stays fresh', async () => {
      setTabResponse(() => ({ orgId: 'org-from-content', success: true }));
      await getOrgId();
      expect(await getStoredOrgId()).toBe('org-from-content');
    });

    it('is skipped entirely when the active tab is not claude.ai', async () => {
      setActiveTab({ id: 7, url: 'https://example.com/' });
      setTabResponse(() => ({ orgId: 'should-not-be-asked', success: true }));
      await getOrgId();
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('getOrgId — route 2, a direct request from the extension origin', () => {
    it('is used when the content script reports failure', async () => {
      setTabResponse(() => ({ error: 'nope', success: false }));
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => [{ uuid: 'org-from-fetch' }],
        }),
      );
      expect(await getOrgId()).toBe('org-from-fetch');
    });

    // The content script is absent on a page it was never injected into, and
    // sendMessage rejects rather than resolving — the chain must survive that.
    it('is used when messaging the content script throws', async () => {
      setTabResponse(() => {
        throw new Error('Receiving end does not exist');
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => [{ uuid: 'org-from-fetch' }],
        }),
      );
      expect(await getOrgId()).toBe('org-from-fetch');
    });

    it('persists what it found', async () => {
      setTabResponse(() => ({ error: 'nope', success: false }));
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => [{ uuid: 'org-from-fetch' }],
        }),
      );
      await getOrgId();
      expect(await getStoredOrgId()).toBe('org-from-fetch');
    });
  });

  describe('getOrgId — route 3, the stored value', () => {
    it('falls back to storage when every detector comes up empty', async () => {
      await chrome.storage.sync.set({ organizationId: 'org-from-storage' });
      expect(await getOrgId()).toBe('org-from-storage');
    });

    it('returns undefined when nothing is stored either', async () => {
      expect(await getOrgId()).toBeUndefined();
    });

    // A detector failure must never overwrite a good stored value with nothing.
    it('leaves the stored value intact when detection fails', async () => {
      await chrome.storage.sync.set({ organizationId: 'org-from-storage' });
      await getOrgId();
      expect(await getStoredOrgId()).toBe('org-from-storage');
    });
  });

  // Every route is wrapped so a thrown error degrades to the next one rather
  // than rejecting out of the popup's click handler.
  describe('getOrgId — failures are reported, not thrown', () => {
    it('logs an Error carrying the original as `cause`', async () => {
      const underlying = new Error('Receiving end does not exist');
      setTabResponse(() => {
        throw underlying;
      });
      await getOrgId();

      const logged = vi.mocked(console.warn).mock.calls[0]?.[0];
      expect(logged).toBeInstanceOf(Error);
      expect(logged).toMatchObject({ cause: underlying });
    });

    it('never rejects, whatever fails', async () => {
      setActiveTab(null);
      setTabResponse(() => {
        throw new Error('unreachable');
      });
      await expect(getOrgId()).resolves.toBeUndefined();
    });
  });
});
