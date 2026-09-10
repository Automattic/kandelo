//! Reading and writing a caller's memory for kernel-dereferenced arguments.
//!
//! Most syscall pointer arguments are described well enough by
//! `wasm_posix_shared::host_abi::SyscallArgDesc` for the host to copy them into
//! the kernel's scratch channel before dispatch. Some are not: `msgctl`'s
//! buffer changes direction with `cmd`, `semctl`'s fourth argument is a
//! `union semun`, a `struct msghdr` points at three more caller buffers, and a
//! SysV `struct msgbuf` opens with a caller-width `long`. Those arguments are
//! declared `SyscallArgSize::KernelDereferenced`, and the host hands the kernel
//! the raw guest address instead of any bytes.
//!
//! # Why this is a module and not four open-coded call pairs
//!
//! Three rules bind every use of the cross-memory primitives, and each has a
//! way of being quietly dropped at an individual call site:
//!
//! 1. **Copy once, then parse.** The caller's memory is shared and another
//!    thread may write it at any moment. A field read twice can hold two
//!    different values, which is how a checked length becomes a stale one — the
//!    classic time-of-check/time-of-use hazard. Every read here returns an
//!    owned buffer so the parse cannot reach back into guest memory.
//! 2. **The guest never sizes a kernel allocation on its own.** Reaching the
//!    caller's memory directly removes the channel's fixed data capacity, and
//!    with it the incidental ceiling that used to bound these transfers. Every
//!    read therefore takes an explicit `limit` that its caller must justify
//!    from a kernel-held fact — a queue's `mq_msgsize`, a semaphore set's
//!    `nsems`, `MSGMAX`, `IOV_MAX`.
//! 3. **A failed cross-memory access is `EFAULT`, not a kernel fault.** An
//!    out-of-range guest address is an ordinary POSIX error the caller must
//!    observe as one.
//!
//! # Target liveness
//!
//! `HostIO::proc_read_bytes` and `HostIO::proc_write_bytes` are sound only for
//! the process the kernel is currently dispatching for, which is live by
//! construction: host dispatch is synchronous and the import must not re-enter
//! the kernel, so no `exec` or `exit` can interleave and rebind the pid's
//! memory. Every caller in this module passes the dispatching pid.

use alloc::vec::Vec;

use wasm_posix_shared::Errno;

use crate::process::HostIO;

/// Copy `len` bytes out of the process at `pid`, starting at guest address
/// `addr`.
///
/// `limit` is the largest transfer the caller has proven from kernel-held
/// state. A `len` above it is `EINVAL`: the request is not merely too big for
/// this call, it exceeds what the operation can ever mean.
pub fn read_guest_bytes(
    host: &mut dyn HostIO,
    pid: i32,
    addr: u64,
    len: usize,
    limit: usize,
) -> Result<Vec<u8>, Errno> {
    if len > limit {
        return Err(Errno::EINVAL);
    }
    let mut buf = Vec::new();
    if len == 0 {
        return Ok(buf);
    }
    if addr == 0 {
        return Err(Errno::EFAULT);
    }
    // `try_reserve_exact` rather than `vec![0; len]`: `limit` bounds the
    // request semantically, but a kernel that cannot satisfy a legitimate
    // allocation must report ENOMEM rather than abort.
    buf.try_reserve_exact(len).map_err(|_| Errno::ENOMEM)?;
    buf.resize(len, 0);
    if host.proc_read_bytes(pid, addr, &mut buf) < 0 {
        return Err(Errno::EFAULT);
    }
    Ok(buf)
}

/// Allocate a zeroed staging buffer of `len` bytes for a copy-back.
pub fn zeroed_staging(len: usize, limit: usize) -> Result<Vec<u8>, Errno> {
    if len > limit {
        return Err(Errno::EINVAL);
    }
    let mut buf = Vec::new();
    buf.try_reserve_exact(len).map_err(|_| Errno::ENOMEM)?;
    buf.resize(len, 0);
    Ok(buf)
}

/// Copy `bytes` into the process at `pid`, starting at guest address `addr`.
pub fn write_guest_bytes(
    host: &mut dyn HostIO,
    pid: i32,
    addr: u64,
    bytes: &[u8],
) -> Result<(), Errno> {
    if bytes.is_empty() {
        return Ok(());
    }
    if addr == 0 {
        return Err(Errno::EFAULT);
    }
    if host.proc_write_bytes(pid, addr, bytes) < 0 {
        return Err(Errno::EFAULT);
    }
    Ok(())
}

/// Read a caller-native pointer — four bytes on wasm32, eight on wasm64 — out
/// of an already-copied structure at `offset`.
///
/// Returning `EFAULT` for a short buffer keeps a truncated caller structure
/// indistinguishable from an unreadable one, which is what the caller sees
/// either way.
pub fn native_pointer(bytes: &[u8], offset: usize, pointer_width: u8) -> Result<u64, Errno> {
    match pointer_width {
        4 => {
            let end = offset.checked_add(4).ok_or(Errno::EFAULT)?;
            let field = bytes.get(offset..end).ok_or(Errno::EFAULT)?;
            Ok(u64::from(u32::from_le_bytes([
                field[0], field[1], field[2], field[3],
            ])))
        }
        8 => {
            let end = offset.checked_add(8).ok_or(Errno::EFAULT)?;
            let field = bytes.get(offset..end).ok_or(Errno::EFAULT)?;
            Ok(u64::from_le_bytes([
                field[0], field[1], field[2], field[3], field[4], field[5], field[6], field[7],
            ]))
        }
        _ => Err(Errno::EINVAL),
    }
}

/// Write a caller-native pointer at `offset`.
pub fn write_native_pointer(
    bytes: &mut [u8],
    offset: usize,
    pointer_width: u8,
    value: u64,
) -> Result<(), Errno> {
    match pointer_width {
        4 => {
            let narrowed = u32::try_from(value).map_err(|_| Errno::EOVERFLOW)?;
            let end = offset.checked_add(4).ok_or(Errno::EFAULT)?;
            let field = bytes.get_mut(offset..end).ok_or(Errno::EFAULT)?;
            field.copy_from_slice(&narrowed.to_le_bytes());
            Ok(())
        }
        8 => {
            let end = offset.checked_add(8).ok_or(Errno::EFAULT)?;
            let field = bytes.get_mut(offset..end).ok_or(Errno::EFAULT)?;
            field.copy_from_slice(&value.to_le_bytes());
            Ok(())
        }
        _ => Err(Errno::EINVAL),
    }
}

/// Read a caller-native `long`/`ssize_t`-width signed integer at `offset`.
pub fn native_long(bytes: &[u8], offset: usize, pointer_width: u8) -> Result<i64, Errno> {
    match pointer_width {
        4 => {
            let end = offset.checked_add(4).ok_or(Errno::EFAULT)?;
            let field = bytes.get(offset..end).ok_or(Errno::EFAULT)?;
            Ok(i64::from(i32::from_le_bytes([
                field[0], field[1], field[2], field[3],
            ])))
        }
        8 => {
            let end = offset.checked_add(8).ok_or(Errno::EFAULT)?;
            let field = bytes.get(offset..end).ok_or(Errno::EFAULT)?;
            Ok(i64::from_le_bytes([
                field[0], field[1], field[2], field[3], field[4], field[5], field[6], field[7],
            ]))
        }
        _ => Err(Errno::EINVAL),
    }
}

/// Write a caller-native `long` at `offset`.
///
/// A value that does not fit a wasm32 `long` is `EOVERFLOW` rather than a
/// silent truncation: the caller would otherwise read a different number from
/// the one the kernel holds.
pub fn write_native_long(
    bytes: &mut [u8],
    offset: usize,
    pointer_width: u8,
    value: i64,
) -> Result<(), Errno> {
    match pointer_width {
        4 => {
            let narrowed = i32::try_from(value).map_err(|_| Errno::EOVERFLOW)?;
            let end = offset.checked_add(4).ok_or(Errno::EFAULT)?;
            let field = bytes.get_mut(offset..end).ok_or(Errno::EFAULT)?;
            field.copy_from_slice(&narrowed.to_le_bytes());
            Ok(())
        }
        8 => {
            let end = offset.checked_add(8).ok_or(Errno::EFAULT)?;
            let field = bytes.get_mut(offset..end).ok_or(Errno::EFAULT)?;
            field.copy_from_slice(&value.to_le_bytes());
            Ok(())
        }
        _ => Err(Errno::EINVAL),
    }
}

/// Read a 32-bit field at `offset` from an already-copied structure.
pub fn u32_field(bytes: &[u8], offset: usize) -> Result<u32, Errno> {
    let end = offset.checked_add(4).ok_or(Errno::EFAULT)?;
    let field = bytes.get(offset..end).ok_or(Errno::EFAULT)?;
    Ok(u32::from_le_bytes([field[0], field[1], field[2], field[3]]))
}

/// Write a 32-bit field at `offset` of a structure staged for copy-back.
pub fn write_u32_field(bytes: &mut [u8], offset: usize, value: u32) -> Result<(), Errno> {
    let end = offset.checked_add(4).ok_or(Errno::EFAULT)?;
    let field = bytes.get_mut(offset..end).ok_or(Errno::EFAULT)?;
    field.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::test_host::GuestMemoryHost;
    use alloc::vec;

    #[test]
    fn a_length_above_the_proven_limit_is_rejected_before_any_allocation() {
        let mut guest = GuestMemoryHost::new(0x1000, 64);
        assert_eq!(
            read_guest_bytes(&mut guest, 1, 0x1000, 65, 64).unwrap_err(),
            Errno::EINVAL
        );
        assert_eq!(zeroed_staging(65, 64).unwrap_err(), Errno::EINVAL);
    }

    #[test]
    fn a_zero_length_read_never_touches_the_pointer() {
        let mut guest = GuestMemoryHost::new(0x1000, 64);
        // POSIX has zero-length transfers whose pointer is never dereferenced;
        // a null one must not become EFAULT.
        assert!(read_guest_bytes(&mut guest, 1, 0, 0, 64).unwrap().is_empty());
        assert!(write_guest_bytes(&mut guest, 1, 0, &[]).is_ok());
    }

    #[test]
    fn an_out_of_range_guest_address_is_efault_not_a_kernel_fault() {
        let mut guest = GuestMemoryHost::new(0x1000, 64);
        assert_eq!(
            read_guest_bytes(&mut guest, 1, 0x2000, 8, 64).unwrap_err(),
            Errno::EFAULT
        );
        assert_eq!(
            write_guest_bytes(&mut guest, 1, 0x2000, &[1, 2, 3]).unwrap_err(),
            Errno::EFAULT
        );
    }

    #[test]
    fn a_null_pointer_with_a_positive_length_is_efault() {
        let mut guest = GuestMemoryHost::new(0x1000, 64);
        assert_eq!(
            read_guest_bytes(&mut guest, 1, 0, 4, 64).unwrap_err(),
            Errno::EFAULT
        );
    }

    #[test]
    fn a_round_trip_returns_the_bytes_that_were_written() {
        let mut guest = GuestMemoryHost::new(0x1000, 64);
        write_guest_bytes(&mut guest, 1, 0x1004, &[9, 8, 7, 6]).unwrap();
        assert_eq!(
            read_guest_bytes(&mut guest, 1, 0x1004, 4, 64).unwrap(),
            vec![9, 8, 7, 6]
        );
    }

    #[test]
    fn native_fields_follow_the_callers_width_not_the_kernels() {
        let bytes = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];
        assert_eq!(native_pointer(&bytes, 0, 4).unwrap(), 0x0403_0201);
        assert_eq!(native_pointer(&bytes, 0, 8).unwrap(), 0x0807_0605_0403_0201);
        assert_eq!(native_long(&(-2i64).to_le_bytes(), 0, 8).unwrap(), -2);
        assert_eq!(native_long(&(-2i32).to_le_bytes(), 0, 4).unwrap(), -2);
    }

    #[test]
    fn a_short_structure_reads_as_efault_rather_than_a_panic() {
        let bytes = [0u8; 3];
        assert_eq!(native_pointer(&bytes, 0, 4).unwrap_err(), Errno::EFAULT);
        assert_eq!(native_long(&bytes, 0, 4).unwrap_err(), Errno::EFAULT);
        assert_eq!(u32_field(&bytes, 0).unwrap_err(), Errno::EFAULT);
    }

    #[test]
    fn a_long_that_does_not_fit_the_callers_width_is_eoverflow() {
        let mut out = [0u8; 8];
        assert_eq!(
            write_native_long(&mut out, 0, 4, i64::from(i32::MAX) + 1).unwrap_err(),
            Errno::EOVERFLOW
        );
        write_native_long(&mut out, 0, 8, i64::from(i32::MAX) + 1).unwrap();
        assert_eq!(native_long(&out, 0, 8).unwrap(), i64::from(i32::MAX) + 1);
    }

    #[test]
    fn an_unsupported_pointer_width_is_einval_everywhere() {
        let bytes = [0u8; 8];
        let mut out = [0u8; 8];
        assert_eq!(native_pointer(&bytes, 0, 2).unwrap_err(), Errno::EINVAL);
        assert_eq!(native_long(&bytes, 0, 2).unwrap_err(), Errno::EINVAL);
        assert_eq!(
            write_native_long(&mut out, 0, 2, 0).unwrap_err(),
            Errno::EINVAL
        );
        assert_eq!(
            write_native_pointer(&mut out, 0, 2, 0).unwrap_err(),
            Errno::EINVAL
        );
    }
}
