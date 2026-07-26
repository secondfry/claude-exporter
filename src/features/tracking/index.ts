// Owns Export Records (per CONTEXT.md: "the user got a file") and model
// snapshots. Storage keys must stay exactly `exportTimestamps` and
// `modelSnapshots` in chrome.storage.local — existing users' data depends on
// it, and the Backup format contains them verbatim.
//
// Callers get synchronously-queryable "books" (ExportRecordBook,
// ModelDisplayBook) rather than a raw map, so browse can query per-row inside
// a tight render loop without awaiting per row.
//
// Writes AND reads are serialised through a single-tail promise chain
// (`enqueue`), but that only orders operations within ONE JavaScript context.
// The browse page and the content script are separate contexts and can still
// race each other across a storage round-trip; the merge is additive, so the
// worst case is a lost update within that window, not corruption.

import type { ConversationSummary } from '$features/conversation/types';
import { storageGet, storageSet } from '$platform';

/** Maps a conversation UUID to the ISO timestamp of its last Export Record. */
interface ExportRecords {
  [conversationUuid: string]: string;
}

interface ModelSnapshot {
  current: string;
  currentAt: string;
  firstSeen: string;
  firstSeenAt: string;
  history: Array<{ at: string; model: string }>;
}

interface ModelSnapshots {
  [conversationUuid: string]: ModelSnapshot;
}

/**
 * Where a Conversation sits relative to its Export Record.
 * - `never`   — no Export Record at all. Per CONTEXT.md this is NOT Stale:
 *               Stale presupposes a record for the content to be newer than.
 * - `stale`   — has an Export Record, and `updated_at` is later than it.
 * - `current` — has an Export Record no older than `updated_at`.
 */
type ExportStatus = 'current' | 'never' | 'stale';

interface ExportRecordBook {
  /** Strictly Stale per CONTEXT.md — excludes never-exported. */
  isStale(conv: ConversationSummary): boolean;
  /** `never` or `stale`: what the green dot, auto-select and header count mean. */
  needsExport(conv: ConversationSummary): boolean;
  needsExportCount(convs: readonly ConversationSummary[]): number;
  readonly size: number;
  status(conv: ConversationSummary): ExportStatus;
}

interface DisplayModel {
  bounced: boolean;
  model: string;
  other: string;
  otherLabel: '' | 'Currently' | 'Originally';
}

type ModelPreference = 'current' | 'original';

interface ModelDisplayBook {
  display(conv: ConversationSummary): DisplayModel;
}

// Single-tail promise chain. `queue = queue.then(task, task)` means a
// rejected predecessor neither stalls nor poisons the chain — the next task
// still runs, and only the caller of the rejected task sees its rejection.
let queue: Promise<unknown> = Promise.resolve();

const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
  const result = queue.then(task, task);
  queue = result;
  return result;
};

const readExportRecords = async (): Promise<ExportRecords> => {
  const result = await storageGet<{ exportTimestamps?: ExportRecords }>(
    'local',
    ['exportTimestamps'],
  );
  return result.exportTimestamps || {};
};

const readModelSnapshots = async (): Promise<ModelSnapshots> => {
  const result = await storageGet<{ modelSnapshots?: ModelSnapshots }>(
    'local',
    ['modelSnapshots'],
  );
  return result.modelSnapshots || {};
};

// Never-exported and Stale are different states, and collapsing them was a
// real bug: the browse filter's "Previously exported" hid a Conversation that
// HAD been exported and then edited, because both answered the same boolean.
// The comparison itself is unchanged from the original
// browse/index.js#isNewOrUpdated (line 149-153): a Date comparison, not a
// string comparison, and strictly-later (`>`), so an export recorded at the
// exact same instant as `updated_at` does NOT count as Stale.
const statusOf = (
  conv: ConversationSummary,
  records: ExportRecords,
): ExportStatus => {
  const lastExport = records[conv.uuid];
  if (!lastExport) return 'never';
  return new Date(conv.updated_at) > new Date(lastExport) ? 'stale' : 'current';
};

// Resolve which model to show for a conversation. Honors the `preference`
// ('original' = first-seen, or 'current'). When the chat has been bounced
// (current differs from first-seen), `bounced` is true.
const getDisplayModel = (
  conv: ConversationSummary,
  snapshots: ModelSnapshots,
  preference: ModelPreference,
): { bounced: boolean; model: string; other: string } => {
  const snap = snapshots[conv.uuid];
  if (snap && snap.firstSeen) {
    const original = snap.firstSeen;
    const current = snap.current || snap.firstSeen;
    const bounced = !!snap.current && snap.current !== snap.firstSeen;
    return {
      bounced,
      model: preference === 'current' ? current : original,
      other: preference === 'current' ? original : current,
    };
  }
  return { bounced: false, model: conv.model || '', other: '' };
};

const makeExportRecordBook = (records: ExportRecords): ExportRecordBook => {
  return {
    isStale(conv) {
      return statusOf(conv, records) === 'stale';
    },
    needsExport(conv) {
      return statusOf(conv, records) !== 'current';
    },
    needsExportCount(convs) {
      return convs.filter((conv) => statusOf(conv, records) !== 'current')
        .length;
    },
    get size() {
      return Object.keys(records).length;
    },
    status(conv) {
      return statusOf(conv, records);
    },
  };
};

const makeModelDisplayBook = (
  snapshots: ModelSnapshots,
  preference: ModelPreference,
): ModelDisplayBook => {
  return {
    display(conv) {
      const { bounced, model, other } = getDisplayModel(
        conv,
        snapshots,
        preference,
      );
      const otherLabel: DisplayModel['otherLabel'] = !other
        ? ''
        : preference === 'current'
          ? 'Originally'
          : 'Currently';
      return { bounced, model, other, otherLabel };
    },
  };
};

const loadExportRecords = async (): Promise<ExportRecordBook> => {
  return enqueue(async () => makeExportRecordBook(await readExportRecords()));
};

const emptyExportRecords = (): ExportRecordBook => {
  return makeExportRecordBook({});
};

// Writes an Export Record: the user got a file. Returns the post-write book
// so callers never re-read and never own invalidation. Short-circuits
// without writing when `uuids` is empty.
const recordExports = async (
  uuids: readonly string[],
  at: string = new Date().toISOString(),
): Promise<ExportRecordBook> => {
  return enqueue(async () => {
    if (uuids.length === 0) {
      return makeExportRecordBook(await readExportRecords());
    }
    const records = await readExportRecords();
    for (const uuid of uuids) {
      records[uuid] = at;
    }
    await storageSet('local', { exportTimestamps: records });
    return makeExportRecordBook(records);
  });
};

// The user's manual "mark as exported" override — no file was produced here.
// This is distinct from recordExports (a real Export happened): CONTEXT.md
// defines an Export Record as "the user got a file", which is not strictly
// true for a manual mark, but the extension has no separate concept for it,
// so it shares recordExports' implementation and merge semantics.
const markExported = async (
  uuids: readonly string[],
): Promise<ExportRecordBook> => {
  return recordExports(uuids);
};

const clearExportRecords = async (): Promise<ExportRecordBook> => {
  return enqueue(async () => {
    await storageSet('local', { exportTimestamps: {} });
    return makeExportRecordBook({});
  });
};

const loadModelDisplay = async (
  preference: ModelPreference,
): Promise<ModelDisplayBook> => {
  return enqueue(async () =>
    makeModelDisplayBook(await readModelSnapshots(), preference),
  );
};

const emptyModelDisplay = (preference: ModelPreference): ModelDisplayBook => {
  return makeModelDisplayBook({}, preference);
};

// The snapshot a Conversation should have, or null when nothing about it
// changed. Returning null rather than an equal snapshot is what lets the
// caller decide there is no write to make at all.
const nextSnapshot = (
  existing: ModelSnapshot | undefined,
  model: string,
  now: string,
): ModelSnapshot | null => {
  if (!existing) {
    return {
      current: model,
      currentAt: now,
      firstSeen: model,
      firstSeenAt: now,
      history: [{ at: now, model }],
    };
  }
  if (existing.current === model) return null;
  // A bounce: `firstSeen` is never rewritten, and history only ever grows.
  return {
    ...existing,
    current: model,
    currentAt: now,
    history: [...(existing.history || []), { at: now, model }],
  };
};

const collectSnapshotChanges = (
  conversations: readonly ConversationSummary[],
  snapshots: ModelSnapshots,
  now: string,
): Array<[string, ModelSnapshot]> => {
  const changes: Array<[string, ModelSnapshot]> = [];
  for (const conv of conversations) {
    const model = conv?.model;
    const id = conv?.uuid;
    if (!model || !id) continue; // skip null-model chats — don't snapshot a guess

    const next = nextSnapshot(snapshots[id], model, now);
    if (next) changes.push([id, next]);
  }
  return changes;
};

// Snapshot each conversation's current model so it survives a model bounce
// (e.g. when a model retires and Claude silently moves old chats onto a new
// one). Only the raw API model is recorded — never an inferred guess. This is
// not an Export Record: it says nothing about whether the user got a file.
const recordModelSnapshots = async (
  conversations: ConversationSummary[],
): Promise<void> => {
  return enqueue(async () => {
    if (!Array.isArray(conversations)) return;

    const snapshots = await readModelSnapshots();
    const changes = collectSnapshotChanges(
      conversations,
      snapshots,
      new Date().toISOString(),
    );
    if (changes.length === 0) return;

    for (const [id, snapshot] of changes) snapshots[id] = snapshot;
    await storageSet('local', { modelSnapshots: snapshots });
  });
};

export {
  clearExportRecords,
  emptyExportRecords,
  emptyModelDisplay,
  loadExportRecords,
  loadModelDisplay,
  markExported,
  recordExports,
  recordModelSnapshots,
};
export type {
  DisplayModel,
  ExportRecordBook,
  ExportStatus,
  ModelDisplayBook,
  ModelPreference,
};
