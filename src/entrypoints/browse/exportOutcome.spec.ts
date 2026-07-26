import { describe, expect, it } from 'vitest';

import type { ExportResult } from '$features/export/types';

import {
  bulkExportToasts,
  progressDisplay,
  singleExportToasts,
} from './exportOutcome';

// Characterization of the messages the browse page shows after an Export.
// These had no coverage: the three-way branch (one Conversation / some failed
// / all succeeded), the Cache Hit count, the Chat Cache quota warning and the
// "could not be recorded" warning all lived inline in a DOM-only arrow.

const result = (overrides: Partial<ExportResult> = {}): ExportResult => {
  return {
    artifactCount: 0,
    cacheQuotaExceeded: false,
    exportedIds: [],
    failedNames: [],
    filename: 'conversations.zip',
    fromCache: 0,
    recordsWritten: true,
    ...overrides,
  };
};

const messages = (toasts: { message: string }[]): string[] => {
  return toasts.map((toast) => toast.message);
};

describe('browse/exportOutcome', () => {
  describe('singleExportToasts', () => {
    it('names the Conversation', () => {
      expect(messages(singleExportToasts(result(), 'Tuesday'))).toEqual([
        'Exported: Tuesday',
      ]);
    });

    it('mentions artifacts when the Export produced any', () => {
      expect(
        messages(singleExportToasts(result({ artifactCount: 3 }), 'Tuesday')),
      ).toEqual(['Exported: Tuesday with 3 artifact(s)']);
    });

    // The user has the file either way, so this follows the success message
    // rather than replacing it.
    it('warns after the success message when no Export Record was written', () => {
      const toasts = singleExportToasts(
        result({ recordsWritten: false }),
        'Tuesday',
      );
      expect(toasts).toEqual([
        { isError: false, message: 'Exported: Tuesday' },
        {
          isError: true,
          message: 'Export succeeded, but could not be recorded as exported.',
        },
      ]);
    });

    // A single row's Export is not the run that will feel a refetch.
    it('says nothing about the Chat Cache quota', () => {
      const toasts = singleExportToasts(
        result({ cacheQuotaExceeded: true }),
        'Tuesday',
      );
      expect(toasts).toHaveLength(1);
    });
  });

  describe('bulkExportToasts — exactly one target', () => {
    it('uses the single-Conversation wording, not "all 1 conversations"', () => {
      expect(
        messages(bulkExportToasts(result({ exportedIds: ['a'] }), ['Tuesday'])),
      ).toEqual(['Exported: Tuesday']);
    });

    it('mentions artifacts', () => {
      expect(
        messages(
          bulkExportToasts(result({ artifactCount: 2, exportedIds: ['a'] }), [
            'Tuesday',
          ]),
        ),
      ).toEqual(['Exported: Tuesday with 2 artifact(s)']);
    });

    // Even a single failed target takes this branch, because the branch is
    // chosen by how many were asked for, not by how many succeeded.
    it('still uses the single wording when the one target failed', () => {
      expect(
        messages(
          bulkExportToasts(result({ failedNames: ['Tuesday'] }), ['Tuesday']),
        ),
      ).toEqual(['Exported: Tuesday']);
    });
  });

  describe('bulkExportToasts — some failed', () => {
    it('reports completed out of asked-for, and the failure count', () => {
      const toasts = bulkExportToasts(
        result({ exportedIds: ['a', 'b'], failedNames: ['c'] }),
        ['a', 'b', 'c'],
      );
      expect(messages(toasts)).toEqual([
        'Exported 2 of 3 conversations (1 failed).',
      ]);
    });

    // Partial failure is reported as an ordinary toast, not an error one.
    it('is not styled as an error', () => {
      const toasts = bulkExportToasts(
        result({ exportedIds: ['a'], failedNames: ['b'] }),
        ['a', 'b'],
      );
      expect(toasts[0].isError).toBe(false);
    });

    it('never mentions Cache Hits on the failure branch', () => {
      const toasts = bulkExportToasts(
        result({ exportedIds: ['a'], failedNames: ['b'], fromCache: 1 }),
        ['a', 'b'],
      );
      expect(toasts[0].message).not.toContain('from cache');
    });
  });

  describe('bulkExportToasts — all succeeded', () => {
    it('celebrates the whole run', () => {
      expect(
        messages(
          bulkExportToasts(result({ exportedIds: ['a', 'b'] }), ['a', 'b']),
        ),
      ).toEqual(['Successfully exported all 2 conversations!']);
    });

    it('appends the Cache Hit count when there were any', () => {
      expect(
        messages(
          bulkExportToasts(result({ exportedIds: ['a', 'b'], fromCache: 2 }), [
            'a',
            'b',
          ]),
        ),
      ).toEqual(['Successfully exported all 2 conversations! (2 from cache)']);
    });

    it('omits the Cache Hit clause when nothing came from the Chat Cache', () => {
      expect(
        messages(
          bulkExportToasts(result({ exportedIds: ['a', 'b'] }), ['a', 'b']),
        ),
      ).toEqual(['Successfully exported all 2 conversations!']);
    });
  });

  describe('bulkExportToasts — the caveats', () => {
    it('warns about the Chat Cache quota after the success message', () => {
      const toasts = bulkExportToasts(
        result({ cacheQuotaExceeded: true, exportedIds: ['a', 'b'] }),
        ['a', 'b'],
      );
      expect(toasts).toEqual([
        {
          isError: false,
          message: 'Successfully exported all 2 conversations!',
        },
        {
          isError: true,
          message:
            'Local storage is full, so conversations are no longer being cached.',
        },
      ]);
    });

    it('orders quota before the missing Export Records warning', () => {
      const toasts = bulkExportToasts(
        result({
          cacheQuotaExceeded: true,
          exportedIds: ['a', 'b'],
          recordsWritten: false,
        }),
        ['a', 'b'],
      );
      expect(messages(toasts)).toEqual([
        'Successfully exported all 2 conversations!',
        'Local storage is full, so conversations are no longer being cached.',
        'Export succeeded, but could not be recorded as exported.',
      ]);
    });

    it('shows both caveats on the partial-failure branch too', () => {
      const toasts = bulkExportToasts(
        result({
          cacheQuotaExceeded: true,
          exportedIds: ['a'],
          failedNames: ['b'],
          recordsWritten: false,
        }),
        ['a', 'b'],
      );
      expect(toasts).toHaveLength(3);
    });
  });

  describe('progressDisplay', () => {
    it('counts failures towards the bar, since they are done too', () => {
      expect(
        progressDisplay({
          completed: 1,
          failed: 1,
          phase: 'fetching',
          total: 4,
        }).barWidth,
      ).toBe('50%');
    });

    it('reports succeeded, failed and total', () => {
      expect(
        progressDisplay({
          completed: 1,
          failed: 2,
          phase: 'fetching',
          total: 4,
        }).stats,
      ).toBe('1 succeeded, 2 failed out of 4');
    });

    // Zero-length Exports would otherwise divide by zero and render "NaN%".
    it('stays at 0% when there is nothing to do', () => {
      expect(
        progressDisplay({
          completed: 0,
          failed: 0,
          phase: 'fetching',
          total: 0,
        }).barWidth,
      ).toBe('0%');
    });

    it('rounds rather than truncating', () => {
      expect(
        progressDisplay({
          completed: 1,
          failed: 0,
          phase: 'fetching',
          total: 3,
        }).barWidth,
      ).toBe('33%');
    });

    it('leaves the headline text alone while fetching', () => {
      expect(
        progressDisplay({
          completed: 1,
          failed: 0,
          phase: 'fetching',
          total: 2,
        }).text,
      ).toBeNull();
    });

    it('drives the bar from its own percentage while zipping', () => {
      expect(
        progressDisplay({
          completed: 70,
          failed: 0,
          phase: 'zipping',
          total: 2,
        }),
      ).toEqual({
        barWidth: '70%',
        stats: null,
        text: 'Creating ZIP file...',
      });
    });
  });
});
