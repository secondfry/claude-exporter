import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArtifactFile, Conversation } from '../conversation/types';
import { exportConversations } from './pipeline';
import type { ExportOptions, ExportTarget } from './types';

vi.mock('../conversation/api', () => ({
  fetchConversation: vi.fn(),
}));
vi.mock('../artifacts', () => ({
  extractArtifactFiles: vi.fn(() => [] as ArtifactFile[]),
}));
vi.mock('../rendering', () => ({
  convertToMarkdown: vi.fn((data: Conversation) => `# ${data.name}`),
  convertToText: vi.fn((data: Conversation) => `TEXT ${data.name}`),
}));
vi.mock('../models', () => ({
  inferModel: vi.fn(() => 'claude-test'),
}));

const { fetchConversation } = await import('../conversation/api');
const { extractArtifactFiles } = await import('../artifacts');

interface CapturedDownload {
  filename: string;
  blob: Blob;
}

let downloads: CapturedDownload[] = [];

// The pipeline hands the file to the browser through an <a download>. Under the
// node test environment there is no DOM, so we stand in for just enough of one
// to capture what would have been downloaded.
function installDomStub(): void {
  const blobsByUrl = new Map<string, Blob>();
  let counter = 0;

  const documentStub = {
    createElement: () => ({ href: '', download: '', click: () => {} }),
    body: {
      appendChild: (el: { href: string; download: string }) => {
        const blob = blobsByUrl.get(el.href);
        if (blob) downloads.push({ filename: el.download, blob });
      },
      removeChild: () => {},
    },
  };

  vi.stubGlobal('document', documentStub);
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => {
      const url = `blob:test/${counter++}`;
      blobsByUrl.set(url, blob);
      return url;
    },
    revokeObjectURL: () => {},
  });
}

function conversation(uuid: string, name: string): Conversation {
  return {
    uuid,
    name,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-02T00:00:00Z',
    chat_messages: [{ uuid: 'm1', sender: 'human', text: 'hi' }],
  };
}

function options(overrides: Partial<ExportOptions> = {}): ExportOptions {
  return {
    format: 'markdown',
    includeChats: true,
    includeThinking: true,
    includeMetadata: true,
    includeArtifacts: true,
    extractArtifacts: false,
    artifactFormat: 'original',
    flattenArtifacts: false,
    ...overrides,
  };
}

function targets(...names: string[]): ExportTarget[] {
  return names.map((name, i) => ({ uuid: `uuid-${i}`, name }));
}

async function zipPaths(blob: Blob): Promise<string[]> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return Object.keys(zip.files)
    .filter((path) => !zip.files[path]!.dir)
    .sort();
}

beforeEach(() => {
  downloads = [];
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  installDomStub();
  vi.mocked(fetchConversation).mockImplementation(async (_orgId: string, uuid: string) =>
    conversation(uuid, uuid === 'uuid-0' ? 'First chat' : 'Second chat')
  );
  vi.mocked(extractArtifactFiles).mockReturnValue([]);
});

describe('single conversation, single file', () => {
  it('downloads the file directly instead of a ZIP', async () => {
    const result = await exportConversations('org', targets('First chat'), options());

    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.filename).toBe('First chat.md');
    expect(await downloads[0]!.blob.text()).toBe('# First chat');
    expect(result.exportedIds).toEqual(['uuid-0']);
    expect(result.artifactCount).toBe(0);
  });

  it('sanitises the filename', async () => {
    vi.mocked(fetchConversation).mockResolvedValue(conversation('uuid-0', 'a/b: c'));
    await exportConversations('org', [{ uuid: 'uuid-0', name: 'a/b: c' }], options());
    expect(downloads[0]!.filename).toBe('a_b_ c.md');
  });

  it('falls back to the uuid when the conversation is unnamed', async () => {
    vi.mocked(fetchConversation).mockResolvedValue(conversation('uuid-0', ''));
    await exportConversations('org', [{ uuid: 'uuid-0', name: '' }], options());
    expect(downloads[0]!.filename).toBe('uuid-0.md');
  });

  it('uses the format extension', async () => {
    await exportConversations('org', targets('First chat'), options({ format: 'json' }));
    expect(downloads[0]!.filename).toBe('First chat.json');
  });

  it('rejects when the only conversation fails to fetch', async () => {
    vi.mocked(fetchConversation).mockRejectedValue(new Error('HTTP 403'));
    await expect(exportConversations('org', targets('First chat'), options())).rejects.toThrow(
      'HTTP 403'
    );
    expect(downloads).toHaveLength(0);
  });

  it('rejects when chats are off and nothing else is produced', async () => {
    await expect(
      exportConversations('org', targets('First chat'), options({ includeChats: false }))
    ).rejects.toThrow('Nothing to export');
  });
});

describe('single conversation, multiple files', () => {
  it('ZIPs nested artifacts under an artifacts/ subfolder at the root', async () => {
    vi.mocked(extractArtifactFiles).mockReturnValue([
      { filename: 'a.py', content: 'print(1)' },
      { filename: 'b.py', content: 'print(2)' },
    ]);

    const result = await exportConversations(
      'org',
      targets('First chat'),
      options({ extractArtifacts: true })
    );

    expect(downloads[0]!.filename).toBe('First chat.zip');
    expect(await zipPaths(downloads[0]!.blob)).toEqual([
      'First chat.md',
      'artifacts/a.py',
      'artifacts/b.py',
    ]);
    expect(result.artifactCount).toBe(2);
  });

  it('puts artifacts at the root when chats are excluded', async () => {
    vi.mocked(extractArtifactFiles).mockReturnValue([
      { filename: 'a.py', content: 'print(1)' },
      { filename: 'b.py', content: 'print(2)' },
    ]);

    await exportConversations(
      'org',
      targets('First chat'),
      options({ extractArtifacts: true, includeChats: false })
    );

    expect(await zipPaths(downloads[0]!.blob)).toEqual(['a.py', 'b.py']);
  });

  it('uses Chats/ and prefixed Artifacts/ for the flat layout', async () => {
    vi.mocked(extractArtifactFiles).mockReturnValue([{ filename: 'a.py', content: 'print(1)' }]);

    await exportConversations(
      'org',
      targets('First chat'),
      options({ flattenArtifacts: true })
    );

    expect(await zipPaths(downloads[0]!.blob)).toEqual([
      'Artifacts/First chat_a.py',
      'Chats/First chat.md',
    ]);
  });

  it('downloads the lone artifact directly when it is the only output', async () => {
    vi.mocked(extractArtifactFiles).mockReturnValue([{ filename: 'a.py', content: 'print(1)' }]);

    await exportConversations(
      'org',
      targets('First chat'),
      options({ extractArtifacts: true, includeChats: false })
    );

    expect(downloads[0]!.filename).toBe('a.py');
    expect(await downloads[0]!.blob.text()).toBe('print(1)');
  });

  it('skips the ZIP when artifact extraction is on but finds nothing', async () => {
    await exportConversations(
      'org',
      targets('First chat'),
      options({ extractArtifacts: true })
    );
    expect(downloads[0]!.filename).toBe('First chat.md');
  });
});

describe('multiple conversations', () => {
  it('always ZIPs, with one download and a timestamped name', async () => {
    const result = await exportConversations('org', targets('First chat', 'Second chat'), options());

    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.filename).toMatch(/^claude-exports-\d{8}-\d{6}\.zip$/);
    expect(await zipPaths(downloads[0]!.blob)).toEqual(['First chat.md', 'Second chat.md']);
    expect(result.exportedIds).toEqual(['uuid-0', 'uuid-1']);
  });

  it('gives each conversation its own folder in the nested layout', async () => {
    vi.mocked(extractArtifactFiles).mockReturnValue([{ filename: 'a.py', content: 'print(1)' }]);

    await exportConversations(
      'org',
      targets('First chat', 'Second chat'),
      options({ extractArtifacts: true })
    );

    expect(await zipPaths(downloads[0]!.blob)).toEqual([
      'First chat/artifacts/a.py',
      'First chat/First chat.md',
      'Second chat/artifacts/a.py',
      'Second chat/Second chat.md',
    ].sort());
  });

  it('uses the claude-artifacts prefix for a flat artifacts-only export', async () => {
    vi.mocked(extractArtifactFiles).mockReturnValue([{ filename: 'a.py', content: 'print(1)' }]);

    await exportConversations(
      'org',
      targets('First chat', 'Second chat'),
      options({ flattenArtifacts: true, includeChats: false })
    );

    expect(downloads[0]!.filename).toMatch(/^claude-artifacts-\d{8}-\d{6}\.zip$/);
    expect(await zipPaths(downloads[0]!.blob)).toEqual([
      'Artifacts/First chat_a.py',
      'Artifacts/Second chat_a.py',
    ]);
  });

  it('reports failures without aborting the whole export', async () => {
    vi.mocked(fetchConversation).mockImplementation(async (_orgId: string, uuid: string) => {
      if (uuid === 'uuid-1') throw new Error('HTTP 500');
      return conversation(uuid, 'First chat');
    });

    const result = await exportConversations('org', targets('First chat', 'Second chat'), options());

    expect(result.failedNames).toEqual(['Second chat']);
    expect(result.exportedIds).toEqual(['uuid-0']);
    expect(await zipPaths(downloads[0]!.blob)).toEqual(['First chat.md']);
  });

  it('reports fetching then zipping progress', async () => {
    const phases = new Set<string>();
    await exportConversations('org', targets('a', 'b'), options(), {
      onProgress: (p) => phases.add(p.phase),
    });
    expect(phases).toContain('fetching');
    expect(phases).toContain('zipping');
  });
});

describe('Export Records only for conversations that produced a file', () => {
  it('omits conversations that contributed nothing to the output', async () => {
    // Chats off, artifacts flat: only the second conversation has artifacts, so
    // only it may get an Export Record. The other one never became a file.
    vi.mocked(extractArtifactFiles).mockImplementation((data: Conversation) =>
      data.uuid === 'uuid-1' ? [{ filename: 'a.py', content: 'print(1)' }] : []
    );

    const result = await exportConversations(
      'org',
      targets('First chat', 'Second chat'),
      options({ flattenArtifacts: true, includeChats: false })
    );

    expect(result.exportedIds).toEqual(['uuid-1']);
    expect(result.failedNames).toEqual([]);
    expect(result.artifactCount).toBe(1);
    expect(await zipPaths(downloads[0]!.blob)).toEqual(['Artifacts/Second chat_a.py']);
  });

  it('keeps exportedIds in target order regardless of fetch completion order', async () => {
    vi.mocked(fetchConversation).mockImplementation(async (_orgId: string, uuid: string) => {
      if (uuid === 'uuid-0') await new Promise((resolve) => setTimeout(resolve, 5));
      return conversation(uuid, uuid === 'uuid-0' ? 'First chat' : 'Second chat');
    });

    const result = await exportConversations(
      'org',
      targets('First chat', 'Second chat'),
      options()
    );

    expect(result.exportedIds).toEqual(['uuid-0', 'uuid-1']);
  });
});

describe('filenames come from the fetched conversation', () => {
  it('uses the fetched name when the caller supplied none (popup Export Current)', async () => {
    vi.mocked(fetchConversation).mockResolvedValue(conversation('uuid-0', 'Quarterly plan'));

    await exportConversations('org', [{ uuid: 'uuid-0', name: '' }], options());

    expect(downloads[0]!.filename).toBe('Quarterly plan.md');
  });

  it('prefers the fetched name over a stale caller-supplied one', async () => {
    vi.mocked(fetchConversation).mockResolvedValue(conversation('uuid-0', 'Renamed chat'));

    await exportConversations('org', [{ uuid: 'uuid-0', name: 'Old title' }], options());

    expect(downloads[0]!.filename).toBe('Renamed chat.md');
  });

  it('sanitises the fetched name and uses it for the single-conversation ZIP', async () => {
    vi.mocked(fetchConversation).mockResolvedValue(conversation('uuid-0', 'a/b: c'));
    vi.mocked(extractArtifactFiles).mockReturnValue([
      { filename: 'a.py', content: 'print(1)' },
      { filename: 'b.py', content: 'print(2)' },
    ]);

    await exportConversations(
      'org',
      [{ uuid: 'uuid-0', name: '' }],
      options({ extractArtifacts: true })
    );

    expect(downloads[0]!.filename).toBe('a_b_ c.zip');
    expect(await zipPaths(downloads[0]!.blob)).toEqual([
      'a_b_ c.md',
      'artifacts/a.py',
      'artifacts/b.py',
    ]);
  });

  it('falls back to the uuid when neither the caller nor the response names it', async () => {
    vi.mocked(fetchConversation).mockResolvedValue(conversation('uuid-0', ''));

    await exportConversations('org', [{ uuid: 'uuid-0', name: '' }], options());

    expect(downloads[0]!.filename).toBe('uuid-0.md');
  });
});

describe('cancellation', () => {
  it('rejects and downloads nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      exportConversations('org', targets('a', 'b'), options(), { signal: controller.signal })
    ).rejects.toThrow(/abort/i);
    expect(fetchConversation).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(0);
  });

  it('downloads nothing when cancelled during ZIP generation', async () => {
    const controller = new AbortController();

    await expect(
      exportConversations('org', targets('a', 'b'), options(), {
        signal: controller.signal,
        // Fetching is done by the time zipping starts; cancelling here used to
        // hide the modal and then download the file anyway.
        onProgress: (p) => {
          if (p.phase === 'zipping') controller.abort();
        },
      })
    ).rejects.toThrow(/abort/i);
    expect(downloads).toHaveLength(0);
  });

  it('stops fetching further batches once aborted', async () => {
    const controller = new AbortController();
    vi.mocked(fetchConversation).mockImplementation(async (_orgId: string, uuid: string) => {
      controller.abort();
      return conversation(uuid, uuid);
    });

    const many = Array.from({ length: 9 }, (_, i) => ({ uuid: `u${i}`, name: `c${i}` }));
    await expect(
      exportConversations('org', many, options(), { signal: controller.signal })
    ).rejects.toThrow(/abort/i);
    expect(vi.mocked(fetchConversation).mock.calls.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Chat Cache (ADR-0002)

function fakeCache(seed: Conversation[] = []) {
  const store = new Map(seed.map((conv) => [conv.uuid, conv]));
  const port = {
    read: vi.fn(async (uuid: string, updatedAt: string | undefined) => {
      const found = store.get(uuid);
      return found && updatedAt === found.updated_at ? found : null;
    }),
    write: vi.fn(async (conv: Conversation) => {
      store.set(conv.uuid, conv);
      return 'stored' as const;
    }),
  };
  return { port, store };
}

describe('the Chat Cache', () => {
  it('serves a conversation whose updated_at still matches, without fetching', async () => {
    const { port } = fakeCache([conversation('uuid-0', 'Cached chat')]);

    const result = await exportConversations(
      'org',
      [{ uuid: 'uuid-0', name: 'Cached chat', updatedAt: '2025-01-02T00:00:00Z' }],
      options(),
      { cache: port }
    );

    expect(fetchConversation).not.toHaveBeenCalled();
    expect(result.fromCache).toBe(1);
    expect(await downloads[0]!.blob.text()).toBe('# Cached chat');
  });

  it('refetches when the conversation has changed since it was stored', async () => {
    const { port } = fakeCache([conversation('uuid-0', 'Stale copy')]);

    const result = await exportConversations(
      'org',
      [{ uuid: 'uuid-0', name: 'Chat', updatedAt: '2025-06-06T00:00:00Z' }],
      options(),
      { cache: port }
    );

    expect(fetchConversation).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(0);
  });

  // The popup exports the open conversation without ever loading the list.
  it('refetches when the caller supplied no updated_at', async () => {
    const { port } = fakeCache([conversation('uuid-0', 'Cached chat')]);

    await exportConversations('org', targets('First chat'), options(), { cache: port });

    expect(fetchConversation).toHaveBeenCalledTimes(1);
  });

  it('stores what it fetched, so the next export can skip the network', async () => {
    const { port, store } = fakeCache();

    await exportConversations('org', targets('First chat'), options(), { cache: port });

    expect(store.get('uuid-0')).toBeDefined();
    // Stored raw: the model this run inferred is not baked into the record.
    expect(port.write).toHaveBeenCalledTimes(1);
  });

  it('does not touch the network at all when every target is cached', async () => {
    const { port } = fakeCache([
      conversation('uuid-0', 'First chat'),
      conversation('uuid-1', 'Second chat'),
    ]);

    const result = await exportConversations(
      'org',
      [
        { uuid: 'uuid-0', name: 'First chat', updatedAt: '2025-01-02T00:00:00Z' },
        { uuid: 'uuid-1', name: 'Second chat', updatedAt: '2025-01-02T00:00:00Z' },
      ],
      options(),
      { cache: port }
    );

    expect(fetchConversation).not.toHaveBeenCalled();
    expect(result.fromCache).toBe(2);
    expect(await zipPaths(downloads[0]!.blob)).toEqual(['First chat.md', 'Second chat.md']);
  });

  // A full cache is a slower next export, never a failed one.
  it('still produces the file when the cache is out of space', async () => {
    const port = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => 'quota' as const),
    };

    const result = await exportConversations('org', targets('First chat'), options(), {
      cache: port,
    });

    expect(result.cacheQuotaExceeded).toBe(true);
    expect(downloads).toHaveLength(1);
  });

  it('exports normally when no cache is supplied at all', async () => {
    const result = await exportConversations('org', targets('First chat'), options());

    expect(result.fromCache).toBe(0);
    expect(result.cacheQuotaExceeded).toBe(false);
    expect(downloads).toHaveLength(1);
  });
});
