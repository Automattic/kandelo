# DRI port onto kandelo:main — session 15 handoff

Continuation of [2026-06-10-dri-kandelo-port-handoff-14.md](./2026-06-10-dri-kandelo-port-handoff-14.md). Read that first.

## Goal (unchanged)

Land the DRI/WebGL/KMS stack as **one** PR against `Automattic/kandelo:main`. All five test gates green before opening the PR. Branch lives on `Automattic/kandelo` only — do **not** push to `mho22` and do **not** push at all this branch-cycle. Wait for user input before each commit.

## TL;DR for next session — read this twice

1. **Root cause LOCATED but NOT fixed.** The canvas paints black because `programs/modeset.c::drain_mouse` always reads `-1 / EAGAIN` from `/dev/input/mice`. The host **is** calling `kernel_inject_mouse_event(dx, dy, buttons)` with correct values (verified: `{"dx":-128,"dy":1,"buttons":0}`, then `{"dx":-32,"dy":-22,"buttons":1}`, etc.) but modeset.c never sees a byte come out the read end. The kernel-side `crate::mouse::GLOBAL` ring is somehow empty at read time. Three-way comparison with Pavel's repo and reference PR #66 ruled out modeset.c, the GLES2 stub, the host DRI registries, the WebGL2 ping-pong pipeline, OffscreenCanvas commit, framebuffer completeness, and shader compilation — every one of those is healthy. The mouse-event delivery path is the last hop and it is broken.
2. **The fluid pipeline ITSELF is fine.** Pavel-style boot-seed (`multipleSplats(20)` inserted before the loop) successfully painted fading dye on the canvas — confirms shader compile, RGBA16F FBOs, display pass, and OffscreenCanvas → main-thread composite all work end-to-end. The screenshot showed faint wisps that decayed below the visibility threshold because there were no follow-up splats.
3. **Branch state at end of session 15 has UNCOMMITTED DIAGNOSTIC INSTRUMENTATION.** See "Cleanup before commit" below — revert these before any user-facing commit. None of these add features; they were probes that pinpointed the bug.

## Mission (verbatim from session 14)

> *"Analyze the whole code you built for DRI KMS, and also analyze thoroughly Pavel's demo at https://github.com/PavelDoGreat/WebGL-Fluid-Simulation. In its demo it runs a couple of projections when it loads. The user also wrote a working Kandelo DRI/KMS port at https://github.com/mho22/wasm-posix-kernel/pull/66 (a series of 6 to 7 PRs with the whole work in it). Compare Pavel's GitHub repository work with the user's DRI/KMS work with the current branch's DRI/KMS work. And make it work once and for all."*

## What I did this session

### 1. Three-way compare — current vs reference PR #66 vs Pavel

The reference user-port lives at `mho22/wasm-posix-kernel` as a 7-PR stack on top of `main`:

| PR | Branch | Title |
|----|---|---|
| #58 | `emdash/explore-direct-rendering-infrastructure-9vbaz` | docs/plans DRI design |
| #61 | `explore-direct-rendering-infrastructure` | kernel+host(dri) GBM dumb-buffer surface end-to-end |
| #62 | `explore-direct-rendering-phase-c` | examples(dri) dumb-buffer shim-pass demo |
| #63 | `explore-direct-rendering-mmap-shared` | host(dri) SAB-backed bo store |
| #64 | `explore-direct-rendering-per-fd-state` | kernel(dri) per-fd DriFdState lift |
| #65 | `dri-multiplexer-phase-c` | dri plan 3 §C multi-process renderD128 multiplex |
| #66 | `dri-kms-kernel` | dri plan 4 KMS milestone — modeset surface + scanout pump + Pavel fluid-sim demo |

The reference branch `dri-kms-kernel` is fetchable directly via the existing `origin` remote (this kandelo worktree's `origin` IS `mho22/wasm-posix-kernel` — origin and upstream are the same repo on two GitHub remotes). Use `git fetch origin dri-kms-kernel` then `git show origin/dri-kms-kernel:<path>` to inspect.

**Zero-diff files** vs `origin/dri-kms-kernel`:
- `programs/modeset.c` (Pavel port — bit-for-bit identical)
- `libc/glue/libglesv2_stub.c` (the GLES2 stub)
- `host/src/dri/kms-registry.ts`, `host/src/dri/registry.ts`

So the entire visual pipeline is byte-identical to the user's working reference. The bug is NOT in the GL path or modeset.c.

**Significant divergence** (~3000 line diff total):
- `host/src/kernel-worker.ts`, `host/src/kernel.ts`, the worker entries, the host-host files. Mostly unrelated to GL/KMS — the kandelo React UI integration came in on top of the reference port. Most diffs are kandelo-side, not DRI-side.

### 2. Pavel's reference — confirmed boot-seed pattern

Pavel's `script.js` calls `multipleSplats(parseInt(Math.random() * 20) + 5)` at boot so the dye texture is non-empty before any user input. Our `programs/modeset.c` has **no boot seeding** — it relies entirely on mouse-driven splats. I added a temporary seed loop (see Cleanup below) and confirmed the pipeline works without mouse input.

### 3. Walked H7 / H8 / H9 in order

| # | Hypothesis | Verdict |
|---|---|---|
| 7 | OffscreenCanvas worker → placeholder commit gap | **Ruled out.** The kernel-worker uses `Atomics.waitAsync` (non-blocking) so the worker's event loop runs and OffscreenCanvas auto-commit fires. Verified by reading the canvas's default framebuffer center pixel via `gl.readPixels` inside `host_gl_submit`: returns `[0, 0, 0, 255]` opaque-black. The OffscreenCanvas is faithfully showing the GL output; GL is just producing opaque-black. |
| 8 | RGBA16F / extension gap leaves shaders invisible | **Ruled out.** `host_gl_create_context` enables `EXT_color_buffer_float`, `OES_texture_float_linear`, `EXT_float_blend` — all three return non-null. `gl.checkFramebufferStatus(GL_FRAMEBUFFER)` returns `0x8CD5 = GL_FRAMEBUFFER_COMPLETE` for every probed batch. `drawingBufferWidth/Height = 1920×1080` as expected. |
| 9 | `kernel_kms_commit_count` overruns vblank | **Real but cosmetic.** ~130 000 flips in ~8 s = 16 250 commits/s while the vblank pump nominally runs at 60 Hz. modeset.c hot-loops because its vblank gating (`kms_pageflip_wait`) doesn't actually throttle. Not the cause of the black canvas. File for session 16 as a perf/correctness cleanup. |

### 4. Identified the actual root cause — mouse queue starvation

Diagnostic plan in session 15 (each step landed in the working tree, all marked `[DIAG S15 ...]`, all reverted-before-commit material — see Cleanup):

1. Wired `onStdout` / `onStderr` in `live-setup.ts` to also `console.log/warn` so the Playwright probe could see modeset.c's stderr.
2. Added GL-error / FBO-completeness / `drawingBuffer*` probe inside `host_gl_submit`. Result: zero errors, FB always complete.
3. Added `readPixels` probe of the canvas default-framebuffer center. Result: `[0, 0, 0, 255]` — opaque black, so the pipeline IS reaching the canvas.
4. Added `useProgram` histogram + `drawArrays` counter in `host/src/webgl/bridge.ts`. Result: programs 1–7, 9 invoked thousands of times each; **program 8 (the splat program) is invoked 0 times** during normal operation.
5. Patched `programs/modeset.c` to do Pavel-style boot seed (`multipleSplats(20)`). Result: program 8 was now invoked 40× at boot, then never again. The boot-seeded dye was visible (faint wisps) and decayed to black per `DEN_DISSIPATION = 1.0`.
6. Added a `[DIAG S15 drain]` line in `programs/modeset.c::drain_mouse` that logs the read count, last `n`, last `errno`, current button state, and current cursor every 1024 calls. Result, **definitive smoking gun:**

   ```
   [DIAG S15 drain] call=1     reads=1 last_n=-1 last_errno=11 buttons=0 cx=960 cy=540
   [DIAG S15 drain] call=1025  reads=1 last_n=-1 last_errno=11 buttons=0 cx=960 cy=540
   [DIAG S15 drain] call=2049  reads=1 last_n=-1 last_errno=11 buttons=0 cx=960 cy=540
   ... (continues identical for the full probe duration)
   ```

   Every `read(mouse_fd, pkt, 3)` returns `-1` with `errno = 11 (EAGAIN)`. The buttons/cursor never change. modeset.c never sees a single PS/2 packet, so `splat_velocity` and `splat_dye` never fire.

7. Cross-checked the host side: `[DIAG S15 inject]` lines fire during the probe drag with sensible values (`{"n":1,"dx":-128,"dy":1,"buttons":0}` then `{"n":21,"dx":-32,"dy":-22,"buttons":1}` then `{"n":41,"dx":-18,"dy":27,"buttons":1}`). So `WasmPosixKernel.injectMouseEvent` IS being called, with `buttons=1` correctly delivered.

The wasm export `kernel_inject_mouse_event` (defined at `crates/kernel/src/wasm_api.rs:10426`) calls `crate::mouse::inject_event(dx, dy, buttons)` which pushes three bytes into `crate::mouse::GLOBAL` (a `static VecDeque<u8>`). The read syscall in `crates/kernel/src/syscalls.rs:2588` calls `crate::mouse::read_into(buf)` which drains from the same `GLOBAL`. Both run on the kernel-worker JS thread, in the same wasm kernel instance. They MUST share the queue. And yet the read side always finds it empty.

## The exact bug to chase in session 16

**Working hypothesis (DO NOT take as established):**

The wasm kernel is built `no_std` for wasm32, and `static GLOBAL: GlobalMouseQueue = GlobalMouseQueue(UnsafeCell::new(VecDeque::new()))` lives in the wasm linear memory. In single-threaded wasm this is fine. **But** the kernel runs in centralized mode with multiple process workers each having their own SAB-backed `WebAssembly.Memory`; the channel IPC dispatcher in `kernel-worker.ts` instantiates **`kernel_handle_channel` against the user process's memory**, while `kernel_inject_mouse_event` is called against the kernel-worker's own kernel-memory. If the `GLOBAL` symbol resolves to different addresses in those two memory views, inject pushes into kernel-memory and read drains from per-process memory.

If that hypothesis is wrong, the next-most-likely candidates are:

1. **A second wasm-kernel instance.** Look for any path where `WasmPosixKernel` is constructed twice (one for the kernel-worker; another stashed somewhere for mouse injection only). Unlikely given the architecture doc but should be ruled out with `grep -n 'new WasmPosixKernel' host/src/`.
2. **`MICE_OWNER` enforcement gate I missed.** The current read handler doesn't appear to check `MICE_OWNER`, but there could be a `poll`/`select` short-circuit or an `acquire_mice_or_busy` race that fails silently. Read `crates/kernel/src/syscalls.rs:2585-2596` against the open path at `crates/kernel/src/syscalls.rs:270-298`.
3. **The wasm instance handling `kernel_inject_mouse_event` lacks the shared memory view of GLOBAL** — would only show if the kernel-worker spawns a side wasm instance for input. Audit `host/src/kernel.ts:270-275` (the `injectMouseEvent` wasm export call) and confirm it goes through `this.instance` and not some second instance.

### Concrete debugging plan for session 16

1. **Add two new wasm kernel exports** so we can poll the mouse queue from JS without rebuilding the user binary:
   ```rust
   #[unsafe(no_mangle)]
   pub extern "C" fn kernel_mouse_queue_len() -> u32 {
       crate::mouse::queue().len() as u32
   }
   #[unsafe(no_mangle)]
   pub extern "C" fn kernel_mouse_owner() -> i32 {
       crate::mouse::MICE_OWNER.load(core::sync::atomic::Ordering::SeqCst)
   }
   ```
   Both additive-compatible — no `ABI_VERSION` bump needed.
2. From `host/src/kernel.ts::injectMouseEvent`, **after** calling `inject`, also call `kernel_mouse_queue_len` and log the result. If it returns 0 immediately after a successful push, the queue we pushed into is not the same queue (memory/instance mismatch). If it returns 3, 6, 9, … the queue IS accumulating bytes — and then the read side must be draining a different copy.
3. Add a third export — `kernel_mouse_read_one() -> u32` returning the next 3 bytes packed in a u32 — that bypasses the syscall path. Call it from JS as a control: if it returns data when the syscall path returns EAGAIN, the syscall path is broken; if it returns 0, the inject path is broken.
4. As a fallback if (1)–(3) reveal the wrong memory view: print the address of `GLOBAL` from both `inject_event` and `read_into` via temporary `extern "C"` accessors. Two different addresses = two different statics = static is being placed in per-instance memory somehow.
5. **Diff the reference's mouse path.** Specifically check whether reference PR #66 added or modified the kernel-side mouse handling vs `Automattic/kandelo:main` and whether any of those changes are missing on this branch. The reference's user `mouse.rs` and the read handler for `VirtualDevice::Mice` should be examined byte-for-byte even though high-level inspection suggests they're the same. Reference branch: `origin/dri-kms-kernel`. Use:
   ```
   git diff origin/main..origin/dri-kms-kernel -- crates/kernel/src/mouse.rs crates/kernel/src/syscalls.rs
   git diff HEAD..origin/dri-kms-kernel -- crates/kernel/src/mouse.rs crates/kernel/src/syscalls.rs
   ```
   The second diff is the one that matters — anything non-zero is a possible regression in our branch.

### What NOT to retry

- Don't re-walk H7 (commit gap), H8 (RGBA16F gap), or H9 (commit count overrun) — H7 and H8 are ruled out with `gl.readPixels` evidence; H9 is real but unrelated to pixels-on-canvas.
- Don't touch Modeset.tsx pointer wiring. Session 14's pointer code is correct.
- Don't change the canvas pre-resize in `kernel.ts::host_gl_create_context` — it's verified to deliver 1920×1080.
- Don't bump `ABI_VERSION`. Adding new exports is additive-compatible.

## Cleanup before commit (do NOT commit these)

These diagnostics were used to locate the root cause in session 15. None of them should land. Revert sequence:

| File | Change to revert |
|---|---|
| `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` | Restore `onStdout` / `onStderr` to their original tick-only form (no `console.log`/`console.warn`). |
| `host/src/kernel.ts` | Remove the `_s15MouseInj` counter, the `[DIAG S15 host_gl_create_context]` block, and the `[DIAG S15 readPixels-canvas]` block. The line numbers shift; grep for `S15` and remove every match. |
| `host/src/webgl/bridge.ts` | Remove the `_s15UseProg` / `_s15UseProgN` histogram in `OP_USE_PROGRAM` and the `_s15Draws` block in `OP_DRAW_ARRAYS`. |
| `programs/modeset.c` | Remove the boot-seed `for (int i = 0; i < 20; i++)` block, the `[DIAG S15 modeset] entering loop` print, the static `s_call` counter in `drain_mouse`, and the `[DIAG S15 drain]` and `[DIAG S15 modeset] f=...` prints. |

After reverting the C source, rebuild via:
```
PATH=/nix/var/nix/profiles/default/bin:$PATH WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk scripts/dev-shell.sh bash -c \
  'WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk scripts/build-programs.sh'
```

Untracked files to delete:
- `apps/browser-demos/_probe-modeset-session15.ts` (the Playwright-based probe)
- `/tmp/modeset-s15-during.png`, `/tmp/modeset-s15-pane.png`, `/tmp/vite-modeset.log`

## Working-tree state at end of session 15

Same as end-of-session-14 plus the diagnostic edits listed in "Cleanup before commit" above, plus this new doc as untracked.

```
Modified (uncommitted) — handoff-14 list plus session-15 instrumentation
  abi/snapshot.json                                       # unchanged
  apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts   # SESSION 15: stderr/stdout console wiring (revert before commit)
  apps/browser-demos/pages/kandelo/panes/Modeset.tsx           # session-14 keep
  apps/browser-demos/playwright.config.ts                 # unchanged
  crates/kernel/src/syscalls.rs                           # unchanged
  crates/kernel/src/wasm_api.rs                           # unchanged
  crates/shared/src/lib.rs                                # unchanged
  host/src/browser-kernel-host.ts                         # unchanged
  host/src/browser-kernel-protocol.ts                     # unchanged
  host/src/browser-kernel-worker-entry.ts                 # unchanged
  host/src/dri/kms-registry.ts                            # unchanged
  host/src/generated/abi.ts                               # unchanged
  host/src/kernel-worker.ts                               # unchanged
  host/src/kernel.ts                                      # SESSION 15: DIAG counters (revert)
  host/src/node-kernel-host.ts                            # unchanged
  host/src/node-kernel-protocol.ts                        # unchanged
  host/src/node-kernel-worker-entry.ts                    # unchanged
  host/src/webgl/bridge.ts                                # SESSION 15: DIAG counters (revert)
  host/test/dri-kms-stats-sab.test.ts                     # unchanged
  host/test/dri-modeset.test.ts                           # unchanged
  host/test/dri-smoke.test.ts                             # unchanged
  libc/glue/abi_constants.h                               # unchanged
  programs/modeset.c                                      # SESSION 15: boot-seed + drain DIAG (revert)
  scripts/build-programs.sh                               # unchanged
  web-libs/kandelo-session/src/kernel-host.ts             # unchanged

Untracked:
  apps/browser-demos/test/kandelo-modeset.spec.ts         # session-13 keep
  apps/browser-demos/_probe-modeset-session15.ts          # SESSION 15 probe spec (delete before commit)
  docs/plans/2026-06-09-dri-kandelo-port-handoff-13.md    # keep
  docs/plans/2026-06-10-dri-kandelo-port-handoff-14.md    # keep
  docs/plans/2026-06-10-dri-kandelo-port-handoff-15.md    # THIS FILE
```

Local binaries:
- `local-binaries/programs/wasm32/modeset.wasm` — built from instrumented modeset.c, will need a clean rebuild after the cleanup.

## Reference points (additions in session 15)

- `crates/kernel/src/mouse.rs:65` — `static GLOBAL: GlobalMouseQueue` (the queue both sides should share).
- `crates/kernel/src/mouse.rs:81` — `inject_event` (push path).
- `crates/kernel/src/mouse.rs:120` — `read_into` (drain path).
- `crates/kernel/src/wasm_api.rs:10426` — `kernel_inject_mouse_event` wasm export.
- `crates/kernel/src/syscalls.rs:2588` — Mice read handler (returns EAGAIN when queue is empty).
- `host/src/kernel.ts:270` — `WasmPosixKernel.injectMouseEvent` (calls the wasm export).
- `host/src/kernel-worker.ts:7224` — `CentralizedKernelWorker.injectMouseEvent` (forwards to `this.kernel.injectMouseEvent`).
- `host/src/browser-kernel-host.ts:813` — `BrowserKernel.injectMouseEvent` (posts `mouse_inject` to the worker).
- `host/src/browser-kernel-worker-entry.ts:1411` — `handleMouseInject` (receives `mouse_inject` and calls `kernelWorker.injectMouseEvent`).
- `apps/browser-demos/pages/kandelo/panes/Modeset.tsx:135-187` — pointer wiring (sends mouse events via `handleRef.current.sendMouseEvent`).
- `web-libs/kandelo-session/src/kernel-host.ts:1495-1500` — `KandeloHost.attachKmsDisplay`'s `sendMouseEvent` (calls `kernel.injectMouseEvent`).

## Important constraints, do not violate (carry-forward from v1–v14)

- One PR against `Automattic/kandelo:main`. All five test gates green first.
- Dual-host parity for any `host/src/` touch.
- No Asyncify, anywhere.
- Use the Kandelo React UI pane, not a legacy standalone page.
- Ask before any destructive git op.
- Push to `Automattic/kandelo`, not `mho22/wasm-posix-kernel`. **For this branch: do not push at all this session-cycle.**
- Wait for user input before each commit.

## Open questions carried into session 16

- (Q1, NEW) Why does the kernel-side mouse queue appear empty to modeset.c's `read()` syscall even though `kernel_inject_mouse_event` is being called with non-zero buttons? Two hops, same wasm instance — must share `GLOBAL` — but they don't.
- (Q2, carried from v14) The 103 vitest `exnref` failures on this branch — still unresolved, still NOT introduced by sessions 13/14/15.
- (Q3, carried from v14) Is `channel: "chromium"` (new-headless) safe for the other Playwright projects?
- (Q4, carried from v14) Why does `kernel_kms_commit_count` advance at ~3000 Hz when modeset.c is gated by `kms_pageflip_wait()` and the vblank pump runs at 60 Hz?
- (Q5, carried from v14) Does `gl.checkFramebufferStatus()` on the RGBA16F ping-pong RTs return `GL_FRAMEBUFFER_COMPLETE`? **Answered this session: yes (36053 = `GL_FRAMEBUFFER_COMPLETE`).**

## Standing instruction for the next session

**Print this sentence in the next session's first turn so I have a single fixed entry point:**

> *"Read `docs/plans/2026-06-10-dri-kandelo-port-handoff-15.md` first. Then revert all `[DIAG S15 ...]` instrumentation per its 'Cleanup before commit' table, then attack the actual bug: `kernel_inject_mouse_event` pushes packets into `crate::mouse::GLOBAL` but `programs/modeset.c::drain_mouse` always reads `-1 / EAGAIN`. Start by adding additive-compatible wasm exports `kernel_mouse_queue_len()` and `kernel_mouse_owner()` to probe the queue state from JS — if `_len` reports 0 immediately after a successful inject the queue is in the wrong memory view; if `_len` accumulates correctly the syscall read path is the broken side. Three-way diff vs `origin/dri-kms-kernel` to confirm `crates/kernel/src/mouse.rs` and the `VirtualDevice::Mice` read handler in `crates/kernel/src/syscalls.rs` haven't regressed. Branch is `explore-direct-rendering-infrastructure` on Automattic/kandelo — do NOT push, do NOT push to mho22. Nix lives at `/nix/var/nix/profiles/default/bin` so every dev-shell call needs `PATH=/nix/var/nix/profiles/default/bin:$PATH scripts/dev-shell.sh bash -c '…'`. SpiderMonkey needs `WASM_POSIX_MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk` exported inside the inner `bash -c`. Wait for user input before each commit, per the standing instruction."*
