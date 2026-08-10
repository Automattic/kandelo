import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  BrowserEvidenceTimeoutError,
  assertCurrentBrowserEvidenceContext,
  buildBrowserEvidenceSelection,
  enforceBrowserEvidenceDeadline,
  prepareVerifiedProtectedBrowserHarness,
  runBrowserProductEvidence,
  startProtectedBrowserEvidenceServer,
  superviseBrowserEvidenceCli,
  type BrowserEvidenceContextV1,
  type BrowserEvidenceExecutor,
  type BrowserEvidenceSelectionInputV1,
} from "./abi-staging-product-browser-evidence.ts";
import {
  executeProtectedBrowserOperation,
  type ProtectedBrowserOperationAdapter,
} from "./abi-staging-protected-browser-operation.ts";
import {
  candidateEvidenceBootDescriptor,
  candidateEvidenceKernelInitOptions,
  candidateEvidenceLiveDemoId,
  createProtectedCandidatePagesVfsPlacement,
  fetchProtectedCandidateVfs,
  installProtectedCandidatePagesActivation,
  ProtectedBrowserEvidenceOutput,
  readInjectedProtectedBrowserEvidence,
  readInjectedProtectedCandidateVfs,
  resolveCandidateEvidenceBootExecutable,
  resolveCandidateOrDefaultOptionalVfsUrl,
} from "../apps/browser-demos/pages/kandelo/kernel-host/candidate-evidence-vfs.ts";
import { hostMountSpecFromProductMounts } from "../host/src/vfs/product-mount-contract.ts";
import {
  canonicalJsonBytes,
  evidenceDefinitionSha256,
  runtimeIdentityFromBundle,
  sha256Hex,
  validateProductEvidenceResult,
  type GeneratedEvidenceDefinitionRegistryV1,
  type GeneratedEvidenceDefinitionV1,
  type ProtectedVfsProductCatalogV1,
} from "./abi-staging-product-node-evidence.ts";
import { createClosedLazyAssetSourceFetcher } from "../host/src/vfs/closed-lazy-assets.ts";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs.ts";
import { completedPtyCommand } from "../apps/browser-demos/pages/abi-staging-product-evidence/pty-command.ts";

const definitions = JSON.parse(
  readFileSync("abi/staging/evidence-definitions.generated.json", "utf8"),
) as unknown;
const tests = JSON.parse(
  readFileSync("tests/vfs-products.generated.json", "utf8"),
) as unknown;
const pages = JSON.parse(
  readFileSync(
    "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json",
    "utf8",
  ),
) as unknown;
const products = JSON.parse(
  readFileSync("images/vfs/products/generated/catalog.json", "utf8"),
) as unknown;

const previousAbi = 7;
const targetAbi = previousAbi + 1;
const digest = "a".repeat(64);
const gitSha = "b".repeat(40);
const encoder = new TextEncoder();

declare global {
  interface Window {
    __KANDELO_ABI_STAGING_PAGES_PLACEMENT_SOURCE__?: unknown;
    __KANDELO_ABI_STAGING_PAGES_PLACEMENT_FIXTURE__?: {
      activate(): Promise<number>;
      bytes(): Promise<number>;
      resolveOptional(image: "node" | "wordpress" | "lamp"): Promise<{
        fallbackCalls: number;
        url: string;
      }>;
    };
  }
}

interface RuntimeInventoryEntry {
  bytes: number;
  path: string;
  sha256: string;
}

function runtimeInventory(root: string): RuntimeInventoryEntry[] {
  const entries: RuntimeInventoryEntry[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const metadata = lstatSync(absolute);
      assert.equal(metadata.isSymbolicLink(), false, `runtime fixture has symlink ${absolute}`);
      if (metadata.isDirectory()) {
        visit(absolute);
        continue;
      }
      assert.equal(metadata.isFile(), true, `runtime fixture has non-file ${absolute}`);
      const bytes = new Uint8Array(readFileSync(absolute));
      entries.push({
        bytes: bytes.byteLength,
        path: absolute.slice(root.length + 1).split("\\").join("/"),
        sha256: sha256Hex(bytes),
      });
    }
  };
  visit(root);
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
}

function buildMiniaturePerlProgram(root: string): Uint8Array {
  const output = join(root, "abi-staging-perl-plumbing.wasm");
  const result = spawnSync(
    "wasm32posix-cc",
    [
      resolve("apps/browser-demos/test/fixtures/abi-staging-perl-plumbing.c"),
      "-O2",
      "-o",
      output,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        HOME: root,
        LANG: "C",
        PATH: process.env.PATH,
        TMPDIR: root,
      },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return new Uint8Array(readFileSync(output));
}

function installedPlaywrightBrowsersPath(): string {
  const explicit = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (explicit !== undefined && existsSync(explicit)) return explicit;
  const home = process.env.HOME;
  assert.ok(home, "browser fixture requires a declared HOME");
  const candidates = [
    join(home, "Library/Caches/ms-playwright"),
    join(home, ".cache/ms-playwright"),
  ];
  const selected = candidates.find((candidate) => existsSync(candidate));
  assert.ok(selected, "browser fixture requires the repository Playwright browser install");
  return selected;
}

function buildExactBrowserRuntime(root: string): {
  bundleBytes: Uint8Array;
  kernelBytes: Uint8Array;
  runtimeRoot: string;
} {
  const runtimeRoot = join(root, "runtime");
  const browserDist = join(runtimeRoot, "browser/dist");
  const hostRoot = join(runtimeRoot, "host");
  const fixtureHome = join(root, "build-home");
  const fixtureTmp = join(root, "build-tmp");
  const builtHostDist = join(root, "built-host-dist");
  mkdirSync(browserDist, { recursive: true });
  mkdirSync(hostRoot, { recursive: true });
  mkdirSync(fixtureHome);
  mkdirSync(fixtureTmp);
  const buildEnvironment = {
    HOME: fixtureHome,
    LANG: "C",
    PATH: process.env.PATH,
    TMPDIR: fixtureTmp,
  };
  const nodeHostBuild = spawnSync(
    resolve("host/node_modules/.bin/tsup"),
    ["--out-dir", builtHostDist],
    { cwd: resolve("host"), encoding: "utf8", env: buildEnvironment },
  );
  assert.equal(nodeHostBuild.status, 0, `${nodeHostBuild.stdout}\n${nodeHostBuild.stderr}`);
  cpSync(builtHostDist, join(hostRoot, "dist"), { recursive: true });
  cpSync("host/src/generated/abi.ts", join(hostRoot, "generated-abi.ts"));
  cpSync("host/src/worker-protocol.ts", join(hostRoot, "worker-protocol.ts"));
  writeFileSync(join(hostRoot, "package.json"), canonicalJsonBytes({ type: "module" }));
  cpSync("flake.lock", join(runtimeRoot, "flake.lock"));

  const exactBrowserBuildEnvironment = {
    ...buildEnvironment,
    KANDELO_ABI_STAGING_EXACT_SOURCE_ROOT: resolve("."),
  };
  const hostBuild = spawnSync(
    resolve("apps/browser-demos/node_modules/.bin/vite"),
    [
      "build",
      "--config",
      resolve("apps/browser-demos/abi-staging-browser-host.config.ts"),
      "--outDir",
      join(browserDist, "abi-staging"),
      "--emptyOutDir",
    ],
    { cwd: resolve("apps/browser-demos"), encoding: "utf8", env: exactBrowserBuildEnvironment },
  );
  assert.equal(hostBuild.status, 0, `${hostBuild.stdout}\n${hostBuild.stderr}`);
  const harnessBuild = spawnSync(
    resolve("apps/browser-demos/node_modules/.bin/vite"),
    [
      "build",
      "--config",
      resolve("apps/browser-demos/abi-staging-browser-harness.config.ts"),
      "--outDir",
      join(browserDist, "abi-staging-harness"),
      "--emptyOutDir",
    ],
    { cwd: resolve("apps/browser-demos"), encoding: "utf8", env: buildEnvironment },
  );
  assert.equal(harnessBuild.status, 0, `${harnessBuild.stdout}\n${harnessBuild.stderr}`);

  const kernelTarget = join(root, "kernel-target");
  const kernelBuild = spawnSync(
    "cargo",
    ["build", "--release", "-p", "kandelo", "-Z", "build-std=core,alloc"],
    {
      cwd: resolve("."),
      encoding: "utf8",
      env: { ...buildEnvironment, CARGO_TARGET_DIR: kernelTarget },
    },
  );
  assert.equal(kernelBuild.status, 0, `${kernelBuild.stdout}\n${kernelBuild.stderr}`);
  const kernelPath = join(
    kernelTarget,
    "wasm32-unknown-unknown/release/kandelo_kernel.wasm",
  );
  const kernelBytes = new Uint8Array(readFileSync(kernelPath));
  const kernelAssetPath = "browser/dist/abi-staging/kernel.wasm";
  writeFileSync(join(runtimeRoot, "kernel.wasm"), kernelBytes);
  writeFileSync(join(runtimeRoot, kernelAssetPath), kernelBytes);
  writeFileSync(join(browserDist, "index.js"), "export const exactBrowser = true;\n");
  const serviceWorkerBytes = encoder.encode(
    "self.addEventListener('fetch', () => undefined);\n",
  );
  writeFileSync(join(browserDist, "service-worker.js"), serviceWorkerBytes);

  const inventory = runtimeInventory(runtimeRoot);
  const hostInventory = inventory.filter((entry) => entry.path.startsWith("host/"));
  const browserInventory = inventory.filter((entry) => entry.path.startsWith("browser/"));
  const snapshotBytes = new Uint8Array(readFileSync("abi/snapshot.json"));
  const snapshot = JSON.parse(new TextDecoder().decode(snapshotBytes)) as {
    abi_version: number;
  };
  const harnessPath = "browser/dist/abi-staging-harness/index.html";
  const hostPath = "browser/dist/abi-staging/browser-host.js";
  const harnessBytes = new Uint8Array(readFileSync(join(runtimeRoot, harnessPath)));
  const browserHostBytes = new Uint8Array(readFileSync(join(runtimeRoot, hostPath)));
  const generatedAbiBytes = new Uint8Array(readFileSync(join(hostRoot, "generated-abi.ts")));
  const workerProtocolBytes = new Uint8Array(readFileSync(join(hostRoot, "worker-protocol.ts")));
  const bundle = {
    schema: 1,
    kind: "kandelo-exact-runtime-bundle",
    source: {
      repository: "kandelo-dev/kandelo",
      // This is an internally consistent pipeline fixture built from the live
      // test checkout, not a claim about one immutable Git head. Production
      // evidence obtains these identities from the exact-head request.
      commit: createHash("sha1").update("abi-staging-browser-fixture-commit").digest("hex"),
      tree: createHash("sha1").update("abi-staging-browser-fixture-tree").digest("hex"),
    },
    target_abi: {
      version: snapshot.abi_version,
      snapshot_sha256: sha256Hex(snapshotBytes),
    },
    kernel: {
      wasm_sha256: sha256Hex(kernelBytes),
      bytes: kernelBytes.byteLength,
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
      harness_entry_bytes: harnessBytes.byteLength,
      harness_entry_path: harnessPath,
      harness_entry_sha256: sha256Hex(harnessBytes),
      host_entry_bytes: browserHostBytes.byteLength,
      host_entry_path: hostPath,
      host_entry_sha256: sha256Hex(browserHostBytes),
      kernel_asset_path: kernelAssetPath,
      kernel_asset_sha256: sha256Hex(kernelBytes),
      service_worker_sha256: sha256Hex(serviceWorkerBytes),
    },
    build_policy_sha256: sha256Hex(encoder.encode("miniature browser policy")),
    inventory,
  };
  return { bundleBytes: canonicalJsonBytes(bundle), kernelBytes, runtimeRoot };
}

async function writeRealChromiumFixture(root: string) {
  const exactRuntime = buildExactBrowserRuntime(root);
  const runtime = runtimeIdentityFromBundle(exactRuntime.bundleBytes);
  const definitionRegistry = definitions as GeneratedEvidenceDefinitionRegistryV1;
  const productCatalog = products as ProtectedVfsProductCatalogV1;
  const definition = definitionRegistry.definitions.find(
    (candidate) => candidate.id === "perl-vfs-browser-smoke",
  ) as GeneratedEvidenceDefinitionV1 | undefined;
  const product = productCatalog.products.find(
    (candidate) => candidate.manifest.id === "browser-perl",
  );
  assert.ok(definition, "fixture lacks the protected Perl browser definition");
  assert.ok(product, "fixture lacks the protected Perl VFS product");
  assert.ok(product.manifest.boot, "fixture Perl product lacks a boot contract");

  const programBytes = buildMiniaturePerlProgram(root);
  const programSha256 = sha256Hex(programBytes);
  const inputId = "package-perl-output-perl";
  const standardLibraryInputId = "package-perl-source-role-standard-library";
  const standardLibraryBytes = encoder.encode(
    "package File::Spec; # fixture File::Spec\n",
  );
  const standardLibrarySha256 = sha256Hex(standardLibraryBytes);
  const standardLibraryPath = "inputs/perl-standard-library.fixture";
  mkdirSync(join(root, "inputs"), { recursive: true });
  writeFileSync(join(root, standardLibraryPath), standardLibraryBytes);
  const reference =
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${runtime.target_abi.version}` +
    `-candidates/packages/${inputId}@sha256:${programSha256}`;
  const vfs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  vfs.mkdirWithOwner("/home", 0o755, 1000, 1000);
  vfs.mkdirWithOwner("/tmp", 0o1777, 0, 0);
  vfs.mkdirWithOwner("/usr", 0o755, 0, 0);
  vfs.mkdirWithOwner("/usr/lib", 0o755, 0, 0);
  vfs.mkdirWithOwner("/usr/lib/perl5", 0o755, 0, 0);
  vfs.mkdirWithOwner("/usr/lib/perl5/5.40.3", 0o755, 0, 0);
  vfs.mkdirWithOwner("/usr/lib/perl5/5.40.3/File", 0o755, 0, 0);
  vfs.createFileWithOwner(
    "/usr/lib/perl5/5.40.3/File/Spec.pm",
    0o644,
    0,
    0,
    standardLibraryBytes,
  );
  vfs.registerLazyFile("/usr/bin/perl", reference, programBytes.byteLength, 0o755);
  const vfsBytes = await vfs.saveImage({
    metadata: {
      version: 1,
      kernelAbi: runtime.target_abi.version,
      abiSnapshotSha256: runtime.target_abi.snapshot_sha256,
      createdBy: "abi-staging-product-browser-evidence.test.ts",
    },
  });
  const vfsSha256 = sha256Hex(vfsBytes);
  const resolved = {
    build_environment: {
      dev_shell_lock_sha256: runtimeInventory(exactRuntime.runtimeRoot).find(
        (entry) => entry.path === "flake.lock",
      )!.sha256,
      policy_sha256: runtime.build_policy_sha256,
    },
    inputs: [
      {
        architecture: product.manifest.architecture,
        bytes: programBytes.byteLength,
        declared_materialization: "lazy",
        effective_materialization: "lazy-reference",
        id: inputId,
        kind: "package-output",
        reference,
        role: "runtime",
        sha256: programSha256,
      },
      {
        architecture: product.manifest.architecture,
        bytes: standardLibraryBytes.byteLength,
        declared_materialization: "embedded",
        effective_materialization: "embedded",
        id: standardLibraryInputId,
        kind: "package-output",
        path: standardLibraryPath,
        role: "runtime",
        sha256: standardLibrarySha256,
      },
    ],
    kind: "kandelo-resolved-vfs-product-inputs",
    product: {
      architecture: product.manifest.architecture,
      id: product.manifest.id,
      manifest_path: product.path,
      manifest_sha256: product.sha256,
      output: product.manifest.output,
    },
    reference_class: "candidate",
    schema: 1,
    source: runtime.source,
    target_abi: runtime.target_abi,
  };
  const resolvedBytes = canonicalJsonBytes(resolved);
  const report = {
    capture: { complete: true, unreported_reads: [] },
    inputs: [
      {
        bytes: programBytes.byteLength,
        id: inputId,
        kind: "package-output",
        placement: "lazy-reference",
        role: "runtime",
        sha256: programSha256,
      },
      {
        bytes: standardLibraryBytes.byteLength,
        id: standardLibraryInputId,
        kind: "package-output",
        placement: "embedded",
        role: "runtime",
        sha256: standardLibrarySha256,
      },
    ],
    kind: "kandelo-vfs-builder-report",
    output: {
      abi: runtime.target_abi,
      bytes: vfsBytes.byteLength,
      name: product.manifest.output,
      path: product.manifest.output,
      sha256: vfsSha256,
    },
    product: resolved.product,
    resolved_inputs_sha256: sha256Hex(resolvedBytes),
    schema: 1,
  };
  const reportBytes = canonicalJsonBytes(report);
  const repository =
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${runtime.target_abi.version}` +
    `-candidates/products/${product.manifest.id}`;
  const manifestDigest = `sha256:${sha256Hex(encoder.encode("miniature browser product"))}`;
  const locator = {
    product_id: product.manifest.id,
    repository,
    manifest_digest: manifestDigest,
    immutable_reference: `${repository}@${manifestDigest}`,
    vfs_layer_sha256: vfsSha256,
    vfs_layer_bytes: vfsBytes.byteLength,
    builder_report_sha256: sha256Hex(reportBytes),
  };
  const context: BrowserEvidenceContextV1 = {
    schema: 1,
    kind: "kandelo-vfs-product-browser-evidence-context",
    request_digest: sha256Hex(encoder.encode("miniature browser request")),
    product: { id: product.manifest.id, manifest_sha256: product.sha256 },
    candidate_product: {
      manifest_digest: manifestDigest,
      vfs_layer_sha256: vfsSha256,
      vfs_layer_bytes: vfsBytes.byteLength,
      builder_report_sha256: sha256Hex(reportBytes),
    },
    runtime,
    host: "browser",
    definition,
    boot: product.manifest.boot,
    mounts: product.manifest.mounts,
    run: {
      repository: "kandelo-dev/kandelo",
      workflow_ref:
        "kandelo-dev/kandelo/.github/workflows/abi-staging.yml@refs/heads/protected",
      run_id: 101,
      job_id: "browser-product-evidence",
      attempt: 1,
    },
  };
  const paths = {
    builderReport: join(root, "builder-report.json"),
    candidateLocator: join(root, "candidate-locator.json"),
    context: join(root, "context.json"),
    definitions: join(root, "definitions.json"),
    output: join(root, "result.json"),
    pages: join(root, "pages.json"),
    products: join(root, "products.json"),
    resolvedInputs: join(root, "resolved-inputs.json"),
    runtimeBundle: join(root, "runtime-bundle.json"),
    runtimeRoot: exactRuntime.runtimeRoot,
    tests: join(root, "tests.json"),
    vfs: join(root, "browser-perl.vfs"),
  };
  writeFileSync(paths.builderReport, reportBytes);
  writeFileSync(paths.candidateLocator, canonicalJsonBytes(locator));
  writeFileSync(paths.context, canonicalJsonBytes(context));
  writeFileSync(paths.definitions, canonicalJsonBytes(definitionRegistry));
  writeFileSync(paths.pages, canonicalJsonBytes(pages));
  writeFileSync(paths.products, canonicalJsonBytes(productCatalog));
  writeFileSync(paths.resolvedInputs, resolvedBytes);
  writeFileSync(paths.runtimeBundle, exactRuntime.bundleBytes);
  writeFileSync(paths.tests, canonicalJsonBytes(tests));
  writeFileSync(paths.vfs, vfsBytes);
  return { options: paths, programBytes, reference };
}

function selectionInput(
  productId: string,
  definitionId: string,
): BrowserEvidenceSelectionInputV1 {
  const vfsUrl =
    `http://127.0.0.1:5541/__abi_staging/${productId}/product.vfs.zst`;
  const definition = (definitions as {
    definitions: Array<{ id: string; probe: { lazy_inputs?: string[] } }>;
  }).definitions.find((item) => item.id === definitionId)!;
  const servedLazyAssets = (definition.probe.lazy_inputs ?? []).map((id) => {
    const reference =
      `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${targetAbi}-candidates/` +
      `packages/${id}@sha256:${digest}`;
    return {
      id,
      reference,
      url: new URL(reference, new URL("/", vfsUrl)).href,
      sha256: digest,
      bytes: 41,
    };
  });
  return {
    candidateReference:
      `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${targetAbi}-candidates/` +
      `products/${productId}@sha256:${digest}`,
    definitionId,
    definitions,
    pages,
    productId,
    products,
    servedVfs: {
      bytes: 71,
      sha256: digest,
      sourceKind: "protected-local-candidate-vfs",
      url: vfsUrl,
    },
    servedLazyAssets,
    servedBrowserHost: {
      url: new URL("abi-staging/browser-host.js", new URL("/", vfsUrl)).href,
      sha256: digest,
      bytes: 8,
    },
    servedBrowserHarness: {
      url: new URL("abi-staging-harness/index.html", new URL("/", vfsUrl)).href,
      sha256: digest,
      bytes: 8,
    },
    servedKernelAsset: {
      url: new URL("assets/kernel.wasm", new URL("/", vfsUrl)).href,
      sha256: digest,
      bytes: 8,
    },
    targetAbi,
    tests,
  };
}

function evidenceContext(
  productId = "browser-node",
  definitionId = "node-vfs-browser-startup",
): BrowserEvidenceContextV1 {
  const selection = buildBrowserEvidenceSelection(
    selectionInput(productId, definitionId),
  );
  const definition = (definitions as {
    definitions: BrowserEvidenceContextV1["definition"][];
  }).definitions.find((item) => item.id === definitionId)!;
  return {
    schema: 1,
    kind: "kandelo-vfs-product-browser-evidence-context",
    request_digest: digest,
    product: { id: productId, manifest_sha256: selection.manifestSha256 },
    candidate_product: {
      manifest_digest: `sha256:${digest}`,
      vfs_layer_sha256: digest,
      vfs_layer_bytes: selection.vfs.bytes,
      builder_report_sha256: digest,
    },
    runtime: {
      bundle_sha256: digest,
      source: {
        repository: "example/kandelo",
        commit: gitSha,
        tree: gitSha,
      },
      target_abi: { version: targetAbi, snapshot_sha256: digest },
      kernel: {
        abi_version: targetAbi,
        bytes: 8,
        snapshot_sha256: digest,
        wasm_sha256: digest,
      },
      host_runtime: {
        bundle_sha256: digest,
        bytes: 8,
        generated_abi_sha256: digest,
        worker_protocol_sha256: digest,
      },
      browser: {
        bundle_sha256: digest,
        bytes: 8,
        harness_entry_bytes: 8,
        harness_entry_path: "browser/dist/abi-staging-harness/index.html",
        harness_entry_sha256: digest,
        host_entry_bytes: 8,
        host_entry_path: "browser/dist/abi-staging/browser-host.js",
        host_entry_sha256: digest,
        kernel_asset_path: "browser/dist/assets/kernel.wasm",
        kernel_asset_sha256: digest,
        service_worker_sha256: digest,
      },
      build_policy_sha256: digest,
    },
    host: "browser",
    definition,
    boot: selection.boot,
    mounts: selection.mounts,
    run: {
      repository: "example/kandelo",
      workflow_ref: "example/kandelo/.github/workflows/evidence.yml@refs/heads/main",
      run_id: 1,
      job_id: "browser-evidence",
      attempt: 1,
    },
  };
}

function fakeBrowserExecutor(
  execute: BrowserEvidenceExecutor["execute"],
): BrowserEvidenceExecutor {
  return {
    execute,
    async cancel() {},
    async dispose() {},
  };
}

test("selects every registered browser definition from the test-owned registry", () => {
  const registry = tests as {
    registrations: Array<{ browser?: string[]; product: string }>;
  };
  const selected = registry.registrations.flatMap((registration) =>
    (registration.browser ?? []).map((definitionId) =>
      buildBrowserEvidenceSelection(
        selectionInput(registration.product, definitionId),
      )
    )
  );

  assert.ok(selected.length > 0);
  assert.deepEqual(
    selected.map((item) => `${item.productId}:${item.definitionId}`).sort(),
    registry.registrations.flatMap((registration) =>
      (registration.browser ?? []).map(
        (definitionId) => `${registration.product}:${definitionId}`,
      )
    ).sort(),
  );
  assert.ok(selected.every((item) => item.host === "browser"));
});

test("routes every browser runner surface through the protected adapter", async () => {
  const calls: string[] = [];
  const adapter: ProtectedBrowserOperationAdapter = {
    async startService() {
      calls.push("service");
    },
    async exec(request) {
      calls.push(`exec:${request.argv[0]}:${request.stdin ?? ""}`);
      return { exitCode: 0, stdout: "54\n", stderr: "" };
    },
    async pty(input) {
      calls.push(`pty:${String(input)}`);
      return {
        exitCode: 0,
        stdout: "kandelo-main-shell-ready\nsecond-command-ready\n",
        stderr: "",
      };
    },
    async fetchHttp(path) {
      calls.push(`http:${path}`);
      return { status: 200, body: "Welcome" };
    },
    async verifyWordPressLogin() {
      calls.push("wordpress-login");
      return {
        adminBody: '<body class="wp-admin"><div id="wpadminbar"></div></body>',
        adminStatus: 200,
        authenticatedCookie: true,
        loginBody: '<form id="loginform">Log In</form>',
        loginStatus: 200,
        redirectLocation: "/wp-admin/",
        redirectStatus: 302,
      };
    },
    async queryMySql(statement) {
      calls.push(`sql:${statement}`);
      return { columns: ["1"], rows: [["1"]], info: "" };
    },
    async queryRedis(request) {
      calls.push(`redis:${request}`);
      return { type: "string" as const, value: "PONG" };
    },
    async observeFramebuffer(request) {
      calls.push(`framebuffer:${request.argv.join(" ")}`);
      return { nonzeroPixels: 64 };
    },
    async observeModeset(request) {
      calls.push(`modeset:${request.argv.join(" ")}`);
      return { commitCount: 2, nonzeroPixels: 64, width: 1920, height: 1080 };
    },
  };

  const cases = [
    {
      surface: "node",
      definition: {
        id: "node-vfs-browser-startup",
        runner: "exec",
        probe: {
          argv: ["/usr/bin/node", "-e", "console.log(6 * 9)"],
          stdin: "",
          stdout_exact: "54\n",
        },
      },
    },
    {
      surface: "shell",
      definition: {
        id: "main-shell-basic-e2e",
        runner: "interactive-terminal",
        probe: {
          input: [
            "printf 'kandelo-main-shell-ready\\n'",
            "printf 'second-command-ready\\n'",
          ],
          output_contains: ["kandelo-main-shell-ready", "second-command-ready"],
        },
      },
    },
    {
      surface: "nginx",
      definition: {
        id: "nginx-vfs-browser-startup",
        runner: "http",
        probe: { path: "/", status: 200, body_contains: "Welcome" },
      },
    },
    {
      surface: "mariadb",
      definition: {
        id: "mariadb-wasm32-browser-startup",
        runner: "sql",
        probe: { statements: ["SELECT 1"], results_exact: ["1"] },
      },
    },
    {
      surface: "redis",
      definition: {
        id: "redis-vfs-browser-startup",
        runner: "service-protocol",
        probe: { protocol: "redis", request: "PING", response_exact: "PONG" },
      },
    },
    {
      surface: "wordpress-sqlite",
      definition: {
        id: "wordpress-sqlite-browser-e2e",
        runner: "repository-suite",
        probe: { suite: "wordpress-sqlite-browser" },
      },
    },
    {
      surface: "doom",
      definition: {
        id: "main-shell-fbdoom-e2e",
        runner: "repository-suite",
        probe: { suite: "main-shell-fbdoom-browser" },
      },
    },
    {
      surface: "modeset",
      definition: {
        id: "main-shell-modeset-e2e",
        runner: "repository-suite",
        probe: { suite: "main-shell-modeset-browser" },
      },
    },
  ] as const;

  for (const item of cases) {
    await executeProtectedBrowserOperation(
      item.definition,
      item.surface,
      adapter,
    );
  }
  assert.deepEqual(calls, [
    "exec:/usr/bin/node:",
    "pty:printf 'kandelo-main-shell-ready\\n'",
    "pty:printf 'second-command-ready\\n'",
    "http:/",
    "sql:SELECT 1",
    "redis:PING",
    "wordpress-login",
    "framebuffer:/usr/local/bin/fbdoom -iwad /doom1.wad",
    "modeset:/usr/local/bin/modeset",
  ]);
});

test("starts a manifest-owned service before a protected repository suite", async () => {
  const calls: string[] = [];
  const adapter = {
    async startService() {
      calls.push("service");
    },
    async exec() {
      calls.push("exec");
      throw new Error("stop after observing the service ordering");
    },
    async pty() { throw new Error("unexpected PTY"); },
    async fetchHttp() { throw new Error("unexpected HTTP"); },
    async verifyWordPressLogin() { throw new Error("unexpected WordPress login"); },
    async queryMySql() { throw new Error("unexpected SQL"); },
    async queryRedis() { throw new Error("unexpected Redis"); },
    async observeFramebuffer() { throw new Error("unexpected framebuffer"); },
    async observeModeset() { throw new Error("unexpected modeset"); },
  } as ProtectedBrowserOperationAdapter;

  await assert.rejects(
    () => executeProtectedBrowserOperation({
      id: "mariadb-suite-browser",
      runner: "repository-suite",
      probe: { suite: "mariadb-product-browser" },
    }, "mariadb-suite", adapter),
    /stop after observing/,
  );
  assert.deepEqual(calls, ["service", "exec"]);
});

test("rejects ambiguous SQL rows and Redis error replies", async () => {
  const base = {
    async startService() {},
    async exec() { throw new Error("unexpected exec"); },
    async pty() { throw new Error("unexpected PTY"); },
    async fetchHttp() { throw new Error("unexpected HTTP"); },
    async verifyWordPressLogin() { throw new Error("unexpected WordPress login"); },
    async observeFramebuffer() { throw new Error("unexpected framebuffer"); },
    async observeModeset() { throw new Error("unexpected modeset"); },
  };
  await assert.rejects(
    () => executeProtectedBrowserOperation({
      id: "mariadb-wasm32-browser-startup",
      runner: "sql",
      probe: { statements: ["SELECT 1"], results_exact: ["1"] },
    }, "mariadb", {
      ...base,
      async queryMySql() {
        return { columns: ["value"], rows: [["1"], ["2"]] };
      },
      async queryRedis() { throw new Error("unexpected Redis"); },
    }),
    /SQL result predicate/,
  );
  await assert.rejects(
    () => executeProtectedBrowserOperation({
      id: "redis-vfs-browser-startup",
      runner: "service-protocol",
      probe: { protocol: "redis", request: "PING", response_exact: "PONG" },
    }, "redis", {
      ...base,
      async queryMySql() { throw new Error("unexpected SQL"); },
      async queryRedis() { return { type: "error" as const, value: "PONG" }; },
    }),
    /Redis protocol error/,
  );
});

test("rejects a committed modeset scanout that rendered no pixels", async () => {
  const adapter = {
    async startService() { throw new Error("unexpected service"); },
    async exec() { throw new Error("unexpected exec"); },
    async pty() { throw new Error("unexpected PTY"); },
    async fetchHttp() { throw new Error("unexpected HTTP"); },
    async verifyWordPressLogin() { throw new Error("unexpected WordPress login"); },
    async queryMySql() { throw new Error("unexpected SQL"); },
    async queryRedis() { throw new Error("unexpected Redis"); },
    async observeFramebuffer() { throw new Error("unexpected framebuffer"); },
    async observeModeset() {
      return { commitCount: 2, nonzeroPixels: 0, width: 1920, height: 1080 };
    },
  } as ProtectedBrowserOperationAdapter;
  await assert.rejects(
    () => executeProtectedBrowserOperation({
      id: "main-shell-modeset-e2e",
      runner: "repository-suite",
      probe: { suite: "main-shell-modeset-browser" },
    }, "modeset", adapter),
    /rendered no visible pixels/,
  );
});

test("waits for a complete PTY status line instead of its echoed marker", () => {
  const marker = "__KANDELO_EVIDENCE_STATUS_1__";
  const echoed = `printf '${marker}:%s\\n' \"$?\"\r\n`;
  assert.equal(completedPtyCommand(echoed, 0, marker), undefined);
  assert.deepEqual(
    completedPtyCommand(`${echoed}command-ready\r\n${marker}:0\r\n`, 0, marker),
    {
      exitCode: 0,
      nextOffset: `${echoed}command-ready\r\n${marker}:0\r\n`.length,
      stdout: `${echoed}command-ready\r\n`,
    },
  );
});

test("derives Pages load placement without a browser-owned product list", () => {
  assert.equal(
    buildBrowserEvidenceSelection(
      selectionInput("browser-main-shell", "main-shell-basic-e2e"),
    ).pagesLoad,
    "eager",
  );
  assert.equal(
    buildBrowserEvidenceSelection(
      selectionInput("browser-node", "node-vfs-browser-startup"),
    ).pagesLoad,
    "lazy",
  );
  assert.equal(
    buildBrowserEvidenceSelection(
      selectionInput("browser-python", "python-vfs-browser-smoke"),
    ).pagesLoad,
    null,
  );
});

test("Pages placement starts eager bytes before activation and lazy bytes only after it", async () => {
  const eagerSource = buildBrowserEvidenceSelection(
    selectionInput("browser-main-shell", "main-shell-basic-e2e"),
  ).vfs;
  const lazySource = buildBrowserEvidenceSelection(
    selectionInput("browser-node", "node-vfs-browser-startup"),
  ).vfs;
  const loads: string[] = [];
  const load = async (source: typeof eagerSource): Promise<ArrayBuffer> => {
    loads.push(source.productId);
    return new Uint8Array([1, 2, 3]).buffer;
  };

  const eager = createProtectedCandidatePagesVfsPlacement(eagerSource, load);
  assert.deepEqual(loads, ["browser-main-shell"]);
  assert.equal((await eager.activate()).byteLength, 3);
  assert.equal((await eager.bytes()).byteLength, 3);
  assert.deepEqual(loads, ["browser-main-shell"]);

  const lazy = createProtectedCandidatePagesVfsPlacement(lazySource, load);
  assert.deepEqual(loads, ["browser-main-shell"]);
  await assert.rejects(() => lazy.bytes(), /not activated/);
  assert.equal((await lazy.activate()).byteLength, 3);
  assert.equal((await lazy.bytes()).byteLength, 3);
  assert.deepEqual(loads, ["browser-main-shell", "browser-node"]);

  let activations = 0;
  const target = {} as Window;
  installProtectedCandidatePagesActivation(target, lazy, async () => {
    activations += 1;
  });
  await Promise.all([
    target.__KANDELO_ABI_STAGING_ACTIVATE_PAGES_PRODUCT__!(),
    target.__KANDELO_ABI_STAGING_ACTIVATE_PAGES_PRODUCT__!(),
  ]);
  assert.equal(activations, 1);
});

test("binds basic, fbDOOM, and modeset to the same candidate main-shell image", () => {
  const cases = [
    ["main-shell-basic-e2e", "shell"],
    ["main-shell-fbdoom-e2e", "doom"],
    ["main-shell-modeset-e2e", "modeset"],
  ] as const;

  for (const [definitionId, surface] of cases) {
    const selected = buildBrowserEvidenceSelection(
      selectionInput("browser-main-shell", definitionId),
    );
    assert.equal(selected.surface, surface);
    assert.equal(selected.vfs.sha256, digest);
    assert.equal(selected.vfs.sourceKind, "protected-local-candidate-vfs");
  }
});

test("binds the protected harness and browser runtime assets", async () => {
  const input = selectionInput("browser-node", "node-vfs-browser-startup");
  const selected = buildBrowserEvidenceSelection(input);
  assert.deepEqual(selected.browserHarness, input.servedBrowserHarness);
  assert.deepEqual(selected.browserHost, input.servedBrowserHost);
  assert.deepEqual(selected.kernelAsset, input.servedKernelAsset);

  const context = evidenceContext();
  const wrongAsset = structuredClone(selected);
  wrongAsset.kernelAsset.sha256 = "c".repeat(64);
  const result = await runBrowserProductEvidence(
    { context, selection: wrongAsset },
    fakeBrowserExecutor(async () => ({ stdout: "forged\n", stderr: "" })),
  );
  assert.equal(result.outcome, "failure");
  assert.match(
    result.bounded_diagnostics.map((item) => item.text).join("\n"),
    /kernel asset/,
  );
});

test("candidate optional VFS selection cannot fall back to a default importer", async () => {
  const selected = buildBrowserEvidenceSelection(
    selectionInput("browser-node", "node-vfs-browser-startup"),
  );
  const runtime = {
    browserHost: selected.browserHost,
    kernelAsset: selected.kernelAsset,
  };
  let imported = false;
  const resolved = await resolveCandidateOrDefaultOptionalVfsUrl(
    "node",
    selected.vfs,
    async () => {
      imported = true;
      return "/default-node.vfs.zst";
    },
  );

  assert.equal(resolved, selected.vfs.url);
  assert.equal(imported, false);
});

test("rejects a canonical product reference and an unregistered product pairing", () => {
  const canonical = selectionInput(
    "browser-node",
    "node-vfs-browser-startup",
  );
  canonical.candidateReference = canonical.candidateReference.replace(
    "-candidates/",
    "/",
  );
  assert.throws(
    () => buildBrowserEvidenceSelection(canonical),
    /candidate namespace/,
  );

  assert.throws(
    () =>
      buildBrowserEvidenceSelection(
        selectionInput("browser-node", "python-vfs-browser-smoke"),
      ),
    /test-owned registry/,
  );
});

test("accepts candidate boot only through the closed injected object", () => {
  const selected = buildBrowserEvidenceSelection(
    selectionInput("browser-node", "node-vfs-browser-startup"),
  );
  const runtime = {
    browserHost: selected.browserHost,
    kernelAsset: selected.kernelAsset,
  };

  assert.deepEqual(
    readInjectedProtectedCandidateVfs({
      schema: 1,
      kind: "kandelo-protected-browser-evidence-boot",
      boot: selected.boot,
      mounts: selected.mounts,
      runtime,
      vfs: selected.vfs,
    }),
    selected.vfs,
  );
  assert.equal(readInjectedProtectedCandidateVfs(undefined), undefined);

  const remote = structuredClone(selected.vfs);
  remote.url = "https://example.invalid/product.vfs.zst";
  assert.throws(
    () =>
      readInjectedProtectedCandidateVfs({
        schema: 1,
        kind: "kandelo-protected-browser-evidence-boot",
        boot: selected.boot,
        mounts: selected.mounts,
        runtime,
        vfs: remote,
      }),
    /protected local URL/,
  );
  assert.throws(
    () =>
      readInjectedProtectedCandidateVfs({
        schema: 1,
        kind: "kandelo-protected-browser-evidence-boot",
        boot: selected.boot,
        mounts: selected.mounts,
        runtime,
        vfs: selected.vfs,
        unexpected: true,
      }),
    /fields differ/,
  );

  assert.throws(
    () =>
      readInjectedProtectedCandidateVfs({
        schema: 1,
        kind: "kandelo-protected-browser-evidence-boot",
        boot: { ...selected.boot, argv: [] },
        mounts: selected.mounts,
        runtime,
        vfs: selected.vfs,
      }),
    /boot argv/,
  );
});

test("derives the normal live profile, descriptor, and host mounts from protected product intent", () => {
  const selected = buildBrowserEvidenceSelection(
    selectionInput("browser-nginx", "nginx-vfs-browser-startup"),
  );
  const injected = readInjectedProtectedBrowserEvidence({
    schema: 1,
    kind: "kandelo-protected-browser-evidence-boot",
    boot: selected.boot,
    mounts: selected.mounts,
    runtime: {
      browserHost: selected.browserHost,
      kernelAsset: selected.kernelAsset,
    },
    vfs: selected.vfs,
  });
  assert.ok(injected);
  const base = {
    version: 1 as const,
    id: "nginx",
    title: "Nginx",
    base: "kandelo:nginx@local",
    runtime: {
      arch: "wasm32" as const,
      kernel: "kernel@local",
      memoryPages: 2048,
      features: ["shared-array-buffer", "tcp-bridge"],
      time: "real" as const,
    },
    packages: ["legacy-default"],
    mounts: [],
    boot: { argv: ["wrong"], cwd: "/", env: {}, uid: 1, gid: 1 },
    caps: { network: true },
  };

  assert.equal(candidateEvidenceLiveDemoId(injected.vfs.profile), "nginx");
  assert.deepEqual(candidateEvidenceBootDescriptor(base, injected), {
    ...base,
    id: "browser-nginx",
    title: "Nginx (candidate evidence)",
    packages: [],
    mounts: [
      {
        path: "/",
        source: "image",
        ref: `sha256:${digest}`,
        readonly: false,
      },
      { path: "/tmp", source: "scratch", ephemeral: true },
    ],
    boot: selected.boot,
  });
  assert.deepEqual(hostMountSpecFromProductMounts(injected.mounts), [
    { path: "/", source: "image", readonly: false },
    {
      path: "/tmp",
      source: "scratch",
      mode: 0o1777,
      uid: 0,
      gid: 0,
      ephemeral: true,
    },
  ]);
});

test("passes the canonical product mounts into candidate kernel initialization", () => {
  const selected = buildBrowserEvidenceSelection(
    selectionInput("browser-nginx", "nginx-vfs-browser-startup"),
  );
  const injected = readInjectedProtectedBrowserEvidence({
    schema: 1,
    kind: "kandelo-protected-browser-evidence-boot",
    boot: selected.boot,
    mounts: selected.mounts,
    runtime: {
      browserHost: selected.browserHost,
      kernelAsset: selected.kernelAsset,
    },
    vfs: selected.vfs,
  });
  assert.ok(injected);
  const kernelWasm = new ArrayBuffer(3);
  const vfsImage = new Uint8Array([4, 5, 6]);

  assert.deepEqual(
    candidateEvidenceKernelInitOptions(injected, kernelWasm, vfsImage),
    {
      kernelWasm,
      vfsImage,
      lazyUrlBase: new URL("/", selected.vfs.url).href,
      rootfsMountSpec: [
        { path: "/", source: "image", readonly: false },
        {
          path: "/tmp",
          source: "scratch",
          mode: 0o1777,
          uid: 0,
          gid: 0,
          ephemeral: true,
        },
      ],
    },
  );
});

test("resolves the exact candidate boot executable instead of image presentation defaults", () => {
  const modes = new Map([
    ["/usr/local/bin/bash", 0o100755],
    ["/bin/presentation-shell", 0o100755],
  ]);
  const fs = {
    stat(path: string) {
      const mode = modes.get(path);
      if (mode === undefined) throw new Error("ENOENT");
      return { mode };
    },
  };
  assert.equal(
    resolveCandidateEvidenceBootExecutable(fs, {
      argv: ["bash", "-l", "-i"],
      cwd: "/home/user",
      uid: 1000,
      gid: 1000,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    }),
    "/usr/local/bin/bash",
  );
  assert.throws(
    () =>
      resolveCandidateEvidenceBootExecutable(fs, {
        argv: ["relative/bash"],
        cwd: "/",
        uid: 0,
        gid: 0,
        env: { PATH: "/bin" },
      }),
    /neither absolute nor a PATH name/,
  );
});

test("bounds candidate suite output at ingestion without throwing from callbacks", () => {
  const output = new ProtectedBrowserEvidenceOutput(4, 2);
  for (let index = 0; index < 10_000; index++) output.append(new Uint8Array());
  output.append(new TextEncoder().encode("ab"));
  output.append(new TextEncoder().encode("cd"));
  assert.equal(output.text(), "abcd");
  assert.doesNotThrow(() => output.append(new Uint8Array([1])));
  assert.throws(() => output.text(), /exceeded its protected bound/);

  const malformed = new ProtectedBrowserEvidenceOutput();
  assert.doesNotThrow(() => malformed.append("not bytes"));
  assert.throws(() => malformed.text(), /malformed output chunk/);
});

test("wires the injected candidate through the normal live browser host without default artifacts", () => {
  const source = readFileSync(
    "apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts",
    "utf8",
  );
  assert.match(
    source,
    /readInjectedProtectedBrowserEvidence\(\s*window\.__KANDELO_ABI_STAGING_BROWSER_EVIDENCE__/,
  );
  assert.match(source, /profileForCandidateEvidence\(/);
  assert.match(
    source,
    /createProtectedCandidatePagesVfsPlacement\(/,
  );
  assert.match(
    source,
    /installProtectedCandidatePagesActivation\(/,
  );
  assert.match(
    source,
    /profile\.candidateVfsPlacement\.bytes\(\)/,
  );
  assert.doesNotMatch(
    source,
    /fetchProtectedCandidateVfs\(profile\.candidateEvidence\.vfs\)/,
  );
  assert.match(source, /candidateEvidenceKernelInitOptions\(/);
  assert.match(source, /programUrl:\s*undefined/);
  assert.match(source, /candidate evidence VFS does not import fallback binaries/);
  assert.match(
    source,
    /if \(profile\.candidateEvidence === undefined\) \{\s*if \(\s*profile\.id === "nginx-php"/,
  );
  assert.match(
    source,
    /maxProcessMemoryBytes:\s*PROTECTED_BROWSER_EVIDENCE_MAX_PROCESS_MEMORY_BYTES/,
  );
});

test("Playwright accepts only the protected loopback server supplied by the browser runner", () => {
  const source = readFileSync("apps/browser-demos/playwright.config.ts", "utf8");
  assert.match(source, /KANDELO_ABI_STAGING_BROWSER_BASE_URL/);
  assert.match(source, /protectedBrowserBaseUrl === undefined\s*\?\s*\{/);
  assert.match(source, /protectedBrowserBaseUrl === undefined\s*\?\s*`http:\/\/127\.0\.0\.1:/);
  assert.match(source, /:\s*protectedBrowserBaseUrl/);
  assert.match(source, /proxy-bypass-list=<[-]loopback>/);
  assert.match(source, /proxy:[\s\S]*server: new URL\(protectedBrowserBaseUrl\)\.origin/);
  const spec = readFileSync(
    "apps/browser-demos/test/abi-staging-product-evidence.spec.ts",
    "utf8",
  );
  assert.match(spec, /await page\.route\("\*\*\/\*"/);
  assert.match(spec, /url\.origin !== protectedOrigin/);
  assert.match(spec, /selection\.pagesLoad === "eager"/);
  assert.match(
    spec,
    /__KANDELO_ABI_STAGING_ACTIVATE_PAGES_PRODUCT__/,
  );
  assert.match(spec, /expect\(vfsRequests\.get\("ui"\)\)\.toBeUndefined\(\)/);
});

test("builds the browser evidence harness from the protected checkout", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "kandelo-protected-browser-harness-"));
  try {
    const result = spawnSync(
      resolve("apps/browser-demos/node_modules/.bin/vite"),
      [
        "build",
        "--config",
        resolve("apps/browser-demos/abi-staging-browser-harness.config.ts"),
        "--outDir",
        outputRoot,
        "--emptyOutDir",
      ],
      {
        cwd: resolve("apps/browser-demos"),
        encoding: "utf8",
        env: {
          HOME: outputRoot,
          LANG: "C",
          PATH: process.env.PATH,
          TMPDIR: outputRoot,
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const html = readFileSync(join(outputRoot, "index.html"), "utf8");
    assert.match(html, /\/abi-staging-harness\/assets\/[^\"]+\.js/);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("rejects a runtime-supplied replacement for the protected browser harness", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-protected-harness-verify-"));
  const runtimeRoot = join(root, "runtime");
  const runtimeHarness = join(
    runtimeRoot,
    "browser/dist/abi-staging-harness",
  );
  const workRoot = join(root, "protected-work");
  mkdirSync(runtimeHarness, { recursive: true });
  mkdirSync(workRoot);
  try {
    const result = spawnSync(
      resolve("apps/browser-demos/node_modules/.bin/vite"),
      [
        "build",
        "--config",
        resolve("apps/browser-demos/abi-staging-browser-harness.config.ts"),
        "--outDir",
        runtimeHarness,
        "--emptyOutDir",
      ],
      {
        cwd: resolve("apps/browser-demos"),
        encoding: "utf8",
        env: {
          HOME: root,
          LANG: "C",
          PATH: process.env.PATH,
          TMPDIR: root,
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const assetRoot = join(runtimeHarness, "assets");
    const script = readdirSync(assetRoot).find((name) => name.endsWith(".js"));
    assert.ok(script !== undefined);
    const scriptPath = join(assetRoot, script);
    writeFileSync(
      scriptPath,
      `${readFileSync(scriptPath, "utf8")}\nwindow.__forgedEvidence = true;\n`,
    );

    await assert.rejects(
      () => prepareVerifiedProtectedBrowserHarness({
        deadlineAt: Date.now() + 30_000,
        runtimeRoot,
        workRoot,
      }),
      /differs from the freshly built protected checkout/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builds exact browser host workers under the attested host subtree", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "kandelo-exact-browser-host-"));
  try {
    const result = spawnSync(
      resolve("apps/browser-demos/node_modules/.bin/vite"),
      [
        "build",
        "--config",
        resolve("apps/browser-demos/abi-staging-browser-host.config.ts"),
        "--outDir",
        outputRoot,
        "--emptyOutDir",
      ],
      {
        cwd: resolve("apps/browser-demos"),
        encoding: "utf8",
        env: {
          HOME: outputRoot,
          KANDELO_ABI_STAGING_EXACT_SOURCE_ROOT: resolve("."),
          LANG: "C",
          PATH: process.env.PATH,
          TMPDIR: outputRoot,
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const entry = readFileSync(join(outputRoot, "browser-host.js"), "utf8");
    assert.match(entry, /\/abi-staging\/assets\/worker-entry-browser-[^\"]+\.js/);
    assert.match(
      entry,
      /\/abi-staging\/assets\/browser-kernel-worker-entry-[^\"]+\.js/,
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("proves Pages-owned eager and lazy VFS placement in real Chromium", {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-placement-chromium-"));
  const distRoot = join(root, "dist");
  const fixtureHome = join(root, "home");
  const fixtureTmp = join(root, "tmp");
  mkdirSync(fixtureHome);
  mkdirSync(fixtureTmp);
  const build = spawnSync(
    resolve("apps/browser-demos/node_modules/.bin/vite"),
    [
      "build",
      "--config",
      resolve("apps/browser-demos/abi-staging-pages-placement.config.ts"),
      "--outDir",
      distRoot,
      "--emptyOutDir",
    ],
    {
      cwd: resolve("apps/browser-demos"),
      encoding: "utf8",
      env: {
        HOME: fixtureHome,
        LANG: "C",
        PATH: process.env.PATH,
        TMPDIR: fixtureTmp,
      },
    },
  );
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

  const originalBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = installedPlaywrightBrowsersPath();
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const vfsBytes = encoder.encode("miniature Pages placement VFS\n");
    const vfsPath = join(root, "product.vfs.zst");
    writeFileSync(vfsPath, vfsBytes);
    const cases = [
      {
        definitionId: "main-shell-basic-e2e",
        expectedLoad: "eager",
        productId: "browser-main-shell",
      },
      {
        definitionId: "node-vfs-browser-startup",
        expectedLoad: "lazy",
        productId: "browser-node",
      },
    ] as const;
    for (const fixture of cases) {
      const selected = buildBrowserEvidenceSelection(
        selectionInput(fixture.productId, fixture.definitionId),
      );
      assert.equal(selected.pagesLoad, fixture.expectedLoad);
      const server = await startProtectedBrowserEvidenceServer({
        distRoot,
        runtimeBytes: runtimeInventory(distRoot).reduce(
          (total, entry) => total + entry.bytes,
          0,
        ),
        productId: fixture.productId,
        vfs: {
          path: vfsPath,
          bytes: vfsBytes.byteLength,
          sha256: sha256Hex(vfsBytes),
        },
        lazyAssets: [],
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        const source = {
          ...selected.vfs,
          bytes: vfsBytes.byteLength,
          pagesLoad: fixture.expectedLoad,
          sha256: sha256Hex(vfsBytes),
          url: new URL(
            `__abi_staging/${fixture.productId}/product.vfs.zst`,
            server.baseUrl,
          ).href,
        };
        await page.addInitScript((input) => {
          Object.defineProperty(
            window,
            "__KANDELO_ABI_STAGING_PAGES_PLACEMENT_SOURCE__",
            {
              configurable: false,
              enumerable: false,
              writable: false,
              value: input,
            },
          );
        }, source);
        let candidateRequests = 0;
        page.on("request", (request) => {
          if (request.url() === source.url) candidateRequests += 1;
        });
        const response = page.waitForResponse(
          (candidate) => candidate.url() === source.url,
          { timeout: 60_000 },
        );
        await page.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() =>
          window.__KANDELO_ABI_STAGING_PAGES_PLACEMENT_FIXTURE__ !== undefined
        );
        if (fixture.expectedLoad === "eager") {
          assert.equal((await response).status(), 200);
          assert.equal(candidateRequests, 1);
        } else {
          assert.equal(candidateRequests, 0);
        }
        await assert.rejects(
          () => page.evaluate(async () =>
            window.__KANDELO_ABI_STAGING_PAGES_PLACEMENT_FIXTURE__!.bytes()
          ),
          /not activated/,
        );
        if (selected.vfs.optionalImage !== undefined) {
          const resolution = await page.evaluate(async (image) =>
            window.__KANDELO_ABI_STAGING_PAGES_PLACEMENT_FIXTURE__!
              .resolveOptional(image), selected.vfs.optionalImage
          );
          assert.deepEqual(resolution, { fallbackCalls: 0, url: source.url });
          await assert.rejects(
            () => page.evaluate(async () =>
              window.__KANDELO_ABI_STAGING_PAGES_PLACEMENT_FIXTURE__!
                .resolveOptional("wordpress")
            ),
            /differs from the requested image/,
          );
        }
        assert.equal(
          await page.evaluate(async () =>
            window.__KANDELO_ABI_STAGING_PAGES_PLACEMENT_FIXTURE__!.activate()
          ),
          vfsBytes.byteLength,
        );
        if (fixture.expectedLoad === "lazy") {
          assert.equal((await response).status(), 200);
        }
        assert.equal(candidateRequests, 1);
        assert.equal(
          await page.evaluate(async () =>
            window.__KANDELO_ABI_STAGING_PAGES_PLACEMENT_FIXTURE__!.bytes()
          ),
          vfsBytes.byteLength,
        );
      } finally {
        await context.close();
        await server.close();
      }
    }
  } finally {
    await browser.close();
    if (originalBrowsersPath === undefined) {
      delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    } else {
      process.env.PLAYWRIGHT_BROWSERS_PATH = originalBrowsersPath;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("executes a lazy miniature product through the real Chromium supervisor", {
  // The product deadline remains the protected definition's 180 seconds.
  // This outer test additionally compiles an isolated kernel and both browser
  // bundles, so it needs independent setup/teardown headroom on a cold CI host.
  timeout: 360_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-browser-evidence-chromium-"));
  try {
    const fixture = await writeRealChromiumFixture(root);
    let sourceFetches = 0;
    const originalBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = installedPlaywrightBrowsersPath();
    let result;
    try {
      result = await superviseBrowserEvidenceCli(fixture.options, {
        server: {
          createLazyFetcher(sources) {
            assert.equal(sources.length, 1);
            assert.equal(sources[0]?.url, fixture.reference);
            return createClosedLazyAssetSourceFetcher(sources, {
              fetchImpl: async () => {
                sourceFetches += 1;
                const body = new ArrayBuffer(fixture.programBytes.byteLength);
                new Uint8Array(body).set(fixture.programBytes);
                return new Response(body, {
                  status: 200,
                  headers: { "content-length": String(fixture.programBytes.byteLength) },
                });
              },
            });
          },
        },
      });
    } finally {
      if (originalBrowsersPath === undefined) {
        delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      } else {
        process.env.PLAYWRIGHT_BROWSERS_PATH = originalBrowsersPath;
      }
    }
    assert.equal(
      result.outcome,
      "success",
      result.bounded_diagnostics.map((diagnostic) => diagnostic.text).join("\n"),
    );
    assert.deepEqual(result.guard_codes, []);
    assert.equal(sourceFetches, 1, "lazy program must be fetched exactly on first exec");
    validateProductEvidenceResult(result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("supervisor turns exact-input preflight rejection into a canonical browser result", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-browser-preflight-test-"));
  const contextPath = join(root, "context.json");
  const outputPath = join(root, "result.json");
  writeFileSync(contextPath, canonicalJsonBytes(evidenceContext()));
  try {
    const result = await superviseBrowserEvidenceCli({
      builderReport: join(root, "missing-builder-report.json"),
      candidateLocator: join(root, "missing-locator.json"),
      context: contextPath,
      definitions: join(root, "missing-definitions.json"),
      output: outputPath,
      pages: join(root, "missing-pages.json"),
      products: join(root, "missing-products.json"),
      resolvedInputs: join(root, "missing-resolved-inputs.json"),
      runtimeBundle: join(root, "missing-runtime-bundle.json"),
      runtimeRoot: join(root, "missing-runtime"),
      tests: join(root, "missing-tests.json"),
      vfs: join(root, "missing-product.vfs.zst"),
    });
    assert.equal(result.host, "browser");
    assert.equal(result.outcome, "failure");
    assert.deepEqual(result.guard_codes, ["verification_failed"]);
    validateProductEvidenceResult(result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects malformed protected run identity before browser execution", () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-browser-context-shape-test-"));
  const path = join(root, "context.json");
  const malformed = evidenceContext() as BrowserEvidenceContextV1 & {
    run: BrowserEvidenceContextV1["run"] & { unexpected: string };
  };
  malformed.run.unexpected = "candidate-controlled";
  try {
    writeFileSync(path, canonicalJsonBytes(malformed));
    assert.throws(
      () => assertCurrentBrowserEvidenceContext(path, malformed),
      /product evidence run fields differ/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("revalidates the protected browser context from disk after execution", () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-browser-context-test-"));
  const path = join(root, "context.json");
  const context = evidenceContext();
  try {
    writeFileSync(path, canonicalJsonBytes(context));
    assert.deepEqual(assertCurrentBrowserEvidenceContext(path, context), context);

    const replaced = structuredClone(context);
    replaced.request_digest = "c".repeat(64);
    writeFileSync(path, canonicalJsonBytes(replaced));
    assert.throws(
      () => assertCurrentBrowserEvidenceContext(path, context),
      /changed during protected execution/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fetches only bytes matching the protected candidate identity", async () => {
  const body = new TextEncoder().encode("miniature candidate VFS\n");
  const selected = buildBrowserEvidenceSelection({
    ...selectionInput("browser-node", "node-vfs-browser-startup"),
    servedVfs: {
      bytes: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
      sourceKind: "protected-local-candidate-vfs",
      url: "http://127.0.0.1:5541/__abi_staging/browser-node/product.vfs.zst",
    },
  });
  const fetcher: typeof fetch = async () => new Response(body, { status: 200 });

  assert.deepEqual(
    new Uint8Array(await fetchProtectedCandidateVfs(selected.vfs, fetcher)),
    body,
  );
  await assert.rejects(
    () =>
      fetchProtectedCandidateVfs(
        { ...selected.vfs, sha256: "b".repeat(64) },
        fetcher,
      ),
    /digest/,
  );
  await assert.rejects(
    () =>
      fetchProtectedCandidateVfs(
        { ...selected.vfs, bytes: body.byteLength - 1 },
        fetcher,
      ),
    /byte count/,
  );
});

test("emits canonical bounded browser success, failure, and timeout results", async () => {
  const context = evidenceContext();
  const selection = buildBrowserEvidenceSelection(
    selectionInput(context.product.id, context.definition.id),
  );
  const session = { context, selection };

  const success = await runBrowserProductEvidence(
    session,
    fakeBrowserExecutor(async () => ({ stdout: "browser ready\n", stderr: "" })),
  );
  assert.equal(success.host, "browser");
  assert.equal(success.outcome, "success");
  assert.deepEqual(success.guard_codes, []);

  const driftedContext = structuredClone(context);
  driftedContext.definition.probe = { argv: ["/bin/false"], stdout_exact: "" };
  driftedContext.definition.definition_sha256 = evidenceDefinitionSha256(
    driftedContext.definition,
  );
  const drifted = await runBrowserProductEvidence(
    { context: driftedContext, selection },
    fakeBrowserExecutor(async () => ({ stdout: "forged\n", stderr: "" })),
  );
  assert.equal(drifted.outcome, "failure");
  assert.deepEqual(drifted.guard_codes, ["verification_failed"]);

  const failure = await runBrowserProductEvidence(
    session,
    fakeBrowserExecutor(async () => {
      throw new Error("candidate browser failed ".repeat(10_000));
    }),
  );
  assert.equal(failure.outcome, "failure");
  assert.deepEqual(failure.guard_codes, ["verification_failed"]);
  assert.ok(failure.bounded_diagnostics.every((item) => item.bytes <= 64 * 1024));

  const timeout = await runBrowserProductEvidence(
    session,
    fakeBrowserExecutor(async () => {
      throw new BrowserEvidenceTimeoutError("protected browser deadline expired");
    }),
  );
  assert.equal(timeout.outcome, "timeout");
  assert.deepEqual(timeout.guard_codes, ["verification_timeout"]);

  const deadlineWon = enforceBrowserEvidenceDeadline(
    context,
    failure,
    10_000,
    10_000,
  );
  assert.equal(deadlineWon.outcome, "timeout");
  assert.deepEqual(deadlineWon.guard_codes, ["verification_timeout"]);
});

test("serves exact runtime, VFS, and lazy bytes from a closed on-demand local server", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-browser-evidence-server-"));
  const distRoot = join(root, "dist");
  const lazyPath = join(root, "lazy.blob");
  const vfsPath = join(root, "product.vfs.zst");
  mkdirSync(distRoot);
  writeFileSync(join(distRoot, "index.html"), "<h1>exact candidate runtime</h1>\n");
  const vfs = new TextEncoder().encode("exact candidate VFS\n");
  const lazy = new TextEncoder().encode("exact lazy layer\n");
  writeFileSync(vfsPath, vfs);
  writeFileSync(lazyPath, lazy);
  let lazyReads = 0;
  const reference =
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${targetAbi}-candidates/` +
    `packages/perl@sha256:${createHash("sha256").update(lazy).digest("hex")}`;
  const server = await startProtectedBrowserEvidenceServer({
    distRoot,
    runtimeBytes: Buffer.byteLength("<h1>exact candidate runtime</h1>\n"),
    productId: "browser-perl",
    vfsGetLimit: 2,
    lazyGetLimit: 2,
    vfs: {
      path: vfsPath,
      bytes: vfs.byteLength,
      sha256: createHash("sha256").update(vfs).digest("hex"),
    },
    lazyAssets: [{
      reference,
      path: lazyPath,
      bytes: lazy.byteLength,
      sha256: createHash("sha256").update(lazy).digest("hex"),
    }],
    onLazyAssetRead: () => lazyReads++,
  });
  try {
    assert.match(await fetch(server.baseUrl).then((r) => r.text()), /exact candidate runtime/);
    assert.equal(await requestStatusWithHost(server.baseUrl, "example.invalid"), 403);
    assert.equal(lazyReads, 0);
    const servedVfs: ArrayBuffer = await fetch(
      `${server.baseUrl}__abi_staging/browser-perl/product.vfs.zst`,
    ).then((response) => response.arrayBuffer());
    assert.deepEqual(new Uint8Array(servedVfs), vfs);
    assert.equal(
      (await fetch(`${server.baseUrl}__abi_staging/browser-perl/product.vfs.zst`)).status,
      200,
    );
    assert.equal(
      (await fetch(`${server.baseUrl}__abi_staging/browser-perl/product.vfs.zst`)).status,
      500,
    );
    assert.equal(lazyReads, 0);
    const servedLazy: ArrayBuffer = await fetch(`${server.baseUrl}${reference}`).then(
      (response) => response.arrayBuffer(),
    );
    assert.deepEqual(new Uint8Array(servedLazy), lazy);
    assert.equal(lazyReads, 1);
    assert.equal((await fetch(`${server.baseUrl}${reference}`)).status, 200);
    assert.equal(lazyReads, 2);
    assert.equal((await fetch(`${server.baseUrl}${reference}`)).status, 500);
    assert.equal(
      (await fetch(`${server.baseUrl}%2e%2e/%2e%2e/etc/passwd`)).status,
      404,
    );
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function requestStatusWithHost(url: string, host: string): Promise<number> {
  return await new Promise<number>((resolveStatus, rejectStatus) => {
    const request = httpRequest(url, { headers: { host } }, (response) => {
      response.resume();
      response.once("end", () => resolveStatus(response.statusCode ?? 0));
    });
    request.once("error", rejectStatus);
    request.end();
  });
}

test("aborts a stalled lazy source and force-closes the protected server", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-browser-evidence-abort-"));
  const distRoot = join(root, "dist");
  const vfsPath = join(root, "product.vfs.zst");
  mkdirSync(distRoot);
  writeFileSync(join(distRoot, "index.html"), "<h1>runtime</h1>\n");
  writeFileSync(vfsPath, "candidate-vfs\n");
  const reference =
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${targetAbi}-candidates/` +
    `packages/stalled@sha256:${digest}`;
  let fetchStartedResolve!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    fetchStartedResolve = resolve;
  });
  let observedSignal: AbortSignal | undefined;
  const server = await startProtectedBrowserEvidenceServer({
    distRoot,
    runtimeBytes: Buffer.byteLength("<h1>runtime</h1>\n"),
    productId: "browser-perl",
    vfs: {
      path: vfsPath,
      bytes: 14,
      sha256: createHash("sha256").update("candidate-vfs\n").digest("hex"),
    },
    lazyAssets: [{
      reference,
      sourceUrl: "https://example.invalid/stalled.blob",
      bytes: 1,
      sha256: digest,
    }],
  }, {
    createLazyFetcher: () => async (_url, init) => {
      observedSignal = init?.signal;
      fetchStartedResolve();
      return await new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => reject(init?.signal?.reason ?? new Error("aborted"));
        if (init?.signal?.aborted) rejectAbort();
        else init?.signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    },
  });
  try {
    const request = fetch(`${server.baseUrl}${reference}`).catch(() => undefined);
    await fetchStarted;
    assert.equal((await fetch(`${server.baseUrl}${reference}`)).status, 500);
    await Promise.race([
      server.close(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("protected server close hung")), 1_000)
      ),
    ]);
    assert.equal(observedSignal?.aborted, true);
    await request;
  } finally {
    await server.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
