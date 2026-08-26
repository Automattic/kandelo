extern crate alloc;

use alloc::collections::{BTreeMap, VecDeque};
use alloc::vec::Vec;
use core::cell::UnsafeCell;
use wasm_posix_shared::WasmStat;

use wasm_posix_shared::Errno;

use crate::lock::{FileId, OfdId};
use crate::ofd::{FileType, SharedOfdState};

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FifoOpenWaiter {
    pub side: FifoOpenSide,
    pub path: Vec<u8>,
    pub status_flags: u32,
    pub fd_flags: u32,
    pub reserved_fd: i32,
    ready: bool,
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
    pub path: Vec<u8>,
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

impl InFlightFd {
    pub fn new(
        ofd_id: OfdId,
        file_id: Option<FileId>,
        file_type: FileType,
        status_flags: u32,
        host_handle: i64,
        offset: i64,
        path: Vec<u8>,
    ) -> Self {
        let shared_state = SharedOfdState::new(status_flags, offset, 0);
        Self::new_with_shared_state(
            ofd_id,
            file_id,
            file_type,
            status_flags,
            host_handle,
            offset,
            path,
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
        path: Vec<u8>,
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
        self.owns_reference = true;
        Ok(())
    }

    /// Transfer the queued reference to a receiver-side OpenFileDesc without a
    /// decrement/re-increment window in the underlying resource ownership.
    pub fn transfer_reference(&mut self) {
        debug_assert!(self.owns_reference);
        if self.owns_reference {
            transfer_in_flight_resource(self.release_metadata());
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
        let mut path = Vec::new();
        path.try_reserve_exact(self.path.len())
            .map_err(|_| Errno::ENOMEM)?;
        path.extend_from_slice(&self.path);
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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReleasedInFlightFd {
    pub ofd_id: OfdId,
    pub final_ofd_reference: bool,
    pub host_close: Option<i64>,
}

/// One SCM_RIGHTS batch attached to an exact byte range in a stream pipe.
///
/// Positions use the pipe's absolute byte sequence so ordinary reads stay
/// O(1) regardless of how many later descriptor messages are queued.
struct StreamAncillary {
    start: u64,
    end: u64,
    fds: Vec<InFlightFd>,
}

/// Result of one message-aware stream read.
pub struct PipeMessageRead {
    pub bytes_read: usize,
    pub hit_ancillary_barrier: bool,
    pub ancillary_fds: Option<Vec<InFlightFd>>,
}

/// Result of a stream read that cannot return ancillary data.
pub struct PipePlainRead {
    pub bytes_read: usize,
    pub hit_ancillary_barrier: bool,
}

struct DeferredInFlightReleaseQueue {
    records: Vec<DeferredInFlightFdRelease>,
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
        records: Vec::new(),
        reserved: 0,
    })
}

fn reserve_deferred_in_flight_release() -> Result<(), Errno> {
    let queue = deferred_in_flight_releases();
    if queue.records.capacity() - queue.records.len() <= queue.reserved {
        queue
            .records
            .try_reserve(queue.reserved.checked_add(1).ok_or(Errno::EOVERFLOW)?)
            .map_err(|_| Errno::ENOMEM)?;
    }
    queue.reserved += 1;
    Ok(())
}

fn cancel_deferred_in_flight_release() {
    let queue = deferred_in_flight_releases();
    debug_assert!(queue.reserved > 0);
    queue.reserved = queue.reserved.saturating_sub(1);
}

fn enqueue_deferred_in_flight_release(release: DeferredInFlightFdRelease) {
    let queue = deferred_in_flight_releases();
    debug_assert!(queue.reserved > 0);
    debug_assert!(queue.records.len() < queue.records.capacity());
    queue.reserved = queue.reserved.saturating_sub(1);
    queue.records.push(release);
}

pub fn pop_deferred_in_flight_release() -> Option<DeferredInFlightFdRelease> {
    deferred_in_flight_releases().records.pop()
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
            crate::ofd::host_handle_fork_ref(release.host_handle);
        }
        FileType::Pipe if release.host_handle >= 0 => {
            crate::ofd::host_handle_fork_ref(release.host_handle);
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
                    } else {
                        pty.slave_refs = pty.slave_refs.saturating_sub(1);
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
    fifo_open_waiters: BTreeMap<u64, FifoOpenWaiter>,
    /// SCM_RIGHTS batches attached to exact stream byte ranges.
    ///
    /// WHY: a detached FIFO of descriptor batches can deliver rights while
    /// reading earlier plain bytes, or leave stale rights after `read(2)`
    /// consumes their carrier. The byte range makes each sendmsg an
    /// explicit receive barrier and keeps ordinary reads and peeks coherent.
    /// Absolute positions avoid walking every later record on each read.
    ancillary_fds: VecDeque<StreamAncillary>,
}

impl PipeBuffer {
    /// Create a new pipe buffer with the given capacity.
    pub fn new(capacity: usize) -> Self {
        let mut buf = Vec::new();
        buf.resize(capacity, 0u8);
        PipeBuffer {
            buf,
            head: 0,
            tail: 0,
            len: 0,
            stream_position: 0,
            read_count: 1,
            write_count: 1,
            in_flight_read_count: 0,
            in_flight_write_count: 0,
            orphaned_read: false,
            pipe_idx: 0,
            is_fifo: false,
            fifo_read_only_count: 0,
            fifo_writer_ever_opened: false,
            fifo_read_hangup: false,
            fifo_names: 0,
            fifo_path_refs: 0,
            fifo_metadata: None,
            fifo_open_waiters: BTreeMap::new(),
            ancillary_fds: VecDeque::new(),
        }
    }

    /// Create a FIFO backing buffer with no endpoints open yet. Endpoints are
    /// attached as processes `open()` the FIFO by path (see `crate::fifo`).
    pub fn new_fifo(capacity: usize, metadata: WasmStat) -> Self {
        let mut pipe = Self::new(capacity);
        pipe.read_count = 0;
        pipe.write_count = 0;
        pipe.is_fifo = true;
        pipe.fifo_names = 1;
        pipe.fifo_metadata = Some(metadata);
        pipe
    }

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

    pub fn reserve_fifo_open(
        &mut self,
        owner: u64,
        side: FifoOpenSide,
        path: Vec<u8>,
        status_flags: u32,
        fd_flags: u32,
        reserved_fd: i32,
    ) -> bool {
        debug_assert!(self.is_fifo);
        if self.fifo_open_waiters.contains_key(&owner) {
            return false;
        }
        self.fifo_open_waiters.insert(
            owner,
            FifoOpenWaiter {
                side,
                path,
                status_flags,
                fd_flags,
                reserved_fd,
                ready: false,
            },
        );
        self.add_fifo_endpoint_ref(side);
        true
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
                for waiter in self.fifo_open_waiters.values_mut() {
                    if waiter.side == FifoOpenSide::Writer {
                        waiter.ready = true;
                    }
                }
            }
            FifoOpenSide::Writer => {
                self.fifo_writer_ever_opened = true;
                self.fifo_read_hangup = false;
                for waiter in self.fifo_open_waiters.values_mut() {
                    if waiter.side == FifoOpenSide::Reader {
                        waiter.ready = true;
                    }
                }
            }
        }
    }

    pub fn publish_fifo_read_write_open(&mut self) {
        debug_assert!(self.is_fifo);
        self.fifo_writer_ever_opened = true;
        self.fifo_read_hangup = false;
        for waiter in self.fifo_open_waiters.values_mut() {
            waiter.ready = true;
        }
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
        self.fifo_open_waiters.remove(&owner)
    }

    pub fn has_fifo_open_waiter(&self, owner: u64) -> bool {
        self.fifo_open_waiters.contains_key(&owner)
    }

    pub fn cancel_fifo_open(&mut self, owner: u64) -> Option<FifoOpenWaiter> {
        let waiter = self.fifo_open_waiters.remove(&owner)?;
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

    pub fn cancel_fifo_opens_for_process(&mut self, pid: u32) -> Vec<FifoOpenWaiter> {
        let owners: Vec<u64> = self
            .fifo_open_waiters
            .keys()
            .copied()
            .filter(|owner| (*owner >> 32) as u32 == pid)
            .collect();
        owners
            .into_iter()
            .filter_map(|owner| self.cancel_fifo_open(owner))
            .collect()
    }

    /// Total capacity of the buffer.
    pub fn capacity(&self) -> usize {
        self.buf.len()
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
        fds: Vec<InFlightFd>,
    ) -> Result<usize, Errno> {
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
            let mut cloned = Vec::new();
            let original = &self
                .ancillary_fds
                .front()
                .expect("crossed ancillary record exists")
                .fds;
            cloned
                .try_reserve_exact(original.len())
                .map_err(|_| Errno::ENOMEM)?;
            for fd in original {
                cloned.push(fd.try_clone_retained()?);
            }
            Some(cloned)
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
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_WRITABLE);
    }

    /// Close one write end of the pipe. Decrements the write reference count.
    pub fn close_write_end(&mut self) {
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
        self.read_count > 0 || self.orphaned_read
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
        self.write_count > 0
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
    pipes: Vec<Option<PipeBuffer>>,
    free_list: Vec<usize>,
}

impl PipeTable {
    pub const fn new() -> Self {
        PipeTable {
            pipes: Vec::new(),
            free_list: Vec::new(),
        }
    }

    /// Allocate a pipe buffer in the table. Returns the index.
    pub fn alloc(&mut self, mut pipe: PipeBuffer) -> usize {
        if let Some(i) = self.free_list.pop() {
            pipe.pipe_idx = i as u32;
            self.pipes[i] = Some(pipe);
            return i;
        }
        let i = self.pipes.len();
        pipe.pipe_idx = i as u32;
        self.pipes.push(Some(pipe));
        i
    }

    /// Allocate two pipe buffers with adjacent indices (`second_idx == first_idx + 1`).
    /// The host TCP-bridge code assumes the recv and send pipes for an injected
    /// connection are consecutive (`sendPipeIdx = recvPipeIdx + 1`); this helper
    /// preserves that invariant in the global table by skipping the free list
    /// when it can't supply two consecutive slots.
    pub fn alloc_pair(&mut self, first: PipeBuffer, second: PipeBuffer) -> (usize, usize) {
        // Try to find two consecutive freed slots in the free_list. The free
        // list is a Vec of indices; sort a copy and scan for adjacent pairs.
        if self.free_list.len() >= 2 {
            let mut sorted = self.free_list.clone();
            sorted.sort_unstable();
            for w in sorted.windows(2) {
                if w[1] == w[0] + 1 {
                    let a = w[0];
                    let b = w[1];
                    self.free_list.retain(|&x| x != a && x != b);
                    let mut p1 = first;
                    p1.pipe_idx = a as u32;
                    self.pipes[a] = Some(p1);
                    let mut p2 = second;
                    p2.pipe_idx = b as u32;
                    self.pipes[b] = Some(p2);
                    return (a, b);
                }
            }
        }
        // No consecutive freed pair — append both to the tail.
        let a = self.pipes.len();
        let b = a + 1;
        let mut p1 = first;
        p1.pipe_idx = a as u32;
        self.pipes.push(Some(p1));
        let mut p2 = second;
        p2.pipe_idx = b as u32;
        self.pipes.push(Some(p2));
        (a, b)
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
        fds: Vec<InFlightFd>,
    ) -> Result<usize, Errno> {
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
        self.free_list.push(idx);
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
        let mut dropped = Vec::new();
        for pipe in self.pipes.iter_mut().flatten() {
            if !pipe.has_external_reader() {
                dropped.extend(pipe.ancillary_fds.drain(..));
            }
        }
        for batch in dropped {
            #[cfg(test)]
            for fd in &batch.fds {
                if !fd.owns_reference {
                    self.release_ancillary_resource_inner(fd);
                }
            }
            drop(batch);
        }
    }

    /// Release both endpoints of a newly allocated buffer that was never
    /// published to a socket or host bridge, then make its slot reusable.
    pub fn discard_unclaimed(&mut self, idx: usize) {
        if let Some(pipe) = self.get_mut(idx) {
            pipe.close_read_end();
            pipe.close_write_end();
        }
        self.free_if_closed(idx);
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

    pub fn cancel_fifo_opens_for_process(&mut self, pid: u32) -> Vec<FifoOpenWaiter> {
        let mut cancelled = Vec::new();
        for idx in 0..self.pipes.len() {
            if let Some(pipe) = self.get_mut(idx) {
                if pipe.is_fifo() {
                    cancelled.extend(pipe.cancel_fifo_opens_for_process(pid));
                }
            }
            self.free_if_closed(idx);
        }
        cancelled
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
    fn fifo_reader_observes_writer_close_before_open_resumes() {
        let mut pipe = PipeBuffer::new_fifo(DEFAULT_PIPE_CAPACITY, fifo_metadata());
        assert!(pipe.reserve_fifo_open(1, FifoOpenSide::Reader, b"/tmp/fifo".to_vec(), 0, 0, 3,));

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
            assert!(pipe.reserve_fifo_open(
                owner,
                FifoOpenSide::Reader,
                b"/tmp/fifo".to_vec(),
                0,
                0,
                owner as i32 + 3,
            ));
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
