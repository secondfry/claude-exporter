// Shapes returned by the claude.ai conversation API. These are deliberately
// permissive: the API is undocumented and adds fields without notice, so every
// interface carries an index signature and unknown fields survive round-tripping
// into the Chat Cache untouched.

type MessageSender = 'assistant' | 'human';

interface ContentBlock {
  content?: ContentBlock[] | string;
  input?: Record<string, unknown>;
  name?: string;
  text?: string;
  thinking?: string;
  type: string;
  [key: string]: unknown;
}

interface Attachment {
  extracted_content?: string;
  file_name?: string;
  file_type?: string;
  [key: string]: unknown;
}

interface ChatMessage {
  attachments?: Attachment[];
  content?: ContentBlock[];
  created_at?: string;
  parent_message_uuid?: string | null;
  sender: MessageSender;
  text?: string;
  uuid: string;
  [key: string]: unknown;
}

/** A conversation as returned by the detail endpoint (`?tree=True&...`). */
interface Conversation {
  chat_messages?: ChatMessage[];
  created_at: string;
  current_leaf_message_uuid?: string | null;
  model?: string | null;
  name: string;
  truncated?: boolean;
  updated_at: string;
  uuid: string;
  [key: string]: unknown;
}

/**
 * A conversation as returned by the list endpoint — no messages. This is the
 * shape the browse table renders and, critically, the source of the
 * `updated_at` that decides Chat Cache validity.
 */
interface ConversationSummary {
  created_at: string;
  model?: string | null;
  name: string;
  project_id?: string | null;
  project_uuid?: string | null;
  updated_at: string;
  uuid: string;
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
