/**
 * Assemble a demo's VFS image.
 *
 * WHY THIS IS NOT ON THE MAIN THREAD — composition needs a live
 * `MemoryFileSystem`, which means a `SharedArrayBuffer`. On WebKit only
 * `Worker.terminate()` reclaims shared memory deterministically: a buffer the
 * persistent main thread has merely dropped waits for a garbage collection
 * that reserved shared memory rarely provokes, so every boot's staging buffer
 * accumulates until Safari throws `Out of memory`. Running composition inside
 * a disposable worker makes the staging filesystem die with its realm, and
 * hands the main thread nothing but plain transferable bytes. (This replaced
 * the `trackTransientImageBuffer`/`settleWebKitReclaim` GC nudge, which was
 * best-effort with a deadline; terminating a realm is not.)
 *
 * This module is realm-agnostic: it touches no DOM and is imported by both
 * `image-composer-worker.ts` (to run) and `live-setup.ts` (for the pure
 * machine-resolution helpers). Keep it that way — a DOM reference here would
 * quietly force composition back onto the main thread. Anything the page
 * knows and composition needs (app path, protocol, memory profile) arrives
 * as plain data on {@link ComposeImageJob}.
 */

import { MemoryFileSystem } from "../../../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../../../../../host/src/vfs/image-helpers";
import {
  bindImageOwnedRuntimeUrls,
  type ImageOwnedRuntimeLazyAssets,
} from "../../../lib/init/image-owned-runtime-urls";
import {
  WORDPRESS_CONFIG_INIT_SCRIPT,
  WORDPRESS_URL_MU_PLUGIN,
  patchWordPressMysqliPersistentSource,
  renderWordPressConfig,
  wordpressConfigTemplate,
  type WordPressDatabaseKind,
} from "../../../lib/init/wordpress-runtime-config";
import { MYSQL_BENCHMARK_PHP } from "../../../lib/init/mysql-benchmark";
import {
  WORDPRESS_MARIADB_READY_FILE,
  WORDPRESS_MARIADB_READY_PHP,
  WORDPRESS_MARIADB_SOCKET_PATH,
} from "../../../lib/init/wordpress-mariadb-readiness";
import {
  KANDELO_DEMO_CONFIG_PATH,
  resolveDefaultProfileId,
  resolveDemoAssets,
  resolveDemoDisplay,
  resolveDemoIdentity,
  resolveDemoInit,
  resolveDemoRuntime,
  resolveDemoWeb,
  type DemoDisplayConfig,
  type DemoIdentityConfig,
  type DemoInitConfig,
  type DemoRuntimeConfig,
  type DemoWebConfig,
  type KandeloDemoConfig,
} from "../../../../../web-libs/kandelo-session/src/demo-config";
import { readKandeloDemoConfigFromVfs } from "../../../../../web-libs/kandelo-session/src/demo-config-vfs";
import { readDinitBootTargets } from "../../../../../web-libs/kandelo-session/src/dinit-boot-targets";
import {
  EXPERIMENTAL_TERMINAL_SESSION_PATH,
  MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES,
  parseExperimentalTerminalSession,
  type ExperimentalTerminalProgram,
  type ExperimentalTerminalSession,
} from "../../../../../web-libs/kandelo-session/src/experimental-terminal-session";
import {
  materializeBootInputs,
  type BootInputManifest,
} from "../../../../../web-libs/kandelo-session/src/boot-inputs";
import type { BootDescriptor } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import {
  assertVfsImageFitsProfile,
  declaredVfsMaxByteLength,
} from "../../../../../web-libs/kandelo-session/src/vfs-capacity";
import { ABI_VERSION } from "../../../../../host/src/generated/abi";
import { stageConfiguredAssets } from "./configured-assets";
import { verifyImportedSealsForCurrentBoot } from "./boot-current-boundary";

const ROOT_UID = 0;
const ROOT_GID = 0;
const ROOT_HOME = "/root";
const PHP_FPM_UID = 65534;
const PHP_FPM_GID = 65534;
const MYSQL_UID = 101;
const MYSQL_GID = 101;
const DEMO_UID = 1000;
const DEMO_GID = 1000;
const DEMO_HOME = "/home/maker";
const MARIADB_SOCKET_PATH = WORDPRESS_MARIADB_SOCKET_PATH;
const MARIADB_READY_SERVICE = "mariadb-ready";
const MARIADB_READY_SCRIPT_PATH = "/usr/local/bin/mariadb-ready";

/**
 * php-fpm's static worker pool, sized by the host.
 *
 * `pm = static` claims every child at startup, so this number is a demand for
 * that many process address spaces at once. On a host whose reservation pool
 * cannot supply them, php-fpm's master SIGTERMs the children it did start and
 * exits — taking dinit and the whole demo with it — so the count has to come
 * from the host's memory profile rather than a fixed constant.
 */
function patchedPhpFpmConf(workers: number): string {
  if (!Number.isSafeInteger(workers) || workers <= 0) {
    throw new Error(`invalid php-fpm worker count: ${workers}`);
  }
  return `[global]
daemonize = no
error_log = /dev/stderr
log_level = notice

[www]
user = nobody
group = nobody
listen = 127.0.0.1:9000
pm = static
pm.max_children = ${workers}
clear_env = no
slowlog = /dev/null
request_slowlog_trace_depth = 0
`;
}

/**
 * Everything composition needs, reduced to plain data so the whole job
 * survives `postMessage`. The page-derived values (`appPath`, `proto`,
 * `preforkServiceProcesses`) are here precisely because this code must not
 * read them from a `window` it does not have.
 */
export interface ComposeImageJob {
  /** Raw fetched image bytes (transferred in, not copied). */
  imageBytes: Uint8Array;
  /** Host filesystem budget; the image's own capacity still governs. */
  maxVfsByteLength: number;
  /** Human-readable image name for error messages. */
  imageLabel: string;
  /** Profile the caller asked for, or null for the image's default. */
  requestedProfileId: string | null;
  /** Which channel supplied `requestedProfileId`, for rejection messages. */
  requestedProfileSource: string | null;
  /** Protected-candidate boots skip every demo staging patch. */
  hasCandidateEvidence: boolean;
  /** Untrusted boot descriptor; only its declared inputs are materialized. */
  descriptor: BootDescriptor;
  /** Absent when the image declares no grouped lazy assets. */
  lazyAssets?: ImageOwnedRuntimeLazyAssets;
  /** Absolute app path baked into the WordPress runtime config. */
  appPath: string;
  /** "http" or "https", from the composing page's origin. */
  proto: string;
  /**
   * Worker count for pre-forking services, from the host's memory profile.
   * See {@link patchedPhpFpmConf}.
   */
  preforkServiceProcesses: number;
}

export interface ComposeImageResult {
  /** Serialized image, ready to hand to the kernel worker. */
  imageBytes: Uint8Array;
  /** Image-declared demo config; composition fails when the image has none. */
  imageConfig: KandeloDemoConfig;
  /** The profile actually selected (requested, or the image's default). */
  profileId: string;
  terminalSession: ExperimentalTerminalSession;
  /**
   * The dinit readiness closure of the machine's init target (empty when the
   * machine declares no dinit target). Computed here because it is read off
   * the staged filesystem's own /etc/dinit.d tree.
   */
  requiredServices: string[];
  bootInputManifest?: BootInputManifest;
}

/** The whole machine, read from the image it lives in, for one profile. */
export interface ImageMachine {
  profileId: string;
  identity: DemoIdentityConfig | null;
  runtime: DemoRuntimeConfig;
  init: DemoInitConfig | null;
  web: DemoWebConfig | null;
  display: DemoDisplayConfig | null;
}

/** Read the whole machine out of the image config, for one selected profile. */
export function imageMachine(
  config: KandeloDemoConfig,
  profileId: string,
): ImageMachine {
  return {
    profileId,
    identity: resolveDemoIdentity(config, profileId),
    runtime: resolveDemoRuntime(config, profileId),
    init: resolveDemoInit(config, profileId),
    web: resolveDemoWeb(config, profileId),
    display: resolveDemoDisplay(config, profileId),
  };
}

/**
 * Build the demo's image in a filesystem this realm owns, then serialize it.
 *
 * The caller aborts by terminating the realm. That is why there is no
 * supersession check threaded through the staging steps: the staged
 * filesystem is private to this worker and dies with it, so a superseded
 * composition cannot leak partially-staged state anywhere observable. On the
 * main thread the same code needed `assertCurrent()` after every await
 * precisely because it could not rely on that.
 */
export async function composeKandeloImage(
  job: ComposeImageJob,
  tick: (message: string) => void,
): Promise<ComposeImageResult> {
  const vfsMetadata = MemoryFileSystem.readImageMetadata(job.imageBytes);
  assertVfsImageFitsProfile(
    MemoryFileSystem.readImageCapacity(job.imageBytes),
    job.maxVfsByteLength,
    declaredVfsMaxByteLength(vfsMetadata),
    job.imageLabel,
  );
  MemoryFileSystem.assertImageKernelAbi(
    job.imageBytes,
    ABI_VERSION,
    job.imageLabel,
  );
  // Assemble the demo image in a TRANSIENT build-time filesystem. Its
  // SharedArrayBuffer never becomes the machine's live VFS — after
  // `saveImage()` the serialized bytes are transferred out and this whole
  // realm is terminated, and the kernel worker rebuilds+owns the live FS
  // from the bytes (kernelOwnedFs).
  const buildFs = MemoryFileSystem.fromImage(job.imageBytes, {
    maxByteLength: job.maxVfsByteLength,
  });
  // Reject forged imported seals before URL rewriting or asset registration
  // can trust their lazy metadata.
  await verifyImportedSealsForCurrentBoot(buildFs);
  const terminalSession = readImageExperimentalTerminalSession(buildFs);
  if (!job.hasCandidateEvidence) {
    // Keyed on what the image ACTUALLY CONTAINS, never on a machine id: an
    // image that ships a PHP-FPM config gets the host's worker-pool patch, and
    // one that ships WordPress gets the runtime wp-config this page's prefix
    // and protocol determine (which no baked artifact can know). Whether that
    // WordPress talks to MariaDB is likewise read off the image's own dinit
    // tree.
    if (vfsPathExists(buildFs, "/etc/php-fpm.conf")) {
      writeVfsFile(
        buildFs,
        "/etc/php-fpm.conf",
        patchedPhpFpmConf(job.preforkServiceProcesses),
      );
      ensureDirRecursive(buildFs, "/var/cache/opcache");
    }
    if (vfsPathExists(buildFs, "/var/www/html/wp-includes")) {
      if (vfsPathExists(buildFs, "/etc/dinit.d/mariadb")) {
        patchMariaDbUnixSocketConfig(buildFs);
        patchWordPressRuntimeConfig(buildFs, "mariadb", job.appPath, job.proto);
      } else {
        patchWordPressRuntimeConfig(buildFs, "sqlite", job.appPath, job.proto);
      }
    }
    ensureDemoHomes(buildFs);
  }
  assertImageTerminalProgram(buildFs, terminalSession.initial);
  if (terminalSession.afterExit !== undefined) {
    assertImageTerminalProgram(buildFs, terminalSession.afterExit);
  }
  // ── The machine, read from the image it lives in ────────────────────────
  //
  // Nothing here consults an app-side table. An image with no
  // /etc/kandelo/demo.json, or a malformed one, fails the boot here with the
  // real reason: there is no fallback machine to synthesize any more.
  const imageConfig = readImageConfig(buildFs);
  if (imageConfig === null) {
    throw new Error(
      `VFS image has no ${KANDELO_DEMO_CONFIG_PATH}, so it does not describe`
        + " a machine. Kandelo boots what the image declares; it does not"
        + " invent a default.",
    );
  }
  const profileId = resolveImageProfileId(
    imageConfig,
    job.requestedProfileId,
    job.requestedProfileSource,
  );
  const machine = imageMachine(imageConfig, profileId);
  const requiredServices: string[] = [];
  if (machine.init !== null && "target" in machine.init) {
    requiredServices.push(
      ...dinitServiceClosure(buildFs, machine.init.target),
    );
  }
  if (!job.hasCandidateEvidence) {
    const assets = resolveDemoAssets(imageConfig, profileId);
    // Supersession is enforced by terminating this worker, so the per-await
    // ownership check the main-thread path needed is a no-op here.
    await stageConfiguredAssets(buildFs, assets, tick, () => {});
  }

  // Boot inputs (e.g. a #k1= link's script) are untrusted, URL-carried
  // payloads. Materialize the whole declared set now, at the same
  // image-staging point as the asset patches above: every input must verify
  // its byte length and sha256 before anything is written, and a
  // materialization failure must fail the boot loudly rather than silently
  // continue without the input the link promised.
  let bootInputManifest: BootInputManifest | undefined;
  if (job.descriptor.boot.inputs?.length) {
    tick("materializing boot inputs...");
    bootInputManifest = await materializeBootInputs(job.descriptor, {
      resolvers: {},
      mkdir: (p) => ensureDirRecursive(buildFs, p),
      writeFile: (p, b, m) => writeVfsBinary(buildFs, p, b, m),
    });
  }

  // WHY here: this is the final image mutation. Binding before any later
  // staging could leave newly-added lazy metadata outside the manifest
  // authority copied from the authenticated product activation.
  bindImageOwnedRuntimeUrls(buildFs, job.lazyAssets);
  tick("assembling kernel-owned VFS image...");
  // `saveImage()` emits raw (uncompressed) plain bytes that
  // `MemoryFileSystem.fromImage` restores directly in the kernel worker;
  // buildFs and its SharedArrayBuffer die with this realm.
  const imageBytes = await buildFs.saveImage();
  return {
    imageBytes,
    imageConfig,
    profileId,
    terminalSession,
    requiredServices,
    bootInputManifest,
  };
}

const TOP_LEVEL_PROFILE_ID = "";

function declaredProfileIds(config: KandeloDemoConfig): string[] {
  const profiles = config.profiles;
  return profiles !== undefined && profiles !== null && !Array.isArray(profiles)
    ? Object.keys(profiles)
    : [];
}

function resolveImageProfileId(
  config: KandeloDemoConfig,
  requestedProfileId: string | null,
  requestedProfileSource: string | null,
): string {
  const declared = declaredProfileIds(config);
  if (requestedProfileId !== null) {
    if (declared.includes(requestedProfileId)) return requestedProfileId;
    // A profile id nobody declared is a real boundary: refusing to guess is
    // what keeps `&profile=` from silently booting a different machine.
    throw new Error(
      `${requestedProfileSource ?? "the request"} selected profile ${
        JSON.stringify(requestedProfileId)
      }, which this image's ${KANDELO_DEMO_CONFIG_PATH} does not declare`
        + ` (declared: ${declared.length > 0 ? declared.join(", ") : "none"})`,
    );
  }
  if (declared.length === 0) return TOP_LEVEL_PROFILE_ID;
  const defaultProfileId = resolveDefaultProfileId(config);
  if (defaultProfileId === null) {
    throw new Error(
      `${KANDELO_DEMO_CONFIG_PATH} declares ${declared.length} profiles but no`
        + ` defaultProfile; select one with &profile= (declared: ${
          declared.join(", ")
        })`,
    );
  }
  return defaultProfileId;
}

/** Far above any real service tree; a hostile image cannot spin this. */
const MAX_DINIT_SERVICE_CLOSURE = 256;

/**
 * The readiness service list, derived from the image's own dinit tree
 * instead of a hand-maintained copy: the transitive `depends-on` closure of
 * the target `demo.json` selected, including the target itself. A dependency
 * with no `/etc/dinit.d/<name>` file throws, naming it — a machine that can
 * never become ready is a defect, not something to wait out.
 */
function dinitServiceClosure(
  fs: MemoryFileSystem,
  target: string,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const pending = [target];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    ordered.push(name);
    if (seen.size > MAX_DINIT_SERVICE_CLOSURE) {
      throw new Error(
        `image dinit tree exceeds ${MAX_DINIT_SERVICE_CLOSURE} services`,
      );
    }
    for (const dependency of readDinitBootTargets(fs, name)) {
      pending.push(dependency);
    }
  }
  return ordered;
}

function readImageExperimentalTerminalSession(
  fs: MemoryFileSystem,
): ExperimentalTerminalSession {
  let stat;
  try {
    stat = fs.lstat(EXPERIMENTAL_TERMINAL_SESSION_PATH);
  } catch (err) {
    if (isMissingVfsPath(err)) {
      throw new Error(
        `VFS image is missing ${EXPERIMENTAL_TERMINAL_SESSION_PATH}`,
      );
    }
    throw err;
  }
  if ((stat.mode & 0xf000) !== 0x8000) {
    throw new Error(
      `${EXPERIMENTAL_TERMINAL_SESSION_PATH} must be a regular file`,
    );
  }
  if (stat.size > MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES) {
    throw new Error(
      `${EXPERIMENTAL_TERMINAL_SESSION_PATH} exceeds ` +
        `${MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES} bytes`,
    );
  }
  const json = new TextDecoder("utf-8", { fatal: true }).decode(
    new Uint8Array(readVfsFile(fs, EXPERIMENTAL_TERMINAL_SESSION_PATH)),
  );
  return parseExperimentalTerminalSession(json);
}

function assertImageTerminalProgram(
  fs: MemoryFileSystem,
  program: ExperimentalTerminalProgram,
): void {
  const path = program.path;
  let stat;
  try {
    stat = fs.stat(path);
  } catch {
    throw new Error(`VFS image terminal program is missing: ${path}`);
  }
  if ((stat.mode & 0xf000) !== 0x8000) {
    throw new Error(`VFS image terminal program is not a regular file: ${path}`);
  }
  if ((stat.mode & 0o111) === 0) {
    throw new Error(`VFS image terminal program is not executable: ${path}`);
  }
}

function readImageConfig(fs: MemoryFileSystem): KandeloDemoConfig | null {
  return readKandeloDemoConfigFromVfs(fs);
}

function ensureDemoHomes(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/home");
  ensureOwnedDir(fs, DEMO_HOME, 0o755, DEMO_UID, DEMO_GID);
  ensureOwnedDir(fs, ROOT_HOME, 0o700, ROOT_UID, ROOT_GID);
}

function ensureOwnedDir(
  fs: MemoryFileSystem,
  path: string,
  mode: number,
  uid: number,
  gid: number,
): void {
  ensureDirRecursive(fs, path);
  fs.chown(path, uid, gid);
  fs.chmod(path, mode);
}

function patchWordPressRuntimeConfig(
  fs: MemoryFileSystem,
  kind: WordPressDatabaseKind,
  appPath: string,
  proto: string,
): void {
  writeVfsFile(fs, "/etc/wp-config-init.sh", WORDPRESS_CONFIG_INIT_SCRIPT);
  writeVfsFile(
    fs,
    "/etc/wp-config-template.php",
    wordpressConfigTemplate(kind),
  );
  writeVfsFile(
    fs,
    "/var/www/html/wp-config.php",
    renderWordPressConfig(kind, appPath, proto),
  );
  if (kind === "sqlite") {
    ensureOwnedDir(
      fs,
      "/var/www/html/wp-content/database",
      0o775,
      PHP_FPM_UID,
      PHP_FPM_GID,
    );
  } else if (kind === "mariadb") {
    for (const dir of ["/data", "/data/mysql", "/data/tmp", "/data/test"]) {
      ensureOwnedDir(fs, dir, 0o775, MYSQL_UID, MYSQL_GID);
    }
    patchWordPressPersistentMysqli(fs);
    writeVfsFile(
      fs,
      "/var/www/html/kandelo-mysql-bench.php",
      MYSQL_BENCHMARK_PHP,
    );
  }
  ensureDirRecursive(fs, "/var/www/html/wp-content/mu-plugins");
  writeVfsFile(
    fs,
    "/var/www/html/wp-content/mu-plugins/kandelo-url.php",
    WORDPRESS_URL_MU_PLUGIN,
  );
}

function patchMariaDbUnixSocketConfig(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/tmp");
  fs.chmod("/tmp", 0o1777);
  ensureDirRecursive(fs, dirname(WORDPRESS_MARIADB_READY_FILE));
  writeVfsFile(fs, WORDPRESS_MARIADB_READY_FILE, WORDPRESS_MARIADB_READY_PHP);

  const phpIniPath = "/etc/php.ini";
  const phpIni = readOptionalVfsText(fs, phpIniPath);
  if (phpIni !== null) {
    let patched = phpIni;
    if (!/^mysqli\.default_socket\s*=/m.test(patched)) {
      patched += `${patched.endsWith("\n") ? "" : "\n"}mysqli.default_socket=${MARIADB_SOCKET_PATH}\n`;
    }
    if (!/^mysqli\.allow_persistent\s*=/m.test(patched)) {
      patched += `mysqli.allow_persistent=1\n`;
    }
    if (!/^mysqli\.max_persistent\s*=/m.test(patched)) {
      patched += `mysqli.max_persistent=-1\n`;
    }
    if (!/^pdo_mysql\.default_socket\s*=/m.test(patched)) {
      patched += `pdo_mysql.default_socket=${MARIADB_SOCKET_PATH}\n`;
    }
    if (patched !== phpIni) writeVfsFile(fs, phpIniPath, patched);
  }

  const mariadbServicePath = "/etc/dinit.d/mariadb";
  const mariadbService = readOptionalVfsText(fs, mariadbServicePath);
  if (mariadbService !== null) {
    const patched = mariadbService
      .replace(/--socket=(?:\S*)?/g, `--socket=${MARIADB_SOCKET_PATH}`)
      .replace(/\s*--thread-handling=no-threads\b/g, "");
    if (patched !== mariadbService)
      writeVfsFile(fs, mariadbServicePath, patched);
  }

  ensureMariaDbReadyService(fs);
  patchPhpFpmMariaDbDependency(fs);
}

function ensureMariaDbReadyService(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, dirname(MARIADB_READY_SCRIPT_PATH));
  writeVfsFile(
    fs,
    MARIADB_READY_SCRIPT_PATH,
    `#!/bin/sh
set -u

i=0
while [ "$i" -lt 60 ]; do
    if [ -S "${MARIADB_SOCKET_PATH}" ] || [ -e "${MARIADB_SOCKET_PATH}" ]; then
        exit 0
    fi
    sleep 1
    i=$((i + 1))
done

echo "MariaDB readiness timed out waiting for ${MARIADB_SOCKET_PATH}" >&2
exit 1
`,
    0o755,
  );
  writeVfsFile(
    fs,
    `/etc/dinit.d/${MARIADB_READY_SERVICE}`,
    `type = scripted
command = /bin/sh ${MARIADB_READY_SCRIPT_PATH}
depends-on = mariadb
restart = false
`,
  );
}

function patchPhpFpmMariaDbDependency(fs: MemoryFileSystem): void {
  const phpFpmServicePath = "/etc/dinit.d/php-fpm";
  const phpFpmService = readOptionalVfsText(fs, phpFpmServicePath);
  if (phpFpmService === null) return;
  if (
    new RegExp(`^depends-on\\s*=\\s*${MARIADB_READY_SERVICE}$`, "m").test(
      phpFpmService,
    )
  ) {
    return;
  }
  const patched = phpFpmService.replace(
    /^depends-on\s*=\s*mariadb\s*$/m,
    `depends-on = ${MARIADB_READY_SERVICE}`,
  );
  if (patched !== phpFpmService) {
    writeVfsFile(fs, phpFpmServicePath, patched);
  } else {
    writeVfsFile(
      fs,
      phpFpmServicePath,
      `${phpFpmService}${phpFpmService.endsWith("\n") ? "" : "\n"}depends-on = ${MARIADB_READY_SERVICE}\n`,
    );
  }
}

function patchWordPressPersistentMysqli(fs: MemoryFileSystem): void {
  for (const path of [
    "/var/www/html/wp-includes/class-wpdb.php",
    "/var/www/html/wp-includes/wp-db.php",
  ]) {
    const source = readOptionalVfsText(fs, path);
    if (source === null) continue;
    const patched = patchWordPressMysqliPersistentSource(source);
    if (patched !== source) writeVfsFile(fs, path, patched);
  }
}

function readOptionalVfsText(
  fs: MemoryFileSystem,
  path: string,
): string | null {
  const bytes = readOptionalVfsFile(fs, path);
  return bytes === null
    ? null
    : new TextDecoder().decode(new Uint8Array(bytes));
}

function readOptionalVfsFile(
  fs: MemoryFileSystem,
  path: string,
): ArrayBuffer | null {
  try {
    return readVfsFile(fs, path);
  } catch (err) {
    if (isMissingVfsPath(err)) return null;
    throw err;
  }
}

/** Does this image actually contain that path? The host's staging patches
 *  key off what the image CONTAINS, never off a machine id. */
function vfsPathExists(fs: MemoryFileSystem, path: string): boolean {
  try {
    fs.stat(path);
    return true;
  } catch (err) {
    if (isMissingVfsPath(err)) return false;
    throw err;
  }
}

function isMissingVfsPath(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (code === -2 || code === "ENOENT") return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/\bENOENT\b/.test(message)) return true;
  return message.includes("No such file or directory");
}

function readVfsFile(fs: MemoryFileSystem, path: string): ArrayBuffer {
  const st = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const out = new Uint8Array(st.size);
    let off = 0;
    while (off < out.byteLength) {
      const n = fs.read(fd, out.subarray(off), null, out.byteLength - off);
      if (n <= 0) break;
      off += n;
    }
    return out.buffer.slice(out.byteOffset, out.byteOffset + off);
  } finally {
    fs.close(fd);
  }
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}
