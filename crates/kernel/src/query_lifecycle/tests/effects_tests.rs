use super::super::{
    effects::{Delivered, Delivery},
    registry::{Completed, IntentRegistry, Status},
};
use super::*;
use crate::{
    wait_park::Resume,
    wait_queue::{WaitKind, WakeSource},
};

fn thread_request(pid: u32, tid: u32, clear_child_tid: bool) -> Request {
    Request::ThreadExit {
        pid,
        tid,
        clear_child_tid,
    }
}

fn park_ctid(pid: u32, addr: u64) -> usize {
    crate::wait_park::with(|parks| {
        parks
            .park(
                pid,
                pid,
                WaitKind::Futex,
                vec![WakeSource::Futex { pid, addr }],
                None,
                Resume::Futex {
                    bitset: u32::MAX,
                    timeout_ns: None,
                },
            )
            .unwrap();
        parks.pending_completions()
    })
}

#[test]
fn real_query_retirement_precedes_one_frozen_ctid_publication_and_wake() {
    let (mut table, mut host, pid, base, _guard) = fixture();
    let tid = table.create_thread(pid, pid, 0, 0, 0x2000).unwrap();
    let (token, _) = admit(&mut table, &mut host, pid, tid, base);
    let mut registry = IntentRegistry::for_test(1, 1);
    let handle = registry
        .admit(&table, thread_request(pid, tid, true))
        .unwrap();
    let before = park_ctid(pid, 0x2000);
    pending(&mut host, token);
    assert_eq!(
        registry.step(handle, &mut table, &mut host).unwrap().status,
        Status::PendingOwned
    );
    assert_eq!(
        registry.deliver_completion(handle, &mut table, &mut host),
        Err(Errno::EBUSY)
    );
    assert!(host.writes.is_empty());
    assert!(table.get(pid).unwrap().get_thread(tid).is_some());
    // An authenticated wrong-token reply must not release the old owner.
    host.retired(token + 1);
    assert_eq!(
        registry.step(handle, &mut table, &mut host).unwrap().status,
        Status::ProtocolFaultOwned
    );
    assert!(host.writes.is_empty());
    host.retired(token);
    assert_eq!(
        registry.step(handle, &mut table, &mut host).unwrap().status,
        Status::Complete(Ok(Completed::ThreadExit))
    );
    assert!(host.writes.is_empty());
    for _ in 0..3 {
        assert_eq!(
            registry
                .deliver_completion(handle, &mut table, &mut host)
                .unwrap(),
            Delivery::Delivered(Ok(Delivered::ThreadExit(0x2000)))
        );
    }
    assert_eq!(host.writes, vec![(pid as i32, 0x2000, vec![0, 0, 0, 0])]);
    assert_eq!(
        crate::wait_park::with(|parks| parks.pending_completions()),
        before + 1
    );
    registry.forget(handle).unwrap();
}

#[test]
fn clear_tid_flag_and_fault_preserve_legacy_return_and_wake_semantics() {
    for (clear, ptr, write_result) in [
        (false, 0x3000, 0),
        (true, 0, 0),
        (true, 0x3000, -(Errno::EFAULT as i32)),
    ] {
        let (mut table, mut host, pid, _, _guard) = fixture();
        let tid = table.create_thread(pid, pid, 0, 0, ptr).unwrap();
        let before = if ptr != 0 {
            park_ctid(pid, ptr as u64)
        } else {
            crate::wait_park::with(|parks| parks.pending_completions())
        };
        host.write_result = write_result;
        assert_eq!(
            super::super::effects::thread_exit(&mut table, &mut host, pid, tid, clear),
            Ok(ptr)
        );
        assert_eq!(host.writes.len(), usize::from(clear && ptr != 0));
        assert_eq!(
            crate::wait_park::with(|parks| parks.pending_completions()),
            before
        );
        assert_eq!(
            super::super::effects::thread_exit(&mut table, &mut host, pid, tid, clear),
            Err(Errno::ESRCH)
        );
    }
}

#[test]
fn trapped_publication_keeps_installed_actual_receiver_and_never_replays() {
    let (mut table, mut host, pid, _, _guard) = fixture();
    let tid = table.create_thread(pid, pid, 0, 0, 0x4000).unwrap();
    let mut registry = IntentRegistry::for_test(1, 1);
    let handle = registry
        .admit(&table, thread_request(pid, tid, true))
        .unwrap();
    registry.step(handle, &mut table, &mut host).unwrap();
    host.trap_write = true;
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            registry
                .deliver_completion(handle, &mut table, &mut host)
                .unwrap();
        }))
        .is_err()
    );
    assert_eq!(
        registry.inspect(handle).unwrap().status,
        Status::Delivering(Delivery::ProtocolFaultOwned)
    );
    host.trap_write = false;
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::ProtocolFaultOwned
    );
    assert_eq!(host.writes.len(), 1);
    assert_eq!(registry.forget(handle), Err(Errno::EBUSY));
    assert!(matches!(
        registry.take_completion(handle),
        Err(Errno::EBUSY)
    ));
    assert_eq!(
        registry.abandon(handle, &mut table, &mut host).unwrap_err(),
        Errno::EBUSY
    );
}

#[test]
fn replacement_exec_generation_prevents_ctid_write_to_new_image() {
    let (mut table, mut host, pid, base, _guard) = fixture();
    let tid = table.create_thread(pid, pid, 0, 0, 0x5000).unwrap();
    let mut registry = IntentRegistry::for_test(1, 1);
    let handle = registry
        .admit(&table, thread_request(pid, tid, true))
        .unwrap();
    registry.step(handle, &mut table, &mut host).unwrap();
    let (target, _) = prepare(
        &mut table,
        pid,
        PreparedExecOwner::Process {
            pid,
            caller_tid: pid,
            generation: 0,
        },
        base,
    );
    assert!(matches!(
        legacy(
            &mut table,
            &mut host,
            Request::Exec {
                pid,
                tid: pid,
                target
            }
        ),
        Ok(Completion::Exec)
    ));
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::ProtocolFaultOwned
    );
    assert!(host.writes.is_empty());
    assert_eq!(registry.forget(handle), Err(Errno::EBUSY));
}

#[test]
fn captured_pointer_width_is_checked_before_old_memory_publication() {
    let (mut table, mut host, pid, _, _guard) = fixture();
    let tid = table.create_thread(pid, pid, 0, 0, 0x6000).unwrap();
    let mut registry = IntentRegistry::for_test(1, 1);
    let handle = registry
        .admit(&table, thread_request(pid, tid, true))
        .unwrap();
    registry.step(handle, &mut table, &mut host).unwrap();
    // Deliberately corrupt the authoritative width to exercise containment;
    // real exec generation invalidation is tested separately above.
    table.get_mut(pid).unwrap().pointer_width = 8;
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::ProtocolFaultOwned
    );
    assert!(host.writes.is_empty());
    assert_eq!(registry.forget(handle), Err(Errno::EBUSY));
}

#[test]
fn removal_vectors_remain_owned_without_a_physical_receiver() {
    for reap in [false, true] {
        let (mut table, mut host, pid, base, _guard) = fixture();
        let (token, _) = admit(&mut table, &mut host, pid, pid, base);
        let mut registry = IntentRegistry::for_test(1, 1);
        let handle = registry
            .admit(&table, Request::Remove { pid, reap })
            .unwrap();
        host.retired(token);
        registry.step(handle, &mut table, &mut host).unwrap();
        assert!(table.get(pid).is_none());
        for _ in 0..2 {
            assert_eq!(
                registry
                    .deliver_completion(handle, &mut table, &mut host)
                    .unwrap(),
                Delivery::PendingPhysicalReceiver
            );
        }
        let Some(Completion::Removed(actual)) = registry.held_effects(handle).unwrap() else {
            panic!("actual removal must remain installed");
        };
        assert!(actual.host_closes.contains(&base));
        assert!(host.closed.is_empty());
        assert_eq!(registry.forget(handle), Err(Errno::EBUSY));
        assert!(matches!(
            registry.take_completion(handle),
            Err(Errno::EBUSY)
        ));
    }
}

#[test]
fn exec_scalar_delivery_accepts_actual_committed_generation_once() {
    let (mut table, mut host, pid, base, _guard) = fixture();
    let (target, _) = prepare(
        &mut table,
        pid,
        PreparedExecOwner::Process {
            pid,
            caller_tid: pid,
            generation: 0,
        },
        base,
    );
    let mut registry = IntentRegistry::for_test(1, 1);
    let handle = registry
        .admit(
            &table,
            Request::Exec {
                pid,
                tid: pid,
                target,
            },
        )
        .unwrap();
    registry.step(handle, &mut table, &mut host).unwrap();
    assert_eq!(table.get(pid).unwrap().exec_generation, 1);
    for _ in 0..2 {
        assert_eq!(
            registry
                .deliver_completion(handle, &mut table, &mut host)
                .unwrap(),
            Delivery::Delivered(Ok(Delivered::Exec))
        );
    }
    registry.forget(handle).unwrap();
}

#[test]
fn exit_receiver_preserves_another_tasks_live_dispatch_binding() {
    let (mut table, mut host, pid, _, _guard) = fixture();
    let other = table.create_process().unwrap();
    let mut registry = IntentRegistry::for_test(1, 1);
    let handle = registry
        .admit(
            &table,
            Request::Exit {
                pid,
                tid: pid,
                status: 0x123,
                thread_worker: false,
            },
        )
        .unwrap();
    registry.step(handle, &mut table, &mut host).unwrap();
    table.bind_current_tid(other, other).unwrap();
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::Delivered(Ok(Delivered::Exit(0x23)))
    );
    assert_eq!(table.current_pid(), other);
    assert_eq!(table.current_tid(), other);
    registry.forget(handle).unwrap();
}

#[test]
fn init_reap_receiver_retains_actual_removal_and_wait_status() {
    let (mut table, mut host, _, _, _guard) = fixture();
    let child = table
        .create_init_child(vec![b"/effects-init-child".to_vec()])
        .unwrap();
    let (proc, locks) = table.process_and_advisory_locks(child).unwrap();
    syscalls::sys_exit_with_locks(proc, locks, &mut host, 42);
    let mut registry = IntentRegistry::for_test(1, 1);
    let handle = registry
        .admit(&table, Request::ReapInit { pid: child })
        .unwrap();
    registry.step(handle, &mut table, &mut host).unwrap();
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::PendingPhysicalReceiver
    );
    let Some(Completion::InitReaped(actual)) = registry.held_effects(handle).unwrap() else {
        panic!("actual init removal must remain installed");
    };
    assert_eq!(
        (actual.pid, actual.exit_status, actual.exit_signal),
        (child, 42, 0)
    );
    assert_eq!(registry.forget(handle), Err(Errno::EBUSY));
}

#[test]
fn retry_and_signal_scalar_receivers_observe_actual_finished_resources() {
    for signal in [false, true] {
        let (mut table, mut host, pid, base, _guard) = fixture();
        let (token, _) = admit(&mut table, &mut host, pid, pid, base);
        let mut registry = IntentRegistry::for_test(1, 1);
        let request = if signal {
            Request::SignalExit { pid, signum: 9 }
        } else {
            Request::ReleaseRetry {
                pid,
                tid: pid,
                token,
            }
        };
        let handle = registry.admit(&table, request).unwrap();
        host.retired(token);
        registry.step(handle, &mut table, &mut host).unwrap();
        assert!(
            table
                .get(pid)
                .unwrap()
                .blocked_retries
                .binding_for_token(token)
                .is_none()
        );
        assert_eq!(
            registry
                .deliver_completion(handle, &mut table, &mut host)
                .unwrap(),
            Delivery::Delivered(Ok(if signal {
                Delivered::Signaled
            } else {
                Delivered::RetryReleased
            }))
        );
        registry.forget(handle).unwrap();
    }
}

#[test]
fn legacy_export_routes_the_frozen_flag_to_the_single_real_receiver() {
    let source = include_str!("../../wasm_api.rs");
    let start = source
        .find("pub extern \"C\" fn kernel_thread_exit(")
        .unwrap();
    let end = source[start..].find("#[cfg(test)]").unwrap() + start;
    let consumer = &source[start..end];
    assert!(consumer.contains("kernel_thread_exit_in_table(pt, pid, tid, clear_child_tid != 0)"));
    assert!(consumer.contains(
        "query_lifecycle::effects::thread_exit(pt, &mut WasmHostIO, pid, tid, clear_child_tid)"
    ));
    assert!(!consumer.contains("proc_write_bytes"));
    assert!(!consumer.contains("futex_wake"));
}

#[test]
fn wasm32_high_ctid_remains_positive_but_out_of_width_pointer_is_contained() {
    for ptr in [0xffff_f100usize, 0x1_0000_0000usize] {
        let (mut table, mut host, pid, _, _guard) = fixture();
        let tid = table.create_thread(pid, pid, 0, 0, ptr).unwrap();
        let mut registry = IntentRegistry::for_test(1, 1);
        let handle = registry
            .admit(&table, thread_request(pid, tid, true))
            .unwrap();
        registry.step(handle, &mut table, &mut host).unwrap();
        let delivered = registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap();
        if ptr <= u32::MAX as usize {
            assert_eq!(
                delivered,
                Delivery::Delivered(Ok(Delivered::ThreadExit(ptr)))
            );
            assert!(ptr as i64 > 0);
            assert_eq!(host.writes, vec![(pid as i32, ptr as u64, vec![0; 4])]);
            registry.forget(handle).unwrap();
        } else {
            assert_eq!(delivered, Delivery::ProtocolFaultOwned);
            assert!(host.writes.is_empty());
            assert_eq!(registry.forget(handle), Err(Errno::EBUSY));
        }
    }
}
