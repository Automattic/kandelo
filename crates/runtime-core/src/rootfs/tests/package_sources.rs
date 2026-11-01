use super::*;
use crate::package_inventory::{self, Content, File, Inventory, PackageSpec};
use crate::rootfs::package_sources::pin_inventory;

fn inventory(uri: &[u8], archive: bool) -> Vec<u8> {
    let mut section = crate::sdef::decode(&persistent_providers::provider(archive, 128)).unwrap();
    if archive { section.archives[0].uri = uri.to_vec(); }
    else { section.records[0].uri = uri.to_vec(); }
    let provider = crate::sdef::encode(&section.archives, &section.records).unwrap();
    package_inventory::encode(55, [7; 32], &[PackageSpec {
        name: b"core", version: b"1", content_digest: None, dependencies: &[],
    }], &[File { path: b"/program", package: 0, mode: 0o6755, uid: 12, gid: 34,
        content: Content::Deferred { size: section.records[0].size, digest: section.records[0].digest, provider: &provider },
    }]).unwrap().to_vec()
}

#[test]
fn package_sources_pin_native_file_and_archive_descriptions_without_changing_package_content() {
    let _guard = TestGuard::acquire();
    let directory = alloc::format!("https://example.test/{}/", "a".repeat(64));
    let next = alloc::format!("https://example.test/{}/", "b".repeat(64));
    for archive in [false, true] {
        let before = inventory(b"kandelo-lazy:programs/runtime.zip", archive);
        let bound = pin_inventory(&before, directory.as_bytes()).unwrap();
        let first = Inventory::decode(&before).unwrap();
        let second = Inventory::decode(&bound).unwrap();
        assert_ne!(first.digest(), second.digest());
        assert_eq!(first.program_abi(), second.program_abi());
        assert_eq!(first.program_digest(), second.program_digest());
        assert_eq!(first.packages()[0].content_digest, second.packages()[0].content_digest);
        let file = second.files()[0];
        assert_eq!((file.mode, file.uid, file.gid), (0o6755, 12, 34));
        assert_eq!(file.content.file_identity(), first.files()[0].content.file_identity());
        let Content::Deferred { provider, .. } = file.content else { panic!("deferred file expected"); };
        let decoded = crate::sdef::decode(provider).unwrap();
        let original = crate::sdef::decode(match first.files()[0].content {
            Content::Deferred { provider, .. } => provider, _ => unreachable!(),
        }).unwrap();
        let uri = if archive { &decoded.archives[0].uri } else { &decoded.records[0].uri };
        assert_eq!(uri, alloc::format!("{directory}assets/programs/wasm32/runtime.zip").as_bytes());
        assert_eq!(decoded.records[0].payload, original.records[0].payload);
        if archive { assert_eq!(decoded.archives[0].payload, original.archives[0].payload); }
        assert_eq!(pin_inventory(&bound, next.as_bytes()).unwrap().as_slice(), bound.as_slice());
        assert_eq!(Inventory::decode(&before).unwrap().digest(), first.digest());
    }
}

#[test]
fn package_sources_binding_preserves_complete_dependency_commitments() {
    let _guard = TestGuard::acquire();
    let original = inventory(b"kandelo-lazy:programs/tool.wasm", false);
    let core = Inventory::decode(&original).unwrap();
    let file = core.files()[0];
    let dependency = [package_inventory::Dependency { package: 0, content_digest: core.packages()[0].content_digest }];
    let before = package_inventory::encode(55, [7; 32], &[
        PackageSpec { name: b"core", version: b"1", content_digest: Some(core.packages()[0].content_digest), dependencies: &[] },
        PackageSpec { name: b"tool", version: b"1", content_digest: None, dependencies: &dependency },
    ], &[File { path: b"/another", package: 1, ..file }, file]).unwrap();
    let directory = alloc::format!("https://example.test/{}/", "a".repeat(64));
    let pinned = pin_inventory(&before, directory.as_bytes()).unwrap();
    let old = Inventory::decode(&before).unwrap();
    let new = Inventory::decode(&pinned).unwrap();
    for (old, new) in old.packages().iter().zip(new.packages()) {
        assert_eq!(old.content_digest, new.content_digest);
        assert_eq!(old.dependencies().collect::<Vec<_>>(), new.dependencies().collect::<Vec<_>>());
    }
    assert_eq!(new.packages()[1].dependencies().next(), Some(dependency[0]));
}

#[test]
fn package_sources_binding_refusal_releases_all_package_owners_and_does_not_modify_the_filesystem() {
    let _guard = TestGuard::acquire();
    let directory = alloc::format!("https://example.test/{}/", "a".repeat(64));
    let (image, journal, _) = package_upgrade::computer();
    let before = inventory(b"kandelo-lazy:programs/tool.wasm", false);
    let namespace = export_tree();
    let committed = journal.0.lock().clone();
    let baseline = crate::metadata_budget::PACKAGE_METADATA.usage();
    let io = crate::io_buffer::IO_MEMORY.usage().0;
    crate::metadata_budget::PACKAGE_METADATA.set_limit(baseline.0).unwrap();
    let result = pin_inventory(&before, directory.as_bytes());
    crate::metadata_budget::PACKAGE_METADATA.set_limit(baseline.1).unwrap();
    assert!(matches!(result, Err(Errno::ENOMEM)));
    assert_eq!(crate::metadata_budget::PACKAGE_METADATA.usage(), baseline);
    assert_eq!(export_tree(), namespace);
    assert_eq!(*journal.0.lock(), committed);
    assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, io);
    assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
    assert!(pin_inventory(&before, directory.as_bytes()).is_ok());
    drop(image);
}
