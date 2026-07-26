// The DOM-free half of the content script's export handling.
//
// index.ts registers listeners and touches `window` at module load, so nothing
// can import it from a spec. Everything here is a pure function over messages,
// conversation summaries and ExportResults — the option defaulting, the mapping
// from the conversation list to export targets, and the shaping of the response
// the popup reads. Those are the parts with real behaviour to pin (partial
// failure especially), so they live here where a spec can reach them.

import type { ConversationSummary } from '$features/conversation/types';
import type {
  ExportOptions,
  ExportResult,
  ExportTarget,
} from '$features/export/types';

import type { ExportOptionsMessage, ExportResponse } from './messages';

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

/**
 * The conversation list as the export pipeline wants it.
 *
 * `updatedAt` is carried across deliberately: it is the only evidence the Chat
 * Cache accepts that a stored copy is still current, so dropping it here would
 * silently turn every bulk export back into a full refetch.
 */
const toExportTargets = (
  conversations: ConversationSummary[],
): ExportTarget[] => {
  return conversations.map((conversation) => ({
    name: conversation.name || conversation.uuid,
    updatedAt: conversation.updated_at,
    uuid: conversation.uuid,
  }));
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

export {
  DEFAULT_EXPORT_OPTIONS,
  resolveOptions,
  toExportResponse,
  toExportTargets,
};
