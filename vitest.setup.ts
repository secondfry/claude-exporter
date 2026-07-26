// src/platform reads `chrome` at module load, so anything importing a feature
// that goes through the platform seam needs the global to exist before the
// first import. Providing it here rather than mocking '../../platform' per
// spec means specs exercise the real platform code path.
//
// Storage is a working in-memory implementation: most feature code is a
// read-modify-write over it, and asserting on stored state is far more useful
// than asserting on mock calls.

import { beforeEach, vi } from 'vitest';

type StorageRecord = Record<string, unknown>;

interface StubArea {
  _data: StorageRecord;
  clear(): Promise<void>;
  get(keys: string | string[] | null): Promise<StorageRecord>;
  remove(keys: string | string[]): Promise<void>;
  set(items: StorageRecord): Promise<void>;
}

const createArea = (): StubArea => {
  const data: StorageRecord = {};
  return {
    _data: data,
    async clear() {
      for (const key of Object.keys(data)) delete data[key];
    },
    async get(keys) {
      // Deep-copy on the way out: real chrome.storage structured-clones
      // across the extension boundary, so a caller mutating what it read
      // can never reach back into this stub's data. A shallow `{...data}`
      // would still alias any nested object/array values (e.g. a book's
      // records map), letting a later write retroactively mutate an older
      // caller's already-returned data — a bug real chrome.storage cannot
      // have.
      if (keys === null) return structuredClone(data);
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out: StorageRecord = {};
      for (const key of wanted) {
        if (key in data) out[key] = structuredClone(data[key]);
      }
      return out;
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    async set(items) {
      // Deep-copy on the way in too, for the same reason: the caller's
      // object must not remain live inside the stub after the call returns.
      Object.assign(data, structuredClone(items));
    },
  };
};

const createChromeStub = () => {
  return {
    permissions: {
      contains: vi.fn(async () => true),
      request: vi.fn(async () => true),
    },
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      openOptionsPage: vi.fn(),
      sendMessage: vi.fn(),
      getManifest: () => ({ name: 'Claude Exporter', version: '0.0.0-test' }),
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    scripting: { executeScript: vi.fn() },
    storage: { local: createArea(), sync: createArea() },
    tabs: { create: vi.fn(), query: vi.fn(), sendMessage: vi.fn() },
  };
};

const chromeStub = createChromeStub();

Object.defineProperty(globalThis, 'chrome', {
  configurable: true,
  value: chromeStub,
  writable: true,
});

// src/platform captures `api` once at module load, so the stub object itself
// must survive for the whole run — reset its contents in place rather than
// swapping it. Storage is stateful, and a key leaked from one test is exactly
// the kind of order-dependent failure that wastes an afternoon.
beforeEach(async () => {
  await chromeStub.storage.local.clear();
  await chromeStub.storage.sync.clear();
  vi.clearAllMocks();
});

export {};
