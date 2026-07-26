import { describe, expect, it } from 'vitest';

import type { CacheStats } from '$features/cache/messages';

import {
  connectionErrorMessage,
  describeCacheStats,
  formatBytes,
  isValidOrgId,
  resolveModelDisplay,
} from './settings';

// Characterization tests for the options page's decisions. Each of these
// produces text the user acts on, and all of it was previously inline in
// index.ts, which registers listeners at module load and cannot be imported.

const stats = (overrides?: Partial<CacheStats>): CacheStats => {
  return { entries: 0, quotaExceeded: false, usageBytes: null, ...overrides };
};

describe('isValidOrgId', () => {
  it('accepts a lowercase UUID', () => {
    expect(isValidOrgId('12345678-1234-1234-1234-123456789abc')).toBe(true);
  });

  it('accepts an uppercase UUID', () => {
    expect(isValidOrgId('12345678-1234-1234-1234-123456789ABC')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidOrgId('')).toBe(false);
  });

  it('rejects a UUID with the wrong group lengths', () => {
    expect(isValidOrgId('1234567-1234-1234-1234-123456789abc')).toBe(false);
  });

  // Anchored at both ends: a UUID pasted with surrounding text is a paste
  // mistake, and accepting it would send an unusable ID to claude.ai.
  it('rejects a UUID with anything around it', () => {
    expect(isValidOrgId('org 12345678-1234-1234-1234-123456789abc')).toBe(
      false,
    );
    expect(isValidOrgId('12345678-1234-1234-1234-123456789abc/')).toBe(false);
  });

  it('rejects a non-hex character', () => {
    expect(isValidOrgId('1234567g-1234-1234-1234-123456789abc')).toBe(false);
  });
});

describe('connectionErrorMessage', () => {
  // 401 and 403 are different problems with different fixes — logging in
  // versus correcting the ID — so they must not collapse into one message.
  it('reads 401 as "not logged in"', () => {
    expect(connectionErrorMessage(new Error('HTTP 401'))).toContain(
      'logged into claude.ai',
    );
  });

  it('reads 403 as "wrong organization"', () => {
    expect(connectionErrorMessage(new Error('HTTP 403'))).toContain(
      'Organization ID might be incorrect',
    );
  });

  it('passes anything else through as a connection error', () => {
    expect(connectionErrorMessage(new Error('network down'))).toBe(
      'Connection error: network down',
    );
  });

  it('survives a rejection that is not an Error', () => {
    expect(connectionErrorMessage('plain string')).toBe(
      'Connection error: plain string',
    );
  });
});

describe('formatBytes', () => {
  it('reports sub-megabyte sizes in KB', () => {
    expect(formatBytes(2048)).toBe('2 KB');
  });

  it('reports megabyte sizes in MB', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
  });

  it('reports gigabyte sizes in GB with one decimal', () => {
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });

  it('reports zero as 0 KB rather than an empty string', () => {
    expect(formatBytes(0)).toBe('0 KB');
  });
});

describe('describeCacheStats', () => {
  it('pluralises the entry count', () => {
    expect(describeCacheStats(stats({ entries: 1 }))).toContain(
      '1 conversation cached',
    );
    expect(describeCacheStats(stats({ entries: 2 }))).toContain(
      '2 conversations cached',
    );
    expect(describeCacheStats(stats({ entries: 0 }))).toContain(
      '0 conversations cached',
    );
  });

  // The browser may decline to estimate; a missing figure is left out rather
  // than reported as zero, which would read as "the cache is empty".
  it('omits the size entirely when the browser gives no estimate', () => {
    expect(describeCacheStats(stats({ usageBytes: null }))).not.toContain('KB');
  });

  it('reports the size as origin-wide, not per-cache', () => {
    expect(describeCacheStats(stats({ usageBytes: 2048 }))).toContain(
      '2 KB of local storage used in total',
    );
  });

  it('says so when storage is full', () => {
    expect(describeCacheStats(stats({ quotaExceeded: true }))).toContain(
      'storage is full',
    );
  });

  it('joins its parts with a middot', () => {
    expect(
      describeCacheStats(
        stats({ entries: 3, quotaExceeded: true, usageBytes: 1024 }),
      ),
    ).toBe(
      '3 conversations cached · 1 KB of local storage used in total · storage is full — new conversations are not being cached',
    );
  });
});

describe('resolveModelDisplay', () => {
  it("keeps 'current' when that is what was stored", () => {
    expect(resolveModelDisplay('current')).toBe('current');
  });

  it("defaults to 'original' when nothing is stored", () => {
    expect(resolveModelDisplay(undefined)).toBe('original');
  });

  // Storage is shared with older and newer versions of the extension, so an
  // unrecognised value must land on the default rather than on nothing.
  it("treats an unrecognised value as 'original'", () => {
    expect(resolveModelDisplay('something-else')).toBe('original');
  });
});
