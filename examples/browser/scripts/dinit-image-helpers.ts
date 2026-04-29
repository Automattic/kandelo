/**
 * Helpers for adding a dinit-based init system to a VFS image. Used by
 * service-demo build scripts to bake `/sbin/dinit`, `/etc/dinit.d/boot`,
 * and per-service config files into the image alongside the demo's
 * binaries and content.
 *
 * The browser demo just fetches the resulting .vfs and boots the kernel
 * with argv `["/sbin/dinit", "--container"]`. dinit is PID 1; it reads
 * `/etc/dinit.d/boot` and pulls in everything that depends on it.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  writeVfsBinary,
  writeVfsFile,
  ensureDirRecursive,
} from "../../../host/src/vfs/image-helpers";
import { tryResolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";

const REPO_ROOT = findRepoRoot();

/**
 * Locate the dinit + dinitctl binaries.
 *
 * dinit isn't in the published release yet, so this prefers the
 * resolver (which honors local-binaries/ overrides + future releases)
 * but falls back to the source-tree path that build-dinit.sh produces.
 */
function resolveDinitBinaries(): { dinit: string; dinitctl: string } {
  const dinit = tryResolveBinary("programs/dinit/dinit.wasm")
    ?? join(REPO_ROOT, "examples", "libs", "dinit", "bin", "dinit.wasm");
  const dinitctl = tryResolveBinary("programs/dinit/dinitctl.wasm")
    ?? join(REPO_ROOT, "examples", "libs", "dinit", "bin", "dinitctl.wasm");
  if (!existsSync(dinit) || !existsSync(dinitctl)) {
    throw new Error(
      "dinit binaries not found. Run 'bash run.sh build dinit' or place\n" +
      "  pre-built dinit.wasm and dinitctl.wasm under\n" +
      `  ${join(REPO_ROOT, "local-binaries/programs/wasm32/dinit/")}`,
    );
  }
  return { dinit, dinitctl };
}

/**
 * One service entry baked into the image at /etc/dinit.d/<name>. The
 * fields here are a small subset of dinit's full schema — enough for
 * our service demos. See dinit-service(5) for the full spec.
 */
export interface DinitService {
  /** Service name; becomes the filename under /etc/dinit.d/. */
  name: string;
  /**
   * Service type. `process` — long-running daemon (default). `internal`
   * — dependency-only node, no command. `scripted` — one-shot script.
   */
  type?: "process" | "bgprocess" | "scripted" | "internal";
  /** Command to run (required for non-internal). */
  command?: string;
  /** Hard dependencies — start order + fail-the-chain on upstream failure. */
  dependsOn?: string[];
  /** Soft dependencies — start order only, never fail. */
  waitsFor?: string[];
  /** Restart on exit (default: false). */
  restart?: boolean;
  /** Seconds to wait between restart attempts (default: dinit's). */
  restartDelay?: number;
  /** Where to log stdout/stderr (default: /var/log/<name>.log). */
  logfile?: string;
  /** Working directory for the command. */
  workingDir?: string;
  /** Extra raw lines, appended verbatim. Use for fields this helper
   *  hasn't grown a typed setter for yet. */
  extra?: string[];
}

/**
 * Render a DinitService into the dinit config file format. Each field
 * is a `key = value` line; multiple `depends-on` lines for multi-dep
 * services.
 */
function renderService(svc: DinitService): string {
  const lines: string[] = [];
  lines.push(`type = ${svc.type ?? "process"}`);
  if (svc.command) lines.push(`command = ${svc.command}`);
  if (svc.workingDir) lines.push(`working-dir = ${svc.workingDir}`);
  for (const dep of svc.dependsOn ?? []) lines.push(`depends-on = ${dep}`);
  for (const dep of svc.waitsFor ?? []) lines.push(`waits-for = ${dep}`);
  // Always emit restart explicitly. dinit's compiled-in default is
  // ON_FAILURE (DEFAULT_AUTO_RESTART), so an unset field would silently
  // turn restart=false into a restart loop.
  if (svc.restart) {
    lines.push("restart = true");
    if (svc.restartDelay !== undefined) lines.push(`restart-delay = ${svc.restartDelay}`);
  } else {
    lines.push("restart = false");
  }
  if (svc.logfile !== undefined) {
    lines.push(`logfile = ${svc.logfile}`);
  }
  // No default logfile: dinit's NONE log type sends service output to
  // /dev/null, which is the documented default. Demos that need to see
  // service output set `logfile` explicitly (typically to a path under
  // /var/log) and read it back via dinitctl or the VFS.
  for (const line of svc.extra ?? []) lines.push(line);
  lines.push(""); // trailing newline
  return lines.join("\n");
}

/**
 * Standard /etc/passwd entries. Daemons (nginx, redis, etc.) routinely
 * call getpwnam("nobody") or similar at startup; without these entries
 * they fail with [emerg] before doing anything useful.
 */
const ETC_PASSWD = [
  "root:x:0:0:root:/root:/bin/sh",
  "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
  "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin",
  "www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin",
  "redis:x:100:100:redis:/var/lib/redis:/usr/sbin/nologin",
  "mysql:x:101:101:mysql:/var/lib/mysql:/usr/sbin/nologin",
  "user:x:1000:1000:user:/home/user:/bin/sh",
  "",
].join("\n");

const ETC_GROUP = [
  "root:x:0:",
  "daemon:x:1:",
  "nogroup:x:65534:",
  "www-data:x:33:",
  "redis:x:100:",
  "mysql:x:101:",
  "user:x:1000:",
  "",
].join("\n");

const ETC_HOSTS = [
  "127.0.0.1\tlocalhost",
  "::1\tlocalhost",
  "",
].join("\n");

/**
 * Options for {@link addDinitInit}. The defaults set up an implicit
 * `boot` service that depends on every supplied service — fine for
 * demos that always start the whole tree. Demos that bake multiple
 * variants (e.g. mariadb's Aria vs InnoDB trees) and select one via
 * dinit's positional service-name argv set `boot: false` so the
 * variants don't both start at boot.
 */
export interface AddDinitInitOptions {
  /**
   * Implicit boot service. `true` (default) creates an internal
   * service named "boot" depending on every supplied service.
   * `false` skips it; demos must pass a service name as dinit's
   * positional argv to pick a starting tree. A string customizes
   * the name (rare).
   */
  boot?: boolean | string;
}

/**
 * Add the dinit binary, basic rootfs files, and per-service config
 * files. Optionally adds an implicit `boot` service.
 *
 * Image gets:
 *   /sbin/dinit              - the init binary
 *   /sbin/dinitctl           - the control client
 *   /etc/passwd, /etc/group  - user/group database (daemons getpwnam at start)
 *   /etc/hosts               - localhost resolution
 *   /etc/dinit.d/boot        - implicit boot service (unless boot=false)
 *   /etc/dinit.d/<name>      - per-service config file
 *   /var/log, /run           - standard runtime dirs
 *
 * Default boot uses argv = ["/sbin/dinit", "--container"]. With
 * boot=false, demos pass the target service name as a positional
 * argument: ["/sbin/dinit", "--container", "aria-mariadb"].
 */
export function addDinitInit(
  fs: MemoryFileSystem,
  services: DinitService[],
  opts: AddDinitInitOptions = {},
): void {
  // Binaries
  ensureDirRecursive(fs, "/sbin");
  const { dinit, dinitctl } = resolveDinitBinaries();
  writeVfsBinary(fs, "/sbin/dinit", new Uint8Array(readFileSync(dinit)));
  writeVfsBinary(fs, "/sbin/dinitctl", new Uint8Array(readFileSync(dinitctl)));

  // Basic rootfs files. Most Unix daemons expect these to exist at
  // startup; missing them is the usual cause of "started but exits 1
  // silently" failures.
  ensureDirRecursive(fs, "/etc");
  writeVfsFile(fs, "/etc/passwd", ETC_PASSWD);
  writeVfsFile(fs, "/etc/group", ETC_GROUP);
  writeVfsFile(fs, "/etc/hosts", ETC_HOSTS);

  // Standard runtime/log dirs
  ensureDirRecursive(fs, "/var/log");
  fs.chmod("/var/log", 0o755);
  ensureDirRecursive(fs, "/run");
  fs.chmod("/run", 0o755);

  // Service tree
  ensureDirRecursive(fs, "/etc/dinit.d");

  const bootOpt = opts.boot ?? true;
  if (bootOpt !== false) {
    const bootName = typeof bootOpt === "string" ? bootOpt : "boot";
    const boot: DinitService = {
      name: bootName,
      type: "internal",
      dependsOn: services.map((s) => s.name),
    };
    writeVfsFile(fs, `/etc/dinit.d/${bootName}`, renderService(boot));
  }

  // Per-service config files.
  for (const svc of services) {
    writeVfsFile(fs, `/etc/dinit.d/${svc.name}`, renderService(svc));
  }
}
