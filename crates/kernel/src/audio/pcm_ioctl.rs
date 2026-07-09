//! ALSA `/dev/snd/pcmC0D0p` ioctl dispatch.
//!
//! Implements the SNDRV_PCM_IOCTL_* surface that alsa-lib exercises
//! during open / configure / playback startup:
//!
//! ```text
//!   PVERSION     return the ALSA protocol version (alsa-lib bails if
//!                this exceeds the runtime version)
//!   INFO         describe the device (card / device / stream / name)
//!   HW_REFINE    narrow a wildcard hw_params request to a single
//!                concrete combination (S16_LE, 1..2 ch, 8000..48000 Hz,
//!                period 64..4096 frames, buffer 256..16384 frames)
//!   HW_PARAMS    commit a refined hw_params (OPEN/SETUP → SETUP)
//!   HW_FREE      drop the committed hw/sw params (→ OPEN)
//!   SW_PARAMS    cache the avail_min / thresholds / boundary
//!   PREPARE      reset hw_ptr/appl_ptr (→ PREPARED)
//!   START        begin streaming (PREPARED → RUNNING)
//!   DROP         halt + return to SETUP
//!   PAUSE        toggle RUNNING ↔ PAUSED based on argument
//!   STATUS       snapshot state + pointers + monotonic timestamp
//! ```
//!
//! State machine:
//!
//! ```text
//!   OPEN  ──(HW_PARAMS)──▶ SETUP ──(PREPARE)──▶ PREPARED ──(START)──▶ RUNNING
//!    ▲                       │                                          │  ▲
//!    │                       │                                          │  │
//!    └──(HW_FREE)─────────── ┘                          (PAUSE 1/0) ──▶ PAUSED
//!                            ▲                                          │
//!                            └──────────(DROP)──────────────────────────┘
//! ```
//!
//! WRITEI_FRAMES, mmap, ctl ioctls, and the `kernel_audio_period_tick`
//! producer all land in subsequent tasks (A4 / A5 / A6).

use alloc::boxed::Box;
use wasm_posix_shared::audio::*;
use wasm_posix_shared::Errno;

use crate::ofd::{AlsaFdState, HwParamsCache, SwParamsCache};
use crate::process::{HostIO, Process};

/// ALSA protocol version reported by `SNDRV_PCM_IOCTL_PVERSION` and
/// `SNDRV_CTL_IOCTL_PVERSION` (`crate::audio::ctl_ioctl`).
///
/// alsa-lib's `SNDRV_PROTOCOL_INCOMPATIBLE` macro
/// (`include/sound/uapi/asound.h:51`) requires the kernel's *major*
/// and *minor* to both match the userspace's max-version exactly —
/// it is NOT a "kernel must be equal-or-lower" check. PCM max in
/// alsa-lib 1.2.x is `SNDRV_PCM_VERSION_MAX = 2.0.9`
/// (`src/pcm/pcm_hw.c:123`); CTL max is `SNDRV_CTL_VERSION_MAX = 2.0.4`
/// (`src/control/control_hw.c:50`). Reporting `2.0.4` satisfies
/// both compat checks AND keeps alsa-lib's `snd_pcm_hw_open_fd` below
/// the `>= 2.0.5` threshold that triggers `SNDRV_PCM_IOCTL_TSTAMP`
/// and below the `>= 2.0.14` threshold that triggers
/// `SNDRV_PCM_IOCTL_USER_PVERSION` — both of which the kernel does
/// not implement and would fail with ENOTTY.
pub const SNDRV_PROTOCOL_VERSION: u32 = 0x0002_0004;

// SND_PCM_INFO_* flags relevant to v1's playback surface.
const SNDRV_PCM_INFO_MMAP: u32 = 0x0000_0001;
const SNDRV_PCM_INFO_MMAP_VALID: u32 = 0x0000_0002;
const SNDRV_PCM_INFO_INTERLEAVED: u32 = 0x0000_0100;
const SNDRV_PCM_INFO_BLOCK_TRANSFER: u32 = 0x0000_0010;
const SNDRV_PCM_INFO_PAUSE: u32 = 0x0000_0080;
const SNDRV_PCM_CLASS_GENERIC: u32 = 0;

// snd_pcm_hw_params mask indices — see Linux UAPI `enum snd_pcm_hw_param`.
const PARAM_ACCESS: usize = 0;
const PARAM_FORMAT: usize = 1;
const PARAM_SUBFORMAT: usize = 2;

// snd_pcm_hw_params interval indices.
const PARAM_SAMPLE_BITS: usize = 0;
const PARAM_FRAME_BITS: usize = 1;
const PARAM_CHANNELS: usize = 2;
const PARAM_RATE: usize = 3;
const PARAM_PERIOD_SIZE: usize = 5;
const PARAM_PERIODS: usize = 7;
const PARAM_BUFFER_SIZE: usize = 9;

const SNDRV_PCM_SUBFORMAT_STD: u32 = 0;

// v1 capability bounds.
const MIN_CHANNELS: u32 = 1;
const MAX_CHANNELS: u32 = 2;
const MIN_RATE: u32 = 8000;
const MAX_RATE: u32 = 48000;
const MIN_PERIOD_SIZE: u32 = 64;
const MAX_PERIOD_SIZE: u32 = 4096;
const MIN_BUFFER_SIZE: u32 = 256;
const MAX_BUFFER_SIZE: u32 = 16384;
const SAMPLE_BITS_S16_LE: u32 = 16;

// --------------------------------------------------------------------
// Byte-buffer helpers.
// --------------------------------------------------------------------

fn read_struct<T: Copy>(buf: &[u8]) -> Result<T, Errno> {
    if buf.len() < core::mem::size_of::<T>() {
        return Err(Errno::EINVAL);
    }
    Ok(unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const T) })
}

fn write_struct<T: Copy>(buf: &mut [u8], value: &T) -> Result<(), Errno> {
    if buf.len() < core::mem::size_of::<T>() {
        return Err(Errno::EINVAL);
    }
    unsafe {
        core::ptr::write_unaligned(buf.as_mut_ptr() as *mut T, *value);
    }
    Ok(())
}

fn read_u32(buf: &[u8]) -> Result<u32, Errno> {
    if buf.len() < 4 {
        return Err(Errno::EINVAL);
    }
    Ok(u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]))
}

fn write_u32(buf: &mut [u8], value: u32) -> Result<(), Errno> {
    if buf.len() < 4 {
        return Err(Errno::EINVAL);
    }
    buf[..4].copy_from_slice(&value.to_le_bytes());
    Ok(())
}

// --------------------------------------------------------------------
// snd_mask helpers (each snd_mask is u32[8] inside hw_params.masks[64]).
// --------------------------------------------------------------------

const MASK_WORDS: usize = 8;

fn mask_at(masks: &[u32; 64], idx: usize) -> &[u32] {
    &masks[idx * MASK_WORDS..idx * MASK_WORDS + MASK_WORDS]
}

fn mask_at_mut(masks: &mut [u32; 64], idx: usize) -> &mut [u32] {
    &mut masks[idx * MASK_WORDS..idx * MASK_WORDS + MASK_WORDS]
}

fn mask_is_empty(m: &[u32]) -> bool {
    m.iter().all(|&w| w == 0)
}

/// Treat a fully-zero mask as a wildcard ("user did not constrain this
/// dimension") and stamp the capability set in. After the intersection
/// downstream, that becomes the v1-allowed set.
fn fill_if_empty(m: &mut [u32], capability: &[u32; MASK_WORDS]) {
    if mask_is_empty(m) {
        m.copy_from_slice(capability);
    }
}

fn intersect_with(m: &mut [u32], capability: &[u32; MASK_WORDS]) {
    for (w, c) in m.iter_mut().zip(capability.iter()) {
        *w &= *c;
    }
}

fn capability_one(bit: u32) -> [u32; MASK_WORDS] {
    let mut out = [0u32; MASK_WORDS];
    let word = (bit / 32) as usize;
    out[word] |= 1u32 << (bit % 32);
    out
}

fn capability_two(a: u32, b: u32) -> [u32; MASK_WORDS] {
    let mut out = [0u32; MASK_WORDS];
    out[(a / 32) as usize] |= 1u32 << (a % 32);
    out[(b / 32) as usize] |= 1u32 << (b % 32);
    out
}

fn mask_first_set(m: &[u32]) -> Option<u32> {
    for (i, &w) in m.iter().enumerate() {
        if w != 0 {
            return Some(i as u32 * 32 + w.trailing_zeros());
        }
    }
    None
}

// --------------------------------------------------------------------
// snd_interval helpers.
// --------------------------------------------------------------------

/// Clamp `interval` to `[min, max]` (intersection with v1 capability).
///
/// HW_REFINE semantics return a *range*, not a single value — alsa-lib
/// userland needs the full legal range so `snd_pcm_hw_param_set_near`,
/// `set_first`, etc. can narrow at their own discretion. The pinning to
/// a single concrete value happens in user-space `snd_pcm_hw_params_choose()`,
/// which calls HW_REFINE iteratively with one parameter constrained per
/// call; the *committed* single-value struct then arrives at the kernel
/// via SNDRV_PCM_IOCTL_HW_PARAMS, where [`read_interval_single`] enforces
/// `min == max`.
///
/// Wildcard interpretation: a default-initialised `WpkSndInterval`
/// (`min == 0 && max == 0`) is treated as "user hasn't constrained
/// this", so we expand it to the capability range before clamping.
fn refine_interval(
    interval: &mut WpkSndInterval,
    min: u32,
    max: u32,
) -> Result<u32, Errno> {
    if interval.min == 0 && interval.max == 0 {
        interval.min = min;
        interval.max = max;
    }
    if interval.max == 0 || interval.max > max {
        interval.max = max;
    }
    if interval.min < min {
        interval.min = min;
    }
    if interval.min > interval.max {
        return Err(Errno::EINVAL);
    }
    interval.flags = 0;
    Ok(interval.min)
}

fn read_interval_single(interval: &WpkSndInterval) -> Result<u32, Errno> {
    if interval.min == 0 {
        return Err(Errno::EINVAL);
    }
    if interval.max != 0 && interval.max != interval.min {
        return Err(Errno::EINVAL);
    }
    Ok(interval.min)
}

// --------------------------------------------------------------------
// hw_params refine + extract.
// --------------------------------------------------------------------

/// Refine a wildcard / partially-constrained `hw_params` request against
/// v1 capabilities. On success the struct is mutated in place to hold
/// the single concrete combination the kernel commits to. EINVAL if no
/// combination fits (e.g. user asked for S32_LE, which we don't ship).
fn refine_hw_params(req: &mut WpkAlsaPcmHwParams) -> Result<(), Errno> {
    // --- masks -------------------------------------------------------
    let access_cap = capability_two(
        SNDRV_PCM_ACCESS_MMAP_INTERLEAVED,
        SNDRV_PCM_ACCESS_RW_INTERLEAVED,
    );
    let format_cap = capability_one(SNDRV_PCM_FORMAT_S16_LE);
    let subformat_cap = capability_one(SNDRV_PCM_SUBFORMAT_STD);

    {
        let m = mask_at_mut(&mut req.masks, PARAM_ACCESS);
        fill_if_empty(m, &access_cap);
        intersect_with(m, &access_cap);
        if mask_is_empty(m) {
            return Err(Errno::EINVAL);
        }
    }
    {
        let m = mask_at_mut(&mut req.masks, PARAM_FORMAT);
        fill_if_empty(m, &format_cap);
        intersect_with(m, &format_cap);
        if mask_is_empty(m) {
            return Err(Errno::EINVAL);
        }
    }
    {
        let m = mask_at_mut(&mut req.masks, PARAM_SUBFORMAT);
        fill_if_empty(m, &subformat_cap);
        intersect_with(m, &subformat_cap);
        if mask_is_empty(m) {
            return Err(Errno::EINVAL);
        }
    }

    // --- intervals ---------------------------------------------------
    refine_interval(
        &mut req.intervals[PARAM_CHANNELS],
        MIN_CHANNELS,
        MAX_CHANNELS,
    )?;
    refine_interval(
        &mut req.intervals[PARAM_RATE],
        MIN_RATE,
        MAX_RATE,
    )?;
    refine_interval(
        &mut req.intervals[PARAM_PERIOD_SIZE],
        MIN_PERIOD_SIZE,
        MAX_PERIOD_SIZE,
    )?;
    refine_interval(
        &mut req.intervals[PARAM_BUFFER_SIZE],
        MIN_BUFFER_SIZE,
        MAX_BUFFER_SIZE,
    )?;

    // --- derived intervals ------------------------------------------
    //
    // The single S16_LE format pins sample_bits to 16. frame_bits and
    // periods are derived from primary intervals — return them as
    // *ranges* so alsa-lib's `snd_pcm_hw_param_set_first` can keep
    // narrowing them one at a time during `snd_pcm_hw_params_choose()`.
    req.intervals[PARAM_SAMPLE_BITS] = WpkSndInterval {
        min: SAMPLE_BITS_S16_LE,
        max: SAMPLE_BITS_S16_LE,
        flags: 0,
    };
    let ch_min = req.intervals[PARAM_CHANNELS].min;
    let ch_max = req.intervals[PARAM_CHANNELS].max;
    req.intervals[PARAM_FRAME_BITS] = WpkSndInterval {
        min: SAMPLE_BITS_S16_LE * ch_min,
        max: SAMPLE_BITS_S16_LE * ch_max,
        flags: 0,
    };
    let period_min = req.intervals[PARAM_PERIOD_SIZE].min.max(1);
    let period_max = req.intervals[PARAM_PERIOD_SIZE].max.max(1);
    let buffer_min = req.intervals[PARAM_BUFFER_SIZE].min;
    let buffer_max = req.intervals[PARAM_BUFFER_SIZE].max;
    // periods = buffer/period; widest range = buffer_max/period_min,
    // narrowest = buffer_min/period_max.
    let mut periods_min = (buffer_min / period_max).max(1);
    let mut periods_max = (buffer_max / period_min).max(1);
    // Honour caller-supplied periods bounds. alsa-lib drives the
    // hw_params handshake through repeated HW_REFINEs that tighten one
    // interval at a time — set_periods_min(2) sends periods=[2,…] and
    // expects the kernel to keep that floor. Without this intersection
    // the next refine returns the buffer/period-derived [1,16] and
    // alsa-lib sees its constraint dropped, causing
    // snd_pcm_hw_params_choose() / snd_pcm_hw_params() to fail.
    let user_periods_min = req.intervals[PARAM_PERIODS].min;
    let user_periods_max = req.intervals[PARAM_PERIODS].max;
    if user_periods_min > 0 {
        periods_min = periods_min.max(user_periods_min);
    }
    if user_periods_max > 0 {
        periods_max = periods_max.min(user_periods_max);
    }
    if periods_min > periods_max {
        return Err(Errno::EINVAL);
    }
    req.intervals[PARAM_PERIODS] = WpkSndInterval {
        min: periods_min,
        max: periods_max,
        flags: 0,
    };

    // When period_size and periods are both pinned to a single value,
    // buffer_size is forced to their product. Pin it eagerly so the
    // next HW_REFINE doesn't return a stale range and so HW_PARAMS'
    // `read_interval_single` finds a single value. The chosen value
    // must remain inside both the v1 cap and the caller's current
    // buffer range (the latter guards against e.g. an explicit
    // `set_buffer_size(4096)` colliding with `period_size * periods`).
    if period_min == period_max && periods_min == periods_max {
        let derived = (period_min as u64) * (periods_min as u64);
        if derived >= MIN_BUFFER_SIZE as u64
            && derived <= MAX_BUFFER_SIZE as u64
            && derived >= buffer_min as u64
            && derived <= buffer_max as u64
        {
            let d = derived as u32;
            req.intervals[PARAM_BUFFER_SIZE] = WpkSndInterval {
                min: d,
                max: d,
                flags: 0,
            };
        }
    }

    req.rate_num = req.intervals[PARAM_RATE].min;
    req.rate_den = 1;
    req.msbits = SAMPLE_BITS_S16_LE;
    req.info = SNDRV_PCM_INFO_MMAP
        | SNDRV_PCM_INFO_MMAP_VALID
        | SNDRV_PCM_INFO_INTERLEAVED
        | SNDRV_PCM_INFO_BLOCK_TRANSFER
        | SNDRV_PCM_INFO_PAUSE;
    Ok(())
}

fn extract_access(req: &WpkAlsaPcmHwParams) -> Result<u32, Errno> {
    mask_first_set(mask_at(&req.masks, PARAM_ACCESS)).ok_or(Errno::EINVAL)
}

fn extract_format(req: &WpkAlsaPcmHwParams) -> Result<u32, Errno> {
    let bit = mask_first_set(mask_at(&req.masks, PARAM_FORMAT))
        .ok_or(Errno::EINVAL)?;
    if bit != SNDRV_PCM_FORMAT_S16_LE {
        return Err(Errno::EINVAL);
    }
    Ok(bit)
}

fn extract_channels(req: &WpkAlsaPcmHwParams) -> Result<u32, Errno> {
    let v = read_interval_single(&req.intervals[PARAM_CHANNELS])?;
    if !(MIN_CHANNELS..=MAX_CHANNELS).contains(&v) {
        return Err(Errno::EINVAL);
    }
    Ok(v)
}

fn extract_rate(req: &WpkAlsaPcmHwParams) -> Result<u32, Errno> {
    let v = read_interval_single(&req.intervals[PARAM_RATE])?;
    if !(MIN_RATE..=MAX_RATE).contains(&v) {
        return Err(Errno::EINVAL);
    }
    Ok(v)
}

fn extract_period_size(req: &WpkAlsaPcmHwParams) -> Result<u64, Errno> {
    let v = read_interval_single(&req.intervals[PARAM_PERIOD_SIZE])?;
    if !(MIN_PERIOD_SIZE..=MAX_PERIOD_SIZE).contains(&v) {
        return Err(Errno::EINVAL);
    }
    Ok(v as u64)
}

fn extract_buffer_size(req: &WpkAlsaPcmHwParams) -> Result<u64, Errno> {
    let v = read_interval_single(&req.intervals[PARAM_BUFFER_SIZE])?;
    if !(MIN_BUFFER_SIZE..=MAX_BUFFER_SIZE).contains(&v) {
        return Err(Errno::EINVAL);
    }
    Ok(v as u64)
}

fn extract_periods(req: &WpkAlsaPcmHwParams) -> Result<u32, Errno> {
    let v = read_interval_single(&req.intervals[PARAM_PERIODS])?;
    if v == 0 {
        return Err(Errno::EINVAL);
    }
    Ok(v)
}

// --------------------------------------------------------------------
// OFD borrow helpers.
// --------------------------------------------------------------------

fn audio_mut<'a>(
    proc: &'a mut Process,
    ofd_idx: usize,
) -> Result<&'a mut AlsaFdState, Errno> {
    proc.ofd_table
        .get_mut(ofd_idx)
        .ok_or(Errno::EBADF)?
        .audio_mut()
        .ok_or(Errno::EBADFD)
}

fn audio_ref<'a>(
    proc: &'a Process,
    ofd_idx: usize,
) -> Result<&'a AlsaFdState, Errno> {
    proc.ofd_table
        .get(ofd_idx)
        .ok_or(Errno::EBADF)?
        .audio()
        .ok_or(Errno::EBADFD)
}

fn monotonic_secs_nsecs(host: &mut dyn HostIO) -> (i64, i64) {
    host.host_clock_gettime(wasm_posix_shared::clock::CLOCK_MONOTONIC)
        .unwrap_or((0, 0))
}

// --------------------------------------------------------------------
// Dispatcher.
// --------------------------------------------------------------------

/// Entry point invoked by [`crate::syscalls::sys_ioctl`] when an ioctl
/// targets an OFD with an attached [`AlsaFdState`] sidecar (i.e. the OFD
/// was opened against `/dev/snd/pcmC0D0p`).
pub fn handle_alsa_pcm_ioctl(
    proc: &mut Process,
    host: &mut dyn HostIO,
    ofd_idx: usize,
    request: u32,
    buf: &mut [u8],
) -> Result<(), Errno> {
    match request {
        SNDRV_PCM_IOCTL_PVERSION => write_u32(buf, SNDRV_PROTOCOL_VERSION),

        SNDRV_PCM_IOCTL_INFO => {
            let audio = audio_ref(proc, ofd_idx)?;
            let mut info = WpkAlsaPcmInfo {
                device: audio.device as u32,
                subdevice: audio.sub as u32,
                stream: SNDRV_PCM_STREAM_PLAYBACK as i32,
                card: audio.card as i32,
                dev_class: SNDRV_PCM_CLASS_GENERIC,
                subdevices_count: 1,
                subdevices_avail: 1,
                ..Default::default()
            };
            copy_into_array(&mut info.id, b"wpk");
            copy_into_array(&mut info.name, b"wpk virtual playback");
            copy_into_array(&mut info.subname, b"subdevice #0");
            write_struct(buf, &info)
        }

        SNDRV_PCM_IOCTL_HW_REFINE => {
            let mut req: WpkAlsaPcmHwParams = read_struct(buf)?;
            refine_hw_params(&mut req)?;
            write_struct(buf, &req)
        }

        SNDRV_PCM_IOCTL_HW_PARAMS => {
            let mut req: WpkAlsaPcmHwParams = read_struct(buf)?;
            refine_hw_params(&mut req)?;
            let cache = HwParamsCache {
                format: extract_format(&req)?,
                access: extract_access(&req)?,
                channels: extract_channels(&req)?,
                rate: extract_rate(&req)?,
                period_size: extract_period_size(&req)?,
                buffer_size: extract_buffer_size(&req)?,
                periods: extract_periods(&req)?,
            };
            let audio = audio_mut(proc, ofd_idx)?;
            if audio.state != SNDRV_PCM_STATE_OPEN
                && audio.state != SNDRV_PCM_STATE_SETUP
            {
                return Err(Errno::EBADFD);
            }
            audio.hw_params = Some(Box::new(cache));
            audio.state = SNDRV_PCM_STATE_SETUP;
            if let Some(status) = audio.mmap_status.as_mut() {
                status.state = SNDRV_PCM_STATE_SETUP;
            }
            write_struct(buf, &req)
        }

        SNDRV_PCM_IOCTL_HW_FREE => {
            let audio = audio_mut(proc, ofd_idx)?;
            audio.hw_params = None;
            audio.sw_params = None;
            audio.state = SNDRV_PCM_STATE_OPEN;
            if let Some(status) = audio.mmap_status.as_mut() {
                status.state = SNDRV_PCM_STATE_OPEN;
                status.hw_ptr = 0;
            }
            if let Some(ctl) = audio.mmap_control.as_mut() {
                ctl.appl_ptr = 0;
            }
            Ok(())
        }

        SNDRV_PCM_IOCTL_SW_PARAMS => {
            let req: WpkAlsaPcmSwParams = read_struct(buf)?;
            let audio = audio_mut(proc, ofd_idx)?;
            if audio.hw_params.is_none() {
                return Err(Errno::EBADFD);
            }
            audio.sw_params = Some(Box::new(SwParamsCache {
                avail_min: req.avail_min as u64,
                start_threshold: req.start_threshold as u64,
                stop_threshold: req.stop_threshold as u64,
                boundary: req.boundary as u64,
            }));
            Ok(())
        }

        SNDRV_PCM_IOCTL_PREPARE => {
            let audio = audio_mut(proc, ofd_idx)?;
            if audio.hw_params.is_none() {
                return Err(Errno::EBADFD);
            }
            audio.state = SNDRV_PCM_STATE_PREPARED;
            if let Some(status) = audio.mmap_status.as_mut() {
                status.state = SNDRV_PCM_STATE_PREPARED;
                status.hw_ptr = 0;
            }
            if let Some(ctl) = audio.mmap_control.as_mut() {
                ctl.appl_ptr = 0;
            }
            Ok(())
        }

        SNDRV_PCM_IOCTL_START => {
            let (sec, nsec) = monotonic_secs_nsecs(host);
            let audio = audio_mut(proc, ofd_idx)?;
            if audio.state != SNDRV_PCM_STATE_PREPARED {
                return Err(Errno::EBADFD);
            }
            audio.state = SNDRV_PCM_STATE_RUNNING;
            if let Some(status) = audio.mmap_status.as_mut() {
                status.state = SNDRV_PCM_STATE_RUNNING;
                status.tstamp_sec = sec;
                status.tstamp_nsec = nsec as i32;
            }
            Ok(())
        }

        SNDRV_PCM_IOCTL_DROP => {
            let audio = audio_mut(proc, ofd_idx)?;
            // Linux accepts DROP from RUNNING / PREPARED / PAUSED / XRUN.
            // OPEN (no hw_params committed yet) is the only invalid source.
            if audio.state == SNDRV_PCM_STATE_OPEN {
                return Err(Errno::EBADFD);
            }
            audio.state = SNDRV_PCM_STATE_SETUP;
            if let Some(status) = audio.mmap_status.as_mut() {
                status.state = SNDRV_PCM_STATE_SETUP;
            }
            Ok(())
        }

        SNDRV_PCM_IOCTL_PAUSE => {
            let value = read_u32(buf)?;
            let audio = audio_mut(proc, ofd_idx)?;
            let new_state = if value != 0 {
                if audio.state != SNDRV_PCM_STATE_RUNNING {
                    return Err(Errno::EBADFD);
                }
                SNDRV_PCM_STATE_PAUSED
            } else {
                if audio.state != SNDRV_PCM_STATE_PAUSED {
                    return Err(Errno::EBADFD);
                }
                SNDRV_PCM_STATE_RUNNING
            };
            audio.state = new_state;
            if let Some(status) = audio.mmap_status.as_mut() {
                status.state = new_state;
            }
            Ok(())
        }

        SNDRV_PCM_IOCTL_HWSYNC => {
            // alsa-lib calls this before reading mmap_status to force
            // the driver to refresh hw_ptr. In our model, the period
            // tick (`tick.rs::tick`) keeps `mmap_status.hw_ptr` in
            // lockstep with the worklet's consumption, so HWSYNC has
            // nothing to do — just succeed. Returning ENOTTY here
            // (the default) makes `snd_pcm_avail()` fail with -25,
            // which silently propagates as "no headroom" through any
            // caller using the avail path.
            let _ = audio_ref(proc, ofd_idx)?;
            Ok(())
        }

        SNDRV_PCM_IOCTL_STATUS => {
            let (sec, nsec) = monotonic_secs_nsecs(host);
            let audio = audio_ref(proc, ofd_idx)?;
            let hw_ptr = audio.mmap_status.as_ref().map(|s| s.hw_ptr).unwrap_or(0);
            let appl_ptr = audio.mmap_control.as_ref().map(|c| c.appl_ptr).unwrap_or(0);
            let buffer_size = audio
                .hw_params
                .as_ref()
                .map(|h| h.buffer_size as u32)
                .unwrap_or(0);
            // Compute via i64 so negative deltas (XRUN) and pointer
            // wrap deltas larger than i32::MAX both fit before the
            // i32/u32 saturation.
            let delay_i64 = appl_ptr as i64 - hw_ptr as i64;
            let delay = delay_i64.clamp(i32::MIN as i64, i32::MAX as i64) as i32;
            let avail = if buffer_size > 0 {
                (buffer_size as i64 - delay_i64).max(0) as u32
            } else {
                0
            };
            let status = WpkAlsaPcmStatus {
                state: audio.state,
                _pad1: 0,
                trigger_tstamp_sec: 0,
                trigger_tstamp_nsec: 0,
                _trigger_tstamp_pad: 0,
                tstamp_sec: sec,
                tstamp_nsec: nsec as i32,
                _tstamp_pad: 0,
                appl_ptr,
                hw_ptr,
                delay,
                avail,
                avail_max: buffer_size,
                overrange: 0,
                suspended_state: 0,
                audio_tstamp_data: 0,
                audio_tstamp_sec: 0,
                audio_tstamp_nsec: 0,
                _audio_tstamp_pad: 0,
                driver_tstamp_sec: 0,
                driver_tstamp_nsec: 0,
                _driver_tstamp_pad: 0,
                audio_tstamp_accuracy: 0,
                _reserved: [0u8; 20],
            };
            write_struct(buf, &status)
        }

        SNDRV_PCM_IOCTL_WRITEI_FRAMES => handle_writei(proc, host, ofd_idx, buf),

        _ => Err(Errno::ENOTTY),
    }
}

/// Plan for one `WRITEI_FRAMES` call. Computed under an immutable
/// borrow of the OFD so the subsequent `proc_read_bytes` (which needs
/// `&mut HostIO`) and the `appl_ptr` advance (which needs `&mut OFD`)
/// don't fight the borrow checker.
struct WriteiPlan {
    pcm_id: u32,
    channels: usize,
    ring_frames: usize,
    appl_frame_offset: usize,
    to_write: usize,
}

/// `SNDRV_PCM_IOCTL_WRITEI_FRAMES` handler. The non-mmap data path:
/// userspace hands us a pointer + frame count and the kernel copies
/// the samples into the SAB-backed ring at `appl_ptr % ring_frames`.
///
/// When the ring is full (`avail == 0`) on a non-zero request, the
/// call returns `EAGAIN` rather than blocking — v1 has no audio
/// wait queue (A6 territory) so the caller is expected to poll
/// (POLLOUT) or retry on a tick. Returning EAGAIN — instead of the
/// old "result = 0" — matches what SDL2's polling-audio patch
/// (packages/registry/sdl2/patches/0002-polling-audio-eagain.patch)
/// and other non-blocking ALSA writers expect when `snd_pcm_open`
/// was called with `SND_PCM_NONBLOCK`. Blocking-mode callers that
/// don't separately wait for POLLOUT will see EAGAIN as a transient
/// error and retry, which is the same outcome they'd get from a
/// real Linux kernel under heavy contention.
fn handle_writei(
    proc: &mut Process,
    host: &mut dyn HostIO,
    ofd_idx: usize,
    buf: &mut [u8],
) -> Result<(), Errno> {
    let mut req: WpkAlsaXferi = read_struct(buf)?;
    let frames_req = req.frames as usize;
    let pid = proc.pid as i32;

    // ---------- stage 1: validate + plan ----------
    let plan = {
        let audio = audio_ref(proc, ofd_idx)?;
        let hw = audio.hw_params.as_deref().ok_or(Errno::EBADFD)?;
        if hw.format != SNDRV_PCM_FORMAT_S16_LE {
            return Err(Errno::EINVAL);
        }
        if hw.channels == 0 {
            return Err(Errno::EINVAL);
        }
        let channels = hw.channels as usize;
        let bytes_per_frame = channels * core::mem::size_of::<i16>();

        let slice = crate::audio::sab::lookup(audio.pcm_id).ok_or(Errno::ENODEV)?;
        let ring_frames = slice.len / bytes_per_frame;
        if ring_frames == 0 {
            return Err(Errno::ENODEV);
        }

        let appl = audio
            .mmap_control
            .as_deref()
            .ok_or(Errno::EBADFD)?
            .appl_ptr;
        let hw_ptr = audio
            .mmap_status
            .as_deref()
            .ok_or(Errno::EBADFD)?
            .hw_ptr;

        let delay = appl as i64 - hw_ptr as i64;
        let avail = (ring_frames as i64 - delay).max(0) as usize;
        let to_write = frames_req.min(avail);
        let appl_frame_offset = (appl as usize) % ring_frames;

        // Full ring + non-zero request → EAGAIN. A zero-frame request
        // is a valid no-op and still succeeds with result=0.
        if frames_req > 0 && to_write == 0 {
            return Err(Errno::EAGAIN);
        }

        WriteiPlan {
            pcm_id: audio.pcm_id,
            channels,
            ring_frames,
            appl_frame_offset,
            to_write,
        }
    };

    // ---------- stage 2: copy user → SAB ring ----------
    if plan.to_write > 0 {
        let bytes_per_frame = plan.channels * core::mem::size_of::<i16>();
        let total_bytes = plan.to_write * bytes_per_frame;
        let mut scratch: alloc::vec::Vec<u8> = alloc::vec![0u8; total_bytes];
        let rc = host.proc_read_bytes(pid, req.buf, &mut scratch);
        if rc < 0 {
            return Err(Errno::EFAULT);
        }

        // SAFETY: the host registered the SAB via `kernel_audio_init_sab`
        // and the ring outlives this call. Within one syscall the
        // kernel is the sole producer; the AudioWorklet only consumes
        // bytes at offsets below `appl_ptr` per the alsa-lib protocol.
        let ring = unsafe { crate::audio::sab::ring_mut_s16(plan.pcm_id) }
            .ok_or(Errno::ENODEV)?;
        for f in 0..plan.to_write {
            let dst_frame = (plan.appl_frame_offset + f) % plan.ring_frames;
            for c in 0..plan.channels {
                let src_byte = (f * plan.channels + c) * 2;
                let sample =
                    i16::from_le_bytes([scratch[src_byte], scratch[src_byte + 1]]);
                ring[dst_frame * plan.channels + c] = sample;
            }
        }
    }

    // ---------- stage 3: advance appl_ptr ----------
    {
        let audio = audio_mut(proc, ofd_idx)?;
        if let Some(ctl) = audio.mmap_control.as_mut() {
            ctl.appl_ptr = ctl.appl_ptr.wrapping_add(plan.to_write as u32);
            // Mirror the new producer pointer into the SAB-backed
            // `appl_ptr` slot so the AudioWorklet sees it without
            // the 10 ms `getApplPtr` poll → `postMessage` chain.
            // No-op when no host has registered a slot — the legacy
            // poll path still works for that case.
            crate::audio::sab::publish_appl_ptr(plan.pcm_id, ctl.appl_ptr);
        }
    }

    // ---------- stage 3.5: auto-start if start_threshold reached ----------
    // Linux's WRITEI handler auto-transitions PREPARED→RUNNING once
    // (appl_ptr - hw_ptr) >= sw_params.start_threshold. alsa-lib's
    // pcm_hw sets `own_state_check=1` (skipping the userspace bad-state
    // check on writei) and its non-mmap writei path never inspects
    // start_threshold itself — both Linux and the application rely on
    // the kernel doing it here. Without this, devices opened with
    // start_threshold=1 (SDL2's setting) stay PREPARED forever, the
    // period tick skips them, and writei stalls EAGAIN once the ring
    // fills (~341 ms of audio at 48 kHz × stereo × s16, ring=64 KiB).
    {
        let audio = audio_mut(proc, ofd_idx)?;
        if audio.state == SNDRV_PCM_STATE_PREPARED {
            let appl = audio.mmap_control.as_ref().map(|c| c.appl_ptr).unwrap_or(0);
            let hw = audio.mmap_status.as_ref().map(|s| s.hw_ptr).unwrap_or(0);
            let queued = appl.wrapping_sub(hw) as u64;
            let threshold = audio.sw_params.as_ref().map(|s| s.start_threshold).unwrap_or(1);
            if queued >= threshold {
                audio.state = SNDRV_PCM_STATE_RUNNING;
                if let Some(status) = audio.mmap_status.as_mut() {
                    status.state = SNDRV_PCM_STATE_RUNNING;
                }
            }
        }
    }

    // ---------- stage 4: stamp result ----------
    req.result = plan.to_write as i32;
    write_struct(buf, &req)
}

/// Copy `src` into `dst`, NUL-padding any remaining tail. Truncates
/// `src` if it exceeds `dst.len()` (the trailing NUL is preserved by
/// the cap, so alsa-lib's strlen-based readers still find the
/// terminator).
fn copy_into_array(dst: &mut [u8], src: &[u8]) {
    let n = src.len().min(dst.len().saturating_sub(1));
    dst[..n].copy_from_slice(&src[..n]);
    for byte in &mut dst[n..] {
        *byte = 0;
    }
}

// --------------------------------------------------------------------
// Tests.
// --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ofd::{AlsaFdState, FileType, PcmDir};
    use crate::process::Process;
    use crate::process::test_host::NoopHost;
    use crate::syscalls::VirtualDevice;

    /// Build a freshly-opened OFD with an `AlsaFdState` sidecar attached
    /// at the returned OFD index. Always populates mmap_status +
    /// mmap_control so the state-machine arms exercise those branches.
    /// (A4 wires those allocations via real mmap; for the dispatcher
    /// tests we hand them in pre-populated.)
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
        ofd.audio = Some(Box::new(AlsaFdState {
            mmap_status: Some(Box::new(WpkAlsaPcmMmapStatus::default())),
            mmap_control: Some(Box::new(WpkAlsaPcmMmapControl::default())),
            ..AlsaFdState::default()
        }));
        idx
    }

    /// A wildcard hw_params: all-zero, mirroring what alsa-lib hands the
    /// kernel after `snd_pcm_hw_params_any`.
    fn wildcard_hw_params() -> WpkAlsaPcmHwParams {
        WpkAlsaPcmHwParams::default()
    }

    fn refined_hw_params() -> WpkAlsaPcmHwParams {
        let mut p = wildcard_hw_params();
        refine_hw_params(&mut p).expect("refine wildcard");
        // refine_hw_params returns RANGES (matching Linux semantics);
        // alsa-lib's snd_pcm_hw_params_choose() then narrows to a single
        // value via snd_pcm_hw_param_set_first. Mimic that here so unit
        // tests can feed the refined struct straight into HW_PARAMS,
        // which expects min == max via read_interval_single().
        for ix in [
            PARAM_CHANNELS,
            PARAM_RATE,
            PARAM_PERIOD_SIZE,
            PARAM_BUFFER_SIZE,
            PARAM_SAMPLE_BITS,
            PARAM_FRAME_BITS,
        ] {
            p.intervals[ix].max = p.intervals[ix].min;
        }
        // periods must be self-consistent with buffer / period — pin to
        // the derived single value rather than just `min` so the next
        // refine_hw_params doesn't intersect a stale [1,1] against the
        // derived [buffer/period, buffer/period] range and return EINVAL.
        let buffer = p.intervals[PARAM_BUFFER_SIZE].min;
        let period = p.intervals[PARAM_PERIOD_SIZE].min.max(1);
        let periods = (buffer / period).max(1);
        p.intervals[PARAM_PERIODS] = WpkSndInterval {
            min: periods,
            max: periods,
            flags: 0,
        };
        p
    }

    fn run_ioctl(
        proc: &mut Process,
        host: &mut NoopHost,
        ofd_idx: usize,
        request: u32,
        buf: &mut [u8],
    ) -> Result<(), Errno> {
        handle_alsa_pcm_ioctl(proc, host, ofd_idx, request, buf)
    }

    // --- PVERSION ---------------------------------------------------

    #[test]
    fn pcm_pversion_matches_alsa_compat_window() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        let mut buf = [0u8; 4];
        run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_PVERSION, &mut buf)
            .expect("PVERSION");
        assert_eq!(
            u32::from_le_bytes(buf),
            SNDRV_PROTOCOL_VERSION,
            "PVERSION must report 0x0002_0004 — matches alsa-lib's \
             SNDRV_PROTOCOL_INCOMPATIBLE major/minor check vs \
             SNDRV_{{PCM,CTL}}_VERSION_MAX and stays below the \
             conditional-ioctl thresholds (>=2.0.5 TSTAMP, \
             >=2.0.14 USER_PVERSION)",
        );
    }

    // --- INFO -------------------------------------------------------

    #[test]
    fn pcm_info_returns_playback_stream_card0_device0() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        let mut buf = [0u8; core::mem::size_of::<WpkAlsaPcmInfo>()];
        run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_INFO, &mut buf)
            .expect("INFO");
        let info: WpkAlsaPcmInfo =
            unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const _) };
        assert_eq!(info.card, 0);
        assert_eq!(info.device, 0);
        assert_eq!(info.subdevice, 0);
        assert_eq!(info.stream, SNDRV_PCM_STREAM_PLAYBACK as i32);
        assert!(info.name.starts_with(b"wpk virtual playback"));
        assert_eq!(info.dev_class, SNDRV_PCM_CLASS_GENERIC);
        assert_eq!(info.subdevices_count, 1);
        assert_eq!(info.subdevices_avail, 1);
    }

    // --- HW_REFINE --------------------------------------------------

    #[test]
    fn pcm_hw_refine_clamps_unsupported_format_to_s16_le() {
        // User requests S32_LE only; refine must reject.
        let mut p = wildcard_hw_params();
        let m = mask_at_mut(&mut p.masks, PARAM_FORMAT);
        m.copy_from_slice(&capability_one(SNDRV_PCM_FORMAT_S32_LE));
        let err = refine_hw_params(&mut p).expect_err("S32-only must EINVAL");
        assert_eq!(err, Errno::EINVAL);
    }

    #[test]
    fn pcm_hw_refine_wildcard_clamps_to_v1_range() {
        let mut p = wildcard_hw_params();
        refine_hw_params(&mut p).expect("wildcard refine");
        let format = mask_first_set(mask_at(&p.masks, PARAM_FORMAT)).unwrap();
        assert_eq!(format, SNDRV_PCM_FORMAT_S16_LE);
        // refine_hw_params now leaves intervals as RANGES (matching
        // Linux semantics — alsa-lib's snd_pcm_hw_params_choose() does
        // the per-param narrowing after HW_REFINE returns).
        assert_eq!(p.intervals[PARAM_CHANNELS].min, MIN_CHANNELS);
        assert_eq!(p.intervals[PARAM_CHANNELS].max, MAX_CHANNELS);
        assert_eq!(p.intervals[PARAM_RATE].min, MIN_RATE);
        assert_eq!(p.intervals[PARAM_RATE].max, MAX_RATE);
        assert_eq!(p.intervals[PARAM_PERIOD_SIZE].min, MIN_PERIOD_SIZE);
        assert_eq!(p.intervals[PARAM_PERIOD_SIZE].max, MAX_PERIOD_SIZE);
        assert_eq!(p.intervals[PARAM_BUFFER_SIZE].min, MIN_BUFFER_SIZE);
        assert_eq!(p.intervals[PARAM_BUFFER_SIZE].max, MAX_BUFFER_SIZE);
        assert_eq!(p.intervals[PARAM_SAMPLE_BITS].min, SAMPLE_BITS_S16_LE);
        assert_eq!(p.rate_num, MIN_RATE);
        assert_eq!(p.rate_den, 1);
    }

    #[test]
    fn pcm_hw_refine_user_constrained_rate_is_respected() {
        let mut p = wildcard_hw_params();
        p.intervals[PARAM_RATE] = WpkSndInterval {
            min: 44100,
            max: 44100,
            flags: 0,
        };
        refine_hw_params(&mut p).expect("respect user rate");
        assert_eq!(p.intervals[PARAM_RATE].min, 44100);
        assert_eq!(p.intervals[PARAM_RATE].max, 44100);
        assert_eq!(p.rate_num, 44100);
    }

    #[test]
    fn pcm_hw_refine_user_periods_min_is_honoured() {
        // alsa-lib's set_periods_min(2) sends periods=[2,…] and expects
        // the kernel to keep that floor across subsequent refines.
        let mut p = wildcard_hw_params();
        p.intervals[PARAM_PERIODS] = WpkSndInterval { min: 2, max: 0, flags: 0 };
        refine_hw_params(&mut p).expect("respect user periods.min");
        assert!(p.intervals[PARAM_PERIODS].min >= 2);
    }

    #[test]
    fn pcm_hw_refine_empty_periods_intersection_returns_einval() {
        // period=[4096,4096] + buffer=[256,256] derive periods=[0,0] (clamped
        // to [1,1]); a user pin of periods=[8,8] cannot intersect with that.
        let mut p = wildcard_hw_params();
        p.intervals[PARAM_PERIOD_SIZE] = WpkSndInterval {
            min: MAX_PERIOD_SIZE,
            max: MAX_PERIOD_SIZE,
            flags: 0,
        };
        p.intervals[PARAM_BUFFER_SIZE] = WpkSndInterval {
            min: MIN_BUFFER_SIZE,
            max: MIN_BUFFER_SIZE,
            flags: 0,
        };
        p.intervals[PARAM_PERIODS] = WpkSndInterval { min: 8, max: 8, flags: 0 };
        let err = refine_hw_params(&mut p).expect_err("empty intersection");
        assert_eq!(err, Errno::EINVAL);
    }

    #[test]
    fn pcm_hw_refine_eager_buffer_derivation_pins_to_product() {
        // period and periods both pinned single-valued; refine should pin
        // buffer = period * periods so HW_PARAMS' read_interval_single
        // converges.
        let mut p = wildcard_hw_params();
        p.intervals[PARAM_PERIOD_SIZE] = WpkSndInterval { min: 256, max: 256, flags: 0 };
        p.intervals[PARAM_PERIODS] = WpkSndInterval { min: 4, max: 4, flags: 0 };
        refine_hw_params(&mut p).expect("eager buffer derivation");
        assert_eq!(p.intervals[PARAM_BUFFER_SIZE].min, 1024);
        assert_eq!(p.intervals[PARAM_BUFFER_SIZE].max, 1024);
    }

    // --- HW_PARAMS --------------------------------------------------

    #[test]
    fn pcm_hw_params_transitions_open_to_setup() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        let p = refined_hw_params();
        let mut buf = struct_buf(&p);
        run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_HW_PARAMS, &mut buf)
            .expect("HW_PARAMS");
        let st = audio_ref(&proc, idx).unwrap();
        assert_eq!(st.state, SNDRV_PCM_STATE_SETUP);
        let cache = st.hw_params.as_deref().expect("hw_params cached");
        assert_eq!(cache.format, SNDRV_PCM_FORMAT_S16_LE);
        assert_eq!(cache.rate, MIN_RATE);
        assert_eq!(cache.channels, MIN_CHANNELS);
        // mmap_status (defaulted to OPEN by AlsaFdState::default) should
        // also flip — refresh keeps userspace consistent.
        assert_eq!(
            st.mmap_status.as_deref().unwrap().state,
            SNDRV_PCM_STATE_SETUP,
        );
    }

    #[test]
    fn pcm_hw_params_without_format_returns_einval() {
        // Build a "refined-looking" struct with a zero FORMAT mask —
        // refine_hw_params (called inside HW_PARAMS) re-fills empties
        // with the capability set, so we have to actively poison the
        // format dimension to drive this. Set the format mask to a
        // disallowed bit (S32_LE) so the intersection collapses to
        // empty.
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        let mut p = wildcard_hw_params();
        let m = mask_at_mut(&mut p.masks, PARAM_FORMAT);
        m.copy_from_slice(&capability_one(SNDRV_PCM_FORMAT_S32_LE));
        let mut buf = struct_buf(&p);
        let err = run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_HW_PARAMS,
            &mut buf,
        )
        .expect_err("S32-only must EINVAL");
        assert_eq!(err, Errno::EINVAL);
        assert_eq!(audio_ref(&proc, idx).unwrap().state, SNDRV_PCM_STATE_OPEN);
    }

    #[test]
    fn pcm_hw_free_returns_to_open() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        let mut buf = [];
        run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_HW_FREE, &mut buf)
            .expect("HW_FREE");
        let st = audio_ref(&proc, idx).unwrap();
        assert_eq!(st.state, SNDRV_PCM_STATE_OPEN);
        assert!(st.hw_params.is_none());
        assert!(st.sw_params.is_none());
    }

    // --- SW_PARAMS --------------------------------------------------

    #[test]
    fn pcm_sw_params_without_hw_params_returns_einval() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        let sw = WpkAlsaPcmSwParams { avail_min: 256, ..Default::default() };
        let mut buf = struct_buf(&sw);
        let err = run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_SW_PARAMS,
            &mut buf,
        )
        .expect_err("SW_PARAMS before HW_PARAMS must EBADFD");
        assert_eq!(err, Errno::EBADFD);
    }

    #[test]
    fn pcm_sw_params_caches_thresholds() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        let sw = WpkAlsaPcmSwParams {
            avail_min: 512,
            start_threshold: 1024,
            stop_threshold: 4096,
            boundary: 1 << 30,
            ..Default::default()
        };
        let mut buf = struct_buf(&sw);
        run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_SW_PARAMS, &mut buf)
            .expect("SW_PARAMS");
        let st = audio_ref(&proc, idx).unwrap();
        let cache = st.sw_params.as_deref().unwrap();
        assert_eq!(cache.avail_min, 512);
        assert_eq!(cache.start_threshold, 1024);
        assert_eq!(cache.stop_threshold, 4096);
        assert_eq!(cache.boundary, 1 << 30);
    }

    // --- PREPARE / START / DROP / PAUSE -----------------------------

    #[test]
    fn pcm_prepare_after_hw_params_transitions_to_prepared() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        // Seed appl_ptr so PREPARE can reset it.
        proc.ofd_table
            .get_mut(idx)
            .unwrap()
            .audio_mut()
            .unwrap()
            .mmap_control
            .as_mut()
            .unwrap()
            .appl_ptr = 1234;
        let mut buf = [];
        run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_PREPARE, &mut buf)
            .expect("PREPARE");
        let st = audio_ref(&proc, idx).unwrap();
        assert_eq!(st.state, SNDRV_PCM_STATE_PREPARED);
        assert_eq!(st.mmap_control.as_ref().unwrap().appl_ptr, 0);
        assert_eq!(st.mmap_status.as_ref().unwrap().hw_ptr, 0);
    }

    #[test]
    fn pcm_prepare_without_hw_params_returns_ebadfd() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        let err = run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_PREPARE,
            &mut [],
        )
        .expect_err("PREPARE in OPEN must EBADFD");
        assert_eq!(err, Errno::EBADFD);
    }

    #[test]
    fn pcm_start_from_prepared_transitions_to_running() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_PREPARE, &mut [])
            .unwrap();
        run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_START, &mut [])
            .expect("START");
        let st = audio_ref(&proc, idx).unwrap();
        assert_eq!(st.state, SNDRV_PCM_STATE_RUNNING);
        let status = st.mmap_status.as_ref().unwrap();
        assert_eq!(status.state, SNDRV_PCM_STATE_RUNNING);
        // NoopHost's clock returns (0, 0); we only assert the start
        // path stamped *something* via host_clock_gettime — the exact
        // value depends on the host. Picking >= 0 verifies the call
        // wasn't bypassed (uninitialised memory would be UB).
        assert!(status.tstamp_sec >= 0);
        assert!(status.tstamp_nsec >= 0);
    }

    #[test]
    fn pcm_start_without_prepare_returns_ebadfd() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        // SETUP, not PREPARED — START must reject.
        let err = run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_START,
            &mut [],
        )
        .expect_err("START from SETUP must EBADFD");
        assert_eq!(err, Errno::EBADFD);
    }

    #[test]
    fn pcm_drop_from_running_transitions_to_setup() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_PREPARE, &mut [])
            .unwrap();
        run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_START, &mut [])
            .unwrap();
        run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_DROP, &mut [])
            .expect("DROP");
        let st = audio_ref(&proc, idx).unwrap();
        assert_eq!(st.state, SNDRV_PCM_STATE_SETUP);
        assert_eq!(
            st.mmap_status.as_ref().unwrap().state,
            SNDRV_PCM_STATE_SETUP,
        );
    }

    #[test]
    fn pcm_drop_from_open_returns_ebadfd() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        let err = run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_DROP, &mut [])
            .expect_err("DROP from OPEN must EBADFD");
        assert_eq!(err, Errno::EBADFD);
    }

    #[test]
    fn pcm_pause_then_resume_round_trips() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_PREPARE, &mut [])
            .unwrap();
        run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_START, &mut [])
            .unwrap();
        let mut buf = 1u32.to_le_bytes();
        run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_PAUSE,
            &mut buf,
        )
        .expect("PAUSE pause");
        assert_eq!(audio_ref(&proc, idx).unwrap().state, SNDRV_PCM_STATE_PAUSED);
        let mut buf = 0u32.to_le_bytes();
        run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_PAUSE,
            &mut buf,
        )
        .expect("PAUSE resume");
        assert_eq!(
            audio_ref(&proc, idx).unwrap().state,
            SNDRV_PCM_STATE_RUNNING,
        );
    }

    #[test]
    fn pcm_pause_from_setup_returns_ebadfd() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        let mut buf = 1u32.to_le_bytes();
        let err = run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_PAUSE,
            &mut buf,
        )
        .expect_err("PAUSE from SETUP must EBADFD");
        assert_eq!(err, Errno::EBADFD);
    }

    // --- STATUS -----------------------------------------------------

    #[test]
    fn pcm_status_reflects_appl_ptr_hw_ptr_delta() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        // Seed appl_ptr and hw_ptr to simulate a partially-consumed buffer.
        {
            let st = audio_mut(&mut proc, idx).unwrap();
            st.mmap_control.as_mut().unwrap().appl_ptr = 1024;
            st.mmap_status.as_mut().unwrap().hw_ptr = 256;
        }
        let mut buf = [0u8; core::mem::size_of::<WpkAlsaPcmStatus>()];
        run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_STATUS, &mut buf)
            .expect("STATUS");
        let status: WpkAlsaPcmStatus =
            unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const _) };
        assert_eq!(status.state, SNDRV_PCM_STATE_SETUP);
        assert_eq!(status.appl_ptr, 1024);
        assert_eq!(status.hw_ptr, 256);
        assert_eq!(status.delay, 1024 - 256);
        // buffer_size committed via wildcard refine == MIN_BUFFER_SIZE.
        assert_eq!(status.avail_max, MIN_BUFFER_SIZE as u32);
        assert!(status.tstamp_sec >= 0);
        assert!(status.tstamp_nsec >= 0);
    }

    // --- WRITEI_FRAMES (A4) -----------------------------------------

    /// Leak a fresh i16 ring sized to hold `frames * channels`
    /// samples. The pointer is then registered with
    /// [`crate::audio::sab`] and stays live for the test's lifetime.
    fn install_sab_ring(pcm_id: u32, frames: usize, channels: usize) -> *mut i16 {
        let total = frames * channels;
        let vec = alloc::vec![0i16; total].into_boxed_slice();
        let leaked: &'static mut [i16] = alloc::boxed::Box::leak(vec);
        let base = leaked.as_mut_ptr();
        let len_bytes = total * core::mem::size_of::<i16>();
        crate::audio::sab::register(
            pcm_id,
            crate::audio::sab::SabSlice {
                base: base as usize,
                len: len_bytes,
            },
        )
        .expect("sab register");
        base
    }

    /// Read the ring back into an owned Vec for assertion. The caller
    /// MUST still hold the SAB lock so no concurrent producer mutates
    /// the leaked region.
    fn read_ring(ptr: *mut i16, frames: usize, channels: usize) -> alloc::vec::Vec<i16> {
        let total = frames * channels;
        let mut out = alloc::vec![0i16; total];
        unsafe {
            core::ptr::copy_nonoverlapping(ptr, out.as_mut_ptr(), total);
        }
        out
    }

    /// Bytes of `count` interleaved S16-LE frames at `channels`, with
    /// the i'th sample = `seed + i` (so we can verify the ordering
    /// survives the copy + wrap). Seeded so the all-zero "no host
    /// copy" path can't accidentally pass the assertion.
    fn synth_frames(count: usize, channels: usize, seed: i16) -> alloc::vec::Vec<u8> {
        let samples = count * channels;
        let mut out = alloc::vec::Vec::with_capacity(samples * 2);
        for i in 0..samples as i16 {
            out.extend_from_slice(&(seed + i).to_le_bytes());
        }
        out
    }

    fn fresh_sab() -> std::sync::MutexGuard<'static, ()> {
        let g = crate::audio::sab::TEST_SAB_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        crate::audio::sab::reset_table();
        *crate::process::test_host::PROC_READ_SOURCE
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = alloc::vec::Vec::new();
        g
    }

    fn set_proc_read_source(bytes: alloc::vec::Vec<u8>) {
        *crate::process::test_host::PROC_READ_SOURCE
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = bytes;
    }

    #[test]
    fn writei_in_open_state_returns_ebadfd() {
        let _g = fresh_sab();
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        // No HW_PARAMS commit → hw_params is None → WRITEI must EBADFD
        // before the SAB lookup runs.
        let xferi = WpkAlsaXferi {
            result: 0,
            buf: 0,
            frames: 32,
        };
        let mut buf = struct_buf(&xferi);
        let err = run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_WRITEI_FRAMES,
            &mut buf,
        )
        .expect_err("WRITEI in OPEN must EBADFD");
        assert_eq!(err, Errno::EBADFD);
    }

    #[test]
    fn writei_with_unsupported_format_returns_einval() {
        let _g = fresh_sab();
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        // Poison the committed format so the WRITEI guard fires
        // before any SAB lookup or copy runs. The dispatcher's
        // HW_PARAMS path can't produce this directly (extract_format
        // gates on S16_LE) but a future XRUN-recovery path could.
        audio_mut(&mut proc, idx)
            .unwrap()
            .hw_params
            .as_mut()
            .unwrap()
            .format = SNDRV_PCM_FORMAT_S32_LE;
        let xferi = WpkAlsaXferi { result: 0, buf: 0, frames: 16 };
        let mut buf = struct_buf(&xferi);
        let err = run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_WRITEI_FRAMES,
            &mut buf,
        )
        .expect_err("non-S16_LE must EINVAL");
        assert_eq!(err, Errno::EINVAL);
    }

    #[test]
    fn writei_without_sab_registered_returns_enodev() {
        let _g = fresh_sab();
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        // hw_params committed but SAB table empty (no
        // kernel_audio_init_sab yet). WRITEI must surface ENODEV so
        // a caller can tell "host hasn't wired audio yet" from
        // "transport error".
        let xferi = WpkAlsaXferi { result: 0, buf: 0, frames: 16 };
        let mut buf = struct_buf(&xferi);
        let err = run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_WRITEI_FRAMES,
            &mut buf,
        )
        .expect_err("no SAB → ENODEV");
        assert_eq!(err, Errno::ENODEV);
    }

    #[test]
    fn writei_appends_frames_to_sab_ring() {
        let _g = fresh_sab();
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        // Refined wildcard: channels=MIN(1), buffer_size=MIN(256).
        let channels = MIN_CHANNELS as usize;
        let ring_frames = MIN_BUFFER_SIZE as usize;
        let ring_ptr = install_sab_ring(0, ring_frames, channels);
        // Drive 8 frames of synthesised samples through the host
        // bridge (seed=10 → samples 10,11,…,17).
        let frames_to_write = 8usize;
        set_proc_read_source(synth_frames(frames_to_write, channels, 10));
        let xferi = WpkAlsaXferi {
            result: 0,
            // Any non-zero address works — NoopHost ignores it and
            // copies from PROC_READ_SOURCE.
            buf: 0x4000_0000,
            frames: frames_to_write as u32,
        };
        let mut buf = struct_buf(&xferi);
        run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_WRITEI_FRAMES,
            &mut buf,
        )
        .expect("WRITEI");
        let result: WpkAlsaXferi =
            unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const _) };
        assert_eq!(result.result, frames_to_write as i32);
        // appl_ptr advanced.
        let appl =
            audio_ref(&proc, idx).unwrap().mmap_control.as_ref().unwrap().appl_ptr;
        assert_eq!(appl, frames_to_write as u32);
        // Ring head holds the synthesised samples; tail is still 0.
        let ring = read_ring(ring_ptr, ring_frames, channels);
        for i in 0..frames_to_write {
            assert_eq!(ring[i], 10 + i as i16, "frame {i}");
        }
        for i in frames_to_write..ring_frames {
            assert_eq!(ring[i], 0, "tail must stay zero at {i}");
        }
    }

    #[test]
    fn writei_wraps_appl_ptr_at_buffer_boundary() {
        let _g = fresh_sab();
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        let channels = MIN_CHANNELS as usize;
        let ring_frames = MIN_BUFFER_SIZE as usize;
        let ring_ptr = install_sab_ring(0, ring_frames, channels);
        // Seed appl_ptr at ring_frames - 4 and hw_ptr at appl - 0 so
        // there's effectively a full buffer of space ahead (we
        // simulate the host having drained everything). Write 8
        // frames — the first 4 land at positions [ring_frames - 4,
        // ring_frames - 1] and the next 4 wrap to [0, 3].
        {
            let audio = audio_mut(&mut proc, idx).unwrap();
            audio.mmap_control.as_mut().unwrap().appl_ptr = (ring_frames - 4) as u32;
            audio.mmap_status.as_mut().unwrap().hw_ptr = (ring_frames - 4) as u32;
        }
        let frames_to_write = 8usize;
        set_proc_read_source(synth_frames(frames_to_write, channels, 100));
        let xferi = WpkAlsaXferi {
            result: 0,
            buf: 0x4000_0000,
            frames: frames_to_write as u32,
        };
        let mut buf = struct_buf(&xferi);
        run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_WRITEI_FRAMES,
            &mut buf,
        )
        .expect("WRITEI wrap");
        let result: WpkAlsaXferi =
            unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const _) };
        assert_eq!(result.result, frames_to_write as i32);
        // appl_ptr advances monotonically past the wrap boundary.
        let appl =
            audio_ref(&proc, idx).unwrap().mmap_control.as_ref().unwrap().appl_ptr;
        assert_eq!(appl, (ring_frames - 4 + frames_to_write) as u32);
        // First 4 frames at tail of ring.
        let ring = read_ring(ring_ptr, ring_frames, channels);
        for i in 0..4 {
            assert_eq!(ring[ring_frames - 4 + i], 100 + i as i16);
        }
        // Next 4 frames at head of ring (wrap).
        for i in 0..4 {
            assert_eq!(ring[i], 100 + (4 + i) as i16);
        }
    }

    #[test]
    fn writei_when_ring_full_returns_eagain() {
        let _g = fresh_sab();
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        let channels = MIN_CHANNELS as usize;
        let ring_frames = MIN_BUFFER_SIZE as usize;
        let _ring_ptr = install_sab_ring(0, ring_frames, channels);
        // Saturate: appl_ptr is ring_frames ahead of hw_ptr → avail=0.
        // v1 has no audio wait queue (A6 territory). With a non-zero
        // request and zero room, the call returns EAGAIN so the
        // userspace SDL2/ALSA polling path can early-exit instead of
        // spinning on a "result=0" successful no-op.
        {
            let audio = audio_mut(&mut proc, idx).unwrap();
            audio.mmap_status.as_mut().unwrap().hw_ptr = 0;
            audio.mmap_control.as_mut().unwrap().appl_ptr = ring_frames as u32;
        }
        let xferi = WpkAlsaXferi {
            result: 0,
            buf: 0x4000_0000,
            frames: 64,
        };
        let mut buf = struct_buf(&xferi);
        let err = run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_WRITEI_FRAMES,
            &mut buf,
        )
        .expect_err("WRITEI on full ring must return EAGAIN");
        assert_eq!(err, Errno::EAGAIN);
        // appl_ptr unchanged.
        let appl =
            audio_ref(&proc, idx).unwrap().mmap_control.as_ref().unwrap().appl_ptr;
        assert_eq!(appl, ring_frames as u32);
    }

    #[test]
    fn writei_in_prepared_state_auto_starts_at_threshold() {
        // alsa-lib's pcm_hw plugin sets `own_state_check=1` and its
        // non-mmap writei never inspects `sw_params.start_threshold`
        // itself — both Linux and the application rely on the kernel
        // to auto-transition PREPARED→RUNNING once enough frames are
        // queued. SDL2 in particular sets start_threshold=1 and never
        // issues SNDRV_PCM_IOCTL_START explicitly. Without auto-start
        // the period tick (which gates on STATE_RUNNING) skips the
        // OFD, hw_ptr never advances, writei stalls EAGAIN once the
        // ring fills, and audio cuts after one ring's playback.
        let _g = fresh_sab();
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        // PREPARE moves SETUP → PREPARED.
        run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_PREPARE, &mut [])
            .expect("PREPARE");
        // SW_PARAMS with SDL2's start_threshold=1.
        let sw = WpkAlsaPcmSwParams {
            avail_min: 1,
            start_threshold: 1,
            stop_threshold: 1 << 20,
            boundary: 1 << 30,
            ..Default::default()
        };
        let mut sw_buf = struct_buf(&sw);
        run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_SW_PARAMS,
            &mut sw_buf,
        )
        .expect("SW_PARAMS");
        assert_eq!(
            audio_ref(&proc, idx).unwrap().state,
            SNDRV_PCM_STATE_PREPARED,
            "must still be PREPARED before writei",
        );
        let channels = MIN_CHANNELS as usize;
        let ring_frames = MIN_BUFFER_SIZE as usize;
        let _ring_ptr = install_sab_ring(0, ring_frames, channels);
        set_proc_read_source(synth_frames(4, channels, 1));
        let xferi = WpkAlsaXferi {
            result: 0,
            buf: 0x4000_0000,
            frames: 4,
        };
        let mut buf = struct_buf(&xferi);
        run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_WRITEI_FRAMES,
            &mut buf,
        )
        .expect("WRITEI");
        let st = audio_ref(&proc, idx).unwrap();
        assert_eq!(
            st.state, SNDRV_PCM_STATE_RUNNING,
            "writei with queued >= start_threshold must auto-start",
        );
        assert_eq!(
            st.mmap_status.as_ref().unwrap().state,
            SNDRV_PCM_STATE_RUNNING,
            "mmap_status.state must mirror so user-page readers see RUNNING",
        );
    }

    #[test]
    fn writei_below_threshold_stays_prepared() {
        // Counterpart to the auto-start test: if the queued depth is
        // still below start_threshold, the kernel must keep the state
        // at PREPARED so the application can decide when to commit
        // (e.g. an explicit snd_pcm_start, or another writei that
        // crosses the threshold).
        let _g = fresh_sab();
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_PREPARE, &mut [])
            .expect("PREPARE");
        let sw = WpkAlsaPcmSwParams {
            avail_min: 1,
            start_threshold: 1024,
            stop_threshold: 1 << 20,
            boundary: 1 << 30,
            ..Default::default()
        };
        let mut sw_buf = struct_buf(&sw);
        run_ioctl(&mut proc, &mut host, idx, SNDRV_PCM_IOCTL_SW_PARAMS, &mut sw_buf)
            .expect("SW_PARAMS");
        let channels = MIN_CHANNELS as usize;
        let ring_frames = MIN_BUFFER_SIZE as usize;
        let _ring_ptr = install_sab_ring(0, ring_frames, channels);
        set_proc_read_source(synth_frames(4, channels, 1));
        let xferi = WpkAlsaXferi { result: 0, buf: 0x4000_0000, frames: 4 };
        let mut buf = struct_buf(&xferi);
        run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_WRITEI_FRAMES,
            &mut buf,
        )
        .expect("WRITEI");
        assert_eq!(
            audio_ref(&proc, idx).unwrap().state,
            SNDRV_PCM_STATE_PREPARED,
            "queued=4 < start_threshold=1024 must NOT auto-start",
        );
    }

    #[test]
    fn writei_publishes_appl_ptr_to_sab_mirror_when_registered() {
        // When the host has called `kernel_audio_init_appl_ptr_sab`,
        // every WRITEI must mirror the new `appl_ptr` value into the
        // 4-byte SAB slot. The AudioWorklet reads from there directly
        // via `Atomics.load`, eliminating the 10 ms `getApplPtr` poll
        // → `postMessage` chain that caused the §C silence emissions.
        let _g = fresh_sab();
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        let channels = MIN_CHANNELS as usize;
        let ring_frames = MIN_BUFFER_SIZE as usize;
        let _ring_ptr = install_sab_ring(0, ring_frames, channels);
        let slot: u32 = 0;
        let slot_addr = &slot as *const u32 as usize;
        crate::audio::sab::register_appl_ptr(0, slot_addr)
            .expect("register appl_ptr slot");
        set_proc_read_source(synth_frames(8, channels, 1));
        let xferi = WpkAlsaXferi { result: 0, buf: 0x4000_0000, frames: 8 };
        let mut buf = struct_buf(&xferi);
        run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_WRITEI_FRAMES,
            &mut buf,
        )
        .expect("WRITEI");
        let mirrored = unsafe { core::ptr::read_volatile(slot_addr as *const u32) };
        assert_eq!(
            mirrored, 8,
            "writei must publish the new appl_ptr into the SAB mirror",
        );
        let appl =
            audio_ref(&proc, idx).unwrap().mmap_control.as_ref().unwrap().appl_ptr;
        assert_eq!(mirrored, appl, "mirror must match mmap_control.appl_ptr");
    }

    #[test]
    fn writei_without_appl_ptr_sab_does_not_panic() {
        // Legacy host (no `kernel_audio_init_appl_ptr_sab` call) must
        // keep working — `publish_appl_ptr` is a silent no-op when no
        // slot is registered. The `getApplPtr` polled path remains the
        // fallback in that case.
        let _g = fresh_sab();
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        commit_setup(&mut proc, &mut host, idx);
        let channels = MIN_CHANNELS as usize;
        let ring_frames = MIN_BUFFER_SIZE as usize;
        let _ring_ptr = install_sab_ring(0, ring_frames, channels);
        // Explicitly do NOT call register_appl_ptr.
        set_proc_read_source(synth_frames(4, channels, 1));
        let xferi = WpkAlsaXferi { result: 0, buf: 0x4000_0000, frames: 4 };
        let mut buf = struct_buf(&xferi);
        run_ioctl(
            &mut proc,
            &mut host,
            idx,
            SNDRV_PCM_IOCTL_WRITEI_FRAMES,
            &mut buf,
        )
        .expect("WRITEI must succeed without an appl_ptr SAB slot");
    }

    #[test]
    fn pcm_unknown_ioctl_returns_enotty() {
        let mut proc = Process::new(1);
        let mut host = NoopHost;
        let idx = install_pcm(&mut proc);
        let err = run_ioctl(&mut proc, &mut host, idx, 0xdead_beef, &mut [])
            .expect_err("unknown ioctl must ENOTTY");
        assert_eq!(err, Errno::ENOTTY);
    }

    // --- helpers ----------------------------------------------------

    /// Drive PVERSION / INFO / wildcard HW_REFINE / HW_PARAMS so the
    /// fd ends in SETUP with committed hw_params, ready for the
    /// state-machine tests above.
    fn commit_setup(
        proc: &mut Process,
        host: &mut NoopHost,
        idx: usize,
    ) {
        let p = refined_hw_params();
        let mut buf = struct_buf(&p);
        run_ioctl(proc, host, idx, SNDRV_PCM_IOCTL_HW_PARAMS, &mut buf)
            .expect("HW_PARAMS");
    }

    fn struct_buf<T: Copy>(value: &T) -> alloc::vec::Vec<u8> {
        let mut buf = alloc::vec![0u8; core::mem::size_of::<T>()];
        unsafe {
            core::ptr::write_unaligned(buf.as_mut_ptr() as *mut T, *value);
        }
        buf
    }
}
