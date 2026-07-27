//! Kernel-owned transport for one large host-mediated I/O operation.
//!
//! The ordinary syscall channel remains the cheap path. When a scalar or
//! vector I/O payload does not fit there, the host reserves this Rust-owned
//! region, copies at most its reported initialized capacity, and commits the
//! opaque token exactly once.

extern crate alloc;

use alloc::vec::Vec;
use core::mem;
use core::slice;
use spin::Mutex;
use wasm_posix_shared::{platform_limits, Errno};

/// Widened channels contain i64 fields and eight-byte-aligned companion
/// records. Backing the byte prefix with u64 words makes that base alignment
/// an owned allocation property rather than a dlmalloc implementation detail.
type TransferScratchWord = u64;
const TRANSFER_SCRATCH_WORD_BYTES: usize = core::mem::size_of::<TransferScratchWord>();
const TRANSFER_SCRATCH_ALIGNMENT: usize = core::mem::align_of::<TransferScratchWord>();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TransferIoOperation {
    Read,
    Write,
    Pread,
    Pwrite,
}

pub(crate) fn io_operation_for_syscall(
    original_syscall: u32,
) -> Result<TransferIoOperation, Errno> {
    use wasm_posix_shared::Syscall;
    use wasm_posix_shared::abi::extended_syscalls;

    match original_syscall {
        number if number == Syscall::Read as u32 || number == Syscall::Readv as u32 => {
            Ok(TransferIoOperation::Read)
        }
        number if number == Syscall::Write as u32 || number == Syscall::Writev as u32 => {
            Ok(TransferIoOperation::Write)
        }
        number
            if number == Syscall::Pread as u32
                || number == extended_syscalls::SYS_PREADV
                || number == extended_syscalls::SYS_PREADV2 =>
        {
            Ok(TransferIoOperation::Pread)
        }
        number
            if number == Syscall::Pwrite as u32
                || number == extended_syscalls::SYS_PWRITEV
                || number == extended_syscalls::SYS_PWRITEV2 =>
        {
            Ok(TransferIoOperation::Pwrite)
        }
        _ => Err(Errno::EINVAL),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TransferScratchState {
    Idle,
    Reserved { token: i64 },
    Executing { token: i64 },
    Ready { token: i64 },
}

struct TransferScratch {
    state: TransferScratchState,
    words: Vec<TransferScratchWord>,
    authorized_bytes: usize,
    next_token: Option<i64>,
}

impl TransferScratch {
    const fn new() -> Self {
        Self {
            state: TransferScratchState::Idle,
            words: Vec::new(),
            authorized_bytes: 0,
            next_token: Some(1),
        }
    }

    fn begin(&mut self, minimum_capacity: usize) -> Result<i64, Errno> {
        self.begin_with_reserve(minimum_capacity, |words, additional| {
            words
                .try_reserve_exact(additional)
                .map_err(|_| Errno::ENOMEM)
        })
    }

    fn begin_with_reserve(
        &mut self,
        minimum_capacity: usize,
        reserve: impl FnOnce(
            &mut Vec<TransferScratchWord>,
            usize,
        ) -> Result<(), Errno>,
    ) -> Result<i64, Errno> {
        if minimum_capacity == 0
            || minimum_capacity > platform_limits::MAX_TRANSFER_ALLOCATION_BYTES
        {
            return Err(Errno::EINVAL);
        }
        if !matches!(self.state, TransferScratchState::Idle) {
            return Err(Errno::EBUSY);
        }

        let token = self.next_token.ok_or(Errno::EOVERFLOW)?;
        let complete_words = minimum_capacity / TRANSFER_SCRATCH_WORD_BYTES;
        let word_count = complete_words
            .checked_add(usize::from(
                minimum_capacity % TRANSFER_SCRATCH_WORD_BYTES != 0,
            ))
            .ok_or(Errno::EINVAL)?;
        let mut words = Vec::new();
        reserve(&mut words, word_count)?;
        if words.capacity() < word_count {
            return Err(Errno::ENOMEM);
        }
        // WHY: initialize all rounded backing words so constructing the exact
        // authorized byte prefix is sound. Spare Vec capacity remains
        // uninitialized and is never exposed to the host.
        words.resize(word_count, 0);

        self.words = words;
        self.authorized_bytes = minimum_capacity;
        self.state = TransferScratchState::Reserved { token };
        self.next_token = token.checked_add(1);
        Ok(token)
    }

    fn pointer(&mut self, token: i64) -> Result<usize, Errno> {
        if token <= 0 {
            return Err(Errno::EINVAL);
        }
        match self.state {
            TransferScratchState::Reserved { token: current } if current == token => {
                let pointer = self.words.as_mut_ptr() as usize;
                debug_assert_eq!(pointer % TRANSFER_SCRATCH_ALIGNMENT, 0);
                Ok(pointer)
            }
            TransferScratchState::Executing { token: current } if current == token => {
                Err(Errno::EBUSY)
            }
            _ => Err(Errno::EINVAL),
        }
    }

    fn capacity(&self, token: i64) -> Result<usize, Errno> {
        if token <= 0 {
            return Err(Errno::EINVAL);
        }
        match self.state {
            TransferScratchState::Reserved { token: current } if current == token => {
                Ok(self.authorized_bytes)
            }
            TransferScratchState::Executing { token: current } if current == token => {
                Err(Errno::EBUSY)
            }
            _ => Err(Errno::EINVAL),
        }
    }

    fn begin_execution(&mut self, token: i64) -> Result<(*mut u8, usize), Errno> {
        if token <= 0 {
            return Err(Errno::EINVAL);
        }

        let previous = mem::replace(&mut self.state, TransferScratchState::Idle);
        match previous {
            TransferScratchState::Reserved { token: current } if current == token => {
                self.state = TransferScratchState::Executing { token };
                let pointer = self.words.as_mut_ptr().cast::<u8>();
                debug_assert_eq!(
                    pointer as usize % TRANSFER_SCRATCH_ALIGNMENT,
                    0,
                );
                Ok((
                    pointer,
                    self.authorized_bytes,
                ))
            }
            other => {
                let error = match other {
                    TransferScratchState::Executing { token: current } if current == token => {
                        Errno::EBUSY
                    }
                    _ => Errno::EINVAL,
                };
                self.state = other;
                Err(error)
            }
        }
    }

    fn finish_execution(&mut self, token: i64) -> Result<(), Errno> {
        let previous = mem::replace(&mut self.state, TransferScratchState::Idle);
        match previous {
            TransferScratchState::Executing { token: current } if current == token => {
                self.state = TransferScratchState::Ready { token };
                Ok(())
            }
            other => {
                self.state = other;
                Err(Errno::EIO)
            }
        }
    }

    fn cancel(&mut self, token: i64) -> Result<(), Errno> {
        if token <= 0 {
            return Err(Errno::EINVAL);
        }

        let previous = mem::replace(&mut self.state, TransferScratchState::Idle);
        match previous {
            TransferScratchState::Reserved { token: current }
            | TransferScratchState::Ready { token: current }
                if current == token =>
            {
                // Dropping the Vec returns its allocation to the kernel
                // allocator. WebAssembly pages do not shrink, but a later
                // kernel allocation can reuse these heap bytes.
                drop(mem::take(&mut self.words));
                self.authorized_bytes = 0;
                Ok(())
            }
            other => {
                let error = match other {
                    TransferScratchState::Executing { token: current } if current == token => {
                        Errno::EBUSY
                    }
                    _ => Errno::EINVAL,
                };
                self.state = other;
                Err(error)
            }
        }
    }
}

struct GlobalTransferScratch {
    inner: Mutex<TransferScratch>,
}

impl GlobalTransferScratch {
    const fn new() -> Self {
        Self {
            inner: Mutex::new(TransferScratch::new()),
        }
    }

    fn begin(&self, minimum_capacity: usize) -> Result<i64, Errno> {
        self.inner
            .try_lock()
            .ok_or(Errno::EBUSY)?
            .begin(minimum_capacity)
    }

    fn pointer(&self, token: i64) -> Result<usize, Errno> {
        self.inner.try_lock().ok_or(Errno::EBUSY)?.pointer(token)
    }

    fn capacity(&self, token: i64) -> Result<usize, Errno> {
        self.inner.try_lock().ok_or(Errno::EBUSY)?.capacity(token)
    }

    fn cancel(&self, token: i64) -> Result<(), Errno> {
        // Cancellation mutates no external state and invokes no host code, so
        // waiting for this short critical section cannot reenter the mutex.
        // Once acquired it still rejects an Executing token without changing
        // or dropping the allocation.
        self.inner.lock().cancel(token)
    }

    fn execute_with(
        &self,
        token: i64,
        length: usize,
        operation: impl FnOnce(&mut [u8]) -> Result<usize, Errno>,
    ) -> Result<usize, Errno> {
        self.execute_initialized_with(token, |initialized| {
            if length > platform_limits::MAX_REPORTABLE_TRANSFER_BYTES {
                return Err(Errno::EINVAL);
            }
            if length > initialized.len() {
                return Err(Errno::E2BIG);
            }
            let result = operation(&mut initialized[..length]);
            match result {
                Ok(returned) if returned > length => Err(Errno::EIO),
                other => other,
            }
        })
    }

    /// Consume a token and lend its complete initialized allocation.
    ///
    /// Unlike scalar I/O, a widened channel publishes its syscall result in
    /// the channel header. The closure's `Result` is therefore transport
    /// status only and must not be confused with a byte count.
    fn execute_channel_with(
        &self,
        token: i64,
        operation: impl FnOnce(&mut [u8]) -> Result<(), Errno>,
    ) -> Result<(), Errno> {
        self.execute_initialized_with(token, operation)
    }

    fn execute_initialized_with<T>(
        &self,
        token: i64,
        operation: impl FnOnce(&mut [u8]) -> Result<T, Errno>,
    ) -> Result<T, Errno> {
        let (pointer, capacity) = self
            .inner
            .try_lock()
            .ok_or(Errno::EBUSY)?
            .begin_execution(token)?;

        // WHY: Executing forbids begin, query, cancellation, and another
        // execute, so no path can mutate, reallocate, or drop the Vec while
        // this stable pointer is in use. The mutex itself is released before
        // the syscall can invoke host code, preventing callback deadlock.
        let initialized = unsafe { slice::from_raw_parts_mut(pointer, capacity) };
        let result = operation(initialized);

        // Every ordinary Result path restores the stable allocation so the
        // host can read a completed read-family payload through the pointer it
        // obtained while Reserved, then cancel to drop it. A Wasm/host-import
        // trap cannot unwind to this point: Executing and its allocation are
        // intentionally irrecoverable in that case, and the host must
        // fail-stop the kernel instance rather than reuse uncertain bytes.
        self.inner.lock().finish_execution(token)?;
        result
    }
}

static TRANSFER_SCRATCH: GlobalTransferScratch = GlobalTransferScratch::new();

/// Begin one exclusive initialized host-write reservation.
pub fn begin_transfer_scratch(minimum_capacity: usize) -> Result<i64, Errno> {
    TRANSFER_SCRATCH.begin(minimum_capacity)
}

/// Pointer owned by exactly the Reserved token.
pub fn transfer_scratch_pointer(token: i64) -> Result<usize, Errno> {
    TRANSFER_SCRATCH.pointer(token)
}

/// Initialized writable byte capacity owned by exactly the Reserved token.
pub fn transfer_scratch_capacity(token: i64) -> Result<usize, Errno> {
    TRANSFER_SCRATCH.capacity(token)
}

/// Drop the allocation owned by exactly the Reserved or Ready token.
pub fn cancel_transfer_scratch(token: i64) -> Result<(), Errno> {
    TRANSFER_SCRATCH.cancel(token)
}

/// Consume one reservation and execute without holding the scratch mutex.
pub fn execute_transfer_with(
    token: i64,
    length: usize,
    operation: impl FnOnce(&mut [u8]) -> Result<usize, Errno>,
) -> Result<usize, Errno> {
    TRANSFER_SCRATCH.execute_with(token, length, operation)
}

/// Consume one reservation as a complete initialized widened channel.
pub fn execute_channel_transfer_with(
    token: i64,
    operation: impl FnOnce(&mut [u8]) -> Result<(), Errno>,
) -> Result<(), Errno> {
    TRANSFER_SCRATCH.execute_channel_with(token, operation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_vector_and_v2_syscalls_map_to_one_scalar_operation() {
        use wasm_posix_shared::Syscall;
        use wasm_posix_shared::abi::extended_syscalls;

        for syscall in [Syscall::Read as u32, Syscall::Readv as u32] {
            assert_eq!(
                io_operation_for_syscall(syscall),
                Ok(TransferIoOperation::Read),
            );
        }
        for syscall in [Syscall::Write as u32, Syscall::Writev as u32] {
            assert_eq!(
                io_operation_for_syscall(syscall),
                Ok(TransferIoOperation::Write),
            );
        }
        for syscall in [
            Syscall::Pread as u32,
            extended_syscalls::SYS_PREADV,
            extended_syscalls::SYS_PREADV2,
        ] {
            assert_eq!(
                io_operation_for_syscall(syscall),
                Ok(TransferIoOperation::Pread),
            );
        }
        for syscall in [
            Syscall::Pwrite as u32,
            extended_syscalls::SYS_PWRITEV,
            extended_syscalls::SYS_PWRITEV2,
        ] {
            assert_eq!(
                io_operation_for_syscall(syscall),
                Ok(TransferIoOperation::Pwrite),
            );
        }
        assert_eq!(io_operation_for_syscall(0), Err(Errno::EINVAL));
        assert_eq!(io_operation_for_syscall(u32::MAX), Err(Errno::EINVAL));
    }

    #[test]
    fn exact_capacity_executes_once_and_capacity_plus_one_does_not() {
        let scratch = GlobalTransferScratch::new();
        let token = scratch.begin(8).unwrap();
        assert_ne!(scratch.pointer(token).unwrap(), 0);
        assert_eq!(scratch.capacity(token), Ok(8));

        let mut calls = 0;
        assert_eq!(
            scratch.execute_with(token, 8, |bytes| {
                calls += 1;
                bytes.copy_from_slice(b"complete");
                Ok(bytes.len())
            }),
            Ok(8),
        );
        assert_eq!(calls, 1);
        assert_eq!(scratch.pointer(token), Err(Errno::EINVAL));
        assert_eq!(scratch.capacity(token), Err(Errno::EINVAL));
        assert_eq!(
            scratch.execute_with(token, 8, |_| Ok(0)),
            Err(Errno::EINVAL)
        );
        scratch.cancel(token).unwrap();

        let overflow = scratch.begin(8).unwrap();
        assert_eq!(
            scratch.execute_with(overflow, 9, |_| {
                calls += 1;
                Ok(0)
            }),
            Err(Errno::E2BIG),
        );
        assert_eq!(calls, 1);
        scratch.cancel(overflow).unwrap();

        let impossible = scratch.begin(8).unwrap();
        assert_eq!(
            scratch.execute_with(impossible, 8, |_| Ok(9)),
            Err(Errno::EIO),
        );
        scratch.cancel(impossible).unwrap();
    }

    #[test]
    fn every_authorized_byte_prefix_has_an_explicitly_aligned_base() {
        for capacity in [1, 7, 8, 9, 65_609] {
            let scratch = GlobalTransferScratch::new();
            let token = scratch.begin(capacity).unwrap();
            assert_eq!(
                scratch.pointer(token).unwrap() % TRANSFER_SCRATCH_ALIGNMENT,
                0,
            );
            assert_eq!(scratch.capacity(token), Ok(capacity));
            scratch.cancel(token).unwrap();
        }
    }

    #[test]
    fn channel_execution_lends_the_complete_initialized_extent_once() {
        let scratch = GlobalTransferScratch::new();
        let token = scratch.begin(65_609).unwrap();
        let mut calls = 0;
        assert_eq!(
            scratch.execute_channel_with(token, |bytes| {
                calls += 1;
                assert_eq!(bytes.len(), 65_609);
                bytes[0] = 0xa5;
                bytes[65_608] = 0x5a;
                Ok(())
            }),
            Ok(()),
        );
        assert_eq!(calls, 1);
        assert_eq!(scratch.execute_channel_with(token, |_| Ok(())), Err(Errno::EINVAL));
        scratch.cancel(token).unwrap();
    }

    #[test]
    fn reserve_failure_preserves_idle_state_and_token() {
        let mut scratch = TransferScratch::new();
        assert_eq!(
            scratch.begin_with_reserve(65_537, |bytes, requested| {
                assert!(bytes.is_empty());
                assert_eq!(requested, 8_193);
                Err(Errno::ENOMEM)
            }),
            Err(Errno::ENOMEM),
        );
        assert!(matches!(scratch.state, TransferScratchState::Idle));
        assert_eq!(scratch.next_token, Some(1));

        assert_eq!(
            scratch.begin_with_reserve(4, |_, _| Ok(())),
            Err(Errno::ENOMEM),
            "a reserve implementation that reports success without capacity fails closed",
        );
        assert!(matches!(scratch.state, TransferScratchState::Idle));
        assert_eq!(scratch.next_token, Some(1));

        let token = scratch.begin(1).unwrap();
        assert_eq!(token, 1);
        scratch.cancel(token).unwrap();
    }

    #[test]
    fn u32_max_authorized_bytes_reaches_the_fallible_word_reserver() {
        let mut scratch = TransferScratch::new();
        let maximum = platform_limits::MAX_TRANSFER_ALLOCATION_BYTES;
        let expected_words = maximum / TRANSFER_SCRATCH_WORD_BYTES
            + usize::from(maximum % TRANSFER_SCRATCH_WORD_BYTES != 0);
        let mut reserve_called = false;

        assert_eq!(
            scratch.begin_with_reserve(maximum, |words, requested_words| {
                reserve_called = true;
                assert!(words.is_empty());
                assert_eq!(requested_words, expected_words);
                Err(Errno::ENOMEM)
            }),
            Err(Errno::ENOMEM),
        );
        assert!(reserve_called);
        assert!(matches!(scratch.state, TransferScratchState::Idle));
        assert_eq!(scratch.next_token, Some(1));
    }

    #[test]
    fn overlap_stale_tokens_and_invalid_sizes_fail_closed() {
        let scratch = GlobalTransferScratch::new();
        assert_eq!(scratch.begin(0), Err(Errno::EINVAL));
        assert_eq!(
            scratch.begin(
                platform_limits::MAX_TRANSFER_ALLOCATION_BYTES
                    .saturating_add(1),
            ),
            Err(Errno::EINVAL)
        );

        let first = scratch.begin(4).unwrap();
        assert_eq!(scratch.begin(4), Err(Errno::EBUSY));
        assert_eq!(scratch.pointer(0), Err(Errno::EINVAL));
        assert_eq!(scratch.capacity(-1), Err(Errno::EINVAL));
        assert_eq!(scratch.cancel(first + 1), Err(Errno::EINVAL));
        assert_eq!(
            scratch.execute_with(first + 1, 4, |_| Ok(0)),
            Err(Errno::EINVAL)
        );
        scratch.cancel(first).unwrap();

        let second = scratch.begin(4).unwrap();
        assert!(second > first);
        assert_eq!(scratch.cancel(first), Err(Errno::EINVAL));
        scratch.cancel(second).unwrap();
    }

    #[test]
    fn exhausted_token_space_fails_before_reserving_another_allocation() {
        let mut scratch = TransferScratch::new();
        scratch.next_token = Some(i64::MAX);
        let final_token = scratch.begin(1).unwrap();
        assert_eq!(final_token, i64::MAX);
        scratch.cancel(final_token).unwrap();

        let mut reserve_called = false;
        assert_eq!(
            scratch.begin_with_reserve(1, |_, _| {
                reserve_called = true;
                Ok(())
            }),
            Err(Errno::EOVERFLOW),
        );
        assert!(!reserve_called);
        assert!(matches!(scratch.state, TransferScratchState::Idle));
        assert!(scratch.words.is_empty());
        assert_eq!(scratch.authorized_bytes, 0);
    }

    #[test]
    fn channel_metadata_does_not_reduce_the_scalar_payload_ceiling() {
        let allocation = platform_limits::MAX_REPORTABLE_TRANSFER_BYTES
            .checked_add(wasm_posix_shared::channel::DATA_OFFSET)
            .and_then(|value| value.checked_add(7))
            .unwrap();
        assert!(
            allocation <= platform_limits::MAX_TRANSFER_ALLOCATION_BYTES,
        );

        let scratch = GlobalTransferScratch::new();
        let token = scratch.begin(16).unwrap();
        assert_eq!(
            scratch.execute_with(
                token,
                platform_limits::MAX_REPORTABLE_TRANSFER_BYTES + 1,
                |_| Ok(0),
            ),
            Err(Errno::EINVAL),
        );
        scratch.cancel(token).unwrap();
    }

    #[test]
    fn queries_and_execution_fail_closed_during_lock_contention() {
        let scratch = GlobalTransferScratch::new();
        let token = scratch.begin(4).unwrap();
        let guard = scratch.inner.lock();
        assert_eq!(scratch.begin(4), Err(Errno::EBUSY));
        assert_eq!(scratch.pointer(token), Err(Errno::EBUSY));
        assert_eq!(scratch.capacity(token), Err(Errno::EBUSY));
        assert_eq!(scratch.execute_with(token, 4, |_| Ok(4)), Err(Errno::EBUSY),);
        drop(guard);
        scratch.cancel(token).unwrap();
    }

    #[test]
    fn cancel_waits_for_short_contention_then_drops_reserved_allocation() {
        use std::sync::{Arc, mpsc};
        use std::time::Duration;

        let scratch = Arc::new(GlobalTransferScratch::new());
        let token = scratch.begin(4).unwrap();
        let guard = scratch.inner.lock();
        let (started_tx, started_rx) = mpsc::sync_channel(0);
        let (result_tx, result_rx) = mpsc::sync_channel(0);
        let cancel_scratch = Arc::clone(&scratch);
        let cancel_thread = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            result_tx.send(cancel_scratch.cancel(token)).unwrap();
        });

        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(
            result_rx.recv_timeout(Duration::from_millis(50)).is_err(),
            "cancel must not report a transient lock-contention failure",
        );
        drop(guard);
        assert_eq!(
            result_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ok(()),
        );
        cancel_thread.join().unwrap();
        let inner = scratch.inner.lock();
        assert_eq!(inner.state, TransferScratchState::Idle);
        assert!(inner.words.is_empty());
        assert_eq!(inner.authorized_bytes, 0);
    }

    #[test]
    fn executing_rejects_reentrant_access_and_normal_error_becomes_ready() {
        let scratch = GlobalTransferScratch::new();
        let token = scratch.begin(4).unwrap();
        assert_eq!(
            scratch.execute_with(token, 4, |_| {
                assert_eq!(scratch.begin(1), Err(Errno::EBUSY));
                assert_eq!(scratch.pointer(token), Err(Errno::EBUSY));
                assert_eq!(scratch.capacity(token), Err(Errno::EBUSY));
                assert_eq!(scratch.cancel(token), Err(Errno::EBUSY));
                assert_eq!(scratch.execute_with(token, 4, |_| Ok(0)), Err(Errno::EBUSY));
                Err(Errno::EBADF)
            }),
            Err(Errno::EBADF),
        );
        scratch.cancel(token).unwrap();
    }

    #[test]
    fn sequential_operations_use_fresh_allocations_and_monotonic_tokens() {
        let scratch = GlobalTransferScratch::new();
        let first = scratch.begin(3).unwrap();
        assert_eq!(scratch.execute_with(first, 3, |_| Ok(3)), Ok(3));
        scratch.cancel(first).unwrap();

        let second = scratch.begin(7).unwrap();
        assert!(second > first);
        assert_eq!(scratch.capacity(second), Ok(7));
        assert_eq!(scratch.execute_with(second, 7, |_| Ok(7)), Ok(7));
        scratch.cancel(second).unwrap();
    }

    #[test]
    fn panic_leaves_executing_token_irrecoverable_for_fail_stop() {
        use std::panic::{AssertUnwindSafe, catch_unwind};

        let scratch = GlobalTransferScratch::new();
        let token = scratch.begin(4).unwrap();
        let trapped = catch_unwind(AssertUnwindSafe(|| {
            let _ = scratch.execute_with(token, 4, |_| -> Result<usize, Errno> {
                panic!("simulated host-import trap");
            });
        }));
        assert!(trapped.is_err());
        assert_eq!(scratch.cancel(token), Err(Errno::EBUSY));
        assert_eq!(scratch.begin(4), Err(Errno::EBUSY));
        let inner = scratch.inner.lock();
        assert_eq!(
            inner.state,
            TransferScratchState::Executing { token },
            "trap poisons the token",
        );
        assert_eq!(
            inner.authorized_bytes,
            4,
            "kernel retains ownership until the failed instance is discarded",
        );
    }
}
