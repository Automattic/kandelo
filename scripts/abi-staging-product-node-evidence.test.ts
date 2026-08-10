import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";
import { addSealedLazyAtomicTestTree } from "../host/test/lazy-atomic-seal-fixture";
import { buildKandeloSdkVfsImage } from "../images/vfs/scripts/build-kandelo-sdk-vfs-image";

import {
  EvidenceTimeoutError,
  BoundedEvidenceOutput,
  assertUncredentialedEnvironment,
  canonicalJsonBytes,
  evidenceDefinitionSha256,
  formatMysqlEvidenceResult,
  formatRedisEvidenceResult,
  createBoundedKernelPipeTransport,
  compileSdkFixtureFromCandidateVfs,
  classifySupervisorLifecycleError,
  hostMountSpecFromProductMounts,
  loadExactNodeKernelHostConstructor,
  nodeEvidenceHostOptions,
  protectedNodeSuiteDefinition,
  runNodeProductEvidence,
  superviseNodeEvidenceCli,
  runtimeIdentityFromBundle,
  sha256Hex,
  validateNodeEvidenceContext,
  validateCandidateVfsLazyInventory,
  validateExactSdkCompilerSourceRoot,
  validateExactRuntimeArtifactRoot,
  validateProtectedNodeSuiteStep,
  validateProductEvidenceResult,
  type GeneratedEvidenceDefinitionV1,
  type GeneratedEvidenceDefinitionRegistryV1,
  type NodeEvidenceAdapter,
  type NodeEvidenceContextV1,
  type NodeEvidenceExecutionInputs,
  type NodeEvidenceOperation,
  type ProtectedVfsProductCatalogV1,
  type CliOptions,
} from "./abi-staging-product-node-evidence";

const repositoryRoot = resolve(import.meta.dirname, "..");
const generatedDefinitions = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "abi/staging/evidence-definitions.generated.json"),
    "utf8",
  ),
) as GeneratedEvidenceDefinitionRegistryV1;
const productCatalog = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "images/vfs/products/generated/catalog.json"),
    "utf8",
  ),
) as ProtectedVfsProductCatalogV1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FIXTURE_TARGET_ABI = {
  version: 8,
  snapshot_sha256: "3".repeat(64),
} as const;

function lazyFixtureIdentity(id: string) {
  const bytes = encoder.encode(`lazy fixture ${id}`);
  const sha256 = sha256Hex(bytes);
  return {
    bytes,
    sha256,
    url:
      `https://ghcr.io/kandelo-dev/homebrew-tap-core-abi-` +
      `${FIXTURE_TARGET_ABI.version}-candidates/lazy/${id}@sha256:${sha256}`,
  };
}

async function createFixtureVfs(lazyIds: readonly string[]): Promise<Uint8Array> {
  const vfs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  for (const [index, id] of lazyIds.entries()) {
    const fixture = lazyFixtureIdentity(id);
    vfs.registerLazyFile(
      `/lazy/${index}-${id}`,
      fixture.url,
      fixture.bytes.byteLength,
      0o444,
    );
  }
  return vfs.saveImage({
    metadata: {
      version: 1,
      kernelAbi: FIXTURE_TARGET_ABI.version,
      abiSnapshotSha256: FIXTURE_TARGET_ABI.snapshot_sha256,
      createdBy: "abi-staging-product-node-evidence.test.ts",
    },
  });
}

const VFS_BYTES = await createFixtureVfs([]);
const fixtureVfsByDefinition = new Map<string, Uint8Array>();
for (const definition of generatedDefinitions.definitions) {
  if (definition.host !== "node") continue;
  const lazyIds = definition.probe.lazy_inputs === undefined
    ? []
    : definition.probe.lazy_inputs as string[];
  fixtureVfsByDefinition.set(definition.id, await createFixtureVfs(lazyIds));
}

function fixtureVfsForDefinition(definition: GeneratedEvidenceDefinitionV1): Uint8Array {
  const bytes = fixtureVfsByDefinition.get(definition.id);
  assert.ok(bytes, `missing miniature VFS fixture for ${definition.id}`);
  return bytes;
}
const RUNTIME_FILES = {
  "flake.lock": encoder.encode('{"nodes":{},"root":"root","version":7}\n'),
  "browser/dist/abi-staging-harness/index.html": encoder.encode(
    "<!doctype html><title>protected evidence harness</title>\n",
  ),
  "browser/dist/abi-staging/browser-host.js": encoder.encode(
    "export class BrowserKernel {}\n",
  ),
  "browser/dist/index.js": encoder.encode("export const browser = true;\n"),
  "browser/dist/kernel.wasm": encoder.encode("miniature kernel"),
  "browser/dist/service-worker.js": encoder.encode("service worker"),
  "host/dist/a-b.js": encoder.encode("export const dash = true;\n"),
  "host/dist/a_b.js": encoder.encode("export const underscore = true;\n"),
  "host/dist/index.js": encoder.encode("export class NodeKernelHost {}\n"),
  "host/dist/node-kernel-worker-entry.js": encoder.encode("export {};\n"),
  "host/generated-abi.ts": encoder.encode("export const ABI_VERSION = 8;\n"),
  "host/package.json": encoder.encode('{"type":"module"}\n'),
  "host/worker-protocol.ts": encoder.encode("export type Message = never;\n"),
  "kernel.wasm": encoder.encode("miniature kernel"),
} as const;

function inventoryEntry(path: keyof typeof RUNTIME_FILES) {
  const bytes = RUNTIME_FILES[path];
  return { bytes: bytes.byteLength, path, sha256: sha256Hex(bytes) };
}

const runtimeInventory = (Object.keys(RUNTIME_FILES) as Array<keyof typeof RUNTIME_FILES>)
  .sort()
  .map(inventoryEntry);
const hostInventory = runtimeInventory.filter((entry) => entry.path.startsWith("host/"));
const browserInventory = runtimeInventory.filter((entry) => entry.path.startsWith("browser/"));
const RUNTIME_BUNDLE = {
  schema: 1,
  kind: "kandelo-exact-runtime-bundle",
  source: {
    repository: "kandelo-dev/kandelo",
    commit: "1".repeat(40),
    tree: "2".repeat(40),
  },
  target_abi: FIXTURE_TARGET_ABI,
  kernel: {
    wasm_sha256: sha256Hex(RUNTIME_FILES["kernel.wasm"]),
    bytes: RUNTIME_FILES["kernel.wasm"].byteLength,
    abi_version: 8,
    snapshot_sha256: "3".repeat(64),
  },
  host: {
    bundle_sha256: sha256Hex(canonicalJsonBytes(hostInventory)),
    bytes: hostInventory.reduce((total, entry) => total + entry.bytes, 0),
    generated_abi_sha256: sha256Hex(RUNTIME_FILES["host/generated-abi.ts"]),
    worker_protocol_sha256: sha256Hex(RUNTIME_FILES["host/worker-protocol.ts"]),
  },
  browser: {
    bundle_sha256: sha256Hex(canonicalJsonBytes(browserInventory)),
    bytes: browserInventory.reduce((total, entry) => total + entry.bytes, 0),
    harness_entry_bytes:
      RUNTIME_FILES["browser/dist/abi-staging-harness/index.html"].byteLength,
    harness_entry_path: "browser/dist/abi-staging-harness/index.html",
    harness_entry_sha256: sha256Hex(
      RUNTIME_FILES["browser/dist/abi-staging-harness/index.html"],
    ),
    host_entry_bytes:
      RUNTIME_FILES["browser/dist/abi-staging/browser-host.js"].byteLength,
    host_entry_path: "browser/dist/abi-staging/browser-host.js",
    host_entry_sha256: sha256Hex(
      RUNTIME_FILES["browser/dist/abi-staging/browser-host.js"],
    ),
    kernel_asset_path: "browser/dist/kernel.wasm",
    kernel_asset_sha256: sha256Hex(RUNTIME_FILES["browser/dist/kernel.wasm"]),
    service_worker_sha256: sha256Hex(RUNTIME_FILES["browser/dist/service-worker.js"]),
  },
  build_policy_sha256: "4".repeat(64),
  inventory: runtimeInventory,
};
const RUNTIME_BUNDLE_BYTES = canonicalJsonBytes(RUNTIME_BUNDLE);

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

function devShellToolDirectory(...tools: string[]): string {
  for (const entry of (process.env.PATH ?? "").split(":")) {
    if (entry !== "" && tools.every((tool) => existsSync(join(entry, tool)))) {
      return entry;
    }
  }
  throw new Error(`dev shell lacks a directory containing ${tools.join(", ")}`);
}

function exactCompilerSourceFixture(root: string) {
  const sourceRoot = join(root, "exact-source");
  execFileSync(
    "git",
    ["clone", "-q", "--shared", "--no-checkout", repositoryRoot, sourceRoot],
  );
  execFileSync("git", ["checkout", "-q", "HEAD"], { cwd: sourceRoot });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
  const lockSha256 = sha256Hex(new Uint8Array(readFileSync(join(sourceRoot, "flake.lock"))));
  return validateExactSdkCompilerSourceRoot(
    sourceRoot,
    { repository: "Automattic/kandelo", commit, tree },
    lockSha256,
  );
}

async function realSdkFixtureVfs(
  root: string,
  candidateSource?: string,
): Promise<Uint8Array> {
  const llvmDirectory = devShellToolDirectory("clang", "wasm-ld");
  const bashPath = join(devShellToolDirectory("bash"), "bash");
  const resourceDirectory = execFileSync(
    join(llvmDirectory, "clang"),
    ["--print-resource-dir"],
    { encoding: "utf8" },
  ).trim();
  const glueObjects = join(root, "glue-objects");
  mkdirSync(glueObjects);
  const wrapper = join(repositoryRoot, "sdk/kandelo/bin/wasm32posix-cc");
  for (const name of ["channel_syscall", "compiler_rt", "cxxrt", "dlopen"]) {
    const source = join(repositoryRoot, `libc/glue/${name}.c`);
    const output = join(glueObjects, `${name}.o`);
    const result = spawnSync(
      bashPath,
      [wrapper, "-O2", "-c", source, "-o", output],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          WASM_POSIX_CLANG_RESOURCE_DIR: resourceDirectory,
          WASM_POSIX_GLUE_DIR: join(repositoryRoot, "libc/glue"),
          WASM_POSIX_GLUE_OBJ_DIR: glueObjects,
          WASM_POSIX_LLVM_DIR: llvmDirectory,
          WASM_POSIX_SYSROOT: join(repositoryRoot, "sysroot"),
        },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    assert.equal(
      result.status,
      0,
      `cannot build ${name}.o for the SDK fixture:\n${result.stdout}\n${result.stderr}`,
    );
  }
  const snapshotBytes = new Uint8Array(
    readFileSync(join(repositoryRoot, "abi/snapshot.json")),
  );
  const snapshot = JSON.parse(decoder.decode(snapshotBytes)) as {
    abi_version: number;
  };
  // Model the staged product builder: the sysroot and libc++ are separate
  // declared inputs. The developer sysroot may point at a machine-local
  // libc++ cache, which must never be preserved in candidate VFS bytes.
  const stagedSysroot = join(root, "staged-sysroot");
  cpSync(join(repositoryRoot, "sysroot"), stagedSysroot, { recursive: true });
  rmSync(join(stagedSysroot, "include/c++/v1"), {
    recursive: true,
    force: true,
  });
  rmSync(join(stagedSysroot, "lib/libc++.a"), { force: true });
  rmSync(join(stagedSysroot, "lib/libc++abi.a"), { force: true });
  const libcxxHeaders = realpathSync(
    join(repositoryRoot, "sysroot/include/c++/v1"),
  );
  const libcxxDirectory = resolve(libcxxHeaders, "../../..");
  const outputPath = join(root, "developer-kandelo-sdk.vfs.zst");
  await buildKandeloSdkVfsImage({
    sysrootDirectory: stagedSysroot,
    glueDirectory: join(repositoryRoot, "libc/glue"),
    glueObjectsDirectory: glueObjects,
    sdkBinDirectory: join(repositoryRoot, "sdk/kandelo/bin"),
    configSitePath: join(repositoryRoot, "sdk/config.site"),
    clangResourceDirectory: resourceDirectory,
    libcxxDirectory,
    licenseFiles: [
      {
        hostPath: join(repositoryRoot, "LICENSE"),
        guestPath: "/usr/share/licenses/kandelo/LICENSE",
      },
      {
        hostPath: join(repositoryRoot, "COPYING.runtime"),
        guestPath: "/usr/share/licenses/kandelo/COPYING.runtime",
      },
      {
        hostPath: join(repositoryRoot, "libc/musl/COPYRIGHT"),
        guestPath: "/usr/share/licenses/musl/COPYRIGHT",
      },
      {
        hostPath: join(repositoryRoot, "sdk/kandelo/licenses/LLVM-LICENSE.TXT"),
        guestPath: "/usr/share/licenses/llvm/LICENSE.TXT",
      },
    ],
    outputPath,
    targetAbi: {
      version: snapshot.abi_version,
      snapshotSha256: sha256Hex(snapshotBytes),
    },
  });
  const image = new Uint8Array(readFileSync(outputPath));
  if (candidateSource === undefined) return image;
  const fs = MemoryFileSystem.fromImage(image);
  fs.createFileWithOwner(
    "/home/hello.c",
    0o644,
    1000,
    1000,
    encoder.encode(candidateSource),
  );
  return fs.saveImage();
}

function writeExactRuntimeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "kandelo-node-evidence-runtime-"));
  for (const [path, bytes] of Object.entries(RUNTIME_FILES)) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  return root;
}

function exactBuiltHostRuntimeFixture(
  root: string,
  hostDist: string,
  compilerSource: ReturnType<typeof exactCompilerSourceFixture>,
): {
  runtimeRoot: string;
  runtimeBundleBytes: Uint8Array;
  kernelWasmBytes: Uint8Array;
} {
  const runtimeRoot = join(root, "exact-runtime");
  const hostRuntimeDist = join(runtimeRoot, "host/dist");
  mkdirSync(join(runtimeRoot, "host"), { recursive: true });
  cpSync(hostDist, hostRuntimeDist, { recursive: true });
  mkdirSync(join(runtimeRoot, "browser/dist"), { recursive: true });
  const kernelWasmBytes = new Uint8Array(readFileSync(
    join(repositoryRoot, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm"),
  ));
  const snapshotBytes = new Uint8Array(readFileSync(join(repositoryRoot, "abi/snapshot.json")));
  const snapshot = JSON.parse(decoder.decode(snapshotBytes)) as { abi_version: number };
  const generatedAbiBytes = new Uint8Array(readFileSync(
    join(repositoryRoot, "host/src/generated/abi.ts"),
  ));
  const workerProtocolBytes = new Uint8Array(readFileSync(
    join(repositoryRoot, "host/src/worker-protocol.ts"),
  ));
  const browserBundleBytes = encoder.encode("exact browser fixture\n");
  const browserHarnessBytes = encoder.encode(
    "<!doctype html><title>protected evidence harness</title>\n",
  );
  const browserHostBytes = encoder.encode("export class BrowserKernel {}\n");
  const serviceWorkerBytes = encoder.encode("exact service worker fixture\n");
  const files: Array<[string, Uint8Array]> = [
    ["kernel.wasm", kernelWasmBytes],
    ["flake.lock", new Uint8Array(readFileSync(join(compilerSource.sourceRoot, "flake.lock")))],
    ["host/generated-abi.ts", generatedAbiBytes],
    ["host/worker-protocol.ts", workerProtocolBytes],
    ["host/package.json", canonicalJsonBytes({ type: "module" })],
    ["browser/dist/index.js", browserBundleBytes],
    ["browser/dist/abi-staging-harness/index.html", browserHarnessBytes],
    ["browser/dist/abi-staging/browser-host.js", browserHostBytes],
    ["browser/dist/kernel.wasm", kernelWasmBytes],
    ["browser/dist/service-worker.js", serviceWorkerBytes],
  ];
  for (const [path, bytes] of files) {
    const destination = join(runtimeRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  const inventory: Array<{ bytes: number; path: string; sha256: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      assert.equal(metadata.isSymbolicLink(), false, `built host contains symlink ${path}`);
      if (metadata.isDirectory()) {
        visit(path);
      } else {
        assert.equal(metadata.isFile(), true, `built host contains nonregular file ${path}`);
        const body = new Uint8Array(readFileSync(path));
        inventory.push({
          bytes: body.byteLength,
          path: path.slice(runtimeRoot.length + 1).split("\\").join("/"),
          sha256: sha256Hex(body),
        });
      }
    }
  };
  visit(runtimeRoot);
  inventory.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const hostInventory = inventory.filter((entry) => entry.path.startsWith("host/"));
  const browserInventory = inventory.filter((entry) => entry.path.startsWith("browser/"));
  const runtimeBundle = {
    schema: 1,
    kind: "kandelo-exact-runtime-bundle",
    source: compilerSource.source,
    target_abi: {
      version: snapshot.abi_version,
      snapshot_sha256: sha256Hex(snapshotBytes),
    },
    kernel: {
      wasm_sha256: sha256Hex(kernelWasmBytes),
      bytes: kernelWasmBytes.byteLength,
      abi_version: snapshot.abi_version,
      snapshot_sha256: sha256Hex(snapshotBytes),
    },
    host: {
      bundle_sha256: sha256Hex(canonicalJsonBytes(hostInventory)),
      bytes: hostInventory.reduce((total, entry) => total + entry.bytes, 0),
      generated_abi_sha256: sha256Hex(generatedAbiBytes),
      worker_protocol_sha256: sha256Hex(workerProtocolBytes),
    },
    browser: {
      bundle_sha256: sha256Hex(canonicalJsonBytes(browserInventory)),
      bytes: browserInventory.reduce((total, entry) => total + entry.bytes, 0),
      harness_entry_bytes: browserHarnessBytes.byteLength,
      harness_entry_path: "browser/dist/abi-staging-harness/index.html",
      harness_entry_sha256: sha256Hex(browserHarnessBytes),
      host_entry_bytes: browserHostBytes.byteLength,
      host_entry_path: "browser/dist/abi-staging/browser-host.js",
      host_entry_sha256: sha256Hex(browserHostBytes),
      kernel_asset_path: "browser/dist/kernel.wasm",
      kernel_asset_sha256: sha256Hex(kernelWasmBytes),
      service_worker_sha256: sha256Hex(serviceWorkerBytes),
    },
    build_policy_sha256: "8".repeat(64),
    inventory,
  } as const;
  return {
    runtimeRoot,
    runtimeBundleBytes: canonicalJsonBytes(runtimeBundle),
    kernelWasmBytes,
  };
}

function writeCliFixtureInputs(
  root: string,
  inputs: NodeEvidenceExecutionInputs,
  runtimeRoot: string,
  sourceRoot?: string,
): CliOptions {
  const paths = {
    builderReport: join(root, "real-builder-report.json"),
    context: join(root, "real-context.json"),
    candidateLocator: join(root, "real-candidate-locator.json"),
    definitions: join(root, "real-definitions.json"),
    products: join(root, "real-products.json"),
    resolvedInputs: join(root, "real-resolved-inputs.json"),
    runtimeBundle: join(root, "real-runtime-bundle.json"),
    vfs: join(root, "real-product.vfs"),
    output: join(root, "real-result.json"),
  };
  writeFileSync(paths.context, canonicalJsonBytes(inputs.context));
  writeFileSync(paths.candidateLocator, canonicalJsonBytes(inputs.candidateLocator));
  writeFileSync(paths.definitions, canonicalJsonBytes(inputs.protectedDefinitions));
  writeFileSync(paths.products, canonicalJsonBytes(inputs.protectedProducts));
  writeFileSync(paths.resolvedInputs, inputs.resolvedInputsBytes);
  writeFileSync(paths.builderReport, inputs.builderReportBytes);
  writeFileSync(paths.runtimeBundle, inputs.runtimeBundleBytes);
  writeFileSync(paths.vfs, inputs.vfsBytes);
  return { ...paths, runtimeRoot, ...(sourceRoot === undefined ? {} : { sourceRoot }) };
}

function supervisedCliFixture(hostModuleSource: string): {
  root: string;
  options: CliOptions;
} {
  const root = mkdtempSync(join(tmpdir(), "kandelo-node-evidence-supervisor-test-"));
  const runtimeRoot = join(root, "runtime");
  const files: Record<string, Uint8Array> = {
    ...RUNTIME_FILES,
    "host/dist/index.js": encoder.encode(hostModuleSource),
  };
  for (const [path, bytes] of Object.entries(files)) {
    const destination = join(runtimeRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  const inventory = Object.keys(files).sort().map((path) => ({
    bytes: files[path]!.byteLength,
    path,
    sha256: sha256Hex(files[path]!),
  }));
  const hostInventory = inventory.filter((entry) => entry.path.startsWith("host/"));
  const runtimeBundle = {
    ...RUNTIME_BUNDLE,
    host: {
      ...RUNTIME_BUNDLE.host,
      bundle_sha256: sha256Hex(canonicalJsonBytes(hostInventory)),
      bytes: hostInventory.reduce((total, entry) => total + entry.bytes, 0),
    },
    inventory,
  };
  const runtimeBundleBytes = canonicalJsonBytes(runtimeBundle);
  const baseDefinition = generatedDefinitions.definitions.find(
    (candidate) => candidate.id === "node-vfs-node-startup",
  )!;
  const definition = {
    ...baseDefinition,
    timeout_seconds: 1,
    definition_sha256: "",
  };
  definition.definition_sha256 = evidenceDefinitionSha256(definition);
  const context = contextFor(definition, {
    runtime: runtimeIdentityFromBundle(runtimeBundleBytes),
  });
  const protectedDefinitions = {
    ...generatedDefinitions,
    definitions: generatedDefinitions.definitions.map((candidate) =>
      candidate.id === definition.id ? definition : candidate
    ),
  };
  const inputs = executionInputsBase(context);
  const paths = {
    builderReport: join(root, "builder-report.json"),
    context: join(root, "context.json"),
    candidateLocator: join(root, "candidate-locator.json"),
    definitions: join(root, "definitions.json"),
    products: join(root, "products.json"),
    resolvedInputs: join(root, "resolved-inputs.json"),
    runtimeBundle: join(root, "runtime-bundle.json"),
    vfs: join(root, "product.vfs"),
    output: join(root, "result.json"),
  };
  writeFileSync(paths.context, canonicalJsonBytes(context));
  writeFileSync(paths.candidateLocator, canonicalJsonBytes(inputs.candidateLocator));
  writeFileSync(paths.definitions, canonicalJsonBytes(protectedDefinitions));
  writeFileSync(paths.products, canonicalJsonBytes(productCatalog));
  writeFileSync(paths.resolvedInputs, inputs.resolvedInputsBytes);
  writeFileSync(paths.builderReport, inputs.builderReportBytes);
  writeFileSync(paths.runtimeBundle, runtimeBundleBytes);
  writeFileSync(paths.vfs, VFS_BYTES);
  return {
    root,
    options: { ...paths, runtimeRoot },
  };
}

function replaceSupervisedCandidateVfs(
  fixture: ReturnType<typeof supervisedCliFixture>,
  vfsBytes: Uint8Array,
): void {
  const context = JSON.parse(readFileSync(fixture.options.context, "utf8")) as
    NodeEvidenceContextV1;
  const locator = JSON.parse(readFileSync(fixture.options.candidateLocator, "utf8")) as
    ReturnType<typeof executionInputsBase>["candidateLocator"];
  const report = JSON.parse(readFileSync(fixture.options.builderReport, "utf8")) as {
    output: { bytes: number; sha256: string };
  };
  const vfsSha256 = sha256Hex(vfsBytes);
  context.candidate_product.vfs_layer_bytes = vfsBytes.byteLength;
  context.candidate_product.vfs_layer_sha256 = vfsSha256;
  locator.vfs_layer_bytes = vfsBytes.byteLength;
  locator.vfs_layer_sha256 = vfsSha256;
  report.output.bytes = vfsBytes.byteLength;
  report.output.sha256 = vfsSha256;
  const reportBytes = canonicalJsonBytes(report);
  const reportSha256 = sha256Hex(reportBytes);
  context.candidate_product.builder_report_sha256 = reportSha256;
  locator.builder_report_sha256 = reportSha256;
  writeFileSync(fixture.options.vfs, vfsBytes);
  writeFileSync(fixture.options.builderReport, reportBytes);
  writeFileSync(fixture.options.context, canonicalJsonBytes(context));
  writeFileSync(fixture.options.candidateLocator, canonicalJsonBytes(locator));
}

function productForDefinition(definitionId: string) {
  const product = productCatalog.products.find(
    (entry) => entry.manifest.evidence.node?.test === definitionId,
  );
  assert.ok(product, `no product owns Node definition ${definitionId}`);
  assert.ok(product.manifest.boot, `product ${product.manifest.id} lacks a boot contract`);
  return product as typeof product & {
    manifest: typeof product.manifest & { boot: NodeEvidenceContextV1["boot"] };
  };
}

function contextFor(
  definition: GeneratedEvidenceDefinitionV1,
  overrides: Partial<NodeEvidenceContextV1> = {},
): NodeEvidenceContextV1 {
  const product = productCatalog.products.find(
    (entry) => entry.manifest.evidence.node?.test === definition.id,
  ) ?? productForDefinition("rootfs-node-startup");
  assert.ok(product.manifest.boot, `product ${product.manifest.id} lacks a boot contract`);
  const context: NodeEvidenceContextV1 = {
    schema: 1,
    kind: "kandelo-vfs-product-node-evidence-context",
    request_digest: "5".repeat(64),
    product: { id: product.manifest.id, manifest_sha256: product.sha256 },
    candidate_product: {
      manifest_digest: `sha256:${"6".repeat(64)}`,
      vfs_layer_sha256: sha256Hex(fixtureVfsForDefinition(definition)),
      vfs_layer_bytes: fixtureVfsForDefinition(definition).byteLength,
      builder_report_sha256: "7".repeat(64),
    },
    runtime: runtimeIdentityFromBundle(RUNTIME_BUNDLE_BYTES),
    host: "node",
    definition,
    boot: product.manifest.boot,
    mounts: product.manifest.mounts,
    run: {
      repository: "kandelo-dev/kandelo",
      workflow_ref: "kandelo-dev/kandelo/.github/workflows/evidence.yml@refs/heads/protected",
      run_id: 101,
      job_id: "node-product-evidence",
      attempt: 1,
    },
    ...overrides,
  };
  context.candidate_product = {
    ...context.candidate_product,
    builder_report_sha256: sha256Hex(candidateInputDocuments(context).builderReportBytes),
  };
  return context;
}

function candidateInputDocuments(
  context: NodeEvidenceContextV1,
  runtimeBundleBytes: Uint8Array = RUNTIME_BUNDLE_BYTES,
) {
  const product = productCatalog.products.find(
    (entry) => entry.manifest.id === context.product.id,
  );
  assert.ok(product, `no protected product ${context.product.id}`);
  const lazyIds = context.definition.probe.lazy_inputs === undefined
    ? []
    : [...context.definition.probe.lazy_inputs as string[]];
  const lazyInputs = lazyIds.map((id) => {
    const fixture = lazyFixtureIdentity(id);
    return {
      architecture: product.manifest.architecture,
      bytes: fixture.bytes.byteLength,
      declared_materialization: "lazy",
      effective_materialization: "lazy-reference",
      id,
      kind: "package-output",
      reference: fixture.url,
      role: "runtime",
      sha256: fixture.sha256,
    };
  });
  const resolved = {
    build_environment: {
      dev_shell_lock_sha256: (
        JSON.parse(decoder.decode(runtimeBundleBytes)) as typeof RUNTIME_BUNDLE
      ).inventory.find((entry) => entry.path === "flake.lock")!.sha256,
      policy_sha256: context.runtime.build_policy_sha256,
    },
    inputs: lazyInputs,
    kind: "kandelo-resolved-vfs-product-inputs",
    product: {
      architecture: product.manifest.architecture,
      id: context.product.id,
      manifest_path: product.path,
      manifest_sha256: context.product.manifest_sha256,
      output: product.manifest.output,
    },
    reference_class: "candidate",
    schema: 1,
    source: context.runtime.source,
    target_abi: context.runtime.target_abi,
  };
  const resolvedInputsBytes = canonicalJsonBytes(resolved);
  const report = {
    capture: { complete: true, unreported_reads: [] },
    inputs: lazyInputs.map((input) => ({
      bytes: input.bytes,
      id: input.id,
      kind: input.kind,
      placement: input.effective_materialization,
      role: input.role,
      sha256: input.sha256,
    })),
    kind: "kandelo-vfs-builder-report",
    output: {
      abi: context.runtime.target_abi,
      bytes: context.candidate_product.vfs_layer_bytes,
      name: product.manifest.output,
      path: product.manifest.output,
      sha256: context.candidate_product.vfs_layer_sha256,
    },
    product: resolved.product,
    resolved_inputs_sha256: sha256Hex(resolvedInputsBytes),
    schema: 1,
  };
  return {
    builderReportBytes: canonicalJsonBytes(report),
    lazyAssetSources: lazyInputs.map((input) => ({
      url: input.reference,
      sourceUrl: input.reference,
      sha256: input.sha256,
      size: input.bytes,
    })),
    resolvedInputsBytes,
  };
}

interface AdapterCalls {
  operations: NodeEvidenceOperation[];
  canceled: number;
  disposed: number;
  lazyFetches: string[];
}

function successfulAdapter(
  definition: GeneratedEvidenceDefinitionV1,
  calls: AdapterCalls = { operations: [], canceled: 0, disposed: 0, lazyFetches: [] },
): NodeEvidenceAdapter {
  const probe = definition.probe as Record<string, unknown>;
  const record = <T extends NodeEvidenceOperation>(operation: T): T => {
    calls.operations.push(operation);
    return operation;
  };
  return {
    async exec(operation) {
      record(operation);
      return {
        status: Number(probe.expected_status ?? 0),
        stdout: String(probe.stdout_exact ?? probe.stdout_contains ?? ""),
        stderr: "",
      };
    },
    async http(operation) {
      record(operation);
      return {
        status: Number(probe.status),
        body: String(probe.body_exact ?? probe.body_contains ?? ""),
        stdout: "",
        stderr: "",
      };
    },
    async compile(operation) {
      record(operation);
      return { status: 0, stdout: "hello from Kandelo clang\n", stderr: "" };
    },
    async sql(operation) {
      record(operation);
      return {
        results: [...(probe.results_exact as string[])],
        stdout: "",
        stderr: "",
      };
    },
    async serviceProtocol(operation) {
      record(operation);
      return {
        response: String(probe.response_exact),
        stdout: "",
        stderr: "",
      };
    },
    async repositorySuite(operation) {
      record(operation);
      return { status: 0, stdout: "registered-suite-ok\n", stderr: "" };
    },
    async lazyDownloads() {
      const lazyIds = definition.probe.lazy_inputs === undefined
        ? []
        : definition.probe.lazy_inputs as string[];
      return lazyIds.flatMap((id) => {
        calls.lazyFetches.push(id);
        const fixture = lazyFixtureIdentity(id);
        return [
          {
            phase: "operation" as const,
            status: "started" as const,
            url: fixture.url,
            loaded_bytes: 0,
            total_bytes: fixture.bytes.byteLength,
          },
          {
            phase: "operation" as const,
            status: "complete" as const,
            url: fixture.url,
            loaded_bytes: fixture.bytes.byteLength,
            total_bytes: fixture.bytes.byteLength,
          },
        ];
      });
    },
    async cancel() {
      calls.canceled++;
    },
    async dispose() {
      calls.disposed++;
    },
  };
}

function executionInputs(
  context: NodeEvidenceContextV1,
  overrides: Partial<ReturnType<typeof executionInputsBase>> = {},
) {
  return { ...executionInputsBase(context), ...overrides };
}

function executionInputsBase(context: NodeEvidenceContextV1) {
  const repository =
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${context.runtime.target_abi.version}` +
    `-candidates/products/${context.product.id}`;
  const documents = candidateInputDocuments(context);
  return {
    context,
    candidateLocator: {
      product_id: context.product.id,
      repository,
      manifest_digest: context.candidate_product.manifest_digest,
      immutable_reference:
        `${repository}@${context.candidate_product.manifest_digest}`,
      vfs_layer_sha256: context.candidate_product.vfs_layer_sha256,
      vfs_layer_bytes: context.candidate_product.vfs_layer_bytes,
      builder_report_sha256: context.candidate_product.builder_report_sha256,
    },
    protectedDefinitions: generatedDefinitions,
    protectedProducts: productCatalog,
    vfsBytes: fixtureVfsForDefinition(context.definition),
    runtimeBundleBytes: RUNTIME_BUNDLE_BYTES,
    kernelWasmBytes: RUNTIME_FILES["kernel.wasm"],
    ...documents,
  };
}

function executionInputsForVfs(
  definition: GeneratedEvidenceDefinitionV1,
  vfsBytes: Uint8Array,
) {
  const context = contextFor(definition);
  context.candidate_product.vfs_layer_bytes = vfsBytes.byteLength;
  context.candidate_product.vfs_layer_sha256 = sha256Hex(vfsBytes);
  context.candidate_product.builder_report_sha256 = sha256Hex(
    candidateInputDocuments(context).builderReportBytes,
  );
  return executionInputs(context, { vfsBytes });
}

test("executes every registered Node definition through its typed protected runner", async () => {
  const definitions = generatedDefinitions.definitions.filter(
    (definition) => definition.host === "node",
  );
  assert.ok(definitions.length > 10, "expected the complete Node evidence inventory");

  for (const definition of definitions) {
    const context = contextFor(definition);
    const calls: AdapterCalls = {
      operations: [], canceled: 0, disposed: 0, lazyFetches: [],
    };
    const result = await runNodeProductEvidence(
      executionInputs(context),
      successfulAdapter(definition, calls),
    );
    assert.equal(result.outcome, "success", definition.id);
    assert.deepEqual(result.guard_codes, [], definition.id);
    assert.equal(calls.operations.length, 1, definition.id);
    assert.deepEqual(calls.operations[0]?.boot, context.boot, definition.id);
    assert.deepEqual(calls.operations[0]?.mounts, context.mounts, definition.id);
    assert.equal(calls.disposed, 1, definition.id);
    validateProductEvidenceResult(result);
  }
});

test("compiles the checked SDK fixture from exact candidate VFS inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-sdk-evidence-test-"));
  try {
    const vfsBytes = await realSdkFixtureVfs(
      root,
      '#error "candidate-controlled probe source must stay inert"\n',
    );
    const compilerSource = exactCompilerSourceFixture(root);
    const originalToolPath = process.env.KANDELO_DEV_SHELL_TOOL_PATH;
    const gitOnlyDirectory = devShellToolDirectory("git");
    assert.equal(
      existsSync(join(gitOnlyDirectory, "clang")),
      false,
      "test requires an ambient path without a substitute compiler",
    );
    process.env.KANDELO_DEV_SHELL_TOOL_PATH = gitOnlyDirectory;
    let compiled;
    try {
      compiled = await compileSdkFixtureFromCandidateVfs(
        vfsBytes,
        root,
        compilerSource,
      );
    } finally {
      process.env.KANDELO_DEV_SHELL_TOOL_PATH = originalToolPath;
    }
    assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
    assert.match(compiled.compilerIdentitySha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(
      [...compiled.programBytes.subarray(0, 8)],
      [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    );
    assert.equal(compiled.stdout, "");
    assert.equal(compiled.stderr, "");

    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const host = new NodeKernelHost({
      maxWorkers: 4,
      rootfsImage: vfsBytes,
      rootfsMountSpec: [
        { source: "image", path: "/", readonly: false },
        {
          source: "scratch",
          path: "/tmp",
          mode: 0o1777,
          uid: 0,
          gid: 0,
          ephemeral: true,
        },
      ],
      onStdout: (_pid, bytes) => stdout.push(new Uint8Array(bytes)),
      onStderr: (_pid, bytes) => stderr.push(new Uint8Array(bytes)),
    });
    try {
      const kernel = new Uint8Array(readFileSync(
        join(repositoryRoot, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm"),
      ));
      await host.init(toExactArrayBuffer(kernel));
      const status = await host.spawn(
        toExactArrayBuffer(compiled.programBytes),
        ["/tmp/tiny-sdk-program.wasm"],
        {
          cwd: "/home",
          uid: 1000,
          gid: 1000,
          env: ["HOME=/home", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp"],
        },
      );
      assert.equal(status, 0);
      assert.equal(Buffer.concat(stdout.map((bytes) => Buffer.from(bytes))).toString(),
        "hello from Kandelo clang\n");
      assert.equal(Buffer.concat(stderr.map((bytes) => Buffer.from(bytes))).toString(), "");
    } finally {
      await host.destroy();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executes a miniature product through the built exact-host supervisor", {
  skip: process.env.KANDELO_EVIDENCE_HOST_DIST === undefined,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-built-host-evidence-test-"));
  try {
    const compilerSource = exactCompilerSourceFixture(root);
    const vfsBytes = await realSdkFixtureVfs(root);
    const runtime = exactBuiltHostRuntimeFixture(
      root,
      process.env.KANDELO_EVIDENCE_HOST_DIST!,
      compilerSource,
    );
    const definition = generatedDefinitions.definitions.find(
      (candidate) => candidate.id === "kandelo-sdk-node-compile",
    )!;
    const context = contextFor(definition, {
      runtime: runtimeIdentityFromBundle(runtime.runtimeBundleBytes),
    });
    context.candidate_product.vfs_layer_bytes = vfsBytes.byteLength;
    context.candidate_product.vfs_layer_sha256 = sha256Hex(vfsBytes);
    const documents = candidateInputDocuments(context, runtime.runtimeBundleBytes);
    context.candidate_product.builder_report_sha256 = sha256Hex(
      documents.builderReportBytes,
    );
    const inputs = {
      ...executionInputsBase(context),
      ...documents,
      vfsBytes,
      runtimeBundleBytes: runtime.runtimeBundleBytes,
      kernelWasmBytes: runtime.kernelWasmBytes,
    };
    const result = await superviseNodeEvidenceCli(
      writeCliFixtureInputs(
        root,
        inputs,
        runtime.runtimeRoot,
        compilerSource.sourceRoot,
      ),
    );
    assert.equal(
      result.outcome,
      "success",
      result.bounded_diagnostics.map((diagnostic) => diagnostic.text).join("\n"),
    );
    assert.deepEqual(result.guard_codes, []);
    validateProductEvidenceResult(result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("binds the SDK compiler environment to the exact source and dev-shell lock", () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-sdk-compiler-source-test-"));
  const sourceRoot = join(root, "source");
  mkdirSync(sourceRoot);
  writeFileSync(
    join(sourceRoot, "flake.lock"),
    '{"nodes":{},"root":"root","version":7}\n',
  );
  writeFileSync(
    join(sourceRoot, "flake.nix"),
    '{ outputs = { self }: {}; }\n',
  );
  execFileSync("git", ["init", "-q"], { cwd: sourceRoot });
  execFileSync("git", ["add", "."], { cwd: sourceRoot });
  execFileSync(
    "git",
    [
      "-c", "user.name=Fixture", "-c", "user.email=fixture.invalid",
      "commit", "-qm", "exact compiler source fixture",
    ],
    { cwd: sourceRoot },
  );
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
  const lockSha256 = sha256Hex(new Uint8Array(readFileSync(join(sourceRoot, "flake.lock"))));

  const source = validateExactSdkCompilerSourceRoot(
    sourceRoot,
    { repository: "example/kandelo", commit, tree },
    lockSha256,
  );
  assert.equal(source.sourceRoot, realpathSync(sourceRoot));
  assert.equal(source.devShellLockSha256, lockSha256);

  assert.throws(
    () => validateExactSdkCompilerSourceRoot(
      sourceRoot,
      { repository: "example/kandelo", commit: "f".repeat(40), tree },
      lockSha256,
    ),
    /exact runtime source/i,
  );
  writeFileSync(join(sourceRoot, "untracked"), "ambient\n");
  assert.throws(
    () => validateExactSdkCompilerSourceRoot(
      sourceRoot,
      { repository: "example/kandelo", commit, tree },
      lockSha256,
    ),
    /clean exact source/i,
  );
});

test("service evidence cannot replace the product's manifest-owned boot", async () => {
  const definitions = generatedDefinitions.definitions.filter(
    (definition) => definition.host === "node" && definition.runner === "sql",
  );
  assert.ok(definitions.length > 0, "expected registered Node SQL evidence");
  for (const definition of definitions) {
    const context = contextFor(definition);
    const calls: AdapterCalls = {
      operations: [], canceled: 0, disposed: 0, lazyFetches: [],
    };
    const result = await runNodeProductEvidence(
      executionInputs(context),
      successfulAdapter(definition, calls),
    );
    assert.equal(result.outcome, "success", definition.id);
    const operation = calls.operations[0];
    assert.equal(operation?.kind, "sql", definition.id);
    if (operation?.kind === "sql") {
      assert.equal(
        operation.boot.argv.some((argument) => argument === "--skip-networking"),
        false,
        definition.id,
      );
    }
  }
});

test("normalizes protected protocol results without guest command output", () => {
  assert.equal(
    formatMysqlEvidenceResult({
      columns: ["one", "two"],
      rows: [["1", "2"], ["3", "4"]],
    }),
    "1\t2\n3\t4",
  );
  assert.equal(
    formatRedisEvidenceResult({ type: "string", value: "PONG" }),
    "PONG",
  );
  assert.throws(
    () => formatRedisEvidenceResult({ type: "error", value: "ERR denied" }),
    /Redis protocol error: ERR denied/,
  );
});

test("materializes the exact protected product mount contract", () => {
  assert.deepEqual(
    hostMountSpecFromProductMounts([
      { source: "built-image", path: "/", readonly: false },
      {
        source: "scratch",
        path: "/tmp",
        mode: "1777",
        uid: 0,
        gid: 0,
        ephemeral: true,
      },
    ]),
    [
      { source: "image", path: "/", readonly: false },
      {
        source: "scratch",
        path: "/tmp",
        mode: 0o1777,
        uid: 0,
        gid: 0,
        ephemeral: true,
      },
    ],
  );
});

test("the exact Node worker attributes guest output to the active process", () => {
  const source = readFileSync(
    resolve(repositoryRoot, "host/src/node-kernel-worker-entry.ts"),
    "utf8",
  );
  assert.match(source, /type: "stdout",[\s\S]{0,120}pid: .*currentHandlePid/u);
  assert.match(source, /type: "stderr",[\s\S]{0,120}pid: .*currentHandlePid/u);
  assert.doesNotMatch(source, /type: "(?:stdout|stderr)", pid: 0/u);
});

test("rejects guest output while it is being captured", () => {
  const output = new BoundedEvidenceOutput(5, "stdout");
  output.append(7, encoder.encode("abc"));
  assert.equal(output.decode(), "abc");
  assert.throws(
    () => output.append(7, encoder.encode("def")),
    /stdout exceeds its 5-byte evidence bound/,
  );
  assert.equal(output.decode(), "abc");
});

test("rejects malformed output callbacks and stores no empty chunks", () => {
  const output = new BoundedEvidenceOutput(5, "stdout");
  for (let index = 0; index < 10_000; index++) {
    output.append(7, new Uint8Array());
  }
  assert.equal(
    (output as unknown as { chunks: unknown[] }).chunks.length,
    0,
  );
  assert.throws(
    () => output.append(Number.NaN, encoder.encode("x")),
    /stdout.*process ID/i,
  );
  assert.throws(
    () => output.append(7, "not bytes" as unknown as Uint8Array),
    /stdout.*Uint8Array/i,
  );
});

test("bounds SQL and Redis pipe bytes at the evidence transport boundary", async () => {
  const delegate = {
    async pickListenerTarget() { return null; },
    async injectConnection() { return 1; },
    async pipeWrite(_pid: number, _pipe: number, bytes: Uint8Array) {
      return bytes.byteLength;
    },
    async pipeRead() { return encoder.encode("abcdef"); },
    pipeCloseWrite() {},
    pipeCloseRead() {},
    async pipeIsWriteOpen() { return true; },
    wakeBlockedReaders() {},
    wakeBlockedWriters() {},
  };
  const bounded = createBoundedKernelPipeTransport(delegate, 5);
  await assert.rejects(bounded.pipeRead(0, 1), /pipe response exceeds its 5-byte evidence bound/);
  await assert.rejects(
    bounded.pipeWrite(0, 1, encoder.encode("abcdef")),
    /pipe request exceeds its 5-byte evidence bound/,
  );
});

test("keeps registered Node product suites closed and outcome checked", () => {
  const suiteIds = [
    "mariadb-product-node",
    "php-product-node",
    "sqlite-product-node",
  ] as const;

  for (const suiteId of suiteIds) {
    const suite = protectedNodeSuiteDefinition(suiteId);
    assert.ok(suite.steps.length >= 2, `${suiteId} must contain a bounded suite`);
    for (const step of suite.steps) {
      assert.ok(step.argv[0]?.startsWith("/"), `${step.id} must use an absolute binary`);
      assert.notEqual(step.argv[0], "/bin/sh", `${step.id} must not use a shell adapter`);
      assert.ok(step.stdout, `${step.id} must prove a protected output`);
      const passingOutput = step.stdout.kind === "exact"
        ? step.stdout.value
        : `prefix ${step.stdout.value} suffix`;
      assert.doesNotThrow(() => validateProtectedNodeSuiteStep(
        step,
        { status: 0, stdout: passingOutput, stderr: "" },
      ));
      assert.throws(
        () => validateProtectedNodeSuiteStep(
          step,
          { status: 0, stdout: "unrelated output", stderr: "" },
        ),
        /protected output/,
      );
      assert.throws(
        () => validateProtectedNodeSuiteStep(
          step,
          { status: 19, stdout: passingOutput, stderr: "failed" },
        ),
        /status 19/,
      );
    }
  }

  const mariadb = protectedNodeSuiteDefinition("mariadb-product-node");
  assert.deepEqual(mariadb.service, { argv: "product-boot", port: 3306 });
  assert.deepEqual(
    mariadb.steps.map((step) => step.argv[0]),
    ["/usr/bin/mysqltest", "/usr/bin/mysqltest"],
  );
  assert.match(mariadb.steps[0]!.argv.join(" "), /__setup\.test/);
  assert.match(mariadb.steps[1]!.argv.join(" "), /1st\.test/);

  const php = protectedNodeSuiteDefinition("php-product-node");
  assert.equal(php.service, undefined);
  assert.ok(php.steps.every((step) => step.argv[0] === "/usr/local/bin/php"));
  assert.equal(php.steps[0]!.id, "upstream-zend-004-phpt");
  assert.match(php.steps[0]!.argv.join(" "), /\/php-src\/Zend\/tests\/004\.phpt/);
  assert.equal(
    php.steps[0]!.stdout.value,
    "phpt-pass:Zend/tests/004.phpt\n",
  );

  const sqlite = protectedNodeSuiteDefinition("sqlite-product-node");
  assert.equal(sqlite.service, undefined);
  assert.ok(sqlite.steps.every((step) => step.argv[0] === "/usr/bin/testfixture"));
  assert.deepEqual(
    sqlite.steps.map((step) => step.argv[1]),
    ["test/select1.test", "test/func.test"],
  );
});

test("rejects every candidate credential class before execution", () => {
  const forbidden = [
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "CARGO_REGISTRY_TOKEN",
    "GHCR_PAT",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "HOMEBREW_DOCKER_REGISTRY_TOKEN",
    "HOMEBREW_GITHUB_API_TOKEN",
    "HOMEBREW_GITHUB_PACKAGES_TOKEN",
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "SSH_AUTH_SOCK",
  ];
  for (const name of forbidden) {
    assert.throws(
      () => assertUncredentialedEnvironment({ [name]: "secret" }),
      new RegExp(name),
    );
  }
  assert.doesNotThrow(() => assertUncredentialedEnvironment({ CI: "true" }));
});

test("binds exact candidate VFS, runtime bundle, kernel, definition, and host", async () => {
  const definition = generatedDefinitions.definitions.find(
    (candidate) => candidate.id === "rootfs-node-startup",
  )!;
  const context = contextFor(definition);
  validateNodeEvidenceContext(executionInputs(context));

  await assert.rejects(
    runNodeProductEvidence(
      { ...executionInputs(context), vfsBytes: encoder.encode("substitute") },
      successfulAdapter(definition),
    ),
    /candidate VFS.*identity/i,
  );
  await assert.rejects(
    runNodeProductEvidence(
      executionInputs(context, {
        candidateLocator: {
          ...executionInputsBase(context).candidateLocator,
          builder_report_sha256: "8".repeat(64),
        },
      }),
      successfulAdapter(definition),
    ),
    /candidate product locator.*exact evidence context/i,
  );
  await assert.rejects(
    runNodeProductEvidence(
      { ...executionInputs(context), runtimeBundleBytes: encoder.encode("{}\n") },
      successfulAdapter(definition),
    ),
    /runtime/i,
  );
  await assert.rejects(
    runNodeProductEvidence(
      { ...executionInputs(context), kernelWasmBytes: encoder.encode("other kernel") },
      successfulAdapter(definition),
    ),
    /kernel/i,
  );
  const driftedDefinition = { ...definition, definition_sha256: "9".repeat(64) };
  await assert.rejects(
    runNodeProductEvidence(
      executionInputs(contextFor(driftedDefinition)),
      successfulAdapter(driftedDefinition),
    ),
    /definition.*digest/i,
  );
  await assert.rejects(
    runNodeProductEvidence(
      executionInputs(contextFor(definition, { host: "browser" as "node" })),
      successfulAdapter(definition),
    ),
    /host/i,
  );
  const substitutedDefinition = {
    ...definition,
    probe: { argv: ["/bin/false"], stdout_exact: "substituted\n" },
    definition_sha256: "",
  };
  substitutedDefinition.definition_sha256 = evidenceDefinitionSha256(substitutedDefinition);
  await assert.rejects(
    runNodeProductEvidence(
      executionInputs(contextFor(substitutedDefinition)),
      successfulAdapter(substitutedDefinition),
    ),
    /protected current policy/i,
  );
  const substitutedBoot = {
    ...context,
    boot: { ...context.boot, cwd: "/tmp" },
  };
  await assert.rejects(
    runNodeProductEvidence(
      executionInputs(substitutedBoot),
      successfulAdapter(definition),
    ),
    /boot or mount contract.*protected/i,
  );
  const substitutedCatalog = structuredClone(productCatalog);
  const substitutedProduct = substitutedCatalog.products.find(
    (entry) => entry.manifest.id === context.product.id,
  )!;
  assert.ok(substitutedProduct.manifest.boot);
  substitutedProduct.manifest.boot.cwd = "/tmp";
  const catalogMatchedContext = {
    ...context,
    boot: structuredClone(substitutedProduct.manifest.boot),
  };
  await assert.rejects(
    runNodeProductEvidence(
      executionInputs(catalogMatchedContext, {
        protectedProducts: substitutedCatalog,
      }),
      successfulAdapter(definition),
    ),
    /catalog manifest digest/i,
  );

  const canonicalPackageInputs = executionInputsBase(context);
  const canonicalResolved = JSON.parse(
    decoder.decode(canonicalPackageInputs.resolvedInputsBytes),
  );
  canonicalResolved.inputs[0].reference =
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${context.runtime.target_abi.version}` +
    `/dash@sha256:${canonicalResolved.inputs[0].sha256}`;
  await assert.rejects(
    runNodeProductEvidence(
      {
        ...canonicalPackageInputs,
        resolvedInputsBytes: canonicalJsonBytes(canonicalResolved),
      },
      successfulAdapter(definition),
    ),
    /canonical ABI namespace/i,
  );

  const hostileResolved = JSON.parse(
    decoder.decode(canonicalPackageInputs.resolvedInputsBytes),
  );
  hostileResolved.inputs[0].reference =
    `https://attacker.invalid/homebrew-tap-core-abi-` +
    `${context.runtime.target_abi.version}-candidates/dash@sha256:` +
    hostileResolved.inputs[0].sha256;
  await assert.rejects(
    runNodeProductEvidence(
      {
        ...canonicalPackageInputs,
        resolvedInputsBytes: canonicalJsonBytes(hostileResolved),
      },
      successfulAdapter(definition),
    ),
    /visibly nonendorsed candidate namespace/i,
  );

  const lockDriftResolved = JSON.parse(
    decoder.decode(canonicalPackageInputs.resolvedInputsBytes),
  );
  lockDriftResolved.build_environment.dev_shell_lock_sha256 = "9".repeat(64);
  const lockDriftResolvedBytes = canonicalJsonBytes(lockDriftResolved);
  const lockDriftReport = JSON.parse(
    decoder.decode(canonicalPackageInputs.builderReportBytes),
  );
  lockDriftReport.resolved_inputs_sha256 = sha256Hex(lockDriftResolvedBytes);
  const lockDriftReportBytes = canonicalJsonBytes(lockDriftReport);
  const lockDriftContext = {
    ...context,
    candidate_product: {
      ...context.candidate_product,
      builder_report_sha256: sha256Hex(lockDriftReportBytes),
    },
  };
  const lockDriftInputs = executionInputsBase(lockDriftContext);
  await assert.rejects(
    runNodeProductEvidence(
      {
        ...lockDriftInputs,
        builderReportBytes: lockDriftReportBytes,
        candidateLocator: {
          ...lockDriftInputs.candidateLocator,
          builder_report_sha256: sha256Hex(lockDriftReportBytes),
        },
        resolvedInputsBytes: lockDriftResolvedBytes,
      },
      successfulAdapter(definition),
    ),
    /dev-shell lock.*runtime/i,
  );
});

test("executes the Node host from the complete exact runtime artifact root", async () => {
  const root = writeExactRuntimeFixture();
  try {
    const artifacts = validateExactRuntimeArtifactRoot(RUNTIME_BUNDLE_BYTES, root);
    const canonicalRoot = realpathSync.native(root);
    assert.equal(artifacts.root, canonicalRoot);
    assert.equal(artifacts.kernelPath, join(canonicalRoot, "kernel.wasm"));
    assert.equal(artifacts.hostModulePath, join(canonicalRoot, "host/dist/index.js"));
    const Host = await loadExactNodeKernelHostConstructor(artifacts);
    assert.equal(Host.name, "NodeKernelHost");

    const emptyDirectory = join(root, "unrepresented-empty-directory");
    mkdirSync(emptyDirectory);
    assert.throws(
      () => validateExactRuntimeArtifactRoot(RUNTIME_BUNDLE_BYTES, root),
      /empty directory/i,
    );
    rmSync(emptyDirectory, { recursive: true });

    writeFileSync(artifacts.hostModulePath, "export class Substitute {}\n");
    assert.throws(
      () => validateExactRuntimeArtifactRoot(RUNTIME_BUNDLE_BYTES, root),
      /runtime.*inventory/i,
    );
    writeFileSync(artifacts.hostModulePath, RUNTIME_FILES["host/dist/index.js"]);

    truncateSync(artifacts.hostModulePath, 64 * 1024 * 1024 + 1);
    assert.throws(
      () => validateExactRuntimeArtifactRoot(RUNTIME_BUNDLE_BYTES, root),
      /executable Node artifact.*byte bound/i,
    );
    writeFileSync(artifacts.hostModulePath, RUNTIME_FILES["host/dist/index.js"]);

    const worker = join(root, "host/dist/node-kernel-worker-entry.js");
    unlinkSync(worker);
    symlinkSync("index.js", worker);
    assert.throws(
      () => validateExactRuntimeArtifactRoot(RUNTIME_BUNDLE_BYTES, root),
      /symbolic link/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts bounded empty files inside an exact toolchain component", () => {
  const root = writeExactRuntimeFixture();
  try {
    const relativePath = "toolchain/wasm32-sysroot/include/bits/ioctl_fix.h";
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, new Uint8Array());
    const bundle = JSON.parse(JSON.stringify(RUNTIME_BUNDLE)) as typeof RUNTIME_BUNDLE;
    bundle.inventory = [
      ...bundle.inventory,
      { bytes: 0, path: relativePath, sha256: sha256Hex(new Uint8Array()) },
    ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

    assert.doesNotThrow(() =>
      validateExactRuntimeArtifactRoot(canonicalJsonBytes(bundle), root)
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("caps the exact Node evidence host process-memory budget", () => {
  const definition = generatedDefinitions.definitions.find(
    (candidate) => candidate.id === "node-vfs-node-startup",
  )!;
  const options = nodeEvidenceHostOptions(
    executionInputs(contextFor(definition)),
    () => {},
    () => {},
  );
  assert.equal(options.maxWorkers, 24);
  assert.equal(options.maxProcessMemoryBytes, 2 * 1024 * 1024 * 1024);
});

test("passes manifest values as inert argv without constructing a host shell command", async () => {
  const base = generatedDefinitions.definitions.find(
    (candidate) => candidate.id === "rootfs-node-startup",
  )!;
  const hostileArg = "$(touch /tmp/should-not-exist); echo injected";
  const definition: GeneratedEvidenceDefinitionV1 = {
    ...base,
    probe: {
      ...base.probe,
      argv: ["/bin/printf", hostileArg],
      stdout_exact: "safe\n",
    },
    definition_sha256: "",
  };
  definition.definition_sha256 = evidenceDefinitionSha256(definition);
  const calls: AdapterCalls = {
    operations: [], canceled: 0, disposed: 0, lazyFetches: [],
  };
  const context = contextFor(definition);
  const protectedDefinitions = {
    ...generatedDefinitions,
    definitions: generatedDefinitions.definitions.map((candidate) =>
      candidate.id === definition.id ? definition : candidate
    ),
  };
  const result = await runNodeProductEvidence(
    executionInputs(context, { protectedDefinitions }),
    successfulAdapter(definition, calls),
  );
  assert.equal(result.outcome, "success", JSON.stringify(result));
  assert.deepEqual(calls.operations[0]?.kind, "exec");
  assert.deepEqual(
    calls.operations[0] && "argv" in calls.operations[0]
      ? calls.operations[0].argv
      : undefined,
    ["/bin/printf", hostileArg],
  );
});

test("emits a deterministic bounded failure result", async () => {
  const definition = generatedDefinitions.definitions.find(
    (candidate) => candidate.id === "rootfs-node-startup",
  )!;
  const context = contextFor(definition);
  const adapter = successfulAdapter(definition);
  adapter.exec = async () => ({
    status: 23,
    stdout: "x".repeat(100_000),
    stderr: "y".repeat(100_000),
  });
  const first = await runNodeProductEvidence(executionInputs(context), adapter);
  const secondAdapter = successfulAdapter(definition);
  secondAdapter.exec = adapter.exec;
  const second = await runNodeProductEvidence(executionInputs(context), secondAdapter);
  assert.deepEqual(first, second);
  assert.equal(first.outcome, "failure");
  assert.deepEqual(first.guard_codes, ["verification_failed"]);
  for (const diagnostic of first.bounded_diagnostics) {
    assert.ok(diagnostic.bytes <= 64 * 1024);
    assert.equal(diagnostic.bytes, Buffer.byteLength(diagnostic.text));
    assert.equal(diagnostic.sha256, sha256Hex(encoder.encode(diagnostic.text)));
  }
  assert.ok(canonicalJsonBytes(first).byteLength <= 4 * 1024 * 1024);
});

test("turns a protected deadline into an exact timeout result and cancels execution", async () => {
  const definition = generatedDefinitions.definitions.find(
    (candidate) => candidate.id === "rootfs-node-startup",
  )!;
  const calls: AdapterCalls = {
    operations: [], canceled: 0, disposed: 0, lazyFetches: [],
  };
  const result = await runNodeProductEvidence(
    executionInputs(contextFor(definition)),
    successfulAdapter(definition, calls),
    {
      runWithTimeout: async () => {
        throw new EvidenceTimeoutError("protected evidence deadline exceeded");
      },
    },
  );
  assert.equal(result.outcome, "timeout");
  assert.deepEqual(result.guard_codes, ["verification_timeout"]);
  assert.equal(calls.canceled, 1);
  assert.equal(calls.disposed, 1);
});

test("returns a terminal timeout when candidate cancellation and disposal hang", async () => {
  const definition = generatedDefinitions.definitions.find(
    (candidate) => candidate.id === "rootfs-node-startup",
  )!;
  const adapter = successfulAdapter(definition);
  adapter.cancel = async () => new Promise<void>(() => {});
  adapter.dispose = async () => new Promise<void>(() => {});
  const result = await Promise.race([
    runNodeProductEvidence(
      executionInputs(contextFor(definition)),
      adapter,
      {
        cleanupTimeoutMilliseconds: 1,
        runWithTimeout: async () => {
          throw new EvidenceTimeoutError("protected evidence deadline exceeded");
        },
      },
    ),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("typed evidence runner did not terminate")), 50)
    ),
  ]);
  assert.equal(result.outcome, "timeout");
  assert.deepEqual(result.guard_codes, ["verification_timeout"]);
  assert.ok(result.bounded_diagnostics.some((diagnostic) =>
    diagnostic.text.includes("cancel exceeded") &&
    diagnostic.text.includes("dispose exceeded")
  ));
});

test("turns a hung evidence disposal into a terminal failure", async () => {
  const definition = generatedDefinitions.definitions.find(
    (candidate) => candidate.id === "rootfs-node-startup",
  )!;
  const adapter = successfulAdapter(definition);
  adapter.dispose = async () => new Promise<void>(() => {});
  const result = await Promise.race([
    runNodeProductEvidence(
      executionInputs(contextFor(definition)),
      adapter,
      { cleanupTimeoutMilliseconds: 1 },
    ),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("typed evidence runner did not terminate")), 50)
    ),
  ]);
  assert.equal(result.outcome, "failure");
  assert.deepEqual(result.guard_codes, ["verification_failed"]);
  assert.ok(result.bounded_diagnostics.some((diagnostic) =>
    diagnostic.text.includes("dispose exceeded")
  ));
});

test("supervisor emits a canonical failure when the exact host import fails", async () => {
  const fixture = supervisedCliFixture(
    'throw new Error("exact host import failed");\n',
  );
  try {
    const result = await superviseNodeEvidenceCli(fixture.options);
    assert.equal(result.outcome, "failure");
    assert.deepEqual(result.guard_codes, ["verification_failed"]);
    assert.ok(
      result.bounded_diagnostics.some((diagnostic) =>
        diagnostic.text.includes("exact host import failed")
      ),
    );
    validateProductEvidenceResult(result);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("deadline expiry takes precedence over a concurrent preflight failure", () => {
  const parseFailure = new Error("candidate VFS parse failed");
  assert.equal(
    classifySupervisorLifecycleError(parseFailure, 101, 100),
    parseFailure,
  );
  assert.match(
    classifySupervisorLifecycleError(parseFailure, 100, 100).message,
    /protected evidence deadline exceeded/i,
  );
});

test("supervisor emits a canonical terminal result for candidate preflight failure", async () => {
  const fixture = supervisedCliFixture(`export class NodeKernelHost {}`);
  try {
    writeFileSync(fixture.options.vfs, "not an exact candidate VFS\n");
    const result = await superviseNodeEvidenceCli(fixture.options);
    assert.equal(result.outcome, "failure");
    assert.deepEqual(result.guard_codes, ["verification_failed"]);
    assert.ok(result.bounded_diagnostics.some((diagnostic) =>
      diagnostic.text.includes("candidate VFS")
    ));
    validateProductEvidenceResult(result);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("supervisor rejects a candidate zstd expansion above its lifecycle bound", async () => {
  const fixture = supervisedCliFixture(`export class NodeKernelHost {}`);
  try {
    const frame = new Uint8Array(13);
    frame.set([0x28, 0xb5, 0x2f, 0xfd], 0);
    frame[4] = 0xe0;
    new DataView(frame.buffer).setBigUint64(
      5,
      512n * 1024n * 1024n,
      true,
    );
    replaceSupervisedCandidateVfs(fixture, frame);
    const result = await superviseNodeEvidenceCli(fixture.options);
    assert.equal(result.outcome, "failure");
    assert.ok(result.bounded_diagnostics.some((diagnostic) =>
      /zstd.*decompressed.*bound/i.test(diagnostic.text)
    ));
    validateProductEvidenceResult(result);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("supervisor deadline covers exact host initialization and cleanup", async () => {
  const sources = [
    `export class NodeKernelHost {
      constructor() {}
      subscribeLazyDownloads() { return () => {}; }
      async init() { await new Promise(() => setInterval(() => {}, 1000)); }
    }\n`,
    `export class NodeKernelHost {
      constructor(options) { this.options = options; }
      subscribeLazyDownloads() { return () => {}; }
      async init() {}
      async spawnFromVfs() {
        this.options.onStdout(1, new TextEncoder().encode("54\\n"));
        return { pid: 1, exit: Promise.resolve(0) };
      }
      async terminateProcess() {}
      async destroy() { await new Promise(() => setInterval(() => {}, 1000)); }
    }\n`,
  ];
  for (const source of sources) {
    const fixture = supervisedCliFixture(source);
    try {
      const result = await superviseNodeEvidenceCli(fixture.options);
      assert.equal(result.outcome, "timeout");
      assert.deepEqual(result.guard_codes, ["verification_timeout"]);
      validateProductEvidenceResult(result);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("supervisor launches exact candidate code with an allowlisted private environment", async () => {
  const fixture = supervisedCliFixture(`export class NodeKernelHost {
    constructor(options) {
      if (process.env.SUPER_SECRET !== undefined) throw new Error("ambient secret leaked");
      if (!process.env.HOME || process.env.HOME === ${JSON.stringify(process.env.HOME ?? "")}) {
        throw new Error("candidate HOME is not private");
      }
      if (process.argv.includes("--output")) {
        throw new Error("candidate received the protected result path");
      }
      if (process.send !== undefined) {
        throw new Error("candidate retained direct access to protected IPC");
      }
      if (options.maxWorkers !== 24) {
        throw new Error("candidate received the wrong protected worker capacity");
      }
      this.options = options;
    }
    subscribeLazyDownloads() { return () => {}; }
    async init() {}
    async spawnFromVfs() {
      this.options.onStdout(1, new TextEncoder().encode("54\\n"));
      return { pid: 1, exit: Promise.resolve(0) };
    }
    async terminateProcess() {}
    async destroy() {}
  }\n`);
  const previous = process.env.SUPER_SECRET;
  process.env.SUPER_SECRET = "must-not-cross";
  try {
    const result = await superviseNodeEvidenceCli(fixture.options);
    assert.equal(result.outcome, "success");
    assert.deepEqual(result.guard_codes, []);
  } finally {
    if (previous === undefined) delete process.env.SUPER_SECRET;
    else process.env.SUPER_SECRET = previous;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("supervisor converts exact-host guest output overflow into a canonical failure", async () => {
  const fixture = supervisedCliFixture(`export class NodeKernelHost {
    constructor(options) { this.options = options; }
    subscribeLazyDownloads() { return () => {}; }
    async init() {}
    async spawnFromVfs() {
      this.options.onStdout(1, new TextEncoder().encode("x".repeat(70 * 1024)));
      return { pid: 1, exit: Promise.resolve(0) };
    }
    async terminateProcess() {}
    async destroy() {}
  }\n`);
  try {
    const result = await superviseNodeEvidenceCli(fixture.options);
    assert.equal(result.outcome, "failure");
    assert.deepEqual(result.guard_codes, ["verification_failed"]);
    assert.ok(
      result.bounded_diagnostics.some((diagnostic) =>
        diagnostic.text.includes("stdout exceeds its 65536-byte evidence bound")
      ),
    );
    validateProductEvidenceResult(result);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("binds every pending VFS lazy file and archive to exact resolved inputs", async () => {
  const fileBytes = encoder.encode("lazy executable");
  const fileSha = sha256Hex(fileBytes);
  const fileUrl = `https://artifacts.example.test/tool?sha256=${fileSha}`;
  const archiveBytes = encoder.encode("archive transport identity");
  const archiveSha = sha256Hex(archiveBytes);
  const archiveUrl = `https://artifacts.example.test/tree?sha256=${archiveSha}`;
  const vfs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  vfs.registerLazyFile("/usr/bin/tool", fileUrl, fileBytes.byteLength, 0o755);
  vfs.registerLazyArchiveFromEntries(
    archiveUrl,
    [{
      fileName: "bin/tree-tool",
      fileNameBytes: encoder.encode("bin/tree-tool"),
      compressedSize: 12,
      uncompressedSize: 18,
      compressionMethod: 8,
      localHeaderOffset: 0,
      mode: 0o755,
      isDirectory: false,
      isSymlink: false,
      externalAttrs: 0,
      creatorOS: 3,
    }],
    "/opt/tree",
    undefined,
    { sha256: archiveSha, bytes: archiveBytes.byteLength },
  );
  const requirements = [
    { id: "package-tree", url: archiveUrl, sha256: archiveSha, size: archiveBytes.byteLength },
    { id: "package-tool", url: fileUrl, sha256: fileSha, size: fileBytes.byteLength },
  ];
  const image = await vfs.saveImage({
    metadata: {
      version: 1,
      kernelAbi: FIXTURE_TARGET_ABI.version,
      abiSnapshotSha256: FIXTURE_TARGET_ABI.snapshot_sha256,
      createdBy: "abi-staging-product-node-evidence.test.ts",
    },
  });
  await assert.doesNotReject(() =>
    validateCandidateVfsLazyInventory(image, requirements, FIXTURE_TARGET_ABI)
  );

  const extra = MemoryFileSystem.fromImage(image);
  const canonicalSha = "a".repeat(64);
  extra.registerLazyFile(
    "/usr/bin/unbound",
    `https://ghcr.io/kandelo-dev/homebrew-tap-core-abi-8/lazy@sha256:${canonicalSha}`,
    1,
  );
  const extraImage = await extra.saveImage();
  await assert.rejects(
    () => validateCandidateVfsLazyInventory(
      extraImage,
      requirements,
      FIXTURE_TARGET_ABI,
    ),
    /unbound.*lazy/i,
  );

  const sealed = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  await addSealedLazyAtomicTestTree(sealed, {
    groupId: "atomic:candidate-inventory",
    member: "runtime",
    root: "/sealed-runtime",
  });
  const sealedImage = await sealed.saveImage({
    metadata: {
      version: 1,
      kernelAbi: FIXTURE_TARGET_ABI.version,
      abiSnapshotSha256: FIXTURE_TARGET_ABI.snapshot_sha256,
      createdBy: "abi-staging-product-node-evidence.test.ts",
    },
  });
  await assert.doesNotReject(() =>
    validateCandidateVfsLazyInventory(
      sealedImage,
      [{
        id: "sealed-runtime",
        url: "https://example.invalid/sealed-atomic-test-tree.zip",
        sha256: "1".repeat(64),
        size: 1,
      }],
      FIXTURE_TARGET_ABI,
    )
  );
});

test("requires the candidate VFS to declare the exact runtime ABI", async () => {
  const targetAbi = { version: 8, snapshot_sha256: "3".repeat(64) };
  const missing = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
  const missingImage = await missing.saveImage();
  await assert.rejects(
    () => validateCandidateVfsLazyInventory(missingImage, [], targetAbi),
    /ABI metadata/i,
  );
  const wrong = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
  const wrongImage = await wrong.saveImage({
    metadata: {
      version: 1,
      kernelAbi: targetAbi.version + 1,
      abiSnapshotSha256: targetAbi.snapshot_sha256,
      createdBy: "abi-staging-product-node-evidence.test.ts",
    },
  });
  await assert.rejects(
    () => validateCandidateVfsLazyInventory(wrongImage, [], targetAbi),
    /runtime ABI/i,
  );
});

test("preserves lazy materialization timing for Perl and avoids embedded fetches", async () => {
  const perl = generatedDefinitions.definitions.find(
    (candidate) => candidate.id === "perl-vfs-node-smoke",
  )!;
  const perlCalls: AdapterCalls = {
    operations: [], canceled: 0, disposed: 0, lazyFetches: [],
  };
  const perlAdapter = successfulAdapter(perl, perlCalls);
  assert.deepEqual(perlCalls.lazyFetches, []);
  await runNodeProductEvidence(executionInputs(contextFor(perl)), perlAdapter);
  assert.deepEqual(perlCalls.lazyFetches, ["package-perl-output-perl"]);

  const python = generatedDefinitions.definitions.find(
    (candidate) => candidate.id === "python-vfs-node-smoke",
  )!;
  const pythonCalls: AdapterCalls = {
    operations: [], canceled: 0, disposed: 0, lazyFetches: [],
  };
  await runNodeProductEvidence(
    executionInputs(contextFor(python)),
    successfulAdapter(python, pythonCalls),
  );
  assert.deepEqual(pythonCalls.lazyFetches, []);
});

test("the exported typed runner rejects a VFS missing its declared lazy input", async () => {
  const perl = generatedDefinitions.definitions.find(
    (candidate) => candidate.id === "perl-vfs-node-smoke",
  )!;
  const result = await runNodeProductEvidence(
    executionInputsForVfs(perl, VFS_BYTES),
    successfulAdapter(perl),
  );
  assert.equal(result.outcome, "failure");
  assert.ok(result.bounded_diagnostics.some((item) =>
    item.text.includes("absent from the candidate VFS")
  ));
});

test("rejects early, missing, and undeclared lazy materialization", async () => {
  const perl = generatedDefinitions.definitions.find(
    (candidate) => candidate.id === "perl-vfs-node-smoke",
  )!;
  const perlInputs = executionInputs(contextFor(perl));
  const source = perlInputs.lazyAssetSources[0]!;
  const complete = {
    phase: "operation" as const,
    status: "complete" as const,
    url: source.url,
    loaded_bytes: source.size,
    total_bytes: source.size,
  };
  const earlyAdapter = {
    ...successfulAdapter(perl),
    async lazyDownloads() {
      return [
        { ...complete, phase: "initialization" as const, status: "started" as const,
          loaded_bytes: 0 },
        complete,
      ];
    },
  };
  const early = await runNodeProductEvidence(perlInputs, earlyAdapter);
  assert.equal(early.outcome, "failure");
  assert.ok(early.bounded_diagnostics.some((item) =>
    item.text.includes("before the protected operation")
  ));

  const missing = await runNodeProductEvidence(perlInputs, {
    ...successfulAdapter(perl),
    async lazyDownloads() { return []; },
  });
  assert.equal(missing.outcome, "failure");
  assert.ok(missing.bounded_diagnostics.some((item) =>
    item.text.includes("was not fetched completely")
  ));

  const python = generatedDefinitions.definitions.find(
    (candidate) => candidate.id === "python-vfs-node-smoke",
  )!;
  const undeclared = await runNodeProductEvidence(
    executionInputs(contextFor(python)),
    {
      ...successfulAdapter(python),
      async lazyDownloads() { return [complete]; },
    },
  );
  assert.equal(undeclared.outcome, "failure");
  assert.ok(undeclared.bounded_diagnostics.some((item) =>
    item.text.includes("unbound lazy URL")
  ));
});
