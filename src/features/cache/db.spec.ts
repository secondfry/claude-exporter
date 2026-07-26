import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Conversation } from '$features/conversation/types';

// index.ts pulls in the browser adapter for the content script's relay port,
// which touches `chrome` at module load. None of these tests use that path.
vi.mock('$platform', () => ({
  sendMessageToRuntime: vi.fn(),
}));

import {
  clearRecords,
  countRecords,
  getRecord,
  putRecord,
  resetForTests,
} from './db';
import { readConversation, writeConversation } from './index';
import { REQUEST_SIGNATURE, toRecord } from './schema';

const conversation = (overrides: Partial<Conversation> = {}): Conversation => {
  return {
    chat_messages: [],
    created_at: '2026-01-01T00:00:00.000000Z',
    name: 'A chat',
    updated_at: '2026-02-02T12:00:00.000000Z',
    uuid: 'conv-1',
    ...overrides,
  };
};

afterEach(async () => {
  await clearRecords().catch(() => undefined);
  resetForTests();
  vi.restoreAllMocks();
});

describe('the store', () => {
  it('round-trips a conversation unchanged, unknown fields included', async () => {
    await writeConversation(
      conversation({ a_field_we_do_not_model: { deep: true } }),
    );

    const found = await readConversation(
      'conv-1',
      '2026-02-02T12:00:00.000000Z',
    );
    expect(found?.a_field_we_do_not_model).toEqual({ deep: true });
  });

  it('misses once the conversation has been updated upstream', async () => {
    await writeConversation(conversation());
    expect(
      await readConversation('conv-1', '2026-03-03T00:00:00.000000Z'),
    ).toBeNull();
  });

  it('misses for a conversation it has never seen', async () => {
    expect(
      await readConversation('nope', '2026-02-02T12:00:00.000000Z'),
    ).toBeNull();
  });

  it('overwrites rather than accumulating versions of one conversation', async () => {
    await writeConversation(conversation({ name: 'First' }));
    await writeConversation(
      conversation({
        name: 'Second',
        updated_at: '2026-04-04T00:00:00.000000Z',
      }),
    );

    expect(await countRecords()).toBe(1);
    const found = await readConversation(
      'conv-1',
      '2026-04-04T00:00:00.000000Z',
    );
    expect(found?.name).toBe('Second');
  });

  // Records written under an older query string hold a response the exporter
  // no longer asks for. They must not be served even though the timestamp
  // still lines up.
  it('refuses a record left behind by an older request signature', async () => {
    const stale = {
      ...toRecord(conversation(), 0),
      requestSignature: 'chat_conversations?tree=False',
    };
    await putRecord(stale);

    expect(await getRecord('conv-1')).toBeDefined();
    expect(
      await readConversation('conv-1', '2026-02-02T12:00:00.000000Z'),
    ).toBeNull();
  });

  it('stores under the current signature', async () => {
    await writeConversation(conversation());
    expect((await getRecord('conv-1'))?.requestSignature).toBe(
      REQUEST_SIGNATURE,
    );
  });
});

describe('when the browser refuses the write', () => {
  it('reports quota instead of throwing, and stops retrying', async () => {
    await writeConversation(conversation());
    resetForTests();

    const put = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation(() => {
        throw new DOMException('out of space', 'QuotaExceededError');
      });

    expect(await writeConversation(conversation({ uuid: 'conv-2' }))).toBe(
      'quota',
    );

    // Latched: the second write does not even reach IndexedDB.
    const callsAfterFirst = put.mock.calls.length;
    expect(await writeConversation(conversation({ uuid: 'conv-3' }))).toBe(
      'quota',
    );
    expect(put.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('a cache that cannot be opened', () => {
  it('degrades to a miss rather than failing the caller', async () => {
    resetForTests();
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new Error('IndexedDB is disabled');
    });

    expect(
      await readConversation('conv-1', '2026-02-02T12:00:00.000000Z'),
    ).toBeNull();
    expect(await writeConversation(conversation())).toBe('unavailable');
  });
});
