//! Independently versioned trusted-group memory layout.
pub const MODULE: &str = "kandelo.memory-group.v3";
pub const IMPORT: &str = "memory";
pub const SECTION: &str = "kandelo.memory-group";
pub const VERSION: u32 = 3;
pub const LAYOUT: u32 = 3;
pub const PAGE_BYTES: u32 = 65536;
pub const CONTROL: u32 = 4096;
pub const MAGIC: u32 = u32::from_le_bytes(*b"KMG3");
pub const BITMAP: u32 = 6144;
pub const BITMAP_BYTES: u32 = 2048;
pub const MAXIMUM_PAGES: u32 = BITMAP_BYTES * 8;
pub const WAIT_HEADER: u32 = 4112;
pub const WAIT_NODES: u32 = 8192;
pub const WAIT_NODE_BYTES: u32 = 32;
pub const WAIT_FREE: u32 = 0;
pub const WAIT_WAITING: u32 = 1;
pub const WAIT_NOTIFIED: u32 = 2;
pub const WAIT_STOPPED: u32 = 3;
pub const ROOT_HEADER_BYTES: u32 = 64;
pub const ROOT_GROW_LOCK: u32 = 52;
pub const ROOT_RUN: u32 = 56;
pub const REPLICA_BYTES: u32 = 64;
pub const REPLICA_RUN: u32 = 0;
pub const REPLICA_REQUEST: u32 = 4;
pub const REPLICA_ACK: u32 = 8;
pub const REPLICA_ROOT: u32 = 12;
pub const REPLICA_SERIAL: u32 = 16;
pub const REPLICA_GENERATION: u32 = 24;
pub const REPLICA_PID: u32 = 32;
pub const REPLICA_TID: u32 = 36;
pub const REPLICA_GROUP: u32 = 40;
// Formerly reserved within the unchanged 64-byte per-task control record.
pub const REPLICA_FORK_REPLAY: u32 = 44;
pub const FORK_REPLAY_VERSION: u32 = 1;
pub const REPLAY_PENDING: u32 = 0;
pub const REPLAY_COMMITTED: u32 = 1;
pub const REPLAY_CANCELLED: u32 = 2;
pub const REPLAY_PAUSED: u32 = 3;
pub const REPLICA_WAIT_NODE: u32 = 52;
pub const REPLICA_MAGIC_OFFSET: u32 = 60;
pub const REPLICA_MAGIC: u32 = u32::from_le_bytes(*b"KMR3");
pub const WIRE: &[(&str, u32)] = &[
    ("VERSION", VERSION),
    ("LAYOUT", LAYOUT),
    ("PAGE_BYTES", PAGE_BYTES),
    ("CONTROL", CONTROL),
    ("MAGIC", MAGIC),
    ("BITMAP", BITMAP),
    ("BITMAP_BYTES", BITMAP_BYTES),
    ("MAXIMUM_PAGES", MAXIMUM_PAGES),
    ("WAIT_HEADER", WAIT_HEADER),
    ("WAIT_NODES", WAIT_NODES),
    ("WAIT_NODE_BYTES", WAIT_NODE_BYTES),
    ("WAIT_FREE", WAIT_FREE),
    ("WAIT_WAITING", WAIT_WAITING),
    ("WAIT_NOTIFIED", WAIT_NOTIFIED),
    ("WAIT_STOPPED", WAIT_STOPPED),
    ("ROOT_HEADER_BYTES", ROOT_HEADER_BYTES),
    ("ROOT_GROW_LOCK", ROOT_GROW_LOCK),
    ("ROOT_RUN", ROOT_RUN),
    ("REPLICA_BYTES", REPLICA_BYTES),
    ("REPLICA_RUN", REPLICA_RUN),
    ("REPLICA_REQUEST", REPLICA_REQUEST),
    ("REPLICA_ACK", REPLICA_ACK),
    ("REPLICA_ROOT", REPLICA_ROOT),
    ("REPLICA_SERIAL", REPLICA_SERIAL),
    ("REPLICA_GENERATION", REPLICA_GENERATION),
    ("REPLICA_PID", REPLICA_PID),
    ("REPLICA_TID", REPLICA_TID),
    ("REPLICA_GROUP", REPLICA_GROUP),
    ("REPLICA_FORK_REPLAY", REPLICA_FORK_REPLAY),
    ("FORK_REPLAY_VERSION", FORK_REPLAY_VERSION),
    ("REPLAY_PENDING", REPLAY_PENDING),
    ("REPLAY_COMMITTED", REPLAY_COMMITTED),
    ("REPLAY_CANCELLED", REPLAY_CANCELLED),
    ("REPLAY_PAUSED", REPLAY_PAUSED),
    ("REPLICA_WAIT_NODE", REPLICA_WAIT_NODE),
    ("REPLICA_MAGIC_OFFSET", REPLICA_MAGIC_OFFSET),
    ("REPLICA_MAGIC", REPLICA_MAGIC),
];
