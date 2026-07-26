// Owns Export Records (per CONTEXT.md: "the user got a file") and model
// snapshots. Storage keys must stay exactly `exportTimestamps` and
// `modelSnapshots` in chrome.storage.local — existing users' data depends on
// it, and the Backup format contains them verbatim.

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

async function loadExportRecords(): Promise<ExportRecords> {
  const result = await storageGet<{ exportTimestamps?: ExportRecords }>('local', ['exportTimestamps']);
  return result.exportTimestamps || {};
}

async function recordExport(uuid: string, at: string = new Date().toISOString()): Promise<void> {
  const records = await loadExportRecords();
  records[uuid] = at;
  await storageSet('local', { exportTimestamps: records });
}

async function recordExports(uuids: string[], at: string = new Date().toISOString()): Promise<void> {
  const records = await loadExportRecords();
  for (const uuid of uuids) {
    records[uuid] = at;
  }
  await storageSet('local', { exportTimestamps: records });
}

async function loadModelSnapshots(): Promise<ModelSnapshots> {
  const result = await storageGet<{ modelSnapshots?: ModelSnapshots }>('local', ['modelSnapshots']);
  return result.modelSnapshots || {};
}

// Snapshot each conversation's current model so it survives a model bounce
// (e.g. when a model retires and Claude silently moves old chats onto a new
// one). Only the raw API model is recorded — never an inferred guess.
async function recordModelSnapshots(conversations: ConversationSummary[]): Promise<void> {
  if (!Array.isArray(conversations)) return;

  const snapshots = await loadModelSnapshots();
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
  preference: 'original' | 'current',
): { model: string; bounced: boolean } {
  const snap = snapshots[conv.uuid];
  if (snap && snap.firstSeen) {
    const original = snap.firstSeen;
    const current = snap.current || snap.firstSeen;
    const bounced = !!snap.current && snap.current !== snap.firstSeen;
    return {
      model: preference === 'current' ? current : original,
      bounced,
    };
  }
  return { model: conv.model || '', bounced: false };
}

export { loadExportRecords, recordExport, recordExports, loadModelSnapshots, recordModelSnapshots, isStale, getDisplayModel };
export type { ExportRecords, ModelSnapshot, ModelSnapshots };
