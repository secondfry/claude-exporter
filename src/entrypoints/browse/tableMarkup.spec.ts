import { describe, expect, it } from 'vitest';

import { createConversationList } from '$features/conversation-list';
import type { ConversationSummary } from '$features/conversation/types';

import type { DateTimePrefs } from './dateTimePrefs';
import { buildTableModel, escapeHtml, renderTable } from './tableMarkup';

// The table markup had no coverage of any kind: it was a string built inside a
// DOM-writing arrow. What matters here is that every Conversation-derived
// value is escaped, that the per-row data- attributes the click handlers read
// are present and correct, and that an empty View says so.

const PREFS: DateTimePrefs = { dateFormat: 'mdy', timeFormat: '12h' };

const conv = (
  uuid: string,
  name: string,
  extra: Partial<ConversationSummary> = {},
): ConversationSummary => {
  return {
    created_at: '2024-01-02T03:04:05Z',
    model: 'claude-3-5-sonnet-20241022',
    name,
    updated_at: '2024-02-03T04:05:06Z',
    uuid,
    ...extra,
  };
};

const listWith = (convs: ConversationSummary[]) => {
  const list = createConversationList();
  list.setConversations(convs);
  return list;
};

const markupFor = (convs: ConversationSummary[]): string => {
  return renderTable(buildTableModel(listWith(convs), PREFS));
};

describe('browse/tableMarkup', () => {
  describe('escapeHtml', () => {
    it('escapes the markup characters', () => {
      expect(escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
    });

    // Most call sites are attribute values, so quotes are not optional here.
    it('escapes both quote characters', () => {
      expect(escapeHtml(`"x" 'y'`)).toBe('&quot;x&quot; &#39;y&#39;');
    });

    it('returns an empty string for nullish input', () => {
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
      expect(escapeHtml('')).toBe('');
    });

    it('leaves ordinary text alone', () => {
      expect(escapeHtml('Tuesday plans')).toBe('Tuesday plans');
    });
  });

  describe('buildTableModel', () => {
    it('numbers rows by their position in the View', () => {
      const model = buildTableModel(
        listWith([conv('a', 'A'), conv('b', 'B')]),
        PREFS,
      );
      expect(model.rows.map((row) => row.index)).toEqual([0, 1]);
    });

    it('formats both timestamps with the given preferences', () => {
      const model = buildTableModel(listWith([conv('a', 'A')]), PREFS);
      expect(model.rows[0].created.date).toMatch(/^\d+\/\d+\/2024$/);
      expect(model.rows[0].updated.date).toMatch(/^\d+\/\d+\/2024$/);
    });

    it('reports Selection membership per row', () => {
      const list = listWith([conv('a', 'A'), conv('b', 'B')]);
      list.check('a', 0, false);
      const model = buildTableModel(list, PREFS);
      const selected = model.rows.filter((row) => row.selected);
      expect(selected.map((row) => row.uuid)).toEqual(['a']);
    });

    it('carries a sort indicator for every sortable column', () => {
      const model = buildTableModel(listWith([conv('a', 'A')]), PREFS);
      expect(Object.keys(model.sortIndicators).sort()).toEqual([
        'created',
        'model',
        'name',
        'project',
        'updated',
      ]);
    });
  });

  describe('renderTable', () => {
    it('says so when the View is empty', () => {
      expect(markupFor([])).toBe(
        '<div class="no-results">No conversations found</div>',
      );
    });

    it('emits one row per Conversation in the View', () => {
      const html = markupFor([conv('a', 'A'), conv('b', 'B')]);
      expect(html.match(/<tr data-id=/g)).toHaveLength(2);
    });

    it('gives the export button the id and name its handler reads', () => {
      const html = markupFor([conv('a', 'Tuesday')]);
      expect(html).toContain('data-id="a" data-name="Tuesday"');
    });

    it('gives each checkbox its uuid and View index', () => {
      const html = markupFor([conv('a', 'A'), conv('b', 'B')]);
      expect(html).toContain('data-id="a" data-index="0"');
      expect(html).toContain('data-id="b" data-index="1"');
    });

    // A Conversation name is arbitrary user text arriving from claude.ai and
    // is interpolated into href/title/data-name attributes.
    it('escapes a Conversation name that tries to break out of an attribute', () => {
      const html = markupFor([conv('a', '" onmouseover="alert(1)')]);
      expect(html).not.toContain('onmouseover="alert(1)"');
      expect(html).toContain('&quot; onmouseover=&quot;alert(1)');
    });

    it('escapes a project name', () => {
      const list = listWith([conv('a', 'A', { project_uuid: 'p' })]);
      list.setProjects({ p: '<script>' });
      expect(renderTable(buildTableModel(list, PREFS))).not.toContain(
        '<script>',
      );
    });

    it('links each row to its Conversation on claude.ai', () => {
      expect(markupFor([conv('a', 'A')])).toContain(
        'href="https://claude.ai/chat/a"',
      );
    });

    it('renders a plain badge for a Conversation that stayed on one model', () => {
      const html = markupFor([conv('a', 'A')]);
      expect(html).toContain('class="model-badge');
      expect(html).not.toContain('model-bounced');
    });

    it('renders the bounced marker and its title when models differ', () => {
      const list = listWith([conv('a', 'A')]);
      list.setModels({
        display: () => ({
          bounced: true,
          model: 'claude-3-5-sonnet-20241022',
          other: 'claude-3-opus-20240229',
          otherLabel: 'Originally',
        }),
      });
      const html = renderTable(buildTableModel(list, PREFS));
      expect(html).toContain('model-bounced');
      expect(html).toContain('title="Originally ');
    });

    it('marks rows that need an Export with the dot', () => {
      const list = listWith([conv('a', 'A')]);
      expect(renderTable(buildTableModel(list, PREFS))).toContain('new-dot');
    });

    it('checks the select-all box when anything is selected', () => {
      const list = listWith([conv('a', 'A'), conv('b', 'B')]);
      list.check('a', 0, false);
      const html = renderTable(buildTableModel(list, PREFS));
      expect(html).toMatch(/id="selectAll"[^>]*checked/);
    });

    it('leaves the select-all box unchecked when nothing is selected', () => {
      expect(markupFor([conv('a', 'A')])).not.toMatch(
        /id="selectAll"[^>]*checked/,
      );
    });

    it('marks every sortable header with the field its handler reads', () => {
      const html = markupFor([conv('a', 'A')]);
      for (const field of ['name', 'project', 'updated', 'created', 'model']) {
        expect(html).toContain(`data-sort="${field}"`);
      }
    });
  });

  // An Orphan is a row whose claude.ai page no longer exists. Everything about
  // it stays usable — it is selectable and exportable, because the cached copy
  // is the only one left — except the one control that would 404.
  describe('an Orphan row', () => {
    const orphanMarkup = (): string => {
      const list = listWith([conv('gone', 'Deleted chat'), conv('b', 'B')]);
      list.setOrphans(new Set(['gone']));
      return renderTable(buildTableModel(list, PREFS));
    };

    it('does not link the name to a page that is gone', () => {
      expect(orphanMarkup()).not.toContain('https://claude.ai/chat/gone');
    });

    it('still links rows that are not Orphans', () => {
      expect(orphanMarkup()).toContain('https://claude.ai/chat/b');
    });

    it('badges the row so the missing link is explained', () => {
      expect(orphanMarkup()).toContain('orphan-badge');
    });

    it('keeps the Export button, which is the whole point of showing it', () => {
      expect(orphanMarkup()).toContain(
        '<button class="btn-small btn-export" data-id="gone"',
      );
    });

    it('keeps the checkbox, so an Orphan can join a bulk Export', () => {
      expect(orphanMarkup()).toContain(
        'class="conversation-checkbox" data-id="gone"',
      );
    });

    it('escapes an Orphan name, which no longer goes through the link path', () => {
      const list = listWith([conv('gone', '<script>alert(1)</script>')]);
      list.setOrphans(new Set(['gone']));
      const html = renderTable(buildTableModel(list, PREFS));
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });
});
