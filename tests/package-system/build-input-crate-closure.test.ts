import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A package built from a workspace Rust crate must declare that crate's
// entire path-dependency closure in its build.toml `inputs`. Otherwise a
// change in an undeclared dependency crate does not invalidate the package's
// content-addressed cache-key, and the build silently reuses a STALE artifact
// (this is exactly how a runtime-core change once shipped a stale kernel.wasm
// despite passing unit tests). This is a pure file-parse check — it runs in
// CI, never in the build hot path, so it adds no build latency.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cratesRoot = join(repoRoot, "crates");

const packagesWithCrateInputs = discoverPackagesWithCrateInputs();

describe("package build input crate closure", () => {
  it("has at least one package built from a workspace crate", () => {
    // Guards the discovery itself: if this drops to zero, the check below
    // would pass vacuously and stop protecting anything.
    expect(packagesWithCrateInputs.length).toBeGreaterThan(0);
  });

  for (const packageName of packagesWithCrateInputs) {
    it(`${packageName} declares its crates' full path-dependency closure`, () => {
      const buildToml = readFileSync(
        join(repoRoot, "packages", "registry", packageName, "build.toml"),
        "utf8",
      );
      const declaredInputs = parseBuildInputs(buildToml);
      const declaredCrateDirs = new Set(
        declaredInputs
          .filter((input) => input === "crates" || input.startsWith("crates/"))
          .map((input) => resolve(repoRoot, input)),
      );

      // Seed the closure from every crate directly declared in inputs.
      const closure = new Set<string>();
      const queue = [...declaredCrateDirs].filter(
        (dir) => dir !== cratesRoot && existsSync(join(dir, "Cargo.toml")),
      );
      while (queue.length > 0) {
        const crateDir = queue.pop()!;
        if (closure.has(crateDir)) continue;
        closure.add(crateDir);
        for (const depDir of cratePathDependencies(crateDir)) {
          if (!closure.has(depDir)) queue.push(depDir);
        }
      }

      // Every crate in the closure must be covered by a declared input —
      // either its own `crates/<name>` entry or the whole `crates` directory.
      const missing = [...closure]
        .filter((crateDir) => !isCovered(crateDir, declaredCrateDirs))
        .map((crateDir) => relative(repoRoot, crateDir))
        .sort();

      expect(
        missing,
        `${packageName} omits transitive crate inputs from build.toml:\n${missing.join(
          "\n",
        )}\n(a change in these crates would not rebuild ${packageName} → stale artifact)`,
      ).toEqual([]);
    });
  }
});

function discoverPackagesWithCrateInputs(): string[] {
  const registryRoot = join(repoRoot, "packages", "registry");
  return readdirSync(registryRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((packageName) => {
      const buildTomlPath = join(registryRoot, packageName, "build.toml");
      if (!existsSync(buildTomlPath)) return false;
      return parseBuildInputs(readFileSync(buildTomlPath, "utf8")).some(
        (input) => input === "crates" || input.startsWith("crates/"),
      );
    })
    .sort();
}

/** Directories of the crate's non-dev `path = "..."` dependencies. */
function cratePathDependencies(crateDir: string): string[] {
  const manifest = readFileSync(join(crateDir, "Cargo.toml"), "utf8");
  const deps: string[] = [];
  let inDevSection = false;
  for (const rawLine of manifest.split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/)?.[1];
    if (section !== undefined) {
      // dev-dependencies don't affect the built artifact, so they don't
      // belong in the artifact's cache-key closure. Every other
      // *dependencies table (dependencies, build-dependencies,
      // target.'...'.dependencies) does.
      inDevSection = /(?:^|\.)dev-dependencies$/.test(section);
      continue;
    }
    if (inDevSection) continue;
    const path = line.match(/\bpath\s*=\s*"([^"]+)"/)?.[1];
    if (!path) continue;
    const depDir = resolve(crateDir, path);
    if (
      isWithin(cratesRoot, depDir) &&
      existsSync(join(depDir, "Cargo.toml"))
    ) {
      deps.push(depDir);
    }
  }
  return deps;
}

function isCovered(crateDir: string, declaredCrateDirs: Set<string>): boolean {
  if (declaredCrateDirs.has(crateDir)) return true;
  if (declaredCrateDirs.has(cratesRoot)) return true;
  for (const declared of declaredCrateDirs) {
    if (declared !== crateDir && isWithin(declared, crateDir)) return true;
  }
  return false;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !resolve(child).includes("\0"));
}

function parseBuildInputs(buildToml: string): string[] {
  const lines = buildToml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^inputs\s*=\s*\[\s*$/.test(line));
  if (start < 0) return [];
  const inputs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\]\s*$/.test(line)) return inputs;
    const match = line.match(/^\s*"([^"]+)"\s*,?\s*(?:#.*)?$/);
    if (match) inputs.push(match[1]);
  }
  return inputs;
}
