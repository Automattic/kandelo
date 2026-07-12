/**
 * Repo-side bridge from package.toml `[[runtime_files]]` to VFS/test builders.
 *
 * Runtime-file metadata is a build/materialization contract, not a host-runtime
 * API: published browser/rootfs images contain the installed bytes already.
 * Repo tools query xtask so guest paths and modes are never duplicated in
 * TypeScript fixtures.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { tryResolveBinary } from "../host/src/binary-resolver";

export interface PackageRuntimeFileContract {
  artifact: string;
  guestPath: string;
  mode: number;
  mirrorPath: string;
}

export interface ResolvedPackageRuntimeFile extends PackageRuntimeFileContract {
  hostPath: string;
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
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const contract: PackageRuntimeFileContract = {
    artifact: parsed.artifact as string,
    guestPath: parsed.guest_path as string,
    mode: parsed.mode as number,
    mirrorPath: parsed.mirror_path as string,
  };
  if (
    contract.artifact !== artifact
    || typeof contract.guestPath !== "string"
    || !contract.guestPath.startsWith("/")
    || !Number.isInteger(contract.mode)
    || contract.mode < 0
    || contract.mode > 0o777
    || typeof contract.mirrorPath !== "string"
    || isAbsolute(contract.mirrorPath)
    || contract.mirrorPath.split("/").some((part) => !part || part === "." || part === "..")
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
  const hostPath = tryResolveBinary(`programs/${contract.mirrorPath}`);
  if (!hostPath || !existsSync(hostPath)) return undefined;
  return { ...contract, hostPath };
}
