import { describe, it, expect } from 'vitest';
import { mergeStorageData } from './index';

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
