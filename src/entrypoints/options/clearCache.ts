// What Clear Cache has to ask before it empties the Chat Cache.
//
// Clearing is normally harmless — ADR-0002 treats the cache as disposable, and
// the worst case is that the next Export refetches. Orphans are the exception:
// their Conversation is gone from claude.ai, so the cached copy is the only
// one that exists and clearing destroys it outright. The button cannot tell
// the two situations apart on its own, hence this.
//
// The decision is separated from the click handler because the interesting
// case is the one that is hardest to reach by hand: not knowing. An unreachable
// claude.ai means the Orphan count is unavailable, and the safe reading of
// "unknown" is the same as "some", not the same as "none".

import { findOrphansSafely } from '$features/cache/orphans';
import { fetchConversationList } from '$features/conversation/api';

/** Null means "could not find out", which is deliberately not zero. */
type OrphanCount = number | null;

interface ClearCachePrompt {
  /** False only when clearing is known to destroy nothing irreplaceable. */
  confirm: boolean;
  message: string;
}

const NO_PROMPT: ClearCachePrompt = { confirm: false, message: '' };

const UNKNOWN_PROMPT: ClearCachePrompt = {
  confirm: true,
  message:
    'Could not check claude.ai for deleted conversations, so this may be ' +
    'destroying the only copy of one. Clear the Chat Cache anyway?',
};

const describeOrphanLoss = (count: number): string => {
  const chats = count === 1 ? 'conversation' : 'conversations';
  const copies = count === 1 ? 'copy' : 'copies';
  return (
    `${count} cached ${chats} no longer exist on claude.ai. Clearing the ` +
    `Chat Cache deletes the only ${copies} permanently. Export them from the ` +
    `browse page first — filter by "Deleted from claude.ai". Clear anyway?`
  );
};

/**
 * Whether to interrupt the user, and with what.
 *
 * Zero is the only answer that clears without asking. A cache with no Orphans
 * holds nothing that cannot be fetched again, and prompting there would train
 * the user to dismiss the prompt that matters.
 */
const clearCachePrompt = (orphans: OrphanCount): ClearCachePrompt => {
  if (orphans === null) return UNKNOWN_PROMPT;
  if (orphans === 0) return NO_PROMPT;
  return { confirm: true, message: describeOrphanLoss(orphans) };
};

/**
 * How many Orphans the cache holds, or null when that cannot be established.
 *
 * Every failure route returns null rather than zero: without the conversation
 * list there is no way to tell an Orphan from a live Conversation, and
 * answering zero would silently turn the guard off exactly when it is needed —
 * offline, signed out, or with Firefox host access revoked.
 */
const countOrphans = async (
  orgId: string | undefined,
): Promise<OrphanCount> => {
  if (!orgId) return null;

  try {
    const live = await fetchConversationList(orgId);
    // An empty list is indistinguishable from a failed fetch here too, and
    // findOrphansSafely refuses to call the whole cache orphaned on one.
    if (live.length === 0) return null;
    return (await findOrphansSafely(live)).length;
  } catch (error) {
    console.warn(
      new Error('Could not check claude.ai for Orphans before clearing', {
        cause: error,
      }),
    );
    return null;
  }
};

export { clearCachePrompt, countOrphans };
export type { ClearCachePrompt, OrphanCount };
