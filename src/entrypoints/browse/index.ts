// Browse page entrypoint — UI wiring only.
//
// Every piece of business logic here lives in features/: the export pipeline
// (features/export), Export Records and model snapshots (features/tracking),
// claude.ai HTTP (features/conversation/api), backup (features/backup).
// This file owns the table, the filters, the selection, the progress modal
// and the toast — nothing else.

import {
  getExtensionUrl,
  hasClaudeAccess,
  requestClaudeAccess,
  storageGet,
  storageSet,
} from '../../platform';
import { detectOrgId, fetchConversationList, fetchProjects } from '../../features/conversation/api';
import type { Project } from '../../features/conversation/api';
import type {
  ArtifactFormat,
  ConversationSummary,
  ExportFormat,
} from '../../features/conversation/types';
import { localCache } from '../../features/cache';
import { exportConversations } from '../../features/export';
import type { ExportOptions, ExportProgress, ExportTarget } from '../../features/export';
import {
  getDisplayModel,
  recordModelSnapshots,
  isStale,
  loadExportRecords,
  loadModelSnapshots,
  recordExports,
} from '../../features/tracking';
import type { ExportRecords, ModelSnapshots } from '../../features/tracking';
import { formatModelName, getModelBadgeClass, inferModel } from '../../features/models';
import { backupExtensionData, importBackup, showImportModeModal } from '../../features/backup';
import type { ImportMode } from '../../features/backup';
import { initErrorCapture } from '../../features/diagnostics';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** For elements browse.html guarantees. Throws loudly if the markup drifts. */
function req<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id) as T | null;
  if (!found) throw new Error(`browse.html is missing #${id}`);
  return found;
}

function escapeHtml(str: string | null | undefined): string {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function initTheme(): void {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme);
  } else {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  }
}

function toggleTheme(): void {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type SortField = 'name' | 'project' | 'created' | 'updated' | 'model';
type SortDirection = 'asc' | 'desc';
interface SortCriterion {
  field: SortField;
  direction: SortDirection;
}

type StatusFilter = 'all' | 'new' | 'exported' | 'projects';

/** Default sort, used until the user clicks a column header. */
const DEFAULT_SORT: SortCriterion = { field: 'updated', direction: 'desc' };

let allConversations: ConversationSummary[] = [];
let filteredConversations: ConversationSummary[] = [];
let projectsMap: Record<string, string> = {};
let orgId: string | null = null;
let sortStack: SortCriterion[] = [];
const selectedConversations = new Set<string>();
let lastCheckedIndex: number | null = null;
let exportRecords: ExportRecords = {};
let modelSnapshots: ModelSnapshots = {};
let statusFilter: StatusFilter = 'all';
let dateFormat: 'mdy' | 'dmy' = 'mdy';
let timeFormat: '12h' | '24h' = '12h';
let modelDisplay: 'original' | 'current' = 'original';

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

async function loadDateTimePrefs(): Promise<void> {
  const result = await storageGet<{ dateFormat?: string; timeFormat?: string }>('local', [
    'dateFormat',
    'timeFormat',
  ]);
  dateFormat = result.dateFormat === 'dmy' ? 'dmy' : 'mdy';
  timeFormat = result.timeFormat === '24h' ? '24h' : '12h';
}

async function loadModelDisplayPref(): Promise<void> {
  const result = await storageGet<{ modelDisplay?: string }>('local', ['modelDisplay']);
  modelDisplay = result.modelDisplay === 'current' ? 'current' : 'original';
}

function formatDate(dt: Date): string {
  const m = dt.getMonth() + 1;
  const d = dt.getDate();
  const y = dt.getFullYear();
  return dateFormat === 'dmy' ? `${d}/${m}/${y}` : `${m}/${d}/${y}`;
}

function formatTime(dt: Date): string {
  if (timeFormat === '24h') {
    return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
}

function isNewOrUpdated(conv: ConversationSummary): boolean {
  return isStale(conv, exportRecords);
}

/**
 * features/tracking#getDisplayModel answers only "which model, and was it
 * bounced". The table additionally shows the *other* model in a tooltip, so
 * that half is reconstructed here from the same snapshot data.
 */
interface DisplayModelWithTooltip {
  model: string;
  bounced: boolean;
  other: string;
  otherLabel: string;
}

function displayModelWithTooltip(conv: ConversationSummary): DisplayModelWithTooltip {
  const { model, bounced } = getDisplayModel(conv, modelSnapshots, modelDisplay);
  const snap = modelSnapshots[conv.uuid];
  if (snap && snap.firstSeen) {
    const useCurrent = modelDisplay === 'current';
    return {
      model,
      bounced,
      other: useCurrent ? snap.firstSeen : snap.current || snap.firstSeen,
      otherLabel: useCurrent ? 'Originally' : 'Currently',
    };
  }
  return { model, bounced, other: conv.model || '', otherLabel: '' };
}

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
  exportRecords = await loadExportRecords();
  modelSnapshots = await loadModelSnapshots();
  await loadDateTimePrefs();
  await loadModelDisplayPref();
  const elapsed = Date.now() - loadingStart;
  if (elapsed < 1000) await new Promise((r) => setTimeout(r, 1000 - elapsed));
  const loadingText = el('loadingText');
  if (loadingText) loadingText.textContent = 'Loading conversations...';
  await loadConversations();
});

async function hasClaudeAccessSafely(): Promise<boolean> {
  try {
    return await hasClaudeAccess();
  } catch {
    // A browser that can't answer the question must not be blocked on it.
    return true;
  }
}

function showPermissionNotice(): void {
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
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

// Load organization ID — auto-detect first, fall back to stored
async function loadOrgId(): Promise<void> {
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

  const stored = await storageGet<{ organizationId?: string }>('sync', ['organizationId']);
  orgId = stored.organizationId || null;
  if (!orgId) {
    showError(
      'Organization ID not configured. Please open a claude.ai tab and reload this page, or configure it manually in the extension options.'
    );
  }
}

async function loadProjects(): Promise<void> {
  if (!orgId) return;
  try {
    const projects: Project[] = await fetchProjects(orgId);
    projectsMap = {};
    projects.forEach((project) => {
      const projectId = project.uuid || project.id;
      const projectName = project.name || project.title || 'Untitled Project';
      if (projectId) projectsMap[projectId] = projectName;
    });
  } catch (error) {
    console.warn('Error loading projects:', error);
  }
}

async function loadConversations(): Promise<void> {
  if (!orgId) return;

  try {
    // Load projects first so the Project column resolves on the first render
    await loadProjects();

    const conversations = await fetchConversationList(orgId);

    // Best-effort: snapshot recording must never block rendering
    try {
      await recordModelSnapshots(conversations);
    } catch (error) {
      console.error('Error recording model snapshots:', error);
    }

    // Infer models for conversations with null model
    allConversations = conversations.map((conv) => ({
      ...conv,
      model: inferModel(conv as Parameters<typeof inferModel>[0]),
    }));

    applyFiltersAndSort();
  } catch (error) {
    console.error('Error loading conversations:', error);
    showError(`Failed to load conversations: ${errorMessage(error)}`);
  }
}

function getProjectName(conversation: ConversationSummary): string {
  const projectId =
    (conversation.project_uuid as string | null | undefined) ||
    (conversation.project_id as string | null | undefined) ||
    (conversation.projectUuid as string | null | undefined);
  if (!projectId) return '-';
  return projectsMap[projectId] || '-';
}

// ---------------------------------------------------------------------------
// Filtering & sorting
// ---------------------------------------------------------------------------

function applyFiltersAndSort(): void {
  const searchTerm = req<HTMLInputElement>('searchInput').value.toLowerCase();

  filteredConversations = allConversations.filter((conv) => {
    // 'projects' mode: search scope becomes the project name, status filters do not apply
    if (statusFilter === 'projects') {
      if (!searchTerm) return true;
      const projectName = getProjectName(conv);
      return projectName !== '-' && projectName.toLowerCase().includes(searchTerm);
    }

    const summary = conv.summary as string | null | undefined;
    const matchesSearch =
      !searchTerm ||
      conv.name.toLowerCase().includes(searchTerm) ||
      (!!summary && summary.toLowerCase().includes(searchTerm));

    let matchesStatus = true;
    if (statusFilter === 'new') {
      matchesStatus = isNewOrUpdated(conv);
    } else if (statusFilter === 'exported') {
      matchesStatus = !isNewOrUpdated(conv);
    }

    return matchesSearch && matchesStatus;
  });

  sortConversations();

  // Reset last checked index when list changes
  lastCheckedIndex = null;

  displayConversations();
  updateStats();
}

function sortValue(conv: ConversationSummary, field: SortField): string | number {
  switch (field) {
    case 'name':
      return conv.name.toLowerCase();
    case 'project':
      return getProjectName(conv).toLowerCase();
    case 'created':
      return new Date(conv.created_at).getTime();
    case 'updated':
      return new Date(conv.updated_at).getTime();
    case 'model':
      return formatModelName(
        getDisplayModel(conv, modelSnapshots, modelDisplay).model
      ).toLowerCase();
  }
}

function sortConversations(): void {
  // If sortStack is empty, fall back to the default sort
  if (sortStack.length === 0) {
    sortStack = [{ ...DEFAULT_SORT }];
  }

  filteredConversations.sort((a, b) => {
    // Try each sort criterion in order until we find a difference
    for (const { field, direction } of sortStack) {
      const aVal = sortValue(a, field);
      const bVal = sortValue(b, field);

      let comparison = 0;
      if (aVal > bVal) comparison = 1;
      else if (aVal < bVal) comparison = -1;

      if (comparison !== 0) {
        return direction === 'asc' ? comparison : -comparison;
      }
    }
    return 0;
  });
}

function handleColumnSort(field: SortField): void {
  const existingIndex = sortStack.findIndex((s) => s.field === field);

  if (existingIndex === 0) {
    // Clicking primary sort: toggle direction
    sortStack[0]!.direction = sortStack[0]!.direction === 'asc' ? 'desc' : 'asc';
  } else if (existingIndex > 0) {
    // Clicking a secondary sort: move it to primary position
    const [sortCriterion] = sortStack.splice(existingIndex, 1);
    sortStack.unshift(sortCriterion!);
  } else {
    // New sort: add to front with ascending direction
    sortStack.unshift({ field, direction: 'asc' });
  }

  applyFiltersAndSort();
}

function getSortIndicator(field: SortField): string {
  const sortIndex = sortStack.findIndex((s) => s.field === field);

  // Only show indicator for the primary (most recent) sort
  if (sortIndex !== 0) return '';

  const { direction } = sortStack[sortIndex]!;
  const primaryArrow = direction === 'asc' ? '↑' : '↓';
  const secondaryArrow = direction === 'asc' ? '↓' : '↑';

  return ` <span class="sort-indicator">${primaryArrow}<sub>${secondaryArrow}</sub></span>`;
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

function displayConversations(): void {
  const tableContent = req('tableContent');

  if (filteredConversations.length === 0) {
    tableContent.innerHTML = '<div class="no-results">No conversations found</div>';
    return;
  }

  let html = `
    <table>
      <thead>
        <tr>
          <th class="sortable" data-sort="name">Name${getSortIndicator('name')}</th>
          <th class="sortable" data-sort="project">Project${getSortIndicator('project')}</th>
          <th class="sortable" data-sort="updated">Updated${getSortIndicator('updated')}</th>
          <th class="sortable" data-sort="created">Created${getSortIndicator('created')}</th>
          <th class="sortable" data-sort="model">Model${getSortIndicator('model')}</th>
          <th>Actions</th>
          <th class="checkbox-col">
            <input type="checkbox" id="selectAll" class="select-all-checkbox" ${selectedConversations.size > 0 ? 'checked' : ''}>
          </th>
        </tr>
      </thead>
      <tbody>
  `;

  filteredConversations.forEach((conv, index) => {
    const updatedDt = new Date(conv.updated_at);
    const createdDt = new Date(conv.created_at);
    const updatedDate = formatDate(updatedDt);
    const updatedTime = formatTime(updatedDt);
    const createdDate = formatDate(createdDt);
    const createdTime = formatTime(createdDt);
    const modelInfo = displayModelWithTooltip(conv);
    const modelBadgeClass = getModelBadgeClass(modelInfo.model);
    const projectName = getProjectName(conv);

    const newUpdated = isNewOrUpdated(conv);
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
          <input type="checkbox" class="conversation-checkbox" data-id="${escapeHtml(conv.uuid)}" data-index="${index}" ${selectedConversations.has(conv.uuid) ? 'checked' : ''}>
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
      const conv = allConversations.find((candidate) => candidate.uuid === id);
      void exportSingle({
        uuid: id,
        name: btn.dataset.name || id,
        updatedAt: conv?.updated_at,
      });
    });
  });

  // Use 'click' rather than 'change' so the shift key is observable
  document.querySelectorAll<HTMLInputElement>('.conversation-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('click', handleCheckboxChange);
  });

  const selectAllCheckbox = el<HTMLInputElement>('selectAll');
  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener('click', handleSelectAll);
  }

  document.querySelectorAll<HTMLElement>('.sortable').forEach((header) => {
    header.addEventListener('click', () => {
      const field = header.dataset.sort;
      if (field) handleColumnSort(field as SortField);
    });
  });

  updateExportButtonText();

  const exportAllBtn = el<HTMLButtonElement>('exportAllBtn');
  if (exportAllBtn) exportAllBtn.disabled = false;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function handleCheckboxChange(e: MouseEvent): void {
  const checkbox = e.currentTarget as HTMLInputElement;
  const conversationId = checkbox.dataset.id;
  const currentIndex = parseInt(checkbox.dataset.index || '', 10);

  // Handle shift+click for range selection
  if (e.shiftKey && lastCheckedIndex !== null) {
    const start = Math.min(lastCheckedIndex, currentIndex);
    const end = Math.max(lastCheckedIndex, currentIndex);

    const checkboxes = document.querySelectorAll<HTMLInputElement>('.conversation-checkbox');
    const isChecking = checkbox.checked;

    for (let i = start; i <= end; i++) {
      const cb = checkboxes[i];
      if (!cb) continue;
      cb.checked = isChecking;
      const id = cb.dataset.id;
      if (!id) continue;
      if (isChecking) {
        selectedConversations.add(id);
      } else {
        selectedConversations.delete(id);
      }
    }
  } else if (conversationId) {
    // Normal single checkbox toggle
    if (checkbox.checked) {
      selectedConversations.add(conversationId);
    } else {
      selectedConversations.delete(conversationId);
    }
  }

  lastCheckedIndex = currentIndex;

  updateExportButtonText();
  updateSelectAllCheckbox();
}

function handleSelectAll(e: Event): void {
  const target = e.currentTarget as HTMLInputElement;
  const checkboxes = document.querySelectorAll<HTMLInputElement>('.conversation-checkbox');

  if (target.checked) {
    // Select all visible conversations
    checkboxes.forEach((checkbox) => {
      checkbox.checked = true;
      if (checkbox.dataset.id) selectedConversations.add(checkbox.dataset.id);
    });
  } else {
    // Deselect all
    checkboxes.forEach((checkbox) => {
      checkbox.checked = false;
    });
    selectedConversations.clear();
  }

  // Reset last checked index when using select all
  lastCheckedIndex = null;

  updateExportButtonText();
}

function updateSelectAllCheckbox(): void {
  const selectAllCheckbox = el<HTMLInputElement>('selectAll');
  if (!selectAllCheckbox) return;

  // Show header checkbox as checked when any conversations are selected
  selectAllCheckbox.checked = selectedConversations.size > 0;
}

function updateExportButtonText(): void {
  const exportBtn = el<HTMLButtonElement>('exportAllBtn');
  if (!exportBtn) return;

  exportBtn.textContent =
    selectedConversations.size > 0
      ? `Export Selected (${selectedConversations.size})`
      : 'Export All';
}

function updateStats(): void {
  const stats = el('stats');
  if (!stats) return;
  const newCount = allConversations.filter((c) => isNewOrUpdated(c)).length;
  stats.textContent = `Showing ${filteredConversations.length} of ${allConversations.length} conversations (${newCount} new/updated)`;
}

function autoSelectNewUpdated(): void {
  selectedConversations.clear();
  filteredConversations.forEach((conv) => {
    if (isNewOrUpdated(conv)) {
      selectedConversations.add(conv.uuid);
    }
  });
  displayConversations();
  updateExportButtonText();
}

// ---------------------------------------------------------------------------
// Export — options gathering, progress modal, Export Records
// ---------------------------------------------------------------------------

function readExportOptions(): ExportOptions {
  return {
    format: req<HTMLSelectElement>('exportFormat').value as ExportFormat,
    includeChats: req<HTMLInputElement>('includeChats').checked,
    includeThinking: req<HTMLInputElement>('includeThinking').checked,
    includeMetadata: req<HTMLInputElement>('includeMetadata').checked,
    includeArtifacts: req<HTMLInputElement>('includeArtifacts').checked,
    extractArtifacts: req<HTMLInputElement>('extractArtifacts').checked,
    artifactFormat: req<HTMLSelectElement>('artifactFormat').value as ArtifactFormat,
    flattenArtifacts: req<HTMLInputElement>('flattenArtifacts').checked,
  };
}

interface ProgressModal {
  hide(): void;
  update(progress: ExportProgress): void;
  readonly signal: AbortSignal;
  dispose(): void;
}

/** Drives #progressModal and wires #cancelExport to an AbortController. */
function openProgressModal(initialText: string): ProgressModal {
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
    update(progress: ExportProgress) {
      if (progress.phase === 'zipping') {
        text.textContent = 'Creating ZIP file...';
        bar.style.width = `${progress.completed}%`;
        return;
      }
      const done = progress.completed + progress.failed;
      const percent = progress.total > 0 ? Math.round((done / progress.total) * 100) : 0;
      bar.style.width = `${percent}%`;
      stats.textContent = `${progress.completed} succeeded, ${progress.failed} failed out of ${progress.total}`;
    },
    signal: controller.signal,
    dispose() {
      cancelButton.removeEventListener('click', onCancel);
    },
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Refresh Export Records from storage and repaint the table's staleness state. */
async function refreshExportRecords(): Promise<void> {
  exportRecords = await loadExportRecords();
  displayConversations();
  updateStats();
}

/** The per-row Export button. */
async function exportSingle(target: ExportTarget): Promise<void> {
  if (!orgId) {
    showToast('Organization ID not configured', true);
    return;
  }

  const options = readExportOptions();
  showToast(`Exporting ${target.name}...`);

  try {
    const result = await exportConversations(orgId, [target], options, { cache: localCache });
    // exportConversations never writes Export Records — that is the caller's job.
    await recordExports(result.exportedIds);
    showToast(
      result.artifactCount > 0
        ? `Exported: ${target.name} with ${result.artifactCount} artifact(s)`
        : `Exported: ${target.name}`
    );
    await refreshExportRecords();
  } catch (error) {
    console.error('Export error:', error);
    showToast(`Failed to export: ${errorMessage(error)}`, true);
  }
}

/** The "Export All" / "Export Selected (N)" button. */
async function exportAllFiltered(): Promise<void> {
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
    selectedConversations.size > 0
      ? allConversations.filter((conv) => selectedConversations.has(conv.uuid))
      : filteredConversations;

  const targets: ExportTarget[] = conversationsToExport.map((conv) => ({
    uuid: conv.uuid,
    name: conv.name,
    updatedAt: conv.updated_at,
  }));

  const single = targets.length === 1;
  const modal = openProgressModal(
    single ? `Exporting ${targets[0]!.name}...` : `Exporting ${targets.length} conversations...`
  );

  try {
    const result = await exportConversations(orgId, targets, options, {
      onProgress: (progress) => modal.update(progress),
      signal: modal.signal,
      // The browse page is extension-origin, the same as the background
      // worker, so it shares that IndexedDB and needs no relay.
      cache: localCache,
    });

    modal.hide();

    await recordExports(result.exportedIds);

    const failed = result.failedNames.length;
    const completed = result.exportedIds.length;
    if (single) {
      showToast(
        result.artifactCount > 0
          ? `Exported: ${targets[0]!.name} with ${result.artifactCount} artifact(s)`
          : `Exported: ${targets[0]!.name}`
      );
    } else if (failed > 0) {
      showToast(`Exported ${completed} of ${targets.length} conversations (${failed} failed).`);
    } else {
      const cached = result.fromCache > 0 ? ` (${result.fromCache} from cache)` : '';
      showToast(`Successfully exported all ${completed} conversations!${cached}`);
    }

    // Worth saying because the next export will be slow again, but only after
    // the success message: the file the user asked for is unaffected.
    if (result.cacheQuotaExceeded) {
      showToast('Local storage is full, so conversations are no longer being cached.', true);
    }

    await refreshExportRecords();
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
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function showError(message: string): void {
  const tableContent = req('tableContent');
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error';
  errorDiv.textContent = message;
  tableContent.innerHTML = '';
  tableContent.appendChild(errorDiv);
}

function showToast(message: string, isError = false): void {
  const toast = el('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.background = isError ? '#d32f2f' : '#333';
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function setupEventListeners(): void {
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
      const theme = document.documentElement.getAttribute('data-theme') || 'dark';
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
    const ids = allConversations.map((c) => c.uuid);
    await recordExports(ids);
    await refreshExportRecords();
    settingsDropdown.classList.remove('open');
    showToast(`Marked ${ids.length} conversations as exported`);
  });

  // Mark all as new
  req('markAllNew').addEventListener('click', async () => {
    exportRecords = {};
    await storageSet('local', { exportTimestamps: {} });
    selectedConversations.clear();
    autoSelectNewUpdated();
    updateStats();
    settingsDropdown.classList.remove('open');
    showToast('All conversations marked as new');
  });

  // Backup / Restore Database submenu — shared logic lives in features/backup
  req('backupData').addEventListener('click', async () => {
    settingsDropdown.classList.remove('open');
    const { success, message } = await backupExtensionData();
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
    const { success, message } = await importBackup(file, mode);
    showToast(message, !success);
  });

  // Search input
  const searchInput = req<HTMLInputElement>('searchInput');
  const searchBox = req('searchBox');
  searchInput.addEventListener('input', () => {
    searchBox.classList.toggle('has-text', !!searchInput.value);
    applyFiltersAndSort();
  });

  // Clear search
  req('clearSearch').addEventListener('click', () => {
    searchInput.value = '';
    searchBox.classList.remove('has-text');
    applyFiltersAndSort();
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
      statusFilter = (option.dataset.value || 'all') as StatusFilter;
      // Update selected state
      document.querySelectorAll('.filter-option').forEach((o) => o.classList.remove('selected'));
      option.classList.add('selected');
      // Search bar placeholder reflects the active scope
      searchInput.placeholder =
        statusFilter === 'projects'
          ? 'Search projects by name...'
          : 'Search conversations by name...';
      // Update button state
      filterBtn.classList.toggle('active', statusFilter !== 'all');
      filterDropdown.classList.remove('open');
      applyFiltersAndSort();
    });
  });

  // Set initial selected state
  document.querySelector('.filter-option[data-value="all"]')?.classList.add('selected');

  // Export all button
  req('exportAllBtn').addEventListener('click', () => {
    void exportAllFiltered();
  });
}

export {};
