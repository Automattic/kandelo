# DRI Q4 — kernel-side vblank gating for PAGE_FLIP events

Follow-up to commit `5e0c15f1d kernel(dri): synchronously retire PAGE_FLIP into card0 read queue` on `explore-direct-rendering-infrastructure`.

## Status

**v1 ships.** The DRI port currently retires every queued `DRM_IOCTL_MODE_PAGE_FLIP` into the per-fd `event_ring` immediately, inside `handle_dri_card_ioctl`. The libdrm event-driven loop `drmModePageFlip → poll(drm_fd) → drmHandleEvent` therefore returns at ioctl rate (~2 kHz on a tight loop), not at monitor-refresh rate. The user-space modeset.c demo masks this with a program-level 60 Hz throttle (`clock_gettime` + `usleep`), so the demo is visually correct.

This document tracks the architectural fix that pushes the gating into the kernel so every future DRM client gets correct vblank-rate event delivery without bolting on its own throttle.

## Why it's only v1 today

The v1 retire-immediately path is at `crates/kernel/src/syscalls.rs` around the `DRM_IOCTL_MODE_PAGE_FLIP` arm of `handle_dri_card_ioctl`:

```rust
if let Some(flip) = kms_mut.pending_flips.pop() {
    let mut record = [0u8; 32];
    record[0..4].copy_from_slice(&2u32.to_le_bytes());        // DRM_EVENT_FLIP_COMPLETE
    record[4..8].copy_from_slice(&32u32.to_le_bytes());
    record[8..16].copy_from_slice(&flip.user_data.to_le_bytes());
    record[16..20].copy_from_slice(&tv_sec.to_le_bytes());
    record[20..24].copy_from_slice(&tv_usec.to_le_bytes());
    record[24..28].copy_from_slice(&sequence.to_le_bytes());
    record[28..32].copy_from_slice(&flip.crtc_id.to_le_bytes());
    kms_mut.event_ring.extend(record.iter());
}
```

The host runs a 60 Hz `setInterval(tickVblank, 1000/60)` in the kernel worker that calls `kernel_vblank()`. `kernel_vblank()` bumps a global sequence counter (used by `WAIT_VBLANK`), but does NOT drain pending flips. So the retire happens inline with the ioctl, regardless of when the host actually ticked.

## What "tightening Q4" looks like

The fix is two-sided:

1. **Kernel side.** In `handle_dri_card_ioctl`, only push the request onto `pending_flips`. Do not synthesize the `DRM_EVENT_FLIP_COMPLETE` record. Modify `dri::vblank_tick` (called from `kernel_vblank()`) to walk every open card0 fd's `KmsFdState::pending_flips`, drain each pending flip into the fd's `event_ring`, and stamp the host's monotonic time + the new global sequence into each record.

2. **Host side.** No change required — the existing `tickVblank` already calls `kernel_vblank()` once per 16.67 ms. After the kernel change, that call retires whatever flips landed since the last tick.

### Sketch of the kernel side

In `crates/kernel/src/dri/mod.rs`:

```rust
pub fn vblank_tick() -> u32 {
    let seq = VBLANK_SEQ.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
    // Walk every process's card0 fds and drain pending_flips into
    // their event_ring with the new sequence + host-clock timestamp.
    crate::process_table::with_processes(|procs| {
        for proc in procs {
            for ofd in proc.ofd_table.iter_mut() {
                let Some(state) = ofd.dri_state_mut() else { continue };
                let Some(kms) = state.kms_mut() else { continue };
                while let Some(flip) = kms.pending_flips.pop() {
                    write_event(&mut kms.event_ring, &flip, seq, host_clock());
                }
            }
        }
    });
    seq
}
```

The exact iteration shape needs a `with_processes` accessor that hands out `&mut Process` references — today's `process_table` only exposes `with_pid`. That accessor is what makes this a non-trivial change.

### Tests that change

- `host/test/dri-modeset.test.ts` — currently passes because `drmHandleEvent` returns immediately after `drmModePageFlip`. After the kernel change it needs the kernel-worker's vblank pump to be running, OR the test needs to manually call `kernel_vblank()` between flip-issue and event-read.
- `crates/kernel/src/syscalls.rs` — the existing PAGE_FLIP test that asserts the event_ring is non-empty right after the ioctl needs to become "assert pending_flips has the entry; call vblank_tick; assert event_ring has it".

## Why not block the push on this

- modeset.c works correctly today with the program-level throttle. Visual experience matches a real 60 Hz DRM client.
- Every other DRM client that lives in this repo today (`dri-modeset.c`, the smoke tests) is event-loop driven; they all naturally adapt to whatever rate the kernel retires at. No correctness bug — just CPU spend in a hot loop.
- The fix needs new `process_table` accessor surface that is its own design discussion (mutable iteration vs lock-free draining of every card0 fd's pending_flips on a tick).
- The cost of the v1 simplification is **bounded**: it only hurts programs that drive `drmModePageFlip` in a tight loop. None of them do today other than modeset.c, which throttles itself.

## Scope of the follow-up

| Area | Estimate |
|---|---|
| `process_table::with_processes` (or equivalent) accessor | small |
| `dri::vblank_tick` drain logic + per-fd event write | small |
| Move retire OUT of `handle_dri_card_ioctl` | tiny |
| Update kernel-side PAGE_FLIP test | small |
| Update `dri-modeset.test.ts` if needed | small |
| Drop the program-level throttle from modeset.c | trivial cleanup |

Total: ~1 focused session on top of `explore-direct-rendering-infrastructure`. No ABI bump (the kernel exports and channel layout are unchanged).
