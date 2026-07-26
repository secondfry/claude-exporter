import { describe, expect, it } from 'vitest';

import { EXPORT_FORMATS, isExportFormat, toExportFormat } from './formats';

// These exist so entrypoints stop writing `as ExportFormat` over a <select>
// value. The assertion was on the one value in the popup a user can influence,
// and it type-checked whatever the HTML happened to contain.

describe('isExportFormat', () => {
  it('accepts every format the pipeline declares', () => {
    for (const format of EXPORT_FORMATS) {
      expect(isExportFormat(format)).toBe(true);
    }
  });

  it('rejects strings that are not formats', () => {
    expect(isExportFormat('pdf')).toBe(false);
    expect(isExportFormat('')).toBe(false);
    expect(isExportFormat('JSON')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isExportFormat(undefined)).toBe(false);
    expect(isExportFormat(null)).toBe(false);
    expect(isExportFormat(0)).toBe(false);
    expect(isExportFormat({})).toBe(false);
  });
});

describe('toExportFormat', () => {
  it('passes valid formats through', () => {
    expect(toExportFormat('markdown')).toBe('markdown');
  });

  // Undefined rather than a default, so the pipeline's own default applies and
  // each caller does not invent its own.
  it('returns undefined rather than substituting a default', () => {
    expect(toExportFormat('pdf')).toBeUndefined();
    expect(toExportFormat(undefined)).toBeUndefined();
  });
});
