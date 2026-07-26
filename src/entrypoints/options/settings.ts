// The options page's decisions, with no DOM in them.
//
// index.ts is listener wiring and cannot be imported by a spec. Everything
// here answers a question — is this org ID usable, what does this failure mean
// to the user, how should the Chat Cache describe itself — and every one of
// those answers is text the user acts on, so they are worth pinning.

import type { CacheStats } from '$features/cache/messages';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isValidOrgId = (value: string): boolean => {
  return UUID_PATTERN.test(value);
};

/**
 * Translate a failed connection test into something actionable.
 *
 * The two statuses are genuinely different problems: 401 means the browser has
 * no claude.ai session, which the user fixes by logging in; 403 means the
 * session is fine but this organization is not theirs, which they fix by
 * correcting the ID. Reporting either as "connection error" sends them looking
 * at their network.
 */
const connectionErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('401')) {
    return 'Not authenticated. Please make sure you are logged into claude.ai';
  }
  if (message.includes('403')) {
    return 'Access denied. The Organization ID might be incorrect.';
  }
  return `Connection error: ${message}`;
};

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

const formatBytes = (bytes: number): string => {
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`;
  if (bytes < GB) return `${Math.round(bytes / MB)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
};

/**
 * One line describing the Chat Cache.
 *
 * The byte figure is origin-wide, so it covers settings and Export Records too
 * and will not match the entry count. Saying "in total" beats reporting a
 * number the user cannot reconcile. It is omitted entirely when the browser
 * declines to estimate.
 */
const describeCacheStats = (stats: CacheStats): string => {
  const parts = [
    `${stats.entries} conversation${stats.entries === 1 ? '' : 's'} cached`,
  ];
  if (stats.usageBytes !== null) {
    parts.push(
      `${formatBytes(stats.usageBytes)} of local storage used in total`,
    );
  }
  if (stats.quotaExceeded) {
    parts.push('storage is full — new conversations are not being cached');
  }
  return parts.join(' · ');
};

/** Only two values are meaningful; anything else stored is treated as the default. */
const resolveModelDisplay = (stored: string | undefined): string => {
  return stored === 'current' ? 'current' : 'original';
};

export {
  connectionErrorMessage,
  describeCacheStats,
  formatBytes,
  isValidOrgId,
  resolveModelDisplay,
};
