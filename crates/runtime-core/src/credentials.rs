extern crate alloc;

use alloc::vec::Vec;
use wasm_posix_shared::Errno;

pub const NGROUPS_MAX: usize = 32;
pub const ID_UNCHANGED: u32 = u32::MAX;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Credentials {
    pub ruid: u32,
    pub euid: u32,
    pub suid: u32,
    pub rgid: u32,
    pub egid: u32,
    pub sgid: u32,
    pub supplementary_groups: Vec<u32>,
}

impl Credentials {
    pub fn root() -> Self {
        Self::from_ids(0, 0)
    }

    pub fn from_ids(uid: u32, gid: u32) -> Self {
        Self {
            ruid: uid,
            euid: uid,
            suid: uid,
            rgid: gid,
            egid: gid,
            sgid: gid,
            supplementary_groups: Vec::new(),
        }
    }

    pub fn is_member_of_group(&self, gid: u32) -> bool {
        gid == self.egid || self.supplementary_groups.contains(&gid)
    }

    pub fn setuid(&mut self, uid: u32) -> Result<(), Errno> {
        let mut candidate = self.clone();
        if self.euid == 0 {
            candidate.ruid = uid;
            candidate.euid = uid;
            candidate.suid = uid;
        } else if uid == self.ruid || uid == self.suid {
            candidate.euid = uid;
        } else {
            return Err(Errno::EPERM);
        }
        *self = candidate;
        Ok(())
    }

    pub fn seteuid(&mut self, uid: u32) -> Result<(), Errno> {
        let mut candidate = self.clone();
        if self.euid == 0 || uid == self.ruid || uid == self.suid {
            candidate.euid = uid;
        } else {
            return Err(Errno::EPERM);
        }
        *self = candidate;
        Ok(())
    }

    pub fn setresuid(&mut self, ruid: u32, euid: u32, suid: u32) -> Result<(), Errno> {
        if self.euid != 0
            && [ruid, euid, suid].into_iter().any(|requested| {
                requested != ID_UNCHANGED
                    && requested != self.ruid
                    && requested != self.euid
                    && requested != self.suid
            })
        {
            return Err(Errno::EPERM);
        }

        let mut candidate = self.clone();
        if ruid != ID_UNCHANGED {
            candidate.ruid = ruid;
        }
        if euid != ID_UNCHANGED {
            candidate.euid = euid;
        }
        if suid != ID_UNCHANGED {
            candidate.suid = suid;
        }
        *self = candidate;
        Ok(())
    }

    pub fn setreuid(&mut self, ruid: u32, euid: u32) -> Result<(), Errno> {
        if self.euid != 0 {
            let real_allowed = ruid == ID_UNCHANGED || ruid == self.ruid;
            let effective_allowed = euid == ID_UNCHANGED
                || euid == self.ruid
                || euid == self.euid
                || euid == self.suid;
            if !real_allowed || !effective_allowed {
                return Err(Errno::EPERM);
            }
        }

        let mut candidate = self.clone();
        if ruid != ID_UNCHANGED {
            candidate.ruid = ruid;
        }
        if euid != ID_UNCHANGED {
            candidate.euid = euid;
        }
        if ruid != ID_UNCHANGED
            || (euid != ID_UNCHANGED && candidate.euid != candidate.ruid)
        {
            candidate.suid = candidate.euid;
        }
        *self = candidate;
        Ok(())
    }

    pub fn setgid(&mut self, gid: u32) -> Result<(), Errno> {
        let mut candidate = self.clone();
        if self.euid == 0 {
            candidate.rgid = gid;
            candidate.egid = gid;
            candidate.sgid = gid;
        } else if gid == self.rgid || gid == self.sgid {
            candidate.egid = gid;
        } else {
            return Err(Errno::EPERM);
        }
        *self = candidate;
        Ok(())
    }

    pub fn setegid(&mut self, gid: u32) -> Result<(), Errno> {
        let mut candidate = self.clone();
        if self.euid == 0 || gid == self.rgid || gid == self.sgid {
            candidate.egid = gid;
        } else {
            return Err(Errno::EPERM);
        }
        *self = candidate;
        Ok(())
    }

    pub fn setresgid(&mut self, rgid: u32, egid: u32, sgid: u32) -> Result<(), Errno> {
        if self.euid != 0
            && [rgid, egid, sgid].into_iter().any(|requested| {
                requested != ID_UNCHANGED
                    && requested != self.rgid
                    && requested != self.egid
                    && requested != self.sgid
            })
        {
            return Err(Errno::EPERM);
        }

        let mut candidate = self.clone();
        if rgid != ID_UNCHANGED {
            candidate.rgid = rgid;
        }
        if egid != ID_UNCHANGED {
            candidate.egid = egid;
        }
        if sgid != ID_UNCHANGED {
            candidate.sgid = sgid;
        }
        *self = candidate;
        Ok(())
    }

    pub fn setregid(&mut self, rgid: u32, egid: u32) -> Result<(), Errno> {
        if self.euid != 0 {
            let real_allowed =
                rgid == ID_UNCHANGED || rgid == self.rgid || rgid == self.sgid;
            let effective_allowed = egid == ID_UNCHANGED
                || egid == self.rgid
                || egid == self.egid
                || egid == self.sgid;
            if !real_allowed || !effective_allowed {
                return Err(Errno::EPERM);
            }
        }

        let mut candidate = self.clone();
        if rgid != ID_UNCHANGED {
            candidate.rgid = rgid;
        }
        if egid != ID_UNCHANGED {
            candidate.egid = egid;
        }
        if rgid != ID_UNCHANGED
            || (egid != ID_UNCHANGED && candidate.egid != candidate.rgid)
        {
            candidate.sgid = candidate.egid;
        }
        *self = candidate;
        Ok(())
    }

    pub fn setgroups(&mut self, groups: &[u32]) -> Result<(), Errno> {
        if self.euid != 0 {
            return Err(Errno::EPERM);
        }
        if groups.len() > NGROUPS_MAX {
            return Err(Errno::EINVAL);
        }

        let mut candidate = self.clone();
        candidate.supplementary_groups = groups.to_vec();
        *self = candidate;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{Credentials, ID_UNCHANGED, NGROUPS_MAX};
    use wasm_posix_shared::Errno;

    fn nonroot() -> Credentials {
        Credentials {
            ruid: 1000,
            euid: 2000,
            suid: 3000,
            rgid: 4000,
            egid: 5000,
            sgid: 6000,
            supplementary_groups: alloc::vec![7000, 8000],
        }
    }

    #[test]
    fn credentials_uid_transition_table_is_atomic() {
        let mut root = Credentials::root();
        assert_eq!(root.setuid(1000), Ok(()));
        assert_eq!((root.ruid, root.euid, root.suid), (1000, 1000, 1000));

        let mut nonroot = nonroot();
        assert_eq!(nonroot.seteuid(1000), Ok(()));
        assert_eq!(
            (nonroot.ruid, nonroot.euid, nonroot.suid),
            (1000, 1000, 3000)
        );
        assert_eq!(nonroot.seteuid(3000), Ok(()));
        assert_eq!(
            (nonroot.ruid, nonroot.euid, nonroot.suid),
            (1000, 3000, 3000)
        );
        assert_eq!(nonroot.setuid(1000), Ok(()));
        assert_eq!(
            (nonroot.ruid, nonroot.euid, nonroot.suid),
            (1000, 1000, 3000)
        );

        let before = nonroot.clone();
        assert_eq!(nonroot.setuid(9000), Err(Errno::EPERM));
        assert_eq!(nonroot, before);

        assert_eq!(
            nonroot.setresuid(ID_UNCHANGED, 3000, ID_UNCHANGED),
            Ok(()),
        );
        assert_eq!(
            (nonroot.ruid, nonroot.euid, nonroot.suid),
            (1000, 3000, 3000)
        );

        let before = nonroot.clone();
        assert_eq!(
            nonroot.setresuid(ID_UNCHANGED, 9000, ID_UNCHANGED),
            Err(Errno::EPERM),
        );
        assert_eq!(nonroot, before);

        let mut root = Credentials::root();
        assert_eq!(root.setresuid(1000, 1000, 1000), Ok(()));
        assert_eq!((root.ruid, root.euid, root.suid), (1000, 1000, 1000));
    }

    #[test]
    fn credentials_gid_transition_table_is_atomic() {
        let mut root = Credentials::root();
        assert_eq!(root.setgid(4000), Ok(()));
        assert_eq!((root.rgid, root.egid, root.sgid), (4000, 4000, 4000));

        let mut nonroot = nonroot();
        assert_eq!(nonroot.setegid(4000), Ok(()));
        assert_eq!(
            (nonroot.rgid, nonroot.egid, nonroot.sgid),
            (4000, 4000, 6000)
        );
        assert_eq!(nonroot.setegid(6000), Ok(()));
        assert_eq!(
            (nonroot.rgid, nonroot.egid, nonroot.sgid),
            (4000, 6000, 6000)
        );
        assert_eq!(nonroot.setgid(4000), Ok(()));
        assert_eq!(
            (nonroot.rgid, nonroot.egid, nonroot.sgid),
            (4000, 4000, 6000)
        );

        let before = nonroot.clone();
        assert_eq!(nonroot.setgid(9000), Err(Errno::EPERM));
        assert_eq!(nonroot, before);

        assert_eq!(
            nonroot.setresgid(ID_UNCHANGED, 6000, ID_UNCHANGED),
            Ok(()),
        );
        assert_eq!(
            (nonroot.rgid, nonroot.egid, nonroot.sgid),
            (4000, 6000, 6000)
        );

        let before = nonroot.clone();
        assert_eq!(
            nonroot.setresgid(ID_UNCHANGED, 9000, ID_UNCHANGED),
            Err(Errno::EPERM),
        );
        assert_eq!(nonroot, before);

        let mut root = Credentials::root();
        assert_eq!(root.setresgid(4000, 4000, 4000), Ok(()));
        assert_eq!((root.rgid, root.egid, root.sgid), (4000, 4000, 4000));
    }

    #[test]
    fn credentials_setreuid_transition_table_updates_saved_id_atomically() {
        for (ruid, euid, expected) in [
            (1000, 1000, (1000, 1000, 1000)),
            (ID_UNCHANGED, 1000, (0, 1000, 1000)),
            (1000, ID_UNCHANGED, (1000, 0, 0)),
        ] {
            let mut root = Credentials::root();
            assert_eq!(root.setreuid(ruid, euid), Ok(()));
            assert_eq!((root.ruid, root.euid, root.suid), expected);
        }

        for (ruid, euid, expected) in [
            (ID_UNCHANGED, 1000, (1000, 1000, 3000)),
            (ID_UNCHANGED, 2000, (1000, 2000, 2000)),
            (ID_UNCHANGED, 3000, (1000, 3000, 3000)),
            (1000, 1000, (1000, 1000, 1000)),
        ] {
            let mut credentials = nonroot();
            assert_eq!(credentials.setreuid(ruid, euid), Ok(()));
            assert_eq!(
                (credentials.ruid, credentials.euid, credentials.suid),
                expected,
            );
        }

        let mut credentials = nonroot();
        assert_eq!(
            credentials.setreuid(ID_UNCHANGED, ID_UNCHANGED),
            Ok(()),
        );
        assert_eq!(credentials, nonroot());

        for request in [
            (2000, ID_UNCHANGED),
            (3000, ID_UNCHANGED),
            (ID_UNCHANGED, 9000),
        ] {
            let mut credentials = nonroot();
            let before = credentials.clone();
            assert_eq!(
                credentials.setreuid(request.0, request.1),
                Err(Errno::EPERM),
            );
            assert_eq!(credentials, before);
        }
    }

    #[test]
    fn credentials_setregid_transition_table_updates_saved_id_atomically() {
        for (rgid, egid, expected) in [
            (4000, 4000, (4000, 4000, 4000)),
            (ID_UNCHANGED, 4000, (0, 4000, 4000)),
            (4000, ID_UNCHANGED, (4000, 0, 0)),
        ] {
            let mut root = Credentials::root();
            assert_eq!(root.setregid(rgid, egid), Ok(()));
            assert_eq!((root.rgid, root.egid, root.sgid), expected);
        }

        for (rgid, egid, expected) in [
            (ID_UNCHANGED, 4000, (4000, 4000, 6000)),
            (ID_UNCHANGED, 5000, (4000, 5000, 5000)),
            (ID_UNCHANGED, 6000, (4000, 6000, 6000)),
            (6000, ID_UNCHANGED, (6000, 5000, 5000)),
            (4000, 4000, (4000, 4000, 4000)),
        ] {
            let mut credentials = nonroot();
            assert_eq!(credentials.setregid(rgid, egid), Ok(()));
            assert_eq!(
                (credentials.rgid, credentials.egid, credentials.sgid),
                expected,
            );
        }

        let mut credentials = nonroot();
        assert_eq!(
            credentials.setregid(ID_UNCHANGED, ID_UNCHANGED),
            Ok(()),
        );
        assert_eq!(credentials, nonroot());

        for request in [(5000, ID_UNCHANGED), (ID_UNCHANGED, 9000)] {
            let mut credentials = nonroot();
            let before = credentials.clone();
            assert_eq!(
                credentials.setregid(request.0, request.1),
                Err(Errno::EPERM),
            );
            assert_eq!(credentials, before);
        }
    }

    #[test]
    fn supplementary_groups_preserve_order_and_enforce_the_limit_atomically() {
        let mut root = Credentials::root();
        assert_eq!(root.setgroups(&[]), Ok(()));
        assert!(root.supplementary_groups.is_empty());

        let ordered = [9, 3, 9, 7];
        assert_eq!(root.setgroups(&ordered), Ok(()));
        assert_eq!(root.supplementary_groups, ordered);

        let exact: alloc::vec::Vec<u32> = (0..NGROUPS_MAX as u32).collect();
        assert_eq!(root.setgroups(&exact), Ok(()));
        assert_eq!(root.supplementary_groups, exact);

        let before = root.clone();
        let oversized: alloc::vec::Vec<u32> = (0..=NGROUPS_MAX as u32).collect();
        assert_eq!(root.setgroups(&oversized), Err(Errno::EINVAL));
        assert_eq!(root, before);

        let mut nonroot = nonroot();
        let before = nonroot.clone();
        assert_eq!(nonroot.setgroups(&[42]), Err(Errno::EPERM));
        assert_eq!(nonroot, before);
    }

    #[test]
    fn group_membership_uses_effective_primary_and_supplementary_groups() {
        let credentials = nonroot();

        assert!(credentials.is_member_of_group(5000));
        assert!(credentials.is_member_of_group(7000));
        assert!(credentials.is_member_of_group(8000));
        assert!(!credentials.is_member_of_group(4000));
        assert!(!credentials.is_member_of_group(9000));
    }
}
