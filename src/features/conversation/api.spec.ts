import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchConversation, fetchConversationList, fetchProjects, detectOrgId, CONVERSATION_QUERY } from './api';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe('conversation/api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('CONVERSATION_QUERY', () => {
    it('matches the exact query string the Chat Cache signature depends on', () => {
      expect(CONVERSATION_QUERY).toBe('tree=True&rendering_mode=messages&render_all_tools=true');
    });
  });

  describe('fetchConversation', () => {
    it('builds the exact conversation URL and passes credentials/headers', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ uuid: 'abc' }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await fetchConversation('org1', 'conv1');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://claude.ai/api/organizations/org1/chat_conversations/conv1?tree=True&rendering_mode=messages&render_all_tools=true',
        expect.objectContaining({
          credentials: 'include',
          headers: { Accept: 'application/json' },
        }),
      );
      expect(result).toEqual({ uuid: 'abc' });
    });

    it('passes the abort signal through', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ uuid: 'abc' }));
      vi.stubGlobal('fetch', fetchMock);
      const controller = new AbortController();

      await fetchConversation('org1', 'conv1', controller.signal);

      expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
    });

    it('throws a descriptive error including status on non-ok response', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(null, false, 404));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchConversation('org1', 'conv1')).rejects.toThrow(/404/);
    });
  });

  describe('fetchConversationList', () => {
    it('builds the exact list URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
      vi.stubGlobal('fetch', fetchMock);

      await fetchConversationList('org1');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://claude.ai/api/organizations/org1/chat_conversations',
        expect.objectContaining({ credentials: 'include' }),
      );
    });

    it('throws with status on failure', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(null, false, 500));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchConversationList('org1')).rejects.toThrow(/500/);
    });
  });

  describe('fetchProjects', () => {
    it('builds the exact projects URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
      vi.stubGlobal('fetch', fetchMock);

      await fetchProjects('org1');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://claude.ai/api/organizations/org1/projects',
        expect.objectContaining({ credentials: 'include' }),
      );
    });

    it('throws with status on failure', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(null, false, 403));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchProjects('org1')).rejects.toThrow(/403/);
    });
  });

  describe('detectOrgId', () => {
    it('hits the organizations URL and picks the org with "chat" capability', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse([
          { uuid: 'api-org', capabilities: ['api'] },
          { uuid: 'chat-org', capabilities: ['chat', 'claude_pro'] },
        ]),
      );
      vi.stubGlobal('fetch', fetchMock);

      const orgId = await detectOrgId();

      expect(fetchMock).toHaveBeenCalledWith('https://claude.ai/api/organizations', expect.objectContaining({ credentials: 'include' }));
      expect(orgId).toBe('chat-org');
    });

    it('falls back to the first org when none has chat capability', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse([
          { uuid: 'first-org', capabilities: ['api'] },
          { uuid: 'second-org', capabilities: ['other'] },
        ]),
      );
      vi.stubGlobal('fetch', fetchMock);

      const orgId = await detectOrgId();

      expect(orgId).toBe('first-org');
    });

    it('throws when no organizations are returned', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
      vi.stubGlobal('fetch', fetchMock);

      await expect(detectOrgId()).rejects.toThrow(/No organizations found/);
    });

    it('throws with status on non-ok response', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(null, false, 401));
      vi.stubGlobal('fetch', fetchMock);

      await expect(detectOrgId()).rejects.toThrow(/401/);
    });
  });
});
