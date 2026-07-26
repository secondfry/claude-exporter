// The browse table's HTML, as a pure function.
//
// Rendering used to be a 120-line arrow that read module-level preferences,
// concatenated a string and then wired four sets of listeners onto the result.
// Splitting it in two — a view-model derived from the list, then markup
// derived from the view-model — leaves index.ts with one innerHTML write and
// makes everything up to that point reachable by a spec.
//
// escapeHtml is deliberately a string function rather than the old
// `div.textContent = s; return div.innerHTML` trick: that one is DOM-bound
// (untestable here) and, more importantly, does not escape quotes, even though
// most of its call sites below sit inside attribute values.

import type { SortField } from '$features/conversation-list';
import type { ConversationSummary } from '$features/conversation/types';
import { formatModelName, getModelBadgeClass } from '$features/models';

import type { DateTimePrefs } from './dateTimePrefs';
import { formatDate, formatTime } from './dateTimePrefs';

interface DisplayedModel {
  bounced?: boolean;
  model: string;
  other?: string;
  otherLabel?: string;
}

interface TableSource {
  allViewSelected(): boolean;
  display(conv: ConversationSummary): DisplayedModel;
  needsExport(conv: ConversationSummary): boolean;
  projectName(conv: ConversationSummary): string;
  selected(): ReadonlySet<string>;
  sortIndicator(field: SortField): string;
  view(): readonly ConversationSummary[];
}

interface RowModel {
  created: { date: string; time: string };
  index: number;
  model: DisplayedModel;
  name: string;
  needsExport: boolean;
  projectName: string;
  selected: boolean;
  updated: { date: string; time: string };
  uuid: string;
}

interface TableModel {
  allViewSelected: boolean;
  rows: RowModel[];
  sortIndicators: Record<SortField, string>;
}

/** Column order is the table's, and the header row is generated from it. */
const COLUMNS: { field: SortField; label: string }[] = [
  { field: 'name', label: 'Name' },
  { field: 'project', label: 'Project' },
  { field: 'updated', label: 'Updated' },
  { field: 'created', label: 'Created' },
  { field: 'model', label: 'Model' },
];

const ESCAPES: Record<string, string> = {
  '"': '&quot;',
  '&': '&amp;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
};

const escapeHtml = (str: string | null | undefined): string => {
  if (!str) return '';
  return str.replace(/[&<>"']/g, (char) => ESCAPES[char]);
};

const stamp = (
  iso: string,
  prefs: DateTimePrefs,
): { date: string; time: string } => {
  const dt = new Date(iso);
  return {
    date: formatDate(dt, prefs.dateFormat),
    time: formatTime(dt, prefs.timeFormat),
  };
};

const buildTableModel = (
  list: TableSource,
  prefs: DateTimePrefs,
): TableModel => {
  return {
    allViewSelected: list.allViewSelected(),
    rows: list.view().map((conv, index) => ({
      created: stamp(conv.created_at, prefs),
      index,
      model: list.display(conv),
      name: conv.name,
      needsExport: list.needsExport(conv),
      projectName: list.projectName(conv),
      selected: list.selected().has(conv.uuid),
      updated: stamp(conv.updated_at, prefs),
      uuid: conv.uuid,
    })),
    sortIndicators: {
      created: list.sortIndicator('created'),
      model: list.sortIndicator('model'),
      name: list.sortIndicator('name'),
      project: list.sortIndicator('project'),
      updated: list.sortIndicator('updated'),
    },
  };
};

const renderModelCell = (model: DisplayedModel): string => {
  const badgeClass = getModelBadgeClass(model.model);
  const label = escapeHtml(formatModelName(model.model));
  if (!model.bounced) {
    return `<span class="model-badge ${badgeClass}">${label}</span>`;
  }
  // The asterisk means "this Conversation also ran on another model"; the
  // title says which, and in which direction.
  const title = `${escapeHtml(model.otherLabel)} ${escapeHtml(formatModelName(model.other))}`;
  return `<span class="model-cell" title="${title}"><span class="model-badge ${badgeClass}">${label}</span><span class="model-bounced ${badgeClass}">*</span></span>`;
};

const renderStamp = (value: { date: string; time: string }): string => {
  return `${escapeHtml(value.date)}<br><span class="time">${escapeHtml(value.time)}</span>`;
};

const renderRow = (row: RowModel): string => {
  const uuid = escapeHtml(row.uuid);
  const name = escapeHtml(row.name);
  const dot = row.needsExport
    ? '<span class="new-dot" title="New or updated since last export"></span>'
    : '';
  return `
      <tr data-id="${uuid}">
        <td>
          <div class="conversation-name">
            ${dot}
            <a href="https://claude.ai/chat/${uuid}" target="_blank" title="${name}">
              ${name}
            </a>
          </div>
        </td>
        <td>${escapeHtml(row.projectName)}</td>
        <td class="date">${renderStamp(row.updated)}</td>
        <td class="date">${renderStamp(row.created)}</td>
        <td>
          ${renderModelCell(row.model)}
        </td>
        <td>
          <div class="actions">
            <button class="btn-small btn-export" data-id="${uuid}" data-name="${name}">
              Export
            </button>
          </div>
        </td>
        <td class="checkbox-col">
          <input type="checkbox" class="conversation-checkbox" data-id="${uuid}" data-index="${row.index}" ${row.selected ? 'checked' : ''}>
        </td>
      </tr>
    `;
};

const renderHeader = (model: TableModel): string => {
  const headers = COLUMNS.map(
    ({ field, label }) =>
      `<th class="sortable" data-sort="${field}">${label}${model.sortIndicators[field]}</th>`,
  ).join('\n          ');
  return `
      <thead>
        <tr>
          ${headers}
          <th>Actions</th>
          <th class="checkbox-col">
            <input type="checkbox" id="selectAll" class="select-all-checkbox" ${model.allViewSelected ? 'checked' : ''}>
          </th>
        </tr>
      </thead>`;
};

/**
 * Security: every value that came from a Conversation goes through
 * escapeHtml; the structure itself is this file's own literals.
 */
const renderTable = (model: TableModel): string => {
  if (model.rows.length === 0) {
    return '<div class="no-results">No conversations found</div>';
  }
  return `
    <table>${renderHeader(model)}
      <tbody>
  ${model.rows.map(renderRow).join('')}
      </tbody>
    </table>
  `;
};

export { buildTableModel, escapeHtml, renderTable };
export type { RowModel, TableModel, TableSource };
