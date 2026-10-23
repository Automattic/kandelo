use super::*;
use wasm_posix_shared::epoll::*;

fn batch(p: &mut Process, h: &mut MockHostIO, ep: i32, max: i32) -> Vec<(u32, u64)> {
    sys_epoll_pwait(p, h, ep, max, 0, None).unwrap().1
}

#[test]
fn epoll_pwait_mask_ready_and_zero_timeout_restore_before_pending_signal() {
    use crate::signal::{sig_bit, SignalMaskWaitKind};
    use wasm_posix_shared::signal::SIGUSR1;

    for preinstalled in [false, true] {
        for ready in [false, true] {
            let mut p = Process::new(119);
            let mut h = MockHostIO::new();
            let tid = current_tid_for_process(&p);
            let original = sig_bit(SIGUSR1);
            p.set_blocked_for(tid, original);
            assert!(p.raise_signal(SIGUSR1));
            let ep = sys_epoll_create1(&mut p, 0).unwrap();
            let fd = sys_eventfd2(&mut p, u32::from(ready), 0).unwrap();
            sys_epoll_ctl(&mut p, ep, 1, fd, EPOLLIN | EPOLLET | EPOLLONESHOT, 9).unwrap();
            let mask = if preinstalled {
                p.enter_signal_mask_wait_for(tid, SignalMaskWaitKind::EpollPwait, 0);
                None
            } else {
                Some(0)
            };
            let result = sys_epoll_pwait(&mut p, &mut h, ep, 1, 0, mask).unwrap();
            assert_eq!(result.1, if ready { vec![(EPOLLIN, 9)] } else { vec![] });
            assert_eq!(p.blocked_for(tid), original);
            assert_eq!(p.mask_wait_depth_for(tid), 0);
            assert!(p.signal_pending_for(tid, SIGUSR1));
            assert_eq!(p.deliverable_for(tid), 0);

            // A completed ready batch stays consumed. Only a subsequent
            // blocking call with the temporary mask can deliver this signal.
            assert_eq!(
                sys_epoll_pwait(&mut p, &mut h, ep, 1, -1, Some(0)),
                Err(Errno::EINTR)
            );
            assert_eq!(p.blocked_for(tid), 0);
            assert_eq!(p.mask_wait_depth_for(tid), 1);
            p.finish_signal_mask_wait_for(tid, SignalMaskWaitKind::EpollPwait);
        }
    }
}

#[test]
fn epoll_pwait_mask_validation_errors_restore_host_scope() {
    use crate::signal::{sig_bit, SignalMaskWaitKind};
    use wasm_posix_shared::signal::SIGUSR1;

    for preinstalled in [false, true] {
        let mut p = Process::new(120);
        let mut h = MockHostIO::new();
        let tid = current_tid_for_process(&p);
        let original = sig_bit(SIGUSR1);
        p.set_blocked_for(tid, original);
        assert!(p.raise_signal(SIGUSR1));
        let ep = sys_epoll_create1(&mut p, 0).unwrap();
        for (fd, max, error) in [(-1, 1, Errno::EBADF), (ep, 0, Errno::EINVAL)] {
            let mask = if preinstalled {
                p.enter_signal_mask_wait_for(tid, SignalMaskWaitKind::EpollPwait, 0);
                None
            } else {
                Some(0)
            };
            assert_eq!(
                sys_epoll_pwait(&mut p, &mut h, fd, max, -1, mask),
                Err(error)
            );
            assert_eq!(p.blocked_for(tid), original);
            assert_eq!(p.mask_wait_depth_for(tid), 0);
            assert!(p.signal_pending_for(tid, SIGUSR1));
            assert!(p.epoll_waits.is_empty());
        }
    }
}

#[test]
fn epoll_edges_track_new_arrivals_without_a_not_ready_wait() {
    let mut p = Process::new(100);
    let mut h = MockHostIO::new();
    let (r, w) = sys_pipe2(&mut p, O_NONBLOCK).unwrap();
    let ep = sys_epoll_create1(&mut p, 0).unwrap();
    sys_write(&mut p, &mut h, w, b"a").unwrap();
    sys_epoll_ctl(&mut p, ep, 1, r, EPOLLIN | EPOLLET, 0xfedc_ba98_7654_3210).unwrap();
    assert_eq!(
        batch(&mut p, &mut h, ep, 1),
        [(EPOLLIN, 0xfedc_ba98_7654_3210)]
    );
    assert!(batch(&mut p, &mut h, ep, 1).is_empty());
    sys_write(&mut p, &mut h, w, b"b").unwrap();
    assert_eq!(
        batch(&mut p, &mut h, ep, 1).len(),
        1,
        "new arrival while still readable"
    );
    let mut buf = [0; 8];
    assert_eq!(sys_read(&mut p, &mut h, r, &mut buf), Ok(2));
    assert_eq!(sys_read(&mut p, &mut h, r, &mut buf), Err(Errno::EAGAIN));
    sys_write(&mut p, &mut h, w, b"c").unwrap();
    assert_eq!(
        batch(&mut p, &mut h, ep, 1).len(),
        1,
        "drain/refill between waits"
    );
    sys_write(&mut p, &mut h, w, b"d").unwrap();
    sys_read(&mut p, &mut h, r, &mut buf).unwrap();
    assert!(
        batch(&mut p, &mut h, ep, 1).is_empty(),
        "stale candidates are rechecked"
    );
}

#[test]
fn epoll_oneshot_disables_and_mod_rearms_already_ready_state() {
    for mode in [0, EPOLLET] {
        let mut p = Process::new(101);
        let mut h = MockHostIO::new();
        let fd = sys_eventfd2(&mut p, 1, 0).unwrap();
        let ep = sys_epoll_create1(&mut p, 0).unwrap();
        sys_epoll_ctl(&mut p, ep, 1, fd, EPOLLIN | EPOLLONESHOT | mode, 7).unwrap();
        assert_eq!(batch(&mut p, &mut h, ep, 8), [(EPOLLIN, 7)]);
        sys_write(&mut p, &mut h, fd, &1u64.to_le_bytes()).unwrap();
        assert!(batch(&mut p, &mut h, ep, 8).is_empty());
        sys_epoll_ctl(&mut p, ep, 3, fd, EPOLLIN | EPOLLONESHOT | mode, 8).unwrap();
        assert_eq!(batch(&mut p, &mut h, ep, 8), [(EPOLLIN, 8)]);
    }
}

#[test]
fn epoll_eventfd_read_wakes_writers_without_fabricating_a_read_edge() {
    let mut p = Process::new(102);
    let mut h = MockHostIO::new();
    let fd = sys_eventfd2(&mut p, 2, 1).unwrap();
    let ep = sys_epoll_create1(&mut p, 0).unwrap();
    sys_epoll_ctl(&mut p, ep, 1, fd, EPOLLIN | EPOLLET, 1).unwrap();
    assert_eq!(batch(&mut p, &mut h, ep, 1).len(), 1);
    sys_read(&mut p, &mut h, fd, &mut [0; 8]).unwrap();
    assert!(batch(&mut p, &mut h, ep, 1).is_empty());
    sys_write(&mut p, &mut h, fd, &1u64.to_le_bytes()).unwrap();
    assert_eq!(batch(&mut p, &mut h, ep, 1).len(), 1);
}

#[test]
fn epoll_level_batches_round_robin_and_do_not_duplicate_an_interest() {
    let mut p = Process::new(103);
    let mut h = MockHostIO::new();
    let ep = sys_epoll_create1(&mut p, 0).unwrap();
    for tag in 1..=3 {
        let fd = sys_eventfd2(&mut p, 1, 0).unwrap();
        sys_epoll_ctl(&mut p, ep, 1, fd, EPOLLIN, tag).unwrap();
    }
    let seen: Vec<u64> = (0..6).map(|_| batch(&mut p, &mut h, ep, 1)[0].1).collect();
    assert_eq!(seen, [1, 2, 3, 1, 2, 3]);
    assert_eq!(batch(&mut p, &mut h, ep, 99).len(), 3);
}

#[test]
fn epoll_socket_write_band_edges_follow_backpressure_and_receiver_lifetime() {
    for kind in [1, 2] {
        for close_receiver in [false, true] {
            let mut p = Process::new(123);
            let mut h = MockHostIO::new();
            let (a, b) = sys_socketpair(&mut p, &mut h, 1, kind | 0x800, 0).unwrap();
            let data = [1; 4096];
            for _ in 0..1024 {
                match sys_write(&mut p, &mut h, a, &data) {
                    Ok(n) => assert!(n > 0),
                    Err(Errno::EAGAIN) => break,
                    other => panic!("unexpected fill result: {other:?}"),
                }
            }
            assert_eq!(sys_write(&mut p, &mut h, a, &data), Err(Errno::EAGAIN));
            let ep = sys_epoll_create1(&mut p, 0).unwrap();
            sys_epoll_ctl(&mut p, ep, 1, a, EPOLLWRBAND | EPOLLET, 10).unwrap();
            assert!(batch(&mut p, &mut h, ep, 1).is_empty());
            if close_receiver {
                let alias = sys_dup(&mut p, b).unwrap();
                sys_close(&mut p, &mut h, b).unwrap();
                assert!(batch(&mut p, &mut h, ep, 1).is_empty());
                sys_close(&mut p, &mut h, alias).unwrap();
            } else {
                loop {
                    match sys_read(&mut p, &mut h, b, &mut [0; 4096]) {
                        Ok(n) => assert!(n > 0),
                        Err(Errno::EAGAIN) => break,
                        other => panic!("unexpected drain result: {other:?}"),
                    }
                }
            }
            let ready = batch(&mut p, &mut h, ep, 1);
            assert_eq!(ready.len(), 1, "kind={kind} close={close_receiver}");
            assert_ne!(ready[0].0 & EPOLLWRBAND, 0);
            assert_eq!(ready[0].1, 10);
        }
    }
}

#[test]
fn epoll_socket_shutdown_reports_linux_ready_masks() {
    let writable = EPOLLOUT | EPOLLWRNORM | EPOLLWRBAND;
    let readable = EPOLLIN | EPOLLRDNORM | EPOLLRDHUP;
    for kind in [1, 2] {
        for (side, how, mut expected) in [
            (0, 0, readable | writable),
            (0, 1, writable),
            (0, 2, readable | writable | EPOLLHUP),
            (1, 0, writable),
            (1, 1, readable | writable),
            (1, 2, readable | writable | EPOLLHUP),
            (1, 3, readable | writable | EPOLLHUP),
        ] {
            if kind == 2 && side == 1 {
                expected = writable;
            }
            let mut p = Process::new(121);
            let mut h = MockHostIO::new();
            let (a, b) = sys_socketpair(&mut p, &mut h, 1, kind | 0x800, 0).unwrap();
            let ep = sys_epoll_create1(&mut p, 0).unwrap();
            sys_epoll_ctl(&mut p, ep, 1, a, readable | writable, 7).unwrap();
            let target = if side == 0 { a } else { b };
            if how == 3 {
                sys_close(&mut p, &mut h, target).unwrap();
            } else {
                sys_shutdown(&mut p, &mut h, target, how).unwrap();
            }
            assert_eq!(
                batch(&mut p, &mut h, ep, 1),
                [(expected, 7)],
                "kind={kind} side={side} how={how}"
            );
        }
    }
}

#[test]
fn epoll_unconnected_socket_masks_match_the_protocol() {
    for domain in [1, 2] {
        for kind in [1, 2] {
            let mut p = Process::new(122);
            let mut h = MockHostIO::new();
            let fd = sys_socket(&mut p, &mut h, domain, kind | 0x800, 0).unwrap();
            let ep = sys_epoll_create1(&mut p, 0).unwrap();
            let requested =
                EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLRDNORM | EPOLLWRNORM | EPOLLWRBAND;
            sys_epoll_ctl(&mut p, ep, 1, fd, requested, 8).unwrap();
            let mut expected = EPOLLOUT | EPOLLWRNORM;
            if domain == 1 || kind == 2 {
                expected |= EPOLLWRBAND;
            }
            if kind == 1 {
                expected |= EPOLLHUP;
            }
            assert_eq!(
                batch(&mut p, &mut h, ep, 1),
                [(expected, 8)],
                "domain={domain} kind={kind}"
            );
        }
    }
}

#[test]
fn epoll_half_close_is_requested_rdhup_not_full_hangup() {
    let mut p = Process::new(104);
    let mut h = MockHostIO::new();
    let (a, b) = sys_socketpair(&mut p, &mut h, 1, 1 | 0x800, 0).unwrap();
    let ep = sys_epoll_create1(&mut p, 0).unwrap();
    sys_epoll_ctl(
        &mut p,
        ep,
        1,
        a,
        EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLET,
        1,
    )
    .unwrap();
    assert_eq!(batch(&mut p, &mut h, ep, 1), [(EPOLLOUT, 1)]);
    sys_write(&mut p, &mut h, b, b"x").unwrap();
    sys_shutdown(&mut p, &mut h, b, 1).unwrap();
    let events = batch(&mut p, &mut h, ep, 1)[0].0;
    assert_eq!(events, EPOLLIN | EPOLLOUT | EPOLLRDHUP);
    sys_read(&mut p, &mut h, a, &mut [0; 1]).unwrap();
    assert_eq!(sys_read(&mut p, &mut h, a, &mut [0; 1]), Ok(0));
    sys_epoll_ctl(&mut p, ep, 3, a, EPOLLIN, 2).unwrap();
    assert_eq!(batch(&mut p, &mut h, ep, 1), [(EPOLLIN, 2)]);
    sys_close(&mut p, &mut h, b).unwrap();
    assert_eq!(batch(&mut p, &mut h, ep, 1)[0].0, EPOLLIN | EPOLLHUP);
}

#[test]
fn epoll_hup_err_and_normal_alias_bits_preserve_requested_masks() {
    let mut p = Process::new(105);
    let mut h = MockHostIO::new();
    let (r, w) = sys_pipe2(&mut p, 0).unwrap();
    let ep = sys_epoll_create1(&mut p, 0).unwrap();
    sys_epoll_ctl(&mut p, ep, 1, r, EPOLLRDNORM, 1).unwrap();
    sys_write(&mut p, &mut h, w, b"x").unwrap();
    assert_eq!(batch(&mut p, &mut h, ep, 1), [(EPOLLRDNORM, 1)]);
    sys_close(&mut p, &mut h, w).unwrap();
    assert_eq!(batch(&mut p, &mut h, ep, 1), [(EPOLLRDNORM | EPOLLHUP, 1)]);
    let (r, w) = sys_pipe2(&mut p, 0).unwrap();
    sys_epoll_ctl(&mut p, ep, 1, w, 0, 2).unwrap();
    sys_close(&mut p, &mut h, r).unwrap();
    assert!(batch(&mut p, &mut h, ep, 8).contains(&(EPOLLERR, 2)));
}

#[test]
fn epoll_rejects_self_alias_cycles_and_excess_depth() {
    let mut p = Process::new(106);
    let a = sys_epoll_create1(&mut p, 0).unwrap();
    let alias = sys_dup(&mut p, a).unwrap();
    assert_eq!(
        sys_epoll_ctl(&mut p, a, 1, alias, EPOLLIN, 1),
        Err(Errno::EINVAL)
    );
    let b = sys_epoll_create1(&mut p, 0).unwrap();
    sys_epoll_ctl(&mut p, a, 1, b, EPOLLIN, 1).unwrap();
    assert_eq!(
        sys_epoll_ctl(&mut p, b, 1, a, EPOLLIN, 1),
        Err(Errno::ELOOP)
    );
    let mut prev = b;
    for _ in 0..3 {
        let next = sys_epoll_create1(&mut p, 0).unwrap();
        sys_epoll_ctl(&mut p, prev, 1, next, EPOLLIN, 1).unwrap();
        prev = next;
    }
    let sixth = sys_epoll_create1(&mut p, 0).unwrap();
    assert_eq!(
        sys_epoll_ctl(&mut p, prev, 1, sixth, EPOLLIN, 1),
        Err(Errno::ELOOP)
    );
}

#[test]
fn epoll_nested_oneshot_and_edges_are_pollable_without_consuming() {
    let mut p = Process::new(107);
    let mut h = MockHostIO::new();
    let fd = sys_eventfd2(&mut p, 1, 0).unwrap();
    let inner = sys_epoll_create1(&mut p, 0).unwrap();
    let outer = sys_epoll_create1(&mut p, 0).unwrap();
    sys_epoll_ctl(&mut p, inner, 1, fd, EPOLLIN | EPOLLONESHOT, 1).unwrap();
    sys_epoll_ctl(&mut p, outer, 1, inner, EPOLLIN | EPOLLET, 2).unwrap();
    assert_eq!(batch(&mut p, &mut h, outer, 1), [(EPOLLIN, 2)]);
    assert_eq!(batch(&mut p, &mut h, inner, 1), [(EPOLLIN, 1)]);
    assert!(batch(&mut p, &mut h, outer, 1).is_empty());
    sys_epoll_ctl(&mut p, inner, 3, fd, EPOLLIN | EPOLLONESHOT, 3).unwrap();
    assert_eq!(batch(&mut p, &mut h, outer, 1), [(EPOLLIN, 2)]);
}

#[test]
fn epoll_rejects_unpollable_files_and_invalid_exclusive_combinations() {
    let mut p = Process::new(108);
    let ep = sys_epoll_create1(&mut p, 0).unwrap();
    let mem = sys_memfd_create(&mut p, b"unpollable", 0).unwrap();
    assert_eq!(
        sys_epoll_ctl(&mut p, ep, 1, mem, EPOLLIN, 1),
        Err(Errno::EPERM)
    );
    let fd = sys_eventfd2(&mut p, 0, 0).unwrap();
    for bits in [EPOLLONESHOT, EPOLLRDHUP, EPOLLPRI, EPOLLRDNORM] {
        assert_eq!(
            sys_epoll_ctl(&mut p, ep, 1, fd, EPOLLEXCLUSIVE | bits, 1),
            Err(Errno::EINVAL)
        );
    }
    sys_epoll_ctl(&mut p, ep, 1, fd, EPOLLIN | EPOLLEXCLUSIVE, 1).unwrap();
    assert_eq!(
        sys_epoll_ctl(&mut p, ep, 3, fd, EPOLLIN, 1),
        Err(Errno::EINVAL)
    );
    sys_epoll_ctl(&mut p, ep, 2, fd, 0, 0).unwrap();
}

#[test]
fn epoll_wait_keeps_description_when_another_thread_reuses_its_fd() {
    let mut p = Process::new(109);
    let mut h = MockHostIO::new();
    let fd = sys_eventfd2(&mut p, 0, 0).unwrap();
    let ep = sys_epoll_create1(&mut p, 0).unwrap();
    sys_epoll_ctl(&mut p, ep, 1, fd, EPOLLIN, 1).unwrap();
    assert_eq!(
        sys_epoll_pwait(&mut p, &mut h, ep, 1, -1, None),
        Err(Errno::EAGAIN)
    );
    sys_close(&mut p, &mut h, ep).unwrap();
    assert_eq!(sys_epoll_create1(&mut p, 0).unwrap(), ep);
    sys_write(&mut p, &mut h, fd, &1u64.to_le_bytes()).unwrap();
    assert_eq!(batch(&mut p, &mut h, ep, 1), [(EPOLLIN, 1)]);
    assert!(p.epoll_waits.is_empty());
    assert!(
        batch(&mut p, &mut h, ep, 1).is_empty(),
        "next call uses the new description"
    );
}

#[test]
fn epoll_empty_wait_parks_then_observes_registration() {
    let mut p = Process::new(110);
    let mut h = MockHostIO::new();
    let ep = sys_epoll_create1(&mut p, 0).unwrap();
    assert_eq!(
        sys_epoll_pwait(&mut p, &mut h, ep, 1, 100, None),
        Err(Errno::EAGAIN)
    );
    let fd = sys_eventfd2(&mut p, 1, 0).unwrap();
    sys_epoll_ctl(&mut p, ep, 1, fd, EPOLLIN, 1).unwrap();
    assert_eq!(batch(&mut p, &mut h, ep, 1), [(EPOLLIN, 1)]);
}

#[test]
fn epoll_delivers_a_registration_held_only_in_a_sibling_process() {
    let mut parent = Process::new(111);
    let mut h = MockHostIO::new();
    let (r, w) = sys_pipe2(&mut parent, 0).unwrap();
    let ep = sys_epoll_create1(&mut parent, 0).unwrap();
    sys_epoll_ctl(&mut parent, ep, 1, r, EPOLLIN | EPOLLET, 77).unwrap();
    let mut child = fork_child_of(&parent, 112);
    child
        .ofd_table
        .link_shared_states_from(&parent.ofd_table)
        .unwrap();
    sys_close(&mut parent, &mut h, r).unwrap();
    sys_write(&mut parent, &mut h, w, b"x").unwrap();
    let events =
        sys_epoll_pwait_with_peers(&mut parent, &mut h, ep, 1, 0, None, &mut [&mut child]).unwrap();
    assert_eq!(events.1, [(EPOLLIN, 77)]);
    sys_close(&mut child, &mut h, r).unwrap();
    let idx = epoll_index(&parent, ep).unwrap();
    assert!(
        epoll_interests(idx).is_empty(),
        "final OFD release removes the registration"
    );
}

#[test]
fn epoll_exclusive_wakes_a_sleeper_even_if_an_earlier_instance_is_idle() {
    let mut p = Process::new(113);
    let mut h = MockHostIO::new();
    let fd = sys_eventfd2(&mut p, 0, 0).unwrap();
    let idle = sys_epoll_create1(&mut p, 0).unwrap();
    let sleeping = sys_epoll_create1(&mut p, 0).unwrap();
    for ep in [idle, sleeping] {
        sys_epoll_ctl(&mut p, ep, 1, fd, EPOLLIN | EPOLLEXCLUSIVE, 1).unwrap();
    }
    assert!(batch(&mut p, &mut h, idle, 1).is_empty());
    assert_eq!(
        sys_epoll_pwait(&mut p, &mut h, sleeping, 1, -1, None),
        Err(Errno::EAGAIN)
    );
    sys_write(&mut p, &mut h, fd, &1u64.to_le_bytes()).unwrap();
    assert_eq!(batch(&mut p, &mut h, sleeping, 1), [(EPOLLIN, 1)]);
}

#[test]
fn epoll_forked_stream_shutdown_uses_the_shared_connection_half() {
    let mut p = Process::new(114);
    let mut h = MockHostIO::new();
    let (a, b) = sys_socketpair(&mut p, &mut h, 1, 1 | 0x800, 0).unwrap();
    let ep = sys_epoll_create1(&mut p, 0).unwrap();
    sys_epoll_ctl(&mut p, ep, 1, a, EPOLLIN | EPOLLRDHUP | EPOLLET, 1).unwrap();
    let mut child = fork_child_of(&p, 115);
    child
        .ofd_table
        .link_shared_states_from(&p.ofd_table)
        .unwrap();
    sys_shutdown(&mut child, &mut h, b, 1).unwrap();
    assert_eq!(batch(&mut p, &mut h, ep, 1), [(EPOLLIN | EPOLLRDHUP, 1)]);
    assert_eq!(sys_read(&mut p, &mut h, a, &mut [0; 1]), Ok(0));
    assert_eq!(
        sys_send(
            &mut p,
            &mut h,
            b,
            b"x",
            wasm_posix_shared::socket::MSG_NOSIGNAL
        ),
        Err(Errno::EPIPE)
    );
}

#[test]
fn epoll_eventfd_normal_alias_is_not_an_invented_readiness_bit() {
    let mut p = Process::new(116);
    let mut h = MockHostIO::new();
    let fd = sys_eventfd2(&mut p, 1, 0).unwrap();
    let ep = sys_epoll_create1(&mut p, 0).unwrap();
    sys_epoll_ctl(&mut p, ep, 1, fd, EPOLLRDNORM | EPOLLWRNORM, 1).unwrap();
    assert!(batch(&mut p, &mut h, ep, 1).is_empty());
}

#[test]
fn epoll_fd_exhaustion_does_not_leak_instances() {
    let mut p = Process::new(117);
    let before = crate::descriptor_backing::with_epolls(|t| t.iter_mut().count());
    sys_setrlimit(&mut p, wasm_posix_shared::rlimit::RLIMIT_NOFILE, 3, 3).unwrap();
    for _ in 0..3 {
        assert_eq!(sys_epoll_create1(&mut p, 0), Err(Errno::EMFILE));
    }
    assert_eq!(
        crate::descriptor_backing::with_epolls(|t| t.iter_mut().count()),
        before
    );
}

#[test]
fn epoll_old_wait_retirement_cannot_cancel_a_later_call() {
    let mut p = Process::new(118);
    let mut h = MockHostIO::new();
    let ep = sys_epoll_create1(&mut p, 0).unwrap();
    assert_eq!(
        sys_epoll_pwait(&mut p, &mut h, ep, 1, -1, None),
        Err(Errno::EAGAIN)
    );
    let tid = current_tid_for_process(&p);
    let old = p.epoll_waits[0].1.token;
    crate::epoll::finish_wait(&mut p, tid);
    assert_eq!(
        sys_epoll_pwait(&mut p, &mut h, ep, 1, -1, None),
        Err(Errno::EAGAIN)
    );
    crate::epoll::finish_wait_token(&mut p, tid, old);
    assert_eq!(p.epoll_waits.len(), 1);
    assert_ne!(p.epoll_waits[0].1.token, old);
}
