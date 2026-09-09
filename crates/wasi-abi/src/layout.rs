//! WASI Preview 1 binary struct layouts, and the encoders that produce them.
//!
//! Pure byte-slice computation: nothing here knows about wasm, linear memory,
//! or the syscall channel, so `cargo test -p wasi-abi` covers all of it.
//!
//! The kernel-side layouts come from `wasm_posix_shared` rather than from
//! hand-written numbers. That is **DEFECT FIX 4**, and it is not cosmetic --
//! see [`WasmStatFields::decode`].

use core::mem::{align_of, offset_of, size_of};

use wasm_posix_shared::WasmStat;

use crate::translate::mode_to_filetype;
use crate::types::{WasiFiletype, WASI_PREOPENTYPE_DIR};

/// Reads a little-endian value out of a byte slice at `offset`.
macro_rules! rd {
    ($ty:ty, $buf:expr, $off:expr) => {{
        const N: usize = size_of::<$ty>();
        let start = $off;
        match $buf.get(start..start + N) {
            Some(bytes) => {
                let mut raw = [0u8; N];
                raw.copy_from_slice(bytes);
                Some(<$ty>::from_le_bytes(raw))
            }
            None => None,
        }
    }};
}

/// Writes a little-endian value into a byte slice at `offset`.
macro_rules! wr {
    ($buf:expr, $off:expr, $value:expr) => {{
        let value = $value;
        let bytes = value.to_le_bytes();
        match $buf.get_mut($off..$off + bytes.len()) {
            Some(slot) => {
                slot.copy_from_slice(&bytes);
                true
            }
            None => false,
        }
    }};
}

/// Byte offsets of the kernel's `WasmStat`, derived from the struct itself.
///
/// **DEFECT FIX 4.** `translateStat` (`host/src/wasi-shim.ts:606-637`) reads
/// this struct at hand-written offsets `0/8/16/20/32/40/48/56/64/72/80` while
/// importing `WASM_STAT_SIZE` and never using it. Two of those reads are wrong
/// in a way that only zeroed padding hides:
///
/// * `st_atime_nsec` and `st_mtime_nsec` are `u32` fields followed by four
///   bytes of alignment padding, and the TypeScript reads each as a `u64`.
/// * `st_ctime_nsec` is a `u32` at offset 80 followed by the struct's explicit
///   `_pad: u32` at offset 84 -- and the TypeScript reads a `u64` at 80, so a
///   non-zero `_pad` lands in the high 32 bits of the reported nanoseconds.
///
/// Deriving every offset with `offset_of!` makes the layout the compiler's
/// problem, which is the whole point of moving this into Rust.
pub mod wasm_stat {
    use super::*;

    pub const SIZE: usize = size_of::<WasmStat>();
    pub const ALIGN: usize = align_of::<WasmStat>();

    pub const ST_DEV: usize = offset_of!(WasmStat, st_dev);
    pub const ST_INO: usize = offset_of!(WasmStat, st_ino);
    pub const ST_MODE: usize = offset_of!(WasmStat, st_mode);
    pub const ST_NLINK: usize = offset_of!(WasmStat, st_nlink);
    pub const ST_SIZE: usize = offset_of!(WasmStat, st_size);
    pub const ST_ATIME_SEC: usize = offset_of!(WasmStat, st_atime_sec);
    pub const ST_ATIME_NSEC: usize = offset_of!(WasmStat, st_atime_nsec);
    pub const ST_MTIME_SEC: usize = offset_of!(WasmStat, st_mtime_sec);
    pub const ST_MTIME_NSEC: usize = offset_of!(WasmStat, st_mtime_nsec);
    pub const ST_CTIME_SEC: usize = offset_of!(WasmStat, st_ctime_sec);
    pub const ST_CTIME_NSEC: usize = offset_of!(WasmStat, st_ctime_nsec);
}

/// The subset of `WasmStat` the WASI `filestat` needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WasmStatFields {
    pub dev: u64,
    pub ino: u64,
    pub mode: u32,
    pub nlink: u32,
    pub size: u64,
    pub atime_sec: u64,
    pub atime_nsec: u32,
    pub mtime_sec: u64,
    pub mtime_nsec: u32,
    pub ctime_sec: u64,
    pub ctime_nsec: u32,
}

impl WasmStatFields {
    /// Decode a kernel `WasmStat` from its wire bytes.
    ///
    /// Returns `None` if the buffer is shorter than the struct, rather than
    /// reading whatever follows it.
    pub fn decode(buf: &[u8]) -> Option<Self> {
        if buf.len() < wasm_stat::SIZE {
            return None;
        }
        Some(Self {
            dev: rd!(u64, buf, wasm_stat::ST_DEV)?,
            ino: rd!(u64, buf, wasm_stat::ST_INO)?,
            mode: rd!(u32, buf, wasm_stat::ST_MODE)?,
            nlink: rd!(u32, buf, wasm_stat::ST_NLINK)?,
            size: rd!(u64, buf, wasm_stat::ST_SIZE)?,
            atime_sec: rd!(u64, buf, wasm_stat::ST_ATIME_SEC)?,
            atime_nsec: rd!(u32, buf, wasm_stat::ST_ATIME_NSEC)?,
            mtime_sec: rd!(u64, buf, wasm_stat::ST_MTIME_SEC)?,
            mtime_nsec: rd!(u32, buf, wasm_stat::ST_MTIME_NSEC)?,
            ctime_sec: rd!(u64, buf, wasm_stat::ST_CTIME_SEC)?,
            ctime_nsec: rd!(u32, buf, wasm_stat::ST_CTIME_NSEC)?,
        })
    }
}

/// Combine a POSIX `(seconds, nanoseconds)` pair into a WASI `timestamp`,
/// which is nanoseconds since the epoch.
///
/// Saturates rather than wrapping. The TypeScript computes
/// `sec * 1000000000n + nsec` in BigInt, which cannot overflow but can hand
/// the guest a value wider than the `u64` slot it writes into.
pub const fn wasi_timestamp(sec: u64, nsec: u32) -> u64 {
    match sec.checked_mul(1_000_000_000) {
        Some(scaled) => match scaled.checked_add(nsec as u64) {
            Some(total) => total,
            None => u64::MAX,
        },
        None => u64::MAX,
    }
}

/// WASI `filestat`: 64 bytes.
///
/// ```text
///  0 dev       u64
///  8 ino       u64
/// 16 filetype  u8   (+7 bytes padding)
/// 24 nlink     u64
/// 32 size      u64
/// 40 atim      u64  nanoseconds
/// 48 mtim      u64  nanoseconds
/// 56 ctim      u64  nanoseconds
/// ```
pub mod filestat {
    pub const SIZE: usize = 64;
    pub const DEV: usize = 0;
    pub const INO: usize = 8;
    pub const FILETYPE: usize = 16;
    pub const PAD: usize = 17;
    pub const PAD_LEN: usize = 7;
    pub const NLINK: usize = 24;
    pub const SIZE_FIELD: usize = 32;
    pub const ATIM: usize = 40;
    pub const MTIM: usize = 48;
    pub const CTIM: usize = 56;
}

/// Encode a kernel stat as a WASI `filestat`. Returns `false` if `out` is too
/// small, having written nothing.
pub fn encode_filestat(st: &WasmStatFields, out: &mut [u8]) -> bool {
    if out.len() < filestat::SIZE {
        return false;
    }
    wr!(out, filestat::DEV, st.dev);
    wr!(out, filestat::INO, st.ino);
    out[filestat::FILETYPE] = mode_to_filetype(st.mode).as_u8();
    for slot in &mut out[filestat::PAD..filestat::PAD + filestat::PAD_LEN] {
        *slot = 0;
    }
    wr!(out, filestat::NLINK, st.nlink as u64);
    wr!(out, filestat::SIZE_FIELD, st.size);
    wr!(out, filestat::ATIM, wasi_timestamp(st.atime_sec, st.atime_nsec));
    wr!(out, filestat::MTIM, wasi_timestamp(st.mtime_sec, st.mtime_nsec));
    wr!(out, filestat::CTIM, wasi_timestamp(st.ctime_sec, st.ctime_nsec));
    true
}

/// WASI `fdstat`: 24 bytes.
///
/// ```text
///  0 fs_filetype          u8 (+1 padding)
///  2 fs_flags             u16 (+4 padding)
///  8 fs_rights_base       u64
/// 16 fs_rights_inheriting u64
/// ```
pub mod fdstat {
    pub const SIZE: usize = 24;
    pub const FILETYPE: usize = 0;
    pub const FLAGS: usize = 2;
    pub const RIGHTS_BASE: usize = 8;
    pub const RIGHTS_INHERITING: usize = 16;
}

pub fn encode_fdstat(
    filetype: WasiFiletype,
    fdflags: u16,
    rights_base: u64,
    rights_inheriting: u64,
    out: &mut [u8],
) -> bool {
    if out.len() < fdstat::SIZE {
        return false;
    }
    for slot in &mut out[..fdstat::SIZE] {
        *slot = 0;
    }
    out[fdstat::FILETYPE] = filetype.as_u8();
    wr!(out, fdstat::FLAGS, fdflags);
    wr!(out, fdstat::RIGHTS_BASE, rights_base);
    wr!(out, fdstat::RIGHTS_INHERITING, rights_inheriting);
    true
}

/// WASI `prestat`: 8 bytes -- a tag then, for a directory, the name length.
pub mod prestat {
    pub const SIZE: usize = 8;
    pub const TAG: usize = 0;
    pub const DIR_NAME_LEN: usize = 4;
}

pub fn encode_prestat_dir(name_len: u32, out: &mut [u8]) -> bool {
    if out.len() < prestat::SIZE {
        return false;
    }
    for slot in &mut out[..prestat::SIZE] {
        *slot = 0;
    }
    out[prestat::TAG] = WASI_PREOPENTYPE_DIR;
    wr!(out, prestat::DIR_NAME_LEN, name_len);
    true
}

/// WASI `dirent`: a 24-byte header immediately followed by the name bytes.
///
/// ```text
///  0 d_next    u64  the cookie to pass to resume AFTER this entry
///  8 d_ino     u64
/// 16 d_namlen  u32
/// 20 d_type    u8   (+3 padding)
/// ```
pub mod dirent {
    pub const HEADER_SIZE: usize = 24;
    pub const NEXT: usize = 0;
    pub const INO: usize = 8;
    pub const NAMLEN: usize = 16;
    pub const TYPE: usize = 20;
}

pub fn encode_dirent_header(
    next_cookie: u64,
    ino: u64,
    name_len: u32,
    filetype: WasiFiletype,
    out: &mut [u8],
) -> bool {
    if out.len() < dirent::HEADER_SIZE {
        return false;
    }
    for slot in &mut out[..dirent::HEADER_SIZE] {
        *slot = 0;
    }
    wr!(out, dirent::NEXT, next_cookie);
    wr!(out, dirent::INO, ino);
    wr!(out, dirent::NAMLEN, name_len);
    out[dirent::TYPE] = filetype.as_u8();
    true
}

/// Linux `dirent64`, the shape `getdents64` returns.
///
/// ```text
///  0 d_ino     u64
///  8 d_off     i64
/// 16 d_reclen  u16
/// 18 d_type    u8
/// 19 d_name    NUL-terminated bytes
/// ```
pub mod linux_dirent64 {
    pub const INO: usize = 0;
    pub const OFF: usize = 8;
    pub const RECLEN: usize = 16;
    pub const TYPE: usize = 18;
    pub const NAME: usize = 19;
    pub const MIN_SIZE: usize = 19;
}

/// One decoded Linux directory entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinuxDirent<'a> {
    pub ino: u64,
    pub off: i64,
    pub reclen: u16,
    pub d_type: u8,
    pub name: &'a [u8],
}

/// Decode the `getdents64` entry at the start of `buf`.
///
/// Returns the entry and the number of bytes it occupies, or `None` if the
/// buffer does not hold a complete, self-consistent record. A record whose
/// `d_reclen` does not fit, or is smaller than the fixed header, is rejected
/// rather than trusted -- a malformed length would otherwise make the walk
/// loop forever or read past the buffer.
pub fn decode_linux_dirent(buf: &[u8]) -> Option<(LinuxDirent<'_>, usize)> {
    if buf.len() < linux_dirent64::MIN_SIZE {
        return None;
    }
    let reclen = rd!(u16, buf, linux_dirent64::RECLEN)? as usize;
    if reclen < linux_dirent64::MIN_SIZE || reclen > buf.len() {
        return None;
    }
    let name_region = &buf[linux_dirent64::NAME..reclen];
    let name_len = match name_region.iter().position(|&b| b == 0) {
        Some(pos) => pos,
        None => name_region.len(),
    };
    Some((
        LinuxDirent {
            ino: rd!(u64, buf, linux_dirent64::INO)?,
            off: rd!(i64, buf, linux_dirent64::OFF)?,
            reclen: reclen as u16,
            d_type: buf[linux_dirent64::TYPE],
            name: &name_region[..name_len],
        },
        reclen,
    ))
}

/// Linux `DT_*` directory entry types, mapped onto WASI filetypes.
pub const fn dirent_type_to_filetype(d_type: u8) -> WasiFiletype {
    match d_type {
        1 => WasiFiletype::CharacterDevice, // DT_FIFO -> closest available
        2 => WasiFiletype::CharacterDevice, // DT_CHR
        4 => WasiFiletype::Directory,       // DT_DIR
        6 => WasiFiletype::BlockDevice,     // DT_BLK
        8 => WasiFiletype::RegularFile,     // DT_REG
        10 => WasiFiletype::SymbolicLink,   // DT_LNK
        12 => WasiFiletype::SocketStream,   // DT_SOCK
        _ => WasiFiletype::Unknown,         // DT_UNKNOWN(0) and anything else
    }
}

/// WASI `subscription`: 48 bytes.
///
/// ```text
///  0 userdata            u64
///  8 u.tag               u8 (+7 padding)
/// 16 union payload
///      clock:  id u32 @16, (pad) timeout u64 @24, precision u64 @32, flags u16 @40
///      fd_rw:  fd u32 @16
/// ```
pub mod subscription {
    pub const SIZE: usize = 48;
    pub const USERDATA: usize = 0;
    pub const TAG: usize = 8;
    pub const CLOCK_ID: usize = 16;
    pub const CLOCK_TIMEOUT: usize = 24;
    pub const CLOCK_PRECISION: usize = 32;
    pub const CLOCK_FLAGS: usize = 40;
    pub const FD: usize = 16;
}

/// A decoded WASI subscription.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Subscription {
    pub userdata: u64,
    pub tag: u8,
    /// For a clock subscription.
    pub clock_id: u32,
    pub clock_timeout: u64,
    pub clock_flags: u16,
    /// For an fd read/write subscription.
    pub fd: u32,
}

pub fn decode_subscription(buf: &[u8]) -> Option<Subscription> {
    if buf.len() < subscription::SIZE {
        return None;
    }
    Some(Subscription {
        userdata: rd!(u64, buf, subscription::USERDATA)?,
        tag: buf[subscription::TAG],
        clock_id: rd!(u32, buf, subscription::CLOCK_ID)?,
        clock_timeout: rd!(u64, buf, subscription::CLOCK_TIMEOUT)?,
        clock_flags: rd!(u16, buf, subscription::CLOCK_FLAGS)?,
        fd: rd!(u32, buf, subscription::FD)?,
    })
}

/// WASI `event`: 32 bytes.
///
/// ```text
///  0 userdata     u64
///  8 error        u16
/// 10 type         u8 (+5 padding)
/// 16 fd_readwrite.nbytes u64
/// 24 fd_readwrite.flags  u16
/// ```
pub mod event {
    pub const SIZE: usize = 32;
    pub const USERDATA: usize = 0;
    pub const ERROR: usize = 8;
    pub const TYPE: usize = 10;
    pub const NBYTES: usize = 16;
    pub const FLAGS: usize = 24;
}

pub fn encode_event(
    userdata: u64,
    error: u16,
    event_type: u8,
    nbytes: u64,
    flags: u16,
    out: &mut [u8],
) -> bool {
    if out.len() < event::SIZE {
        return false;
    }
    for slot in &mut out[..event::SIZE] {
        *slot = 0;
    }
    wr!(out, event::USERDATA, userdata);
    wr!(out, event::ERROR, error);
    out[event::TYPE] = event_type;
    wr!(out, event::NBYTES, nbytes);
    wr!(out, event::FLAGS, flags);
    true
}

/// WASI `ciovec` / `iovec`, as a wasm32 guest lays them out.
pub mod iovec {
    pub const SIZE: usize = 8;
    pub const BUF: usize = 0;
    pub const BUF_LEN: usize = 4;
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_posix_shared::mode;

    #[test]
    fn wasm_stat_layout_matches_the_generated_abi_size() {
        // host/src/generated/abi.ts: STRUCT_SIZE_WASM_STAT = 88.
        assert_eq!(wasm_stat::SIZE, 88);
        assert_eq!(wasm_stat::ST_DEV, 0);
        assert_eq!(wasm_stat::ST_INO, 8);
        assert_eq!(wasm_stat::ST_MODE, 16);
        assert_eq!(wasm_stat::ST_NLINK, 20);
        assert_eq!(wasm_stat::ST_SIZE, 32);
        assert_eq!(wasm_stat::ST_ATIME_SEC, 40);
        assert_eq!(wasm_stat::ST_ATIME_NSEC, 48);
        assert_eq!(wasm_stat::ST_MTIME_SEC, 56);
        assert_eq!(wasm_stat::ST_MTIME_NSEC, 64);
        assert_eq!(wasm_stat::ST_CTIME_SEC, 72);
        assert_eq!(wasm_stat::ST_CTIME_NSEC, 80);
    }

    /// The concrete shape of DEFECT 4.
    #[test]
    fn defect_4_the_typescript_ctime_read_straddles_the_struct_padding() {
        let mut raw = [0u8; wasm_stat::SIZE];
        raw[wasm_stat::ST_CTIME_NSEC..wasm_stat::ST_CTIME_NSEC + 4]
            .copy_from_slice(&123_456_789u32.to_le_bytes());
        // The struct's explicit `_pad: u32` sits at offset 84, right after
        // st_ctime_nsec. Give it a non-zero value, as any uninitialised or
        // reused buffer might.
        raw[84..88].copy_from_slice(&0xDEAD_BEEFu32.to_le_bytes());

        let decoded = WasmStatFields::decode(&raw).expect("decodes");
        assert_eq!(decoded.ctime_nsec, 123_456_789);

        // What `translateStat` does instead: read a u64 at offset 80.
        let mut wide = [0u8; 8];
        wide.copy_from_slice(&raw[80..88]);
        let as_typescript_reads_it = u64::from_le_bytes(wide);
        assert_eq!(as_typescript_reads_it, 0xDEAD_BEEF_075B_CD15);
        assert_ne!(as_typescript_reads_it, decoded.ctime_nsec as u64);
    }

    #[test]
    fn stat_decode_rejects_a_short_buffer() {
        assert_eq!(WasmStatFields::decode(&[0u8; wasm_stat::SIZE - 1]), None);
        assert!(WasmStatFields::decode(&[0u8; wasm_stat::SIZE]).is_some());
    }

    #[test]
    fn filestat_encodes_the_documented_layout() {
        let st = WasmStatFields {
            dev: 0x1122_3344_5566_7788,
            ino: 42,
            mode: mode::S_IFREG | 0o644,
            nlink: 3,
            size: 4096,
            atime_sec: 1,
            atime_nsec: 500,
            mtime_sec: 2,
            mtime_nsec: 600,
            ctime_sec: 3,
            ctime_nsec: 700,
        };
        let mut out = [0xAAu8; filestat::SIZE];
        assert!(encode_filestat(&st, &mut out));

        assert_eq!(u64::from_le_bytes(out[0..8].try_into().unwrap()), st.dev);
        assert_eq!(u64::from_le_bytes(out[8..16].try_into().unwrap()), 42);
        assert_eq!(out[16], WasiFiletype::RegularFile.as_u8());
        // The 7 padding bytes must be zeroed, not left as whatever was there.
        assert_eq!(&out[17..24], &[0u8; 7]);
        assert_eq!(u64::from_le_bytes(out[24..32].try_into().unwrap()), 3);
        assert_eq!(u64::from_le_bytes(out[32..40].try_into().unwrap()), 4096);
        assert_eq!(u64::from_le_bytes(out[40..48].try_into().unwrap()), 1_000_000_500);
        assert_eq!(u64::from_le_bytes(out[48..56].try_into().unwrap()), 2_000_000_600);
        assert_eq!(u64::from_le_bytes(out[56..64].try_into().unwrap()), 3_000_000_700);
    }

    #[test]
    fn filestat_refuses_a_short_buffer() {
        let st = WasmStatFields::default();
        let mut out = [0u8; filestat::SIZE - 1];
        assert!(!encode_filestat(&st, &mut out));
    }

    #[test]
    fn timestamps_saturate_instead_of_wrapping() {
        assert_eq!(wasi_timestamp(0, 0), 0);
        assert_eq!(wasi_timestamp(1, 500), 1_000_000_500);
        assert_eq!(wasi_timestamp(u64::MAX, 0), u64::MAX);
        assert_eq!(wasi_timestamp(u64::MAX / 1_000_000_000, u32::MAX), u64::MAX);
    }

    #[test]
    fn fdstat_and_prestat_encode() {
        let mut out = [0xFFu8; fdstat::SIZE];
        assert!(encode_fdstat(WasiFiletype::Directory, 0b101, 0x1FFF_FFFF, 0x1FFF_FFFF, &mut out));
        assert_eq!(out[0], WasiFiletype::Directory.as_u8());
        assert_eq!(out[1], 0, "the byte after filetype is padding and must be zeroed");
        assert_eq!(u16::from_le_bytes(out[2..4].try_into().unwrap()), 0b101);
        assert_eq!(u64::from_le_bytes(out[8..16].try_into().unwrap()), 0x1FFF_FFFF);
        assert_eq!(u64::from_le_bytes(out[16..24].try_into().unwrap()), 0x1FFF_FFFF);

        let mut pre = [0xFFu8; prestat::SIZE];
        assert!(encode_prestat_dir(9, &mut pre));
        assert_eq!(pre[0], WASI_PREOPENTYPE_DIR);
        assert_eq!(u32::from_le_bytes(pre[4..8].try_into().unwrap()), 9);
    }

    fn linux_dirent_bytes(ino: u64, off: i64, d_type: u8, name: &str) -> alloc_vec::Vec {
        let reclen = (linux_dirent64::NAME + name.len() + 1).next_multiple_of(8);
        let mut buf = alloc_vec::Vec::new(reclen);
        buf.as_mut()[0..8].copy_from_slice(&ino.to_le_bytes());
        buf.as_mut()[8..16].copy_from_slice(&off.to_le_bytes());
        buf.as_mut()[16..18].copy_from_slice(&(reclen as u16).to_le_bytes());
        buf.as_mut()[18] = d_type;
        buf.as_mut()[19..19 + name.len()].copy_from_slice(name.as_bytes());
        buf
    }

    /// A tiny fixed-capacity byte buffer so these tests need no allocator.
    mod alloc_vec {
        pub struct Vec {
            data: [u8; 128],
            len: usize,
        }
        impl Vec {
            pub fn new(len: usize) -> Self {
                assert!(len <= 128);
                Self { data: [0u8; 128], len }
            }
            pub fn as_mut(&mut self) -> &mut [u8] {
                &mut self.data[..self.len]
            }
            pub fn as_ref(&self) -> &[u8] {
                &self.data[..self.len]
            }
        }
    }

    #[test]
    fn linux_dirent_decodes_name_and_advances_by_reclen() {
        let entry = linux_dirent_bytes(7, 99, 8, "hello.txt");
        let (decoded, used) = decode_linux_dirent(entry.as_ref()).expect("decodes");
        assert_eq!(decoded.ino, 7);
        assert_eq!(decoded.off, 99);
        assert_eq!(decoded.name, b"hello.txt");
        assert_eq!(dirent_type_to_filetype(decoded.d_type), WasiFiletype::RegularFile);
        assert_eq!(used, decoded.reclen as usize);
        assert_eq!(used, entry.as_ref().len());
    }

    #[test]
    fn linux_dirent_rejects_malformed_lengths() {
        // Too short for the fixed header.
        assert!(decode_linux_dirent(&[0u8; 18]).is_none());

        // A reclen smaller than the header would make a walk loop forever.
        let mut buf = [0u8; 32];
        buf[16..18].copy_from_slice(&4u16.to_le_bytes());
        assert!(decode_linux_dirent(&buf).is_none());

        // A reclen past the end of the buffer must not be trusted.
        buf[16..18].copy_from_slice(&64u16.to_le_bytes());
        assert!(decode_linux_dirent(&buf).is_none());
    }

    #[test]
    fn dirent_type_mapping_covers_the_dt_values() {
        assert_eq!(dirent_type_to_filetype(4), WasiFiletype::Directory);
        assert_eq!(dirent_type_to_filetype(8), WasiFiletype::RegularFile);
        assert_eq!(dirent_type_to_filetype(10), WasiFiletype::SymbolicLink);
        assert_eq!(dirent_type_to_filetype(0), WasiFiletype::Unknown);
        assert_eq!(dirent_type_to_filetype(200), WasiFiletype::Unknown);
    }

    #[test]
    fn dirent_header_encodes() {
        let mut out = [0xFFu8; dirent::HEADER_SIZE];
        assert!(encode_dirent_header(5, 42, 9, WasiFiletype::Directory, &mut out));
        assert_eq!(u64::from_le_bytes(out[0..8].try_into().unwrap()), 5);
        assert_eq!(u64::from_le_bytes(out[8..16].try_into().unwrap()), 42);
        assert_eq!(u32::from_le_bytes(out[16..20].try_into().unwrap()), 9);
        assert_eq!(out[20], WasiFiletype::Directory.as_u8());
        assert_eq!(&out[21..24], &[0u8; 3], "the 3 trailing bytes are padding");
    }

    #[test]
    fn subscription_and_event_round_trip_their_layouts() {
        let mut raw = [0u8; subscription::SIZE];
        raw[0..8].copy_from_slice(&0xCAFEu64.to_le_bytes());
        raw[8] = 1; // FD_READ
        raw[16..20].copy_from_slice(&3u32.to_le_bytes());
        let sub = decode_subscription(&raw).expect("decodes");
        assert_eq!(sub.userdata, 0xCAFE);
        assert_eq!(sub.tag, 1);
        assert_eq!(sub.fd, 3);

        assert!(decode_subscription(&[0u8; subscription::SIZE - 1]).is_none());

        let mut out = [0xFFu8; event::SIZE];
        assert!(encode_event(0xCAFE, 0, 1, 64, 0, &mut out));
        assert_eq!(u64::from_le_bytes(out[0..8].try_into().unwrap()), 0xCAFE);
        assert_eq!(u16::from_le_bytes(out[8..10].try_into().unwrap()), 0);
        assert_eq!(out[10], 1);
        assert_eq!(&out[11..16], &[0u8; 5], "padding must be zeroed");
        assert_eq!(u64::from_le_bytes(out[16..24].try_into().unwrap()), 64);
    }
}
