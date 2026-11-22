use fork_instrument_capi::*;
use std::{
    ffi::{CStr, c_int, c_void},
    os::fd::IntoRawFd,
    ptr,
    sync::atomic::{AtomicUsize, Ordering},
};
use wasm_encoder::{CustomSection, Encode};

struct Factory {
    calls: AtomicUsize,
    fail_at: Option<usize>,
}
unsafe extern "C" fn create(context: *mut c_void) -> c_int {
    let factory = unsafe { &*context.cast::<Factory>() };
    let count = factory.calls.fetch_add(1, Ordering::Relaxed);
    if factory.fail_at == Some(count) {
        return -1;
    }
    tempfile::tempfile().map_or(-1, |file| file.into_raw_fd())
}

struct Owned(*mut InstrumentResult);
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { kandelo_fork_instrument_release(self.0) }
    }
}
fn transform(input: &[u8], limit: u64, factory: &Factory) -> (c_int, Owned) {
    let mut result = ptr::null_mut();
    let status = unsafe {
        kandelo_fork_instrument_side_module(
            input.as_ptr(),
            input.len(),
            limit,
            Some(create),
            (factory as *const Factory).cast_mut().cast(),
            &mut result,
        )
    };
    (status, Owned(result))
}
fn side() -> Vec<u8> {
    let plain = wat::parse_str("(module (func (export \"entry\")))").unwrap();
    let mut input = plain[..8].to_vec();
    input.push(0);
    CustomSection {
        name: "dylink.0".into(),
        data: (&[1, 4, 0, 0, 0, 0][..]).into(),
    }
    .encode(&mut input);
    input.extend_from_slice(&plain[8..]);
    input
}
#[test]
fn c_result_owns_output_after_input_and_factory_are_gone() {
    let output = {
        let input = side();
        let factory = Factory {
            calls: AtomicUsize::new(0),
            fail_at: None,
        };
        let (status, output) = transform(&input, 1024 * 1024, &factory);
        assert_eq!(status, OK);
        assert!(!output.0.is_null());
        assert!(factory.calls.load(Ordering::Relaxed) >= 3);
        output
    };
    let mut length = 0;
    let bytes = unsafe { kandelo_fork_instrument_bytes(output.0, &mut length) };
    assert!(!bytes.is_null() && length > 8);
    assert!(unsafe { kandelo_fork_instrument_error(output.0) }.is_null());
    fork_instrument::native::validate(unsafe { std::slice::from_raw_parts(bytes, length) })
        .unwrap();
}
#[test]
fn c_errors_have_owned_messages_and_no_output_bytes() {
    let factory = Factory {
        calls: AtomicUsize::new(0),
        fail_at: None,
    };
    for input in [
        &b"invalid wasm"[..],
        &wat::parse_str("(module)").unwrap()[..],
    ] {
        let (status, output) = transform(input, 1024 * 1024, &factory);
        assert_eq!(status, TRANSFORM_ERROR);
        let message = unsafe { kandelo_fork_instrument_error(output.0) };
        assert!(!message.is_null());
        assert!(!unsafe { CStr::from_ptr(message) }.to_bytes().is_empty());
        let mut length = 99;
        assert!(unsafe { kandelo_fork_instrument_bytes(output.0, &mut length) }.is_null());
        assert_eq!(length, 0);
    }
    assert_eq!(factory.calls.load(Ordering::Relaxed), 0);
}
#[test]
fn c_storage_and_output_budget_failures_are_results() {
    let input = side();
    for (limit, fail_at) in [(1, None), (1024 * 1024, Some(0)), (1024 * 1024, Some(1))] {
        let factory = Factory {
            calls: AtomicUsize::new(0),
            fail_at,
        };
        let (status, output) = transform(&input, limit, &factory);
        assert_eq!(status, TRANSFORM_ERROR);
        assert!(!output.0.is_null());
        assert!(!unsafe { kandelo_fork_instrument_error(output.0) }.is_null());
    }
}
#[test]
fn invalid_c_arguments_clear_output_and_do_not_call_factory() {
    let factory = Factory {
        calls: AtomicUsize::new(0),
        fail_at: None,
    };
    let mut output = ptr::dangling_mut::<InstrumentResult>();
    unsafe {
        assert_eq!(
            kandelo_fork_instrument_side_module(
                ptr::null(),
                1,
                1,
                Some(create),
                (&factory as *const Factory).cast_mut().cast(),
                &mut output
            ),
            INVALID_ARGUMENT
        );
        assert!(output.is_null());
        assert_eq!(
            kandelo_fork_instrument_side_module(
                ptr::null(),
                0,
                1,
                None,
                ptr::null_mut(),
                &mut output
            ),
            INVALID_ARGUMENT
        );
        assert!(output.is_null());
        assert_eq!(
            kandelo_fork_instrument_side_module(
                ptr::null(),
                0,
                1,
                Some(create),
                ptr::null_mut(),
                ptr::null_mut()
            ),
            INVALID_ARGUMENT
        );
        assert_eq!(
            kandelo_fork_instrument_side_module(
                ptr::null(),
                0,
                0,
                Some(create),
                ptr::null_mut(),
                &mut output
            ),
            INVALID_ARGUMENT
        );
    }
    assert_eq!(factory.calls.load(Ordering::Relaxed), 0);
}
#[test]
fn null_c_accessors_and_release_do_not_dereference_null() {
    let mut length = 99;
    unsafe {
        assert!(kandelo_fork_instrument_bytes(ptr::null(), &mut length).is_null());
        assert_eq!(length, 0);
        assert!(kandelo_fork_instrument_bytes(ptr::null(), ptr::null_mut()).is_null());
        assert!(kandelo_fork_instrument_error(ptr::null()).is_null());
        kandelo_fork_instrument_release(ptr::null_mut());
    }
}
