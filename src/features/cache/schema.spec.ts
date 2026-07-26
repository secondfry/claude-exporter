import { describe, expect, it } from 'vitest';

import { CONVERSATION_QUERY } from '$features/conversation/api';
import type { Conversation } from '$features/conversation/types';

import { isFresh, REQUEST_SIGNATURE, toRecord } from './schema';
import type { CacheRecord } from './schema';

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    chat_messages: [],
    created_at: '2026-01-01T00:00:00.000000Z',
    name: 'A chat',
    updated_at: '2026-02-02T12:00:00.000000Z',
    uuid: 'conv-1',
    ...overrides,
  };
}

function record(overrides: Partial<CacheRecord> = {}): CacheRecord {
  return { ...toRecord(conversation(), 1000), ...overrides };
}

describe('REQUEST_SIGNATURE', () => {
  it('is derived from the one CONVERSATION_QUERY definition', () => {
    expect(REQUEST_SIGNATURE).toContain(CONVERSATION_QUERY);
  });
});

describe('isFresh', () => {
  it('serves a record whose updated_at matches exactly', () => {
    expect(isFresh(record(), '2026-02-02T12:00:00.000000Z')).toBe(true);
  });

  it('rejects a record older than the list says', () => {
    expect(isFresh(record(), '2026-03-03T12:00:00.000000Z')).toBe(false);
  });

  // The dangerous direction: a record NEWER than the list must also miss, so
  // the decision can never depend on which side is greater.
  it('rejects a record newer than the list says', () => {
    expect(isFresh(record(), '2026-01-01T12:00:00.000000Z')).toBe(false);
  });

  it('rejects an equivalent timestamp written differently', () => {
    expect(isFresh(record(), '2026-02-02T12:00:00Z')).toBe(false);
  });

  it('rejects a record fetched under a different request signature', () => {
    expect(isFresh(record({ requestSignature: 'chat_conversations?tree=False' }), '2026-02-02T12:00:00.000000Z')).toBe(
      false
    );
  });

  it('misses when there is no record', () => {
    expect(isFresh(undefined, '2026-02-02T12:00:00.000000Z')).toBe(false);
  });

  // The popup exports a single conversation without ever loading the list, so
  // it has no updated_at to validate against and must always refetch.
  it('misses when the caller knows no updated_at', () => {
    expect(isFresh(record(), undefined)).toBe(false);
  });
});

describe('toRecord', () => {
  it('stores the raw conversation and its own updated_at', () => {
    const raw = conversation({ some_future_field: 'kept' });
    const stored = toRecord(raw, 42);

    expect(stored.uuid).toBe('conv-1');
    expect(stored.updatedAt).toBe('2026-02-02T12:00:00.000000Z');
    expect(stored.storedAt).toBe(42);
    expect(stored.conversation.some_future_field).toBe('kept');
  });
});
