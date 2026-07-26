import { describe, expect, it } from 'vitest';

import type { ConversationSummary } from '$features/conversation/types';
import type { ExportResult } from '$features/export/types';

import {
  DEFAULT_EXPORT_OPTIONS,
  resolveOptions,
  toExportResponse,
  toExportTargets,
} from './export';

// Characterization tests for the DOM-free half of the content script.
//
// The response shape is a wire format: the popup renders `count`, `filename`
// and `warnings` verbatim, and there is no other channel through which a
// partial bulk failure reaches the user. It was previously inline in index.ts,
// which touches `window` at module load and so can never be imported here.

const summary = (
  overrides: Partial<ConversationSummary> & { uuid: string },
): ConversationSummary => {
  return {
    created_at: '2026-01-01T00:00:00.000Z',
    name: 'A chat',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
};

const result = (overrides?: Partial<ExportResult>): ExportResult => {
  return {
    artifactCount: 0,
    cacheQuotaExceeded: false,
    exportedIds: [],
    failedNames: [],
    filename: 'export.zip',
    fromCache: 0,
    recordsWritten: true,
    ...overrides,
  };
};

describe('resolveOptions', () => {
  it('fills every absent control from the defaults', () => {
    expect(resolveOptions({})).toEqual(DEFAULT_EXPORT_OPTIONS);
  });

  it('keeps what the caller actually sent', () => {
    const resolved = resolveOptions({
      format: 'markdown',
      includeThinking: true,
    });
    expect(resolved.format).toBe('markdown');
    expect(resolved.includeThinking).toBe(true);
  });

  // `false` is a control the user deliberately turned off, and `??` is what
  // keeps it from being read as "absent" and flipped back on by the default.
  it('preserves an explicit false rather than defaulting it', () => {
    expect(resolveOptions({ includeChats: false }).includeChats).toBe(false);
  });

  it('never returns the defaults object itself', () => {
    expect(resolveOptions({})).not.toBe(DEFAULT_EXPORT_OPTIONS);
  });
});

describe('toExportTargets', () => {
  it('maps uuid, name and updated_at across', () => {
    expect(
      toExportTargets([
        summary({ name: 'Planning', updated_at: 'T1', uuid: 'u1' }),
      ]),
    ).toEqual([{ name: 'Planning', updatedAt: 'T1', uuid: 'u1' }]);
  });

  // An unnamed conversation must still be identifiable in the ZIP and in the
  // failure list, so the UUID stands in for the title.
  it('falls back to the uuid when the conversation has no name', () => {
    expect(toExportTargets([summary({ name: '', uuid: 'u2' })])[0].name).toBe(
      'u2',
    );
  });

  // updatedAt is the Chat Cache's only freshness evidence; losing it here
  // would make every bulk export refetch while still reporting success.
  it('carries updatedAt so the Chat Cache can be consulted', () => {
    expect(
      toExportTargets([summary({ updated_at: 'T9', uuid: 'u3' })])[0].updatedAt,
    ).toBe('T9');
  });

  it('maps an empty list to an empty list', () => {
    expect(toExportTargets([])).toEqual([]);
  });
});

describe('toExportResponse', () => {
  it('reports success with the count and filename, and no warnings', () => {
    const response = toExportResponse(
      result({ exportedIds: ['a', 'b'], filename: 'chats.zip' }),
      2,
    );
    expect(response).toEqual({
      count: 2,
      filename: 'chats.zip',
      success: true,
    });
  });

  // Partial failure: the user has a file, so this is still success: true. The
  // losses are reported only through `warnings`.
  it('stays success: true on a partial failure and names what was lost', () => {
    const response = toExportResponse(
      result({ exportedIds: ['a'], failedNames: ['Beta', 'Gamma'] }),
      3,
    );
    expect(response.success).toBe(true);
    expect(response.count).toBe(1);
    expect(response.warnings).toBe(
      'Exported 1/3 conversations. Some failed: Beta; Gamma',
    );
  });

  // Every target failed but the pipeline still returned: count is 0 and the
  // warning is the whole story. The popup must not read this as "nothing to do".
  it('reports 0/N with every name when nothing survived', () => {
    const response = toExportResponse(
      result({ exportedIds: [], failedNames: ['Alpha', 'Beta'] }),
      2,
    );
    expect(response.count).toBe(0);
    expect(response.warnings).toBe(
      'Exported 0/2 conversations. Some failed: Alpha; Beta',
    );
  });

  // `attempted` is the caller's number, not the result's: a conversation that
  // fetched fine but produced no file is neither exported nor failed, so the
  // two counts genuinely differ and the denominator must stay the caller's.
  it('uses the caller-supplied attempted count as the denominator', () => {
    const response = toExportResponse(
      result({ exportedIds: ['a'], failedNames: ['Beta'] }),
      10,
    );
    expect(response.warnings).toContain('1/10');
  });

  it('omits warnings entirely when nothing failed', () => {
    expect(
      'warnings' in toExportResponse(result({ exportedIds: ['a'] }), 1),
    ).toBe(false);
  });
});
