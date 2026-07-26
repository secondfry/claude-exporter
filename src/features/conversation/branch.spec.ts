import { describe, expect, it } from 'vitest';

import { getCurrentBranch } from './branch';
import type { Conversation } from './types';

// Recovered from the pre-split utils.test.js suite. conversation/ was the one
// module that never received a copy of the shared spec during the restructure,
// so these four cases would otherwise have been dropped silently.

describe('getCurrentBranch', () => {
  it('returns empty array when there are no messages', () => {
    const data = {
      chat_messages: [],
      current_leaf_message_uuid: 'x',
    } as unknown as Conversation;
    expect(getCurrentBranch(data)).toEqual([]);
  });

  it('returns empty array when leaf uuid is missing', () => {
    const data = { chat_messages: [{ uuid: 'a' }] } as unknown as Conversation;
    expect(getCurrentBranch(data)).toEqual([]);
  });

  it('walks from leaf back to root in chronological order', () => {
    const data = {
      chat_messages: [
        { parent_message_uuid: 'root', text: 'first', uuid: 'm1' },
        { parent_message_uuid: 'm1', text: 'second', uuid: 'm2' },
        { parent_message_uuid: 'm2', text: 'third', uuid: 'm3' },
      ],
      current_leaf_message_uuid: 'm3',
    } as unknown as Conversation;
    const branch = getCurrentBranch(data);
    expect(branch.map((m) => m.uuid)).toEqual(['m1', 'm2', 'm3']);
  });

  it('only includes messages on the current branch (ignores siblings)', () => {
    // m1 → m2a → m3 (current leaf), m1 → m2b is a sibling branch and should be excluded
    const data = {
      chat_messages: [
        { parent_message_uuid: 'root', text: 'first', uuid: 'm1' },
        { parent_message_uuid: 'm1', text: 'kept', uuid: 'm2a' },
        { parent_message_uuid: 'm1', text: 'sibling', uuid: 'm2b' },
        { parent_message_uuid: 'm2a', text: 'leaf', uuid: 'm3' },
      ],
      current_leaf_message_uuid: 'm3',
    } as unknown as Conversation;
    const branch = getCurrentBranch(data);
    expect(branch.map((m) => m.uuid)).toEqual(['m1', 'm2a', 'm3']);
  });
});
