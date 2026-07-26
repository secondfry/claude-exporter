import packageJson from '../package.json';

type Target = 'chrome' | 'firefox';

const EXTENSION_NAME = 'Claude Exporter';

// This fork's own AMO identity. The previous value belonged to the upstream
// agoramachina listing; signing against an ID you do not own fails, and
// installing a build that claims it would collide with the store version.
// Changing this again means AMO treats the result as a different add-on.
const GECKO_EXTENSION_ID = '{61bd6473-8d21-4bbf-8bcd-ea55e56fcb47}';

const getManifest = (target: Target) => {
  const base = {
    action: {
      default_icon: {
        '16': 'icon16.png',
        '48': 'icon48.png',
        '128': 'icon128.png',
      },
      default_popup: 'popup.html',
    },
    content_scripts: [
      {
        css: ['content.css'],
        js: ['content.js'],
        matches: ['https://claude.ai/*'],
      },
    ],
    description: 'Export conversations and artifacts from Claude.ai',
    host_permissions: ['https://claude.ai/*'],
    icons: {
      '16': 'icon16.png',
      '48': 'icon48.png',
      '128': 'icon128.png',
    },
    manifest_version: 3 as const,
    name: EXTENSION_NAME,
    // options_ui with open_in_tab, not options_page: Firefox otherwise embeds
    // the page inside about:addons, where options.html's 810px layout overflows.
    options_ui: {
      open_in_tab: true,
      page: 'options.html',
    },
    permissions: ['activeTab', 'storage', 'scripting', 'tabs'],
    version: packageJson.version,
    web_accessible_resources: [
      {
        matches: ['https://claude.ai/*'],
        resources: ['browse.html'],
      },
    ],
  };

  if (target === 'chrome') {
    return {
      ...base,
      background: {
        service_worker: 'background.js',
      },
    };
  }

  return {
    ...base,
    background: {
      scripts: ['background.js'],
    },
    browser_specific_settings: {
      gecko: {
        data_collection_permissions: {
          required: ['none'],
        },
        id: GECKO_EXTENSION_ID,
        strict_min_version: '109.0',
      },
    },
  };
};

export { getManifest };
export type { Target };
