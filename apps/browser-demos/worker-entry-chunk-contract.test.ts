import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadConfigFromFile,
  type Plugin,
  type ResolvedConfig,
} from "vite";
import type { OutputBundle, OutputChunk, RenderedChunk } from "rollup";

const appRoot = dirname(fileURLToPath(import.meta.url));
const configFile = join(appRoot, "vite.config.ts");
const loaded = await loadConfigFromFile(
  { command: "build", mode: "production" },
  configFile,
  undefined,
  "silent",
);
assert.ok(loaded);

const workerPlugins = loaded.config.worker?.plugins;
assert.equal(typeof workerPlugins, "function");

function workerEntryPlugin(): Plugin {
  const plugin = workerPlugins!().find(
    (candidate) => candidate.name === "drop-worker-entry-exports",
  );
  assert.ok(plugin);
  return plugin;
}

test("each browser worker is emitted as one terminal chunk", () => {
  const output = loaded.config.worker?.rollupOptions?.output;
  assert.ok(output !== undefined && !Array.isArray(output));
  assert.equal(output.inlineDynamicImports, true);
});

function outputChunk(
  fileName: string,
  overrides: Partial<OutputChunk> = {},
): OutputChunk {
  return {
    code: "",
    dynamicImports: [],
    exports: [],
    facadeModuleId: null,
    fileName,
    implicitlyLoadedBefore: [],
    importedBindings: {},
    imports: [],
    isDynamicEntry: false,
    isEntry: false,
    isImplicitEntry: false,
    map: null,
    moduleIds: [],
    modules: {},
    name: fileName,
    preliminaryFileName: fileName,
    referencedFiles: [],
    sourcemapFileName: null,
    type: "chunk",
    ...overrides,
  };
}

function hookHandler<T extends (...args: never[]) => unknown>(
  hook: T | { handler: T } | undefined,
): T | undefined {
  return typeof hook === "function" ? hook : hook?.handler;
}

function invokeGenerateBundle(
  candidate: Plugin,
  bundle: OutputBundle,
): void {
  const hook = hookHandler(candidate.generateBundle);
  if (hook === undefined) return;
  hook.call(
    {
      error(message: string): never {
        throw new Error(message);
      },
    } as never,
    {} as never,
    bundle,
    false,
  );
}

function invokeRenderChunk(
  candidate: Plugin,
  code: string,
  chunk: RenderedChunk,
): { code: string; map: unknown } | null | undefined {
  const hook = hookHandler(candidate.renderChunk);
  assert.ok(hook);
  return hook.call(
    {} as never,
    code,
    chunk,
    {} as ResolvedConfig,
  ) as { code: string; map: unknown } | null | undefined;
}

test("stripped worker entries use their final emitted filename", () => {
  const plugin = workerEntryPlugin();
  const renderedEntry = outputChunk("worker-entry-!~{000}~.js", {
    facadeModuleId: "/worker-entry.ts",
    isEntry: true,
  });
  invokeRenderChunk(
    plugin,
    "const ready = true; export { ready as r };",
    renderedEntry,
  );
  const entry = outputChunk("worker-entry-a1b2.js", {
    facadeModuleId: "/worker-entry.ts",
    isEntry: true,
    preliminaryFileName: "worker-entry-!~{000}~.js",
  });
  const decoder = outputChunk("zip.js", {
    importedBindings: { "worker-entry-a1b2.js": ["r"] },
    imports: ["worker-entry-a1b2.js"],
  });

  assert.throws(
    () => invokeGenerateBundle(plugin, {
      "worker-entry-a1b2.js": entry,
      "zip.js": decoder,
    }),
    /imports worker entry .* whose exports are stripped/u,
  );
});

test("dynamic imports of stripped worker entries are rejected", () => {
  const plugin = workerEntryPlugin();
  const entry = outputChunk("worker-entry.js", {
    facadeModuleId: "/dynamic-worker-entry.ts",
    isEntry: true,
  });
  invokeRenderChunk(
    plugin,
    "const ready = true; export { ready as r };",
    entry,
  );

  assert.throws(
    () => invokeGenerateBundle(plugin, {
      "worker-entry.js": entry,
      "zip.js": outputChunk("zip.js", {
        dynamicImports: ["worker-entry.js"],
      }),
    }),
    /imports worker entry .* whose exports are stripped/u,
  );
});

test("side-effect-only imports of stripped worker entries are rejected", () => {
  const plugin = workerEntryPlugin();
  const entry = outputChunk("worker-entry.js", {
    facadeModuleId: "/side-effect-worker-entry.ts",
    isEntry: true,
  });
  invokeRenderChunk(
    plugin,
    "const ready = true; export { ready as r };",
    entry,
  );

  assert.throws(
    () => invokeGenerateBundle(plugin, {
      "worker-entry.js": entry,
      "side-effect.js": outputChunk("side-effect.js", {
        importedBindings: { "worker-entry.js": [] },
        imports: ["worker-entry.js"],
      }),
    }),
    /imports worker entry .* whose exports are stripped/u,
  );
});

test("static reverse edges without binding metadata fail closed", () => {
  const plugin = workerEntryPlugin();
  const entry = outputChunk("worker-entry.js", {
    facadeModuleId: "/unknown-bindings-worker-entry.ts",
    isEntry: true,
  });
  invokeRenderChunk(
    plugin,
    "const ready = true; export { ready as r };",
    entry,
  );
  const importer = outputChunk("unknown-bindings.js", {
    imports: ["worker-entry.js"],
  });
  delete (importer as Partial<OutputChunk>).importedBindings;

  assert.throws(
    () => invokeGenerateBundle(plugin, {
      "worker-entry.js": entry,
      "unknown-bindings.js": importer,
    }),
    /does not report imported bindings for stripped worker entry/u,
  );
});

test("stripped entry identities must resolve uniquely", () => {
  const plugin = workerEntryPlugin();
  const renderedEntry = outputChunk("worker-entry-!~{000}~.js", {
    facadeModuleId: "/ambiguous-worker-entry.ts",
    isEntry: true,
  });
  invokeRenderChunk(
    plugin,
    "const ready = true; export { ready as r };",
    renderedEntry,
  );

  assert.throws(
    () => invokeGenerateBundle(plugin, {
      "worker-entry-one.js": outputChunk("worker-entry-one.js", {
        facadeModuleId: "/ambiguous-worker-entry.ts",
        isEntry: true,
      }),
      "worker-entry-two.js": outputChunk("worker-entry-two.js", {
        facadeModuleId: "/ambiguous-worker-entry.ts",
        isEntry: true,
      }),
    }),
    /stripped worker entry .* resolves to multiple emitted chunks/u,
  );
});

test("terminal worker entries still have synthetic exports removed", () => {
  const plugin = workerEntryPlugin();
  const result = invokeRenderChunk(
    plugin,
    "const ready = true; export { ready as r };",
    outputChunk("worker-entry.js", {
      facadeModuleId: "/terminal-worker-entry.ts",
      isEntry: true,
    }),
  );
  assert.equal(result?.code, "const ready = true; ");
});
