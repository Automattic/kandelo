//! Streamed exchange entries: FIFOs whose other end is the host.
//!
//! Both kinds are ordinary kernel FIFOs (`crate::fifo`): a tmpfs
//! `Special(S_IFIFO)` node, a path-keyed registry name and a
//! [`crate::pipe::PipeBuffer`] of 64 KiB. Guests use them with the usual
//! `open`/`read`/`write`/`poll` semantics; the host is the other endpoint.
//!
//! - **Inputs.** A host `ReadableStream` becomes a FIFO in its batch. The
//!   host holds a writer endpoint from the moment the batch appears, so a
//!   reader's open never blocks. The host writes only what fits
//!   ([`push_input`]), and learns of room as readers drain it (a
//!   stream-demand notification): that is the backpressure. Ending the host
//!   stream marks the FIFO finished, so readers see end-of-file after the
//!   buffered bytes; a host stream error makes them fail with EIO instead.
//!   The host keeps its writer endpoint until the source is released, so a
//!   reader that opens late still never blocks. When
//!   no name and no reader remain, the source is released and the host
//!   cancels its stream.
//! - **Outputs.** A FIFO published from a session. The host becomes a
//!   reader when it starts reading ([`start_output`]): until then a blocking
//!   writer's open waits and an `O_NONBLOCK` one fails with ENXIO, as for
//!   any FIFO without a reader. When the host's lease ends, its reader
//!   closes, so writers get EPIPE and SIGPIPE.
//!
//! The exchange holds a path reference on every stream's pipe (as an
//! `O_PATH` descriptor does), so the pipe's slot is never freed and reused
//! while it is tracked here.
//!
//! The pipe layer reports readiness changes through `crate::wakeup::push`.
//! While any stream exists, [`on_wake`] marks the stream's pipe dirty and
//! tells the host exchange notifications are waiting; [`collect`] turns dirty
//! pipes into notifications when the host drains them. With no streams the
//! hook is one relaxed atomic load.

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::vec::Vec;
use core::cell::UnsafeCell;
use core::hint::spin_loop;
use core::sync::atomic::{AtomicBool, Ordering};

use wasm_posix_shared::mode::S_IFIFO;
use wasm_posix_shared::Errno;

use super::batches::Notification;
use super::ids::ExchangeId;
use crate::pipe::{FifoOpenSide, PipeBuffer, DEFAULT_PIPE_CAPACITY};

/// Streamed outputs not yet finished and released (spec quota).
pub const MAX_UNFINISHED_OUTPUTS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stream {
    /// The host writes `source` into the FIFO while `host_writer` (until its
    /// stream ends). Its endpoint is held until the source is released.
    Input { source: u64, host_writer: bool },
    /// A published output; the host reads it once `host_reader`.
    Output { output: ExchangeId, host_reader: bool },
}

struct Locked<T> {
    locked: AtomicBool,
    value: UnsafeCell<T>,
}

// SAFETY: `locked` serializes every access; no reference escapes `with`.
unsafe impl<T> Sync for Locked<T> {}

impl<T> Locked<T> {
    const fn new(value: T) -> Self {
        Locked { locked: AtomicBool::new(false), value: UnsafeCell::new(value) }
    }

    fn with<R>(&self, f: impl FnOnce(&mut T) -> R) -> R {
        while self
            .locked
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            spin_loop();
        }
        struct Unlock<'a>(&'a AtomicBool);
        impl Drop for Unlock<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _unlock = Unlock(&self.locked);
        // SAFETY: see `Locked`.
        f(unsafe { &mut *self.value.get() })
    }
}

/// Streams by pipe index. Pipe operations run while this is held, and they
/// call [`on_wake`], so [`WATCH`] is a separate lock that is never held
/// across a pipe operation.
static STREAMS: Locked<BTreeMap<usize, Stream>> = Locked::new(BTreeMap::new());

struct Watch {
    watched: BTreeSet<u32>,
    dirty: BTreeSet<u32>,
}

static WATCH: Locked<Watch> = Locked::new(Watch { watched: BTreeSet::new(), dirty: BTreeSet::new() });

/// Whether any stream exists: the wakeup hook's fast path.
static ACTIVE: AtomicBool = AtomicBool::new(false);

fn pipes() -> &'static mut crate::pipe::PipeTable {
    // SAFETY: the kernel services one syscall at a time.
    unsafe { crate::pipe::global_pipe_table() }
}

fn watch(pipe_idx: usize) {
    WATCH.with(|watch| {
        watch.watched.insert(pipe_idx as u32);
        watch.dirty.insert(pipe_idx as u32);
    });
    ACTIVE.store(true, Ordering::Relaxed);
    crate::wakeup::push_exchange_pending();
}

fn unwatch(pipe_idx: usize) {
    let empty = WATCH.with(|watch| {
        watch.watched.remove(&(pipe_idx as u32));
        watch.dirty.remove(&(pipe_idx as u32));
        watch.watched.is_empty()
    });
    if empty {
        ACTIVE.store(false, Ordering::Relaxed);
    }
}

/// `crate::wakeup::push` saw a readiness change on pipe `idx`.
#[inline]
pub fn on_wake(idx: u32, wake_type: u8) {
    if !ACTIVE.load(Ordering::Relaxed) {
        return;
    }
    if wake_type != crate::wakeup::WAKE_READABLE && wake_type != crate::wakeup::WAKE_WRITABLE {
        return;
    }
    mark(idx);
}

/// A stream's pipe changed in a way the pipe layer does not report (its last
/// name went away).
pub fn touch(pipe_idx: usize) {
    if ACTIVE.load(Ordering::Relaxed) {
        mark(pipe_idx as u32);
    }
}

fn mark(idx: u32) {
    let marked = WATCH.with(|watch| watch.watched.contains(&idx) && watch.dirty.insert(idx));
    if marked {
        crate::wakeup::push_exchange_pending();
    }
}

/// Create the input FIFO at `path` for host stream `source`, owned by `uid`
/// and the exchange group, mode 0440. The host is its writer from now on.
pub fn create_input(path: &[u8], source: u64, uid: u32, gid: u32) -> Result<(), Errno> {
    crate::tmpfs::mknod_special(path, 0o440, uid, gid, S_IFIFO)?;
    let metadata = crate::tmpfs::lstat(path)?;
    let pipe_idx = pipes().alloc(PipeBuffer::new_fifo(DEFAULT_PIPE_CAPACITY, metadata));
    if !unsafe { crate::fifo::global_fifo_table() }.register(path.to_vec(), pipe_idx) {
        pipes().remove_fifo_name(pipe_idx);
        let _ = crate::tmpfs::unlink(path);
        return Err(Errno::EEXIST);
    }
    STREAMS.with(|streams| {
        if let Some(pipe) = pipes().get_mut(pipe_idx) {
            pipe.add_fifo_path_ref();
            pipe.add_fifo_endpoint_ref(FifoOpenSide::Writer);
            pipe.publish_fifo_open(FifoOpenSide::Writer);
        }
        streams.insert(pipe_idx, Stream::Input { source, host_writer: true });
    });
    // The host learns the FIFO's room at the next drain.
    watch(pipe_idx);
    Ok(())
}

fn input_pipe(streams: &BTreeMap<usize, Stream>, source: u64) -> Option<(usize, bool)> {
    streams.iter().find_map(|(&pipe_idx, stream)| match *stream {
        Stream::Input { source: s, host_writer } if s == source => Some((pipe_idx, host_writer)),
        _ => None,
    })
}

/// Write host bytes into input `source`'s FIFO: as many as fit, possibly 0.
/// ENOENT once the source is released; EPIPE after the host ended it.
pub fn push_input(source: u64, data: &[u8]) -> Result<usize, Errno> {
    STREAMS.with(|streams| {
        let (pipe_idx, host_writer) = input_pipe(streams, source).ok_or(Errno::ENOENT)?;
        if !host_writer {
            return Err(Errno::EPIPE);
        }
        let pipe = pipes().get_mut(pipe_idx).ok_or(Errno::ENOENT)?;
        Ok(pipe.write(data))
    })
}

/// The host stream for input `source` ended: cleanly (readers see
/// end-of-file after the buffered bytes) or with an error (they see EIO).
pub fn end_input(source: u64, failed: bool) -> Result<(), Errno> {
    let pipe_idx = STREAMS.with(|streams| {
        let (pipe_idx, host_writer) = input_pipe(streams, source).ok_or(Errno::ENOENT)?;
        if !host_writer {
            return Err(Errno::EPIPE);
        }
        if let Some(pipe) = pipes().get_mut(pipe_idx) {
            if failed {
                pipe.fail_reads_after_buffered(Errno::EIO);
            }
            // Keep the endpoint (a late reader's open must not block), but
            // let empty reads end.
            pipe.finish_writes();
        }
        streams.insert(pipe_idx, Stream::Input { source, host_writer: false });
        Ok(pipe_idx)
    })?;
    touch(pipe_idx);
    Ok(())
}

/// Track a published output FIFO.
pub fn register_output(pipe_idx: usize, output: ExchangeId) {
    STREAMS.with(|streams| {
        if let Some(pipe) = pipes().get_mut(pipe_idx) {
            pipe.add_fifo_path_ref();
        }
        streams.insert(pipe_idx, Stream::Output { output, host_reader: false });
    });
    watch(pipe_idx);
}

/// How many streamed outputs are published and not yet released.
pub fn unfinished_outputs() -> usize {
    STREAMS.with(|streams| streams.values().filter(|s| matches!(s, Stream::Output { .. })).count())
}

fn output_pipe(streams: &BTreeMap<usize, Stream>, output: &ExchangeId) -> Option<(usize, bool)> {
    streams.iter().find_map(|(&pipe_idx, stream)| match stream {
        Stream::Output { output: o, host_reader } if o == output => Some((pipe_idx, *host_reader)),
        _ => None,
    })
}

/// Whether `output` is a streamed output.
pub fn is_output(output: &ExchangeId) -> bool {
    STREAMS.with(|streams| output_pipe(streams, output).is_some())
}

/// The host starts reading a streamed output: it becomes the FIFO's reader,
/// and a writer waiting in `open` proceeds. EBUSY if it already started.
pub fn start_output(output: &ExchangeId) -> Result<(), Errno> {
    STREAMS.with(|streams| {
        let (pipe_idx, host_reader) = output_pipe(streams, output).ok_or(Errno::ENOENT)?;
        if host_reader {
            return Err(Errno::EBUSY);
        }
        let pipe = pipes().get_mut(pipe_idx).ok_or(Errno::ENOENT)?;
        pipe.add_fifo_endpoint_ref(FifoOpenSide::Reader);
        pipe.publish_fifo_open(FifoOpenSide::Reader);
        streams.insert(pipe_idx, Stream::Output { output: *output, host_reader: true });
        Ok(())
    })
}

/// What reading a streamed output found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputRead {
    Bytes(usize),
    /// Empty, and a writer may still write (or has not opened yet).
    Wait,
    /// Empty, and the writers have closed.
    End,
}

/// Read what a streamed output's writer has written.
pub fn read_output(output: &ExchangeId, out: &mut [u8]) -> Result<OutputRead, Errno> {
    STREAMS.with(|streams| {
        let (pipe_idx, host_reader) = output_pipe(streams, output).ok_or(Errno::ENOENT)?;
        if !host_reader {
            return Err(Errno::EINVAL);
        }
        let pipe = pipes().get_mut(pipe_idx).ok_or(Errno::ENOENT)?;
        let count = pipe.read(out);
        if count > 0 {
            return Ok(OutputRead::Bytes(count));
        }
        // The host's read-only endpoint makes the hang-up sticky once a writer
        // that opened has closed; before any writer opens there is no EOF.
        if !pipe.is_write_end_open() && pipe.read_end_has_hangup() {
            Ok(OutputRead::End)
        } else {
            Ok(OutputRead::Wait)
        }
    })
}

/// Stop tracking a streamed output (released by the host or withdrawn by the
/// guest), closing the host's reader: writers then get EPIPE and SIGPIPE.
/// Returns the FIFO's pipe index if it was a stream.
pub fn close_output(output: &ExchangeId) -> Option<usize> {
    let pipe_idx = STREAMS.with(|streams| {
        let (pipe_idx, host_reader) = output_pipe(streams, output)?;
        streams.remove(&pipe_idx);
        if let Some(pipe) = pipes().get_mut(pipe_idx) {
            if host_reader {
                pipe.close_fifo_read_only();
            } else {
                // A writer waiting in open for a reader that will never come
                // proceeds, and its writes fail with EPIPE.
                pipe.release_fifo_open_waiters(FifoOpenSide::Writer);
            }
            pipe.close_fifo_path_ref();
        }
        pipes().free_if_closed(pipe_idx);
        Some(pipe_idx)
    })?;
    unwatch(pipe_idx);
    Some(pipe_idx)
}

/// Turn every stream whose pipe changed into what the host must learn:
/// room in an input (stream demand), bytes or end-of-file in an output
/// (stream readable), and inputs no one can reach any more (released).
pub fn collect() -> Vec<Notification> {
    if !ACTIVE.load(Ordering::Relaxed) {
        return Vec::new();
    }
    let dirty: Vec<u32> = WATCH.with(|watch| core::mem::take(&mut watch.dirty).into_iter().collect());
    let mut notes = Vec::new();
    let mut released = Vec::new();
    STREAMS.with(|streams| {
        for idx in dirty {
            let pipe_idx = idx as usize;
            let Some(stream) = streams.get(&pipe_idx).copied() else {
                continue;
            };
            match stream {
                Stream::Input { source, host_writer } => {
                    // The exchange's path reference keeps the pipe allocated.
                    let Some(pipe) = pipes().get_mut(pipe_idx) else {
                        continue;
                    };
                    if pipe.fifo_name_count() == 0 && !pipe.has_readers() {
                        // Unreachable: no name to open and no reader left.
                        // The host's endpoint is held until now, ended or not.
                        pipe.close_write_end();
                        pipe.close_fifo_path_ref();
                        pipes().free_if_closed(pipe_idx);
                        streams.remove(&pipe_idx);
                        released.push(pipe_idx);
                        notes.push(Notification::SourceReleased { source });
                    } else if host_writer && pipe.free_space() > 0 {
                        let free = u32::try_from(pipe.free_space()).unwrap_or(u32::MAX);
                        notes.push(Notification::StreamDemand { source, free });
                    }
                }
                Stream::Output { output, host_reader } => {
                    let Some(pipe) = pipes().get(pipe_idx) else {
                        continue;
                    };
                    let ended = !pipe.is_write_end_open() && pipe.read_end_has_hangup();
                    if host_reader && (pipe.available() > 0 || ended) {
                        notes.push(Notification::StreamReadable { output });
                    }
                }
            }
        }
    });
    for pipe_idx in released {
        unwatch(pipe_idx);
    }
    notes
}

/// Forget every stream. Kernel teardown and tests.
pub fn reset() {
    STREAMS.with(|streams| streams.clear());
    WATCH.with(|watch| {
        watch.watched.clear();
        watch.dirty.clear();
    });
    ACTIVE.store(false, Ordering::Relaxed);
}
