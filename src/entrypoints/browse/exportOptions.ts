// Turning the browse page's option form into an ExportOptions.
//
// Two things live here that used to be inline in index.ts and untestable: the
// narrowing of a <select>'s free-form string into an ExportFormat (previously
// an `as` assertion, i.e. a promise the DOM cannot keep), and the rule that
// three options only mean anything while chats are being included.

import { toExportFormat } from '$features/export/formats';
import type { ExportFormat, ExportOptions } from '$features/export/types';

import { requireInput, requireSelect } from './dom';

/**
 * The fallback for an unrecognised <select> value. It must match what the
 * popup ends up with: both read the same control, and a private copy of this
 * rule here once made the same value export as Markdown from browse and JSON
 * from the popup. `toExportFormat` is the single validator; only the default
 * is a page-level choice, and browse's form defaults to Markdown.
 */
const FALLBACK_FORMAT: ExportFormat = 'markdown';

const asExportFormat = (value: string): ExportFormat =>
  toExportFormat(value) ?? FALLBACK_FORMAT;

/**
 * Thinking blocks, metadata and inline artifacts are all parts of a chat
 * transcript, so excluding transcripts must both disable and clear them —
 * leaving them checked-but-ignored would put the form in a state that lies
 * about what the next Export contains.
 */
const dependentOptionState = (
  chatsEnabled: boolean,
): { checked?: false; disabled: boolean } => {
  return chatsEnabled
    ? { disabled: false }
    : { checked: false, disabled: true };
};

/** The option ids that follow #includeChats. */
const CHAT_DEPENDENT_IDS = [
  'includeThinking',
  'includeMetadata',
  'includeArtifacts',
];

const readExportOptions = (): ExportOptions => {
  return {
    artifactFormat: requireSelect('artifactFormat').value,
    extractArtifacts: requireInput('extractArtifacts').checked,
    flattenArtifacts: requireInput('flattenArtifacts').checked,
    format: asExportFormat(requireSelect('exportFormat').value),
    includeArtifacts: requireInput('includeArtifacts').checked,
    includeChats: requireInput('includeChats').checked,
    includeMetadata: requireInput('includeMetadata').checked,
    includeThinking: requireInput('includeThinking').checked,
  };
};

export {
  asExportFormat,
  CHAT_DEPENDENT_IDS,
  dependentOptionState,
  readExportOptions,
};
