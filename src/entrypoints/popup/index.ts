import type {
  ExportResponse as ContentExportResponse,
  ExportAllConversationsRequest,
  ExportConversationRequest,
  FailureResponse,
} from '$entrypoints/content/messages';
import { initErrorCapture } from '$features/diagnostics';
import { toExportFormat } from '$features/export/formats';
import {
  createTab,
  getExtensionUrl,
  getManifestVersion,
  hasClaudeAccess,
  openOptionsPage,
  queryTabs,
  requestClaudeAccess,
  sendMessageToTab,
} from '$platform';

import { getButton, readCheckbox, readSelectValue } from './dom';
import {
  describeBulkExport,
  describeConversationExport,
} from './exportOutcome';
import type { StatusMessage } from './exportOutcome';
import { getClaudeTab, getOrgId } from './orgId';
import { initTheme } from './theme';

// Capture unhandled errors for diagnostics (sanitized, stored in chrome.storage.local)
initErrorCapture('popup');

initTheme();

type ExportResponse = ContentExportResponse | FailureResponse;

// Get current conversation ID from URL
const getCurrentConversationId = async (): Promise<string | null> => {
  const [tab] = await queryTabs({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  const url = new URL(tab.url);
  const match = url.pathname.match(/\/chat\/([a-f0-9-]+)/);
  return match ? match[1] : null;
};

// ----- Status line -----

const openOptionsFromStatus = (event: Event): void => {
  event.preventDefault();
  void openOptionsPage();
};

// Some error messages point at the options page; those get a live link rather
// than plain text. Everything else is textContent, which cannot inject markup.
const renderStatusBody = (
  statusEl: HTMLElement,
  message: string,
  type: 'error' | 'info' | 'success',
): void => {
  if (type !== 'error') {
    statusEl.textContent = message;
    return;
  }

  if (message.includes('Please set this value in Options.')) {
    statusEl.innerHTML = message.replace(
      'Options.',
      '<a href="#" id="statusOpenOptions">Options</a>.',
    );
    document
      .getElementById('statusOpenOptions')
      ?.addEventListener('click', openOptionsFromStatus);
    return;
  }

  // Legacy 403/404 hint
  if (message.includes('403') || message.includes('404')) {
    statusEl.innerHTML = `${message}<br>Is your <a href="#" id="statusOpenOptions">Organization ID</a> correct?`;
    document
      .getElementById('statusOpenOptions')
      ?.addEventListener('click', openOptionsFromStatus);
    return;
  }

  statusEl.textContent = message;
};

// Show status message
const showStatus = (
  message: string,
  type: 'error' | 'info' | 'success' = 'info',
): void => {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;

  statusEl.className = `status ${type}`;
  renderStatusBody(statusEl, message, type);

  if (type !== 'success') return;
  setTimeout(() => {
    statusEl.textContent = '';
    statusEl.className = '';
  }, 3000);
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ----- Claude access notice -----

const checkClaudeAccess = async (): Promise<void> => {
  const notice = document.getElementById('claudeAccessNotice');
  if (!notice) return;

  const granted = await hasClaudeAccess();
  notice.style.display = granted ? 'none' : 'block';
};

// ----- Options form -----

// Thinking, metadata and inline artifacts are all properties *of* the chat
// transcript, so they mean nothing with chats unchecked.
const CHAT_DEPENDENT_CHECKBOX_IDS = [
  'includeThinking',
  'includeMetadata',
  'includeArtifacts',
];

const updateCheckboxStates = (): void => {
  const chatsEnabled = readCheckbox('includeChats');
  if (chatsEnabled === undefined) return;

  for (const id of CHAT_DEPENDENT_CHECKBOX_IDS) {
    const checkbox = document.getElementById(id);
    if (!(checkbox instanceof HTMLInputElement)) continue;
    checkbox.disabled = !chatsEnabled;
    if (!chatsEnabled) checkbox.checked = false;
  }
};

const initHeader = (): void => {
  // Pull the popup title + version from the manifest so the testing branch
  // shows "Claude Exporter Beta" without a separate HTML edit.
  const headerTitle = document.getElementById('header-title');
  const headerVersion = document.getElementById('header-version');
  if (headerTitle) headerTitle.textContent = chrome.runtime.getManifest().name;
  if (headerVersion) headerVersion.textContent = `v${getManifestVersion()}`;
};

document.addEventListener('DOMContentLoaded', async () => {
  initHeader();
  await checkClaudeAccess();

  document
    .getElementById('grantClaudeAccess')
    ?.addEventListener('click', async () => {
      await requestClaudeAccess();
      await checkClaudeAccess();
    });

  document
    .getElementById('includeChats')
    ?.addEventListener('change', updateCheckboxStates);
  updateCheckboxStates(); // Initialize on load
});

// ----- Exports -----

// The options both export requests share. Read once, in one place, so the two
// requests cannot drift over which checkbox they honour.
const readSharedExportOptions = () => ({
  artifactFormat: readSelectValue('artifactFormat'),
  extractArtifacts: readCheckbox('extractArtifacts'),
  flattenArtifacts: readCheckbox('flattenArtifacts'),
  format: toExportFormat(readSelectValue('format')),
  includeArtifacts: readCheckbox('includeArtifacts'),
  includeChats: readCheckbox('includeChats'),
  includeMetadata: readCheckbox('includeMetadata'),
});

// Sends a request the caller already built and turns the response into the
// status line. The only job here is reporting — building the request, and
// deciding what counts as ready, belong to the click handlers.
const dispatchExport = async (
  tabId: number,
  request: ExportAllConversationsRequest | ExportConversationRequest,
  describeSuccess: (response: ContentExportResponse) => StatusMessage,
): Promise<void> => {
  const response = await sendMessageToTab<ExportResponse>(tabId, request);

  if (!response?.success) {
    const message = response?.error || 'Export failed';
    console.error(new Error(`Export failed: ${message}`));
    showStatus(message, 'error');
    return;
  }

  // The describer chooses the type, not just the text: a partial failure names
  // the conversations that did not make it and must not be auto-cleared.
  const { message, type } = describeSuccess(response);
  showStatus(message, type);
};

// Guards shared by both handlers: an org ID and a claude.ai tab to send to.
// Throws rather than returning null so the caller's single catch renders the
// message — these are user-actionable, not internal failures.
const requireExportContext = async (): Promise<{
  orgId: string;
  tabId: number;
}> => {
  const orgId = await getOrgId();
  if (!orgId) {
    throw new Error(
      'Failed to obtain organization ID: Please set this value in Options.',
    );
  }

  const tab = await getClaudeTab();
  if (!tab) {
    throw new Error('Please navigate to a claude.ai conversation page first.');
  }

  return { orgId, tabId: tab.id };
};

// Owns the button state and the failure path so each handler only describes
// what it wants exported. `finally` re-enables the button on every route out,
// which the two nested try/catch blocks here previously did by repeating the
// same line in four places.
const runExport = async (
  buttonId: string,
  pendingMessage: string,
  perform: () => Promise<void>,
): Promise<void> => {
  const button = getButton(buttonId);
  if (button) button.disabled = true;
  showStatus(pendingMessage, 'info');

  try {
    await perform();
  } catch (error) {
    console.error(new Error('Export failed', { cause: error }));
    showStatus(describeError(error), 'error');
  } finally {
    if (button) button.disabled = false;
  }
};

// Export current conversation
document.getElementById('exportCurrent')?.addEventListener('click', () => {
  void runExport('exportCurrent', 'Fetching conversation...', async () => {
    const { orgId, tabId } = await requireExportContext();

    const conversationId = await getCurrentConversationId();
    if (!conversationId) {
      throw new Error(
        'Could not detect conversation ID. Make sure you are on a claude.ai conversation page.',
      );
    }

    // tab.title on claude.ai carries a site suffix (e.g. " - Claude") that
    // would need brittle stripping to recover the bare conversation name,
    // so it is intentionally not sent here. The pipeline's own fetched
    // conversation name is the reliable source (see pipeline.ts).
    const request: ExportConversationRequest = {
      action: 'exportConversation',
      ...readSharedExportOptions(),
      conversationId,
      includeThinking: readCheckbox('includeThinking'),
      orgId,
    };

    await dispatchExport(tabId, request, describeConversationExport);
  });
});

// Browse conversations
document
  .getElementById('browseConversations')
  ?.addEventListener('click', () => {
    void createTab({ url: getExtensionUrl('browse.html') });
  });

// Export all conversations
document.getElementById('exportAll')?.addEventListener('click', () => {
  void runExport('exportAll', 'Fetching all conversations...', async () => {
    const { orgId, tabId } = await requireExportContext();

    const request: ExportAllConversationsRequest = {
      action: 'exportAllConversations',
      ...readSharedExportOptions(),
      orgId,
    };

    await dispatchExport(tabId, request, describeBulkExport);
  });
});

export {};
