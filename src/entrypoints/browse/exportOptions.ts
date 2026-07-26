// Turning the browse page's option form into an ExportOptions.
//
// Two things live here that used to be inline in index.ts and untestable: the
// narrowing of a <select>'s free-form string into an ExportFormat (previously
// an `as` assertion, i.e. a promise the DOM cannot keep), and the rule that
// three options only mean anything while chats are being included.

import type { ExportFormat, ExportOptions } from '$features/export/types';

import { requireInput, requireSelect } from './dom';

/** A <select> can hold any string; only three of them are formats we emit. */
const asExportFormat = (value: string): ExportFormat => {
  return value === 'json' || value === 'text' ? value : 'markdown';
};

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
