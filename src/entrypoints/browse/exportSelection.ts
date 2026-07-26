// Which Conversations the "Export All" button actually exports.
//
// CONTEXT.md keeps the Selection and the View apart on purpose, and this is
// where that distinction is cashed in: a non-empty Selection wins over the
// View entirely, including Conversations the current filter hides. The
// checkbox is the user's explicit choice; the filter is only a lens. The
// button's own label already counts the whole Selection, so nothing is
// exported that the user was not told about.

import type { ConversationSummary } from '$features/conversation/types';
import type { ExportTarget } from '$features/export/types';

interface SelectionSource {
  all(): readonly ConversationSummary[];
  selected(): ReadonlySet<string>;
  selectedCount(): number;
  view(): readonly ConversationSummary[];
}

const toTarget = (conv: ConversationSummary): ExportTarget => {
  return {
    name: conv.name,
    // Without updated_at the Chat Cache may not answer for this Conversation.
    updatedAt: conv.updated_at,
    uuid: conv.uuid,
  };
};

/** The Selection if there is one, otherwise everything the View shows. */
const conversationsToExport = (
  list: SelectionSource,
): readonly ConversationSummary[] => {
  if (list.selectedCount() === 0) return list.view();
  return list.all().filter((conv) => list.selected().has(conv.uuid));
};

const exportTargets = (list: SelectionSource): ExportTarget[] => {
  return conversationsToExport(list).map(toTarget);
};

/**
 * The row Export button's target. `updated_at` is taken from the loaded list
 * rather than the button's own dataset because it is what decides whether the
 * Chat Cache may answer instead of the network — it has to come from the same
 * source the table rendered from.
 */
const rowExportTarget = (
  list: Pick<SelectionSource, 'all'>,
  uuid: string,
  fallbackName: string,
): ExportTarget => {
  const conv = list.all().find((candidate) => candidate.uuid === uuid);
  return { name: fallbackName, updatedAt: conv?.updated_at, uuid };
};

export { conversationsToExport, exportTargets, rowExportTarget };
export type { SelectionSource };
