//! POSIX file-access permission checks.
//!
//! Centralized helper used by Tasks 5.4-5.6 to wire `EACCES` enforcement into
//! filesystem syscalls. The toggle in `crate::enforce_permissions()` is
//! consulted at call sites — this module is pure policy.

use wasm_posix_shared::access::{F_OK, R_OK, W_OK, X_OK};
use wasm_posix_shared::mode::{
    S_IRGRP, S_IROTH, S_IRUSR, S_IWGRP, S_IWOTH, S_IWUSR, S_IXGRP, S_IXOTH, S_IXUSR,
};
use wasm_posix_shared::Errno;

/// POSIX file-access check. Returns `Ok(())` if access is allowed,
/// `Err(Errno::EACCES)` otherwise.
///
/// `requested` is a bitmask of `R_OK`, `W_OK`, `X_OK` (POSIX `<unistd.h>`
/// constants). `F_OK` (existence) is always granted on its own — callers that
/// need existence checks have already resolved the path.
///
/// `file_mode` carries the file's permission bits in the low nine bits
/// (`rwxrwxrwx`); higher bits (file type, setuid/setgid/sticky) are ignored
/// here. Callers that need sticky-bit semantics (Task 5.5) layer that on top.
///
/// Selection rule (POSIX): owner bits gate the owner even if other bits would
/// grant; group bits gate group members even if other bits would grant.
///
/// Root (`caller_uid == 0`) gets `R_OK`/`W_OK` unconditionally. `X_OK` for
/// root requires that *some* execute bit be set on the file — POSIX permits
/// implementations either way, and matching Linux's behaviour is the most
/// useful reference. Directories are exempt: root may always traverse them.
///
/// # Examples
///
/// ```
/// use wasm_posix_kernel::access::check_access;
/// use wasm_posix_shared::access::{R_OK, W_OK, X_OK};
///
/// // Owner of a 0o600 file may read+write but not execute.
/// assert!(check_access(R_OK | W_OK, 1000, 1000, 0o600, 1000, 1000, &[]).is_ok());
/// assert!(check_access(X_OK, 1000, 1000, 0o600, 1000, 1000, &[]).is_err());
///
/// // Stranger gets only the "other" bits.
/// assert!(check_access(R_OK, 1000, 1000, 0o644, 2000, 2000, &[]).is_ok());
/// assert!(check_access(W_OK, 1000, 1000, 0o644, 2000, 2000, &[]).is_err());
/// ```
pub fn check_access(
    requested: u32,
    file_uid: u32,
    file_gid: u32,
    file_mode: u32,
    caller_uid: u32,
    caller_gid: u32,
    caller_groups: &[u32],
) -> Result<(), Errno> {
    if requested == F_OK {
        return Ok(());
    }

    let perm_bits = file_mode & 0o777;
    let is_dir = (file_mode & wasm_posix_shared::mode::S_IFMT)
        == wasm_posix_shared::mode::S_IFDIR;

    if caller_uid == 0 {
        if requested & X_OK != 0 {
            let any_exec = perm_bits & (S_IXUSR | S_IXGRP | S_IXOTH) != 0;
            if !is_dir && !any_exec {
                return Err(Errno::EACCES);
            }
        }
        return Ok(());
    }

    let granted = if caller_uid == file_uid {
        owner_bits(perm_bits)
    } else if caller_gid == file_gid || caller_groups.contains(&file_gid) {
        group_bits(perm_bits)
    } else {
        other_bits(perm_bits)
    };

    let want = requested & (R_OK | W_OK | X_OK);
    if (want & granted) == want {
        Ok(())
    } else {
        Err(Errno::EACCES)
    }
}

#[inline]
fn owner_bits(perm: u32) -> u32 {
    let mut g = 0;
    if perm & S_IRUSR != 0 { g |= R_OK; }
    if perm & S_IWUSR != 0 { g |= W_OK; }
    if perm & S_IXUSR != 0 { g |= X_OK; }
    g
}

#[inline]
fn group_bits(perm: u32) -> u32 {
    let mut g = 0;
    if perm & S_IRGRP != 0 { g |= R_OK; }
    if perm & S_IWGRP != 0 { g |= W_OK; }
    if perm & S_IXGRP != 0 { g |= X_OK; }
    g
}

#[inline]
fn other_bits(perm: u32) -> u32 {
    let mut g = 0;
    if perm & S_IROTH != 0 { g |= R_OK; }
    if perm & S_IWOTH != 0 { g |= W_OK; }
    if perm & S_IXOTH != 0 { g |= X_OK; }
    g
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_posix_shared::mode::S_IFDIR;

    const OWNER: u32 = 1000;
    const OWNER_GID: u32 = 1000;
    const OTHER_UID: u32 = 2000;
    const OTHER_GID: u32 = 2000;
    const ROOT: u32 = 0;

    // ---- Owner cases ----

    #[test]
    fn owner_0o600_can_read_and_write() {
        assert!(check_access(R_OK, OWNER, OWNER_GID, 0o600, OWNER, OWNER_GID, &[]).is_ok());
        assert!(check_access(W_OK, OWNER, OWNER_GID, 0o600, OWNER, OWNER_GID, &[]).is_ok());
        assert!(check_access(R_OK | W_OK, OWNER, OWNER_GID, 0o600, OWNER, OWNER_GID, &[]).is_ok());
    }

    #[test]
    fn owner_0o600_cannot_execute() {
        assert_eq!(
            check_access(X_OK, OWNER, OWNER_GID, 0o600, OWNER, OWNER_GID, &[]),
            Err(Errno::EACCES)
        );
    }

    #[test]
    fn owner_0o700_can_rwx() {
        assert!(
            check_access(R_OK | W_OK | X_OK, OWNER, OWNER_GID, 0o700, OWNER, OWNER_GID, &[])
                .is_ok()
        );
    }

    #[test]
    fn owner_0o000_denies_everything() {
        assert_eq!(
            check_access(R_OK, OWNER, OWNER_GID, 0o000, OWNER, OWNER_GID, &[]),
            Err(Errno::EACCES)
        );
        assert_eq!(
            check_access(W_OK, OWNER, OWNER_GID, 0o000, OWNER, OWNER_GID, &[]),
            Err(Errno::EACCES)
        );
        assert_eq!(
            check_access(X_OK, OWNER, OWNER_GID, 0o000, OWNER, OWNER_GID, &[]),
            Err(Errno::EACCES)
        );
    }

    #[test]
    fn owner_write_on_read_only_file_denied() {
        // 0o400: owner read-only.
        assert_eq!(
            check_access(W_OK, OWNER, OWNER_GID, 0o400, OWNER, OWNER_GID, &[]),
            Err(Errno::EACCES)
        );
    }

    #[test]
    fn owner_uses_owner_bits_even_when_other_would_grant() {
        // 0o077: no owner bits, full group+other access. Owner is still gated
        // by owner bits — must be denied.
        assert_eq!(
            check_access(R_OK, OWNER, OWNER_GID, 0o077, OWNER, OWNER_GID, &[]),
            Err(Errno::EACCES)
        );
    }

    // ---- Group cases ----

    #[test]
    fn primary_group_member_0o060_can_read_and_write() {
        // Caller is not owner but has matching primary gid.
        assert!(check_access(R_OK | W_OK, OWNER, OWNER_GID, 0o060, OTHER_UID, OWNER_GID, &[]).is_ok());
    }

    #[test]
    fn primary_group_member_0o060_cannot_execute() {
        assert_eq!(
            check_access(X_OK, OWNER, OWNER_GID, 0o060, OTHER_UID, OWNER_GID, &[]),
            Err(Errno::EACCES)
        );
    }

    #[test]
    fn supplementary_group_member_0o040_can_read() {
        // Caller's primary gid != file gid, but supplementary list contains it.
        assert!(check_access(R_OK, OWNER, OWNER_GID, 0o040, OTHER_UID, 9999, &[OWNER_GID]).is_ok());
    }

    #[test]
    fn supplementary_group_member_0o040_cannot_write() {
        assert_eq!(
            check_access(W_OK, OWNER, OWNER_GID, 0o040, OTHER_UID, 9999, &[OWNER_GID]),
            Err(Errno::EACCES)
        );
    }

    #[test]
    fn group_member_0o000_denied() {
        assert_eq!(
            check_access(R_OK, OWNER, OWNER_GID, 0o000, OTHER_UID, OWNER_GID, &[]),
            Err(Errno::EACCES)
        );
    }

    #[test]
    fn group_uses_group_bits_even_when_other_would_grant() {
        // 0o007: no owner/group bits, only other. Group member must be denied.
        assert_eq!(
            check_access(R_OK, OWNER, OWNER_GID, 0o007, OTHER_UID, OWNER_GID, &[]),
            Err(Errno::EACCES)
        );
    }

    // ---- Other cases ----

    #[test]
    fn stranger_0o004_can_read() {
        assert!(check_access(R_OK, OWNER, OWNER_GID, 0o004, OTHER_UID, OTHER_GID, &[]).is_ok());
    }

    #[test]
    fn stranger_0o004_cannot_write() {
        assert_eq!(
            check_access(W_OK, OWNER, OWNER_GID, 0o004, OTHER_UID, OTHER_GID, &[]),
            Err(Errno::EACCES)
        );
    }

    #[test]
    fn stranger_0o000_denied() {
        assert_eq!(
            check_access(R_OK, OWNER, OWNER_GID, 0o000, OTHER_UID, OTHER_GID, &[]),
            Err(Errno::EACCES)
        );
    }

    #[test]
    fn empty_supplementary_groups_falls_through_to_other() {
        // Caller is not owner, primary gid mismatches, supplementary list empty.
        // Must get OTHER bits — 0o007 grants r+w+x to other.
        assert!(
            check_access(R_OK | W_OK | X_OK, OWNER, OWNER_GID, 0o007, OTHER_UID, OTHER_GID, &[])
                .is_ok()
        );
    }

    // ---- Root cases ----

    #[test]
    fn root_can_read_write_zero_mode_file() {
        assert!(check_access(R_OK, OWNER, OWNER_GID, 0o000, ROOT, ROOT, &[]).is_ok());
        assert!(check_access(W_OK, OWNER, OWNER_GID, 0o000, ROOT, ROOT, &[]).is_ok());
        assert!(check_access(R_OK | W_OK, OWNER, OWNER_GID, 0o000, ROOT, ROOT, &[]).is_ok());
    }

    #[test]
    fn root_cannot_execute_file_with_no_exec_bits() {
        // Regular file (no S_IFDIR) with mode 0o644 — no execute bits anywhere.
        assert_eq!(
            check_access(X_OK, OWNER, OWNER_GID, 0o644, ROOT, ROOT, &[]),
            Err(Errno::EACCES)
        );
    }

    #[test]
    fn root_can_execute_file_with_any_exec_bit() {
        // Only owner-execute set; root still gets X_OK.
        assert!(check_access(X_OK, OWNER, OWNER_GID, 0o100, ROOT, ROOT, &[]).is_ok());
        // Only group-execute.
        assert!(check_access(X_OK, OWNER, OWNER_GID, 0o010, ROOT, ROOT, &[]).is_ok());
        // Only other-execute.
        assert!(check_access(X_OK, OWNER, OWNER_GID, 0o001, ROOT, ROOT, &[]).is_ok());
    }

    #[test]
    fn root_can_traverse_directory_regardless_of_exec_bits() {
        // Directory with no execute bits anywhere — root may still search.
        let mode = S_IFDIR | 0o600;
        assert!(check_access(X_OK, OWNER, OWNER_GID, mode, ROOT, ROOT, &[]).is_ok());
        let mode = S_IFDIR | 0o000;
        assert!(check_access(X_OK, OWNER, OWNER_GID, mode, ROOT, ROOT, &[]).is_ok());
    }

    #[test]
    fn root_combined_request_with_missing_exec_bits_denied() {
        // R_OK | W_OK | X_OK on a 0o644 regular file — read+write granted but
        // execute fails because no x bit is set.
        assert_eq!(
            check_access(R_OK | W_OK | X_OK, OWNER, OWNER_GID, 0o644, ROOT, ROOT, &[]),
            Err(Errno::EACCES)
        );
    }

    // ---- Edge cases ----

    #[test]
    fn f_ok_alone_always_granted() {
        // Caller has no permissions whatsoever, but F_OK is just existence.
        assert!(check_access(F_OK, OWNER, OWNER_GID, 0o000, OTHER_UID, OTHER_GID, &[]).is_ok());
    }

    #[test]
    fn combined_rwx_request_on_0o755_for_owner() {
        assert!(
            check_access(R_OK | W_OK | X_OK, OWNER, OWNER_GID, 0o755, OWNER, OWNER_GID, &[])
                .is_ok()
        );
    }

    #[test]
    fn combined_rwx_request_on_0o755_for_other_denied_on_write() {
        // 0o755 → other gets r+x, no w.
        assert_eq!(
            check_access(R_OK | W_OK | X_OK, OWNER, OWNER_GID, 0o755, OTHER_UID, OTHER_GID, &[]),
            Err(Errno::EACCES)
        );
        // But R_OK | X_OK alone is fine.
        assert!(
            check_access(R_OK | X_OK, OWNER, OWNER_GID, 0o755, OTHER_UID, OTHER_GID, &[]).is_ok()
        );
    }

    #[test]
    fn high_bits_in_mode_are_ignored() {
        // setuid+setgid+sticky bits set, but only owner-read perm. Must still
        // grant only R_OK; W_OK/X_OK denied (high bits don't leak in).
        let mode = 0o7400; // S_ISUID | S_ISGID | S_ISVTX | S_IRUSR
        assert!(check_access(R_OK, OWNER, OWNER_GID, mode, OWNER, OWNER_GID, &[]).is_ok());
        assert_eq!(
            check_access(W_OK, OWNER, OWNER_GID, mode, OWNER, OWNER_GID, &[]),
            Err(Errno::EACCES)
        );
    }
}
