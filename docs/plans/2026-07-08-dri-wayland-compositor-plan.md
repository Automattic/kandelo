# DRI v2 — Wayland-first compositor plan (SUPERSEDES the custom-protocol compositor)

Date: 2026-07-08
Branch: `explore-dri-sdl2`
Worktree: `/Users/mho/emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-direct-rendering-infrastructure-9vbaz`

> **Status:** This document supersedes `2026-07-13-wpkcompositor-plan.md`
> and amends `2026-05-18-dri-design.md` (§9.2, §9.5, §15) plus the
> greenfield plans 8/10/11. It is the authoritative roadmap for the top
> half of the DRI stack. The lower half (milestones A–D: buffer sharing,
> multiplexer, KMS, evdev, ALSA, SDL2) is **done and tested** and is not
> changed by this pivot.

---

## §1. The decision

After landing SDL2 (plan 7 / PR #709, the last foundation milestone), the
project pivots the **compositor and userland** half of DRI from a bespoke
in-house wire protocol to **Wayland**, the Linux-standard display protocol.

Two locked decisions (confirmed with the user):

1. **Wayland-first — REPLACE the custom compositor.** The unbuilt custom
   compositor (`wpkcompositor` + `libwpkclient` + the 24-message custom
   wire of dri-design §9.2) is dropped before it is written. Kandelo's own
   seed apps become **Wayland clients** speaking the real protocol.

2. **Own Wayland-native apps first.** v1 ships a thin in-house toolkit
   (`libkwl`) over `libwayland-client`, and Kandelo-authored apps on top of
   it. Running *unmodified* upstream GTK/Qt applications is a real,
   explicitly-named goal but is scoped **post-v1** (it pulls in glib,
   cairo, pango, pixman, and full libffi — see §7).

**Why Wayland.** Adopting the Linux-standard protocol means (a) Kandelo's
future apps are portable to real Linux and real Wayland compositors, (b)
the eventual GTK/Qt app-compat milestone reuses the same compositor rather
than needing a second protocol bridge, and (c) we validate the kernel's
Unix primitives (AF_UNIX + SCM_RIGHTS + epoll) against a large, real,
unmodified C codebase (`libwayland`) instead of a codebase we wrote to fit
what the kernel already does.

---

## §2. Feasibility — every kernel primitive Wayland needs already exists

This was verified against the kernel during exploration and is **not** open
work. The pivot rests on it:

| Wayland needs | Kernel has it | Where |
|---|---|---|
| AF_UNIX stream sockets (bind/listen/accept/accept4/connect/socketpair, `SOCK_CLOEXEC`/`SOCK_NONBLOCK`) | ✅ | `crates/kernel/src/unix_socket.rs`, `syscalls.rs` ~7252–7550 |
| `SCM_RIGHTS` fd-passing via `sendmsg`/`recvmsg` ancillary data | ✅ | `crates/kernel/src/wasm_api.rs` ~6342–6674 (`extract_scm_rights` / `install_scm_rights_fds`) |
| `poll`/`pselect6`/`ppoll`/`epoll_create1`/`epoll_ctl`/`epoll_wait`/`eventfd2`/`timerfd`/`signalfd` | ✅ | `syscalls.rs` |
| **Blocking that actually parks** — kernel returns `EAGAIN`, host worker parks + retries on event wakes with a 1 ms fallback, so `libwayland`'s epoll `wl_event_loop` runs directly | ✅ | `syscalls.rs:7928–7944`, `:9491`; `host/src/kernel-worker.ts:242,2222,2509` |
| GBM prime-fd / dumb-bo allocation + mmap | ✅ | `crates/kernel/src/dri/bo.rs`, `syscalls.rs` ~809–1013 |
| KMS single-CRTC + vblank/page-flip pump | ✅ | `crates/kernel/src/dri/mod.rs` `drain_pending_flips`, `syscalls.rs` ~1219–1614 |
| N-guest→1-host GL multiplexer | ✅ | `host/src/webgl/muxer.ts`, `submit-queue.ts` |
| evdev input | ✅ | `crates/kernel/src/input/` |
| ALSA audio | ✅ | `crates/kernel/src/audio/` |

The single hardest feasibility worry — *does a blocking `epoll_wait`/`poll`
inside a real C event loop actually suspend and resume?* — is resolved: it
does. `libwayland`'s `wl_event_loop` is an epoll loop, and it runs unmodified.

**GPU-tier note.** `DRM_IOCTL_WPK_CREATE_GPU_BO` / `WPK_BIND_FOREIGN_TEXTURE`
constants exist (`crates/shared/src/lib.rs` ~2192–2199) but are **not
dispatched** yet. v1 compositing therefore uses `wl_shm` (CPU tier): the
client renders into a dumb-bo, passes the prime-fd over `SCM_RIGHTS`, and the
compositor CPU-blits it into the scanout bo. GPU-tier + `zwp_linux_dmabuf_v1`
is the post-v1 GL milestone (F′, §7).

---

## §3. New ports required

Nothing Wayland-related is in `packages/registry/` today. Four new pieces:

| Port | Kind | Risk | Notes |
|---|---|---|---|
| **libffi** (Wayland-scoped shim) | wasm32 static lib | **the one gating risk** | No wasm32 libffi exists upstream (only vendored copies inside cpython/spidermonkey). We do **not** port full libffi — see §4. **DONE (PR1).** |
| **wayland-scanner** | HOST build tool | low | Generates C glue from protocol XML. Provided via **`flake.nix`** (`pkgs.wayland-scanner` 1.24.0, darwin+linux clean — the split `-bin` derivation, NOT the Linux-only `wayland` lib), consumed via `[[host_tools]]`. **DONE (PR2).** |
| **wayland-protocols** | XML data (`kind = "source"`) | none | Protocol `.xml` **vendored in-tree** (`packages/registry/wayland-protocols/xml/`): `wayland.xml` 1.24.0 + `xdg-shell.xml` 1.45. Vendored because core `wayland.xml` ships only in the Linux-only `wayland` lib. **DONE (PR2).** |
| **libwayland** (client + server) | wasm32 static lib | medium | Depends on libffi + the AF_UNIX/SCM_RIGHTS/epoll surface above. **MUST pin wayland 1.24.0** to match the vendored `wayland.xml` and the host scanner. |

**PR2 result (2026-07-08).** The host toolchain is proven end-to-end:
`wayland-scanner` 1.24.0 (flake) generates client/server/private-code for
the full v1 interface set from the vendored XML, and the generated
private-code compiles cleanly for wasm32 against our sysroot (23
`wl_*_interface` symbols; core + xdg-shell). Gate:
`host/test/wayland-protocols-scanner.test.ts`. The one remaining
integration point — compiling the generated glue against libwayland's
`wayland-util.h` in the wasm sysroot — lands with PR3 (the scanner-side
compile was verified manually with the upstream 1.24.0 header).

Reusable across the port regardless of protocol (already scheduled by the
old plan's Phases A/B): real **libxkbcommon**, real **libinput**, KMS master,
EGL / `gbm_surface`, prime-fd + `SCM_RIGHTS`, the GL multiplexer.

---

## §4. The libffi de-risk (crux of the whole pivot)

`libwayland`'s **only** use of libffi is `wl_closure_invoke` (and its dispatch
sibling): given a decoded message, it calls the target listener/implementation
function with the message's arguments. On **wasm32 every Wayland argument is a
single 32-bit word** — `int`, `uint`, `wl_fixed_t`, `new_id`, an object
pointer, a `char *` string, a `wl_array *`, or an `fd` `int`. Return type is
`void`. There are no doubles and no by-value structs anywhere in the Wayland
wire ABI.

So we do **not** port full libffi (with its per-arch assembly closures,
double/struct classification, and `ffi_closure` trampolines). We ship a
**Wayland-scoped shim**: `ffi_prep_cif` records only the argument count;
`ffi_call` reads that many `i32` words from the `avalue` array and dispatches
through a `switch` over arity `0..=WL_CLOSURE_MAX_ARGS+2`. Each `case` is a
function-pointer call of a distinct `(i32, …) -> ()` signature, which the LLVM
wasm backend lowers to `call_indirect` against the program's function table —
exactly the mechanism real libffi provides, minus everything Wayland never
exercises. ~200 LoC, no assembly.

`WL_CLOSURE_MAX_ARGS` is 20; `wl_closure_invoke` prepends `data` + `target`,
so the shim covers arities `0..=22`.

**Full libffi is deferred** to the GTK/glib tail (post-v1), where doubles,
by-value structs, and `ffi_closure` callbacks appear. That is a separate,
larger port and is explicitly out of scope here.

**PR1 (this branch) proves the shim before any libwayland investment**: a
native unit test constructs a cif and calls `ffi_call` across every arity
`0..=22` with a target that records its arguments, asserting each `i32` word
lands in the right parameter slot. Because function-pointer dispatch *is*
`call_indirect` on wasm32, proving the arity switch marshals arguments
correctly proves `wl_closure_invoke` will dispatch correctly. See
`packages/registry/libffi/` + `host/test/libffi-shim-unit.test.ts`.

**Open item (resolve in PR3/PR6, not a blocker):** confirm the shim covers
the *full* closure argument set actually emitted (fd / array / string args) —
these are all still single `i32` words, so the risk is low, but PR3 links the
shim against real `libwayland` and PR6 exercises it end-to-end.

---

## §5. Stacked-PR roadmap

Client and compositor land as a stack of small PRs. v1 target is milestone
**D′** (a Wayland client window rendered by our compositor, browser-gated).

| PR | Deliverable |
|---|---|
| **PR1** | **libffi Wayland-scoped shim** (`packages/registry/libffi/`) + trampoline proof. ← *this branch* |
| PR2 | `wayland-scanner` (host tool) + `wayland-protocols` (XML data) packages |
| PR3 | `libwayland` (client + server) wasm32 port, linked against the PR1 shim |
| PR4 | real `libxkbcommon` port (keymap translation; compositor + clients link it) |
| PR5 | real `libinput` port (replaces `libinput-lite` stub: gestures, palm rejection, multi-device) |
| PR6 | `examples/programs/wlcompositor/` — PID-2 server: core + `wl_shm` + `xdg_shell` + `wl_seat` + `wl_output` |
| **PR7** | `examples/libs/libkwl/` toolkit + `wlterm` — **BROWSER GATE, milestone D′** |
| PR8 | `wlfm` (file manager) + `xdg_popup` |
| PR9 | `wlpanel` + `wlbeep` |
| — | **Post-v1 GL (F′):** PR10 GPU-tier ioctls → PR11 `zwp_linux_dmabuf_v1` → PR12 sdl2 wayland backend → PR13 `wlcube` |

### v1 Wayland interface set

Implemented in v1: `wl_display`/`wl_registry`/`wl_callback`,
`wl_compositor`+`wl_surface`, `wl_shm`+`wl_shm_pool`+`wl_buffer`
(ARGB8888 / XRGB8888), `xdg_wm_base`+`xdg_surface`+`xdg_toplevel`,
`wl_seat`+`wl_keyboard`+`wl_pointer`, `wl_output`.

Deferred: `zwp_linux_dmabuf_v1` (post-v1 GL), `xdg_popup` (E′, PR8),
subsurface / server-side decoration / clipboard (post-v1). **Own apps use
client-side decoration (CSD).**

### Compositor design (PR6)

Run `libwayland`'s `wl_event_loop` on epoll. Register: the listen socket
(`/run/wayland-0`), the `card0` DRM fd, and the libinput fd. A `wl_shm`
buffer is a client dumb-bo prime-fd received over `SCM_RIGHTS`. v1
compositing = CPU blit each committed surface into the `gbm_surface` scanout
bo + KMS `PAGE_FLIP`; gate on `gbm_surface_has_free_buffers`; pace clients via
`wl_surface.frame` callbacks. Input: handle **both** `POINTER_MOTION` and
`POINTER_MOTION_ABSOLUTE` (the browser emits `EV_ABS`). ESC is **forwarded**
to the focused client, **not** special-cased by the compositor.

---

## §6. Docs superseded / amended by this pivot

- **Supersede `2026-07-13-wpkcompositor-plan.md`** — the custom PID-2
  compositor, `libwpkclient`, and the 24-message custom wire are dropped.
  Replaced by PR3–PR9 above (real `libwayland` + `wlcompositor`).
- **Amend `2026-05-18-dri-design.md`:**
  - §9.2 (custom protocol) and §9.5 ("why custom protocol, not Wayland, in
    v1") — the reasoning is **reversed**. v1 *is* Wayland. Keep the sections
    as history but mark them superseded by this doc.
  - §15 (Wayland compat named + deferred) — **promote** Wayland from a
    deferred post-v1 compat layer to the v1 protocol.
- **Amend plans 8/10/11:**
  - Plan 8 (`wpkdraw`) — becomes a **CPU raster helper only** (rasterizer /
    blit utilities used by `libkwl`), not a compositor front-end.
  - Plan 10 — `libwpkclient` → **`libkwl`** (thin toolkit over
    `libwayland-client`).
  - Plan 11 — seed apps become **Wayland clients**; **drop the custom
    `SDL_wpkvideo` backend** in favor of SDL2's upstream Wayland backend
    (flip `--disable-video-wayland` → `--enable-video-wayland` in
    `packages/registry/sdl2/build-sdl2.sh` ~190–191, post-v1 in PR12).

---

## §7. Post-v1 milestones (named, out of scope for this doc)

- **F′ — GPU tier:** dispatch `DRM_IOCTL_WPK_CREATE_GPU_BO` /
  `WPK_BIND_FOREIGN_TEXTURE`; add `zwp_linux_dmabuf_v1`; SDL2 Wayland
  backend; `wlcube` GL client (PR10–PR13).
- **Full libffi:** doubles, by-value structs, `ffi_closure` — needed by
  glib/gobject.
- **Unmodified GTK/Qt apps:** the app-compat milestone; pulls in glib, cairo,
  pango, pixman, full libffi, plus `xdg_popup`, subsurface, clipboard, and
  server-side decoration.

---

## §8. Open verification items (resolve during PR3/PR6 — NOT blockers to start)

1. Server-side `mmap` of a received prime-fd OFD (else use the
   `gbm_bo_import` path for `wl_shm`).
2. A DRM `event_ring` write wakes a parked `epoll_wait` on `card0` (else the
   1 ms host fallback covers liveness).
3. libffi shim sufficiency for the full closure argument set (fd / array /
   string args) — see §4.

### Gaps discovered + fixed during PR3 (libwayland port)

The `wl_smoke` end-to-end test (one process hosting a libwayland server +
client over a kernel AF_UNIX socketpair) surfaced four kernel/host bugs that
libwayland is the first consumer to hit:

1. **`SO_PEERCRED`** was unimplemented. libwayland's `wl_client_create` calls
   it on every accepted client and refuses the client on error. Added
   `sys_getsockopt_peercred` (single-user model: returns the querying
   process's own pid/uid/gid). See `docs/posix-status.md`.
2. **`recvmsg`/`sendmsg` generic marshaling descriptors were wrong** — arg 2
   is `flags`, not a length, so the EAGAIN/error copyback in `completeChannel`
   copied kernel scratch over the caller's stack (corrupting a `wl_registry`
   pointer at bind time). Both handlers are hand-marshalled, so the descriptor
   was both wrong and unused for input; removed the two entries from
   `host_abi.rs`. Host-internal marshaling metadata only — not user-facing ABI.
3. **`epoll_event` layout** — on wasm32 the struct is *unpacked* (size 16,
   `data` at offset 8); the kernel's `epoll_ctl`/`epoll_pwait` used a packed
   12-byte / offset-4 layout. Fixed in `wasm_api.rs`.
4. **epoll_pwait finite-timeout hang** — the host converts epoll_pwait to a
   non-blocking poll and retries on a timer, but never honored the timeout:
   a drained fd set (the `[PARK]` case) retried forever. Added a per-channel
   deadline (`epollWaitDeadlines`) that persists across wakeup-driven retries
   so the wait returns 0 after ~timeout instead of resetting on every poke.

---

## §9. Verification (per CLAUDE.md)

- `cargo test -p kandelo --target aarch64-apple-darwin --lib` (expect 539+; 0 fail)
- `cd host && npx vitest run`
- `bash scripts/check-abi-version.sh` — the GPU-tier ioctls are additive;
  expect **no** ABI bump for the v1 Wayland work (confirm at PR10).
- libc-test + POSIX suites at kernel-touching PRs; `./run.sh browser` for the
  D′ browser gate (PR7).
- Build: `bash scripts/build-musl.sh` (after libc/overlay edits) then
  `bash build.sh`.
</content>
</invoke>
