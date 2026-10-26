/**
 * Repo-side bridge from package.toml `[[runtime_files]]` to VFS/test builders.
 *
 * Runtime-file metadata is a build/materialization contract, not a host-runtime
 * API: published browser/rootfs images contain the installed bytes already.
 * Repo tools query xtask so guest paths and modes are never duplicated in
 * TypeScript fixtures.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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

let preparedRuntimeMetadataXtask:
  | { repoRoot: string; xtaskPath: string }
  | undefined;

function hostTarget(repoRoot: string): string {
  const inDevShell = process.env.KANDELO_DEV_SHELL_TOOL_PATH !== undefined;
  const command = inDevShell ? "rustc" : "bash";
  const args = inDevShell
    ? ["-vV"]
    : [join(repoRoot, "scripts", "dev-shell.sh"), "rustc", "-vV"];
  const output = execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const target = output.match(/^host:\s*(\S+)$/m)?.[1];
  if (!target) throw new Error("rustc -vV did not report a host target");
  return target;
}

function requireRegularXtask(path: string): string {
  try {
    if (lstatSync(path).isFile()) return realpathSync(path);
  } catch {
    // Report one stable preparation error below.
  }
  throw new Error(`Prepared xtask is not a regular file: ${path}`);
}

/**
 * Pick the xtask binary's path out of `cargo build --message-format=json*`
 * stdout. Non-JSON lines (the dev shell's banner) are skipped.
 */
export function cargoBuiltXtaskExecutable(messages: string): string {
  let executable: string | undefined;
  for (const line of messages.split("\n")) {
    if (!line.startsWith("{")) continue;
    let message: {
      reason?: unknown;
      target?: { name?: unknown; kind?: unknown };
      executable?: unknown;
    };
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      message.reason === "compiler-artifact"
      && message.target?.name === "xtask"
      && Array.isArray(message.target.kind)
      && message.target.kind.includes("bin")
      && typeof message.executable === "string"
    ) {
      executable = message.executable;
    }
  }
  if (executable === undefined) {
    throw new Error("cargo build -p xtask reported no xtask executable");
  }
  return executable;
}

function prepareRuntimeMetadataXtask(repoRoot: string): string {
  const explicit = process.env.WASM_POSIX_XTASK_BIN;
  if (explicit !== undefined) {
    const explicitPath = isAbsolute(explicit)
      ? resolve(explicit)
      : resolve(repoRoot, explicit);
    return requireRegularXtask(explicitPath);
  }
  if (preparedRuntimeMetadataXtask?.repoRoot === repoRoot) {
    return requireRegularXtask(preparedRuntimeMetadataXtask.xtaskPath);
  }

  const target = hostTarget(repoRoot);
  // WHY: ask cargo where it wrote the binary instead of assuming
  // <repoRoot>/target. xtask local-build exports a private CARGO_TARGET_DIR
  // into every package recipe, and cargo honors it, so the fresh binary lands
  // there. A hard-coded repo path fails in a fresh worktree and silently runs
  // a stale binary from an earlier `./run.sh setup` in an old one.
  const cargoArgs = [
    "build",
    "--release",
    "-p",
    "xtask",
    "--target",
    target,
    "--quiet",
    "--message-format=json-render-diagnostics",
  ];
  const inDevShell = process.env.KANDELO_DEV_SHELL_TOOL_PATH !== undefined;
  const command = inDevShell ? "cargo" : "bash";
  const args = inDevShell
    ? cargoArgs
    : [join(repoRoot, "scripts", "dev-shell.sh"), "cargo", ...cargoArgs];
  // WHY: deleting compiler variables here also deletes the dev shell's
  // declared host archiver and makes native Cargo build scripts fall back to
  // ambient platform tools. Cargo's incremental build is the current-source
  // attestation; CI can instead provide the exact prepared binary below.
  const messages = execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const xtaskPath = cargoBuiltXtaskExecutable(messages);
  preparedRuntimeMetadataXtask = {
    repoRoot,
    xtaskPath: requireRegularXtask(xtaskPath),
  };
  return preparedRuntimeMetadataXtask.xtaskPath;
}

export function readPackageRuntimeFileContract(
  repoRoot: string,
  packageName: string,
  artifact: string,
): PackageRuntimeFileContract {
  const raw = execFileSync(
    prepareRuntimeMetadataXtask(repoRoot),
    [
      "build-deps",
      "runtime-file-metadata",
      packageName,
      artifact,
    ],
    { cwd: repoRoot, encoding: "utf8" },
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
