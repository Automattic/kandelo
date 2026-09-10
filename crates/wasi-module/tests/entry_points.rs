//! Every `wasi_snapshot_preview1` entry point, driven against a fake guest
//! memory and a recording fake channel.
//!
//! This is the evidence that licenses the Rust path. The repository's only
//! WASI guest fixtures are three hand-written `.wat` files covering
//! `fd_write`, `args_get`, and i64 scalar fidelity, and the declared toolchain
//! cannot build a realistic wasi-libc binary at all (no wasi sysroot in
//! `flake.nix`, no `wasm32-wasip1` std). So the entry points are exercised
//! here instead, where the exact syscall number and the six i64 argument slots
//! are observable -- the same shape `host/test/wasi-shim.test.ts:60-84`
//! asserts against a mocked `Atomics.wait`.
//!
//! Tests named `defect_N_*` pin behavior that DIFFERS from the TypeScript on
//! purpose. Each names the defect it fixes.

#![cfg(feature = "testing")]

use wasi_abi::layout;
use wasi_abi::WasiErrno;
use wasm_posix_shared::abi::extended_syscalls;
use wasm_posix_shared::{channel, fcntl_cmd, flags, seek, Syscall};

use wasi_module::channel::{ChannelResponse, FakeChannel, RecordedCall};
use wasi_module::mem::{FakeMemory, GuestMemory};
use wasi_module::shim::WasiShim;
use wasi_module::StringBlob;

const CHANNEL_BASE: u64 = 65536;
const MEM_SIZE: usize = 256 * 1024;
const DATA: u64 = CHANNEL_BASE + channel::DATA_OFFSET as u64;
/// Guest scratch, well clear of the channel.
const GUEST: u32 = 1024;

type Shim<'m> = WasiShim<&'m FakeMemory, FakeChannel<'m>>;

fn memory() -> FakeMemory {
    FakeMemory::new(MEM_SIZE)
}

/// A shim whose channel always succeeds with `result`.
fn shim_ok(mem: &FakeMemory, result: i64) -> Shim<'_> {
    shim_with(mem, move |_, _| ChannelResponse::ok(result))
}

fn shim_with<'m>(
    mem: &'m FakeMemory,
    responder: impl Fn(&RecordedCall, &FakeMemory) -> ChannelResponse + 'm,
) -> Shim<'m> {
    WasiShim::new(
        mem,
        FakeChannel::new(CHANNEL_BASE, mem, responder),
        StringBlob::default(),
        StringBlob::default(),
    )
}

/// Seeds the "/" preopen without issuing the real `init()` open, for the
/// tests that only care about path resolution.
fn with_root(mem: &FakeMemory) -> Shim<'_> {
    let mut shim = shim_ok(mem, 3);
    shim.init().expect("init opens /");
    shim
}

fn read_cstr(mem: &FakeMemory, addr: u64) -> std::string::String {
    let mut out = std::vec::Vec::new();
    let mut cursor = addr;
    loop {
        let byte = mem.read_u8(cursor).expect("in range");
        if byte == 0 {
            break;
        }
        out.push(byte);
        cursor += 1;
    }
    std::string::String::from_utf8(out).expect("utf8")
}

// ---------------------------------------------------------------- init/preopen

#[test]
fn init_opens_root_read_only_and_records_the_preopen() {
    let mem = memory();
    let shim = with_root(&mem);
    let call = shim.chan.only_call();
    assert_eq!(call.nr, Syscall::Openat as u32);
    assert_eq!(call.args[0], flags::AT_FDCWD as i64);
    assert_eq!(call.args[1], DATA as i64);
    assert_eq!(
        call.args[2],
        (flags::O_RDONLY | flags::O_DIRECTORY) as i64,
        "root must open read-only as a directory"
    );
    assert_eq!(read_cstr(&mem, DATA), "/");
    assert_eq!(shim.preopens().get(3), Some(&b"/"[..]));
}

#[test]
fn init_reports_a_failed_root_open_instead_of_leaving_no_preopen() {
    // The TypeScript ignores the errno and leaves the table empty; the guest
    // then sees EBADF from fd_prestat_get and concludes it has no filesystem.
    let mem = memory();
    let mut shim = shim_with(&mem, |_, _| ChannelResponse::err(13)); // EACCES
    assert_eq!(shim.init(), Err(WasiErrno::Acces));
    assert!(shim.preopens().is_empty());
}

#[test]
fn prestat_reports_the_preopen_and_ebadf_for_anything_else() {
    let mem = memory();
    let shim = with_root(&mem);
    shim.fd_prestat_get(3, GUEST).expect("prestat");
    assert_eq!(mem.snapshot(GUEST as u64, 1), std::vec![0], "PREOPENTYPE_DIR");
    assert_eq!(
        u32::from_le_bytes(mem.snapshot(GUEST as u64 + 4, 4).try_into().unwrap()),
        1,
        "the name \"/\" is one byte"
    );
    assert_eq!(shim.fd_prestat_get(4, GUEST), Err(WasiErrno::BadF));
    assert_eq!(shim.fd_prestat_dir_name(4, GUEST, 8), Err(WasiErrno::BadF));

    shim.fd_prestat_dir_name(3, GUEST, 8).expect("dir name");
    assert_eq!(mem.snapshot(GUEST as u64, 1), std::vec![b'/']);
}

// ------------------------------------------------------------- args / environ

#[test]
fn args_and_environ_publish_pointers_into_the_guest_buffer() {
    let mem = memory();
    // Two NUL-separated strings staged where the host would write them.
    let blob_at = 4096u32;
    mem.write(blob_at as u64, b"prog\0--flag\0").unwrap();
    let blob = StringBlob {
        ptr: blob_at,
        count: 2,
        bytes: 12,
    };
    let shim = WasiShim::new(
        &mem,
        FakeChannel::new(CHANNEL_BASE, &mem, |_, _| ChannelResponse::ok(0)),
        blob,
        blob,
    );

    shim.args_sizes_get(GUEST, GUEST + 4).expect("sizes");
    assert_eq!(
        u32::from_le_bytes(mem.snapshot(GUEST as u64, 4).try_into().unwrap()),
        2
    );
    assert_eq!(
        u32::from_le_bytes(mem.snapshot(GUEST as u64 + 4, 4).try_into().unwrap()),
        12
    );

    let ptrs = 8192u32;
    let buf = 8320u32;
    shim.args_get(ptrs, buf).expect("args_get");
    let p0 = u32::from_le_bytes(mem.snapshot(ptrs as u64, 4).try_into().unwrap());
    let p1 = u32::from_le_bytes(mem.snapshot(ptrs as u64 + 4, 4).try_into().unwrap());
    assert_eq!(p0, buf);
    assert_eq!(p1, buf + 5, "second string starts after \"prog\\0\"");
    assert_eq!(read_cstr(&mem, p0 as u64), "prog");
    assert_eq!(read_cstr(&mem, p1 as u64), "--flag");

    // environ shares the implementation; check it is wired to the env blob.
    shim.environ_sizes_get(GUEST, GUEST + 4).expect("env sizes");
    assert_eq!(
        u32::from_le_bytes(mem.snapshot(GUEST as u64, 4).try_into().unwrap()),
        2
    );
    shim.environ_get(ptrs, buf).expect("environ_get");
    assert_eq!(read_cstr(&mem, buf as u64), "prog");

    // No syscall is issued for any of these.
    assert!(shim.chan.calls().is_empty());
}

// --------------------------------------------------------------- read / write

#[test]
fn fd_write_and_fd_read_pass_the_guest_iovec_through_to_readv_writev() {
    let mem = memory();
    let shim = shim_ok(&mem, 11);

    shim.fd_write(1, GUEST, 2, GUEST + 64).expect("fd_write");
    let call = shim.chan.only_call();
    assert_eq!(call.nr, Syscall::Writev as u32);
    assert_eq!(&call.args[..3], &[1, GUEST as i64, 2]);
    assert_eq!(
        u32::from_le_bytes(mem.snapshot(GUEST as u64 + 64, 4).try_into().unwrap()),
        11
    );

    let mem = memory();
    let shim = shim_ok(&mem, 7);
    shim.fd_read(0, GUEST, 1, GUEST + 64).expect("fd_read");
    assert_eq!(shim.chan.only_call().nr, Syscall::Readv as u32);
    assert_eq!(
        u32::from_le_bytes(mem.snapshot(GUEST as u64 + 64, 4).try_into().unwrap()),
        7
    );
}

#[test]
fn a_channel_errno_becomes_a_wasi_errno_and_no_output_is_written() {
    let mem = memory();
    mem.write_u32(GUEST as u64 + 64, 0xDEAD_BEEF).unwrap();
    let shim = shim_with(&mem, |_, _| ChannelResponse::err(9)); // EBADF
    assert_eq!(shim.fd_write(1, GUEST, 1, GUEST + 64), Err(WasiErrno::BadF));
    assert_eq!(
        u32::from_le_bytes(mem.snapshot(GUEST as u64 + 64, 4).try_into().unwrap()),
        0xDEAD_BEEF,
        "the output slot must be untouched on failure"
    );
}

#[test]
fn a_result_too_wide_for_the_u32_output_slot_is_eoverflow() {
    let mem = memory();
    let shim = shim_ok(&mem, i64::from(u32::MAX) + 1);
    assert_eq!(
        shim.fd_write(1, GUEST, 1, GUEST + 64),
        Err(WasiErrno::Overflow),
        "a byte count must not be silently truncated"
    );
}

// ------------------------------------------------------------------- pread/pwrite

#[test]
fn fd_pread_carries_the_offset_in_its_own_slot_and_scatters_the_result() {
    let mem = memory();
    // Two iovecs of 4 bytes each in the guest's memory.
    for index in 0..2u64 {
        mem.write_u32(GUEST as u64 + index * 8, 2048 + index as u32 * 4)
            .unwrap();
        mem.write_u32(GUEST as u64 + index * 8 + 4, 4).unwrap();
    }
    let shim = shim_with(&mem, |_, m| {
        m.write(DATA, b"ABCDEFGH").unwrap();
        ChannelResponse::ok(8)
    });

    shim.fd_pread(5, GUEST, 2, 0x1_0000_0000, GUEST + 64)
        .expect("pread");
    let call = shim.chan.only_call();
    assert_eq!(call.nr, Syscall::Pread as u32);
    assert_eq!(call.args[0], 5);
    assert_eq!(call.args[1], DATA as i64);
    assert_eq!(call.args[2], 8, "the total the iovecs can take");
    assert_eq!(
        call.args[3], 0x1_0000_0000,
        "an offset above 2^32 must survive in its own i64 slot"
    );
    assert_eq!(mem.snapshot(2048, 4), b"ABCD".to_vec());
    assert_eq!(mem.snapshot(2052, 4), b"EFGH".to_vec());
    assert_eq!(
        u32::from_le_bytes(mem.snapshot(GUEST as u64 + 64, 4).try_into().unwrap()),
        8
    );
}

#[test]
fn fd_pwrite_gathers_the_iovecs_before_the_syscall() {
    let mem = memory();
    mem.write(2048, b"HELLO").unwrap();
    mem.write(2060, b"WORLD").unwrap();
    mem.write_u32(GUEST as u64, 2048).unwrap();
    mem.write_u32(GUEST as u64 + 4, 5).unwrap();
    mem.write_u32(GUEST as u64 + 8, 2060).unwrap();
    mem.write_u32(GUEST as u64 + 12, 5).unwrap();

    let shim = shim_ok(&mem, 10);
    shim.fd_pwrite(6, GUEST, 2, 42, GUEST + 64).expect("pwrite");
    let call = shim.chan.only_call();
    assert_eq!(call.nr, Syscall::Pwrite as u32);
    assert_eq!(call.args[2], 10, "both iovecs staged contiguously");
    assert_eq!(call.args[3], 42);
    assert_eq!(mem.snapshot(DATA, 10), b"HELLOWORLD".to_vec());
}

// ------------------------------------------------------------------------ seek

#[test]
fn fd_seek_splits_the_offset_into_the_kernels_low_high_words() {
    let mem = memory();
    let shim = shim_ok(&mem, 0x1_2345_6789);
    shim.fd_seek(4, 0x0123_4567_89AB_CDEF, 0, GUEST)
        .expect("seek");
    let call = shim.chan.only_call();
    assert_eq!(call.nr, Syscall::Seek as u32);
    assert_eq!(call.args[0], 4);
    assert_eq!(call.args[1], 0x89AB_CDEFu32 as i64, "low word, unsigned");
    assert_eq!(call.args[2], 0x0123_4567, "high word, signed");
    assert_eq!(call.args[3], seek::SEEK_SET as i64);
    assert_eq!(
        u64::from_le_bytes(mem.snapshot(GUEST as u64, 8).try_into().unwrap()),
        0x1_2345_6789,
        "the i64 result is written whole, not narrowed"
    );
}

#[test]
fn fd_seek_sign_extends_a_negative_offset() {
    let mem = memory();
    let shim = shim_ok(&mem, 0);
    shim.fd_seek(4, -1, 1, GUEST).expect("seek");
    let call = shim.chan.only_call();
    assert_eq!(call.args[1], u32::MAX as i64);
    assert_eq!(call.args[2], -1);
    assert_eq!(call.args[3], seek::SEEK_CUR as i64);
}

#[test]
fn fd_seek_rejects_an_undefined_whence_before_issuing_anything() {
    let mem = memory();
    let shim = shim_ok(&mem, 0);
    assert_eq!(shim.fd_seek(4, 0, 3, GUEST), Err(WasiErrno::Inval));
    assert!(
        shim.chan.calls().is_empty(),
        "an invalid whence must not reach the kernel"
    );
}

#[test]
fn fd_tell_is_a_seek_of_zero_from_the_current_position() {
    let mem = memory();
    let shim = shim_ok(&mem, 4096);
    shim.fd_tell(4, GUEST).expect("tell");
    let call = shim.chan.only_call();
    assert_eq!(call.nr, Syscall::Seek as u32);
    assert_eq!(&call.args[..4], &[4, 0, 0, seek::SEEK_CUR as i64]);
}

// ------------------------------------------------------------ close / renumber

#[test]
fn fd_close_drops_the_preopen_only_after_the_syscall_succeeds() {
    let mem = memory();
    let mut shim = with_root(&mem);
    assert!(shim.preopens().get(3).is_some());
    shim.fd_close(3).expect("close");
    assert!(shim.preopens().get(3).is_none());

    let mem = memory();
    let mut shim = shim_with(&mem, |call, _| {
        if call.nr == Syscall::Openat as u32 {
            ChannelResponse::ok(3)
        } else {
            ChannelResponse::err(9)
        }
    });
    shim.init().unwrap();
    assert_eq!(shim.fd_close(3), Err(WasiErrno::BadF));
    assert!(
        shim.preopens().get(3).is_some(),
        "a failed close must not forget the preopen"
    );
}

#[test]
fn fd_renumber_dup2s_closes_and_moves_the_preopen() {
    let mem = memory();
    let mut shim = with_root(&mem);
    shim.fd_renumber(3, 9).expect("renumber");
    let calls = shim.chan.calls();
    assert_eq!(calls[1].nr, Syscall::Dup2 as u32);
    assert_eq!(&calls[1].args[..2], &[3, 9]);
    assert_eq!(calls[2].nr, Syscall::Close as u32);
    assert_eq!(shim.preopens().get(3), None);
    assert_eq!(shim.preopens().get(9), Some(&b"/"[..]));
}

#[test]
fn fd_renumber_onto_itself_does_not_close_the_fd() {
    let mem = memory();
    let mut shim = shim_ok(&mem, 0);
    shim.fd_renumber(5, 5).expect("renumber");
    let calls = shim.chan.calls();
    assert_eq!(calls.len(), 1, "dup2 only: closing would lose the fd");
    assert_eq!(calls[0].nr, Syscall::Dup2 as u32);
}

// ------------------------------------------------------------------- fdstat

#[test]
fn fd_fdstat_get_combines_fstat_and_fcntl() {
    let mem = memory();
    let shim = shim_with(&mem, |call, m| {
        if call.nr == Syscall::Fstat as u32 {
            m.write_u32(DATA + layout::wasm_stat::ST_MODE as u64, 0o040755)
                .unwrap();
            ChannelResponse::ok(0)
        } else {
            ChannelResponse::ok((flags::O_APPEND | flags::O_NONBLOCK) as i64)
        }
    });
    shim.fd_fdstat_get(3, GUEST).expect("fdstat");
    let calls = shim.chan.calls();
    assert_eq!(calls[0].nr, Syscall::Fstat as u32);
    assert_eq!(calls[1].nr, Syscall::Fcntl as u32);
    assert_eq!(calls[1].args[1], fcntl_cmd::F_GETFL as i64);

    let out = mem.snapshot(GUEST as u64, layout::fdstat::SIZE);
    assert_eq!(out[0], 3, "S_IFDIR maps to WASI directory");
    assert_eq!(out[1], 0, "the byte after filetype is padding");
    assert_eq!(
        u16::from_le_bytes(out[2..4].try_into().unwrap()),
        1 | 4,
        "APPEND | NONBLOCK"
    );
    assert_eq!(
        u64::from_le_bytes(out[8..16].try_into().unwrap()),
        wasi_abi::WASI_RIGHTS_ALL
    );
}

#[test]
fn fd_fdstat_get_survives_a_failing_fcntl() {
    // The filetype is the load-bearing half and is already known, so a
    // failing fcntl reports zero flags rather than failing the call.
    let mem = memory();
    let shim = shim_with(&mem, |call, m| {
        if call.nr == Syscall::Fstat as u32 {
            m.write_u32(DATA + layout::wasm_stat::ST_MODE as u64, 0o100644)
                .unwrap();
            ChannelResponse::ok(0)
        } else {
            ChannelResponse::err(9)
        }
    });
    shim.fd_fdstat_get(3, GUEST).expect("fdstat");
    let out = mem.snapshot(GUEST as u64, layout::fdstat::SIZE);
    assert_eq!(out[0], 4, "regular file");
    assert_eq!(u16::from_le_bytes(out[2..4].try_into().unwrap()), 0);
}

#[test]
fn defect_3_fd_fdstat_set_flags_refuses_synchronised_writes() {
    let mem = memory();
    let shim = shim_ok(&mem, 0);
    // The two bits the kernel really tracks go through.
    shim.fd_fdstat_set_flags(3, 1 | 4).expect("append|nonblock");
    let call = shim.chan.only_call();
    assert_eq!(call.nr, Syscall::Fcntl as u32);
    assert_eq!(call.args[1], fcntl_cmd::F_SETFL as i64);
    assert_eq!(call.args[2], (flags::O_APPEND | flags::O_NONBLOCK) as i64);

    for sync in [2u16, 8, 16] {
        let mem = memory();
        let shim = shim_ok(&mem, 0);
        assert_eq!(
            shim.fd_fdstat_set_flags(3, sync),
            Err(WasiErrno::NotSup),
            "the TypeScript returns ESUCCESS here without doing anything"
        );
        assert!(
            shim.chan.calls().is_empty(),
            "a request that cannot be honored must not reach the kernel"
        );
    }
}

#[test]
fn fd_fdstat_set_rights_is_a_no_op_and_sock_accept_refuses() {
    let mem = memory();
    let shim = shim_ok(&mem, 0);
    // Kandelo does not model rights; a no-op is the correct compatibility
    // behavior, not a stub hiding a gap.
    shim.fd_fdstat_set_rights().expect("no-op");
    shim.fd_advise().expect("advisory");
    assert!(shim.chan.calls().is_empty());
    // accept is genuinely unimplemented and says so.
    assert_eq!(shim.sock_accept(), Err(WasiErrno::NoSys));
}

// ------------------------------------------------------------------- filestat

fn write_stat(m: &FakeMemory, at: u64, mode: u32, size: u64, ctime_nsec: u32, pad: u32) {
    m.write_u32(at + layout::wasm_stat::ST_MODE as u64, mode).unwrap();
    m.write_u64(at + layout::wasm_stat::ST_SIZE as u64, size).unwrap();
    m.write_u64(at + layout::wasm_stat::ST_CTIME_SEC as u64, 1_700_000_002)
        .unwrap();
    m.write_u32(at + layout::wasm_stat::ST_CTIME_NSEC as u64, ctime_nsec)
        .unwrap();
    // The struct's explicit `_pad: u32`, immediately after st_ctime_nsec.
    m.write_u32(at + 84, pad).unwrap();
}

#[test]
fn defect_4_filestat_reads_only_the_nanosecond_field_not_the_padding() {
    let mem = memory();
    let shim = shim_with(&mem, |_, m| {
        write_stat(m, DATA, 0o100644, 4096, 123_456_789, 0xDEAD_BEEF);
        ChannelResponse::ok(0)
    });
    shim.fd_filestat_get(3, GUEST).expect("filestat");
    let out = mem.snapshot(GUEST as u64, layout::filestat::SIZE);
    assert_eq!(out[16], 4, "regular file");
    assert_eq!(&out[17..24], &[0u8; 7], "padding is zeroed");
    assert_eq!(u64::from_le_bytes(out[32..40].try_into().unwrap()), 4096);
    assert_eq!(
        u64::from_le_bytes(out[56..64].try_into().unwrap()),
        1_700_000_002_123_456_789,
        "the TypeScript's u64 read at offset 80 would sweep in 0xDEADBEEF"
    );
}

#[test]
fn fd_filestat_set_size_and_allocate_carry_their_i64_arguments() {
    let mem = memory();
    let shim = shim_ok(&mem, 0);
    shim.fd_filestat_set_size(3, 0x1_0000_0000).expect("truncate");
    let call = shim.chan.only_call();
    assert_eq!(call.nr, Syscall::Ftruncate as u32);
    assert_eq!(call.args[1], 0x1_0000_0000);

    let mem = memory();
    let shim = shim_ok(&mem, 0);
    shim.fd_allocate(3, 100, 200).expect("fallocate");
    let call = shim.chan.only_call();
    assert_eq!(call.nr, extended_syscalls::SYS_FALLOCATE);
    assert_eq!(&call.args[..4], &[3, 0, 100, 200], "(fd, mode, offset, len)");
}

#[test]
fn fd_filestat_set_times_encodes_now_and_omit_sentinels() {
    let mem = memory();
    let shim = shim_ok(&mem, 0);
    // ATIM_NOW (bit 1) and an explicit MTIM (bit 2).
    shim.fd_filestat_set_times(3, 0, 2_000_000_500, 2 | 4)
        .expect("utimens");
    let call = shim.chan.only_call();
    assert_eq!(call.nr, Syscall::Utimensat as u32);
    assert_eq!(call.args[0], 3, "the fd variant passes the fd as dirfd");
    assert_eq!(read_cstr(&mem, call.args[1] as u64), "", "with an empty path");

    let ts = call.args[2] as u64;
    assert_eq!(mem.read_u64(ts).unwrap(), 0);
    assert_eq!(mem.read_u64(ts + 8).unwrap(), 0x3FFF_FFFF, "UTIME_NOW");
    assert_eq!(mem.read_u64(ts + 16).unwrap(), 2, "mtim seconds");
    assert_eq!(mem.read_u64(ts + 24).unwrap(), 500, "mtim nanoseconds");
}

#[test]
fn filestat_set_times_omits_what_the_flags_do_not_select() {
    let mem = memory();
    let shim = shim_ok(&mem, 0);
    shim.fd_filestat_set_times(3, 1, 1, 0).expect("utimens");
    let ts = shim.chan.only_call().args[2] as u64;
    assert_eq!(mem.read_u64(ts + 8).unwrap(), 0x3FFF_FFFE, "UTIME_OMIT");
    assert_eq!(mem.read_u64(ts + 24).unwrap(), 0x3FFF_FFFE, "UTIME_OMIT");
}

// -------------------------------------------------------------- path resolution

#[test]
fn a_relative_path_under_the_root_preopen_becomes_absolute() {
    let mem = memory();
    let shim = with_root(&mem);
    mem.write(GUEST as u64, b"tmp/file.txt").unwrap();
    shim.path_create_directory(3, GUEST, 12).expect("mkdir");
    let call = shim.chan.calls()[1].clone();
    assert_eq!(call.nr, Syscall::Mkdirat as u32);
    assert_eq!(call.args[0], flags::AT_FDCWD as i64);
    assert_eq!(read_cstr(&mem, call.args[1] as u64), "/tmp/file.txt");
    assert_eq!(call.args[2], 0o777);
}

#[test]
fn an_absolute_path_is_not_given_a_second_slash() {
    let mem = memory();
    let shim = with_root(&mem);
    mem.write(GUEST as u64, b"/etc/hosts").unwrap();
    shim.path_unlink_file(3, GUEST, 10).expect("unlink");
    let call = shim.chan.calls()[1].clone();
    assert_eq!(read_cstr(&mem, call.args[1] as u64), "/etc/hosts");
}

#[test]
fn a_non_root_preopen_prefixes_the_path() {
    let mem = memory();
    let mut shim = shim_ok(&mem, 0);
    // Simulate a host that preopened /data at fd 4.
    shim.fd_renumber(4, 4).ok();
    let shim = {
        let mut s = shim_ok(&mem, 0);
        s.init().unwrap();
        s
    };
    // The root preopen is at 3; resolve against it, then check the /-special
    // case does not add a duplicate separator.
    mem.write(GUEST as u64, b"x").unwrap();
    shim.path_remove_directory(3, GUEST, 1).expect("rmdir");
    let call = shim.chan.calls()[1].clone();
    assert_eq!(read_cstr(&mem, call.args[1] as u64), "/x");
    assert_eq!(call.args[2], flags::AT_REMOVEDIR as i64);
}

#[test]
fn an_over_long_path_is_enametoolong_rather_than_a_trap() {
    let mem = memory();
    let shim = with_root(&mem);
    // 4096 is the per-region capacity; ask for more.
    assert_eq!(
        shim.path_create_directory(3, GUEST, 5000),
        Err(WasiErrno::NameTooLong)
    );
    assert_eq!(shim.chan.calls().len(), 1, "only init's open");
}

#[test]
fn rename_and_link_stage_their_two_paths_in_separate_regions() {
    let mem = memory();
    let shim = with_root(&mem);
    mem.write(GUEST as u64, b"old").unwrap();
    mem.write(GUEST as u64 + 16, b"new").unwrap();
    shim.path_rename(3, GUEST, 3, 3, GUEST + 16, 3)
        .expect("rename");
    let call = shim.chan.calls()[1].clone();
    assert_eq!(call.nr, Syscall::Renameat as u32);
    assert_ne!(call.args[1], call.args[3], "the two paths must not overlap");
    assert_eq!(read_cstr(&mem, call.args[1] as u64), "/old");
    assert_eq!(read_cstr(&mem, call.args[3] as u64), "/new");

    let mem = memory();
    let shim = with_root(&mem);
    mem.write(GUEST as u64, b"a").unwrap();
    mem.write(GUEST as u64 + 16, b"b").unwrap();
    shim.path_link(3, 0, GUEST, 1, 3, GUEST + 16, 1).expect("link");
    let call = shim.chan.calls()[1].clone();
    assert_eq!(call.nr, Syscall::Linkat as u32);
    assert_eq!(read_cstr(&mem, call.args[1] as u64), "/a");
    assert_eq!(read_cstr(&mem, call.args[3] as u64), "/b");
}

#[test]
fn symlink_uses_its_target_verbatim_and_resolves_only_the_link_path() {
    let mem = memory();
    let shim = with_root(&mem);
    mem.write(GUEST as u64, b"../relative/target").unwrap();
    mem.write(GUEST as u64 + 32, b"link").unwrap();
    shim.path_symlink(GUEST, 18, 3, GUEST + 32, 4)
        .expect("symlink");
    let call = shim.chan.calls()[1].clone();
    assert_eq!(call.nr, Syscall::Symlinkat as u32);
    assert_eq!(
        read_cstr(&mem, call.args[0] as u64),
        "../relative/target",
        "the target is the link's CONTENTS, not a path to resolve"
    );
    assert_eq!(call.args[1], flags::AT_FDCWD as i64);
    assert_eq!(read_cstr(&mem, call.args[2] as u64), "/link");
}

#[test]
fn readlink_copies_the_kernels_answer_into_the_guest_buffer() {
    let mem = memory();
    let shim = shim_with(&mem, |call, m| {
        if call.nr == Syscall::Openat as u32 {
            return ChannelResponse::ok(3);
        }
        m.write(call.args[2] as u64, b"/target").unwrap();
        ChannelResponse::ok(7)
    });
    let mut shim = shim;
    shim.init().unwrap();
    mem.write(GUEST as u64, b"link").unwrap();
    shim.path_readlink(3, GUEST, 4, 2048, 64, GUEST + 64)
        .expect("readlink");
    assert_eq!(mem.snapshot(2048, 7), b"/target".to_vec());
    assert_eq!(
        u32::from_le_bytes(mem.snapshot(GUEST as u64 + 64, 4).try_into().unwrap()),
        7
    );
}

// ------------------------------------------------------------------- path_open

#[test]
fn path_open_maps_oflags_and_writes_the_new_fd() {
    let mem = memory();
    let shim = shim_with(&mem, |call, _| {
        ChannelResponse::ok(if call.args[2] & flags::O_DIRECTORY as i64 != 0 {
            3
        } else {
            7
        })
    });
    let mut shim = shim;
    shim.init().unwrap();
    mem.write(GUEST as u64, b"f").unwrap();
    // CREAT | TRUNC with the APPEND fdflag.
    shim.path_open(3, 0, GUEST, 1, 1 | 8, 0, 0, 1, GUEST + 64)
        .expect("open");
    let call = shim.chan.calls()[1].clone();
    assert_eq!(call.nr, Syscall::Openat as u32);
    let posix = call.args[2] as u32;
    assert_ne!(posix & flags::O_CREAT, 0);
    assert_ne!(posix & flags::O_TRUNC, 0);
    assert_ne!(posix & flags::O_APPEND, 0);
    assert_ne!(posix & flags::O_RDWR, 0);
    assert_eq!(call.args[3], 0o666);
    assert_eq!(
        u32::from_le_bytes(mem.snapshot(GUEST as u64 + 64, 4).try_into().unwrap()),
        7
    );
}

#[test]
fn path_open_of_a_directory_opens_read_only() {
    let mem = memory();
    let shim = {
        let mut s = shim_ok(&mem, 3);
        s.init().unwrap();
        s
    };
    mem.write(GUEST as u64, b"d").unwrap();
    shim.path_open(3, 0, GUEST, 1, 2, 0, 0, 0, GUEST + 64)
        .expect("open dir");
    let posix = shim.chan.calls()[1].args[2] as u32;
    assert_ne!(posix & flags::O_DIRECTORY, 0);
    assert_eq!(posix & flags::O_RDWR, 0, "a directory must not open RDWR");
}

#[test]
fn path_open_retries_read_only_when_read_write_is_refused() {
    let mem = memory();
    let shim = {
        let mut s = shim_with(&mem, |call, _| {
            if call.nr != Syscall::Openat as u32 {
                return ChannelResponse::ok(0);
            }
            if call.args[2] as u32 & flags::O_RDWR != 0 && call.args[1] != 0 {
                ChannelResponse::err(21) // EISDIR
            } else {
                ChannelResponse::ok(9)
            }
        });
        s.init().unwrap();
        s
    };
    mem.write(GUEST as u64, b"ro").unwrap();
    shim.path_open(3, 0, GUEST, 2, 0, 0, 0, 0, GUEST + 64)
        .expect("retry succeeds");
    let calls = shim.chan.calls();
    assert_eq!(calls.len(), 3, "init, the RDWR attempt, then the retry");
    assert_eq!(calls[2].args[2] as u32 & flags::O_ACCMODE, flags::O_RDONLY);
}

#[test]
fn path_open_does_not_retry_when_the_guest_asked_to_create() {
    let mem = memory();
    let shim = {
        let mut s = shim_with(&mem, |call, _| {
            if call.nr == Syscall::Openat as u32 && call.args[2] as u32 & flags::O_CREAT != 0 {
                ChannelResponse::err(13) // EACCES
            } else {
                ChannelResponse::ok(3)
            }
        });
        s.init().unwrap();
        s
    };
    mem.write(GUEST as u64, b"n").unwrap();
    assert_eq!(
        shim.path_open(3, 0, GUEST, 1, 1, 0, 0, 0, GUEST + 64),
        Err(WasiErrno::Acces)
    );
    assert_eq!(
        shim.chan.calls().len(),
        2,
        "retrying a create read-only would create nothing and mislead"
    );
}

#[test]
fn defect_2_path_filestat_get_honors_lookupflags() {
    // lookupflags == 0 is WASI's lstat. The TypeScript passes a literal 0 to
    // fstatat and always follows the link.
    let mem = memory();
    let shim = {
        let mut s = shim_with(&mem, |_, m| {
            write_stat(m, DATA + 4096, 0o120777, 11, 0, 0);
            ChannelResponse::ok(0)
        });
        s.init().unwrap();
        s
    };
    mem.write(GUEST as u64, b"l").unwrap();

    shim.path_filestat_get(3, 0, GUEST, 1, GUEST + 64)
        .expect("lstat");
    assert_eq!(
        shim.chan.calls()[1].args[3],
        flags::AT_SYMLINK_NOFOLLOW as i64,
        "lookupflags 0 must NOT follow the symlink"
    );
    assert_eq!(
        mem.snapshot(GUEST as u64 + 64 + 16, 1),
        std::vec![7],
        "and the guest sees a symlink filetype"
    );

    shim.path_filestat_get(3, 1, GUEST, 1, GUEST + 64)
        .expect("stat");
    assert_eq!(
        shim.chan.calls()[2].args[3],
        0,
        "SYMLINK_FOLLOW needs no at-flag"
    );
}

#[test]
fn defect_2_path_filestat_set_times_honors_lookupflags_too() {
    let mem = memory();
    let shim = {
        let mut s = shim_ok(&mem, 0);
        s.init().unwrap();
        s
    };
    mem.write(GUEST as u64, b"l").unwrap();
    shim.path_filestat_set_times(3, 0, GUEST, 1, 0, 0, 0)
        .expect("utimens");
    assert_eq!(
        shim.chan.calls()[1].args[3],
        flags::AT_SYMLINK_NOFOLLOW as i64
    );
}

// ------------------------------------------------------------------- readdir

/// Build one Linux `dirent64` record.
fn dirent(ino: u64, off: i64, d_type: u8, name: &str) -> std::vec::Vec<u8> {
    let reclen = (layout::linux_dirent64::NAME + name.len() + 1).next_multiple_of(8);
    let mut buf = std::vec![0u8; reclen];
    buf[0..8].copy_from_slice(&ino.to_le_bytes());
    buf[8..16].copy_from_slice(&off.to_le_bytes());
    buf[16..18].copy_from_slice(&(reclen as u16).to_le_bytes());
    buf[18] = d_type;
    buf[19..19 + name.len()].copy_from_slice(name.as_bytes());
    buf
}

#[test]
fn fd_readdir_emits_the_next_entrys_offset_as_the_cookie() {
    let mem = memory();
    let mut batch = std::vec::Vec::new();
    batch.extend(dirent(1, 10, 4, "."));
    batch.extend(dirent(2, 20, 4, ".."));
    batch.extend(dirent(3, 30, 8, "a.txt"));
    let batch_len = batch.len();

    let shim = shim_with(&mem, move |call, m| {
        if call.nr != Syscall::Getdents64 as u32 {
            return ChannelResponse::ok(0);
        }
        // Serve the batch once, then report end-of-directory.
        if m.read_u8(DATA).unwrap() == 0 {
            m.write(DATA, &batch).unwrap();
            ChannelResponse::ok(batch_len as i64)
        } else {
            ChannelResponse::ok(0)
        }
    });

    shim.fd_readdir(3, 4096, 4096, 0, GUEST).expect("readdir");
    let written =
        u32::from_le_bytes(mem.snapshot(GUEST as u64, 4).try_into().unwrap()) as usize;
    assert!(written > 0);

    // First dirent: d_next must be the Linux d_off of that entry, which is
    // where a resume should seek to.
    let out = mem.snapshot(4096, written);
    assert_eq!(u64::from_le_bytes(out[0..8].try_into().unwrap()), 10);
    assert_eq!(u64::from_le_bytes(out[8..16].try_into().unwrap()), 1, "d_ino");
    assert_eq!(u32::from_le_bytes(out[16..20].try_into().unwrap()), 1, "namlen");
    assert_eq!(out[20], 3, "DT_DIR -> WASI directory");
    assert_eq!(&out[24..25], b".");
}

#[test]
fn defect_5_fd_readdir_resumes_by_seeking_to_the_cookie() {
    // The TypeScript issues a fresh getdents64 and then skips `cookie`
    // entries of whatever came back -- but getdents64 has already advanced
    // the fd, so the second call reads the NEXT batch and discards entries
    // from it. Anything past one batch is silently lost.
    let mem = memory();
    let shim = shim_with(&mem, |call, _| {
        if call.nr == Syscall::Getdents64 as u32 {
            ChannelResponse::ok(0)
        } else {
            ChannelResponse::ok(0)
        }
    });
    shim.fd_readdir(3, 4096, 4096, 30, GUEST).expect("readdir");
    let calls = shim.chan.calls();
    assert_eq!(
        calls[0].nr,
        Syscall::Seek as u32,
        "a non-zero cookie must seek the directory before reading"
    );
    assert_eq!(calls[0].args[1], 30, "low word of the cookie");
    assert_eq!(calls[0].args[3], seek::SEEK_SET as i64);
    assert_eq!(calls[1].nr, Syscall::Getdents64 as u32);
}

#[test]
fn defect_5_fd_readdir_reads_across_batches_until_the_buffer_is_full() {
    let mem = memory();
    let batches = core::cell::Cell::new(0u32);
    let shim = shim_with(&mem, move |call, m| {
        if call.nr != Syscall::Getdents64 as u32 {
            return ChannelResponse::ok(0);
        }
        let n = batches.get();
        batches.set(n + 1);
        match n {
            0 => {
                let b = dirent(1, 10, 8, "first");
                let len = b.len();
                m.write(DATA, &b).unwrap();
                ChannelResponse::ok(len as i64)
            }
            1 => {
                let b = dirent(2, 20, 8, "second");
                let len = b.len();
                m.write(DATA, &b).unwrap();
                ChannelResponse::ok(len as i64)
            }
            _ => ChannelResponse::ok(0),
        }
    });

    shim.fd_readdir(3, 4096, 4096, 0, GUEST).expect("readdir");
    let getdents = shim
        .chan
        .calls()
        .into_iter()
        .filter(|c| c.nr == Syscall::Getdents64 as u32)
        .count();
    assert_eq!(
        getdents, 3,
        "two batches plus the empty one that ends the directory"
    );

    let written =
        u32::from_le_bytes(mem.snapshot(GUEST as u64, 4).try_into().unwrap()) as usize;
    let out = mem.snapshot(4096, written);
    // Both entries are present: the TypeScript would have lost the second.
    assert_eq!(&out[24..29], b"first");
    let second = layout::dirent::HEADER_SIZE + 5;
    assert_eq!(u64::from_le_bytes(out[second..second + 8].try_into().unwrap()), 20);
    assert_eq!(&out[second + 24..second + 30], b"second");
}

#[test]
fn fd_readdir_stops_cleanly_when_the_guest_buffer_fills() {
    let mem = memory();
    let shim = shim_with(&mem, |call, m| {
        if call.nr != Syscall::Getdents64 as u32 {
            return ChannelResponse::ok(0);
        }
        let b = dirent(1, 10, 8, "name");
        let len = b.len();
        m.write(DATA, &b).unwrap();
        ChannelResponse::ok(len as i64)
    });
    // Room for less than one header.
    shim.fd_readdir(3, 4096, 8, 0, GUEST).expect("readdir");
    let written = u32::from_le_bytes(mem.snapshot(GUEST as u64, 4).try_into().unwrap());
    assert_eq!(written, 8, "a truncated final entry, not an overrun");
}

// ----------------------------------------------------------------- poll_oneoff

fn write_subscription(m: &FakeMemory, at: u64, userdata: u64, tag: u8, fd: u32, timeout: u64) {
    m.write_u64(at, userdata).unwrap();
    m.write_u8(at + layout::subscription::TAG as u64, tag).unwrap();
    m.write_u32(at + layout::subscription::FD as u64, fd).unwrap();
    m.write_u64(at + layout::subscription::CLOCK_TIMEOUT as u64, timeout)
        .unwrap();
}

#[test]
fn poll_oneoff_with_no_subscriptions_reports_no_events() {
    let mem = memory();
    let shim = shim_ok(&mem, 0);
    shim.poll_oneoff(GUEST, GUEST + 256, 0, GUEST + 512)
        .expect("poll");
    assert_eq!(
        u32::from_le_bytes(mem.snapshot(GUEST as u64 + 512, 4).try_into().unwrap()),
        0
    );
    assert!(shim.chan.calls().is_empty());
}

#[test]
fn defect_1_poll_oneoff_rejects_an_undefined_tag_before_any_syscall() {
    // The TypeScript treats every non-FD_READ tag as a write subscription,
    // so a malformed tag silently polls for writability.
    for tag in [3u8, 4, 200, 255] {
        let mem = memory();
        let shim = shim_ok(&mem, 0);
        write_subscription(&mem, GUEST as u64, 1, tag, 5, 0);
        assert_eq!(
            shim.poll_oneoff(GUEST, GUEST + 256, 1, GUEST + 512),
            Err(WasiErrno::Inval),
            "tag {tag} must be rejected"
        );
        assert!(shim.chan.calls().is_empty());
    }
}

#[test]
fn poll_oneoff_distinguishes_read_from_write_subscriptions() {
    let mem = memory();
    write_subscription(&mem, GUEST as u64, 0xAA, 1, 5, 0); // FD_READ
    write_subscription(&mem, GUEST as u64 + 48, 0xBB, 2, 6, 0); // FD_WRITE
    let shim = shim_ok(&mem, 0);
    shim.poll_oneoff(GUEST, GUEST + 256, 2, GUEST + 512)
        .expect("poll");
    let call = shim.chan.only_call();
    assert_eq!(call.nr, Syscall::Poll as u32);
    assert_eq!(call.args[1], 2);
    let base = call.args[0] as u64;
    let size = layout::wasm_poll_fd::SIZE as u64;
    assert_eq!(mem.read_u32(base + layout::wasm_poll_fd::FD as u64).unwrap(), 5);
    assert_eq!(
        mem.read_u16(base + layout::wasm_poll_fd::EVENTS as u64).unwrap(),
        1,
        "POLLIN"
    );
    assert_eq!(
        mem.read_u32(base + size + layout::wasm_poll_fd::FD as u64).unwrap(),
        6
    );
    assert_eq!(
        mem.read_u16(base + size + layout::wasm_poll_fd::EVENTS as u64).unwrap(),
        4,
        "POLLOUT -- the TypeScript reaches this by falling through"
    );
}

#[test]
fn poll_oneoff_reports_ready_fds_with_their_own_userdata() {
    let mem = memory();
    write_subscription(&mem, GUEST as u64, 0xAA, 1, 5, 0);
    write_subscription(&mem, GUEST as u64 + 48, 0xBB, 2, 6, 0);
    let shim = shim_with(&mem, |call, m| {
        if call.nr == Syscall::Poll as u32 {
            // Only the SECOND fd is ready.
            let base = call.args[0] as u64 + layout::wasm_poll_fd::SIZE as u64;
            m.write_u16(base + layout::wasm_poll_fd::REVENTS as u64, 4)
                .unwrap();
            return ChannelResponse::ok(1);
        }
        ChannelResponse::ok(0)
    });
    shim.poll_oneoff(GUEST, GUEST + 256, 2, GUEST + 512)
        .expect("poll");
    assert_eq!(
        u32::from_le_bytes(mem.snapshot(GUEST as u64 + 512, 4).try_into().unwrap()),
        1
    );
    let ev = mem.snapshot(GUEST as u64 + 256, layout::event::SIZE);
    assert_eq!(
        u64::from_le_bytes(ev[0..8].try_into().unwrap()),
        0xBB,
        "the event must carry the READY subscription's userdata"
    );
    assert_eq!(ev[10], 2, "and its tag");
}

#[test]
fn poll_oneoff_reports_pollerr_as_eio() {
    let mem = memory();
    write_subscription(&mem, GUEST as u64, 0xAA, 1, 5, 0);
    let shim = shim_with(&mem, |call, m| {
        if call.nr == Syscall::Poll as u32 {
            m.write_u16(
                call.args[0] as u64 + layout::wasm_poll_fd::REVENTS as u64,
                8, // POLLERR
            )
            .unwrap();
            return ChannelResponse::ok(1);
        }
        ChannelResponse::ok(0)
    });
    shim.poll_oneoff(GUEST, GUEST + 256, 1, GUEST + 512).unwrap();
    let ev = mem.snapshot(GUEST as u64 + 256, layout::event::SIZE);
    assert_eq!(
        u16::from_le_bytes(ev[8..10].try_into().unwrap()),
        WasiErrno::Io.as_u16()
    );
}

#[test]
fn poll_oneoff_reports_the_clock_subscription_when_nothing_became_ready() {
    let mem = memory();
    // A clock subscription with a 5 ms relative timeout.
    write_subscription(&mem, GUEST as u64, 0xC10C, 0, 0, 5_000_000);
    let shim = shim_ok(&mem, 0);
    shim.poll_oneoff(GUEST, GUEST + 256, 1, GUEST + 512)
        .expect("poll");
    let call = shim.chan.only_call();
    assert_eq!(call.nr, Syscall::Poll as u32);
    assert_eq!(call.args[1], 0, "no pollfds");
    assert_eq!(call.args[2], 5, "the timeout in milliseconds");

    assert_eq!(
        u32::from_le_bytes(mem.snapshot(GUEST as u64 + 512, 4).try_into().unwrap()),
        1
    );
    let ev = mem.snapshot(GUEST as u64 + 256, layout::event::SIZE);
    assert_eq!(u64::from_le_bytes(ev[0..8].try_into().unwrap()), 0xC10C);
    assert_eq!(ev[10], 0, "EVENTTYPE_CLOCK");
}

#[test]
fn poll_oneoff_converts_an_absolute_deadline_into_a_relative_timeout() {
    let mem = memory();
    write_subscription(&mem, GUEST as u64, 1, 0, 0, 10_000_000_000);
    mem.write_u16(
        GUEST as u64 + layout::subscription::CLOCK_FLAGS as u64,
        1, // SUBSCRIPTION_CLOCK_ABSTIME
    )
    .unwrap();
    let shim = shim_with(&mem, |call, m| {
        if call.nr == Syscall::ClockGettime as u32 {
            // "Now" is 9 seconds, so 1 second remains.
            m.write_u64(call.args[1] as u64, 9).unwrap();
            m.write_u64(call.args[1] as u64 + 8, 0).unwrap();
        }
        ChannelResponse::ok(0)
    });
    shim.poll_oneoff(GUEST, GUEST + 256, 1, GUEST + 512)
        .expect("poll");
    let poll = shim
        .chan
        .calls()
        .into_iter()
        .find(|c| c.nr == Syscall::Poll as u32)
        .expect("poll issued");
    assert_eq!(poll.args[2], 1000, "10s deadline minus a 9s now");
}

#[test]
fn poll_oneoff_treats_eintr_as_a_short_wait_not_a_failure() {
    let mem = memory();
    write_subscription(&mem, GUEST as u64, 1, 1, 5, 0);
    let shim = shim_with(&mem, |call, _| {
        if call.nr == Syscall::Poll as u32 {
            ChannelResponse::err(4) // EINTR
        } else {
            ChannelResponse::ok(0)
        }
    });
    shim.poll_oneoff(GUEST, GUEST + 256, 1, GUEST + 512)
        .expect("EINTR is not a poll failure");
}

// ------------------------------------------------------- random / clock / proc

#[test]
fn random_get_chunks_and_copies_each_chunk_into_place() {
    let mem = memory();
    let shim = shim_with(&mem, |call, m| {
        let len = call.args[1] as usize;
        m.write(call.args[0] as u64, &std::vec![0x5A; len]).unwrap();
        ChannelResponse::ok(len as i64)
    });
    shim.random_get(2048, 32).expect("random");
    let call = shim.chan.only_call();
    assert_eq!(call.nr, extended_syscalls::SYS_GETRANDOM);
    assert_eq!(call.args[1], 32);
    assert_eq!(mem.snapshot(2048, 32), std::vec![0x5A; 32]);
}

#[test]
fn random_get_fails_rather_than_spinning_on_zero_progress() {
    // The TypeScript's `while (offset < bufLen)` loop never terminates if the
    // kernel keeps returning 0.
    let mem = memory();
    let shim = shim_ok(&mem, 0);
    assert_eq!(shim.random_get(2048, 32), Err(WasiErrno::Io));
}

#[test]
fn clock_time_get_folds_the_timespec_into_nanoseconds() {
    let mem = memory();
    let shim = shim_with(&mem, |call, m| {
        m.write_u64(call.args[1] as u64, 1_700_000_000).unwrap();
        m.write_u64(call.args[1] as u64 + 8, 123_456_789).unwrap();
        ChannelResponse::ok(0)
    });
    shim.clock_time_get(1, 0, GUEST).expect("clock");
    let call = shim.chan.only_call();
    assert_eq!(call.nr, Syscall::ClockGettime as u32);
    assert_eq!(call.args[0], 1, "MONOTONIC maps straight through");
    assert_eq!(
        u64::from_le_bytes(mem.snapshot(GUEST as u64, 8).try_into().unwrap()),
        1_700_000_000_123_456_789
    );
}

#[test]
fn an_undefined_clock_still_silently_becomes_realtime() {
    // Bug-compatible on purpose: this is the unchartered sixth defect, left
    // for a maintainer decision rather than changed here.
    let mem = memory();
    let shim = shim_with(&mem, |_, _| ChannelResponse::ok(0));
    shim.clock_time_get(99, 0, GUEST).expect("clock");
    assert_eq!(shim.chan.only_call().args[0], 0, "CLOCK_REALTIME");
}

#[test]
fn clock_res_get_uses_clock_getres() {
    let mem = memory();
    let shim = shim_with(&mem, |call, m| {
        m.write_u64(call.args[1] as u64, 0).unwrap();
        m.write_u64(call.args[1] as u64 + 8, 1000).unwrap();
        ChannelResponse::ok(0)
    });
    shim.clock_res_get(0, GUEST).expect("res");
    assert_eq!(shim.chan.only_call().nr, Syscall::ClockGetres as u32);
    assert_eq!(
        u64::from_le_bytes(mem.snapshot(GUEST as u64, 8).try_into().unwrap()),
        1000
    );
}

#[test]
fn proc_raise_kills_this_process() {
    let mem = memory();
    let shim = shim_with(&mem, |call, _| {
        if call.nr == Syscall::Getpid as u32 {
            ChannelResponse::ok(1234)
        } else {
            ChannelResponse::ok(0)
        }
    });
    shim.proc_raise(9).expect("raise");
    let calls = shim.chan.calls();
    assert_eq!(calls[0].nr, Syscall::Getpid as u32);
    assert_eq!(calls[1].nr, Syscall::Kill as u32);
    assert_eq!(&calls[1].args[..2], &[1234, 9]);
}

#[test]
fn proc_exit_issues_sys_exit() {
    let mem = memory();
    let shim = shim_ok(&mem, 0);
    shim.proc_exit(3);
    let call = shim.chan.only_call();
    assert_eq!(call.nr, Syscall::Exit as u32);
    assert_eq!(call.args[0], 3);
}

#[test]
fn sched_yield_shutdown_and_sync_map_straight_through() {
    let mem = memory();
    let shim = shim_ok(&mem, 0);
    shim.sched_yield().expect("yield");
    assert_eq!(shim.chan.only_call().nr, extended_syscalls::SYS_SCHED_YIELD);

    let mem = memory();
    let shim = shim_ok(&mem, 0);
    shim.sock_shutdown(4, 2).expect("shutdown");
    let call = shim.chan.only_call();
    assert_eq!(call.nr, Syscall::Shutdown as u32);
    assert_eq!(&call.args[..2], &[4, 2], "WASI sdflags match SHUT_*");

    let mem = memory();
    let shim = shim_ok(&mem, 0);
    shim.fd_sync(4).expect("sync");
    assert_eq!(shim.chan.only_call().nr, Syscall::Fsync as u32);

    let mem = memory();
    let shim = shim_ok(&mem, 0);
    shim.fd_datasync(4).expect("datasync");
    assert_eq!(shim.chan.only_call().nr, Syscall::Fdatasync as u32);
}

// ------------------------------------------------------------------- sockets

#[test]
fn sock_send_gathers_and_sock_recv_scatters() {
    let mem = memory();
    mem.write(2048, b"payload").unwrap();
    mem.write_u32(GUEST as u64, 2048).unwrap();
    mem.write_u32(GUEST as u64 + 4, 7).unwrap();
    let shim = shim_ok(&mem, 7);
    shim.sock_send(4, GUEST, 1, 0, GUEST + 64).expect("send");
    let call = shim.chan.only_call();
    assert_eq!(call.nr, Syscall::Sendto as u32);
    assert_eq!(call.args[2], 7);
    assert_eq!(mem.snapshot(DATA, 7), b"payload".to_vec());

    let mem = memory();
    mem.write_u32(GUEST as u64, 2048).unwrap();
    mem.write_u32(GUEST as u64 + 4, 16).unwrap();
    let shim = shim_with(&mem, |_, m| {
        m.write(DATA, b"incoming").unwrap();
        ChannelResponse::ok(8)
    });
    shim.sock_recv(4, GUEST, 1, 0, GUEST + 64, GUEST + 68)
        .expect("recv");
    assert_eq!(shim.chan.only_call().nr, Syscall::Recvfrom as u32);
    assert_eq!(mem.snapshot(2048, 8), b"incoming".to_vec());
    assert_eq!(
        u32::from_le_bytes(mem.snapshot(GUEST as u64 + 64, 4).try_into().unwrap()),
        8
    );
    assert_eq!(
        u16::from_le_bytes(mem.snapshot(GUEST as u64 + 68, 2).try_into().unwrap()),
        0,
        "ro_flags"
    );
}

// -------------------------------------------------------------------- EFAULT

#[test]
fn a_guest_pointer_past_the_end_of_memory_is_efault_not_a_panic() {
    let mem = memory();
    let shim = shim_ok(&mem, 0);
    let past_end = (MEM_SIZE as u32) - 2;
    assert_eq!(shim.fd_tell(3, past_end), Err(WasiErrno::Fault));
    assert_eq!(
        shim.args_sizes_get(past_end, past_end),
        Err(WasiErrno::Fault)
    );
}
