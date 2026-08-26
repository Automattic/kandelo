import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkPagesVfsProductRegistry,
  isVfsSpecifier,
  readPagesRegistry,
} from "./check-pages-vfs-product-registry.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(repoRoot, "images/vfs/products/generated/catalog.json");
const registryPath = join(
  repoRoot,
  "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml",
);
const generatedRegistryPath = join(
  repoRoot,
  "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json",
);
const galleryPath = join(
  repoRoot,
  "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-gallery.json",
);
const presentationPath = join(repoRoot, "apps/browser-demos/pages/kandelo/presets.ts");
const browserDepsPath = join(repoRoot, "run.sh");
const browserSources = [
  join(repoRoot, "host/src/browser-kernel-default-artifacts.ts"),
  join(repoRoot, "apps/browser-demos/vite.config.ts"),
  join(repoRoot, "apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts"),
  join(repoRoot, "apps/browser-demos/pages/kandelo/kernel-host/optional-demo-vfs.ts"),
];
const paths = {
  catalogPath,
  registryPath,
  generatedRegistryPath,
  galleryPath,
  presentationPath,
  browserDepsPath,
  browserSources,
};

test("classifies empty-basename and fragmented VFS requests", () => {
  for (const request of [
    ".vfs",
    ".vfs.zst",
    "assets/.vfs.zst",
    "rogue.vfs.zst#fragment",
    "rogue.vfs.zst?url#fragment",
  ]) {
    assert.equal(isVfsSpecifier(request), true, request);
  }
  for (const request of ["assets/vfs.zst", "asset.vfs.js", "guide/vfs-format.html"]) {
    assert.equal(isVfsSpecifier(request), false, request);
  }
});

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}

function canonicalBytes(value) {
  return `${JSON.stringify(normalize(value))}\n`;
}

function digest(manifest) {
  return createHash("sha256").update(canonicalBytes(manifest)).digest("hex");
}

function withTempDir(run) {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-pages-products-test-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function copyBrowserSources(directory, mutate = () => undefined) {
  return browserSources.map((source) => {
    const target = join(directory, basename(source));
    let contents = readFileSync(source, "utf8");
    contents = mutate(source, contents) ?? contents;
    writeFileSync(target, contents);
    return target;
  });
}

function writeCatalog(directory, mutate) {
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  mutate(catalog);
  const target = join(directory, "catalog.json");
  writeFileSync(target, canonicalBytes(catalog));
  return target;
}

test("the repository Pages sources exactly project the Pages-owned registry", () => {
  checkPagesVfsProductRegistry(paths);
  assert.deepEqual(
    readPagesRegistry(registryPath),
    JSON.parse(readFileSync(generatedRegistryPath, "utf8")),
  );
});

test("rejects source-only and generated-only Pages registry mutations", () => {
  withTempDir((directory) => {
    const sourceOnly = join(directory, "pages.toml");
    writeFileSync(
      sourceOnly,
      readFileSync(registryPath, "utf8").replace(
        'id = "browser-node"',
        'id = "browser-node-source-only"',
      ),
    );
    assert.throws(
      () => checkPagesVfsProductRegistry({ ...paths, registryPath: sourceOnly }),
      /source and generated Pages registries differ/i,
    );

    const generatedOnly = join(directory, "pages.generated.json");
    const generated = JSON.parse(readFileSync(generatedRegistryPath, "utf8"));
    generated.products[0].load = generated.products[0].load === "eager" ? "lazy" : "eager";
    writeFileSync(generatedOnly, canonicalBytes(generated));
    assert.throws(
      () => checkPagesVfsProductRegistry({
        ...paths,
        generatedRegistryPath: generatedOnly,
      }),
      /source and generated Pages registries differ/i,
    );
  });
});

test("rejects gallery product, preset, and VFS-image mapping drift", () => {
  withTempDir((directory) => {
    const mutateGallery = (name, mutate) => {
      const gallery = JSON.parse(readFileSync(galleryPath, "utf8"));
      mutate(gallery);
      const path = join(directory, name);
      writeFileSync(path, canonicalBytes(gallery));
      return path;
    };
    assert.throws(
      () => checkPagesVfsProductRegistry({
        ...paths,
        galleryPath: mutateGallery("missing.json", (gallery) => gallery.products.pop()),
      }),
      /gallery.*Pages product set/i,
    );
    assert.throws(
      () => checkPagesVfsProductRegistry({
        ...paths,
        galleryPath: mutateGallery("unknown.json", (gallery) => {
          gallery.products.find(({ id }) => id === "browser-node").gallery_entries = ["rogue"];
        }),
      }),
      /gallery entries differ.*preset/i,
    );
    assert.throws(
      () => checkPagesVfsProductRegistry({
        ...paths,
        galleryPath: mutateGallery("wrong-image.json", (gallery) => {
          gallery.products.find(({ id }) => id === "browser-node").vfs_image = "shell";
        }),
      }),
      /gallery entry node.*VFS image node/i,
    );
  });
});

test("rejects product-owned Pages intent and a missing product output", () => {
  withTempDir((directory) => {
    const pagesCatalog = writeCatalog(directory, (catalog) => {
      catalog.products[0].manifest.pages = true;
      catalog.products[0].sha256 = digest(catalog.products[0].manifest);
    });
    assert.throws(
      () => checkPagesVfsProductRegistry({ ...paths, catalogPath: pagesCatalog }),
      /unknown field.*pages/i,
    );

    const outputCatalog = writeCatalog(directory, (catalog) => {
      const product = catalog.products.find(
        ({ manifest }) => manifest.id === "browser-node",
      );
      delete product.manifest.output;
      product.sha256 = digest(product.manifest);
    });
    assert.throws(
      () => checkPagesVfsProductRegistry({ ...paths, catalogPath: outputCatalog }),
      /missing required field output/i,
    );
  });
});

test("enforces eager static imports and lazy glob-only imports", () => {
  withTempDir((directory) => {
    const eagerOnlyGlob = copyBrowserSources(directory, (source, contents) => {
      if (!source.endsWith("live-setup.ts")) return contents;
      return contents.replace(
        'import shellVfsUrl from "@binaries/programs/wasm32/shell.vfs.zst?url";',
        'const shellVfsUrl = import.meta.glob("../../../../../binaries/programs/wasm32/shell.vfs.zst");',
      );
    });
    assert.throws(
      () => checkPagesVfsProductRegistry({ ...paths, browserSources: eagerOnlyGlob }),
      /browser-main-shell.*eager.*static import/is,
    );

    const lazyStatic = copyBrowserSources(directory, (source, contents) => {
      if (!source.endsWith("live-setup.ts")) return contents;
      return `import nodeVfs from "@binaries/programs/wasm32/node-vfs.vfs.zst?url";\n${contents}`;
    });
    assert.throws(
      () => checkPagesVfsProductRegistry({ ...paths, browserSources: lazyStatic }),
      /browser-node.*lazy.*static import/is,
    );
  });
});

test("rejects absent, unregistered, and unselected VFS source paths", () => {
  withTempDir((directory) => {
    const absent = copyBrowserSources(directory, (source, contents) => {
      if (!source.endsWith("optional-demo-vfs.ts")) return contents;
      return contents.replaceAll("node-vfs.vfs.zst", "node-vfs.absent");
    });
    assert.throws(
      () => checkPagesVfsProductRegistry({ ...paths, browserSources: absent }),
      /browser-node.*glob/is,
    );

    const rogue = copyBrowserSources(directory, (source, contents) => {
      if (!source.endsWith("optional-demo-vfs.ts")) return contents;
      return `${contents}\nconst rogue = import.meta.glob("../../../../../binaries/programs/wasm32/rogue.vfs.zst");\n`;
    });
    assert.throws(
      () => checkPagesVfsProductRegistry({ ...paths, browserSources: rogue }),
      /unregistered.*rogue\.vfs\.zst/is,
    );

    const unselected = copyBrowserSources(directory, (source, contents) => {
      if (!source.endsWith("optional-demo-vfs.ts")) return contents;
      return `${contents}\nconst python = import.meta.glob("../../../../../binaries/programs/wasm32/python.vfs.zst");\n`;
    });
    assert.throws(
      () => checkPagesVfsProductRegistry({ ...paths, browserSources: unselected }),
      /browser-python.*not selected.*Pages/is,
    );
  });
});

test("checks registered VFS build targets without owning non-VFS prerequisites", () => {
  withTempDir((directory) => {
    const rogueRun = join(directory, "run-rogue.sh");
    writeFileSync(
      rogueRun,
      readFileSync(browserDepsPath, "utf8").replace(
        "BROWSER_DEPS=(kernel ",
        "BROWSER_DEPS=(rogue-vfs kernel ",
      ),
    );
    assert.throws(
      () => checkPagesVfsProductRegistry({ ...paths, browserDepsPath: rogueRun }),
      /unregistered VFS build target.*rogue-vfs/is,
    );

    const missingRun = join(directory, "run-missing.sh");
    writeFileSync(
      missingRun,
      readFileSync(browserDepsPath, "utf8").replace(" shell-vfs ", " "),
    );
    assert.throws(
      () => checkPagesVfsProductRegistry({ ...paths, browserDepsPath: missingRun }),
      /browser-main-shell.*shell-vfs/is,
    );
  });
});

test("keeps canonical resolution ahead of legacy fallback for every Pages product", () => {
  withTempDir((directory) => {
    const reordered = copyBrowserSources(directory, (source, contents) => {
      if (!source.endsWith("vite.config.ts")) return contents;
      return contents.replace(
        "      vfsProductsPlugin(base),\n      react(),",
        "      react(),\n      resolveKernelArtifactsAlias(binaryDevAccess),\n      vfsProductsPlugin(base),",
      ).replace(
        "      resolveKernelArtifactsAlias(binaryDevAccess),\n      resolveBinariesAlias",
        "      resolveBinariesAlias",
      );
    });
    assert.throws(
      () => checkPagesVfsProductRegistry({ ...paths, browserSources: reordered }),
      /canonical Pages VFS resolver.*precede/i,
    );

    const missingProduct = copyBrowserSources(directory, (source, contents) => {
      if (!source.endsWith("live-setup.ts")) return contents;
      return contents.replace('productId: "browser-node"', 'productId: "browser-rogue"');
    });
    assert.throws(
      () => checkPagesVfsProductRegistry({ ...paths, browserSources: missingProduct }),
      /canonical product mapping.*browser-node/i,
    );

    const fallback = copyBrowserSources(directory, (source, contents) => {
      if (!source.endsWith("optional-demo-vfs.ts")) return contents;
      return contents.replace(
        "  if (canonicalProductUrl !== undefined) return canonicalProductUrl();",
        "  if (false && canonicalProductUrl !== undefined) return canonicalProductUrl();",
      );
    });
    assert.throws(
      () => checkPagesVfsProductRegistry({ ...paths, browserSources: fallback }),
      /evaluate fallback in canonical mode/i,
    );
  });
});
