extern crate alloc;

use alloc::vec::Vec;
use core::cell::UnsafeCell;
use wasm_posix_shared::WasmStat;

use wasm_posix_shared::Errno;

use crate::lock::{FileId, OfdId};
use crate::io_buffer::IoBuffer;
use crate::metadata_budget::{MetadataBudget, MetadataReservation};
use crate::ofd::{FileType, SharedOfdState};
use crate::prepared_map::{MapMemory, PreparedEntry, PreparedMap};

/// POSIX default pipe capacity.
pub const DEFAULT_PIPE_CAPACITY: usize = 65536;

/// POSIX atomicity guarantee threshold: writes of PIPE_BUF bytes or fewer
/// are guaranteed to be atomic.
pub const PIPE_BUF: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FifoOpenSide {
    Reader,
    Writer,
}

#[derive(Debug)]
pub struct FifoOpenWaiter {
    pub side: FifoOpenSide,
    pub path: Vec<u8>,
    pub status_flags: u32,
    pub fd_flags: u32,
    pub reserved_fd: i32,
    pub(crate) prepared_descriptor: Option<crate::process::PreparedDescriptor>,
    ready: bool,
    _path_reservation: MetadataReservation<'static>,
}

impl MapMemory for FifoOpenWaiter {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) }
}

pub(crate) struct PreparedFifoOpen(PreparedEntry<u64, FifoOpenWaiter>);

impl PreparedFifoOpen {
    pub(crate) fn bind_descriptor(&mut self, prepared: crate::process::PreparedDescriptor) {
        assert_eq!(prepared.fd(), self.0.value().reserved_fd);
        self.0.value_mut().prepared_descriptor = Some(prepared);
    }
}

/// The exact global-pipe reference owned by one pipe OFD.
///
/// Keep this explicit in SCM_RIGHTS messages: status flags alone cannot
/// distinguish an anonymous reader from a FIFO read-only cohort member, and
/// `O_PATH` owns a FIFO inode reference rather than an I/O endpoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InFlightPipeRefKind {
    Path,
    Read { fifo_read_only: bool },
    Write,
    ReadWrite,
}

/// An FD in transit via SCM_RIGHTS ancillary data.
///
/// Stores enough information to reconstruct the file descriptor
/// in the receiving process without needing access to the sender.
pub struct InFlightFd {
    pub ofd_id: OfdId,
    pub file_id: Option<FileId>,
    pub file_type: FileType,
    pub status_flags: u32,
    pub host_handle: i64,
    pub offset: i64,
    /// Exact shared OFD state retained while this descriptor is queued.
    /// Scalar fields above remain validated reconstruction metadata; current
    /// offset/status/owner values come from this handle at receive time.
    shared_state: SharedOfdState,
    pub path: crate::ofd::OfdPath,
    /// For kernel-backed pipe FDs: the exact reference transferred to the
    /// receiver. Non-pipe descriptors leave this as `None`.
    pub pipe_ref_kind: Option<InFlightPipeRefKind>,
    /// For DRM prime-bo FDs: the bo sidecar, without which the fd arrives as a
    /// plain CharDevice and the receiver's `PRIME_FD_TO_HANDLE` import fails.
    pub prime_bo: Option<crate::ofd::PrimeBoState>,
    /// True after this queued payload has acquired its one machine-wide
    /// backing and OfdId reference. Ownership transfers to the receiver or is
    /// released through the deferred queue on drop.
    owns_reference: bool,
}

pub type AncillaryFds = IoBuffer<InFlightFd>;

impl IoBuffer<InFlightFd> {
    pub fn try_clone_retained(&self) -> Result<Self, Errno> {
        let mut cloned = Self::try_with_capacity(self.len())?;
        for entry in self { cloned.push(entry.try_clone_retained()?); }
        Ok(cloned)
    }
}

pub trait IntoAncillaryFds {
    fn into_ancillary(self) -> Result<AncillaryFds, Errno>;
}

impl IntoAncillaryFds for AncillaryFds {
    fn into_ancillary(self) -> Result<AncillaryFds, Errno> { Ok(self) }
}

#[cfg(test)]
impl IntoAncillaryFds for Vec<InFlightFd> {
    fn into_ancillary(self) -> Result<AncillaryFds, Errno> { IoBuffer::try_adopt(self) }
}

impl InFlightFd {
    #[cfg(test)]
    pub fn new(
        ofd_id: OfdId,
        file_id: Option<FileId>,
        file_type: FileType,
        status_flags: u32,
        host_handle: i64,
        offset: i64,
        path: impl AsRef<[u8]>,
    ) -> Self {
        let shared_state = SharedOfdState::new(status_flags, offset, 0);
        Self::new_with_shared_state(
            ofd_id,
            file_id,
            file_type,
            status_flags,
            host_handle,
            offset,
            crate::ofd::OfdPath::copy_from(path.as_ref()).unwrap(),
            shared_state,
        )
    }

    pub fn new_with_shared_state(
        ofd_id: OfdId,
        file_id: Option<FileId>,
        file_type: FileType,
        status_flags: u32,
        host_handle: i64,
        offset: i64,
        path: crate::ofd::OfdPath,
        shared_state: SharedOfdState,
    ) -> Self {
        Self {
            ofd_id,
            file_id,
            file_type,
            status_flags,
            host_handle,
            offset,
            shared_state,
            path,
            pipe_ref_kind: None,
            prime_bo: None,
            owns_reference: false,
        }
    }

    fn release_metadata(&self) -> DeferredInFlightFdRelease {
        DeferredInFlightFdRelease {
            ofd_id: self.ofd_id,
            file_type: self.file_type,
            host_handle: self.host_handle,
            pipe_ref_kind: self.pipe_ref_kind,
            prime_bo_id: self.prime_bo.as_ref().map(|pb| pb.bo_id),
        }
    }

    /// Acquire the real resource and OfdId references represented by one
    /// queued SCM_RIGHTS entry.
    pub fn retain_reference(&mut self) -> Result<(), Errno> {
        if self.owns_reference {
            return Ok(());
        }
        // Keep the lowest ownership primitive closed too. Callers must not be
        // able to bypass sendmsg's complete-batch validation and retain a
        // description the receiver cannot reconstruct.
        crate::syscalls::validate_scm_rights_in_flight_fd(self)?;
        reserve_deferred_in_flight_release()?;
        if let Err(err) = crate::ofd::retain_in_flight_ofd(self.ofd_id) {
            cancel_deferred_in_flight_release();
            return Err(err);
        }
        if let Err(err) = retain_in_flight_resource(self.release_metadata()) {
            crate::ofd::release_in_flight_ofd(self.ofd_id);
            cancel_deferred_in_flight_release();
            return Err(err);
        }
        // SCM_RIGHTS lets the sender close its fd the instant sendmsg
        // returns, so the queued entry cannot borrow the sender's reference.
        // Take one of its own; `transfer_reference` hands it to the receiver
        // and `Drop` returns it through the deferred release queue.
        if let Some(pb) = self.prime_bo.as_ref() {
            crate::dri::with_registry(|r| r.incref(pb.bo_id));
        }
        self.owns_reference = true;
        Ok(())
    }

    /// Transfer the queued reference to a receiver-side OpenFileDesc without a
    /// decrement/re-increment window in the underlying resource ownership.
    pub fn transfer_reference(&mut self) {
        debug_assert!(self.owns_reference);
        if self.owns_reference {
            transfer_in_flight_resource(self.release_metadata());
            // The receiver increfs before this call, so dropping the queued
            // entry's reference here can never reach zero — no host is
            // needed to destroy backing.
            if let Some(pb) = self.prime_bo.as_ref() {
                crate::dri::with_registry(|r| r.decref(pb.bo_id));
            }
            self.owns_reference = false;
            crate::ofd::release_in_flight_ofd(self.ofd_id);
            cancel_deferred_in_flight_release();
        }
    }

    /// Clone one queued descriptor while acquiring an independent in-flight
    /// reference.
    ///
    /// `MSG_PEEK` installs a new descriptor for each successful peek while
    /// leaving the original message queued. Keep that allocation fallible so
    /// resource pressure returns an errno instead of panicking after the
    /// caller has observed a partial ancillary result.
    pub fn try_clone_retained(&self) -> Result<Self, Errno> {
        let path = self.path.clone();
        let mut cloned = Self {
            ofd_id: self.ofd_id,
            file_id: self.file_id,
            file_type: self.file_type,
            status_flags: self.status_flags,
            host_handle: self.host_handle,
            offset: self.offset,
            shared_state: self.shared_state.clone(),
            path,
            pipe_ref_kind: self.pipe_ref_kind,
            prime_bo: self.prime_bo.clone(),
            owns_reference: false,
        };
        if self.owns_reference {
            cloned.retain_reference()?;
        }
        Ok(cloned)
    }

    pub fn owns_reference(&self) -> bool {
        self.owns_reference
    }

    pub fn shared_state(&self) -> SharedOfdState {
        self.shared_state.clone()
    }
}

impl Drop for InFlightFd {
    fn drop(&mut self) {
        if !self.owns_reference {
            return;
        }
        self.owns_reference = false;
        crate::ofd::release_in_flight_ofd(self.ofd_id);
        enqueue_deferred_in_flight_release(self.release_metadata());
    }
}

/// Fixed cleanup metadata queued by `InFlightFd::drop`. Drop never re-enters
/// the pipe, PTY, or descriptor-backing globals because it may itself be
/// running while one of those tables is mutably borrowed.
#[derive(Clone, Copy)]
pub struct DeferredInFlightFdRelease {
    pub ofd_id: OfdId,
    file_type: FileType,
    host_handle: i64,
    pipe_ref_kind: Option<InFlightPipeRefKind>,
    /// Bo whose in-flight reference this release drops. Carried here because
    /// the queued entry owns a bo reference from `retain_reference` onward,
    /// so a message discarded before recvmsg must give it back.
    pub prime_bo_id: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReleasedInFlightFd {
    pub ofd_id: OfdId,
    pub final_ofd_reference: bool,
    pub host_close: Option<i64>,
    /// Bo reference the caller must drop, destroying host backing at zero.
    pub prime_bo_id: Option<u32>,
}

/// One SCM_RIGHTS batch attached to an exact byte range in a stream pipe.
///
/// Positions use the pipe's absolute byte sequence so ordinary reads stay
/// O(1) regardless of how many later descriptor messages are queued.
struct StreamAncillary {
    start: u64,
    end: u64,
    fds: AncillaryFds,
}

/// Result of one message-aware stream read.
pub struct PipeMessageRead {
    pub bytes_read: usize,
    pub hit_ancillary_barrier: bool,
    pub ancillary_fds: Option<AncillaryFds>,
}

/// Result of a stream read that cannot return ancillary data.
pub struct PipePlainRead {
    pub bytes_read: usize,
    pub hit_ancillary_barrier: bool,
}

struct DeferredInFlightReleaseQueue {
    records: IoBuffer<DeferredInFlightFdRelease>,
    /// Capacity promised to live `InFlightFd` values whose destructor may
    /// enqueue one record. Reserving before ownership is acquired keeps Drop
    /// allocation-free and prevents allocation failure during cleanup.
    reserved: usize,
}

struct DeferredInFlightReleases(UnsafeCell<Option<DeferredInFlightReleaseQueue>>);
unsafe impl Sync for DeferredInFlightReleases {}

static DEFERRED_IN_FLIGHT_RELEASES: DeferredInFlightReleases =
    DeferredInFlightReleases(UnsafeCell::new(None));

fn deferred_in_flight_releases() -> &'static mut DeferredInFlightReleaseQueue {
    let slot = unsafe { &mut *DEFERRED_IN_FLIGHT_RELEASES.0.get() };
    slot.get_or_insert_with(|| DeferredInFlightReleaseQueue {
        records: IoBuffer::new(),
        reserved: 0,
    })
}

fn reserve_deferred_in_flight_release() -> Result<(), Errno> {
    let queue = deferred_in_flight_releases();
    queue.reserve()
}

impl DeferredInFlightReleaseQueue {
    fn reserve(&mut self) -> Result<(), Errno> {
        let required = self.records.len().checked_add(self.reserved)
            .and_then(|count| count.checked_add(1)).ok_or(Errno::EOVERFLOW)?;
        if required > self.records.capacity() {
            let capacity = required.max(self.records.capacity().saturating_mul(2));
            self.records.reserve_with(capacity, |records| {
                records.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM)
            })?;
        }
        self.reserved += 1;
        Ok(())
    }

    fn reclaim_empty(&mut self) {
        if self.reserved == 0 && self.records.is_empty() {
            self.records = IoBuffer::new_in(self.records.budget());
        }
    }
}

fn cancel_deferred_in_flight_release() {
    let queue = deferred_in_flight_releases();
    debug_assert!(queue.reserved > 0);
    queue.reserved = queue.reserved.saturating_sub(1);
    queue.reclaim_empty();
}

fn enqueue_deferred_in_flight_release(release: DeferredInFlightFdRelease) {
    let queue = deferred_in_flight_releases();
    debug_assert!(queue.reserved > 0);
    debug_assert!(queue.records.len() < queue.records.capacity());
    queue.reserved = queue.reserved.saturating_sub(1);
    queue.records.push(release);
}

pub fn pop_deferred_in_flight_release() -> Option<DeferredInFlightFdRelease> {
    let queue = deferred_in_flight_releases();
    let release = queue.records.pop();
    queue.reclaim_empty();
    release
}

/// Return whether an ownership drop still needs its outer resource cleanup.
///
/// Direct host pipe exports use this after ending their pipe-table borrow, so
/// the ordinary host-TCP path pays only a queue-length check while any future
/// ancillary-capable caller cannot strand a deferred backing release.
pub fn has_deferred_in_flight_releases() -> bool {
    !deferred_in_flight_releases().records.is_empty()
}

#[cfg(test)]
pub fn deferred_in_flight_release_state() -> (usize, usize, usize) {
    let queue = deferred_in_flight_releases();
    (
        queue.records.len(),
        queue.reserved,
        queue.records.capacity(),
    )
}

fn retain_in_flight_resource(release: DeferredInFlightFdRelease) -> Result<(), Errno> {
    if crate::descriptor_backing::add_ref_for_ofd(release.file_type, release.host_handle)? {
        return Ok(());
    }

    match release.file_type {
        FileType::Regular | FileType::Directory | FileType::CharDevice
            if release.host_handle >= 0 =>
        {
            crate::ofd::host_handle_fork_ref(release.host_handle)?;
        }
        FileType::Pipe if release.host_handle >= 0 => {
            crate::ofd::host_handle_fork_ref(release.host_handle)?;
        }
        FileType::Pipe => {
            let pipe_idx = (-(release.host_handle + 1)) as usize;
            let pipe = unsafe { global_pipe_table() }
                .get_mut(pipe_idx)
                .ok_or(Errno::EBADF)?;
            let kind = release.pipe_ref_kind.ok_or(Errno::EINVAL)?;
            pipe.retain_in_flight_reference(kind);
        }
        FileType::PtyMaster | FileType::PtySlave => {
            let pty = crate::pty::get_pty(release.host_handle as usize).ok_or(Errno::EBADF)?;
            if release.file_type == FileType::PtyMaster {
                pty.master_refs = pty.master_refs.checked_add(1).ok_or(Errno::EOVERFLOW)?;
            } else {
                pty.slave_refs = pty.slave_refs.checked_add(1).ok_or(Errno::EOVERFLOW)?;
            }
        }
        FileType::Socket | FileType::Epoll => return Err(Errno::EOPNOTSUPP),
        _ => {}
    }
    Ok(())
}

/// Convert a queued resource reference into the receiver's installed OFD
/// reference without changing the underlying endpoint count.
fn transfer_in_flight_resource(release: DeferredInFlightFdRelease) {
    match release.file_type {
        FileType::Pipe if release.host_handle < 0 => {
            let pipe_idx = (-(release.host_handle + 1)) as usize;
            if let (Some(pipe), Some(kind)) = (
                unsafe { global_pipe_table() }.get_mut(pipe_idx),
                release.pipe_ref_kind,
            ) {
                pipe.adopt_in_flight_reference(kind);
            }
        }
        _ => {}
    }
}

/// Release one deferred queued reference after the table borrow that dropped
/// it has ended. Any nested ancillary payload discarded by closing a pipe is
/// queued for a later iteration by the caller.
pub fn release_deferred_in_flight_resource(
    release: DeferredInFlightFdRelease,
) -> ReleasedInFlightFd {
    let mut final_ofd_reference = false;
    let mut host_close = None;

    if crate::descriptor_backing::manages_ofd(release.file_type, release.host_handle) {
        final_ofd_reference =
            crate::descriptor_backing::release_for_ofd(release.file_type, release.host_handle);
    } else {
        match release.file_type {
            FileType::Regular | FileType::Directory | FileType::CharDevice
                if release.host_handle >= 0 =>
            {
                if crate::ofd::host_handle_close_ref(release.host_handle) {
                    final_ofd_reference = true;
                    host_close = Some(release.host_handle);
                }
            }
            FileType::Pipe if release.host_handle >= 0 => {
                if crate::ofd::host_handle_close_ref(release.host_handle) {
                    host_close = Some(release.host_handle);
                }
            }
            FileType::Pipe => {
                let pipe_idx = (-(release.host_handle + 1)) as usize;
                let pipes = unsafe { global_pipe_table() };
                if let Some(pipe) = pipes.get_mut(pipe_idx) {
                    if let Some(kind) = release.pipe_ref_kind {
                        pipe.release_in_flight_reference(kind);
                    }
                }
                pipes.free_if_closed(pipe_idx);
            }
            FileType::PtyMaster | FileType::PtySlave => {
                let pty_idx = release.host_handle as usize;
                if let Some(pty) = crate::pty::get_pty(pty_idx) {
                    if release.file_type == FileType::PtyMaster {
                        pty.master_refs = pty.master_refs.saturating_sub(1);
                        if pty.master_refs == 0 {
                            crate::epoll::notify(
                                crate::epoll::Source::Pty(pty.index, false),
                                wasm_posix_shared::epoll::EPOLLHUP,
                            );
                        }
                    } else {
                        pty.slave_refs = pty.slave_refs.saturating_sub(1);
                        if pty.slave_refs == 0 {
                            crate::epoll::notify(
                                crate::epoll::Source::Pty(pty.index, true),
                                wasm_posix_shared::epoll::EPOLLHUP,
                            );
                        }
                    }
                    if !pty.is_alive() {
                        crate::pty::free_pty(pty_idx);
                    }
                }
            }
            _ => {}
        }
    }

    ReleasedInFlightFd {
        ofd_id: release.ofd_id,
        final_ofd_reference,
        host_close,
        prime_bo_id: release.prime_bo_id,
    }
}

/// A ring buffer backing a pipe.
///
/// Uses a fixed-capacity `Vec<u8>` with head/tail pointers and a length
/// counter for O(1) read and write operations.
///
/// Endpoints are reference-counted: `read_count` and `write_count` track
/// how many open file descriptions reference each end. This supports
/// cross-process pipe sharing (e.g., after fork).
pub struct PipeBuffer {
    buf: Vec<u8>,
    capacity: usize,
    fifo_buffer_reservation: Option<MetadataReservation<'static>>,
    #[cfg(test)]
    fail_fifo_buffer_allocation: bool,
    head: usize,
    tail: usize,
    len: usize,
    /// Absolute sequence number of the byte at `head`.
    stream_position: u64,
    read_count: u32,
    write_count: u32,
    /// Endpoint references owned by descriptors queued in SCM_RIGHTS messages.
    /// These are included in read_count/write_count, but tracked separately so
    /// a carrier queue with no externally owned reader can be discarded.
    in_flight_read_count: u32,
    in_flight_write_count: u32,
    /// The receive half of a normally closed TCP endpoint remains as an
    /// orphaned discard sink until the peer closes its write half. This models
    /// TCP's simplex FIN without inventing a fixed number of successful writes
    /// after EOF.
    orphaned_read: bool,
    /// Sticky transport failure shared by inherited socket pipe endpoints.
    stream_error: u32,
    socket_read_shutdown: bool,
    socket_write_shutdown: bool,
    tcp_connection_id: u32,
    stream_error_pending: bool,
    /// Index of this pipe in the PipeTable (for wakeup events).
    pipe_idx: u32,
    /// True if this pipe backs a named FIFO (see `crate::fifo`). FIFO pipes
    /// persist across all fds closing (freed only on unlink), so
    /// `is_fully_closed` never frees them.
    is_fifo: bool,
    /// Installed read-only FIFO OFDs. O_RDWR descriptors deliberately do not
    /// count: they carry their own writer and cannot observe a read-side HUP.
    fifo_read_only_count: u32,
    /// POLLHUP is not reported to an initial non-blocking reader. It becomes
    /// sticky for the current reader cohort only after a successfully opened
    /// writer disappears, and clears when that cohort closes or a writer opens.
    fifo_writer_ever_opened: bool,
    fifo_read_hangup: bool,
    /// Number of filesystem names that still refer to this FIFO. The FIFO
    /// buffer persists while this is non-zero even when no endpoints are open.
    fifo_names: u32,
    /// Path-only FIFO OFDs retain the inode without becoming I/O endpoints.
    fifo_path_refs: u32,
    /// Last observed metadata for the FIFO marker inode. This remains available
    /// to fstat after the last name is unlinked.
    fifo_metadata: Option<WasmStat>,
    /// Blocking FIFO opens own a reserved endpoint until the opposite side
    /// arrives. Keys combine pid and guest thread id. Reserving the endpoint
    /// prevents the counterpart from returning into an apparent zero-reader
    /// or zero-writer pipe before this thread gets scheduled again.
    fifo_open_waiters: PreparedMap<u64, FifoOpenWaiter>,
    /// SCM_RIGHTS batches attached to exact stream byte ranges.
    ///
    /// WHY: a detached FIFO of descriptor batches can deliver rights while
    /// reading earlier plain bytes, or leave stale rights after `read(2)`
    /// consumes their carrier. The byte range makes each sendmsg an
    /// explicit receive barrier and keeps ordinary reads and peeks coherent.
    /// Absolute positions avoid walking every later record on each read.
    ancillary_fds: crate::io_buffer::IoDeque<StreamAncillary>,
}

impl PipeBuffer {
    /// A socket shutdown is a connection-half transition, independent of how
    /// many processes still retain references to that half after fork.
    pub fn shutdown_read(&mut self) {
        if !self.socket_read_shutdown {
            self.socket_read_shutdown = true;
            self.head = 0;
            self.tail = 0;
            self.len = 0;
            self.ancillary_fds.clear();
            crate::epoll::notify(
                crate::epoll::Source::Pipe(self.pipe_idx, crate::wakeup::WAKE_READABLE),
                0x2041,
            );
            crate::epoll::notify(
                crate::epoll::Source::Pipe(self.pipe_idx, crate::wakeup::WAKE_WRITABLE),
                0x18,
            );
            crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_READABLE);
            crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_WRITABLE);
        }
    }
    pub fn shutdown_write(&mut self) {
        if !self.socket_write_shutdown {
            self.socket_write_shutdown = true;
            crate::epoll::notify(
                crate::epoll::Source::Pipe(self.pipe_idx, crate::wakeup::WAKE_READABLE),
                0x2051,
            );
            crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_READABLE);
        }
    }
    pub fn read_shutdown(&self) -> bool {
        self.socket_read_shutdown
    }
    pub fn write_shutdown(&self) -> bool {
        self.socket_write_shutdown
    }

    /// Reset stream data without releasing endpoint references. Ordinary pipes
    /// never set this state; the host invokes it for an actual socket reset.
    pub fn reset_stream(&mut self, error: Errno) {
        if self.stream_error != 0 {
            return;
        }
        crate::epoll::notify(
            crate::epoll::Source::Pipe(self.pipe_idx, crate::wakeup::WAKE_READABLE),
            0x18,
        );
        crate::epoll::notify(
            crate::epoll::Source::Pipe(self.pipe_idx, crate::wakeup::WAKE_WRITABLE),
            0x18,
        );
        self.stream_error = error as u32;
        self.stream_error_pending = true;
        self.head = 0;
        self.tail = 0;
        self.len = 0;
        self.ancillary_fds.clear();
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_READABLE);
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_WRITABLE);
    }
    pub fn tcp_connection_id(&self) -> u32 {
        self.tcp_connection_id
    }
    pub fn stream_error(&self) -> Option<Errno> {
        Errno::from_u32(self.stream_error)
    }
    pub fn take_stream_error(&mut self) -> u32 {
        let error = if self.stream_error_pending {
            self.stream_error
        } else {
            0
        };
        self.stream_error_pending = false;
        error
    }

    /// Create a new pipe buffer with the given capacity.
    #[cfg(test)]
    pub fn new(capacity: usize) -> Self {
        Self::try_new(capacity).unwrap()
    }

    pub fn try_new(capacity: usize) -> Result<Self, Errno> {
        let mut pipe = Self::empty(capacity);
        pipe.prepare_buffer_with_budget(&crate::io_buffer::IO_MEMORY)?;
        Ok(pipe)
    }

    fn empty(capacity: usize) -> Self {
        PipeBuffer {
            buf: Vec::new(),
            capacity,
            fifo_buffer_reservation: None,
            #[cfg(test)]
            fail_fifo_buffer_allocation: false,
            head: 0,
            tail: 0,
            len: 0,
            stream_position: 0,
            read_count: 1,
            write_count: 1,
            in_flight_read_count: 0,
            in_flight_write_count: 0,
            orphaned_read: false,
            stream_error: 0,
            socket_read_shutdown: false,
            socket_write_shutdown: false,
            tcp_connection_id: 0,
            stream_error_pending: false,
            pipe_idx: 0,
            is_fifo: false,
            fifo_read_only_count: 0,
            fifo_writer_ever_opened: false,
            fifo_read_hangup: false,
            fifo_names: 0,
            fifo_path_refs: 0,
            fifo_metadata: None,
            fifo_open_waiters: PreparedMap::default(),
            ancillary_fds: crate::io_buffer::IoDeque::new(),
        }
    }

    /// Create a FIFO backing buffer with no endpoints open yet. Endpoints are
    /// attached as processes `open()` the FIFO by path (see `crate::fifo`).
    pub fn new_fifo(capacity: usize, metadata: WasmStat) -> Self {
        let mut pipe = Self::empty(capacity);
        pipe.read_count = 0;
        pipe.write_count = 0;
        pipe.is_fifo = true;
        pipe.fifo_names = 1;
        pipe.fifo_metadata = Some(metadata);
        pipe
    }

    pub(crate) fn prepare_fifo_io(&mut self) -> Result<(), Errno> {
        self.prepare_fifo_io_with_budget(&crate::io_buffer::IO_MEMORY)
    }

    fn prepare_fifo_io_with_budget(&mut self, budget: &'static MetadataBudget) -> Result<(), Errno> {
        if !self.is_fifo || self.fifo_buffer_reservation.is_some() { return Ok(()); }
        self.prepare_buffer_with_budget(budget)
    }

    fn prepare_buffer_with_budget(&mut self, budget: &'static MetadataBudget) -> Result<(), Errno> {
        let mut reservation = budget.reserve(self.capacity.checked_mul(2).ok_or(Errno::ENOMEM)?)?;
        #[cfg(test)]
        if core::mem::take(&mut self.fail_fifo_buffer_allocation) { return Err(Errno::ENOMEM); }
        let mut buffer = Vec::new();
        buffer.try_reserve_exact(self.capacity).map_err(|_| Errno::ENOMEM)?;
        buffer.resize(self.capacity, 0);
        reservation.resize(buffer.capacity().checked_mul(2).ok_or(Errno::ENOMEM)?)?;
        self.buf = buffer;
        self.fifo_buffer_reservation = Some(reservation);
        Ok(())
    }

    pub(crate) fn release_fifo_buffer_if_idle(&mut self) {
        if self.is_fifo && self.read_count == 0 && self.write_count == 0 {
            debug_assert_eq!(self.len, 0);
            self.buf = Vec::new();
            self.fifo_buffer_reservation = None;
        }
    }

    #[cfg(test)]
    pub(crate) fn fail_next_fifo_buffer_allocation(&mut self) {
        self.fail_fifo_buffer_allocation = true;
    }

    #[cfg(test)]
    pub(crate) fn resident_buffer_bytes(&self) -> usize { self.buf.capacity() }

    /// True if this pipe backs a named FIFO.
    pub fn is_fifo(&self) -> bool {
        self.is_fifo
    }

    /// True while at least one filesystem name can admit a future opener.
    pub fn has_fifo_names(&self) -> bool {
        self.fifo_names > 0
    }

    pub fn add_fifo_name(&mut self) {
        debug_assert!(self.is_fifo);
        self.fifo_names = self.fifo_names.saturating_add(1);
        if let Some(st) = self.fifo_metadata.as_mut() {
            st.st_nlink = st.st_nlink.saturating_add(1);
        }
    }

    pub fn remove_fifo_name(&mut self) {
        debug_assert!(self.is_fifo);
        self.fifo_names = self.fifo_names.saturating_sub(1);
        if let Some(st) = self.fifo_metadata.as_mut() {
            st.st_nlink = st.st_nlink.saturating_sub(1);
        }
    }

    pub fn remove_fifo_name_at(&mut self, ctime_sec: u64, ctime_nsec: u32) {
        self.remove_fifo_name();
        if let Some(st) = self.fifo_metadata.as_mut() {
            st.st_ctime_sec = ctime_sec;
            st.st_ctime_nsec = ctime_nsec;
        }
    }

    pub fn update_fifo_metadata(&mut self, metadata: WasmStat) {
        debug_assert!(self.is_fifo);
        self.fifo_metadata = Some(metadata);
    }

    pub fn fifo_metadata(&self) -> Option<WasmStat> {
        self.fifo_metadata
    }

    pub fn fifo_name_count(&self) -> u32 {
        self.fifo_names
    }

    pub fn add_fifo_path_ref(&mut self) {
        debug_assert!(self.is_fifo);
        self.fifo_path_refs = self.fifo_path_refs.saturating_add(1);
    }

    pub fn close_fifo_path_ref(&mut self) {
        debug_assert!(self.is_fifo);
        self.fifo_path_refs = self.fifo_path_refs.saturating_sub(1);
    }

    /// Resolve an OFD's immutable access mode into the global reference it
    /// owns. This is the single source of truth for fork, close, teardown,
    /// rollback, and SCM_RIGHTS serialization.
    pub fn reference_kind(&self, status_flags: u32) -> Option<InFlightPipeRefKind> {
        use wasm_posix_shared::flags::{O_ACCMODE, O_PATH, O_RDONLY, O_RDWR, O_WRONLY};

        if status_flags & O_PATH != 0 {
            return self.is_fifo.then_some(InFlightPipeRefKind::Path);
        }
        match status_flags & O_ACCMODE {
            O_RDONLY => Some(InFlightPipeRefKind::Read {
                fifo_read_only: self.is_fifo,
            }),
            O_WRONLY => Some(InFlightPipeRefKind::Write),
            O_RDWR => Some(InFlightPipeRefKind::ReadWrite),
            _ => None,
        }
    }

    /// Add one externally owned OFD reference.
    pub fn add_reference(&mut self, kind: InFlightPipeRefKind) {
        match kind {
            InFlightPipeRefKind::Path => self.add_fifo_path_ref(),
            InFlightPipeRefKind::Read { fifo_read_only } => {
                self.add_reader();
                if fifo_read_only {
                    debug_assert!(self.is_fifo);
                    self.inherit_fifo_read_only();
                }
            }
            InFlightPipeRefKind::Write => self.add_writer(),
            InFlightPipeRefKind::ReadWrite => {
                self.add_reader();
                self.add_writer();
            }
        }
    }

    /// Release one externally owned OFD reference.
    pub fn close_reference(&mut self, kind: InFlightPipeRefKind) {
        match kind {
            InFlightPipeRefKind::Path => self.close_fifo_path_ref(),
            InFlightPipeRefKind::Read {
                fifo_read_only: true,
            } => self.close_fifo_read_only(),
            InFlightPipeRefKind::Read {
                fifo_read_only: false,
            } => self.close_read_end(),
            InFlightPipeRefKind::Write => self.close_write_end(),
            InFlightPipeRefKind::ReadWrite => {
                self.close_read_end();
                self.close_write_end();
            }
        }
    }

    fn retain_in_flight_reference(&mut self, kind: InFlightPipeRefKind) {
        self.add_reference(kind);
        match kind {
            InFlightPipeRefKind::Path => {}
            InFlightPipeRefKind::Read { .. } => self.in_flight_read_count += 1,
            InFlightPipeRefKind::Write => self.in_flight_write_count += 1,
            InFlightPipeRefKind::ReadWrite => {
                self.in_flight_read_count += 1;
                self.in_flight_write_count += 1;
            }
        }
    }

    fn adopt_in_flight_reference(&mut self, kind: InFlightPipeRefKind) {
        match kind {
            InFlightPipeRefKind::Path => {}
            InFlightPipeRefKind::Read { .. } => self.adopt_in_flight_reader(),
            InFlightPipeRefKind::Write => self.adopt_in_flight_writer(),
            InFlightPipeRefKind::ReadWrite => {
                self.adopt_in_flight_reader();
                self.adopt_in_flight_writer();
            }
        }
    }

    fn release_in_flight_reference(&mut self, kind: InFlightPipeRefKind) {
        self.adopt_in_flight_reference(kind);
        self.close_reference(kind);
    }

    #[cfg(test)]
    pub fn reserve_fifo_open(
        &mut self,
        owner: u64,
        side: FifoOpenSide,
        path: &[u8],
        status_flags: u32,
        fd_flags: u32,
        reserved_fd: i32,
    ) -> Result<(), Errno> {
        self.reserve_fifo_open_with_budget(owner, side, path, status_flags, fd_flags, reserved_fd, &crate::io_buffer::IO_MEMORY)
    }

    #[cfg(test)]
    fn reserve_fifo_open_with_budget(
        &mut self, owner: u64, side: FifoOpenSide, path: &[u8], status_flags: u32,
        fd_flags: u32, reserved_fd: i32, budget: &'static MetadataBudget,
    ) -> Result<(), Errno> {
        let prepared = self.prepare_fifo_open_with_budget(owner, side, path, status_flags, fd_flags, reserved_fd, budget)?;
        self.publish_fifo_open_reservation(prepared);
        Ok(())
    }

    pub(crate) fn prepare_fifo_open(
        &mut self, owner: u64, side: FifoOpenSide, path: &[u8], status_flags: u32,
        fd_flags: u32, reserved_fd: i32,
    ) -> Result<PreparedFifoOpen, Errno> {
        self.prepare_fifo_open_with_budget(owner, side, path, status_flags, fd_flags, reserved_fd, &crate::io_buffer::IO_MEMORY)
    }

    fn prepare_fifo_open_with_budget(
        &mut self,
        owner: u64,
        side: FifoOpenSide,
        path: &[u8],
        status_flags: u32,
        fd_flags: u32,
        reserved_fd: i32,
        budget: &'static MetadataBudget,
    ) -> Result<PreparedFifoOpen, Errno> {
        debug_assert!(self.is_fifo);
        if self.fifo_open_waiters.contains_key(&owner) {
            return Err(Errno::EIO);
        }
        let node_reservation = PreparedEntry::<u64, FifoOpenWaiter>::reserve_in(budget, 0)?;
        let mut path_reservation = budget.reserve(path.len().checked_mul(2).ok_or(Errno::ENOMEM)?)?;
        let mut owned_path = Vec::new();
        owned_path.try_reserve_exact(path.len()).map_err(|_| Errno::ENOMEM)?;
        owned_path.extend_from_slice(path);
        path_reservation.resize(owned_path.capacity().checked_mul(2).ok_or(Errno::ENOMEM)?)?;
        let prepared = PreparedEntry::new_reserved_in(
            budget,
            owner,
            FifoOpenWaiter {
                side,
                path: owned_path,
                status_flags,
                fd_flags,
                reserved_fd,
                prepared_descriptor: None,
                ready: false,
                _path_reservation: path_reservation,
            },
            node_reservation,
        )?;
        Ok(PreparedFifoOpen(prepared))
    }

    pub(crate) fn publish_fifo_open_reservation(&mut self, prepared: PreparedFifoOpen) {
        let side = prepared.0.value().side;
        self.fifo_open_waiters.insert_prepared(prepared.0);
        self.add_fifo_endpoint_ref(side);
    }

    /// Add an endpoint ref before the caller's fd allocation. This ref makes
    /// the opposite side eligible to open, but does not latch any waiter ready
    /// until allocation succeeds and `publish_fifo_open` is called.
    pub fn add_fifo_endpoint_ref(&mut self, side: FifoOpenSide) {
        debug_assert!(self.is_fifo);
        match side {
            FifoOpenSide::Reader => self.add_reader(),
            FifoOpenSide::Writer => self.add_writer(),
        }
    }

    pub fn publish_fifo_open(&mut self, side: FifoOpenSide) {
        debug_assert!(self.is_fifo);
        match side {
            FifoOpenSide::Reader => {
                self.fifo_read_only_count = self.fifo_read_only_count.saturating_add(1);
                if self.write_count > 0 {
                    self.fifo_writer_ever_opened = true;
                    self.fifo_read_hangup = false;
                } else if self.fifo_writer_ever_opened {
                    // A writer may have completed and closed after making a
                    // blocked reader ready but before that reader resumed.
                    self.fifo_read_hangup = true;
                }
                self.fifo_open_waiters.for_each_mut(|waiter| {
                    if waiter.side == FifoOpenSide::Writer {
                        waiter.ready = true;
                    }
                });
            }
            FifoOpenSide::Writer => {
                self.fifo_writer_ever_opened = true;
                self.fifo_read_hangup = false;
                self.fifo_open_waiters.for_each_mut(|waiter| {
                    if waiter.side == FifoOpenSide::Reader {
                        waiter.ready = true;
                    }
                });
            }
        }
    }

    pub fn publish_fifo_read_write_open(&mut self) {
        debug_assert!(self.is_fifo);
        self.fifo_writer_ever_opened = true;
        self.fifo_read_hangup = false;
        self.fifo_open_waiters.for_each_mut(|waiter| {
            waiter.ready = true;
        });
    }

    pub fn inherit_fifo_read_only(&mut self) {
        debug_assert!(self.is_fifo);
        self.fifo_read_only_count = self.fifo_read_only_count.saturating_add(1);
    }

    pub fn close_fifo_read_only(&mut self) {
        debug_assert!(self.is_fifo);
        self.fifo_read_only_count = self.fifo_read_only_count.saturating_sub(1);
        self.close_read_end();
        if self.fifo_read_only_count == 0 && !self.has_ready_fifo_reader_waiter() {
            self.fifo_read_hangup = false;
            if self.write_count == 0 {
                self.fifo_writer_ever_opened = false;
            }
        }
    }

    pub fn take_ready_fifo_open(&mut self, owner: u64) -> Option<FifoOpenWaiter> {
        if !self
            .fifo_open_waiters
            .get(&owner)
            .is_some_and(|waiter| waiter.ready)
        {
            return None;
        }
        self.remove_fifo_open_waiter(owner)
    }

    pub fn has_fifo_open_waiter(&self, owner: u64) -> bool {
        self.fifo_open_waiters.contains_key(&owner)
    }

    pub fn cancel_fifo_open(&mut self, owner: u64) -> Option<FifoOpenWaiter> {
        let waiter = self.remove_fifo_open_waiter(owner)?;
        match waiter.side {
            FifoOpenSide::Reader => {
                self.close_read_end();
                if self.fifo_read_only_count == 0 && !self.has_ready_fifo_reader_waiter() {
                    self.fifo_read_hangup = false;
                    if self.write_count == 0 {
                        self.fifo_writer_ever_opened = false;
                    }
                }
            }
            FifoOpenSide::Writer => self.close_write_end(),
        }
        Some(waiter)
    }

    fn remove_fifo_open_waiter(&mut self, owner: u64) -> Option<FifoOpenWaiter> {
        let (mut waiter, node_reservation) = self.fifo_open_waiters.remove_entry(&owner)?.into_reserved_value();
        waiter._path_reservation.merge(node_reservation);
        Some(waiter)
    }

    pub fn cancel_fifo_opens_for_process(&mut self, pid: u32, mut cancelled: impl FnMut(FifoOpenWaiter)) {
        let mut owner = self.fifo_open_waiters.iter().find_map(|(owner, _)|
            ((*owner >> 32) as u32 == pid).then_some(*owner));
        while let Some(current) = owner {
            owner = self.fifo_open_waiters.next_after(&current)
                .and_then(|(next, _)| ((*next >> 32) as u32 == pid).then_some(*next));
            if let Some(waiter) = self.cancel_fifo_open(current) { cancelled(waiter); }
        }
    }

    /// Total capacity of the buffer.
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Number of bytes available for reading.
    pub fn available(&self) -> usize {
        self.len
    }

    /// Number of bytes of free space available for writing.
    pub fn free_space(&self) -> usize {
        self.capacity() - self.len
    }

    /// Returns true if the buffer contains no data.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Write data into the ring buffer, returning the number of bytes written.
    ///
    /// Performs a partial write if the buffer does not have enough free space
    /// for all of `data`. Returns 0 if the buffer is full.
    pub fn write(&mut self, data: &[u8]) -> usize {
        let previous_len = self.len;
        let bytes_written = self.write_without_wakeup(data);
        if self.len != previous_len {
            crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_READABLE);
        }
        bytes_written
    }

    /// Mutate buffered bytes without publishing a readable wakeup.
    ///
    /// SCM_RIGHTS uses this so the carrier bytes and their ownership record
    /// become visible as one transaction before a waiter may run.
    fn write_without_wakeup(&mut self, data: &[u8]) -> usize {
        if self.read_count == 0 {
            return if self.orphaned_read { data.len() } else { 0 };
        }
        let cap = self.capacity();
        let n = data.len().min(self.free_space());
        if n == 0 {
            return 0;
        }
        assert_eq!(self.buf.len(), cap, "FIFO I/O must be prepared before an endpoint is published");
        self.ensure_stream_sequence_room(n);
        let first = cap - self.tail;
        if n <= first {
            self.buf[self.tail..self.tail + n].copy_from_slice(&data[..n]);
        } else {
            self.buf[self.tail..self.tail + first].copy_from_slice(&data[..first]);
            self.buf[0..n - first].copy_from_slice(&data[first..n]);
        }
        self.tail = (self.tail + n) % cap;
        self.len += n;
        n
    }

    /// Write stream bytes and attach one retained SCM_RIGHTS batch to the
    /// exact successfully written range.
    ///
    /// Queue capacity is reserved before bytes become visible. This prevents
    /// a successful data write followed by a failed best-effort ancillary
    /// enqueue, which would silently separate the descriptors from their
    /// carrier bytes.
    pub fn write_with_ancillary(
        &mut self,
        data: &[u8],
        fds: impl IntoAncillaryFds,
    ) -> Result<usize, Errno> {
        let fds = fds.into_ancillary()?;
        if fds.is_empty() {
            return Ok(self.write(data));
        }
        if data.is_empty() {
            return Ok(0);
        }
        self.ancillary_fds
            .try_reserve(1)
            .map_err(|_| Errno::ENOMEM)?;
        let previous_len = self.len;
        let bytes_written = self.write_without_wakeup(data);
        if bytes_written == 0 {
            return Ok(0);
        }
        if self.len == previous_len {
            // An orphaned TCP read side is an explicit discard sink. Data may
            // report success there, but there is no readable carrier range to
            // which descriptors could safely remain attached.
            return Ok(bytes_written);
        }
        let start = self
            .stream_position
            .checked_add(previous_len as u64)
            .expect("stream sequence was rebased before write");
        let end = start
            .checked_add(bytes_written as u64)
            .expect("stream sequence was rebased before write");
        self.ancillary_fds
            .push_back(StreamAncillary { start, end, fds });
        // WHY: publish only after both the bytes and their descriptor ownership
        // are installed, so a callback or nested operation cannot observe one
        // half of the message.
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_READABLE);
        Ok(bytes_written)
    }

    /// Maximum bytes one receive may cross without passing a descriptor
    /// barrier.
    fn message_read_len(&self, requested: usize) -> usize {
        let mut bytes = requested.min(self.len);
        if let Some(ancillary) = self.ancillary_fds.front() {
            let requested_end = self
                .stream_position
                .checked_add(bytes as u64)
                .expect("live pipe range fits in stream sequence");
            if ancillary.start < requested_end {
                let barrier_len = ancillary
                    .end
                    .checked_sub(self.stream_position)
                    .expect("ancillary barrier cannot precede read head");
                bytes = bytes.min(barrier_len as usize);
            }
        }
        bytes
    }

    /// Whether the currently available prefix reaches the first descriptor
    /// barrier for a receive of at most `requested` bytes.
    pub fn ancillary_barrier_within(&self, requested: usize) -> bool {
        let bytes = requested.min(self.len);
        let read_end = self
            .stream_position
            .checked_add(bytes as u64)
            .expect("live pipe range fits in stream sequence");
        self.ancillary_fds
            .front()
            .is_some_and(|ancillary| ancillary.start < read_end)
    }

    /// Rebase the absolute stream sequence only at the practically unreachable
    /// u64 boundary. The ordinary hot path never walks queued records.
    fn ensure_stream_sequence_room(&mut self, additional: usize) {
        let buffered_and_new = self
            .len
            .checked_add(additional)
            .expect("pipe capacity bounds buffered stream bytes");
        if self
            .stream_position
            .checked_add(buffered_and_new as u64)
            .is_some()
        {
            return;
        }
        let old_position = self.stream_position;
        for ancillary in &mut self.ancillary_fds {
            ancillary.start -= old_position;
            ancillary.end -= old_position;
        }
        self.stream_position = 0;
    }

    fn copy_from_head(&self, buf: &mut [u8], bytes: usize) {
        if bytes == 0 {
            return;
        }
        let cap = self.capacity();
        let first = (cap - self.head).min(bytes);
        buf[..first].copy_from_slice(&self.buf[self.head..self.head + first]);
        if first < bytes {
            buf[first..bytes].copy_from_slice(&self.buf[..bytes - first]);
        }
    }

    fn consume_from_head(&mut self, bytes: usize) {
        if bytes == 0 {
            return;
        }
        self.ensure_stream_sequence_room(0);
        self.head = (self.head + bytes) % self.capacity();
        self.len -= bytes;
        self.stream_position = self
            .stream_position
            .checked_add(bytes as u64)
            .expect("stream sequence was rebased before consume");
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_WRITABLE);
    }

    /// Read one stream segment and return the first ancillary batch crossed.
    ///
    /// A non-peek receive moves the queued batch. A peek fallibly clones its
    /// retained references and leaves both bytes and the original batch in
    /// place, matching Linux's repeated-peek descriptor semantics.
    pub fn recv_message(
        &mut self,
        buf: &mut [u8],
        peek: bool,
    ) -> Result<PipeMessageRead, Errno> {
        let bytes_read = self.message_read_len(buf.len());
        let read_end = self
            .stream_position
            .checked_add(bytes_read as u64)
            .expect("live pipe range fits in stream sequence");
        let crosses_ancillary = self
            .ancillary_fds
            .front()
            .is_some_and(|ancillary| ancillary.start < read_end);
        let ancillary_fds = if !crosses_ancillary {
            None
        } else if peek {
            let original = &self
                .ancillary_fds
                .front()
                .expect("crossed ancillary record exists")
                .fds;
            Some(original.try_clone_retained()?)
        } else {
            Some(
                self.ancillary_fds
                    .pop_front()
                    .expect("crossed ancillary record exists")
                    .fds,
            )
        };

        self.copy_from_head(buf, bytes_read);
        if !peek {
            self.consume_from_head(bytes_read);
        }
        Ok(PipeMessageRead {
            bytes_read,
            hit_ancillary_barrier: crosses_ancillary,
            ancillary_fds,
        })
    }

    /// Read stream bytes for `read(2)`, `recv(2)`, or `recvfrom(2)`, none of
    /// which can return ancillary data. A consuming call discards a crossed
    /// descriptor batch; a peek leaves the batch queued.
    pub fn recv_plain(&mut self, buf: &mut [u8], peek: bool) -> PipePlainRead {
        let bytes_read = self.message_read_len(buf.len());
        let read_end = self
            .stream_position
            .checked_add(bytes_read as u64)
            .expect("live pipe range fits in stream sequence");
        let hit_ancillary_barrier = self
            .ancillary_fds
            .front()
            .is_some_and(|ancillary| ancillary.start < read_end);
        self.copy_from_head(buf, bytes_read);
        if !peek {
            if hit_ancillary_barrier {
                drop(self.ancillary_fds.pop_front());
            }
            self.consume_from_head(bytes_read);
        }
        PipePlainRead {
            bytes_read,
            hit_ancillary_barrier,
        }
    }

    /// Read data from the ring buffer without consuming it, returning the
    /// number of bytes read.
    ///
    /// This is equivalent to `read()` but the head pointer and length are
    /// not modified, so the same data can be read again.
    ///
    /// Returns 0 if the buffer is empty.
    pub fn peek(&self, buf: &mut [u8]) -> usize {
        let bytes_read = self.message_read_len(buf.len());
        self.copy_from_head(buf, bytes_read);
        bytes_read
    }

    /// Read data from the ring buffer into `buf`, returning the number of
    /// bytes read.
    ///
    /// Returns 0 if the buffer is empty.
    pub fn read(&mut self, buf: &mut [u8]) -> usize {
        self.recv_plain(buf, false).bytes_read
    }

    /// Close one read end of the pipe. Decrements the read reference count.
    pub fn close_read_end(&mut self) {
        if self.read_count == 1 {
            crate::epoll::notify(
                crate::epoll::Source::Pipe(self.pipe_idx, crate::wakeup::WAKE_WRITABLE),
                0x18,
            );
        }
        self.read_count = self.read_count.saturating_sub(1);
        if self.read_count == 0 {
            self.orphaned_read = false;
            self.head = 0;
            self.tail = 0;
            self.len = 0;
            // No process can receive these queued descriptors now. Dropping
            // them only enqueues fixed cleanup metadata; resource tables are
            // drained after this PipeBuffer borrow ends.
            self.discard_unreceivable_ancillary();
            if self.ancillary_fds.is_empty() {
                self.stream_position = 0;
            }
        }
        self.release_fifo_buffer_if_idle();
        // Read end closed → pipe became writable (writers get EPIPE/SIGPIPE)
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_WRITABLE);
    }

    /// Close one TCP read end with orderly-close semantics.
    ///
    /// The last real reader becomes an orphaned discard sink while a writer is
    /// still open. This is the pipe-backed equivalent of an operating system
    /// retaining a TCP control block after the application closes its socket.
    /// Explicit read shutdown uses `close_read_end` instead.
    pub fn close_read_end_orderly(&mut self) {
        self.read_count = self.read_count.saturating_sub(1);
        if self.read_count == 0 {
            self.head = 0;
            self.tail = 0;
            self.len = 0;
            self.orphaned_read = self.write_count > 0;
            self.discard_unreceivable_ancillary();
            if self.ancillary_fds.is_empty() {
                self.stream_position = 0;
            }
        }
        self.release_fifo_buffer_if_idle();
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_WRITABLE);
    }

    /// Close one write end of the pipe. Decrements the write reference count.
    pub fn close_write_end(&mut self) {
        if self.write_count == 1 {
            crate::epoll::notify(
                crate::epoll::Source::Pipe(self.pipe_idx, crate::wakeup::WAKE_READABLE),
                0x18,
            );
        }
        self.write_count = self.write_count.saturating_sub(1);
        if self.write_count == 0 {
            self.orphaned_read = false;
            if self.is_fifo && self.fifo_writer_ever_opened && self.fifo_read_only_count > 0 {
                self.fifo_read_hangup = true;
            } else if self.is_fifo && !self.has_ready_fifo_reader_waiter() {
                self.fifo_writer_ever_opened = false;
                self.fifo_read_hangup = false;
            }
        }
        self.release_fifo_buffer_if_idle();
        // Write end closed → pipe became readable (readers get EOF)
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_READABLE);
    }

    /// Add a reader reference (e.g., after fork or dup).
    pub fn add_reader(&mut self) {
        self.orphaned_read = false;
        self.read_count += 1;
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_WRITABLE);
    }

    /// Add a writer reference (e.g., after fork or dup).
    pub fn add_writer(&mut self) {
        self.write_count += 1;
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_READABLE);
    }

    fn adopt_in_flight_reader(&mut self) {
        debug_assert!(self.in_flight_read_count > 0);
        self.in_flight_read_count = self.in_flight_read_count.saturating_sub(1);
    }

    fn adopt_in_flight_writer(&mut self) {
        debug_assert!(self.in_flight_write_count > 0);
        self.in_flight_write_count = self.in_flight_write_count.saturating_sub(1);
    }

    fn has_external_reader(&self) -> bool {
        self.read_count > self.in_flight_read_count
    }

    fn discard_unreceivable_ancillary(&mut self) {
        #[cfg(test)]
        if self
            .ancillary_fds
            .iter()
            .flat_map(|record| &record.fds)
            .any(|fd| !fd.owns_reference)
        {
            // Local PipeTable unit fixtures exercise the lower-level reference
            // counters without the machine-wide RAII owner. Their containing
            // table releases the fixture records when the carrier is freed.
            return;
        }
        self.ancillary_fds.clear();
    }

    /// Returns true if the read end is still open (any readers remain).
    pub fn is_read_end_open(&self) -> bool {
        !self.socket_read_shutdown && (self.read_count > 0 || self.orphaned_read)
    }

    /// Returns true if an application-owned reader remains.
    ///
    /// Unlike `is_read_end_open`, this excludes TCP's orphaned discard sink so
    /// host bridges can distinguish SHUT_WR from a final close.
    pub fn has_readers(&self) -> bool {
        self.read_count > 0
    }

    /// Returns true if the write end is still open (any writers remain).
    pub fn is_write_end_open(&self) -> bool {
        !self.socket_write_shutdown && self.write_count > 0
    }

    /// Whether an empty read must return EOF. Blocking FIFO readers reserve an
    /// endpoint while opening, so an installed read-only fd with no writers is
    /// necessarily either non-blocking or observed after the last writer
    /// closed. Both cases return EOF.
    pub fn read_end_has_eof(&self) -> bool {
        !self.is_write_end_open()
    }

    pub fn read_end_has_hangup(&self) -> bool {
        if self.is_fifo {
            self.fifo_read_hangup
        } else {
            !self.is_write_end_open()
        }
    }

    fn has_ready_fifo_reader_waiter(&self) -> bool {
        self.fifo_open_waiters
            .values()
            .any(|waiter| waiter.side == FifoOpenSide::Reader && waiter.ready)
    }

    /// Returns true if both endpoints are closed and the pipe can be freed.
    ///
    /// FIFO-backing pipes are exempt: a FIFO persists in the filesystem
    /// namespace until unlinked, even when no fds are currently open, so a
    /// later `open()` reconnects to the same buffer. FIFO pipes become
    /// reclaimable after their last name and endpoint are removed.
    pub fn is_fully_closed(&self) -> bool {
        self.read_count == 0
            && self.write_count == 0
            && !self.orphaned_read
            && (!self.is_fifo || (self.fifo_names == 0 && self.fifo_path_refs == 0))
    }

    /// Returns true if there are ancillary FDs pending delivery.
    pub fn has_ancillary(&self) -> bool {
        !self.ancillary_fds.is_empty()
    }
}

/// Table of pipe buffers shared across all processes.
pub struct PipeTable {
    pipes: IoBuffer<Option<PipeBuffer>>,
    first_free: usize,
}

impl PipeTable {
    pub const fn new() -> Self {
        PipeTable {
            pipes: IoBuffer::new(),
            first_free: 0,
        }
    }

    /// Allocate a pipe buffer in the table. Returns the index.
    pub(crate) fn prepare_slot(&mut self) -> Result<usize, Errno> {
        if let Some(offset) = self.pipes[self.first_free..].iter().position(Option::is_none) {
            return Ok(self.first_free + offset);
        }
        let index = self.pipes.len();
        self.prepare_length(index.checked_add(1).ok_or(Errno::ENOMEM)?)?;
        Ok(index)
    }

    pub(crate) fn prepare_slots(&mut self, count: usize) -> Result<IoBuffer<usize>, Errno> {
        let mut indices = IoBuffer::new_in(self.pipes.budget());
        indices.reserve_with(count, |values| {
            values.try_reserve_exact(count).map_err(|_| Errno::ENOMEM)
        })?;
        for index in self.first_free..self.pipes.len() {
            if indices.len() == count { break; }
            if self.pipes[index].is_none() { indices.push(index); }
        }
        let appended = count - indices.len();
        self.prepare_length(self.pipes.len().checked_add(appended).ok_or(Errno::ENOMEM)?)?;
        for index in self.pipes.len()..self.pipes.len() + appended { indices.push(index); }
        Ok(indices)
    }

    fn prepare_length(&mut self, length: usize) -> Result<(), Errno> {
        if length > u32::MAX as usize { return Err(Errno::ENOMEM); }
        if length > self.pipes.capacity() {
            let capacity = length.max(self.pipes.capacity().saturating_mul(2)).max(4);
            self.pipes.reserve_with(capacity, |slots| {
                slots.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM)
            })?;
        }
        Ok(())
    }

    pub(crate) fn publish_prepared(&mut self, index: usize, mut pipe: PipeBuffer) {
        pipe.pipe_idx = u32::try_from(index).expect("prepared pipe index overflow");
        if index == self.pipes.len() {
            self.pipes.push(Some(pipe));
        } else {
            assert!(self.pipes[index].is_none(), "prepared pipe slot is occupied");
            self.pipes[index] = Some(pipe);
        }
        if self.first_free == index { self.first_free = index + 1; }
    }

    pub fn try_alloc(&mut self, pipe: PipeBuffer) -> Result<usize, Errno> {
        let index = self.prepare_slot()?;
        self.publish_prepared(index, pipe);
        Ok(index)
    }

    #[cfg(test)]
    pub fn alloc(&mut self, pipe: PipeBuffer) -> usize {
        self.try_alloc(pipe).unwrap()
    }

    /// Mint an identity that survives closing either endpoint but never
    /// follows a freed index into an unrelated pipe allocation.
    pub fn alloc_tcp_pair(&mut self, capacity: usize) -> Result<(usize, usize), Errno> {
        let token = crate::socket::allocate_host_net_handle()? as u32;
        let mut recv = PipeBuffer::try_new(capacity)?;
        let mut send = PipeBuffer::try_new(capacity)?;
        recv.tcp_connection_id = token;
        send.tcp_connection_id = token;
        self.try_alloc_pair(recv, send)
    }
    pub fn reset_tcp_connection(
        &mut self,
        recv: usize,
        send: usize,
        token: u32,
    ) -> Result<(), Errno> {
        if recv.checked_add(1) != Some(send) || token == 0 {
            return Err(Errno::EINVAL);
        }
        let mut found = false;
        for index in [recv, send] {
            if let Some(pipe) = self.get_mut(index) {
                if pipe.tcp_connection_id == token {
                    pipe.reset_stream(Errno::ECONNRESET);
                    found = true;
                }
            }
        }
        if found { Ok(()) } else { Err(Errno::ENOTCONN) }
    }

    /// Allocate two pipe buffers with adjacent indices (`second_idx == first_idx + 1`).
    /// The host TCP-bridge code assumes the recv and send pipes for an injected
    /// connection are consecutive (`sendPipeIdx = recvPipeIdx + 1`); this helper
    /// preserves that invariant when reusable slots are fragmented.
    pub fn try_alloc_pair(&mut self, first: PipeBuffer, second: PipeBuffer) -> Result<(usize, usize), Errno> {
        if let Some(offset) = self.pipes[self.first_free..].windows(2)
            .position(|slots| slots[0].is_none() && slots[1].is_none())
        {
            let first_index = self.first_free + offset;
            let second_index = first_index + 1;
            let mut first = first;
            first.pipe_idx = first_index as u32;
            self.pipes[first_index] = Some(first);
            let mut second = second;
            second.pipe_idx = second_index as u32;
            self.pipes[second_index] = Some(second);
            if self.first_free == first_index { self.first_free = second_index + 1; }
            return Ok((first_index, second_index));
        }
        let a = self.pipes.len();
        self.prepare_length(a.checked_add(2).ok_or(Errno::ENOMEM)?)?;
        let b = a + 1;
        let mut p1 = first;
        p1.pipe_idx = a as u32;
        self.pipes.push(Some(p1));
        let mut p2 = second;
        p2.pipe_idx = b as u32;
        self.pipes.push(Some(p2));
        if self.first_free == a { self.first_free = b + 1; }
        Ok((a, b))
    }

    #[cfg(test)]
    pub fn alloc_pair(&mut self, first: PipeBuffer, second: PipeBuffer) -> (usize, usize) {
        self.try_alloc_pair(first, second).unwrap()
    }

    /// Get a reference to a pipe buffer by index.
    pub fn get(&self, idx: usize) -> Option<&PipeBuffer> {
        self.pipes.get(idx).and_then(|p| p.as_ref())
    }

    /// Get a mutable reference to a pipe buffer by index.
    pub fn get_mut(&mut self, idx: usize) -> Option<&mut PipeBuffer> {
        self.pipes.get_mut(idx).and_then(|p| p.as_mut())
    }

    /// Atomically publish stream data and its already-retained SCM_RIGHTS
    /// descriptors, then discard any carrier queue that has no external
    /// receiver.
    pub fn write_retained_ancillary(
        &mut self,
        carrier_idx: usize,
        data: &[u8],
        fds: impl IntoAncillaryFds,
    ) -> Result<usize, Errno> {
        let fds = fds.into_ancillary()?;
        debug_assert!(fds.iter().all(|fd| fd.owns_reference));
        let bytes_written = self
            .get_mut(carrier_idx)
            .ok_or(Errno::EBADF)?
            .write_with_ancillary(data, fds)?;
        self.collect_unreachable_ancillary();
        Ok(bytes_written)
    }

    /// Lower-level resource accounting used by the local PipeTable tests.
    #[cfg(test)]
    pub fn queue_ancillary(&mut self, carrier_idx: usize, fds: Vec<InFlightFd>) -> bool {
        let Ok(fds) = fds.into_ancillary() else { return false; };
        let Some(carrier) = self.get_mut(carrier_idx) else { return false; };
        if carrier.ancillary_fds.try_reserve(1).is_err() { return false; }
        if self.get(carrier_idx).is_none() || !self.retain_ancillary_resources(&fds) {
            return false;
        }
        let result = self
            .get_mut(carrier_idx)
            .unwrap()
            .write_with_ancillary(b"x", fds);
        if result != Ok(1) {
            return false;
        }
        self.collect_unreachable_ancillary();
        true
    }

    /// Retain every pipe-backed resource carried by one SCM_RIGHTS message.
    ///
    /// A successful send owns these references while the descriptors are in
    /// transit. Receiving a descriptor transfers the matching reference to
    /// the new OFD; discarding the message releases it instead.
    #[cfg(test)]
    pub fn retain_ancillary_resources(&mut self, fds: &[InFlightFd]) -> bool {
        for (retained, fd) in fds.iter().enumerate() {
            if !self.retain_ancillary_resource(fd) {
                for retained_fd in &fds[..retained] {
                    self.release_ancillary_resource_inner(retained_fd);
                }
                self.collect_unreachable_ancillary();
                return false;
            }
        }
        true
    }

    /// Release pipe-backed resources for SCM_RIGHTS descriptors that were not
    /// installed in a receiving process.
    #[cfg(test)]
    pub fn release_ancillary_resources(&mut self, fds: &[InFlightFd]) {
        for fd in fds {
            self.release_ancillary_resource_inner(fd);
        }
        self.collect_unreachable_ancillary();
    }

    /// Transfer one retained SCM_RIGHTS reference into a newly installed OFD.
    /// Call finish_ancillary_transition after every entry in the popped batch
    /// has either been adopted or released.
    #[cfg(test)]
    pub fn adopt_ancillary_resource(&mut self, fd: &InFlightFd) {
        self.adopt_ancillary_resource_inner(fd);
    }

    /// Release one entry from a popped SCM_RIGHTS batch that could not be
    /// installed. Collection is deferred until the entire batch is resolved.
    #[cfg(test)]
    pub fn release_ancillary_resource(&mut self, fd: &InFlightFd) {
        self.release_ancillary_resource_inner(fd);
    }

    /// Complete a popped SCM_RIGHTS batch after every reference was adopted or
    /// released, then discard carrier queues that no external reader can reach.
    pub fn finish_ancillary_transition(&mut self) {
        self.collect_unreachable_ancillary();
    }

    #[cfg(test)]
    fn retain_ancillary_resource(&mut self, fd: &InFlightFd) -> bool {
        if fd.file_type == FileType::Pipe && fd.host_handle < 0 {
            let pipe_idx = (-(fd.host_handle + 1)) as usize;
            let Some(pipe) = self.get_mut(pipe_idx) else {
                return false;
            };
            let Some(kind) = fd.pipe_ref_kind else {
                return false;
            };
            pipe.retain_in_flight_reference(kind);
        }
        true
    }

    #[cfg(test)]
    fn adopt_ancillary_resource_inner(&mut self, fd: &InFlightFd) {
        if fd.file_type == FileType::Pipe && fd.host_handle < 0 {
            let pipe_idx = (-(fd.host_handle + 1)) as usize;
            if let Some(pipe) = self.get_mut(pipe_idx) {
                if let Some(kind) = fd.pipe_ref_kind {
                    pipe.adopt_in_flight_reference(kind);
                }
            }
        }
    }

    #[cfg(test)]
    fn release_ancillary_resource_inner(&mut self, fd: &InFlightFd) {
        if fd.file_type == FileType::Pipe && fd.host_handle < 0 {
            let pipe_idx = (-(fd.host_handle + 1)) as usize;
            if let Some(pipe) = self.get_mut(pipe_idx) {
                if let Some(kind) = fd.pipe_ref_kind {
                    pipe.release_in_flight_reference(kind);
                }
            }
            self.free_fully_closed_inner(pipe_idx);
        }
    }

    /// Free a pipe buffer slot if both endpoints are closed.
    pub fn free_if_closed(&mut self, idx: usize) {
        self.free_fully_closed_inner(idx);
        self.collect_unreachable_ancillary();
    }

    fn free_fully_closed_inner(&mut self, idx: usize) {
        let should_free = self
            .pipes
            .get(idx)
            .and_then(Option::as_ref)
            .is_some_and(PipeBuffer::is_fully_closed);
        if !should_free {
            return;
        }

        let pipe = self.pipes[idx].take().unwrap();
        self.first_free = self.first_free.min(idx);
        for record in pipe.ancillary_fds {
            #[cfg(test)]
            for fd in &record.fds {
                if !fd.owns_reference {
                    self.release_ancillary_resource_inner(fd);
                }
            }
            drop(record);
        }
    }

    /// Drop ancillary queues whose carrier has no externally owned reader.
    ///
    /// Socket descriptors are rejected before retain, so queued rights no
    /// longer form graph edges between carrier pipes. A direct sweep is both
    /// sufficient and less likely to imply that lossy socket snapshots exist.
    fn collect_unreachable_ancillary(&mut self) {
        for index in 0..self.pipes.len() {
            loop {
                let batch = self.get_mut(index)
                    .filter(|pipe| !pipe.has_external_reader())
                    .and_then(|pipe| pipe.ancillary_fds.pop_front());
                let Some(batch) = batch else { break };
                #[cfg(test)]
                for fd in &batch.fds {
                    if !fd.owns_reference {
                        self.release_ancillary_resource_inner(fd);
                    }
                }
                drop(batch);
            }
        }
    }

    /// Release both endpoints of a newly allocated buffer that was never
    /// published to a socket or host bridge, then make its slot reusable.
    pub fn discard_unclaimed(&mut self, idx: usize) {
        let Some(pipe) = self.get(idx) else { return; };
        assert!(!pipe.is_fifo && pipe.read_count == 1 && pipe.write_count == 1
            && pipe.ancillary_fds.is_empty(), "unclaimed pipe has external owners");
        self.pipes[idx] = None;
        self.first_free = self.first_free.min(idx);
    }

    /// Drop one filesystem name from a FIFO. The slot remains live while an
    /// alias or open endpoint exists, and becomes reusable only after both are
    /// gone.
    pub fn remove_fifo_name(&mut self, idx: usize) {
        if let Some(pipe) = self.get_mut(idx) {
            pipe.remove_fifo_name();
        }
        self.free_if_closed(idx);
    }

    pub fn remove_fifo_name_at(&mut self, idx: usize, ctime_sec: u64, ctime_nsec: u32) {
        if let Some(pipe) = self.get_mut(idx) {
            pipe.remove_fifo_name_at(ctime_sec, ctime_nsec);
        }
        self.free_if_closed(idx);
    }

    pub fn find_fifo_open(&self, owner: u64) -> Option<usize> {
        self.pipes.iter().enumerate().find_map(|(idx, pipe)| {
            pipe.as_ref()
                .is_some_and(|pipe| pipe.is_fifo() && pipe.has_fifo_open_waiter(owner))
                .then_some(idx)
        })
    }

    pub fn take_ready_fifo_open(&mut self, owner: u64) -> Option<(usize, FifoOpenWaiter)> {
        let idx = self.find_fifo_open(owner)?;
        let waiter = self.get_mut(idx)?.take_ready_fifo_open(owner)?;
        Some((idx, waiter))
    }

    pub fn cancel_fifo_open(&mut self, owner: u64) -> Option<FifoOpenWaiter> {
        let idx = self.find_fifo_open(owner)?;
        let cancelled = self.get_mut(idx)?.cancel_fifo_open(owner);
        if cancelled.is_some() {
            self.free_if_closed(idx);
        }
        cancelled
    }

    pub fn cancel_fifo_opens_for_process(&mut self, pid: u32, mut cancelled: impl FnMut(FifoOpenWaiter)) {
        for idx in 0..self.pipes.len() {
            if let Some(pipe) = self.get_mut(idx) {
                if pipe.is_fifo() {
                    pipe.cancel_fifo_opens_for_process(pid, &mut cancelled);
                }
            }
            self.free_if_closed(idx);
        }
    }

    /// Total number of slots (including freed).
    pub fn len(&self) -> usize {
        self.pipes.len()
    }

    /// Number of active (non-None) pipe buffers.
    #[cfg(test)]
    pub fn count_active(&self) -> usize {
        self.pipes.iter().filter(|p| p.is_some()).count()
    }
}

/// Global pipe table wrapper for static storage.
pub struct GlobalPipeTable(pub UnsafeCell<PipeTable>);

/// SAFETY: Access is serialized — the kernel services one syscall at a time
/// from the JS event loop (no concurrent Wasm execution).
unsafe impl Sync for GlobalPipeTable {}

/// Global pipe table shared across all processes.
pub static PIPE_TABLE: GlobalPipeTable = GlobalPipeTable(UnsafeCell::new(PipeTable::new()));

/// Get a mutable reference to the global pipe table.
///
/// # Safety
/// Only safe when access is serialized (single-threaded kernel).
pub unsafe fn global_pipe_table() -> &'static mut PipeTable {
    unsafe { &mut *PIPE_TABLE.0.get() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_payload_admission_precedes_allocation_and_follows_the_last_endpoint() {
        static BUDGET: MetadataBudget = MetadataBudget::new(128);
        let mut pipe = PipeBuffer::empty(64);
        BUDGET.set_limit(127).unwrap();
        assert_eq!(pipe.prepare_buffer_with_budget(&BUDGET), Err(Errno::ENOMEM));
        assert_eq!(pipe.buf.capacity(), 0);
        assert_eq!(BUDGET.usage().0, 0);
        BUDGET.set_limit(128).unwrap();
        pipe.fail_next_fifo_buffer_allocation();
        assert_eq!(pipe.prepare_buffer_with_budget(&BUDGET), Err(Errno::ENOMEM));
        assert_eq!(BUDGET.usage().0, 0);
        pipe.prepare_buffer_with_budget(&BUDGET).unwrap();
        let mut table = PipeTable::new();
        let index = table.try_alloc(pipe).unwrap();
        assert_eq!(BUDGET.usage().0, 128);
        table.get_mut(index).unwrap().close_read_end();
        table.free_if_closed(index);
        assert_eq!(BUDGET.usage().0, 128);
        table.get_mut(index).unwrap().close_write_end();
        table.free_if_closed(index);
        assert_eq!(BUDGET.usage().0, 0);
    }

    #[test]
    fn pipe_arena_pair_refusal_preserves_live_slots_and_reuses_admitted_holes() {
        static BUDGET: MetadataBudget = MetadataBudget::new(64 * 1024);
        let mut table = PipeTable { pipes: IoBuffer::new_in(&BUDGET), first_free: 0 };
        BUDGET.set_limit(0).unwrap();
        assert_eq!(table.prepare_slot(), Err(Errno::ENOMEM));
        assert_eq!(table.pipes.len(), 0);
        BUDGET.set_limit(64 * 1024).unwrap();
        for _ in 0..4 { table.try_alloc(PipeBuffer::try_new(0).unwrap()).unwrap(); }
        let retained = BUDGET.usage().0;
        assert_eq!(retained, 2 * table.pipes.capacity() * core::mem::size_of::<Option<PipeBuffer>>());
        BUDGET.set_limit(retained).unwrap();
        assert_eq!(table.try_alloc_pair(PipeBuffer::empty(0), PipeBuffer::empty(0)), Err(Errno::ENOMEM));
        assert_eq!(table.pipes.len(), 4);
        assert_eq!(table.first_free, 4);
        assert_eq!(table.count_active(), 4);
        assert_eq!(BUDGET.usage().0, retained);
        for index in [1, 2] {
            let pipe = table.get_mut(index).unwrap();
            pipe.close_read_end();
            pipe.close_write_end();
            table.free_if_closed(index);
        }
        assert_eq!(table.try_alloc_pair(PipeBuffer::empty(0), PipeBuffer::empty(0)), Ok((1, 2)));
        assert_eq!(BUDGET.usage().0, retained);
        drop(table);
        assert_eq!(BUDGET.usage().0, 0);
    }

    #[test]
    fn deferred_cleanup_capacity_is_admitted_before_ownership_and_reclaimed_after_drain() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let mut queue = DeferredInFlightReleaseQueue { records: IoBuffer::new(), reserved: 0 };
        {
            let _limit = crate::io_buffer::test_budget(baseline);
            assert_eq!(queue.reserve(), Err(Errno::ENOMEM));
        }
        assert_eq!(queue.reserved, 0);
        queue.reserve().unwrap();
        let old = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(old);
            assert_eq!(queue.reserve(), Err(Errno::ENOMEM));
            assert_eq!(queue.reserved, 1);
            queue.reserved -= 1;
            queue.records.push(DeferredInFlightFdRelease {
                ofd_id: OfdId(23), file_type: FileType::Regular, host_handle: 27,
                pipe_ref_kind: None, prime_bo_id: None,
            });
            queue.reclaim_empty();
            assert_eq!(queue.records.len(), 1);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, old);
            assert_eq!(queue.records.pop().unwrap().ofd_id, OfdId(23));
            queue.reclaim_empty();
        }
        assert_eq!(queue.records.capacity(), 0);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        queue.reserve().unwrap();
        queue.reserved -= 1;
        queue.reclaim_empty();
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    fn test_ancillary_fd(id: u64) -> InFlightFd {
        InFlightFd::new(
            OfdId(id),
            None,
            FileType::Regular,
            wasm_posix_shared::flags::O_RDONLY,
            id as i64,
            0,
            b"/tmp/right".to_vec(),
        )
    }

    fn fifo_metadata() -> WasmStat {
        WasmStat {
            st_dev: 1,
            st_ino: 1,
            st_mode: wasm_posix_shared::mode::S_IFIFO | 0o600,
            st_nlink: 1,
            st_uid: 0,
            st_gid: 0,
            st_size: 0,
            st_atime_sec: 0,
            st_atime_nsec: 0,
            st_mtime_sec: 0,
            st_mtime_nsec: 0,
            st_ctime_sec: 0,
            st_ctime_nsec: 0,
            _pad: 0,
            st_rdev: 0,
        }
    }

    #[test]
    fn tcp_reset_does_not_target_a_reused_receive_pipe() {
        let mut table = PipeTable::new();
        let (recv, send) = table.alloc_tcp_pair(8).unwrap();
        let token = table.get(recv).unwrap().tcp_connection_id();
        table.get_mut(recv).unwrap().close_read_end();
        table.get_mut(recv).unwrap().close_write_end();
        table.free_if_closed(recv);
        let replacement = table.alloc(PipeBuffer::new(8));
        assert_eq!(replacement, recv);
        table.get_mut(replacement).unwrap().write(b"new");
        table.reset_tcp_connection(recv, send, token).unwrap();
        assert_eq!(
            table.get(send).unwrap().stream_error(),
            Some(Errno::ECONNRESET)
        );
        assert_eq!(table.get(replacement).unwrap().stream_error(), None);
        let mut bytes = [0; 3];
        assert_eq!(table.get_mut(replacement).unwrap().read(&mut bytes), 3);
        assert_eq!(&bytes, b"new");
        assert_eq!(
            table.reset_tcp_connection(recv, send, token + 1),
            Err(Errno::ENOTCONN)
        );
    }

    #[test]
    fn fragmented_reuse_preserves_live_indices_and_adjacent_pair_capacity() {
        let mut table = PipeTable::new();
        for _ in 0..6 { table.alloc(PipeBuffer::new(8)); }
        for index in [1, 3, 4] { table.discard_unclaimed(index); }
        let capacity = table.pipes.capacity();
        let first = PipeBuffer::new(8);
        let second = PipeBuffer::new(8);
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(baseline);
            assert_eq!(table.alloc_pair(first, second), (3, 4));
            assert_eq!(table.pipes.capacity(), capacity);
            assert_eq!(table.pipes.len(), 6);
            assert_eq!(table.get(5).unwrap().pipe_idx, 5);
            table.discard_unclaimed(3);
            table.discard_unclaimed(4);
        }
        assert_eq!(table.alloc(PipeBuffer::new(8)), 1);
        assert_eq!(table.get(0).unwrap().pipe_idx, 0);
        assert_eq!(table.get(2).unwrap().pipe_idx, 2);
        assert_eq!(table.get(5).unwrap().pipe_idx, 5);
    }

    #[test]
    fn test_write_and_read() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        let written = pipe.write(b"hello");
        assert_eq!(written, 5);

        let mut buf = [0u8; 5];
        let read = pipe.read(&mut buf);
        assert_eq!(read, 5);
        assert_eq!(&buf, b"hello");
    }

    #[test]
    fn test_fifo_ordering() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        pipe.write(b"first");
        pipe.write(b"second");

        let mut buf = [0u8; 11];
        let read = pipe.read(&mut buf);
        assert_eq!(read, 11);
        assert_eq!(&buf[..11], b"firstsecond");
    }

    #[test]
    fn stream_ancillary_follows_its_carrier_byte_range() {
        let mut pipe = PipeBuffer::new(32);
        assert_eq!(pipe.write(b"AAAA"), 4);
        assert_eq!(
            pipe.write_with_ancillary(b"B", vec![test_ancillary_fd(1)]),
            Ok(1)
        );
        assert_eq!(pipe.write(b"CCCC"), 4);

        let mut first = [0u8; 1];
        let received = pipe.recv_message(&mut first, false).unwrap();
        assert_eq!(received.bytes_read, 1);
        assert!(!received.hit_ancillary_barrier);
        assert!(received.ancillary_fds.is_none());
        assert_eq!(&first, b"A");

        let mut through_carrier = [0u8; 8];
        let received = pipe.recv_message(&mut through_carrier, false).unwrap();
        assert_eq!(received.bytes_read, 4);
        assert!(received.hit_ancillary_barrier);
        assert_eq!(received.ancillary_fds.as_ref().unwrap()[0].ofd_id, OfdId(1));
        assert_eq!(&through_carrier[..4], b"AAAB");

        let mut tail = [0u8; 8];
        assert_eq!(pipe.read(&mut tail), 4);
        assert_eq!(&tail[..4], b"CCCC");
    }

    #[test]
    fn stream_receive_stops_at_each_ancillary_barrier() {
        let mut pipe = PipeBuffer::new(8);
        assert_eq!(
            pipe.write_with_ancillary(b"A", vec![test_ancillary_fd(1)]),
            Ok(1)
        );
        assert_eq!(
            pipe.write_with_ancillary(b"B", vec![test_ancillary_fd(2)]),
            Ok(1)
        );

        let mut bytes = [0u8; 2];
        let first = pipe.recv_message(&mut bytes, false).unwrap();
        assert_eq!(first.bytes_read, 1);
        assert_eq!(first.ancillary_fds.unwrap()[0].ofd_id, OfdId(1));
        assert_eq!(bytes[0], b'A');

        let second = pipe.recv_message(&mut bytes, false).unwrap();
        assert_eq!(second.bytes_read, 1);
        assert_eq!(second.ancillary_fds.unwrap()[0].ofd_id, OfdId(2));
        assert_eq!(bytes[0], b'B');
    }

    #[test]
    fn plain_read_discards_crossed_ancillary_batch() {
        let mut pipe = PipeBuffer::new(8);
        assert_eq!(
            pipe.write_with_ancillary(b"A", vec![test_ancillary_fd(1)]),
            Ok(1)
        );
        let mut byte = [0u8; 1];
        assert_eq!(pipe.read(&mut byte), 1);
        assert_eq!(&byte, b"A");
        assert!(!pipe.has_ancillary());
    }

    #[test]
    fn ancillary_admission_precedes_carrier_publication_and_peek_copy() {
        let mut pipe = PipeBuffer::new(8);
        let mut fds = AncillaryFds::try_with_capacity(1).unwrap();
        fds.push(test_ancillary_fd(19));
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(held);
            assert_eq!(pipe.write_with_ancillary(b"Q", fds), Err(Errno::ENOMEM));
            assert_eq!(pipe.available(), 0);
            assert!(!pipe.has_ancillary());
        }
        assert_eq!(pipe.write_with_ancillary(b"R", vec![test_ancillary_fd(20)]), Ok(1));
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        let mut byte = [0x55];
        {
            let _limit = crate::io_buffer::test_budget(held);
            assert!(matches!(pipe.recv_message(&mut byte, true), Err(Errno::ENOMEM)));
            assert_eq!(byte, [0x55]);
            assert_eq!(pipe.available(), 1);
            assert!(pipe.has_ancillary());
            let consumed = pipe.recv_message(&mut byte, false).unwrap();
            assert_eq!(consumed.bytes_read, 1);
            assert_eq!(byte, [b'R']);
            assert_eq!(consumed.ancillary_fds.unwrap()[0].ofd_id, OfdId(20));
            assert!(!pipe.has_ancillary());
        }
    }

    #[test]
    fn stream_ancillary_peek_is_repeatable_and_non_consuming() {
        let mut pipe = PipeBuffer::new(8);
        assert_eq!(
            pipe.write_with_ancillary(b"P", vec![test_ancillary_fd(1)]),
            Ok(1)
        );
        let mut byte = [0u8; 1];
        for _ in 0..2 {
            let peeked = pipe.recv_message(&mut byte, true).unwrap();
            assert_eq!(peeked.bytes_read, 1);
            assert_eq!(peeked.ancillary_fds.unwrap()[0].ofd_id, OfdId(1));
            assert!(pipe.has_ancillary());
        }
        let consumed = pipe.recv_message(&mut byte, false).unwrap();
        assert_eq!(consumed.ancillary_fds.unwrap()[0].ofd_id, OfdId(1));
        assert!(!pipe.has_ancillary());
    }

    #[test]
    fn stream_sequence_rebases_queued_ancillary_near_u64_max() {
        let mut pipe = PipeBuffer::new(16);
        pipe.stream_position = u64::MAX - 5;
        assert_eq!(pipe.write(b"A"), 1);
        assert_eq!(
            pipe.write_with_ancillary(b"B", vec![test_ancillary_fd(7)]),
            Ok(1)
        );

        // This ordinary write would overflow stream_position + buffered bytes.
        // It performs the rare checked rebase and keeps the queued range exact.
        assert_eq!(pipe.write(b"CDEF"), 4);
        assert_eq!(pipe.stream_position, 0);

        let mut bytes = [0u8; 8];
        let received = pipe.recv_message(&mut bytes, false).unwrap();
        assert_eq!(received.bytes_read, 2);
        assert_eq!(&bytes[..2], b"AB");
        assert_eq!(received.ancillary_fds.unwrap()[0].ofd_id, OfdId(7));
        assert_eq!(pipe.read(&mut bytes), 4);
        assert_eq!(&bytes[..4], b"CDEF");
    }

    #[test]
    fn failed_or_partial_stream_send_never_detaches_rights() {
        let mut full = PipeBuffer::new(1);
        assert_eq!(full.write(b"X"), 1);
        assert_eq!(
            full.write_with_ancillary(b"Y", vec![test_ancillary_fd(1)]),
            Ok(0)
        );
        assert!(!full.has_ancillary());

        let mut partial = PipeBuffer::new(2);
        assert_eq!(
            partial.write_with_ancillary(b"ABC", vec![test_ancillary_fd(2)]),
            Ok(2)
        );
        let mut bytes = [0u8; 3];
        let received = partial.recv_message(&mut bytes, false).unwrap();
        assert_eq!(received.bytes_read, 2);
        assert_eq!(&bytes[..2], b"AB");
        assert_eq!(received.ancillary_fds.unwrap()[0].ofd_id, OfdId(2));
    }

    #[test]
    fn inactive_fifo_has_no_resident_data_buffer() {
        let pipe = PipeBuffer::new_fifo(DEFAULT_PIPE_CAPACITY, fifo_metadata());
        assert_eq!(pipe.capacity(), DEFAULT_PIPE_CAPACITY);
        assert_eq!(pipe.free_space(), DEFAULT_PIPE_CAPACITY);
        assert_eq!(pipe.buf.capacity(), 0);
        assert_eq!(pipe.available(), 0);
    }

    #[test]
    fn fifo_buffer_admission_is_fallible_and_releases_after_the_last_io_endpoint() {
        static BUDGET: MetadataBudget = MetadataBudget::new(256);
        let mut pipe = PipeBuffer::new_fifo(128, fifo_metadata());
        BUDGET.set_limit(255).unwrap();
        assert_eq!(pipe.prepare_fifo_io_with_budget(&BUDGET), Err(Errno::ENOMEM));
        assert_eq!(BUDGET.usage().0, 0);
        assert_eq!(pipe.resident_buffer_bytes(), 0);
        assert!(!pipe.has_readers());
        assert!(!pipe.is_write_end_open());
        BUDGET.set_limit(256).unwrap();
        pipe.fail_next_fifo_buffer_allocation();
        assert_eq!(pipe.prepare_fifo_io_with_budget(&BUDGET), Err(Errno::ENOMEM));
        assert_eq!(BUDGET.usage().0, 0);
        pipe.prepare_fifo_io_with_budget(&BUDGET).unwrap();
        assert_eq!(BUDGET.usage().0, 2 * pipe.resident_buffer_bytes());
        assert_eq!(pipe.resident_buffer_bytes(), 128);
        pipe.prepare_fifo_io_with_budget(&BUDGET).unwrap();
        pipe.add_reference(InFlightPipeRefKind::ReadWrite);
        pipe.add_reference(InFlightPipeRefKind::Path);
        assert_eq!(pipe.write(b"old"), 3);
        pipe.close_read_end();
        assert_eq!(BUDGET.usage().0, 256);
        pipe.close_write_end();
        assert_eq!(BUDGET.usage().0, 0);
        assert_eq!(pipe.capacity(), 128);
        assert_eq!(pipe.resident_buffer_bytes(), 0);
        assert!(!pipe.is_fully_closed());
        pipe.prepare_fifo_io_with_budget(&BUDGET).unwrap();
        pipe.add_reference(InFlightPipeRefKind::ReadWrite);
        assert_eq!(pipe.available(), 0);
        assert_eq!(pipe.write(b"new"), 3);
        let mut bytes = [0; 3];
        assert_eq!(pipe.read(&mut bytes), 3);
        assert_eq!(&bytes, b"new");
        pipe.close_reference(InFlightPipeRefKind::ReadWrite);
        assert_eq!(BUDGET.usage().0, 0);
    }

    #[test]
    fn fifo_buffer_ownership_follows_inherited_and_in_flight_endpoints() {
        static BUDGET: MetadataBudget = MetadataBudget::new(128);
        let mut pipe = PipeBuffer::new_fifo(64, fifo_metadata());
        pipe.prepare_fifo_io_with_budget(&BUDGET).unwrap();
        pipe.add_reference(InFlightPipeRefKind::ReadWrite);
        pipe.add_reference(InFlightPipeRefKind::ReadWrite);
        assert_eq!(pipe.write(b"held"), 4);
        pipe.close_reference(InFlightPipeRefKind::ReadWrite);
        pipe.retain_in_flight_reference(InFlightPipeRefKind::ReadWrite);
        pipe.close_reference(InFlightPipeRefKind::ReadWrite);
        assert_eq!(BUDGET.usage().0, 128);
        assert_eq!(pipe.available(), 4);
        pipe.adopt_in_flight_reference(InFlightPipeRefKind::ReadWrite);
        assert_eq!(BUDGET.usage().0, 128);
        let mut bytes = [0; 4];
        assert_eq!(pipe.read(&mut bytes), 4);
        assert_eq!(&bytes, b"held");
        pipe.close_reference(InFlightPipeRefKind::ReadWrite);
        assert_eq!(BUDGET.usage().0, 0);
    }

    #[test]
    fn fifo_waiter_admission_and_node_failure_leave_endpoints_unchanged() {
        static BUDGET: MetadataBudget = MetadataBudget::new(4096);
        let reservation = PreparedEntry::<u64, FifoOpenWaiter>::reserve_in(&BUDGET, 0).unwrap();
        let node_bytes = reservation.bytes();
        drop(reservation);
        let mut pipe = PipeBuffer::new_fifo(DEFAULT_PIPE_CAPACITY, fifo_metadata());
        BUDGET.set_limit(node_bytes).unwrap();
        crate::prepared_map::fail_after_allocations(0);
        assert_eq!(pipe.reserve_fifo_open_with_budget(1, FifoOpenSide::Reader, b"/tmp/fifo", 7, 1, 3, &BUDGET), Err(Errno::ENOMEM));
        assert_eq!(BUDGET.usage().0, 0);
        assert!(!pipe.has_readers());
        assert!(!pipe.has_fifo_open_waiter(1));
        BUDGET.set_limit(4096).unwrap();
        assert_eq!(pipe.reserve_fifo_open_with_budget(1, FifoOpenSide::Reader, b"/tmp/fifo", 7, 1, 3, &BUDGET), Err(Errno::ENOMEM));
        assert_eq!(BUDGET.usage().0, 0);
        assert!(!pipe.has_readers());
        assert!(!pipe.has_fifo_open_waiter(1));
        pipe.reserve_fifo_open_with_budget(1, FifoOpenSide::Reader, b"/tmp/fifo", 7, 1, 3, &BUDGET).unwrap();
        let bytes = BUDGET.usage().0;
        assert_eq!(bytes, node_bytes + 2 * b"/tmp/fifo".len());
        assert_eq!(pipe.reserve_fifo_open_with_budget(1, FifoOpenSide::Writer, b"/other", 0, 0, 4, &BUDGET), Err(Errno::EIO));
        assert_eq!(BUDGET.usage().0, bytes);
        assert!(!pipe.is_write_end_open());
        assert!(pipe.take_ready_fifo_open(1).is_none());
        drop(pipe);
        assert_eq!(BUDGET.usage().0, 0);
    }

    #[test]
    fn fifo_waiter_credits_follow_ready_and_cancelled_path_ownership() {
        static BUDGET: MetadataBudget = MetadataBudget::new(4096);
        let mut pipe = PipeBuffer::new_fifo(DEFAULT_PIPE_CAPACITY, fifo_metadata());
        for owner in [1, 2] {
            pipe.reserve_fifo_open_with_budget(owner, FifoOpenSide::Reader, b"/tmp/fifo", 7, 1, owner as i32 + 3, &BUDGET).unwrap();
        }
        let bytes = BUDGET.usage().0;
        pipe.add_fifo_endpoint_ref(FifoOpenSide::Writer);
        pipe.publish_fifo_open(FifoOpenSide::Writer);
        pipe.close_write_end();
        let cancelled = pipe.cancel_fifo_open(1).unwrap();
        assert!(pipe.has_readers());
        let ready = pipe.take_ready_fifo_open(2).unwrap();
        assert!(pipe.fifo_open_waiters.is_empty());
        assert_eq!(BUDGET.usage().0, bytes);
        assert_eq!(ready.path, b"/tmp/fifo");
        assert_eq!(ready.status_flags, 7);
        assert_eq!(ready.fd_flags, 1);
        assert_eq!(ready.reserved_fd, 5);
        assert_eq!(cancelled.reserved_fd, 4);
        drop(cancelled);
        assert_eq!(BUDGET.usage().0, bytes / 2);
        pipe.publish_fifo_open(FifoOpenSide::Reader);
        assert!(pipe.read_end_has_hangup());
        drop(ready);
        assert_eq!(BUDGET.usage().0, 0);
        pipe.close_fifo_read_only();
    }

    #[test]
    fn fifo_process_cancellation_needs_no_new_waiter_storage() {
        static BUDGET: MetadataBudget = MetadataBudget::new(4096);
        let mut table = PipeTable::new();
        for index in 0..2 {
            let mut pipe = PipeBuffer::new_fifo(DEFAULT_PIPE_CAPACITY, fifo_metadata());
            for pid in [0, 42, u32::MAX] {
                let owner = ((pid as u64) << 32) | (index + 1) as u64;
                pipe.reserve_fifo_open_with_budget(owner, FifoOpenSide::Reader, b"/tmp/fifo", 0, 0, index + 3, &BUDGET).unwrap();
            }
            table.alloc(pipe);
        }
        let bytes = BUDGET.usage().0;
        BUDGET.set_limit(bytes).unwrap();
        crate::prepared_map::fail_after_allocations(0);
        for (index, pid) in [42, u32::MAX, 0].into_iter().enumerate() {
            let mut descriptors = [0; 2];
            let mut count = 0;
            table.cancel_fifo_opens_for_process(pid, |waiter| {
                descriptors[count] = waiter.reserved_fd;
                count += 1;
            });
            assert_eq!(count, 2);
            assert_eq!(descriptors, [3, 4]);
            assert_eq!(BUDGET.usage().0, bytes - (index + 1) * (bytes / 3));
        }
        for pipe in table.pipes.iter().flatten() {
            assert!(!pipe.has_readers());
            assert!(pipe.fifo_open_waiters.is_empty());
        }
        assert_eq!(BUDGET.usage().0, 0);
        assert_eq!(table.get_mut(0).unwrap().reserve_fifo_open_with_budget(1, FifoOpenSide::Reader, b"/tmp/fifo", 0, 0, 3, &BUDGET), Err(Errno::ENOMEM));
        assert_eq!(BUDGET.usage().0, 0);
        BUDGET.set_limit(4096).unwrap();
    }

    #[test]
    fn fifo_waiters_use_ordinary_io_not_journal_or_writeback_credit() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let writeback = crate::io_buffer::WRITEBACK_MEMORY.usage();
        let journal = crate::prepared_map::JOURNAL_STATE_MEMORY.usage();
        let reserve = crate::prepared_map::JOURNAL_WRITEBACK_MEMORY.reserve(1).unwrap();
        let mut pipe = PipeBuffer::new_fifo(DEFAULT_PIPE_CAPACITY, fifo_metadata());
        pipe.reserve_fifo_open(1, FifoOpenSide::Reader, b"/tmp/fifo", 0, 0, 3).unwrap();
        assert!(crate::io_buffer::IO_MEMORY.usage().0 > baseline);
        {
            let _budget = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            assert_eq!(pipe.reserve_fifo_open(2, FifoOpenSide::Reader, b"/tmp/fifo", 0, 0, 4), Err(Errno::ENOMEM));
        }
        assert_eq!(crate::io_buffer::WRITEBACK_MEMORY.usage(), writeback);
        assert_eq!(crate::prepared_map::JOURNAL_STATE_MEMORY.usage(), journal);
        drop(pipe);
        drop(reserve);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn fifo_reader_observes_writer_close_before_open_resumes() {
        let mut pipe = PipeBuffer::new_fifo(DEFAULT_PIPE_CAPACITY, fifo_metadata());
        pipe.reserve_fifo_open(1, FifoOpenSide::Reader, b"/tmp/fifo", 0, 0, 3).unwrap();

        pipe.add_fifo_endpoint_ref(FifoOpenSide::Writer);
        pipe.publish_fifo_open(FifoOpenSide::Writer);
        pipe.close_write_end();
        assert!(pipe.take_ready_fifo_open(1).is_some());

        pipe.publish_fifo_open(FifoOpenSide::Reader);
        assert!(pipe.read_end_has_eof());
        assert!(pipe.read_end_has_hangup());

        pipe.close_fifo_read_only();
        pipe.add_fifo_endpoint_ref(FifoOpenSide::Reader);
        pipe.publish_fifo_open(FifoOpenSide::Reader);
        assert!(pipe.read_end_has_eof());
        assert!(!pipe.read_end_has_hangup());
    }

    #[test]
    fn fifo_cancel_preserves_writer_history_for_other_ready_reader() {
        let mut pipe = PipeBuffer::new_fifo(DEFAULT_PIPE_CAPACITY, fifo_metadata());
        for owner in [1, 2] {
            pipe.reserve_fifo_open(
                owner,
                FifoOpenSide::Reader,
                b"/tmp/fifo",
                0,
                0,
                owner as i32 + 3,
            ).unwrap();
        }

        pipe.add_fifo_endpoint_ref(FifoOpenSide::Writer);
        pipe.publish_fifo_open(FifoOpenSide::Writer);
        assert!(pipe.cancel_fifo_open(1).is_some());
        pipe.close_write_end();
        assert!(pipe.take_ready_fifo_open(2).is_some());
        pipe.publish_fifo_open(FifoOpenSide::Reader);
        assert!(pipe.read_end_has_hangup());
    }

    #[test]
    fn test_full_buffer() {
        let mut pipe = PipeBuffer::new(8);
        let written = pipe.write(b"12345678");
        assert_eq!(written, 8);

        // Buffer is full, additional write should return 0
        let written = pipe.write(b"abcd");
        assert_eq!(written, 0);
    }

    #[test]
    fn test_wraparound() {
        let mut pipe = PipeBuffer::new(8);

        // Fill the buffer
        let written = pipe.write(b"12345678");
        assert_eq!(written, 8);

        // Read 4 bytes, freeing space at the beginning
        let mut buf = [0u8; 4];
        let read = pipe.read(&mut buf);
        assert_eq!(read, 4);
        assert_eq!(&buf, b"1234");

        // Write 4 more bytes -- these wrap around to the beginning
        let written = pipe.write(b"abcd");
        assert_eq!(written, 4);

        // Read all 8 bytes: the remaining "5678" plus the wrapped "abcd"
        let mut buf = [0u8; 8];
        let read = pipe.read(&mut buf);
        assert_eq!(read, 8);
        assert_eq!(&buf, b"5678abcd");
    }

    #[test]
    fn test_empty_read() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        let mut buf = [0u8; 10];
        let read = pipe.read(&mut buf);
        assert_eq!(read, 0);
    }

    #[test]
    fn test_partial_write() {
        let mut pipe = PipeBuffer::new(8);
        let written = pipe.write(b"12345");
        assert_eq!(written, 5);

        // Only 3 bytes of free space remain, so only 3 of the 5 bytes
        // should be written.
        let written = pipe.write(b"abcde");
        assert_eq!(written, 3);
    }

    #[test]
    fn test_close_endpoints() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        assert!(pipe.is_read_end_open());
        assert!(pipe.is_write_end_open());

        pipe.close_write_end();
        assert!(!pipe.is_write_end_open());
        assert!(pipe.is_read_end_open());

        pipe.close_read_end();
        assert!(!pipe.is_read_end_open());
    }

    #[test]
    fn test_pipe_peek() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        pipe.write(b"hello");
        let mut buf = [0u8; 5];
        // Peek should read without consuming
        let n = pipe.peek(&mut buf);
        assert_eq!(n, 5);
        assert_eq!(&buf[..5], b"hello");
        // Data should still be available for regular read
        let n2 = pipe.read(&mut buf);
        assert_eq!(n2, 5);
        assert_eq!(&buf[..5], b"hello");
    }

    #[test]
    fn test_capacity_and_counts() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        assert_eq!(pipe.capacity(), DEFAULT_PIPE_CAPACITY);
        assert_eq!(pipe.available(), 0);
        assert_eq!(pipe.free_space(), DEFAULT_PIPE_CAPACITY);

        pipe.write(b"hello");
        assert_eq!(pipe.available(), 5);
        assert_eq!(pipe.free_space(), DEFAULT_PIPE_CAPACITY - 5);
    }

    #[test]
    fn test_ref_counting() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        assert!(pipe.is_read_end_open());
        assert!(pipe.is_write_end_open());

        // Add extra reader and writer (simulating fork)
        pipe.add_reader();
        pipe.add_writer();

        // Close one reader — still open
        pipe.close_read_end();
        assert!(pipe.is_read_end_open());
        assert!(!pipe.is_fully_closed());

        // Close second reader — now closed
        pipe.close_read_end();
        assert!(!pipe.is_read_end_open());
        assert!(!pipe.is_fully_closed()); // writer still open

        // Close both writers
        pipe.close_write_end();
        assert!(!pipe.is_fully_closed());
        pipe.close_write_end();
        assert!(pipe.is_fully_closed());
    }

    #[test]
    fn test_orderly_read_close_discards_until_last_writer_closes() {
        let mut pipe = PipeBuffer::new(8);

        pipe.close_read_end_orderly();
        assert!(pipe.is_read_end_open());
        assert!(!pipe.has_readers());
        assert_eq!(pipe.write(b"first"), 5);
        assert_eq!(pipe.write(b"larger than capacity"), 20);
        assert_eq!(pipe.available(), 0);
        assert!(!pipe.is_fully_closed());

        pipe.close_write_end();
        assert!(!pipe.is_read_end_open());
        assert!(pipe.is_fully_closed());
    }

    #[test]
    fn test_orderly_read_close_preserves_other_real_readers() {
        let mut pipe = PipeBuffer::new(8);
        pipe.add_reader();

        pipe.close_read_end_orderly();
        assert!(pipe.has_readers());
        assert_eq!(pipe.write(b"live"), 4);
        let mut buf = [0u8; 4];
        assert_eq!(pipe.read(&mut buf), 4);
        assert_eq!(&buf, b"live");

        pipe.close_read_end_orderly();
        assert!(!pipe.has_readers());
        assert_eq!(pipe.write(b"discarded"), 9);
        assert_eq!(pipe.available(), 0);
        pipe.close_write_end();
        assert!(pipe.is_fully_closed());
    }

    #[test]
    fn test_pipe_table_alloc_and_free() {
        let mut table = PipeTable::new();
        let idx = table.alloc(PipeBuffer::new(64));
        assert_eq!(idx, 0);

        let idx2 = table.alloc(PipeBuffer::new(64));
        assert_eq!(idx2, 1);

        // Close both endpoints of first pipe
        table.get_mut(idx).unwrap().close_read_end();
        table.get_mut(idx).unwrap().close_write_end();
        table.free_if_closed(idx);

        // Slot 0 should be reusable
        let idx3 = table.alloc(PipeBuffer::new(64));
        assert_eq!(idx3, 0);
    }

    #[test]
    fn test_pipe_table_discards_unclaimed_slot() {
        let mut table = PipeTable::new();
        let idx = table.alloc(PipeBuffer::new(64));

        table.discard_unclaimed(idx);

        assert_eq!(table.count_active(), 0);
        assert_eq!(table.alloc(PipeBuffer::new(64)), idx);
    }

    fn in_flight_pipe_read_end(pipe_idx: usize) -> InFlightFd {
        let mut fd = InFlightFd::new(
            OfdId(1),
            None,
            FileType::Pipe,
            wasm_posix_shared::flags::O_RDONLY,
            -((pipe_idx as i64) + 1),
            0,
            b"/dev/pipe".to_vec(),
        );
        fd.pipe_ref_kind = Some(InFlightPipeRefKind::Read {
            fifo_read_only: false,
        });
        fd
    }

    fn in_flight_fifo(pipe_idx: usize, status_flags: u32, kind: InFlightPipeRefKind) -> InFlightFd {
        let mut fd = InFlightFd::new(
            OfdId(1),
            None,
            FileType::Pipe,
            status_flags,
            -((pipe_idx as i64) + 1),
            0,
            b"/tmp/fifo".to_vec(),
        );
        fd.pipe_ref_kind = Some(kind);
        fd
    }

    #[test]
    fn scm_rights_reference_becomes_received_pipe_endpoint() {
        let mut table = PipeTable::new();
        let pipe_idx = table.alloc(PipeBuffer::new(64));
        let right = in_flight_pipe_read_end(pipe_idx);

        assert!(table.retain_ancillary_resources(core::slice::from_ref(&right)));
        table.adopt_ancillary_resource(&right);
        table.finish_ancillary_transition();
        table.get_mut(pipe_idx).unwrap().close_read_end();
        assert_eq!(
            table.get_mut(pipe_idx).unwrap().write(b"still connected"),
            15
        );

        // Receiving transfers the retained reference to the new OFD. Its final
        // close, not installation, consumes that same reference.
        table.get_mut(pipe_idx).unwrap().close_write_end();
        let mut payload = [0u8; 15];
        assert_eq!(table.get_mut(pipe_idx).unwrap().read(&mut payload), 15);
        assert_eq!(&payload, b"still connected");
        table.get_mut(pipe_idx).unwrap().close_read_end();
        table.free_if_closed(pipe_idx);
        assert!(table.get(pipe_idx).is_none());
    }

    #[test]
    fn scm_rights_fifo_path_reference_controls_reclamation() {
        let mut table = PipeTable::new();
        let pipe_idx = table.alloc(PipeBuffer::new_fifo(64, fifo_metadata()));
        let right = in_flight_fifo(
            pipe_idx,
            wasm_posix_shared::flags::O_PATH,
            InFlightPipeRefKind::Path,
        );

        assert!(table.retain_ancillary_resources(core::slice::from_ref(&right)));
        table.remove_fifo_name(pipe_idx);
        assert!(table.get(pipe_idx).is_some());

        table.release_ancillary_resource(&right);
        table.finish_ancillary_transition();
        assert!(table.get(pipe_idx).is_none());
    }

    #[test]
    fn scm_rights_fifo_reader_preserves_read_only_cohort() {
        let mut table = PipeTable::new();
        let pipe_idx = table.alloc(PipeBuffer::new_fifo(64, fifo_metadata()));
        let right = in_flight_fifo(
            pipe_idx,
            wasm_posix_shared::flags::O_RDONLY,
            InFlightPipeRefKind::Read {
                fifo_read_only: true,
            },
        );
        let pipe = table.get_mut(pipe_idx).unwrap();
        pipe.add_fifo_endpoint_ref(FifoOpenSide::Reader);
        pipe.publish_fifo_open(FifoOpenSide::Reader);
        pipe.add_fifo_endpoint_ref(FifoOpenSide::Writer);
        pipe.publish_fifo_open(FifoOpenSide::Writer);

        assert!(table.retain_ancillary_resources(core::slice::from_ref(&right)));
        table.get_mut(pipe_idx).unwrap().close_fifo_read_only();
        table.get_mut(pipe_idx).unwrap().close_write_end();
        assert!(table.get(pipe_idx).unwrap().read_end_has_hangup());

        table.adopt_ancillary_resource(&right);
        table.finish_ancillary_transition();
        table
            .get_mut(pipe_idx)
            .unwrap()
            .close_reference(InFlightPipeRefKind::Read {
                fifo_read_only: true,
            });
        table.remove_fifo_name(pipe_idx);
        assert!(table.get(pipe_idx).is_none());
    }

    #[test]
    fn discarded_scm_rights_fifo_reader_releases_endpoint_and_cohort() {
        let mut table = PipeTable::new();
        let pipe_idx = table.alloc(PipeBuffer::new_fifo(64, fifo_metadata()));
        let right = in_flight_fifo(
            pipe_idx,
            wasm_posix_shared::flags::O_RDONLY,
            InFlightPipeRefKind::Read {
                fifo_read_only: true,
            },
        );
        let pipe = table.get_mut(pipe_idx).unwrap();
        pipe.add_fifo_endpoint_ref(FifoOpenSide::Reader);
        pipe.publish_fifo_open(FifoOpenSide::Reader);

        assert!(table.retain_ancillary_resources(core::slice::from_ref(&right)));
        table.get_mut(pipe_idx).unwrap().close_fifo_read_only();
        assert!(table.get(pipe_idx).unwrap().has_readers());

        table.release_ancillary_resource(&right);
        table.finish_ancillary_transition();
        assert!(!table.get(pipe_idx).unwrap().has_readers());
        assert_eq!(table.get(pipe_idx).unwrap().fifo_read_only_count, 0);
    }

    #[test]
    fn closing_carrier_releases_queued_pipe_endpoint() {
        let mut table = PipeTable::new();
        let pipe_idx = table.alloc(PipeBuffer::new(64));
        let carrier_idx = table.alloc(PipeBuffer::new(64));
        let right = in_flight_pipe_read_end(pipe_idx);

        assert!(table.queue_ancillary(carrier_idx, vec![right]));
        table.get_mut(pipe_idx).unwrap().close_read_end();
        assert_eq!(table.get_mut(pipe_idx).unwrap().write(b"held"), 4);

        table.get_mut(carrier_idx).unwrap().close_read_end();
        table.get_mut(carrier_idx).unwrap().close_write_end();
        table.free_if_closed(carrier_idx);
        assert_eq!(table.get_mut(pipe_idx).unwrap().write(b"released"), 0);

        table.get_mut(pipe_idx).unwrap().close_write_end();
        table.free_if_closed(pipe_idx);
        assert!(table.get(pipe_idx).is_none());
    }
}
