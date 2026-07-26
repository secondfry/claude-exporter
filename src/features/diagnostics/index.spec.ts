import { afterEach, describe, expect, it, vi } from 'vitest';

import { storageGet, storageSet } from '$platform';

import {
  CE_ERROR_LOG_MAX,
  initErrorCapture,
  readErrorLog,
  sanitizeForDiagnostics,
} from './index';
import type { ErrorLogEntry } from './index';

describe('sanitizeForDiagnostics', () => {
  it('replaces one UUID', () => {
    const result = sanitizeForDiagnostics(
      'chat/11111111-2222-3333-4444-555555555555/x',
    );
    expect(result).toBe('chat/<id>/x');
  });

  it('replaces multiple UUIDs in one string', () => {
    const input =
      '11111111-2222-3333-4444-555555555555 and 66666666-7777-8888-9999-000000000000';
    const result = sanitizeForDiagnostics(input);
    expect(result).toBe('<id> and <id>');
  });

  it('is case-insensitive', () => {
    const result = sanitizeForDiagnostics(
      'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
    );
    expect(result).toBe('<id>');
  });

  it('leaves UUID-free strings untouched', () => {
    const result = sanitizeForDiagnostics('no ids here, just text');
    expect(result).toBe('no ids here, just text');
  });
});

describe('readErrorLog', () => {
  it('returns [] for undefined', () => {
    expect(readErrorLog(undefined)).toEqual([]);
  });

  it('returns [] for null', () => {
    expect(readErrorLog(null)).toEqual([]);
  });

  it('returns [] for a non-array', () => {
    expect(readErrorLog({ msg: 'y', ts: 'x' })).toEqual([]);
  });

  it('filters out entries missing ts or msg', () => {
    const entries = [
      {
        context: undefined,
        level: 'error',
        msg: 'ok',
        ts: '2026-01-01T00:00:00.000Z',
      },
      { context: undefined, level: 'error', msg: 'missing ts' },
      { context: undefined, level: 'error', ts: '2026-01-01T00:00:00.000Z' },
    ];
    const result = readErrorLog(entries);
    expect(result).toEqual([
      {
        context: undefined,
        level: 'error',
        msg: 'ok',
        ts: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('keeps well-formed entries', () => {
    const entries = [
      {
        col: 2,
        context: 'ctx',
        level: 'error',
        line: 1,
        msg: 'boom',
        source: 's',
        stack: 'st',
        ts: '2026-01-01T00:00:00.000Z',
      },
      {
        context: undefined,
        level: 'unhandledrejection',
        msg: 'rejected',
        ts: '2026-01-02T00:00:00.000Z',
      },
    ];
    const result = readErrorLog(entries);
    expect(result).toEqual(entries);
  });
});

describe('CE_ERROR_LOG_MAX', () => {
  it('is 50', () => {
    expect(CE_ERROR_LOG_MAX).toBe(50);
  });
});

describe('initErrorCapture', () => {
  type Listener = (event: unknown) => void;

  // The test environment is node, where globalThis is not an EventTarget, so
  // there is nothing to spy on — stub addEventListener and keep whatever
  // initErrorCapture registers.
  const capture = (context?: string): Map<string, Listener> => {
    const listeners = new Map<string, Listener>();
    vi.stubGlobal('addEventListener', (type: string, listener: Listener) => {
      listeners.set(type, listener);
    });
    initErrorCapture(context);
    return listeners;
  };

  // push() fires an un-awaited async IIFE, so the storage round-trip has to be
  // let out through the macrotask queue before the log can be read back.
  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const storedLog = async (): Promise<ErrorLogEntry[]> => {
    const stored = await storageGet<{ errorLog?: unknown }>('local', [
      'errorLog',
    ]);
    return readErrorLog(stored.errorLog);
  };

  const errorEvent = (overrides: Record<string, unknown> = {}) => {
    return {
      colno: 3,
      error: new Error('boom'),
      filename: 'chrome-extension://abc/browse.js',
      lineno: 2,
      message: 'boom',
      ...overrides,
    };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers exactly the error and unhandledrejection listeners', () => {
    const listeners = capture();
    expect([...listeners.keys()].sort()).toEqual([
      'error',
      'unhandledrejection',
    ]);
  });

  it('appends a sanitized entry, redacting UUIDs in message, filename and stack', async () => {
    const listeners = capture('browse');
    const error = new Error('failed');
    error.stack =
      'at fetch (https://claude.ai/api/organizations/11111111-2222-3333-4444-555555555555/chat)';

    listeners.get('error')?.(
      errorEvent({
        error,
        filename:
          'chrome-extension://abc/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE.js',
        message: 'boom for 66666666-7777-8888-9999-000000000000',
      }),
    );
    await flush();

    const log = await storedLog();
    expect(log).toHaveLength(1);
    expect(log[0].msg).toBe('boom for <id>');
    expect(log[0].source).toBe('chrome-extension://abc/<id>.js');
    expect(log[0].stack).toBe(
      'at fetch (https://claude.ai/api/organizations/<id>/chat)',
    );
    expect(log[0].context).toBe('browse');
    expect(log[0].level).toBe('error');
    expect(log[0].col).toBe(3);
    expect(log[0].line).toBe(2);
  });

  it('records a null stack when the event carries no Error', async () => {
    const listeners = capture();

    listeners.get('error')?.(errorEvent({ error: undefined, filename: '' }));
    await flush();

    const log = await storedLog();
    expect(log[0].stack).toBeNull();
    expect(log[0].source).toBeNull();
  });

  it('trims the ring buffer to CE_ERROR_LOG_MAX, keeping the newest', async () => {
    const existing = Array.from({ length: CE_ERROR_LOG_MAX }, (_, i) => ({
      context: undefined,
      level: 'error',
      msg: `old ${i}`,
      ts: '2026-01-01T00:00:00.000Z',
    }));
    await storageSet('local', { errorLog: existing });
    const listeners = capture();

    listeners.get('error')?.(errorEvent({ message: 'newest' }));
    await flush();

    const log = await storedLog();
    expect(log).toHaveLength(CE_ERROR_LOG_MAX);
    expect(log[0].msg).toBe('old 1');
    expect(log[CE_ERROR_LOG_MAX - 1].msg).toBe('newest');
  });

  describe('unhandledrejection', () => {
    it("uses an Error reason's message and stack", async () => {
      const listeners = capture();
      const reason = new Error(
        'rejected for 11111111-2222-3333-4444-555555555555',
      );
      reason.stack = 'stack 11111111-2222-3333-4444-555555555555';

      listeners.get('unhandledrejection')?.({ reason });
      await flush();

      const log = await storedLog();
      expect(log[0].level).toBe('unhandledrejection');
      expect(log[0].msg).toBe('rejected for <id>');
      expect(log[0].stack).toBe('stack <id>');
    });

    it('stringifies a non-Error reason and records no stack', async () => {
      const listeners = capture();

      listeners.get('unhandledrejection')?.({ reason: 'plain string' });
      await flush();

      const log = await storedLog();
      expect(log[0].msg).toBe('plain string');
      expect(log[0].stack).toBeNull();
    });

    it('falls back to "(no reason)" for an undefined reason', async () => {
      const listeners = capture();

      listeners.get('unhandledrejection')?.({ reason: undefined });
      await flush();

      const log = await storedLog();
      expect(log[0].msg).toBe('(no reason)');
    });
  });

  describe('re-entrancy guard', () => {
    it('drops a second event raised while the first is still being written', async () => {
      const listeners = capture();

      listeners.get('error')?.(errorEvent({ message: 'first' }));
      listeners.get('error')?.(errorEvent({ message: 'second' }));
      await flush();

      const log = await storedLog();
      expect(log).toHaveLength(1);
      expect(log[0].msg).toBe('first');
    });

    it('re-arms once the write settles, so later errors are still captured', async () => {
      const listeners = capture();

      listeners.get('error')?.(errorEvent({ message: 'first' }));
      await flush();
      listeners.get('error')?.(errorEvent({ message: 'third' }));
      await flush();

      const log = await storedLog();
      expect(log.map((entry) => entry.msg)).toEqual(['first', 'third']);
    });
  });

  describe('storage failures', () => {
    it('swallows a failing write without propagating to the page', async () => {
      const setSpy = vi
        .spyOn(chrome.storage.local, 'set')
        .mockRejectedValue(new Error('quota exceeded'));
      const listeners = capture();

      expect(() => listeners.get('error')?.(errorEvent())).not.toThrow();
      await flush();

      expect(setSpy).toHaveBeenCalled();
      setSpy.mockRestore();
      expect(await storedLog()).toEqual([]);
    });

    it('swallows a failing read too', async () => {
      const getSpy = vi
        .spyOn(chrome.storage.local, 'get')
        .mockRejectedValue(new Error('storage unavailable'));
      const listeners = capture();

      expect(() => listeners.get('error')?.(errorEvent())).not.toThrow();
      await flush();

      getSpy.mockRestore();
      expect(await storedLog()).toEqual([]);
    });

    it('re-arms the guard after a failure, so the next error is still captured', async () => {
      const setSpy = vi
        .spyOn(chrome.storage.local, 'set')
        .mockRejectedValueOnce(new Error('quota exceeded'));
      const listeners = capture();

      listeners.get('error')?.(errorEvent({ message: 'lost' }));
      await flush();
      listeners.get('error')?.(errorEvent({ message: 'kept' }));
      await flush();

      setSpy.mockRestore();
      const log = await storedLog();
      expect(log.map((entry) => entry.msg)).toEqual(['kept']);
    });
  });
});
