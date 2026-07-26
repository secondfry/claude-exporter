// Artifact extraction functions for Claude Exporter

import { getCurrentBranch } from '$features/conversation/branch';
import type { ChatMessage, Conversation } from '$features/conversation/types';

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

// Extract artifacts from message content (supports both old and new formats)
function extractArtifactsFromMessage(message: ChatMessage): Artifact[] {
  const artifacts: Artifact[] = [];

  // Check if message has content array (new format)
  if (message.content && Array.isArray(message.content)) {
    for (const content of message.content) {
      // NEW FORMAT: tool_use with display_content.
      // Allowlist real file/artifact producers:
      //   - `artifacts` — legacy artifacts tool (still used when
      //     `enabled_artifacts_attachments` is true)
      //   - `create_file` — skills-runner MCP tool that replaced artifacts
      //     when `enabled_artifacts_attachments` is false. Same json_block
      //     display_content shape (language / code / filename).
      // bash, web_search, repl, view, list_directory, etc. are filtered out.
      if (content.type === 'tool_use' &&
          (content.name === 'artifacts' || content.name === 'create_file') &&
          content.display_content) {
        const displayContent = content.display_content as Record<string, unknown>;

        // Check for code_block format (newer artifact format)
        if (displayContent.type === 'code_block' && displayContent.code) {
          const language = (displayContent.language as string) || 'txt';
          const code = (displayContent.code as string) || '';
          const filename = (displayContent.filename as string) || 'artifact';

          // Extract title from filename (remove path and extension)
          const title = filename.split('/').pop()!.replace(/\.[^.]+$/, '');

          artifacts.push({
            content: code.trim(),
            identifier: null,
            language: language,
            title: title || 'Untitled',
            type: isProgrammingLanguage(language) ? 'code' : 'document',
          });
        }
        // Check for json_block format (older artifact format)
        else if (displayContent.type === 'json_block' && displayContent.json_block) {
          try {
            const artifactData = JSON.parse(displayContent.json_block as string);

            // Only treat as artifact if it has a filename (real artifacts, not tool uses like bash)
            if (artifactData.filename) {
              // Extract artifact details
              const language = artifactData.language || 'txt';
              const code = artifactData.code || '';
              const filename = artifactData.filename;

              // Extract title from filename (remove path and extension)
              const title = filename.split('/').pop().replace(/\.[^.]+$/, '');

              artifacts.push({
                content: code.trim(),
                identifier: null,
                language: language,
                title: title || 'Untitled',
                type: isProgrammingLanguage(language) ? 'code' : 'document',
              });
            }
          } catch (e) {
            // JSON parse failed, skip this artifact
            console.warn('Failed to parse artifact json_block:', e);
          }
        }
      }

      // OLD FORMAT: Check text content for <antArtifact> tags
      if (content.text) {
        const textArtifacts = extractArtifactsFromText(content.text);
        artifacts.push(...textArtifacts);
      }
    }
  }

  // Fallback: Check message.text directly (older format)
  if (message.text) {
    const textArtifacts = extractArtifactsFromText(message.text);
    artifacts.push(...textArtifacts);
  }

  return artifacts;
}

// Extract artifacts from text using regex (OLD FORMAT: <antArtifact> tags)
function extractArtifactsFromText(text: string): Artifact[] {
  const artifactRegex = /<antArtifact[^>]*>([\s\S]*?)<\/antArtifact>/g;
  const artifacts: Artifact[] = [];
  let match;

  while ((match = artifactRegex.exec(text)) !== null) {
    const fullTag = match[0];
    const content = match[1];

    // Extract attributes - handle both old and new formats
    const titleMatch = fullTag.match(/title="([^"]*)"/);
    const typeMatch = fullTag.match(/type="([^"]*)"/);
    const languageMatch = fullTag.match(/language="([^"]*)"/);
    const identifierMatch = fullTag.match(/identifier="([^"]*)"/);

    // Determine the artifact type and language
    let artifactType = 'text';
    let language = 'txt';

    if (typeMatch) {
      const type = typeMatch[1];
      // Map type to language/format
      if (type === 'text/html') {
        language = 'html';
        artifactType = 'code';
      } else if (type === 'text/markdown') {
        language = 'markdown';
        artifactType = 'document';
      } else if (type === 'application/vnd.ant.code') {
        language = languageMatch ? languageMatch[1] : 'txt';
        artifactType = 'code';
      } else if (type === 'text/css') {
        language = 'css';
        artifactType = 'code';
      } else if (type === 'application/vnd.ant.mermaid') {
        language = 'mermaid';
        artifactType = 'document';
      } else if (type === 'application/vnd.ant.react') {
        language = 'jsx';
        artifactType = 'code';
      } else if (type === 'image/svg+xml') {
        language = 'svg';
        artifactType = 'code';
      }
    } else if (languageMatch) {
      // Old format - just language attribute
      language = languageMatch[1];
      artifactType = 'code';
    }

    artifacts.push({
      content: content.trim(),
      identifier: identifierMatch ? identifierMatch[1] : null,
      language: language,
      title: titleMatch ? titleMatch[1] : 'Untitled',
      type: artifactType,
    });
  }

  return artifacts;
}

// Legacy function name for backward compatibility
function extractArtifacts(text: string): Artifact[] {
  return extractArtifactsFromText(text);
}

// Get file extension from language
function getFileExtension(language: string): string {
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
}

// Check if a language is a programming language (should be saved in original format only)
function isProgrammingLanguage(language: string): boolean {
  const programmingLanguages = [
    'javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'c++', 'ruby', 'php',
    'swift', 'go', 'rust', 'jsx', 'tsx', 'shell', 'bash', 'sql', 'kotlin', 'scala',
    'r', 'perl', 'lua', 'dart', 'elixir', 'erlang', 'haskell', 'clojure', 'fsharp',
    'f#', 'c#', 'csharp', 'objective-c', 'ocaml', 'scheme', 'lisp', 'fortran',
    'assembly', 'asm', 'groovy', 'html', 'css', 'scss', 'sass', 'less', 'stylus'
  ];
  return programmingLanguages.includes(language.toLowerCase());
}

// Convert artifact content and filename based on selected format
function convertArtifactFormat(
  content: string,
  language: string,
  baseFilename: string,
  format: ArtifactFormat
): ArtifactFile {
  // Get original extension
  const originalExtension = getFileExtension(language);

  // Keep code files and non-markdown files in original format
  if (isProgrammingLanguage(language) || originalExtension !== '.md') {
    return {
      content: content,
      filename: `${baseFilename}${originalExtension}`
    };
  }

  // For markdown documents, convert based on selected format
  switch (format) {
    case 'json': {
      // Convert to JSON format
      const jsonData = {
        content: content,
        format: 'markdown',
        language: language,
        title: baseFilename
      };

      return {
        content: JSON.stringify(jsonData, null, 2),
        filename: `${baseFilename}.json`
      };
    }
    case 'markdown':

    case 'original':
      // Keep as markdown
      return {
        content: content,
        filename: `${baseFilename}.md`
      };

    case 'text': {
      // Convert to plain text (remove markdown formatting)
      let plainText = content;

      // Remove code blocks
      plainText = plainText.replace(/```[\s\S]*?```/g, (match) => {
        // Extract just the code content without backticks and language
        return match.replace(/```\w*\n?/, '').replace(/\n?```$/, '');
      });

      // Remove inline code
      plainText = plainText.replace(/`([^`]+)`/g, '$1');

      // Remove bold/italic
      plainText = plainText.replace(/\*\*([^*]+)\*\*/g, '$1');
      plainText = plainText.replace(/\*([^*]+)\*/g, '$1');
      plainText = plainText.replace(/__([^_]+)__/g, '$1');
      plainText = plainText.replace(/_([^_]+)_/g, '$1');

      // Remove headers (replace with just the text)
      plainText = plainText.replace(/^#{1,6}\s+(.+)$/gm, '$1');

      // Remove links but keep text
      plainText = plainText.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');

      // Remove images
      plainText = plainText.replace(/!\[([^\]]*)\]\([^\)]+\)/g, '');

      // Remove horizontal rules
      plainText = plainText.replace(/^[-*_]{3,}$/gm, '');

      // Clean up excessive newlines
      plainText = plainText.replace(/\n{3,}/g, '\n\n');

      return {
        content: plainText.trim(),
        filename: `${baseFilename}.txt`
      };
    }

    default:
      // Default to original format
      return {
        content: content,
        filename: `${baseFilename}${originalExtension}`
      };
  }
}

// Extract all artifacts from a conversation into separate files
function extractArtifactFiles(
  data: Conversation,
  artifactFormat: ArtifactFormat = 'original'
): ArtifactFile[] {
  const artifactFiles: ArtifactFile[] = [];
  const usedFilenames = new Set<string>();

  // Get only the current branch messages
  const branchMessages = getCurrentBranch(data);

  for (const message of branchMessages) {
    const artifacts = extractArtifactsFromMessage(message);

    for (const artifact of artifacts) {
      // Generate filename from title and language
      let baseFilename = artifact.title || 'artifact';
      // Sanitize filename (remove invalid characters)
      baseFilename = baseFilename.replace(/[<>:"/\\|?*]/g, '_');

      // Convert artifact based on selected format
      const converted = convertArtifactFormat(
        artifact.content,
        artifact.language,
        baseFilename,
        artifactFormat
      );

      let filename = converted.filename;

      // Handle duplicate filenames
      let counter = 1;
      const extensionMatch = filename.match(/(\.[^.]+)$/);
      const extension = extensionMatch ? extensionMatch[1] : '';
      const nameWithoutExt = extension ? filename.slice(0, -extension.length) : filename;

      while (usedFilenames.has(filename)) {
        filename = `${nameWithoutExt}_${counter}${extension}`;
        counter++;
      }

      usedFilenames.add(filename);

      artifactFiles.push({
        content: converted.content,
        filename: filename
      });
    }
  }

  return artifactFiles;
}

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
