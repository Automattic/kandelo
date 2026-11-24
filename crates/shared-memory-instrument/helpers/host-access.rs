//! Stateless Rust SDK primitives operating on an already imported group memory.
#![no_std]
#![feature(stdarch_wasm_atomic_wait)]

#[path = "../../program-abi/src/memory_group_layout.rs"]
pub mod memory_group_layout;
mod program_extensions {
    pub use super::memory_group_layout as memory_group_v3;
}
#[path = "../../shared/src/group_access.rs"]
mod group_access;

use core::{
    arch::wasm32,
    sync::atomic::{AtomicU32, Ordering},
};
use group_access::Memory;

#[link(wasm_import_module = "kandelo.host-memory.v2")]
unsafe extern "C" {
    /// Returns zero for a completed bounded platform publication. It must
    /// catch native callback exceptions rather than unwind through Rust.
    fn publish() -> u32;
}

struct Imported;
impl Memory for Imported {
    fn bytes(&self) -> u64 {
        (wasm32::memory_size::<0>() as u64) * u64::from(memory_group_layout::PAGE_BYTES)
    }
    fn load(&self, address: u32) -> u32 {
        unsafe { AtomicU32::from_ptr(address as *mut u32).load(Ordering::SeqCst) }
    }
    fn store(&mut self, address: u32, value: u32) {
        unsafe {
            AtomicU32::from_ptr(address as *mut u32).store(value, Ordering::SeqCst);
        }
    }
    fn compare_exchange(&mut self, address: u32, expected: u32, value: u32) -> u32 {
        unsafe {
            AtomicU32::from_ptr(address as *mut u32)
                .compare_exchange(expected, value, Ordering::SeqCst, Ordering::SeqCst)
                .unwrap_or_else(|old| old)
        }
    }
    fn wait_value(&mut self, address: u32, expected: u32) {
        unsafe {
            wasm32::memory_atomic_wait32(address as *mut i32, expected as i32, -1);
        }
    }
    fn wake(&mut self, address: u32, count: u32) {
        unsafe {
            wasm32::memory_atomic_notify(address as *mut i32, count);
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn version() -> u32 {
    group_access::VERSION
}
#[unsafe(no_mangle)]
pub extern "C" fn length(root: u32, maximum: u32) -> i64 {
    group_access::length(&Imported, root, maximum)
}
#[unsafe(no_mangle)]
pub extern "C" fn check(root: u32, maximum: u32, address: u64, bytes: u64, rights: u32) -> i32 {
    group_access::check(&Imported, root, maximum, address, bytes, rights)
}
#[unsafe(no_mangle)]
pub extern "C" fn span(root: u32, maximum: u32, address: u64, bytes: u64, rights: u32) -> u64 {
    group_access::span(&Imported, root, maximum, address, bytes, rights)
}
#[unsafe(no_mangle)]
pub extern "C" fn store(address: u32, value: u32) {
    // [RUNTIME-WORKAROUND: JSC-GROUP-MUTEX-STORE-STALL] Keep the foreign
    // contended mutex release in Wasm; the engine cause remains suspected.
    Imported.store(address, value);
}
#[unsafe(no_mangle)]
pub extern "C" fn notify(address: u32, count: u32, nonblocking: u32) -> i64 {
    group_access::notify(&mut Imported, address, count, nonblocking != 0, || unsafe {
        publish() == 0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn wait_fork_replay(replica: u32) -> i32 {
    group_access::wait_fork_replay(&mut Imported, replica)
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    wasm32::unreachable()
}
