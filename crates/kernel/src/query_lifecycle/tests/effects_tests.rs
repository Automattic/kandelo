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
        add_mapping(table, pid);
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
    crate::exchange::activation::reset();
    let child = table
        .create_init_child(vec![b"/effects-init-child".to_vec()])
        .unwrap();
    let (proc, locks) = table.process_and_advisory_locks(child).unwrap();
    syscalls::sys_exit_with_locks(proc, locks, &mut host, 42);
    add_mapping(table, child);
    let mut registry = IntentRegistry::for_test(1, 1);
    let handle = registry
        .admit(&table, Request::ReapInit { pid: child })
        .unwrap();
    registry.step(handle, &mut table, &mut host).unwrap();
    crate::exchange::activation::launched(child);
    crate::exchange::batches::take_notifications();
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
    assert!(crate::exchange::batches::take_notifications().is_empty());
    host.dri_phase = crate::dri_release::DriReleasePhase::Retired;
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::PendingPhysicalReceiver
    );
    assert!(crate::exchange::batches::take_notifications().is_empty());
    host.dri_phase = crate::dri_release::DriReleasePhase::Forgotten;
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::Delivered(Ok(Delivered::InitReaped {
            pid: child,
            status: 42,
            signal: 0
        }))
    );
    assert_eq!(
        crate::exchange::batches::take_notifications()
            .into_iter()
            .filter(|note| matches!(
                note,
                crate::exchange::batches::Notification::ActivationCheck
            ))
            .count(),
        1
    );
    registry
        .deliver_completion(handle, &mut table, &mut host)
        .unwrap();
    assert!(crate::exchange::batches::take_notifications().is_empty());
    registry.forget(handle).unwrap();
    crate::exchange::activation::reset();
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

fn add_mapping(table: &mut ProcessTable, pid: u32) {
    let bo = crate::dri::with_registry(|r| r.try_alloc(4, 4, 32).unwrap().id);
    table
        .get_mut(pid)
        .unwrap()
        .dri_bindings
        .push(crate::process::DriBoBinding {
            addr: 0x9000,
            len: 64,
            bo_offset: 0,
            bo_id: bo,
        });
}

#[test]
fn exact_physical_ack_and_forget_precede_actual_removal_tail_once() {
    use crate::dri_release::{DriReleaseControl as C, DriReleasePhase as P};
    let (mut table, mut host, pid, base, _guard) = fixture();
    let proc = table.get_mut(pid).unwrap();
    proc.ofd_table
        .create(FileType::Regular, O_RDONLY, base, b"/removal-tail".to_vec());
    proc.fb_binding = Some(crate::process::FbBinding {
        addr: 0x8000,
        len: 4,
        w: 1,
        h: 1,
        stride: 4,
        fmt: 0,
    });
    add_mapping(table, pid);
    let mut registry = IntentRegistry::for_test(1, 1);
    let handle = registry
        .admit(&table, Request::Remove { pid, reap: false })
        .unwrap();
    registry.step(handle, &mut table, &mut host).unwrap();
    assert!(table.get(pid).is_none());
    for _ in 0..2 {
        assert_eq!(
            registry
                .deliver_completion(handle, &mut table, &mut host)
                .unwrap(),
            Delivery::PendingPhysicalReceiver
        );
        assert!(host.closed.is_empty());
    }
    host.dri_wrong_token = true;
    host.dri_phase = P::Retired;
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::PendingPhysicalReceiver
    );
    assert!(host.closed.is_empty());
    host.dri_wrong_token = false;
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::PendingPhysicalReceiver
    );
    assert!(host.closed.is_empty());
    host.dri_phase = P::Forgotten;
    for _ in 0..2 {
        assert_eq!(
            registry
                .deliver_completion(handle, &mut table, &mut host)
                .unwrap(),
            Delivery::Delivered(Ok(Delivered::Removed))
        );
    }
    assert_eq!(host.closed, vec![0, 1, 2, base]);
    assert!(host.cleanup_order.ends_with(&[
        alloc::format!("close:{base}"),
        alloc::format!("framebuffer:{pid}")
    ]));
    assert_eq!(
        host.dri_calls.iter().map(|(_, c)| *c).collect::<Vec<_>>(),
        vec![C::Begin, C::Poll, C::Poll, C::Poll, C::Forget]
    );
    assert!(
        host.dri_calls
            .iter()
            .all(|(token, _)| *token == host.dri_calls[0].0)
    );
    registry.forget(handle).unwrap();
}

#[test]
fn uncertain_begin_is_polled_and_tail_trap_never_replays_close() {
    use crate::dri_release::{DriReleaseControl as C, DriReleasePhase as P};
    let (mut table, mut host, pid, base, _guard) = fixture();
    table.get_mut(pid).unwrap().ofd_table.create(
        FileType::Regular,
        O_RDONLY,
        base,
        b"/tail-trap".to_vec(),
    );
    add_mapping(table, pid);
    let mut registry = IntentRegistry::for_test(1, 1);
    let handle = registry
        .admit(&table, Request::Remove { pid, reap: false })
        .unwrap();
    registry.step(handle, &mut table, &mut host).unwrap();
    host.dri_error = true;
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::PendingPhysicalReceiver
    );
    host.dri_error = false;
    host.dri_phase = P::Retired;
    registry
        .deliver_completion(handle, &mut table, &mut host)
        .unwrap();
    host.dri_phase = P::Forgotten;
    host.trap_close = true;
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || registry.deliver_completion(handle, &mut table, &mut host)
        ))
        .is_err()
    );
    host.trap_close = false;
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::ProtocolFaultOwned
    );
    assert_eq!(host.closed, vec![0, 1, 2, base]);
    assert_eq!(
        host.dri_calls.iter().map(|(_, c)| *c).collect::<Vec<_>>(),
        vec![C::Begin, C::Poll, C::Forget]
    );
    assert_eq!(registry.forget(handle), Err(Errno::EBUSY));
}

#[test]
fn removal_without_graphics_needs_no_fabricated_device_ack() {
    let (mut table, mut host, pid, base, _guard) = fixture();
    table.get_mut(pid).unwrap().ofd_table.create(
        FileType::Regular,
        O_RDONLY,
        base,
        b"/plain".to_vec(),
    );
    let mut registry = IntentRegistry::for_test(1, 1);
    let handle = registry
        .admit(&table, Request::Remove { pid, reap: false })
        .unwrap();
    registry.step(handle, &mut table, &mut host).unwrap();
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::Delivered(Ok(Delivered::Removed))
    );
    assert_eq!(host.closed, vec![0, 1, 2, base]);
    assert!(host.dri_calls.is_empty());
    registry.forget(handle).unwrap();
}

#[test]
fn complete_dri_plan_is_frozen_and_unknown_controls_never_replay_begin() {
    use crate::dri_release::{
        DriReleaseControl as C, DriReleaseOwner, DriReleasePhase as P, DriReleaseProgress as S,
        DriReleaseTransaction,
    };
    use crate::syscalls::DriReleaseEffect as E;
    let (_, mut host, pid, _, _guard) = fixture();
    let effects = vec![
        E::UnbindBo {
            bo_id: 9,
            addr: 0x9000,
            len: 128,
        },
        E::UnbindGl {
            owner_pid: pid as i32 + 1,
            session_id: 31,
        },
        E::DropMaster {
            file_id: 0x100000001,
            lease_id: 0x200000001,
        },
        E::HideCursor {
            lease_id: 0x200000001,
            fb_id: 16,
        },
        E::DestroyBo(9),
        E::RemoveFramebuffer(16),
    ];
    let expected = alloc::format!("{:?}/{:?}", DriReleaseOwner { pid, generation: 4 }, effects);
    let mut tx = DriReleaseTransaction::new(DriReleaseOwner { pid, generation: 4 }, effects)
        .ok()
        .unwrap();
    host.dri_error = true;
    assert_eq!(tx.step(&mut host), S::Uncertain);
    host.dri_error = false;
    host.dri_wrong_token = true;
    host.dri_phase = P::Retired;
    assert_eq!(tx.step(&mut host), S::Uncertain);
    host.dri_wrong_token = false;
    assert_eq!(tx.step(&mut host), S::Pending);
    // Repeated physical retirement is not a metadata-release ACK.
    assert_eq!(tx.step(&mut host), S::Uncertain);
    host.dri_phase = P::Forgotten;
    assert_eq!(tx.step(&mut host), S::Complete);
    assert_eq!(tx.step(&mut host), S::Complete);
    assert_eq!(
        host.dri_calls.iter().map(|(_, c)| *c).collect::<Vec<_>>(),
        vec![C::Begin, C::Poll, C::Poll, C::Forget, C::Forget]
    );
    assert!(host.dri_plans.iter().all(|plan| plan == &expected));
    assert!(host.closed.is_empty());
}

#[test]
fn rejected_device_plan_is_not_retirement_and_never_runs_the_tail() {
    use crate::dri_release::DriReleasePhase as P;
    let (mut table, mut host, pid, base, _guard) = fixture();
    table.get_mut(pid).unwrap().ofd_table.create(
        FileType::Regular,
        O_RDONLY,
        base,
        b"/refused".to_vec(),
    );
    add_mapping(table, pid);
    let mut registry = IntentRegistry::for_test(1, 1);
    let handle = registry
        .admit(&table, Request::Remove { pid, reap: false })
        .unwrap();
    registry.step(handle, &mut table, &mut host).unwrap();
    host.dri_phase = P::Rejected(Errno::ENOMEM);
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::ProtocolFaultOwned
    );
    host.dri_phase = P::Retired;
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::ProtocolFaultOwned
    );
    assert_eq!(host.dri_calls.len(), 1);
    assert!(host.closed.is_empty());
    assert!(registry.held_effects(handle).unwrap().is_some());
    assert_eq!(registry.forget(handle), Err(Errno::EBUSY));
}

#[test]
fn adopted_published_child_uses_the_explicit_table_and_finishes_without_registry_reentry() {
    let (mut table, mut host, pid, base, _guard) = fixture();
    let child = table.fork_process_for_caller(pid, pid).unwrap();
    let (proc, locks) = table.process_and_advisory_locks(child).unwrap();
    syscalls::sys_exit_with_locks(proc, locks, &mut host, 23);
    table.publish_process_exit(child).unwrap();
    table.get_mut(pid).unwrap().ofd_table.create(
        FileType::Regular,
        O_RDONLY,
        base,
        b"/parent".to_vec(),
    );
    host.closed.clear();
    let mut registry = IntentRegistry::for_test(1, 1);
    let handle = registry
        .admit(&table, Request::Remove { pid, reap: false })
        .unwrap();
    registry.step(handle, &mut table, &mut host).unwrap();
    assert!(table.get(child).is_some());
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::Delivered(Ok(Delivered::Removed))
    );
    assert!(table.get(child).is_none());
    assert_eq!(host.closed, vec![0, 1, 2, base]);
    assert!(host.dri_calls.is_empty());
    registry.forget(handle).unwrap();
}

#[test]
fn child_physical_wait_is_owned_inside_parent_and_never_reenters_registry() {
    use crate::dri_release::{DriReleaseControl as C, DriReleasePhase as P};
    let (mut table, mut host, pid, base, _guard) = fixture();
    let child = table.fork_process_for_caller(pid, pid).unwrap();
    let (proc, locks) = table.process_and_advisory_locks(child).unwrap();
    syscalls::sys_exit_with_locks(proc, locks, &mut host, 29);
    // Exercise the removal backstop's actual retained mapping effect rather
    // than fabricating a native deletion ACK or invoking a recursive wrapper.
    add_mapping(table, child);
    table.publish_process_exit(child).unwrap();
    table.get_mut(pid).unwrap().ofd_table.create(
        FileType::Regular,
        O_RDONLY,
        base,
        b"/parent-pending".to_vec(),
    );
    host.closed.clear();
    let mut registry = IntentRegistry::for_test(1, 1);
    let handle = registry
        .admit(&table, Request::Remove { pid, reap: false })
        .unwrap();
    registry.step(handle, &mut table, &mut host).unwrap();
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::PendingPhysicalReceiver
    );
    assert!(table.get(child).is_none());
    assert_eq!(host.closed, vec![0, 1, 2, base]);
    assert_eq!(registry.forget(handle), Err(Errno::EBUSY));
    host.dri_phase = P::Retired;
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::PendingPhysicalReceiver
    );
    host.dri_phase = P::Forgotten;
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::Delivered(Ok(Delivered::Removed))
    );
    assert_eq!(host.closed, vec![0, 1, 2, base]);
    assert_eq!(
        host.dri_calls.iter().map(|(_, c)| *c).collect::<Vec<_>>(),
        vec![C::Begin, C::Poll, C::Forget]
    );
    registry.forget(handle).unwrap();
}

#[test]
fn ordered_tail_keeps_directory_file_framebuffer_network_order_and_returned_error_semantics() {
    use super::super::removal::{RemovalProgress, RemovalReceiver};
    use crate::dri_release::DriReleaseOwner;
    let (mut table, mut host, pid, base, _guard) = fixture();
    // Actual table removal supplies linear custody; explicit host handle lists
    // exercise the complete returned-effect contract against recording HostIO.
    let mut removal = table.remove_process(pid).unwrap();
    removal.host_dir_closes = vec![base, base + 1];
    removal.host_closes = vec![base + 2, base + 3];
    removal.had_framebuffer_binding = true;
    removal.host_net_closes = vec![71, 72];
    let mut receiver = RemovalReceiver::new(
        Completion::Removed(removal),
        DriReleaseOwner { pid, generation: 0 },
    )
    .ok()
    .unwrap();
    host.close_error = Some(Errno::EIO);
    assert!(matches!(
        receiver.step(&mut table, &mut host),
        RemovalProgress::Complete(_)
    ));
    assert_eq!(
        host.cleanup_order,
        vec![
            alloc::format!("close:{base}"),
            alloc::format!("close:{}", base + 1),
            alloc::format!("close:{}", base + 2),
            alloc::format!("close:{}", base + 3),
            alloc::format!("framebuffer:{pid}"),
            "net:71".into(),
            "net:72".into(),
        ]
    );
    assert!(matches!(
        receiver.step(&mut table, &mut host),
        RemovalProgress::Complete(_)
    ));
    assert_eq!(host.cleanup_order.len(), 7);
}

#[test]
fn trapped_dri_begin_keeps_same_transaction_and_never_reenters_begin() {
    use crate::dri_release::{
        DriReleaseControl as C, DriReleaseOwner, DriReleasePhase as P, DriReleaseProgress as S,
        DriReleaseTransaction,
    };
    let (_, mut host, pid, _, _guard) = fixture();
    let mut tx = DriReleaseTransaction::new(
        DriReleaseOwner { pid, generation: 1 },
        vec![syscalls::DriReleaseEffect::DestroyBo(91)],
    )
    .ok()
    .unwrap();
    host.dri_trap = true;
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| tx.step(&mut host))).is_err());
    host.dri_trap = false;
    host.dri_phase = P::Retired;
    assert_eq!(tx.step(&mut host), S::Pending);
    host.dri_phase = P::Forgotten;
    assert_eq!(tx.step(&mut host), S::Complete);
    assert_eq!(
        host.dri_calls.iter().map(|(_, c)| *c).collect::<Vec<_>>(),
        vec![C::Begin, C::Poll, C::Forget]
    );
}

#[test]
fn deeply_nested_published_adoptions_have_no_arbitrary_genealogy_limit() {
    let (mut table, mut host, pid, _, _guard) = fixture();
    let mut descendants = Vec::new();
    let mut parent = pid;
    for _ in 0..70 {
        let child = table.fork_process_for_caller(parent, parent).unwrap();
        descendants.push(child);
        parent = child;
    }
    // Stage actual table records as published zombies awaiting removal. This
    // deliberately preserves the deep relationship rather than running exit's
    // separate reparenting pass, so it tests the cleanup receiver's own bound.
    for &child in &descendants {
        let proc = table.get_mut(child).unwrap();
        proc.state = ProcessState::Exited;
        proc.exit_published = true;
    }
    let mut registry = IntentRegistry::for_test(1, 1);
    let handle = registry
        .admit(&table, Request::Remove { pid, reap: false })
        .unwrap();
    registry.step(handle, &mut table, &mut host).unwrap();
    assert_eq!(
        registry
            .deliver_completion(handle, &mut table, &mut host)
            .unwrap(),
        Delivery::Delivered(Ok(Delivered::Removed))
    );
    assert!(
        descendants
            .into_iter()
            .all(|child| table.get(child).is_none())
    );
    assert!(host.dri_calls.is_empty());
    registry.forget(handle).unwrap();
}
