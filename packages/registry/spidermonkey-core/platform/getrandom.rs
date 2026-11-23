// Guest entropy backend compiled inside Mozilla's original shim crate.
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
use core::ffi::c_void;


#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
#[no_mangle]
unsafe extern "Rust" fn __getrandom_v03_custom(
    dest: *mut u8,
    len: usize,
) -> Result<(), getrandom::Error> {
    unsafe extern "C" {
        #[link_name = "getrandom"]
        fn libc_getrandom(buf: *mut c_void, buflen: usize, flags: u32) -> isize;
    }

    let mut filled = 0;
    while filled < len {
        let ptr = unsafe { dest.add(filled) }.cast::<c_void>();
        let remaining = len - filled;
        let result = unsafe { libc_getrandom(ptr, remaining, 0) };

        if result < 0 {
            return Err(getrandom::Error::new_custom(1));
        }

        if result == 0 {
            return Err(getrandom::Error::new_custom(2));
        }

        filled += result as usize;
    }

    Ok(())
}
