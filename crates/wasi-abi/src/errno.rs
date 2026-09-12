//! WASI Preview 1 errno values, and the Linux -> WASI translation table.
//!
//! Ported from the table at `host/src/wasi-shim.ts:229-338`. The numeric
//! values are fixed by the WASI Preview 1 specification and are a *guest* ABI,
//! not a Kandelo ABI -- nothing here appears in `abi/snapshot.json`.

use wasm_posix_shared::Errno;

/// A WASI Preview 1 errno.
///
/// An enum rather than a newtype over `u16` so an invalid value cannot be
/// constructed: every WASI call returns one of exactly these, and the set is
/// closed by the specification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum WasiErrno {
    Success = 0,
    TooBig = 1,
    Acces = 2,
    AddrInUse = 3,
    AddrNotAvail = 4,
    AfNoSupport = 5,
    Again = 6,
    Already = 7,
    BadF = 8,
    BadMsg = 9,
    Busy = 10,
    Canceled = 11,
    Child = 12,
    ConnAborted = 13,
    ConnRefused = 14,
    ConnReset = 15,
    DeadLk = 16,
    DestAddrReq = 17,
    Dom = 18,
    DQuot = 19,
    Exist = 20,
    Fault = 21,
    FBig = 22,
    HostUnreach = 23,
    IdRm = 24,
    IlSeq = 25,
    InProgress = 26,
    Intr = 27,
    Inval = 28,
    Io = 29,
    IsConn = 30,
    IsDir = 31,
    Loop = 32,
    MFile = 33,
    MLink = 34,
    MsgSize = 35,
    MultiHop = 36,
    NameTooLong = 37,
    NetDown = 38,
    NetReset = 39,
    NetUnreach = 40,
    NFile = 41,
    NoBufs = 42,
    NoDev = 43,
    NoEnt = 44,
    NoExec = 45,
    NoLck = 46,
    NoLink = 47,
    NoMem = 48,
    NoMsg = 49,
    NoProtoOpt = 50,
    NoSpc = 51,
    NoSys = 52,
    NotConn = 53,
    NotDir = 54,
    NotEmpty = 55,
    NotRecoverable = 56,
    NotSock = 57,
    NotSup = 58,
    NoTty = 59,
    NxIo = 60,
    Overflow = 61,
    OwnerDead = 62,
    Perm = 63,
    Pipe = 64,
    Proto = 65,
    ProtoNoSupport = 66,
    Prototype = 67,
    Range = 68,
    RoFs = 69,
    SPipe = 70,
    Srch = 71,
    Stale = 72,
    TimedOut = 73,
    TxtBsy = 74,
    XDev = 75,
    NotCapable = 76,
}

impl WasiErrno {
    /// The value a WASI entry point returns, as the wasm `i32` the guest sees.
    #[inline]
    pub const fn as_i32(self) -> i32 {
        self as u16 as i32
    }

    #[inline]
    pub const fn as_u16(self) -> u16 {
        self as u16
    }
}

/// Translate a Linux (musl) errno into a WASI errno.
///
/// Mirrors `translateLinuxErrno` (`host/src/wasi-shim.ts:371`), including its
/// fallback: an errno with no WASI counterpart becomes `Io`. WASI Preview 1
/// has no "unknown error" value, so there is nothing more honest to return --
/// the alternative would be inventing a code the guest cannot interpret.
///
/// The `match` is written over the raw number rather than over
/// [`wasm_posix_shared::Errno`] because the kernel can hand back any value the
/// host platform produced, including ones with no `Errno` variant. Every value
/// that *does* have a variant is covered; see [`translate_errno`] for the
/// typed entry point.
pub const fn translate_linux_errno(linux_errno: u32) -> WasiErrno {
    match linux_errno {
        0 => WasiErrno::Success,
        1 => WasiErrno::Perm,
        2 => WasiErrno::NoEnt,
        3 => WasiErrno::Srch,
        4 => WasiErrno::Intr,
        5 => WasiErrno::Io,
        6 => WasiErrno::NxIo,
        7 => WasiErrno::TooBig,
        8 => WasiErrno::NoExec,
        9 => WasiErrno::BadF,
        10 => WasiErrno::Child,
        // EAGAIN and EWOULDBLOCK share value 11 on Linux.
        11 => WasiErrno::Again,
        12 => WasiErrno::NoMem,
        13 => WasiErrno::Acces,
        14 => WasiErrno::Fault,
        16 => WasiErrno::Busy,
        17 => WasiErrno::Exist,
        18 => WasiErrno::XDev,
        19 => WasiErrno::NoDev,
        20 => WasiErrno::NotDir,
        21 => WasiErrno::IsDir,
        22 => WasiErrno::Inval,
        23 => WasiErrno::NFile,
        24 => WasiErrno::MFile,
        25 => WasiErrno::NoTty,
        26 => WasiErrno::TxtBsy,
        27 => WasiErrno::FBig,
        28 => WasiErrno::NoSpc,
        29 => WasiErrno::SPipe,
        30 => WasiErrno::RoFs,
        31 => WasiErrno::MLink,
        32 => WasiErrno::Pipe,
        33 => WasiErrno::Dom,
        34 => WasiErrno::Range,
        35 => WasiErrno::DeadLk,
        36 => WasiErrno::NameTooLong,
        37 => WasiErrno::NoLck,
        38 => WasiErrno::NoSys,
        39 => WasiErrno::NotEmpty,
        40 => WasiErrno::Loop,
        42 => WasiErrno::NoMsg,
        43 => WasiErrno::IdRm,
        // ENOSTR / ENODATA / ETIME have no WASI counterpart; the shim has
        // always folded them onto the nearest available value.
        60 => WasiErrno::NotSup,
        61 => WasiErrno::NotSup,
        62 => WasiErrno::TimedOut,
        67 => WasiErrno::NoLink,
        71 => WasiErrno::Proto,
        72 => WasiErrno::MultiHop,
        74 => WasiErrno::BadMsg,
        75 => WasiErrno::Overflow,
        84 => WasiErrno::IlSeq,
        88 => WasiErrno::NotSock,
        89 => WasiErrno::DestAddrReq,
        90 => WasiErrno::MsgSize,
        91 => WasiErrno::Prototype,
        92 => WasiErrno::NoProtoOpt,
        93 => WasiErrno::ProtoNoSupport,
        95 => WasiErrno::NotSup,
        97 => WasiErrno::AfNoSupport,
        98 => WasiErrno::AddrInUse,
        99 => WasiErrno::AddrNotAvail,
        100 => WasiErrno::NetDown,
        101 => WasiErrno::NetUnreach,
        102 => WasiErrno::NetReset,
        103 => WasiErrno::ConnAborted,
        104 => WasiErrno::ConnReset,
        105 => WasiErrno::NoBufs,
        106 => WasiErrno::IsConn,
        107 => WasiErrno::NotConn,
        110 => WasiErrno::TimedOut,
        111 => WasiErrno::ConnRefused,
        113 => WasiErrno::HostUnreach,
        114 => WasiErrno::Already,
        115 => WasiErrno::InProgress,
        116 => WasiErrno::Stale,
        122 => WasiErrno::DQuot,
        125 => WasiErrno::Canceled,
        130 => WasiErrno::OwnerDead,
        131 => WasiErrno::NotRecoverable,
        _ => WasiErrno::Io,
    }
}

/// Typed convenience wrapper over [`translate_linux_errno`].
#[inline]
pub const fn translate_errno(errno: Errno) -> WasiErrno {
    translate_linux_errno(errno as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_is_zero() {
        assert_eq!(translate_linux_errno(0), WasiErrno::Success);
        assert_eq!(WasiErrno::Success.as_i32(), 0);
    }

    #[test]
    fn unmapped_values_fall_back_to_io() {
        // 15 and 41 are gaps in the Linux table; 200 is past the end.
        for probe in [15u32, 41, 200, 4096, u32::MAX] {
            assert_eq!(translate_linux_errno(probe), WasiErrno::Io);
        }
    }

    #[test]
    fn every_typed_errno_translates() {
        // Every `Errno` variant must land somewhere. ESHUTDOWN(108) has no
        // WASI counterpart and is expected to fall back to Io; it is called
        // out here so a future change to the table is a deliberate one.
        assert_eq!(translate_errno(Errno::ESHUTDOWN), WasiErrno::Io);
        assert_eq!(translate_errno(Errno::EPERM), WasiErrno::Perm);
        assert_eq!(translate_errno(Errno::ENOTRECOVERABLE), WasiErrno::NotRecoverable);
        assert_eq!(translate_errno(Errno::EOWNERDEAD), WasiErrno::OwnerDead);
        assert_eq!(translate_errno(Errno::EDOM), WasiErrno::Dom);
        assert_eq!(translate_errno(Errno::EILSEQ), WasiErrno::IlSeq);
        assert_eq!(translate_errno(Errno::EHOSTUNREACH), WasiErrno::HostUnreach);
    }

    #[test]
    fn enotsup_and_eopnotsupp_share_a_value() {
        // POSIX permits it, `Errno::ENOTSUP` is an alias for EOPNOTSUPP(95),
        // and WASI has a single NotSup.
        assert_eq!(translate_errno(Errno::ENOTSUP), WasiErrno::NotSup);
        assert_eq!(translate_linux_errno(95), WasiErrno::NotSup);
    }

    #[test]
    fn wasi_errno_values_match_the_specification() {
        // Spot-check the boundaries of the enum's numbering.
        assert_eq!(WasiErrno::Success.as_u16(), 0);
        assert_eq!(WasiErrno::TooBig.as_u16(), 1);
        assert_eq!(WasiErrno::NotCapable.as_u16(), 76);
    }
}
