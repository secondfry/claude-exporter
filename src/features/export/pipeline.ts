// The single export pipeline. Historically browse/index.js and content/index.js
// each carried their own copy and drifted; this module is the only one.
//
// Hard rules it enforces (CLAUDE.md):
//   - more than one output file => always a ZIP, never several downloads
//   - exactly one target producing exactly one file => that file, no ZIP

import JSZip from 'jszip';

import { fetchConversation } from '../conversation/api';
import type { Conversation } from '../conversation/types';
import { extractArtifactFiles } from '../artifacts';
import { inferModel } from '../models';
import { convertToMarkdown, convertToText } from '../rendering';

import {
  bulkZipFilename,
  conversationFilename,
  mimeForFilename,
  sanitizeFilename,
} from './filenames';
import type {
  ExportEntry,
  ExportHooks,
  ExportOptions,
  ExportResult,
  ExportTarget,
} from './types';

/**
 * Fetch concurrency. Deliberately left at the browse page's original batches
 * of 3 with a 200ms breather — redesigning this is a separate change, see
 * docs/TODO.md.
 */
const BATCH_SIZE = 3;
const INTER_BATCH_DELAY_MS = 200;

const ZIP_OPTIONS = {
  type: 'blob',
  compression: 'DEFLATE',
  compressionOptions: { level: 6 },
} as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Export aborted', 'AbortError');
  }
}

function renderConversation(data: Conversation, uuid: string, options: ExportOptions): string {
  switch (options.format) {
    case 'markdown':
      return convertToMarkdown(
        data,
        options.includeMetadata,
        uuid,
        options.includeArtifacts,
        options.includeThinking
      );
    case 'text':
      return convertToText(
        data,
        options.includeMetadata,
        options.includeArtifacts,
        options.includeThinking
      );
    default:
      return JSON.stringify(data, null, 2);
  }
}

/**
 * Lay one fetched conversation out as ZIP-relative paths.
 *
 * `nest` distinguishes the two nested layouts: a bulk export puts each
 * conversation in its own `<name>/` folder, a single-conversation export
 * writes at the root. The flat layout (`Chats/` + `Artifacts/`) is identical
 * either way.
 */
function buildEntries(
  target: ExportTarget,
  data: Conversation,
  options: ExportOptions,
  nest: boolean
): ExportEntry[] {
  // The fetched conversation's own name wins: the popup cannot cheaply know the
  // title so it sends none, and the browse page's list may be stale.
  const displayName = data.name || target.name || target.uuid;
  const safeName = sanitizeFilename(displayName);
  const chatFilename = conversationFilename(displayName, options.format);

  const artifactFiles =
    options.extractArtifacts || options.flattenArtifacts || !options.includeChats
      ? extractArtifactFiles(data, options.artifactFormat)
      : [];

  // Chats off and nothing extractable here: this conversation contributes
  // nothing rather than an empty folder.
  if (!options.includeChats && artifactFiles.length === 0) return [];

  const entries: ExportEntry[] = [];
  const chatContent = options.includeChats
    ? renderConversation(data, target.uuid, options)
    : null;

  if (options.flattenArtifacts && !options.extractArtifacts) {
    if (chatContent !== null) {
      entries.push({ path: `Chats/${chatFilename}`, content: chatContent, isChat: true });
    }
    for (const artifact of artifactFiles) {
      entries.push({
        path: `Artifacts/${safeName}_${artifact.filename}`,
        content: artifact.content,
        isChat: false,
      });
    }
    return entries;
  }

  if (options.extractArtifacts) {
    const base = nest ? `${safeName}/` : '';
    if (chatContent !== null) {
      entries.push({ path: `${base}${chatFilename}`, content: chatContent, isChat: true });
    }
    // Artifacts only get their own subfolder when there's a transcript to sit
    // beside; otherwise they'd be alone inside a pointless directory.
    const artifactBase = chatContent !== null ? `${base}artifacts/` : base;
    for (const artifact of artifactFiles) {
      entries.push({
        path: `${artifactBase}${artifact.filename}`,
        content: artifact.content,
        isChat: false,
      });
    }
    return entries;
  }

  if (chatContent !== null) {
    entries.push({ path: chatFilename, content: chatContent, isChat: true });
  }
  return entries;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface FetchOutcome {
  entries: ExportEntry[];
  failedNames: string[];
  /**
   * Conversations that contributed at least one file to `entries`. A fetch that
   * succeeded but produced nothing (chats off, no artifacts) is NOT in here:
   * an Export Record asserts the user got a file (CONTEXT.md).
   */
  succeededIds: string[];
  /** Display name actually used per uuid, taken from the fetched conversation. */
  resolvedNames: Map<string, string>;
  firstError: unknown;
}

async function fetchAll(
  orgId: string,
  targets: ExportTarget[],
  options: ExportOptions,
  hooks: ExportHooks | undefined,
  nest: boolean
): Promise<FetchOutcome> {
  const total = targets.length;
  const collected = new Map<string, ExportEntry[]>();
  const failedNames: string[] = [];
  const resolvedNames = new Map<string, string>();
  let firstError: unknown = undefined;
  let completed = 0;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    throwIfAborted(hooks?.signal);

    const batch = targets.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (target) => {
        try {
          const data = await fetchConversation(orgId, target.uuid, hooks?.signal);
          if (!data || !Array.isArray(data.chat_messages)) {
            throw new Error(
              'Invalid conversation data structure. Please refresh the page and try again.'
            );
          }
          data.model = inferModel(data);
          collected.set(target.uuid, buildEntries(target, data, options, nest));
          resolvedNames.set(target.uuid, data.name || target.name || target.uuid);
          completed++;
        } catch (error) {
          if (firstError === undefined) firstError = error;
          failedNames.push(target.name || target.uuid);
        }
      })
    );

    hooks?.onProgress?.({
      phase: 'fetching',
      completed,
      total,
      failed: failedNames.length,
    });

    if (i + BATCH_SIZE < total) {
      throwIfAborted(hooks?.signal);
      await delay(INTER_BATCH_DELAY_MS);
    }
  }

  // Preserve the caller's ordering rather than completion order, so ZIP
  // contents are deterministic for a given selection.
  const entries: ExportEntry[] = [];
  const succeededIds: string[] = [];
  for (const target of targets) {
    const found = collected.get(target.uuid);
    if (!found || found.length === 0) continue;
    entries.push(...found);
    succeededIds.push(target.uuid);
  }

  return { entries, failedNames, succeededIds, resolvedNames, firstError };
}

/**
 * Export one or more conversations to a file the user receives immediately.
 *
 * Writes no Export Records and renders no UI: the caller records against
 * `exportedIds` and reports through `hooks.onProgress`.
 */
async function exportConversations(
  orgId: string,
  targets: ExportTarget[],
  options: ExportOptions,
  hooks?: ExportHooks
): Promise<ExportResult> {
  if (targets.length === 0) {
    throw new Error('Nothing to export. No conversations selected.');
  }

  const single = targets.length === 1;
  const { entries, failedNames, succeededIds, resolvedNames, firstError } = await fetchAll(
    orgId,
    targets,
    options,
    hooks,
    !single
  );

  // A single-conversation export has no partial success to report, so a failed
  // fetch is the whole operation failing.
  if (single && failedNames.length > 0) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }

  if (entries.length === 0) {
    throw new Error('Nothing to export. Enable "Chats" or "Artifacts nested".');
  }

  const artifactCount = entries.filter((entry) => !entry.isChat).length;

  if (single && entries.length === 1) {
    const entry = entries[0]!;
    const filename = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    downloadBlob(new Blob([entry.content], { type: mimeForFilename(filename) }), filename);
    return { exportedIds: succeededIds, failedNames, artifactCount, filename };
  }

  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(entry.path, entry.content);
  }

  const blob = await zip.generateAsync(ZIP_OPTIONS, (metadata) => {
    hooks?.onProgress?.({
      phase: 'zipping',
      completed: Math.round(metadata.percent),
      total: 100,
      failed: failedNames.length,
    });
  });

  // Cancelling during compression must not still hand the user a file. Same
  // AbortError contract the fetch loop uses; browse's isAbort() suppresses the
  // failure toast because the cancel button already showed its own.
  throwIfAborted(hooks?.signal);

  const first = targets[0]!;
  const filename = single
    ? `${sanitizeFilename(resolvedNames.get(first.uuid) || first.name || first.uuid)}.zip`
    : bulkZipFilename(options);

  downloadBlob(blob, filename);

  return { exportedIds: succeededIds, failedNames, artifactCount, filename };
}

export { buildEntries, downloadBlob, exportConversations };
