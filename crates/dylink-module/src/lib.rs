//! `crates/dylink-module` — the wasm face of the dynamic-linking planner.
//!
//! # Why this crate exists
//!
//! [`dylink`] is a pure Rust library with a Rust-native `step`/`resume` API.
//! `crates/host-native` links it directly and matches on the enums, so on a
//! native host the planner needs nothing else. On the two JavaScript hosts it
//! needs one thing it does not have: **a wasm entry point**. Without one,
//! nothing on Node or in the browser can call the planner at all, and
//! `host/src/dylink.ts` (4,188 lines) plus `host/src/dylink-fork-archive.ts`
//! (2,152) keep driving every load on every host.
//!
//! This crate is that entry point. It is deliberately thin: session state, two
//! byte buffers, and a `dl_*` export per planner method. Every decision the
//! linker makes lives in [`dylink`], where it is testable with plain
//! `cargo test` and shared with the native executor.
//!
//! # Placement — a standalone module, forced rather than chosen
//!
//! Two other homes were considered and both are refuted:
//!
//! - **Folding into `crates/fork-module`.** Fork-module is instantiated only
//!   under `if (hasForkInstrumentation)`, while the `dlopen` import builder's
//!   call site is in the **non**-instrumented branch. Folding would remove
//!   `dlopen` from every UNINSTRUMENTED process, and no artifact in this tree
//!   would catch it: PHP is the only runtime-`dlopen` consumer here and PHP is
//!   instrumented. `dlopen` is a generically useful POSIX interface, not a
//!   facility for one package, so a regression invisible to the test suite is
//!   exactly the kind this project treats as a defect rather than an
//!   acceptable trade.
//! - **Linking into the kernel.** The kernel reaches process memory only
//!   through `HostIO::process_memory_len` and channel scratch. Both the `.so`
//!   image and the fork archive live in GUEST memory, which the kernel cannot
//!   address.
//!
//! What remains is a standalone module, and it is cleaner than either: this
//! module imports **nothing at all** — not even `env.memory`. It owns its own
//! linear memory, which is why its allocator can grow it and why the driver
//! passes bytes rather than pointers into the guest.
//!
//! # The memory contract, which a driver WILL get wrong once
//!
//! Every `dl_*` entry point may allocate, and allocating may `memory.grow`.
//! Growing detaches every existing `ArrayBuffer` view on the JavaScript side.
//!
//! **A driver must therefore re-acquire `instance.exports.memory.buffer` after
//! every `dl_*` call, before touching any pointer.** A view captured before a
//! call and used after it is either detached (a thrown `TypeError`, which is
//! survivable) or, worse, stale. [`dl_output_ptr`] and [`dl_output_len`] do not
//! allocate, so reading them after a call is safe — but the view used to READ
//! those bytes must still be freshly acquired.
//!
//! # The drive loop
//!
//! ```text
//!   dl_configure(config)            once per process
//!   dl_publish_main_image(image)    once per process, before any dlopen
//!
//!   dl_open_begin(request)          per dlopen
//!   loop {
//!       dl_step()                   -> encoded PlanStep in the output buffer
//!       match step {
//!           Act | Host | Call  => execute it, dl_resume(encoded ActResult)
//!           Finished           => break
//!       }
//!   }
//!   dl_open_finish()                -> the dlopen handle
//! ```
//!
//! A failed load calls [`dl_open_abort`] instead of [`dl_open_finish`]. Abort
//! does not end the drive loop: it re-arms it with the rollback work, so the
//! SAME loop drains the release requests and then sees `Finished`. There is one
//! drive loop, not two.
//!
//! # Scope of this crate, and what is NOT here
//!
//! This crate is the entry points and the session state, and the surrounding
//! commit wires the module through the build pipeline so both hosts resolve,
//! compile, and hand it to every process worker.
//!
//! Nothing DRIVES it. `host/src/dylink.ts` still performs every load on every
//! host. The JavaScript act executor, the KFLA fork-archive encoder, and the
//! `worker-main.ts` rewire that retires that file are the next increment.
//!
//! Two things a caller might expect and will not find, so that their absence is
//! a stated boundary rather than a surprise:
//!
//! - **Nested loader transactions.** [`dylink::PendingTransaction`] models a
//!   `dlopen` the parent had open when it forked. The planner carries it; this
//!   module has no entry point that begins or resumes one, and
//!   [`dl_open_begin`] refuses a second concurrent load rather than nesting.
//! - **Scope snapshot/restore.** `LinkerScope::snapshot`/`restore` exist for
//!   transaction rollback inside the planner. [`dl_open_abort`] uses the plan's
//!   own rollback, which is the whole-load case; a partial-scope rewind has no
//!   entry point.
//!
//! Neither is needed to drive a `dlopen` to completion or to unwind a failed
//! one, which is why they are omitted rather than stubbed.

#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]
#![forbid(unsafe_op_in_unsafe_fn)]

extern crate alloc;

use alloc::collections::VecDeque;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use core::cell::UnsafeCell;

use dylink::{
    DylinkError, HandleTable, HostRequest, LinkPlan, Linker, PlanStep, MAIN_PROGRAM_HANDLE,
};

/// The call succeeded. Any payload is in the output buffer.
pub const DL_OK: i32 = 0;
/// The call failed. [`dl_error`] renders what happened.
pub const DL_ERROR: i32 = -1;

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/// What the session is currently driving.
enum Phase {
    /// No load in flight.
    Idle,
    /// A `dlopen` is being planned.
    Loading(LinkPlan),
    /// A failed load is being rolled back. The queue is drained by the same
    /// `dl_step` loop that drove the load, so a driver has one loop, not two.
    RollingBack(VecDeque<HostRequest>),
}

struct Session {
    linker: Linker,
    handles: HandleTable,
    phase: Phase,
    /// `dlerror`'s pending message.
    error: Option<String>,
}

impl Session {
    fn new(linker: Linker) -> Self {
        Session {
            linker,
            handles: HandleTable::new(),
            phase: Phase::Idle,
            error: None,
        }
    }
}

/// The two byte buffers, deliberately OUTSIDE the session.
///
/// [`dl_configure`] is itself a request that arrives as bytes, so the input
/// buffer has to exist before the session it creates does. Keeping both
/// buffers independent also means a failed configure still has somewhere to
/// put its diagnostic.
struct Buffers {
    /// The driver writes request bytes here; the module reads them.
    input: Vec<u8>,
    /// The module writes answer bytes here; the driver reads them.
    output: Vec<u8>,
    /// A message from a call made with no session, which has nowhere else to
    /// go.
    detached_error: Option<String>,
}

/// The process's single session.
///
/// A process worker runs one guest on one thread and every `dlopen` arrives on
/// that thread, so there is no concurrent access to guard against. The wrapper
/// exists because a `static mut` reference is denied in this edition, not
/// because a lock is needed — the same reasoning `crates/wasi-module` records
/// for its shim.
struct SessionCell(UnsafeCell<Option<Session>>);

// SAFETY: single-threaded per process worker, as documented above.
unsafe impl Sync for SessionCell {}

static SESSION: SessionCell = SessionCell(UnsafeCell::new(None));

struct BufferCell(UnsafeCell<Buffers>);

// SAFETY: single-threaded per process worker, as documented above.
unsafe impl Sync for BufferCell {}

static BUFFERS: BufferCell = BufferCell(UnsafeCell::new(Buffers {
    input: Vec::new(),
    output: Vec::new(),
    detached_error: None,
}));

/// The session, or `None` before [`dl_configure`].
///
/// Every entry point below takes one reference, uses it, and returns, so no
/// second live reference exists.
#[allow(clippy::mut_from_ref)]
fn session() -> &'static mut Option<Session> {
    // SAFETY: single-threaded per process worker (see `SessionCell`).
    unsafe { &mut *SESSION.0.get() }
}

/// The request and answer buffers.
#[allow(clippy::mut_from_ref)]
fn buffers() -> &'static mut Buffers {
    // SAFETY: single-threaded per process worker (see `BufferCell`).
    unsafe { &mut *BUFFERS.0.get() }
}

/// The request bytes the driver just wrote, bounds-checked against what it
/// actually reserved.
///
/// A `len` larger than the reservation is a driver bug that would otherwise
/// read whatever the previous request left behind, so it is refused.
fn request(len: u32) -> Result<&'static [u8], DylinkError> {
    let input = &buffers().input;
    input
        .get(..len as usize)
        .ok_or(DylinkError::MalformedModule(
            "request length exceeds the reserved input buffer",
        ))
}

/// Run `body` against a configured session, turning any error into a stored
/// `dlerror` message and the [`DL_ERROR`] status.
///
/// This is where "truthful failure" is enforced for the whole surface: a
/// planner error is never flattened into a zero or an empty answer, it becomes
/// a status the driver must check and a message it can render.
fn with_session(body: impl FnOnce(&mut Session) -> Result<(), DylinkError>) -> i32 {
    buffers().output.clear();
    let Some(state) = session().as_mut() else {
        return detached_failure("no linker session; call dl_configure first");
    };
    match body(state) {
        Ok(()) => {
            state.error = None;
            DL_OK
        }
        Err(error) => {
            buffers().output.clear();
            state.error = Some(error.to_string());
            DL_ERROR
        }
    }
}

fn fail(message: &str) -> i32 {
    buffers().output.clear();
    match session().as_mut() {
        Some(state) => {
            state.error = Some(message.to_string());
            DL_ERROR
        }
        None => detached_failure(message),
    }
}

/// A failure with no session to record it against. [`dl_error`] still renders
/// it: a call made before `dl_configure` must be diagnosable, not just a bare
/// status code.
fn detached_failure(message: &str) -> i32 {
    buffers().detached_error = Some(message.to_string());
    DL_ERROR
}

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

/// Reserve `len` bytes of module-owned memory for the driver to write a
/// request into, and return its address.
///
/// This may grow the module's memory, so the caller MUST re-acquire its
/// `ArrayBuffer` view before writing. See the memory contract above.
#[unsafe(no_mangle)]
pub extern "C" fn dl_input_reserve(len: u32) -> usize {
    let input = &mut buffers().input;
    input.clear();
    input.resize(len as usize, 0);
    input.as_ptr() as usize
}

/// The address of the answer bytes from the last successful call.
#[unsafe(no_mangle)]
pub extern "C" fn dl_output_ptr() -> usize {
    buffers().output.as_ptr() as usize
}

/// The length of the answer bytes from the last successful call.
#[unsafe(no_mangle)]
pub extern "C" fn dl_output_len() -> u32 {
    buffers().output.len() as u32
}

/// Render the pending `dlerror` message into the output buffer.
///
/// Returns the message length, or 0 when there is no pending error. POSIX
/// `dlerror` clears the message it reports, and so does this.
#[unsafe(no_mangle)]
pub extern "C" fn dl_error() -> u32 {
    let message = match session().as_mut().and_then(|state| state.error.take()) {
        Some(message) => Some(message),
        None => buffers().detached_error.take(),
    };
    let output = &mut buffers().output;
    output.clear();
    match message {
        Some(message) => {
            output.extend_from_slice(message.as_bytes());
            output.len() as u32
        }
        None => 0,
    }
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

/// Configure the process's linker from an encoded `LinkerConfig`.
///
/// Called once per process. Calling it again replaces the linker wholesale,
/// which is what `exec` needs: the new image shares no loader state with the
/// old one.
#[unsafe(no_mangle)]
pub extern "C" fn dl_configure(len: u32) -> i32 {
    buffers().output.clear();
    let config = match request(len).and_then(dylink::wire::decode_linker_config) {
        Ok(config) => config,
        Err(error) => {
            // A malformed config leaves NO session, so the message goes to the
            // detached slot. Creating a default-configured session here would
            // be the silent-success shape this project treats as a defect: the
            // process would link against a pointer width nobody chose.
            *session() = None;
            return detached_failure(&error.to_string());
        }
    };
    *session() = Some(Session::new(Linker::new(config)));
    DL_OK
}

/// Drop all loader state. `exec` replaces the process image, so the next
/// [`dl_configure`] starts from nothing.
#[unsafe(no_mangle)]
pub extern "C" fn dl_reset() {
    *session() = None;
}

/// Publish the main image's exports and element-segment table layout from an
/// encoded `MainImage`.
///
/// The main image is the root of the global scope, so this must happen before
/// any `dlopen` can resolve a symbol against it.
#[unsafe(no_mangle)]
pub extern "C" fn dl_publish_main_image(len: u32) -> i32 {
    with_session(|state| {
        let image = dylink::wire::decode_main_image(request(len)?)?;
        state.linker.scope.publish_main_image(
            image.exports,
            image.element_slots,
            image.table_length,
        );
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// dlopen
// ---------------------------------------------------------------------------

/// Begin a `dlopen` from an encoded `LoadRequest`.
#[unsafe(no_mangle)]
pub extern "C" fn dl_open_begin(len: u32) -> i32 {
    with_session(|state| {
        if !matches!(state.phase, Phase::Idle) {
            // A nested begin would silently abandon the in-flight plan's
            // allocations and activation, so it is refused rather than
            // accommodated.
            return Err(DylinkError::UnexpectedActSequence);
        }
        let load_request = dylink::wire::decode_load_request(request(len)?)?;
        let plan = LinkPlan::begin(&mut state.linker, load_request)?;
        state.phase = Phase::Loading(plan);
        Ok(())
    })
}

/// Ask what the driver must do next. The encoded `PlanStep` lands in the
/// output buffer.
#[unsafe(no_mangle)]
pub extern "C" fn dl_step() -> i32 {
    with_session(|state| {
        let mut drained = false;
        let step = match &mut state.phase {
            Phase::Loading(plan) => plan.step(&mut state.linker)?,
            Phase::RollingBack(queue) => match queue.pop_front() {
                Some(host_request) => PlanStep::Host(host_request),
                None => {
                    drained = true;
                    PlanStep::Finished
                }
            },
            Phase::Idle => return Err(DylinkError::UnexpectedActSequence),
        };
        if drained {
            // The rollback is complete. Return to Idle so the next dlopen is a
            // fresh session rather than an endless run of `Finished`.
            state.phase = Phase::Idle;
        }
        buffers().output = dylink::wire::encode_plan_step(&step)?;
        Ok(())
    })
}

/// Answer the last step with an encoded `ActResult`.
#[unsafe(no_mangle)]
pub extern "C" fn dl_resume(len: u32) -> i32 {
    with_session(|state| {
        let result = dylink::wire::decode_act_result(request(len)?)?;
        match &mut state.phase {
            Phase::Loading(plan) => plan.resume(&mut state.linker, result),
            // A rollback request is answered with `Done`; there is nothing to
            // feed back into the planner.
            Phase::RollingBack(_) => Ok(()),
            Phase::Idle => Err(DylinkError::UnexpectedActSequence),
        }
    })
}

/// Complete the load and return its `dlopen` handle, or [`DL_ERROR`].
///
/// `replay_handle` pins the parent's exact handle during fork replay; pass -1
/// for an ordinary load. The guest holds the parent's handle values in its own
/// memory, so a child that renumbered them would hand back a handle the program
/// has never seen — which is why the planner treats a mismatch as an error
/// rather than silently reassigning.
///
/// `i32` rather than `i64` deliberately: handles are allocated from 2 upwards,
/// one per live `dlopen`, so they cannot approach `i32::MAX`, and an `i64`
/// parameter would force every JavaScript caller to pass a `BigInt` for a small
/// counter.
#[unsafe(no_mangle)]
pub extern "C" fn dl_open_finish(replay_handle: i32) -> i32 {
    buffers().output.clear();
    let replay_handle = match replay_handle {
        -1 => None,
        handle if handle >= 0 => Some(handle as u32),
        _ => return fail("replay handle must be -1 (none) or a non-negative handle"),
    };
    let Some(state) = session().as_mut() else {
        return detached_failure("no linker session; call dl_configure first");
    };
    let Phase::Loading(plan) = core::mem::replace(&mut state.phase, Phase::Idle) else {
        return fail("dl_open_finish without a load in flight");
    };
    let library = match plan.finish(&state.linker) {
        Ok(library) => library,
        Err(error) => return fail(&error.to_string()),
    };
    let handle = match state.handles.open(&library.name, replay_handle) {
        Ok(handle) => handle,
        Err(error) => return fail(&error.to_string()),
    };
    // Record the lifetime edges `dlclose` needs. Without them a dependency
    // retained only by another object would look unloadable.
    let dependencies = library.runtime_dependency_names();
    if let Err(error) = state
        .handles
        .register_dependency_edges([(library.name.clone(), dependencies)])
    {
        return fail(&error.to_string());
    }
    state.error = None;
    handle as i32
}

/// Abandon the load in flight and re-arm the drive loop with its rollback.
///
/// The rollback requests are drained by [`dl_step`], so a driver that already
/// has a step loop needs no second one. The output buffer carries the table
/// range to reclaim, when there is one: `[1][u64 first][u64 length]`, or `[0]`.
#[unsafe(no_mangle)]
pub extern "C" fn dl_open_abort() -> i32 {
    buffers().output.clear();
    let Some(state) = session().as_mut() else {
        return detached_failure("no linker session; call dl_configure first");
    };
    let Phase::Loading(plan) = core::mem::replace(&mut state.phase, Phase::Idle) else {
        return fail("dl_open_abort without a load in flight");
    };
    let table_range = plan.rollback_table_range(&state.linker);
    let requests = plan.rollback(&mut state.linker);
    let output = &mut buffers().output;
    match table_range {
        Some((first, length)) => {
            output.push(1);
            output.extend_from_slice(&first.to_le_bytes());
            output.extend_from_slice(&length.to_le_bytes());
        }
        None => output.push(0),
    }
    state.phase = Phase::RollingBack(requests.into_iter().collect());
    state.error = None;
    DL_OK
}

// ---------------------------------------------------------------------------
// Plan accessors
// ---------------------------------------------------------------------------
//
// The layout the planner chose, for the caller that has to record it: the fork
// archive writes exactly these fields. Each returns -1 for "absent" rather than
// zero, because zero is a legal value for every one of them.

/// The instance id the plan assigned, or -1.
#[unsafe(no_mangle)]
pub extern "C" fn dl_plan_instance() -> i64 {
    with_plan(|plan| plan.instance().index() as i64)
}

/// The plan's `__memory_base`, or -1.
#[unsafe(no_mangle)]
pub extern "C" fn dl_plan_memory_base() -> i64 {
    with_plan(|plan| plan.memory_base() as i64)
}

/// The plan's `__table_base`, or -1.
#[unsafe(no_mangle)]
pub extern "C" fn dl_plan_table_base() -> i64 {
    with_plan(|plan| plan.table_base() as i64)
}

/// The plan's TLS base, or -1 when the object has no TLS.
#[unsafe(no_mangle)]
pub extern "C" fn dl_plan_tls_base() -> i64 {
    with_plan(|plan| plan.tls_base().map(|base| base as i64).unwrap_or(-1))
}

/// The fork activation the plan reserved, or -1 when it reserved none.
#[unsafe(no_mangle)]
pub extern "C" fn dl_plan_activation() -> i64 {
    with_plan(|plan| {
        plan.activation_id()
            .map(|activation| activation as i64)
            .unwrap_or(-1)
    })
}

fn with_plan(body: impl FnOnce(&LinkPlan) -> i64) -> i64 {
    match session().as_ref() {
        Some(Session {
            phase: Phase::Loading(plan),
            ..
        }) => body(plan),
        _ => -1,
    }
}

// ---------------------------------------------------------------------------
// dlsym / dlclose
// ---------------------------------------------------------------------------

/// Resolve a symbol for `handle`. The input buffer holds the symbol name; the
/// output buffer receives an encoded `Option<ResolvedSymbol>`.
///
/// A miss is a successful call carrying `None`, not an error: POSIX reports it
/// through `dlerror`, and conflating the two would make a legitimately absent
/// weak symbol indistinguishable from a broken lookup.
#[unsafe(no_mangle)]
pub extern "C" fn dl_sym(handle: u32, len: u32) -> i32 {
    with_session(|state| {
        // Copied out of the input buffer rather than borrowed from it. The
        // answer is written into the OUTPUT buffer further down, and holding a
        // borrow of one field of `Buffers` across a write to another means two
        // live `&mut` to the same struct — which works in practice and is still
        // the kind of aliasing that has no business being in code an optimizer
        // is free to reason about.
        let name = match core::str::from_utf8(request(len)?) {
            Ok(name) => name.to_string(),
            Err(_) => return Err(DylinkError::MalformedModule("dlsym name is not UTF-8")),
        };
        let name = name.as_str();
        let symbol = if handle == MAIN_PROGRAM_HANDLE {
            state.linker.scope.global_symbol(name).cloned()
        } else {
            let library = state
                .handles
                .library_for(handle)
                .ok_or(DylinkError::InvalidHandle { handle })?
                .to_string();
            let roots = [library.clone()];
            let scope = state.linker.scope.dependency_scope(&library, &roots)?;
            state.linker.scope.scoped_symbol(&scope, name)
        };
        buffers().output = dylink::wire::encode_resolved_symbol(symbol.as_ref())?;
        Ok(())
    })
}

/// Release one reference to `handle`. The output buffer receives an encoded
/// `CloseOutcome` describing what actually happened.
#[unsafe(no_mangle)]
pub extern "C" fn dl_close(handle: u32) -> i32 {
    with_session(|state| {
        let outcome = state.handles.close(handle)?;
        buffers().output = dylink::wire::encode_close_outcome(&outcome)?;
        Ok(())
    })
}

/// Whether the library released by the last [`dl_close`] is safe to unload —
/// that is, no other loaded object still retains it.
///
/// `dlclose` releasing the last HANDLE reference does not by itself authorize
/// unloading: a dependency edge from another object keeps the image alive.
/// Returns 1 for unloadable, 0 for retained, and [`DL_ERROR`] on a bad handle.
#[unsafe(no_mangle)]
pub extern "C" fn dl_is_unloadable(len: u32) -> i32 {
    buffers().output.clear();
    let Ok(bytes) = request(len) else {
        return fail("library name exceeds the reserved input buffer");
    };
    let Ok(library) = core::str::from_utf8(bytes) else {
        return fail("library name is not UTF-8");
    };
    match session().as_ref() {
        Some(state) => i32::from(state.handles.is_unloadable(library)),
        None => detached_failure("no linker session; call dl_configure first"),
    }
}

/// Forget a library that has been unloaded, so its name and table slots are
/// available again.
#[unsafe(no_mangle)]
pub extern "C" fn dl_forget(len: u32) -> i32 {
    with_session(|state| {
        let library = core::str::from_utf8(request(len)?)
            .map_err(|_| DylinkError::MalformedModule("library name is not UTF-8"))?
            .to_string();
        let _ = state.linker.scope.remove(&library);
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// The wasm runtime floor
// ---------------------------------------------------------------------------

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
mod wasm {
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;
    use dlmalloc::Dlmalloc;

    /// A RECLAIMING allocator, and that word is load-bearing.
    ///
    /// A long-running process can `dlopen` and `dlclose` repeatedly. Each load
    /// allocates the module image, its symbol tables, and its GOT plan, and
    /// each unload should give them back. A bump allocator — the shape
    /// `crates/fork-module` uses, because its state is reset once per fork —
    /// would turn ordinary loader churn into eventual exhaustion of this
    /// module's linear memory.
    ///
    /// `dlmalloc` is what the kernel uses for the same reason
    /// (`crates/kernel/src/lib.rs`), and what Rust itself uses for ordinary
    /// wasm32-unknown-unknown programs. Its wasm backend grows from the current
    /// end of THIS module's own linear memory — which this module owns outright,
    /// importing no memory from anyone — so it adds no import and cannot
    /// collide with guest data.
    struct ModuleAllocator(UnsafeCell<Dlmalloc>);

    // SAFETY: a process worker runs one guest on one thread, and every `dl_*`
    // entry point is called from it. There is no concurrent access.
    unsafe impl Sync for ModuleAllocator {}

    unsafe impl GlobalAlloc for ModuleAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            unsafe { (*self.0.get()).malloc(layout.size(), layout.align()) }
        }

        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { (*self.0.get()).free(ptr, layout.size(), layout.align()) }
        }

        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            unsafe { (*self.0.get()).calloc(layout.size(), layout.align()) }
        }

        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            unsafe { (*self.0.get()).realloc(ptr, layout.size(), layout.align(), new_size) }
        }
    }

    #[global_allocator]
    static ALLOC: ModuleAllocator = ModuleAllocator(UnsafeCell::new(Dlmalloc::new()));

    /// The module is built with `panic=immediate-abort`, so a panic compiles to
    /// a wasm `unreachable` and never reaches here. This exists to satisfy the
    /// `no_std` link.
    ///
    /// It traps rather than looping: a build that somehow kept the unwinder
    /// must fail loudly instead of hanging the process worker, which is the
    /// truthful-failure rule applied to this module's own floor.
    #[panic_handler]
    fn panic(_info: &core::panic::PanicInfo) -> ! {
        #[cfg(target_arch = "wasm32")]
        core::arch::wasm32::unreachable();
        // `core::arch::wasm64` does not exist, so express the same trap through
        // the language rather than the intrinsic.
        #[cfg(not(target_arch = "wasm32"))]
        unreachable!()
    }
}
