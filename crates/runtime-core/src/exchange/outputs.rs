//! Publishing outputs: a rename from a work session into `outbox/`.
//!
//! The rename is atomic, so `outbox/` only ever holds complete outputs. It
//! succeeds only when:
//!
//! - a host output listener exists (ENXIO otherwise: no one would take it);
//! - the source is a regular file (a stored output) or a FIFO (a streamed
//!   output); directories and symlinks are EPERM;
//! - nothing has the source open or mapped and it has no other name (EBUSY),
//!   so the published bytes cannot change underneath the host and the file is
//!   published at most once, and a stream's writer opens only after
//!   publishing;
//! - the name is new in `outbox/` (EEXIST), so a publish never replaces an
//!   earlier output;
//! - fewer than 64 outputs await the host, and fewer than 8 of them are
//!   unfinished streams (ENOSPC).
//!
//! On success the output is frozen, gets its exchange ID, and is announced
//! to the host. A guest may still unlink it, which withdraws it. A streamed
//! output's one permitted change is `user.kandelo.end` ([`set_end`]), which
//! declares how the stream ended and seals it against further writes.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::cell::UnsafeCell;
use core::hint::spin_loop;
use core::sync::atomic::{AtomicBool, Ordering};
use wasm_posix_shared::mode::{S_IFDIR, S_IFIFO, S_IFLNK, S_IFMT, S_IFREG};
use wasm_posix_shared::Errno;

use super::batches::{self, Notification};
use super::{device, ids};

const ID_NAME: &[u8] = b"user.kandelo.id";
/// How a streamed output ended: `complete` or `aborted <reason>`.
pub const END_NAME: &[u8] = b"user.kandelo.end";
/// The longest `aborted` reason.
pub const MAX_END_REASON_BYTES: usize = 256;
const OUTBOX: &[u8] = b"/run/kandelo/exchange/outbox";

/// Published outputs not yet released by the host (spec quota).
pub const MAX_STORED_OUTPUTS: usize = 64;

/// Published outputs by ID, to their path, until the host releases them or
/// the guest withdraws them.
struct Published {
    locked: AtomicBool,
    paths: UnsafeCell<BTreeMap<ids::ExchangeId, Vec<u8>>>,
}

// SAFETY: `locked` serializes every access; no reference escapes `with`.
unsafe impl Sync for Published {}

static PUBLISHED: Published = Published {
    locked: AtomicBool::new(false),
    paths: UnsafeCell::new(BTreeMap::new()),
};

fn with<R>(f: impl FnOnce(&mut BTreeMap<ids::ExchangeId, Vec<u8>>) -> R) -> R {
    while PUBLISHED
        .locked
        .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        spin_loop();
    }
    struct Unlock;
    impl Drop for Unlock {
        fn drop(&mut self) {
            PUBLISHED.locked.store(false, Ordering::Release);
        }
    }
    let _unlock = Unlock;
    // SAFETY: see `Published`.
    f(unsafe { &mut *PUBLISHED.paths.get() })
}

/// Publish `old` (in a session) as `new` (a direct child of `outbox/`). The
/// caller has already checked permissions and the rename policy.
pub fn publish(old: &[u8], new: &[u8], now_ms: u64) -> Result<(), Errno> {
    if !device::outputs_accepting() {
        return Err(Errno::ENXIO);
    }
    let stat = crate::tmpfs::lstat(old)?;
    let stream_pipe = match stat.st_mode & S_IFMT {
        S_IFREG => None,
        S_IFIFO => Some(unsafe { crate::fifo::global_fifo_table() }.lookup(old).ok_or(Errno::EIO)?),
        S_IFDIR | S_IFLNK => return Err(Errno::EPERM),
        _ => return Err(Errno::EPERM),
    };
    if crate::tmpfs::lstat(new).is_ok() {
        return Err(Errno::EEXIST);
    }
    match stream_pipe {
        None => {
            // A second name (a hard link left in the session) could be
            // published again as another output of the same file.
            if !crate::tmpfs::is_unreferenced(old)? || stat.st_nlink != 1 {
                return Err(Errno::EBUSY);
            }
        }
        Some(pipe_idx) => {
            // No endpoint (a waiting open reserves one) and no second name.
            let pipe = unsafe { crate::pipe::global_pipe_table() }.get(pipe_idx).ok_or(Errno::EIO)?;
            if pipe.has_readers() || pipe.is_write_end_open() || pipe.fifo_name_count() != 1 {
                return Err(Errno::EBUSY);
            }
            if super::streams::unfinished_outputs() >= super::streams::MAX_UNFINISHED_OUTPUTS {
                return Err(Errno::ENOSPC);
            }
        }
    }
    if crate::tmpfs::dir_entry_count(OUTBOX)? >= MAX_STORED_OUTPUTS {
        return Err(Errno::ENOSPC);
    }
    let output = batches::issue_id(now_ms)?;
    let prepared_fifo = if stream_pipe.is_some() {
        Some(unsafe { crate::fifo::global_fifo_table() }.prepare_rename(old, new)?)
    } else { None };
    crate::tmpfs::rename(old, new)?;
    if let Some(prepared) = prepared_fifo {
        unsafe { crate::fifo::global_fifo_table() }.publish_rename(prepared, |_| unreachable!("the outbox name was new"));
    }
    with(|paths| paths.insert(output, new.to_vec()));
    crate::tmpfs::freeze(new)?;
    crate::tmpfs::xattr_set_kernel(new, ID_NAME, &ids::format(&output))?;
    if let Some(pipe_idx) = stream_pipe {
        super::streams::register_output(pipe_idx, output);
    }
    let name = super::policy::outbox_child_name(new).unwrap_or(new).to_vec();
    let mime_type = crate::tmpfs::xattr_get(new, b"user.mime_type").ok();
    let derived_from = crate::tmpfs::xattr_get(new, b"user.kandelo.derived_from")
        .map(|list| parse_ids(&list))
        .unwrap_or_default();
    batches::push_notification(Notification::OutputPublished {
        output,
        stream: stream_pipe.is_some(),
        name,
        size: if stream_pipe.is_some() { 0 } else { stat.st_size },
        mime_type,
        derived_from,
    });
    Ok(())
}

/// The output's ID, read before its name goes (an unlink withdraws it).
pub fn output_id(path: &[u8]) -> Option<ids::ExchangeId> {
    let text = crate::tmpfs::xattr_get(path, ID_NAME).ok()?;
    ids::parse(&text).ok()
}

/// A guest unlinked a published output. A stream's host reader closes, so
/// its writers get EPIPE.
pub fn on_withdrawn(output: ids::ExchangeId) {
    with(|paths| paths.remove(&output));
    super::streams::close_output(&output);
    batches::push_notification(Notification::OutputWithdrawn { output });
}

/// Set a published stream's `user.kandelo.end`, once: `complete`, or
/// `aborted <reason>` with a 1 to 256 byte UTF-8 reason on one line
/// (EINVAL otherwise). EPERM on anything but an unfinished streamed output.
/// Later writes to the stream fail with EPERM.
pub fn set_end(path: &[u8], value: &[u8]) -> Result<(), Errno> {
    let output = output_id(path).ok_or(Errno::EPERM)?;
    if !super::streams::is_output(&output) || crate::tmpfs::xattr_get(path, END_NAME).is_ok() {
        return Err(Errno::EPERM);
    }
    let valid = value == b"complete"
        || value.strip_prefix(b"aborted ").is_some_and(|reason| {
            !reason.is_empty()
                && reason.len() <= MAX_END_REASON_BYTES
                && core::str::from_utf8(reason).is_ok_and(|text| !text.chars().any(char::is_control))
        });
    if !valid {
        return Err(Errno::EINVAL);
    }
    let pipe_idx = unsafe { crate::fifo::global_fifo_table() }.lookup(path).ok_or(Errno::EPERM)?;
    crate::tmpfs::xattr_set_kernel(path, END_NAME, value)?;
    if let Some(pipe) = unsafe { crate::pipe::global_pipe_table() }.get_mut(pipe_idx) {
        pipe.seal_writes();
    }
    super::streams::touch(pipe_idx);
    Ok(())
}

/// A published stream's `user.kandelo.end`, if its writer set one.
pub fn end_state(output: &ids::ExchangeId) -> Result<Option<Vec<u8>>, Errno> {
    let path = with(|paths| paths.get(output).cloned()).ok_or(Errno::ENOENT)?;
    Ok(crate::tmpfs::xattr_get(&path, END_NAME).ok())
}

/// Read a published output's bytes for the host. ENOENT once it is gone.
pub fn read_output(output: &ids::ExchangeId, offset: u64, out: &mut [u8]) -> Result<usize, Errno> {
    let path = with(|paths| paths.get(output).cloned()).ok_or(Errno::ENOENT)?;
    let offset = i64::try_from(offset).map_err(|_| Errno::EOVERFLOW)?;
    crate::tmpfs::read_file_at(&path, offset, out)
}

/// The host's lease ended: remove the output. Descriptors a guest still has
/// open keep working until they close, as with any unlink; a stream's
/// writers get EPIPE, since its only reader was the host.
pub fn release_output(output: &ids::ExchangeId) -> Result<(), Errno> {
    let path = with(|paths| paths.remove(output)).ok_or(Errno::ENOENT)?;
    if let Some(pipe_idx) = super::streams::close_output(output) {
        if unsafe { crate::fifo::global_fifo_table() }.remove(&path) == Some(pipe_idx) {
            unsafe { crate::pipe::global_pipe_table() }.remove_fifo_name(pipe_idx);
        }
    }
    crate::tmpfs::unlink(&path)
}

/// Forget every published output. Kernel teardown and tests.
pub fn reset() {
    with(|paths| paths.clear());
}

fn parse_ids(list: &[u8]) -> Vec<ids::ExchangeId> {
    list.split(|&byte| byte == b'\n')
        .filter(|line| !line.is_empty())
        .filter_map(|line| ids::parse(line).ok())
        .collect()
}
