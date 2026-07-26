import { describe, it, expect } from 'vitest';

import {
  extractArtifactsFromMessage,
  extractArtifactFiles,
  getFileExtension,
  isProgrammingLanguage,
} from './index';

import type { ChatMessage, Conversation } from '../conversation/types';

// Regression coverage for the bug fixed in v1.9.1: bash/web_search/repl
// tool_use entries used to slip through as fake artifacts. Now gated on
// `tool_use.name === 'artifacts'`.
describe('extractArtifactsFromMessage — tool name filter', () => {
  it('rejects a bash tool_use even with code_block display content', () => {
    const message = {
      content: [
        {
          type: 'tool_use',
          name: 'bash',
          display_content: {
            type: 'code_block',
            code: 'ls -la',
            language: 'bash',
            filename: 'cmd.sh',
          },
        },
      ],
    } as unknown as ChatMessage;
    expect(extractArtifactsFromMessage(message)).toEqual([]);
  });

  it('rejects a web_search tool_use', () => {
    const message = {
      content: [
        {
          type: 'tool_use',
          name: 'web_search',
          display_content: {
            type: 'code_block',
            code: 'results...',
            language: 'json',
          },
        },
      ],
    } as unknown as ChatMessage;
    expect(extractArtifactsFromMessage(message)).toEqual([]);
  });

  it('extracts an artifacts tool_use with code_block format', () => {
    const message = {
      content: [
        {
          type: 'tool_use',
          name: 'artifacts',
          display_content: {
            type: 'code_block',
            code: 'def hello():\n    pass',
            language: 'python',
            filename: 'hello.py',
          },
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
          type: 'tool_use',
          name: 'artifacts',
          display_content: {
            type: 'json_block',
            json_block: JSON.stringify({
              filename: 'app.js',
              language: 'javascript',
              code: 'console.log("hi");',
            }),
          },
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
          type: 'tool_use',
          name: 'artifacts',
          display_content: {
            type: 'json_block',
            json_block: JSON.stringify({
              code: 'echo hi',
            }),
          },
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
          type: 'tool_use',
          name: 'create_file',
          input: {
            path: '/mnt/user-data/outputs/hello.md',
            file_text: '# Hello, world!\n',
          },
          display_content: {
            type: 'json_block',
            json_block: JSON.stringify({
              language: 'markdown',
              code: '# Hello, world!\n',
              filename: '/mnt/user-data/outputs/hello.md',
            }),
          },
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
          type: 'tool_use',
          name: 'view',
          display_content: {
            type: 'json_block',
            json_block: JSON.stringify({
              language: 'text',
              code: 'directory listing here',
              filename: '/mnt/skills/public',
            }),
          },
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
      uuid: 'conv-1',
      name: 'Test',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      current_leaf_message_uuid: last.uuid,
      chat_messages: messages,
    };
  }

  it('returns artifact files only from real artifact tool calls', () => {
    const data = makeConversationWithMessages([
      {
        uuid: 'm1',
        sender: 'human',
        content: [{ type: 'text', text: 'make me something' }],
        parent_message_uuid: '00000000-0000-0000-0000-000000000000',
      },
      {
        uuid: 'm2',
        sender: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'artifacts',
            display_content: {
              type: 'code_block',
              code: '<h1>hi</h1>',
              language: 'html',
              filename: 'page.html',
            },
          },
          {
            type: 'tool_use',
            name: 'bash',
            display_content: {
              type: 'code_block',
              code: 'ls',
              language: 'bash',
              filename: 'noise.sh',
            },
          },
        ],
        parent_message_uuid: 'm1',
      },
    ]);
    const files = extractArtifactFiles(data);
    expect(files).toHaveLength(1);
    expect(files[0].filename).toMatch(/\.html$/);
  });

  it('deduplicates duplicate filenames with a counter suffix', () => {
    const data = makeConversationWithMessages([
      {
        uuid: 'm1',
        sender: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'artifacts',
            display_content: {
              type: 'code_block',
              code: 'a',
              language: 'javascript',
              filename: 'app.js',
            },
          },
          {
            type: 'tool_use',
            name: 'artifacts',
            display_content: {
              type: 'code_block',
              code: 'b',
              language: 'javascript',
              filename: 'app.js',
            },
          },
        ],
        parent_message_uuid: '00000000-0000-0000-0000-000000000000',
      },
    ]);
    const files = extractArtifactFiles(data);
    expect(files).toHaveLength(2);
    const names = files.map(f => f.filename);
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
