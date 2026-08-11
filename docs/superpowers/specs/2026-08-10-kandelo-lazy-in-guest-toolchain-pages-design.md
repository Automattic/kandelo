# Lazy In-Guest Toolchain on Kandelo Pages

**Date:** 2026-08-10

**Status:** Approved design

**Prototype snapshot:** `602d179e0` (`wip: snapshot in-Kandelo compiler prototype`)

## Summary

Kandelo will make its C/C++ toolchain available from the ordinary browser
shell without adding the compiler payload to the initial shell download. The
canonical `browser-main-shell` product will declare a lazy Homebrew
`kandelo-sdk` dependency whose same-tap closure supplies the SDK, Clang, LLD,
LLVM utilities, and target development files. The default shell will fetch
those exact admitted bottle trees only when a tool is first used.

The gallery will retain a **C development** preset, but that preset will use
the same `browser-main-shell` product rather than a separate compiler image.
It will prefetch the same lazy closure with visible progress, prepare a sample
working directory, and set convenience environment variables. There will be
one shell product, one toolchain identity, and two ways to enter it.

This design targets the Homebrew ABI-staging and atomic Pages architecture
being developed on `emdash/homebrew-pr-staging-1q1w6`. Formula work may
proceed independently, and integration may use a clean branch stacked on a
stable staging revision. Public activation must wait for staging to land. The
feature must not extend the legacy Pages publisher or preserve the prototype's
browser-specific VFS merge path.

## Context

At design time:

- `origin/main` was `8c19f577dcb2ef23855e4f5015847674fdd0d2b9`.
- The remote ref named `emdash/homebrew-pr-staging-1q1w6` still pointed at
  `origin/main`, while its active local worktree was at
  `a0bb933056789642c093836cd38a37e1a4d7b60c`, 55 commits ahead.
- During implementation-plan review that active worktree advanced to
  `81c48a9122a44326f4815d74125e0cdda884863d`, 66 commits ahead. The later
  audit was read-only; the worktree remained dirty and user-owned.
- That staging work defines canonical VFS product manifests, candidate and
  canonical Homebrew namespaces, admission records, exact product evidence,
  a Pages-owned product registry, and last-complete-site atomic deployment.
- Pages activation in that work remained in legacy mode. This feature must
  wait for the staging activation gate rather than bypass it.
- The current main Pages workflow failed while preparing an unsealed Homebrew
  selection. Adding another legacy asset path would deepen the obsolete
  coupling rather than solve it.
- GitHub Pages limits a published site to 1 GB and has a soft 100 GB monthly
  bandwidth limit. GitHub Release assets may each be under 2 GiB and have no
  total release-size or bandwidth limit. The staging design's canonical GHCR
  bottle transport is a better home for the compiler payload than the Pages
  tree or an additional Release-hosted monolithic VFS.

The prototype proves that a Kandelo-hosted Clang can compile and link a small
program. Its current browser path loads the shell VFS, overlays a 3.5 MB SDK
VFS, and stages approximately 73 MB of raw compiler and linker Wasm files at
runtime. That is useful validation, but it bypasses product authority,
Homebrew admission, canonical lazy references, and product evidence.

## Goals

1. Make `cc`, `c++`, and the `wasm32posix-*` SDK commands usable from the
   default Kandelo shell.
2. Preserve the default shell's startup behavior: it must not request compiler
   or SDK payload bytes during ordinary boot.
3. Provide a discoverable C-development gallery entry with explicit download
   progress and a ready-to-run example.
4. Use admitted, immutable, ABI-qualified Homebrew assets for every lazy
   toolchain component.
5. Keep compiler flags and filesystem paths under SDK/package ownership, not
   browser-host special cases.
6. Prove real in-guest compile, link, and execution on both Node.js and browser
   hosts.
7. Preserve atomic Pages behavior: Kandelo must never publish a shell that
   advertises a toolchain whose selected payloads or evidence are incomplete.

## Non-goals

- Building LLVM or similarly large projects inside Kandelo.
- Supporting fork-capable generated programs before `wasm-fork-instrument`
  is available in-guest.
- Persisting the fetched compiler across browser sessions in the first
  delivery.
- Restoring arbitrary in-guest Homebrew installation or allowing users to
  select mutable toolchain versions.
- Creating a second `browser-c-development` VFS product.
- Publishing a parallel monolithic `compiler.vfs.zst` release artifact.
- Replacing or weakening the staging branch's admission, evidence, or Pages
  activation model.

## Alternatives Considered

### Separate C-development product

A dedicated product would isolate compiler failures and permit an independent
release cadence. It would also duplicate shell and SDK content, consume more
Pages inventory, require a profile switch or reboot, and create two subtly
different shell environments. It is not selected.

### Compiler in the default shell without a preset

This is the smallest product and UI surface. It gives poor discoverability,
makes the first large download surprising, and provides no natural place to
explain memory and first-use behavior. It is not selected.

### Hybrid: one shell product plus a C-development preset

This is selected. The compiler is reachable from the default shell through
lazy filesystem entries. The gallery preset uses the same image and exact
payloads but makes the development workflow discoverable and may prefetch
them in the background, with progress, after presenting a usable terminal and
the prepared example.

## Product Architecture

`browser-main-shell` remains the sole canonical Pages product for both shell
entry points. Its product manifest selects `kandelo-sdk` as lazy Homebrew
software. The formula's same-tap dependency closure selects the compatible
compiler and runtime components.

The phrase **lazy VFS reference** in this design means a Homebrew
bottle-backed lazy filesystem tree carried by the staging system's immutable
input references. It does not mean a lazily overlaid Pages product image.
The current staging contract requires canonical Pages product-image inputs to
be embedded, while Homebrew bottle inputs explicitly support lazy-reference
materialization.

The resulting ownership boundaries are:

| Owner | Responsibility |
|---|---|
| Homebrew tap | Formula source, dependency closure, build recipe, stable installation paths, licenses, and bottle metadata |
| ABI staging | Candidate builds, exact-head evidence, promotion, admission, canonical references, and anonymous readback |
| `browser-main-shell` product | Selection of the lazy SDK closure, boot contract, and exact final VFS metadata |
| SDK wrappers | Compiler/linker flags, target paths, glue selection, and user-facing command behavior |
| Browser gallery | Entry-point presentation, preset-triggered prefetch, progress, sample setup, and convenience environment |
| Pages readiness | Canonical recomposition, Node/browser evidence, complete-site inventory, and atomic activation |

No browser module may know individual compiler binary URLs, copy compiler
files into the VFS, or merge a second SDK image during boot.

Each authenticated Homebrew composition descriptor carries the Formula's
direct same-tap, same-architecture dependency identities. The product builder
seals those edges beside the package keg paths in
`/etc/kandelo/homebrew-vfs.json`. The generic prefetch API therefore accepts
only the `kandelo-sdk` root and derives the dependency-first closure from guest
authority; neither the gallery nor either host keeps a second compiler
dependency list.

## Package Boundaries

### `clang` formula

The `clang` formula installs:

- `clang` and `clang++`;
- `wasm-ld`;
- `llvm-ar`, `llvm-ranlib`, and `llvm-nm`;
- the matching Clang resource headers;
- a dependency on the same-tap `libcxx` runtime needed to execute these tools;
  and
- LLVM license notices.

All executables are Kandelo programs for the selected ABI. The formula is
published through the same-tap ABI-qualified bottle flow. The build remains a
cross-build using matching host table-generation tools, but host build tools
do not become runtime inputs.

### `kandelo-sdk` formula

The `kandelo-sdk` formula installs:

- stable `wasm32posix-*` driver commands and conventional aliases in its
  Formula-owned `bin`, projected by the shell link manifest under `/usr/bin`;
- the target sysroot under its Formula-owned `libexec/wasm32posix`, with the
  shell providing the `/usr/wasm32posix` compatibility projection;
- syscall glue sources and precompiled glue objects;
- `config.site` and package-configuration support;
- small examples and SDK documentation; and
- Kandelo, musl, and other required notices.

It declares same-tap dependencies on `clang` and `libcxx`. ABI staging binds
the exact compatible formula revisions and bottle identities; mutable Formula
metadata is not a runtime selector. `libcxx` remains the owner of target C++
headers and archives rather than duplicating them inside the SDK bottle. The
SDK wrappers carry sensible defaults for LLVM, sysroot, resource, libc++, and
glue paths. The ordinary shell does not require developer-only environment
variables for `cc hello.c -o hello.wasm` to work.

The product manifest selects `kandelo-sdk` rather than enumerating browser
URLs or copying the current project-registry package into the page. The
Homebrew dependency closure remains the authority for the compiler pieces.

The existing `developer-kandelo-sdk` product remains a useful non-Pages SDK
artifact, but it must not become a second packaging authority. After formula
adoption, it becomes a projection of the admitted SDK formula inputs or enters
the staging retirement inventory. Its protected-host compilation evidence may
remain supplementary; it cannot satisfy this feature's in-guest compiler gate.

## Default Shell Behavior

The default shell keeps its existing image, prompt, and boot command. Its VFS
contains immutable lazy metadata for the SDK/toolchain closure but not the
payload bytes.

An ordinary boot must not fetch any SDK or compiler bottle payload. Lazy
metadata and existing shell assets are the only permitted toolchain-related
startup cost.

When a user runs:

```sh
cc hello.c -o hello.wasm
./hello.wasm
```

the data flow is:

1. Opening the SDK wrapper causes the verified SDK tree to be fetched.
2. The wrapper resolves its packaged defaults and invokes `clang`.
3. Opening `clang` causes the verified compiler tree to be fetched.
4. The compiler reads the target sysroot, resource headers, and glue through
   ordinary VFS paths.
5. Object files and the final program are written into the shell's writable
   filesystem.
6. Executing the result follows the normal Kandelo program path.

Each lazy tree materializes at most once during that session. Cross-session
offline persistence is not part of this release.

## C-Development Preset

The **C development** gallery entry is a preset over
`browser-main-shell`, not a separate product. It selects the same kernel,
shell VFS, package identities, and filesystem paths as the ordinary shell.

The preset:

- requests the SDK dependency closure through a generic lazy-package
  activation interface;
- displays existing generic package name, byte, progress, and failure data;
- keeps the terminal usable while prefetch runs and marks developer tooling
  ready only after successful verification;
- prepares a small `hello.c` working example;
- sets convenience values including `CC`, `CXX`, and `MAKEFLAGS=-j1`; and
- explains that fork-family behavior in generated programs is not yet
  supported without an in-guest fork instrumenter.

If prefetch fails, the terminal remains usable. The user can retry or continue
with the ordinary shell. The preset must not install partial bytes or fall
back to a different toolchain.

The preset may alter presentation and session environment only. It may not
stage binaries, merge VFS images, or define a second set of compiler flags.

## Publication Flow

Formula productionization may proceed alongside staging. Kandelo integration
must use a clean branch based on a stable staging revision, not write into the
active dirty staging worktree. Public Pages activation begins only after the
Homebrew staging foundation is merged and its activation prerequisites are
satisfied. No phase patches the legacy `browser-demos-pages.yml`
asset-selection path.

The coordinated delivery flow is:

1. Add the `clang` and `kandelo-sdk` Formula changes to the tap. In the exact
   Kandelo request head, update `browser-main-shell` to select the lazy SDK root
   and register the protected Node/browser toolchain suites.
2. Build candidate bottles without publication credentials.
3. Publish candidate layers to the candidate namespace, prove anonymous
   readback, and run the per-Formula structure/pour/Node checks.
4. Compose the exact candidate `browser-main-shell` from those layers and run
   real in-guest Node and Chromium product evidence.
5. Use only successful, non-overridden product evidence that binds all three
   exact layers to authorize `runtime_support = ["node", "browser"]` and
   `browser_compatible = true`; then promote the unchanged bottles into the
   ABI-qualified canonical GHCR namespace and publish admission records.
6. Let Pages readiness authenticate every selected admission and canonical
   composition descriptor, replace candidate references with their admitted
   GHCR identities, recompose the shell, rerun Node and browser product
   evidence, and produce the exact Pages site inventory. No legacy
   closed-selection or bottle-mirror release participates in this path.
7. Activate the new complete site atomically. If any required input or
   evidence is missing, retain the previous complete site.

GitHub Pages therefore carries the browser application and compact shell VFS.
GHCR carries the compiler and SDK bottle payloads. PR prereleases may retain
requests, reports, and evidence as required by staging, but there is no second
compiler distribution path.

## Error and Integrity Model

### Before publication

- Missing, failed, or unpromoted compiler/SDK inputs produce a Pages readiness
  blocker.
- Candidate references are forbidden from the canonical Pages result.
- A compiler or SDK evidence failure holds the whole site revision because
  the default shell advertises these commands.
- The last selected complete site remains live.
- There is no fallback to an older ABI, older compiler, mutable tag, or
  credentialed-only locator.

### At runtime

- Every lazy descriptor binds an immutable reference, byte count, and digest.
- Payload bytes are verified before they become executable or readable through
  their final tree.
- A truncated, missing, or digest-mismatched payload remains unmaterialized.
- The generic download surface identifies the failing package and permits an
  explicit retry.
- A failed `cc` invocation returns a clear error while the existing shell
  remains alive and usable.
- Partially downloaded content is never installed into the writable VFS.

## Evidence and Acceptance

### Formula evidence

- Verify the bottle manifests, licenses, installation paths, dependency
  closure, and anonymous canonical readback.
- Run `clang --version`, `wasm-ld --version`, and the LLVM utility version
  commands as Kandelo programs.
- Prove that build-host table-generation tools are not included in the runtime
  closure.
- Do not infer browser compatibility from a browser-labelled job alone. The
  current staging `public-candidate-browser` job does not configure the inputs
  used by its exact-candidate Playwright cases, so those cases skip. It may not
  authorize a browser metadata claim.
- Bind the public runtime fields and their exact product-evidence/definition
  digests into the Formula metadata update and admission. An override may
  accept a risk for promotion but may not manufacture runtime support.

### Node product evidence

Boot the exact candidate `browser-main-shell` before promotion, then repeat the
proof against the canonical product before Pages activation:

1. no SDK/compiler payload is read during shell startup;
2. `cc` triggers the bound lazy inputs;
3. a protected tiny C source compiles and links in-guest;
4. the generated program executes and prints the protected output; and
5. a tiny C++ source compiles, links against the target libc++, and executes.

The existing `developer-kandelo-sdk` evidence, which compiles with a protected
host compiler, is not sufficient for this feature. The new evidence must run
the compiler executable inside Kandelo.

### Browser product evidence

Chromium evidence proves both entry points:

- ordinary shell boot issues no compiler/SDK payload request;
- running `cc` causes the expected immutable lazy requests and a successful
  compile-and-run;
- selecting C development prefetches those same identities with visible
  progress, then completes the same compile-and-run;
- repeated use within the session does not refetch or reinstall the trees;
  and
- missing, truncated, and digest-mismatched payloads leave the terminal alive
  and do not expose partial content.

### Pages evidence

- Missing compiler admission, missing SDK admission, and failed Node/browser
  evidence each hold readiness.
- A held revision cannot replace the current-site selection.
- A complete revision includes the exact shell VFS identity and every bound
  runtime-evidence receipt.
- The published Pages inventory remains below the repository's guarded size
  limit; lazy GHCR payload bytes are not copied into that inventory.

### Repository verification

Before claiming the implementation complete, run every suite required by
`AGENTS.md`:

```sh
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

Because this is browser-facing behavior, also run `./run.sh browser` and
manually verify default-shell lazy first use, C-development prefetch, compile,
link, and execution. Node and browser implementations require parallel test
coverage.

If any retained prototype change touches `libc/musl-overlay/` or
`libc/glue/channel_syscall.c`, rebuild musl first through
`scripts/dev-shell.sh`. Any ABI-affecting source change follows the repository
ABI snapshot and version-bump policy.

Record compressed payload sizes and first-compile timing for Node and browser
as diagnostic evidence. The first release does not establish an arbitrary
performance threshold, but ordinary shell startup must remain free of
toolchain payload requests. If implementation work turns into performance
tuning or makes performance claims, run all five benchmark suites on both
Node.js and browser hosts as required by `AGENTS.md`.

## Prototype Migration

The snapshot is evidence and a source reservoir, not the merge shape.

Retain or adapt after rebasing onto the post-staging base:

- the LLVM cross-build knowledge and matching host table-generation stage;
- validated Kandelo-specific compiler patches;
- SDK wrapper behavior and target flag knowledge;
- required sysroot/header fixes;
- the tiny compile-and-run fixtures; and
- independently justified kernel or filesystem correctness fixes.

Replace:

- direct browser imports of individual compiler Wasm files;
- `loadCompilerAssets`, runtime VFS overlay, and compiler staging code;
- a browser-only `c-dev` VFS/memory special case;
- project-registry publication as the final compiler transport; and
- locally generated or checked-in LLVM build trees and glue objects.

Every kernel, libc, or VFS correctness change from the prototype must be
reviewed and tested independently against current main. Such fixes should land
as focused prerequisites when still needed, not hitchhike unnoticed inside
toolchain packaging.

## Rollout Boundaries

Implementation is one coordinated design but should land through ordered,
reviewable changes:

1. **Prerequisite correctness:** independently validate and upstream only the
   kernel/libc fixes still required on the post-staging base.
2. **Tap toolchain:** productionize `clang` and `kandelo-sdk` formulae and pass
   candidate/admission evidence.
3. **Shell integration:** select the lazy SDK closure and add in-guest Node
   evidence without changing the default boot fetch set.
4. **Browser experience:** add the shared-product C-development preset,
   browser evidence, progress, and failure coverage.
5. **Pages activation:** prove held and successful atomic revisions, then
   deploy only through the staging activation gate.

Each change must preserve a reviewable answer to "what does this look like on
the other host?" The final user-visible feature is documented only after both
hosts and the Pages publication path are complete.

## Documentation

The implementation updates:

- `docs/sdk-guide.md` for in-guest compiler commands, paths, flags, and current
  limitations;
- `docs/browser-support.md` for lazy first-use behavior, network requirements,
  memory expectations, and the C-development preset;
- `docs/package-management.md` for the SDK/compiler formula ownership and lazy
  product selection;
- `docs/binary-releases.md` for canonical admission, composition-descriptor,
  and bottle-readback contracts;
  and
- `README.md` when the public C-development capability is activated.

## References

- GitHub Pages limits:
  <https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits>
- GitHub Release asset limits:
  <https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases>
- Prototype implementation plan:
  `docs/plans/2026-05-21-in-kandelo-clang-sdk-plan.md`
- Staging design, currently on the staging worktree:
  `docs/superpowers/specs/2026-08-08-abi-bottle-staging-design.md`
