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

import { checkPagesVfsProductRegistry } from "./check-pages-vfs-product-registry.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(repoRoot, "images/vfs/products/generated/catalog.json");
const registryPath = join(
  repoRoot,
  "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml",
);
const galleryPath = join(
  repoRoot,
  "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-gallery.json",
);
const presentationPath = join(repoRoot, "apps/browser-demos/pages/kandelo/presets.ts");
const adapterPath = join(repoRoot, "abi/staging/legacy-vfs-adapters.toml");
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
  galleryPath,
  presentationPath,
  adapterPath,
  browserDepsPath,
  browserSources,
};

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
      return `${contents}\nconst python = import.meta.glob("../../../../../binaries/programs/wasm32/python-vfs.vfs.zst");\n`;
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
