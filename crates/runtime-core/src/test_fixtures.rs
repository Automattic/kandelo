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

/// A [`HostIO`](crate::process::HostIO) that can tell the time and nothing
/// else: the host a kernel-log test needs, because every kernel-log record is
/// stamped from `host_clock_gettime(CLOCK_MONOTONIC)`.
///
/// `monotonic` is what `CLOCK_MONOTONIC` reads (seconds, nanoseconds), or the
/// errno the clock fails with. `host_close` succeeds, because a dying process
/// closes its descriptors; every other host operation is `unimplemented!`,
/// so a test that reaches the host for anything but the clock fails loudly
/// instead of seeing an invented answer.
pub(crate) struct ClockHost {
    pub monotonic: Result<(i64, i64), wasm_posix_shared::Errno>,
    /// How many times the clock was read, so a test can tell that a site
    /// consulted the host rather than skipping the timestamp.
    pub clock_reads: usize,
}

impl ClockHost {
    pub(crate) fn at(sec: i64, nsec: i64) -> Self {
        ClockHost { monotonic: Ok((sec, nsec)), clock_reads: 0 }
    }
}

impl crate::process::HostIO for ClockHost {
    fn host_clock_gettime(&mut self, clock_id: u32) -> Result<(i64, i64), wasm_posix_shared::Errno> {
        assert_eq!(clock_id, wasm_posix_shared::clock::CLOCK_MONOTONIC, "the kernel log reads the monotonic clock");
        self.clock_reads += 1;
        self.monotonic
    }
    // A process that dies closes its standard descriptors; closing is the one
    // other operation a log test has no reason to forbid.
    fn host_close(&mut self, _: i64) -> Result<(), wasm_posix_shared::Errno> { Ok(()) }
    fn host_read(&mut self, _: i64, _: &mut [u8]) -> Result<usize, wasm_posix_shared::Errno> { unimplemented!() }
    fn host_write(&mut self, _: i64, _: &[u8]) -> Result<usize, wasm_posix_shared::Errno> { unimplemented!() }
    fn host_seek(&mut self, _: i64, _: i64, _: u32) -> Result<i64, wasm_posix_shared::Errno> { unimplemented!() }
    fn host_fstat(&mut self, _: i64) -> Result<wasm_posix_shared::WasmStat, wasm_posix_shared::Errno> { unimplemented!() }
    fn host_readdir(&mut self, _: i64, _: &mut [u8]) -> Result<Option<(u64, u32, usize)>, wasm_posix_shared::Errno> { unimplemented!() }
    fn host_ftruncate(&mut self, _: i64, _: i64) -> Result<(), wasm_posix_shared::Errno> { unimplemented!() }
    fn host_fsync(&mut self, _: i64) -> Result<(), wasm_posix_shared::Errno> { unimplemented!() }
    fn host_fchmod(&mut self, _: i64, _: u32) -> Result<(), wasm_posix_shared::Errno> { unimplemented!() }
    fn host_fchown(&mut self, _: i64, _: u32, _: u32) -> Result<(), wasm_posix_shared::Errno> { unimplemented!() }
    fn host_set_alarm(&mut self, _: u32) -> Result<(), wasm_posix_shared::Errno> { unimplemented!() }
    fn host_set_posix_timer(&mut self, _: i32, _: i32, _: i64, _: i64) -> Result<(), wasm_posix_shared::Errno> { unimplemented!() }
    fn bind_framebuffer(&mut self, _: i32, _: usize, _: usize, _: u32, _: u32, _: u32, _: u32) { unimplemented!() }
    fn unbind_framebuffer(&mut self, _: i32) { unimplemented!() }
    fn fb_write(&mut self, _: i32, _: usize, _: &[u8]) { unimplemented!() }
    fn host_getrandom(&mut self, _: &mut [u8]) -> Result<usize, wasm_posix_shared::Errno> { unimplemented!() }
    fn host_net_connect(&mut self, _: i32, _: &[u8], _: u16) -> Result<(), wasm_posix_shared::Errno> { unimplemented!() }
    fn host_net_connect_status(&mut self, _: i32) -> Result<(), wasm_posix_shared::Errno> { unimplemented!() }
    fn host_net_send(&mut self, _: i32, _: &[u8], _: u32) -> Result<usize, wasm_posix_shared::Errno> { unimplemented!() }
    fn host_net_recv(&mut self, _: i32, _: u32, _: u32, _: &mut [u8]) -> Result<usize, wasm_posix_shared::Errno> { unimplemented!() }
    fn host_net_close(&mut self, _: i32) -> Result<(), wasm_posix_shared::Errno> { unimplemented!() }
    fn host_net_listen(&mut self, _: i32, _: u16, _: &[u8; 4]) -> Result<(), wasm_posix_shared::Errno> { unimplemented!() }
    fn host_getaddrinfo(&mut self, _: &[u8], _: &mut [u8]) -> Result<usize, wasm_posix_shared::Errno> { unimplemented!() }
}
