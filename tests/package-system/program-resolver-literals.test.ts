import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const projectionPath = join(
  repoRoot,
  "packages",
  "registry",
  "program-packages.json",
);
const fixtureInventoryPath = join(
  repoRoot,
  "tests",
  "test-artifacts",
  "kernel-test-programs.json",
);

type ProgramMember = {
  kind: "output" | "runtime-file";
  mirrorPath: string;
};

type ProgramProjection = {
  arches: Array<"wasm32" | "wasm64">;
  members: ProgramMember[];
};

type ProgramPackageIndex = {
  packages: Record<string, ProgramProjection>;
};

type FixtureInventory = {
  fixtures: Array<{
    source: string;
    binary: string;
    resolver_path: string;
  }>;
};

type StalePathOwner = {
  packageName: string;
  replacement: string;
};

const sourceRoots = [
  ".cargo",
  ".github",
  "abi",
  "apps",
  "benchmarks",
  "crates",
  "docs",
  "docs-site",
  "examples",
  "homebrew",
  "host",
  "images",
  "packages",
  "programs",
  "scripts",
  "sdk",
  "tests",
  "tools",
  "web-libs",
];

const topLevelSources = [
  "README.md",
  "TODO-kernel-refactoring.md",
  "build.sh",
  "flake.nix",
  "package.json",
  "run.sh",
];

const excludedDirectories = new Set([
  ".git",
  "build",
  "dist",
  "node_modules",
  "target",
  "test-results",
]);

const excludedFiles = new Set([
  "packages/registry/program-packages.json",
  "scripts/resolve-binary.bundle.LICENSES.txt",
  "scripts/resolve-binary.bundle.mjs",
]);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function directProgramSources(): string[] {
  return readdirSync(join(repoRoot, "programs"))
    .filter((name) => [".c", ".cpp"].includes(extname(name)))
    .map((name) => `programs/${name}`)
    .sort();
}

function legitimateFlatResolverPaths(inventory: FixtureInventory): Set<string> {
  const paths = new Set<string>();
  const inventoriedSources = new Set(
    inventory.fixtures.map((fixture) => fixture.source),
  );

  for (const fixture of inventory.fixtures) {
    paths.add(fixture.binary);
    paths.add(fixture.resolver_path);
  }

  for (const source of directProgramSources()) {
    // The inventory is authoritative for architecture-specific exceptions
    // such as hello64.c. Every other direct program source is produced by
    // scripts/build-programs.sh in the ordinary wasm32 fixture namespace.
    if (inventoriedSources.has(source)) continue;
    const name = basename(source, extname(source));
    paths.add(`programs/${name}.wasm`);
    paths.add(`programs/wasm32/${name}.wasm`);
  }

  return paths;
}

function staleFlatPackagePaths(
  index: ProgramPackageIndex,
  legitimateFlatPaths: ReadonlySet<string>,
): Map<string, StalePathOwner[]> {
  const candidates = new Map<string, StalePathOwner[]>();

  function add(path: string, owner: StalePathOwner): void {
    if (legitimateFlatPaths.has(path)) return;
    const owners = candidates.get(path) ?? [];
    owners.push(owner);
    candidates.set(path, owners);
  }

  for (const [packageName, projection] of Object.entries(index.packages)) {
    for (const member of projection.members) {
      if (member.kind !== "output" || !member.mirrorPath.includes("/")) {
        continue;
      }
      const outputBasename = member.mirrorPath.split("/").at(-1)!;
      for (const arch of projection.arches) {
        add(`programs/${arch}/${outputBasename}`, {
          packageName,
          replacement: `programs/${arch}/${member.mirrorPath}`,
        });
        if (arch === "wasm32") {
          add(`programs/${outputBasename}`, {
            packageName,
            replacement: `programs/${member.mirrorPath}`,
          });
        }
      }
    }
  }

  return candidates;
}

function sourceFilesUnder(relPath: string): string[] {
  const absolute = join(repoRoot, relPath);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) return [];
    const child = join(relPath, entry.name);
    if (entry.isDirectory()) {
      if (
        excludedDirectories.has(entry.name)
        || child === "docs/plans"
      ) {
        return [];
      }
      return sourceFilesUnder(child);
    }
    if (!entry.isFile() || excludedFiles.has(child)) return [];
    return [child];
  });
}

function auditedSourceFiles(): string[] {
  return [
    ...sourceRoots.flatMap(sourceFilesUnder),
    ...topLevelSources.filter((path) => existsSync(join(repoRoot, path))),
  ].sort();
}

function staleLiteralFailures(
  candidates: ReadonlyMap<string, StalePathOwner[]>,
): string[] {
  const failures: string[] = [];
  for (const relPath of auditedSourceFiles()) {
    const bytes = readFileSync(join(repoRoot, relPath));
    if (bytes.includes(0)) continue;
    const lines = bytes.toString("utf8").split("\n");
    for (const [stalePath, owners] of candidates) {
      lines.forEach((line, index) => {
        if (!line.includes(stalePath)) return;
        const replacements = [...new Set(owners.map((owner) => owner.replacement))]
          .sort()
          .map((replacement) => JSON.stringify(replacement))
          .join(" or ");
        const packages = [...new Set(owners.map((owner) => owner.packageName))]
          .sort()
          .map((packageName) => JSON.stringify(packageName))
          .join(", ");
        failures.push(
          `${relPath}:${index + 1}: ${JSON.stringify(stalePath)} is a stale flat `
          + `resolver path owned by package ${packages}; use ${replacements}`,
        );
      });
    }
  }
  return failures;
}

describe("program resolver source literals", () => {
  it("keeps direct program fixtures outside package directory policy", () => {
    const inventory = readJson<FixtureInventory>(fixtureInventoryPath);
    const legitimatePaths = legitimateFlatResolverPaths(inventory);
    expect(legitimatePaths).toContain("programs/sh.wasm");
    expect(legitimatePaths).toContain("programs/wasm32/sh.wasm");

    const syntheticIndex: ProgramPackageIndex = {
      packages: {
        "synthetic-shell-tools": {
          arches: ["wasm32"],
          members: [
            {
              kind: "output",
              mirrorPath: "synthetic-shell-tools/sh.wasm",
            },
          ],
        },
      },
    };
    const candidates = staleFlatPackagePaths(syntheticIndex, legitimatePaths);
    expect(candidates.has("programs/sh.wasm")).toBe(false);
    expect(candidates.has("programs/wasm32/sh.wasm")).toBe(false);
  });

  it("does not name package-directory outputs through obsolete flat paths", () => {
    const index = readJson<ProgramPackageIndex>(projectionPath);
    const inventory = readJson<FixtureInventory>(fixtureInventoryPath);
    const candidates = staleFlatPackagePaths(
      index,
      legitimateFlatResolverPaths(inventory),
    );
    const failures = staleLiteralFailures(candidates);

    expect(
      failures,
      failures.length === 0
        ? undefined
        : `Stale package resolver literals:\n${failures.join("\n")}`,
    ).toEqual([]);
  });
});
