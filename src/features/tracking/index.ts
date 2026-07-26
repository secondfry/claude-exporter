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

import { storageGet, storageSet } from '../../platform';
import type { ConversationSummary } from '../conversation/types';

/** Maps a conversation UUID to the ISO timestamp of its last Export Record. */
interface ExportRecords {
  [conversationUuid: string]: string;
}

interface ModelSnapshot {
  firstSeen: string;
  firstSeenAt: string;
  current: string;
  currentAt: string;
  history: Array<{ model: string; at: string }>;
}

interface ModelSnapshots {
  [conversationUuid: string]: ModelSnapshot;
}

interface ExportRecordBook {
  isStale(conv: ConversationSummary): boolean;
  staleCount(convs: readonly ConversationSummary[]): number;
  readonly size: number;
}

interface DisplayModel {
  model: string;
  bounced: boolean;
  other: string;
  otherLabel: 'Originally' | 'Currently' | '';
}

type ModelPreference = 'original' | 'current';

interface ModelDisplayBook {
  display(conv: ConversationSummary): DisplayModel;
}

// Single-tail promise chain. `queue = queue.then(task, task)` means a
// rejected predecessor neither stalls nor poisons the chain — the next task
// still runs, and only the caller of the rejected task sees its rejection.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result;
  return result;
}

async function readExportRecords(): Promise<ExportRecords> {
  const result = await storageGet<{ exportTimestamps?: ExportRecords }>('local', ['exportTimestamps']);
  return result.exportTimestamps || {};
}

async function readModelSnapshots(): Promise<ModelSnapshots> {
  const result = await storageGet<{ modelSnapshots?: ModelSnapshots }>('local', ['modelSnapshots']);
  return result.modelSnapshots || {};
}

// A conversation is stale (new/updated since last export) when it has never
// been exported, or its `updated_at` is later than its Export Record.
// Preserves the exact comparison semantics of the original
// browse/index.js#isNewOrUpdated (line 149-153): a Date comparison, not a
// string comparison, and strictly-later (`>`), so an export recorded at the
// exact same instant as `updated_at` does NOT count as stale.
function isStale(conv: ConversationSummary, records: ExportRecords): boolean {
  const lastExport = records[conv.uuid];
  if (!lastExport) return true; // Never exported
  return new Date(conv.updated_at) > new Date(lastExport);
}

// Resolve which model to show for a conversation. Honors the `preference`
// ('original' = first-seen, or 'current'). When the chat has been bounced
// (current differs from first-seen), `bounced` is true.
function getDisplayModel(
  conv: ConversationSummary,
  snapshots: ModelSnapshots,
  preference: ModelPreference,
): { model: string; bounced: boolean; other: string } {
  const snap = snapshots[conv.uuid];
  if (snap && snap.firstSeen) {
    const original = snap.firstSeen;
    const current = snap.current || snap.firstSeen;
    const bounced = !!snap.current && snap.current !== snap.firstSeen;
    return {
      model: preference === 'current' ? current : original,
      bounced,
      other: preference === 'current' ? original : current,
    };
  }
  return { model: conv.model || '', bounced: false, other: '' };
}

function makeExportRecordBook(records: ExportRecords): ExportRecordBook {
  return {
    isStale(conv) {
      return isStale(conv, records);
    },
    staleCount(convs) {
      let count = 0;
      for (const conv of convs) {
        if (isStale(conv, records)) count += 1;
      }
      return count;
    },
    get size() {
      return Object.keys(records).length;
    },
  };
}

function makeModelDisplayBook(snapshots: ModelSnapshots, preference: ModelPreference): ModelDisplayBook {
  return {
    display(conv) {
      const { model, bounced, other } = getDisplayModel(conv, snapshots, preference);
      const otherLabel: DisplayModel['otherLabel'] = !other ? '' : preference === 'current' ? 'Originally' : 'Currently';
      return { model, bounced, other, otherLabel };
    },
  };
}

async function loadExportRecords(): Promise<ExportRecordBook> {
  return enqueue(async () => makeExportRecordBook(await readExportRecords()));
}

function emptyExportRecords(): ExportRecordBook {
  return makeExportRecordBook({});
}

// Writes an Export Record: the user got a file. Returns the post-write book
// so callers never re-read and never own invalidation. Short-circuits
// without writing when `uuids` is empty.
async function recordExports(uuids: readonly string[], at: string = new Date().toISOString()): Promise<ExportRecordBook> {
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
}

// The user's manual "mark as exported" override — no file was produced here.
// This is distinct from recordExports (a real Export happened): CONTEXT.md
// defines an Export Record as "the user got a file", which is not strictly
// true for a manual mark, but the extension has no separate concept for it,
// so it shares recordExports' implementation and merge semantics.
async function markExported(uuids: readonly string[]): Promise<ExportRecordBook> {
  return recordExports(uuids);
}

async function clearExportRecords(): Promise<ExportRecordBook> {
  return enqueue(async () => {
    await storageSet('local', { exportTimestamps: {} });
    return makeExportRecordBook({});
  });
}

async function loadModelDisplay(preference: ModelPreference): Promise<ModelDisplayBook> {
  return enqueue(async () => makeModelDisplayBook(await readModelSnapshots(), preference));
}

function emptyModelDisplay(preference: ModelPreference): ModelDisplayBook {
  return makeModelDisplayBook({}, preference);
}

// Snapshot each conversation's current model so it survives a model bounce
// (e.g. when a model retires and Claude silently moves old chats onto a new
// one). Only the raw API model is recorded — never an inferred guess.
async function recordModelSnapshots(conversations: ConversationSummary[]): Promise<void> {
  return enqueue(async () => {
    if (!Array.isArray(conversations)) return;

    const snapshots = await readModelSnapshots();
    const now = new Date().toISOString();
    let changed = false;

    for (const conv of conversations) {
      const model = conv && conv.model;
      const id = conv && conv.uuid;
      if (!model || !id) continue; // skip null-model chats — don't snapshot a guess

      const existing = snapshots[id];
      if (!existing) {
        snapshots[id] = {
          firstSeen: model,
          firstSeenAt: now,
          current: model,
          currentAt: now,
          history: [{ model, at: now }],
        };
        changed = true;
      } else if (existing.current !== model) {
        existing.current = model;
        existing.currentAt = now;
        existing.history = existing.history || [];
        existing.history.push({ model, at: now });
        changed = true;
      }
    }

    if (changed) {
      await storageSet('local', { modelSnapshots: snapshots });
    }
  });
}

export {
  loadExportRecords,
  emptyExportRecords,
  recordExports,
  markExported,
  clearExportRecords,
  loadModelDisplay,
  emptyModelDisplay,
  recordModelSnapshots,
};
export type { ExportRecordBook, DisplayModel, ModelPreference, ModelDisplayBook };
