//! Caller-native `struct msghdr`, `struct iovec` and `struct cmsghdr` access.
//!
//! `sendmsg`/`recvmsg` take one pointer that leads to three more. A
//! `struct msghdr` holds `msg_name`, an `msg_iov` array, and `msg_control`,
//! and it carries each of their sizes in its own fields — so no static syscall
//! argument descriptor can describe it. The argument is declared
//! `SyscallArgSize::KernelDereferenced` and the kernel walks the whole
//! structure itself, through [`crate::guest_ptr`].
//!
//! # Why the caller's width, never the kernel's
//!
//! One wasm32 kernel instance serves both wasm32 and wasm64 processes, so its
//! own compilation target is never authoritative for a caller structure. Two
//! places make that especially easy to get wrong, and both are why these
//! offsets are generated data rather than arithmetic on a pointer width:
//!
//! * musl keeps `msg_iovlen` (`int`) and `msg_controllen` (`socklen_t`)
//!   **32-bit on wasm64**, then adds four bytes of ABI padding after each.
//!   Reading either as a `size_t` would treat unrelated padding as the high
//!   half of a count and reject, or mis-size, a valid message.
//! * CMSG records align to four bytes on wasm32 and eight on wasm64, and the
//!   wasm64 `cmsghdr` has a four-byte pad after `cmsg_len`.
//!
//! # Copy once, then parse
//!
//! Every read below copies a bounded range out of the caller and parses the
//! copy. Caller memory is shared: re-reading a length after checking it is the
//! time-of-check/time-of-use hazard that lets a peer thread widen a buffer the
//! kernel already sized.

use alloc::vec::Vec;

use wasm_posix_shared::process_layout;
use wasm_posix_shared::socket::{SCM_RIGHTS, SCM_RIGHTS_FD_BYTES, SOL_SOCKET};
use wasm_posix_shared::{platform_limits, Errno};

use crate::guest_ptr;
use crate::process::HostIO;

/// The caller's `struct msghdr`, decoded from one copied snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeMsghdr {
    /// `msg_name`, the optional source/destination address.
    pub name_addr: u64,
    /// `msg_namelen`. Value-result for `recvmsg`.
    pub name_len: u32,
    /// `msg_iov`, the caller's scatter/gather table.
    pub iov_addr: u64,
    /// `msg_iovlen`.
    pub iov_count: u32,
    /// `msg_control`, the optional ancillary-data buffer.
    pub control_addr: u64,
    /// `msg_controllen`. Value-result for `recvmsg`.
    pub control_len: u32,
    /// `msg_flags`. Output-only; POSIX ignores whatever the caller left here.
    pub flags: u32,
}

/// One entry of the caller's `struct iovec` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeIovec {
    pub base: u64,
    pub len: usize,
}

/// One decoded ancillary-data record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeCmsg {
    pub level: u32,
    pub cmsg_type: u32,
    pub data: Vec<u8>,
}

struct MsghdrLayout {
    size: usize,
    name: usize,
    name_len: usize,
    iov: usize,
    iov_len: usize,
    control: usize,
    control_len: usize,
    flags: usize,
}

fn msghdr_layout(pointer_width: u8) -> Result<MsghdrLayout, Errno> {
    use process_layout::msghdr as m;
    match pointer_width {
        4 => Ok(MsghdrLayout {
            size: m::WASM32_SIZE as usize,
            name: m::WASM32_NAME_OFFSET as usize,
            name_len: m::WASM32_NAMELEN_OFFSET as usize,
            iov: m::WASM32_IOV_OFFSET as usize,
            iov_len: m::WASM32_IOVLEN_OFFSET as usize,
            control: m::WASM32_CONTROL_OFFSET as usize,
            control_len: m::WASM32_CONTROLLEN_OFFSET as usize,
            flags: m::WASM32_FLAGS_OFFSET as usize,
        }),
        8 => Ok(MsghdrLayout {
            size: m::WASM64_SIZE as usize,
            name: m::WASM64_NAME_OFFSET as usize,
            name_len: m::WASM64_NAMELEN_OFFSET as usize,
            iov: m::WASM64_IOV_OFFSET as usize,
            iov_len: m::WASM64_IOVLEN_OFFSET as usize,
            control: m::WASM64_CONTROL_OFFSET as usize,
            control_len: m::WASM64_CONTROLLEN_OFFSET as usize,
            flags: m::WASM64_FLAGS_OFFSET as usize,
        }),
        _ => Err(Errno::EINVAL),
    }
}

struct CmsgLayout {
    header: usize,
    align: usize,
    len: usize,
    level: usize,
    cmsg_type: usize,
    data: usize,
}

fn cmsg_layout(pointer_width: u8) -> Result<CmsgLayout, Errno> {
    use process_layout::cmsghdr as c;
    match pointer_width {
        4 => Ok(CmsgLayout {
            header: c::WASM32_SIZE as usize,
            align: c::WASM32_ALIGN as usize,
            len: c::WASM32_LEN_OFFSET as usize,
            level: c::WASM32_LEVEL_OFFSET as usize,
            cmsg_type: c::WASM32_TYPE_OFFSET as usize,
            data: c::WASM32_DATA_OFFSET as usize,
        }),
        8 => Ok(CmsgLayout {
            header: c::WASM64_SIZE as usize,
            align: c::WASM64_ALIGN as usize,
            len: c::WASM64_LEN_OFFSET as usize,
            level: c::WASM64_LEVEL_OFFSET as usize,
            cmsg_type: c::WASM64_TYPE_OFFSET as usize,
            data: c::WASM64_DATA_OFFSET as usize,
        }),
        _ => Err(Errno::EINVAL),
    }
}

fn iovec_layout(pointer_width: u8) -> Result<(usize, usize, usize), Errno> {
    use process_layout::iovec as v;
    match pointer_width {
        4 => Ok((
            v::WASM32_SIZE as usize,
            v::WASM32_BASE_OFFSET as usize,
            v::WASM32_LEN_OFFSET as usize,
        )),
        8 => Ok((
            v::WASM64_SIZE as usize,
            v::WASM64_BASE_OFFSET as usize,
            v::WASM64_LEN_OFFSET as usize,
        )),
        _ => Err(Errno::EINVAL),
    }
}

fn align_up(value: usize, align: usize) -> Result<usize, Errno> {
    if align == 0 || !align.is_power_of_two() {
        return Err(Errno::EINVAL);
    }
    value
        .checked_add(align - 1)
        .map(|value| value & !(align - 1))
        .ok_or(Errno::EINVAL)
}

/// Byte size of the caller's `struct msghdr`.
pub fn msghdr_size(pointer_width: u8) -> Result<usize, Errno> {
    Ok(msghdr_layout(pointer_width)?.size)
}

/// Copy and decode the caller's `struct msghdr`.
pub fn read_msghdr(
    host: &mut dyn HostIO,
    pid: i32,
    addr: u64,
    pointer_width: u8,
) -> Result<NativeMsghdr, Errno> {
    let layout = msghdr_layout(pointer_width)?;
    if addr == 0 {
        return Err(Errno::EFAULT);
    }
    let bytes = guest_ptr::read_guest_bytes(host, pid, addr, layout.size, layout.size)?;
    Ok(NativeMsghdr {
        name_addr: guest_ptr::native_pointer(&bytes, layout.name, pointer_width)?,
        name_len: guest_ptr::u32_field(&bytes, layout.name_len)?,
        iov_addr: guest_ptr::native_pointer(&bytes, layout.iov, pointer_width)?,
        iov_count: guest_ptr::u32_field(&bytes, layout.iov_len)?,
        control_addr: guest_ptr::native_pointer(&bytes, layout.control, pointer_width)?,
        control_len: guest_ptr::u32_field(&bytes, layout.control_len)?,
        flags: guest_ptr::u32_field(&bytes, layout.flags)?,
    })
}

/// Publish `recvmsg`'s value-result fields back into the caller's `msghdr`.
///
/// Only the three fields the kernel owns are written, each on its own, rather
/// than the whole structure: re-publishing `msg_iov`, `msg_iovlen` or the two
/// buffer pointers would overwrite caller-owned bytes with a snapshot taken
/// before the call.
///
/// `name_len` is written only when the caller supplied a non-null `msg_name`.
/// POSIX makes `msg_namelen` value-result on presence, not capacity, so a
/// non-null zero-capacity pointer still receives the complete length — that is
/// how a caller learns its address buffer was too small.
pub fn write_msghdr_results(
    host: &mut dyn HostIO,
    pid: i32,
    addr: u64,
    pointer_width: u8,
    name_len: Option<u32>,
    control_len: u32,
    flags: u32,
) -> Result<(), Errno> {
    let layout = msghdr_layout(pointer_width)?;
    let mut field = [0u8; 4];
    if let Some(name_len) = name_len {
        field.copy_from_slice(&name_len.to_le_bytes());
        guest_ptr::write_guest_bytes(host, pid, addr + layout.name_len as u64, &field)?;
    }
    field.copy_from_slice(&control_len.to_le_bytes());
    guest_ptr::write_guest_bytes(host, pid, addr + layout.control_len as u64, &field)?;
    field.copy_from_slice(&flags.to_le_bytes());
    guest_ptr::write_guest_bytes(host, pid, addr + layout.flags as u64, &field)
}

/// Copy and decode the caller's `struct iovec` table.
///
/// A count above `IOV_MAX` is EINVAL, as POSIX requires, and it is checked
/// before the table is read so an absurd count cannot size a kernel
/// allocation.
pub fn read_iovecs(
    host: &mut dyn HostIO,
    pid: i32,
    addr: u64,
    count: u32,
    pointer_width: u8,
) -> Result<Vec<NativeIovec>, Errno> {
    let count = count as usize;
    if count > platform_limits::IOV_MAX {
        return Err(Errno::EINVAL);
    }
    let mut entries = Vec::new();
    if count == 0 {
        return Ok(entries);
    }
    let (entry_size, base_offset, len_offset) = iovec_layout(pointer_width)?;
    let table_bytes = count.checked_mul(entry_size).ok_or(Errno::EINVAL)?;
    let table = guest_ptr::read_guest_bytes(host, pid, addr, table_bytes, table_bytes)?;
    entries.try_reserve_exact(count).map_err(|_| Errno::ENOMEM)?;
    let mut total: usize = 0;
    for index in 0..count {
        let offset = index * entry_size;
        let len = guest_ptr::native_pointer(&table, offset + len_offset, pointer_width)?;
        let len = usize::try_from(len).map_err(|_| Errno::EINVAL)?;
        // POSIX ignores `iov_base` when `iov_len` is zero, so a wasm64 caller
        // may leave anything at all there without naming a byte.
        let base = if len == 0 {
            0
        } else {
            guest_ptr::native_pointer(&table, offset + base_offset, pointer_width)?
        };
        total = total.checked_add(len).ok_or(Errno::EINVAL)?;
        if total > platform_limits::MAX_REPORTABLE_TRANSFER_BYTES {
            // The aggregate length of a scatter/gather transfer must be
            // representable as a return value; POSIX says EINVAL.
            return Err(Errno::EINVAL);
        }
        entries.push(NativeIovec { base, len });
    }
    Ok(entries)
}

/// Total bytes an iovec table addresses.
pub fn iovec_total(entries: &[NativeIovec]) -> Result<usize, Errno> {
    let mut total: usize = 0;
    for entry in entries {
        total = total.checked_add(entry.len).ok_or(Errno::EINVAL)?;
    }
    Ok(total)
}

/// Gather every iovec's bytes into one contiguous kernel-owned buffer.
pub fn gather(
    host: &mut dyn HostIO,
    pid: i32,
    entries: &[NativeIovec],
) -> Result<Vec<u8>, Errno> {
    let total = iovec_total(entries)?;
    let mut out = guest_ptr::zeroed_staging(total, platform_limits::MAX_REPORTABLE_TRANSFER_BYTES)?;
    let mut cursor = 0usize;
    for entry in entries {
        if entry.len == 0 {
            continue;
        }
        let chunk = guest_ptr::read_guest_bytes(host, pid, entry.base, entry.len, entry.len)?;
        out[cursor..cursor + entry.len].copy_from_slice(&chunk);
        cursor += entry.len;
    }
    Ok(out)
}

/// Scatter `data` across the caller's iovecs, stopping when it runs out.
///
/// Returns the number of bytes written, which equals `data.len()` whenever the
/// table has room — the caller has already bounded the transfer by
/// [`iovec_total`].
pub fn scatter(
    host: &mut dyn HostIO,
    pid: i32,
    entries: &[NativeIovec],
    data: &[u8],
) -> Result<usize, Errno> {
    let mut written = 0usize;
    for entry in entries {
        if written >= data.len() {
            break;
        }
        if entry.len == 0 {
            continue;
        }
        let take = entry.len.min(data.len() - written);
        guest_ptr::write_guest_bytes(host, pid, entry.base, &data[written..written + take])?;
        written += take;
    }
    Ok(written)
}

/// Copy and decode the caller's ancillary-data buffer.
///
/// A malformed record is EINVAL rather than a silent truncation: a caller that
/// meant to pass descriptors must not be told the message was sent without
/// them.
pub fn read_control(
    host: &mut dyn HostIO,
    pid: i32,
    addr: u64,
    control_len: u32,
    pointer_width: u8,
) -> Result<Vec<NativeCmsg>, Errno> {
    let mut records = Vec::new();
    let control_len = control_len as usize;
    if control_len == 0 || addr == 0 {
        return Ok(records);
    }
    let layout = cmsg_layout(pointer_width)?;
    // The guest never sizes a kernel allocation on its own: `msg_controllen`
    // is a caller-chosen u32, so it is bounded by the operation's own limit
    // rather than by whichever allocation happens to fail first.
    let bytes = guest_ptr::read_guest_bytes(
        host,
        pid,
        addr,
        control_len,
        platform_limits::SOCKET_CONTROL_MAX_BYTES,
    )?;

    let mut offset = 0usize;
    while offset + layout.header <= control_len {
        let cmsg_len = guest_ptr::native_pointer(&bytes, offset + layout.len, pointer_width)?;
        let cmsg_len = usize::try_from(cmsg_len).map_err(|_| Errno::EINVAL)?;
        if cmsg_len < layout.data {
            return Err(Errno::EINVAL);
        }
        let end = offset.checked_add(cmsg_len).ok_or(Errno::EINVAL)?;
        if end > control_len {
            return Err(Errno::EINVAL);
        }
        let level = guest_ptr::u32_field(&bytes, offset + layout.level)?;
        let cmsg_type = guest_ptr::u32_field(&bytes, offset + layout.cmsg_type)?;
        let data = &bytes[offset + layout.data..end];
        if level == SOL_SOCKET
            && cmsg_type == SCM_RIGHTS
            && data.len() % SCM_RIGHTS_FD_BYTES != 0
        {
            // A partial descriptor is not a descriptor. Refusing here keeps a
            // truncated `SCM_RIGHTS` payload from installing a fd built out of
            // fewer than four bytes.
            return Err(Errno::EINVAL);
        }
        let mut owned = Vec::new();
        owned
            .try_reserve_exact(data.len())
            .map_err(|_| Errno::ENOMEM)?;
        owned.extend_from_slice(data);
        records.push(NativeCmsg {
            level,
            cmsg_type,
            data: owned,
        });
        offset = align_up(end, layout.align)?;
    }
    Ok(records)
}

/// Byte size one record occupies in a caller-native control buffer.
pub fn control_space(pointer_width: u8, data_len: usize) -> Result<usize, Errno> {
    let layout = cmsg_layout(pointer_width)?;
    let record = layout.data.checked_add(data_len).ok_or(Errno::EINVAL)?;
    align_up(record, layout.align)
}

/// How many `SCM_RIGHTS` descriptors a caller's control buffer can hold.
///
/// This is what bounds fd installation: descriptors that will not fit must
/// never become receiver OFDs, because the caller would have no way to close
/// them. The count is derived from the CALLER-native header size, so a wasm64
/// receiver is not credited with the extra room a wasm32 header would leave.
pub fn control_fd_capacity(pointer_width: u8, control_len: u32) -> Result<usize, Errno> {
    let layout = cmsg_layout(pointer_width)?;
    let control_len = control_len as usize;
    if control_len < layout.data + SCM_RIGHTS_FD_BYTES {
        return Ok(0);
    }
    Ok((control_len - layout.data) / SCM_RIGHTS_FD_BYTES)
}

/// Serialize one `SCM_RIGHTS` record into the caller's control buffer.
///
/// Returns the `msg_controllen` the caller should observe: the record's
/// aligned span, never more than the buffer it supplied.
pub fn write_scm_rights(
    host: &mut dyn HostIO,
    pid: i32,
    addr: u64,
    control_len: u32,
    pointer_width: u8,
    fds: &[i32],
) -> Result<u32, Errno> {
    if fds.is_empty() {
        return Ok(0);
    }
    let layout = cmsg_layout(pointer_width)?;
    let data_len = fds
        .len()
        .checked_mul(SCM_RIGHTS_FD_BYTES)
        .ok_or(Errno::EOVERFLOW)?;
    let record_len = layout.data.checked_add(data_len).ok_or(Errno::EOVERFLOW)?;
    let span = align_up(record_len, layout.align)?;
    let control_len = control_len as usize;
    if record_len > control_len {
        // The caller's capacity was checked before any descriptor was
        // installed, so reaching this is a kernel accounting error rather
        // than a caller mistake.
        return Err(Errno::EIO);
    }
    let published = span.min(control_len);
    let mut out = guest_ptr::zeroed_staging(published, published)?;
    guest_ptr::write_native_long(&mut out, layout.len, pointer_width, record_len as i64)?;
    guest_ptr::write_u32_field(&mut out, layout.level, SOL_SOCKET)?;
    guest_ptr::write_u32_field(&mut out, layout.cmsg_type, SCM_RIGHTS)?;
    for (index, fd) in fds.iter().enumerate() {
        let at = layout.data + index * SCM_RIGHTS_FD_BYTES;
        out[at..at + SCM_RIGHTS_FD_BYTES].copy_from_slice(&fd.to_le_bytes());
    }
    guest_ptr::write_guest_bytes(host, pid, addr, &out)?;
    u32::try_from(published).map_err(|_| Errno::EOVERFLOW)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::test_host::GuestMemoryHost;
    use alloc::vec;

    const BASE: u64 = 0x1_0000;

    fn write_msghdr(
        guest: &mut GuestMemoryHost,
        addr: u64,
        pointer_width: u8,
        hdr: NativeMsghdr,
    ) {
        let layout = msghdr_layout(pointer_width).unwrap();
        let mut bytes = vec![0u8; layout.size];
        guest_ptr::write_native_pointer(&mut bytes, layout.name, pointer_width, hdr.name_addr)
            .unwrap();
        guest_ptr::write_u32_field(&mut bytes, layout.name_len, hdr.name_len).unwrap();
        guest_ptr::write_native_pointer(&mut bytes, layout.iov, pointer_width, hdr.iov_addr)
            .unwrap();
        guest_ptr::write_u32_field(&mut bytes, layout.iov_len, hdr.iov_count).unwrap();
        guest_ptr::write_native_pointer(
            &mut bytes,
            layout.control,
            pointer_width,
            hdr.control_addr,
        )
        .unwrap();
        guest_ptr::write_u32_field(&mut bytes, layout.control_len, hdr.control_len).unwrap();
        guest_ptr::write_u32_field(&mut bytes, layout.flags, hdr.flags).unwrap();
        guest.poke(addr, &bytes);
    }

    fn write_iovecs(
        guest: &mut GuestMemoryHost,
        addr: u64,
        pointer_width: u8,
        entries: &[NativeIovec],
    ) {
        let (size, base_offset, len_offset) = iovec_layout(pointer_width).unwrap();
        let mut table = vec![0u8; size * entries.len()];
        for (index, entry) in entries.iter().enumerate() {
            let at = index * size;
            guest_ptr::write_native_pointer(&mut table, at + base_offset, pointer_width, entry.base)
                .unwrap();
            guest_ptr::write_native_pointer(
                &mut table,
                at + len_offset,
                pointer_width,
                entry.len as u64,
            )
            .unwrap();
        }
        guest.poke(addr, &table);
    }

    #[test]
    fn a_msghdr_decodes_identically_on_both_caller_widths() {
        for pointer_width in [4u8, 8u8] {
            let mut guest = GuestMemoryHost::new(BASE, 4096);
            let expected = NativeMsghdr {
                name_addr: BASE + 0x100,
                name_len: 16,
                iov_addr: BASE + 0x200,
                iov_count: 2,
                control_addr: BASE + 0x300,
                control_len: 24,
                flags: 0,
            };
            write_msghdr(&mut guest, BASE, pointer_width, expected);
            assert_eq!(
                read_msghdr(&mut guest, 1, BASE, pointer_width).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn iovlen_and_controllen_stay_32_bit_on_wasm64() {
        // musl keeps both fields `int`/`socklen_t` wide on wasm64 and pads
        // after them. Poisoning the padding must not change the decoded
        // counts: reading either as a size_t would fold the pad into the
        // high half.
        let pointer_width = 8u8;
        let layout = msghdr_layout(pointer_width).unwrap();
        let mut guest = GuestMemoryHost::new(BASE, 4096);
        let header = NativeMsghdr {
            name_addr: 0,
            name_len: 0,
            iov_addr: BASE + 0x200,
            iov_count: 3,
            control_addr: 0,
            control_len: 7,
            flags: 0,
        };
        write_msghdr(&mut guest, BASE, pointer_width, header);
        guest.poke(
            BASE + layout.iov_len as u64 + 4,
            &0xdead_beefu32.to_le_bytes(),
        );
        guest.poke(
            BASE + layout.control_len as u64 + 4,
            &0xfeed_faceu32.to_le_bytes(),
        );
        let decoded = read_msghdr(&mut guest, 1, BASE, pointer_width).unwrap();
        assert_eq!(decoded.iov_count, 3);
        assert_eq!(decoded.control_len, 7);
    }

    #[test]
    fn gather_and_scatter_round_trip_across_multiple_buffers() {
        for pointer_width in [4u8, 8u8] {
            let mut guest = GuestMemoryHost::new(BASE, 8192);
            let entries = [
                NativeIovec {
                    base: BASE + 0x400,
                    len: 3,
                },
                // A zero-length entry is skipped entirely and its base is
                // never dereferenced.
                NativeIovec { base: 0, len: 0 },
                NativeIovec {
                    base: BASE + 0x500,
                    len: 2,
                },
            ];
            guest.poke(BASE + 0x400, &[1, 2, 3]);
            guest.poke(BASE + 0x500, &[4, 5]);
            write_iovecs(&mut guest, BASE + 0x200, pointer_width, &entries);

            let decoded =
                read_iovecs(&mut guest, 1, BASE + 0x200, 3, pointer_width).unwrap();
            assert_eq!(decoded, entries);
            assert_eq!(gather(&mut guest, 1, &decoded).unwrap(), vec![1, 2, 3, 4, 5]);

            assert_eq!(
                scatter(&mut guest, 1, &decoded, &[9, 8, 7, 6, 5]).unwrap(),
                5
            );
            assert_eq!(guest.peek(BASE + 0x400, 3), &[9, 8, 7]);
            assert_eq!(guest.peek(BASE + 0x500, 2), &[6, 5]);
        }
    }

    #[test]
    fn a_short_result_fills_only_the_leading_iovecs() {
        let mut guest = GuestMemoryHost::new(BASE, 8192);
        let entries = [
            NativeIovec {
                base: BASE + 0x400,
                len: 4,
            },
            NativeIovec {
                base: BASE + 0x500,
                len: 4,
            },
        ];
        guest.poke(BASE + 0x500, &[0xff, 0xff, 0xff, 0xff]);
        assert_eq!(scatter(&mut guest, 1, &entries, &[1, 2]).unwrap(), 2);
        assert_eq!(guest.peek(BASE + 0x400, 2), &[1, 2]);
        // The untouched trailing buffer keeps the caller's bytes.
        assert_eq!(guest.peek(BASE + 0x500, 4), &[0xff, 0xff, 0xff, 0xff]);
    }

    #[test]
    fn an_iovec_count_above_iov_max_is_rejected_before_the_table_is_read() {
        let mut guest = GuestMemoryHost::new(BASE, 64);
        assert_eq!(
            read_iovecs(
                &mut guest,
                1,
                BASE,
                platform_limits::IOV_MAX as u32 + 1,
                4
            )
            .unwrap_err(),
            Errno::EINVAL
        );
    }

    #[test]
    fn control_records_follow_the_callers_alignment() {
        for (pointer_width, expected_span) in [(4u8, 16usize), (8u8, 24usize)] {
            // One SCM_RIGHTS record carrying one fd: header + 4 data bytes,
            // rounded up to the caller's CMSG alignment.
            assert_eq!(
                control_space(pointer_width, SCM_RIGHTS_FD_BYTES).unwrap(),
                expected_span
            );
        }
    }

    #[test]
    fn a_control_chain_decodes_every_record_on_both_widths() {
        for pointer_width in [4u8, 8u8] {
            let layout = cmsg_layout(pointer_width).unwrap();
            let mut guest = GuestMemoryHost::new(BASE, 8192);
            let first_data = [7i32, 9i32];
            let first_len = layout.data + first_data.len() * SCM_RIGHTS_FD_BYTES;
            let first_span = align_up(first_len, layout.align).unwrap();
            let second_data = [1u8, 2, 3];
            let second_len = layout.data + second_data.len();
            let total = first_span + align_up(second_len, layout.align).unwrap();

            let mut buffer = vec![0u8; total];
            guest_ptr::write_native_long(&mut buffer, layout.len, pointer_width, first_len as i64)
                .unwrap();
            guest_ptr::write_u32_field(&mut buffer, layout.level, SOL_SOCKET).unwrap();
            guest_ptr::write_u32_field(&mut buffer, layout.cmsg_type, SCM_RIGHTS).unwrap();
            for (index, fd) in first_data.iter().enumerate() {
                let at = layout.data + index * SCM_RIGHTS_FD_BYTES;
                buffer[at..at + 4].copy_from_slice(&fd.to_le_bytes());
            }
            guest_ptr::write_native_long(
                &mut buffer,
                first_span + layout.len,
                pointer_width,
                second_len as i64,
            )
            .unwrap();
            guest_ptr::write_u32_field(&mut buffer, first_span + layout.level, 41).unwrap();
            guest_ptr::write_u32_field(&mut buffer, first_span + layout.cmsg_type, 42).unwrap();
            buffer[first_span + layout.data..first_span + layout.data + 3]
                .copy_from_slice(&second_data);
            guest.poke(BASE, &buffer);

            let records =
                read_control(&mut guest, 1, BASE, total as u32, pointer_width).unwrap();
            assert_eq!(records.len(), 2);
            assert_eq!(records[0].level, SOL_SOCKET);
            assert_eq!(records[0].cmsg_type, SCM_RIGHTS);
            assert_eq!(records[0].data.len(), 8);
            assert_eq!(records[1].level, 41);
            assert_eq!(records[1].cmsg_type, 42);
            assert_eq!(records[1].data, vec![1, 2, 3]);
        }
    }

    #[test]
    fn a_control_length_above_the_operations_limit_is_rejected() {
        // `msg_controllen` is a caller-chosen u32. Without an explicit ceiling
        // the only thing standing between a 4 GiB claim and a 4 GiB kernel
        // allocation is whether that allocation happens to fail — which makes
        // the errno depend on unrelated memory pressure. Bound it by the
        // operation.
        let mut guest = GuestMemoryHost::new(BASE, 4096);
        assert_eq!(
            read_control(
                &mut guest,
                1,
                BASE,
                platform_limits::SOCKET_CONTROL_MAX_BYTES as u32 + 1,
                4,
            )
            .unwrap_err(),
            Errno::EINVAL
        );
    }

    #[test]
    fn a_partial_scm_rights_payload_is_refused() {
        // Three bytes cannot be a descriptor. Accepting it would install one
        // built from a truncated value.
        let pointer_width = 4u8;
        let layout = cmsg_layout(pointer_width).unwrap();
        let mut guest = GuestMemoryHost::new(BASE, 4096);
        let record_len = layout.data + 3;
        let span = align_up(record_len, layout.align).unwrap();
        let mut buffer = vec![0u8; span];
        guest_ptr::write_native_long(&mut buffer, layout.len, pointer_width, record_len as i64)
            .unwrap();
        guest_ptr::write_u32_field(&mut buffer, layout.level, SOL_SOCKET).unwrap();
        guest_ptr::write_u32_field(&mut buffer, layout.cmsg_type, SCM_RIGHTS).unwrap();
        guest.poke(BASE, &buffer);
        assert_eq!(
            read_control(&mut guest, 1, BASE, span as u32, pointer_width).unwrap_err(),
            Errno::EINVAL
        );
    }

    #[test]
    fn a_cmsg_len_past_the_buffer_is_refused() {
        let pointer_width = 8u8;
        let layout = cmsg_layout(pointer_width).unwrap();
        let mut guest = GuestMemoryHost::new(BASE, 4096);
        let mut buffer = vec![0u8; layout.header];
        guest_ptr::write_native_long(&mut buffer, layout.len, pointer_width, 4096).unwrap();
        guest.poke(BASE, &buffer);
        assert_eq!(
            read_control(&mut guest, 1, BASE, layout.header as u32, pointer_width).unwrap_err(),
            Errno::EINVAL
        );
    }

    #[test]
    fn a_cmsg_len_below_the_header_is_refused() {
        let pointer_width = 4u8;
        let layout = cmsg_layout(pointer_width).unwrap();
        let mut guest = GuestMemoryHost::new(BASE, 4096);
        let mut buffer = vec![0u8; layout.header];
        guest_ptr::write_native_long(&mut buffer, layout.len, pointer_width, 1).unwrap();
        guest.poke(BASE, &buffer);
        assert_eq!(
            read_control(&mut guest, 1, BASE, layout.header as u32, pointer_width).unwrap_err(),
            Errno::EINVAL
        );
    }

    #[test]
    fn fd_capacity_uses_the_callers_header_size() {
        // 32 bytes holds five fds after a 12-byte wasm32 header, but only
        // four after a 16-byte wasm64 one. Crediting a wasm64 receiver with
        // the wasm32 count would install a descriptor it could never see.
        assert_eq!(control_fd_capacity(4, 32).unwrap(), 5);
        assert_eq!(control_fd_capacity(8, 32).unwrap(), 4);
        // Too small for a header plus one descriptor at all.
        assert_eq!(control_fd_capacity(4, 12).unwrap(), 0);
        assert_eq!(control_fd_capacity(8, 16).unwrap(), 0);
    }

    #[test]
    fn a_written_scm_rights_record_reads_back_as_itself() {
        for pointer_width in [4u8, 8u8] {
            let mut guest = GuestMemoryHost::new(BASE, 4096);
            let fds = [11i32, 12, 13];
            let capacity = control_space(pointer_width, fds.len() * SCM_RIGHTS_FD_BYTES).unwrap();
            let published = write_scm_rights(
                &mut guest,
                1,
                BASE,
                capacity as u32,
                pointer_width,
                &fds,
            )
            .unwrap();
            assert_eq!(published as usize, capacity);
            let records =
                read_control(&mut guest, 1, BASE, published, pointer_width).unwrap();
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].level, SOL_SOCKET);
            assert_eq!(records[0].cmsg_type, SCM_RIGHTS);
            let decoded: Vec<i32> = records[0]
                .data
                .chunks_exact(4)
                .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            assert_eq!(decoded, fds);
        }
    }

    #[test]
    fn msghdr_results_touch_only_the_kernel_owned_fields() {
        let pointer_width = 4u8;
        let layout = msghdr_layout(pointer_width).unwrap();
        let mut guest = GuestMemoryHost::new(BASE, 4096);
        let header = NativeMsghdr {
            name_addr: BASE + 0x100,
            name_len: 128,
            iov_addr: BASE + 0x200,
            iov_count: 2,
            control_addr: BASE + 0x300,
            control_len: 64,
            flags: 0,
        };
        write_msghdr(&mut guest, BASE, pointer_width, header);
        write_msghdr_results(&mut guest, 1, BASE, pointer_width, Some(16), 32, 8).unwrap();
        let after = read_msghdr(&mut guest, 1, BASE, pointer_width).unwrap();
        assert_eq!(after.name_len, 16);
        assert_eq!(after.control_len, 32);
        assert_eq!(after.flags, 8);
        // The caller's own fields survive untouched.
        assert_eq!(after.name_addr, header.name_addr);
        assert_eq!(after.iov_addr, header.iov_addr);
        assert_eq!(after.iov_count, header.iov_count);
        assert_eq!(after.control_addr, header.control_addr);
        let _ = layout;
    }

    #[test]
    fn an_absent_msg_name_leaves_msg_namelen_alone() {
        // POSIX makes msg_namelen value-result on PRESENCE. A caller that
        // passed no address keeps whatever stale length it had.
        let pointer_width = 8u8;
        let mut guest = GuestMemoryHost::new(BASE, 4096);
        let header = NativeMsghdr {
            name_addr: 0,
            name_len: 99,
            iov_addr: BASE + 0x200,
            iov_count: 1,
            control_addr: 0,
            control_len: 0,
            flags: 0,
        };
        write_msghdr(&mut guest, BASE, pointer_width, header);
        write_msghdr_results(&mut guest, 1, BASE, pointer_width, None, 0, 0).unwrap();
        assert_eq!(
            read_msghdr(&mut guest, 1, BASE, pointer_width).unwrap().name_len,
            99
        );
    }
}
