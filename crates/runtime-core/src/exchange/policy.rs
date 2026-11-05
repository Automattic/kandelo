//! Where names may appear and move on the exchange filesystem.
//!
//! Every object has one owner, and every transfer between owners is a move,
//! so a name can never give an object a second owner:
//!
//! | Area | Allowed | Refused (EPERM) |
//! |---|---|---|
//! | `inbox/` | read; remove entries and whole batches | create, rename or link in or out |
//! | `work/<n>/` | anything, including copies within the session | links or renames to another session or `inbox/` |
//! | `outbox/` | appear only by rename from a session (publishing); unlink (withdrawing) | direct create, links in or out, rename within |
//! | mount root, `inbox/`, `work/`, `outbox/`, device nodes | nothing | creating beside them, removing them |
//!
//! Mode bits express most of this, so an unprivileged caller usually meets
//! EACCES first; these checks also bind root. Moving to or from another
//! filesystem is EXDEV, as for any two mounts, so `mv` falls back to a copy
//! that lands in a session or fails here.

use wasm_posix_shared::Errno;

use super::device::WORK_DIR;
use super::xattr::{area, Area};
use super::{batches, owns_path, MOUNT_PATH};

const WORK_ROOT: &[u8] = b"/run/kandelo/exchange/work/";
const OUTBOX: &[u8] = b"/run/kandelo/exchange/outbox";

/// A name inside a session (not the session directory itself).
fn in_session(path: &[u8]) -> bool {
    area(path) == Area::Session && parent(path) != WORK_DIR
}

fn parent(path: &[u8]) -> &[u8] {
    match path.iter().rposition(|&byte| byte == b'/') {
        Some(0) => b"/",
        Some(index) => &path[..index],
        None => b"",
    }
}

/// The session a path lies in (the session directory included), by number.
fn session_of(path: &[u8]) -> Option<&[u8]> {
    let rest = path.strip_prefix(WORK_ROOT)?;
    let number = rest.split(|&byte| byte == b'/').next()?;
    (!number.is_empty() && number != b"clone").then_some(number)
}

/// May a new name appear at `path`? Only inside a work session.
pub fn check_create(path: &[u8]) -> Result<(), Errno> {
    if !owns_path(path) {
        return Ok(());
    }
    if path == MOUNT_PATH {
        return Err(Errno::EEXIST);
    }
    if area(parent(path)) == Area::Session {
        Ok(())
    } else {
        Err(Errno::EPERM)
    }
}

/// May the name at `path` be removed?
pub fn check_remove(path: &[u8]) -> Result<(), Errno> {
    if !owns_path(path) {
        return Ok(());
    }
    match area(path) {
        Area::Fixed => Err(Errno::EPERM),
        // The session directory itself ends with its description.
        Area::Session if parent(path) == WORK_DIR => Err(Errno::EPERM),
        _ => Ok(()),
    }
}

/// What a permitted rename is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rename {
    /// An ordinary rename; also how the other filesystems' renames, and
    /// cross-mount renames (EXDEV), proceed.
    Ordinary,
    /// From a work session to a direct child of `outbox/`: publishing.
    Publish,
}

pub fn check_rename(old: &[u8], new: &[u8]) -> Result<Rename, Errno> {
    if !owns_path(old) || !owns_path(new) {
        // At most one side is here: the usual cross-device rule applies.
        return Ok(Rename::Ordinary);
    }
    let from = if in_session(old) { session_of(old) } else { None };
    match from {
        Some(_) if parent(new) == OUTBOX => Ok(Rename::Publish),
        Some(session) if session_of(new) == Some(session) && area(parent(new)) == Area::Session => {
            Ok(Rename::Ordinary)
        }
        _ => Err(Errno::EPERM),
    }
}

/// Hard links stay inside one session: a second name elsewhere would give an
/// object a second owner, or keep an input's host source alive past its batch.
pub fn check_link(old: &[u8], new: &[u8]) -> Result<(), Errno> {
    if !owns_path(old) || !owns_path(new) {
        // At most one side is here: the usual cross-device rule applies.
        return Ok(());
    }
    let same_session = session_of(old).is_some() && session_of(old) == session_of(new);
    if same_session && in_session(old) && area(parent(new)) == Area::Session {
        Ok(())
    } else {
        Err(Errno::EPERM)
    }
}

/// Whether `path` names a batch directory (its removal acknowledges it).
pub fn is_batch_directory(path: &[u8]) -> bool {
    batches::inbox_child_name(path).is_some()
}

/// The name of `path` if it is a direct child of `outbox/`.
pub fn outbox_child_name(path: &[u8]) -> Option<&[u8]> {
    let rest = path.strip_prefix(OUTBOX)?.strip_prefix(b"/")?;
    (!rest.is_empty() && !rest.contains(&b'/')).then_some(rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BATCH: &[u8] = b"/run/kandelo/exchange/inbox/0192f3a1-7c4e-8a2b-8f00-3c1d9e5b4a10";

    #[test]
    fn names_appear_only_inside_work_sessions() {
        assert_eq!(check_create(b"/run/kandelo/exchange/work/3/a"), Ok(()));
        assert_eq!(check_create(b"/run/kandelo/exchange/work/3/dir/a"), Ok(()));
        for refused in [
            &b"/run/kandelo/exchange/x"[..],
            b"/run/kandelo/exchange/inbox/x",
            b"/run/kandelo/exchange/work/9",
            b"/run/kandelo/exchange/outbox/a",
        ] {
            assert_eq!(check_create(refused), Err(Errno::EPERM), "{}", core::str::from_utf8(refused).unwrap());
        }
        let mut inside_batch = BATCH.to_vec();
        inside_batch.extend_from_slice(b"/new");
        assert_eq!(check_create(&inside_batch), Err(Errno::EPERM));
        assert_eq!(check_create(b"/tmp/anything"), Ok(()));
    }

    #[test]
    fn renames_stay_in_a_session_or_publish() {
        assert_eq!(check_rename(b"/run/kandelo/exchange/work/3/a", b"/run/kandelo/exchange/work/3/b"), Ok(Rename::Ordinary));
        assert_eq!(check_rename(b"/run/kandelo/exchange/work/3/a", b"/run/kandelo/exchange/outbox/a"), Ok(Rename::Publish));
        assert_eq!(check_rename(b"/run/kandelo/exchange/work/3/a", b"/run/kandelo/exchange/work/4/a"), Err(Errno::EPERM));
        assert_eq!(check_rename(b"/run/kandelo/exchange/work/3/a", b"/run/kandelo/exchange/outbox/d/a"), Err(Errno::EPERM));
        assert_eq!(check_rename(b"/run/kandelo/exchange/work/3", b"/run/kandelo/exchange/outbox/3"), Err(Errno::EPERM));
        assert_eq!(check_rename(b"/run/kandelo/exchange/outbox/a", b"/run/kandelo/exchange/outbox/b"), Err(Errno::EPERM));
        assert_eq!(check_rename(b"/run/kandelo/exchange/outbox/a", b"/run/kandelo/exchange/work/3/a"), Err(Errno::EPERM));
        let mut input = BATCH.to_vec();
        input.extend_from_slice(b"/a");
        assert_eq!(check_rename(&input, b"/run/kandelo/exchange/work/3/a"), Err(Errno::EPERM));
        assert_eq!(check_rename(b"/tmp/a", b"/run/kandelo/exchange/work/3/a"), Ok(Rename::Ordinary), "EXDEV decides");
    }

    #[test]
    fn links_stay_inside_one_session() {
        assert_eq!(check_link(b"/run/kandelo/exchange/work/3/a", b"/run/kandelo/exchange/work/3/b"), Ok(()));
        assert_eq!(check_link(b"/run/kandelo/exchange/work/3/a", b"/run/kandelo/exchange/work/4/b"), Err(Errno::EPERM));
        assert_eq!(check_link(b"/run/kandelo/exchange/work/3/a", b"/run/kandelo/exchange/outbox/b"), Err(Errno::EPERM));
        let mut input = BATCH.to_vec();
        input.extend_from_slice(b"/a");
        assert_eq!(check_link(&input, b"/run/kandelo/exchange/work/3/a"), Err(Errno::EPERM));
        assert_eq!(check_link(b"/tmp/a", b"/tmp/b"), Ok(()));
    }

    #[test]
    fn fixed_names_and_session_directories_cannot_be_removed() {
        for fixed in [&b"/run/kandelo/exchange/events"[..], b"/run/kandelo/exchange/inbox", b"/run/kandelo/exchange/work/clone", b"/run/kandelo/exchange/work/3"] {
            assert_eq!(check_remove(fixed), Err(Errno::EPERM), "{}", core::str::from_utf8(fixed).unwrap());
        }
        assert_eq!(check_remove(BATCH), Ok(()));
        assert_eq!(check_remove(b"/run/kandelo/exchange/work/3/a"), Ok(()));
        assert_eq!(check_remove(b"/run/kandelo/exchange/outbox/a"), Ok(()));
    }
}
