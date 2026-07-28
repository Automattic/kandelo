use core::mem::{align_of, offset_of, size_of};

use wasm_posix_shared::socket::{
    KERNEL_MESSAGE_WIRE_FLATTENED_IOVEC_COUNT, SCM_RIGHTS, SCM_RIGHTS_FD_BYTES, SOL_SOCKET,
};
use wasm_posix_shared::{Errno, KernelCmsghdrWire};

// The parser below intentionally reads one flattened record. Make a protocol
// constant change fail compilation until that parser is updated in lockstep.
const _: [(); 1] = [(); KERNEL_MESSAGE_WIRE_FLATTENED_IOVEC_COUNT as usize];

fn read_wire_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + size_of::<u32>()]
            .try_into()
            .expect("fixed wire u32 range"),
    )
}

fn canonical_control_record_space(cmsg_len: usize, remaining: usize) -> Result<usize, Errno> {
    let header_size = size_of::<KernelCmsghdrWire>();
    let alignment = align_of::<KernelCmsghdrWire>();
    if cmsg_len < header_size || cmsg_len > remaining {
        return Err(Errno::EINVAL);
    }
    let aligned_len = cmsg_len.checked_add(alignment - 1).ok_or(Errno::EINVAL)? & !(alignment - 1);
    if aligned_len > remaining {
        return Err(Errno::EINVAL);
    }
    Ok(aligned_len)
}

/// Visit every descriptor in a canonical kernel SCM_RIGHTS control wire.
///
/// The visitor owns descriptor lookup and resource serialization. Keeping
/// those process operations outside this pure parser lets both native tests
/// and the Wasm export enforce exactly the same record bounds and alignment.
pub(crate) fn for_each_canonical_scm_rights_fd(
    control: &[u8],
    mut visit: impl FnMut(i32) -> Result<(), Errno>,
) -> Result<(), Errno> {
    let header_size = size_of::<KernelCmsghdrWire>();
    let len_offset = offset_of!(KernelCmsghdrWire, cmsg_len);
    let level_offset = offset_of!(KernelCmsghdrWire, cmsg_level);
    let type_offset = offset_of!(KernelCmsghdrWire, cmsg_type);
    let mut offset = 0;

    while offset < control.len() {
        let remaining = &control[offset..];
        if remaining.len() < header_size {
            return Err(Errno::EINVAL);
        }
        let cmsg_len = read_wire_u32(remaining, len_offset) as usize;
        let cmsg_level = read_wire_u32(remaining, level_offset);
        let cmsg_type = read_wire_u32(remaining, type_offset);
        // WHY: prove the complete aligned record fits before slicing or
        // advancing, so an attacker-controlled length cannot wrap or leave a
        // truncated final record accepted as a valid prefix.
        let record_space = canonical_control_record_space(cmsg_len, remaining.len())?;
        let record = &remaining[..cmsg_len];

        if cmsg_level == SOL_SOCKET && cmsg_type == SCM_RIGHTS {
            let data = &record[header_size..];
            if data.is_empty() || data.len() % SCM_RIGHTS_FD_BYTES != 0 {
                return Err(Errno::EINVAL);
            }
            for encoded_fd in data.chunks_exact(SCM_RIGHTS_FD_BYTES) {
                let fd = i32::from_le_bytes(
                    encoded_fd
                        .try_into()
                        .expect("validated SCM_RIGHTS fd width"),
                );
                visit(fd)?;
            }
        }

        offset += record_space;
    }

    Ok(())
}

pub(crate) fn validate_canonical_message_iov_len(iov_len: u32) -> Result<(), Errno> {
    match iov_len {
        0 | KERNEL_MESSAGE_WIRE_FLATTENED_IOVEC_COUNT => Ok(()),
        _ => Err(Errno::EINVAL),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::{vec, vec::Vec};

    fn control_record(cmsg_len: u32, storage_len: usize, level: u32, control_type: u32) -> Vec<u8> {
        let mut control = vec![0; storage_len];
        if storage_len >= size_of::<KernelCmsghdrWire>() {
            control[offset_of!(KernelCmsghdrWire, cmsg_len)
                ..offset_of!(KernelCmsghdrWire, cmsg_len) + size_of::<u32>()]
                .copy_from_slice(&cmsg_len.to_le_bytes());
            control[offset_of!(KernelCmsghdrWire, cmsg_level)
                ..offset_of!(KernelCmsghdrWire, cmsg_level) + size_of::<u32>()]
                .copy_from_slice(&level.to_le_bytes());
            control[offset_of!(KernelCmsghdrWire, cmsg_type)
                ..offset_of!(KernelCmsghdrWire, cmsg_type) + size_of::<u32>()]
                .copy_from_slice(&control_type.to_le_bytes());
        }
        control
    }

    fn scm_rights_control(fds: &[i32]) -> Vec<u8> {
        let header_size = size_of::<KernelCmsghdrWire>();
        let cmsg_len = header_size + fds.len() * SCM_RIGHTS_FD_BYTES;
        let mut control = control_record(cmsg_len as u32, cmsg_len, SOL_SOCKET, SCM_RIGHTS);
        for (index, fd) in fds.iter().enumerate() {
            let offset = header_size + index * SCM_RIGHTS_FD_BYTES;
            control[offset..offset + SCM_RIGHTS_FD_BYTES].copy_from_slice(&fd.to_le_bytes());
        }
        control
    }

    #[test]
    fn canonical_control_rejects_wrapped_record_space() {
        assert_eq!(
            canonical_control_record_space(usize::MAX, usize::MAX),
            Err(Errno::EINVAL),
        );

        let wrapped_wire = control_record(
            u32::MAX,
            size_of::<KernelCmsghdrWire>(),
            SOL_SOCKET,
            SCM_RIGHTS,
        );
        assert_eq!(
            for_each_canonical_scm_rights_fd(&wrapped_wire, |_| Ok(())),
            Err(Errno::EINVAL),
        );
    }

    #[test]
    fn canonical_control_rejects_short_headers_and_records() {
        let partial_header = vec![0; size_of::<KernelCmsghdrWire>() - 1];
        assert_eq!(
            for_each_canonical_scm_rights_fd(&partial_header, |_| Ok(())),
            Err(Errno::EINVAL),
        );

        let short_record = control_record(
            (size_of::<KernelCmsghdrWire>() - 1) as u32,
            size_of::<KernelCmsghdrWire>(),
            SOL_SOCKET,
            SCM_RIGHTS,
        );
        assert_eq!(
            for_each_canonical_scm_rights_fd(&short_record, |_| Ok(())),
            Err(Errno::EINVAL),
        );

        let empty_rights = control_record(
            size_of::<KernelCmsghdrWire>() as u32,
            size_of::<KernelCmsghdrWire>(),
            SOL_SOCKET,
            SCM_RIGHTS,
        );
        assert_eq!(
            for_each_canonical_scm_rights_fd(&empty_rights, |_| Ok(())),
            Err(Errno::EINVAL),
        );

        let partial_fd_len = size_of::<KernelCmsghdrWire>() + 1;
        let partial_fd = control_record(
            partial_fd_len as u32,
            (partial_fd_len + align_of::<KernelCmsghdrWire>() - 1)
                & !(align_of::<KernelCmsghdrWire>() - 1),
            SOL_SOCKET,
            SCM_RIGHTS,
        );
        assert_eq!(
            for_each_canonical_scm_rights_fd(&partial_fd, |_| Ok(())),
            Err(Errno::EINVAL),
        );
    }

    #[test]
    fn canonical_control_rejects_overlong_records_and_trailing_bytes() {
        let overlong = control_record(
            (size_of::<KernelCmsghdrWire>() + SCM_RIGHTS_FD_BYTES) as u32,
            size_of::<KernelCmsghdrWire>(),
            SOL_SOCKET,
            SCM_RIGHTS,
        );
        assert_eq!(
            for_each_canonical_scm_rights_fd(&overlong, |_| Ok(())),
            Err(Errno::EINVAL),
        );

        let trailing = control_record(
            size_of::<KernelCmsghdrWire>() as u32,
            size_of::<KernelCmsghdrWire>() + 1,
            0,
            0,
        );
        assert_eq!(
            for_each_canonical_scm_rights_fd(&trailing, |_| Ok(())),
            Err(Errno::EINVAL),
        );
    }

    #[test]
    fn canonical_control_visits_all_scm_rights_descriptors() {
        let mut control = scm_rights_control(&[3, 17]);
        control.extend_from_slice(&scm_rights_control(&[23]));
        let mut visited = Vec::new();
        for_each_canonical_scm_rights_fd(&control, |fd| {
            visited.push(fd);
            Ok(())
        })
        .unwrap();
        assert_eq!(visited, vec![3, 17, 23]);
    }

    #[test]
    fn invalid_descriptor_lookup_error_is_ebadf() {
        let control = scm_rights_control(&[123]);
        assert_eq!(
            for_each_canonical_scm_rights_fd(&control, |fd| {
                assert_eq!(fd, 123);
                Err(Errno::EBADF)
            }),
            Err(Errno::EBADF),
        );
    }

    #[test]
    fn canonical_message_iov_len_accepts_only_zero_or_one() {
        let exact = KERNEL_MESSAGE_WIRE_FLATTENED_IOVEC_COUNT;
        assert_eq!(validate_canonical_message_iov_len(0), Ok(()));
        assert_eq!(validate_canonical_message_iov_len(exact), Ok(()));
        assert_eq!(
            validate_canonical_message_iov_len(exact + 1),
            Err(Errno::EINVAL),
        );
        assert_eq!(
            validate_canonical_message_iov_len(u32::MAX),
            Err(Errno::EINVAL),
        );
    }
}
