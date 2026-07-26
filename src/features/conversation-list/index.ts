// The browse table's business logic, extracted so it is testable without a
// DOM: filtering, the multi-key sort stack, and the Selection (per
// CONTEXT.md: the set of Conversations the user has picked for the next
// Export) and its shift-range math. Rendering stays in the browse entrypoint;
// this module is pure state + logic — no DOM, no storage, no `chrome`.

import type { ConversationSummary } from './types';
import type { ExportRecordBook, DisplayModel } from '../tracking';
import { emptyExportRecords } from '../tracking';
import { formatModelName } from '../models';

type SortField = 'name' | 'project' | 'created' | 'updated' | 'model';
type SortDirection = 'asc' | 'desc';
interface SortCriterion {
  field: SortField;
  direction: SortDirection;
}

type StatusFilter = 'all' | 'new' | 'exported' | 'projects';

/** Default sort, used until the user clicks a column header. */
const DEFAULT_SORT: SortCriterion = { field: 'updated', direction: 'desc' };

/**
 * Something with a display() method for resolving a Conversation's model.
 * The extra fields are optional so this stays satisfied both by a plain
 * `{ model }` resolver (as sortValue only needs) and by tracking's full
 * ModelDisplayBook (whose DisplayModel always carries them) — list.display()
 * passes whichever shape it was given straight through to the renderer.
 */
interface ModelResolver {
  display(conv: ConversationSummary): {
    model: string;
    bounced?: boolean;
    other?: string;
    otherLabel?: DisplayModel['otherLabel'];
  };
}

function emptyModelResolver(): ModelResolver {
  return {
    display(conv) {
      return { model: conv.model || '' };
    },
  };
}

// Three-way key fallback for the project id a Conversation carries, and the
// '-' sentinel for "no project" — which deliberately leaks into filtering and
// sort keys below.
function getProjectName(conv: ConversationSummary, projectsMap: Record<string, string>): string {
  const projectId =
    (typeof conv.project_uuid === 'string' ? conv.project_uuid : undefined) ||
    (typeof conv.project_id === 'string' ? conv.project_id : undefined) ||
    (typeof conv.projectUuid === 'string' ? conv.projectUuid : undefined);
  if (!projectId) return '-';
  return projectsMap[projectId] || '-';
}

interface ConversationList {
  setConversations(convs: ConversationSummary[]): void;
  setProjects(projectsMap: Record<string, string>): void;
  setExportRecords(book: ExportRecordBook): void;
  setModels(book: ModelResolver): void;
  setSearch(query: string): void;
  setStatusFilter(filter: StatusFilter): void;
  toggleSort(field: SortField): void;
  sortIndicator(field: SortField): string;
  view(): readonly ConversationSummary[];
  all(): readonly ConversationSummary[];
  projectName(conv: ConversationSummary): string;
  isStale(conv: ConversationSummary): boolean;
  display(conv: ConversationSummary): ReturnType<ModelResolver['display']>;
  check(uuid: string, index: number, shiftHeld: boolean): void;
  checkAll(checked: boolean): void;
  selectStale(): void;
  clearSelection(): void;
  selected(): ReadonlySet<string>;
  selectedCount(): number;
  staleCount(): number;
  allViewSelected(): boolean;
  searchPlaceholder(): string;
}

function createConversationList(): ConversationList {
  let allConversations: ConversationSummary[] = [];
  let viewConversations: ConversationSummary[] = [];
  let projectsMap: Record<string, string> = {};
  let exportRecords: ExportRecordBook = emptyExportRecords();
  let models: ModelResolver = emptyModelResolver();
  let search = '';
  let statusFilter: StatusFilter = 'all';
  let sortStack: SortCriterion[] = [];
  const selectedUuids = new Set<string>();
  let lastCheckedIndex: number | null = null;

  function sortValue(conv: ConversationSummary, field: SortField): string | number {
    switch (field) {
      case 'name':
        return conv.name.toLowerCase();
      case 'project':
        return getProjectName(conv, projectsMap).toLowerCase();
      case 'created':
        return new Date(conv.created_at).getTime();
      case 'updated':
        return new Date(conv.updated_at).getTime();
      case 'model':
        return formatModelName(models.display(conv).model).toLowerCase();
    }
  }

  function sortView(): void {
    // If sortStack is empty, fall back to the default sort
    if (sortStack.length === 0) {
      sortStack = [{ ...DEFAULT_SORT }];
    }

    viewConversations.sort((a, b) => {
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

  function recompute(): void {
    viewConversations = allConversations.filter((conv) => {
      // 'projects' mode: search scope becomes the project name, status filters do not apply
      if (statusFilter === 'projects') {
        if (!search) return true;
        const projectName = getProjectName(conv, projectsMap);
        return projectName !== '-' && projectName.toLowerCase().includes(search);
      }

      const summary = typeof conv.summary === 'string' ? conv.summary : undefined;
      const matchesSearch =
        !search || conv.name.toLowerCase().includes(search) || (!!summary && summary.toLowerCase().includes(search));

      let matchesStatus = true;
      if (statusFilter === 'new') {
        matchesStatus = exportRecords.isStale(conv);
      } else if (statusFilter === 'exported') {
        matchesStatus = !exportRecords.isStale(conv);
      }

      return matchesSearch && matchesStatus;
    });

    sortView();

    // Reset last checked index when the view changes.
    lastCheckedIndex = null;
  }

  return {
    setConversations(convs) {
      allConversations = convs;
      recompute();
    },
    setProjects(map) {
      projectsMap = map;
      recompute();
    },
    setExportRecords(book) {
      // Deliberately does NOT recompute the View. An Export Record only
      // changes a row's staleness dot, not whether it belongs in the current
      // filter/search/sort result — the View stays put (and lastCheckedIndex
      // stays valid) until the user next touches the filter or search.
      exportRecords = book;
    },
    setModels(book) {
      models = book;
      recompute();
    },
    setSearch(query) {
      search = query.toLowerCase();
      recompute();
    },
    setStatusFilter(filter) {
      statusFilter = filter;
      recompute();
    },
    toggleSort(field) {
      const existingIndex = sortStack.findIndex((s) => s.field === field);

      if (existingIndex === 0) {
        // Clicking primary sort: toggle direction
        sortStack[0]!.direction = sortStack[0]!.direction === 'asc' ? 'desc' : 'asc';
      } else if (existingIndex > 0) {
        // Clicking a secondary sort: move it to primary position
        const [criterion] = sortStack.splice(existingIndex, 1);
        sortStack.unshift(criterion!);
      } else {
        // New sort: add to front with ascending direction
        sortStack.unshift({ field, direction: 'asc' });
      }

      recompute();
    },
    sortIndicator(field) {
      const sortIndex = sortStack.findIndex((s) => s.field === field);

      // Only show indicator for the primary (most recent) sort
      if (sortIndex !== 0) return '';

      const { direction } = sortStack[sortIndex]!;
      const primaryArrow = direction === 'asc' ? '↑' : '↓';
      const secondaryArrow = direction === 'asc' ? '↓' : '↑';

      return ` <span class="sort-indicator">${primaryArrow}<sub>${secondaryArrow}</sub></span>`;
    },
    view() {
      return viewConversations;
    },
    all() {
      return allConversations;
    },
    projectName(conv) {
      return getProjectName(conv, projectsMap);
    },
    isStale(conv) {
      return exportRecords.isStale(conv);
    },
    display(conv) {
      return models.display(conv);
    },
    check(uuid, index, shiftHeld) {
      if (shiftHeld && lastCheckedIndex !== null) {
        const start = Math.min(lastCheckedIndex, index);
        const end = Math.max(lastCheckedIndex, index);
        // Range selection follows the *target* checkbox's resulting state:
        // if it ends up checked, the whole range is selected; otherwise the
        // whole range is cleared.
        const isChecking = !selectedUuids.has(uuid);
        for (let i = start; i <= end; i++) {
          const conv = viewConversations[i];
          if (!conv) continue;
          if (isChecking) {
            selectedUuids.add(conv.uuid);
          } else {
            selectedUuids.delete(conv.uuid);
          }
        }
      } else {
        if (selectedUuids.has(uuid)) {
          selectedUuids.delete(uuid);
        } else {
          selectedUuids.add(uuid);
        }
      }

      lastCheckedIndex = index;
    },
    checkAll(checked) {
      if (checked) {
        for (const conv of viewConversations) selectedUuids.add(conv.uuid);
      } else {
        selectedUuids.clear();
      }
      // Reset last checked index when using select all
      lastCheckedIndex = null;
    },
    selectStale() {
      selectedUuids.clear();
      for (const conv of viewConversations) {
        if (exportRecords.isStale(conv)) selectedUuids.add(conv.uuid);
      }
    },
    clearSelection() {
      selectedUuids.clear();
    },
    selected() {
      return selectedUuids;
    },
    selectedCount() {
      return selectedUuids.size;
    },
    staleCount() {
      return exportRecords.staleCount(allConversations);
    },
    allViewSelected() {
      // Checked when ANY are selected — not indeterminate, not "every row in
      // the view". Matches the original updateSelectAllCheckbox exactly.
      return selectedUuids.size > 0;
    },
    searchPlaceholder() {
      return statusFilter === 'projects' ? 'Search projects by name...' : 'Search conversations by name...';
    },
  };
}

export { createConversationList, getProjectName };
export type { ConversationList, SortField, StatusFilter };
