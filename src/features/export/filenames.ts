// Filename construction for exports. Kept apart from the pipeline because the
// ZIP naming rules (prefix selection, local-time stamp) are user-visible and
// worth testing on their own.

import type { ExportFormat, ExportOptions } from './types';

/** Characters Windows/macOS forbid in a filename, replaced 1:1 with '_'. */
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*]/g;

function sanitizeFilename(name: string): string {
  return name.replace(INVALID_FILENAME_CHARS, '_');
}

/**
 * `20251031-143045` in the user's *local* time — an export named for UTC would
 * not match the clock the user just looked at.
 */
function getLocalDateTimeString(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

/**
 * `claude-artifacts` only when the ZIP holds artifacts and nothing else —
 * i.e. flat layout, no nesting, chats switched off.
 */
function zipPrefix(options: ExportOptions): 'claude-artifacts' | 'claude-exports' {
  const artifactsOnly =
    options.flattenArtifacts && !options.extractArtifacts && !options.includeChats;
  return artifactsOnly ? 'claude-artifacts' : 'claude-exports';
}

/** Name for a bulk (multi-conversation) export ZIP. */
function bulkZipFilename(options: ExportOptions, now: Date = new Date()): string {
  return `${zipPrefix(options)}-${getLocalDateTimeString(now)}.zip`;
}

function extensionForFormat(format: ExportFormat): string {
  switch (format) {
    case 'markdown':
      return 'md';
    case 'text':
      return 'txt';
    default:
      return 'json';
  }
}

/** The transcript filename for one conversation, already sanitised. */
function conversationFilename(displayName: string, format: ExportFormat): string {
  return `${sanitizeFilename(displayName)}.${extensionForFormat(format)}`;
}

function mimeForFilename(filename: string): string {
  if (filename.endsWith('.md')) return 'text/markdown';
  if (filename.endsWith('.txt')) return 'text/plain';
  if (filename.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

export {
  bulkZipFilename,
  conversationFilename,
  extensionForFormat,
  getLocalDateTimeString,
  mimeForFilename,
  sanitizeFilename,
  zipPrefix,
};
