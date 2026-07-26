// The browse table's view-model over Conversations: filtering, search, the
// multi-key sort stack, and the Selection (per CONTEXT.md: the set of
// Conversations the user has picked for the next Export) and its shift-range
// math. Rendering stays in the browse entrypoint;
// this module is pure state + logic — no DOM, no storage, no `chrome`.

import type { ConversationSummary } from '$features/conversation/types';
import { formatModelName } from '$features/models';
import type { DisplayModel, ExportRecordBook } from '$features/tracking';
import { emptyExportRecords } from '$features/tracking';

type SortField = 'created' | 'model' | 'name' | 'project' | 'updated';
type SortDirection = 'asc' | 'desc';
interface SortCriterion {
  direction: SortDirection;
  field: SortField;
}

type StatusFilter = 'all' | 'exported' | 'new' | 'projects';

/** Default sort, used until the user clicks a column header. */
const DEFAULT_SORT: SortCriterion = { direction: 'desc', field: 'updated' };

/**
 * Something with a display() method for resolving a Conversation's model.
 * The extra fields are optional so this stays satisfied both by a plain
 * `{ model }` resolver (as sortValue only needs) and by tracking's full
 * ModelDisplayBook (whose DisplayModel always carries them) — list.display()
 * passes whichever shape it was given straight through to the renderer.
 */
interface ModelResolver {
  display(conv: ConversationSummary): {
    bounced?: boolean;
    model: string;
    other?: string;
    otherLabel?: DisplayModel['otherLabel'];
  };
}

const emptyModelResolver = (): ModelResolver => {
  return {
    display(conv) {
      return { model: conv.model || '' };
    },
  };
};

// Three-way key fallback for the project id a Conversation carries, and the
// '-' sentinel for "no project" — which deliberately leaks into filtering and
// sort keys below.
const getProjectName = (
  conv: ConversationSummary,
  projectsMap: Record<string, string>,
): string => {
  const projectId =
    (typeof conv.project_uuid === 'string' ? conv.project_uuid : undefined) ||
    (typeof conv.project_id === 'string' ? conv.project_id : undefined) ||
    (typeof conv.projectUuid === 'string' ? conv.projectUuid : undefined);
  if (!projectId) return '-';
  return projectsMap[projectId] || '-';
};

interface ConversationList {
  all(): readonly ConversationSummary[];
  allViewSelected(): boolean;
  check(uuid: string, index: number, shiftHeld: boolean): void;
  checkAll(checked: boolean): void;
  clearSelection(): void;
  display(conv: ConversationSummary): ReturnType<ModelResolver['display']>;
  isStale(conv: ConversationSummary): boolean;
  projectName(conv: ConversationSummary): string;
  searchPlaceholder(): string;
  selected(): ReadonlySet<string>;
  selectedCount(): number;
  selectStale(): void;
  setConversations(convs: ConversationSummary[]): void;
  setExportRecords(book: ExportRecordBook): void;
  setModels(book: ModelResolver): void;
  setProjects(projectsMap: Record<string, string>): void;
  setSearch(query: string): void;
  setStatusFilter(filter: StatusFilter): void;
  sortIndicator(field: SortField): string;
  staleCount(): number;
  toggleSort(field: SortField): void;
  view(): readonly ConversationSummary[];
}

const createConversationList = (): ConversationList => {
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

  const sortValue = (
    conv: ConversationSummary,
    field: SortField,
  ): number | string => {
    switch (field) {
      case 'created':
        return new Date(conv.created_at).getTime();
      case 'model':
        return formatModelName(models.display(conv).model).toLowerCase();
      case 'name':
        return conv.name.toLowerCase();
      case 'project':
        return getProjectName(conv, projectsMap).toLowerCase();
      case 'updated':
        return new Date(conv.updated_at).getTime();
    }
  };

  const sortView = (): void => {
    // If sortStack is empty, fall back to the default sort
    if (sortStack.length === 0) {
      sortStack = [{ ...DEFAULT_SORT }];
    }

    viewConversations.sort((a, b) => {
      // Try each sort criterion in order until we find a difference
      for (const { direction, field } of sortStack) {
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
  };

  const recompute = (): void => {
    viewConversations = allConversations.filter((conv) => {
      // 'projects' mode: search scope becomes the project name, status filters do not apply
      if (statusFilter === 'projects') {
        if (!search) return true;
        const projectName = getProjectName(conv, projectsMap);
        return (
          projectName !== '-' && projectName.toLowerCase().includes(search)
        );
      }

      const summary =
        typeof conv.summary === 'string' ? conv.summary : undefined;
      const matchesSearch =
        !search ||
        conv.name.toLowerCase().includes(search) ||
        (!!summary && summary.toLowerCase().includes(search));

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
  };

  return {
    all() {
      return allConversations;
    },
    allViewSelected() {
      // Checked when ANY are selected — not indeterminate, not "every row in
      // the view". Matches the original updateSelectAllCheckbox exactly.
      return selectedUuids.size > 0;
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
    clearSelection() {
      selectedUuids.clear();
    },
    display(conv) {
      return models.display(conv);
    },
    isStale(conv) {
      return exportRecords.isStale(conv);
    },
    projectName(conv) {
      return getProjectName(conv, projectsMap);
    },
    searchPlaceholder() {
      return statusFilter === 'projects'
        ? 'Search projects by name...'
        : 'Search conversations by name...';
    },
    selected() {
      return selectedUuids;
    },
    selectedCount() {
      return selectedUuids.size;
    },
    selectStale() {
      selectedUuids.clear();
      for (const conv of viewConversations) {
        if (exportRecords.isStale(conv)) selectedUuids.add(conv.uuid);
      }
    },
    setConversations(convs) {
      allConversations = convs;
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
    setProjects(map) {
      projectsMap = map;
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
    sortIndicator(field) {
      const sortIndex = sortStack.findIndex((s) => s.field === field);

      // Only show indicator for the primary (most recent) sort
      if (sortIndex !== 0) return '';

      const { direction } = sortStack[sortIndex];
      const primaryArrow = direction === 'asc' ? '↑' : '↓';
      const secondaryArrow = direction === 'asc' ? '↓' : '↑';

      return ` <span class="sort-indicator">${primaryArrow}<sub>${secondaryArrow}</sub></span>`;
    },
    staleCount() {
      return exportRecords.staleCount(allConversations);
    },
    toggleSort(field) {
      const existingIndex = sortStack.findIndex((s) => s.field === field);

      if (existingIndex === 0) {
        // Clicking primary sort: toggle direction
        sortStack[0].direction =
          sortStack[0].direction === 'asc' ? 'desc' : 'asc';
      } else if (existingIndex > 0) {
        // Clicking a secondary sort: move it to primary position
        const [criterion] = sortStack.splice(existingIndex, 1);
        sortStack.unshift(criterion);
      } else {
        // New sort: add to front with ascending direction
        sortStack.unshift({ direction: 'asc', field });
      }

      recompute();
    },
    view() {
      return viewConversations;
    },
  };
};

export { createConversationList, getProjectName };
export type { ConversationList, SortField, StatusFilter };
