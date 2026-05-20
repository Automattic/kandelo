# Graphics Seat Device Policy

Date: 2026-05-18

## Goal

Keep Kandelo's guest-visible system surface POSIX-first while adding only the Linux device APIs that unlock broad, reusable graphical software compatibility.

## Policy

Kandelo should prefer POSIX interfaces when they are sufficient:

- Text input and command interaction go through file descriptors, controlling terminals, PTYs, termios, and stdio.
- Filesystem interaction goes through POSIX paths, descriptors, directory APIs, and metadata APIs.
- Process, signal, pipe, socket, mmap, and locking behavior should remain POSIX-shaped unless a specific Linux extension is already the de facto portability target.

Linux device nodes are acceptable when all of these are true:

- The device is a common target for existing portable-ish Unix software.
- The ABI is small enough to implement and test directly.
- The device is guest-visible as a standard Linux interface, not as a Kandelo/browser-specific protocol.
- POSIX behavior is not replaced for software that can use POSIX.

## Current Decisions

`/dev/fb0` is justified as a Linux compatibility device. It is not POSIX, but fbdev is a compact ABI that lets existing framebuffer programs, SDL backends, tiny X servers such as Xfbdev, and simple compositors render without a bespoke Kandelo graphics API.

The fbdev surface should stay compact and compatibility-oriented. Mode setting,
fixed/variable screen info, mmap/write presentation, blanking, pan, and
wait-for-vsync are acceptable because they are standard probes for
direct-framebuffer clients. More complex acceleration APIs should not be added
until a real port demonstrates that fbdev is insufficient.

`/dev/input/mice` is justified as a legacy Linux pointer compatibility device. It is small, useful for direct-framebuffer programs, and remains a fallback.

`/dev/input/event0` and `/dev/input/event1` are justified as Linux evdev compatibility devices for a graphical seat:

- `event0`: relative pointer motion, wheel motion, and button edges.
- `event1`: keyboard key press/release edges.

These are not the default text-input path. Text-mode programs should continue to read from stdin, `/dev/tty`, or PTYs and use termios. Evdev exists for graphical stacks that need raw seat input, including X, Wayland-style compositors, libinput-style code, SDL, and direct framebuffer applications.

The browser host may have convenience exports such as `kernel_inject_mouse_event`, `kernel_inject_mouse_wheel_event`, and `kernel_inject_keyboard_event`, but those are host-to-kernel plumbing only. Guest programs must see ordinary device files and ordinary Linux wire formats.

`/dev/tty0` and `/dev/tty1` are acceptable as lightweight Linux VT aliases for
the controlling terminal. They exist to satisfy broad console probes from Xfbdev
and SDL-style backends. Kandelo still does not implement real virtual-console
multiplexing; activation, release, and KD graphics/text mode calls are no-op
compatibility acknowledgements unless and until a real multi-seat/multi-VT need
appears.

## Device Boundary

The guest-visible graphics seat is deliberately made of standard device files:

| Device | Standard shape | Direction | Reason |
| --- | --- | --- | --- |
| `/dev/fb0` | Linux fbdev | guest -> display | Small direct-rendering ABI for Xfbdev, SDL, direct-fb demos, and simple compositors. |
| `/dev/input/event0` | Linux evdev | host -> guest | Raw relative pointer, wheel, and button edges for graphical stacks. |
| `/dev/input/event1` | Linux evdev | host -> guest | Raw keyboard key edges for graphical stacks. |
| `/dev/input/mice` | Linux mousedev | host -> guest | Legacy PS/2-style pointer fallback. |
| `/dev/tty0`, `/dev/tty1` | Linux VT/KD subset | guest -> kernel | Compatibility acknowledgements for framebuffer stacks that probe console mode. |

Everything above is a compatibility surface, not a Kandelo desktop protocol.
Demo behavior belongs in user programs or browser demo glue. The kernel should
not gain branches for a specific game, window manager, file browser, or
gallery entry.

## Deferred Interfaces

Linux DRI, DRM/KMS, GBM, Mesa, WebGL, and WebGPU are not rejected, but they are
heavier than the current need. They should stay out of the guest ABI until a
real port needs them and the smaller fbdev/evdev/VT path cannot reasonably
support it.

The browser host may use canvas, WebGL, or WebGPU internally to present pixels,
but that is a host rendering implementation choice. It should not change what
guest programs see unless Kandelo intentionally adds a standard guest ABI such
as DRM/KMS.

## Acceptance Checklist

Before adding another graphics/input device or ioctl:

1. Identify at least one real upstream program or library that probes it.
2. Prefer an existing POSIX interface if it can satisfy the same program.
3. Prefer a small Linux compatibility subset over a Kandelo-specific device.
4. Add focused kernel tests for guest-visible behavior.
5. Extend `fbseat-probe` when the behavior is part of the graphical-seat contract.
6. Keep demo-specific policy in `programs/`, examples, docs, or browser UI code.

## Demo-Specific Audit

Audit date: 2026-05-19.

The kernel and ABI-facing headers were checked for demo-specific terms with:

```sh
rg -n -i "doom|fbdoom|jwm|kdesktop|desktop-jwm|liquid|liquid war|game|wasd|shareware|doom1" crates/kernel crates/shared musl-overlay
```

After genericizing comments in `crates/shared/src/lib.rs` and the Linux header
overlay, that command reports no matches. Remaining demo names are expected in
demo/package code such as `examples/libs/fbdoom`, `examples/browser/pages/doom`,
`programs/kdesktop.c`, docs, and browser gallery metadata.

## Guardrails

Do not add Kandelo-only guest device nodes for graphics or input until a standard interface has been tried and found too heavy or fundamentally mismatched.

Do not make `/dev/input/event1` synthesize text. It reports physical key edges. Text composition, keyboard layouts, shortcuts, and character input belong above this layer, typically in a terminal line discipline, an X/Wayland input stack, or an application toolkit.

Do not let demo-specific key aliases leak into evdev. For example, WASD-as-arrows can be acceptable for a legacy game stdin path, but evdev must report `KEY_W`, `KEY_A`, `KEY_S`, and `KEY_D` as themselves.

Keep Linux device implementations small and capability-driven. Implement the subset exercised by real software, add tests for every guest-visible behavior, and document any no-op ioctl or missing mode.

## Next Architectural Step

The next substantial graphics step should be to run one real Unix graphics stack component against these standard devices, not to invent a Kandelo-native display protocol. The preferred order is:

1. Keep `kdesktop` as the visible smoke test.
2. Keep `fbseat-probe` running before the desktop smoke test so fbdev, evdev,
   and VT compatibility regressions are visible in the browser demo.
3. Port Xfbdev or an SDL2 framebuffer/evdev backend.
4. Put JWM or Matchbox on top once the server/compositor path is proven.

The Xfbdev/JWM/ROX-Filer path is expanded in `docs/plans/2026-05-19-xfbdev-jwm-rox-port-plan.md`.
