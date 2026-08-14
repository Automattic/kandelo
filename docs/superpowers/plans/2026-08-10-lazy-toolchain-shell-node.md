# Lazy Toolchain Shell and Node Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the candidate and then admitted `kandelo-sdk` closure available as first-use lazy files in the one canonical `browser-main-shell` product and prove real in-guest C/C++ compilation on Node.js.

**Architecture:** The shell selects only the `kandelo-sdk` Formula root; staging first resolves its exact candidate same-tap dependency closure for protected evidence, then reissues the same bottle identities under canonical admissions. A shared worker-owned prefetch API reads the sealed Homebrew composition graph and prepares packages by Formula identity, so callers never supply URLs, paths, or a second dependency list. Node product evidence boots the candidate shell, invokes the packaged compiler in-guest, and executes protected C and C++ outputs; canonical compatibility locks are finalized only after admission.

**Tech Stack:** TypeScript, MemoryFileSystem lazy trees, Node and browser kernel workers, Homebrew VFS composition, TOML VFS product manifests, Vitest, protected ABI-staging evidence runners.

## Global Constraints

- Begin Tasks 1–4 after Formula-plan Tasks 1–4 have produced the exact tap/Kandelo source commits and runtime-claim policy. Do not wait for admissions: this plan's candidate shell and Node evidence are inputs to those admissions.
- Execute Task 5's documentation and branch gate after Tasks 1–4. Canonical
  post-admission recomposition and final evidence belong to the Pages plan,
  which consumes the Formula admissions directly.
- Use a new clean Kandelo worktree based on a revision containing `d52b9bea2`
  (`[Pages] Preserve Phase B product authority`) and its final-site builder;
  never edit the active dirty staging worktree.
- `browser-main-shell` remains the sole shell product. Do not add `browser-c-development` or another Pages VFS product.
- `kandelo-sdk` is lazy. Its bottle and every toolchain dependency bottle must remain unread during ordinary shell boot.
- The prefetch API accepts full Formula names only. It derives dependencies and activation roots from the sealed guest composition.
- Node.js and browser hosts receive the same protocol and public method in the same commit.
- Browser modules must not import compiler Wasm files, name compiler URLs, merge an SDK VFS, or copy compiler bytes.
- Preserve dedicated kernel workers on both hosts. The main thread remains a proxy.
- Initial public compilation scope is C and C++ on wasm32; generated fork-family behavior remains unsupported without an in-guest instrumenter.
- The existing protected-host `kandelo-sdk-node-compile` evidence is supplementary only and cannot satisfy this plan.
- The exact Kandelo request head used by reconciliation must contain the lazy `browser-main-shell` selection and `main-shell-toolchain-node` definition. A locally modified or later commit cannot stand for that source identity.
- Add the existing `developer-kandelo-sdk` implementation to retirement inventory; do not delete it until the staging retirement conditions permit removal.
- Run commands needing repository build dependencies through `scripts/dev-shell.sh`.
- If any implementation changes `libc/musl-overlay` or `libc/glue/channel_syscall.c`, rebuild musl first through `scripts/dev-shell.sh`.
- Do not change `ABI_VERSION` unless `scripts/check-abi-version.sh` reports an incompatible ABI change and the ABI policy requires it.

---

## Two-Phase Staging Boundary

1. Implement and commit the shared prefetch boundary, the lazy Formula root in
   `browser-main-shell`, and protected Node evidence. These source commits are
   part of the exact Kandelo staging request.
2. Complete the Pages plan through its protected browser-evidence task, then
   dispatch reconciliation. Staging resolves candidate Formula layers directly;
   it does not require a pre-existing browser-capable sidecar claim.
3. Let the Formula plan consume the successful Node/browser product-evidence
   record, promote the unchanged candidate layers, and publish admissions.
4. After admission, let generic Pages readiness authenticate each selected
   Formula admission and canonical composition descriptor directly, recompose
   the exact shell, and rerun final evidence. Do not route the toolchain through
   the legacy closed-selection or bottle-mirror release paths.

---

## Preflight: Audit the prototype against the post-staging base

Run before Task 1:

~~~bash
git merge-base --is-ancestor d52b9bea2 HEAD
rg -n "MAP_SHARED|flush.*mmap|munmap" host/src/kernel-worker.ts \
  programs/mmap_shared_test.c host/test
rg -n "ABI.*export|parse.*abi" host/src/worker-main.ts \
  host/src/node-kernel-worker-entry.ts host/src/browser-kernel-worker-entry.ts
rg -n '\.obj' sdk/src/lib/flags.ts
rg -n 'ac_cv_func_tgetent' packages/registry/vim Formula homebrew
~~~

Expected: the current base already contains the prototype’s MAP_SHARED flush, ABI export parsing, `.obj` handling, and Vim `tgetent` correction. Do not cherry-pick those snapshot hunks. If a representative C/C++ evidence fixture later proves a missing header, add only the header justified by that failing fixture.

## File and Interface Map

### Shared package-prefetch boundary

- Create `host/src/homebrew-package-prefetch.ts`: parse the closed guest composition, resolve dependency-first closures, and prepare their keg roots.
- Modify `host/src/homebrew-vfs-builder.ts`: serialize each package’s normalized full dependency identities beside its keg.
- Modify `host/src/homebrew-runtime-layer-consumer.ts` and `scripts/abi-staging-homebrew-composition-descriptor.ts`: carry authenticated direct dependencies in the staged bottle-tree descriptor while retaining read compatibility for historical descriptors.
- Modify `images/vfs/scripts/staged-product-inputs.ts`: serialize the same dependency identities into the canonical staged shell's guest composition.
- Modify `scripts/abi-staging-pages-readiness.ts` and `scripts/abi-staging-verify-bottle.sh`: require the current descriptor version and its closed dependency graph while preserving explicit historical-v1 validation.
- Modify `host/src/node-kernel-protocol.ts` and `host/src/browser-kernel-protocol.ts`: request/response messages for package prefetch.
- Modify `host/src/node-kernel-host.ts` and `host/src/browser-kernel-host.ts`: identical public `prefetchHomebrewPackages` methods.
- Modify `host/src/node-kernel-worker-entry.ts` and `host/src/browser-kernel-worker-entry.ts`: invoke the shared helper on the worker-owned root MemoryFileSystem.
- Modify `host/src/types.ts` and `host/src/index.ts`: export the result type.
- Create `host/test/homebrew-package-prefetch.test.ts`: graph, validation, order, retry, and integrity tests.
- Modify existing host protocol tests for both hosts.

### Product selection

- Modify `images/vfs/products/browser-main-shell.toml`: select `kandelo-sdk` as lazy Homebrew software.
- Modify `homebrew/main-shell.Brewfile`: retain the transitional projection of that root.
- Modify `homebrew/main-shell-compatibility.json`: expose Formula-owned `/usr/lib/llvm` and `/usr/wasm32posix` paths.
- Modify `abi/staging/legacy-retirement.toml`: inventory the legacy developer SDK product and builder.

### Node product evidence

- Modify `abi/staging/evidence-definitions.toml` and regenerate `abi/staging/evidence-definitions.generated.json`.
- Modify `tests/vfs-products.toml`: register `main-shell-toolchain-node`.
- Modify `scripts/abi-staging-product-node-evidence.ts`: protected in-guest C and C++ suite.
- Modify `scripts/abi-staging-product-node-evidence.test.ts`.
- Modify `images/vfs/products/browser-main-shell.toml` evidence selection only if the staging registry requires one primary Node test; the complete test registry must retain both startup and toolchain evidence.

### Stable TypeScript interface

~~~typescript
export interface HomebrewPackagePrefetchResult {
  roots: string[];
  packages: string[];
  materializedPackages: string[];
  alreadyMaterializedPackages: string[];
}

export interface HomebrewPackagePrefetchApi {
  prefetchHomebrewPackages(
    roots: readonly string[],
  ): Promise<HomebrewPackagePrefetchResult>;
}
~~~

`NodeKernelHost` and `BrowserKernel` implement the same structural API; this
does not require callers to depend on a common concrete host class. Formula
names are full names such as `kandelo-dev/tap-core/kandelo-sdk`. Result package
order is dependency-first and deterministic.

## Task 1: Add the worker-owned package-closure prefetch API

**Files:**

- Create: `host/src/homebrew-package-prefetch.ts`
- Create: `host/test/homebrew-package-prefetch.test.ts`
- Modify: `host/src/homebrew-vfs-builder.ts`
- Modify: `host/test/homebrew-vfs-builder.test.ts`
- Modify: `host/src/homebrew-runtime-layer-consumer.ts`
- Modify: `scripts/abi-staging-homebrew-composition-descriptor.ts`
- Modify: `scripts/abi-staging-homebrew-composition-descriptor.test.ts`
- Modify: `images/vfs/scripts/staged-product-inputs.ts`
- Modify: `host/test/abi-staging-product-builders.test.ts`
- Modify: `scripts/abi-staging-pages-readiness.ts`
- Modify: `scripts/abi-staging-pages-readiness.test.ts`
- Modify: `scripts/abi-staging-verify-bottle.sh`
- Modify: `scripts/test-abi-staging-verify-bottle.sh`
- Modify: `host/src/types.ts`
- Modify: `host/src/index.ts`

**Interfaces:**

- Consumes: `MemoryFileSystem.preparePath(path: string): Promise<boolean>` and `/etc/kandelo/homebrew-vfs.json`.
- Produces: `prefetchHomebrewPackageClosures(fs, roots): Promise<HomebrewPackagePrefetchResult>`, authenticated staged-descriptor direct dependencies, and serialized guest package `dependencies: string[]` in both legacy and canonical product builders.

- [ ] **Step 1: Write failing graph and materialization tests**

Create a fixture composition with `kandelo-sdk -> clang -> libcxx` and fake keg-root lazy trees. Assert that callers provide only the SDK root:

~~~typescript
test("prefetches a sealed Homebrew dependency closure in dependency order", async () => {
  const { fs, fetched } = await toolchainFixture();
  const result = await prefetchHomebrewPackageClosures(
    fs,
    ["kandelo-dev/tap-core/kandelo-sdk"],
  );

  expect(result.packages).toEqual([
    "kandelo-dev/tap-core/libcxx",
    "kandelo-dev/tap-core/clang",
    "kandelo-dev/tap-core/kandelo-sdk",
  ]);
  expect(fetched).toEqual([
    "/opt/kandelo/homebrew/Cellar/libcxx/21.1.7_1",
    "/opt/kandelo/homebrew/Cellar/clang/21.1.7",
    "/opt/kandelo/homebrew/Cellar/kandelo-sdk/0.1.0",
  ]);
});

test("rejects a package absent from the sealed composition", async () => {
  const { fs } = await toolchainFixture();
  await expect(prefetchHomebrewPackageClosures(
    fs,
    ["kandelo-dev/tap-core/not-selected"],
  )).rejects.toThrow("is absent from the Homebrew composition");
});

test("retries a failed tree without exposing partial bytes", async () => {
  const { fs, failOnce, readStub } = await toolchainFixture();
  failOnce("kandelo-dev/tap-core/clang");
  await expect(prefetchHomebrewPackageClosures(
    fs,
    ["kandelo-dev/tap-core/kandelo-sdk"],
  )).rejects.toThrow("clang");
  expect(() => readStub("kandelo-dev/tap-core/clang")).toThrow();
  await expect(prefetchHomebrewPackageClosures(
    fs,
    ["kandelo-dev/tap-core/kandelo-sdk"],
  )).resolves.toMatchObject({
    packages: [
      "kandelo-dev/tap-core/libcxx",
      "kandelo-dev/tap-core/clang",
      "kandelo-dev/tap-core/kandelo-sdk",
    ],
  });
});
~~~

In `abi-staging-homebrew-composition-descriptor.test.ts`, require a descriptor
with direct dependencies to preserve the exact same-tap full names through
candidate creation and canonical reissue. In
`abi-staging-product-builders.test.ts`, build a staged shell fixture and assert
that `/etc/kandelo/homebrew-vfs.json` contains those direct edges; reject an
edge to an absent package, another tap, another architecture, or a cycle before
writing the image.

- [ ] **Step 2: Run the focused test and confirm the missing module failure**

Run:

~~~bash
scripts/dev-shell.sh bash -euo pipefail -c '
cd host
npx vitest run test/homebrew-package-prefetch.test.ts
'
~~~

Expected: FAIL because `homebrew-package-prefetch.ts` and composition dependencies do not exist.

- [ ] **Step 3: Add normalized dependency identities to both guest-composition paths**

Version the authenticated Homebrew bottle-tree descriptor so it carries
`dependencies: string[]` beside `required_by`. Candidate construction derives
that array from the tap plan's `direct_dependencies`; canonical reissue may
change only transport authority and must preserve it byte-for-byte. Continue
to parse historical schema-1 descriptors for historical records, but require
the new descriptor version for a current staged product that exposes package
prefetch.

Update every exact descriptor/media-type consumer found with:

~~~bash
rg -n 'vfs-composition-descriptor\.v1|required_by' \
  host scripts images/vfs tools/xtask
~~~

Historical record validators must select the historical schema explicitly;
current candidate verification, promotion, Pages admission/readiness, and the
staged builder require the new schema. Do not accept a document whose declared
schema and OCI media type disagree.

In legacy `writeHomebrewVfsComposition`, serialize dependencies from the
already validated plan:

~~~typescript
const planned = packageByName.get(pkg.full_name);
if (planned === undefined) {
  throw new HomebrewVfsBuildError(
    "Homebrew VFS report package is absent from the plan",
  );
}
return {
  name: pkg.name,
  full_name: pkg.full_name,
  keg: pkg.keg,
  dependencies: planned.dependencies.map((dependency) => {
    if (dependency.full_name === undefined) {
      throw new HomebrewVfsBuildError(
        "Homebrew VFS dependency lacks a normalized full name",
      );
    }
    return dependency.full_name;
  }),
  // Preserve the existing identity, link, source, and environment fields.
};
~~~

In `buildStagedBrowserMainShell`, copy the descriptor's authenticated direct
dependencies into the same package field written at
`/etc/kandelo/homebrew-vfs.json`. Validate the complete graph against the
resolved `homebrew-*` input set before registering or materializing any tree.
Update composition parser tests to reject absent, duplicate, non-full,
cross-tap, cross-architecture, or out-of-plan dependency names and cycles.

- [ ] **Step 4: Implement the bounded shared resolver**

The new module must:

- read at most 4 MiB from `/etc/kandelo/homebrew-vfs.json`;
- require schema 1 and exact package fields used by this interface;
- allow at most 4,096 packages and 128 dependencies per package;
- accept one to 32 roots and at most 16 KiB of root-name UTF-8 data;
- validate each at-most-512-byte full name with `^[a-z0-9._-]+/[a-z0-9._-]+/[a-z0-9][a-z0-9._-]*$`;
- require at-most-4,096-byte normalized absolute keg paths strictly below `/opt/kandelo/homebrew/Cellar`;
- detect missing dependencies and cycles before any fetch;
- de-duplicate roots and return dependency-first ordinal-stable order;
- call `fs.preparePath(package.keg)` and never accept a path or URL from the caller.

Core shape:

~~~typescript
export async function prefetchHomebrewPackageClosures(
  fs: MemoryFileSystem,
  roots: readonly string[],
): Promise<HomebrewPackagePrefetchResult> {
  const composition = readHomebrewPrefetchComposition(fs);
  const normalizedRoots = validateAndDedupePrefetchRoots(roots);
  const packages = dependencyFirstClosure(composition, normalizedRoots);
  const materializedPackages: string[] = [];
  const alreadyMaterializedPackages: string[] = [];

  for (const pkg of packages) {
    const changed = await fs.preparePath(pkg.keg);
    (changed ? materializedPackages : alreadyMaterializedPackages)
      .push(pkg.fullName);
  }
  return {
    roots: normalizedRoots,
    packages: packages.map((pkg) => pkg.fullName),
    materializedPackages,
    alreadyMaterializedPackages,
  };
}
~~~

- [ ] **Step 5: Run the module and composition tests**

Run:

~~~bash
scripts/dev-shell.sh bash -euo pipefail -c '
cd host
npx vitest run \
  test/homebrew-package-prefetch.test.ts \
  test/homebrew-vfs-builder.test.ts \
  test/abi-staging-product-builders.test.ts
'
scripts/dev-shell.sh npx tsx --test \
  scripts/abi-staging-homebrew-composition-descriptor.test.ts
scripts/dev-shell.sh npx tsx --test \
  scripts/abi-staging-pages-readiness.test.ts
scripts/dev-shell.sh bash scripts/test-abi-staging-verify-bottle.sh
~~~

Expected: PASS.

- [ ] **Step 6: Commit the shared package resolver**

~~~bash
git add host/src/homebrew-package-prefetch.ts \
  host/src/homebrew-vfs-builder.ts \
  host/src/homebrew-runtime-layer-consumer.ts \
  host/src/types.ts host/src/index.ts \
  scripts/abi-staging-homebrew-composition-descriptor.ts \
  scripts/abi-staging-homebrew-composition-descriptor.test.ts \
  images/vfs/scripts/staged-product-inputs.ts \
  scripts/abi-staging-pages-readiness.ts \
  scripts/abi-staging-pages-readiness.test.ts \
  scripts/abi-staging-verify-bottle.sh \
  scripts/test-abi-staging-verify-bottle.sh \
  host/test/homebrew-package-prefetch.test.ts \
  host/test/homebrew-vfs-builder.test.ts \
  host/test/abi-staging-product-builders.test.ts
git commit -m "host: resolve lazy Homebrew package closures"
~~~

## Task 2: Expose the same prefetch method on Node and browser workers

**Files:**

- Modify: `host/src/node-kernel-protocol.ts`
- Modify: `host/src/browser-kernel-protocol.ts`
- Modify: `host/src/node-kernel-host.ts`
- Modify: `host/src/browser-kernel-host.ts`
- Modify: `host/src/node-kernel-worker-entry.ts`
- Modify: `host/src/browser-kernel-worker-entry.ts`
- Create: `host/test/node-homebrew-package-prefetch.test.ts`
- Modify: `host/test/browser-kernel.test.ts`
- Create: `host/test/homebrew-package-prefetch-worker-parity.test.ts`

**Interfaces:**

- Consumes: `prefetchHomebrewPackageClosures` from Task 1.
- Produces: identical `prefetchHomebrewPackages(roots)` methods on `NodeKernelHost` and `BrowserKernel`.

- [ ] **Step 1: Write failing host parity tests**

Add a Node host request test using the same narrow private-request seam already used by the host lifecycle tests:

~~~typescript
const PREFETCH_RESULT: HomebrewPackagePrefetchResult = {
  roots: ["kandelo-dev/tap-core/kandelo-sdk"],
  packages: [
    "kandelo-dev/tap-core/libcxx",
    "kandelo-dev/tap-core/clang",
    "kandelo-dev/tap-core/kandelo-sdk",
  ],
  materializedPackages: [
    "kandelo-dev/tap-core/libcxx",
    "kandelo-dev/tap-core/clang",
    "kandelo-dev/tap-core/kandelo-sdk",
  ],
  alreadyMaterializedPackages: [],
};

test("Node host sends one closed package-root request", async () => {
  const host = new NodeKernelHost();
  const requests: MainToKernelMessage[] = [];
  const internals = host as unknown as {
    initialized: boolean;
    request: (
      requestId: number,
      message: MainToKernelMessage,
    ) => Promise<HomebrewPackagePrefetchResult>;
  };
  internals.initialized = true;
  internals.request = vi.fn(async (_requestId, message) => {
    requests.push(message);
    return PREFETCH_RESULT;
  });

  const result = await host.prefetchHomebrewPackages([
    "kandelo-dev/tap-core/kandelo-sdk",
  ]);
  expect(result.packages).toEqual([
    "kandelo-dev/tap-core/libcxx",
    "kandelo-dev/tap-core/clang",
    "kandelo-dev/tap-core/kandelo-sdk",
  ]);
  expect(requests).toEqual([expect.objectContaining({
    type: "prefetch_homebrew_packages",
    packages: ["kandelo-dev/tap-core/kandelo-sdk"],
  })]);
});
~~~

In `browser-kernel.test.ts`, use its existing `MockWorker` rather than inventing another harness. Define the same immutable expected result in that file:

~~~typescript
const BrowserKernel = await loadBrowserKernel();
const expected: HomebrewPackagePrefetchResult = {
  roots: ["kandelo-dev/tap-core/kandelo-sdk"],
  packages: [
    "kandelo-dev/tap-core/libcxx",
    "kandelo-dev/tap-core/clang",
    "kandelo-dev/tap-core/kandelo-sdk",
  ],
  materializedPackages: [
    "kandelo-dev/tap-core/libcxx",
    "kandelo-dev/tap-core/clang",
    "kandelo-dev/tap-core/kandelo-sdk",
  ],
  alreadyMaterializedPackages: [],
};
const kernel = new BrowserKernel({ kernelOwnedFs: true });
const init = kernel.initFromImage({
  kernelWasm: new ArrayBuffer(8),
  vfsImage: new Uint8Array(0),
});
await new Promise((resolve) => setTimeout(resolve, 0));
const worker = MockWorker.instances[0]!;
worker.simulateMessage({ type: "ready" });
await init;

const pending = kernel.prefetchHomebrewPackages([
  "kandelo-dev/tap-core/kandelo-sdk",
]);
const request = worker.lastMessage("prefetch_homebrew_packages");
expect(request.packages).toEqual([
  "kandelo-dev/tap-core/kandelo-sdk",
]);
worker.simulateMessage({
  type: "homebrew_packages_prefetched",
  requestId: request.requestId,
  result: expected,
});
await expect(pending).resolves.toEqual(expected);
~~~

Create `homebrew-package-prefetch-worker-parity.test.ts` as the symmetry tripwire used by other host-parity tests:

~~~typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workers = [
  ["Node", "node-kernel-worker-entry.ts", "rootfsMemfs"],
  ["browser", "browser-kernel-worker-entry.ts", "memfs"],
] as const;

describe.each(workers)("%s package-prefetch worker", (
  _name,
  filename,
  rootName,
) => {
  const source = readFileSync(resolve("src", filename), "utf8");
  it("dispatches through the shared resolver on the worker-owned root", () => {
    expect(source).toContain("prefetchHomebrewPackageClosures");
    expect(source).toContain('case "prefetch_homebrew_packages"');
    expect(source).toMatch(new RegExp(
      `prefetchHomebrewPackageClosures\\(\\s*${rootName}`,
      "u",
    ));
  });
});
~~~

The Task 1 behavioral fixture owns `preparePath` assertions; this source tripwire prevents one host handler from silently disappearing. Across the three protocol test files also cover malformed package arrays, worker rejection, destroy while pending, late/unknown request IDs, and a second call returning every package in `alreadyMaterializedPackages`.

- [ ] **Step 2: Run parity tests and confirm the methods are absent**

Run:

~~~bash
scripts/dev-shell.sh bash -euo pipefail -c '
cd host
npx vitest run \
  test/node-homebrew-package-prefetch.test.ts \
  test/browser-kernel.test.ts \
  test/homebrew-package-prefetch-worker-parity.test.ts
'
~~~

Expected: FAIL because neither host exposes `prefetchHomebrewPackages`.

- [ ] **Step 3: Add closed protocol messages**

Add matching request and response shapes:

~~~typescript
type PrefetchHomebrewPackagesRequest = {
  type: "prefetch_homebrew_packages";
  requestId: number;
  packages: string[];
};

type PrefetchHomebrewPackagesResponse = {
  type: "homebrew_packages_prefetched";
  requestId: number;
  result: HomebrewPackagePrefetchResult;
};

type PrefetchHomebrewPackagesFailure = {
  type: "homebrew_packages_prefetch_failed";
  requestId: number;
  error: string;
};
~~~

Both protocol validators must enforce the resolver's same cap of 32 roots, 512 UTF-8 bytes per full name, and 16 KiB of aggregate package-name data. A failure response carries a bounded diagnostic only; it cannot carry URLs, credentials, filesystem bytes, or arbitrary objects.

- [ ] **Step 4: Implement host request tracking**

Add the same method to both host classes:

~~~typescript
async prefetchHomebrewPackages(
  roots: readonly string[],
): Promise<HomebrewPackagePrefetchResult> {
  const packages = validatePrefetchRootSnapshot(roots);
  const requestId = this.nextRequestId++;
  const pending = this.createPendingPrefetch(requestId);
  this.kernelWorkerHandle.postMessage({
    type: "prefetch_homebrew_packages",
    requestId,
    packages,
  });
  return pending;
}
~~~

Reject every pending promise when the worker fails or the host is destroyed. Do not reuse spawn request maps or allow a late response to resolve a new request.

- [ ] **Step 5: Implement both worker handlers with the shared helper**

Node uses its worker-owned root MemoryFileSystem; browser uses `memfs` after initialization:

~~~typescript
async function handleHomebrewPackagePrefetch(
  message: PrefetchHomebrewPackagesRequest,
): Promise<void> {
  try {
    const result = await prefetchHomebrewPackageClosures(
      rootMemoryFileSystem(),
      message.packages,
    );
    post({
      type: "homebrew_packages_prefetched",
      requestId: message.requestId,
      result,
    });
  } catch (error) {
    post({
      type: "homebrew_packages_prefetch_failed",
      requestId: message.requestId,
      error: boundedWorkerError(error),
    });
  }
}
~~~

The browser and Node entrypoints differ only in how `rootMemoryFileSystem()` returns the existing worker-owned root. Do not instantiate `CentralizedKernelWorker` on either main thread.

- [ ] **Step 6: Run host parity and full Vitest suites**

Run:

~~~bash
scripts/dev-shell.sh bash -euo pipefail -c '
cd host
npx vitest run \
  test/node-homebrew-package-prefetch.test.ts \
  test/browser-kernel.test.ts \
  test/homebrew-package-prefetch-worker-parity.test.ts
npx vitest run
'
~~~

Expected: every test file passes; PHP tests may skip only when their binary prerequisite is absent.

- [ ] **Step 7: Commit both host implementations together**

~~~bash
git add host/src/node-kernel-protocol.ts \
  host/src/browser-kernel-protocol.ts \
  host/src/node-kernel-host.ts host/src/browser-kernel-host.ts \
  host/src/node-kernel-worker-entry.ts \
  host/src/browser-kernel-worker-entry.ts \
  host/test/node-homebrew-package-prefetch.test.ts \
  host/test/browser-kernel.test.ts \
  host/test/homebrew-package-prefetch-worker-parity.test.ts
git commit -m "host: prefetch Homebrew packages on both runtimes"
~~~

## Task 3: Select the candidate SDK closure in the canonical shell source

**Files:**

- Modify: `images/vfs/products/browser-main-shell.toml`
- Regenerate: `images/vfs/products/generated/catalog.json`
- Modify: `homebrew/main-shell.Brewfile`
- Modify: `homebrew/main-shell-compatibility.json`
- Modify: `scripts/vfs-product-catalog.test.mjs`
- Modify: `abi/staging/legacy-retirement.toml`

**Interfaces:**

- Consumes: candidate Formula root `kandelo-dev/tap-core/kandelo-sdk` for the
  staging evidence phase.
- Produces: one pre-admission `browser-main-shell` source identity that selects
  the SDK exactly once as a lazy root, leaves dependency expansion to the tap,
  and contains no candidate locator or bottle byte.

- [ ] **Step 1: Write a failing source-selection contract test**

Extend `scripts/vfs-product-catalog.test.mjs` without reading any selection or
artifact lock:

~~~javascript
test("main shell selects only the lazy SDK root for the toolchain", () => {
  const catalog = loadVfsProductCatalog(catalogPath);
  const selected = catalog.homebrewRoots("browser-main-shell")
    .filter(({ formula }) =>
      ["libcxx", "clang", "kandelo-sdk"].includes(formula));

  assert.deepEqual(selected, [{
    tap: "kandelo-dev/homebrew-tap-core",
    formula: "kandelo-sdk",
    materialization: "lazy",
  }]);
  assert.doesNotMatch(
    JSON.stringify(catalog.productById("browser-main-shell").software.homebrew),
    /https?:|sha256:/,
  );
});
~~~

Also parse `homebrew/main-shell-compatibility.json` and require exactly one
Clang `/usr/lib/llvm` alias and one SDK `/usr/wasm32posix` alias. Add mutations
that make `clang` a direct root, duplicate the SDK root, add a candidate URL,
or point either alias at another package; each mutation must fail.

- [ ] **Step 2: Run the tests and confirm the root is absent**

Run:

~~~bash
scripts/dev-shell.sh node --test scripts/vfs-product-catalog.test.mjs
~~~

Expected: FAIL because the product and Brewfile do not select `kandelo-sdk`.

- [ ] **Step 3: Add the one lazy root to the product and transitional Brewfile**

Append `"kandelo-sdk"` to the `formulae` array in the existing lazy `[[software.homebrew]]` block whose tap is `kandelo-dev/homebrew-tap-core` in `browser-main-shell.toml`. Do not add another Homebrew block. Add only:

~~~ruby
brew "kandelo-dev/tap-core/kandelo-sdk"
~~~

to `homebrew/main-shell.Brewfile`. Do not list `clang` or `libcxx` as new roots; the tap dependency graph owns them.

- [ ] **Step 4: Add Formula-owned public path projections**

Add these compatibility aliases:

~~~json
{
  "package": "kandelo-dev/tap-core/clang",
  "source_kind": "keg",
  "source": "libexec/llvm",
  "targets": ["/usr/lib/llvm"]
}
~~~

~~~json
{
  "package": "kandelo-dev/tap-core/kandelo-sdk",
  "source_kind": "keg",
  "source": "libexec/wasm32posix",
  "targets": ["/usr/wasm32posix"]
}
~~~

The existing link-manifest bin mirroring exposes `cc`, `c++`, and
`wasm32posix-*` under `/usr/bin` and `/bin`. The source contract verifies the
aliases' exact package ownership and targets here. Task 5's image contract
verifies that they point into the admitted opt kegs and trigger the owning
deferred tree rather than an eager copy.

- [ ] **Step 5: Regenerate and commit the pre-admission product authority**

Regenerate the canonical product catalog from the changed manifest before
requesting candidate evidence:

~~~bash
scripts/dev-shell.sh bash -euo pipefail -c '
host_target=$(rustc -vV | awk "/^host/ {print \$2}")
cargo run -p xtask --target "$host_target" --quiet -- \
  abi-staging products generate \
  --source images/vfs/products \
  --out images/vfs/products/generated/catalog.json
cargo run -p xtask --target "$host_target" --quiet -- \
  abi-staging products check \
  --source images/vfs/products \
  --generated images/vfs/products/generated/catalog.json
'
~~~

Run the source-level shell-selection assertions that do not consume canonical
admissions:

~~~bash
scripts/dev-shell.sh node --test scripts/vfs-product-catalog.test.mjs
~~~

They must prove there is one lazy SDK root, dependency closure remains
Formula-owned, and no candidate URL or bottle byte is checked in. Then commit
the exact source identity used by staging:

~~~bash
git add images/vfs/products/browser-main-shell.toml \
  images/vfs/products/generated/catalog.json \
  homebrew/main-shell.Brewfile homebrew/main-shell-compatibility.json \
  scripts/vfs-product-catalog.test.mjs
git commit -m "vfs: stage lazy Kandelo SDK in the main shell"
~~~

Do not modify the three canonical main-shell lock files in this step. Candidate
resolution belongs to ABI staging, and candidate URLs must never enter a
production selection or artifact lock.

- [ ] **Step 6: Inventory the legacy developer SDK authority**

Add retirement entries for the first three paths and update the existing fourth entry in place; do not duplicate it:

~~~text
images/vfs/products/developer-kandelo-sdk.toml
images/vfs/scripts/build-kandelo-sdk-vfs-image.sh
images/vfs/scripts/build-kandelo-sdk-vfs-image.ts
packages/registry/kandelo-sdk
~~~

Each entry uses:

~~~toml
current_consumers = [
  "developer-sdk-vfs-build",
  "package-generation",
  "supplementary-sdk-evidence",
]
replacement_component = "Admitted kandelo-sdk Formula selected by browser-main-shell"
required_evidence_ids = [
  "failure-recovery-proof",
  "generic-transition-acceptance",
  "pages-atomic-readiness",
  "prior-abi-history-protection",
  "product-authority-consumer-audit",
  "promotion-readback",
  "source-custody-retention",
]
removal_conditions = [
  "complete-generic-transition",
  "complete-retained-source-custody",
  "consumer-audit-complete",
  "failure-recovery-evidence",
  "independent-canonical-promotion",
  "protected-prior-abi-repair",
  "required-product-pages-evidence",
]
removable = false
~~~

Do not delete the old product or builders in this task.

Commit the bounded inventory before producing the exact staging request:

~~~bash
git add abi/staging/legacy-retirement.toml
git commit -m "staging: inventory the legacy developer SDK"
~~~

Canonical recomposition deliberately belongs to the Pages plan after Task 4
and protected browser evidence have supplied the product evidence required for
admission. This pre-admission shell plan does not write transitional selection
or artifact locks for the compiler closure.

## Task 4: Add protected real in-guest Node compilation evidence

**Files:**

- Modify: `abi/staging/evidence-definitions.toml`
- Regenerate: `abi/staging/evidence-definitions.generated.json`
- Modify: `tests/vfs-products.toml`
- Modify: `scripts/abi-staging-product-node-evidence.ts`
- Modify: `scripts/abi-staging-product-node-evidence.test.ts`

**Interfaces:**

- Consumes: exact candidate `browser-main-shell` and lazy inputs
  `homebrew-libcxx`, `homebrew-clang`, and `homebrew-kandelo-sdk` from the same
  protected request.
- Produces: repository suite `main-shell-toolchain-node` with protected source, compiler commands, expected output, and lazy-input ledger.

- [ ] **Step 1: Write failing protected-suite tests**

~~~typescript
test("registers a protected in-guest C and C++ suite", () => {
  const suite = protectedNodeSuiteDefinition("main-shell-toolchain-node");
  expect(suite.steps.map((step) => step.id)).toEqual([
    "compile-and-run-c",
    "compile-and-run-cxx",
  ]);
  expect(suite.steps[0].argv[0]).toBe("/bin/bash");
  expect(suite.steps[0].stdout).toEqual({
    kind: "exact",
    value: "kandelo-c-ok\n",
  });
  expect(suite.steps[1].stdout).toEqual({
    kind: "exact",
    value: "kandelo-cxx-ok\n",
  });
});
~~~

Add a definition-registry test that `main-shell-toolchain-node` names exactly the three expected lazy inputs and cannot use runner `compile`.

- [ ] **Step 2: Run the focused test and confirm the suite is unregistered**

Run:

~~~bash
scripts/dev-shell.sh npx tsx --test \
  scripts/abi-staging-product-node-evidence.test.ts
~~~

Expected: FAIL because `main-shell-toolchain-node` is not a valid `NodeRepositorySuite`.

- [ ] **Step 3: Add protected in-guest compile commands**

Extend `NodeRepositorySuite` and `PROTECTED_NODE_SUITES`:

~~~typescript
"main-shell-toolchain-node": {
  steps: [
    {
      id: "compile-and-run-c",
      argv: [
        "/bin/bash",
        "-lc",
        "set -eu; work=/tmp/kandelo-c-evidence; " +
          "rm -rf \"$work\"; mkdir -p \"$work\"; " +
          "printf '#include <stdio.h>\\nint main(void){" +
          "puts(\"kandelo-c-ok\");return 0;}\\n' > \"$work/main.c\"; " +
          "cc \"$work/main.c\" -o \"$work/main.wasm\"; " +
          "\"$work/main.wasm\"",
      ],
      env: { HOME: "/tmp", MAKEFLAGS: "-j1" },
      stdout: { kind: "exact", value: "kandelo-c-ok\n" },
    },
    {
      id: "compile-and-run-cxx",
      argv: [
        "/bin/bash",
        "-lc",
        "set -eu; work=/tmp/kandelo-cxx-evidence; " +
          "rm -rf \"$work\"; mkdir -p \"$work\"; " +
          "printf '#include <iostream>\\nint main(){" +
          "std::cout<<\"kandelo-cxx-ok\\\\n\";}\\n' > \"$work/main.cpp\"; " +
          "c++ \"$work/main.cpp\" -o \"$work/main.wasm\"; " +
          "\"$work/main.wasm\"",
      ],
      env: { HOME: "/tmp", MAKEFLAGS: "-j1" },
      stdout: { kind: "exact", value: "kandelo-cxx-ok\n" },
    },
  ],
},
~~~

This runner spawns `cc` and `c++` from the candidate VFS. Do not call `compileSdkFixtureFromCandidateVfs`, Nix Clang, or any host compiler.

- [ ] **Step 4: Register the evidence definition and product test**

Add:

~~~toml
[[definitions]]
id = "main-shell-toolchain-node"
host = "node"
runner = "repository-suite"
timeout_seconds = 900

[definitions.probe]
suite = "main-shell-toolchain-node"
lazy_inputs = [
  "homebrew-libcxx",
  "homebrew-clang",
  "homebrew-kandelo-sdk",
]
~~~

Update `browser-main-shell` registration:

~~~toml
node = ["main-shell-startup", "main-shell-toolchain-node"]
~~~

Keep `main-shell-startup` separate because its empty toolchain lazy ledger proves ordinary boot performs no toolchain fetch.

- [ ] **Step 5: Regenerate registries and run evidence tests**

~~~bash
scripts/dev-shell.sh bash -euo pipefail -c '
  host_target="$(rustc -vV | awk "/^host/ {print \$2}")"
  cargo run -p xtask --target "$host_target" --quiet -- \
    abi-staging evidence-definitions generate \
    --source abi/staging/evidence-definitions.toml \
    --out abi/staging/evidence-definitions.generated.json
  cargo run -p xtask --target "$host_target" --quiet -- \
    abi-staging registries generate \
    --pages apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml \
    --pages-out apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json \
    --tests tests/vfs-products.toml \
    --tests-out tests/vfs-products.generated.json
  cargo run -p xtask --target "$host_target" --quiet -- \
    abi-staging evidence-definitions check \
    --source abi/staging/evidence-definitions.toml \
    --generated abi/staging/evidence-definitions.generated.json
  cargo run -p xtask --target "$host_target" --quiet -- \
    abi-staging registries check \
    --catalog images/vfs/products/generated/catalog.json \
    --pages apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml \
    --pages-generated apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json \
    --tests tests/vfs-products.toml \
    --tests-generated tests/vfs-products.generated.json
'
scripts/dev-shell.sh npx tsx --test \
  scripts/abi-staging-product-node-evidence.test.ts
scripts/dev-shell.sh bash scripts/test-abi-staging-product-evidence.sh
~~~

Expected: the registry check and protected runner tests pass.

- [ ] **Step 6: Commit the protected Node evidence source**

~~~bash
git add abi/staging/evidence-definitions.toml \
  abi/staging/evidence-definitions.generated.json \
  tests/vfs-products.toml tests/vfs-products.generated.json \
  scripts/abi-staging-product-node-evidence.ts \
  scripts/abi-staging-product-node-evidence.test.ts
git commit -m "staging: prove in-guest C and C++ on Node"
~~~

This commit, the Task 3 product-authority commit, and the Pages plan's browser
evidence commit must all be ancestors of the exact Kandelo request head.

- [ ] **Step 7: Run the Node evidence against the exact candidate shell**

After protected reconciliation creates the candidate product, bind every input
to its generated coordination handoff and invoke the protected runner directly:

~~~bash
evidence_context="${PRODUCT_EVIDENCE_CONTEXT:?set from coordination handoff}"
candidate_locator="${PRODUCT_CANDIDATE_LOCATOR:?set from coordination handoff}"
builder_report="${PRODUCT_BUILDER_REPORT:?set from coordination handoff}"
resolved_inputs="${PRODUCT_RESOLVED_INPUTS:?set from coordination handoff}"
runtime_bundle="${PRODUCT_RUNTIME_BUNDLE:?set from coordination handoff}"
runtime_root="${PRODUCT_RUNTIME_ROOT:?set from coordination handoff}"
candidate_vfs="${PRODUCT_CANDIDATE_VFS:?set from coordination handoff}"
evidence_tmp="$(mktemp -d)"

scripts/dev-shell.sh npx tsx \
  scripts/abi-staging-product-node-evidence.ts \
  --builder-report "$builder_report" \
  --context "$evidence_context" \
  --candidate-locator "$candidate_locator" \
  --definitions abi/staging/evidence-definitions.generated.json \
  --products images/vfs/products/generated/catalog.json \
  --resolved-inputs "$resolved_inputs" \
  --runtime-bundle "$runtime_bundle" \
  --runtime-root "$runtime_root" \
  --source-root "$PWD" \
  --vfs "$candidate_vfs" \
  --output "$evidence_tmp/main-shell-toolchain-node.json"
~~~

Inspect the bounded result, then remove only `$evidence_tmp`. Require:

- `main-shell-startup` reads no toolchain lazy input;
- `main-shell-toolchain-node` reads exactly the three registered identities;
- C and C++ outputs exit 0 with exact protected stdout;
- the second compiler invocation does not refetch an already materialized bottle;
- evidence diagnostics contain no host compiler identity.

After inspection, in the same shell that defined `evidence_tmp`, run:

~~~bash
rm -rf -- "$evidence_tmp"
~~~

## Task 5: Document the shell contract and run the pre-admission branch gate

**Files:**

- Modify: `docs/homebrew-publishing.md`
- Modify: `docs/sdk-guide.md`
- Modify: `docs/package-management.md`
- Modify: `docs/binary-releases.md`
- Modify: `docs/architecture.md` only to document the shared worker-owned prefetch message; do not describe a new kernel architecture.

**Interfaces:**

- Consumes: completed Tasks 1–4 and the exact successful candidate Node
  evidence from Task 4.
- Produces: documented commands, paths, lazy behavior, ownership, descriptor
  transport, and Node evidence; a verified pre-admission branch ready for the
  browser-evidence and canonical Pages phases.

- [ ] **Step 1: Document the canonical dependency and transport boundary**

In `docs/homebrew-publishing.md`, `docs/package-management.md`, and
`docs/binary-releases.md`, document that the current VFS composition descriptor
carries authenticated direct same-tap dependency identities. Product callers
name only `kandelo-sdk`; the guest composition derives `clang` and `libcxx`.

Document the two staging phases without introducing another selector:

1. candidate product evidence uses candidate GHCR layers from the exact
   request;
2. generic Pages readiness authenticates each Formula admission and canonical
   composition descriptor, substitutes the canonical GHCR references, and
   recomposes the product.

State explicitly that neither the legacy closed-selection release nor the
legacy main-shell bottle mirror may carry this compiler closure. They remain
historical/retirement paths and are not inputs to candidate evidence,
canonical recomposition, or Pages publication.

- [ ] **Step 2: Document the exact shell contract**

Document these exact user commands:

~~~bash
cat > hello.c <<'EOF'
#include <stdio.h>
int main(void) {
  puts("hello from Kandelo");
  return 0;
}
EOF
cc hello.c -o hello.wasm
./hello.wasm
~~~

Also document `c++`, `/usr/lib/llvm`, `/usr/wasm32posix`, first-use network
behavior, no cross-session cache in this release, and the
fork-instrumentation limitation.

- [ ] **Step 3: Run focused documentation and product checks**

~~~bash
scripts/dev-shell.sh node --test \
  docs-site/.vitepress/homebrew-doc-links.test.mjs
scripts/dev-shell.sh bash scripts/test-abi-staging-product-authority.sh
scripts/dev-shell.sh bash scripts/test-abi-staging-product-evidence.sh
scripts/dev-shell.sh npx tsx --test \
  scripts/abi-staging-homebrew-composition-descriptor.test.ts
~~~

Expected: all commands exit 0, and descriptor fixtures prove that current
records carry direct dependencies while historical schema-1 records remain
validation-only.

- [ ] **Step 4: Run every AGENTS.md verification suite**

~~~bash
scripts/dev-shell.sh cargo test \
  -p wasm-posix-kernel --target aarch64-apple-darwin --lib
scripts/dev-shell.sh bash -euo pipefail -c 'cd host && npx vitest run'
scripts/dev-shell.sh bash scripts/run-libc-tests.sh
scripts/dev-shell.sh bash scripts/run-posix-tests.sh
scripts/dev-shell.sh bash scripts/check-abi-version.sh
~~~

Expected:

- at least 539 Cargo kernel tests pass with 0 failures;
- all Vitest files pass, except allowed missing-binary skips;
- libc-test reports 0 unexpected `FAIL` results;
- POSIX reports 0 `FAIL` results; and
- the ABI snapshot check exits 0.

- [ ] **Step 5: Review the exact candidate Node evidence**

Inspect the Task 4 result and require:

- `main-shell-startup` read no toolchain input;
- `main-shell-toolchain-node` used the exact request-bound candidate VFS and
  definition digest;
- its lazy-input set is exactly `homebrew-libcxx`, `homebrew-clang`, and
  `homebrew-kandelo-sdk`;
- protected C and C++ compile, link, and execution observations succeeded;
- repeated compilation did not refetch a materialized tree; and
- diagnostics contain no host compiler identity or credential.

- [ ] **Step 6: Prove the compiler closure has no legacy publication path**

~~~bash
if rg -n 'closed-selection|bottle-mirror|releases/download|compiler\.vfs' \
  images/vfs/products/browser-main-shell.toml \
  host/src/homebrew-package-prefetch.ts; then
  exit 1
fi
git diff --check
~~~

Expected: no match and no whitespace errors. The product manifest contains
only the lazy Formula root; candidate and canonical transport identities come
from staging records, not source literals.

- [ ] **Step 7: Record the browser/Pages handoff**

Save these exact values in the implementation PR notes:

~~~text
Kandelo source commit and tree
target ABI and snapshot SHA-256
browser-main-shell product manifest SHA-256
main-shell-startup definition SHA-256 and successful receipt
main-shell-toolchain-node definition SHA-256 and successful receipt
candidate browser-main-shell immutable locator and VFS SHA-256/bytes
candidate resolved-inputs and builder-report SHA-256 values
~~~

The Pages plan uses staging discovery for the actual files; browser source must
not embed these values.

- [ ] **Step 8: Review the documentation diff**

~~~bash
git diff -- docs/homebrew-publishing.md docs/sdk-guide.md \
  docs/package-management.md docs/binary-releases.md docs/architecture.md
git status --short
~~~

Confirm that the diff describes the candidate/canonical staging boundary, not
the legacy shell publisher. Stage only those five documentation files.

- [ ] **Step 9: Commit documentation**

~~~bash
git add docs/sdk-guide.md docs/package-management.md docs/binary-releases.md \
  docs/homebrew-publishing.md docs/architecture.md
git commit -m "docs: explain the lazy in-guest toolchain"
~~~

## Plan Verification

Before handing this branch to the browser/Pages plan, require all of the following:

1. The exact candidate shell boots with zero toolchain payload reads.
2. `cc` and `c++` resolve only the request-bound candidate Homebrew trees.
3. Candidate Node evidence compiles, links, and executes protected C and C++ programs in-guest.
4. Both worker protocols expose the same package-root prefetch method and tests.
5. The developer SDK product is inventoried for retirement and is not used as feature evidence.
6. Every AGENTS.md suite above has current passing output.

Canonical admissions, canonical Node/browser evidence, and manual browser
verification are completion gates in the Pages plan; do not claim the public
feature complete at this handoff.
