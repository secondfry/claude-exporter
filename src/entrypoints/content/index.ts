// The content script is a thin relay, nothing more.
//
// It exists because only code running on a claude.ai page carries the session
// cookies the API needs. It owns no export logic: fetching lives in
// features/conversation, the export pipeline in features/export, which also
// writes Export Records (features/tracking). This file only snapshots models.
// It previously carried its own copy of the pipeline and drifted from the
// browse page's — see CLAUDE.md "Export Flow".

import { remoteCache } from '$features/cache';
import {
  detectOrgId,
  fetchConversationList,
  fetchProjects,
} from '$features/conversation/api';
import { initErrorCapture } from '$features/diagnostics';
import { exportConversations } from '$features/export/pipeline';
import type {
  ExportOptions,
  ExportResult,
  ExportTarget,
} from '$features/export/types';
import { recordModelSnapshots } from '$features/tracking';
import { onMessage } from '$platform';

import type {
  ContentRequest,
  ExportAllConversationsRequest,
  ExportConversationRequest,
  ExportOptionsMessage,
  ExportResponse,
} from './messages';

declare global {
  interface Window {
    claudeExporterContentScriptLoaded?: boolean;
  }
}

// Callers only send the controls they expose (the popup's "Export All", for
// one, has no thinking toggle), so anything absent falls back to here.
const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  artifactFormat: 'original',
  extractArtifacts: false,
  flattenArtifacts: false,
  format: 'json',
  includeArtifacts: false,
  includeChats: true,
  includeMetadata: false,
  includeThinking: false,
};

const resolveOptions = (message: ExportOptionsMessage): ExportOptions => {
  return {
    artifactFormat:
      message.artifactFormat ?? DEFAULT_EXPORT_OPTIONS.artifactFormat,
    extractArtifacts:
      message.extractArtifacts ?? DEFAULT_EXPORT_OPTIONS.extractArtifacts,
    flattenArtifacts:
      message.flattenArtifacts ?? DEFAULT_EXPORT_OPTIONS.flattenArtifacts,
    format: message.format ?? DEFAULT_EXPORT_OPTIONS.format,
    includeArtifacts:
      message.includeArtifacts ?? DEFAULT_EXPORT_OPTIONS.includeArtifacts,
    includeChats: message.includeChats ?? DEFAULT_EXPORT_OPTIONS.includeChats,
    includeMetadata:
      message.includeMetadata ?? DEFAULT_EXPORT_OPTIONS.includeMetadata,
    includeThinking:
      message.includeThinking ?? DEFAULT_EXPORT_OPTIONS.includeThinking,
  };
};

// The pipeline reports partial failures instead of throwing, so a bulk export
// can succeed for most conversations and still say what it lost.
const toExportResponse = (
  result: ExportResult,
  attempted: number,
): ExportResponse => {
  const response: ExportResponse = {
    count: result.exportedIds.length,
    filename: result.filename,
    success: true,
  };
  if (result.failedNames.length > 0) {
    response.warnings =
      `Exported ${result.exportedIds.length}/${attempted} conversations. ` +
      `Some failed: ${result.failedNames.join('; ')}`;
  }
  return response;
};

const handleExportConversation = async (
  request: ExportConversationRequest,
): Promise<ExportResponse> => {
  // No updatedAt: the popup exports whatever conversation is on screen without
  // loading the list, so there is nothing to validate a cached copy against and
  // this always refetches. It still populates the cache for later runs.
  const target: ExportTarget = {
    name: request.conversationName || request.conversationId,
    uuid: request.conversationId,
  };
  const result = await exportConversations(
    request.orgId,
    [target],
    resolveOptions(request),
    {
      cache: remoteCache,
    },
  );
  return toExportResponse(result, 1);
};

const handleExportAllConversations = async (
  request: ExportAllConversationsRequest,
): Promise<ExportResponse> => {
  const conversations = await fetchConversationList(request.orgId);
  // Capture current models before any model bounce can rewrite them.
  await recordModelSnapshots(conversations);

  const targets: ExportTarget[] = conversations.map((conv) => ({
    name: conv.name || conv.uuid,
    updatedAt: conv.updated_at,
    uuid: conv.uuid,
  }));

  const result = await exportConversations(
    request.orgId,
    targets,
    resolveOptions(request),
    {
      cache: remoteCache,
    },
  );
  return toExportResponse(result, targets.length);
};

// Returns a promise for actions it owns and undefined for everything else —
// undefined lets other listeners answer instead. onMessage keeps the message
// channel open and turns a rejection into { success: false, error }.
const route = (request: ContentRequest): Promise<unknown> | undefined => {
  switch (request?.action) {
    case 'detectOrgId':
      return detectOrgId().then((orgId) => ({ orgId, success: true }));

    case 'exportAllConversations':
      return handleExportAllConversations(request);

    case 'exportConversation':
      return handleExportConversation(request);

    case 'loadConversations':
      return fetchConversationList(request.orgId).then(
        async (conversations) => {
          await recordModelSnapshots(conversations);
          return { conversations, success: true };
        },
      );

    case 'loadProjects':
      return fetchProjects(request.orgId).then((projects) => ({
        projects,
        success: true,
      }));

    default:
      return undefined;
  }
};

// A top-level `return` is illegal in a module, so the double-injection guard
// wraps the side effects instead of skipping the rest of the file. Background
// re-injects on install/update, which can land on a tab that already has us;
// without this the page would end up with two message listeners.
const init = (): void => {
  if (window.claudeExporterContentScriptLoaded) {
    console.log(
      'Claude Exporter content script already loaded, skipping re-injection',
    );
    return;
  }
  window.claudeExporterContentScriptLoaded = true;

  initErrorCapture('content');
  onMessage(route);
};

init();

export {
  DEFAULT_EXPORT_OPTIONS,
  init,
  resolveOptions,
  route,
  toExportResponse,
};
