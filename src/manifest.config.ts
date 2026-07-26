import packageJson from "../package.json";

type Target = "chrome" | "firefox";

const EXTENSION_NAME = "Claude Exporter";

const GECKO_EXTENSION_ID = "{25798758-c184-470a-bb5b-9fa76a09d9b5}";

function getManifest(target: Target) {
  const base = {
    manifest_version: 3 as const,
    name: EXTENSION_NAME,
    version: packageJson.version,
    description: "Export conversations and artifacts from Claude.ai",
    action: {
      default_popup: "popup.html",
      default_icon: {
        "16": "icon16.png",
        "48": "icon48.png",
        "128": "icon128.png",
      },
    },
    icons: {
      "16": "icon16.png",
      "48": "icon48.png",
      "128": "icon128.png",
    },
    permissions: ["activeTab", "storage", "scripting", "tabs"],
    host_permissions: ["https://claude.ai/*"],
    content_scripts: [
      {
        matches: ["https://claude.ai/*"],
        js: ["content.js"],
        css: ["content.css"],
      },
    ],
    // options_ui with open_in_tab, not options_page: Firefox otherwise embeds
    // the page inside about:addons, where options.html's 810px layout overflows.
    options_ui: {
      page: "options.html",
      open_in_tab: true,
    },
    web_accessible_resources: [
      {
        resources: ["browse.html"],
        matches: ["https://claude.ai/*"],
      },
    ],
  };

  if (target === "chrome") {
    return {
      ...base,
      background: {
        service_worker: "background.js",
      },
    };
  }

  return {
    ...base,
    background: {
      scripts: ["background.js"],
    },
    browser_specific_settings: {
      gecko: {
        id: GECKO_EXTENSION_ID,
        strict_min_version: "109.0",
        data_collection_permissions: {
          required: ["none"],
        },
      },
    },
  };
}

export { getManifest };
export type { Target };
