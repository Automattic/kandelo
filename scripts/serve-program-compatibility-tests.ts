import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build, preview, type PreviewServer } from "../apps/browser-demos/node_modules/vite/dist/node/index.js";
import { createProgramCompatibilityImage } from "../host/test/fixtures/program-compatibility";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Expected one unprivileged test server port");
const app = resolve(import.meta.dirname, "../apps/browser-demos");
const directory = mkdtempSync(join(tmpdir(), "kandelo-program-compatibility-site-"));
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
  process.env.KANDELO_BROWSER_DEMO_INPUTS = "program-compatibility-test";
  process.env.VITE_BASE = "/";
  await build({ root: app, configFile: join(app, "vite.config.ts"), build: { outDir: directory, emptyOutDir: true } });
  writeFileSync(join(directory, "program-compatibility.vfs"), await createProgramCompatibilityImage());
  server = await preview({
    root: app, configFile: false, build: { outDir: directory },
    preview: {
      host: "127.0.0.1", port, strictPort: true,
      headers: {
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    },
  });
  console.log(`Program compatibility fixture ready at http://127.0.0.1:${port}/pages/program-compatibility-test/`);
} catch (error) {
  await close();
  throw error;
}
