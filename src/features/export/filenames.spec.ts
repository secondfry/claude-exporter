import { describe, expect, it } from 'vitest';

import {
  bulkZipFilename,
  conversationFilename,
  extensionForFormat,
  getLocalDateTimeString,
  mimeForFilename,
  sanitizeFilename,
  zipPrefix,
} from './filenames';
import type { ExportOptions } from './types';

function options(overrides: Partial<ExportOptions> = {}): ExportOptions {
  return {
    artifactFormat: 'original',
    extractArtifacts: false,
    flattenArtifacts: false,
    format: 'markdown',
    includeArtifacts: true,
    includeChats: true,
    includeMetadata: true,
    includeThinking: true,
    ...overrides,
  };
}

describe('sanitizeFilename', () => {
  it('replaces every character forbidden on Windows', () => {
    expect(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j')).toBe(
      'a_b_c_d_e_f_g_h_i_j',
    );
  });

  it('leaves ordinary names alone, including spaces and dots', () => {
    expect(sanitizeFilename('My chat v1.2 (final)')).toBe(
      'My chat v1.2 (final)',
    );
  });

  it('replaces one-for-one so distinct names stay distinct in length', () => {
    expect(sanitizeFilename('a/b')).toHaveLength(3);
  });

  it('handles an empty name', () => {
    expect(sanitizeFilename('')).toBe('');
  });
});

describe('getLocalDateTimeString', () => {
  it('formats as YYYYMMDD-HHMMSS in local time', () => {
    expect(getLocalDateTimeString(new Date(2025, 9, 31, 14, 30, 45))).toBe(
      '20251031-143045',
    );
  });

  it('zero-pads every component', () => {
    expect(getLocalDateTimeString(new Date(2025, 0, 2, 3, 4, 5))).toBe(
      '20250102-030405',
    );
  });
});

describe('zipPrefix', () => {
  it('uses claude-artifacts only for flat, non-nested, chatless exports', () => {
    expect(
      zipPrefix(
        options({
          extractArtifacts: false,
          flattenArtifacts: true,
          includeChats: false,
        }),
      ),
    ).toBe('claude-artifacts');
  });

  it('uses claude-exports when chats are included', () => {
    expect(
      zipPrefix(
        options({
          extractArtifacts: false,
          flattenArtifacts: true,
          includeChats: true,
        }),
      ),
    ).toBe('claude-exports');
  });

  it('uses claude-exports when artifacts are nested', () => {
    expect(
      zipPrefix(
        options({
          extractArtifacts: true,
          flattenArtifacts: true,
          includeChats: false,
        }),
      ),
    ).toBe('claude-exports');
  });

  it('uses claude-exports for a plain export', () => {
    expect(zipPrefix(options())).toBe('claude-exports');
  });
});

describe('bulkZipFilename', () => {
  it('joins prefix and timestamp', () => {
    const name = bulkZipFilename(options(), new Date(2025, 9, 31, 14, 30, 45));
    expect(name).toBe('claude-exports-20251031-143045.zip');
  });

  it('switches prefix for artifacts-only exports', () => {
    const name = bulkZipFilename(
      options({ flattenArtifacts: true, includeChats: false }),
      new Date(2025, 9, 31, 14, 30, 45),
    );
    expect(name).toBe('claude-artifacts-20251031-143045.zip');
  });
});

describe('conversationFilename', () => {
  it.each([
    ['markdown', 'md'],
    ['text', 'txt'],
    ['json', 'json'],
  ] as const)('%s exports use .%s', (format, ext) => {
    expect(conversationFilename('Chat', format)).toBe(`Chat.${ext}`);
    expect(extensionForFormat(format)).toBe(ext);
  });

  it('sanitises the name it is given', () => {
    expect(conversationFilename('re: a/b', 'markdown')).toBe('re_ a_b.md');
  });
});

describe('mimeForFilename', () => {
  it('maps known extensions', () => {
    expect(mimeForFilename('a.md')).toBe('text/markdown');
    expect(mimeForFilename('a.txt')).toBe('text/plain');
    expect(mimeForFilename('a.json')).toBe('application/json');
  });

  it('falls back for artifact extensions it does not know', () => {
    expect(mimeForFilename('script.py')).toBe('application/octet-stream');
  });
});
