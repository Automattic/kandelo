// Builds a LiveKernelHost over a real BrowserKernel. Used by default when the
// kandelo page is loaded (use `?mock=1` for MockKernelHost).

import { BrowserKernel } from "@host/browser-kernel-host";
import { initServiceWorkerBridge } from "../../../lib/init/service-worker-bridge";
import { HttpBridgeHost } from "../../../lib/http-bridge";
import {
  COREUTILS_NAMES,
  populateShellBinaries,
  type BinaryDef,
} from "../../../lib/init/shell-binaries";
import { MemoryFileSystem } from "../../../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsBinary,
} from "../../../../../host/src/vfs/image-helpers";
import { decompress as decompressZstd } from "fzstd";
import {
  LiveKernelHost,
  type BootDescriptor,
  type DemoPresentation,
  type GalleryItem,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { PRESET_LIBRARY } from "../fixtures";

import kernelWasmUrl from "@kernel-wasm?url";
import shellVfsUrl from "@binaries/programs/wasm32/shell.vfs.zst?url";
import nodeVfsUrl from "@binaries/programs/wasm32/node-vfs.vfs.zst?url";
import nginxVfsUrl from "@binaries/programs/wasm32/nginx-vfs.vfs.zst?url";
import nginxPhpVfsUrl from "@binaries/programs/wasm32/nginx-php-vfs.vfs.zst?url";
import wordpressVfsUrl from "@binaries/programs/wasm32/wordpress.vfs.zst?url";
import lampVfsUrl from "@binaries/programs/wasm32/lamp.vfs.zst?url";
import nodeWasmUrl from "@binaries/programs/wasm32/node.wasm?url";
import dashWasmUrl from "@binaries/programs/wasm32/dash.wasm?url";
import bashWasmUrl from "@binaries/programs/wasm32/bash.wasm?url";
import coreutilsWasmUrl from "@binaries/programs/wasm32/coreutils.wasm?url";
import grepWasmUrl from "@binaries/programs/wasm32/grep.wasm?url";
import sedWasmUrl from "@binaries/programs/wasm32/sed.wasm?url";
import bcWasmUrl from "@binaries/programs/wasm32/bc.wasm?url";
import fileWasmUrl from "@binaries/programs/wasm32/file/file.wasm?url";
import lessWasmUrl from "@binaries/programs/wasm32/less.wasm?url";
import m4WasmUrl from "@binaries/programs/wasm32/m4.wasm?url";
import makeWasmUrl from "@binaries/programs/wasm32/make.wasm?url";
import tarWasmUrl from "@binaries/programs/wasm32/tar.wasm?url";
import curlWasmUrl from "@binaries/programs/wasm32/curl.wasm?url";
import wgetWasmUrl from "@binaries/programs/wasm32/wget.wasm?url";
import gitWasmUrl from "@binaries/programs/wasm32/git/git.wasm?url";
import gitRemoteHttpWasmUrl from "@binaries/programs/wasm32/git/git-remote-http.wasm?url";
import gzipWasmUrl from "@binaries/programs/wasm32/gzip.wasm?url";
import bzip2WasmUrl from "@binaries/programs/wasm32/bzip2.wasm?url";
import xzWasmUrl from "@binaries/programs/wasm32/xz.wasm?url";
import zstdWasmUrl from "@binaries/programs/wasm32/zstd.wasm?url";
import zipWasmUrl from "@binaries/programs/wasm32/zip.wasm?url";
import unzipWasmUrl from "@binaries/programs/wasm32/unzip.wasm?url";
import nanoWasmUrl from "@binaries/programs/wasm32/nano.wasm?url";
import lsofWasmUrl from "@binaries/programs/wasm32/lsof.wasm?url";
import fbtestWasmUrl from "@binaries/programs/wasm32/fbtest.wasm?url";
import fbdoomWasmUrl from "@binaries/programs/wasm32/fbdoom.wasm?url";

const KANDELO_SOFTWARE_MANIFEST_URL =
  "https://github.com/brandonpayton/kandelo-software/releases/download/binaries-abi-v11/gallery.json";
const DEFAULT_KANDELO_SOFTWARE_INDEX_URL =
  "https://github.com/brandonpayton/kandelo-software/releases/download/binaries-abi-v11/index.toml";

type GalleryPackageRequirement = {
  name: string;
  version: string;
};

type SoftwareGalleryEntry = {
  id: string;
  title: string;
  description: string;
  packages: GalleryPackageRequirement[];
  package_url?: string;
};

type SoftwareGalleryManifest = {
  index_url?: string;
  entries: SoftwareGalleryEntry[];
};

type IndexBinaryEntry = {
  status?: string;
  archive_url?: string;
};

type IndexPackageEntry = {
  name?: string;
  version?: string;
  binary: Record<string, IndexBinaryEntry>;
};

type SoftwareBinary = {
  archiveUrl: string;
  artifactPath: string;
  installPath: string;
  symlinks?: string[];
};

type SoftwareProfile = {
  id: string;
  vfsArchiveUrl: string;
  vfsArtifactPath: string;
  binaries: SoftwareBinary[];
  shellEnv?: string[];
  autoCommand?: string;
  init?: LiveProfile["init"];
  presentation?: DemoPresentation;
};

const SOFTWARE_PROFILES = new Map<string, SoftwareProfile>();
const tarDecoder = new TextDecoder();

type LiveDemoId =
  | "shell"
  | "node"
  | "nginx"
  | "nginx-php"
  | "wordpress-sqlite"
  | "wordpress-mariadb"
  | "doom";

interface LiveProfile {
  id: LiveDemoId;
  vfsUrl: string;
  software?: SoftwareProfile;
  descriptor: BootDescriptor;
  presentation: DemoPresentation;
  autoCommand?: string;
  init?: {
    argv: string[];
    env?: string[];
    cwd?: string;
    maxWorkers?: number;
    maxMemoryPages?: number;
    web?: { label: string; requiredPorts: number[] };
  };
  framebuffer?: "doom" | "test";
}

interface WebReadinessState {
  ready: boolean;
  probing: boolean;
}

const APP_PREFIX = import.meta.env.BASE_URL + "app/";
const APP_PATH = import.meta.env.BASE_URL + "app";
const PROTO = window.location.protocol === "https:" ? "https" : "http";
const SW_URL = import.meta.env.BASE_URL + "service-worker.js";
const HTTP_PORT = 8080;
const DOOM_WAD_URL = "https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad";

const SHELL_ENV: string[] = [
  "HOME=/home",
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
  "PS1=kandelo$ ",
  "HISTFILE=/home/.bash_history",
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
];

const NODE_SHELL_ENV: string[] = [
  "HOME=/work",
  "PWD=/work",
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
  "PS1=node$ ",
  "HISTFILE=/work/.bash_history",
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
  "npm_config_cache=/tmp/.npm-cache",
  "npm_config_registry=http://proxy.local/",
  "npm_config_fund=false",
  "npm_config_audit=false",
  "npm_config_progress=false",
];

const SERVICE_ENV: string[] = [
  "HOME=/root",
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
];

const DOOM_COMMAND = "/usr/local/bin/fbdoom -iwad /doom1.wad";

export type FbDemo = "none" | "test" | "doom";

export interface CreateLiveHostOptions {
  demo?: string | null;
  fb?: FbDemo;
}

export async function createLiveHost(opts: CreateLiveHostOptions = {}): Promise<LiveKernelHost> {
  let currentKernel: BrowserKernel | null = null;
  let bootSeq = 0;
  const galleryItems = await loadLiveGalleryItems();

  const host = new LiveKernelHost({
    status: "booting",
    descriptor: descriptorFor("shell"),
    galleryItems,
    applyBootDescriptor: async (desc, h) => {
      const seq = ++bootSeq;
      try {
        if (currentKernel) {
          await currentKernel.destroy().catch(() => {});
          currentKernel = null;
        }
        currentKernel = await bootProfile(h, profileFor(desc.id, "none"), desc, seq);
      } catch (err) {
        currentKernel = null;
        h.detachKernel();
        showBootError(h, desc, err);
      }
    },
  });

  const initialId = normalizeDemoId(opts.demo) ?? (opts.fb === "doom" ? "doom" : "shell");
  currentKernel = await bootProfile(host, profileFor(initialId, opts.fb), descriptorFor(initialId), ++bootSeq);
  return host;
}

function showBootError(
  host: LiveKernelHost,
  descriptor: BootDescriptor,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  host.clearDmesg();
  host.setWebPreview(null);
  host.setDescriptor(descriptor);
  host.setPresentation({
    bootPrimary: "syslog",
    runningPrimary: ["syslog"],
    terminalAccess: "drawer",
    internalsAccess: "drawer",
  });
  host.pushDmesg({
    t: 50,
    level: "err",
    facility: "kandelo",
    msg: `Failed to boot ${descriptor.title || descriptor.id}`,
  });
  host.pushDmesg({
    t: 100,
    level: "err",
    facility: "kandelo",
    msg: message,
  });
  if (descriptor.id.startsWith("kandelo-software-")) {
    host.pushDmesg({
      t: 150,
      level: "warn",
      facility: "kandelo-software",
      msg: "The third-party gallery entry may be temporarily unavailable or its release artifact may have been deleted.",
    });
  }
  host.setStatus("error");
}

function profileFor(id: string, fb?: FbDemo): LiveProfile {
  const software = SOFTWARE_PROFILES.get(id);
  if (software) {
    const desc = descriptorFor(id);
    return {
      id: software.id,
      vfsUrl: software.vfsArchiveUrl,
      software,
      descriptor: desc,
      presentation: software.presentation ?? {
        bootPrimary: "syslog",
        runningPrimary: ["terminal", "syslog"],
        terminalAccess: "primary",
        internalsAccess: "drawer",
      },
      autoCommand: software.autoCommand,
      init: software.init,
    };
  }

  const normalized = normalizeDemoId(id) ?? "shell";
  const desc = descriptorFor(normalized);
  const presentation = presentationFor(normalized);
  const dinit = ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl"];
  switch (normalized) {
    case "node":
      return {
        id: "node",
        vfsUrl: nodeVfsUrl,
        descriptor: desc,
        presentation,
      };
    case "nginx":
      return {
        id: "nginx",
        vfsUrl: nginxVfsUrl,
        descriptor: desc,
        presentation,
        init: {
          argv: dinit,
          env: SERVICE_ENV,
          maxWorkers: 6,
          web: { label: "nginx", requiredPorts: [HTTP_PORT] },
        },
      };
    case "nginx-php":
      return {
        id: "nginx-php",
        vfsUrl: nginxPhpVfsUrl,
        descriptor: desc,
        presentation,
        init: {
          argv: dinit,
          env: SERVICE_ENV,
          maxWorkers: 8,
          web: { label: "nginx + PHP", requiredPorts: [HTTP_PORT] },
        },
      };
    case "wordpress-sqlite":
      return {
        id: "wordpress-sqlite",
        vfsUrl: wordpressVfsUrl,
        descriptor: desc,
        presentation,
        init: {
          argv: dinit,
          env: [...SERVICE_ENV, `WP_APP_PATH=${APP_PATH}`, `WP_PROTO=${PROTO}`],
          maxWorkers: 8,
          maxMemoryPages: 4096,
          web: { label: "WordPress SQLite", requiredPorts: [HTTP_PORT] },
        },
      };
    case "wordpress-mariadb":
      return {
        id: "wordpress-mariadb",
        vfsUrl: lampVfsUrl,
        descriptor: desc,
        presentation,
        init: {
          argv: dinit,
          env: [...SERVICE_ENV, `WP_APP_PATH=${APP_PATH}`, `WP_PROTO=${PROTO}`],
          maxWorkers: 10,
          maxMemoryPages: 4096,
          web: { label: "WordPress MariaDB", requiredPorts: [HTTP_PORT, 3306] },
        },
      };
    case "doom":
      return { id: "doom", vfsUrl: shellVfsUrl, descriptor: desc, presentation, framebuffer: "doom" };
    case "shell":
    default:
      return {
        id: "shell",
        vfsUrl: shellVfsUrl,
        descriptor: desc,
        presentation,
        framebuffer: fb === "test" ? "test" : undefined,
      };
  }
}

async function bootProfile(
  host: LiveKernelHost,
  profile: LiveProfile,
  requestedDescriptor: BootDescriptor,
  seq: number,
): Promise<BrowserKernel> {
  host.clearDmesg();
  host.setWebPreview(null);
  host.setDescriptor({
    ...profile.descriptor,
    title: requestedDescriptor.title || profile.descriptor.title,
    packages: requestedDescriptor.packages.length > 0
      ? requestedDescriptor.packages
      : profile.descriptor.packages,
  });
  host.setPresentation(profile.presentation);
  host.setStatus("booting");

  let t = 0;
  const tick = (msg: string) => {
    host.pushDmesg({ t: (t += 50), level: "info", facility: "kandelo", msg });
  };

  tick(`loading ${profile.id} profile...`);
  const [kernelBytes, vfsBytes, bashBytes, dashBytes, lazyBinaries, softwareBinaries] = await Promise.all([
    fetch(kernelWasmUrl).then(failOn("kernel.wasm")).then((r) => r.arrayBuffer()),
    loadVfsImageBytes(profile),
    fetch(bashWasmUrl).then(failOn("bash.wasm")).then((r) => r.arrayBuffer()),
    fetch(dashWasmUrl).then(failOn("dash.wasm")).then((r) => r.arrayBuffer()),
    loadShellUtilityDefs(profile.id === "node"),
    loadSoftwareBinaries(profile.software),
  ]);

  tick(`kernel: ${kib(kernelBytes.byteLength)} · vfs: ${kib(vfsBytes.byteLength)}`);
  const memfs = MemoryFileSystem.fromImage(new Uint8Array(vfsBytes), {
    maxByteLength: profile.id === "wordpress-mariadb" ? 512 * 1024 * 1024 : 256 * 1024 * 1024,
  });
  memfs.rewriteLazyArchiveUrls((url) => import.meta.env.BASE_URL + url);

  tick("instantiating kernel...");
  const seenPorts = new Set<number>();
  let bridgeSent = false;
  const webReadiness: WebReadinessState = { ready: false, probing: false };
  const kernel = new BrowserKernel({
    memfs,
    maxWorkers: profile.init?.maxWorkers ?? 4,
    maxMemoryPages: profile.init?.maxMemoryPages,
    onStdout: (data) => tick(new TextDecoder().decode(data).trimEnd() || "stdout"),
    onStderr: (data) => tick(new TextDecoder().decode(data).trimEnd() || "stderr"),
    onProcessEvent: (event) => host.emitProcessEvent(event),
    onListenTcp: (_pid, _fd, port) => {
      seenPorts.add(port);
      tick(`service listening on :${port}`);
      maybeMarkWebReady(host, profile, seenPorts, bridgeSent, webReadiness, tick);
    },
  });
  await kernel.init(kernelBytes);

  tick("staging shell utilities...");
  stageShellUtilities(kernel, dashBytes, bashBytes, lazyBinaries);
  stageSoftwareBinaries(kernel, softwareBinaries);
  await registerFbPrograms(kernel);
  host.attachKernel(kernel);
  const shellEnv = profile.software?.shellEnv ?? (profile.id === "node" ? NODE_SHELL_ENV : SHELL_ENV);
  host.setDefaultShell({
    programBytes: bashBytes,
    argv: ["bash", "-l", "-i"],
    env: shellEnv,
    cwd: profile.id === "node" ? "/work" : "/home",
  });

  if (profile.init?.web) {
    tick("initializing HTTP bridge...");
    host.setWebPreview({
      label: profile.init.web.label,
      url: APP_PREFIX,
      status: "starting",
      message: "Waiting for service ports",
    });
    const swBridge = await initServiceWorkerBridge(SW_URL, APP_PREFIX);
    if (!swBridge) {
      host.setWebPreview({
        label: profile.init.web.label,
        url: APP_PREFIX,
        status: "error",
        message: "Service workers unavailable",
      });
    } else {
      kernel.sendBridgePort(swBridge.detachHostPort(), HTTP_PORT);
      bridgeSent = true;
      setupBridgeRestoreListener(kernel, HTTP_PORT, tick);
    }
  }

  if (profile.init) {
    const initBytes = readVfsFile(memfs, profile.init.argv[0]);
    tick(`spawning ${profile.init.argv[0]}...`);
    void kernel.spawn(initBytes, profile.init.argv, {
      env: profile.init.env,
      cwd: profile.init.cwd ?? "/",
    }).then(
      (code) => tick(`${profile.init?.argv[0] ?? "init"} exited with code ${code}`),
      (err) => tick(`init failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  if (profile.framebuffer === "doom") {
    await stageDoomWad(kernel, tick);
  }

  if (seq >= 0) {
    host.setStatus("running");
  }
  maybeMarkWebReady(host, profile, seenPorts, bridgeSent, webReadiness, tick);

  if (profile.framebuffer === "test") {
    void spawnLazy(kernel, "/usr/local/bin/fbtest", ["fbtest"], tick);
  } else if (profile.framebuffer === "doom") {
    tick("starting Doom from bash...");
    void host.runShellCommand(profile.presentation.autoCommand ?? DOOM_COMMAND).catch((err) => {
      tick(`doom command failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  } else if (profile.autoCommand) {
    tick(`running ${profile.autoCommand}...`);
    void host.runShellCommand(profile.autoCommand).catch((err) => {
      tick(`command failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  tick("ready");
  return kernel;
}

function presentationFor(id: LiveDemoId): DemoPresentation {
  switch (id) {
    case "doom":
      return {
        bootPrimary: "syslog",
        runningPrimary: ["framebuffer", "terminal", "syslog"],
        terminalAccess: "drawer",
        internalsAccess: "drawer",
        autoCommand: DOOM_COMMAND,
      };
    case "nginx":
    case "nginx-php":
    case "wordpress-sqlite":
    case "wordpress-mariadb":
      return {
        bootPrimary: "syslog",
        runningPrimary: ["web", "terminal", "syslog"],
        terminalAccess: "drawer",
        internalsAccess: "drawer",
      };
    case "shell":
    case "node":
    default:
      return {
        bootPrimary: "syslog",
        runningPrimary: ["terminal", "syslog"],
        terminalAccess: "primary",
        internalsAccess: "drawer",
      };
  }
}

function stageShellUtilities(
  kernel: BrowserKernel,
  dashBytes: ArrayBuffer,
  bashBytes: ArrayBuffer,
  lazyBinaries: BinaryDef[],
): void {
  ensureDirRecursive(kernel.fs, "/home");
  ensureDirRecursive(kernel.fs, "/bin");
  ensureDirRecursive(kernel.fs, "/usr/bin");
  populateShellBinaries(kernel, dashBytes, lazyBinaries);
  writeVfsBinary(kernel.fs, "/bin/bash", new Uint8Array(bashBytes), 0o755);
  try { kernel.fs.symlink("/bin/bash", "/usr/bin/bash"); } catch { /* exists */ }
}

async function loadVfsImageBytes(profile: LiveProfile): Promise<ArrayBuffer> {
  if (!profile.software) {
    return fetch(profile.vfsUrl).then(failOn(`${profile.id}.vfs.zst`)).then((r) => r.arrayBuffer());
  }
  const vfsImage = await loadArchiveArtifact(
    profile.software.vfsArchiveUrl,
    profile.software.vfsArtifactPath,
  );
  return vfsImage.buffer.slice(
    vfsImage.byteOffset,
    vfsImage.byteOffset + vfsImage.byteLength,
  );
}

async function loadSoftwareBinaries(
  software: SoftwareProfile | undefined,
): Promise<Array<{ spec: SoftwareBinary; bytes: Uint8Array }>> {
  if (!software) return [];
  return Promise.all(software.binaries.map(async (spec) => ({
    spec,
    bytes: await loadArchiveArtifact(spec.archiveUrl, spec.artifactPath),
  })));
}

function stageSoftwareBinaries(
  kernel: BrowserKernel,
  binaries: Array<{ spec: SoftwareBinary; bytes: Uint8Array }>,
): void {
  for (const { spec, bytes } of binaries) {
    ensureDirRecursive(kernel.fs, dirname(spec.installPath));
    writeVfsBinary(kernel.fs, spec.installPath, bytes, 0o755);
    for (const symlinkPath of spec.symlinks ?? []) {
      ensureDirRecursive(kernel.fs, dirname(symlinkPath));
      try { kernel.fs.symlink(spec.installPath, symlinkPath); } catch { /* exists */ }
    }
  }
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

async function loadArchiveArtifact(archiveUrl: string, artifactPath: string): Promise<Uint8Array> {
  const archiveBytes = await fetchBytesWithDevProxy(archiveUrl);
  const tarBytes = decompressZstd(archiveBytes);
  const artifact = extractTarFile(tarBytes, artifactPath);
  if (!artifact) {
    throw new Error(`${artifactPath} not found in ${archiveUrl}`);
  }
  return artifact;
}

function extractTarFile(tarBytes: Uint8Array, wantedPath: string): Uint8Array | undefined {
  for (let offset = 0; offset + 512 <= tarBytes.length;) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return undefined;

    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarString(header, 124, 12).trim();
    const size = parseInt(sizeText || "0", 8);
    if (!Number.isFinite(size)) {
      throw new Error(`Invalid tar size for ${path}`);
    }

    offset += 512;
    if (path === wantedPath) {
      return tarBytes.slice(offset, offset + size);
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return undefined;
}

function tarString(block: Uint8Array, offset: number, length: number): string {
  return tarDecoder.decode(block.subarray(offset, offset + length)).replace(/\0.*$/, "");
}

async function loadShellUtilityDefs(includeNode: boolean): Promise<BinaryDef[]> {
  const defs: Array<Omit<BinaryDef, "size">> = [
    ...(includeNode ? [{
      url: nodeWasmUrl,
      path: "/usr/bin/node",
      symlinks: ["/bin/node", "/usr/local/bin/node"],
    }] : []),
    { url: coreutilsWasmUrl, path: "/bin/coreutils", symlinks: [...COREUTILS_NAMES, "["].flatMap((n) => [`/bin/${n}`, `/usr/bin/${n}`]) },
    { url: grepWasmUrl, path: "/usr/bin/grep", symlinks: ["/bin/grep", "/usr/bin/egrep", "/bin/egrep", "/usr/bin/fgrep", "/bin/fgrep"] },
    { url: sedWasmUrl, path: "/usr/bin/sed", symlinks: ["/bin/sed"] },
    { url: bcWasmUrl, path: "/usr/bin/bc", symlinks: ["/bin/bc"] },
    { url: fileWasmUrl, path: "/usr/bin/file", symlinks: ["/bin/file"] },
    { url: lessWasmUrl, path: "/usr/bin/less", symlinks: ["/bin/less"] },
    { url: m4WasmUrl, path: "/usr/bin/m4", symlinks: ["/bin/m4"] },
    { url: makeWasmUrl, path: "/usr/bin/make", symlinks: ["/bin/make"] },
    { url: tarWasmUrl, path: "/usr/bin/tar", symlinks: ["/bin/tar"] },
    { url: curlWasmUrl, path: "/usr/bin/curl", symlinks: ["/bin/curl"] },
    { url: wgetWasmUrl, path: "/usr/bin/wget", symlinks: ["/bin/wget"] },
    { url: gitWasmUrl, path: "/usr/bin/git", symlinks: ["/bin/git"] },
    { url: gitRemoteHttpWasmUrl, path: "/usr/bin/git-remote-http", symlinks: ["/usr/bin/git-remote-https", "/usr/bin/git-remote-ftp", "/usr/bin/git-remote-ftps"] },
    { url: gzipWasmUrl, path: "/usr/bin/gzip", symlinks: ["/bin/gzip", "/usr/bin/gunzip", "/bin/gunzip", "/usr/bin/zcat", "/bin/zcat"] },
    { url: bzip2WasmUrl, path: "/usr/bin/bzip2", symlinks: ["/bin/bzip2", "/usr/bin/bunzip2", "/bin/bunzip2", "/usr/bin/bzcat", "/bin/bzcat"] },
    { url: xzWasmUrl, path: "/usr/bin/xz", symlinks: ["/bin/xz", "/usr/bin/unxz", "/bin/unxz", "/usr/bin/xzcat", "/bin/xzcat", "/usr/bin/lzma", "/bin/lzma", "/usr/bin/unlzma", "/bin/unlzma", "/usr/bin/lzcat", "/bin/lzcat"] },
    { url: zstdWasmUrl, path: "/usr/bin/zstd", symlinks: ["/bin/zstd", "/usr/bin/unzstd", "/bin/unzstd", "/usr/bin/zstdcat", "/bin/zstdcat"] },
    { url: zipWasmUrl, path: "/usr/bin/zip", symlinks: ["/bin/zip"] },
    { url: unzipWasmUrl, path: "/usr/bin/unzip", symlinks: ["/bin/unzip", "/usr/bin/zipinfo", "/bin/zipinfo", "/usr/bin/funzip", "/bin/funzip"] },
    { url: lsofWasmUrl, path: "/usr/bin/lsof", symlinks: ["/bin/lsof"] },
    { url: nanoWasmUrl, path: "/usr/bin/nano", symlinks: ["/bin/nano"] },
  ];
  const sizes = await Promise.all(defs.map((d) => fetchSize(d.url)));
  return defs
    .map((d, i) => ({ ...d, size: sizes[i] }))
    .filter((d) => d.size > 0);
}

async function registerFbPrograms(kernel: BrowserKernel): Promise<void> {
  const probes = [
    { path: "/usr/local/bin/fbdoom", url: fbdoomWasmUrl },
    { path: "/usr/local/bin/fbtest", url: fbtestWasmUrl },
  ];
  ensureDirRecursive(kernel.fs, "/usr/local/bin");
  const sizes = await Promise.all(probes.map((p) => fetchSize(p.url)));
  const entries = probes
    .map((p, i) => ({ ...p, size: sizes[i], mode: 0o755 }))
    .filter((e) => e.size > 0);
  if (entries.length > 0) kernel.registerLazyFiles(entries);
}

async function stageDoomWad(kernel: BrowserKernel, tick: (msg: string) => void): Promise<void> {
  tick("staging /doom1.wad...");
  try {
    const url = import.meta.env.DEV
      ? `/cors-proxy?url=${encodeURIComponent(DOOM_WAD_URL)}`
      : DOOM_WAD_URL;
    const wadBytes = await fetch(url).then(failOn("doom1.wad")).then((r) => r.arrayBuffer());
    writeVfsBinary(kernel.fs, "/doom1.wad", new Uint8Array(wadBytes), 0o644);
  } catch (err) {
    tick(`doom1.wad stage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function spawnLazy(
  kernel: BrowserKernel,
  path: string,
  argv: string[],
  tick: (msg: string) => void,
): Promise<void> {
  const fetchUrl = path === "/usr/local/bin/fbdoom" ? fbdoomWasmUrl
    : path === "/usr/local/bin/fbtest" ? fbtestWasmUrl
    : "";
  if (!fetchUrl) return;
  try {
    tick(`fetching ${argv[0]}...`);
    const bytes = await fetch(fetchUrl).then(failOn(argv[0])).then((r) => r.arrayBuffer());
    tick(`spawning ${argv[0]}...`);
    await kernel.spawn(bytes, argv, { env: SHELL_ENV });
    tick(`${argv[0]} exited`);
  } catch (err) {
    tick(`${argv[0]} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function maybeMarkWebReady(
  host: LiveKernelHost,
  profile: LiveProfile,
  seenPorts: Set<number>,
  bridgeSent: boolean,
  readiness: WebReadinessState,
  tick: (msg: string) => void,
): void {
  const web = profile.init?.web;
  if (!web) return;
  const portsReady = web.requiredPorts.every((p) => seenPorts.has(p));
  if (!portsReady || !bridgeSent) return;
  if (readiness.ready) {
    host.setWebPreview({
      label: web.label,
      url: APP_PREFIX,
      status: "running",
      message: "HTTP bridge ready",
    });
    return;
  }
  if (readiness.probing) return;
  readiness.probing = true;
  host.setWebPreview({
    label: web.label,
    url: APP_PREFIX,
    status: "starting",
    message: "Waiting for HTTP response",
  });
  void waitForHttpPreview(APP_PREFIX).then(
    () => {
      readiness.ready = true;
      host.setWebPreview({
        label: web.label,
        url: APP_PREFIX,
        status: "running",
        message: "HTTP bridge ready",
      });
      tick("HTTP preview ready");
    },
    (err) => {
      const message = err instanceof Error ? err.message : String(err);
      host.setWebPreview({
        label: web.label,
        url: APP_PREFIX,
        status: "error",
        message: "HTTP preview did not become ready",
      });
      tick(`HTTP preview readiness failed: ${message}`);
    },
  ).finally(() => {
    readiness.probing = false;
  });
}

async function waitForHttpPreview(url: string, timeoutMs = 90_000): Promise<void> {
  const started = performance.now();
  let delayMs = 250;
  let lastError = "";

  while (performance.now() - started < timeoutMs) {
    try {
      const response = await fetchWithTimeout(url, 5_000);
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(delayMs);
    delayMs = Math.min(1_500, Math.floor(delayMs * 1.4));
  }

  throw new Error(lastError || "timed out");
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function setupBridgeRestoreListener(
  kernel: BrowserKernel,
  httpPort: number,
  tick: (msg: string) => void,
): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "need-bridge") return;
    const replyPort = event.ports[0];
    if (!replyPort) return;
    const bridge = new HttpBridgeHost();
    replyPort.postMessage(
      { type: "bridge-restored", appPrefix: APP_PREFIX },
      [bridge.getSwPort()],
    );
    kernel.sendBridgePort(bridge.detachHostPort(), httpPort);
    tick("HTTP bridge restored");
  });
}

function descriptorFor(id: LiveDemoId): BootDescriptor {
  const item = SOFTWARE_PROFILES.has(id)
    ? liveGalleryItems().find((p) => p.id === "shell")!
    : liveGalleryItems().find((p) => p.id === id) ?? liveGalleryItems()[0];
  const software = SOFTWARE_PROFILES.get(id);
  return {
    version: 1,
    id: software?.id ?? item.id,
    title: software ? software.id.replace(/^kandelo-software-/, "") : item.title,
    base: software ? "kandelo:shell@abi11" : item.base,
    runtime: {
      arch: "wasm32",
      kernel: "kernel@local",
      memoryPages: id === "wordpress-mariadb" || id === "node" || software ? 4096 : 2048,
      features: ["shared-array-buffer", "pty", ...(item.id === "doom" ? ["framebuffer"] : []), ...(item.id === "shell" || item.id === "doom" || software ? [] : ["tcp-bridge"])],
      time: "real",
    },
    packages: software ? [] : item.packages,
    mounts: [
      { path: "/", source: "image", ref: `${software?.id ?? item.id}.vfs@local`, readonly: false },
      { path: "/tmp", source: "scratch", ephemeral: true },
    ],
    boot: {
      argv: software ? ["bash", "-l", "-i"] : item.bootCommand,
      cwd: item.id === "node" ? "/work" : "/home",
      env: Object.fromEntries((software?.shellEnv ?? (item.id === "node" ? NODE_SHELL_ENV : SHELL_ENV)).map((kv) => {
        const idx = kv.indexOf("=");
        return [kv.slice(0, idx), kv.slice(idx + 1)];
      })),
    },
    caps: { network: item.id !== "shell" && item.id !== "doom" && !software },
  };
}

function liveGalleryItems(): GalleryItem[] {
  return PRESET_LIBRARY.map((p) => ({
    id: p.id,
    title: p.title,
    summary: p.summary,
    base: p.base,
    packages: p.packages,
    bootCommand: p.bootCommand,
    accent: p.accent,
    glyph: p.glyph,
    estimatedUrlBytes: p.estimatedUrlBytes,
  }));
}

async function loadLiveGalleryItems(): Promise<GalleryItem[]> {
  const localItems = liveGalleryItems();
  try {
    return [...localItems, ...await loadKandeloSoftwareGalleryItems()];
  } catch (err) {
    console.warn("Could not load kandelo-software gallery entries:", err);
    return localItems;
  }
}

async function loadKandeloSoftwareGalleryItems(): Promise<GalleryItem[]> {
  const manifestText = await fetchTextWithDevProxy(KANDELO_SOFTWARE_MANIFEST_URL);
  const manifest = JSON.parse(manifestText) as SoftwareGalleryManifest;
  const indexUrl = manifest.index_url
    ? new URL(manifest.index_url, KANDELO_SOFTWARE_MANIFEST_URL).href
    : DEFAULT_KANDELO_SOFTWARE_INDEX_URL;
  const index = parseIndexToml(await fetchTextWithDevProxy(indexUrl));
  return manifest.entries
    .filter((entry) => entry.packages.every((pkg) => packageAvailable(index, pkg)))
    .map((entry) => softwareEntryToGalleryItem(entry, index, indexUrl));
}

function softwareEntryToGalleryItem(
  entry: SoftwareGalleryEntry,
  index: Map<string, IndexPackageEntry>,
  indexUrl: string,
): GalleryItem {
  const primaryPackage = entry.packages[entry.packages.length - 1];
  const archiveUrl = archiveUrlFor(index, indexUrl, primaryPackage);
  const id = `kandelo-software-${entry.id}`;
  if (archiveUrl) {
    SOFTWARE_PROFILES.set(id, softwareProfileForEntry(id, entry, index, indexUrl, archiveUrl));
  }
  return {
    id,
    title: entry.title,
    summary: archiveUrl
      ? `${entry.description} Archive: ${archiveUrl}`
      : entry.description,
    base: "kandelo:shell@abi11",
    packages: entry.packages.map(packageKey),
    bootCommand: ["bash", "-l", "-i"],
    accent: accentForSoftwareEntry(entry.id),
    glyph: glyphForSoftwareEntry(entry),
    estimatedUrlBytes: JSON.stringify(entry).length,
    author: "kandelo-software",
  };
}

function softwareProfileForEntry(
  id: string,
  entry: SoftwareGalleryEntry,
  index: Map<string, IndexPackageEntry>,
  indexUrl: string,
  vfsArchiveUrl: string,
): SoftwareProfile {
  const primaryPackage = entry.packages[entry.packages.length - 1];
  const runtimePackage = entry.packages[0];
  const runtimeArchiveUrl = archiveUrlFor(index, indexUrl, runtimePackage);
  const vfsArtifactPath = `artifacts/${primaryPackage.name}.vfs.zst`;

  const base: SoftwareProfile = {
    id,
    vfsArchiveUrl,
    vfsArtifactPath,
    binaries: [],
    shellEnv: SHELL_ENV,
  };

  if (entry.id.includes("python") && runtimeArchiveUrl) {
    return {
      ...base,
      binaries: [{
        archiveUrl: runtimeArchiveUrl,
        artifactPath: "artifacts/python.wasm",
        installPath: "/usr/bin/python",
        symlinks: ["/usr/bin/python3", "/usr/local/bin/python", "/usr/local/bin/python3"],
      }],
      shellEnv: [
        ...SHELL_ENV,
        "PYTHONHOME=/usr",
        "PYTHONDONTWRITEBYTECODE=1",
        "PYTHONNOUSERSITE=1",
      ],
      autoCommand: "python3 -c \"import sys, json; print('Python', sys.version.split()[0]); print(json.dumps({'kandelo': 'software'}))\"",
    };
  }

  if (entry.id.includes("perl") && runtimeArchiveUrl) {
    return {
      ...base,
      binaries: [{
        archiveUrl: runtimeArchiveUrl,
        artifactPath: "artifacts/perl.wasm",
        installPath: "/usr/bin/perl",
        symlinks: ["/usr/local/bin/perl"],
      }],
      shellEnv: [...SHELL_ENV, "PERL5LIB=/usr/lib/perl5"],
      autoCommand: "perl -e 'print \"Perl $^V from kandelo-software\\n\"'",
    };
  }

  if (entry.id.includes("erlang") && runtimeArchiveUrl) {
    return {
      ...base,
      binaries: [{
        archiveUrl: runtimeArchiveUrl,
        artifactPath: "artifacts/erlang.wasm",
        installPath: "/usr/bin/erlang",
        symlinks: ["/usr/bin/erl", "/usr/local/bin/erl"],
      }],
      shellEnv: [
        ...SHELL_ENV,
        "ROOTDIR=/usr/local/lib/erlang",
        "BINDIR=/usr/local/lib/erlang/erts-16.1.2/bin",
        "EMU=beam",
        "PROGNAME=erl",
      ],
      autoCommand: [
        "erlang",
        "-S 1:1 -A 0 -SDio 1 -SDcpu 1:1 -P 262144 --",
        "-root /usr/local/lib/erlang",
        "-bindir /usr/local/lib/erlang/erts-16.1.2/bin",
        "-progname erl -home /tmp -start_epmd false",
        "-boot /usr/local/lib/erlang/releases/28/start_clean",
        "-noshell -eval 'io:format(\"Erlang/OTP from kandelo-software~n\"), halt().'",
      ].join(" "),
    };
  }

  if (entry.id.includes("redis")) {
    return {
      ...base,
      shellEnv: SERVICE_ENV,
      init: {
        argv: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl"],
        env: SERVICE_ENV,
        maxWorkers: 6,
      },
      presentation: {
        bootPrimary: "syslog",
        runningPrimary: ["terminal", "syslog"],
        terminalAccess: "primary",
        internalsAccess: "drawer",
      },
      autoCommand: "echo 'Redis VFS from kandelo-software'; ls -l /usr/local/bin/redis-server /etc/dinit.d/redis",
    };
  }

  return base;
}

function packageKey(pkg: GalleryPackageRequirement): string {
  return `${pkg.name}@${pkg.version}`;
}

function packageAvailable(
  index: Map<string, IndexPackageEntry>,
  requirement: GalleryPackageRequirement,
): boolean {
  const entry = index.get(packageKey(requirement));
  return entry?.binary.wasm32?.status === "success";
}

function archiveUrlFor(
  index: Map<string, IndexPackageEntry>,
  indexUrl: string,
  requirement: GalleryPackageRequirement | undefined,
): string | undefined {
  if (!requirement) return undefined;
  const archiveUrl = index.get(packageKey(requirement))?.binary.wasm32?.archive_url;
  if (!archiveUrl) return undefined;
  return new URL(archiveUrl, indexUrl).href;
}

function stripTomlComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") {
      inString = !inString;
    } else if (ch === "#" && !inString) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseTomlValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseIndexToml(text: string): Map<string, IndexPackageEntry> {
  const packages = new Map<string, IndexPackageEntry>();
  let currentPackage: IndexPackageEntry | undefined;
  let currentBinary: IndexBinaryEntry | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    if (line === "[[packages]]") {
      currentPackage = { binary: {} };
      currentBinary = undefined;
      continue;
    }

    const binaryMatch = line.match(/^\[packages\.binary\.([A-Za-z0-9_-]+)\]$/);
    if (binaryMatch && currentPackage) {
      currentBinary = {};
      currentPackage.binary[binaryMatch[1]] = currentBinary;
      continue;
    }

    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment || !currentPackage) continue;

    const [, key, rawValue] = assignment;
    const value = parseTomlValue(rawValue);
    if (currentBinary) {
      currentBinary[key as keyof IndexBinaryEntry] = value;
    } else if (key === "name" || key === "version") {
      currentPackage[key] = value;
      if (currentPackage.name && currentPackage.version) {
        packages.set(`${currentPackage.name}@${currentPackage.version}`, currentPackage);
      }
    }
  }

  return packages;
}

async function fetchTextWithDevProxy(url: string): Promise<string> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  } catch (error) {
    const isDevHost =
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1" ||
      location.hostname === "[::1]";
    if (!isDevHost) throw error;

    const response = await fetch(`/cors-proxy?url=${encodeURIComponent(url)}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  }
}

async function fetchBytesWithDevProxy(url: string): Promise<Uint8Array> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    const isDevHost =
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1" ||
      location.hostname === "[::1]";
    if (!isDevHost) throw error;

    const response = await fetch(`/cors-proxy?url=${encodeURIComponent(url)}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

function accentForSoftwareEntry(id: string): string {
  if (id.includes("python")) return "#3776ab";
  if (id.includes("perl")) return "#6c6aa8";
  if (id.includes("erlang")) return "#a90533";
  if (id.includes("redis")) return "#c52f24";
  return "#2f6f73";
}

function glyphForSoftwareEntry(entry: SoftwareGalleryEntry): string {
  const packageName = entry.packages[entry.packages.length - 1]?.name ?? entry.id;
  const parts = packageName.split(/[-_]/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toLowerCase();
  return packageName.slice(0, 3).toLowerCase();
}

function normalizeDemoId(id: string | null | undefined): LiveDemoId | null {
  switch (id) {
    case "shell":
    case "node":
    case "nginx":
    case "nginx-php":
    case "wordpress-sqlite":
    case "wordpress-mariadb":
    case "doom":
      return id;
    case "wordpress":
      return "wordpress-sqlite";
    case "lamp":
      return "wordpress-mariadb";
    default:
      return null;
  }
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

async function fetchSize(url: string): Promise<number> {
  try {
    const resp = await fetch(url, { method: "HEAD" });
    if (!resp.ok) return 0;
    return Number(resp.headers.get("content-length") ?? 0) || 0;
  } catch {
    return 0;
  }
}

function failOn(label: string): (r: Response) => Response {
  return (r) => {
    if (!r.ok) throw new Error(`fetch failed for ${label}: ${r.status} ${r.statusText}`);
    return r;
  };
}

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KiB`;
}
