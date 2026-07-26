// The Chat Cache: raw conversation JSON, keyed by UUID, valid only while the
// stored `updated_at` still matches what the conversation list reports.
//
// Raw JSON rather than rendered files so one entry serves every combination of
// export options and toggling a format stays instant (ADR-0002).
//
// Every function here swallows its own failures. A cache that cannot be read
// is a miss; a cache that cannot be written is a slower next export. Neither
// is allowed to surface as an export failure.

import type { Conversation } from '../conversation/types';
import { sendMessageToRuntime } from '../../platform';

import {
  clearRecords,
  countRecords,
  getRecord,
  isQuotaExceeded,
  putRecord,
} from './db';
import { isFresh, toRecord } from './schema';
import type {
  CachePort,
  CacheRequest,
  CacheStats,
  CacheWriteStatus,
} from './messages';

async function readConversation(
  uuid: string,
  updatedAt: string | undefined
): Promise<Conversation | null> {
  if (!updatedAt) return null;
  try {
    const record = await getRecord(uuid);
    return isFresh(record, updatedAt) ? record!.conversation : null;
  } catch (error) {
    console.warn('Chat Cache read failed; refetching', error);
    return null;
  }
}

async function writeConversation(conversation: Conversation): Promise<CacheWriteStatus> {
  if (!conversation?.uuid || !conversation.updated_at) return 'unavailable';
  try {
    return (await putRecord(toRecord(conversation, Date.now()))) ? 'stored' : 'quota';
  } catch (error) {
    console.warn('Chat Cache write failed; export unaffected', error);
    return 'unavailable';
  }
}

async function cacheStats(): Promise<CacheStats> {
  let entries = 0;
  try {
    entries = await countRecords();
  } catch (error) {
    console.warn('Could not count Chat Cache entries', error);
  }

  let usageBytes: number | null = null;
  try {
    // Origin-wide, not cache-only — the browser exposes no per-database
    // figure. Callers must label it as such rather than as the cache's size.
    const estimate = await navigator.storage?.estimate?.();
    usageBytes = estimate?.usage ?? null;
  } catch {
    usageBytes = null;
  }

  return { entries, usageBytes, quotaExceeded: isQuotaExceeded() };
}

async function clearCache(): Promise<void> {
  await clearRecords();
}

/** For contexts sharing the extension origin: the browse page and background. */
const localCache: CachePort = {
  read: readConversation,
  write: writeConversation,
};

async function ask<T>(request: CacheRequest): Promise<T | null> {
  try {
    return await sendMessageToRuntime<T>(request);
  } catch (error) {
    console.warn('Chat Cache is unreachable; continuing uncached', error);
    return null;
  }
}

/**
 * For the content script, whose claude.ai origin has a different IndexedDB
 * than the rest of the extension. Relays to the background worker so both
 * export callers share one cache instead of filling the disk twice.
 */
const remoteCache: CachePort = {
  async read(uuid, updatedAt) {
    if (!updatedAt) return null;
    const response = await ask<{ success: boolean; conversation: Conversation | null }>({
      action: 'cacheRead',
      uuid,
      updatedAt,
    });
    return response?.success ? response.conversation : null;
  },

  async write(conversation) {
    const response = await ask<{ success: boolean; status: CacheWriteStatus }>({
      action: 'cacheWrite',
      conversation,
    });
    return response?.success ? response.status : 'unavailable';
  },
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
