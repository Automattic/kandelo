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
} from "../src/compiled-worker-entry";

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
