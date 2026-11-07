//! Implicit synchronization of GL work with a dma-buf's fences.
//!
//! # What Linux does
//!
//! A GPU driver adds every buffer a job reads or writes to the job's
//! dependencies: the job waits for the buffer's writers (to read it) or for
//! all its fences (to write it) before it runs, in the GPU scheduler. That is
//! what lets a producer import its render-complete fence into a dma-buf
//! (`DMA_BUF_IOCTL_IMPORT_SYNC_FILE`) and a consumer sample the buffer with no
//! explicit synchronization of its own.
//!
//! # Why Kandelo waits before the GL work instead
//!
//! Kandelo's GL runs synchronously: `host_gl_submit` executes a command buffer
//! before the ioctl returns, so there is no queue in which a job could wait.
//! Deferring the work is not truthful either: the host reads the commands
//! from the guest's own command buffer, and every later command of the
//! session, query and presentation depends on it. So the GL entry points that
//! can read or write buffer contents (command and query submission,
//! presentation, image import, foreign-texture upload, image export) wait
//! *before* reaching the host, until the fences of every buffer the process
//! can name through its DRM files have signaled. Once they pass, nothing
//! the host executes can observe a buffer its writers have not finished, and
//! nothing it writes can overtake a reader: that is the ordering implicit
//! sync promises, enforced earlier and at a coarser grain (a process that
//! names a fenced buffer waits even for work that does not touch it, and
//! waits for readers as a writer would, because the kernel cannot see which
//! buffers a command buffer touches).
//!
//! # Why the wait cannot deadlock
//!
//! The only fences that can be pending in production are a GL fence on a
//! separate native context (the host observes its completion; the GL work
//! already ran) and a KMS out-fence (the host's vblank pump completes it).
//! A GL fence on the shared native context is complete in submission order
//! (decision D-17), and sync objects only ever attach signaled stubs. No
//! pending fence therefore depends on the waiting thread, or on any guest
//! thread, to make progress.
//!
//! # Why the wait is uninterruptible
//!
//! On Linux the CPU call never waits at all, so it can never fail with
//! `EINTR`; a GL facade has no way to resubmit a command buffer an
//! interrupted call abandoned. The parked call therefore keeps caught
//! signals pending (`waits_uninterruptibly`, consulted when the kernel
//! dequeues a signal), as the atomic KMS commit tail does; default actions
//! still apply.
//!
//! # Cost
//!
//! While no buffer holds a fence the gate is one integer test
//! (`fence::implicit_fences_exist`), so drawing pays nothing.

extern crate alloc;

use alloc::vec::Vec;
use core::cell::RefCell;

use wasm_posix_shared::Errno;

use super::fence::Fence;
use crate::process::Process;

/// Tasks parked at the gate, as `(pid, tid)`.
#[cfg(not(test))]
struct Waiters(RefCell<Vec<(u32, u32)>>);
#[cfg(not(test))]
unsafe impl Sync for Waiters {}
#[cfg(not(test))]
static WAITERS: Waiters = Waiters(RefCell::new(Vec::new()));
#[cfg(test)]
std::thread_local! {
    static WAITERS: RefCell<Vec<(u32, u32)>> = const { RefCell::new(Vec::new()) };
}

fn with_waiters<R>(f: impl FnOnce(&mut Vec<(u32, u32)>) -> R) -> R {
    #[cfg(not(test))]
    { f(&mut WAITERS.0.borrow_mut()) }
    #[cfg(test)]
    { WAITERS.with(|w| f(&mut w.borrow_mut())) }
}

/// Every unsignaled fence of every buffer the process can name through its
/// DRM files (GEM handles). A PRIME descriptor alone gives GL no access, and
/// CPU mappings are not implicitly synchronized on Linux either.
fn pending_buffer_fences(proc: &Process) -> Vec<Fence> {
    let mut bos: Vec<super::BoId> = Vec::new();
    for (_, ofd) in proc.ofd_table.iter() {
        if let Some(dri) = ofd.dri() {
            bos.extend(dri.gem.borrow().handles.values().copied());
        }
    }
    // Driver capabilities independently retain storage after raw GEM_CLOSE.
    // A parked operation also owns its copied BO proofs after the source C
    // object retires; omitting those holds would bypass its pending writers.
    for resource in &proc.owned_resources.resources {
        let mut add=|kind:crate::owned_resource::Kind| {
            if let crate::owned_resource::Kind::Bo{bo,..}=kind {bos.push(bo);}
        };
        if let Some(kind)=resource.kind {add(kind);}
        if let Some(receipt)=&resource.receipt {
            if let Some(kind)=receipt.source {add(kind);}
            for binding in receipt.bindings.iter().flatten() {add(binding.kind);}
        }
    }
    bos.sort_unstable();
    bos.dedup();
    super::with_registry(|registry| {
        let mut fences = Vec::new();
        for bo in bos {
            if let Some(bo) = registry.get_mut(bo) {
                fences.extend(bo.reservation.wait_set(true));
            }
        }
        fences
    })
}

/// The gate: `Ok` once nothing the GL entry point could touch has a pending
/// fence; otherwise the calling task parks (`EAGAIN`, retried by the host
/// when a fence signals) with its signals held.
pub fn gate(proc: &Process, tid: u32) -> Result<(), Errno> {
    let pid = proc.pid;
    if !super::fence::implicit_fences_exist() {
        // A record left by a call parked earlier ends with it.
        forget_task(pid, tid);
        return Ok(());
    }
    let pending = pending_buffer_fences(proc);
    if pending.is_empty() {
        forget_task(pid, tid);
        return Ok(());
    }
    for fence in &pending {
        // A waiter enables the fence: a host GL source starts being polled.
        fence.enable_signaling();
    }
    with_waiters(|w| {
        if !w.contains(&(pid, tid)) {
            w.push((pid, tid));
        }
    });
    Err(Errno::EAGAIN)
}

/// Whether `tid` is parked at the gate, so a caught signal stays pending.
pub fn waits_uninterruptibly(pid: u32, tid: u32) -> bool {
    with_waiters(|w| w.contains(&(pid, tid)))
}

/// The task is gone (or its call ended): drop its record.
pub fn forget_task(pid: u32, tid: u32) {
    with_waiters(|w| {
        if !w.is_empty() {
            w.retain(|&entry| entry != (pid, tid));
        }
    });
}

/// The process image is gone.
pub fn forget_process(pid: u32) {
    with_waiters(|w| w.retain(|&(p, _)| p != pid));
}
