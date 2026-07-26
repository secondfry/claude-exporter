import { describe, expect, it } from 'vitest';

import { asTheme, oppositeTheme, themeLabel } from './theme';

// The DOM/localStorage halves are untestable here; the decisions are not.

describe('browse/theme', () => {
  describe('asTheme', () => {
    it('passes a recognised theme through', () => {
      expect(asTheme('light', 'dark')).toBe('light');
      expect(asTheme('dark', 'light')).toBe('dark');
    });

    // localStorage is shared with the popup and survives across versions, so
    // an unrecognised value is a real possibility, not a hypothetical.
    it('falls back for a value it does not recognise', () => {
      expect(asTheme('solarized', 'dark')).toBe('dark');
    });

    it('falls back when nothing is stored', () => {
      expect(asTheme(null, 'light')).toBe('light');
    });
  });

  describe('oppositeTheme', () => {
    it('flips both ways', () => {
      expect(oppositeTheme('dark')).toBe('light');
      expect(oppositeTheme('light')).toBe('dark');
    });
  });

  describe('themeLabel', () => {
    it('titlecases the theme for the settings dropdown', () => {
      expect(themeLabel('dark')).toBe('Dark');
      expect(themeLabel('light')).toBe('Light');
    });
  });
});
