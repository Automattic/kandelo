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
//! through `runtime_core::sffs` -- rather than reimplementing the format a
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

use runtime_core::sffs::{self, Sffs};

/// Offset of the container flags word. `sffs_span` validates magic and
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
    match sffs::file_type(mode) {
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
    let (body_offset, body_len) = sffs::sffs_span(&image)
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
    let fs = Sffs::mount(body).map_err(|e| format!("{}: mount: {e:?}", path.display()))?;

    // Deferred set first: an entry's digest depends on knowing whether it is
    // deferred, and asking the image twice would let the two answers drift.
    let (deferred_by_ino, carrier) = read_deferred(&fs, &image)?;

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
        },
        entries,
        hardlink_groups,
        deferred,
        deferred_carrier: carrier,
    })
}

fn fs_root<S: sffs::BlockSource>(_fs: &Sffs<S>) -> u32 {
    // SFFS fixes the root inode at 1; `Sffs` exposes lookup from a directory
    // inode rather than a root accessor.
    1
}

/// Read the deferred set from whichever carrier the image uses.
///
/// SDEF is preferred when present because it is the authority under V5; KLZY
/// is read otherwise. An image carrying both is not an error here -- SDEF wins
/// and the carrier is reported, so a comparison can see the disagreement
/// rather than having it silently resolved.
fn read_deferred<S: sffs::BlockSource>(
    fs: &Sffs<S>,
    image: &[u8],
) -> Result<(BTreeMap<u32, Deferred>, &'static str), String> {
    let mut out = BTreeMap::new();

    if let Some(section) = fs.deferred_section().map_err(|e| format!("SDEF: {e:?}"))? {
        for record in &section.records {
            out.insert(
                record.ino,
                Deferred {
                    path: String::new(),
                    real_size: record.size,
                    payload_sha256: hex(&Sha256::digest(&record.payload)),
                    archive_id: None,
                    source_path: None,
                },
            );
        }
        return Ok((out, "sdef"));
    }

    if let Some(section) = sffs::kernel_lazy_section(image).map_err(|e| format!("KLZY: {e:?}"))? {
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
        return Ok((out, "klzy"));
    }

    Ok((out, "none"))
}

fn walk<S: sffs::BlockSource>(
    fs: &Sffs<S>,
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

fn digest_file<S: sffs::BlockSource>(
    fs: &Sffs<S>,
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
        _ => Err("usage: xtask vfs-image <describe|diff> ...".to_string()),
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
    if a.deferred.len() != b.deferred.len() {
        eprintln!("deferred count: {} vs {}", a.deferred.len(), b.deferred.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use runtime_core::sffs_write::{Content, NoContent, SffsConfig, SffsWriter};

    /// Wrap a raw SFFS body in the minimal VFS image container.
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
        let mut w = SffsWriter::mkfs(SffsConfig {
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
        let a = describe_ok(&build(0o644, b"hello sffs\n"));
        let b = describe_ok(&build(0o644, b"hello sffs\n"));
        assert_eq!(as_json(&a), as_json(&b));
    }

    #[test]
    fn reads_the_namespace_it_was_given() {
        let d = describe_ok(&build(0o644, b"hello sffs\n"));
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
        let a = describe_ok(&build(0o644, b"hello sffs\n"));
        let b = describe_ok(&build(0o645, b"hello sffs\n"));
        assert_ne!(as_json(&a), as_json(&b), "a mode bit change must be visible");
        let ma = a.entries.iter().find(|e| e.path == "/hello.txt").unwrap().mode;
        let mb = b.entries.iter().find(|e| e.path == "/hello.txt").unwrap().mode;
        assert_ne!(ma, mb);
    }

    /// The other half: same metadata, different bytes. Catching this is what
    /// makes `content_sha256` load-bearing rather than decorative.
    #[test]
    fn one_changed_content_byte_is_caught() {
        let a = describe_ok(&build(0o644, b"hello sffs\n"));
        let b = describe_ok(&build(0o644, b"hello sffsX"));
        let da = a.entries.iter().find(|e| e.path == "/hello.txt").unwrap();
        let db = b.entries.iter().find(|e| e.path == "/hello.txt").unwrap();
        assert_eq!(da.size, db.size, "sizes equal, so only the digest can differ");
        assert_ne!(
            da.content_sha256, db.content_sha256,
            "a content change with an unchanged size must still be visible"
        );
    }
}
