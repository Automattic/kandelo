//! Access to the guest's linear memory.
//!
//! Behind a trait so every entry point in `shim.rs` can be driven on the host
//! against a plain byte buffer. On wasm the implementation is raw pointer
//! access into the imported shared memory; in tests it is a `Vec<u8>`.
//!
//! Every accessor is bounds-checked and returns a `Result`, so a guest pointer
//! that does not fit is `EFAULT` rather than a trap or a silent wrap. The
//! TypeScript relies on `DataView` throwing a `RangeError`, which would escape
//! the shim as a JavaScript exception rather than as a WASI errno.

use wasi_abi::WasiErrno;

pub type MemResult<T> = Result<T, WasiErrno>;

/// The guest's linear memory, as the shim sees it.
pub trait GuestMemory {
    /// Total addressable size, in bytes. May grow between calls: a WASI guest
    /// grows its own memory with `memory.grow` and never tells the kernel.
    fn size(&self) -> u64;

    /// Copy `out.len()` bytes from `addr`.
    fn read(&self, addr: u64, out: &mut [u8]) -> MemResult<()>;

    /// Copy `src` to `addr`.
    fn write(&self, addr: u64, src: &[u8]) -> MemResult<()>;

    /// Bounds check without transferring anything.
    fn check_range(&self, addr: u64, len: u64) -> MemResult<()> {
        match addr.checked_add(len) {
            Some(end) if end <= self.size() => Ok(()),
            _ => Err(WasiErrno::Fault),
        }
    }

    fn read_u8(&self, addr: u64) -> MemResult<u8> {
        let mut b = [0u8; 1];
        self.read(addr, &mut b)?;
        Ok(b[0])
    }

    fn read_u16(&self, addr: u64) -> MemResult<u16> {
        let mut b = [0u8; 2];
        self.read(addr, &mut b)?;
        Ok(u16::from_le_bytes(b))
    }

    fn read_u32(&self, addr: u64) -> MemResult<u32> {
        let mut b = [0u8; 4];
        self.read(addr, &mut b)?;
        Ok(u32::from_le_bytes(b))
    }

    fn read_u64(&self, addr: u64) -> MemResult<u64> {
        let mut b = [0u8; 8];
        self.read(addr, &mut b)?;
        Ok(u64::from_le_bytes(b))
    }

    fn read_i64(&self, addr: u64) -> MemResult<i64> {
        Ok(self.read_u64(addr)? as i64)
    }

    fn write_u8(&self, addr: u64, value: u8) -> MemResult<()> {
        self.write(addr, &[value])
    }

    fn write_u16(&self, addr: u64, value: u16) -> MemResult<()> {
        self.write(addr, &value.to_le_bytes())
    }

    fn write_u32(&self, addr: u64, value: u32) -> MemResult<()> {
        self.write(addr, &value.to_le_bytes())
    }

    fn write_u64(&self, addr: u64, value: u64) -> MemResult<()> {
        self.write(addr, &value.to_le_bytes())
    }

    /// Fill `len` bytes at `addr` with zero.
    fn zero(&self, addr: u64, len: u64) -> MemResult<()> {
        self.check_range(addr, len)?;
        let mut remaining = len;
        let mut cursor = addr;
        let chunk = [0u8; 64];
        while remaining > 0 {
            let n = remaining.min(chunk.len() as u64) as usize;
            self.write(cursor, &chunk[..n])?;
            cursor += n as u64;
            remaining -= n as u64;
        }
        Ok(())
    }
}

/// A wasm32 iovec / ciovec: `{ buf: u32, buf_len: u32 }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IoVec {
    pub buf: u32,
    pub buf_len: u32,
}

/// Read the `iovs_len`-long iovec array at `iovs`.
pub fn read_iovec<M: GuestMemory>(mem: &M, iovs: u32, index: u32) -> MemResult<IoVec> {
    let base = iovs as u64 + index as u64 * wasi_abi::layout::iovec::SIZE as u64;
    Ok(IoVec {
        buf: mem.read_u32(base + wasi_abi::layout::iovec::BUF as u64)?,
        buf_len: mem.read_u32(base + wasi_abi::layout::iovec::BUF_LEN as u64)?,
    })
}

/// Total bytes described by an iovec array, saturating rather than wrapping.
pub fn iovec_total_len<M: GuestMemory>(mem: &M, iovs: u32, iovs_len: u32) -> MemResult<u64> {
    let mut total = 0u64;
    for index in 0..iovs_len {
        total = total.saturating_add(read_iovec(mem, iovs, index)?.buf_len as u64);
    }
    Ok(total)
}

/// The wasm implementation: raw access to the imported shared memory.
#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
pub struct WasmMemory;

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
impl GuestMemory for WasmMemory {
    fn size(&self) -> u64 {
        // `memory.size` is in 64 KiB pages and reflects any growth the guest
        // performed itself, which is the only way this module can learn about
        // it -- a WASI guest never routes growth through the kernel.
        (core::arch::wasm32::memory_size(0) as u64) * 65536
    }

    fn read(&self, addr: u64, out: &mut [u8]) -> MemResult<()> {
        self.check_range(addr, out.len() as u64)?;
        // SAFETY: the range was just bounds-checked against the live memory
        // size, and this module's memory IS the guest's (imported), so `addr`
        // is a valid guest offset.
        unsafe {
            core::ptr::copy_nonoverlapping(addr as usize as *const u8, out.as_mut_ptr(), out.len());
        }
        Ok(())
    }

    fn write(&self, addr: u64, src: &[u8]) -> MemResult<()> {
        self.check_range(addr, src.len() as u64)?;
        // SAFETY: as above.
        unsafe {
            core::ptr::copy_nonoverlapping(src.as_ptr(), addr as usize as *mut u8, src.len());
        }
        Ok(())
    }
}

/// A host-side memory for tests: a plain byte buffer with interior mutability,
/// so the trait's `&self` writes work exactly as they do on wasm.
#[cfg(feature = "testing")]
pub struct FakeMemory {
    bytes: core::cell::RefCell<std::vec::Vec<u8>>,
}

#[cfg(feature = "testing")]
impl FakeMemory {
    pub fn new(len: usize) -> Self {
        Self {
            bytes: core::cell::RefCell::new(std::vec![0u8; len]),
        }
    }

    pub fn snapshot(&self, addr: u64, len: usize) -> std::vec::Vec<u8> {
        self.bytes.borrow()[addr as usize..addr as usize + len].to_vec()
    }
}

#[cfg(feature = "testing")]
impl GuestMemory for FakeMemory {
    fn size(&self) -> u64 {
        self.bytes.borrow().len() as u64
    }

    fn read(&self, addr: u64, out: &mut [u8]) -> MemResult<()> {
        self.check_range(addr, out.len() as u64)?;
        let bytes = self.bytes.borrow();
        out.copy_from_slice(&bytes[addr as usize..addr as usize + out.len()]);
        Ok(())
    }

    fn write(&self, addr: u64, src: &[u8]) -> MemResult<()> {
        self.check_range(addr, src.len() as u64)?;
        let mut bytes = self.bytes.borrow_mut();
        bytes[addr as usize..addr as usize + src.len()].copy_from_slice(src);
        Ok(())
    }
}

#[cfg(all(test, feature = "testing"))]
mod tests {
    use super::*;

    #[test]
    fn out_of_range_access_is_efault_not_a_trap() {
        let mem = FakeMemory::new(64);
        let mut buf = [0u8; 8];
        assert_eq!(mem.read(60, &mut buf), Err(WasiErrno::Fault));
        assert_eq!(mem.write(60, &buf), Err(WasiErrno::Fault));
        assert_eq!(mem.read(64, &mut []), Ok(()));
        assert_eq!(mem.read(56, &mut buf), Ok(()));
    }

    #[test]
    fn an_address_that_would_overflow_is_efault() {
        let mem = FakeMemory::new(64);
        assert_eq!(mem.check_range(u64::MAX, 1), Err(WasiErrno::Fault));
        assert_eq!(mem.check_range(u64::MAX - 4, 8), Err(WasiErrno::Fault));
    }

    #[test]
    fn scalar_accessors_are_little_endian() {
        let mem = FakeMemory::new(64);
        mem.write_u32(0, 0x1234_5678).unwrap();
        assert_eq!(mem.snapshot(0, 4), std::vec![0x78, 0x56, 0x34, 0x12]);
        assert_eq!(mem.read_u32(0), Ok(0x1234_5678));

        mem.write_u64(8, 0x0123_4567_89AB_CDEF).unwrap();
        assert_eq!(mem.read_u64(8), Ok(0x0123_4567_89AB_CDEF));
        assert_eq!(mem.read_i64(8), Ok(0x0123_4567_89AB_CDEF));

        mem.write_u64(16, u64::MAX).unwrap();
        assert_eq!(mem.read_i64(16), Ok(-1));
    }

    #[test]
    fn zero_clears_the_exact_range() {
        let mem = FakeMemory::new(256);
        mem.write(0, &[0xFFu8; 256]).unwrap();
        mem.zero(10, 100).unwrap();
        assert_eq!(mem.snapshot(9, 1), std::vec![0xFF]);
        assert_eq!(mem.snapshot(10, 100), std::vec![0u8; 100]);
        assert_eq!(mem.snapshot(110, 1), std::vec![0xFF]);
    }

    #[test]
    fn iovec_totals_saturate_rather_than_wrapping() {
        let mem = FakeMemory::new(256);
        // Two iovecs each claiming 4 GiB - 1: the sum must not wrap a u32.
        for index in 0..2u32 {
            let base = 64 + index as u64 * 8;
            mem.write_u32(base, 128).unwrap();
            mem.write_u32(base + 4, u32::MAX).unwrap();
        }
        assert_eq!(iovec_total_len(&mem, 64, 2), Ok(2 * u32::MAX as u64));
    }
}
