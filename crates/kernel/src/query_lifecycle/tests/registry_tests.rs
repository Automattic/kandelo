use super::super::registry::{self, Completed, Handle, IntentRegistry, Status, TakenEffects};
use super::*;

fn receive_removal(effects: TakenEffects, host: &mut Host) -> u32 {
    let (owner, completion) = effects.into_parts();
    let Completion::Removed(removal) = completion.unwrap() else {
        panic!("actual removal custody");
    };
    assert!(!removal.had_framebuffer_binding);
    assert!(removal.host_net_closes.is_empty());
    assert!(removal.dri_effects.is_empty());
    assert!(removal.adopted_zombies.is_empty());
    for handle in removal
        .host_dir_closes
        .into_iter()
        .chain(removal.host_closes)
    {
        host.host_close(handle).unwrap();
    }
    owner.pid
}

#[test]
fn bounded_admission_and_tombstones_never_reuse_handles_or_touch_resources() {
    let (mut table, mut host, pid, _, _guard) = fixture();
    let request = Request::Exit {
        pid,
        tid: pid,
        status: 7,
        thread_worker: false,
    };
    let mut registry = IntentRegistry::for_test(1, 1);
    let first = registry.admit(&table, request).unwrap();
    assert_eq!(registry.admit(&table, request), Err(Errno::ENOSPC));
    assert!(host.controls.is_empty());
    assert!(host.closed.is_empty());
    assert_eq!(registry.forget(first), Err(Errno::EBUSY));
    assert_eq!(
        registry
            .abandon(first, &mut table, &mut host)
            .unwrap()
            .status,
        Status::Abandoned {
            query_cleanup_started: false,
            target_cancelled: false,
            invalidated: false
        }
    );
    registry.forget(first).unwrap();
    let second = registry.admit(&table, request).unwrap();
    assert!(second.raw() > first.raw());
    assert_eq!(registry.inspect(first).unwrap_err(), Errno::ENOENT);
    registry.abandon(second, &mut table, &mut host).unwrap();
    registry.forget(second).unwrap();
    assert_eq!(table.get(pid).unwrap().state, ProcessState::Running);
    let mut exhausted = IntentRegistry::for_test(1, i64::MAX);
    let last = exhausted.admit(&table, request).unwrap();
    assert_eq!(last.raw(), i64::MAX);
    exhausted.abandon(last, &mut table, &mut host).unwrap();
    exhausted.forget(last).unwrap();
    assert_eq!(exhausted.admit(&table, request), Err(Errno::EOVERFLOW));
    assert_eq!(Handle::from_raw(0), Err(Errno::EINVAL));
    assert_eq!(Handle::from_raw(-1), Err(Errno::EINVAL));
}

#[test]
fn completed_removal_keeps_actual_effects_until_linear_take() {
    for reap in [false, true] {
        let (mut table, mut host, pid, base, _guard) = fixture();
        let (token, idx) = admit(&mut table, &mut host, pid, pid, base);
        let mut registry = IntentRegistry::for_test(1, 1);
        let handle = registry
            .admit(&table, Request::Remove { pid, reap })
            .unwrap();
        pending(&mut host, token);
        assert_eq!(
            registry.step(handle, &mut table, &mut host).unwrap().status,
            Status::PendingOwned
        );
        assert_eq!(registry.forget(handle), Err(Errno::EBUSY));
        assert!(matches!(
            registry.take_completion(handle),
            Err(Errno::EBUSY)
        ));
        assert_eq!(
            table
                .get(pid)
                .unwrap()
                .ofd_table
                .get(idx)
                .unwrap()
                .ref_count,
            2
        );
        host.retired(token);
        assert_eq!(
            registry.step(handle, &mut table, &mut host).unwrap().status,
            Status::Complete(Ok(Completed::Removed))
        );
        let controls = host.controls.len();
        assert!(table.get(pid).is_none());
        assert!(host.closed.is_empty());
        assert_eq!(registry.forget(handle), Err(Errno::EBUSY));
        assert_eq!(
            registry.step(handle, &mut table, &mut host).unwrap().status,
            Status::Complete(Ok(Completed::Removed))
        );
        let effects = registry.take_completion(handle).unwrap();
        assert!(
            host.closed.is_empty(),
            "Take transfers custody; it does not execute effects"
        );
        assert_eq!(
            registry.inspect(handle).unwrap().status,
            Status::Taken(Ok(Completed::Removed))
        );
        assert!(matches!(
            registry.take_completion(handle),
            Err(Errno::EBUSY)
        ));
        assert_eq!(receive_removal(effects, &mut host), pid);
        assert_eq!(host.closed.iter().filter(|h| **h == base).count(), 1);
        assert_eq!(host.controls.len(), controls);
        // Even clean scalar tombstones count against the same bounded budget.
        let other = table.create_process().unwrap();
        assert_eq!(
            registry.admit(
                &table,
                Request::Remove {
                    pid: other,
                    reap: false
                }
            ),
            Err(Errno::ENOSPC)
        );
        registry.forget(handle).unwrap();
    }
}

#[test]
fn exact_thread_ctid_and_frozen_exit_status_are_owned_until_take() {
    for thread in [false, true] {
        let (mut table, mut host, pid, base, _guard) = fixture();
        let tid = if thread {
            table.create_thread(pid, pid, 0, 0, 0).unwrap()
        } else {
            pid
        };
        if thread {
            table
                .get_mut(pid)
                .unwrap()
                .get_thread_mut(tid)
                .unwrap()
                .ctid_ptr = 0x1234;
        }
        let (token, _) = admit(&mut table, &mut host, pid, tid, base);
        let mut registry = IntentRegistry::for_test(1, 1);
        let request = if thread {
            Request::ThreadExit { pid, tid }
        } else {
            Request::Exit {
                pid,
                tid,
                status: 0x12a,
                thread_worker: false,
            }
        };
        let handle = registry.admit(&table, request).unwrap();
        pending(&mut host, token);
        registry.step(handle, &mut table, &mut host).unwrap();
        assert!(matches!(
            registry.take_completion(handle),
            Err(Errno::EBUSY)
        ));
        if thread {
            assert_eq!(
                table.get(pid).unwrap().get_thread(tid).unwrap().ctid_ptr,
                0x1234
            );
        }
        host.retired(token);
        let snapshot = registry.step(handle, &mut table, &mut host).unwrap();
        let controls = host.controls.len();
        assert_eq!(snapshot.owner.pid, pid);
        assert_eq!(snapshot.owner.generation, 0);
        let (owner, completion) = registry.take_completion(handle).unwrap().into_parts();
        assert_eq!(owner.pid, pid);
        match completion.unwrap() {
            Completion::ThreadExit(pointer) if thread => assert_eq!(pointer, 0x1234),
            Completion::Exit(status) if !thread => assert_eq!(status, 0x2a),
            _ => panic!("linear exact completion"),
        }
        assert!(matches!(
            registry.take_completion(handle),
            Err(Errno::EBUSY)
        ));
        registry.step(handle, &mut table, &mut host).unwrap();
        assert_eq!(host.controls.len(), controls);
        registry.forget(handle).unwrap();
    }
}

#[test]
fn unstarted_exec_abandonment_cancels_actual_target_for_process_and_spawn() {
    for spawn in [false, true] {
        let (mut table, mut host, parent, base, _guard) = fixture();
        let pid = if spawn {
            table.fork_process_for_caller(parent, parent).unwrap()
        } else {
            parent
        };
        let owner = if spawn {
            PreparedExecOwner::Spawn {
                parent_pid: parent,
                child_pid: pid,
                launch: 0,
            }
        } else {
            PreparedExecOwner::Process {
                pid,
                caller_tid: pid,
                generation: 0,
            }
        };
        let (target, idx) = prepare(&mut table, pid, owner, base);
        let request = if spawn {
            Request::SpawnExec {
                parent,
                child: pid,
                target,
            }
        } else {
            Request::Exec {
                pid,
                tid: pid,
                target,
            }
        };
        let mut registry = IntentRegistry::for_test(1, 1);
        let handle = registry.admit(&table, request).unwrap();
        assert_eq!(
            registry
                .abandon(handle, &mut table, &mut host)
                .unwrap()
                .status,
            Status::Abandoned {
                query_cleanup_started: false,
                target_cancelled: true,
                invalidated: false
            }
        );
        assert!(
            table
                .get(pid)
                .unwrap()
                .prepared_exec_targets
                .get(target)
                .is_err()
        );
        assert!(table.get(pid).unwrap().ofd_table.get(idx).is_none());
        assert_eq!(table.get(pid).unwrap().exec_generation, 0);
        assert_eq!(host.closed, [base]);
        registry.abandon(handle, &mut table, &mut host).unwrap();
        registry.step(handle, &mut table, &mut host).unwrap();
        assert_eq!(host.closed, [base]);
        registry.forget(handle).unwrap();
    }
}

#[test]
fn abandoning_started_exec_keeps_cleanup_authority_until_ack_and_never_commits() {
    let (mut table, mut host, pid, base, _guard) = fixture();
    let (target, target_idx) = prepare(
        &mut table,
        pid,
        PreparedExecOwner::Process {
            pid,
            caller_tid: pid,
            generation: 0,
        },
        base,
    );
    let (token, query_idx) = admit(&mut table, &mut host, pid, pid, base + 1);
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
    pending(&mut host, token);
    registry.step(handle, &mut table, &mut host).unwrap();
    host.replies.push_back(Ok(vec![0; 32]));
    assert_eq!(
        registry
            .abandon(handle, &mut table, &mut host)
            .unwrap()
            .status,
        Status::Abandoning {
            query_cleanup_started: true,
            fault: true
        }
    );
    assert_eq!(registry.forget(handle), Err(Errno::EBUSY));
    assert!(matches!(
        registry.take_completion(handle),
        Err(Errno::EBUSY)
    ));
    assert!(
        table
            .get(pid)
            .unwrap()
            .prepared_exec_targets
            .get(target)
            .is_ok()
    );
    assert!(table.get(pid).unwrap().ofd_table.get(target_idx).is_some());
    assert_eq!(
        table
            .get(pid)
            .unwrap()
            .ofd_table
            .get(query_idx)
            .unwrap()
            .ref_count,
        2
    );
    assert!(host.closed.is_empty());
    pending(&mut host, token);
    assert_eq!(
        registry.step(handle, &mut table, &mut host).unwrap().status,
        Status::Abandoning {
            query_cleanup_started: true,
            fault: false
        }
    );
    host.retired(token);
    assert_eq!(
        registry.step(handle, &mut table, &mut host).unwrap().status,
        Status::Abandoned {
            query_cleanup_started: true,
            target_cancelled: true,
            invalidated: false
        }
    );
    assert_eq!(table.get(pid).unwrap().exec_generation, 0);
    assert!(table.get(pid).unwrap().exe.is_none());
    assert_eq!(host.closed, [base]);
    assert!(
        !table
            .get(pid)
            .unwrap()
            .blocked_retries
            .has_external_query_receipts()
    );
    // Guest syscall completion still owns its terminal binding/pin. Registry
    // abandonment does not silently release it or claim guest resumption.
    assert!(
        table
            .get(pid)
            .unwrap()
            .blocked_retries
            .binding_for_token(token)
            .is_some()
    );
    registry.forget(handle).unwrap();
}

#[test]
fn unstarted_ordinary_abandonment_leaves_independent_query_owned_and_running() {
    let (mut table, mut host, pid, base, _guard) = fixture();
    let (token, _) = admit(&mut table, &mut host, pid, pid, base);
    let mut registry = IntentRegistry::for_test(1, 1);
    let handle = registry
        .admit(
            &table,
            Request::Exit {
                pid,
                tid: pid,
                status: 3,
                thread_worker: false,
            },
        )
        .unwrap();
    assert_eq!(
        registry
            .abandon(handle, &mut table, &mut host)
            .unwrap()
            .status,
        Status::Abandoned {
            query_cleanup_started: false,
            target_cancelled: false,
            invalidated: false
        }
    );
    registry.forget(handle).unwrap();
    assert_eq!(host.controls, [Control::Begin]);
    assert!(
        table
            .get(pid)
            .unwrap()
            .blocked_retries
            .has_external_query_receipts()
    );
    assert_eq!(table.get(pid).unwrap().state, ProcessState::Running);
    host.retired(token);
    let (proc, locks) = table.process_and_advisory_locks(pid).unwrap();
    syscalls::release_blocking_retry_binding(proc, locks, &mut host, pid, token).unwrap();
}

#[test]
fn old_generation_and_absent_pid_do_not_cancel_replacement_resources() {
    let (mut table, mut host, pid, base, _guard) = fixture();
    let mut registry = IntentRegistry::for_test(3, 1);
    let stale = registry
        .admit(&table, Request::Remove { pid, reap: false })
        .unwrap();
    let (old_target, _) = prepare(
        &mut table,
        pid,
        PreparedExecOwner::Process {
            pid,
            caller_tid: pid,
            generation: 0,
        },
        base,
    );
    let old_exec = registry
        .admit(
            &table,
            Request::Exec {
                pid,
                tid: pid,
                target: old_target,
            },
        )
        .unwrap();
    let (replacement, _) = prepare(
        &mut table,
        pid,
        PreparedExecOwner::Process {
            pid,
            caller_tid: pid,
            generation: 0,
        },
        base + 1,
    );
    legacy(
        &mut table,
        &mut host,
        Request::Exec {
            pid,
            tid: pid,
            target: replacement,
        },
    )
    .unwrap();
    assert_eq!(table.get(pid).unwrap().exec_generation, 1);
    let (token, _) = admit(&mut table, &mut host, pid, pid, base + 2);
    assert_eq!(
        registry.step(stale, &mut table, &mut host).unwrap().status,
        Status::Complete(Err(Errno::ESRCH))
    );
    assert_eq!(
        registry
            .abandon(old_exec, &mut table, &mut host)
            .unwrap()
            .status,
        Status::Abandoned {
            query_cleanup_started: false,
            target_cancelled: false,
            invalidated: true
        }
    );
    assert_eq!(host.controls, [Control::Begin]);
    let (_, failure) = registry.take_completion(stale).unwrap().into_parts();
    assert!(matches!(failure, Err(Errno::ESRCH)));
    registry.forget(stale).unwrap();
    registry.forget(old_exec).unwrap();
    host.retired(token);
    let (proc, locks) = table.process_and_advisory_locks(pid).unwrap();
    syscalls::release_blocking_retry_binding(proc, locks, &mut host, pid, token).unwrap();
    // Removal invalidates the old PID; the real global allocator never reuses
    // that identity, even when a fresh process starts at generation zero.
    let absent = registry
        .admit(&table, Request::Remove { pid, reap: false })
        .unwrap();
    let removal = legacy(&mut table, &mut host, Request::Remove { pid, reap: false }).unwrap();
    let Completion::Removed(removal) = removal else {
        panic!("actual remove");
    };
    for handle in removal.host_closes {
        host.host_close(handle).unwrap();
    }
    let next_pid = table.create_process().unwrap();
    assert_ne!(next_pid, pid);
    assert_eq!(
        registry.step(absent, &mut table, &mut host).unwrap().status,
        Status::Complete(Err(Errno::ESRCH))
    );
    let (_, failure) = registry.take_completion(absent).unwrap().into_parts();
    assert!(matches!(failure, Err(Errno::ESRCH)));
    registry.forget(absent).unwrap();
    assert_eq!(table.get(next_pid).unwrap().state, ProcessState::Running);
}

#[test]
fn preconsumption_refusal_remains_owned_and_retryable() {
    let (mut table, mut host, pid, base, _guard) = fixture();
    let (token, _) = admit(&mut table, &mut host, pid, pid, base);
    let mut registry = IntentRegistry::for_test(1, 1);
    let handle = registry
        .admit(
            &table,
            Request::ReleaseRetry {
                pid,
                tid: pid,
                token,
            },
        )
        .unwrap();
    table
        .get_mut(pid)
        .unwrap()
        .blocked_retries
        .activate(pid, token, BlockingRetryOperation::GlQuery)
        .unwrap();
    assert_eq!(
        registry.step(handle, &mut table, &mut host).unwrap().status,
        Status::Refused(Errno::EBUSY)
    );
    assert_eq!(host.controls, [Control::Begin]);
    assert_eq!(registry.forget(handle), Err(Errno::EBUSY));
    assert!(matches!(
        registry.take_completion(handle),
        Err(Errno::EBUSY)
    ));
    table.get_mut(pid).unwrap().blocked_retries.clear_active();
    host.retired(token);
    assert_eq!(
        registry.step(handle, &mut table, &mut host).unwrap().status,
        Status::Complete(Ok(Completed::RetryReleased))
    );
    let (_, result) = registry.take_completion(handle).unwrap().into_parts();
    assert!(matches!(result, Ok(Completion::RetryReleased)));
    registry.forget(handle).unwrap();
}

#[test]
fn completed_exec_and_consuming_failure_are_stable_until_take() {
    for success in [false, true] {
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
        if !success {
            let (proc, locks) = table.process_and_advisory_locks(pid).unwrap();
            crate::exec_target::cancel(proc, locks, &mut host, pid, target).unwrap();
        }
        let expected = if success {
            Status::Complete(Ok(Completed::Exec))
        } else {
            Status::Complete(Err(Errno::EINVAL))
        };
        assert_eq!(
            registry.step(handle, &mut table, &mut host).unwrap().status,
            expected
        );
        let closed = host.closed.len();
        assert_eq!(
            registry.abandon(handle, &mut table, &mut host).unwrap_err(),
            Errno::EBUSY
        );
        assert_eq!(
            registry.step(handle, &mut table, &mut host).unwrap().status,
            expected
        );
        assert_eq!(host.closed.len(), closed);
        let (owner, result) = registry.take_completion(handle).unwrap().into_parts();
        assert_eq!(owner.generation, 0);
        if success {
            assert!(matches!(result, Ok(Completion::Exec)));
        } else {
            assert!(matches!(result, Err(Errno::EINVAL)));
        }
        registry.forget(handle).unwrap();
    }
}

#[test]
fn registry_reentry_is_fallible_and_invalid_exec_authority_has_no_effects() {
    let (mut table, mut host, pid, base, _guard) = fixture();
    assert_eq!(
        registry::with_registry(|_| registry::with_registry(|_| ())).unwrap(),
        Err(Errno::EBUSY)
    );
    let tid = table.create_thread(pid, pid, 0, 0, 0).unwrap();
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
    assert_eq!(
        registry.admit(&table, Request::Exec { pid, tid, target }),
        Err(Errno::EINVAL)
    );
    assert!(
        table
            .get(pid)
            .unwrap()
            .prepared_exec_targets
            .get(target)
            .is_ok()
    );
    assert!(host.closed.is_empty());
    assert!(host.controls.is_empty());
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
    assert_eq!(
        handle.raw(),
        1,
        "failed admission does not consume a handle"
    );
    registry.abandon(handle, &mut table, &mut host).unwrap();
    registry.forget(handle).unwrap();
}

#[test]
fn actual_kernel_registry_enforces_the_complete_64_entry_budget() {
    let (mut table, mut host, pid, _, _guard) = fixture();
    registry::with_registry(|registry| {
        let request = Request::Exit {
            pid,
            tid: pid,
            status: 1,
            thread_worker: false,
        };
        let mut handles = Vec::new();
        for _ in 0..64 {
            handles.push(registry.admit(&table, request).unwrap());
        }
        assert_eq!(registry.admit(&table, request), Err(Errno::ENOSPC));
        assert!(host.controls.is_empty());
        assert_eq!(table.get(pid).unwrap().state, ProcessState::Running);
        for handle in handles {
            assert_eq!(registry.inspect(handle).unwrap().handle, handle);
            registry.abandon(handle, &mut table, &mut host).unwrap();
            registry.forget(handle).unwrap();
        }
        assert!(host.closed.is_empty());
    })
    .unwrap();
}

#[test]
fn init_reap_retains_the_actual_child_completion_until_take() {
    let (mut table, mut host, _, _, _guard) = fixture();
    let child = table
        .create_init_child(vec![b"/init-registry-child".to_vec()])
        .unwrap();
    let mut registry = IntentRegistry::for_test(1, 1);
    assert_eq!(
        registry.admit(&table, Request::ReapInit { pid: child }),
        Err(Errno::ECHILD)
    );
    let (proc, locks) = table.process_and_advisory_locks(child).unwrap();
    syscalls::sys_exit_with_locks(proc, locks, &mut host, 42);
    let handle = registry
        .admit(&table, Request::ReapInit { pid: child })
        .unwrap();
    assert_eq!(
        registry.step(handle, &mut table, &mut host).unwrap().status,
        Status::Complete(Ok(Completed::InitReaped {
            pid: child,
            status: 42,
            signal: 0
        }))
    );
    assert!(table.get(child).is_none());
    assert_eq!(registry.forget(handle), Err(Errno::EBUSY));
    let (owner, result) = registry.take_completion(handle).unwrap().into_parts();
    assert!(matches!(owner.request, Request::ReapInit {pid} if pid == child));
    let Completion::InitReaped(reap) = result.unwrap() else {
        panic!("actual init reap custody");
    };
    assert_eq!(
        (reap.pid, reap.exit_status, reap.exit_signal),
        (child, 42, 0)
    );
    assert!(reap.removal.host_closes.is_empty());
    assert!(reap.removal.host_dir_closes.is_empty());
    assert!(reap.removal.host_net_closes.is_empty());
    assert!(reap.removal.dri_effects.is_empty());
    assert!(reap.removal.adopted_zombies.is_empty());
    registry.forget(handle).unwrap();
}
