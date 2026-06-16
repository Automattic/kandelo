//! `/dev/snd/controlC0` ioctl handler.
//!
//! `crate::audio::mod`'s historical comment noted "no ioctl dispatch
//! lives here — espeak-ng/pcaudiolib never touches the control
//! surface". alsa-lib's `snd_pcm_hw_open`
//! (`src/pcm/pcm_hw.c:1751`) *does* touch it: it opens
//! `/dev/snd/controlC0` before opening `/dev/snd/pcmC0D0p` and
//! issues `SNDRV_CTL_IOCTL_PVERSION` immediately, then
//! `SNDRV_CTL_IOCTL_PCM_PREFER_SUBDEVICE` from
//! `snd_ctl_pcm_prefer_subdevice`. Without those two ioctls the
//! whole `snd_pcm_open("default")` path fails with `ENOTTY` before
//! any PCM ioctl runs.
//!
//! This module implements the minimum surface for the alsa-lib hw
//! plugin's open path. Everything else (CARD_INFO, ELEM_LIST,
//! SUBSCRIBE_EVENTS, …) is deliberately left unhandled — those
//! callers fall through to `ENOTTY` and degrade gracefully
//! (CARD_INFO returns "no driver" string, ELEM_LIST returns "no
//! controls", etc.); none are reached on the open path.

use wasm_posix_shared::Errno;

use crate::process::{HostIO, Process};
use crate::syscalls::VirtualDevice;

use super::pcm_ioctl::SNDRV_PROTOCOL_VERSION;

/// `SNDRV_CTL_IOCTL_PVERSION = _IOR('U', 0x00, int)`.
///
///   dir=2 (read), size=4, type=0x55, nr=0x00 → 0x80045500.
pub const SNDRV_CTL_IOCTL_PVERSION: u32 = 0x8004_5500;

/// `SNDRV_CTL_IOCTL_PCM_PREFER_SUBDEVICE = _IOW('U', 0x32, int)`.
///
///   dir=1 (write), size=4, type=0x55, nr=0x32 → 0x40045532.
///
/// alsa-lib's `snd_pcm_hw_open` always calls this immediately after
/// `snd_ctl_hw_open`. v1 has exactly one subdevice (subdevice 0 of
/// device 0 of card 0), so the "preference" is meaningless — accept
/// any value as a no-op success.
pub const SNDRV_CTL_IOCTL_PCM_PREFER_SUBDEVICE: u32 = 0x4004_5532;

/// Returns `Some(Ok(()))` / `Some(Err(_))` if `ofd_idx` is an
/// `/dev/snd/controlC0` fd and the request was handled; `None` if
/// the caller should fall through to the generic ioctl path.
pub fn handle_alsa_ctl_ioctl(
    proc: &mut Process,
    _host: &mut dyn HostIO,
    ofd_idx: usize,
    request: u32,
    buf: &mut [u8],
) -> Option<Result<(), Errno>> {
    let ofd = proc.ofd_table.get(ofd_idx)?;
    if !matches!(
        VirtualDevice::from_host_handle(ofd.host_handle),
        Some(VirtualDevice::AlsaControl { .. })
    ) {
        return None;
    }

    Some(match request {
        SNDRV_CTL_IOCTL_PVERSION => {
            if buf.len() < 4 {
                return Some(Err(Errno::EINVAL));
            }
            buf[..4].copy_from_slice(&SNDRV_PROTOCOL_VERSION.to_le_bytes());
            Ok(())
        }
        SNDRV_CTL_IOCTL_PCM_PREFER_SUBDEVICE => {
            // v1 ships one subdevice per device; any preference is a
            // no-op. alsa-lib's `snd_pcm_hw_open` re-attempts on the
            // subdevice mismatch path, but with subdevice = -1 (the
            // "any" sentinel) plus only-one-subdevice, the re-attempt
            // never fires.
            if buf.len() < 4 {
                return Some(Err(Errno::EINVAL));
            }
            Ok(())
        }
        _ => return Some(Err(Errno::ENOTTY)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::test_host::NoopHost;
    use crate::syscalls::sys_open;
    use wasm_posix_shared::flags::O_RDWR;

    #[allow(non_snake_case)]
    fn install_controlC0(proc: &mut Process) -> usize {
        let mut host = NoopHost;
        let fd =
            sys_open(proc, &mut host, b"/dev/snd/controlC0", O_RDWR, 0).expect("open controlC0");
        proc.fd_table.get(fd).expect("fd entry").ofd_ref.0
    }

    #[test]
    fn ctl_pversion_matches_pcm_pversion() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let ofd_idx = install_controlC0(&mut proc);
        let mut buf = [0u8; 4];
        let rc = handle_alsa_ctl_ioctl(
            &mut proc,
            &mut host,
            ofd_idx,
            SNDRV_CTL_IOCTL_PVERSION,
            &mut buf,
        )
        .expect("AlsaControl gate");
        rc.expect("PVERSION");
        assert_eq!(u32::from_le_bytes(buf), SNDRV_PROTOCOL_VERSION);
    }

    #[test]
    fn ctl_pcm_prefer_subdevice_is_noop_ok() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let ofd_idx = install_controlC0(&mut proc);
        let mut buf = (-1i32).to_le_bytes();
        let rc = handle_alsa_ctl_ioctl(
            &mut proc,
            &mut host,
            ofd_idx,
            SNDRV_CTL_IOCTL_PCM_PREFER_SUBDEVICE,
            &mut buf,
        )
        .expect("AlsaControl gate");
        rc.expect("PCM_PREFER_SUBDEVICE no-op");
    }

    #[test]
    fn ctl_handler_returns_none_for_non_control_fd() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        // Open the PCM fd instead of the control fd.
        let fd = sys_open(
            &mut proc,
            &mut host,
            b"/dev/snd/pcmC0D0p",
            O_RDWR,
            0,
        )
        .expect("open pcm");
        let ofd_idx = proc.fd_table.get(fd).unwrap().ofd_ref.0;
        let mut buf = [0u8; 4];
        let rc = handle_alsa_ctl_ioctl(
            &mut proc,
            &mut host,
            ofd_idx,
            SNDRV_CTL_IOCTL_PVERSION,
            &mut buf,
        );
        assert!(
            rc.is_none(),
            "non-AlsaControl fd should not be intercepted"
        );
    }

    #[test]
    fn ctl_handler_returns_enotty_for_unknown_request() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let ofd_idx = install_controlC0(&mut proc);
        let mut buf = [0u8; 4];
        let rc = handle_alsa_ctl_ioctl(
            &mut proc,
            &mut host,
            ofd_idx,
            0x8101_5501, /* SNDRV_CTL_IOCTL_CARD_INFO — unhandled in v1 */
            &mut buf,
        )
        .expect("AlsaControl gate");
        assert_eq!(rc, Err(Errno::ENOTTY));
    }
}
