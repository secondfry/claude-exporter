import type {
  DetectOrgIdResponse as ContentDetectOrgIdResponse,
  DetectOrgIdRequest,
  FailureResponse,
} from '$entrypoints/content/messages';
import { detectOrgId } from '$features/conversation/api';
import { queryTabs, sendMessageToTab, storageGet, storageSet } from '$platform';

// Resolving the organization ID has three routes of decreasing reliability,
// and every one of them can fail for a reason the user cannot act on. Kept
// out of index.ts because index.ts is DOM wiring and cannot be imported by a
// spec — this file has no DOM in it, so the fallback order is testable.

type DetectOrgIdResponse = ContentDetectOrgIdResponse | FailureResponse;

/** The active claude.ai tab, or null when the user is looking at something else. */
const getClaudeTab = async (): Promise<{ id: number; url: string } | null> => {
  const [tab] = await queryTabs({ active: true, currentWindow: true });
  if (!tab?.url?.includes('claude.ai')) return null;
  if (tab.id === undefined) return null;
  return { id: tab.id, url: tab.url };
};

/** Read the last known organization ID. The route of last resort. */
const getStoredOrgId = async (): Promise<string | undefined> => {
  const result = await storageGet<{ organizationId?: string }>('sync', [
    'organizationId',
  ]);
  return result.organizationId;
};

// Ask the content script, which runs on claude.ai and can read the org ID out
// of the page's own state.
const detectOrgIdViaContentScript = async (): Promise<string | undefined> => {
  try {
    const tab = await getClaudeTab();
    if (!tab) return undefined;

    const request: DetectOrgIdRequest = { action: 'detectOrgId' };
    const response = await sendMessageToTab<DetectOrgIdResponse>(
      tab.id,
      request,
    );
    if (!response?.success) return undefined;
    return response.orgId;
  } catch (error) {
    console.warn(
      new Error('Content script could not detect the organization ID', {
        cause: error,
      }),
    );
    return undefined;
  }
};

// Fetch it from claude.ai directly. Only works when the extension's own origin
// has host access — on Firefox that permission is optional and user-revocable.
const detectOrgIdFromExtensionOrigin = async (): Promise<
  string | undefined
> => {
  try {
    return (await detectOrgId()) || undefined;
  } catch (error) {
    console.warn(
      new Error('Direct claude.ai request for the organization ID failed', {
        cause: error,
      }),
    );
    return undefined;
  }
};

// Order matters: the content script sees the live page, the direct fetch only
// sees what the extension origin is allowed to see.
const ORG_ID_DETECTORS = [
  detectOrgIdViaContentScript,
  detectOrgIdFromExtensionOrigin,
];

/**
 * First detector that answers wins, and its answer is persisted so the stored
 * fallback stays fresh. Persisting used to be repeated at each success site;
 * one loop means a newly added route cannot forget to do it.
 */
const getOrgId = async (): Promise<string | undefined> => {
  for (const detect of ORG_ID_DETECTORS) {
    const orgId = await detect();
    if (!orgId) continue;
    await storageSet('sync', { organizationId: orgId });
    return orgId;
  }
  return getStoredOrgId();
};

export { getClaudeTab, getOrgId, getStoredOrgId };
