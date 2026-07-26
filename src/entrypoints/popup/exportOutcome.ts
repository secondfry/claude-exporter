import type { ExportResponse } from '$entrypoints/content/messages';

// What the user is told after an Export, and — just as load-bearing — whether
// it is told to them permanently.
//
// The status line clears itself after three seconds for 'success' only. A
// partial failure carries the only list of the conversations that did not make
// it, so rendering it as 'success' both reads as "all good" and takes the list
// with it when it disappears. Keeping that decision here, away from the DOM,
// is what lets a spec assert on it: the popup entrypoint cannot be imported
// under the node test environment.

type StatusType = 'error' | 'info' | 'success';

interface StatusMessage {
  message: string;
  type: StatusType;
}

/** The single open conversation — no partial outcome is possible. */
const describeConversationExport = (): StatusMessage => ({
  message: 'Conversation exported successfully!',
  type: 'success',
});

/**
 * A bulk Export. `warnings` is set by the content script when some
 * conversations failed, and it names them — so it stays on screen.
 */
const describeBulkExport = (response: ExportResponse): StatusMessage => {
  if (response.warnings) {
    return { message: response.warnings, type: 'info' };
  }
  return {
    message: `Exported ${response.count} conversations!`,
    type: 'success',
  };
};

export type { StatusMessage, StatusType };
export { describeBulkExport, describeConversationExport };
