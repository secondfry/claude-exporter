// Resolving the organization ID for the browse page.
//
// Two routes: ask claude.ai from the extension origin, and — when that fails
// or answers nothing — fall back to the last value we stored. Every hop can
// fail for a reason the user cannot act on, so the order and the "a success is
// always persisted" rule are the whole contract. Kept out of index.ts because
// index.ts is DOM wiring a spec cannot import; nothing here touches the DOM.

import { detectOrgId } from '$features/conversation/api';
import { storageGet, storageSet } from '$platform';

const getStoredOrgId = async (): Promise<string | null> => {
  const stored = await storageGet<{ organizationId?: string }>('sync', [
    'organizationId',
  ]);
  return stored.organizationId || null;
};

const detectOrgIdSafely = async (): Promise<string | null> => {
  try {
    return (await detectOrgId()) || null;
  } catch (error) {
    console.warn(
      new Error('Auto-detecting the organization ID failed', { cause: error }),
    );
    return null;
  }
};

/**
 * Detection wins; its answer is persisted so the fallback stays fresh. A
 * failed detection must never overwrite a good stored value with nothing.
 */
const getOrgId = async (): Promise<string | null> => {
  const detected = await detectOrgIdSafely();
  if (!detected) return getStoredOrgId();
  await storageSet('sync', { organizationId: detected });
  return detected;
};

export { getOrgId, getStoredOrgId };
