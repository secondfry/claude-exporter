import { describe, it, expect } from 'vitest';
import { convertToMarkdown } from './index';
import type { Conversation } from '../conversation/types';

describe('convertToMarkdown — smoke test', () => {
  it('renders both human and assistant message text', () => {
    const data = {
      name: 'Test Chat',
      model: 'claude-sonnet-4-5-20250929',
      created_at: '2026-04-01T12:00:00Z',
      updated_at: '2026-04-01T12:00:00Z',
      current_leaf_message_uuid: 'm2',
      chat_messages: [
        {
          uuid: 'm1',
          sender: 'human',
          content: [{ type: 'text', text: 'Hello there' }],
          parent_message_uuid: '00000000-0000-0000-0000-000000000000',
        },
        {
          uuid: 'm2',
          sender: 'assistant',
          content: [{ type: 'text', text: 'General Kenobi' }],
          parent_message_uuid: 'm1',
        },
      ],
    } as unknown as Conversation;
    const md = convertToMarkdown(data, false);
    expect(md).toContain('Hello there');
    expect(md).toContain('General Kenobi');
  });

  it('includes metadata block when includeMetadata is true', () => {
    const data = {
      name: 'My Chat',
      model: 'claude-opus-4-5-20251101',
      created_at: '2026-04-01T12:00:00Z',
      updated_at: '2026-04-01T12:00:00Z',
      current_leaf_message_uuid: 'm1',
      chat_messages: [
        {
          uuid: 'm1',
          sender: 'human',
          content: [{ type: 'text', text: 'hi' }],
          parent_message_uuid: '00000000-0000-0000-0000-000000000000',
        },
      ],
    } as unknown as Conversation;
    const md = convertToMarkdown(data, true);
    expect(md).toContain('My Chat');
  });
});
