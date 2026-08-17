//! Implementation-neutral, playback-only PCM stream core.
//!
//! OSS `/dev/dsp` is a frontend in `syscalls.rs`. The authoritative playback
//! state is a refcounted open-file-description backing, while one fixed,
//! versioned transport exposes the default physical device to browser and
//! Node audio clocks. No mixer, routing policy, capture, or Web Audio concept
//! is part of this module's guest-facing model.

extern crate alloc;

use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};

use wasm_posix_shared::{Errno, pcm};

const DEFAULT_RATE: u32 = 48_000;
const DEFAULT_CHANNELS: u32 = 2;
const DEFAULT_FORMAT: u32 = pcm::PCM_FORMAT_S16_LE;
const DEFAULT_FRAGMENT_BYTES: u32 = 1024;
const DEFAULT_FRAGMENT_COUNT: u32 = 4;
const MIN_RATE: u32 = 8_000;
const MAX_RATE: u32 = 192_000;
const MIN_FRAGMENT_EXP: u32 = 4;
const MAX_FRAGMENT_EXP: u32 = 16;
const PCM_WAKE_BASE: u32 = 0x2000_0000;

/// State owned by one logical PCM open file description. Forked process OFD
/// copies refer to the same backing table entry; `dup` aliases the local OFD.
#[derive(Debug)]
pub struct PcmStream {
    pub requested_format: u32,
    pub actual_format: u32,
    pub requested_rate: u32,
    pub actual_rate: u32,
    pub requested_channels: u32,
    pub actual_channels: u32,
    pub fragment_bytes: u32,
    pub fragment_count: u32,
    pub optr_played_base: u64,
    pub optr_consumer_base: u64,
    pub last_optr_blocks: u64,
    pub nonblock: bool,
}

/// Implementation-neutral output-buffer availability returned to frontends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PcmOutputSpace {
    pub available_fragments: u32,
    pub total_fragments: u32,
    pub fragment_bytes: u32,
    pub available_bytes: u32,
}

/// Implementation-neutral audio-clock playback position returned to frontends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PcmPosition {
    pub played_bytes: u64,
    pub completed_fragments: u32,
    pub ring_offset: u32,
}

impl PcmStream {
    fn new() -> Self {
        Self {
            requested_format: DEFAULT_FORMAT,
            actual_format: DEFAULT_FORMAT,
            requested_rate: DEFAULT_RATE,
            actual_rate: DEFAULT_RATE,
            requested_channels: DEFAULT_CHANNELS,
            actual_channels: DEFAULT_CHANNELS,
            fragment_bytes: DEFAULT_FRAGMENT_BYTES,
            fragment_count: DEFAULT_FRAGMENT_COUNT,
            optr_played_base: 0,
            optr_consumer_base: 0,
            last_optr_blocks: 0,
            nonblock: false,
        }
    }

    fn frame_bytes(&self) -> u32 {
        sample_bytes(self.actual_format) * self.actual_channels
    }

    fn capacity(&self) -> u32 {
        self.fragment_bytes * self.fragment_count
    }
}

#[repr(C)]
struct AtomicPcmControl {
    magic: AtomicU32,
    version: AtomicU32,
    header_bytes: AtomicU32,
    physical_capacity_bytes: AtomicU32,
    active_capacity_bytes: AtomicU32,
    format: AtomicU32,
    rate: AtomicU32,
    channels: AtomicU32,
    frame_bytes: AtomicU32,
    fragment_bytes: AtomicU32,
    fragment_count: AtomicU32,
    state: AtomicU32,
    generation: AtomicU32,
    flags: AtomicU32,
    transport_mode: AtomicU32,
    producer_seq: AtomicU32,
    producer_lo: AtomicU32,
    producer_hi: AtomicU32,
    consumer_seq: AtomicU32,
    consumer_lo: AtomicU32,
    consumer_hi: AtomicU32,
    discard_seq: AtomicU32,
    discard_lo: AtomicU32,
    discard_hi: AtomicU32,
    underruns: AtomicU32,
    wake_seq: AtomicU32,
    reserved: [AtomicU32; 6],
}

impl AtomicPcmControl {
    const fn new() -> Self {
        Self {
            magic: AtomicU32::new(pcm::PCM_TRANSPORT_MAGIC),
            version: AtomicU32::new(pcm::PCM_TRANSPORT_VERSION),
            header_bytes: AtomicU32::new(pcm::PCM_TRANSPORT_HEADER_BYTES),
            physical_capacity_bytes: AtomicU32::new(pcm::PCM_TRANSPORT_RING_BYTES),
            active_capacity_bytes: AtomicU32::new(DEFAULT_FRAGMENT_BYTES * DEFAULT_FRAGMENT_COUNT),
            format: AtomicU32::new(DEFAULT_FORMAT),
            rate: AtomicU32::new(DEFAULT_RATE),
            channels: AtomicU32::new(DEFAULT_CHANNELS),
            frame_bytes: AtomicU32::new(4),
            fragment_bytes: AtomicU32::new(DEFAULT_FRAGMENT_BYTES),
            fragment_count: AtomicU32::new(DEFAULT_FRAGMENT_COUNT),
            state: AtomicU32::new(pcm::PCM_STATE_CLOSED),
            generation: AtomicU32::new(0),
            flags: AtomicU32::new(0),
            transport_mode: AtomicU32::new(pcm::PCM_TRANSPORT_UNCLAIMED),
            producer_seq: AtomicU32::new(0),
            producer_lo: AtomicU32::new(0),
            producer_hi: AtomicU32::new(0),
            consumer_seq: AtomicU32::new(0),
            consumer_lo: AtomicU32::new(0),
            consumer_hi: AtomicU32::new(0),
            discard_seq: AtomicU32::new(0),
            discard_lo: AtomicU32::new(0),
            discard_hi: AtomicU32::new(0),
            underruns: AtomicU32::new(0),
            wake_seq: AtomicU32::new(0),
            reserved: [const { AtomicU32::new(0) }; 6],
        }
    }
}

#[repr(C, align(64))]
struct SharedTransport {
    control: AtomicPcmControl,
    ring: UnsafeCell<[u8; pcm::PCM_TRANSPORT_RING_BYTES as usize]>,
}

// SAFETY: ring bytes have one kernel producer and one host audio-clock
// consumer. Release/acquire publication of the cursors synchronizes access.
unsafe impl Sync for SharedTransport {}

static TRANSPORT: SharedTransport = SharedTransport {
    control: AtomicPcmControl::new(),
    ring: UnsafeCell::new([0; pcm::PCM_TRANSPORT_RING_BYTES as usize]),
};

static ACTIVE_STREAM: AtomicI32 = AtomicI32::new(-1);
static ORPHAN_DRAINING: AtomicBool = AtomicBool::new(false);

struct KernelCursor(UnsafeCell<u64>);
unsafe impl Sync for KernelCursor {}
static LAST_RECONCILED_CONSUMER: KernelCursor = KernelCursor(UnsafeCell::new(0));
static PLAYED_BYTES: KernelCursor = KernelCursor(UnsafeCell::new(0));

fn sample_bytes(format: u32) -> u32 {
    match format {
        pcm::PCM_FORMAT_U8 => 1,
        pcm::PCM_FORMAT_S16_LE | pcm::PCM_FORMAT_S16_BE => 2,
        _ => 0,
    }
}

fn read_cursor(seq: &AtomicU32, lo: &AtomicU32, hi: &AtomicU32) -> u64 {
    loop {
        let before = seq.load(Ordering::Acquire);
        if before & 1 != 0 {
            core::hint::spin_loop();
            continue;
        }
        let low = lo.load(Ordering::Relaxed);
        let high = hi.load(Ordering::Relaxed);
        let after = seq.load(Ordering::Acquire);
        if before == after {
            return ((high as u64) << 32) | low as u64;
        }
    }
}

fn write_cursor(seq: &AtomicU32, lo: &AtomicU32, hi: &AtomicU32, value: u64) {
    seq.fetch_add(1, Ordering::AcqRel);
    lo.store(value as u32, Ordering::Relaxed);
    hi.store((value >> 32) as u32, Ordering::Relaxed);
    seq.fetch_add(1, Ordering::Release);
}

fn producer() -> u64 {
    let c = &TRANSPORT.control;
    read_cursor(&c.producer_seq, &c.producer_lo, &c.producer_hi)
}

fn consumer() -> u64 {
    let c = &TRANSPORT.control;
    read_cursor(&c.consumer_seq, &c.consumer_lo, &c.consumer_hi)
}

fn discard() -> u64 {
    let c = &TRANSPORT.control;
    read_cursor(&c.discard_seq, &c.discard_lo, &c.discard_hi)
}

fn effective_consumer() -> u64 {
    consumer().max(discard()).min(producer())
}

fn queued_bytes() -> u64 {
    producer().saturating_sub(effective_consumer())
}

fn publish_producer(value: u64) {
    let c = &TRANSPORT.control;
    write_cursor(&c.producer_seq, &c.producer_lo, &c.producer_hi, value);
}

fn publish_consumer(value: u64) {
    let c = &TRANSPORT.control;
    write_cursor(&c.consumer_seq, &c.consumer_lo, &c.consumer_hi, value);
}

fn publish_discard(value: u64) {
    let c = &TRANSPORT.control;
    write_cursor(&c.discard_seq, &c.discard_lo, &c.discard_hi, value);
}

pub fn stream_handle(idx: usize) -> i64 {
    -(idx as i64) - 1
}

pub fn stream_index(handle: i64) -> Result<usize, Errno> {
    if handle >= 0 {
        return Err(Errno::EBADF);
    }
    usize::try_from(-(handle + 1)).map_err(|_| Errno::EBADF)
}

fn wake_token(idx: usize) -> u32 {
    PCM_WAKE_BASE.saturating_add(idx as u32)
}

pub fn wake_token_for_handle(handle: i64) -> Result<u32, Errno> {
    Ok(wake_token(stream_index(handle)?))
}

fn configure_transport(stream: &PcmStream) {
    let c = &TRANSPORT.control;
    c.active_capacity_bytes
        .store(stream.capacity(), Ordering::Release);
    c.format.store(stream.actual_format, Ordering::Release);
    c.rate.store(stream.actual_rate, Ordering::Release);
    c.channels.store(stream.actual_channels, Ordering::Release);
    c.frame_bytes.store(stream.frame_bytes(), Ordering::Release);
    c.fragment_bytes
        .store(stream.fragment_bytes, Ordering::Release);
    c.fragment_count
        .store(stream.fragment_count, Ordering::Release);
}

/// Publish configuration as one host-observable generation. The configuring
/// bit closes the interval in which the individual atomic fields would
/// otherwise form a torn snapshot for a concurrent host audio clock.
fn publish_configuration(stream: &PcmStream) {
    let c = &TRANSPORT.control;
    c.flags
        .fetch_or(pcm::PCM_FLAG_CONFIGURING, Ordering::AcqRel);
    configure_transport(stream);
    c.generation.fetch_add(1, Ordering::AcqRel);
    c.flags.fetch_and(
        !(pcm::PCM_FLAG_CONFIGURING | pcm::PCM_FLAG_UNDERRUN_ACTIVE),
        Ordering::Release,
    );
}

fn clear_underrun_episode() {
    TRANSPORT
        .control
        .flags
        .fetch_and(!pcm::PCM_FLAG_UNDERRUN_ACTIVE, Ordering::AcqRel);
}

fn note_underrun_episode() {
    let was_active = TRANSPORT
        .control
        .flags
        .fetch_or(pcm::PCM_FLAG_UNDERRUN_ACTIVE, Ordering::AcqRel)
        & pcm::PCM_FLAG_UNDERRUN_ACTIVE
        != 0;
    if !was_active {
        TRANSPORT.control.underruns.fetch_add(1, Ordering::AcqRel);
    }
}

fn enter_stopped_generation() {
    clear_underrun_episode();
    TRANSPORT
        .control
        .state
        .store(pcm::PCM_STATE_STOPPED, Ordering::Release);
    TRANSPORT.control.generation.fetch_add(1, Ordering::AcqRel);
}

pub fn has_fatal_error(handle: i64) -> Result<bool, Errno> {
    with_stream(handle, |_| {
        TRANSPORT.control.flags.load(Ordering::Acquire) & pcm::PCM_FLAG_FATAL_ERROR != 0
    })
}

fn reset_transport_for_open(stream: &mut PcmStream) {
    let c = &TRANSPORT.control;
    c.state.store(pcm::PCM_STATE_CLOSED, Ordering::Release);

    // The host audio clock can still be finishing a quantum from the previous
    // generation while RESET + close + reopen runs in the kernel worker. Keep
    // the live transport cursors monotonic across opens so such a stale
    // consumer publication can never jump ahead of the new stream. The new
    // discard floor makes every byte from the prior generation unreachable;
    // subsequent writes continue from the same absolute producer position.
    let base = producer();
    publish_discard(base);
    unsafe { *LAST_RECONCILED_CONSUMER.0.get() = base };
    unsafe { *PLAYED_BYTES.0.get() = 0 };
    stream.optr_played_base = 0;
    stream.optr_consumer_base = base;
    stream.last_optr_blocks = 0;
    c.underruns.store(0, Ordering::Release);
    publish_configuration(stream);
    c.state.store(pcm::PCM_STATE_STOPPED, Ordering::Release);
    ORPHAN_DRAINING.store(false, Ordering::Release);
}

/// Allocate and exclusively claim the one default playback stream.
pub fn open_stream() -> Result<i64, Errno> {
    if ACTIVE_STREAM.load(Ordering::Acquire) != -1 {
        return Err(Errno::EBUSY);
    }
    let stream = PcmStream::new();
    let idx = crate::descriptor_backing::with_pcm_streams(|table| table.alloc(stream));
    if ACTIVE_STREAM
        .compare_exchange(-1, idx as i32, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        crate::descriptor_backing::with_pcm_streams(|table| {
            table.release(idx);
        });
        return Err(Errno::EBUSY);
    }
    crate::descriptor_backing::with_pcm_streams(|table| {
        let stream = table.get_mut(idx).expect("new PCM backing");
        reset_transport_for_open(stream);
    });
    Ok(stream_handle(idx))
}

pub fn rollback_open(handle: i64) {
    if let Ok(idx) = stream_index(handle) {
        crate::descriptor_backing::with_pcm_streams(|table| {
            table.release(idx);
        });
        finish_closed(idx);
    }
}

fn finish_closed(idx: usize) {
    if ACTIVE_STREAM
        .compare_exchange(idx as i32, -1, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        ORPHAN_DRAINING.store(false, Ordering::Release);
        clear_underrun_episode();
        TRANSPORT
            .control
            .state
            .store(pcm::PCM_STATE_CLOSED, Ordering::Release);
    }
}

/// Called after the final cross-process OFD reference disappears. A queued
/// tail becomes an orphan drain and keeps exclusive ownership until the audio
/// clock reaches the producer; empty streams release immediately.
pub fn on_last_ofd_released(idx: usize) {
    if ACTIVE_STREAM.load(Ordering::Acquire) != idx as i32 {
        return;
    }
    if TRANSPORT.control.flags.load(Ordering::Acquire) & pcm::PCM_FLAG_FATAL_ERROR != 0 {
        publish_discard(producer());
        finish_closed(idx);
        return;
    }
    pad_terminal_frame();
    if queued_bytes() == 0 {
        finish_closed(idx);
    } else {
        ORPHAN_DRAINING.store(true, Ordering::Release);
        clear_underrun_episode();
        TRANSPORT
            .control
            .state
            .store(pcm::PCM_STATE_DRAINING, Ordering::Release);
    }
}

fn with_stream<R>(handle: i64, f: impl FnOnce(&mut PcmStream) -> R) -> Result<R, Errno> {
    let idx = stream_index(handle)?;
    crate::descriptor_backing::with_pcm_streams(|table| {
        table.get_mut(idx).map(f).ok_or(Errno::EBADF)
    })
}

fn ensure_configurable() -> Result<(), Errno> {
    match TRANSPORT.control.state.load(Ordering::Acquire) {
        pcm::PCM_STATE_RUNNING | pcm::PCM_STATE_DRAINING => Err(Errno::EBUSY),
        _ => Ok(()),
    }
}

pub fn set_rate(handle: i64, requested: u32) -> Result<u32, Errno> {
    if requested == 0 {
        return with_stream(handle, |stream| stream.actual_rate);
    }
    ensure_configurable()?;
    with_stream(handle, |stream| {
        stream.requested_rate = requested;
        stream.actual_rate = requested.clamp(MIN_RATE, MAX_RATE);
        publish_configuration(stream);
        stream.actual_rate
    })
}

pub fn set_channels(handle: i64, requested: u32) -> Result<u32, Errno> {
    if requested == 0 {
        return with_stream(handle, |stream| stream.actual_channels);
    }
    ensure_configurable()?;
    with_stream(handle, |stream| {
        stream.requested_channels = requested;
        stream.actual_channels = if requested == 1 { 1 } else { 2 };
        publish_configuration(stream);
        stream.actual_channels
    })
}

pub fn set_format(handle: i64, requested: u32) -> Result<u32, Errno> {
    if requested == pcm::PCM_FORMAT_UNKNOWN {
        return with_stream(handle, |stream| stream.actual_format);
    }
    if !matches!(
        requested,
        pcm::PCM_FORMAT_U8 | pcm::PCM_FORMAT_S16_LE | pcm::PCM_FORMAT_S16_BE
    ) {
        return Err(Errno::EINVAL);
    }
    ensure_configurable()?;
    with_stream(handle, |stream| {
        stream.requested_format = requested;
        stream.actual_format = requested;
        publish_configuration(stream);
        stream.actual_format
    })
}

pub fn set_fragment(handle: i64, encoded: u32) -> Result<u32, Errno> {
    ensure_configurable()?;
    with_stream(handle, |stream| {
        let exp = (encoded & 0xffff).clamp(MIN_FRAGMENT_EXP, MAX_FRAGMENT_EXP);
        let fragment_bytes = 1u32 << exp;
        let requested_count = encoded >> 16;
        let max_count = (pcm::PCM_TRANSPORT_RING_BYTES / fragment_bytes).max(1);
        let fragment_count = if requested_count == 0 {
            max_count
        } else {
            requested_count.clamp(max_count.min(2), max_count)
        };
        stream.fragment_bytes = fragment_bytes;
        stream.fragment_count = fragment_count;
        let played = unsafe { *PLAYED_BYTES.0.get() };
        stream.last_optr_blocks =
            played.saturating_sub(stream.optr_played_base) / fragment_bytes as u64;
        publish_configuration(stream);
        (fragment_count << 16) | exp
    })
}

pub fn config(handle: i64) -> Result<(u32, u32, u32), Errno> {
    with_stream(handle, |stream| {
        (
            stream.actual_format,
            stream.actual_rate,
            stream.actual_channels,
        )
    })
}

pub fn geometry(handle: i64) -> Result<(u32, u32), Errno> {
    with_stream(handle, |stream| {
        (stream.fragment_bytes, stream.fragment_count)
    })
}

pub fn set_nonblock(handle: i64, enabled: bool) -> Result<(), Errno> {
    with_stream(handle, |stream| stream.nonblock = enabled)
}

pub fn is_nonblock(handle: i64) -> Result<bool, Errno> {
    with_stream(handle, |stream| stream.nonblock)
}

pub fn write(handle: i64, data: &[u8], nonblock: bool) -> Result<usize, Errno> {
    if data.is_empty() {
        return Ok(0);
    }
    with_stream(handle, |stream| {
        if TRANSPORT.control.flags.load(Ordering::Acquire) & pcm::PCM_FLAG_FATAL_ERROR != 0 {
            return Err(Errno::EIO);
        }
        let capacity = stream.capacity() as usize;
        let queued = queued_bytes().min(capacity as u64) as usize;
        let free = capacity.saturating_sub(queued);
        if free == 0 {
            return Err(Errno::EAGAIN);
        }
        if !nonblock && data.len() <= capacity && free < data.len() {
            // A queued partial frame cannot be consumed by the audio clock.
            // Permit a short write when it completes that frame; insisting on
            // room for the entire request here would deadlock both sides.
            let frame = stream.frame_bytes().max(1) as usize;
            let remainder = queued % frame;
            let completes_partial = remainder != 0 && free >= frame - remainder;
            if !completes_partial {
                return Err(Errno::EAGAIN);
            }
        }
        let n = data.len().min(free);
        if n == 0 {
            return Err(Errno::EAGAIN);
        }
        let producer_before = producer();
        let start = (producer_before % capacity as u64) as usize;
        let first = n.min(capacity - start);
        unsafe {
            let ring = (*TRANSPORT.ring.get()).as_mut_ptr();
            core::ptr::copy_nonoverlapping(data.as_ptr(), ring.add(start), first);
            if first < n {
                core::ptr::copy_nonoverlapping(data.as_ptr().add(first), ring, n - first);
            }
        }
        publish_producer(producer_before + n as u64);
        TRANSPORT
            .control
            .state
            .store(pcm::PCM_STATE_RUNNING, Ordering::Release);
        Ok(n)
    })?
}

/// Complete a final partial frame before a drain. OSS exposes `/dev/dsp` as a
/// byte stream, while the physical sink advances in whole frames. Padding is
/// therefore part of drain/close, not an alignment restriction on `write()`.
fn pad_terminal_frame() {
    let frame = TRANSPORT.control.frame_bytes.load(Ordering::Acquire).max(1) as u64;
    let queued = queued_bytes();
    let remainder = queued % frame;
    if remainder == 0 {
        return;
    }
    let padding = (frame - remainder) as usize;
    let capacity = TRANSPORT
        .control
        .active_capacity_bytes
        .load(Ordering::Acquire) as usize;
    if capacity == 0 || queued.saturating_add(padding as u64) > capacity as u64 {
        return;
    }
    let fill = if TRANSPORT.control.format.load(Ordering::Acquire) == pcm::PCM_FORMAT_U8 {
        0x80
    } else {
        0
    };
    let before = producer();
    let start = (before % capacity as u64) as usize;
    unsafe {
        let ring = (*TRANSPORT.ring.get()).as_mut_ptr();
        for offset in 0..padding {
            ring.add((start + offset) % capacity).write(fill);
        }
    }
    publish_producer(before + padding as u64);
}

pub fn poll_writable(handle: i64) -> Result<bool, Errno> {
    with_stream(handle, |stream| {
        if TRANSPORT.control.flags.load(Ordering::Acquire) & pcm::PCM_FLAG_FATAL_ERROR != 0 {
            return Err(Errno::EIO);
        }
        let free = stream.capacity() as u64 - queued_bytes().min(stream.capacity() as u64);
        Ok(free >= stream.fragment_bytes as u64)
    })?
}

pub fn output_space(handle: i64) -> Result<PcmOutputSpace, Errno> {
    with_stream(handle, |stream| {
        if TRANSPORT.control.flags.load(Ordering::Acquire) & pcm::PCM_FLAG_FATAL_ERROR != 0 {
            return Err(Errno::EIO);
        }
        let free = stream.capacity() as u64 - queued_bytes().min(stream.capacity() as u64);
        Ok(PcmOutputSpace {
            available_fragments: (free / stream.fragment_bytes as u64) as u32,
            total_fragments: stream.fragment_count,
            fragment_bytes: stream.fragment_bytes,
            available_bytes: free as u32,
        })
    })?
}

pub fn output_delay(handle: i64) -> Result<i32, Errno> {
    with_stream(handle, |stream| {
        queued_bytes().min(stream.capacity() as u64) as i32
    })
}

pub fn output_pointer(handle: i64) -> Result<PcmPosition, Errno> {
    with_stream(handle, |_| ())?;
    // GETOPTR observes the audio clock, so first account for a consumer
    // publication that has not yet passed through the syscall path.
    reconcile();
    with_stream(handle, |stream| {
        let played = unsafe { *PLAYED_BYTES.0.get() }.saturating_sub(stream.optr_played_base);
        let blocks = played / stream.fragment_bytes as u64;
        let delta = blocks.saturating_sub(stream.last_optr_blocks);
        stream.last_optr_blocks = blocks;
        PcmPosition {
            played_bytes: played,
            completed_fragments: delta.min(u32::MAX as u64) as u32,
            ring_offset: (effective_consumer().saturating_sub(stream.optr_consumer_base)
                % stream.capacity() as u64) as u32,
        }
    })
}

pub fn post(handle: i64) -> Result<(), Errno> {
    with_stream(handle, |_| ())?;
    if has_fatal_error(handle)? {
        return Err(Errno::EIO);
    }
    clear_underrun_episode();
    TRANSPORT
        .control
        .state
        .store(pcm::PCM_STATE_RUNNING, Ordering::Release);
    Ok(())
}

pub fn sync(handle: i64) -> Result<(), Errno> {
    with_stream(handle, |_| ())?;
    if has_fatal_error(handle)? {
        return Err(Errno::EIO);
    }
    pad_terminal_frame();
    reconcile();
    if queued_bytes() == 0 {
        enter_stopped_generation();
        Ok(())
    } else {
        clear_underrun_episode();
        TRANSPORT
            .control
            .state
            .store(pcm::PCM_STATE_DRAINING, Ordering::Release);
        Err(Errno::EAGAIN)
    }
}

pub fn reset_stream(handle: i64) -> Result<(), Errno> {
    with_stream(handle, |_| ())?;
    // Account for a shared-clock consumer update before discard changes the
    // effective-consumer floor; otherwise RESET could erase played position.
    reconcile();
    let end = producer();
    publish_discard(end);
    TRANSPORT.control.generation.fetch_add(1, Ordering::AcqRel);
    TRANSPORT
        .control
        .state
        .store(pcm::PCM_STATE_STOPPED, Ordering::Release);
    clear_underrun_episode();
    reconcile();
    let played_base = unsafe { *PLAYED_BYTES.0.get() };
    let consumer_base = effective_consumer();
    with_stream(handle, |stream| {
        stream.optr_played_base = played_base;
        stream.optr_consumer_base = consumer_base;
        stream.last_optr_blocks = 0;
    })?;
    Ok(())
}

/// Explicit final close drains before fd/OFD removal. The host turns this
/// internal EAGAIN into a blocking retry, leaving the descriptor valid.
pub fn preflight_close(handle: i64) -> Result<(), Errno> {
    let idx = stream_index(handle)?;
    let last = crate::descriptor_backing::with_pcm_streams(|table| table.ref_count(idx) == Some(1));
    if !last {
        return Ok(());
    }
    if has_fatal_error(handle)? {
        publish_discard(producer());
        return Err(Errno::EIO);
    }
    pad_terminal_frame();
    reconcile();
    if queued_bytes() == 0 {
        Ok(())
    } else {
        clear_underrun_episode();
        TRANSPORT
            .control
            .state
            .store(pcm::PCM_STATE_DRAINING, Ordering::Release);
        Err(Errno::EAGAIN)
    }
}

pub fn reconcile() -> i32 {
    let active = ACTIVE_STREAM.load(Ordering::Acquire);
    if active < 0 {
        return 0;
    }
    let now = effective_consumer();
    let discard_floor = discard();
    let previous = unsafe { &mut *LAST_RECONCILED_CONSUMER.0.get() };
    let advanced = now > *previous;
    let played_delta = now.saturating_sub((*previous).max(discard_floor));
    if played_delta != 0 {
        unsafe {
            *PLAYED_BYTES.0.get() = (*PLAYED_BYTES.0.get()).saturating_add(played_delta);
        }
    }
    *previous = (*previous).max(now);
    if advanced {
        crate::wakeup::push(wake_token(active as usize), crate::wakeup::WAKE_WRITABLE);
    }
    // There is no OFD left to observe EIO once an implicit close has turned a
    // queued tail into an orphan drain. If the physical sink fails after that
    // transition, it can never advance the consumer to empty the queue. Drop
    // only the unplayed tail and release exclusive ownership; consumer bytes
    // reconciled above remain the sole source of played-position accounting.
    let fatal_orphan = ORPHAN_DRAINING.load(Ordering::Acquire)
        && TRANSPORT.control.flags.load(Ordering::Acquire) & pcm::PCM_FLAG_FATAL_ERROR != 0;
    if fatal_orphan {
        publish_discard(producer());
        finish_closed(active as usize);
    } else if queued_bytes() == 0 {
        if ORPHAN_DRAINING.load(Ordering::Acquire) {
            finish_closed(active as usize);
        } else if TRANSPORT.control.state.load(Ordering::Acquire) == pcm::PCM_STATE_DRAINING {
            enter_stopped_generation();
        }
    }
    if advanced { 1 } else { 0 }
}

pub fn claim_transport(mode: u32) -> Result<(), Errno> {
    if !matches!(
        mode,
        pcm::PCM_TRANSPORT_LEGACY_PULL | pcm::PCM_TRANSPORT_SHARED_CLOCK
    ) {
        return Err(Errno::EINVAL);
    }
    let slot = &TRANSPORT.control.transport_mode;
    loop {
        let current = slot.load(Ordering::Acquire);
        if current == mode {
            return Ok(());
        }
        if current != pcm::PCM_TRANSPORT_UNCLAIMED {
            return Err(Errno::EBUSY);
        }
        if slot
            .compare_exchange(current, mode, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            return Ok(());
        }
    }
}

pub fn clock_update(requested_frames: u32) -> u32 {
    if claim_transport(pcm::PCM_TRANSPORT_SHARED_CLOCK).is_err() {
        return 0;
    }
    let frame = TRANSPORT.control.frame_bytes.load(Ordering::Acquire).max(1) as u64;
    let available_frames = queued_bytes() / frame;
    let consumed_frames = available_frames.min(requested_frames as u64);
    let state = TRANSPORT.control.state.load(Ordering::Acquire);
    if consumed_frames != 0 || state != pcm::PCM_STATE_RUNNING {
        clear_underrun_episode();
    }
    if requested_frames != 0
        && consumed_frames < requested_frames as u64
        && state == pcm::PCM_STATE_RUNNING
    {
        note_underrun_episode();
    }
    if consumed_frames != 0 {
        publish_consumer(effective_consumer() + consumed_frames * frame);
    }
    TRANSPORT.control.wake_seq.fetch_add(1, Ordering::AcqRel);
    reconcile();
    consumed_frames as u32
}

/// Compatibility pull consumer retained for existing hosts. A claimed shared
/// clock wins exclusively, so this path can never race an AudioWorklet.
pub fn drain_into(out: &mut [u8]) -> usize {
    if claim_transport(pcm::PCM_TRANSPORT_LEGACY_PULL).is_err() {
        return 0;
    }
    let frame = TRANSPORT.control.frame_bytes.load(Ordering::Acquire).max(1) as usize;
    let capacity = TRANSPORT
        .control
        .active_capacity_bytes
        .load(Ordering::Acquire)
        .max(1) as usize;
    let available = queued_bytes().min(capacity as u64) as usize;
    let n = out.len().min(available) / frame * frame;
    if n == 0 {
        return 0;
    }
    let before = effective_consumer();
    let start = (before % capacity as u64) as usize;
    let first = n.min(capacity - start);
    unsafe {
        let ring = (*TRANSPORT.ring.get()).as_ptr();
        core::ptr::copy_nonoverlapping(ring.add(start), out.as_mut_ptr(), first);
        if first < n {
            core::ptr::copy_nonoverlapping(ring, out.as_mut_ptr().add(first), n - first);
        }
    }
    publish_consumer(before + n as u64);
    TRANSPORT.control.wake_seq.fetch_add(1, Ordering::AcqRel);
    reconcile();
    n
}

pub fn pending_bytes() -> usize {
    queued_bytes() as usize
}

pub fn current_config() -> (u32, u32) {
    (
        TRANSPORT.control.rate.load(Ordering::Acquire),
        TRANSPORT.control.channels.load(Ordering::Acquire),
    )
}

pub fn transport_ptr() -> *const u8 {
    core::ptr::addr_of!(TRANSPORT).cast()
}

pub const fn transport_len() -> u32 {
    pcm::PCM_TRANSPORT_BYTES
}

#[cfg(test)]
pub static TEST_AUDIO_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub fn reset_for_test() {
    let active = ACTIVE_STREAM.swap(-1, Ordering::AcqRel);
    if active >= 0 {
        crate::descriptor_backing::with_pcm_streams(|table| {
            while table.ref_count(active as usize).is_some() {
                if table.release(active as usize) {
                    break;
                }
            }
        });
    }
    ORPHAN_DRAINING.store(false, Ordering::Release);
    TRANSPORT
        .control
        .state
        .store(pcm::PCM_STATE_CLOSED, Ordering::Release);
    TRANSPORT
        .control
        .transport_mode
        .store(pcm::PCM_TRANSPORT_UNCLAIMED, Ordering::Release);
    TRANSPORT.control.flags.store(0, Ordering::Release);
    TRANSPORT.control.underruns.store(0, Ordering::Release);
    publish_producer(0);
    publish_consumer(0);
    publish_discard(0);
    unsafe { *LAST_RECONCILED_CONSUMER.0.get() = 0 };
    unsafe { *PLAYED_BYTES.0.get() = 0 };
}

#[cfg(test)]
pub fn mark_fatal_error_for_test() {
    TRANSPORT
        .control
        .flags
        .fetch_or(pcm::PCM_FLAG_FATAL_ERROR, Ordering::AcqRel);
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::mem::{offset_of, size_of};

    fn fresh() -> (std::sync::MutexGuard<'static, ()>, i64) {
        let guard = TEST_AUDIO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        let handle = open_stream().unwrap();
        (guard, handle)
    }

    #[test]
    fn atomic_transport_matches_shared_layout() {
        assert_eq!(
            size_of::<AtomicPcmControl>(),
            pcm::PCM_TRANSPORT_HEADER_BYTES as usize
        );
        assert_eq!(
            offset_of!(SharedTransport, ring),
            pcm::PCM_TRANSPORT_HEADER_BYTES as usize
        );
        assert_eq!(
            size_of::<SharedTransport>(),
            pcm::PCM_TRANSPORT_BYTES as usize
        );
    }

    #[test]
    fn ring_wraparound_preserves_pcm() {
        let (_guard, handle) = fresh();
        set_fragment(handle, (2 << 16) | 4).unwrap();
        let first = [1u8; 28];
        assert_eq!(write(handle, &first, false).unwrap(), 28);
        let mut drained = [0u8; 24];
        assert_eq!(drain_into(&mut drained), 24);
        let second = [2u8; 24];
        assert_eq!(write(handle, &second, false).unwrap(), 24);
        let mut all = [0u8; 28];
        assert_eq!(drain_into(&mut all), 28);
        assert_eq!(&all[..4], &[1; 4]);
        assert_eq!(&all[4..], &[2; 24]);
    }

    #[test]
    fn blocking_and_nonblocking_backpressure() {
        let (_guard, handle) = fresh();
        set_fragment(handle, (2 << 16) | 4).unwrap();
        let full = [0u8; 32];
        assert_eq!(write(handle, &full, false).unwrap(), 32);
        assert_eq!(write(handle, &[0; 4], false), Err(Errno::EAGAIN));
        let mut out = [0u8; 8];
        assert_eq!(drain_into(&mut out), 8);
        assert_eq!(write(handle, &[0; 12], false), Err(Errno::EAGAIN));
        assert_eq!(write(handle, &[0; 12], true).unwrap(), 8);
    }

    #[test]
    fn blocking_write_can_complete_a_queued_partial_frame() {
        let (_guard, handle) = fresh();
        set_fragment(handle, (2 << 16) | 4).unwrap();
        assert_eq!(write(handle, &[1], false).unwrap(), 1);

        // Waiting for all 32 bytes would deadlock: the audio clock cannot
        // consume the queued single byte until this write completes a frame.
        assert_eq!(write(handle, &[2; 32], false).unwrap(), 31);
        assert_eq!(pending_bytes(), 32);
        assert_eq!(drain_into(&mut [0; 32]), 32);
    }

    #[test]
    fn reset_discards_without_rewinding_monotonic_producer() {
        let (_guard, handle) = fresh();
        write(handle, &[0; 16], false).unwrap();
        let before = producer();
        reset_stream(handle).unwrap();
        assert_eq!(pending_bytes(), 0);
        assert_eq!(producer(), before);
        assert_eq!(discard(), before);
    }

    #[test]
    fn fragment_encoding_clamps_and_zero_count_means_maximum() {
        let (_guard, handle) = fresh();
        assert_eq!(set_fragment(handle, 3).unwrap(), (4096 << 16) | 4);
        assert_eq!(geometry(handle).unwrap(), (16, 4096));
        assert_eq!(
            set_fragment(handle, (1 << 16) | 10).unwrap(),
            (2 << 16) | 10
        );
        reset_stream(handle).unwrap();
        assert_eq!(
            set_fragment(handle, (7 << 16) | 20).unwrap(),
            (1 << 16) | 16
        );
        assert_eq!(geometry(handle).unwrap(), (65_536, 1));
    }

    #[test]
    fn reset_discard_does_not_advance_played_position() {
        let (_guard, handle) = fresh();
        write(handle, &[1; 8], false).unwrap();
        assert_eq!(drain_into(&mut [0; 8]), 8);
        assert_eq!(output_pointer(handle).unwrap().played_bytes, 8);
        write(handle, &[2; 8], false).unwrap();
        reset_stream(handle).unwrap();
        assert_eq!(
            output_pointer(handle).unwrap(),
            PcmPosition {
                played_bytes: 0,
                completed_fragments: 0,
                ring_offset: 0,
            }
        );
    }

    #[test]
    fn reset_reconciles_shared_consumer_before_discarding_tail() {
        let (_guard, handle) = fresh();
        write(handle, &[1; 16], false).unwrap();
        publish_consumer(8);
        reset_stream(handle).unwrap();
        assert_eq!(output_pointer(handle).unwrap().played_bytes, 0);
        assert_eq!(pending_bytes(), 0);
    }

    #[test]
    fn getoptr_reconciles_and_reports_reset_relative_position() {
        let (_guard, handle) = fresh();
        set_fragment(handle, (4 << 16) | 4).unwrap();
        write(handle, &[1; 64], false).unwrap();

        // Model a shared-clock publication that has not reached reconcile().
        publish_consumer(48);
        assert_eq!(
            output_pointer(handle).unwrap(),
            PcmPosition {
                played_bytes: 48,
                completed_fragments: 3,
                ring_offset: 48,
            }
        );

        reset_stream(handle).unwrap();
        assert_eq!(
            output_pointer(handle).unwrap(),
            PcmPosition {
                played_bytes: 0,
                completed_fragments: 0,
                ring_offset: 0,
            }
        );

        write(handle, &[2; 32], false).unwrap();
        publish_consumer(producer());
        assert_eq!(
            output_pointer(handle).unwrap(),
            PcmPosition {
                played_bytes: 32,
                completed_fragments: 2,
                ring_offset: 32,
            }
        );
    }

    #[test]
    fn delay_space_position_sync_and_reconfiguration_follow_the_audio_clock() {
        let (_guard, handle) = fresh();
        set_fragment(handle, (2 << 16) | 4).unwrap();
        write(handle, &[1; 32], false).unwrap();

        assert_eq!(output_delay(handle).unwrap(), 32);
        assert_eq!(
            output_space(handle).unwrap(),
            PcmOutputSpace {
                available_fragments: 0,
                total_fragments: 2,
                fragment_bytes: 16,
                available_bytes: 0,
            }
        );
        assert_eq!(set_rate(handle, 44_100), Err(Errno::EBUSY));
        assert_eq!(sync(handle), Err(Errno::EAGAIN));

        assert_eq!(drain_into(&mut [0; 16]), 16);
        assert_eq!(output_delay(handle).unwrap(), 16);
        assert_eq!(
            output_pointer(handle).unwrap(),
            PcmPosition {
                played_bytes: 16,
                completed_fragments: 1,
                ring_offset: 16,
            }
        );
        assert_eq!(output_pointer(handle).unwrap().completed_fragments, 0);

        assert_eq!(drain_into(&mut [0; 16]), 16);
        let before_stop = TRANSPORT.control.generation.load(Ordering::Acquire);
        assert_eq!(sync(handle), Ok(()));
        let stopped = TRANSPORT.control.generation.load(Ordering::Acquire);
        assert_eq!(stopped, before_stop.wrapping_add(1));
        assert_eq!(set_rate(handle, 44_100), Ok(44_100));
        assert_eq!(
            TRANSPORT.control.generation.load(Ordering::Acquire),
            stopped.wrapping_add(1)
        );
        assert_eq!(TRANSPORT.control.rate.load(Ordering::Acquire), 44_100);
        assert_eq!(
            TRANSPORT.control.flags.load(Ordering::Acquire) & pcm::PCM_FLAG_CONFIGURING,
            0
        );
    }

    #[test]
    fn shared_clock_underrun_consumes_available_frames_and_records_silence_gap() {
        let (_guard, handle) = fresh();
        write(handle, &[1; 4], false).unwrap();

        assert_eq!(clock_update(2), 1);
        assert_eq!(pending_bytes(), 0);
        assert_eq!(TRANSPORT.control.underruns.load(Ordering::Acquire), 1);
        assert_eq!(clock_update(2), 0);
        assert_eq!(TRANSPORT.control.underruns.load(Ordering::Acquire), 1);

        write(handle, &[2; 4], false).unwrap();
        assert_eq!(clock_update(2), 1);
        assert_eq!(TRANSPORT.control.underruns.load(Ordering::Acquire), 2);
    }

    #[test]
    fn draining_a_short_tail_is_not_an_underrun() {
        let (_guard, handle) = fresh();
        write(handle, &[1; 8], false).unwrap();
        assert_eq!(sync(handle), Err(Errno::EAGAIN));
        let before_stop = TRANSPORT.control.generation.load(Ordering::Acquire);

        assert_eq!(clock_update(128), 2);
        assert_eq!(TRANSPORT.control.underruns.load(Ordering::Acquire), 0);
        assert_eq!(
            TRANSPORT.control.flags.load(Ordering::Acquire) & pcm::PCM_FLAG_UNDERRUN_ACTIVE,
            0
        );
        assert_eq!(
            TRANSPORT.control.state.load(Ordering::Acquire),
            pcm::PCM_STATE_STOPPED
        );
        assert_eq!(
            TRANSPORT.control.generation.load(Ordering::Acquire),
            before_stop.wrapping_add(1)
        );
    }

    #[test]
    fn fatal_sink_error_fails_io_and_implicit_close_does_not_stall() {
        let (_guard, handle) = fresh();
        write(handle, &[1; 8], false).unwrap();
        TRANSPORT
            .control
            .flags
            .fetch_or(pcm::PCM_FLAG_FATAL_ERROR, Ordering::AcqRel);

        assert_eq!(write(handle, &[2; 4], false), Err(Errno::EIO));
        assert_eq!(poll_writable(handle), Err(Errno::EIO));
        assert_eq!(output_space(handle), Err(Errno::EIO));
        assert_eq!(sync(handle), Err(Errno::EIO));
        assert_eq!(preflight_close(handle), Err(Errno::EIO));

        let idx = stream_index(handle).unwrap();
        let freed = crate::descriptor_backing::with_pcm_streams(|table| table.release(idx));
        assert!(freed);
        on_last_ofd_released(idx);
        assert_eq!(ACTIVE_STREAM.load(Ordering::Acquire), -1);
        assert_eq!(pending_bytes(), 0);
    }

    #[test]
    fn fatal_sink_after_orphaning_tail_discards_without_counting_playback() {
        let (_guard, handle) = fresh();
        write(handle, &[1; 16], false).unwrap();
        // Model consumer progress that the host published immediately before
        // process teardown, but which no syscall has reconciled yet.
        publish_consumer(8);

        let idx = stream_index(handle).unwrap();
        let freed = crate::descriptor_backing::with_pcm_streams(|table| table.release(idx));
        assert!(freed);
        on_last_ofd_released(idx);
        assert_eq!(ACTIVE_STREAM.load(Ordering::Acquire), idx as i32);
        assert!(ORPHAN_DRAINING.load(Ordering::Acquire));
        assert_eq!(pending_bytes(), 8);
        assert_eq!(open_stream(), Err(Errno::EBUSY));

        mark_fatal_error_for_test();
        assert_eq!(reconcile(), 1);
        assert_eq!(ACTIVE_STREAM.load(Ordering::Acquire), -1);
        assert!(!ORPHAN_DRAINING.load(Ordering::Acquire));
        assert_eq!(pending_bytes(), 0);
        assert_eq!(discard(), producer());
        assert_eq!(unsafe { *PLAYED_BYTES.0.get() }, 8);

        // The physical failure remains sticky, but it must not retain the old
        // stream's exclusive-open claim.
        let reopened = open_stream().unwrap();
        assert!(has_fatal_error(reopened).unwrap());
        rollback_open(reopened);
    }

    #[test]
    fn drain_pads_partial_u8_stereo_frame_with_silence() {
        let (_guard, handle) = fresh();
        set_format(handle, pcm::PCM_FORMAT_U8).unwrap();
        set_channels(handle, 2).unwrap();
        write(handle, &[1, 2, 3], false).unwrap();
        assert_eq!(sync(handle), Err(Errno::EAGAIN));
        let mut out = [0; 4];
        assert_eq!(drain_into(&mut out), 4);
        assert_eq!(out, [1, 2, 3, 0x80]);
    }

    #[test]
    fn transport_claim_prevents_competing_consumers() {
        let (_guard, handle) = fresh();
        write(handle, &[0; 16], false).unwrap();
        claim_transport(pcm::PCM_TRANSPORT_SHARED_CLOCK).unwrap();
        assert_eq!(drain_into(&mut [0; 16]), 0);
        assert_eq!(clock_update(4), 4);
        assert_eq!(pending_bytes(), 0);
    }

    #[test]
    fn reset_close_reopen_keeps_live_cursors_monotonic() {
        let (_guard, first) = fresh();
        set_format(first, pcm::PCM_FORMAT_U8).unwrap();
        set_channels(first, 1).unwrap();
        write(first, &[1, 2, 3, 4], false).unwrap();

        let mut played = [0; 2];
        assert_eq!(drain_into(&mut played), 2);
        assert_eq!(played, [1, 2]);
        assert_eq!(output_pointer(first).unwrap().played_bytes, 2);

        // RESET permits the final close without waiting for the old tail. This
        // is the lifecycle in which an already-running AudioWorklet quantum
        // can otherwise publish an old absolute consumer after the reopen.
        reset_stream(first).unwrap();
        let base = producer();
        let old_consumer = consumer();
        assert_eq!(base, 4);
        assert_eq!(old_consumer, 2);
        assert_eq!(discard(), base);

        let first_idx = stream_index(first).unwrap();
        let freed = crate::descriptor_backing::with_pcm_streams(|table| table.release(first_idx));
        assert!(freed);
        on_last_ofd_released(first_idx);

        let second = open_stream().unwrap();
        assert_eq!(producer(), base, "producer must not rewind across opens");
        assert_eq!(
            consumer(),
            old_consumer,
            "kernel must not race the host consumer writer"
        );
        assert_eq!(
            discard(),
            base,
            "the new generation starts at the old producer"
        );
        assert_eq!(output_pointer(second).unwrap().played_bytes, 0);

        // Model a late publication from the old worklet generation. Because it
        // cannot exceed that generation's producer, the new discard floor wins
        // and no byte from the new stream is consumed or skipped.
        publish_consumer(base - 1);
        assert_eq!(pending_bytes(), 0);

        set_format(second, pcm::PCM_FORMAT_U8).unwrap();
        set_channels(second, 1).unwrap();
        assert_eq!(write(second, &[9, 10], false).unwrap(), 2);
        assert_eq!(producer(), base + 2);
        let mut next = [0; 2];
        assert_eq!(drain_into(&mut next), 2);
        assert_eq!(next, [9, 10]);
        assert_eq!(consumer(), base + 2);
        assert_eq!(output_pointer(second).unwrap().played_bytes, 2);
    }
}
