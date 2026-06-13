# Kandelo UI follow-ups

Captures work deferred while landing the initial Kandelo UI implementation
(branch `claude-design-handoff-initiation`). Each item is independently
shippable.

## Design reconsiderations

### Re-examine the shareable-computer URL dream

The current URL is a *boot descriptor* — a pointer to signed package
refs + a small inline overlay slot. The session that built this branch
deferred actually capturing the user's edits into that overlay, so the
URL today encodes the preset, not what's running.

Open questions to revisit before committing to the overlay design:

- **Granularity.** Op-log per writable mount (mkdir/write/chmod/unlink/
  rename/symlink/utime/whiteout) vs. whole-file replacement vs. block-
  level VFS diff. The design doc favors op-log; the trade-off vs.
  serialized SQLite/key-value state for app-heavy mounts (WordPress,
  MariaDB) needs concrete sizing data.
- **Scope of the writable mount.** Just `/home/user` (small,
  hand-editable), or everything (large, mutates often)? A whitelist
  per preset feels right but adds product surface.
- **Encoding cost.** CBOR + zstd vs. JSON + gzip (today). The
  difference is ~2× URL size but adds 150KB of wasm.
- **Privacy default.** Plaintext overlay in fragment vs. always-
  encrypted with key-in-fragment. Plaintext is debuggable; encryption
  is hostile to inspection.
- **Pre-share preview.** Show the user the exact bytes their URL
  captures before they share. Mode picker UI hints at this but the
  current preview is descriptor-only.

This is a design discussion, not implementation. Worth a follow-up
design doc that supersedes parts of `2026-05-11-shareable-computer-
url-design.md`.

## Deferred vitest coverage

`web-libs/kandelo-session/test/kandelo-session.test.ts` covers LiveKernelHost
status, descriptor, lifecycle, gallery, snapshot, and demo-config behavior
(28 specs). Still missing:

### boot-descriptor round-trip + validation (~12 specs)

- `encodeBootDescriptor → decodeBootDescriptor` round-trip for every
  preset in `PRESET_LIBRARY`. `decode(encode(d))` deep-equals `d`.
- `validateBootDescriptor` rejection cases:
  - `version !== 1`
  - missing `id` / `title` / `base`
  - `mounts` array longer than `HARD_CAPS.maxMounts` (32)
  - path > `HARD_CAPS.maxPathLen` (1024)
  - unknown mount source string
  - inline-overlay `data` > `HARD_CAPS.maxInlineOverlayBytes` (32KB)
  - `boot.argv` empty
- `classifyTier` at all 4 boundaries (`2048/2049/8192/8193/32768/32769`).
- `buildShareUrl` URL shape per mode (`preset`, `delta`, `inline`,
  `manifest`, `private`, `local`).
- `shortHash` stability across calls.

### snapshot mode-picker (~6 specs)

- `pickMode(0)` → `preset`
- `pickMode(6000)` → `delta` (boundary)
- `pickMode(6001)` → `inline`
- `pickMode(28000)` → `inline` (boundary)
- `pickMode(28001)` → `manifest`
- `takeSnapshot` with `preferMode: "manifest"` overrides auto pick
- `takeSnapshot` promotes to `manifest` when the encoded payload
  exceeds `HARD_CAPS.maxCompressedBytes` (forces the encoder-failure
  path through `BootDescriptorError`).

### React hook tests

Requires happy-dom + react-testing-library (not currently wired into
host/test). Worth doing once it's set up:

- `useStatus` subscribes on mount, returns the latest status, unsubs
  on unmount.
- `useDmesg` accumulates lines through `subscribeDmesg`; matches
  `host.dmesgHistory()` on first render.
- `useProcessEventBump` increments exactly once per event; does NOT
  re-subscribe on parent re-render.
- `useSnapshot` re-runs on status change; returns `null` until first
  snapshot resolves.

### Browser-side end-to-end (Playwright)

- Kandelo default route boots live, bash prompt appears in shell, Procs lists
  bash + init.
- Quit DOOM via menu → Procs drops fbdoom; canvas clears.
- Relaunch fbdoom from bash → canvas re-attaches.
- Focused framebuffer panes forward keyboard input as Linux keycodes; clicking
  another pane or pressing Ctrl+Shift+Esc moves focus back to the UI.
- Procs tab post-exec shows `fbdoom -iwad /doom1.wad`, not `bash`.

### Kernel-export tests (synthetic harness)

- `kernel_enum_procs` against a kernel with a small fake process
  table (record format + zombie filter).
- `kernel_read_proc_maps` returns the mappings recorded by `proc.
  memory.mappings()`.

## Codec migration

### CBOR + zstd

Current envelope: `#k1=base64url(gzip(JSON(descriptor)))`. Spec calls
for `#k1=base64url(zstd(cbor(descriptor)))`. Migration:

- Bump envelope name `k1` → `k2`; keep a `k1` decoder for backward
  compat (old links keep working).
- Add `cbor-x` (~50KB) and `@bokuweb/zstd-wasm` (~150KB) deps.
- Expected URL-size reduction: ~2× for typical preset descriptors.

## Real overlay capture

The product thesis piece. The dataflow:

1. **Capture.** Add an op-log wrapper around `MemoryFileSystem` (or
   whatever writable mount backs the overlay). Each write/mkdir/
   chmod/unlink mutates the underlying FS AND appends to a per-mount
   op-log.
2. **Serialize.** CBOR-encode the op-log into the descriptor's
   inline-overlay `data` field at snapshot time.
3. **Replay.** On boot from a descriptor with `inline-overlay`,
   decode the data and replay the op-log against the writable mount.

Open work:

- Where the op-log lives (host-side wrapper vs. kernel-side hook).
- How to handle binary file writes that compress poorly (chunked
  zstd vs. opaque pointer to lazy-fetch).
- Retention window: keep all ops, or coalesce on idle?
- Performance budget for capture: ideally invisible during normal
  use, expensive only on `host.snapshot()`.

## Syscall trace v1

Today's tracer emits at syscall *entry* only — return value column
is blank, args are raw integers, polling is 250 ms.

- **Pair entry/return events.** Hook both `_handleSyscallInner` start
  AND the `completeChannel` paths; pair by (channel offset, generation
  counter); emit a single `SyscallEvent` with both `args` and `ret`.
- **Pointer arg formatting.** Reuse `kernel-worker.ts: formatSyscall
  Entry` (it already dereferences C strings for `open`, `stat`,
  `chdir`, etc.). Wire its output into the trace ring instead of /
  alongside the existing raw args.
- **Push-style events.** Replace the 250 ms polling drain with
  worker→main `syscall_event` postMessage per batch. Wait for the
  trace tab to be visibly slow under load before paying the message
  cost.

## Pane affordances polish

- When a pane is maximized, today both the slot view AND the `.kmax`
  overlay render the same component (xterm in Shell, canvas in
  Framebuffer). Slot view is hidden behind the overlay but its
  effects still run — RAF loops, subscriptions. Skip-render when
  maximized to free those.
- Drag-and-drop visual feedback could be sharper: a "drag preview"
  showing the pane title near the cursor while dragging would make
  the affordance more discoverable.
- The PaneHead's hover state on the drag-grip handle could light up
  more clearly than today's subtle `color-mix(in oklch, var(--k-text) 8%,…)`.

## Kernel/host parity loose ends

- **exec doesn't update `Process.argv` kernel-side.** Today we update
  it from `handleExec` via `kernel_set_process_argv`. Cleaner: have
  `sys_execve` accept the new argv and update `proc.argv` itself.
  Avoids a post-exec window where the kernel-side view is stale.
- **attachFramebuffer doesn't disable previous canvas's RAF when
  the same pid rebinds.** Edge case (would only matter if a process
  unbinds + rebinds /dev/fb0 while the pane is mounted), but worth
  cleaning up.
- **Real dmesg ring buffer.** Currently the host pushes synthetic
  setup events to LiveKernelHost.pushDmesg; the kernel-side ring
  isn't connected. A `kernel_drain_dmesg` export mirroring the
  syscall trace pattern would wire `printk!`-equivalent kernel logs.

## Workspace / repo hygiene

- The `libc/musl/` submodule's working tree is dirty (we populated it via
  cp from a sibling worktree to bootstrap the build). The gitlink
  itself is unchanged so commits won't carry the dirtiness, but a
  clean `git submodule update --init libc/musl` in a fresh checkout
  reconstitutes the same state from upstream.
- Screenshots accumulated under `/tmp/kandelo-screenshots/` during
  development. Not in the repo; nothing to clean.
- The `design_handoff_kandelo_ui/` directory at repo root is the
  designer's reference bundle (HTML/JSX prototype + screenshots +
  spec docs). Decide whether to commit it (history of the design)
  or treat it as ephemeral input that doesn't belong in tree.
