# Gamepad input: hot-pluggable evdev devices

Status: initial goal implemented (2026-11-07). Next goals: enable SDL2/SDL3
joystick support, then gamepad input in the DOSBox Pure and retro-emulator
frontends.

## Goal

A guest program can discover a gamepad the moment the browser reveals
it, the same way it would on Linux: a new `/dev/input/eventN` node
appears, the standard evdev ioctls describe it, and `read()` delivers
button and axis records. When the pad goes away the node disappears,
and descriptors still open on it fail with `ENODEV` and poll as
`POLLHUP | POLLERR`.

Out of scope for this goal, and still visible as gaps afterwards:
enabling SDL's joystick subsystem, gamepad support in the DOSBox Pure
and retro-emulator frontends, force feedback (`EV_FF`), the legacy
`/dev/input/js*` interface, pads the browser does not report with the
`"standard"` mapping, `inotify` on `/dev/input`, and a real `/sys`
tree.

## Why hot-plug, not a fixed third device

The Gamepad API hides every pad until the user presses a button on it,
and pads can disconnect at any time. A fixed `event2` that exists
whether or not a pad is attached would report a device that is not
there. Linux creates and removes evdev nodes as devices come and go;
Kandelo does the same.

## Kernel: host-described evdev devices

`event0` (keyboard) and `event1` (pointer) are unchanged. Numbers
`2..=31` are dynamic: Linux's legacy evdev minor range is 32 nodes, and
`st_rdev` stays `makedev(13, 64 + N)`.

The kernel does not know what a gamepad is. The host describes a device
the way Linux `uinput`'s legacy `struct uinput_user_dev` does: a name, an
`input_id`, the `EV_KEY` codes it can emit, and the `EV_ABS` axes it has
with their `input_absinfo`. The kernel owns everything a guest can
observe: the node, its identity, capabilities, current key and axis
state, and connection lifetime. Translating browser input to evdev
codes stays in the host, as keyboard translation already does.

New optional kernel exports (kernel-host surface):

- `kernel_input_device_connect(desc_ptr, desc_len) -> i32`: validate a
  `WpkInputDeviceDesc`, take the lowest free number, and return it, or
  `-EINVAL`, `-ENOSPC`, `-ENOMEM`.
- `kernel_input_device_disconnect(device) -> i32`: remove the device;
  `-ENODEV` if it is not connected.
- `kernel_input_event` now also accepts connected dynamic devices.

Each connection gets a kernel-wide serial number. An evdev open file
description records the serial it opened, so a descriptor left open
across disconnect and reuse of the same number keeps failing with
`ENODEV` instead of reading the new device.

Like the Linux input core, the kernel drops records a dynamic device
did not advertise, drops key and axis records that do not change the
device state, and drops a `SYN_REPORT` that closes an empty frame. The
current key bitmap (`EVIOCGKEY`) and axis values (`EVIOCGABS`) are
device state, kept even when a reader's ring overflows.

`/dev/input`'s `st_mtime` and `st_ctime` record its last change. Without
`inotify` or udev, SDL's Linux joystick backend rescans `/dev/input`
only when that mtime changes, and never while it reads 0. The directory
is stamped with the wall clock the first time it is observed and
again on every connect and disconnect. The stamp has one-second
granularity in `st_mtime`, so a scanner that compares only seconds can
miss a change that lands in the same second as its previous scan. Linux
without `inotify` has the same limit.

## Host: one API on both hosts

`NodeKernelHost` and `BrowserKernel` gain:

- `connectInputDevice(key, description)`, which resolves with the
  device number or the kernel's errno;
- `disconnectInputDevice(key)`;
- `injectInputDeviceEvents(key, records)`.

`key` is a host-chosen string. The kernel worker maps it to the kernel
device number, so records sent right after a connect are ordered behind
it without a round trip. Records for a key whose connect failed, or
which is disconnected, are dropped.

The gamepad translation is a pure module (`host/src/input/gamepad.ts`).
It reports the Linux `xpad` (Xbox 360) evdev layout, which the browser's
`"standard"` mapping is modeled on and which SDL's evdev auto-mapping
expects for a non-Sony vendor:

| Standard index | Control | evdev |
|---|---|---|
| 0, 1, 2, 3 | bottom, right, left, top face | `BTN_A`, `BTN_B`, `BTN_X`, `BTN_Y` |
| 4, 5 | shoulders | `BTN_TL`, `BTN_TR` |
| 6, 7 | triggers | `ABS_Z`, `ABS_RZ` (0..1023) |
| 8, 9 | back, start | `BTN_SELECT`, `BTN_START` |
| 10, 11 | stick clicks | `BTN_THUMBL`, `BTN_THUMBR` |
| 12..15 | d-pad | `ABS_HAT0Y`, `ABS_HAT0X` (-1..1) |
| 16 | home | `BTN_MODE` |
| axes 0..3 | sticks | `ABS_X`, `ABS_Y`, `ABS_RX`, `ABS_RY` (-32768..32767) |

The device identifies itself as what it is: `BUS_VIRTUAL`, vendor
`0x1209` (the vendor Kandelo's virtual keyboard and pointer already
use), product `0x0003`, named after the browser's `Gamepad.id`. It
does not claim a physical pad's USB vendor and product.

`BrowserGamepadSource` polls `navigator.getGamepads()` on the main thread
once per animation frame (the Gamepad API is not exposed to workers),
connects each standard-mapped pad, and sends one `SYN_REPORT` frame per
changed poll. A pad without the standard mapping is not connected, and
the source reports it as unsupported.

Node has no Gamepad API, so no Node source connects a pad. That
reflects the Node host's real hardware, as with the keyboard and
pointer. Tests drive the same host API directly.

## Validation

- Rust unit tests for the registry, the open/read/ioctl/poll/readdir/stat
  paths, slot reuse, event filtering, and fork serialization.
- A Node Vitest end-to-end test with a C fixture that discovers the pad,
  reads its identity and events, and observes `ENODEV`/`POLLHUP` and
  node removal after disconnect.
- Vitest for the gamepad translation and the browser source with a fake
  `navigator`.
- A Playwright test that stubs `navigator.getGamepads()` in a real
  browser and checks that the guest receives the records.
