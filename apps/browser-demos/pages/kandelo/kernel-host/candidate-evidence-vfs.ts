import type { ClosedLazyAsset } from "../../../../../host/src/vfs/closed-lazy-assets";
import {
  hostMountSpecFromProductMounts,
  type VfsMountIntentV1,
} from "../../../../../host/src/vfs/product-mount-contract";
import type { BootDescriptor } from "../../../../../web-libs/kandelo-session/src/kernel-host";

export type CandidateOptionalDemoVfsImage = "node" | "wordpress" | "lamp";

export interface ProtectedCandidateVfsSource {
  schema: 1;
  kind: "kandelo-protected-candidate-vfs";
  productId: string;
  profile: string;
  pagesLoad: "eager" | "lazy" | null;
  sourceKind: "protected-local-candidate-vfs";
  url: string;
  sha256: string;
  bytes: number;
  optionalImage?: CandidateOptionalDemoVfsImage;
}

export interface InjectedProtectedCandidateVfsV1 {
  schema: 1;
  kind: "kandelo-protected-browser-evidence-boot";
  boot: ProtectedBrowserEvidenceBootContract;
  mounts: ProtectedBrowserEvidenceMountIntent[];
  runtime: {
    browserHost: ProtectedBrowserEvidenceRuntimeAsset;
    kernelAsset: ProtectedBrowserEvidenceRuntimeAsset;
  };
  vfs: ProtectedCandidateVfsSource;
}

export interface ProtectedBrowserEvidenceRuntimeAsset {
  url: string;
  sha256: string;
  bytes: number;
}

export interface ProtectedBrowserEvidenceBootContract {
  argv: string[];
  cwd: string;
  uid: number;
  gid: number;
  env: Record<string, string>;
}

export type ProtectedBrowserEvidenceMountIntent = VfsMountIntentV1;

declare global {
  interface Window {
    __KANDELO_ABI_STAGING_BROWSER_EVIDENCE__?: unknown;
    __KANDELO_ABI_STAGING_ACTIVATE_PAGES_PRODUCT__?: () => Promise<void>;
    __KANDELO_ABI_STAGING_LIVE_LEDGER__?: () => {
      lazyDownloads: Array<{ status: string }>;
      packagePrefetches: Array<{
        id: string;
        status: string;
        roots: string[];
        packages?: string[];
      }>;
    };
  }
}

const SHA256 = /^[0-9a-f]{64}$/u;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const MAX_CANDIDATE_VFS_BYTES = 256 * 1024 * 1024;
export const PROTECTED_BROWSER_EVIDENCE_MAX_PROCESS_MEMORY_BYTES =
  2 * 1024 * 1024 * 1024;
export const PROTECTED_BROWSER_EVIDENCE_MAX_OUTPUT_BYTES = 64 * 1024;
export const PROTECTED_BROWSER_EVIDENCE_MAX_OUTPUT_CHUNKS = 4_096;

export class ProtectedBrowserEvidenceOutput {
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;
  private overflow: Error | undefined;

  constructor(
    private readonly maximumBytes = PROTECTED_BROWSER_EVIDENCE_MAX_OUTPUT_BYTES,
    private readonly maximumChunks = PROTECTED_BROWSER_EVIDENCE_MAX_OUTPUT_CHUNKS,
  ) {
    if (
      !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 ||
      !Number.isSafeInteger(maximumChunks) || maximumChunks < 1
    ) {
      throw new Error("protected browser evidence output bounds are invalid");
    }
  }

  append(data: unknown): void {
    if (this.overflow !== undefined) return;
    if (!(data instanceof Uint8Array)) {
      this.overflow = new Error("candidate runtime emitted a malformed output chunk");
      return;
    }
    if (data.byteLength === 0) return;
    if (
      this.chunks.length >= this.maximumChunks ||
      data.byteLength > this.maximumBytes - this.bytes
    ) {
      this.overflow = new Error("candidate runtime output exceeded its protected bound");
      return;
    }
    this.bytes += data.byteLength;
    this.chunks.push(data.slice());
  }

  appendText(value: unknown): void {
    if (typeof value !== "string") {
      this.append(value);
      return;
    }
    this.append(new TextEncoder().encode(value));
  }

  byteLength(): number {
    return this.bytes;
  }

  value(): Uint8Array {
    if (this.overflow !== undefined) throw this.overflow;
    const output = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  text(): string {
    return new TextDecoder().decode(this.value());
  }

  binaryString(): string {
    const bytes = this.value();
    let output = "";
    for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
      output += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return output;
  }
}

export type CandidateEvidenceLiveDemoId =
  | "shell"
  | "c-dev"
  | "node"
  | "nginx"
  | "nginx-php"
  | "wordpress-sqlite"
  | "wordpress-mariadb"
  | "doom"
  | "modeset";

const LIVE_DEMO_BY_EVIDENCE_PROFILE: Readonly<
  Record<string, CandidateEvidenceLiveDemoId>
> = {
  shell: "shell",
  "toolchain-shell": "shell",
  "c-development": "c-dev",
  doom: "doom",
  modeset: "modeset",
  node: "node",
  nginx: "nginx",
  "nginx-php": "nginx-php",
  "wordpress-sqlite": "wordpress-sqlite",
  "wordpress-mariadb": "wordpress-mariadb",
};

export function candidateEvidenceLiveDemoId(
  profile: string,
): CandidateEvidenceLiveDemoId {
  const selected = LIVE_DEMO_BY_EVIDENCE_PROFILE[profile];
  if (selected === undefined) {
    throw new Error(
      `protected browser evidence profile does not use the live Kandelo page: ${profile}`,
    );
  }
  return selected;
}

export function candidateEvidenceBootDescriptor(
  base: BootDescriptor,
  evidence: InjectedProtectedCandidateVfsV1,
): BootDescriptor {
  return {
    ...base,
    id: evidence.vfs.productId,
    title: `${base.title} (candidate evidence)`,
    packages: [],
    mounts: evidence.mounts.map((mount) => mount.source === "built-image"
      ? {
        path: mount.path,
        source: "image" as const,
        ref: `sha256:${evidence.vfs.sha256}`,
        readonly: mount.readonly,
      }
      : {
        path: mount.path,
        source: "scratch" as const,
        ephemeral: mount.ephemeral,
      }),
    boot: {
      argv: evidence.boot.argv.slice(),
      cwd: evidence.boot.cwd,
      uid: evidence.boot.uid,
      gid: evidence.boot.gid,
      env: { ...evidence.boot.env },
    },
  };
}

export function candidateEvidenceKernelInitOptions(
  evidence: InjectedProtectedCandidateVfsV1,
  kernelWasm: ArrayBuffer,
  vfsImage: Uint8Array,
  closedLazyAssets?: readonly ClosedLazyAsset[],
): {
  kernelWasm: ArrayBuffer;
  vfsImage: Uint8Array;
  lazyUrlBase: string;
  rootfsMountSpec: ReturnType<typeof hostMountSpecFromProductMounts>;
  closedLazyAssets?: readonly ClosedLazyAsset[];
} {
  return {
    kernelWasm,
    vfsImage,
    lazyUrlBase: new URL("/", evidence.vfs.url).href,
    rootfsMountSpec: hostMountSpecFromProductMounts(evidence.mounts),
    ...(closedLazyAssets === undefined ? {} : { closedLazyAssets }),
  };
}

export function resolveCandidateEvidenceBootExecutable(
  fs: { stat(path: string): { mode: number } },
  boot: ProtectedBrowserEvidenceBootContract,
): string {
  const requested = boot.argv[0];
  if (requested === undefined || requested.length === 0) {
    throw new Error("protected candidate boot lacks an executable");
  }
  const candidates: string[] = [];
  if (requested.startsWith("/")) {
    candidates.push(checkedAbsolutePath(requested, "protected candidate boot executable"));
  } else {
    if (requested.includes("/")) {
      throw new Error("protected candidate boot executable is neither absolute nor a PATH name");
    }
    const path = boot.env.PATH;
    if (path === undefined || path.length === 0) {
      throw new Error("protected candidate boot PATH is unavailable");
    }
    for (const [index, directory] of path.split(":").entries()) {
      const checked = checkedAbsolutePath(
        directory,
        `protected candidate boot PATH entry ${index}`,
      );
      candidates.push(`${checked === "/" ? "" : checked}/${requested}`);
    }
  }
  for (const candidate of candidates) {
    try {
      const metadata = fs.stat(candidate);
      if ((metadata.mode & 0o170000) === 0o100000 && (metadata.mode & 0o111) !== 0) {
        return candidate;
      }
    } catch {
      // Continue through the exact manifest-owned PATH.
    }
  }
  throw new Error("protected candidate boot executable is absent or not executable");
}

export function readInjectedProtectedCandidateVfs(
  value: unknown,
): ProtectedCandidateVfsSource | undefined {
  return readInjectedProtectedBrowserEvidence(value)?.vfs;
}

export function readInjectedProtectedBrowserEvidence(
  value: unknown,
): InjectedProtectedCandidateVfsV1 | undefined {
  if (value === undefined) return undefined;
  const input = exactObject(
    value,
    ["boot", "kind", "mounts", "runtime", "schema", "vfs"],
    "protected browser evidence boot",
  );
  if (
    input.schema !== 1 ||
    input.kind !== "kandelo-protected-browser-evidence-boot"
  ) {
    throw new Error("protected browser evidence boot identity is unsupported");
  }
  const boot = validateBoot(input.boot);
  const mounts = validateMounts(input.mounts);
  const vfs = validateCandidateVfs(input.vfs);
  const runtime = validateRuntime(input.runtime, vfs);
  return {
    schema: 1,
    kind: "kandelo-protected-browser-evidence-boot",
    boot,
    mounts,
    runtime,
    vfs,
  };
}

function validateRuntime(
  value: unknown,
  vfs: ProtectedCandidateVfsSource,
): InjectedProtectedCandidateVfsV1["runtime"] {
  const runtime = exactObject(
    value,
    ["browserHost", "kernelAsset"],
    "protected browser evidence runtime",
  );
  return {
    browserHost: validateRuntimeAsset(
      runtime.browserHost,
      vfs,
      "browser host",
      "/abi-staging/browser-host.js",
    ),
    kernelAsset: validateRuntimeAsset(
      runtime.kernelAsset,
      vfs,
      "browser kernel",
      ".wasm",
    ),
  };
}

function validateRuntimeAsset(
  value: unknown,
  vfs: ProtectedCandidateVfsSource,
  label: string,
  pathSuffix: string,
): ProtectedBrowserEvidenceRuntimeAsset {
  const asset = exactObject(
    value,
    ["bytes", "sha256", "url"],
    `protected ${label} asset`,
  );
  if (typeof asset.sha256 !== "string" || !SHA256.test(asset.sha256)) {
    throw new Error(`protected ${label} asset digest is invalid`);
  }
  if (
    !Number.isSafeInteger(asset.bytes) || Number(asset.bytes) < 1 ||
    Number(asset.bytes) > 512 * 1024 * 1024
  ) {
    throw new Error(`protected ${label} asset byte count is outside its bound`);
  }
  if (typeof asset.url !== "string") {
    throw new Error(`protected ${label} asset URL is invalid`);
  }
  const url = new URL(asset.url);
  const vfsUrl = new URL(vfs.url);
  if (
    url.protocol !== "http:" || url.origin !== vfsUrl.origin ||
    url.username !== "" || url.password !== "" ||
    url.search !== "" || url.hash !== "" ||
    !url.pathname.endsWith(pathSuffix)
  ) {
    throw new Error(`protected ${label} asset does not use its exact local URL`);
  }
  return {
    url: url.href,
    sha256: asset.sha256,
    bytes: Number(asset.bytes),
  };
}

function validateCandidateVfs(value: unknown): ProtectedCandidateVfsSource {
  const vfs = exactObjectWithOptional(
    value,
    [
      "bytes",
      "kind",
      "pagesLoad",
      "productId",
      "profile",
      "schema",
      "sha256",
      "sourceKind",
      "url",
    ],
    ["optionalImage"],
    "protected candidate VFS",
  );
  if (
    vfs.schema !== 1 ||
    vfs.kind !== "kandelo-protected-candidate-vfs" ||
    vfs.sourceKind !== "protected-local-candidate-vfs"
  ) {
    throw new Error("protected candidate VFS identity is unsupported");
  }
  const productId = checkedStableId(vfs.productId, "candidate VFS product");
  const profile = checkedStableId(vfs.profile, "candidate VFS profile");
  if (vfs.pagesLoad !== null && vfs.pagesLoad !== "eager" && vfs.pagesLoad !== "lazy") {
    throw new Error("candidate VFS Pages load policy is unsupported");
  }
  if (typeof vfs.sha256 !== "string" || !SHA256.test(vfs.sha256)) {
    throw new Error("candidate VFS digest is invalid");
  }
  if (
    !Number.isSafeInteger(vfs.bytes) ||
    Number(vfs.bytes) < 1 ||
    Number(vfs.bytes) > MAX_CANDIDATE_VFS_BYTES
  ) {
    throw new Error("candidate VFS byte count is outside its bound");
  }
  if (typeof vfs.url !== "string") {
    throw new Error("candidate VFS URL is invalid");
  }
  const url = new URL(vfs.url);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.endsWith(`/${productId}/product.vfs.zst`)
  ) {
    throw new Error("candidate VFS does not use its protected local URL");
  }
  let optionalImage: CandidateOptionalDemoVfsImage | undefined;
  if (vfs.optionalImage !== undefined) {
    if (
      vfs.optionalImage !== "node" &&
      vfs.optionalImage !== "wordpress" &&
      vfs.optionalImage !== "lamp"
    ) {
      throw new Error("candidate VFS optional image is unsupported");
    }
    optionalImage = vfs.optionalImage;
  }
  return {
    schema: 1,
    kind: "kandelo-protected-candidate-vfs",
    productId,
    profile,
    pagesLoad: vfs.pagesLoad,
    sourceKind: "protected-local-candidate-vfs",
    url: url.href,
    sha256: vfs.sha256,
    bytes: Number(vfs.bytes),
    ...(optionalImage === undefined ? {} : { optionalImage }),
  };
}

export async function resolveCandidateOrDefaultOptionalVfsUrl(
  image: CandidateOptionalDemoVfsImage,
  candidate: ProtectedCandidateVfsSource | undefined,
  resolveDefault: () => Promise<string>,
): Promise<string> {
  if (candidate === undefined) return resolveDefault();
  if (
    candidate.schema !== 1 ||
    candidate.kind !== "kandelo-protected-candidate-vfs" ||
    candidate.sourceKind !== "protected-local-candidate-vfs" ||
    candidate.optionalImage !== image
  ) {
    throw new Error("protected candidate VFS differs from the requested image");
  }
  return candidate.url;
}

export interface ProtectedCandidatePagesVfsPlacement {
  readonly pagesLoad: "eager" | "lazy" | null;
  activate(): Promise<ArrayBuffer>;
  bytes(): Promise<ArrayBuffer>;
}

export function installProtectedCandidatePagesActivation(
  target: Window,
  placement: ProtectedCandidatePagesVfsPlacement,
  activate: () => Promise<void>,
): void {
  if (placement.pagesLoad === null) {
    throw new Error("non-Pages candidate VFS has no Pages activation boundary");
  }
  let activation: Promise<void> | undefined;
  Object.defineProperty(
    target,
    "__KANDELO_ABI_STAGING_ACTIVATE_PAGES_PRODUCT__",
    {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (): Promise<void> => {
        activation ??= activate();
        return activation;
      },
    },
  );
}

export function createProtectedCandidatePagesVfsPlacement(
  source: ProtectedCandidateVfsSource,
  load: (
    source: ProtectedCandidateVfsSource,
  ) => Promise<ArrayBuffer> = fetchProtectedCandidateVfs,
): ProtectedCandidatePagesVfsPlacement {
  const checked = validateCandidateVfs(source);
  let activated = checked.pagesLoad === null;
  let loaded: Promise<ArrayBuffer> | undefined;
  const start = (): Promise<ArrayBuffer> => {
    loaded ??= load(checked);
    return loaded;
  };

  if (checked.pagesLoad === "eager") {
    // Eager Pages products begin resolving their whole-VFS bytes when the page
    // is loaded, but guest boot remains behind the same explicit product
    // activation boundary used by lazy products.
    const prefetched = start();
    void prefetched.catch(() => {
      // Retain the exact rejection for activate()/bytes() without creating an
      // unhandled rejection before the protected selector crosses the gate.
    });
  }

  return {
    pagesLoad: checked.pagesLoad,
    activate(): Promise<ArrayBuffer> {
      activated = true;
      return start();
    },
    bytes(): Promise<ArrayBuffer> {
      if (!activated) {
        return Promise.reject(
          new Error("candidate Pages VFS is not activated"),
        );
      }
      return start();
    },
  };
}

export async function fetchProtectedCandidateVfs(
  source: ProtectedCandidateVfsSource,
  fetcher: typeof fetch = fetch,
): Promise<ArrayBuffer> {
  const checked = validateCandidateVfs(source);
  const response = await fetcher(checked.url, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`candidate VFS fetch failed with status ${response.status}`);
  }
  const body = await response.arrayBuffer();
  if (body.byteLength !== checked.bytes) {
    throw new Error("candidate VFS byte count differs from its protected identity");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  const actual = Array.from(digest, (value) => value.toString(16).padStart(2, "0"))
    .join("");
  if (actual !== checked.sha256) {
    throw new Error("candidate VFS digest differs from its protected identity");
  }
  return body;
}

export async function fetchProtectedBrowserEvidenceAsset(
  asset: ProtectedBrowserEvidenceRuntimeAsset,
  fetcher: typeof fetch = fetch,
): Promise<ArrayBuffer> {
  const response = await fetcher(asset.url, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`protected browser runtime fetch failed with status ${response.status}`);
  }
  const body = await response.arrayBuffer();
  if (body.byteLength !== asset.bytes) {
    throw new Error("protected browser runtime byte count differs from its identity");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  const actual = Array.from(digest, (value) => value.toString(16).padStart(2, "0"))
    .join("");
  if (actual !== asset.sha256) {
    throw new Error("protected browser runtime digest differs from its identity");
  }
  return body;
}

function validateBoot(value: unknown): ProtectedBrowserEvidenceBootContract {
  const boot = exactObject(
    value,
    ["argv", "cwd", "env", "gid", "uid"],
    "protected browser evidence boot contract",
  );
  if (!Array.isArray(boot.argv) || boot.argv.length < 1 || boot.argv.length > 64) {
    throw new Error("protected browser evidence boot argv is out of bounds");
  }
  const argv = boot.argv.map((item, index) =>
    checkedText(item, `protected browser evidence boot argv ${index}`, 4_096)
  );
  const cwd = checkedAbsolutePath(
    boot.cwd,
    "protected browser evidence boot cwd",
  );
  const uid = checkedUnsignedInteger(
    boot.uid,
    "protected browser evidence boot uid",
  );
  const gid = checkedUnsignedInteger(
    boot.gid,
    "protected browser evidence boot gid",
  );
  if (
    boot.env === null ||
    typeof boot.env !== "object" ||
    Array.isArray(boot.env) ||
    Object.keys(boot.env).length > 64
  ) {
    throw new Error("protected browser evidence boot environment is invalid");
  }
  const env: Record<string, string> = {};
  for (const [name, candidate] of Object.entries(boot.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error("protected browser evidence boot environment name is invalid");
    }
    env[name] = checkedText(
      candidate,
      `protected browser evidence boot environment ${name}`,
      64 * 1024,
    );
  }
  return { argv, cwd, uid, gid, env };
}

function validateMounts(value: unknown): ProtectedBrowserEvidenceMountIntent[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new Error("protected browser evidence mounts are out of bounds");
  }
  const mounts: ProtectedBrowserEvidenceMountIntent[] = [];
  const paths = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`protected browser evidence mount ${index} is invalid`);
    }
    const source = (candidate as Record<string, unknown>).source;
    if (source === "built-image") {
      const mount = exactObject(
        candidate,
        ["path", "readonly", "source"],
        `protected browser evidence mount ${index}`,
      );
      if (typeof mount.readonly !== "boolean") {
        throw new Error("protected browser evidence image mount readonly is invalid");
      }
      const path = checkedAbsolutePath(
        mount.path,
        `protected browser evidence mount ${index} path`,
      );
      mounts.push({ source, path, readonly: mount.readonly });
    } else if (source === "scratch") {
      const mount = exactObject(
        candidate,
        ["ephemeral", "gid", "mode", "path", "source", "uid"],
        `protected browser evidence mount ${index}`,
      );
      if (typeof mount.mode !== "string" || !/^[0-7]{3,4}$/u.test(mount.mode)) {
        throw new Error("protected browser evidence scratch mode is invalid");
      }
      if (typeof mount.ephemeral !== "boolean") {
        throw new Error("protected browser evidence scratch lifetime is invalid");
      }
      mounts.push({
        source,
        path: checkedAbsolutePath(
          mount.path,
          `protected browser evidence mount ${index} path`,
        ),
        mode: mount.mode,
        uid: checkedUnsignedInteger(
          mount.uid,
          `protected browser evidence mount ${index} uid`,
        ),
        gid: checkedUnsignedInteger(
          mount.gid,
          `protected browser evidence mount ${index} gid`,
        ),
        ephemeral: mount.ephemeral,
      });
    } else {
      throw new Error("protected browser evidence mount source is unsupported");
    }
    const path = mounts[mounts.length - 1]!.path;
    if (paths.has(path)) {
      throw new Error("protected browser evidence mount paths are duplicated");
    }
    paths.add(path);
  }
  if (
    mounts.filter((mount) => mount.source === "built-image").length !== 1 ||
    mounts[0]?.source !== "built-image" ||
    mounts[0]?.path !== "/"
  ) {
    throw new Error("protected browser evidence mounts lack one root image");
  }
  return mounts;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const result = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} fields differ`);
  }
  return result;
}

function exactObjectWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const result = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(result, key)) ||
    Object.keys(result).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} fields differ`);
  }
  return result;
}

function checkedStableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !STABLE_ID.test(value)) {
    throw new Error(`${label} is not a stable ID`);
  }
  return value;
}

function checkedText(value: unknown, label: string, maximum: number): string {
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

function checkedAbsolutePath(value: unknown, label: string): string {
  const path = checkedText(value, label, 4_096);
  if (
    !path.startsWith("/") ||
    (path.length > 1 && path.endsWith("/")) ||
    (path !== "/" && path.split("/").some(
      (part, index) =>
        index > 0 && (part === "" || part === "." || part === ".."),
    ))
  ) {
    throw new Error(`${label} is not a normalized absolute path`);
  }
  return path;
}

function checkedUnsignedInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 0xffff_ffff) {
    throw new Error(`${label} is outside its integer bound`);
  }
  return Number(value);
}
