//! Synchronous C calls over the original side-module instrumentation library.
//!
//! All allocations and mapped outputs are released by this same Rust library.
//! This is not a dynamic loader or an alternative fork-metadata producer.
use fork_instrument::{
    artifact_io::{MappedArtifact, SpoolStorage},
    native,
};
use std::{
    ffi::{CString, c_char, c_int, c_void},
    fs::File,
    io::{self, Seek},
    os::fd::FromRawFd,
    panic::{AssertUnwindSafe, catch_unwind},
    ptr,
};

pub const OK: c_int = 0;
pub const INVALID_ARGUMENT: c_int = 1;
pub const TRANSFORM_ERROR: c_int = 2;
pub const PANIC: c_int = 3;

pub type CreateSpool = unsafe extern "C" fn(*mut c_void) -> c_int;

/// Opaque across C. Field layout is private and must never be copied by C.
pub struct InstrumentResult {
    bytes: Option<MappedArtifact>,
    error: Option<CString>,
}

impl InstrumentResult {
    /// Let a target emitter return an owned diagnostic through this same C
    /// result/release boundary without exposing Rust allocation internals.
    pub fn failure(message: String) -> Self {
        error_result(message)
    }
}

struct CallbackStorage {
    create: CreateSpool,
    context: *mut c_void,
}

// SAFETY: the unsafe C entry requires the factory to transfer a fresh private
// file, with no writable alias. No pointer to this factory escapes the call.
unsafe impl SpoolStorage for CallbackStorage {
    fn create(&self) -> io::Result<File> {
        // SAFETY: the caller keeps its factory/context valid until return.
        let fd = unsafe { (self.create)(self.context) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: every successful callback transfers sole fd ownership.
        let mut file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() != 0 {
            return Err(io::Error::other(
                "spool factory must return an empty regular file",
            ));
        }
        file.rewind()?;
        Ok(file)
    }
}

fn error_result(message: String) -> InstrumentResult {
    // Error chains may contain arbitrary input text. Preserve all UTF-8 bytes
    // apart from embedded NULs so the borrowed C error cannot be truncated.
    let mut bytes = message.into_bytes();
    for byte in &mut bytes {
        if *byte == 0 {
            *byte = b'?';
        }
    }
    InstrumentResult {
        bytes: None,
        error: Some(CString::new(bytes).expect("embedded NULs replaced")),
    }
}

/// Instrument one side module; see the matching C header for ownership rules.
///
/// # Safety
/// `output` points to writable pointer storage disjoint from input. Nonempty input is readable,
/// immutable and valid for `input_len` bytes until return. Factory/context
/// remain valid for this call; factory must not unwind and each successful fd
/// must meet SpoolStorage's exclusive private-file contract. No input, factory
/// or context is retained. Returned objects are released exactly once here.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kandelo_fork_instrument_side_module(
    input: *const u8,
    input_len: usize,
    output_limit: u64,
    create_spool: Option<CreateSpool>,
    context: *mut c_void,
    output: *mut *mut InstrumentResult,
) -> c_int {
    if output.is_null() {
        return INVALID_ARGUMENT;
    }
    // SAFETY: writable output storage is required by this entry's contract.
    unsafe {
        *output = ptr::null_mut();
    }
    let Some(create) = create_spool else {
        return INVALID_ARGUMENT;
    };
    if (input.is_null() && input_len != 0) || input_len > isize::MAX as usize || output_limit == 0 {
        return INVALID_ARGUMENT;
    }
    // SAFETY: the caller holds the immutable input borrow for this whole call.
    let input = if input_len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(input, input_len) }
    };
    let storage = CallbackStorage { create, context };
    // WHY: unwind-enabled builds must not unwind through C. On the current
    // panic=abort guest target this cannot catch a panic/OOM; qualification
    // must not confuse ordinary Result errors with recoverable Rust panics.
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        native::instrument_side_module_with_storage(
            input,
            native::Limits {
                output_bytes: output_limit,
                ..Default::default()
            },
            &storage,
        )
    }));
    let (status, result) = match outcome {
        Ok(Ok(artifact)) => (
            OK,
            InstrumentResult {
                bytes: Some(artifact.bytes),
                error: None,
            },
        ),
        Ok(Err(error)) => (TRANSFORM_ERROR, error_result(format!("{error:#}"))),
        Err(payload) => {
            // An arbitrary panic payload may itself panic during Drop. Keep
            // this exceptional payload from unwinding across the C boundary.
            std::mem::forget(payload);
            (
                PANIC,
                error_result("Rust side-module instrumentation panicked".into()),
            )
        }
    };
    // SAFETY: the caller owns this single Rust result and releases it below.
    unsafe {
        *output = Box::into_raw(Box::new(result));
    }
    status
}

/// # Safety
/// Non-null `result` is a live result from this library. `length` points to
/// writable size_t storage. Borrowed output ends when result is released.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kandelo_fork_instrument_bytes(
    result: *const InstrumentResult,
    length: *mut usize,
) -> *const u8 {
    if length.is_null() {
        return ptr::null();
    }
    unsafe {
        *length = 0;
    }
    if result.is_null() {
        return ptr::null();
    }
    let Some(bytes) = (unsafe { &*result }).bytes.as_ref() else {
        return ptr::null();
    };
    unsafe {
        *length = bytes.bytes().len();
    }
    bytes.bytes().as_ptr()
}

/// # Safety
/// Non-null result is live. The borrowed NUL-terminated error ends at release.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kandelo_fork_instrument_error(
    result: *const InstrumentResult,
) -> *const c_char {
    if result.is_null() {
        return ptr::null();
    }
    (unsafe { &*result })
        .error
        .as_ref()
        .map_or(ptr::null(), |error| error.as_ptr())
}

/// # Safety
/// Non-null result is a live, uniquely owned result from this library; no
/// access, borrowed output, concurrent reader or second release may follow.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kandelo_fork_instrument_release(result: *mut InstrumentResult) {
    if !result.is_null() {
        unsafe {
            drop(Box::from_raw(result));
        }
    }
}
