use super::*;
use fork_instrument_capi::{
    CreateSpool, INVALID_ARGUMENT, InstrumentResult, PANIC, TRANSFORM_ERROR,
};
use std::{
    ffi::{c_int, c_void},
    panic::{AssertUnwindSafe, catch_unwind},
    ptr,
};

/// Emit and genuinely instrument one adapter, with the same owned C result as
/// the instrumenter. Mode0 is call,1 callback,2 pre-signature slot reservation.
///
/// # Safety
/// Output is writable and disjoint from borrowed input. The type array is
/// immutable/readable for count elements until return. The factory/context
/// meet kandelo_fork_instrument_side_module's exclusive-file contract.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kandelo_ffi_emit_adapter(
    mode: u32,
    result_type: u32,
    argument_types: *const u32,
    count: usize,
    closure: u32,
    output_limit: u64,
    factory: Option<CreateSpool>,
    context: *mut c_void,
    output: *mut *mut InstrumentResult,
) -> c_int {
    if output.is_null() {
        return INVALID_ARGUMENT;
    }
    unsafe {
        *output = ptr::null_mut();
    }
    if factory.is_none()
        || mode > 2
        || output_limit == 0
        || count > isize::MAX as usize / std::mem::size_of::<u32>()
        || (argument_types.is_null() && count != 0)
    {
        return INVALID_ARGUMENT;
    }
    let limit = usize::try_from(output_limit).unwrap_or(usize::MAX);
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let bytes = if mode == 2 {
            reservation(limit)
        } else {
            let Some(result) = Scalar::from_ffi(result_type) else {
                return Err(EmitError("unrecognized libffi scalar result type"));
            };
            let codes = if count == 0 {
                &[]
            } else {
                unsafe { std::slice::from_raw_parts(argument_types, count) }
            };
            let mut arguments = Vec::new();
            arguments
                .try_reserve_exact(count)
                .map_err(|_| EmitError("argument allocation failed"))?;
            for code in codes {
                arguments.push(
                    Scalar::from_ffi(*code)
                        .ok_or(EmitError("unrecognized libffi scalar argument type"))?,
                );
            }
            let signature = Signature { result, arguments };
            if mode == 0 {
                call(&signature, limit)
            } else {
                callback(&signature, closure, limit)
            }
        }?;
        let digest = option_env!("KANDELO_GUEST_PROGRAM_ABI_DIGEST").ok_or(EmitError(
            "FFI emitter is missing its SDK program ABI binding",
        ))?;
        let bytes = wasm_artifact::stamp_abi_contract(&bytes, digest)
            .map_err(|_| EmitError("cannot bind FFI adapter to the SDK program ABI"))?
            .unwrap_or(bytes);
        // No capability/ABI labels are invented here. The original transform
        // owns declarations, validation and side-module admission metadata.
        Ok(unsafe {
            fork_instrument_capi::kandelo_fork_instrument_side_module(
                bytes.as_ptr(),
                bytes.len(),
                output_limit,
                factory,
                context,
                output,
            )
        })
    }));
    let (status, message) = match outcome {
        Ok(Ok(status)) => return status,
        Ok(Err(error)) => (TRANSFORM_ERROR, error.0.to_string()),
        Err(payload) => {
            std::mem::forget(payload);
            (PANIC, "Rust FFI adapter emission panicked".to_string())
        }
    };
    unsafe {
        *output = Box::into_raw(Box::new(InstrumentResult::failure(message)));
    }
    status
}
