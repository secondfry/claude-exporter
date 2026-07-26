// The only place browser differences are allowed to live.
//
// Both targets are MV3, where every API used here returns a promise when no
// callback is passed, so this adapter is promise-only: one shape, no
// lastError, errors as rejections. Note that Firefox's browser.* APIs are
// schema-validated and reject an unexpected trailing callback, while its
// chrome.* alias still accepts one — so callback-style code does not
// necessarily break on Firefox, it just cannot use browser.*. Going through
// here is about having one shape, not about avoiding a crash.

// Firefox exposes `browser` and aliases `chrome` to it; Chrome exposes only
// `chrome`. Declared rather than asserted so the union is checked, and read off
// globalThis because a bare `browser` is a ReferenceError on Chrome.
declare global {
  var browser: typeof chrome | undefined;
}

const api: typeof chrome = globalThis.browser ?? chrome;

// Normalises whatever the API rejected with into an Error, and turns a
// synchronous throw into a rejection so callers only need try/catch or .catch,
// never both.
const callApi = async <T>(invoke: () => Promise<T>): Promise<T> => {
  try {
    return await invoke();
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

type StorageArea = 'local' | 'sync';

const storageGet = <T extends Record<string, unknown>>(
  area: StorageArea,
  keys: string | string[] | null,
): Promise<T> => {
  return callApi<T>(() => api.storage[area].get(keys));
};

const storageSet = (
  area: StorageArea,
  items: Record<string, unknown>,
): Promise<void> => {
  return callApi<void>(() => api.storage[area].set(items));
};

const storageRemove = (
  area: StorageArea,
  keys: string | string[],
): Promise<void> => {
  return callApi<void>(() => api.storage[area].remove(keys));
};

const queryTabs = (
  query: chrome.tabs.QueryInfo,
): Promise<chrome.tabs.Tab[]> => {
  return callApi<chrome.tabs.Tab[]>(() => api.tabs.query(query));
};

const sendMessageToTab = <T>(tabId: number, message: unknown): Promise<T> => {
  return callApi<T>(() => api.tabs.sendMessage<unknown, T>(tabId, message));
};

const sendMessageToRuntime = <T>(message: unknown): Promise<T> => {
  return callApi<T>(() => api.runtime.sendMessage<unknown, T>(message));
};

const createTab = (
  properties: chrome.tabs.CreateProperties,
): Promise<chrome.tabs.Tab> => {
  return callApi<chrome.tabs.Tab>(() => api.tabs.create(properties));
};

// MV3 replaced tabs.executeScript with scripting.executeScript. This is the
// only surviving code-level Chrome/Firefox difference in the old tree, and it
// disappeared when Firefox moved to MV3 — both now take the same shape.
const injectScript = (tabId: number, files: string[]): Promise<unknown> => {
  return callApi<unknown>(() =>
    api.scripting.executeScript({ files, target: { tabId } }),
  );
};

const getExtensionUrl = (path: string): string => {
  return api.runtime.getURL(path);
};

const getManifestVersion = (): string => {
  return api.runtime.getManifest().version;
};

const getManifestName = (): string => {
  return api.runtime.getManifest().name;
};

const openOptionsPage = (): Promise<void> => {
  return callApi<void>(() => api.runtime.openOptionsPage());
};

// Firefox MV3 makes host permissions optional and user-revocable, so the
// extension can be installed yet unable to reach claude.ai at all. Chrome
// grants them at install time and these resolve trivially true.
const CLAUDE_ORIGIN = 'https://claude.ai/*';

const hasClaudeAccess = (): Promise<boolean> => {
  return callApi<boolean>(() =>
    api.permissions.contains({ origins: [CLAUDE_ORIGIN] }),
  );
};

const requestClaudeAccess = (): Promise<boolean> => {
  return callApi<boolean>(() =>
    api.permissions.request({ origins: [CLAUDE_ORIGIN] }),
  );
};

// Registers a message handler that may reply asynchronously. Returning true
// from the raw listener is what keeps the message channel open; doing it here
// once means feature code never has to remember.
const onMessage = (
  handler: (
    message: any,
    sender: chrome.runtime.MessageSender,
  ) => Promise<unknown> | undefined,
): void => {
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const result = handler(message, sender);
    if (!result) return false;
    result.then(sendResponse, (error) =>
      sendResponse({
        error: error instanceof Error ? error.message : String(error),
        success: false,
      }),
    );
    return true;
  });
};

const onInstalled = (handler: () => void): void => {
  api.runtime.onInstalled.addListener(handler);
};

export {
  api,
  callApi,
  CLAUDE_ORIGIN,
  createTab,
  getExtensionUrl,
  getManifestName,
  getManifestVersion,
  hasClaudeAccess,
  injectScript,
  onInstalled,
  onMessage,
  openOptionsPage,
  queryTabs,
  requestClaudeAccess,
  sendMessageToRuntime,
  sendMessageToTab,
  storageGet,
  storageRemove,
  storageSet,
};
export type { StorageArea };
