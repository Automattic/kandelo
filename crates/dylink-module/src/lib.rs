//! `crates/dylink-module` — the wasm face of the dynamic-linking planner.
//!
//! # Why this crate exists
//!
//! [`dylink`] is a pure Rust library with a Rust-native session API.
//! `crates/host-native` links it directly and matches on the enums, so on a
//! native host the planner needs nothing else. On the two JavaScript hosts it
//! needs one thing it does not have: **a wasm entry point**. Without one,
//! nothing on Node or in the browser can call the planner at all.
//!
//! This crate is that entry point. It is deliberately thin: one session, two
//! byte buffers, and a `dl_*` export per session method. Every decision the
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
//! # One drive loop, four kinds of transaction
//!
//! ```text
//!   dl_configure(config)            once per process
//!   dl_publish_main_image(image)    once per process, before any dlopen
//!
//!   token = dl_open_begin(request)  |  dl_sym_begin(handle, name)
//!                                   |  dl_close_begin(handle)
//!   loop {
//!       dl_step(token)              -> encoded PlanStep in the output buffer
//!       match step {
//!           Act | Host | Call  => execute it, dl_resume(token, ActResult)
//!           Finished           => break
//!       }
//!   }
//!   dl_open_finish(token, replay)   |  dl_sym_address(token)
//!                                   |  dl_close_result(token)
//! ```
//!
//! The fork half — reading the process archive, publishing it, and reconciling
//! a child against it — is the same loop over the same session and lands with
//! `crates/dylink`'s archive planner.
//!
//! A failed transaction calls [`dl_abort`] instead. Abort does not end the
//! drive loop: it re-arms it with the rollback work, so the SAME loop drains
//! the release requests and then sees `Finished`. There is one drive loop, not
//! two, and it is the same loop for every transaction kind.
//!
//! # Transactions are concurrent on purpose
//!
//! A constructor calling `dlopen` is legal POSIX, and
//! [`dylink::scope::LoadState::Initializing`] exists for it. Tokens are
//! allocated from a counter that is not the handle counter, they are private to
//! libc's prepare/next/commit protocol, and a second `dl_open_begin` while one
//! is in flight is an ordinary nested load rather than a refusal.

#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]
#![forbid(unsafe_op_in_unsafe_fn)]

extern crate alloc;

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use core::cell::UnsafeCell;

use dylink::session::{MemoryOwnership, Session};
use dylink::{DylinkError, PlanStep};

/// The call succeeded. Any payload is in the output buffer.
pub const DL_OK: i32 = 0;
/// The call failed. [`dl_error`] renders what happened.
pub const DL_ERROR: i32 = -1;

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

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
    /// The pending `dlerror` message.
    error: Option<String>,
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
    error: None,
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
        return fail("no linker session; call dl_configure first");
    };
    match body(state) {
        Ok(()) => {
            buffers().error = None;
            DL_OK
        }
        Err(error) => {
            buffers().output.clear();
            buffers().error = Some(error.to_string());
            DL_ERROR
        }
    }
}

/// The same, for an entry point whose answer is a scalar rather than bytes.
/// `-1` is the failure value for every one of them.
fn with_session_i64(body: impl FnOnce(&mut Session) -> Result<i64, DylinkError>) -> i64 {
    buffers().output.clear();
    let Some(state) = session().as_mut() else {
        fail("no linker session; call dl_configure first");
        return -1;
    };
    match body(state) {
        Ok(value) => {
            buffers().error = None;
            value
        }
        Err(error) => {
            buffers().output.clear();
            buffers().error = Some(error.to_string());
            -1
        }
    }
}

fn fail(message: &str) -> i32 {
    buffers().output.clear();
    buffers().error = Some(message.to_string());
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
///
/// A message set by the loader itself — a failed load, an invalid handle —
/// takes precedence over one the session recorded for a `dlsym` miss, because
/// the failure the caller is asking about is the one that just happened.
#[unsafe(no_mangle)]
pub extern "C" fn dl_error() -> u32 {
    let message = match buffers().error.take() {
        Some(message) => Some(message),
        None => session().as_mut().and_then(|state| state.handles.take_error()),
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
/// Called once per process. Calling it again replaces the session wholesale,
/// which is what `exec` needs: the new image shares no loader state with the
/// old one.
#[unsafe(no_mangle)]
pub extern "C" fn dl_configure(len: u32) -> i32 {
    buffers().output.clear();
    let config = match request(len).and_then(dylink::wire::decode_linker_config) {
        Ok(config) => config,
        Err(error) => {
            // A malformed config leaves NO session. Creating a
            // default-configured one here would be the silent-success shape
            // this project treats as a defect: the process would link against a
            // pointer width nobody chose.
            *session() = None;
            return fail(&error.to_string());
        }
    };
    *session() = Some(Session::new(config));
    buffers().error = None;
    DL_OK
}

/// Drop all loader state. `exec` replaces the process image, so the next
/// [`dl_configure`] starts from nothing.
#[unsafe(no_mangle)]
pub extern "C" fn dl_reset() {
    *session() = None;
}

/// Adopt the process's existing exception tags under the ids the driver has
/// already bound them to. Pass -1 for a tag the process does not have.
///
/// C++ exceptions and `longjmp` crossing a side-module call require tag
/// IDENTITY, not just a matching payload type, and the identity is the main
/// image's. A planner that created its own tags would give every side module a
/// realm the main image cannot catch in, which fails only when an exception
/// actually crosses — long after the load looked successful.
#[unsafe(no_mangle)]
pub extern "C" fn dl_adopt_process_tags(longjmp: i32, cpp_exception: i32) -> i32 {
    with_session(|state| {
        let tag = |value: i32| -> Result<Option<dylink::TagId>, DylinkError> {
            match value {
                -1 => Ok(None),
                id if id >= 0 => Ok(Some(dylink::TagId(id as u32))),
                _ => Err(DylinkError::MalformedModule("tag id must be -1 or non-negative")),
            }
        };
        let longjmp = tag(longjmp)?;
        let cpp_exception = tag(cpp_exception)?;
        state.adopt_process_tags(longjmp, cpp_exception);
        Ok(())
    })
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
// The drive loop
// ---------------------------------------------------------------------------

/// Ask what the driver must do next for `token`. The encoded `PlanStep` lands
/// in the output buffer.
#[unsafe(no_mangle)]
pub extern "C" fn dl_step(token: u32) -> i32 {
    with_session(|state| {
        let step = state.step(token)?;
        buffers().output = dylink::wire::encode_plan_step(&step)?;
        Ok(())
    })
}

/// Answer the last step with an encoded `ActResult`.
#[unsafe(no_mangle)]
pub extern "C" fn dl_resume(token: u32, len: u32) -> i32 {
    with_session(|state| {
        let result = dylink::wire::decode_act_result(request(len)?)?;
        state.resume(token, result)
    })
}

/// Abandon the transaction in flight and re-arm its drive loop with the
/// rollback.
///
/// The output buffer carries the table range to reclaim, when there is one:
/// `[1][u64 first][u64 length]`, or `[0]`. A `WebAssembly.Table` cannot shrink,
/// so the length stays and the driver nulls the slots.
#[unsafe(no_mangle)]
pub extern "C" fn dl_abort(token: u32) -> i32 {
    with_session(|state| {
        let range = state.abort(token)?;
        let output = &mut buffers().output;
        match range {
            Some((first, length)) => {
                output.push(1);
                output.extend_from_slice(&first.to_le_bytes());
                output.extend_from_slice(&length.to_le_bytes());
            }
            None => output.push(0),
        }
        Ok(())
    })
}

/// Forget a transaction whose rollback has drained.
#[unsafe(no_mangle)]
pub extern "C" fn dl_discard(token: u32) {
    if let Some(state) = session().as_mut() {
        state.discard(token);
    }
}

/// Has `token`'s drive loop reached `Finished`?
///
/// A transaction whose staged initializer is still outstanding is not a FAILED
/// transaction — it is one the guest has not finished driving. Committing it
/// early is a misuse the caller must be able to distinguish from a load that
/// cannot complete, because rolling back on that mistake would destroy a
/// `dlopen` that was going to succeed.
#[unsafe(no_mangle)]
pub extern "C" fn dl_finished(token: u32) -> i32 {
    match session().as_ref() {
        Some(state) => i32::from(state.is_finished(token)),
        None => 0,
    }
}

/// Is `token` a live transaction?
///
/// The driver's own `Map` of pending tokens is gone: this is the authority, and
/// asking it costs one call rather than a second copy of the state that can
/// disagree with the first.
#[unsafe(no_mangle)]
pub extern "C" fn dl_pending(token: u32) -> i32 {
    match session().as_ref() {
        Some(state) => i32::from(state.contains(token)),
        None => 0,
    }
}

// ---------------------------------------------------------------------------
// dlopen
// ---------------------------------------------------------------------------

/// Begin a `dlopen` from an encoded `LoadRequest`. Returns the transaction
/// token, or [`DL_ERROR`].
#[unsafe(no_mangle)]
pub extern "C" fn dl_open_begin(len: u32) -> i32 {
    with_session_i64(|state| {
        let load_request = dylink::wire::decode_load_request(request(len)?)?;
        let token = state.open_begin(load_request)?;
        Ok(i64::from(token))
    }) as i32
}

/// Complete the load and return its `dlopen` handle, or [`DL_ERROR`].
///
/// `replay_handle` pins the parent's exact handle during fork replay; pass -1
/// for an ordinary load. The guest holds the parent's handle values in its own
/// memory, so a child that renumbered them would hand back a handle the program
/// has never seen.
///
/// `i32` rather than `i64` deliberately: handles are allocated from 2 upwards,
/// one per live `dlopen`, so they cannot approach `i32::MAX`, and an `i64`
/// parameter would force every JavaScript caller to pass a `BigInt` for a small
/// counter.
#[unsafe(no_mangle)]
pub extern "C" fn dl_open_finish(token: u32, replay_handle: i32) -> i32 {
    with_session_i64(|state| {
        let replay = match replay_handle {
            -1 => None,
            handle if handle >= 0 => Some(handle as u32),
            _ => {
                return Err(DylinkError::HandleOutOfRange {
                    handle: replay_handle as u32,
                })
            }
        };
        Ok(i64::from(state.open_finish(token, replay)?))
    }) as i32
}

/// Record where the driver published the staged `() -> ()` entry the last
/// [`PlanStep::Call`] named.
///
/// The slot is an engine fact only the driver has, and a fork child needs it to
/// resume an interrupted `dlopen` at the exact continuation point.
#[unsafe(no_mangle)]
pub extern "C" fn dl_note_staged_slot(token: u32, table_index: u64) -> i32 {
    with_session(|state| state.note_staged_slot(token, table_index))
}

// ---------------------------------------------------------------------------
// Plan accessors
// ---------------------------------------------------------------------------

/// The layout the planner chose for the object currently being linked, for the
/// caller that has to record it. Each field returns -1 for "absent" rather than
/// zero, because zero is a legal value for every one of them.
#[unsafe(no_mangle)]
pub extern "C" fn dl_plan_instance(token: u32) -> i64 {
    with_plan(token, |plan| plan.instance().index() as i64)
}

/// The plan's `__memory_base`, or -1.
#[unsafe(no_mangle)]
pub extern "C" fn dl_plan_memory_base(token: u32) -> i64 {
    with_plan(token, |plan| plan.memory_base() as i64)
}

/// The plan's `__table_base`, or -1.
#[unsafe(no_mangle)]
pub extern "C" fn dl_plan_table_base(token: u32) -> i64 {
    with_plan(token, |plan| plan.table_base() as i64)
}

/// The plan's TLS base, or -1 when the object has no TLS.
#[unsafe(no_mangle)]
pub extern "C" fn dl_plan_tls_base(token: u32) -> i64 {
    with_plan(token, |plan| plan.tls_base().map(|base| base as i64).unwrap_or(-1))
}

/// The fork activation the plan reserved, or -1 when it reserved none.
#[unsafe(no_mangle)]
pub extern "C" fn dl_plan_activation(token: u32) -> i64 {
    with_plan(token, |plan| {
        plan.activation_id()
            .map(|activation| activation as i64)
            .unwrap_or(-1)
    })
}

fn with_plan(token: u32, body: impl FnOnce(&dylink::LinkPlan) -> i64) -> i64 {
    match session().as_ref().and_then(|state| state.active_plan(token)) {
        Some(plan) => body(plan),
        None => -1,
    }
}

// ---------------------------------------------------------------------------
// dlsym
// ---------------------------------------------------------------------------

/// Begin a `dlsym`. The input buffer holds the symbol name. Returns the
/// transaction token to drive, or [`DL_ERROR`].
///
/// This is a transaction rather than a plain call because a resolved function
/// may have no indirect-function-table slot yet, and taking one is a table
/// mutation only the driver can perform. A C function pointer IS that index.
#[unsafe(no_mangle)]
pub extern "C" fn dl_sym_begin(handle: u32, len: u32) -> i32 {
    with_session_i64(|state| {
        let name = core::str::from_utf8(request(len)?)
            .map_err(|_| DylinkError::MalformedModule("dlsym name is not UTF-8"))?;
        // Copied out of the input buffer: the session may write the output
        // buffer while this borrow is live, and two live `&mut` into `Buffers`
        // have no business in code an optimizer is free to reason about.
        let name = name.to_string();
        Ok(i64::from(state.sym_begin(handle, &name)?))
    }) as i32
}

/// The resolved address, or -1 for a miss.
///
/// A miss is a successful call: POSIX reports it through `dlerror`, and
/// conflating the two would make a legitimately absent weak symbol
/// indistinguishable from a broken lookup. -1 rather than 0 because address
/// zero is a legal data address.
#[unsafe(no_mangle)]
pub extern "C" fn dl_sym_address(token: u32) -> i64 {
    with_session_i64(|state| {
        Ok(match state.sym_result(token)? {
            Some(address) => i64::try_from(address)
                .map_err(|_| DylinkError::MalformedModule("symbol address exceeds i64"))?,
            None => -1,
        })
    })
}

// ---------------------------------------------------------------------------
// dlclose
// ---------------------------------------------------------------------------

/// Begin a `dlclose`. Returns the transaction token to drive, or [`DL_ERROR`].
#[unsafe(no_mangle)]
pub extern "C" fn dl_close_begin(handle: u32) -> i32 {
    with_session_i64(|state| Ok(i64::from(state.close_begin(handle)?))) as i32
}

/// What the `dlclose` did. The output buffer receives an encoded
/// `CloseOutcome`.
#[unsafe(no_mangle)]
pub extern "C" fn dl_close_result(token: u32) -> i32 {
    with_session(|state| {
        let outcome = state.close_result(token)?;
        buffers().output = dylink::wire::encode_close_outcome(&outcome)?;
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// The archive in guest memory
// ---------------------------------------------------------------------------

/// Read the process archive whose header is at `head` into the session.
///
/// The archive's records live in GUEST linear memory, which this module cannot
/// address: it imports nothing at all. So the read is a transaction like every
/// other one — the session walks the record chain by asking the driver for one
/// byte range at a time and decodes what comes back. Drive the token, then call
/// [`dl_archive_read_finish`].
///
/// A `head` of zero is a process that has never published, which decodes to
/// nothing rather than to an error.
///
/// `memory_len` is the CURRENT size of guest linear memory. Memory grows, and a
/// record allocated past the size this session was configured with would be
/// refused as out of bounds — a stale bound reads as a corrupt archive, which
/// is the least diagnosable failure this format has.
#[unsafe(no_mangle)]
pub extern "C" fn dl_archive_read_begin(head: u64, memory_len: u64) -> i32 {
    with_session_i64(|state| Ok(i64::from(state.archive_read_begin(head, memory_len)?))) as i32
}

/// Keep what the read walked as this session's view of the archive.
#[unsafe(no_mangle)]
pub extern "C" fn dl_archive_read_finish(token: u32) -> i32 {
    with_session(|state| state.archive_read_finish(token))
}

/// Publish the loader's current state into the process archive.
///
/// The session decides the layout, which records may keep their addresses, and
/// which must be replaced whole because a reachable record may never be resized
/// beneath a pthread reader. The driver allocates, copies bytes, stores the
/// generation, and releases — nothing else. Drive the token, then call
/// [`dl_archive_sync_finish`].
#[unsafe(no_mangle)]
pub extern "C" fn dl_archive_sync_begin() -> i32 {
    with_session_i64(|state| Ok(i64::from(state.archive_sync_begin()?))) as i32
}

/// The archive head address and generation the sync published, as
/// `[u64 head][u64 generation]` in the output buffer.
#[unsafe(no_mangle)]
pub extern "C" fn dl_archive_sync_finish(token: u32) -> i32 {
    with_session(|state| {
        let (head, generation) = state.archive_sync_finish(token)?;
        let output = &mut buffers().output;
        output.extend_from_slice(&head.to_le_bytes());
        output.extend_from_slice(&generation.to_le_bytes());
        Ok(())
    })
}

/// Does the decoded archive describe a process that ever loaded anything?
///
/// A child whose parent had no shared objects and no staged transaction has
/// nothing to reconcile, and asking the module is one call rather than a second
/// copy of the state in the driver.
#[unsafe(no_mangle)]
pub extern "C" fn dl_archive_is_empty() -> i32 {
    match session().as_ref() {
        Some(state) => i32::from(state.archive_is_empty()),
        None => 1,
    }
}

/// The generation of the archive the last [`dl_archive_read_begin`] decoded, or
/// -1 with no session.
#[unsafe(no_mangle)]
pub extern "C" fn dl_archive_generation(token: u32) -> i64 {
    let _ = token;
    match session().as_ref() {
        Some(state) => state.archive_generation() as i64,
        None => -1,
    }
}

/// Begin a fork reconcile against the archive the last read decoded.
///
/// `borrowed` is 1 for a `vfork` child sharing the suspended parent's live
/// memory, where loader-controlled instantiation must be provably read-only.
#[unsafe(no_mangle)]
pub extern "C" fn dl_fork_reconcile_begin(borrowed: i32) -> i32 {
    with_session_i64(|state| {
        let ownership = if borrowed == 0 {
            MemoryOwnership::Copied
        } else {
            MemoryOwnership::Borrowed
        };
        Ok(i64::from(state.reconcile_decoded_begin(ownership)?))
    }) as i32
}

/// The transactions the last reconcile restored, as
/// `[u32 count][(u32 token, u64 table slot)...]`.
///
/// The driver publishes each one's staged entry into the slot the parent
/// recorded — not a fresh one — because the guest's copied memory already names
/// that index, and libc will call `__wasm_dlopen_next(token)` on it.
#[unsafe(no_mangle)]
pub extern "C" fn dl_restored_transactions() -> i32 {
    with_session(|state| {
        let restored = state.restored_transactions();
        let mut output = Vec::new();
        output.extend_from_slice(&(restored.len() as u32).to_le_bytes());
        for (token, slot) in restored {
            output.extend_from_slice(&token.to_le_bytes());
            output.extend_from_slice(&slot.to_le_bytes());
        }
        buffers().output = output;
        Ok(())
    })
}

/// Adopt the parent's handle table once the reconcile's drive loop has
/// finished.
#[unsafe(no_mangle)]
pub extern "C" fn dl_fork_reconcile_finish(token: u32) -> i32 {
    with_session(|state| state.reconcile_decoded_finish(token))
}

/// Hand the activation coordinator's funcref table patches to the archive.
///
/// They are not loader state, but they ride in the same record chain and under
/// the same generation fence, so publishing them is publishing the archive. The
/// input buffer holds an encoded patch list.
#[unsafe(no_mangle)]
pub extern "C" fn dl_archive_set_table_patches(len: u32) -> i32 {
    with_session(|state| {
        let patches = dylink::wire::decode_table_patches(request(len)?)?;
        state.set_table_patches(patches);
        Ok(())
    })
}

/// Seal a typed table snapshot at `root`. Patches published before a checkpoint
/// are superseded by it, so they are dropped rather than carried forward.
#[unsafe(no_mangle)]
pub extern "C" fn dl_archive_set_table_state_root(root: u64) -> i32 {
    with_session(|state| state.set_table_state_root(root))
}

/// Append one funcref patch to the journal the next publication carries.
///
/// Returns 1 when it fits and 0 when the journal is full, in which case the
/// caller must take a full table checkpoint instead. The limits are the KFLA
/// format's, so the answer is the format's to give: a driver that guessed them
/// would publish a record the decoder then refuses.
#[unsafe(no_mangle)]
pub extern "C" fn dl_archive_append_table_patch(len: u32) -> i32 {
    with_session_i64(|state| {
        let mut patches = dylink::wire::decode_table_patches(request(len)?)?;
        let Some(patch) = patches.pop() else {
            return Err(DylinkError::MalformedModule("no table patch to append"));
        };
        Ok(i64::from(state.append_table_patch(patch)))
    }) as i32
}

/// The archived objects a fork child must name before it reconciles, as
/// `[(name, activation id, image bytes)]`.
///
/// A child builds its activation-to-module map for reference decoding BEFORE
/// any object is rebuilt, because module and reference recipes name activation
/// coordinates rather than whichever instance happens to load first.
#[unsafe(no_mangle)]
pub extern "C" fn dl_archive_modules() -> i32 {
    with_session(|state| {
        buffers().output = dylink::wire::encode_archived_modules(state.archived_modules())?;
        Ok(())
    })
}

/// Would [`dl_archive_append_table_patch`] accept this patch?
///
/// Asked BEFORE the caller commits to a patch, so a journal that is full leads
/// to a full table checkpoint rather than to a record the decoder refuses.
#[unsafe(no_mangle)]
pub extern "C" fn dl_archive_can_append_table_patch(len: u32) -> i32 {
    with_session_i64(|state| {
        let patches = dylink::wire::decode_table_patches(request(len)?)?;
        let Some(patch) = patches.first() else {
            return Err(DylinkError::MalformedModule("no table patch to measure"));
        };
        Ok(i64::from(state.can_append_table_patch(patch)))
    }) as i32
}

/// The archive's table-replication state, as
/// `[u64 generation][u64 tableStateRoot][u64 checkpointGeneration][patches]`.
///
/// This is the only part of the archive a driver reads back, because the
/// funcref table replica is the one consumer that is not the loader. The
/// modules and transactions never cross the boundary: a reconcile drives them
/// from inside.
#[unsafe(no_mangle)]
pub extern "C" fn dl_archive_table_state() -> i32 {
    with_session(|state| {
        let (generation, root, checkpoint, patches) = state.table_state();
        let mut output = Vec::new();
        output.extend_from_slice(&generation.to_le_bytes());
        output.extend_from_slice(&root.to_le_bytes());
        output.extend_from_slice(&checkpoint.to_le_bytes());
        output.extend_from_slice(&dylink::wire::encode_table_patch_journal(patches)?);
        buffers().output = output;
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

// A `PlanStep` reference keeps the doc link above resolvable without pulling
// the enum into the entry points, which deal only in encoded bytes.
#[allow(dead_code)]
type DocPlanStep = PlanStep;
