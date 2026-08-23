import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  findRepoRoot,
  resolveBinary,
  tryResolveBinary,
} from "../host/src/binary-resolver";
import {
  browserBinariesImports,
  browserRequiredInputs,
} from "../apps/browser-demos/browser-binary-imports.mjs";

export function browserAssetImportsForPolicy(
  repoRoot: string,
  resolutionPolicy: string | undefined,
): string[] {
  const browserImports = resolutionPolicy === "source-only-v1"
    ? browserRequiredInputs(repoRoot, {
      htmlEntryFiles: [
        "index.html",
        "pages/kandelo/index.html",
        "pages/network/index.html",
      ],
    }).imports
    : browserBinariesImports(repoRoot);
  return [
    "@kernel-wasm",
    "@rootfs-vfs",
    ...browserImports.map((relPath) =>
      `@binaries/${relPath}`
    ),
  ];
}

function resolveRootfsVfs(): string {
  if (process.env.WASM_POSIX_RESOLUTION_POLICY === "source-only-v1") {
    return resolveBinary("programs/wasm32/rootfs.vfs");
  }
  return tryResolveBinary("rootfs.vfs")
    ?? resolveBinary("programs/wasm32/rootfs.vfs");
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

function main(): void {
  const specs = browserAssetImportsForPolicy(
    findRepoRoot(),
    process.env.WASM_POSIX_RESOLUTION_POLICY,
  );
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
        failures.join("\n\n"),
    );
    process.exit(1);
  }

  console.log(`ci-check-browser-assets: resolved ${specs.length} browser asset import(s)`);
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
