//! Publication policy for a VFS image: the checks an artifact must pass before
//! it ships, expressed where the writer is rather than beside the caller.
//!
//! # Why these live here
//!
//! Three assertions guard a published image today, and all three sit inside
//! `serializeImage` in `images/vfs/scripts/vfs-image-helpers.ts`: runtime
//! headroom, the encoded growth ceiling, and an ABI check on every Wasm
//! artifact the image carries. They are not format work, but losing them is
//! worse than losing format work -- images are validated by being run, so a
//! product image published without its size guarantee fails somewhere
//! unrelated, days later.
//!
//! Lane Y measured their coverage before moving them, by disabling each CALL
//! SITE inside `serializeImage` rather than each function body: a unit test on
//! the function cannot notice the function being unwired, and unwiring is what
//! a migration does. Headroom and capacity had exactly ONE detector each. That
//! is the argument for moving them next to the writer: a new image path should
//! not be able to skip them by forgetting a line.
//!
//! # Why the values are `u64`
//!
//! The TypeScript checks open by validating that each limit "must be a
//! non-negative safe integer", because a JavaScript number can be -3, 1.5, or
//! 2^60. Here the type says it. Those validations have no Rust counterpart on
//! purpose -- they are not missing, they are unrepresentable.

use alloc::vec::Vec;

use crate::sffs::{BlockSource, Sffs};

/// What a product image must still have free when it ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Headroom {
    pub minimum_free_bytes: u64,
    pub minimum_free_inodes: u64,
}

/// A failed publication check, carrying the numbers rather than a message.
///
/// The caller formats. A `no_std` policy module that owned its own prose would
/// force one wording on every host, and the wording a build script wants
/// ("lamp.vfs lacks runtime VFS headroom") is not the one a kernel wants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyViolation {
    /// The image ships with less free space than its profile requires.
    Headroom {
        free_bytes: u64,
        required_bytes: u64,
        free_inodes: u64,
        required_inodes: u64,
    },
}

impl PolicyViolation {
    /// Which limits were actually breached, so a caller can name them without
    /// re-deriving the comparison.
    pub fn breached(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        match self {
            PolicyViolation::Headroom {
                free_bytes,
                required_bytes,
                free_inodes,
                required_inodes,
            } => {
                if free_bytes < required_bytes {
                    out.push("free bytes");
                }
                if free_inodes < required_inodes {
                    out.push("free inodes");
                }
            }
        }
        out
    }
}

/// Require a mounted image to still carry its declared runtime headroom.
///
/// Both limits are evaluated before returning, and both numbers ride in the
/// violation. The TypeScript original collects both failures and joins them,
/// and it is right to: telling a build "you are short on bytes", waiting for a
/// rebuild, then telling it "you are also short on inodes" wastes the slowest
/// loop in the project.
pub fn check_headroom<S: BlockSource>(
    fs: &Sffs<S>,
    headroom: &Headroom,
) -> Result<(), PolicyViolation> {
    let st = fs.statfs().map_err(|_| PolicyViolation::Headroom {
        // A statfs that cannot be read is not "zero free": it is an image whose
        // own superblock is unreadable, and reporting it as a headroom breach
        // is the truthful outcome for a publication gate. `Sffs::statfs`
        // already refuses a superblock claiming more free than total, so this
        // arm cannot be reached by a merely-full image.
        free_bytes: 0,
        required_bytes: headroom.minimum_free_bytes,
        free_inodes: 0,
        required_inodes: headroom.minimum_free_inodes,
    })?;

    let free_bytes = st.f_bfree.saturating_mul(st.f_frsize as u64);
    if free_bytes < headroom.minimum_free_bytes || st.f_ffree < headroom.minimum_free_inodes {
        return Err(PolicyViolation::Headroom {
            free_bytes,
            required_bytes: headroom.minimum_free_bytes,
            free_inodes: st.f_ffree,
            required_inodes: headroom.minimum_free_inodes,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sffs::unwrap_vfsi;

    const TINY_VFS: &[u8] = include_bytes!("testdata/tiny.vfs");

    fn mount() -> Sffs<Vec<u8>> {
        Sffs::mount(unwrap_vfsi(TINY_VFS).expect("unwrap").to_vec()).expect("mount")
    }

    #[test]
    fn a_zero_requirement_always_passes() {
        let fs = mount();
        assert_eq!(
            check_headroom(
                &fs,
                &Headroom { minimum_free_bytes: 0, minimum_free_inodes: 0 }
            ),
            Ok(())
        );
    }

    #[test]
    fn the_fixtures_real_headroom_is_accepted() {
        let fs = mount();
        let st = fs.statfs().expect("statfs");
        let free_bytes = st.f_bfree * st.f_frsize as u64;
        // Ask for exactly what it has: the boundary must pass, not fail.
        assert_eq!(
            check_headroom(
                &fs,
                &Headroom {
                    minimum_free_bytes: free_bytes,
                    minimum_free_inodes: st.f_ffree,
                }
            ),
            Ok(()),
            "requiring exactly the free space present must pass",
        );
    }

    #[test]
    fn one_byte_beyond_the_free_space_is_refused() {
        let fs = mount();
        let st = fs.statfs().expect("statfs");
        let free_bytes = st.f_bfree * st.f_frsize as u64;
        let err = check_headroom(
            &fs,
            &Headroom { minimum_free_bytes: free_bytes + 1, minimum_free_inodes: 0 },
        )
        .expect_err("one byte too many must fail");
        assert_eq!(err.breached(), alloc::vec!["free bytes"]);
    }

    /// Both limits are reported together. A gate that surfaces one breach per
    /// rebuild costs a full image build to learn the second.
    #[test]
    fn both_breaches_are_reported_from_one_run() {
        let fs = mount();
        let st = fs.statfs().expect("statfs");
        let free_bytes = st.f_bfree * st.f_frsize as u64;
        let err = check_headroom(
            &fs,
            &Headroom {
                minimum_free_bytes: free_bytes + 1,
                minimum_free_inodes: st.f_ffree + 1,
            },
        )
        .expect_err("both limits breached");
        assert_eq!(err.breached(), alloc::vec!["free bytes", "free inodes"]);
    }

    #[test]
    fn an_inode_breach_alone_is_refused() {
        let fs = mount();
        let st = fs.statfs().expect("statfs");
        let err = check_headroom(
            &fs,
            &Headroom { minimum_free_bytes: 0, minimum_free_inodes: st.f_ffree + 1 },
        )
        .expect_err("inode shortfall must fail");
        assert_eq!(err.breached(), alloc::vec!["free inodes"]);
    }
}
