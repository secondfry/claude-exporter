// Renders a Conversation into the text formats an Export can write: Markdown
// and plain text. JSON needs no rendering — the pipeline writes the fetched
// Conversation as-is. Only the current branch of the message tree is rendered;
// alternative branches from edited messages are not part of an Export.

import { getCurrentBranch } from '../conversation/branch';
import type { Conversation } from '../conversation/types';
import { extractArtifactsFromMessage, isProgrammingLanguage } from '../artifacts';

// Convert to markdown format
function convertToMarkdown(
  data: Conversation,
  includeMetadata: boolean,
  conversationId: string | null = null,
  includeArtifacts: boolean = true,
  includeThinking: boolean = true
): string {
  console.log('🔧 convertToMarkdown - conversationId:', conversationId, 'includeArtifacts:', includeArtifacts, 'includeThinking:', includeThinking);
  let markdown = `# ${data.name || 'Untitled Conversation'}\n\n`;

  if (includeMetadata) {
    markdown += `**Created:** ${new Date(data.created_at).toLocaleString()}\n`;
    markdown += `**Updated:** ${new Date(data.updated_at).toLocaleString()}\n`;
    markdown += `**Exported:** ${new Date().toLocaleString()}\n`;
    markdown += `**Model:** ${data.model}\n`;
    if (conversationId) {
      markdown += `**Link:** [https://claude.ai/chat/${conversationId}](https://claude.ai/chat/${conversationId})\n`;
    }
    if (data.truncated !== undefined) {
      markdown += `**Truncated:** ${data.truncated}\n`;
    }
    markdown += `\n---\n\n`;
  }

  // Get only the current branch messages
  const branchMessages = getCurrentBranch(data);

  for (const message of branchMessages) {
    const sender = message.sender === 'human' ? '## User' : '## Claude';
    markdown += `${sender}\n`;

    if (includeMetadata && message.created_at) {
      markdown += `**${new Date(message.created_at).toISOString()}**\n`;
    }
    markdown += `\n`;

    // Extract artifacts from the entire message (handles both old and new formats)
    const messageArtifacts = includeArtifacts ? extractArtifactsFromMessage(message) : [];
    if (messageArtifacts.length > 0) {
      console.log('📦 Found', messageArtifacts.length, 'artifact(s) in message:', messageArtifacts.map(a => a.title));
    }

    // Render message text (excluding tool_use and artifact tags)
    if (message.content) {
      for (const content of message.content) {
        // Handle thinking blocks (extended thinking)
        if (content.type === 'thinking' && content.thinking && includeThinking) {
          markdown += `### Thinking\n\`\`\`\`\n${content.thinking}\n\`\`\`\`\n\n`;
        }
        // Handle regular text content (skip tool_use, we handle artifacts separately)
        else if (content.type === 'text' && content.text) {
          // Remove old-format artifact tags from text
          let textWithoutArtifacts = content.text.replace(/<antArtifact[^>]*>[\s\S]*?<\/antArtifact>/g, '').trim();
          if (textWithoutArtifacts) {
            markdown += `${textWithoutArtifacts}\n\n`;
          }
        }
      }
    } else if (message.text) {
      // Handle old format - remove artifact tags from text
      let textWithoutArtifacts = message.text.replace(/<antArtifact[^>]*>[\s\S]*?<\/antArtifact>/g, '').trim();
      if (textWithoutArtifacts) {
        markdown += `${textWithoutArtifacts}\n\n`;
      }
    }

    // Handle attachments (file uploads and pasted content)
    if (message.attachments && message.attachments.length > 0) {
      for (const attachment of message.attachments) {
        if (attachment.file_name) {
          // File attachment — show file metadata + extracted content if present
          let header = `### Attachment: ${attachment.file_name}`;
          const meta = [];
          const fileSize = attachment.file_size as number | undefined;
          if (fileSize) {
            meta.push(`${(fileSize / 1024).toFixed(1)} KB`);
          }
          if (attachment.file_type) {
            meta.push(attachment.file_type);
          }
          if (meta.length > 0) {
            header += ` _(${meta.join(', ')})_`;
          }
          markdown += `${header}\n`;
          if (attachment.extracted_content) {
            markdown += `\`\`\`\`\n${attachment.extracted_content}\n\`\`\`\`\n\n`;
          } else {
            markdown += `\n`;
          }
        } else if (attachment.extracted_content) {
          // Pasted content (no file_name) — legacy label
          markdown += `### Pasted\n\`\`\`\`\n${attachment.extracted_content}\n\`\`\`\`\n\n`;
        }
      }
    }

    // Render all artifacts found in the message
    for (const artifact of messageArtifacts) {
      markdown += `#### 📦 Artifact: ${artifact.title}\n`;
      markdown += `**Type:** ${artifact.type} | **Language:** ${artifact.language}\n\n`;

      if (artifact.type === 'code' || isProgrammingLanguage(artifact.language)) {
        markdown += `\`\`\`${artifact.language}\n${artifact.content}\n\`\`\`\n\n`;
      } else {
        markdown += `${artifact.content}\n\n`;
      }
    }
  }

  return markdown;
}

// Convert to plain text
function convertToText(
  data: Conversation,
  includeMetadata: boolean,
  includeArtifacts: boolean = true,
  includeThinking: boolean = true
): string {
  let text = '';

  // Add metadata header if requested
  if (includeMetadata) {
    text += `${data.name || 'Untitled Conversation'}\n`;
    text += `Created: ${new Date(data.created_at).toLocaleString()}\n`;
    text += `Updated: ${new Date(data.updated_at).toLocaleString()}\n`;
    text += `Model: ${data.model}\n\n`;
    text += '---\n\n';
  }

  // Get only the current branch messages
  const branchMessages = getCurrentBranch(data);

  branchMessages.forEach((message) => {
    // Extract artifacts from the entire message (handles both old and new formats)
    const artifacts = includeArtifacts ? extractArtifactsFromMessage(message) : [];

    // Get the message text (excluding artifacts)
    let messageText = '';
    let thinkingText = '';
    if (message.content) {
      for (const content of message.content) {
        // Handle thinking blocks
        if (content.type === 'thinking' && content.thinking && includeThinking) {
          const summaries = content.summaries as { summary: string }[] | undefined;
          const summary = summaries && summaries.length > 0
            ? summaries[summaries.length - 1].summary
            : 'Thought process';
          thinkingText += `[Thinking: ${summary}]\n${content.thinking}\n[End Thinking]\n\n`;
        }
        // Only include text content, skip tool_use
        else if (content.type === 'text' && content.text) {
          // Remove old-format artifact tags
          messageText += content.text.replace(/<antArtifact[^>]*>[\s\S]*?<\/antArtifact>/g, '').trim() + ' ';
        }
      }
    } else if (message.text) {
      // Handle old format - remove artifact tags
      messageText = message.text.replace(/<antArtifact[^>]*>[\s\S]*?<\/antArtifact>/g, '').trim();
    }

    messageText = messageText.trim();

    // Use full label for all messages
    let senderLabel;
    if (message.sender === 'human') {
      senderLabel = 'User';
    } else {
      senderLabel = 'Claude';
    }

    // Add thinking text if present
    if (thinkingText) {
      text += thinkingText;
    }

    text += `${senderLabel}: ${messageText}\n`;

    // Add artifacts if present
    if (artifacts.length > 0) {
      for (const artifact of artifacts) {
        text += `\n[Artifact: ${artifact.title} (${artifact.language})]\n`;
        text += `${artifact.content}\n`;
        text += `[End Artifact]\n`;
      }
    }

    // Add pasted content if present
    if (message.attachments && message.attachments.length > 0) {
      for (const attachment of message.attachments) {
        if (attachment.extracted_content) {
          const fileSize = attachment.file_size as number | undefined;
          const size = fileSize ? ` (${fileSize} bytes)` : '';
          text += `\n[Pasted content${size}]\n`;
          text += `${attachment.extracted_content}\n`;
          text += `[End Pasted content]\n`;
        }
      }
    }

    text += `\n`;
  });

  return text.trim();
}

export { convertToMarkdown, convertToText };
