import { describe, expect, it } from 'vitest';

import { CE_ERROR_LOG_MAX, readErrorLog, sanitizeForDiagnostics } from './index';

describe('sanitizeForDiagnostics', () => {
  it('replaces one UUID', () => {
    const result = sanitizeForDiagnostics('chat/11111111-2222-3333-4444-555555555555/x');
    expect(result).toBe('chat/<id>/x');
  });

  it('replaces multiple UUIDs in one string', () => {
    const input = '11111111-2222-3333-4444-555555555555 and 66666666-7777-8888-9999-000000000000';
    const result = sanitizeForDiagnostics(input);
    expect(result).toBe('<id> and <id>');
  });

  it('is case-insensitive', () => {
    const result = sanitizeForDiagnostics('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE');
    expect(result).toBe('<id>');
  });

  it('leaves UUID-free strings untouched', () => {
    const result = sanitizeForDiagnostics('no ids here, just text');
    expect(result).toBe('no ids here, just text');
  });
});

describe('readErrorLog', () => {
  it('returns [] for undefined', () => {
    expect(readErrorLog(undefined)).toEqual([]);
  });

  it('returns [] for null', () => {
    expect(readErrorLog(null)).toEqual([]);
  });

  it('returns [] for a non-array', () => {
    expect(readErrorLog({ msg: 'y', ts: 'x' })).toEqual([]);
  });

  it('filters out entries missing ts or msg', () => {
    const entries = [
      { context: undefined, level: 'error', msg: 'ok', ts: '2026-01-01T00:00:00.000Z' },
      { context: undefined, level: 'error', msg: 'missing ts' },
      { context: undefined, level: 'error', ts: '2026-01-01T00:00:00.000Z' },
    ];
    const result = readErrorLog(entries);
    expect(result).toEqual([
      { context: undefined, level: 'error', msg: 'ok', ts: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('keeps well-formed entries', () => {
    const entries = [
      { col: 2, context: 'ctx', level: 'error', line: 1, msg: 'boom', source: 's', stack: 'st', ts: '2026-01-01T00:00:00.000Z' },
      { context: undefined, level: 'unhandledrejection', msg: 'rejected', ts: '2026-01-02T00:00:00.000Z' },
    ];
    const result = readErrorLog(entries);
    expect(result).toEqual(entries);
  });
});

describe('CE_ERROR_LOG_MAX', () => {
  it('is 50', () => {
    expect(CE_ERROR_LOG_MAX).toBe(50);
  });
});
