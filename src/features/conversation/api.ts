// All claude.ai HTTP access lives here. Both the content script (relaying
// popup requests) and the browse page (fetching directly) go through these
// functions so the URLs, headers, and error handling never diverge again.

import type { Conversation, ConversationSummary } from './types';

/**
 * Query string appended to the conversation detail endpoint. ADR-0002 makes
 * the Chat Cache's `requestSignature` depend on this exact string — changing
 * it invalidates every cached entry, so it has exactly one definition.
 */
const CONVERSATION_QUERY =
  'tree=True&rendering_mode=messages&render_all_tools=true';

/** A project as returned by the organizations/{orgId}/projects endpoint. */
interface Project {
  id?: string;
  name?: string;
  title?: string;
  uuid?: string;
  [key: string]: unknown;
}

interface Organization {
  capabilities?: string[];
  uuid: string;
  [key: string]: unknown;
}

async function fetchJson<T>(
  url: string,
  signal: AbortSignal | undefined,
  notFoundLabel: string,
): Promise<T> {
  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      Accept: 'application/json',
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${notFoundLabel}: ${response.status}`);
  }

  return (await response.json()) as T;
}

function fetchConversation(
  orgId: string,
  uuid: string,
  signal?: AbortSignal,
): Promise<Conversation> {
  const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${uuid}?${CONVERSATION_QUERY}`;
  return fetchJson<Conversation>(url, signal, 'conversation');
}

function fetchConversationList(
  orgId: string,
  signal?: AbortSignal,
): Promise<ConversationSummary[]> {
  const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations`;
  return fetchJson<ConversationSummary[]>(url, signal, 'conversations');
}

function fetchProjects(
  orgId: string,
  signal?: AbortSignal,
): Promise<Project[]> {
  const url = `https://claude.ai/api/organizations/${orgId}/projects`;
  return fetchJson<Project[]>(url, signal, 'projects');
}

// Auto-detect organization ID from the claude.ai API. Picks the org whose
// capabilities include "chat" (the Claude.ai org, not an API-only org),
// falling back to the first org if none match.
async function detectOrgId(signal?: AbortSignal): Promise<string> {
  const orgs = await fetchJson<Organization[]>(
    'https://claude.ai/api/organizations',
    signal,
    'organizations',
  );

  if (!Array.isArray(orgs) || orgs.length === 0) {
    throw new Error('No organizations found');
  }

  const chatOrg = orgs.find(
    (org) => org.capabilities && org.capabilities.includes('chat'),
  );
  return chatOrg ? chatOrg.uuid : orgs[0].uuid;
}

export {
  CONVERSATION_QUERY,
  detectOrgId,
  fetchConversation,
  fetchConversationList,
  fetchProjects,
};
export type { Project };
