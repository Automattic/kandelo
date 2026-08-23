import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build as viteBuild, loadConfigFromFile, type Plugin } from "vite";

import { ABI_VERSION } from "../host/src/generated/abi.ts";
import {
  buildFinalPagesSite,
  createCanonicalPagesLegacyBinaryBoundary,
  createCanonicalPagesVfsProductsPlugin,
  loadCanonicalPagesProductMap,
  type CanonicalPagesProductMapV1,
  type PagesSiteBuildCommand,
} from "./abi-staging-pages-site-builder.ts";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const registry = JSON.parse(readFileSync(join(
  repoRoot,
  "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json",
), "utf8"));
const gallery = JSON.parse(readFileSync(join(
  repoRoot,
  "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-gallery.json",
), "utf8"));

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, normalize(child)]));
  }
  return value;
}

function canonicalBytes(value: unknown): string {
  return `${JSON.stringify(normalize(value))}\n`;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function withTempDir<T>(run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-site-builder-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

async function withTempDirAsync<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-site-builder-"));
  try {
    return await run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function productMap(root: string): {
  assetGroupDirectory: string;
  map: CanonicalPagesProductMapV1;
  path: string;
} {
  const privateRoot = join(root, "sealed");
  mkdirSync(privateRoot);
  const assetGroupDirectory = join(root, "asset-group");
  mkdirSync(assetGroupDirectory);
  const products = registry.products.map((entry: { id: string; load: "eager" | "lazy" }) => {
    const body = Buffer.from(`sealed ${entry.id}\n`);
    const digest = sha256(body);
    const privatePath = join(privateRoot, `${entry.id}.vfs`);
    writeFileSync(privatePath, body, { mode: 0o600 });
    return {
      bytes: body.byteLength,
      id: entry.id,
      load: entry.load,
      path: `products/${entry.id}/sha256-${digest}/${entry.id}-${ABI_VERSION}.vfs.zst`,
      private_path: privatePath,
      sha256: digest,
    };
  });
  mkdirSync(join(assetGroupDirectory, "images"));
  const runtime = Buffer.from("group runtime asset\n");
  mkdirSync(join(assetGroupDirectory, "assets"));
  writeFileSync(join(assetGroupDirectory, "assets", "runtime.wasm"), runtime);
  const groupManifest = Buffer.from(JSON.stringify({
    assets: [{
      bytes: runtime.byteLength,
      group: "runtime",
      path: "assets/runtime.wasm",
      sha256: sha256(runtime),
    }],
    kind: "kandelo-vfs-asset-group",
    policy: "source-only-v1",
    products: products.map(({ bytes, id, private_path, sha256: digest }) => {
      writeFileSync(join(assetGroupDirectory, "images", `${id}.vfs.zst`), readFileSync(private_path));
      return {
        eager_groups: [],
        id,
        image: { bytes, path: `images/${id}.vfs.zst`, sha256: digest },
        lazy_groups: [],
      };
    }),
    schema: 1,
  }));
  writeFileSync(join(assetGroupDirectory, "manifest.json"), groupManifest);
  const assetGroup = {
    bytes: groupManifest.byteLength,
    path: "vfs-groups/release-1/manifest.json",
    sha256: sha256(groupManifest),
  };
  const map = {
    kind: "kandelo-pages-private-product-map" as const,
    products: products.map((product) => ({ ...product, asset_group: assetGroup })),
    schema: 1 as const,
  };
  const path = join(root, "private-map.json");
  writeFileSync(path, canonicalBytes(map), { mode: 0o600 });
  return { assetGroupDirectory, map, path };
}

function writeMap(root: string, name: string, map: unknown): string {
  const path = join(root, name);
  writeFileSync(path, canonicalBytes(map));
  return path;
}

function legacyProductMap(root: string) {
  const fixture = productMap(root);
  const map = {
    ...fixture.map,
    products: fixture.map.products.map(({ asset_group: _group, ...product }) =>
      product
    ),
  };
  const path = writeMap(root, "legacy-private-map.json", map);
  return { ...fixture, map, path };
}

function authorityOptions(path: string) {
  return { mapPath: path, sourceRoot: repoRoot };
}

test("accepts only the exact current seven-product closed map", () => {
  withTempDir((root) => {
    const fixture = productMap(root);
    const loaded = loadCanonicalPagesProductMap(authorityOptions(fixture.path));
    assert.deepEqual(
      loaded.products.map(({ id, load }) => ({ id, load })),
      registry.products,
    );

    const mutations: Array<[string, (value: any) => void, RegExp]> = [
      ["missing", (value) => value.products.pop(), /exact Pages product set/i],
      ["extra", (value) => value.products.push({
        ...value.products[0], id: "browser-rogue",
      }), /exact Pages product set/i],
      ["duplicate", (value) => value.products[1] = { ...value.products[0] }, /sorted and unique|duplicate/i],
      ["wrong-load", (value) => value.products[0].load = "eager", /load.*registry/i],
      ["candidate", (value) => value.products[0].path = value.products[0].path.replace(
        "products/", "products/-candidates/",
      ), /canonical product path|candidate/i],
      ["prior-abi", (value) => value.products[0].path = value.products[0].path.replace(
        `-${ABI_VERSION}.vfs.zst`, `-${ABI_VERSION - 1}.vfs.zst`,
      ), /canonical product path|ABI/i],
      ["wrong-bytes", (value) => value.products[0].bytes += 1, /private product.*(?:identity|bounded)/i],
      ["unknown-field", (value) => value.products[0].fallback = "binaries", /fields differ/i],
    ];
    for (const [name, mutate, message] of mutations) {
      const value = structuredClone(fixture.map);
      mutate(value);
      assert.throws(
        () => loadCanonicalPagesProductMap(authorityOptions(writeMap(root, `${name}.json`, value))),
        message,
        name,
      );
    }
  });
});

test("accepts legacy map-only products but rejects a partially grouped map", () => {
  withTempDir((root) => {
    const fixture = legacyProductMap(root);
    const loaded = loadCanonicalPagesProductMap(authorityOptions(fixture.path));
    assert.equal(
      loaded.products.every((product) => product.asset_group === undefined),
      true,
    );

    const mixed = structuredClone(fixture.map) as any;
    const groupedRoot = join(root, "grouped");
    mkdirSync(groupedRoot);
    mixed.products[0].asset_group = productMap(groupedRoot).map.products[0]
      .asset_group;
    assert.throws(
      () =>
        loadCanonicalPagesProductMap({
          mapPath: writeMap(root, "mixed-private-map.json", mixed),
          sourceRoot: repoRoot,
        }),
      /all declare an asset group or all omit it/,
    );

  });
});

test("legacy map-only authority reaches the real Vite configuration without a group", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = legacyProductMap(root);
    const savedEnvironment = process.env;
    try {
      process.env = {
        ...savedEnvironment,
        KANDELO_PAGES_PRODUCT_MAP: fixture.path,
        VITE_BASE: "/kandelo/",
      };
      delete process.env.KANDELO_PAGES_VFS_ASSET_GROUP_DIR;
      const loaded = await loadConfigFromFile(
        { command: "build", mode: "production" },
        join(repoRoot, "apps/browser-demos/vite.config.ts"),
        undefined,
        "silent",
      );
      assert.ok(loaded);
      const plugins = (loaded.config.plugins ?? []).flat(Infinity) as Plugin[];
      assert.ok(
        plugins.some(
          ({ name }) => name === "canonical-pages-vfs-products",
        ),
      );
    } finally {
      process.env = savedEnvironment;
    }
  });
});

test("real Vite configuration pairs a group directory only with grouped maps", async () => {
  await withTempDirAsync(async (root) => {
    const grouped = productMap(root);
    const legacyRoot = join(root, "legacy");
    mkdirSync(legacyRoot);
    const legacy = legacyProductMap(legacyRoot);
    const cases = [
      {
        group: undefined,
        map: grouped.path,
        message: /grouped .* requires KANDELO_PAGES_VFS_ASSET_GROUP_DIR/,
      },
      {
        group: legacy.assetGroupDirectory,
        map: legacy.path,
        message: /legacy .* must omit KANDELO_PAGES_VFS_ASSET_GROUP_DIR/,
      },
    ];
    const savedEnvironment = process.env;
    try {
      for (const entry of cases) {
        process.env = {
          ...savedEnvironment,
          KANDELO_PAGES_PRODUCT_MAP: entry.map,
          VITE_BASE: "/kandelo/",
        };
        if (entry.group === undefined) {
          delete process.env.KANDELO_PAGES_VFS_ASSET_GROUP_DIR;
        } else {
          process.env.KANDELO_PAGES_VFS_ASSET_GROUP_DIR = entry.group;
        }
        await assert.rejects(
          loadConfigFromFile(
            { command: "build", mode: "production" },
            join(repoRoot, "apps/browser-demos/vite.config.ts"),
            undefined,
            "silent",
          ),
          entry.message,
        );
      }
    } finally {
      process.env = savedEnvironment;
    }
  });
});

test("default executor preserves the legacy ABI Pages map-only path", () => {
  withTempDir((root) => {
    const isolatedSource = join(root, "source");
    copyPagesAuthority(isolatedSource);
    const fixture = legacyProductMap(root);
    const cacheRoot = join(root, "binary-cache");
    mkdirSync(cacheRoot);
    const savedCacheRoot = process.env.WASM_POSIX_BINARY_CACHE_ROOT;
    process.env.WASM_POSIX_BINARY_CACHE_ROOT = cacheRoot;
    try {
      const metadata = buildFinalPagesSite({
        outputRoot: join(root, "site"),
        productMapPath: fixture.path,
        sourceRoot: isolatedSource,
      });
      assert.equal(metadata.products.length, 7);
      assert.equal(
        metadata.files.some(({ path }) => path.includes("vfs-groups/")),
        false,
      );
    } finally {
      if (savedCacheRoot === undefined) {
        delete process.env.WASM_POSIX_BINARY_CACHE_ROOT;
      } else {
        process.env.WASM_POSIX_BINARY_CACHE_ROOT = savedCacheRoot;
      }
    }
  });
});

test("grouped site maps require their explicit asset-group directory before execution", () => {
  withTempDir((root) => {
    const fixture = productMap(root);
    let executed = false;
    assert.throws(
      () =>
        buildFinalPagesSite({
          execute() {
            executed = true;
          },
          outputRoot: join(root, "site"),
          productMapPath: fixture.path,
          sourceRoot: repoRoot,
        }),
      /grouped private Pages product map requires an asset-group directory/,
    );
    assert.equal(executed, false);
  });
});

function copyPagesAuthority(destination: string): void {
  const paths = [
    "abi/staging/legacy-vfs-adapters.toml",
    "apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts",
    "apps/browser-demos/pages/kandelo/kernel-host/optional-demo-vfs.ts",
    "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-gallery.json",
    "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json",
    "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml",
    "apps/browser-demos/pages/kandelo/presets.ts",
    "apps/browser-demos/vite.config.ts",
    "host/src/browser-kernel-default-artifacts.ts",
    "images/vfs/products/generated/catalog.json",
    "run.sh",
  ];
  for (const path of paths) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repoRoot, path), target);
  }
  const devShell = join(destination, "scripts/dev-shell.sh");
  mkdirSync(dirname(devShell), { recursive: true });
  writeFileSync(
    devShell,
    `#!/usr/bin/env bash
set -euo pipefail
output=""
previous=""
legacy_map=0
group=0
for argument in "$@"; do
  if [[ "$argument" == KANDELO_PAGES_PRODUCT_MAP=* ]]; then legacy_map=1; fi
  if [[ "$argument" == KANDELO_PAGES_VFS_ASSET_GROUP_DIR=* ]]; then group=1; fi
  if [[ "$previous" == "--outDir" ]]; then output="$argument"; fi
  previous="$argument"
done
if [[ "$*" == *"apps/browser-demos"* ]] &&
   [[ "$legacy_map" -ne 1 || "$group" -ne 0 ]]; then
  exit 91
fi
if [[ -z "$output" ]]; then output="\${@: -1}"; fi
mkdir -p "$output"
printf '%s\\n' "$output" > "$output/index.html"
`,
  );
  chmodSync(devShell, 0o755);
}

test("rejects private asset-group paths that are unsafe as URL-relative paths", () => {
  withTempDir((root) => {
    const fixture = productMap(root);
    const cases = [
      "vfs-groups/release-1/manifest.json?cache=1",
      "vfs-groups/release-1/manifest.json#fragment",
      "vfs-groups/%2e%2e/release-1/manifest.json",
      "vfs-groups/release-1%2fescape/manifest.json",
      "vfs-groups/release-1%5cescape/manifest.json",
    ];
    for (const [index, path] of cases.entries()) {
      const map = structuredClone(fixture.map);
      for (const product of map.products) product.asset_group.path = path;
      assert.throws(
        () => loadCanonicalPagesProductMap(authorityOptions(writeMap(root, `unsafe-group-${index}.json`, map))),
        /asset group identity/i,
        path,
      );
    }
  });
});

test("canonical Pages replaces legacy browser binaries without consulting a cache", async () => {
  await withTempDirAsync(async (root) => {
    const project = join(root, "vite-project");
    mkdirSync(project);
    writeFileSync(join(project, "entry.ts"), `
      import dash from "@binaries/programs/wasm32/dash.wasm?url";
      export function observed() { return dash; }
    `);
    const output = join(root, "vite-output");
    await viteBuild({
      build: {
        emptyOutDir: true,
        lib: { entry: join(project, "entry.ts"), formats: ["es"] },
        minify: false,
        outDir: output,
        rollupOptions: { output: { entryFileNames: "entry.mjs" } },
      },
      configFile: false,
      plugins: [createCanonicalPagesLegacyBinaryBoundary(true)],
      root: project,
    });
    const module = await import(
      `${pathToFileURL(join(output, "entry.mjs")).href}?t=${Date.now()}`
    );
    assert.equal(
      module.observed(),
      "/__kandelo_pages_unavailable__/programs/wasm32/dash.wasm",
    );
  });
});

test("canonical Vite mode exports /a/ product URLs without emitting or consulting legacy VFS", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = legacyProductMap(root);
    const loaded = loadCanonicalPagesProductMap(authorityOptions(fixture.path));
    const project = join(root, "vite-project");
    const mirror = join(project, "binaries");
    const programRoot = join(mirror, "programs/wasm32");
    mkdirSync(programRoot, { recursive: true });
    const names = [
      "shell.vfs.zst",
      "node-vfs.vfs.zst",
      "nginx.vfs.zst",
      "nginx-vfs.vfs.zst",
      "nginx-php.vfs.zst",
      "nginx-php-vfs.vfs.zst",
      "wordpress.vfs.zst",
      "lamp.vfs.zst",
    ];
    for (const name of names) writeFileSync(join(programRoot, name), `legacy ${name}\n`);
    writeFileSync(join(project, "entry.ts"), `
      import products from "virtual:kandelo-pages-vfs-products";
      import rootfs from "@rootfs-vfs?url";
      import shell from "@binaries/programs/wasm32/shell.vfs.zst?url";
      const node = import.meta.glob("./binaries/programs/wasm32/node-vfs.vfs.zst", {query:"?url",import:"default"});
      const nginx = import.meta.glob("./binaries/programs/wasm32/nginx.vfs.zst", {query:"?url",import:"default"});
      const nginxTransitional = import.meta.glob("./binaries/programs/wasm32/nginx-vfs.vfs.zst", {query:"?url",import:"default"});
      const nginxPhp = import.meta.glob("./binaries/programs/wasm32/nginx-php.vfs.zst", {query:"?url",import:"default"});
      const nginxPhpTransitional = import.meta.glob("./binaries/programs/wasm32/nginx-php-vfs.vfs.zst", {query:"?url",import:"default"});
      const wordpress = import.meta.glob("./binaries/programs/wasm32/wordpress.vfs.zst", {query:"?url",import:"default"});
      const lamp = import.meta.glob("./binaries/programs/wasm32/lamp.vfs.zst", {query:"?url",import:"default"});
      const one = async (value) => (await Object.values(value)[0]());
      export async function observed() { return {products, rootfs, shell,
        node:await one(node), nginx:await one(nginx), nginxTransitional:await one(nginxTransitional),
        nginxPhp:await one(nginxPhp), nginxPhpTransitional:await one(nginxPhpTransitional),
        wordpress:await one(wordpress), lamp:await one(lamp)}; }
    `);
    let fallbackCalls = 0;
    const fallback: Plugin = {
      name: "forbidden-legacy-vfs-fallback",
      resolveId(source) {
        if (/\.vfs(?:\.zst)?(?:\?|$)/u.test(source)) fallbackCalls += 1;
        return null;
      },
    };
    const output = join(root, "vite-output");
    await viteBuild({
      base: "/a/",
      build: {
        emptyOutDir: true,
        lib: { entry: join(project, "entry.ts"), formats: ["es"] },
        minify: false,
        outDir: output,
        rollupOptions: {
          output: { chunkFileNames: "[name]-[hash].mjs", entryFileNames: "entry.mjs" },
        },
      },
      configFile: false,
      plugins: [
        createCanonicalPagesVfsProductsPlugin({
          base: "/a/",
          map: loaded,
          mirrorRoots: [mirror],
        }),
        fallback,
      ],
      root: project,
    });
    assert.equal(fallbackCalls, 0);
    const module = await import(`${pathToFileURL(join(output, "entry.mjs")).href}?t=${Date.now()}`);
    const observed = await module.observed();
    const byId = new Map(loaded.products.map((entry) => [entry.id, entry]));
    const url = (id: string) => `/a/${byId.get(id)!.path}`;
    assert.deepEqual(observed.products, loaded.products.map(({ private_path: _, ...entry }) => ({
      ...entry,
      path: `/a/${entry.path}`,
    })));
    assert.equal(
      observed.products.every((entry: object) =>
        !Object.hasOwn(entry, "asset_group")),
      true,
    );
    assert.deepEqual({
      rootfs: observed.rootfs,
      shell: observed.shell,
      node: observed.node,
      nginx: observed.nginx,
      nginxTransitional: observed.nginxTransitional,
      nginxPhp: observed.nginxPhp,
      nginxPhpTransitional: observed.nginxPhpTransitional,
      wordpress: observed.wordpress,
      lamp: observed.lamp,
    }, {
      rootfs: url("platform-rootfs"),
      shell: url("browser-main-shell"),
      node: url("browser-node"),
      nginx: url("browser-nginx"),
      nginxTransitional: url("browser-nginx"),
      nginxPhp: url("browser-nginx-php"),
      nginxPhpTransitional: url("browser-nginx-php"),
      wordpress: url("browser-wordpress"),
      lamp: url("browser-lamp"),
    });
    assert.deepEqual(
      inventory(output).filter((path) => /\.vfs(?:\.zst)?$/u.test(path)),
      [],
    );
  });
});

test("canonical Vite mode claims verified SourceOnly VFS virtual IDs before asset emission", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = legacyProductMap(root);
    const loaded = loadCanonicalPagesProductMap(authorityOptions(fixture.path));
    const project = join(root, "source-only-virtual-project");
    mkdirSync(project);
    writeFileSync(
      join(project, "entry.ts"),
      `
      import nginx from "virtual:kandelo-source-only-asset:programs%2Fwasm32%2Fnginx-vfs.vfs.zst";
      export default nginx;
    `,
    );
    let sourceOnlyFallbacks = 0;
    const output = join(root, "source-only-virtual-output");
    await viteBuild({
      base: "/a/",
      build: {
        emptyOutDir: true,
        lib: { entry: join(project, "entry.ts"), formats: ["es"] },
        minify: false,
        outDir: output,
        rollupOptions: { output: { entryFileNames: "entry.mjs" } },
      },
      configFile: false,
      plugins: [
        createCanonicalPagesVfsProductsPlugin({
          base: "/a/",
          map: loaded,
          mirrorRoots: [project],
        }),
        {
          name: "source-only-virtual-fallback",
          resolveId(source) {
            if (!source.startsWith("virtual:kandelo-source-only-asset:"))
              return null;
            sourceOnlyFallbacks += 1;
            return "\0source-only-virtual-fallback";
          },
          load(id) {
            return id === "\0source-only-virtual-fallback"
              ? 'export default "/legacy-nginx.vfs.zst";\n'
              : null;
          },
        },
      ],
      root: project,
    });
    assert.equal(sourceOnlyFallbacks, 0);
    const module = await import(
      `${pathToFileURL(join(output, "entry.mjs")).href}?t=${Date.now()}`
    );
    assert.equal(
      module.default,
      `/a/${loaded.products.find(({ id }) => id === "browser-nginx")!.path}`,
    );
  });
});

test("canonical Vite writeBundle copies the complete authenticated group beneath both output bases", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = productMap(root);
    const loaded = loadCanonicalPagesProductMap(authorityOptions(fixture.path));
    const project = join(root, "group-project");
    mkdirSync(project);
    writeFileSync(join(project, "entry.ts"), "export default true;\n");
    mkdirSync(join(project, "public"));
    writeFileSync(
      join(project, "public", "service-worker.js"),
      'const cacheVersion = null /*__KANDELO_VFS_LAZY_CACHE_VERSION__*/;\n',
    );
    for (const base of ["/a/", "/candidate-b/"]) {
      const output = join(root, `output-${base.split("/")[1]}`);
      await viteBuild({
        base,
        build: {
          emptyOutDir: true,
          lib: { entry: join(project, "entry.ts"), formats: ["es"] },
          outDir: output,
        },
        configFile: false,
        plugins: [
          createCanonicalPagesVfsProductsPlugin({
            assetGroupDirectory: fixture.assetGroupDirectory,
            base,
            map: loaded,
            mirrorRoots: [project],
          }),
        ],
        root: project,
      });
      assert.deepEqual(
        inventory(join(output, "vfs-groups/release-1")),
        inventory(fixture.assetGroupDirectory),
      );
      assert.equal(inventory(output).includes("private-map.json"), false);
      assert.equal(
        readFileSync(join(output, "service-worker.js"), "utf8"),
        `const cacheVersion = "${loaded.products[0]!.asset_group!.sha256}";\n`,
      );
    }
  });
});

test("canonical Vite writeBundle rejects an existing group destination conflict", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = productMap(root);
    const loaded = loadCanonicalPagesProductMap(authorityOptions(fixture.path));
    const project = join(root, "conflict-project");
    const output = join(root, "conflict-output");
    mkdirSync(project);
    writeFileSync(join(project, "entry.ts"), "export default true;\n");
    await assert.rejects(
      viteBuild({
        base: "/a/",
        build: {
          emptyOutDir: true,
          lib: { entry: join(project, "entry.ts"), formats: ["es"] },
          outDir: output,
        },
        configFile: false,
        plugins: [
          {
            name: "write-group-conflict",
            writeBundle() {
              mkdirSync(join(output, "vfs-groups/release-1"), {
                recursive: true,
              });
              writeFileSync(
                join(output, "vfs-groups/release-1/conflict.txt"),
                "conflict\n",
              );
            },
          },
          createCanonicalPagesVfsProductsPlugin({
            assetGroupDirectory: fixture.assetGroupDirectory,
            base: "/a/",
            map: loaded,
            mirrorRoots: [project],
          }),
        ],
        root: project,
      }),
      /output path conflicts/,
    );
  });
});

test("canonical Vite mode fails closed for an unknown VFS request", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = legacyProductMap(root);
    const loaded = loadCanonicalPagesProductMap(authorityOptions(fixture.path));
    const project = join(root, "unknown-project");
    mkdirSync(project);
    writeFileSync(join(project, "rogue.vfs.zst"), "rogue\n");
    writeFileSync(join(project, "entry.ts"), 'import rogue from "./rogue.vfs.zst?url"; export default rogue;\n');
    let fallbackCalls = 0;
    await assert.rejects(viteBuild({
      base: "/kandelo/",
      build: { lib: { entry: join(project, "entry.ts"), formats: ["es"] }, outDir: join(root, "out") },
      configFile: false,
      plugins: [
        createCanonicalPagesVfsProductsPlugin({
          base: "/kandelo/", map: loaded, mirrorRoots: [project],
        }),
        { name: "forbidden-fallback", resolveId() { fallbackCalls += 1; return null; } },
      ],
      root: project,
    }), /unknown canonical Pages VFS/i);
    assert.equal(fallbackCalls, 0);
  });
});

test("canonical Vite mode rejects a fragmented VFS request before fallback", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = legacyProductMap(root);
    const loaded = loadCanonicalPagesProductMap(authorityOptions(fixture.path));
    const project = join(root, "fragment-project");
    mkdirSync(project);
    writeFileSync(join(project, "rogue.vfs.zst"), "rogue\n");
    writeFileSync(
      join(project, "entry.ts"),
      'import rogue from "./rogue.vfs.zst#fragment"; export default rogue;\n',
    );
    let fallbackCalls = 0;
    await assert.rejects(viteBuild({
      base: "/kandelo/",
      build: {
        lib: { entry: join(project, "entry.ts"), formats: ["es"] },
        outDir: join(root, "fragment-out"),
      },
      configFile: false,
      plugins: [
        createCanonicalPagesVfsProductsPlugin({
          base: "/kandelo/", map: loaded, mirrorRoots: [project],
        }),
        { name: "forbidden-fragment-fallback", resolveId() { fallbackCalls += 1; return null; } },
      ],
      root: project,
    }), /unknown canonical Pages VFS/i);
    assert.equal(fallbackCalls, 0);
  });
});

test("normal Vite mode preserves the ordinary VFS fallback", async () => {
  await withTempDirAsync(async (root) => {
    const project = join(root, "normal-project");
    mkdirSync(project);
    writeFileSync(join(project, "entry.ts"), `
      import products from "virtual:kandelo-pages-vfs-products";
      import legacy from "./legacy.vfs.zst?url";
      export function observed() { return {legacy, products}; }
    `);
    let fallbackCalls = 0;
    const output = join(root, "normal-output");
    await viteBuild({
      base: "/kandelo/",
      build: {
        emptyOutDir: true,
        lib: { entry: join(project, "entry.ts"), formats: ["es"] },
        minify: false,
        outDir: output,
        rollupOptions: { output: { entryFileNames: "entry.mjs" } },
      },
      configFile: false,
      plugins: [
        createCanonicalPagesVfsProductsPlugin({
          base: "/kandelo/", map: null, mirrorRoots: [project],
        }),
        {
          name: "ordinary-vfs-fallback",
          resolveId(source) {
            if (!source.includes("legacy.vfs.zst")) return null;
            fallbackCalls += 1;
            return "\0ordinary-vfs-fallback";
          },
          load(id) {
            return id === "\0ordinary-vfs-fallback"
              ? 'export default "/assets/legacy.vfs.zst";\n'
              : null;
          },
        },
      ],
      root: project,
    });
    assert.equal(fallbackCalls, 1);
    const module = await import(`${pathToFileURL(join(output, "entry.mjs")).href}?t=${Date.now()}`);
    assert.deepEqual(module.observed(), {
      legacy: "/assets/legacy.vfs.zst",
      products: null,
    });
  });
});

test("assembles browser, documentation, API, and exactly seven canonical VFS files", () => {
  withTempDir((root) => {
    const fixture = productMap(root);
    const outputRoot = join(root, "site");
    const commands: PagesSiteBuildCommand[] = [];
    const metadata = buildFinalPagesSite({
      execute(command) {
        commands.push(command);
        assert.equal(command.command, join(repoRoot, "scripts/dev-shell.sh"));
        assert.ok(command.environment.HOME?.startsWith(root));
        assert.ok(command.environment.TMPDIR?.startsWith(root));
        if (command.name === "browser") {
          assert.ok(command.arguments.includes(`KANDELO_PAGES_PRODUCT_MAP=${fixture.path}`));
          assert.equal(
            command.arguments.filter((argument) => argument.startsWith("VITE_BASE=")).join(","),
            "VITE_BASE=/kandelo/",
          );
          mkdirSync(command.output, { recursive: true });
          writeFileSync(join(command.output, "index.html"), "browser\n");
          mkdirSync(join(command.output, "assets"));
          writeFileSync(join(command.output, "assets/app.js"), "app\n");
        } else if (command.name === "documentation") {
          mkdirSync(command.output, { recursive: true });
          writeFileSync(join(command.output, "index.html"), "guide\n");
        } else if (command.name === "api") {
          mkdirSync(command.output, { recursive: true });
          writeFileSync(join(command.output, "index.html"), "api\n");
        }
      },
      assetGroupDirectory: fixture.assetGroupDirectory,
      outputRoot,
      productMapPath: fixture.path,
      sourceRoot: repoRoot,
    });
    assert.deepEqual(commands.map(({ name }) => name), ["browser", "documentation", "api"]);
    const vfs = metadata.files.filter(({ path }) => path.startsWith("products/"));
    assert.deepEqual(
      vfs.map(({ path }) => path),
      fixture.map.products.map(({ path }) => path).sort(),
    );
    assert.equal(vfs.length, 7);
    const groupVfs = metadata.files.filter(({ path }) => path.startsWith("vfs-groups/release-1/images/"));
    assert.deepEqual(
      groupVfs.map(({ path }) => path),
      fixture.map.products.map(({ id }) => `vfs-groups/release-1/images/${id}.vfs.zst`).sort(),
    );
    assert.equal(groupVfs.length, 7);
    assert.equal(metadata.files.length, inventory(outputRoot).length);
    assert.deepEqual(metadata.products, gallery.products);
    assert.equal(metadata.browser.path, "index.html");
    assert.equal(metadata.documentation.path, "guide/index.html");
    assert.equal(metadata.api.path, "api/index.html");
    assert.deepEqual(
      readFileSync(join(outputRoot, "vfs-groups/release-1/manifest.json"), "utf8"),
      readFileSync(join(fixture.assetGroupDirectory, "manifest.json"), "utf8"),
    );
    assert.deepEqual(
      inventory(join(outputRoot, "assets")).filter((path) => /\.vfs(?:\.zst)?$/u.test(path)),
      [],
    );
  });
});

test("rejects missing, corrupt, and unlisted files from the declared asset-group inventory", () => {
  const cases: Array<[string, (directory: string) => void]> = [
    ["missing asset", (directory) => rmSync(join(directory, "assets/runtime.wasm"))],
    ["corrupt asset", (directory) => writeFileSync(join(directory, "assets/runtime.wasm"), "corrupt\n")],
    ["unlisted VFS", (directory) => writeFileSync(join(directory, "images/unlisted.vfs.zst"), "unlisted\n")],
    ["linked asset", (directory) => {
      rmSync(join(directory, "assets/runtime.wasm"));
      symlinkSync(join(directory, "manifest.json"), join(directory, "assets/runtime.wasm"));
    }],
  ];
  for (const [name, mutate] of cases) {
    withTempDir((root) => {
      const fixture = productMap(root);
      mutate(fixture.assetGroupDirectory);
      assert.throws(
        () => buildFinalPagesSite({
          execute(command) {
            mkdirSync(command.output, { recursive: true });
            writeFileSync(join(command.output, "index.html"), `${command.name}\n`);
          },
          assetGroupDirectory: fixture.assetGroupDirectory,
          outputRoot: join(root, `site-${name}`),
          productMapPath: fixture.path,
          sourceRoot: repoRoot,
        }),
        /asset group.*inventory|symbolic link/i,
        name,
      );
    });
  }
});

test("rejects copied asset-group drift before final output publication", () => {
  withTempDir((root) => {
    const fixture = productMap(root);
    const outputRoot = join(root, "site");
    let browserOutput = "";
    assert.throws(
      () =>
        buildFinalPagesSite({
          execute(command) {
            mkdirSync(command.output, { recursive: true });
            writeFileSync(join(command.output, "index.html"), `${command.name}\n`);
            if (command.name === "browser") browserOutput = command.output;
            if (command.name === "documentation") {
              writeFileSync(
                join(
                  browserOutput,
                  "vfs-groups/release-1/assets/runtime.wasm",
                ),
                "changed after copy\n",
              );
            }
          },
          assetGroupDirectory: fixture.assetGroupDirectory,
          outputRoot,
          productMapPath: fixture.path,
          sourceRoot: repoRoot,
        }),
      /copied asset group.*inventory/i,
    );
    assert.equal(existsSync(outputRoot), false);
  });
});

test("propagates one isolated binary cache root through the Phase B dev shell", () => {
  withTempDir((root) => {
    const workflow = readFileSync(
      join(repoRoot, ".github/workflows/abi-staging-pages-canary.yml"),
      "utf8",
    );
    const produceStart = workflow.indexOf("- name: Prepare exact uncredentialed runtime");
    const produceEnd = workflow.indexOf("- name: Write the bounded production handoff");
    assert.notEqual(produceStart, -1);
    assert.ok(produceEnd > produceStart);
    assert.match(
      workflow.slice(produceStart, produceEnd),
      /bash scripts\/dev-shell\.sh env \\\n+\s+"WASM_POSIX_BINARY_CACHE_ROOT=\$WASM_POSIX_BINARY_CACHE_ROOT"/u,
    );

    const fixture = legacyProductMap(root);
    const cacheRoot = join(root, "isolated-program-cache");
    mkdirSync(cacheRoot);
    const savedCacheRoot = process.env.WASM_POSIX_BINARY_CACHE_ROOT;
    process.env.WASM_POSIX_BINARY_CACHE_ROOT = cacheRoot;
    try {
      buildFinalPagesSite({
        execute(command) {
          if (command.name === "browser") {
            const npmIndex = command.arguments.indexOf("npm");
            assert.notEqual(npmIndex, -1);
            const probe = spawnSync(command.command, [
              ...command.arguments.slice(0, npmIndex),
              "node", "--import", "tsx", "--input-type=module", "-e",
              'import { binaryCacheRoot } from "./host/src/binary-resolver.ts"; process.stdout.write(binaryCacheRoot());',
            ], {
              cwd: command.workingDirectory,
              encoding: "utf8",
              env: command.environment,
            });
            assert.equal(probe.status, 0, probe.stderr);
            assert.equal(probe.stdout.trim().split(/\r?\n/u).at(-1), cacheRoot);
          }
          mkdirSync(command.output, { recursive: true });
          writeFileSync(join(command.output, "index.html"), `${command.name}\n`);
        },
        outputRoot: join(root, "site"),
        productMapPath: fixture.path,
        sourceRoot: repoRoot,
      });
    } finally {
      if (savedCacheRoot === undefined) {
        delete process.env.WASM_POSIX_BINARY_CACHE_ROOT;
      } else {
        process.env.WASM_POSIX_BINARY_CACHE_ROOT = savedCacheRoot;
      }
    }
  });
});

test("rejects VFS emitted by Vite and symlinks from every build", () => {
  withTempDir((root) => {
    const fixture = legacyProductMap(root);
    const run = (
      mutation: "vite-vfs" | "vite-hashed-vfs" | "vite-hidden-vfs" | "symlink",
    ) => buildFinalPagesSite({
      execute(command) {
        mkdirSync(command.output, { recursive: true });
        writeFileSync(join(command.output, "index.html"), `${command.name}\n`);
        if (command.name === "browser" && mutation.startsWith("vite-")) {
          mkdirSync(join(command.output, "assets"));
          const filename = mutation === "vite-hashed-vfs"
            ? "shell.vfs-BrtFEJTw.zst"
            : mutation === "vite-hidden-vfs" ? ".vfs.zst" : "legacy.vfs.zst";
          writeFileSync(join(command.output, "assets", filename), "legacy\n");
        }
        if (command.name === "documentation" && mutation === "symlink") {
          symlinkSync(join(command.output, "index.html"), join(command.output, "linked.html"));
        }
      },
      outputRoot: join(root, `site-${mutation}`),
      productMapPath: fixture.path,
      sourceRoot: repoRoot,
    });
    assert.throws(() => run("vite-vfs"), /Vite output contains VFS/i);
    assert.throws(() => run("vite-hashed-vfs"), /Vite output contains VFS/i);
    assert.throws(() => run("vite-hidden-vfs"), /Vite output contains VFS/i);
    assert.throws(() => run("symlink"), /symbolic link/i);
  });
});

function inventory(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, name.name);
      if (name.isDirectory()) visit(path);
      else result.push(relative(root, path).split(sep).join("/"));
    }
  };
  visit(root);
  return result.sort();
}
