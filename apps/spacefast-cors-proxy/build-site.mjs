import { build } from "esbuild";
import { cp, mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

// Only consume the generated site. Never publish the repository or its tests.
const source = process.argv[2] ? resolve(process.argv[2])
  : fileURLToPath(new URL("../browser-demos/dist/", import.meta.url));
for (const name of ["index.html", "service-worker.js", "vfs-groups"]) await stat(join(source, name));
async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith(".env") ||
        [".git", ".spacefast", "node_modules", "pages-vfs-products.private.json"].includes(entry.name)) {
      throw new Error(`Not a publishable build: ${join(directory, entry.name)}`);
    }
    if (entry.isDirectory()) await checkDirectory(join(directory, entry.name));
  }
}
await checkDirectory(source);
const app = fileURLToPath(new URL("./", import.meta.url));
const context = fileURLToPath(new URL("../../.context/", import.meta.url));
await mkdir(context, { recursive: true });
const output = await mkdtemp(join(context, "spacefast-kandelo-build-"));
await cp(source, output, { recursive: true });
await mkdir(join(output, "functions", "cors-proxy"), { recursive: true });
await build({
  stdin: { contents: 'export { corsProxyRoute as default } from "./handler.ts";',
    resolveDir: app, sourcefile: "cors-proxy-entry.ts" },
  // A catch-all preserves Playground's /https://target path form as well as
  // the base route's encoded ?url= form, without claiming the static app.
  outfile: join(output, "functions", "cors-proxy", "[...rest].mjs"),
  bundle: true, format: "esm", platform: "browser", target: "es2022",
  external: ["cloudflare:*"],
});
await writeFile(join(output, "sf.jsonc"), JSON.stringify({
  $schema: "https://spacefast.com/schemas/sf.json",
  runtime: { kind: "functions", compatibilityDate: "2026-07-01" },
}, null, 2) + "\n");
// These response headers are required for the kernel's SharedArrayBuffer.
await writeFile(join(output, "_headers"), `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
`);
console.log(output);
