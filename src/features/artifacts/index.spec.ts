import { describe, expect, it } from 'vitest';

import type { ChatMessage, Conversation } from '$features/conversation/types';

import {
  extractArtifactFiles,
  extractArtifactsFromMessage,
  getFileExtension,
  isProgrammingLanguage,
} from './index';

// Regression coverage for the bug fixed in v1.9.1: bash/web_search/repl
// tool_use entries used to slip through as fake artifacts. Now gated on
// `tool_use.name === 'artifacts'`.
describe('extractArtifactsFromMessage — tool name filter', () => {
  it('rejects a bash tool_use even with code_block display content', () => {
    const message = {
      content: [
        {
          display_content: {
            code: 'ls -la',
            filename: 'cmd.sh',
            language: 'bash',
            type: 'code_block',
          },
          name: 'bash',
          type: 'tool_use',
        },
      ],
    } as unknown as ChatMessage;
    expect(extractArtifactsFromMessage(message)).toEqual([]);
  });

  it('rejects a web_search tool_use', () => {
    const message = {
      content: [
        {
          display_content: {
            code: 'results...',
            language: 'json',
            type: 'code_block',
          },
          name: 'web_search',
          type: 'tool_use',
        },
      ],
    } as unknown as ChatMessage;
    expect(extractArtifactsFromMessage(message)).toEqual([]);
  });

  it('extracts an artifacts tool_use with code_block format', () => {
    const message = {
      content: [
        {
          display_content: {
            code: 'def hello():\n    pass',
            filename: 'hello.py',
            language: 'python',
            type: 'code_block',
          },
          name: 'artifacts',
          type: 'tool_use',
        },
      ],
    } as unknown as ChatMessage;
    const artifacts = extractArtifactsFromMessage(message);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].title).toBe('hello');
    expect(artifacts[0].language).toBe('python');
    expect(artifacts[0].content).toBe('def hello():\n    pass');
  });

  it('extracts an artifacts tool_use with json_block format when filename is present', () => {
    const message = {
      content: [
        {
          display_content: {
            json_block: JSON.stringify({
              code: 'console.log("hi");',
              filename: 'app.js',
              language: 'javascript',
            }),
            type: 'json_block',
          },
          name: 'artifacts',
          type: 'tool_use',
        },
      ],
    } as unknown as ChatMessage;
    const artifacts = extractArtifactsFromMessage(message);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].title).toBe('app');
  });

  it('rejects a json_block artifacts entry that has no filename', () => {
    const message = {
      content: [
        {
          display_content: {
            json_block: JSON.stringify({
              code: 'echo hi',
            }),
            type: 'json_block',
          },
          name: 'artifacts',
          type: 'tool_use',
        },
      ],
    } as unknown as ChatMessage;
    expect(extractArtifactsFromMessage(message)).toEqual([]);
  });

  // Regression: when `enabled_artifacts_attachments` is false in conversation
  // settings, Claude uses the skills-runner `create_file` MCP tool instead of
  // the legacy `artifacts` tool. display_content shape is identical
  // (json_block with language / code / filename). The extractor must allowlist
  // both tool names.
  it('extracts a create_file tool_use (skills-runner replacement for artifacts)', () => {
    const message = {
      content: [
        {
          display_content: {
            json_block: JSON.stringify({
              code: '# Hello, world!\n',
              filename: '/mnt/user-data/outputs/hello.md',
              language: 'markdown',
            }),
            type: 'json_block',
          },
          input: {
            file_text: '# Hello, world!\n',
            path: '/mnt/user-data/outputs/hello.md',
          },
          name: 'create_file',
          type: 'tool_use',
        },
      ],
    } as unknown as ChatMessage;
    const artifacts = extractArtifactsFromMessage(message);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].title).toBe('hello');
    expect(artifacts[0].language).toBe('markdown');
    expect(artifacts[0].content).toBe('# Hello, world!');
  });

  it('still rejects other skills tools that share json_block display (e.g. view, list_directory)', () => {
    const message = {
      content: [
        {
          display_content: {
            json_block: JSON.stringify({
              code: 'directory listing here',
              filename: '/mnt/skills/public',
              language: 'text',
            }),
            type: 'json_block',
          },
          name: 'view',
          type: 'tool_use',
        },
      ],
    } as unknown as ChatMessage;
    expect(extractArtifactsFromMessage(message)).toEqual([]);
  });
});

describe('extractArtifactFiles — end-to-end', () => {
  function makeConversationWithMessages(messages: ChatMessage[]): Conversation {
    const last = messages[messages.length - 1];
    return {
      chat_messages: messages,
      created_at: '2024-01-01T00:00:00Z',
      current_leaf_message_uuid: last.uuid,
      name: 'Test',
      updated_at: '2024-01-01T00:00:00Z',
      uuid: 'conv-1',
    };
  }

  it('returns artifact files only from real artifact tool calls', () => {
    const data = makeConversationWithMessages([
      {
        content: [{ text: 'make me something', type: 'text' }],
        parent_message_uuid: '00000000-0000-0000-0000-000000000000',
        sender: 'human',
        uuid: 'm1',
      },
      {
        content: [
          {
            display_content: {
              code: '<h1>hi</h1>',
              filename: 'page.html',
              language: 'html',
              type: 'code_block',
            },
            name: 'artifacts',
            type: 'tool_use',
          },
          {
            display_content: {
              code: 'ls',
              filename: 'noise.sh',
              language: 'bash',
              type: 'code_block',
            },
            name: 'bash',
            type: 'tool_use',
          },
        ],
        parent_message_uuid: 'm1',
        sender: 'assistant',
        uuid: 'm2',
      },
    ]);
    const files = extractArtifactFiles(data);
    expect(files).toHaveLength(1);
    expect(files[0].filename).toMatch(/\.html$/);
  });

  it('deduplicates duplicate filenames with a counter suffix', () => {
    const data = makeConversationWithMessages([
      {
        content: [
          {
            display_content: {
              code: 'a',
              filename: 'app.js',
              language: 'javascript',
              type: 'code_block',
            },
            name: 'artifacts',
            type: 'tool_use',
          },
          {
            display_content: {
              code: 'b',
              filename: 'app.js',
              language: 'javascript',
              type: 'code_block',
            },
            name: 'artifacts',
            type: 'tool_use',
          },
        ],
        parent_message_uuid: '00000000-0000-0000-0000-000000000000',
        sender: 'assistant',
        uuid: 'm1',
      },
    ]);
    const files = extractArtifactFiles(data);
    expect(files).toHaveLength(2);
    const names = files.map((f) => f.filename);
    expect(new Set(names).size).toBe(2); // both unique
  });
});

describe('getFileExtension', () => {
  it('maps common programming languages correctly', () => {
    expect(getFileExtension('javascript')).toBe('.js');
    expect(getFileExtension('python')).toBe('.py');
    expect(getFileExtension('bash')).toBe('.sh');
  });

  it('falls back to .txt for unknown languages', () => {
    expect(getFileExtension('totally-not-a-language')).toBe('.txt');
  });
});

describe('isProgrammingLanguage', () => {
  it('recognizes common programming languages', () => {
    expect(isProgrammingLanguage('javascript')).toBe(true);
    expect(isProgrammingLanguage('python')).toBe(true);
    expect(isProgrammingLanguage('rust')).toBe(true);
  });

  it('rejects markup/document formats', () => {
    expect(isProgrammingLanguage('markdown')).toBe(false);
  });
});
