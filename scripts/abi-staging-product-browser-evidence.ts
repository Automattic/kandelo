import { createServer, type ServerResponse } from "node:http";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

import { createClosedLazyAssetSourceFetcher } from "../host/src/vfs/closed-lazy-assets.ts";

import type { ProtectedCandidateVfsSource } from "../apps/browser-demos/pages/kandelo/kernel-host/candidate-evidence-vfs.ts";
import {
  canonicalJsonBytes,
  candidateLazyAssetSources,
  evidenceDefinitionSha256,
  expectedLazyInputIds,
  exactRuntimeDevShellLockSha256,
  sha256Hex,
  terminalProductEvidenceResult,
  validateCandidateLocator,
  validateCandidateProductInputDocuments,
  validateCandidateVfsLazyInventory,
  validateExactRuntimeArtifactRoot,
  validateProductEvidenceResult,
  runtimeIdentityFromBundle,
  type CandidateLazyRequirementV1,
  type CandidateProductLocatorV1,
  type ExactRuntimeArtifactRootV1,
  type GeneratedEvidenceDefinitionRegistryV1,
  type GeneratedEvidenceDefinitionV1,
  type ProtectedVfsProductCatalogV1,
  type ProductEvidenceResultV1,
  type ProductEvidenceRunV1,
  type RuntimeEvidenceIdentityV1,
  type VfsBootContractV1,
  type VfsMountIntentV1,
} from "./abi-staging-product-node-evidence.ts";

const SHA256 = /^[0-9a-f]{64}$/u;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const MAX_BROWSER_VFS_BYTES = 256 * 1024 * 1024;
const MAX_BROWSER_STATIC_FILE_BYTES = 256 * 1024 * 1024;
const MAX_BROWSER_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_BROWSER_RUNTIME_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_PLAYWRIGHT_OUTPUT_BYTES = 64 * 1024;
const MAX_BROWSER_SERVER_REQUESTS = 4_096;
const MAX_BROWSER_SERVER_CONCURRENCY = 8;

export type BrowserEvidenceSurface =
  | "shell"
  | "toolchain-shell"
  | "c-development"
  | "doom"
  | "modeset"
  | "node"
  | "nginx"
  | "nginx-php"
  | "wordpress-sqlite"
  | "wordpress-mariadb"
  | "generic-exec"
  | "mariadb"
  | "redis"
  | "mariadb-suite"
  | "php-suite"
  | "sqlite-suite";

export interface BrowserEvidenceSelectionInputV1 {
  candidateReference: string;
  referenceClass?: "candidate" | "canonical";
  definitionId: string;
  definitions: unknown;
  pages: unknown;
  productId: string;
  products: unknown;
  servedVfs: {
    bytes: number;
    sha256: string;
    sourceKind: "protected-local-candidate-vfs";
    url: string;
  };
  servedLazyAssets: ProtectedBrowserEvidenceLazySelectionV1[];
  servedBrowserHarness: ProtectedBrowserEvidenceKernelSelectionV1;
  servedBrowserHost: ProtectedBrowserEvidenceKernelSelectionV1;
  servedKernelAsset: ProtectedBrowserEvidenceKernelSelectionV1;
  targetAbi: number;
  tests: unknown;
}

export interface ProtectedBrowserEvidenceLazySelectionV1 {
  id: string;
  reference: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface ProtectedBrowserEvidenceKernelSelectionV1 {
  url: string;
  sha256: string;
  bytes: number;
}

export interface BrowserEvidenceSelectionV1 {
  schema: 1;
  kind: "kandelo-protected-browser-evidence-selection";
  host: "browser";
  productId: string;
  definitionId: string;
  definitionSha256: string;
  runner: string;
  surface: BrowserEvidenceSurface;
  pagesLoad: "eager" | "lazy" | null;
  candidateReference: string;
  vfs: ProtectedCandidateVfsSource;
  manifestSha256: string;
  boot: VfsBootContractV1;
  mounts: VfsMountIntentV1[];
  lazyAssets: ProtectedBrowserEvidenceLazySelectionV1[];
  browserHarness: ProtectedBrowserEvidenceKernelSelectionV1;
  browserHost: ProtectedBrowserEvidenceKernelSelectionV1;
  kernelAsset: ProtectedBrowserEvidenceKernelSelectionV1;
}

export interface BrowserEvidenceContextV1 {
  schema: 1;
  kind: "kandelo-vfs-product-browser-evidence-context";
  request_digest: string;
  product: { id: string; manifest_sha256: string };
  candidate_product: {
    manifest_digest: string;
    vfs_layer_sha256: string;
    vfs_layer_bytes: number;
    builder_report_sha256: string;
  };
  runtime: RuntimeEvidenceIdentityV1;
  host: "browser";
  definition: GeneratedEvidenceDefinitionV1;
  boot: VfsBootContractV1;
  mounts: VfsMountIntentV1[];
  run: ProductEvidenceRunV1;
}

export interface BrowserEvidenceSessionV1 {
  context: BrowserEvidenceContextV1;
  selection: BrowserEvidenceSelectionV1;
}

export interface BrowserEvidenceObservationV1 {
  stdout: string;
  stderr: string;
}

export interface BrowserEvidenceExecutor {
  execute(
    session: BrowserEvidenceSessionV1,
  ): Promise<BrowserEvidenceObservationV1>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export interface BrowserEvidenceRunnerDependencies {
  runWithTimeout?<T>(operation: Promise<T>, timeoutMilliseconds: number): Promise<T>;
  cleanupTimeoutMilliseconds?: number;
}

export class BrowserEvidenceTimeoutError extends Error {}

const DEFAULT_CLEANUP_TIMEOUT_MILLISECONDS = 1_000;
const MAX_CLEANUP_TIMEOUT_MILLISECONDS = 5_000;

export interface ProtectedBrowserEvidenceAssetV1 {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ProtectedBrowserEvidenceLazyAssetV1
  extends Omit<ProtectedBrowserEvidenceAssetV1, "path"> {
  reference: string;
  path?: string;
  sourceUrl?: string;
}

export interface ProtectedBrowserEvidenceServerOptions {
  distRoot: string;
  /** Freshly rebuilt protected policy files; never served from candidate output. */
  protectedHarnessRoot?: string;
  runtimeBytes: number;
  productId: string;
  vfs: ProtectedBrowserEvidenceAssetV1;
  lazyAssets: ProtectedBrowserEvidenceLazyAssetV1[];
  vfsGetLimit?: 1 | 2;
  lazyGetLimit?: 1 | 2;
  onLazyAssetRead?: (reference: string) => void;
}

export interface ProtectedBrowserEvidenceServer {
  baseUrl: string;
  close(): Promise<void>;
}

export interface ProtectedBrowserEvidenceServerDependencies {
  createLazyFetcher?: typeof createClosedLazyAssetSourceFetcher;
}

export async function startProtectedBrowserEvidenceServer(
  options: ProtectedBrowserEvidenceServerOptions,
  dependencies: ProtectedBrowserEvidenceServerDependencies = {},
): Promise<ProtectedBrowserEvidenceServer> {
  const productId = stableId(options.productId, "browser server product");
  const vfsGetLimit = protectedPhaseLimit(
    options.vfsGetLimit,
    "candidate VFS GET limit",
  );
  const lazyGetLimit = protectedPhaseLimit(
    options.lazyGetLimit,
    "candidate lazy GET limit",
  );
  const runtimeBytes = positiveInteger(
    options.runtimeBytes,
    "browser server runtime bytes",
  );
  const distRoot = resolve(await realpath(options.distRoot));
  const distStat = await lstat(distRoot);
  if (!distStat.isDirectory() || distStat.isSymbolicLink()) {
    throw new Error("browser runtime dist root is not a real directory");
  }
  const protectedHarnessRoot = options.protectedHarnessRoot === undefined
    ? undefined
    : resolve(await realpath(options.protectedHarnessRoot));
  if (protectedHarnessRoot !== undefined) {
    const harnessStat = await lstat(protectedHarnessRoot);
    if (!harnessStat.isDirectory() || harnessStat.isSymbolicLink()) {
      throw new Error("protected browser harness root is not a real directory");
    }
  }
  const vfs = checkedServerAsset(options.vfs, "candidate VFS");
  const lazyAssets = new Map<string, ProtectedBrowserEvidenceLazyAssetV1>();
  for (const [index, value] of options.lazyAssets.entries()) {
    const identity = checkedLazyServerAsset(value, `candidate lazy asset ${index}`);
    const asset = {
      ...identity,
      reference: text(
        value.reference,
        `candidate lazy asset ${index} reference`,
        8_192,
      ),
    };
    const route = protectedLazyAssetPath(asset.reference);
    if (lazyAssets.has(route)) {
      throw new Error("candidate lazy asset protected routes are duplicated");
    }
    lazyAssets.set(route, asset);
  }
  const fetchLazySource = (dependencies.createLazyFetcher ??
    createClosedLazyAssetSourceFetcher)(
    Array.from(lazyAssets.values())
      .filter((asset) => asset.sourceUrl !== undefined)
      .map((asset) => ({
        url: asset.reference,
        sourceUrl: asset.sourceUrl!,
        sha256: asset.sha256,
        size: asset.bytes,
      })),
  );
  const lazyFetchController = new AbortController();
  const maximumServedBytes = vfs.bytes * vfsGetLimit +
    Array.from(lazyAssets.values()).reduce(
      (total, asset) => total + asset.bytes * lazyGetLimit,
      0,
    ) +
    runtimeBytes * 2;
  if (!Number.isSafeInteger(maximumServedBytes)) {
    throw new Error("protected browser server byte budget is outside its bound");
  }
  let servedBytes = 0;
  let requestCount = 0;
  let concurrentRequests = 0;
  let vfsGetsStarted = 0;
  const lazyGetsStarted = new Map<string, number>();
  const runtimeGetCounts = new Map<string, number>();
  const reserveBytes = (bytes: number, method: string | undefined): void => {
    if (method === "HEAD") return;
    if (bytes > maximumServedBytes - servedBytes) {
      throw new Error("protected browser server exceeded its aggregate byte budget");
    }
    servedBytes += bytes;
  };

  let protectedAuthority: string | undefined;
  const server = createServer((request, response) => {
    requestCount += 1;
    if (
      requestCount > MAX_BROWSER_SERVER_REQUESTS ||
      concurrentRequests >= MAX_BROWSER_SERVER_CONCURRENCY
    ) {
      sendText(response, 429, "protected browser request budget exceeded\n");
      return;
    }
    concurrentRequests += 1;
    void (async () => {
      if (
        protectedAuthority === undefined ||
        request.headers.host !== protectedAuthority
      ) {
        sendText(response, 403, "undeclared browser network origin\n");
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendText(response, 405, "method not allowed\n");
        return;
      }
      const protectedOrigin = `http://${protectedAuthority}`;
      const url = new URL(request.url ?? "/", protectedOrigin);
      if (url.origin !== protectedOrigin) {
        sendText(response, 403, "undeclared browser network origin\n");
        return;
      }
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes("\\") || pathname.includes("\0")) {
        sendText(response, 404, "not found\n");
        return;
      }
      const vfsPath = `/__abi_staging/${productId}/product.vfs.zst`;
      if (pathname === vfsPath) {
        if (request.method === "GET") {
          if (vfsGetsStarted >= vfsGetLimit) {
            throw new Error("candidate VFS exceeded its protected phase limit");
          }
          vfsGetsStarted += 1;
        }
        await sendExactAsset(
          response,
          vfs,
          "application/zstd",
          request.method,
          reserveBytes,
        );
        return;
      }
      const lazy = lazyAssets.get(`${pathname}${url.search}`);
      if (lazy !== undefined) {
        if (request.method === "GET") {
          const count = lazyGetsStarted.get(lazy.reference) ?? 0;
          if (count >= lazyGetLimit) {
            throw new Error("candidate lazy asset exceeded its protected phase limit");
          }
          lazyGetsStarted.set(lazy.reference, count + 1);
          options.onLazyAssetRead?.(lazy.reference);
        }
        const asset = lazy;
        if (asset.path !== undefined) {
          await sendExactAsset(
            response,
            { path: asset.path, bytes: asset.bytes, sha256: asset.sha256 },
            "application/octet-stream",
            request.method,
            reserveBytes,
          );
        } else if (request.method === "HEAD") {
          sendHeaders(response, 200, "application/octet-stream", asset.bytes);
          response.end();
        } else {
          reserveBytes(asset.bytes, request.method);
          const loaded = new Uint8Array(
            await (await fetchLazySource(asset.reference, {
              signal: lazyFetchController.signal,
            })).arrayBuffer(),
          );
          sendHeaders(response, 200, "application/octet-stream", loaded.byteLength);
          response.end(loaded);
        }
        return;
      }
      if (
        pathname === "/abi-staging-harness" ||
        pathname.startsWith("/abi-staging-harness/")
      ) {
        if (protectedHarnessRoot === undefined) {
          sendText(response, 404, "protected browser harness is unavailable\n");
          return;
        }
        const harnessPath = pathname.slice("/abi-staging-harness".length) || "/";
        await sendRuntimeFile(
          response,
          protectedHarnessRoot,
          harnessPath,
          request.method,
          reserveBytes,
        );
        return;
      }
      if (request.method === "GET") {
        const count = runtimeGetCounts.get(pathname) ?? 0;
        if (count >= 2) throw new Error("browser runtime file was requested too many times");
        runtimeGetCounts.set(pathname, count + 1);
      }
      await sendRuntimeFile(
        response,
        distRoot,
        pathname,
        request.method,
        reserveBytes,
      );
    })().catch((error) => {
      if (!response.headersSent) {
        sendText(response, 500, "protected browser evidence server failed\n");
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    }).finally(() => {
      concurrentRequests -= 1;
    });
  });
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    lazyFetchController.abort();
    server.close();
    throw new Error("protected browser evidence server lacks a TCP address");
  }
  protectedAuthority = `127.0.0.1:${address.port}`;
  let closePromise: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: () => {
      closePromise ??= new Promise<void>((resolveClose, rejectClose) => {
        lazyFetchController.abort(
          new Error("protected browser evidence server is closing"),
        );
        server.close((error) =>
          error === undefined ? resolveClose() : rejectClose(error)
        );
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}

export interface VerifiedProtectedBrowserHarnessV1 {
  root: string;
  entry: { bytes: number; sha256: string };
}

/**
 * Rebuild policy-owned browser code from the protected checkout and compare
 * every emitted byte with the inert copy carried by the candidate runtime.
 * Production orchestration runs this in a fresh protected job after candidate
 * preparation, so candidate build code never chooses the judging harness.
 */
export async function prepareVerifiedProtectedBrowserHarness(options: {
  deadlineAt: number;
  runtimeRoot: string;
  workRoot: string;
}): Promise<VerifiedProtectedBrowserHarnessV1> {
  if (!Number.isSafeInteger(options.deadlineAt) || options.deadlineAt <= Date.now()) {
    throw new BrowserEvidenceTimeoutError(
      "protected browser evidence deadline expired before harness rebuild",
    );
  }
  const workRoot = resolve(options.workRoot);
  const workMetadata = lstatSync(workRoot);
  if (!workMetadata.isDirectory() || workMetadata.isSymbolicLink()) {
    throw new Error("protected browser harness work root must be a real directory");
  }
  const home = join(workRoot, "home");
  const temporary = join(workRoot, "tmp");
  const output = join(workRoot, "protected-browser-harness");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  mkdirSync(output, { recursive: true, mode: 0o700 });

  const vite = resolve("apps/browser-demos/node_modules/.bin/vite");
  const stdout = new BoundedProcessStream();
  const stderr = new BoundedProcessStream();
  const child = spawn(
    vite,
    [
      "build",
      "--config",
      resolve("apps/browser-demos/abi-staging-browser-harness.config.ts"),
      "--outDir",
      output,
      "--emptyOutDir",
    ],
    {
      cwd: resolve("apps/browser-demos"),
      detached: process.platform !== "win32",
      env: protectedHarnessBuildEnvironment(home, temporary),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk: Buffer) => {
    if (!stdout.append(chunk)) killProtectedChild(child);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (!stderr.append(chunk)) killProtectedChild(child);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exit = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit, rejectExit) => {
          child.once("error", rejectExit);
          child.once("close", (code, signal) => resolveExit({ code, signal }));
        },
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          killProtectedChild(child);
          reject(new BrowserEvidenceTimeoutError(
            "protected browser evidence deadline expired during harness rebuild",
          ));
        }, Math.max(1, options.deadlineAt - Date.now()));
      }),
    ]);
    if (stdout.overflow || stderr.overflow) {
      throw new Error("protected browser harness build output exceeded its byte bound");
    }
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(
        `protected browser harness build exited with code ${String(exit.code)}` +
        (exit.signal === null ? "" : ` and signal ${exit.signal}`) +
        `\nstdout:\n${stdout.text()}\nstderr:\n${stderr.text()}`,
      );
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (Date.now() >= options.deadlineAt) {
    throw new BrowserEvidenceTimeoutError(
      "protected browser evidence deadline expired during harness rebuild",
    );
  }

  const candidateHarness = join(
    resolve(options.runtimeRoot),
    "browser/dist/abi-staging-harness",
  );
  const expected = protectedHarnessInventory(candidateHarness);
  const rebuilt = protectedHarnessInventory(output);
  if (!canonicalEqual(expected, rebuilt)) {
    throw new Error(
      "candidate runtime browser harness differs from the freshly built protected checkout",
    );
  }
  const entry = rebuilt.find((item) => item.path === "index.html");
  if (entry === undefined) {
    throw new Error("fresh protected browser harness lacks its index entry");
  }
  return { root: output, entry: { bytes: entry.bytes, sha256: entry.sha256 } };
}

function protectedHarnessBuildEnvironment(
  home: string,
  temporary: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { HOME: home, TMPDIR: temporary };
  for (const name of [
    "CI", "FORCE_COLOR", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR", "PATH",
    "SOURCE_DATE_EPOCH", "TERM", "TZ",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function killProtectedChild(
  child: ChildProcessByStdio<null, Readable, Readable>,
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // A concurrent child exit is equivalent to successful cancellation.
  }
}

function protectedHarnessInventory(root: string): Array<{
  path: string;
  bytes: number;
  sha256: string;
}> {
  const canonicalRoot = resolve(root);
  const rootMetadata = lstatSync(canonicalRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("protected browser harness must be a real directory");
  }
  const inventory: Array<{ path: string; bytes: number; sha256: string }> = [];
  let entries = 0;
  let total = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > 32) throw new Error("protected browser harness exceeds its depth bound");
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      entries += 1;
      if (entries > 4_096) {
        throw new Error("protected browser harness exceeds its entry bound");
      }
      const path = join(directory, child.name);
      if (child.isSymbolicLink()) {
        throw new Error("protected browser harness contains a symbolic link");
      }
      if (child.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      if (!child.isFile()) {
        throw new Error("protected browser harness contains a nonregular file");
      }
      const metadata = lstatSync(path);
      if (metadata.size < 1 || metadata.size > 64 * 1024 * 1024) {
        throw new Error("protected browser harness file exceeds its byte bound");
      }
      total += metadata.size;
      if (!Number.isSafeInteger(total) || total > 128 * 1024 * 1024) {
        throw new Error("protected browser harness exceeds its total byte bound");
      }
      const body = new Uint8Array(readFileSync(path));
      const after = lstatSync(path);
      if (
        after.isSymbolicLink() || !after.isFile() ||
        after.size !== metadata.size || body.byteLength !== metadata.size
      ) {
        throw new Error("protected browser harness changed while hashing");
      }
      inventory.push({
        path: relative(canonicalRoot, path).split(sep).join("/"),
        bytes: body.byteLength,
        sha256: sha256Hex(body),
      });
    }
  };
  visit(canonicalRoot, 0);
  if (inventory.length === 0) throw new Error("protected browser harness is empty");
  return inventory.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
}

function protectedPhaseLimit(
  value: 1 | 2 | undefined,
  label: string,
): 1 | 2 {
  if (value === undefined) return 1;
  if (value !== 1 && value !== 2) {
    throw new Error(`${label} is outside its protected bound`);
  }
  return value;
}

function checkedLazyServerAsset(
  value: ProtectedBrowserEvidenceLazyAssetV1,
  label: string,
): ProtectedBrowserEvidenceLazyAssetV1 {
  const bytes = positiveInteger(value.bytes, `${label} bytes`);
  if (bytes > MAX_BROWSER_VFS_BYTES) {
    throw new Error(`${label} exceeds its protected byte bound`);
  }
  const hasPath = value.path !== undefined;
  const hasSource = value.sourceUrl !== undefined;
  if (hasPath === hasSource) {
    throw new Error(`${label} requires exactly one protected byte source`);
  }
  return {
    reference: text(value.reference, `${label} reference`, 8_192),
    bytes,
    sha256: digest(value.sha256, `${label} digest`),
    ...(hasPath
      ? { path: resolve(text(value.path, `${label} path`, 8_192)) }
      : { sourceUrl: text(value.sourceUrl, `${label} source URL`, 8_192) }),
  };
}

function checkedServerAsset(
  value: ProtectedBrowserEvidenceAssetV1,
  label: string,
): ProtectedBrowserEvidenceAssetV1 {
  const bytes = positiveInteger(value.bytes, `${label} bytes`);
  if (bytes > MAX_BROWSER_VFS_BYTES) {
    throw new Error(`${label} exceeds its protected byte bound`);
  }
  return {
    path: resolve(text(value.path, `${label} path`, 8_192)),
    bytes,
    sha256: digest(value.sha256, `${label} digest`),
  };
}

async function sendExactAsset(
  response: ServerResponse,
  asset: ProtectedBrowserEvidenceAssetV1,
  contentType: string,
  method: string | undefined,
  reserveBytes: (bytes: number, method: string | undefined) => void,
): Promise<void> {
  if (method === "HEAD") {
    sendHeaders(response, 200, contentType, asset.bytes);
    response.end();
    return;
  }
  reserveBytes(asset.bytes, method);
  const body = await readExactRegular(asset);
  sendHeaders(response, 200, contentType, body.byteLength);
  response.end(body);
}

async function readExactRegular(
  asset: ProtectedBrowserEvidenceAssetV1,
): Promise<Uint8Array> {
  const stat = await lstat(asset.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.bytes) {
    throw new Error("protected browser evidence asset identity changed");
  }
  const body = new Uint8Array(await readFile(asset.path));
  if (sha256Hex(body) !== asset.sha256) {
    throw new Error("protected browser evidence asset digest changed");
  }
  return body;
}

async function sendRuntimeFile(
  response: ServerResponse,
  distRoot: string,
  pathname: string,
  method: string | undefined,
  reserveBytes: (bytes: number, method: string | undefined) => void,
): Promise<void> {
  const relativePath = pathname === "/"
    ? "index.html"
    : pathname.replace(/^\/+/, "") + (pathname.endsWith("/") ? "index.html" : "");
  const candidate = resolve(join(distRoot, relativePath));
  const within = relative(distRoot, candidate);
  if (
    within === "" || within === ".." || within.startsWith(`..${sep}`) ||
    resolve(distRoot, within) !== candidate
  ) {
    sendText(response, 404, "not found\n");
    return;
  }
  let canonical: string;
  let stat;
  try {
    canonical = resolve(await realpath(candidate));
    stat = await lstat(canonical);
  } catch {
    sendText(response, 404, "not found\n");
    return;
  }
  if (
    canonical !== candidate || !stat.isFile() || stat.isSymbolicLink() ||
    stat.size < 1 || stat.size > MAX_BROWSER_STATIC_FILE_BYTES
  ) {
    sendText(response, 404, "not found\n");
    return;
  }
  sendHeaders(response, 200, contentTypeFor(candidate), stat.size);
  if (method === "HEAD") {
    response.end();
    return;
  }
  reserveBytes(stat.size, method);
  response.end(await readFile(canonical));
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".css": return "text/css; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".wasm": return "application/wasm";
    case ".zst": return "application/zstd";
    default: return "application/octet-stream";
  }
}

function sendHeaders(
  response: ServerResponse,
  status: number,
  contentType: string,
  bytes: number,
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": String(bytes),
    "Content-Type": contentType,
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Service-Worker-Allowed": "/",
    "X-Content-Type-Options": "nosniff",
  });
}

function sendText(response: ServerResponse, status: number, value: string): void {
  const body = new TextEncoder().encode(value);
  sendHeaders(response, status, "text/plain; charset=utf-8", body.byteLength);
  response.end(body);
}

export async function runBrowserProductEvidence(
  session: BrowserEvidenceSessionV1,
  executor: BrowserEvidenceExecutor,
  dependencies: BrowserEvidenceRunnerDependencies = {},
): Promise<ProductEvidenceResultV1> {
  const runWithTimeout = dependencies.runWithTimeout ?? browserRunWithTimeout;
  const cleanupTimeout = dependencies.cleanupTimeoutMilliseconds ??
    DEFAULT_CLEANUP_TIMEOUT_MILLISECONDS;
  if (
    !Number.isSafeInteger(cleanupTimeout) || cleanupTimeout < 1 ||
    cleanupTimeout > MAX_CLEANUP_TIMEOUT_MILLISECONDS
  ) {
    throw new Error("browser evidence cleanup timeout exceeds its protected bound");
  }

  let outcome: ProductEvidenceResultV1["outcome"] = "success";
  let stdout = "";
  let stderr = "";
  let runner = "";
  try {
    validateBrowserEvidenceSession(session);
    const observed = await runWithTimeout(
      executor.execute(session),
      session.context.definition.timeout_seconds * 1_000,
    );
    stdout = boundedText(observed.stdout, "browser evidence stdout");
    stderr = boundedText(observed.stderr, "browser evidence stderr");
  } catch (error) {
    outcome = error instanceof BrowserEvidenceTimeoutError
      ? "timeout"
      : "failure";
    runner = errorMessage(error);
    await boundedBrowserCleanup(
      () => executor.cancel(),
      cleanupTimeout,
    ).catch((cleanupError) => {
      runner += `\nbrowser cancellation failed: ${errorMessage(cleanupError)}`;
    });
  }

  await boundedBrowserCleanup(
    () => executor.dispose(),
    cleanupTimeout,
  ).catch((cleanupError) => {
    if (outcome === "success") outcome = "failure";
    runner += `${runner ? "\n" : ""}browser disposal failed: ${errorMessage(cleanupError)}`;
  });

  return terminalProductEvidenceResult(
    session.context,
    "browser",
    outcome,
    { runner, stderr, stdout },
  );
}

export interface BrowserEvidenceCliOptions {
  builderReport: string;
  candidateLocator: string;
  context: string;
  definitions: string;
  output: string;
  pages: string;
  products: string;
  resolvedInputs: string;
  runtimeBundle: string;
  runtimeRoot: string;
  tests: string;
  vfs: string;
}

interface PreparedBrowserEvidence {
  context: BrowserEvidenceContextV1;
  artifacts: ExactRuntimeArtifactRootV1;
  candidateLocator: CandidateProductLocatorV1;
  definitions: GeneratedEvidenceDefinitionRegistryV1;
  pages: unknown;
  products: ProtectedVfsProductCatalogV1;
  tests: unknown;
  lazyRequirements: CandidateLazyRequirementV1[];
  vfs: ProtectedBrowserEvidenceAssetV1;
}

interface BrowserEvidenceObservationDocument {
  schema: 1;
  kind: "kandelo-protected-browser-evidence-observation";
  definition_id: string;
  product_id: string;
  stdout: string;
  stderr: string;
}

export interface BrowserEvidenceSupervisorDependencies {
  /** Test-only transport seam for the external immutable lazy source. */
  server?: ProtectedBrowserEvidenceServerDependencies;
}

export async function superviseBrowserEvidenceCli(
  options: BrowserEvidenceCliOptions,
  dependencies: BrowserEvidenceSupervisorDependencies = {},
): Promise<ProductEvidenceResultV1> {
  const startedAt = Date.now();
  const context = loadCanonicalBrowserContext(options.context);
  const deadlineAt = startedAt + context.definition.timeout_seconds * 1_000;
  let prepared: PreparedBrowserEvidence | undefined;
  let workRoot: string | undefined;
  let server: ProtectedBrowserEvidenceServer | undefined;
  let executor: PlaywrightBrowserEvidenceExecutor | undefined;
  let result: ProductEvidenceResultV1 | undefined;
  const terminal = (error: unknown): ProductEvidenceResultV1 =>
    terminalProductEvidenceResult(
      context,
      "browser",
      Date.now() >= deadlineAt || error instanceof BrowserEvidenceTimeoutError
        ? "timeout"
        : "failure",
      { runner: errorMessage(error), stderr: "", stdout: "" },
    );

  try {
    prepared = await prepareBrowserEvidence(options, context);
    if (Date.now() >= deadlineAt) {
      throw new BrowserEvidenceTimeoutError(
        "protected browser evidence deadline expired during exact-input validation",
      );
    }
    workRoot = mkdtempSync(join(tmpdir(), "kandelo-browser-evidence-supervisor-"));
    const protectedHarness = await prepareVerifiedProtectedBrowserHarness({
      deadlineAt,
      runtimeRoot: options.runtimeRoot,
      workRoot,
    });
    const expectedLazyIds = expectedLazyInputIds(context.definition);
    const lazySources = candidateLazyAssetSources(
      prepared.lazyRequirements,
      expectedLazyIds,
    );
    const pagesLoad = pagesLoadForProduct(
      prepared.pages,
      context.product.id,
    );
    const phaseLimit = pagesLoad === null ? 1 : 2;
    server = await startProtectedBrowserEvidenceServer(
      {
        distRoot: join(options.runtimeRoot, "browser", "dist"),
        protectedHarnessRoot: protectedHarness.root,
        runtimeBytes: context.runtime.browser.bytes,
        productId: context.product.id,
        vfs: prepared.vfs,
        lazyAssets: lazySources.map((source) => ({
          reference: source.url,
          sourceUrl: source.sourceUrl,
          bytes: source.size,
          sha256: source.sha256,
        })),
        vfsGetLimit: phaseLimit,
        lazyGetLimit: phaseLimit,
      },
      dependencies.server,
    );
    const selection = buildBrowserEvidenceSelection({
      candidateReference: prepared.candidateLocator.immutable_reference,
      referenceClass: prepared.candidateLocator.reference_class ?? "candidate",
      definitionId: context.definition.id,
      definitions: prepared.definitions,
      pages: prepared.pages,
      productId: context.product.id,
      products: prepared.products,
      servedVfs: {
        bytes: context.candidate_product.vfs_layer_bytes,
        sha256: context.candidate_product.vfs_layer_sha256,
        sourceKind: "protected-local-candidate-vfs",
        url: new URL(
          `__abi_staging/${context.product.id}/product.vfs.zst`,
          server.baseUrl,
        ).href,
      },
      servedLazyAssets: lazySources.map((source, index) => ({
        id: expectedLazyIds[index]!,
        reference: source.url,
        url: new URL(protectedLazyAssetPath(source.url), server!.baseUrl).href,
        sha256: source.sha256,
        bytes: source.size,
      })),
      servedBrowserHarness: {
        url: new URL(
          context.runtime.browser.harness_entry_path.slice("browser/dist/".length),
          server.baseUrl,
        ).href,
        sha256: protectedHarness.entry.sha256,
        bytes: protectedHarness.entry.bytes,
      },
      servedBrowserHost: {
        url: new URL(
          context.runtime.browser.host_entry_path.slice("browser/dist/".length),
          server.baseUrl,
        ).href,
        sha256: context.runtime.browser.host_entry_sha256,
        bytes: context.runtime.browser.host_entry_bytes,
      },
      servedKernelAsset: {
        url: new URL(
          context.runtime.browser.kernel_asset_path.slice("browser/dist/".length),
          server.baseUrl,
        ).href,
        sha256: context.runtime.browser.kernel_asset_sha256,
        bytes: context.runtime.kernel.bytes,
      },
      targetAbi: context.runtime.target_abi.version,
      tests: prepared.tests,
    });
    const session = { context, selection };
    validateBrowserEvidenceSession(session);

    const sessionPath = join(workRoot, "session.json");
    const observationPath = join(workRoot, "observation.json");
    writeFileSync(sessionPath, canonicalJsonBytes(session), { flag: "wx", mode: 0o600 });
    executor = new PlaywrightBrowserEvidenceExecutor({
      baseUrl: server.baseUrl,
      observationPath,
      sessionPath,
      workRoot,
      onDispose: async () => {
        if (server !== undefined) {
          const active = server;
          server = undefined;
          await active.close();
        }
      },
    });
    result = await runBrowserProductEvidence(session, executor, {
      runWithTimeout: (operation, timeoutMilliseconds) => {
        const remaining = Math.min(
          timeoutMilliseconds,
          Math.max(1, deadlineAt - Date.now()),
        );
        return browserRunWithTimeout(operation, remaining);
      },
    });
    result = enforceBrowserEvidenceDeadline(context, result, deadlineAt);
  } catch (error) {
    result = terminal(error);
  } finally {
    if (executor === undefined && server !== undefined) {
      await server.close().catch(() => undefined);
      server = undefined;
    }
  }

  if (prepared !== undefined && result?.outcome === "success") {
    try {
      if (Date.now() >= deadlineAt) {
        throw new BrowserEvidenceTimeoutError(
          "protected browser evidence deadline expired before input revalidation",
        );
      }
      await prepareBrowserEvidence(options, context);
      if (Date.now() >= deadlineAt) {
        throw new BrowserEvidenceTimeoutError(
          "protected browser evidence deadline expired during input revalidation",
        );
      }
    } catch (error) {
      result = terminal(error instanceof BrowserEvidenceTimeoutError
        ? error
        : new Error(
          `candidate browser execution mutated its protected inputs: ${errorMessage(error)}`,
        ));
    }
  }
  try {
    if (result === undefined) {
      throw new Error("protected browser lifecycle produced no terminal result");
    }
    result = enforceBrowserEvidenceDeadline(context, result, deadlineAt);
    validateProductEvidenceResult(result);
    return result;
  } finally {
    if (workRoot !== undefined) {
      try {
        rmSync(workRoot, { recursive: true, force: true });
      } catch {
        // A canonical result already exists. Private runner cleanup is best effort.
      }
    }
  }
}

export function enforceBrowserEvidenceDeadline(
  context: BrowserEvidenceContextV1,
  result: ProductEvidenceResultV1,
  deadlineAt: number,
  now = Date.now(),
): ProductEvidenceResultV1 {
  if (now < deadlineAt) return result;
  return terminalProductEvidenceResult(
    context,
    "browser",
    "timeout",
    {
      runner: "protected browser evidence absolute deadline expired",
      stderr: "",
      stdout: "",
    },
  );
}

async function prepareBrowserEvidence(
  options: BrowserEvidenceCliOptions,
  context: BrowserEvidenceContextV1,
): Promise<PreparedBrowserEvidence> {
  assertCurrentBrowserEvidenceContext(options.context, context);
  const runtimeBundleBytes = readBoundedRegular(
    options.runtimeBundle,
    "exact browser runtime bundle",
    MAX_BROWSER_RUNTIME_BUNDLE_BYTES,
  );
  const artifacts = validateExactRuntimeArtifactRoot(
    runtimeBundleBytes,
    options.runtimeRoot,
  );
  const definitions = loadCanonicalDocument(
    options.definitions,
    "protected evidence definitions",
  ) as GeneratedEvidenceDefinitionRegistryV1;
  const products = loadCanonicalDocument(
    options.products,
    "protected VFS products",
  ) as ProtectedVfsProductCatalogV1;
  const pages = loadCanonicalDocument(options.pages, "Pages VFS registry");
  const tests = loadCanonicalDocument(options.tests, "test VFS registry");
  const candidateLocator = loadCanonicalDocument(
    options.candidateLocator,
    "candidate product locator",
  ) as CandidateProductLocatorV1;
  validateCandidateLocator(context, candidateLocator);
  const resolvedInputs = readBoundedRegular(
    options.resolvedInputs,
    "resolved product inputs",
    MAX_BROWSER_DOCUMENT_BYTES,
  );
  const builderReport = readBoundedRegular(
    options.builderReport,
    "candidate builder report",
    MAX_BROWSER_DOCUMENT_BYTES,
  );
  const lazyRequirements = validateCandidateProductInputDocuments(
    context,
    candidateLocator,
    products,
    exactRuntimeDevShellLockSha256(runtimeBundleBytes),
    resolvedInputs,
    builderReport,
  );
  const vfsBytes = readBoundedRegular(
    options.vfs,
    "candidate browser VFS",
    Math.min(MAX_BROWSER_VFS_BYTES, context.candidate_product.vfs_layer_bytes),
    context.candidate_product.vfs_layer_bytes,
  );
  if (sha256Hex(vfsBytes) !== context.candidate_product.vfs_layer_sha256) {
    throw new Error("candidate browser VFS differs from its exact digest");
  }
  await validateCandidateVfsLazyInventory(
    vfsBytes,
    lazyRequirements,
    context.runtime.target_abi,
  );
  if (!canonicalEqual(runtimeIdentityFromBundle(runtimeBundleBytes), context.runtime)) {
    throw new Error("browser evidence runtime differs from its exact bundle");
  }
  const kernelBytes = readBoundedRegular(
    artifacts.kernelPath,
    "exact browser kernel",
    512 * 1024 * 1024,
    context.runtime.kernel.bytes,
  );
  if (sha256Hex(kernelBytes) !== context.runtime.kernel.wasm_sha256) {
    throw new Error("exact browser kernel differs from its runtime identity");
  }
  return {
    context,
    artifacts,
    candidateLocator,
    definitions,
    pages,
    products,
    tests,
    lazyRequirements,
    vfs: {
      path: resolve(options.vfs),
      bytes: vfsBytes.byteLength,
      sha256: sha256Hex(vfsBytes),
    },
  };
}

class PlaywrightBrowserEvidenceExecutor implements BrowserEvidenceExecutor {
  private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private readonly stdout = new BoundedProcessStream();
  private readonly stderr = new BoundedProcessStream();
  private disposed = false;

  constructor(private readonly options: {
    baseUrl: string;
    observationPath: string;
    sessionPath: string;
    workRoot: string;
    onDispose: () => Promise<void>;
  }) {}

  async execute(
    session: BrowserEvidenceSessionV1,
  ): Promise<BrowserEvidenceObservationV1> {
    if (this.child !== undefined) throw new Error("Playwright evidence already started");
    const browserRoot = resolve("apps/browser-demos");
    const outputRoot = join(this.options.workRoot, "playwright-output");
    mkdirSync(outputRoot, { mode: 0o700 });
    const child = spawn(
      "npx",
      [
        "--no-install", "playwright", "test",
        "test/abi-staging-product-evidence.spec.ts",
        "--project=chromium", "--workers=1", "--reporter=line",
        `--output=${outputRoot}`,
      ],
      {
        cwd: browserRoot,
        env: protectedPlaywrightEnvironment(this.options),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      if (!this.stdout.append(chunk)) this.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!this.stderr.append(chunk)) this.kill();
    });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", (code, signal) => resolveExit({ code, signal }));
      },
    );
    if (this.stdout.overflow || this.stderr.overflow) {
      throw new Error("protected Playwright output exceeded its byte bound");
    }
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(
        `protected Playwright evidence exited with code ${String(exit.code)}` +
        (exit.signal === null ? "" : ` and signal ${exit.signal}`) +
        `\nstdout:\n${this.stdout.text()}\nstderr:\n${this.stderr.text()}`,
      );
    }
    const observation = loadCanonicalDocument(
      this.options.observationPath,
      "protected browser observation",
    ) as BrowserEvidenceObservationDocument;
    if (
      observation.schema !== 1 ||
      observation.kind !== "kandelo-protected-browser-evidence-observation" ||
      observation.definition_id !== session.selection.definitionId ||
      observation.product_id !== session.selection.productId
    ) {
      throw new Error("protected browser observation differs from its session");
    }
    return {
      stdout: boundedText(observation.stdout, "protected browser observation stdout"),
      stderr: boundedText(observation.stderr, "protected browser observation stderr"),
    };
  }

  async cancel(): Promise<void> {
    this.kill();
    await this.waitForClose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.kill();
    await this.waitForClose();
    await this.options.onDispose();
  }

  private kill(): void {
    const child = this.child;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== "win32" && child.pid !== undefined) {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      // A concurrent browser exit is equivalent to successful cancellation.
    }
  }

  private async waitForClose(): Promise<void> {
    const child = this.child;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    await Promise.race([
      new Promise<void>((resolveClose) => child.once("close", () => resolveClose())),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
    ]);
  }
}

class BoundedProcessStream {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  overflow = false;

  append(chunk: Buffer): boolean {
    const remaining = MAX_PLAYWRIGHT_OUTPUT_BYTES - this.bytes;
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining);
      this.chunks.push(Buffer.from(retained));
      this.bytes += retained.byteLength;
    }
    if (chunk.byteLength > remaining) this.overflow = true;
    return !this.overflow;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function protectedPlaywrightEnvironment(options: {
  baseUrl: string;
  observationPath: string;
  sessionPath: string;
  workRoot: string;
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "DISPLAY", "FORCE_COLOR", "LANG", "LC_ALL", "NO_COLOR", "NO_PROXY",
    "PATH", "PLAYWRIGHT_BROWSERS_PATH", "TERM", "TZ", "WAYLAND_DISPLAY",
    "XAUTHORITY",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.CI = "true";
  environment.HOME = join(options.workRoot, "home");
  environment.TMPDIR = join(options.workRoot, "tmp");
  environment.KANDELO_ABI_STAGING_BROWSER_BASE_URL = options.baseUrl;
  environment.KANDELO_ABI_STAGING_BROWSER_SESSION = options.sessionPath;
  environment.KANDELO_ABI_STAGING_BROWSER_OBSERVATION = options.observationPath;
  return environment;
}

function loadCanonicalBrowserContext(path: string): BrowserEvidenceContextV1 {
  const value = loadCanonicalDocument(path, "browser evidence context") as unknown;
  const context = exactRecord(value, [
    "boot", "candidate_product", "definition", "host", "kind", "mounts",
    "product", "request_digest", "run", "runtime", "schema",
  ], "browser evidence context") as unknown as BrowserEvidenceContextV1;
  exactRecord(context.definition, [
    "definition_sha256", "host", "id", "implementation", "probe", "runner",
    "timeout_seconds",
  ], "browser evidence definition");
  // A context is not usable unless protected code can always construct its
  // terminal receipt. This validates every shared identity field, including
  // the exact run shape, before any server, browser, or candidate code starts.
  terminalProductEvidenceResult(
    context,
    "browser",
    "failure",
    { runner: "", stderr: "", stdout: "" },
  );
  if (
    context.schema !== 1 ||
    context.kind !== "kandelo-vfs-product-browser-evidence-context" ||
    context.host !== "browser" ||
    context.definition?.host !== "browser" ||
    context.definition.definition_sha256 !== evidenceDefinitionSha256(context.definition) ||
    !SHA256.test(context.request_digest) ||
    !STABLE_ID.test(context.product?.id ?? "") ||
    !SHA256.test(context.product?.manifest_sha256 ?? "") ||
    !Number.isSafeInteger(context.definition.timeout_seconds) ||
    context.definition.timeout_seconds < 1 ||
    context.definition.timeout_seconds > 3 * 60 * 60
  ) {
    throw new Error("browser evidence context has invalid protected identity");
  }
  return context;
}

function loadCanonicalDocument(
  path: string,
  label: string,
): unknown {
  const bytes = readBoundedRegular(path, label, MAX_BROWSER_DOCUMENT_BYTES);
  const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!equalBytes(bytes, canonicalJsonBytes(value))) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return value;
}

function readBoundedRegular(
  path: string,
  label: string,
  maximum: number,
  expected?: number,
): Uint8Array {
  const resolved = resolve(path);
  const metadata = lstatSync(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (metadata.size < 1 || metadata.size > maximum) {
    throw new Error(`${label} is outside its byte bound`);
  }
  if (expected !== undefined && metadata.size !== expected) {
    throw new Error(`${label} differs from its exact byte count`);
  }
  return new Uint8Array(readFileSync(resolved));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);
}

function validateBrowserEvidenceSession(
  session: BrowserEvidenceSessionV1,
): void {
  const { context, selection } = session;
  if (
    context.schema !== 1 ||
    context.kind !== "kandelo-vfs-product-browser-evidence-context" ||
    context.host !== "browser" ||
    context.definition.host !== "browser"
  ) {
    throw new Error("browser evidence context has unsupported identity");
  }
  if (
    context.product.id !== selection.productId ||
    context.product.manifest_sha256 !== selection.manifestSha256 ||
    context.definition.id !== selection.definitionId ||
    context.definition.definition_sha256 !== selection.definitionSha256 ||
    context.definition.runner !== selection.runner ||
    context.definition.definition_sha256 !==
      evidenceDefinitionSha256(context.definition)
  ) {
    throw new Error("browser evidence context differs from protected selection");
  }
  const productReference = productReferenceIdentity(
    selection.candidateReference,
    context.product.id,
  );
  if (
    context.candidate_product.manifest_digest !==
      `sha256:${productReference.digest}` ||
    context.candidate_product.vfs_layer_sha256 !== selection.vfs.sha256 ||
    context.candidate_product.vfs_layer_bytes !== selection.vfs.bytes ||
    !SHA256.test(context.candidate_product.builder_report_sha256)
  ) {
    throw new Error("browser evidence candidate differs from its immutable selection");
  }
  if (
    productReference.abi !== context.runtime.target_abi.version ||
    !canonicalEqual(context.boot, selection.boot) ||
    !canonicalEqual(context.mounts, selection.mounts)
  ) {
    throw new Error("browser evidence runtime or boot differs from protected selection");
  }
  const browserKernelPrefix = "browser/dist/";
  if (!context.runtime.browser.kernel_asset_path.startsWith(browserKernelPrefix)) {
    throw new Error("browser evidence runtime kernel asset path is invalid");
  }
  const expectedKernelUrl = new URL(
    context.runtime.browser.kernel_asset_path.slice(browserKernelPrefix.length),
    new URL("/", selection.vfs.url),
  ).href;
  if (
    selection.browserHarness.url !== new URL(
      context.runtime.browser.harness_entry_path.slice(browserKernelPrefix.length),
      new URL("/", selection.vfs.url),
    ).href ||
    selection.browserHarness.sha256 !==
      context.runtime.browser.harness_entry_sha256 ||
    selection.browserHarness.bytes !== context.runtime.browser.harness_entry_bytes ||
    selection.browserHost.url !== new URL(
      context.runtime.browser.host_entry_path.slice(browserKernelPrefix.length),
      new URL("/", selection.vfs.url),
    ).href ||
    selection.browserHost.sha256 !== context.runtime.browser.host_entry_sha256 ||
    selection.browserHost.bytes !== context.runtime.browser.host_entry_bytes ||
    selection.kernelAsset.url !== expectedKernelUrl ||
    selection.kernelAsset.sha256 !== context.runtime.kernel.wasm_sha256 ||
    selection.kernelAsset.sha256 !==
      context.runtime.browser.kernel_asset_sha256 ||
    selection.kernelAsset.bytes !== context.runtime.kernel.bytes
  ) {
    throw new Error("browser-loaded kernel asset differs from its exact runtime identity");
  }
  if (
    !Number.isSafeInteger(context.definition.timeout_seconds) ||
    context.definition.timeout_seconds < 1 ||
    context.definition.timeout_seconds > 3 * 60 * 60
  ) {
    throw new Error("browser evidence timeout is outside its protected bound");
  }
}

export function assertCurrentBrowserEvidenceContext(
  path: string,
  expected: BrowserEvidenceContextV1,
): BrowserEvidenceContextV1 {
  const current = loadCanonicalBrowserContext(path);
  if (!canonicalEqual(current, expected)) {
    throw new Error("browser evidence context changed during protected execution");
  }
  return current;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return sha256Hex(canonicalJsonBytes(left)) ===
    sha256Hex(canonicalJsonBytes(right));
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is not text`);
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > 64 * 1024) {
    throw new Error(`${label} exceeds its protected byte bound`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function boundedBrowserCleanup(
  cleanup: () => Promise<void>,
  timeoutMilliseconds: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("browser evidence cleanup timed out")),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function browserRunWithTimeout<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new BrowserEvidenceTimeoutError(
            "protected browser evidence deadline expired",
          )),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const DEFINITION_SURFACES: Readonly<Record<string, BrowserEvidenceSurface>> = {
  "erlang-vfs-browser-smoke": "generic-exec",
  "main-shell-basic-e2e": "shell",
  "main-shell-toolchain-browser": "toolchain-shell",
  "main-shell-c-development-browser": "c-development",
  "main-shell-fbdoom-e2e": "doom",
  "main-shell-modeset-e2e": "modeset",
  "mariadb-suite-browser": "mariadb-suite",
  "mariadb-wasm32-browser-startup": "mariadb",
  "mariadb-wasm64-browser-startup": "mariadb",
  "nginx-php-vfs-browser-startup": "nginx-php",
  "nginx-vfs-browser-startup": "nginx",
  "node-vfs-browser-startup": "node",
  "perl-vfs-browser-smoke": "generic-exec",
  "php-suite-browser": "php-suite",
  "python-vfs-browser-smoke": "generic-exec",
  "redis-vfs-browser-startup": "redis",
  "rootfs-browser-startup": "shell",
  "sqlite-suite-browser": "sqlite-suite",
  "wordpress-mariadb-browser-e2e": "wordpress-mariadb",
  "wordpress-sqlite-browser-e2e": "wordpress-sqlite",
};

const OPTIONAL_IMAGE_BY_PRODUCT = {
  "browser-lamp": "lamp",
  "browser-node": "node",
  "browser-wordpress": "wordpress",
} as const;

const PROTECTED_BROWSER_REPOSITORY_SUITES: Readonly<
  Partial<Record<BrowserEvidenceSurface, string>>
> = {
  "toolchain-shell": "main-shell-toolchain-browser",
  "c-development": "main-shell-c-development-browser",
  doom: "main-shell-fbdoom-browser",
  modeset: "main-shell-modeset-browser",
  "wordpress-sqlite": "wordpress-sqlite-browser",
  "wordpress-mariadb": "wordpress-mariadb-browser",
  "mariadb-suite": "mariadb-product-browser",
  "php-suite": "php-product-browser",
  "sqlite-suite": "sqlite-product-browser",
};

export function buildBrowserEvidenceSelection(
  input: BrowserEvidenceSelectionInputV1,
): BrowserEvidenceSelectionV1 {
  const productId = stableId(input.productId, "browser evidence product");
  const definitionId = stableId(
    input.definitionId,
    "browser evidence definition",
  );
  const targetAbi = positiveInteger(input.targetAbi, "browser evidence ABI");
  const definition = selectedBrowserDefinition(
    input.definitions,
    definitionId,
  );
  const product = selectedProtectedProduct(input.products, productId);
  assertTestRegistrySelection(input.tests, productId, definitionId);
  const pagesLoad = pagesLoadForProduct(input.pages, productId);
  const referenceClass = input.referenceClass ?? "candidate";
  const candidateReference = candidateProductReference(
    input.candidateReference,
    productId,
    targetAbi,
    referenceClass,
  );
  const surface = DEFINITION_SURFACES[definitionId];
  if (surface === undefined) {
    throw new Error(
      `browser evidence definition lacks a protected surface adapter: ${definitionId}`,
    );
  }
  const suite = PROTECTED_BROWSER_REPOSITORY_SUITES[surface];
  const probe = record(definition.probe, "browser evidence definition probe");
  if (
    (definition.runner === "repository-suite") !== (suite !== undefined) ||
    (suite !== undefined && probe.suite !== suite)
  ) {
    throw new Error("browser repository-suite definition differs from its protected adapter");
  }
  const vfs = validateServedVfs(
    input.servedVfs,
    productId,
    surface,
    pagesLoad,
  );
  const lazyAssets = validateServedLazyAssets(
    input.servedLazyAssets,
    expectedLazyInputIds(definition as unknown as GeneratedEvidenceDefinitionV1),
    vfs,
    targetAbi,
    referenceClass,
  );
  const kernelAsset = validateServedKernelAsset(input.servedKernelAsset, vfs);
  const browserHarness = validateServedBrowserHarness(
    input.servedBrowserHarness,
    vfs,
  );
  const browserHost = validateServedBrowserHost(input.servedBrowserHost, vfs);

  return {
    schema: 1,
    kind: "kandelo-protected-browser-evidence-selection",
    host: "browser",
    productId,
    definitionId,
    definitionSha256: digest(
      definition.definition_sha256,
      "browser evidence definition digest",
    ),
    runner: stableId(definition.runner, "browser evidence runner"),
    surface,
    pagesLoad,
    candidateReference,
    vfs,
    manifestSha256: product.sha256,
    boot: product.boot,
    mounts: product.mounts,
    lazyAssets,
    browserHarness,
    browserHost,
    kernelAsset,
  };
}

function validateServedBrowserHarness(
  value: ProtectedBrowserEvidenceKernelSelectionV1,
  vfs: ProtectedCandidateVfsSource,
): ProtectedBrowserEvidenceKernelSelectionV1 {
  const asset = validateServedRuntimeAsset(
    value,
    vfs,
    "protected browser evidence harness",
    ".html",
    MAX_BROWSER_DOCUMENT_BYTES,
  );
  if (!new URL(asset.url).pathname.endsWith("/abi-staging-harness/index.html")) {
    throw new Error("protected browser evidence harness path is noncanonical");
  }
  return asset;
}

function validateServedBrowserHost(
  value: ProtectedBrowserEvidenceKernelSelectionV1,
  vfs: ProtectedCandidateVfsSource,
): ProtectedBrowserEvidenceKernelSelectionV1 {
  const asset = validateServedRuntimeAsset(
    value,
    vfs,
    "protected browser host entry",
    ".js",
    64 * 1024 * 1024,
  );
  if (!new URL(asset.url).pathname.endsWith("/abi-staging/browser-host.js")) {
    throw new Error("protected browser host entry path is noncanonical");
  }
  return asset;
}

function validateServedKernelAsset(
  value: ProtectedBrowserEvidenceKernelSelectionV1,
  vfs: ProtectedCandidateVfsSource,
): ProtectedBrowserEvidenceKernelSelectionV1 {
  return validateServedRuntimeAsset(
    value,
    vfs,
    "protected browser kernel asset",
    ".wasm",
    512 * 1024 * 1024,
  );
}

function validateServedRuntimeAsset(
  value: ProtectedBrowserEvidenceKernelSelectionV1,
  vfs: ProtectedCandidateVfsSource,
  label: string,
  suffix: string,
  maximumBytes: number,
): ProtectedBrowserEvidenceKernelSelectionV1 {
  const item = exactRecord(
    value,
    ["bytes", "sha256", "url"],
    label,
  );
  const bytes = positiveInteger(item.bytes, `${label} bytes`);
  if (bytes > maximumBytes) {
    throw new Error(`${label} exceeds its byte bound`);
  }
  const sha256 = digest(item.sha256, `${label} digest`);
  const url = new URL(text(item.url, `${label} URL`, 2_048));
  const root = new URL("/", vfs.url);
  if (
    url.protocol !== "http:" || url.origin !== root.origin ||
    url.username !== "" || url.password !== "" ||
    url.search !== "" || url.hash !== "" ||
    !url.pathname.endsWith(suffix)
  ) {
    throw new Error(`${label} is not one exact local runtime URL`);
  }
  return { url: url.href, sha256, bytes };
}

function validateServedLazyAssets(
  value: unknown,
  expectedIds: readonly string[],
  vfs: ProtectedCandidateVfsSource,
  targetAbi: number,
  referenceClass: "candidate" | "canonical",
): ProtectedBrowserEvidenceLazySelectionV1[] {
  const values = array(value, "protected browser lazy assets");
  if (values.length !== expectedIds.length) {
    throw new Error("served lazy assets differ from protected evidence policy");
  }
  const root = new URL("/", vfs.url);
  return values.map((value, index) => {
    const item = exactRecord(
      value,
      ["bytes", "id", "reference", "sha256", "url"],
      `protected browser lazy asset ${index}`,
    );
    const id = stableId(item.id, `protected browser lazy asset ${index} id`);
    if (id !== expectedIds[index]) {
      throw new Error("served lazy asset IDs differ from protected evidence policy");
    }
    const reference = text(
      item.reference,
      `protected browser lazy asset ${index} reference`,
      8_192,
    );
    const sha256 = digest(
      item.sha256,
      `protected browser lazy asset ${index} digest`,
    );
    const bytes = positiveInteger(
      item.bytes,
      `protected browser lazy asset ${index} bytes`,
    );
    if (bytes > MAX_BROWSER_VFS_BYTES) {
      throw new Error("served lazy asset exceeds its protected byte bound");
    }
    const requiredPrefix = referenceClass === "candidate"
      ? `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${targetAbi}-candidates/`
      : `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${targetAbi}/`;
    const canonicalPagesReference =
      `https://automattic.github.io/kandelo/products/inputs/${id}/` +
      `sha256-${sha256}/${id}?sha256=${sha256}&bytes=${bytes}`;
    const exactOciReference = reference.startsWith(requiredPrefix) &&
      reference.includes("@sha256:") && reference.endsWith(`@sha256:${sha256}`);
    if (
      !exactOciReference &&
      (referenceClass !== "canonical" || reference !== canonicalPagesReference)
    ) {
      throw new Error("served lazy asset leaves its exact ABI namespace");
    }
    const url = text(item.url, `protected browser lazy asset ${index} URL`, 8_192);
    if (url !== new URL(protectedLazyAssetPath(reference), root).href) {
      throw new Error("served lazy asset does not use its exact protected local URL");
    }
    return { id, reference, url, sha256, bytes };
  });
}

function protectedLazyAssetPath(reference: string): string {
  if (/^ghcr\.io\/[a-z0-9._\/-]+@sha256:[0-9a-f]{64}$/u.test(reference)) {
    return `/${reference}`;
  }
  const parsed = new URL(reference);
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== "https://automattic.github.io" ||
    !parsed.pathname.startsWith("/kandelo/products/inputs/") ||
    parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" ||
    parsed.href !== reference
  ) {
    throw new Error("protected lazy asset reference is not a supported immutable source");
  }
  return `${parsed.pathname}${parsed.search}`;
}

function selectedProtectedProduct(
  value: unknown,
  productId: string,
): {
  sha256: string;
  boot: VfsBootContractV1;
  mounts: VfsMountIntentV1[];
} {
  const catalog = exactRecord(
    value,
    ["kind", "products", "schema"],
    "protected VFS product catalog",
  );
  if (catalog.schema !== 1 || catalog.kind !== "kandelo-vfs-product-catalog") {
    throw new Error("protected VFS product catalog is unsupported");
  }
  let selected: Record<string, unknown> | undefined;
  let previous = "";
  for (const value of array(catalog.products, "protected VFS products")) {
    const entry = exactRecord(
      value,
      ["manifest", "path", "sha256"],
      "protected VFS product",
    );
    const manifest = record(entry.manifest, "protected VFS product manifest");
    const id = stableId(manifest.id, "protected VFS product id");
    if (id <= previous) throw new Error("protected VFS products are not sorted");
    previous = id;
    if (entry.path !== `images/vfs/products/${id}.toml`) {
      throw new Error("protected VFS product path is noncanonical");
    }
    const claimed = digest(entry.sha256, "protected VFS product digest");
    if (claimed !== sha256Hex(canonicalJsonBytes(manifest))) {
      throw new Error("protected VFS product manifest digest is invalid");
    }
    if (id === productId) selected = entry;
  }
  if (selected === undefined) {
    throw new Error("browser evidence product is absent from protected catalog");
  }
  const manifest = record(selected.manifest, "selected VFS product manifest");
  return {
    sha256: selected.sha256 as string,
    boot: manifest.boot as VfsBootContractV1,
    mounts: manifest.mounts as VfsMountIntentV1[],
  };
}

function selectedBrowserDefinition(
  value: unknown,
  definitionId: string,
): Record<string, unknown> {
  const registry = exactRecord(
    value,
    ["definitions", "kind", "schema", "version"],
    "browser evidence definition registry",
  );
  if (
    registry.schema !== 1 ||
    registry.kind !== "kandelo-vfs-evidence-definitions" ||
    positiveInteger(registry.version, "browser definition registry version") < 1
  ) {
    throw new Error("browser evidence definition registry is unsupported");
  }
  const definitions = array(
    registry.definitions,
    "browser evidence definitions",
  );
  let selected: Record<string, unknown> | undefined;
  let previous = "";
  for (const value of definitions) {
    const definition = exactRecord(
      value,
      [
        "definition_sha256",
        "host",
        "id",
        "implementation",
        "probe",
        "runner",
        "timeout_seconds",
      ],
      "browser evidence definition",
    );
    const id = stableId(definition.id, "browser evidence definition id");
    if (id <= previous) {
      throw new Error("browser evidence definitions are not sorted and unique");
    }
    previous = id;
    if (id === definitionId) selected = definition;
  }
  if (selected === undefined || selected.host !== "browser") {
    throw new Error("selected definition is not protected browser evidence");
  }
  const claimed = digest(
    selected.definition_sha256,
    "selected browser definition digest",
  );
  if (
    claimed !== evidenceDefinitionSha256(
      selected as unknown as GeneratedEvidenceDefinitionV1,
    )
  ) {
    throw new Error("selected browser definition digest is invalid");
  }
  return selected;
}

function assertTestRegistrySelection(
  value: unknown,
  productId: string,
  definitionId: string,
): void {
  const registry = exactRecord(
    value,
    ["kind", "registrations", "schema"],
    "test-owned VFS product registry",
  );
  if (registry.schema !== 1 || registry.kind !== "kandelo-test-vfs-products") {
    throw new Error("test-owned VFS product registry is unsupported");
  }
  const registrations = array(
    registry.registrations,
    "test-owned VFS product registrations",
  );
  let matched = false;
  let previous = "";
  for (const value of registrations) {
    const registration = exactRecordWithOptional(
      value,
      ["applicability", "node", "product"],
      ["browser"],
      "test-owned VFS product registration",
    );
    const product = stableId(
      registration.product,
      "test-owned VFS product registration product",
    );
    if (product <= previous) {
      throw new Error("test-owned VFS product registrations are not sorted");
    }
    previous = product;
    const browser = registration.browser === undefined
      ? []
      : stableIdArray(
        registration.browser,
        `test-owned browser registrations for ${product}`,
      );
    if (product === productId && browser.includes(definitionId)) matched = true;
  }
  if (!matched) {
    throw new Error(
      "browser evidence product and definition differ from the test-owned registry",
    );
  }
}

function pagesLoadForProduct(
  value: unknown,
  productId: string,
): "eager" | "lazy" | null {
  const registry = exactRecord(
    value,
    ["kind", "products", "schema"],
    "Pages-owned VFS product registry",
  );
  if (registry.schema !== 1 || registry.kind !== "kandelo-pages-vfs-products") {
    throw new Error("Pages-owned VFS product registry is unsupported");
  }
  let selected: "eager" | "lazy" | null = null;
  let previous = "";
  for (const value of array(registry.products, "Pages VFS products")) {
    const item = exactRecord(
      value,
      ["id", "load"],
      "Pages VFS product",
    );
    const id = stableId(item.id, "Pages VFS product id");
    if (id <= previous) throw new Error("Pages VFS products are not sorted");
    previous = id;
    if (item.load !== "eager" && item.load !== "lazy") {
      throw new Error("Pages VFS product load policy is unsupported");
    }
    if (id === productId) selected = item.load;
  }
  return selected;
}

function candidateProductReference(
  value: unknown,
  productId: string,
  targetAbi: number,
  referenceClass: "candidate" | "canonical",
): string {
  const reference = text(value, "candidate product reference", 1024);
  const candidatePrefix =
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${targetAbi}-candidates/` +
    `products/${productId}@sha256:`;
  if (referenceClass === "candidate") {
    if (
      !reference.startsWith(candidatePrefix) ||
      !SHA256.test(reference.slice(candidatePrefix.length))
    ) {
      throw new Error(
        "browser evidence product reference is outside the exact candidate namespace",
      );
    }
    return reference;
  }
  const match = reference.match(new RegExp(
    `^https://automattic\\.github\\.io/kandelo/products/${productId}/` +
      `sha256-([0-9a-f]{64})/${productId}-${targetAbi}\\.vfs\\.zst\\?` +
      `sha256=([0-9a-f]{64})&bytes=([1-9][0-9]*)$`,
    "u",
  ));
  if (match === null || match[1] !== match[2] || !Number.isSafeInteger(Number(match[3]))) {
    throw new Error(
      "browser evidence product reference is outside the exact canonical Pages namespace",
    );
  }
  return reference;
}

function productReferenceIdentity(
  reference: string,
  productId: string,
): { abi: number; digest: string } {
  const candidate = reference.match(new RegExp(
    `^ghcr\\.io/kandelo-dev/homebrew-tap-core-abi-([0-9]+)-candidates/` +
      `products/${productId}@sha256:([0-9a-f]{64})$`,
    "u",
  ));
  if (candidate !== null) {
    return { abi: Number(candidate[1]), digest: candidate[2]! };
  }
  const canonical = reference.match(new RegExp(
    `^https://automattic\\.github\\.io/kandelo/products/${productId}/` +
      `sha256-([0-9a-f]{64})/${productId}-([0-9]+)\\.vfs\\.zst\\?` +
      `sha256=([0-9a-f]{64})&bytes=([1-9][0-9]*)$`,
    "u",
  ));
  if (canonical === null || canonical[1] !== canonical[3]) {
    throw new Error("browser evidence product reference has unsupported identity");
  }
  return { abi: Number(canonical[2]), digest: canonical[1]! };
}

function validateServedVfs(
  value: BrowserEvidenceSelectionInputV1["servedVfs"],
  productId: string,
  surface: BrowserEvidenceSurface,
  pagesLoad: "eager" | "lazy" | null,
): ProtectedCandidateVfsSource {
  if (value.sourceKind !== "protected-local-candidate-vfs") {
    throw new Error("browser candidate VFS source kind is unsupported");
  }
  const bytes = positiveInteger(value.bytes, "browser candidate VFS bytes");
  if (bytes > MAX_BROWSER_VFS_BYTES) {
    throw new Error("browser candidate VFS exceeds its byte bound");
  }
  const sha256 = digest(value.sha256, "browser candidate VFS digest");
  const url = new URL(text(value.url, "browser candidate VFS URL", 2048));
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.endsWith(`/${productId}/product.vfs.zst`)
  ) {
    throw new Error("browser candidate VFS URL is not a protected local source");
  }
  const optionalImage = OPTIONAL_IMAGE_BY_PRODUCT[
    productId as keyof typeof OPTIONAL_IMAGE_BY_PRODUCT
  ];
  return {
    schema: 1,
    kind: "kandelo-protected-candidate-vfs",
    productId,
    profile: surface,
    pagesLoad,
    sourceKind: value.sourceKind,
    url: url.href,
    sha256,
    bytes,
    ...(optionalImage === undefined ? {} : { optionalImage }),
  };
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields differ`);
  }
  return result;
}

function exactRecordWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result).sort();
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(result, key)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} fields differ`);
  }
  return result;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stableIdArray(value: unknown, label: string): string[] {
  const result = array(value, label).map((item) => stableId(item, label));
  if (result.some((item, index) => index > 0 && item <= result[index - 1]!)) {
    throw new Error(`${label} must be sorted and unique`);
  }
  return result;
}

function text(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maximum ||
    value.includes("\0")
  ) {
    throw new Error(`${label} is outside its text bound`);
  }
  return value;
}

function stableId(value: unknown, label: string): string {
  const result = text(value, label, 128);
  if (!STABLE_ID.test(result)) throw new Error(`${label} is not a stable ID`);
  return result;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} is not a lowercase SHA-256 digest`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function parseBrowserEvidenceArgs(
  args: readonly string[],
): BrowserEvidenceCliOptions {
  const flags = new Map([
    ["--builder-report", "builderReport"],
    ["--candidate-locator", "candidateLocator"],
    ["--context", "context"],
    ["--definitions", "definitions"],
    ["--output", "output"],
    ["--pages", "pages"],
    ["--products", "products"],
    ["--resolved-inputs", "resolvedInputs"],
    ["--runtime-bundle", "runtimeBundle"],
    ["--runtime-root", "runtimeRoot"],
    ["--tests", "tests"],
    ["--vfs", "vfs"],
  ] as const);
  const parsed: Partial<BrowserEvidenceCliOptions> = {};
  if (args.length !== flags.size * 2) return browserEvidenceUsage();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const key = flag === undefined ? undefined : flags.get(flag as never);
    if (
      key === undefined || value === undefined || value.length === 0 ||
      parsed[key] !== undefined
    ) return browserEvidenceUsage();
    parsed[key] = resolve(value);
  }
  return parsed as BrowserEvidenceCliOptions;
}

function browserEvidenceUsage(): never {
  throw new Error(
    "usage: abi-staging-product-browser-evidence.ts " +
    "--context <context.json> --candidate-locator <locator.json> " +
    "--definitions <definitions.json> --products <catalog.json> " +
    "--pages <pages-registry.json> --tests <test-registry.json> " +
    "--runtime-bundle <runtime-bundle.json> --runtime-root <runtime-dir> " +
    "--resolved-inputs <resolved-inputs.json> " +
    "--builder-report <builder-report.json> --vfs <product.vfs.zst> " +
    "--output <result.json>",
  );
}

async function browserEvidenceMain(args: readonly string[]): Promise<void> {
  const options = parseBrowserEvidenceArgs(args);
  const result = await superviseBrowserEvidenceCli(options);
  writeFileSync(options.output, canonicalJsonBytes(result), {
    flag: "wx",
    mode: 0o600,
  });
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void browserEvidenceMain(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
