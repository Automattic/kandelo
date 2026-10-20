/**
 * Run a package build inside a Kandelo machine (Node host only).
 *
 * A cross-compiled build that compiles and runs helper programs runs them on
 * the build machine, so whatever they generate describes the build machine
 * rather than the Kandelo target. This runner lets a recipe run its whole
 * build — configure, make, helpers, compiling and linking — inside a booted
 * Kandelo machine through the guest toolchain instead.
 *
 * Node-only by design: the browser host has no host-directory mount backend,
 * and package builds run on the Node host. See docs/package-management.md,
 * "Building inside Kandelo".
 */
import { KERNEL_TMPFS_OWNED_PREFIXES } from "./vfs/default-mounts";

/** Where the build's workspace appears inside the guest. */
export const GUEST_BUILD_WORKSPACE = "/build";

export interface GuestBuildInput {
  /** Absolute, normalized guest path the host directory appears at. */
  guestPath: string;
  /** Absolute host directory, mounted read-only. */
  hostPath: string;
}

export interface GuestBuildRequest {
  /** Absolute host directory mounted read-write at /build. */
  workspace: string;
  /** Read-only inputs, typically dependency install prefixes. */
  inputs?: readonly GuestBuildInput[];
  /** Command to run; argv[0] is an absolute path inside the guest. */
  argv: readonly string[];
  /** Guest working directory. Defaults to /build. */
  cwd?: string;
  /** Additional environment; may not replace the base keys. */
  env?: Readonly<Record<string, string>>;
  /** Exported as SOURCE_DATE_EPOCH for reproducible tool output. */
  sourceDateEpoch: number;
  /** Wall-clock limit for the whole command. */
  timeoutMs: number;
}

export interface GuestBuildMount {
  mountPoint: string;
  hostPath: string;
  readonly: boolean;
}

export interface GuestBuildPlan {
  mounts: GuestBuildMount[];
  argv: string[];
  cwd: string;
  env: string[];
  timeoutMs: number;
}

// WHY HOME and TMPDIR live on the workspace: /tmp and /root belong to the
// in-kernel tmpfs, which is stored in the kernel's linear memory. A large
// build's scratch objects there compete with every file the machine holds;
// on the workspace mount they are ordinary host files.
function baseEnvironment(sourceDateEpoch: number): Array<[string, string]> {
  return [
    ["PATH", "/usr/bin:/bin"],
    ["HOME", `${GUEST_BUILD_WORKSPACE}/.home`],
    ["TMPDIR", `${GUEST_BUILD_WORKSPACE}/.tmp`],
    ["LC_ALL", "C"],
    ["TZ", "UTC0"],
    ["SOURCE_DATE_EPOCH", String(sourceDateEpoch)],
  ];
}

function requireAbsolute(label: string, path: string): void {
  if (!path.startsWith("/")) {
    throw new Error(`${label} must be an absolute path: ${path}`);
  }
}

function requireNormalizedGuestPath(label: string, path: string): void {
  requireAbsolute(label, path);
  const parts = path.split("/").slice(1);
  if (
    path === "/" ||
    path.endsWith("/") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a normalized guest path: ${path}`);
  }
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Check a request and resolve it into exactly what the host will be told. */
export function validateGuestBuildRequest(request: GuestBuildRequest): GuestBuildPlan {
  requireAbsolute("workspace", request.workspace);
  if (request.argv.length === 0 || !request.argv[0].startsWith("/")) {
    throw new Error("argv must name an absolute guest program");
  }
  if (!Number.isSafeInteger(request.sourceDateEpoch) || request.sourceDateEpoch < 0) {
    throw new Error(`sourceDateEpoch must be a non-negative integer: ${request.sourceDateEpoch}`);
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new Error(`timeoutMs must be a positive integer: ${request.timeoutMs}`);
  }

  const mounts: GuestBuildMount[] = [
    { mountPoint: GUEST_BUILD_WORKSPACE, hostPath: request.workspace, readonly: false },
  ];
  for (const input of request.inputs ?? []) {
    requireNormalizedGuestPath("input guestPath", input.guestPath);
    requireAbsolute("input hostPath", input.hostPath);
    // A mount under a tmpfs prefix would be shadowed by the kernel's tmpfs:
    // the guest would see an empty directory instead of the input.
    const shadow = KERNEL_TMPFS_OWNED_PREFIXES.find((prefix) =>
      isUnder(input.guestPath, prefix)
    );
    if (shadow !== undefined) {
      throw new Error(`${input.guestPath} is under the in-kernel tmpfs at ${shadow}`);
    }
    if (mounts.some((mount) => mount.mountPoint === input.guestPath)) {
      throw new Error(`${input.guestPath} is already mounted`);
    }
    if (isUnder(input.guestPath, GUEST_BUILD_WORKSPACE)) {
      throw new Error(`${input.guestPath} is inside the ${GUEST_BUILD_WORKSPACE} workspace`);
    }
    mounts.push({ mountPoint: input.guestPath, hostPath: input.hostPath, readonly: true });
  }

  const cwd = request.cwd ?? GUEST_BUILD_WORKSPACE;
  requireNormalizedGuestPath("cwd", cwd);

  const env = baseEnvironment(request.sourceDateEpoch);
  const reserved = new Set(env.map(([key]) => key));
  for (const [key, value] of Object.entries(request.env ?? {})) {
    if (reserved.has(key)) {
      throw new Error(`${key} is set by the runner and cannot be replaced`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) {
      throw new Error(`invalid environment entry: ${key}`);
    }
    env.push([key, value]);
  }

  return {
    mounts,
    argv: [...request.argv],
    cwd,
    env: env.map(([key, value]) => `${key}=${value}`),
    timeoutMs: request.timeoutMs,
  };
}
