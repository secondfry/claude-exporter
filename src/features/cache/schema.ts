// Chat Cache schema and the freshness predicate (ADR-0002).
//
// Two things decide whether a stored conversation may be used, and both are
// pure string comparisons so they can be reasoned about without a database:
// the conversation's `updated_at` and the request signature.

import { CONVERSATION_QUERY } from '$features/conversation/api';
import type { Conversation } from '$features/conversation/types';

const DB_NAME = 'claude-exporter-chat-cache';
const STORE_NAME = 'conversations';
const META_STORE_NAME = 'meta';
const SIGNATURE_KEY = 'requestSignature';

/**
 * IndexedDB version. Bumping it drops and recreates the object store — the
 * cache is NEVER migrated (ADR-0002): migration's best case is identical to
 * clear() and its worst case is silently exporting stale data.
 */
const DB_VERSION = 1;

/**
 * Identifies the request whose response a record holds. A record fetched under
 * a different query string answers a different question, so it must not be
 * served even though its `updated_at` still matches. Derived from
 * CONVERSATION_QUERY so the two can never drift.
 */
const REQUEST_SIGNATURE = `chat_conversations?${CONVERSATION_QUERY}`;

interface CacheRecord {
  /** The raw API response, unmodified. */
  conversation: Conversation;
  requestSignature: string;
  /** When we stored it. Diagnostic only — never part of the hit decision. */
  storedAt: number;
  /** Verbatim `updated_at` from the response the record was built from. */
  updatedAt: string;
  uuid: string;
}

/**
 * May this record be served for a conversation the list says was last updated
 * at `updatedAt`?
 *
 * Exact string equality, not a date comparison and not `>=`. `>=` is the only
 * variant that can produce a false *hit*, and a false hit silently exports a
 * conversation missing its newest messages. Comparing the strings rather than
 * parsed dates keeps a reformatted timestamp a miss, which costs one fetch;
 * the alternative failure costs the user data they think they have.
 */
const isFresh = (
  record: CacheRecord | undefined,
  updatedAt: string | undefined,
): boolean => {
  if (!record || !updatedAt) return false;
  if (record.requestSignature !== REQUEST_SIGNATURE) return false;
  return record.updatedAt === updatedAt;
};

const toRecord = (
  conversation: Conversation,
  storedAt: number,
): CacheRecord => {
  return {
    conversation,
    requestSignature: REQUEST_SIGNATURE,
    storedAt,
    updatedAt: conversation.updated_at,
    uuid: conversation.uuid,
  };
};

export {
  DB_NAME,
  DB_VERSION,
  isFresh,
  META_STORE_NAME,
  REQUEST_SIGNATURE,
  SIGNATURE_KEY,
  STORE_NAME,
  toRecord,
};
export type { CacheRecord };
