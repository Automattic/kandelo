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

**PR4 result (2026-07-08).** `libxkbcommon` 1.7.0 is ported to wasm32
(`packages/registry/libxkbcommon/`, `libxkbcommon.a`). Pinned to 1.7.0 —
the last release with a stable standalone dist tarball (newer releases are
GitHub-only auto-archives with less durable checksums); the TEXT_V1 keymap
format the port needs is version-stable. Built with the alsa-lib /
libwayland pattern (bypass meson; compile the core TUs against a
hand-curated `config.h`), with `bison` (flake.nix) generating the xkbcomp
parser. Gate: `host/test/libxkbcommon-smoke.test.ts` runs
`programs/xkb_smoke.c` — compiles a self-contained keymap with
`xkb_keymap_new_from_string` and translates keycodes+modifiers to
keysyms/UTF-8 (base `a`, Shift→`A`, EuroSign round-trip) under the kernel.

**PR5a result (2026-07-08).** `libevdev` 1.13.3 is ported to wasm32
(`packages/registry/libevdev/`, `libevdev.a` — two core TUs, uinput
skipped). It is the mandatory foundation of the real libinput port
(libinput's evdev backend is built entirely on `libevdev_new_from_fd` /
`libevdev_next_event`); the original PR5 one-liner had omitted it. Built
with the libxkbcommon pattern (bypass meson; hand-curated `config.h`),
with python3 (flake.nix) generating the event-name table from libevdev's
bundled full linux UAPI headers — the sysroot's `<linux/input-event-codes.h>`
is a deliberately minimal, ABI-locked subset (no `*_MAX` sentinels) that
libevdev's `*_MAX`-sized tables cannot compile against; a tiny
`<linux/types.h>` shim covers the one header the sysroot omits. Gate:
`host/test/libevdev-smoke.test.ts` runs `programs/libevdev_smoke.c` —
builds a libevdev from each virtual evdev node and decodes host-injected
key + pointer events (name lookups included) under the kernel.

Kernel gap fixed (additive, no ABI bump): `libevdev_set_fd` issues
`EVIOCGPHYS`/`EVIOCGUNIQ`/`EVIOCGPROP` and `EVIOCGKEY`/`EVIOCGLED`/`EVIOCGSW`
during construction and fatals on an unexpected errno; the kernel had
returned `ENOTTY` for all (tuned for SDL2, which tolerates it). Now
phys/uniq return `ENOENT` ("unset") and the state bitmaps return
zero-filled success — the honest state of a virtual device with nothing
latched. See `crates/kernel/src/syscalls.rs` `handle_input_ioctl` +
`shared::input` NR constants. Contrary to the initial PR5 assumption that
no kernel work was needed, libevdev was the first consumer to exercise
this surface.

**PR5b result (2026-07-08).** The two link/classification layers real
libinput builds on are in place:

- `mtdev` (`packages/registry/mtdev/`, `libmtdev.a`) — a link-only stub
  reproducing mtdev's public ABI. libinput references five `mtdev_*`
  symbols but calls them only for legacy protocol-A multitouch
  (`evdev_need_mtdev()` — has `ABS_MT_POSITION_X/Y` but no
  `ABS_MT_SLOT`). The kernel's virtual pointer reports plain
  `ABS_X/ABS_Y`, so that predicate is always false and the stub is never
  entered; each entry point aborts if it ever is. Gate:
  `host/test/mtdev-smoke.test.ts`.
- `libudev` (`packages/registry/libudev/`, `libudev.a`) — a PATH-mode
  shim whose load-bearing part reimplements udev's `input_id`
  classification (`test_pointers` + `test_key` + the EV_SW / scrollwheel
  fallbacks, faithful to systemd v255) over `EVIOCGBIT`/`EVIOCGPROP`
  probes, synthesizing the `ID_INPUT*` tags libinput's evdev core
  requires to accept a device. The other 13 udev entry points are thin
  no-ops. Gate: `host/test/libudev-input-id-smoke.test.ts` (event0 →
  `ID_INPUT_KEYBOARD`, event1 → `ID_INPUT_MOUSE` through the real API).

ABI bump to **v17** (the single deliberate bump this stack anticipated).
`WasmStat` grows 88→96 with a trailing `st_rdev`, and virtual evdev
nodes now stat as Linux char major 13, minor 64+N (`/dev/input/event0`
= 13:64). This is load-bearing for libinput's PATH backend, which drops
the devnode path and hands `udev_device_new_from_devnum` only the
`st_rdev` — the shim recovers the node by scanning `/dev/input/event*`
for the matching devnum. The v17 bump also folds in the DRI-branch ABI
changes accumulated since v16. Publishing v17 package binaries (php,
spidermonkey, wordpress, …) is the release-tag/matrix step; until then
those package tests fail against the v17 kernel by design.

**PR5c result (2026-07-09).** The real **libinput 1.25.0 core** is ported
(`packages/registry/libinput/`, `libinput.a`, 437 KB), replacing the
`libinput-lite` stub as the compositor's input library. Scope: the 35
path-backend TUs (`src_libfilter` + `src_libinput` core + util + quirks),
compiled directly against a hand-curated `config.h` + sed-substituted
version headers (upstream meson bypassed, same pattern as libxkbcommon /
libevdev). `src/udev-seat.c` is **dropped** — the udev enumerate/monitor
seat backend; the compositor drives the path backend only, and a symbol
audit confirmed no in-set TU references anything udev-seat.c defines. All
35 TUs compiled clean on the first pass: musl provides `static_assert`,
`versionsort`, and `newlocale`; the sysroot has `sys/epoll.h` +
`sys/timerfd.h`; the bundled full linux UAPI headers win over the
sysroot's minimal `<linux/input.h>` via `-Iinclude/linux` + a
`<linux/types.h>` shim (identical to the libevdev port). Links against
libevdev (PR5a) + the libudev + mtdev shims (PR5b).

Gate: `programs/libinput_smoke.c` +
`host/test/libinput-smoke.test.ts` — the first full-chain proof.
`libinput_path_add_device("/dev/input/event0")` runs the entire accept
path (stat → `st_rdev` recovery → `udev_device_new_from_devnum` →
`input_id` classification → `evdev_device_new` → libevdev capability
probe → device accepted, DEVICE_ADDED queued), then a host-injected
`EV_KEY` is read off the kernel evdev ring by libinput's epoll loop
(`sys_epoll_pwait` → `sys_poll` → the evdev ring-readiness gate) and
decoded into a `LIBINPUT_EVENT_KEYBOARD_KEY`.

**Dual-consumer decision:** SDL2 keeps depending on `libinput-lite`, not
the real port. SDL2 2.30 references **zero** libinput symbols (verified
by grep over the extracted source + configure) — it uses libinput purely
as an optional-detection stub — so pointing it at the 35-TU real library
would only bloat its dep graph and link surface for no functional gain.
The real `libinput` is a distinct consumer (this smoke + the PR6/PR7
compositor); its archive is linked from the resolver cache prefix by
full path, never through `$SYSROOT/lib/libinput.a` (which stays the lite
stub), so the two never collide. No ABI change (PR5c is additive:
package + program + test + docs only).

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
| PR4 | real `libxkbcommon` port (keymap translation; compositor + clients link it). **DONE.** |
| PR5 | real `libinput` port (gestures, palm rejection, multi-device). Lands as a bottom-up sub-stack — **PR5a `libevdev` (DONE)**, **PR5b `mtdev` stub + `libudev`/`input_id` shim (DONE)**, **PR5c `libinput` 1.25.0 core (DONE)** — since real libinput builds on all three (the original one-line scope omitted libevdev + mtdev). The real `libinput` serves the compositor; SDL2 keeps `libinput-lite` (it references no libinput symbols). |
| PR6 | `programs/wlcompositor/` — PID-2 server: core + `wl_shm` + `xdg_shell` + `wl_seat` + `wl_output`. **DONE.** Two-process smoke gate (`host/test/wlcompositor-smoke.test.ts`) drives a real client through connect → bind-all-globals → keymap fd-pass → xdg configure → shared-buffer composite (red pixel proof) → KMS flip → injected key+button delivery. Uncovered + fixed two kernel bugs: nested epoll readiness (epoll-on-epoll) and the `epoll_event` wasm32 layout (see §8.3). |
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

Run `libwayland`'s `wl_event_loop` on epoll. Register: the listen socket,
the `card0` DRM fd, and the libinput fd. **Socket path (PR6):** the compositor
binds `/tmp/wayland-0` (and writes its keymap to `/tmp/wlcompositor-keymap.xkb`),
not the plan's original `/run/wayland-0` — `/` is a read-only rootfs and
`/var/run` is `root:root 0755` (`EACCES` for a non-root uid), while `/tmp` is
`1777` world-writable. Recorded in a code comment in `wlcompositor.c`. A `wl_shm`
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

1. **EXERCISED (PR6).** Server-side access to a received prime-fd OFD. The
   compositor uses the `gbm_bo_import(GBM_BO_IMPORT_FD)` + `gbm_bo_map` path for
   `wl_shm` (not raw `mmap` of the fd — file/memfd `MAP_SHARED` is not shared
   cross-process; only the DRI BoRegistry is). This required carrying the
   prime-bo sidecar across `SCM_RIGHTS`: `InFlightFd` now holds an optional
   `prime_bo` (`pipe.rs`), `extract_scm_rights` captures it, and
   `install_scm_rights_fds` re-increments the bo refcount at install time
   (`wasm_api.rs`). The smoke gate proves it end-to-end via `COMPOSITE_SAMPLE
   px=0x00ff0000` (a client-painted red pixel composited in the server).
2. A DRM `event_ring` write wakes a parked `epoll_wait` on `card0` (else the
   1 ms host fallback covers liveness).
3. **EXERCISED (PR6).** libffi shim sufficiency for the full closure argument
   set. The compositor dispatches real fd / string / array closure args
   end-to-end (keymap fd over `wl_keyboard.keymap`, surface/toplevel requests,
   `wl_array` for keyboard state) through `wl_closure_invoke → ffi_call` with no
   shim gaps observed — see §4.

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
   `data` at offset 8; musl only applies `__packed__` on x86_64); the kernel
   used a packed 12-byte / offset-4 layout. **This was documented as "fixed in
   `wasm_api.rs`" during PR3 but was actually incomplete**, and it was the true
   root cause of the PR6 wlcompositor input crash (see below). The authoritative
   epoll path for the running system is host-side — `handleEpollCtl` /
   `handleEpollPwait` in `host/src/kernel-worker.ts` — and it *also* carried the
   12/offset-4 layout, which the PR3 note missed. The bug is latent for
   single-event waits: at `i == 0` both the 12- and 16-byte strides start at
   offset 0 and the offset-4 read/write happen to cancel (the pointer lands in,
   and is read from, the high dword), so socket-driven `wl_event_loop` dispatch
   worked all the way to `CLIENT_READY`. It only bites at `i >= 1`, where the
   12-vs-16 stride desyncs and a second ready fd's `data` reads back as **0** →
   a NULL `struct libinput_source *` in libinput's `libinput_dispatch` loop
   (`source->dispatch(source->user_data)` traps with a `call_indirect` null /
   signature mismatch). libinput registers three fds in its own epoll (timer +
   two evdev nodes), so injected input is the first workload to make two fire at
   once. **Fixed for real in PR6**, consistently across all four marshalling
   sites: `wasm_api.rs` `kernel_epoll_ctl`/`kernel_epoll_pwait` and
   `kernel-worker.ts` `handleEpollCtl`/`handleEpollPwait` (16-byte stride, data
   at offset 8, full 16-byte scratch copy). Regression-covered by a kernel unit
   test (`test_epoll_pwait_multiple_events_data`) and the PR6 smoke gate.
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
