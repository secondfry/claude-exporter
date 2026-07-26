import { describe, expect, it } from 'vitest';

import {
  describeBulkExport,
  describeConversationExport,
} from './exportOutcome';

const response = (overrides: { count?: number; warnings?: string } = {}) => ({
  count: 0,
  filename: 'export.zip',
  success: true as const,
  ...overrides,
});

describe('describeConversationExport', () => {
  it('is a success, so the status line may clear itself', () => {
    expect(describeConversationExport()).toEqual({
      message: 'Conversation exported successfully!',
      type: 'success',
    });
  });
});

describe('describeBulkExport', () => {
  it('reports the count when every conversation made it', () => {
    expect(describeBulkExport(response({ count: 42 }))).toEqual({
      message: 'Exported 42 conversations!',
      type: 'success',
    });
  });

  // Regression. `warnings` is the only place the names of the conversations
  // that failed are shown. Typing it 'success' made the popup render it green
  // — reading as "all good" — and then erase it after three seconds, which is
  // often before the user has finished reading, and always before they could
  // act on it.
  it('keeps a partial failure as info, so it stays on screen', () => {
    const outcome = describeBulkExport(
      response({
        count: 38,
        warnings: 'Exported 38/50 conversations. Some failed: A; B; C',
      }),
    );

    expect(outcome.type).toBe('info');
    expect(outcome.type).not.toBe('success');
    expect(outcome.message).toContain('Some failed: A; B; C');
  });

  it('prefers the warning text over the count when both are present', () => {
    expect(
      describeBulkExport(response({ count: 1, warnings: 'partial' })).message,
    ).toBe('partial');
  });

  it('treats an empty warning string as no warning', () => {
    expect(describeBulkExport(response({ count: 3, warnings: '' }))).toEqual({
      message: 'Exported 3 conversations!',
      type: 'success',
    });
  });
});
