//! Kernel fence core: Linux's `dma_fence` object model for Kandelo.
//!
//! # Why this exists
//!
//! Explicit synchronization (`sync_file`, DRM sync objects, the dma-buf
//! implicit-fence ioctls, `EGL_ANDROID_native_fence_sync`, KMS in/out
//! fences) is a contract between *independent* programs: a compositor waits
//! on a client's render-complete fence, a client waits on the compositor's
//! release fence. Every one of those interfaces is defined in terms of one
//! kernel object, the fence, and of two derived shapes built from it: the
//! fence *array* a `SYNC_IOC_MERGE` produces and the fence *chain* a timeline
//! sync object grows. Reproducing those three shapes exactly, rather than
//! modelling each interface separately, is what makes their cross-interface
//! behavior (merge a timeline point with a KMS out-fence, import that into a
//! dma-buf, wait on it through a syncobj eventfd) the behavior Linux
//! programs were written against.
//!
//! # Sources
//!
//! A leaf fence is pending on one source until it signals once:
//!
//! * [`Source::Software`]: a kernel operation signals it (a software
//!   timeline, a sync object's `SIGNAL`, which uses an already-signaled
//!   stub).
//! * [`Source::Kms`]: the vblank that completes a KMS commit signals it
//!   (`OUT_FENCE_PTR`); the KMS code calls [`Fence::signal`] from its vblank
//!   retirement.
//! * [`Source::HostGl`]: a GL fence on a *separate* native context. A fence on
//!   the virtual GPU's shared native context is complete in submission order
//!   (decision D-17: every Kandelo consumer of its results runs later on that
//!   same context), so it is created signaled. A fence on another context
//!   has no shared command stream, so the host must observe its native
//!   status; it polls only fences that a waiter has enabled
//!   ([`Fence::enable_signaling`]), exactly as Linux drivers start fence
//!   interrupts only from `dma_fence_enable_sw_signaling`.
//!
//! # Waiters
//!
//! Kandelo's waiters are parked syscalls (the host's EAGAIN retry), poll and
//! epoll readiness, and eventfd triggers. A signal raises one coalesced wake
//! notification ([`take_wake`]) so the host retries parked callers, notifies
//! epoll interests on `sync_file` and dma-buf descriptions, and fires armed
//! sync-object eventfds. Nothing here runs while no fence signals, and the
//! host does no fence work at all while no waiter has enabled a host fence.

extern crate alloc;

use alloc::rc::{Rc, Weak};
use alloc::vec::Vec;
use core::cell::{Cell, RefCell};
use core::fmt;

/// What a pending leaf fence waits on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// Signaled by a kernel operation.
    Software,
    /// A GL fence on a separate native context, retained by the host under
    /// this kernel-issued export id (see `kernel_dri_fence_host_requests`).
    HostGl { export_id: u32 },
    /// Completion of a KMS commit on `crtc_id` (`OUT_FENCE_PTR`).
    Kms { crtc_id: u32 },
}

/// `dma_fence_get_status` folded into a value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Pending,
    /// `error` is 0 for success or a negative errno; `timestamp_ns` is the
    /// `CLOCK_MONOTONIC` time at which the fence was observed to signal.
    Signaled { error: i32, timestamp_ns: i64 },
}

impl Status {
    /// `dma_fence_get_status`: 0 pending, 1 signaled, negative errno.
    pub fn get_status(self) -> i32 {
        match self {
            Status::Pending => 0,
            Status::Signaled { error, .. } if error != 0 => error,
            Status::Signaled { .. } => 1,
        }
    }
}

/// A fence's timeline name (`dma_fence_ops.get_timeline_name`).
#[derive(Clone)]
pub enum Timeline {
    Static(&'static str),
    Named(Rc<str>),
}

impl Timeline {
    pub fn as_str(&self) -> &str {
        match self {
            Timeline::Static(name) => name,
            Timeline::Named(name) => name,
        }
    }
}

enum LeafState {
    Pending(Source),
    Signaled { error: i32, timestamp_ns: i64 },
}

struct Leaf {
    state: LeafState,
    /// The earliest deadline hint (`dma_fence_set_deadline`), if any.
    deadline_ns: Option<u64>,
    /// `DMA_FENCE_FLAG_ENABLE_SIGNAL_BIT`: a waiter asked for this fence's
    /// completion to be observed. Sticky, as on Linux.
    signaling: bool,
}

struct Link {
    /// The previous point, pruned of signaled links as the chain is walked
    /// (`dma_fence_chain_walk`), so a long-lived timeline holds only its
    /// unsignaled history.
    prev: Option<Fence>,
    fence: Fence,
    prev_seqno: u64,
}

enum Kind {
    Leaf { leaf: RefCell<Leaf>, driver: &'static str, timeline: Timeline },
    /// `dma_fence_array`: signals when every child has signaled.
    Array(Vec<Fence>),
    /// `dma_fence_chain`: one timeline point.
    Chain(RefCell<Link>),
}

struct FenceInner {
    id: u64,
    context: u64,
    seqno: u64,
    kind: Kind,
    /// A container's status once observed signaled; signaling is final.
    settled: Cell<Option<(i32, i64)>>,
}

/// One reference to a kernel fence. Cloning takes a reference; dropping the
/// last one releases it (and, for a pending host fence, the host's retained
/// native fence).
#[derive(Clone)]
pub struct Fence(Rc<FenceInner>);

impl fmt::Debug for Fence {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Fence(#{} ctx {} seq {} {:?})", self.0.id, self.0.context, self.0.seqno,
            self.status())
    }
}

// ── Globals ────────────────────────────────────────────────────────────────

struct Globals {
    next_id: u64,
    next_context: u64,
    last_export: u32,
    /// A fence signaled since the host last asked: parked callers retry.
    wake: bool,
    /// Pending host fences a waiter enabled, by export id.
    host_poll: Vec<(u32, Weak<FenceInner>)>,
    /// Export ids whose last kernel reference dropped while pending.
    host_release: Vec<u32>,
    /// Buffer reservations holding any implicit fence. While zero, a plane
    /// update looks up no buffer's fences (one integer test per commit).
    reservations_in_use: usize,
}

impl Globals {
    const fn new() -> Self {
        Self { next_id: 1, next_context: 1, last_export: 0, wake: false,
            host_poll: Vec::new(), host_release: Vec::new(), reservations_in_use: 0 }
    }
}

#[cfg(not(test))]
struct GlobalCell(RefCell<Globals>);
// Kernel Wasm execution is serialized on its worker.
#[cfg(not(test))]
unsafe impl Sync for GlobalCell {}
#[cfg(not(test))]
static GLOBALS: GlobalCell = GlobalCell(RefCell::new(Globals::new()));

// Native unit tests run in parallel threads; each gets its own fence world.
#[cfg(test)]
std::thread_local! {
    static GLOBALS: RefCell<Globals> = const { RefCell::new(Globals::new()) };
}

/// For destructors: a test thread's storage may already be torn down when
/// its last objects drop at thread exit; nothing is left to update then.
fn with_globals_on_drop(f: impl FnOnce(&mut Globals)) {
    #[cfg(not(test))]
    { f(&mut GLOBALS.0.borrow_mut()) }
    #[cfg(test)]
    { let _ = GLOBALS.try_with(|g| f(&mut g.borrow_mut())); }
}

fn with_globals<R>(f: impl FnOnce(&mut Globals) -> R) -> R {
    #[cfg(not(test))]
    { f(&mut GLOBALS.0.borrow_mut()) }
    #[cfg(test)]
    { GLOBALS.with(|g| f(&mut g.borrow_mut())) }
}

/// GL fences take their session's identity as their fence context, in a
/// range `context_alloc` never reaches.
pub const GL_SESSION_CONTEXT_BASE: u64 = 1 << 63;

/// `dma_fence_context_alloc(1)`.
pub fn context_alloc() -> u64 {
    with_globals(|g| {
        let context = g.next_context;
        g.next_context = g.next_context.checked_add(1).expect("fence context space exhausted");
        context
    })
}

/// Issue a never-reused id naming one host-retained GL fence.
pub fn allocate_export_id() -> Result<u32, wasm_posix_shared::Errno> {
    with_globals(|g| {
        let next = g.last_export.checked_add(1).ok_or(wasm_posix_shared::Errno::ENOMEM)?;
        g.last_export = next;
        Ok(next)
    })
}

/// Parked callers must retry: a sync object gained a fence, or an eventfd a
/// fence fired became readable.
pub(crate) fn raise_wake() {
    with_globals(|g| g.wake = true);
    crate::wakeup::push_fence_ready();
}

/// Take (and clear) the "a fence signaled; retry parked callers" flag. The
/// host learns the same thing from the coalesced `IDX_FENCE_READY` wake
/// event; this flag lets kernel code (and tests) observe it directly.
pub fn take_wake() -> bool {
    with_globals(|g| core::mem::replace(&mut g.wake, false))
}

/// Host requests from [`host_requests`]: poll this export, or release it.
pub const HOST_REQUEST_POLL: u32 = 1;
pub const HOST_REQUEST_RELEASE: u32 = 2;

/// Whether the host has fence work: an enabled pending host fence to poll
/// or a released one to drop.
pub fn host_work_pending() -> bool {
    with_globals(|g| !g.host_poll.is_empty() || !g.host_release.is_empty())
}

/// Every host fence the host must act on: releases first (consumed), then
/// the enabled pending fences it must poll (kept until they signal).
pub fn host_requests() -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    // Collect strong references outside the globals borrow: upgrading and
    // dropping them must not run a fence destructor inside the borrow.
    let (releases, polls) = with_globals(|g| {
        let releases = core::mem::take(&mut g.host_release);
        let polls: Vec<(u32, Weak<FenceInner>)> = g.host_poll.clone();
        (releases, polls)
    });
    for id in releases {
        out.push((id, HOST_REQUEST_RELEASE));
    }
    let mut live = Vec::new();
    for (id, weak) in polls {
        if let Some(inner) = weak.upgrade() {
            let fence = Fence(inner);
            if fence.status() == Status::Pending {
                out.push((id, HOST_REQUEST_POLL));
                live.push((id, Rc::downgrade(&fence.0)));
            }
        }
    }
    with_globals(|g| g.host_poll = live);
    out
}

/// Outcome of a host's report that export `export_id` signaled.
#[derive(Debug, PartialEq, Eq)]
pub enum HostSignal {
    Signaled,
    /// No pending fence holds this export (its last reference dropped).
    Released,
}

/// The host observed host fence `export_id` signal. An id the kernel never
/// issued is a host fault.
pub fn host_signaled(export_id: u32, error: i32, timestamp_ns: i64)
    -> Result<HostSignal, wasm_posix_shared::Errno> {
    let issued = with_globals(|g| export_id != 0 && export_id <= g.last_export);
    if !issued || error > 0 {
        return Err(wasm_posix_shared::Errno::EINVAL);
    }
    let target = with_globals(|g| g.host_poll.iter()
        .find(|(id, _)| *id == export_id).and_then(|(_, weak)| weak.upgrade()));
    match target {
        Some(inner) => {
            Fence(inner).signal(error, timestamp_ns);
            Ok(HostSignal::Signaled)
        }
        None => Ok(HostSignal::Released),
    }
}

impl Drop for FenceInner {
    fn drop(&mut self) {
        if let Kind::Leaf { leaf, .. } = &self.kind {
            if let LeafState::Pending(Source::HostGl { export_id }) = leaf.borrow().state {
                // The host keeps the native fence alive for this export; the
                // kernel's last reference is gone, so it may delete it.
                with_globals_on_drop(|g| {
                    g.host_release.push(export_id);
                    g.host_poll.retain(|(id, _)| *id != export_id);
                });
                crate::wakeup::push_fence_host_work();
            }
            return;
        }
        // WHY: ordinary Rc drop glue recursively releases every chain link
        // and array child. A timeline can outlive thousands of frames; its
        // final owner must not exhaust the kernel's native/Wasm call stack.
        let mut pending = Vec::new();
        self.detach_drop_children(&mut pending);
        while let Some(Fence(inner)) = pending.pop() {
            // Shared children retain their other owners. try_unwrap also
            // admits weak references, including a host fence's poll record.
            if let Ok(mut inner) = Rc::try_unwrap(inner) {
                inner.detach_drop_children(&mut pending);
                // Empty containers now drop at constant depth. Leaves keep
                // the exact final-reference native release path above.
            }
        }
    }
}

impl FenceInner {
    fn detach_drop_children(&mut self, pending: &mut Vec<Fence>) {
        if matches!(self.kind, Kind::Leaf { .. }) {
            return;
        }
        match core::mem::replace(&mut self.kind, Kind::Array(Vec::new())) {
            Kind::Array(mut children) => pending.append(&mut children),
            Kind::Chain(link) => {
                let Link { prev, fence, .. } = link.into_inner();
                if let Some(prev) = prev {
                    pending.push(prev);
                }
                pending.push(fence);
            }
            Kind::Leaf { .. } => unreachable!(),
        }
    }
}

/// Every reaction to a fence completing: retry parked callers, notify
/// readiness interests on sync_file and dma-buf descriptions, fire armed
/// eventfds. Coalesced per signal; a caller that signals many fences may
/// call it once.
fn notify_signaled() {
    raise_wake();
    use wasm_posix_shared::epoll::{EPOLLIN, EPOLLOUT, EPOLLRDNORM, EPOLLWRNORM};
    crate::epoll::notify(crate::epoll::Source::Device(crate::ofd::SYNC_FILE_FD_HOST_HANDLE),
        EPOLLIN | EPOLLRDNORM);
    crate::epoll::notify(crate::epoll::Source::Device(crate::ofd::PRIME_FD_HOST_HANDLE),
        EPOLLIN | EPOLLRDNORM | EPOLLOUT | EPOLLWRNORM);
    super::syncobj::fire_armed_eventfds();
}

// ── Construction ──────────────────────────────────────────────────────────

fn make(context: u64, seqno: u64, kind: Kind) -> Fence {
    let id = with_globals(|g| {
        let id = g.next_id;
        g.next_id = g.next_id.checked_add(1).expect("fence id space exhausted");
        id
    });
    Fence(Rc::new(FenceInner { id, context, seqno, kind, settled: Cell::new(None) }))
}

fn leaf(context: u64, seqno: u64, driver: &'static str, timeline: Timeline, state: LeafState)
    -> Fence {
    make(context, seqno, Kind::Leaf {
        leaf: RefCell::new(Leaf { state, deadline_ns: None, signaling: false }),
        driver, timeline,
    })
}

impl Fence {
    /// A leaf pending on `source`.
    pub fn pending(context: u64, seqno: u64, driver: &'static str, timeline: Timeline,
        source: Source) -> Fence {
        leaf(context, seqno, driver, timeline, LeafState::Pending(source))
    }

    /// A leaf created already signaled (a GL fence on the shared native
    /// context, completed in submission order).
    pub fn signaled(context: u64, seqno: u64, driver: &'static str, timeline: Timeline,
        timestamp_ns: i64) -> Fence {
        leaf(context, seqno, driver, timeline, LeafState::Signaled { error: 0, timestamp_ns })
    }

    /// `dma_fence_allocate_private_stub(timestamp)`: an already-signaled
    /// fence on context 0.
    pub fn stub(timestamp_ns: i64) -> Fence {
        leaf(0, 0, "stub", Timeline::Static("signaled"),
            LeafState::Signaled { error: 0, timestamp_ns })
    }

    /// `dma_fence_array_create(.., dma_fence_context_alloc(1), 1, ..)`.
    fn array(children: Vec<Fence>) -> Fence {
        make(context_alloc(), 1, Kind::Array(children))
    }

    /// `dma_fence_chain_init(chain, prev, fence, seqno)`: a timeline point
    /// on top of `prev` (the sync object's current fence, if any).
    pub fn chain(prev: Option<Fence>, fence: Fence, seqno: u64) -> Fence {
        let prev_chain_seqno = prev.as_ref()
            .filter(|p| matches!(p.0.kind, Kind::Chain(_)))
            .map(|p| (p.0.context, p.0.seqno));
        let (context, seqno, prev_seqno) = match prev_chain_seqno {
            // Reuse the previous point's context when this point is later.
            Some((context, prev)) if seqno > prev => (context, seqno, prev),
            // An unordered point starts a new context; keep a valid seqno.
            Some((_, prev)) => (context_alloc(), seqno.max(prev), 0),
            None => (context_alloc(), seqno, 0),
        };
        make(context, seqno, Kind::Chain(RefCell::new(Link { prev, fence, prev_seqno })))
    }

    /// The export id of a pending host GL leaf fence.
    pub fn host_export_id(&self) -> Option<u32> {
        match &self.0.kind {
            Kind::Leaf { leaf, .. } => match leaf.borrow().state {
                LeafState::Pending(Source::HostGl { export_id }) => Some(export_id),
                _ => None,
            },
            _ => None,
        }
    }

    pub fn id(&self) -> u64 { self.0.id }
    pub fn context(&self) -> u64 { self.0.context }
    pub fn seqno(&self) -> u64 { self.0.seqno }
    pub fn ptr_eq(&self, other: &Fence) -> bool { Rc::ptr_eq(&self.0, &other.0) }
    pub fn is_chain(&self) -> bool { matches!(self.0.kind, Kind::Chain(_)) }

    pub fn driver_name(&self) -> &str {
        match &self.0.kind {
            Kind::Leaf { driver, .. } => driver,
            Kind::Array(_) => "dma_fence_array",
            Kind::Chain(_) => "dma_fence_chain",
        }
    }

    pub fn timeline_name(&self) -> &str {
        match &self.0.kind {
            Kind::Leaf { timeline, .. } => timeline.as_str(),
            Kind::Array(_) | Kind::Chain(_) => "unbound",
        }
    }

    // ── Status ────────────────────────────────────────────────────────────

    pub fn is_signaled(&self) -> bool {
        self.status() != Status::Pending
    }

    pub fn status(&self) -> Status {
        if let Some((error, timestamp_ns)) = self.0.settled.get() {
            return Status::Signaled { error, timestamp_ns };
        }
        let status = match &self.0.kind {
            Kind::Leaf { leaf, .. } => match leaf.borrow().state {
                LeafState::Pending(_) => Status::Pending,
                LeafState::Signaled { error, timestamp_ns } => {
                    return Status::Signaled { error, timestamp_ns };
                }
            },
            Kind::Array(children) => {
                // dma_fence_array: complete when every child is; its error
                // is the first child error.
                let mut error = 0;
                let mut stamp = 0i64;
                for child in children {
                    match child.status() {
                        Status::Pending => return Status::Pending,
                        Status::Signaled { error: e, timestamp_ns } => {
                            if error == 0 { error = e; }
                            stamp = stamp.max(timestamp_ns);
                        }
                    }
                }
                Status::Signaled { error, timestamp_ns: stamp }
            }
            Kind::Chain(_) => {
                // dma_fence_chain_signaled: this point's fence and every
                // unsignaled earlier point's fence. A chain carries no error.
                let mut stamp = 0i64;
                let mut iter = Some(self.clone());
                while let Some(link) = iter {
                    match link.contained().status() {
                        Status::Pending => return Status::Pending,
                        Status::Signaled { timestamp_ns, .. } => stamp = stamp.max(timestamp_ns),
                    }
                    iter = link.walk();
                }
                Status::Signaled { error: 0, timestamp_ns: stamp }
            }
        };
        if let Status::Signaled { error, timestamp_ns } = status {
            self.0.settled.set(Some((error, timestamp_ns)));
        }
        status
    }

    /// `dma_fence_chain_contained`: a point's fence, or the fence itself.
    fn contained(&self) -> Fence {
        match &self.0.kind {
            Kind::Chain(link) => link.borrow().fence.clone(),
            _ => self.clone(),
        }
    }

    /// `dma_fence_chain_walk`: splice signaled points out of this point's
    /// history and return the first unsignaled earlier point (None for a
    /// non-chain fence or a fully signaled history).
    fn walk(&self) -> Option<Fence> {
        let Kind::Chain(link) = &self.0.kind else { return None };
        loop {
            let prev = link.borrow().prev.clone()?;
            let replacement = match &prev.0.kind {
                Kind::Chain(prev_link) => {
                    let (prev_fence, prev_prev) = {
                        let prev_link = prev_link.borrow();
                        (prev_link.fence.clone(), prev_link.prev.clone())
                    };
                    if !prev_fence.is_signaled() {
                        return Some(prev);
                    }
                    prev_prev
                }
                _ => {
                    if !prev.is_signaled() {
                        return Some(prev);
                    }
                    None
                }
            };
            link.borrow_mut().prev = replacement;
        }
    }

    /// The point before this timeline point (`dma_fence_chain.prev_seqno`).
    pub(crate) fn prev_seqno(&self) -> u64 {
        match &self.0.kind {
            Kind::Chain(link) => link.borrow().prev_seqno,
            _ => 0,
        }
    }

    /// One step of `dma_fence_chain_for_each` (see [`Fence::walk`]).
    pub(crate) fn walk_prev(&self) -> Option<Fence> {
        self.walk()
    }

    /// `dma_fence_chain_find_seqno`: the fence that completes timeline point
    /// `point`. `Ok(None)` means the point already signaled; `Err` means the
    /// point has not been submitted (or `point` names a point on a fence that
    /// is not a timeline).
    pub fn find_seqno(&self, point: u64) -> Result<Option<Fence>, ()> {
        if point == 0 {
            return Ok(Some(self.clone()));
        }
        let Kind::Chain(_) = &self.0.kind else { return Err(()) };
        if self.0.seqno < point {
            return Err(());
        }
        let head_context = self.0.context;
        let mut iter = Some(self.clone());
        while let Some(link) = iter {
            let prev_seqno = match &link.0.kind {
                Kind::Chain(l) => Some(l.borrow().prev_seqno),
                _ => None,
            };
            if link.0.context != head_context || prev_seqno.is_none_or(|prev| prev < point) {
                return Ok(Some(link));
            }
            iter = link.walk();
        }
        Ok(None)
    }

    /// `dma_fence_unwrap_for_each`: the leaf fences of arrays and chains.
    pub fn unwrap_into(&self, out: &mut Vec<Fence>) {
        match &self.0.kind {
            Kind::Leaf { .. } => out.push(self.clone()),
            Kind::Array(children) => {
                for child in children {
                    child.unwrap_into(out);
                }
            }
            Kind::Chain(_) => {
                let mut iter = Some(self.clone());
                while let Some(link) = iter {
                    link.contained().unwrap_into(out);
                    iter = link.walk();
                }
            }
        }
    }

    /// `dma_fence_unwrap_merge`: one fence completing when all of `inputs`
    /// do. Signaled leaves drop out; one fence per context survives (the
    /// latest); a single survivor is returned as itself; none at all is a
    /// stub carrying the latest signaled timestamp.
    pub fn merge(inputs: &[Fence]) -> Fence {
        let mut pending = Vec::new();
        let mut stamp = 0i64;
        for input in inputs {
            let mut leaves = Vec::new();
            input.unwrap_into(&mut leaves);
            for leaf in leaves {
                match leaf.status() {
                    Status::Pending => pending.push(leaf),
                    Status::Signaled { timestamp_ns, .. } => stamp = stamp.max(timestamp_ns),
                }
            }
        }
        if pending.is_empty() {
            return Fence::stub(stamp);
        }
        // fence_cmp: by context, later seqno first, then keep the first of
        // each context.
        pending.sort_by(|a, b| a.0.context.cmp(&b.0.context).then(b.0.seqno.cmp(&a.0.seqno)));
        pending.dedup_by(|later, earlier| later.0.context == earlier.0.context);
        if pending.len() == 1 {
            return pending.pop().unwrap();
        }
        Fence::array(pending)
    }

    // ── Signaling ─────────────────────────────────────────────────────────

    /// Signal a pending leaf with `error` (0 or a negative errno) at
    /// `timestamp_ns`. Signaling is final; a second signal, or a signal of a
    /// container, is a kernel invariant violation.
    pub fn signal(&self, error: i32, timestamp_ns: i64) {
        assert!(error <= 0, "fence error must be 0 or a negative errno");
        let Kind::Leaf { leaf, .. } = &self.0.kind else {
            panic!("only a leaf fence is signaled directly");
        };
        {
            let mut leaf = leaf.borrow_mut();
            assert!(matches!(leaf.state, LeafState::Pending(_)), "fence signaled twice");
            leaf.state = LeafState::Signaled { error, timestamp_ns };
        }
        notify_signaled();
    }

    /// `dma_fence_enable_sw_signaling` for every pending leaf: a waiter now
    /// needs this fence's completion observed. For a host GL fence this is
    /// what starts the host's polling.
    pub fn enable_signaling(&self) {
        let mut leaves = Vec::new();
        self.unwrap_into(&mut leaves);
        for fence in leaves {
            let Kind::Leaf { leaf, .. } = &fence.0.kind else { continue };
            let mut leaf = leaf.borrow_mut();
            if leaf.signaling {
                continue;
            }
            if let LeafState::Pending(source) = leaf.state {
                leaf.signaling = true;
                if let Source::HostGl { export_id } = source {
                    let weak = Rc::downgrade(&fence.0);
                    drop(leaf);
                    with_globals(|g| g.host_poll.push((export_id, weak)));
                    crate::wakeup::push_fence_host_work();
                }
            }
        }
    }

    /// `dma_fence_set_deadline`: a hint recorded on every pending leaf. No
    /// Kandelo fence source can complete sooner on request, so it changes
    /// nothing observable.
    pub fn set_deadline(&self, deadline_ns: u64) {
        let mut leaves = Vec::new();
        self.unwrap_into(&mut leaves);
        for fence in leaves {
            if let Kind::Leaf { leaf, .. } = &fence.0.kind {
                let mut leaf = leaf.borrow_mut();
                if matches!(leaf.state, LeafState::Pending(_)) {
                    leaf.deadline_ns = Some(leaf.deadline_ns.map_or(deadline_ns, |d| d.min(deadline_ns)));
                }
            }
        }
    }

    #[cfg(test)]
    pub fn deadline_ns(&self) -> Option<u64> {
        match &self.0.kind {
            Kind::Leaf { leaf, .. } => leaf.borrow().deadline_ns,
            _ => None,
        }
    }

    #[cfg(test)]
    pub fn signaling_enabled(&self) -> bool {
        match &self.0.kind {
            Kind::Leaf { leaf, .. } => leaf.borrow().signaling,
            _ => false,
        }
    }
}

// ── Software timeline ──────────────────────────────────────────────────────

/// A software timeline: fences on it signal in seqno order as its value
/// advances (`sw_sync`'s `sync_timeline`). KMS CRTC out-fences use one per
/// CRTC (`drm_crtc.fence_context`); tests use them in place of the `sw_sync`
/// debugfs device.
pub struct SwTimeline {
    context: u64,
    value: u64,
    driver: &'static str,
    name: Timeline,
    fences: Vec<Weak<FenceInner>>,
}

impl SwTimeline {
    pub fn new(driver: &'static str, name: Timeline) -> Self {
        Self { context: context_alloc(), value: 0, driver, name, fences: Vec::new() }
    }

    pub fn value(&self) -> u64 { self.value }

    /// A fence that signals when the timeline reaches `seqno` (already
    /// signaled if it has).
    pub fn create_fence(&mut self, seqno: u64, now_ns: i64) -> Fence {
        if seqno <= self.value {
            return Fence::signaled(self.context, seqno, self.driver, self.name.clone(), now_ns);
        }
        let fence = Fence::pending(self.context, seqno, self.driver, self.name.clone(),
            Source::Software);
        self.fences.push(Rc::downgrade(&fence.0));
        fence
    }

    /// Advance by `step`, signaling every fence the timeline passes.
    pub fn inc(&mut self, step: u64, now_ns: i64) {
        self.value = self.value.saturating_add(step);
        let value = self.value;
        let mut keep = Vec::new();
        let mut due = Vec::new();
        for weak in core::mem::take(&mut self.fences) {
            if let Some(inner) = weak.upgrade() {
                if inner.seqno <= value { due.push(Fence(inner)); } else { keep.push(weak); }
            }
        }
        self.fences = keep;
        for fence in due {
            fence.signal(0, now_ns);
        }
    }

    /// Closing a timeline signals its unsignaled fences with `-ENOENT`, as
    /// `sw_sync_debugfs_release` does.
    pub fn close(mut self, now_ns: i64) {
        for weak in core::mem::take(&mut self.fences) {
            if let Some(inner) = weak.upgrade() {
                Fence(inner).signal(-(wasm_posix_shared::Errno::ENOENT as i32), now_ns);
            }
        }
    }
}

// ── KMS out-fences ─────────────────────────────────────────────────────────

/// One CRTC's fence timeline (`drm_crtc.fence_context` / `fence_seqno`):
/// every `OUT_FENCE_PTR` fence of the CRTC is a later point on it, so two of
/// its out-fences merge to the later one. Each fence is pending on
/// [`Source::Kms`]; the KMS code signals it (`Fence::signal`) at the vblank
/// that completes the commit, with an error if the commit is abandoned.
pub struct CrtcFences {
    crtc_id: u32,
    context: u64,
    seqno: u64,
    timeline: Timeline,
}

impl CrtcFences {
    /// `drm_crtc_init_with_planes`: Linux names the timeline
    /// `CRTC:<id>-crtc-<index>`.
    pub fn new(crtc_id: u32, index: u32) -> Self {
        let name = alloc::format!("CRTC:{crtc_id}-crtc-{index}");
        Self { crtc_id, context: context_alloc(), seqno: 0, timeline: Timeline::Named(Rc::from(name)) }
    }

    /// `drm_crtc_create_fence`: the next point on this CRTC's timeline.
    pub fn create(&mut self, driver: &'static str) -> Fence {
        self.seqno = self.seqno.checked_add(1).expect("CRTC fence seqno space exhausted");
        Fence::pending(self.context, self.seqno, driver, self.timeline.clone(),
            Source::Kms { crtc_id: self.crtc_id })
    }
}

// ── dma-buf reservation (implicit fences) ─────────────────────────────────

/// `enum dma_resv_usage`, ordered from strictest to weakest.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Usage {
    Write = 1,
    Read = 2,
}

/// One buffer's implicit fences (`struct dma_resv`), held by its BO.
#[derive(Default, Debug)]
pub struct Reservation {
    fences: Vec<(Fence, Usage)>,
}

/// Whether any buffer holds an implicit fence. A KMS plane update consults
/// its framebuffer's reservation only then.
pub fn implicit_fences_exist() -> bool {
    with_globals(|g| g.reservations_in_use != 0)
}

impl Clone for Reservation {
    fn clone(&self) -> Self {
        if !self.fences.is_empty() {
            with_globals(|g| g.reservations_in_use += 1);
        }
        Self { fences: self.fences.clone() }
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if !self.fences.is_empty() {
            with_globals_on_drop(|g| g.reservations_in_use = g.reservations_in_use.saturating_sub(1));
        }
    }
}

impl Reservation {
    /// `drm_gem_plane_helper_prepare_fb` without an explicit fence: the
    /// unsignaled writers a scanout of this buffer must wait for, as one
    /// fence, or `None`.
    pub fn pending_write_fence(&mut self) -> Option<Fence> {
        let mut writers = self.wait_set(false);
        match writers.len() {
            0 => None,
            1 => writers.pop(),
            _ => Some(Fence::array(writers)),
        }
    }

    /// `dma_resv_add_fence`: replace a signaled slot, or an older fence of the
    /// same context whose usage is no stricter; otherwise append. Containers
    /// are added leaf by leaf.
    pub fn add(&mut self, fence: &Fence, usage: Usage) {
        let was_empty = self.fences.is_empty();
        self.add_leaves(fence, usage);
        if was_empty && !self.fences.is_empty() {
            with_globals(|g| g.reservations_in_use += 1);
        }
    }

    fn add_leaves(&mut self, fence: &Fence, usage: Usage) {
        let mut leaves = Vec::new();
        fence.unwrap_into(&mut leaves);
        'leaves: for leaf in leaves {
            for slot in self.fences.iter_mut() {
                if (slot.0.context() == leaf.context() && slot.1 >= usage
                    && leaf.seqno() >= slot.0.seqno())
                    || slot.0.is_signaled()
                {
                    *slot = (leaf, usage);
                    continue 'leaves;
                }
            }
            self.fences.push((leaf, usage));
        }
    }

    /// The unsignaled fences an access must wait for: a read waits for
    /// writers, a write for everyone (`dma_resv_usage_rw`).
    pub fn wait_set(&mut self, write_access: bool) -> Vec<Fence> {
        let was_in_use = !self.fences.is_empty();
        self.fences.retain(|(fence, _)| !fence.is_signaled());
        if was_in_use && self.fences.is_empty() {
            with_globals(|g| g.reservations_in_use -= 1);
        }
        let limit = if write_access { Usage::Read } else { Usage::Write };
        self.fences.iter().filter(|(_, usage)| *usage <= limit).map(|(f, _)| f.clone()).collect()
    }

    /// `dma_resv_get_singleton`: one fence for the wait set (a stub when it
    /// is empty).
    pub fn singleton(&mut self, write_access: bool, now_ns: i64) -> Fence {
        let mut set = self.wait_set(write_access);
        match set.len() {
            0 => Fence::stub(now_ns),
            1 => set.pop().unwrap(),
            _ => Fence::array(set),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sw(name: &'static str) -> SwTimeline {
        SwTimeline::new("sw_sync", Timeline::Static(name))
    }

    #[test]
    fn dropping_deep_chain_uses_bounded_stack() {
        std::thread::Builder::new().stack_size(128 * 1024).spawn(|| {
            let export_id = allocate_export_id().unwrap();
            let leaf = Fence::pending(context_alloc(), 1, "test", Timeline::Static("drop"),
                Source::HostGl { export_id });
            leaf.enable_signaling();
            let mut head = None;
            let mut middle = None;
            for point in 1..=8192 {
                head = Some(Fence::chain(head, leaf.clone(), point));
                if point == 4096 {
                    middle = Some(Rc::downgrade(&head.as_ref().unwrap().0));
                }
            }
            drop(head);
            assert!(middle.unwrap().upgrade().is_none(), "history must be released, not leaked");
            assert_eq!(Rc::strong_count(&leaf.0), 1, "shared leaf belongs to its remaining owner");
            assert_eq!(host_requests(), alloc::vec![(export_id, HOST_REQUEST_POLL)]);
            drop(leaf);
            assert_eq!(host_requests(), alloc::vec![(export_id, HOST_REQUEST_RELEASE)]);
            assert!(host_requests().is_empty(), "native release happens exactly once");
        }).unwrap().join().unwrap();
    }

    #[test]
    fn dropping_deep_array_uses_bounded_stack() {
        std::thread::Builder::new().stack_size(128 * 1024).spawn(|| {
            let leaf = Fence::stub(1);
            let weak = Rc::downgrade(&leaf.0);
            let mut head = leaf;
            for _ in 0..8192 {
                head = Fence::array(alloc::vec![head]);
            }
            drop(head);
            assert!(weak.upgrade().is_none(), "nested containers must release their leaf");
        }).unwrap().join().unwrap();
    }

    #[test]
    fn leaf_signals_once_with_its_error_and_time() {
        let mut timeline = sw("t");
        let fence = timeline.create_fence(1, 0);
        assert_eq!(fence.status(), Status::Pending);
        assert!(!take_wake());
        timeline.inc(1, 77);
        assert_eq!(fence.status(), Status::Signaled { error: 0, timestamp_ns: 77 });
        assert!(take_wake());
        let closed = {
            let mut t = sw("closing");
            let f = t.create_fence(5, 0);
            t.close(9);
            f
        };
        assert_eq!(closed.status().get_status(), -(wasm_posix_shared::Errno::ENOENT as i32));
    }

    #[test]
    #[should_panic(expected = "fence signaled twice")]
    fn signaling_twice_is_an_invariant_violation() {
        let fence = Fence::pending(context_alloc(), 1, "sw_sync", Timeline::Static("t"),
            Source::Software);
        fence.signal(0, 1);
        fence.signal(0, 2);
    }

    #[test]
    fn merge_dedups_by_context_and_drops_signaled() {
        let mut a = sw("a");
        let mut b = sw("b");
        let a1 = a.create_fence(1, 0);
        let a2 = a.create_fence(2, 0);
        let b1 = b.create_fence(1, 0);
        let merged = Fence::merge(&[a1.clone(), a2.clone()]);
        assert!(merged.ptr_eq(&a2), "same context keeps the later point");
        let merged = Fence::merge(&[merged, b1.clone()]);
        let mut leaves = Vec::new();
        merged.unwrap_into(&mut leaves);
        assert_eq!(leaves.len(), 2);
        a.inc(2, 5);
        assert_eq!(merged.status(), Status::Pending);
        b.inc(1, 6);
        assert_eq!(merged.status(), Status::Signaled { error: 0, timestamp_ns: 6 });
        // Everything signaled: a stub with the latest time.
        let stub = Fence::merge(&[a1, b1]);
        assert_eq!(stub.status(), Status::Signaled { error: 0, timestamp_ns: 6 });
        assert_eq!(stub.driver_name(), "stub");
    }

    #[test]
    fn timeline_points_complete_in_order_and_prune() {
        let mut t = sw("t");
        let f1 = t.create_fence(1, 0);
        // Point 2's fence comes from another producer and signals early.
        let f2 = Fence::pending(context_alloc(), 1, "sw_sync", Timeline::Static("other"),
            Source::Software);
        let f3 = t.create_fence(3, 0);
        let p1 = Fence::chain(None, f1, 1);
        let p2 = Fence::chain(Some(p1.clone()), f2.clone(), 2);
        let p3 = Fence::chain(Some(p2.clone()), f3, 3);
        assert_eq!(p3.context(), p1.context());
        // A later fence signaling alone does not complete the later point.
        f2.signal(0, 3);
        assert!(!p2.is_signaled());
        // Point 2 is now completed by point 1's fence.
        let covering = p3.find_seqno(2).unwrap().unwrap();
        assert!(covering.ptr_eq(&p1));
        assert!(p3.find_seqno(4).is_err());
        t.inc(1, 4);
        assert!(p2.is_signaled());
        assert!(!p3.is_signaled());
        assert!(p3.find_seqno(2).unwrap().is_none(), "point 2 already signaled");
        t.inc(2, 5);
        assert!(p3.is_signaled());
    }

    #[test]
    fn unordered_point_starts_a_new_context() {
        let p5 = Fence::chain(None, Fence::stub(0), 5);
        let p3 = Fence::chain(Some(p5.clone()), Fence::stub(0), 3);
        assert_ne!(p3.context(), p5.context());
        assert_eq!(p3.seqno(), 5);
    }

    #[test]
    fn host_fences_are_polled_only_after_a_waiter_enables_them() {
        let export_id = allocate_export_id().unwrap();
        let fence = Fence::pending(context_alloc(), 1, "kandelo-drm", Timeline::Static("gles"),
            Source::HostGl { export_id });
        assert!(!host_work_pending(), "no waiter, no host work");
        fence.enable_signaling();
        assert_eq!(host_requests(), alloc::vec![(export_id, HOST_REQUEST_POLL)]);
        assert_eq!(host_signaled(export_id, 0, 10), Ok(HostSignal::Signaled));
        assert!(fence.is_signaled());
        assert!(host_requests().is_empty());
        assert_eq!(host_signaled(export_id + 1, 0, 10), Err(wasm_posix_shared::Errno::EINVAL));
        // Dropping an unsignaled host fence releases the host's native fence.
        let export_id = allocate_export_id().unwrap();
        let fence = Fence::pending(context_alloc(), 1, "kandelo-drm", Timeline::Static("gles"),
            Source::HostGl { export_id });
        fence.enable_signaling();
        drop(fence);
        assert_eq!(host_requests(), alloc::vec![(export_id, HOST_REQUEST_RELEASE)]);
        assert_eq!(host_signaled(export_id, 0, 10), Ok(HostSignal::Released));
    }

    #[test]
    fn crtc_out_fences_are_ordered_points_on_one_timeline() {
        let mut crtc = CrtcFences::new(1, 0);
        let first = crtc.create("kandelo-drm");
        let second = crtc.create("kandelo-drm");
        assert_eq!(first.timeline_name(), "CRTC:1-crtc-0");
        assert!(Fence::merge(&[first.clone(), second.clone()]).ptr_eq(&second));
        first.signal(0, 5);
        assert!(first.is_signaled() && !second.is_signaled());
        // An abandoned commit's fence completes with an error.
        second.signal(-(wasm_posix_shared::Errno::EIO as i32), 6);
        assert!(second.status().get_status() < 0);
    }

    #[test]
    fn reservation_read_waits_for_writers_and_write_waits_for_all() {
        let mut t = sw("r");
        let mut w = sw("w");
        let reader = t.create_fence(1, 0);
        let writer = w.create_fence(1, 0);
        let mut resv = Reservation::default();
        resv.add(&reader, Usage::Read);
        resv.add(&writer, Usage::Write);
        assert_eq!(resv.wait_set(false).len(), 1);
        assert_eq!(resv.wait_set(true).len(), 2);
        w.inc(1, 1);
        assert!(resv.wait_set(false).is_empty());
        assert!(resv.singleton(false, 3).is_signaled());
        assert!(!resv.singleton(true, 3).is_signaled());
    }
}
