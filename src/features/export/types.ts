// The contract the export pipeline is coded against. Both callers (popup via
// the content script, and the browse page) go through exportConversations —
// see CLAUDE.md "Export Flow". The pipeline writes its own Export Records
// after the download (CONTEXT.md: "An Export writes an Export Record for
// every Conversation it succeeds on") — callers do not need to call
// recordExports themselves.

import type { ArtifactFormat } from '$features/artifacts';
import type { CachePort } from '$features/cache/messages';

/** Output format for an exported conversation. */
type ExportFormat = 'json' | 'markdown' | 'text';

interface ExportOptions {
  artifactFormat: ArtifactFormat;
  extractArtifacts: boolean;
  flattenArtifacts: boolean;
  format: ExportFormat;
  includeArtifacts: boolean;
  includeChats: boolean;
  includeMetadata: boolean;
  includeThinking: boolean;
}

/** A conversation the user asked to export, as known before fetching it. */
interface ExportTarget {
  name: string;
  /**
   * `updated_at` from the conversation list. The Chat Cache may only be read
   * for targets that carry one — it is the sole evidence that a stored copy is
   * still current. Callers that never loaded the list (the popup exporting the
   * open conversation) omit it and always refetch.
   */
  updatedAt?: string;
  uuid: string;
}

interface ExportProgress {
  completed: number;
  failed: number;
  /** How many of `completed` came from the Chat Cache. */
  fromCache?: number;
  phase: 'fetching' | 'zipping';
  total: number;
}

interface ExportResult {
  artifactCount: number;
  /** The cache filled up mid-run. The export itself still succeeded. */
  cacheQuotaExceeded: boolean;
  /** Conversations an Export Record was written for (a receipt, not a to-do). */
  exportedIds: string[];
  failedNames: string[];
  /** The name of the file actually handed to the browser. */
  filename: string;
  /** Conversations served from the Chat Cache instead of the network. */
  fromCache: number;
  /**
   * False when the Export succeeded but its Export Records could not be
   * stored — the user has the file, so this never causes a rejection, but a
   * caller may want to surface it.
   */
  recordsWritten: boolean;
}

interface ExportHooks {
  /**
   * Where to look before fetching, and where to store what was fetched. The
   * caller supplies it because which implementation is correct depends on the
   * context: extension pages reach IndexedDB directly, the content script must
   * relay to the background worker. Omitting it disables the cache entirely.
   */
  cache?: CachePort;
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
}

/** One file destined for the export, at its path inside the ZIP. */
interface ExportEntry {
  content: string;
  /** True for the conversation transcript, false for an extracted artifact. */
  isChat: boolean;
  path: string;
}

export type {
  ArtifactFormat,
  CachePort,
  ExportEntry,
  ExportFormat,
  ExportHooks,
  ExportOptions,
  ExportProgress,
  ExportResult,
  ExportTarget,
};
