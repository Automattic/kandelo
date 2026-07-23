import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registryPackagesWithoutBuildToml } from "../../scripts/browser-binary-package-roots.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifestPath = join(repoRoot, "tests", "test-artifacts", "kernel-test-programs.json");
const registryPackagePath = join(repoRoot, "packages", "registry", "kernel-test-programs");
type FixtureEntry = {
  id: string;
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

const expectedFixtureIds = [
  "exec-caller:wasm32",
  "exec-child:wasm32",
  "fork-exec:wasm32",
  "hello64:wasm64",
  "ifhwaddr:wasm32",
  "ifhwaddr:wasm64",
  "mmap_shared_test:wasm32",
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

function sourceFilesUnder(path: string): string[] {
  const absolute = join(repoRoot, path);
  if (!existsSync(absolute)) return [];
  const entries = readdirSync(absolute, { withFileTypes: true });
  return entries.flatMap((entry) => {
    if (["node_modules", "target", "dist", ".git"].includes(entry.name)) return [];
    const child = join(path, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(child);
    return /\.(?:c|cc|cpp|js|mjs|sh|ts|tsx|toml)$/.test(entry.name)
      ? [child]
      : [];
  });
}

function discoveredConsumers(fixture: FixtureEntry): string[] {
  const candidates = [
    "apps",
    "benchmarks",
    "examples",
    "host",
    "images",
    "packages",
    "scripts",
    "tests",
  ].flatMap(sourceFilesUnder);
  candidates.push("run.sh");
  return candidates
    .filter((candidate) => {
      if (candidate === relative(repoRoot, fileURLToPath(import.meta.url))) return false;
      const source = readFileSync(join(repoRoot, candidate), "utf8");
      return source.includes(fixture.resolver_path) || source.includes(fixture.binary);
    })
    .sort();
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

    expect(registryPackagesWithoutBuildToml).not.toContain("kernel-test-programs");
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

    const fixtureIds = manifest.fixtures.map((fixture) => fixture.id).sort();
    expect(fixtureIds).toEqual(expectedFixtureIds);
    expect(new Set(fixtureIds).size).toBe(fixtureIds.length);

    for (const fixture of manifest.fixtures) {
      expect(fixture.id).toBe(`${fixture.name}:${fixture.arch}`);
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
      expect(new Set(fixture.consumers).size).toBe(fixture.consumers.length);
      expect([...fixture.consumers].sort()).toEqual(discoveredConsumers(fixture));
      for (const consumer of fixture.consumers) {
        expect(isSafeRelativePath(consumer), `${fixture.name} consumer ${consumer}`).toBe(true);
        expect(fileExists(consumer), `${fixture.name} consumer ${consumer} exists`).toBe(true);
        const consumerSource = readFileSync(join(repoRoot, consumer), "utf8");
        expect(
          consumerSource.includes(fixture.resolver_path)
            || consumerSource.includes(fixture.binary),
          `${fixture.name} consumer ${consumer} references its declared path`,
        ).toBe(true);
      }
    }
  });

  it("accounts for every output from the removed registry manifest", () => {
    const manifest = readManifest();
    const legacyNames = manifest.legacy_outputs.map((output) => output.name).sort();
    expect(legacyNames).toEqual(legacyOutputsFromRemovedPackage);

    const fixtures = new Set(manifest.fixtures.map((fixture) => fixture.id));
    for (const output of manifest.legacy_outputs) {
      expect(isSafeRelativePath(output.wasm), `${output.name} wasm`).toBe(true);
      if (output.disposition === "migrated-fixture") {
        expect(output.fixture, `${output.name} fixture pointer`).toMatch(
          new RegExp(`^${output.name}:wasm(32|64)$`),
        );
        expect(fixtures.has(output.fixture!), `${output.name} fixture exists`).toBe(true);
      } else if (output.name === "hello") {
        expect(output.disposition).toBe("retired");
        expect(output.reason).toMatch(/retired/);
        expect(fileExists("examples/hello.c"), "separate SDK hello example exists").toBe(true);
      } else {
        throw new Error(`unexpected legacy disposition for ${output.name}: ${output.disposition}`);
      }
    }
  });
});
