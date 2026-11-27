//! Benchmark-only positioned byte I/O. This feature is excluded from products.
use runtime_core::persistent_overlay::OverlayStorage;
use wasm_posix_shared::Errno;

#[link(wasm_import_module = "namespace_benchmark")]
unsafe extern "C" {
    fn storage_len(slot: u32) -> i64;
    fn storage_read(slot: u32, offset: u64, bytes: *mut u8, length: usize) -> i32;
    fn storage_write(slot: u32, offset: u64, bytes: *const u8, length: usize) -> i32;
    fn storage_flush(slot: u32) -> i32;
    fn storage_truncate(slot: u32, length: u64) -> i32;
    fn mark_phase(phase: u32);
}

struct Storage(u32);

fn check(status: i32) -> Result<(), Errno> {
    if status == 0 {
        Ok(())
    } else {
        Err(status
            .checked_neg()
            .and_then(|errno| Errno::from_u32(errno as u32))
            .unwrap_or(Errno::EIO))
    }
}

impl OverlayStorage for Storage {
    fn len(&mut self) -> Result<u64, Errno> {
        let length = unsafe { storage_len(self.0) };
        if length < 0 {
            check(length as i32)?;
        }
        Ok(length as u64)
    }

    fn read_exact_at(&mut self, offset: u64, bytes: &mut [u8]) -> Result<(), Errno> {
        check(unsafe { storage_read(self.0, offset, bytes.as_mut_ptr(), bytes.len()) })
    }

    fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> Result<(), Errno> {
        check(unsafe { storage_write(self.0, offset, bytes.as_ptr(), bytes.len()) })
    }

    fn flush(&mut self) -> Result<(), Errno> {
        check(unsafe { storage_flush(self.0) })
    }

    fn truncate(&mut self, length: u64) -> Result<(), Errno> {
        check(unsafe { storage_truncate(self.0, length) })
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn sm_namespace_benchmark(format: u32, files: u32, seed: u32) -> i32 {
    let mark = |phase| unsafe { mark_phase(phase) };
    let outcome = if format == 2 {
        runtime_core::namespace_benchmark::run_payload(Storage(0), mark)
    } else {
        runtime_core::namespace_benchmark::run(Storage, mark, format, files, seed)
    };
    outcome.map_or_else(|error| -(error as i32), |()| 0)
}
