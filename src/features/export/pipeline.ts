// The single export pipeline. Historically browse/index.js and content/index.js
// each carried their own copy and drifted; this module is the only one.
//
// Hard rules it enforces (CLAUDE.md):
//   - more than one output file => always a ZIP, never several downloads
//   - exactly one target producing exactly one file => that file, no ZIP

import JSZip from 'jszip';

import type { ArtifactFile } from '$features/artifacts';
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
 * Everything the three layout builders need, computed once.
 *
 * `nest` distinguishes the two nested layouts: a bulk export puts each
 * conversation in its own `<name>/` folder, a single-conversation export
 * writes at the root. The flat layout (`Chats/` + `Artifacts/`) is identical
 * either way.
 */
interface Layout {
  artifactFiles: ArtifactFile[];
  chatContent: string | null;
  chatFilename: string;
  nest: boolean;
  safeName: string;
}

/** `Chats/` + `Artifacts/`, one pair of folders for the whole export. */
const flatEntries = ({
  artifactFiles,
  chatContent,
  chatFilename,
  safeName,
}: Layout): ExportEntry[] => {
  const chat =
    chatContent === null
      ? []
      : [{ content: chatContent, isChat: true, path: `Chats/${chatFilename}` }];
  return chat.concat(
    artifactFiles.map((artifact) => ({
      content: artifact.content,
      isChat: false,
      path: `Artifacts/${safeName}_${artifact.filename}`,
    })),
  );
};

/** Transcript beside its own artifacts, optionally inside a per-chat folder. */
const nestedEntries = ({
  artifactFiles,
  chatContent,
  chatFilename,
  nest,
  safeName,
}: Layout): ExportEntry[] => {
  const base = nest ? `${safeName}/` : '';
  const chat =
    chatContent === null
      ? []
      : [
          {
            content: chatContent,
            isChat: true,
            path: `${base}${chatFilename}`,
          },
        ];
  // Artifacts only get their own subfolder when there's a transcript to sit
  // beside; otherwise they'd be alone inside a pointless directory.
  const artifactBase = chatContent === null ? base : `${base}artifacts/`;
  return chat.concat(
    artifactFiles.map((artifact) => ({
      content: artifact.content,
      isChat: false,
      path: `${artifactBase}${artifact.filename}`,
    })),
  );
};

/** Transcripts only, at the root. */
const chatOnlyEntries = ({
  chatContent,
  chatFilename,
}: Layout): ExportEntry[] => {
  if (chatContent === null) return [];
  return [{ content: chatContent, isChat: true, path: chatFilename }];
};

const artifactsFor = (
  data: Conversation,
  options: ExportOptions,
): ArtifactFile[] => {
  const wanted =
    options.extractArtifacts ||
    options.flattenArtifacts ||
    !options.includeChats;
  if (!wanted) return [];
  return extractArtifactFiles(data, options.artifactFormat);
};

/** Lay one fetched conversation out as ZIP-relative paths. */
const buildEntries = (
  target: ExportTarget,
  data: Conversation,
  options: ExportOptions,
  nest: boolean,
): ExportEntry[] => {
  // The fetched conversation's own name wins: the popup cannot cheaply know the
  // title so it sends none, and the browse page's list may be stale.
  const displayName = data.name || target.name || target.uuid;
  const artifactFiles = artifactsFor(data, options);

  // Chats off and nothing extractable here: this conversation contributes
  // nothing rather than an empty folder.
  if (!options.includeChats && artifactFiles.length === 0) return [];

  const layout: Layout = {
    artifactFiles,
    chatContent: options.includeChats
      ? renderConversation(data, target.uuid, options)
      : null,
    chatFilename: conversationFilename(displayName, options.format),
    nest,
    safeName: sanitizeFilename(displayName),
  };

  if (options.flattenArtifacts && !options.extractArtifacts) {
    return flatEntries(layout);
  }
  if (options.extractArtifacts) return nestedEntries(layout);
  return chatOnlyEntries(layout);
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

const isConversation = (value: unknown): value is Conversation => {
  if (typeof value !== 'object' || value === null) return false;
  return Array.isArray(Reflect.get(value, 'chat_messages'));
};

/** Fetch one conversation over the network, rejecting anything unusable. */
const fetchValidConversation = async (
  orgId: string,
  target: ExportTarget,
  signal: AbortSignal | undefined,
): Promise<Conversation> => {
  const data = await fetchConversation(orgId, target.uuid, signal);
  if (!isConversation(data)) {
    throw new Error(
      'Invalid conversation data structure. Please refresh the page and try again.',
    );
  }
  return data;
};

interface LoadedConversation {
  cached: boolean;
  data: Conversation;
  quota: boolean;
}

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
): Promise<LoadedConversation> => {
  const cache = hooks?.cache;

  const hit = cache ? await cache.read(target.uuid, target.updatedAt) : null;
  if (hit) return { cached: true, data: hit, quota: false };

  const data = await fetchValidConversation(orgId, target, hooks?.signal);

  const status = cache ? await cache.write(data) : 'unavailable';
  return { cached: false, data, quota: status === 'quota' };
};

/**
 * What the load told us about the Chat Cache, kept apart from whether the
 * target went on to render. Null means the load itself threw, so it learned
 * nothing — a distinction the run-level totals depend on: a conversation that
 * was fetched and cached still counts as fetched and cached even if rendering
 * it failed a moment later.
 */
interface LoadRecord {
  cached: boolean;
  quota: boolean;
}

/**
 * What one target turned into. Collecting these and reducing once at the end
 * is what keeps the batch loop free of shared mutable counters — the shape
 * that used to make partial-failure accounting hard to follow.
 */
interface TargetSucceeded {
  entries: ExportEntry[];
  load: LoadRecord;
  ok: true;
  resolvedName: string;
  uuid: string;
}

interface TargetFailed {
  error: unknown;
  failedName: string;
  /** Null when the load is what failed; set when rendering failed after it. */
  load: LoadRecord | null;
  ok: false;
}

type TargetOutcome = TargetFailed | TargetSucceeded;

const succeeded = (outcome: TargetOutcome): outcome is TargetSucceeded => {
  return outcome.ok;
};

const failed = (outcome: TargetOutcome): outcome is TargetFailed => {
  return !outcome.ok;
};

type LoadAttempt =
  | { data: Conversation; load: LoadRecord; ok: true }
  | { error: unknown; ok: false };

/** Never rejects. Owns the only try around the fetch/cache half of a target. */
const attemptLoad = async (
  orgId: string,
  target: ExportTarget,
  hooks: ExportHooks | undefined,
): Promise<LoadAttempt> => {
  try {
    const { cached, data, quota } = await loadConversation(
      orgId,
      target,
      hooks,
    );
    return { data, load: { cached, quota }, ok: true };
  } catch (error) {
    return { error, ok: false };
  }
};

/**
 * Never rejects: a failure is a value, so one bad target cannot sink a batch.
 *
 * Loading and rendering are attempted separately so a rendering failure still
 * reports what the load learned. Folding both into one try lost it, and what
 * was lost was the cache-full warning — the export would fail one conversation
 * and silently stop telling the user their disk was full.
 */
const runTarget = async (
  orgId: string,
  target: ExportTarget,
  options: ExportOptions,
  hooks: ExportHooks | undefined,
  nest: boolean,
): Promise<TargetOutcome> => {
  const failedName = target.name || target.uuid;

  const attempt = await attemptLoad(orgId, target, hooks);
  if (!attempt.ok) {
    return { error: attempt.error, failedName, load: null, ok: false };
  }

  const { data, load } = attempt;
  try {
    data.model = inferModel(data);
    return {
      entries: buildEntries(target, data, options, nest),
      load,
      ok: true,
      resolvedName: data.name || target.name || target.uuid,
      uuid: target.uuid,
    };
  } catch (error) {
    return { error, failedName, load, ok: false };
  }
};

/**
 * The delay exists to keep claude.ai from rate-limiting us. A batch served
 * entirely from the cache asked claude.ai for nothing, so pausing after it
 * would only make a fully-cached re-export slower than it needs to be.
 */
const pauseBetweenBatches = async (
  batch: TargetOutcome[],
  more: boolean,
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (!more) return;
  if (!batch.some((outcome) => outcome.load && !outcome.load.cached)) return;
  throwIfAborted(signal);
  await delay(INTER_BATCH_DELAY_MS);
};

const reportFetchProgress = (
  outcomes: TargetOutcome[],
  total: number,
  hooks: ExportHooks | undefined,
): void => {
  const done = outcomes.filter(succeeded);
  hooks?.onProgress?.({
    completed: done.length,
    failed: outcomes.length - done.length,
    fromCache: outcomes.filter((outcome) => outcome.load?.cached).length,
    phase: 'fetching',
    total,
  });
};

interface FetchOutcome {
  /**
   * Conversations answered from the cache, so never requested over the
   * network. Counted at load time: a conversation that came from the cache
   * and then failed to render still did not touch the network.
   */
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

/**
 * Reduce the per-target outcomes to the whole run's answer.
 *
 * `outcomes` are already in the caller's order — batches run in sequence and
 * `Promise.all` preserves input order — so ZIP contents are deterministic for a
 * given selection rather than depending on which fetch finished first.
 */
const summarise = (outcomes: TargetOutcome[]): FetchOutcome => {
  const done = outcomes.filter(succeeded);
  const contributing = done.filter((outcome) => outcome.entries.length > 0);

  return {
    cacheHits: outcomes.filter((outcome) => outcome.load?.cached).length,
    cacheQuotaExceeded: outcomes.some((outcome) => outcome.load?.quota),
    entries: contributing.flatMap((outcome) => outcome.entries),
    failedNames: outcomes.filter(failed).map((outcome) => outcome.failedName),
    firstError: outcomes.filter(failed)[0]?.error,
    resolvedNames: new Map(
      done.map((outcome) => [outcome.uuid, outcome.resolvedName]),
    ),
    succeededIds: contributing.map((outcome) => outcome.uuid),
  };
};

const fetchAll = async (
  orgId: string,
  targets: ExportTarget[],
  options: ExportOptions,
  hooks: ExportHooks | undefined,
  nest: boolean,
): Promise<FetchOutcome> => {
  const total = targets.length;
  const outcomes: TargetOutcome[] = [];

  for (let i = 0; i < total; i += BATCH_SIZE) {
    throwIfAborted(hooks?.signal);

    const batch = await Promise.all(
      targets
        .slice(i, i + BATCH_SIZE)
        .map((target) => runTarget(orgId, target, options, hooks, nest)),
    );
    outcomes.push(...batch);

    reportFetchProgress(outcomes, total, hooks);
    await pauseBetweenBatches(batch, i + BATCH_SIZE < total, hooks?.signal);
  }

  return summarise(outcomes);
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
 * Write the Export Records, reporting whether it worked instead of throwing.
 *
 * The user already has the file by the time this runs, so a storage failure is
 * information, not a reason to fail the export.
 */
const writeRecords = async (succeededIds: string[]): Promise<boolean> => {
  if (succeededIds.length === 0) return true;
  try {
    await recordExports(succeededIds);
    return true;
  } catch (error) {
    console.warn(
      new Error('Failed to write Export Records for a successful export', {
        cause: error,
      }),
    );
    return false;
  }
};

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

  return {
    artifactCount,
    cacheQuotaExceeded,
    exportedIds: succeededIds,
    failedNames,
    filename,
    fromCache: cacheHits,
    recordsWritten: await writeRecords(succeededIds),
  };
};

const asError = (value: unknown): Error => {
  if (value instanceof Error) return value;
  return new Error(String(value));
};

/** The one-entry case: the file itself, no ZIP wrapper (CLAUDE.md). */
const asLoneFile = (entry: ExportEntry): { blob: Blob; filename: string } => {
  const filename = entry.path.slice(entry.path.lastIndexOf('/') + 1);
  return {
    blob: new Blob([entry.content], { type: mimeForFilename(filename) }),
    filename,
  };
};

const zipEntries = async (
  entries: ExportEntry[],
  failed: number,
  hooks: ExportHooks | undefined,
): Promise<Blob> => {
  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(entry.path, entry.content);
  }

  return zip.generateAsync(ZIP_OPTIONS, (metadata) => {
    hooks?.onProgress?.({
      completed: Math.round(metadata.percent),
      failed,
      phase: 'zipping',
      total: 100,
    });
  });
};

const zipFilename = (
  targets: ExportTarget[],
  options: ExportOptions,
  resolvedNames: Map<string, string>,
  single: boolean,
): string => {
  if (!single) return bulkZipFilename(options);
  const first = targets[0];
  const name = resolvedNames.get(first.uuid) || first.name || first.uuid;
  return `${sanitizeFilename(name)}.zip`;
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
  const fetched = await fetchAll(orgId, targets, options, hooks, !single);
  const { entries, failedNames } = fetched;

  // A single-conversation export has no partial success to report, so a failed
  // fetch is the whole operation failing.
  if (single && failedNames.length > 0) throw asError(fetched.firstError);

  if (entries.length === 0) {
    throw new Error('Nothing to export. Enable "Chats" or "Artifacts nested".');
  }

  const common = {
    artifactCount: entries.filter((entry) => !entry.isChat).length,
    cacheHits: fetched.cacheHits,
    cacheQuotaExceeded: fetched.cacheQuotaExceeded,
    failedNames,
    succeededIds: fetched.succeededIds,
  };

  if (single && entries.length === 1) {
    return finish({ ...common, ...asLoneFile(entries[0]) });
  }

  const blob = await zipEntries(entries, failedNames.length, hooks);

  // Cancelling during compression must not still hand the user a file. Same
  // AbortError contract the fetch loop uses; browse's isAbort() suppresses the
  // failure toast because the cancel button already showed its own.
  throwIfAborted(hooks?.signal);

  return finish({
    ...common,
    blob,
    filename: zipFilename(targets, options, fetched.resolvedNames, single),
  });
};

export { buildEntries, downloadBlob, exportConversations };
