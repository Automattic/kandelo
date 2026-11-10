//! Explicitly requested, independently versioned program interfaces.
//!
//! These namespaces are not additions to the frozen base ABI's `env` imports.
//! A module import is a required extension declaration: the host must reject
//! unknown versions, names, kinds or signatures before instantiation. Existing
//! base programs request none. Never accept a new interface under an old name.
pub const RESERVED_MODULE_PREFIX: &str = "kandelo.";

pub mod stack_v1 {
    pub const MODULE: &str = "kandelo.stack.v1";
    pub const IMPORT: &str = "__kandelo_stack_capture_v1";
    /// (pointer, capacity:u32, maximum_frames:u32) -> i32. A positive return
    /// is the packet length; errors are negative values and do not set errno.
    pub const MAX_PACKET_BYTES: u32 = 65536;
    pub const MAX_FRAMES: u32 = 128;
    pub const MAX_NAME_BYTES: u32 = 4096;
    pub const MAX_FILE_BYTES: u32 = 16384;
    pub const MAGIC: u32 = u32::from_le_bytes(*b"KSTK");
    pub const VERSION: u16 = 1;
    pub const HEADER_BYTES: u32 = 48;
    pub const FRAME_HEADER_BYTES: u32 = 32;
    pub const FLAG_TRUNCATED: u16 = 1;
    pub const FLAG_MODULE_UNRESOLVED: u16 = 2;
    pub const FRAME_HAS_PC: u32 = 1;
    pub const FRAME_HAS_NAME: u32 = 2;
    pub const FRAME_HAS_SOURCE: u32 = 4;
    pub const FRAME_MODULE_KNOWN: u32 = 8;
    pub const UNKNOWN_FUNCTION: u32 = u32::MAX;
    pub const INVALID_ARGUMENT: i32 = -22;
    pub const INVALID_ADDRESS: i32 = -14;
    pub const BUFFER_TOO_SMALL: i32 = -105;

    /// All unsigned wire constants, also rendered into the host and std
    /// backend. Offsets are fixed-width little-endian byte positions.
    pub const WIRE: &[(&str, u32)] = &[
        ("MAX_PACKET_BYTES", MAX_PACKET_BYTES),
        ("MAX_FRAMES", MAX_FRAMES),
        ("MAX_NAME_BYTES", MAX_NAME_BYTES),
        ("MAX_FILE_BYTES", MAX_FILE_BYTES),
        ("MAGIC", MAGIC),
        ("VERSION", VERSION as u32),
        ("HEADER_BYTES", HEADER_BYTES),
        ("FRAME_HEADER_BYTES", FRAME_HEADER_BYTES),
        ("FLAG_TRUNCATED", FLAG_TRUNCATED as u32),
        ("FLAG_MODULE_UNRESOLVED", FLAG_MODULE_UNRESOLVED as u32),
        ("FRAME_HAS_PC", FRAME_HAS_PC),
        ("FRAME_HAS_NAME", FRAME_HAS_NAME),
        ("FRAME_HAS_SOURCE", FRAME_HAS_SOURCE),
        ("FRAME_MODULE_KNOWN", FRAME_MODULE_KNOWN),
        ("UNKNOWN_FUNCTION", UNKNOWN_FUNCTION),
        ("VERSION_OFFSET", 4),
        ("FLAGS_OFFSET", 6),
        ("COUNT_OFFSET", 8),
        ("LENGTH_OFFSET", 12),
        ("MODULE_HASH_OFFSET", 16),
        ("FRAME_FLAGS_OFFSET", 4),
        ("FRAME_PC_OFFSET", 8),
        ("FRAME_LINE_OFFSET", 16),
        ("FRAME_COLUMN_OFFSET", 20),
        ("FRAME_NAME_LENGTH_OFFSET", 24),
        ("FRAME_FILE_LENGTH_OFFSET", 28),
    ];
    pub const ERRORS: &[(&str, i32)] = &[
        ("INVALID_ARGUMENT", INVALID_ARGUMENT),
        ("INVALID_ADDRESS", INVALID_ADDRESS),
        ("BUFFER_TOO_SMALL", BUFFER_TOO_SMALL),
    ];
}

/// The kernel message ring, read the way `klogctl(type, buf, len)` reads it.
///
/// WHY an extension and not a base syscall: musl's `klogctl` issues
/// `SYS_syslog` (304), which the frozen base program surface does not
/// declare, and adding it would change the digest every supported program
/// carries. A program that calls `klogctl` imports this instead, so it is
/// refused on a host that cannot serve it rather than handed a silent answer,
/// and programs that never call it keep their base identity.
pub mod klog_v1 {
    pub const MODULE: &str = "kandelo.klog.v1";
    pub const IMPORT: &str = "__kandelo_klogctl_v1";
    /// (buffer: pointer, capacity: u32, action: i32) -> i32. The arguments are
    /// `klogctl`'s, reordered to the extension family's (pointer, i32, i32)
    /// shape. A non-negative return is `klogctl`'s result; an error is a
    /// negative errno and does not set the caller's `errno`.
    pub const ERRORS: &[(&str, i32)] = &[
        ("INVALID_ARGUMENT", -22),
        ("INVALID_ADDRESS", -14),
        ("PERMISSION_DENIED", -1),
    ];
}

/// Every implemented extension, by module and its single function import.
/// Each has the signature `(pointer, i32, i32) -> i32`.
pub const EXTENSIONS: &[(&str, &str)] = &[
    (stack_v1::MODULE, stack_v1::IMPORT),
    (klog_v1::MODULE, klog_v1::IMPORT),
];

/// The function import a known extension module supplies.
pub fn extension_import(module: &str) -> Option<&'static str> {
    EXTENSIONS
        .iter()
        .find(|(candidate, _)| *candidate == module)
        .map(|(_, import)| *import)
}

/// Whether a name is one of the extension functions, imported from any module.
pub fn is_extension_import_name(name: &str) -> bool {
    EXTENSIONS.iter().any(|(_, import)| *import == name)
}
