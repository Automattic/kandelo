import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot, resolveBinary } from "../host/src/binary-resolver";

const repoRoot = findRepoRoot();
const importPattern = /["'](@binaries\/[^"']+|@kernel-wasm[^"']*|@rootfs-vfs[^"']*)["']/g;
const sourceFilePattern = /\.(?:cjs|html|js|jsx|mjs|ts|tsx)$/;

function trackedBrowserSourceFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z", "apps/browser-demos"], {
    cwd: repoRoot,
  });
  return output
    .toString("utf8")
    .split("\0")
    .filter((file) => sourceFilePattern.test(file));
}

function browserAssetImports(): string[] {
  const specs = new Set<string>();
  for (const file of trackedBrowserSourceFiles()) {
    const source = readFileSync(join(repoRoot, file), "utf8");
    for (const match of source.matchAll(importPattern)) {
      specs.add(match[1]);
    }
  }
  return [...specs].sort();
}

function resolveRootfsVfs(): string {
  const candidates = [
    join(repoRoot, "host/wasm/rootfs.vfs"),
    join(repoRoot, "local-binaries/rootfs.vfs"),
    join(repoRoot, "binaries/rootfs.vfs"),
    join(repoRoot, "local-binaries/programs/wasm32/rootfs.vfs"),
    join(repoRoot, "binaries/programs/wasm32/rootfs.vfs"),
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (resolved) return resolved;
  throw new Error(`rootfs.vfs not found\n${candidates.map((path) => `  checked: ${path}`).join("\n")}`);
}

function resolveAssetImport(spec: string): string {
  const pathPart = spec.split("?", 1)[0];
  if (pathPart === "@kernel-wasm") {
    return resolveBinary("kernel.wasm");
  }
  if (pathPart === "@rootfs-vfs") {
    return resolveRootfsVfs();
  }
  if (pathPart.startsWith("@binaries/")) {
    return resolveBinary(pathPart.slice("@binaries/".length));
  }
  throw new Error(`unsupported browser asset import: ${spec}`);
}

const specs = browserAssetImports();
if (specs.length === 0) {
  throw new Error("no browser asset imports found");
}

const failures: string[] = [];
for (const spec of specs) {
  try {
    resolveAssetImport(spec);
  } catch (error) {
    failures.push(`${spec}\n${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  console.error(
    `ci-check-browser-assets: ${failures.length} browser asset import(s) could not be resolved\n\n` +
      failures.join("\n\n")
  );
  process.exit(1);
}

console.log(`ci-check-browser-assets: resolved ${specs.length} browser asset import(s)`);
