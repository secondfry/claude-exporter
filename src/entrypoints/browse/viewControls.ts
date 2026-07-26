// The browse page's View controls are `data-` attributes on ordinary elements,
// so every click hands us a `string | undefined` that has to become a domain
// value. These narrow it without a type assertion: an unrecognised attribute
// means the markup drifted, and the safe reading of that is "no filter" /
// "not a sort column" rather than a value the list has never heard of.

import type { SortField, StatusFilter } from '$features/conversation-list';

/** Narrows a `.filter-option`'s dataset value to StatusFilter. */
const asStatusFilter = (value: string | undefined): StatusFilter => {
  return value === 'pending' ||
    value === 'never' ||
    value === 'stale' ||
    value === 'exported' ||
    value === 'projects'
    ? value
    : 'all';
};

/** Narrows a `.sortable` header's dataset value to SortField. */
const asSortField = (value: string | undefined): SortField | null => {
  return value === 'name' ||
    value === 'project' ||
    value === 'created' ||
    value === 'updated' ||
    value === 'model'
    ? value
    : null;
};

export { asSortField, asStatusFilter };
