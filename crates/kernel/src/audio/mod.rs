//! Audio subsystems.
//!
//! - [`oss`] implements the legacy `/dev/dsp` single-owner PCM sink
//!   (OSS-style `ioctl`s + raw S16-LE writes; drained by the host via
//!   `kernel_drain_audio`). Existing call sites reach OSS symbols
//!   directly through `crate::audio::*` via the re-export below.
//! - ALSA modules (`pcm_ioctl`, `sab`, `mmap`, `tick`, `wait`) serve
//!   `/dev/snd/pcmC0D<n>p`. `/dev/snd/controlC0` opens succeed via the
//!   devfs node (so libasound's first probe doesn't crash), but no
//!   ioctl dispatch lives here — espeak-ng/pcaudiolib never touches
//!   the control surface, so a dedicated path would be code without
//!   a caller.

pub mod mmap;
pub mod oss;
pub mod pcm_ioctl;
pub mod sab;
pub mod tick;
pub mod wait;

pub(crate) use oss::*;
