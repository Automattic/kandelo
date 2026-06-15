//! `mmap()` dispatcher for `/dev/snd/pcmC0D<p>p` open file descriptions.
//!
//! alsa-lib calls `mmap(pcm_fd, ..., offset)` three times right after
//! `HW_PARAMS`, one per page:
//!
//! - [`SNDRV_PCM_MMAP_OFFSET_STATUS`] — `snd_pcm_mmap_status`:
//!   kernel-writes / userspace-reads. Lazily allocated as
//!   [`AlsaFdState::mmap_status`].
//! - [`SNDRV_PCM_MMAP_OFFSET_CONTROL`] — `snd_pcm_mmap_control`:
//!   userspace-writes / kernel-reads. Lazily allocated as
//!   [`AlsaFdState::mmap_control`].
//! - [`SNDRV_PCM_MMAP_OFFSET_DATA`] — the SAB-backed PCM ring registered
//!   via `kernel_audio_init_sab`. Returns [`Errno::ENODEV`] before the
//!   host has issued that call.
//!
//! In v1 the user-space allocation is a plain anonymous wasm-page
//! reservation: alsa-lib gets back a base pointer it can pass to its
//! mmap-based reads, and the kernel-side `Box`es / SAB hold the actual
//! state. Mirroring the kernel-side state into the user pages is host
//! work (Phase B) — A5 just sets up the lazy allocation and dispatch.

use alloc::boxed::Box;

use wasm_posix_shared::Errno;
use wasm_posix_shared::audio::{
    SNDRV_PCM_MMAP_OFFSET_CONTROL, SNDRV_PCM_MMAP_OFFSET_DATA, SNDRV_PCM_MMAP_OFFSET_STATUS,
    WpkAlsaPcmMmapControl, WpkAlsaPcmMmapStatus,
};
use wasm_posix_shared::mmap::{MAP_ANONYMOUS, MAP_FAILED};

use crate::process::Process;

/// Entry point invoked by [`crate::syscalls::sys_mmap`] when the target
/// fd has an attached [`crate::ofd::AlsaFdState`] sidecar (i.e. it was
/// opened against `/dev/snd/pcmC0D<p>p`).
pub fn handle_alsa_pcm_mmap(
    proc: &mut Process,
    ofd_idx: usize,
    addr: usize,
    len: usize,
    prot: u32,
    flags: u32,
    offset: i64,
) -> Result<usize, Errno> {
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    match offset as u64 {
        SNDRV_PCM_MMAP_OFFSET_STATUS => map_status_page(proc, ofd_idx, addr, len, prot, flags),
        SNDRV_PCM_MMAP_OFFSET_CONTROL => map_control_page(proc, ofd_idx, addr, len, prot, flags),
        SNDRV_PCM_MMAP_OFFSET_DATA => map_data_page(proc, ofd_idx, addr, len, prot, flags),
        _ => Err(Errno::EINVAL),
    }
}

fn allocate_user_pages(
    proc: &mut Process,
    addr: usize,
    len: usize,
    prot: u32,
    flags: u32,
) -> Result<usize, Errno> {
    let alloc_flags = flags | MAP_ANONYMOUS;
    let result = proc.memory.mmap_anonymous(addr, len, prot, alloc_flags);
    if result == MAP_FAILED {
        return Err(Errno::ENOMEM);
    }
    Ok(result)
}

fn map_status_page(
    proc: &mut Process,
    ofd_idx: usize,
    addr: usize,
    len: usize,
    prot: u32,
    flags: u32,
) -> Result<usize, Errno> {
    let user_addr = allocate_user_pages(proc, addr, len, prot, flags)?;
    let audio = proc
        .ofd_table
        .get_mut(ofd_idx)
        .ok_or(Errno::EBADF)?
        .audio_mut()
        .ok_or(Errno::EBADFD)?;
    if audio.mmap_status.is_none() {
        audio.mmap_status = Some(Box::new(WpkAlsaPcmMmapStatus::default()));
    }
    Ok(user_addr)
}

fn map_control_page(
    proc: &mut Process,
    ofd_idx: usize,
    addr: usize,
    len: usize,
    prot: u32,
    flags: u32,
) -> Result<usize, Errno> {
    let user_addr = allocate_user_pages(proc, addr, len, prot, flags)?;
    let audio = proc
        .ofd_table
        .get_mut(ofd_idx)
        .ok_or(Errno::EBADF)?
        .audio_mut()
        .ok_or(Errno::EBADFD)?;
    if audio.mmap_control.is_none() {
        audio.mmap_control = Some(Box::new(WpkAlsaPcmMmapControl::default()));
    }
    Ok(user_addr)
}

fn map_data_page(
    proc: &mut Process,
    ofd_idx: usize,
    addr: usize,
    len: usize,
    prot: u32,
    flags: u32,
) -> Result<usize, Errno> {
    // ENODEV before the SAB is registered. Read pcm_id off the OFD via
    // an immutable borrow so the later mmap_anonymous can re-borrow
    // proc mutably without aliasing.
    let pcm_id = proc
        .ofd_table
        .get(ofd_idx)
        .ok_or(Errno::EBADF)?
        .audio()
        .ok_or(Errno::EBADFD)?
        .pcm_id;
    if crate::audio::sab::lookup(pcm_id).is_none() {
        return Err(Errno::ENODEV);
    }
    allocate_user_pages(proc, addr, len, prot, flags)
}

// --------------------------------------------------------------------
// Tests.
// --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ofd::{AlsaFdState, FileType, PcmDir};
    use crate::process::Process;
    use crate::syscalls::VirtualDevice;

    fn install_pcm(proc: &mut Process) -> usize {
        let host_handle = VirtualDevice::AlsaPcm {
            card: 0,
            device: 0,
            sub: 0,
            kind: PcmDir::Playback,
        }
        .host_handle();
        let idx = proc.ofd_table.create(
            FileType::CharDevice,
            0,
            host_handle,
            b"/dev/snd/pcmC0D0p".to_vec(),
        );
        let ofd = proc.ofd_table.get_mut(idx).expect("created ofd");
        // Unlike the pcm_ioctl tests, leave mmap_status / mmap_control
        // unset so A5 can prove it allocates them on first mmap.
        ofd.audio = Some(Box::new(AlsaFdState {
            pcm_id: 0,
            ..AlsaFdState::default()
        }));
        idx
    }

    fn fresh_sab() -> std::sync::MutexGuard<'static, ()> {
        let g = crate::audio::sab::TEST_SAB_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        crate::audio::sab::reset_table();
        g
    }

    #[test]
    fn mmap_status_page_allocates_box_and_returns_user_addr() {
        let _g = fresh_sab();
        let mut proc = Process::new(1);
        let idx = install_pcm(&mut proc);
        let user_addr = handle_alsa_pcm_mmap(
            &mut proc,
            idx,
            0,
            0x10000,
            3, // PROT_READ | PROT_WRITE
            wasm_posix_shared::mmap::MAP_SHARED,
            SNDRV_PCM_MMAP_OFFSET_STATUS as i64,
        )
        .expect("mmap STATUS");
        assert!(user_addr >= 0x04000000, "addr {:#x} below MMAP_BASE", user_addr);
        let ofd = proc.ofd_table.get(idx).expect("ofd");
        let audio = ofd.audio().expect("audio sidecar");
        assert!(audio.mmap_status.is_some(), "STATUS box must be allocated");
        assert!(audio.mmap_control.is_none(), "CONTROL untouched by STATUS mmap");
    }

    #[test]
    fn mmap_control_page_allocates_box_and_returns_user_addr() {
        let _g = fresh_sab();
        let mut proc = Process::new(1);
        let idx = install_pcm(&mut proc);
        let user_addr = handle_alsa_pcm_mmap(
            &mut proc,
            idx,
            0,
            0x10000,
            3,
            wasm_posix_shared::mmap::MAP_SHARED,
            SNDRV_PCM_MMAP_OFFSET_CONTROL as i64,
        )
        .expect("mmap CONTROL");
        assert!(user_addr >= 0x04000000);
        let audio = proc.ofd_table.get(idx).unwrap().audio().unwrap();
        assert!(audio.mmap_control.is_some(), "CONTROL box must be allocated");
        assert!(audio.mmap_status.is_none(), "STATUS untouched by CONTROL mmap");
    }

    #[test]
    fn mmap_data_page_returns_user_addr_when_sab_registered() {
        let _g = fresh_sab();
        let mut proc = Process::new(1);
        let idx = install_pcm(&mut proc);
        // Register a (fake) SAB so DATA mmap can succeed.
        crate::audio::sab::register(
            0,
            crate::audio::sab::SabSlice {
                base: 0xdead_beef,
                len: 8192,
            },
        )
        .expect("sab register");
        let user_addr = handle_alsa_pcm_mmap(
            &mut proc,
            idx,
            0,
            0x10000,
            3,
            wasm_posix_shared::mmap::MAP_SHARED,
            SNDRV_PCM_MMAP_OFFSET_DATA as i64,
        )
        .expect("mmap DATA");
        assert!(user_addr >= 0x04000000);
    }

    #[test]
    fn mmap_data_page_before_init_sab_returns_enodev() {
        let _g = fresh_sab();
        let mut proc = Process::new(1);
        let idx = install_pcm(&mut proc);
        let err = handle_alsa_pcm_mmap(
            &mut proc,
            idx,
            0,
            0x10000,
            3,
            wasm_posix_shared::mmap::MAP_SHARED,
            SNDRV_PCM_MMAP_OFFSET_DATA as i64,
        )
        .expect_err("DATA without SAB must ENODEV");
        assert_eq!(err, Errno::ENODEV);
    }

    #[test]
    fn mmap_unknown_offset_returns_einval() {
        let _g = fresh_sab();
        let mut proc = Process::new(1);
        let idx = install_pcm(&mut proc);
        let err = handle_alsa_pcm_mmap(
            &mut proc,
            idx,
            0,
            0x10000,
            3,
            wasm_posix_shared::mmap::MAP_SHARED,
            0x4000_0000, // not STATUS / CONTROL / DATA
        )
        .expect_err("unknown offset");
        assert_eq!(err, Errno::EINVAL);
    }

    #[test]
    fn mmap_negative_offset_returns_einval() {
        let _g = fresh_sab();
        let mut proc = Process::new(1);
        let idx = install_pcm(&mut proc);
        let err = handle_alsa_pcm_mmap(&mut proc, idx, 0, 0x10000, 3, 0, -1)
            .expect_err("negative offset");
        assert_eq!(err, Errno::EINVAL);
    }

    #[test]
    fn mmap_status_is_idempotent_does_not_realloc_box() {
        let _g = fresh_sab();
        let mut proc = Process::new(1);
        let idx = install_pcm(&mut proc);
        let _ = handle_alsa_pcm_mmap(
            &mut proc,
            idx,
            0,
            0x10000,
            3,
            wasm_posix_shared::mmap::MAP_SHARED,
            SNDRV_PCM_MMAP_OFFSET_STATUS as i64,
        )
        .expect("first STATUS mmap");
        // Stash the Box pointer; the second mmap must NOT replace it.
        let ptr_before = {
            let audio = proc.ofd_table.get(idx).unwrap().audio().unwrap();
            audio.mmap_status.as_ref().unwrap().as_ref() as *const _ as usize
        };
        let _ = handle_alsa_pcm_mmap(
            &mut proc,
            idx,
            0,
            0x10000,
            3,
            wasm_posix_shared::mmap::MAP_SHARED,
            SNDRV_PCM_MMAP_OFFSET_STATUS as i64,
        )
        .expect("second STATUS mmap");
        let ptr_after = {
            let audio = proc.ofd_table.get(idx).unwrap().audio().unwrap();
            audio.mmap_status.as_ref().unwrap().as_ref() as *const _ as usize
        };
        assert_eq!(
            ptr_before, ptr_after,
            "second mmap must NOT reallocate the Box — alsa-lib expects a stable pointer",
        );
    }
}
