//! Period-tick producer for ALSA PCM fds.
//!
//! [`tick`] is called from the `kernel_audio_period_tick` export
//! ([`crate::wasm_api`]) on every AudioWorklet quantum (browser) or
//! `setInterval` tick (Node) after the host driver pulled
//! `frames_consumed` frames from the SAB ring. It walks every open
//! `/dev/snd/pcmC0D<pcm_id>p` OFD whose state is `STATE_RUNNING`;
//! advances `mmap_status.hw_ptr` by `frames_consumed`; stamps
//! `tstamp_sec` / `tstamp_nsec`; detects XRUN (`hw_ptr > appl_ptr`);
//! and wakes POLLOUT waiters via [`super::wait::wake_pollout`].
//!
//! Lock order — mirrors [`crate::dri::drain_pending_flips`]: hold the
//! process-table briefly to walk OFDs + advance state, collect
//! wake-target idxs into a local `Vec`, drop the lock, then drive
//! [`super::wait::wake_pollout`] outside the lock so the wake path
//! never re-enters under the table guard.
//!
//! The kernel-side `Box<WpkAlsaPcmMmapStatus>` on each OFD is the
//! source of truth for `hw_ptr` / `state`; user-page mirroring is a
//! Phase B host-bridge concern (see the ALSA plan §"Architecturally
//! load-bearing decisions").

use alloc::vec::Vec;

use wasm_posix_shared::audio::{SNDRV_PCM_STATE_RUNNING, SNDRV_PCM_STATE_XRUN};

use crate::audio::wait;

/// Advance `hw_ptr` by `frames_consumed` on every RUNNING OFD bound
/// to `pcm_id`, stamp the monotonic timestamp, detect XRUN, then
/// wake POLLOUT waiters.
///
/// `tv_sec` / `tv_nsec` are supplied by the caller so this function
/// stays testable without a `HostIO`; the `kernel_audio_period_tick`
/// export fetches them once via `WasmHostIO::host_clock_gettime` and
/// passes them down.
/// Read the current `mmap_control.appl_ptr` for any OFD bound to
/// `pcm_id` (max across matches; in practice ≤1 writer per PCM).
/// Backs [`crate::wasm_api::kernel_audio_get_appl_ptr`] — the host's
/// browser audio driver forwards this into the AudioWorklet so the
/// worklet can gate `hwPtr` advance on producer progress (silence
/// past `appl_ptr`). Returns 0 when no OFD is bound.
pub fn current_appl_ptr(pcm_id: u32) -> i64 {
    let mut result: u32 = 0;
    crate::process_table::with_processes(|procs| {
        for proc in procs {
            for (_idx, ofd) in proc.ofd_table.iter_mut() {
                let Some(audio) = ofd.audio_mut() else { continue };
                if audio.pcm_id != pcm_id {
                    continue;
                }
                if let Some(ctl) = audio.mmap_control.as_ref() {
                    if ctl.appl_ptr > result {
                        result = ctl.appl_ptr;
                    }
                }
            }
        }
    });
    result as i64
}

/// Read the current `mmap_status.hw_ptr` for any OFD bound to `pcm_id`
/// (max across matches). Backs
/// [`crate::wasm_api::kernel_audio_get_hw_ptr`] — a read-only probe
/// used by host-side instrumentation to confirm the period tick is
/// advancing `hw_ptr` in lockstep with producer progress. Returns 0
/// when no OFD is bound.
pub fn current_hw_ptr(pcm_id: u32) -> i64 {
    let mut result: u32 = 0;
    crate::process_table::with_processes(|procs| {
        for proc in procs {
            for (_idx, ofd) in proc.ofd_table.iter_mut() {
                let Some(audio) = ofd.audio_mut() else { continue };
                if audio.pcm_id != pcm_id {
                    continue;
                }
                if let Some(status) = audio.mmap_status.as_ref() {
                    if status.hw_ptr > result {
                        result = status.hw_ptr;
                    }
                }
            }
        }
    });
    result as i64
}

/// Read the current `state` (SNDRV_PCM_STATE_*) for any OFD bound to
/// `pcm_id` (first match wins). Backs
/// [`crate::wasm_api::kernel_audio_get_state`] — host-side
/// instrumentation watches for the PREPARED → RUNNING → XRUN
/// transition to diagnose mid-playback feedback-loop breakdowns.
/// Returns `SNDRV_PCM_STATE_OPEN` (0) when no OFD is bound.
pub fn current_state(pcm_id: u32) -> u32 {
    let mut result: u32 = wasm_posix_shared::audio::SNDRV_PCM_STATE_OPEN;
    let mut found = false;
    crate::process_table::with_processes(|procs| {
        for proc in procs {
            for (_idx, ofd) in proc.ofd_table.iter_mut() {
                let Some(audio) = ofd.audio_mut() else { continue };
                if audio.pcm_id != pcm_id {
                    continue;
                }
                if !found {
                    result = audio.state;
                    found = true;
                }
            }
        }
    });
    result
}

pub fn tick(pcm_id: u32, frames_consumed: u32, tv_sec: i64, tv_nsec: i64) {
    let mut woken: Vec<usize> = Vec::new();
    crate::process_table::with_processes(|procs| {
        for proc in procs {
            for (idx, ofd) in proc.ofd_table.iter_mut() {
                let Some(audio) = ofd.audio_mut() else { continue };
                if audio.pcm_id != pcm_id {
                    continue;
                }
                if audio.state != SNDRV_PCM_STATE_RUNNING {
                    continue;
                }
                if let Some(status) = audio.mmap_status.as_mut() {
                    status.hw_ptr = status.hw_ptr.wrapping_add(frames_consumed);
                    status.tstamp_sec = tv_sec;
                    status.tstamp_nsec = tv_nsec as i32;
                    let new_hw_ptr = status.hw_ptr;
                    // `status` borrow ends here so `audio.mmap_control`
                    // and `audio.state` can be touched mutably.
                    let appl = audio
                        .mmap_control
                        .as_ref()
                        .map(|c| c.appl_ptr)
                        .unwrap_or(0);
                    if new_hw_ptr > appl {
                        audio.state = SNDRV_PCM_STATE_XRUN;
                        if let Some(s) = audio.mmap_status.as_mut() {
                            s.state = SNDRV_PCM_STATE_XRUN;
                        }
                    }
                }
                woken.push(idx);
            }
        }
    });
    for ofd_idx in woken {
        wait::wake_pollout(ofd_idx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::wait::{drain_wake_count, reset as reset_wakes, TEST_WAKE_LOCK};
    use crate::ofd::{AlsaFdState, FileType, PcmDir};
    use crate::process::Process;
    use crate::process_table::GLOBAL_PROCESS_TABLE as PROCESS_TABLE;
    use crate::syscalls::VirtualDevice;
    use alloc::boxed::Box;
    use wasm_posix_shared::audio::{
        SNDRV_PCM_STATE_PREPARED, WpkAlsaPcmMmapControl, WpkAlsaPcmMmapStatus,
    };
    use wasm_posix_shared::flags::O_WRONLY;

    fn install_process(pid: u32) -> &'static mut Process {
        let table = unsafe { &mut *PROCESS_TABLE.0.get() };
        let _ = table.create_process(pid);
        let proc = table.processes.get_mut(&pid).unwrap();
        unsafe { &mut *(proc as *mut Process) }
    }

    fn remove_process(pid: u32) {
        let table = unsafe { &mut *PROCESS_TABLE.0.get() };
        table.processes.remove(&pid);
    }

    fn install_pcm(proc: &mut Process, pcm_id: u32, state: u32) -> usize {
        let host_handle = VirtualDevice::AlsaPcm {
            card: 0,
            device: pcm_id as u8,
            sub: 0,
            kind: PcmDir::Playback,
        }
        .host_handle();
        let idx = proc.ofd_table.create(
            FileType::CharDevice,
            O_WRONLY,
            host_handle,
            b"/dev/snd/pcmC0D0p".to_vec(),
        );
        let ofd = proc.ofd_table.get_mut(idx).unwrap();
        ofd.audio = Some(Box::new(AlsaFdState {
            pcm_id,
            state,
            mmap_status: Some(Box::new(WpkAlsaPcmMmapStatus::default())),
            // Large appl_ptr so the default-init hw_ptr advance does
            // not trip XRUN unless a test rewrites the pointers.
            mmap_control: Some(Box::new(WpkAlsaPcmMmapControl {
                appl_ptr: 1_000_000_000,
                ..WpkAlsaPcmMmapControl::default()
            })),
            ..AlsaFdState::default()
        }));
        idx
    }

    fn fresh() -> std::sync::MutexGuard<'static, ()> {
        let g = TEST_WAKE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_wakes();
        g
    }

    #[test]
    fn tick_advances_hw_ptr_by_frames_consumed() {
        let _g = fresh();
        let proc = install_process(8001);
        let idx = install_pcm(proc, 0, SNDRV_PCM_STATE_RUNNING);

        tick(0, 256, 12_345, 678_901_234);

        let audio = proc.ofd_table.get(idx).unwrap().audio().unwrap();
        let status = audio.mmap_status.as_ref().unwrap();
        assert_eq!(status.hw_ptr, 256);
        assert_eq!(status.tstamp_sec, 12_345);
        assert_eq!(status.tstamp_nsec, 678_901_234);
        assert_eq!(audio.state, SNDRV_PCM_STATE_RUNNING);
        remove_process(8001);
    }

    #[test]
    fn tick_on_non_running_pcm_is_a_noop() {
        let _g = fresh();
        let proc = install_process(8002);
        let idx = install_pcm(proc, 0, SNDRV_PCM_STATE_PREPARED);
        {
            let audio = proc.ofd_table.get_mut(idx).unwrap().audio_mut().unwrap();
            audio.mmap_status.as_mut().unwrap().hw_ptr = 42;
        }

        tick(0, 256, 1, 1);

        let audio = proc.ofd_table.get(idx).unwrap().audio().unwrap();
        let status = audio.mmap_status.as_ref().unwrap();
        assert_eq!(status.hw_ptr, 42, "PREPARED PCM must not advance hw_ptr");
        assert_eq!(audio.state, SNDRV_PCM_STATE_PREPARED);
        assert_eq!(
            drain_wake_count(idx),
            0,
            "non-RUNNING OFD must not wake POLLOUT"
        );
        remove_process(8002);
    }

    #[test]
    fn tick_underrun_transitions_state_to_xrun() {
        let _g = fresh();
        let proc = install_process(8003);
        let idx = install_pcm(proc, 0, SNDRV_PCM_STATE_RUNNING);
        // appl_ptr=1000, hw_ptr starts at 900 → advance by 200 →
        // 1100 > 1000 → XRUN.
        {
            let audio = proc.ofd_table.get_mut(idx).unwrap().audio_mut().unwrap();
            audio.mmap_status.as_mut().unwrap().hw_ptr = 900;
            audio.mmap_control.as_mut().unwrap().appl_ptr = 1000;
        }

        tick(0, 200, 0, 0);

        let audio = proc.ofd_table.get(idx).unwrap().audio().unwrap();
        let status = audio.mmap_status.as_ref().unwrap();
        assert_eq!(status.hw_ptr, 1100);
        assert_eq!(audio.state, SNDRV_PCM_STATE_XRUN, "OFD state must latch XRUN");
        assert_eq!(
            status.state, SNDRV_PCM_STATE_XRUN,
            "mmap_status.state must mirror so user-page readers see XRUN",
        );
        remove_process(8003);
    }

    #[test]
    fn tick_wakes_blocked_pollout_waiter() {
        let _g = fresh();
        let proc = install_process(8004);
        let idx = install_pcm(proc, 0, SNDRV_PCM_STATE_RUNNING);

        tick(0, 100, 0, 0);

        assert_eq!(
            drain_wake_count(idx),
            1,
            "RUNNING OFD on the ticked pcm_id must wake POLLOUT exactly once",
        );
        remove_process(8004);
    }

    #[test]
    fn tick_skips_ofds_on_a_different_pcm_id() {
        let _g = fresh();
        let proc = install_process(8005);
        let idx_zero = install_pcm(proc, 0, SNDRV_PCM_STATE_RUNNING);
        let idx_one = install_pcm(proc, 1, SNDRV_PCM_STATE_RUNNING);

        tick(0, 256, 0, 0);

        let zero = proc.ofd_table.get(idx_zero).unwrap().audio().unwrap();
        let one = proc.ofd_table.get(idx_one).unwrap().audio().unwrap();
        assert_eq!(zero.mmap_status.as_ref().unwrap().hw_ptr, 256);
        assert_eq!(
            one.mmap_status.as_ref().unwrap().hw_ptr, 0,
            "tick on pcm_id=0 must not touch pcm_id=1",
        );
        assert_eq!(drain_wake_count(idx_zero), 1);
        assert_eq!(drain_wake_count(idx_one), 0);
        remove_process(8005);
    }
}
