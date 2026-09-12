# Repo survey — production code not claimed by any campaign lane

**Date: 2026-09-11. Status: raw survey results, saved so they stop being
lost. This is an inventory, not a plan.** The lane characterizations it
feeds live in `docs/plans/2026-09-11-MASTER-PLAN.md`; the gates live in
`docs/surface-budget.json`.

## Why this file exists

The question asked was: *do a complete repo scan for unscoped, untracked
lanes relative to goals V1–V4, on the premise that all production code
that can reasonably be made into reusable Rust needs to move there.*

That scan had been run before and its results were not written down, so
the master plan was assembled from memory and came out incomplete —
three lanes (K, G, D) were missing entirely, and lane V's gate measured
only a third of its own subject. This file is the durable form of the
scan so the next assembly starts from data instead of recall.

**Nothing here is a claim that a given body of code should move.** The
columns report size and coupling. Whether a body is genuine host floor
is a per-lane question, and for most of these it has not been answered.

## The goals this is measured against

- **V1** — share code across hosts.
- **V2** — deeper Rust type checking.
- **V3** — bundle the kernel with the VFS so ABI changes cannot break images.
- **V4** — minimize the host API surface so a new host (wasmtime) is cheap
  to write. **Stated primary goal.**

## Method, and what it can and cannot show

Line counts are `wc -l` over production sources, excluding `*.test.ts`,
`*.spec.ts`, `*.d.ts`, `test/` directories and `node_modules/`.

Coupling columns count references to the APIs that make TypeScript
*necessary* rather than merely incumbent:

- **WebAsm** — `WebAssembly.` — instantiation, `Table`, `Memory`. Some of
  this is the irreducible floor named in the fork contract.
- **SAB/Atom** — `SharedArrayBuffer`, `Atomics.` — the syscall channel.
- **postMsg** — `postMessage`, `onmessage`, `MessagePort` — worker transport.

**A zero in all three columns does not prove a body is migratable.** It
proves only that the body does not itself touch the host boundary; it can
still be coupled through what it imports. It is a screen for where to
look, not a verdict. Conversely a nonzero count does not prove floor —
`kernel-entry-gate.ts` has 43 `WebAssembly.` references and most are
plausibly orchestration around a much smaller floor.

## Totals by area

| Area | TypeScript | JS/MJS | Shell | Rust |
|---|---|---|---|---|
| `host/src` | 134,822 | 263 | 0 | 0 |
| `images/` | 14,091 | 0 | 1,106 | 0 |
| `scripts/` | 6,408 | 3,321 | 25,658 | 0 |
| `web-libs/` | 5,360 | 0 | 0 | 0 |
| `tools/` | 2,230 | 14 | 0 | 72,633 |
| `sdk/` | 1,466 | 0 | 22 | 0 |
| **Rust total** (`crates/` + `tools/`) | | | | **330,813** |

## `host/src` against the lane roster

| Bucket | Lines | Files |
|---|---|---|
| Lane K — `kernel-worker.ts` | 32,718 | 1 |
| Lane F — `fork-*.ts`, `vfork-*.ts`, `worker-main.ts` | 32,225 | 39 |
| Lane V — `vfs/` | 22,027 | 34 |
| **Claimed by no lane** | **47,806** | **106** |
| Total | 134,776 | 180 |

**The unclaimed bucket is larger than the fork lane.** That is the
headline result of this survey.

## The unclaimed bodies, with coupling

| File | Lines | WebAsm | SAB/Atom | postMsg |
|---|---|---|---|---|
| `process-lifecycle.ts` | 4,836 | 21 | 8 | 1 |
| `kernel.ts` | 4,774 | 30 | 14 | 0 |
| `binary-resolver.ts` | 4,020 | **0** | **0** | **0** |
| `kernel-scratch.ts` | 2,491 | 30 | 6 | 0 |
| `generated/abi.ts` | 2,229 | — | — | — |
| `browser-kernel-worker-entry.ts` | 1,805 | — | — | — |
| `browser-kernel-host.ts` | 1,785 | — | — | — |
| `kernel-entry-gate.ts` | 1,596 | 43 | 0 | 0 |
| `node-kernel-worker-entry.ts` | 1,401 | — | — | — |
| `node-kernel-host.ts` | 1,371 | — | — | — |
| `process-memory.ts` | 1,337 | 20 | 0 | 0 |
| `dylink-planner.ts` | 1,243 | **0** | **0** | **0** |
| `dylink-planner-wire.ts` | 1,047 | **0** | 1 | **0** |
| `dylink-loader.ts` | 973 | 15 | 4 | 0 |
| `wasm-artifact-driver.ts` | 854 | 8 | 0 | 0 |
| `networking/tls-network-backend.ts` | 787 | — | — | — |
| `framebuffer/browser-controls.ts` | 712 | — | — | — |
| `browser-kernel-protocol.ts` | 680 | — | — | — |
| `platform/node.ts` | 666 | — | — | — |
| `webgl/bridge.ts` | 625 | — | — | — |
| `exec-target.ts` | 590 | 9 | 0 | 0 |
| `networking/virtual-network.ts` | 558 | — | — | — |
| `node-kernel-protocol.ts` | 471 | — | — | — |
| `worker-protocol.ts` | 429 | 11 | 1 | 1 |
| `native-positioned-write.ts` | 417 | — | — | — |
| `worker-adapter.ts` | 405 | — | — | — |
| `audio/browser-pcm-driver.ts` | 380 | — | — | — |
| `audio/pcm-transport.ts` | 370 | — | — | — |
| `wasi-module-instance.ts` | 361 | — | — | — |
| `types.ts` | 345 | — | — | — |
| (76 further files) | 8,248 | — | — | — |

`generated/abi.ts` is generated from the Rust ABI and is not a lane; it
is listed so the 47,806 reconciles. The 30 named files are 39,558 lines;
the remaining 76 are 8,248.

## Clusters worth naming

These are groupings the survey suggests, with the evidence for each. They
are **candidates for lanes, not lanes** — none has the five-section
characterization the master plan requires before dispatch.

### Dynamic linking — 3,263 lines

`dylink-planner.ts` (1,243), `dylink-planner-wire.ts` (1,047),
`dylink-loader.ts` (973). The planner and its wire format touch the host
boundary **zero times between them apart from one `SharedArrayBuffer`
reference**: this is dylink planning arithmetic living in TypeScript. The
loader carries the real floor (15 `WebAssembly.` references — instantiating
side modules). Goals V2 and V4.

### Binary and package resolution — 4,020 lines

`binary-resolver.ts`, **zero references in all three columns**, the
largest wholly-uncoupled body in `host/src`. It imports
`vfs/memory-fs.ts`, so its coupling is through lane V rather than absent.
Goal V4: a second host reimplements binary resolution today.

### Host↔kernel entry, scratch and memory plumbing — 11,481 lines

`kernel.ts` (4,774), `kernel-scratch.ts` (2,491), `kernel-entry-gate.ts`
(1,596), `process-memory.ts` (1,337), `wasm-artifact-driver.ts` (854),
`worker-protocol.ts` (429). **This cluster is goal V4 itself** — it is
approximately the thing a wasmtime host would have to write. It is also
the cluster where floor and orchestration are most entangled, so it needs
a census on the pattern of lane V's V6 before any of it is dispatched.

### Node/browser host pairs — 7,513 lines

`browser-kernel-host.ts` / `node-kernel-host.ts` (1,785 / 1,371),
`browser-kernel-worker-entry.ts` / `node-kernel-worker-entry.ts`
(1,805 / 1,401), `browser-kernel-protocol.ts` / `node-kernel-protocol.ts`
(680 / 471).

**These are not copy-paste twins.** After normalising away the host names,
the pairs differ on 2,154, 2,120 and 515 lines respectively — roughly 70%
divergence. The V1 concern is real but it is *divergence between peers*,
not duplication to delete, and any lane here has to say which divergences
are genuine platform boundaries. Note the direction: the browser file is
larger in all three pairs.

### Process and exec host side — 8,359 lines

`process-lifecycle.ts` (4,836), `kernel-entry-gate.ts` (1,596),
`process-memory.ts` (1,337), `exec-target.ts` (590).

**Lane X already exists for this and its only gate is
`parseShebangReferences` (12 → 0).** A 12-reference gate on an 8,359-line
body is the same hole lane V had, and it is not yet closed. Note
`kernel-entry-gate.ts` and `process-memory.ts` appear in both this cluster
and the V4 plumbing cluster; the lanes must agree who owns them before
either is dispatched.

### VFS image builders — 14,091 lines of TypeScript in `images/`

Largest files: `staged-product-inputs.ts` (1,973),
`vfs-product-builder-contract.ts` (952), `wordpress-preinstall.ts` (921),
`shell-vfs-build.ts` (870), `build-source-rootfs-shell-image.ts` (813).
Three of them — `dinit-image-helpers.ts`, `staged-product-inputs.ts`,
`vfs-image-helpers.ts` — reference the SFFS format directly.

**This is goal V3.** A Rust SFFS writer already exists (lane V's V2,
2,103 lines, live via `kernel_rootfs_export_tree`). Builders that write
the format in TypeScript are the reason an ABI change can still break an
image.

### Build automation — 25,658 lines of shell, 9,729 of TS/MJS in `scripts/`

Largest: `run-php-upstream-tests.ts` (2,520),
`browser-binary-package-roots.mjs` (770), `vfs-product-deployment.ts`
(764), `build-local-vfs-asset-group.ts` (764),
`generate-rootfs-package-manifest.mjs` (689).

Goal V2, and the standing repo preference that new tools default to a
Rust xtask verb. `generate-rootfs-package-manifest.mjs` is already
implicated in lane S — it is the emitter that ships `sudo` setuid-root as
a lazy ref with no integrity digest.

### `web-libs/kandelo-session` — 5,360 lines

`kernel-host.ts` is 2,776 of them and touches the host boundary 6 times
total. It owns `KernelHost`, boot descriptors and snapshots — the
contracts a new host consumes. Goals V1 and V4.

## What this survey does not cover

- **`apps/browser-demos`** — presentation, and the contract map says demos
  are consumers. Not surveyed as migration candidates.
- **`libc/glue`, `sdk/`** — `sdk/` is 1,466 lines of TypeScript CLI
  wrapper; it is a candidate under the Rust-tools preference but is not
  host API surface and does not serve V4.
- **Test code** — excluded throughout. Lane T owns test hygiene.
- **Whether any of this should actually move.** Every cluster above needs
  its floor established before it becomes a lane, and the survey
  deliberately stops short of asserting one.

## Immediate consequences already applied

- Lanes **K**, **G**, **D** added to the master plan and the budget
  (commit `1ff6b646d`).
- Surface **`memoryFsTypeScript`** added and put in lane V's closure, so
  the lane can no longer go green with 8,501 of its 12,253 lines standing
  (commit `d9f313955`).

Everything else above is still unclaimed as of this file's date.
