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

// 'pending' is the union of 'never' and 'stale' — kept as its own option
// because it is the one users act on before a bulk Export. 'exported' means
// "has an Export Record", so a Stale Conversation appears under BOTH it and
// 'stale'; the three are not a partition and are not meant to be.
// 'orphans' is not a status in the same sense as the rest: it says where the
// Conversation still exists rather than whether it has been Exported. It lives
// in the same union because it occupies the same control — a user asking "what
// do I still need to deal with?" reaches for one dropdown, not two.
type StatusFilter =
  'all' | 'exported' | 'never' | 'orphans' | 'pending' | 'projects' | 'stale';

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
  isOrphan(conv: ConversationSummary): boolean;
  needsExport(conv: ConversationSummary): boolean;
  needsExportCount(): number;
  orphanCount(): number;
  projectName(conv: ConversationSummary): string;
  searchPlaceholder(): string;
  selected(): ReadonlySet<string>;
  selectedCount(): number;
  selectPending(): void;
  setConversations(convs: ConversationSummary[]): void;
  setExportRecords(book: ExportRecordBook): void;
  setModels(book: ModelResolver): void;
  setOrphans(uuids: ReadonlySet<string>): void;
  setProjects(projectsMap: Record<string, string>): void;
  setSearch(query: string): void;
  setStatusFilter(filter: StatusFilter): void;
  sortIndicator(field: SortField): string;
  toggleSort(field: SortField): void;
  view(): readonly ConversationSummary[];
}

const createConversationList = (): ConversationList => {
  let allConversations: ConversationSummary[] = [];
  let viewConversations: ConversationSummary[] = [];
  let projectsMap: Record<string, string> = {};
  let exportRecords: ExportRecordBook = emptyExportRecords();
  let models: ModelResolver = emptyModelResolver();
  // Which of allConversations exist only in the Chat Cache. Held as a set of
  // uuids rather than a flag on the rows because an Orphan is a fact about the
  // *cache*, discovered separately and later than the row itself, and marking
  // up the ConversationSummary would put it in everything that round-trips one.
  let orphanUuids: ReadonlySet<string> = new Set();
  // Lower-cased once at setSearch time rather than per row per keystroke.
  // Like statusFilter and sortStack this is view-model state, not an
  // accumulator: it lives exactly as long as the list instance does.
  let search = '';
  let statusFilter: StatusFilter = 'all';
  let sortStack: SortCriterion[] = [];
  const selectedUuids = new Set<string>();
  // The shift-click anchor. Genuinely stateful — a range needs the previous
  // click to define it — and deliberately cleared whenever the View is
  // recomputed, because the index it holds is an index into that View.
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

  // Compares one criterion's values. An unparseable date yields NaN, which is
  // neither `>` nor `<`, so the pair reads as equal and Array.sort's stability
  // preserves input order instead of throwing the row to an arbitrary end.
  const compareValues = (
    aVal: number | string,
    bVal: number | string,
  ): number => {
    if (aVal > bVal) return 1;
    if (aVal < bVal) return -1;
    return 0;
  };

  // Each criterion carries its own direction; the first that separates the
  // pair wins, so later entries in the stack are pure tie-breakers.
  const compareBySortStack = (
    a: ConversationSummary,
    b: ConversationSummary,
  ): number => {
    for (const { direction, field } of sortStack) {
      const comparison = compareValues(
        sortValue(a, field),
        sortValue(b, field),
      );
      if (comparison === 0) continue;
      return direction === 'asc' ? comparison : -comparison;
    }
    return 0;
  };

  const sortView = (): void => {
    // If sortStack is empty, fall back to the default sort
    if (sortStack.length === 0) {
      sortStack = [{ ...DEFAULT_SORT }];
    }

    viewConversations.sort(compareBySortStack);
  };

  /** Search scope in every mode but 'projects': the name and the summary. */
  const matchesSearch = (conv: ConversationSummary): boolean => {
    if (!search) return true;
    if (conv.name.toLowerCase().includes(search)) return true;
    const summary = conv.summary;
    return (
      typeof summary === 'string' && summary.toLowerCase().includes(search)
    );
  };

  // Search scope in 'projects' mode. The '-' sentinel for "no project" is
  // excluded explicitly, so it can never be matched even by searching for it.
  const matchesProjectSearch = (conv: ConversationSummary): boolean => {
    if (!search) return true;
    const projectName = getProjectName(conv, projectsMap);
    return projectName !== '-' && projectName.toLowerCase().includes(search);
  };

  // The three-way status filter. 'exported' means "has an Export Record", so a
  // Stale Conversation satisfies both it and 'stale' — the cases deliberately
  // overlap. No `default`: a new StatusFilter must answer here explicitly.
  const matchesStatus = (conv: ConversationSummary): boolean => {
    switch (statusFilter) {
      case 'all':
      case 'projects':
        return true;
      case 'exported':
        return exportRecords.status(conv) !== 'never';
      case 'never':
        return exportRecords.status(conv) === 'never';
      case 'orphans':
        return orphanUuids.has(conv.uuid);
      case 'pending':
        return exportRecords.needsExport(conv);
      case 'stale':
        return exportRecords.status(conv) === 'stale';
    }
  };

  // 'projects' mode replaces both halves: the search scope becomes the project
  // name, and status filters do not apply.
  const matchesFilters = (conv: ConversationSummary): boolean => {
    if (statusFilter === 'projects') return matchesProjectSearch(conv);
    return matchesSearch(conv) && matchesStatus(conv);
  };

  const recompute = (): void => {
    viewConversations = allConversations.filter(matchesFilters);

    sortView();

    // Reset last checked index when the view changes.
    lastCheckedIndex = null;
  };

  const toggleOne = (uuid: string): void => {
    if (selectedUuids.has(uuid)) {
      selectedUuids.delete(uuid);
      return;
    }
    selectedUuids.add(uuid);
  };

  /** Applies one resulting state to a contiguous run of View rows. */
  const setRange = (start: number, end: number, checked: boolean): void => {
    for (let i = start; i <= end; i++) {
      const conv = viewConversations[i];
      if (!conv) continue;
      if (checked) selectedUuids.add(conv.uuid);
      else selectedUuids.delete(conv.uuid);
    }
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
        // Range selection follows the *target* checkbox's resulting state:
        // if it ends up checked, the whole range is selected; otherwise the
        // whole range is cleared.
        setRange(
          Math.min(lastCheckedIndex, index),
          Math.max(lastCheckedIndex, index),
          !selectedUuids.has(uuid),
        );
      } else {
        toggleOne(uuid);
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
    isOrphan(conv) {
      return orphanUuids.has(conv.uuid);
    },
    needsExport(conv) {
      return exportRecords.needsExport(conv);
    },
    needsExportCount() {
      return exportRecords.needsExportCount(allConversations);
    },
    orphanCount() {
      return orphanUuids.size;
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
    selectPending() {
      selectedUuids.clear();
      for (const conv of viewConversations) {
        if (exportRecords.needsExport(conv)) selectedUuids.add(conv.uuid);
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
    setOrphans(uuids) {
      // Recomputes, unlike setExportRecords: this one *can* change which rows
      // belong in the View, because 'orphans' is a filter over exactly it.
      orphanUuids = uuids;
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
