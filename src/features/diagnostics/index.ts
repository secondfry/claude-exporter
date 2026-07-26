// ----- Error capture & diagnostics -----
// Captures unhandled errors and rejected promises into a ring buffer in
// extension-local storage. The user can later download a sanitized diagnostics
// bundle (Options page → Contact & Diagnostics) to attach to a bug report.
// Sanitization runs at capture time: any UUID-looking substring (chat / org /
// project IDs that may appear in fetch URLs or stack traces) is replaced with
// "<id>" so we never persist identifiers.

import { getManifestName, getManifestVersion, storageGet, storageSet } from '../../platform';

const CE_UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CE_ERROR_LOG_MAX = 50;

function sanitizeForDiagnostics(value: string): string {
  return value.replace(CE_UUID_REGEX, '<id>');
}

interface ErrorLogEntry {
  ts: string;
  level: 'error' | 'unhandledrejection';
  context: string | undefined;
  msg: string;
  source?: string | null;
  line?: number | null;
  col?: number | null;
  stack?: string | null;
}

interface DiagnosticsOutcome {
  success: boolean;
  message: string;
}

function isErrorLogEntry(value: unknown): value is ErrorLogEntry {
  if (value === null || typeof value !== 'object') return false;
  return 'ts' in value && typeof value.ts === 'string'
    && 'msg' in value && typeof value.msg === 'string';
}

function readErrorLog(stored: unknown): ErrorLogEntry[] {
  return Array.isArray(stored) ? stored.filter(isErrorLogEntry) : [];
}

function countEntries(value: unknown): number {
  return value !== null && typeof value === 'object' ? Object.keys(value).length : 0;
}

/** A stack or filename that may be absent; sanitized only when present. */
function sanitizeOptional(value: unknown): string | null {
  return typeof value === 'string' && value ? sanitizeForDiagnostics(value) : null;
}

interface ErrorLogStorage extends Record<string, unknown> {
  errorLog?: unknown;
}

function initErrorCapture(context?: string): void {
  // Re-entry guard: if our own push() throws, don't loop into the listener.
  let suppressed = false;

  const push = (entry: ErrorLogEntry) => {
    if (suppressed) return;
    suppressed = true;
    void (async () => {
      try {
        const stored = await storageGet<ErrorLogStorage>('local', ['errorLog']);
        const log = readErrorLog(stored.errorLog);
        log.push(entry);
        if (log.length > CE_ERROR_LOG_MAX) {
          log.splice(0, log.length - CE_ERROR_LOG_MAX);
        }
        await storageSet('local', { errorLog: log });
      } catch {
        // Diagnostics must never be the reason something fails.
      } finally {
        suppressed = false;
      }
    })();
  };

  globalThis.addEventListener('error', (event: ErrorEvent) => {
    push({
      ts: new Date().toISOString(),
      level: 'error',
      context,
      msg: sanitizeForDiagnostics(String(event.message || '')),
      source: sanitizeOptional(event.filename),
      line: event.lineno || null,
      col: event.colno || null,
      stack: sanitizeOptional(event.error instanceof Error ? event.error.stack : null),
    });
  });

  globalThis.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    const msg = reason instanceof Error
      ? reason.message
      : (reason !== undefined ? String(reason) : '(no reason)');
    push({
      ts: new Date().toISOString(),
      level: 'unhandledrejection',
      context,
      msg: sanitizeForDiagnostics(msg),
      stack: sanitizeOptional(reason instanceof Error ? reason.stack : null),
    });
  });
}

interface DiagnosticsStorage extends Record<string, unknown> {
  errorLog?: unknown;
  modelSnapshots?: unknown;
  exportTimestamps?: unknown;
  dateFormat?: unknown;
  timeFormat?: unknown;
  modelDisplay?: unknown;
}

// Build a sanitized diagnostics bundle and trigger a download.
async function generateDiagnostics(): Promise<DiagnosticsOutcome> {
  try {
    const local = await storageGet<DiagnosticsStorage>('local', [
      'errorLog', 'modelSnapshots', 'exportTimestamps', 'dateFormat', 'timeFormat', 'modelDisplay',
    ]);
    const sync = await storageGet<{ organizationId?: unknown }>('sync', ['organizationId']);
    const errorLog = readErrorLog(local.errorLog);

    const diagnostics = {
      _meta: {
        app: 'claude-exporter',
        diagnosticsVersion: 1,
        generatedAt: new Date().toISOString(),
      },
      extension: {
        name: getManifestName(),
        version: getManifestVersion(),
      },
      environment: {
        userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || null,
        language: (typeof navigator !== 'undefined' && navigator.language) || null,
      },
      preferences: {
        dateFormat: local.dateFormat || 'mdy',
        timeFormat: local.timeFormat || '12h',
        modelDisplay: local.modelDisplay === 'current' ? 'current' : 'original',
        orgIdConfigured: Boolean(sync.organizationId),
      },
      counts: {
        modelSnapshots: countEntries(local.modelSnapshots),
        exportTimestamps: countEntries(local.exportTimestamps),
        errors: errorLog.length,
      },
      errors: errorLog,
    };

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ymd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const hms = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const blob = new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `claude-exporter-diagnostics-${ymd}-${hms}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    return {
      success: true,
      message: `Diagnostics downloaded — ${errorLog.length} error(s) captured, all IDs redacted.`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Diagnostics failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export {
  CE_ERROR_LOG_MAX,
  CE_UUID_REGEX,
  generateDiagnostics,
  initErrorCapture,
  readErrorLog,
  sanitizeForDiagnostics,
};
export type { DiagnosticsOutcome, ErrorLogEntry };
