//! Binary serialization/deserialization of Process state for fork.
//!
//! The binary format is little-endian and consists of:
//! - Header (12 bytes): magic, version, total_size
//! - Scalars (32 bytes): ppid, uid, gid, euid, egid, pgid, sid, umask
//! - Signal state (variable): blocked mask + non-default handlers
//! - FD table (variable): max_fds, then each open fd entry
//! - OFD table (variable): each open file description
//! - Environment (variable): env var strings
//! - CWD (variable): current working directory bytes
//! - Rlimits (256 bytes): 16 pairs of u64
//! - Terminal (56 bytes): flags, control chars, window size
//! - Program break (4 bytes): current brk value
//! - Memory layout metadata (20 bytes): initial brk, max addr, brk limit,
//!   mmap base, reserved prefix
//! - Mmap mappings

extern crate alloc;

use alloc::collections::BTreeSet;
use alloc::vec::Vec;
use wasm_posix_shared::Errno;
use wasm_posix_shared::fd_flags::FD_CLOEXEC;

use crate::fd::{FdEntry, FdTable, OpenFileDescRef};
use crate::lock::LockTable;
use crate::memory::{MappedRegion, MemoryLayoutMetadata, MemoryManager};
use crate::ofd::{FileType, OfdTable, OpenFileDesc};
use crate::process::{Process, ProcessState};
use crate::signal::{SignalAction, SignalHandler, SignalState};
use crate::socket::SocketTable;
use crate::terminal::{NCCS, TerminalState, WinSize};

const FORK_MAGIC: u32 = 0x464F524B; // "FORK"
const EXEC_MAGIC: u32 = 0x45584543; // "EXEC"
// v9 adds the per-OFD DRI sidecar block: a u8 variant tag followed by
// `DriFdState` / `KmsFdState` / `PrimeBoState` payload as appropriate.
// See `write_dri_state` / `read_dri_state` below.
const FORK_VERSION: u32 = 9;

// Bounds for deserialization to prevent OOM from malformed buffers.
const MAX_FDS: u32 = 65536;
const MAX_OFDS: u32 = 65536;
const MAX_ENV_VARS: u32 = 65536;
const MAX_ARGV: u32 = 65536;
const MAX_PATH_LEN: usize = 1048576; // 1 MiB
const MAX_STRING_LEN: usize = 1048576; // 1 MiB

// ── Writer helper ───────────────────────────────────────────────────────────

struct Writer<'a> {
    buf: &'a mut [u8],
    pos: usize,
}

impl<'a> Writer<'a> {
    fn new(buf: &'a mut [u8]) -> Self {
        Writer { buf, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    fn write_u8(&mut self, v: u8) -> Result<(), Errno> {
        if self.remaining() < 1 {
            return Err(Errno::ENOMEM);
        }
        self.buf[self.pos] = v;
        self.pos += 1;
        Ok(())
    }

    fn write_i32(&mut self, v: i32) -> Result<(), Errno> {
        if self.remaining() < 4 {
            return Err(Errno::ENOMEM);
        }
        self.buf[self.pos..self.pos + 4].copy_from_slice(&v.to_le_bytes());
        self.pos += 4;
        Ok(())
    }

    fn write_u16(&mut self, v: u16) -> Result<(), Errno> {
        if self.remaining() < 2 {
            return Err(Errno::ENOMEM);
        }
        self.buf[self.pos..self.pos + 2].copy_from_slice(&v.to_le_bytes());
        self.pos += 2;
        Ok(())
    }

    fn write_u32(&mut self, v: u32) -> Result<(), Errno> {
        if self.remaining() < 4 {
            return Err(Errno::ENOMEM);
        }
        self.buf[self.pos..self.pos + 4].copy_from_slice(&v.to_le_bytes());
        self.pos += 4;
        Ok(())
    }

    fn write_u64(&mut self, v: u64) -> Result<(), Errno> {
        if self.remaining() < 8 {
            return Err(Errno::ENOMEM);
        }
        self.buf[self.pos..self.pos + 8].copy_from_slice(&v.to_le_bytes());
        self.pos += 8;
        Ok(())
    }

    fn write_i64(&mut self, v: i64) -> Result<(), Errno> {
        if self.remaining() < 8 {
            return Err(Errno::ENOMEM);
        }
        self.buf[self.pos..self.pos + 8].copy_from_slice(&v.to_le_bytes());
        self.pos += 8;
        Ok(())
    }

    fn write_bytes(&mut self, data: &[u8]) -> Result<(), Errno> {
        if self.remaining() < data.len() {
            return Err(Errno::ENOMEM);
        }
        self.buf[self.pos..self.pos + data.len()].copy_from_slice(data);
        self.pos += data.len();
        Ok(())
    }

    /// Patch a u32 value at a previously written offset.
    fn patch_u32(&mut self, offset: usize, v: u32) {
        self.buf[offset..offset + 4].copy_from_slice(&v.to_le_bytes());
    }
}

// ── Reader helper ───────────────────────────────────────────────────────────

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    fn read_u8(&mut self) -> Result<u8, Errno> {
        if self.remaining() < 1 {
            return Err(Errno::EINVAL);
        }
        let v = self.buf[self.pos];
        self.pos += 1;
        Ok(v)
    }

    fn read_i32(&mut self) -> Result<i32, Errno> {
        if self.remaining() < 4 {
            return Err(Errno::EINVAL);
        }
        let v = i32::from_le_bytes([
            self.buf[self.pos],
            self.buf[self.pos + 1],
            self.buf[self.pos + 2],
            self.buf[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(v)
    }

    fn read_u16(&mut self) -> Result<u16, Errno> {
        if self.remaining() < 2 {
            return Err(Errno::EINVAL);
        }
        let v = u16::from_le_bytes([self.buf[self.pos], self.buf[self.pos + 1]]);
        self.pos += 2;
        Ok(v)
    }

    fn read_u32(&mut self) -> Result<u32, Errno> {
        if self.remaining() < 4 {
            return Err(Errno::EINVAL);
        }
        let v = u32::from_le_bytes([
            self.buf[self.pos],
            self.buf[self.pos + 1],
            self.buf[self.pos + 2],
            self.buf[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(v)
    }

    fn read_u64(&mut self) -> Result<u64, Errno> {
        if self.remaining() < 8 {
            return Err(Errno::EINVAL);
        }
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&self.buf[self.pos..self.pos + 8]);
        self.pos += 8;
        Ok(u64::from_le_bytes(bytes))
    }

    fn read_i64(&mut self) -> Result<i64, Errno> {
        if self.remaining() < 8 {
            return Err(Errno::EINVAL);
        }
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&self.buf[self.pos..self.pos + 8]);
        self.pos += 8;
        Ok(i64::from_le_bytes(bytes))
    }

    fn read_bytes(&mut self, len: usize) -> Result<&'a [u8], Errno> {
        if self.remaining() < len {
            return Err(Errno::EINVAL);
        }
        let data = &self.buf[self.pos..self.pos + len];
        self.pos += len;
        Ok(data)
    }

    /// Read bytes with an upper bound check to prevent OOM from malformed data.
    fn read_bounded_bytes(&mut self, len: usize, max: usize) -> Result<&'a [u8], Errno> {
        if len > max {
            return Err(Errno::EINVAL);
        }
        self.read_bytes(len)
    }
}

// ── FileType encoding ───────────────────────────────────────────────────────

fn file_type_to_u32(ft: FileType) -> u32 {
    match ft {
        FileType::Regular => 0,
        FileType::Directory => 1,
        FileType::Pipe => 2,
        FileType::CharDevice => 3,
        FileType::Socket => 4,
        FileType::EventFd => 5,
        FileType::Epoll => 6,
        FileType::TimerFd => 7,
        FileType::SignalFd => 8,
        FileType::MemFd => 9,
        FileType::PtyMaster => 10,
        FileType::PtySlave => 11,
    }
}

fn u32_to_file_type(v: u32) -> Result<FileType, Errno> {
    match v {
        0 => Ok(FileType::Regular),
        1 => Ok(FileType::Directory),
        2 => Ok(FileType::Pipe),
        3 => Ok(FileType::CharDevice),
        4 => Ok(FileType::Socket),
        5 => Ok(FileType::EventFd),
        6 => Ok(FileType::Epoll),
        7 => Ok(FileType::TimerFd),
        8 => Ok(FileType::SignalFd),
        9 => Ok(FileType::MemFd),
        10 => Ok(FileType::PtyMaster),
        11 => Ok(FileType::PtySlave),
        _ => Err(Errno::EINVAL),
    }
}

// ── DRI sidecar encoding ────────────────────────────────────────────────────
//
// Each OFD carries a one-byte variant tag (`DRI_TAG_*`) plus the bytes
// for the variant's payload. Bo refcount accounting moves entirely into
// the deserialize side: every bo id we restore on a handle, fb, or
// PrimeBo state gets an extra `with_registry(|r| r.incref(_))` so the
// child's eventual close-path decrefs are balanced.

const DRI_TAG_NONE: u8 = 0;
const DRI_TAG_RENDER_NODE: u8 = 1;
const DRI_TAG_CARD: u8 = 2;
const DRI_TAG_PRIME_BO: u8 = 3;

const INPUT_TAG_NONE: u8 = 0;
const INPUT_TAG_SOME: u8 = 1;

const AUDIO_TAG_NONE: u8 = 0;
const AUDIO_TAG_SOME: u8 = 1;

const AUDIO_CTL_TAG_NONE: u8 = 0;
const AUDIO_CTL_TAG_SOME: u8 = 1;

const PCM_DIR_PLAYBACK: u8 = 0;
const PCM_DIR_CAPTURE: u8 = 1;

fn write_dri_fd_state(
    w: &mut Writer<'_>,
    dri: &crate::ofd::DriFdState,
) -> Result<(), Errno> {
    w.write_u32(dri.handles.len() as u32)?;
    for (handle, bo_id) in &dri.handles {
        w.write_u32(*handle)?;
        w.write_u32(*bo_id)?;
    }
    w.write_u32(dri.next_handle)?;
    Ok(())
}

fn write_kms_fd_state(
    w: &mut Writer<'_>,
    kms: &crate::ofd::KmsFdState,
    preserve_master: bool,
) -> Result<(), Errno> {
    // Master is a singleton; only the exec path may preserve it
    // (the wasm image swaps but the process keeps its KMS lease).
    // Fork always writes 0 — the child must SET_MASTER itself.
    w.write_u8(if preserve_master && kms.holds_master {
        1
    } else {
        0
    })?;
    w.write_u32(kms.fbs.len() as u32)?;
    for (fb_id, fb) in &kms.fbs {
        w.write_u32(*fb_id)?;
        w.write_u32(fb.bo_id)?;
        w.write_u32(fb.width)?;
        w.write_u32(fb.height)?;
        w.write_u32(fb.pixel_format)?;
        w.write_u32(fb.stride)?;
    }
    w.write_u32(kms.next_fb_id)?;
    w.write_u32(kms.pending_flips.len() as u32)?;
    for flip in &kms.pending_flips {
        w.write_u32(flip.crtc_id)?;
        w.write_u32(flip.fb_id)?;
        w.write_u64(flip.user_data)?;
    }
    Ok(())
}

fn write_dri_state(
    w: &mut Writer<'_>,
    state: Option<&crate::ofd::DriOfdState>,
    preserve_master: bool,
) -> Result<(), Errno> {
    use crate::ofd::DriOfdState;
    match state {
        None => w.write_u8(DRI_TAG_NONE),
        Some(DriOfdState::RenderNode(d)) => {
            w.write_u8(DRI_TAG_RENDER_NODE)?;
            write_dri_fd_state(w, d)
        }
        Some(DriOfdState::Card { dri, kms }) => {
            w.write_u8(DRI_TAG_CARD)?;
            write_dri_fd_state(w, dri)?;
            write_kms_fd_state(w, kms, preserve_master)
        }
        Some(DriOfdState::PrimeBo(p)) => {
            w.write_u8(DRI_TAG_PRIME_BO)?;
            w.write_u32(p.bo_id)?;
            w.write_u64(p.cookie)
        }
    }
}

/// Serialise the evdev sidecar across a fork/exec. The ring is copied
/// byte-for-byte; the child inherits the parent's grab + dropped flag.
/// `EVIOCGRAB` is per-OFD in Linux, so each side of the fork ends up
/// with its own copy of the InputFdState.
fn write_input_state(
    w: &mut Writer<'_>,
    state: Option<&crate::ofd::InputFdState>,
) -> Result<(), Errno> {
    let Some(input) = state else {
        return w.write_u8(INPUT_TAG_NONE);
    };
    w.write_u8(INPUT_TAG_SOME)?;
    w.write_u8(input.device)?;
    w.write_u8(input.grabbed as u8)?;
    w.write_u8(input.dropped as u8)?;
    w.write_u32(input.event_ring.len() as u32)?;
    for &b in input.event_ring.iter() {
        w.write_u8(b)?;
    }
    Ok(())
}

/// Serialise the ALSA `/dev/snd/pcmC0D0p` sidecar across a fork/exec.
/// The child inherits the full state machine snapshot (state +
/// hw_params + sw_params + mmap pages + pcm_id). The SAB registry is a
/// global keyed by `pcm_id`; the kernel-side ring is not copied — both
/// sides keep referring to the same host-allocated buffer.
fn write_audio_state(
    w: &mut Writer<'_>,
    state: Option<&crate::ofd::AlsaFdState>,
) -> Result<(), Errno> {
    let Some(audio) = state else {
        return w.write_u8(AUDIO_TAG_NONE);
    };
    w.write_u8(AUDIO_TAG_SOME)?;
    w.write_u8(audio.card)?;
    w.write_u8(audio.device)?;
    w.write_u8(audio.sub)?;
    w.write_u8(match audio.kind {
        crate::ofd::PcmDir::Playback => PCM_DIR_PLAYBACK,
        crate::ofd::PcmDir::Capture => PCM_DIR_CAPTURE,
    })?;
    w.write_u32(audio.state)?;
    match audio.hw_params.as_deref() {
        None => w.write_u8(0)?,
        Some(hw) => {
            w.write_u8(1)?;
            w.write_u32(hw.format)?;
            w.write_u32(hw.access)?;
            w.write_u32(hw.channels)?;
            w.write_u32(hw.rate)?;
            w.write_u64(hw.period_size)?;
            w.write_u64(hw.buffer_size)?;
            w.write_u32(hw.periods)?;
        }
    }
    match audio.sw_params.as_deref() {
        None => w.write_u8(0)?,
        Some(sw) => {
            w.write_u8(1)?;
            w.write_u64(sw.avail_min)?;
            w.write_u64(sw.start_threshold)?;
            w.write_u64(sw.stop_threshold)?;
            w.write_u64(sw.boundary)?;
        }
    }
    match audio.mmap_status.as_deref() {
        None => w.write_u8(0)?,
        Some(s) => {
            w.write_u8(1)?;
            w.write_u32(s.state)?;
            w.write_u32(s.hw_ptr)?;
            w.write_i64(s.tstamp_sec)?;
            w.write_i32(s.tstamp_nsec)?;
            w.write_u32(s.suspended_state)?;
            w.write_i64(s.audio_tstamp_sec)?;
            w.write_i32(s.audio_tstamp_nsec)?;
        }
    }
    match audio.mmap_control.as_deref() {
        None => w.write_u8(0)?,
        Some(c) => {
            w.write_u8(1)?;
            w.write_u32(c.appl_ptr)?;
            w.write_u32(c.avail_min)?;
        }
    }
    w.write_u32(audio.pcm_id)?;
    Ok(())
}

/// Serialise the ALSA `/dev/snd/controlC0` sidecar across a fork/exec.
/// v1 carries only a card binding — `CARD_INFO` / `ELEM_LIST` serve
/// from kernel globals, so no further state.
fn write_audio_ctl_state(
    w: &mut Writer<'_>,
    state: Option<&crate::ofd::AlsaControlFdState>,
) -> Result<(), Errno> {
    let Some(ctl) = state else {
        return w.write_u8(AUDIO_CTL_TAG_NONE);
    };
    w.write_u8(AUDIO_CTL_TAG_SOME)?;
    w.write_u8(ctl.card)?;
    Ok(())
}

/// Read a `DriFdState` from the wire and incref every referenced bo
/// in the global registry so the new OFD has its own refcount. The
/// caller may still drop the entire OFD if the surrounding deserialize
/// fails; the trail of increfs is harmless in that case (the OFD's
/// eventual close-path decref balances it).
fn read_dri_fd_state(r: &mut Reader<'_>) -> Result<crate::ofd::DriFdState, Errno> {
    use alloc::collections::BTreeMap;
    let handle_count = r.read_u32()? as usize;
    if handle_count > 65536 {
        return Err(Errno::EINVAL);
    }
    let mut handles: BTreeMap<u32, crate::dri::BoId> = BTreeMap::new();
    for _ in 0..handle_count {
        let handle = r.read_u32()?;
        let bo_id = r.read_u32()?;
        crate::dri::with_registry(|reg| {
            reg.incref(bo_id);
        });
        handles.insert(handle, bo_id);
    }
    let next_handle = r.read_u32()?;
    Ok(crate::ofd::DriFdState {
        handles,
        next_handle,
        gl: None,
    })
}

fn read_kms_fd_state(r: &mut Reader<'_>) -> Result<crate::ofd::KmsFdState, Errno> {
    use alloc::collections::{BTreeMap, VecDeque};
    let holds_master = r.read_u8()? != 0;
    let fb_count = r.read_u32()? as usize;
    if fb_count > 65536 {
        return Err(Errno::EINVAL);
    }
    let mut fbs: BTreeMap<u32, crate::ofd::KmsFb> = BTreeMap::new();
    for _ in 0..fb_count {
        let fb_id = r.read_u32()?;
        let bo_id = r.read_u32()?;
        let width = r.read_u32()?;
        let height = r.read_u32()?;
        let pixel_format = r.read_u32()?;
        let stride = r.read_u32()?;
        crate::dri::with_registry(|reg| {
            reg.incref(bo_id);
        });
        fbs.insert(
            fb_id,
            crate::ofd::KmsFb {
                bo_id,
                width,
                height,
                pixel_format,
                stride,
            },
        );
    }
    let next_fb_id = r.read_u32()?;
    let pending_count = r.read_u32()? as usize;
    if pending_count > 65536 {
        return Err(Errno::EINVAL);
    }
    let mut pending_flips = Vec::with_capacity(pending_count);
    for _ in 0..pending_count {
        let crtc_id = r.read_u32()?;
        let fb_id = r.read_u32()?;
        let user_data = r.read_u64()?;
        pending_flips.push(crate::ofd::PendingFlip {
            crtc_id,
            fb_id,
            user_data,
        });
    }
    Ok(crate::ofd::KmsFdState {
        holds_master,
        fbs,
        next_fb_id,
        pending_flips,
        event_ring: VecDeque::new(),
    })
}

fn read_input_state(
    r: &mut Reader<'_>,
) -> Result<Option<alloc::boxed::Box<crate::ofd::InputFdState>>, Errno> {
    use alloc::collections::VecDeque;
    let tag = r.read_u8()?;
    match tag {
        INPUT_TAG_NONE => Ok(None),
        INPUT_TAG_SOME => {
            let device = r.read_u8()?;
            let grabbed = r.read_u8()? != 0;
            let dropped = r.read_u8()? != 0;
            let ring_len = r.read_u32()? as usize;
            // The ring is always whole 24-byte records and bounded at
            // INPUT_RING_MAX_BYTES — reject anything else as a
            // corrupted/forged fork stream.
            if ring_len > crate::ofd::INPUT_RING_MAX_BYTES
                || ring_len % core::mem::size_of::<
                    wasm_posix_shared::input::WpkInputEvent,
                >() != 0
            {
                return Err(Errno::EINVAL);
            }
            let mut event_ring = VecDeque::with_capacity(ring_len);
            for _ in 0..ring_len {
                event_ring.push_back(r.read_u8()?);
            }
            Ok(Some(alloc::boxed::Box::new(crate::ofd::InputFdState {
                device,
                event_ring,
                grabbed,
                dropped,
            })))
        }
        _ => Err(Errno::EINVAL),
    }
}

fn read_audio_state(
    r: &mut Reader<'_>,
) -> Result<Option<alloc::boxed::Box<crate::ofd::AlsaFdState>>, Errno> {
    use wasm_posix_shared::audio::{WpkAlsaPcmMmapControl, WpkAlsaPcmMmapStatus};
    let tag = r.read_u8()?;
    match tag {
        AUDIO_TAG_NONE => Ok(None),
        AUDIO_TAG_SOME => {
            let card = r.read_u8()?;
            let device = r.read_u8()?;
            let sub = r.read_u8()?;
            let kind = match r.read_u8()? {
                PCM_DIR_PLAYBACK => crate::ofd::PcmDir::Playback,
                PCM_DIR_CAPTURE => crate::ofd::PcmDir::Capture,
                _ => return Err(Errno::EINVAL),
            };
            let state = r.read_u32()?;
            let hw_params = match r.read_u8()? {
                0 => None,
                1 => Some(alloc::boxed::Box::new(crate::ofd::HwParamsCache {
                    format: r.read_u32()?,
                    access: r.read_u32()?,
                    channels: r.read_u32()?,
                    rate: r.read_u32()?,
                    period_size: r.read_u64()?,
                    buffer_size: r.read_u64()?,
                    periods: r.read_u32()?,
                })),
                _ => return Err(Errno::EINVAL),
            };
            let sw_params = match r.read_u8()? {
                0 => None,
                1 => Some(alloc::boxed::Box::new(crate::ofd::SwParamsCache {
                    avail_min: r.read_u64()?,
                    start_threshold: r.read_u64()?,
                    stop_threshold: r.read_u64()?,
                    boundary: r.read_u64()?,
                })),
                _ => return Err(Errno::EINVAL),
            };
            let mmap_status = match r.read_u8()? {
                0 => None,
                1 => {
                    let s_state = r.read_u32()?;
                    let hw_ptr = r.read_u32()?;
                    let tstamp_sec = r.read_i64()?;
                    let tstamp_nsec = r.read_i32()?;
                    let suspended_state = r.read_u32()?;
                    let audio_tstamp_sec = r.read_i64()?;
                    let audio_tstamp_nsec = r.read_i32()?;
                    Some(alloc::boxed::Box::new(WpkAlsaPcmMmapStatus {
                        state: s_state,
                        _pad1: 0,
                        hw_ptr,
                        _pad_after_hw_ptr: 0,
                        tstamp_sec,
                        tstamp_nsec,
                        _tstamp_pad: 0,
                        suspended_state,
                        _pad3: 0,
                        audio_tstamp_sec,
                        audio_tstamp_nsec,
                        _audio_tstamp_pad: 0,
                    }))
                }
                _ => return Err(Errno::EINVAL),
            };
            let mmap_control = match r.read_u8()? {
                0 => None,
                1 => {
                    let appl_ptr = r.read_u32()?;
                    let avail_min = r.read_u32()?;
                    Some(alloc::boxed::Box::new(WpkAlsaPcmMmapControl {
                        appl_ptr,
                        avail_min,
                        _pad_after: 0,
                    }))
                }
                _ => return Err(Errno::EINVAL),
            };
            let pcm_id = r.read_u32()?;
            Ok(Some(alloc::boxed::Box::new(crate::ofd::AlsaFdState {
                card,
                device,
                sub,
                kind,
                state,
                hw_params,
                sw_params,
                mmap_status,
                mmap_control,
                pcm_id,
            })))
        }
        _ => Err(Errno::EINVAL),
    }
}

fn read_audio_ctl_state(
    r: &mut Reader<'_>,
) -> Result<Option<alloc::boxed::Box<crate::ofd::AlsaControlFdState>>, Errno> {
    let tag = r.read_u8()?;
    match tag {
        AUDIO_CTL_TAG_NONE => Ok(None),
        AUDIO_CTL_TAG_SOME => {
            let card = r.read_u8()?;
            Ok(Some(alloc::boxed::Box::new(crate::ofd::AlsaControlFdState { card })))
        }
        _ => Err(Errno::EINVAL),
    }
}

fn read_dri_state(
    r: &mut Reader<'_>,
) -> Result<Option<alloc::boxed::Box<crate::ofd::DriOfdState>>, Errno> {
    use crate::ofd::{DriOfdState, PrimeBoState};
    let tag = r.read_u8()?;
    Ok(match tag {
        DRI_TAG_NONE => None,
        DRI_TAG_RENDER_NODE => {
            let d = read_dri_fd_state(r)?;
            Some(alloc::boxed::Box::new(DriOfdState::RenderNode(d)))
        }
        DRI_TAG_CARD => {
            let dri = read_dri_fd_state(r)?;
            let kms = read_kms_fd_state(r)?;
            Some(alloc::boxed::Box::new(DriOfdState::Card { dri, kms }))
        }
        DRI_TAG_PRIME_BO => {
            let bo_id = r.read_u32()?;
            let cookie = r.read_u64()?;
            crate::dri::with_registry(|reg| {
                reg.incref(bo_id);
            });
            Some(alloc::boxed::Box::new(DriOfdState::PrimeBo(PrimeBoState {
                bo_id,
                cookie,
            })))
        }
        _ => return Err(Errno::EINVAL),
    })
}

// ── SignalHandler encoding ──────────────────────────────────────────────────

fn handler_to_u32(h: SignalHandler) -> u32 {
    match h {
        SignalHandler::Default => 0,
        SignalHandler::Ignore => 1,
        SignalHandler::Handler(ptr) => 2 + ptr,
    }
}

fn u32_to_handler(v: u32) -> SignalHandler {
    match v {
        0 => SignalHandler::Default,
        1 => SignalHandler::Ignore,
        n => SignalHandler::Handler(n - 2),
    }
}

// ── Serialize ───────────────────────────────────────────────────────────────

/// Serialize the process state into a binary buffer for fork.
///
/// Returns the number of bytes written on success, or `Errno::ENOMEM` if
/// the buffer is too small.
pub fn serialize_fork_state(proc: &Process, buf: &mut [u8]) -> Result<usize, Errno> {
    let mut w = Writer::new(buf);

    // ── Header (12 bytes) ──
    w.write_u32(FORK_MAGIC)?;
    w.write_u32(FORK_VERSION)?;
    let total_size_offset = w.pos;
    w.write_u32(0)?; // placeholder for total_size

    // ── Scalars (32 bytes) ──
    // Write the parent's pid as the child's ppid (child's parent is this process)
    w.write_u32(proc.pid)?;
    w.write_u32(proc.uid)?;
    w.write_u32(proc.gid)?;
    w.write_u32(proc.euid)?;
    w.write_u32(proc.egid)?;
    w.write_u32(proc.pgid)?;
    w.write_u32(proc.sid)?;
    w.write_u32(proc.umask)?;
    w.write_u32(proc.nice as u32)?;
    w.write_u32(proc.is_session_leader as u32)?;

    // ── Signal state ──
    w.write_u64(proc.signals.blocked)?;

    // Count non-default actions (handler, flags, mask)
    let non_default_count = (1..65u32)
        .filter(|&i| {
            proc.signals.get_handler(i) != SignalHandler::Default
                || proc.signals.get_action(i).flags != 0
                || proc.signals.get_action(i).mask != 0
        })
        .count() as u32;
    w.write_u32(non_default_count)?;

    for i in 1..65u32 {
        let action = proc.signals.get_action(i);
        if action.handler != SignalHandler::Default || action.flags != 0 || action.mask != 0 {
            w.write_u32(i)?;
            w.write_u32(handler_to_u32(action.handler))?;
            w.write_u32(action.flags)?;
            w.write_u64(action.mask)?;
        }
    }

    // ── FD table ──
    w.write_u32(proc.fd_table.max_fds() as u32)?;
    let fd_entries: Vec<(i32, &FdEntry)> = proc.fd_table.iter().collect();
    w.write_u32(fd_entries.len() as u32)?;
    for (fd_num, entry) in &fd_entries {
        w.write_u32(*fd_num as u32)?;
        w.write_u32(entry.ofd_ref.0 as u32)?;
        w.write_u32(entry.fd_flags)?;
    }

    // ── OFD table ──
    let ofd_entries: Vec<(usize, &OpenFileDesc)> = proc.ofd_table.iter().collect();
    w.write_u32(ofd_entries.len() as u32)?;
    for (index, ofd) in &ofd_entries {
        w.write_u32(*index as u32)?;
        w.write_u32(file_type_to_u32(ofd.file_type))?;
        w.write_u32(ofd.status_flags)?;
        w.write_i64(ofd.host_handle)?;
        w.write_i64(ofd.offset)?;
        w.write_u32(ofd.ref_count)?;
        w.write_u32(ofd.path.len() as u32)?;
        w.write_bytes(&ofd.path)?;
        // DRI sidecar — `preserve_master = false` because the master
        // lease must drop on fork (only one process may hold it).
        write_dri_state(&mut w, ofd.dri_state.as_deref(), false)?;
        // evdev sidecar — child inherits the per-OFD ring + grab.
        write_input_state(&mut w, ofd.input_state.as_deref())?;
        // ALSA sidecars — child inherits the PCM state machine snapshot
        // and the controlC0 card binding. The SAB registry is global by
        // `pcm_id` so no per-fork copy is needed.
        write_audio_state(&mut w, ofd.audio.as_deref())?;
        write_audio_ctl_state(&mut w, ofd.audio_ctl.as_deref())?;
    }

    // ── Environment ──
    w.write_u32(proc.environ.len() as u32)?;
    for var in &proc.environ {
        w.write_u32(var.len() as u32)?;
        w.write_bytes(var)?;
    }

    // ── Argv ──
    w.write_u32(proc.argv.len() as u32)?;
    for arg in &proc.argv {
        w.write_u32(arg.len() as u32)?;
        w.write_bytes(arg)?;
    }

    // ── CWD ──
    w.write_u32(proc.cwd.len() as u32)?;
    w.write_bytes(&proc.cwd)?;

    // ── Rlimits (256 bytes) ──
    for pair in &proc.rlimits {
        w.write_u64(pair[0])?;
        w.write_u64(pair[1])?;
    }

    // ── Terminal ──
    w.write_u32(proc.terminal.c_iflag)?;
    w.write_u32(proc.terminal.c_oflag)?;
    w.write_u32(proc.terminal.c_cflag)?;
    w.write_u32(proc.terminal.c_lflag)?;
    w.write_bytes(&proc.terminal.c_cc)?;
    w.write_u16(proc.terminal.winsize.ws_row)?;
    w.write_u16(proc.terminal.winsize.ws_col)?;
    w.write_u16(proc.terminal.winsize.ws_xpixel)?;
    w.write_u16(proc.terminal.winsize.ws_ypixel)?;
    w.write_u8(proc.terminal.c_line)?;
    w.write_u32(proc.terminal.c_ispeed)?;
    w.write_u32(proc.terminal.c_ospeed)?;
    w.write_i32(proc.terminal.session_id)?;

    // ── Program break ──
    w.write_u32(proc.memory.get_brk() as u32)?;
    let memory_layout = proc.memory.layout_metadata();
    w.write_u32(memory_layout.initial_brk as u32)?;
    w.write_u32(memory_layout.max_addr as u32)?;
    w.write_u32(memory_layout.brk_limit as u32)?;
    w.write_u32(memory_layout.mmap_base as u32)?;
    w.write_u32(memory_layout.reserved_until as u32)?;

    // ── mmap mappings (v5) ──
    let mappings = proc.memory.mappings();
    w.write_u32(mappings.len() as u32)?;
    for m in mappings {
        w.write_u32(m.addr as u32)?;
        w.write_u32(m.len as u32)?;
        w.write_u32(m.prot)?;
        w.write_u32(m.flags)?;
    }

    // ── Fork exec state (v3) ──
    // exec_path: u32 len then bytes (0 = none)
    match &proc.fork_exec_path {
        Some(path) => {
            w.write_u32(path.len() as u32)?;
            w.write_bytes(path)?;
        }
        None => w.write_u32(0)?,
    }
    // exec_argv: u32 count then each (u32 len, bytes)
    match &proc.fork_exec_argv {
        Some(argv) => {
            w.write_u32(argv.len() as u32)?;
            for arg in argv {
                w.write_u32(arg.len() as u32)?;
                w.write_bytes(arg)?;
            }
        }
        None => w.write_u32(0)?,
    }
    // fd_actions: u32 count then each (u32 type, u32 fd1, u32 fd2)
    w.write_u32(proc.fork_fd_actions.len() as u32)?;
    for action in &proc.fork_fd_actions {
        use crate::process::FdAction;
        match action {
            FdAction::Dup2 { old_fd, new_fd } => {
                w.write_u32(0)?;
                w.write_u32(*old_fd as u32)?;
                w.write_u32(*new_fd as u32)?;
            }
            FdAction::Close { fd } => {
                w.write_u32(1)?;
                w.write_u32(*fd as u32)?;
                w.write_u32(0)?;
            }
            FdAction::Open { fd, .. } => {
                w.write_u32(2)?;
                w.write_u32(*fd as u32)?;
                w.write_u32(0)?;
            }
        }
    }

    // ── Socket table (v4) ──
    {
        use crate::socket::{SocketDomain, SocketState, SocketType};
        // Count actual sockets
        let mut sock_count = 0u32;
        for idx in 0..proc.sockets.len() {
            if proc.sockets.get(idx).is_some() {
                sock_count += 1;
            }
        }
        w.write_u32(proc.sockets.len() as u32)?; // total slots (for index preservation)
        w.write_u32(sock_count)?;
        for idx in 0..proc.sockets.len() {
            if let Some(sock) = proc.sockets.get(idx) {
                w.write_u32(idx as u32)?;
                w.write_u32(match sock.domain {
                    SocketDomain::Unix => 0,
                    SocketDomain::Inet => 1,
                    SocketDomain::Inet6 => 2,
                })?;
                w.write_u32(match sock.sock_type {
                    SocketType::Stream => 0,
                    SocketType::Dgram => 1,
                })?;
                w.write_u32(sock.protocol)?;
                w.write_u32(match sock.state {
                    SocketState::Unbound => 0,
                    SocketState::Bound => 1,
                    SocketState::Listening => 2,
                    SocketState::Connected => 3,
                    SocketState::Closed => 4,
                    // The live host net.Socket can't cross fork.
                    SocketState::Connecting => 4,
                })?;
                // peer_idx, recv_buf_idx, send_buf_idx as Option<u32> (0xFFFFFFFF = None)
                w.write_u32(sock.peer_idx.map(|v| v as u32).unwrap_or(0xFFFFFFFF))?;
                w.write_u32(sock.recv_buf_idx.map(|v| v as u32).unwrap_or(0xFFFFFFFF))?;
                w.write_u32(sock.send_buf_idx.map(|v| v as u32).unwrap_or(0xFFFFFFFF))?;
                w.write_u32(if sock.shut_rd { 1 } else { 0 })?;
                w.write_u32(if sock.shut_wr { 1 } else { 0 })?;
                w.write_u32(sock.host_net_handle.map(|v| v as u32).unwrap_or(0xFFFFFFFF))?;
                // Socket options
                w.write_u32(sock.options.len() as u32)?;
                for &(level, optname, value) in &sock.options {
                    w.write_u32(level)?;
                    w.write_u32(optname)?;
                    w.write_u32(value)?;
                }
                // Bind/peer addresses
                w.write_bytes(&sock.bind_addr)?;
                w.write_u32(sock.bind_port as u32)?;
                w.write_bytes(&sock.peer_addr)?;
                w.write_u32(sock.peer_port as u32)?;
                // Listen backlog: write 0-length. Pre-accepted AF_UNIX
                // same-process connections are consume-once and stay with
                // the parent — see SocketInfo's hand-written Clone. This
                // field is preserved in the wire format (always 0) for
                // backward compatibility with the deserialize side, which
                // reads-and-discards.
                w.write_u32(0u32)?;
                // Global pipes flag (cross-process loopback)
                w.write_u32(if sock.global_pipes { 1 } else { 0 })?;
                // Shared listener backlog idx (AF_INET listening sockets).
                // 0xFFFFFFFF = None.
                w.write_u32(
                    sock.shared_backlog_idx
                        .map(|v| v as u32)
                        .unwrap_or(0xFFFFFFFF),
                )?;
                // bind_path for AF_UNIX
                match &sock.bind_path {
                    Some(p) => {
                        w.write_u32(p.len() as u32)?;
                        w.write_bytes(p)?;
                    }
                    None => {
                        w.write_u32(0xFFFFFFFF)?;
                    }
                }
                // Accept wake token for listening sockets. This must be
                // inherited so forked listeners register against the same
                // readiness event as the parent.
                w.write_u32(sock.accept_wake_idx.unwrap_or(0xFFFFFFFF))?;
                // Skip dgram_queue for fork (child starts with empty queue)
            }
        }
    }

    // ── Patch total_size ──
    let total = w.pos as u32;
    w.patch_u32(total_size_offset, total);

    Ok(w.pos)
}

// ── Deserialize ─────────────────────────────────────────────────────────────

/// Deserialize process state from a fork buffer, creating a new child process.
///
/// The child process gets:
/// - `pid = child_pid`
/// - `state = ProcessState::Running`
/// - `exit_status = 0`
/// - Empty lock table, pipes, dir_streams, memory (per POSIX)
/// - Sockets are cloned from parent (POSIX: child inherits open fds including sockets)
/// - `signals.pending = 0` (via `SignalState::from_parts`)
pub fn deserialize_fork_state(buf: &[u8], child_pid: u32) -> Result<Process, Errno> {
    let mut r = Reader::new(buf);

    // ── Header ──
    let magic = r.read_u32()?;
    if magic != FORK_MAGIC {
        return Err(Errno::EINVAL);
    }
    let version = r.read_u32()?;
    if version != FORK_VERSION {
        return Err(Errno::EINVAL);
    }
    let _total_size = r.read_u32()?;

    // ── Scalars ──
    let ppid = r.read_u32()?;
    let uid = r.read_u32()?;
    let gid = r.read_u32()?;
    let euid = r.read_u32()?;
    let egid = r.read_u32()?;
    let pgid = r.read_u32()?;
    let sid = r.read_u32()?;
    let umask = r.read_u32()?;
    let nice = r.read_u32()? as i32;
    let _parent_is_session_leader = r.read_u32()? != 0; // inherited as false for fork children

    // ── Signal state ──
    let blocked = r.read_u64()?;
    let handler_count = r.read_u32()?;
    if handler_count > 64 {
        return Err(Errno::EINVAL);
    }
    let mut actions = [SignalAction::default(); 65];
    for _ in 0..handler_count {
        let signum = r.read_u32()?;
        let handler_val = r.read_u32()?;
        let flags = r.read_u32()?;
        let mask = r.read_u64()?;
        if (signum as usize) < 65 {
            actions[signum as usize] = SignalAction {
                handler: u32_to_handler(handler_val),
                flags,
                mask,
            };
        }
    }
    let signals = SignalState::from_actions(actions, blocked);

    // ── FD table ──
    let max_fds = r.read_u32()? as usize;
    let fd_count = r.read_u32()?;
    if fd_count > MAX_FDS {
        return Err(Errno::EINVAL);
    }
    let mut fd_entries: Vec<Option<FdEntry>> = Vec::new();
    for _ in 0..fd_count {
        let fd_num = r.read_u32()? as usize;
        let ofd_index = r.read_u32()? as usize;
        let fd_flags = r.read_u32()?;
        // FD_CLOFORK: skip FDs marked close-on-fork
        if fd_flags & wasm_posix_shared::fd_flags::FD_CLOFORK != 0 {
            continue;
        }
        while fd_entries.len() <= fd_num {
            fd_entries.push(None);
        }
        fd_entries[fd_num] = Some(FdEntry {
            ofd_ref: OpenFileDescRef(ofd_index),
            fd_flags,
        });
    }
    let fd_table = FdTable::from_raw(fd_entries, max_fds);

    // ── OFD table ──
    let ofd_count = r.read_u32()?;
    if ofd_count > MAX_OFDS {
        return Err(Errno::EINVAL);
    }
    let mut ofd_entries: Vec<Option<OpenFileDesc>> = Vec::new();
    for _ in 0..ofd_count {
        let index = r.read_u32()? as usize;
        let file_type = u32_to_file_type(r.read_u32()?)?;
        let status_flags = r.read_u32()?;
        let host_handle = r.read_i64()?;
        let offset = r.read_i64()?;
        let ref_count = r.read_u32()?;
        let path_len = r.read_u32()? as usize;
        let path = r.read_bounded_bytes(path_len, MAX_PATH_LEN)?.to_vec();
        while ofd_entries.len() <= index {
            ofd_entries.push(None);
        }
        let dri_state = read_dri_state(&mut r)?;
        let input_state = read_input_state(&mut r)?;
        let audio = read_audio_state(&mut r)?;
        let audio_ctl = read_audio_ctl_state(&mut r)?;
        ofd_entries[index] = Some(OpenFileDesc {
            file_type,
            status_flags,
            host_handle,
            offset,
            ref_count,
            owner_pid: child_pid,
            path,
            dir_host_handle: -1,
            dir_synth_state: 0,
            dir_entry_offset: 0,
            dri_state,
            input_state,
            audio,
            audio_ctl,
        });
    }
    let ofd_table = OfdTable::from_raw(ofd_entries);

    // ── Environment ──
    let env_count = r.read_u32()?;
    if env_count > MAX_ENV_VARS {
        return Err(Errno::EINVAL);
    }
    let mut environ = Vec::with_capacity(env_count as usize);
    for _ in 0..env_count {
        let len = r.read_u32()? as usize;
        let data = r.read_bounded_bytes(len, MAX_STRING_LEN)?;
        environ.push(data.to_vec());
    }

    // ── Argv ──
    let argv_count = r.read_u32()?;
    if argv_count > MAX_ARGV {
        return Err(Errno::EINVAL);
    }
    let mut argv = Vec::with_capacity(argv_count as usize);
    for _ in 0..argv_count {
        let len = r.read_u32()? as usize;
        let data = r.read_bounded_bytes(len, MAX_STRING_LEN)?;
        argv.push(data.to_vec());
    }

    // ── CWD ──
    let cwd_len = r.read_u32()? as usize;
    let cwd_data = r.read_bounded_bytes(cwd_len, MAX_PATH_LEN)?;
    let cwd = cwd_data.to_vec();

    // ── Rlimits ──
    let mut rlimits = [[0u64; 2]; 16];
    for pair in rlimits.iter_mut() {
        pair[0] = r.read_u64()?;
        pair[1] = r.read_u64()?;
    }

    // ── Terminal ──
    let c_iflag = r.read_u32()?;
    let c_oflag = r.read_u32()?;
    let c_cflag = r.read_u32()?;
    let c_lflag = r.read_u32()?;
    let c_cc_data = r.read_bytes(NCCS)?;
    let mut c_cc = [0u8; NCCS];
    c_cc.copy_from_slice(c_cc_data);
    let ws_row = r.read_u16()?;
    let ws_col = r.read_u16()?;
    let ws_xpixel = r.read_u16()?;
    let ws_ypixel = r.read_u16()?;
    let c_line = r.read_u8().unwrap_or(0);
    let c_ispeed = r.read_u32().unwrap_or(0o0000017); // B38400
    let c_ospeed = r.read_u32().unwrap_or(0o0000017);
    let session_id = r.read_i32().unwrap_or(0);

    let terminal = TerminalState {
        c_iflag,
        c_oflag,
        c_cflag,
        c_lflag,
        c_line,
        c_cc,
        c_ispeed,
        c_ospeed,
        winsize: WinSize {
            ws_row,
            ws_col,
            ws_xpixel,
            ws_ypixel,
        },
        foreground_pgid: 1,
        session_id,
        line_buffer: Vec::new(),
        cooked_buffer: Vec::new(),
    };

    // ── Program break ──
    let program_break = r.read_u32()?;
    let memory_layout = MemoryLayoutMetadata {
        initial_brk: r.read_u32()? as usize,
        max_addr: r.read_u32()? as usize,
        brk_limit: r.read_u32()? as usize,
        mmap_base: r.read_u32()? as usize,
        reserved_until: r.read_u32()? as usize,
    };
    let mut memory = MemoryManager::new();
    memory.set_layout_metadata(memory_layout);
    memory.set_brk(program_break as usize);

    // ── mmap mappings (v5) ──
    if r.remaining() >= 4 {
        let mapping_count = r.read_u32()? as usize;
        if mapping_count > 4096 {
            return Err(Errno::EINVAL);
        }
        let mut mappings = Vec::with_capacity(mapping_count);
        for _ in 0..mapping_count {
            let addr = r.read_u32()? as usize;
            let len = r.read_u32()? as usize;
            let prot = r.read_u32()?;
            let flags = r.read_u32()?;
            mappings.push(MappedRegion {
                addr,
                len,
                prot,
                flags,
            });
        }
        memory.set_mappings(mappings);
    }

    // ── Fork exec state (v3) ──
    let fork_exec_path = if r.remaining() >= 4 {
        let path_len = r.read_u32()? as usize;
        if path_len > 0 {
            Some(r.read_bounded_bytes(path_len, MAX_PATH_LEN)?.to_vec())
        } else {
            None
        }
    } else {
        None
    };
    let fork_exec_argv = if r.remaining() >= 4 {
        let argc = r.read_u32()? as usize;
        if argc > 0 {
            if argc > MAX_ARGV as usize {
                return Err(Errno::EINVAL);
            }
            let mut args = Vec::with_capacity(argc);
            for _ in 0..argc {
                let len = r.read_u32()? as usize;
                args.push(r.read_bounded_bytes(len, MAX_STRING_LEN)?.to_vec());
            }
            Some(args)
        } else {
            None
        }
    } else {
        None
    };
    let mut fork_fd_actions = Vec::new();
    if r.remaining() >= 4 {
        let action_count = r.read_u32()? as usize;
        for _ in 0..action_count {
            let action_type = r.read_u32()?;
            let fd1 = r.read_u32()? as i32;
            let fd2 = r.read_u32()? as i32;
            use crate::process::FdAction;
            match action_type {
                0 => fork_fd_actions.push(FdAction::Dup2 {
                    old_fd: fd1,
                    new_fd: fd2,
                }),
                1 => fork_fd_actions.push(FdAction::Close { fd: fd1 }),
                _ => {} // skip unknown actions
            }
        }
    }

    // ── Socket table (v4) ──
    let mut sockets = SocketTable::new();
    if r.remaining() >= 8 {
        use crate::socket::{SocketDomain, SocketInfo, SocketState, SocketType};
        let _total_slots = r.read_u32()? as usize;
        let sock_count = r.read_u32()? as usize;
        for _ in 0..sock_count {
            let idx = r.read_u32()? as usize;
            let domain = match r.read_u32()? {
                0 => SocketDomain::Unix,
                1 => SocketDomain::Inet,
                2 => SocketDomain::Inet6,
                _ => return Err(Errno::EINVAL),
            };
            let sock_type = match r.read_u32()? {
                0 => SocketType::Stream,
                1 => SocketType::Dgram,
                _ => return Err(Errno::EINVAL),
            };
            let protocol = r.read_u32()?;
            let state = match r.read_u32()? {
                0 => SocketState::Unbound,
                1 => SocketState::Bound,
                2 => SocketState::Listening,
                3 => SocketState::Connected,
                4 => SocketState::Closed,
                _ => return Err(Errno::EINVAL),
            };
            let peer_idx_raw = r.read_u32()?;
            let peer_idx = if peer_idx_raw == 0xFFFFFFFF {
                None
            } else {
                Some(peer_idx_raw as usize)
            };
            let recv_raw = r.read_u32()?;
            let recv_buf_idx = if recv_raw == 0xFFFFFFFF {
                None
            } else {
                Some(recv_raw as usize)
            };
            let send_raw = r.read_u32()?;
            let send_buf_idx = if send_raw == 0xFFFFFFFF {
                None
            } else {
                Some(send_raw as usize)
            };
            let shut_rd = r.read_u32()? != 0;
            let shut_wr = r.read_u32()? != 0;
            let hnh_raw = r.read_u32()?;
            let host_net_handle = if hnh_raw == 0xFFFFFFFF {
                None
            } else {
                Some(hnh_raw as i32)
            };
            // Options
            let opt_count = r.read_u32()? as usize;
            let mut options = Vec::new();
            for _ in 0..opt_count {
                let level = r.read_u32()?;
                let optname = r.read_u32()?;
                let value = r.read_u32()?;
                options.push((level, optname, value));
            }
            // Addresses
            let mut bind_addr = [0u8; 4];
            bind_addr.copy_from_slice(r.read_bytes(4)?);
            let bind_port = r.read_u32()? as u16;
            let mut peer_addr = [0u8; 4];
            peer_addr.copy_from_slice(r.read_bytes(4)?);
            let peer_port = r.read_u32()? as u16;
            // Listen backlog: read-and-discard. The serialize side now
            // always writes 0; this loop tolerates older blobs (in case
            // any in-flight serialize/deserialize crosses the format
            // change). Pre-accepted AF_UNIX same-process connections are
            // consume-once and stay with the parent — see SocketInfo's
            // hand-written Clone.
            let bl_count = r.read_u32()? as usize;
            for _ in 0..bl_count {
                let _ = r.read_u32()?;
            }

            let mut sock = SocketInfo::new(domain, sock_type, protocol);
            sock.state = state;
            sock.peer_idx = peer_idx;
            sock.recv_buf_idx = recv_buf_idx;
            sock.send_buf_idx = send_buf_idx;
            sock.shut_rd = shut_rd;
            sock.shut_wr = shut_wr;
            sock.host_net_handle = host_net_handle;
            sock.options = options;
            sock.bind_addr = bind_addr;
            sock.bind_port = bind_port;
            sock.peer_addr = peer_addr;
            sock.peer_port = peer_port;
            // sock.listen_backlog stays at default (Vec::new()) — see the
            // read-and-discard block above.
            sock.global_pipes = r.read_u32()? != 0;
            // Shared listener backlog idx (AF_INET listening sockets). The
            // refcount bump for inherited references happens in
            // `process_table::bump_inherited_resource_refcounts`, which both
            // fork and spawn call after building the child — keeping
            // refcount logic in one place.
            let sb_raw = r.read_u32()?;
            sock.shared_backlog_idx = if sb_raw == 0xFFFFFFFF {
                None
            } else {
                Some(sb_raw as usize)
            };
            // bind_path for AF_UNIX
            if r.remaining() >= 4 {
                let bp_len = r.read_u32()?;
                if bp_len != 0xFFFFFFFF {
                    let bp = r.read_bytes(bp_len as usize)?;
                    sock.bind_path = Some(bp.to_vec());
                }
            }
            if r.remaining() >= 4 {
                let aw_raw = r.read_u32()?;
                sock.accept_wake_idx = if aw_raw == 0xFFFFFFFF {
                    None
                } else {
                    Some(aw_raw)
                };
            }
            sockets.insert_at(idx, sock);
        }
    }

    Ok(Process {
        pid: child_pid,
        ppid,
        uid,
        gid,
        euid,
        egid,
        pgid,
        sid,
        // POSIX: fork children inherit sid but are NEVER session leaders.
        // The leader flag is explicit (not derived from sid==pid) so that a
        // child whose new pid happens to equal the inherited sid is still
        // correctly treated as a non-leader.
        is_session_leader: false,
        state: ProcessState::Running,
        exit_status: 0,
        fd_table,
        ofd_table,
        lock_table: LockTable::new(),
        pipes: Vec::new(),
        sockets,
        cwd,
        dir_streams: Vec::new(),
        signals,
        memory,
        terminal,
        environ,
        argv,
        umask,
        nice,
        rlimits,
        alarm_deadline_ns: 0,
        alarm_interval_ns: 0,
        thread_name: [0u8; 16],
        fork_child: true,
        sigsuspend_saved_mask: None,
        fork_exec_path,
        fork_exec_argv,
        fork_fd_actions,
        next_ephemeral_port: 49152,
        threads: Vec::new(), // POSIX: child has single thread
        next_tid: 0,
        eventfds: Vec::new(),
        epolls: Vec::new(),
        timerfds: Vec::new(),
        signalfds: Vec::new(),
        posix_timers: Vec::new(),
        alt_stack_sp: 0,
        alt_stack_flags: 2, // SS_DISABLE
        alt_stack_size: 0,
        alt_stack_depth: 0,
        fork_pipe_replay: Vec::new(),
        memfds: Vec::new(),
        procfs_bufs: Vec::new(),
        has_exec: false,
        // Fork children do NOT inherit the framebuffer binding. The
        // /dev/fb0 device is single-owner (FB0_OWNER); a forked child
        // gets a private mmap copy in its own Memory but is not
        // registered as a host display target. fbDOOM doesn't fork
        // mid-game; documented limitation in the design doc.
        fb_binding: None,
        // DRI bo bindings are per-process host state (the host points
        // each bo's SAB slice at the binding's wasm `addr`). After
        // fork, the child's memory is freshly cloned and the host
        // has not been told where to mirror anything; the child must
        // re-mmap to re-establish bindings, mirroring `fb_binding`.
        dri_bindings: Vec::new(),
        fork_count: 0,
    })
}

// ── Exec Serialize ──────────────────────────────────────────────────────────

/// Serialize the process state into a binary buffer for exec.
///
/// Differs from fork serialization:
/// - Magic: EXEC_MAGIC (0x45584543)
/// - ppid: preserves proc.ppid (fork writes proc.pid as child's ppid)
/// - Signal handlers: only SIG_IGN preserved; caught Handler signals reset to Default
/// - Pending signals: preserved (fork clears to 0)
/// - FD table: FDs with FD_CLOEXEC are excluded
/// - OFD table: only OFDs still referenced by remaining FDs after CLOEXEC filtering
pub fn serialize_exec_state(proc: &Process, buf: &mut [u8]) -> Result<usize, Errno> {
    let mut w = Writer::new(buf);

    // ── Header (12 bytes) ──
    w.write_u32(EXEC_MAGIC)?;
    w.write_u32(FORK_VERSION)?;
    let total_size_offset = w.pos;
    w.write_u32(0)?; // placeholder for total_size

    // ── Scalars (32 bytes) ──
    // Preserve the process's own ppid (exec replaces the image, not the process)
    w.write_u32(proc.ppid)?;
    w.write_u32(proc.uid)?;
    w.write_u32(proc.gid)?;
    w.write_u32(proc.euid)?;
    w.write_u32(proc.egid)?;
    w.write_u32(proc.pgid)?;
    w.write_u32(proc.sid)?;
    w.write_u32(proc.is_session_leader as u32)?;
    w.write_u32(proc.umask)?;
    w.write_u32(proc.nice as u32)?;

    // ── Signal state ──
    w.write_u64(proc.signals.blocked)?;

    // Only preserve SIG_IGN handlers; caught (Handler) signals reset to Default (POSIX)
    let handlers = proc.signals.handlers();
    let ignore_count = handlers
        .iter()
        .enumerate()
        .filter(|(i, h)| *i > 0 && **h == SignalHandler::Ignore)
        .count() as u32;
    w.write_u32(ignore_count)?;

    for (i, h) in handlers.iter().enumerate() {
        if i > 0 && *h == SignalHandler::Ignore {
            w.write_u32(i as u32)?;
            w.write_u32(handler_to_u32(*h))?;
        }
    }

    // Pending signals preserved for exec (unlike fork which clears them)
    w.write_u64(proc.signals.pending)?;

    // ── FD table (filter out CLOEXEC fds) ──
    let fd_entries: Vec<(i32, &FdEntry)> = proc
        .fd_table
        .iter()
        .filter(|(_, entry)| entry.fd_flags & FD_CLOEXEC == 0)
        .collect();

    // Collect referenced OFD indices from the filtered FDs
    let referenced_ofds: BTreeSet<usize> = fd_entries
        .iter()
        .map(|(_, entry)| entry.ofd_ref.0)
        .collect();

    w.write_u32(proc.fd_table.max_fds() as u32)?;
    w.write_u32(fd_entries.len() as u32)?;
    for (fd_num, entry) in &fd_entries {
        w.write_u32(*fd_num as u32)?;
        w.write_u32(entry.ofd_ref.0 as u32)?;
        w.write_u32(entry.fd_flags)?;
    }

    // ── OFD table (only OFDs referenced by remaining FDs) ──
    let ofd_entries: Vec<(usize, &OpenFileDesc)> = proc
        .ofd_table
        .iter()
        .filter(|(index, _)| referenced_ofds.contains(index))
        .collect();
    w.write_u32(ofd_entries.len() as u32)?;
    for (index, ofd) in &ofd_entries {
        w.write_u32(*index as u32)?;
        w.write_u32(file_type_to_u32(ofd.file_type))?;
        w.write_u32(ofd.status_flags)?;
        w.write_i64(ofd.host_handle)?;
        w.write_i64(ofd.offset)?;
        w.write_u32(ofd.ref_count)?;
        w.write_u32(ofd.path.len() as u32)?;
        w.write_bytes(&ofd.path)?;
        // DRI sidecar — `preserve_master = true` because exec keeps
        // the same process identity and any inherited card0 OFD
        // legitimately retains its KMS lease across the image swap.
        write_dri_state(&mut w, ofd.dri_state.as_deref(), true)?;
        // evdev sidecar — exec keeps the per-OFD ring + grab (the OFD
        // survives the image swap; CLOEXEC is handled by the fd table,
        // not the OFD).
        write_input_state(&mut w, ofd.input_state.as_deref())?;
        // ALSA sidecars — same survival semantics as evdev across exec.
        write_audio_state(&mut w, ofd.audio.as_deref())?;
        write_audio_ctl_state(&mut w, ofd.audio_ctl.as_deref())?;
    }

    // ── Environment ──
    w.write_u32(proc.environ.len() as u32)?;
    for var in &proc.environ {
        w.write_u32(var.len() as u32)?;
        w.write_bytes(var)?;
    }

    // ── Argv ──
    w.write_u32(proc.argv.len() as u32)?;
    for arg in &proc.argv {
        w.write_u32(arg.len() as u32)?;
        w.write_bytes(arg)?;
    }

    // ── CWD ──
    w.write_u32(proc.cwd.len() as u32)?;
    w.write_bytes(&proc.cwd)?;

    // ── Rlimits (256 bytes) ──
    for pair in &proc.rlimits {
        w.write_u64(pair[0])?;
        w.write_u64(pair[1])?;
    }

    // ── Terminal ──
    w.write_u32(proc.terminal.c_iflag)?;
    w.write_u32(proc.terminal.c_oflag)?;
    w.write_u32(proc.terminal.c_cflag)?;
    w.write_u32(proc.terminal.c_lflag)?;
    w.write_bytes(&proc.terminal.c_cc)?;
    w.write_u16(proc.terminal.winsize.ws_row)?;
    w.write_u16(proc.terminal.winsize.ws_col)?;
    w.write_u16(proc.terminal.winsize.ws_xpixel)?;
    w.write_u16(proc.terminal.winsize.ws_ypixel)?;
    w.write_u8(proc.terminal.c_line)?;
    w.write_u32(proc.terminal.c_ispeed)?;
    w.write_u32(proc.terminal.c_ospeed)?;
    w.write_i32(proc.terminal.session_id)?;

    // ── Program break ──
    w.write_u32(proc.memory.get_brk() as u32)?;

    // ── Patch total_size ──
    let total = w.pos as u32;
    w.patch_u32(total_size_offset, total);

    Ok(w.pos)
}

// ── Exec Deserialize ────────────────────────────────────────────────────────

/// Deserialize process state from an exec buffer.
///
/// Differs from fork deserialization:
/// - Checks EXEC_MAGIC instead of FORK_MAGIC
/// - Reads pending signals (u64) after handler entries
/// - Uses `SignalState::from_parts_with_pending` to preserve pending signals
pub fn deserialize_exec_state(buf: &[u8], pid: u32) -> Result<Process, Errno> {
    let mut r = Reader::new(buf);

    // ── Header ──
    let magic = r.read_u32()?;
    if magic != EXEC_MAGIC {
        return Err(Errno::EINVAL);
    }
    let version = r.read_u32()?;
    if version != FORK_VERSION {
        return Err(Errno::EINVAL);
    }
    let _total_size = r.read_u32()?;

    // ── Scalars ──
    let ppid = r.read_u32()?;
    let uid = r.read_u32()?;
    let gid = r.read_u32()?;
    let euid = r.read_u32()?;
    let egid = r.read_u32()?;
    let pgid = r.read_u32()?;
    let sid = r.read_u32()?;
    let is_session_leader = r.read_u32()? != 0; // preserved across exec
    let umask = r.read_u32()?;
    let nice = r.read_u32()? as i32;

    // ── Signal state ──
    let blocked = r.read_u64()?;
    let handler_count = r.read_u32()?;
    if handler_count > 64 {
        return Err(Errno::EINVAL);
    }
    let mut handlers = [SignalHandler::Default; 65];
    for _ in 0..handler_count {
        let signum = r.read_u32()?;
        let handler_val = r.read_u32()?;
        if (signum as usize) < 64 {
            handlers[signum as usize] = u32_to_handler(handler_val);
        }
    }
    // Read pending signals (exec preserves them, unlike fork)
    let pending = r.read_u64()?;
    let signals = SignalState::from_parts_with_pending(handlers, blocked, pending);

    // ── FD table ──
    let max_fds = r.read_u32()? as usize;
    let fd_count = r.read_u32()?;
    if fd_count > MAX_FDS {
        return Err(Errno::EINVAL);
    }
    let mut fd_entries: Vec<Option<FdEntry>> = Vec::new();
    for _ in 0..fd_count {
        let fd_num = r.read_u32()? as usize;
        let ofd_index = r.read_u32()? as usize;
        let fd_flags = r.read_u32()?;
        while fd_entries.len() <= fd_num {
            fd_entries.push(None);
        }
        fd_entries[fd_num] = Some(FdEntry {
            ofd_ref: OpenFileDescRef(ofd_index),
            fd_flags,
        });
    }
    let fd_table = FdTable::from_raw(fd_entries, max_fds);

    // ── OFD table ──
    let ofd_count = r.read_u32()?;
    if ofd_count > MAX_OFDS {
        return Err(Errno::EINVAL);
    }
    let mut ofd_entries: Vec<Option<OpenFileDesc>> = Vec::new();
    for _ in 0..ofd_count {
        let index = r.read_u32()? as usize;
        let file_type = u32_to_file_type(r.read_u32()?)?;
        let status_flags = r.read_u32()?;
        let host_handle = r.read_i64()?;
        let offset = r.read_i64()?;
        let ref_count = r.read_u32()?;
        let path_len = r.read_u32()? as usize;
        let path = r.read_bounded_bytes(path_len, MAX_PATH_LEN)?.to_vec();
        while ofd_entries.len() <= index {
            ofd_entries.push(None);
        }
        let dri_state = read_dri_state(&mut r)?;
        let input_state = read_input_state(&mut r)?;
        let audio = read_audio_state(&mut r)?;
        let audio_ctl = read_audio_ctl_state(&mut r)?;
        ofd_entries[index] = Some(OpenFileDesc {
            file_type,
            status_flags,
            host_handle,
            offset,
            ref_count,
            owner_pid: pid,
            path,
            dir_host_handle: -1,
            dir_synth_state: 0,
            dir_entry_offset: 0,
            dri_state,
            input_state,
            audio,
            audio_ctl,
        });
    }
    let ofd_table = OfdTable::from_raw(ofd_entries);

    // ── Environment ──
    let env_count = r.read_u32()?;
    if env_count > MAX_ENV_VARS {
        return Err(Errno::EINVAL);
    }
    let mut environ = Vec::with_capacity(env_count as usize);
    for _ in 0..env_count {
        let len = r.read_u32()? as usize;
        let data = r.read_bounded_bytes(len, MAX_STRING_LEN)?;
        environ.push(data.to_vec());
    }

    // ── Argv ──
    let argv_count = r.read_u32()?;
    if argv_count > MAX_ARGV {
        return Err(Errno::EINVAL);
    }
    let mut argv = Vec::with_capacity(argv_count as usize);
    for _ in 0..argv_count {
        let len = r.read_u32()? as usize;
        let data = r.read_bounded_bytes(len, MAX_STRING_LEN)?;
        argv.push(data.to_vec());
    }

    // ── CWD ──
    let cwd_len = r.read_u32()? as usize;
    let cwd_data = r.read_bounded_bytes(cwd_len, MAX_PATH_LEN)?;
    let cwd = cwd_data.to_vec();

    // ── Rlimits ──
    let mut rlimits = [[0u64; 2]; 16];
    for pair in rlimits.iter_mut() {
        pair[0] = r.read_u64()?;
        pair[1] = r.read_u64()?;
    }

    // ── Terminal ──
    let c_iflag = r.read_u32()?;
    let c_oflag = r.read_u32()?;
    let c_cflag = r.read_u32()?;
    let c_lflag = r.read_u32()?;
    let c_cc_data = r.read_bytes(NCCS)?;
    let mut c_cc = [0u8; NCCS];
    c_cc.copy_from_slice(c_cc_data);
    let ws_row = r.read_u16()?;
    let ws_col = r.read_u16()?;
    let ws_xpixel = r.read_u16()?;
    let ws_ypixel = r.read_u16()?;
    let c_line = r.read_u8().unwrap_or(0);
    let c_ispeed = r.read_u32().unwrap_or(0o0000017); // B38400
    let c_ospeed = r.read_u32().unwrap_or(0o0000017);
    let session_id = r.read_i32().unwrap_or(0);

    let terminal = TerminalState {
        c_iflag,
        c_oflag,
        c_cflag,
        c_lflag,
        c_line,
        c_cc,
        c_ispeed,
        c_ospeed,
        winsize: WinSize {
            ws_row,
            ws_col,
            ws_xpixel,
            ws_ypixel,
        },
        foreground_pgid: 1,
        session_id,
        line_buffer: Vec::new(),
        cooked_buffer: Vec::new(),
    };

    // ── Program break ──
    // Read but discard: POSIX exec resets the program break (Linux does the
    // same), and the host calls `kernel_set_brk_base` with the new program's
    // `__heap_base` immediately after exec to install the correct value
    // before `_start` runs. Preserving the previous program's brk here would
    // leave malloc allocating from inside the new program's stack region
    // when the new program has a larger data section than the old one
    // (e.g. /bin/sh exec'ing mariadbd).
    let _program_break = r.read_u32()?;
    let memory = MemoryManager::new();

    Ok(Process {
        pid,
        ppid,
        uid,
        gid,
        euid,
        egid,
        pgid,
        sid,
        is_session_leader,
        state: ProcessState::Running,
        exit_status: 0,
        fd_table,
        ofd_table,
        lock_table: LockTable::new(),
        pipes: Vec::new(),
        sockets: SocketTable::new(),
        cwd,
        dir_streams: Vec::new(),
        signals,
        memory,
        terminal,
        environ,
        argv,
        umask,
        nice,
        rlimits,
        alarm_deadline_ns: 0,
        alarm_interval_ns: 0,
        thread_name: [0u8; 16],
        fork_child: false,
        sigsuspend_saved_mask: None,
        fork_exec_path: None,
        fork_exec_argv: None,
        fork_fd_actions: Vec::new(),
        next_ephemeral_port: 49152,
        threads: Vec::new(), // exec resets to single thread
        next_tid: 0,
        eventfds: Vec::new(),
        epolls: Vec::new(),
        timerfds: Vec::new(),
        signalfds: Vec::new(),
        posix_timers: Vec::new(),
        alt_stack_sp: 0,
        alt_stack_flags: 2, // SS_DISABLE
        alt_stack_size: 0,
        alt_stack_depth: 0,
        fork_pipe_replay: Vec::new(),
        memfds: Vec::new(),
        procfs_bufs: Vec::new(),
        has_exec: false,
        // exec wipes any prior framebuffer binding — the new program
        // must open and mmap /dev/fb0 itself.
        fb_binding: None,
        // exec replaces the address space, so every DRI bo binding
        // is gone — the new image must re-mmap.
        dri_bindings: Vec::new(),
        // The fork counter exists as a kernel-side regression guardrail.
        // Resetting on exec keeps semantics simple: the next spawn-from-this-pid
        // test starts from a clean slate. The plan's regression check inspects
        // the *parent* process's counter, not the post-exec child, so this
        // reset is safe.
        fork_count: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::Process;
    use crate::signal::SignalHandler;

    #[test]
    fn test_roundtrip_default_process() {
        let proc = Process::new(1);
        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        assert!(written > 12);
        assert_eq!(&buf[0..4], &0x464F524Bu32.to_le_bytes());

        let child = deserialize_fork_state(&buf[..written], 42).unwrap();
        assert_eq!(child.pid, 42);
        assert_eq!(child.ppid, proc.pid); // child's ppid is parent's pid
        assert_eq!(child.uid, proc.uid);
        assert_eq!(child.gid, proc.gid);
        assert_eq!(child.umask, proc.umask);
        assert_eq!(child.nice, proc.nice);
        assert_eq!(child.cwd, proc.cwd);
        assert_eq!(child.signals.pending, 0);
    }

    #[test]
    fn test_roundtrip_with_environment() {
        let mut proc = Process::new(1);
        proc.environ.push(b"HOME=/home/test".to_vec());
        proc.environ.push(b"PATH=/usr/bin".to_vec());

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 2).unwrap();

        assert_eq!(child.environ.len(), 2);
        assert_eq!(child.environ[0], b"HOME=/home/test");
        assert_eq!(child.environ[1], b"PATH=/usr/bin");
    }

    #[test]
    fn test_roundtrip_with_fds() {
        let proc = Process::new(1);
        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 3).unwrap();

        assert!(child.fd_table.get(0).is_ok());
        assert!(child.fd_table.get(1).is_ok());
        assert!(child.fd_table.get(2).is_ok());
        assert!(child.fd_table.get(3).is_err());
    }

    #[test]
    fn test_roundtrip_with_custom_cwd() {
        let mut proc = Process::new(1);
        proc.cwd = b"/home/user/project".to_vec();

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 4).unwrap();
        assert_eq!(child.cwd, b"/home/user/project");
    }

    #[test]
    fn test_roundtrip_signal_handlers() {
        let mut proc = Process::new(1);
        proc.signals.set_handler(2, SignalHandler::Ignore).unwrap();
        proc.signals
            .set_handler(15, SignalHandler::Handler(42))
            .unwrap();
        proc.signals.blocked = 0x0000_0004;

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 5).unwrap();

        assert_eq!(child.signals.get_handler(2), SignalHandler::Ignore);
        assert_eq!(child.signals.get_handler(15), SignalHandler::Handler(42));
        assert_eq!(child.signals.blocked, 0x0000_0004);
        assert_eq!(child.signals.pending, 0);
    }

    #[test]
    fn test_roundtrip_rlimits() {
        let mut proc = Process::new(1);
        proc.rlimits[7] = [512, 1024];

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 6).unwrap();

        assert_eq!(child.rlimits[7], [512, 1024]);
    }

    #[test]
    fn test_fork_exec_params_roundtrip() {
        use crate::process::FdAction;
        let mut proc = Process::new(1);
        proc.fork_exec_path = Some(b"/usr/bin/echo".to_vec());
        proc.fork_exec_argv = Some(vec![b"echo".to_vec(), b"hello".to_vec(), b"world".to_vec()]);
        proc.fork_fd_actions = vec![
            FdAction::Close { fd: 3 },
            FdAction::Dup2 {
                old_fd: 4,
                new_fd: 1,
            },
            FdAction::Close { fd: 4 },
        ];

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 42).unwrap();

        assert!(child.fork_child);
        assert_eq!(
            child.fork_exec_path.as_deref(),
            Some(b"/usr/bin/echo".as_slice())
        );
        let argv = child.fork_exec_argv.unwrap();
        assert_eq!(argv.len(), 3);
        assert_eq!(argv[0], b"echo");
        assert_eq!(argv[1], b"hello");
        assert_eq!(argv[2], b"world");
        assert_eq!(child.fork_fd_actions.len(), 3);
        match &child.fork_fd_actions[0] {
            FdAction::Close { fd } => assert_eq!(*fd, 3),
            _ => panic!("expected Close"),
        }
        match &child.fork_fd_actions[1] {
            FdAction::Dup2 { old_fd, new_fd } => {
                assert_eq!(*old_fd, 4);
                assert_eq!(*new_fd, 1);
            }
            _ => panic!("expected Dup2"),
        }
    }

    #[test]
    fn test_buffer_too_small() {
        let proc = Process::new(1);
        let mut buf = vec![0u8; 8];
        let result = serialize_fork_state(&proc, &mut buf);
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_magic() {
        let buf = [0u8; 64];
        let result = deserialize_fork_state(&buf, 1);
        assert!(result.is_err());
    }

    // ── Exec tests ──────────────────────────────────────────────────────────

    #[test]
    fn test_exec_roundtrip_default_process() {
        let proc = Process::new(1);
        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_exec_state(&proc, &mut buf).unwrap();
        assert!(written > 12);
        assert_eq!(&buf[0..4], &0x45584543u32.to_le_bytes()); // EXEC magic

        let restored = deserialize_exec_state(&buf[..written], 1).unwrap();
        assert_eq!(restored.pid, 1);
        assert_eq!(restored.ppid, 0); // default ppid
        assert_eq!(restored.signals.pending, 0);
    }

    #[test]
    fn test_exec_state_filters_cloexec_fds() {
        use wasm_posix_shared::fd_flags::FD_CLOEXEC;
        let mut proc = Process::new(1);
        // fd 3 with CLOEXEC
        let ofd_ref = proc.ofd_table.create(
            crate::ofd::FileType::Regular,
            0,
            100,
            b"/test/cloexec".to_vec(),
        );
        proc.fd_table
            .alloc(crate::fd::OpenFileDescRef(ofd_ref), FD_CLOEXEC)
            .unwrap();

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_exec_state(&proc, &mut buf).unwrap();
        let restored = deserialize_exec_state(&buf[..written], 1).unwrap();
        // fd 3 should be gone (CLOEXEC)
        assert!(restored.fd_table.get(3).is_err());
        // fds 0,1,2 should still exist
        assert!(restored.fd_table.get(0).is_ok());
    }

    #[test]
    fn test_exec_state_resets_caught_handler_preserves_ignore() {
        let mut proc = Process::new(1);
        proc.signals.set_handler(2, SignalHandler::Ignore).unwrap(); // SIGINT -> IGN
        proc.signals
            .set_handler(15, SignalHandler::Handler(42))
            .unwrap(); // SIGTERM -> caught

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_exec_state(&proc, &mut buf).unwrap();
        let restored = deserialize_exec_state(&buf[..written], 1).unwrap();

        assert_eq!(restored.signals.get_handler(2), SignalHandler::Ignore); // preserved
        assert_eq!(restored.signals.get_handler(15), SignalHandler::Default); // reset
    }

    #[test]
    fn test_exec_state_preserves_pending_signals() {
        let mut proc = Process::new(1);
        proc.signals.raise(2); // SIGINT pending
        proc.signals.raise(15); // SIGTERM pending

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_exec_state(&proc, &mut buf).unwrap();
        let restored = deserialize_exec_state(&buf[..written], 1).unwrap();

        assert!(restored.signals.is_pending(2));
        assert!(restored.signals.is_pending(15));
    }

    #[test]
    fn test_exec_preserves_ppid() {
        let mut proc = Process::new(5);
        proc.ppid = 3;

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_exec_state(&proc, &mut buf).unwrap();
        let restored = deserialize_exec_state(&buf[..written], 5).unwrap();

        assert_eq!(restored.ppid, 3); // ppid preserved
    }

    #[test]
    fn test_fork_inherits_program_break() {
        let mut proc = Process::new(1);
        proc.memory.set_brk(0x02000000); // move brk past default

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 42).unwrap();

        assert_eq!(child.memory.get_brk(), 0x02000000);
    }

    #[test]
    fn test_fork_inherits_compact_memory_layout() {
        use wasm_posix_shared::mmap::*;
        let mut proc = Process::new(1);
        let brk_base = 0x00200000;
        proc.memory.set_brk_base(brk_base);
        proc.memory.set_max_addr(0x00800000);
        proc.memory.set_mmap_base(brk_base);

        let first = proc.memory.mmap_anonymous(
            0,
            0x10000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        assert_eq!(first, brk_base);

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let mut child = deserialize_fork_state(&buf[..written], 42).unwrap();

        assert_eq!(child.memory.get_brk(), brk_base);
        assert_eq!(child.memory.set_brk(brk_base + 0x10000), brk_base);

        let protected = child.memory.mmap_anonymous(
            brk_base - 0x10000,
            0x10000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED,
        );
        assert_eq!(protected, MAP_FAILED);

        let next = child.memory.mmap_anonymous(
            0,
            0x10000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        assert_eq!(next, brk_base + 0x10000);
    }

    #[test]
    fn test_fork_inherits_mmap_mappings() {
        use wasm_posix_shared::mmap::*;
        let mut proc = Process::new(1);
        // Parent has several mmap allocations
        let a1 = proc.memory.mmap_anonymous(
            0,
            0x10000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        let a2 = proc
            .memory
            .mmap_anonymous(0, 0x20000, PROT_READ, MAP_PRIVATE | MAP_ANONYMOUS);
        let a3 = proc.memory.mmap_anonymous(
            0,
            0x30000,
            PROT_READ | PROT_WRITE | PROT_EXEC,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        assert_ne!(a1, MAP_FAILED);
        assert_ne!(a2, MAP_FAILED);
        assert_ne!(a3, MAP_FAILED);

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let mut child = deserialize_fork_state(&buf[..written], 42).unwrap();

        // Child must inherit all parent's mmap mappings
        let child_mappings = child.memory.mappings();
        assert_eq!(child_mappings.len(), 3);
        assert_eq!(child_mappings[0].addr, a1);
        assert_eq!(child_mappings[0].len, 0x10000);
        assert_eq!(child_mappings[1].addr, a2);
        assert_eq!(child_mappings[1].len, 0x20000);
        assert_eq!(child_mappings[2].addr, a3);
        assert_eq!(child_mappings[2].len, 0x30000);

        // Child's next mmap must NOT overlap parent's regions
        let a4 = child.memory.mmap_anonymous(
            0,
            0x10000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        assert_ne!(a4, MAP_FAILED);
        assert!(
            a4 >= a3 + 0x30000,
            "child mmap at {:#x} overlaps parent mapping at {:#x}",
            a4,
            a3
        );
    }

    #[test]
    fn test_fork_from_main_treats_parent_pthread_slots_as_free_memory() {
        use wasm_posix_shared::mmap::*;

        let mut proc = Process::new(1);
        let slot_len = 0x40000;
        let first = proc.memory.reserve_host_region(slot_len);
        let second = proc.memory.reserve_host_region(slot_len);
        assert_ne!(first, wasm_posix_shared::mmap::MAP_FAILED);
        assert_ne!(second, wasm_posix_shared::mmap::MAP_FAILED);
        assert_eq!(proc.memory.reserved_regions().len(), 2);

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let mut child = deserialize_fork_state(&buf[..written], 42).unwrap();

        // POSIX fork resumes only the calling thread. Parent pthread slots
        // are process-memory bytes in the child, not automatically-live host
        // reservations. The host installs one exact caller-slot reservation
        // separately for fork-from-pthread children.
        assert!(child.memory.reserved_regions().is_empty());
        assert!(child.memory.can_grow_at(first, slot_len));
        assert!(child.memory.can_grow_at(second, slot_len));

        let fixed_anon = MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED;
        assert_eq!(
            child
                .memory
                .mmap_anonymous(first, slot_len, PROT_READ | PROT_WRITE, fixed_anon),
            first
        );
        assert_eq!(
            child
                .memory
                .mmap_anonymous(second, slot_len, PROT_READ | PROT_WRITE, fixed_anon),
            second
        );
    }

    #[test]
    fn test_fork_from_pthread_retains_only_caller_slot() {
        use wasm_posix_shared::mmap::*;

        let mut proc = Process::new(1);
        let slot_len = 0x40000;
        let first = proc.memory.reserve_host_region(slot_len);
        let caller = proc.memory.reserve_host_region(slot_len);
        let third = proc.memory.reserve_host_region(slot_len);
        assert_ne!(first, MAP_FAILED);
        assert_ne!(caller, MAP_FAILED);
        assert_ne!(third, MAP_FAILED);
        assert_eq!(proc.memory.reserved_regions().len(), 3);

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let mut child = deserialize_fork_state(&buf[..written], 42).unwrap();

        // `kernel_fork_process` does not inherit parent dynamic reservations.
        // For fork-from-pthread, the host then retains only the caller slot
        // with `kernel_reserve_host_region_at`.
        assert!(child.memory.reserved_regions().is_empty());
        assert_eq!(child.memory.reserve_host_region_at(caller, slot_len), caller);
        assert_eq!(child.memory.reserved_regions().len(), 1);
        assert!(child.memory.overlaps_host_reserved_region(caller, slot_len));

        assert!(child.memory.can_grow_at(first, slot_len));
        assert!(!child.memory.can_grow_at(caller, slot_len));
        assert!(child.memory.can_grow_at(third, slot_len));

        let fixed_anon = MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED;
        assert_eq!(
            child
                .memory
                .mmap_anonymous(caller, slot_len, PROT_READ | PROT_WRITE, fixed_anon),
            MAP_FAILED
        );
        assert_eq!(
            child
                .memory
                .mmap_anonymous(first, slot_len, PROT_READ | PROT_WRITE, fixed_anon),
            first
        );
        assert_eq!(
            child
                .memory
                .mmap_anonymous(third, slot_len, PROT_READ | PROT_WRITE, fixed_anon),
            third
        );
    }

    #[test]
    fn test_exec_resets_program_break() {
        // POSIX/Linux: exec resets the program break. The host re-installs
        // it via `kernel_set_brk_base(__heap_base)` immediately after, so
        // the new program's malloc gets a value above its data + stack
        // region instead of inheriting an arbitrary value from the prior
        // program (which could land inside the new program's stack region
        // when the new program has a larger data section).
        let mut proc = Process::new(1);
        proc.memory.set_brk(0x02000000);

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_exec_state(&proc, &mut buf).unwrap();
        let child = deserialize_exec_state(&buf[..written], 1).unwrap();

        // Default fallback (no `set_brk_base` call yet); host overrides
        // this with the new program's `__heap_base` before `_start` runs.
        let default_brk = {
            let m = crate::memory::MemoryManager::new();
            m.get_brk()
        };
        assert_eq!(child.memory.get_brk(), default_brk);
        assert_ne!(child.memory.get_brk(), 0x02000000);
    }

    #[test]
    fn test_fork_does_not_inherit_threads() {
        use crate::process::ThreadInfo;
        let mut proc = Process::new(1);
        // Parent has 2 threads
        let t1 = proc.alloc_tid();
        let t2 = proc.alloc_tid();
        proc.add_thread(ThreadInfo::new(t1, 0, 0x1000, 0));
        proc.add_thread(ThreadInfo::new(t2, 0, 0x2000, 0));
        assert_eq!(proc.threads.len(), 2);

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 42).unwrap();

        // POSIX: child has a single thread (the calling thread)
        assert_eq!(child.threads.len(), 0);
        assert_eq!(child.next_tid, 0);
    }

    #[test]
    fn test_exec_resets_threads() {
        use crate::process::ThreadInfo;
        let mut proc = Process::new(1);
        let t1 = proc.alloc_tid();
        proc.add_thread(ThreadInfo::new(t1, 0, 0x1000, 0));

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_exec_state(&proc, &mut buf).unwrap();
        let child = deserialize_exec_state(&buf[..written], 1).unwrap();

        assert_eq!(child.threads.len(), 0);
        assert_eq!(child.next_tid, 0);
    }

    #[test]
    fn test_deserialize_rejects_huge_env_count() {
        // Craft a minimal valid fork buffer then set env_count to u32::MAX
        let proc = Process::new(1);
        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();

        // Find env_count field and set it to a huge value.
        // The env_count immediately follows the OFD table. For an empty
        // process, it's at a known offset. We'll just set the field that
        // was serialized as 0 to 0xFFFFFFFF and expect EINVAL.
        let mut tampered = buf[..written].to_vec();
        // Search for env_count (currently 0) by scanning after OFD section.
        // Simpler approach: just corrupt the entire buffer to trigger bounds.
        // Set bytes at offset 12 (total_size) to a huge value won't help...
        // Instead, craft a buffer with correct header but malicious counts.
        let mut w = Writer::new(&mut tampered);
        w.write_u32(FORK_MAGIC).unwrap();
        w.write_u32(FORK_VERSION).unwrap();
        w.write_u32(0).unwrap(); // total_size (ignored on read)
        // Scalars: ppid, uid, gid, euid, egid, pgid, sid, umask, nice
        for _ in 0..9 {
            w.write_u32(0).unwrap();
        }
        // Signal: blocked + handler_count=0
        w.write_u64(0).unwrap();
        w.write_u32(0).unwrap();
        // FD table: max_fds=1024, fd_count=0
        w.write_u32(1024).unwrap();
        w.write_u32(0).unwrap();
        // OFD table: ofd_count=0
        w.write_u32(0).unwrap();
        // Environment: env_count = 0xFFFFFFFF (huge!)
        w.write_u32(0xFFFFFFFF).unwrap();
        let pos = w.pos;
        let result = deserialize_fork_state(&tampered[..pos], 42);
        assert!(result.is_err());
    }

    #[test]
    fn test_deserialize_rejects_huge_path_len() {
        let mut buf = vec![0u8; 256];
        let mut w = Writer::new(&mut buf);
        w.write_u32(FORK_MAGIC).unwrap();
        w.write_u32(FORK_VERSION).unwrap();
        w.write_u32(0).unwrap();
        for _ in 0..9 {
            w.write_u32(0).unwrap();
        }
        w.write_u64(0).unwrap();
        w.write_u32(0).unwrap(); // handler_count
        w.write_u32(1024).unwrap(); // max_fds
        w.write_u32(0).unwrap(); // fd_count
        // OFD table: 1 entry with huge path
        w.write_u32(1).unwrap(); // ofd_count
        w.write_u32(0).unwrap(); // index
        w.write_u32(0).unwrap(); // file_type = Regular
        w.write_u32(0).unwrap(); // status_flags
        w.write_i64(0).unwrap(); // host_handle
        w.write_i64(0).unwrap(); // offset
        w.write_u32(1).unwrap(); // ref_count
        w.write_u32(0x10000000).unwrap(); // path_len = 256MB (over MAX_PATH_LEN)
        let pos = w.pos;
        let result = deserialize_fork_state(&buf[..pos], 42);
        assert!(result.is_err());
    }

    // ── DRI fork inheritance tests ─────────────────────────────────────────

    fn install_render_node_ofd_with_handles(
        proc: &mut Process,
        path: &[u8],
        host_handle: i64,
        handles: &[(u32, crate::dri::BoId)],
    ) -> usize {
        use crate::ofd::{DriFdState, DriOfdState};
        let ofd_idx =
            proc.ofd_table
                .create(crate::ofd::FileType::CharDevice, 0, host_handle, path.to_vec());
        let mut dri = DriFdState::default();
        for &(h, bo) in handles {
            dri.handles.insert(h, bo);
        }
        dri.next_handle = handles.iter().map(|(h, _)| *h).max().unwrap_or(0) + 1;
        proc.ofd_table.get_mut(ofd_idx).unwrap().dri_state =
            Some(alloc::boxed::Box::new(DriOfdState::RenderNode(dri)));
        proc.fd_table
            .alloc(crate::fd::OpenFileDescRef(ofd_idx), 0)
            .unwrap();
        ofd_idx
    }

    #[test]
    fn fork_preserves_render_node_handles_and_increfs_bos() {
        let _g = crate::dri::bo::TEST_REGISTRY_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        crate::dri::bo::reset_registry();
        let bo_a = crate::dri::with_registry(|r| r.alloc(64, 64, 32).id);
        let bo_b = crate::dri::with_registry(|r| r.alloc(32, 32, 32).id);
        // refcount = 1 each from `alloc`.

        let mut proc = Process::new(1);
        let ofd_idx = install_render_node_ofd_with_handles(
            &mut proc,
            b"/dev/dri/renderD128",
            -8,
            &[(1, bo_a), (2, bo_b)],
        );

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 99).unwrap();

        // Both bos now have refcount = 2 (parent + child).
        for &bo in &[bo_a, bo_b] {
            assert_eq!(
                crate::dri::with_registry(|r| r.get(bo).map(|b| b.refcount)),
                Some(2),
                "bo {bo} should be incref'd to 2"
            );
        }

        // Child OFD carries the cloned handle map.
        let child_ofd = child.ofd_table.get(ofd_idx).unwrap();
        let child_dri = child_ofd.dri().unwrap();
        assert_eq!(child_dri.handles.get(&1).copied(), Some(bo_a));
        assert_eq!(child_dri.handles.get(&2).copied(), Some(bo_b));
        assert_eq!(child_dri.next_handle, 3);

        // Clean up: decref the two extra references so we don't pollute
        // the registry for sibling tests.
        crate::dri::with_registry(|r| {
            r.decref(bo_a);
            r.decref(bo_b);
            r.decref(bo_a);
            r.decref(bo_b);
        });
    }

    #[test]
    fn fork_clears_kms_master_in_child() {
        use crate::ofd::{DriFdState, DriOfdState, KmsFdState};
        let _g = crate::dri::bo::TEST_REGISTRY_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        crate::dri::bo::reset_registry();

        let mut proc = Process::new(1);
        let ofd_idx = proc.ofd_table.create(
            crate::ofd::FileType::CharDevice,
            0,
            -9,
            b"/dev/dri/card0".to_vec(),
        );
        let kms = KmsFdState {
            holds_master: true,
            ..Default::default()
        };
        proc.ofd_table.get_mut(ofd_idx).unwrap().dri_state =
            Some(alloc::boxed::Box::new(DriOfdState::Card {
                dri: DriFdState::default(),
                kms,
            }));
        proc.fd_table
            .alloc(crate::fd::OpenFileDescRef(ofd_idx), 0)
            .unwrap();

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 99).unwrap();

        let child_kms = child.ofd_table.get(ofd_idx).unwrap().kms().unwrap();
        assert!(
            !child_kms.holds_master,
            "fork child must not inherit KMS master"
        );
    }

    #[test]
    fn fork_preserves_card_fbs_and_increfs_bos() {
        use crate::ofd::{DriFdState, DriOfdState, KmsFb, KmsFdState};
        let _g = crate::dri::bo::TEST_REGISTRY_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        crate::dri::bo::reset_registry();
        let bo = crate::dri::with_registry(|r| r.alloc(64, 64, 32).id);

        let mut proc = Process::new(1);
        let ofd_idx = proc.ofd_table.create(
            crate::ofd::FileType::CharDevice,
            0,
            -9,
            b"/dev/dri/card0".to_vec(),
        );
        let mut kms = KmsFdState::default();
        kms.fbs.insert(
            42,
            KmsFb {
                bo_id: bo,
                width: 64,
                height: 64,
                pixel_format: 0x34325241, // AR24
                stride: 64 * 4,
            },
        );
        kms.next_fb_id = 43;
        proc.ofd_table.get_mut(ofd_idx).unwrap().dri_state =
            Some(alloc::boxed::Box::new(DriOfdState::Card {
                dri: DriFdState::default(),
                kms,
            }));
        proc.fd_table
            .alloc(crate::fd::OpenFileDescRef(ofd_idx), 0)
            .unwrap();

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 99).unwrap();

        let child_kms = child.ofd_table.get(ofd_idx).unwrap().kms().unwrap();
        let fb = child_kms.fbs.get(&42).expect("fb 42 cloned");
        assert_eq!(fb.bo_id, bo);
        assert_eq!(fb.width, 64);
        assert_eq!(child_kms.next_fb_id, 43);

        // Fb held an incref on the bo + handle slot (none here) → child
        // adds one more ref for its inherited fb slot. Parent's
        // outstanding refs: 1 (alloc) + 0 (no handle in parent) +
        // 0 (we didn't set up an MODE_ADDFB2 path that bumps this in
        // the helper). Child's outstanding refs: 1 from the fb in
        // its kms.fbs.
        assert_eq!(
            crate::dri::with_registry(|r| r.get(bo).map(|b| b.refcount)),
            Some(2),
            "child's inherited fb must hold its own refcount on the bo"
        );

        crate::dri::with_registry(|r| {
            r.decref(bo);
            r.decref(bo);
        });
    }

    #[test]
    fn fork_preserves_prime_bo_state_and_increfs() {
        use crate::ofd::{DriOfdState, PrimeBoState};
        let _g = crate::dri::bo::TEST_REGISTRY_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        crate::dri::bo::reset_registry();
        let bo = crate::dri::with_registry(|r| r.alloc(64, 64, 32).id);
        let cookie = crate::dri::with_registry(|r| r.ensure_prime_cookie(bo).unwrap());

        let mut proc = Process::new(1);
        let ofd_idx = proc.ofd_table.create(
            crate::ofd::FileType::Regular,
            0,
            -200,
            alloc::format!("/dev/dri/prime-{bo}-{cookie:x}")
                .into_bytes(),
        );
        proc.ofd_table.get_mut(ofd_idx).unwrap().dri_state = Some(
            alloc::boxed::Box::new(DriOfdState::PrimeBo(PrimeBoState { bo_id: bo, cookie })),
        );
        proc.fd_table
            .alloc(crate::fd::OpenFileDescRef(ofd_idx), 0)
            .unwrap();

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 99).unwrap();

        let child_p = child.ofd_table.get(ofd_idx).unwrap().prime_bo().unwrap();
        assert_eq!(child_p.bo_id, bo);
        assert_eq!(child_p.cookie, cookie);
        assert_eq!(
            crate::dri::with_registry(|r| r.get(bo).map(|b| b.refcount)),
            Some(2)
        );

        crate::dri::with_registry(|r| {
            r.decref(bo);
            r.decref(bo);
        });
    }

    #[test]
    fn exec_preserves_kms_master_when_inherited() {
        use crate::ofd::{DriFdState, DriOfdState, KmsFdState};
        let _g = crate::dri::bo::TEST_REGISTRY_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        crate::dri::bo::reset_registry();

        let mut proc = Process::new(1);
        let ofd_idx = proc.ofd_table.create(
            crate::ofd::FileType::CharDevice,
            0,
            -9,
            b"/dev/dri/card0".to_vec(),
        );
        let kms = KmsFdState {
            holds_master: true,
            ..Default::default()
        };
        proc.ofd_table.get_mut(ofd_idx).unwrap().dri_state =
            Some(alloc::boxed::Box::new(DriOfdState::Card {
                dri: DriFdState::default(),
                kms,
            }));
        proc.fd_table
            .alloc(crate::fd::OpenFileDescRef(ofd_idx), 0)
            .unwrap();

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_exec_state(&proc, &mut buf).unwrap();
        let post = deserialize_exec_state(&buf[..written], proc.pid).unwrap();

        let post_kms = post.ofd_table.get(ofd_idx).unwrap().kms().unwrap();
        assert!(
            post_kms.holds_master,
            "exec keeps the same process identity; KMS master should survive"
        );
    }

    // ── ALSA fork/exec inheritance tests ──────────────────────────────────

    /// Build an AlsaFdState with the full state machine populated:
    /// committed HW/SW params, mmap pages with seeded ptrs, and a
    /// non-zero pcm_id. Lets the round-trip tests assert every field
    /// survives without relying on defaults.
    fn populated_alsa_pcm_state() -> crate::ofd::AlsaFdState {
        use crate::ofd::{AlsaFdState, HwParamsCache, PcmDir, SwParamsCache};
        use wasm_posix_shared::audio::{
            WpkAlsaPcmMmapControl, WpkAlsaPcmMmapStatus, SNDRV_PCM_FORMAT_S16_LE,
            SNDRV_PCM_STATE_RUNNING,
        };
        AlsaFdState {
            card: 0,
            device: 0,
            sub: 0,
            kind: PcmDir::Playback,
            state: SNDRV_PCM_STATE_RUNNING,
            hw_params: Some(alloc::boxed::Box::new(HwParamsCache {
                format: SNDRV_PCM_FORMAT_S16_LE,
                access: 0,
                channels: 2,
                rate: 48000,
                period_size: 1024,
                buffer_size: 4096,
                periods: 4,
            })),
            sw_params: Some(alloc::boxed::Box::new(SwParamsCache {
                avail_min: 1024,
                start_threshold: 2048,
                stop_threshold: 4096,
                boundary: 1 << 30,
            })),
            mmap_status: Some(alloc::boxed::Box::new(WpkAlsaPcmMmapStatus {
                state: SNDRV_PCM_STATE_RUNNING,
                hw_ptr: 512,
                tstamp_sec: 7,
                tstamp_nsec: 123_456_789,
                ..WpkAlsaPcmMmapStatus::default()
            })),
            mmap_control: Some(alloc::boxed::Box::new(WpkAlsaPcmMmapControl {
                appl_ptr: 1536,
                avail_min: 1024,
                _pad_after: 0,
            })),
            pcm_id: 0,
        }
    }

    #[test]
    fn fork_inherits_alsa_pcm_state() {
        use crate::syscalls::VirtualDevice;
        use wasm_posix_shared::audio::{
            SNDRV_PCM_FORMAT_S16_LE, SNDRV_PCM_STATE_RUNNING,
        };

        let mut proc = Process::new(1);
        let host_handle = VirtualDevice::AlsaPcm {
            card: 0,
            device: 0,
            sub: 0,
            kind: crate::ofd::PcmDir::Playback,
        }
        .host_handle();
        let ofd_idx = proc.ofd_table.create(
            crate::ofd::FileType::CharDevice,
            0,
            host_handle,
            b"/dev/snd/pcmC0D0p".to_vec(),
        );
        proc.ofd_table.get_mut(ofd_idx).unwrap().audio =
            Some(alloc::boxed::Box::new(populated_alsa_pcm_state()));
        proc.fd_table
            .alloc(crate::fd::OpenFileDescRef(ofd_idx), 0)
            .unwrap();

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 99).unwrap();

        let child_audio = child
            .ofd_table
            .get(ofd_idx)
            .unwrap()
            .audio()
            .expect("child must inherit AlsaFdState");
        assert_eq!(child_audio.card, 0);
        assert_eq!(child_audio.device, 0);
        assert_eq!(child_audio.sub, 0);
        assert_eq!(child_audio.kind, crate::ofd::PcmDir::Playback);
        assert_eq!(child_audio.state, SNDRV_PCM_STATE_RUNNING);
        let hw = child_audio.hw_params.as_deref().expect("hw_params survives");
        assert_eq!(hw.format, SNDRV_PCM_FORMAT_S16_LE);
        assert_eq!(hw.channels, 2);
        assert_eq!(hw.rate, 48000);
        assert_eq!(hw.period_size, 1024);
        assert_eq!(hw.buffer_size, 4096);
        assert_eq!(hw.periods, 4);
        let sw = child_audio.sw_params.as_deref().expect("sw_params survives");
        assert_eq!(sw.avail_min, 1024);
        assert_eq!(sw.start_threshold, 2048);
        assert_eq!(sw.stop_threshold, 4096);
        assert_eq!(sw.boundary, 1 << 30);
        let status = child_audio.mmap_status.as_deref().expect("status survives");
        assert_eq!(status.state, SNDRV_PCM_STATE_RUNNING);
        assert_eq!(status.hw_ptr, 512);
        assert_eq!(status.tstamp_sec, 7);
        assert_eq!(status.tstamp_nsec, 123_456_789);
        let ctl = child_audio.mmap_control.as_deref().expect("control survives");
        assert_eq!(ctl.appl_ptr, 1536);
        assert_eq!(ctl.avail_min, 1024);
        // pcm_id is per-fd; the SAB registry it indexes is a global keyed
        // by this id, so inheriting the id is enough — no per-fork copy.
        assert_eq!(child_audio.pcm_id, 0);
    }

    #[test]
    fn fork_inherits_alsa_control_state() {
        use crate::ofd::AlsaControlFdState;
        use crate::syscalls::VirtualDevice;

        let mut proc = Process::new(1);
        let host_handle = VirtualDevice::AlsaControl { card: 0 }.host_handle();
        let ofd_idx = proc.ofd_table.create(
            crate::ofd::FileType::CharDevice,
            0,
            host_handle,
            b"/dev/snd/controlC0".to_vec(),
        );
        proc.ofd_table.get_mut(ofd_idx).unwrap().audio_ctl =
            Some(alloc::boxed::Box::new(AlsaControlFdState { card: 0 }));
        proc.fd_table
            .alloc(crate::fd::OpenFileDescRef(ofd_idx), 0)
            .unwrap();

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 99).unwrap();

        let child_ctl = child
            .ofd_table
            .get(ofd_idx)
            .unwrap()
            .audio_ctl()
            .expect("child must inherit AlsaControlFdState");
        assert_eq!(child_ctl.card, 0);
    }

    #[test]
    fn exec_preserves_alsa_pcm_state() {
        use crate::syscalls::VirtualDevice;
        use wasm_posix_shared::audio::SNDRV_PCM_STATE_RUNNING;

        let mut proc = Process::new(1);
        let host_handle = VirtualDevice::AlsaPcm {
            card: 0,
            device: 0,
            sub: 0,
            kind: crate::ofd::PcmDir::Playback,
        }
        .host_handle();
        let ofd_idx = proc.ofd_table.create(
            crate::ofd::FileType::CharDevice,
            0,
            host_handle,
            b"/dev/snd/pcmC0D0p".to_vec(),
        );
        proc.ofd_table.get_mut(ofd_idx).unwrap().audio =
            Some(alloc::boxed::Box::new(populated_alsa_pcm_state()));
        proc.fd_table
            .alloc(crate::fd::OpenFileDescRef(ofd_idx), 0)
            .unwrap();

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_exec_state(&proc, &mut buf).unwrap();
        let post = deserialize_exec_state(&buf[..written], proc.pid).unwrap();

        // exec keeps the same process identity — the PCM state machine
        // snapshot, hw/sw params, mmap pages, and pcm_id must all
        // survive byte-for-byte.
        let post_audio = post
            .ofd_table
            .get(ofd_idx)
            .unwrap()
            .audio()
            .expect("exec must keep AlsaFdState");
        assert_eq!(post_audio.state, SNDRV_PCM_STATE_RUNNING);
        assert_eq!(post_audio.hw_params.as_deref().unwrap().rate, 48000);
        assert_eq!(post_audio.mmap_status.as_deref().unwrap().hw_ptr, 512);
        assert_eq!(post_audio.mmap_control.as_deref().unwrap().appl_ptr, 1536);
    }

    #[test]
    fn fork_audio_none_round_trips() {
        // An OFD without an audio sidecar (the common case for non-snd
        // fds) must encode + decode losslessly. Catches a stray byte
        // misread that would corrupt the wire stream for the next OFD.
        let mut proc = Process::new(1);
        let ofd_idx = proc.ofd_table.create(
            crate::ofd::FileType::Regular,
            0,
            5,
            b"/tmp/file".to_vec(),
        );
        proc.fd_table
            .alloc(crate::fd::OpenFileDescRef(ofd_idx), 0)
            .unwrap();

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 99).unwrap();

        let child_ofd = child.ofd_table.get(ofd_idx).unwrap();
        assert!(child_ofd.audio.is_none());
        assert!(child_ofd.audio_ctl.is_none());
    }
}
