//! Publication policy for a VFS image: the checks an artifact must pass before
//! it ships, expressed where the writer is rather than beside the caller.
//!
//! # Why these live here
//!
//! Three assertions guard a published image today, and all three sit inside
//! `serializeImage` in `images/vfs/scripts/vfs-image-helpers.ts`: runtime
//! headroom, the encoded growth ceiling, and an ABI check on every Wasm
//! artifact the image carries. They are not format work, but losing them is
//! worse than losing format work -- images are validated by being run, so a
//! product image published without its size guarantee fails somewhere
//! unrelated, days later.
//!
//! Lane Y measured their coverage before moving them, by disabling each CALL
//! SITE inside `serializeImage` rather than each function body: a unit test on
//! the function cannot notice the function being unwired, and unwiring is what
//! a migration does. Headroom and capacity had exactly ONE detector each. That
//! is the argument for moving them next to the writer: a new image path should
//! not be able to skip them by forgetting a line.
//!
//! # Why the values are `u64`
//!
//! The TypeScript checks open by validating that each limit "must be a
//! non-negative safe integer", because a JavaScript number can be -3, 1.5, or
//! 2^60. Here the type says it. Those validations have no Rust counterpart on
//! purpose -- they are not missing, they are unrepresentable.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

use crate::kandelo_image_fs::{file_type, BlockSource, KandeloImageFs, ROOT_INO};

/// What a product image must still have free when it ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Headroom {
    pub minimum_free_bytes: u64,
    pub minimum_free_inodes: u64,
}

/// A headroom verdict WITH the numbers behind it, whether or not it passed.
///
/// [`PolicyViolation`] carries numbers only on failure, which is right for a
/// gate: a passing check has nothing to report. A caller that wants to PRINT
/// the margin — "3.2 MiB free against 1 MiB required" — needs them either way,
/// and recomputing them on the other side of an ABI boundary would be a second
/// implementation of the same arithmetic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicyOutcome {
    pub met: bool,
    pub free_bytes: u64,
    pub required_bytes: u64,
    pub free_inodes: u64,
    pub required_inodes: u64,
}

/// A failed publication check, carrying the numbers rather than a message.
///
/// The caller formats. A `no_std` policy module that owned its own prose would
/// force one wording on every host, and the wording a build script wants
/// ("lamp.vfs lacks runtime VFS headroom") is not the one a kernel wants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyViolation {
    /// The image ships with less free space than its profile requires.
    Headroom {
        free_bytes: u64,
        required_bytes: u64,
        free_inodes: u64,
        required_inodes: u64,
    },
    /// The image carries Wasm artifacts that fail the publication policy, or
    /// declares a policy for a path it does not contain. One violation lists
    /// every failing path: an image with four stale binaries should not need
    /// four builds to learn that.
    StaleWasmArtifacts { failures: Vec<String> },
    /// The image's encoded growth ceiling is not the one its product profile
    /// declares. Not a range check: an image built to grow LARGER than its
    /// profile is as wrong as one built smaller, because the profile is what
    /// the product was sized and tested against.
    Capacity { actual_bytes: u64, expected_bytes: u64 },
    /// The image states in its own metadata that it was built for a different
    /// kernel ABI than the one about to mount it.
    DeclaredAbi { declared: u32, expected: u32 },
}

impl PolicyViolation {
    /// Which limits were actually breached, so a caller can name them without
    /// re-deriving the comparison.
    pub fn breached(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        match self {
            PolicyViolation::Headroom {
                free_bytes,
                required_bytes,
                free_inodes,
                required_inodes,
            } => {
                if free_bytes < required_bytes {
                    out.push("free bytes");
                }
                if free_inodes < required_inodes {
                    out.push("free inodes");
                }
            }
            PolicyViolation::Capacity { .. } => out.push("growth ceiling"),
            PolicyViolation::StaleWasmArtifacts { .. } => out.push("wasm artifacts"),
            PolicyViolation::DeclaredAbi { .. } => out.push("declared kernel ABI"),
        }
        out
    }
}

/// Require a mounted image to still carry its declared runtime headroom.
///
/// Both limits are evaluated before returning, and both numbers ride in the
/// violation. The TypeScript original collects both failures and joins them,
/// and it is right to: telling a build "you are short on bytes", waiting for a
/// rebuild, then telling it "you are also short on inodes" wastes the slowest
/// loop in the project.
pub fn check_headroom<S: BlockSource>(
    fs: &KandeloImageFs<S>,
    headroom: &Headroom,
) -> Result<(), PolicyViolation> {
    let st = fs.statfs().map_err(|_| PolicyViolation::Headroom {
        // A statfs that cannot be read is not "zero free": it is an image whose
        // own superblock is unreadable, and reporting it as a headroom breach
        // is the truthful outcome for a publication gate. `KandeloImageFs::statfs`
        // already refuses a superblock claiming more free than total, so this
        // arm cannot be reached by a merely-full image.
        free_bytes: 0,
        required_bytes: headroom.minimum_free_bytes,
        free_inodes: 0,
        required_inodes: headroom.minimum_free_inodes,
    })?;

    let free_bytes = st.f_bfree.saturating_mul(st.f_frsize as u64);
    if free_bytes < headroom.minimum_free_bytes || st.f_ffree < headroom.minimum_free_inodes {
        return Err(PolicyViolation::Headroom {
            free_bytes,
            required_bytes: headroom.minimum_free_bytes,
            free_inodes: st.f_ffree,
            required_inodes: headroom.minimum_free_inodes,
        });
    }
    Ok(())
}

/// Require an image's encoded growth ceiling to be exactly the one its product
/// profile declares.
///
/// Equality, not a minimum. An image built to grow larger than its profile is
/// as wrong as one built smaller: the profile is the size the product was
/// tested against, and a quietly roomier image is a difference nobody reviewed.
pub fn check_capacity<S: BlockSource>(
    fs: &KandeloImageFs<S>,
    expected_bytes: u64,
) -> Result<(), PolicyViolation> {
    let actual_bytes = fs
        .growth_ceiling_bytes()
        .map_err(|_| PolicyViolation::Capacity { actual_bytes: 0, expected_bytes })?;
    if actual_bytes != expected_bytes {
        return Err(PolicyViolation::Capacity { actual_bytes, expected_bytes });
    }
    Ok(())
}

/// A per-path exception to the default artifact policy, mirroring the
/// `VfsWasmArtifactPolicy` declarations the builders already pass.
pub struct WasmArtifactDeclaration<'a> {
    pub path: &'a [u8],
    /// The artifact must be free of fork instrumentation rather than carry it.
    pub fork_instrumentation_disabled: bool,
}

/// The four bytes that open every WebAssembly module.
const WASM_MAGIC: [u8; 4] = [0x00, 0x61, 0x73, 0x6d];

/// Require every Wasm artifact in the image to match the kernel it ships with.
///
/// # Why an image-wide walk rather than a check at each write
///
/// An artifact can be written correctly and go stale afterwards -- the kernel
/// ABI moves, or a later step overwrites a file. The question this answers is
/// about the finished image, so it is asked of the finished image.
///
/// # Deferred files are skipped, and that is not a hole
///
/// A deferred entry deliberately has no bytes in the image; its identity is
/// validated at registration and materialization instead. Reading one here
/// would either fail or, worse, inspect a zero-length stub and pronounce it
/// fine. The TypeScript original skips them for the same reason.
///
/// Deferral is read from the in-body SDEF section, which is what `KandeloImageWriter`
/// produces. An image whose deferred files are recorded only in the trailing
/// KLZY JSON is a TypeScript-written image, and this path does not produce
/// one.
pub fn check_wasm_artifacts<S: BlockSource>(
    fs: &KandeloImageFs<S>,
    kernel_abi: u32,
    declarations: &[WasmArtifactDeclaration<'_>],
) -> Result<(), PolicyViolation> {
    let mut failures: Vec<String> = Vec::new();

    let deferred: Vec<u32> = match fs.deferred_section() {
        Ok(Some(section)) => section.records.iter().map(|r| r.ino).collect(),
        Ok(None) => Vec::new(),
        Err(_) => {
            failures.push(String::from(
                "image declares a deferred-file section that cannot be decoded",
            ));
            Vec::new()
        }
    };

    let mut unused: Vec<usize> = (0..declarations.len()).collect();
    // Explicit stack rather than recursion: image trees are deep and this runs
    // in the kernel's Wasm stack, where a recursive walk is a crash waiting for
    // a sufficiently nested image.
    let mut stack = alloc::vec![(ROOT_INO, Vec::<u8>::new())];
    while let Some((dir_ino, prefix)) = stack.pop() {
        let entries = match fs.read_dir(dir_ino) {
            Ok(entries) => entries,
            Err(_) => {
                failures.push(format!(
                    "{}: directory cannot be read while inspecting artifacts",
                    String::from_utf8_lossy(&prefix)
                ));
                continue;
            }
        };
        for entry in entries {
            if entry.name == b"." || entry.name == b".." {
                continue;
            }
            let mut path = prefix.clone();
            path.push(b'/');
            path.extend_from_slice(&entry.name);

            let st = match fs.stat_ino(entry.ino) {
                Ok(st) => st,
                Err(_) => {
                    failures.push(format!(
                        "{}: cannot stat while inspecting artifacts",
                        String::from_utf8_lossy(&path)
                    ));
                    continue;
                }
            };
            if file_type(st.mode) == 0x4000 {
                stack.push((entry.ino, path));
                continue;
            }
            if file_type(st.mode) != 0x8000 {
                continue;
            }

            let declared = declarations.iter().position(|d| d.path == path.as_slice());
            if let Some(index) = declared {
                unused.retain(|&i| i != index);
            }
            if deferred.contains(&entry.ino) {
                continue;
            }

            let mut bytes = Vec::new();
            if bytes.try_reserve(st.size as usize).is_err() {
                failures.push(format!(
                    "{}: artifact too large to inspect",
                    String::from_utf8_lossy(&path)
                ));
                continue;
            }
            bytes.resize(st.size as usize, 0u8);
            if fs.read_at(entry.ino, 0, &mut bytes).is_err() {
                failures.push(format!(
                    "{}: cannot read while inspecting artifacts",
                    String::from_utf8_lossy(&path)
                ));
                continue;
            }

            if bytes.len() < 4 || bytes[..4] != WASM_MAGIC {
                if declared.is_some() {
                    failures.push(format!(
                        "{}: declared Wasm artifact policy names a non-Wasm file",
                        String::from_utf8_lossy(&path)
                    ));
                }
                continue;
            }

            let disabled = declared
                .map(|i| declarations[i].fork_instrumentation_disabled)
                .unwrap_or(false);
            let policy = wasm_artifact::ArtifactPolicy {
                expected_abi: Some(kernel_abi),
                expected_abi_contract_digest: None,
                required_exports: &[],
                forbidden_exports: &[],
                require_fork_instrumentation: if disabled { Some(false) } else { None },
                forbid_fork_instrumentation: disabled,
            };
            let report = wasm_artifact::describe_artifact_policy_failures(&bytes, &policy);
            for failure in report.failures {
                failures.push(format!("{}: {failure}", String::from_utf8_lossy(&path)));
            }
        }
    }

    for index in unused {
        failures.push(format!(
            "{}: declared Wasm artifact policy did not match a materialized regular file",
            String::from_utf8_lossy(declarations[index].path)
        ));
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(PolicyViolation::StaleWasmArtifacts { failures })
    }
}

/// The kernel ABI an image DECLARES about itself, or `None` when it declares
/// none.
///
/// # Why this scans instead of parsing
///
/// `kandelo_image_fs::metadata_span` hands back the metadata section as opaque
/// bytes, and says why: the section is JSON with a deliberately OPEN shape, so
/// a reader that parsed it into a struct and re-serialized would silently drop
/// every field it did not know about. That argument is about a PARSER. It is
/// not an argument against reading one number.
///
/// The same comment's second reason — "teaching the kernel crate to parse JSON
/// to read three fields it does not act on would buy a parser's attack surface
/// for nothing" — turns on *does not act on*, and that is what changes here.
/// The kernel now acts on exactly one of those fields, so it reads exactly one
/// of them, with a bounded scan that allocates nothing, recurses nowhere, and
/// cannot consume more than the section it was handed.
///
/// # What it deliberately does NOT do
///
/// It does not validate that the section is well-formed JSON, and it does not
/// care what else the section contains. A malformed section simply declares no
/// ABI, and "declares no ABI" is already a state the caller must handle,
/// because images predating the field exist. Refusing to load an image because
/// its metadata had a stray comma would fail the machine for something no part
/// of the system reads.
///
/// It finds the FIRST `"kernelAbi"` key. A section carrying two would be a
/// malformed artifact, and choosing the first is the same rule every streaming
/// reader uses; it is not a judgement about which one is true.
pub fn declared_kernel_abi(metadata: &[u8]) -> Option<u32> {
    const KEY: &[u8] = b"\"kernelAbi\"";
    let mut at = 0usize;
    while at + KEY.len() <= metadata.len() {
        if &metadata[at..at + KEY.len()] != KEY {
            at += 1;
            continue;
        }
        let mut cursor = at + KEY.len();
        while matches!(metadata.get(cursor), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            cursor += 1;
        }
        if metadata.get(cursor) != Some(&b':') {
            at += 1;
            continue;
        }
        cursor += 1;
        while matches!(metadata.get(cursor), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            cursor += 1;
        }
        let start = cursor;
        let mut value: u32 = 0;
        while let Some(&byte) = metadata.get(cursor) {
            if !byte.is_ascii_digit() {
                break;
            }
            // A version that does not fit a u32 is not a version this kernel
            // could ever match, and saturating would turn it into one.
            value = value.checked_mul(10)?.checked_add(u32::from(byte - b'0'))?;
            cursor += 1;
        }
        if cursor == start {
            at += 1;
            continue;
        }
        return Some(value);
    }
    None
}

/// Refuse an image that states it was built for a different kernel ABI.
///
/// An image is a product artifact with a long life: it is built once, written
/// to `local-binaries/`, and survives every `ABI_VERSION` bump after it. So
/// "the image and the kernel disagree" is not a transport or a packaging
/// accident, it is the ordinary consequence of not rebuilding, and the ABI
/// contract says it must fail loudly rather than boot.
///
/// An image that declares NOTHING is accepted. That is not a hole: declaring
/// an ABI is what a builder does to make this check possible, and an image
/// predating the field makes no claim this could contradict. Refusing it would
/// be refusing the absence of evidence.
pub fn check_declared_abi(metadata: Option<&[u8]>, expected: u32) -> Result<(), PolicyViolation> {
    let Some(declared) = metadata.and_then(declared_kernel_abi) else {
        return Ok(());
    };
    if declared == expected {
        return Ok(());
    }
    Err(PolicyViolation::DeclaredAbi { declared, expected })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kandelo_image_fs::unwrap_vfsi;

    const TINY_VFS: &[u8] = include_bytes!("testdata/tiny.vfs");

    fn mount() -> KandeloImageFs<Vec<u8>> {
        KandeloImageFs::mount(unwrap_vfsi(TINY_VFS).expect("unwrap").to_vec()).expect("mount")
    }

    #[test]
    fn a_zero_requirement_always_passes() {
        let fs = mount();
        assert_eq!(
            check_headroom(
                &fs,
                &Headroom { minimum_free_bytes: 0, minimum_free_inodes: 0 }
            ),
            Ok(())
        );
    }

    #[test]
    fn the_fixtures_real_headroom_is_accepted() {
        let fs = mount();
        let st = fs.statfs().expect("statfs");
        let free_bytes = st.f_bfree * st.f_frsize as u64;
        // Ask for exactly what it has: the boundary must pass, not fail.
        assert_eq!(
            check_headroom(
                &fs,
                &Headroom {
                    minimum_free_bytes: free_bytes,
                    minimum_free_inodes: st.f_ffree,
                }
            ),
            Ok(()),
            "requiring exactly the free space present must pass",
        );
    }

    #[test]
    fn one_byte_beyond_the_free_space_is_refused() {
        let fs = mount();
        let st = fs.statfs().expect("statfs");
        let free_bytes = st.f_bfree * st.f_frsize as u64;
        let err = check_headroom(
            &fs,
            &Headroom { minimum_free_bytes: free_bytes + 1, minimum_free_inodes: 0 },
        )
        .expect_err("one byte too many must fail");
        assert_eq!(err.breached(), alloc::vec!["free bytes"]);
    }

    /// Both limits are reported together. A gate that surfaces one breach per
    /// rebuild costs a full image build to learn the second.
    #[test]
    fn both_breaches_are_reported_from_one_run() {
        let fs = mount();
        let st = fs.statfs().expect("statfs");
        let free_bytes = st.f_bfree * st.f_frsize as u64;
        let err = check_headroom(
            &fs,
            &Headroom {
                minimum_free_bytes: free_bytes + 1,
                minimum_free_inodes: st.f_ffree + 1,
            },
        )
        .expect_err("both limits breached");
        assert_eq!(err.breached(), alloc::vec!["free bytes", "free inodes"]);
    }

    #[test]
    fn the_encoded_growth_ceiling_is_accepted_when_it_matches() {
        let fs = mount();
        let ceiling = fs.growth_ceiling_bytes().expect("ceiling");
        assert_eq!(check_capacity(&fs, ceiling), Ok(()));
    }

    /// Both directions, because the check is equality and a range check would
    /// pass the roomier image silently.
    #[test]
    fn a_ceiling_that_differs_either_way_is_refused() {
        let fs = mount();
        let ceiling = fs.growth_ceiling_bytes().expect("ceiling");
        for wrong in [ceiling - 1, ceiling + 1] {
            let err = check_capacity(&fs, wrong).expect_err("mismatch must fail");
            assert_eq!(err.breached(), alloc::vec!["growth ceiling"]);
            assert_eq!(
                err,
                PolicyViolation::Capacity { actual_bytes: ceiling, expected_bytes: wrong },
                "the violation must carry both numbers so a caller can name them",
            );
        }
    }

    // The ceiling's own VALUE is pinned in `image.rs` against literals, not
    // here: a test in this module that derives its expectation from
    // `growth_ceiling_bytes` can only show the function equals itself, which
    // is exactly how two mutants of it survived the first time round.

    /// Build a small image containing the given (path, bytes) regular files.
    fn image_with(files: &[(&[u8], &[u8])]) -> KandeloImageFs<Vec<u8>> {
        use crate::kandelo_image_write::{Content, NoContent, KandeloImageConfig, KandeloImageWriter};
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig {
            size_bytes: 256 * 1024,
            max_size_bytes: None,
            growable_to_bytes: 256 * 1024,
            now_ms: 0,
        })
        .expect("mkfs");
        let root = w.root();
        for (name, bytes) in files {
            let leaf = &name[1..]; // these fixtures are all top-level
            w.create_file(root, leaf, 0o644, Content::Bytes(bytes)).expect("create");
        }
        let body = w.finish().expect("finish").to_vec(&NoContent).expect("to_vec");
        KandeloImageFs::mount(body).expect("mount")
    }

    fn failures_of(err: &PolicyViolation) -> &[String] {
        match err {
            PolicyViolation::StaleWasmArtifacts { failures } => failures,
            other => panic!("expected StaleWasmArtifacts, got {other:?}"),
        }
    }

    #[test]
    fn an_image_with_no_wasm_and_no_declarations_passes() {
        let fs = image_with(&[(b"/readme", b"not a module")]);
        assert_eq!(check_wasm_artifacts(&fs, 44, &[]), Ok(()));
    }

    /// A declaration naming a path the image does not contain is a failure,
    /// not a no-op. A policy that silently matches nothing is a policy the
    /// author believes is protecting them.
    #[test]
    fn a_declaration_matching_nothing_is_refused() {
        let fs = image_with(&[(b"/readme", b"not a module")]);
        let decls = [WasmArtifactDeclaration {
            path: b"/usr/bin/absent",
            fork_instrumentation_disabled: true,
        }];
        let err = check_wasm_artifacts(&fs, 44, &decls).expect_err("must fail");
        assert_eq!(err.breached(), alloc::vec!["wasm artifacts"]);
        assert_eq!(failures_of(&err).len(), 1);
        assert!(
            failures_of(&err)[0].contains("did not match a materialized regular file"),
            "got {:?}",
            failures_of(&err)[0]
        );
    }

    #[test]
    fn a_declaration_naming_a_non_wasm_file_is_refused() {
        let fs = image_with(&[(b"/readme", b"not a module")]);
        let decls = [WasmArtifactDeclaration {
            path: b"/readme",
            fork_instrumentation_disabled: false,
        }];
        let err = check_wasm_artifacts(&fs, 44, &decls).expect_err("must fail");
        assert!(
            failures_of(&err)[0].contains("names a non-Wasm file"),
            "got {:?}",
            failures_of(&err)[0]
        );
    }

    /// Something carrying the Wasm magic but no readable structure must be
    /// reported, not skipped. This is the stale-artifact case the check exists
    /// for: a file that looks like a module to a four-byte sniff.
    #[test]
    fn a_malformed_wasm_artifact_is_reported_against_its_path() {
        let fs = image_with(&[(b"/bin-prog.wasm", b"\0asm\x01\x00\x00\x00garbage")]);
        let err = check_wasm_artifacts(&fs, 44, &[]).expect_err("must fail");
        assert!(
            failures_of(&err)[0].starts_with("/bin-prog.wasm:"),
            "the failure must name the path it came from, got {:?}",
            failures_of(&err)[0]
        );
    }

    /// The walk descends. Every fixture above puts its files at the root, and
    /// mutation testing showed that a version of this check which never
    /// recursed passed all of them -- while inspecting nothing at all in a
    /// real image, where every binary lives under /usr/bin or /bin.
    ///
    /// So the artifact here is deliberately two levels down, and the assertion
    /// is on its full path.
    #[test]
    fn a_stale_artifact_in_a_subdirectory_is_found() {
        use crate::kandelo_image_write::{Content, NoContent, KandeloImageConfig, KandeloImageWriter};
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig {
            size_bytes: 256 * 1024,
            max_size_bytes: None,
            growable_to_bytes: 256 * 1024,
            now_ms: 0,
        })
        .expect("mkfs");
        let root = w.root();
        let usr = w.mkdir(root, b"usr", 0o755).expect("mkdir /usr");
        let bin = w.mkdir(usr, b"bin", 0o755).expect("mkdir /usr/bin");
        w.create_file(bin, b"prog.wasm", 0o755, Content::Bytes(b"\0asm\x01\x00\x00\x00garbage"))
            .expect("create");
        let body = w.finish().expect("finish").to_vec(&NoContent).expect("to_vec");
        let fs = KandeloImageFs::mount(body).expect("mount");

        let err = check_wasm_artifacts(&fs, 44, &[]).expect_err("a stale nested artifact must fail");
        assert!(
            failures_of(&err)[0].starts_with("/usr/bin/prog.wasm:"),
            "the walk must reach nested paths and name them in full, got {:?}",
            failures_of(&err)[0]
        );
    }

    /// Every failing path is reported from ONE run. An image with several
    /// stale binaries should not cost several image builds to diagnose.
    #[test]
    fn every_failure_is_collected_from_one_run() {
        let fs = image_with(&[
            (b"/a.wasm", b"\0asm\x01\x00\x00\x00garbage"),
            (b"/b.wasm", b"\0asm\x01\x00\x00\x00garbage"),
        ]);
        let decls = [WasmArtifactDeclaration {
            path: b"/absent",
            fork_instrumentation_disabled: false,
        }];
        let err = check_wasm_artifacts(&fs, 44, &decls).expect_err("must fail");
        assert_eq!(
            failures_of(&err).len(),
            3,
            "two bad artifacts plus one unmatched declaration, got {:?}",
            failures_of(&err)
        );
    }

    #[test]
    fn an_inode_breach_alone_is_refused() {
        let fs = mount();
        let st = fs.statfs().expect("statfs");
        let err = check_headroom(
            &fs,
            &Headroom { minimum_free_bytes: 0, minimum_free_inodes: st.f_ffree + 1 },
        )
        .expect_err("inode shortfall must fail");
        assert_eq!(err.breached(), alloc::vec!["free inodes"]);
    }
    #[test]
    fn reads_the_abi_an_image_declares() {
        assert_eq!(
            declared_kernel_abi(br#"{"version":1,"kernelAbi":44,"createdBy":"a test"}"#),
            Some(44)
        );
    }

    #[test]
    fn tolerates_the_whitespace_a_pretty_printer_leaves() {
        assert_eq!(
            declared_kernel_abi(b"{\n  \"kernelAbi\" :  44 ,\n  \"version\": 1\n}"),
            Some(44)
        );
    }

    #[test]
    fn an_image_that_declares_nothing_declares_nothing() {
        assert_eq!(declared_kernel_abi(br#"{"version":1}"#), None);
        assert_eq!(declared_kernel_abi(b""), None);
        // The key present with a non-numeric value is the same answer: this
        // reads a number or it reads nothing, and it never guesses one.
        assert_eq!(declared_kernel_abi(br#"{"kernelAbi":"44"}"#), None);
        assert_eq!(declared_kernel_abi(br#"{"kernelAbi":null}"#), None);
    }

    #[test]
    fn a_similarly_named_key_is_not_this_key() {
        // Scanning for a substring would match `notKernelAbi` and
        // `kernelAbiExpected`; the quotes are what make the key a key.
        assert_eq!(declared_kernel_abi(br#"{"notkernelAbi":9}"#), None);
        assert_eq!(declared_kernel_abi(br#"{"kernelAbiExpected":9}"#), None);
    }

    #[test]
    fn a_version_too_large_for_a_u32_is_not_silently_clamped() {
        // Saturating would turn an impossible declaration into u32::MAX, which
        // is a number a kernel could in principle equal.
        assert_eq!(declared_kernel_abi(br#"{"kernelAbi":99999999999}"#), None);
    }

    #[test]
    fn an_agreeing_declaration_passes_and_a_disagreeing_one_does_not() {
        assert_eq!(check_declared_abi(Some(br#"{"kernelAbi":44}"#), 44), Ok(()));
        assert_eq!(
            check_declared_abi(Some(br#"{"kernelAbi":43}"#), 44),
            Err(PolicyViolation::DeclaredAbi { declared: 43, expected: 44 })
        );
    }

    #[test]
    fn absence_of_a_declaration_is_not_a_violation() {
        // An image predating the field makes no claim this can contradict.
        assert_eq!(check_declared_abi(None, 44), Ok(()));
        assert_eq!(check_declared_abi(Some(br#"{"version":1}"#), 44), Ok(()));
    }

    #[test]
    fn the_violation_names_the_limit_it_breached() {
        let err = check_declared_abi(Some(br#"{"kernelAbi":1}"#), 44).expect_err("mismatch");
        assert_eq!(err.breached(), alloc::vec!["declared kernel ABI"]);
    }
}
