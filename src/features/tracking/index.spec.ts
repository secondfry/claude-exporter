import { describe, expect, it, vi } from 'vitest';

import type { ConversationSummary } from '$features/conversation/types';
// vitest.setup.ts installs a real in-memory chrome.storage stub, so tracking
// exercises the real platform code path. That matters here specifically:
// the concurrency/serialisation tests below need an honest storage
// round-trip to be a meaningful regression guard for the write queue.
import { storageGet, storageSet } from '$platform';

import {
  clearExportRecords,
  emptyExportRecords,
  emptyModelDisplay,
  loadExportRecords,
  loadModelDisplay,
  markExported,
  recordExports,
  recordModelSnapshots,
} from './index';

const conv = (
  uuid: string,
  updatedAt: string,
  model: string | null = null,
): ConversationSummary => {
  return {
    created_at: '2026-01-01T00:00:00.000Z',
    model,
    name: 'Test',
    updated_at: updatedAt,
    uuid,
  };
};

describe('tracking', () => {
  describe('loadExportRecords / ExportRecordBook', () => {
    it('reads the exact "exportTimestamps" storage key and treats it as the Export Record boundary', async () => {
      await storageSet('local', {
        exportTimestamps: { c1: '2026-01-01T00:00:00.000Z' },
      });

      const book = await loadExportRecords();

      // Not stale at the exact recorded instant, stale a moment later — this
      // only holds if the book actually read the stored timestamp for c1.
      expect(book.isStale(conv('c1', '2026-01-01T00:00:00.000Z'))).toBe(false);
      expect(book.isStale(conv('c1', '2026-01-01T00:00:00.001Z'))).toBe(true);
      // Never exported is 'never', NOT Stale — Stale needs a record to be
      // newer than. It still needs Exporting.
      expect(book.status(conv('missing', '2026-01-01T00:00:00.000Z'))).toBe(
        'never',
      );
      expect(
        book.needsExport(conv('missing', '2026-01-01T00:00:00.000Z')),
      ).toBe(true);
    });

    it('defaults to an empty book when nothing is stored', async () => {
      const book = await loadExportRecords();
      expect(book.size).toBe(0);
      expect(book.status(conv('c1', '2026-01-01T00:00:00.000Z'))).toBe('never');
    });
  });

  describe('emptyExportRecords', () => {
    it('returns a book with size 0 in which nothing has ever been exported', () => {
      const book = emptyExportRecords();
      expect(book.size).toBe(0);
      expect(book.status(conv('c1', '2026-01-01T00:00:00.000Z'))).toBe('never');
      expect(book.isStale(conv('c1', '2026-01-01T00:00:00.000Z'))).toBe(false);
      expect(book.needsExport(conv('c1', '2026-01-01T00:00:00.000Z'))).toBe(
        true,
      );
    });
  });

  describe('recordExports (merge semantics)', () => {
    it('stamps every uuid with the same timestamp and merges with existing records', async () => {
      await storageSet('local', {
        exportTimestamps: { c1: 'stale-ts', keep: 'keep-ts' },
      });

      const book = await recordExports(
        ['c1', 'c2'],
        '2026-06-01T00:00:00.000Z',
      );

      const { exportTimestamps } = await storageGet<{
        exportTimestamps: Record<string, string>;
      }>('local', ['exportTimestamps']);
      expect(exportTimestamps).toEqual({
        c1: '2026-06-01T00:00:00.000Z',
        c2: '2026-06-01T00:00:00.000Z',
        keep: 'keep-ts',
      });
      expect(book.isStale(conv('c1', '2026-06-01T00:00:00.000Z'))).toBe(false);
      expect(book.isStale(conv('c1', '2026-06-01T00:00:00.001Z'))).toBe(true);
      expect(book.isStale(conv('c2', '2026-06-01T00:00:00.000Z'))).toBe(false);
      expect(book.isStale(conv('c2', '2026-06-01T00:00:00.001Z'))).toBe(true);
    });

    it('defaults `at` to now when omitted', async () => {
      const before = Date.now();

      const book = await recordExports(['c1']);

      const { exportTimestamps } = await storageGet<{
        exportTimestamps: Record<string, string>;
      }>('local', ['exportTimestamps']);
      const recordedAt = new Date(exportTimestamps.c1).getTime();
      expect(recordedAt).toBeGreaterThanOrEqual(before);
      expect(book.isStale(conv('c1', exportTimestamps.c1))).toBe(false);
    });

    it('short-circuits without writing when uuids is empty', async () => {
      const storageSetSpy = vi.spyOn(chrome.storage.local, 'set');

      await recordExports([], '2026-06-01T00:00:00.000Z');

      expect(storageSetSpy).not.toHaveBeenCalled();
      storageSetSpy.mockRestore();
    });
  });

  describe('markExported', () => {
    it('writes an Export Record like recordExports, for the manual override path', async () => {
      const book = await markExported(['c1']);
      // Recorded just now, so any conversation "updated" before that instant
      // reads as not-stale.
      expect(book.isStale(conv('c1', '1970-01-01T00:00:00.000Z'))).toBe(false);
    });
  });

  describe('clearExportRecords', () => {
    it('writes exactly { exportTimestamps: {} } and returns an empty book', async () => {
      await storageSet('local', { exportTimestamps: { c1: 'old' } });

      const book = await clearExportRecords();

      const stored = await storageGet<{
        exportTimestamps: Record<string, string>;
      }>('local', ['exportTimestamps']);
      expect(stored).toEqual({ exportTimestamps: {} });
      expect(book.size).toBe(0);
    });
  });

  describe('write serialisation', () => {
    it('two concurrent un-awaited recordExports calls: final write contains both', async () => {
      const p1 = recordExports(['a'], '2026-01-01T00:00:00.000Z');
      const p2 = recordExports(['b'], '2026-01-01T00:00:01.000Z');

      const [, book2] = await Promise.all([p1, p2]);

      expect(book2.isStale(conv('a', '2026-01-01T00:00:00.000Z'))).toBe(false);
      expect(book2.isStale(conv('a', '2026-01-01T00:00:00.001Z'))).toBe(true);
      expect(book2.isStale(conv('b', '2026-01-01T00:00:01.000Z'))).toBe(false);
      expect(book2.isStale(conv('b', '2026-01-01T00:00:01.001Z'))).toBe(true);
    });

    it('FIFO ordering: two writes for the same uuid, the later call wins', async () => {
      const p1 = recordExports(['c1'], '2026-01-01T00:00:00.000Z');
      const p2 = recordExports(['c1'], '2026-01-02T00:00:00.000Z');

      await Promise.all([p1, p2]);

      const book = await loadExportRecords();
      // Between the two writes: not-stale only if the later write (c1's real
      // FIFO winner) is what's stored. If the earlier write had won instead,
      // this same updated_at would read as stale.
      expect(book.isStale(conv('c1', '2026-01-01T12:00:00.000Z'))).toBe(false);
    });

    it('a read enqueued after a write observes the write', async () => {
      await recordExports(['c1'], '2026-03-01T00:00:00.000Z');
      const book = await loadExportRecords();
      expect(book.isStale(conv('c1', '2026-03-01T00:00:00.000Z'))).toBe(false);
      expect(book.isStale(conv('c1', '2026-03-01T00:00:00.001Z'))).toBe(true);
    });

    it("a write's returned book equals a freshly-loaded one", async () => {
      const written = await recordExports(['c1'], '2026-04-01T00:00:00.000Z');
      const loaded = await loadExportRecords();
      expect(loaded.isStale(conv('c1', '2026-04-01T00:00:00.000Z'))).toBe(
        written.isStale(conv('c1', '2026-04-01T00:00:00.000Z')),
      );
      expect(loaded.isStale(conv('c1', '2026-04-01T00:00:00.001Z'))).toBe(
        written.isStale(conv('c1', '2026-04-01T00:00:00.001Z')),
      );
      expect(loaded.size).toBe(written.size);
    });
  });

  describe('recordModelSnapshots', () => {
    it('creates a new snapshot for a first-seen conversation', async () => {
      await recordModelSnapshots([
        conv('c1', '2026-01-02T00:00:00.000Z', 'claude-opus'),
      ]);

      const { modelSnapshots } = await storageGet<{
        modelSnapshots: Record<
          string,
          {
            current: string;
            firstSeen: string;
            history: Array<{ at: string; model: string }>;
          }
        >;
      }>('local', ['modelSnapshots']);
      expect(modelSnapshots.c1.firstSeen).toBe('claude-opus');
      expect(modelSnapshots.c1.current).toBe('claude-opus');
      expect(modelSnapshots.c1.history).toHaveLength(1);
      expect(modelSnapshots.c1.history[0].model).toBe('claude-opus');
    });

    it('updates current and appends history when the model bounces', async () => {
      await storageSet('local', {
        modelSnapshots: {
          c1: {
            current: 'claude-old',
            currentAt: '2026-01-01T00:00:00.000Z',
            firstSeen: 'claude-old',
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            history: [{ at: '2026-01-01T00:00:00.000Z', model: 'claude-old' }],
          },
        },
      });

      await recordModelSnapshots([
        conv('c1', '2026-01-02T00:00:00.000Z', 'claude-new'),
      ]);

      const { modelSnapshots } = await storageGet<{
        modelSnapshots: Record<
          string,
          {
            current: string;
            firstSeen: string;
            history: Array<{ at: string; model: string }>;
          }
        >;
      }>('local', ['modelSnapshots']);
      const snap = modelSnapshots.c1;
      expect(snap.firstSeen).toBe('claude-old');
      expect(snap.current).toBe('claude-new');
      expect(snap.history).toHaveLength(2);
      expect(snap.history[1].model).toBe('claude-new');
    });

    it('does not write when nothing changed', async () => {
      await storageSet('local', {
        modelSnapshots: {
          c1: {
            current: 'claude-old',
            currentAt: '2026-01-01T00:00:00.000Z',
            firstSeen: 'claude-old',
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            history: [{ at: '2026-01-01T00:00:00.000Z', model: 'claude-old' }],
          },
        },
      });
      const storageSetSpy = vi.spyOn(chrome.storage.local, 'set');

      await recordModelSnapshots([
        conv('c1', '2026-01-02T00:00:00.000Z', 'claude-old'),
      ]);

      expect(storageSetSpy).not.toHaveBeenCalled();
      storageSetSpy.mockRestore();
    });

    it('skips conversations with a null model rather than snapshotting a guess', async () => {
      const storageSetSpy = vi.spyOn(chrome.storage.local, 'set');

      await recordModelSnapshots([
        conv('c1', '2026-01-02T00:00:00.000Z', null),
      ]);

      expect(storageSetSpy).not.toHaveBeenCalled();
      storageSetSpy.mockRestore();
    });

    it('is a no-op for non-array input', async () => {
      const storageGetSpy = vi.spyOn(chrome.storage.local, 'get');
      const storageSetSpy = vi.spyOn(chrome.storage.local, 'set');

      // @ts-expect-error deliberately passing a bad shape to mirror original defensive check
      await recordModelSnapshots(null);

      expect(storageGetSpy).not.toHaveBeenCalled();
      expect(storageSetSpy).not.toHaveBeenCalled();
      storageGetSpy.mockRestore();
      storageSetSpy.mockRestore();
    });
  });

  describe('ExportRecordBook#status', () => {
    // The distinction the browse "Previously exported" filter got wrong: a
    // Conversation edited after its Export Record still HAS one.
    it('separates never-exported from Stale', async () => {
      await storageSet('local', {
        exportTimestamps: { c1: '2026-01-02T00:00:00.000Z' },
      });
      const book = await loadExportRecords();
      expect(book.status(conv('c1', '2026-01-03T00:00:00.000Z'))).toBe('stale');
      expect(book.status(conv('c1', '2026-01-02T00:00:00.000Z'))).toBe(
        'current',
      );
      expect(book.status(conv('nope', '2026-01-03T00:00:00.000Z'))).toBe(
        'never',
      );
    });

    it('needsExport covers never and stale but not current', async () => {
      await storageSet('local', {
        exportTimestamps: { c1: '2026-01-02T00:00:00.000Z' },
      });
      const book = await loadExportRecords();
      expect(book.needsExport(conv('c1', '2026-01-03T00:00:00.000Z'))).toBe(
        true,
      );
      expect(book.needsExport(conv('nope', '2026-01-03T00:00:00.000Z'))).toBe(
        true,
      );
      expect(book.needsExport(conv('c1', '2026-01-02T00:00:00.000Z'))).toBe(
        false,
      );
    });
  });

  describe('ExportRecordBook#isStale', () => {
    it('is NOT stale when the conversation has never been exported', () => {
      const book = emptyExportRecords();
      expect(book.isStale(conv('c1', '2026-01-02T00:00:00.000Z'))).toBe(false);
    });

    it('is stale when updated_at is strictly later than the export record', async () => {
      await storageSet('local', {
        exportTimestamps: { c1: '2026-01-02T00:00:00.000Z' },
      });
      const book = await loadExportRecords();
      expect(book.isStale(conv('c1', '2026-01-03T00:00:00.000Z'))).toBe(true);
    });

    it('is NOT stale when updated_at exactly equals the export record (boundary)', async () => {
      await storageSet('local', {
        exportTimestamps: { c1: '2026-01-02T00:00:00.000Z' },
      });
      const book = await loadExportRecords();
      expect(book.isStale(conv('c1', '2026-01-02T00:00:00.000Z'))).toBe(false);
    });

    it('is NOT stale when updated_at is earlier than the export record', async () => {
      await storageSet('local', {
        exportTimestamps: { c1: '2026-01-02T00:00:00.000Z' },
      });
      const book = await loadExportRecords();
      expect(book.isStale(conv('c1', '2026-01-01T00:00:00.000Z'))).toBe(false);
    });
  });

  describe('ExportRecordBook#needsExportCount', () => {
    it('counts never-exported and Stale conversations over a mixed list', async () => {
      await storageSet('local', {
        exportTimestamps: {
          c1: '2026-01-02T00:00:00.000Z', // current: updated_at equal
          c2: '2026-01-01T00:00:00.000Z', // stale: updated_at later
        },
      });
      const book = await loadExportRecords();

      const convs = [
        conv('c1', '2026-01-02T00:00:00.000Z'),
        conv('c2', '2026-01-03T00:00:00.000Z'),
        conv('c3', '2026-01-01T00:00:00.000Z'), // never exported
      ];

      expect(book.needsExportCount(convs)).toBe(2);
    });
  });

  describe('loadModelDisplay / emptyModelDisplay / ModelDisplayBook#display', () => {
    it('returns the raw model with bounced=false and no "other" when there is no snapshot', async () => {
      const book = await loadModelDisplay('original');
      const result = book.display(
        conv('c1', '2026-01-02T00:00:00.000Z', 'claude-x'),
      );
      expect(result).toEqual({
        bounced: false,
        model: 'claude-x',
        other: '',
        otherLabel: '',
      });
    });

    it('emptyModelDisplay behaves the same as an empty loaded book', () => {
      const book = emptyModelDisplay('original');
      const result = book.display(
        conv('c1', '2026-01-02T00:00:00.000Z', 'claude-x'),
      );
      expect(result).toEqual({
        bounced: false,
        model: 'claude-x',
        other: '',
        otherLabel: '',
      });
    });

    it('"original" preference: shows first-seen as model, current as other/"Currently" when bounced', async () => {
      await storageSet('local', {
        modelSnapshots: {
          c1: {
            current: 'claude-b',
            currentAt: 't1',
            firstSeen: 'claude-a',
            firstSeenAt: 't0',
            history: [],
          },
        },
      });
      const book = await loadModelDisplay('original');

      const result = book.display(conv('c1', '2026-01-02T00:00:00.000Z'));

      expect(result).toEqual({
        bounced: true,
        model: 'claude-a',
        other: 'claude-b',
        otherLabel: 'Currently',
      });
    });

    it('"current" preference: shows current as model, first-seen as other/"Originally" when bounced', async () => {
      await storageSet('local', {
        modelSnapshots: {
          c1: {
            current: 'claude-b',
            currentAt: 't1',
            firstSeen: 'claude-a',
            firstSeenAt: 't0',
            history: [],
          },
        },
      });
      const book = await loadModelDisplay('current');

      const result = book.display(conv('c1', '2026-01-02T00:00:00.000Z'));

      expect(result).toEqual({
        bounced: true,
        model: 'claude-b',
        other: 'claude-a',
        otherLabel: 'Originally',
      });
    });

    it('not bounced when the model never changed: still surfaces a matching "other"', async () => {
      await storageSet('local', {
        modelSnapshots: {
          c1: {
            current: 'claude-a',
            currentAt: 't0',
            firstSeen: 'claude-a',
            firstSeenAt: 't0',
            history: [],
          },
        },
      });
      const book = await loadModelDisplay('original');

      const result = book.display(conv('c1', '2026-01-02T00:00:00.000Z'));

      expect(result.model).toBe('claude-a');
      expect(result.bounced).toBe(false);
    });
  });
});
