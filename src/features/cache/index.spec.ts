import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Conversation } from '$features/conversation/types';

// Characterization tests for the Chat Cache's *degradation*. Every function in
// index.ts swallows its own failures on purpose (ADR-0002): a cache that
// cannot be read is a miss, a cache that cannot be written is a slower next
// export, and neither may surface as an export failure. That silence is the
// contract, so it has to be pinned rather than left to be rediscovered.
//
// db.spec.ts already covers the round trip, overwrite-not-accumulate, the
// request-signature refusal, the quota latch and the cannot-open path. What is
// here is what that file does not touch: the direction of the freshness
// comparison, per-call failures below an open database, the storage estimate,
// and the relay port.

vi.mock('$platform', () => ({
  sendMessageToRuntime: vi.fn(),
}));

import { sendMessageToRuntime } from '$platform';

import { clearRecords, resetForTests } from './db';
import {
  cacheStats,
  readConversation,
  remoteCache,
  writeConversation,
} from './index';

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

const relayResolves = (value: unknown): void => {
  vi.mocked(sendMessageToRuntime).mockResolvedValue(value);
};

beforeEach(() => {
  vi.mocked(sendMessageToRuntime).mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await clearRecords().catch(() => undefined);
  resetForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('freshness is exact equality, never a range', () => {
  // The one comparison that must never be loosened. `>=` — serving a record
  // whose stored timestamp is at or beyond what the list reported — is the
  // only variant that can produce a false *hit*, and a false hit exports a
  // conversation missing its newest messages while reporting success.
  // If someone rewrites isFresh as `record.updatedAt >= updatedAt`, this test
  // is what fails.
  it('misses when the stored record is NEWER than the timestamp asked for', async () => {
    await writeConversation(
      conversation({ updated_at: '2026-05-05T00:00:00.000000Z' }),
    );

    expect(
      await readConversation('conv-1', '2026-02-02T12:00:00.000000Z'),
    ).toBeNull();
  });

  it('misses when the stored record is OLDER than the timestamp asked for', async () => {
    await writeConversation(
      conversation({ updated_at: '2026-02-02T12:00:00.000000Z' }),
    );

    expect(
      await readConversation('conv-1', '2026-05-05T00:00:00.000000Z'),
    ).toBeNull();
  });

  // Strings, not parsed dates. The same instant written differently is a miss,
  // which costs one fetch — cheaper than the parsing bugs the alternative buys.
  it('misses when the same instant is spelled differently', async () => {
    await writeConversation(
      conversation({ updated_at: '2026-02-02T12:00:00.000000Z' }),
    );

    expect(await readConversation('conv-1', '2026-02-02T12:00:00Z')).toBeNull();
  });

  it('hits only on the verbatim string', async () => {
    await writeConversation(conversation());

    expect(
      await readConversation('conv-1', '2026-02-02T12:00:00.000000Z'),
    ).not.toBeNull();
  });
});

describe('readConversation', () => {
  // Without a timestamp from the conversation list there is nothing to check
  // freshness against, so there is no such thing as a safe hit.
  it('is a miss when the caller has no updated_at, without touching the database', async () => {
    await writeConversation(conversation());
    const get = vi.spyOn(IDBObjectStore.prototype, 'get');

    expect(await readConversation('conv-1', undefined)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('degrades to a miss when the read itself throws', async () => {
    await writeConversation(conversation());
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(() => {
      throw new Error('transaction died');
    });

    expect(
      await readConversation('conv-1', '2026-02-02T12:00:00.000000Z'),
    ).toBeNull();
  });

  it('reports the failed read rather than rethrowing it', async () => {
    const underlying = new Error('transaction died');
    await writeConversation(conversation());
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(() => {
      throw underlying;
    });

    await readConversation('conv-1', '2026-02-02T12:00:00.000000Z');
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('writeConversation', () => {
  it('stores a usable conversation', async () => {
    expect(await writeConversation(conversation())).toBe('stored');
  });

  // A record is keyed by uuid and judged by updated_at. Missing either one
  // means it could never be read back, so writing it only wastes space.
  it('refuses a conversation with no uuid', async () => {
    expect(await writeConversation(conversation({ uuid: '' }))).toBe(
      'unavailable',
    );
  });

  it('refuses a conversation with no updated_at', async () => {
    expect(await writeConversation(conversation({ updated_at: '' }))).toBe(
      'unavailable',
    );
  });

  it('reports unavailable — not quota — when the write throws for some other reason', async () => {
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new Error('database is closing');
    });

    expect(await writeConversation(conversation())).toBe('unavailable');
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('cacheStats', () => {
  it('counts what is stored', async () => {
    vi.stubGlobal('navigator', {});
    await writeConversation(conversation());
    await writeConversation(conversation({ uuid: 'conv-2' }));

    expect((await cacheStats()).entries).toBe(2);
  });

  it('reports zero entries rather than failing when the count throws', async () => {
    vi.stubGlobal('navigator', {});
    vi.spyOn(IDBObjectStore.prototype, 'count').mockImplementation(() => {
      throw new Error('cannot count');
    });

    expect((await cacheStats()).entries).toBe(0);
  });

  // Origin-wide usage, and only when the browser volunteers it.
  it('passes through the estimate when the browser gives one', async () => {
    vi.stubGlobal('navigator', {
      storage: { estimate: () => Promise.resolve({ usage: 4096 }) },
    });

    expect((await cacheStats()).usageBytes).toBe(4096);
  });

  it('yields null usage when navigator.storage is absent', async () => {
    vi.stubGlobal('navigator', {});
    expect((await cacheStats()).usageBytes).toBeNull();
  });

  it('yields null usage when estimate() is absent', async () => {
    vi.stubGlobal('navigator', { storage: {} });
    expect((await cacheStats()).usageBytes).toBeNull();
  });

  it('yields null usage when estimate() throws', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        estimate: () => {
          throw new Error('not permitted');
        },
      },
    });

    expect((await cacheStats()).usageBytes).toBeNull();
  });

  it('yields null usage when the estimate omits usage', async () => {
    vi.stubGlobal('navigator', {
      storage: { estimate: () => Promise.resolve({ quota: 100 }) },
    });

    expect((await cacheStats()).usageBytes).toBeNull();
  });

  it('reports the quota latch', async () => {
    vi.stubGlobal('navigator', {});
    expect((await cacheStats()).quotaExceeded).toBe(false);
  });
});

// The content script's claude.ai origin has its own IndexedDB, so it must
// relay to the background worker (ADR-0003). The worker can be asleep, torn
// down mid-message, or simply not listening — none of which may fail an export.
describe('remoteCache', () => {
  it('relays a read and returns what the worker found', async () => {
    const found = conversation();
    relayResolves({ conversation: found, success: true });

    expect(
      await remoteCache.read('conv-1', '2026-02-02T12:00:00.000000Z'),
    ).toBe(found);
    expect(sendMessageToRuntime).toHaveBeenCalledWith({
      action: 'cacheRead',
      updatedAt: '2026-02-02T12:00:00.000000Z',
      uuid: 'conv-1',
    });
  });

  it('is a miss with no updated_at, without waking the worker', async () => {
    expect(await remoteCache.read('conv-1', undefined)).toBeNull();
    expect(sendMessageToRuntime).not.toHaveBeenCalled();
  });

  it('is a miss when the worker is unreachable', async () => {
    vi.mocked(sendMessageToRuntime).mockRejectedValue(
      new Error('Could not establish connection'),
    );

    expect(
      await remoteCache.read('conv-1', '2026-02-02T12:00:00.000000Z'),
    ).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('is a miss when the worker answers without success', async () => {
    relayResolves({ conversation: conversation(), success: false });

    expect(
      await remoteCache.read('conv-1', '2026-02-02T12:00:00.000000Z'),
    ).toBeNull();
  });

  it('is a miss when the worker answers with nothing at all', async () => {
    relayResolves(undefined);

    expect(
      await remoteCache.read('conv-1', '2026-02-02T12:00:00.000000Z'),
    ).toBeNull();
  });

  it('relays a write and returns the status the worker reports', async () => {
    relayResolves({ status: 'stored', success: true });

    expect(await remoteCache.write(conversation())).toBe('stored');
    expect(sendMessageToRuntime).toHaveBeenCalledWith({
      action: 'cacheWrite',
      conversation: conversation(),
    });
  });

  it('passes a quota report through unchanged', async () => {
    relayResolves({ status: 'quota', success: true });
    expect(await remoteCache.write(conversation())).toBe('quota');
  });

  it('reports unavailable when the worker is unreachable', async () => {
    vi.mocked(sendMessageToRuntime).mockRejectedValue(
      new Error('Could not establish connection'),
    );

    expect(await remoteCache.write(conversation())).toBe('unavailable');
  });

  it('reports unavailable when the worker answers without success', async () => {
    relayResolves({ status: 'stored', success: false });
    expect(await remoteCache.write(conversation())).toBe('unavailable');
  });
});
