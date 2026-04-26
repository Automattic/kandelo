# Framebuffer (`/dev/fb0`) + fbDOOM Browser Demo — Design

Date: 2026-04-26
Branch: `kernel-processes-writing-to-framebuffer`
Worktree: `.superset/worktrees/wasm-posix-kernel/kernel-processes-writing-to-framebuffer/`

## §1. Goals & non-goals

**Goal.** A process running on this kernel can `open("/dev/fb0")`, query geometry/format via Linux `fbdev` ioctls, `mmap` the pixel buffer, write BGRA32 pixels, and have those pixels appear in a browser `<canvas>`. An unmodified [fbDOOM](https://github.com/maximevince/fbDOOM) build runs in `examples/browser/pages/doom/` and is playable with keyboard input. Save games persist to the in-memory VFS for the session.

**Non-goals (v1).**

- Audio (`/dev/dsp`, AudioWorklet) — separate effort.
- Mouse — keyboard only.
- Multiple framebuffer clients — `/dev/fb0` is single-open. Second `open` returns `EBUSY`.
- Multi-buffering / `FBIOPAN_DISPLAY` as a real vsync — accepted as a no-op success.
- Format negotiation via `FBIOPUT_VSCREENINFO` — kernel reports a fixed geometry/format; software either accepts it or fails. Most fbdev software is happy with whatever the device reports; fbDOOM definitely is.
- Node.js host rendering — Node host fully supports the device for tests, but does not display pixels anywhere. Visual demo is browser-only.
- Real `/dev/input/eventN` — keyboard arrives via stdin in raw termios mode, same as a real Linux console.
- Multiple framebuffers (`/dev/fb1`, `/dev/fb2`) — only `fb0`.

**Constraint.** Per CLAUDE.md "never compromise hosted software." fbDOOM gets vendored and patched only as needed for cross-compilation hygiene — never to work around platform gaps. If fbDOOM exercises an ioctl we haven't implemented, we implement it (or return a sensible default), never `#ifdef` it out.

**Success criteria.** Title screen renders, you can start a new game on E1M1, walk to the first imp, and shoot it. Save mid-level, quit, reload, continue.

## §2. Architecture

```
   ┌─ user process (wasm32) ────────────────┐
   │ fbDOOM:                                │
   │   fd = open("/dev/fb0")                │
   │   ioctl(fd, FBIOGET_VSCREENINFO, &v)   │
   │   ioctl(fd, FBIOGET_FSCREENINFO, &f)   │
   │   px = mmap(NULL, len, RW, SHARED, fd) │
   │   *(uint32_t*)(px + off) = pixel       │
   │   ioctl(fd, FBIOPAN_DISPLAY, &v)       │ (no-op success)
   └────────┬───────────────────────────────┘
            │ syscalls via channel
   ┌────────▼───────────────────────────────┐
   │ kernel (wasm64):                       │
   │   devfs: /dev/fb0 → Framebuffer device │
   │   per-process FbBinding {              │
   │     mmap_addr, mmap_len, fmt, w, h     │
   │   }                                    │
   │   on first mmap: HostIO::bind_fb(...)  │
   │   on munmap/close/exit: unbind_fb(pid) │
   └────────┬───────────────────────────────┘
            │ HostIO callbacks (no channel needed; direct host call)
   ┌────────▼───────────────────────────────┐
   │ host (TypeScript, browser):            │
   │   FramebufferRegistry:                 │
   │     pid → { addr, len, w, h, sab }     │
   │   bind_fb: cache process Memory.buffer │
   │   on memory.grow: re-bind buffer ref   │
   │   RAF loop:                            │
   │     for each bound fb:                 │
   │       view = new Uint8ClampedArray(    │
   │              sab, addr, len)           │
   │       imageData = new ImageData(       │
   │              view, w, h)               │
   │       ctx.putImageData(imageData,0,0)  │
   └────────────────────────────────────────┘
```

Three flow paths:

1. **Open / ioctl path** — runs through the existing channel-syscall machinery. `open` returns an fd backed by a new `OpenFile::Framebuffer`. `FBIOGET_VSCREENINFO` / `FBIOGET_FSCREENINFO` write fixed geometry into the user buffer. Pure kernel, no host involvement.

2. **mmap → bind path** — `mmap` on a framebuffer fd allocates a region in process memory via existing `mmap_anonymous`, then calls `HostIO::bind_framebuffer(pid, addr, len, fmt, w, h, stride)`. The host now knows where to read pixels.

3. **Unbind path** — `munmap` of the region, `close` of the last fd, or process exit drops the binding. Host stops including this fb in its RAF iteration.

**Input is independent.** Keyboard events on the canvas → `appendStdinData(pid, bytes)` (existing API from PR #126). fbDOOM's raw-termios stdin reader picks them up.

**Why no kernel→host event per frame.** The host drives present (RAF). The kernel's only job is binding/unbinding regions. `FBIOPAN_DISPLAY` triggers no host work — RAF is already running.

### Trade-offs of in-Memory binding

Why this approach rather than a separate host-allocated SAB or a kernel-side double-buffer:

- **Tearing**: host can copy mid-write. fbDOOM at 35Hz on a 1MB buffer means putImageData might catch a half-drawn frame ~once a second. Probably invisible during gameplay; accepted.
- **memory.grow invalidates the host's view**: when wasm linear memory grows, the SAB is replaced and TypedArrays bound to the old buffer detach. We re-bind on the next RAF tick. Already-existing infrastructure for syscall plumbing handles the underlying event.
- **No real vsync**: `FBIOPAN_DISPLAY` returns immediately. Software using it for frame pacing gets nothing. fbDOOM uses `gettimeofday` for pacing; doesn't care.
- **Always-on copy**: ~60MB/s of canvas work at 60Hz, negligible at 640×400. Browsers auto-pause RAF on hidden tabs.
- **Fork semantics drift from Linux**: each forked child gets a private mmap copy. DOOM doesn't fork mid-game; documented limitation.
- **Single-client only**: blocks future "X server / compositor on top" until redesign. YAGNI for v1.
- **Format lock-in**: BGRA32 is what we emit. Acceptable — most modern fbdev software is BGRA-friendly.

A separate-SAB design was considered. Wasm has no way to splice a foreign SAB into an existing `Memory` at an arbitrary address; multi-memory could give wasm code direct access but requires LLVM toolchain work or fbDOOM source patches (violating "never compromise hosted software"). Copy-on-flush via `FBIOPAN_DISPLAY` is the realistic upgrade path if tearing turns out to matter — deferred until proven necessary.

## §3. Kernel components

**New device variant** in `crates/kernel/src/devfs.rs`:

```rust
pub enum DevfsEntry { ..., Fb0 }
```

`/dev/fb0` resolves to `DevfsEntry::Fb0`. Stat as `S_IFCHR`, major/minor matching Linux fbdev convention (29, 0).

**New OpenFile variant** in `crates/kernel/src/ofd.rs`:

```rust
pub enum OpenFileKind {
  ..., Framebuffer(FbState),
}

pub struct FbState {
  width: u32,            // 640
  height: u32,           // 400
  bits_per_pixel: u32,   // 32
  // BGRA32: blue.offset=0, green=8, red=16, alpha=24
}
```

`open("/dev/fb0", O_RDWR)` enforces single-open via `FB0_OWNER: AtomicI32` (pid or `-1`). Second open returns `EBUSY`. `O_NONBLOCK`/`O_RDONLY` accepted but ignored.

**ioctls** in `sys_ioctl`:

| ioctl | Action |
|---|---|
| `FBIOGET_VSCREENINFO` (0x4600) | Fill `fb_var_screeninfo` (160 B): xres/yres = 640/400, xres_virtual/yres_virtual same, bits_per_pixel=32, RGBA bitfields for BGRA32. |
| `FBIOGET_FSCREENINFO` (0x4602) | Fill `fb_fix_screeninfo` (80 B): id="wasmfb", smem_len = 640·400·4, line_length = 2560, type=PACKED_PIXELS, visual=TRUECOLOR. |
| `FBIOPAN_DISPLAY` (0x4606) | Read `fb_var_screeninfo`, ignore, return 0. |
| `FBIOPUT_VSCREENINFO` (0x4601) | Validate that requested geometry matches our fixed values; if not, return `EINVAL`. |
| anything else | `ENOTTY`. |

Wire layout for both structs is the canonical Linux ABI; the project already does this for termios.

**mmap path** in `sys_mmap`:

When `fd` is a `Framebuffer`, instead of file-backed mapping:

1. Allocate `len` (must equal `smem_len`) via `process.memory.mmap_anonymous(...)`.
2. Record `FbBinding { pid, addr, len, w, h, stride, fmt }` in a process-side field `Process::fb_binding: Option<FbBinding>`.
3. Call `host_io.bind_framebuffer(pid, addr, len, w, h, stride, fmt)`.

A second mmap on the same fd returns `EINVAL` (one binding per process).

**Cleanup**:

- `munmap` covering the region: clear `fb_binding`, call `host_io.unbind_framebuffer(pid)`.
- `close` of last fb fd: drop `FB0_OWNER`. Binding stays alive — Linux semantics: mmap survives close; only cleared on munmap or exit.
- Process exit / exec: clear `fb_binding`, call `unbind_framebuffer(pid)`, drop `FB0_OWNER` if owned.
- `fork`: child gets a copy of the mmap region (existing behavior). For DOOM (single process) we don't bind the child; if a forked child later does its own `open + mmap`, it goes through the normal path. Documented as a known limitation.

**HostIO trait additions**:

```rust
fn bind_framebuffer(&mut self, pid: i32, addr: usize, len: usize,
                    w: u32, h: u32, stride: u32, fmt: FbFormat);
fn unbind_framebuffer(&mut self, pid: i32);
```

Both are infallible from the kernel's POV — failures (e.g., no canvas bound on host) are logged host-side and silently ignored; the process still gets a working memory region, just no visible output. (Matches Node-as-test-host: kernel is fully exercised, no display.)

**ABI impact**: new ioctl numbers (kernel-internal switch arms, not snapshot-visible), two new marshalled `repr(C)` structs `FbVarScreenInfo` (160 B) + `FbFixScreenInfo` (80 B) — these are snapshot-visible per CLAUDE.md. New `HostIO` trait methods are host-imported, not kernel-exported, so likely not snapshot-visible. No channel layout change, no syscall numbers added (open/ioctl/mmap are existing). `scripts/check-abi-version.sh update` after implementation; expect `ABI_VERSION` bump 4 → 5.

## §4. Host components

**New module** `host/src/framebuffer/registry.ts`:

```ts
type FbBinding = {
  pid: number;
  addr: number;     // offset into process Memory
  len: number;
  w: number; h: number; stride: number;
  fmt: 'BGRA32';
  // Cached views — invalidated on memory.grow:
  view: Uint8ClampedArray | null;
  imageData: ImageData | null;
};

export class FramebufferRegistry {
  private bindings = new Map<number, FbBinding>();
  bind(b: Omit<FbBinding,'view'|'imageData'>): void;
  unbind(pid: number): void;
  get(pid: number): FbBinding | undefined;
  rebindMemory(pid: number, newSab: SharedArrayBuffer): void;  // memory.grow
  list(): FbBinding[];
  onChange(fn: (pid: number, ev: 'bind'|'unbind') => void): () => void;
}
```

The registry holds *pure metadata + cached views*. It owns no canvas. Wired into the HostIO implementation: `bind_framebuffer` → `registry.bind(...)`, `unbind_framebuffer` → `registry.unbind(pid)`.

**memory.grow integration.** The kernel host already tracks per-process Memory via the existing process registry (used for syscall arg copying). Hook the existing "memory replaced" path so any `FbBinding` for that pid gets `view` and `imageData` set to `null`; the next RAF tick re-builds them from the new SAB. No new event channel needed — piggyback on what's already there.

**Browser side** — `host/src/framebuffer/canvas-renderer.ts`:

```ts
export function attachCanvas(
  canvas: HTMLCanvasElement,
  registry: FramebufferRegistry,
  pid: number,
): () => void {
  const ctx = canvas.getContext('2d', { alpha: false })!;
  let raf = 0;
  const tick = () => {
    const b = registry.get(pid);
    if (b) {
      if (!b.view) {
        const sab = getProcessMemorySab(pid);
        b.view = new Uint8ClampedArray(sab, b.addr, b.len);
        b.imageData = new ImageData(b.view, b.w, b.h);
      }
      ctx.putImageData(b.imageData!, 0, 0);
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
```

Canvas size is set to `w × h` CSS pixels with `image-rendering: pixelated` so 640×400 scales to whatever the layout gives it without blur. The renderer is ignorant of DOOM — it blits whatever bytes the registry points at.

**Node side** — `host/src/framebuffer/node-renderer.ts` is a no-op stub that consumes the registry but produces no visible output. Lets kernel tests run end-to-end on Node without `if (browser)` branches in shared code.

**Input pipeline** — separate from rendering, lives in the demo page (not in `host/`):

```ts
const KEY_MAP: Record<string, Uint8Array> = {
  'ArrowUp':    new Uint8Array([0x1b, 0x5b, 0x41]),
  'ArrowDown':  new Uint8Array([0x1b, 0x5b, 0x42]),
  'ArrowRight': new Uint8Array([0x1b, 0x5b, 0x43]),
  'ArrowLeft':  new Uint8Array([0x1b, 0x5b, 0x44]),
  'Enter':      new Uint8Array([0x0d]),
  'Escape':     new Uint8Array([0x1b]),
  'Space':      new Uint8Array([0x20]),
  // ... y/n, ctrl combos, letters via event.key
};

canvas.addEventListener('keydown', e => {
  const bytes = KEY_MAP[e.code] ?? new TextEncoder().encode(e.key);
  kernel.appendStdinData(pid, bytes);
  e.preventDefault();
});
```

Canvas needs `tabindex="0"` to receive keyboard focus. Auto-focus on click.

**Why the renderer is its own module rather than living in `BrowserKernel`.** Keeps the platform/application boundary clean per CLAUDE.md (`BrowserKernel` doesn't know about canvases). The DOOM page wires it explicitly: `attachCanvas(canvas, kernel.framebuffers, pid)`.

## §5. fbDOOM port

**Source**: `https://github.com/maximevince/fbDOOM`, `fbdoom/` subdir is the actual fbdev frontend (there's also a `chocdoom/` tree we ignore). Pure C, ~30k LoC, one Makefile.

**Build script** `examples/libs/fbdoom/build-fbdoom.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
SRC=fbdoom-src
[ -d "$SRC" ] || git clone --depth 1 https://github.com/maximevince/fbDOOM "$SRC"

cd "$SRC/fbdoom"
make CC=wasm32posix-cc \
     LD=wasm32posix-cc \
     CFLAGS="-O2 -DNORMALUNIX -DLINUX -D_DEFAULT_SOURCE" \
     LDFLAGS="" \
     NOSDL=1

# fork-instrument is the last wasm pipeline step (per project convention)
"$REPO_ROOT/tools/bin/wasm-fork-instrument" fbdoom fbdoom.wasm
```

Expected gotchas, in order of likelihood:

- **Audio backend**: fbDOOM compiles `i_sound.c` even with `NOSDL=1`. Use the fbDOOM-shipped null backend (already in tree) — not a patch, just a Makefile selection.
- **`<linux/fb.h>`**: fbDOOM includes the Linux header for the structs and ioctls. Add a minimal `sysroot/include/linux/fb.h` with the structs and ioctl numbers fbdev software expects. Sysroot addition, not an fbDOOM patch.
- **`<linux/kd.h>` / `KDSKBMODE`**: some fbDOOM forks do raw scancode mode. Maximevince's branch uses plain termios — verify on first build, deal with it then. Don't pre-emptively patch.
- **`gettimeofday` / `nanosleep`**: already implemented; fine.
- **fork-instrument**: DOOM doesn't fork, but per project convention every binary goes through `wasm-fork-instrument` as the last step.

**WAD asset**: bundle `doom1.wad` (freely redistributable shareware WAD, ~4 MB). Lazy-load via existing `MemoryFileSystem.registerLazyFile()` (PR #206) so the page loads fast and the WAD is fetched on first read.

**Filesystem layout in the demo**:

```
/usr/local/games/doom/doom1.wad   (lazy, read-only)
/home/doom/                       (writable, holds savegames + .cfg)
```

fbDOOM looks for the WAD via `-iwad` (we pass `-iwad /usr/local/games/doom/doom1.wad`) and writes savegames to `$HOME` (set `HOME=/home/doom`). Saves persist for the session via the existing in-memory VFS — they survive new-game/load-game/quit-and-restart-the-process within a tab, but not page reload. Page-reload persistence is a future enhancement via OPFS or IndexedDB; out of scope.

**Demo page** `examples/browser/pages/doom/`:

```
index.html    <canvas tabindex=0> + start button
main.ts       wires:
              1. kernel boot
              2. lazy-register doom1.wad
              3. attachCanvas(canvas, kernel.framebuffers, doomPid)
              4. keyboard listener → appendStdinData
              5. spawn fbdoom.wasm with -iwad ...
```

Total surface: one HTML page, one TS file ~80–120 lines, plus the existing browser-kernel scaffolding.

## §6. Testing strategy

Three layers, scoped to what each catches.

**Cargo unit tests** (`crates/kernel/src/devfs.rs`, `ofd.rs`, `syscalls.rs`):

- `/dev/fb0` resolves via `match_devfs_*`, stats as `S_IFCHR` with the right ino/major/minor.
- `open("/dev/fb0", O_RDWR)` returns an fd; second open returns `EBUSY`; close releases ownership.
- `FBIOGET_VSCREENINFO` writes 160 bytes with `xres=640, yres=400, bits_per_pixel=32` and BGRA32 bitfields at the right offsets.
- `FBIOGET_FSCREENINFO` writes 80 bytes with `id="wasmfb"`, `smem_len = 640·400·4`, `line_length = 2560`.
- `FBIOPAN_DISPLAY` returns 0; `FBIOPUT_VSCREENINFO` with mismatched geometry returns `EINVAL`; unknown ioctl returns `ENOTTY`.
- `mmap(fb_fd)` allocates a region in process memory, records `FbBinding`, and a mock `HostIO` records one `bind_framebuffer` call with the right args.
- `munmap` of that region calls `unbind_framebuffer`. Process exit calls `unbind_framebuffer` if a binding exists. `fork` does not auto-bind the child.
- `mmap` twice on the same fd → `EINVAL`. `mmap` of a non-fb fd unaffected (regression guard).

**Vitest integration test** (`host/test/framebuffer.test.ts`):

A tiny C program — `examples/test-programs/fbtest.c` — built into the test fixtures:

```c
int fd = open("/dev/fb0", O_RDWR);
struct fb_var_screeninfo v; ioctl(fd, FBIOGET_VSCREENINFO, &v);
struct fb_fix_screeninfo f; ioctl(fd, FBIOGET_FSCREENINFO, &f);
uint32_t* px = mmap(NULL, f.smem_len, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0);
// Write a known pattern: row r, col c → 0xFF000000 | (r << 16) | c
for (int r = 0; r < v.yres; r++)
  for (int c = 0; c < v.xres; c++)
    px[r * v.xres + c] = 0xFF000000u | ((uint32_t)r << 16) | (uint32_t)c;
write(1, "ok\n", 3);
pause();
```

Test runs the program via `centralizedTestHelper`, waits for `"ok\n"` on stdout, then asserts:

- The `FramebufferRegistry` has exactly one binding for `pid`.
- Reading the bound region from the process Memory SAB produces the known pattern (sample 4–8 pixels at fixed coords).
- Sending SIGTERM clears the binding.

Plus a smaller test that opens `/dev/fb0` twice and asserts the second `open` fails with `EBUSY`, and a test that asserts ioctl byte-layout matches the structs musl ships in `<linux/fb.h>`.

**Manual browser verification** (the actual DOOM demo):

Per CLAUDE.md "for UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete." Concretely:

1. Title screen renders within ~5s of clicking Start.
2. Arrow keys navigate the main menu; Enter starts a new game.
3. E1M1 loads, player can walk forward (up arrow), strafe, fire (Ctrl).
4. Save game (F2) and load game (F3) round-trip across a process restart within the same tab.
5. Frame rate is "playable" (eyeball test, target ≥20 fps).

No Playwright pixel-comparison: DOOM is non-deterministic (random imp behavior, RNG-seeded), and a pixel-perfect test would be brittle. The Vitest test is what guards the framebuffer plumbing; the DOOM demo is the integration smoke test.

**Full project test gauntlet** per CLAUDE.md (all five suites + ABI snapshot must pass with zero regressions):

1. `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
2. `cd host && npx vitest run`
3. `scripts/run-libc-tests.sh`
4. `scripts/run-posix-tests.sh`
5. `scripts/run-sortix-tests.sh --all`
6. `bash scripts/check-abi-version.sh`

## §7. ABI & rollout

**ABI surface added**:

- New ioctl numbers (`FBIOGET_VSCREENINFO=0x4600`, etc.) — *user-space* constants matched by switch arms in `sys_ioctl`. Don't change the channel layout or any `repr(C)` struct already in `abi/snapshot.json`.
- New `repr(C)` structs `FbVarScreenInfo` (160 B) and `FbFixScreenInfo` (80 B). Per CLAUDE.md, marshalled `repr(C)` structs are ABI-relevant — they'll show up in the snapshot.
- New `HostIO` trait methods `bind_framebuffer` / `unbind_framebuffer` — host-imported, not kernel-exported. Per the snapshot's "kernel-wasm exports" rule, host imports aren't tracked, so likely not snapshot-visible.
- No new syscall numbers, no channel header changes, no asyncify slot changes, no new exported `kernel_*` functions.

**Procedure**:

1. Implement the kernel + host work.
2. Run `bash scripts/check-abi-version.sh update` and inspect `git diff abi/snapshot.json`.
3. If the snapshot grew the two new structs (expected): bump `ABI_VERSION` in `crates/shared/src/lib.rs` (4 → 5), commit both files together.
4. If only host-imports changed and the structural snapshot is unchanged: no version bump needed — but verify, don't assume.

**Rollout sequencing.** Three independently-reviewable PRs, *opened as work progresses* but **held — none merged — until the browser demo runs end-to-end and the user confirms**. Manual browser verification of fbDOOM is the validation gate for the whole stack; landing kernel work without the demo means landing untested ABI surface.

1. **PR #1 — Kernel fbdev surface + tests.** devfs entry, ofd variant, ioctls, mmap binding, unit tests. No host glue yet; bind/unbind callbacks are dead.
2. **PR #2 — Host registry + Node stub + Vitest.** `FramebufferRegistry`, `bind_framebuffer` wired into `HostIO` impls, integration test using `fbtest.c`.
3. **PR #3 — Browser canvas renderer + DOOM demo.** `attachCanvas`, demo page, fbDOOM build script + WAD lazy-load, manual browser verification.

After demo confirms, merge in order #1 → #2 → #3. Each is self-contained; reverting any one is mechanically clean.

**Doc updates** per CLAUDE.md "every PR that adds user-facing features must include corresponding documentation updates":

- `docs/posix-status.md` — add fbdev row.
- `docs/architecture.md` — short framebuffer subsection covering the bind model.
- `docs/browser-support.md` — note canvas/keyboard requirements.
- `README.md` — fbDOOM in the "Software ported" list.
- `docs/abi-versioning.md` — no change; structs already covered by existing policy.
