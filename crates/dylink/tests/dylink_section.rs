//! `dylink.0` parsing, including the weak-import namespace fix.

mod support;

use dylink::{parse_dylink_section, DylinkError, GotKind};
use support::{DylinkSection, SideModule, FLAG_TLS, FLAG_WEAK};

#[test]
fn memory_and_table_reservations_round_trip() {
    let bytes = SideModule {
        dylink: DylinkSection {
            memory_size: 570_364,
            memory_align: 4,
            table_size: 2_357,
            table_align: 0,
            needed: vec!["libc++.so".into(), "libicuuc.so".into()],
            ..Default::default()
        },
        ..Default::default()
    }
    .encode();

    let metadata = parse_dylink_section(&bytes).expect("dylink.0");
    assert_eq!(metadata.memory_size, 570_364);
    assert_eq!(metadata.memory_align, 4);
    assert_eq!(metadata.memory_align_bytes(), Ok(16));
    assert_eq!(metadata.table_size, 2_357);
    assert_eq!(metadata.needed_dynlibs, vec!["libc++.so", "libicuuc.so"]);
}

#[test]
fn tls_exports_are_collected() {
    let bytes = SideModule {
        dylink: DylinkSection {
            export_info: vec![
                ("errno_storage".into(), FLAG_TLS),
                ("plain_data".into(), 0),
            ],
            ..Default::default()
        },
        ..Default::default()
    }
    .encode();

    let metadata = parse_dylink_section(&bytes).expect("dylink.0");
    assert!(metadata.tls_exports.contains("errno_storage"));
    assert!(!metadata.tls_exports.contains("plain_data"));
}

/// `host/src/dylink.ts:334-340` reads the import-info record's module name into
/// `_module` and discards it, keying the weak set on the field alone. That
/// conflates `env.foo`, `GOT.mem.foo` and `GOT.func.foo`, which are three
/// different imports. The port keys on the pair the section actually encodes.
#[test]
fn weak_flags_are_keyed_by_namespace_and_field() {
    let bytes = SideModule {
        dylink: DylinkSection {
            import_info: vec![
                ("GOT.mem".into(), "optional_hook".into(), FLAG_WEAK),
                ("GOT.mem".into(), "required_table".into(), 0),
                ("GOT.func".into(), "optional_hook".into(), 0),
                ("env".into(), "maybe_present".into(), FLAG_WEAK),
            ],
            ..Default::default()
        },
        ..Default::default()
    }
    .encode();

    let metadata = parse_dylink_section(&bytes).expect("dylink.0");

    assert!(metadata.is_weak_import("GOT.mem", "optional_hook"));
    assert!(!metadata.is_weak_import("GOT.mem", "required_table"));
    // The SAME field name in a different namespace is a different import, and
    // this one was not flagged weak.
    assert!(!metadata.is_weak_import("GOT.func", "optional_hook"));
    assert!(metadata.is_weak_import("env", "maybe_present"));

    // `is_weak_symbol` folds `env` in deliberately: ELF weakness is a property
    // of the symbol-table entry, not of one relocation, so a weak `env.x`
    // declaration makes `x` a weak reference from this object.
    assert!(metadata.is_weak_symbol(GotKind::Mem, "optional_hook"));
    assert!(metadata.is_weak_symbol(GotKind::Func, "maybe_present"));
    assert!(!metadata.is_weak_symbol(GotKind::Mem, "required_table"));

    let recorded: Vec<(&str, &str)> = metadata.weak_imports().collect();
    assert_eq!(
        recorded,
        vec![("GOT.mem", "optional_hook"), ("env", "maybe_present")]
    );
    assert_eq!(metadata.import_flags("GOT.func", "optional_hook"), Some(0));
    assert_eq!(metadata.import_flags("GOT.func", "absent"), None);
}

#[test]
fn a_main_module_is_not_a_shared_library() {
    let bytes = SideModule { omit_dylink: true, ..Default::default() }.encode();
    assert_eq!(parse_dylink_section(&bytes), Err(DylinkError::NotASharedLibrary));
}

/// A `dylink.0` section that is not the module's FIRST section does not count:
/// the ABI requires that position, and accepting a later one would let an
/// arbitrary custom section masquerade as linking metadata.
#[test]
fn a_late_dylink_section_is_not_accepted() {
    let mut bytes = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    // An unrelated custom section first.
    let mut decoy = Vec::new();
    support::name("producers", &mut decoy);
    support::section(0, decoy, &mut bytes);
    support::section(0, DylinkSection::default().encode(), &mut bytes);
    assert_eq!(parse_dylink_section(&bytes), Err(DylinkError::NotASharedLibrary));
}

/// Unknown sub-sections are the ABI's forward-compatibility mechanism and must
/// be skipped, not rejected.
#[test]
fn unknown_subsections_are_skipped() {
    let bytes = SideModule {
        dylink: DylinkSection {
            memory_size: 32,
            memory_align: 3,
            needed: vec!["libm.so".into()],
            unknown_subsection: Some((99, vec![1, 2, 3, 4, 5])),
            ..Default::default()
        },
        ..Default::default()
    }
    .encode();

    let metadata = parse_dylink_section(&bytes).expect("dylink.0");
    assert_eq!(metadata.memory_size, 32);
    assert_eq!(metadata.needed_dynlibs, vec!["libm.so"]);
}

/// A KNOWN sub-section whose declared size disagrees with its contents is a
/// malformed artifact, not a forward-compatible one. The TypeScript trusts the
/// declared size unconditionally and would silently drop entries.
#[test]
fn a_known_subsection_with_a_wrong_size_is_rejected() {
    let good = SideModule {
        dylink: DylinkSection {
            needed: vec!["libm.so".into(), "libc++.so".into()],
            ..Default::default()
        },
        ..Default::default()
    }
    .encode();
    // Find the NEEDED sub-section's size byte and shrink it by one.
    let needle = parse_dylink_section(&good).expect("baseline");
    assert_eq!(needle.needed_dynlibs.len(), 2);

    let mut corrupted = good.clone();
    // The NEEDED sub-section is the second one; locate its declared size by
    // searching for the id byte followed by a plausible size.
    let position = corrupted
        .windows(2)
        .position(|window| window[0] == 2 && window[1] as usize > 4)
        .expect("NEEDED sub-section header");
    corrupted[position + 1] -= 1;
    assert!(matches!(
        parse_dylink_section(&corrupted),
        Err(DylinkError::MalformedDylinkSection(_)) | Err(DylinkError::MalformedModule(_))
    ));
}

#[test]
fn an_out_of_range_alignment_is_rejected_rather_than_shifted() {
    let bytes = SideModule {
        dylink: DylinkSection { memory_align: 64, ..Default::default() },
        ..Default::default()
    }
    .encode();
    let metadata = parse_dylink_section(&bytes).expect("dylink.0");
    // `1 << 64` is undefined behaviour in C and a panic in debug Rust; the
    // TypeScript produced `1` via JavaScript's modulo-32 shift.
    assert!(metadata.memory_align_bytes().is_err());
}
