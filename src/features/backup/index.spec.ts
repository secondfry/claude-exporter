import { describe, it, expect, beforeEach } from 'vitest';
import { storageGet, storageSet } from '../../platform';
import { importBackup, isBackupFile, mergeStorageData } from './index';

interface BackupMeta {
  app: string;
  backupVersion: number;
  extensionVersion: string;
  createdAt: string;
}

interface BackupShape {
  _meta: BackupMeta;
  local: Record<string, unknown>;
  sync: Record<string, unknown>;
}

function makeBackup(overrides?: {
  local?: Record<string, unknown>;
  sync?: Record<string, unknown>;
}): BackupShape {
  return {
    _meta: {
      app: 'claude-exporter',
      backupVersion: 1,
      extensionVersion: '1.0.0',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    local: overrides?.local ?? { modelSnapshots: { a: 1 }, exportTimestamps: { b: 2 } },
    sync: overrides?.sync ?? { organizationId: 'org-1' },
  };
}

function fileFor(payload: unknown): File {
  return new File([JSON.stringify(payload)], 'b.json', { type: 'application/json' });
}

// NOTE: the original 54-test suite (copied verbatim into every feature's
// index.spec.js before this split) contained zero tests for the backup
// module (backupExtensionData / mergeStorageData / showImportModeModal /
// importBackup). This describe block is new coverage added during the
// TS conversion for mergeStorageData's per-key merge semantics, since
// there was nothing to prune from the original suite.
describe('mergeStorageData', () => {
  it('copies keys absent locally from the backup', () => {
    const result = mergeStorageData({}, { dateFormat: 'mdy' });
    expect(result).toEqual({ dateFormat: 'mdy' });
  });

  it('keeps the local scalar value on conflict', () => {
    const result = mergeStorageData({ dateFormat: 'dmy' }, { dateFormat: 'mdy' });
    expect(result).toEqual({ dateFormat: 'dmy' });
  });

  it('merges plain-object (map-shaped) keys, local wins on overlap', () => {
    const current = { exportTimestamps: { a: 1, b: 2 } };
    const backup = { exportTimestamps: { b: 99, c: 3 } };
    const result = mergeStorageData(current, backup);
    expect(result).toEqual({ exportTimestamps: { a: 1, b: 2, c: 3 } });
  });

  it('leaves local-only keys untouched', () => {
    const result = mergeStorageData({ onlyLocal: true }, {});
    expect(result).toEqual({ onlyLocal: true });
  });

  it('does not mutate the input objects', () => {
    const current = { modelSnapshots: { x: 1 } };
    const backup = { modelSnapshots: { y: 2 } };
    mergeStorageData(current, backup);
    expect(current).toEqual({ modelSnapshots: { x: 1 } });
    expect(backup).toEqual({ modelSnapshots: { y: 2 } });
  });
});

describe('isBackupFile', () => {
  it('accepts a real backup shape', () => {
    expect(isBackupFile(makeBackup())).toBe(true);
  });

  it('rejects null', () => {
    expect(isBackupFile(null)).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isBackupFile('not an object')).toBe(false);
  });

  it('rejects an object with no _meta', () => {
    expect(isBackupFile({ local: {}, sync: {} })).toBe(false);
  });

  it("rejects _meta.app that isn't 'claude-exporter'", () => {
    const backup = makeBackup();
    expect(isBackupFile({ ...backup, _meta: { ...backup._meta, app: 'other-app' } })).toBe(false);
  });

  it('rejects a missing local', () => {
    const backup = makeBackup();
    const withoutLocal: Record<string, unknown> = { _meta: backup._meta, sync: backup.sync };
    expect(isBackupFile(withoutLocal)).toBe(false);
  });

  it('rejects a non-object local', () => {
    expect(isBackupFile({ ...makeBackup(), local: 'nope' })).toBe(false);
  });
});

describe('importBackup', () => {
  beforeEach(async () => {
    await storageSet('local', {});
    await storageSet('sync', {});
  });

  it("writes parsed.local and parsed.sync on mode 'replace' and reports counts", async () => {
    const backup = makeBackup();
    const outcome = await importBackup(fileFor(backup), 'replace');

    expect(outcome.success).toBe(true);
    expect(outcome.message).toContain('1 model snapshot(s)');
    expect(outcome.message).toContain('1 export record(s)');

    const local = await storageGet<Record<string, unknown>>('local', null);
    const sync = await storageGet<Record<string, unknown>>('sync', null);
    expect(local).toEqual(backup.local);
    expect(sync).toEqual(backup.sync);
  });

  it("merges on mode 'merge': local wins on overlap, backup-only keys are added", async () => {
    await storageSet('local', {
      modelSnapshots: { a: 'local-value' },
      onlyLocal: true,
    });
    await storageSet('sync', { organizationId: 'local-org' });

    const backup = makeBackup({
      local: { modelSnapshots: { a: 'backup-value', c: 'backup-only' } },
      sync: { organizationId: 'backup-org', otherSyncKey: 'added' },
    });
    const outcome = await importBackup(fileFor(backup), 'merge');

    expect(outcome.success).toBe(true);

    const local = await storageGet<Record<string, unknown>>('local', null);
    const sync = await storageGet<Record<string, unknown>>('sync', null);
    expect(local).toEqual({
      modelSnapshots: { a: 'local-value', c: 'backup-only' },
      onlyLocal: true,
    });
    expect(sync).toEqual({ organizationId: 'local-org', otherSyncKey: 'added' });
  });

  it('returns failure with a JSON-mentioning message on invalid JSON', async () => {
    const file = new File(['{not valid json'], 'b.json', { type: 'application/json' });
    const outcome = await importBackup(file, 'replace');
    expect(outcome.success).toBe(false);
    expect(outcome.message.toLowerCase()).toContain('json');
  });

  it('returns failure for valid JSON that is not a backup', async () => {
    const outcome = await importBackup(fileFor({ hello: 'world' }), 'replace');
    expect(outcome.success).toBe(false);
  });
});
