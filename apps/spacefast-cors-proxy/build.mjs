import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildOptions, proxyEntry, buildSessionRoute } from "./build-options.mjs";

const { approved } = buildOptions(process.argv.slice(2));
const app = fileURLToPath(new URL("./", import.meta.url));
const context = fileURLToPath(new URL("../../.context/", import.meta.url));
await mkdir(context, { recursive: true });
const output = await mkdtemp(join(context, "spacefast-cors-proxy-build-"));
await buildSessionRoute(output, approved);
await build({
  stdin: { contents: proxyEntry(approved), resolveDir: app, sourcefile: "proxy-entry.ts" },
  outfile: join(output, "handler.mjs"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:*"],
});
const config = JSON.parse(await readFile(join(app, "sf.jsonc"), "utf8"));
config.runtime.entry = "handler.mjs";
await writeFile(join(output, "sf.jsonc"), JSON.stringify(config, null, 2) + "\n");
console.log(output);
