//! WASI Preview 1 scalar types.
//!
//! These are a *guest* ABI fixed by the WASI specification. POSIX constants
//! are never redeclared here -- they come from `wasm_posix_shared`, which is
//! already the single source of truth for them and is what
//! `host/src/generated/abi.ts` is generated from.

/// WASI `filetype`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum WasiFiletype {
    Unknown = 0,
    BlockDevice = 1,
    CharacterDevice = 2,
    Directory = 3,
    RegularFile = 4,
    SocketDgram = 5,
    SocketStream = 6,
    SymbolicLink = 7,
}

impl WasiFiletype {
    #[inline]
    pub const fn as_u8(self) -> u8 {
        self as u8
    }
}

/// WASI `clockid`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum WasiClock {
    Realtime = 0,
    Monotonic = 1,
    ProcessCputime = 2,
    ThreadCputime = 3,
}

impl WasiClock {
    /// WASI clock ids 0-3 happen to share their numbering with the POSIX
    /// `CLOCK_*` ids, but that is a coincidence worth naming rather than
    /// relying on silently.
    pub const fn from_u32(value: u32) -> Option<Self> {
        match value {
            0 => Some(Self::Realtime),
            1 => Some(Self::Monotonic),
            2 => Some(Self::ProcessCputime),
            3 => Some(Self::ThreadCputime),
            _ => None,
        }
    }
}

/// WASI `whence`. Distinct from POSIX `SEEK_*` as a type even though the
/// numbering coincides -- `host/src/wasi-shim.ts:388` carries a "DIFFERENT
/// from POSIX!" comment about an earlier WASI revision where it did differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum WasiWhence {
    Set = 0,
    Cur = 1,
    End = 2,
}

impl WasiWhence {
    pub const fn from_u32(value: u32) -> Option<Self> {
        match value {
            0 => Some(Self::Set),
            1 => Some(Self::Cur),
            2 => Some(Self::End),
            _ => None,
        }
    }
}

/// WASI `eventtype`, the subscription/event tag used by `poll_oneoff`.
///
/// This being an exhaustively-matched enum is the fix for defect 1 (see
/// `crate::translate::poll_events_for_eventtype`): the TypeScript compares
/// only against `FD_READ` and treats *everything else* -- including a
/// malformed tag -- as `FD_WRITE`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum WasiEventType {
    Clock = 0,
    FdRead = 1,
    FdWrite = 2,
}

impl WasiEventType {
    pub const fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Clock),
            1 => Some(Self::FdRead),
            2 => Some(Self::FdWrite),
            _ => None,
        }
    }

    #[inline]
    pub const fn as_u8(self) -> u8 {
        self as u8
    }
}

macro_rules! bitset {
    (
        $(#[$meta:meta])*
        $name:ident : $repr:ty { $( $(#[$cmeta:meta])* $konst:ident = $value:expr; )* }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
        pub struct $name(pub $repr);

        impl $name {
            pub const EMPTY: Self = Self(0);
            $( $(#[$cmeta])* pub const $konst: Self = Self($value); )*

            /// Every bit this type defines. A bit outside this mask is one the
            /// specification does not define, or one a later revision added.
            pub const KNOWN: Self = Self(0 $( | $value )*);

            #[inline]
            pub const fn bits(self) -> $repr { self.0 }

            #[inline]
            pub const fn contains(self, other: Self) -> bool {
                (self.0 & other.0) == other.0
            }

            #[inline]
            pub const fn intersects(self, other: Self) -> bool {
                (self.0 & other.0) != 0
            }

            #[inline]
            pub const fn union(self, other: Self) -> Self { Self(self.0 | other.0) }

            /// Bits set that this type does not define.
            #[inline]
            pub const fn unknown_bits(self) -> $repr { self.0 & !Self::KNOWN.0 }
        }
    };
}

bitset! {
    /// WASI `oflags`, the create/exclusive/truncate/directory bits of
    /// `path_open`. Note these are NOT the POSIX `O_*` values.
    WasiOflags: u32 {
        CREAT = 1;
        DIRECTORY = 2;
        EXCL = 4;
        TRUNC = 8;
    }
}

bitset! {
    /// WASI `fdflags`.
    WasiFdflags: u32 {
        APPEND = 1;
        DSYNC = 2;
        NONBLOCK = 4;
        RSYNC = 8;
        SYNC = 16;
    }
}

impl WasiFdflags {
    /// The three synchronised-write bits. Kandelo's kernel has no counterpart
    /// for any of them -- `wasm_posix_shared::flags` defines no `O_SYNC`,
    /// `O_DSYNC`, or `O_RSYNC` -- which is what makes defect 3 a real gap
    /// rather than a mapping oversight.
    pub const SYNC_BITS: Self = Self(Self::DSYNC.0 | Self::RSYNC.0 | Self::SYNC.0);
}

bitset! {
    /// WASI `lookupflags`. The single defined bit selects symlink following;
    /// its ABSENCE is WASI's `lstat`, which the TypeScript never implements
    /// (defect 2).
    WasiLookupflags: u32 {
        SYMLINK_FOLLOW = 1;
    }
}

/// WASI `rights`. Kandelo does not model per-fd rights, so every fd is
/// reported as carrying all of them, matching `host/src/wasi-shim.ts:361`.
pub const WASI_RIGHTS_ALL: u64 = 0x1FFF_FFFF;

/// WASI `preopentype`.
pub const WASI_PREOPENTYPE_DIR: u8 = 0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitsets_report_unknown_bits() {
        assert_eq!(WasiOflags::KNOWN.bits(), 0b1111);
        assert_eq!(WasiOflags(0b1_0000).unknown_bits(), 0b1_0000);
        assert_eq!(WasiOflags(0b1111).unknown_bits(), 0);
        assert_eq!(WasiFdflags::KNOWN.bits(), 0b1_1111);
        assert_eq!(WasiFdflags::SYNC_BITS.bits(), 2 | 8 | 16);
    }

    #[test]
    fn scalar_enums_reject_out_of_range() {
        assert_eq!(WasiWhence::from_u32(3), None);
        assert_eq!(WasiClock::from_u32(4), None);
        assert_eq!(WasiEventType::from_u8(3), None);
        assert_eq!(WasiWhence::from_u32(2), Some(WasiWhence::End));
        assert_eq!(WasiClock::from_u32(3), Some(WasiClock::ThreadCputime));
        assert_eq!(WasiEventType::from_u8(2), Some(WasiEventType::FdWrite));
    }

    #[test]
    fn contains_requires_all_bits() {
        let both = WasiFdflags::APPEND.union(WasiFdflags::NONBLOCK);
        assert!(both.contains(WasiFdflags::APPEND));
        assert!(both.contains(WasiFdflags::NONBLOCK));
        assert!(!both.contains(WasiFdflags::SYNC));
        assert!(both.intersects(WasiFdflags::APPEND));
        assert!(!both.intersects(WasiFdflags::SYNC_BITS));
    }
}
