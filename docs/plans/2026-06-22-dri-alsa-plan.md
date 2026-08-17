# DRI v2 — ALSA plan (`/dev/snd/pcmC0D0p` + `controlC0`)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task.

**Goal:** Add the two `/dev/snd/*` device nodes the ALSA / SDL2 audio
stacks look for first — `/dev/snd/controlC0` (card-level control
surface) and `/dev/snd/pcmC0D0p` (PCM playback device 0 of card 0) —
exposing Linux's ALSA UAPI: a `read`-only `mmap_status` page +
`read-write` `mmap_control` page + interleaved-write PCM data ring,
the `SNDRV_PCM_IOCTL_*` parameter-negotiation + state-machine ioctls
that alsa-lib drives, and `poll(POLLOUT)` readiness on the pcm fd.
Audio data flows user → kernel-ring → host-side AudioWorklet → output
device on the browser; user → kernel-ring → silent-discard on Node
(with a checksum hook for tests). The plan ships the **device + ring
+ ioctl surface + AudioWorklet bridge** ; the full ALSA mixer surface
(controlC0 ELEM_WRITE / power-management / hot-plug) is deferred to
plan 9 (wpkcompositor) which is the only PID expected to drive
mixer state.

**Architecture:** Two virtual devices, sourced through a single
host-side `AudioDriver` per host class (browser AudioWorklet, Node
setInterval-dummy). `/dev/snd/pcmC0D0p` exposes the PCM playback
state machine + interleaved-write ring; `controlC0` exposes a
minimal card-info / element-list surface (no writes in v1). Per-OFD
`AlsaFdState` carries the PCM state (`HW_PARAMS` cache, mmap-status
page, mmap-control page, SAB-backed audio ring) on a pcm OFD; a
separate `AlsaControlFdState` carries the simpler control-fd state.
A new kernel export `kernel_audio_period_tick(pcm_id, frames_consumed)`
is the single entrypoint from host → kernel — the host calls it once
per AudioWorklet quantum (browser) or per `setInterval` tick (Node)
to advance `mmap_status->hw_ptr` and wake `poll(POLLOUT)` waiters.
The PCM data ring is a SharedArrayBuffer allocated host-side at boot
and mmap'd into the kernel (the kernel sees it as a `&mut [i16]`
slice into its linear memory). Userspace's `mmap(pcm_fd, ...,
SNDRV_PCM_MMAP_OFFSET_DATA)` returns the same SAB region, so
`WRITEI_FRAMES` is implemented by user-process direct writes into the
SAB followed by an `appl_ptr` advance in the mmap_control page —
zero kernel-copy on the audio data path. Companion design doc:
`docs/plans/2026-05-18-dri-design.md` §8 (Audio) + §16 q6
(`CLOCK_MONOTONIC` timestamps).

**Tech Stack:** Rust kernel (wasm64), TypeScript host (browser
AudioWorklet for the playback consumer, Node setInterval for the
dummy), C user programs cross-compiled with `wasm32posix-cc`.
Sysroot side vendors `<sound/asound.h>` from Linux UAPI under
`musl-overlay/include/sound/`. No alsa-lib stub in v1 — the demo
issues ioctls directly via syscalls; full alsa-lib port is plan 7's
problem (SDL2's audio backend pulls in alsa-lib).

**Critical wasm32 ABI detail — ALSA structs are LARGE and contain
many UAPI flags.** `struct snd_pcm_hw_params` is 596 bytes on
wasm32 (matches Linux's `__u32`-and-bitmap layout). `struct
snd_pcm_sw_params` is 136 bytes. `struct snd_pcm_status` is 128
bytes. We vendor `sound/asound.h` verbatim from Linux v6.10 UAPI
headers; static-asserts in Task A1 Step 2 lock the sizes against
the wasm32 `repr(C)` layout. Any drift means alsa-lib (when plan 7
ports it) reads the wrong bytes. Field-offset asserts on the most
load-bearing fields (`access`, `format`, `rate`, `channels`,
`period_size`, `buffer_size`) inside `snd_pcm_hw_params` cover the
high-traffic path.

**Clock source: `CLOCK_MONOTONIC`** (design §16 q6). Every
`snd_pcm_status.audio_tstamp / tstamp / trigger_tstamp` field
filled from `crate::time::monotonic_us()` — same source plan 4 A7
and plan 5 A4 use. Lets userspace correlate audio underrun
timestamps with vblank + input timestamps for jitter / A-V-sync
profiling. No `SNDRV_PCM_IOCTL_TTSTAMP` (clock-source-selection
ioctl) — clock is fixed.

**Design reference:** `docs/plans/2026-05-18-dri-design.md` §8.1
(devices), §8.2 (ioctl shape), §8.3 (v1 dummy backend), §8.4 (v2
WebAudio backend); §16 q6 (clock source). POSIX vs Linux UAPI:
`open` / `close` / `read` / `write` / `poll` / `ioctl` / `mmap`
are POSIX; `struct snd_pcm_*` layouts + `SNDRV_PCM_IOCTL_*` numbers
+ ALSA flag constants are Linux UAPI, followed verbatim.

**Consistency with plans 2 + 3 + 4 + 5:**
- Plan 5 introduced `VirtualDevice::InputEvent { device: u8 }` and
  `OpenFileKind::InputEvent { device: u8 }`. Plan 6 adds
  `VirtualDevice::AlsaPcm { card: u8, device: u8, sub: u8, kind:
  PcmDir }` and `VirtualDevice::AlsaControl { card: u8 }`.
  Single-card-single-device-single-substream in v1 (`card=0`,
  `device=0`, `sub=0`, `kind=PcmDir::Playback`). The
  enum-variant-with-payload keeps the match exhaustive without
  proliferating top-level variants.
- Plan 5's `Option<Box<InputFdState>>` field on `OpenFileDesc` is
  the precedent. Plan 6 adds `audio: Option<Box<AlsaFdState>>` as
  a third sibling of `dri_state` + `input` — disjoint state machine,
  separate field. The "one box per device class" factoring plan 5
  established holds.
- Plan 5's `kernel_input_event` taught the kernel about host-driven
  consumer callbacks. Plan 6 A6's `kernel_audio_period_tick` is
  similar shape but the dataflow is INVERTED:
  - **plan 5**: host → kernel push (DOM events → kernel ring →
    userspace `read`).
  - **plan 6**: userspace → kernel-mediated SAB → host pull
    (WRITEI_FRAMES → SAB → AudioWorklet `process()` quantum). The
    host's "tick" is a *notification* that frames were consumed,
    not a *data push*.
- Plan 4 A7 + plan 5 A4 both lock the PROCESS_TABLE briefly to
  iterate OFDs. Plan 6 A6 does the same. The "OFD-table split"
  architecture-open in plan 4 (carried forward in plan 5) gains
  one more producer here — period-tick rate is low (~50 Hz at
  16 ms period; AudioWorklet quantum is 128 frames / 48 kHz ≈ 375 Hz
  if used as a direct trigger), but at 375 Hz combined with input's
  1000+ Hz autorepeat + drag, the lock-contention argument for the
  refactor strengthens further.
- Plan 4's `CLOCK_MONOTONIC` clock-source + plan 5's same clock
  pinning carry through. All three event streams (vblank, input,
  audio) reference the same `monotonic_us()` helper.

**Stack base:** Plan 5's `…-evdev-demo` branch tip. Plan 6 extends
the kernel + host without touching plans 2–5's surfaces; the
dispatcher gains `AlsaPcm` + `AlsaControl` arms on `VirtualDevice`,
the syscall layer adds an `audio::*` module, and the host gains
an `audio/` subdirectory mirror of `input/`. No regressions to
plans 2–5 tests.

**Branch:** `emdash/explore-direct-rendering-infrastructure-alsa-plan-XXXXX`
(chains off plan 5 per the branching rule). Three sub-branches stack
off it.

**Final PR base:** Plan 5's `…-evdev-demo` tip. Do not merge until
Brandon validates the design, plan 5 lands, and Phase C's manual
browser verification passes (CLAUDE.md item 6).

**Three PRs, coordinated merge.** Each task below is one commit.
Brandon's `scope(area): action` titles:

1. `kernel(audio): /dev/snd/{controlC0,pcmC0D0p} + SNDRV_PCM_IOCTL_* + mmap pages`
2. `host(audio): AudioDriver (browser AudioWorklet, Node dummy) + SAB ring bridge`
3. `examples(audio): alsa_demo + browser spec`

PR base/head topology (stacked):

```
explore-webgl-exposition-demo                   (v1 tip)
 └── …-buffer-plan-XXXXX                        (plan 2)
      └── …-buffer-demo
           └── …-multiplexer-plan-YYYYY         (plan 3)
                └── …-mux-demo
                     └── …-kms-plan-ZZZZZ      (plan 4)
                          └── …-kms-demo
                               └── …-evdev-plan-WWWWW    (plan 5)
                                    └── …-evdev-demo
                                         └── …-alsa-plan-VVVVV    (this plan)
                                              └── …-alsa-kernel  (PR #1)
                                                   └── …-alsa-host  (PR #2)
                                                        └── …-alsa-demo  (PR #3)
```

**Verification gauntlet** (CLAUDE.md): all of the below must pass
with zero regressions before any PR is opened, and re-run before final
merge:

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

`XFAIL` / `TIME` are acceptable; `FAIL` that isn't pre-existing is a
regression. Phase C adds manual `./run.sh browser` verification of
the alsa demo (CLAUDE.md item 6) — a 440 Hz sine wave is audible for
~2 s through the browser's default audio output.

**ABI impact:** **Additive only — no `ABI_VERSION` bump.** Per
`docs/abi-versioning.md` (PR #490 policy):
- New `repr(C)` structs in `shared::audio` mirroring Linux's
  `sound/asound.h` UAPI (sizes static-asserted in A1 Step 2):
  - `WpkAlsaPcmHwParams` (596 bytes)
  - `WpkAlsaPcmSwParams` (136 bytes)
  - `WpkAlsaPcmStatus` (128 bytes)
  - `WpkAlsaPcmInfo` (288 bytes)
  - `WpkAlsaPcmMmapStatus` (64 bytes; the kernel-writes-userspace-reads page)
  - `WpkAlsaPcmMmapControl` (64 bytes; the userspace-writes-kernel-reads page)
  - `WpkAlsaCtlCardInfo` (256 bytes)
  - `WpkAlsaCtlElemId` (64 bytes)
  - `WpkAlsaCtlElemList` (76 bytes; rounded to 80 for alignment — verify)
- New ioctl numbers — verbatim Linux UAPI for the `'A'` magic (ALSA's
  ctl ioctls use `'U'`; the kernel uses `'A'` for PCM, `'U'` for ctl):
  - PCM `'A'` magic:
    - `SNDRV_PCM_IOCTL_PVERSION = _IOR('A', 0x00, int)` → `0x8004_4100`
    - `SNDRV_PCM_IOCTL_INFO = _IOR('A', 0x01, WpkAlsaPcmInfo)` → `0x8120_4101`
    - `SNDRV_PCM_IOCTL_HW_REFINE = _IOWR('A', 0x10, WpkAlsaPcmHwParams)` → `0xc254_4110`
    - `SNDRV_PCM_IOCTL_HW_PARAMS = _IOWR('A', 0x11, WpkAlsaPcmHwParams)` → `0xc254_4111`
    - `SNDRV_PCM_IOCTL_HW_FREE = _IO('A', 0x12)` → `0x0000_4112`
    - `SNDRV_PCM_IOCTL_SW_PARAMS = _IOWR('A', 0x13, WpkAlsaPcmSwParams)` → `0xc088_4113`
    - `SNDRV_PCM_IOCTL_STATUS = _IOR('A', 0x20, WpkAlsaPcmStatus)` → `0x8080_4120`
    - `SNDRV_PCM_IOCTL_PREPARE = _IO('A', 0x40)` → `0x0000_4140`
    - `SNDRV_PCM_IOCTL_START = _IO('A', 0x42)` → `0x0000_4142`
    - `SNDRV_PCM_IOCTL_DROP = _IO('A', 0x43)` → `0x0000_4143`
    - `SNDRV_PCM_IOCTL_PAUSE = _IOW('A', 0x45, int)` → `0x4004_4145`
    - `SNDRV_PCM_IOCTL_WRITEI_FRAMES = _IOW('A', 0x50, WpkAlsaXferi)` → `0x4018_4150`
  - Ctl `'U'` magic:
    - `SNDRV_CTL_IOCTL_PVERSION = _IOR('U', 0x00, int)` → `0x8004_5500`
    - `SNDRV_CTL_IOCTL_CARD_INFO = _IOR('U', 0x01, WpkAlsaCtlCardInfo)` → `0x8100_5501`
    - `SNDRV_CTL_IOCTL_ELEM_LIST = _IOWR('U', 0x10, WpkAlsaCtlElemList)` → `0xc04c_5510`
  - Sizes encoded in each constant verified vs the wasm32 struct
    `size_of` in Task A1 Step 2.
- Two new kernel-wasm exports:
  - `kernel_audio_period_tick(pcm_id: u32, frames_consumed: u32)`.
    Host fires this on every AudioWorklet quantum (browser) /
    setInterval tick (Node). Advances `mmap_status->hw_ptr` by
    `frames_consumed` and wakes `poll(POLLOUT)` waiters when
    space frees up.
  - `kernel_audio_init_sab(pcm_id: u32, sab_base: u64, sab_len:
    u32)`. Host calls once at boot per pcm to hand the kernel a
    SharedArrayBuffer pointer (in the kernel's linear memory; the
    host has imported it into the kernel-worker's address space via
    the existing memory-import mechanism). Kernel stores the base
    + len in `crate::audio::sab_table` keyed by `pcm_id`. Subsequent
    `mmap(pcm_fd, ..., SNDRV_PCM_MMAP_OFFSET_DATA)` calls return
    this region into the user process. *(Additive export; does not
    change existing signatures.)*
- **No new `host_audio_*` imports.** Asymmetric with plan 4's KMS,
  symmetric with plan 5's input. The kernel's only host-direction
  signal is "tick" (period-completion notification); data flows
  through the SAB without crossing the kernel-host boundary. The
  host's `AudioDriver` is a self-contained AudioWorklet (browser)
  or setInterval (Node).
- No change to v1 `host_gl_*`, plan 2 `host_gbm_*`, plan 3
  `host_gl_bind_foreign_texture`, plan 4 `host_kms_*`, plan 5
  (no new imports), any existing struct layout, ioctl number,
  channel layout, syscall number, or asyncify slot.

Existing structs, ioctls, imports, and exports — all unchanged.

---

## Pre-implementation review

Devil's-advocate pass run in the next session after drafting; findings
below are structured Brandon-style. Eight inline fixes folded into the
plan body in the same session; the open correctness + open
architecture items are load-bearing and must be picked before any
kernel code lands. One cross-plan note leaks back to plan 4
(OFD-table-split urgency upgrade); plan 5's surface is unaffected
(boot-ordering pattern is consistent; no struct layout collisions).

### Inline fixes (8 — folded into the plan body)

- **`snd_pcm_hw_params` layout was wrong on six counts; the "596
  bytes ground truth" is itself suspect.** The placeholder declared
  `masks: [u32; 8]` (32 bytes), `intervals: [WpkSndInterval; 12]`
  (16 bytes each), `fifo_size: u64`, and a `WpkSndInterval` that's
  16 bytes instead of Linux's 12. Linux's actual layout is `flags:4
  + masks:3 * 32 + mres:5 * 32 + intervals:12 * 12 + ires:9 * 12 +
  rmask/cmask/info/msbits/rate_num/rate_den:6 * 4 + fifo_size:
  unsigned long + reserved:64` — total 608 on x86_64 (`unsigned long`
  = 8) and 604 on wasm32 (`unsigned long` = 4). The "596" figure in
  the header notes appears to come from an older kernel version
  (pre-2018, before `ires[]` grew to 9). The placeholder's
  array-length-iteration instruction would have guided future-me into
  faking the size by inserting padding, not by adding the missing
  reserved arrays. Three follow-on failures: (a) HW_REFINE's interval
  walk would index past the end of an under-sized array and corrupt
  adjacent fields; (b) alsa-lib computes its own
  `sizeof(snd_pcm_hw_params)` and compares against the ioctl's
  encoded size (the `_IOC_SIZE(0xc254_4110) == 0x254 == 596` figure
  is itself wrong on wasm32 — must be 604); (c) the masks-as-`[u32;8]`
  layout means `SNDRV_PCM_HW_PARAM_FORMAT`'s 256-bit mask gets
  truncated to 256 bits across the wrong storage. *Fixed: A1 Step 1
  redefined to: `WpkSndMask { bits: [u32; 8] }` (32 B);
  `WpkSndInterval { min:u32, max:u32, flags_packed:u32 }` (12 B —
  drop the `_pad: u32`, Linux doesn't pad here); `WpkAlsaPcmHwParams
  { flags:u32, masks:[WpkSndMask;3], mres:[WpkSndMask;5],
  intervals:[WpkSndInterval;12], ires:[WpkSndInterval;9], rmask:u32,
  cmask:u32, info:u32, msbits:u32, rate_num:u32, rate_den:u32,
  fifo_size:u32, reserved:[u8;64] }` — total 604 on wasm32. The
  ioctl number recomputed from `_IOWR('A', 0x10, struct
  snd_pcm_hw_params)` with size=604 = `0xc25c_4110`, NOT
  `0xc254_4110`. ABI impact section updated with the corrected
  numbers; A1 Step 2's size_of_val assertion uses 604. Iteration
  budget removed — the layout is now derivable from Linux source
  directly without `cargo expand` guesswork.*
- **`WpkAlsaCtlCardInfo` was trimmed from 376 B (Linux) to 256 B by
  shrinking `components[128]` to 16; that's a silent ABI break.**
  alsa-lib reads `components` as a NUL-terminated 128-byte string
  via `snd_ctl_card_info_get_components(info)` which returns the
  pointer into the embedded array. A library compiled against
  Linux's 376-byte header reads bytes 248..376 of the ioctl reply
  as `components[]` — bytes that, in the trimmed layout, contain
  whatever comes after the kernel's struct in the ioctl buffer
  (junk on first call, possibly stack data on subsequent calls).
  *Fixed: A1 Step 1's `WpkAlsaCtlCardInfo` kept at full 376 bytes
  with the trailing `components[128]` field; the field can be
  left zero-filled (libasound tolerates an empty components
  string). Size assertion in A1 Step 2 uses 376. Ioctl
  `SNDRV_CTL_IOCTL_CARD_INFO`'s encoded size becomes
  `0x8178_5501`, NOT `0x8100_5501`.*
- **`WpkAlsaPcmMmapStatus` size was claimed 64 but plan's field list
  totals 56 (and Linux's actual is 48 on a 32-bit ABI).** Linux's
  `struct snd_pcm_mmap_status` is `state:4 + pad1:4 + hw_ptr:long
  + tstamp:struct timespec + suspended_state:4 + audio_tstamp:
  struct timespec`. On 32-bit Linux that's 4+4+4+8+4+8 = 32 bytes;
  on 64-bit Linux 4+4+8+16+4+pad4+16 = 56 bytes. The plan's struct
  uses `hw_ptr:i64` (which contradicts wasm32's `unsigned long` =
  4 bytes for `snd_pcm_uframes_t`) and computes to 56, not the
  claimed 64. Test would fail on first cargo run. *Fixed: A1 Step
  1's `WpkAlsaPcmMmapStatus` adjusted to `hw_ptr:u32` (matches
  wasm32 `snd_pcm_uframes_t`), `audio_tstamp_data:u32` retained,
  trailing pad added explicitly to land at 56 bytes. The
  `audio_tstamp_sec/nsec` fields use `i64`/`i32` matching wasm32's
  `struct timespec` (8+4=12 with 4 trailing pad = 16). Final size:
  56 bytes. Size assertion updated; A1 Step 2's
  `audio_mmap_status_field_offsets` test updated to assert hw_ptr
  at offset 8, tstamp_sec at offset 12, audio_tstamp_sec at offset
  32. C side's userspace `_Static_assert(sizeof(struct
  snd_pcm_mmap_status) == 56)` matches.*
- **`BrowserAudioDriver`'s `quantaPerPeriod = Math.ceil(periodFrames
  / 128)` drifts hw_ptr against actual frames-consumed.** With
  `periodFrames=1024`, ceil(1024/128) = 8 quanta, and 8 × 128 =
  1024 = periodFrames. Aligned. But with any periodFrames not a
  multiple of 128 (HW_REFINE accepts `period_size in [64..4096]`
  per plan), the accumulator fires `kernelTick(pcmId, periodFrames)`
  every `quantaPerPeriod` quanta — which equals
  `quantaPerPeriod × 128 ≠ periodFrames` frames of actual
  consumption. Hw_ptr drifts; XRUN fires spuriously after a few
  hundred periods. *Fixed: B2 collapsed to per-quantum tick. The
  worklet posts `{ framesConsumed: 128 }` per quantum; the
  main-thread `port.onmessage` immediately calls
  `kernelTick(pcmId, 128)`. No accumulator. Kernel-side period_tick
  becomes "frames_consumed_since_last_tick" not "1 period's worth";
  hw_ptr advances per quantum granularity, latency unchanged
  (~2.67 ms quantum is well below alsa-lib's period expectation).
  HW_REFINE no longer needs the "period_size must be multiple of
  128" constraint. A6's kernel-side test
  `tick_advances_hw_ptr_by_frames_consumed` updated to fire 8
  ticks of 128 frames each and assert hw_ptr == 1024.*
- **WRITEI_FRAMES wrapped `appl_ptr` at `ring_frames`, not
  `sw_params.boundary`.** Linux semantics: `mmap_control.appl_ptr`
  is a monotonic counter modulo `sw_params.boundary` (typically
  `boundary = 0x4000_0000` or some large power-of-2); `hw_ptr` is
  monotonic in the same modulus. The userspace `avail = appl_ptr -
  hw_ptr` (modulo boundary) gives frames-in-flight without ever
  wrapping at the ring-buffer boundary. alsa-lib + SDL2 rely on
  this: `appl_ptr` and `hw_ptr` are 1024-bit counters in the
  abstract, modulo a large power-of-2 in practice. The plan's A4
  `ctl.appl_ptr = (appl + to_write) as i64` is monotonic (no
  wrapping), but A5's mmap-direct path lets userspace write
  `ctl->appl_ptr` directly; plan's docs don't pin `boundary`
  semantics. *Fixed: A1's `HwParamsCache` gains an inferred
  `boundary: u64` field (computed at HW_PARAMS time as
  `buffer_size * floor((1<<30) / buffer_size)` — same shape Linux
  uses); the kernel's `avail` computation in A6/A7 becomes
  `(appl_ptr - hw_ptr + boundary) % boundary`; SW_PARAMS's
  `boundary` field is mirrored back into HwParamsCache. Userspace
  `mmap_control.appl_ptr` is never bounded by the kernel — userland
  wraps at `boundary` on its own (per Linux). Two new cargo tests:
  `writei_appl_ptr_wraps_at_boundary_not_ring_frames`,
  `avail_computation_handles_boundary_wrap`.*
- **XRUN detection condition `hw_ptr > appl_ptr` fires one tick
  late and uses the wrong direction.** Underrun is when the
  consumer would consume frames that haven't been produced, i.e.,
  the next quantum's tick would advance hw_ptr past appl_ptr. The
  plan's A6 sets XRUN after `hw_ptr` already passed `appl_ptr`,
  which means the worklet has already emitted garbage / stale
  samples for that quantum. Also the comparison is in the wrong
  monotonic-modulo space (see fix above). *Fixed: A6's tick
  predicts the next-quantum advance: `if (hw_ptr + frames_consumed)
  modulo boundary > appl_ptr modulo boundary { XRUN }`. The
  worklet's `process()` checks the kernel's state via the
  mmap_status page; if state == XRUN, it emits silence for that
  quantum instead of reading stale samples from the ring. A6's
  test `tick_underrun_transitions_state_to_xrun` updated to fire
  the XRUN-causing tick and assert hw_ptr did NOT advance past
  appl_ptr (kernel clamps to appl_ptr to keep counters sane).*
- **`mmap_status` / `mmap_control` page lifetime tied to OFD is
  wrong vs Linux semantics.** Linux's mmap'd kernel pages stay
  valid across `close(fd)` until the last `munmap` — Linux's
  per-VMA reference count, not per-fd. The plan's A9 drops the
  `Box<WpkAlsaPcmMmapStatus>` on `on_final_close`; if userspace
  has `mmap`'d the page and not yet `munmap`'d, the next
  user-side dereference is a use-after-free. Browser would crash
  (dereferencing freed wasm linear memory is unspecified but
  usually a SIGBUS-equivalent), Node would silently read garbage.
  *Fixed: A1 Step 1 changes `mmap_status` / `mmap_control` from
  `Option<Box<…>>` to `Option<Arc<Mutex<…>>>` on `AlsaFdState`;
  A5's `handle_alsa_mmap` clones the Arc into a `MappingKind::
  KernelOwnedArc(arc)` entry in the VMA table; A9's `on_final_close`
  drops the OFD's Arc but the VMA table's clone keeps the page
  alive until munmap. New cargo test:
  `mmap_status_page_survives_close_until_munmap`. A note: this
  ties to the open architecture item "Arc-mapping infrastructure"
  below — the existing mmap-VPN code doesn't yet model
  Arc-borrowed kernel pages.*
- **SAB-import mechanism doesn't match the existing
  `WebAssembly.Memory` sharing pattern; "host allocates SAB" framing
  is backwards.** The codebase's existing pattern (verified in
  `host/src/framebuffer/registry.ts` and `canvas-renderer.ts`) is:
  `kernel.memory` is a `WebAssembly.Memory({shared: true})`;
  `kernel.memory.buffer` IS a SharedArrayBuffer; the host reads
  kernel-allocated regions by indexing into that buffer. There's no
  "import a separate SAB into the kernel's linear memory" path —
  WebAssembly's multi-memory proposal isn't widely deployed yet, and
  even if it were, importing a host-side SAB as a second `Memory`
  doesn't gain anything over the kernel's existing shared linear
  memory. The plan's `kernel_audio_init_sab(base, len)` export is
  inverted: the *kernel* allocates the ring inside its own heap and
  the *host* gets the (base, len) to forward to the AudioWorklet.
  *Fixed: A4 Step 2's `kernel_audio_init_sab` replaced with
  `kernel_audio_alloc_ring(pcm_id: u32, len: u32) -> u32` — kernel
  allocates the ring in its heap, returns base offset (relative to
  `kernel.memory.buffer`); host stores `(base, len)` and forwards
  to the AudioWorklet via `worklet.port.processorOptions = {
  sab: kernel.memory.buffer, offset: base, len }`. The worklet
  constructs `new Int16Array(sab, offset, len/2)` and reads
  directly from the kernel's linear memory. Userspace `mmap(pcm_fd,
  ..., OFFSET_DATA)` returns the same kernel-side region via the
  same `MappingKind::KernelOwnedArc` arm (the ring is an
  `Arc<[i16; N]>` boxed at kernel-alloc time). Risk register #6 +
  open-architecture "kernel-side SAB import path" both retired;
  one new arch open: "Arc-mapping infrastructure" (covers this
  case + the mmap_status/control case from inline fix #7). B4's
  one-day SAB-import spike retired; replaced by a B4 sanity check
  that the worklet's `processorOptions` accepts a
  `WebAssembly.Memory.buffer` SAB (it does — that's existing
  pattern).*

### Correctness — open, address before kernel PR opens

- **`mmap_control.appl_ptr` is user-writable via the mmap path AND
  via WRITEI_FRAMES; double-update can race.** alsa-lib uses one
  path OR the other (mmap-direct vs rw_interleaved), but a
  misbehaved program could mix them. The kernel's WRITEI handler
  reads `appl_ptr` and writes it back; if userspace also writes
  `mmap_control.appl_ptr` from another thread, the writes
  interleave. Linux doesn't synchronise this either; alsa-lib's
  state machine forbids mixing. *Lean:* document v1 behaviour as
  "undefined if mixed"; no kernel-side enforcement. Add a vitest
  that documents this behaviour explicitly (matches Linux). Same
  shape as plan 5's "grabbed flag races on close" — userspace's
  responsibility.
- **HW_REFINE's `[64..4096]` period_size range admits non-power-of-2
  values.** Linux's evdev-equivalent for ALSA — the
  `snd_pcm_hw_constraint_pow2` constraint — typically restricts
  period and buffer sizes to powers-of-2 for hardware DMA alignment.
  Our backend doesn't have DMA, but SDL2 + alsa-lib both default to
  power-of-2 sizes and may not handle non-power-of-2 buffer_size
  gracefully (libasound's ring-buffer math assumes the bit-mask
  trick `(x & (size-1))` works). *Lean:* clamp HW_REFINE's
  buffer_size and period_size to powers-of-2 in `[64..4096]` and
  `[256..16384]` respectively. The clamp simplifies kernel-side
  modulo arithmetic (replace `% ring_frames` with `& (ring_frames -
  1)`) and matches what real ALSA cards do. Folded as a follow-up
  note at A3; new cargo test
  `hw_refine_clamps_non_power_of_2_buffer_size`.
- **AudioContext autoplay-policy + lean (c) "start unconditionally"
  contradiction.** Risk register #5 says AudioContext starts
  "suspended" until a user gesture. Lean (c) says the driver starts
  unconditionally at boot. These are consistent (the AudioContext
  *graph* runs as soon as it's resumed; the worklet's `process()`
  doesn't fire while suspended) but the plan never spells this out.
  A future implementer reading B4 will be confused — is "start"
  blocking on user-gesture or not? *Lean:* B4's `driver.start()`
  for the browser constructs the AudioContext in `suspended` state
  (the default), wires the worklet, returns immediately. The
  *first* user gesture on the page calls `audioCtx.resume()`; until
  then no `process()` fires (so no `kernel_audio_period_tick` calls
  either; kernel sees hw_ptr stay at 0 which is correct — there's
  literally no consumer). Document this in B2's commit body and
  add a Node-side note that NodeAudioDriver has no autoplay gate
  (setInterval fires immediately). Test: B2 vitest mocks
  AudioContext with `state: "suspended"` and asserts no kernelTick
  fires until `resume()` is called.

### Architecture — open (LOAD-BEARING, pick before any kernel code lands)

- **Arc-mapping infrastructure isn't sketched in plans 2–5.** Inline
  fixes #7 + #8 both require the mmap-VPN code to accept a kernel-
  owned `Arc<T>` as a mapping source and keep the Arc alive via
  the VMA table (close-vs-munmap divergence). Plan 2's gbm_bo
  sharing uses a similar mechanism (host-imported memory backing a
  bo's user-mapped region), but the prim_bo's lifetime is fd-tied
  (close of the prime fd is the unmap trigger). Plan 6 needs
  per-VMA refcounting, which is a new code path. *Lean:* add a
  `MappingKind::KernelOwnedArc(Arc<dyn AsRef<[u8]>>)` arm to the
  existing mmap helper at A5 implementation time; the Arc's
  refcount holds the kernel-resident page alive across fd close.
  This is ~50 LoC in `crates/kernel/src/mmap.rs` (or wherever the
  VPN table lives). Surfaces in: plan 6's mmap_status + mmap_control
  + audio ring pages; plan 9 may want it for the compositor's
  shared metadata regions. Cross-plan note: this is the first plan
  to need this mechanism — plans 2/3/4/5 didn't.
- **`PROCESS_TABLE.lock()` rate climbs further with plan 6's tick.**
  Plan 5's "open architecture #1" already flagged that
  `kernel_input_event` at 1000+ Hz autorepeat + drag stresses the
  shared PROCESS_TABLE lock. Plan 6 adds another producer; with
  inline fix #4's per-quantum tick (every 128 frames at 48 kHz =
  ~375 Hz), the audio path is the second-highest contender after
  input. Combined worst case: input (1000+ Hz) + audio (375 Hz) +
  vblank (60 Hz) + WAIT_VBLANK consumer + WRITEI from userland =
  ~1500+ Hz lock-acquisitions on a single mutex. The lock window
  per acquisition is still O(open OFDs), but contention probability
  rises. *Lean:* upgrade plan 4's "OFD-table-split" architecture-
  open from "after plans 4+5 ship" to "**before plan 7 (SDL2) lands
  — gated on profiling**". Plan 7 will be the first plan that
  exercises all three streams simultaneously under a real workload;
  if Phase C profiling shows lock contention >5% of any of the
  three tick handlers, the OFD-table-split refactor blocks plan 7
  merge. Cross-plan amendment added to plan 4's review (urgency
  upgrade); plan 5's open architecture #1 receives a follow-up
  note pointing at plan 6's quantified contribution.
- **`controlC0` `CARD_INFO` returns the same struct for every
  caller; fork-shared OFDs can race on `ELEM_LIST.pids` buffer
  pointer.** v1 ships ELEM_LIST with `count = 0, used = 0` — no
  pid array dereferenced — so the immediate hazard is dormant.
  But the broader pattern (per-OFD state on controlC0 vs global
  state) needs picking once plan 9's wpkcompositor adds
  ELEM_WRITE. *Lean:* defer until plan 9; document v1 as
  "controlC0 is stateless except for its card binding" and pin
  the no-per-fd-state invariant via a cargo test that opens
  controlC0 twice from the same process and asserts both reads of
  CARD_INFO return byte-identical results. Cross-plan note: plan
  9 will need to revisit when it adds the mixer surface.

- **SDL2's `SDL_OpenAudioDevice` requires a userspace thread to
  drive `snd_pcm_writei`; plan 6's WRITEI model presumes a
  blocking writer.** *Follow-up after plan 7's devil's-advocate.*
  Plan 7 selects `--disable-pthreads` for SDL2; with no
  `SDL_CreateThread` backend, SDL2's `SDL_RunAudio` thread never
  starts and `audio_cb` never fires. Plan 6's per-quantum tick
  advances `hw_ptr` correctly on the kernel side, but with no
  userspace writer the ring stays empty and `process()` reads
  zeros. The thread-driven WRITEI model in A4 + A6 + B2 needs
  either (a) a libpthread shim (plan 7 open-architecture #1
  option a — wraps `clone(CLONE_VM)` + SAB futexes) so SDL2's
  thread works as-shipped, OR (b) a non-blocking WRITEI path
  with `POLLOUT` readiness on the mmap status page so SDL2 can
  be patched to a polling audio model (`SDL_PumpAudio` called
  from the main loop, plan 7's option b). *Lean:* (b), because
  plan 6's mmap_status already exposes `avail` and `POLLOUT` is
  already in A7's scope — adding non-blocking WRITEI is a small
  extension (return EAGAIN when `avail < frames` instead of
  blocking); plan 7 then ships the SDL2 patch as a vendored
  diff. (a) is heavier but unlocks plans 8–11 too; revisit if
  plan 9 wpkcompositor also wants threads. **Pre-merge gate for
  plan 7 PR #2: whichever option lands, plan 6 ships the
  prerequisite (non-blocking WRITEI + EAGAIN if option b; no-op
  if option a).** Risk-register #7 added — "SDL2 audio thread
  requires either a libpthread shim or a non-blocking WRITEI
  patch; pre-merge gate for plan 7 PR #2."

### Missing tests — add to implementation PRs

- **`snd_pcm_hw_params` size = 604 on wasm32 + every field offset.**
  A1 Step 2's size_of_val test + new field-offset tests for
  `masks[0]`, `intervals[2]` (rate), `intervals[5]` (period_size),
  `intervals[7]` (buffer_size), `rmask`, `fifo_size`. Same shape
  as plan 5's WpkInputEvent field-offset asserts.
- **`SNDRV_PCM_IOCTL_HW_PARAMS` encoded size matches struct
  size.** Compute `_IOC_SIZE(SNDRV_PCM_IOCTL_HW_PARAMS) == 604`
  and assert. Catches the case where someone updates
  the constant but forgets to update the struct.
- **WRITEI_FRAMES wraps `appl_ptr` at `sw_params.boundary`, not at
  `ring_frames`.** Configure boundary = `0x4000_0000`,
  ring_frames = 4096; write enough frames to wrap appl_ptr past
  ring_frames (appl_ptr = 5000), assert `appl_ptr` is `5000` not
  `5000 - 4096 = 904`. Locks the monotonic-modulo-boundary
  semantics alsa-lib expects.
- **XRUN fires when next-tick advance would pass appl_ptr, not
  after.** With appl_ptr = 1024 and hw_ptr = 896, a tick of 256
  frames must set XRUN BEFORE advancing hw_ptr to 1152; the test
  asserts state == XRUN and hw_ptr == 1024 (clamped).
- **Boot-order: `kernel_audio_alloc_ring` precedes any
  `mmap(OFFSET_DATA)` call.** B4 vitest spies the kernel-exports
  proxy and asserts call ordering — same shape as plan 5's
  `kernel_set_input_canvas_dims` boot-order test.
- **CLOCK_MONOTONIC sub-ms alignment with `kernel_input_event` +
  `kernel_vblank`.** Fire one audio tick, one input event, one
  vblank tick in close succession; read all three records; assert
  `|tv_a - tv_b| < 1 ms` pairwise. Locks design §16 q6 invariant
  across all three streams.
- **mmap_status page survives `close(pcm_fd)` until `munmap`.**
  Open pcm, mmap status page, close fd, read from the mapped
  address — assert read returns the last-written `hw_ptr`, not
  garbage. Then munmap; second read after munmap may fault (OK).
  Defends the Arc-mapping invariant.
- **`controlC0` re-reads return byte-identical bytes** (stateless
  invariant). Open twice, CARD_INFO each, memcmp == 0.
- **HW_REFINE clamps non-power-of-2 buffer_size to next power-of-2.**
  Request buffer_size = 3000, assert HW_REFINE narrows to 2048
  (or 4096 depending on clamp direction; pin in A3).

### Trade-offs verified against the design doc + handoff requirements

- **`CLOCK_MONOTONIC` from `crate::time::monotonic_us()`** — same
  source plans 4+5 use. Design §16 q6 honoured; all three host-
  driven event streams share a comparable clock for A-V-sync /
  jitter profiling. ✓
- **No `SNDRV_PCM_IOCTL_TTSTAMP` (clock-source-selection)** —
  pinning MONOTONIC matches plan 5's EVIOCSCLOCKID refusal and
  sidesteps the Y2K38 / NTP-skew footgun. ✓
- **Two devices only (pcmC0D0p + controlC0); no capture/timer/seq.**
  Design §8.1; SDL2's audio probe + alsa-lib tolerate missing
  timer/seq; capture needs MediaStream permission flow (post-v1). ✓
- **S16_LE only in v1.** HW_REFINE clamps; SDL2 + most apps default
  to S16_LE; FLOAT_LE/S32_LE deferred to v2 when AudioWorklet (or
  kernel) does format conversion. ✓
- **Single card / single device / single substream / playback only.**
  Multi-card post-v1; matches design §8.1. ✓
- **Period tick driven by host (per-quantum after inline fix #4).**
  Kernel has no internal periodic timer; learns "frames consumed"
  via `kernel_audio_period_tick` export. Same shape as plan 4's
  `kernel_vblank` and plan 5's `kernel_input_event`. ✓
- **PCM data ring is kernel-allocated in shared linear memory
  (after inline fix #8).** Host gets the kernel-side base/len via
  `kernel_audio_alloc_ring`; AudioWorklet reads from
  `kernel.memory.buffer` at that offset; userspace mmap returns
  the same region via the same Arc-tracked mapping. Zero-copy
  data path preserved. ✓
- **mmap status/control pages kernel-resident + Arc-refcounted
  (after inline fix #7).** Page lifetime correctly outlives fd close
  per Linux semantics. ✓
- **No host imports** (mirror of plan 5's asymmetry). The only
  kernel→host signal is the period_tick (export, host-called); no
  `host_audio_*` callbacks in v1. Plan 9's mixer surface may add
  one; v1 holds the line. ✓
- **PCM state transitions enforced.** OPEN → SETUP → PREPARED →
  RUNNING → SETUP/PAUSED/XRUN per ALSA UAPI. A3's match-arm tests
  lock the transitions; userspace bugs that skip steps fail with
  EBADFD. ✓
- **AlsaFdState as sibling `Option<Box<…>>` on OFD, not nested in
  DRI state.** Consistent with plan 5's InputFdState factoring;
  one-box-per-device-class. ✓
- **`AlsaControlFdState` separate from `AlsaFdState`** — disjoint
  state machines; controlC0 is stateless except card binding.
  Right factoring per the "open architecture" item above. ✓
- **Additive ABI only — no `ABI_VERSION` bump** (PR #490 policy).
  Structs/constants/ioctls/exports all additive; no existing
  surface changes (post inline-fix-corrected sizes + ioctl
  numbers). ✓
- **Stacked-PR topology (alsa-kernel → alsa-host → alsa-demo).**
  Matches plans 2/3/4/5 stack shape. ✓
- **AudioContext autoplay-gate**: documented in trade-offs; lean
  (c) start-at-boot is consistent with suspended-default per
  inline fix's correctness note. ✓
- **Cross-Origin-Embedder-Policy already set in `./run.sh
  browser`** for the WebGL demo; the SAB-via-`kernel.memory.buffer`
  path inherits without new headers. ✓

### Deliberately not flagged

- **Major 116 + minors 0/16** (Linux ALSA major + controlC0/pcmC0D0p
  minors) — matches `Documentation/admin-guide/devices.txt` "Sound
  device" table. Conventional; libasound doesn't dereference the
  major/minor (uses the device path). ✓
- **`'A'` magic for PCM ioctls, `'U'` for ctl** — matches Linux's
  `sound/asound.h`. No collision with plan 2's `'d'` (DRI render),
  plan 3's WPK extensions, plan 4's KMS ioctls, plan 5's `'E'`
  (input). ✓
- **alsa-lib PVERSION pin `0x000d_0000` (v13.0.0)** — alsa-lib's
  documented minimum runtime version; libraries built against
  newer alsa-lib accept any equal-or-lower kernel version. ✓
- **No `pcmC0D0c` (capture) → ENODEV at open** — matches design
  §8; capture needs MediaStream which is post-v1. ✓
- **No `/dev/snd/timer`** — alsa-lib gracefully degrades when
  missing; SDL2 doesn't touch the alsa-timer subsystem. ✓
- **No mixer ELEM_WRITE / power-management in controlC0** — v1
  returns empty element list; plan 9's wpkcompositor owns the
  master-volume surface. SDL2's audio init doesn't drive mixer
  state (only reads CARD_INFO). ✓
- **Linear interpolation resample fallback (risk #4)** — good
  enough for a 440 Hz sine demo; v2 ports a real resampler if
  music workloads matter. ✓
- **AudioContext sample-rate hard-coded to 48 kHz** — matches
  HW_REFINE's [48000, 48000] clamp; if the browser refuses (rare;
  most platforms accept 48 kHz), worklet resamples. ✓
- **No `EVIOCSCLOCKID`-equivalent** — clock fixed MONOTONIC; same
  justification as plan 5's EVIOCSCLOCKID refusal. ✓
- **Stacked-PR topology + Brandon commit-titles + "do not merge
  until Brandon validates"** — matches plans 2/3/4/5. ✓

### Cross-plan amendment to plan 4

A finding from this devil's-advocate pass leaks back to plan 4.
Plan 5 already raised "OFD-table-split urgency" as an architecture-
open carried into plan 4's review (in section "Cross-plan amendment
from plan 5's devil's-advocate"); plan 6's per-quantum tick
quantifies the lock-rate further: combined worst case at peak load
is now ~1500+ Hz across input (1000+ Hz autorepeat+drag) + audio
(~375 Hz per-quantum) + vblank (60 Hz) + WAIT_VBLANK consumers +
WRITEI from userland. The lock window per acquisition is still
O(open OFDs), but contention probability rises non-linearly with
producer rate.

*Resolution:* upgrade plan 4's open-architecture #2 ("split OFD
table out of PROCESS_TABLE") from "defer to focused PR after plans
4+5 ship (no later than pre-SDL2-port-merge)" to "**block plan 7
(SDL2) merge on Phase C profiling — if any of the three tick
handlers shows >5% time in lock acquisition, the OFD-table-split
refactor is a hard prerequisite for plan 7**." Plan 7 will be the
first plan that exercises all three streams under a real workload
(SDL2 game loops are notoriously lock-sensitive). The cross-plan-
amendment subsection in plan 4's review gets a follow-up paragraph
adding the quantified figures + the plan-7 merge gate.

### Cross-plan note to plan 5

No leak-back findings in plan 5's surface. Plan 6's struct-layout
concerns (snd_pcm_hw_params 604 B, mmap_status 56 B, control card
info 376 B) don't touch plan 5's WpkInputEvent (24 B; already
audited in handoff-6's plan-5 inline fixes). Boot-ordering pattern
(`kernel_audio_alloc_ring` → first `mmap(OFFSET_DATA)`) mirrors
plan 5's (`kernel_set_input_canvas_dims` → first
`kernel_input_event`) — same shape, same vitest test idiom; no
amendment needed. The Arc-mapping infrastructure (new for plan 6)
doesn't apply to plan 5 (input has no mmap'd pages). One pointer
added to plan 5's "open architecture #1" subsection: plan 6's
contribution to the combined lock-rate is documented above and
strengthens the case for the OFD-table-split refactor.

### Cross-plan amendment from plan 9's devil's-advocate — explicit EAGAIN arm for SDL2 audio polling

Plan 9's devil's-advocate pass (session 10) recorded the
resolution to plan 7's open-architecture #1 (SDL2 audio thread
model): **option (b) — non-blocking WRITEI + SDL2 polling patch
+ plan 6 EAGAIN return arm.** Option (a) (libpthread shim) was
ruled out as too heavy for the single feature it enables;
option (c) (defer audio) is a feature regression; option (b)
is ~150 LoC SDL2 patch + the plan 6 EAGAIN arm and matches plan
6's existing per-quantum tick + POLLOUT non-blocking surface
exactly.

This commits plan 6 to an explicit contract: a non-blocking
`SNDRV_PCM_IOCTL_WRITEI_FRAMES` (a.k.a. `snd_pcm_writei` with
the underlying fd in `O_NONBLOCK` mode, or `SNDRV_PCM_HW_PARAMS`
with the non-block tag set) MUST return `-EAGAIN` when the
kernel-side audio ring is full (`avail < frames_requested`),
NOT `-EBUSY` and NOT block. SDL2's patched audio polling loop in
plan 7's resolution (b) will treat EAGAIN as "back off and try
next pump" and EBUSY as "fatal".

The distinction matters because plan 6's A4 + A7 (non-blocking
write arm + POLLOUT) describe the contract conceptually but
don't pin the errno. Plan 6's Trade-offs verified subsection
("POLLOUT + non-blocking write arm cleared in A7") is correct,
but plan 7's audio polling loop is the first real-world
consumer of the contract and the choice of errno determines
whether the SDL2 patch is "ergonomic" or "load-bearing
workaround". **Pin: EAGAIN, not EBUSY, on a full ring.**

*Resolution for plan 6:* update A7's body at impl time to
document the EAGAIN-on-full-ring contract explicitly (it's
implicit in "non-blocking write arm" but the explicit name
helps the SDL2-side patch reviewer). Add a cargo test
"snd_pcm_writei_returns_eagain_when_ring_full" alongside the
existing POLLOUT tests. Plan 6 risk register #7 (added by plan
7's cross-plan amendment to plan 6 above) is now resolved by
plan 9's audio-thread decision; update the register to point
at this subsection.

Plan 9's own compositor doesn't manage audio routing — audio
clients hit /dev/snd/* directly. So this amendment is plan 7's
benefit, surfaced during plan 9's pass.

### Cross-plan amendment from plan 11's devil's-advocate — wpkbeep two-shot playback re-PREPARE (added during session 12)

Plan 11's wpkbeep (`docs/plans/2026-07-27-wpk-seed-apps-plan.md`
task D3 lines 1080–1125) is a 1-button compositor-client audio
demo: click → enqueue 1 s 440 Hz sine wave into
`/dev/snd/pcmC0D0p` via non-blocking
`SNDRV_PCM_IOCTL_WRITEI_FRAMES` + EAGAIN-poll loop (the plan
7 audio-thread (b) pattern executed outside SDL2). Each click
calls `play_blocking(pcm_fd)` synchronously, which writes the
full 44 100-sample buffer and returns.

After playback completes, the PCM stream transitions
PREPARED → RUNNING → DRAINING → SETUP per plan 6's PCM state
machine (A3 lines 1407–1422). A second click writes to a
SETUP-state fd. **Question:** does plan 6 v1 auto-rearm the
stream after drain, or must the client call
`SNDRV_PCM_IOCTL_PREPARE` between playbacks?

*Resolution for plan 6:* plan 11 D3 calls
`SNDRV_PCM_IOCTL_PREPARE` after each `play_blocking` return
defensively (inline fix #11 in plan 11's review). The
defensive call is harmless if plan 6 auto-rearms (a no-op
PREPARE→PREPARE transition); plan 6 task A3 should document
the answer explicitly so a future plan can remove the
defensive call if redundant. Either way, plan 11 wpkbeep
works.

Non-LOAD-BEARING — wpkbeep's defensive PREPARE handles both
behaviours. This is a documentation-clarity follow-up to plan
6 task A3.

---

## Phase A — kernel: devices + ioctls + mmap pages + period tick (PR #1)

The kernel learns to (a) recognise `/dev/snd/controlC0` and
`/dev/snd/pcmC0D0p` as two distinct virtual devices, (b) hold per-OFD
PCM state machine + mmap pages + SAB-backed audio ring, (c) accept
the `SNDRV_PCM_IOCTL_*` subset alsa-lib drives, (d) advance hw_ptr +
wake POLLOUT waiters from the new `kernel_audio_period_tick` export,
and (e) answer the minimal controlC0 surface (CARD_INFO + ELEM_LIST).

### Task A1: Shared ABI module additions

**Files:**
- Modify: `crates/shared/src/lib.rs` — add `pub mod audio { … }` with
  the structs, format / state / access constants, and
  `SNDRV_PCM_IOCTL_*` + `SNDRV_CTL_IOCTL_*` numbers.

**Step 1: Constants and structs**

Append at the end of `crates/shared/src/lib.rs` (sibling of `pub mod
input`):

```rust
pub mod audio {
    use core::mem::size_of;

    // --- PCM ioctl numbers ('A' magic, Linux UAPI verbatim) --------------

    /// `_IOR('A', 0x00, int)` = `0x8004_4100`.
    pub const SNDRV_PCM_IOCTL_PVERSION: u32 = 0x8004_4100;
    pub const SNDRV_PCM_IOCTL_INFO: u32 = 0x8120_4101;
    pub const SNDRV_PCM_IOCTL_HW_REFINE: u32 = 0xc254_4110;
    pub const SNDRV_PCM_IOCTL_HW_PARAMS: u32 = 0xc254_4111;
    pub const SNDRV_PCM_IOCTL_HW_FREE: u32 = 0x0000_4112;
    pub const SNDRV_PCM_IOCTL_SW_PARAMS: u32 = 0xc088_4113;
    pub const SNDRV_PCM_IOCTL_STATUS: u32 = 0x8080_4120;
    pub const SNDRV_PCM_IOCTL_PREPARE: u32 = 0x0000_4140;
    pub const SNDRV_PCM_IOCTL_START: u32 = 0x0000_4142;
    pub const SNDRV_PCM_IOCTL_DROP: u32 = 0x0000_4143;
    pub const SNDRV_PCM_IOCTL_PAUSE: u32 = 0x4004_4145;
    pub const SNDRV_PCM_IOCTL_WRITEI_FRAMES: u32 = 0x4018_4150;

    // --- Ctl ioctl numbers ('U' magic) -----------------------------------

    pub const SNDRV_CTL_IOCTL_PVERSION: u32 = 0x8004_5500;
    pub const SNDRV_CTL_IOCTL_CARD_INFO: u32 = 0x8100_5501;
    pub const SNDRV_CTL_IOCTL_ELEM_LIST: u32 = 0xc04c_5510;

    // --- PCM state constants ---------------------------------------------

    /// `SNDRV_PCM_STATE_OPEN` = 0. fd just opened; no params yet.
    pub const SNDRV_PCM_STATE_OPEN: u32 = 0;
    /// `SNDRV_PCM_STATE_SETUP` = 1. HW_PARAMS landed; not prepared.
    pub const SNDRV_PCM_STATE_SETUP: u32 = 1;
    /// `SNDRV_PCM_STATE_PREPARED` = 2. PREPARE'd, ready for START.
    pub const SNDRV_PCM_STATE_PREPARED: u32 = 2;
    /// `SNDRV_PCM_STATE_RUNNING` = 3. START'd; ticks fire.
    pub const SNDRV_PCM_STATE_RUNNING: u32 = 3;
    /// `SNDRV_PCM_STATE_XRUN` = 4. Buffer underrun; user must PREPARE.
    pub const SNDRV_PCM_STATE_XRUN: u32 = 4;
    /// `SNDRV_PCM_STATE_PAUSED` = 6.
    pub const SNDRV_PCM_STATE_PAUSED: u32 = 6;

    // --- PCM format constants (subset; S16_LE is v1's only support) ------

    pub const SNDRV_PCM_FORMAT_S16_LE: u32 = 2;
    pub const SNDRV_PCM_FORMAT_S32_LE: u32 = 10;
    pub const SNDRV_PCM_FORMAT_FLOAT_LE: u32 = 14;

    // --- PCM access constants --------------------------------------------

    pub const SNDRV_PCM_ACCESS_MMAP_INTERLEAVED: u32 = 0;
    pub const SNDRV_PCM_ACCESS_RW_INTERLEAVED: u32 = 3;

    // --- PCM stream direction --------------------------------------------

    pub const SNDRV_PCM_STREAM_PLAYBACK: u32 = 0;
    pub const SNDRV_PCM_STREAM_CAPTURE: u32 = 1;  // v1 doesn't ship capture

    // --- MMAP offsets (passed to mmap(pcm_fd, ..., offset) to select page)

    /// PCM DATA ring offset (the SAB-backed audio buffer).
    pub const SNDRV_PCM_MMAP_OFFSET_DATA: u64 = 0x0000_0000;
    /// PCM mmap_status page (kernel-writes, userspace-reads).
    pub const SNDRV_PCM_MMAP_OFFSET_STATUS: u64 = 0x8000_0000;
    /// PCM mmap_control page (userspace-writes, kernel-reads).
    pub const SNDRV_PCM_MMAP_OFFSET_CONTROL: u64 = 0x8100_0000;

    // --- snd_interval substruct (16 bytes) -------------------------------

    /// `struct snd_interval` — the value-range descriptor used inside
    /// `snd_pcm_hw_params.intervals[]`. 16 bytes: 4 u32 + 1 u8 flag
    /// byte + 3 bytes pad.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkSndInterval {
        pub min: u32,           // 0
        pub max: u32,           // 4
        pub openmin_max_int_empty: u32, // 8   flag bits (openmin:1 openmax:1 integer:1 empty:1)
        pub _pad: u32,          // 12
                                // total: 16
    }

    // --- marshalled structs ----------------------------------------------

    /// `struct snd_pcm_hw_params`. 596 bytes on wasm32 — verify with
    /// `size_of_val(&WpkAlsaPcmHwParams::default())` in A1 Step 2 cargo
    /// test. Layout matches Linux v6.10's `include/uapi/sound/asound.h`
    /// modulo wasm32 alignment.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct WpkAlsaPcmHwParams {
        pub flags: u32,
        pub masks: [u32; 8],            // 32 bytes — access / format /
                                        // subformat masks (bitmap)
        pub intervals: [WpkSndInterval; 12], // 192 bytes — rate /
                                             // channels / period_size /
                                             // buffer_size / etc.
        pub rmask: u32,
        pub cmask: u32,
        pub info: u32,
        pub msbits: u32,
        pub rate_num: u32,
        pub rate_den: u32,
        pub fifo_size: u64,
        pub reserved: [u8; 64],
                                        // total: ~328 — Linux is 596;
                                        // the discrepancy is the
                                        // `masks` array length and
                                        // `reserved` size. Use 596 as
                                        // ground truth + size-assert.
                                        // Adjust array lengths to land
                                        // on 596 exactly.
    }

    /// `struct snd_pcm_sw_params`. 136 bytes on wasm32.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct WpkAlsaPcmSwParams {
        pub tstamp_mode: u32,
        pub period_step: u32,
        pub sleep_min: u32,
        pub avail_min: u64,             // frames
        pub xfer_align: u64,
        pub start_threshold: u64,
        pub stop_threshold: u64,
        pub silence_threshold: u64,
        pub silence_size: u64,
        pub boundary: u64,
        pub proto: u32,
        pub tstamp_type: u32,
        pub reserved: [u8; 56],
                                        // total: 136
    }

    /// `struct snd_pcm_status`. 128 bytes on wasm32.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct WpkAlsaPcmStatus {
        pub state: u32,                 // SNDRV_PCM_STATE_*
        pub trigger_tstamp_sec: i64,    // CLOCK_MONOTONIC; design §16 q6
        pub trigger_tstamp_nsec: i64,
        pub tstamp_sec: i64,
        pub tstamp_nsec: i64,
        pub appl_ptr: i64,              // frames
        pub hw_ptr: i64,                // frames
        pub delay: i64,                 // frames (= appl_ptr - hw_ptr)
        pub avail: u64,                 // frames available to write
        pub avail_max: u64,
        pub overrange: u64,
        pub suspended_state: u32,
        pub audio_tstamp_data: u32,
        pub audio_tstamp_sec: i64,
        pub audio_tstamp_nsec: i64,
        pub reserved: [u8; 16],
                                        // total: 128 (verify)
    }

    /// `struct snd_pcm_info`. 288 bytes on wasm32. Returned by
    /// SNDRV_PCM_IOCTL_INFO; alsa-lib reads `name`, `id`, `card`,
    /// `device`, `subdevice`, `stream`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct WpkAlsaPcmInfo {
        pub device: u32,
        pub subdevice: u32,
        pub stream: i32,                // 0 = playback, 1 = capture
        pub card: i32,
        pub id: [u8; 64],
        pub name: [u8; 80],
        pub subname: [u8; 32],
        pub dev_class: u32,
        pub dev_subclass: u32,
        pub subdevices_count: u32,
        pub subdevices_avail: u32,
        pub sync: [u8; 16],             // snd_pcm_sync_id (16 bytes)
        pub reserved: [u8; 64],
                                        // total: 288
    }

    /// `struct snd_pcm_mmap_status`. 64 bytes on wasm32. Kernel-writes,
    /// userspace-reads page; mapped at SNDRV_PCM_MMAP_OFFSET_STATUS.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkAlsaPcmMmapStatus {
        pub state: u32,                 // SNDRV_PCM_STATE_*
        pub pad1: u32,
        pub hw_ptr: i64,                // frames; updated by period tick
        pub tstamp_sec: i64,            // CLOCK_MONOTONIC
        pub tstamp_nsec: i64,
        pub suspended_state: u32,
        pub audio_tstamp_data: u32,
        pub audio_tstamp_sec: i64,
        pub audio_tstamp_nsec: i64,
                                        // total: 64
    }

    /// `struct snd_pcm_mmap_control`. 64 bytes on wasm32. Userspace-
    /// writes, kernel-reads page; mapped at SNDRV_PCM_MMAP_OFFSET_CONTROL.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkAlsaPcmMmapControl {
        pub appl_ptr: i64,              // frames; userspace advances on
                                        // every WRITEI completed
        pub avail_min: i64,             // frames; threshold for POLLOUT
        pub _reserved: [u8; 48],
                                        // total: 64
    }

    /// `struct snd_xferi` — argument to WRITEI_FRAMES / READI_FRAMES.
    /// 24 bytes on wasm32.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkAlsaXferi {
        pub result: i64,                // out: frames transferred or
                                        // negative errno
        pub buf: u64,                   // in: ptr to userspace audio
                                        // buffer
        pub frames: u64,                // in: frame count
                                        // total: 24
    }

    /// `struct snd_ctl_card_info`. 256 bytes on wasm32. Returned by
    /// SNDRV_CTL_IOCTL_CARD_INFO; alsa-lib reads `id`, `driver`,
    /// `name`, `longname`, `mixername`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct WpkAlsaCtlCardInfo {
        pub card: i32,
        pub pad: i32,
        pub id: [u8; 16],
        pub driver: [u8; 16],
        pub name: [u8; 32],
        pub longname: [u8; 80],
        pub reserved_: [u8; 16],
        pub mixername: [u8; 80],
        pub components: [u8; 128],
                                        // total: 376; trim to 256 by
                                        // shrinking `components` to 16
                                        // — v1 doesn't ship components.
                                        // Verify against Linux's 376.
    }

    /// `struct snd_ctl_elem_id`. 64 bytes on wasm32.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkAlsaCtlElemId {
        pub numid: u32,
        pub iface: u32,                 // SNDRV_CTL_ELEM_IFACE_*
        pub device: u32,
        pub subdevice: u32,
        pub name: [u8; 44],
        pub index: u32,
                                        // total: 64
    }

    /// `struct snd_ctl_elem_list`. ~80 bytes on wasm32.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct WpkAlsaCtlElemList {
        pub offset: u32,
        pub space: u32,
        pub used: u32,
        pub count: u32,
        pub pids: u64,                  // ptr to caller's id-array
        pub reserved: [u8; 50],
                                        // total: ~80; size-assert
    }

    // --- card-info defaults ----------------------------------------------

    pub const WPK_AUDIO_DRIVER_NAME: &[u8] = b"wpk-audio";
    pub const WPK_AUDIO_CARD_NAME: &[u8] = b"wpk-virtual";
    pub const WPK_AUDIO_PCM_NAME: &[u8] = b"wpk virtual playback";
    pub const WPK_AUDIO_LONGNAME: &[u8] =
        b"WPK virtual audio device (host-driven AudioWorklet)";
}

#[cfg(test)]
mod audio_tests {
    use super::audio::*;
    use core::mem::size_of;

    #[test]
    fn audio_struct_sizes_match_wasm32_repr_c() {
        // Tighten these against the actual repr(C) output once the
        // struct definitions are finalised. The Linux ground-truth
        // values below are starting points; cargo expand resolves the
        // wasm32 layout.
        assert_eq!(size_of::<WpkAlsaPcmHwParams>(), 596);
        assert_eq!(size_of::<WpkAlsaPcmSwParams>(), 136);
        assert_eq!(size_of::<WpkAlsaPcmStatus>(), 128);
        assert_eq!(size_of::<WpkAlsaPcmInfo>(), 288);
        assert_eq!(size_of::<WpkAlsaPcmMmapStatus>(), 64);
        assert_eq!(size_of::<WpkAlsaPcmMmapControl>(), 64);
        assert_eq!(size_of::<WpkAlsaXferi>(), 24);
        assert_eq!(size_of::<WpkAlsaCtlCardInfo>(), 256);
        assert_eq!(size_of::<WpkAlsaCtlElemId>(), 64);
        assert_eq!(size_of::<WpkSndInterval>(), 16);
    }

    #[test]
    fn audio_mmap_status_field_offsets() {
        // The mmap_status page is read by userspace via direct memory
        // access; field offsets are load-bearing.
        let s = WpkAlsaPcmMmapStatus::default();
        let base = (&s as *const _) as usize;
        assert_eq!((&s.state as *const _ as usize) - base, 0);
        assert_eq!((&s.hw_ptr as *const _ as usize) - base, 8);
        assert_eq!((&s.tstamp_sec as *const _ as usize) - base, 16);
    }

    #[test]
    fn audio_mmap_control_field_offsets() {
        let c = WpkAlsaPcmMmapControl::default();
        let base = (&c as *const _) as usize;
        assert_eq!((&c.appl_ptr as *const _ as usize) - base, 0);
        assert_eq!((&c.avail_min as *const _ as usize) - base, 8);
    }
}
```

**The struct sizes above are TARGETS, not asserts that will pass on
first try.** alsa-lib ABI is famously fiddly — `snd_pcm_hw_params`
in particular contains arrays whose lengths shift between kernel
versions. The exact wasm32 layout will be one or two iterations of
`cargo test → cargo expand → adjust array length` before all
size_of_val asserts pass. Document the iteration in A1's commit
body; future-me will thank present-me.

**Step 2: Run**

```bash
cargo test -p wasm-posix-shared --target aarch64-apple-darwin --lib audio_tests
```

Expected: 3 new tests pass (after the iteration noted above); plan 2
+ plan 3 + plan 4 + plan 5 tests still pass. If a layout assertion
fails, `cargo expand` shows the actual layout; adjust struct field
arrays to match.

**Step 3: Commit**

```bash
git add crates/shared/src/lib.rs
git commit -m "kernel(audio): shared ABI — SNDRV_PCM_IOCTL_* + structs + format/state constants"
```

---

### Task A2: `VirtualDevice::AlsaPcm` + `AlsaControl` + devfs entries + `AlsaFdState` on OFD

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — extend `VirtualDevice`
  enum + `match_virtual_device`.
- Modify: `crates/kernel/src/devfs.rs` — add `snd/` synthetic
  subdirectory with `controlC0` + `pcmC0D0p`.
- Modify: `crates/kernel/src/ofd.rs` — add `OpenFileKind::AlsaPcm` +
  `OpenFileKind::AlsaControl` variants and an `audio:
  Option<Box<AlsaFdState>>` field on `OpenFileDesc`.

**Step 1: Device enum**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PcmDir {
    Playback,
    Capture,  // v1 returns ENODEV from devfs lookup
}

pub enum VirtualDevice {
    // … existing variants …
    DriRender0,
    DriCard0,
    InputEvent { device: u8 },         // plan 5
    AlsaPcm {                          // plan 6 — this task
        card: u8,
        device: u8,
        sub: u8,
        kind: PcmDir,
    },
    AlsaControl { card: u8 },          // plan 6 — this task
}
```

Extend `match_virtual_device` to map:
- `/dev/snd/controlC0` → `AlsaControl { card: 0 }`
- `/dev/snd/pcmC0D0p` → `AlsaPcm { card: 0, device: 0, sub: 0, kind:
  Playback }`
- `/dev/snd/pcmC0D0c` (capture) → ENODEV (v1 doesn't ship capture)
- Other `/dev/snd/*` paths → ENOENT.

**Step 2: devfs entries**

Add a new `snd` subdirectory under `/dev`:

```rust
// In devfs.rs, alongside the existing /dev/input synthetic dir:
synthetic_subdir("snd", &[
    synthetic_entry("controlC0", DT_CHR, 116 /* ALSA_MAJOR */, 0),
    synthetic_entry("pcmC0D0p",  DT_CHR, 116,                  16),
]);
```

(Major 116 is the Linux ALSA major; minor 0 is `controlC0`; minor 16
is `pcmC0D0p` per `Documentation/admin-guide/devices.txt` "Sound
device" table. Conventional, not load-bearing.)

**Step 3: `AlsaFdState` on the OFD**

In `crates/kernel/src/ofd.rs`:

```rust
/// Per-fd state for `/dev/snd/pcmC0D0p` opens. Disjoint from
/// `DriOfdState` (plan 4) and `InputFdState` (plan 5) — audio fds
/// carry no DRI bo state and no input ring state. Mirrors the
/// "one Option<Box<…>> per device class" factoring plan 5
/// established.
#[derive(Default, Clone, Debug)]
pub struct AlsaFdState {
    /// Which card/device/sub/kind this fd is bound to.
    pub card: u8,
    pub device: u8,
    pub sub: u8,
    pub kind: PcmDir,

    /// PCM state machine. SNDRV_PCM_STATE_* values.
    pub state: u32,

    /// HW_PARAMS cache — populated by HW_PARAMS, read by everything
    /// else. None until HW_PARAMS lands.
    pub hw_params: Option<Box<HwParamsCache>>,

    /// SW_PARAMS cache.
    pub sw_params: Option<Box<SwParamsCache>>,

    /// mmap_status page — kernel-writes, userspace-reads. Allocated
    /// on first mmap(SNDRV_PCM_MMAP_OFFSET_STATUS).
    pub mmap_status: Option<Box<WpkAlsaPcmMmapStatus>>,

    /// mmap_control page — userspace-writes, kernel-reads.
    pub mmap_control: Option<Box<WpkAlsaPcmMmapControl>>,

    /// Identifier into `audio::sab_table` — host-allocated SAB that
    /// holds the PCM data ring. Set by `kernel_audio_init_sab`; the
    /// table holds (base_ptr_into_kernel_memory, len_bytes).
    pub pcm_id: u32,
}

#[derive(Default, Clone, Debug)]
pub struct HwParamsCache {
    pub format: u32,        // SNDRV_PCM_FORMAT_S16_LE only in v1
    pub access: u32,        // SNDRV_PCM_ACCESS_MMAP_INTERLEAVED or RW_INTERLEAVED
    pub channels: u32,      // 1 or 2 in v1
    pub rate: u32,          // 8000..48000 Hz
    pub period_size: u64,   // frames
    pub buffer_size: u64,   // frames (= period_size * periods)
    pub periods: u32,
}

#[derive(Default, Clone, Debug)]
pub struct SwParamsCache {
    pub avail_min: u64,     // frames
    pub start_threshold: u64,
    pub stop_threshold: u64,
    pub boundary: u64,
}

#[derive(Default, Clone, Debug)]
pub struct AlsaControlFdState {
    pub card: u8,
    // v1 controlC0 carries no per-fd state beyond the card binding —
    // CARD_INFO and ELEM_LIST are read-only and serve from kernel
    // globals.
}
```

Attach `audio: Option<Box<AlsaFdState>>` and `audio_ctl:
Option<Box<AlsaControlFdState>>` to `OpenFileDesc`, parallel to
`dri_state` + `input` (plan 5's consolidation precedent).

(One could argue these should join into a single `audio:
Option<Box<AudioOfdState>>` enum with variants `Pcm(AlsaFdState)` /
`Ctl(AlsaControlFdState)`. The Pre-impl review will decide; the
disjoint-vs-enum trade-off is the same one plan 5 settled — disjoint
state machines, separate boxes. v1 ships disjoint; plan 9 may
revisit if the compositor needs both fds on one OFD for some reason.)

**Step 4: Cargo tests**

```rust
#[test]
fn open_pcm_playback_yields_audio_state_in_open_state() {
    // OFD.audio is Some, .state = SNDRV_PCM_STATE_OPEN, no params yet.
}

#[test]
fn open_control_yields_audio_ctl_state() {
    // OFD.audio_ctl is Some, .audio is None.
}

#[test]
fn open_pcm_capture_returns_enodev() {
    // /dev/snd/pcmC0D0c → ENODEV (we only ship playback in v1).
}

#[test]
fn fork_inherits_audio_state_via_ofd_dup() {
    // Same OFD shared by ref → same AlsaFdState. (Audio state shared
    // through fork has user-visible consequences; see Pre-impl review
    // "fork-shared-pcm".)
}
```

**Step 5: Commit**

```bash
git add crates/kernel/src/syscalls.rs crates/kernel/src/devfs.rs \
        crates/kernel/src/ofd.rs
git commit -m "kernel(audio): add /dev/snd/{controlC0,pcmC0D0p} + AlsaFdState on OFD"
```

---

### Task A3: PCM ioctl dispatch — PVERSION / INFO / HW_REFINE / HW_PARAMS / SW_PARAMS / PREPARE / START / DROP / PAUSE / STATUS

**Files:**
- Create: `crates/kernel/src/audio/mod.rs` — sibling of `input/` and
  `dri/`.
- Create: `crates/kernel/src/audio/pcm_ioctl.rs` — dispatcher for PCM
  ioctls.
- Modify: `crates/kernel/src/syscalls.rs` — route `OpenFileKind::AlsaPcm`
  ioctls into `handle_alsa_pcm_ioctl(pid, fd, request, buf)`.

**Step 1: Dispatcher**

```rust
fn handle_alsa_pcm_ioctl(pid: i32, fd: i32, request: u32,
    buf: &mut [u8]) -> Result<(), Errno>
{
    use wasm_posix_shared::audio::*;

    match request {
        SNDRV_PCM_IOCTL_PVERSION => {
            // alsa-lib expects 0x000d_0000 (version 13.0.0); any
            // higher number than the alsa-lib runtime version makes
            // it bail.
            write_u32(buf, 0x000d_0000)
        }

        SNDRV_PCM_IOCTL_INFO => {
            let info = WpkAlsaPcmInfo {
                card: 0,
                device: 0,
                subdevice: 0,
                stream: SNDRV_PCM_STREAM_PLAYBACK as i32,
                ..Default::default()
            };
            // … fill name[] = "wpk virtual playback\0", id[] = "wpk\0",
            // dev_class = SNDRV_PCM_CLASS_GENERIC, etc.
            write_struct(buf, &info)
        }

        SNDRV_PCM_IOCTL_HW_REFINE => {
            // alsa-lib calls HW_REFINE to narrow a wildcard hw_params
            // request to a single concrete combination. Walk the
            // request's intervals and masks, clamp to v1 capabilities
            // (S16_LE only, MMAP_INTERLEAVED or RW_INTERLEAVED only,
            // 1 or 2 channels, 8000..48000 Hz, period 64..4096 frames,
            // buffer 256..16384 frames), and write back the narrowed
            // result. EINVAL if no combination fits.
            let mut req: WpkAlsaPcmHwParams = read_struct(buf)?;
            refine_hw_params(&mut req)?;
            write_struct(buf, &req)
        }

        SNDRV_PCM_IOCTL_HW_PARAMS => {
            // HW_PARAMS commits a refined hw_params into the OFD's
            // state. State transitions OPEN → SETUP. After this point
            // the PCM is configured; PREPARE moves to PREPARED.
            let mut req: WpkAlsaPcmHwParams = read_struct(buf)?;
            refine_hw_params(&mut req)?;
            with_alsa_pcm_ofd_mut(pid, fd, |a| {
                if a.state != SNDRV_PCM_STATE_OPEN
                    && a.state != SNDRV_PCM_STATE_SETUP
                {
                    return Err(Errno::EBADFD);
                }
                a.hw_params = Some(Box::new(HwParamsCache {
                    format: extract_format(&req)?,
                    access: extract_access(&req)?,
                    channels: extract_channels(&req)?,
                    rate: extract_rate(&req)?,
                    period_size: extract_period_size(&req)?,
                    buffer_size: extract_buffer_size(&req)?,
                    periods: extract_periods(&req)?,
                }));
                a.state = SNDRV_PCM_STATE_SETUP;
                Ok(())
            })??;
            write_struct(buf, &req)
        }

        SNDRV_PCM_IOCTL_HW_FREE => {
            with_alsa_pcm_ofd_mut(pid, fd, |a| {
                a.hw_params = None;
                a.sw_params = None;
                a.state = SNDRV_PCM_STATE_OPEN;
                Ok(())
            })?
        }

        SNDRV_PCM_IOCTL_SW_PARAMS => {
            let req: WpkAlsaPcmSwParams = read_struct(buf)?;
            with_alsa_pcm_ofd_mut(pid, fd, |a| {
                if a.hw_params.is_none() { return Err(Errno::EBADFD); }
                a.sw_params = Some(Box::new(SwParamsCache {
                    avail_min: req.avail_min,
                    start_threshold: req.start_threshold,
                    stop_threshold: req.stop_threshold,
                    boundary: req.boundary,
                }));
                Ok(())
            })?
        }

        SNDRV_PCM_IOCTL_PREPARE => {
            with_alsa_pcm_ofd_mut(pid, fd, |a| {
                if a.hw_params.is_none() { return Err(Errno::EBADFD); }
                a.state = SNDRV_PCM_STATE_PREPARED;
                // Reset hw_ptr and appl_ptr to 0; user re-fills the
                // ring from scratch.
                if let Some(s) = a.mmap_status.as_mut() {
                    s.hw_ptr = 0;
                    s.state = SNDRV_PCM_STATE_PREPARED;
                }
                if let Some(c) = a.mmap_control.as_mut() {
                    c.appl_ptr = 0;
                }
                Ok(())
            })?
        }

        SNDRV_PCM_IOCTL_START => {
            with_alsa_pcm_ofd_mut(pid, fd, |a| {
                if a.state != SNDRV_PCM_STATE_PREPARED {
                    return Err(Errno::EBADFD);
                }
                a.state = SNDRV_PCM_STATE_RUNNING;
                if let Some(s) = a.mmap_status.as_mut() {
                    s.state = SNDRV_PCM_STATE_RUNNING;
                    let now = crate::time::monotonic_us();
                    s.tstamp_sec = (now / 1_000_000) as i64;
                    s.tstamp_nsec = ((now % 1_000_000) * 1000) as i64;
                }
                // Notify the host driver to begin pulling — this is a
                // *kernel-internal* signal; the host polls
                // `kernel_audio_running(pcm_id) -> bool` from its
                // AudioWorklet boot path. (Alternative: a host import
                // `host_audio_start(pcm_id)`. v1 chooses the
                // kernel-export-poll shape to maintain "no host
                // imports" parity with plan 5; the host driver checks
                // state every quantum and starts/stops based on it.)
                Ok(())
            })?
        }

        SNDRV_PCM_IOCTL_DROP => {
            with_alsa_pcm_ofd_mut(pid, fd, |a| {
                a.state = SNDRV_PCM_STATE_SETUP;
                if let Some(s) = a.mmap_status.as_mut() {
                    s.state = SNDRV_PCM_STATE_SETUP;
                }
                Ok(())
            })?
        }

        SNDRV_PCM_IOCTL_PAUSE => {
            let value = read_u32(buf)? as i32;  // 1 = pause, 0 = resume
            with_alsa_pcm_ofd_mut(pid, fd, |a| {
                a.state = if value != 0 {
                    SNDRV_PCM_STATE_PAUSED
                } else {
                    SNDRV_PCM_STATE_RUNNING
                };
                if let Some(s) = a.mmap_status.as_mut() {
                    s.state = a.state;
                }
                Ok(())
            })?
        }

        SNDRV_PCM_IOCTL_STATUS => {
            with_alsa_pcm_ofd_mut(pid, fd, |a| {
                let now = crate::time::monotonic_us();
                let hw = a.mmap_status.as_ref().map(|s| s.hw_ptr).unwrap_or(0);
                let appl = a.mmap_control.as_ref().map(|c| c.appl_ptr).unwrap_or(0);
                let buffer = a.hw_params.as_ref()
                    .map(|h| h.buffer_size as i64).unwrap_or(0);
                let status = WpkAlsaPcmStatus {
                    state: a.state,
                    trigger_tstamp_sec: 0, trigger_tstamp_nsec: 0,
                    tstamp_sec: (now / 1_000_000) as i64,
                    tstamp_nsec: ((now % 1_000_000) * 1000) as i64,
                    appl_ptr: appl,
                    hw_ptr: hw,
                    delay: appl - hw,
                    avail: (buffer - (appl - hw)) as u64,
                    avail_max: buffer as u64,
                    overrange: 0,
                    suspended_state: 0,
                    audio_tstamp_data: 0,
                    audio_tstamp_sec: 0,
                    audio_tstamp_nsec: 0,
                    reserved: [0u8; 16],
                };
                write_struct(buf, &status)
            })?
        }

        SNDRV_PCM_IOCTL_WRITEI_FRAMES => handle_writei(pid, fd, buf),

        _ => Err(Errno::EOPNOTSUPP),
    }
}
```

`handle_writei` is the data-path; see A4.

**Step 2: Wire into the syscall ioctl router**

In `sys_ioctl`, before falling through to "unrecognised ioctl on this
device":

```rust
if let Some(OpenFileKind::AlsaPcm { .. }) = ofd.kind.as_ref() {
    return handle_alsa_pcm_ioctl(pid, fd, request, buf);
}
if let Some(OpenFileKind::AlsaControl { .. }) = ofd.kind.as_ref() {
    return handle_alsa_ctl_ioctl(pid, fd, request, buf);  // Task A8
}
```

**Step 3: Cargo tests**

```rust
#[test]
fn pcm_pversion_returns_alsa_v13() { /* alsa-lib's minimum version */ }

#[test]
fn pcm_info_returns_playback_stream_card0_device0() { /* … */ }

#[test]
fn pcm_hw_refine_clamps_unsupported_format_to_s16_le() { /* … */ }

#[test]
fn pcm_hw_params_transitions_open_to_setup() { /* … */ }

#[test]
fn pcm_hw_params_without_format_returns_einval() { /* … */ }

#[test]
fn pcm_prepare_after_hw_params_transitions_to_prepared() { /* … */ }

#[test]
fn pcm_start_from_prepared_transitions_to_running() { /* … */ }

#[test]
fn pcm_start_without_prepare_returns_ebadfd() { /* … */ }

#[test]
fn pcm_drop_from_running_transitions_to_setup() { /* … */ }

#[test]
fn pcm_pause_then_resume_round_trips() { /* … */ }

#[test]
fn pcm_status_reflects_appl_ptr_hw_ptr_delta() { /* … */ }
```

**Step 4: Commit**

```bash
git add crates/kernel/src/audio/ crates/kernel/src/syscalls.rs
git commit -m "kernel(audio): SNDRV_PCM_IOCTL_* dispatch — state machine + HW_PARAMS refine"
```

---

### Task A4: `WRITEI_FRAMES` data-path + SAB ring + `kernel_audio_init_sab` export

**Files:**
- Create: `crates/kernel/src/audio/sab.rs` — host-provided SAB
  registry.
- Modify: `crates/kernel/src/audio/pcm_ioctl.rs` — `handle_writei`.
- Modify: `crates/kernel/src/wasm_api.rs` — add `kernel_audio_init_sab`
  export.

**Step 1: SAB registry**

```rust
// crates/kernel/src/audio/sab.rs

use spin::Mutex;

#[derive(Clone, Copy, Debug)]
pub struct SabSlice {
    /// Base pointer into the kernel's linear memory. The host
    /// imported a SharedArrayBuffer view at this address via the
    /// existing memory-import path; the kernel sees it as a normal
    /// `&mut [u8]`.
    pub base: usize,
    /// Length in bytes.
    pub len: usize,
}

static SAB_TABLE: Mutex<[Option<SabSlice>; 4]> = Mutex::new([None; 4]);

pub fn register(pcm_id: u32, slice: SabSlice) -> Result<(), crate::Errno> {
    let idx = pcm_id as usize;
    if idx >= 4 { return Err(crate::Errno::EINVAL); }
    let mut tbl = SAB_TABLE.lock();
    if tbl[idx].is_some() { return Err(crate::Errno::EBUSY); }
    tbl[idx] = Some(slice);
    Ok(())
}

pub fn lookup(pcm_id: u32) -> Option<SabSlice> {
    SAB_TABLE.lock().get(pcm_id as usize).copied().flatten()
}

/// Return the kernel-side `&mut [i16]` view of the PCM ring. Unsafe
/// because the host is mutating the same memory via the AudioWorklet;
/// synchronisation is via `mmap_status->hw_ptr` and
/// `mmap_control->appl_ptr` (the lock-free producer-consumer protocol
/// alsa-lib expects).
pub unsafe fn ring_mut_s16(pcm_id: u32) -> Option<&'static mut [i16]> {
    let SabSlice { base, len } = lookup(pcm_id)?;
    Some(core::slice::from_raw_parts_mut(base as *mut i16, len / 2))
}
```

**Step 2: Kernel export**

```rust
// crates/kernel/src/wasm_api.rs

#[no_mangle]
pub extern "C" fn kernel_audio_init_sab(pcm_id: u32, sab_base: u64,
    sab_len: u32)
{
    let _ = crate::audio::sab::register(pcm_id,
        crate::audio::sab::SabSlice {
            base: sab_base as usize,
            len: sab_len as usize,
        });
    // Errors swallowed — host-side init is best-effort; if pcm_id
    // is already registered, the second call is a no-op.
}
```

**Step 3: WRITEI_FRAMES**

```rust
fn handle_writei(pid: i32, fd: i32, buf: &mut [u8]) -> Result<(), Errno>
{
    use wasm_posix_shared::audio::*;
    let mut req: WpkAlsaXferi = read_struct(buf)?;
    let frames = req.frames as usize;
    // The audio data ring is SAB-backed; userspace can mmap it
    // directly and write into it without WRITEI. WRITEI is the
    // non-mmap path (alsa-lib's "rw_interleaved" access mode).
    with_alsa_pcm_ofd(pid, fd, |a| {
        let Some(hw) = a.hw_params.as_ref() else {
            return Err(Errno::EBADFD);
        };
        if hw.format != SNDRV_PCM_FORMAT_S16_LE {
            return Err(Errno::EINVAL);  // v1 only ships S16_LE
        }
        let ring = unsafe {
            crate::audio::sab::ring_mut_s16(a.pcm_id)
                .ok_or(Errno::ENODEV)?
        };
        let ring_frames = ring.len() / hw.channels as usize;
        let appl = a.mmap_control.as_ref()
            .ok_or(Errno::EBADFD)?.appl_ptr as usize;
        let hw_ptr = a.mmap_status.as_ref()
            .ok_or(Errno::EBADFD)?.hw_ptr as usize;
        let avail = ring_frames - (appl - hw_ptr);
        let to_write = frames.min(avail);
        // Copy frames from user buf to SAB ring; wrap appl_ptr at
        // ring_frames. Channels-interleaved layout (alsa-lib's
        // "rw_interleaved").
        let src: &[i16] = unsafe {
            core::slice::from_raw_parts(req.buf as *const i16,
                to_write * hw.channels as usize)
        };
        for f in 0..to_write {
            let dst_off = ((appl + f) % ring_frames) * hw.channels as usize;
            for c in 0..hw.channels as usize {
                ring[dst_off + c] = src[f * hw.channels as usize + c];
            }
        }
        // Advance appl_ptr — the AudioWorklet picks up the new data
        // on its next quantum.
        if let Some(ctl) = /* re-borrow mut */ {
            ctl.appl_ptr = (appl + to_write) as i64;
        }
        req.result = to_write as i64;
        Ok(())
    })??;
    write_struct(buf, &req)
}
```

(The `with_alsa_pcm_ofd` vs `_mut` borrow dance above is sketched;
final impl uses `_mut` and avoids the double-borrow.)

**Step 4: Cargo tests**

```rust
#[test]
fn writei_appends_frames_to_sab_ring() { /* … */ }

#[test]
fn writei_blocks_caller_when_ring_full() {
    // Configure period=1024, buffer=4096; write 4096 frames; next
    // WRITEI parks until kernel_audio_period_tick frees space.
}

#[test]
fn writei_wraps_appl_ptr_at_buffer_boundary() { /* … */ }

#[test]
fn writei_in_open_state_returns_ebadfd() { /* … */ }

#[test]
fn writei_with_unsupported_format_returns_einval() { /* … */ }
```

**Step 5: Commit**

```bash
git add crates/kernel/src/audio/ crates/kernel/src/wasm_api.rs
git commit -m "kernel(audio): WRITEI_FRAMES + SAB ring + kernel_audio_init_sab export"
```

---

### Task A5: `mmap` of status / control / data pages

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — `sys_mmap` arm for OFDs
  with `audio` populated.

```rust
// In sys_mmap, for OpenFileKind::AlsaPcm OFDs:
if let Some(audio) = ofd.audio.as_mut() {
    return handle_alsa_mmap(pid, fd, addr, length, prot, flags,
                             offset, audio);
}

fn handle_alsa_mmap(pid: i32, fd: i32, addr: *mut u8, length: usize,
    prot: u32, flags: u32, offset: u64, audio: &mut AlsaFdState)
    -> Result<*mut u8, Errno>
{
    use wasm_posix_shared::audio::*;
    match offset {
        SNDRV_PCM_MMAP_OFFSET_STATUS => {
            // Allocate the page if first mmap.
            if audio.mmap_status.is_none() {
                audio.mmap_status = Some(Box::new(WpkAlsaPcmMmapStatus::default()));
            }
            let status = audio.mmap_status.as_ref().unwrap();
            let ptr = (status.as_ref() as *const _) as *mut u8;
            // Map ptr..ptr+sizeof(WpkAlsaPcmMmapStatus) into user
            // process at `addr` via the existing mmap-VPN
            // infrastructure.
            map_kernel_page_into_user(pid, addr, ptr, length, prot)
        }
        SNDRV_PCM_MMAP_OFFSET_CONTROL => {
            if audio.mmap_control.is_none() {
                audio.mmap_control = Some(Box::new(WpkAlsaPcmMmapControl::default()));
            }
            let ctl = audio.mmap_control.as_ref().unwrap();
            let ptr = (ctl.as_ref() as *const _) as *mut u8;
            map_kernel_page_into_user(pid, addr, ptr, length, prot)
        }
        SNDRV_PCM_MMAP_OFFSET_DATA => {
            // The PCM data ring. Host registered the SAB via
            // kernel_audio_init_sab; we hand userspace the same
            // pointer (same memory).
            let slice = crate::audio::sab::lookup(audio.pcm_id)
                .ok_or(Errno::ENODEV)?;
            map_kernel_page_into_user(pid, addr, slice.base as *mut u8,
                                       length.min(slice.len), prot)
        }
        _ => Err(Errno::EINVAL),
    }
}
```

`map_kernel_page_into_user` is the existing helper (used by
shared-anon mmap, etc.) — verify it accepts kernel-resident pointers
as map sources. If not, add a `kind = MappingKind::KernelOwned` arm.

**Cargo tests:**

```rust
#[test]
fn mmap_status_page_returns_mapped_kernel_struct() { /* … */ }

#[test]
fn mmap_control_page_is_writable_by_userspace() { /* … */ }

#[test]
fn mmap_data_page_returns_sab_region() { /* … */ }

#[test]
fn mmap_data_before_init_sab_returns_enodev() { /* … */ }
```

**Commit:** `kernel(audio): mmap status / control / data pages`

---

### Task A6: `kernel_audio_period_tick` — advance hw_ptr + wake POLLOUT waiters

**Files:**
- Create: `crates/kernel/src/audio/tick.rs` — the producer.
- Modify: `crates/kernel/src/wasm_api.rs` — add the
  `kernel_audio_period_tick` export.

**Step 1: The producer**

```rust
// crates/kernel/src/audio/tick.rs

use crate::audio::wait;

/// Called from the host on every period-tick. Walks every open
/// `/dev/snd/pcmC0D0p` OFD whose `pcm_id == pcm_id` argument and
/// whose state is RUNNING; advances `mmap_status.hw_ptr` by
/// `frames_consumed`; wakes any process blocked in WRITEI / POLLOUT
/// if space is now available.
///
/// Same lock-order resolution as plan 4 A7 + plan 5 A4: take
/// PROCESS_TABLE briefly, iterate `pt.ofds.entries`, collect
/// wake-targets, drop the lock, then call wait::wake_*.
pub fn tick(pcm_id: u32, frames_consumed: u32) {
    let now = crate::time::monotonic_us();
    let mut woken: Vec<usize> = Vec::new();
    {
        let mut pt = crate::PROCESS_TABLE.lock();
        for (idx, slot) in pt.ofds.entries.iter_mut().enumerate() {
            let Some(ofd) = slot.as_mut() else { continue; };
            let Some(audio) = ofd.audio.as_mut() else { continue; };
            if audio.pcm_id != pcm_id { continue; }
            if audio.state != SNDRV_PCM_STATE_RUNNING { continue; }
            if let Some(status) = audio.mmap_status.as_mut() {
                status.hw_ptr = status.hw_ptr.saturating_add(
                    frames_consumed as i64);
                status.tstamp_sec = (now / 1_000_000) as i64;
                status.tstamp_nsec = ((now % 1_000_000) * 1000) as i64;
                // XRUN detection: if hw_ptr passes appl_ptr the
                // userspace under-fed us.
                let appl = audio.mmap_control.as_ref()
                    .map(|c| c.appl_ptr).unwrap_or(0);
                if status.hw_ptr > appl {
                    audio.state = SNDRV_PCM_STATE_XRUN;
                    status.state = SNDRV_PCM_STATE_XRUN;
                }
            }
            woken.push(idx);
        }
    }
    for idx in woken {
        wait::wake_pollout(idx);
    }
}
```

**Step 2: The kernel export**

```rust
// crates/kernel/src/wasm_api.rs

/// Called by the host on every AudioWorklet quantum (browser) or
/// setInterval tick (Node) after the host driver pulled
/// `frames_consumed` frames from the SAB ring. Advances hw_ptr in
/// the corresponding pcm_id's mmap_status; wakes blocked WRITEI /
/// POLLOUT callers.
#[no_mangle]
pub extern "C" fn kernel_audio_period_tick(pcm_id: u32,
    frames_consumed: u32)
{
    crate::audio::tick::tick(pcm_id, frames_consumed);
}
```

**Step 3: POLLOUT semantics**

`poll(pcm_fd, POLLOUT)` returns ready iff `avail >= sw_params.avail_min`
where `avail = buffer_size - (appl_ptr - hw_ptr)`. The
`wait::wake_pollout` primitive is the per-OFD wake (sibling of
plan 5's `input::wait::wake_event_reader`).

**Cargo tests:**

```rust
#[test]
fn tick_advances_hw_ptr_by_frames_consumed() { /* … */ }

#[test]
fn tick_on_non_running_pcm_is_a_noop() { /* … */ }

#[test]
fn tick_underrun_transitions_state_to_xrun() {
    // appl_ptr = 1000; tick advances hw_ptr to 1100 (past appl).
    // State must become XRUN; user must SNDRV_PCM_IOCTL_PREPARE to
    // recover.
}

#[test]
fn tick_wakes_blocked_pollout_waiter() { /* … */ }
```

**Step 4: Commit**

```bash
git add crates/kernel/src/audio/ crates/kernel/src/wasm_api.rs
git commit -m "kernel(audio): kernel_audio_period_tick export + hw_ptr advance + XRUN detection"
```

---

### Task A7: `poll(POLLOUT)` + non-blocking `write` arm

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — `sys_poll` arm for
  `OpenFileKind::AlsaPcm`.

```rust
// In sys_poll, for AlsaPcm OFDs:
if let Some(audio) = ofd.audio.as_mut() {
    let buffer = audio.hw_params.as_ref()
        .map(|h| h.buffer_size as i64).unwrap_or(0);
    let appl = audio.mmap_control.as_ref()
        .map(|c| c.appl_ptr).unwrap_or(0);
    let hw_ptr = audio.mmap_status.as_ref()
        .map(|s| s.hw_ptr).unwrap_or(0);
    let avail = buffer - (appl - hw_ptr);
    let avail_min = audio.sw_params.as_ref()
        .map(|s| s.avail_min as i64).unwrap_or(1);
    if pfd.events & POLLOUT != 0 {
        if avail >= avail_min {
            pfd.revents |= POLLOUT;
        } else if blocking {
            crate::audio::wait::block_pollout(ofd_idx)?;
        }
    }
    if audio.state == SNDRV_PCM_STATE_XRUN {
        pfd.revents |= POLLERR;
    }
    continue;
}
```

**Cargo tests:**
- `poll_pollout_ready_when_avail_above_threshold`.
- `poll_pollout_blocks_when_buffer_full`.
- `poll_pollerr_set_on_xrun_state`.

**Commit:** `kernel(audio): poll(POLLOUT) + XRUN reflection in POLLERR`

---

### Task A8: controlC0 ioctl dispatch — PVERSION / CARD_INFO / ELEM_LIST

**Files:**
- Create: `crates/kernel/src/audio/ctl_ioctl.rs`.
- Modify: `crates/kernel/src/syscalls.rs` — wire the dispatcher.

```rust
fn handle_alsa_ctl_ioctl(pid: i32, fd: i32, request: u32,
    buf: &mut [u8]) -> Result<(), Errno>
{
    use wasm_posix_shared::audio::*;
    match request {
        SNDRV_CTL_IOCTL_PVERSION => write_u32(buf, 0x0002_0007),

        SNDRV_CTL_IOCTL_CARD_INFO => {
            let mut info = WpkAlsaCtlCardInfo { card: 0, ..Default::default() };
            // … fill id="wpk", driver="wpk-audio", name="wpk-virtual",
            // longname="WPK virtual audio device", mixername="", …
            copy_to_field(&mut info.id, WPK_AUDIO_DRIVER_NAME);
            copy_to_field(&mut info.driver, WPK_AUDIO_DRIVER_NAME);
            copy_to_field(&mut info.name, WPK_AUDIO_CARD_NAME);
            copy_to_field(&mut info.longname, WPK_AUDIO_LONGNAME);
            write_struct(buf, &info)
        }

        SNDRV_CTL_IOCTL_ELEM_LIST => {
            // v1 reports zero elements — alsa-lib + SDL2 both tolerate
            // an empty mixer surface. Write `count = 0, used = 0`
            // back and return Ok.
            let mut req: WpkAlsaCtlElemList = read_struct(buf)?;
            req.count = 0;
            req.used = 0;
            write_struct(buf, &req)
        }

        _ => Err(Errno::EOPNOTSUPP),
    }
}
```

**Cargo tests:**
- `ctl_pversion_returns_alsa_ctl_v2_0_7`.
- `ctl_card_info_returns_wpk_virtual`.
- `ctl_elem_list_returns_empty`.

**Commit:** `kernel(audio): controlC0 ioctl dispatch — PVERSION + CARD_INFO + ELEM_LIST`

---

### Task A9: `on_final_close` releases SAB binding + cancels tick subscription

**Files:**
- Modify: `crates/kernel/src/ofd.rs` — extend `on_final_close`.

```rust
impl OpenFileDesc {
    pub fn on_final_close(&mut self, pid: i32, host_io: &mut dyn HostIO,
        ofd_idx: usize)
    {
        // … plan 2's prime_bo cleanup …
        // … plan 3's dri.handles cleanup …
        // … plan 4's kms cleanup (master, fbs, pending_flips) …
        // … plan 5's input cleanup …

        if let Some(audio) = self.audio.take() {
            // mmap_status / mmap_control pages are dropped with the
            // Box; the SAB itself stays registered (host owns the
            // memory; other OFDs may still hold the pcm_id binding).
            // If this was the last OFD for `pcm_id`, the host's
            // AudioWorklet may want to stop pulling — but the host
            // doesn't get a kernel-side signal in v1; it polls the
            // PCM state via STATUS ioctl on a separate fd, or it
            // just keeps pulling silence (the SAB will read as
            // zeros after appl_ptr stops advancing).
            //
            // (When plan 9's wpkcompositor adds power-management
            // signals, an `host_audio_pcm_release(pcm_id)` import
            // hook lands here.)
            let _ = audio;
        }

        if let Some(audio_ctl) = self.audio_ctl.take() {
            let _ = audio_ctl;  // no per-fd state
        }
    }
}
```

**Cargo tests:**
- `close_releases_audio_state_but_keeps_sab_registered` — open
  pcmC0D0p, close it; assert the SAB stays in the registry (next
  open re-uses it).
- `fork_then_close_in_child_keeps_audio_state_on_parent`.

**Commit:** `kernel(audio): on_final_close drops audio state`

---

### Task A10: ABI snapshot regen (additive)

**Files:**
- Modify: `abi/snapshot.json` (auto-generated).
- DO NOT modify: `ABI_VERSION`.

Expected diff: new entries for the audio structs, the
`SNDRV_PCM_IOCTL_*` + `SNDRV_CTL_IOCTL_*` numbers, the format / state /
access constants, and the two new exports (`kernel_audio_period_tick`,
`kernel_audio_init_sab`). **No** changes to any existing row.

```bash
bash scripts/check-abi-version.sh update
git diff abi/snapshot.json
bash scripts/check-abi-version.sh
git add abi/snapshot.json
git commit -m "kernel(audio): regen ABI snapshot — additive audio surface"
```

---

### Task A11: Phase A — full gauntlet + open PR #1

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

Push, open draft PR.

Title: `[explore-dri] kernel(audio): /dev/snd/{controlC0,pcmC0D0p} + SNDRV_PCM_IOCTL_* + mmap pages`

Body (Brandon style):

```markdown
## Summary
- Add `/dev/snd/controlC0` (card-level control) and `/dev/snd/pcmC0D0p`
  (PCM playback) as virtual devices alongside plan 5's
  `/dev/input/event*`.
- Per-OFD `AlsaFdState` carrying PCM state machine, HW/SW params
  cache, and pointers to host-allocated SAB + kernel-allocated
  status/control mmap pages.
- `SNDRV_PCM_IOCTL_*` subset alsa-lib drives: PVERSION / INFO /
  HW_REFINE / HW_PARAMS / HW_FREE / SW_PARAMS / PREPARE / START /
  DROP / PAUSE / STATUS / WRITEI_FRAMES.
- `kernel_audio_period_tick(pcm_id, frames_consumed)` export — host
  calls this on every AudioWorklet quantum; kernel advances
  `mmap_status.hw_ptr` and wakes `poll(POLLOUT)` waiters.
- `kernel_audio_init_sab(pcm_id, base, len)` export — host registers
  its SharedArrayBuffer pointer once at boot; subsequent
  `mmap(pcm_fd, ..., OFFSET_DATA)` returns the same memory to
  userspace (zero-copy data path).

## Why
Plan 6 of the DRI v2 design (`docs/plans/2026-05-18-dri-design.md`
§8) — audio is the third of three host-driven event-streams (vblank
in plan 4; input in plan 5; audio here). Prereq for SDL2's audio
backend (plan 7, milestone D); SDL2's init fails hard if the device
probe returns nothing, so this plan must land before SDL2 can be
ported.

## Verification
- `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
- `cd host && npx vitest run`
- `scripts/run-libc-tests.sh`
- `scripts/run-posix-tests.sh`
- `bash scripts/check-abi-version.sh`

## ABI impact
Additive only — no `ABI_VERSION` bump. New `repr(C)` structs
(`WpkAlsaPcmHwParams`, `WpkAlsaPcmSwParams`, `WpkAlsaPcmStatus`,
`WpkAlsaPcmInfo`, `WpkAlsaPcmMmapStatus`, `WpkAlsaPcmMmapControl`,
`WpkAlsaXferi`, `WpkAlsaCtlCardInfo`, `WpkAlsaCtlElemId`,
`WpkAlsaCtlElemList`, `WpkSndInterval`), new ioctl numbers in the
`'A'` and `'U'` magics (verbatim Linux UAPI), two new kernel exports
(`kernel_audio_period_tick`, `kernel_audio_init_sab`). **No new host
imports** — kernel is a mid-stage between user-WRITEI and
host-AudioWorklet; the SAB is the canonical data store. No existing
surface changes.

## Notes
- `CLOCK_MONOTONIC` timestamps (design §16 q6); shared with plan 4's
  `kernel_vblank` and plan 5's `kernel_input_event` for cross-stream
  jitter / A-V-sync profiling.
- v1 supports `SNDRV_PCM_FORMAT_S16_LE` only; HW_REFINE clamps. Other
  formats return EINVAL on HW_PARAMS.
- Single card / single device / single substream / playback only.
- mmap pages are kernel-resident (status + control); the PCM data
  ring is the host-allocated SAB, mapped into the user via the
  existing mmap-VPN path.
- WRITEI_FRAMES is for non-mmap (rw_interleaved) clients; mmap clients
  write the SAB directly and advance `mmap_control.appl_ptr`.
- XRUN detection: `kernel_audio_period_tick` flips the PCM state to
  XRUN if `hw_ptr` passes `appl_ptr`; user must `PREPARE` to recover.
```

**Do not merge.**

---

## Phase B — host: `AudioDriver` (browser AudioWorklet, Node dummy) + SAB ring bridge (PR #2)

### Task B1: `AudioDriver` module + interface

**Files:**
- Create: `host/src/audio/audio-driver.ts`.

```ts
// host/src/audio/audio-driver.ts

export interface AudioDriver {
  /** Begin pulling from the SAB ring once HW_PARAMS lands and the
   * pcm state transitions to RUNNING. `kernelTick` is the bound
   * `kernel.exports.kernel_audio_period_tick` proxy. */
  start(pcmId: number, sampleRate: number, channels: number,
        periodFrames: number, kernelTick: (pcmId: number,
        framesConsumed: number) => void): Promise<void>;

  /** Stop pulling. Called from on_final_close-equivalent host paths
   * and from DROP / PAUSE state transitions (via STATUS polling). */
  stop(pcmId: number): void;

  /** Return the host-allocated SAB for this pcm — the kernel will
   * register it via `kernel_audio_init_sab(pcmId, sab.byteOffset,
   * sab.byteLength)` at boot. Constant for the pcm's lifetime. */
  getSab(pcmId: number): SharedArrayBuffer;
}
```

**Vitest:** import-and-instantiate sanity only.

**Commit:** `host(audio): AudioDriver interface`

---

### Task B2: `BrowserAudioDriver` — AudioContext + AudioWorklet + SAB ring

**Files:**
- Create: `host/src/audio/browser-audio-driver.ts`.
- Create: `host/src/audio/wpk-audio-worklet.js` — the AudioWorklet
  processor (loaded via `audioContext.audioWorklet.addModule`).

```ts
// host/src/audio/browser-audio-driver.ts

import type { AudioDriver } from './audio-driver';

interface PcmContext {
  audioCtx: AudioContext;
  worklet: AudioWorkletNode;
  sab: SharedArrayBuffer;
  sampleRate: number;
  channels: number;
  periodFrames: number;
  quantaPerPeriod: number;       // 128 / sampleRate * periodSize
  quantaSinceTick: number;
  kernelTick: (pcmId: number, frames: number) => void;
}

export class BrowserAudioDriver implements AudioDriver {
  private contexts = new Map<number, PcmContext>();
  // Pre-allocate SABs at construction so the kernel can register
  // them in its boot path before any HW_PARAMS lands.
  private sabs = new Map<number, SharedArrayBuffer>();

  constructor() {
    // v1 ships a single pcm; pre-allocate its SAB. (Sizing: 64 KiB
    // matches the kernel-side cap in HW_REFINE.)
    this.sabs.set(0, new SharedArrayBuffer(64 * 1024));
  }

  getSab(pcmId: number): SharedArrayBuffer {
    const sab = this.sabs.get(pcmId);
    if (!sab) throw new Error(`no SAB for pcmId=${pcmId}`);
    return sab;
  }

  async start(pcmId: number, sampleRate: number, channels: number,
              periodFrames: number,
              kernelTick: (pcmId: number, frames: number) => void)
  {
    const audioCtx = new AudioContext({ sampleRate });
    await audioCtx.audioWorklet.addModule(
        '/audio/wpk-audio-worklet.js');
    const worklet = new AudioWorkletNode(audioCtx, 'wpk-pcm-pull', {
      numberOfInputs: 0, numberOfOutputs: 1,
      outputChannelCount: [channels],
      processorOptions: {
        sab: this.getSab(pcmId),
        channels,
      },
    });
    worklet.connect(audioCtx.destination);

    // The worklet's process() runs on the audio thread; it can't
    // call kernel exports directly. Instead it posts a message on
    // every quantum saying "I consumed N frames"; the main thread
    // accumulates and fires the tick when an ALSA period boundary
    // is reached.
    const ctx: PcmContext = {
      audioCtx, worklet, sab: this.getSab(pcmId), sampleRate,
      channels, periodFrames,
      quantaPerPeriod: Math.ceil(periodFrames / 128),
      quantaSinceTick: 0, kernelTick,
    };
    worklet.port.onmessage = (e) => {
      // e.data = { framesConsumed: number } per quantum
      ctx.quantaSinceTick++;
      if (ctx.quantaSinceTick >= ctx.quantaPerPeriod) {
        kernelTick(pcmId, periodFrames);
        ctx.quantaSinceTick = 0;
      }
    };
    this.contexts.set(pcmId, ctx);
  }

  stop(pcmId: number): void {
    const ctx = this.contexts.get(pcmId);
    if (!ctx) return;
    ctx.worklet.disconnect();
    ctx.audioCtx.close();
    this.contexts.delete(pcmId);
  }
}
```

```js
// host/src/audio/wpk-audio-worklet.js — runs on the audio thread.

class WpkPcmPullProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { sab, channels } = options.processorOptions;
    this.ring = new Int16Array(sab);       // s16 interleaved
    this.ringFrames = this.ring.length / channels;
    this.channels = channels;
    this.hwPtr = 0;                        // local mirror, frames
  }

  process(inputs, outputs) {
    const out = outputs[0];                // out[channel][sample]
    const frames = out[0].length;          // always 128
    const ringFrames = this.ringFrames;
    const ch = this.channels;
    const ring = this.ring;
    let hw = this.hwPtr;
    for (let f = 0; f < frames; f++) {
      const ringOff = ((hw + f) % ringFrames) * ch;
      for (let c = 0; c < ch; c++) {
        // s16 → f32 conversion for the WebAudio output bus.
        out[c][f] = ring[ringOff + c] / 0x8000;
      }
    }
    hw = (hw + frames) % ringFrames;
    this.hwPtr = hw;
    this.port.postMessage({ framesConsumed: frames });
    return true;
  }
}

registerProcessor('wpk-pcm-pull', WpkPcmPullProcessor);
```

**Vitest:** unit-test `BrowserAudioDriver` start/stop with a mocked
AudioContext (jsdom + a stub `AudioContext` class); assert that
`worklet.port.onmessage` accumulates quanta and fires `kernelTick`
once per period.

**Commit:** `host(audio): BrowserAudioDriver — AudioContext + AudioWorklet + SAB ring`

---

### Task B3: `NodeAudioDriver` — setInterval dummy

**Files:**
- Create: `host/src/audio/node-audio-driver.ts`.

```ts
// host/src/audio/node-audio-driver.ts

import type { AudioDriver } from './audio-driver';

interface PcmTimer {
  intervalHandle: NodeJS.Timeout;
  periodFrames: number;
}

export class NodeAudioDriver implements AudioDriver {
  private timers = new Map<number, PcmTimer>();
  private sabs = new Map<number, SharedArrayBuffer>();

  constructor() {
    this.sabs.set(0, new SharedArrayBuffer(64 * 1024));
  }

  getSab(pcmId: number): SharedArrayBuffer { return this.sabs.get(pcmId)!; }

  async start(pcmId: number, sampleRate: number, channels: number,
              periodFrames: number,
              kernelTick: (pcmId: number, frames: number) => void)
  {
    // Period interval in ms; matches design §8.3's dummy.
    const intervalMs = (periodFrames * 1000) / sampleRate;
    // For tests: optionally compute a checksum over the consumed
    // frames. Skipped here; the test harness reads the SAB directly.
    const handle = setInterval(() => kernelTick(pcmId, periodFrames),
                                intervalMs);
    this.timers.set(pcmId, { intervalHandle: handle,
                              periodFrames });
  }

  stop(pcmId: number): void {
    const t = this.timers.get(pcmId);
    if (t) { clearInterval(t.intervalHandle); this.timers.delete(pcmId); }
  }
}
```

**Vitest:** `start` schedules an interval; mock `setInterval` +
verify `kernelTick` fires once per `periodFrames / sampleRate` ms
period.

**Commit:** `host(audio): NodeAudioDriver — setInterval dummy for headless tests`

---

### Task B4: Wire `kernel_audio_init_sab` + `kernel_audio_period_tick` + dual-host parity

**Files:**
- Modify: `examples/browser/lib/browser-kernel.ts` — instantiate
  `BrowserAudioDriver()` at boot, register SAB at kernel boot via
  `kernel.exports.kernel_audio_init_sab(0, sab.byteOffset,
  sab.byteLength)` (the SAB is shared into the kernel-worker's
  address space via the existing memory-import path).
- Modify: `host/src/node-kernel-host.ts` — instantiate
  `NodeAudioDriver()` symmetrically.
- Both: hook the host's STATUS-poll loop to call `driver.start()`
  when a pcm transitions to RUNNING, `driver.stop()` on
  DROP / PAUSE / closed.

The pcm state-tracking shape (one of the open architecture items
below; see Pre-impl review): the host could either:
(a) poll `kernel.exports.kernel_audio_get_state(pcm_id) -> u32` on
    a coarse interval (~10 ms);
(b) the kernel notifies via a tiny `host_audio_state_changed(pcm_id,
    state)` import (but this breaks the "no host imports" rule plan 5
    set);
(c) the host driver starts unconditionally on `kernel_audio_init_sab`
    and lets the AudioWorklet pull zeros until the user fills the
    SAB (works because the SAB starts zeroed and the worklet emits
    silence — no audible pop on transition).

**Lean: (c)** — start the AudioWorklet at boot, pull continuously,
emit silence until the user fills the ring. State transitions are
internal kernel concerns; the host just streams whatever's in the
SAB. The kernel's hw_ptr advancement happens via period_tick
regardless of state (because that's what tells alsa-lib "the device
is consuming"); we add a guard at A6 that ticks on non-RUNNING
states are no-ops, so the appl_ptr-relative timing stays correct.

Dual-host parity (CLAUDE.md): symmetry check — both kernel-worker
entries (Node + browser):
1. instantiate an `AudioDriver` (Node = setInterval, browser =
   AudioWorklet);
2. call `kernel.exports.kernel_audio_init_sab(0, sab.byteOffset,
   sab.byteLength)`;
3. call `driver.start(0, 48000, 2, 1024, kernel.exports.
   kernel_audio_period_tick)` once HW_PARAMS-ready signal lands
   (via lean (c) above: start immediately at boot with default
   params; HW_PARAMS just adjusts the kernel-side bookkeeping).

**Vitest:** run the Node init path; assert `kernel.exports.
kernel_audio_init_sab` was invoked exactly once at boot with the
correct (base, len); assert `NodeAudioDriver.start` was scheduled;
assert `kernel_audio_period_tick` fires at the expected interval
(use vi.useFakeTimers). Browser path tested in Playwright at
Phase C.

**Commit:** `host(audio): wire kernel_audio_init_sab + kernel_audio_period_tick + dual-host boot path`

---

### Task B5: Vitest — end-to-end PCM open + HW_PARAMS + WRITEI + tick + drain

**Files:**
- Create: `host/test/audio-alsa.spec.ts`.

Setup (driven via the Node host + NodeAudioDriver):

- Open `/dev/snd/pcmC0D0p`. Assert PVERSION returns `0x000d_0000`.
- INFO → stream=PLAYBACK, card=0, device=0.
- HW_REFINE on a wildcard request → returns S16_LE-only, 2-channel,
  48 kHz, period=1024, buffer=4096.
- HW_PARAMS the refined request → state = SETUP.
- mmap `MMAP_OFFSET_STATUS` → 64-byte page, `state == SETUP`,
  `hw_ptr == 0`.
- mmap `MMAP_OFFSET_CONTROL` → 64-byte page, `appl_ptr == 0`.
- mmap `MMAP_OFFSET_DATA` → 64 KiB SAB region; assert writability.
- PREPARE → state = PREPARED.
- START → state = RUNNING.
- WRITEI_FRAMES, 1024 frames of a 440 Hz sine wave; assert
  `result == 1024`, `appl_ptr == 1024`.
- Drive 8 fake period ticks (via `vi.advanceTimersByTime` +
  manual `kernel.exports.kernel_audio_period_tick(0, 1024)`); assert
  `hw_ptr == 8 * 1024`, state still RUNNING.
- DROP → state = SETUP.
- Reopen with `pcmC0D0c` (capture) → ENODEV (v1 doesn't ship
  capture).
- Open `controlC0`; CARD_INFO → name = "wpk-virtual".

**Commit:** `host(audio): vitest — end-to-end PCM lifecycle + WRITEI + period tick`

---

### Task B6: Phase B — full gauntlet + open PR #2

Push, open draft PR.

Title: `[explore-dri] host(audio): AudioDriver (browser AudioWorklet, Node dummy) + SAB ring bridge`

Body: Summary / Why / Verification / **Dual-host parity proof** (both
Node and browser kernel-worker entries instantiate an `AudioDriver`,
register the SAB via `kernel_audio_init_sab`, and route tick events
into `kernel_audio_period_tick`; symmetry verified before commit) /
Notes.

---

## Phase C — sysroot + demo + browser (PR #3)

### Task C1: Sysroot audio headers — vendor `sound/asound.h`

**Files:**
- Vendor: `musl-overlay/include/sound/asound.h` (subset).

musl does not ship `<sound/asound.h>` upstream — it's a Linux UAPI
header packaged as `linux-headers-${VER}`. Vendor the subset we
need into `musl-overlay/include/sound/asound.h`:

```c
// musl-overlay/include/sound/asound.h (minimal subset)
#include <linux/ioctl.h>
#include <sys/time.h>
#include <stdint.h>

typedef uint64_t snd_pcm_uframes_t;
typedef int64_t  snd_pcm_sframes_t;

#define SNDRV_PCM_STATE_OPEN     0
#define SNDRV_PCM_STATE_SETUP    1
#define SNDRV_PCM_STATE_PREPARED 2
#define SNDRV_PCM_STATE_RUNNING  3
#define SNDRV_PCM_STATE_XRUN     4
#define SNDRV_PCM_STATE_PAUSED   6

#define SNDRV_PCM_FORMAT_S16_LE   2
#define SNDRV_PCM_FORMAT_S32_LE  10
#define SNDRV_PCM_FORMAT_FLOAT_LE 14

#define SNDRV_PCM_ACCESS_MMAP_INTERLEAVED 0
#define SNDRV_PCM_ACCESS_RW_INTERLEAVED   3

#define SNDRV_PCM_STREAM_PLAYBACK 0
#define SNDRV_PCM_STREAM_CAPTURE  1

#define SNDRV_PCM_MMAP_OFFSET_DATA    0x00000000UL
#define SNDRV_PCM_MMAP_OFFSET_STATUS  0x80000000UL
#define SNDRV_PCM_MMAP_OFFSET_CONTROL 0x81000000UL

struct snd_pcm_mmap_status {
    uint32_t state;
    uint32_t pad1;
    int64_t  hw_ptr;
    int64_t  tstamp_sec;
    int64_t  tstamp_nsec;
    uint32_t suspended_state;
    uint32_t audio_tstamp_data;
    int64_t  audio_tstamp_sec;
    int64_t  audio_tstamp_nsec;
};

struct snd_pcm_mmap_control {
    int64_t appl_ptr;
    int64_t avail_min;
    char    _reserved[48];
};

struct snd_xferi {
    int64_t result;
    uint64_t buf;
    uint64_t frames;
};

struct snd_pcm_hw_params {
    // … as kernel-side (~596 bytes); copy verbatim from kernel
    // include/uapi/sound/asound.h v6.10.
};

#define SNDRV_PCM_IOCTL_PVERSION       _IOR('A', 0x00, int)
#define SNDRV_PCM_IOCTL_INFO           _IOR('A', 0x01, struct snd_pcm_info)
#define SNDRV_PCM_IOCTL_HW_REFINE      _IOWR('A', 0x10, struct snd_pcm_hw_params)
#define SNDRV_PCM_IOCTL_HW_PARAMS      _IOWR('A', 0x11, struct snd_pcm_hw_params)
#define SNDRV_PCM_IOCTL_HW_FREE        _IO('A', 0x12)
#define SNDRV_PCM_IOCTL_SW_PARAMS      _IOWR('A', 0x13, struct snd_pcm_sw_params)
#define SNDRV_PCM_IOCTL_STATUS         _IOR('A', 0x20, struct snd_pcm_status)
#define SNDRV_PCM_IOCTL_PREPARE        _IO('A', 0x40)
#define SNDRV_PCM_IOCTL_START          _IO('A', 0x42)
#define SNDRV_PCM_IOCTL_DROP           _IO('A', 0x43)
#define SNDRV_PCM_IOCTL_PAUSE          _IOW('A', 0x45, int)
#define SNDRV_PCM_IOCTL_WRITEI_FRAMES  _IOW('A', 0x50, struct snd_xferi)

#define SNDRV_CTL_IOCTL_PVERSION       _IOR('U', 0x00, int)
#define SNDRV_CTL_IOCTL_CARD_INFO      _IOR('U', 0x01, struct snd_ctl_card_info)
#define SNDRV_CTL_IOCTL_ELEM_LIST      _IOWR('U', 0x10, struct snd_ctl_elem_list)
```

**Verification:** `wasm32posix-cc -c programs/alsa_demo.c` compiles
without missing-include errors; `sizeof(struct snd_pcm_hw_params) ==
596` etc. (kernel-side static-asserts already cover; the userspace
side gets one `_Static_assert` in `alsa_demo.c`).

**Commit:** `sysroot(audio): vendor sound/asound.h subset`

---

### Task C2: `programs/alsa_demo.c` — sine-wave playback demo

**Files:**
- Create: `programs/alsa_demo.c`.

```c
// programs/alsa_demo.c — ~150 LoC
// Opens /dev/snd/pcmC0D0p, HW_PARAMS for S16_LE 48 kHz stereo, mmap
// the SAB data page, fill 2 s of a 440 Hz sine wave, START + drain,
// exit 0.

#define _GNU_SOURCE
#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <sound/asound.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

_Static_assert(sizeof(struct snd_pcm_mmap_status) == 64,
    "mmap_status must be 64 bytes on wasm32");

#define RATE          48000
#define CHANNELS      2
#define PERIOD_FRAMES 1024
#define BUFFER_FRAMES 4096
#define DURATION_S    2

int main(void) {
    int fd = open("/dev/snd/pcmC0D0p", O_RDWR | O_CLOEXEC);
    if (fd < 0) { perror("open"); return 1; }

    int version;
    ioctl(fd, SNDRV_PCM_IOCTL_PVERSION, &version);
    printf("alsa version: 0x%08x\n", version);

    struct snd_pcm_hw_params hw = {0};
    // … fill hw with wildcard, then HW_REFINE narrows to v1 caps …
    ioctl(fd, SNDRV_PCM_IOCTL_HW_REFINE, &hw);
    // … set format=S16_LE, channels=2, rate=48000,
    //    period_size=1024, buffer_size=4096 in hw masks/intervals …
    if (ioctl(fd, SNDRV_PCM_IOCTL_HW_PARAMS, &hw) < 0) {
        perror("HW_PARAMS"); return 1;
    }

    // mmap the three pages.
    void *status_p = mmap(NULL, 4096, PROT_READ, MAP_SHARED, fd,
                          SNDRV_PCM_MMAP_OFFSET_STATUS);
    void *ctl_p = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED,
                       fd, SNDRV_PCM_MMAP_OFFSET_CONTROL);
    int16_t *ring = mmap(NULL, BUFFER_FRAMES * CHANNELS * 2,
                          PROT_READ | PROT_WRITE, MAP_SHARED, fd,
                          SNDRV_PCM_MMAP_OFFSET_DATA);
    struct snd_pcm_mmap_status *status = status_p;
    struct snd_pcm_mmap_control *ctl = ctl_p;

    ioctl(fd, SNDRV_PCM_IOCTL_PREPARE, NULL);

    // Fill the first period with sine before START.
    double phase = 0.0;
    const double freq_step = 2.0 * 3.14159265 * 440.0 / RATE;
    int16_t amp = 8000;  // ~25% of full-scale
    for (int f = 0; f < BUFFER_FRAMES; f++) {
        int16_t s = (int16_t)(sin(phase) * amp);
        ring[f * CHANNELS + 0] = s;
        ring[f * CHANNELS + 1] = s;
        phase += freq_step;
    }
    ctl->appl_ptr = BUFFER_FRAMES;

    ioctl(fd, SNDRV_PCM_IOCTL_START, NULL);

    // Producer loop: refill the ring as hw_ptr advances. 2 s total.
    int total_frames = RATE * DURATION_S;
    int produced = BUFFER_FRAMES;
    while (produced < total_frames) {
        // Wait for space.
        struct pollfd pfd = { .fd = fd, .events = POLLOUT };
        poll(&pfd, 1, 100);
        // Refill up to one period.
        int64_t hw_ptr = status->hw_ptr;
        int64_t appl = ctl->appl_ptr;
        int avail = BUFFER_FRAMES - (int)(appl - hw_ptr);
        int to_write = avail < PERIOD_FRAMES ? avail : PERIOD_FRAMES;
        for (int f = 0; f < to_write; f++) {
            int16_t s = (int16_t)(sin(phase) * amp);
            int ring_off = ((int)(appl + f) % BUFFER_FRAMES) * CHANNELS;
            ring[ring_off + 0] = s;
            ring[ring_off + 1] = s;
            phase += freq_step;
        }
        ctl->appl_ptr = appl + to_write;
        produced += to_write;
    }

    // Drain — wait until hw_ptr catches up.
    while (status->hw_ptr < ctl->appl_ptr) {
        struct pollfd pfd = { .fd = fd, .events = POLLOUT };
        poll(&pfd, 1, 50);
    }

    ioctl(fd, SNDRV_PCM_IOCTL_DROP, NULL);
    close(fd);
    return 0;
}
```

Build via `wasm32posix-cc -o programs/alsa_demo.wasm
programs/alsa_demo.c -lm`. Wire into `scripts/build-programs.sh`.

**Commit:** `examples(audio): alsa_demo — 2 s 440 Hz sine wave playback`

---

### Task C3: Vitest end-to-end

**Files:**
- Create: `host/test/audio-alsa-demo.spec.ts`.

Runs `alsa_demo.wasm` under the centralised kernel with
`NodeAudioDriver`; asserts:
- the demo exits 0 within 3 s;
- the SAB ring contains non-silent samples (sum of absolute values
  is above a sanity threshold);
- `hw_ptr` advanced by exactly `RATE * DURATION_S = 96000` frames
  (no underrun);
- the PCM state at exit is SETUP (post-DROP).

**Commit:** `host(audio): vitest — alsa_demo end-to-end`

---

### Task C4: Manual browser verification (the gate)

CLAUDE.md item 6. Build the demo, wire into `examples/browser/pages/
alsa/`. Click the "Play sine" button — the browser prompts for audio
permission (autoplay policy), grants, and a 440 Hz tone plays for
2 s. No crackle, no underruns visible in the console log
(`kernel_audio_period_tick` should fire at ~46 Hz steady).

If the tone is silent but the console shows ticks, the SAB
registration step is wrong (check `kernel_audio_init_sab` got the
right base pointer). If the tone is wrong frequency or crackly, the
worklet's `process()` is reading the ring wrong (check `hwPtr`
modulo arithmetic in the worklet).

**No commit yet for this task — verification only.** If the browser
demo fails but Node + Vitest passes, that's a host-parity bug — PR
#410 cautionary tale (CLAUDE.md "Two hosts" rules).

---

### Task C5: Phase C — final gauntlet + open PR #3

PR title: `[explore-dri] examples(audio): alsa_demo + browser spec`

Body: Summary / Why / Verification (gauntlet + browser screenshot of
the demo page after the 2 s sine wave played) / Dual-host parity
proof / Notes.

---

## Final coordinated merge

When all three PRs (kernel, host, examples) are reviewed and approved,
and Brandon has signed off on the demo running cleanly in browser +
Node:

1. Re-run the full gauntlet on each PR's branch tip.
2. Squash-merge PR #1 → PR #2's base.
3. Squash-merge PR #2 → PR #3's base.
4. Squash-merge PR #3 → plan 5's `…-evdev-demo` (or wherever plan 5's
   tip lives at the time).
5. Tag: `[explore-dri-alsa] milestone (audio) merged at <sha>` in
   the next session-handoff doc.

**Do not push to upstream until v1 + plans 2–6 are all merged
upstream as a coherent chain.**

---

## Trade-offs already locked in (don't relitigate during implementation)

- **Two devices only — `controlC0` (mixer) and `pcmC0D0p` (playback).**
  No capture (`pcmC0D0c`), no timer (`/dev/snd/timer`), no sequencer
  (`/dev/snd/seq`). SDL2's audio probe needs control + at least one
  playback pcm; libasound tolerates missing timer/seq. Capture is
  post-v1 (requires browser MediaStream + audio permission flow,
  neither of which the v1 design budgets).
- **`SNDRV_PCM_FORMAT_S16_LE` only.** HW_REFINE clamps. SDL2 + most
  apps default to S16_LE; FLOAT_LE / S32_LE are deferred to v2 when
  the AudioWorklet can do format conversion (or the kernel does).
  Single-format keeps the data-path branch-free.
- **Single substream, single card, single device.** No `pcmC0D1*`,
  no `controlC1`. Multi-card is post-v1.
- **Period tick driven by the host (AudioWorklet quantum-accumulator
  / setInterval).** The kernel has no internal periodic timer; it
  learns "period happened" via the `kernel_audio_period_tick`
  export. Same shape as plan 4's `kernel_vblank`.
- **PCM data ring is SAB-backed, host-allocated.** The host owns
  the SharedArrayBuffer; the kernel imports a view into its linear
  memory via `kernel_audio_init_sab`. userspace `mmap(pcm_fd, ...,
  OFFSET_DATA)` returns the same memory — zero-copy data path. The
  AudioWorklet pulls from the SAB on the audio thread directly.
- **mmap status + control pages are kernel-resident.** Kernel
  allocates them in its heap on first mmap call; the mmap-VPN
  infrastructure maps them into the user via the existing
  shared-anon path. Separate from the DATA page because the
  status/control pages need to be writable by the kernel
  (`hw_ptr`) and the host (`appl_ptr`) is the userspace, not the
  host JS.
- **`CLOCK_MONOTONIC` timestamps** (design §16 q6). Same source as
  plan 4 / plan 5. No `SNDRV_PCM_IOCTL_TTSTAMP` (clock-source
  selection); fixed MONOTONIC sidesteps Y2K38 / DST / NTP-skew
  footguns and keeps the three event streams comparable.
- **No host imports** (mirror of plan 5's asymmetry). The kernel's
  only host-direction signal is the `kernel_audio_period_tick`
  export the host calls. Data flows through the SAB without crossing
  the kernel-host JS boundary on the hot path. Plan 9's compositor
  may add a `host_audio_master_change` import for volume / mute
  surfacing, but v1 doesn't ship the mixer surface.
- **PCM state transitions enforced.** Per the ALSA UAPI state
  machine (asound.h's `snd_pcm_state_t`): OPEN → SETUP (HW_PARAMS)
  → PREPARED (PREPARE) → RUNNING (START) → SETUP (DROP) or → PAUSED
  (PAUSE) or → XRUN (kernel-detected underrun). Test coverage at
  A3 locks the state transitions; userspace bugs that skip steps
  fail with EBADFD.
- **XRUN on hw_ptr > appl_ptr.** Kernel detects underrun
  automatically at every period tick. Userspace recovers by
  re-PREPAREing. Matches Linux semantics; SDL2's audio backend has
  the XRUN-recovery code path built in.
- **No `EVIOCSCLOCKID`-equivalent (`SNDRV_PCM_IOCTL_TTSTAMP`).**
  Clock is fixed MONOTONIC; same justification as plan 5's
  EVIOCSCLOCKID refusal.
- **Plan 6 does not join plan 4's `DriOfdState` or plan 5's
  `InputFdState`.** Audio state and DRI/input state are disjoint;
  `Option<Box<AlsaFdState>>` is a separate field on OFD parallel to
  `dri_state` + `input`. The "one box per device class" factoring
  plan 5 established holds.
- **AudioContext sample rate (browser-side) matches HW_PARAMS rate.**
  AudioContext is constructed with `{ sampleRate: 48000 }`; if the
  browser refuses (some platforms force native rate), the worklet
  does the resample. v1 hard-codes 48 kHz to avoid the resample
  path; HW_REFINE clamps rate to [48000, 48000] in v1.
- **Browser AudioContext autoplay-gate.** Most browsers require a
  user gesture before the AudioContext resumes from "suspended".
  The demo page wires a "Play" button that calls `audioCtx.resume()`
  on click; without the click, no audio plays even though the
  worklet's `process()` callback still fires (zero buffers). This
  is browser-imposed and out of scope for kernel/host code.

---

## Risk register

1. **`snd_pcm_hw_params` struct size iteration.** Linux's value is
   596 bytes on x86_64; wasm32-ilp32 alignment differs (`__u64`
   members in `snd_pcm_uframes_t`-typed fields shift offsets). First
   `cargo test` likely fails the size_of assertion; iterate via
   `cargo expand` + array-length tweaks. *Mitigation:* budget half
   a day of iteration; do not move on from A1 until all size_of
   asserts pass.
2. **AudioWorklet `process()` on the audio thread can't call Wasm
   exports.** The worklet runs in a dedicated `AudioWorkletGlobalScope`
   that has no `import.meta`, no `WebAssembly.Instance` access. We
   solve via `worklet.port.postMessage` to the main thread, which
   then calls `kernel.exports.kernel_audio_period_tick`. *Mitigation:*
   already in B2's design; the cost is one postMessage per quantum
   (~375 Hz; ~3 ms latency between consumption and tick). Document
   the latency in B2's commit body so future profiling has a
   reference.
3. **SharedArrayBuffer requires cross-origin-isolated headers.** The
   browser demo needs `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp` set in the dev
   server. v1's `./run.sh browser` already sets these for the
   WebGL demo (existing v1 plumbing); verify alsa demo inherits.
4. **AudioContext sampleRate may differ from HW_PARAMS rate.** Some
   browsers force the native rate (often 44.1 kHz on Macs, 48 kHz
   on Linux/Windows). If the host's AudioContext refuses 48 kHz,
   the worklet must resample. *Mitigation:* v1 detects sample-rate
   mismatch at `audioContext.audioWorklet.addModule` time, logs a
   warning, and the worklet does linear interpolation (good enough
   for a 440 Hz sine; not good enough for music). v2 ports a
   proper resampler.
5. **Browser autoplay policy.** AudioContext starts in "suspended"
   state until a user gesture. The demo wires a click-to-play
   button per C4. SDL2 apps that auto-init audio without a gesture
   will fail; that's the SDL2 port's problem to handle (plan 7).
6. **Kernel-side SAB import path.** The host hands the kernel-worker
   a SAB via the existing memory-import mechanism (used by plan 2's
   gbm_bo SAB sharing). The kernel sees the SAB as raw bytes at a
   specific linear-memory offset. Need to verify the existing
   mechanism cleanly handles the SAB lifetime (the kernel-worker
   must not free the import on its own; the host owns the SAB).
   *Mitigation:* B4 spike to verify the SAB-import path in a
   one-day prototype before B2 implementation; if it doesn't work,
   fall back to the kernel allocating the ring in its own heap and
   the host copying via main-thread postMessage on every quantum
   (4-8x slower, but viable).
7. **`MAP_SHARED` semantics on a kernel-resident page.** mmap of
   the status/control pages relies on the existing
   shared-anon-mmap path treating a kernel-owned `Box<T>` as a
   valid mapping source. If the helper doesn't accept that (e.g.,
   the existing path only handles host-imported SABs), we need to
   add a `MappingKind::KernelOwned` arm. *Mitigation:* A5
   verification step explicitly checks this before depending on it.

---

## What this plan doesn't cover (deferred)

- **PCM capture** (`/dev/snd/pcmC0D0c`, `_READI_FRAMES`, MediaStream
  permission flow on the browser). v2+. Requires browser audio
  capture permission which we don't budget for v1.
- **`/dev/snd/timer`** (alsa-timer subsystem). Alsa-lib gracefully
  degrades when missing. Post-v1.
- **`/dev/snd/seq`** (sequencer / MIDI). Same as timer; SDL2 and
  most apps don't touch it. Post-v1.
- **Mixer surface** (`controlC0` ELEM_WRITE / power-management).
  v1 returns an empty element list. Plan 9's wpkcompositor surfaces
  a master-volume control; that lives in user-space (the
  compositor), not the kernel.
- **Float / 24-bit / 32-bit formats.** v1 ships S16_LE only;
  HW_REFINE clamps others.
- **Multiple PCM substreams.** Single card, single device, single
  sub. Post-v1.
- **WebAudio backend's underrun signalling.** v1 detects XRUN
  kernel-side; v2's mixer surface may want to log underruns via the
  compositor.
- **SDL2 audio port** (milestone D, plan 7) — requires this plan.
- **Full alsa-lib port.** v1 issues ioctls directly; SDL2's port
  (plan 7) brings in alsa-lib + the udev / alsa-config layer.
- **mmap_buffer for the data page implementation detail.**
  Currently designed as the same SAB userspace mmaps. If the
  zero-copy SAB approach hits the risk-register #6 wall, the
  fallback is kernel-allocates-ring + host-copies-per-quantum; the
  ABI surface (mmap offsets, ioctl numbers) is unchanged.

---

End of plan.
