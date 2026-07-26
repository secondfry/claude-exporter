import type {
  DetectOrgIdResponse as ContentDetectOrgIdResponse,
  ExportResponse as ContentExportResponse,
  DetectOrgIdRequest,
  ExportAllConversationsRequest,
  ExportConversationRequest,
  FailureResponse,
} from '$entrypoints/content/messages';
import { detectOrgId } from '$features/conversation/api';
import { initErrorCapture } from '$features/diagnostics';
import type { ArtifactFormat, ExportFormat } from '$features/export/types';
import {
  createTab,
  getExtensionUrl,
  getManifestVersion,
  hasClaudeAccess,
  openOptionsPage,
  queryTabs,
  requestClaudeAccess,
  sendMessageToTab,
  storageGet,
  storageSet,
} from '$platform';

import { initTheme } from './theme';

// Capture unhandled errors for diagnostics (sanitized, stored in chrome.storage.local)
initErrorCapture('popup');

initTheme();

type DetectOrgIdResponse = ContentDetectOrgIdResponse | FailureResponse;

type ExportResponse = ContentExportResponse | FailureResponse;

// Get organization ID from storage (fallback)
async function getStoredOrgId(): Promise<string | undefined> {
  const result = await storageGet<{ organizationId?: string }>('sync', [
    'organizationId',
  ]);
  return result.organizationId;
}

// Auto-detect organization ID via content script, fall back to a direct
// detectOrgId() call (when the popup itself has claude.ai access), and
// finally to the stored org ID.
async function getOrgId(): Promise<string | undefined> {
  try {
    const [tab] = await queryTabs({ active: true, currentWindow: true });
    if (
      tab &&
      tab.url &&
      tab.url.includes('claude.ai') &&
      tab.id !== undefined
    ) {
      try {
        const detectOrgIdRequest: DetectOrgIdRequest = {
          action: 'detectOrgId',
        };
        const response = await sendMessageToTab<DetectOrgIdResponse>(
          tab.id,
          detectOrgIdRequest,
        );
        if (response && response.success && response.orgId) {
          // Save for future use / fallback
          await storageSet('sync', { organizationId: response.orgId });
          return response.orgId;
        }
      } catch (e) {
        console.log(
          'Content script detectOrgId failed, trying direct detection:',
          e,
        );
      }
    }
  } catch (e) {
    console.log('Auto-detect org ID failed, falling back to stored:', e);
  }

  try {
    const orgId = await detectOrgId();
    if (orgId) {
      await storageSet('sync', { organizationId: orgId });
      return orgId;
    }
  } catch (e) {
    console.log('Direct detectOrgId failed, falling back to stored:', e);
  }

  // Fall back to stored org ID
  return getStoredOrgId();
}

// Get current conversation ID from URL
async function getCurrentConversationId(): Promise<string | null> {
  const [tab] = await queryTabs({ active: true, currentWindow: true });
  if (!tab || !tab.url) return null;
  const url = new URL(tab.url);
  const match = url.pathname.match(/\/chat\/([a-f0-9-]+)/);
  return match ? match[1] : null;
}

// Show status message
function showStatus(
  message: string,
  type: 'error' | 'info' | 'success' = 'info',
): void {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;
  statusEl.className = `status ${type}`;

  // Swap "Options" for a clickable link when the message points users to the options page
  if (
    type === 'error' &&
    message.includes('Please set this value in Options.')
  ) {
    const linked = message.replace(
      'Options.',
      '<a href="#" id="statusOpenOptions">Options</a>.',
    );
    statusEl.innerHTML = linked;
    document
      .getElementById('statusOpenOptions')
      ?.addEventListener('click', (e) => {
        e.preventDefault();
        void openOptionsPage();
      });
  } else if (
    type === 'error' &&
    (message.includes('403') || message.includes('404'))
  ) {
    // Legacy 403/404 hint
    statusEl.innerHTML = `${message}<br>Is your <a href="#" id="statusOpenOptions">Organization ID</a> correct?`;
    document
      .getElementById('statusOpenOptions')
      ?.addEventListener('click', (e) => {
        e.preventDefault();
        void openOptionsPage();
      });
  } else {
    statusEl.textContent = message;
  }

  if (type === 'success') {
    setTimeout(() => {
      statusEl.textContent = '';
      statusEl.className = '';
    }, 3000);
  }
}

async function checkClaudeAccess(): Promise<void> {
  const notice = document.getElementById('claudeAccessNotice');
  if (!notice) return;

  const granted = await hasClaudeAccess();
  notice.style.display = granted ? 'none' : 'block';
}

document.addEventListener('DOMContentLoaded', async () => {
  // Pull the popup title + version from the manifest so the testing branch
  // shows "Claude Exporter Beta" without a separate HTML edit.
  const headerTitle = document.getElementById('header-title');
  const headerVersion = document.getElementById('header-version');
  if (headerTitle) headerTitle.textContent = chrome.runtime.getManifest().name;
  if (headerVersion) headerVersion.textContent = `v${getManifestVersion()}`;

  await checkClaudeAccess();

  const grantClaudeAccessButton = document.getElementById('grantClaudeAccess');
  grantClaudeAccessButton?.addEventListener('click', async () => {
    await requestClaudeAccess();
    await checkClaudeAccess();
  });

  // Handle checkbox dependencies
  const includeChatsCheckbox = document.getElementById(
    'includeChats',
  ) as HTMLInputElement | null;
  const includeThinkingCheckbox = document.getElementById(
    'includeThinking',
  ) as HTMLInputElement | null;
  const includeMetadataCheckbox = document.getElementById(
    'includeMetadata',
  ) as HTMLInputElement | null;
  const includeArtifactsCheckbox = document.getElementById(
    'includeArtifacts',
  ) as HTMLInputElement | null;

  function updateCheckboxStates(): void {
    if (
      !includeChatsCheckbox ||
      !includeThinkingCheckbox ||
      !includeMetadataCheckbox ||
      !includeArtifactsCheckbox
    ) {
      return;
    }
    const chatsEnabled = includeChatsCheckbox.checked;

    // Disable thinking, metadata and inline artifacts when chats is unchecked
    includeThinkingCheckbox.disabled = !chatsEnabled;
    includeMetadataCheckbox.disabled = !chatsEnabled;
    includeArtifactsCheckbox.disabled = !chatsEnabled;

    // Optionally uncheck them when disabled
    if (!chatsEnabled) {
      includeThinkingCheckbox.checked = false;
      includeMetadataCheckbox.checked = false;
      includeArtifactsCheckbox.checked = false;
    }
  }

  includeChatsCheckbox?.addEventListener('change', updateCheckboxStates);
  updateCheckboxStates(); // Initialize on load
});

// Export current conversation
document
  .getElementById('exportCurrent')
  ?.addEventListener('click', async () => {
    const button = document.getElementById(
      'exportCurrent',
    ) as HTMLButtonElement | null;
    if (button) button.disabled = true;
    showStatus('Fetching conversation...', 'info');

    try {
      const orgId = await getOrgId();
      const conversationId = await getCurrentConversationId();

      if (!orgId) {
        throw new Error(
          'Failed to obtain organization ID: Please set this value in Options.',
        );
      }
      if (!conversationId) {
        throw new Error(
          'Could not detect conversation ID. Make sure you are on a claude.ai conversation page.',
        );
      }

      const [tab] = await queryTabs({ active: true, currentWindow: true });

      // Check if we're on claude.ai
      if (
        !tab ||
        !tab.url ||
        !tab.url.includes('claude.ai') ||
        tab.id === undefined
      ) {
        throw new Error(
          'Please navigate to a claude.ai conversation page first.',
        );
      }

      const format = (
        document.getElementById('format') as HTMLSelectElement | null
      )?.value as ExportFormat | undefined;
      const artifactFormat = (
        document.getElementById('artifactFormat') as HTMLSelectElement | null
      )?.value;

      try {
        // tab.title on claude.ai carries a site suffix (e.g. " - Claude") that
        // would need brittle stripping to recover the bare conversation name,
        // so it is intentionally not sent here. The pipeline's own fetched
        // conversation name is the reliable source (see pipeline.ts).
        const exportConversationRequest: ExportConversationRequest = {
          action: 'exportConversation',
          artifactFormat,
          conversationId,
          extractArtifacts: (
            document.getElementById(
              'extractArtifacts',
            ) as HTMLInputElement | null
          )?.checked,
          flattenArtifacts: (
            document.getElementById(
              'flattenArtifacts',
            ) as HTMLInputElement | null
          )?.checked,
          format,
          includeArtifacts: (
            document.getElementById(
              'includeArtifacts',
            ) as HTMLInputElement | null
          )?.checked,
          includeChats: (
            document.getElementById('includeChats') as HTMLInputElement | null
          )?.checked,
          includeMetadata: (
            document.getElementById(
              'includeMetadata',
            ) as HTMLInputElement | null
          )?.checked,
          includeThinking: (
            document.getElementById(
              'includeThinking',
            ) as HTMLInputElement | null
          )?.checked,
          orgId,
        };
        const response = await sendMessageToTab<ExportResponse>(
          tab.id,
          exportConversationRequest,
        );

        if (response?.success) {
          showStatus('Conversation exported successfully!', 'success');
        } else {
          const errorMsg = response?.error || 'Export failed';
          console.error('Export failed:', errorMsg);
          showStatus(errorMsg, 'error');
        }
      } catch (error) {
        console.error('Runtime error:', error);
        showStatus(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
      if (button) button.disabled = false;
    } catch (error) {
      showStatus(
        error instanceof Error ? error.message : String(error),
        'error',
      );
      if (button) button.disabled = false;
    }
  });

// Browse conversations
document
  .getElementById('browseConversations')
  ?.addEventListener('click', () => {
    void createTab({ url: getExtensionUrl('browse.html') });
  });

// Export all conversations
document.getElementById('exportAll')?.addEventListener('click', async () => {
  const button = document.getElementById(
    'exportAll',
  ) as HTMLButtonElement | null;
  if (button) button.disabled = true;
  showStatus('Fetching all conversations...', 'info');

  try {
    const orgId = await getOrgId();

    if (!orgId) {
      throw new Error(
        'Failed to obtain organization ID: Please set this value in Options.',
      );
    }

    const [tab] = await queryTabs({ active: true, currentWindow: true });
    if (!tab || tab.id === undefined) {
      throw new Error(
        'Please navigate to a claude.ai conversation page first.',
      );
    }

    const format = (
      document.getElementById('format') as HTMLSelectElement | null
    )?.value as ExportFormat | undefined;
    const artifactFormat = (
      document.getElementById('artifactFormat') as HTMLSelectElement | null
    )?.value;

    try {
      const exportAllConversationsRequest: ExportAllConversationsRequest = {
        action: 'exportAllConversations',
        artifactFormat,
        extractArtifacts: (
          document.getElementById('extractArtifacts') as HTMLInputElement | null
        )?.checked,
        flattenArtifacts: (
          document.getElementById('flattenArtifacts') as HTMLInputElement | null
        )?.checked,
        format,
        includeArtifacts: (
          document.getElementById('includeArtifacts') as HTMLInputElement | null
        )?.checked,
        includeChats: (
          document.getElementById('includeChats') as HTMLInputElement | null
        )?.checked,
        includeMetadata: (
          document.getElementById('includeMetadata') as HTMLInputElement | null
        )?.checked,
        orgId,
      };
      const response = await sendMessageToTab<ExportResponse>(
        tab.id,
        exportAllConversationsRequest,
      );

      if (response?.success) {
        if (response.warnings) {
          showStatus(response.warnings, 'info');
        } else {
          showStatus(`Exported ${response.count} conversations!`, 'success');
        }
      } else {
        const errorMsg = response?.error || 'Export failed';
        console.error('Export failed:', errorMsg);
        showStatus(errorMsg, 'error');
      }
    } catch (error) {
      console.error('Runtime error:', error);
      showStatus(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }
    if (button) button.disabled = false;
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), 'error');
    if (button) button.disabled = false;
  }
});

export {};
