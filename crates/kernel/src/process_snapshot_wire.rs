//! Capacity-checked host process-snapshot record encoding.
//!
//! This stays separate from the Wasm export module so native unit tests can
//! prove the exact record capacity and atomic short-buffer behavior.

use wasm_posix_shared::{process_snapshot_wire as wire, Errno};

pub(crate) struct ProcessSnapshotHeader {
    pub(crate) pid: u32,
    pub(crate) ppid: u32,
    pub(crate) uid: u32,
    pub(crate) gid: u32,
    pub(crate) vsize: u64,
    pub(crate) state: u32,
    pub(crate) comm_len: u32,
    pub(crate) cmdline_len: u32,
}

pub(crate) fn write_process_snapshot_header(
    buf: &mut [u8],
    off: &mut usize,
    header: &ProcessSnapshotHeader,
) -> Result<(), Errno> {
    let end = (*off)
        .checked_add(wire::HEADER_BYTES)
        .ok_or(Errno::EOVERFLOW)?;
    if end > buf.len() {
        return Err(Errno::ENOSPC);
    }
    let base = *off;
    write_u32_at(buf, base + wire::PID_OFFSET, header.pid);
    write_u32_at(buf, base + wire::PPID_OFFSET, header.ppid);
    write_u32_at(buf, base + wire::UID_OFFSET, header.uid);
    write_u32_at(buf, base + wire::GID_OFFSET, header.gid);
    write_u64_at(buf, base + wire::VSIZE_OFFSET, header.vsize);
    write_u32_at(buf, base + wire::STATE_OFFSET, header.state);
    write_u32_at(buf, base + wire::COMM_LEN_OFFSET, header.comm_len);
    write_u32_at(
        buf,
        base + wire::CMDLINE_LEN_OFFSET,
        header.cmdline_len,
    );
    *off = end;
    Ok(())
}

pub(crate) fn process_snapshot_record_bytes(
    comm_len: usize,
    cmdline_len: usize,
) -> Result<usize, Errno> {
    wire::HEADER_BYTES
        .checked_add(comm_len)
        .and_then(|bytes| bytes.checked_add(cmdline_len))
        .ok_or(Errno::EOVERFLOW)
}

/// Write one complete variable-sized record or leave the destination untouched.
///
/// WHY: preflighting the complete header plus both byte strings prevents a
/// short allocation from observing a valid-looking header for a partial
/// record, and keeps the host's all-or-nothing parser contract truthful.
pub(crate) fn write_process_snapshot_record(
    buf: &mut [u8],
    off: &mut usize,
    header: &ProcessSnapshotHeader,
    comm: &[u8],
    cmdline: &[u8],
) -> Result<(), Errno> {
    if usize::try_from(header.comm_len).map_err(|_| Errno::EOVERFLOW)? != comm.len()
        || usize::try_from(header.cmdline_len).map_err(|_| Errno::EOVERFLOW)? != cmdline.len()
    {
        return Err(Errno::EINVAL);
    }
    let record_bytes = process_snapshot_record_bytes(comm.len(), cmdline.len())?;
    let end = (*off)
        .checked_add(record_bytes)
        .ok_or(Errno::EOVERFLOW)?;
    if end > buf.len() {
        return Err(Errno::ENOSPC);
    }

    let mut cursor = *off;
    write_process_snapshot_header(buf, &mut cursor, header)?;
    let comm_end = cursor + comm.len();
    buf[cursor..comm_end].copy_from_slice(comm);
    cursor = comm_end;
    let cmdline_end = cursor + cmdline.len();
    buf[cursor..cmdline_end].copy_from_slice(cmdline);
    debug_assert_eq!(cmdline_end, end);
    *off = end;
    Ok(())
}

fn write_u32_at(buf: &mut [u8], offset: usize, value: u32) {
    buf[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_u64_at(buf: &mut [u8], offset: usize, value: u64) {
    buf[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> ProcessSnapshotHeader {
        ProcessSnapshotHeader {
            pid: 1,
            ppid: 2,
            uid: 3,
            gid: 4,
            vsize: 5,
            state: b'R' as u32,
            comm_len: 6,
            cmdline_len: 7,
        }
    }

    fn record_header(comm: &[u8], cmdline: &[u8]) -> ProcessSnapshotHeader {
        ProcessSnapshotHeader {
            comm_len: u32::try_from(comm.len()).unwrap(),
            cmdline_len: u32::try_from(cmdline.len()).unwrap(),
            ..header()
        }
    }

    #[test]
    fn header_fits_its_exact_declared_capacity() {
        let mut bytes = [0xa5; wire::HEADER_BYTES];
        let mut offset = 0;

        assert_eq!(
            write_process_snapshot_header(&mut bytes, &mut offset, &header()),
            Ok(())
        );
        assert_eq!(offset, wire::HEADER_BYTES);
        assert_eq!(wire::HEADER_BYTES, 36);
        let view = &bytes[..];
        assert_eq!(
            u32::from_le_bytes(
                view[wire::PID_OFFSET..wire::PID_OFFSET + 4]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        assert_eq!(
            u64::from_le_bytes(
                view[wire::VSIZE_OFFSET..wire::VSIZE_OFFSET + 8]
                    .try_into()
                    .unwrap()
            ),
            5
        );
        assert_eq!(
            u32::from_le_bytes(
                view[wire::CMDLINE_LEN_OFFSET..wire::CMDLINE_LEN_OFFSET + 4]
                    .try_into()
                    .unwrap()
            ),
            7
        );
    }

    #[test]
    fn header_rejects_one_short_without_mutation() {
        let mut bytes = [0xa5; wire::HEADER_BYTES - 1];
        let before = bytes;
        let mut offset = 0;

        assert_eq!(
            write_process_snapshot_header(&mut bytes, &mut offset, &header()),
            Err(Errno::ENOSPC)
        );
        assert_eq!(offset, 0);
        assert_eq!(bytes, before);
    }

    #[test]
    fn complete_record_fits_exact_capacity() {
        let comm = b"demo";
        let cmdline = b"demo\0--safe\0";
        let required = process_snapshot_record_bytes(comm.len(), cmdline.len()).unwrap();
        let mut bytes = vec![0xa5; required];
        let mut offset = 0;

        assert_eq!(
            write_process_snapshot_record(
                &mut bytes,
                &mut offset,
                &record_header(comm, cmdline),
                comm,
                cmdline,
            ),
            Ok(())
        );
        assert_eq!(offset, required);
        assert_eq!(
            &bytes[wire::HEADER_BYTES..wire::HEADER_BYTES + comm.len()],
            comm
        );
        assert_eq!(&bytes[wire::HEADER_BYTES + comm.len()..], cmdline);
    }

    #[test]
    fn complete_record_rejects_one_short_without_mutation() {
        let comm = b"demo";
        let cmdline = b"demo\0--safe\0";
        let required = process_snapshot_record_bytes(comm.len(), cmdline.len()).unwrap();
        let mut bytes = vec![0xa5; required - 1];
        let before = bytes.clone();
        let mut offset = 0;

        assert_eq!(
            write_process_snapshot_record(
                &mut bytes,
                &mut offset,
                &record_header(comm, cmdline),
                comm,
                cmdline,
            ),
            Err(Errno::ENOSPC)
        );
        assert_eq!(offset, 0);
        assert_eq!(bytes, before);
    }
}
