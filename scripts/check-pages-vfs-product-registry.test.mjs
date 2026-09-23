import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
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
  assertNoAppMachineIdentityTables,
  checkPagesVfsProductRegistry,
  isVfsSpecifier,
  readPagesRegistry,
} from "./check-pages-vfs-product-registry.mjs";
import { loadVfsProductCatalog } from "./vfs-product-catalog.mjs";

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
const rosterPath = join(repoRoot, "apps/browser-demos/pages/kandelo/gallery-roster.json");
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
  rosterPath,
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
        'id = "browser-nginx"',
        'id = "browser-nginx-source-only"',
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

test("rejects gallery product, roster, and VFS-image mapping drift", () => {
  withTempDir((directory) => {
    const mutateGallery = (name, mutate) => {
      const gallery = JSON.parse(readFileSync(galleryPath, "utf8"));
      mutate(gallery);
      const path = join(directory, name);
      writeFileSync(path, canonicalBytes(gallery));
      return path;
    };
    const mutateRoster = (name, mutate) => {
      const roster = JSON.parse(readFileSync(rosterPath, "utf8"));
      mutate(roster);
      const path = join(directory, name);
      writeFileSync(path, canonicalBytes(roster));
      return path;
    };
    assert.throws(
      () => checkPagesVfsProductRegistry({
        ...paths,
        galleryPath: mutateGallery("missing.json", (gallery) => gallery.products.pop()),
      }),
      /gallery.*Pages product set/i,
    );
    // pages-vfs-product-gallery.json does deployment scoping only (no
    // `gallery_entries`); the roster is the sole membership authority, so
    // the drift this schema can no longer express is a roster entry naming
    // a product that does not exist at all.
    assert.throws(
      () => checkPagesVfsProductRegistry({
        ...paths,
        rosterPath: mutateRoster("unknown-product.json", (roster) => {
          roster.entries[0].product = "browser-rogue";
        }),
      }),
      /gallery roster references unknown product browser-rogue/i,
    );
    assert.throws(
      () => checkPagesVfsProductRegistry({
        ...paths,
        galleryPath: mutateGallery("wrong-image.json", (gallery) => {
          gallery.products.find(({ id }) => id === "browser-nginx").vfs_image = "shell";
        }),
      }),
      /gallery product browser-nginx declares VFS image shell, not nginx/i,
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
        ({ manifest }) => manifest.id === "browser-nginx",
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
      return `import nginxVfs from "@binaries/programs/wasm32/nginx-vfs.vfs.zst?url";\n${contents}`;
    });
    assert.throws(
      () => checkPagesVfsProductRegistry({ ...paths, browserSources: lazyStatic }),
      /browser-nginx.*lazy.*static import/is,
    );
  });
});

test("rejects absent, unregistered, and unselected VFS source paths", () => {
  withTempDir((directory) => {
    const absent = copyBrowserSources(directory, (source, contents) => {
      if (!source.endsWith("optional-demo-vfs.ts")) return contents;
      return contents.replaceAll("wordpress.vfs.zst", "wordpress.absent");
    });
    assert.throws(
      () => checkPagesVfsProductRegistry({ ...paths, browserSources: absent }),
      /browser-wordpress.*glob/is,
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
      return contents.replace('productId: "browser-nginx"', 'productId: "browser-rogue"');
    });
    assert.throws(
      () => checkPagesVfsProductRegistry({ ...paths, browserSources: missingProduct }),
      /canonical product mapping.*browser-nginx/i,
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

// Task B6: assert the app holds no built-in machine identities. These tests
// scan an isolated temp directory tree (never the real apps/browser-demos or
// web-libs/kandelo-session sources), so the "reintroduce a table, watch it
// fail" case never mutates this repository's real files.
const realCatalog = loadVfsProductCatalog(catalogPath);
// A minimal catalog whose product ids share nothing with any tracked
// profile id, so these tests exercise the SCANNING logic (and the named
// exemptions) rather than the "admit catalog products" carve-out.
const fakeCatalog = { productIds: ["browser-main-shell", "browser-node", "platform-rootfs"] };

function writeFixture(root, relPath, contents) {
  const target = join(root, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

test("the real browser app and web-libs hold no machine-identity tables", () => {
  assert.doesNotThrow(() => assertNoAppMachineIdentityTables(realCatalog));
});

// THE TEST THAT MATTERS MOST: reintroduce a table shaped like the deleted
// LIVE_DEMO_SPECS, keyed by profile id, and confirm the checker rejects it
// by name. This never touches the real tree — the fixture lives in a temp
// directory that assertNoAppMachineIdentityTables scans in place of the
// real apps/browser-demos.
test("rejects a reintroduced LIVE_DEMO_SPECS-shaped table keyed by profile id", () => {
  withTempDir((directory) => {
    writeFixture(
      directory,
      "apps/browser-demos/pages/kandelo/kernel-host/reintroduced-live-demo-specs.ts",
      `
      export const LIVE_DEMO_SPECS = {
        doom: { argv: ["/usr/bin/fbdoom"], memoryPages: 4096 },
        sdl2: { argv: ["/usr/bin/sdl2_demo"], memoryPages: 4096 },
      };
      `,
    );
    assert.throws(
      () => assertNoAppMachineIdentityTables(fakeCatalog, directory),
      /machine-identity table[\s\S]*reintroduced-live-demo-specs\.ts.*object literal.*\[(doom, sdl2|sdl2, doom)\]/,
    );
  });
});

test("rejects a reintroduced id union type keyed by profile id", () => {
  withTempDir((directory) => {
    writeFixture(
      directory,
      "apps/browser-demos/pages/kandelo/kernel-host/reintroduced-live-demo-id.ts",
      `export type LiveDemoId = "doom" | "sdl2" | "modeset";`,
    );
    assert.throws(
      () => assertNoAppMachineIdentityTables(fakeCatalog, directory),
      /union type/,
    );
  });
});

test("rejects a reintroduced id-selection switch statement", () => {
  withTempDir((directory) => {
    writeFixture(
      directory,
      "apps/browser-demos/pages/kandelo/kernel-host/reintroduced-switch.ts",
      `
      function pick(id: string) {
        switch (id) {
          case "doom": return 1;
          case "sdl2": return 2;
          default: return 0;
        }
      }
      `,
    );
    assert.throws(
      () => assertNoAppMachineIdentityTables(fakeCatalog, directory),
      /switch statement/,
    );
  });
});

test("does not flag a single incidental profile-id key (below the >=2 threshold)", () => {
  withTempDir((directory) => {
    writeFixture(
      directory,
      "apps/browser-demos/pages/kandelo/app/theme.ts",
      `type ThemeFamily = "ubuntu" | "wordpress" | "kandelo";`,
    );
    assert.doesNotThrow(() => assertNoAppMachineIdentityTables(fakeCatalog, directory));
  });
});

test("admits product-id-keyed plumbing (not a machine-identity table)", () => {
  withTempDir((directory) => {
    writeFixture(
      directory,
      "apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts",
      `
      const VFS_PRODUCTS = {
        "browser-main-shell": { kind: "url", url: "shell.vfs.zst" },
        "browser-wordpress": { kind: "optional-demo", image: "wordpress" },
      };
      `,
    );
    // "browser-main-shell" and "browser-wordpress" ARE in realCatalog.productIds,
    // so this must pass against the real catalog admission rule too.
    assert.doesNotThrow(() => assertNoAppMachineIdentityTables(realCatalog, directory));
  });
});

test("exempts OPTIONAL_DEMO_VFS_PATHS in optional-demo-vfs.ts by name", () => {
  withTempDir((directory) => {
    writeFixture(
      directory,
      "apps/browser-demos/pages/kandelo/kernel-host/optional-demo-vfs.ts",
      `
      export const OPTIONAL_DEMO_VFS_PATHS = {
        node: { label: "node-vfs.vfs.zst", relPaths: [] },
        wordpress: { label: "wordpress.vfs.zst", relPaths: [] },
        lamp: { label: "lamp.vfs.zst", relPaths: [] },
      };
      `,
    );
    assert.doesNotThrow(() => assertNoAppMachineIdentityTables(fakeCatalog, directory));
  });
});

test("does NOT exempt a differently-named table in the same exempted file", () => {
  withTempDir((directory) => {
    writeFixture(
      directory,
      "apps/browser-demos/pages/kandelo/kernel-host/optional-demo-vfs.ts",
      `
      export const OPTIONAL_DEMO_VFS_PATHS = {
        node: { label: "node-vfs.vfs.zst", relPaths: [] },
      };
      export const SNUCK_IN_TABLE = {
        doom: { argv: ["/usr/bin/fbdoom"] },
        sdl2: { argv: ["/usr/bin/sdl2_demo"] },
      };
      `,
    );
    assert.throws(
      () => assertNoAppMachineIdentityTables(fakeCatalog, directory),
      /SNUCK_IN_TABLE/,
    );
  });
});

test("exempts candidate-evidence-vfs.ts's protected ABI-staging admission tables by name", () => {
  withTempDir((directory) => {
    writeFixture(
      directory,
      "apps/browser-demos/pages/kandelo/kernel-host/candidate-evidence-vfs.ts",
      `
      export type CandidateEvidenceLiveDemoId =
        | "shell" | "node" | "nginx" | "nginx-php"
        | "wordpress-sqlite" | "wordpress-mariadb" | "doom" | "modeset";
      const LIVE_DEMO_BY_EVIDENCE_PROFILE = {
        shell: "shell", doom: "doom", modeset: "modeset", node: "node",
        nginx: "nginx", "nginx-php": "nginx-php",
        "wordpress-sqlite": "wordpress-sqlite", "wordpress-mariadb": "wordpress-mariadb",
      };
      `,
    );
    assert.doesNotThrow(() => assertNoAppMachineIdentityTables(fakeCatalog, directory));
  });
});
