// The contract the export pipeline is coded against. Both callers (popup via
// the content script, and the browse page) go through exportConversations —
// see CLAUDE.md "Export Flow". Nothing here touches chrome.storage or the DOM
// beyond the download itself; Export Records are the caller's job.

import type { ArtifactFormat, ExportFormat } from '../conversation/types';

interface ExportOptions {
  format: ExportFormat;
  includeChats: boolean;
  includeThinking: boolean;
  includeMetadata: boolean;
  includeArtifacts: boolean;
  extractArtifacts: boolean;
  artifactFormat: ArtifactFormat;
  flattenArtifacts: boolean;
}

/** A conversation the user asked to export, as known before fetching it. */
interface ExportTarget {
  uuid: string;
  name: string;
}

interface ExportProgress {
  phase: 'fetching' | 'zipping';
  completed: number;
  total: number;
  failed: number;
}

interface ExportResult {
  /** Conversations the caller should write an Export Record for. */
  exportedIds: string[];
  failedNames: string[];
  artifactCount: number;
  /** The name of the file actually handed to the browser. */
  filename: string;
}

interface ExportHooks {
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
}

/** One file destined for the export, at its path inside the ZIP. */
interface ExportEntry {
  path: string;
  content: string;
  /** True for the conversation transcript, false for an extracted artifact. */
  isChat: boolean;
}

export type {
  ExportEntry,
  ExportFormat,
  ExportHooks,
  ExportOptions,
  ExportProgress,
  ExportResult,
  ExportTarget,
};
