//! Extended attributes on the exchange filesystem.
//!
//! Only the `user.` namespace exists here; other namespaces are ENOTSUP, as on
//! a Linux filesystem that implements only user attributes. Reading needs
//! read permission and changing needs write permission, as on Linux, and then
//! the exchange rules decide what may change:
//!
//! | Where | May change |
//! |---|---|
//! | A batch directory, `inbox/<id>` | `user.kandelo.status` only |
//! | Anything else in `inbox/` | nothing: inputs are read-only |
//! | A work session file | any `user.` name except reserved `user.kandelo.*` ones; of those, only `user.kandelo.derived_from` |
//! | A published output, `outbox/<name>` | a streamed output's `user.kandelo.end`, once (see `outputs::set_end`) |
//! | The mount root, `inbox/`, `work/`, `outbox/`, device nodes | nothing |
//!
//! Published outputs are otherwise frozen. Linux permits `user.`
//! attributes only on regular files and directories; this filesystem also
//! allows them on FIFOs, a documented difference from Linux that POSIX, which
//! defines no extended attributes, does not forbid.

use alloc::vec::Vec;
use wasm_posix_shared::Errno;

use super::batches;
use super::ids;

/// The largest value this filesystem stores.
pub const MAX_VALUE_BYTES: usize = 4096;
/// The longest `user.kandelo.status`.
pub const MAX_STATUS_BYTES: usize = 256;
/// The most items `user.kandelo.derived_from` may name.
pub const MAX_DERIVED_FROM: usize = 64;

const SESSION_ROOT: &[u8] = b"/run/kandelo/exchange/work/";
const OUTBOX_ROOT: &[u8] = b"/run/kandelo/exchange/outbox/";

/// Where in the exchange layout a path sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Area {
    /// `inbox/<id>`.
    BatchDirectory,
    /// Anything below a batch directory.
    Input,
    /// Anything below `work/<n>/`, the session directory included.
    Session,
    /// Anything below `outbox/`.
    Output,
    /// The mount root, the fixed directories, the device nodes.
    Fixed,
}

/// Classify a canonical path on the exchange mount.
pub fn area(path: &[u8]) -> Area {
    if batches::inbox_child_name(path).is_some() {
        return Area::BatchDirectory;
    }
    if let Some(rest) = path.strip_prefix(batches::INBOX_DIR).and_then(|rest| rest.strip_prefix(b"/")) {
        if !rest.is_empty() {
            return Area::Input;
        }
    }
    if let Some(rest) = path.strip_prefix(SESSION_ROOT) {
        if !rest.is_empty() && rest != b"clone" {
            return Area::Session;
        }
    }
    if let Some(rest) = path.strip_prefix(OUTBOX_ROOT) {
        if !rest.is_empty() {
            return Area::Output;
        }
    }
    Area::Fixed
}

/// Refuse names outside `user.`, empty `user.` names included.
pub fn check_namespace(name: &[u8]) -> Result<(), Errno> {
    match name.strip_prefix(b"user.") {
        Some(rest) if !rest.is_empty() => Ok(()),
        _ => Err(Errno::ENOTSUP),
    }
}

/// Whether `name` may be set or removed at `path` (permission already checked).
pub fn check_change(path: &[u8], name: &[u8], value: Option<&[u8]>) -> Result<(), Errno> {
    check_namespace(name)?;
    if let Some(value) = value {
        if value.len() > MAX_VALUE_BYTES {
            return Err(Errno::E2BIG);
        }
    }
    match area(path) {
        Area::BatchDirectory if name == b"user.kandelo.status" => {
            if let Some(status) = value {
                validate_status(status)?;
            }
            Ok(())
        }
        Area::Session => {
            if name == b"user.kandelo.derived_from" {
                if let Some(list) = value {
                    validate_derived_from(list)?;
                }
                Ok(())
            } else if name.starts_with(b"user.kandelo.") {
                Err(Errno::EPERM)
            } else {
                Ok(())
            }
        }
        // Validated, and limited to unfinished streams, by `outputs::set_end`.
        Area::Output if name == super::outputs::END_NAME && value.is_some() => Ok(()),
        _ => Err(Errno::EPERM),
    }
}

/// Whether setting `name` at `path` declares a stream's end.
pub fn is_stream_end(path: &[u8], name: &[u8]) -> bool {
    name == super::outputs::END_NAME && area(path) == Area::Output
}

/// A status is one line of UTF-8 text, at most 256 bytes, no control
/// characters: the host shows it as progress.
fn validate_status(status: &[u8]) -> Result<(), Errno> {
    if status.len() > MAX_STATUS_BYTES {
        return Err(Errno::E2BIG);
    }
    let text = core::str::from_utf8(status).map_err(|_| Errno::EINVAL)?;
    if text.chars().any(char::is_control) {
        return Err(Errno::EINVAL);
    }
    Ok(())
}

/// One ID issued by this mount per line, at most 64; a trailing newline is
/// allowed. IDs from another machine or an earlier boot are EINVAL.
fn validate_derived_from(list: &[u8]) -> Result<(), Errno> {
    let body = list.strip_suffix(b"\n").unwrap_or(list);
    if body.is_empty() {
        return Ok(());
    }
    let lines: Vec<&[u8]> = body.split(|&byte| byte == b'\n').collect();
    if lines.len() > MAX_DERIVED_FROM {
        return Err(Errno::E2BIG);
    }
    for line in lines {
        let id = ids::parse(line)?;
        batches::validate_id(&id)?;
    }
    Ok(())
}

/// Serve a get: the size alone for an empty buffer, ERANGE for a short one.
pub fn copy_value(value: &[u8], out: &mut [u8]) -> Result<usize, Errno> {
    if out.is_empty() {
        return Ok(value.len());
    }
    if out.len() < value.len() {
        return Err(Errno::ERANGE);
    }
    out[..value.len()].copy_from_slice(value);
    Ok(value.len())
}

/// Serve a list: NUL-terminated names, the size alone for an empty buffer,
/// ERANGE for a short one.
pub fn copy_names(names: &[Vec<u8>], out: &mut [u8]) -> Result<usize, Errno> {
    let total: usize = names.iter().map(|name| name.len() + 1).sum();
    if out.is_empty() {
        return Ok(total);
    }
    if out.len() < total {
        return Err(Errno::ERANGE);
    }
    let mut position = 0;
    for name in names {
        out[position..position + name.len()].copy_from_slice(name);
        out[position + name.len()] = 0;
        position += name.len() + 1;
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn areas_follow_the_exchange_layout() {
        let id = b"/run/kandelo/exchange/inbox/0192f3a1-7c4e-8a2b-8f00-3c1d9e5b4a10";
        assert_eq!(area(id), Area::BatchDirectory);
        let mut entry = id.to_vec();
        entry.extend_from_slice(b"/photo.jpg");
        assert_eq!(area(&entry), Area::Input);
        assert_eq!(area(b"/run/kandelo/exchange/work/3"), Area::Session);
        assert_eq!(area(b"/run/kandelo/exchange/work/3/a"), Area::Session);
        assert_eq!(area(b"/run/kandelo/exchange/work/clone"), Area::Fixed);
        assert_eq!(area(b"/run/kandelo/exchange/outbox/a.pdf"), Area::Output);
        for fixed in [&b"/run/kandelo/exchange"[..], b"/run/kandelo/exchange/inbox", b"/run/kandelo/exchange/outbox", b"/run/kandelo/exchange/events"] {
            assert_eq!(area(fixed), Area::Fixed);
        }
    }

    #[test]
    fn only_the_user_namespace_exists() {
        assert_eq!(check_namespace(b"user.a"), Ok(()));
        for name in [&b"user."[..], b"trusted.a", b"security.selinux", b"system.posix_acl_access", b"a"] {
            assert_eq!(check_namespace(name), Err(Errno::ENOTSUP));
        }
    }

    #[test]
    fn what_may_change_depends_on_where() {
        let batch = b"/run/kandelo/exchange/inbox/0192f3a1-7c4e-8a2b-8f00-3c1d9e5b4a10";
        assert_eq!(check_change(batch, b"user.kandelo.status", Some(b"saved 3 files")), Ok(()));
        assert_eq!(check_change(batch, b"user.kandelo.status", Some(b"two\nlines")), Err(Errno::EINVAL));
        assert_eq!(check_change(batch, b"user.kandelo.status", Some(&[b'x'; 257])), Err(Errno::E2BIG));
        assert_eq!(check_change(batch, b"user.mime_type", Some(b"x")), Err(Errno::EPERM));
        let mut input = batch.to_vec();
        input.extend_from_slice(b"/a");
        assert_eq!(check_change(&input, b"user.mime_type", Some(b"x")), Err(Errno::EPERM));
        let session = b"/run/kandelo/exchange/work/1/out.png";
        assert_eq!(check_change(session, b"user.mime_type", Some(b"image/png")), Ok(()));
        assert_eq!(check_change(session, b"user.xdg.origin.url", Some(b"https://example.com/")), Ok(()));
        assert_eq!(check_change(session, b"user.kandelo.id", Some(b"x")), Err(Errno::EPERM));
        assert_eq!(check_change(session, b"user.mime_type", Some(&[b'x'; 4097])), Err(Errno::E2BIG));
        assert_eq!(check_change(b"/run/kandelo/exchange/outbox/a", b"user.mime_type", None), Err(Errno::EPERM));
        assert_eq!(check_change(b"/run/kandelo/exchange/inbox", b"user.a", Some(b"x")), Err(Errno::EPERM));
    }

    #[test]
    fn provenance_names_only_ids_this_mount_issued() {
        let _guard = batches::tests::TestGuard::acquire();
        let batch = batches::begin(b"api", 1).unwrap();
        let entry = batches::add_entry(&batch, batches::tests::file(&[b"a"], 1, 1), 1).unwrap();
        let session = b"/run/kandelo/exchange/work/1/out";
        let mut list = ids::format(&batch).to_vec();
        list.push(b'\n');
        list.extend_from_slice(&ids::format(&entry));
        list.push(b'\n');
        assert_eq!(check_change(session, b"user.kandelo.derived_from", Some(&list)), Ok(()));
        assert_eq!(check_change(session, b"user.kandelo.derived_from", Some(b"")), Ok(()));
        assert_eq!(check_change(session, b"user.kandelo.derived_from", Some(b"7")), Err(Errno::EINVAL));
        let foreign = ids::IdIssuer::new(0xF00D).issue(1).unwrap();
        assert_eq!(
            check_change(session, b"user.kandelo.derived_from", Some(&ids::format(&foreign))),
            Err(Errno::EINVAL)
        );
        let mut too_many = Vec::new();
        for _ in 0..=MAX_DERIVED_FROM {
            too_many.extend_from_slice(&ids::format(&entry));
            too_many.push(b'\n');
        }
        // 65 lines of 37 bytes exceed the 4 KiB cap first; both limits hold.
        assert!(matches!(
            check_change(session, b"user.kandelo.derived_from", Some(&too_many)),
            Err(Errno::E2BIG)
        ));
    }

    #[test]
    fn get_and_list_follow_the_size_conventions() {
        let mut out = [0u8; 4];
        assert_eq!(copy_value(b"abc", &mut []), Ok(3));
        assert_eq!(copy_value(b"abcde", &mut out), Err(Errno::ERANGE));
        assert_eq!(copy_value(b"ab", &mut out), Ok(2));
        let names = [b"user.a".to_vec(), b"user.bb".to_vec()];
        assert_eq!(copy_names(&names, &mut []), Ok(15));
        let mut list = [0u8; 15];
        assert_eq!(copy_names(&names, &mut list), Ok(15));
        assert_eq!(&list, b"user.a\0user.bb\0");
        assert_eq!(copy_names(&names, &mut [0u8; 14]), Err(Errno::ERANGE));
    }
}
