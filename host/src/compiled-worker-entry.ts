import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

const FINGERPRINT_MARKER =
  "kandelo-host-build-inputs-sha256:";
const HOST_BUILD_FILES = [
  "package-lock.json",
  "package.json",
  "tsconfig.json",
  "tsup.config.ts",
] as const;

function collectRegularFiles(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectRegularFiles(path, files);
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
}

/**
 * Hash every declared input to the host package build.
 *
 * File names and byte lengths are framed independently before their contents,
 * so a rename or boundary shift cannot preserve the digest accidentally.
 */
export function hostBuildInputFingerprint(hostRoot: string): string {
  const inputs = HOST_BUILD_FILES.map((path) => join(hostRoot, path));
  collectRegularFiles(join(hostRoot, "src"), inputs);
  inputs.sort((left, right) =>
    relative(hostRoot, left).localeCompare(relative(hostRoot, right))
  );

  const hash = createHash("sha256");
  for (const input of inputs) {
    const name = relative(hostRoot, input);
    const bytes = readFileSync(input);
    hash.update(String(Buffer.byteLength(name)));
    hash.update(":");
    hash.update(name);
    hash.update(":");
    hash.update(String(bytes.byteLength));
    hash.update(":");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/** Build banner consumed by the source-checkout freshness gate. */
export function hostBuildFingerprintBanner(hostRoot: string): string {
  return `/* ${FINGERPRINT_MARKER}${hostBuildInputFingerprint(hostRoot)} */`;
}

function compiledBuildInputFingerprint(path: string): string | null {
  const match = readFileSync(path, "utf8").match(
    /kandelo-host-build-inputs-sha256:([0-9a-f]{64})/,
  );
  return match?.[1] ?? null;
}

/**
 * Decide whether a bundled worker represents the complete declared host build
 * input set, rather than trusting file modification times.
 *
 * Packaged consumers have no source entry and may use the shipped bundle
 * directly. A source checkout fails closed to the TypeScript loader unless the
 * bundle embeds the exact source/config/package-lock fingerprint produced by
 * the declared tsup build. Touching or copying an old bundle cannot make it
 * current.
 */
export function compiledWorkerEntryIsCurrent(
  sourceEntryPath: string,
  compiledPath: string,
): boolean {
  if (!existsSync(compiledPath)) return false;
  if (!existsSync(sourceEntryPath)) return true;
  try {
    const hostRoot = dirname(dirname(sourceEntryPath));
    return compiledBuildInputFingerprint(compiledPath)
      === hostBuildInputFingerprint(hostRoot);
  } catch {
    return false;
  }
}
