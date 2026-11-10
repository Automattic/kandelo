//! Kandelo's dev_t encoding, shared by stat, statx and procfs.
//!
//! Keep this consistent with the guest libc's sys/sysmacros.h so kernel
//! metadata and userspace major(), minor() and makedev() agree.

pub const fn make(major: u32, minor: u32) -> u64 {
    let major = major as u64;
    let minor = minor as u64;
    ((major & 0xffff_f000) << 32)
        | ((major & 0x0000_0fff) << 8)
        | ((minor & 0xffff_ff00) << 12)
        | (minor & 0x0000_00ff)
}

pub const fn major(dev: u64) -> u32 {
    (((dev >> 32) & 0xffff_f000) | ((dev >> 8) & 0x0fff)) as u32
}

pub const fn minor(dev: u64) -> u32 {
    (((dev >> 12) & 0xffff_ff00) | (dev & 0x00ff)) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_numbers_round_trip_all_major_and_minor_bits() {
        for (major_number, minor_number) in [
            (0, 0), (0, 0x73000), (13, 64), (226, 128),
            (0x1234_5678, 0x9abc_def0), (u32::MAX, u32::MAX),
        ] {
            let dev = make(major_number, minor_number);
            assert_eq!(major(dev), major_number);
            assert_eq!(minor(dev), minor_number);
        }
    }
}
