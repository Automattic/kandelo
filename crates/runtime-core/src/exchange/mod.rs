//! Kandelo exchange: moving files into and out of a running machine.
//!
//! See `docs/superpowers/specs/2026-10-21-kandelo-exchange-design.md`.

pub mod activation;
pub mod batches;
pub mod device;
pub mod ids;
pub mod outputs;
pub mod policy;
pub mod streams;
pub mod wire;
pub mod xattr;

/// Where the exchange filesystem is mounted, on every machine.
pub const MOUNT_PATH: &[u8] = b"/run/kandelo/exchange";

/// `statfs` `f_type`: ASCII "KXCH". Linux uses ASCII magics the same way
/// (`0x58465342`, "XFSB"); this one matches no Linux filesystem.
pub const FS_MAGIC: u32 = 0x4B58_4348;

/// The reserved `exchange` group: receiving inputs and publishing outputs.
/// Declared in the base rootfs `/etc/group`.
pub const EXCHANGE_GID: u32 = 120;

/// Bytes `work/` and `outbox/` may hold until the host configures its quota
/// (the smaller of 256 MiB and a quarter of the kernel's memory). The default
/// is the constrained-profile value, so an unconfigured host errs small.
pub const DEFAULT_BYTE_LIMIT: u64 = 64 * 1024 * 1024;

use alloc::vec::Vec;
use wasm_posix_shared::Errno;

use device::{ExchangeDevice, Released};

/// Whether a character-device host handle names an exchange description.
pub fn is_exchange_handle(handle: i64) -> bool {
    ExchangeDevice::from_host_handle(handle).is_some()
}

/// A description was duplicated across processes (`fork`, `posix_spawn`).
pub fn add_ref_handle(handle: i64) -> Result<(), Errno> {
    let device = ExchangeDevice::from_host_handle(handle).ok_or(Errno::EBADF)?;
    device::add_ref(device)
}

/// Drop one reference to a description. Returns true when it was the last,
/// after acting on what ended: an ended work session's directory and
/// everything unpublished in it are removed.
pub fn release_handle(handle: i64) -> bool {
    let Some(device) = ExchangeDevice::from_host_handle(handle) else {
        return false;
    };
    match device::release(device) {
        Released::Nothing => false,
        Released::Consumer => {
            batches::on_consumer_close();
            batches::push_notification(batches::Notification::Consumer { present: false });
            activation::on_consumer_close();
            true
        }
        Released::Session(number) => {
            // The directory may already be gone only if the kernel was reset.
            let _ = remove_tree(&session_path(number));
            true
        }
    }
}

/// Remove a tree the kernel itself removes (an ended session, a cancelled
/// or discarded batch). FIFOs and bound sockets in it are path-keyed kernel
/// objects beside their tmpfs nodes, so their names go too: a FIFO's buffer
/// lives on only while a description still holds it, as after an unlink.
pub fn remove_tree(path: &[u8]) -> Result<(), Errno> {
    let pipes = unsafe { crate::fifo::global_fifo_table() }.remove_under(path);
    for pipe_idx in pipes {
        unsafe { crate::pipe::global_pipe_table() }.remove_fifo_name(pipe_idx);
        streams::touch(pipe_idx);
    }
    unsafe { crate::unix_socket::global_unix_socket_registry() }.unregister_under(path);
    crate::tmpfs::remove_tree(path)
}

/// `work/<n>`.
pub fn session_path(number: u32) -> Vec<u8> {
    let mut path = Vec::from(device::WORK_DIR);
    path.push(b'/');
    let mut digits = [0u8; 10];
    let mut value = number;
    let mut count = 0;
    loop {
        digits[count] = b'0' + (value % 10) as u8;
        count += 1;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    path.extend(digits[..count].iter().rev());
    path
}

/// Open `work/clone`: create `work/<n>/` owned by the opener with mode 0700
/// and return its description.
pub fn open_session(uid: u32, gid: u32) -> Result<ExchangeDevice, Errno> {
    let number = device::reserve_session()?;
    crate::tmpfs::mkdir(&session_path(number), 0o700, uid, gid)?;
    Ok(device::activate_session(number))
}

/// Open `events` for a process with these effective credentials: it becomes
/// the consumer, and batches waiting for one are committed and announced.
pub fn open_events(uid: u32, gid: u32) -> Result<ExchangeDevice, Errno> {
    let events = device::open_events(uid, gid)?;
    batches::push_notification(batches::Notification::Consumer { present: true });
    batches::on_consumer_open();
    activation::on_consumer_open();
    Ok(events)
}

/// Whether a canonical path lies on the exchange mount.
pub fn owns_path(path: &[u8]) -> bool {
    path == MOUNT_PATH
        || (path.len() > MOUNT_PATH.len() && path.starts_with(MOUNT_PATH) && path[MOUNT_PATH.len()] == b'/')
}
