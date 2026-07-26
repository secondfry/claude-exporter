// The Chat Cache: raw conversation JSON, keyed by UUID, valid only while the
// stored `updated_at` still matches what the conversation list reports.
//
// Raw JSON rather than rendered files so one entry serves every combination of
// export options and toggling a format stays instant (ADR-0002).
//
// Every function here swallows its own failures. A cache that cannot be read
// is a miss; a cache that cannot be written is a slower next export. Neither
// is allowed to surface as an export failure. Each swallow logs an Error
// carrying the original as `cause`, so the reason survives in the console even
// though the caller never sees it.

import type { Conversation } from '$features/conversation/types';
import { sendMessageToRuntime } from '$platform';

import {
  clearRecords,
  countRecords,
  getRecord,
  isQuotaExceeded,
  putRecord,
} from './db';
import type {
  CachePort,
  CacheRequest,
  CacheStats,
  CacheWriteStatus,
} from './messages';
import type { CacheRecord } from './schema';
import { isFresh, toRecord } from './schema';

/**
 * A record, or nothing when the database would not give one up.
 *
 * Degrading is correct: the conversation is still fetchable from claude.ai, so
 * an unreadable cache costs one request. Propagating instead would turn a
 * storage problem into a failed export.
 */
const fetchRecord = async (uuid: string): Promise<CacheRecord | undefined> => {
  try {
    return await getRecord(uuid);
  } catch (error) {
    console.warn(
      new Error('Chat Cache read failed; refetching', { cause: error }),
    );
    return undefined;
  }
};

const readConversation = async (
  uuid: string,
  updatedAt: string | undefined,
): Promise<Conversation | null> => {
  // No timestamp from the conversation list means nothing to check freshness
  // against, and therefore no such thing as a safe hit.
  if (!updatedAt) return null;

  const record = await fetchRecord(uuid);
  if (!record) return null;
  if (!isFresh(record, updatedAt)) return null;
  return record.conversation;
};

/**
 * Degrading is correct: the bytes the caller wanted to cache are already in
 * memory and on their way into the ZIP. A refused write only means the next
 * export re-fetches.
 */
const storeRecord = async (
  conversation: Conversation,
): Promise<CacheWriteStatus> => {
  try {
    const stored = await putRecord(toRecord(conversation, Date.now()));
    return stored ? 'stored' : 'quota';
  } catch (error) {
    console.warn(
      new Error('Chat Cache write failed; export unaffected', { cause: error }),
    );
    return 'unavailable';
  }
};

const writeConversation = async (
  conversation: Conversation,
): Promise<CacheWriteStatus> => {
  // A record is keyed by uuid and judged by updated_at. Without both it could
  // never be read back, so storing it would only consume space.
  if (!conversation?.uuid) return 'unavailable';
  if (!conversation.updated_at) return 'unavailable';
  return storeRecord(conversation);
};

/**
 * Degrading is correct: the count is a number on a settings screen. Reporting
 * zero is a worse figure, not a broken page.
 */
const countEntries = async (): Promise<number> => {
  try {
    return await countRecords();
  } catch (error) {
    console.warn(
      new Error('Could not count Chat Cache entries', { cause: error }),
    );
    return 0;
  }
};

/**
 * Origin-wide usage, not cache-only — the browser exposes no per-database
 * figure. Callers must label it as such rather than as the cache's size.
 *
 * Degrading is correct: `navigator.storage` is absent in some contexts and
 * `estimate()` may be refused outright. Null means "the browser would not
 * say", which the UI can render; a throw here would take the screen with it.
 */
const estimateUsageBytes = async (): Promise<number | null> => {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return estimate?.usage ?? null;
  } catch (error) {
    console.warn(
      new Error('Could not estimate storage usage', { cause: error }),
    );
    return null;
  }
};

const cacheStats = async (): Promise<CacheStats> => {
  const entries = await countEntries();
  const usageBytes = await estimateUsageBytes();
  return { entries, quotaExceeded: isQuotaExceeded(), usageBytes };
};

const clearCache = async (): Promise<void> => {
  await clearRecords();
};

/** For contexts sharing the extension origin: the browse page and background. */
const localCache: CachePort = {
  read: readConversation,
  write: writeConversation,
};

/**
 * Degrading is correct: the background worker can be asleep, torn down
 * mid-message, or simply not listening. None of that is a reason to fail an
 * export the content script can complete uncached.
 */
const ask = async <T>(request: CacheRequest): Promise<T | null> => {
  try {
    return await sendMessageToRuntime<T>(request);
  } catch (error) {
    console.warn(
      new Error('Chat Cache is unreachable; continuing uncached', {
        cause: error,
      }),
    );
    return null;
  }
};

const askToRead = async (
  uuid: string,
  updatedAt: string,
): Promise<Conversation | null> => {
  const response = await ask<{
    conversation: Conversation | null;
    success: boolean;
  }>({ action: 'cacheRead', updatedAt, uuid });
  return response?.success ? response.conversation : null;
};

const askToWrite = async (
  conversation: Conversation,
): Promise<CacheWriteStatus> => {
  const response = await ask<{ status: CacheWriteStatus; success: boolean }>({
    action: 'cacheWrite',
    conversation,
  });
  return response?.success ? response.status : 'unavailable';
};

/**
 * For the content script, whose claude.ai origin has a different IndexedDB
 * than the rest of the extension. Relays to the background worker so both
 * export callers share one cache instead of filling the disk twice (ADR-0003).
 */
const relayRead = async (
  uuid: string,
  updatedAt: string | undefined,
): Promise<Conversation | null> => {
  if (!updatedAt) return null;
  return askToRead(uuid, updatedAt);
};

const remoteCache: CachePort = {
  read: relayRead,
  write: askToWrite,
};

export {
  cacheStats,
  clearCache,
  localCache,
  readConversation,
  remoteCache,
  writeConversation,
};
export type { CachePort, CacheStats, CacheWriteStatus };
