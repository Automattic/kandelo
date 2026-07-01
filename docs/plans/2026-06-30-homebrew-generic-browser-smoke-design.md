# Generic Homebrew Browser Smoke Design

Date: 2026-06-30

Tracked work:

- `kd-1mr` - Port all current Kandelo packages to Homebrew.
- `kd-1mr.2` - Port sqlite, bzip2, and xz Homebrew pilot.
- `kd-1mr.2.1` - Add generic browser smoke for non-hello Homebrew packages.
- Parent implementation evidence: `kd-1mr.2` implementation commit
  `440ac7e5e8876b54345682f23dde271889682c40` added the sqlite, bzip2,
  and xz pilot Formulae, generic Node smoke, non-hello link manifests, and
  sidecar browser-smoke status fields.

This is a design artifact. It does not implement the browser harness, change
sidecar schemas, publish Homebrew bottles, or mark any non-hello package as
browser-compatible.

## Problem Statement

The Homebrew pilot can now build and smoke sqlite, bzip2, and xz through the
Node Homebrew VFS path, but browser compatibility is still effectively
hardcoded to the original `hello` smoke. That leaves generated sidecars with
truthful `browser_smoke` skips for non-hello packages, but no reusable way to
turn package-specific browser evidence into:

- a browser-compatible sidecar claim for wasm32 packages that actually boot
  and run in the browser host;
- a failed or skipped browser-smoke outcome when the browser host, VFS image,
  package command, or validation consumer does not work;
- durable passed, failed, and skipped browser outcome-list artifacts with
  reasons.

The new path must prove browser behavior through the normal browser product
surface: a precomposed Homebrew-derived VFS image, the Kandelo browser app,
the browser kernel host, a real terminal or runtime process, and package
commands that run from the poured Homebrew prefix.

## Non-Goals

- Do not add package-specific browser demo branches for sqlite, bzip2, or xz.
- Do not mark browser support from Node smoke, bottle build success, or VFS
  image construction alone.
- Do not require guest `brew install`; the supported path is still
  precomposed VFS images built from sidecars and verified bottle bytes.
- Do not weaken ABI, cache-key, bottle sha, byte-count, link-manifest, or
  receipt validation to get a browser image to boot.
- Do not make full SQLite upstream project tests part of this browser smoke.
  The browser smoke only proves the package-specific consumer case.
- Do not make wasm64 browser compatibility claims. The existing sidecar
  wrapper only permits browser success for wasm32, and the gallery path is
  wasm32-only.

## Users And Operator Workflows

### Package Porter

The porter runs one command against a generated or trusted tap root and gets
per-formula browser status:

```bash
npx tsx scripts/homebrew-package-browser-smoke.ts \
  --tap-root /path/to/kandelo-homebrew \
  --formula sqlite \
  --formula bzip2 \
  --formula xz \
  --arch wasm32 \
  --result-dir test-runs/homebrew-package-browser-smoke
```

The command builds candidate Homebrew VFS images, launches the browser app,
runs package-specific checks, and writes summary plus outcome-list artifacts.

### Trusted Publisher

The trusted workflow uses the browser-smoke summary to decide whether the
final sidecars may record:

- `runtime_support = ["node", "browser"]` and
  `browser_compatible = true`, when the wasm32 browser smoke passes; or
- `runtime_support = ["node"]`, `browser_compatible = false`, and a failed or
  skipped `browser_smoke` outcome with artifact paths and reasons.

Browser gallery assets are generated only after final metadata records wasm32
success and `browser_compatible = true`.

### Maintainer Reviewer

The reviewer checks that the browser outcome is evidence-backed, not inferred.
They should be able to inspect the command, browser URL, terminal output,
VFS build report, screenshot or trace, and passed/failed/skipped TSV files for
each package.

### Debugger

The debugger needs failures to identify the layer: sidecar planning, bottle
fetch, VFS build, SQLite consumer compilation, Vite startup, browser app boot,
cross-origin isolation, terminal readiness, package command exit, output
matching, or sidecar finalization.

## Current State

The parent Homebrew pilot commit contains these relevant surfaces:

- `scripts/homebrew-package-node-smoke.ts` materializes Homebrew sidecars into
  VFS images and runs package-specific Node smokes. It writes `summary.json`,
  `summary.md`, `failures.json`, `current-run.json`, and
  `outcome-lists/{passed,failed,skipped}-tests.tsv`.
- `images/vfs/scripts/build-homebrew-vfs-image.ts` builds precomposed VFS
  images from Homebrew sidecars and verified bottle bytes.
- `apps/browser-demos/test/kandelo-homebrew.spec.ts` has the trusted `hello`
  browser smoke. It boots the browser app with `?vfs=<image-url>`, waits for
  the terminal prompt, types `/home/linuxbrew/.linuxbrew/bin/hello --version`,
  and checks terminal output.
- `scripts/homebrew-generate-sidecars-from-env.sh` can record browser smoke
  as `success`, `failed`, or `skipped` through environment variables. Success
  requires VFS image, VFS report, browser URL, and browser command evidence.
- `homebrew/kandelo-homebrew/Kandelo/provenance.schema.json` already supports
  a `browser_smoke` outcome list with `passed`, `failed`, `skipped`, and
  `skip_reason` strings. No schema change is required to record package-level
  browser case names and artifact paths as strings.

The child bead worktree created for this design was based on convoy commit
`f4339836e8c9c4b1fc2de7f4d931856c51a74432`, which does not contain the parent
Homebrew pilot files. Implementation for `kd-1mr.2.1` should either stack on
`440ac7e5e8876b54345682f23dde271889682c40` or wait until that parent work is
merged before editing the harness.

## Architecture

Add a reusable TypeScript browser smoke runner:

```text
scripts/homebrew-package-browser-smoke.ts
```

The runner should mirror the Node smoke runner's contract:

```text
tap root + formula list + arch
      |
      v
read Kandelo/metadata.json
      |
      v
plan and build candidate Homebrew VFS images
  - verify ABI, cache key when supplied, bottle sha, bottle bytes
  - load link manifests
  - do not require browser_compatible=true before the smoke runs
      |
      v
optionally inject validation-only smoke artifacts
  - sqlite_basic.wasm for sqlite
      |
      v
save one browser candidate image per formula
      |
      v
serve image through Vite/browser app
      |
      v
run package-specific terminal commands
      |
      v
write browser summary and outcome-list artifacts
      |
      v
final sidecar generation consumes summary
```

The important detail is the planning mode. Before a package has browser
evidence, its sidecar must not yet say `browser_compatible = true`. The smoke
runner therefore must not call `planHomebrewVfs()` with `runtime: "browser"`
for candidate images. It should omit the runtime filter, or use the existing
Node-compatible success metadata, then treat the browser run as the evidence
that may update final sidecars. The stricter `runtime: "browser"` check is
appropriate after final metadata is generated, especially for gallery asset
creation.

## Package Smoke Cases

Keep package behavior in a small shared case registry, for example:

```text
scripts/homebrew-package-smoke-cases.ts
```

The Node and browser runners do not need identical mechanics, but they should
share the same package intent: command, expected output, minimum success
threshold, and unsupported reasons.

### Bzip2

Required browser case:

```bash
/home/linuxbrew/.linuxbrew/bin/bzip2 --help
```

Expected output should match `/bzip2/i` in terminal text. `--help` is a good
first check because the parent Node smoke used it to avoid `bzip2` writing
compressed bytes to a terminal.

Preferred stronger case:

```bash
cd /tmp &&
printf 'kandelo bzip2 browser smoke\n' > bzip2.in &&
/home/linuxbrew/.linuxbrew/bin/bzip2 -k bzip2.in &&
/home/linuxbrew/.linuxbrew/bin/bzip2 -dc bzip2.in.bz2
```

Expected output is the original text. This avoids writing compressed bytes to
the PTY. If this round trip is flaky because of shell or file semantics, the
harness should mark that specific case skipped with a reason, not convert the
package to browser-compatible on a hidden workaround.

### Xz

Required browser case:

```bash
/home/linuxbrew/.linuxbrew/bin/xz --version
```

Expected output should match `/xz/i`.

Preferred stronger case:

```bash
cd /tmp &&
printf 'kandelo xz browser smoke\n' > xz.in &&
/home/linuxbrew/.linuxbrew/bin/xz -k xz.in &&
/home/linuxbrew/.linuxbrew/bin/xz -dc xz.in.xz
```

Expected output is the original text. As with bzip2, round-trip inability is a
case result, not a reason to fake success.

### SQLite

SQLite is a library package, so the browser smoke must run a test-only
consumer. Reuse the parent Node smoke's idea:

1. Extract `include/sqlite3.h`, `include/sqlite3ext.h`, and
   `lib/libsqlite3.a` from the poured keg in the candidate VFS.
2. Compile `packages/registry/sqlite/test/sqlite_basic.c` with the
   worktree-local SDK into `sqlite_basic.wasm`.
3. Inject the validation-only Wasm into the candidate browser VFS at a path
   such as `/usr/local/kandelo-smoke/bin/sqlite_basic`.
4. Boot the image in the browser and run:

```bash
/usr/local/kandelo-smoke/bin/sqlite_basic
```

Browser compatibility for sqlite requires the consumer to exit 0 and print
the existing `PASS` marker. A library bottle that builds, pours, or links is
not sufficient by itself.

If consumer compilation is unavailable in a particular environment, record
`browser_smoke` as skipped with the compile blocker and artifact path. Do not
mark sqlite as browser-compatible.

## Harness Behavior

The browser runner should:

- accept `--tap-root`, repeated `--formula`, `--arch`, `--result-dir`,
  `--bottle-cache`, `--timeout-ms`, `--max-bytes`, and `--bead-id`;
- reject or skip `--arch wasm64` for browser compatibility with a clear
  reason;
- create one result subdirectory per formula and arch;
- build a candidate VFS image with Homebrew VFS metadata preserved in image
  metadata;
- use a deterministic static fixture path under
  `apps/browser-demos/public/__kandelo-homebrew-smoke/<run-id>/` or a local
  static server so `?vfs=<url>` can fetch the image;
- start Vite with `KANDELO_BROWSER_TEST_NO_HMR=1`;
- launch Chromium with SharedArrayBuffer support, matching the existing
  browser smoke baseline;
- navigate to `/?vfs=<encoded image URL>`;
- wait for the terminal prompt rather than sleeping blindly;
- type a package command wrapped with a unique pass/fail sentinel;
- collect terminal text, console warnings/errors, page errors, request
  failures, screenshots, and Playwright trace or video when available;
- write `current-run.json` during execution so interrupted runs are
  diagnosable;
- always write passed, failed, and skipped outcome lists, even when one list is
  empty.

The existing app-level `LiveKernelHost.runShellCommand()` and
`/etc/kandelo/demo.json` `autoCommand` path are useful references, but the
first implementation should keep command execution in the harness. That avoids
creating product-visible auto-run metadata solely for tests. If terminal
driving proves too flaky, a later refinement can add smoke-only demo metadata
to the generated VFS image and still boot through the normal app path.

## Sidecar Finalization

Avoid a circular metadata dependency by splitting candidate sidecars from
final sidecars:

1. Generate candidate sidecars after bottle build with browser smoke skipped
   or absent. These sidecars are enough to materialize a candidate VFS image.
2. Run Node and browser smokes against the candidate sidecars.
3. Regenerate final sidecars with Node and browser summary inputs.
4. Publish final sidecars, provenance, and release assets.

Extend `scripts/homebrew-generate-sidecars-from-env.sh` to accept an optional
browser summary path:

```text
KANDELO_HOMEBREW_BROWSER_SMOKE_SUMMARY=/path/to/summary.json
```

When present, the wrapper should populate the provenance `browser_smoke`
outcome from the summary:

- `status = success` only when all required package browser cases pass;
- `status = failed` when any required case fails;
- `status = skipped` when the package is unsupported for browser smoke or a
  prerequisite is missing;
- `passed`, `failed`, and `skipped` arrays contain concrete case names,
  reasons, and artifact paths as strings.

The existing environment variables remain valid for manual or transitional
use:

```text
KANDELO_HOMEBREW_BROWSER_SMOKE_STATUS
KANDELO_HOMEBREW_BROWSER_SMOKE_REASON
KANDELO_HOMEBREW_VFS_IMAGE
KANDELO_HOMEBREW_VFS_REPORT
KANDELO_HOMEBREW_BROWSER_SMOKE_URL
KANDELO_HOMEBREW_BROWSER_SMOKE_COMMAND
KANDELO_HOMEBREW_GALLERY_ROOT
```

Final metadata rules:

- `browser_compatible = true` only for wasm32 packages with successful
  browser smoke.
- `runtime_support` includes `browser` only when `browser_compatible = true`.
- Browser failure does not have to make the bottle status `failed` if the
  package is still valid for Node. It should remain a successful Node-capable
  bottle with a failed browser-smoke validation outcome.
- Gallery creation runs only after final metadata passes
  `homebrew-validate` and records browser compatibility.

## Outcome Artifacts

For each browser smoke run, write:

- `summary.json` - machine-readable suite result, counts, tap commit,
  image/report paths, formulas, arch, browser URL, and command list.
- `summary.md` - reviewer-readable table of cases and statuses.
- `current-run.json` - live progress, current case, expected next action, and
  stale-run threshold.
- `failures.json` - complete failed case objects.
- `outcome-lists/passed-tests.tsv` - case, duration, details, artifact path.
- `outcome-lists/failed-tests.tsv` - case, duration, error, artifact path.
- `outcome-lists/skipped-tests.tsv` - case, reason, artifact path.
- `<formula>-<arch>-homebrew.vfs.zst` - candidate image or a pointer to its
  served copy.
- `<formula>-<arch>-homebrew-vfs-report.json` - VFS builder report.
- screenshots and traces when the browser page fails, times out, or produces
  unexpected output.

Skipped lists must include reasons, for example:

- `wasm64 browser compatibility is unsupported by the current Homebrew browser
  sidecar path`;
- `sqlite consumer compilation failed before browser launch`;
- `candidate sidecar planning failed because package has no wasm32 bottle`;
- `browser terminal did not become ready before timeout`.

## Implementation Sequence

1. Stack the worktree on the parent Homebrew pilot commit
   `440ac7e5e8876b54345682f23dde271889682c40` or wait until it is merged.
2. Refactor shared outcome-list helpers from
   `scripts/homebrew-package-node-smoke.ts` into a small local helper module.
3. Add shared package smoke case definitions for sqlite, bzip2, and xz.
4. Add `scripts/homebrew-package-browser-smoke.ts` with candidate VFS
   building, optional sqlite consumer injection, Vite startup, Playwright
   browser execution, terminal command driving, and artifact writing.
5. Add targeted unit coverage for command planning, unsupported-case
   classification, and outcome-list generation.
6. Extend `scripts/homebrew-generate-sidecars-from-env.sh` to consume browser
   summary JSON and populate the existing `browser_smoke` provenance outcome.
7. Update the reusable Homebrew publish workflow to run the browser smoke only
   for wasm32 entries after candidate sidecars are available and before final
   sidecars are published.
8. Keep `apps/browser-demos/test/kandelo-homebrew.spec.ts` for gallery gating
   and hello coverage. Add only minimal coverage there if the generic runner
   exposes a browser-app regression not covered by the direct script.
9. Generate browser gallery assets only from final metadata that passed the
   browser smoke.
10. Update `docs/homebrew-publishing.md` with the generic browser smoke flow,
   candidate/final sidecar sequence, outcome artifacts, and unsupported wasm64
   boundary.

## Test And Documentation Plan

For the implementation PR, run and record:

- `npx tsx scripts/homebrew-package-node-smoke.ts --tap-root <tap> --formula sqlite --formula bzip2 --formula xz --arch wasm32 --result-dir <dir>`
- `npx tsx scripts/homebrew-package-browser-smoke.ts --tap-root <tap> --formula sqlite --formula bzip2 --formula xz --arch wasm32 --result-dir <dir>`
- `cargo run --release -p xtask -- homebrew-validate --tap-root <final-sidecar-root>`
- `cd host && npx vitest run test/homebrew-vfs-planner.test.ts test/homebrew-vfs-builder.test.ts test/homebrew-vfs-fetch.test.ts`
- `cd apps/browser-demos && npx playwright test test/kandelo-homebrew.spec.ts --project=chromium`
- `scripts/validate-software-gallery.mjs <gallery.json>` when gallery assets are generated.

If implementation changes shared host runtime, VFS semantics, ABI-adjacent
code, package bytes, or browser app boot behavior, broaden verification using
the suites in `CLAUDE.md` and `docs/agent-guidance/validation.md`. At minimum,
publish exactly which full-gate commands were run and which were not run.

Documentation updates:

- `docs/homebrew-publishing.md` for the generic browser smoke workflow and
  sidecar finalization semantics.
- Package-specific notes only if the implementation changes package build
  outputs or smoke expectations.
- No `docs/package-management.md` update unless package archive, resolver, or
  revision semantics change.

## Alternatives Considered

### Add One Playwright Spec Per Package

Rejected. Per-package specs would reproduce the current `hello` hardcoding and
make every new Formula require browser test plumbing. A generic runner keeps
package specifics in data and produces uniform artifacts.

### Run Browser Smokes Through The Low-Level Test Runner Page

Rejected as the default. `apps/browser-demos/pages/test-runner` is useful for
isolated Wasm binaries, but Homebrew browser support is a product claim about
precomposed VFS images, the Kandelo app boot path, browser host setup, and
terminal-visible execution.

### Require `browser_compatible=true` Before Building The Smoke Image

Rejected because it is circular. The smoke must build a candidate image before
browser compatibility is known. The strict browser runtime filter belongs
after final sidecar generation.

### Mark Browser Compatibility From Node Smoke

Rejected. Node and browser are peer hosts, and browser-specific failures in
fetching, SharedArrayBuffer setup, VFS restore, terminal PTY behavior, or
worker lifecycle would be hidden.

### Put `autoCommand` In Every Smoke Image

Deferred. Image-declared `autoCommand` is a real product feature and should
not be used only to simplify the first test harness. It remains a fallback if
terminal driving is demonstrably flaky.

## Risks And Mitigations

Metadata circularity:

- Risk: the harness needs browser-compatible metadata to build the image that
  proves browser compatibility.
- Mitigation: use candidate sidecars without a browser runtime filter, then
  regenerate final sidecars from smoke summaries.

Terminal flakiness:

- Risk: prompt detection or text wrapping makes browser checks unreliable.
- Mitigation: use unique sentinels, bounded waits, screenshots/traces on
  failure, and one command at a time. Avoid relying on exact full terminal
  layout.

Library smoke ambiguity:

- Risk: sqlite could be marked compatible after only headers and libraries are
  linked into the VFS.
- Mitigation: require a compiled `sqlite_basic.wasm` consumer to run in the
  browser before setting browser compatibility.

Package command overreach:

- Risk: bzip2/xz round trips could fail because shell utilities are missing
  rather than because the package is broken.
- Mitigation: make version/help the required first smoke, use Bash builtins for
  file creation, and record round-trip skips separately if needed.

Workflow time and artifact size:

- Risk: one browser boot per formula increases trusted publication time.
- Mitigation: run only wasm32 browser candidates, keep timeouts explicit, cache
  bottle bytes, and preserve per-formula images only as run artifacts unless a
  package becomes gallery-eligible.

Stale branch base:

- Risk: implementation starts from a branch that lacks the parent Homebrew
  pilot files.
- Mitigation: stack on the parent implementation commit or merged main before
  editing. Record the base in bead metadata.

## Open Questions

- Should browser compatibility require the bzip2/xz file round-trip cases, or
  is version/help sufficient for the first generic harness?
- Should the browser runner use Playwright Test for trace integration, or a
  direct Playwright script like `browser-sqlite-official-runner.ts` for simpler
  process control?
- Should sqlite consumer injection be local to the smoke runner, or should
  `build-homebrew-vfs-image.ts` grow a generic `--inject-file` test-only
  option?
- Should the trusted workflow run browser smoke before or after Node smoke
  finalization, or should both consume the same candidate sidecar root and
  regenerate final sidecars once?
- Which browser projects beyond Chromium should become required after the
  generic harness is stable?
