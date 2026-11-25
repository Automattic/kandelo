use fork_instrument::native;
use fork_instrument_capi::{
    InstrumentResult, OK, TRANSFORM_ERROR, kandelo_fork_instrument_bytes,
    kandelo_fork_instrument_error, kandelo_fork_instrument_release,
};
use kandelo_ffi_adapter::{Scalar::*, *};
use std::{
    ffi::{CStr, c_int, c_void},
    os::fd::IntoRawFd,
    ptr,
};

#[test]
fn all_node_scalars_and_mixed_arities_emit_valid_wasm_for_calls_and_callbacks() {
    let scalars = [U8, S8, U16, S16, U32, S32, U64, S64, F32, F64, Pointer];
    for result in [
        Void, U8, S8, U16, S16, U32, S32, U64, S64, F32, F64, Pointer,
    ] {
        for argument in scalars {
            for count in [0, 1, 3, 23, 64] {
                let signature = Signature {
                    result,
                    arguments: vec![argument; count],
                };
                native::validate(&call(&signature, 1024 * 1024).unwrap()).unwrap();
                native::validate(&callback(&signature, 4096, 1024 * 1024).unwrap()).unwrap();
            }
        }
    }
    let signature = Signature {
        result: F64,
        arguments: scalars.to_vec(),
    };
    native::validate(&call(&signature, 1024 * 1024).unwrap()).unwrap();
    native::validate(&callback(&signature, 4096, 1024 * 1024).unwrap()).unwrap();
    native::validate(&reservation(1024 * 1024).unwrap()).unwrap();
}
#[test]
fn invalid_types_contexts_and_byte_budgets_do_not_emit_modules() {
    assert!(Scalar::from_ffi(13).is_none()); // not a Node scalar alias
    assert!(Scalar::from_ffi(15).is_none());
    assert_eq!(Scalar::from_ffi(14), Some(Pointer));
    let invalid = Signature {
        result: F64,
        arguments: vec![Void],
    };
    assert!(call(&invalid, 1024 * 1024).is_err());
    assert!(callback(&invalid, 4096, 1024 * 1024).is_err());
    let valid = Signature {
        result: F64,
        arguments: vec![F64; 3],
    };
    assert!(callback(&valid, 0, 1024 * 1024).is_err());
    assert!(call(&valid, 1).is_err());
    assert!(callback(&valid, 4096, 1).is_err());
    assert!(reservation(1).is_err());
}
unsafe extern "C" fn create(_: *mut c_void) -> c_int {
    tempfile::tempfile().map_or(-1, |f| f.into_raw_fd())
}
struct Owned(*mut InstrumentResult);
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe {
            kandelo_fork_instrument_release(self.0);
        }
    }
}
#[test]
fn c_entry_always_runs_original_instrumentation_and_owns_the_final_artifact() {
    for mode in 0..3 {
        let mut output = Owned(ptr::null_mut());
        let codes = [3, 3, 3, 12, 2, 14];
        let status = unsafe {
            kandelo_ffi_emit_adapter(
                mode,
                3,
                codes.as_ptr(),
                codes.len(),
                4096,
                1024 * 1024,
                Some(create),
                ptr::null_mut(),
                &mut output.0,
            )
        };
        if status != OK {
            let message = unsafe { CStr::from_ptr(kandelo_fork_instrument_error(output.0)) };
            panic!("mode{mode}: {}", message.to_string_lossy());
        }
        let mut length = 0;
        let data = unsafe { kandelo_fork_instrument_bytes(output.0, &mut length) };
        let bytes = unsafe { std::slice::from_raw_parts(data, length) };
        native::validate(bytes).unwrap();
        let scan = fork_instrument::streaming::scan(bytes).unwrap();
        assert!(
            scan.custom_data("kandelo.wpk_fork.capabilities")
                .next()
                .is_some()
        );
        assert!(
            scan.exports
                .iter()
                .any(|(name, _, _)| name == "wpk_fork_module_state_save")
        );
        assert!(unsafe { kandelo_fork_instrument_error(output.0) }.is_null());
    }
}
#[test]
fn c_entry_returns_owned_errors_for_bad_shapes_and_output_budgets() {
    for (result, code, closure, mode, budget) in [
        (13, 3, 4096, 0, 1024 * 1024),
        (3, 0, 4096, 0, 1024 * 1024),
        (3, 3, 0, 1, 1024 * 1024),
        (3, 3, 4096, 0, 1),
    ] {
        let mut output = Owned(ptr::null_mut());
        let status = unsafe {
            kandelo_ffi_emit_adapter(
                mode,
                result,
                &code,
                1,
                closure,
                budget,
                Some(create),
                ptr::null_mut(),
                &mut output.0,
            )
        };
        assert_eq!(status, TRANSFORM_ERROR);
        assert!(!output.0.is_null());
        assert!(!unsafe { kandelo_fork_instrument_error(output.0) }.is_null());
    }
}
