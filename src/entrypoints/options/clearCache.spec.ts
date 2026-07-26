import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Partial, not wholesale: the Chat Cache's requestSignature is built from this
// module's CONVERSATION_QUERY (ADR-0002), so replacing the module outright
// takes the cache's schema down with it.
vi.mock('$features/conversation/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$features/conversation/api')>()),
  fetchConversationList: vi.fn(),
}));

import { clearCache, writeConversation } from '$features/cache';
import { fetchConversationList } from '$features/conversation/api';
import type { Conversation } from '$features/conversation/types';

import { clearCachePrompt, countOrphans } from './clearCache';

// Clearing the Chat Cache is normally harmless (ADR-0002). It stops being
// harmless the moment the cache holds an Orphan, whose Conversation exists
// nowhere else. These pin the asymmetry: never knowing is treated as "there
// might be", because the alternative silently disables the guard in exactly
// the conditions — offline, signed out, host access revoked — where the user
// is least able to recover from being wrong.

const conversation = (uuid: string): Conversation => ({
  chat_messages: [],
  created_at: '2026-01-01T00:00:00.000000Z',
  name: uuid,
  updated_at: '2026-02-02T12:00:00.000000Z',
  uuid,
});

const listOf = (...uuids: string[]) =>
  uuids.map((uuid) => ({
    created_at: '2026-01-01T00:00:00.000000Z',
    name: uuid,
    updated_at: '2026-02-02T12:00:00.000000Z',
    uuid,
  }));

describe('clearCachePrompt', () => {
  // The only silent path. Prompting on a cache that holds nothing
  // irreplaceable would train the user to dismiss the prompt that matters.
  it('does not interrupt when there are no Orphans', () => {
    expect(clearCachePrompt(0)).toEqual({ confirm: false, message: '' });
  });

  it('interrupts when Orphans would be destroyed', () => {
    const prompt = clearCachePrompt(3);
    expect(prompt.confirm).toBe(true);
    expect(prompt.message).toContain('3 cached conversations');
    expect(prompt.message).toContain('only copies');
  });

  it('reads naturally for a single Orphan', () => {
    const prompt = clearCachePrompt(1);
    expect(prompt.message).toContain('1 cached conversation ');
    expect(prompt.message).toContain('only copy');
  });

  it('points the user at the way to rescue them first', () => {
    expect(clearCachePrompt(2).message).toContain('Deleted from claude.ai');
  });

  // The case the split exists for: unknown is not zero.
  it('interrupts when the Orphan count could not be established', () => {
    const prompt = clearCachePrompt(null);
    expect(prompt.confirm).toBe(true);
    expect(prompt.message).toContain('Could not check');
  });
});

describe('countOrphans', () => {
  beforeEach(async () => {
    await clearCache();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts cached conversations the list no longer reports', async () => {
    await writeConversation(conversation('gone'));
    await writeConversation(conversation('live'));
    vi.mocked(fetchConversationList).mockResolvedValue(listOf('live'));

    expect(await countOrphans('org-1')).toBe(1);
  });

  it('is zero when every cached conversation is still live', async () => {
    await writeConversation(conversation('live'));
    vi.mocked(fetchConversationList).mockResolvedValue(listOf('live'));

    expect(await countOrphans('org-1')).toBe(0);
  });

  it('is unknown, not zero, without an organization ID', async () => {
    expect(await countOrphans(undefined)).toBeNull();
    expect(fetchConversationList).not.toHaveBeenCalled();
  });

  it('is unknown, not zero, when claude.ai cannot be reached', async () => {
    await writeConversation(conversation('gone'));
    vi.mocked(fetchConversationList).mockRejectedValue(new Error('offline'));

    expect(await countOrphans('org-1')).toBeNull();
  });

  // An empty list is what a failed-but-not-throwing fetch looks like, and
  // treating it as truth would report every cached entry as an Orphan.
  it('is unknown when the list comes back empty', async () => {
    await writeConversation(conversation('gone'));
    vi.mocked(fetchConversationList).mockResolvedValue([]);

    expect(await countOrphans('org-1')).toBeNull();
  });
});
