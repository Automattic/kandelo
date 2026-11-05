//! Exchange input batches: files the host offers together.
//!
//! The host stages a batch entry by entry, then commits it. A batch is
//! committed into the guest only while a consumer holds `events`; until then
//! it is *pending*: invisible, owned by the host's offer, and counted against
//! the pending-batch limit. Committing creates `inbox/<id>/` and every entry
//! in one kernel entry, so a guest never observes a partial batch, then
//! announces it with a `batch <id>` line.
//!
//! The consumer owns committed batches. Removing the batch directory is the
//! acknowledgement. When the consumer's description goes away, batches whose
//! line it read but did not remove are discarded; batches whose line it never
//! read were never delivered, so they stay and are announced to the next
//! consumer (not redelivery: no consumer saw them).
//!
//! Every change the host must learn about is queued as a [`Notification`]
//! for the host to drain.

use alloc::collections::{BTreeMap, VecDeque};
use alloc::vec::Vec;
use core::cell::UnsafeCell;
use core::hint::spin_loop;
use core::sync::atomic::{AtomicBool, Ordering};

use wasm_posix_shared::Errno;

use super::device;
use super::ids::{self, ExchangeId, IdIssuer};
use super::EXCHANGE_GID;

/// `inbox/`.
pub const INBOX_DIR: &[u8] = b"/run/kandelo/exchange/inbox";

/// Batches pending or committed at once (spec quota).
pub const MAX_BATCHES: usize = 16;
/// Entries per batch, directories included.
pub const MAX_ENTRIES: usize = 1024;
/// Directory depth inside a batch.
pub const MAX_DEPTH: usize = 16;
/// The longest path component (Linux NAME_MAX).
pub const NAME_MAX: usize = 255;
/// The longest metadata value an entry carries (MIME type, URL, name).
pub const MAX_METADATA_BYTES: usize = 4096;

/// What an entry is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryKind {
    /// A random-access source of a known size.
    File { source: u64, size: u64 },
    /// A stream of unknown length: a FIFO the host writes (see `streams`).
    Stream { source: u64 },
    /// An explicitly offered directory (folder drops may contain empty ones).
    Directory,
}

/// One entry as the host stages it. `path` is the entry's components inside
/// the batch, outermost first; missing parent directories are created.
#[derive(Debug, Clone, Default)]
pub struct StagedEntry {
    pub path: Vec<Vec<u8>>,
    pub kind: Option<EntryKind>,
    pub mime_type: Option<Vec<u8>>,
    pub origin_url: Option<Vec<u8>>,
    pub original_name: Option<Vec<u8>>,
    pub index: Option<u32>,
    pub mtime: (u64, u32),
}

/// How a batch left the inbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The consumer removed it: the acknowledgement.
    Removed,
    /// The consumer went away after its line was read.
    Discarded,
    /// The host cancelled it.
    Cancelled,
}

/// Something the host must learn about, drained by [`take_notifications`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notification {
    /// The batch is visible under `inbox/<id>/`.
    Committed { batch: ExchangeId },
    /// The batch left the inbox; `status` is its last `user.kandelo.status`.
    Settled { batch: ExchangeId, outcome: Outcome, status: Vec<u8> },
    /// The consumer wrote a new `user.kandelo.status`.
    Status { batch: ExchangeId, status: Vec<u8> },
    /// No name and no description of an entry with this source remain.
    SourceReleased { source: u64 },
    /// An input stream's FIFO has room for `free` more bytes.
    StreamDemand { source: u64, free: u32 },
    /// A guest published `outbox/<name>`; `stream` for a FIFO, whose `size`
    /// is 0.
    OutputPublished {
        output: ExchangeId,
        stream: bool,
        name: Vec<u8>,
        size: u64,
        mime_type: Option<Vec<u8>>,
        derived_from: Vec<ExchangeId>,
    },
    /// A guest removed a published output.
    OutputWithdrawn { output: ExchangeId },
    /// A streamed output the host reads has bytes or reached end-of-file.
    StreamReadable { output: ExchangeId },
    /// A consumer opened `events`, or the consumer's description went away.
    Consumer { present: bool },
    /// Something activation depends on changed: the host should call
    /// `kernel_exchange_activate` with the time.
    ActivationCheck,
    /// What the host shows about the consumer (see `activation`).
    ConsumerState {
        state: super::activation::ConsumerState,
        mode: super::activation::Mode,
        failure: Option<super::activation::Failure>,
    },
    /// Call `kernel_exchange_activate` again after `delay_ms`: a backoff ends.
    ActivationTimer { delay_ms: u32 },
}

/// What [`commit`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Committed {
    /// Visible under `inbox/<id>/` now.
    Now,
    /// Waiting for a consumer.
    Pending,
}

enum Phase {
    Staging,
    Pending,
    Committed { delivered: bool },
}

struct Batch {
    id: ExchangeId,
    source_label: Vec<u8>,
    entries: Vec<(ExchangeId, StagedEntry)>,
    phase: Phase,
    /// Keys of `entries`' paths, to refuse duplicates while staging.
    paths: BTreeMap<Vec<Vec<u8>>, ()>,
}

struct State {
    ids: IdIssuer,
    batches: BTreeMap<ExchangeId, Batch>,
    /// Pending batches in offer order.
    pending: VecDeque<ExchangeId>,
    notifications: VecDeque<Notification>,
}

impl State {
    const fn new() -> Self {
        State {
            ids: IdIssuer::new(0),
            batches: BTreeMap::new(),
            pending: VecDeque::new(),
            notifications: VecDeque::new(),
        }
    }
}

struct Global {
    locked: AtomicBool,
    state: UnsafeCell<State>,
}

// SAFETY: `locked` serializes every access; no reference escapes `with`.
unsafe impl Sync for Global {}

static GLOBAL: Global = Global {
    locked: AtomicBool::new(false),
    state: UnsafeCell::new(State::new()),
};

/// Lock order: batches, then device, then tmpfs. The device never calls back
/// into this module while holding its own lock.
fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    while GLOBAL
        .locked
        .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        spin_loop();
    }
    struct Unlock;
    impl Drop for Unlock {
        fn drop(&mut self) {
            GLOBAL.locked.store(false, Ordering::Release);
        }
    }
    let _unlock = Unlock;
    // SAFETY: see `Global`.
    f(unsafe { &mut *GLOBAL.state.get() })
}

/// Start a fresh ID issuer for this boot. `nonce` comes from the host's
/// random source.
pub fn init(nonce: u64) {
    with(|state| *state = State { ids: IdIssuer::new(nonce), ..State::new() });
}

/// Issue an ID for a new exchange item (a published output).
pub fn issue_id(now_ms: u64) -> Result<ExchangeId, Errno> {
    with(|state| state.ids.issue(now_ms))
}

/// Queue a notification for the host.
pub fn push_notification(notification: Notification) {
    with(|state| push(state, notification));
}

/// Whether `id` was issued by this mount.
pub fn validate_id(id: &ExchangeId) -> Result<(), Errno> {
    with(|state| state.ids.validate(id))
}

/// Begin staging a batch. ENOSPC when [`MAX_BATCHES`] batches are already
/// staged, pending, or committed.
pub fn begin(source_label: &[u8], now_ms: u64) -> Result<ExchangeId, Errno> {
    validate_label(source_label)?;
    with(|state| {
        if state.batches.len() >= MAX_BATCHES {
            return Err(Errno::ENOSPC);
        }
        let id = state.ids.issue(now_ms)?;
        state.batches.insert(
            id,
            Batch {
                id,
                source_label: source_label.to_vec(),
                entries: Vec::new(),
                phase: Phase::Staging,
                paths: BTreeMap::new(),
            },
        );
        Ok(id)
    })
}

fn validate_label(label: &[u8]) -> Result<(), Errno> {
    let known: &[&[u8]] = &[b"drop", b"picker", b"paste", b"share", b"api"];
    if known.contains(&label) {
        Ok(())
    } else {
        Err(Errno::EINVAL)
    }
}

/// A path component the kernel accepts: 1 to 255 bytes of UTF-8, not `.` or
/// `..`, with no `/` or NUL. The host cleans names; the kernel is the
/// authority and refuses anything else with EINVAL.
pub fn validate_component(component: &[u8]) -> Result<(), Errno> {
    if component.is_empty()
        || component.len() > NAME_MAX
        || component == b"."
        || component == b".."
        || component.contains(&b'/')
        || component.contains(&0)
        || core::str::from_utf8(component).is_err()
    {
        return Err(Errno::EINVAL);
    }
    Ok(())
}

fn validate_metadata(value: &Option<Vec<u8>>) -> Result<(), Errno> {
    match value {
        Some(bytes) if bytes.len() > MAX_METADATA_BYTES || bytes.contains(&0) => Err(Errno::EINVAL),
        Some(bytes) if core::str::from_utf8(bytes).is_err() => Err(Errno::EINVAL),
        _ => Ok(()),
    }
}

/// Stage one entry; returns its ID.
pub fn add_entry(batch: &ExchangeId, entry: StagedEntry, now_ms: u64) -> Result<ExchangeId, Errno> {
    if entry.path.is_empty() || entry.path.len() > MAX_DEPTH {
        return Err(Errno::EINVAL);
    }
    for component in &entry.path {
        validate_component(component)?;
    }
    if entry.kind.is_none() {
        return Err(Errno::EINVAL);
    }
    validate_metadata(&entry.mime_type)?;
    validate_metadata(&entry.origin_url)?;
    validate_metadata(&entry.original_name)?;
    with(|state| {
        let issued = {
            let target = state.batches.get(batch).ok_or(Errno::ENOENT)?;
            if !matches!(target.phase, Phase::Staging) {
                return Err(Errno::EINVAL);
            }
            if target.entries.len() >= MAX_ENTRIES {
                return Err(Errno::ENOSPC);
            }
            if target.paths.contains_key(&entry.path) {
                return Err(Errno::EEXIST);
            }
            state.ids.issue(now_ms)?
        };
        let target = state.batches.get_mut(batch).ok_or(Errno::ENOENT)?;
        target.paths.insert(entry.path.clone(), ());
        target.entries.push((issued, entry));
        Ok(issued)
    })
}

/// Commit a staged batch: now if a consumer exists, otherwise when one
/// arrives.
pub fn commit(batch: &ExchangeId) -> Result<Committed, Errno> {
    let consumer = device::consumer();
    with(|state| {
        let target = state.batches.get_mut(batch).ok_or(Errno::ENOENT)?;
        if !matches!(target.phase, Phase::Staging) {
            return Err(Errno::EINVAL);
        }
        match consumer {
            Some(owner) => {
                materialize(target, owner)?;
                target.phase = Phase::Committed { delivered: false };
                announce(state, batch);
                push(state, Notification::Committed { batch: *batch });
                Ok(Committed::Now)
            }
            None => {
                target.phase = Phase::Pending;
                state.pending.push_back(*batch);
                // A batch waits for a consumer: activation may start one.
                push(state, Notification::ActivationCheck);
                Ok(Committed::Pending)
            }
        }
    })
}

/// The host gives up on a batch: a staging or pending one is dropped; a
/// committed one is removed from the inbox.
pub fn cancel(batch: &ExchangeId) -> Result<(), Errno> {
    with(|state| {
        let target = state.batches.remove(batch).ok_or(Errno::ENOENT)?;
        state.pending.retain(|pending| pending != batch);
        let status = if matches!(target.phase, Phase::Committed { .. }) {
            // Its files release their sources as tmpfs frees them.
            let path = batch_path(batch);
            let status = crate::tmpfs::xattr_get(&path, b"user.kandelo.status").unwrap_or_default();
            let _ = super::remove_tree(&path);
            status
        } else {
            // Never materialized: no file holds its sources, so release them here.
            release_unmaterialized(state, &target);
            Vec::new()
        };
        push(state, Notification::Settled { batch: *batch, outcome: Outcome::Cancelled, status });
        Ok(())
    })
}

/// Report the sources of a batch that never reached the inbox as released.
/// A source tmpfs also reports (a partial materialization it removed) is
/// reported twice; the host treats a release of an unknown source as done.
fn release_unmaterialized(state: &mut State, batch: &Batch) {
    for (_, entry) in &batch.entries {
        if let Some(EntryKind::File { source, .. } | EntryKind::Stream { source }) = entry.kind {
            push(state, Notification::SourceReleased { source });
        }
    }
}

/// A consumer opened `events`: commit pending batches in order, then
/// announce committed batches no consumer has read yet.
pub fn on_consumer_open() {
    let Some(owner) = device::consumer() else {
        return;
    };
    with(|state| {
        while let Some(batch) = state.pending.pop_front() {
            let Some(target) = state.batches.get_mut(&batch) else {
                continue;
            };
            if materialize(target, owner).is_err() {
                // An inbox that cannot take the batch is reported, not hidden.
                if let Some(failed) = state.batches.remove(&batch) {
                    release_unmaterialized(state, &failed);
                }
                push(state, Notification::Settled {
                    batch,
                    outcome: Outcome::Cancelled,
                    status: b"failed: could not create the batch".to_vec(),
                });
                continue;
            }
            target.phase = Phase::Committed { delivered: false };
            push(state, Notification::Committed { batch });
        }
        let undelivered: Vec<ExchangeId> = state
            .batches
            .values()
            .filter(|batch| matches!(batch.phase, Phase::Committed { delivered: false }))
            .map(|batch| batch.id)
            .collect();
        for batch in undelivered {
            announce(state, &batch);
        }
    });
}

/// The consumer's description went away: discard what it was told about and
/// did not remove.
pub fn on_consumer_close() {
    with(|state| {
        let delivered: Vec<ExchangeId> = state
            .batches
            .values()
            .filter(|batch| matches!(batch.phase, Phase::Committed { delivered: true }))
            .map(|batch| batch.id)
            .collect();
        for batch in delivered {
            state.batches.remove(&batch);
            let path = batch_path(&batch);
            let status = crate::tmpfs::xattr_get(&path, b"user.kandelo.status").unwrap_or_default();
            let _ = super::remove_tree(&path);
            push(state, Notification::Settled {
                batch,
                outcome: Outcome::Discarded,
                status,
            });
        }
    });
}

/// Whether a batch waits for a consumer: pending, or committed with its
/// line never read (the next consumer is told about it).
pub fn awaiting_consumer() -> bool {
    with(|state| {
        !state.pending.is_empty()
            || state.batches.values().any(|batch| matches!(batch.phase, Phase::Committed { delivered: false }))
    })
}

/// The consumer read a batch's whole `batch` line.
pub fn mark_delivered(batch: &ExchangeId) {
    with(|state| {
        if let Some(target) = state.batches.get_mut(batch) {
            if matches!(target.phase, Phase::Committed { .. }) {
                target.phase = Phase::Committed { delivered: true };
            }
        }
    });
}

/// The name of `path` if it is a direct child of `inbox/`.
pub fn inbox_child_name(path: &[u8]) -> Option<&[u8]> {
    let rest = path.strip_prefix(INBOX_DIR)?.strip_prefix(b"/")?;
    (!rest.is_empty() && !rest.contains(&b'/')).then_some(rest)
}

/// `inbox/<name>` was removed by a guest. If it named a committed batch, the
/// batch is settled as removed with its last status.
pub fn on_inbox_entry_removed(name: &[u8], last_status: Vec<u8>) {
    let Ok(batch) = ids::parse(name) else {
        return;
    };
    with(|state| {
        if state.batches.remove(&batch).is_some() {
            push(state, Notification::Settled {
                batch,
                outcome: Outcome::Removed,
                status: last_status,
            });
        }
    });
}

/// The consumer changed a batch's `user.kandelo.status`.
pub fn on_status(batch_name: &[u8], status: &[u8]) {
    let Ok(batch) = ids::parse(batch_name) else {
        return;
    };
    with(|state| {
        if state.batches.contains_key(&batch) {
            push(state, Notification::Status { batch, status: status.to_vec() });
        }
    });
}

/// Drain what the host must learn about, oldest first. Released sources are
/// reported after the settlement that released them.
pub fn take_notifications() -> Vec<Notification> {
    let streams = super::streams::collect();
    let mut drained: Vec<Notification> = with(|state| state.notifications.drain(..).collect());
    drained.extend(
        crate::tmpfs::take_released_sources()
            .into_iter()
            .map(|source| Notification::SourceReleased { source }),
    );
    drained.extend(streams);
    drained
}

/// Encode as many queued notifications as fit in `out`, oldest first, and
/// keep the rest queued. Released sources are queued at this point, after the
/// settlements that released them. Returns the bytes written.
pub fn drain_into(out: &mut [u8]) -> usize {
    let streams = super::streams::collect();
    let released = crate::tmpfs::take_released_sources();
    with(|state| {
        for source in released {
            state.notifications.push_back(Notification::SourceReleased { source });
        }
        state.notifications.extend(streams);
        let queued: Vec<Notification> = state.notifications.iter().cloned().collect();
        let (written, encoded) = super::wire::encode_into(&queued, out);
        state.notifications.drain(..encoded);
        written
    })
}

/// `inbox/<id>`.
pub fn batch_path(batch: &ExchangeId) -> Vec<u8> {
    let mut path = Vec::from(INBOX_DIR);
    path.push(b'/');
    path.extend_from_slice(&ids::format(batch));
    path
}

/// Queue a notification and tell the host one is waiting.
fn push(state: &mut State, notification: Notification) {
    state.notifications.push_back(notification);
    crate::wakeup::push_exchange_pending();
}

fn announce(_state: &mut State, batch: &ExchangeId) {
    let mut line = Vec::from(&b"batch "[..]);
    line.extend_from_slice(&ids::format(batch));
    line.push(b'\n');
    device::push_batch_line(line, Some(*batch));
}

/// Create `inbox/<id>/` and every entry, owned by the consumer and the
/// exchange group. All of it happens inside one kernel entry, so no guest
/// observes a partial batch; on failure what was created is removed.
fn materialize(batch: &Batch, (uid, _gid): (u32, u32)) -> Result<(), Errno> {
    let root = batch_path(&batch.id);
    let result = (|| {
        crate::tmpfs::mkdir(&root, 0o750, uid, EXCHANGE_GID)?;
        crate::tmpfs::xattr_set(&root, b"user.kandelo.id", &ids::format(&batch.id))?;
        crate::tmpfs::xattr_set(&root, b"user.kandelo.source", &batch.source_label)?;
        for (id, entry) in &batch.entries {
            let mut path = root.clone();
            for (depth, component) in entry.path.iter().enumerate() {
                path.push(b'/');
                path.extend_from_slice(component);
                let last = depth + 1 == entry.path.len();
                if !last {
                    ensure_directory(&path, uid)?;
                }
            }
            match entry.kind.as_ref().ok_or(Errno::EINVAL)? {
                EntryKind::File { source, size } => {
                    crate::tmpfs::create_host_backed(&path, *source, *size, 0o440, uid, EXCHANGE_GID, entry.mtime)?;
                }
                EntryKind::Stream { source } => {
                    super::streams::create_input(&path, *source, uid, EXCHANGE_GID)?;
                }
                EntryKind::Directory => ensure_directory(&path, uid)?,
            }
            crate::tmpfs::xattr_set(&path, b"user.kandelo.id", &ids::format(id))?;
            if let Some(mime) = &entry.mime_type {
                crate::tmpfs::xattr_set(&path, b"user.mime_type", mime)?;
            }
            if let Some(url) = &entry.origin_url {
                crate::tmpfs::xattr_set(&path, b"user.xdg.origin.url", url)?;
            }
            if let Some(name) = &entry.original_name {
                crate::tmpfs::xattr_set(&path, b"user.kandelo.original_name", name)?;
            }
            if let Some(index) = entry.index {
                let mut text = Vec::new();
                push_decimal(&mut text, index);
                crate::tmpfs::xattr_set(&path, b"user.kandelo.index", &text)?;
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = super::remove_tree(&root);
    }
    result
}

fn ensure_directory(path: &[u8], uid: u32) -> Result<(), Errno> {
    match crate::tmpfs::mkdir(path, 0o750, uid, EXCHANGE_GID) {
        Err(Errno::EEXIST) if crate::tmpfs::is_dir(path) => Ok(()),
        other => other,
    }
}

fn push_decimal(out: &mut Vec<u8>, value: u32) {
    let mut digits = [0u8; 10];
    let mut remaining = value;
    let mut count = 0;
    loop {
        digits[count] = b'0' + (remaining % 10) as u8;
        count += 1;
        remaining /= 10;
        if remaining == 0 {
            break;
        }
    }
    out.extend(digits[..count].iter().rev());
}

/// Return to the initial state. Kernel teardown and tests.
pub fn reset() {
    with(|state| *state = State::new());
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::exchange::device::tests::TestGuard as DeviceGuard;
    use core::sync::atomic::AtomicU64;

    static NEXT_NONCE: AtomicU64 = AtomicU64::new(1);

    /// Fresh device and batch state with a unique ID nonce, so batches from
    /// different tests never share an inbox name in the global tmpfs.
    pub(crate) struct TestGuard {
        _device: DeviceGuard,
    }

    impl TestGuard {
        pub(crate) fn acquire() -> Self {
            let device = DeviceGuard::acquire();
            init(NEXT_NONCE.fetch_add(1, Ordering::Relaxed) * 0x1_0001);
            TestGuard { _device: device }
        }
    }

    impl Drop for TestGuard {
        fn drop(&mut self) {
            reset();
            crate::exchange::streams::reset();
            crate::exchange::outputs::reset();
            crate::exchange::activation::reset();
        }
    }

    pub(crate) fn stream(path: &[&[u8]], source: u64) -> StagedEntry {
        StagedEntry {
            path: path.iter().map(|component| component.to_vec()).collect(),
            kind: Some(EntryKind::Stream { source }),
            mtime: (1_700_000_000, 0),
            ..StagedEntry::default()
        }
    }

    pub(crate) fn file(path: &[&[u8]], source: u64, size: u64) -> StagedEntry {
        StagedEntry {
            path: path.iter().map(|component| component.to_vec()).collect(),
            kind: Some(EntryKind::File { source, size }),
            mtime: (1_700_000_000, 0),
            ..StagedEntry::default()
        }
    }

    fn read_line() -> Vec<u8> {
        let mut buf = [0u8; 64];
        let n = device::read_events(&mut buf).unwrap();
        buf[..n].to_vec()
    }

    fn batch_line(batch: &ExchangeId) -> Vec<u8> {
        let mut line = b"batch ".to_vec();
        line.extend_from_slice(&ids::format(batch));
        line.push(b'\n');
        line
    }

    #[test]
    fn a_batch_waits_for_a_consumer_then_appears_whole_and_is_announced() {
        let _guard = TestGuard::acquire();
        let batch = begin(b"drop", 10).unwrap();
        let photo = add_entry(&batch, file(&[b"photo.jpg"], 7, 3), 10).unwrap();
        let nested = add_entry(&batch, file(&[b"vacation", b"a.jpg"], 8, 5), 10).unwrap();
        assert_ne!(photo, nested);
        assert_eq!(commit(&batch), Ok(Committed::Pending));
        let path = batch_path(&batch);
        assert!(crate::tmpfs::lstat(&path).is_err(), "pending batches are invisible");

        device::open_events(1000, 1000).unwrap();
        on_consumer_open();
        assert_eq!(read_line(), b"outputs none\n");
        assert_eq!(read_line(), batch_line(&batch));

        let dir = crate::tmpfs::lstat(&path).unwrap();
        assert_eq!((dir.st_uid, dir.st_gid, dir.st_mode & 0o7777), (1000, EXCHANGE_GID, 0o750));
        let mut photo_path = path.clone();
        photo_path.extend_from_slice(b"/photo.jpg");
        let st = crate::tmpfs::lstat(&photo_path).unwrap();
        assert_eq!((st.st_size, st.st_mode & 0o7777, st.st_uid), (3, 0o440, 1000));
        assert_eq!(crate::tmpfs::xattr_get(&photo_path, b"user.kandelo.id").unwrap(), ids::format(&photo));
        let mut folder = path.clone();
        folder.extend_from_slice(b"/vacation");
        assert!(crate::tmpfs::is_dir(&folder));
        assert_eq!(crate::tmpfs::xattr_get(&path, b"user.kandelo.source").unwrap(), b"drop");
        assert_eq!(
            take_notifications(),
            [Notification::ActivationCheck, Notification::Committed { batch }],
            "waiting asks for activation; committing is not settling"
        );
    }

    #[test]
    fn closing_discards_read_batches_and_keeps_unread_ones_for_the_next_consumer() {
        let _guard = TestGuard::acquire();
        let events = device::open_events(0, 0).unwrap();
        on_consumer_open();
        let read = begin(b"api", 1).unwrap();
        add_entry(&read, file(&[b"a"], 1, 1), 1).unwrap();
        commit(&read).unwrap();
        let unread = begin(b"api", 1).unwrap();
        add_entry(&unread, file(&[b"b"], 2, 1), 1).unwrap();
        commit(&unread).unwrap();
        assert_eq!(read_line(), b"outputs none\n");
        assert_eq!(read_line(), batch_line(&read));

        assert_eq!(device::release(events), device::Released::Consumer);
        on_consumer_close();
        assert!(crate::tmpfs::lstat(&batch_path(&read)).is_err());
        assert!(crate::tmpfs::lstat(&batch_path(&unread)).is_ok());
        let notes = take_notifications();
        assert!(notes.contains(&Notification::Settled {
            batch: read,
            outcome: Outcome::Discarded,
            status: Vec::new(),
        }));
        assert!(notes.contains(&Notification::SourceReleased { source: 1 }));

        device::open_events(0, 0).unwrap();
        on_consumer_open();
        assert_eq!(read_line(), b"outputs none\n");
        assert_eq!(read_line(), batch_line(&unread), "announced again: it was never delivered");
    }

    #[test]
    fn removing_the_batch_directory_settles_it_as_removed() {
        let _guard = TestGuard::acquire();
        device::open_events(0, 0).unwrap();
        let batch = begin(b"picker", 1).unwrap();
        add_entry(&batch, file(&[b"a"], 3, 1), 1).unwrap();
        commit(&batch).unwrap();
        crate::tmpfs::xattr_set(&batch_path(&batch), b"user.kandelo.status", b"done").unwrap();
        on_status(&ids::format(&batch), b"done");
        crate::tmpfs::remove_tree(&batch_path(&batch)).unwrap();
        on_inbox_entry_removed(&ids::format(&batch), b"done".to_vec());
        let notes = take_notifications();
        assert_eq!(notes[0], Notification::Committed { batch });
        assert_eq!(notes[1], Notification::Status { batch, status: b"done".to_vec() });
        assert_eq!(
            notes[2],
            Notification::Settled { batch, outcome: Outcome::Removed, status: b"done".to_vec() }
        );
        assert!(notes.contains(&Notification::SourceReleased { source: 3 }));
    }

    #[test]
    fn the_kernel_refuses_unsafe_names_duplicates_and_overflow() {
        let _guard = TestGuard::acquire();
        assert_eq!(begin(b"usb", 1), Err(Errno::EINVAL));
        let batch = begin(b"drop", 1).unwrap();
        for bad in [&b""[..], b".", b"..", b"a/b", b"a\0b", &[0xff, 0xfe], &[b'x'; 256]] {
            assert_eq!(add_entry(&batch, file(&[bad], 1, 1), 1), Err(Errno::EINVAL), "{bad:?}");
        }
        add_entry(&batch, file(&[&[b'x'; 255]], 1, 1), 1).unwrap();
        add_entry(&batch, file(&[b"same"], 2, 1), 1).unwrap();
        assert_eq!(add_entry(&batch, file(&[b"same"], 3, 1), 1), Err(Errno::EEXIST));
        let deep: Vec<&[u8]> = core::iter::repeat(&b"d"[..]).take(MAX_DEPTH + 1).collect();
        assert_eq!(add_entry(&batch, file(&deep, 4, 1), 1), Err(Errno::EINVAL));
        for _ in 1..MAX_BATCHES {
            begin(b"drop", 1).unwrap();
        }
        assert_eq!(begin(b"drop", 1), Err(Errno::ENOSPC));
    }

    #[test]
    fn cancelling_drops_pending_batches_and_removes_committed_ones() {
        let _guard = TestGuard::acquire();
        let pending = begin(b"drop", 1).unwrap();
        add_entry(&pending, file(&[b"a"], 1, 1), 1).unwrap();
        commit(&pending).unwrap();
        cancel(&pending).unwrap();
        // The host learns it is over, and that its source is free.
        let notes = take_notifications();
        assert!(notes.contains(&Notification::Settled {
            batch: pending,
            outcome: Outcome::Cancelled,
            status: Vec::new(),
        }));
        assert!(notes.contains(&Notification::SourceReleased { source: 1 }));
        device::open_events(0, 0).unwrap();
        on_consumer_open();
        assert_eq!(read_line(), b"outputs none\n");
        assert_eq!(device::read_events(&mut [0u8; 8]), Err(Errno::EAGAIN), "nothing to announce");

        let committed = begin(b"drop", 1).unwrap();
        add_entry(&committed, file(&[b"b"], 2, 1), 1).unwrap();
        commit(&committed).unwrap();
        cancel(&committed).unwrap();
        assert!(crate::tmpfs::lstat(&batch_path(&committed)).is_err());
        assert!(take_notifications().contains(&Notification::Settled {
            batch: committed,
            outcome: Outcome::Cancelled,
            status: Vec::new(),
        }));
    }
}
