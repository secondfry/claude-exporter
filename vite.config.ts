/// <reference types="node" />
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
      // One Rollup build per entry, not one build with two inputs:
      // inlineDynamicImports is what guarantees a single self-contained file
      // with no shared chunks (content-script context cannot load them), and
      // Rollup rejects it outright when more than one input is present.
      const entries = {
        content: resolve(SRC, "entrypoints/content/index.ts"),
        background: resolve(SRC, "entrypoints/background/index.ts"),
      };

      for (const [name, input] of Object.entries(entries)) {
        await viteBuild({
          configFile: false,
          publicDir: false,
          build: {
            outDir,
            emptyOutDir: false,
            minify: false,
            sourcemap: true,
            rollupOptions: {
              input,
              output: {
                format: "iife",
                entryFileNames: `${name}.js`,
                inlineDynamicImports: true,
              },
            },
          },
        });
      }
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

// Vite's HTML pipeline emits each HTML entry at a path relative to `root`
// (e.g. dist/chrome/src/entrypoints/popup/popup.html), and rewrites the
// <script>/<link> references inside it to relative paths that assume that
// nested location. The manifest requires every emitted file — HTML, JS
// chunks, CSS — to sit flat at the outDir root. This plugin renames the HTML
// assets to their basename and rewrites the now-broken relative references
// inside their source to match, after entryFileNames/chunkFileNames/
// assetFileNames have already flattened everything else.
function flattenHtmlPlugin(): Plugin {
  return {
    name: "claude-exporter-flatten-html",
    apply: "build",
    // Vite's own HTML plugin (vite:build-html) emits the nested HTML asset
    // in its own generateBundle hook, which — because it's a core plugin —
    // runs after plugins declared in user config by default. This plugin
    // must run after that emission to have anything to rename, hence `post`.
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const chunkOrAsset of Object.values(bundle)) {
        if (chunkOrAsset.type !== "asset") continue;
        if (!chunkOrAsset.fileName.endsWith(".html")) continue;

        const basename = chunkOrAsset.fileName.split("/").pop() as string;
        chunkOrAsset.fileName = basename;

        if (typeof chunkOrAsset.source === "string") {
          // Relative refs point up out of the nested source dir (e.g.
          // "../../../assets/popup-XXXX.js" or "./popup.css"); once the HTML
          // itself lives at the outDir root, every referenced asset is a
          // flat sibling, so any leading "../" segments and "./" prefixes
          // collapse to a bare filename.
          chunkOrAsset.source = chunkOrAsset.source.replace(
            /((?:src|href)=")(?:(?:\.\.\/)+|\.\/)([^"]+)(")/g,
            "$1$2$3",
          );
        }
      }
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
        output: {
          entryFileNames: "[name].js",
          // Shared chunks are derived from module filenames, and nearly every
          // module here is called index.ts — without the hash Rollup
          // disambiguates them as index.js/index2.js, so which feature lands
          // in which file shifts whenever an import is added.
          chunkFileNames: "chunk-[name]-[hash].js",
          assetFileNames: "[name][extname]",
        },
      },
    },
    plugins: [
      flattenHtmlPlugin(),
      manifestPlugin(target),
      staticAssetsPlugin(outDir),
      iifeEntriesPlugin(outDir),
    ],
    test: {
      include: ["src/**/*.spec.ts"],
      environment: "node",
    },
  };
});

export {};
