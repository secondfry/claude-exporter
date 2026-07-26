// Walks a Conversation's message tree from `current_leaf_message_uuid` back to
// the root via each message's parent link, returning that single branch in
// chronological order. Claude conversations are trees, not lists: everything
// that renders or exports one needs the branch the user is actually looking at.

import type { ChatMessage, Conversation } from './types';

// Helper function to reconstruct the current branch from the message tree
const getCurrentBranch = (data: Conversation): ChatMessage[] => {
  if (!data.chat_messages || !data.current_leaf_message_uuid) {
    return [];
  }

  // Create a map of UUID to message for quick lookup
  const messageMap = new Map<string, ChatMessage>();
  data.chat_messages.forEach((msg) => {
    messageMap.set(msg.uuid, msg);
  });

  // Trace back from the current leaf to the root
  const branch: ChatMessage[] = [];
  let currentUuid: string | null | undefined = data.current_leaf_message_uuid;

  while (currentUuid && messageMap.has(currentUuid)) {
    const message: ChatMessage = messageMap.get(currentUuid)!;
    branch.unshift(message); // Add to beginning to maintain order
    currentUuid = message.parent_message_uuid;

    // Stop if we hit the root (parent UUID that doesn't exist in our messages)
    if (!currentUuid || !messageMap.has(currentUuid)) {
      break;
    }
  }

  return branch;
};

export { getCurrentBranch };
