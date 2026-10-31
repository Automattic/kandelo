// Package a Kandelo guest-preview bundle for its own public Space.
//
// Guest web pages are served from a second origin so their scripts cannot
// reach the Kandelo page (docs/browser-support.md, "Guest web previews run on
// their own origin"). `./run.sh build-browser --preview-origin ...
// --app-origin ...` writes that origin's static files beside the app build;
// this adds the Spacefast `_headers` and `_redirects` they need and nothing
// else. The preview Space must be public: a private Space's access page
// forbids framing, which breaks the preview frame.
//
// Usage: node build-preview-site.mjs <preview-bundle-dir> --app-origin ORIGIN
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PREVIEW_BUNDLE_FILES,
  PREVIEW_PROTOCOL_VERSION,
  exactOrigin,
  spacefastPreviewSiteFiles,
} from "../browser-demos/vite/preview-origin.ts";

function options(args) {
  let source;
  let appOrigin;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--app-origin") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--app-origin needs an origin");
      appOrigin = exactOrigin(args[++i], "--app-origin");
    } else if (!args[i].startsWith("--") && source === undefined) {
      source = resolve(args[i]);
    } else throw new Error(`Unexpected preview build argument: ${args[i]}`);
  }
  if (!source) throw new Error("Pass the preview bundle directory");
  if (!appOrigin) throw new Error("--app-origin is required: the relay accepts only that Kandelo origin");
  return { source, appOrigin };
}

const { source, appOrigin } = options(process.argv.slice(2));
// Exactly the preview bundle, nothing the app build could leak into it.
const expected = new Set(Object.keys(PREVIEW_BUNDLE_FILES));
async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Not a preview bundle: ${path} is a symlink`);
    if (entry.isDirectory()) files.push(...await listFiles(join(directory, entry.name), path));
    else files.push(path);
  }
  return files;
}
const found = await listFiles(source);
for (const path of found) {
  if (!expected.has(path)) throw new Error(`Not a preview bundle: unexpected ${path}`);
}
for (const path of expected) {
  if (!found.includes(path)) throw new Error(`Not a preview bundle: ${path} is missing`);
}
// The bundle must have been built for this app, at this protocol version.
const relay = await readFile(join(source, "__kandelo_preview/relay.js"), "utf8");
const configText = relay.match(/var PREVIEW_CONFIG = (\{.*?\});\n/)?.[1];
const config = configText ? JSON.parse(configText) : null;
if (!config || config.protocolVersion !== PREVIEW_PROTOCOL_VERSION || !config.kandeloOrigins.includes(appOrigin)) {
  throw new Error(`The preview bundle was not built for ${appOrigin} at preview protocol ${PREVIEW_PROTOCOL_VERSION}`);
}

const context = fileURLToPath(new URL("../../.context/", import.meta.url));
await mkdir(context, { recursive: true });
const output = await mkdtemp(join(context, "spacefast-kandelo-preview-"));
await cp(source, output, { recursive: true });
// Spacefast publishes at the root of the Space, so the deployment scope is /.
for (const [name, text] of Object.entries(spacefastPreviewSiteFiles("/", appOrigin))) {
  await writeFile(join(output, name), text);
}
console.log(output);
