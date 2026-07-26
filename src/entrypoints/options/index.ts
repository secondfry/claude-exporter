import { backupExtensionData, showImportModeModal, importBackup } from '../../features/backup';
import { generateDiagnostics, initErrorCapture } from '../../features/diagnostics';
import { fetchConversationList } from '../../features/conversation/api';
import { storageGet, storageSet, getManifestVersion, hasClaudeAccess, requestClaudeAccess } from '../../platform';

// Capture unhandled errors for diagnostics (sanitized, stored in chrome.storage.local)
initErrorCapture('options');

function showStatus(elementId: string, message: string, type: 'success' | 'error'): void {
  const statusEl = document.getElementById(elementId);
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

function hideStatus(elementId: string): void {
  const statusEl = document.getElementById(elementId);
  if (!statusEl) return;
  statusEl.className = 'status';
}

// Load saved settings
document.addEventListener('DOMContentLoaded', () => {
  storageGet<{ organizationId?: string }>('sync', ['organizationId']).then((result) => {
    if (result.organizationId) {
      const orgIdInput = document.getElementById('orgId') as HTMLInputElement | null;
      if (orgIdInput) orgIdInput.value = result.organizationId;
      showStatus('status', 'Organization ID loaded from saved settings', 'success');
      setTimeout(() => hideStatus('status'), 2000);
    }
  });
});

// Save settings
document.getElementById('saveBtn')?.addEventListener('click', () => {
  const orgIdInput = document.getElementById('orgId') as HTMLInputElement | null;
  const orgId = orgIdInput?.value.trim() ?? '';

  if (!orgId) {
    showStatus('status', 'Please enter an Organization ID', 'error');
    return;
  }

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(orgId)) {
    showStatus('status', 'Invalid Organization ID format. It should be a UUID like: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', 'error');
    return;
  }

  storageSet('sync', { organizationId: orgId }).then(() => {
    showStatus('status', 'Settings saved successfully!', 'success');
  });
});

// Test connection
document.getElementById('testBtn')?.addEventListener('click', async () => {
  const orgIdInput = document.getElementById('orgId') as HTMLInputElement | null;
  const orgId = orgIdInput?.value.trim() ?? '';

  if (!orgId) {
    showStatus('testStatus', 'Please save an Organization ID first', 'error');
    return;
  }

  showStatus('testStatus', 'Testing connection...', 'success');

  // Firefox MV3 makes host permissions optional and user-revocable, so the
  // extension may be installed yet unable to reach claude.ai at all.
  const hasAccess = await hasClaudeAccess();
  if (!hasAccess) {
    const granted = await requestClaudeAccess();
    if (!granted) {
      showStatus('testStatus', 'Access to claude.ai was not granted. Please allow the permission to test the connection.', 'error');
      return;
    }
  }

  try {
    const data = await fetchConversationList(orgId);
    showStatus('testStatus', `Success! Found ${data.length} conversations.`, 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('401')) {
      showStatus('testStatus', 'Not authenticated. Please make sure you are logged into claude.ai', 'error');
    } else if (message.includes('403')) {
      showStatus('testStatus', 'Access denied. The Organization ID might be incorrect.', 'error');
    } else {
      showStatus('testStatus', `Connection error: ${message}`, 'error');
    }
  }
});

// Backup all extension data to a file (shared logic lives in features/backup)
document.getElementById('backupBtn')?.addEventListener('click', () => {
  backupExtensionData((success, message) => {
    showStatus('backupStatus', message, success ? 'success' : 'error');
  });
});

// Restore extension data from a backup file. Flow: click → mode-choice modal
// → file picker → import. The mode is held in pendingImportMode across the
// async file-picker boundary.
let pendingImportMode: 'merge' | 'replace' | null = null;

document.getElementById('restoreBtn')?.addEventListener('click', () => {
  showImportModeModal((mode) => {
    if (mode === null) return; // user cancelled the modal
    pendingImportMode = mode;
    document.getElementById('restoreFile')?.click();
  });
});

document.getElementById('restoreFile')?.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  target.value = ''; // allow re-selecting the same file later
  const mode = pendingImportMode;
  pendingImportMode = null; // consume; never reuse a stale mode
  if (!file || !mode) return;
  importBackup(file, mode, (success, message) => {
    showStatus('backupStatus', message, success ? 'success' : 'error');
  });
});

// Date & Time format preferences (displayed in the browse view)
function loadDateTimeFormatPrefs(): void {
  storageGet<{ dateFormat?: string; timeFormat?: string }>('local', ['dateFormat', 'timeFormat']).then((result) => {
    const dateFormatSelect = document.getElementById('dateFormatSelect') as HTMLSelectElement | null;
    const timeFormatSelect = document.getElementById('timeFormatSelect') as HTMLSelectElement | null;
    if (dateFormatSelect) dateFormatSelect.value = result.dateFormat || 'mdy';
    if (timeFormatSelect) timeFormatSelect.value = result.timeFormat || '12h';
  });
}
loadDateTimeFormatPrefs();

document.getElementById('dateFormatSelect')?.addEventListener('change', (e) => {
  const value = (e.target as HTMLSelectElement).value;
  storageSet('local', { dateFormat: value }).then(() => {
    showStatus('dateTimeStatus', 'Date format saved. Reload the browse page to see the change.', 'success');
  });
});

document.getElementById('timeFormatSelect')?.addEventListener('change', (e) => {
  const value = (e.target as HTMLSelectElement).value;
  storageSet('local', { timeFormat: value }).then(() => {
    showStatus('dateTimeStatus', 'Time format saved. Reload the browse page to see the change.', 'success');
  });
});

// Model display preference (browse view's Model column)
function loadModelDisplayPref(): void {
  storageGet<{ modelDisplay?: string }>('local', ['modelDisplay']).then((result) => {
    const value = result.modelDisplay === 'current' ? 'current' : 'original';
    const radio = document.querySelector<HTMLInputElement>(`input[name="modelDisplay"][value="${value}"]`);
    if (radio) radio.checked = true;
  });
}
loadModelDisplayPref();

document.querySelectorAll<HTMLInputElement>('input[name="modelDisplay"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    const value = (e.target as HTMLInputElement).value;
    storageSet('local', { modelDisplay: value }).then(() => {
      showStatus('modelDisplayStatus', 'Model display preference saved. Reload the browse page to see the change.', 'success');
    });
  });
});

// Contact & Diagnostics
document.getElementById('emailDevLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  const version = getManifestVersion();
  const subject = encodeURIComponent(`Claude Exporter Bug Report — v${version}`);
  const body = encodeURIComponent('Describe the issue here. If this is a bug, please attach a diagnostics file generated from the Options page.\n\n');
  window.location.href = `mailto:agoramachina@gmail.com?subject=${subject}&body=${body}`;
});

document.getElementById('generateDiagnosticsLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  generateDiagnostics((success, message) => {
    showStatus('contactStatus', message, success ? 'success' : 'error');
  });
});

export {};
