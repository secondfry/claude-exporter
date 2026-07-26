// The wire contract for reaching the Chat Cache from a context that cannot
// open it directly.
//
// IndexedDB is partitioned by origin. The browse page and the background
// worker are both extension-origin, so they share one database; the content
// script runs on claude.ai and would otherwise build a second, duplicate cache
// of the same conversations. Since the ADR-0002 sizing argument is the whole
// reason the cache is not in chrome.storage.local, storing it twice is not an
// acceptable outcome — the content script goes through the background worker
// instead. See docs/adr/0003-chat-cache-lives-on-the-extension-origin.md.

import type { Conversation } from '$features/conversation/types';

/** Refused for want of space; the export itself is unaffected. */
type CacheWriteStatus = 'quota' | 'stored' | 'unavailable';

interface CacheReadRequest {
  action: 'cacheRead';
  updatedAt: string;
  uuid: string;
}

interface CacheWriteRequest {
  action: 'cacheWrite';
  conversation: Conversation;
}

interface CacheStatsRequest {
  action: 'cacheStats';
}

interface CacheClearRequest {
  action: 'cacheClear';
}

type CacheRequest =
  CacheClearRequest | CacheReadRequest | CacheStatsRequest | CacheWriteRequest;

interface CacheReadResponse {
  conversation: Conversation | null;
  success: true;
}

interface CacheWriteResponse {
  status: CacheWriteStatus;
  success: true;
}

interface CacheStats {
  entries: number;
  quotaExceeded: boolean;
  /** Bytes this origin is using across all storage, when the browser says. */
  usageBytes: number | null;
}

interface CacheStatsResponse {
  stats: CacheStats;
  success: true;
}

/**
 * What a context asks of the cache. Two implementations satisfy it: one
 * talking to IndexedDB directly, one relaying to the background worker.
 * Neither ever rejects — a broken cache degrades to a miss, never to a
 * failed export.
 */
interface CachePort {
  read(
    uuid: string,
    updatedAt: string | undefined,
  ): Promise<Conversation | null>;
  write(conversation: Conversation): Promise<CacheWriteStatus>;
}

export type {
  CacheClearRequest,
  CachePort,
  CacheReadRequest,
  CacheReadResponse,
  CacheRequest,
  CacheStats,
  CacheStatsRequest,
  CacheStatsResponse,
  CacheWriteRequest,
  CacheWriteResponse,
  CacheWriteStatus,
};
