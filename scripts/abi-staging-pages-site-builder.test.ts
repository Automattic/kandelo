import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
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
import { build as viteBuild, type Plugin } from "vite";

import { ABI_VERSION } from "../host/src/generated/abi.ts";
import {
  buildFinalPagesSite,
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

function productMap(root: string): { map: CanonicalPagesProductMapV1; path: string } {
  const privateRoot = join(root, "sealed");
  mkdirSync(privateRoot);
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
  const map = {
    kind: "kandelo-pages-private-product-map" as const,
    products,
    schema: 1 as const,
  };
  const path = join(root, "private-map.json");
  writeFileSync(path, canonicalBytes(map), { mode: 0o600 });
  return { map, path };
}

function writeMap(root: string, name: string, map: unknown): string {
  const path = join(root, name);
  writeFileSync(path, canonicalBytes(map));
  return path;
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

test("canonical Vite mode exports exact URLs without emitting or consulting legacy VFS", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = productMap(root);
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
      base: "/kandelo/",
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
          base: "/kandelo/",
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
    const url = (id: string) => `/kandelo/${byId.get(id)!.path}`;
    assert.deepEqual(observed.products, loaded.products.map(({ private_path: _, ...entry }) => ({
      ...entry,
      path: `/kandelo/${entry.path}`,
    })));
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

test("canonical Vite mode fails closed for an unknown VFS request", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = productMap(root);
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
      outputRoot,
      productMapPath: fixture.path,
      sourceRoot: repoRoot,
    });
    assert.deepEqual(commands.map(({ name }) => name), ["browser", "documentation", "api"]);
    const vfs = metadata.files.filter(({ path }) => /\.vfs(?:\.zst)?$/u.test(path));
    assert.deepEqual(
      vfs.map(({ path }) => path),
      fixture.map.products.map(({ path }) => path).sort(),
    );
    assert.equal(vfs.length, 7);
    assert.equal(metadata.files.length, inventory(outputRoot).length);
    assert.deepEqual(metadata.products, gallery.products);
    assert.equal(metadata.browser.path, "index.html");
    assert.equal(metadata.documentation.path, "guide/index.html");
    assert.equal(metadata.api.path, "api/index.html");
    assert.deepEqual(
      inventory(join(outputRoot, "assets")).filter((path) => /\.vfs(?:\.zst)?$/u.test(path)),
      [],
    );
  });
});

test("rejects VFS emitted by Vite and symlinks from every build", () => {
  withTempDir((root) => {
    const fixture = productMap(root);
    const run = (mutation: "vite-vfs" | "vite-hashed-vfs" | "symlink") => buildFinalPagesSite({
      execute(command) {
        mkdirSync(command.output, { recursive: true });
        writeFileSync(join(command.output, "index.html"), `${command.name}\n`);
        if (command.name === "browser" && mutation.startsWith("vite-")) {
          mkdirSync(join(command.output, "assets"));
          const filename = mutation === "vite-hashed-vfs"
            ? "shell.vfs-BrtFEJTw.zst"
            : "legacy.vfs.zst";
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
