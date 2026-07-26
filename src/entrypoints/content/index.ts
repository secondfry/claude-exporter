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
import type { ExportTarget } from '$features/export/types';
import { recordModelSnapshots } from '$features/tracking';
import { onMessage } from '$platform';

import { resolveOptions, toExportResponse, toExportTargets } from './export';
import type {
  ContentRequest,
  ExportAllConversationsRequest,
  ExportConversationRequest,
  ExportResponse,
} from './messages';

declare global {
  interface Window {
    claudeExporterContentScriptLoaded?: boolean;
  }
}

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

  const targets = toExportTargets(conversations);

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

export { init, route };
