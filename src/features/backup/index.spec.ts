import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storageGet, storageSet } from '$platform';

import {
  backupExtensionData,
  importBackup,
  isBackupFile,
  mergeStorageData,
} from './index';

interface BackupMeta {
  app: string;
  backupVersion: number;
  createdAt: string;
  extensionVersion: string;
}

interface BackupShape {
  _meta: BackupMeta;
  local: Record<string, unknown>;
  sync: Record<string, unknown>;
}

const makeBackup = (overrides?: {
  local?: Record<string, unknown>;
  sync?: Record<string, unknown>;
}): BackupShape => {
  return {
    _meta: {
      app: 'claude-exporter',
      backupVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      extensionVersion: '1.0.0',
    },
    local: overrides?.local ?? {
      exportTimestamps: { b: 2 },
      modelSnapshots: { a: 1 },
    },
    sync: overrides?.sync ?? { organizationId: 'org-1' },
  };
};

const fileFor = (payload: unknown): File => {
  return new File([JSON.stringify(payload)], 'b.json', {
    type: 'application/json',
  });
};

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
    const result = mergeStorageData(
      { dateFormat: 'dmy' },
      { dateFormat: 'mdy' },
    );
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
    expect(
      isBackupFile({ ...backup, _meta: { ...backup._meta, app: 'other-app' } }),
    ).toBe(false);
  });

  it('rejects a missing local', () => {
    const backup = makeBackup();
    const withoutLocal: Record<string, unknown> = {
      _meta: backup._meta,
      sync: backup.sync,
    };
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
    expect(sync).toEqual({
      organizationId: 'local-org',
      otherSyncKey: 'added',
    });
  });

  it('returns failure with a JSON-mentioning message on invalid JSON', async () => {
    const file = new File(['{not valid json'], 'b.json', {
      type: 'application/json',
    });
    const outcome = await importBackup(file, 'replace');
    expect(outcome.success).toBe(false);
    expect(outcome.message.toLowerCase()).toContain('json');
  });

  it('returns failure for valid JSON that is not a backup', async () => {
    const outcome = await importBackup(fileFor({ hello: 'world' }), 'replace');
    expect(outcome.success).toBe(false);
  });

  // The file came off the user's disk, so every one of these is reachable.
  it('rejects a file whose _meta belongs to another app', async () => {
    const backup = makeBackup();
    const outcome = await importBackup(
      fileFor({ ...backup, _meta: { ...backup._meta, app: 'other-app' } }),
      'replace',
    );
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain('Claude Exporter backup file');
  });

  it('rejects a file whose local section is not an object', async () => {
    const outcome = await importBackup(
      fileFor({ ...makeBackup(), local: 'nope' }),
      'replace',
    );
    expect(outcome.success).toBe(false);
  });

  it('rejects a JSON array', async () => {
    const outcome = await importBackup(fileFor([1, 2, 3]), 'replace');
    expect(outcome.success).toBe(false);
  });

  // A missing sync section is tolerated rather than rejected — only `local`
  // is required — and it lands as an empty object, not as undefined.
  it('accepts a backup with no sync section and stores an empty one', async () => {
    const backup = makeBackup();
    const outcome = await importBackup(
      fileFor({ _meta: backup._meta, local: backup.local }),
      'replace',
    );
    expect(outcome.success).toBe(true);
    expect(await storageGet<Record<string, unknown>>('sync', null)).toEqual({});
  });

  it('names the mode in the success message', async () => {
    const replaced = await importBackup(fileFor(makeBackup()), 'replace');
    const merged = await importBackup(fileFor(makeBackup()), 'merge');
    expect(replaced.message).toContain('(replace)');
    expect(merged.message).toContain('(merge)');
  });
});

// The download itself is the only part of backupExtensionData that touches the
// DOM, and it is a fixed four lines. Stubbing just that (no jsdom — the test
// environment is `node`) buys the whole round trip: what backupExtensionData
// writes must be exactly what importBackup accepts, which is the one property
// no test of either half alone can check.
interface DownloadCapture {
  payload: () => Promise<unknown>;
}

const captureDownload = (): DownloadCapture => {
  // An array, not a reassigned `let`: the write happens inside a callback, and
  // this keeps the read side honest without a type assertion.
  const captured: Blob[] = [];

  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => {
      captured.push(blob);
      return 'blob:test';
    },
    revokeObjectURL: () => {},
  });
  vi.stubGlobal('document', {
    body: { appendChild: () => {}, removeChild: () => {} },
    createElement: () => ({ click: () => {} }),
  });

  return {
    payload: async () => {
      const blob = captured[0];
      if (blob === undefined) throw new Error('nothing was downloaded');
      return JSON.parse(await blob.text());
    },
  };
};

describe('backupExtensionData → importBackup round trip', () => {
  let download: DownloadCapture;

  beforeEach(async () => {
    download = captureDownload();
    await storageSet('local', {
      exportTimestamps: { 'uuid-b': '2026-01-02T00:00:00.000Z' },
      modelSnapshots: { 'uuid-a': 'claude-opus-4' },
    });
    await storageSet('sync', { organizationId: 'org-1' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes a file its own validator accepts', async () => {
    const outcome = await backupExtensionData();
    expect(outcome.success).toBe(true);
    expect(isBackupFile(await download.payload())).toBe(true);
  });

  it('reports the snapshot and Export Record counts it wrote', async () => {
    const outcome = await backupExtensionData();
    expect(outcome.message).toContain('1 model snapshot(s)');
    expect(outcome.message).toContain('1 export record(s)');
  });

  it('restores every backed-up key through replace', async () => {
    await backupExtensionData();
    const payload = await download.payload();

    await storageSet('local', {
      modelSnapshots: { 'uuid-a': 'overwritten' },
    });

    const outcome = await importBackup(fileFor(payload), 'replace');
    expect(outcome.success).toBe(true);
    expect(
      await storageGet<Record<string, unknown>>('local', null),
    ).toMatchObject({
      exportTimestamps: { 'uuid-b': '2026-01-02T00:00:00.000Z' },
      modelSnapshots: { 'uuid-a': 'claude-opus-4' },
    });
    expect(await storageGet<Record<string, unknown>>('sync', null)).toEqual({
      organizationId: 'org-1',
    });
  });

  // "Replace" overwrites every key the backup carries, but storage.set is a
  // merge, not a truncate — a key that exists locally and not in the backup
  // survives. Worth pinning: the label promises more than the mechanism does.
  it('leaves local-only keys standing even on replace', async () => {
    await backupExtensionData();
    const payload = await download.payload();

    await storageSet('local', { somethingElse: true });
    await importBackup(fileFor(payload), 'replace');

    const local = await storageGet<Record<string, unknown>>('local', null);
    expect(local.somethingElse).toBe(true);
  });

  // Re-importing a backup over the storage it came from must be a no-op, not a
  // duplication: merge keeps the local value on every overlapping key.
  it('is idempotent when merged back over its own source', async () => {
    await backupExtensionData();
    const before = await storageGet<Record<string, unknown>>('local', null);

    await importBackup(fileFor(await download.payload()), 'merge');
    expect(await storageGet<Record<string, unknown>>('local', null)).toEqual(
      before,
    );
  });

  // Never the Chat Cache: it lives in IndexedDB, which backup does not touch.
  it('carries only the two chrome.storage areas', async () => {
    await backupExtensionData();
    const payload = await download.payload();
    if (!isBackupFile(payload)) throw new Error('not a backup file');
    expect(Object.keys(payload).sort()).toEqual(['_meta', 'local', 'sync']);
  });
});
