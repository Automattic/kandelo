# Rust GPU driver: iteration 1 design

Status: draft for maintainer review, 2026-11-27. This is a design, not
evidence of implemented or validated behavior.

## Intent

The maintainer wants OpenGL ES 3.0 and WebGPU compatibility, built Rust-first,
on a graphics stack whose authority is owned by Kandelo rather than by the
browser host. Today the browser host carries GL: about 26,000 lines of
TypeScript in `host/src/webgl` decode, validate, track state, rewrite shaders
and emulate OpenGL ES 2.0 over WebGL 2 inside the kernel Worker. Guest C
libraries (`libc/glue/libglesv2_stub.c`, `libegl_stub.c`) encode commands and
keep partial local state. GL runs synchronously inside each ioctl.

Iteration 1 replaces that stack with the architecture Linux uses with Mesa,
on the API Kandelo already supports (GLES2 and EGL 1.5), so that ES 3.0 and
WebGPU can be built on it afterwards:

- a **Rust userspace driver** linked into each GL program, owning GL meaning;
- the **kernel** owning the device, memory, submission, scheduling, fences and
  display;
- a kernel-spawned **GPU worker** that executes low-level command streams
  against the browser's WebGL 2, as a GPU executes command buffers.

The maintainer wants a first iteration soon. The effort is explicitly
**browser-first** (see Constraints).

## Goals

- **Never wait unless the GPU must answer.** Like a Mesa driver, the userspace
  driver models the GPU state it expects. `glGet*`, `glGetError`, validation,
  object state, compile/link status and program reflection are answered in
  process. Only real GPU results wait: pixel readback, `glFinish`, query
  results and fence waits.
- **Rust userspace driver** providing the Khronos `libEGL` and `libGLESv2`
  C APIs for C and Rust programs, replacing the C libraries.
- **GPU worker** owning the WebGL 2 context and the KMS canvas, spawned,
  supervised and stopped by the kernel. GPU work leaves the kernel worker.
- **One graphics memory.** Command streams and payloads live in the graphics
  memory group's shared backing and reach the GPU worker as kernel-issued
  descriptors.
- **Clean start, hard switch.** The new stack is written without reference to
  the existing implementation. When it is ready, it replaces the old stack in
  one switch; the two are never supported side by side.
- **Programs usable** on the new stack: Sway with Foot, ScummVM, Freeciv,
  the SDL2 and modeset demos, and the GLES2/EGL conformance runner.
- **Browsers in this order:** Firefox, then WebKit, then Chromium (Chromium is
  expected to be easiest).

## Non-goals for iteration 1

- OpenGL ES 3.0 (iteration 2). ES3 context requests keep failing with
  `EGL_BAD_MATCH`.
- WebGPU in any form (later iteration; see Open questions).
- Quake. TyrQuake ships only its software renderer; its GL renderer targets
  desktop OpenGL 1.x.
- Programs outside the graphics group. The kernel copy-in path that serves
  them is iteration 1b.
- GL rendering on Node beyond today's embedder-supplied capability (see Node).
- A native (non-JavaScript) host backend; the design keeps room for one.
- Rewriting GBM, `libwayland-egl` or `libdrm`. They stay as they are unless an
  interface with the new EGL requires a change.

## Anti-goals

- **Legacy infection.** Builders must not read or port `host/src/webgl`,
  `libc/glue/libglesv2_stub.c`, `libc/glue/libegl_stub.c`, `gl_abi.h`, or the
  architecture documentation's description of their internals. Permitted
  sources: Khronos specifications (OpenGL ES 2.0.25, GLSL ES 1.00, EGL 1.5 and
  the extensions Kandelo advertises), the WebGL 2 and GLSL ES 3.00
  specifications, Mesa as a design reference, recorded browser-defect
  findings (`docs/browser-support.md`, `tests/runtime-workarounds/`), the
  kernel DRM code being extended, and conformance results.
- **Two models.** No compatibility layer, feature flag or fallback to the old
  stack. The old stack is deleted in the switch.
- **Hidden round trips.** A GL call that the model can answer must not reach
  the GPU worker. Round trips are counted in tests.
- **Blocking executors.** The GPU worker never blocks; the kernel worker never
  waits on the GPU.
- **Guest pointers as physical offsets**, or executor state in group pages.
- **Disguised failure.** An executor-side failure the model did not predict is
  a driver defect or resource exhaustion and is reported as such (diagnostic
  plus context reset); it is never swallowed.

## Constraints

- **Rust-first** (`docs/agent-guidance/host-runtime.md`): policy and semantics
  in Rust; JavaScript executes platform effects. Never instantiate
  `CentralizedKernelWorker` on the main thread.
- **Browser-first, by maintainer decision.** Node keeps protocol parity and
  its current renderer boundary (see Node). The difference is documented in
  `docs/browser-support.md` and `docs/architecture.md`.
- **Memory:** the main thread never owns a VFS `SharedArrayBuffer`; persistent
  browser/audio realms never receive guest memory. The GPU worker is a
  disposable kernel-owned worker. WebKit/JSC charges declared memory ceilings
  at construction (`host/src/runtime-memory-profile.ts`).
- **ABI** (`docs/agent-guidance/abi.md`): the ABI-56 base program surface
  is frozen so that saved programs stay valid
  (`docs/persistent-program-compatibility.md`). The guest reaches kgpu
  through a versioned program extension, `kandelo.kgpu.v1`, following the
  `kandelo.klog.v1` precedent (`docs/program-extensions.md`), not through
  new ioctls. Only programs that import it, the GL programs, carry the new
  requirement; every other program keeps its identity. The kernel–host
  transport bumps `HOST_ADAPTER_VERSION`. The command-stream format and the
  kernel–executor protocol carry their own version constants. No
  compatibility shims.
- **Graphics memory groups** are a preview (`docs/shared-memory-groups.md`):
  members trust each other; plugin-loading programs (dynamic side modules)
  and `vfork` are outside the preview. WebKit is experimental, and repeated
  live desktop replacement can time out there. Because WebKit usability is an
  iteration-1 bar, fixing the group defects WebKit exposes is in scope.
- **Moving programs into the group** (maintainer decision): the standalone
  Freeciv and ScummVM demos, the SDL2 and modeset demos and the conformance
  runner launch with `executionBackend: "memory-group"`. Programs that load
  plugins must use a build without them (for example `scummvm-static`) or
  wait for side-module support in groups.
- **Fork-instrumented packages** link the new library like any other code;
  `scripts/run-wasm-fork-instrument.sh` and the shared-memory instrumenter
  must accept it.

## Approaches considered

**Where the GPU work runs** (maintainer chose B): (A) on the kernel thread
inside the kernel module; (B) in its own module and kernel-spawned worker
from the start; (C) its own module, first on the kernel thread then moved.
B builds the end state once; C only defers the worker work.

**Where the GL state model lives** (maintainer chose i): (i) a Rust
userspace library in each program, as Mesa does, so modeled answers need no
trip at all; (ii) one model inside the GPU worker, which still needs a trip
for answers it already knows. The authority split follows Linux: the kernel
owns the device, memory and execution; the userspace driver owns GL meaning.

**Programs outside the group** (maintainer decision): move the needed
programs into the group now; ship kernel copy-in as iteration 1b.

**Migration** (maintainer decision): clean-room implementation with a hard
switch, rather than porting the TypeScript or running the two side by side.

## Design

### Components and authority

| Component | Owns | Does not own |
| --- | --- | --- |
| Userspace driver (new Rust crate, built as the `libEGL`/`libGLESv2` static libraries) | EGL displays, configs, contexts and surfaces; the full GLES2 state model per context and share group; object names; validation and error state; GLSL ES front end, link rules and reflection; ES2-over-WebGL 2 lowering (formats, cube maps, fixed-point attributes, index types and similar); encoding the low-level command stream; fence and wait requests | Device memory, scheduling, other processes' objects, display state |
| Kernel (`crates/runtime-core`, `crates/kernel`) | DRM device ABI and fds; GPU contexts as kernel objects; GEM/BO handles and lifetimes; DRM master and KMS; dma-fence/syncobj/sync-file; translating submitted ranges into graphics-memory descriptors and pinning them; the submission queue; parking and completing waits; GPU worker spawn, supervision, fault and teardown; process lifecycle cleanup | GL semantics |
| GPU executor (new Rust Wasm module in the GPU worker) | Decoding command streams once into private memory; enforcing per-context object isolation and bounds; mapping driver object names to WebGL 2 objects; issuing backend calls; presentation and KMS scanout composition (gamma, cursor); reporting completions, fence signals, vblank and faults | Any GL-level meaning |
| GPU worker shell (TypeScript) | Worker bootstrap; the WebGL 2 import surface; the transferred canvas; the event loop (`requestAnimationFrame`, timers); doorbell wiring | Decisions about commands |

The executor and userspace driver are both part of the Kandelo product,
versioned with the kernel. The executor is a separate module so GPU execution
runs on its own thread now and can be sandboxed separately later.

### The command stream

- A new, low-level, WebGL 2-shaped command format, defined once in Rust and
  shared by the userspace driver and the executor. It is the "GPU's
  instruction set": it describes backend operations the driver has already
  validated and lowered, not GLES2 calls.
- Object references use driver-chosen names scoped to a kernel GPU context;
  the executor rejects any reference outside the submitting context's share
  group. Cross-process sharing happens only through kernel BOs (dma-buf,
  `EGLImage`).
- Commands carry inline data or descriptors of payload ranges in graphics
  memory.
- The format has its own version constant; a mismatch between driver and
  executor fails loudly at context creation.

### Modeled answers and real waits

- The model is authoritative for errors and state: `glGetError`, `glGet*`,
  `glIs*`, object parameters, framebuffer completeness, compile and link
  status, active attributes and uniforms, and locations are answered in
  process.
- The driver's GLSL ES 1.00 front end decides compile and link results and
  reflection, and emits GLSL ES 3.00 for WebGL 2. If the browser rejects
  translated output the driver accepted, that is a driver defect, surfaced
  loudly through the fault path.
- Real waits: `glReadPixels` and other readback, `glFinish`, query results,
  `eglClientWaitSync` and similar fence waits, and swap throttling. These go
  through kernel fences or readback requests and park only the calling
  thread.
- `GL_OUT_OF_MEMORY` and context loss originating in the browser arrive
  asynchronously; the driver reports them through `GL_KHR_robustness` reset
  status and the next error query, matching how a GPU reset reaches a Mesa
  driver.

### Graphics memory, descriptors and pinning

- The GPU worker receives the graphics group's shared backing
  `WebAssembly.Memory` once; the backing lives as long as the machine. The
  executor module does not import it: Rust cannot address a second memory,
  and multi-memory support is not uniform across engines. Instead the worker
  shell copies each command range named by a descriptor into executor memory
  (the single read the read-once rule requires), and payload descriptors are
  resolved by the backend imports into views over the backing.
- Submissions name virtual ranges. The kernel translates them into scatter
  lists of physical extents (64 KiB pages, possibly discontiguous), pins the
  pages and queues the descriptors. Pins release when the executor retires the
  work.
- Each command is read once into executor memory before it is acted on,
  because group members can change shared memory at any time. Large payloads
  pass from the backing to WebGL 2 through shared views without an
  intermediate copy.
- Iteration 1b adds kernel copy-in to staging pages in the same backing for
  programs outside the group; the executor cannot tell the difference.

### Kernel–executor protocol

- Bounded rings in a kernel-owned shared buffer: submissions and control
  (context, BO, display) from kernel to executor; completions (retirement,
  fence signals, readback done, present and flip done, vblank, faults) back.
- KMS display effects travel in the same ordered ring as GPU work, so a flip
  cannot overtake the rendering it shows.
- The executor wakes on a non-blocking doorbell, drains, calls the backend and
  returns to the event loop, where WebGL updates sync status and presents.
- A full ring parks the submitting thread in the kernel; the kernel never
  blocks.
- Signals, exit and exec during a parked wait follow the kernel's existing
  completion rules; pinned pages stay pinned until retirement.
- Formats are defined once in `crates/shared`.

### Presentation and KMS

- The KMS canvas is transferred to the GPU worker. Scanout of GPU and CPU
  buffers, `2d`/bitmap modes, gamma, cursor composition and `eglSwapBuffers`
  presentation run in the executor; the `requestAnimationFrame`-aligned vblank
  clock runs in the GPU worker and reports through completions.
- The kernel remains the KMS authority: it validates and commits KMS state and
  issues display effects.

### Fences

Kernel dma-fence, syncobj and sync-file objects stay authoritative
(`crates/runtime-core/src/dri/fence.rs`). GPU fences signal from executor
completions. The rule that fences on the shared native context start signaled
does not carry over: a fence is pending until its work retires.

### Backends

The executor calls the platform through a Rust backend interface:

- WebGL 2 over JavaScript imports, in the GPU worker;
- a recording backend for native `cargo test`;
- a null backend, and the embedder-supplied WebGL 2 path, for Node.

The import crossing style (per call or batched) is chosen by measurement in
the first slice. WebGPU and native (wgpu or Dawn) backends come later.

**Crossing decision (slice 1, measured 2026-11-27):** one import per
backend call. Over 10,000 viewport-and-clear pairs, a batched variant (one
`run_batch(ptr, len)` import running a compact call list in JavaScript)
was 0 to 4 ns per call slower on Firefox and Chromium. On WebKit it was 5
to 11 ns faster, against 9 to 10 ns of run-to-run spread. The per-call
medians were about 69 ns on Firefox and Chromium and 195 ns on WebKit,
mostly the JavaScript backend's work and its WebGL 2 calls rather than the
crossing. The batched variant was deleted. Method, engine versions and
every run are in `docs/measurements/2026-11-27-kgpu-crossing.md`. Re-measure
with `apps/browser-demos/test/kgpu-crossing-bench.spec.ts` once commands
that carry more work per call (uploads and draws) exist.

### Node

The kernel, rings, pinning, parking and executor run on Node. Without an
embedder-supplied WebGL 2 context the executor uses the null backend and
`eglInitialize` fails with `EGL_NOT_INITIALIZED`, as today. An
embedder-supplied context keeps working through the WebGL 2 backend in a Node
worker.

### Threads and fork

The driver is thread-safe; contexts are current per thread as EGL requires.
After `fork`, the child inherits the library's memory but not the parent's
kernel GPU contexts; using an inherited context fails as on Linux, and the
child may initialize EGL anew.

## Testing and acceptance

- **Driver unit tests (native, seconds):** the state model, validation,
  errors, GLSL front end and lowering, against the recording backend. Tests
  also count round trips: modeled calls must produce none.
- **Executor and kernel tests (native and Node):** stream decoding,
  isolation, bounds, pinning, parking, cancellation and teardown.
- **Conformance:** dEQP GLES2 and EGL (`scripts/run-graphics-cts.sh`), run
  inside the graphics group, in Firefox, WebKit and Chromium. Results are
  recorded per family; acceptance requires the families the target programs
  use, and all results are reported.
- **Fast regression replays:** recorded command streams from the target
  programs, replayed through the executor with expected images saved from the
  new stack after visual review.
- **Live usability** of Sway+Foot, ScummVM, Freeciv and the SDL2 and modeset
  demos, in Firefox, then WebKit, then Chromium. "Usable" means a person can
  operate each program normally without stalls or visual defects.
- **Measured account** for Sway+Foot against the pre-switch develop: terminal
  open/close, focus latency, CPU and browser memory. Recorded, not a gate.
- `./run.sh test browser-memory` for memory and lifecycle changes.

## Delivery slices

Development happens on an integration branch; the switch lands as one
reviewed series.

1. **Execution foundations:** command-stream format; executor module; GPU
   worker spawn/teardown; rings and doorbell; WebGL 2, recording and null
   backends; kernel GPU contexts, descriptors, pinning, submission and parking.
   A small test program clears and presents a frame. Measure crossing cost.
2. **Userspace driver skeleton:** Rust `libEGL`/`libGLESv2` static libraries
   linked through the SDK into C programs (including fork-instrumented ones);
   EGL on GBM, Wayland and surfaceless; clear and swap.
   *As built (2026-11-28):* one archive, `libkandelo_gl.a`, with EGL on the
   surfaceless platform and pbuffers only. GBM and Wayland moved to slice 5.
   Window swap on them needs a present path and a buffer tier the kgpu
   executor does not have yet, and today `libgbm` and `libwayland-egl` hand
   EGL old-stack buffers, so changing them would change the live old stack.
   See the [slice 2 plan](2026-11-28-rust-gpu-slice2-plan.md).
3. **State model by area,** driven by conformance families: buffers, textures
   and formats, framebuffers, draw state, drawing, queries and errors.
4. **GLSL ES 1.00 front end,** link rules, reflection and GLSL ES 3.00 output.
5. **Presentation and KMS** in the GPU worker; fences from completions;
   EGL on GBM and Wayland (moved from slice 2).
6. **Programs into the group:** demos and conformance runner.
7. **Bring-up** of Sway+Foot, ScummVM, Freeciv, SDL2 and modeset in Firefox,
   then WebKit (including group defects found there), then Chromium.
8. **Switch:** delete `host/src/webgl`, the synchronous `host_gl_*` imports
   and the C GL/EGL libraries; bump versions; update `docs/architecture.md`,
   `docs/browser-support.md`, `docs/graphics/compatibility-v1.md` and
   `docs/future-improvements.md`.

## Risks

- **GLSL ES front end** is the largest single component; an existing Rust
  parser crate may help, but ES 1.00 semantics and link rules are the work.
- **Library size** in every GL program; measure, and consider sharing later.
- **Rust static library in C programs**: allocator, panic handling and
  duplicate standard-library copies when the program is itself Rust.
- **Worker platform differences:** `requestAnimationFrame` and
  `OffscreenCanvas` in dedicated workers and `Atomics.waitAsync` vary by
  engine; verify in slice 1.
- **WebKit group defects** now block the WebKit bar.
- **Recorded browser defects** that the old stack worked around must be
  re-addressed from the defect records, not from its code.

## Left to the builder

Crate and module names; command and ring encodings; doorbell mechanism;
backend crossing style (by measurement); the order of areas within slice 3;
which GLSL parsing crate, if any.

## Open questions

- WebGPU: should guest programs use WebGPU directly, should WebGPU be an
  executor backend under GL, or both? Decides the WebGPU iteration's shape.

## Later iterations

- **1b:** kernel copy-in for programs outside the group.
- **2, ES 3.0:** extend the userspace driver to ES3 contexts and GLSL ES
  3.00. The recovered 2026-11-01 expansion plan's list of ES 3.0 differences
  from WebGL 2 is a specification-level input. Mapped buffers can map
  graphics-memory pages directly. dEQP-GLES3 packaging can start any time.
- **WebGPU,** per the open question.
- **Native backend** for non-JavaScript hosts.

## References

- `docs/shared-memory-groups.md`
- `docs/graphics/cts-coverage-v1.md`, `docs/graphics/conformance-testing.md`
- `docs/future-improvements.md` ("Implement OpenGL ES 3.0 contexts")
- Recovered 2026-11-01 expansion plan and the 2026-11-09 campaign plan, kept in
  this worktree's `.context/gles3-webgpu/`
- mho22's `wgpu-window` package and Rust standard library work: commit
  `145f37cde2`
