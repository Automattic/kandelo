import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  compiledWorkerEntryIsCurrent,
  hostBuildFingerprintBanner,
  inspectCompiledWorkerEntry,
} from "../src/compiled-worker-entry";
import {
  NODE_KERNEL_WORKER_PATH_ENV,
  selectNodeKernelWorkerEntry,
} from "../src/node-kernel-host";

const temporaryDirectories: string[] = [];

function writeAt(path: string, contents: string, seconds: number): void {
  writeFileSync(path, contents);
  utimesSync(path, seconds, seconds);
}

function createSourceCheckout(root: string): {
  entry: string;
  imported: string;
} {
  const source = join(root, "src");
  const nested = join(source, "nested");
  mkdirSync(source);
  mkdirSync(nested);
  for (const file of [
    "package-lock.json",
    "package.json",
    "tsconfig.json",
    "tsup.config.ts",
  ]) {
    writeAt(join(root, file), `${file}\n`, 100);
  }
  const entry = join(source, "entry.ts");
  const imported = join(nested, "imported.ts");
  writeAt(entry, "import './nested/imported';", 100);
  writeAt(imported, "export const value = 1;", 100);
  return { entry, imported };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("compiled worker freshness", () => {
  it("invalidates a bundle when source or build configuration changes", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-worker-freshness-"));
    temporaryDirectories.push(root);
    const { entry, imported } = createSourceCheckout(root);
    const bundle = join(root, "entry.js");

    writeAt(bundle, hostBuildFingerprintBanner(root), 200);
    expect(compiledWorkerEntryIsCurrent(entry, bundle)).toBe(true);

    writeAt(imported, "export const value = 2;", 100);
    expect(compiledWorkerEntryIsCurrent(entry, bundle)).toBe(false);

    writeAt(bundle, hostBuildFingerprintBanner(root), 200);
    expect(compiledWorkerEntryIsCurrent(entry, bundle)).toBe(true);

    writeAt(join(root, "tsup.config.ts"), "changed config\n", 100);
    expect(compiledWorkerEntryIsCurrent(entry, bundle)).toBe(false);
  });

  it("does not accept a touched stale bundle without an exact marker", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-worker-touched-"));
    temporaryDirectories.push(root);
    const { entry } = createSourceCheckout(root);
    const bundle = join(root, "entry.js");

    writeAt(bundle, "/* stale but newly touched */", 10_000);
    expect(compiledWorkerEntryIsCurrent(entry, bundle)).toBe(false);
  });

  it("accepts a packaged bundle when source files are absent", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-worker-package-"));
    temporaryDirectories.push(root);
    const bundle = join(root, "entry.js");
    writeAt(bundle, "/* packaged */", 100);

    expect(
      compiledWorkerEntryIsCurrent(join(root, "entry.ts"), bundle),
    ).toBe(true);
  });
});

describe("compiled worker inspection", () => {
  it("reports both fingerprints and why a stale bundle is not current", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-worker-inspect-"));
    temporaryDirectories.push(root);
    const { entry, imported } = createSourceCheckout(root);
    const bundle = join(root, "entry.js");

    writeAt(bundle, hostBuildFingerprintBanner(root), 200);
    const fresh = inspectCompiledWorkerEntry(entry, bundle);
    expect(fresh.current).toBe(true);
    expect(fresh.bundleFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh.sourceFingerprint).toBe(fresh.bundleFingerprint);
    expect(fresh.reason).toBeNull();

    writeAt(imported, "export const value = 2;", 100);
    const stale = inspectCompiledWorkerEntry(entry, bundle);
    expect(stale.current).toBe(false);
    expect(stale.bundleFingerprint).toBe(fresh.bundleFingerprint);
    expect(stale.sourceFingerprint).not.toBe(fresh.bundleFingerprint);
    expect(stale.reason).toMatch(/built from different host inputs/);
  });
});

describe("Node kernel worker entry selection", () => {
  /** A fake host package: src/node-kernel-worker-entry.ts + dist bundle. */
  function createHostCheckout(): { srcDir: string; dist: string; imported: string } {
    const root = mkdtempSync(join(tmpdir(), "kandelo-kernel-entry-"));
    temporaryDirectories.push(root);
    const { imported } = createSourceCheckout(root);
    const srcDir = join(root, "src");
    writeAt(join(srcDir, "node-kernel-worker-entry.ts"), "export {};", 100);
    mkdirSync(join(root, "dist"));
    const dist = join(root, "dist", "node-kernel-worker-entry.js");
    writeAt(dist, hostBuildFingerprintBanner(root), 200);
    return { srcDir, dist, imported };
  }

  it("runs a current bundle and records its fingerprint", () => {
    const { srcDir, dist } = createHostCheckout();
    for (const policy of [undefined, "auto", "bundled"]) {
      const env = policy === undefined
        ? {}
        : { [NODE_KERNEL_WORKER_PATH_ENV]: policy };
      const selection = selectNodeKernelWorkerEntry({ env, moduleDir: srcDir });
      expect(selection.path).toBe("bundled");
      expect(selection.entry).toBe(dist);
      expect(selection.bundleFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(selection.fallbackReason).toBeNull();
    }
  });

  it("keeps the development tsx fallback for a stale bundle by default", () => {
    const { srcDir, imported } = createHostCheckout();
    writeAt(imported, "export const value = 2;", 100);
    const selection = selectNodeKernelWorkerEntry({ env: {}, moduleDir: srcDir });
    expect(selection.path).toBe("tsx");
    expect(selection.entry).toBe(join(srcDir, "node-kernel-worker-entry.ts"));
    expect(selection.fallbackReason).toMatch(/different host inputs/);
  });

  it("refuses a stale bundle under the bundled policy and names the rebuild", () => {
    const { srcDir, imported } = createHostCheckout();
    writeAt(imported, "export const value = 2;", 100);
    expect(() =>
      selectNodeKernelWorkerEntry({
        env: { [NODE_KERNEL_WORKER_PATH_ENV]: "bundled" },
        moduleDir: srcDir,
      })
    ).toThrow(/host bundle is stale or missing.*\.\/run\.sh build host/s);
  });

  it("takes the tsx path on request even with a current bundle", () => {
    const { srcDir } = createHostCheckout();
    const selection = selectNodeKernelWorkerEntry({
      env: { [NODE_KERNEL_WORKER_PATH_ENV]: "tsx" },
      moduleDir: srcDir,
    });
    expect(selection.path).toBe("tsx");
    expect(selection.policy).toBe("tsx");
  });

  it("rejects an unknown policy instead of guessing", () => {
    const { srcDir } = createHostCheckout();
    expect(() =>
      selectNodeKernelWorkerEntry({
        env: { [NODE_KERNEL_WORKER_PATH_ENV]: "fast" },
        moduleDir: srcDir,
      })
    ).toThrow(/not one of auto, bundled, tsx/);
  });
});
