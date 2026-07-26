// Browse page entrypoint — UI wiring only.
//
// Every piece of business logic here lives in features/: the export pipeline
// (features/export), Export Records and model snapshots (features/tracking),
// claude.ai HTTP (features/conversation/api), filtering/sorting/Selection
// (features/conversation-list), backup (features/backup). This file owns DOM
// helpers, theme, date/time preferences, page lifecycle, data loading, TABLE
// RENDERING, the progress modal, export orchestration, toasts and event
// wiring — nothing else.

import {
  backupExtensionData,
  importBackup,
  showImportModeModal,
} from '$features/backup';
import type { ImportMode } from '$features/backup';
import { localCache } from '$features/cache';
import { createConversationList } from '$features/conversation-list';
import type { SortField, StatusFilter } from '$features/conversation-list';
import {
  detectOrgId,
  fetchConversationList,
  fetchProjects,
} from '$features/conversation/api';
import type { Project } from '$features/conversation/api';
import type { ConversationSummary } from '$features/conversation/types';
import { initErrorCapture } from '$features/diagnostics';
import { exportConversations } from '$features/export/pipeline';
import type {
  ArtifactFormat,
  ExportFormat,
  ExportOptions,
  ExportProgress,
  ExportTarget,
} from '$features/export/types';
import {
  formatModelName,
  getModelBadgeClass,
  inferModel,
} from '$features/models';
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
  storageGet,
  storageSet,
} from '$platform';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const el = <T extends HTMLElement>(id: string): T | null => {
  return document.getElementById(id) as T | null;
};

/** For elements browse.html guarantees. Throws loudly if the markup drifts. */
const req = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id) as T | null;
  if (!found) throw new Error(`browse.html is missing #${id}`);
  return found;
};

const escapeHtml = (str: string | null | undefined): string => {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
};

const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const initTheme = (): void => {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme);
  } else {
    const prefersDark = window.matchMedia(
      '(prefers-color-scheme: dark)',
    ).matches;
    document.documentElement.setAttribute(
      'data-theme',
      prefersDark ? 'dark' : 'light',
    );
  }
};

const toggleTheme = (): void => {
  const currentTheme =
    document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let orgId: string | null = null;
// The list is the single source of truth for Conversations, Export Records
// and models — the render path below reads through it (list.needsExport,
// list.display) rather than keeping a second, independently-updated copy
// that sorting/filtering and rendering could silently disagree on.
const list = createConversationList();
let dateFormat: 'dmy' | 'mdy' = 'mdy';
let timeFormat: '12h' | '24h' = '12h';
let modelDisplay: 'current' | 'original' = 'original';

/** Narrows a `.filter-option`'s dataset value to StatusFilter without an `as` assertion. */
const asStatusFilter = (value: string | undefined): StatusFilter => {
  return value === 'pending' ||
    value === 'never' ||
    value === 'stale' ||
    value === 'exported' ||
    value === 'projects'
    ? value
    : 'all';
};

/** Narrows a `.sortable` header's dataset value to SortField without an `as` assertion. */
const asSortField = (value: string | undefined): SortField | null => {
  return value === 'name' ||
    value === 'project' ||
    value === 'created' ||
    value === 'updated' ||
    value === 'model'
    ? value
    : null;
};

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

const loadDateTimePrefs = async (): Promise<void> => {
  const result = await storageGet<{ dateFormat?: string; timeFormat?: string }>(
    'local',
    ['dateFormat', 'timeFormat'],
  );
  dateFormat = result.dateFormat === 'dmy' ? 'dmy' : 'mdy';
  timeFormat = result.timeFormat === '24h' ? '24h' : '12h';
};

const loadModelDisplayPref = async (): Promise<void> => {
  const result = await storageGet<{ modelDisplay?: string }>('local', [
    'modelDisplay',
  ]);
  modelDisplay = result.modelDisplay === 'current' ? 'current' : 'original';
};

const formatDate = (dt: Date): string => {
  const m = dt.getMonth() + 1;
  const d = dt.getDate();
  const y = dt.getFullYear();
  return dateFormat === 'dmy' ? `${d}/${m}/${y}` : `${m}/${d}/${y}`;
};

const formatTime = (dt: Date): string => {
  if (timeFormat === '24h') {
    return dt.toLocaleTimeString([], {
      hour: '2-digit',
      hour12: false,
      minute: '2-digit',
    });
  }
  return dt.toLocaleTimeString([], {
    hour: '2-digit',
    hour12: true,
    minute: '2-digit',
  });
};

// ---------------------------------------------------------------------------
// Page lifecycle
// ---------------------------------------------------------------------------

// When user navigates back to this page from the options page (bfcache hit),
// reload so changed preferences (model display, date/time format, etc.) take
// effect without a manual refresh.
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

  // Wire up UI listeners (settings dropdown, filters, search, etc.) immediately
  // so the chrome stays interactive while orgId / conversations are still loading.
  setupEventListeners();
  const loadingStart = Date.now();
  await loadOrgId();
  list.setExportRecords(await loadExportRecords());
  await loadDateTimePrefs();
  await loadModelDisplayPref();
  list.setModels(await loadModelDisplay(modelDisplay));
  const elapsed = Date.now() - loadingStart;
  if (elapsed < 1000) await new Promise((r) => setTimeout(r, 1000 - elapsed));
  const loadingText = el('loadingText');
  if (loadingText) loadingText.textContent = 'Loading conversations...';
  await loadConversations();
});

const hasClaudeAccessSafely = async (): Promise<boolean> => {
  try {
    return await hasClaudeAccess();
  } catch {
    // A browser that can't answer the question must not be blocked on it.
    return true;
  }
};

const showPermissionNotice = (): void => {
  const tableContent = req('tableContent');
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
  button.addEventListener('click', async () => {
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
  });
  wrapper.appendChild(button);

  tableContent.appendChild(wrapper);
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

// Load organization ID — auto-detect first, fall back to stored
const loadOrgId = async (): Promise<void> => {
  try {
    const detected = await detectOrgId();
    if (detected) {
      orgId = detected;
      // Save for future use / fallback
      void storageSet('sync', { organizationId: detected });
      return;
    }
  } catch (e) {
    console.log('Auto-detect org ID failed, falling back to stored:', e);
  }

  const stored = await storageGet<{ organizationId?: string }>('sync', [
    'organizationId',
  ]);
  orgId = stored.organizationId || null;
  if (!orgId) {
    showError(
      'Organization ID not configured. Please open a claude.ai tab and reload this page, or configure it manually in the extension options.',
    );
  }
};

const loadProjects = async (): Promise<void> => {
  if (!orgId) return;
  try {
    const projects: Project[] = await fetchProjects(orgId);
    const projectsMap: Record<string, string> = {};
    projects.forEach((project) => {
      const projectId = project.uuid || project.id;
      const projectName = project.name || project.title || 'Untitled Project';
      if (projectId) projectsMap[projectId] = projectName;
    });
    list.setProjects(projectsMap);
  } catch (error) {
    console.warn('Error loading projects:', error);
  }
};

const loadConversations = async (): Promise<void> => {
  if (!orgId) return;

  try {
    // Load projects first so the Project column resolves on the first render
    await loadProjects();

    const conversations = await fetchConversationList(orgId);

    // Best-effort: snapshot recording must never block rendering
    try {
      await recordModelSnapshots(conversations);
      list.setModels(await loadModelDisplay(modelDisplay));
    } catch (error) {
      console.error('Error recording model snapshots:', error);
    }

    // Infer models for conversations with null model
    const conversationsWithModels = conversations.map((conv) => ({
      ...conv,
      model: inferModel(conv),
    }));
    list.setConversations(conversationsWithModels);

    displayConversations();
    updateStats();
  } catch (error) {
    console.error('Error loading conversations:', error);
    showError(`Failed to load conversations: ${errorMessage(error)}`);
  }
};

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

const displayConversations = (): void => {
  const tableContent = req('tableContent');
  const view = list.view();

  if (view.length === 0) {
    tableContent.innerHTML =
      '<div class="no-results">No conversations found</div>';
    return;
  }

  let html = `
    <table>
      <thead>
        <tr>
          <th class="sortable" data-sort="name">Name${list.sortIndicator('name')}</th>
          <th class="sortable" data-sort="project">Project${list.sortIndicator('project')}</th>
          <th class="sortable" data-sort="updated">Updated${list.sortIndicator('updated')}</th>
          <th class="sortable" data-sort="created">Created${list.sortIndicator('created')}</th>
          <th class="sortable" data-sort="model">Model${list.sortIndicator('model')}</th>
          <th>Actions</th>
          <th class="checkbox-col">
            <input type="checkbox" id="selectAll" class="select-all-checkbox" ${list.allViewSelected() ? 'checked' : ''}>
          </th>
        </tr>
      </thead>
      <tbody>
  `;

  view.forEach((conv, index) => {
    const updatedDt = new Date(conv.updated_at);
    const createdDt = new Date(conv.created_at);
    const updatedDate = formatDate(updatedDt);
    const updatedTime = formatTime(updatedDt);
    const createdDate = formatDate(createdDt);
    const createdTime = formatTime(createdDt);
    const modelInfo = list.display(conv);
    const modelBadgeClass = getModelBadgeClass(modelInfo.model);
    const projectName = list.projectName(conv);

    const newUpdated = list.needsExport(conv);
    html += `
      <tr data-id="${escapeHtml(conv.uuid)}">
        <td>
          <div class="conversation-name">
            ${newUpdated ? '<span class="new-dot" title="New or updated since last export"></span>' : ''}
            <a href="https://claude.ai/chat/${escapeHtml(conv.uuid)}" target="_blank" title="${escapeHtml(conv.name)}">
              ${escapeHtml(conv.name)}
            </a>
          </div>
        </td>
        <td>${escapeHtml(projectName)}</td>
        <td class="date">${escapeHtml(updatedDate)}<br><span class="time">${escapeHtml(updatedTime)}</span></td>
        <td class="date">${escapeHtml(createdDate)}<br><span class="time">${escapeHtml(createdTime)}</span></td>
        <td>
          ${
            modelInfo.bounced
              ? `<span class="model-cell" title="${escapeHtml(modelInfo.otherLabel)} ${escapeHtml(formatModelName(modelInfo.other))}"><span class="model-badge ${modelBadgeClass}">${escapeHtml(formatModelName(modelInfo.model))}</span><span class="model-bounced ${modelBadgeClass}">*</span></span>`
              : `<span class="model-badge ${modelBadgeClass}">${escapeHtml(formatModelName(modelInfo.model))}</span>`
          }
        </td>
        <td>
          <div class="actions">
            <button class="btn-small btn-export" data-id="${escapeHtml(conv.uuid)}" data-name="${escapeHtml(conv.name)}">
              Export
            </button>
          </div>
        </td>
        <td class="checkbox-col">
          <input type="checkbox" class="conversation-checkbox" data-id="${escapeHtml(conv.uuid)}" data-index="${index}" ${list.selected().has(conv.uuid) ? 'checked' : ''}>
        </td>
      </tr>
    `;
  });

  html += `
      </tbody>
    </table>
  `;

  // Security: All user-provided data in html has been sanitized with escapeHtml()
  // before concatenation. The HTML structure itself is static/trusted template code.
  tableContent.innerHTML = html;

  document.querySelectorAll<HTMLButtonElement>('.btn-export').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (!id) return;
      // Take updated_at from the loaded list rather than the button's dataset:
      // it is what decides whether the Chat Cache may answer instead of the
      // network, so it must come from the same source the table rendered.
      const conv = list.all().find((candidate) => candidate.uuid === id);
      void exportSingle({
        name: btn.dataset.name || id,
        updatedAt: conv?.updated_at,
        uuid: id,
      });
    });
  });

  // Use 'click' rather than 'change' so the shift key is observable
  document
    .querySelectorAll<HTMLInputElement>('.conversation-checkbox')
    .forEach((checkbox) => {
      checkbox.addEventListener('click', handleCheckboxChange);
    });

  const selectAllCheckbox = el<HTMLInputElement>('selectAll');
  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener('click', handleSelectAll);
  }

  document.querySelectorAll<HTMLElement>('.sortable').forEach((header) => {
    header.addEventListener('click', () => {
      const field = asSortField(header.dataset.sort);
      if (field) {
        list.toggleSort(field);
        displayConversations();
        updateStats();
      }
    });
  });

  updateExportButtonText();

  const exportAllBtn = el<HTMLButtonElement>('exportAllBtn');
  if (exportAllBtn) exportAllBtn.disabled = false;
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

// Selection changes must NOT rebuild the table: displayConversations()
// replaces tableContent's innerHTML, which destroys the very <input> the
// click/change event fired on. That drops keyboard focus to <body> (a
// keyboard user tabbed to a checkbox, pressed Space, and now has to re-tab
// from the top of the document for every row) and re-parses/re-renders
// potentially thousands of rows on every single click. The list's state is
// already updated by this point, so just paint that state onto the existing
// DOM nodes.
const syncSelectionDom = (): void => {
  document
    .querySelectorAll<HTMLInputElement>('.conversation-checkbox')
    .forEach((checkbox) => {
      const id = checkbox.dataset.id;
      checkbox.checked = !!id && list.selected().has(id);
    });

  const selectAllCheckbox = el<HTMLInputElement>('selectAll');
  if (selectAllCheckbox) selectAllCheckbox.checked = list.allViewSelected();
};

const handleCheckboxChange = (e: MouseEvent): void => {
  if (!(e.currentTarget instanceof HTMLInputElement)) return;
  const checkbox = e.currentTarget;
  const conversationId = checkbox.dataset.id;
  const currentIndex = parseInt(checkbox.dataset.index || '', 10);
  if (!conversationId) return;

  list.check(conversationId, currentIndex, e.shiftKey);

  syncSelectionDom();
  updateExportButtonText();
};

const handleSelectAll = (e: Event): void => {
  if (!(e.currentTarget instanceof HTMLInputElement)) return;

  list.checkAll(e.currentTarget.checked);

  syncSelectionDom();
  updateExportButtonText();
};

const updateExportButtonText = (): void => {
  const exportBtn = el<HTMLButtonElement>('exportAllBtn');
  if (!exportBtn) return;

  const count = list.selectedCount();
  exportBtn.textContent =
    count > 0 ? `Export Selected (${count})` : 'Export All';
};

const updateStats = (): void => {
  const stats = el('stats');
  if (!stats) return;
  stats.textContent = `Showing ${list.view().length} of ${list.all().length} conversations (${list.needsExportCount()} new/updated)`;
};

const autoSelectNewUpdated = (): void => {
  // Only the Selection changes here, not the View — same in-place treatment
  // as handleCheckboxChange/handleSelectAll.
  list.selectPending();
  syncSelectionDom();
  updateExportButtonText();
};

// ---------------------------------------------------------------------------
// Export — options gathering, progress modal, Export Records
// ---------------------------------------------------------------------------

const readExportOptions = (): ExportOptions => {
  return {
    artifactFormat: req<HTMLSelectElement>('artifactFormat').value,
    extractArtifacts: req<HTMLInputElement>('extractArtifacts').checked,
    flattenArtifacts: req<HTMLInputElement>('flattenArtifacts').checked,
    format: req<HTMLSelectElement>('exportFormat').value as ExportFormat,
    includeArtifacts: req<HTMLInputElement>('includeArtifacts').checked,
    includeChats: req<HTMLInputElement>('includeChats').checked,
    includeMetadata: req<HTMLInputElement>('includeMetadata').checked,
    includeThinking: req<HTMLInputElement>('includeThinking').checked,
  };
};

interface ProgressModal {
  dispose(): void;
  hide(): void;
  readonly signal: AbortSignal;
  update(progress: ExportProgress): void;
}

/** Drives #progressModal and wires #cancelExport to an AbortController. */
const openProgressModal = (initialText: string): ProgressModal => {
  const modal = req('progressModal');
  const bar = req('progressBar');
  const text = req('progressText');
  const stats = req('progressStats');
  const cancelButton = req<HTMLButtonElement>('cancelExport');

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
      if (progress.phase === 'zipping') {
        text.textContent = 'Creating ZIP file...';
        bar.style.width = `${progress.completed}%`;
        return;
      }
      const done = progress.completed + progress.failed;
      const percent =
        progress.total > 0 ? Math.round((done / progress.total) * 100) : 0;
      bar.style.width = `${percent}%`;
      stats.textContent = `${progress.completed} succeeded, ${progress.failed} failed out of ${progress.total}`;
    },
  };
};

const isAbort = (error: unknown): boolean => {
  return error instanceof DOMException && error.name === 'AbortError';
};

/** Apply a freshly-loaded Export Record book and repaint the table's staleness state. */
const applyExportRecords = (book: ExportRecordBook): void => {
  list.setExportRecords(book);
  displayConversations();
  updateStats();
};

/** The per-row Export button. */
const exportSingle = async (target: ExportTarget): Promise<void> => {
  if (!orgId) {
    showToast('Organization ID not configured', true);
    return;
  }

  const options = readExportOptions();
  showToast(`Exporting ${target.name}...`);

  try {
    const result = await exportConversations(orgId, [target], options, {
      cache: localCache,
    });
    showToast(
      result.artifactCount > 0
        ? `Exported: ${target.name} with ${result.artifactCount} artifact(s)`
        : `Exported: ${target.name}`,
    );
    if (!result.recordsWritten) {
      showToast(
        'Export succeeded, but could not be recorded as exported.',
        true,
      );
    }
    applyExportRecords(await loadExportRecords());
  } catch (error) {
    console.error('Export error:', error);
    showToast(`Failed to export: ${errorMessage(error)}`, true);
  }
};

/** The "Export All" / "Export Selected (N)" button. */
const exportAllFiltered = async (): Promise<void> => {
  if (!orgId) {
    showToast('Organization ID not configured', true);
    return;
  }

  const options = readExportOptions();
  const button = req<HTMLButtonElement>('exportAllBtn');
  const originalButtonText = button.textContent || 'Export All';
  button.disabled = true;
  button.textContent = 'Preparing...';

  // Export ALL selected conversations, even ones currently hidden by the
  // filter — the checkbox is the user's explicit choice, the filter is just a
  // view. The "Export Selected (N)" button text already reflects the full
  // selection count, so users aren't surprised.
  const conversationsToExport =
    list.selectedCount() > 0
      ? list.all().filter((conv) => list.selected().has(conv.uuid))
      : list.view();

  const targets: ExportTarget[] = conversationsToExport.map((conv) => ({
    name: conv.name,
    updatedAt: conv.updated_at,
    uuid: conv.uuid,
  }));

  const single = targets.length === 1;
  const modal = openProgressModal(
    single
      ? `Exporting ${targets[0].name}...`
      : `Exporting ${targets.length} conversations...`,
  );

  try {
    const result = await exportConversations(orgId, targets, options, {
      // The browse page is extension-origin, the same as the background
      // worker, so it shares that IndexedDB and needs no relay.
      cache: localCache,
      signal: modal.signal,
      onProgress: (progress) => modal.update(progress),
    });

    modal.hide();

    const failed = result.failedNames.length;
    const completed = result.exportedIds.length;
    if (single) {
      showToast(
        result.artifactCount > 0
          ? `Exported: ${targets[0].name} with ${result.artifactCount} artifact(s)`
          : `Exported: ${targets[0].name}`,
      );
    } else if (failed > 0) {
      showToast(
        `Exported ${completed} of ${targets.length} conversations (${failed} failed).`,
      );
    } else {
      const cached =
        result.fromCache > 0 ? ` (${result.fromCache} from cache)` : '';
      showToast(
        `Successfully exported all ${completed} conversations!${cached}`,
      );
    }

    // Worth saying because the next export will be slow again, but only after
    // the success message: the file the user asked for is unaffected.
    if (result.cacheQuotaExceeded) {
      showToast(
        'Local storage is full, so conversations are no longer being cached.',
        true,
      );
    }
    if (!result.recordsWritten) {
      showToast(
        'Export succeeded, but could not be recorded as exported.',
        true,
      );
    }

    applyExportRecords(await loadExportRecords());
  } catch (error) {
    modal.hide();
    // A cancel already showed its own toast via the cancel button.
    if (!isAbort(error)) {
      console.error('Export error:', error);
      showToast(`Export failed: ${errorMessage(error)}`, true);
    }
  } finally {
    modal.dispose();
    button.disabled = false;
    button.textContent = originalButtonText;
  }
};

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

const showError = (message: string): void => {
  const tableContent = req('tableContent');
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error';
  errorDiv.textContent = message;
  tableContent.innerHTML = '';
  tableContent.appendChild(errorDiv);
};

const showToast = (message: string, isError = false): void => {
  const toast = el('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.background = isError ? '#d32f2f' : '#333';
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
};

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

const setupEventListeners = (): void => {
  // Handle checkbox dependencies
  const includeChatsCheckbox = req<HTMLInputElement>('includeChats');
  const includeThinkingCheckbox = req<HTMLInputElement>('includeThinking');
  const includeMetadataCheckbox = req<HTMLInputElement>('includeMetadata');
  const includeArtifactsCheckbox = req<HTMLInputElement>('includeArtifacts');

  const updateCheckboxStates = (): void => {
    const chatsEnabled = includeChatsCheckbox.checked;

    // Disable thinking, metadata and inline artifacts when chats is unchecked
    includeThinkingCheckbox.disabled = !chatsEnabled;
    includeMetadataCheckbox.disabled = !chatsEnabled;
    includeArtifactsCheckbox.disabled = !chatsEnabled;

    // Optionally uncheck them when disabled
    if (!chatsEnabled) {
      includeThinkingCheckbox.checked = false;
      includeMetadataCheckbox.checked = false;
      includeArtifactsCheckbox.checked = false;
    }
  };

  includeChatsCheckbox.addEventListener('change', updateCheckboxStates);
  updateCheckboxStates(); // Initialize on load

  // Settings dropdown
  const settingsBtn = req('settingsBtn');
  const settingsDropdown = req('settingsDropdown');

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsDropdown.classList.toggle('open');
    // Update org ID display when opening
    if (settingsDropdown.classList.contains('open')) {
      const orgDisplay = req('orgIdDisplay');
      if (orgId) {
        orgDisplay.textContent = orgId.substring(0, 8) + '...';
        orgDisplay.title = orgId;
      } else {
        orgDisplay.textContent = 'Not set';
      }
      // Update theme label
      const theme =
        document.documentElement.getAttribute('data-theme') || 'dark';
      req('themeLabel').textContent = theme === 'dark' ? 'Dark' : 'Light';
    }
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', () => {
    settingsDropdown.classList.remove('open');
  });
  settingsDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // Theme toggle
  req('themeToggle').addEventListener('click', () => {
    toggleTheme();
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    req('themeLabel').textContent = theme === 'dark' ? 'Dark' : 'Light';
  });

  // Click org ID row to copy full ID to clipboard
  req('settingsOrgId').addEventListener('click', async () => {
    if (!orgId) {
      showToast('No org ID set', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(orgId);
      showToast('Org ID copied to clipboard');
    } catch {
      showToast('Failed to copy org ID', true);
    }
    settingsDropdown.classList.remove('open');
  });

  // Edit org ID — open options in the same tab so the back button returns here
  req('editOrgId').addEventListener('click', () => {
    window.location.href = getExtensionUrl('options.html');
  });

  // Advanced Options — open options in the same tab so the back button returns here
  req('advancedOptions').addEventListener('click', () => {
    window.location.href = getExtensionUrl('options.html');
  });

  // Mark all as exported
  req('markAllExported').addEventListener('click', async () => {
    const ids = list.all().map((c) => c.uuid);
    applyExportRecords(await markExported(ids));
    settingsDropdown.classList.remove('open');
    showToast(`Marked ${ids.length} conversations as exported`);
  });

  // Mark all as new
  req('markAllNew').addEventListener('click', async () => {
    applyExportRecords(await clearExportRecords());
    list.clearSelection();
    autoSelectNewUpdated();
    settingsDropdown.classList.remove('open');
    showToast('All conversations marked as new');
  });

  // Backup / Restore Database submenu — shared logic lives in features/backup
  req('backupData').addEventListener('click', async () => {
    settingsDropdown.classList.remove('open');
    const { message, success } = await backupExtensionData();
    showToast(message, !success);
  });

  // Import flow: mode-choice modal → file picker → import.
  // pendingImportMode bridges the async file-picker boundary.
  let pendingImportMode: ImportMode | null = null;

  const restoreFileBrowse = req<HTMLInputElement>('restoreFileBrowse');

  req('restoreData').addEventListener('click', async () => {
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

  // Search input
  const searchInput = req<HTMLInputElement>('searchInput');
  const searchBox = req('searchBox');
  searchInput.addEventListener('input', () => {
    searchBox.classList.toggle('has-text', !!searchInput.value);
    list.setSearch(searchInput.value);
    displayConversations();
    updateStats();
  });

  // Clear search
  req('clearSearch').addEventListener('click', () => {
    searchInput.value = '';
    searchBox.classList.remove('has-text');
    list.setSearch('');
    displayConversations();
    updateStats();
  });

  // Filter dropdown
  const filterBtn = req('filterBtn');
  const filterDropdown = req('filterDropdown');

  filterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    filterDropdown.classList.toggle('open');
  });

  document.addEventListener('click', () => {
    filterDropdown.classList.remove('open');
  });
  filterDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  document.querySelectorAll<HTMLElement>('.filter-option').forEach((option) => {
    option.addEventListener('click', () => {
      const statusFilter = asStatusFilter(option.dataset.value);
      list.setStatusFilter(statusFilter);
      // Update selected state
      document
        .querySelectorAll('.filter-option')
        .forEach((o) => o.classList.remove('selected'));
      option.classList.add('selected');
      // Search bar placeholder reflects the active scope
      searchInput.placeholder = list.searchPlaceholder();
      // Update button state
      filterBtn.classList.toggle('active', statusFilter !== 'all');
      filterDropdown.classList.remove('open');
      displayConversations();
      updateStats();
    });
  });

  // Set initial selected state
  document
    .querySelector('.filter-option[data-value="all"]')
    ?.classList.add('selected');

  // Export all button
  req('exportAllBtn').addEventListener('click', () => {
    void exportAllFiltered();
  });
};

export {};
