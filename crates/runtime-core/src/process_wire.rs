//! Caller-native syscall structure parsing and serialization.
//!
//! These helpers operate on already capacity-bounded kernel scratch slices.
//! They keep the process data model explicit so a wasm32 kernel cannot
//! accidentally parse a wasm64 caller using its own target layout.

use core::convert::TryFrom;

use wasm_posix_shared::{Errno, WasmStat, WasmStatfs, process_layout};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessDataModel {
    Wasm32,
    Wasm64,
}

impl ProcessDataModel {
    pub fn from_width(width: i64) -> Result<Self, Errno> {
        match width {
            value if value == process_layout::WASM32_POINTER_WIDTH as i64 => Ok(Self::Wasm32),
            value if value == process_layout::WASM64_POINTER_WIDTH as i64 => Ok(Self::Wasm64),
            _ => Err(Errno::EINVAL),
        }
    }

    pub const fn width(self) -> u32 {
        match self {
            Self::Wasm32 => process_layout::WASM32_POINTER_WIDTH,
            Self::Wasm64 => process_layout::WASM64_POINTER_WIDTH,
        }
    }

    pub const fn max_pointer(self) -> u64 {
        match self {
            Self::Wasm32 => u32::MAX as u64,
            Self::Wasm64 => u64::MAX,
        }
    }

    const fn native_long_bytes(self) -> usize {
        self.width() as usize
    }

    pub const fn sigaltstack_size(self) -> usize {
        match self {
            Self::Wasm32 => process_layout::sigaltstack::WASM32_SIZE as usize,
            Self::Wasm64 => process_layout::sigaltstack::WASM64_SIZE as usize,
        }
    }

    pub const fn itimerval_size(self) -> usize {
        match self {
            Self::Wasm32 => process_layout::itimerval::WASM32_SIZE as usize,
            Self::Wasm64 => process_layout::itimerval::WASM64_SIZE as usize,
        }
    }

    pub const fn mq_attr_size(self) -> usize {
        match self {
            Self::Wasm32 => process_layout::mq_attr::WASM32_SIZE as usize,
            Self::Wasm64 => process_layout::mq_attr::WASM64_SIZE as usize,
        }
    }

    pub const fn sigevent_size(self) -> usize {
        match self {
            Self::Wasm32 => process_layout::sigevent::WASM32_SIZE as usize,
            Self::Wasm64 => process_layout::sigevent::WASM64_SIZE as usize,
        }
    }

    pub const fn statfs_size(self) -> usize {
        match self {
            Self::Wasm32 => process_layout::statfs::WASM32_SIZE as usize,
            Self::Wasm64 => process_layout::statfs::WASM64_SIZE as usize,
        }
    }

    pub const fn sysinfo_size(self) -> usize {
        match self {
            Self::Wasm32 => process_layout::sysinfo::WASM32_SIZE as usize,
            Self::Wasm64 => process_layout::sysinfo::WASM64_SIZE as usize,
        }
    }

    pub const fn siginfo_size(self) -> usize {
        match self {
            Self::Wasm32 => process_layout::rt_sigqueueinfo::WASM32_SIZE as usize,
            Self::Wasm64 => process_layout::rt_sigqueueinfo::WASM64_SIZE as usize,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeSigaltstack {
    pub sp: u64,
    pub flags: u32,
    pub size: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeMqAttr {
    pub flags: u32,
    pub maxmsg: u32,
    pub msgsize: u32,
    pub curmsgs: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeSigevent {
    /// Raw caller-native `union sigval` bits, zero-extended for wasm32.
    pub value_bits: u64,
    pub signo: u32,
    pub notify: u32,
    /// `sigev_notify_thread_id` when `notify` is `SIGEV_THREAD_ID`.
    pub thread_id: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeRtSigqueueinfo {
    pub pid: i32,
    pub uid: u32,
    /// Raw caller-native `union sigval` bits, zero-extended for wasm32.
    pub value_bits: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeSiginfo {
    pub signo: i32,
    pub code: i32,
    pub word_1: i32,
    pub word_2_bits: u32,
    /// Raw caller-native `union sigval` bits, zero-extended for wasm32.
    pub value_bits: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SignalDeliveryRecord {
    pub signum: u32,
    pub handler: u32,
    pub flags: u32,
    /// Raw `union sigval` bits. The delivery wire always uses the widest
    /// supported pointer width so wasm64 values are never narrowed.
    pub si_value_bits: u64,
    pub old_mask: u64,
    pub si_code: i32,
    pub siginfo_word_1: i32,
    pub siginfo_word_2: i32,
    pub alt_sp: u64,
    pub alt_size: u64,
}

pub const SIGALTSTACK_SS_DISABLE: u32 = 2;

pub fn validate_sigaltstack_range(
    stack: NativeSigaltstack,
    model: ProcessDataModel,
) -> Result<(), Errno> {
    if stack.flags & SIGALTSTACK_SS_DISABLE != 0 {
        return Ok(());
    }
    let end = stack.sp.checked_add(stack.size).ok_or(Errno::EOVERFLOW)?;
    // WHY: state is stored without narrowing, but libc eventually converts
    // both fields back to the caller's pointer and size types and computes the
    // exclusive stack top. Prove each conversion and the addition now, before
    // any output or process state is replaced.
    if stack.sp > model.max_pointer()
        || stack.size > model.max_pointer()
        || end > model.max_pointer()
    {
        return Err(Errno::EOVERFLOW);
    }
    Ok(())
}

pub fn validate_signal_delivery_output(
    out_ptr: *mut u8,
    out_capacity: u32,
) -> Result<(), Errno> {
    if out_ptr.is_null() {
        return Err(Errno::EFAULT);
    }
    if out_capacity != wasm_posix_shared::kernel_scratch_wire::SIGNAL_DELIVERY_BYTES {
        return Err(Errno::EINVAL);
    }
    Ok(())
}

pub fn encode_signal_delivery_record(
    record: SignalDeliveryRecord,
) -> [u8; wasm_posix_shared::kernel_scratch_wire::SIGNAL_DELIVERY_BYTES as usize] {
    use wasm_posix_shared::kernel_scratch_wire as wire;

    fn write_field<const N: usize>(buf: &mut [u8], offset: usize, bytes: [u8; N]) {
        buf[offset..offset + N].copy_from_slice(&bytes);
    }

    let mut buf = [0; wire::SIGNAL_DELIVERY_BYTES as usize];
    write_field(&mut buf, wire::SIGNAL_SIGNUM_OFFSET, record.signum.to_le_bytes());
    write_field(&mut buf, wire::SIGNAL_HANDLER_OFFSET, record.handler.to_le_bytes());
    write_field(&mut buf, wire::SIGNAL_FLAGS_OFFSET, record.flags.to_le_bytes());
    write_field(
        &mut buf,
        wire::SIGNAL_SI_VALUE_OFFSET,
        record.si_value_bits.to_le_bytes(),
    );
    write_field(&mut buf, wire::SIGNAL_OLD_MASK_OFFSET, record.old_mask.to_le_bytes());
    write_field(&mut buf, wire::SIGNAL_SI_CODE_OFFSET, record.si_code.to_le_bytes());
    write_field(
        &mut buf,
        wire::SIGNAL_SIGINFO_WORD_1_OFFSET,
        record.siginfo_word_1.to_le_bytes(),
    );
    write_field(
        &mut buf,
        wire::SIGNAL_SIGINFO_WORD_2_OFFSET,
        record.siginfo_word_2.to_le_bytes(),
    );
    write_field(&mut buf, wire::SIGNAL_ALT_SP_OFFSET, record.alt_sp.to_le_bytes());
    write_field(
        &mut buf,
        wire::SIGNAL_ALT_SIZE_OFFSET,
        record.alt_size.to_le_bytes(),
    );
    buf
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct NativeSchedParam {
    pub priority: i32,
    pub ss_max_repl: i32,
    pub ss_repl_period_sec: i64,
    pub ss_repl_period_nsec: i64,
    pub ss_init_budget_sec: i64,
    pub ss_init_budget_nsec: i64,
    pub ss_low_priority: i32,
}

fn require_len(bytes: &[u8], expected: usize) -> Result<(), Errno> {
    if bytes.len() == expected {
        Ok(())
    } else {
        Err(Errno::EINVAL)
    }
}

fn require_len_mut(bytes: &mut [u8], expected: usize) -> Result<(), Errno> {
    if bytes.len() == expected {
        Ok(())
    } else {
        Err(Errno::EINVAL)
    }
}

fn read_i32(bytes: &[u8], offset: usize) -> Result<i32, Errno> {
    let field = bytes.get(offset..offset + 4).ok_or(Errno::EINVAL)?;
    Ok(i32::from_le_bytes(
        field.try_into().map_err(|_| Errno::EINVAL)?,
    ))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, Errno> {
    let field = bytes.get(offset..offset + 4).ok_or(Errno::EINVAL)?;
    Ok(u32::from_le_bytes(
        field.try_into().map_err(|_| Errno::EINVAL)?,
    ))
}

fn read_i64(bytes: &[u8], offset: usize) -> Result<i64, Errno> {
    let field = bytes.get(offset..offset + 8).ok_or(Errno::EINVAL)?;
    Ok(i64::from_le_bytes(
        field.try_into().map_err(|_| Errno::EINVAL)?,
    ))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, Errno> {
    let field = bytes.get(offset..offset + 8).ok_or(Errno::EINVAL)?;
    Ok(u64::from_le_bytes(
        field.try_into().map_err(|_| Errno::EINVAL)?,
    ))
}

fn write_i32(bytes: &mut [u8], offset: usize, value: i32) -> Result<(), Errno> {
    let field = bytes.get_mut(offset..offset + 4).ok_or(Errno::EINVAL)?;
    field.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn write_u16(bytes: &mut [u8], offset: usize, value: u16) -> Result<(), Errno> {
    let field = bytes.get_mut(offset..offset + 2).ok_or(Errno::EINVAL)?;
    field.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn write_u32(bytes: &mut [u8], offset: usize, value: u32) -> Result<(), Errno> {
    let field = bytes.get_mut(offset..offset + 4).ok_or(Errno::EINVAL)?;
    field.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn write_i64(bytes: &mut [u8], offset: usize, value: i64) -> Result<(), Errno> {
    let field = bytes.get_mut(offset..offset + 8).ok_or(Errno::EINVAL)?;
    field.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn write_u64(bytes: &mut [u8], offset: usize, value: u64) -> Result<(), Errno> {
    let field = bytes.get_mut(offset..offset + 8).ok_or(Errno::EINVAL)?;
    field.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn read_native_long(bytes: &[u8], offset: usize, model: ProcessDataModel) -> Result<i64, Errno> {
    match model {
        ProcessDataModel::Wasm32 => Ok(read_i32(bytes, offset)? as i64),
        ProcessDataModel::Wasm64 => read_i64(bytes, offset),
    }
}

fn write_native_long(
    bytes: &mut [u8],
    offset: usize,
    value: i64,
    model: ProcessDataModel,
) -> Result<(), Errno> {
    match model {
        ProcessDataModel::Wasm32 => {
            let narrowed = i32::try_from(value).map_err(|_| Errno::EOVERFLOW)?;
            write_i32(bytes, offset, narrowed)
        }
        ProcessDataModel::Wasm64 => write_i64(bytes, offset, value),
    }
}

fn write_native_ulong(
    bytes: &mut [u8],
    offset: usize,
    value: u64,
    model: ProcessDataModel,
) -> Result<(), Errno> {
    match model {
        ProcessDataModel::Wasm32 => {
            let narrowed = u32::try_from(value).map_err(|_| Errno::EOVERFLOW)?;
            write_u32(bytes, offset, narrowed)
        }
        ProcessDataModel::Wasm64 => write_u64(bytes, offset, value),
    }
}

fn read_native_sigval(
    bytes: &[u8],
    offset: usize,
    model: ProcessDataModel,
) -> Result<u64, Errno> {
    match model {
        ProcessDataModel::Wasm32 => Ok(read_u32(bytes, offset)? as u64),
        ProcessDataModel::Wasm64 => read_u64(bytes, offset),
    }
}

fn write_native_sigval(
    bytes: &mut [u8],
    offset: usize,
    value_bits: u64,
    model: ProcessDataModel,
) -> Result<(), Errno> {
    match model {
        // A mixed-data-model kernel can deliver a wasm64 sender's sigval to a
        // wasm32 recipient. The recipient's native union is four bytes, so
        // Linux-compatible target-native semantics expose the low 32 bits.
        ProcessDataModel::Wasm32 => write_u32(bytes, offset, value_bits as u32),
        ProcessDataModel::Wasm64 => write_u64(bytes, offset, value_bits),
    }
}

pub fn read_sigaltstack(
    bytes: &[u8],
    model: ProcessDataModel,
) -> Result<NativeSigaltstack, Errno> {
    require_len(bytes, model.sigaltstack_size())?;
    let (flags_offset, size_offset) = match model {
        ProcessDataModel::Wasm32 => (
            process_layout::sigaltstack::WASM32_FLAGS_OFFSET as usize,
            process_layout::sigaltstack::WASM32_STACK_SIZE_OFFSET as usize,
        ),
        ProcessDataModel::Wasm64 => (
            process_layout::sigaltstack::WASM64_FLAGS_OFFSET as usize,
            process_layout::sigaltstack::WASM64_STACK_SIZE_OFFSET as usize,
        ),
    };
    let (sp, size) = match model {
        ProcessDataModel::Wasm32 => (
            read_u32(
                bytes,
                process_layout::sigaltstack::WASM32_SP_OFFSET as usize,
            )? as u64,
            read_u32(bytes, size_offset)? as u64,
        ),
        ProcessDataModel::Wasm64 => (
            read_u64(
                bytes,
                process_layout::sigaltstack::WASM64_SP_OFFSET as usize,
            )?,
            read_u64(bytes, size_offset)?,
        ),
    };
    Ok(NativeSigaltstack {
        sp,
        flags: read_u32(bytes, flags_offset)?,
        size,
    })
}

pub fn write_sigaltstack(
    bytes: &mut [u8],
    stack: NativeSigaltstack,
    model: ProcessDataModel,
) -> Result<(), Errno> {
    require_len_mut(bytes, model.sigaltstack_size())?;
    bytes.fill(0);
    match model {
        ProcessDataModel::Wasm32 => {
            write_u32(
                bytes,
                process_layout::sigaltstack::WASM32_SP_OFFSET as usize,
                u32::try_from(stack.sp).map_err(|_| Errno::EOVERFLOW)?,
            )?;
            write_u32(
                bytes,
                process_layout::sigaltstack::WASM32_FLAGS_OFFSET as usize,
                stack.flags,
            )?;
            write_u32(
                bytes,
                process_layout::sigaltstack::WASM32_STACK_SIZE_OFFSET as usize,
                u32::try_from(stack.size).map_err(|_| Errno::EOVERFLOW)?,
            )
        }
        ProcessDataModel::Wasm64 => {
            write_u64(
                bytes,
                process_layout::sigaltstack::WASM64_SP_OFFSET as usize,
                stack.sp,
            )?;
            write_u32(
                bytes,
                process_layout::sigaltstack::WASM64_FLAGS_OFFSET as usize,
                stack.flags,
            )?;
            write_u64(
                bytes,
                process_layout::sigaltstack::WASM64_STACK_SIZE_OFFSET as usize,
                stack.size,
            )
        }
    }
}

pub fn read_itimerval(bytes: &[u8], model: ProcessDataModel) -> Result<[i64; 4], Errno> {
    require_len(bytes, model.itimerval_size())?;
    let stride = model.native_long_bytes();
    Ok([
        read_native_long(bytes, 0, model)?,
        read_native_long(bytes, stride, model)?,
        read_native_long(bytes, stride * 2, model)?,
        read_native_long(bytes, stride * 3, model)?,
    ])
}

pub fn write_itimerval(
    bytes: &mut [u8],
    values: [i64; 4],
    model: ProcessDataModel,
) -> Result<(), Errno> {
    require_len_mut(bytes, model.itimerval_size())?;
    bytes.fill(0);
    let stride = model.native_long_bytes();
    for (index, value) in values.into_iter().enumerate() {
        write_native_long(bytes, index * stride, value, model)?;
    }
    Ok(())
}

fn nonnegative_u32(value: i64) -> Result<u32, Errno> {
    u32::try_from(value).map_err(|_| Errno::EINVAL)
}

pub fn read_mq_attr(bytes: &[u8], model: ProcessDataModel) -> Result<NativeMqAttr, Errno> {
    require_len(bytes, model.mq_attr_size())?;
    let stride = model.native_long_bytes();
    Ok(NativeMqAttr {
        flags: nonnegative_u32(read_native_long(bytes, 0, model)?)?,
        maxmsg: nonnegative_u32(read_native_long(bytes, stride, model)?)?,
        msgsize: nonnegative_u32(read_native_long(bytes, stride * 2, model)?)?,
        curmsgs: nonnegative_u32(read_native_long(bytes, stride * 3, model)?)?,
    })
}

pub fn write_mq_attr(
    bytes: &mut [u8],
    attr: NativeMqAttr,
    model: ProcessDataModel,
) -> Result<(), Errno> {
    require_len_mut(bytes, model.mq_attr_size())?;
    bytes.fill(0);
    let stride = model.native_long_bytes();
    for (index, value) in [attr.flags, attr.maxmsg, attr.msgsize, attr.curmsgs]
        .into_iter()
        .enumerate()
    {
        write_native_long(bytes, index * stride, value as i64, model)?;
    }
    Ok(())
}

pub fn read_sigevent(
    bytes: &[u8],
    model: ProcessDataModel,
) -> Result<NativeSigevent, Errno> {
    require_len(bytes, model.sigevent_size())?;
    let (value_offset, signo_offset, notify_offset, payload_offset) = match model {
        ProcessDataModel::Wasm32 => (
            process_layout::sigevent::WASM32_VALUE_OFFSET as usize,
            process_layout::sigevent::WASM32_SIGNO_OFFSET as usize,
            process_layout::sigevent::WASM32_NOTIFY_OFFSET as usize,
            process_layout::sigevent::WASM32_PAYLOAD_OFFSET as usize,
        ),
        ProcessDataModel::Wasm64 => (
            process_layout::sigevent::WASM64_VALUE_OFFSET as usize,
            process_layout::sigevent::WASM64_SIGNO_OFFSET as usize,
            process_layout::sigevent::WASM64_NOTIFY_OFFSET as usize,
            process_layout::sigevent::WASM64_PAYLOAD_OFFSET as usize,
        ),
    };
    Ok(NativeSigevent {
        value_bits: read_native_sigval(bytes, value_offset, model)?,
        signo: read_i32(bytes, signo_offset)? as u32,
        notify: read_i32(bytes, notify_offset)? as u32,
        thread_id: read_i32(bytes, payload_offset)? as u32,
    })
}

pub fn write_statfs(
    bytes: &mut [u8],
    statfs: &WasmStatfs,
    model: ProcessDataModel,
) -> Result<(), Errno> {
    require_len_mut(bytes, model.statfs_size())?;
    bytes.fill(0);
    match model {
        ProcessDataModel::Wasm32 => {
            use process_layout::statfs::*;
            write_u32(bytes, WASM32_TYPE_OFFSET as usize, statfs.f_type)?;
            write_u32(bytes, WASM32_BSIZE_OFFSET as usize, statfs.f_bsize)?;
            write_u64(bytes, WASM32_BLOCKS_OFFSET as usize, statfs.f_blocks)?;
            write_u64(bytes, WASM32_BFREE_OFFSET as usize, statfs.f_bfree)?;
            write_u64(bytes, WASM32_BAVAIL_OFFSET as usize, statfs.f_bavail)?;
            write_u64(bytes, WASM32_FILES_OFFSET as usize, statfs.f_files)?;
            write_u64(bytes, WASM32_FFREE_OFFSET as usize, statfs.f_ffree)?;
            write_u64(bytes, WASM32_FSID_OFFSET as usize, statfs.f_fsid)?;
            write_u32(bytes, WASM32_NAMELEN_OFFSET as usize, statfs.f_namelen)?;
            write_u32(bytes, WASM32_FRSIZE_OFFSET as usize, statfs.f_frsize)?;
            write_u32(bytes, WASM32_FLAGS_OFFSET as usize, statfs.f_flags)
        }
        ProcessDataModel::Wasm64 => {
            use process_layout::statfs::*;
            write_u64(bytes, WASM64_TYPE_OFFSET as usize, statfs.f_type as u64)?;
            write_u64(bytes, WASM64_BSIZE_OFFSET as usize, statfs.f_bsize as u64)?;
            write_u64(bytes, WASM64_BLOCKS_OFFSET as usize, statfs.f_blocks)?;
            write_u64(bytes, WASM64_BFREE_OFFSET as usize, statfs.f_bfree)?;
            write_u64(bytes, WASM64_BAVAIL_OFFSET as usize, statfs.f_bavail)?;
            write_u64(bytes, WASM64_FILES_OFFSET as usize, statfs.f_files)?;
            write_u64(bytes, WASM64_FFREE_OFFSET as usize, statfs.f_ffree)?;
            write_u64(bytes, WASM64_FSID_OFFSET as usize, statfs.f_fsid)?;
            write_u64(
                bytes,
                WASM64_NAMELEN_OFFSET as usize,
                statfs.f_namelen as u64,
            )?;
            write_u64(bytes, WASM64_FRSIZE_OFFSET as usize, statfs.f_frsize as u64)?;
            write_u64(bytes, WASM64_FLAGS_OFFSET as usize, statfs.f_flags as u64)
        }
    }
}

pub fn write_sysinfo(
    bytes: &mut [u8],
    info: &crate::syscalls::KernelSysinfo,
    model: ProcessDataModel,
) -> Result<(), Errno> {
    require_len_mut(bytes, model.sysinfo_size())?;
    bytes.fill(0);
    let (
        uptime,
        loads,
        totalram,
        freeram,
        sharedram,
        bufferram,
        totalswap,
        freeswap,
        procs,
        totalhigh,
        freehigh,
        mem_unit,
    ) = match model {
        ProcessDataModel::Wasm32 => (
            process_layout::sysinfo::WASM32_UPTIME_OFFSET,
            process_layout::sysinfo::WASM32_LOADS_OFFSET,
            process_layout::sysinfo::WASM32_TOTALRAM_OFFSET,
            process_layout::sysinfo::WASM32_FREERAM_OFFSET,
            process_layout::sysinfo::WASM32_SHAREDRAM_OFFSET,
            process_layout::sysinfo::WASM32_BUFFERRAM_OFFSET,
            process_layout::sysinfo::WASM32_TOTALSWAP_OFFSET,
            process_layout::sysinfo::WASM32_FREESWAP_OFFSET,
            process_layout::sysinfo::WASM32_PROCS_OFFSET,
            process_layout::sysinfo::WASM32_TOTALHIGH_OFFSET,
            process_layout::sysinfo::WASM32_FREEHIGH_OFFSET,
            process_layout::sysinfo::WASM32_MEM_UNIT_OFFSET,
        ),
        ProcessDataModel::Wasm64 => (
            process_layout::sysinfo::WASM64_UPTIME_OFFSET,
            process_layout::sysinfo::WASM64_LOADS_OFFSET,
            process_layout::sysinfo::WASM64_TOTALRAM_OFFSET,
            process_layout::sysinfo::WASM64_FREERAM_OFFSET,
            process_layout::sysinfo::WASM64_SHAREDRAM_OFFSET,
            process_layout::sysinfo::WASM64_BUFFERRAM_OFFSET,
            process_layout::sysinfo::WASM64_TOTALSWAP_OFFSET,
            process_layout::sysinfo::WASM64_FREESWAP_OFFSET,
            process_layout::sysinfo::WASM64_PROCS_OFFSET,
            process_layout::sysinfo::WASM64_TOTALHIGH_OFFSET,
            process_layout::sysinfo::WASM64_FREEHIGH_OFFSET,
            process_layout::sysinfo::WASM64_MEM_UNIT_OFFSET,
        ),
    };

    write_native_ulong(bytes, uptime as usize, info.uptime, model)?;
    for (index, load) in info.loads.iter().copied().enumerate() {
        write_native_ulong(
            bytes,
            loads as usize + index * model.native_long_bytes(),
            load,
            model,
        )?;
    }
    for (offset, value) in [
        (totalram, info.totalram),
        (freeram, info.freeram),
        (sharedram, info.sharedram),
        (bufferram, info.bufferram),
        (totalswap, info.totalswap),
        (freeswap, info.freeswap),
        (totalhigh, info.totalhigh),
        (freehigh, info.freehigh),
    ] {
        write_native_ulong(bytes, offset as usize, value, model)?;
    }
    write_u16(bytes, procs as usize, info.procs)?;
    write_u32(bytes, mem_unit as usize, info.mem_unit)
}

pub fn read_rt_sigqueueinfo(
    bytes: &[u8],
    model: ProcessDataModel,
) -> Result<NativeRtSigqueueinfo, Errno> {
    require_len(bytes, model.siginfo_size())?;
    let (pid_offset, uid_offset, value_offset) = siginfo_union_offsets(model);
    Ok(NativeRtSigqueueinfo {
        pid: read_i32(bytes, pid_offset)?,
        uid: read_u32(bytes, uid_offset)?,
        value_bits: read_native_sigval(bytes, value_offset, model)?,
    })
}

fn siginfo_union_offsets(model: ProcessDataModel) -> (usize, usize, usize) {
    match model {
        ProcessDataModel::Wasm32 => (
            process_layout::rt_sigqueueinfo::WASM32_PID_OFFSET as usize,
            process_layout::rt_sigqueueinfo::WASM32_UID_OFFSET as usize,
            process_layout::rt_sigqueueinfo::WASM32_VALUE_OFFSET as usize,
        ),
        ProcessDataModel::Wasm64 => (
            process_layout::rt_sigqueueinfo::WASM64_PID_OFFSET as usize,
            process_layout::rt_sigqueueinfo::WASM64_UID_OFFSET as usize,
            process_layout::rt_sigqueueinfo::WASM64_VALUE_OFFSET as usize,
        ),
    }
}

/// Serialize a complete caller-native `siginfo_t` without retaining scratch
/// bytes in padding or inactive union members.
pub fn write_siginfo(
    bytes: &mut [u8],
    info: NativeSiginfo,
    model: ProcessDataModel,
) -> Result<(), Errno> {
    require_len_mut(bytes, model.siginfo_size())?;
    bytes.fill(0);
    let (word_1_offset, word_2_offset, value_offset) = siginfo_union_offsets(model);
    write_i32(
        bytes,
        process_layout::rt_sigqueueinfo::SIGNO_OFFSET as usize,
        info.signo,
    )?;
    write_i32(
        bytes,
        process_layout::rt_sigqueueinfo::CODE_OFFSET as usize,
        info.code,
    )?;
    write_i32(bytes, word_1_offset, info.word_1)?;
    write_u32(bytes, word_2_offset, info.word_2_bits)?;
    write_native_sigval(bytes, value_offset, info.value_bits, model)
}

/// Serialize the complete guest-native stat record.
///
/// WHY: [`WasmStat`] is the kernel/host canonical metadata record and stops at
/// `st_ctime_nsec`. A stat syscall instead returns musl's larger native
/// `struct kstat`; copying only the canonical prefix would publish reused
/// kernel-scratch bytes as rdev/block metadata.
pub fn write_stat(bytes: &mut [u8], stat: &WasmStat) -> Result<(), Errno> {
    require_len_mut(bytes, process_layout::stat::SIZE as usize)?;
    bytes.fill(0);
    use process_layout::stat::*;
    write_u64(bytes, DEV_OFFSET as usize, stat.st_dev)?;
    write_u64(bytes, INO_OFFSET as usize, stat.st_ino)?;
    write_u32(bytes, MODE_OFFSET as usize, stat.st_mode)?;
    write_u32(bytes, NLINK_OFFSET as usize, stat.st_nlink)?;
    write_u32(bytes, UID_OFFSET as usize, stat.st_uid)?;
    write_u32(bytes, GID_OFFSET as usize, stat.st_gid)?;
    write_u64(bytes, SIZE_OFFSET as usize, stat.st_size)?;
    write_u64(bytes, ATIME_SEC_OFFSET as usize, stat.st_atime_sec)?;
    write_u32(bytes, ATIME_NSEC_OFFSET as usize, stat.st_atime_nsec)?;
    write_u64(bytes, MTIME_SEC_OFFSET as usize, stat.st_mtime_sec)?;
    write_u32(bytes, MTIME_NSEC_OFFSET as usize, stat.st_mtime_nsec)?;
    write_u64(bytes, CTIME_SEC_OFFSET as usize, stat.st_ctime_sec)?;
    write_u32(bytes, CTIME_NSEC_OFFSET as usize, stat.st_ctime_nsec)?;
    write_u64(bytes, RDEV_OFFSET as usize, stat.st_rdev)
}

pub fn read_sched_param(bytes: &[u8]) -> Result<NativeSchedParam, Errno> {
    require_len(bytes, process_layout::sched_param::SIZE as usize)?;
    use process_layout::sched_param::*;
    Ok(NativeSchedParam {
        priority: read_i32(bytes, PRIORITY_OFFSET as usize)?,
        ss_max_repl: read_i32(bytes, SS_MAX_REPL_OFFSET as usize)?,
        ss_repl_period_sec: read_i64(bytes, SS_REPL_PERIOD_SEC_OFFSET as usize)?,
        ss_repl_period_nsec: read_i64(bytes, SS_REPL_PERIOD_NSEC_OFFSET as usize)?,
        ss_init_budget_sec: read_i64(bytes, SS_INIT_BUDGET_SEC_OFFSET as usize)?,
        ss_init_budget_nsec: read_i64(bytes, SS_INIT_BUDGET_NSEC_OFFSET as usize)?,
        ss_low_priority: read_i32(bytes, SS_LOW_PRIORITY_OFFSET as usize)?,
    })
}

pub fn write_sched_param(bytes: &mut [u8], param: NativeSchedParam) -> Result<(), Errno> {
    require_len_mut(bytes, process_layout::sched_param::SIZE as usize)?;
    bytes.fill(0);
    use process_layout::sched_param::*;
    write_i32(bytes, PRIORITY_OFFSET as usize, param.priority)?;
    write_i32(bytes, SS_MAX_REPL_OFFSET as usize, param.ss_max_repl)?;
    write_i64(
        bytes,
        SS_REPL_PERIOD_SEC_OFFSET as usize,
        param.ss_repl_period_sec,
    )?;
    write_i64(
        bytes,
        SS_REPL_PERIOD_NSEC_OFFSET as usize,
        param.ss_repl_period_nsec,
    )?;
    write_i64(
        bytes,
        SS_INIT_BUDGET_SEC_OFFSET as usize,
        param.ss_init_budget_sec,
    )?;
    write_i64(
        bytes,
        SS_INIT_BUDGET_NSEC_OFFSET as usize,
        param.ss_init_budget_nsec,
    )?;
    write_i32(
        bytes,
        SS_LOW_PRIORITY_OFFSET as usize,
        param.ss_low_priority,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_statfs() -> WasmStatfs {
        WasmStatfs {
            f_type: 0x1122_3344,
            f_bsize: 0x5566_7788,
            f_blocks: 0x0102_0304_0506_0708,
            f_bfree: 0x1112_1314_1516_1718,
            f_bavail: 0x2122_2324_2526_2728,
            f_files: 0x3132_3334_3536_3738,
            f_ffree: 0x4142_4344_4546_4748,
            f_fsid: 0x5152_5354_5556_5758,
            f_namelen: 255,
            f_frsize: 4096,
            f_flags: 0xa5a5_5a5a,
            _pad: 0,
        }
    }

    #[test]
    fn rejects_unknown_process_width() {
        assert_eq!(ProcessDataModel::from_width(0), Err(Errno::EINVAL));
        assert_eq!(ProcessDataModel::from_width(16), Err(Errno::EINVAL));
    }

    #[test]
    fn signal_delivery_output_requires_nonnull_exact_capacity() {
        use wasm_posix_shared::kernel_scratch_wire as wire;

        let mut byte = 0u8;
        let pointer = &mut byte as *mut u8;
        let exact = wire::SIGNAL_DELIVERY_BYTES;

        assert_eq!(validate_signal_delivery_output(pointer, exact), Ok(()));
        assert_eq!(
            validate_signal_delivery_output(core::ptr::null_mut(), exact),
            Err(Errno::EFAULT),
        );
        assert_eq!(
            validate_signal_delivery_output(pointer, exact - 1),
            Err(Errno::EINVAL),
        );
        assert_eq!(
            validate_signal_delivery_output(pointer, exact + 1),
            Err(Errno::EINVAL),
        );
    }

    #[test]
    fn signal_delivery_record_serializes_every_field_at_the_shared_offsets() {
        use wasm_posix_shared::kernel_scratch_wire as wire;

        let record = SignalDeliveryRecord {
            signum: 17,
            handler: 23,
            flags: 0x0800_0004,
            si_value_bits: 0x0123_4567_89ab_cdef,
            old_mask: 0x0102_0304_0506_0708,
            si_code: -2,
            siginfo_word_1: -31,
            siginfo_word_2: 37,
            alt_sp: 0x1_2345_6789,
            alt_size: 0x2_3456_789a,
        };
        let bytes = encode_signal_delivery_record(record);
        let expected: [u8; wire::SIGNAL_DELIVERY_BYTES as usize] = [
            0x11, 0x00, 0x00, 0x00, // signum
            0x17, 0x00, 0x00, 0x00, // handler
            0x04, 0x00, 0x00, 0x08, // flags
            0xef, 0xcd, 0xab, 0x89, 0x67, 0x45, 0x23, 0x01, // raw sigval bits
            0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, // old_mask
            0xfe, 0xff, 0xff, 0xff, // si_code = -2
            0xe1, 0xff, 0xff, 0xff, // siginfo word 1 = -31
            0x25, 0x00, 0x00, 0x00, // siginfo word 2 = 37
            0x89, 0x67, 0x45, 0x23, 0x01, 0x00, 0x00, 0x00, // alt_sp
            0x9a, 0x78, 0x56, 0x34, 0x02, 0x00, 0x00, 0x00, // alt_size
        ];

        assert_eq!(bytes, expected);
    }

    #[test]
    fn sigaltstack_validates_exclusive_top_in_each_pointer_domain() {
        let stack = |sp, size| NativeSigaltstack { sp, flags: 0, size };
        let wasm32_exact_top = stack(u32::MAX as u64 - 4096, 4096);
        assert_eq!(
            validate_sigaltstack_range(wasm32_exact_top, ProcessDataModel::Wasm32),
            Ok(()),
        );
        assert_eq!(
            validate_sigaltstack_range(
                stack(wasm32_exact_top.sp, wasm32_exact_top.size + 1),
                ProcessDataModel::Wasm32,
            ),
            Err(Errno::EOVERFLOW),
        );
        assert_eq!(
            validate_sigaltstack_range(
                stack(0, u32::MAX as u64 + 1),
                ProcessDataModel::Wasm32,
            ),
            Err(Errno::EOVERFLOW),
        );
        assert_eq!(
            validate_sigaltstack_range(
                stack(u32::MAX as u64 + 4096, 8192),
                ProcessDataModel::Wasm64,
            ),
            Ok(()),
        );
        assert_eq!(
            validate_sigaltstack_range(
                stack(u64::MAX - 1, 2),
                ProcessDataModel::Wasm64,
            ),
            Err(Errno::EOVERFLOW),
        );
    }

    #[test]
    fn disabled_sigaltstack_ignores_nonsemantic_pointer_fields() {
        let disabled = NativeSigaltstack {
            sp: u64::MAX,
            flags: SIGALTSTACK_SS_DISABLE,
            size: u64::MAX,
        };
        assert_eq!(
            validate_sigaltstack_range(disabled, ProcessDataModel::Wasm32),
            Ok(()),
        );
        assert_eq!(
            validate_sigaltstack_range(disabled, ProcessDataModel::Wasm64),
            Ok(()),
        );
    }

    #[test]
    fn sigaltstack_round_trips_each_native_layout() {
        let stack = NativeSigaltstack {
            sp: 0x1020_3040,
            flags: 2,
            size: 0x5060_7080,
        };
        for model in [ProcessDataModel::Wasm32, ProcessDataModel::Wasm64] {
            let mut bytes = alloc::vec![0xcc; model.sigaltstack_size()];
            write_sigaltstack(&mut bytes, stack, model).unwrap();
            assert_eq!(read_sigaltstack(&bytes, model).unwrap(), stack);
            assert!(bytes.iter().any(|byte| *byte == 0));

            let mut short = alloc::vec![0; model.sigaltstack_size() - 1];
            assert_eq!(
                write_sigaltstack(&mut short, stack, model),
                Err(Errno::EINVAL)
            );
            let mut long = alloc::vec![0; model.sigaltstack_size() + 1];
            assert_eq!(
                write_sigaltstack(&mut long, stack, model),
                Err(Errno::EINVAL)
            );
        }

        let high = NativeSigaltstack {
            sp: u32::MAX as u64 + 0x1_001,
            flags: 0,
            size: u32::MAX as u64 + 0x2_002,
        };
        let mut wasm64 = alloc::vec![0; ProcessDataModel::Wasm64.sigaltstack_size()];
        write_sigaltstack(&mut wasm64, high, ProcessDataModel::Wasm64).unwrap();
        assert_eq!(
            read_sigaltstack(&wasm64, ProcessDataModel::Wasm64),
            Ok(high),
        );

        let mut wasm32 = alloc::vec![0; ProcessDataModel::Wasm32.sigaltstack_size()];
        assert_eq!(
            write_sigaltstack(&mut wasm32, high, ProcessDataModel::Wasm32),
            Err(Errno::EOVERFLOW),
        );
    }

    #[test]
    fn itimerval_uses_four_i32_or_four_i64_fields() {
        let values = [1, 2, 3, 4];
        for model in [ProcessDataModel::Wasm32, ProcessDataModel::Wasm64] {
            let mut bytes = alloc::vec![0; model.itimerval_size()];
            write_itimerval(&mut bytes, values, model).unwrap();
            assert_eq!(read_itimerval(&bytes, model).unwrap(), values);

            let mut short = alloc::vec![0; model.itimerval_size() - 1];
            assert_eq!(
                write_itimerval(&mut short, values, model),
                Err(Errno::EINVAL)
            );
            assert_eq!(read_itimerval(&short, model), Err(Errno::EINVAL));
            let mut long = alloc::vec![0; model.itimerval_size() + 1];
            assert_eq!(
                write_itimerval(&mut long, values, model),
                Err(Errno::EINVAL)
            );
            assert_eq!(read_itimerval(&long, model), Err(Errno::EINVAL));
        }

        let mut wasm32 = [0u8; process_layout::itimerval::WASM32_SIZE as usize];
        assert_eq!(
            write_itimerval(
                &mut wasm32,
                [i32::MAX as i64 + 1, 0, 0, 0],
                ProcessDataModel::Wasm32,
            ),
            Err(Errno::EOVERFLOW)
        );
    }

    #[test]
    fn mq_attr_and_sigevent_follow_process_long_width() {
        let attr = NativeMqAttr {
            flags: 0x800,
            maxmsg: 17,
            msgsize: 8192,
            curmsgs: 3,
        };
        for model in [ProcessDataModel::Wasm32, ProcessDataModel::Wasm64] {
            let mut bytes = alloc::vec![0xcc; model.mq_attr_size()];
            write_mq_attr(&mut bytes, attr, model).unwrap();
            assert_eq!(read_mq_attr(&bytes, model).unwrap(), attr);
            assert!(
                bytes[model.native_long_bytes() * 4..]
                    .iter()
                    .all(|byte| *byte == 0)
            );

            let mut short_attr = alloc::vec![0; model.mq_attr_size() - 1];
            assert_eq!(
                write_mq_attr(&mut short_attr, attr, model),
                Err(Errno::EINVAL)
            );
            assert_eq!(read_mq_attr(&short_attr, model), Err(Errno::EINVAL));
            let mut long_attr = alloc::vec![0; model.mq_attr_size() + 1];
            assert_eq!(
                write_mq_attr(&mut long_attr, attr, model),
                Err(Errno::EINVAL)
            );
            assert_eq!(read_mq_attr(&long_attr, model), Err(Errno::EINVAL));

            let mut event = alloc::vec![0; model.sigevent_size()];
            let (value_offset, value_bits, signo_offset, notify_offset, payload_offset) =
                match model {
                    ProcessDataModel::Wasm32 => (0, 0x89ab_cdef_u64, 4, 8, 12),
                    ProcessDataModel::Wasm64 => {
                        (0, 0x0123_4567_89ab_cdef_u64, 8, 12, 16)
                    }
                };
            match model {
                ProcessDataModel::Wasm32 => event[value_offset..value_offset + 4]
                    .copy_from_slice(&(value_bits as u32).to_le_bytes()),
                ProcessDataModel::Wasm64 => event[value_offset..value_offset + 8]
                    .copy_from_slice(&value_bits.to_le_bytes()),
            };
            event[signo_offset..signo_offset + 4].copy_from_slice(&10i32.to_le_bytes());
            event[notify_offset..notify_offset + 4].copy_from_slice(&4i32.to_le_bytes());
            event[payload_offset..payload_offset + 4].copy_from_slice(&42i32.to_le_bytes());
            assert_eq!(
                read_sigevent(&event, model).unwrap(),
                NativeSigevent {
                    value_bits,
                    signo: 10,
                    notify: 4,
                    thread_id: 42,
                }
            );
            assert_eq!(
                read_sigevent(&event[..event.len() - 1], model),
                Err(Errno::EINVAL)
            );
            event.push(0);
            assert_eq!(read_sigevent(&event, model), Err(Errno::EINVAL));
        }
    }

    #[test]
    fn statfs_serializes_exact_native_sizes_and_zeroes_spares() {
        let statfs = sample_statfs();
        for model in [ProcessDataModel::Wasm32, ProcessDataModel::Wasm64] {
            let mut bytes = alloc::vec![0xcc; model.statfs_size()];
            write_statfs(&mut bytes, &statfs, model).unwrap();
            let spare = match model {
                ProcessDataModel::Wasm32 => process_layout::statfs::WASM32_SPARE_OFFSET,
                ProcessDataModel::Wasm64 => process_layout::statfs::WASM64_SPARE_OFFSET,
            } as usize;
            assert!(bytes[spare..].iter().all(|byte| *byte == 0));

            let mut short = alloc::vec![0; model.statfs_size() - 1];
            assert_eq!(write_statfs(&mut short, &statfs, model), Err(Errno::EINVAL));
            let mut long = alloc::vec![0; model.statfs_size() + 1];
            assert_eq!(write_statfs(&mut long, &statfs, model), Err(Errno::EINVAL));
        }
    }

    #[test]
    fn sysinfo_serializes_exact_native_sizes_and_zeroes_reserved_bytes() {
        let info = crate::syscalls::sys_sysinfo();
        for model in [ProcessDataModel::Wasm32, ProcessDataModel::Wasm64] {
            let size = model.sysinfo_size();
            let mut guarded = alloc::vec![0x5a; size + 2];
            let bytes = &mut guarded[1..size + 1];
            write_sysinfo(bytes, &info, model).unwrap();

            let (uptime, totalram, freeram, procs, mem_unit, reserved) = match model {
                ProcessDataModel::Wasm32 => (
                    read_u32(
                        bytes,
                        process_layout::sysinfo::WASM32_UPTIME_OFFSET as usize,
                    )
                    .unwrap() as u64,
                    read_u32(
                        bytes,
                        process_layout::sysinfo::WASM32_TOTALRAM_OFFSET as usize,
                    )
                    .unwrap() as u64,
                    read_u32(
                        bytes,
                        process_layout::sysinfo::WASM32_FREERAM_OFFSET as usize,
                    )
                    .unwrap() as u64,
                    process_layout::sysinfo::WASM32_PROCS_OFFSET,
                    process_layout::sysinfo::WASM32_MEM_UNIT_OFFSET,
                    process_layout::sysinfo::WASM32_RESERVED_OFFSET,
                ),
                ProcessDataModel::Wasm64 => (
                    read_u64(
                        bytes,
                        process_layout::sysinfo::WASM64_UPTIME_OFFSET as usize,
                    )
                    .unwrap(),
                    read_u64(
                        bytes,
                        process_layout::sysinfo::WASM64_TOTALRAM_OFFSET as usize,
                    )
                    .unwrap(),
                    read_u64(
                        bytes,
                        process_layout::sysinfo::WASM64_FREERAM_OFFSET as usize,
                    )
                    .unwrap(),
                    process_layout::sysinfo::WASM64_PROCS_OFFSET,
                    process_layout::sysinfo::WASM64_MEM_UNIT_OFFSET,
                    process_layout::sysinfo::WASM64_RESERVED_OFFSET,
                ),
            };
            assert_eq!(uptime, info.uptime);
            assert_eq!(totalram, info.totalram);
            assert_eq!(freeram, info.freeram);
            assert_eq!(
                u16::from_le_bytes(
                    bytes[procs as usize..procs as usize + 2]
                        .try_into()
                        .unwrap()
                ),
                info.procs
            );
            assert_eq!(read_u32(bytes, mem_unit as usize).unwrap(), info.mem_unit);
            assert!(bytes[reserved as usize..].iter().all(|byte| *byte == 0));
            assert_eq!(guarded[0], 0x5a);
            assert_eq!(guarded[size + 1], 0x5a);

            let mut short = alloc::vec![0; size - 1];
            assert_eq!(write_sysinfo(&mut short, &info, model), Err(Errno::EINVAL));
            let mut long = alloc::vec![0; size + 1];
            assert_eq!(write_sysinfo(&mut long, &info, model), Err(Errno::EINVAL));
        }
    }

    #[test]
    fn siginfo_reads_and_completely_writes_each_native_layout() {
        for (model, pid_offset, uid_offset, value_offset) in [
            (
                ProcessDataModel::Wasm32,
                process_layout::rt_sigqueueinfo::WASM32_PID_OFFSET as usize,
                process_layout::rt_sigqueueinfo::WASM32_UID_OFFSET as usize,
                process_layout::rt_sigqueueinfo::WASM32_VALUE_OFFSET as usize,
            ),
            (
                ProcessDataModel::Wasm64,
                process_layout::rt_sigqueueinfo::WASM64_PID_OFFSET as usize,
                process_layout::rt_sigqueueinfo::WASM64_UID_OFFSET as usize,
                process_layout::rt_sigqueueinfo::WASM64_VALUE_OFFSET as usize,
            ),
        ] {
            let value_bits = match model {
                ProcessDataModel::Wasm32 => 0xefdf_cfc0,
                ProcessDataModel::Wasm64 => 0x0123_4567_89ab_cdef,
            };
            let info = NativeSiginfo {
                signo: 12,
                code: -1,
                word_1: 1234,
                word_2_bits: 0xf123_4567,
                value_bits,
            };
            let size = model.siginfo_size();
            let mut guarded = alloc::vec![0x5a; size + 2];
            write_siginfo(&mut guarded[1..size + 1], info, model).unwrap();
            let bytes = &guarded[1..size + 1];

            let mut expected = alloc::vec![0; size];
            expected[process_layout::rt_sigqueueinfo::SIGNO_OFFSET as usize
                ..process_layout::rt_sigqueueinfo::SIGNO_OFFSET as usize + 4]
                .copy_from_slice(&info.signo.to_le_bytes());
            expected[process_layout::rt_sigqueueinfo::CODE_OFFSET as usize
                ..process_layout::rt_sigqueueinfo::CODE_OFFSET as usize + 4]
                .copy_from_slice(&info.code.to_le_bytes());
            expected[pid_offset..pid_offset + 4].copy_from_slice(&info.word_1.to_le_bytes());
            expected[uid_offset..uid_offset + 4].copy_from_slice(&info.word_2_bits.to_le_bytes());
            match model {
                ProcessDataModel::Wasm32 => expected[value_offset..value_offset + 4]
                    .copy_from_slice(&(info.value_bits as u32).to_le_bytes()),
                ProcessDataModel::Wasm64 => expected[value_offset..value_offset + 8]
                    .copy_from_slice(&info.value_bits.to_le_bytes()),
            }
            assert_eq!(bytes, expected);
            assert_eq!(guarded[0], 0x5a);
            assert_eq!(guarded[size + 1], 0x5a);

            assert_eq!(
                read_rt_sigqueueinfo(bytes, model).unwrap(),
                NativeRtSigqueueinfo {
                    pid: 1234,
                    uid: 0xf123_4567,
                    value_bits,
                }
            );
            assert_eq!(
                read_rt_sigqueueinfo(&bytes[..bytes.len() - 1], model),
                Err(Errno::EINVAL)
            );
            let mut long = bytes.to_vec();
            long.push(0);
            assert_eq!(read_rt_sigqueueinfo(&long, model), Err(Errno::EINVAL));

            let mut short_output = alloc::vec![0xa5; size - 1];
            assert_eq!(
                write_siginfo(&mut short_output, info, model),
                Err(Errno::EINVAL),
            );
            assert!(short_output.iter().all(|byte| *byte == 0xa5));
            let mut long_output = alloc::vec![0xa5; size + 1];
            assert_eq!(
                write_siginfo(&mut long_output, info, model),
                Err(Errno::EINVAL),
            );
            assert!(long_output.iter().all(|byte| *byte == 0xa5));
        }

        let mut wasm32 = alloc::vec![0xa5; ProcessDataModel::Wasm32.siginfo_size()];
        let mixed_model = NativeSiginfo {
            signo: 12,
            code: -1,
            word_1: 1,
            word_2_bits: 2,
            value_bits: 0x0123_4567_89ab_cdef,
        };
        assert_eq!(
            write_siginfo(&mut wasm32, mixed_model, ProcessDataModel::Wasm32),
            Ok(()),
        );
        let offset = process_layout::rt_sigqueueinfo::WASM32_VALUE_OFFSET as usize;
        assert_eq!(
            u32::from_le_bytes(wasm32[offset..offset + 4].try_into().unwrap()),
            0x89ab_cdef,
        );
    }

    fn sample_stat() -> WasmStat {
        WasmStat {
            st_dev: 0x0102_0304_0506_0708,
            st_ino: 0x1112_1314_1516_1718,
            st_mode: 0x2122_2324,
            st_nlink: 0x3132_3334,
            st_uid: 0x4142_4344,
            st_gid: 0x5152_5354,
            st_size: 0x6162_6364_6566_6768,
            st_atime_sec: 0x7172_7374_7576_7778,
            st_atime_nsec: 0x0102_0304,
            st_mtime_sec: 0x1112_1314_1516_1718,
            st_mtime_nsec: 0x2122_2324,
            st_ctime_sec: 0x3132_3334_3536_3738,
            st_ctime_nsec: 0x4142_4344,
            _pad: 0,
            st_rdev: 0x5152_5354_5556_5758,
        }
    }

    #[test]
    fn stat_serializes_all_112_bytes_without_touching_canaries() {
        let stat = sample_stat();
        let size = process_layout::stat::SIZE as usize;
        let mut guarded = alloc::vec![0x5a; size + 2];
        write_stat(&mut guarded[1..size + 1], &stat).unwrap();
        assert_eq!(guarded[0], 0x5a);
        assert_eq!(guarded[size + 1], 0x5a);

        let bytes = &guarded[1..size + 1];
        assert_eq!(
            read_u64(bytes, process_layout::stat::DEV_OFFSET as usize).unwrap(),
            stat.st_dev
        );
        assert_eq!(
            read_u64(bytes, process_layout::stat::CTIME_SEC_OFFSET as usize).unwrap(),
            stat.st_ctime_sec
        );
        assert_eq!(
            read_u32(bytes, process_layout::stat::CTIME_NSEC_OFFSET as usize).unwrap(),
            stat.st_ctime_nsec
        );
        assert_eq!(
            read_u64(bytes, process_layout::stat::RDEV_OFFSET as usize).unwrap(),
            stat.st_rdev
        );
        assert!(
            bytes[process_layout::stat::BLKSIZE_OFFSET as usize..]
                .iter()
                .all(|byte| *byte == 0),
            "unsupported blksize/blocks and their padding must be initialized"
        );

        let mut short = alloc::vec![0; size - 1];
        assert_eq!(write_stat(&mut short, &stat), Err(Errno::EINVAL));
        let mut long = alloc::vec![0; size + 1];
        assert_eq!(write_stat(&mut long, &stat), Err(Errno::EINVAL));
    }

    #[test]
    fn sched_param_round_trips_all_fields_and_zeroes_trailing_padding() {
        let param = NativeSchedParam {
            priority: 1,
            ss_max_repl: 2,
            ss_repl_period_sec: 3,
            ss_repl_period_nsec: 4,
            ss_init_budget_sec: 5,
            ss_init_budget_nsec: 6,
            ss_low_priority: 7,
        };
        let size = process_layout::sched_param::SIZE as usize;
        let mut guarded = alloc::vec![0x7c; size + 2];
        write_sched_param(&mut guarded[1..size + 1], param).unwrap();
        assert_eq!(guarded[0], 0x7c);
        assert_eq!(guarded[size + 1], 0x7c);
        let bytes = &guarded[1..size + 1];
        assert_eq!(read_sched_param(bytes).unwrap(), param);
        assert!(bytes[44..48].iter().all(|byte| *byte == 0));

        let mut short = alloc::vec![0; size - 1];
        assert_eq!(write_sched_param(&mut short, param), Err(Errno::EINVAL));
        assert_eq!(read_sched_param(&short), Err(Errno::EINVAL));
        let mut long = alloc::vec![0; size + 1];
        assert_eq!(write_sched_param(&mut long, param), Err(Errno::EINVAL));
        assert_eq!(read_sched_param(&long), Err(Errno::EINVAL));

        let mut zero = alloc::vec![0xa5; size];
        write_sched_param(&mut zero, NativeSchedParam::default()).unwrap();
        assert!(zero.iter().all(|byte| *byte == 0));
    }
}
