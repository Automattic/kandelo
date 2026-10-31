/**
 * One build id for a production build's pages and its service worker.
 *
 * The first navigation after a deploy is answered by the service worker of
 * the deployment before it: the browser fetches the new `service-worker.js`
 * only while that navigation runs, and the new worker takes control later.
 * A page that started workers or fetched build-specific files in between ran
 * against the wrong deployment's worker (its kernel-worker script paths, its
 * caches). Comparing the page's id with the controlling worker's id makes that
 * state visible, so the page can wait for its own worker before it boots
 * (lib/init/service-worker-bridge.ts). See docs/browser-support.md,
 * "Deployment updates".
 *
 * The id is a digest of what the build emitted, so the same inputs give the
 * same id and any change to a chunk, an HTML entry or the service worker gives
 * a new one. Every HTML entry carries it in
 * `<meta name="kandelo-build-id">`; `service-worker.js` carries it in
 * `KANDELO_BUILD_ID` and reports it when asked. Under `vite` (development)
 * both keep the placeholder, which is equal on both sides.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export const BUILD_ID_PLACEHOLDER = "__KANDELO_BUILD_ID__";
export const BUILD_ID_META_NAME = "kandelo-build-id";
const BUILD_ID_META = `<meta name="${BUILD_ID_META_NAME}" content="${BUILD_ID_PLACEHOLDER}">`;
/** The worker's literal, as written in public/service-worker.js. */
const WORKER_PLACEHOLDER = JSON.stringify(BUILD_ID_PLACEHOLDER);
const WORKER_BUILD_ID = /var KANDELO_BUILD_ID = ("[0-9a-f]{20}"|"__KANDELO_BUILD_ID__");/u;

/** Replace the worker source's placeholder with `buildId`. Exactly one must exist. */
export function injectWorkerBuildId(source: string, buildId: string): string {
  const parts = source.split(WORKER_PLACEHOLDER);
  if (parts.length !== 2) {
    throw new Error("service-worker.js must contain exactly one build id placeholder");
  }
  return parts.join(JSON.stringify(buildId));
}

/**
 * The build id a built `service-worker.js` carries, for servers (`vite
 * preview`) that rebuild the worker from source but serve the built pages.
 * Null when there is no built worker.
 */
export function builtWorkerBuildId(outputRoot: string): string | null {
  let source: string;
  try {
    source = fs.readFileSync(path.join(outputRoot, "service-worker.js"), "utf8");
  } catch {
    return null;
  }
  const match = WORKER_BUILD_ID.exec(source);
  if (match === null) throw new Error("built service-worker.js has no build id");
  return JSON.parse(match[1]!) as string;
}

export function buildIdPlugin(): Plugin {
  let outputRoot = "";
  return {
    name: "kandelo-build-id",
    // After every plugin that rewrites the emitted service worker (the CORS
    // proxy profile, the lazy-cache version): the id covers their output.
    enforce: "post",
    configResolved(config) {
      outputRoot = path.resolve(config.root, config.build.outDir);
    },
    // A tag descriptor, not a string edit: Vite places it first in <head>,
    // or before <body> when a page has no <head> (where the HTML parser puts
    // it in the implied head), so every page Vite serves or builds carries
    // the id. Vite serializes the tag as exactly BUILD_ID_META, which
    // writeBundle replaces; writeBundle's "exactly one" check stays the
    // build-time guarantee that the page and the worker agree.
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (html.includes(BUILD_ID_META_NAME)) return html;
        return {
          html,
          tags: [{
            tag: "meta",
            attrs: { name: BUILD_ID_META_NAME, content: BUILD_ID_PLACEHOLDER },
            injectTo: "head-prepend",
          }],
        };
      },
    },
    writeBundle: {
      order: "post",
      sequential: true,
      handler(_options, bundle) {
        const workerPath = path.join(outputRoot, "service-worker.js");
        const worker = fs.readFileSync(workerPath, "utf8");
        const hash = createHash("sha256");
        const add = (name: string, bytes: string | Uint8Array) => {
          hash.update(`${name}\0${Buffer.byteLength(bytes)}\0`);
          hash.update(bytes);
        };
        for (const name of Object.keys(bundle).sort()) {
          const output = bundle[name]!;
          add(name, output.type === "chunk" ? output.code : output.source);
        }
        add("service-worker.js", worker);
        const buildId = hash.digest("hex").slice(0, 20);
        fs.writeFileSync(workerPath, injectWorkerBuildId(worker, buildId));
        for (const name of Object.keys(bundle)) {
          if (!name.endsWith(".html")) continue;
          const file = path.join(outputRoot, name);
          const html = fs.readFileSync(file, "utf8");
          const parts = html.split(BUILD_ID_META);
          if (parts.length !== 2) {
            throw new Error(`${name} must carry exactly one build id meta element`);
          }
          fs.writeFileSync(
            file,
            parts.join(`<meta name="${BUILD_ID_META_NAME}" content="${buildId}">`),
          );
        }
      },
    },
  };
}
