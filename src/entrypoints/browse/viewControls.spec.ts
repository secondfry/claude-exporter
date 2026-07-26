import { describe, expect, it } from 'vitest';

import { asSortField, asStatusFilter } from './viewControls';

// Characterization: these two used to sit in index.ts, unreachable by a spec,
// yet they are the only thing standing between a renamed `data-` attribute in
// browse.html and a StatusFilter/SortField the list cannot handle.

describe('browse/viewControls', () => {
  describe('asStatusFilter', () => {
    it.each([
      'pending',
      'never',
      'stale',
      'exported',
      'orphans',
      'projects',
    ] as const)('passes %s through', (value) => {
      expect(asStatusFilter(value)).toBe(value);
    });

    it('passes "all" through', () => {
      expect(asStatusFilter('all')).toBe('all');
    });

    // An unknown attribute must widen the View, never narrow it to nothing.
    it('falls back to "all" for an unrecognised value', () => {
      expect(asStatusFilter('archived')).toBe('all');
    });

    it('falls back to "all" when the attribute is absent', () => {
      expect(asStatusFilter(undefined)).toBe('all');
    });
  });

  describe('asSortField', () => {
    it.each(['name', 'project', 'created', 'updated', 'model'] as const)(
      'passes %s through',
      (value) => {
        expect(asSortField(value)).toBe(value);
      },
    );

    // null, not a default column: an unknown header must leave the sort alone.
    it('returns null for an unrecognised value', () => {
      expect(asSortField('summary')).toBeNull();
    });

    it('returns null when the attribute is absent', () => {
      expect(asSortField(undefined)).toBeNull();
    });
  });
});
