import { resolve } from "node:path";
import { build as viteBuild, defineConfig, type Plugin } from "vite";
import { getManifest, type Target } from "./src/manifest.config";

const ROOT = resolve(__dirname);
const SRC = resolve(ROOT, "src");

function isTarget(value: string): value is Target {
  return value === "chrome" || value === "firefox";
}

// Vite's HTML-entry pipeline only emits ESM <script type="module"> bundles.
// Content scripts (and, for portability, the background script) must ship as
// classic IIFE bundles with zero shared chunks, since content-script context
// forbids ESM and MV2/event-page background contexts cannot rely on dynamic
// import either. Vite's build API doesn't let a single build emit mixed
// formats, so this plugin drives a second, IIFE-format Rollup build for those
// entries once the primary (page) build has written its output, into the
// same outDir.
function iifeEntriesPlugin(outDir: string): Plugin {
  return {
    name: "claude-exporter-iife-entries",
    apply: "build",
    async closeBundle() {
      await viteBuild({
        configFile: false,
        publicDir: false,
        build: {
          outDir,
          emptyOutDir: false,
          minify: false,
          sourcemap: true,
          rollupOptions: {
            input: {
              content: resolve(SRC, "entrypoints/content/index.ts"),
              background: resolve(SRC, "entrypoints/background/index.ts"),
            },
            output: {
              format: "iife",
              entryFileNames: "[name].js",
              inlineDynamicImports: true,
            },
          },
        },
      });
    },
  };
}

// Copies static, non-transformed assets: the extension icons and the
// content-script stylesheet (referenced by filename from manifest
// content_scripts.css, so it must land at the outDir root untouched).
function staticAssetsPlugin(outDir: string): Plugin {
  return {
    name: "claude-exporter-static-assets",
    apply: "build",
    async generateBundle() {
      const { copyFile, mkdir, readdir } = await import("node:fs/promises");
      await mkdir(outDir, { recursive: true });

      const assetsDir = resolve(SRC, "assets");
      for (const file of await readdir(assetsDir)) {
        await copyFile(resolve(assetsDir, file), resolve(outDir, file));
      }

      await copyFile(
        resolve(SRC, "entrypoints/content/content.css"),
        resolve(outDir, "content.css"),
      );
    },
  };
}

// Emits manifest.json for the target being built, generated from the shared
// manifest.config.ts rather than hand-maintained per-browser JSON files.
function manifestPlugin(target: Target): Plugin {
  return {
    name: "claude-exporter-manifest",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: JSON.stringify(getManifest(target), null, 2),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const target: Target = isTarget(mode) ? mode : "chrome";
  const outDir = resolve(ROOT, "dist", target);

  return {
    root: ROOT,
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        input: {
          popup: resolve(SRC, "entrypoints/popup/popup.html"),
          browse: resolve(SRC, "entrypoints/browse/browse.html"),
          options: resolve(SRC, "entrypoints/options/options.html"),
        },
      },
    },
    plugins: [manifestPlugin(target), staticAssetsPlugin(outDir), iifeEntriesPlugin(outDir)],
    test: {
      include: ["src/**/*.spec.ts"],
      environment: "node",
    },
  };
});

export {};
