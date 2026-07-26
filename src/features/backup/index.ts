// Backup: a user-initiated snapshot of the extension's own settings and Export
// Records, for moving between machines. Never carries the Chat Cache — that
// lives in IndexedDB, which this deliberately does not touch.

import { getManifestVersion, storageGet, storageSet } from '$platform';

interface BackupMeta {
  app: 'claude-exporter';
  backupVersion: number;
  createdAt: string;
  extensionVersion: string;
}

interface BackupFile {
  _meta: BackupMeta;
  local: Record<string, unknown>;
  sync: Record<string, unknown>;
}

/** What the caller shows the user; each surface renders it its own way. */
interface BackupOutcome {
  message: string;
  success: boolean;
}

type ImportMode = 'merge' | 'replace';

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const isImportMode = (value: unknown): value is ImportMode => {
  return value === 'merge' || value === 'replace';
};

/**
 * A backup file as written by backupExtensionData. Validated rather than
 * asserted: this is a file the user picked off disk, so it is the least
 * trustworthy input in the extension.
 */
const isBackupFile = (value: unknown): value is BackupFile => {
  if (!isPlainObject(value)) return false;
  const meta = value._meta;
  if (!isPlainObject(meta) || meta.app !== 'claude-exporter') return false;
  return isPlainObject(value.local);
};

const countEntries = (value: unknown): number => {
  return isPlainObject(value) ? Object.keys(value).length : 0;
};

const timestampSuffix = (now: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const hms = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${ymd}-${hms}`;
};

const downloadJson = (filename: string, payload: unknown): void => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// Download all extension storage (local + sync) as a structured JSON file.
const backupExtensionData = async (): Promise<BackupOutcome> => {
  try {
    const local = await storageGet<Record<string, unknown>>('local', null);
    const sync = await storageGet<Record<string, unknown>>('sync', null);
    const backup: BackupFile = {
      _meta: {
        app: 'claude-exporter',
        backupVersion: 1,
        createdAt: new Date().toISOString(),
        extensionVersion: getManifestVersion(),
      },
      local: local ?? {},
      sync: sync ?? {},
    };
    downloadJson(
      `claude-exporter-backup-${timestampSuffix(new Date())}.json`,
      backup,
    );
    const snapCount = countEntries(backup.local.modelSnapshots);
    const exportCount = countEntries(backup.local.exportTimestamps);
    return {
      message: `Backup exported — ${snapCount} model snapshot(s), ${exportCount} export record(s).`,
      success: true,
    };
  } catch (error) {
    return {
      message: `Backup failed: ${error instanceof Error ? error.message : String(error)}`,
      success: false,
    };
  }
};

// Conservative merge: for each top-level key in `backup`, if the key is absent
// locally, copy it over; if both sides are plain objects (UUID-keyed records
// like exportTimestamps / modelSnapshots), merge their sub-keys with local
// winning on overlap. Scalar conflicts (org ID, date format, etc.) keep the
// local value untouched.
const mergeStorageData = (
  current: Record<string, unknown>,
  backup: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...current };
  for (const [key, backupVal] of Object.entries(backup || {})) {
    const currentVal = current[key];
    if (!(key in current)) {
      result[key] = backupVal;
    } else if (isPlainObject(currentVal) && isPlainObject(backupVal)) {
      result[key] = { ...backupVal, ...currentVal };
    }
    // else: scalar conflict — current value is already in result, keep it
  }
  return result;
};

// Show a modal letting the user choose merge vs replace BEFORE the OS file
// picker opens. Resolves with the chosen mode, or null on Cancel / Esc /
// overlay click. The caller opens the file picker on a non-null mode.
const showImportModeModal = (): Promise<ImportMode | null> => {
  return new Promise((resolve) => {
    if (!document.getElementById('claude-exporter-modal-styles')) {
      const style = document.createElement('style');
      style.id = 'claude-exporter-modal-styles';
      style.textContent = `
      .ce-modal-overlay {
        position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55);
        display: flex; align-items: center; justify-content: center;
        z-index: 100000; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      .ce-modal {
        background: var(--bg-body, #ffffff);
        color: var(--text-primary, #2c313a);
        padding: 22px 24px;
        border-radius: 8px;
        max-width: 480px; width: 90%;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
        border: 1px solid var(--border-color, #e2e4e9);
      }
      .ce-modal h2 { margin: 0 0 14px; font-size: 17px; font-weight: 600; }
      .ce-modal-info {
        background: var(--section-bg, var(--bg-card, #f8f9fa));
        padding: 10px 12px;
        border-radius: 5px;
        margin-bottom: 14px;
        font-size: 13px;
        line-height: 1.5;
        border: 1px solid var(--border-color, #e2e4e9);
      }
      .ce-modal-option {
        display: block; padding: 10px 12px; border-radius: 5px;
        margin-bottom: 8px; cursor: pointer;
        border: 1px solid var(--border-color, #e2e4e9);
        background: var(--bg-body, #ffffff);
        font-size: 13px;
      }
      .ce-modal-option:hover { border-color: var(--primary-color, #5d44e8); }
      .ce-modal-option input { margin-right: 6px; vertical-align: middle; }
      .ce-modal-option strong { font-weight: 600; }
      .ce-modal-option-desc {
        display: block; margin: 4px 0 0 22px;
        font-size: 12px;
        color: var(--text-secondary, #666666);
      }
      .ce-modal-actions {
        display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px;
      }
      .ce-modal-actions button {
        padding: 8px 16px; border-radius: 5px; border: none;
        cursor: pointer; font-size: 14px;
        display: inline-flex; align-items: center; justify-content: center;
        line-height: 1;
      }
      .ce-modal-cancel {
        background: var(--section-bg, var(--bg-card, #e9ecef));
        color: var(--text-primary, #2c313a);
        border: 1px solid var(--border-color, #e2e4e9) !important;
      }
      .ce-modal-import {
        background: var(--primary-color, #5d44e8);
        color: #ffffff;
      }
      .ce-modal-import:hover { background: var(--primary-hover, #4a35ba); }
    `;
      document.head.appendChild(style);
    }

    // Remove any stale modal before showing a new one
    const stale = document.querySelector('.ce-modal-overlay');
    if (stale) stale.remove();

    const overlay = document.createElement('div');
    overlay.className = 'ce-modal-overlay';
    overlay.innerHTML = `
    <div class="ce-modal" role="dialog" aria-modal="true" aria-labelledby="ce-modal-title">
      <h2 id="ce-modal-title">Import Backup</h2>
      <div class="ce-modal-info">
        Choose how the imported data should be combined with your current data, then pick a backup file.
      </div>
      <label class="ce-modal-option">
        <input type="radio" name="ce-import-mode" value="merge" checked>
        <strong>Merge with current data</strong>
        <span class="ce-modal-option-desc">Adds entries not present locally; keeps your current values when they overlap.</span>
      </label>
      <label class="ce-modal-option">
        <input type="radio" name="ce-import-mode" value="replace">
        <strong>Replace all current data</strong>
        <span class="ce-modal-option-desc">Overwrites everything with this backup's contents.</span>
      </label>
      <div class="ce-modal-actions">
        <button type="button" class="ce-modal-cancel">Cancel</button>
        <button type="button" class="ce-modal-import">Choose File&hellip;</button>
      </div>
    </div>
  `;

    document.body.appendChild(overlay);

    const selectedMode = (): ImportMode | null => {
      const checked = overlay.querySelector(
        'input[name="ce-import-mode"]:checked',
      );
      if (!(checked instanceof HTMLInputElement)) return null;
      return isImportMode(checked.value) ? checked.value : null;
    };

    const cleanup = (mode: ImportMode | null) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(mode);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cleanup(null);
      else if (e.key === 'Enter') cleanup(selectedMode());
    };
    document.addEventListener('keydown', onKey);

    overlay
      .querySelector('.ce-modal-cancel')
      ?.addEventListener('click', () => cleanup(null));
    overlay
      .querySelector('.ce-modal-import')
      ?.addEventListener('click', () => cleanup(selectedMode()));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(null);
    });

    // Focus the default radio so keyboard users can act immediately
    const firstRadio = overlay.querySelector('input[name="ce-import-mode"]');
    if (firstRadio instanceof HTMLInputElement) firstRadio.focus();
  });
};

// Import extension storage from a file produced by backupExtensionData.
// Validates the file, then writes to local + sync using the supplied mode.
// The mode choice is made BEFORE the file picker opens (see
// showImportModeModal), so this function just executes.
const importBackup = async (
  file: File,
  mode: ImportMode,
): Promise<BackupOutcome> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return {
      message: 'Import failed: the file is not valid JSON.',
      success: false,
    };
  }

  if (!isBackupFile(parsed)) {
    return {
      message:
        'Import failed: this does not look like a Claude Exporter backup file.',
      success: false,
    };
  }

  const snapCount = countEntries(parsed.local.modelSnapshots);
  const exportCount = countEntries(parsed.local.exportTimestamps);
  const syncData = isPlainObject(parsed.sync) ? parsed.sync : {};
  const tail =
    'Reload any open Claude pages and the browse page to see the changes.';

  try {
    if (mode === 'replace') {
      await storageSet('local', parsed.local);
      await storageSet('sync', syncData);
      return {
        message: `Import complete (replace) — ${snapCount} model snapshot(s), ${exportCount} export record(s) restored. ${tail}`,
        success: true,
      };
    }

    const currentLocal = await storageGet<Record<string, unknown>>(
      'local',
      null,
    );
    const currentSync = await storageGet<Record<string, unknown>>('sync', null);
    await storageSet(
      'local',
      mergeStorageData(currentLocal ?? {}, parsed.local),
    );
    await storageSet('sync', mergeStorageData(currentSync ?? {}, syncData));
    return {
      message: `Import complete (merge) — added missing entries from backup, kept your current values on overlap. ${tail}`,
      success: true,
    };
  } catch (error) {
    return {
      message: `Import failed: ${error instanceof Error ? error.message : String(error)}`,
      success: false,
    };
  }
};

export {
  backupExtensionData,
  importBackup,
  isBackupFile,
  mergeStorageData,
  showImportModeModal,
};
export type { BackupOutcome, ImportMode };
