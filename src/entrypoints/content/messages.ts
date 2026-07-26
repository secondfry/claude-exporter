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

import type { Project } from '$features/conversation/api';
import type { ConversationSummary } from '$features/conversation/types';
import type { ExportOptions } from '$features/export/types';

/** Export options as they appear on the wire: flat, and all optional. */
type ExportOptionsMessage = Partial<ExportOptions>;

interface DetectOrgIdRequest {
  action: 'detectOrgId';
}

interface ExportConversationRequest extends ExportOptionsMessage {
  action: 'exportConversation';
  conversationId: string;
  /** Display name, when the caller knows it. Falls back to the UUID. */
  conversationName?: string;
  orgId: string;
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
  | ExportAllConversationsRequest
  | ExportConversationRequest
  | LoadConversationsRequest
  | LoadProjectsRequest;

type ContentAction = ContentRequest['action'];

/** Every handler either succeeds with its payload, or fails with a message. */
interface FailureResponse {
  error: string;
  success: false;
}

interface DetectOrgIdResponse {
  orgId: string;
  success: true;
}

interface ExportResponse {
  /** Conversations that produced output and got an Export Record. */
  count: number;
  filename: string;
  success: true;
  warnings?: string;
}

interface LoadConversationsResponse {
  conversations: ConversationSummary[];
  success: true;
}

interface LoadProjectsResponse {
  projects: Project[];
  success: true;
}

/** Maps each request to the success payload its handler resolves with. */
interface ContentResponseMap {
  detectOrgId: DetectOrgIdResponse;
  exportAllConversations: ExportResponse;
  exportConversation: ExportResponse;
  loadConversations: LoadConversationsResponse;
  loadProjects: LoadProjectsResponse;
}

/** What a caller actually receives back: the success payload, or a failure. */
type ContentResponse<A extends ContentAction = ContentAction> =
  ContentResponseMap[A] | FailureResponse;

// The background script's own protocol. Kept here because the popup imports
// both from one place; background has no other message surface.
interface EnsureContentScriptRequest {
  action: 'ensureContentScript';
}

interface EnsureContentScriptResponse {
  error?: string;
  success: boolean;
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
