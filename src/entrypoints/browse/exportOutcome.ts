// What the user is told after an Export finishes.
//
// An ExportResult carries five independent facts — how many Conversations got
// a file, how many failed, how many were Cache Hits, whether the Chat Cache
// filled up, and whether Export Records could be written — and the page has to
// turn them into an ordered sequence of toasts. That mapping was buried in the
// middle of a DOM-heavy arrow with no coverage at all, even though it is the
// only part of an Export most users ever see. Here it is a pure function of
// the result.

import type { ExportProgress, ExportResult } from '$features/export/types';

interface Toast {
  isError: boolean;
  message: string;
}

const QUOTA_MESSAGE =
  'Local storage is full, so conversations are no longer being cached.';
const RECORDS_MESSAGE =
  'Export succeeded, but could not be recorded as exported.';

/** "Exported: X" plus the artifact count, when there is one. */
const successMessage = (name: string, artifactCount: number): string => {
  return artifactCount > 0
    ? `Exported: ${name} with ${artifactCount} artifact(s)`
    : `Exported: ${name}`;
};

const bulkMessage = (result: ExportResult, total: number): string => {
  const failed = result.failedNames.length;
  const completed = result.exportedIds.length;
  if (failed > 0) {
    return `Exported ${completed} of ${total} conversations (${failed} failed).`;
  }
  const cached =
    result.fromCache > 0 ? ` (${result.fromCache} from cache)` : '';
  return `Successfully exported all ${completed} conversations!${cached}`;
};

/**
 * The per-row Export button. Deliberately says nothing about the Chat Cache
 * quota: one Conversation is not the run that will feel the refetch.
 */
const singleExportToasts = (result: ExportResult, name: string): Toast[] => {
  const toasts: Toast[] = [
    { isError: false, message: successMessage(name, result.artifactCount) },
  ];
  if (!result.recordsWritten) {
    toasts.push({ isError: true, message: RECORDS_MESSAGE });
  }
  return toasts;
};

/**
 * "Export All" / "Export Selected (N)". Order is the contract: the file the
 * user asked for is unaffected by either warning, so the success message goes
 * first and the caveats follow it.
 */
const bulkExportToasts = (result: ExportResult, names: string[]): Toast[] => {
  const headline =
    names.length === 1
      ? successMessage(names[0], result.artifactCount)
      : bulkMessage(result, names.length);

  const toasts: Toast[] = [{ isError: false, message: headline }];
  if (result.cacheQuotaExceeded) {
    toasts.push({ isError: true, message: QUOTA_MESSAGE });
  }
  if (!result.recordsWritten) {
    toasts.push({ isError: true, message: RECORDS_MESSAGE });
  }
  return toasts;
};

interface ProgressDisplay {
  /** The bar's CSS width. */
  barWidth: string;
  /** null means "leave what is already there". */
  stats: string | null;
  text: string | null;
}

/**
 * What the progress modal should read for a given ExportProgress. Zipping has
 * no per-Conversation counts to report, so it drives the bar from its own
 * percentage and leaves the previous stats line alone rather than blanking it.
 */
const progressDisplay = (progress: ExportProgress): ProgressDisplay => {
  if (progress.phase === 'zipping') {
    return {
      barWidth: `${progress.completed}%`,
      stats: null,
      text: 'Creating ZIP file...',
    };
  }
  const done = progress.completed + progress.failed;
  const percent =
    progress.total > 0 ? Math.round((done / progress.total) * 100) : 0;
  return {
    barWidth: `${percent}%`,
    stats: `${progress.completed} succeeded, ${progress.failed} failed out of ${progress.total}`,
    text: null,
  };
};

export { bulkExportToasts, progressDisplay, singleExportToasts };
export type { ProgressDisplay, Toast };
