// The only place browser differences are allowed to live.
//
// Both targets are MV3, where every API used here returns a promise when no
// callback is passed. So this adapter is promise-only on purpose: Firefox's
// browser.* APIs are schema-validated and reject an unexpected trailing
// callback argument outright, which would take the API down on Firefox with no
// fallback. Passing a callback "just in case" is the one shape that cannot
// work on both. Errors surface as rejections, so runtime.lastError never
// needs reading.

const api: typeof chrome = (globalThis as { browser?: typeof chrome }).browser ?? chrome;

// Normalises whatever the API rejected with into an Error, and turns a
// synchronous throw into a rejection so callers only need try/catch or .catch,
// never both.
async function callApi<T>(invoke: () => Promise<T>): Promise<T> {
  try {
    return await invoke();
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

type StorageArea = 'local' | 'sync';

function storageGet<T extends Record<string, unknown>>(
  area: StorageArea,
  keys: string | string[] | null,
): Promise<T> {
  return callApi<T>(() => api.storage[area].get(keys) as Promise<T>);
}

function storageSet(area: StorageArea, items: Record<string, unknown>): Promise<void> {
  return callApi<void>(() => api.storage[area].set(items));
}

function storageRemove(area: StorageArea, keys: string | string[]): Promise<void> {
  return callApi<void>(() => api.storage[area].remove(keys));
}

function queryTabs(query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
  return callApi<chrome.tabs.Tab[]>(() => api.tabs.query(query));
}

function sendMessageToTab<T>(tabId: number, message: unknown): Promise<T> {
  return callApi<T>(() => api.tabs.sendMessage<unknown, T>(tabId, message));
}

function sendMessageToRuntime<T>(message: unknown): Promise<T> {
  return callApi<T>(() => api.runtime.sendMessage<unknown, T>(message));
}

function createTab(properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
  return callApi<chrome.tabs.Tab>(() => api.tabs.create(properties));
}

// MV3 replaced tabs.executeScript with scripting.executeScript. This is the
// only surviving code-level Chrome/Firefox difference in the old tree, and it
// disappeared when Firefox moved to MV3 — both now take the same shape.
function injectScript(tabId: number, files: string[]): Promise<unknown> {
  return callApi<unknown>(() => api.scripting.executeScript({ target: { tabId }, files }));
}

function getExtensionUrl(path: string): string {
  return api.runtime.getURL(path);
}

function getManifestVersion(): string {
  return api.runtime.getManifest().version;
}

function openOptionsPage(): Promise<void> {
  return callApi<void>(() => api.runtime.openOptionsPage());
}

// Firefox MV3 makes host permissions optional and user-revocable, so the
// extension can be installed yet unable to reach claude.ai at all. Chrome
// grants them at install time and these resolve trivially true.
const CLAUDE_ORIGIN = 'https://claude.ai/*';

function hasClaudeAccess(): Promise<boolean> {
  return callApi<boolean>(() => api.permissions.contains({ origins: [CLAUDE_ORIGIN] }));
}

function requestClaudeAccess(): Promise<boolean> {
  return callApi<boolean>(() => api.permissions.request({ origins: [CLAUDE_ORIGIN] }));
}

// Registers a message handler that may reply asynchronously. Returning true
// from the raw listener is what keeps the message channel open; doing it here
// once means feature code never has to remember.
function onMessage(
  handler: (message: any, sender: chrome.runtime.MessageSender) => Promise<unknown> | undefined,
): void {
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const result = handler(message, sender);
    if (!result) return false;
    result.then(sendResponse, error =>
      sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  });
}

function onInstalled(handler: () => void): void {
  api.runtime.onInstalled.addListener(handler);
}

export {
  api,
  callApi,
  storageGet,
  storageSet,
  storageRemove,
  queryTabs,
  sendMessageToTab,
  sendMessageToRuntime,
  createTab,
  injectScript,
  getExtensionUrl,
  getManifestVersion,
  openOptionsPage,
  hasClaudeAccess,
  requestClaudeAccess,
  onMessage,
  onInstalled,
  CLAUDE_ORIGIN,
};
export type { StorageArea };
