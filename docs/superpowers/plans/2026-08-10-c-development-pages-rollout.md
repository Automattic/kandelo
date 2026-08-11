# C Development Preset, Browser Evidence, and Pages Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a discoverable C-development preset over the canonical `browser-main-shell`, prove lazy C/C++ compilation in a real browser, and activate the admitted seven-product Pages site without publishing compiler payloads on Pages.

**Architecture:** The preset changes only session presentation: it uses the same shell VFS, prepares a small workspace, and starts the shared Homebrew package-closure prefetch after the terminal becomes usable. `LiveKernelHost` owns a generic package-prefetch lifecycle so any preset can expose progress and retry without knowing package paths or URLs. Protected browser evidence exercises both ordinary first-use compilation and preset prefetch; Pages readiness continues to admit one `browser-main-shell` product and publishes the resulting complete site atomically.

**Tech Stack:** TypeScript, React, BrowserKernel workers, Homebrew deferred VFS trees, Playwright, ABI-staging evidence registries, GitHub Actions, GitHub Pages, GHCR.

## Global Constraints

- Begin Tasks 1–3 after Formula-plan Tasks 1–4 and shell-plan Tasks 1–4 have produced the exact candidate Formula/product authority. The browser evidence in Task 3 is required before those Formulae may gain browser-capable admissions.
- Execute Tasks 4–6 only after the Formula plan has published anonymous
  admissions for `kandelo-sdk`, `clang`, and the selected `libcxx`. Consume
  those admissions through generic Pages readiness, not transitional shell
  selection/artifact locks.
- Use a new clean Kandelo worktree based on a stable staging revision containing `4f7b75b69` and the completed final admitted-product Pages site flow; never edit the active dirty `emdash/homebrew-pr-staging-1q1w6` worktree.
- `browser-main-shell` remains the only shell product. Do not add `browser-c-development` or an eighth Pages VFS product.
- The Pages registry remains exactly seven products: eager `platform-rootfs` and `browser-main-shell`, then lazy `browser-node`, `browser-nginx`, `browser-nginx-php`, `browser-wordpress`, and `browser-lamp`.
- The ordinary shell must make zero `kandelo-sdk`, `clang`, or newly selected `libcxx` payload requests before first use.
- The C-development preset must request only the full Formula root `kandelo-dev/tap-core/kandelo-sdk`. Dependency order, keg roots, immutable URLs, byte counts, and digests come from the sealed composition.
- The terminal becomes usable before preset prefetch begins and remains usable after a failed prefetch.
- The browser UI may display generic package/download state, but it must not import compiler Wasm, name compiler URLs, enumerate the compiler dependency closure, merge an SDK VFS, or define compiler/linker flags.
- SDK wrappers remain the authority for sysroot, Clang resource, libc++, linker, and syscall-glue flags.
- Initial public language scope is C and C++ on wasm32. The guide must state that fork-family behavior in generated programs is unsupported until an in-guest `wasm-fork-instrument` exists.
- Missing, truncated, or digest-mismatched lazy bytes must leave the owning tree unmaterialized. Retry uses the same immutable descriptor; there is no fallback toolchain.
- Protected browser evidence must compile, link, and execute both C and C++ inside the candidate Kandelo guest. A host compiler cannot satisfy the evidence.
- The exact Kandelo request head used by reconciliation must contain the preset, protected browser suites, lazy shell selection, and Node suite. A locally modified or later source tree cannot stand for that evidence identity.
- Pages carries the browser application and compact product VFS files. GHCR remains the only transport for compiler and SDK bottle payloads.
- Public cutover is two-step: merge and observe a ready complete site first; change `pages-activation.toml` to `active` only after the successor canary for the exact main commit is ready and reviewed.
- If readiness is held at any point, retain the previously selected complete site.
- Do not patch the legacy asset-selection logic as a fallback.
- Run commands needing repository build dependencies through `scripts/dev-shell.sh`.
- Do not change `ABI_VERSION` unless `scripts/check-abi-version.sh` reports an incompatible ABI change and the ABI policy requires it.

---

## Two-Phase Staging Boundary

1. Commit Tasks 1–3 so the exact Kandelo request head contains both browser
   compiler suites and the candidate-shell surface adapter.
2. Dispatch reconciliation. The protected workflow composes
   `browser-main-shell` from the exact candidate Formula layers and publishes
   Node/browser product evidence before Formula promotion.
3. Complete Formula-plan Task 5. Promotion projects the successful ordinary
   shell Node/browser evidence into the three Formula admissions without
   changing bottle bytes.
4. Return here for failure/retry acceptance against canonical transports,
   Pages readiness, observation, and activation. No candidate reference may
   survive this boundary.

---

## Dependency Gate

Before Task 1, record the integration bases and prove the pre-admission portions
of the two earlier plans are present:

~~~bash
git status --short
git merge-base --is-ancestor 4f7b75b69 HEAD
rg -n 'kandelo-dev/tap-core/kandelo-sdk' images/vfs/products/browser-main-shell.toml
rg -n 'prefetchHomebrewPackages' \
  host/src/node-kernel-host.ts host/src/browser-kernel-host.ts
rg -n 'main-shell-toolchain-node' \
  abi/staging/evidence-definitions.toml tests/vfs-products.toml
~~~

Expected: the worktree has no implementation changes, the base includes the
staging prerequisite, the candidate shell selects `kandelo-sdk` lazily, both
hosts expose the same prefetch API, and protected Node toolchain evidence is
registered.

For Tasks 1–3, do not continue unless protected coordination can resolve the
exact candidate `kandelo-sdk` closure selected by this request. For Tasks 4–6,
do not continue unless the same layer identities are available through
anonymous canonical admissions and the checked-in shell locks. A local
prototype compiler is never a substitute.

## File and Interface Map

### Generic session prefetch state

- Modify `web-libs/kandelo-session/src/kernel-host.ts`: add the structural package-prefetch result, state ledger, start/retry methods, and subscriptions to `KernelHost` and `LiveKernelHost`.
- Modify `apps/browser-demos/pages/kandelo/kernel-host/react.tsx`: expose `useHomebrewPackagePrefetches()`.
- Modify `apps/browser-demos/pages/kandelo/app/App.tsx`: render generic running/ready/error package-prefetch state and a retry action; keep individual byte progress in the existing lazy-download toasts.
- Modify `apps/browser-demos/pages/kandelo/styles.css`: style the generic retry action.
- Modify `web-libs/kandelo-session/test/kandelo-session.test.ts` and `apps/browser-demos/test/lazy-download-summary.spec.ts`: state, coalescing, retry, and UI lifecycle tests.

### C-development session

- Create `apps/browser-demos/pages/kandelo/c-development.ts`: one reviewed preset-session constant containing workspace text, cwd, convenience environment, and the single Formula root.
- Create `apps/browser-demos/pages/kandelo/kernel-host/preset-session.ts`: bounded generic workspace preparation and background package-prefetch startup.
- Modify `web-libs/kandelo-session/src/kernel-host.ts`: allow gallery items to carry `cwd` and `env` presentation fields.
- Modify `apps/browser-demos/pages/kandelo/presets.ts`: add the `c-dev` gallery entry.
- Modify `apps/browser-demos/pages/kandelo/gallery-descriptor.ts`: merge gallery-owned cwd and environment into the boot descriptor.
- Modify `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`: map `c-dev` to the shell image, prepare its workspace, set status to running, then start prefetch without awaiting it.
- Modify `web-libs/kandelo-session/src/demo-guides.ts`: add the C-development guide and fork-instrumentation limitation.
- Modify `apps/browser-demos/pages/kandelo/kernel-host/candidate-evidence-vfs.ts`: map protected `toolchain-shell` and `c-development` profiles to the ordinary shell and `c-dev` live profiles.
- Create `apps/browser-demos/pages/kandelo/c-development.test.ts`: preset, descriptor, workspace, and ordering tests.

### Browser acceptance and protected evidence

- Create `apps/browser-demos/test/kandelo-c-development.spec.ts`: ordinary-shell deferral, preset prefetch, terminal availability, reuse, corruption, and retry acceptance.
- Modify `apps/browser-demos/test/support/homebrew-lazy-transport.ts`: resolve exact lazy request URLs for same-origin and proxied immutable assets.
- Modify `apps/browser-demos/test/abi-staging-product-evidence.spec.ts`: protected `toolchain-shell` and `c-development` live-page operations.
- Modify `scripts/abi-staging-product-browser-evidence.ts` and `scripts/abi-staging-product-browser-evidence.test.ts`: add the two protected surfaces and exact suite mapping.
- Modify `abi/staging/evidence-definitions.toml` and regenerate `abi/staging/evidence-definitions.generated.json`.
- Modify `tests/vfs-products.toml` and regenerate `tests/vfs-products.generated.json`.

### Pages readiness, activation, and docs

- Modify `scripts/abi-staging-pages-readiness.test.ts`: toolchain admission/evidence blockers and exact seven-product site inventory.
- Modify `scripts/abi-staging-pages-producer.test.ts`: held versus ready production with the shell's three new lazy inputs.
- Modify `abi/staging/pages-activation.toml` twice in separate reviewed commits: `legacy` to `observe`, then `observe` to `active` after the exact canary gate.
- Modify `docs/browser-support.md` and `README.md`: default first-use behavior, C-development preset, progress/retry, memory/network expectations, and current limitations.

## Stable Interfaces

Task 1 adds this UI-facing structural contract. It is intentionally separate from package paths and transport descriptors:

~~~typescript
export interface HomebrewPackagePrefetchResult {
  roots: string[];
  packages: string[];
  materializedPackages: string[];
  alreadyMaterializedPackages: string[];
}

export interface HomebrewPackagePrefetchState {
  id: string;
  label: string;
  roots: string[];
  status: "running" | "ready" | "error";
  attempt: number;
  error?: string;
  result?: HomebrewPackagePrefetchResult;
}

// Structural member added to KernelLike; BrowserKernel supplies it.
prefetchHomebrewPackages?(
  roots: readonly string[],
): Promise<HomebrewPackagePrefetchResult>;

// UI-facing methods added to KernelHost and LiveKernelHost.
prefetchHomebrewPackages(
  id: string,
  label: string,
  roots: readonly string[],
): Promise<HomebrewPackagePrefetchResult>;

retryHomebrewPackagePrefetch(
  id: string,
): Promise<HomebrewPackagePrefetchResult>;
~~~

The lower-level `KernelLike.prefetchHomebrewPackages(roots)` method is the Node/browser worker API from the shell/Node plan. `LiveKernelHost` supplies only lifecycle state, request coalescing, and retry.

The reviewed preset constant has this exact shape:

~~~typescript
export interface PresetWorkspaceFile {
  path: string;
  contents: string;
  mode: number;
}

export interface PresetSession {
  cwd: string;
  env: Readonly<Record<string, string>>;
  workspaceFiles: readonly PresetWorkspaceFile[];
  packagePrefetch?: {
    id: string;
    label: string;
    roots: readonly string[];
  };
}

export const C_DEVELOPMENT_SESSION: PresetSession = {
  cwd: "/home/user/c",
  env: {
    CC: "cc",
    CXX: "c++",
    MAKEFLAGS: "-j1",
    PWD: "/home/user/c",
  },
  workspaceFiles: [{
    path: "/home/user/c/hello.c",
    contents: [
      "#include <stdio.h>",
      "",
      "int main(void) {",
      "  puts(\"Hello from Kandelo C!\");",
      "  return 0;",
      "}",
      "",
    ].join("\n"),
    mode: 0o644,
  }],
  packagePrefetch: {
    id: "c-development-toolchain",
    label: "C/C++ toolchain",
    roots: ["kandelo-dev/tap-core/kandelo-sdk"],
  },
};
~~~

## Task 1: Add generic package-prefetch lifecycle and retry UI

**Files:**

- Modify: `web-libs/kandelo-session/src/kernel-host.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/react.tsx`
- Modify: `apps/browser-demos/pages/kandelo/app/App.tsx`
- Modify: `apps/browser-demos/pages/kandelo/styles.css`
- Modify: `web-libs/kandelo-session/test/kandelo-session.test.ts`
- Modify: `apps/browser-demos/test/lazy-download-summary.spec.ts`

**Interfaces:**

- Consumes: `KernelLike.prefetchHomebrewPackages(roots: readonly string[]): Promise<HomebrewPackagePrefetchResult>` from the shell/Node plan.
- Produces: the four `KernelHost` methods in Stable Interfaces, `homebrewPackagePrefetches()`, `subscribeHomebrewPackagePrefetches(cb)`, and `useHomebrewPackagePrefetches()`.

- [ ] **Step 1: Write failing lifecycle tests**

Add a minimal structural kernel helper and these cases to `kandelo-session.test.ts`:

~~~typescript
function kernelWithPackagePrefetch(
  prefetch: (roots: readonly string[]) => Promise<HomebrewPackagePrefetchResult>,
): KernelLike {
  const unavailable = () => {
    throw new Error("not used by package-prefetch test");
  };
  return {
    fs: {} as FileSystemLike,
    spawn: unavailable,
    onPtyOutput: unavailable,
    ptyWrite: unavailable,
    ptyResize: unavailable,
    terminateProcess: async () => {},
    prefetchHomebrewPackages: prefetch,
  };
}

test("records one coalesced package-prefetch attempt and retries the same roots", async () => {
  const result = {
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
  const prefetch = vi.fn()
    .mockRejectedValueOnce(new Error("clang tree digest mismatch"))
    .mockResolvedValueOnce(result);
  const host = new LiveKernelHost({
    kernel: kernelWithPackagePrefetch(prefetch),
  });
  const roots = ["kandelo-dev/tap-core/kandelo-sdk"];

  const first = host.prefetchHomebrewPackages(
    "c-development-toolchain",
    "C/C++ toolchain",
    roots,
  );
  const coalesced = host.prefetchHomebrewPackages(
    "c-development-toolchain",
    "C/C++ toolchain",
    roots,
  );
  await expect(first).rejects.toThrow("digest mismatch");
  await expect(coalesced).rejects.toThrow("digest mismatch");
  expect(prefetch).toHaveBeenCalledTimes(1);
  expect(host.homebrewPackagePrefetches()).toEqual([
    expect.objectContaining({
      id: "c-development-toolchain",
      status: "error",
      attempt: 1,
      error: "clang tree digest mismatch",
    }),
  ]);

  await expect(
    host.retryHomebrewPackagePrefetch("c-development-toolchain"),
  ).resolves.toEqual(result);
  expect(prefetch).toHaveBeenNthCalledWith(2, roots);
  expect(host.homebrewPackagePrefetches()).toEqual([
    expect.objectContaining({
      status: "ready",
      attempt: 2,
      result,
    }),
  ]);
});
~~~

Also assert that:

- a repeated ID with different label or roots is rejected before reaching the worker;
- retry is rejected for an unknown or non-error ID;
- a missing worker capability produces a stable error state;
- `attachKernel`, `detachKernel`, halt, and reboot clear the prior kernel generation's prefetch ledger;
- settling a prefetch from a detached/replaced kernel cannot repopulate the
  new kernel generation's ledger or emit a stale ready/error state;
- state and roots returned by accessors are defensive copies.

- [ ] **Step 2: Run the focused test and confirm the interface is absent**

Run:

~~~bash
scripts/dev-shell.sh npx vitest run \
  web-libs/kandelo-session/test/kandelo-session.test.ts
~~~

Expected: FAIL because `KernelLike` and `LiveKernelHost` do not expose package-prefetch lifecycle methods.

- [ ] **Step 3: Implement the bounded state machine**

In `LiveKernelHost` add:

~~~typescript
private homebrewPackagePrefetchById =
  new Map<string, HomebrewPackagePrefetchState>();
private homebrewPackagePrefetchInFlight =
  new Map<string, Promise<HomebrewPackagePrefetchResult>>();
private homebrewPackagePrefetchListeners = new ListenerSet<void>();
private homebrewPackagePrefetchGeneration = 0;
~~~

Validate IDs with `^[a-z0-9][a-z0-9._-]{0,127}$`, labels as non-empty UTF-8 strings of at most 128 bytes, one to 32 roots, and each root as a full Formula identity. Freeze a copied root array in the ledger. Coalesce an identical in-flight ID; reject any attempt to reuse the ID with a different label or roots.

Use this transition core:

~~~typescript
private runHomebrewPackagePrefetch(
  prior: HomebrewPackagePrefetchState,
): Promise<HomebrewPackagePrefetchResult> {
  const generation = this.homebrewPackagePrefetchGeneration;
  const kernelPrefetch = this.kernel?.prefetchHomebrewPackages;
  const running: HomebrewPackagePrefetchState = {
    id: prior.id,
    label: prior.label,
    roots: prior.roots.slice(),
    status: "running",
    attempt: prior.attempt + 1,
  };
  this.homebrewPackagePrefetchById.set(running.id, running);
  this.homebrewPackagePrefetchListeners.emit(undefined);

  const operation = kernelPrefetch === undefined
    ? Promise.reject(new Error("current kernel cannot prefetch Homebrew packages"))
    : kernelPrefetch.call(this.kernel, running.roots);
  const settled = operation.then(
    (result) => {
      if (this.homebrewPackagePrefetchGeneration !== generation) return result;
      this.homebrewPackagePrefetchById.set(running.id, {
        ...running,
        status: "ready",
        result: structuredClone(result),
      });
      return result;
    },
    (error) => {
      if (this.homebrewPackagePrefetchGeneration !== generation) throw error;
      const message = boundedPackagePrefetchError(error);
      this.homebrewPackagePrefetchById.set(running.id, {
        ...running,
        status: "error",
        error: message,
      });
      throw error;
    },
  ).finally(() => {
    if (
      this.homebrewPackagePrefetchGeneration !== generation ||
      this.homebrewPackagePrefetchInFlight.get(running.id) !== settled
    ) return;
    this.homebrewPackagePrefetchInFlight.delete(running.id);
    this.homebrewPackagePrefetchListeners.emit(undefined);
  });
  this.homebrewPackagePrefetchInFlight.set(running.id, settled);
  return settled;
}
~~~

Use one `clearHomebrewPackagePrefetchState()` helper from `attachKernel`,
`detachKernel`, halt, and reboot. It increments the generation before clearing
both maps and notifying listeners, so a promise owned by an older kernel can
settle for its caller without mutating the replacement kernel's UI state.

Do not translate roots into paths or URLs here. The worker remains the only component allowed to read the sealed composition and call `preparePath`.

`boundedPackagePrefetchError` must replace control characters, redact URL userinfo plus query/fragment data, use `"package prefetch failed"` for an empty result, and truncate the final UTF-8 representation to at most 512 bytes. Add cases with a multibyte overlong message and `https://user:secret@example.test/tree?token=secret#fragment`; neither the stored state nor rendered UI may contain `secret`, `token`, or a partial UTF-8 replacement character.

- [ ] **Step 4: Add the React hook and generic retry surface**

Add `useHomebrewPackagePrefetches()` using the same subscription/accessor pattern as `useLazyDownloadSummaries()`. In `App.tsx` keep `LazyDownloadToasts` unchanged for per-asset byte progress and render a second generic status toast:

~~~tsx
const packagePrefetches = useHomebrewPackagePrefetches();

<PackagePrefetchToasts
  states={packagePrefetches}
  onRetry={(id) => {
    void host.retryHomebrewPackagePrefetch(id).catch(() => {
      // The host ledger owns and renders the stable error.
    });
  }}
/>
~~~

For `running` show `Preparing ${state.label}`; for `ready` show `${state.label} ready`; for `error` show `${state.label}: ${state.error}` using only the bounded, redacted ledger value and:

~~~tsx
<button
  type="button"
  className="kdownload-toast-retry"
  onClick={() => onRetry(state.id)}
>
  Retry
</button>
~~~

Render running and ready announcements with `aria-live="polite"` and errors with `role="alert"`. A ready state may fade after 2.4 seconds in the hook, but an error must remain until dismissed or retried.

- [ ] **Step 5: Run focused state and browser UI tests**

Run:

~~~bash
scripts/dev-shell.sh npx vitest run \
  web-libs/kandelo-session/test/kandelo-session.test.ts
scripts/dev-shell.sh bash -euo pipefail -c '
cd apps/browser-demos
npx playwright test test/lazy-download-summary.spec.ts --project=chromium
'
~~~

Expected: the lifecycle tests pass, byte-progress toasts still render, and the generic error state exposes a working Retry button without replacing the lazy-asset ledger.

- [ ] **Step 6: Commit the generic prefetch UI**

~~~bash
git add web-libs/kandelo-session/src/kernel-host.ts \
  web-libs/kandelo-session/test/kandelo-session.test.ts \
  apps/browser-demos/pages/kandelo/kernel-host/react.tsx \
  apps/browser-demos/pages/kandelo/app/App.tsx \
  apps/browser-demos/pages/kandelo/styles.css \
  apps/browser-demos/test/lazy-download-summary.spec.ts
git commit -m "feat: expose retryable package prefetch state"
~~~

## Task 2: Add the C-development preset over the main shell

**Files:**

- Create: `apps/browser-demos/pages/kandelo/c-development.ts`
- Create: `apps/browser-demos/pages/kandelo/kernel-host/preset-session.ts`
- Create: `apps/browser-demos/pages/kandelo/c-development.test.ts`
- Modify: `web-libs/kandelo-session/src/kernel-host.ts`
- Modify: `web-libs/kandelo-session/src/demo-guides.ts`
- Modify: `apps/browser-demos/pages/kandelo/presets.ts`
- Modify: `apps/browser-demos/pages/kandelo/gallery-descriptor.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/candidate-evidence-vfs.ts`

**Interfaces:**

- Consumes: `C_DEVELOPMENT_SESSION` from Stable Interfaces and `LiveKernelHost.prefetchHomebrewPackages(id, label, roots)` from Task 1.
- Produces: built-in live demo `c-dev`, protected profile mappings `toolchain-shell -> shell` and `c-development -> c-dev`, and generic `applyPresetSessionBoot(descriptor, session)`, `preparePresetWorkspace(kernel, session, identity)`, plus `startPresetPackagePrefetch(host, session)`.

The generic helpers use these narrow interfaces so their ordering and failure
behavior can be tested without constructing a BrowserKernel:

~~~typescript
export interface PresetSessionIdentity {
  cwd: string;
  env: string[];
  uid: number;
  gid: number;
}

export interface PresetSessionKernel {
  spawnFromVfs(
    path: string,
    argv: string[],
    options: {
      cwd: string;
      env: string[];
      uid: number;
      gid: number;
      stdin: Uint8Array;
    },
  ): Promise<{ pid: number; exit: Promise<number> }>;
}

export interface PresetSessionHost {
  getStatus(): MachineStatus;
  prefetchHomebrewPackages(
    id: string,
    label: string,
    roots: readonly string[],
  ): Promise<HomebrewPackagePrefetchResult>;
}
~~~

- [ ] **Step 1: Write failing preset and descriptor tests**

Create `c-development.test.ts` with:

~~~typescript
test("C development is presentation over the ordinary shell", () => {
  const preset = PRESET_LIBRARY.find(({ id }) => id === "c-dev");
  expect(preset).toMatchObject({
    id: "c-dev",
    title: "C development",
    base: "kandelo:shell@abi" + ABI_VERSION,
    packages: ["kandelo-sdk@local", "make@local", "bash@local"],
    bootCommand: ["bash", "-l", "-i"],
    cwd: "/home/user/c",
    env: {
      CC: "cc",
      CXX: "c++",
      MAKEFLAGS: "-j1",
      PWD: "/home/user/c",
    },
  });
  expect(C_DEVELOPMENT_SESSION.packagePrefetch?.roots).toEqual([
    "kandelo-dev/tap-core/kandelo-sdk",
  ]);
});

test("gallery descriptor changes cwd and convenience env without changing image", () => {
  const preset = PRESET_LIBRARY.find(({ id }) => id === "c-dev");
  if (preset === undefined) throw new Error("c-dev preset is absent");
  const item: GalleryItem = {
    ...preset,
    packages: preset.packages.slice(),
    bootCommand: preset.bootCommand.slice(),
  };
  const base: BootDescriptor = {
    version: 1,
    id: "shell",
    title: "Bare shell",
    base: "kandelo:shell@abi" + ABI_VERSION,
    runtime: {
      arch: "wasm32",
      kernel: "kernel@local",
      memoryPages: 2048,
      features: ["shared-array-buffer", "pty"],
      time: "real",
    },
    packages: ["bash@local"],
    mounts: [
      {
        path: "/",
        source: "image",
        ref: "browser-main-shell.vfs@local",
        readonly: false,
      },
      { path: "/tmp", source: "scratch", ephemeral: true },
    ],
    boot: {
      argv: ["bash", "-l", "-i"],
      cwd: "/home/user",
      env: {
        HOME: "/home/user",
        USER: "user",
        LOGNAME: "user",
      },
      uid: 1000,
      gid: 1000,
    },
    caps: { network: false },
  };
  const result = descriptorFromGalleryItem(item, base);
  expect(result.mounts).toEqual(base.mounts);
  expect(result.boot.cwd).toBe("/home/user/c");
  expect(result.boot.env).toMatchObject({
    HOME: "/home/user",
    USER: "user",
    CC: "cc",
    CXX: "c++",
    MAKEFLAGS: "-j1",
  });
});

test("protected candidate boot retains identity while applying the preset session", () => {
  const candidate: BootDescriptor = {
    version: 1,
    id: "shell",
    title: "Bare shell",
    base: "kandelo:shell@abi" + ABI_VERSION,
    runtime: {
      arch: "wasm32",
      kernel: "kernel@local",
      memoryPages: 2048,
      features: ["shared-array-buffer", "pty"],
      time: "real",
    },
    packages: ["bash@local"],
    mounts: [
      {
        path: "/",
        source: "image",
        ref: "candidate-browser-main-shell.vfs@local",
        readonly: false,
      },
      { path: "/tmp", source: "scratch", ephemeral: true },
    ],
    boot: {
      argv: ["bash", "-l", "-i"],
      cwd: "/home/user",
      env: { HOME: "/home/user", PATH: "/usr/bin:/bin" },
      uid: 1000,
      gid: 1000,
    },
    caps: { network: false },
  };
  const result = applyPresetSessionBoot(candidate, C_DEVELOPMENT_SESSION);
  expect(result.mounts).toEqual(candidate.mounts);
  expect(result.boot.argv).toEqual(candidate.boot.argv);
  expect(result.boot.uid).toBe(candidate.boot.uid);
  expect(result.boot.gid).toBe(candidate.boot.gid);
  expect(result.boot.cwd).toBe("/home/user/c");
  expect(result.boot.env).toMatchObject({
    HOME: "/home/user",
    PATH: "/usr/bin:/bin",
    CC: "cc",
    CXX: "c++",
    PWD: "/home/user/c",
  });
});
~~~

Add a mocked ordering test for `preparePresetSession`:

~~~typescript
test("prepares local files before running status and starts prefetch afterward", async () => {
  const events: string[] = [];
  let status: MachineStatus = "booting";
  const kernel: PresetSessionKernel = {
    async spawnFromVfs(path, argv) {
      expect(path).toBe("/bin/bash");
      expect(argv[0]).toBe("/bin/bash");
      events.push("workspace");
      return { pid: 41, exit: Promise.resolve(0) };
    },
  };
  const host: PresetSessionHost = {
    getStatus: () => status,
    async prefetchHomebrewPackages(_id, _label, roots) {
      expect(status).toBe("running");
      expect(roots).toEqual(["kandelo-dev/tap-core/kandelo-sdk"]);
      events.push("prefetch");
      return {
        roots: [...roots],
        packages: [],
        materializedPackages: [],
        alreadyMaterializedPackages: [],
      };
    },
  };
  const identity: PresetSessionIdentity = {
    cwd: "/home/user/c",
    env: ["HOME=/home/user", "USER=user"],
    uid: 1000,
    gid: 1000,
  };

  await preparePresetWorkspace(kernel, C_DEVELOPMENT_SESSION, identity);
  status = "running";
  events.push("status:running");
  const pending = startPresetPackagePrefetch(
    host,
    C_DEVELOPMENT_SESSION,
  );
  if (pending === undefined) {
    throw new Error("c-dev package prefetch is absent");
  }
  expect(events).toEqual(["workspace", "status:running", "prefetch"]);
  await expect(pending).resolves.toMatchObject({
    roots: ["kandelo-dev/tap-core/kandelo-sdk"],
  });
});
~~~

- [ ] **Step 2: Run the focused test and confirm the preset is missing**

Run:

~~~bash
scripts/dev-shell.sh npx vitest run \
  apps/browser-demos/pages/kandelo/c-development.test.ts
~~~

Expected: FAIL because `c-development.ts`, `c-dev`, and the preset-session helpers do not exist.

- [ ] **Step 3: Add the one reviewed session constant and gallery metadata**

Create `C_DEVELOPMENT_SESSION` exactly as shown in Stable Interfaces. Add this preset:

~~~typescript
{
  id: "c-dev",
  title: "C development",
  summary: "Compile and run C or C++ in the shell; the admitted toolchain downloads in the background.",
  base: SHELL_BASE,
  packages: ["kandelo-sdk@local", "make@local", "bash@local"],
  accent: "#6f42c1",
  glyph: "C",
  bootCommand: ["bash", "-l", "-i"],
  cwd: C_DEVELOPMENT_SESSION.cwd,
  env: C_DEVELOPMENT_SESSION.env,
  estimatedUrlBytes: 548,
}
~~~

Extend `Preset` and `GalleryItem` with:

~~~typescript
cwd?: string;
env?: Readonly<Record<string, string>>;
~~~

Copy both fields in `liveGalleryItems()` and `LiveKernelHost.setGalleryItems()`. In both `descriptorFromGalleryItem` and `descriptorFor`, use `item.cwd` for the boot cwd and merge `item.env` after the base user identity. Do not infer compiler flags from the preset ID.

- [ ] **Step 4: Implement bounded workspace preparation**

`preparePresetWorkspace` must reject:

- a cwd outside `/home/user`;
- more than 16 files;
- a file outside the cwd;
- a path containing NUL, backslash, `.`, or `..` segments;
- source contents containing NUL;
- a total source payload over 64 KiB;
- a mode with bits outside `0o777`.

Resolve path segments before the containment check: `/home/user/c2/file.c` is not inside `/home/user/c`. `applyPresetSessionBoot` must return defensive copies and may change only `boot.cwd` plus the merged `boot.env`; it must preserve the protected descriptor's argv, uid/gid, mounts, runtime, and VFS reference.

Build one shell command using a local `shellQuote` helper, then run it as the preset user:

~~~typescript
const commands = [
  "umask 022",
  "mkdir -p -- " + shellQuote(session.cwd),
  ...session.workspaceFiles.flatMap((file) => [
    "printf %s " + shellQuote(file.contents) +
      " > " + shellQuote(file.path),
    "chmod " + file.mode.toString(8) + " -- " + shellQuote(file.path),
  ]),
];
const { exit } = await kernel.spawnFromVfs(
  "/bin/bash",
  ["/bin/bash", "-lc", commands.join("\n")],
  {
    // The final session cwd is created by this command, so launch from the
    // already-present user home rather than a not-yet-existing directory.
    cwd: "/home/user",
    env: identity.env,
    uid: identity.uid,
    gid: identity.gid,
    stdin: new Uint8Array(),
  },
);
const code = await exit;
if (code !== 0) {
  throw new Error("preset workspace preparation exited with " + code);
}
~~~

This operation is awaited before `running` because the example must exist when the terminal opens. It may use only image-owned shell utilities and must not touch the toolchain paths.

- [ ] **Step 5: Wire the shared shell profile and background prefetch**

Add `"c-dev"` to `LIVE_DEMO_IDS` and:

~~~typescript
"c-dev": {
  image: "shell",
  session: C_DEVELOPMENT_SESSION,
},
~~~

Extend `LiveProfile` with `session?: PresetSession` and copy the spec's session through `profileFor`. After `host.attachKernel(kernel)` and `host.setDefaultShell(...)`, prepare the workspace. At the end of a successful boot, preserve this order:

In `profileForCandidateEvidence`, pass the descriptor returned by `candidateEvidenceBootDescriptor` through `applyPresetSessionBoot` when `base.session` is present. This is required for the protected `c-development` surface: the immutable product supplies the candidate VFS and base boot identity, while the reviewed preset supplies only cwd and convenience environment. The `toolchain-shell` surface has no session overlay.

~~~typescript
tick("ready");
host.setStatus("running");
const packagePrefetch = profile.session === undefined
  ? undefined
  : startPresetPackagePrefetch(host, profile.session);
if (packagePrefetch !== undefined) {
  void packagePrefetch.catch(() => {
    // The generation-guarded host ledger owns the visible error and retry.
  });
}
~~~

Do not await this promise from `bootProfile`. A rejection must not call
`showBootError` or destroy the kernel. Do not add completion-side logging here:
the generation-guarded ledger is the sole status authority, so a promise from a
detached kernel cannot emit ready/error state into its replacement. The toast
renders only the ledger's bounded, credential-redacted error.

- [ ] **Step 6: Add the guide and protected profile mapping**

Add a `cDevelopmentGuide()` with:

- “Compile C” action: `cc hello.c -o hello.wasm && ./hello.wasm`;
- “Compile C++” action that writes a tiny `hello.cpp` using `<iostream>`, runs `c++ hello.cpp -o hello-cxx.wasm`, and executes it;
- a script editor seeded with the C compile command;
- copy stating that first use may download the admitted toolchain, the preset starts that download in the background, and retry never selects a different version;
- copy stating that fork-family behavior in newly compiled programs is not supported until Kandelo ships an in-guest fork instrumenter.

Return terminal presentation for `c-dev`. Map protected profiles exactly:

~~~typescript
const LIVE_DEMO_BY_EVIDENCE_PROFILE = {
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
} as const;
~~~

- [ ] **Step 7: Run focused tests and typechecks**

Run:

~~~bash
scripts/dev-shell.sh npx vitest run \
  apps/browser-demos/pages/kandelo/c-development.test.ts \
  web-libs/kandelo-session/test/kandelo-session.test.ts
scripts/dev-shell.sh bash -euo pipefail -c '
cd host
npm run typecheck
'
scripts/dev-shell.sh bash -euo pipefail -c '
cd apps/browser-demos
npx tsc --noEmit
'
~~~

Expected: preset and ordering tests pass, both TypeScript packages compile, and `c-dev` resolves to the same shell VFS URL as `shell` with only a different fragment/profile.

- [ ] **Step 8: Commit the preset**

~~~bash
git add apps/browser-demos/pages/kandelo/c-development.ts \
  apps/browser-demos/pages/kandelo/c-development.test.ts \
  apps/browser-demos/pages/kandelo/kernel-host/preset-session.ts \
  apps/browser-demos/pages/kandelo/presets.ts \
  apps/browser-demos/pages/kandelo/gallery-descriptor.ts \
  apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts \
  apps/browser-demos/pages/kandelo/kernel-host/candidate-evidence-vfs.ts \
  web-libs/kandelo-session/src/kernel-host.ts \
  web-libs/kandelo-session/src/demo-guides.ts
git commit -m "feat: add C development shell preset"
~~~

## Task 3: Prove ordinary and preset browser compilation

**Files:**

- Modify: `apps/browser-demos/test/abi-staging-product-evidence.spec.ts`
- Modify: `scripts/abi-staging-product-browser-evidence.ts`
- Modify: `scripts/abi-staging-product-browser-evidence.test.ts`
- Modify: `abi/staging/evidence-definitions.toml`
- Regenerate: `abi/staging/evidence-definitions.generated.json`
- Modify: `tests/vfs-products.toml`
- Regenerate: `tests/vfs-products.generated.json`

**Interfaces:**

- Consumes: protected live-page surface adapter, candidate `browser-main-shell`, and lazy inputs `homebrew-libcxx`, `homebrew-clang`, and `homebrew-kandelo-sdk`.
- Produces: repository suites `main-shell-toolchain-browser` and `main-shell-c-development-browser`, both required browser evidence for `browser-main-shell`.

- [ ] **Step 1: Write failing evidence-selection tests**

Add to `abi-staging-product-browser-evidence.test.ts`:

~~~typescript
test.each([
  ["main-shell-toolchain-browser", "toolchain-shell"],
  ["main-shell-c-development-browser", "c-development"],
] as const)("selects protected %s browser evidence", (definitionId, surface) => {
  const selection = buildBrowserEvidenceSelection(
    selectionInput("browser-main-shell", definitionId),
  );
  assert.equal(selection.surface, surface);
  assert.deepEqual(
    selection.lazyAssets.map(({ id }) => id),
    ["homebrew-libcxx", "homebrew-clang", "homebrew-kandelo-sdk"],
  );
});
~~~

Add rejection cases for an `exec` runner, the wrong repository-suite name, a missing lazy input, an extra lazy input, or a toolchain definition registered to any product other than `browser-main-shell`.

- [ ] **Step 2: Run the focused test and confirm the surfaces are absent**

Run:

~~~bash
scripts/dev-shell.sh npx tsx --test \
  scripts/abi-staging-product-browser-evidence.test.ts
~~~

Expected: FAIL because neither definition has a protected surface adapter.

- [ ] **Step 3: Add exact protected surface mappings**

Extend `BrowserEvidenceSurface` with `"toolchain-shell"` and `"c-development"`. Add:

~~~typescript
const DEFINITION_SURFACES = {
  // Preserve every existing mapping.
  "main-shell-toolchain-browser": "toolchain-shell",
  "main-shell-c-development-browser": "c-development",
} as const;

const PROTECTED_BROWSER_REPOSITORY_SUITES = {
  // Preserve every existing mapping.
  "toolchain-shell": "main-shell-toolchain-browser",
  "c-development": "main-shell-c-development-browser",
} as const;
~~~

Update the protected suite validator in `abi-staging-product-evidence.spec.ts` with the same two exact pairs.

- [ ] **Step 4: Implement the ordinary-shell protected operation**

Before executing a compiler, read the UI's lazy ledger and assert it contains none of the three selected toolchain inputs. Then run one bounded shell command that writes both protected sources, compiles them with guest `cc` and `c++`, and executes both:

~~~sh
set -eu
work=/tmp/kandelo-browser-toolchain
rm -rf "$work"
mkdir -p "$work"
printf '%s\n' \
  '#include <stdio.h>' \
  'int main(void) { puts("BROWSER_C_IN_GUEST_OK"); return 0; }' \
  >"$work/main.c"
printf '%s\n' \
  '#include <iostream>' \
  'int main() { std::cout << "BROWSER_CXX_IN_GUEST_OK\n"; return 0; }' \
  >"$work/main.cpp"
cc "$work/main.c" -o "$work/main-c.wasm"
c++ "$work/main.cpp" -o "$work/main-cxx.wasm"
"$work/main-c.wasm"
"$work/main-cxx.wasm"
~~~

Require both protected strings, exit status 0, and no stderr. Require the
post-compile lazy-input set to equal the three definition-owned identities.
Do not require first-use network order: the SDK wrapper can be opened before
the compiler runtime, while explicit closure prefetch is dependency-first.
Re-run both outputs and `cc --version`, then assert there are no new asset
requests and no second materialization events.

- [ ] **Step 5: Implement the C-development protected operation**

Launch the candidate live page with protected profile `c-development`. Require:

1. the terminal surface becomes available;
2. `/home/user/c/hello.c` contains the exact reviewed source;
3. `pwd` is `/home/user/c`;
4. `CC=cc`, `CXX=c++`, and `MAKEFLAGS=-j1`;
5. generic package and byte progress appears;
6. “C/C++ toolchain ready” appears only after all three verified lazy trees complete;
7. `cc hello.c -o hello.wasm && ./hello.wasm` prints `Hello from Kandelo C!`;
8. a tiny C++ source compiles and prints `BROWSER_C_DEV_CXX_OK`;
9. repeating both commands triggers no new lazy requests.

Return this exact bounded observation:

~~~text
c-development-ready
Hello from Kandelo C!
BROWSER_C_DEV_CXX_OK
toolchain-reused
~~~

- [ ] **Step 6: Register both definitions and product tests**

Append to `evidence-definitions.toml`:

~~~toml
[[definitions]]
id = "main-shell-toolchain-browser"
host = "browser"
runner = "repository-suite"
timeout_seconds = 600

[definitions.probe]
suite = "main-shell-toolchain-browser"
lazy_inputs = [
  "homebrew-libcxx",
  "homebrew-clang",
  "homebrew-kandelo-sdk",
]

[[definitions]]
id = "main-shell-c-development-browser"
host = "browser"
runner = "repository-suite"
timeout_seconds = 600

[definitions.probe]
suite = "main-shell-c-development-browser"
lazy_inputs = [
  "homebrew-libcxx",
  "homebrew-clang",
  "homebrew-kandelo-sdk",
]
~~~

Change only the `browser-main-shell` registration in `tests/vfs-products.toml`:

~~~toml
browser = [
  "main-shell-basic-e2e",
  "main-shell-toolchain-browser",
  "main-shell-c-development-browser",
  "main-shell-fbdoom-e2e",
  "main-shell-modeset-e2e",
]
~~~

- [ ] **Step 7: Regenerate registries**

Run:

~~~bash
scripts/dev-shell.sh bash -euo pipefail -c '
host_target=$(rustc -vV | awk "/^host/ {print \$2}")
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
~~~

Expected: only evidence/test-registry projections change; the Pages registry still contains the exact seven products and no `c-dev` product.

- [ ] **Step 8: Run local protected-evidence tests**

Run:

~~~bash
scripts/dev-shell.sh npx tsx --test \
  scripts/abi-staging-product-browser-evidence.test.ts
scripts/dev-shell.sh bash scripts/test-abi-staging-product-evidence.sh
scripts/dev-shell.sh bash -euo pipefail -c '
cd apps/browser-demos
npx playwright test test/abi-staging-product-evidence.spec.ts --project=chromium
'
~~~

Expected: local policy/runner tests pass. An unconfigured local Playwright skip
is not candidate evidence and must not be counted as one.

- [ ] **Step 9: Commit protected browser evidence**

~~~bash
git add apps/browser-demos/test/abi-staging-product-evidence.spec.ts \
  scripts/abi-staging-product-browser-evidence.ts \
  scripts/abi-staging-product-browser-evidence.test.ts \
  abi/staging/evidence-definitions.toml \
  abi/staging/evidence-definitions.generated.json \
  tests/vfs-products.toml tests/vfs-products.generated.json
git commit -m "test: require in-browser C and C++ evidence"
~~~

This commit and the shell plan's source/evidence commits must all be ancestors
of the exact Kandelo request head.

- [ ] **Step 10: Run both suites against the exact candidate shell**

Invoke both generated browser evidence requests through the staging
coordination handoff against the exact candidate `browser-main-shell`.
Require zero skipped protected operations. Expected: both receipts are
`success`, bind the candidate VFS digest and exact definition digest, name the
three immutable lazy inputs, compile/link/execute C and C++ in Chromium, and
contain no host compiler identity. The successful
`main-shell-toolchain-browser` result is the browser half of the Formula plan's
runtime-claim authority; the C-development result remains additional preset/UI
evidence.

## Task 4: Prove browser failure atomicity and explicit retry

**Files:**

- Create: `apps/browser-demos/test/kandelo-c-development.spec.ts`
- Modify: `apps/browser-demos/test/support/homebrew-lazy-transport.ts`

**Interfaces:**

- Consumes: the exact canonically recomposed shell, its authenticated resolved
  inputs/composition descriptors, and the generic package-prefetch Retry
  button.
- Produces: user-facing acceptance for terminal-before-prefetch, missing/truncated/digest failure, atomic unmaterialized trees, and same-descriptor retry.

- [ ] **Step 1: Add exact transport helpers**

Import `corsProxyFetchUrl` from
`host/src/networking/cors-proxy-url.ts` and export:

~~~typescript
export interface CanonicalHomebrewAsset {
  inputId: string;
  package: string;
  descriptorReference: string;
  sourceUrl: string;
  sha256: string;
  bytes: number;
}

export interface CanonicalHomebrewTransportPlan {
  assets: CanonicalHomebrewAsset[];
}

export function browserLazyFetchUrl(
  sourceUrl: string,
  pageUrl: string,
  corsProxyUrl: string,
): string {
  const resolved = browserResolvedLazySourceUrl(sourceUrl, pageUrl);
  return expectedBrowserLazyTransport(resolved, pageUrl) === "direct"
    ? resolved
    : corsProxyFetchUrl(new URL(corsProxyUrl, pageUrl).href, resolved);
}

export function canonicalAssetForPackage(
  plan: CanonicalHomebrewTransportPlan,
  fullName: string,
): CanonicalHomebrewAsset {
  const matches = plan.assets.filter((asset) => asset.package === fullName);
  if (matches.length !== 1) {
    throw new Error(
      "expected one canonical lazy asset for " + fullName +
        ", found " + matches.length,
    );
  }
  const asset = matches[0]!;
  const formula =
    /^kandelo-dev\/tap-core\/([a-z0-9][a-z0-9+._-]{0,127})$/u
      .exec(fullName)?.[1];
  const descriptor =
    /^ghcr\.io\/kandelo-dev\/homebrew-tap-core-abi-[1-9][0-9]*\/([a-z0-9][a-z0-9+._-]{0,127})@sha256:[0-9a-f]{64}$/u
      .exec(asset.descriptorReference);
  const descriptorRepository = asset.descriptorReference
    .replace(/^ghcr\.io\//u, "")
    .replace(/@sha256:[0-9a-f]{64}$/u, "");
  if (
    formula === undefined ||
    descriptor?.[1] !== formula ||
    asset.inputId !== "homebrew-" + formula ||
    !/^[0-9a-f]{64}$/u.test(asset.sha256) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 1 ||
    asset.sourceUrl !==
      "https://ghcr.io/v2/" + descriptorRepository +
        "/blobs/sha256:" + asset.sha256
  ) {
    throw new Error("canonical lazy asset identity is invalid for " + fullName);
  }
  return { ...asset };
}
~~~

Build this plan in test setup from the canonical `browser-main-shell`
resolved-input document and the composition descriptors authenticated by Pages
readiness. Do not read the legacy bottle-mirror plan or accept an independently
supplied URL list.

- [ ] **Step 2: Write the terminal-availability and reuse test**

Delay the exact `clang` asset response, launch `c-dev`, and assert:

~~~typescript
await expect(page.getByRole("heading", { name: "C development" }))
  .toBeVisible();
await runTerminalCommand(
  page,
  "printf 'C_DEV_TERMINAL_USABLE_DURING_PREFETCH\\n'",
  "C_DEV_TERMINAL_USABLE_DURING_PREFETCH",
);
expect(clangResponseReleased).toBe(false);
releaseClangResponse();
await expect(page.getByText("C/C++ toolchain ready")).toBeVisible({
  timeout: 300_000,
});
await runTerminalCommand(
  page,
  "cc hello.c -o hello.wasm && ./hello.wasm",
  "Hello from Kandelo C!",
  300_000,
);
~~~

Capture asset request counts before a second compile and require the counts to remain unchanged.

- [ ] **Step 3: Write the default-shell deferral test**

Boot `shell`, wait for the prompt, run `printf DEFAULT_SHELL_READY`, and assert no requests or lazy ledger entries map to `kandelo-sdk`, `clang`, or the newly selected `libcxx`. Then run the protected C/C++ command from Task 3 and require exactly one verified request for each selected lazy tree.

- [ ] **Step 4: Write table-driven missing, truncated, and digest-mismatch cases**

Use a new browser context for each case:

~~~typescript
const failures = [
  {
    name: "missing",
    response: (asset: CanonicalHomebrewAsset) => ({
      status: 404,
      body: Buffer.from("missing"),
    }),
    expected: /404|not found/i,
  },
  {
    name: "truncated",
    response: (asset: CanonicalHomebrewAsset, body: Buffer) => ({
      status: 200,
      body: body.subarray(0, body.byteLength - 1),
    }),
    expected: /byte count|size|truncated/i,
  },
  {
    name: "digest-mismatch",
    response: (asset: CanonicalHomebrewAsset, body: Buffer) => {
      const corrupt = Buffer.from(body);
      corrupt[0] ^= 0xff;
      return { status: 200, body: corrupt };
    },
    expected: /sha-?256|digest/i,
  },
] as const;
~~~

For each failure:

- launch `c-dev` and wait for the generic error state;
- require the error to identify the C/C++ toolchain and match the expected integrity class;
- run `printf 'SHELL_STILL_ALIVE\n'` successfully;
- require `cc --version` to fail without executing partial compiler bytes;
- inspect the lazy ledger and require the failing asset status `error` with no `complete` event;
- restore the exact immutable response;
- click `Retry`;
- require the same source URL, digest, and expected byte count;
- compile and execute `hello.c` successfully;
- require one complete materialization after the failed attempt.

- [ ] **Step 5: Run the browser acceptance**

Run the canonical-product setup used by the final admitted Pages evidence
harness, passing its authenticated resolved-input and composition-descriptor
handoff, then:

~~~bash
scripts/dev-shell.sh bash -euo pipefail -c '
cd apps/browser-demos
npx playwright test test/kandelo-c-development.spec.ts --project=chromium
'
~~~

Expected: all happy-path and failure cases pass. Diagnostics show the terminal running before prefetch, no ordinary-boot toolchain traffic, atomic failure, and retry against the same immutable asset.

- [ ] **Step 6: Commit browser acceptance**

~~~bash
git add apps/browser-demos/test/kandelo-c-development.spec.ts \
  apps/browser-demos/test/support/homebrew-lazy-transport.ts
git commit -m "test: cover lazy toolchain browser recovery"
~~~

## Task 5: Hold or admit the exact seven-product Pages site

**Files:**

- Modify: `scripts/abi-staging-pages-readiness.ts`
- Modify: `scripts/abi-staging-pages-readiness.test.ts`
- Modify: `scripts/abi-staging-pages-producer.ts`
- Modify: `scripts/abi-staging-pages-producer.test.ts`
- Modify: `abi/staging/pages-activation.toml`
- Modify: `docs/browser-support.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: admitted shell inputs, successful `main-shell-toolchain-node`, `main-shell-toolchain-browser`, and `main-shell-c-development-browser` receipts.
- Produces: observe-mode readiness for one complete seven-product site, test fixture `sevenProductToolchainFixture()`, and user-facing documentation.

- [ ] **Step 1: Write failing readiness blocker tests**

Add this fixture beside the existing `sevenProductFixture()`. The mini product
IDs exercise the readiness algorithm; the generated-registry assertion in
Step 2 checks the real public IDs.

~~~typescript
function toolchainInputs() {
  return [
    bottleInput("libcxx", "lazy-reference"),
    bottleInput("clang", "lazy-reference"),
    bottleInput("kandelo-sdk", "lazy-reference"),
  ];
}

const TOOLCHAIN_DEFINITIONS = [
  ["main-shell-toolchain-node", "node"],
  ["main-shell-toolchain-browser", "browser"],
  ["main-shell-c-development-browser", "browser"],
] as const;

function sevenProductToolchainFixture(): PagesReadinessInputV1 {
  const input = sevenProductFixture();
  const shellIndex = input.products.findIndex(({ id }) => id === "mini-shell");
  if (shellIndex < 0) throw new Error("seven-product fixture lacks mini-shell");
  const prior = input.products[shellIndex]!;
  input.products[shellIndex] = candidateProduct(input, "mini-shell", [
    ...prior.candidate_resolved_inputs.inputs,
    ...toolchainInputs(),
  ]);

  const registration = input.test_registry.value.registrations.find(
    ({ product }) => product === "mini-shell",
  );
  if (registration === undefined) {
    throw new Error("seven-product fixture lacks mini-shell tests");
  }
  registration.node.push("main-shell-toolchain-node");
  registration.browser.push(
    "main-shell-toolchain-browser",
    "main-shell-c-development-browser",
  );
  for (const [id, host] of TOOLCHAIN_DEFINITIONS) {
    input.evidence_definitions.value.definitions.push({
      definition_sha256: sha256(new TextEncoder().encode(id)),
      host,
      id,
      implementation: [],
      probe: {
        suite: id,
        lazy_inputs: [
          "homebrew-libcxx",
          "homebrew-clang",
          "homebrew-kandelo-sdk",
        ],
      },
      runner: "repository-suite",
      timeout_seconds: 600,
    });
  }
  input.authority.evidence_definitions_sha256 =
    digest(input.evidence_definitions.value);
  input.authority.test_registry_sha256 = digest(input.test_registry.value);
  return input;
}
~~~

Extend the `successfulDependencies` options object itself, preserving every existing option:

~~~typescript
type SuccessfulDependencyOptions = {
  builderFailure?: string;
  evidence?: ["node" | "browser", "failure" | "timeout"];
  failedDefinition?: string;
  finalCandidateReference?: boolean;
  informationalFailure?: boolean;
  wrongDefinitionDigest?: boolean;
  canonicalOciMutation?: "layer" | "metadata";
};
~~~

Use `SuccessfulDependencyOptions` for the existing function's `options` parameter.

Inside its existing `runEvidence` method, select the receipt outcome by exact definition:

~~~typescript
const configured = options.evidence;
const outcome =
  options.failedDefinition === request.definition_id &&
      request.product.id === "mini-shell"
    ? "failure"
    : configured?.[0] === request.host &&
        request.product.id === "mini-base"
      ? configured[1]
      : "success";
if (options.informationalFailure && request.product.id === "mini-background") {
  return evidenceReceipt(request, "failure");
}
const receipt = evidenceReceipt(request, outcome);
if (options.wrongDefinitionDigest && request.product.id === "mini-base") {
  receipt.definition.definition_sha256 = "f".repeat(64);
}
return receipt;
~~~

Add these concrete blocker tests:

~~~typescript
for (const formula of ["libcxx", "clang", "kandelo-sdk"] as const) {
  await t.test("missing " + formula + " admission", async () => {
    const input = sevenProductToolchainFixture();
    const shell = input.products.find(({ id }) => id === "mini-shell")!;
    const index = shell.admissions.findIndex((envelope) =>
      envelope.record.admission.formula_metadata_update.formula === formula
    );
    assert.notEqual(index, -1);
    shell.admissions.splice(index, 1);
    await assertBlocked(input, "missing-admission", "mini-shell");
  });
}

for (const definitionId of [
  "main-shell-toolchain-node",
  "main-shell-toolchain-browser",
  "main-shell-c-development-browser",
] as const) {
  await t.test("failed " + definitionId, async () => {
    const host = definitionId.endsWith("-node") ? "node" : "browser";
    await assertBlocked(
      sevenProductToolchainFixture(),
      `${host}-evidence-failure`,
      "mini-shell",
      successfulDependencies({ failedDefinition: definitionId }),
    );
  });
}
~~~

Add one test each that mutates the exact toolchain admission/canonical layer used to recompose the shell:

- candidate-namespace admission reference → `candidate-reference`;
- mutable-tag admission reference → `candidate-reference`;
- credentialed-only/noncanonical URL → `candidate-reference`;
- canonical reference digest differing from the admitted layer → `layer-mismatch`;
- promoted-layer byte count differing from the resolved input → `layer-mismatch`.

Pass each mutated fixture to `assertBlocked` and assert the listed blocker kind and product `mini-shell`, not only an error-message fragment.

- [ ] **Step 2: Write the ready-site inventory test**

Add `readFileSync` to the existing `node:fs` import. With all admissions and
receipts successful, define `result` from the actual readiness API and require:

~~~typescript
const input = sevenProductToolchainFixture();
const result = await computePagesReadiness(
  input,
  successfulDependencies(),
);
assert.equal(result.readiness.ready, true);
assert.equal(result.site_manifest?.products.length, 7);
assert.ok(
  result.site_manifest?.files.every(({ path }) =>
    !/clang|kandelo-sdk|libcxx|compiler\.vfs/iu.test(path)
  ),
);

const publicRegistry = JSON.parse(readFileSync(
  "apps/browser-demos/pages/kandelo/kernel-host/" +
    "pages-vfs-products.generated.json",
  "utf8",
));
assert.deepEqual(
  publicRegistry.products,
  [
    { id: "browser-lamp", load: "lazy" },
    { id: "browser-main-shell", load: "eager" },
    { id: "browser-nginx", load: "lazy" },
    { id: "browser-nginx-php", load: "lazy" },
    { id: "browser-node", load: "lazy" },
    { id: "browser-wordpress", load: "lazy" },
    { id: "platform-rootfs", load: "eager" },
  ],
);
~~~

Require the `browser-main-shell` resolved-input document to retain all three immutable GHCR lazy references and the compact VFS to contain only lazy metadata for them. Require no eighth product, no compiler release archive, and no candidate reference anywhere in the canonical JSON.

- [ ] **Step 3: Extend generic admission binding and producer hold/ready tests**

Preserve `computePagesReadiness`'s existing generic binding of every current
Homebrew lazy resolved input to exactly one same-Formula, same-architecture
admission. Extend its fixtures for the three new inputs and current descriptor
schema. Require each canonical reference, digest, and byte count to equal both
the promoted layer and the resolved input, then require successful evidence
for every definition in the product's generated test registration. Keep this
generic: do not add a `clang`, `libcxx`, `kandelo-sdk`, or
`browser-main-shell` name branch.

In the producer, a blocked readiness result may write only its bounded
`readiness.json`; it must not create, partially replace, or select a successor
site tree. A ready result binds the validated canonical inputs and evidence
digests into one immutable successor before exposing it to observe/active
selection.

In `abi-staging-pages-producer.test.ts`, run one fixture with a missing `clang` admission and require only `readiness.json` with the prior site selection untouched. Run the complete fixture and require one immutable source tree whose deployment manifest binds:

- exact Kandelo commit/tree;
- exact tap commit/tree;
- target ABI and ABI snapshot digest;
- seven product VFS identities;
- all required Node and browser receipt digests;
- all three toolchain admission record digests.

- [ ] **Step 4: Run focused readiness and atomic-publication tests**

Run:

~~~bash
scripts/dev-shell.sh npx tsx --test \
  scripts/abi-staging-pages-readiness.test.ts \
  scripts/abi-staging-pages-producer.test.ts
scripts/dev-shell.sh bash scripts/test-abi-staging-pages-atomic.sh
scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
scripts/dev-shell.sh bash scripts/ci-check-pages-deployment.sh
~~~

Expected: a missing input or receipt retains the previous complete site; a complete input set produces the exact seven-product site.

- [ ] **Step 5: Document the user contract**

Update `docs/browser-support.md` and `README.md` with:

- `cc`, `c++`, and `wasm32posix-*` are available from the ordinary shell;
- ordinary boot does not download the compiler;
- first use downloads digest-verified, ABI-qualified admitted Homebrew trees from GHCR;
- the C-development gallery entry uses the same shell and starts the same closure in the background;
- progress and failure are visible, Retry reuses the same immutable descriptor, and a failure leaves the shell usable;
- the prepared example lives at `/home/user/c/hello.c`;
- there is no cross-session offline compiler cache in this release;
- compile-heavy work requires browser memory headroom;
- C/C++ is the initial scope;
- generated fork-family programs remain limited until an in-guest fork instrumenter ships.

Do not document LLVM source builds inside Kandelo or an arbitrary in-guest Homebrew installer.

- [ ] **Step 6: Switch the integrated flow to observe mode**

Change `abi/staging/pages-activation.toml` to exactly:

~~~toml
schema = 1
kind = "kandelo-pages-activation"
mode = "observe"
~~~

Observe mode must build, validate, and retain the successor complete site without moving the public selection. Run:

~~~bash
scripts/dev-shell.sh bash scripts/test-abi-staging-pages-atomic.sh
git diff --check
~~~

Expected: the activation parser accepts observe mode, ready output is inert, and held output does not alter the prior site.

- [ ] **Step 7: Run every required repository verification suite**

Run:

~~~bash
scripts/dev-shell.sh cargo test \
  -p wasm-posix-kernel --target aarch64-apple-darwin --lib
scripts/dev-shell.sh bash -euo pipefail -c '
cd host
npx vitest run
'
scripts/dev-shell.sh bash scripts/run-libc-tests.sh
scripts/dev-shell.sh bash scripts/run-posix-tests.sh
scripts/dev-shell.sh bash scripts/check-abi-version.sh
scripts/dev-shell.sh bash scripts/test-abi-staging-product-evidence.sh
scripts/dev-shell.sh bash scripts/test-abi-staging-pages-atomic.sh
scripts/dev-shell.sh bash -euo pipefail -c '
cd apps/browser-demos
npx playwright test \
  test/abi-staging-product-evidence.spec.ts \
  test/kandelo-c-development.spec.ts \
  test/kandelo-homebrew-main-shell.spec.ts \
  --project=chromium
'
~~~

Expected:

- Cargo reports at least 539 passing tests and zero failures.
- Vitest reports every test file passing; PHP skips are acceptable only when its binary is not built.
- libc-test reports zero unexpected `FAIL`; `XFAIL` and `TIME` are acceptable.
- Open POSIX reports zero `FAIL`; `UNRES` and `SKIP` are acceptable.
- ABI snapshot check exits 0.
- Product evidence, Pages atomicity, and the three browser specs pass.

- [ ] **Step 8: Manually verify the browser**

Run:

~~~bash
scripts/dev-shell.sh ./run.sh browser
~~~

In a fresh browser storage context:

1. open Bare shell and confirm the prompt appears with no toolchain request;
2. compile and execute one C and one C++ program; observe package names, bytes, and progress;
3. repeat both builds and confirm no second payload fetch;
4. launch C development; confirm the terminal accepts input while prefetch is active;
5. compile `/home/user/c/hello.c`;
6. simulate an offline or blocked toolchain fetch, confirm the shell remains usable, restore connectivity, and use Retry;
7. inspect the Lazy Load pane for one failed then one complete immutable asset identity.

Record compressed bytes per admitted tree and first-compile/prefetch elapsed times as diagnostics only. Do not describe them as performance improvements.

- [ ] **Step 9: Commit observe-mode rollout and docs**

~~~bash
git add scripts/abi-staging-pages-readiness.test.ts \
  scripts/abi-staging-pages-readiness.ts \
  scripts/abi-staging-pages-producer.ts \
  scripts/abi-staging-pages-producer.test.ts \
  abi/staging/pages-activation.toml \
  docs/browser-support.md README.md
git commit -m "pages: observe lazy C development rollout"
~~~

## Task 6: Activate only the reviewed ready successor

**Files:**

- Modify: `abi/staging/pages-activation.toml`

**Interfaces:**

- Consumes: a successful observe-mode canary for the exact merged main commit and exact current tap main tree.
- Produces: atomic selection of that complete site; no product or payload changes.

- [ ] **Step 1: Merge the observe-mode integration and wait for its exact canary**

After Tasks 1–5 are reviewed and merged, record:

~~~bash
git fetch origin main
main_commit=$(git rev-parse origin/main)
main_tree=$(git rev-parse 'origin/main^{tree}')
printf '%s %s\n' "$main_commit" "$main_tree"
~~~

Use the protected canary run triggered by that exact `main_commit`. Do not use a PR run, manually altered artifact, older successful run, or local build as the activation gate.

- [ ] **Step 2: Review the canary's closed identities**

Download the inert canary artifact and require:

- `readiness.json` has `ready: true` and no blockers;
- source commit/tree equal `main_commit` and `main_tree`;
- tap commit/tree equal current protected tap main;
- target ABI and snapshot digest equal the source tree;
- product list and deployment manifest contain the exact seven IDs and eager/lazy policies from Global Constraints;
- `browser-main-shell` binds successful current Node and both browser toolchain receipts;
- `kandelo-sdk`, `clang`, and `libcxx` references are canonical anonymous GHCR references with matching admission digests;
- the Pages file inventory has no compiler/SDK bottle payload and remains below 1,000,000,000 bytes;
- the artifact contains no `-candidates/` reference, mutable tag, symlink, special file, or unlisted file.

If any check fails, leave activation in `observe` and let the prior complete site remain selected.

- [ ] **Step 3: Create the activation-only change**

From the reviewed `origin/main`, create a new clean branch and change only `abi/staging/pages-activation.toml`:

~~~toml
schema = 1
kind = "kandelo-pages-activation"
mode = "active"
~~~

Confirm:

~~~bash
git diff --name-only
git diff --check
~~~

Expected: the only changed path is `abi/staging/pages-activation.toml`.

- [ ] **Step 4: Verify activation semantics**

Run:

~~~bash
scripts/dev-shell.sh bash scripts/test-abi-staging-pages-atomic.sh
scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
scripts/dev-shell.sh bash scripts/ci-check-pages-deployment.sh
~~~

Expected: active mode selects a ready successor atomically; held readiness leaves the previous selection unchanged.

- [ ] **Step 5: Commit and review the activation**

~~~bash
git add abi/staging/pages-activation.toml
git commit -m "pages: activate admitted product site"
~~~

Require review to compare the activation commit's parent to the exact successful canary source identity. Do not combine dependency, product, gallery, evidence, documentation, or workflow edits into this commit.

- [ ] **Step 6: Verify the public site after deployment**

In a clean browser storage context on the public Pages URL:

- confirm the deployment manifest matches the activated canary;
- confirm the gallery exposes C development but the product registry still has seven products;
- confirm Bare shell boots without compiler traffic;
- compile/execute C and C++ from Bare shell;
- launch C development and compile the prepared example;
- confirm compiler/SDK requests go to the admitted GHCR-backed immutable transport and not a Pages compiler asset;
- confirm a repeat build reuses the materialized trees.

If deployment readiness is held or the deployment does not match the reviewed manifest, do not patch the public tree manually. Leave or restore the previous complete-site selection through the staging system's recoverable activation mechanism.

## Completion Checklist

- `browser-main-shell` is still the sole shell product and the Pages registry still has exactly seven products.
- Bare shell performs zero toolchain payload reads before first use.
- Bare shell compiles, links, and executes protected C and C++ in Node and browser hosts.
- C development uses the same shell image and exact admitted closure, prepares `hello.c`, and starts prefetch only after the terminal is running.
- Generic progress exposes package/byte state and generic Retry; no browser code names compiler URLs or dependency paths.
- Missing, truncated, and digest-mismatched payloads remain unmaterialized and leave the shell usable.
- Repeat compilation causes no second materialization in the session.
- Pages readiness holds on any missing admission or required receipt and retains the previous complete site.
- The ready Pages tree contains the browser app plus compact product VFS files, not compiler/SDK bottles.
- Observe-mode canary precedes the separate activation-only commit.
- Documentation states C/C++ scope, first-use network behavior, memory/cache expectations, and the fork-instrumentation limitation.
- Every required AGENTS.md verification suite and manual browser check has passed before anyone claims the branch complete.
