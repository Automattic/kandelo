# Real Hyprland port — requirements inventory

Date: 2026-09-30
Status: **Deferred (near-term follow-up).** Recorded when the DRI desktop
batch PR shipped the Omarchy machine on Kandelo's own `wlcompositor`
instead of Hyprland. `docs/browser-support.md` ("What is not real yet")
is the user-facing record of that gap; this file is the engineering
inventory behind it.

> **Relationship to other plans.** This refines §5 (PR25–31) of
> `2026-07-14-build-hyprland-class-compositor-plan.md` with a source-level
> read of pinned upstream tags. It adds five requirements that plan does
> not name: Hyprland's GLES 3 floor, its mandatory BGRA texture format,
> an upstream null-call hazard in its EGL device probe, the wrong errno
> Kandelo returns for `DRM_IOCTL_MODE_CREATE_LEASE`, and the missing DRI
> `st_rdev`/sysfs identity.

## Summary

Real Hyprland is blocked mainly by the GL/EGL/GBM stack: Kandelo offers a
GLES 2.0 subset and no dmabuf import, and Hyprland's renderer is GL-only.
A wlroots compositor on its pixman software renderer avoids all of the GL
work and shares every other gap with Hyprland, so **wlroots 0.20 + tinywl
on pixman is the recommended first milestone** (see (d)).

Method: upstream sources at the tags named below were read, not built.
File references without a repo prefix are upstream paths; Kandelo paths
are repo-relative as of the batch PR. Anything marked (unverified) is a
claim not confirmed in source.

## (a) Dependency graph with Kandelo status

Legend: **✓** = package exists (version given). **↑** = exists but older than required. **P** = missing, plain C/C++, probably portable. **S** = missing and needs platform support or a toolchain decision. **H** = runs on the build machine only.

| Node (tag) | Lang / build | Direct deps (min versions from the build files) | Kandelo |
|---|---|---|---|
| **Hyprland v0.56.2** | C++26 (`CMakeLists.txt:101`), CMake ≥3.30 (`:1`) | aquamarine≥0.9.3, hyprlang≥0.6.7, hyprcursor≥0.1.7, hyprutils≥0.14.0, hyprgraphics≥0.5.1 (`:147-157`); xkbcommon≥1.11, uuid, wayland-server≥1.22.91, wayland-protocols≥1.49, cairo, pango, pangocairo, pixman-1, xcursor, libdrm, libinput≥1.29, libeis-1.0, gbm, gio-2.0, re2, muparser, lcms2 (`:264-289`); Lua 5.5 (`:291`); hyprwayland-scanner≥0.3.10 (`:293`); EGL + GLES3 + glslang (`:129-131`); glaze 7.x (`:133-145`); udis86≥1.7.2 or bundled copy (`:41-51`); Threads. Optional: xcb* for XWayland (`:378-400`, off via `NO_XWAYLAND`), systemd, tracy, hyprpm (`NO_HYPRPM`, `:619`). hyprctl: hyprwire, re2, readline (`hyprctl/CMakeLists.txt:8`) | S |
| aquamarine v0.15.1 | C++23 (`:43`), CMake | libseat≥0.8, libinput≥1.26, wayland-client, wayland-protocols, hyprutils≥0.8, pixman-1, libdrm, gbm, libudev, libdisplay-info, hwdata, GLES3, hyprwayland-scanner≥0.4.0 (`CMakeLists.txt:20-39`) | S |
| hyprutils v0.14.2 | C++26 (`:21`) | pixman-1, Threads (`:50-58`) | P |
| hyprlang v0.6.8 | C++23 | hyprutils≥0.7.1 (`:40`) | P |
| hyprcursor v0.1.13 | C++23 | hyprlang≥0.4.2, libzip, cairo, librsvg-2.0, tomlplusplus (`:35-43`) | P, except librsvg (S) |
| hyprgraphics v0.5.1 | C++26 (`:23`) | libdrm, pixman, cairo, pangocairo, hyprutils, libjpeg, libwebp, libmagic, libpng, librsvg-2.0; optional libjxl, libheif (`:51-94`); GLES3 headers only (`src/egl/Egl.cpp` is format tables) | P, except librsvg (S) |
| hyprwayland-scanner v0.4.6 | C++23 | pugixml (`:40`) | H |
| hyprwire v0.3.1 (hyprctl only) | C++23 | hyprutils≥0.9, libffi (`:24-30`); its own scanner needs pugixml (H) | P |
| hyprland-protocols v0.7.1 | XML data | none | P (trivial; also a git submodule) |
| libseat (seatd 0.9.3) | C, meson | none with only the noop backend (`meson.build:182`) | P |

**Third-party libraries against Kandelo:**
- **Already packaged (✓):** cairo 1.16.0, pango 1.42.4, libpng 1.6.43, libzip 1.11.4, glib 2.84.4 (includes gio), wayland-server 1.24.0, readline, libffi 0.1.0 (Kandelo's own full wasm32 port), libcxx 21.1.7 (wasm exception handling on, `packages/registry/libcxx/build-libcxx.sh:148`).
- **Present but too old (↑):**
  - libinput 1.25.0 needs ≥1.29, and Kandelo's build dropped `udev-seat.c` (`.../libinput/package.toml:13`).
  - xkbcommon 1.7.0 needs ≥1.11.
  - wayland-protocols 1.45 needs ≥1.49.
  - libdrm 2.4.120 is fine for Hyprland but below wlroots' ≥2.4.129.
  - pixman 0.42.2 is below wlroots' ≥0.43.
  - libudev 0.1.0 is a shim covering only the device API; it has no enumerate, monitor or list functions (`.../libudev/src/libudev_shim.c`).
- **Missing but plain C/C++ (P):**
  - Small or header-only: hwdata (data files), libdisplay-info, lcms2, muparser, Lua 5.5, libuuid, libjpeg(-turbo), libwebp, tomlplusplus, glaze 7, udis86.
  - Larger: re2 (needs abseil-cpp), glslang (Hyprland uses it only as a shader preprocessor, `src/render/ShaderLoader.cpp:93-130`), libeis/libei (its deps unverified).
  - libXcursor pulls in the whole X11 client chain (libX11, libxcb, libXau, xorgproto, libXrender, libXfixes). None of these are in the registry. Hyprland includes `<X11/Xcursor/Xcursor.h>` directly (`src/managers/XCursorManager.cpp:3`).
  - libmagic: `file` 5.45 is a program package and declares no library output.
- **Needs platform support (S):**
  - librsvg: current releases are written in Rust. I found no Kandelo package that builds Rust for the guest. The last C-only release was 2.40.x (unverified whether that is acceptable).
  - EGL, GLES3 and a real GBM: see gaps below.
- **No meson in the dev shell.** `flake.nix:125-129` provides cmake and ninja only, so meson-based dependencies (libseat, libdisplay-info, libei, wlroots) must be ported with hand-written build scripts, as libinput already is.

## (b) Platform gaps blocking real Hyprland

**1. KMS object and property model — medium, needs an ABI review.**
- Kernel `GET_CAP` answers only DUMB_BUFFER and PRIME; everything else returns 0 (`crates/runtime-core/src/syscalls.rs:1120-1131`). Unknown DRM ioctls return `ENOSYS` (`:1672`).
- aquamarine refuses to start without `CRTC_IN_VBLANK_EVENT`, `TIMESTAMP_MONOTONIC` and `SET_CLIENT_CAP(UNIVERSAL_PLANES)` (`src/backend/drm/DRM.cpp:720-738`).
- It also needs `GETPLANERESOURCES`, `GETPLANE`, `OBJ_GETPROPERTIES`, `GETPROPERTY` and `GETPROPBLOB`, including the plane `type` property (`DRM.cpp:821-846`, `:1650-1690`, `Props.cpp:98-200`). None of these are implemented.
- Atomic modesetting is optional: aquamarine falls back to the legacy interface (`DRM.cpp:749-755`).
- Advertising `CRTC_IN_VBLANK_EVENT` is honest and cheap, because flip events already carry `crtc_id` (`crates/runtime-core/src/dri/mod.rs:39`).
- **Wrong errno today:** `drmModeCreateLease` hits the ENOSYS default. aquamarine accepts only EINVAL or EOPNOTSUPP there and otherwise aborts allocator setup (`src/backend/Backend.cpp:333-342`, `:165-169`). Linux returns EOPNOTSUPP in this case.
- **Doc drift:** `docs/architecture.md:2435` says the kernel handles `GETPLANE_RESOURCES`, `ADDFB` and `DIRTYFB`, and points at a nonexistent `crates/kernel/src/syscalls.rs`. The real code has none of those ioctls.

**2. DRM device identity — medium.**
- DRI device nodes report `st_rdev=0`; only evdev nodes get a real device number (`syscalls.rs:227-231`).
- Kandelo's libdrm is built with `__linux__` forced on (`.../libdrm/build-libdrm.sh:130-131`). On that path, `drmGetDevice2` and the minor-name lookups read `/sys/dev/char/M:m/...` (`libdrm-2.4.120/xf86drm.c:3333,3440,4720`), and Kandelo has no sysfs.
- Callers that break: Hyprland `drmGetDevice` (`src/render/OpenGL.cpp:267`) and `openRenderNode`; aquamarine `reopenDRMNode` and its dev_t bookkeeping (`Session.cpp:148`).

**3. udev enumeration and monitor, plus the libinput udev backend — medium.**
- aquamarine needs, among others:
  - `udev_enumerate_*`, `udev_list_entry_*`, `udev_monitor_new_from_netlink`, `udev_monitor_get_fd` / `receive_device`;
  - device queries: `devtype`, `devnum`, `action`, `get_parent_with_subsystem_devtype`, `sysattr_value`;
  - the libinput udev backend: `libinput_udev_create_context` / `assign_seat` (`src/backend/Session.cpp:176-284`, `:328-372`, `DRM.cpp:78-198`).
- The monitor can honestly never become readable (no hotplug), but it must exist.

**4. libseat — small.** Port seatd's libseat with only the noop backend, which just calls `open()` (`libseat/backend/noop.c:52-55`). aquamarine requires a seat (`Session.cpp:308-313`). The noop backend is skipped during auto-probe, so the session must set `LIBSEAT_BACKEND=noop` (`libseat/libseat.c:45-69`).

**5. EGL — large. Today the stub advertises nothing.**
- `eglQueryString(EGL_NO_DISPLAY, …)` returns NULL (`libc/glue/libegl_stub.c:341`). Hyprland builds a `std::string` from it immediately (`OpenGL.cpp:290`), which crashes.
- `eglGetProcAddress` returns only GL functions (`libegl_stub.c:482-525`), so `eglGetPlatformDisplayEXT` and the device functions come back NULL.
- **Upstream null-call hazard:** Hyprland takes the device path whenever `eglQueryDevicesEXT` is NULL (`OpenGL.cpp:333`), then calls that NULL pointer (`:244-246`). Kandelo must expose `EGL_EXT_device_query`/`device_enumeration` plus `EGL_DRM_DEVICE_FILE_EXT`, or full `EXT_platform_device`, to reach the GBM fallback at `:340-358`.
- Also required:
  - `EGL_KHR_no_config_context` and surfaceless contexts (`EGL_NO_CONFIG_KHR`, `:205`);
  - `KHR_image_base` and `EXT_image_dma_buf_import(_modifiers)`: Hyprland renders every output buffer by importing a dmabuf as an EGLImage into a renderbuffer (`src/render/gl/GLRenderbuffer.cpp:35-45`, `OpenGL.cpp:615+`);
  - `eglCreateSyncKHR`, `eglDupNativeFenceFDANDROID` and `eglWaitSyncKHR` must be non-NULL (`:309-311`). Native fence sync is forced off on non-`__linux__` builds (`:384-392`), so these can honestly fail at runtime while the extension stays unadvertised.
- There is **no software or pixman fallback** in Hyprland's renderer or in aquamarine. Hyprland's `src/render` is GL-only; aquamarine's own EGL renderer is only for multi-GPU blits.

**6. GLES 3.0 — large.**
- Hyprland asks for a 3.2 context and falls back to 3.0, aborting below that (`OpenGL.cpp:199-220`). 14 shaders are `#version 300 es` and one is `320 es` with a 3.0 fallback.
- `GL_EXT_texture_format_BGRA8888` is mandatory (`:373`). WebGL2 has no BGRA upload, so the host has to swizzle. That is a browser boundary and must be documented as one.
- The Kandelo stub is ES 2.0 with 60 entry points (`libglesv2_stub.c:787-813`). The musl overlay has `GLES2/` but no `GLES3/` headers.
- By grep, at least 27 functions Hyprland calls are missing: vertex arrays, `glDrawBuffers`, `glTexImage3D`, `glInvalidateFramebuffer`, `glClearBufferfv`, renderbuffers, stencil, `glUniform*fv`, `glUniformMatrix3fv`/`4x2fv`, and `glEGLImageTarget{Texture2D,RenderbufferStorage}OES`.
- This is feasible: the host is already WebGL2, which is roughly ES 3.0 (`host/src/kernel.ts:1005`).
- The EGL stub ignores `EGL_CONTEXT_MINOR_VERSION`; how the host treats a major version of 3 is unverified.

**7. GBM — medium.**
- A GBM allocator is mandatory (`Backend.cpp:162-178`).
- Missing from the stub: `gbm_bo_create_with_modifiers`/`with_modifiers2`, `gbm_bo_get_fd_for_plane`, `gbm_device_get_fd`, `gbm_device_get_backend_name` (`libgbm_stub.c:33-37`, confirmed by grep).
- Buffers must be both renderable by EGL (the GPU-tier buffers) and scanned out by KMS via `ADDFB2`. Whether KMS can scan out GPU-tier buffers is unverified.

**8. Non-Linux, non-BSD target — small to medium.** Kandelo does not define `__linux__` and is not BSD. Hyprland has branches at `Compositor.cpp:81,361`, `helpers/Drm.cpp:13,108,126`, `desktop/view/Window.cpp:1315`, `KeybindManager.cpp:31`; aquamarine at `Session.cpp:513` and `DRM.cpp:84`. Which of these fail to compile is unverified; the fix should be generic POSIX fallbacks that could go upstream.

**9. Smaller items:**
- Plugins (boundary): `plugins/HookSystem.cpp` patches x86 machine code using udis86 and `mprotect`, which is impossible on wasm. It still compiles; plugins must fail honestly.
- inotify is ENOSYS (`docs/posix-status.md:347`). Only config auto-reload is lost (`ConfigWatcher.cpp:20-24`). Small, optional.
- Hyprland and hyprutils call `fork()` (`hyprutils/src/os/Process.cpp`, Hyprland `Executor.cpp`), so the build needs fork instrumentation. Small.
- Toolchain: whether clang/libc++ 21 cover Hyprland's C++26 usage, and whether the dev shell's cmake is ≥3.30, are unverified.
- **Not gaps:** timerfd, eventfd, epoll, signalfd, memfd, `SO_PEERCRED` and pthreads are all listed as Full or working (`posix-status.md:201,214,286,292-295,344-346,610`). DRM syncobj is optional and `__linux__`-gated (`Compositor.cpp:361-381`).
- **Running Hyprland nested inside wlcompositor is not a shortcut.** aquamarine's Wayland backend needs linux-dmabuf v4 with feedback (`src/backend/Wayland.cpp:136`), which leads back to sysfs; wlcompositor offers v3 (`programs/wlcompositor/wlcompositor.c:5070`). It still needs gaps 5-7.

## (c) The wlroots alternative (0.20.2 is the latest tag)

- **Software path exists.**
  - The pixman renderer is always built; `WLR_RENDERER=pixman` selects it (`render/wlr_renderer.c:268-269`).
  - The DRM dumb-buffer allocator is always built (`render/allocator/meson.build`) and is picked when the backend and renderer support CPU-mapped buffers (`allocator.c:139-147`).
  - GLES2, EGL and GBM are optional under `auto` (`render/meson.build:34-57`). When GLES2 is used, it requires `GL_EXT_texture_format_BGRA8888` and `GL_EXT_unpack_subimage` (`render/gles2/renderer.c:549-554`).
- **Hard deps:**
  - libudev and libseat whenever the DRM or libinput backends are on (`backend/meson.build:11-14`). The udev monitor is mandatory (`backend/session/session.c:275`); `WLR_DRM_DEVICES` skips enumeration (`:476-481`).
  - hwdata and libdisplay-info≥0.2 for the DRM backend (`backend/drm/meson.build:1-14`).
  - libinput≥1.19 with the udev backend (`backend/libinput/backend.c:90`).
  - libdrm≥2.4.129, xkbcommon≥1.8, pixman≥0.43 (`meson.build:100-124`).
  - It is C11/C23 (`meson.build:8`), not C++.
- **Same KMS requirements as aquamarine:** universal planes, `CRTC_IN_VBLANK_EVENT`, `TIMESTAMP_MONOTONIC` (`backend/drm/drm.c:75-88`), and plane properties (`:165-171`). It falls back to the legacy interface (`:105-112`).
- **Remaining gaps for wlroots + pixman:** gaps 1-4 above, the version bumps, and hwdata/libdisplay-info. **No EGL, GLES or GBM work is needed.**
- **Compositors on wlroots 0.20 today:** sway 1.12; swayfx 0.6 (via scenefx-0.5); dwl v0.9; labwc (latest tag as listed by git); mangowc 0.17.4 (scenefx, Hyprland-like animations). The swayfx and mango effects need scenefx's GLES2-only renderer (`scenefx/render/fx_renderer/meson.build:3`), which means gap 5 and dmabuf import but not GLES3. River was not checked.

## (d) Recommended build order

1. **Kernel and libraries shared by both paths:**
   - The KMS work in gap 1 (caps, `SET_CLIENT_CAP`, planes, properties, blobs, CREATE_LEASE returning EOPNOTSUPP, atomic later), with an ABI bump and snapshot.
   - DRI `st_rdev` 226:0 / 226:128 plus a minimal `/sys/dev/char` and `/sys/class/drm` tree.
   - libudev enumerate and monitor; libinput ≥1.29 with its udev backend.
   - libseat with the noop backend; hwdata; libdisplay-info.
   - Version bumps: libdrm ≥2.4.129, xkbcommon ≥1.11, pixman ≥0.43, wayland-protocols ≥1.49.
2. **First gate:** wlroots 0.20 plus unmodified tinywl on pixman and dumb buffers, then sway. This proves step 1 without any GL work.
3. **GL:** GLES3 headers and entry points with the BGRA boundary; EGL client/device/platform-GBM, no-config and surfaceless contexts, KHR_image with dmabuf import, and fence-sync functions; the GBM modifier and per-plane API with GPU-tier scanout. Gate on unmodified kmscube and wlroots' GLES2 renderer (and swayfx/mango).
4. **hypr libraries:** the host scanners first (hyprwayland-scanner, hyprwire-scanner, using the build machine's pugixml), then hyprutils → hyprlang → hyprland-protocols → hyprgraphics (libjpeg, libwebp, libmagic as a library, and a librsvg decision) → hyprcursor (tomlplusplus) → aquamarine.
5. **Hyprland's remaining deps, then Hyprland:**
   - Deps: Lua 5.5, muparser, abseil + re2, lcms2, libuuid, libei, glaze, glslang, udis86, the X11 client libraries through libXcursor.
   - Build Hyprland with `NO_XWAYLAND`, `NO_SYSTEMD` and `NO_HYPRPM`, then hyprctl (hyprwire, readline).
   - Configuration is Lua-first; a legacy `.conf` file is still read if no Lua config exists (`src/config/ConfigManager.cpp:39`).

This lines up with `docs/plans/2026-07-14-build-hyprland-class-compositor-plan.md` §5 (PR25-31). That plan does not yet mention the GLES3 requirement, the BGRA requirement, the EGL null-call hazard, the wrong CREATE_LEASE errno, or the `st_rdev`/sysfs gap.
