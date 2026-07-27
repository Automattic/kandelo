//! Capacity-carrying bounds for one live widened-syscall channel allocation.
//!
//! This module is target-independent so the pure ownership checks used by the
//! Wasm dispatcher are exercised by the ordinary native kernel test suite.

use core::mem::{offset_of, size_of};

use wasm_posix_shared::abi::extended_syscalls;
use wasm_posix_shared::host_abi::{
    PROCESS_POINTER_WIDTH_ARG_INDEX, SYSCALL_ARG_DESCRIPTORS, SyscallArgDesc, SyscallArgSize,
};
use wasm_posix_shared::{
    Errno, KernelIovecWire, KernelMsghdrWire, Syscall, WasmEpollEvent, WasmSysvMessageHeader,
    kernel_scratch_wire, platform_limits, prctl,
};

const SCRATCH_ALIGNMENT: usize = 8;
const KERNEL_WIRE_ALIGNMENT: usize = 4;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Numeric bounds of the data area in one live kernel channel allocation.
///
/// Keep the allocation capacity beside its address. A pointer being somewhere
/// in kernel linear memory does not prove that the bytes after it belong to the
/// channel currently being dispatched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ChannelScratchRegion {
    start: usize,
    capacity: usize,
}

/// One already-proven subrange of a live channel scratch allocation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ChannelScratchRange {
    start: usize,
    length: usize,
}

impl ChannelScratchRange {
    pub(crate) const fn start(self) -> usize {
        self.start
    }
}

impl ChannelScratchRegion {
    pub(crate) fn new(start: usize, capacity: usize) -> Result<Self, Errno> {
        start.checked_add(capacity).ok_or(Errno::EFAULT)?;
        Ok(Self { start, capacity })
    }

    pub(crate) fn for_channel(channel_offset: usize) -> Result<Self, Errno> {
        use wasm_posix_shared::channel::{DATA_OFFSET, DATA_SIZE};

        let start = channel_offset
            .checked_add(DATA_OFFSET)
            .ok_or(Errno::EFAULT)?;
        Self::new(start, DATA_SIZE)
    }

    pub(crate) const fn start(self) -> usize {
        self.start
    }

    pub(crate) fn end(self) -> Result<usize, Errno> {
        self.start.checked_add(self.capacity).ok_or(Errno::EFAULT)
    }

    /// Prove a complete byte range against this allocation, independently of
    /// whether it also happens to fit in the kernel's total linear memory.
    pub(crate) fn checked_range(
        self,
        pointer: usize,
        length: usize,
    ) -> Result<ChannelScratchRange, Errno> {
        if pointer < self.start {
            return Err(Errno::EFAULT);
        }
        let allocation_end = self.end()?;
        let range_end = pointer.checked_add(length).ok_or(Errno::EFAULT)?;
        if pointer > allocation_end || range_end > allocation_end {
            return Err(Errno::EFAULT);
        }
        if length > 0 && pointer == 0 {
            return Err(Errno::EFAULT);
        }
        Ok(ChannelScratchRange {
            start: pointer,
            length,
        })
    }

    /// Prove a command-dependent payload starts at the allocation base and
    /// fits completely inside its explicit capacity.
    pub(crate) fn checked_start_range(
        self,
        pointer: usize,
        length: usize,
    ) -> Result<ChannelScratchRange, Errno> {
        if pointer != self.start {
            return Err(Errno::EFAULT);
        }
        self.checked_range(pointer, length)
    }

    fn remaining_from(self, pointer: usize) -> Result<usize, Errno> {
        if pointer == 0 || pointer < self.start {
            return Err(Errno::EFAULT);
        }
        let end = self.start.checked_add(self.capacity).ok_or(Errno::EFAULT)?;
        if pointer >= end {
            return Err(Errno::EFAULT);
        }
        end.checked_sub(pointer).ok_or(Errno::EFAULT)
    }
}

/// Per-argument evidence produced before channel dispatch dereferences scratch.
///
/// `described[index]` distinguishes a reviewed null pointer from an argument
/// which no descriptor or bespoke wire validator proved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ValidatedChannelScratchArgs {
    described: [bool; 6],
    ranges: [Option<ChannelScratchRange>; 6],
}

impl ValidatedChannelScratchArgs {
    const fn new() -> Self {
        Self {
            described: [false; 6],
            ranges: [None; 6],
        }
    }

    fn mark_null(&mut self, index: usize) -> Result<(), Errno> {
        if index >= self.ranges.len() {
            return Err(Errno::EINVAL);
        }
        self.described[index] = true;
        self.ranges[index] = None;
        Ok(())
    }

    fn mark_range(&mut self, index: usize, range: ChannelScratchRange) -> Result<(), Errno> {
        if index >= self.ranges.len() {
            return Err(Errno::EINVAL);
        }
        self.described[index] = true;
        self.ranges[index] = Some(range);
        Ok(())
    }

    /// Return a pointer only if the corresponding descriptor or reviewed
    /// bespoke-wire validator proved its exact allocation-owned subrange.
    pub(crate) fn pointer(self, index: usize) -> Result<usize, Errno> {
        if index >= self.ranges.len() || !self.described[index] {
            return Err(Errno::EFAULT);
        }
        Ok(self.ranges[index].map_or(0, ChannelScratchRange::start))
    }
}

fn checked_pointer(raw: i64) -> Result<usize, Errno> {
    usize::try_from(raw as u64).map_err(|_| Errno::EFAULT)
}

fn checked_size_scalar(raw: i64) -> Result<usize, Errno> {
    if !(0..=MAX_SAFE_INTEGER).contains(&raw) {
        return Err(Errno::EINVAL);
    }
    usize::try_from(raw).map_err(|_| Errno::EINVAL)
}

fn align_up(value: usize, alignment: usize) -> Result<usize, Errno> {
    if !alignment.is_power_of_two() {
        return Err(Errno::EINVAL);
    }
    value
        .checked_add(alignment - 1)
        .map(|value| value & !(alignment - 1))
        .ok_or(Errno::EFAULT)
}

unsafe fn read_u32(pointer: usize, region: ChannelScratchRegion) -> Result<u32, Errno> {
    let range = region.checked_range(pointer, size_of::<u32>())?;
    let bytes = unsafe { core::slice::from_raw_parts(range.start as *const u8, range.length) };
    Ok(u32::from_le_bytes(
        bytes.try_into().map_err(|_| Errno::EFAULT)?,
    ))
}

unsafe fn descriptor_size(
    descriptor: &SyscallArgDesc,
    args: &[i64; 6],
    region: ChannelScratchRegion,
) -> Result<usize, Errno> {
    match descriptor.size {
        SyscallArgSize::CString {
            max_bytes,
            too_long_errno,
        } => {
            let pointer = checked_pointer(args[descriptor.arg_index as usize])?;
            region.checked_range(pointer, 0)?;
            let remaining = region.end()?.checked_sub(pointer).ok_or(Errno::EFAULT)?;
            let bounded =
                ChannelScratchRegion::new(pointer, remaining.min(max_bytes as usize))?;
            let length = match unsafe { checked_cstr_len(pointer as *const u8, bounded) } {
                Ok(length) => length,
                Err(_) if remaining >= max_bytes as usize => {
                    return Err(Errno::from_u32(too_long_errno).unwrap_or(Errno::EIO));
                }
                Err(error) => return Err(error),
            };
            usize::try_from(length)
                .ok()
                .and_then(|length| length.checked_add(1))
                .ok_or(Errno::EFAULT)
        }
        SyscallArgSize::Arg {
            arg_index,
            multiplier,
            add,
        } => checked_size_scalar(args[arg_index as usize])?
            .checked_mul(multiplier as usize)
            .and_then(|length| length.checked_add(add as usize))
            .ok_or(Errno::EINVAL),
        SyscallArgSize::Deref { arg_index } => {
            let pointer = checked_pointer(args[arg_index as usize])?;
            if pointer == 0 {
                return Err(Errno::EFAULT);
            }
            Ok(unsafe { read_u32(pointer, region) }? as usize)
        }
        SyscallArgSize::Fixed { size } => Ok(size as usize),
        SyscallArgSize::ProcessLayout {
            wasm32_size,
            wasm64_size,
        } => match args[PROCESS_POINTER_WIDTH_ARG_INDEX as usize] {
            4 => Ok(wasm32_size as usize),
            8 => Ok(wasm64_size as usize),
            _ => Err(Errno::EINVAL),
        },
    }
}

unsafe fn validate_descriptor_layout(
    args: &[i64; 6],
    descriptors: &[SyscallArgDesc],
    region: ChannelScratchRegion,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    let mut validated = ValidatedChannelScratchArgs::new();
    let mut cursor = region.start;

    for descriptor in descriptors {
        let index = descriptor.arg_index as usize;
        if index >= args.len() {
            return Err(Errno::EINVAL);
        }
        let pointer = checked_pointer(args[index])?;
        if pointer == 0 {
            if let SyscallArgSize::Arg {
                arg_index,
                multiplier,
                add,
            } = descriptor.size
            {
                let length = checked_size_scalar(args[arg_index as usize])?
                    .checked_mul(multiplier as usize)
                    .and_then(|length| length.checked_add(add as usize))
                    .ok_or(Errno::EINVAL)?;
                if length == 0 {
                    // Preserve the syscall's null-plus-zero semantics while
                    // giving Rust a valid empty-slice address. The normal host
                    // already writes this canonical address itself.
                    validated.mark_range(index, region.checked_range(region.start, 0)?)?;
                    continue;
                }
            }
            if !descriptor.nullable {
                // Shared metadata explicitly classifies every positive-extent
                // pointer as required or nullable. Enforce that classification
                // independently in Rust before dispatch can form a slice.
                return Err(Errno::EFAULT);
            }
            validated.mark_null(index)?;
            continue;
        }

        let length = unsafe { descriptor_size(descriptor, args, region) }?;
        if length == 0 {
            // WHY: the host deliberately canonicalizes every empty borrow to
            // the allocation start. Accepting an arbitrary address here would
            // let a process pointer cross the host/kernel boundary merely
            // because the associated count happened to be zero.
            if pointer != region.start {
                return Err(Errno::EFAULT);
            }
            validated.mark_range(index, region.checked_range(pointer, 0)?)?;
            continue;
        }
        if pointer != cursor {
            return Err(Errno::EFAULT);
        }
        let range = region.checked_range(pointer, length)?;
        validated.mark_range(index, range)?;
        cursor = align_up(
            pointer.checked_add(length).ok_or(Errno::EFAULT)?,
            SCRATCH_ALIGNMENT,
        )?;
        if cursor > region.end()? {
            return Err(Errno::EFAULT);
        }
    }
    Ok(validated)
}

fn checked_exact_range(
    validated: &mut ValidatedChannelScratchArgs,
    args: &[i64; 6],
    index: usize,
    expected_pointer: usize,
    length: usize,
    region: ChannelScratchRegion,
) -> Result<ChannelScratchRange, Errno> {
    let pointer = checked_pointer(args[index])?;
    if pointer != expected_pointer {
        return Err(Errno::EFAULT);
    }
    let range = region.checked_range(pointer, length)?;
    validated.mark_range(index, range)?;
    Ok(range)
}

fn checked_nullable_exact_range(
    validated: &mut ValidatedChannelScratchArgs,
    args: &[i64; 6],
    index: usize,
    expected_pointer: usize,
    length: usize,
    region: ChannelScratchRegion,
) -> Result<(), Errno> {
    let pointer = checked_pointer(args[index])?;
    if pointer == 0 {
        return validated.mark_null(index);
    }
    checked_exact_range(validated, args, index, expected_pointer, length, region)?;
    Ok(())
}

unsafe fn validate_iovec_layout(
    args: &[i64; 6],
    region: ChannelScratchRegion,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    let count = checked_size_scalar(args[2])?;
    if count > platform_limits::IOV_MAX {
        return Err(Errno::EINVAL);
    }
    let mut validated = ValidatedChannelScratchArgs::new();
    if count == 0 {
        // POSIX ignores the iovec pointer when no entries exist. Record a
        // canonical null for dispatch without converting, range-checking, or
        // reading the caller-provided pointer bits.
        validated.mark_null(1)?;
        return Ok(validated);
    }
    let table_bytes = count
        .checked_mul(size_of::<KernelIovecWire>())
        .ok_or(Errno::EINVAL)?;
    let table = checked_exact_range(&mut validated, args, 1, region.start, table_bytes, region)?;
    let table_bytes =
        unsafe { core::slice::from_raw_parts(table.start as *const u8, table.length) };
    let mut cursor = table.start.checked_add(table.length).ok_or(Errno::EFAULT)?;
    for entry in table_bytes.chunks_exact(size_of::<KernelIovecWire>()) {
        let base = read_wire_u32(entry, offset_of!(KernelIovecWire, base))? as usize;
        let length = read_wire_u32(entry, offset_of!(KernelIovecWire, len))? as usize;
        if base != cursor {
            return Err(Errno::EFAULT);
        }
        region.checked_range(base, length)?;
        cursor = align_up(
            base.checked_add(length).ok_or(Errno::EFAULT)?,
            KERNEL_WIRE_ALIGNMENT,
        )?;
        if cursor > region.end()? {
            return Err(Errno::EFAULT);
        }
    }
    Ok(validated)
}

fn read_wire_u32(bytes: &[u8], offset: usize) -> Result<u32, Errno> {
    let end = offset.checked_add(size_of::<u32>()).ok_or(Errno::EFAULT)?;
    let bytes = bytes.get(offset..end).ok_or(Errno::EFAULT)?;
    Ok(u32::from_le_bytes(
        bytes.try_into().map_err(|_| Errno::EFAULT)?,
    ))
}

unsafe fn validate_message_layout(
    args: &[i64; 6],
    region: ChannelScratchRegion,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    let mut validated = ValidatedChannelScratchArgs::new();
    let header = checked_exact_range(
        &mut validated,
        args,
        1,
        region.start,
        size_of::<KernelMsghdrWire>(),
        region,
    )?;
    let header = unsafe { core::slice::from_raw_parts(header.start as *const u8, header.length) };
    unsafe { validate_message_wire_layout(header, region) }?;
    Ok(validated)
}

/// Validate the nested extents described by one canonical message header.
///
/// Keeping this separate from the outer header-range proof lets native tests
/// exercise wasm32 wire addresses without requiring the test allocator itself
/// to return an address below 4 GiB.
///
/// # Safety
///
/// When the header describes one iovec, that iovec must name readable memory
/// for the complete `KernelIovecWire` after this function proves its range.
unsafe fn validate_message_wire_layout(
    header: &[u8],
    region: ChannelScratchRegion,
) -> Result<(), Errno> {
    if header.len() != size_of::<KernelMsghdrWire>() {
        return Err(Errno::EFAULT);
    }
    let name = read_wire_u32(header, offset_of!(KernelMsghdrWire, name))? as usize;
    let name_len = read_wire_u32(header, offset_of!(KernelMsghdrWire, name_len))? as usize;
    let iov = read_wire_u32(header, offset_of!(KernelMsghdrWire, iov))? as usize;
    let iov_len = read_wire_u32(header, offset_of!(KernelMsghdrWire, iov_len))? as usize;
    let control = read_wire_u32(header, offset_of!(KernelMsghdrWire, control))? as usize;
    let control_len = read_wire_u32(header, offset_of!(KernelMsghdrWire, control_len))? as usize;

    let mut cursor = region
        .start
        .checked_add(size_of::<KernelMsghdrWire>())
        .ok_or(Errno::EFAULT)?;
    let mut append = |pointer: usize, length: usize| -> Result<(), Errno> {
        if length == 0 {
            // A null pointer means the optional field is absent. The current
            // cursor is the one canonical allocation-owned zero-capacity
            // address and preserves presence without lending any bytes.
            return if pointer == 0 || pointer == cursor {
                Ok(())
            } else {
                Err(Errno::EFAULT)
            };
        }
        if pointer != cursor {
            return Err(Errno::EFAULT);
        }
        region.checked_range(pointer, length)?;
        cursor = align_up(
            pointer.checked_add(length).ok_or(Errno::EFAULT)?,
            KERNEL_WIRE_ALIGNMENT,
        )?;
        if cursor > region.end()? {
            return Err(Errno::EFAULT);
        }
        Ok(())
    };

    append(name, name_len)?;
    append(control, control_len)?;
    if iov_len > wasm_posix_shared::socket::KERNEL_MESSAGE_WIRE_FLATTENED_IOVEC_COUNT as usize {
        return Err(Errno::EINVAL);
    }
    let iov_bytes = iov_len
        .checked_mul(size_of::<KernelIovecWire>())
        .ok_or(Errno::EINVAL)?;
    append(iov, iov_bytes)?;
    if iov_len == 1 {
        let iovec =
            unsafe { core::slice::from_raw_parts(iov as *const u8, size_of::<KernelIovecWire>()) };
        let base = read_wire_u32(iovec, offset_of!(KernelIovecWire, base))? as usize;
        let length = read_wire_u32(iovec, offset_of!(KernelIovecWire, len))? as usize;
        if length == 0 {
            if base != 0 {
                return Err(Errno::EFAULT);
            }
        } else {
            append(base, length)?;
        }
    }
    Ok(())
}

fn validate_select_layout(
    args: &[i64; 6],
    region: ChannelScratchRegion,
    has_mask: bool,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    let mut validated = ValidatedChannelScratchArgs::new();
    let fd_set_bytes = wasm_posix_shared::select::FD_SET_BYTES;
    for index in 1usize..=3 {
        let offset = (index - 1).checked_mul(fd_set_bytes).ok_or(Errno::EFAULT)?;
        checked_nullable_exact_range(
            &mut validated,
            args,
            index,
            region.start.checked_add(offset).ok_or(Errno::EFAULT)?,
            fd_set_bytes,
            region,
        )?;
    }
    if has_mask {
        let mask_pointer = region
            .start
            .checked_add(3 * fd_set_bytes)
            .ok_or(Errno::EFAULT)?;
        checked_nullable_exact_range(
            &mut validated,
            args,
            5,
            mask_pointer,
            kernel_scratch_wire::SIGNAL_MASK_BYTES as usize,
            region,
        )?;
    }
    Ok(validated)
}

fn validate_ioctl_layout(
    args: &[i64; 6],
    region: ChannelScratchRegion,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    use wasm_posix_shared::ioctl_contract::IoctlArgKind;

    let mut validated = ValidatedChannelScratchArgs::new();
    let request = args[1] as u32;
    let Some(contract) = wasm_posix_shared::ioctl_contract::request_contract(request) else {
        return Ok(validated);
    };
    if contract.arg_kind != IoctlArgKind::Pointer {
        return Ok(validated);
    }
    let width = u8::try_from(args[5]).map_err(|_| Errno::EINVAL)?;
    let size = contract
        .size_for_pointer_width(width)
        .ok_or(Errno::EINVAL)? as usize;
    if checked_size_scalar(args[3])? != size {
        return Err(Errno::EINVAL);
    }
    checked_exact_range(&mut validated, args, 2, region.start, size, region)?;
    Ok(validated)
}

fn validate_ipc_control_layout(
    args: &[i64; 6],
    region: ChannelScratchRegion,
    syscall_number: u32,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    let mut validated = ValidatedChannelScratchArgs::new();
    let command = (args[1] as i32) & !0x100;
    if !matches!(command, 1 | 2) {
        validated.mark_null(2)?;
        return Ok(validated);
    }
    let width = u32::try_from(args[5]).map_err(|_| Errno::EINVAL)?;
    let size = if syscall_number == extended_syscalls::SYS_MSGCTL {
        crate::ipc_wire::msqid_ds_size(width)?
    } else {
        crate::ipc_wire::shmid_ds_size(width)?
    };
    checked_exact_range(&mut validated, args, 2, region.start, size, region)?;
    Ok(validated)
}

fn validate_special_layout(
    syscall_number: u32,
    args: &[i64; 6],
    region: ChannelScratchRegion,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    match syscall_number {
        number if number == Syscall::Fcntl as u32 => {
            let mut validated = ValidatedChannelScratchArgs::new();
            if matches!(args[1] as u32, 5 | 6 | 7 | 12 | 13 | 14 | 36 | 37 | 38) {
                checked_exact_range(
                    &mut validated,
                    args,
                    2,
                    region.start,
                    kernel_scratch_wire::FCNTL_FLOCK_BYTES as usize,
                    region,
                )?;
            }
            Ok(validated)
        }
        number if number == Syscall::Ioctl as u32 => validate_ioctl_layout(args, region),
        number
            if matches!(
                number,
                x if x == Syscall::Writev as u32
                    || x == Syscall::Readv as u32
                    || x == extended_syscalls::SYS_PREADV
                    || x == extended_syscalls::SYS_PWRITEV
                    || x == extended_syscalls::SYS_PREADV2
                    || x == extended_syscalls::SYS_PWRITEV2
            ) =>
        unsafe { validate_iovec_layout(args, region) },
        number if number == Syscall::Sendmsg as u32 || number == Syscall::Recvmsg as u32 => unsafe {
            validate_message_layout(args, region)
        },
        number if number == Syscall::Getgroups as u32 => {
            let mut validated = ValidatedChannelScratchArgs::new();
            let count = checked_size_scalar(args[0])?;
            if count == 0 {
                if checked_pointer(args[1])? != 0 || args[2] != 0 {
                    return Err(Errno::EFAULT);
                }
                validated.mark_null(1)?;
            } else {
                if args[2] != size_of::<u32>() as i64 {
                    return Err(Errno::EINVAL);
                }
                checked_exact_range(
                    &mut validated,
                    args,
                    1,
                    region.start,
                    size_of::<u32>(),
                    region,
                )?;
            }
            Ok(validated)
        }
        number if number == Syscall::Select as u32 => validate_select_layout(args, region, false),
        extended_syscalls::SYS_PSELECT6 => validate_select_layout(args, region, true),
        extended_syscalls::SYS_MSGRCV | extended_syscalls::SYS_MSGSND => {
            if !matches!(args[5], 4 | 8) {
                return Err(Errno::EINVAL);
            }
            let payload = checked_size_scalar(args[2])?;
            let length = size_of::<WasmSysvMessageHeader>()
                .checked_add(payload)
                .ok_or(Errno::EINVAL)?;
            let mut validated = ValidatedChannelScratchArgs::new();
            checked_exact_range(&mut validated, args, 1, region.start, length, region)?;
            Ok(validated)
        }
        extended_syscalls::SYS_MSGCTL | extended_syscalls::SYS_SHMCTL => {
            validate_ipc_control_layout(args, region, syscall_number)
        }
        extended_syscalls::SYS_EPOLL_CTL => {
            let mut validated = ValidatedChannelScratchArgs::new();
            checked_nullable_exact_range(
                &mut validated,
                args,
                3,
                region.start,
                size_of::<WasmEpollEvent>(),
                region,
            )?;
            Ok(validated)
        }
        extended_syscalls::SYS_EPOLL_PWAIT | extended_syscalls::SYS_EPOLL_WAIT => {
            let count = checked_size_scalar(args[2])?;
            let length = count
                .checked_mul(size_of::<WasmEpollEvent>())
                .ok_or(Errno::EINVAL)?;
            let mut validated = ValidatedChannelScratchArgs::new();
            checked_exact_range(&mut validated, args, 1, region.start, length, region)?;
            if syscall_number == extended_syscalls::SYS_EPOLL_PWAIT {
                let mask_pointer = align_up(
                    region.start.checked_add(length).ok_or(Errno::EFAULT)?,
                    SCRATCH_ALIGNMENT,
                )?;
                checked_nullable_exact_range(
                    &mut validated,
                    args,
                    4,
                    mask_pointer,
                    kernel_scratch_wire::SIGNAL_MASK_BYTES as usize,
                    region,
                )?;
            }
            Ok(validated)
        }
        _ => Ok(ValidatedChannelScratchArgs::new()),
    }
}

fn validate_prctl_layout(
    args: &[i64; 6],
    region: ChannelScratchRegion,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    let mut validated = ValidatedChannelScratchArgs::new();
    if args[0] == i64::from(prctl::PR_SET_NAME) || args[0] == i64::from(prctl::PR_GET_NAME) {
        checked_exact_range(
            &mut validated,
            args,
            1,
            region.start,
            kernel_scratch_wire::PRCTL_NAME_BYTES as usize,
            region,
        )?;
    }
    Ok(validated)
}

/// Validate every ordinary descriptor-backed channel suballocation and the
/// reviewed nested/manual wire formats before syscall dispatch.
///
/// # Safety
///
/// `region` must describe the complete live kernel-owned allocation and no
/// concurrent host operation may replace its bytes during this call or the
/// immediately following synchronous dispatch.
pub(crate) unsafe fn validate_channel_scratch_arguments(
    syscall_number: u32,
    args: &[i64; 6],
    region: ChannelScratchRegion,
) -> Result<ValidatedChannelScratchArgs, Errno> {
    // PR_SET_NAME and PR_GET_NAME use arg 1 as the generated fixed-size name
    // pointer, while other prctl options use the same slot as a scalar. A
    // generic pointer descriptor would either dereference a scalar or fail to
    // prove the name allocation, so keep this option-dependent contract
    // explicit.
    if syscall_number == extended_syscalls::SYS_PRCTL {
        return validate_prctl_layout(args, region);
    }
    if let Ok(index) = SYSCALL_ARG_DESCRIPTORS
        .binary_search_by_key(&syscall_number, |descriptor| descriptor.syscall_number)
    {
        return unsafe {
            validate_descriptor_layout(args, SYSCALL_ARG_DESCRIPTORS[index].args, region)
        };
    }
    validate_special_layout(syscall_number, args, region)
}

/// Compute the length of a bounded, null-terminated C string in kernel memory.
///
/// The host stages channel strings into a live kernel-owned allocation before
/// synchronous dispatch. This scanner proves the exact remaining allocation
/// capacity before each dereference; semantic limits such as `PATH_MAX` remain
/// the responsibility of the syscall consuming the string.
///
/// # Safety
///
/// `region` must describe the live channel allocation for this synchronous
/// dispatch.
pub(crate) unsafe fn checked_cstr_len(
    ptr: *const u8,
    region: ChannelScratchRegion,
) -> Result<u32, Errno> {
    let remaining = region.remaining_from(ptr as usize)?;
    for len in 0..remaining {
        if unsafe { *ptr.add(len) } == 0 {
            return u32::try_from(len).map_err(|_| Errno::EFAULT);
        }
    }
    Err(Errno::EFAULT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use wasm_posix_shared::platform_limits;

    fn pointer_arg(pointer: usize) -> i64 {
        i64::try_from(pointer).expect("native test pointer fits widened channel slot")
    }

    #[test]
    fn checked_range_accepts_exact_end_and_rejects_capacity_plus_one() {
        let region = ChannelScratchRegion::new(0x1000, 16).unwrap();
        assert_eq!(
            region.checked_range(0x1008, 8),
            Ok(ChannelScratchRange {
                start: 0x1008,
                length: 8,
            }),
        );
        assert_eq!(region.checked_range(0x1008, 9), Err(Errno::EFAULT));
        assert_eq!(region.checked_range(usize::MAX, 1), Err(Errno::EFAULT));
        assert_eq!(region.checked_range(0x1010, 0).unwrap().length, 0);
    }

    #[test]
    fn checked_start_range_requires_the_owned_base_and_explicit_capacity() {
        let region = ChannelScratchRegion::new(0x1000, 16).unwrap();
        assert_eq!(
            region.checked_start_range(0x1000, 16),
            Ok(ChannelScratchRange {
                start: 0x1000,
                length: 16,
            }),
        );
        assert_eq!(
            region.checked_start_range(0x1000, 17),
            Err(Errno::EFAULT),
        );
        assert_eq!(
            region.checked_start_range(0x1001, 15),
            Err(Errno::EFAULT),
        );
        assert_eq!(region.checked_start_range(0, 0), Err(Errno::EFAULT));
    }

    #[test]
    fn dynamic_buffers_reject_positive_null_and_canonicalize_empty_null() {
        let bytes = vec![0u8; 16];
        let start = bytes.as_ptr() as usize;
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();

        for syscall in [Syscall::Read as u32, Syscall::Write as u32] {
            let mut positive = [0i64; 6];
            positive[2] = 1;
            assert_eq!(
                unsafe { validate_channel_scratch_arguments(syscall, &positive, region) },
                Err(Errno::EFAULT),
            );

            let empty = [0i64; 6];
            let validated =
                unsafe { validate_channel_scratch_arguments(syscall, &empty, region) }.unwrap();
            assert_eq!(validated.pointer(1), Ok(start));
        }
    }

    #[test]
    fn zero_iovec_count_ignores_pointer_without_reading_it() {
        let bytes = [0u8; 1];
        let region = ChannelScratchRegion::new(bytes.as_ptr() as usize, bytes.len()).unwrap();
        for ignored_pointer in [0, i64::MIN, -1] {
            let mut args = [0i64; 6];
            args[1] = ignored_pointer;
            args[2] = 0;
            let validated = unsafe { validate_iovec_layout(&args, region) }.unwrap();
            assert_eq!(validated.pointer(1), Ok(0));
        }

        let mut args = [0i64; 6];
        args[2] = -1;
        assert_eq!(
            unsafe { validate_iovec_layout(&args, region) },
            Err(Errno::EINVAL),
        );
        args[2] = i64::try_from(platform_limits::IOV_MAX + 1).unwrap();
        assert_eq!(
            unsafe { validate_iovec_layout(&args, region) },
            Err(Errno::EINVAL),
        );
    }

    #[test]
    fn message_layout_distinguishes_absent_and_present_zero_capacity_names() {
        let start = 0x1000usize;
        let header_size = size_of::<KernelMsghdrWire>();
        let region = ChannelScratchRegion::new(start, header_size).unwrap();
        let canonical_zero_extent = start.checked_add(header_size).unwrap();
        let mut header = vec![0u8; header_size];

        let set_name = |header: &mut [u8], pointer: usize| {
            let pointer = u32::try_from(pointer).unwrap().to_le_bytes();
            let offset = offset_of!(KernelMsghdrWire, name);
            header[offset..offset + pointer.len()].copy_from_slice(&pointer);
        };

        // Both sendmsg and recvmsg use this canonical nested-wire validator.
        // Null encodes absence, while the current checked cursor encodes a
        // present output field whose caller capacity is exactly zero.
        set_name(&mut header, 0);
        assert!(unsafe { validate_message_wire_layout(&header, region) }.is_ok());

        set_name(&mut header, canonical_zero_extent);
        assert!(unsafe { validate_message_wire_layout(&header, region) }.is_ok());

        set_name(&mut header, canonical_zero_extent + 1);
        assert_eq!(
            unsafe { validate_message_wire_layout(&header, region) },
            Err(Errno::EFAULT),
        );
    }

    #[test]
    fn fixed_buffers_require_explicit_nullable_metadata() {
        let bytes = vec![0u8; 512];
        let start = bytes.as_ptr() as usize;
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();
        let args = [0i64; 6];

        for syscall in [Syscall::Pipe as u32, Syscall::Uname as u32] {
            assert_eq!(
                unsafe { validate_channel_scratch_arguments(syscall, &args, region) },
                Err(Errno::EFAULT),
            );
        }

        let nullable = unsafe {
            validate_channel_scratch_arguments(extended_syscalls::SYS_SENDFILE, &args, region)
        }
        .unwrap();
        assert_eq!(nullable.pointer(2), Ok(0));
    }

    #[test]
    fn prctl_proves_only_name_buffers_as_scratch() {
        let bytes = vec![0u8; kernel_scratch_wire::PRCTL_NAME_BYTES as usize];
        let start = bytes.as_ptr() as usize;
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();
        let mut args = [0i64; 6];
        args[0] = i64::from(prctl::PR_SET_NAME);
        args[1] = pointer_arg(start);

        let validated = unsafe {
            validate_channel_scratch_arguments(extended_syscalls::SYS_PRCTL, &args, region)
        }
        .unwrap();
        assert_eq!(validated.pointer(1), Ok(start));

        args[1] = 0;
        assert_eq!(
            unsafe {
                validate_channel_scratch_arguments(extended_syscalls::SYS_PRCTL, &args, region)
            },
            Err(Errno::EFAULT),
        );

        args[0] = 999;
        args[1] = i64::MAX;
        let scalar = unsafe {
            validate_channel_scratch_arguments(extended_syscalls::SYS_PRCTL, &args, region)
        }
        .unwrap();
        assert_eq!(scalar.pointer(1), Err(Errno::EFAULT));

        let short_region = ChannelScratchRegion::new(start, bytes.len() - 1).unwrap();
        args[0] = i64::from(prctl::PR_GET_NAME);
        args[1] = pointer_arg(start);
        assert_eq!(
            unsafe {
                validate_channel_scratch_arguments(
                    extended_syscalls::SYS_PRCTL,
                    &args,
                    short_region,
                )
            },
            Err(Errno::EFAULT),
        );
    }

    #[test]
    fn raw_channel_pointer_allowlist_contains_only_process_addresses() {
        let dispatcher = include_str!("wasm_api.rs");
        let channel_dispatch_source = dispatcher
            .split("#[cfg(test)]\nmod channel_pointer_tests")
            .next()
            .expect("channel pointer test boundary disappeared");

        assert!(
            !dispatcher.contains("channel_pointer!("),
            "ambiguous raw channel pointer bypasses the scratch proof"
        );

        // Pin every remaining direct widened-pointer normalization site in the
        // channel dispatcher. Command-dependent SEMCTL buffers must go through
        // the named allocation-start/range proof rather than adding another
        // raw `checked_channel_pointer(args[..])` call.
        for context in [
            "fn checked_channel_pointer(raw: i64) -> Result<usize, Errno> {",
            "let pointer = checked_channel_pointer(raw)?;",
            "checked_channel_pointer(channel_scalar::process_address_argument(",
            "match checked_channel_pointer(args[$index]) {",
        ] {
            assert_eq!(
                channel_dispatch_source.matches(context).count(),
                1,
                "reviewed direct channel-pointer context changed:\n{context}"
            );
        }
        assert_eq!(
            channel_dispatch_source
                .matches("checked_channel_pointer(")
                .count(),
            4,
            "review every new direct widened-channel pointer conversion"
        );
        // WHY: rustfmt may wrap the binding before `match`; normalize only
        // whitespace so this still pins the exact binding and proof helper.
        let normalized_channel_dispatch_source = channel_dispatch_source
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            normalized_channel_dispatch_source
                .matches("let values_pointer = match checked_channel_scratch_start_range(")
                .count(),
            1,
            "SEMCTL SETALL must prove the exact scratch allocation and range"
        );
        assert_eq!(
            normalized_channel_dispatch_source
                .matches("let output_pointer = match checked_channel_scratch_start_range(")
                .count(),
            2,
            "SEMCTL STAT/GETALL must prove the exact scratch allocation and range"
        );
        assert_eq!(
            channel_dispatch_source
                .matches("checked_channel_scratch_start_range(")
                .count(),
            4,
            "review every command-dependent scratch-start proof"
        );

        // WHY: a count alone lets a newly added raw pointer hide behind removal
        // of an existing use. Pin each reviewed process-address context, then
        // also pin the total so every addition, removal, or relocation requires
        // an explicit ownership review.
        let reviewed_process_address_contexts = [
            (
                "47 => kernel_munmap(process_address!(0), process_size!(1)), // SYS_MUNMAP",
                1,
            ),
            (
                "49 => kernel_mprotect(process_address!(0), process_size!(1), a3 as u32), // SYS_MPROTECT",
                1,
            ),
            (
                "128 => kernel_madvise(process_address!(0), process_size!(1), a3 as u32), // SYS_MADVISE",
                1,
            ),
            (
                r#"201 => kernel_clone(
            0,
            conditional_process_address!(1),
            a1 as u32,
            0,
            conditional_process_address!(2),
            conditional_process_address!(3),
            conditional_process_address!(4),"#,
                4,
            ),
            (
                r#"200 => kernel_futex(
            process_address!(0),
            a2 as u32,
            a3 as u32,
            a4 as u32,
            conditional_process_address!(4),"#,
                2,
            ),
            (
                "203 => kernel_set_tid_address(process_address!(0)), // SYS_SET_TID_ADDRESS",
                1,
            ),
            (
                "261 => kernel_set_robust_list(process_address!(0), process_size!(1)), // SYS_SET_ROBUST_LIST",
                1,
            ),
            (
                "262 => kernel_get_robust_list(a1 as u32, process_address!(1), process_address!(2)), // SYS_GET_ROBUST_LIST",
                2,
            ),
            (
                r#"let _shmaddr = conditional_process_address!(1);
            kernel_ipc_shmat(a1, a2, a3)"#,
                1,
            ),
            (
                r#"let _shmaddr = conditional_process_address!(0);
            kernel_ipc_shmdt(a1)"#,
                1,
            ),
            (
                r#"279 | 280 => {
            // mlock, mlock2: (addr, len, ...)
            let addr = process_address!(0);"#,
                1,
            ),
            (
                r#"281 => {
            // munlock: (addr, len)
            let addr = process_address!(0);"#,
                1,
            ),
            (
                r#"278 => {
            let _address = process_address!(0);
            let _length = process_size!(1);"#,
                1,
            ),
        ];

        let mut reviewed_uses = 0;
        for (context, expected_uses) in reviewed_process_address_contexts {
            assert_eq!(
                dispatcher.matches(context).count(),
                1,
                "reviewed raw process-address context changed:\n{context}"
            );
            reviewed_uses += expected_uses;
        }
        assert_eq!(
            dispatcher.matches("process_address!(").count(),
            reviewed_uses,
            "review every new raw process-address use; scratch must use a validated pointer macro"
        );
    }

    #[test]
    fn variable_io_adapters_are_not_public_bare_pointer_exports() {
        let wasm_api = include_str!("wasm_api.rs");
        for removed_function in [
            "fn kernel_read(",
            "fn kernel_write(",
            "fn kernel_pread(",
            "fn kernel_pwrite(",
            "fn kernel_readv(",
            "fn kernel_writev(",
            "fn kernel_preadv(",
            "fn kernel_pwritev(",
            "fn kernel_prepare_write_operation(",
        ] {
            assert!(
                !wasm_api.contains(removed_function),
                "variable I/O regained a pointer-only public adapter: {removed_function}",
            );
        }
        for required_private_adapter in [
            "fn channel_read(",
            "fn channel_write(",
            "fn channel_pread(",
            "fn channel_pwrite(",
            "fn channel_readv(",
            "fn channel_writev(",
            "fn channel_preadv(",
            "fn channel_pwritev(",
        ] {
            assert!(
                wasm_api.contains(required_private_adapter),
                "bounded private adapter disappeared: {required_private_adapter}",
            );
        }
    }

    #[test]
    fn descriptor_range_accepts_capacity_and_rejects_capacity_plus_one() {
        let bytes = vec![0u8; 16];
        let start = bytes.as_ptr() as usize;
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();
        let mut args = [0i64; 6];
        args[1] = pointer_arg(start);
        args[2] = bytes.len() as i64;

        let validated =
            unsafe { validate_channel_scratch_arguments(Syscall::Read as u32, &args, region) }
                .unwrap();
        assert_eq!(validated.pointer(1), Ok(start));

        args[2] += 1;
        assert_eq!(
            unsafe { validate_channel_scratch_arguments(Syscall::Read as u32, &args, region) },
            Err(Errno::EFAULT),
        );
    }

    #[test]
    fn descriptor_rejects_negative_and_overflowing_dynamic_lengths() {
        let bytes = vec![0u8; 16];
        let start = bytes.as_ptr() as usize;
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();
        let mut args = [0i64; 6];
        args[1] = pointer_arg(start);

        args[2] = -1;
        assert_eq!(
            unsafe { validate_channel_scratch_arguments(Syscall::Write as u32, &args, region) },
            Err(Errno::EINVAL),
        );
        args[2] = MAX_SAFE_INTEGER + 1;
        assert_eq!(
            unsafe { validate_channel_scratch_arguments(Syscall::Write as u32, &args, region) },
            Err(Errno::EINVAL),
        );
    }

    #[test]
    fn dereferenced_length_must_preserve_the_canonical_following_slot() {
        let mut bytes = vec![0u8; 64];
        let start = bytes.as_mut_ptr() as usize;
        assert_eq!(start % SCRATCH_ALIGNMENT, 0);
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();
        let mut args = [0i64; 6];
        args[1] = pointer_arg(start);
        args[2] = 16;
        args[4] = pointer_arg(start + 16);
        args[5] = pointer_arg(start + 24);
        bytes[24..28].copy_from_slice(&4u32.to_le_bytes());

        assert!(
            unsafe { validate_channel_scratch_arguments(Syscall::Recvfrom as u32, &args, region) }
                .is_ok()
        );

        // This models a second/torn socklen observation after the host sized
        // the address subregion. Growing across the alignment boundary moves
        // the canonical length slot and must be rejected before recvfrom can
        // form its output slice.
        bytes[24..28].copy_from_slice(&12u32.to_le_bytes());
        assert_eq!(
            unsafe { validate_channel_scratch_arguments(Syscall::Recvfrom as u32, &args, region) },
            Err(Errno::EFAULT),
        );
    }

    #[test]
    fn dereferenced_region_rejects_data_without_a_length_pointer() {
        let bytes = vec![0u8; 64];
        let start = bytes.as_ptr() as usize;
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();
        let mut args = [0i64; 6];
        args[1] = pointer_arg(start);
        args[2] = 8;
        args[4] = pointer_arg(start + 8);
        args[5] = 0;

        assert_eq!(
            unsafe { validate_channel_scratch_arguments(Syscall::Recvfrom as u32, &args, region) },
            Err(Errno::EFAULT),
        );
    }

    #[test]
    fn select_requires_each_nonnull_fdset_at_its_fixed_disjoint_slot() {
        let bytes = vec![0u8; 3 * wasm_posix_shared::select::FD_SET_BYTES];
        let start = bytes.as_ptr() as usize;
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();
        let mut args = [0i64; 6];
        args[1] = pointer_arg(start);
        args[2] = pointer_arg(start + wasm_posix_shared::select::FD_SET_BYTES);
        args[3] = pointer_arg(start + 2 * wasm_posix_shared::select::FD_SET_BYTES);

        assert!(
            unsafe { validate_channel_scratch_arguments(Syscall::Select as u32, &args, region) }
                .is_ok()
        );
        args[2] = args[1];
        assert_eq!(
            unsafe { validate_channel_scratch_arguments(Syscall::Select as u32, &args, region) },
            Err(Errno::EFAULT),
        );
    }

    #[test]
    fn cstr_accepts_a_nul_at_the_last_region_byte() {
        let bytes = b"abc\0";
        let region = ChannelScratchRegion::new(bytes.as_ptr() as usize, bytes.len()).unwrap();
        assert_eq!(unsafe { checked_cstr_len(bytes.as_ptr(), region) }, Ok(3));
    }

    #[test]
    fn cstr_does_not_read_a_sentinel_outside_the_region() {
        let bytes = b"ab\0";
        let shorter_region =
            ChannelScratchRegion::new(bytes.as_ptr() as usize, bytes.len() - 1).unwrap();
        assert_eq!(
            unsafe { checked_cstr_len(bytes.as_ptr(), shorter_region) },
            Err(Errno::EFAULT),
        );
    }

    #[test]
    fn cstr_rejects_pointers_outside_or_overflowing_the_region() {
        let bytes = b"abc\0";
        let start = bytes.as_ptr() as usize;
        let region = ChannelScratchRegion::new(start, bytes.len()).unwrap();

        assert_eq!(
            unsafe { checked_cstr_len(core::ptr::null(), region) },
            Err(Errno::EFAULT),
        );
        assert_eq!(
            unsafe { checked_cstr_len((start - 1) as *const u8, region) },
            Err(Errno::EFAULT),
        );
        assert_eq!(
            unsafe { checked_cstr_len((start + bytes.len()) as *const u8, region) },
            Err(Errno::EFAULT),
        );
        assert_eq!(
            unsafe { checked_cstr_len(usize::MAX as *const u8, region) },
            Err(Errno::EFAULT),
        );
        assert_eq!(ChannelScratchRegion::new(usize::MAX, 1), Err(Errno::EFAULT));
        assert_eq!(
            ChannelScratchRegion::for_channel(usize::MAX),
            Err(Errno::EFAULT),
        );
    }

    #[test]
    fn cstr_accepts_non_path_strings_larger_than_path_max() {
        let mut bytes = vec![b'a'; platform_limits::PATH_MAX_BYTES + 2];
        *bytes.last_mut().unwrap() = 0;
        let region = ChannelScratchRegion::new(bytes.as_ptr() as usize, bytes.len()).unwrap();

        assert_eq!(
            unsafe { checked_cstr_len(bytes.as_ptr(), region) },
            Ok((platform_limits::PATH_MAX_BYTES + 1) as u32),
        );
    }

    #[test]
    fn descriptor_cstr_bound_accepts_exact_capacity_and_rejects_capacity_plus_one() {
        let capacity = platform_limits::PROCESS_METADATA_ENTRY_MAX_BYTES + 1;
        let descriptor = SyscallArgDesc {
            arg_index: 0,
            direction: wasm_posix_shared::host_abi::SyscallArgDirection::In,
            size: SyscallArgSize::CString {
                max_bytes: capacity as u32,
                too_long_errno: Errno::E2BIG as u32,
            },
            nullable: false,
            required: true,
        };
        let mut exact = vec![b'a'; capacity];
        *exact.last_mut().unwrap() = 0;
        let exact_region =
            ChannelScratchRegion::new(exact.as_ptr() as usize, exact.len()).unwrap();
        let mut args = [0i64; 6];
        args[0] = pointer_arg(exact.as_ptr() as usize);
        assert_eq!(
            unsafe { descriptor_size(&descriptor, &args, exact_region) },
            Ok(capacity),
        );

        let mut oversized = vec![b'a'; capacity + 1];
        *oversized.last_mut().unwrap() = 0;
        let oversized_region =
            ChannelScratchRegion::new(oversized.as_ptr() as usize, oversized.len()).unwrap();
        args[0] = pointer_arg(oversized.as_ptr() as usize);
        assert_eq!(
            unsafe { descriptor_size(&descriptor, &args, oversized_region) },
            Err(Errno::E2BIG),
        );
    }
}
