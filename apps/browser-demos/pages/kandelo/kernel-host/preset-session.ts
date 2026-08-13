import type {
  BootDescriptor,
  HomebrewPackagePrefetchResult,
  MachineStatus,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";

export interface PresetWorkspaceFile {
  path: string;
  contents: string;
  mode: number;
}

export interface PresetSession {
  cwd: string;
  env: Readonly<Record<string, string>>;
  workspaceFiles: readonly PresetWorkspaceFile[];
  packagePrefetch?: {
    id: string;
    label: string;
    roots: readonly string[];
  };
}

export interface PresetSessionIdentity {
  cwd: string;
  env: string[];
  uid: number;
  gid: number;
}

export interface PresetSessionKernel {
  spawnFromVfs(
    path: string,
    argv: string[],
    options: {
      cwd: string;
      env: string[];
      uid: number;
      gid: number;
      stdin: Uint8Array;
    },
  ): Promise<{ pid: number; exit: Promise<number> }>;
}

export interface PresetSessionHost {
  getStatus(): MachineStatus;
  prefetchHomebrewPackages(
    id: string,
    label: string,
    roots: readonly string[],
  ): Promise<HomebrewPackagePrefetchResult>;
}

const MAX_WORKSPACE_FILES = 16;
const MAX_WORKSPACE_BYTES = 64 * 1024;

export function applyPresetSessionBoot(
  descriptor: BootDescriptor,
  session: PresetSession,
): BootDescriptor {
  validatePresetSession(session);
  const result = structuredClone(descriptor);
  result.boot.cwd = session.cwd;
  result.boot.env = {
    ...result.boot.env,
    ...session.env,
  };
  return result;
}

export async function preparePresetWorkspace(
  kernel: PresetSessionKernel,
  session: PresetSession,
  identity: PresetSessionIdentity,
): Promise<void> {
  validatePresetSession(session);
  const commands = [
    "umask 022",
    "mkdir -p -- " + shellQuote(session.cwd),
    ...session.workspaceFiles.flatMap((file) => [
      "printf %s " + shellQuote(file.contents) + " > " + shellQuote(file.path),
      "chmod " + file.mode.toString(8) + " -- " + shellQuote(file.path),
    ]),
  ];
  const { exit } = await kernel.spawnFromVfs(
    "/bin/bash",
    ["/bin/bash", "-lc", commands.join("\n")],
    {
      cwd: "/home/user",
      env: identity.env.slice(),
      uid: identity.uid,
      gid: identity.gid,
      stdin: new Uint8Array(),
    },
  );
  const code = await exit;
  if (code !== 0) {
    throw new Error("preset workspace preparation exited with " + code);
  }
}

export function startPresetPackagePrefetch(
  host: PresetSessionHost,
  session: PresetSession,
): Promise<HomebrewPackagePrefetchResult> | undefined {
  const request = session.packagePrefetch;
  if (request === undefined) return undefined;
  if (host.getStatus() !== "running") {
    throw new Error("preset package prefetch requires a running machine");
  }
  return host.prefetchHomebrewPackages(
    request.id,
    request.label,
    request.roots,
  );
}

function validatePresetSession(session: PresetSession): void {
  validateAbsolutePath(session.cwd, "preset cwd");
  if (session.cwd !== "/home/user" && !session.cwd.startsWith("/home/user/")) {
    throw new Error("preset cwd must remain inside /home/user");
  }
  if (session.workspaceFiles.length > MAX_WORKSPACE_FILES) {
    throw new Error("preset workspace exceeds the file-count limit");
  }

  let totalBytes = 0;
  const prefix = session.cwd === "/" ? "/" : session.cwd + "/";
  for (const file of session.workspaceFiles) {
    validateAbsolutePath(file.path, "preset workspace path");
    if (!file.path.startsWith(prefix)) {
      throw new Error("preset workspace file must remain inside its cwd");
    }
    if (file.contents.includes("\0")) {
      throw new Error("preset workspace contents contain NUL");
    }
    totalBytes += new TextEncoder().encode(file.contents).byteLength;
    if (totalBytes > MAX_WORKSPACE_BYTES) {
      throw new Error("preset workspace exceeds the source-byte limit");
    }
    if (!Number.isInteger(file.mode) || file.mode < 0 || (file.mode & ~0o777) !== 0) {
      throw new Error("preset workspace mode is invalid");
    }
  }
}

function validateAbsolutePath(path: string, label: string): void {
  if (!path.startsWith("/") || path.includes("\0") || path.includes("\\")) {
    throw new Error(label + " is invalid");
  }
  const segments = path.split("/").slice(1);
  if (
    segments.length === 0
    || segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw new Error(label + " is invalid");
  }
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
