import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifestPath = join(repoRoot, "tests", "test-artifacts", "kernel-test-programs.json");
const registryPackagePath = join(repoRoot, "packages", "registry", "kernel-test-programs");
const browserBinaryDepsTest = join(
  repoRoot,
  "tests",
  "package-system",
  "browser-binary-dependencies.test.ts",
);

type FixtureEntry = {
  name: string;
  arch: "wasm32" | "wasm64";
  source: string;
  binary: string;
  resolver_path: string;
  consumers: string[];
};

type LegacyOutput = {
  name: string;
  wasm: string;
  disposition: string;
  fixture?: string;
  owner?: string;
  alternate_test_fixture?: string;
  reason?: string;
};

type KernelTestProgramsManifest = {
  schema: number;
  name: string;
  owner: string;
  producer: {
    script: string;
    output_root: string;
  };
  fixtures: FixtureEntry[];
  legacy_outputs: LegacyOutput[];
};

const expectedFixtures = [
  "exec-caller",
  "exec-child",
  "fork-exec",
  "hello64",
  "ifhwaddr",
  "mmap_shared_test",
].sort();

const legacyOutputsFromRemovedPackage = [
  "exec-caller",
  "exec-child",
  "fork-exec",
  "hello",
  "hello64",
  "ifhwaddr",
  "mmap_shared_test",
].sort();

function readManifest(): KernelTestProgramsManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as KernelTestProgramsManifest;
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  return !path.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function fileExists(relPath: string): boolean {
  return existsSync(join(repoRoot, relPath));
}

function formulaNames(): string[] {
  const formulaDir = join(repoRoot, "homebrew", "kandelo-homebrew", "Formula");
  if (!existsSync(formulaDir)) return [];
  return readdirSync(formulaDir)
    .filter((name) => name.endsWith(".rb"))
    .map((name) => name.replace(/\.rb$/, ""));
}

describe("kernel test fixture ownership", () => {
  it("keeps kernel-test-programs out of package and Homebrew discovery", () => {
    expect(existsSync(join(registryPackagePath, "package.toml"))).toBe(false);
    expect(formulaNames()).not.toContain("kernel-test-programs");
    expect(
      existsSync(
        join(repoRoot, "homebrew", "kandelo-homebrew", "Kandelo", "formula", "kernel-test-programs.json"),
      ),
    ).toBe(false);

    const browserBinaryDepsSource = readFileSync(browserBinaryDepsTest, "utf8");
    const exceptionSet = browserBinaryDepsSource.match(
      /const registryPackagesWithoutBuildToml = new Set\(\[([\s\S]*?)\]\);/,
    );
    expect(exceptionSet?.[1] ?? "").not.toContain("\"kernel-test-programs\"");
  });

  it("records every migrated fixture with source, output, and consumer ownership", () => {
    const manifest = readManifest();
    expect(manifest.schema).toBe(1);
    expect(manifest.name).toBe("kernel-test-programs");
    expect(manifest.owner).toBe("host-kernel-tests");
    expect(manifest.producer).toEqual({
      script: "scripts/build-programs.sh",
      output_root: "local-binaries/programs",
    });
    expect(isSafeRelativePath(manifest.producer.script), "producer script").toBe(true);
    expect(isSafeRelativePath(manifest.producer.output_root), "producer output root").toBe(true);
    expect(fileExists(manifest.producer.script)).toBe(true);

    const fixtureNames = manifest.fixtures.map((fixture) => fixture.name).sort();
    expect(fixtureNames).toEqual(expectedFixtures);

    for (const fixture of manifest.fixtures) {
      expect(isSafeRelativePath(fixture.source), `${fixture.name} source`).toBe(true);
      expect(isSafeRelativePath(fixture.binary), `${fixture.name} binary`).toBe(true);
      expect(isSafeRelativePath(fixture.resolver_path), `${fixture.name} resolver_path`).toBe(true);
      expect(fileExists(fixture.source), `${fixture.name} source exists`).toBe(true);
      expect(fixture.binary).toBe(`programs/${fixture.arch}/${fixture.name}.wasm`);
      if (fixture.arch === "wasm32") {
        expect(fixture.resolver_path).toBe(`programs/${fixture.name}.wasm`);
      } else {
        expect(fixture.resolver_path).toBe(fixture.binary);
      }
      expect(fixture.consumers.length, `${fixture.name} consumers`).toBeGreaterThan(0);
      for (const consumer of fixture.consumers) {
        expect(isSafeRelativePath(consumer), `${fixture.name} consumer ${consumer}`).toBe(true);
        expect(fileExists(consumer), `${fixture.name} consumer ${consumer} exists`).toBe(true);
      }
    }
  });

  it("accounts for every output from the removed registry manifest", () => {
    const manifest = readManifest();
    const legacyNames = manifest.legacy_outputs.map((output) => output.name).sort();
    expect(legacyNames).toEqual(legacyOutputsFromRemovedPackage);

    const fixtures = new Set(manifest.fixtures.map((fixture) => fixture.name));
    for (const output of manifest.legacy_outputs) {
      expect(isSafeRelativePath(output.wasm), `${output.name} wasm`).toBe(true);
      if (output.disposition === "migrated-fixture") {
        expect(output.fixture, `${output.name} fixture pointer`).toBe(output.name);
        expect(fixtures.has(output.fixture!), `${output.name} fixture exists`).toBe(true);
      } else if (output.name === "hello") {
        expect(output.disposition).toBe("package-owned");
        expect(output.owner).toBe("packages/registry/hello/package.toml");
        expect(output.alternate_test_fixture).toBe("examples/hello.wasm");
        expect(output.reason).toMatch(/GNU hello/);
        expect(fileExists(output.owner!), "hello owner exists").toBe(true);
        expect(fileExists("examples/hello.c"), "hello test source exists").toBe(true);
      } else {
        throw new Error(`unexpected legacy disposition for ${output.name}: ${output.disposition}`);
      }
    }
  });
});
