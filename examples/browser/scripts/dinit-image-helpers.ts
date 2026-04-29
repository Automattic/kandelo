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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  writeVfsBinary,
  writeVfsFile,
  ensureDirRecursive,
} from "../../../host/src/vfs/image-helpers";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");

/** Where build-dinit.sh drops the binary. */
const DINIT_WASM = join(REPO_ROOT, "examples", "libs", "dinit", "bin", "dinit.wasm");
const DINITCTL_WASM = join(REPO_ROOT, "examples", "libs", "dinit", "bin", "dinitctl.wasm");

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
  if (svc.restart) {
    lines.push("restart = true");
    if (svc.restartDelay !== undefined) lines.push(`restart-delay = ${svc.restartDelay}`);
  }
  if (svc.logfile !== undefined) {
    lines.push(`logfile = ${svc.logfile}`);
  } else if (svc.type !== "internal") {
    // Default to /dev/stderr so service output flows through dinit's
    // stderr → kernel stderr → demo's onStderr callback. Without this,
    // dinit's NONE log type sends service output to /dev/null and we
    // lose error messages. Demos that want isolation can opt in by
    // setting `logfile` explicitly.
    lines.push("logfile = /dev/stderr");
  }
  for (const line of svc.extra ?? []) lines.push(line);
  lines.push(""); // trailing newline
  return lines.join("\n");
}

/**
 * Add the dinit binary, the implicit `boot` service that pulls in the
 * supplied services, and per-service config files into the image.
 *
 * Image gets:
 *   /sbin/dinit              - the init binary
 *   /sbin/dinitctl           - the control client (small, ~700KB)
 *   /etc/dinit.d/boot        - internal service depending on each service
 *   /etc/dinit.d/<name>      - per-service config file
 *   /var/log                 - log directory
 *   /run                     - runtime state
 *
 * The browser demo boots with argv = ["/sbin/dinit", "--container"].
 */
export function addDinitInit(
  fs: MemoryFileSystem,
  services: DinitService[],
): void {
  // Binaries
  ensureDirRecursive(fs, "/sbin");
  writeVfsBinary(fs, "/sbin/dinit", new Uint8Array(readFileSync(DINIT_WASM)));
  writeVfsBinary(fs, "/sbin/dinitctl", new Uint8Array(readFileSync(DINITCTL_WASM)));

  // Standard runtime/log dirs
  ensureDirRecursive(fs, "/var/log");
  fs.chmod("/var/log", 0o755);
  ensureDirRecursive(fs, "/run");
  fs.chmod("/run", 0o755);

  // Service tree
  ensureDirRecursive(fs, "/etc/dinit.d");

  // Implicit "boot" service: dinit's default target. Depends on every
  // listed service so the whole tree starts when dinit comes up.
  const boot: DinitService = {
    name: "boot",
    type: "internal",
    dependsOn: services.map((s) => s.name),
  };
  writeVfsFile(fs, "/etc/dinit.d/boot", renderService(boot));

  // Per-service config files.
  for (const svc of services) {
    writeVfsFile(fs, `/etc/dinit.d/${svc.name}`, renderService(svc));
  }
}
