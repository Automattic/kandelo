use fork_instrument::{
    artifact_io::{ArtifactSpool, MappedArtifact},
    streaming::*,
};
use std::io::Write;

#[test]
fn private_snapshot_survives_source_replacement_and_supports_empty_files() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("input");
    std::fs::write(&path, b"original").unwrap();
    let (snapshot, permissions) = MappedArtifact::read(&path, 8).unwrap();
    std::fs::write(&path, b"changed").unwrap();
    assert_eq!(snapshot.bytes(), b"original");
    snapshot.publish(&path, permissions).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"original");
    assert!(
        MappedArtifact::snapshot(&b""[..], 0)
            .unwrap()
            .bytes()
            .is_empty()
    );
    assert!(MappedArtifact::read(&path, 7).is_err());
}

#[test]
fn output_and_source_copies_stop_at_their_byte_limit() {
    assert!(MappedArtifact::snapshot(&b"1234"[..], 3).is_err());
    let mut spool = ArtifactSpool::new(3).unwrap();
    spool.write_all(b"12").unwrap();
    assert!(spool.write_all(b"34").is_err());
    spool.write_all(b"3").unwrap();
    assert_eq!(spool.freeze().unwrap().bytes(), b"123");
}

#[test]
fn code_and_data_spools_enforce_limits_before_the_section_is_published() {
    for source in [
        "(module (func nop nop nop))",
        "(module (memory 1) (data (i32.const 0) \"123456789\"))",
    ] {
        let input = wat::parse_str(source).unwrap();
        let scanned = scan(&input).unwrap();
        let mut output = Vec::new();
        let error = emit_remapped(
            &scanned,
            &mut wasm_encoder::reencode::RoundtripReencoder,
            &mut output,
            EmitLimits {
                max_spooled_section_bytes: 2,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(
            format!("{error:#}").contains("spool exceeds disk budget"),
            "{error:#}"
        );
    }
}

#[cfg(unix)]
#[test]
fn atomic_publication_replaces_the_destination_entry_without_following_symlinks() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("target");
    let destination = directory.path().join("link");
    std::fs::write(&target, b"leave target intact").unwrap();
    symlink(&target, &destination).unwrap();
    let snapshot = MappedArtifact::snapshot(&b"published"[..], 9).unwrap();
    snapshot
        .publish(&destination, std::fs::Permissions::from_mode(0o751))
        .unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"leave target intact");
    assert_eq!(std::fs::read(&destination).unwrap(), b"published");
    assert!(
        !std::fs::symlink_metadata(&destination)
            .unwrap()
            .is_symlink()
    );
    assert_eq!(
        std::fs::metadata(&destination)
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        0o751
    );
}
