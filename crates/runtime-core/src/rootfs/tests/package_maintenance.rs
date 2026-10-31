use super::package_upgrade::{computer, contents, file, manifest};
use super::*;
use crate::process_table::ProcessTable;
use crate::rootfs::package_maintenance::Maintenance;
use crate::rootfs::package_upgrade::{Error, Phase, Recovery};
use wasm_posix_shared::package_maintenance_wire as wire;

fn enter_packet() -> [u8; 40] {
    let mut bytes = [0; 40];
    bytes[..4].copy_from_slice(&wire::VERSION.to_le_bytes());
    bytes[8..].fill(7);
    bytes
}

fn word(bytes: &[u8], offset: u32) -> u32 {
    u32::from_le_bytes(
        bytes[offset as usize..offset as usize + 4]
            .try_into()
            .unwrap(),
    )
}

#[test]
fn package_maintenance_control_transports_inventory_progress_staging_and_explicit_release() {
    let _guard = TestGuard::acquire();
    let (image, _journal, _) = computer();
    let mut source = image_host(&image);
    let after = manifest(b"2", &[file(b"/hello.txt", b"updated")]);
    let mut table = ProcessTable::new();
    let mut controller = crate::rootfs::package_maintenance::control::Controller::new();
    controller
        .call(
            &mut table,
            wire::OP_ENTER,
            0,
            0,
            &mut enter_packet(),
            &mut source,
        )
        .unwrap();
    assert_eq!(table.create_process(), Err(Errno::EBUSY));
    let mut incoming = after.clone();
    assert_eq!(
        controller.call(
            &mut table,
            wire::OP_UPLOAD_INVENTORY,
            0,
            0,
            &mut incoming,
            &mut source
        ),
        Ok(after.len())
    );
    let mut out = [0; 512];
    assert_eq!(
        controller.call(&mut table, wire::OP_PROGRESS, 0, 0, &mut out, &mut source),
        Ok(64)
    );
    assert_eq!(
        u64::from_le_bytes(out[48..56].try_into().unwrap()),
        after.len() as u64
    );
    controller
        .call(&mut table, wire::OP_BEGIN, 0, 0, &mut [], &mut source)
        .unwrap();
    assert_eq!(
        controller.call(&mut table, wire::OP_PROGRESS, 0, 0, &mut out, &mut source),
        Ok(74)
    );
    assert_eq!(word(&out, wire::PROGRESS_VERSION_OFFSET), wire::VERSION);
    assert_eq!(word(&out, wire::PROGRESS_FILE_COUNT_OFFSET), 1);
    assert_eq!(
        word(&out, wire::PROGRESS_CURRENT_KIND_OFFSET),
        wire::CURRENT_INSTALLED
    );
    assert_eq!(&out[64..74], b"/hello.txt");
    while controller
        .call(
            &mut table,
            wire::OP_VERIFY_INSTALLED,
            1024,
            0,
            &mut [],
            &mut source,
        )
        .unwrap()
        == 0
    {}
    controller
        .call(&mut table, wire::OP_PREPARE, 0, 0, &mut [], &mut source)
        .unwrap();
    assert_eq!(
        controller.call(&mut table, wire::OP_RECOVERY, 0, 0, &mut [], &mut source),
        Ok(wire::RECOVERY_PENDING as usize)
    );
    assert_eq!(
        controller.call(
            &mut table,
            wire::OP_STAGING_FILE,
            0,
            0,
            &mut out,
            &mut source
        ),
        Ok(26)
    );
    assert_eq!(word(&out, wire::STAGING_KIND_OFFSET), wire::STAGING_UPLOAD);
    assert_eq!(&out[16..26], b"/hello.txt");
    assert_eq!(u64::from_le_bytes(out[8..16].try_into().unwrap()), 7);
    controller
        .call(
            &mut table,
            wire::OP_STAGE,
            0,
            0,
            &mut b"updated".to_owned(),
            &mut source,
        )
        .unwrap();
    controller
        .call(&mut table, wire::OP_CANCEL, 0, 0, &mut [], &mut source)
        .unwrap();
    assert_eq!(
        controller.call(&mut table, wire::OP_LEAVE, 0, 0, &mut [], &mut source),
        Err(Error::Storage(Errno::EBUSY))
    );
    assert_eq!(table.create_process(), Err(Errno::EBUSY));
    controller
        .call(&mut table, wire::OP_RESUME, 0, 0, &mut [], &mut source)
        .unwrap();
    while controller
        .call(
            &mut table,
            wire::OP_VERIFY_INSTALLED,
            1024,
            0,
            &mut [],
            &mut source,
        )
        .unwrap()
        == 0
    {}
    while controller
        .call(
            &mut table,
            wire::OP_VERIFY_STAGED,
            1024,
            0,
            &mut [],
            &mut source,
        )
        .unwrap()
        == 0
    {}
    controller
        .call(&mut table, wire::OP_COMMIT, 0, 0, &mut [], &mut source)
        .unwrap();
    assert_eq!(
        controller.call(&mut table, wire::OP_RECOVERY, 0, 0, &mut [], &mut source),
        Ok(wire::RECOVERY_ACTIVE as usize)
    );
    assert_eq!(table.create_process(), Err(Errno::EBUSY));
    controller
        .call(&mut table, wire::OP_LEAVE, 0, 0, &mut [], &mut source)
        .unwrap();
    assert!(!table.is_in_maintenance());
    assert_eq!(contents(b"/hello.txt", &mut source), b"updated");
    assert_eq!(
        contents(b"/user-post", &mut source),
        b"retain database and uploads"
    );
}

#[test]
fn package_maintenance_control_refuses_bad_wire_versions_arguments_and_buffers_before_work() {
    let _guard = TestGuard::acquire();
    let (image, _journal, _) = computer();
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let mut controller = crate::rootfs::package_maintenance::control::Controller::new();
    let mut future = enter_packet();
    future[..4].copy_from_slice(&999u32.to_le_bytes());
    assert_eq!(
        controller.call(&mut table, wire::OP_ENTER, 0, 0, &mut future, &mut source),
        Err(Error::Storage(Errno::EOPNOTSUPP))
    );
    assert!(!table.is_in_maintenance());
    assert_eq!(
        controller.call(&mut table, wire::OP_LAST_ERROR, 0, 0, &mut [], &mut source),
        Ok(wire::ERROR_STORAGE as usize)
    );
    controller
        .call(
            &mut table,
            wire::OP_ENTER,
            0,
            0,
            &mut enter_packet(),
            &mut source,
        )
        .unwrap();
    for (opcode, index, offset, length, expected) in [
        (wire::OP_UPLOAD_INVENTORY, 0, 0, 65537, Errno::E2BIG),
        (wire::OP_PROGRESS, 1, 0, 64, Errno::EINVAL),
        (wire::OP_PROGRESS, 0, 1, 64, Errno::EINVAL),
        (wire::OP_PROGRESS, 0, 0, 63, Errno::ENOBUFS),
        (wire::OP_RECOVERY, 0, 0, 1, Errno::EINVAL),
        (999, 0, 0, 0, Errno::EINVAL),
    ] {
        assert_eq!(
            controller.call(
                &mut table,
                opcode,
                index,
                offset,
                &mut vec![0; length],
                &mut source
            ),
            Err(Error::Storage(expected))
        );
    }
    assert_eq!(
        controller.call(&mut table, wire::OP_RECOVERY, 0, 0, &mut [], &mut source),
        Ok(0)
    );
    controller
        .call(&mut table, wire::OP_LEAVE, 0, 0, &mut [], &mut source)
        .unwrap();
}

#[test]
fn package_maintenance_control_retains_typed_conflict_reason_without_overwriting_user_data() {
    let _guard = TestGuard::acquire();
    let (image, _journal, _) = computer();
    let mut source = image_host(&image);
    write_file_at(b"/hello.txt", 0, b"evil! sffs\n", 0o644, true, &mut source).unwrap();
    let mut after = manifest(b"2", &[file(b"/hello.txt", b"updated")]);
    let mut table = ProcessTable::new();
    let mut controller = crate::rootfs::package_maintenance::control::Controller::new();
    controller
        .call(
            &mut table,
            wire::OP_ENTER,
            0,
            0,
            &mut enter_packet(),
            &mut source,
        )
        .unwrap();
    controller
        .call(
            &mut table,
            wire::OP_UPLOAD_INVENTORY,
            0,
            0,
            &mut after,
            &mut source,
        )
        .unwrap();
    controller
        .call(&mut table, wire::OP_BEGIN, 0, 0, &mut [], &mut source)
        .unwrap();
    let error = controller
        .call(
            &mut table,
            wire::OP_VERIFY_INSTALLED,
            1024,
            0,
            &mut [],
            &mut source,
        )
        .unwrap_err();
    assert_eq!(
        crate::rootfs::package_maintenance::control::error_errno(error),
        Errno::EBUSY
    );
    assert_eq!(
        controller.call(&mut table, wire::OP_LAST_ERROR, 0, 0, &mut [], &mut source),
        Ok(wire::ERROR_CONTENTS as usize)
    );
    assert_eq!(
        controller.call(&mut table, wire::OP_LAST_ERROR, 0, 0, &mut [], &mut source),
        Ok(wire::ERROR_CONTENTS as usize)
    );
    assert_eq!(contents(b"/hello.txt", &mut source), b"evil! sffs\n");
    controller
        .call(&mut table, wire::OP_CANCEL, 0, 0, &mut [], &mut source)
        .unwrap();
    controller
        .call(&mut table, wire::OP_LEAVE, 0, 0, &mut [], &mut source)
        .unwrap();
}

#[test]
fn maintenance_session_keeps_guest_admission_closed_until_recovery_and_compatible_commit() {
    let _guard = TestGuard::acquire();
    let (image, _journal, _before) = computer();
    let after = manifest(b"2", &[file(b"/hello.txt", b"updated")]);
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let mut session = Maintenance::enter(&mut table, 55, [7; 32]).unwrap();
    assert_eq!(table.create_process(), Err(Errno::EBUSY));
    assert_eq!(
        session.upload_inventory(&table, 1, &after),
        Err(Error::Storage(Errno::EINVAL))
    );
    let first = after.len() / 2;
    session
        .upload_inventory(&table, 0, &after[..first])
        .unwrap();
    session
        .upload_inventory(&table, first, &after[first..])
        .unwrap();
    session.begin_upgrade(&table, &mut source).unwrap();
    while !session.verify_next(&table, 1024, &mut source).unwrap() {}
    session.prepare(&table, &mut source).unwrap();
    session
        .stage(&table, 0, 0, b"updated", &mut source)
        .unwrap();
    assert_eq!(
        session.leave(&mut table, &mut source),
        Err(Error::Storage(Errno::EBUSY))
    );
    assert_eq!(table.create_process(), Err(Errno::EBUSY));
    session.resume_upgrade(&table, &mut source).unwrap();
    while !session.verify_next(&table, 1024, &mut source).unwrap() {}
    while !session
        .verify_staged_next(&table, 1024, &mut source)
        .unwrap()
    {}
    session.commit(&table).unwrap();
    assert_eq!(
        session.recovery(&table, &mut source).unwrap(),
        Recovery::Transaction(Phase::Active)
    );
    assert_eq!(table.create_process(), Err(Errno::EBUSY));
    session.leave(&mut table, &mut source).unwrap();
    assert!(!table.is_in_maintenance());
    assert_eq!(table.create_process(), Ok(100));
    assert_eq!(contents(b"/hello.txt", &mut source), b"updated");
    assert_eq!(
        contents(b"/user-post", &mut source),
        b"retain database and uploads"
    );
    assert!(matches!(
        session.recovery(&table, &mut source),
        Err(Error::Storage(Errno::EPERM))
    ));
}

#[test]
fn maintenance_session_rejects_incompatible_installed_programs_without_releasing_admission() {
    let _guard = TestGuard::acquire();
    let (image, _journal, before) = computer();
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let mut session = Maintenance::enter(&mut table, 55, [8; 32]).unwrap();
    assert_eq!(
        session.leave(&mut table, &mut source),
        Err(Error::Storage(Errno::ENOEXEC))
    );
    assert!(table.is_in_maintenance());
    assert_eq!(table.create_process(), Err(Errno::EBUSY));
    assert_eq!(
        contents(crate::rootfs::package_upgrade::INSTALLED, &mut source),
        before
    );
}

#[test]
fn maintenance_session_can_cancel_bad_input_without_changing_the_installed_computer() {
    let _guard = TestGuard::acquire();
    let (image, _journal, before) = computer();
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let mut session = Maintenance::enter(&mut table, 55, [7; 32]).unwrap();
    assert_eq!(
        session.upload_inventory(&table, 0, &vec![0; 65537]),
        Err(Error::Storage(Errno::EINVAL))
    );
    session
        .upload_inventory(&table, 0, b"not an inventory")
        .unwrap();
    assert!(session.begin_upgrade(&table, &mut source).is_err());
    assert_eq!(
        session.recovery(&table, &mut source).unwrap(),
        Recovery::None
    );
    session.cancel_operation(&table).unwrap();
    session.leave(&mut table, &mut source).unwrap();
    assert_eq!(
        contents(crate::rootfs::package_upgrade::INSTALLED, &mut source),
        before
    );
    assert_eq!(contents(b"/hello.txt", &mut source), b"hello sffs\n");
}

#[test]
fn pending_upgrade_boot_blocks_guests_until_explicit_compatible_maintenance_release() {
    let _guard = TestGuard::acquire();
    let (image, journal, before) = computer();
    let mut source = image_host(&image);
    let after = manifest(b"2", &[file(b"/hello.txt", b"updated")]);
    let mut old_table = ProcessTable::new();
    let mut old = Maintenance::enter(&mut old_table, 55, [7; 32]).unwrap();
    old.upload_inventory(&old_table, 0, &after).unwrap();
    old.begin_upgrade(&old_table, &mut source).unwrap();
    while !old.verify_next(&old_table, 1024, &mut source).unwrap() {}
    old.prepare(&old_table, &mut source).unwrap();
    drop(old);
    drop(old_table);
    load_image(image.len() as u64, &mut source).unwrap();
    enable_resizable_persistence(
        Box::new(journal),
        Sha256::digest(&image).into(),
        &mut source,
    )
    .unwrap();
    let mut current_table = ProcessTable::new();
    assert_eq!(current_table.create_process(), Err(Errno::EBUSY));
    assert!(current_table.all_pids().is_empty());
    let mut session = Maintenance::enter(&mut current_table, 55, [7; 32]).unwrap();
    assert_eq!(
        session.recovery(&current_table, &mut source),
        Ok(Recovery::Transaction(Phase::Pending))
    );
    session
        .discard_transaction(&current_table, &mut source)
        .unwrap();
    assert_eq!(current_table.create_process(), Err(Errno::EBUSY));
    session.leave(&mut current_table, &mut source).unwrap();
    assert_eq!(current_table.create_process(), Ok(100));
    assert_eq!(
        contents(crate::rootfs::package_upgrade::INSTALLED, &mut source),
        before
    );
}

#[test]
fn maintenance_entry_on_a_nonpersistent_image_refuses_without_closing_guest_admission() {
    let _guard = TestGuard::acquire();
    let image = tiny_vfs_described();
    load_image(image.len() as u64, &mut image_host(image)).unwrap();
    let mut table = ProcessTable::new();
    assert!(matches!(
        Maintenance::enter(&mut table, 55, [7; 32]),
        Err(Error::Storage(Errno::EOPNOTSUPP))
    ));
    assert!(!table.is_in_maintenance());
    assert_eq!(table.create_process(), Ok(100));
}

#[test]
fn unknown_package_authority_blocks_boot_without_losing_readable_files_or_changing_the_journal() {
    let _guard = TestGuard::acquire();
    let (image, journal, before) = computer();
    let mut source = image_host(&image);
    let mut table = ProcessTable::new();
    let mut session = Maintenance::enter(&mut table, 55, [7; 32]).unwrap();
    let after = manifest(b"2", &[file(b"/hello.txt", b"updated")]);
    session.upload_inventory(&table, 0, &after).unwrap();
    session.begin_upgrade(&table, &mut source).unwrap();
    while !session.verify_next(&table, 1024, &mut source).unwrap() {}
    session.prepare(&table, &mut source).unwrap();
    write_file_at(
        b"/var/lib/kandelo/packages/transaction/status",
        0,
        b"unknown control",
        0o600,
        true,
        &mut source,
    )
    .unwrap();
    sync_persistence().unwrap();
    let physical = journal.0.lock().clone();
    drop(session);
    drop(table);
    load_image(image.len() as u64, &mut source).unwrap();
    enable_resizable_persistence(
        Box::new(journal.clone()),
        Sha256::digest(&image).into(),
        &mut source,
    )
    .unwrap();
    let mut table = ProcessTable::new();
    assert_eq!(table.create_process(), Err(Errno::EBUSY));
    assert_eq!(*journal.0.lock(), physical);
    assert_eq!(
        contents(b"/user-post", &mut source),
        b"retain database and uploads"
    );
    assert_eq!(
        contents(crate::rootfs::package_upgrade::INSTALLED, &mut source),
        before
    );
}
