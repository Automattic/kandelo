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
 * hands the main thread nothing but plain transferable bytes.
 *
 * This module is realm-agnostic: it touches no DOM and is imported by
 * `image-composer-worker.ts`. Keep it that way — a DOM reference here would
 * quietly force composition back onto the main thread.
 */

import { MemoryFileSystem } from "../../../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../../../../../host/src/vfs/image-helpers";
import {
  extractZipEntry,
  parseZipCentralDirectory,
} from "../../../../../host/src/vfs/zip";
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
  builtinDemoAssets,
} from "../../../../../web-libs/kandelo-session/src/demo-guides";
import {
  resolveDemoAssets,
  type KandeloDemoConfig,
} from "../../../../../web-libs/kandelo-session/src/demo-config";
import { readKandeloDemoConfigFromVfs } from "../../../../../web-libs/kandelo-session/src/demo-config-vfs";
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
import { failOn, optionalBinaryUrl } from "./binary-urls";
import { stageConfiguredAssets } from "./configured-assets";
import { verifyImportedSealsForCurrentBoot } from "./boot-current-boundary";
import sdl2PlasmaFragSrc from "../../../../../programs/sdl2/presets/image/plasma.frag?raw";
import sdl2AudioBarsFragSrc from "../../../../../programs/sdl2/presets/image/audio_bars.frag?raw";
import sdl2TunnelwispFragSrc from "../../../../../programs/sdl2/presets/image/tunnelwisp.frag?raw";
import sdl2SoundSineFragSrc from "../../../../../programs/sdl2/presets/sound/sine.frag?raw";
import sdl2SoundTunnelwispFragSrc from "../../../../../programs/sdl2/presets/sound/tunnelwisp.frag?raw";
import sdl2SoundFmBellFragSrc from "../../../../../programs/sdl2/presets/sound/fm_bell.frag?raw";
import sdl2SoundNoiseSweepFragSrc from "../../../../../programs/sdl2/presets/sound/noise_sweep.frag?raw";
import sdl2SoundChordFragSrc from "../../../../../programs/sdl2/presets/sound/chord.frag?raw";

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
const PHP_FPM_WORKERS = 6;
const PATCHED_PHP_FPM_CONF = `[global]
daemonize = no
error_log = /dev/stderr
log_level = notice

[www]
user = nobody
group = nobody
listen = 127.0.0.1:9000
pm = static
pm.max_children = ${PHP_FPM_WORKERS}
clear_env = no
slowlog = /dev/null
request_slowlog_trace_depth = 0
`;

/**
 * Everything composition needs from a `LiveProfile`, reduced to plain data so
 * the whole job survives `postMessage`.
 */
export interface ComposableProfile {
  id: string;
  /** Profile's filesystem budget; the image's own capacity still governs. */
  maxVfsByteLength: number;
  /** Protected-candidate boots skip every demo staging patch. */
  hasCandidateEvidence: boolean;
  init?: {
    argv: string[];
    programUrl?: string;
  };
  sdl2Demo: boolean;
  espeakDemo: boolean;
  evdevDemo: boolean;
}

export interface ComposeImageJob {
  profile: ComposableProfile;
  descriptor: BootDescriptor;
  /** Raw fetched image bytes; may still be compressed. */
  imageBytes: Uint8Array;
  /** Absent when the image declares no grouped lazy assets. */
  lazyAssets?: ImageOwnedRuntimeLazyAssets;
  /** Absolute app path baked into the WordPress runtime config. */
  appPath: string;
  /** "http" or "https", from the composing page's origin. */
  proto: string;
}

export interface ComposeImageResult {
  /** Serialized image, ready to hand to the kernel worker. */
  imageBytes: Uint8Array;
  terminalSession: ExperimentalTerminalSession;
  /** Image-declared demo config, for the main thread's presentation layer. */
  imageConfig: KandeloDemoConfig | null;
  bootInputManifest?: BootInputManifest;
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
  const { profile, descriptor } = job;
  const capacity = MemoryFileSystem.readImageCapacity(job.imageBytes);
  // Reserve what the image's SharedFS superblock can actually use:
  // `SharedFS.grow()` refuses to pass the recorded capacity, so a larger
  // ceiling buys no staging room and costs real budget on WebKit.
  const buildFs = MemoryFileSystem.fromImage(job.imageBytes, {
    maxByteLength: Math.max(
      capacity.byteLength,
      Math.min(capacity.maxByteLength, profile.maxVfsByteLength),
    ),
  });
  // Reject forged imported seals before URL rewriting or asset registration
  // can trust their lazy metadata.
  await verifyImportedSealsForCurrentBoot(buildFs);
  const terminalSession = readImageExperimentalTerminalSession(buildFs);
  if (!profile.hasCandidateEvidence) {
    if (
      profile.id === "nginx-php" ||
      profile.id === "wordpress-sqlite" ||
      profile.id === "wordpress-mariadb"
    ) {
      writeVfsFile(buildFs, "/etc/php-fpm.conf", PATCHED_PHP_FPM_CONF);
      ensureDirRecursive(buildFs, "/var/cache/opcache");
    }
    if (profile.id === "wordpress-sqlite") {
      patchWordPressRuntimeConfig(buildFs, "sqlite", job.appPath, job.proto);
    } else if (profile.id === "wordpress-mariadb") {
      patchMariaDbUnixSocketConfig(buildFs);
      patchWordPressRuntimeConfig(buildFs, "mariadb", job.appPath, job.proto);
    }
    if (profile.init?.programUrl) {
      tick(`staging ${profile.init.argv[0]}...`);
      const bytes = await fetch(profile.init.programUrl)
        .then(failOn(profile.init.argv[0]))
        .then((r) => r.arrayBuffer());
      ensureDirRecursive(buildFs, dirname(profile.init.argv[0]));
      writeVfsBinary(buildFs, profile.init.argv[0], new Uint8Array(bytes), 0o755);
    }
    // Each demo runs its binary from a path, so the bytes have to be in the
    // image before the kernel worker takes exclusive ownership of the VFS.
    if (profile.sdl2Demo) {
      tick("staging sdl2...");
      await stageSdl2Runtime(buildFs);
    }
    if (profile.espeakDemo) {
      tick("staging espeak-ng...");
      await stageEspeakRuntime(buildFs);
    }
    if (profile.evdevDemo) {
      tick("staging evdev_demo...");
      await stageEvdevDemo(buildFs);
    }
    ensureDemoHomes(buildFs);
  }
  assertImageTerminalProgram(buildFs, terminalSession.initial);
  if (terminalSession.afterExit !== undefined) {
    assertImageTerminalProgram(buildFs, terminalSession.afterExit);
  }
  const imageConfig = readImageConfig(buildFs);
  const imageAssets = imageConfig
    ? resolveDemoAssets(imageConfig, profile.id)
    : [];
  const assets =
    imageAssets.length > 0 ? imageAssets : builtinDemoAssets(profile.id);
  if (!profile.hasCandidateEvidence) {
    // Supersession is enforced by terminating this worker, so the
    // per-await ownership check the main-thread path needed is a no-op here.
    await stageConfiguredAssets(buildFs, assets, tick, () => {});
  }

  // Boot inputs (e.g. a #k1= link's script) are untrusted, URL-carried
  // payloads. Materialize the whole declared set now, at the same
  // image-staging point as the asset patches above: every input must verify
  // its byte length and sha256 before anything is written, and a
  // materialization failure must fail the boot loudly rather than silently
  // continue without the input the link promised.
  let bootInputManifest: BootInputManifest | undefined;
  if (descriptor.boot.inputs?.length) {
    tick("materializing boot inputs...");
    bootInputManifest = await materializeBootInputs(descriptor, {
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
  const imageBytes = await buildFs.saveImage();
  return { imageBytes, terminalSession, imageConfig, bootInputManifest };
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

/**
 * Bake the SDL2 GLSL playground and its shader presets into the image.
 *
 * The playground's source-resolution chain is
 *   1. /home/shaders/<mode>/current.frag       (user-editable)
 *   2. /usr/share/shaders/<mode>/<preset>.frag (preset)
 *   3. built-in fallback compiled into main.c
 * Staging (2) makes the browser path exercise the VFS leg;
 * /home/shaders/<mode> is created so Ctrl+S can write (1) without first
 * creating directories. tunnelwisp is the boot default for both modes;
 * the others are loadable through the editor's Ctrl+L preset browser.
 */
async function stageSdl2Runtime(fs: MemoryFileSystem): Promise<void> {
  const url = await optionalBinaryUrl([
    "../../../../../local-binaries/programs/wasm32/sdl2.wasm",
    "../../../../../binaries/programs/wasm32/sdl2.wasm",
  ], "sdl2.wasm");
  const bytes = await fetch(url)
    .then(failOn("sdl2.wasm"))
    .then((r) => r.arrayBuffer());
  ensureDirRecursive(fs, "/usr/local/bin");
  writeVfsBinary(fs, "/usr/local/bin/sdl2", new Uint8Array(bytes), 0o755);

  ensureDirRecursive(fs, "/usr/share/shaders/image");
  ensureDirRecursive(fs, "/home/shaders/image");
  writeVfsFile(fs, "/usr/share/shaders/image/plasma.frag", sdl2PlasmaFragSrc);
  writeVfsFile(fs, "/usr/share/shaders/image/audio_bars.frag", sdl2AudioBarsFragSrc);
  writeVfsFile(fs, "/usr/share/shaders/image/tunnelwisp.frag", sdl2TunnelwispFragSrc);

  ensureDirRecursive(fs, "/usr/share/shaders/sound");
  ensureDirRecursive(fs, "/home/shaders/sound");
  writeVfsFile(fs, "/usr/share/shaders/sound/tunnelwisp.frag", sdl2SoundTunnelwispFragSrc);
  writeVfsFile(fs, "/usr/share/shaders/sound/sine.frag", sdl2SoundSineFragSrc);
  writeVfsFile(fs, "/usr/share/shaders/sound/fm_bell.frag", sdl2SoundFmBellFragSrc);
  writeVfsFile(fs, "/usr/share/shaders/sound/noise_sweep.frag", sdl2SoundNoiseSweepFragSrc);
  writeVfsFile(fs, "/usr/share/shaders/sound/chord.frag", sdl2SoundChordFragSrc);
}

/**
 * Bake espeak-ng and its voice data into the image.
 *
 * Both come from the espeak-ng package closure, so the demo consumes the same
 * bytes the resolver published. libespeak-ng's PATH_ESPEAK_DATA is fixed to
 * /usr/share at build time, so the data tree has to land unpacked there.
 */
async function stageEspeakRuntime(fs: MemoryFileSystem): Promise<void> {
  const binaryUrl = await optionalBinaryUrl([
    "../../../../../local-binaries/programs/wasm32/espeak-ng/espeak-ng.wasm",
    "../../../../../binaries/programs/wasm32/espeak-ng/espeak-ng.wasm",
  ], "espeak-ng.wasm");
  const binary = await fetch(binaryUrl)
    .then(failOn("espeak-ng.wasm"))
    .then((r) => r.arrayBuffer());
  ensureDirRecursive(fs, "/usr/bin");
  writeVfsBinary(fs, "/usr/bin/espeak-ng", new Uint8Array(binary), 0o755);

  const dataUrl = await optionalBinaryUrl([
    "../../../../../local-binaries/programs/wasm32/espeak-ng/espeak-ng-data.zip",
    "../../../../../binaries/programs/wasm32/espeak-ng/espeak-ng-data.zip",
  ], "espeak-ng-data.zip");
  const data = await fetch(dataUrl)
    .then(failOn("espeak-ng-data.zip"))
    .then((r) => r.arrayBuffer());
  const zipBytes = new Uint8Array(data);
  const root = "/usr/share/espeak-ng-data";
  ensureDirRecursive(fs, root);
  for (const entry of parseZipCentralDirectory(zipBytes)) {
    if (entry.isDirectory) continue;
    const target = `${root}/${entry.fileName}`;
    ensureDirRecursive(fs, target.slice(0, target.lastIndexOf("/")));
    writeVfsBinary(fs, target, extractZipEntry(zipBytes, entry), 0o644);
  }
}

async function stageEvdevDemo(fs: MemoryFileSystem): Promise<void> {
  const url = await optionalBinaryUrl([
    "../../../../../local-binaries/programs/wasm32/evdev_demo.wasm",
    "../../../../../binaries/programs/wasm32/evdev_demo.wasm",
  ], "evdev_demo.wasm");
  const bytes = await fetch(url)
    .then(failOn("evdev_demo.wasm"))
    .then((r) => r.arrayBuffer());
  ensureDirRecursive(fs, "/usr/local/bin");
  writeVfsBinary(fs, "/usr/local/bin/evdev_demo", new Uint8Array(bytes), 0o755);
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
