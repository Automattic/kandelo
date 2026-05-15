//! `/dev/dsp` — OSS-style PCM audio sink.
//!
//! Surface mirrors what the Linux Open Sound System (OSS) `dsp` device
//! exposes: a character device that user-space writes raw PCM frames
//! into, with a handful of `ioctl`s for sample rate / format / channel
//! count. The kernel does **not** synthesize or mix audio — DOOM's own
//! mixer fills its 16-bit-stereo buffer and `write()`s it here. The host
//! periodically drains the resulting byte stream via
//! [`drain_into`] (exposed as the `kernel_drain_audio` wasm export) and
//! feeds it to a Web Audio AudioContext.
//!
//! ## Format
//!
//! We accept exactly the format fbDOOM (and most OSS clients) configure
//! by default: signed-16-bit little-endian, stereo, ~11025–48000 Hz. The
//! `ioctl` handler validates each request and stores the chosen rate /
//! channel count so the host can pick them up via
//! [`current_config`]; anything else is `EINVAL`.
//!
//! ## Single-owner
//!
//! Like `/dev/fb0` and `/dev/input/mice`, `/dev/dsp` is single-open. A
//! second `open` from a different pid is `EBUSY`. Re-opens by the
//! current owner are accepted (matches the typical OSS exclusive-grab
//! model). Owner is released when the process closes its last `/dev/dsp`
//! fd, or exits, or `execve`s — at which point the ring is also
//! cleared so a successor open starts from silence.
//!
//! ## Backpressure
//!
//! The ring is bounded ([`MAX_QUEUED_BYTES`]) so a misbehaving program
//! that writes faster than the host drains can't OOM the kernel. When
//! the ring fills up, the oldest **whole frame** is dropped to make
//! room — never a partial frame, since downstream tooling assumes
//! interleaved L/R samples are paired. This is the same trade-off OSS
//! made on overrun: drop now, keep recent audio.

extern crate alloc;

use alloc::collections::VecDeque;
use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicI32, AtomicU32, Ordering};

/// Owning pid of `/dev/dsp`, or `-1` if free.
pub(crate) static DSP_OWNER: AtomicI32 = AtomicI32::new(-1);

/// Currently configured sample rate (Hz). Defaults to fbDOOM's preferred
/// 11025 Hz so a process that opens the device without ever calling
/// `SNDCTL_DSP_SPEED` still produces something playable.
pub(crate) static SAMPLE_RATE: AtomicU32 = AtomicU32::new(11025);

/// Currently configured channel count (1 = mono, 2 = stereo). Defaults
/// to stereo to match fbDOOM's default.
pub(crate) static CHANNELS: AtomicU32 = AtomicU32::new(2);

/// Bytes per S16_LE sample times channel count. Used to align ring
/// drops and reads to whole frames.
fn frame_bytes() -> usize {
    2 * (CHANNELS.load(Ordering::Relaxed) as usize).max(1)
}

/// Ring capacity in bytes. ~256 KiB → ~1.5 s of stereo S16 at 44100 Hz,
/// or ~6 s at 11025 Hz. Generous enough that the host can fall behind a
/// few RAFs without dropping audio, small enough that kernel memory
/// pressure stays bounded.
const MAX_QUEUED_BYTES: usize = 256 * 1024;

struct GlobalRing(UnsafeCell<VecDeque<u8>>);
unsafe impl Sync for GlobalRing {}

static RING: GlobalRing = GlobalRing(UnsafeCell::new(VecDeque::new()));

fn ring() -> &'static mut VecDeque<u8> {
    unsafe { &mut *RING.0.get() }
}

/// PCM format the device accepts. Matches OSS `AFMT_S16_LE` — signed
/// 16-bit little-endian. We don't allow other formats; `set_format`
/// rejects anything else with `EINVAL`.
pub(crate) const AFMT_S16_LE: u32 = 0x10;

/// Append `data` to the ring as raw bytes. Drops oldest *whole frames*
/// to fit `data.len()` if the ring is near capacity. Returns the number
/// of bytes actually buffered (always `data.len()` — overflow is
/// silent, mirroring what a real OSS device does on hardware overrun).
pub fn write_pcm(data: &[u8]) {
    let r = ring();
    let frame = frame_bytes();
    while r.len() + data.len() > MAX_QUEUED_BYTES {
        // Drop one frame from the front. A frame is 2-channel S16 by
        // default = 4 bytes. Tearing a frame would shift L/R alignment
        // for every subsequent drain, producing inverted-channel hiss.
        let drop = frame.min(r.len());
        if drop == 0 { break; }
        for _ in 0..drop {
            r.pop_front();
        }
    }
    for &b in data {
        r.push_back(b);
    }
}

/// Drain up to `out.len()` bytes from the ring into `out`. Returns the
/// number of bytes copied. Stops at whole-frame boundaries — never
/// returns a torn frame.
pub fn drain_into(out: &mut [u8]) -> usize {
    let r = ring();
    let frame = frame_bytes();
    let avail = r.len();
    let want = out.len();
    // Round both ends down to a whole frame so the host always receives
    // L/R pairs (when stereo) — feeding a torn frame to AudioContext
    // would swap channels for the rest of the stream.
    let n = core::cmp::min(want, avail);
    let n = (n / frame) * frame;
    for i in 0..n {
        out[i] = r.pop_front().unwrap_or(0);
    }
    n
}

/// Bytes currently buffered.
pub fn pending_bytes() -> usize {
    ring().len()
}

/// Drop all buffered samples. Called on process exit / exec by the
/// owner, and by `SNDCTL_DSP_RESET`.
pub fn reset() {
    ring().clear();
}

/// Set the sample rate (Hz). Returns the rate actually stored — OSS
/// behavior: clamp to a hardware-sensible range and report back what we
/// landed on. We accept the full range fbDOOM and similar consumers
/// emit (11025, 22050, 44100, 48000) plus reasonable extremes.
pub fn set_sample_rate(hz: u32) -> u32 {
    let clamped = hz.clamp(4000, 192000);
    SAMPLE_RATE.store(clamped, Ordering::Relaxed);
    clamped
}

/// Set channel count. Returns the count actually stored. Accepts 1 or
/// 2; anything else clamps to 2 (matches what real OSS drivers tend to
/// do — most cards don't support 3+ channels in dsp mode).
pub fn set_channels(n: u32) -> u32 {
    let n = if n == 1 { 1 } else { 2 };
    CHANNELS.store(n, Ordering::Relaxed);
    n
}

/// Validate the format. Only `AFMT_S16_LE` is supported — return
/// `false` for anything else so the ioctl handler can map it to
/// `EINVAL`.
pub fn set_format(fmt: u32) -> bool {
    fmt == AFMT_S16_LE
}

/// Snapshot of the current device config. Returned to the host so it
/// can configure its AudioContext. `(sample_rate_hz, channels)`.
pub fn current_config() -> (u32, u32) {
    (
        SAMPLE_RATE.load(Ordering::Relaxed),
        CHANNELS.load(Ordering::Relaxed),
    )
}

/// Serializes tests that touch the global ring + atomics. Shared
/// across `audio::tests` and `syscalls::tests` because both touch the
/// same process-global state — using two separate mutexes would let
/// them race when cargo runs them concurrently. Public-in-test only.
#[cfg(test)]
pub static TEST_RING_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> std::sync::MutexGuard<'static, ()> {
        // Tolerate poisoned locks from earlier failed assertions — the
        // ring is reset before each test, so prior panics don't leave
        // observable state behind.
        let g = TEST_RING_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        SAMPLE_RATE.store(11025, Ordering::Relaxed);
        CHANNELS.store(2, Ordering::Relaxed);
        g
    }

    #[test]
    fn empty_ring_drains_zero() {
        let _g = fresh();
        let mut buf = [0u8; 16];
        assert_eq!(drain_into(&mut buf), 0);
        assert_eq!(pending_bytes(), 0);
    }

    #[test]
    fn write_then_drain_roundtrip_preserves_bytes() {
        let _g = fresh();
        let frame = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];
        write_pcm(&frame);
        assert_eq!(pending_bytes(), 8);
        let mut out = [0u8; 8];
        assert_eq!(drain_into(&mut out), 8);
        assert_eq!(out, frame);
        assert_eq!(pending_bytes(), 0);
    }

    #[test]
    fn drain_rounds_down_to_whole_stereo_frame() {
        let _g = fresh();
        // Stereo S16 → 4 bytes/frame.
        let bytes: [u8; 12] = [0; 12];
        write_pcm(&bytes);
        let mut out = [0u8; 7]; // 7 < 8, should drain 4 bytes (one frame)
        assert_eq!(drain_into(&mut out), 4);
        assert_eq!(pending_bytes(), 8);
    }

    #[test]
    fn mono_drain_uses_2_byte_frames() {
        let _g = fresh();
        set_channels(1);
        let bytes: [u8; 6] = [1, 2, 3, 4, 5, 6];
        write_pcm(&bytes);
        let mut out = [0u8; 3]; // 3 < 4, should round down to 2 (one mono frame)
        assert_eq!(drain_into(&mut out), 2);
        assert_eq!(out[0], 1);
        assert_eq!(out[1], 2);
    }

    #[test]
    fn set_sample_rate_clamps_to_supported_range() {
        let _g = fresh();
        assert_eq!(set_sample_rate(44100), 44100);
        assert_eq!(set_sample_rate(0), 4000);
        assert_eq!(set_sample_rate(1_000_000), 192000);
        assert_eq!(current_config().0, 192000);
    }

    #[test]
    fn set_channels_only_accepts_mono_or_stereo() {
        let _g = fresh();
        assert_eq!(set_channels(1), 1);
        assert_eq!(set_channels(2), 2);
        // Anything weird normalizes to stereo — what real OSS drivers do.
        assert_eq!(set_channels(7), 2);
        assert_eq!(set_channels(0), 2);
    }

    #[test]
    fn set_format_rejects_anything_but_s16_le() {
        let _g = fresh();
        assert!(set_format(AFMT_S16_LE));
        assert!(!set_format(0x08)); // AFMT_U8
        assert!(!set_format(0x20)); // AFMT_S16_BE
        assert!(!set_format(0));
    }

    #[test]
    fn overflow_drops_oldest_whole_frame() {
        let _g = fresh();
        // Stereo S16 → 4-byte frames. Fill exactly to capacity, then add
        // one more frame: the head frame must drop.
        let mut head_frame = [0u8; 4];
        head_frame.copy_from_slice(&[0xAA, 0xBB, 0xCC, 0xDD]);
        write_pcm(&head_frame);

        // Pad up to capacity with a recognizable pattern.
        let pad = [0x11u8; MAX_QUEUED_BYTES - 4];
        write_pcm(&pad);
        assert_eq!(pending_bytes(), MAX_QUEUED_BYTES);

        // One more frame — head must drop.
        let new_frame = [0x42, 0x43, 0x44, 0x45];
        write_pcm(&new_frame);

        // Drain everything: should NOT see the original head frame.
        let mut all = vec![0u8; pending_bytes()];
        let n = drain_into(&mut all);
        assert_eq!(n, MAX_QUEUED_BYTES);
        // First 4 bytes are the start of the pad pattern, NOT the head_frame.
        assert_eq!(&all[0..4], &[0x11, 0x11, 0x11, 0x11]);
        // Tail is the freshest frame.
        assert_eq!(&all[MAX_QUEUED_BYTES - 4..], &new_frame);
    }

    #[test]
    fn reset_drops_pending() {
        let _g = fresh();
        write_pcm(&[1, 2, 3, 4]);
        assert_eq!(pending_bytes(), 4);
        reset();
        assert_eq!(pending_bytes(), 0);
    }
}
