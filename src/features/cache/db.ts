// IndexedDB access for the Chat Cache. Nothing here decides whether a record
// may be used — that is schema.ts. This file only stores and retrieves.
//
// IndexedDB rather than chrome.storage.local because a large account's raw
// conversation JSON is plausibly hundreds of megabytes, far past the 10 MB
// local-storage cap (ADR-0002). It also keeps the cache out of Backup for
// free: backupExtensionData dumps chrome.storage.local wholesale, so anything
// stored there would be swept in silently.

import {
  DB_NAME,
  DB_VERSION,
  META_STORE_NAME,
  REQUEST_SIGNATURE,
  SIGNATURE_KEY,
  STORE_NAME,
} from './schema';
import type { CacheRecord } from './schema';

/**
 * Latches for the life of this context once the browser refuses a write.
 * Retrying after a quota failure only burns time — every subsequent write in
 * the same run fails the same way. It must never fail the export itself: the
 * bytes are already in memory and the ZIP is unaffected (ADR-0002).
 */
let quotaExceeded = false;

let dbPromise: Promise<IDBDatabase> | null = null;

const isQuotaError = (error: unknown): boolean => {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
};

const promisify = <T>(request: IDBRequest<T>): Promise<T> => {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed'));
  });
};

const openDatabase = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    // The cache is never migrated. A version bump means the old shape is gone,
    // so the stores are dropped and rebuilt empty rather than converted.
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [STORE_NAME, META_STORE_NAME]) {
        if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
      }
      db.createObjectStore(STORE_NAME, { keyPath: 'uuid' });
      db.createObjectStore(META_STORE_NAME);
    };

    request.onerror = () =>
      reject(request.error ?? new Error('Could not open the Chat Cache'));
    // Another context still holds the previous version open. Rejecting rather
    // than hanging keeps the export moving — it just runs uncached.
    request.onblocked = () =>
      reject(new Error('Chat Cache upgrade blocked by another tab'));

    request.onsuccess = () => {
      const db = request.result;
      // A newer context wants to upgrade; hold the connection no longer.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
  });
};

/**
 * Drop every record if the request shape changed since they were written.
 *
 * A signature change leaves records that still pass the `updated_at` check
 * while holding a response the exporter no longer asks for. isFresh already
 * refuses to serve them; this reclaims the space they occupy, which at
 * cache-sized volumes is the difference that matters.
 */
const enforceSignature = async (db: IDBDatabase): Promise<void> => {
  const tx = db.transaction([STORE_NAME, META_STORE_NAME], 'readwrite');
  const meta = tx.objectStore(META_STORE_NAME);
  const stored = await promisify<string | undefined>(meta.get(SIGNATURE_KEY));

  if (stored !== REQUEST_SIGNATURE) {
    tx.objectStore(STORE_NAME).clear();
    meta.put(REQUEST_SIGNATURE, SIGNATURE_KEY);
  }
};

const getDatabase = (): Promise<IDBDatabase> => {
  if (!dbPromise) {
    dbPromise = openDatabase()
      .then(async (db) => {
        await enforceSignature(db);
        return db;
      })
      .catch((error) => {
        // Never cache a failed open: the next call gets a fresh attempt.
        dbPromise = null;
        throw error;
      });
  }
  return dbPromise;
};

const getRecord = async (uuid: string): Promise<CacheRecord | undefined> => {
  const db = await getDatabase();
  const tx = db.transaction(STORE_NAME, 'readonly');
  return promisify<CacheRecord | undefined>(
    tx.objectStore(STORE_NAME).get(uuid),
  );
};

/** Resolves false when the write was refused for want of space. */
const putRecord = async (record: CacheRecord): Promise<boolean> => {
  if (quotaExceeded) return false;

  try {
    const db = await getDatabase();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await promisify(tx.objectStore(STORE_NAME).put(record));
    return true;
  } catch (error) {
    if (isQuotaError(error)) {
      quotaExceeded = true;
      return false;
    }
    throw error;
  }
};

const clearRecords = async (): Promise<void> => {
  const db = await getDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  await promisify(tx.objectStore(STORE_NAME).clear());
  quotaExceeded = false;
};

const countRecords = async (): Promise<number> => {
  const db = await getDatabase();
  const tx = db.transaction(STORE_NAME, 'readonly');
  return promisify(tx.objectStore(STORE_NAME).count());
};

const isQuotaExceeded = (): boolean => {
  return quotaExceeded;
};

/** Test seam: forget the cached connection and the quota latch. */
const resetForTests = (): void => {
  dbPromise = null;
  quotaExceeded = false;
};

export {
  clearRecords,
  countRecords,
  getRecord,
  isQuotaExceeded,
  putRecord,
  resetForTests,
};
