# Omarchy desktop: paste from the system clipboard

Date: 2026-10-01
Status: Phase 1 (Layer 1) implemented; Layers 2 and 3 designed, decisions below

## Why

A person using the Omarchy-style desktop in the browser
(`?vfs=<shell image>&profile=omarchy`) cannot paste text into it. They
copy a command from a web page, focus a foot terminal on the desktop,
press Cmd+V (macOS) or Ctrl+V, and nothing arrives. Pasting a URL,
a config snippet, or a command someone gave you is about the most
ordinary thing a terminal is for, so this gap makes the desktop look broken.

The gap is not a single missing feature. Three layers are missing, and
each is visible in the tree:

1. **The desktop has no clipboard of its own.** The compositor's
   `wl_data_device_manager` is a stub that exists only so foot will start
   (`programs/wlcompositor/wlcompositor.c:3069-3131`). The comment says so:
   it "accepts selections without transferring them — real clipboard data
   paths are the O2 tier's work (plan §4 PR24)"
   (`docs/plans/2026-07-14-build-hyprland-class-compositor-plan.md:314-324`,
   and the protocol row at line 465). `set_selection` is a no-op and no
   `wl_data_offer` is ever created, so copy/paste does not work even
   between two foot windows *inside* the desktop. The stub also reports
   success for something it does not do. The platform values contract
   forbids that kind of stub.
2. **Nothing carries host clipboard text into the guest.** The host has
   channels for keyboard/pointer (`kernel_input_event`,
   `crates/kernel/src/wasm_api.rs:14016`), audio, and KMS. No channel
   carries clipboard text.
3. **The browser never produces a paste event over the desktop.**
   `BrowserInputSource.onKeyDown`
   (`host/src/input/browser-input-source.ts:236-258`) calls
   `preventDefault()` on every key it translates, so Cmd/Ctrl+V never
   reaches the browser's default action and no `paste` event fires. On
   macOS, Cmd arrives in the guest as `KEY_LEFTMETA`, so Cmd+V reaches the
   compositor as SUPER+V. No bind matches it, and foot ignores it.

The goal is for a paste gesture over the desktop to put the user's
clipboard text into the focused window. It must use the same Wayland
selection mechanism a real Hyprland session uses, and it must fail
visibly when it cannot.

## What Omarchy actually does (the behavior we imitate)

Omarchy (default branch `quattro`, at `8b4eae66`) configures Hyprland in
Lua. In `default/hypr/bindings/clipboard.lua`:

- `SUPER+V` sends paste to the focused surface: Ctrl+V to ordinary
  windows and Ctrl+Shift+V to windows tagged `terminal`. `SUPER+C`
  (copy) chooses between Ctrl+C and Ctrl+Shift+C the same way. `SUPER+A`
  and `SUPER+X` always send Ctrl+A and Ctrl+X; they do not check for a
  terminal. `SUPER+CTRL+V` opens the `omarchy.clipboard` panel (a
  clipboard manager).
- The shortcut goes through `hl.dsp.send_key_state` with *explicit*
  modifiers, sent as a separate down and up 50 ms apart. The comments
  give the reason: a virtual keyboard (wtype) "won't do: the physically
  held SUPER merges into the injected chord at the seat". The split
  works around stuck synthetic key state in Hyprland.
- The `terminal` tag comes from `default/hypr/apps/terminals.lua`, which
  matches the classes `Alacritty|kitty|com.mitchellh.ghostty|foot|
  org.codeberg.dnkl.foot|wezterm|org.omarchy.*|TUI.*`.

Today the image's bind table
(`packages/registry/wayland-demo/desktops/data/omarchy/wlcompositor.conf`)
contains **none** of these clipboard binds, on either SUPER or CTRL.

## Current client inventory (who can consume a paste today)

The desktop runs foot, Waybar, mako, klauncher, wlclock, wlpaint,
qtgallery, and Quickshell. `packages/registry/wayland-demo/desktops/
omarchydesktop` starts the compositor, dbus-daemon, mako, and Waybar.
**Only foot reads the clipboard.** foot is upstream 1.17.2 with two
Kandelo patches (`packages/registry/foot/patches/0001-shm-gbm-prime-fd-
pools.patch`, `0002-serial-font-loading.patch`). Neither patch touches
the clipboard. foot's default paste key is Ctrl+Shift+V. The image's
`foot.ini` does not change it.

The other clients do not paste. klauncher (`programs/klauncher.c`)
filters as you type but has no `wl_data_device` code. Waybar, mako, and
the two Qt clients take no text input. So the "Ctrl+V for ordinary
apps" half of the universal-paste rule has no consumer on this desktop
today. It is still worth implementing to match Omarchy, because a GTK or
Qt text field is one launcher entry away.

## Design overview

The design copies the VM guest-agent pattern. SPICE's `spice-vdagent`
reads a virtio-serial port that the hypervisor feeds, then sets the
guest desktop's clipboard through the desktop's own protocol. Kandelo
has the same three parts:

| Layer | What | Shippable alone? |
|---|---|---|
| 1 | A real Wayland clipboard in `wlcompositor` (`wl_data_device` selection plus a data-control protocol), and Omarchy's universal-clipboard binds | Yes: in-desktop copy/paste |
| 2 | A host-fed character device and a small in-guest agent (`kclipd`) that turns device records into the Wayland selection | Yes: testable from Node without a browser |
| 3 | The browser paste gesture: let the real `paste` event fire, push its text through Layer 2, wait for the agent's acknowledgement, then deliver the user's chord | Needs 1 and 2 |

## Layer 1: a real clipboard in wlcompositor

### wl_data_device (selection only)

Replace the stub with the selection half of `wl_data_device_manager` v3:

- **Sources.** `create_data_source` allocates a source record that holds
  its MIME list (`offer`) and its owning client. Destroying the source
  clears the selection if this source was it.
- **Devices.** `get_data_device` records the device resource on a
  per-client list, in the same way the seat resources are tracked
  (`for_each_seat_res` over `g.keyboards`).
- **set_selection.** Replace the global selection. Send
  `wl_data_source.cancelled` to the previous source. Ignore stale
  serials, as wlroots does. A NULL source clears the selection.
- **Offers.** The protocol says to send the selection to a client
  "immediately before receiving keyboard focus" and again when the
  selection changes while the client has focus. Add a
  `send_selection_to(client)` step to `kbd_set_focus`
  (`wlcompositor.c:2294`) before `wl_keyboard_send_enter`. This step
  creates a `wl_data_offer`, sends one `offer(mime)` per source MIME,
  and then sends `selection(offer)`, or `selection(NULL)` when the
  selection is empty. Call it again from `set_selection` for the
  focused client. Layer surfaces with keyboard interactivity
  (klauncher) take focus through the same function, so they get the
  same treatment.
- **receive.** `wl_data_offer.receive(mime, fd)` forwards the fd to the
  current source's client with `wl_data_source.send(mime, fd)`, then
  closes the compositor's copy. If the offer's source is no longer the
  selection, the compositor closes the fd right away; the reader then
  sees EOF, which is the honest result. The compositor never reads or
  copies clipboard bytes. Sender and receiver talk over a pipe, and the
  pipe's write end crosses the Wayland socket twice by `SCM_RIGHTS`.
  Kandelo already supports pipe fds over `SCM_RIGHTS`
  (`docs/architecture.md:690-718`; `docs/posix-status.md:285`; gated by
  `host/test/scm-rights-pipe-lifetime.test.ts`). It is the same
  mechanism that carries foot's prime-fd `wl_shm` pools today
  (`docs/architecture.md:2447`).
- **Not in scope:** drag-and-drop (`start_drag` stays a no-op;
  `accept`, `finish`, and `set_actions` on offers are accepted only so
  that v3 clients work) and primary selection
  (`primary-selection-unstable-v1.xml` is vendored but not advertised).
  Both stay listed as gaps in `docs/browser-support.md`.

### Data-control (a selection setter that needs no focus)

The agent in Layer 2 has no window and never has keyboard focus, so it
cannot use `wl_data_device.set_selection`. Clipboard tools such as
wl-clipboard use a data-control protocol for this. There are two
near-identical choices:

- `zwlr_data_control_manager_v1` (wlr-protocols). It is the widely
  deployed one; Hyprland advertises it, and wl-clipboard's `wl-copy`
  uses it.
- `ext_data_control_v1`, its standardized successor in
  wayland-protocols staging. The vendored XML set
  (`packages/registry/wayland-protocols/xml/`, pinned to 1.45) has
  neither.

Recommendation: implement `zwlr_data_control_manager_v1` v2 first,
because that is what Hyprland and the existing tools speak. Vendor
`wlr-data-control-unstable-v1.xml` next to the vendored
`wlr-layer-shell-unstable-v1.xml`. Add `ext_data_control_v1` once a
consumer needs it; the two share the compositor's selection state.
Data-control devices receive `selection` on every change, regardless of
focus. Primary selection under v2 stays unadvertised, as above.

### Universal-clipboard binds and `sendshortcut`

The compositor's dispatcher set (`run_dispatch`, `wlcompositor.c:3741`;
config parsing at `:3964-3989`) has no way to send a synthetic shortcut
to the focused surface. Add:

- A `sendshortcut` dispatcher (Hyprland's name) for both `bind =` lines
  and `kwlctl dispatch` (`wlcompositor.c:4926`). It sends
  `wl_keyboard.modifiers` with the *explicit* chord modifiers, a key
  press, and a key release, then restores the real modifier state, all
  to `g.kbd_focus`. Explicit modifiers are what keep a physically held
  SUPER/Cmd out of the chord, which is the problem Omarchy's comment
  describes.
- A window-tag rule, so the terminal decision lives in config and not in
  C. The rule is keyed on `app_id` (`struct surface.app_id`,
  `wlcompositor.c:227`), for example
  `windowrule = tag +terminal, class:^(foot|org\.codeberg\.dnkl\.foot)$`,
  plus a tag-conditional form of the dispatcher. Hyprland's own `.conf`
  has no conditional bind; Omarchy uses Lua for this, and wlcompositor
  has no Lua. The conditional dispatcher is therefore a
  Kandelo-specific stand-in for that Lua function, and the docs must
  say so (see Open questions).
- Binds in the Omarchy `wlcompositor.conf`: `SUPER+A/C/V/X` exactly as
  Omarchy defines them. On macOS these fire from Cmd+A/C/V/X, because
  Cmd reaches the guest as SUPER and the browser does not reserve those
  four keys once the page cancels them. **Mirror only V on CTRL.** A
  CTRL+C mirror would send Ctrl+Shift+C to terminals and take SIGINT
  away from foot. A CTRL+A or CTRL+X mirror would take readline and
  editor keys. A CTRL+V mirror costs a terminal its literal-next key
  (^V), but in a browser Ctrl+V means paste, so that cost is the right
  one. Document it next to the existing Ctrl+W caveat.

With Layer 1 alone, a user can copy in one foot window (Cmd+C or
Ctrl+Shift+C) and paste in another (Cmd+V or Ctrl+V). Layer 1 ships on
its own.

## Layer 2: the host-fed clipboard device and kclipd

### How existing host-fed devices work

The model is the evdev path. The host's `injectInputEvent`
(`host/src/kernel-worker.ts:30499-30520`) calls the `kernel_input_event`
export (`wasm_api.rs:14016`). That export runs `push_event`
(`crates/runtime-core/src/input/dispatch.rs:21`), which fans the record
out to every OFD whose `input_state` names the device. The host then
calls `scheduleWakeBlockedRetries` so that parked readers retry. Device
nodes are matched by path in `match_virtual_device`
(`crates/runtime-core/src/syscalls.rs:252-267`), carry negative
`host_handle` sentinels (`VirtualDevice`, `:152-200`), and get per-OFD
sidecar state installed on open (`install_input_state_on_open`, `:770`).
`/dev` listings are synthesized in `crates/runtime-core/src/devfs.rs`,
and per-OFD state crosses fork through `fork.rs` (`read_input_state`,
`:904`). Single-owner devices already exist: `/dev/input/mice` returns
`EBUSY` to a second opener (`acquire_mice_or_busy`, `syscalls.rs:444`).

### The device: `/dev/kandelo/clipboard` (working name)

It is a message-oriented character device that represents "the
clipboard text the host most recently offered":

- **Latest wins.** The kernel holds at most one pending offer (a
  sequence number plus UTF-8 bytes). A new offer replaces an unread one,
  because a clipboard is one value, not a queue. After the reader
  consumes an offer, the kernel drops its copy; the selection then lives
  in the agent, as it would on Linux.
- **Read framing.** Each offer reads as a fixed header followed by the
  payload. The header is `{u32 version, u32 kind, u32 seq, u32 len}`,
  with kind `OFFER_TEXT`, defined in `crates/shared` and mirrored in a C
  header for the agent. Reads stream through the record with a per-OFD
  cursor, so no single `read()` has to exceed the 64 KiB channel data
  area (`channel::DATA_SIZE`, `crates/shared/src/lib.rs:1329`). An offer
  that arrives in the middle of a record becomes readable only after the
  current record is fully read. The reader never sees two offers
  interleaved.
- **Blocking.** If no offer is pending, a blocking `read` parks until
  one arrives, as Linux character devices and `/dev/dri/card0` do. It
  must not copy evdev's documented divergence of returning `Ok(0)`
  (`syscalls.rs:4966-4980`). `O_NONBLOCK` gets `EAGAIN`. `poll` reports
  `POLLIN` only when an unread offer exists. The poll gating follows
  the evdev branch at `syscalls.rs:14206-14221`.
- **Acknowledgement by write.** The agent writes `{u32 seq, i32 status}`
  after the selection is installed (status 0) or after it fails (a
  negative errno). The kernel stores the last acknowledgement.
- **Single owner.** A second opener from another process gets `EBUSY`,
  using the mice model. The point is that only the agent sees pasted
  text, not every process that can open `/dev`. The node shows as
  `S_IFCHR`, with a Linux-style `st_rdev` taken from the misc major.
- **Fork.** Per-OFD state (the read cursor and the in-progress record)
  is serialized like `InputFdState`. That raises `FORK_VERSION`
  (`fork.rs:48`). `FORK_VERSION` is internal to the kernel and is not
  `ABI_VERSION`.

### Host side: Node and browser as peers

- Kernel exports: `kernel_clipboard_offer(ptr, len) -> i32`, which
  returns the new seq, or `-ENXIO` when no reader has the device open,
  or `-EMSGSIZE` over the cap; and `kernel_clipboard_ack(seq) -> i32`,
  which returns pending, 0, or the agent's negative status. The bytes
  reach kernel memory through the existing scratch allocation, as other
  host→kernel buffers do.
- In `CentralizedKernelWorker`, add `offerClipboardText(bytes)`: run
  under `#runOrDeferKernelEntry`, call the export, and call
  `scheduleWakeBlockedRetries`. It resolves when the ack arrives or a
  bounded timeout passes. While an offer is pending, the worker checks
  `kernel_clipboard_ack` after each kernel entry, next to the existing
  post-syscall `kernel_drain_wakeup_events` drain
  (`kernel-worker.ts:15701`). Nothing is checked when no offer is
  pending. This avoids a new kernel→host import or a new wakeup type.
- `BrowserKernel` gets `offerClipboardText(text)` through a new
  request/response pair in `browser-kernel-protocol.ts`, alongside
  `InputEventInjectMessage`. `NodeKernelHost` gets the same method with
  the same result type. On Node it is a real API for embedders and
  tests, not a no-op. The only browser-only part is the gesture in
  Layer 3, which depends on a DOM `paste` event that Node does not
  have. That is a real platform boundary, the same one
  `NodeInputSource` already documents.

### kclipd, the agent

kclipd is a small C Wayland client in `programs/`, built with the
compositor's demo programs. It:

1. Opens the device. If the open fails, it logs the errno and exits
   non-zero, so a missing device shows up in the machine's terminal and
   syslog.
2. Binds `zwlr_data_control_manager_v1` and gets a device for the seat.
3. Loops: block in `poll` on the device fd and the Wayland fd together.
   For each offer, create a data-control source that offers
   `text/plain;charset=utf-8`, `text/plain`, `UTF8_STRING`, and `TEXT`,
   and call `set_selection`. After `wl_display_roundtrip`, the
   compositor has installed the selection; if the source was not
   `cancelled`, write ack status 0. Serve `send(mime, fd)` by writing
   the bytes and closing the fd.

`omarchydesktop` starts it after the compositor's socket is up, as it
does for mako. The image declares a new runtime feature, `clipboard`,
in the omarchy profile
(`packages/registry/shell/source-rootfs-shell-demo.json:216-252`). That
feature is what makes the host attach the Layer 3 gesture. Per the rule
in `web-libs/kandelo-session/src/demo-config.ts:157-169`, the feature
has a real consumer.

Why an agent, rather than having the compositor read the device
directly? Because `docs/browser-support.md` records "port real Hyprland"
as the deferred end state. A data-control agent still works unchanged
once real Hyprland replaces `wlcompositor`. A compositor that reads
`/dev/kandelo/clipboard` would not.

### Compared with the cheaper alternative

The cheaper route needs no kernel change. The host writes the text to
a file through the existing VFS write RPC (`writeFileToVfs`,
`host/src/browser-kernel-host.ts:1429`, `host/src/node-kernel-host.ts:
986`), and a guest loop polls for the file, as the ScummVM upload
watcher does (`SCUMMVM_LAUNCH_SCRIPT`,
`images/vfs/scripts/build-source-rootfs-shell-image.ts:309-338`, with a
one-second `sleep`).

| | Device | File drop |
|---|---|---|
| Kernel/ABI work | New device, two exports, snapshot regen | None |
| Latency | Wakes the parked reader immediately | Polling interval, or a busy loop; `inotify` fails with `ENOSYS` (ABI 45) |
| Ack path | `write` to the device; export polled only while pending | A second file that the host must read back by polling |
| Atomicity | One record, latest wins | `writeFile` is not rename-atomic, so a reader can see a partial file |
| Privacy | Bytes live in kernel memory until the agent reads them; single owner | Clipboard text becomes a file: readable under file permissions, it can land on persisted OPFS mounts, and the planned live-overlay snapshot walker (`web-libs/kandelo-session/src/snapshot.ts` header) would fold it into shared URLs |
| Truthfulness | `ls /dev` shows a host clipboard device that exists | A file in the filesystem stands in for something that is not a file |

**Recommendation: the device.** The file drop's only advantage is that
it avoids kernel work. Its privacy problem conflicts with the browser
contract's persistence and sharing rules: clipboard text must not
become durable, shareable state.

### ABI implications

`docs/abi-versioning.md:137-155` lists the additive changes:

- New kernel exports are additive. Regenerate `abi/snapshot.json`
  (`cargo xtask dump-abi`); this needs no `ABI_VERSION` bump. List them
  in `HOST_ADAPTER_OPTIONAL_KERNEL_EXPORTS`
  (`crates/shared/src/lib.rs:3106`) so that a kernel without them makes
  the host report "clipboard unavailable" and does not fail manifest
  validation.
- The header struct and constants are a new guest-visible wire format.
  Adding new names is additive. Changing them later requires a bump.
- The new device path changes `open("/dev/kandelo/clipboard")` from
  `ENOENT` to success and adds an entry to `ls /dev`. No existing binary
  depends on either, and a new kclipd on an older same-epoch kernel
  fails with `ENOENT`, which is honest. **Proposed: no bump on its own.**
  Record the change in `abi-versioning.md` in the current epoch's
  section. Reviewers decide whether this counts as a semantic change
  that needs a bump (see Open questions).
- `FORK_VERSION` bump: internal to the kernel, as above.
- No new kernel imports and no new wakeup types. Adding either *would*
  require a bump (`abi-versioning.md:86-89`).

## Layer 3: the browser paste gesture

### Flow

The flow applies only to a machine whose image declares `clipboard`,
and only while the KMS surface has keyboard focus (the existing
`demoSurfaceCaptureGate`, `host/src/input/demo-surface-gate.ts`):

1. **Candidate chord.** On keydown with `key` `v`/`V` and exactly one of
   `metaKey`/`ctrlKey` (Shift allowed), `BrowserInputSource` does **not**
   call `preventDefault`. It does not emit the key either. It enters a
   *paste-pending* state that holds this chord and every later evdev
   record in an ordered queue.
2. **The browser decides.** If a `paste` event follows, the gesture was
   a real paste. The handler reads
   `clipboardData.getData("text/plain")` and calls `preventDefault()` so
   nothing is inserted into a page element. Kandelo never calls
   `navigator.clipboard.readText()`. A genuine paste gesture triggers no
   permission prompt in any engine, and the clipboard is read only on
   that gesture. If no `paste` event arrives before the next task (for
   example, Ctrl+V on macOS is not a paste chord), the queue flushes and
   the chord reaches the guest as ordinary keys. This avoids sniffing
   the platform; the browser's own paste binding decides.
3. **Offer.** If the text is non-empty, within the size cap, and
   different from the last text this page offered, call
   `kernel.offerClipboardText`. If the text is empty (the clipboard
   holds no text) or unchanged, skip the offer and flush. The guest then
   pastes its own current selection. This keeps in-desktop copy/paste
   working without copy-out sync.
4. **Ack.** On ack 0, flush the queue in order: the user's chord first
   (SUPER+V on macOS, which hits Omarchy's bind; CTRL+V or CTRL+SHIFT+V
   elsewhere), then every key typed meanwhile. The compositor's binds
   pick Ctrl+V or Ctrl+Shift+V by tag. Because the selection event was
   sent to the focused client before the chord's key events, foot's
   `receive` sees the new text. Holding later keys is what keeps
   "Cmd+V, Enter" from running the command line before the paste
   lands.
5. **Failure.** No agent (`-ENXIO`), over the cap, an agent error, a
   timeout, or a kernel without the exports all lead to the same
   handling: drop the chord and the held keys, and show a `kdemo-toast`
   with `role="alert"` in the KMS pane (the existing ingest-error toast
   pattern, `apps/browser-demos/pages/kandelo/panes/Modeset.tsx:441-458`).
   The toast states the cause and the number of discarded keystrokes,
   for example "Paste failed: clipboard agent is not running in this
   machine; 1 keystroke discarded". Pasted text is never truncated;
   truncation would be a silent lie about the content.

### Limits and boundaries

- **Size cap:** proposed at 1 MiB of UTF-8, enforced by the host before
  the offer and again by the kernel (`EMSGSIZE`). The value needs review.
- **Text only.** Images, `text/html`, and file lists are out of scope.
  When a paste carries none of these as text, it is treated as empty
  (step 3).
- **Logging.** Clipboard contents never appear in syslog, syscall
  traces, or console output; only lengths and sequence numbers do. This
  needs checking against the syscall trace path for device reads.
- **Engine differences, to probe before building:** whether Safari and
  Firefox fire `paste` for Cmd/Ctrl+V when focus is on `<body>` and not
  on an editable element. WebKit's Paste command is disabled outside
  editable content. If either engine does not fire it, the KMS surface
  needs an off-screen, focusable `<textarea>` inside the surface (the
  approach noVNC and Guacamole use). The capture gate already treats
  focus inside the surface as captured. Also to check: the
  `getData("text/plain")` line endings each engine returns (CRLF on
  Windows).
- **Existing macOS quirk:** browsers on macOS do not deliver keyup for a
  key released while Cmd is held. The code does not handle this today.
  Check whether V is left logically held in the guest after Cmd+V,
  because this flow makes that chord common.

## Phased implementation

**Phase 1: Layer 1 (compositor).** Vendor the data-control XML. Add
selection, offers, receive forwarding, and data-control to
`wlcompositor.c`. Add `sendshortcut`, tags, and the clipboard binds; add
the CTRL+V mirror to the Omarchy conf. Tests:
`host/test/wlcompositor-clipboard-smoke.test.ts`, using a new test client
(`programs/wlcompositor/wlclip-test.c`) in two roles. Client A sets
text; focus moves to client B, which receives the offer and reads the
text over a pipe. A replaced source gets `cancelled`. A data-control
client sets the selection with no focus. Extend
`wlcompositor-keybind-smoke.test.ts` so that SUPER+V reaches a tagged
client as Ctrl+Shift+V with explicit modifiers while SUPER is held.
Manual check: in `./run.sh browser`, copy between two foot windows.

**Phase 2: Layer 2 (device and agent).** Runtime-core unit tests: devfs
listing and stat, single owner, framing across a short buffer, latest
wins, a record replaced mid-read, blocking read, `O_NONBLOCK`, poll,
ack, the cap, and the fork round-trip. A device conformance program,
wasm32 and wasm64, in the style of `scm-rights-pipe-lifetime`, driven
from Node through `offerClipboardText`. An end-to-end Node smoke: offer,
then kclipd, then the compositor, then `wlclip-test` reads the same
bytes and the offer resolves with ack 0. Regenerate the ABI snapshot.
Consider the kernel conformance suites under
`docs/agent-guidance/validation.md`, because this adds a device and
fork state.

**Phase 3: Layer 3 (browser).** Add the `clipboard` runtime feature, the
gesture in `BrowserInputSource` (or a companion class attached by
`attachDeclaredInputSource`, `live-setup.ts:1777`), the worker protocol
messages, and the toast. Add a Playwright spec,
`apps/browser-demos/test/kandelo-omarchy-clipboard.spec.ts`: boot
omarchy, open foot, put text on the clipboard (on Chromium through
granted `clipboard-write`), press `ControlOrMeta+V`, then assert the
text in the terminal and the absence of an error toast. Add a failure
case with kclipd killed, asserting the toast. Whether Playwright's
synthesized chord triggers a real `paste` in each engine is itself a
probe. Engines where it does not must be verified by hand in
`./run.sh browser`, including Safari.

**Docs, in each phase as the behavior lands:** the Omarchy section and
deferred-work list in `docs/browser-support.md` (keybinds, the CTRL+V
cost, what pastes, the failure toast). The Wayland stack paragraph in
`docs/architecture.md:2447`. A `/dev/kandelo/clipboard` row in
`docs/posix-status.md` next to `/dev/dri/card0` (`:270`). The current
epoch's section in `docs/abi-versioning.md`. The PR24 status in the
compositor plan.

## Copying out (implemented 2026-10-02)

The reverse direction uses the same channel. kclipd watches data-control
`selection` events, reads text selections it did not set, and writes
them to the device as a second record kind (`KIND_GUEST_TEXT`). The
device keeps the latest one and a generation counter.

The design first sketched here — let the browser's `copy` event fire and
call `clipboardData.setData` with a selection already in host memory —
was not used: it needs the guest's selection in the host before the
gesture, which means copying every desktop selection out as it happens.
The maintainer chose instead (decision 2026-10-02) to copy out only on a
copy gesture over the desktop: on the chord's keydown the host samples
the generation, starts `navigator.clipboard.write` with a
`ClipboardItem` whose data is a promise (the form Safari requires inside
a gesture), and fills it when the generation changes, within 2 s. If
nothing is copied, the promise rejects and the host clipboard is left
alone.

Keys (decision 2026-10-02): paste on `Cmd+V`, `Ctrl+V`, `Ctrl+Shift+V`
and `Shift+Insert`; copy on `Cmd+C`/`Cmd+X`, `Ctrl+Shift+C`,
`Ctrl+Insert`, `Ctrl+C`/`Ctrl+X`. The compositor binds `Shift+Insert`
and `Ctrl+Insert` through `kandelo:sendshortcutiftag`, so a terminal
gets the clipboard chords rather than its own `Shift+Insert` (PRIMARY).
`Ctrl+C` still reaches a terminal as SIGINT; it arms copy-out, which
times out harmlessly.

A successful copy-out records its text as what the guest holds, so the
X, Y, X edge in step 3 is resolved for keyboard copies. It remains for
copies made from a menu with the mouse, which have no gesture.

## Future work

- **Touch devices** (deferred explicitly, 2026-10-02). iOS and iPadOS
  have no keyboard chord, so neither paste nor copy-out has a gesture
  there. Two candidates: a long-press menu in the desktop pane offering
  Copy and Paste (a page-owned menu whose button press is the user
  gesture both directions need), or the native callout on a focused,
  offscreen `<textarea>` mirroring the guest's selection, which gets the
  system's own Copy/Paste items but must keep the mirror in sync with
  the desktop. Either needs the desktop selection to be visible to the
  page at the moment the menu opens.
- Copy-out for copies made without a copy chord (a menu item clicked
  with the mouse).
- A clipboard manager behind `SUPER+CTRL+V`, primary selection, and
  non-text MIME types.

## Open questions

1. **Device name.** `/dev/kandelo/clipboard`, or a virtio-serial-style
   name (`/dev/virtio-ports/org.kandelo.clipboard.0`) that names the
   pattern being copied?
2. **ABI.** Is a new device path additive (snapshot only, as proposed),
   or a semantic change that needs an `ABI_VERSION` bump? If another
   bump is in flight, should this fold into it?
3. **Size cap and framing.** Is 1 MiB right? Does a single large
   character-device `read()` already cross the channel atomically? If it
   does, the streaming-record design could be simpler.
4. **Data-control flavor.** wlr first, as recommended, or ext only, or
   both? Which ones does the Hyprland version targeted by the
   real-Hyprland port advertise?
5. **Tag-conditional dispatcher syntax.** It has no Hyprland `.conf`
   equivalent. Pick a name and form, and document it as a stand-in for
   Omarchy's Lua.
6. **Failure handling of held keys.** Discard them (proposed, because it
   is safer for "paste, Enter") or flush them without the chord?
7. **The dedupe rule.** "Offer only changed text" lets an in-desktop
   copy survive a paste of unchanged host text. It is wrong in one case:
   copy X on the host, copy Y in the guest, copy X on the host again,
   and the guest pastes Y. Accept this until copy-out exists?
8. **Line endings.** Normalize CRLF to LF before the offer?
9. **Ack timeout value**, and whether polling the ack export after each
   kernel entry is acceptable on the syscall path. That path is
   performance-sensitive (`docs/agent-guidance/performance.md`), even
   though the check runs only while an offer is pending.
10. **Agent implementation.** A Kandelo C agent (proposed), or port
    wl-clipboard and wrap `wl-copy`? The port would also give terminal
    users `wl-copy`/`wl-paste`, but framing and acks are awkward in
    shell.
11. **Touch devices.** iOS and iPadOS have no keyboard chord. A paste
    callout on a focused `<textarea>` might work. Out of scope here?

## Decisions (2026-10-01, maintainer)

Phase 1 (Layer 1) is implemented. The open questions above were answered
before Layers 2 and 3:

1. **Device name:** `/dev/kandelo/clipboard`.
2. **ABI:** additive. Regenerate the snapshot, list the new exports as
   optional host-adapter exports, record the device in
   `abi-versioning.md`; no `ABI_VERSION` bump. (Briefly revised on
   2026-10-02 to a dedicated epoch when copy-out was added, then
   returned to additive on 2026-10-05: every change, copy-out included,
   only adds, and both sides already fail honestly against a peer
   without the device — the agent gets `ENOENT`, the host reports
   `unsupported` — so a bump would only have forced every binary to be
   rebuilt.)
3. **Size cap and framing:** 1 MiB. A read returns at most one record,
   and a per-OFD cursor lets a short buffer stream through it. Measured
   fact behind this: a guest `read()` larger than 64 KiB is one kernel
   `sys_read` through `kernel_transfer_scratch_begin`, not a chunked
   copy, so the channel size does not constrain the record.
4. **Data control:** add `ext_data_control_v1` to wlcompositor alongside
   the wlr protocol from Phase 1; kclipd speaks ext. Hyprland v0.56.2
   advertises both, and wlr was deprecated upstream in July 2025.
5. **Conditional dispatcher:** named `kandelo:sendshortcutiftag`, in
   Hyprland's plugin-dispatcher namespace style.
6. **Failed paste:** discard the held keys and show a toast that names
   the cause and the number of discarded keystrokes.
7. **Dedupe:** ship "offer only changed host text" now and document the
   X, Y, X edge. Latest-wins between host and guest comes with copy-out.
8. **Line endings:** convert CRLF pairs to LF; leave lone CRs alone.
9. **Ack:** the host polls `kernel_clipboard_ack` on a timer only while
   an offer is pending, with a 2 s timeout. Nothing is added to the
   syscall completion path.
10. **Agent:** a small C kclipd. Porting wl-clipboard is separate work.
11. **Touch devices:** out of scope; recorded as a gap, and on
    2026-10-02 deferred explicitly to future work (see above).

Implementation note: Layer 3 step 2's "before the next task" was too short.
In a real macOS browser (Brave), `paste` arrives a task or more after the
Cmd+V keydown, because the browser runs Edit > Paste only after the page
leaves the key unhandled; Playwright's synthetic chord hides this by firing
`paste` in the same task. The gesture waits up to 500 ms instead.

Also decided: the macOS missing-keyup-under-Cmd quirk is fixed in Phase 1
(BrowserInputSource releases keys pressed under Meta when Meta goes up);
the protocol XML stays in `packages/registry/wayland-protocols`, with
`ext-data-control-v1.xml` batched into the Layer 2 change so the
consumer rebuild happens once; Phase 1 goes up as its own PR and Layers
2 and 3 stack on it.
