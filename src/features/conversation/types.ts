// Shapes returned by the claude.ai conversation API. These are deliberately
// permissive: the API is undocumented and adds fields without notice, so every
// interface carries an index signature and unknown fields survive round-tripping
// into the Chat Cache untouched.

type MessageSender = 'human' | 'assistant';

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: ContentBlock[] | string;
  [key: string]: unknown;
}

interface Attachment {
  file_name?: string;
  file_type?: string;
  extracted_content?: string;
  [key: string]: unknown;
}

interface ChatMessage {
  uuid: string;
  parent_message_uuid?: string | null;
  sender: MessageSender;
  text?: string;
  content?: ContentBlock[];
  attachments?: Attachment[];
  created_at?: string;
  [key: string]: unknown;
}

/** A conversation as returned by the detail endpoint (`?tree=True&...`). */
interface Conversation {
  uuid: string;
  name: string;
  model?: string | null;
  created_at: string;
  updated_at: string;
  truncated?: boolean;
  chat_messages?: ChatMessage[];
  current_leaf_message_uuid?: string | null;
  [key: string]: unknown;
}

/**
 * A conversation as returned by the list endpoint — no messages. This is the
 * shape the browse table renders and, critically, the source of the
 * `updated_at` that decides Chat Cache validity.
 */
interface ConversationSummary {
  uuid: string;
  name: string;
  model?: string | null;
  created_at: string;
  updated_at: string;
  project_uuid?: string | null;
  project_id?: string | null;
  [key: string]: unknown;
}

export type {
  Attachment,
  ChatMessage,
  ContentBlock,
  Conversation,
  ConversationSummary,
  MessageSender,
};
