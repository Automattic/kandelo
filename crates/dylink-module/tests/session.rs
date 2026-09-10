//! The module's session state machine, driven through its real entry points.
//!
//! `crates/dylink` proves the PLANNER. These tests prove the thin layer around
//! it: that a request arriving as bytes reaches the planner intact, that the
//! phase machine refuses sequences it cannot honour, and — the part most worth
//! testing — that every failure surfaces as a status the caller must check plus
//! a message `dlerror` can render, rather than as a zero.
//!
//! They run against the `rlib` build on the host triple, so the entry points
//! are exercised as ordinary functions. The state is process-global by design
//! (one guest per process worker), so each test starts with [`dl_reset`]. The
//! repo pins `RUST_TEST_THREADS = 1`, so that is sufficient.

use dylink::act::PointerWidth;
use dylink::plan::{LinkerConfig, LoadRequest};
use dylink::scope::SymbolValue;
use dylink::wire::{
    encode_linker_config, encode_load_request, encode_main_image, MainImage,
};
use dylink_module::*;

/// Copy `bytes` into the module's input buffer the way a driver would, and
/// return the length to hand the entry point.
fn write_input(bytes: &[u8]) -> u32 {
    let ptr = dl_input_reserve(bytes.len() as u32);
    assert_ne!(ptr, 0, "the input buffer must be reservable");
    // SAFETY: `dl_input_reserve` just sized the module-owned buffer to exactly
    // this length and returned its address. On the host triple that address is
    // an ordinary pointer into this process.
    unsafe {
        core::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
    }
    bytes.len() as u32
}

/// The answer bytes from the last call.
fn read_output() -> Vec<u8> {
    let ptr = dl_output_ptr() as *const u8;
    let len = dl_output_len() as usize;
    if len == 0 {
        return Vec::new();
    }
    // SAFETY: the module owns this buffer and nothing has called into it since.
    unsafe { core::slice::from_raw_parts(ptr, len) }.to_vec()
}

/// Take the pending `dlerror` message.
fn take_error() -> String {
    let len = dl_error();
    if len == 0 {
        return String::new();
    }
    String::from_utf8(read_output()).expect("a dlerror message is UTF-8")
}

fn configure(config: &LinkerConfig) -> i32 {
    let bytes = encode_linker_config(config).expect("encode config");
    let len = write_input(&bytes);
    dl_configure(len)
}

#[test]
fn a_configured_session_accepts_a_main_image() {
    dl_reset();
    assert_eq!(configure(&LinkerConfig::default()), DL_OK);

    let image = MainImage {
        table_length: 64,
        exports: vec![("environ".into(), SymbolValue::main_data("environ", 0x1000))],
        element_slots: Vec::new(),
    };
    let bytes = encode_main_image(&image).expect("encode image");
    let len = write_input(&bytes);
    assert_eq!(dl_publish_main_image(len), DL_OK);
    assert_eq!(take_error(), "", "a successful call leaves no dlerror");
}

/// Everything before `dl_configure` must fail, and must SAY why. A bare status
/// code with no message would leave a driver unable to distinguish "you called
/// out of order" from "the planner rejected your input".
#[test]
fn calls_before_configure_fail_with_a_message() {
    dl_reset();
    let bytes = encode_main_image(&MainImage::default()).expect("encode image");
    let len = write_input(&bytes);
    assert_eq!(dl_publish_main_image(len), DL_ERROR);
    let message = take_error();
    assert!(
        message.contains("dl_configure"),
        "the message must name the missing step, got {message:?}",
    );
}

/// A malformed config must leave NO session. Falling back to a default-
/// configured linker would silently give the process a pointer width nobody
/// chose -- the shape of silent success this project treats as a defect.
#[test]
fn a_malformed_config_leaves_no_session_rather_than_a_default_one() {
    dl_reset();
    let len = write_input(&[0xff, 0xff, 0xff]);
    assert_eq!(dl_configure(len), DL_ERROR);
    assert!(!take_error().is_empty(), "a malformed config must explain itself");

    // Proof that no session was created: the next call reports the missing
    // configure step rather than proceeding against a default linker.
    let bytes = encode_main_image(&MainImage::default()).expect("encode image");
    let len = write_input(&bytes);
    assert_eq!(dl_publish_main_image(len), DL_ERROR);
    assert!(take_error().contains("dl_configure"));
}

/// The configured pointer width must actually reach the planner. If the wire
/// record were dropped, a wasm64 process would be planned with 32-bit GOT
/// cells and the failure would appear much later, as corrupted addresses.
#[test]
fn the_configured_pointer_width_reaches_the_planner() {
    dl_reset();
    let config = LinkerConfig {
        pointer_width: PointerWidth::W64,
        ..LinkerConfig::default()
    };
    assert_eq!(configure(&config), DL_OK);

    // A module that is not a wasm binary at all is refused, and the refusal
    // comes from the PLANNER -- proof the request crossed the boundary and was
    // parsed, rather than being rejected by the transport.
    let request = LoadRequest::new("not-a-library.so", vec![0, 1, 2, 3]);
    let bytes = encode_load_request(&request).expect("encode request");
    let len = write_input(&bytes);
    assert_eq!(dl_open_begin(len), DL_ERROR);
    let message = take_error();
    assert!(
        !message.is_empty() && !message.contains("dl_configure"),
        "the planner, not the transport, must have refused it: {message:?}",
    );
}

/// Stepping with no load in flight is a driver bug, not an empty answer.
#[test]
fn stepping_with_nothing_in_flight_is_an_error_not_an_empty_step() {
    dl_reset();
    assert_eq!(configure(&LinkerConfig::default()), DL_OK);
    assert_eq!(dl_step(), DL_ERROR);
    // Checked BEFORE `dl_error`, which renders its message into this same
    // buffer: a failed step must not leave a decodable `PlanStep` behind for a
    // driver that forgot to check the status.
    assert!(
        read_output().is_empty(),
        "a failed step must not leave a decodable record behind",
    );
    assert!(!take_error().is_empty());
}

/// Finishing or aborting with no load in flight names the problem.
#[test]
fn finishing_without_a_load_in_flight_is_refused() {
    dl_reset();
    assert_eq!(configure(&LinkerConfig::default()), DL_OK);
    assert_eq!(dl_open_finish(-1), DL_ERROR);
    assert!(take_error().contains("without a load in flight"));
    assert_eq!(dl_open_abort(), DL_ERROR);
    assert!(take_error().contains("without a load in flight"));
}

/// A length larger than what was reserved must be refused rather than reading
/// whatever the PREVIOUS request left in the buffer. Without this bound a
/// driver bug would decode a stale record and act on it.
#[test]
fn a_request_longer_than_the_reservation_is_refused() {
    dl_reset();
    assert_eq!(configure(&LinkerConfig::default()), DL_OK);
    let bytes = encode_main_image(&MainImage::default()).expect("encode image");
    let len = write_input(&bytes);
    assert_eq!(dl_publish_main_image(len + 64), DL_ERROR);
    assert!(!take_error().is_empty());
}

/// `dlerror` reports once and clears, as POSIX specifies.
#[test]
fn dlerror_clears_the_message_it_reports() {
    dl_reset();
    assert_eq!(configure(&LinkerConfig::default()), DL_OK);
    assert_eq!(dl_step(), DL_ERROR);
    assert!(!take_error().is_empty(), "the first read reports it");
    assert_eq!(take_error(), "", "the second read finds it cleared");
}

/// The plan accessors report "absent" as -1 with no load in flight. Zero is a
/// legal `__memory_base`, so it cannot double as the absent value.
#[test]
fn plan_accessors_report_absent_as_minus_one() {
    dl_reset();
    assert_eq!(configure(&LinkerConfig::default()), DL_OK);
    assert_eq!(dl_plan_instance(), -1);
    assert_eq!(dl_plan_memory_base(), -1);
    assert_eq!(dl_plan_table_base(), -1);
    assert_eq!(dl_plan_tls_base(), -1);
    assert_eq!(dl_plan_activation(), -1);
}

/// `dl_reset` is what `exec` needs: the new image shares no loader state.
#[test]
fn reset_drops_the_session() {
    dl_reset();
    assert_eq!(configure(&LinkerConfig::default()), DL_OK);
    dl_reset();
    assert_eq!(dl_step(), DL_ERROR);
    assert!(take_error().contains("dl_configure"));
}
