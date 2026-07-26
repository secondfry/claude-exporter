// Browse page entrypoint — UI wiring only.
//
// Every piece of business logic lives elsewhere: the export pipeline
// (features/export), Export Records and model snapshots (features/tracking),
// claude.ai HTTP (features/conversation/api), filtering/sorting/Selection
// (features/conversation-list), backup (features/backup). The page's own
// decisions live in this directory's siblings — the table's markup
// (./tableMarkup), what the user is told about an Export (./exportOutcome),
// which Conversations an Export covers (./exportSelection), the option form
// (./exportOptions), the organization ID (./orgId), the theme (./theme) and
// date/time preferences (./dateTimePrefs). Each of those is reachable by a
// spec; this file is not, so what is left here is DOM writes and
// addEventListener calls.

import {
  backupExtensionData,
  importBackup,
  showImportModeModal,
} from '$features/backup';
import { localCache } from '$features/cache';
import { createConversationList } from '$features/conversation-list';
import {
  fetchConversationList,
  fetchProjects,
} from '$features/conversation/api';
import { initErrorCapture } from '$features/diagnostics';
import { exportConversations } from '$features/export/pipeline';
import type {
  ExportOptions,
  ExportProgress,
  ExportResult,
  ExportTarget,
} from '$features/export/types';
import { inferModel } from '$features/models';
import {
  clearExportRecords,
  loadExportRecords,
  loadModelDisplay,
  markExported,
  recordModelSnapshots,
} from '$features/tracking';
import type { ExportRecordBook } from '$features/tracking';
import {
  getExtensionUrl,
  hasClaudeAccess,
  requestClaudeAccess,
} from '$platform';

import type { DateTimePrefs } from './dateTimePrefs';
import { loadDateTimePrefs, loadModelPreference } from './dateTimePrefs';
import {
  getButton,
  getElement,
  getInput,
  requireButton,
  requireElement,
  requireInput,
} from './dom';
import {
  CHAT_DEPENDENT_IDS,
  dependentOptionState,
  readExportOptions,
} from './exportOptions';
import type { Toast } from './exportOutcome';
import {
  bulkExportToasts,
  progressDisplay,
  singleExportToasts,
} from './exportOutcome';
import { exportTargets, rowExportTarget } from './exportSelection';
import { getOrgId } from './orgId';
import { buildTableModel, renderTable } from './tableMarkup';
import { currentTheme, initTheme, themeLabel, toggleTheme } from './theme';
import { asSortField, asStatusFilter } from './viewControls';

// ---------------------------------------------------------------------------
// Page-lifetime state
// ---------------------------------------------------------------------------

// The list is the single source of truth for Conversations, Export Records
// and models — the render path reads through it (list.needsExport,
// list.display) rather than keeping a second, independently-updated copy that
// sorting/filtering and rendering could silently disagree on.
const list = createConversationList();

let orgId: string | null = null;
let prefs: DateTimePrefs = { dateFormat: 'mdy', timeFormat: '12h' };

const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

const showError = (message: string): void => {
  const tableContent = requireElement('tableContent');
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error';
  errorDiv.textContent = message;
  tableContent.innerHTML = '';
  tableContent.appendChild(errorDiv);
};

const showToast = (message: string, isError = false): void => {
  const toast = getElement('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.background = isError ? '#d32f2f' : '#333';
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
};

// Toasts share one element, so a later one replaces the one before it. That is
// the pre-existing behaviour and the ordering in exportOutcome assumes it:
// the caveats are what remains on screen.
const showToasts = (toasts: Toast[]): void => {
  for (const toast of toasts) showToast(toast.message, toast.isError);
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const updateStats = (): void => {
  const stats = getElement('stats');
  if (!stats) return;
  stats.textContent = `Showing ${list.view().length} of ${list.all().length} conversations (${list.needsExportCount()} new/updated)`;
};

const updateExportButtonText = (): void => {
  const exportBtn = getButton('exportAllBtn');
  if (!exportBtn) return;

  const count = list.selectedCount();
  exportBtn.textContent =
    count > 0 ? `Export Selected (${count})` : 'Export All';
};

const wireRowExportButtons = (): void => {
  document.querySelectorAll<HTMLButtonElement>('.btn-export').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (!id) return;
      void exportSingle(rowExportTarget(list, id, btn.dataset.name || id));
    });
  });
};

const wireRowCheckboxes = (): void => {
  // 'click' rather than 'change' so the shift key is observable
  document
    .querySelectorAll<HTMLInputElement>('.conversation-checkbox')
    .forEach((checkbox) => {
      checkbox.addEventListener('click', handleCheckboxChange);
    });

  getInput('selectAll')?.addEventListener('click', handleSelectAll);
};

const wireSortableHeaders = (): void => {
  document.querySelectorAll<HTMLElement>('.sortable').forEach((header) => {
    header.addEventListener('click', () => {
      const field = asSortField(header.dataset.sort);
      if (!field) return;
      list.toggleSort(field);
      displayConversations();
    });
  });
};

/** Rebuilds the table from the list's current View and re-wires its controls. */
const displayConversations = (): void => {
  requireElement('tableContent').innerHTML = renderTable(
    buildTableModel(list, prefs),
  );
  updateStats();

  wireRowExportButtons();
  wireRowCheckboxes();
  wireSortableHeaders();
  updateExportButtonText();

  // An empty View has nothing to Export. Enabling the button anyway opens the
  // progress modal on "Exporting 0 conversations..." and then fails — which is
  // what a brand-new account saw.
  const exportAllBtn = getButton('exportAllBtn');
  if (exportAllBtn) exportAllBtn.disabled = list.view().length === 0;
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

// Selection changes must NOT rebuild the table: displayConversations()
// replaces tableContent's innerHTML, which destroys the very <input> the
// click event fired on. That drops keyboard focus to <body> (a keyboard user
// tabbed to a checkbox, pressed Space, and now has to re-tab from the top of
// the document for every row) and re-parses potentially thousands of rows on
// every single click. The list's state is already updated by this point, so
// just paint that state onto the existing DOM nodes.
const syncSelectionDom = (): void => {
  document
    .querySelectorAll<HTMLInputElement>('.conversation-checkbox')
    .forEach((checkbox) => {
      const id = checkbox.dataset.id;
      checkbox.checked = !!id && list.selected().has(id);
    });

  const selectAllCheckbox = getInput('selectAll');
  if (selectAllCheckbox) selectAllCheckbox.checked = list.allViewSelected();

  updateExportButtonText();
};

const handleCheckboxChange = (e: MouseEvent): void => {
  if (!(e.currentTarget instanceof HTMLInputElement)) return;
  const checkbox = e.currentTarget;
  const conversationId = checkbox.dataset.id;
  if (!conversationId) return;

  list.check(
    conversationId,
    parseInt(checkbox.dataset.index || '', 10),
    e.shiftKey,
  );
  syncSelectionDom();
};

const handleSelectAll = (e: Event): void => {
  if (!(e.currentTarget instanceof HTMLInputElement)) return;
  list.checkAll(e.currentTarget.checked);
  syncSelectionDom();
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const loadProjects = async (orgIdentifier: string): Promise<void> => {
  try {
    const projects = await fetchProjects(orgIdentifier);
    const projectsMap: Record<string, string> = {};
    for (const project of projects) {
      const projectId = project.uuid || project.id;
      if (!projectId) continue;
      projectsMap[projectId] =
        project.name || project.title || 'Untitled Project';
    }
    list.setProjects(projectsMap);
  } catch (error) {
    // The Project column degrades to '-'; nothing else depends on this.
    console.warn(new Error('Loading projects failed', { cause: error }));
  }
};

/** Best-effort: model history must never block the table from rendering. */
const refreshModels = async (): Promise<void> => {
  try {
    list.setModels(await loadModelDisplay(await loadModelPreference()));
  } catch (error) {
    console.warn(new Error('Loading model display failed', { cause: error }));
  }
};

const recordModelsFor = async (
  conversations: Awaited<ReturnType<typeof fetchConversationList>>,
): Promise<void> => {
  try {
    await recordModelSnapshots(conversations);
  } catch (error) {
    console.warn(
      new Error('Recording model snapshots failed', { cause: error }),
    );
    return;
  }
  await refreshModels();
};

const loadConversations = async (): Promise<void> => {
  if (!orgId) return;

  try {
    // Projects first, so the Project column resolves on the first render
    await loadProjects(orgId);
    const conversations = await fetchConversationList(orgId);
    await recordModelsFor(conversations);

    list.setConversations(
      conversations.map((conv) => ({ ...conv, model: inferModel(conv) })),
    );
    displayConversations();
  } catch (error) {
    console.error(new Error('Loading conversations failed', { cause: error }));
    showError(`Failed to load conversations: ${errorMessage(error)}`);
  }
};

/** Apply a freshly-loaded Export Record book and repaint the staleness dots. */
const applyExportRecords = (book: ExportRecordBook): void => {
  list.setExportRecords(book);
  displayConversations();
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

interface ProgressModal {
  dispose(): void;
  hide(): void;
  readonly signal: AbortSignal;
  update(progress: ExportProgress): void;
}

/** Drives #progressModal and wires #cancelExport to an AbortController. */
const openProgressModal = (initialText: string): ProgressModal => {
  const modal = requireElement('progressModal');
  const bar = requireElement('progressBar');
  const text = requireElement('progressText');
  const stats = requireElement('progressStats');
  const cancelButton = requireButton('cancelExport');

  const controller = new AbortController();

  const hide = (): void => {
    modal.style.display = 'none';
  };

  const onCancel = (): void => {
    controller.abort();
    hide();
    showToast('Export cancelled', true);
  };
  cancelButton.addEventListener('click', onCancel);

  bar.style.width = '0%';
  stats.textContent = '';
  text.textContent = initialText;
  modal.style.display = 'block';

  return {
    hide,
    signal: controller.signal,
    dispose() {
      cancelButton.removeEventListener('click', onCancel);
    },
    update(progress: ExportProgress) {
      const display = progressDisplay(progress);
      bar.style.width = display.barWidth;
      if (display.text !== null) text.textContent = display.text;
      if (display.stats !== null) stats.textContent = display.stats;
    },
  };
};

const isAbort = (error: unknown): boolean => {
  return error instanceof DOMException && error.name === 'AbortError';
};

/** Guards every export entry point; null means "already told the user". */
const requireOrgId = (): string | null => {
  if (orgId) return orgId;
  showToast('Organization ID not configured', true);
  return null;
};

/** The per-row Export button. */
const exportSingle = async (target: ExportTarget): Promise<void> => {
  const organizationId = requireOrgId();
  if (!organizationId) return;

  const options = readExportOptions();
  showToast(`Exporting ${target.name}...`);

  try {
    const result = await exportConversations(
      organizationId,
      [target],
      options,
      {
        cache: localCache,
      },
    );
    showToasts(singleExportToasts(result, target.name));
    applyExportRecords(await loadExportRecords());
  } catch (error) {
    console.error(new Error('Export failed', { cause: error }));
    showToast(`Failed to export: ${errorMessage(error)}`, true);
  }
};

const runBulkExport = async (
  organizationId: string,
  targets: ExportTarget[],
  options: ExportOptions,
  modal: ProgressModal,
): Promise<ExportResult> => {
  return exportConversations(organizationId, targets, options, {
    // The browse page is extension-origin, the same as the background worker,
    // so it shares that IndexedDB and needs no relay.
    cache: localCache,
    signal: modal.signal,
    onProgress: (progress) => modal.update(progress),
  });
};

const initialProgressText = (targets: ExportTarget[]): string => {
  return targets.length === 1
    ? `Exporting ${targets[0].name}...`
    : `Exporting ${targets.length} conversations...`;
};

/** The "Export All" / "Export Selected (N)" button. */
const exportAllFiltered = async (): Promise<void> => {
  const organizationId = requireOrgId();
  if (!organizationId) return;

  const options = readExportOptions();
  const button = requireButton('exportAllBtn');
  const originalButtonText = button.textContent || 'Export All';
  button.disabled = true;
  button.textContent = 'Preparing...';

  const targets = exportTargets(list);
  const modal = openProgressModal(initialProgressText(targets));

  try {
    const result = await runBulkExport(organizationId, targets, options, modal);
    modal.hide();
    showToasts(
      bulkExportToasts(
        result,
        targets.map((target) => target.name),
      ),
    );
    applyExportRecords(await loadExportRecords());
  } catch (error) {
    modal.hide();
    // A cancel already showed its own toast via the cancel button.
    if (!isAbort(error)) {
      console.error(new Error('Export failed', { cause: error }));
      showToast(`Export failed: ${errorMessage(error)}`, true);
    }
  } finally {
    modal.dispose();
    button.disabled = false;
    button.textContent = originalButtonText;
  }
};

// ---------------------------------------------------------------------------
// Event wiring — one arrow per concern
// ---------------------------------------------------------------------------

const wireOptionDependencies = (): void => {
  const includeChats = requireInput('includeChats');
  const dependents = CHAT_DEPENDENT_IDS.map(requireInput);

  const apply = (): void => {
    const state = dependentOptionState(includeChats.checked);
    for (const dependent of dependents) {
      dependent.disabled = state.disabled;
      if (state.checked === false) dependent.checked = false;
    }
  };

  includeChats.addEventListener('change', apply);
  apply();
};

/** Closes on an outside click, but not on a click within itself. */
const wireDropdown = (triggerId: string, dropdown: HTMLElement): void => {
  requireElement(triggerId).addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });
  document.addEventListener('click', () => dropdown.classList.remove('open'));
  dropdown.addEventListener('click', (e) => e.stopPropagation());
};

const showOrgIdInSettings = (): void => {
  const orgDisplay = requireElement('orgIdDisplay');
  if (!orgId) {
    orgDisplay.textContent = 'Not set';
    return;
  }
  orgDisplay.textContent = orgId.substring(0, 8) + '...';
  orgDisplay.title = orgId;
};

const showThemeInSettings = (): void => {
  requireElement('themeLabel').textContent = themeLabel(currentTheme());
};

const wireSettingsDropdown = (settingsDropdown: HTMLElement): void => {
  wireDropdown('settingsBtn', settingsDropdown);
  // The dropdown's contents are only correct at the moment it opens.
  requireElement('settingsBtn').addEventListener('click', () => {
    if (!settingsDropdown.classList.contains('open')) return;
    showOrgIdInSettings();
    showThemeInSettings();
  });

  requireElement('themeToggle').addEventListener('click', () => {
    toggleTheme();
    showThemeInSettings();
  });
};

const copyOrgId = async (): Promise<void> => {
  if (!orgId) {
    showToast('No org ID set', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(orgId);
    showToast('Org ID copied to clipboard');
  } catch (error) {
    console.warn(new Error('Copying the org ID failed', { cause: error }));
    showToast('Failed to copy org ID', true);
  }
};

// Open the options page in the same tab so the back button returns here.
const openOptionsPage = (): void => {
  window.location.href = getExtensionUrl('options.html');
};

const wireOrgIdControls = (settingsDropdown: HTMLElement): void => {
  requireElement('settingsOrgId').addEventListener('click', async () => {
    await copyOrgId();
    settingsDropdown.classList.remove('open');
  });
  requireElement('editOrgId').addEventListener('click', openOptionsPage);
  requireElement('advancedOptions').addEventListener('click', openOptionsPage);
};

const wireExportRecordControls = (settingsDropdown: HTMLElement): void => {
  requireElement('markAllExported').addEventListener('click', async () => {
    const ids = list.all().map((conv) => conv.uuid);
    applyExportRecords(await markExported(ids));
    settingsDropdown.classList.remove('open');
    showToast(`Marked ${ids.length} conversations as exported`);
  });

  requireElement('markAllNew').addEventListener('click', async () => {
    applyExportRecords(await clearExportRecords());
    list.clearSelection();
    // Only the Selection changes here, not the View — same in-place treatment
    // as handleCheckboxChange/handleSelectAll.
    list.selectPending();
    syncSelectionDom();
    settingsDropdown.classList.remove('open');
    showToast('All conversations marked as new');
  });
};

const wireBackupRestore = (settingsDropdown: HTMLElement): void => {
  requireElement('backupData').addEventListener('click', async () => {
    settingsDropdown.classList.remove('open');
    const { message, success } = await backupExtensionData();
    showToast(message, !success);
  });

  // Import flow: mode-choice modal → file picker → import. The chosen mode has
  // to survive the async file-picker boundary, hence the closure variable.
  const restoreFileBrowse = requireInput('restoreFileBrowse');
  let pendingImportMode: Awaited<ReturnType<typeof showImportModeModal>> = null;

  requireElement('restoreData').addEventListener('click', async () => {
    settingsDropdown.classList.remove('open');
    const mode = await showImportModeModal();
    if (mode === null) return; // user cancelled
    pendingImportMode = mode;
    restoreFileBrowse.click();
  });

  restoreFileBrowse.addEventListener('change', async () => {
    const file = restoreFileBrowse.files?.[0];
    restoreFileBrowse.value = ''; // allow re-selecting the same file later
    const mode = pendingImportMode;
    pendingImportMode = null; // consume; never reuse a stale mode
    if (!file || !mode) return;
    const { message, success } = await importBackup(file, mode);
    showToast(message, !success);
  });
};

const wireSearch = (searchInput: HTMLInputElement): void => {
  const searchBox = requireElement('searchBox');

  const setSearch = (value: string): void => {
    searchInput.value = value;
    searchBox.classList.toggle('has-text', !!value);
    list.setSearch(value);
    displayConversations();
  };

  searchInput.addEventListener('input', () => setSearch(searchInput.value));
  requireElement('clearSearch').addEventListener('click', () => setSearch(''));
};

const wireFilters = (searchInput: HTMLInputElement): void => {
  const filterBtn = requireElement('filterBtn');
  const filterDropdown = requireElement('filterDropdown');
  wireDropdown('filterBtn', filterDropdown);

  document.querySelectorAll<HTMLElement>('.filter-option').forEach((option) => {
    option.addEventListener('click', () => {
      const statusFilter = asStatusFilter(option.dataset.value);
      list.setStatusFilter(statusFilter);

      document
        .querySelectorAll('.filter-option')
        .forEach((other) => other.classList.remove('selected'));
      option.classList.add('selected');
      // The search bar's placeholder reflects the active scope
      searchInput.placeholder = list.searchPlaceholder();
      filterBtn.classList.toggle('active', statusFilter !== 'all');
      filterDropdown.classList.remove('open');
      displayConversations();
    });
  });

  document
    .querySelector('.filter-option[data-value="all"]')
    ?.classList.add('selected');
};

const setupEventListeners = (): void => {
  const settingsDropdown = requireElement('settingsDropdown');
  const searchInput = requireInput('searchInput');

  wireOptionDependencies();
  wireSettingsDropdown(settingsDropdown);
  wireOrgIdControls(settingsDropdown);
  wireExportRecordControls(settingsDropdown);
  wireBackupRestore(settingsDropdown);
  wireSearch(searchInput);
  wireFilters(searchInput);

  requireElement('exportAllBtn').addEventListener('click', () => {
    void exportAllFiltered();
  });
};

// ---------------------------------------------------------------------------
// Page lifecycle
// ---------------------------------------------------------------------------

const hasClaudeAccessSafely = async (): Promise<boolean> => {
  try {
    return await hasClaudeAccess();
  } catch (error) {
    // A browser that can't answer the question must not be blocked on it.
    console.warn(
      new Error('Checking claude.ai host access failed', { cause: error }),
    );
    return true;
  }
};

const grantAccess = async (button: HTMLButtonElement): Promise<void> => {
  button.disabled = true;
  try {
    if (await requestClaudeAccess()) {
      window.location.reload();
      return;
    }
    showToast('Permission was not granted', true);
  } catch (error) {
    showToast(`Permission request failed: ${errorMessage(error)}`, true);
  }
  button.disabled = false;
};

const showPermissionNotice = (): void => {
  const tableContent = requireElement('tableContent');
  tableContent.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'error';

  const message = document.createElement('div');
  message.textContent =
    'Claude Exporter needs permission to access https://claude.ai/ before it can list your conversations.';
  wrapper.appendChild(message);

  const button = document.createElement('button');
  button.className = 'export-all-btn';
  button.style.marginTop = '15px';
  button.textContent = 'Grant access to claude.ai';
  button.addEventListener('click', () => void grantAccess(button));
  wrapper.appendChild(button);

  tableContent.appendChild(wrapper);
};

/** Keep the loading state up for a beat, so it does not flash. */
const settleLoadingSpinner = async (startedAt: number): Promise<void> => {
  const elapsed = Date.now() - startedAt;
  if (elapsed >= 1000) return;
  await new Promise((resolve) => setTimeout(resolve, 1000 - elapsed));
};

const loadPageState = async (): Promise<void> => {
  orgId = await getOrgId();
  if (!orgId) {
    showError(
      'Organization ID not configured. Please open a claude.ai tab and reload this page, or configure it manually in the extension options.',
    );
  }
  list.setExportRecords(await loadExportRecords());
  prefs = await loadDateTimePrefs();
  await refreshModels();
};

// When the user navigates back to this page from the options page (bfcache
// hit), reload so changed preferences take effect without a manual refresh.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});

document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  initErrorCapture('browse');

  // Firefox MV3 host permissions are optional and user-revocable. Without
  // https://claude.ai/* nothing below can succeed, so say so rather than
  // showing an empty table. Chrome always reports true here.
  if (!(await hasClaudeAccessSafely())) {
    showPermissionNotice();
    return;
  }

  // Wire the UI immediately so the chrome stays interactive while the org ID
  // and the Conversations are still loading.
  setupEventListeners();

  const loadingStart = Date.now();
  await loadPageState();
  await settleLoadingSpinner(loadingStart);

  const loadingText = getElement('loadingText');
  if (loadingText) loadingText.textContent = 'Loading conversations...';
  await loadConversations();
});

export {};
