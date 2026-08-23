import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build as viteBuild, loadConfigFromFile, type Plugin } from "vite";

const appRoot = dirname(fileURLToPath(import.meta.url));
const configFile = join(appRoot, "vite.config.ts");
const rejectedBases = [
  "",
  "a/",
  "./",
  "../a/",
  "/a",
  "//a/",
  "https://example/a/",
  "/a//b/",
  "/a/./",
  "/a/../b/",
  "/a/%2e/",
  "/a/%2E%2E/b/",
  "/a/%252e%252e/b/",
  "/a/%2f/b/",
  "/a/%5c/b/",
  "/a\\b/",
  "/a/?q=1",
  "/a/#x",
  "/a/\0/",
];

function loadedPlugins(value: unknown): Plugin[] {
  const config = value as { config?: { plugins?: unknown[] } };
  return (config.config?.plugins ?? []).flat(Infinity) as Plugin[];
}

async function invokePluginHook(
  plugin: Plugin,
  name: "configResolved" | "resolveId" | "transformIndexHtml",
  ...arguments_: unknown[]
): Promise<unknown> {
  const hook = plugin[name];
  if (typeof hook === "function") {
    return await hook.apply({} as never, arguments_ as never);
  }
  if (hook !== undefined && typeof hook === "object" && "handler" in hook) {
    return await hook.handler.apply({} as never, arguments_ as never);
  }
  throw new Error(`plugin ${plugin.name} lacks ${name}`);
}

async function withViteBase<T>(base: string, run: () => Promise<T>): Promise<T> {
  const savedEnvironment = process.env;
  try {
    // Assigning one process.env property truncates at NUL before Vite can
    // validate the raw input. A temporary plain environment preserves the
    // exact spelling exercised by the configuration boundary.
    process.env = { ...savedEnvironment, VITE_BASE: base };
    return await run();
  } finally {
    process.env = savedEnvironment;
  }
}

test("binary URL imports are external during the dependency scan", async () => {
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "development" },
    configFile,
    undefined,
    "silent",
  );
  assert.ok(loaded);
  const plugin = loadedPlugins(loaded).find(
    (candidate) => candidate.name === "resolve-binaries-alias",
  );
  assert.ok(plugin);
  const source = "@binaries/programs/wasm32/bash.wasm?url";
  const resolved = await invokePluginHook(
    plugin,
    "resolveId",
    source,
    "/repo/apps/browser-demos/example.ts",
    { scan: true },
  );
  assert.deepEqual(resolved, { id: source, external: true });
});

test("an absolute /a/ prefix reaches Vite and generated browser HTML", async () => {
  await withViteBase("/a/", async () => {
    const loaded = await loadConfigFromFile(
      { command: "build", mode: "production" },
      configFile,
      undefined,
      "silent",
    );
    assert.ok(loaded);
    assert.equal(loaded.config.base, "/a/");

    const plugins = loadedPlugins(loaded);
    const resolvedConfig = {
      ...loaded.config,
      base: "/a/",
      command: "build",
    };
    let html = '<html><head></head><body><a href="/pages/kandelo/">Open</a></body></html>';
    for (const name of ["rewrite-nav-links", "inject-coi-service-worker"]) {
      const plugin = plugins.find((candidate) => candidate.name === name);
      assert.ok(plugin, name);
      await invokePluginHook(plugin, "configResolved", resolvedConfig);
      html = await invokePluginHook(plugin, "transformIndexHtml", html) as string;
    }

    assert.match(html, /src="\/a\/service-worker\.js"/u);
    assert.match(html, /href="\/a\/pages\/kandelo\/"/u);
  });
});

test("invalid deployment bases fail during config loading before output exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-deployment-base-config-"));
  try {
    for (const [index, base] of rejectedBases.entries()) {
      const output = join(root, `output-${index}`);
      await assert.rejects(
        withViteBase(base, async () => {
          await viteBuild({
            build: { outDir: output },
            configFile,
            logLevel: "silent",
            mode: "production",
          });
        }),
        /deployment base is invalid/iu,
        JSON.stringify(base),
      );
      assert.equal(existsSync(output), false, JSON.stringify(base));
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Pages asset-group directory requires a private map", async () => {
  const savedEnvironment = process.env;
  try {
    process.env = {
      ...savedEnvironment,
      KANDELO_PAGES_VFS_ASSET_GROUP_DIR: "/private/tmp/vfs-group",
      VITE_BASE: "/a/",
    };
    delete process.env.KANDELO_PAGES_PRODUCT_MAP;
    await assert.rejects(
      loadConfigFromFile(
        { command: "build", mode: "production" },
        configFile,
        undefined,
        "silent",
      ),
      /requires KANDELO_PAGES_PRODUCT_MAP/,
    );
  } finally {
    process.env = savedEnvironment;
  }
});
