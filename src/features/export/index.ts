import { downloadBlob, exportConversations } from './pipeline';
import {
  bulkZipFilename,
  conversationFilename,
  getLocalDateTimeString,
  mimeForFilename,
  sanitizeFilename,
  zipPrefix,
} from './filenames';
import type {
  ExportFormat,
  ExportHooks,
  ExportOptions,
  ExportProgress,
  ExportResult,
  ExportTarget,
} from './types';

// Download file utility
function downloadFile(
  content: string,
  filename: string,
  type: string = 'application/json'
): void {
  downloadBlob(new Blob([content], { type }), filename);
}

export {
  bulkZipFilename,
  conversationFilename,
  downloadFile,
  exportConversations,
  getLocalDateTimeString,
  mimeForFilename,
  sanitizeFilename,
  zipPrefix,
};

export type {
  ExportFormat,
  ExportHooks,
  ExportOptions,
  ExportProgress,
  ExportResult,
  ExportTarget,
};
