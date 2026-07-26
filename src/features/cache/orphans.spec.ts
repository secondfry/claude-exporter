import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  Conversation,
  ConversationSummary,
} from '$features/conversation/types';

import { clearRecords, resetForTests } from './db';
import { readConversation, writeConversation } from './index';
import {
  findOrphans,
  findOrphansSafely,
  missingFromList,
  toSummary,
} from './orphans';
import type { CacheRecord } from './schema';

// An Orphan is the only case where the Chat Cache holds something that exists
// nowhere else, so the cost of being wrong is asymmetric and one-directional:
// a missed Orphan is a row the user does not see, while a falsely reported one
// is an invitation to treat live conversations as unrecoverable — and, next to
// a Clear Cache warning, to act on that. These pin the direction.

const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  chat_messages: [],
  created_at: '2026-01-01T00:00:00.000000Z',
  name: 'A chat',
  updated_at: '2026-02-02T12:00:00.000000Z',
  uuid: 'conv-1',
  ...overrides,
});

const summary = (uuid: string): ConversationSummary => ({
  created_at: '2026-01-01T00:00:00.000000Z',
  name: uuid,
  updated_at: '2026-02-02T12:00:00.000000Z',
  uuid,
});

const record = (overrides: Partial<CacheRecord> = {}): CacheRecord => ({
  conversation: conversation(),
  requestSignature: 'sig',
  storedAt: 0,
  updatedAt: '2026-02-02T12:00:00.000000Z',
  uuid: 'conv-1',
  ...overrides,
});

describe('missingFromList', () => {
  it('reports cached uuids the live list does not mention', () => {
    expect(missingFromList(['a', 'b', 'c'], ['a', 'c'])).toEqual(['b']);
  });

  it('reports nothing when every cached uuid is still live', () => {
    expect(missingFromList(['a', 'b'], ['a', 'b', 'c'])).toEqual([]);
  });

  it('reports nothing for an empty cache', () => {
    expect(missingFromList([], ['a'])).toEqual([]);
  });

  // The pure function answers the set question honestly; the guard against an
  // empty list being a failed fetch belongs to findOrphans, below.
  it('reports everything when the live list is empty', () => {
    expect(missingFromList(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});

describe('toSummary', () => {
  it('takes updated_at from the record, not the conversation body', () => {
    const result = toSummary(
      record({
        conversation: conversation({ updated_at: 'whatever-was-in-the-body' }),
        updatedAt: '2026-03-03T00:00:00.000000Z',
      }),
    );

    // This is what makes an Orphan exportable: the pipeline asks the cache
    // with this timestamp and isFresh compares it, exactly, against the same
    // field. Any other value is a guaranteed miss followed by a 404.
    expect(result?.updated_at).toBe('2026-03-03T00:00:00.000000Z');
  });

  it('takes the uuid from the record key', () => {
    expect(toSummary(record({ uuid: 'orphan-9' }))?.uuid).toBe('orphan-9');
  });

  it('carries the name and project through for the table', () => {
    const result = toSummary(
      record({
        conversation: conversation({ name: 'Rescued', project_uuid: 'proj-1' }),
      }),
    );

    expect(result?.name).toBe('Rescued');
    expect(result?.project_uuid).toBe('proj-1');
  });

  it('drops the message tree, which the table never reads', () => {
    const result = toSummary(
      record({
        conversation: conversation({
          chat_messages: [{ sender: 'human', uuid: 'm1' }],
        }),
      }),
    );

    expect(result?.chat_messages).toBeUndefined();
  });

  it('substitutes a name rather than rendering an empty row', () => {
    expect(
      toSummary(record({ conversation: conversation({ name: '' }) }))?.name,
    ).toBe('Untitled');
  });

  it('returns null for a record with no conversation in it', () => {
    expect(toSummary(record({ conversation: undefined }))).toBeNull();
  });
});

describe('findOrphans', () => {
  beforeEach(async () => {
    resetForTests();
    await clearRecords();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finds a cached conversation the list no longer reports', async () => {
    await writeConversation(conversation({ name: 'Deleted', uuid: 'gone' }));
    await writeConversation(conversation({ uuid: 'still-here' }));

    const orphans = await findOrphans([summary('still-here')]);

    expect(orphans.map((o) => o.uuid)).toEqual(['gone']);
    expect(orphans[0].name).toBe('Deleted');
  });

  it('finds nothing when every cached conversation is still live', async () => {
    await writeConversation(conversation({ uuid: 'a' }));
    expect(await findOrphans([summary('a')])).toEqual([]);
  });

  it('finds nothing when the cache is empty', async () => {
    expect(await findOrphans([summary('a')])).toEqual([]);
  });

  // The guard that matters. An empty live list is indistinguishable from a
  // failed fetch, and under the wrong reading every cached entry is reported
  // as the last copy of a deleted conversation.
  it('refuses to call the whole cache orphaned when the live list is empty', async () => {
    await writeConversation(conversation({ uuid: 'a' }));
    await writeConversation(conversation({ uuid: 'b' }));

    expect(await findOrphans([])).toEqual([]);
  });

  it('gives each Orphan the updated_at that will hit the cache', async () => {
    await writeConversation(
      conversation({ updated_at: '2026-05-05T00:00:00.000000Z', uuid: 'gone' }),
    );

    const [orphan] = await findOrphans([summary('other')]);

    expect(orphan.updated_at).toBe('2026-05-05T00:00:00.000000Z');
  });
});

// The point of surfacing Orphans is that they can still be Exported, and the
// only thing that makes that possible is the freshness comparison: the export
// pipeline asks the cache with the target's updatedAt, and isFresh demands an
// exact match. If a summary carried any other timestamp the pipeline would
// miss, fall through to claude.ai, and get the 404 that made it an Orphan.
// readConversation below is the very function the pipeline calls.
describe('an Orphan is exportable', () => {
  beforeEach(async () => {
    resetForTests();
    await clearRecords();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves the cached conversation for the timestamp its summary carries', async () => {
    await writeConversation(
      conversation({
        name: 'Deleted but kept',
        updated_at: '2026-04-04T00:00:00.000000Z',
        uuid: 'gone',
      }),
    );

    const [orphan] = await findOrphans([summary('something-else')]);
    // Exactly what exportSelection's toTarget puts on an ExportTarget.
    const hit = await readConversation(orphan.uuid, orphan.updated_at);

    expect(hit?.name).toBe('Deleted but kept');
  });

  it('carries the message tree in the cached copy, not in the summary', async () => {
    await writeConversation(
      conversation({
        chat_messages: [{ sender: 'human', text: 'hello', uuid: 'm1' }],
        uuid: 'gone',
      }),
    );

    const [orphan] = await findOrphans([summary('other')]);
    const hit = await readConversation(orphan.uuid, orphan.updated_at);

    expect(orphan.chat_messages).toBeUndefined();
    expect(hit?.chat_messages).toHaveLength(1);
  });
});

describe('findOrphansSafely', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The browse table renders whether or not the cache cooperates. An Orphan
  // lookup that throws must cost the Orphan rows, not the page.
  it('degrades to no Orphans when the cache cannot be enumerated', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new Error('database unavailable');
    });
    resetForTests();

    await expect(findOrphansSafely([summary('a')])).resolves.toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });
});
