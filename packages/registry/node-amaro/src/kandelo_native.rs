//! Private guest C ABI. The JavaScript wrapper and portable SWC owners stay
//! upstream. Options JSON is an internal typed wire representation, not a
//! replacement for JavaScript option conversion (and must not use toJSON).
use super::{operate, Options, GLOBALS};
use std::{
    alloc::{alloc, Layout},
    any::Any,
    panic::{catch_unwind, AssertUnwindSafe},
    ptr, slice, str,
};

const OK: i32 = 0;
const DIAGNOSTIC: i32 = 1;
const WIRE_ERROR: i32 = 2;
const RESOURCE_ERROR: i32 = 3;
const PANIC: i32 = 4;
pub(super) enum Payload {
    Static(&'static [u8]),
    Bytes(Vec<u8>),
    Panic(Box<dyn Any + Send>),
}
pub struct NativeResult {
    pub(super) kind: i32,
    pub(super) payload: Payload,
}
impl NativeResult {
    fn bytes(&self) -> &[u8] {
        match &self.payload {
            Payload::Static(bytes) => bytes,
            Payload::Bytes(bytes) => bytes,
            Payload::Panic(value) => {
                if let Some(message) = value.downcast_ref::<String>() {
                    message.as_bytes()
                } else if let Some(message) = value.downcast_ref::<&str>() {
                    message.as_bytes()
                } else {
                    b"unexpected Rust panic"
                }
            }
        }
    }
}
#[no_mangle]
pub extern "C" fn kandelo_amaro_abi_version() -> u32 {
    1
}

/// Borrows valid, disjoint input spans for this call only. Output is writable
/// and owns a result until release; all result bytes remain in the library's
/// allocator. The caller must keep the library loaded through release.
#[no_mangle]
pub unsafe extern "C" fn kandelo_amaro_transform(
    source: *const u8,
    source_len: usize,
    options: *const u8,
    options_len: usize,
    output: *mut *mut NativeResult,
) -> i32 {
    if output.is_null() {
        return WIRE_ERROR;
    }
    unsafe {
        *output = ptr::null_mut();
    }
    if source_len > isize::MAX as usize
        || options_len > isize::MAX as usize
        || (source.is_null() && source_len != 0)
        || (options.is_null() && options_len != 0)
    {
        return WIRE_ERROR;
    }
    // Reserve the small result owner fallibly before entering upstream code.
    // A caught panic can then retain its existing payload without allocating.
    let owner = unsafe { alloc(Layout::new::<NativeResult>()) as *mut NativeResult };
    if owner.is_null() {
        return RESOURCE_ERROR;
    }
    unsafe {
        owner.write(NativeResult {
            kind: WIRE_ERROR,
            payload: Payload::Static(b"unfinished native transform"),
        });
        *output = owner;
    }
    let result = catch_unwind(AssertUnwindSafe(|| {
        let source = if source_len == 0 {
            &[][..]
        } else {
            unsafe { slice::from_raw_parts(source, source_len) }
        };
        let options = if options_len == 0 {
            &[][..]
        } else {
            unsafe { slice::from_raw_parts(options, options_len) }
        };
        let input = match str::from_utf8(source) {
            Ok(value) => value.to_owned(),
            Err(_) => {
                return NativeResult {
                    kind: WIRE_ERROR,
                    payload: Payload::Static(b"native source is not UTF-8"),
                }
            }
        };
        let options: Options = match serde_json::from_slice(options) {
            Ok(value) => value,
            Err(error) => {
                return NativeResult {
                    kind: WIRE_ERROR,
                    payload: Payload::Bytes(error.to_string().into_bytes()),
                }
            }
        };
        // Reuse the complete original transform, handler and reporter owners.
        let transformed = GLOBALS.set(&Default::default(), || operate(input, options));
        let (kind, bytes) = match transformed {
            Ok(value) => (OK, serde_json::to_vec(&value)),
            Err(errors) => (DIAGNOSTIC, serde_json::to_vec(&errors[0])),
        };
        match bytes {
            Ok(bytes) => NativeResult {
                kind,
                payload: Payload::Bytes(bytes),
            },
            Err(error) => NativeResult {
                kind: WIRE_ERROR,
                payload: Payload::Bytes(error.to_string().into_bytes()),
            },
        }
    }));
    let value = match result {
        Ok(value) => value,
        Err(payload) => NativeResult {
            kind: PANIC,
            payload: Payload::Panic(payload),
        },
    };
    let kind = value.kind;
    unsafe {
        *owner = value;
    }
    kind
}
#[no_mangle]
pub unsafe extern "C" fn kandelo_amaro_result_bytes(
    result: *const NativeResult,
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
    let bytes = unsafe { &*result }.bytes();
    unsafe {
        *length = bytes.len();
    }
    bytes.as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn kandelo_amaro_result_release(result: *mut NativeResult) -> i32 {
    if result.is_null() {
        return OK;
    }
    match catch_unwind(AssertUnwindSafe(|| unsafe {
        drop(Box::from_raw(result));
    })) {
        Ok(()) => OK,
        Err(payload) => {
            std::mem::forget(payload);
            PANIC
        }
    }
}
