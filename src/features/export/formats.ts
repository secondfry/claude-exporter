import type { ExportFormat } from './types';

// Runtime validation for ExportFormat. It lives here rather than in types.ts
// because that file is type-only, and next to the type rather than in a caller
// because every entrypoint reads the same <select> and would otherwise reach
// for `as ExportFormat` — an assertion on a value the user controls.

const EXPORT_FORMATS = ['json', 'markdown', 'text'] as const;

const isExportFormat = (value: unknown): value is ExportFormat =>
  typeof value === 'string' &&
  EXPORT_FORMATS.some((format) => format === value);

// Returns undefined rather than a default so callers keep the pipeline's own
// default instead of each inventing one.
const toExportFormat = (value: unknown): ExportFormat | undefined =>
  isExportFormat(value) ? value : undefined;

export { EXPORT_FORMATS, isExportFormat, toExportFormat };
