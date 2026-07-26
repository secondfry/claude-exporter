import { describe, expect, it } from 'vitest';

import { EXPORT_FORMATS, isExportFormat } from '$features/export/formats';

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

// CLAUDE.md names this failure mode directly: two callers of the one export
// pipeline that each kept a private copy and drifted. Browse and the popup
// read the same <select>, and browse's hand-written copy of the format rule
// disagreed with the popup's on the fallback — the same unrecognised value
// exported as Markdown from one page and JSON from the other.
describe('asExportFormat agrees with the shared validator', () => {
  it('accepts every format the pipeline declares, unchanged', () => {
    for (const format of EXPORT_FORMATS) {
      expect(asExportFormat(format)).toBe(format);
    }
  });

  it('accepts nothing the shared validator rejects', () => {
    for (const value of ['pdf', '', 'JSON', 'markdown ']) {
      expect(isExportFormat(value)).toBe(false);
      expect(asExportFormat(value)).toBe('markdown');
    }
  });

  // The fallback is browse's own choice — its form defaults to Markdown — but
  // it must be a format the pipeline actually emits.
  it('falls back to a format the pipeline declares', () => {
    expect(isExportFormat(asExportFormat('nonsense'))).toBe(true);
  });
});
