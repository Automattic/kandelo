import { build } from "esbuild";
import { cp, mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { buildOptions, proxyEntry, buildSessionRoute } from "./build-options.mjs";

// Only consume the generated site. Never publish the repository or its tests.
const options = buildOptions(process.argv.slice(2), { site: true });
const source = options.source ? resolve(options.source)
  : fileURLToPath(new URL("../browser-demos/dist/", import.meta.url));
for (const name of ["index.html", "service-worker.js", "vfs-groups"]) await stat(join(source, name));
const isolationPaths = new Set(["/"]);
// Paths a browser must revalidate on every load: the service worker script
// and every HTML entry (and its clean URL aliases). The first reload after a
// deploy reaches the new deployment only if neither comes from a stale copy;
// content-hashed assets keep the host's caching. See docs/browser-support.md,
// "Deployment updates".
const revalidatedPaths = new Set(["/", "/service-worker.js"]);
async function checkDirectory(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith(".env") ||
        [".git", ".spacefast", "node_modules", "pages-vfs-products.private.json"].includes(entry.name) ||
        (prefix === "" && ["functions", "handler.ts", "handler.js", "handler.mjs", ".open-next"].includes(entry.name))) {
      throw new Error(`Not a publishable build: ${join(directory, entry.name)}`);
    }
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await checkDirectory(join(directory, entry.name), path);
    else if (/\.(?:html|m?js)$/.test(entry.name)) {
      isolationPaths.add(path);
      if (entry.name.endsWith(".html")) {
        // Header matching uses the requested URL, including clean URL aliases.
        const clean = path.replace(/\.html$/, "");
        const aliases = [path, clean];
        if (entry.name === "index.html") {
          aliases.push(`${prefix}/`);
          if (prefix) aliases.push(prefix);
        }
        for (const alias of aliases) {
          isolationPaths.add(alias);
          revalidatedPaths.add(alias);
        }
      }
    }
  }
}
await checkDirectory(source);
const app = fileURLToPath(new URL("./", import.meta.url));
const context = fileURLToPath(new URL("../../.context/", import.meta.url));
await mkdir(context, { recursive: true });
const output = await mkdtemp(join(context, "spacefast-kandelo-build-"));
await cp(source, output, {
  recursive: true,
  // The portable piplet mutates its PHP file on WP Cloud. Spacefast instead
  // owns signalling at /signalling through the database-backed Function below.
  filter: path => path !== join(source, "signalling", "piplet.php"),
});
if (!options.withoutProxy) {
  await buildSessionRoute(output, options.approved);
  await mkdir(join(output, "functions", "cors-proxy"), { recursive: true });
  await build({
    stdin: { contents: proxyEntry(options.approved, { route: true }),
      resolveDir: app, sourcefile: "cors-proxy-entry.ts" },
    // A catch-all preserves Playground's /https://target path form as well as
    // the base route's encoded ?url= form, without claiming the static app.
    outfile: join(output, "functions", "cors-proxy", "_handler.mjs"),
    bundle: true, format: "esm", platform: "browser", target: "es2022",
    external: ["cloudflare:*"],
  });
  // CLI 0.5.0 detects `export default`, but not esbuild's equivalent
  // `export { binding as default }`. Keep a literal router entry and put
  // bundled code in an underscore-prefixed helper, which is never routed.
  await writeFile(join(output, "functions", "cors-proxy", "[...rest].mjs"),
    'import handler from "./_handler.mjs";\nexport default handler;\n');
}
await build({
  entryPoints: [join(app, "../signalling/spacefast/handler.ts")],
  outfile: join(output, "functions", "_signalling.mjs"),
  bundle: true, format: "esm", platform: "browser", target: "es2022",
});
await writeFile(join(output, "functions", "signalling.mjs"),
  'import handler from "./_signalling.mjs";\nexport default handler;\n');
await writeFile(join(output, "sf.jsonc"), JSON.stringify({
  $schema: "https://spacefast.com/schemas/sf.json",
  runtime: { kind: "functions", compatibilityDate: "2026-07-01" },
}, null, 2) + "\n");
// Pages and workers need isolation, but binary assets do not. A blanket rule
// forces assets above Spacefast's 100 MiB PHP-lane limit into an unservable path.
// Only Kandelo may frame Kandelo: a guest page on the preview origin must not
// frame the app (for example to clickjack a credential prompt).
await writeFile(join(output, "_headers"), [...isolationPaths].sort().map(path => `${path}
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
  Content-Security-Policy: frame-ancestors 'self'
  Origin-Agent-Cluster: ?1
${revalidatedPaths.has(path) ? "  Cache-Control: no-cache\n" : ""}`).join("\n"));
// `computer/<name>/…` is the address users share. Kandelo's service worker
// serves the viewer shell for it; this covers a first visit it does not yet
// control. Guest pages themselves come only from the preview Space.
try {
  await stat(join(source, "pages/kandelo/viewer.html"));
  await writeFile(join(output, "_redirects"), "/computer/*  /pages/kandelo/viewer.html  200\n");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
console.log(output);
