import { describe, it, expect, vi, beforeEach } from 'vitest';

const storageGet = vi.fn();
const storageSet = vi.fn();

vi.mock('../../platform', () => ({
  storageGet: (...args: unknown[]) => storageGet(...args),
  storageSet: (...args: unknown[]) => storageSet(...args),
}));

import { loadExportRecords, recordExport, recordExports, loadModelSnapshots, recordModelSnapshots, isStale, getDisplayModel } from './index';
import type { ConversationSummary } from '../conversation/types';

function conv(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    uuid: 'c1',
    name: 'Test',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  storageGet.mockReset();
  storageSet.mockReset();
  storageGet.mockResolvedValue({});
  storageSet.mockResolvedValue(undefined);
});

describe('tracking', () => {
  describe('loadExportRecords', () => {
    it('reads the exact "exportTimestamps" storage key', async () => {
      storageGet.mockResolvedValue({ exportTimestamps: { c1: '2026-01-01T00:00:00.000Z' } });

      const records = await loadExportRecords();

      expect(storageGet).toHaveBeenCalledWith('local', ['exportTimestamps']);
      expect(records).toEqual({ c1: '2026-01-01T00:00:00.000Z' });
    });

    it('defaults to an empty object when nothing is stored', async () => {
      storageGet.mockResolvedValue({});
      expect(await loadExportRecords()).toEqual({});
    });
  });

  describe('recordExport', () => {
    it('merges a single export into existing records and writes under "exportTimestamps"', async () => {
      storageGet.mockResolvedValue({ exportTimestamps: { existing: 'old-ts' } });

      await recordExport('c1', '2026-05-01T00:00:00.000Z');

      expect(storageSet).toHaveBeenCalledWith('local', {
        exportTimestamps: { existing: 'old-ts', c1: '2026-05-01T00:00:00.000Z' },
      });
    });

    it('defaults `at` to now when omitted', async () => {
      storageGet.mockResolvedValue({});
      const before = Date.now();

      await recordExport('c1');

      const [, payload] = storageSet.mock.calls[0];
      const recordedAt = new Date(payload.exportTimestamps.c1).getTime();
      expect(recordedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('recordExports (merge semantics)', () => {
    it('stamps every uuid with the same timestamp and merges with existing records', async () => {
      storageGet.mockResolvedValue({ exportTimestamps: { keep: 'keep-ts', c1: 'stale-ts' } });

      await recordExports(['c1', 'c2'], '2026-06-01T00:00:00.000Z');

      expect(storageSet).toHaveBeenCalledWith('local', {
        exportTimestamps: {
          keep: 'keep-ts',
          c1: '2026-06-01T00:00:00.000Z',
          c2: '2026-06-01T00:00:00.000Z',
        },
      });
    });

    it('handles an empty uuid list as a no-op merge (still writes back unchanged records)', async () => {
      storageGet.mockResolvedValue({ exportTimestamps: { keep: 'keep-ts' } });

      await recordExports([], '2026-06-01T00:00:00.000Z');

      expect(storageSet).toHaveBeenCalledWith('local', { exportTimestamps: { keep: 'keep-ts' } });
    });
  });

  describe('loadModelSnapshots', () => {
    it('reads the exact "modelSnapshots" storage key', async () => {
      storageGet.mockResolvedValue({ modelSnapshots: { c1: { firstSeen: 'opus' } } });

      const snapshots = await loadModelSnapshots();

      expect(storageGet).toHaveBeenCalledWith('local', ['modelSnapshots']);
      expect(snapshots).toEqual({ c1: { firstSeen: 'opus' } });
    });
  });

  describe('recordModelSnapshots', () => {
    it('creates a new snapshot for a first-seen conversation', async () => {
      storageGet.mockResolvedValue({ modelSnapshots: {} });

      await recordModelSnapshots([conv({ model: 'claude-opus' } as Partial<ConversationSummary>)]);

      expect(storageSet).toHaveBeenCalledTimes(1);
      const [, payload] = storageSet.mock.calls[0];
      expect(payload.modelSnapshots.c1.firstSeen).toBe('claude-opus');
      expect(payload.modelSnapshots.c1.current).toBe('claude-opus');
      expect(payload.modelSnapshots.c1.history).toEqual([{ model: 'claude-opus', at: payload.modelSnapshots.c1.firstSeenAt }]);
    });

    it('updates current and appends history when the model bounces', async () => {
      storageGet.mockResolvedValue({
        modelSnapshots: {
          c1: {
            firstSeen: 'claude-old',
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            current: 'claude-old',
            currentAt: '2026-01-01T00:00:00.000Z',
            history: [{ model: 'claude-old', at: '2026-01-01T00:00:00.000Z' }],
          },
        },
      });

      await recordModelSnapshots([conv({ model: 'claude-new' } as Partial<ConversationSummary>)]);

      const [, payload] = storageSet.mock.calls[0];
      const snap = payload.modelSnapshots.c1;
      expect(snap.firstSeen).toBe('claude-old');
      expect(snap.current).toBe('claude-new');
      expect(snap.history).toHaveLength(2);
      expect(snap.history[1].model).toBe('claude-new');
    });

    it('does not write when nothing changed', async () => {
      storageGet.mockResolvedValue({
        modelSnapshots: {
          c1: {
            firstSeen: 'claude-old',
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            current: 'claude-old',
            currentAt: '2026-01-01T00:00:00.000Z',
            history: [{ model: 'claude-old', at: '2026-01-01T00:00:00.000Z' }],
          },
        },
      });

      await recordModelSnapshots([conv({ model: 'claude-old' } as Partial<ConversationSummary>)]);

      expect(storageSet).not.toHaveBeenCalled();
    });

    it('skips conversations with a null model rather than snapshotting a guess', async () => {
      storageGet.mockResolvedValue({ modelSnapshots: {} });

      await recordModelSnapshots([conv({ model: null } as Partial<ConversationSummary>)]);

      expect(storageSet).not.toHaveBeenCalled();
    });

    it('is a no-op for non-array input', async () => {
      // @ts-expect-error deliberately passing a bad shape to mirror original defensive check
      await recordModelSnapshots(null);
      expect(storageGet).not.toHaveBeenCalled();
      expect(storageSet).not.toHaveBeenCalled();
    });
  });

  describe('isStale', () => {
    it('is stale when the conversation has never been exported', () => {
      expect(isStale(conv(), {})).toBe(true);
    });

    it('is stale when updated_at is strictly later than the export record', () => {
      const c = conv({ updated_at: '2026-01-03T00:00:00.000Z' });
      expect(isStale(c, { c1: '2026-01-02T00:00:00.000Z' })).toBe(true);
    });

    it('is NOT stale when updated_at exactly equals the export record (boundary)', () => {
      const c = conv({ updated_at: '2026-01-02T00:00:00.000Z' });
      expect(isStale(c, { c1: '2026-01-02T00:00:00.000Z' })).toBe(false);
    });

    it('is NOT stale when updated_at is earlier than the export record', () => {
      const c = conv({ updated_at: '2026-01-01T00:00:00.000Z' });
      expect(isStale(c, { c1: '2026-01-02T00:00:00.000Z' })).toBe(false);
    });
  });

  describe('getDisplayModel', () => {
    it('returns the raw model with bounced=false when there is no snapshot', () => {
      const result = getDisplayModel(conv({ model: 'claude-x' } as Partial<ConversationSummary>), {}, 'original');
      expect(result).toEqual({ model: 'claude-x', bounced: false });
    });

    it('returns firstSeen for "original" preference, not bounced when model never changed', () => {
      const snapshots = { c1: { firstSeen: 'claude-a', firstSeenAt: 't0', current: 'claude-a', currentAt: 't0', history: [] } };
      const result = getDisplayModel(conv(), snapshots, 'original');
      expect(result).toEqual({ model: 'claude-a', bounced: false });
    });

    it('detects a bounce and honors "original" preference (shows first-seen model)', () => {
      const snapshots = { c1: { firstSeen: 'claude-a', firstSeenAt: 't0', current: 'claude-b', currentAt: 't1', history: [] } };
      const result = getDisplayModel(conv(), snapshots, 'original');
      expect(result).toEqual({ model: 'claude-a', bounced: true });
    });

    it('detects a bounce and honors "current" preference (shows current model)', () => {
      const snapshots = { c1: { firstSeen: 'claude-a', firstSeenAt: 't0', current: 'claude-b', currentAt: 't1', history: [] } };
      const result = getDisplayModel(conv(), snapshots, 'current');
      expect(result).toEqual({ model: 'claude-b', bounced: true });
    });
  });
});
