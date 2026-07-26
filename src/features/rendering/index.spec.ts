import { describe, expect, it } from 'vitest';

import type { Conversation } from '$features/conversation/types';

import { convertToMarkdown } from './index';

describe('convertToMarkdown — smoke test', () => {
  it('renders both human and assistant message text', () => {
    const data = {
      chat_messages: [
        {
          content: [{ text: 'Hello there', type: 'text' }],
          parent_message_uuid: '00000000-0000-0000-0000-000000000000',
          sender: 'human',
          uuid: 'm1',
        },
        {
          content: [{ text: 'General Kenobi', type: 'text' }],
          parent_message_uuid: 'm1',
          sender: 'assistant',
          uuid: 'm2',
        },
      ],
      created_at: '2026-04-01T12:00:00Z',
      current_leaf_message_uuid: 'm2',
      model: 'claude-sonnet-4-5-20250929',
      name: 'Test Chat',
      updated_at: '2026-04-01T12:00:00Z',
    } as unknown as Conversation;
    const md = convertToMarkdown(data, false);
    expect(md).toContain('Hello there');
    expect(md).toContain('General Kenobi');
  });

  it('includes metadata block when includeMetadata is true', () => {
    const data = {
      chat_messages: [
        {
          content: [{ text: 'hi', type: 'text' }],
          parent_message_uuid: '00000000-0000-0000-0000-000000000000',
          sender: 'human',
          uuid: 'm1',
        },
      ],
      created_at: '2026-04-01T12:00:00Z',
      current_leaf_message_uuid: 'm1',
      model: 'claude-opus-4-5-20251101',
      name: 'My Chat',
      updated_at: '2026-04-01T12:00:00Z',
    } as unknown as Conversation;
    const md = convertToMarkdown(data, true);
    expect(md).toContain('My Chat');
  });
});
