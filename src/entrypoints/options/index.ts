// The options page: listener wiring only.
//
// Every decision it makes lives in ./settings (DOM-free, spec'd) and every
// element read goes through ./dom (instanceof-guarded). What is left here is
// the wiring itself, which no spec can reach because the test environment has
// no DOM.

import {
  backupExtensionData,
  importBackup,
  showImportModeModal,
} from '$features/backup';
import type { ImportMode } from '$features/backup';
import { cacheStats, clearCache } from '$features/cache';
import { fetchConversationList } from '$features/conversation/api';
import { generateDiagnostics, initErrorCapture } from '$features/diagnostics';
import {
  getManifestVersion,
  hasClaudeAccess,
  requestClaudeAccess,
  storageGet,
  storageSet,
} from '$platform';

import {
  eventValue,
  hideStatus,
  onChange,
  onClick,
  readInputValue,
  setInputValue,
  setSelectValue,
  setText,
  showStatus,
} from './dom';
import {
  connectionErrorMessage,
  describeCacheStats,
  isValidOrgId,
  resolveModelDisplay,
} from './settings';

// Capture unhandled errors for diagnostics (sanitized, stored in
// chrome.storage.local).
initErrorCapture('options');

// ── Organization ID ────────────────────────────────────────────────────────

const loadOrgId = async (): Promise<void> => {
  const result = await storageGet<{ organizationId?: string }>('sync', [
    'organizationId',
  ]);
  if (!result.organizationId) return;
  setInputValue('orgId', result.organizationId);
  showStatus('status', 'Organization ID loaded from saved settings', 'success');
  setTimeout(() => hideStatus('status'), 2000);
};

const saveOrgId = async (): Promise<void> => {
  const orgId = readInputValue('orgId');
  if (!orgId) {
    showStatus('status', 'Please enter an Organization ID', 'error');
    return;
  }
  if (!isValidOrgId(orgId)) {
    showStatus(
      'status',
      'Invalid Organization ID format. It should be a UUID like: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      'error',
    );
    return;
  }
  await storageSet('sync', { organizationId: orgId });
  showStatus('status', 'Settings saved successfully!', 'success');
};

// ── Connection test ────────────────────────────────────────────────────────

/**
 * Firefox MV3 makes host permissions optional and user-revocable, so the
 * extension may be installed yet unable to reach claude.ai at all. Chrome
 * always reports granted, so this is a no-op there.
 */
const ensureClaudeAccess = async (): Promise<boolean> => {
  if (await hasClaudeAccess()) return true;
  return requestClaudeAccess();
};

const runConnectionTest = async (orgId: string): Promise<void> => {
  try {
    const data = await fetchConversationList(orgId);
    showStatus(
      'testStatus',
      `Success! Found ${data.length} conversations.`,
      'success',
    );
  } catch (error) {
    showStatus('testStatus', connectionErrorMessage(error), 'error');
  }
};

const testConnection = async (): Promise<void> => {
  const orgId = readInputValue('orgId');
  if (!orgId) {
    showStatus('testStatus', 'Please save an Organization ID first', 'error');
    return;
  }

  showStatus('testStatus', 'Testing connection...', 'success');

  if (!(await ensureClaudeAccess())) {
    showStatus(
      'testStatus',
      'Access to claude.ai was not granted. Please allow the permission to test the connection.',
      'error',
    );
    return;
  }

  await runConnectionTest(orgId);
};

// ── Backup and restore ─────────────────────────────────────────────────────

const runBackup = async (): Promise<void> => {
  const { message, success } = await backupExtensionData();
  showStatus('backupStatus', message, success ? 'success' : 'error');
};

// The mode is chosen before the OS file picker opens, so it has to survive the
// async gap between the two. Consumed on use — a stale mode must never be
// applied to a file picked for a later, cancelled attempt.
let pendingImportMode: ImportMode | null = null;

const startRestore = async (): Promise<void> => {
  const mode = await showImportModeModal();
  if (mode === null) return; // user cancelled the modal
  pendingImportMode = mode;
  document.getElementById('restoreFile')?.click();
};

const takePendingImportMode = (): ImportMode | null => {
  const mode = pendingImportMode;
  pendingImportMode = null;
  return mode;
};

const finishRestore = async (event: Event): Promise<void> => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const file = target.files?.[0];
  target.value = ''; // allow re-selecting the same file later
  const mode = takePendingImportMode();
  if (!file || !mode) return;
  const { message, success } = await importBackup(file, mode);
  showStatus('backupStatus', message, success ? 'success' : 'error');
};

// ── Display preferences (rendered by the browse page) ──────────────────────

const RELOAD_HINT = 'Reload the browse page to see the change.';

const loadDateTimeFormatPrefs = async (): Promise<void> => {
  const result = await storageGet<{ dateFormat?: string; timeFormat?: string }>(
    'local',
    ['dateFormat', 'timeFormat'],
  );
  setSelectValue('dateFormatSelect', result.dateFormat || 'mdy');
  setSelectValue('timeFormatSelect', result.timeFormat || '12h');
};

const saveFormatPref = async (
  key: 'dateFormat' | 'timeFormat',
  label: string,
  event: Event,
): Promise<void> => {
  const value = eventValue(event);
  if (value === undefined) return;
  await storageSet('local', { [key]: value });
  showStatus(
    'dateTimeStatus',
    `${label} format saved. ${RELOAD_HINT}`,
    'success',
  );
};

const loadModelDisplayPref = async (): Promise<void> => {
  const result = await storageGet<{ modelDisplay?: string }>('local', [
    'modelDisplay',
  ]);
  const value = resolveModelDisplay(result.modelDisplay);
  const radio = document.querySelector<HTMLInputElement>(
    `input[name="modelDisplay"][value="${value}"]`,
  );
  if (radio) radio.checked = true;
};

const saveModelDisplayPref = async (event: Event): Promise<void> => {
  const value = eventValue(event);
  if (value === undefined) return;
  await storageSet('local', { modelDisplay: value });
  showStatus(
    'modelDisplayStatus',
    `Model display preference saved. ${RELOAD_HINT}`,
    'success',
  );
};

// ── Contact and diagnostics ────────────────────────────────────────────────

const openBugReportEmail = (event: Event): void => {
  event.preventDefault();
  const subject = encodeURIComponent(
    `Claude Exporter Bug Report — v${getManifestVersion()}`,
  );
  const body = encodeURIComponent(
    'Describe the issue here. If this is a bug, please attach a diagnostics file generated from the Options page.\n\n',
  );
  window.location.href = `mailto:agoramachina@gmail.com?subject=${subject}&body=${body}`;
};

const runDiagnostics = async (event: Event): Promise<void> => {
  event.preventDefault();
  const { message, success } = await generateDiagnostics();
  showStatus('contactStatus', message, success ? 'success' : 'error');
};

// ── Chat Cache ─────────────────────────────────────────────────────────────
//
// The options page is extension-origin, the same as the background worker, so
// it reads the cache directly rather than relaying through it.

const readCacheDescription = async (): Promise<string> => {
  try {
    return describeCacheStats(await cacheStats());
  } catch (error) {
    console.warn(
      new Error('Could not read the Chat Cache statistics', { cause: error }),
    );
    return 'Cache unavailable.';
  }
};

const refreshCacheStats = async (): Promise<void> => {
  setText('cacheStats', await readCacheDescription());
};

const emptyCache = async (): Promise<void> => {
  hideStatus('cacheStatus');
  try {
    await clearCache();
  } catch (error) {
    showStatus(
      'cacheStatus',
      `Could not clear the cache: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
    return;
  }
  await refreshCacheStats();
  showStatus(
    'cacheStatus',
    'Chat Cache cleared. The next export will refetch.',
    'success',
  );
};

// ── Wiring ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  void loadOrgId();
  void refreshCacheStats();
});

onClick('saveBtn', () => void saveOrgId());
onClick('testBtn', () => void testConnection());
onClick('backupBtn', () => void runBackup());
onClick('restoreBtn', () => void startRestore());
onChange('restoreFile', (event) => void finishRestore(event));
onClick('clearCacheBtn', () => void emptyCache());

onChange(
  'dateFormatSelect',
  (event) => void saveFormatPref('dateFormat', 'Date', event),
);
onChange(
  'timeFormatSelect',
  (event) => void saveFormatPref('timeFormat', 'Time', event),
);

document
  .getElementById('emailDevLink')
  ?.addEventListener('click', openBugReportEmail);
document
  .getElementById('generateDiagnosticsLink')
  ?.addEventListener('click', (event) => void runDiagnostics(event));

document
  .querySelectorAll<HTMLInputElement>('input[name="modelDisplay"]')
  .forEach((radio) => {
    radio.addEventListener(
      'change',
      (event) => void saveModelDisplayPref(event),
    );
  });

void loadDateTimeFormatPrefs();
void loadModelDisplayPref();

export {};
