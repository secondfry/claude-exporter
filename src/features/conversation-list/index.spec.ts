import { describe, expect, it } from 'vitest';

import type { ConversationSummary } from '$features/conversation/types';
import type { ExportRecordBook, ExportStatus } from '$features/tracking';

import { createConversationList, getProjectName } from './index';
import type { ConversationList, StatusFilter } from './index';

const conv = (
  overrides: Partial<ConversationSummary> & { uuid: string },
): ConversationSummary => {
  return {
    created_at: '2024-01-01T00:00:00.000Z',
    name: 'Untitled',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
};

// Conversations not named default to 'current' (exported, unchanged).
const bookOf = (statuses: Record<string, ExportStatus>): ExportRecordBook => {
  const statusOf = (uuid: string): ExportStatus => statuses[uuid] || 'current';
  return {
    size: 0,
    isStale: (c) => statusOf(c.uuid) === 'stale',
    needsExport: (c) => statusOf(c.uuid) !== 'current',
    needsExportCount: (convs) =>
      convs.filter((c) => statusOf(c.uuid) !== 'current').length,
    status: (c) => statusOf(c.uuid),
  };
};

describe('getProjectName', () => {
  const projects = { p1: 'Alpha' };

  it('falls back through project_uuid, project_id, projectUuid in order', () => {
    expect(
      getProjectName(conv({ project_uuid: 'p1', uuid: 'a' }), projects),
    ).toBe('Alpha');
    expect(
      getProjectName(conv({ project_id: 'p1', uuid: 'b' }), projects),
    ).toBe('Alpha');
    expect(
      getProjectName(conv({ projectUuid: 'p1', uuid: 'c' }), projects),
    ).toBe('Alpha');
  });

  it('returns the sentinel "-" when no project key is present', () => {
    expect(getProjectName(conv({ uuid: 'd' }), projects)).toBe('-');
  });

  it('returns the sentinel "-" when the project id is unresolvable', () => {
    expect(
      getProjectName(conv({ project_uuid: 'unknown', uuid: 'e' }), projects),
    ).toBe('-');
  });
});

describe('createConversationList', () => {
  const setup = (): ConversationList => {
    return createConversationList();
  };

  describe('search', () => {
    it('matches name, case-insensitively', () => {
      const list = setup();
      list.setConversations([conv({ name: 'Hello World', uuid: 'a' })]);
      list.setSearch('WORLD');
      expect(list.view().map((c) => c.uuid)).toEqual(['a']);
    });

    it('matches summary', () => {
      const list = setup();
      list.setConversations([
        conv({ name: 'Foo', summary: 'a bar baz', uuid: 'a' }),
      ]);
      list.setSearch('bar');
      expect(list.view().map((c) => c.uuid)).toEqual(['a']);
    });

    it('empty query matches everything', () => {
      const list = setup();
      list.setConversations([conv({ uuid: 'a' }), conv({ uuid: 'b' })]);
      list.setSearch('');
      expect(list.view()).toHaveLength(2);
    });
  });

  describe('status filter', () => {
    it('projects mode overrides search scope to project name and disables status filters', () => {
      const list = setup();
      list.setConversations([
        conv({ name: 'zzz', project_uuid: 'p1', uuid: 'a' }),
        conv({ name: 'Alpha thing', project_uuid: 'p2', uuid: 'b' }),
      ]);
      list.setProjects({ p1: 'Alpha', p2: 'Beta' });
      list.setExportRecords(bookOf({ a: 'never' })); // would matter for status filters, must not matter here
      list.setStatusFilter('projects');
      list.setSearch('alpha');
      // Only conv 'a' has project name "Alpha"; conv 'b' has name containing
      // "Alpha" but its project is "Beta", so it must NOT match.
      expect(list.view().map((c) => c.uuid)).toEqual(['a']);
    });

    // 'a' never exported, 'b' exported then edited (Stale), 'c' exported and
    // unchanged. The three status filters are deliberately NOT a partition:
    // 'b' belongs to both 'stale' and 'exported'.
    const threeStates = () => {
      const list = setup();
      list.setConversations([
        conv({ uuid: 'a' }),
        conv({ uuid: 'b' }),
        conv({ uuid: 'c' }),
      ]);
      list.setExportRecords(bookOf({ a: 'never', b: 'stale' }));
      return list;
    };

    it('pending filter shows never-exported and Stale conversations', () => {
      const list = threeStates();
      list.setStatusFilter('pending');
      expect(list.view().map((c) => c.uuid)).toEqual(['a', 'b']);
    });

    it('never filter shows only conversations with no Export Record', () => {
      const list = threeStates();
      list.setStatusFilter('never');
      expect(list.view().map((c) => c.uuid)).toEqual(['a']);
    });

    it('stale filter shows only conversations edited since their Export Record', () => {
      const list = threeStates();
      list.setStatusFilter('stale');
      expect(list.view().map((c) => c.uuid)).toEqual(['b']);
    });

    it('exported filter includes a Stale conversation — it still has an Export Record', () => {
      const list = threeStates();
      list.setStatusFilter('exported');
      expect(list.view().map((c) => c.uuid)).toEqual(['b', 'c']);
    });
  });

  // The three-way status filter shipped in v1.21.0 and its interaction with
  // the search box is the part users reported as wrong. Every status value is
  // pinned both with and without a search term. Note setExportRecords does
  // NOT recompute, so it must precede setStatusFilter/setSearch.
  describe('status filter x search', () => {
    // a: never, b: stale, c: current, d: stale. Names chosen so 'alpha'
    // cuts across all three statuses.
    const matrix = (): ConversationList => {
      const list = setup();
      list.setConversations([
        conv({ name: 'alpha never', uuid: 'a' }),
        conv({ name: 'beta stale', uuid: 'b' }),
        conv({ name: 'alpha current', uuid: 'c' }),
        conv({ name: 'alpha stale', uuid: 'd' }),
      ]);
      list.setExportRecords(bookOf({ a: 'never', b: 'stale', d: 'stale' }));
      return list;
    };

    const viewOf = (filter: StatusFilter, search: string): string[] => {
      const list = matrix();
      list.setStatusFilter(filter);
      list.setSearch(search);
      return list.view().map((c) => c.uuid);
    };

    it('all: no search keeps everything', () => {
      expect(viewOf('all', '')).toEqual(['a', 'b', 'c', 'd']);
    });

    it('all: search narrows by name across every status', () => {
      expect(viewOf('all', 'alpha')).toEqual(['a', 'c', 'd']);
    });

    it('pending: no search keeps never + stale', () => {
      expect(viewOf('pending', '')).toEqual(['a', 'b', 'd']);
    });

    it('pending: search and status are ANDed', () => {
      expect(viewOf('pending', 'alpha')).toEqual(['a', 'd']);
    });

    it('never: no search keeps only conversations with no Export Record', () => {
      expect(viewOf('never', '')).toEqual(['a']);
    });

    it('never: search further narrows the never set', () => {
      expect(viewOf('never', 'alpha')).toEqual(['a']);
      expect(viewOf('never', 'beta')).toEqual([]);
    });

    it('stale: no search keeps only Stale conversations', () => {
      expect(viewOf('stale', '')).toEqual(['b', 'd']);
    });

    it('stale: search drops the Stale conversation that does not match', () => {
      expect(viewOf('stale', 'alpha')).toEqual(['d']);
    });

    it('exported: no search keeps everything with an Export Record', () => {
      expect(viewOf('exported', '')).toEqual(['b', 'c', 'd']);
    });

    it('exported: search narrows within the exported set', () => {
      expect(viewOf('exported', 'alpha')).toEqual(['c', 'd']);
    });

    it('search also matches the summary, not just the name', () => {
      const list = setup();
      list.setConversations([
        conv({ name: 'x', summary: 'alpha in summary', uuid: 'a' }),
        conv({ name: 'y', uuid: 'b' }),
      ]);
      list.setExportRecords(bookOf({ a: 'never', b: 'never' }));
      list.setStatusFilter('never');
      list.setSearch('alpha');
      expect(list.view().map((c) => c.uuid)).toEqual(['a']);
    });

    it('a non-string summary is ignored rather than throwing', () => {
      const list = setup();
      // ConversationSummary's index signature admits any summary shape.
      list.setConversations([conv({ name: 'x', summary: 42, uuid: 'a' })]);
      list.setSearch('42');
      expect(list.view()).toHaveLength(0);
    });

    describe('projects mode', () => {
      const projectMatrix = (): ConversationList => {
        const list = setup();
        list.setConversations([
          conv({ name: 'zzz', project_uuid: 'p1', uuid: 'a' }),
          conv({ name: 'Alpha thing', project_uuid: 'p2', uuid: 'b' }),
          conv({ name: 'no project', uuid: 'c' }),
        ]);
        list.setProjects({ p1: 'Alpha', p2: 'Beta' });
        list.setExportRecords(bookOf({ a: 'never', b: 'never', c: 'never' }));
        list.setStatusFilter('projects');
        return list;
      };

      it('empty search short-circuits to everything, including project-less conversations', () => {
        const list = projectMatrix();
        list.setSearch('');
        expect(list.view().map((c) => c.uuid)).toEqual(['a', 'b', 'c']);
      });

      it('a search scopes to the project name and excludes the "-" sentinel', () => {
        const list = projectMatrix();
        list.setSearch('alpha');
        expect(list.view().map((c) => c.uuid)).toEqual(['a']);
      });

      it('the "-" sentinel is never matchable, even by searching for it', () => {
        const list = projectMatrix();
        list.setSearch('-');
        expect(list.view().map((c) => c.uuid)).toEqual([]);
      });

      it('status is ignored: an "exported" conversation still shows', () => {
        const list = setup();
        list.setConversations([conv({ project_uuid: 'p1', uuid: 'a' })]);
        list.setProjects({ p1: 'Alpha' });
        list.setExportRecords(bookOf({})); // 'a' defaults to 'current'
        list.setStatusFilter('projects');
        list.setSearch('alpha');
        expect(list.view().map((c) => c.uuid)).toEqual(['a']);
      });
    });
  });

  describe('sort', () => {
    it('applies the implicit default sort (updated desc) with no user interaction', () => {
      const list = setup();
      list.setConversations([
        conv({ updated_at: '2024-01-01T00:00:00.000Z', uuid: 'a' }),
        conv({ updated_at: '2024-02-01T00:00:00.000Z', uuid: 'b' }),
      ]);
      expect(list.view().map((c) => c.uuid)).toEqual(['b', 'a']);
    });

    it('toggling a new field sorts ascending, pushed to primary', () => {
      const list = setup();
      list.setConversations([
        conv({ name: 'B', uuid: 'a' }),
        conv({ name: 'A', uuid: 'b' }),
      ]);
      list.toggleSort('name');
      expect(list.view().map((c) => c.uuid)).toEqual(['b', 'a']);
    });

    it('toggling the primary field again flips direction', () => {
      const list = setup();
      list.setConversations([
        conv({ name: 'B', uuid: 'a' }),
        conv({ name: 'A', uuid: 'b' }),
      ]);
      list.toggleSort('name');
      list.toggleSort('name');
      expect(list.view().map((c) => c.uuid)).toEqual(['a', 'b']);
    });

    it('primary + secondary sort applies secondary as tiebreaker', () => {
      const list = setup();
      list.setConversations([
        conv({ created_at: '2024-01-02T00:00:00.000Z', name: 'Z', uuid: 'a' }),
        conv({ created_at: '2024-01-01T00:00:00.000Z', name: 'Z', uuid: 'b' }),
        conv({ created_at: '2024-01-03T00:00:00.000Z', name: 'A', uuid: 'c' }),
      ]);
      list.toggleSort('name'); // primary: name asc
      list.toggleSort('created'); // primary: created asc, name becomes secondary
      // sortStack is now [created asc, name asc] (created pushed to front)
      expect(list.view().map((c) => c.uuid)).toEqual(['b', 'a', 'c']);
    });

    it('clicking an existing secondary promotes it to primary', () => {
      const list = setup();
      list.setConversations([
        conv({ created_at: '2024-01-01T00:00:00.000Z', name: 'B', uuid: 'a' }),
        conv({ created_at: '2024-01-01T00:00:00.000Z', name: 'A', uuid: 'b' }),
      ]);
      list.toggleSort('created'); // stack: [created asc]
      list.toggleSort('name'); // stack: [name asc, created asc]
      list.toggleSort('created'); // promote created back to primary: [created asc, name asc]
      expect(list.sortIndicator('created')).not.toBe('');
      expect(list.sortIndicator('name')).toBe('');
    });

    it('each criterion carries its own direction: flipping the primary leaves the secondary alone', () => {
      const list = setup();
      list.setConversations([
        conv({ created_at: '2024-01-01T00:00:00.000Z', name: 'Z', uuid: 'a' }),
        conv({ created_at: '2024-01-02T00:00:00.000Z', name: 'Z', uuid: 'b' }),
        conv({ created_at: '2024-01-03T00:00:00.000Z', name: 'A', uuid: 'c' }),
      ]);
      list.toggleSort('created'); // stack: [created asc]
      list.toggleSort('name'); // stack: [name asc, created asc]
      list.toggleSort('name'); // stack: [name desc, created asc]
      // 'Z' before 'A' (primary desc), then the Z-tie broken by created ASC —
      // the secondary keeps the direction it was given.
      expect(list.view().map((c) => c.uuid)).toEqual(['a', 'b', 'c']);
    });

    it('a tie on every criterion preserves input order (the comparator returns 0)', () => {
      const list = setup();
      list.setConversations([
        conv({
          created_at: '2024-01-01T00:00:00.000Z',
          name: 'same',
          uuid: 'a',
        }),
        conv({
          created_at: '2024-01-01T00:00:00.000Z',
          name: 'same',
          uuid: 'b',
        }),
        conv({
          created_at: '2024-01-01T00:00:00.000Z',
          name: 'same',
          uuid: 'c',
        }),
      ]);
      list.toggleSort('name');
      list.toggleSort('created');
      expect(list.view().map((c) => c.uuid)).toEqual(['a', 'b', 'c']);
    });

    it('the secondary criterion only breaks ties — it never reorders distinct primaries', () => {
      const list = setup();
      list.setConversations([
        conv({ created_at: '2024-01-03T00:00:00.000Z', name: 'A', uuid: 'a' }),
        conv({ created_at: '2024-01-01T00:00:00.000Z', name: 'B', uuid: 'b' }),
      ]);
      list.toggleSort('created'); // secondary-to-be: created asc
      list.toggleSort('name'); // primary: name asc
      // 'a' has the later created_at but the earlier name, and name wins.
      expect(list.view().map((c) => c.uuid)).toEqual(['a', 'b']);
    });

    it('sortIndicator is only shown for the primary criterion', () => {
      const list = setup();
      list.setConversations([conv({ uuid: 'a' })]);
      list.toggleSort('name');
      list.toggleSort('created');
      expect(list.sortIndicator('created')).toContain('↑');
      expect(list.sortIndicator('name')).toBe('');
    });
  });

  describe('sortValue via view ordering (field coverage)', () => {
    it('sorts by name', () => {
      const list = setup();
      list.setConversations([
        conv({ name: 'b', uuid: 'a' }),
        conv({ name: 'a', uuid: 'b' }),
      ]);
      list.toggleSort('name');
      expect(list.view().map((c) => c.uuid)).toEqual(['b', 'a']);
    });

    it('sorts by project, using the "-" sentinel for missing projects', () => {
      const list = setup();
      list.setConversations([
        conv({ project_uuid: 'p1', uuid: 'a' }),
        conv({ uuid: 'b' }), // no project -> '-'
      ]);
      list.setProjects({ p1: 'Zeta' });
      list.toggleSort('project'); // asc: '-' sorts before 'zeta'
      expect(list.view().map((c) => c.uuid)).toEqual(['b', 'a']);
    });

    it('sorts by created', () => {
      const list = setup();
      list.setConversations([
        conv({ created_at: '2024-05-01T00:00:00.000Z', uuid: 'a' }),
        conv({ created_at: '2024-01-01T00:00:00.000Z', uuid: 'b' }),
      ]);
      list.toggleSort('created');
      expect(list.view().map((c) => c.uuid)).toEqual(['b', 'a']);
    });

    it('handles a missing/invalid date by treating it as Invalid Date (NaN, compares as neither > nor <)', () => {
      const list = setup();
      list.setConversations([
        conv({ created_at: 'not-a-date', uuid: 'a' }),
        conv({ created_at: '2024-01-01T00:00:00.000Z', uuid: 'b' }),
      ]);
      list.toggleSort('created');
      // NaN comparisons (aVal > bVal and aVal < bVal) are both always false,
      // so `comparison` stays 0 for the 'a' vs 'b' pair regardless of which
      // side is NaN — the comparator reports them equal and Array.sort's
      // stable sort therefore preserves input order ('a' before 'b') rather
      // than crashing or throwing one of them to an arbitrary end.
      expect(list.view().map((c) => c.uuid)).toEqual(['a', 'b']);
    });

    it('sorts by model, formatting via the resolver, defaulting to empty string when absent', () => {
      const list = setup();
      list.setConversations([conv({ uuid: 'a' }), conv({ uuid: 'b' })]);
      list.setModels({
        display: (c) => ({ model: c.uuid === 'a' ? 'claude-3-opus' : '' }),
      });
      list.toggleSort('model');
      // formatModelName('') -> 'Unknown', formatModelName('claude-3-opus') ->
      // 'Claude 3 Opus'; lower-cased, 'claude 3 opus' sorts before 'unknown'.
      expect(list.view().map((c) => c.uuid)).toEqual(['a', 'b']);
    });
  });

  describe('selection', () => {
    const fiveConvs = (): ConversationSummary[] => {
      return [
        conv({ name: 'A', uuid: 'a' }),
        conv({ name: 'B', uuid: 'b' }),
        conv({ name: 'C', uuid: 'c' }),
        conv({ name: 'D', uuid: 'd' }),
        conv({ name: 'E', uuid: 'e' }),
      ];
    };

    it('plain click toggles a single conversation', () => {
      const list = setup();
      list.setConversations(fiveConvs());
      list.check('b', 1, false);
      expect(list.selected()).toEqual(new Set(['b']));
      list.check('b', 1, false);
      expect(list.selected()).toEqual(new Set());
    });

    it('shift-click with no prior anchor behaves as a plain toggle', () => {
      const list = setup();
      list.setConversations(fiveConvs());
      list.check('c', 2, true);
      expect(list.selected()).toEqual(new Set(['c']));
    });

    it('shift-click selects a forward range', () => {
      const list = setup();
      list.setConversations(fiveConvs());
      list.check('a', 0, false);
      list.check('d', 3, true);
      expect(list.selected()).toEqual(new Set(['a', 'b', 'c', 'd']));
    });

    it('shift-click selects a backward range (lower index clicked second)', () => {
      const list = setup();
      list.setConversations(fiveConvs());
      list.check('d', 3, false);
      list.check('a', 0, true);
      expect(list.selected()).toEqual(new Set(['a', 'b', 'c', 'd']));
    });

    it('shift-range uses the resulting (unchecking) state when the anchor was checked', () => {
      const list = setup();
      list.setConversations(fiveConvs());
      list.check('a', 0, false);
      list.check('b', 1, false);
      list.check('c', 2, false);
      // Now uncheck 'a' with shift held to range-uncheck a..c
      list.check('a', 0, true);
      expect(list.selected()).toEqual(new Set());
    });

    it('shift-range after a re-sort uses the new ordering for index lookup', () => {
      const list = setup();
      list.setConversations(fiveConvs());
      list.toggleSort('name'); // ascending by name: a,b,c,d,e (unchanged order here)
      list.toggleSort('name'); // descending: e,d,c,b,a
      // view is now [e, d, c, b, a]
      list.check('e', 0, false);
      list.check('b', 3, true); // range over view indices 0..3 => e,d,c,b
      expect(list.selected()).toEqual(new Set(['b', 'c', 'd', 'e']));
    });

    it('checkAll(true) selects everything currently in view', () => {
      const list = setup();
      list.setConversations(fiveConvs());
      list.setSearch('a'); // only conv 'a' name matches (case-insensitive substring)
      list.checkAll(true);
      expect(list.selected()).toEqual(new Set(['a']));
    });

    it('checkAll(false) clears the whole selection', () => {
      const list = setup();
      list.setConversations(fiveConvs());
      list.checkAll(true);
      list.checkAll(false);
      expect(list.selected()).toEqual(new Set());
    });

    it('clearSelection empties the selection', () => {
      const list = setup();
      list.setConversations(fiveConvs());
      list.check('a', 0, false);
      list.clearSelection();
      expect(list.selectedCount()).toBe(0);
    });

    it('selectPending clears the prior selection and selects only conversations needing Export', () => {
      const list = setup();
      list.setConversations(fiveConvs());
      list.setExportRecords(bookOf({ b: 'never', d: 'stale' }));
      list.check('a', 0, false);
      list.selectPending();
      expect(list.selected()).toEqual(new Set(['b', 'd']));
    });

    it('allViewSelected is true whenever ANY conversation is selected, not just view members', () => {
      const list = setup();
      list.setConversations(fiveConvs());
      expect(list.allViewSelected()).toBe(false);
      list.check('a', 0, false);
      expect(list.allViewSelected()).toBe(true);
    });
  });

  describe('needsExportCount', () => {
    it('counts conversations needing Export across all(), not just the view', () => {
      const list = setup();
      list.setConversations([
        conv({ uuid: 'a' }),
        conv({ uuid: 'b' }),
        conv({ uuid: 'c' }),
      ]);
      list.setExportRecords(bookOf({ a: 'never', c: 'stale' }));
      list.setSearch('nonexistent-match'); // view is now empty
      expect(list.needsExportCount()).toBe(2);
    });
  });

  // Orphans (CONTEXT.md): Conversations that exist only in the Chat Cache.
  // They are ordinary rows in every respect the list cares about — the filter
  // is what makes them findable, since a user who deleted a chat by accident
  // has no other way to ask "what do I still have?"
  describe('orphans', () => {
    const withOrphans = (): ConversationList => {
      const list = createConversationList();
      list.setConversations([
        conv({ name: 'Live', uuid: 'a' }),
        conv({ name: 'Deleted', uuid: 'b' }),
      ]);
      list.setOrphans(new Set(['b']));
      return list;
    };

    it('shows only Orphans under the orphans filter', () => {
      const list = withOrphans();
      list.setStatusFilter('orphans');
      expect(list.view().map((c) => c.uuid)).toEqual(['b']);
    });

    // They are not a separate table. A user who never opens the filter should
    // still see the Conversation they lost.
    it('leaves Orphans in the View under "all"', () => {
      expect(
        withOrphans()
          .view()
          .map((c) => c.uuid)
          .sort(),
      ).toEqual(['a', 'b']);
    });

    it('answers isOrphan per row', () => {
      const list = withOrphans();
      expect(list.isOrphan(conv({ uuid: 'b' }))).toBe(true);
      expect(list.isOrphan(conv({ uuid: 'a' }))).toBe(false);
    });

    it('counts them', () => {
      expect(withOrphans().orphanCount()).toBe(1);
    });

    it('reports no Orphans before the cache has been consulted', () => {
      const list = createConversationList();
      list.setConversations([conv({ uuid: 'a' })]);
      expect(list.orphanCount()).toBe(0);
      expect(list.isOrphan(conv({ uuid: 'a' }))).toBe(false);
    });

    // Unlike setExportRecords, this one must recompute: it changes which rows
    // belong in the View whenever the orphans filter is the active one.
    it('recomputes the View when Orphans arrive after the filter is set', () => {
      const list = createConversationList();
      list.setConversations([conv({ uuid: 'a' }), conv({ uuid: 'b' })]);
      list.setStatusFilter('orphans');
      expect(list.view()).toEqual([]);

      list.setOrphans(new Set(['b']));
      expect(list.view().map((c) => c.uuid)).toEqual(['b']);
    });

    it('still applies the search box within the orphans filter', () => {
      const list = withOrphans();
      list.setStatusFilter('orphans');
      list.setSearch('live');
      expect(list.view()).toEqual([]);
    });
  });

  describe('searchPlaceholder', () => {
    it('switches copy for projects mode', () => {
      const list = setup();
      expect(list.searchPlaceholder()).toBe('Search conversations by name...');
      list.setStatusFilter('projects');
      expect(list.searchPlaceholder()).toBe('Search projects by name...');
    });
  });
});
