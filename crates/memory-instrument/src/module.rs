#![cfg_attr(target_arch = "wasm32", no_main)]

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    panic!("the memory-instrument module must be built for wasm32");
}

#[cfg(target_arch = "wasm32")]
mod module {
    use std::cell::UnsafeCell;

    use anyhow::Result;
    use memory_instrument::{Crossing, Options, Role, instrument, instrument_at_exec};

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
    fn rewrite(instrument: impl Fn(&[u8]) -> Result<Vec<u8>>) -> i32 {
        let buffer = unsafe { &mut *BUFFER.0.get() };
        match instrument(buffer) {
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
    pub extern "C" fn mi_instrument_program() -> i32 {
        rewrite(instrument_at_exec)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn mi_instrument_side_module() -> i32 {
        let options = Options {
            crossing: Crossing::Strict,
            role: Role::SideModule,
        };
        rewrite(|input| instrument(input, &options))
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn mi_result() -> *const u8 {
        unsafe { (*BUFFER.0.get()).as_ptr() }
    }
}
