//! Synchronous entry using the original transform_sync body and pinned Serde
//! converter. No panic may unwind into the C++ callback or exported C caller.
use super::kandelo_native::{NativeResult, Payload};
use serde_wasm_bindgen::native_values::{Abrupt, FrameGuard, JsValue, Operations};
use std::{alloc::{alloc, Layout}, panic::{catch_unwind, AssertUnwindSafe}, ptr};

#[no_mangle]
pub unsafe extern "C" fn kandelo_amaro_transform_values(
    operations: *const Operations,
    input: u32,
    options: u32,
    output: *mut u32,
    failure: *mut *mut NativeResult,
) -> i32 {
    if output.is_null() || failure.is_null() { return 3; }
    unsafe { *output = 0; *failure = ptr::null_mut(); }
    let Some(_frame) = (unsafe { FrameGuard::enter(operations) }) else { return 3; };
    let result = catch_unwind(AssertUnwindSafe(|| super::transform_sync(JsValue(input), JsValue(options))));
    match result {
        Ok(Ok(value)) => { unsafe { *output = value.0; } 0 }
        Ok(Err(value)) => { unsafe { *output = value.0; } 1 }
        Err(payload) if payload.is::<Abrupt>() => 2,
        Err(payload) => {
            let owner = unsafe { alloc(Layout::new::<NativeResult>()).cast::<NativeResult>() };
            if owner.is_null() { std::mem::forget(payload); return 5; }
            unsafe {
                owner.write(NativeResult { kind: 4, payload: Payload::Panic(payload) });
                *failure = owner;
            }
            4
        }
    }
}
