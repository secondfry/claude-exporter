import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getOrgId, getStoredOrgId } from './orgId';

// Characterization of the browse page's organization-ID fallback. It used to
// be a try/catch in index.ts falling through to the stored value, with the
// failure only visible as a console.log.

describe('browse/orgId', () => {
  beforeEach(async () => {
    await chrome.storage.sync.clear();
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

  const detectionYields = (uuid: string): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [{ uuid }],
      }),
    );
  };

  it('prefers what it detects from claude.ai', async () => {
    await chrome.storage.sync.set({ organizationId: 'org-stored' });
    detectionYields('org-detected');
    expect(await getOrgId()).toBe('org-detected');
  });

  it('persists a detected value so the fallback stays fresh', async () => {
    detectionYields('org-detected');
    await getOrgId();
    expect(await getStoredOrgId()).toBe('org-detected');
  });

  it('falls back to the stored value when detection throws', async () => {
    await chrome.storage.sync.set({ organizationId: 'org-stored' });
    expect(await getOrgId()).toBe('org-stored');
  });

  it('returns null when detection fails and nothing is stored', async () => {
    expect(await getOrgId()).toBeNull();
  });

  // The page still works off the stored value, so a detection failure must
  // never reject out of DOMContentLoaded.
  it('never rejects when detection throws', async () => {
    await expect(getOrgId()).resolves.toBeNull();
  });

  // Losing a good stored ID because the network was down would leave the user
  // with an unusable page and no way back short of the options screen.
  it('leaves the stored value intact when detection fails', async () => {
    await chrome.storage.sync.set({ organizationId: 'org-stored' });
    await getOrgId();
    expect(await getStoredOrgId()).toBe('org-stored');
  });

  it('reports the failure as an Error carrying the original as `cause`', async () => {
    const underlying = new Error('offline');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(underlying));
    await getOrgId();

    const logged = vi.mocked(console.warn).mock.calls[0]?.[0];
    expect(logged).toBeInstanceOf(Error);
    expect(logged).toMatchObject({ cause: underlying });
  });

  describe('getStoredOrgId', () => {
    it('returns null rather than an empty string when nothing is stored', async () => {
      expect(await getStoredOrgId()).toBeNull();
    });

    it('normalises a stored empty string to null', async () => {
      await chrome.storage.sync.set({ organizationId: '' });
      expect(await getStoredOrgId()).toBeNull();
    });
  });
});
