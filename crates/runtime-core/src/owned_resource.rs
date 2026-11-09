//! Exact driver resources and their once-only operation receipts.
//!
//! A numeric fd can be closed and reused while C still retains a context/image.
//! These capabilities own explicit OFD references and, for imported images,
//! independent BO references. A clone of an Rc sidecar is not such ownership:
//! final DRM release effects run only through the ordinary full OFD cleanup.

extern crate alloc;
use crate::lock::OfdId;
use alloc::vec::Vec;
use core::sync::atomic::{AtomicU32, Ordering};
use wasm_posix_shared::{Errno, dri_owned::Packet};

// Only logical BO capabilities own public-name custody. Pending work holds
// storage separately: it must survive deletion without keeping the name live.
struct NameCustody {
    file: OfdId,
    handle: u32,
    bo: u32,
    caps: u32,
    owns_name: bool,
}
#[cfg(not(test))]
// The kernel entry/GKL serializes this cold registry; native callbacks do
// not re-enter resource admission. GPU work never mutates these Rust names.
struct Names(core::cell::RefCell<Vec<NameCustody>>);
#[cfg(not(test))]
unsafe impl Sync for Names {}
#[cfg(not(test))]
static NAMES: Names = Names(core::cell::RefCell::new(Vec::new()));
#[cfg(test)]
std::thread_local! {static NAMES:core::cell::RefCell<Vec<NameCustody>>=const {core::cell::RefCell::new(Vec::new())};}
fn with_names<T>(f: impl FnOnce(&mut Vec<NameCustody>) -> T) -> T {
    #[cfg(not(test))]
    {
        f(&mut NAMES.0.borrow_mut())
    }
    #[cfg(test)]
    {
        NAMES.with(|names| f(&mut names.borrow_mut()))
    }
}
pub(crate) fn reserve_name_custody() -> Result<(), Errno> {
    with_names(|names| names.try_reserve(1).map_err(|_| Errno::ENOMEM))
}
pub(crate) fn capture_name_custody(kind: Kind) -> Result<(), Errno> {
    let Kind::Bo {
        file,
        handle,
        bo,
        owns_handle,
    } = kind
    else {
        return Ok(());
    };
    with_names(|names| {
        if let Some(name) = names
            .iter_mut()
            .find(|n| n.file == file.id && n.handle == handle && n.bo == bo)
        {
            name.caps = name.caps.checked_add(1).ok_or(Errno::EOVERFLOW)?;
            name.owns_name |= owns_handle;
        } else {
            names.push(NameCustody {
                file: file.id,
                handle,
                bo,
                caps: 1,
                owns_name: owns_handle,
            });
        }
        Ok(())
    })
}
/// Retire one logical capability, across process boundaries. Exit drops its
/// custody without inventing GEM_CLOSE calls against a namespace a child
/// can still own through an ordinary fd. Explicit final close may retire it.
pub(crate) fn retire_name_custody(kind: Kind, explicit: bool) -> bool {
    let Kind::Bo {
        file, handle, bo, ..
    } = kind
    else {
        return false;
    };
    with_names(|names| {
        let index = names
            .iter()
            .position(|n| n.file == file.id && n.handle == handle && n.bo == bo)
            .expect("logical BO cap lost its exact namespace custody");
        let name = &mut names[index];
        assert!(name.caps > 0);
        name.caps -= 1;
        if name.caps != 0 {
            return false;
        }
        let close = explicit && name.owns_name;
        names.swap_remove(index);
        close
    })
}

static LAST_TOKEN: AtomicU32 = AtomicU32::new(0);
pub(crate) fn next_token() -> Result<u32, Errno> {
    LAST_TOKEN
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |last| {
            last.checked_add(1)
        })
        .map(|previous| previous + 1)
        .map_err(|_| Errno::ENOMEM)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub index: usize,
    pub id: OfdId,
    pub original_fd: i32,
    pub session: Option<u32>,
    pub context: Option<u32>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    File(Target),
    Bo {
        file: Target,
        handle: u32,
        bo: u32,
        owns_handle: bool,
    },
}
impl Kind {
    pub(crate) fn target(self) -> Target {
        match self {
            Self::File(target) | Self::Bo { file: target, .. } => target,
        }
    }
}

pub(crate) struct Receipt {
    pub request: Packet,
    pub response: Packet,
    pub complete: bool,
    pub source: Option<Kind>,
    pub bindings: [Option<crate::syscalls::BoBinding>; 4],
    pub running: bool,
    pub creator_tid: u32,
    pub published_fd: Option<(i32, OfdId)>,
    pub deadline_ns: Option<i64>,
    pub awaiting_mapping_finish: bool,
    pub mapping_finish_errno: Option<u32>,
    pub mapping_plan: Option<crate::syscalls::OwnedMappingPlan>,
}
pub(crate) struct Resource {
    pub token: u32,
    pub pid: u32,
    pub generation: u64,
    /// None only after its exact release; keep the immutable receipt until ACK.
    pub kind: Option<Kind>,
    pub last_transaction: u64,
    pub borrowed_alias: Option<(i32, OfdId)>,
    pub receipt: Option<Receipt>,
}
pub(crate) struct Creation {
    pub nonce: u64,
    pub receipt: Receipt,
}
#[derive(Default)]
pub(crate) struct State {
    pub resources: Vec<Resource>,
    pub creations: Vec<Creation>,
}
impl State {
    pub fn index(&self, token: u32, pid: u32, generation: u64) -> Result<usize, Errno> {
        let index = self
            .resources
            .iter()
            .position(|r| r.token == token)
            .ok_or(Errno::EBADF)?;
        let record = &self.resources[index];
        if record.pid != pid || record.generation != generation {
            return Err(Errno::EACCES);
        }
        Ok(index)
    }
    pub fn target(&self, token: u32, pid: u32, generation: u64) -> Result<Target, Errno> {
        self.resources[self.index(token, pid, generation)?]
            .kind
            .map(Kind::target)
            .ok_or(Errno::EBADF)
    }
}

use crate::lock::AdvisoryLockManager;
use crate::process::{HostIO, Process};
use wasm_posix_shared::dri_owned as W;

fn read_packet(bytes: &[u8]) -> Result<Packet, Errno> {
    if bytes.len() != core::mem::size_of::<Packet>() {
        return Err(Errno::EINVAL);
    }
    Ok(unsafe { core::ptr::read_unaligned(bytes.as_ptr().cast()) })
}
fn write_packet(bytes: &mut [u8], packet: Packet) {
    unsafe { core::ptr::write_unaligned(bytes.as_mut_ptr().cast(), packet) };
}
fn completed(mut packet: Packet, result: Result<(), Errno>) -> Packet {
    packet.state = W::COMPLETE;
    packet.magic = W::MAGIC;
    packet.result = match result {
        Ok(()) => 0,
        Err(error) => -(error as i32),
    };
    packet
}
fn validate_new(packet: &Packet) -> Result<(), Errno> {
    if packet.version != W::VERSION
        || packet.transaction == 0
        || packet.result != 0
        || packet.state != 0
        || packet.magic != 0
        || packet.reserved != 0
        || packet.length as usize > W::BODY_BYTES
        || packet.body[packet.length as usize..]
            .iter()
            .any(|&b| b != 0)
    {
        return Err(Errno::EINVAL);
    }
    match packet.action {
        W::OPEN
            if packet.token == 0
                && packet.source_token == 0
                && packet.fd == -1
                && packet.length == 0
                && matches!(packet.request, W::NODE_RENDER | W::NODE_CARD)
                && packet.flags == 0 => {}
        W::ACQUIRE
            if packet.token == 0
                && packet.source_token == 0
                && packet.fd >= 0
                && packet.request == 0
                && packet.length == 0
                && packet.flags & !(W::CONSUME_FD | W::EXPECT_SYNC_FILE) == 0 => {}
        W::IOCTL
            if packet.token != 0
                && packet.fd == -1
                && packet.request != W::REQUEST
                && packet.flags & !(W::CAPTURE_FD | W::CAPTURE_BO | W::BO_BINDINGS) == 0
                && packet.flags & (W::CAPTURE_FD | W::CAPTURE_BO)
                    != (W::CAPTURE_FD | W::CAPTURE_BO) => {}
        W::MMAP
            if packet.token != 0
                && packet.fd == -1
                && packet.request == 0
                && packet.length == 32
                && packet.flags == 0 => {}
        W::MMAP_EXACT
            if packet.token != 0 && packet.fd == -1 && packet.request == 0
                && packet.length == 40 && packet.flags == 0
                && packet.body[32..40].iter().all(|byte| *byte == 0) => {}
        W::UNMAP_EXACT
            if packet.token != 0 && packet.fd == -1 && packet.request == 0
                && packet.length == 8 && packet.flags == 0 => {}
        W::RELEASE | W::BO_RELEASE
            if packet.token != 0
                && packet.source_token == 0
                && packet.fd == -1
                && packet.request == 0
                && packet.length == 0
                && packet.flags == 0 => {}
        W::POLL
            if packet.token != 0
                && packet.source_token == 0
                && packet.fd == -1
                && packet.request == 0
                && packet.length == 16
                && packet.flags == 0
                && packet.body[4..8].iter().all(|&b| b == 0)
                && packet.body[12..16].iter().all(|&b| b == 0)
                && u32::from_le_bytes(packet.body[..4].try_into().unwrap()) <= u16::MAX as u32 => {}
        W::BO_INFO
            if packet.token != 0
                && packet.source_token == 0
                && packet.fd == -1
                && packet.request == 0
                && packet.length == 32
                && packet.flags == 0
                && packet.body.iter().all(|&b| b == 0) => {}
        W::DUP_FD
            if packet.token != 0
                && packet.source_token == 0
                && packet.fd >= -1
                && packet.request == 0
                && packet.length == 0
                && packet.flags
                    & !(W::REUSE_EXACT | W::BORROW_ALIAS | wasm_posix_shared::flags::O_CLOEXEC)
                    == 0 => {}
        _ => return Err(Errno::EINVAL),
    }
    Ok(())
}
fn published_alias_live(proc: &Process, proof: Option<(i32, OfdId)>) -> bool {
    proof.is_none_or(|(fd, id)| {
        proc.fd_table
            .get(fd)
            .ok()
            .and_then(|entry| proc.ofd_table.get(entry.ofd_ref.0))
            .is_some_and(|ofd| ofd.ofd_id == id)
    })
}
fn receipt_response(
    proc: &Process,
    host: &mut dyn HostIO,
    receipt: &Receipt,
) -> Result<Packet, Errno> {
    let mut response = receipt.response;
    // WHY: execution history is immutable, but a public result fd can have
    // been closed/reused before recovery. Never return the replacement or
    // allocate again; known completion remains distinct from publication.
    if receipt.complete && !published_alias_live(proc, receipt.published_fd) {
        response.result = -(Errno::EBADF as i32);
    }
    if !receipt.complete && receipt.request.action == W::POLL {
        response.body[12..16]
            .copy_from_slice(&remaining_ms(host, receipt.deadline_ns)?.to_le_bytes());
    }
    Ok(response)
}
pub(crate) fn remaining_ms(host: &mut dyn HostIO, deadline: Option<i64>) -> Result<i32, Errno> {
    let Some(deadline) = deadline else {
        return Ok(-1);
    };
    let now = crate::dri::sync_file::monotonic_now(host)?;
    let left = deadline.saturating_sub(now).max(0);
    Ok(((left.saturating_add(999_999) / 1_000_000)
        .max(1)
        .min(i64::from(i32::MAX))) as i32)
}
fn cancel_poll(receipt: &mut Receipt) {
    receipt.complete = true;
    receipt.running = false;
    receipt.response.state = W::COMPLETE;
    receipt.response.result = -(Errno::EINTR as i32);
    receipt.response.magic = W::MAGIC;
    receipt.response.body[12..16].fill(0);
}
/// A dying TID can no longer resume its poll. Preserve a terminal receipt so
/// a peer doing cancellation cleanup can release the owner after lost replies.
pub(crate) fn cancel_thread_polls(proc: &mut Process, tid: u32) -> bool {
    let mut cancelled = false;
    for resource in &mut proc.owned_resources.resources {
        if let Some(receipt) = &mut resource.receipt {
            if receipt.creator_tid == tid && !receipt.complete && receipt.request.action == W::POLL
            {
                cancel_poll(receipt);
                cancelled = true;
            }
        }
    }
    cancelled
}
fn poll_retry_matches(receipt: &Receipt, mut request: Packet) -> bool {
    if receipt.request.action != W::POLL {
        return false;
    }
    request.state = 0;
    request.result = 0;
    request.magic = 0;
    request.body[4..8].fill(0);
    request.body[12..16].fill(0);
    request == receipt.request
}
fn source_kind(proc: &Process, token: u32) -> Result<Option<Kind>, Errno> {
    if token == 0 {
        return Ok(None);
    }
    let index = proc
        .owned_resources
        .index(token, proc.pid, proc.exec_generation)?;
    proc.owned_resources.resources[index]
        .kind
        .map(Some)
        .ok_or(Errno::EBADF)
}

/// Entry is reached only for this new request. Negative legacy descriptors
/// retain their ordinary EBADF behavior; they are never capability integers.
pub(crate) fn ioctl(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
    fd: i32,
    bytes: &mut [u8],
) -> Result<(), Errno> {
    if fd != -1 {
        return Err(Errno::EBADF);
    }
    let request = read_packet(bytes)?;
    if request.version != W::VERSION || request.reserved != 0 || request.transaction == 0 {
        return Err(Errno::EINVAL);
    }
    if request.action == W::READ_LAST {
        let receipt = if request.token == 0 {
            proc.owned_resources
                .creations
                .iter()
                .find(|c| c.nonce == request.transaction)
                .map(|c| &c.receipt)
        } else {
            proc.owned_resources
                .index(request.token, proc.pid, proc.exec_generation)
                .ok()
                .and_then(|i| proc.owned_resources.resources[i].receipt.as_ref())
                .filter(|receipt| receipt.request.transaction == request.transaction)
        };
        let response = match receipt {
            Some(receipt) => receipt_response(proc, host, receipt)?,
            None => {
                let mut absent = request;
                absent.state = W::ABSENT;
                absent.magic = W::MAGIC;
                absent.result = -(Errno::ENOENT as i32);
                absent
            }
        };
        write_packet(bytes, response);
        return Ok(());
    }
    if request.action == W::CANCEL_POLL {
        if request.token == 0
            || request.source_token != 0
            || request.fd != -1
            || request.request != 0
            || request.length != 0
            || request.flags != 0
            || request.result != 0
            || request.state != 0
            || request.magic != 0
            || request.acknowledge != 0
            || request.body.iter().any(|&b| b != 0)
        {
            return Err(Errno::EINVAL);
        }
        let index = proc
            .owned_resources
            .index(request.token, proc.pid, proc.exec_generation)?;
        let receipt = proc.owned_resources.resources[index].receipt.as_ref();
        if receipt.is_none_or(|r| r.request.transaction != request.transaction) {
            let mut absent = request;
            absent.state = W::ABSENT;
            absent.magic = W::MAGIC;
            absent.result = -(Errno::ENOENT as i32);
            write_packet(bytes, absent);
            return Ok(());
        }
        let receipt = receipt.unwrap();
        if receipt.request.action != W::POLL {
            return Err(Errno::EINVAL);
        }
        if !receipt.complete {
            if receipt.running
                || receipt.creator_tid != crate::syscalls::current_tid_for_process(proc)
            {
                return Err(Errno::EBUSY);
            }
            cancel_poll(
                proc.owned_resources.resources[index]
                    .receipt
                    .as_mut()
                    .unwrap(),
            );
        }
        write_packet(
            bytes,
            receipt_response(
                proc,
                host,
                proc.owned_resources.resources[index]
                    .receipt
                    .as_ref()
                    .unwrap(),
            )?,
        );
        return Ok(());
    }
    if request.action == W::ACK {
        if request.length != 0
            || request.flags != 0
            || request.source_token != 0
            || request.fd != -1
            || request.request != 0
            || request.result != 0
            || request.state != 0
            || request.magic != 0
            || request.body.iter().any(|&b| b != 0)
        {
            return Err(Errno::EINVAL);
        }
        if request.token == 0 {
            if let Some(index) = proc
                .owned_resources
                .creations
                .iter()
                .position(|c| c.nonce == request.transaction)
            {
                if !proc.owned_resources.creations[index].receipt.complete {
                    return Err(Errno::EBUSY);
                }
                proc.owned_resources.creations.swap_remove(index);
            }
        } else if let Ok(index) =
            proc.owned_resources
                .index(request.token, proc.pid, proc.exec_generation)
        {
            let resource = &mut proc.owned_resources.resources[index];
            if let Some(receipt) = &resource.receipt {
                if receipt.request.transaction != request.transaction || !receipt.complete {
                    return Err(Errno::EBUSY);
                }
            } else if resource.last_transaction != request.transaction {
                return Err(Errno::EINVAL);
            }
            resource.receipt = None;
            if resource.kind.is_none() {
                proc.owned_resources.resources.swap_remove(index);
            }
        }
        write_packet(bytes, completed(request, Ok(())));
        return Ok(());
    }
    if matches!(request.action, W::OPEN | W::ACQUIRE) {
        if let Some(existing) = proc
            .owned_resources
            .creations
            .iter()
            .find(|c| c.nonce == request.transaction)
        {
            if existing.receipt.request != request {
                return Err(Errno::EALREADY);
            }
            write_packet(bytes, receipt_response(proc, host, &existing.receipt)?);
            return Ok(());
        }
        validate_new(&request)?;
        proc.owned_resources
            .creations
            .try_reserve(1)
            .map_err(|_| Errno::ENOMEM)?;
        proc.owned_resources
            .resources
            .try_reserve(1)
            .map_err(|_| Errno::ENOMEM)?;
        let token = next_token()?;
        let index = proc.owned_resources.creations.len();
        let mut pending = request;
        pending.state = W::PENDING;
        pending.magic = W::MAGIC;
        proc.owned_resources.creations.push(Creation {
            nonce: request.transaction,
            receipt: Receipt {
                request,
                response: pending,
                complete: false,
                source: None,
                bindings: [None; 4],
                running: true,
                creator_tid: crate::syscalls::current_tid_for_process(proc),
                published_fd: None,
                deadline_ns: None,
                awaiting_mapping_finish: false,
                mapping_finish_errno: None,
                mapping_plan: None,
            },
        });
        let mut response = request;
        let captured = crate::syscalls::owned_resource_capture_file(proc, locks, host, &request);
        let result = match captured {
            Ok((target, close_result)) => {
                proc.owned_resources.resources.push(Resource {
                    token,
                    pid: proc.pid,
                    generation: proc.exec_generation,
                    kind: Some(Kind::File(target)),
                    last_transaction: 0,
                    receipt: None,
                    borrowed_alias: None,
                });
                response.token = token;
                close_result
            }
            Err(error) => Err(error),
        };
        response = completed(response, result);
        let receipt = &mut proc.owned_resources.creations[index].receipt;
        receipt.response = response;
        receipt.complete = true;
        receipt.running = false;
        write_packet(bytes, response);
        return Ok(());
    }
    let index = proc
        .owned_resources
        .index(request.token, proc.pid, proc.exec_generation)?;
    let duplicate = proc.owned_resources.resources[index]
        .receipt
        .as_ref()
        .is_some_and(|receipt| receipt.request.transaction == request.transaction);
    if duplicate {
        let receipt = proc.owned_resources.resources[index]
            .receipt
            .as_ref()
            .unwrap();
        if receipt.complete {
            if receipt.request != request && !poll_retry_matches(receipt, request) {
                return Err(Errno::EALREADY);
            }
            write_packet(bytes, receipt_response(proc, host, receipt)?);
            return Ok(());
        }
        if receipt.request != request
            && receipt.response != request
            && !poll_retry_matches(receipt, request)
        {
            return Err(Errno::EALREADY);
        }
        if receipt.awaiting_mapping_finish {
            write_packet(bytes, receipt_response(proc, host, receipt)?);
            return Ok(());
        }
        if receipt.running || receipt.creator_tid != crate::syscalls::current_tid_for_process(proc)
        {
            return Err(Errno::EBUSY);
        }
        // A host EAGAIN retry continues the exact frozen kernel operation.
        // It is not authorization to replay an unknown native side effect.
    } else {
        validate_new(&request)?;
        let resource = &proc.owned_resources.resources[index];
        if resource.kind.is_none() || request.transaction <= resource.last_transaction {
            return Err(Errno::EBADF);
        }
        if let Some(receipt) = &resource.receipt {
            if !receipt.complete || request.acknowledge != resource.last_transaction {
                return Err(Errno::EBUSY);
            }
        } else if request.acknowledge != 0 && request.acknowledge != resource.last_transaction {
            return Err(Errno::EINVAL);
        }
        let kind = resource.kind.ok_or(Errno::EBADF)?;
        let deadline_ns = if request.action == W::POLL {
            let timeout = i32::from_le_bytes(request.body[8..12].try_into().unwrap());
            if timeout > 0 {
                Some(
                    crate::dri::sync_file::monotonic_now(host)?
                        .checked_add(i64::from(timeout) * 1_000_000)
                        .ok_or(Errno::EOVERFLOW)?,
                )
            } else {
                None
            }
        } else {
            None
        };
        let bindings = if request.action == W::IOCTL {
            crate::syscalls::owned_resource_operands(proc, kind, &request)?.0
        } else {
            [None; 4]
        };
        let source = source_kind(proc, request.source_token)?;
        if let Some(kind) = source {
            crate::syscalls::owned_resource_retain_kind(proc, kind)?;
        }
        let mut retained = 0;
        for binding in bindings.into_iter().flatten() {
            if let Err(error) = crate::syscalls::owned_resource_retain_kind(proc, binding.kind) {
                for prior in bindings.into_iter().flatten().take(retained) {
                    crate::syscalls::owned_resource_release_kind(
                        proc, locks, host, prior.kind, false,
                    )?;
                }
                if let Some(kind) = source {
                    crate::syscalls::owned_resource_release_kind(proc, locks, host, kind, false)?;
                }
                return Err(error);
            }
            retained += 1;
        }
        let mut pending = request;
        pending.state = W::PENDING;
        pending.magic = W::MAGIC;
        let tid = crate::syscalls::current_tid_for_process(proc);
        let resource = &mut proc.owned_resources.resources[index];
        resource.last_transaction = request.transaction;
        resource.receipt = Some(Receipt {
            request,
            response: pending,
            complete: false,
            source,
            bindings,
            running: false,
            creator_tid: tid,
            published_fd: None,
            deadline_ns,
            awaiting_mapping_finish: false,
            mapping_finish_errno: None,
            mapping_plan: None,
        });
    }
    let (kind, source, bindings, deadline_ns, mut working) = {
        let resource = &mut proc.owned_resources.resources[index];
        let kind = resource.kind.ok_or(Errno::EBADF)?;
        let receipt = resource.receipt.as_mut().unwrap();
        receipt.running = true;
        (
            kind,
            receipt.source,
            receipt.bindings,
            receipt.deadline_ns,
            receipt.response,
        )
    };
    // Strip transport output metadata; the immutable original request remains
    // separate from the working ioctl buffer retained through blocking retries.
    working.state = 0;
    working.result = 0;
    working.magic = 0;
    let mut published_fd = None;
    let mut mapping_plan = None;
    // Input source authority is already retained in receipt.source. A failed
    // capture must not mislabel that FILE token as a newly created BO token.
    if working.action == W::IOCTL && working.flags & (W::CAPTURE_FD | W::CAPTURE_BO) != 0 {
        working.source_token = 0;
    }
    let result = match working.action {
        W::IOCTL => crate::syscalls::owned_resource_dispatch(
            proc,
            locks,
            host,
            kind,
            source,
            bindings,
            &mut working,
            &mut published_fd,
        ),
        W::POLL => {
            crate::syscalls::owned_resource_poll(proc, host, kind, deadline_ns, &mut working)
        }
        W::BO_INFO => crate::syscalls::owned_resource_bo_info(proc, kind, &mut working),
        W::MMAP | W::MMAP_EXACT => match crate::syscalls::owned_resource_prepare_mmap(proc, kind, source, &working)
        {
            Ok(plan) => {
                working.body[..8].copy_from_slice(&(plan.addr() as u64).to_le_bytes());
                if let Some(identity) = plan.identity() {
                    working.body[32..40].copy_from_slice(&identity.id.to_le_bytes());
                }
                mapping_plan = Some(plan);
                Ok(())
            }
            Err(error) => Err(error),
        },
        W::UNMAP_EXACT => crate::syscalls::owned_resource_unmap_exact(proc, host, kind, source, &working),
        W::DUP_FD => {
            crate::syscalls::owned_resource_duplicate(proc, kind, &mut working, &mut published_fd)
        }
        W::RELEASE | W::BO_RELEASE => {
            if matches!(
                (working.action, kind),
                (W::RELEASE, Kind::Bo { .. }) | (W::BO_RELEASE, Kind::File(_))
            ) {
                Err(Errno::EINVAL)
            } else {
                // Consume logical ownership before final-close effects. A fatal
                // native cleanup fault must never authorize a second decref.
                crate::syscalls::owned_resource_validate(proc, kind.target())?;
                let alias = proc.owned_resources.resources[index].borrowed_alias.take();
                proc.owned_resources.resources[index].kind = None;
                working.source_token = 1;
                let alias_result = if let Some((fd, id)) = alias {
                    if published_alias_live(proc, Some((fd, id))) {
                        crate::syscalls::sys_close_implicit_with_locks(proc, locks, host, fd)
                    } else {
                        Ok(())
                    }
                } else {
                    Ok(())
                };
                let release =
                    crate::syscalls::owned_resource_release_kind(proc, locks, host, kind, true);
                alias_result.and(release)
            }
        }
        _ => Err(Errno::EINVAL),
    };
    let mapping_pending = matches!(working.action, W::MMAP | W::MMAP_EXACT) && result.is_ok();
    let pending = matches!(result, Err(Errno::EAGAIN))
        && matches!(working.action, W::IOCTL | W::POLL | W::MMAP | W::MMAP_EXACT);
    if pending || mapping_pending {
        working.state = W::PENDING;
        working.result = if mapping_pending {
            0
        } else {
            -(Errno::EAGAIN as i32)
        };
        working.magic = W::MAGIC;
    } else {
        let scalar_result = working.result;
        working = completed(working, result);
        if working.result == 0 {
            working.result = scalar_result;
        }
    }
    let source_to_release = {
        let receipt = proc.owned_resources.resources[index]
            .receipt
            .as_mut()
            .unwrap();
        receipt.response = working;
        receipt.complete = !pending && !mapping_pending;
        receipt.awaiting_mapping_finish = mapping_pending;
        receipt.mapping_plan = mapping_plan;
        receipt.running = false;
        receipt.published_fd = published_fd;
        if pending || mapping_pending {
            None
        } else {
            receipt.source.take()
        }
    };
    if let Some(kind) = source_to_release {
        crate::syscalls::owned_resource_release_kind(proc, locks, host, kind, false)?;
    }
    if !pending && !mapping_pending {
        let bindings = core::mem::take(
            &mut proc.owned_resources.resources[index]
                .receipt
                .as_mut()
                .unwrap()
                .bindings,
        );
        for binding in bindings.into_iter().flatten() {
            crate::syscalls::owned_resource_release_kind(proc, locks, host, binding.kind, false)?;
        }
    }
    write_packet(bytes, working);
    if pending { Err(Errno::EAGAIN) } else { Ok(()) }
}

/// Staging owns only the additional independent BO/name references. OFDs have
/// not acquired machine backings yet; dropping the unpublished child table
/// simply drops its cloned sidecars, while the live parent retains originals.
pub(crate) struct ForkInheritance {
    resources: Vec<Resource>,
    creations: Vec<Creation>,
}
impl Drop for ForkInheritance {
    fn drop(&mut self) {
        for resource in &self.resources {
            if let Some(kind @ Kind::Bo { bo, .. }) = resource.kind {
                retire_name_custody(kind, false);
                assert!(
                    crate::dri::with_registry(|r| r.decref(bo)).is_some_and(|left| left > 0),
                    "fork rollback lost parent's storage custody"
                );
            }
        }
    }
}
impl ForkInheritance {
    pub(crate) fn commit(mut self) -> State {
        State {
            resources: core::mem::take(&mut self.resources),
            creations: core::mem::take(&mut self.creations),
        }
    }
}
fn fork_receipt(receipt: &Receipt, child_pid: u32) -> Receipt {
    let mut copy = Receipt {
        request: receipt.request,
        response: receipt.response,
        complete: receipt.complete,
        source: None,
        bindings: [None; 4],
        running: false,
        creator_tid: child_pid,
        published_fd: receipt.published_fd,
        deadline_ns: None,
        awaiting_mapping_finish: false,
        mapping_finish_errno: receipt.mapping_finish_errno,
        mapping_plan: None,
    };
    // Receipts are copied bytes, not shared transactions. Already-created or
    // consumed custody remains visible, but a parent's pending execution and
    // temporary operand pins must never run in the child or be replayed there.
    copy.source = None;
    copy.bindings = [None; 4];
    copy.running = false;
    copy.creator_tid = child_pid;
    copy.deadline_ns = None;
    if !copy.complete {
        copy.complete = true;
        copy.response = completed(copy.response, Err(Errno::EINTR));
        if copy.request.action == W::POLL {
            copy.response.body[12..16].fill(0);
        }
        if copy.request.action == W::IOCTL
            && copy.request.flags & (W::CAPTURE_FD | W::CAPTURE_BO) != 0
            && copy.response.source_token == copy.request.source_token
        {
            copy.response.source_token = 0;
        }
    }
    copy
}
fn fork_kind(kind: Kind) -> Kind {
    let mut target = kind.target();
    target.session = None;
    target.context = None;
    match kind {
        Kind::File(_) => Kind::File(target),
        Kind::Bo {
            handle,
            bo,
            owns_handle,
            ..
        } => Kind::Bo {
            file: target,
            handle,
            bo,
            owns_handle,
        },
    }
}
pub(crate) fn prepare_fork(
    parent: &Process,
    child: &mut Process,
) -> Result<ForkInheritance, Errno> {
    if has_pending_mapping(parent) {
        return Err(Errno::EBUSY);
    }
    let mut inherited = ForkInheritance {
        resources: Vec::new(),
        creations: Vec::new(),
    };
    inherited
        .resources
        .try_reserve_exact(parent.owned_resources.resources.len())
        .map_err(|_| Errno::ENOMEM)?;
    inherited
        .creations
        .try_reserve_exact(parent.owned_resources.creations.len())
        .map_err(|_| Errno::ENOMEM)?;
    for resource in &parent.owned_resources.resources {
        let kind = resource.kind.map(fork_kind);
        if let Some(kind) = kind {
            if matches!(kind, Kind::Bo { .. }) {
                reserve_name_custody()?;
            }
            child
                .ofd_table
                .retain_graphics_fork_target(&parent.ofd_table, kind.target())?;
            if let Kind::Bo { bo, .. } = kind {
                crate::dri::with_registry(|r| r.incref(bo)).ok_or(Errno::EOVERFLOW)?;
                if let Err(error) = capture_name_custody(kind) {
                    crate::dri::with_registry(|r| r.decref(bo));
                    return Err(error);
                }
            }
        }
        let borrowed_alias = resource
            .borrowed_alias
            .filter(|proof| published_alias_live(child, Some(*proof)));
        inherited.resources.push(Resource {
            token: resource.token,
            pid: child.pid,
            generation: child.exec_generation,
            kind,
            last_transaction: resource.last_transaction,
            borrowed_alias,
            receipt: resource
                .receipt
                .as_ref()
                .map(|receipt| fork_receipt(receipt, child.pid)),
        });
    }
    for creation in &parent.owned_resources.creations {
        inherited.creations.push(Creation {
            nonce: creation.nonce,
            receipt: fork_receipt(&creation.receipt, child.pid),
        });
    }
    Ok(inherited)
}

/// Host construction must finish before the entry lease releases or any
/// guest success is published. Token/transaction owns the reserved interval;
/// READ_LAST is read-only and never grows, zeroes, rebinds or re-primes it.
pub(crate) fn has_pending_mapping(proc: &Process) -> bool {
    proc.owned_resources.resources.iter().any(|r| {
        r.receipt
            .as_ref()
            .is_some_and(|r| r.awaiting_mapping_finish)
    })
}
pub(crate) fn finish_mapping(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
    tid: u32,
    token: u32,
    transaction: u64,
    errno: u32,
) -> Result<(), Errno> {
    if errno != 0 && errno != Errno::ENOMEM as u32 && errno != Errno::EIO as u32 {
        return Err(Errno::EINVAL);
    }
    let index = proc
        .owned_resources
        .index(token, proc.pid, proc.exec_generation)?;
    let receipt = proc.owned_resources.resources[index]
        .receipt
        .as_ref()
        .ok_or(Errno::ENOENT)?;
    if !matches!(receipt.request.action, W::MMAP | W::MMAP_EXACT)
        || receipt.request.transaction != transaction
        || receipt.creator_tid != tid
    {
        return Err(Errno::EACCES);
    }
    if let Some(known) = receipt.mapping_finish_errno {
        return if known == errno {
            Ok(())
        } else {
            Err(Errno::EALREADY)
        };
    }
    if !receipt.awaiting_mapping_finish || receipt.complete || receipt.running {
        return Err(Errno::EINVAL);
    }
    let plan = proc.owned_resources.resources[index]
        .receipt
        .as_mut()
        .unwrap()
        .mapping_plan
        .take()
        .ok_or(Errno::EIO)?;
    // Only this exact host constructor can consume the plan. The adapter
    // keeps its entry lease through grow/old-view flush, native commit and
    // initial zero/prime; another guest entry cannot observe this interval.
    proc.owned_resources.resources[index]
        .receipt
        .as_mut()
        .unwrap()
        .awaiting_mapping_finish = false;
    let result = if errno == 0 {
        plan.commit(proc, host).map(|_| ())
    } else {
        plan.rollback(proc);
        Err(Errno::from_u32(errno).expect("validated mapping construction errno"))
    };
    let receipt = proc.owned_resources.resources[index]
        .receipt
        .as_mut()
        .unwrap();
    receipt.mapping_finish_errno = Some(errno);
    receipt.complete = true;
    receipt.response = completed(receipt.response, result);
    let source = receipt.source.take();
    let bindings = core::mem::take(&mut receipt.bindings);
    if let Some(kind) = source {
        crate::syscalls::owned_resource_release_kind(proc, locks, host, kind, false)?;
    }
    for binding in bindings.into_iter().flatten() {
        crate::syscalls::owned_resource_release_kind(proc, locks, host, binding.kind, false)?;
    }
    Ok(())
}
