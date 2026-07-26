import { describe, expect, it } from 'vitest';

import {
  asExportFormat,
  CHAT_DEPENDENT_IDS,
  dependentOptionState,
} from './exportOptions';

// The DOM reads themselves are untestable here (no jsdom), but the two
// decisions around them are not: what a <select> value means, and what the
// chat-dependent options do when transcripts are switched off.

describe('browse/exportOptions', () => {
  describe('asExportFormat', () => {
    it.each(['json', 'text'] as const)('passes %s through', (value) => {
      expect(asExportFormat(value)).toBe(value);
    });

    it('passes markdown through', () => {
      expect(asExportFormat('markdown')).toBe('markdown');
    });

    // markdown is the shipped default, and the only fallback that produces a
    // readable file for a value the pipeline would otherwise not recognise.
    it('falls back to markdown for anything the pipeline cannot emit', () => {
      expect(asExportFormat('pdf')).toBe('markdown');
      expect(asExportFormat('')).toBe('markdown');
    });
  });

  describe('dependentOptionState', () => {
    it('leaves the options alone while chats are included', () => {
      expect(dependentOptionState(true)).toEqual({ disabled: false });
    });

    // Clearing as well as disabling: a checked-but-ignored box would describe
    // an Export that is not the one about to happen.
    it('disables and clears them when chats are excluded', () => {
      expect(dependentOptionState(false)).toEqual({
        checked: false,
        disabled: true,
      });
    });

    it('never re-checks anything when chats come back', () => {
      expect(dependentOptionState(true).checked).toBeUndefined();
    });
  });

  it('lists exactly the three options that follow #includeChats', () => {
    expect(CHAT_DEPENDENT_IDS).toEqual([
      'includeThinking',
      'includeMetadata',
      'includeArtifacts',
    ]);
  });
});
