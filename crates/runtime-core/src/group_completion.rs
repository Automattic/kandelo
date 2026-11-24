//! Exact grouped syscall outcomes retained by the actual ProcessTable.
//! Native observations only report settlement; they grant no publication right.
use crate::{
    io_buffer::IO_MEMORY,
    memory_group::{
        physical::HostMemory,
        storage::{ProgressTarget, ProgressWait, completion::PublicationFailure},
    },
    prepared_map::{MapMemory, PreparedMap, PreparedMapSlot},
    process::{HostIO, ProcessState},
    process_table::ProcessTable,
};
use wasm_posix_shared::group_storage::status as S;
use wasm_posix_shared::{ChannelStatus, Errno, Syscall, channel as C, memory_group::ReceiptRecord};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Key(u32, u64);
impl MapMemory for Key {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Captured,
    Ready,
    Published,
    Discarded,
    Fatal,
}
#[derive(Clone, Copy)]
struct Call {
    token: u64,
    syscall: u32,
    flags: u32,
    phase: Phase,
    value: i64,
    errno: u32,
    wait: Option<ProgressWait>,
    relisten: bool,
    terminal: bool,
    dispatched: bool,
}
#[derive(Clone, Copy)]
struct Binding {
    receipt: ReceiptRecord,
    channel: u32,
    detached: bool,
    natural_exit: bool,
    process_exit: bool,
    exec_retired: bool,
    signal: Option<crate::process_wire::SignalDeliveryRecord>,
    signal_written: bool,
    fatal: bool,
    interrupt: bool,
    call: Option<Call>,
}
impl MapMemory for Binding {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}
pub(crate) struct Completions {
    bindings: PreparedMap<Key, Binding>,
    next: u64,
}
impl Completions {
    pub(crate) const fn new() -> Self {
        Self {
            bindings: PreparedMap::new(),
            next: 1,
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Captured {
    pub token: u64,
    pub syscall: u32,
    pub flags: u32,
    pub invalid: bool,
    pub automatic: bool,
}
#[derive(Clone, Copy, Debug)]
pub enum Effect {
    Captured,
    Dispatch,
    InterruptTransport {
        receipt: ReceiptRecord,
        channel: u32,
        token: u64,
    },
    WaitStopped,
    Observe {
        resource: u64,
        wait: ProgressWait,
    },
    CancelObservation {
        resource: u64,
        wait: ProgressWait,
    },
    Published {
        relisten: bool,
        terminal: bool,
    },
    Discarded,
    Fatal,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NativeStart { Ready, Stopped, Dead }
impl ProcessTable {
    fn completion_binding(&self, receipt: ReceiptRecord) -> Result<Binding, Errno> {
        let binding = *self
            .group_completions_ref()
            .bindings
            .get(&Key(receipt.group, receipt.serial))
            .ok_or(Errno::ESRCH)?;
        if binding.receipt != receipt {
            return Err(Errno::ESRCH);
        }
        Ok(binding)
    }
    fn set_completion_binding(&mut self, binding: Binding) {
        *self
            .group_completions()
            .bindings
            .get_mut(&Key(binding.receipt.group, binding.receipt.serial))
            .unwrap() = binding;
    }
    /// Called only after the physical owner has released the exact task or
    /// image. Active calls prevent that release independently of native pins.
    /// Metadata must not depend on a later JavaScript DETACH callback.
    pub(crate) fn forget_released_group_completions(
        &mut self,
        receipt: ReceiptRecord,
        image: bool,
    ) {
        self.group_completions().bindings.retain(|_, binding| {
            let selected = if image {
                binding.receipt.group == receipt.group
                    && binding.receipt.pid == receipt.pid
                    && binding.receipt.generation == receipt.generation
            } else {
                binding.receipt == receipt
            };
            if selected {
                assert!(
                    binding.call.is_none(),
                    "physical release bypassed retained completion"
                );
            }
            !selected
        });
    }

    pub fn release_group_storage_image(
        &mut self,
        receipt: ReceiptRecord,
        host: &mut dyn HostIO,
    ) -> Result<crate::memory_group::StorageReply, Errno> {
        let reply = self.memory_groups().storage_action(
            receipt,
            wasm_posix_shared::group_storage::Action::ReleaseStoppedImage,
            0,
            0,
            host,
        )?;
        self.forget_released_group_completions(receipt, true);
        Ok(reply)
    }
    pub fn bind_group_completion_channel(
        &mut self,
        receipt: ReceiptRecord,
        channel: u32,
    ) -> Result<(), Errno> {
        let admission = self.memory_group_task(receipt.pid, receipt.tid)?.ok_or(Errno::ESRCH)?;
        let process = self.get(receipt.pid).ok_or(Errno::ESRCH)?;
        if process.pointer_width != 4 || process.vfork_child { return Err(Errno::EOPNOTSUPP); }
        if admission.record() != receipt || self.group_task_channel(receipt)? != channel
            || (self.memory_group_running_admission(admission).is_err()
                && self.memory_group_prepared_admission(admission.execution()).ok() != Some(admission)) {
            return Err(Errno::ESRCH);
        }
        let key = Key(receipt.group, receipt.serial);
        if let Some(binding) = self.group_completions_ref().bindings.get(&key) {
            return if binding.receipt == receipt && binding.channel == channel && !binding.detached
            {
                Ok(())
            } else {
                Err(Errno::EBUSY)
            };
        }
        let prepared = PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(
            key,
            Binding {
                receipt,
                channel,
                detached: false,
                natural_exit: false,
                process_exit: false,
                exec_retired: false,
                signal: None,
                signal_written: false,
                fatal: false,
                interrupt: false,
                call: None,
            },
        )?;
        self.group_completions().bindings.publish_io(prepared);
        Ok(())
    }
    pub fn capture_group_channel_request(
        &mut self,
        receipt: ReceiptRecord,
        host: &mut dyn HostIO,
    ) -> Result<Captured, Errno> {
        let mut binding = self.completion_binding(receipt)?;
        if binding.fatal {
            return Err(Errno::EIO);
        }
        if binding.detached || binding.call.is_some() {
            return Err(Errno::EBUSY);
        }
        if binding.exec_retired {
            if self.get(receipt.pid).is_some_and(|process| process.exec_generation == receipt.generation) {
                return Err(Errno::ESRCH);
            }
        } else if binding.process_exit {
            if self.get(receipt.pid).is_some_and(|process| {
                process.exec_generation != receipt.generation
                    || !matches!(process.state, ProcessState::Exited | ProcessState::Limbo)
            }) {
                return Err(Errno::ESRCH);
            }
        } else if self.admitted_group_memory_caller(receipt.pid, receipt.tid)? != receipt {
            return Err(Errno::ESRCH);
        }
        let token = self.group_completions_ref().next;
        let next = token.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        let (store, admission) = self.memory_groups().storage_owner(receipt)?;
        let mut memory = HostMemory {
            resource: store.resource(),
            host,
        };
        if store.status(admission)? & S::STOPPED != 0 {
            return Err(Errno::ESRCH);
        }
        if store.completion_word(
            &memory,
            admission,
            binding.channel + C::STATUS_OFFSET as u32,
        )? != ChannelStatus::Pending as u32
        {
            return Err(Errno::EBUSY);
        }
        let syscall = store.completion_word(
            &memory,
            admission,
            binding.channel + C::SYSCALL_OFFSET as u32,
        )?;
        let flags = store.completion_word(
            &memory,
            admission,
            binding.channel + C::REQUEST_FLAGS_OFFSET as u32,
        )?;
        let invalid = flags & !C::REQUEST_FLAGS_KNOWN_MASK != 0
            || flags & C::REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED != 0
                && flags & C::REQUEST_FLAG_CANCELLATION_POINT == 0
            || flags & C::REQUEST_FLAG_OPAQUE_RECORD != 0
                && wasm_posix_shared::host_raw_syscalls::is_host_raw_syscall(syscall);
        store.retain_completion(admission)?;
        // The next PENDING publication consumes the prior signal record.
        // Host ACK alone cannot prove that the guest already read it.
        binding.signal = None;
        binding.signal_written = false;
        let automatic = invalid || binding.process_exit || binding.exec_retired;
        binding.call = Some(Call {
            token,
            syscall,
            flags,
            phase: if automatic {
                Phase::Ready
            } else {
                Phase::Captured
            },
            value: if invalid { -1 } else { 0 },
            errno: if invalid { Errno::EINVAL as u32 } else { 0 },
            wait: None,
            relisten: false,
            terminal: false,
            dispatched: false,
        });
        self.set_completion_binding(binding);
        self.group_completions().next = next;
        // Freeze ownership before the foreign store: an uncertain clear must
        // retain this call and quarantine, never recapture its request.
        let (store, admission) = self.memory_groups().storage_owner(receipt)?;
        let cleared = store.clear_completion_request_flags(&mut HostMemory { resource: store.resource(), host }, admission, binding.channel);
        if cleared.is_err() {
            self.fail_group_completion_image(receipt, host)?;
            return Err(Errno::EIO);
        }
        Ok(Captured {
            token,
            syscall,
            flags,
            invalid,
            automatic,
        })
    }
    pub fn complete_group_channel_request(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
        value: i64,
        errno: u32,
    ) -> Result<(), Errno> {
        let mut binding = self.completion_binding(receipt)?;
        let call = binding
            .call
            .as_mut()
            .filter(|call| call.token == token)
            .ok_or(Errno::ESRCH)?;
        if call.phase != Phase::Captured {
            return Err(Errno::EBUSY);
        }
        if !call.dispatched { return Err(Errno::EBUSY); }
        call.value = value;
        call.errno = errno;
        call.phase = Phase::Ready;
        self.set_completion_binding(binding);
        Ok(())
    }
    /// Called only after actual Rust thread cleanup commits. A host boolean
    /// at publication time cannot manufacture the removed task's EXIT permit.
    pub fn note_group_completion_thread_exit(
        &mut self,
        pid: u32,
        tid: u32,
        generation: u64,
        natural: bool,
    ) {
        if self.get(pid).is_none_or(|process| {
            process.exec_generation != generation || process.is_live_explicit_tid(tid)
        }) {
            return;
        }
        let _ = self
            .group_completions()
            .bindings
            .try_for_each_mut_entry(|_, binding| {
                if binding.receipt.pid == pid
                    && binding.receipt.tid == tid
                    && binding.receipt.generation == generation
                {
                    binding.natural_exit = natural
                        && binding
                            .call
                            .is_some_and(|call| call.syscall == Syscall::Exit as u32);
                }
                Ok(())
            });
    }
    pub(crate) fn note_group_completion_process_exit(&mut self, pid: u32, generation: u64) {
        let _ = self
            .group_completions()
            .bindings
            .try_for_each_mut_entry(|_, binding| {
                if binding.receipt.pid == pid && binding.receipt.generation == generation {
                    binding.process_exit = true;
                }
                Ok(())
            });
    }
    pub(crate) fn note_group_completion_exec_retirement(&mut self, pid: u32, generation: u64) {
        let _ = self.group_completions().bindings.try_for_each_mut_entry(|_, binding| {
            if binding.receipt.pid == pid && binding.receipt.generation == generation {
                binding.exec_retired = true;
            }
            Ok(())
        });
    }
    pub fn detach_group_completion_channel(&mut self, receipt: ReceiptRecord) -> Result<(), Errno> {
        let mut binding = self.completion_binding(receipt)?;
        binding.detached = true;
        if binding.call.is_none() {
            self.group_completions()
                .bindings
                .remove(&Key(receipt.group, receipt.serial));
        } else {
            self.set_completion_binding(binding);
        }
        Ok(())
    }
    /// The actual engine observation reports its exact retained wait identity.
    /// Timeout and wake requests do not enter this method.
    pub fn settle_group_completion_observation(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
        wait: u64,
    ) -> Result<(), Errno> {
        let mut binding = self.completion_binding(receipt)?;
        let call = binding
            .call
            .as_mut()
            .filter(|call| call.token == token)
            .ok_or(Errno::ESRCH)?;
        if call.wait.is_none_or(|pending| pending.token != wait) {
            return Err(Errno::ESRCH);
        }
        let (store, admission) = self.memory_groups().storage_owner(receipt)?;
        store.settle_native_observation(admission, wait)?;
        call.wait = None;
        self.set_completion_binding(binding);
        Ok(())
    }
    /// A selected native transport reports whether it actually held a blocker.
    /// Rust owns cancellation and the interrupted result; the adapter disposes
    /// its real callback/pipe/timer objects before acknowledging this effect.
    pub fn report_group_completion_interrupt(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
        blocked: bool,
    ) -> Result<(), Errno> {
        let mut binding = self.completion_binding(receipt)?;
        let call = binding
            .call
            .as_mut()
            .filter(|call| call.token == token)
            .ok_or(Errno::ESRCH)?;
        if !binding.interrupt || call.phase != Phase::Captured {
            return Err(Errno::EBUSY);
        }
        if blocked || crate::wait_park::with(|parks| parks.owns_task(receipt.pid, receipt.tid)) {
            let process = self.get_mut(receipt.pid).ok_or(Errno::ESRCH)?;
            if process.exec_generation != receipt.generation {
                return Err(Errno::ESRCH);
            }
            crate::syscalls::cancel_host_owned_wait_for_live_tid(process, receipt.tid)?;
            if blocked {
                call.value = -(Errno::EINTR as i64);
                call.errno = Errno::EINTR as u32;
                call.phase = Phase::Ready;
            }
        }
        binding.interrupt = false;
        self.set_completion_binding(binding);
        Ok(())
    }
    fn fail_group_completion_image(
        &mut self,
        receipt: ReceiptRecord,
        host: &mut dyn HostIO,
    ) -> Result<Effect, Errno> {
        // Retain every prepared record before a foreign effect. No uncertain
        // write can become another dequeue or a retryable allocator refusal.
        self.group_completions()
            .bindings
            .try_for_each_mut_entry(|_, binding| {
                if binding.receipt.pid == receipt.pid
                    && binding.receipt.generation == receipt.generation
                {
                    binding.fatal = true;
                    if let Some(call) = binding.call.as_mut() {
                        call.phase = Phase::Fatal;
                    }
                }
                Ok(())
            })?;
        let (store, _) = self.memory_groups().storage_owner(receipt)?;
        let resource = store.resource();
        let root = store.root_for_image(receipt)?;
        let stopped = store.quarantine_image(&mut HostMemory { resource, host }, root);
        self.memory_groups().quarantine_image_tasks(receipt)?;
        match stopped {
            Ok(()) | Err(Errno::EAGAIN) => Ok(Effect::Fatal),
            Err(error) => Err(error),
        }
    }
    pub fn prepare_group_completion_signal(
        &mut self,
        receipt: ReceiptRecord,
        suppress_restart: bool,
        host: &mut dyn HostIO,
    ) -> Result<u32, Errno> {
        let mut binding = self.completion_binding(receipt)?;
        if binding.fatal {
            return Err(Errno::EIO);
        }
        if !binding.call.is_some_and(|call| matches!(call.phase, Phase::Captured | Phase::Ready)) {
            return Err(Errno::EBUSY);
        }
        if binding.natural_exit || binding.process_exit || binding.exec_retired {
            return Ok(0);
        }
        if binding
            .call
            .is_some_and(|call| call.flags & C::REQUEST_FLAG_DEFER_SIGNAL_DELIVERY != 0)
        {
            return Ok(0);
        }
        if binding.signal.is_none() {
            let (process, locks) = self
                .task_and_advisory_locks(receipt.pid, receipt.tid)
                .ok_or(Errno::ESRCH)?;
            if process.exec_generation != receipt.generation {
                return Err(Errno::ESRCH);
            }
            binding.signal =
                crate::signal::dequeue_caught_signal_for_task(process, locks, host, receipt.tid)?;
            binding.signal_written = false;
            binding.interrupt = binding.signal.is_some()
                && binding
                    .call
                    .is_some_and(|call| call.phase == Phase::Captured);
        }
        if suppress_restart {
            if let Some(signal) = binding.signal.as_mut() {
                if signal.flags & wasm_posix_shared::signal::SA_RESTART != 0 {
                    signal.flags &= !wasm_posix_shared::signal::SA_RESTART;
                    binding.signal_written = false;
                }
            }
        }
        // Persist the exact caught signal and installed mask before copying
        // any wire bytes. A failed copy must never consume a second signal.
        self.set_completion_binding(binding);
        let signum = binding.signal.map_or(0, |signal| signal.signum);
        if !binding.signal_written {
            let mut bytes = [0; C::SIG_AREA_SIZE];
            if let Some(signal) = binding.signal {
                let encoded = crate::process_wire::encode_signal_delivery_record(signal);
                bytes[..encoded.len()].copy_from_slice(&encoded);
            }
            let (store, admission) = self.memory_groups().storage_owner(receipt)?;
            let written = store.write_completion_signal(
                &mut HostMemory {
                    resource: store.resource(),
                    host,
                },
                admission,
                binding.channel,
                &bytes,
            );
            if written.is_err() {
                self.fail_group_completion_image(receipt, host)?;
                return Err(Errno::EIO);
            }
            binding.signal_written = true;
            self.set_completion_binding(binding);
        }
        Ok(signum)
    }
    fn preflight_group_completion_signals(
        &mut self,
        receipt: ReceiptRecord,
        host: &mut dyn HostIO,
        prepare_caught: bool,
    ) -> Result<Option<Effect>, Errno> {
        let selected = |binding: &&Binding| {
            binding.receipt.pid == receipt.pid
                && binding.receipt.generation == receipt.generation
                && !binding.detached
        };
        // Copy only the next key/receipt before each mutable signal action.
        // Foreign callbacks cannot reenter ProcessTable, so no channel can be
        // inserted during this barrier. No per-syscall scan allocation or
        // allocation refusal may split an image's resume/start decision.
        let mut cursor = Key(receipt.group, 0);
        while let Some((key, binding)) = self.group_completions_ref().bindings
            .next_after(&cursor).map(|(key, binding)| (*key, *binding)) {
            cursor = key;
            if key.0 != receipt.group { break; }
            if !selected(&&binding) { continue; }
            let current = binding.receipt;
            if self.validate_task(current.pid, current.tid).is_err() {
                continue;
            }
            if crate::wait_park::with(|parks| parks.owns_task(current.pid, current.tid)) {
                continue;
            }
            let binding = self.completion_binding(current)?;
            if binding.signal.is_none() {
                if !prepare_caught || binding.call.is_none_or(|call| !call.dispatched
                    || !matches!(call.phase, Phase::Captured | Phase::Ready))
                    || binding
                        .call
                        .is_some_and(|call| call.flags & C::REQUEST_FLAG_DEFER_SIGNAL_DELIVERY != 0)
                {
                    // An idle sibling has no result to carry a handler. Its
                    // next PENDING request must still find the caught signal
                    // queued; only default actions may progress here.
                    let (process, locks) = self
                        .task_and_advisory_locks(current.pid, current.tid)
                        .ok_or(Errno::ESRCH)?;
                    crate::signal::deliver_pending_signals_for_tid_with_locks(
                        process,
                        locks,
                        host,
                        current.tid,
                    )?;
                } else {
                    self.prepare_group_completion_signal(current, false, host)?;
                }
            }
            if self.get(receipt.pid).is_none_or(|process| {
                process.state != ProcessState::Running || process.exit_signal != 0
            }) {
                return Ok(None);
            }
        }
        Ok(self
            .group_completions_ref()
            .bindings
            .values()
            .find_map(|binding| {
                (binding.receipt.pid == receipt.pid
                    && binding.receipt.generation == receipt.generation
                    && !binding.detached
                    && binding.interrupt)
                    .then(|| {
                        binding.call.filter(|call| call.phase == Phase::Captured).map(|call| Effect::InterruptTransport {
                            receipt: binding.receipt,
                            channel: binding.channel,
                            token: call.token,
                        })
                    })
                    .flatten()
            }))
    }
    /// Actual root/fork/exec owners call this before issuing or entering a
    /// native constructor/delivery effect. It holds no separate lifecycle.
    pub(crate) fn group_native_start_permission(&mut self, receipt: ReceiptRecord,
        host: &mut dyn HostIO) -> Result<NativeStart, Errno> {
        let current = self.admitted_group_memory_caller(receipt.pid, receipt.tid).ok() == Some(receipt);
        if !current { return Ok(NativeStart::Dead); }
        let (store, admission) = self.memory_groups().storage_owner(receipt)?;
        if store.status(admission)? & (S::STOPPING | S::STOPPED) != 0
            || store.status(admission)? & S::SOURCE_LIVE == 0 { return Ok(NativeStart::Dead); }
        if self.get(receipt.pid).is_some_and(|process| process.state == ProcessState::Stopped) {
            return Ok(NativeStart::Stopped);
        }
        // A newly constructed image has no result carrying a caught handler.
        // Keep those signals queued for real PENDING dispatch; apply defaults
        // across the whole image before any guest instruction may run.
        let (process, locks) = self.task_and_advisory_locks(receipt.pid, receipt.tid).ok_or(Errno::ESRCH)?;
        crate::signal::deliver_pending_signals_for_tid_with_locks(process, locks, host, receipt.tid)?;
        self.preflight_group_completion_signals(receipt, host, false)?;
        Ok(match self.get(receipt.pid) {
            Some(process) if process.exec_generation == receipt.generation && process.exit_signal == 0 =>
                match process.state { ProcessState::Running => NativeStart::Ready,
                    ProcessState::Stopped => NativeStart::Stopped, _ => NativeStart::Dead },
            _ => NativeStart::Dead,
        })
    }
    pub fn poll_group_channel_completion(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
        host: &mut dyn HostIO,
    ) -> Result<Effect, Errno> {
        let mut binding = self.completion_binding(receipt)?;
        let call = binding
            .call
            .filter(|call| call.token == token)
            .ok_or(Errno::ESRCH)?;
        if matches!(
            call.phase,
            Phase::Published | Phase::Discarded | Phase::Fatal
        ) {
            return Ok(match call.phase {
                Phase::Published => Effect::Published {
                    relisten: call.relisten,
                    terminal: call.terminal,
                },
                Phase::Discarded => Effect::Discarded,
                _ => Effect::Fatal,
            });
        }
        let process = self
            .get(receipt.pid)
            .map(|process| (process.exec_generation, process.state, process.exit_signal));
        let generation_current = process.is_some_and(|process| process.0 == receipt.generation);
        let live = generation_current
            && process.is_some_and(|process| {
                matches!(process.1, ProcessState::Running | ProcessState::Stopped) && process.2 == 0
            })
            && self.validate_task(receipt.pid, receipt.tid).is_ok();
        let ended = binding.process_exit && (process.is_none() || generation_current);
        let terminal = binding.natural_exit || ended || binding.exec_retired;
        let (store, admission) = self.memory_groups().storage_owner(receipt)?;
        let status = store.status(admission)?;
        let discard = (!terminal
            && (binding.detached
                || !live
                || status & (S::STOPPING | S::STOPPED) != 0
                || status & S::SOURCE_LIVE == 0))
            || terminal && status & S::STOPPED != 0
            || !generation_current && !ended && !binding.exec_retired;
        if let Some(wait) = call.wait {
            return Ok(if discard {
                Effect::CancelObservation {
                    resource: store.resource(),
                    wait,
                }
            } else {
                Effect::Observe {
                    resource: store.resource(),
                    wait,
                }
            });
        }
        if discard {
            binding.call.as_mut().unwrap().phase = Phase::Discarded;
            self.set_completion_binding(binding);
            return Ok(Effect::Discarded);
        }
        if call.phase == Phase::Captured {
            if !call.dispatched { return self.dispatch_group_channel_request(receipt, token, host); }
            if binding.interrupt {
                return Ok(Effect::InterruptTransport { receipt, channel: binding.channel, token });
            }
            if process.is_some_and(|process| process.1 == ProcessState::Stopped) {
                return Ok(Effect::WaitStopped);
            }
            return Ok(Effect::Captured);
        }
        if !terminal {
            if process.is_some_and(|process| process.1 == ProcessState::Stopped) {
                return Ok(Effect::WaitStopped);
            }
            match self.preflight_group_completion_signals(receipt, host, true) {
                Ok(Some(effect)) => return Ok(effect),
                Ok(None) => {}
                Err(_) if self.completion_binding(receipt)?.fatal => return Ok(Effect::Fatal),
                Err(error) => return Err(error),
            }
            binding = self.completion_binding(receipt)?;
            let process = self.get(receipt.pid).ok_or(Errno::ESRCH)?;
            if process.state == ProcessState::Stopped {
                return Ok(Effect::WaitStopped);
            }
            if process.state != ProcessState::Running || process.exit_signal != 0 {
                binding.call.as_mut().unwrap().phase = Phase::Discarded;
                self.set_completion_binding(binding);
                return Ok(Effect::Discarded);
            }
        }
        let call = binding.call.unwrap();
        let exit = call.syscall == Syscall::Exit as u32
            || call.syscall == wasm_posix_shared::abi::extended_syscalls::SYS_EXIT_GROUP;
        // [RUNTIME-WORKAROUND: JSC-TERMINATE-ATOMICS-WAIT-LEAK]
        // An old Worker may need to leave its real atomic wait cooperatively.
        // The actual exit/exec transition selects this marker; notification
        // alone still proves neither Worker stop nor native-wait retirement.
        let unwind = if binding.exec_retired {
            Some(wasm_posix_shared::group_completion::RETIRE_EXEC_CODE)
        } else if terminal && !exit {
            Some(wasm_posix_shared::group_completion::RETIRE_EXIT_CODE)
        } else { None };
        let (value, errno) = if unwind.is_some() {
            (-1, Errno::EINTR as u32)
        } else if terminal {
            (0, 0)
        } else {
            (call.value, call.errno)
        };
        let (store, admission) = self.memory_groups().storage_owner(receipt)?;
        let resource = store.resource();
        match store.publish_completion(
            &mut HostMemory { resource, host },
            admission,
            binding.channel,
            value,
            errno,
            unwind,
        ) {
            Ok(()) => {
                let relisten = !binding.natural_exit && !binding.exec_retired
                    && (!terminal
                        || call.syscall
                            == wasm_posix_shared::abi::extended_syscalls::SYS_EXIT_GROUP
                        || unwind.is_some());
                let completed = binding.call.as_mut().unwrap();
                completed.phase = Phase::Published;
                completed.value = value;
                completed.errno = errno;
                completed.relisten = relisten;
                completed.terminal = terminal;
                self.set_completion_binding(binding);
                Ok(Effect::Published { relisten, terminal })
            }
            Err(PublicationFailure::Busy) => {
                let wait = store
                    .prepare_progress(
                        &HostMemory { resource, host },
                        admission,
                        ProgressTarget::NotificationQueue,
                    )?
                    .ok_or(Errno::EIO)?;
                binding.call.as_mut().unwrap().wait = Some(wait);
                self.set_completion_binding(binding);
                Ok(Effect::Observe { resource, wait })
            }
            Err(PublicationFailure::Fault(_error)) => {
                self.fail_group_completion_image(receipt, host)
            }
        }
    }
    pub fn dispatch_group_channel_request(&mut self, receipt: ReceiptRecord, token: u64,
        host: &mut dyn HostIO) -> Result<Effect, Errno> {
        let mut binding = self.completion_binding(receipt)?;
        let call = binding.call.filter(|call| call.token == token).ok_or(Errno::ESRCH)?;
        if call.phase != Phase::Captured {
            return self.poll_group_channel_completion(receipt, token, host);
        }
        let current = self.get(receipt.pid).is_some_and(|process|
            process.exec_generation == receipt.generation && process.exit_signal == 0
                && matches!(process.state, ProcessState::Running | ProcessState::Stopped));
        if binding.detached || !current || self.admitted_group_memory_caller(receipt.pid, receipt.tid).ok() != Some(receipt) {
            binding.call.as_mut().unwrap().phase = Phase::Discarded;
            self.set_completion_binding(binding);
            return Ok(Effect::Discarded);
        }
        if self.get(receipt.pid).unwrap().state == ProcessState::Stopped { return Ok(Effect::WaitStopped); }
        // Dispatch applies defaults, but cannot consume a caught signal before
        // the syscall has a result or an actual blocker to interrupt.
        self.preflight_group_completion_signals(receipt, host, false)?;
        let process = self.get(receipt.pid).ok_or(Errno::ESRCH)?;
        if process.state == ProcessState::Stopped { return Ok(Effect::WaitStopped); }
        if process.state != ProcessState::Running || process.exit_signal != 0 {
            binding.call.as_mut().unwrap().phase = Phase::Discarded;
            self.set_completion_binding(binding);
            return Ok(Effect::Discarded);
        }
        binding.call.as_mut().unwrap().dispatched = true;
        self.set_completion_binding(binding);
        Ok(Effect::Dispatch)
    }

    fn completion_reply(
        &self,
        receipt: ReceiptRecord,
        token: u64,
        effect: u32,
    ) -> wasm_posix_shared::group_completion::Reply {
        let mut reply = wasm_posix_shared::group_completion::Reply::new(receipt, token, effect);
        if let Ok(binding) = self.completion_binding(receipt) {
            reply.channel = binding.channel;
            if let Some(call) = binding.call {
                reply.token = call.token;
                reply.value = call.value;
                reply.errno = call.errno;
                reply.syscall = call.syscall;
                reply.request_flags = call.flags;
            }
        }
        reply
    }
    fn encode_completion_effect(
        &self,
        receipt: ReceiptRecord,
        token: u64,
        effect: Effect,
    ) -> wasm_posix_shared::group_completion::Reply {
        use wasm_posix_shared::group_completion::{effect as E, flags as F};
        let (target, token) = if let Effect::InterruptTransport { receipt, token, .. } = effect {
            (receipt, token)
        } else {
            (receipt, token)
        };
        let kind = match effect {
            Effect::Captured => E::CAPTURED,
            Effect::Dispatch => E::DISPATCH,
            Effect::InterruptTransport { .. } => E::INTERRUPT,
            Effect::WaitStopped => E::STOPPED,
            Effect::Observe { .. } => E::OBSERVE,
            Effect::CancelObservation { .. } => E::CANCEL_OBSERVATION,
            Effect::Published { .. } => E::PUBLISHED,
            Effect::Discarded => E::DISCARDED,
            Effect::Fatal => E::FATAL,
        };
        let mut reply = self.completion_reply(target, token, kind);
        match effect {
            Effect::Observe { resource, wait } | Effect::CancelObservation { resource, wait } => {
                reply.resource = resource;
                reply.observation = wait.token;
                reply.address = wait.address;
                reply.expected = wait.expected;
                reply.delay = 10;
            }
            Effect::Published { relisten, terminal } => {
                if relisten {
                    reply.flags |= F::RELISTEN;
                }
                if terminal {
                    reply.flags |= F::TERMINAL;
                }
            }
            _ => {}
        }
        reply
    }
    pub fn group_completion_control(
        &mut self,
        request: wasm_posix_shared::group_completion::Request,
        host: &mut dyn HostIO,
    ) -> Result<wasm_posix_shared::group_completion::Reply, Errno> {
        use wasm_posix_shared::group_completion::{command as C, effect as E, flags as F};
        let record = request.receipt;
        match request.command {
            C::BIND => {
                self.bind_group_completion_channel(record, request.channel)?;
                return Ok(self.completion_reply(record, 0, E::ACKNOWLEDGED));
            }
            C::CAPTURE => {
                let call = match self.capture_group_channel_request(record, host) {
                    Ok(call) => call,
                    Err(_) if self.completion_binding(record)?.fatal => return Ok(self.completion_reply(record, 0, E::FATAL)),
                    Err(error) => return Err(error),
                };
                let mut reply = self.completion_reply(record, call.token, E::CAPTURED);
                if call.automatic {
                    reply.flags |= F::AUTOMATIC;
                }
                if call.invalid {
                    reply.flags |= F::INVALID;
                }
                return Ok(reply);
            }
            C::COMPLETE => self.complete_group_channel_request(
                record,
                request.token,
                request.value,
                request.errno,
            )?,
            C::POLL => {}
            C::DISPATCH => {
                let effect = match self.dispatch_group_channel_request(record, request.token, host) {
                    Ok(effect) => effect,
                    Err(Errno::ENOMEM) => {
                        let mut reply = self.completion_reply(record, request.token, E::RETRY);
                        reply.delay = 10; return Ok(reply);
                    }
                    Err(error) => return Err(error),
                };
                return Ok(self.encode_completion_effect(record, request.token, effect));
            }
            C::RETURNED => {
                let mut binding = self.completion_binding(record)?;
                let call = binding.call.filter(|call| call.token == request.token).ok_or(Errno::ESRCH)?;
                if call.phase == Phase::Captured && call.dispatched && binding.signal.is_some() {
                    binding.interrupt = true;
                    self.set_completion_binding(binding);
                }
            }
            C::TERMINAL => {
                let mut binding = self.completion_binding(record)?;
                if !binding.natural_exit && !binding.process_exit && !binding.exec_retired { return Err(Errno::ESRCH); }
                if binding.call.is_none() {
                    let (store, admission) = self.memory_groups().storage_owner(record)?;
                    if store.status(admission)? & S::STOPPED != 0 {
                        return Ok(self.completion_reply(record, 0, E::ACKNOWLEDGED));
                    }
                    match self.capture_group_channel_request(record, host) {
                        Ok(_) => binding = self.completion_binding(record)?,
                        Err(Errno::EBUSY) => return Ok(self.completion_reply(record, 0, E::ACKNOWLEDGED)),
                        Err(error) => return Err(error),
                    }
                }
                if request.token != 0 && binding.call.unwrap().token != request.token { return Err(Errno::ESRCH); }
                if binding.call.unwrap().phase == Phase::Captured {
                    binding.call.as_mut().unwrap().phase = Phase::Ready;
                    self.set_completion_binding(binding);
                }
                let token = binding.call.unwrap().token;
                let effect = self.poll_group_channel_completion(record, token, host)?;
                return Ok(self.encode_completion_effect(record, token, effect));
            }
            C::DETACH => {
                self.detach_group_completion_channel(record)?;
                return Ok(self.completion_reply(record, 0, E::ACKNOWLEDGED));
            }
            C::OBSERVED => self.settle_group_completion_observation(
                record,
                request.token,
                request.observation,
            )?,
            C::ACK => {
                self.acknowledge_group_channel_completion(record, request.token)?;
                return Ok(wasm_posix_shared::group_completion::Reply::new(
                    record,
                    request.token,
                    E::ACKNOWLEDGED,
                ));
            }
            C::INTERRUPTED => self.report_group_completion_interrupt(
                record,
                request.token,
                request.argument != 0,
            )?,
            C::SIGNAL => {
                let binding = self.completion_binding(record)?;
                if binding.call.map_or(0, |call| call.token) != request.token {
                    return Err(Errno::ESRCH);
                }
                let signal =
                    self.prepare_group_completion_signal(record, request.argument != 0, host);
                if self.completion_binding(record)?.fatal {
                    return Ok(self.completion_reply(record, request.token, E::FATAL));
                }
                let mut reply = self.completion_reply(record, request.token, E::SIGNAL);
                reply.value = i64::from(signal?);
                return Ok(reply);
            }
            C::RESUME => {
                self.completion_binding(record)?;
                if self.get(record.pid).is_none_or(|process| {
                    process.exec_generation != record.generation
                        || matches!(process.state, ProcessState::Exited | ProcessState::Limbo)
                        || process.exit_signal != 0
                }) {
                    return Ok(self.completion_reply(record, 0, E::DISCARDED));
                }
                if self.get(record.pid).unwrap().state == ProcessState::Stopped {
                    return Ok(self.completion_reply(record, 0, E::STOPPED));
                }
                let effect = self.preflight_group_completion_signals(record, host, true);
                if self.completion_binding(record)?.fatal {
                    return Ok(self.completion_reply(record, 0, E::FATAL));
                }
                if let Some(effect) = effect? {
                    return Ok(self.encode_completion_effect(record, 0, effect));
                }
                let state = self.get(record.pid).ok_or(Errno::ESRCH)?;
                let kind = if state.state == ProcessState::Stopped {
                    E::STOPPED
                } else if state.state != ProcessState::Running || state.exit_signal != 0 {
                    E::DISCARDED
                } else {
                    E::RESUMED
                };
                return Ok(self.completion_reply(record, 0, kind));
            }
            _ => return Err(Errno::EINVAL),
        }
        let effect = match self.poll_group_channel_completion(record, request.token, host) {
            Ok(effect) => effect,
            Err(Errno::ENOMEM) => {
                let mut reply = self.completion_reply(record, request.token, E::RETRY);
                reply.delay = 10;
                return Ok(reply);
            }
            Err(error) => return Err(error),
        };
        Ok(self.encode_completion_effect(record, request.token, effect))
    }
    pub fn acknowledge_group_channel_completion(
        &mut self,
        receipt: ReceiptRecord,
        token: u64,
    ) -> Result<(), Errno> {
        let mut binding = self.completion_binding(receipt)?;
        let call = binding
            .call
            .filter(|call| call.token == token)
            .ok_or(Errno::ESRCH)?;
        if !matches!(call.phase, Phase::Published | Phase::Discarded) || call.wait.is_some() {
            return Err(Errno::EBUSY);
        }
        let (store, admission) = self.memory_groups().storage_owner(receipt)?;
        store.release_completion(admission)?;
        binding.call = None;
        if binding.detached {
            self.group_completions()
                .bindings
                .remove(&Key(receipt.group, receipt.serial));
        } else {
            self.set_completion_binding(binding);
        }
        Ok(())
    }
}
