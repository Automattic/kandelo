/**
 * Repo-side bridge from package.toml `[[runtime_files]]` to VFS/test builders.
 *
 * Runtime-file metadata is a build/materialization contract, not a host-runtime
 * API: published browser/rootfs images contain the installed bytes already.
 * Repo tools query xtask so guest paths and modes are never duplicated in
 * TypeScript fixtures.
 */
import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { tryResolveBinarySet } from "../host/src/binary-resolver";

export interface PackageRuntimeFileContract {
  artifact: string;
  guestPath: string;
  mode: number;
  mirrorPath: string;
  /** Every program output + runtime file declared by this package. */
  closureMirrorPaths: string[];
}

export interface ResolvedPackageRuntimeFile extends PackageRuntimeFileContract {
  hostPath: string;
  /** Host paths keyed by resolver mirror path, all from one provenance root. */
  closureHostPaths: ReadonlyMap<string, string>;
}

let cachedHostTarget: string | undefined;

function hostTarget(): string {
  if (cachedHostTarget) return cachedHostTarget;
  const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const target = output.match(/^host:\s*(\S+)$/m)?.[1];
  if (!target) throw new Error("rustc -vV did not report a host target");
  cachedHostTarget = target;
  return target;
}

function hostCargoEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    "CC",
    "CXX",
    "AR",
    "RANLIB",
    "CFLAGS",
    "CXXFLAGS",
    "CPPFLAGS",
    "LDFLAGS",
  ]) {
    delete env[name];
  }
  return env;
}

export function readPackageRuntimeFileContract(
  repoRoot: string,
  packageName: string,
  artifact: string,
): PackageRuntimeFileContract {
  const raw = execFileSync(
    "cargo",
    [
      "run",
      "-p",
      "xtask",
      "--target",
      hostTarget(),
      "--quiet",
      "--",
      "build-deps",
      "runtime-file-metadata",
      packageName,
      artifact,
    ],
    { cwd: repoRoot, encoding: "utf8", env: hostCargoEnv() },
  ).trim();
  return parsePackageRuntimeFileContract(raw, packageName, artifact);
}

/** Parse and validate xtask's structured runtime-file metadata. */
export function parsePackageRuntimeFileContract(
  raw: string,
  packageName: string,
  artifact: string,
): PackageRuntimeFileContract {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const contract: PackageRuntimeFileContract = {
    artifact: parsed.artifact as string,
    guestPath: parsed.guest_path as string,
    mode: parsed.mode as number,
    mirrorPath: parsed.mirror_path as string,
    closureMirrorPaths: parsed.closure_mirror_paths as string[],
  };
  const validMirrorPath = (value: unknown): value is string =>
    typeof value === "string"
    && !isAbsolute(value)
    && !value.includes("\\")
    && !value.includes("\0")
    && value
      .split("/")
      .every((part) => Boolean(part) && part !== "." && part !== "..");
  if (
    contract.artifact !== artifact
    || typeof contract.guestPath !== "string"
    || !contract.guestPath.startsWith("/")
    || !Number.isInteger(contract.mode)
    || contract.mode < 0
    || contract.mode > 0o777
    || !validMirrorPath(contract.mirrorPath)
    || !Array.isArray(contract.closureMirrorPaths)
    || contract.closureMirrorPaths.length === 0
    || !contract.closureMirrorPaths.every(validMirrorPath)
    || new Set(contract.closureMirrorPaths).size !== contract.closureMirrorPaths.length
    || !contract.closureMirrorPaths.includes(contract.mirrorPath)
  ) {
    throw new Error(
      `invalid runtime-file metadata for ${packageName}:${artifact}: ${raw}`,
    );
  }
  return contract;
}

export function resolvePackageRuntimeFile(
  repoRoot: string,
  packageName: string,
  artifact: string,
): ResolvedPackageRuntimeFile | undefined {
  const contract = readPackageRuntimeFileContract(repoRoot, packageName, artifact);
  const hostPaths = tryResolveBinarySet(
    contract.closureMirrorPaths.map((mirrorPath) => `programs/${mirrorPath}`),
  );
  if (!hostPaths) return undefined;
  const closureHostPaths = new Map(
    contract.closureMirrorPaths.map((mirrorPath, index) => [
      mirrorPath,
      hostPaths[index],
    ]),
  );
  const hostPath = closureHostPaths.get(contract.mirrorPath);
  if (!hostPath) {
    throw new Error(
      `resolved package closure omitted ${packageName}:${contract.mirrorPath}`,
    );
  }
  return { ...contract, hostPath, closureHostPaths };
}
