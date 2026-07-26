import { describe, expect, it } from 'vitest';

import { createConversationList } from '$features/conversation-list';
import type { ConversationSummary } from '$features/conversation/types';

import {
  conversationsToExport,
  exportTargets,
  rowExportTarget,
} from './exportSelection';

// Characterization of the Selection-beats-View rule. This is the browse page's
// most surprising behaviour — a filtered-out Conversation still gets exported
// if its checkbox is ticked — and it was inline in a DOM arrow.

const conv = (uuid: string, name: string): ConversationSummary => {
  return {
    created_at: '2024-01-01T00:00:00Z',
    model: null,
    name,
    updated_at: '2024-02-01T00:00:00Z',
    uuid,
  };
};

const A = conv('a', 'Alpha');
const B = conv('b', 'Beta');
const C = conv('c', 'Gamma');

const listWith = (convs: ConversationSummary[]) => {
  const list = createConversationList();
  list.setConversations(convs);
  return list;
};

describe('browse/exportSelection', () => {
  describe('conversationsToExport', () => {
    it('falls back to the whole View when nothing is selected', () => {
      const list = listWith([A, B, C]);
      expect(conversationsToExport(list).map((c) => c.uuid)).toEqual([
        'a',
        'b',
        'c',
      ]);
    });

    it('honours the search filter when nothing is selected', () => {
      const list = listWith([A, B, C]);
      list.setSearch('alpha');
      expect(conversationsToExport(list).map((c) => c.uuid)).toEqual(['a']);
    });

    it('exports only the Selection when there is one', () => {
      const list = listWith([A, B, C]);
      list.check('b', 0, false);
      expect(conversationsToExport(list).map((c) => c.uuid)).toEqual(['b']);
    });

    // The whole point: the filter is a lens, the checkbox is a decision.
    it('exports a selected Conversation the View currently hides', () => {
      const list = listWith([A, B, C]);
      list.check('b', 0, false);
      list.setSearch('alpha');
      expect(conversationsToExport(list).map((c) => c.uuid)).toEqual(['b']);
    });

    it('draws selected Conversations in all() order, not Selection order', () => {
      const list = listWith([A, B, C]);
      list.check('c', 0, false);
      list.check('a', 1, false);
      expect(conversationsToExport(list).map((c) => c.uuid)).toEqual([
        'a',
        'c',
      ]);
    });
  });

  describe('exportTargets', () => {
    it('carries updated_at so the Chat Cache may answer', () => {
      const list = listWith([A]);
      expect(exportTargets(list)).toEqual([
        { name: 'Alpha', updatedAt: A.updated_at, uuid: 'a' },
      ]);
    });

    it('is empty when the View is empty and nothing is selected', () => {
      expect(exportTargets(listWith([]))).toEqual([]);
    });
  });

  describe('rowExportTarget', () => {
    it('takes updated_at from the loaded list, not the caller', () => {
      const list = listWith([A, B]);
      expect(rowExportTarget(list, 'b', 'Beta')).toEqual({
        name: 'Beta',
        updatedAt: B.updated_at,
        uuid: 'b',
      });
    });

    // No updated_at means no Cache Hit, which is the safe direction: the
    // Export refetches rather than serving a Conversation we cannot vouch for.
    it('omits updated_at when the uuid is not in the loaded list', () => {
      const list = listWith([A]);
      expect(rowExportTarget(list, 'z', 'Zeta')).toEqual({
        name: 'Zeta',
        updatedAt: undefined,
        uuid: 'z',
      });
    });
  });
});
