import packageJson from "../package.json";

type Target = "chrome" | "firefox";

const EXTENSION_NAME = "Claude Exporter";

const GECKO_EXTENSION_ID = "{25798758-c184-470a-bb5b-9fa76a09d9b5}";

function getManifest(target: Target) {
  const base = {
    action: {
      default_icon: {
        "16": "icon16.png",
        "48": "icon48.png",
        "128": "icon128.png",
      },
      default_popup: "popup.html",
    },
    content_scripts: [
      {
        css: ["content.css"],
        js: ["content.js"],
        matches: ["https://claude.ai/*"],
      },
    ],
    description: "Export conversations and artifacts from Claude.ai",
    host_permissions: ["https://claude.ai/*"],
    icons: {
      "16": "icon16.png",
      "48": "icon48.png",
      "128": "icon128.png",
    },
    manifest_version: 3 as const,
    name: EXTENSION_NAME,
    // options_ui with open_in_tab, not options_page: Firefox otherwise embeds
    // the page inside about:addons, where options.html's 810px layout overflows.
    options_ui: {
      open_in_tab: true,
      page: "options.html",
    },
    permissions: ["activeTab", "storage", "scripting", "tabs"],
    version: packageJson.version,
    web_accessible_resources: [
      {
        matches: ["https://claude.ai/*"],
        resources: ["browse.html"],
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
        data_collection_permissions: {
          required: ["none"],
        },
        id: GECKO_EXTENSION_ID,
        strict_min_version: "109.0",
      },
    },
  };
}

export { getManifest };
export type { Target };
