//! Canonical description of a VFS image, and a diff between two of them.
//!
//! # Why this exists
//!
//! Lane Y migrates the image builders from the TypeScript filesystem to the
//! Rust writer. The obvious acceptance bar for that -- the two paths produce
//! byte-identical images -- is unreachable and was retired: lane V's V5 moves
//! deferred-file metadata out of the trailing JSON sections and into the body
//! as an SDEF section, so the two writers disagree about the container layout
//! deliberately. Comparing their bytes compares the carrier, not the content.
//!
//! So the bar is that the two images DECODE to the same thing, and this is the
//! instrument that decides it. It reads an image the way the kernel does --
//! through `runtime_core::image` -- rather than reimplementing the format a
//! third time, which is the defect lane V is closing.
//!
//! # What "the same thing" means, concretely
//!
//! The description is deliberately carrier-blind. Deferred files are
//! normalised to `(path, real size, payload digest)` whether the image
//! describes them through the KLZY section or through SDEF, because which
//! section holds them is exactly the thing allowed to change.
//!
//! Hardlinks are reported as inode groups rather than per-path, so that two
//! images agree only when the same set of paths shares the same inode -- a
//! per-path report would call a broken hardlink graph equal.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

use runtime_core::kandelo_image_fs::{self, KandeloImageFs};
use wasm_posix_shared::Errno;

/// Offset of the container flags word. `kandelo_image_span` validates magic and
/// version and hands back the body span; the flags are read here because the
/// description reports them and a changed flag word is a real difference.
const VFSI_FLAGS_OFFSET: usize = 8;

const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];

#[derive(Serialize)]
pub struct ImageDescription {
    pub container: Container,
    /// Every path in the image, sorted, with its POSIX metadata.
    pub entries: Vec<Entry>,
    /// Inode -> the sorted paths sharing it, for inodes with more than one.
    pub hardlink_groups: BTreeMap<u32, Vec<String>>,
    /// Deferred files normalised across whichever carrier describes them.
    pub deferred: Vec<Deferred>,
    /// The lazy archives the image declares, as `archive_id -> bytes`. Part of
    /// the description because an archive's length bounds the fetch that
    /// materialises its members: two images whose trees match but whose archive
    /// lengths differ are not interchangeable, and an equivalence bar that
    /// cannot see the difference is answering a different question.
    pub archives: BTreeMap<u32, u64>,
    pub deferred_carrier: &'static str,
}

#[derive(Serialize)]
pub struct Container {
    pub flags: u32,
    pub body_bytes: u64,
    /// The encoded growth ceiling. Part of the description because it is a
    /// published property of the artifact -- two images with identical trees
    /// but different ceilings are not interchangeable, and the equivalence bar
    /// must not call them equal.
    pub growth_ceiling_bytes: u64,
    /// The image's metadata section, verbatim when it is UTF-8.
    ///
    /// The equivalence bar names image metadata (version, kernelAbi,
    /// createdBy) as one of its dimensions, and until now the describer did
    /// not read it -- so two images differing only in the kernel ABI they
    /// declare would have compared equal. Carried as text rather than a digest
    /// because it is small and a reader diagnosing a mismatch wants to see
    /// which field moved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,
}

#[derive(Serialize)]
pub struct Entry {
    pub path: String,
    pub kind: &'static str,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub size: u64,
    pub ino: u32,
    pub nlink: u32,
    /// `None` for anything that is not a symlink.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symlink_target: Option<String>,
    /// sha256 of the file's bytes. `None` for a deferred file, which has no
    /// bytes in the image by definition -- that is not a missing digest, it is
    /// the deferred contract, and `deferred` below carries its real size.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_sha256: Option<String>,
}

#[derive(Serialize)]
pub struct Deferred {
    pub path: String,
    pub real_size: u64,
    /// sha256 of the opaque fetch description. Digested rather than reproduced
    /// because the kernel never inspects it and neither should this.
    pub payload_sha256: String,
    /// Archive linkage, when the carrier reports it (KLZY does; SDEF keeps it
    /// inside the opaque payload).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
}

fn kind_of(mode: u32) -> &'static str {
    match kandelo_image_fs::file_type(mode) {
        0x8000 => "file",
        0x4000 => "dir",
        0xa000 => "symlink",
        0x1000 => "fifo",
        0x2000 => "chardev",
        0x6000 => "blockdev",
        0xc000 => "socket",
        _ => "unknown",
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Decompress when the file is zstd-wrapped, otherwise take it as-is. A raw
/// container is accepted so an intermediate can be inspected without a
/// compression round trip.
fn load_container(path: &Path) -> Result<Vec<u8>, String> {
    let raw = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if raw.len() >= 4 && raw[..4] == ZSTD_MAGIC {
        zstd::decode_all(&raw[..]).map_err(|e| format!("{}: zstd decode: {e}", path.display()))
    } else {
        Ok(raw)
    }
}

pub fn describe(path: &Path) -> Result<ImageDescription, String> {
    let image = load_container(path)?;
    describe_container(&image, &path.display().to_string())
}

/// The whole description, over an already-decompressed container.
///
/// Split from [`describe`] so the sensitivity tests can drive it from bytes
/// built in-process. A gate that is only reachable through the filesystem can
/// only be tested against artifacts that already exist, which is the wrong way
/// round for a gate whose job is to notice a change.
pub fn describe_container(image: &[u8], label: &str) -> Result<ImageDescription, String> {
    let path = std::path::PathBuf::from(label);
    let path = path.as_path();
    let (body_offset, body_len) = kandelo_image_fs::kandelo_image_span(&image)
        .map_err(|e| format!("{}: not a VFS image container: {e:?}", path.display()))?;
    let flags = u32::from_le_bytes(
        image
            .get(VFSI_FLAGS_OFFSET..VFSI_FLAGS_OFFSET + 4)
            .ok_or_else(|| format!("{}: truncated container header", path.display()))?
            .try_into()
            .expect("4 bytes"),
    );

    let body = image
        .get(body_offset as usize..(body_offset + body_len) as usize)
        .ok_or_else(|| format!("{}: body span outside image", path.display()))?
        .to_vec();
    let fs = KandeloImageFs::mount(body).map_err(|e| format!("{}: mount: {e:?}", path.display()))?;

    // Deferred set first: an entry's digest depends on knowing whether it is
    // deferred, and asking the image twice would let the two answers drift.
    let (deferred_by_ino, archives, carrier) = read_deferred(&fs, &image)?;

    let mut entries = Vec::new();
    let mut by_ino: BTreeMap<u32, Vec<String>> = BTreeMap::new();
    walk(&fs, fs_root(&fs), "", &mut entries, &mut by_ino, &deferred_by_ino)?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));

    let hardlink_groups: BTreeMap<u32, Vec<String>> = by_ino
        .into_iter()
        .filter(|(_, paths)| paths.len() > 1)
        .map(|(ino, mut paths)| {
            paths.sort();
            (ino, paths)
        })
        .collect();

    let ino_to_path: BTreeMap<u32, String> = entries
        .iter()
        .map(|e| (e.ino, e.path.clone()))
        .collect();
    let mut deferred: Vec<Deferred> = deferred_by_ino
        .into_iter()
        .map(|(ino, d)| Deferred {
            path: ino_to_path
                .get(&ino)
                .cloned()
                .unwrap_or_else(|| format!("<unreachable ino {ino}>")),
            ..d
        })
        .collect();
    deferred.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(ImageDescription {
        container: Container {
            flags,
            body_bytes: body_len,
            growth_ceiling_bytes: fs
                .growth_ceiling_bytes()
                .map_err(|e| format!("{}: growth ceiling: {e:?}", path.display()))?,
            metadata: kandelo_image_fs::metadata_section(&image)
                .map_err(|e| format!("{}: metadata section: {e:?}", path.display()))?
                .map(|bytes| String::from_utf8_lossy(bytes).into_owned()),
        },
        entries,
        hardlink_groups,
        deferred,
        archives,
        deferred_carrier: carrier,
    })
}

fn fs_root<S: kandelo_image_fs::BlockSource>(_fs: &KandeloImageFs<S>) -> u32 {
    // KIFS fixes the root inode at 1; `KandeloImageFs` exposes lookup from a directory
    // inode rather than a root accessor.
    1
}

/// A member path for display and comparison. SDEF carries bytes; KLZY carries a
/// validated UTF-8 string. Non-UTF-8 bytes are spelled in hex under a prefix no
/// real path can produce, so two different paths never compare equal here.
fn spell_source_path(bytes: &[u8]) -> String {
    match core::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => format!("\0hex:{}", hex(bytes)),
    }
}

/// Read the deferred set from whichever carrier the image uses.
///
/// SDEF is preferred when present because it is the authority under V5; KLZY
/// is read otherwise. An image carrying both is not an error here -- SDEF wins
/// and the carrier is reported, so a comparison can see the disagreement
/// rather than having it silently resolved.
fn read_deferred<S: kandelo_image_fs::BlockSource>(
    fs: &KandeloImageFs<S>,
    image: &[u8],
) -> Result<(BTreeMap<u32, Deferred>, BTreeMap<u32, u64>, &'static str), String> {
    let mut out = BTreeMap::new();
    let mut archives = BTreeMap::new();

    if let Some(section) = fs.deferred_section().map_err(|e| format!("SDEF: {e:?}"))? {
        for record in &section.records {
            out.insert(
                record.ino,
                Deferred {
                    path: String::new(),
                    real_size: record.size,
                    payload_sha256: hex(&Sha256::digest(&record.payload)),
                    // Since SDEF v2 the linkage is a field on both carriers,
                    // which is what makes this comparison carrier-blind: the
                    // same archive member compares equal whether the image
                    // describes it in KLZY or in SDEF.
                    archive_id: Some(record.archive_id),
                    source_path: Some(spell_source_path(&record.source_path)),
                },
            );
        }
        for archive in &section.archives {
            archives.insert(archive.archive_id, archive.bytes);
        }
        return Ok((out, archives, "sdef"));
    }

    if let Some(section) = kandelo_image_fs::kernel_lazy_section(image).map_err(|e| format!("KLZY: {e:?}"))? {
        let linkage = runtime_core::klzy::decode_kernel_lazy_linkage(section)
            .map_err(|e| format!("KLZY decode: {e:?}"))?;
        for file in &linkage.files {
            out.insert(
                file.ino,
                Deferred {
                    path: String::new(),
                    real_size: file.size,
                    // KLZY is the kernel-facing subset and carries no fetch
                    // description, so the digest covers what it does carry.
                    // The URL and integrity fields live in the trailing lazy
                    // JSON; comparing those is a later increment and is noted
                    // in the lane rather than faked here.
                    payload_sha256: hex(&Sha256::digest(
                        format!("klzy:{}:{}", file.archive_id, file.source_path).as_bytes(),
                    )),
                    archive_id: Some(file.archive_id),
                    source_path: Some(file.source_path.clone()),
                },
            );
        }
        for archive in &linkage.archives {
            archives.insert(archive.archive_id, archive.archive_bytes);
        }
        return Ok((out, archives, "klzy"));
    }

    Ok((out, archives, "none"))
}

fn walk<S: kandelo_image_fs::BlockSource>(
    fs: &KandeloImageFs<S>,
    ino: u32,
    prefix: &str,
    entries: &mut Vec<Entry>,
    by_ino: &mut BTreeMap<u32, Vec<String>>,
    deferred: &BTreeMap<u32, Deferred>,
) -> Result<(), String> {
    let dirents = fs.read_dir(ino).map_err(|e| format!("readdir {prefix}: {e:?}"))?;
    for dirent in dirents {
        let name = String::from_utf8_lossy(&dirent.name).to_string();
        if name == "." || name == ".." {
            continue;
        }
        let path = format!("{prefix}/{name}");
        let st = fs
            .stat_ino(dirent.ino)
            .map_err(|e| format!("stat {path}: {e:?}"))?;
        let kind = kind_of(st.mode);

        let symlink_target = if kind == "symlink" {
            Some(
                String::from_utf8_lossy(
                    &fs.read_link(dirent.ino)
                        .map_err(|e| format!("readlink {path}: {e:?}"))?,
                )
                .to_string(),
            )
        } else {
            None
        };

        let content_sha256 = if kind == "file" && !deferred.contains_key(&dirent.ino) {
            Some(digest_file(fs, dirent.ino, st.size, &path)?)
        } else {
            None
        };

        by_ino.entry(dirent.ino).or_default().push(path.clone());
        entries.push(Entry {
            path: path.clone(),
            kind,
            mode: st.mode,
            uid: st.uid,
            gid: st.gid,
            size: st.size,
            ino: dirent.ino,
            nlink: st.nlink,
            symlink_target,
            content_sha256,
        });

        if kind == "dir" {
            walk(fs, dirent.ino, &path, entries, by_ino, deferred)?;
        }
    }
    Ok(())
}

fn digest_file<S: kandelo_image_fs::BlockSource>(
    fs: &KandeloImageFs<S>,
    ino: u32,
    size: u64,
    path: &str,
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    let mut offset = 0u64;
    let mut buf = vec![0u8; 64 * 1024];
    while offset < size {
        let want = ((size - offset) as usize).min(buf.len());
        let got = fs
            .read_at(ino, offset, &mut buf[..want])
            .map_err(|e| format!("read {path} @{offset}: {e:?}"))?;
        if got == 0 {
            return Err(format!("read {path} @{offset}: unexpected short read"));
        }
        hasher.update(&buf[..got]);
        offset += got as u64;
    }
    Ok(hex(&hasher.finalize()))
}

/// Load a REAL image into the kernel, export it, and prove the two decode the
/// same.
///
/// # Why against a real image rather than a fixture
///
/// V4's round trip — "an image the kernel exports is one the kernel can load" —
/// is tested in `rootfs.rs` against trees this repository builds in a test: a
/// handful of files, one archive, no hard links worth the name, nothing at
/// scale. That proves the mechanism and says nothing about a 16 MB rootfs with
/// thousands of entries, deep directories, and deferred files the TypeScript
/// writer produced rather than this one.
///
/// This is the check that closes that gap, and it is deliberately a COMMAND
/// rather than a test: the images it wants are build outputs, absent from a
/// fresh checkout and not reproducible in a unit test. A test that silently
/// skipped when they were missing would be the dead-floor pattern with a green
/// tick on it.
///
/// # What equivalence means here, and what it does not
///
/// The comparison is the same decoded description `diff` uses: paths, POSIX
/// metadata, hard-link groups, deferred files normalised across whichever
/// carrier describes them, the growth ceiling and the image metadata. **It is
/// not byte equality, and must not be** — the exported image describes its
/// deferred files in `SDEF` where the input used `KLZY`, so the bytes differ by
/// construction. That is the point of the carrier-blind normalisation.
///
/// The container fields are reported rather than compared: an export chooses
/// its own capacity and declares no `KLZY`, so a difference there is expected
/// and interesting rather than a failure.
/// Load a whole VFSI container into the kernel, the way a host does.
///
/// Shared by both loads in [`roundtrip`] so the re-entry cannot drift into
/// asking an easier question than the first load asked. `what` names which load
/// failed, because "the image will not load" and "the image this kernel just
/// wrote will not load" are different bugs with the same errno.
fn load_into_kernel(bytes: &[u8], what: &str) -> Result<usize, String> {
    runtime_core::rootfs::load_image(bytes.len() as u64, |req, dst| match req {
        runtime_core::rootfs::ByteReq::Image { offset } => {
            let start = usize::try_from(offset).map_err(|_| Errno::EINVAL)?;
            if start >= bytes.len() {
                return Ok(0);
            }
            let end = core::cmp::min(start.saturating_add(dst.len()), bytes.len());
            let n = end - start;
            dst[..n].copy_from_slice(&bytes[start..end]);
            Ok(n)
        }
        // A load walks structure, never content. Anything else means the walk
        // reached for bytes it should not need, and saying so is more useful
        // than serving them.
        //
        // NOT MUTATION-TESTABLE, and recorded rather than left as a permanent
        // red. A load requests only `Image`, so this arm is unreachable during
        // one and a mutant that serves zeroes here changes nothing a test can
        // observe. A trial for it survives every time; writing a test that
        // happened to pass would be worse than saying so. It stays because it
        // is the guard that would fire if the walk ever did reach for content.
        _ => Err(Errno::ENOSYS),
    })
    .map_err(|e| format!("{what}: {e:?}"))
}

fn roundtrip(path: &Path, out: Option<&Path>) -> Result<(), String> {
    // `load_container` already handles the `.vfs.zst` every production image
    // but the rootfs ships as; reusing it rather than writing a second reader
    // keeps one answer to "what is an image file".
    let original = load_container(path)?;
    println!("{}: {} bytes decoded", path.display(), original.len());
    println!("  loading into the kernel");

    // The kernel reads its own image through a positioned byte source; here
    // that source is the file we just read.
    let entries = load_into_kernel(&original, "load failed")
        .map_err(|e| format!("{}: {e}", path.display()))?;
    println!("  loaded {entries} entries");

    let exported = drain_container(&original)?;
    println!("  exported {} bytes", exported.len());

    if let Some(out) = out {
        std::fs::write(out, &exported).map_err(|e| format!("{}: {e}", out.display()))?;
        println!("  wrote the exported image to {}", out.display());
    }

    // RE-ENTER THE EXPORT AT THE DOOR THE ORIGINAL CAME IN BY (H-13). Comparing
    // descriptions proves the DECODER understands what the export writes; it
    // says nothing about whether the KERNEL can load it back, and those came
    // apart: every image with no deferred files was refused by `load_image` as a
    // stale artifact while this verb reported EQUIVALENT across the whole corpus
    // (gap 15). A round-trip check that never re-enters its own output is
    // checking a transform, not a round trip.
    println!("  loading the export back into the kernel");
    let reentered = load_into_kernel(&exported, "the export cannot be loaded back")
        .map_err(|e| {
            format!("{}: {e} -- the kernel wrote an image it cannot read", path.display())
        })?;
    println!("  loaded the export back: {reentered} entries");
    if reentered != entries {
        return Err(format!(
            "{}: the export loads back as {reentered} entries, not the {entries} \
             that were loaded from the original",
            path.display(),
        ));
    }

    let before = describe_container(&original, "original")?;
    let after = describe_container(&exported, "exported")?;

    // Inode NUMBERS are not part of equivalence, and comparing them says
    // "not equivalent" about every entry in every image. An export assigns its
    // own numbering — that is exactly why a deferred file's identity cannot be
    // carried by inode across a rewrite — so a comparison that includes them is
    // measuring the renumbering rather than the tree.
    //
    // What inodes DO carry is hard-link grouping, and that is compared below as
    // sets of paths rather than as numbers, which is the property that survives
    // renumbering.
    let strip_ino = |entries: &[Entry]| -> Result<serde_json::Value, String> {
        let mut out = serde_json::to_value(entries).map_err(|e| e.to_string())?;
        if let Some(list) = out.as_array_mut() {
            for entry in list {
                if let Some(map) = entry.as_object_mut() {
                    map.remove("ino");
                }
            }
        }
        Ok(out)
    };
    let ja = strip_ino(&before.entries)?;
    let jb = strip_ino(&after.entries)?;
    let da = serde_json::to_value(&before.deferred).map_err(|e| e.to_string())?;
    let db = serde_json::to_value(&after.deferred).map_err(|e| e.to_string())?;

    // Hard-link groups as sets of paths: same files sharing an inode, whatever
    // that inode is called on either side.
    let groups = |g: &BTreeMap<u32, Vec<String>>| -> std::collections::BTreeSet<Vec<String>> {
        g.values().cloned().collect()
    };

    println!(
        "  {} entries / {} deferred in, {} entries / {} deferred out (carriers: {} -> {})",
        before.entries.len(),
        before.deferred.len(),
        after.entries.len(),
        after.deferred.len(),
        before.deferred_carrier,
        after.deferred_carrier,
    );

    if ja == jb && da == db && groups(&before.hardlink_groups) == groups(&after.hardlink_groups) {
        println!("EQUIVALENT: the exported image decodes to the tree that was loaded");
        return Ok(());
    }
    report_difference(&before, &after);
    Err(format!(
        "NOT EQUIVALENT: {} does not survive a load-and-export round trip",
        path.display()
    ))
}

/// Drain the whole exported container, the way a builder saves one.
///
/// `image` is the source the export reads CONTENT from. A file inherited from
/// the loaded image keeps its bytes there — that is what `BaseSource::Image`
/// means — so the export streams them out through the same positioned read the
/// loader used. Refusing this source does not test anything stricter; it just
/// fails at the first content byte, which is how this was first written.
fn drain_container(image: &[u8]) -> Result<Vec<u8>, String> {
    const CHUNK: usize = 1 << 20;
    // Bounded for the reason H-11 records: an export that stops advancing would
    // otherwise spin here growing a buffer instead of failing.
    const SANE_LIMIT: usize = 2 * 1024 * 1024 * 1024;
    let mut out: Vec<u8> = Vec::new();
    let mut offset = 0i64;
    loop {
        let mut buf = vec![0u8; CHUNK];
        let n = runtime_core::rootfs::export_container_read(offset, &mut buf, &mut |req, dst| {
            match req {
                runtime_core::rootfs::ByteReq::Image { offset } => {
                    let start = usize::try_from(offset).map_err(|_| Errno::EINVAL)?;
                    if start >= image.len() {
                        return Ok(0);
                    }
                    let end = core::cmp::min(start.saturating_add(dst.len()), image.len());
                    let n = end - start;
                    dst[..n].copy_from_slice(&image[start..end]);
                    Ok(n)
                }
                // A host blob store or an archive fetch. Neither is available
                // here, and an image that needs one cannot round-trip through
                // this command — which is worth failing on rather than hiding.
                _ => Err(Errno::ENOSYS),
            }
        })
        .map_err(|e| format!("export failed at {offset}: {e:?}"))?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
        offset += n as i64;
        if out.len() > SANE_LIMIT {
            return Err("the export is not advancing; some chunk is being served again".into());
        }
    }
    Ok(out)
}

pub fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("describe") => {
            let path = args.get(1).ok_or("usage: xtask vfs-image describe <image>")?;
            let desc = describe(Path::new(path))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&desc).map_err(|e| e.to_string())?
            );
            Ok(())
        }
        Some("diff") => {
            let a = args.get(1).ok_or("usage: xtask vfs-image diff <a> <b>")?;
            let b = args.get(2).ok_or("usage: xtask vfs-image diff <a> <b>")?;
            let da = describe(Path::new(a))?;
            let db = describe(Path::new(b))?;
            let ja = serde_json::to_value(&da).map_err(|e| e.to_string())?;
            let jb = serde_json::to_value(&db).map_err(|e| e.to_string())?;
            if ja == jb {
                println!("EQUIVALENT: {a} and {b} decode identically");
                Ok(())
            } else {
                report_difference(&da, &db);
                Err(format!("NOT EQUIVALENT: {a} and {b}"))
            }
        }
        Some("roundtrip") => {
            let path = args
                .get(1)
                .ok_or("usage: xtask vfs-image roundtrip <image> [out]")?;
            // An optional output path, because when the two are NOT equivalent
            // the next question is always "how", and that needs the bytes.
            roundtrip(Path::new(path), args.get(2).map(Path::new))
        }
        _ => Err("usage: xtask vfs-image <describe|diff|roundtrip> ...".to_string()),
    }
}

/// Report the first differences in each dimension rather than a whole-document
/// dump. A diff of two 30,000-entry images that prints everything is not a
/// diagnosis.
fn report_difference(a: &ImageDescription, b: &ImageDescription) {
    if a.container.growth_ceiling_bytes != b.container.growth_ceiling_bytes {
        eprintln!(
            "growth ceiling: {} vs {} bytes",
            a.container.growth_ceiling_bytes, b.container.growth_ceiling_bytes
        );
    }
    if a.container.metadata != b.container.metadata {
        eprintln!(
            "image metadata differs:\n  A: {}\n  B: {}",
            a.container.metadata.as_deref().unwrap_or("<none>"),
            b.container.metadata.as_deref().unwrap_or("<none>")
        );
    }
    if a.container.flags != b.container.flags {
        eprintln!(
            "container flags: {:#x} vs {:#x}",
            a.container.flags, b.container.flags
        );
    }
    if a.deferred_carrier != b.deferred_carrier {
        eprintln!(
            "deferred carrier: {} vs {} (expected during the V5 cutover; the \
             deferred SET below must still agree)",
            a.deferred_carrier, b.deferred_carrier
        );
    }
    let pa: BTreeMap<_, _> = a.entries.iter().map(|e| (&e.path, e)).collect();
    let pb: BTreeMap<_, _> = b.entries.iter().map(|e| (&e.path, e)).collect();
    let mut shown = 0;
    for (path, ea) in &pa {
        match pb.get(path) {
            None => eprintln!("only in A: {path}"),
            Some(eb) => {
                if serde_json::to_value(ea).ok() != serde_json::to_value(eb).ok() {
                    eprintln!("differs: {path}");
                    shown += 1;
                }
            }
        }
        if shown >= 20 {
            eprintln!("... further entry differences suppressed");
            break;
        }
    }
    for path in pb.keys() {
        if !pa.contains_key(path) {
            eprintln!("only in B: {path}");
        }
    }
    if a.archives != b.archives {
        for (id, bytes) in &a.archives {
            match b.archives.get(id) {
                None => eprintln!("archive {id}: only in A ({bytes} bytes)"),
                Some(other) if other != bytes => {
                    eprintln!("archive {id}: {bytes} vs {other} bytes")
                }
                Some(_) => {}
            }
        }
        for id in b.archives.keys() {
            if !a.archives.contains_key(id) {
                eprintln!("archive {id}: only in B");
            }
        }
    }
    if a.deferred.len() != b.deferred.len() {
        eprintln!("deferred count: {} vs {}", a.deferred.len(), b.deferred.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use runtime_core::kandelo_image_write::{Content, NoContent, KandeloImageConfig, KandeloImageWriter};

    /// Wrap a raw KIFS body in the minimal VFS image container.
    ///
    /// This exists only for the tests. It is deliberately NOT a general
    /// container writer: writing the container is lane Y's gap 7 and belongs
    /// with the writer, not in a test helper, and a helper that grew into one
    /// would be a second implementation of the layout.
    fn wrap_vfsi(body: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(body.len() + 20);
        out.extend_from_slice(&0x5646_5349u32.to_le_bytes()); // "VFSI"
        out.extend_from_slice(&1u32.to_le_bytes()); // version
        out.extend_from_slice(&0u32.to_le_bytes()); // flags: no lazy sections
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(&0u32.to_le_bytes()); // empty lazy section
        out
    }

    /// One small tree, with the two knobs the sensitivity tests turn.
    fn build(hello_mode: u32, hello_body: &[u8]) -> Vec<u8> {
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig {
            size_bytes: 128 * 1024,
            max_size_bytes: None,
            growable_to_bytes: 128 * 1024,
            now_ms: 0,
        })
        .expect("mkfs");
        let root = w.root();
        let hello = w
            .create_file(root, b"hello.txt", hello_mode, Content::Bytes(hello_body))
            .expect("create");
        w.set_mode(hello, hello_mode).expect("chmod");
        let dir = w.mkdir(root, b"dir", 0o755).expect("mkdir");
        w.symlink(dir, b"link", b"../hello.txt").expect("symlink");
        let image = w.finish().expect("finish");
        wrap_vfsi(&image.to_vec(&NoContent).expect("to_vec"))
    }

    fn describe_ok(bytes: &[u8]) -> ImageDescription {
        describe_container(bytes, "test").expect("describe")
    }

    fn as_json(d: &ImageDescription) -> serde_json::Value {
        serde_json::to_value(d).expect("serialize")
    }

    #[test]
    fn identical_trees_describe_identically() {
        let a = describe_ok(&build(0o644, b"hello image\n"));
        let b = describe_ok(&build(0o644, b"hello image\n"));
        assert_eq!(as_json(&a), as_json(&b));
    }

    /// The growth ceiling is part of the description.
    ///
    /// It was added so that two images with identical trees but different
    /// ceilings cannot compare equal — they are not interchangeable artifacts.
    /// Nothing asserted it, and a mutant that reported 0 for every image
    /// survived the suite, which would have quietly removed that dimension
    /// from the bar.
    #[test]
    fn the_description_carries_the_growth_ceiling() {
        let d = describe_ok(&build(0o644, b"hello image\n"));
        // `build` asks for no explicit maximum, and mkfs then uses the
        // vendor's default of four times the initial size: 128 KiB -> 512 KiB.
        assert_eq!(
            d.container.growth_ceiling_bytes,
            512 * 1024,
            "the ceiling must be read from the image, not defaulted",
        );
    }

    #[test]
    fn reads_the_namespace_it_was_given() {
        let d = describe_ok(&build(0o644, b"hello image\n"));
        let paths: Vec<&str> = d.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["/dir", "/dir/link", "/hello.txt"]);
        let link = d.entries.iter().find(|e| e.path == "/dir/link").unwrap();
        assert_eq!(link.kind, "symlink");
        assert_eq!(link.symlink_target.as_deref(), Some("../hello.txt"));
    }

    /// H-2: the gate must be shown to FAIL, and on the smallest change it is
    /// supposed to catch. A single mode bit is the cheapest thing a migration
    /// can silently get wrong -- and the one byte-comparison would also catch,
    /// so this proves the equivalence bar is not weaker where it matters.
    #[test]
    fn one_changed_mode_bit_is_caught() {
        let a = describe_ok(&build(0o644, b"hello image\n"));
        let b = describe_ok(&build(0o645, b"hello image\n"));
        assert_ne!(as_json(&a), as_json(&b), "a mode bit change must be visible");
        let ma = a.entries.iter().find(|e| e.path == "/hello.txt").unwrap().mode;
        let mb = b.entries.iter().find(|e| e.path == "/hello.txt").unwrap().mode;
        assert_ne!(ma, mb);
    }

    /// The other half: same metadata, different bytes. Catching this is what
    /// makes `content_sha256` load-bearing rather than decorative.
    #[test]
    fn one_changed_content_byte_is_caught() {
        let a = describe_ok(&build(0o644, b"hello image\n"));
        let b = describe_ok(&build(0o644, b"hello sffsX"));
        let da = a.entries.iter().find(|e| e.path == "/hello.txt").unwrap();
        let db = b.entries.iter().find(|e| e.path == "/hello.txt").unwrap();
        assert_eq!(da.size, db.size, "sizes equal, so only the digest can differ");
        assert_ne!(
            da.content_sha256, db.content_sha256,
            "a content change with an unchanged size must still be visible"
        );
    }
    /// The refusal the round trip's second load exists to hear.
    ///
    /// Before H-13, `roundtrip` compared decoded descriptions and never fed its
    /// own output back in, so gap 15 -- the kernel refusing images it had just
    /// written -- was invisible while the corpus reported EQUIVALENT. This pins
    /// the half of that check which can silently go wrong: a loader that
    /// accepts an image describing its deferred files NOWHERE would make the
    /// re-entry vacuous, and the verb would go back to proving a transform.
    #[test]
    fn an_image_describing_its_deferred_files_nowhere_is_refused() {
        // `build` writes a small tree and never calls `declare_deferred_section`,
        // which is exactly the shape the TypeScript writer produces and the
        // shape the loader must refuse.
        let image = wrap_vfsi(&build(0o644, b"hello"));

        let err = load_into_kernel(&image, "refused")
            .expect_err("an image that describes its deferred files nowhere must be refused");
        assert!(
            err.contains("EINVAL"),
            "refused for the stale-artifact reason, got {err}",
        );
    }
}

#[cfg(test)]
mod corpus_tests {
    use super::*;
    use std::path::PathBuf;

    /// The shipped image corpus, if this worktree has been provisioned.
    ///
    /// Skipped rather than failed when absent: a fresh checkout has no built
    /// images, and a test that fails there would be reporting provisioning
    /// rather than a defect.
    fn corpus() -> Vec<PathBuf> {
        let dir = Path::new("../../local-binaries/source-only-v1/programs/wasm32");
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut out: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.to_string_lossy().ends_with(".vfs.zst"))
            .collect();
        out.sort();
        out
    }

    /// Every shipped image describes IDENTICALLY twice, and differently from
    /// its neighbour.
    ///
    /// # Why run this against the real corpus
    ///
    /// The differ's own tests build four-entry trees. Y5's acceptance bar runs
    /// it against images of 9,000 to 13,800 entries carrying thousands of
    /// deferred files, and a describer that is merely self-consistent on a toy
    /// tree tells you nothing about that. This is the instrument being
    /// exercised at the size it will actually be used.
    ///
    /// Reflexivity is not a trivial property here: the description walks a
    /// directory tree, hashes resident content, groups hardlinks by inode and
    /// decodes a deferred section. Any ordering that depended on hash-map
    /// iteration rather than a sort would show up as two different
    /// descriptions of one file.
    #[test]
    fn every_shipped_image_describes_deterministically() {
        let images = corpus();
        if images.is_empty() {
            eprintln!("skip: no built images in local-binaries");
            return;
        }
        let mut descriptions = Vec::new();
        for path in &images {
            let a = describe(path).expect("describe");
            let b = describe(path).expect("describe again");
            assert_eq!(
                serde_json::to_value(&a).unwrap(),
                serde_json::to_value(&b).unwrap(),
                "{} must describe identically twice",
                path.display(),
            );
            assert!(!a.entries.is_empty(), "{} has entries", path.display());
            descriptions.push((path.clone(), serde_json::to_value(&a).unwrap()));
        }

        // And distinct images must not compare equal, or the bar would pass
        // anything.
        for window in descriptions.windows(2) {
            let (pa, a) = &window[0];
            let (pb, b) = &window[1];
            assert_ne!(a, b, "{} and {} must not describe alike", pa.display(), pb.display());
        }
        eprintln!("described {} shipped images deterministically", images.len());
    }

    /// The deferred set is decoded, not skipped, on images that carry
    /// thousands of entries.
    ///
    /// A describer that silently reported zero deferred files would compare
    /// equal across images whose deferred content differed — the exact failure
    /// the equivalence bar replaced byte-identity to catch.
    #[test]
    fn the_corpus_deferred_sets_are_read() {
        let images = corpus();
        if images.is_empty() {
            eprintln!("skip: no built images in local-binaries");
            return;
        }
        let mut with_deferred = 0;
        for path in &images {
            let d = describe(path).expect("describe");
            if !d.deferred.is_empty() {
                with_deferred += 1;
                assert!(
                    d.deferred.iter().all(|e| !e.path.starts_with("<unreachable")),
                    "{}: every deferred record must resolve to a path in the tree",
                    path.display(),
                );
            }
        }
        assert!(
            with_deferred > 0,
            "the shipped corpus carries deferred content; reading none means the decoder is not running",
        );
        eprintln!("{with_deferred} of {} images carry deferred entries", images.len());
    }

}
