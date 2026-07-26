// Artifact extraction functions for Claude Exporter

import { getCurrentBranch } from '$features/conversation/branch';
import type {
  ChatMessage,
  ContentBlock,
  Conversation,
} from '$features/conversation/types';

/** How artifacts are written out: as-authored, or converted to another form. */
type ArtifactFormat = 'original' | string;

/** An extracted artifact, ready to be written to disk under `filename`. */
interface ArtifactFile {
  content: string;
  filename: string;
}

interface Artifact {
  content: string;
  identifier: string | null;
  language: string;
  title: string;
  type: string;
}

// ============================================================================
// Artifact Extraction Functions
// ============================================================================

// Tools that genuinely produce files:
//   - `artifacts` — legacy artifacts tool (still used when
//     `enabled_artifacts_attachments` is true)
//   - `create_file` — skills-runner MCP tool that replaced artifacts when
//     `enabled_artifacts_attachments` is false. Same json_block
//     display_content shape (language / code / filename).
// bash, web_search, repl, view, list_directory, etc. are filtered out.
const ARTIFACT_TOOL_NAMES = new Set(['artifacts', 'create_file']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The string at `key`, or `fallback` when it is missing, empty or not a string. */
const stringField = (
  source: Record<string, unknown>,
  key: string,
  fallback: string,
): string => {
  const value = source[key];
  if (typeof value !== 'string' || value === '') return fallback;
  return value;
};

/** Artifact titles are the filename's basename with its extension removed. */
const titleFromFilename = (filename: string): string => {
  const basename = filename.split('/').at(-1) ?? filename;
  return basename.replace(/\.[^.]+$/, '') || 'Untitled';
};

const buildFileArtifact = (
  filename: string,
  language: string,
  code: string,
): Artifact => ({
  content: code.trim(),
  identifier: null,
  language: language,
  title: titleFromFilename(filename),
  type: isProgrammingLanguage(language) ? 'code' : 'document',
});

/** Newer artifact format: the display content already carries the code. */
const artifactFromCodeBlock = (
  displayContent: Record<string, unknown>,
): Artifact | null => {
  if (displayContent.type !== 'code_block') return null;
  if (!displayContent.code) return null;
  return buildFileArtifact(
    stringField(displayContent, 'filename', 'artifact'),
    stringField(displayContent, 'language', 'txt'),
    stringField(displayContent, 'code', ''),
  );
};

/** A malformed json_block is dropped, not fatal: the rest of the message still exports. */
const parseJsonBlock = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn(
      new Error('Failed to parse artifact json_block', { cause: error }),
    );
    return null;
  }
};

/** Older artifact format: the details are a JSON string inside the display content. */
const artifactFromJsonBlock = (
  displayContent: Record<string, unknown>,
): Artifact | null => {
  if (displayContent.type !== 'json_block') return null;
  if (typeof displayContent.json_block !== 'string') return null;
  if (!displayContent.json_block) return null;

  const artifactData = parseJsonBlock(displayContent.json_block);
  if (!isRecord(artifactData)) return null;

  // Only a filename marks this as a real artifact rather than a tool use like bash.
  const filename = stringField(artifactData, 'filename', '');
  if (!filename) return null;

  return buildFileArtifact(
    filename,
    stringField(artifactData, 'language', 'txt'),
    stringField(artifactData, 'code', ''),
  );
};

const artifactsFromToolUse = (content: ContentBlock): Artifact[] => {
  if (content.type !== 'tool_use') return [];
  if (content.name === undefined) return [];
  if (!ARTIFACT_TOOL_NAMES.has(content.name)) return [];
  if (!isRecord(content.display_content)) return [];

  const artifact =
    artifactFromCodeBlock(content.display_content) ??
    artifactFromJsonBlock(content.display_content);
  return artifact === null ? [] : [artifact];
};

const artifactsFromContentBlock = (content: ContentBlock): Artifact[] => [
  ...artifactsFromToolUse(content),
  // OLD FORMAT: text content may carry <antArtifact> tags.
  ...(content.text ? extractArtifactsFromText(content.text) : []),
];

/**
 * Extract artifacts from a message in every format claude.ai has used.
 *
 * The `message.text` sweep is deliberately unconditional rather than an `else`
 * on the content-array branch — a message carrying the same tag in both places
 * yields the artifact twice. Pinned by spec; changing it is a behaviour change.
 */
const extractArtifactsFromMessage = (message: ChatMessage): Artifact[] => {
  const fromContent = Array.isArray(message.content)
    ? message.content.flatMap(artifactsFromContentBlock)
    : [];
  const fromText = message.text ? extractArtifactsFromText(message.text) : [];
  return [...fromContent, ...fromText];
};

/** How an `<antArtifact>` MIME type is written out. */
interface ArtifactKind {
  artifactType: string;
  /** `null` means the tag's own `language=` attribute decides. */
  language: string | null;
}

// Anything not listed here — including a type we do not recognise — is treated
// as opaque text, and its `language=` attribute is ignored. Only the untyped
// legacy form (`<antArtifact language="python">`) trusts that attribute alone.
const ARTIFACT_KIND_BY_TYPE: Record<string, ArtifactKind> = {
  'application/vnd.ant.code': { artifactType: 'code', language: null },
  'application/vnd.ant.mermaid': {
    artifactType: 'document',
    language: 'mermaid',
  },
  'application/vnd.ant.react': { artifactType: 'code', language: 'jsx' },
  'image/svg+xml': { artifactType: 'code', language: 'svg' },
  'text/css': { artifactType: 'code', language: 'css' },
  'text/html': { artifactType: 'code', language: 'html' },
  'text/markdown': { artifactType: 'document', language: 'markdown' },
};

const DEFAULT_ARTIFACT_KIND: ArtifactKind = {
  artifactType: 'text',
  language: 'txt',
};

const resolveArtifactKind = (
  type: string | undefined,
  language: string | undefined,
): { artifactType: string; language: string } => {
  if (type === undefined) {
    // Old format — a bare `language` attribute and nothing else.
    if (language === undefined)
      return { artifactType: 'text', language: 'txt' };
    return { artifactType: 'code', language: language };
  }

  const kind = ARTIFACT_KIND_BY_TYPE[type] ?? DEFAULT_ARTIFACT_KIND;
  return {
    artifactType: kind.artifactType,
    language: kind.language ?? language ?? 'txt',
  };
};

/** The first capture group of `pattern`, or undefined when it does not match. */
const captureAttribute = (tag: string, attribute: string): string | undefined =>
  tag.match(new RegExp(`${attribute}="([^"]*)"`))?.[1];

// Extract artifacts from text using regex (OLD FORMAT: <antArtifact> tags)
const extractArtifactsFromText = (text: string): Artifact[] => {
  const artifactRegex = /<antArtifact[^>]*>([\s\S]*?)<\/antArtifact>/g;
  const artifacts: Artifact[] = [];
  let match;

  while ((match = artifactRegex.exec(text)) !== null) {
    const fullTag = match[0];
    const content = match[1];

    // Extract attributes - handle both old and new formats
    const kind = resolveArtifactKind(
      captureAttribute(fullTag, 'type'),
      captureAttribute(fullTag, 'language'),
    );

    artifacts.push({
      content: content.trim(),
      identifier: captureAttribute(fullTag, 'identifier') ?? null,
      language: kind.language,
      title: captureAttribute(fullTag, 'title') ?? 'Untitled',
      type: kind.artifactType,
    });
  }

  return artifacts;
};

// Legacy function name for backward compatibility
const extractArtifacts = (text: string): Artifact[] => {
  return extractArtifactsFromText(text);
};

// Get file extension from language
const getFileExtension = (language: string): string => {
  const languageToExt: Record<string, string> = {
    asm: '.asm',
    assembly: '.asm',
    bash: '.sh',
    bib: '.bib',
    bibtex: '.bib',
    c: '.c',
    'c#': '.cs',
    'c++': '.cpp',
    clojure: '.clj',
    cpp: '.cpp',
    csharp: '.cs',
    css: '.css',
    csv: '.csv',
    dart: '.dart',
    dockerfile: '.dockerfile',
    elixir: '.ex',
    erlang: '.erl',
    'f#': '.fs',
    fortran: '.f90',
    fsharp: '.fs',
    go: '.go',
    gradle: '.gradle',
    groovy: '.groovy',
    haskell: '.hs',
    html: '.html',
    ini: '.ini',
    java: '.java',
    javascript: '.js',
    json: '.json',
    jsx: '.jsx',
    kotlin: '.kt',
    latex: '.tex',
    less: '.less',
    lisp: '.lisp',
    lua: '.lua',
    makefile: '.mk',
    markdown: '.md',
    matlab: '.m',
    md: '.md',
    mermaid: '.mmd',
    'objective-c': '.m',
    ocaml: '.ml',
    perl: '.pl',
    php: '.php',
    python: '.py',
    r: '.r',
    ruby: '.rb',
    rust: '.rs',
    sass: '.sass',
    scala: '.scala',
    scheme: '.scm',
    scss: '.scss',
    shell: '.sh',
    sql: '.sql',
    stylus: '.styl',
    svg: '.svg',
    swift: '.swift',
    tex: '.tex',
    text: '.txt',
    toml: '.toml',
    tsx: '.tsx',
    txt: '.txt',
    typescript: '.ts',
    xml: '.xml',
    yaml: '.yaml',
    yml: '.yml',
  };
  return languageToExt[language.toLowerCase()] || '.txt';
};

// Check if a language is a programming language (should be saved in original format only)
const isProgrammingLanguage = (language: string): boolean => {
  const programmingLanguages = [
    'javascript',
    'typescript',
    'python',
    'java',
    'c',
    'cpp',
    'c++',
    'ruby',
    'php',
    'swift',
    'go',
    'rust',
    'jsx',
    'tsx',
    'shell',
    'bash',
    'sql',
    'kotlin',
    'scala',
    'r',
    'perl',
    'lua',
    'dart',
    'elixir',
    'erlang',
    'haskell',
    'clojure',
    'fsharp',
    'f#',
    'c#',
    'csharp',
    'objective-c',
    'ocaml',
    'scheme',
    'lisp',
    'fortran',
    'assembly',
    'asm',
    'groovy',
    'html',
    'css',
    'scss',
    'sass',
    'less',
    'stylus',
  ];
  return programmingLanguages.includes(language.toLowerCase());
};

// Ordered because each step feeds the next: fences first (so their contents are
// not mangled as inline markup), whitespace cleanup last.
const MARKDOWN_STRIPPERS: ((text: string) => string)[] = [
  // Code blocks — keep the code, drop the backticks and the language tag.
  (text) =>
    text.replace(/```[\s\S]*?```/g, (fence) =>
      fence.replace(/```\w*\n?/, '').replace(/\n?```$/, ''),
    ),
  (text) => text.replace(/`([^`]+)`/g, '$1'), // inline code
  (text) => text.replace(/\*\*([^*]+)\*\*/g, '$1'), // bold
  (text) => text.replace(/\*([^*]+)\*/g, '$1'), // italic
  (text) => text.replace(/__([^_]+)__/g, '$1'), // bold, underscore form
  (text) => text.replace(/_([^_]+)_/g, '$1'), // italic, underscore form
  (text) => text.replace(/^#{1,6}\s+(.+)$/gm, '$1'), // headers
  (text) => text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'), // links keep their text
  (text) => text.replace(/!\[([^\]]*)\]\([^)]+\)/g, ''), // images go entirely
  (text) => text.replace(/^[-*_]{3,}$/gm, ''), // horizontal rules
  (text) => text.replace(/\n{3,}/g, '\n\n'), // excess blank lines
];

const stripMarkdown = (content: string): string =>
  MARKDOWN_STRIPPERS.reduce((text, strip) => strip(text), content).trim();

/** Markdown documents are the only artifacts a format choice can reshape. */
const convertMarkdownArtifact = (
  content: string,
  language: string,
  baseFilename: string,
  format: ArtifactFormat,
): ArtifactFile => {
  if (format === 'json') {
    const jsonData = {
      content: content,
      format: 'markdown',
      language: language,
      title: baseFilename,
    };
    return {
      content: JSON.stringify(jsonData, null, 2),
      filename: `${baseFilename}.json`,
    };
  }

  if (format === 'text') {
    return {
      content: stripMarkdown(content),
      filename: `${baseFilename}.txt`,
    };
  }

  // 'markdown', 'original', and anything unrecognised: leave it as markdown.
  return { content: content, filename: `${baseFilename}.md` };
};

// Convert artifact content and filename based on selected format
const convertArtifactFormat = (
  content: string,
  language: string,
  baseFilename: string,
  format: ArtifactFormat,
): ArtifactFile => {
  const originalExtension = getFileExtension(language);

  // Keep code files and non-markdown files in original format
  if (isProgrammingLanguage(language) || originalExtension !== '.md') {
    return {
      content: content,
      filename: `${baseFilename}${originalExtension}`,
    };
  }

  return convertMarkdownArtifact(content, language, baseFilename, format);
};

/** Filesystem-hostile characters become underscores. */
const sanitizeBaseFilename = (title: string): string =>
  (title || 'artifact').replace(/[<>:"/\\|?*]/g, '_');

/** First writer keeps the bare name; later collisions get `_1`, `_2`, … before the extension. */
const claimUniqueFilename = (filename: string, used: Set<string>): string => {
  const extension = filename.match(/(\.[^.]+)$/)?.[1] ?? '';
  const nameWithoutExt = extension
    ? filename.slice(0, -extension.length)
    : filename;

  let claimed = filename;
  let counter = 1;
  while (used.has(claimed)) {
    claimed = `${nameWithoutExt}_${counter}${extension}`;
    counter++;
  }

  used.add(claimed);
  return claimed;
};

const toArtifactFile = (
  artifact: Artifact,
  format: ArtifactFormat,
  usedFilenames: Set<string>,
): ArtifactFile => {
  const converted = convertArtifactFormat(
    artifact.content,
    artifact.language,
    sanitizeBaseFilename(artifact.title),
    format,
  );
  return {
    content: converted.content,
    filename: claimUniqueFilename(converted.filename, usedFilenames),
  };
};

// Extract all artifacts from a conversation into separate files
const extractArtifactFiles = (
  data: Conversation,
  artifactFormat: ArtifactFormat = 'original',
): ArtifactFile[] => {
  // Only the current branch: alternative branches are not part of an Export.
  const usedFilenames = new Set<string>();
  return getCurrentBranch(data)
    .flatMap(extractArtifactsFromMessage)
    .map((artifact) => toArtifactFile(artifact, artifactFormat, usedFilenames));
};

export {
  convertArtifactFormat,
  extractArtifactFiles,
  extractArtifacts,
  extractArtifactsFromMessage,
  extractArtifactsFromText,
  getFileExtension,
  isProgrammingLanguage,
};
export type { ArtifactFile, ArtifactFormat };
