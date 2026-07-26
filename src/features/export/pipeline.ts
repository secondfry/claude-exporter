// The single export pipeline. Historically browse/index.js and content/index.js
// each carried their own copy and drifted; this module is the only one.
//
// Hard rules it enforces (CLAUDE.md):
//   - more than one output file => always a ZIP, never several downloads
//   - exactly one target producing exactly one file => that file, no ZIP

import JSZip from 'jszip';

import { extractArtifactFiles } from '$features/artifacts';
import { fetchConversation } from '$features/conversation/api';
import type { Conversation } from '$features/conversation/types';
import { inferModel } from '$features/models';
import { convertToMarkdown, convertToText } from '$features/rendering';
// Direct import, deliberately not an injected hook: an optional hook is one a
// caller will eventually omit, and this codebase has already had the two
// export callers diverge once over this exact call (CLAUDE.md). The content
// script may call this directly — chrome.storage.local is extension-scoped,
// not origin-partitioned, unlike the Chat Cache, which needs the background
// relay (ADR-0003).
import { recordExports } from '$features/tracking';

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
  compression: 'DEFLATE',
  compressionOptions: { level: 6 },
  type: 'blob',
} as const;

const delay = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw new DOMException('Export aborted', 'AbortError');
  }
};

const renderConversation = (
  data: Conversation,
  uuid: string,
  options: ExportOptions,
): string => {
  switch (options.format) {
    case 'markdown':
      return convertToMarkdown(
        data,
        options.includeMetadata,
        uuid,
        options.includeArtifacts,
        options.includeThinking,
      );
    case 'text':
      return convertToText(
        data,
        options.includeMetadata,
        options.includeArtifacts,
        options.includeThinking,
      );
    default:
      return JSON.stringify(data, null, 2);
  }
};

/**
 * Lay one fetched conversation out as ZIP-relative paths.
 *
 * `nest` distinguishes the two nested layouts: a bulk export puts each
 * conversation in its own `<name>/` folder, a single-conversation export
 * writes at the root. The flat layout (`Chats/` + `Artifacts/`) is identical
 * either way.
 */
const buildEntries = (
  target: ExportTarget,
  data: Conversation,
  options: ExportOptions,
  nest: boolean,
): ExportEntry[] => {
  // The fetched conversation's own name wins: the popup cannot cheaply know the
  // title so it sends none, and the browse page's list may be stale.
  const displayName = data.name || target.name || target.uuid;
  const safeName = sanitizeFilename(displayName);
  const chatFilename = conversationFilename(displayName, options.format);

  const artifactFiles =
    options.extractArtifacts ||
    options.flattenArtifacts ||
    !options.includeChats
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
      entries.push({
        content: chatContent,
        isChat: true,
        path: `Chats/${chatFilename}`,
      });
    }
    for (const artifact of artifactFiles) {
      entries.push({
        content: artifact.content,
        isChat: false,
        path: `Artifacts/${safeName}_${artifact.filename}`,
      });
    }
    return entries;
  }

  if (options.extractArtifacts) {
    const base = nest ? `${safeName}/` : '';
    if (chatContent !== null) {
      entries.push({
        content: chatContent,
        isChat: true,
        path: `${base}${chatFilename}`,
      });
    }
    // Artifacts only get their own subfolder when there's a transcript to sit
    // beside; otherwise they'd be alone inside a pointless directory.
    const artifactBase = chatContent !== null ? `${base}artifacts/` : base;
    for (const artifact of artifactFiles) {
      entries.push({
        content: artifact.content,
        isChat: false,
        path: `${artifactBase}${artifact.filename}`,
      });
    }
    return entries;
  }

  if (chatContent !== null) {
    entries.push({ content: chatContent, isChat: true, path: chatFilename });
  }
  return entries;
};

const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

/**
 * Obtain one conversation, preferring the Chat Cache.
 *
 * The write happens immediately after the fetch and before conversion, so
 * cancelling an export interrupts it rather than destroying everything it
 * fetched (ADR-0002). It stores the response untouched — `inferModel` runs
 * afterwards, on the caller's copy, so the cache keeps raw API JSON.
 */
const loadConversation = async (
  orgId: string,
  target: ExportTarget,
  hooks: ExportHooks | undefined,
): Promise<{ cached: boolean; data: Conversation; quota: boolean }> => {
  const cache = hooks?.cache;

  const hit = cache ? await cache.read(target.uuid, target.updatedAt) : null;
  if (hit) return { cached: true, data: hit, quota: false };

  const data = await fetchConversation(orgId, target.uuid, hooks?.signal);
  if (!data || !Array.isArray(data.chat_messages)) {
    throw new Error(
      'Invalid conversation data structure. Please refresh the page and try again.',
    );
  }

  const status = cache ? await cache.write(data) : 'unavailable';
  return { cached: false, data, quota: status === 'quota' };
};

interface FetchOutcome {
  /** Conversations answered from the cache, so never requested over the network. */
  cacheHits: number;
  cacheQuotaExceeded: boolean;
  entries: ExportEntry[];
  failedNames: string[];
  firstError: unknown;
  /** Display name actually used per uuid, taken from the fetched conversation. */
  resolvedNames: Map<string, string>;
  /**
   * Conversations that contributed at least one file to `entries`. A fetch that
   * succeeded but produced nothing (chats off, no artifacts) is NOT in here:
   * an Export Record asserts the user got a file (CONTEXT.md).
   */
  succeededIds: string[];
}

const fetchAll = async (
  orgId: string,
  targets: ExportTarget[],
  options: ExportOptions,
  hooks: ExportHooks | undefined,
  nest: boolean,
): Promise<FetchOutcome> => {
  const total = targets.length;
  const collected = new Map<string, ExportEntry[]>();
  const failedNames: string[] = [];
  const resolvedNames = new Map<string, string>();
  let firstError: unknown = undefined;
  let completed = 0;
  let cacheHits = 0;
  let cacheQuotaExceeded = false;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    throwIfAborted(hooks?.signal);

    const batch = targets.slice(i, i + BATCH_SIZE);
    let hitNetwork = false;

    await Promise.all(
      batch.map(async (target) => {
        try {
          const { cached, data, quota } = await loadConversation(
            orgId,
            target,
            hooks,
          );
          if (cached) cacheHits++;
          else hitNetwork = true;
          if (quota) cacheQuotaExceeded = true;

          data.model = inferModel(data);
          collected.set(target.uuid, buildEntries(target, data, options, nest));
          resolvedNames.set(
            target.uuid,
            data.name || target.name || target.uuid,
          );
          completed++;
        } catch (error) {
          if (firstError === undefined) firstError = error;
          failedNames.push(target.name || target.uuid);
        }
      }),
    );

    hooks?.onProgress?.({
      completed,
      failed: failedNames.length,
      fromCache: cacheHits,
      phase: 'fetching',
      total,
    });

    // The delay exists to keep claude.ai from rate-limiting us. A batch served
    // entirely from the cache asked claude.ai for nothing, so pausing after it
    // would only make a fully-cached re-export slower than it needs to be.
    if (hitNetwork && i + BATCH_SIZE < total) {
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

  return {
    cacheHits,
    cacheQuotaExceeded,
    entries,
    failedNames,
    firstError,
    resolvedNames,
    succeededIds,
  };
};

interface FinishArgs {
  artifactCount: number;
  blob: Blob;
  cacheHits: number;
  cacheQuotaExceeded: boolean;
  failedNames: string[];
  filename: string;
  succeededIds: string[];
}

/**
 * Download the file and write its Export Records, then build the result.
 *
 * The single shared tail for both success paths (one file, or a ZIP): one
 * place that downloads, one place that records, one place that shapes
 * `ExportResult`. Records are written after the download — an Export Record
 * asserts the user got a file (CONTEXT.md) — and only for `succeededIds`,
 * never when it is empty. A record-write failure never fails the export: the
 * user already has the file, so it is caught, warned, and reported via
 * `recordsWritten` instead of rejecting.
 */
const finish = async ({
  artifactCount,
  blob,
  cacheHits,
  cacheQuotaExceeded,
  failedNames,
  filename,
  succeededIds,
}: FinishArgs): Promise<ExportResult> => {
  downloadBlob(blob, filename);

  let recordsWritten = true;
  if (succeededIds.length > 0) {
    try {
      await recordExports(succeededIds);
    } catch (error) {
      recordsWritten = false;
      console.warn(
        'Failed to write Export Records for a successful export:',
        error,
      );
    }
  }

  return {
    artifactCount,
    cacheQuotaExceeded,
    exportedIds: succeededIds,
    failedNames,
    filename,
    fromCache: cacheHits,
    recordsWritten,
  };
};

/**
 * Export one or more conversations to a file the user receives immediately.
 *
 * Writes an Export Record for every conversation it succeeds on (CONTEXT.md)
 * and renders no UI: the caller reports through `hooks.onProgress`.
 */
const exportConversations = async (
  orgId: string,
  targets: ExportTarget[],
  options: ExportOptions,
  hooks?: ExportHooks,
): Promise<ExportResult> => {
  if (targets.length === 0) {
    throw new Error('Nothing to export. No conversations selected.');
  }

  const single = targets.length === 1;
  const {
    cacheHits,
    cacheQuotaExceeded,
    entries,
    failedNames,
    firstError,
    resolvedNames,
    succeededIds,
  } = await fetchAll(orgId, targets, options, hooks, !single);

  // A single-conversation export has no partial success to report, so a failed
  // fetch is the whole operation failing.
  if (single && failedNames.length > 0) {
    throw firstError instanceof Error
      ? firstError
      : new Error(String(firstError));
  }

  if (entries.length === 0) {
    throw new Error('Nothing to export. Enable "Chats" or "Artifacts nested".');
  }

  const artifactCount = entries.filter((entry) => !entry.isChat).length;

  if (single && entries.length === 1) {
    const entry = entries[0];
    const filename = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    return finish({
      artifactCount,
      blob: new Blob([entry.content], { type: mimeForFilename(filename) }),
      cacheHits,
      cacheQuotaExceeded,
      failedNames,
      filename,
      succeededIds,
    });
  }

  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(entry.path, entry.content);
  }

  const blob = await zip.generateAsync(ZIP_OPTIONS, (metadata) => {
    hooks?.onProgress?.({
      completed: Math.round(metadata.percent),
      failed: failedNames.length,
      phase: 'zipping',
      total: 100,
    });
  });

  // Cancelling during compression must not still hand the user a file. Same
  // AbortError contract the fetch loop uses; browse's isAbort() suppresses the
  // failure toast because the cancel button already showed its own.
  throwIfAborted(hooks?.signal);

  const first = targets[0];
  const filename = single
    ? `${sanitizeFilename(resolvedNames.get(first.uuid) || first.name || first.uuid)}.zip`
    : bulkZipFilename(options);

  return finish({
    artifactCount,
    blob,
    cacheHits,
    cacheQuotaExceeded,
    failedNames,
    filename,
    succeededIds,
  });
};

export { buildEntries, downloadBlob, exportConversations };
