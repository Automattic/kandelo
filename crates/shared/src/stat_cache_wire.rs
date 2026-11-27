//! Certificate for a stat result the kernel has authorized for reuse.
//!
//! The kernel writes all fields little-endian. The adapter publishes a
//! detached copy only at the original process worker's completion boundary.
pub const MAGIC: u32 = u32::from_le_bytes(*b"KLS1");
pub const MAGIC_OFFSET: usize = 0;
pub const LENGTH_OFFSET: usize = 4;
pub const PID_OFFSET: usize = 8;
pub const TID_OFFSET: usize = 12;
pub const SCOPE_OFFSET: usize = 16;
pub const ROUTE_OFFSET: usize = 24;
pub const PATHNAME_GENERATION_OFFSET: usize = 32;
pub const INODE_GENERATION_OFFSET: usize = 40;
pub const BUCKET_OFFSET: usize = 48;
pub const SYSCALL_OFFSET: usize = 52;
pub const FLAGS_OFFSET: usize = 56;
pub const PATH_LENGTH_OFFSET: usize = 60;
pub const PATH_OFFSET: usize = 64;
pub const PATH_BYTES: usize = 96;
pub const STAT_OFFSET: usize = PATH_OFFSET + PATH_BYTES;
pub const STAT_BYTES: usize = crate::process_layout::stat::SIZE as usize;
pub const GENERATIONS_OFFSET: usize = STAT_OFFSET + STAT_BYTES;
pub const INODE_BUCKETS: usize = 256;
pub const BYTES: usize = GENERATIONS_OFFSET + INODE_BUCKETS * size_of::<u64>();

pub const FIELDS: &[(&str, u32)] = &[
    ("MAGIC", MAGIC),
    ("MAGIC_OFFSET", MAGIC_OFFSET as u32),
    ("LENGTH_OFFSET", LENGTH_OFFSET as u32),
    ("PID_OFFSET", PID_OFFSET as u32),
    ("TID_OFFSET", TID_OFFSET as u32),
    ("SCOPE_OFFSET", SCOPE_OFFSET as u32),
    ("ROUTE_OFFSET", ROUTE_OFFSET as u32),
    (
        "PATHNAME_GENERATION_OFFSET",
        PATHNAME_GENERATION_OFFSET as u32,
    ),
    ("INODE_GENERATION_OFFSET", INODE_GENERATION_OFFSET as u32),
    ("BUCKET_OFFSET", BUCKET_OFFSET as u32),
    ("SYSCALL_OFFSET", SYSCALL_OFFSET as u32),
    ("FLAGS_OFFSET", FLAGS_OFFSET as u32),
    ("PATH_LENGTH_OFFSET", PATH_LENGTH_OFFSET as u32),
    ("PATH_OFFSET", PATH_OFFSET as u32),
    ("PATH_BYTES", PATH_BYTES as u32),
    ("STAT_OFFSET", STAT_OFFSET as u32),
    ("STAT_BYTES", STAT_BYTES as u32),
    ("GENERATIONS_OFFSET", GENERATIONS_OFFSET as u32),
    ("INODE_BUCKETS", INODE_BUCKETS as u32),
    ("BYTES", BYTES as u32),
];
