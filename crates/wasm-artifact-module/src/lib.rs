//! `crates/wasm-artifact-module` — the wasm face of the artifact reader.
//!
//! # Why this crate exists
//!
//! [`wasm_artifact`] is a `no_std + alloc` library. The kernel links it
//! directly (`kernel_exec_target_artifact_policy`), and the build tooling links
//! it natively. Between them they cover the `exec` path and the publish path,
//! and they cover **none** of the callers that keep `host/src/constants.ts` —
//! a hand-rolled 3,000-line WebAssembly binary reader — alive, because those
//! callers have no kernel to call:
//!
//! | caller | why no kernel export can serve it |
//! |---|---|
//! | `kernel.ts` `#compileKernelModule` | needs the artifact's pointer width to build the import object **before the kernel module is compiled** |
//! | `worker-main.ts`, `dylink.ts`, `fork-host-import-runtime.ts`, `wasm-module-reflection.ts` | run in the **process worker**, which holds no kernel instance |
//! | `binary-resolver.ts` | validates `kernel.wasm` itself, before any kernel exists |
//!
//! That is a bootstrap paradox for a kernel export and a non-problem for a
//! standalone module: this module **imports nothing at all** — not even
//! `env.memory` — so instantiating it depends on nothing that is not already
//! in the engine. `crates/dylink-module` established the shape; this follows
//! it, and `build-wasm.sh` verifies the zero-import property on every build
//! rather than asserting it in a comment.
//!
//! # What this crate is NOT
//!
//! It holds no policy. Every judgement — what the ABI epoch requires, what a
//! fork artifact must export, how a malformed container is described — lives in
//! [`wasm_artifact`], where it is shared with the kernel and the native host
//! and testable with plain `cargo test`. This crate is a byte transport: it
//! decodes a request, calls the library, encodes the answer. If a change here
//! would decide something about an artifact, the decision belongs one crate
//! down.
//!
//! # The memory contract, which a driver WILL get wrong once
//!
//! Every entry point may allocate, and allocating may grow this module's
//! memory, which detaches every existing `ArrayBuffer` view of it. A driver
//! must acquire each view immediately before use and never hold one across a
//! call. `host/src/wasm-artifact-driver.ts` is the only place that touches it.

#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]
#![forbid(unsafe_op_in_unsafe_fn)]

extern crate alloc;

pub mod wire;

use alloc::vec::Vec;
use core::cell::UnsafeCell;

use wasm_artifact::facts::{ArtifactFacts, BinaryValueType};
use wasm_artifact::{
    describe_artifact_policy_failures, detect_pointer_width, is_wasm_module, read_artifact_facts,
    read_custom_section, read_heap_base, ArtifactPolicy,
};

use wire::{Reader, Writer};

/// The call succeeded; any payload is in the output buffer.
pub const WA_OK: i32 = 0;
/// The call failed; the output buffer holds a UTF-8 description.
pub const WA_ERROR: i32 = -1;

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

/// The two byte buffers.
///
/// This module is stateless between calls by design: an artifact is bytes in
/// and an answer out, with nothing worth carrying across the boundary. The
/// driver caches per-artifact answers on the JavaScript side, where it can key
/// them by the `ArrayBuffer` it already holds; caching them here would mean
/// inventing an artifact identity the module has no way to check.
struct Buffers {
    /// The driver writes request bytes here; the module reads them.
    input: Vec<u8>,
    /// The module writes answer bytes here; the driver reads them.
    output: Vec<u8>,
}

/// A `static mut` reference is denied in this edition; an `UnsafeCell` in a
/// plain `static` expresses the same single-threaded ownership without one.
struct BufferCell(UnsafeCell<Buffers>);

// SAFETY: a worker runs one guest on one thread and every `wa_*` entry point is
// called from it. There is no concurrent access.
unsafe impl Sync for BufferCell {}

static BUFFERS: BufferCell = BufferCell(UnsafeCell::new(Buffers {
    input: Vec::new(),
    output: Vec::new(),
}));

fn buffers() -> &'static mut Buffers {
    // SAFETY: see the `Sync` justification above.
    unsafe { &mut *BUFFERS.0.get() }
}

/// The wire version this module speaks. A driver that does not recognise it
/// must refuse rather than decode optimistically.
#[unsafe(no_mangle)]
pub extern "C" fn wa_wire_version() -> u32 {
    wire::WIRE_VERSION
}

/// Reserve `len` bytes for the driver to write a request into, and return the
/// address.
///
/// This may grow the module's memory, so the caller MUST re-acquire its view
/// afterwards. See the memory contract in the crate docs.
#[unsafe(no_mangle)]
pub extern "C" fn wa_input_reserve(len: u32) -> usize {
    let input = &mut buffers().input;
    input.clear();
    input.resize(len as usize, 0);
    input.as_ptr() as usize
}

/// The address of the answer bytes from the last call.
#[unsafe(no_mangle)]
pub extern "C" fn wa_output_ptr() -> usize {
    buffers().output.as_ptr() as usize
}

/// The length of the answer bytes from the last call.
#[unsafe(no_mangle)]
pub extern "C" fn wa_output_len() -> u32 {
    buffers().output.len() as u32
}

/// Record a failure: the message goes to the output buffer so a caller that
/// checks the status can always render what happened.
fn fail(message: &str) -> i32 {
    buffers().output.clear();
    buffers().output.extend_from_slice(message.as_bytes());
    WA_ERROR
}

/// The first `len` bytes of the input buffer, or `None` when the driver
/// promised more than it wrote.
fn artifact(len: u32) -> Option<&'static [u8]> {
    buffers().input.get(..len as usize)
}

/// The bytes after the artifact, which is where a second payload — a section
/// name, a policy request — is written.
fn trailer(artifact_len: u32, trailer_len: u32) -> Option<&'static [u8]> {
    let start = artifact_len as usize;
    let end = start.checked_add(trailer_len as usize)?;
    buffers().input.get(start..end)
}

fn publish(bytes: Vec<u8>) {
    buffers().output = bytes;
}

// ---------------------------------------------------------------------------
// The cheap questions
// ---------------------------------------------------------------------------

/// Whether the bytes open with the WebAssembly preamble.
///
/// Kept as its own export rather than folded into the facts blob because it is
/// the only question some callers ask, and answering it must not require the
/// container to be walkable — a non-wasm file is a legitimate, expected answer
/// here, not a failure.
#[unsafe(no_mangle)]
pub extern "C" fn wa_is_wasm_module(len: u32) -> u32 {
    match artifact(len) {
        Some(bytes) => u32::from(is_wasm_module(bytes)),
        None => 0,
    }
}

/// The artifact's pointer width in bytes: 4 for wasm32, 8 for wasm64.
///
/// This is the **bootstrap floor**. `kernel.ts` calls it to build the kernel's
/// import object before the kernel module is compiled, so it must answer
/// without a kernel, without a full container walk succeeding, and without
/// allocating a report. A module with no memory at all is wasm32: that is the
/// default data model, and a memory-less module has no pointers to disagree
/// about.
#[unsafe(no_mangle)]
pub extern "C" fn wa_detect_pointer_width(len: u32) -> u32 {
    match artifact(len) {
        Some(bytes) => u32::from(detect_pointer_width(bytes)),
        None => 4,
    }
}

/// The payload of the first custom section named by the trailer bytes.
///
/// Returns 1 with the payload in the output buffer when present, 0 with an
/// empty output buffer when absent, and [`WA_ERROR`] when the request itself
/// was malformed. Absent and malformed are deliberately distinct: a legacy
/// artifact with no ABI-contract stamp is a rollout state the policy warns
/// about, while a request the module could not read is a defect in the driver.
#[unsafe(no_mangle)]
pub extern "C" fn wa_custom_section(artifact_len: u32, name_len: u32) -> i32 {
    let Some(bytes) = artifact(artifact_len) else {
        return fail("artifact length exceeds the bytes written to the input buffer");
    };
    let Some(name_bytes) = trailer(artifact_len, name_len) else {
        return fail("section-name length exceeds the bytes written to the input buffer");
    };
    let Ok(name) = core::str::from_utf8(name_bytes) else {
        return fail("section name is not valid UTF-8");
    };
    match read_custom_section(bytes, name) {
        Some(payload) => {
            publish(payload.to_vec());
            1
        }
        None => {
            buffers().output.clear();
            0
        }
    }
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

fn write_binary_value_type(writer: &mut Writer, ty: &BinaryValueType) {
    writer.u8(ty.code);
    writer.bool(ty.heap_type.is_some());
    writer.i64(ty.heap_type.unwrap_or(0));
    writer.bool(ty.shared);
}

/// Encode everything one walk established.
///
/// The blob is deliberately whole rather than a family of narrow exports: the
/// expensive part is the container walk, and a driver that asked five questions
/// through five exports would walk five times. One walk, one blob, and the
/// driver caches it against the `ArrayBuffer` it already holds.
fn encode_facts(bytes: &[u8], facts: &ArtifactFacts) -> Vec<u8> {
    let mut writer = Writer::versioned();

    writer.u8(facts.pointer_width());
    writer.option_i32(wasm_artifact::read_abi_version(bytes));
    writer.option_u64(read_heap_base(bytes));
    writer.option_i32(wasm_artifact::read_thread_slot_declaration(bytes));
    writer.bool(facts.contains_legacy_asyncify);
    writer.bool(facts.imports_kernel_fork);
    writer.bool(facts.is_relocatable);
    writer.bool(facts.has_fork_artifact_surface());

    writer.strings(&facts.custom_section_names);

    writer.u32(facts.import_descriptors.len() as u32);
    for descriptor in &facts.import_descriptors {
        writer.string(&descriptor.module);
        writer.string(&descriptor.name);
        writer.u8(descriptor.kind.code());
    }

    writer.u32(facts.export_descriptors.len() as u32);
    for descriptor in &facts.export_descriptors {
        writer.string(&descriptor.name);
        writer.u8(descriptor.kind.code());
    }

    writer.u32(facts.function_import_entries.len() as u32);
    for entry in &facts.function_import_entries {
        writer.string(&entry.module);
        writer.string(&entry.name);
        writer.u32(entry.import_ordinal);
        writer.u32(entry.function_index);
        writer.u32(entry.params.len() as u32);
        for ty in &entry.params {
            write_binary_value_type(&mut writer, ty);
        }
        writer.u32(entry.results.len() as u32);
        for ty in &entry.results {
            write_binary_value_type(&mut writer, ty);
        }
    }

    writer.u32(facts.function_type_indices.len() as u32);
    for index in &facts.function_type_indices {
        writer.u32(*index);
    }

    writer.u32(facts.type_arities.len() as u32);
    for arity in &facts.type_arities {
        writer.bool(arity.is_some());
        let (params, results) = arity.unwrap_or((0, 0));
        writer.u32(params);
        writer.u32(results);
    }

    writer.into_bytes()
}

/// Walk the artifact once and publish every fact.
///
/// A malformed container is [`WA_ERROR`] with the reason in the output buffer,
/// not a partial fact set: a partial set reads as "requirement absent" and
/// would turn a corrupt artifact into a misleading *contract* failure.
#[unsafe(no_mangle)]
pub extern "C" fn wa_read_facts(len: u32) -> i32 {
    let Some(bytes) = artifact(len) else {
        return fail("artifact length exceeds the bytes written to the input buffer");
    };
    match read_artifact_facts(bytes) {
        Ok(facts) => {
            publish(encode_facts(bytes, &facts));
            WA_OK
        }
        Err(error) => fail(&error.0),
    }
}

/// The complete ABI-epoch fork-artifact contract for this artifact.
///
/// Separate from [`wa_read_facts`] because it is asked only of artifacts that
/// carry the transform: for an ordinary program every requirement is trivially
/// unmet, so folding it into the facts blob would build a long list of
/// irrelevant failures on every process launch.
#[unsafe(no_mangle)]
pub extern "C" fn wa_fork_contract(len: u32) -> i32 {
    let Some(bytes) = artifact(len) else {
        return fail("artifact length exceeds the bytes written to the input buffer");
    };
    let facts = match read_artifact_facts(bytes) {
        Ok(facts) => facts,
        Err(error) => {
            // The TypeScript this replaces reported an unreadable artifact as a
            // contract failure naming the epoch, so a caller that only renders
            // failures still says something true. Preserved deliberately.
            let mut writer = Writer::versioned();
            let message = alloc::format!(
                "cannot validate ABI {} fork-artifact contract: {}",
                wasm_posix_shared::ABI_VERSION,
                error.0
            );
            writer.strings(&[message]);
            publish(writer.into_bytes());
            return WA_OK;
        }
    };
    let failures =
        wasm_artifact::fork_contract::describe_fork_contract_failures(
            &facts,
            wasm_posix_shared::ABI_VERSION,
        );
    let mut writer = Writer::versioned();
    writer.strings(&failures);
    publish(writer.into_bytes());
    WA_OK
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/// `require_fork_instrumentation` is a tri-state on the wire: the library takes
/// `Option<bool>`, where `None` means "decide from the artifact".
const REQUIRE_FORK_AUTO: u8 = 2;

/// Judge the artifact against a policy the driver encodes in the trailer.
///
/// The report separates failures from warnings because whether a missing
/// rollout marker deserves a console line is a host decision, and a decision
/// made inside a `no_std` library cannot be un-made by its caller.
#[unsafe(no_mangle)]
pub extern "C" fn wa_policy(artifact_len: u32, request_len: u32) -> i32 {
    let Some(bytes) = artifact(artifact_len) else {
        return fail("artifact length exceeds the bytes written to the input buffer");
    };
    let Some(request_bytes) = trailer(artifact_len, request_len) else {
        return fail("policy-request length exceeds the bytes written to the input buffer");
    };
    let Some(mut request) = Reader::versioned(request_bytes) else {
        return fail("policy request has an unrecognised wire version");
    };

    let malformed = "policy request is malformed";
    let Some(has_expected_abi) = request.bool() else {
        return fail(malformed);
    };
    let Some(expected_abi_value) = request.u32() else {
        return fail(malformed);
    };
    let Some(has_digest) = request.bool() else {
        return fail(malformed);
    };
    let Some(digest) = request.bytes() else {
        return fail(malformed);
    };
    let Some(required_exports) = request.strings() else {
        return fail(malformed);
    };
    let Some(forbidden_exports) = request.strings() else {
        return fail(malformed);
    };
    let Some(require_fork) = request.u8() else {
        return fail(malformed);
    };
    let Some(forbid_fork) = request.bool() else {
        return fail(malformed);
    };

    let policy = ArtifactPolicy {
        expected_abi: has_expected_abi.then_some(expected_abi_value),
        expected_abi_contract_digest: has_digest.then_some(digest),
        required_exports: &required_exports,
        forbidden_exports: &forbidden_exports,
        require_fork_instrumentation: match require_fork {
            REQUIRE_FORK_AUTO => None,
            other => Some(other != 0),
        },
        forbid_fork_instrumentation: forbid_fork,
    };

    let report = describe_artifact_policy_failures(bytes, &policy);
    let mut writer = Writer::versioned();
    writer.strings(&report.failures);
    writer.strings(&report.warnings);
    publish(writer.into_bytes());
    WA_OK
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
    /// A process worker validates one artifact after another over its lifetime,
    /// and each walk allocates its fact set and its report. A bump allocator —
    /// the shape `crates/fork-module` uses, because its state is reset once per
    /// fork — would turn ordinary validation churn into eventual exhaustion of
    /// this module's linear memory.
    ///
    /// `dlmalloc`'s wasm backend grows from the end of THIS module's own linear
    /// memory, which the module owns outright, importing no memory from anyone.
    /// So it adds no import and cannot collide with guest data.
    struct ModuleAllocator(UnsafeCell<Dlmalloc>);

    // SAFETY: a worker runs one guest on one thread, and every `wa_*` entry
    // point is called from it. There is no concurrent access.
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
    /// It traps rather than looping: a build that somehow kept the unwinder must
    /// fail loudly instead of hanging the worker, which is the truthful-failure
    /// rule applied to this module's own floor.
    #[panic_handler]
    fn panic(_info: &core::panic::PanicInfo) -> ! {
        #[cfg(target_arch = "wasm32")]
        core::arch::wasm32::unreachable();
        #[cfg(not(target_arch = "wasm32"))]
        unreachable!()
    }
}
