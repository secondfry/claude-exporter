import { describe, expect, it } from 'vitest';

import type { Conversation } from '$features/conversation/types';

import { convertToMarkdown, convertToText } from './index';

// Characterization suite. These pin the EXACT bytes of an exported file —
// separators and blank lines are the contract, not incidental formatting.
const makeConversation = (message: Record<string, unknown>): Conversation =>
  ({
    chat_messages: [
      {
        parent_message_uuid: '00000000-0000-0000-0000-000000000000',
        sender: 'assistant',
        uuid: 'm1',
        ...message,
      },
    ],
    created_at: '2026-04-01T12:00:00Z',
    current_leaf_message_uuid: 'm1',
    model: 'claude-opus-4-5',
    name: 'Test',
    updated_at: '2026-04-02T13:00:00Z',
  }) as unknown as Conversation;

describe('convertToMarkdown — exact output', () => {
  it('renders a thinking block when includeThinking is true', () => {
    const data = makeConversation({
      content: [{ thinking: 'reasoning', type: 'thinking' }],
    });
    expect(convertToMarkdown(data, false, null, true, true)).toBe(
      '# Test\n\n## Claude\n\n### Thinking\n````\nreasoning\n````\n\n',
    );
  });

  it('omits the thinking block when includeThinking is false', () => {
    const data = makeConversation({
      content: [
        { thinking: 'reasoning', type: 'thinking' },
        { text: 'hello', type: 'text' },
      ],
    });
    expect(convertToMarkdown(data, false, null, true, false)).toBe(
      '# Test\n\n## Claude\n\nhello\n\n',
    );
  });

  it('renders a text block', () => {
    const data = makeConversation({ content: [{ text: 'hi', type: 'text' }] });
    expect(convertToMarkdown(data, false)).toBe(
      '# Test\n\n## Claude\n\nhi\n\n',
    );
  });

  it('strips old-format antArtifact tags out of the rendered text', () => {
    const data = makeConversation({
      content: [
        {
          text: 'before <antArtifact language="python">x</antArtifact> after',
          type: 'text',
        },
      ],
    });
    expect(convertToMarkdown(data, false, null, false)).toBe(
      '# Test\n\n## Claude\n\nbefore  after\n\n',
    );
  });

  it('falls back to message.text when content is absent', () => {
    const data = makeConversation({ sender: 'human', text: 'plain text' });
    expect(convertToMarkdown(data, false)).toBe(
      '# Test\n\n## User\n\nplain text\n\n',
    );
  });

  it('renders only the header for an empty content array', () => {
    const data = makeConversation({ content: [] });
    expect(convertToMarkdown(data, false)).toBe('# Test\n\n## Claude\n\n');
  });

  it('renders a file attachment with size and type metadata', () => {
    const data = makeConversation({
      attachments: [
        {
          extracted_content: 'body',
          file_name: 'notes.txt',
          file_size: 2048,
          file_type: 'text/plain',
        },
      ],
      content: [],
    });
    expect(convertToMarkdown(data, false)).toBe(
      '# Test\n\n## Claude\n\n' +
        '### Attachment: notes.txt _(2.0 KB, text/plain)_\n' +
        '````\nbody\n````\n\n',
    );
  });

  it('renders a file attachment with no extracted content as a bare header', () => {
    const data = makeConversation({
      attachments: [{ file_name: 'photo.png' }],
      content: [],
    });
    expect(convertToMarkdown(data, false)).toBe(
      '# Test\n\n## Claude\n\n### Attachment: photo.png\n\n',
    );
  });

  it('renders pasted content (no file_name) under the legacy label', () => {
    const data = makeConversation({
      attachments: [{ extracted_content: 'pasted body' }],
      content: [],
    });
    expect(convertToMarkdown(data, false)).toBe(
      '# Test\n\n## Claude\n\n### Pasted\n````\npasted body\n````\n\n',
    );
  });

  it('renders a code artifact in a fenced block and a document artifact bare', () => {
    const data = makeConversation({
      content: [
        {
          text:
            '<antArtifact language="python" title="Code">c</antArtifact>' +
            '<antArtifact type="text/markdown" title="Doc">d</antArtifact>',
          type: 'text',
        },
      ],
    });
    expect(convertToMarkdown(data, false)).toBe(
      '# Test\n\n## Claude\n\n' +
        '#### 📦 Artifact: Code\n**Type:** code | **Language:** python\n\n' +
        '```python\nc\n```\n\n' +
        '#### 📦 Artifact: Doc\n**Type:** document | **Language:** markdown\n\n' +
        'd\n\n',
    );
  });

  it('renders the full metadata header including link and truncated flag', () => {
    const data = makeConversation({ content: [{ text: 'hi', type: 'text' }] });
    const withTruncated = { ...data, truncated: false } as Conversation;
    const md = convertToMarkdown(withTruncated, true, 'conv-9');
    expect(md).toBe(
      '# Test\n\n' +
        `**Created:** ${new Date('2026-04-01T12:00:00Z').toLocaleString()}\n` +
        `**Updated:** ${new Date('2026-04-02T13:00:00Z').toLocaleString()}\n` +
        `**Exported:** ${new Date().toLocaleString()}\n` +
        '**Model:** claude-opus-4-5\n' +
        '**Link:** [https://claude.ai/chat/conv-9](https://claude.ai/chat/conv-9)\n' +
        '**Truncated:** false\n' +
        '\n---\n\n' +
        '## Claude\n\nhi\n\n',
    );
  });
});

describe('convertToText — exact output', () => {
  it('renders a thinking block with the last summary as its label', () => {
    const data = makeConversation({
      content: [
        {
          summaries: [{ summary: 'First' }, { summary: 'Last' }],
          thinking: 'reasoning',
          type: 'thinking',
        },
        { text: 'hello', type: 'text' },
      ],
    });
    expect(convertToText(data, false)).toBe(
      '[Thinking: Last]\nreasoning\n[End Thinking]\n\nClaude: hello',
    );
  });

  it('labels a thinking block without summaries as Thought process', () => {
    const data = makeConversation({
      content: [{ thinking: 'reasoning', type: 'thinking' }],
    });
    expect(convertToText(data, false)).toBe(
      '[Thinking: Thought process]\nreasoning\n[End Thinking]\n\nClaude:',
    );
  });

  it('omits thinking when includeThinking is false', () => {
    const data = makeConversation({
      content: [
        { thinking: 'reasoning', type: 'thinking' },
        { text: 'hello', type: 'text' },
      ],
    });
    expect(convertToText(data, false, true, false)).toBe('Claude: hello');
  });

  it('joins multiple text blocks with a single space', () => {
    const data = makeConversation({
      content: [
        { text: 'one', type: 'text' },
        { text: 'two', type: 'text' },
      ],
    });
    expect(convertToText(data, false)).toBe('Claude: one two');
  });

  it('falls back to message.text when content is absent', () => {
    const data = makeConversation({ sender: 'human', text: 'plain text' });
    expect(convertToText(data, false)).toBe('User: plain text');
  });

  it('renders an empty content array as a bare label', () => {
    const data = makeConversation({ content: [] });
    expect(convertToText(data, false)).toBe('Claude:');
  });

  it('renders artifacts after the message line', () => {
    const data = makeConversation({
      content: [
        {
          text: 'see <antArtifact language="python" title="Code">c</antArtifact>',
          type: 'text',
        },
      ],
    });
    expect(convertToText(data, false)).toBe(
      'Claude: see\n\n[Artifact: Code (python)]\nc\n[End Artifact]',
    );
  });

  it('renders attachments with extracted content as pasted content', () => {
    const data = makeConversation({
      attachments: [
        {
          extracted_content: 'body',
          file_name: 'notes.txt',
          file_size: 2048,
        },
      ],
      content: [{ text: 'hi', type: 'text' }],
    });
    expect(convertToText(data, false)).toBe(
      'Claude: hi\n\n[Pasted content (2048 bytes)]\nbody\n[End Pasted content]',
    );
  });

  it('renders the metadata header', () => {
    const data = makeConversation({ content: [{ text: 'hi', type: 'text' }] });
    expect(convertToText(data, true)).toBe(
      'Test\n' +
        `Created: ${new Date('2026-04-01T12:00:00Z').toLocaleString()}\n` +
        `Updated: ${new Date('2026-04-02T13:00:00Z').toLocaleString()}\n` +
        'Model: claude-opus-4-5\n\n' +
        '---\n\n' +
        'Claude: hi',
    );
  });
});

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
