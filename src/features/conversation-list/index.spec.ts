import { describe, expect, it } from 'vitest';

import type { ConversationSummary } from '$features/conversation/types';
import type { ExportRecordBook } from '$features/tracking';

import { createConversationList, getProjectName } from './index';
import type { ConversationList } from './index';

function conv(overrides: Partial<ConversationSummary> & { uuid: string }): ConversationSummary {
  return {
    created_at: '2024-01-01T00:00:00.000Z',
    name: 'Untitled',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function staleBook(staleUuids: readonly string[]): ExportRecordBook {
  const set = new Set(staleUuids);
  return {
    size: 0,
    isStale: (c) => set.has(c.uuid),
    staleCount: (convs) => convs.filter((c) => set.has(c.uuid)).length,
  };
}

describe('getProjectName', () => {
  const projects = { p1: 'Alpha' };

  it('falls back through project_uuid, project_id, projectUuid in order', () => {
    expect(getProjectName(conv({ project_uuid: 'p1', uuid: 'a' }), projects)).toBe('Alpha');
    expect(getProjectName(conv({ project_id: 'p1', uuid: 'b' }), projects)).toBe('Alpha');
    expect(getProjectName(conv({ projectUuid: 'p1', uuid: 'c' }), projects)).toBe('Alpha');
  });

  it('returns the sentinel "-" when no project key is present', () => {
    expect(getProjectName(conv({ uuid: 'd' }), projects)).toBe('-');
  });

  it('returns the sentinel "-" when the project id is unresolvable', () => {
    expect(getProjectName(conv({ project_uuid: 'unknown', uuid: 'e' }), projects)).toBe('-');
  });
});

describe('createConversationList', () => {
  function setup(): ConversationList {
    return createConversationList();
  }

  describe('search', () => {
    it('matches name, case-insensitively', () => {
      const list = setup();
      list.setConversations([conv({ name: 'Hello World', uuid: 'a' })]);
      list.setSearch('WORLD');
      expect(list.view().map((c) => c.uuid)).toEqual(['a']);
    });

    it('matches summary', () => {
      const list = setup();
      list.setConversations([conv({ name: 'Foo', summary: 'a bar baz', uuid: 'a' })]);
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
      list.setExportRecords(staleBook(['a'])); // would matter for status filters, must not matter here
      list.setStatusFilter('projects');
      list.setSearch('alpha');
      // Only conv 'a' has project name "Alpha"; conv 'b' has name containing
      // "Alpha" but its project is "Beta", so it must NOT match.
      expect(list.view().map((c) => c.uuid)).toEqual(['a']);
    });

    it('new filter shows only Stale conversations', () => {
      const list = setup();
      list.setConversations([conv({ uuid: 'a' }), conv({ uuid: 'b' })]);
      list.setExportRecords(staleBook(['a']));
      list.setStatusFilter('new');
      expect(list.view().map((c) => c.uuid)).toEqual(['a']);
    });

    it('exported filter shows only non-Stale conversations', () => {
      const list = setup();
      list.setConversations([conv({ uuid: 'a' }), conv({ uuid: 'b' })]);
      list.setExportRecords(staleBook(['a']));
      list.setStatusFilter('exported');
      expect(list.view().map((c) => c.uuid)).toEqual(['b']);
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
      list.setConversations([conv({ name: 'B', uuid: 'a' }), conv({ name: 'A', uuid: 'b' })]);
      list.toggleSort('name');
      expect(list.view().map((c) => c.uuid)).toEqual(['b', 'a']);
    });

    it('toggling the primary field again flips direction', () => {
      const list = setup();
      list.setConversations([conv({ name: 'B', uuid: 'a' }), conv({ name: 'A', uuid: 'b' })]);
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
      list.setConversations([conv({ name: 'b', uuid: 'a' }), conv({ name: 'a', uuid: 'b' })]);
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
    function fiveConvs(): ConversationSummary[] {
      return [
        conv({ name: 'A', uuid: 'a' }),
        conv({ name: 'B', uuid: 'b' }),
        conv({ name: 'C', uuid: 'c' }),
        conv({ name: 'D', uuid: 'd' }),
        conv({ name: 'E', uuid: 'e' }),
      ];
    }

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

    it('selectStale clears the prior selection and selects only Stale conversations in view', () => {
      const list = setup();
      list.setConversations(fiveConvs());
      list.setExportRecords(staleBook(['b', 'd']));
      list.check('a', 0, false);
      list.selectStale();
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

  describe('staleCount', () => {
    it('counts Stale conversations across all(), not just the view', () => {
      const list = setup();
      list.setConversations([conv({ uuid: 'a' }), conv({ uuid: 'b' }), conv({ uuid: 'c' })]);
      list.setExportRecords(staleBook(['a', 'c']));
      list.setSearch('nonexistent-match'); // view is now empty
      expect(list.staleCount()).toBe(2);
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
