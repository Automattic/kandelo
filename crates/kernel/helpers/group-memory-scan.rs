//! Read-only kernel adjunct bound to one existing group backing. No data,
//! linear stack, allocation, ownership records or publication authority.
#![no_std]
use core::{
    arch::wasm32,
    sync::atomic::{AtomicU32, Ordering},
};

/// Zero means no nonzero word; otherwise high32 is its one-based relative
/// index and low32 its observed bits. Negative values are errno. The reserved
/// first page is excluded so Rust never constructs a null atomic reference.
#[unsafe(no_mangle)]
pub extern "C" fn next_nonzero(address: u32, words: u32) -> i64 {
    let bytes = (wasm32::memory_size::<0>() as u64) * 65536;
    if address < 65536
        || address % 4 != 0
        || words > 65536
        || u64::from(address) + u64::from(words) * 4 > bytes
    {
        return -22;
    }
    for index in 0..words {
        // Bounds and alignment were checked above. Each load observes the
        // live shared backing, in the same order as the scalar kernel path.
        let value = unsafe {
            AtomicU32::from_ptr((address + index * 4) as *mut u32).load(Ordering::SeqCst)
        };
        if value != 0 {
            return ((u64::from(index + 1) << 32) | u64::from(value)) as i64;
        }
    }
    0
}
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    wasm32::unreachable()
}
