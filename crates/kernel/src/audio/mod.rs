//! Audio subsystems.
//!
//! - [`oss`] implements the legacy `/dev/dsp` single-owner PCM sink
//!   (OSS-style `ioctl`s + raw S16-LE writes; drained by the host via
//!   `kernel_drain_audio`). Existing call sites reach OSS symbols
//!   directly through `crate::audio::*` via the re-export below.
//! - ALSA modules (`pcm_ioctl`, `ctl_ioctl`, `sab`, `mmap`, `tick`,
//!   `wait`) serve `/dev/snd/pcmC0D<n>p` and `/dev/snd/controlC0`.
//!   `ctl_ioctl` carries the minimum surface alsa-lib's hw-plugin
//!   open path (`snd_pcm_hw_open` → `snd_ctl_hw_open`) reaches
//!   before any PCM ioctl: `SNDRV_CTL_IOCTL_PVERSION` and
//!   `SNDRV_CTL_IOCTL_PCM_PREFER_SUBDEVICE`. Espeak-ng/pcaudiolib
//!   bypassed alsa-lib so this surface had no caller previously.

pub mod ctl_ioctl;
pub mod mmap;
pub mod oss;
pub mod pcm_ioctl;
pub mod sab;
pub mod tick;
pub mod wait;

pub(crate) use oss::*;
