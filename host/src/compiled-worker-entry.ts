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

/** What the freshness gate saw when it judged one compiled worker entry. */
export interface CompiledWorkerEntryInspection {
  /** True when the compiled entry may run in place of the source entry. */
  current: boolean;
  /** Host build-input fingerprint embedded in the compiled entry, if any. */
  bundleFingerprint: string | null;
  /**
   * Fingerprint of the checkout's current host build inputs. Null for a
   * packaged consumer (no source entry) or when it could not be computed.
   */
  sourceFingerprint: string | null;
  /** Why the compiled entry is not current; null when it is. */
  reason: string | null;
}

/**
 * Judge a compiled worker entry and report the evidence behind the verdict.
 *
 * Callers that must not silently take the slower source path (benchmarks)
 * need the fingerprints and the reason, not just the boolean, so they can
 * refuse with an actionable message and record what ran.
 */
export function inspectCompiledWorkerEntry(
  sourceEntryPath: string,
  compiledPath: string,
): CompiledWorkerEntryInspection {
  if (!existsSync(compiledPath)) {
    return {
      current: false,
      bundleFingerprint: null,
      sourceFingerprint: null,
      reason: `${compiledPath} does not exist`,
    };
  }
  if (!existsSync(sourceEntryPath)) {
    // Packaged consumer: the shipped bundle is the only entry there is.
    let packagedFingerprint: string | null = null;
    try {
      packagedFingerprint = compiledBuildInputFingerprint(compiledPath);
    } catch {
      // The verdict never depended on reading a packaged bundle.
    }
    return {
      current: true,
      bundleFingerprint: packagedFingerprint,
      sourceFingerprint: null,
      reason: null,
    };
  }
  let bundleFingerprint: string | null;
  try {
    bundleFingerprint = compiledBuildInputFingerprint(compiledPath);
  } catch (error) {
    return {
      current: false,
      bundleFingerprint: null,
      sourceFingerprint: null,
      reason: `cannot read ${compiledPath}: ${String(error)}`,
    };
  }
  let sourceFingerprint: string;
  try {
    sourceFingerprint = hostBuildInputFingerprint(
      dirname(dirname(sourceEntryPath)),
    );
  } catch (error) {
    return {
      current: false,
      bundleFingerprint,
      sourceFingerprint: null,
      reason: `cannot fingerprint host build inputs: ${String(error)}`,
    };
  }
  if (bundleFingerprint === null) {
    return {
      current: false,
      bundleFingerprint,
      sourceFingerprint,
      reason: `${compiledPath} carries no host build-input fingerprint`,
    };
  }
  if (bundleFingerprint !== sourceFingerprint) {
    return {
      current: false,
      bundleFingerprint,
      sourceFingerprint,
      reason:
        `${compiledPath} was built from different host inputs ` +
        `(bundle ${bundleFingerprint.slice(0, 12)}, ` +
        `sources ${sourceFingerprint.slice(0, 12)})`,
    };
  }
  return { current: true, bundleFingerprint, sourceFingerprint, reason: null };
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
  return inspectCompiledWorkerEntry(sourceEntryPath, compiledPath).current;
}
