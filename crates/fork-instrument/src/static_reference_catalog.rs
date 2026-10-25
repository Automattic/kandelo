//! Static reference root catalog wire format and export names.

pub const EXPORT: &str = "__wpk_fork_static_root_catalog";

pub const HARVEST_EXPORT: &str = "__wpk_fork_static_root_harvest";

pub const FORMAT_SECTION: &str = "kandelo.wpk_fork.static_root_catalog";

pub const FORMAT_MAGIC: [u8; 4] = *b"KFSR";

pub const FORMAT_VERSION: u16 = 1;

pub const FORMAT_HEADER_SIZE: u16 = 12;
