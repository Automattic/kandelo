import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestRelativePath =
  "scripts/browser-memory64-example-fixtures.txt";
const manifestPath = join(repoRoot, manifestRelativePath);
const sourcePattern = /^examples\/[a-z0-9][a-z0-9_-]*\.c$/;

function fail(message: string): never {
  throw new Error(`browser memory64 fixture contract: ${message}`);
}

function portableRelativePath(path: string): string {
  return path.split(sep).join("/");
}

function readManifestSources(): string[] {
  if (!existsSync(manifestPath)) {
    fail(`missing manifest ${manifestRelativePath}`);
  }
  const sources = readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (sources.length === 0) {
    fail(`${manifestRelativePath} has no fixture sources`);
  }
  for (const source of sources) {
    if (!sourcePattern.test(source)) {
      fail(`invalid source path ${JSON.stringify(source)}`);
    }
    if (!existsSync(join(repoRoot, source))) {
      fail(`missing source ${source}`);
    }
  }
  const sortedUnique = [...new Set(sources)].sort();
  if (
    sources.length !== sortedUnique.length ||
    sources.some((source, index) => source !== sortedUnique[index])
  ) {
    fail(`${manifestRelativePath} must be sorted with no duplicates`);
  }
  return sources;
}

function browserSpecFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...browserSpecFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
      files.push(path);
    }
  }
  return files;
}

function referencedExampleOutputs(): string[] {
  const outputs = new Set<string>();
  const literalPattern = /(["'`])([^"'`\r\n]+\.wasm64\.wasm)\1/g;
  for (const specPath of browserSpecFiles(
    join(repoRoot, "apps", "browser-demos", "test"),
  )) {
    const source = readFileSync(specPath, "utf8");
    for (const match of source.matchAll(literalPattern)) {
      const referencedPath = portableRelativePath(
        relative(repoRoot, resolve(dirname(specPath), match[2])),
      );
      if (referencedPath.startsWith("examples/")) {
        outputs.add(referencedPath);
      }
    }
  }
  return [...outputs].sort();
}

function assertEqualSets(expected: string[], actual: string[]): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((path) => !actualSet.has(path));
  const unmanifested = actual.filter((path) => !expectedSet.has(path));
  if (missing.length === 0 && unmanifested.length === 0) return;

  const details = [
    ...missing.map((path) => `  manifest output has no browser spec: ${path}`),
    ...unmanifested.map(
      (path) => `  browser spec output is not in the manifest: ${path}`,
    ),
  ];
  fail(`browser references and manifest outputs differ\n${details.join("\n")}`);
}

const manifestSources = readManifestSources();
const manifestOutputs = manifestSources.map(
  (source) => `${source.slice(0, -2)}.wasm64.wasm`,
);
const browserOutputs = referencedExampleOutputs();
if (browserOutputs.length === 0) {
  fail("no browser example memory64 references were found");
}
assertEqualSets(manifestOutputs, browserOutputs);

// WHY: checking only the manifest against specs would still allow a producer
// or readiness guard to regress to a partial literal list. These consumers
// must all derive their fixture set from the same authoritative file.
for (const consumer of [
  "scripts/build-programs.sh",
  "run.sh",
  "scripts/pack-ci-test-workspace.sh",
]) {
  const source = readFileSync(join(repoRoot, consumer), "utf8");
  if (!source.includes(manifestRelativePath)) {
    fail(`${consumer} does not consume ${manifestRelativePath}`);
  }
}

console.log(
  `browser memory64 fixture contract: ${manifestOutputs.length} fixture(s) verified`,
);
