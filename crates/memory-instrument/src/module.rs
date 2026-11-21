#![cfg_attr(target_arch = "wasm32", no_main)]

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    panic!("the memory-instrument module must be built for wasm32");
}

#[cfg(target_arch = "wasm32")]
mod module {
    use std::cell::UnsafeCell;

    use memory_instrument::{Crossing, Options, Role, instrument};

    struct State(UnsafeCell<Vec<u8>>);
    unsafe impl Sync for State {}
    static BUFFER: State = State(UnsafeCell::new(Vec::new()));

    #[unsafe(no_mangle)]
    pub extern "C" fn mi_begin(length: usize) -> *mut u8 {
        let buffer = unsafe { &mut *BUFFER.0.get() };
        *buffer = vec![0; length];
        buffer.as_mut_ptr()
    }

    /// Replaces the input with the rewritten module and returns its length,
    /// or with an error message and returns the negated message length.
    #[unsafe(no_mangle)]
    pub extern "C" fn mi_instrument_side_module() -> i32 {
        let buffer = unsafe { &mut *BUFFER.0.get() };
        let options = Options {
            crossing: Crossing::Strict,
            role: Role::SideModule,
        };
        match instrument(buffer, &options) {
            Ok(output) => {
                *buffer = output;
                buffer.len() as i32
            }
            Err(error) => {
                *buffer = format!("{error:#}").into_bytes();
                -(buffer.len() as i32)
            }
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn mi_result() -> *const u8 {
        unsafe { (*BUFFER.0.get()).as_ptr() }
    }
}
