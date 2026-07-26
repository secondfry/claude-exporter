// ----- Error capture & diagnostics -----
// Captures unhandled errors and rejected promises into a ring buffer in
// extension-local storage. The user can later download a sanitized diagnostics
// bundle (Options page → Contact & Diagnostics) to attach to a bug report.
// Sanitization runs at capture time: any UUID-looking substring (chat / org /
// project IDs that may appear in fetch URLs or stack traces) is replaced with
// "<id>" so we never persist identifiers.

import {
  getManifestName,
  getManifestVersion,
  storageGet,
  storageSet,
} from '$platform';

const CE_UUID_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CE_ERROR_LOG_MAX = 50;

const sanitizeForDiagnostics = (value: string): string => {
  return value.replace(CE_UUID_REGEX, '<id>');
};

interface ErrorLogEntry {
  col?: number | null;
  context: string | undefined;
  level: 'error' | 'unhandledrejection';
  line?: number | null;
  msg: string;
  source?: string | null;
  stack?: string | null;
  ts: string;
}

interface DiagnosticsOutcome {
  message: string;
  success: boolean;
}

const isErrorLogEntry = (value: unknown): value is ErrorLogEntry => {
  if (value === null || typeof value !== 'object') return false;
  return (
    'ts' in value &&
    typeof value.ts === 'string' &&
    'msg' in value &&
    typeof value.msg === 'string'
  );
};

const readErrorLog = (stored: unknown): ErrorLogEntry[] => {
  return Array.isArray(stored) ? stored.filter(isErrorLogEntry) : [];
};

const countEntries = (value: unknown): number => {
  return value !== null && typeof value === 'object'
    ? Object.keys(value).length
    : 0;
};

/** A stack or filename that may be absent; sanitized only when present. */
const sanitizeOptional = (value: unknown): string | null => {
  return typeof value === 'string' && value
    ? sanitizeForDiagnostics(value)
    : null;
};

interface ErrorLogStorage extends Record<string, unknown> {
  errorLog?: unknown;
}

/** Appends one entry to the ring buffer, trimming the oldest past the cap. */
const appendErrorLogEntry = async (entry: ErrorLogEntry): Promise<void> => {
  const stored = await storageGet<ErrorLogStorage>('local', ['errorLog']);
  const log = readErrorLog(stored.errorLog);
  log.push(entry);
  if (log.length > CE_ERROR_LOG_MAX) {
    log.splice(0, log.length - CE_ERROR_LOG_MAX);
  }
  await storageSet('local', { errorLog: log });
};

const toErrorEntry = (
  event: ErrorEvent,
  context: string | undefined,
): ErrorLogEntry => {
  return {
    col: event.colno || null,
    context,
    level: 'error',
    line: event.lineno || null,
    msg: sanitizeForDiagnostics(String(event.message || '')),
    source: sanitizeOptional(event.filename),
    stack: sanitizeOptional(
      event.error instanceof Error ? event.error.stack : null,
    ),
    ts: new Date().toISOString(),
  };
};

const rejectionMessage = (reason: unknown): string => {
  if (reason instanceof Error) return reason.message;
  if (reason === undefined) return '(no reason)';
  return String(reason);
};

const toRejectionEntry = (
  event: PromiseRejectionEvent,
  context: string | undefined,
): ErrorLogEntry => {
  const reason: unknown = event.reason;
  return {
    context,
    level: 'unhandledrejection',
    msg: sanitizeForDiagnostics(rejectionMessage(reason)),
    stack: sanitizeOptional(reason instanceof Error ? reason.stack : null),
    ts: new Date().toISOString(),
  };
};

const initErrorCapture = (context?: string): void => {
  // Not an incidental accumulator — this is re-entrancy protection, and it has
  // to be mutable closure state because the window it protects spans an async
  // storage round-trip. If appending throws, the throw would surface as an
  // 'error' event or an unhandled rejection, re-entering the very listener
  // that raised it and looping without bound. Set before the write starts,
  // cleared once it settles either way.
  let suppressed = false;

  const push = (entry: ErrorLogEntry): void => {
    if (suppressed) return;
    suppressed = true;
    void appendErrorLogEntry(entry)
      .catch(() => {
        // Swallowed on purpose: diagnostics must never be the reason something
        // fails. It cannot report its own failure either — rethrowing becomes
        // an unhandled rejection that fires the listener below, and logging it
        // would put noise into the console of the very page we are observing,
        // in the one situation (storage unavailable) where nothing could be
        // persisted to explain it anyway. So no `cause` is chained here: there
        // is nowhere for it to go.
      })
      .finally(() => {
        suppressed = false;
      });
  };

  globalThis.addEventListener('error', (event: ErrorEvent) => {
    push(toErrorEntry(event, context));
  });

  globalThis.addEventListener(
    'unhandledrejection',
    (event: PromiseRejectionEvent) => {
      push(toRejectionEntry(event, context));
    },
  );
};

interface DiagnosticsStorage extends Record<string, unknown> {
  dateFormat?: unknown;
  errorLog?: unknown;
  exportTimestamps?: unknown;
  modelDisplay?: unknown;
  modelSnapshots?: unknown;
  timeFormat?: unknown;
}

// Build a sanitized diagnostics bundle and trigger a download.
const generateDiagnostics = async (): Promise<DiagnosticsOutcome> => {
  try {
    const local = await storageGet<DiagnosticsStorage>('local', [
      'errorLog',
      'modelSnapshots',
      'exportTimestamps',
      'dateFormat',
      'timeFormat',
      'modelDisplay',
    ]);
    const sync = await storageGet<{ organizationId?: unknown }>('sync', [
      'organizationId',
    ]);
    const errorLog = readErrorLog(local.errorLog);

    const diagnostics = {
      _meta: {
        app: 'claude-exporter',
        diagnosticsVersion: 1,
        generatedAt: new Date().toISOString(),
      },
      counts: {
        errors: errorLog.length,
        exportTimestamps: countEntries(local.exportTimestamps),
        modelSnapshots: countEntries(local.modelSnapshots),
      },
      environment: {
        language:
          (typeof navigator !== 'undefined' && navigator.language) || null,
        userAgent:
          (typeof navigator !== 'undefined' && navigator.userAgent) || null,
      },
      errors: errorLog,
      extension: {
        name: getManifestName(),
        version: getManifestVersion(),
      },
      preferences: {
        dateFormat: local.dateFormat || 'mdy',
        modelDisplay: local.modelDisplay === 'current' ? 'current' : 'original',
        orgIdConfigured: Boolean(sync.organizationId),
        timeFormat: local.timeFormat || '12h',
      },
    };

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ymd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const hms = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const blob = new Blob([JSON.stringify(diagnostics, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `claude-exporter-diagnostics-${ymd}-${hms}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    return {
      message: `Diagnostics downloaded — ${errorLog.length} error(s) captured, all IDs redacted.`,
      success: true,
    };
  } catch (error) {
    return {
      message: `Diagnostics failed: ${error instanceof Error ? error.message : String(error)}`,
      success: false,
    };
  }
};

export {
  CE_ERROR_LOG_MAX,
  CE_UUID_REGEX,
  generateDiagnostics,
  initErrorCapture,
  readErrorLog,
  sanitizeForDiagnostics,
};
export type { DiagnosticsOutcome, ErrorLogEntry };
