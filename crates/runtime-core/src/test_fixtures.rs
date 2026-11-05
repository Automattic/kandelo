//! Test inputs built at test time from their producers, instead of committed
//! binaries.
//!
//! Committed generator output goes stale silently: when the producer changes
//! or is deleted, tests keep passing against bytes nothing emits any more.
//! `tiny.vfs` was exactly that, written once by the TypeScript
//! `MemoryFileSystem.saveImage` that has since been deleted, and it had
//! drifted from what any producer would write.
//!
//! Each fixture is built once per test binary and shared.

extern crate std;

use std::sync::OnceLock;
use std::vec::Vec;

use crate::kandelo_image_write::{Content, KandeloImageConfig, KandeloImageWriter, NoContent};
use crate::vfsi_container::{wrap, ContainerSections};

/// A small `/` image, written by the production Rust image writer, with
/// every timestamp at 2026-08-30T22:57:41.647Z.
///
/// Tree (inode numbers in creation order, which some tests rely on):
///
/// ```text
/// /hello.txt        2  0644  "hello sffs\n"
/// /dir              3  0755
/// /dir/nested.txt   4  0644  "nested\n"
/// /link             5        -> hello.txt
/// /big.txt          6  0644  45000 bytes, byte i = i % 251 (spans the
///                            single-indirect block)
/// ```
///
/// A 256 KiB body inside a VFSI container with NO deferred-file description:
/// no `SDEF` in the body and no `KLZY` section. One rootfs test asserts that
/// `load_image` refuses exactly this; the rest load [`tiny_vfs_described`].
///
/// WHY the Rust writer: the maintainer's ruling (2026-10-01) for this
/// fixture. Its consumers are READER tests (`KandeloImageFs`, `load_image`,
/// image policy), so writer -> reader is a round trip. It is not a golden
/// that checks the writer against its own earlier output, and it cannot
/// catch a writer change the reader follows in lockstep. That is the job of
/// the writer's own tests in `kandelo_image_write.rs`.
pub(crate) fn tiny_vfs() -> &'static [u8] {
    static BYTES: OnceLock<Vec<u8>> = OnceLock::new();
    BYTES.get_or_init(|| build_tiny_vfs(false))
}

/// [`tiny_vfs`] whose body DECLARES its (empty) deferred-file section, `SDEF`:
/// the statement "this image would have told you about deferred files", which
/// is what `rootfs::load_image` requires before it will load an image. Same
/// tree and inode numbers; the section's inode is unlinked and allocated after
/// the tree.
pub(crate) fn tiny_vfs_described() -> &'static [u8] {
    static BYTES: OnceLock<Vec<u8>> = OnceLock::new();
    BYTES.get_or_init(|| build_tiny_vfs(true))
}

fn build_tiny_vfs(declare_deferred: bool) -> Vec<u8> {
    {
        // A timestamp with a sub-second part, and nowhere near the 1,000 s
        // the rootfs `TestGuard` stamps on its own inodes: one rootfs test
        // checks that a loaded file reports the IMAGE's mtime, including the
        // millisecond -> nanosecond conversion. The default (Kandelo's
        // reference epoch) has no sub-second part and would not exercise it.
        let config = KandeloImageConfig {
            now_ms: 1_788_130_661_647,
            ..KandeloImageConfig::fixed(256 * 1024)
        };
        let mut writer = KandeloImageWriter::mkfs(config).expect("mkfs");
        let root = writer.root();
        writer
            .create_file(root, b"hello.txt", 0o644, Content::Bytes(b"hello sffs\n"))
            .expect("create /hello.txt");
        let dir = writer.mkdir(root, b"dir", 0o755).expect("mkdir /dir");
        writer
            .create_file(dir, b"nested.txt", 0o644, Content::Bytes(b"nested\n"))
            .expect("create /dir/nested.txt");
        writer.symlink(root, b"link", b"hello.txt").expect("symlink /link");
        let big: Vec<u8> = (0..45_000u32).map(|i| (i % 251) as u8).collect();
        writer
            .create_file(root, b"big.txt", 0o644, Content::Bytes(&big))
            .expect("create /big.txt");
        if declare_deferred {
            writer.declare_deferred_section();
        }
        let body = writer
            .finish()
            .expect("finish")
            .to_vec(&NoContent)
            .expect("serialize image body");
        wrap(
            &body,
            &ContainerSections {
                lazy_json: b"",
                archive_json: None,
                metadata_json: None,
                kernel_lazy: None,
            },
        )
        .expect("wrap VFSI container")
    }
}
