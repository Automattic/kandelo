//! Target-process wire layouts for System V IPC structures.
//!
//! A kernel Wasm instance can serve both wasm32 and wasm64 processes, so these
//! layouts must be selected from the calling process data model rather than
//! from the kernel crate's own pointer width.

use crate::ipc::{MsgQueueInfo, SemSetInfo, ShmSegInfo};
use core::mem::size_of;
use wasm_posix_shared::WasmSysvMessageHeader;
use wasm_posix_shared::Errno;

#[derive(Clone, Copy)]
struct SemidDsLayout {
    size: usize,
    otime_offset: usize,
    ctime_offset: usize,
    nsems_offset: usize,
}

#[derive(Clone, Copy)]
struct MsqidDsLayout {
    size: usize,
    stime_offset: usize,
    rtime_offset: usize,
    ctime_offset: usize,
    cbytes_offset: usize,
    qnum_offset: usize,
    qbytes_offset: usize,
    lspid_offset: usize,
    lrpid_offset: usize,
    ulong_bytes: usize,
}

#[derive(Clone, Copy)]
struct ShmidDsLayout {
    size: usize,
    segsz_offset: usize,
    atime_offset: usize,
    dtime_offset: usize,
    ctime_offset: usize,
    cpid_offset: usize,
    lpid_offset: usize,
    nattch_offset: usize,
    ulong_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MsgctlSetFields {
    pub uid: u32,
    pub gid: u32,
    pub mode: u32,
    pub qbytes: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ShmctlSetFields {
    pub uid: u32,
    pub gid: u32,
    pub mode: u32,
}

const SEMID_DS_WASM32_LAYOUT: SemidDsLayout = SemidDsLayout {
    size: 72,
    otime_offset: 40,
    ctime_offset: 48,
    nsems_offset: 56,
};

const SEMID_DS_WASM64_LAYOUT: SemidDsLayout = SemidDsLayout {
    size: 88,
    otime_offset: 48,
    ctime_offset: 56,
    nsems_offset: 64,
};

const MSQID_DS_WASM32_LAYOUT: MsqidDsLayout = MsqidDsLayout {
    size: 96,
    stime_offset: 40,
    rtime_offset: 48,
    ctime_offset: 56,
    cbytes_offset: 64,
    qnum_offset: 68,
    qbytes_offset: 72,
    lspid_offset: 76,
    lrpid_offset: 80,
    ulong_bytes: 4,
};

const MSQID_DS_WASM64_LAYOUT: MsqidDsLayout = MsqidDsLayout {
    size: 120,
    stime_offset: 48,
    rtime_offset: 56,
    ctime_offset: 64,
    cbytes_offset: 72,
    qnum_offset: 80,
    qbytes_offset: 88,
    lspid_offset: 96,
    lrpid_offset: 100,
    ulong_bytes: 8,
};

const SHMID_DS_WASM32_LAYOUT: ShmidDsLayout = ShmidDsLayout {
    size: 88,
    segsz_offset: 36,
    atime_offset: 40,
    dtime_offset: 48,
    ctime_offset: 56,
    cpid_offset: 64,
    lpid_offset: 68,
    nattch_offset: 72,
    ulong_bytes: 4,
};

const SHMID_DS_WASM64_LAYOUT: ShmidDsLayout = ShmidDsLayout {
    size: 112,
    segsz_offset: 48,
    atime_offset: 56,
    dtime_offset: 64,
    ctime_offset: 72,
    cpid_offset: 80,
    lpid_offset: 84,
    nattch_offset: 88,
    ulong_bytes: 8,
};

const _: () = {
    assert!(SEMID_DS_WASM32_LAYOUT.nsems_offset + 2 <= SEMID_DS_WASM32_LAYOUT.size);
    assert!(SEMID_DS_WASM64_LAYOUT.nsems_offset + 2 <= SEMID_DS_WASM64_LAYOUT.size);
    assert!(MSQID_DS_WASM32_LAYOUT.lrpid_offset + 4 <= MSQID_DS_WASM32_LAYOUT.size);
    assert!(MSQID_DS_WASM64_LAYOUT.lrpid_offset + 4 <= MSQID_DS_WASM64_LAYOUT.size);
    assert!(
        SHMID_DS_WASM32_LAYOUT.nattch_offset + SHMID_DS_WASM32_LAYOUT.ulong_bytes
            <= SHMID_DS_WASM32_LAYOUT.size
    );
    assert!(
        SHMID_DS_WASM64_LAYOUT.nattch_offset + SHMID_DS_WASM64_LAYOUT.ulong_bytes
            <= SHMID_DS_WASM64_LAYOUT.size
    );
};

fn semid_ds_layout(pointer_width: u32) -> Result<SemidDsLayout, Errno> {
    match pointer_width {
        4 => Ok(SEMID_DS_WASM32_LAYOUT),
        8 => Ok(SEMID_DS_WASM64_LAYOUT),
        _ => Err(Errno::EINVAL),
    }
}

fn msqid_ds_layout(pointer_width: u32) -> Result<MsqidDsLayout, Errno> {
    match pointer_width {
        4 => Ok(MSQID_DS_WASM32_LAYOUT),
        8 => Ok(MSQID_DS_WASM64_LAYOUT),
        _ => Err(Errno::EINVAL),
    }
}

fn shmid_ds_layout(pointer_width: u32) -> Result<ShmidDsLayout, Errno> {
    match pointer_width {
        4 => Ok(SHMID_DS_WASM32_LAYOUT),
        8 => Ok(SHMID_DS_WASM64_LAYOUT),
        _ => Err(Errno::EINVAL),
    }
}

/// Byte size of the target musl `struct semid_ds`.
pub(crate) fn semid_ds_size(pointer_width: u32) -> Result<usize, Errno> {
    Ok(semid_ds_layout(pointer_width)?.size)
}

/// Byte size of the target musl `struct msqid_ds`.
pub(crate) fn msqid_ds_size(pointer_width: u32) -> Result<usize, Errno> {
    Ok(msqid_ds_layout(pointer_width)?.size)
}

/// Byte size of the target musl `struct shmid_ds`.
pub(crate) fn shmid_ds_size(pointer_width: u32) -> Result<usize, Errno> {
    Ok(shmid_ds_layout(pointer_width)?.size)
}

/// Size of the width-independent header used for message data in kernel
/// scratch. The host translates the caller's native `long` to this i64.
pub(crate) const SYSV_MESSAGE_HEADER_SIZE: usize =
    size_of::<WasmSysvMessageHeader>();

pub(crate) fn sysv_message_wire_size(text_bytes: usize) -> Result<usize, Errno> {
    SYSV_MESSAGE_HEADER_SIZE
        .checked_add(text_bytes)
        .ok_or(Errno::EINVAL)
}

pub(crate) fn read_sysv_message_type(input: &[u8]) -> Result<i64, Errno> {
    let bytes = input
        .get(..SYSV_MESSAGE_HEADER_SIZE)
        .ok_or(Errno::EFAULT)?;
    Ok(i64::from_le_bytes(
        bytes.try_into().map_err(|_| Errno::EFAULT)?,
    ))
}

pub(crate) fn write_sysv_message(
    out: &mut [u8],
    mtype: i64,
    text: &[u8],
) -> Result<usize, Errno> {
    let total = sysv_message_wire_size(text.len())?;
    let out = out.get_mut(..total).ok_or(Errno::EFAULT)?;
    out[..SYSV_MESSAGE_HEADER_SIZE].copy_from_slice(&mtype.to_le_bytes());
    out[SYSV_MESSAGE_HEADER_SIZE..].copy_from_slice(text);
    Ok(total)
}

/// Read the fields Linux permits msgctl IPC_SET to replace.
pub(crate) fn read_msqid_ds_set_fields(
    input: &[u8],
    pointer_width: u32,
) -> Result<MsgctlSetFields, Errno> {
    let layout = msqid_ds_layout(pointer_width)?;
    if input.len() < layout.size {
        return Err(Errno::EFAULT);
    }
    let qbytes = read_ulong(input, layout.qbytes_offset, layout.ulong_bytes)?;
    Ok(MsgctlSetFields {
        uid: read_u32(input, 4)?,
        gid: read_u32(input, 8)?,
        mode: read_u32(input, 20)?,
        qbytes: u32::try_from(qbytes).map_err(|_| Errno::EOVERFLOW)?,
    })
}

/// Read the fields Linux permits shmctl IPC_SET to replace.
pub(crate) fn read_shmid_ds_set_fields(
    input: &[u8],
    pointer_width: u32,
) -> Result<ShmctlSetFields, Errno> {
    let layout = shmid_ds_layout(pointer_width)?;
    if input.len() < layout.size {
        return Err(Errno::EFAULT);
    }
    Ok(ShmctlSetFields {
        uid: read_u32(input, 4)?,
        gid: read_u32(input, 8)?,
        mode: read_u32(input, 20)?,
    })
}

/// Serialize one `struct semid_ds` for the target process data model.
///
/// Only the layout-sized prefix is replaced. The caller may pass a larger
/// kernel-owned region without risking writes into the following transfer.
pub(crate) fn write_semid_ds(
    out: &mut [u8],
    info: &SemSetInfo,
    pointer_width: u32,
) -> Result<usize, Errno> {
    let layout = semid_ds_layout(pointer_width)?;
    if out.len() < layout.size {
        return Err(Errno::EFAULT);
    }
    let nsems = u16::try_from(info.nsems).map_err(|_| Errno::EOVERFLOW)?;
    let out = &mut out[..layout.size];
    out.fill(0);

    write_ipc_perm(
        out, info.key, info.uid, info.gid, info.cuid, info.cgid, info.mode, info.seq,
    );

    // WHY: musl's wasm32 time64 layout follows the 36-byte ipc_perm with
    // four bytes of padding, while wasm64's LP64 ipc_perm ends at offset 48.
    write_i64(out, layout.otime_offset, info.otime);
    write_i64(out, layout.ctime_offset, info.ctime);
    out[layout.nsems_offset..layout.nsems_offset + 2]
        .copy_from_slice(&nsems.to_le_bytes());
    Ok(layout.size)
}

/// Serialize one `struct msqid_ds` for the target process data model.
pub(crate) fn write_msqid_ds(
    out: &mut [u8],
    info: &MsgQueueInfo,
    pointer_width: u32,
) -> Result<usize, Errno> {
    let layout = msqid_ds_layout(pointer_width)?;
    if out.len() < layout.size {
        return Err(Errno::EFAULT);
    }
    let out = &mut out[..layout.size];
    out.fill(0);

    write_ipc_perm(
        out, info.key, info.uid, info.gid, info.cuid, info.cgid, info.mode, info.seq,
    );
    write_i64(out, layout.stime_offset, info.stime);
    write_i64(out, layout.rtime_offset, info.rtime);
    write_i64(out, layout.ctime_offset, info.ctime);
    write_ulong(out, layout.cbytes_offset, info.cbytes, layout.ulong_bytes);
    write_ulong(out, layout.qnum_offset, info.qnum, layout.ulong_bytes);
    write_ulong(out, layout.qbytes_offset, info.qbytes, layout.ulong_bytes);
    write_i32(out, layout.lspid_offset, info.lspid);
    write_i32(out, layout.lrpid_offset, info.lrpid);
    Ok(layout.size)
}

/// Serialize one `struct shmid_ds` for the target process data model.
pub(crate) fn write_shmid_ds(
    out: &mut [u8],
    info: &ShmSegInfo,
    pointer_width: u32,
) -> Result<usize, Errno> {
    let layout = shmid_ds_layout(pointer_width)?;
    if out.len() < layout.size {
        return Err(Errno::EFAULT);
    }
    let out = &mut out[..layout.size];
    out.fill(0);

    write_ipc_perm(
        out, info.key, info.uid, info.gid, info.cuid, info.cgid, info.mode, info.seq,
    );
    write_ulong(out, layout.segsz_offset, info.segsz, layout.ulong_bytes);
    write_i64(out, layout.atime_offset, info.atime);
    write_i64(out, layout.dtime_offset, info.dtime);
    write_i64(out, layout.ctime_offset, info.ctime);
    write_i32(out, layout.cpid_offset, info.cpid);
    write_i32(out, layout.lpid_offset, info.lpid);
    write_ulong(out, layout.nattch_offset, info.nattch, layout.ulong_bytes);
    Ok(layout.size)
}

#[allow(clippy::too_many_arguments)]
fn write_ipc_perm(
    out: &mut [u8],
    key: i32,
    uid: u32,
    gid: u32,
    cuid: u32,
    cgid: u32,
    mode: u32,
    seq: i32,
) {
    write_i32(out, 0, key);
    write_u32(out, 4, uid);
    write_u32(out, 8, gid);
    write_u32(out, 12, cuid);
    write_u32(out, 16, cgid);
    write_u32(out, 20, mode);
    write_i32(out, 24, seq);
}

fn write_u32(out: &mut [u8], offset: usize, value: u32) {
    out[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_i32(out: &mut [u8], offset: usize, value: i32) {
    out[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_i64(out: &mut [u8], offset: usize, value: i64) {
    out[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn write_ulong(out: &mut [u8], offset: usize, value: u32, width: usize) {
    match width {
        4 => write_u32(out, offset, value),
        8 => out[offset..offset + 8].copy_from_slice(&(value as u64).to_le_bytes()),
        _ => unreachable!("validated System V IPC unsigned-long width"),
    }
}

fn read_u32(input: &[u8], offset: usize) -> Result<u32, Errno> {
    let bytes = input.get(offset..offset + 4).ok_or(Errno::EFAULT)?;
    Ok(u32::from_le_bytes(
        bytes.try_into().map_err(|_| Errno::EFAULT)?,
    ))
}

fn read_u64(input: &[u8], offset: usize) -> Result<u64, Errno> {
    let bytes = input.get(offset..offset + 8).ok_or(Errno::EFAULT)?;
    Ok(u64::from_le_bytes(
        bytes.try_into().map_err(|_| Errno::EFAULT)?,
    ))
}

fn read_ulong(input: &[u8], offset: usize, width: usize) -> Result<u64, Errno> {
    match width {
        4 => Ok(read_u32(input, offset)? as u64),
        8 => read_u64(input, offset),
        _ => Err(Errno::EINVAL),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn sample_info() -> SemSetInfo {
        SemSetInfo {
            key: 0x1234_5678,
            uid: 0x0102_0304,
            gid: 0x1112_1314,
            cuid: 0x2122_2324,
            cgid: 0x3132_3334,
            mode: 0x4142_4344,
            seq: 0x5152_5354,
            nsems: 0x6162,
            otime: 0x0102_0304_0506_0708,
            ctime: 0x1112_1314_1516_1718,
        }
    }

    fn sample_msg_info() -> MsgQueueInfo {
        MsgQueueInfo {
            key: 0x1234_5678,
            uid: 0x0102_0304,
            gid: 0x1112_1314,
            cuid: 0x2122_2324,
            cgid: 0x3132_3334,
            mode: 0x4142_4344,
            seq: 0x5152_5354,
            stime: 0x0102_0304_0506_0708,
            rtime: 0x1112_1314_1516_1718,
            ctime: 0x2122_2324_2526_2728,
            cbytes: 0x6162_6364,
            qnum: 0x7172_7374,
            qbytes: 0x0103_0507,
            lspid: 0x1122_3344,
            lrpid: 0x5566_7788,
        }
    }

    fn sample_shm_info() -> ShmSegInfo {
        ShmSegInfo {
            key: 0x1234_5678,
            uid: 0x0102_0304,
            gid: 0x1112_1314,
            cuid: 0x2122_2324,
            cgid: 0x3132_3334,
            mode: 0x4142_4344,
            seq: 0x5152_5354,
            segsz: 0x6162_6364,
            cpid: 0x1122_3344,
            lpid: 0x5566_7788,
            nattch: 0x7172_7374,
            atime: 0x0102_0304_0506_0708,
            dtime: 0x1112_1314_1516_1718,
            ctime: 0x2122_2324_2526_2728,
        }
    }

    fn assert_sample_ipc_perm(out: &[u8]) {
        assert_eq!(&out[0..4], &0x1234_5678i32.to_le_bytes());
        assert_eq!(&out[4..8], &0x0102_0304u32.to_le_bytes());
        assert_eq!(&out[8..12], &0x1112_1314u32.to_le_bytes());
        assert_eq!(&out[12..16], &0x2122_2324u32.to_le_bytes());
        assert_eq!(&out[16..20], &0x3132_3334u32.to_le_bytes());
        assert_eq!(&out[20..24], &0x4142_4344u32.to_le_bytes());
        assert_eq!(&out[24..28], &0x5152_5354i32.to_le_bytes());
    }

    #[test]
    fn sysv_ipc_sizes_follow_the_process_pointer_width() {
        assert_eq!(semid_ds_size(4), Ok(72));
        assert_eq!(semid_ds_size(8), Ok(88));
        assert_eq!(semid_ds_size(0), Err(Errno::EINVAL));
        assert_eq!(semid_ds_size(16), Err(Errno::EINVAL));
        assert_eq!(msqid_ds_size(4), Ok(96));
        assert_eq!(msqid_ds_size(8), Ok(120));
        assert_eq!(msqid_ds_size(16), Err(Errno::EINVAL));
        assert_eq!(shmid_ds_size(4), Ok(88));
        assert_eq!(shmid_ds_size(8), Ok(112));
        assert_eq!(shmid_ds_size(16), Err(Errno::EINVAL));
    }

    #[test]
    fn canonical_message_wire_preserves_i64_type_and_exact_capacity() {
        let mtype = 0x0102_0304_0506_0708i64;
        let mut out = vec![0xa5; SYSV_MESSAGE_HEADER_SIZE + 4];
        assert_eq!(
            write_sysv_message(&mut out, mtype, b"abc"),
            Ok(SYSV_MESSAGE_HEADER_SIZE + 3)
        );
        assert_eq!(read_sysv_message_type(&out), Ok(mtype));
        assert_eq!(
            &out[SYSV_MESSAGE_HEADER_SIZE..SYSV_MESSAGE_HEADER_SIZE + 3],
            b"abc"
        );
        assert_eq!(out[SYSV_MESSAGE_HEADER_SIZE + 3], 0xa5);
    }

    #[test]
    fn canonical_message_wire_rejects_capacity_minus_one_without_writing() {
        let mut out = vec![0xa5; SYSV_MESSAGE_HEADER_SIZE + 2];
        assert_eq!(
            write_sysv_message(&mut out, 7, b"abc"),
            Err(Errno::EFAULT)
        );
        assert!(out.iter().all(|byte| *byte == 0xa5));
        assert_eq!(
            read_sysv_message_type(&out[..SYSV_MESSAGE_HEADER_SIZE - 1]),
            Err(Errno::EFAULT)
        );
    }

    #[test]
    fn wasm32_semid_ds_uses_time64_ilp32_offsets_without_overwrite() {
        let mut out = vec![0xa5; 73];
        assert_eq!(write_semid_ds(&mut out, &sample_info(), 4), Ok(72));

        assert_sample_ipc_perm(&out);
        assert_eq!(&out[40..48], &0x0102_0304_0506_0708i64.to_le_bytes());
        assert_eq!(&out[48..56], &0x1112_1314_1516_1718i64.to_le_bytes());
        assert_eq!(&out[56..58], &0x6162u16.to_le_bytes());
        assert_eq!(out[71], 0);
        assert_eq!(out[72], 0xa5);
    }

    #[test]
    fn wasm64_semid_ds_uses_lp64_offsets_without_overwrite() {
        let mut out = vec![0xa5; 89];
        assert_eq!(write_semid_ds(&mut out, &sample_info(), 8), Ok(88));

        assert_sample_ipc_perm(&out);
        assert_eq!(&out[48..56], &0x0102_0304_0506_0708i64.to_le_bytes());
        assert_eq!(&out[56..64], &0x1112_1314_1516_1718i64.to_le_bytes());
        assert_eq!(&out[64..66], &0x6162u16.to_le_bytes());
        assert_eq!(out[87], 0);
        assert_eq!(out[88], 0xa5);
    }

    #[test]
    fn semid_ds_rejects_short_output_and_invalid_width_without_partial_write() {
        let mut short = vec![0xa5; 71];
        assert_eq!(
            write_semid_ds(&mut short, &sample_info(), 4),
            Err(Errno::EFAULT)
        );
        assert!(short.iter().all(|byte| *byte == 0xa5));

        let mut invalid = vec![0xa5; 88];
        assert_eq!(
            write_semid_ds(&mut invalid, &sample_info(), 16),
            Err(Errno::EINVAL)
        );
        assert!(invalid.iter().all(|byte| *byte == 0xa5));
    }

    #[test]
    fn semid_ds_rejects_unrepresentable_nsems_without_partial_write() {
        let mut info = sample_info();
        info.nsems = u16::MAX as u32 + 1;
        let mut out = vec![0xa5; 72];
        assert_eq!(
            write_semid_ds(&mut out, &info, 4),
            Err(Errno::EOVERFLOW)
        );
        assert!(out.iter().all(|byte| *byte == 0xa5));
    }

    #[test]
    fn msqid_ds_offsets_cover_wasm32_and_wasm64_without_overwrite() {
        let info = sample_msg_info();
        let mut wasm32 = vec![0xa5; 97];
        assert_eq!(write_msqid_ds(&mut wasm32, &info, 4), Ok(96));
        assert_sample_ipc_perm(&wasm32);
        assert_eq!(&wasm32[40..48], &info.stime.to_le_bytes());
        assert_eq!(&wasm32[48..56], &info.rtime.to_le_bytes());
        assert_eq!(&wasm32[56..64], &info.ctime.to_le_bytes());
        assert_eq!(&wasm32[64..68], &info.cbytes.to_le_bytes());
        assert_eq!(&wasm32[68..72], &info.qnum.to_le_bytes());
        assert_eq!(&wasm32[72..76], &info.qbytes.to_le_bytes());
        assert_eq!(&wasm32[76..80], &info.lspid.to_le_bytes());
        assert_eq!(&wasm32[80..84], &info.lrpid.to_le_bytes());
        assert_eq!(wasm32[95], 0);
        assert_eq!(wasm32[96], 0xa5);

        let mut wasm64 = vec![0xa5; 121];
        assert_eq!(write_msqid_ds(&mut wasm64, &info, 8), Ok(120));
        assert_sample_ipc_perm(&wasm64);
        assert_eq!(&wasm64[48..56], &info.stime.to_le_bytes());
        assert_eq!(&wasm64[56..64], &info.rtime.to_le_bytes());
        assert_eq!(&wasm64[64..72], &info.ctime.to_le_bytes());
        assert_eq!(&wasm64[72..80], &(info.cbytes as u64).to_le_bytes());
        assert_eq!(&wasm64[80..88], &(info.qnum as u64).to_le_bytes());
        assert_eq!(&wasm64[88..96], &(info.qbytes as u64).to_le_bytes());
        assert_eq!(&wasm64[96..100], &info.lspid.to_le_bytes());
        assert_eq!(&wasm64[100..104], &info.lrpid.to_le_bytes());
        assert_eq!(wasm64[119], 0);
        assert_eq!(wasm64[120], 0xa5);
    }

    #[test]
    fn shmid_ds_offsets_cover_wasm32_and_wasm64_without_overwrite() {
        let info = sample_shm_info();
        let mut wasm32 = vec![0xa5; 89];
        assert_eq!(write_shmid_ds(&mut wasm32, &info, 4), Ok(88));
        assert_sample_ipc_perm(&wasm32);
        assert_eq!(&wasm32[36..40], &info.segsz.to_le_bytes());
        assert_eq!(&wasm32[40..48], &info.atime.to_le_bytes());
        assert_eq!(&wasm32[48..56], &info.dtime.to_le_bytes());
        assert_eq!(&wasm32[56..64], &info.ctime.to_le_bytes());
        assert_eq!(&wasm32[64..68], &info.cpid.to_le_bytes());
        assert_eq!(&wasm32[68..72], &info.lpid.to_le_bytes());
        assert_eq!(&wasm32[72..76], &info.nattch.to_le_bytes());
        assert_eq!(wasm32[87], 0);
        assert_eq!(wasm32[88], 0xa5);

        let mut wasm64 = vec![0xa5; 113];
        assert_eq!(write_shmid_ds(&mut wasm64, &info, 8), Ok(112));
        assert_sample_ipc_perm(&wasm64);
        assert_eq!(&wasm64[48..56], &(info.segsz as u64).to_le_bytes());
        assert_eq!(&wasm64[56..64], &info.atime.to_le_bytes());
        assert_eq!(&wasm64[64..72], &info.dtime.to_le_bytes());
        assert_eq!(&wasm64[72..80], &info.ctime.to_le_bytes());
        assert_eq!(&wasm64[80..84], &info.cpid.to_le_bytes());
        assert_eq!(&wasm64[84..88], &info.lpid.to_le_bytes());
        assert_eq!(&wasm64[88..96], &(info.nattch as u64).to_le_bytes());
        assert_eq!(wasm64[111], 0);
        assert_eq!(wasm64[112], 0xa5);
    }

    #[test]
    fn msqid_and_shmid_serializers_reject_short_outputs_without_partial_write() {
        let mut msg = vec![0xa5; 119];
        assert_eq!(
            write_msqid_ds(&mut msg, &sample_msg_info(), 8),
            Err(Errno::EFAULT)
        );
        assert!(msg.iter().all(|byte| *byte == 0xa5));

        let mut shm = vec![0xa5; 111];
        assert_eq!(
            write_shmid_ds(&mut shm, &sample_shm_info(), 8),
            Err(Errno::EFAULT)
        );
        assert!(shm.iter().all(|byte| *byte == 0xa5));

        let mut invalid_msg = vec![0xa5; 120];
        assert_eq!(
            write_msqid_ds(&mut invalid_msg, &sample_msg_info(), 16),
            Err(Errno::EINVAL)
        );
        assert!(invalid_msg.iter().all(|byte| *byte == 0xa5));

        let mut invalid_shm = vec![0xa5; 112];
        assert_eq!(
            write_shmid_ds(&mut invalid_shm, &sample_shm_info(), 16),
            Err(Errno::EINVAL)
        );
        assert!(invalid_shm.iter().all(|byte| *byte == 0xa5));
    }

    #[test]
    fn ipc_set_parsers_read_only_permitted_fields_at_both_target_widths() {
        let expected_msg = MsgctlSetFields {
            uid: 1001,
            gid: 1002,
            mode: 0o764,
            qbytes: 32_768,
        };
        for (pointer_width, size, qbytes_offset) in
            [(4, 96, 72), (8, 120, 88)]
        {
            let mut input = vec![0xa5; size];
            write_u32(&mut input, 4, expected_msg.uid);
            write_u32(&mut input, 8, expected_msg.gid);
            write_u32(&mut input, 20, expected_msg.mode);
            if pointer_width == 4 {
                write_u32(&mut input, qbytes_offset, expected_msg.qbytes);
            } else {
                write_i64(
                    &mut input,
                    qbytes_offset,
                    expected_msg.qbytes as i64,
                );
            }
            assert_eq!(
                read_msqid_ds_set_fields(&input, pointer_width),
                Ok(expected_msg)
            );
        }

        let expected_shm = ShmctlSetFields {
            uid: 2001,
            gid: 2002,
            mode: 0o640,
        };
        for (pointer_width, size) in [(4, 88), (8, 112)] {
            let mut input = vec![0xa5; size];
            write_u32(&mut input, 4, expected_shm.uid);
            write_u32(&mut input, 8, expected_shm.gid);
            write_u32(&mut input, 20, expected_shm.mode);
            assert_eq!(
                read_shmid_ds_set_fields(&input, pointer_width),
                Ok(expected_shm)
            );
        }
    }

    #[test]
    fn ipc_set_parsers_reject_short_invalid_or_unrepresentable_inputs() {
        assert_eq!(
            read_msqid_ds_set_fields(&vec![0; 95], 4),
            Err(Errno::EFAULT)
        );
        assert_eq!(
            read_shmid_ds_set_fields(&vec![0; 111], 8),
            Err(Errno::EFAULT)
        );
        assert_eq!(
            read_msqid_ds_set_fields(&vec![0; 120], 16),
            Err(Errno::EINVAL)
        );

        let mut oversized_qbytes = vec![0; 120];
        oversized_qbytes[88..96]
            .copy_from_slice(&(u32::MAX as u64 + 1).to_le_bytes());
        assert_eq!(
            read_msqid_ds_set_fields(&oversized_qbytes, 8),
            Err(Errno::EOVERFLOW)
        );
    }
}
