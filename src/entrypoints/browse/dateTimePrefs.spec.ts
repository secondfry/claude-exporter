import { beforeEach, describe, expect, it } from 'vitest';

import {
  formatDate,
  formatTime,
  loadDateTimePrefs,
  loadModelPreference,
} from './dateTimePrefs';

// Characterization: the defaults matter more than the formats. A missing or
// junk preference must land on the shipped default, not on `undefined`, since
// the value is fed straight into a template string in the table.

describe('browse/dateTimePrefs', () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
  });

  describe('loadDateTimePrefs', () => {
    it('defaults to mdy and 12h when nothing is stored', async () => {
      expect(await loadDateTimePrefs()).toEqual({
        dateFormat: 'mdy',
        timeFormat: '12h',
      });
    });

    it('reads the stored alternatives', async () => {
      await chrome.storage.local.set({ dateFormat: 'dmy', timeFormat: '24h' });
      expect(await loadDateTimePrefs()).toEqual({
        dateFormat: 'dmy',
        timeFormat: '24h',
      });
    });

    it('falls back to the defaults for values it does not recognise', async () => {
      await chrome.storage.local.set({
        dateFormat: 'ymd',
        timeFormat: 'swatch',
      });
      expect(await loadDateTimePrefs()).toEqual({
        dateFormat: 'mdy',
        timeFormat: '12h',
      });
    });
  });

  describe('loadModelPreference', () => {
    it('defaults to original', async () => {
      expect(await loadModelPreference()).toBe('original');
    });

    it('reads "current" when stored', async () => {
      await chrome.storage.local.set({ modelDisplay: 'current' });
      expect(await loadModelPreference()).toBe('current');
    });

    it('falls back to original for anything else', async () => {
      await chrome.storage.local.set({ modelDisplay: 'newest' });
      expect(await loadModelPreference()).toBe('original');
    });
  });

  describe('formatDate', () => {
    const dt = new Date(2024, 2, 9); // 9 March 2024, local time

    it('renders month first for mdy', () => {
      expect(formatDate(dt, 'mdy')).toBe('3/9/2024');
    });

    it('renders day first for dmy', () => {
      expect(formatDate(dt, 'dmy')).toBe('9/3/2024');
    });

    // No zero padding, deliberately — that is what the table has always shown.
    it('does not zero-pad', () => {
      expect(formatDate(new Date(2024, 0, 1), 'mdy')).toBe('1/1/2024');
    });
  });

  describe('formatTime', () => {
    const dt = new Date(2024, 2, 9, 15, 4);

    it('renders 24h without a meridiem', () => {
      const formatted = formatTime(dt, '24h');
      expect(formatted).toContain('15');
      expect(formatted).not.toMatch(/[AP]M/i);
    });

    it('renders 12h with a meridiem', () => {
      const formatted = formatTime(dt, '12h');
      expect(formatted).toMatch(/[AP]M/i);
      expect(formatted).toContain('3');
    });
  });
});
