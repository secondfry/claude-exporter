// Orphans: Chat Cache entries whose Conversation no longer exists on
// claude.ai (CONTEXT.md). The cache holds the only remaining copy, so an
// Orphan is the one case where the cache stops being disposable — ADR-0002
// resolves that tension by making Orphans exportable and visible rather than
// by making the cache durable. This module is the "visible" half.
//
// Detection is a set difference, not a probe: asking claude.ai about each
// cached uuid would be hundreds of requests to learn what one conversation
// list already says. Anything cached that the list does not mention is gone.
//
// Reading the values is deliberately confined to the uuids that survive the
// diff. The keys answer "which", and only the handful that are Orphans are
// worth deserialising a record for.

import type {
  Conversation,
  ConversationSummary,
} from '$features/conversation/types';

import { getRecord, listRecordUuids } from './db';
import type { CacheRecord } from './schema';

/**
 * Cached uuids the live list does not mention.
 *
 * Pure, and separated from the IO for exactly one reason: this is where the
 * feature can be wrong in a way that costs the user data. An empty live list —
 * a failed fetch, an account still loading — makes *everything* an Orphan,
 * which is why callers must never pass one in. See findOrphans.
 */
const missingFromList = (
  cachedUuids: readonly string[],
  liveUuids: Iterable<string>,
): string[] => {
  const live = new Set(liveUuids);
  return cachedUuids.filter((uuid) => !live.has(uuid));
};

/**
 * The list-shaped view of a cached Conversation, so an Orphan can travel
 * through everything that already handles a ConversationSummary — the table,
 * the Selection, the export pipeline.
 *
 * `updated_at` comes from the record's own `updatedAt`, the field freshness is
 * judged on, which is what makes an Orphan exportable at all: the pipeline
 * asks the cache with this timestamp, isFresh matches exactly, and the fetch
 * that would 404 never happens.
 */
const toSummary = (record: CacheRecord): ConversationSummary | null => {
  const conversation: Conversation | undefined = record.conversation;
  if (!conversation) return null;

  return {
    ...conversation,
    chat_messages: undefined,
    created_at: conversation.created_at || record.updatedAt,
    name: conversation.name || 'Untitled',
    updated_at: record.updatedAt,
    uuid: record.uuid,
  };
};

/**
 * Degrading is correct: a record that will not load is one row missing from
 * the table, and the alternative is that one unreadable entry hides every
 * other Orphan — including the ones the user came to rescue.
 */
const loadSummary = async (
  uuid: string,
): Promise<ConversationSummary | null> => {
  try {
    const record = await getRecord(uuid);
    if (!record) return null;
    return toSummary(record);
  } catch (error) {
    console.warn(
      new Error(`Could not read cached conversation ${uuid}`, { cause: error }),
    );
    return null;
  }
};

/**
 * Every Orphan, as list rows, given the Conversations claude.ai currently
 * reports.
 *
 * Returns nothing for an empty live list. That is the load-bearing guard: the
 * caller cannot distinguish "this account has no conversations" from "the
 * fetch failed", and under the second reading every cached entry looks
 * orphaned. Announcing the entire cache as unrecoverable — and, with a Clear
 * Cache warning attached to that count, inviting the user to act on it — is a
 * far worse failure than showing no Orphans on a genuinely empty account,
 * where there is nothing to show anyway.
 */
const findOrphans = async (
  live: readonly ConversationSummary[],
): Promise<ConversationSummary[]> => {
  if (live.length === 0) return [];

  const cachedUuids = await listRecordUuids();
  const orphanUuids = missingFromList(
    cachedUuids,
    live.map((conv) => conv.uuid),
  );

  const summaries = await Promise.all(orphanUuids.map(loadSummary));
  return summaries.filter((summary) => summary !== null);
};

/** Never throws: an unreadable cache means no Orphans surfaced, not no table. */
const findOrphansSafely = async (
  live: readonly ConversationSummary[],
): Promise<ConversationSummary[]> => {
  try {
    return await findOrphans(live);
  } catch (error) {
    console.warn(
      new Error('Could not look for Orphans in the Chat Cache', {
        cause: error,
      }),
    );
    return [];
  }
};

export { findOrphans, findOrphansSafely, missingFromList, toSummary };
