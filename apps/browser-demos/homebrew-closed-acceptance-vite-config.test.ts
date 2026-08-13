import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build, loadConfigFromFile, type Plugin } from "vite";

import { HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE } from "./lib/homebrew-closed-acceptance";

const root = "/homebrew-main-shell-bottles";
const appRoot = dirname(fileURLToPath(import.meta.url));
const configFile = join(appRoot, "vite.config.ts");

test("Vite builds the private page only beside the real closed product inputs", async () => {
  const savedRoot = process.env.VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT;
  const savedInputs = process.env.KANDELO_BROWSER_DEMO_INPUTS;
  try {
    delete process.env.KANDELO_BROWSER_DEMO_INPUTS;
    process.env.VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT = root;
    const closed = await loadConfigFromFile(
      { command: "build", mode: HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE },
      configFile,
      undefined,
      "silent",
    );
    assert.ok(closed);
    assert.deepEqual(
      Object.keys(
        closed.config.build?.rollupOptions?.input as Record<string, string>,
      ).sort(),
      ["homebrew-vfs-test", "main"],
    );

    delete process.env.VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT;
    const ordinary = await loadConfigFromFile(
      { command: "build", mode: "production" },
      configFile,
      undefined,
      "silent",
    );
    assert.ok(ordinary);
    assert.deepEqual(
      Object.keys(
        ordinary.config.build?.rollupOptions?.input as Record<string, string>,
      ).sort(),
      ["kandelo", "main", "network"],
    );

    process.env.VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT = root;
    await assert.rejects(
      loadConfigFromFile(
        { command: "build", mode: "production" },
        configFile,
        undefined,
        "silent",
      ),
      /permitted only in homebrew-closed-acceptance/,
    );
  } finally {
    if (savedRoot === undefined) {
      delete process.env.VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT;
    } else {
      process.env.VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT = savedRoot;
    }
    if (savedInputs === undefined) {
      delete process.env.KANDELO_BROWSER_DEMO_INPUTS;
    } else {
      process.env.KANDELO_BROWSER_DEMO_INPUTS = savedInputs;
    }
  }
});

test("Vite rewrites the service worker in the resolved custom output directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-vite-service-worker-"));
  try {
    const loaded = await loadConfigFromFile(
      { command: "build", mode: "production" },
      configFile,
      undefined,
      "silent",
    );
    assert.ok(loaded);
    const plugins = (loaded.config.plugins ?? []).flat(Infinity) as Plugin[];
    const corsPlugin = plugins.find(
      ({ name }) => name === "inject-cors-proxy-config",
    );
    assert.ok(corsPlugin);

    const project = join(root, "project");
    const output = join(root, "custom-output");
    mkdirSync(join(project, "public"), { recursive: true });
    writeFileSync(join(project, "entry.ts"), "export const fixture = true;\n");
    writeFileSync(
      join(project, "public/service-worker.js"),
      'const cors = "__CORS_PROXY_CONFIG__"; const interceptor = "__BLOB_IFRAME_INTERCEPTOR__";\n',
    );

    await build({
      build: {
        emptyOutDir: true,
        lib: { entry: join(project, "entry.ts"), formats: ["es"] },
        outDir: output,
      },
      configFile: false,
      plugins: [corsPlugin],
      root: project,
    });
    const serviceWorker = readFileSync(
      join(output, "service-worker.js"),
      "utf8",
    );
    assert.equal(serviceWorker.includes("__CORS_PROXY_CONFIG__"), false);
    assert.match(serviceWorker, /allowedRequestHeaderNames/);
    assert.equal(serviceWorker.includes("__BLOB_IFRAME_INTERCEPTOR__"), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
