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

### Dynamic linking — 3,263 lines — **NOT A LANE. Already migrated.**

**The first draft of this survey got this wrong and the correction is the
most useful thing in this file.** The coupling screen flagged
`dylink-planner.ts` (1,243) and `dylink-planner-wire.ts` (1,047) as
near-zero-coupling TypeScript and therefore migration candidates. Reading
the files says the opposite: this is a *deliberately built floor* left
behind by a migration that already happened.

`host/src/dylink.ts` — 4,188 lines that interleaved linker computation
with the JS-API calls realising it — **has been deleted**. In its place
are 14,543 lines of Rust across `crates/dylink` and `crates/dylink-module`,
and the surviving TypeScript is a session wrapper plus an executor for
the eight acts wasm cannot perform on itself (`compile`, `newGlobal`,
`readGlobal`/`writeGlobal`, `growTable`/`writeTable`, `growMemory`,
`newTag`). The planner's own header states the rule: *"if a change here
would encode a linker DECISION, the decision belongs in `crates/dylink`."*

The low coupling count is therefore **evidence the migration succeeded** —
the decisions left, the acts stayed. `wasm-artifact-driver.ts` (854) is
the same story with the same header, against `crates/wasm-artifact-module`.

**This is the exemplar the other lanes should be measured against**, and
it is why a low coupling score must never be read as "migratable" without
opening the file. See hazard H-8 in the master plan.

### Binary and package resolution — 4,020 lines

`binary-resolver.ts`, **zero references in all three columns**, the
largest wholly-uncoupled body in `host/src`. It imports
`vfs/memory-fs.ts`, so its coupling is through lane V rather than absent.
Goal V4: a second host reimplements binary resolution today.

### Host↔kernel entry, scratch and memory plumbing — 11,481 lines

**`kernel.ts` (4,774) is lane I's body, not unclaimed.** Its header
enumerates the `env.host_*` import functions it implements — it *is* the
72-import surface lane I counts. Lane I measures the count and never names
the implementation, which is the same gate hole lane V had. It is
subtracted from this cluster below, leaving 6,707.

`wasm-artifact-driver.ts` (854) is likewise already-migrated floor, for
the same reason and with the same header, so it comes out too. What
remains genuinely unclaimed is **5,853 lines**: `kernel-scratch.ts`
(2,491), `kernel-entry-gate.ts` (1,596), `process-memory.ts` (1,337) and
`worker-protocol.ts` (429).

**This remainder is goal V4 itself** — approximately the thing a wasmtime
host would have to write. It is also where floor and orchestration are
most entangled: `kernel-entry-gate.ts` exists because a kernel export may
synchronously call a host import while Rust still owns mutable state, and
`kernel-scratch.ts` exists because a pointer inside `WebAssembly.Memory`
proves the host *can* address bytes, not that the allocator *gave* them to
this caller. Both are real invariants; whether they need 4,087 lines of
TypeScript to hold is the open question. It needs a census on the pattern
of lane V's V6 before any of it is dispatched.

### Node/browser host pairs — 7,513 lines — **partly under way already**

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

**`process-lifecycle.ts` (4,836) already exists to fix exactly this**, and
its header carries the measurement that motivated it: 105 commits since
2026-06-01 touched an entry file and **73 of them (70%) had to touch
both**, and the copies drifted anyway — as far as a VM interrupt timer
left armed across a lease release. Both entries do import from it today,
**10 symbols each**, so the consolidation is real and partial. The lane
here is *finish it*, not *start it*.

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

## Consequences — all applied

Every cluster above has been resolved into the master plan. Nothing in
this file is still unclaimed.

- Lanes **K**, **G**, **D** added (commit `1ff6b646d`).
- Surface **`memoryFsTypeScript`** added to lane V's closure, so the lane
  can no longer go green with 8,501 of its 12,253 lines standing
  (commit `d9f313955`).
- Lanes **L**, **E**, **R**, **Y**, **W**, **U** added with full
  five-section characterizations and budgeted surfaces.
- Two pre-existing gate holes closed: **lane I** gained
  `kernelHostImportTypeScript` (`kernel.ts`, 4,774 lines implementing the
  72 imports it counted) and **lane X** gained `processExecTypeScript`
  (5,426 lines behind a 12-reference gate).
- Hazard **H-8** records the survey's own mistake so it is not repeated:
  a low coupling score selects a file to open, it never classifies one.
- The estimates table now covers all 20 lanes, and a gate fails if it
  ever falls behind the roster again. The nine lanes added on this date
  are **88–177 agent-days** against **93–180** for the eleven before
  them — they very nearly double the campaign.

**One ordering constraint fell out of this survey and was not known
before: lane Y blocks lane V.** `memory-fs.ts` cannot be deleted while
`images/vfs/scripts` imports it.

## What this survey got wrong, kept here deliberately

The first draft read low coupling scores as migration candidates and was
wrong twice in the same way — `dylink-planner.ts` and
`wasm-artifact-driver.ts` are finished floors, not candidates. The
corrected entries above say so, and the error is recorded as H-8 rather
than edited out, because the next survey will be tempted by exactly the
same shortcut.
