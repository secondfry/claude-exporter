// The message protocol between the popup / browse page and the content script.
//
// The content script is the only code that runs on a claude.ai page, so every
// request that needs claude.ai's session cookies is relayed through it. These
// five action strings are load-bearing: they are the wire format, and changing
// one breaks an already-installed popup talking to a freshly-updated content
// script (and vice versa) until the browser reloads the page.
//
// Export options travel FLAT on the message rather than nested under an
// `options` key — that is the historical shape, and every key here matches
// ExportOptions exactly. They are optional because callers only send the
// controls they expose; the content script fills the rest from
// DEFAULT_EXPORT_OPTIONS.

import type { ConversationSummary } from '../../features/conversation/types';
import type { Project } from '../../features/conversation/api';
import type { ExportOptions } from '../../features/export/types';

/** Export options as they appear on the wire: flat, and all optional. */
type ExportOptionsMessage = Partial<ExportOptions>;

interface DetectOrgIdRequest {
  action: 'detectOrgId';
}

interface ExportConversationRequest extends ExportOptionsMessage {
  action: 'exportConversation';
  orgId: string;
  conversationId: string;
  /** Display name, when the caller knows it. Falls back to the UUID. */
  conversationName?: string;
}

interface ExportAllConversationsRequest extends ExportOptionsMessage {
  action: 'exportAllConversations';
  orgId: string;
}

interface LoadConversationsRequest {
  action: 'loadConversations';
  orgId: string;
}

interface LoadProjectsRequest {
  action: 'loadProjects';
  orgId: string;
}

type ContentRequest =
  | DetectOrgIdRequest
  | ExportConversationRequest
  | ExportAllConversationsRequest
  | LoadConversationsRequest
  | LoadProjectsRequest;

type ContentAction = ContentRequest['action'];

/** Every handler either succeeds with its payload, or fails with a message. */
interface FailureResponse {
  success: false;
  error: string;
}

interface DetectOrgIdResponse {
  success: true;
  orgId: string;
}

interface ExportResponse {
  success: true;
  /** Conversations that produced output and got an Export Record. */
  count: number;
  filename: string;
  warnings?: string;
}

interface LoadConversationsResponse {
  success: true;
  conversations: ConversationSummary[];
}

interface LoadProjectsResponse {
  success: true;
  projects: Project[];
}

/** Maps each request to the success payload its handler resolves with. */
interface ContentResponseMap {
  detectOrgId: DetectOrgIdResponse;
  exportConversation: ExportResponse;
  exportAllConversations: ExportResponse;
  loadConversations: LoadConversationsResponse;
  loadProjects: LoadProjectsResponse;
}

/** What a caller actually receives back: the success payload, or a failure. */
type ContentResponse<A extends ContentAction = ContentAction> =
  | ContentResponseMap[A]
  | FailureResponse;

// The background script's own protocol. Kept here because the popup imports
// both from one place; background has no other message surface.
interface EnsureContentScriptRequest {
  action: 'ensureContentScript';
}

interface EnsureContentScriptResponse {
  success: boolean;
  error?: string;
}

export type {
  ContentAction,
  ContentRequest,
  ContentResponse,
  ContentResponseMap,
  DetectOrgIdRequest,
  DetectOrgIdResponse,
  EnsureContentScriptRequest,
  EnsureContentScriptResponse,
  ExportAllConversationsRequest,
  ExportConversationRequest,
  ExportOptionsMessage,
  ExportResponse,
  FailureResponse,
  LoadConversationsRequest,
  LoadConversationsResponse,
  LoadProjectsRequest,
  LoadProjectsResponse,
};
