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

// Two pieces of module-level state, both deliberately so: each describes this
// JavaScript context's single relationship with one database, and every caller
// of every function below must observe the same value. Neither can become a
// local or a parameter without threading it through the whole file.

/**
 * Latches for the life of this context once the browser refuses a write.
 * Retrying after a quota failure only burns time — every subsequent write in
 * the same run fails the same way. It must never fail the export itself: the
 * bytes are already in memory and the ZIP is unaffected (ADR-0002).
 *
 * Reset only by clearRecords (space was just reclaimed, so the next write may
 * genuinely succeed) and by the test seam.
 */
let quotaExceeded = false;

/**
 * The memoised connection. Module-level because it is the memo: hoisting it
 * into a function would open a second connection per call, and a second
 * connection blocks the version change that drops the stores. It is nulled
 * from three places — a failed open, `onversionchange`, and the test seam —
 * each of which means the handle we were holding is no longer good.
 */
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

/** An open, signature-checked connection. Says nothing about caching it. */
const connect = async (): Promise<IDBDatabase> => {
  const db = await openDatabase();
  await enforceSignature(db);
  return db;
};

/**
 * Never leave a failed open memoised — the next call gets a fresh attempt,
 * which matters because the usual causes (an upgrade blocked by another tab, a
 * transient open error) clear on their own.
 */
const forgetOnFailure = (
  pending: Promise<IDBDatabase>,
): Promise<IDBDatabase> => {
  return pending.catch((error) => {
    dbPromise = null;
    throw new Error('Could not connect to the Chat Cache', { cause: error });
  });
};

const getDatabase = (): Promise<IDBDatabase> => {
  dbPromise ??= forgetOnFailure(connect());
  return dbPromise;
};

const getRecord = async (uuid: string): Promise<CacheRecord | undefined> => {
  const db = await getDatabase();
  const tx = db.transaction(STORE_NAME, 'readonly');
  return promisify<CacheRecord | undefined>(
    tx.objectStore(STORE_NAME).get(uuid),
  );
};

const writeRecord = async (record: CacheRecord): Promise<void> => {
  const db = await getDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  await promisify(tx.objectStore(STORE_NAME).put(record));
};

/** Resolves false when the write was refused for want of space. */
const putRecord = async (record: CacheRecord): Promise<boolean> => {
  if (quotaExceeded) return false;

  try {
    await writeRecord(record);
    return true;
  } catch (error) {
    // Anything that is not the disk being full is the caller's problem to log.
    if (!isQuotaError(error)) {
      throw new Error('Could not write to the Chat Cache', { cause: error });
    }
    quotaExceeded = true;
    return false;
  }
};

const clearRecords = async (): Promise<void> => {
  const db = await getDatabase();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  await promisify(tx.objectStore(STORE_NAME).clear());
  quotaExceeded = false;
};

/**
 * Every cached uuid, keys only.
 *
 * `getAllKeys` rather than a cursor over the records because the values are the
 * whole point of the cache: a large account's records run to hundreds of
 * megabytes, and Orphan detection needs no byte of them — only which uuids are
 * present, to diff against the conversation list. Reading the values to answer
 * a question about the keys would deserialise the entire cache to find the
 * handful of entries that are no longer upstream.
 */
const listRecordUuids = async (): Promise<string[]> => {
  const db = await getDatabase();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const keys = await promisify(tx.objectStore(STORE_NAME).getAllKeys());
  // keyPath is 'uuid', so every key is the string it was written under. The
  // predicate is how that is established rather than asserted.
  return keys.filter((key): key is string => typeof key === 'string');
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
  listRecordUuids,
  putRecord,
  resetForTests,
};
