# Homebrew SpiderMonkey VFS Fork-Status Design

Bead: `kd-nlyy.1`

Parent wave: `kd-nlyy` / Homebrew JS runtime stack

Observed failure:
`test-runs/kd-nlyy/homebrew/node-smoke-with-mariadb/outcome-lists/failed-tests.tsv`

## Problem Statement

The Homebrew bottles for `spidermonkey`, `spidermonkey-node`, and `node` can be
built and formula-tested, but the Homebrew VFS smoke cannot save images from
those bottles. The VFS image helper refuses the poured images because linked
artifacts import `kernel.kernel_fork` without the complete `wpk_fork_*` export
set:

- `spidermonkey` installs `bin/js` and `libexec/node.wasm`.
- `spidermonkey-node` installs `bin/spidermonkey-node`.
- `node` installs `bin/node`.

The package manifests currently declare `fork_instrumentation = "disabled"` for
these outputs. That is intentional: earlier SpiderMonkey fork instrumentation
made Chromium workers exhaust the Wasm call stack before user JavaScript ran.
The package archive path allows this disabled policy, but the VFS image path is
stricter because a VFS image is a runtime launch artifact and must not contain
Wasm that can reach `kernel.kernel_fork` without fork continuation exports.

The design goal is to publish truthful Homebrew status without weakening the
VFS guard or claiming Node/browser runtime support for artifacts that are not
safe to put into a Kandelo VFS image.

## Non-Goals

- Do not bypass `assertNoStaleWasmArtifacts()` or add a SpiderMonkey allowlist
  to `images/vfs/scripts/vfs-image-helpers.ts`.
- Do not treat `status = "failed"` as the answer for successful bottle bytes.
  Bottle build status and runtime/VFS compatibility are separate facts.
- Do not revive Asyncify or accept legacy `asyncify_*` artifacts.
- Do not silently remove or stub `fork()` from the SpiderMonkey artifacts in
  this work. A no-fork runtime profile needs a separate POSIX-boundary design.
- Do not mark browser support from a direct Node host formula test or from a
  successful bottle build.
- Do not implement the package fix in this design artifact.

## Decision

Keep the VFS stale-artifact guard intact and record the three SpiderMonkey
derived bottles as buildable but not VFS-runtime-compatible until either:

1. the artifacts are successfully rebuilt with complete `wasm-fork-instrument`
   exports and pass Node plus browser VFS smokes, or
2. a separately designed no-fork artifact profile removes the unsafe
   `kernel.kernel_fork` import and documents its POSIX boundary.

For the current Homebrew path, extend Kandelo/Homebrew sidecars so a bottle can
be `status = "success"` while declaring no runtime support:

```json
{
  "runtime_support": [],
  "runtime_status": {
    "node": {
      "status": "unsupported",
      "reason_code": "fork-instrumentation-disabled-imports-kernel-fork",
      "reason": "The linked Wasm imports kernel.kernel_fork but intentionally disables wasm-fork-instrument; VFS images must reject it.",
      "artifact_policy_failures": [
        {
          "path": "bin/js",
          "failures": [
            "imports kernel.kernel_fork without complete wasm-fork-instrument exports"
          ]
        }
      ]
    },
    "browser": {
      "status": "unsupported",
      "reason_code": "fork-instrumentation-disabled-imports-kernel-fork",
      "reason": "No browser VFS smoke can be valid while the image contains raw fork imports."
    }
  }
}
```

`runtime_support` remains the allow-list of hosts for which the bottle can be
planned, poured, saved as a VFS image, and executed through the normal Kandelo
runtime path. A successful direct formula test is validation evidence, not a
runtime support claim.

## Users And Operator Workflows

Maintainers reviewing Homebrew status need to distinguish four states:

- bottle build/test succeeded;
- bottle bytes and sidecars are valid;
- VFS runtime support is intentionally unsupported for Node/browser;
- no browser gallery or launchable VFS image should be generated.

Package porters need the Node smoke command to stop reporting a stale-artifact
VFS failure as an unexpected test failure when the sidecar already says the
package is not runtime-compatible. The smoke should record a skipped or
accepted-unsupported outcome with the exact reason and artifact paths.

Tap publishers need failure/status publishing to preserve last-green bottle
metadata while still allowing successful non-runtime-compatible bottles to
appear in `Kandelo/metadata.json`. This lets reviewers see that the bottle
exists, but VFS/runtime consumers cannot accidentally select it.

Node and browser runtime consumers need early, explicit diagnostics from the
planner. They should not download bottles, build partial images, or reach
`saveImage()` before learning that the requested package has no supported
runtime.

## Architecture And Data Flow

### Current Flow

1. Formula builds and installs raw `js.wasm` / `node.wasm`.
2. Sidecar generation emits `runtime_support = ["node"]` when no browser smoke
   succeeded.
3. `scripts/homebrew-package-node-smoke.ts` calls `planHomebrewVfs()` with
   `runtime = "node"`.
4. The planner accepts the metadata, `buildHomebrewVfs()` pours bottles into a
   `MemoryFileSystem`, and `saveImage()` rejects the raw fork imports.

The failure is correct but late. The incorrect fact is the sidecar's Node
runtime claim.

### Proposed Flow

1. Formula build/test may still succeed for `spidermonkey`,
   `spidermonkey-node`, and `node`.
2. `scripts/homebrew-generate-sidecars-from-env.sh` or `xtask homebrew-sidecars`
   scans linked Wasm artifacts from the bottle/link manifest using the same
   policy facts as `describeWasmArtifactPolicyFailures()`.
3. If a linked runtime artifact imports `kernel.kernel_fork` without complete
   fork exports, sidecar generation must either:
   - fail because the package is trying to claim runtime support, or
   - require an explicit unsupported-runtime override and emit
     `runtime_support = []` plus `runtime_status` with reason and evidence.
4. `homebrew-validate` checks the schema and cross-file facts:
   - `browser_compatible = true` still requires `browser` in
     `runtime_support`;
   - `runtime_support` may be empty only when `runtime_status` explains each
     host used by current tooling;
   - artifact-policy failures are incompatible with `runtime_support`
     containing `node` or `browser`.
5. `planHomebrewVfs()` refuses normal runtime plans for unsupported packages
   before bottle fetching or link-manifest loading. It should expose a typed
   diagnostic, for example `HomebrewVfsUnsupportedError`, carrying package,
   host, reason code, and evidence.
6. `scripts/homebrew-package-node-smoke.ts` catches that typed diagnostic and
   records durable skipped/unsupported outcomes for
   `homebrew_vfs_build_<formula>` and dependent `node_smoke_<formula>` cases.
   It must not call `saveImage()` for unsupported runtime packages.
7. Browser gallery generation remains unchanged: it already requires wasm32
   `status = "success"` and `browser_compatible = true`, so these packages
   remain absent from launchable browser assets.

## Metadata Contract

Keep `status` as bottle publication status:

- `success`: current bottle bytes exist and match metadata;
- `failed`, `pending`, `building`: current bottle attempt state with optional
  last-green fallback.

Add bottle-level runtime compatibility:

- `runtime_support`: array of hosts that can build and boot a VFS image from
  this bottle. This array may be empty.
- `runtime_status`: object keyed by `node` and `browser`.
- per-host status enum: `supported`, `unsupported`, `failed`, `not-validated`.

Recommended meanings:

- `supported`: host is present in `runtime_support`; smoke evidence exists.
- `unsupported`: this bottle is intentionally not usable on that host because
  of a documented platform/package boundary.
- `failed`: runtime smoke was attempted and failed unexpectedly; this should
  keep the host out of `runtime_support` but remain distinct from
  intentionally unsupported.
- `not-validated`: no support claim was made and no blocking incompatibility is
  known. This is useful for browser before a smoke exists, but it is not enough
  for `runtime_support`.

For `spidermonkey`, `spidermonkey-node`, and `node`, use `unsupported` for both
Node and browser while the linked runtime artifacts retain raw fork imports.

## Alternatives Considered

Instrument the SpiderMonkey artifacts now. This is the only path that would
make normal VFS runtime support true, but earlier evidence says the resulting
module overflows Chromium worker call stacks before user JavaScript starts. It
should be a focused fork-instrumentation/runtime investigation, not a metadata
shortcut inside the Homebrew publication path.

Add a VFS image allowlist for SpiderMonkey. Rejected. It would weaken the
product-artifact guard and allow VFS images to carry Wasm that the host cannot
fork correctly. The platform contract prefers a loud unsupported status over a
launchable image with hidden fork corruption risk.

Use `status = "failed"` for these bottles. Rejected. The bottle bytes exist and
formula tests can pass. Marking the bottle failed would conflate publication
state with runtime compatibility, break last-green fallback semantics, and
make tap metadata less accurate.

Keep `runtime_support = ["node"]` and treat the stale guard as an expected
smoke failure. Rejected. Consumers use `runtime_support` as a planner contract;
claiming Node support while the planner/build path cannot save a VFS image is
the root inconsistency.

Split `node` into alias/dependency-owned outputs. Deferred. A split may reduce
duplicate bottle bytes later, but it does not make the underlying raw fork
imports safe. The split should wait until sidecars can represent
dependency-owned executable links and at least one safe runtime artifact exists.

Link a no-fork libc/profile for SpiderMonkey. Deferred. This could remove the
raw `kernel.kernel_fork` import and make a non-forking JavaScript runtime
launchable, but it is a POSIX-visible package/runtime boundary and needs its
own design, docs, and tests.

## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| Empty `runtime_support` breaks existing schema assumptions. | Update both JSON schemas, TypeScript planner types, `homebrew-validate`, examples, and docs in the same implementation. Add tests for empty support with explicit `runtime_status`. |
| A package accidentally claims Node support despite stale fork artifacts. | Make sidecar generation scan linked Wasm artifacts and fail unless an explicit unsupported override removes the host from `runtime_support`. |
| Operators confuse formula test success with runtime support. | Docs and provenance should separate `bottle_build`, direct formula tests, Node VFS smoke, and browser VFS smoke outcomes. |
| Unsupported SpiderMonkey blocks dependent `spidermonkey-node` and `node` with generic dependency errors. | Planner diagnostics should include the dependency package that caused the unsupported closure and the originally requested package. |
| Metadata-only unsupported status hides a real fixable platform defect. | The unsupported reason must point at the current blocker and a follow-up path: instrumented SpiderMonkey or a documented no-fork profile. Keep the VFS guard as the backstop. |
| Future multi-output packages have mixed safe/unsafe artifacts. | This design records bottle-level status for the current package set. Add per-link/per-output runtime status only when a real mixed-output package needs it. |

## Implementation Sequence

1. Add `runtime_status` to `homebrew/kandelo-homebrew/Kandelo/metadata.schema.json`
   and `formula.schema.json`; allow `runtime_support` to be empty.
2. Extend `host/src/homebrew-vfs-planner.ts` types and validation to expose a
   typed unsupported-runtime diagnostic before bottle/link-manifest loading.
3. Teach `scripts/homebrew-generate-sidecars-from-env.sh` or
   `xtask homebrew-sidecars` to scan linked Wasm artifacts from the produced
   bottle. Reuse the same artifact-policy checks used by the VFS guard.
4. Add an explicit runtime override for intentional unsupported status, for
   example environment variables naming host, reason code, reason text, and
   evidence source. Without that override, artifact-policy failures must block
   generation of runtime-supporting sidecars.
5. Update `homebrew-validate` to reject inconsistent combinations:
   `runtime_support` includes a host whose `runtime_status` is unsupported or
   whose artifact scan has stale fork failures.
6. Update `scripts/homebrew-package-node-smoke.ts` so unsupported-runtime
   diagnostics become skipped/unsupported outcome-list rows instead of
   uncaught failures.
7. Regenerate local sidecars for `spidermonkey`, `spidermonkey-node`, and
   `node` with `runtime_support = []` and reasoned `runtime_status`.
8. Rerun the Homebrew sidecar/VFS smoke command for the three packages and
   confirm the stale-artifact failure list is replaced by durable unsupported
   outcomes.
9. Create a follow-up bead for either instrumented SpiderMonkey bring-up or a
   no-fork runtime profile if product direction needs launchable JS runtime
   Homebrew VFS images before fork instrumentation is fixed.

## Test Plan

Focused tests:

- `cargo test -p xtask --target aarch64-apple-darwin homebrew` for sidecar
  schema/generation/validation behavior.
- `cd host && npx vitest run host/test/homebrew-vfs-planner.test.ts
  host/test/homebrew-vfs-builder.test.ts` for planner diagnostics and unchanged
  builder behavior.
- A targeted script test for `scripts/homebrew-generate-sidecars-from-env.sh`
  that proves:
  - raw fork imports plus runtime support are rejected;
  - the explicit unsupported override emits empty `runtime_support` and
    `runtime_status`;
  - browser support cannot be set on unsupported metadata.
- `npx tsx scripts/homebrew-package-node-smoke.ts` against the generated
  sidecars for `spidermonkey`, `spidermonkey-node`, and `node`, with
  pass/fail/skip outcome lists. Expected result for this design path: VFS build
  and runtime smoke cases are skipped/unsupported with the fork-instrumentation
  reason, not failed by `assertNoStaleWasmArtifacts()`.
- `git diff --check` and `bash -n` for touched shell scripts.

Broader gates for an implementation PR:

- `cargo test -p kandelo --target aarch64-apple-darwin --lib`
- `cd host && npx vitest run`
- `scripts/run-libc-tests.sh`
- `scripts/run-posix-tests.sh`
- `bash scripts/check-abi-version.sh`

If a later implementation attempts instrumented SpiderMonkey runtime support,
add:

- `cargo test -p fork-instrument --target aarch64-apple-darwin`
- SpiderMonkey package Node tests;
- the SpiderMonkey browser stress test;
- Homebrew Node VFS smoke passing for the three formulae;
- browser VFS smoke before adding `browser` to `runtime_support`.

## Documentation Plan

Update:

- `docs/homebrew-publishing.md`: define `runtime_support = []`,
  `runtime_status`, and the difference between bottle status, formula tests,
  Node VFS support, and browser VFS support.
- `docs/porting-guide.md`: note that Homebrew formula tests do not by
  themselves establish VFS runtime support.
- `docs/fork-instrumentation.md`: clarify that disabled fork instrumentation
  may be a package archive policy, but VFS images still reject raw
  `kernel.kernel_fork` imports unless runtime support is explicitly absent.
- `homebrew/kandelo-homebrew/README.md`: describe how unsupported runtime
  bottles appear in sidecars and why they are absent from browser gallery
  assets.
- Package notes or follow-up bead notes for `spidermonkey`,
  `spidermonkey-node`, and `node`, recording the exact unsupported reason and
  the future paths to become VFS-compatible.

## Open Questions

1. Should `runtime_status` be required for every host in all sidecars, or only
   when `runtime_support` is empty or a host is explicitly unsupported?
2. Should the artifact-policy scan live in the shell generator, in `xtask
   homebrew-sidecars`, or in both with one implementation treated as the source
   of truth?
3. Do future multi-output packages need per-link runtime compatibility, or is
   bottle-level compatibility enough until there is a concrete mixed-output
   case?
4. Is a no-fork SpiderMonkey artifact an acceptable product boundary if it
   returns truthful `ENOSYS` for fork-like APIs, or should all effort go toward
   making full fork instrumentation work?
5. Should `spidermonkey-node` and `node` continue as separate Homebrew formulae
   while unsupported, or should an alias/dependency-owned executable model wait
   until there is a VFS-compatible artifact to publish?
