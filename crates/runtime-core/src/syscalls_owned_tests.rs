// These controls use the actual runtime OFD/GEM tables and syscall dispatch,
// rather than a receiver double that can accidentally assume fd stability.
use super::*;
use wasm_posix_shared::{dri::*, dri_owned as W, gl};

fn call(proc: &mut Process, host: &mut MockHostIO, packet: W::Packet) -> W::Packet {
    let mut bytes = [0; 320];
    unsafe { core::ptr::write_unaligned(bytes.as_mut_ptr().cast(), packet) };
    sys_ioctl(proc, host, -1, W::REQUEST, &mut bytes).unwrap();
    let response: W::Packet = unsafe { core::ptr::read_unaligned(bytes.as_ptr().cast()) };
    assert_eq!(response.magic, W::MAGIC);
    if response.action == W::MMAP && response.state == W::PENDING && response.result == 0 {
        // This fixture models the host's accepted construction decision. Real
        // Wasm Memory grow/zero/prime belongs to the matching adapter tests.
        let tid = current_tid_for_process(proc);
        crate::owned_resource::finish_mapping(
            proc,
            &mut AdvisoryLockManager::new(),
            host,
            tid,
            response.token,
            response.transaction,
            0,
        )
        .unwrap();
        return call(
            proc,
            host,
            W::Packet {
                action: W::READ_LAST,
                token: response.token,
                transaction: response.transaction,
                ..Default::default()
            },
        );
    }
    response
}
fn acquire(proc: &mut Process, host: &mut MockHostIO, fd: i32, nonce: u64) -> u32 {
    let response = call(
        proc,
        host,
        W::Packet {
            action: W::ACQUIRE,
            transaction: nonce,
            fd,
            ..Default::default()
        },
    );
    assert_eq!(response.result, 0);
    assert_ne!(response.token, 0);
    call(
        proc,
        host,
        W::Packet {
            action: W::ACK,
            transaction: nonce,
            ..Default::default()
        },
    );
    response.token
}
fn operation(token: u32, tx: u64, request: u32, length: u32) -> W::Packet {
    W::Packet {
        action: W::IOCTL,
        token,
        transaction: tx,
        acknowledge: tx - 1,
        request,
        length,
        ..Default::default()
    }
}
fn create(proc: &mut Process, host: &mut MockHostIO, token: u32, tx: u64) -> W::Packet {
    let mut packet = operation(token, tx, DRM_IOCTL_MODE_CREATE_DUMB, 32);
    packet.flags = W::CAPTURE_BO;
    packet.body[..4].copy_from_slice(&4u32.to_le_bytes());
    packet.body[4..8].copy_from_slice(&4u32.to_le_bytes());
    packet.body[8..12].copy_from_slice(&32u32.to_le_bytes());
    let response = call(proc, host, packet);
    assert_eq!(response.result, 0);
    assert_ne!(response.source_token, 0);
    response
}
fn raw_create(proc: &mut Process, host: &mut MockHostIO, fd: i32) -> u32 {
    let mut bytes = [0; 32];
    bytes[..4].copy_from_slice(&4u32.to_le_bytes());
    bytes[4..8].copy_from_slice(&4u32.to_le_bytes());
    bytes[8..12].copy_from_slice(&32u32.to_le_bytes());
    sys_ioctl(proc, host, fd, DRM_IOCTL_MODE_CREATE_DUMB, &mut bytes).unwrap();
    u32::from_le_bytes(bytes[16..20].try_into().unwrap())
}
fn release(proc: &mut Process, host: &mut MockHostIO, token: u32, tx: u64, bo: bool) -> W::Packet {
    call(
        proc,
        host,
        W::Packet {
            action: if bo { W::BO_RELEASE } else { W::RELEASE },
            token,
            transaction: tx,
            acknowledge: tx - 1,
            ..Default::default()
        },
    )
}
fn word(packet: &W::Packet, offset: usize) -> u32 {
    u32::from_le_bytes(packet.body[offset..offset + 4].try_into().unwrap())
}

#[test]
fn owned_resource_original_ofd_and_bo_survive_fd_reuse_without_closing_replacement() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let token = acquire(&mut proc, &mut host, fd, 1);
    let captured = create(&mut proc, &mut host, token, 1);
    let original = proc
        .owned_resources
        .target(token, 1, proc.exec_generation)
        .unwrap();
    let handle = word(&captured, 16);
    let old_bo = dri_state(&proc, original.index)
        .unwrap()
        .gem
        .borrow()
        .handles[&handle];
    sys_close(&mut proc, &mut host, fd).unwrap();
    let replacement = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    assert_eq!(replacement, fd);
    assert_eq!(raw_create(&mut proc, &mut host, replacement), handle);
    let new_index = proc.fd_table.get(replacement).unwrap().ofd_ref.0;
    let replacement_bo = dri_state(&proc, new_index).unwrap().gem.borrow().handles[&handle];
    assert_ne!(replacement_bo, old_bo);
    assert_eq!(
        release(&mut proc, &mut host, captured.source_token, 1, true).source_token,
        1
    );
    assert!(crate::dri::with_registry(|r| r.get(old_bo).is_none()));
    assert_eq!(
        dri_state(&proc, new_index).unwrap().gem.borrow().handles[&handle],
        replacement_bo
    );
    assert_eq!(
        release(&mut proc, &mut host, token, 2, false).source_token,
        1
    );
    assert!(proc.ofd_table.get(original.index).is_none());
    assert!(crate::dri::with_registry(|r| r
        .get(replacement_bo)
        .is_some()));
    sys_close(&mut proc, &mut host, replacement).unwrap();
}
#[test]
fn owned_resource_bo_proof_survives_external_gem_close_and_maps_exact_storage() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let token = acquire(&mut proc, &mut host, fd, 1);
    let captured = create(&mut proc, &mut host, token, 1);
    let handle = word(&captured, 16);
    let bo = match proc.owned_resources.resources[proc
        .owned_resources
        .index(captured.source_token, 1, proc.exec_generation)
        .unwrap()]
    .kind
    .unwrap()
    {
        crate::owned_resource::Kind::Bo { bo, .. } => bo,
        _ => unreachable!(),
    };
    let mut close = [0; 8];
    close[..4].copy_from_slice(&handle.to_le_bytes());
    sys_ioctl(&mut proc, &mut host, fd, DRM_IOCTL_GEM_CLOSE, &mut close).unwrap();
    assert!(crate::dri::with_registry(|r| r.get(bo).is_some()));
    let mut check = operation(token, 2, DRM_IOCTL_WPK_CHECK_BO_FORMAT, 20);
    check.flags = W::BO_BINDINGS;
    for (offset, value) in [(0, handle), (8, 1), (12, 0), (16, captured.source_token)] {
        check.body[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    assert_eq!(call(&mut proc, &mut host, check).result, 0);
    let mut map = W::Packet {
        action: W::MMAP,
        token,
        transaction: 3,
        acknowledge: 2,
        source_token: captured.source_token,
        length: 32,
        ..Default::default()
    };
    map.body[8..16].copy_from_slice(&64u64.to_le_bytes());
    map.body[16..24].copy_from_slice(&(u64::from(bo) << 12).to_le_bytes());
    map.body[24..28].copy_from_slice(&wasm_posix_shared::mmap::PROT_READ.to_le_bytes());
    map.body[28..32].copy_from_slice(&wasm_posix_shared::mmap::MAP_SHARED.to_le_bytes());
    let mapped = call(&mut proc, &mut host, map);
    assert_eq!(mapped.result, 0);
    assert_eq!(host.gbm_bo_bind_calls.len(), 1);
    map.transaction = 4;
    map.acknowledge = 3;
    map.body[16..24].fill(0);
    assert_eq!(
        call(&mut proc, &mut host, map).result,
        0,
        "explicit BO source also maps its dma-buf origin at offset0"
    );
    assert_eq!(host.gbm_bo_bind_calls.len(), 2);
    release_process_dri_mappings(&mut proc, &mut host);
    assert_eq!(
        release(&mut proc, &mut host, captured.source_token, 1, true).result,
        0
    );
    assert!(crate::dri::with_registry(|r| r.get(bo).is_none()));
    release(&mut proc, &mut host, token, 5, false);
    sys_close(&mut proc, &mut host, fd).unwrap();
}
#[test]
fn owned_resource_recovery_proves_consumed_release_without_replaying_cleanup() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let token = acquire(&mut proc, &mut host, fd, 1);
    let captured = create(&mut proc, &mut host, token, 1);
    let original = W::Packet {
        action: W::BO_RELEASE,
        transaction: 1,
        token: captured.source_token,
        ..Default::default()
    };
    let consumed = call(&mut proc, &mut host, original);
    assert_eq!(consumed.source_token, 1);
    let count = host.gbm_bo_destroy_calls.len();
    let recovered = call(
        &mut proc,
        &mut host,
        W::Packet {
            action: W::READ_LAST,
            transaction: 1,
            token: captured.source_token,
            ..Default::default()
        },
    );
    assert_eq!(recovered, consumed);
    assert_eq!(call(&mut proc, &mut host, original), consumed);
    assert_eq!(host.gbm_bo_destroy_calls.len(), count);
    for _ in 0..2 {
        assert_eq!(
            call(
                &mut proc,
                &mut host,
                W::Packet {
                    action: W::ACK,
                    transaction: 1,
                    token: captured.source_token,
                    ..Default::default()
                }
            )
            .result,
            0
        );
    }
    assert_eq!(
        call(
            &mut proc,
            &mut host,
            W::Packet {
                action: W::READ_LAST,
                transaction: 1,
                token: captured.source_token,
                ..Default::default()
            }
        )
        .state,
        W::ABSENT
    );
    release(&mut proc, &mut host, token, 2, false);
    sys_close(&mut proc, &mut host, fd).unwrap();
}
#[test]
fn owned_resource_dup_recovery_never_publishes_replacement_alias() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let token = acquire(&mut proc, &mut host, fd, 1);
    let duplicate = call(
        &mut proc,
        &mut host,
        W::Packet {
            action: W::DUP_FD,
            transaction: 1,
            token,
            flags: O_CLOEXEC,
            ..Default::default()
        },
    );
    assert!(duplicate.result >= 0);
    let alias = duplicate.result;
    assert_eq!(proc.fd_table.get(alias).unwrap().fd_flags, FD_CLOEXEC);
    sys_close(&mut proc, &mut host, alias).unwrap();
    assert_eq!(
        sys_open(&mut proc, &mut host, b"/dev/null", O_RDWR, 0).unwrap(),
        alias
    );
    let recovered = call(
        &mut proc,
        &mut host,
        W::Packet {
            action: W::READ_LAST,
            transaction: 1,
            token,
            ..Default::default()
        },
    );
    assert_eq!(recovered.state, W::COMPLETE);
    assert_eq!(recovered.result, -(Errno::EBADF as i32));
    release(&mut proc, &mut host, token, 2, false);
    assert!(proc.fd_table.get(alias).is_ok());
    sys_close(&mut proc, &mut host, fd).unwrap();
    sys_close(&mut proc, &mut host, alias).unwrap();
}
#[test]
fn owned_resource_borrowed_alias_retired_but_public_dup_survives_cap_release() {
    for borrowed in [false, true] {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
        let token = acquire(&mut proc, &mut host, fd, 1);
        let alias = call(
            &mut proc,
            &mut host,
            W::Packet {
                action: W::DUP_FD,
                transaction: 1,
                token,
                flags: if borrowed { W::BORROW_ALIAS } else { 0 },
                ..Default::default()
            },
        )
        .result;
        let second = if borrowed {
            Some(call(
                &mut proc,
                &mut host,
                W::Packet {
                    action: W::DUP_FD,
                    transaction: 2,
                    acknowledge: 1,
                    token,
                    flags: W::BORROW_ALIAS,
                    ..Default::default()
                },
            ))
        } else {
            None
        };
        if let Some(second) = second {
            assert_eq!(second.result, alias);
            assert_eq!(
                second.flags,
                W::BORROW_ALIAS,
                "borrowing an existing alias must preserve immutable request flags"
            );
        }
        release(
            &mut proc,
            &mut host,
            token,
            if borrowed { 3 } else { 2 },
            false,
        );
        assert_eq!(proc.fd_table.get(alias).is_err(), borrowed);
        if !borrowed {
            sys_close(&mut proc, &mut host, alias).unwrap();
        }
        sys_close(&mut proc, &mut host, fd).unwrap();
    }
}
#[test]
fn owned_resource_open_is_atomic_and_has_no_descriptor_leak() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let count = proc.fd_table.iter().count();
    let request = W::Packet {
        action: W::OPEN,
        transaction: 1,
        request: W::NODE_RENDER,
        ..Default::default()
    };
    let first = call(&mut proc, &mut host, request);
    assert_eq!(first.result, 0);
    assert_ne!(first.token, 0);
    assert_eq!(proc.fd_table.iter().count(), count);
    assert_eq!(call(&mut proc, &mut host, request), first);
    assert_eq!(proc.owned_resources.resources.len(), 1);
    release(&mut proc, &mut host, first.token, 1, false);
    assert_eq!(proc.fd_table.iter().count(), count);
}
#[test]
fn owned_resource_gl_session_replacement_cannot_retarget_old_driver() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let token = acquire(&mut proc, &mut host, fd, 1);
    let mut init = operation(token, 1, gl::GLIO_INIT, 16);
    init.body[..16].copy_from_slice(&glio_init_bytes(gl::GlInitInfo {
        op_version: gl::OP_VERSION,
        role: gl::SESSION_DISPLAY,
        display_fd: -1,
        display_id: 0,
    }));
    assert_eq!(call(&mut proc, &mut host, init).result, 0);
    sys_ioctl(&mut proc, &mut host, fd, gl::GLIO_TERMINATE, &mut []).unwrap();
    let mut raw = glio_init_bytes(gl::GlInitInfo {
        op_version: gl::OP_VERSION,
        role: gl::SESSION_DISPLAY,
        display_fd: -1,
        display_id: 0,
    });
    sys_ioctl(&mut proc, &mut host, fd, gl::GLIO_INIT, &mut raw).unwrap();
    let new_session = gl_session_id(&proc, proc.fd_table.get(fd).unwrap().ofd_ref.0).unwrap();
    assert_eq!(
        call(
            &mut proc,
            &mut host,
            operation(token, 2, gl::GLIO_TERMINATE, 0)
        )
        .result,
        -(Errno::EACCES as i32)
    );
    assert_eq!(
        gl_session_id(&proc, proc.fd_table.get(fd).unwrap().ofd_ref.0).unwrap(),
        new_session
    );
    release(&mut proc, &mut host, token, 3, false);
    sys_close(&mut proc, &mut host, fd).unwrap();
}
#[test]
fn owned_resource_exec_and_exit_drain_hidden_original_ofds() {
    for exec in [false, true] {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
        let token = acquire(&mut proc, &mut host, fd, 1);
        let captured = create(&mut proc, &mut host, token, 1);
        let target = proc
            .owned_resources
            .target(token, 1, proc.exec_generation)
            .unwrap();
        sys_close(&mut proc, &mut host, fd).unwrap();
        if exec {
            commit_exec_state(&mut proc, &mut host, 1).unwrap();
        } else {
            sys_exit(&mut proc, &mut host, 0);
        }
        assert!(proc.owned_resources.resources.is_empty());
        assert!(proc.owned_resources.creations.is_empty());
        assert!(proc.ofd_table.get(target.index).is_none());
        assert_eq!(host.gbm_bo_destroy_calls.len(), 1);
        assert_ne!(captured.source_token, 0);
    }
}

#[test]
fn owned_resource_source_prime_capture_and_reimports_hold_independent_storage() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let source = acquire(&mut proc, &mut host, fd, 1);
    let created = create(&mut proc, &mut host, source, 1);
    let handle = word(&created, 16);
    let mut export = operation(source, 2, DRM_IOCTL_PRIME_HANDLE_TO_FD, 12);
    export.flags = W::CAPTURE_FD;
    export.body[..4].copy_from_slice(&handle.to_le_bytes());
    export.body[4..8].copy_from_slice(&O_RDWR.to_le_bytes());
    let exported = call(&mut proc, &mut host, export);
    assert_eq!(exported.result, 0);
    assert_ne!(exported.source_token, 0);
    assert_eq!(word(&exported, 8), u32::MAX);
    let fd2 = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let target = acquire(&mut proc, &mut host, fd2, 2);
    let mut import = operation(target, 1, DRM_IOCTL_PRIME_FD_TO_HANDLE, 12);
    import.source_token = exported.source_token;
    import.flags = W::CAPTURE_BO;
    import.body[8..12].copy_from_slice(&(-1i32).to_le_bytes());
    let first = call(&mut proc, &mut host, import);
    assert_eq!(first.result, 0);
    import.transaction = 2;
    import.acknowledge = 1;
    let second = call(&mut proc, &mut host, import);
    assert_eq!(second.result, 0);
    assert_eq!(word(&first, 0), word(&second, 0));
    assert_ne!(first.source_token, second.source_token);
    assert_eq!(
        release(&mut proc, &mut host, first.source_token, 1, true).result,
        0
    );
    let target_index = proc.fd_table.get(fd2).unwrap().ofd_ref.0;
    let name = word(&first, 0);
    assert!(dri_state(&proc, target_index)
        .unwrap()
        .gem
        .borrow()
        .handles
        .contains_key(&name));
    let info = call(
        &mut proc,
        &mut host,
        W::Packet {
            action: W::BO_INFO,
            transaction: 1,
            token: second.source_token,
            length: 32,
            ..Default::default()
        },
    );
    assert_eq!(info.result, 0);
    assert_eq!(u64::from_le_bytes(info.body[..8].try_into().unwrap()), 64);
    assert_eq!(
        release(&mut proc, &mut host, second.source_token, 2, true).result,
        0
    );
    assert!(!dri_state(&proc, target_index)
        .unwrap()
        .gem
        .borrow()
        .handles
        .contains_key(&name));
    release(&mut proc, &mut host, exported.source_token, 1, false);
    release(&mut proc, &mut host, created.source_token, 1, true);
    release(&mut proc, &mut host, source, 3, false);
    release(&mut proc, &mut host, target, 3, false);
    sys_close(&mut proc, &mut host, fd).unwrap();
    sys_close(&mut proc, &mut host, fd2).unwrap();
    assert_eq!(host.gbm_bo_destroy_calls.len(), 1);
}
#[test]
fn owned_resource_production_table_and_fork_have_independent_storage_receipts() {
    use crate::process_table::ProcessTable;
    let mut table = ProcessTable::new();
    let pid = table.create_process().unwrap();
    let mut host = MockHostIO::new();
    let fd = sys_open(
        table.get_mut(pid).unwrap(),
        &mut host,
        b"/dev/dri/renderD128",
        O_RDWR,
        0,
    )
    .unwrap();
    table.bind_current_tid(pid, pid).unwrap();
    let request = W::Packet {
        action: W::ACQUIRE,
        transaction: 1,
        fd,
        ..Default::default()
    };
    let mut bytes = [0; 320];
    unsafe { core::ptr::write_unaligned(bytes.as_mut_ptr().cast(), request) };
    table.ioctl(&mut host, -1, W::REQUEST, &mut bytes).unwrap();
    let response: W::Packet = unsafe { core::ptr::read_unaligned(bytes.as_ptr().cast()) };
    assert_eq!(response.result, 0);
    let token = response.token;
    let captured = create(table.get_mut(pid).unwrap(), &mut host, token, 1);
    let name = word(&captured, 16);
    let child = table.fork_process_for_caller(pid, pid).unwrap();
    assert_eq!(table.get(child).unwrap().owned_resources.resources.len(), 2);
    table.bind_current_tid(child, child).unwrap();
    let packet = W::Packet {
        action: W::READ_LAST,
        transaction: 1,
        token,
        ..Default::default()
    };
    unsafe { core::ptr::write_unaligned(bytes.as_mut_ptr().cast(), packet) };
    table.ioctl(&mut host, -1, W::REQUEST, &mut bytes).unwrap();
    let copied: W::Packet = unsafe { core::ptr::read_unaligned(bytes.as_ptr().cast()) };
    assert_eq!(
        copied, captured,
        "child recovers a copied completed receipt, without replaying parent effects"
    );
    table.bind_current_tid(pid, pid).unwrap();
    let (proc, locks) = table.current_process_and_advisory_locks().unwrap();
    commit_exec_state_with_locks(proc, locks, &mut host, pid).unwrap();
    let child_proc = table.get_mut(child).unwrap();
    let index = child_proc.fd_table.get(fd).unwrap().ofd_ref.0;
    assert!(
        dri_state(child_proc, index)
            .unwrap()
            .gem
            .borrow()
            .handles
            .contains_key(&name),
        "parent exec must not GEM_CLOSE a name inherited by child"
    );
    release(child_proc, &mut host, captured.source_token, 1, true);
    release(child_proc, &mut host, token, 2, false);
    sys_close(child_proc, &mut host, fd).unwrap();
    let parent = table.get_mut(pid).unwrap();
    sys_close(parent, &mut host, fd).unwrap();
    assert_eq!(host.gbm_bo_destroy_calls.len(), 1);
}
#[test]
fn owned_resource_forced_removal_retires_independent_bo_hold() {
    use crate::process_table::ProcessTable;
    let mut table = ProcessTable::new();
    let pid = table.create_process().unwrap();
    let mut host = MockHostIO::new();
    let proc = table.get_mut(pid).unwrap();
    let fd = sys_open(proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let token = acquire(proc, &mut host, fd, 1);
    create(proc, &mut host, token, 1);
    sys_close(proc, &mut host, fd).unwrap();
    let removed = table.remove_process(pid).unwrap();
    assert_eq!(
        removed
            .dri_effects
            .iter()
            .filter(|e| matches!(e, DriReleaseEffect::DestroyBo(_)))
            .count(),
        1
    );
}
#[test]
fn owned_resource_malformed_bo_binding_is_rejected_before_any_effect() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let token = acquire(&mut proc, &mut host, fd, 1);
    let captured = create(&mut proc, &mut host, token, 1);
    let mut packet = operation(token, 2, DRM_IOCTL_WPK_CHECK_BO_FORMAT, 20);
    packet.flags = W::BO_BINDINGS;
    for (offset, value) in [
        (0, word(&captured, 16)),
        (8, 1),
        (12, 4),
        (16, captured.source_token),
    ] {
        packet.body[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    let mut bytes = [0; 320];
    unsafe { core::ptr::write_unaligned(bytes.as_mut_ptr().cast(), packet) };
    assert_eq!(
        sys_ioctl(&mut proc, &mut host, -1, W::REQUEST, &mut bytes),
        Err(Errno::EINVAL)
    );
    assert_eq!(
        proc.owned_resources.resources[proc
            .owned_resources
            .index(token, 1, proc.exec_generation)
            .unwrap()]
        .last_transaction,
        1
    );
    assert_eq!(host.gbm_bo_destroy_calls.len(), 0);
    release(&mut proc, &mut host, captured.source_token, 1, true);
    release(&mut proc, &mut host, token, 2, false);
    sys_close(&mut proc, &mut host, fd).unwrap();
}

fn try_packet(
    proc: &mut Process,
    host: &mut MockHostIO,
    packet: W::Packet,
) -> (Result<(), Errno>, W::Packet) {
    let mut bytes = [0; 320];
    unsafe { core::ptr::write_unaligned(bytes.as_mut_ptr().cast(), packet) };
    let result = sys_ioctl(proc, host, -1, W::REQUEST, &mut bytes);
    (result, unsafe {
        core::ptr::read_unaligned(bytes.as_ptr().cast())
    })
}
#[test]
fn owned_resource_parked_bo_proof_outlives_source_cap_and_external_namespace() {
    use crate::dri::fence::{Fence, Source, Timeline, Usage};
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let token = acquire(&mut proc, &mut host, fd, 1);
    let captured = create(&mut proc, &mut host, token, 1);
    let handle = word(&captured, 16);
    let target = proc
        .owned_resources
        .target(token, 1, proc.exec_generation)
        .unwrap();
    let bo = dri_state(&proc, target.index).unwrap().gem.borrow().handles[&handle];
    let fence = Fence::pending(1, 1, "owned", Timeline::Static("test"), Source::Software);
    crate::dri::with_registry(|r| r.get_mut(bo).unwrap().reservation.add(&fence, Usage::Write));
    let mut packet = operation(token, 2, DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE, 28);
    packet.flags = W::BO_BINDINGS;
    for (offset, value) in [(0, handle), (16, 1), (20, 0), (24, captured.source_token)] {
        packet.body[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    let (result, pending) = try_packet(&mut proc, &mut host, packet);
    assert_eq!(result, Err(Errno::EAGAIN));
    assert_eq!(pending.state, W::PENDING);
    assert_eq!(
        call(
            &mut proc,
            &mut host,
            W::Packet {
                action: W::READ_LAST,
                token,
                transaction: 2,
                ..Default::default()
            }
        )
        .state,
        W::PENDING
    );
    let mut close = [0; 8];
    close[..4].copy_from_slice(&handle.to_le_bytes());
    sys_ioctl(&mut proc, &mut host, fd, DRM_IOCTL_GEM_CLOSE, &mut close).unwrap();
    release(&mut proc, &mut host, captured.source_token, 1, true);
    sys_close(&mut proc, &mut host, fd).unwrap();
    let replacement = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    assert_eq!(replacement, fd);
    raw_create(&mut proc, &mut host, replacement);
    assert_eq!(
        try_packet(&mut proc, &mut host, packet).0,
        Err(Errno::EAGAIN),
        "retained storage still waits after its raw GEM name and source cap disappear"
    );
    fence.signal(0, 1);
    let resumed = call(&mut proc, &mut host, packet);
    assert_eq!(
        resumed.result,
        -(Errno::EINVAL as i32),
        "no GL context was created by this fixture"
    );
    assert_eq!(resumed.state, W::COMPLETE);
    assert!(crate::dri::with_registry(|r| r.get(bo).is_none()));
    let replacement_index = proc.fd_table.get(replacement).unwrap().ofd_ref.0;
    assert_eq!(
        dri_state(&proc, replacement_index)
            .unwrap()
            .gem
            .borrow()
            .handles
            .len(),
        1
    );
    release(&mut proc, &mut host, token, 3, false);
    sys_close(&mut proc, &mut host, replacement).unwrap();
}
#[test]
fn owned_resource_poll_uses_exact_file_and_frozen_monotonic_deadline() {
    use crate::dri::{
        fence::{Fence, Source, Timeline},
        sync_file::{install_fd, SyncFile},
    };
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    host.monotonic_time = Some((100, 0));
    let fence = Fence::pending(1, 1, "owned", Timeline::Static("test"), Source::Software);
    let fd = install_fd(&mut proc, SyncFile::new(fence.clone()), false).unwrap();
    let token = acquire(&mut proc, &mut host, fd, 1);
    sys_close(&mut proc, &mut host, fd).unwrap();
    assert_eq!(
        sys_open(&mut proc, &mut host, b"/dev/null", O_RDWR, 0).unwrap(),
        fd
    );
    let mut poll = W::Packet {
        action: W::POLL,
        token,
        transaction: 1,
        length: 16,
        ..Default::default()
    };
    poll.body[..4].copy_from_slice(&(wasm_posix_shared::poll::POLLIN as u32).to_le_bytes());
    poll.body[8..12].copy_from_slice(&10i32.to_le_bytes());
    assert_eq!(try_packet(&mut proc, &mut host, poll).0, Err(Errno::EAGAIN));
    assert!(fence.signaling_enabled());
    host.monotonic_time = Some((100, 9_000_000));
    assert_eq!(try_packet(&mut proc, &mut host, poll).0, Err(Errno::EAGAIN));
    host.monotonic_time = Some((100, 11_000_000));
    let timed_out = call(&mut proc, &mut host, poll);
    assert_eq!(timed_out.result, 0);
    assert_eq!(word(&timed_out, 4), 0);
    poll.transaction = 2;
    poll.acknowledge = 1;
    poll.body[8..12].copy_from_slice(&(-1i32).to_le_bytes());
    assert_eq!(try_packet(&mut proc, &mut host, poll).0, Err(Errno::EAGAIN));
    fence.signal(0, 100_012_000_000);
    let ready = call(&mut proc, &mut host, poll);
    assert_eq!(ready.result, 1);
    assert_eq!(word(&ready, 4), wasm_posix_shared::poll::POLLIN as u32);
    release(&mut proc, &mut host, token, 3, false);
    assert!(proc.fd_table.get(fd).is_ok());
    sys_close(&mut proc, &mut host, fd).unwrap();
}
#[test]
fn owned_resource_invalid_sync_import_does_not_consume_input_descriptor() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let index = proc.fd_table.get(fd).unwrap().ofd_ref.0;
    let refs = proc.ofd_table.get(index).unwrap().ref_count;
    let response = call(
        &mut proc,
        &mut host,
        W::Packet {
            action: W::ACQUIRE,
            fd,
            transaction: 1,
            flags: W::CONSUME_FD | W::EXPECT_SYNC_FILE,
            ..Default::default()
        },
    );
    assert_eq!(response.result, -(Errno::EINVAL as i32));
    assert_eq!(response.token, 0);
    assert!(proc.fd_table.get(fd).is_ok());
    assert_eq!(proc.ofd_table.get(index).unwrap().ref_count, refs);
    sys_close(&mut proc, &mut host, fd).unwrap();
}
#[test]
fn owned_resource_dup2_replacement_never_changes_original_target() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let token = acquire(&mut proc, &mut host, fd, 1);
    let target = proc
        .owned_resources
        .target(token, 1, proc.exec_generation)
        .unwrap();
    let replacement = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    sys_dup2(&mut proc, &mut host, replacement, fd).unwrap();
    let replacement_index = proc.fd_table.get(fd).unwrap().ofd_ref.0;
    assert_ne!(target.index, replacement_index);
    let created = create(&mut proc, &mut host, token, 1);
    assert_eq!(
        dri_state(&proc, replacement_index)
            .unwrap()
            .gem
            .borrow()
            .handles
            .len(),
        0
    );
    release(&mut proc, &mut host, created.source_token, 1, true);
    release(&mut proc, &mut host, token, 2, false);
    assert!(proc.ofd_table.get(target.index).is_none());
    sys_close(&mut proc, &mut host, replacement).unwrap();
    sys_close(&mut proc, &mut host, fd).unwrap();
}

#[test]
fn owned_resource_cancel_poll_is_once_only_and_late_retry_cannot_restart_it() {
    use crate::dri::{
        fence::{Fence, Source, Timeline},
        sync_file::{install_fd, SyncFile},
    };
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fence = Fence::pending(1, 1, "owned", Timeline::Static("test"), Source::Software);
    let fd = install_fd(&mut proc, SyncFile::new(fence.clone()), false).unwrap();
    let token = acquire(&mut proc, &mut host, fd, 1);
    let mut poll = W::Packet {
        action: W::POLL,
        token,
        transaction: 1,
        length: 16,
        ..Default::default()
    };
    poll.body[..4].copy_from_slice(&(wasm_posix_shared::poll::POLLIN as u32).to_le_bytes());
    poll.body[8..12].copy_from_slice(&(-1i32).to_le_bytes());
    let (status, late_retry) = try_packet(&mut proc, &mut host, poll);
    assert_eq!(status, Err(Errno::EAGAIN));
    assert_eq!(word(&late_retry, 12), u32::MAX);
    let cancel = W::Packet {
        action: W::CANCEL_POLL,
        token,
        transaction: 1,
        ..Default::default()
    };
    let cancelled = call(&mut proc, &mut host, cancel);
    assert_eq!(cancelled.action, W::POLL);
    assert_eq!(cancelled.result, -(Errno::EINTR as i32));
    assert_eq!(word(&cancelled, 12), 0);
    assert_eq!(call(&mut proc, &mut host, cancel), cancelled);
    fence.signal(0, 1);
    assert_eq!(
        call(&mut proc, &mut host, late_retry),
        cancelled,
        "late timer wake returns terminal receipt, never restarts the cancelled poll"
    );
    assert_eq!(
        call(
            &mut proc,
            &mut host,
            W::Packet {
                action: W::READ_LAST,
                token,
                transaction: 1,
                ..Default::default()
            }
        ),
        cancelled
    );
    assert_eq!(
        release(&mut proc, &mut host, token, 2, false).source_token,
        1
    );
    sys_close(&mut proc, &mut host, fd).unwrap();
}
#[test]
fn owned_resource_poll_recovery_refreshes_remaining_without_restarting_deadline() {
    use crate::dri::{
        fence::{Fence, Source, Timeline},
        sync_file::{install_fd, SyncFile},
    };
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    host.monotonic_time = Some((100, 0));
    let fd = install_fd(
        &mut proc,
        SyncFile::new(Fence::pending(
            1,
            1,
            "owned",
            Timeline::Static("test"),
            Source::Software,
        )),
        false,
    )
    .unwrap();
    let token = acquire(&mut proc, &mut host, fd, 1);
    let mut poll = W::Packet {
        action: W::POLL,
        token,
        transaction: 1,
        length: 16,
        ..Default::default()
    };
    poll.body[..4].copy_from_slice(&(wasm_posix_shared::poll::POLLIN as u32).to_le_bytes());
    poll.body[8..12].copy_from_slice(&10i32.to_le_bytes());
    let (status, pending) = try_packet(&mut proc, &mut host, poll);
    assert_eq!(status, Err(Errno::EAGAIN));
    assert_eq!(word(&pending, 12), 10);
    host.monotonic_time = Some((100, 8_500_000));
    let recovered = call(
        &mut proc,
        &mut host,
        W::Packet {
            action: W::READ_LAST,
            token,
            transaction: 1,
            ..Default::default()
        },
    );
    assert_eq!(word(&recovered, 12), 2);
    assert_eq!(word(&recovered, 8), 10);
    host.monotonic_time = Some((100, 11_000_000));
    let expired = call(
        &mut proc,
        &mut host,
        W::Packet {
            action: W::READ_LAST,
            token,
            transaction: 1,
            ..Default::default()
        },
    );
    assert_eq!(expired.state, W::PENDING);
    assert_eq!(word(&expired, 12), 1);
    assert_eq!(call(&mut proc, &mut host, poll).result, 0);
    let cancel = W::Packet {
        action: W::CANCEL_POLL,
        token,
        transaction: 1,
        ..Default::default()
    };
    assert_eq!(
        call(&mut proc, &mut host, cancel).result,
        0,
        "completion wins the timeout/cancel race"
    );
    release(&mut proc, &mut host, token, 2, false);
    sys_close(&mut proc, &mut host, fd).unwrap();
}
#[test]
fn owned_resource_actual_tid_authority_and_thread_exit_terminalize_poll() {
    use crate::dri::{
        fence::{Fence, Source, Timeline},
        sync_file::{install_fd, SyncFile},
    };
    use crate::process::ThreadInfo;
    use crate::process_table::ProcessTable;
    let mut table = ProcessTable::new();
    let pid = table.create_process().unwrap();
    let tid = pid + 100;
    let mut host = MockHostIO::new();
    let proc = table.get_mut(pid).unwrap();
    proc.add_thread(ThreadInfo::new(tid, 0, 0, 0));
    let fd = install_fd(
        proc,
        SyncFile::new(Fence::pending(
            1,
            1,
            "owned",
            Timeline::Static("test"),
            Source::Software,
        )),
        false,
    )
    .unwrap();
    let token = acquire(proc, &mut host, fd, 1);
    table.bind_current_tid(pid, tid).unwrap();
    let mut poll = W::Packet {
        action: W::POLL,
        token,
        transaction: 1,
        length: 16,
        ..Default::default()
    };
    poll.body[..4].copy_from_slice(&(wasm_posix_shared::poll::POLLIN as u32).to_le_bytes());
    poll.body[8..12].copy_from_slice(&(-1i32).to_le_bytes());
    let mut bytes = [0; 320];
    unsafe { core::ptr::write_unaligned(bytes.as_mut_ptr().cast(), poll) };
    assert_eq!(
        table.ioctl(&mut host, -1, W::REQUEST, &mut bytes),
        Err(Errno::EAGAIN)
    );
    table.bind_current_tid(pid, pid).unwrap();
    let cancel = W::Packet {
        action: W::CANCEL_POLL,
        token,
        transaction: 1,
        ..Default::default()
    };
    unsafe { core::ptr::write_unaligned(bytes.as_mut_ptr().cast(), cancel) };
    assert_eq!(
        table.ioctl(&mut host, -1, W::REQUEST, &mut bytes),
        Err(Errno::EBUSY)
    );
    let (proc, locks) = table.current_process_and_advisory_locks().unwrap();
    cleanup_exiting_thread_with_state(proc, locks, &mut host, tid).unwrap();
    let recovered = call(
        table.get_mut(pid).unwrap(),
        &mut host,
        W::Packet {
            action: W::READ_LAST,
            token,
            transaction: 1,
            ..Default::default()
        },
    );
    assert_eq!(recovered.state, W::COMPLETE);
    assert_eq!(recovered.result, -(Errno::EINTR as i32));
    release(table.get_mut(pid).unwrap(), &mut host, token, 2, false);
    sys_close(table.get_mut(pid).unwrap(), &mut host, fd).unwrap();
}

#[test]
fn owned_resource_context_replacement_within_same_session_cannot_retarget_driver() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let (root, _) = glio_display_test(&mut proc, &mut host, gl::OP_VERSION).unwrap();
    let (fd, old_context) = glio_cross_new_context(&mut proc, &mut host, root);
    let token = acquire(&mut proc, &mut host, fd, 1);
    sys_ioctl(&mut proc, &mut host, fd, gl::GLIO_DESTROY_CONTEXT, &mut []).unwrap();
    let mut attrs = [0; 16];
    attrs[..4].copy_from_slice(&2u32.to_le_bytes());
    sys_ioctl(
        &mut proc,
        &mut host,
        fd,
        gl::GLIO_CREATE_CONTEXT,
        &mut attrs,
    )
    .unwrap();
    let replacement = u32::from_le_bytes(attrs[12..16].try_into().unwrap());
    assert_ne!(old_context, replacement);
    assert_eq!(
        call(
            &mut proc,
            &mut host,
            operation(token, 1, gl::GLIO_DESTROY_CONTEXT, 0)
        )
        .result,
        -(Errno::EACCES as i32)
    );
    let index = proc.fd_table.get(fd).unwrap().ofd_ref.0;
    assert_eq!(
        dri_state(&proc, index)
            .unwrap()
            .gl
            .as_ref()
            .unwrap()
            .context_id,
        Some(replacement)
    );
    release(&mut proc, &mut host, token, 2, false);
    sys_close(&mut proc, &mut host, fd).unwrap();
    sys_close(&mut proc, &mut host, root).unwrap();
}

#[test]
fn owned_resource_fork_inherits_storage_authority_without_inheriting_renderer() {
    use crate::process_table::ProcessTable;
    let mut table = ProcessTable::new();
    let pid = table.create_process().unwrap();
    let mut host = MockHostIO::new();
    let (fd, _) =
        glio_display_test(table.get_mut(pid).unwrap(), &mut host, gl::OP_VERSION).unwrap();
    let parent_token = acquire(table.get_mut(pid).unwrap(), &mut host, fd, 1);
    let child = table.fork_process_for_caller(pid, pid).unwrap();
    let proc = table.get_mut(child).unwrap();
    let child_token = acquire(proc, &mut host, fd, 1);
    let created = create(proc, &mut host, child_token, 1);
    let handle = word(&created, 16);
    let index = proc.fd_table.get(fd).unwrap().ofd_ref.0;
    assert!(dri_state(proc, index).unwrap().gl.is_none());
    assert_eq!(
        dri_state(proc, index)
            .unwrap()
            .gl_resources
            .borrow()
            .owner
            .unwrap()
            .pid,
        pid as i32
    );
    assert_eq!(
        call(
            proc,
            &mut host,
            operation(child_token, 2, gl::GLIO_TERMINATE, 0)
        )
        .result,
        -(Errno::EACCES as i32)
    );
    let duplicate = call(
        proc,
        &mut host,
        W::Packet {
            action: W::DUP_FD,
            token: child_token,
            transaction: 3,
            acknowledge: 2,
            ..Default::default()
        },
    );
    assert!(duplicate.result >= 0);
    sys_close(proc, &mut host, duplicate.result).unwrap();
    let mut map = W::Packet {
        action: W::MMAP,
        token: child_token,
        transaction: 4,
        acknowledge: 3,
        source_token: created.source_token,
        length: 32,
        ..Default::default()
    };
    map.body[8..16].copy_from_slice(&64u64.to_le_bytes());
    map.body[24..28].copy_from_slice(&wasm_posix_shared::mmap::PROT_READ.to_le_bytes());
    map.body[28..32].copy_from_slice(&wasm_posix_shared::mmap::MAP_SHARED.to_le_bytes());
    assert_eq!(call(proc, &mut host, map).result, 0);
    release_process_dri_mappings(proc, &mut host);
    release(proc, &mut host, created.source_token, 1, true);
    assert!(!dri_state(proc, index)
        .unwrap()
        .gem
        .borrow()
        .handles
        .contains_key(&handle));
    release(proc, &mut host, child_token, 5, false);
    release(proc, &mut host, parent_token, 1, false);
    sys_close(proc, &mut host, fd).unwrap();
    let parent = table.get_mut(pid).unwrap();
    let index = parent.fd_table.get(fd).unwrap().ofd_ref.0;
    assert!(dri_state(parent, index).unwrap().gl.is_some());
    release(parent, &mut host, parent_token, 1, false);
    sys_close(parent, &mut host, fd).unwrap();
    assert_eq!(host.gbm_bo_destroy_calls.len(), 1);
}

#[test]
fn owned_resource_renderer_replacement_does_not_revoke_drm_namespace_authority() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let token = acquire(&mut proc, &mut host, fd, 1);
    let mut init = glio_init_bytes(gl::GlInitInfo {
        op_version: gl::OP_VERSION,
        role: gl::SESSION_DISPLAY,
        display_fd: -1,
        display_id: 0,
    });
    sys_ioctl(&mut proc, &mut host, fd, gl::GLIO_INIT, &mut init).unwrap();
    let created = create(&mut proc, &mut host, token, 1);
    assert_eq!(word(&created, 16), 1);
    assert_eq!(
        call(
            &mut proc,
            &mut host,
            operation(token, 2, gl::GLIO_TERMINATE, 0)
        )
        .result,
        -(Errno::EACCES as i32)
    );
    release(&mut proc, &mut host, created.source_token, 1, true);
    release(&mut proc, &mut host, token, 3, false);
    sys_close(&mut proc, &mut host, fd).unwrap();
    assert_eq!(host.gbm_bo_destroy_calls.len(), 1);
}

#[test]
fn owned_resource_fork_hidden_caps_share_exact_final_name_custody() {
    use crate::process_table::ProcessTable;
    for parent_first in [false, true] {
        let mut table = ProcessTable::new();
        let parent = table.create_process().unwrap();
        let mut host = MockHostIO::new();
        let p = table.get_mut(parent).unwrap();
        let fd = sys_open(p, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
        let token = acquire(p, &mut host, fd, 1);
        let captured = create(p, &mut host, token, 1);
        let handle = word(&captured, 16);
        let target = p
            .owned_resources
            .target(token, parent, p.exec_generation)
            .unwrap();
        let bo = dri_state(p, target.index).unwrap().gem.borrow().handles[&handle];
        sys_close(p, &mut host, fd).unwrap();
        let child = table.fork_process_for_caller(parent, parent).unwrap();
        let c = table.get(child).unwrap();
        assert!(c.fd_table.iter().all(|(_, e)| e.ofd_ref.0 != target.index));
        assert_eq!(c.ofd_table.get(target.index).unwrap().ref_count, 2);
        assert_eq!(
            crate::dri::with_registry(|r| r.get(bo).unwrap().refcount),
            3
        );
        let (first, last) = if parent_first {
            (parent, child)
        } else {
            (child, parent)
        };
        release(
            table.get_mut(first).unwrap(),
            &mut host,
            captured.source_token,
            1,
            true,
        );
        assert!(dri_state(table.get(last).unwrap(), target.index)
            .unwrap()
            .gem
            .borrow()
            .handles
            .contains_key(&handle));
        assert_eq!(
            crate::dri::with_registry(|r| r.get(bo).unwrap().refcount),
            2
        );
        release(table.get_mut(first).unwrap(), &mut host, token, 2, false);
        assert!(table
            .get(first)
            .unwrap()
            .ofd_table
            .get(target.index)
            .is_none());
        release(
            table.get_mut(last).unwrap(),
            &mut host,
            captured.source_token,
            1,
            true,
        );
        assert!(crate::dri::with_registry(|r| r.get(bo).is_none()));
        release(table.get_mut(last).unwrap(), &mut host, token, 2, false);
        assert!(table
            .get(last)
            .unwrap()
            .ofd_table
            .get(target.index)
            .is_none());
        assert_eq!(host.gbm_bo_destroy_calls.len(), 1);
        assert!(table.remove_process(first).unwrap().dri_effects.is_empty());
        assert!(table.remove_process(last).unwrap().dri_effects.is_empty());
    }
}
#[test]
fn owned_resource_fork_recovers_unknown_cold_and_child_capture_without_parent_ack() {
    use crate::process_table::ProcessTable;
    let mut table = ProcessTable::new();
    let parent = table.create_process().unwrap();
    let mut host = MockHostIO::new();
    let p = table.get_mut(parent).unwrap();
    let fd = sys_open(p, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let cold = call(
        p,
        &mut host,
        W::Packet {
            action: W::ACQUIRE,
            transaction: 7,
            fd,
            ..Default::default()
        },
    );
    let token = cold.token;
    let captured = create(p, &mut host, token, 1);
    let original = p.owned_resources.resources[p
        .owned_resources
        .index(token, parent, p.exec_generation)
        .unwrap()]
    .receipt
    .as_ref()
    .unwrap()
    .request;
    let child = table.fork_process_for_caller(parent, parent).unwrap();
    let c = table.get_mut(child).unwrap();
    assert_eq!(
        call(
            c,
            &mut host,
            W::Packet {
                action: W::READ_LAST,
                transaction: 7,
                ..Default::default()
            }
        ),
        cold
    );
    call(
        c,
        &mut host,
        W::Packet {
            action: W::ACK,
            transaction: 7,
            ..Default::default()
        },
    );
    assert_eq!(
        call(
            c,
            &mut host,
            W::Packet {
                action: W::READ_LAST,
                transaction: 1,
                token,
                ..Default::default()
            }
        ),
        captured
    );
    assert_eq!(call(c, &mut host, original), captured);
    call(
        c,
        &mut host,
        W::Packet {
            action: W::ACK,
            transaction: 1,
            token,
            ..Default::default()
        },
    );
    let p = table.get_mut(parent).unwrap();
    assert_eq!(
        call(
            p,
            &mut host,
            W::Packet {
                action: W::READ_LAST,
                transaction: 7,
                ..Default::default()
            }
        ),
        cold
    );
    assert_eq!(
        call(
            p,
            &mut host,
            W::Packet {
                action: W::READ_LAST,
                transaction: 1,
                token,
                ..Default::default()
            }
        ),
        captured
    );
    release(p, &mut host, captured.source_token, 1, true);
    release(p, &mut host, token, 2, false);
    sys_close(p, &mut host, fd).unwrap();
    let c = table.get_mut(child).unwrap();
    release(c, &mut host, captured.source_token, 1, true);
    release(c, &mut host, token, 2, false);
    sys_close(c, &mut host, fd).unwrap();
    assert_eq!(host.gbm_bo_destroy_calls.len(), 1);
}
#[test]
fn owned_resource_fork_pending_work_is_child_tombstone_without_temporary_pins() {
    use crate::dri::fence::{Fence, Source, Timeline, Usage};
    use crate::process_table::ProcessTable;
    for retire_source in [false, true] {
        let mut table = ProcessTable::new();
        let parent = table.create_process().unwrap();
        let mut host = MockHostIO::new();
        let p = table.get_mut(parent).unwrap();
        let fd = sys_open(p, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
        let token = acquire(p, &mut host, fd, 1);
        let captured = create(p, &mut host, token, 1);
        let handle = word(&captured, 16);
        let index = p.fd_table.get(fd).unwrap().ofd_ref.0;
        let bo = dri_state(p, index).unwrap().gem.borrow().handles[&handle];
        let fence = Fence::pending(1, 1, "owned", Timeline::Static("test"), Source::Software);
        crate::dri::with_registry(|r| r.get_mut(bo).unwrap().reservation.add(&fence, Usage::Write));
        let mut pending = operation(token, 2, DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE, 28);
        pending.flags = W::BO_BINDINGS;
        for (offset, value) in [(0, handle), (16, 1), (20, 0), (24, captured.source_token)] {
            pending.body[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        assert_eq!(try_packet(p, &mut host, pending).0, Err(Errno::EAGAIN));
        if retire_source {
            release(p, &mut host, captured.source_token, 1, true);
        }
        let child = table.fork_process_for_caller(parent, parent).unwrap();
        assert_eq!(
            crate::dri::with_registry(|r| r.get(bo).unwrap().refcount),
            if retire_source { 1 } else { 4 }
        );
        let c = table.get_mut(child).unwrap();
        let tombstone = call(
            c,
            &mut host,
            W::Packet {
                action: W::READ_LAST,
                token,
                transaction: 2,
                ..Default::default()
            },
        );
        assert_eq!(tombstone.state, W::COMPLETE);
        assert_eq!(tombstone.result, -(Errno::EINTR as i32));
        assert_eq!(call(c, &mut host, pending), tombstone);
        let p = table.get_mut(parent).unwrap();
        assert_eq!(
            call(
                p,
                &mut host,
                W::Packet {
                    action: W::READ_LAST,
                    token,
                    transaction: 2,
                    ..Default::default()
                }
            )
            .state,
            W::PENDING
        );
        fence.signal(0, 1);
        assert_eq!(call(p, &mut host, pending).result, -(Errno::EINVAL as i32));
        if !retire_source {
            release(p, &mut host, captured.source_token, 1, true);
            release(
                table.get_mut(child).unwrap(),
                &mut host,
                captured.source_token,
                1,
                true,
            );
        }
        assert!(crate::dri::with_registry(|r| r.get(bo).is_none()));
        for pid in [parent, child] {
            let proc = table.get_mut(pid).unwrap();
            release(proc, &mut host, token, 3, false);
            sys_close(proc, &mut host, fd).unwrap();
        }
        assert_eq!(host.gbm_bo_destroy_calls.len(), 1);
    }
}
#[test]
fn owned_resource_failed_capture_does_not_return_input_file_as_bo_custody() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let token = acquire(&mut proc, &mut host, fd, 1);
    let index = proc.fd_table.get(fd).unwrap().ofd_ref.0;
    let refs = proc.ofd_table.get(index).unwrap().ref_count;
    let mut import = operation(token, 1, DRM_IOCTL_PRIME_FD_TO_HANDLE, 12);
    import.source_token = token;
    import.flags = W::CAPTURE_BO;
    import.body[8..12].copy_from_slice(&(-1i32).to_le_bytes());
    let error = call(&mut proc, &mut host, import);
    assert_eq!(error.result, -(Errno::EINVAL as i32));
    assert_eq!(error.source_token, 0);
    assert_eq!(proc.owned_resources.resources.len(), 1);
    assert_eq!(proc.ofd_table.get(index).unwrap().ref_count, refs);
    release(&mut proc, &mut host, token, 2, false);
    sys_close(&mut proc, &mut host, fd).unwrap();
}
#[test]
fn owned_resource_staged_fixed_mapping_rolls_back_before_native_bind_or_seals_actual_error() {
    use wasm_posix_shared::mmap::*;
    for errno in [0, Errno::ENOMEM as u32, Errno::EIO as u32] {
        for bind_failure in [false, true] {
            let mut proc = Process::new(1);
            let mut host = MockHostIO::new();
            let fd = sys_open(&mut proc, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
            let token = acquire(&mut proc, &mut host, fd, 1);
            let captured = create(&mut proc, &mut host, token, 1);
            let old = sys_mmap(
                &mut proc,
                &mut host,
                0,
                0x10000,
                PROT_READ | PROT_WRITE,
                MAP_PRIVATE | MAP_ANONYMOUS,
                -1,
                0,
            )
            .unwrap();
            let old_flags = proc
                .memory
                .mappings()
                .iter()
                .find(|m| m.addr == old)
                .unwrap()
                .flags;
            let mut map = W::Packet {
                action: W::MMAP,
                token,
                transaction: 2,
                acknowledge: 1,
                source_token: captured.source_token,
                length: 32,
                ..Default::default()
            };
            map.body[..8].copy_from_slice(&(old as u64).to_le_bytes());
            map.body[8..16].copy_from_slice(&64u64.to_le_bytes());
            map.body[24..28].copy_from_slice(&(PROT_READ | PROT_WRITE).to_le_bytes());
            map.body[28..32].copy_from_slice(&(MAP_FIXED | MAP_SHARED).to_le_bytes());
            let (status, pending) = try_packet(&mut proc, &mut host, map);
            assert_eq!(status, Ok(()));
            assert_eq!(pending.state, W::PENDING);
            assert_eq!(pending.result, 0);
            assert!(proc.dri_bindings.is_empty());
            assert!(host.gbm_bo_bind_calls.is_empty());
            assert_eq!(try_packet(&mut proc, &mut host, map).1, pending);
            assert_eq!(
                sys_munmap(&mut proc, &mut host, old, 0x10000),
                Err(Errno::EBUSY)
            );
            if bind_failure {
                host.gbm_bo_bind_rc = -(Errno::ENOMEM as i32);
            }
            crate::owned_resource::finish_mapping(
                &mut proc,
                &mut AdvisoryLockManager::new(),
                &mut host,
                1,
                token,
                2,
                errno,
            )
            .unwrap();
            let receipt = call(
                &mut proc,
                &mut host,
                W::Packet {
                    action: W::READ_LAST,
                    token,
                    transaction: 2,
                    ..Default::default()
                },
            );
            let expected = if errno != 0 {
                -(errno as i32)
            } else if bind_failure {
                -(Errno::ENOMEM as i32)
            } else {
                0
            };
            assert_eq!(receipt.result, expected);
            assert_eq!(receipt.state, W::COMPLETE);
            assert_eq!(host.gbm_bo_bind_calls.len(), usize::from(errno == 0));
            if expected != 0 {
                assert_eq!(
                    proc.memory
                        .mappings()
                        .iter()
                        .find(|m| m.addr == old)
                        .unwrap()
                        .flags,
                    old_flags
                );
                assert!(proc.dri_bindings.is_empty());
            }
            let count = host.gbm_bo_bind_calls.len();
            crate::owned_resource::finish_mapping(
                &mut proc,
                &mut AdvisoryLockManager::new(),
                &mut host,
                1,
                token,
                2,
                errno,
            )
            .unwrap();
            assert_eq!(host.gbm_bo_bind_calls.len(), count);
            assert_eq!(
                crate::owned_resource::finish_mapping(
                    &mut proc,
                    &mut AdvisoryLockManager::new(),
                    &mut host,
                    1,
                    token,
                    2,
                    if errno == 0 { Errno::ENOMEM as u32 } else { 0 }
                ),
                Err(Errno::EALREADY)
            );
            sys_munmap(&mut proc, &mut host, old, 0x10000).unwrap();
            release(&mut proc, &mut host, captured.source_token, 1, true);
            release(&mut proc, &mut host, token, 3, false);
            sys_close(&mut proc, &mut host, fd).unwrap();
            assert_eq!(host.gbm_bo_destroy_calls.len(), 1);
        }
    }
}

#[test]
fn owned_resource_fork_public_gem_close_and_fd_reuse_never_retarget_caps() {
    use crate::process_table::ProcessTable;
    let mut table = ProcessTable::new();
    let parent = table.create_process().unwrap();
    let mut host = MockHostIO::new();
    let p = table.get_mut(parent).unwrap();
    let fd = sys_open(p, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let token = acquire(p, &mut host, fd, 1);
    let captured = create(p, &mut host, token, 1);
    let handle = word(&captured, 16);
    let index = p.fd_table.get(fd).unwrap().ofd_ref.0;
    let old_bo = dri_state(p, index).unwrap().gem.borrow().handles[&handle];
    let child = table.fork_process_for_caller(parent, parent).unwrap();
    let c = table.get_mut(child).unwrap();
    let mut close = [0; 8];
    close[..4].copy_from_slice(&handle.to_le_bytes());
    sys_ioctl(c, &mut host, fd, DRM_IOCTL_GEM_CLOSE, &mut close).unwrap();
    assert_eq!(
        crate::dri::with_registry(|r| r.get(old_bo).unwrap().refcount),
        2
    );
    let p = table.get_mut(parent).unwrap();
    sys_close(p, &mut host, fd).unwrap();
    let replacement = sys_open(p, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    assert_eq!(replacement, fd);
    assert_eq!(raw_create(p, &mut host, replacement), handle);
    let new_index = p.fd_table.get(replacement).unwrap().ofd_ref.0;
    let new_bo = dri_state(p, new_index).unwrap().gem.borrow().handles[&handle];
    assert_ne!(old_bo, new_bo);
    release(p, &mut host, captured.source_token, 1, true);
    release(
        table.get_mut(child).unwrap(),
        &mut host,
        captured.source_token,
        1,
        true,
    );
    assert!(crate::dri::with_registry(|r| r.get(old_bo).is_none()));
    assert!(crate::dri::with_registry(|r| r.get(new_bo).is_some()));
    for pid in [parent, child] {
        let proc = table.get_mut(pid).unwrap();
        release(proc, &mut host, token, 2, false);
        sys_close(proc, &mut host, fd).unwrap();
    }
    assert_eq!(
        host.gbm_bo_destroy_calls
            .iter()
            .filter(|(_, bo)| *bo == old_bo)
            .count(),
        1
    );
    assert_eq!(
        host.gbm_bo_destroy_calls
            .iter()
            .filter(|(_, bo)| *bo == new_bo)
            .count(),
        1
    );
}
#[test]
fn owned_resource_fork_exec_exit_balance_cap_pins_without_synthetic_gem_close() {
    use crate::process_table::ProcessTable;
    for exec_parent in [false, true] {
        let mut table = ProcessTable::new();
        let parent = table.create_process().unwrap();
        let mut host = MockHostIO::new();
        let p = table.get_mut(parent).unwrap();
        let fd = sys_open(p, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
        let token = acquire(p, &mut host, fd, 1);
        let captured = create(p, &mut host, token, 1);
        let index = p.fd_table.get(fd).unwrap().ofd_ref.0;
        let bo = dri_state(p, index).unwrap().gem.borrow().handles[&word(&captured, 16)];
        let child = table.fork_process_for_caller(parent, parent).unwrap();
        let p = table.get_mut(parent).unwrap();
        if exec_parent {
            commit_exec_state(p, &mut host, parent).unwrap();
        } else {
            sys_exit(p, &mut host, 0);
        }
        let c = table.get_mut(child).unwrap();
        sys_exit(c, &mut host, 0);
        if exec_parent {
            assert_eq!(
                crate::dri::with_registry(|r| r.get(bo).unwrap().refcount),
                1
            );
            sys_close(table.get_mut(parent).unwrap(), &mut host, fd).unwrap();
        }
        assert!(crate::dri::with_registry(|r| r.get(bo).is_none()));
        assert_eq!(host.gbm_bo_destroy_calls.len(), 1);
    }
}
#[test]
fn owned_resource_mapping_finish_checks_real_task_and_fork_cannot_snapshot_constructor() {
    use crate::{process::ThreadInfo, process_table::ProcessTable};
    use wasm_posix_shared::mmap::*;
    let mut table = ProcessTable::new();
    let pid = table.create_process().unwrap();
    let tid = pid + 100;
    let mut host = MockHostIO::new();
    let p = table.get_mut(pid).unwrap();
    p.add_thread(ThreadInfo::new(tid, 0, 0, 0));
    let fd = sys_open(p, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let token = acquire(p, &mut host, fd, 1);
    let captured = create(p, &mut host, token, 1);
    table.bind_current_tid(pid, tid).unwrap();
    let mut map = W::Packet {
        action: W::MMAP,
        token,
        transaction: 2,
        acknowledge: 1,
        source_token: captured.source_token,
        length: 32,
        ..Default::default()
    };
    map.body[8..16].copy_from_slice(&64u64.to_le_bytes());
    map.body[24..28].copy_from_slice(&PROT_READ.to_le_bytes());
    map.body[28..32].copy_from_slice(&MAP_SHARED.to_le_bytes());
    let mut bytes = [0; 320];
    unsafe { core::ptr::write_unaligned(bytes.as_mut_ptr().cast(), map) };
    table.ioctl(&mut host, -1, W::REQUEST, &mut bytes).unwrap();
    let pending: W::Packet = unsafe { core::ptr::read_unaligned(bytes.as_ptr().cast()) };
    assert_eq!(pending.state, W::PENDING);
    assert!(host.gbm_bo_bind_calls.is_empty());
    assert_eq!(
        table.finish_owned_mapping(&mut host, pid, pid, token, 2, 0),
        Err(Errno::EACCES)
    );
    assert_eq!(
        table.finish_owned_mapping(&mut host, pid, 999_999, token, 2, 0),
        Err(Errno::ESRCH)
    );
    assert_eq!(table.fork_process_for_caller(pid, pid), Err(Errno::EBUSY));
    table
        .finish_owned_mapping(&mut host, pid, tid, token, 2, 0)
        .unwrap();
    assert_eq!(host.gbm_bo_bind_calls.len(), 1);
    table
        .finish_owned_mapping(&mut host, pid, tid, token, 2, 0)
        .unwrap();
    assert_eq!(host.gbm_bo_bind_calls.len(), 1);
    let c = table.fork_process_for_caller(pid, pid).unwrap();
    sys_exit(table.get_mut(c).unwrap(), &mut host, 0);
    sys_exit(table.get_mut(pid).unwrap(), &mut host, 0);
    assert_eq!(host.gbm_bo_destroy_calls.len(), 1);
}
#[test]
fn owned_resource_forced_removal_rolls_back_staged_split_holds_before_old_mapping_release() {
    use crate::process_table::ProcessTable;
    use wasm_posix_shared::mmap::*;
    let mut table = ProcessTable::new();
    let pid = table.create_process().unwrap();
    let mut host = MockHostIO::new();
    let p = table.get_mut(pid).unwrap();
    let fd = sys_open(p, &mut host, b"/dev/dri/renderD128", O_RDWR, 0).unwrap();
    let token = acquire(p, &mut host, fd, 1);
    let mut large = operation(token, 1, DRM_IOCTL_MODE_CREATE_DUMB, 32);
    large.flags = W::CAPTURE_BO;
    for (offset, value) in [(0, 768u32), (4, 64), (8, 32)] {
        large.body[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    let old = call(p, &mut host, large);
    assert_eq!(old.result, 0);
    let index = p.fd_table.get(fd).unwrap().ofd_ref.0;
    let old_bo = dri_state(p, index).unwrap().gem.borrow().handles[&word(&old, 16)];
    let addr = sys_mmap(
        p,
        &mut host,
        0,
        0x30000,
        PROT_READ | PROT_WRITE,
        MAP_SHARED,
        fd,
        (u64::from(old_bo) << 12) as i64,
    )
    .unwrap();
    release(p, &mut host, old.source_token, 1, true);
    let new = create(p, &mut host, token, 2);
    let new_bo = dri_state(p, index).unwrap().gem.borrow().handles[&word(&new, 16)];
    let mut map = W::Packet {
        action: W::MMAP,
        token,
        transaction: 3,
        acknowledge: 2,
        source_token: new.source_token,
        length: 32,
        ..Default::default()
    };
    map.body[..8].copy_from_slice(&((addr + 0x10000) as u64).to_le_bytes());
    map.body[8..16].copy_from_slice(&64u64.to_le_bytes());
    map.body[24..28].copy_from_slice(&PROT_READ.to_le_bytes());
    map.body[28..32].copy_from_slice(&(MAP_SHARED | MAP_FIXED).to_le_bytes());
    assert_eq!(try_packet(p, &mut host, map).1.state, W::PENDING);
    assert_eq!(
        crate::dri::with_registry(|r| r.get(old_bo).unwrap().refcount),
        2
    );
    let removed = table.remove_process(pid).unwrap();
    assert!(crate::dri::with_registry(
        |r| r.get(old_bo).is_none() && r.get(new_bo).is_none()
    ));
    assert_eq!(
        removed
            .dri_effects
            .iter()
            .filter(|e| **e == DriReleaseEffect::DestroyBo(old_bo))
            .count(),
        1
    );
    assert_eq!(
        removed
            .dri_effects
            .iter()
            .filter(|e| **e == DriReleaseEffect::DestroyBo(new_bo))
            .count(),
        1
    );
}
