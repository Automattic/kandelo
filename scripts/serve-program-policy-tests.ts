import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build, preview, type PreviewServer } from "../apps/browser-demos/node_modules/vite/dist/node/index.js";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Expected one unprivileged test server port");
const root = resolve(import.meta.dirname, "..");
execFileSync("bash", [join(root, "crates/program-policy/build-wasm.sh"), "--verify-fresh"], { cwd: root, stdio: "inherit" });
const app = join(root, "apps/browser-demos");
const directory = mkdtempSync(join(tmpdir(), "kandelo-program-policy-site-"));
let server: PreviewServer | undefined;
let closing = false;

async function close() {
  if (closing) return;
  closing = true;
  try { await server?.close(); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  void close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
});

try {
  process.env.KANDELO_BROWSER_DEMO_INPUTS = "program-policy-test";
  process.env.VITE_BASE = "/";
  await build({ root: app, configFile: join(app, "vite.config.ts"), build: { outDir: directory, emptyOutDir: true } });
  copyFileSync(join(root, "local-binaries/kandelo_program_policy32.wasm"), join(directory, "program-policy.wasm"));
  server = await preview({
    root: app, configFile: false, build: { outDir: directory },
    preview: { host: "127.0.0.1", port, strictPort: true, headers: {
      "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Opener-Policy": "same-origin",
      "Cache-Control": "public, max-age=31536000, immutable",
    } },
  });
} catch (error) {
  await close();
  throw error;
}
