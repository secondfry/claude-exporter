import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArtifactFile } from '$features/artifacts';
import type { Conversation } from '$features/conversation/types';

import { exportConversations } from './pipeline';
import type { ExportOptions, ExportTarget } from './types';

vi.mock('$features/conversation/api', () => ({
  fetchConversation: vi.fn(),
}));
vi.mock('$features/artifacts', () => ({
  extractArtifactFiles: vi.fn(() => [] as ArtifactFile[]),
}));
vi.mock('$features/rendering', () => ({
  convertToMarkdown: vi.fn((data: Conversation) => `# ${data.name}`),
  convertToText: vi.fn((data: Conversation) => `TEXT ${data.name}`),
}));
vi.mock('$features/models', () => ({
  inferModel: vi.fn(() => 'claude-test'),
}));
vi.mock('$features/tracking', () => ({
  recordExports: vi.fn(async () => undefined),
}));

const { fetchConversation } = await import('$features/conversation/api');
const { extractArtifactFiles } = await import('$features/artifacts');
const { recordExports } = await import('$features/tracking');

interface CapturedDownload {
  blob: Blob;
  filename: string;
}

let downloads: CapturedDownload[] = [];

// The pipeline hands the file to the browser through an <a download>. Under the
// node test environment there is no DOM, so we stand in for just enough of one
// to capture what would have been downloaded.
const installDomStub = (): void => {
  const blobsByUrl = new Map<string, Blob>();
  let counter = 0;

  const documentStub = {
    body: {
      appendChild: (el: { download: string; href: string }) => {
        const blob = blobsByUrl.get(el.href);
        if (blob) downloads.push({ blob, filename: el.download });
      },
      removeChild: () => {},
    },
    createElement: () => ({ download: '', href: '', click: () => {} }),
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
};

const conversation = (uuid: string, name: string): Conversation => {
  return {
    chat_messages: [{ sender: 'human', text: 'hi', uuid: 'm1' }],
    created_at: '2025-01-01T00:00:00Z',
    name,
    updated_at: '2025-01-02T00:00:00Z',
    uuid,
  };
};

const options = (overrides: Partial<ExportOptions> = {}): ExportOptions => {
  return {
    artifactFormat: 'original',
    extractArtifacts: false,
    flattenArtifacts: false,
    format: 'markdown',
    includeArtifacts: true,
    includeChats: true,
    includeMetadata: true,
    includeThinking: true,
    ...overrides,
  };
};

const targets = (...names: string[]): ExportTarget[] => {
  return names.map((name, i) => ({ name, uuid: `uuid-${i}` }));
};

const zipPaths = async (blob: Blob): Promise<string[]> => {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return Object.keys(zip.files)
    .filter((path) => !zip.files[path].dir)
    .sort();
};

beforeEach(() => {
  downloads = [];
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  installDomStub();
  vi.mocked(fetchConversation).mockImplementation(
    async (_orgId: string, uuid: string) =>
      conversation(uuid, uuid === 'uuid-0' ? 'First chat' : 'Second chat'),
  );
  vi.mocked(extractArtifactFiles).mockReturnValue([]);
});

describe('single conversation, single file', () => {
  it('downloads the file directly instead of a ZIP', async () => {
    const result = await exportConversations(
      'org',
      targets('First chat'),
      options(),
    );

    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe('First chat.md');
    expect(await downloads[0].blob.text()).toBe('# First chat');
    expect(result.exportedIds).toEqual(['uuid-0']);
    expect(result.artifactCount).toBe(0);
  });

  it('sanitises the filename', async () => {
    vi.mocked(fetchConversation).mockResolvedValue(
      conversation('uuid-0', 'a/b: c'),
    );
    await exportConversations(
      'org',
      [{ name: 'a/b: c', uuid: 'uuid-0' }],
      options(),
    );
    expect(downloads[0].filename).toBe('a_b_ c.md');
  });

  it('falls back to the uuid when the conversation is unnamed', async () => {
    vi.mocked(fetchConversation).mockResolvedValue(conversation('uuid-0', ''));
    await exportConversations('org', [{ name: '', uuid: 'uuid-0' }], options());
    expect(downloads[0].filename).toBe('uuid-0.md');
  });

  it('uses the format extension', async () => {
    await exportConversations(
      'org',
      targets('First chat'),
      options({ format: 'json' }),
    );
    expect(downloads[0].filename).toBe('First chat.json');
  });

  it('rejects when the only conversation fails to fetch', async () => {
    vi.mocked(fetchConversation).mockRejectedValue(new Error('HTTP 403'));
    await expect(
      exportConversations('org', targets('First chat'), options()),
    ).rejects.toThrow('HTTP 403');
    expect(downloads).toHaveLength(0);
  });

  it('rejects when chats are off and nothing else is produced', async () => {
    await expect(
      exportConversations(
        'org',
        targets('First chat'),
        options({ includeChats: false }),
      ),
    ).rejects.toThrow('Nothing to export');
  });
});

describe('single conversation, multiple files', () => {
  it('ZIPs nested artifacts under an artifacts/ subfolder at the root', async () => {
    vi.mocked(extractArtifactFiles).mockReturnValue([
      { content: 'print(1)', filename: 'a.py' },
      { content: 'print(2)', filename: 'b.py' },
    ]);

    const result = await exportConversations(
      'org',
      targets('First chat'),
      options({ extractArtifacts: true }),
    );

    expect(downloads[0].filename).toBe('First chat.zip');
    expect(await zipPaths(downloads[0].blob)).toEqual([
      'First chat.md',
      'artifacts/a.py',
      'artifacts/b.py',
    ]);
    expect(result.artifactCount).toBe(2);
  });

  it('puts artifacts at the root when chats are excluded', async () => {
    vi.mocked(extractArtifactFiles).mockReturnValue([
      { content: 'print(1)', filename: 'a.py' },
      { content: 'print(2)', filename: 'b.py' },
    ]);

    await exportConversations(
      'org',
      targets('First chat'),
      options({ extractArtifacts: true, includeChats: false }),
    );

    expect(await zipPaths(downloads[0].blob)).toEqual(['a.py', 'b.py']);
  });

  it('uses Chats/ and prefixed Artifacts/ for the flat layout', async () => {
    vi.mocked(extractArtifactFiles).mockReturnValue([
      { content: 'print(1)', filename: 'a.py' },
    ]);

    await exportConversations(
      'org',
      targets('First chat'),
      options({ flattenArtifacts: true }),
    );

    expect(await zipPaths(downloads[0].blob)).toEqual([
      'Artifacts/First chat_a.py',
      'Chats/First chat.md',
    ]);
  });

  it('downloads the lone artifact directly when it is the only output', async () => {
    vi.mocked(extractArtifactFiles).mockReturnValue([
      { content: 'print(1)', filename: 'a.py' },
    ]);

    await exportConversations(
      'org',
      targets('First chat'),
      options({ extractArtifacts: true, includeChats: false }),
    );

    expect(downloads[0].filename).toBe('a.py');
    expect(await downloads[0].blob.text()).toBe('print(1)');
  });

  it('skips the ZIP when artifact extraction is on but finds nothing', async () => {
    await exportConversations(
      'org',
      targets('First chat'),
      options({ extractArtifacts: true }),
    );
    expect(downloads[0].filename).toBe('First chat.md');
  });
});

describe('multiple conversations', () => {
  it('always ZIPs, with one download and a timestamped name', async () => {
    const result = await exportConversations(
      'org',
      targets('First chat', 'Second chat'),
      options(),
    );

    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toMatch(/^claude-exports-\d{8}-\d{6}\.zip$/);
    expect(await zipPaths(downloads[0].blob)).toEqual([
      'First chat.md',
      'Second chat.md',
    ]);
    expect(result.exportedIds).toEqual(['uuid-0', 'uuid-1']);
  });

  it('gives each conversation its own folder in the nested layout', async () => {
    vi.mocked(extractArtifactFiles).mockReturnValue([
      { content: 'print(1)', filename: 'a.py' },
    ]);

    await exportConversations(
      'org',
      targets('First chat', 'Second chat'),
      options({ extractArtifacts: true }),
    );

    expect(await zipPaths(downloads[0].blob)).toEqual(
      [
        'First chat/artifacts/a.py',
        'First chat/First chat.md',
        'Second chat/artifacts/a.py',
        'Second chat/Second chat.md',
      ].sort(),
    );
  });

  it('uses the claude-artifacts prefix for a flat artifacts-only export', async () => {
    vi.mocked(extractArtifactFiles).mockReturnValue([
      { content: 'print(1)', filename: 'a.py' },
    ]);

    await exportConversations(
      'org',
      targets('First chat', 'Second chat'),
      options({ flattenArtifacts: true, includeChats: false }),
    );

    expect(downloads[0].filename).toMatch(
      /^claude-artifacts-\d{8}-\d{6}\.zip$/,
    );
    expect(await zipPaths(downloads[0].blob)).toEqual([
      'Artifacts/First chat_a.py',
      'Artifacts/Second chat_a.py',
    ]);
  });

  it('reports failures without aborting the whole export', async () => {
    vi.mocked(fetchConversation).mockImplementation(
      async (_orgId: string, uuid: string) => {
        if (uuid === 'uuid-1') throw new Error('HTTP 500');
        return conversation(uuid, 'First chat');
      },
    );

    const result = await exportConversations(
      'org',
      targets('First chat', 'Second chat'),
      options(),
    );

    expect(result.failedNames).toEqual(['Second chat']);
    expect(result.exportedIds).toEqual(['uuid-0']);
    expect(await zipPaths(downloads[0].blob)).toEqual(['First chat.md']);
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
      data.uuid === 'uuid-1' ? [{ content: 'print(1)', filename: 'a.py' }] : [],
    );

    const result = await exportConversations(
      'org',
      targets('First chat', 'Second chat'),
      options({ flattenArtifacts: true, includeChats: false }),
    );

    expect(result.exportedIds).toEqual(['uuid-1']);
    expect(result.failedNames).toEqual([]);
    expect(result.artifactCount).toBe(1);
    expect(await zipPaths(downloads[0].blob)).toEqual([
      'Artifacts/Second chat_a.py',
    ]);
  });

  it('keeps exportedIds in target order regardless of fetch completion order', async () => {
    vi.mocked(fetchConversation).mockImplementation(
      async (_orgId: string, uuid: string) => {
        if (uuid === 'uuid-0')
          await new Promise((resolve) => setTimeout(resolve, 5));
        return conversation(
          uuid,
          uuid === 'uuid-0' ? 'First chat' : 'Second chat',
        );
      },
    );

    const result = await exportConversations(
      'org',
      targets('First chat', 'Second chat'),
      options(),
    );

    expect(result.exportedIds).toEqual(['uuid-0', 'uuid-1']);
  });
});

describe('filenames come from the fetched conversation', () => {
  it('uses the fetched name when the caller supplied none (popup Export Current)', async () => {
    vi.mocked(fetchConversation).mockResolvedValue(
      conversation('uuid-0', 'Quarterly plan'),
    );

    await exportConversations('org', [{ name: '', uuid: 'uuid-0' }], options());

    expect(downloads[0].filename).toBe('Quarterly plan.md');
  });

  it('prefers the fetched name over a stale caller-supplied one', async () => {
    vi.mocked(fetchConversation).mockResolvedValue(
      conversation('uuid-0', 'Renamed chat'),
    );

    await exportConversations(
      'org',
      [{ name: 'Old title', uuid: 'uuid-0' }],
      options(),
    );

    expect(downloads[0].filename).toBe('Renamed chat.md');
  });

  it('sanitises the fetched name and uses it for the single-conversation ZIP', async () => {
    vi.mocked(fetchConversation).mockResolvedValue(
      conversation('uuid-0', 'a/b: c'),
    );
    vi.mocked(extractArtifactFiles).mockReturnValue([
      { content: 'print(1)', filename: 'a.py' },
      { content: 'print(2)', filename: 'b.py' },
    ]);

    await exportConversations(
      'org',
      [{ name: '', uuid: 'uuid-0' }],
      options({ extractArtifacts: true }),
    );

    expect(downloads[0].filename).toBe('a_b_ c.zip');
    expect(await zipPaths(downloads[0].blob)).toEqual([
      'a_b_ c.md',
      'artifacts/a.py',
      'artifacts/b.py',
    ]);
  });

  it('falls back to the uuid when neither the caller nor the response names it', async () => {
    vi.mocked(fetchConversation).mockResolvedValue(conversation('uuid-0', ''));

    await exportConversations('org', [{ name: '', uuid: 'uuid-0' }], options());

    expect(downloads[0].filename).toBe('uuid-0.md');
  });
});

describe('cancellation', () => {
  it('rejects and downloads nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      exportConversations('org', targets('a', 'b'), options(), {
        signal: controller.signal,
      }),
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
      }),
    ).rejects.toThrow(/abort/i);
    expect(downloads).toHaveLength(0);
  });

  it('stops fetching further batches once aborted', async () => {
    const controller = new AbortController();
    vi.mocked(fetchConversation).mockImplementation(
      async (_orgId: string, uuid: string) => {
        controller.abort();
        return conversation(uuid, uuid);
      },
    );

    const many = Array.from({ length: 9 }, (_, i) => ({
      name: `c${i}`,
      uuid: `u${i}`,
    }));
    await expect(
      exportConversations('org', many, options(), {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
    expect(vi.mocked(fetchConversation).mock.calls.length).toBeLessThanOrEqual(
      3,
    );
  });
});

// ---------------------------------------------------------------------------
// Chat Cache (ADR-0002)

const fakeCache = (seed: Conversation[] = []) => {
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
};

describe('the Chat Cache', () => {
  it('serves a conversation whose updated_at still matches, without fetching', async () => {
    const { port } = fakeCache([conversation('uuid-0', 'Cached chat')]);

    const result = await exportConversations(
      'org',
      [
        {
          name: 'Cached chat',
          updatedAt: '2025-01-02T00:00:00Z',
          uuid: 'uuid-0',
        },
      ],
      options(),
      { cache: port },
    );

    expect(fetchConversation).not.toHaveBeenCalled();
    expect(result.fromCache).toBe(1);
    expect(await downloads[0].blob.text()).toBe('# Cached chat');
  });

  it('refetches when the conversation has changed since it was stored', async () => {
    const { port } = fakeCache([conversation('uuid-0', 'Stale copy')]);

    const result = await exportConversations(
      'org',
      [{ name: 'Chat', updatedAt: '2025-06-06T00:00:00Z', uuid: 'uuid-0' }],
      options(),
      { cache: port },
    );

    expect(fetchConversation).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(0);
  });

  // The popup exports the open conversation without ever loading the list.
  it('refetches when the caller supplied no updated_at', async () => {
    const { port } = fakeCache([conversation('uuid-0', 'Cached chat')]);

    await exportConversations('org', targets('First chat'), options(), {
      cache: port,
    });

    expect(fetchConversation).toHaveBeenCalledTimes(1);
  });

  it('stores what it fetched, so the next export can skip the network', async () => {
    const { port, store } = fakeCache();

    await exportConversations('org', targets('First chat'), options(), {
      cache: port,
    });

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
        {
          name: 'First chat',
          updatedAt: '2025-01-02T00:00:00Z',
          uuid: 'uuid-0',
        },
        {
          name: 'Second chat',
          updatedAt: '2025-01-02T00:00:00Z',
          uuid: 'uuid-1',
        },
      ],
      options(),
      { cache: port },
    );

    expect(fetchConversation).not.toHaveBeenCalled();
    expect(result.fromCache).toBe(2);
    expect(await zipPaths(downloads[0].blob)).toEqual([
      'First chat.md',
      'Second chat.md',
    ]);
  });

  // A full cache is a slower next export, never a failed one.
  it('still produces the file when the cache is out of space', async () => {
    const port = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => 'quota' as const),
    };

    const result = await exportConversations(
      'org',
      targets('First chat'),
      options(),
      {
        cache: port,
      },
    );

    expect(result.cacheQuotaExceeded).toBe(true);
    expect(downloads).toHaveLength(1);
  });

  it('exports normally when no cache is supplied at all', async () => {
    const result = await exportConversations(
      'org',
      targets('First chat'),
      options(),
    );

    expect(result.fromCache).toBe(0);
    expect(result.cacheQuotaExceeded).toBe(false);
    expect(downloads).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Export Records (the pipeline writes its own, per CONTEXT.md)

describe('writing Export Records', () => {
  it('records only the succeeded ids, not a target that fetched fine but produced nothing', async () => {
    vi.mocked(extractArtifactFiles).mockImplementation((data: Conversation) =>
      data.uuid === 'uuid-1' ? [{ content: 'print(1)', filename: 'a.py' }] : [],
    );

    const result = await exportConversations(
      'org',
      targets('First chat', 'Second chat'),
      options({ flattenArtifacts: true, includeChats: false }),
    );

    expect(recordExports).toHaveBeenCalledTimes(1);
    expect(recordExports).toHaveBeenCalledWith(['uuid-1']);
    expect(result.exportedIds).toEqual(['uuid-1']);
    expect(result.recordsWritten).toBe(true);
  });

  it('writes no records when the export throws on abort during zipping', async () => {
    const controller = new AbortController();

    await expect(
      exportConversations('org', targets('a', 'b'), options(), {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === 'zipping') controller.abort();
        },
      }),
    ).rejects.toThrow(/abort/i);

    expect(recordExports).not.toHaveBeenCalled();
  });

  it('resolves with recordsWritten: false when recordExports rejects', async () => {
    vi.mocked(recordExports).mockRejectedValueOnce(new Error('storage full'));

    const result = await exportConversations(
      'org',
      targets('First chat'),
      options(),
    );

    expect(downloads).toHaveLength(1);
    expect(result.recordsWritten).toBe(false);
    expect(result.exportedIds).toEqual(['uuid-0']);
  });

  it('resolves with recordsWritten: false for a bulk export whose records fail', async () => {
    vi.mocked(recordExports).mockRejectedValueOnce(new Error('storage full'));

    const result = await exportConversations(
      'org',
      targets('First chat', 'Second chat'),
      options(),
    );

    expect(downloads).toHaveLength(1);
    expect(result.recordsWritten).toBe(false);
    expect(result.exportedIds).toEqual(['uuid-0', 'uuid-1']);
    expect(await zipPaths(downloads[0].blob)).toEqual([
      'First chat.md',
      'Second chat.md',
    ]);
  });

  it('does not call recordExports at all for a fully-failed bulk export', async () => {
    vi.mocked(fetchConversation).mockRejectedValue(new Error('HTTP 500'));

    await expect(
      exportConversations(
        'org',
        targets('First chat', 'Second chat'),
        options(),
      ),
    ).rejects.toThrow();

    expect(recordExports).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Batching. Characterisation of what the per-batch accumulators add up to:
// these pin the arithmetic, not the loop that currently performs it.

const named = (count: number): ExportTarget[] => {
  return Array.from({ length: count }, (_, i) => ({
    name: `chat ${i}`,
    updatedAt: '2025-01-02T00:00:00Z',
    uuid: `uuid-${i}`,
  }));
};

describe('batched fetching', () => {
  beforeEach(() => {
    vi.mocked(fetchConversation).mockImplementation(
      (_orgId: string, uuid: string) =>
        Promise.resolve(
          conversation(uuid, `chat ${uuid.slice('uuid-'.length)}`),
        ),
    );
  });

  it('counts fromCache across batches, over the whole run', async () => {
    // Seven targets is three batches; the cache answers four of them, spread
    // across every batch, so a per-batch counter that failed to accumulate
    // would show up here.
    const cached = [0, 2, 4, 6].map((i) =>
      conversation(`uuid-${i}`, `chat ${i}`),
    );
    const { port } = fakeCache(cached);

    const result = await exportConversations('org', named(7), options(), {
      cache: port,
    });

    expect(result.fromCache).toBe(4);
    expect(fetchConversation).toHaveBeenCalledTimes(3);
    expect(result.exportedIds).toHaveLength(7);
  });

  it('flags cacheQuotaExceeded from a single late write without failing anything', async () => {
    let writes = 0;
    const port = {
      read: vi.fn(() => Promise.resolve(null)),
      write: vi.fn(() => {
        writes += 1;
        return Promise.resolve(
          writes === 5 ? ('quota' as const) : ('stored' as const),
        );
      }),
    };

    const result = await exportConversations('org', named(6), options(), {
      cache: port,
    });

    expect(result.cacheQuotaExceeded).toBe(true);
    expect(result.failedNames).toEqual([]);
    expect(result.exportedIds).toHaveLength(6);
    expect(downloads).toHaveLength(1);
    expect(await zipPaths(downloads[0].blob)).toHaveLength(6);
  });

  it('accumulates failedNames across batches while the survivors still export', async () => {
    vi.mocked(fetchConversation).mockImplementation(
      (_orgId: string, uuid: string) => {
        if (uuid === 'uuid-1' || uuid === 'uuid-4') {
          return Promise.reject(new Error(`HTTP 500 for ${uuid}`));
        }
        return Promise.resolve(
          conversation(uuid, `chat ${uuid.slice('uuid-'.length)}`),
        );
      },
    );

    const result = await exportConversations('org', named(6), options());

    expect([...result.failedNames].sort()).toEqual(['chat 1', 'chat 4']);
    expect(result.exportedIds).toEqual([
      'uuid-0',
      'uuid-2',
      'uuid-3',
      'uuid-5',
    ]);
    expect(downloads).toHaveLength(1);
  });

  it('rejects a single-conversation export with the original error object', async () => {
    const cause = new Error('HTTP 403');
    vi.mocked(fetchConversation).mockRejectedValue(cause);

    await expect(exportConversations('org', named(1), options())).rejects.toBe(
      cause,
    );
  });

  it('keeps ZIP contents in target order however the batch resolves', async () => {
    // uuid-0 is the slowest member of its own batch, so completion order is the
    // exact reverse of input order within each batch.
    vi.mocked(fetchConversation).mockImplementation(
      async (_orgId: string, uuid: string) => {
        const index = Number(uuid.slice('uuid-'.length));
        await new Promise((resolve) => setTimeout(resolve, (3 - index) * 4));
        return conversation(uuid, `chat ${index}`);
      },
    );

    const result = await exportConversations('org', named(3), options());

    expect(result.exportedIds).toEqual(['uuid-0', 'uuid-1', 'uuid-2']);
    expect(recordExports).toHaveBeenCalledWith(['uuid-0', 'uuid-1', 'uuid-2']);
  });

  it('stops between batches when aborted after the first batch of progress', async () => {
    const controller = new AbortController();

    await expect(
      exportConversations('org', named(9), options(), {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === 'fetching') controller.abort();
        },
      }),
    ).rejects.toThrow(/abort/i);

    expect(vi.mocked(fetchConversation).mock.calls.length).toBeLessThanOrEqual(
      3,
    );
    expect(downloads).toHaveLength(0);
    expect(recordExports).not.toHaveBeenCalled();
  });
});
