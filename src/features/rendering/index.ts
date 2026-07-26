// Renders a Conversation into the text formats an Export can write: Markdown
// and plain text. JSON needs no rendering — the pipeline writes the fetched
// Conversation as-is. Only the current branch of the message tree is rendered;
// alternative branches from edited messages are not part of an Export.

import {
  extractArtifactsFromMessage,
  isProgrammingLanguage,
} from '$features/artifacts';
import { getCurrentBranch } from '$features/conversation/branch';
import type {
  Attachment,
  ChatMessage,
  ContentBlock,
  Conversation,
} from '$features/conversation/types';

/** Artifacts in the old inline format are rendered from the artifact list, not the prose. */
const ARTIFACT_TAG = /<antArtifact[^>]*>[\s\S]*?<\/antArtifact>/g;

const stripArtifactTags = (text: string): string =>
  text.replace(ARTIFACT_TAG, '').trim();

const numberField = (
  source: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = source[key];
  return typeof value === 'number' ? value : undefined;
};

const collectArtifacts = (message: ChatMessage, includeArtifacts: boolean) => {
  if (!includeArtifacts) return [];
  const artifacts = extractArtifactsFromMessage(message);
  if (artifacts.length > 0) {
    console.log(
      '📦 Found',
      artifacts.length,
      'artifact(s) in message:',
      artifacts.map((a) => a.title),
    );
  }
  return artifacts;
};

type Artifacts = ReturnType<typeof collectArtifacts>;

// ============================================================================
// Markdown
// ============================================================================

const renderMarkdownMetadata = (
  data: Conversation,
  conversationId: string | null,
): string => {
  const lines = [
    `**Created:** ${new Date(data.created_at).toLocaleString()}\n`,
    `**Updated:** ${new Date(data.updated_at).toLocaleString()}\n`,
    `**Exported:** ${new Date().toLocaleString()}\n`,
    `**Model:** ${data.model}\n`,
  ];
  if (conversationId) {
    lines.push(
      `**Link:** [https://claude.ai/chat/${conversationId}](https://claude.ai/chat/${conversationId})\n`,
    );
  }
  if (data.truncated !== undefined) {
    lines.push(`**Truncated:** ${data.truncated}\n`);
  }
  lines.push(`\n---\n\n`);
  return lines.join('');
};

const renderMarkdownContentBlock = (
  content: ContentBlock,
  includeThinking: boolean,
): string => {
  if (content.type === 'thinking' && content.thinking && includeThinking) {
    return `### Thinking\n\`\`\`\`\n${content.thinking}\n\`\`\`\`\n\n`;
  }
  // Everything else that is not plain prose (tool_use in particular) is either
  // handled as an artifact or deliberately dropped.
  if (content.type !== 'text' || !content.text) return '';

  const textWithoutArtifacts = stripArtifactTags(content.text);
  if (!textWithoutArtifacts) return '';
  return `${textWithoutArtifacts}\n\n`;
};

const renderMarkdownBody = (
  message: ChatMessage,
  includeThinking: boolean,
): string => {
  if (message.content) {
    return message.content
      .map((content) => renderMarkdownContentBlock(content, includeThinking))
      .join('');
  }

  if (!message.text) return '';
  const textWithoutArtifacts = stripArtifactTags(message.text);
  if (!textWithoutArtifacts) return '';
  return `${textWithoutArtifacts}\n\n`;
};

const renderMarkdownAttachment = (attachment: Attachment): string => {
  if (!attachment.file_name) {
    // Pasted content (no file_name) — legacy label.
    if (!attachment.extracted_content) return '';
    return `### Pasted\n\`\`\`\`\n${attachment.extracted_content}\n\`\`\`\`\n\n`;
  }

  const meta = [];
  const fileSize = numberField(attachment, 'file_size');
  if (fileSize) meta.push(`${(fileSize / 1024).toFixed(1)} KB`);
  if (attachment.file_type) meta.push(attachment.file_type);

  const suffix = meta.length > 0 ? ` _(${meta.join(', ')})_` : '';
  const header = `### Attachment: ${attachment.file_name}${suffix}\n`;

  if (!attachment.extracted_content) return `${header}\n`;
  return `${header}\`\`\`\`\n${attachment.extracted_content}\n\`\`\`\`\n\n`;
};

const renderMarkdownArtifact = (artifact: Artifacts[number]): string => {
  const header =
    `#### 📦 Artifact: ${artifact.title}\n` +
    `**Type:** ${artifact.type} | **Language:** ${artifact.language}\n\n`;

  if (artifact.type === 'code' || isProgrammingLanguage(artifact.language)) {
    return `${header}\`\`\`${artifact.language}\n${artifact.content}\n\`\`\`\n\n`;
  }
  return `${header}${artifact.content}\n\n`;
};

const renderMarkdownMessage = (
  message: ChatMessage,
  includeMetadata: boolean,
  includeArtifacts: boolean,
  includeThinking: boolean,
): string => {
  const sender = message.sender === 'human' ? '## User' : '## Claude';
  const timestamp =
    includeMetadata && message.created_at
      ? `**${new Date(message.created_at).toISOString()}**\n`
      : '';

  // Artifacts are extracted from the whole message, then rendered after the
  // prose — so the prose walk strips their inline tags rather than repeating them.
  const artifacts = collectArtifacts(message, includeArtifacts);

  return [
    `${sender}\n`,
    timestamp,
    `\n`,
    renderMarkdownBody(message, includeThinking),
    ...(message.attachments ?? []).map(renderMarkdownAttachment),
    ...artifacts.map(renderMarkdownArtifact),
  ].join('');
};

// Convert to markdown format
const convertToMarkdown = (
  data: Conversation,
  includeMetadata: boolean,
  conversationId: string | null = null,
  includeArtifacts: boolean = true,
  includeThinking: boolean = true,
): string => {
  console.log(
    '🔧 convertToMarkdown - conversationId:',
    conversationId,
    'includeArtifacts:',
    includeArtifacts,
    'includeThinking:',
    includeThinking,
  );

  return [
    `# ${data.name || 'Untitled Conversation'}\n\n`,
    includeMetadata ? renderMarkdownMetadata(data, conversationId) : '',
    ...getCurrentBranch(data).map((message) =>
      renderMarkdownMessage(
        message,
        includeMetadata,
        includeArtifacts,
        includeThinking,
      ),
    ),
  ].join('');
};

// ============================================================================
// Plain text
// ============================================================================

const renderTextMetadata = (data: Conversation): string =>
  [
    `${data.name || 'Untitled Conversation'}\n`,
    `Created: ${new Date(data.created_at).toLocaleString()}\n`,
    `Updated: ${new Date(data.updated_at).toLocaleString()}\n`,
    `Model: ${data.model}\n\n`,
    '---\n\n',
  ].join('');

const isSummaryList = (value: unknown): value is { summary?: unknown }[] =>
  Array.isArray(value);

/** The most recent summary claude.ai attached to a thinking block. */
const thinkingSummary = (content: ContentBlock): string => {
  const summaries = content.summaries;
  if (!isSummaryList(summaries)) return 'Thought process';
  const summary = summaries.at(-1)?.summary;
  return typeof summary === 'string' ? summary : 'Thought process';
};

/** Thinking and prose interleave in the content array but render as two blocks. */
interface TextParts {
  message: string;
  thinking: string;
}

const textPartsFromContent = (
  content: ContentBlock[],
  includeThinking: boolean,
): TextParts => {
  const parts: TextParts = { message: '', thinking: '' };

  for (const block of content) {
    if (block.type === 'thinking' && block.thinking && includeThinking) {
      parts.thinking += `[Thinking: ${thinkingSummary(block)}]\n${block.thinking}\n[End Thinking]\n\n`;
      continue;
    }
    // Only prose, never tool_use.
    if (block.type !== 'text' || !block.text) continue;
    parts.message += stripArtifactTags(block.text) + ' ';
  }

  return parts;
};

const textPartsFromMessage = (
  message: ChatMessage,
  includeThinking: boolean,
): TextParts => {
  if (message.content) {
    return textPartsFromContent(message.content, includeThinking);
  }
  if (!message.text) return { message: '', thinking: '' };
  return { message: stripArtifactTags(message.text), thinking: '' };
};

const renderTextArtifact = (artifact: Artifacts[number]): string =>
  `\n[Artifact: ${artifact.title} (${artifact.language})]\n` +
  `${artifact.content}\n` +
  `[End Artifact]\n`;

const renderTextAttachment = (attachment: Attachment): string => {
  if (!attachment.extracted_content) return '';
  const fileSize = numberField(attachment, 'file_size');
  const size = fileSize ? ` (${fileSize} bytes)` : '';
  return (
    `\n[Pasted content${size}]\n` +
    `${attachment.extracted_content}\n` +
    `[End Pasted content]\n`
  );
};

const renderTextMessage = (
  message: ChatMessage,
  includeArtifacts: boolean,
  includeThinking: boolean,
): string => {
  const artifacts = includeArtifacts
    ? extractArtifactsFromMessage(message)
    : [];
  const parts = textPartsFromMessage(message, includeThinking);
  const senderLabel = message.sender === 'human' ? 'User' : 'Claude';

  return [
    parts.thinking,
    `${senderLabel}: ${parts.message.trim()}\n`,
    ...artifacts.map(renderTextArtifact),
    ...(message.attachments ?? []).map(renderTextAttachment),
    `\n`,
  ].join('');
};

// Convert to plain text
const convertToText = (
  data: Conversation,
  includeMetadata: boolean,
  includeArtifacts: boolean = true,
  includeThinking: boolean = true,
): string =>
  [
    includeMetadata ? renderTextMetadata(data) : '',
    ...getCurrentBranch(data).map((message) =>
      renderTextMessage(message, includeArtifacts, includeThinking),
    ),
  ]
    .join('')
    .trim();

export { convertToMarkdown, convertToText };
