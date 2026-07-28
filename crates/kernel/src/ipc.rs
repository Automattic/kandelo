//! SysV IPC implementation: message queues, semaphore sets, shared memory.
//!
//! IPC operations are handled by the kernel. The host marshals data between
//! process memory and kernel scratch; all IPC logic and storage lives here.

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::collections::VecDeque;
use alloc::vec;
use alloc::vec::Vec;
use wasm_posix_shared::{Errno, platform_limits};

// ── IPC constants ──

const IPC_CREAT: u32 = 0o1000;
const IPC_EXCL: u32 = 0o2000;
const IPC_NOWAIT: u32 = 0o4000;
const IPC_PRIVATE: i32 = 0;
const IPC_RMID: i32 = 0;
const IPC_SET: i32 = 1;
const IPC_STAT: i32 = 2;
const IPC_R: u32 = 0o400;
const IPC_W: u32 = 0o200;
const IPC_PERM_MASK: u32 = 0o777;
const SHM_RDONLY: u32 = 0o10000;

// msgrcv flags
const MSG_NOERROR: u32 = 0o10000;
const MSG_EXCEPT: u32 = 0o20000;

// semctl commands
const GETPID: i32 = 11;
const GETVAL: i32 = 12;
const GETALL: i32 = 13;
const GETNCNT: i32 = 14;
const GETZCNT: i32 = 15;
const SETVAL: i32 = 16;
const SETALL: i32 = 17;

// Limits
const MSGMNB: u32 = 16384; // default max bytes in queue
const SEMMSL: usize = 32; // max semaphores per set

fn ipc_has_perm(uid: u32, gid: u32, owner_uid: u32, owner_gid: u32, mode: u32, perm: u32) -> bool {
    if uid == 0 || perm == 0 {
        return true;
    }
    let available = if uid == owner_uid {
        (mode >> 6) & 0o7
    } else if gid == owner_gid {
        (mode >> 3) & 0o7
    } else {
        mode & 0o7
    };
    let requested = (perm >> 6) & 0o7;
    available & requested == requested
}

fn ipc_check_perm(
    uid: u32,
    gid: u32,
    owner_uid: u32,
    owner_gid: u32,
    mode: u32,
    perm: u32,
) -> Result<(), Errno> {
    if ipc_has_perm(uid, gid, owner_uid, owner_gid, mode, perm) {
        Ok(())
    } else {
        Err(Errno::EACCES)
    }
}

fn ipc_check_owner(uid: u32, owner_uid: u32, creator_uid: u32) -> Result<(), Errno> {
    if uid == 0 || uid == owner_uid || uid == creator_uid {
        Ok(())
    } else {
        Err(Errno::EPERM)
    }
}

// ── Data structures ──

/// A single message in a SysV message queue.
struct MsgEntry {
    mtype: i64,
    data: Vec<u8>,
}

/// SysV message queue.
struct MsgQueue {
    key: i32,
    id: i32,
    generation: u64,
    active_pins: usize,
    removed: bool,
    mode: u32,
    uid: u32,
    gid: u32,
    cuid: u32,
    cgid: u32,
    qbytes: u32,
    messages: VecDeque<MsgEntry>,
    cbytes: u32,
    lspid: i32,
    lrpid: i32,
    stime: i64,
    rtime: i64,
    ctime: i64,
    seq: i32,
}

/// Info struct returned by msgctl IPC_STAT.
#[derive(Debug)]
pub struct MsgQueueInfo {
    pub key: i32,
    pub uid: u32,
    pub gid: u32,
    pub cuid: u32,
    pub cgid: u32,
    pub mode: u32,
    pub seq: i32,
    pub stime: i64,
    pub rtime: i64,
    pub ctime: i64,
    pub cbytes: u32,
    pub qnum: u32,
    pub qbytes: u32,
    pub lspid: i32,
    pub lrpid: i32,
}

/// Result of msgrcv.
#[derive(Debug)]
pub struct MsgRcvResult {
    pub mtype: i64,
    pub data: Vec<u8>,
}

/// A single semaphore within a set.
struct SemValue {
    val: u16,
    pid: u32,
    // ncnt/zcnt are not truly tracked (would require in-kernel blocking), but
    // we store them for IPC_STAT.
    ncnt: u32,
    zcnt: u32,
}

/// SysV semaphore set.
struct SemSet {
    key: i32,
    id: i32,
    generation: u64,
    active_pins: usize,
    removed: bool,
    mode: u32,
    uid: u32,
    gid: u32,
    cuid: u32,
    cgid: u32,
    nsems: u32,
    values: Vec<SemValue>,
    otime: i64,
    ctime: i64,
    seq: i32,
}

/// Info struct returned by semctl IPC_STAT.
#[derive(Debug)]
pub struct SemSetInfo {
    pub key: i32,
    pub uid: u32,
    pub gid: u32,
    pub cuid: u32,
    pub cgid: u32,
    pub mode: u32,
    pub seq: i32,
    pub nsems: u32,
    pub otime: i64,
    pub ctime: i64,
}

/// A single semaphore operation (from sembuf struct).
#[derive(Debug, Clone, Copy)]
pub struct SemOp {
    pub num: u16,
    pub op: i16,
    pub flg: u16,
}

/// SysV shared memory segment.
struct ShmSegment {
    key: i32,
    id: i32,
    mode: u32,
    uid: u32,
    gid: u32,
    cuid: u32,
    cgid: u32,
    segsz: u32,
    data: Vec<u8>,
    cpid: i32,
    lpid: i32,
    nattch: u32,
    atime: i64,
    dtime: i64,
    ctime: i64,
    seq: i32,
}

/// Info struct returned by shmctl IPC_STAT.
#[derive(Debug)]
pub struct ShmSegInfo {
    pub key: i32,
    pub uid: u32,
    pub gid: u32,
    pub cuid: u32,
    pub cgid: u32,
    pub mode: u32,
    pub seq: i32,
    pub segsz: u32,
    pub cpid: i32,
    pub lpid: i32,
    pub nattch: u32,
    pub atime: i64,
    pub dtime: i64,
    pub ctime: i64,
}

/// Result of semctl that can return different types.
#[derive(Debug)]
pub enum SemCtlResult {
    /// Simple success (0).
    Ok,
    /// Integer value (GETVAL, GETPID, GETNCNT, GETZCNT).
    Value(i32),
    /// Stat info (IPC_STAT).
    Stat(SemSetInfo),
    /// Array of all values (GETALL) — packed as u16 little-endian.
    All(Vec<u16>),
}

/// Stable identity for one message-queue generation retained across a blocked
/// operation.
///
/// The fields intentionally remain private and the capability is neither
/// `Clone` nor `Copy`: only `IpcTable` can create it, and releasing it consumes
/// the exact pin once.
#[derive(Debug)]
pub(crate) struct PinnedMsgQueue {
    pin_id: IpcPinId,
    public_id: i32,
    generation: u64,
}

/// Stable identity for one semaphore-set generation retained across a blocked
/// operation.
///
/// See `PinnedMsgQueue` for the ownership contract.
#[derive(Debug)]
pub(crate) struct PinnedSemSet {
    pin_id: IpcPinId,
    public_id: i32,
    generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct IpcPinId(u64);

#[cfg(test)]
impl PinnedMsgQueue {
    fn duplicate_for_exact_release_test(&self) -> Self {
        Self {
            pin_id: self.pin_id,
            public_id: self.public_id,
            generation: self.generation,
        }
    }
}

#[cfg(test)]
impl PinnedSemSet {
    fn duplicate_for_exact_release_test(&self) -> Self {
        Self {
            pin_id: self.pin_id,
            public_id: self.public_id,
            generation: self.generation,
        }
    }
}

// ── IPC Table ──

/// Global SysV IPC table holding message queues, semaphore sets,
/// and shared memory segments.
pub struct IpcTable {
    msg_queues: BTreeMap<i32, MsgQueue>,
    removed_msg_queues: BTreeMap<u64, MsgQueue>,
    active_msg_pins: BTreeMap<IpcPinId, u64>,
    sem_sets: BTreeMap<i32, SemSet>,
    removed_sem_sets: BTreeMap<u64, SemSet>,
    active_sem_pins: BTreeMap<IpcPinId, u64>,
    shm_segments: BTreeMap<i32, ShmSegment>,
    next_id: i32,
    next_generation: u64,
    next_pin_id: Option<IpcPinId>,
}

impl IpcTable {
    pub const fn new() -> Self {
        IpcTable {
            msg_queues: BTreeMap::new(),
            removed_msg_queues: BTreeMap::new(),
            active_msg_pins: BTreeMap::new(),
            sem_sets: BTreeMap::new(),
            removed_sem_sets: BTreeMap::new(),
            active_sem_pins: BTreeMap::new(),
            shm_segments: BTreeMap::new(),
            next_id: 0,
            next_generation: 1,
            next_pin_id: Some(IpcPinId(1)),
        }
    }

    fn public_id_in_use(&self, id: i32) -> bool {
        self.msg_queues.contains_key(&id)
            || self.sem_sets.contains_key(&id)
            || self.shm_segments.contains_key(&id)
    }

    fn alloc_id(&mut self) -> Result<i32, Errno> {
        self.alloc_id_bounded(i32::MAX)
    }

    /// Allocate from `0..=max_id`, advancing through the domain without ever
    /// overwriting a live object.
    ///
    /// The bounded form also gives unit tests a tractable way to prove
    /// collision, wrap, and exhaustion behavior without constructing billions
    /// of IPC objects.
    fn alloc_id_bounded(&mut self, max_id: i32) -> Result<i32, Errno> {
        if max_id < 0 {
            return Err(Errno::ENOSPC);
        }

        let mut candidate = if self.next_id >= 0 && self.next_id <= max_id {
            self.next_id
        } else {
            0
        };
        let domain_size = u64::try_from(max_id)
            .map_err(|_| Errno::ENOSPC)?
            .checked_add(1)
            .ok_or(Errno::ENOSPC)?;

        for _ in 0..domain_size {
            if !self.public_id_in_use(candidate) {
                self.next_id = if candidate == max_id {
                    0
                } else {
                    candidate + 1
                };
                return Ok(candidate);
            }
            candidate = if candidate == max_id {
                0
            } else {
                candidate + 1
            };
        }

        Err(Errno::ENOSPC)
    }

    fn alloc_generation(&mut self) -> Result<u64, Errno> {
        let generation = self.next_generation;
        self.next_generation = self.next_generation.checked_add(1).ok_or(Errno::ENOSPC)?;
        Ok(generation)
    }

    fn alloc_pin_id(&mut self) -> Result<IpcPinId, Errno> {
        let mut candidate = self.next_pin_id.ok_or(Errno::EOVERFLOW)?;
        loop {
            if !self.active_msg_pins.contains_key(&candidate)
                && !self.active_sem_pins.contains_key(&candidate)
            {
                self.next_pin_id = candidate.0.checked_add(1).map(IpcPinId);
                return Ok(candidate);
            }
            candidate = IpcPinId(candidate.0.checked_add(1).ok_or(Errno::EOVERFLOW)?);
        }
    }

    #[cfg(test)]
    fn set_next_public_id_for_test(&mut self, next_id: i32) {
        self.next_id = next_id;
    }

    // ═══════════════════════════════════════════════════════════════
    // Message Queues
    // ═══════════════════════════════════════════════════════════════

    /// Get or create a message queue.
    pub fn msgget(
        &mut self,
        key: i32,
        flags: u32,
        _pid: u32,
        uid: u32,
        gid: u32,
    ) -> Result<i32, Errno> {
        let creating = (flags & IPC_CREAT) != 0;
        let exclusive = (flags & IPC_EXCL) != 0;
        let mode = flags & 0o777;

        if key != IPC_PRIVATE {
            // Look for existing queue with this key
            for q in self.msg_queues.values() {
                if q.key == key {
                    if creating && exclusive {
                        return Err(Errno::EEXIST);
                    }
                    ipc_check_perm(uid, gid, q.uid, q.gid, q.mode, flags & IPC_PERM_MASK)?;
                    return Ok(q.id);
                }
            }
        }

        if !creating && key != IPC_PRIVATE {
            return Err(Errno::ENOENT);
        }

        let id = self.alloc_id()?;
        let generation = self.alloc_generation()?;
        let seq = id;
        self.msg_queues.insert(
            id,
            MsgQueue {
                key,
                id,
                generation,
                active_pins: 0,
                removed: false,
                mode,
                uid,
                gid,
                cuid: uid,
                cgid: gid,
                qbytes: MSGMNB,
                messages: VecDeque::new(),
                cbytes: 0,
                lspid: 0,
                lrpid: 0,
                stime: 0,
                rtime: 0,
                ctime: crate::current_time_secs(),
                seq,
            },
        );

        Ok(id)
    }

    /// Pin the currently visible generation behind a public message-queue ID.
    ///
    /// WHY: a blocked retry must retain object identity, not merely the numeric
    /// ID that a later `msgget` is allowed to reuse.
    pub(crate) fn pin_msg_queue(&mut self, qid: i32) -> Result<PinnedMsgQueue, Errno> {
        let generation = self
            .msg_queues
            .get(&qid)
            .map(|queue| queue.generation)
            .ok_or(Errno::EINVAL)?;
        let pin_id = self.alloc_pin_id()?;
        let queue = self.msg_queues.get_mut(&qid).ok_or(Errno::EINVAL)?;
        queue.active_pins = queue.active_pins.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        let previous = self.active_msg_pins.insert(pin_id, generation);
        debug_assert!(previous.is_none());
        Ok(PinnedMsgQueue {
            pin_id,
            public_id: qid,
            generation,
        })
    }

    /// Release one exact message-queue pin.
    ///
    /// Taking the opaque capability by value makes release consuming. A
    /// tombstone remains reachable until the last capability is released.
    pub(crate) fn release_msg_queue_pin(&mut self, pin: PinnedMsgQueue) -> Result<(), Errno> {
        if self.active_msg_pins.get(&pin.pin_id) != Some(&pin.generation) {
            return Err(Errno::EINVAL);
        }

        if let Some(queue) = self.msg_queues.get_mut(&pin.public_id) {
            if queue.generation == pin.generation {
                queue.active_pins = queue.active_pins.checked_sub(1).ok_or(Errno::EINVAL)?;
                self.active_msg_pins.remove(&pin.pin_id);
                return Ok(());
            }
        }

        let should_reclaim = {
            let queue = self
                .removed_msg_queues
                .get_mut(&pin.generation)
                .ok_or(Errno::EINVAL)?;
            if queue.id != pin.public_id || !queue.removed {
                return Err(Errno::EINVAL);
            }
            queue.active_pins = queue.active_pins.checked_sub(1).ok_or(Errno::EINVAL)?;
            queue.active_pins == 0
        };
        if should_reclaim {
            self.removed_msg_queues.remove(&pin.generation);
        }
        self.active_msg_pins.remove(&pin.pin_id);
        Ok(())
    }

    fn live_msg_queue_for_pin_mut(&mut self, pin: &PinnedMsgQueue) -> Result<&mut MsgQueue, Errno> {
        if self.active_msg_pins.get(&pin.pin_id) != Some(&pin.generation) {
            return Err(Errno::EIDRM);
        }
        if self
            .msg_queues
            .get(&pin.public_id)
            .is_some_and(|queue| queue.generation == pin.generation)
        {
            return self.msg_queues.get_mut(&pin.public_id).ok_or(Errno::EIDRM);
        }

        // A capability never follows a reused public ID. Whether its removed
        // generation is still tombstoned or has already been reclaimed, the
        // operation's stable target no longer exists.
        Err(Errno::EIDRM)
    }

    /// Send a message to a queue.
    pub fn msgsnd(
        &mut self,
        qid: i32,
        mtype: i64,
        data: &[u8],
        flags: u32,
        pid: u32,
        uid: u32,
        gid: u32,
    ) -> Result<(), Errno> {
        self.msgsnd_with_reserve(
            qid,
            mtype,
            data,
            flags,
            pid,
            uid,
            gid,
            |message, additional| {
                message
                    .try_reserve_exact(additional)
                    .map_err(|_| Errno::ENOMEM)
            },
            |messages| messages.try_reserve(1).map_err(|_| Errno::ENOMEM),
        )
    }

    /// Retry `msgsnd` against the exact generation captured by
    /// `pin_msg_queue`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn msgsnd_pinned(
        &mut self,
        pin: &PinnedMsgQueue,
        mtype: i64,
        data: &[u8],
        flags: u32,
        pid: u32,
        uid: u32,
        gid: u32,
    ) -> Result<(), Errno> {
        let queue = self.live_msg_queue_for_pin_mut(pin)?;
        if mtype <= 0 {
            return Err(Errno::EINVAL);
        }
        Self::msgsnd_queue_with_reserve(
            queue,
            mtype,
            data,
            flags,
            pid,
            uid,
            gid,
            |message, additional| {
                message
                    .try_reserve_exact(additional)
                    .map_err(|_| Errno::ENOMEM)
            },
            |messages| messages.try_reserve(1).map_err(|_| Errno::ENOMEM),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn msgsnd_with_reserve(
        &mut self,
        qid: i32,
        mtype: i64,
        data: &[u8],
        flags: u32,
        pid: u32,
        uid: u32,
        gid: u32,
        reserve_message: impl FnOnce(&mut Vec<u8>, usize) -> Result<(), Errno>,
        reserve_slot: impl FnOnce(&mut VecDeque<MsgEntry>) -> Result<(), Errno>,
    ) -> Result<(), Errno> {
        if mtype <= 0 {
            return Err(Errno::EINVAL);
        }
        let q = self.msg_queues.get_mut(&qid).ok_or(Errno::EINVAL)?;
        Self::msgsnd_queue_with_reserve(
            q,
            mtype,
            data,
            flags,
            pid,
            uid,
            gid,
            reserve_message,
            reserve_slot,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn msgsnd_queue_with_reserve(
        q: &mut MsgQueue,
        mtype: i64,
        data: &[u8],
        flags: u32,
        pid: u32,
        uid: u32,
        gid: u32,
        reserve_message: impl FnOnce(&mut Vec<u8>, usize) -> Result<(), Errno>,
        reserve_slot: impl FnOnce(&mut VecDeque<MsgEntry>) -> Result<(), Errno>,
    ) -> Result<(), Errno> {
        ipc_check_perm(uid, gid, q.uid, q.gid, q.mode, IPC_W)?;

        if data.len() > platform_limits::SYSV_MSG_MAX_BYTES {
            return Err(Errno::EINVAL);
        }

        // Compute the complete post-commit accounting value once. Overflow
        // cannot mean "space available"; treat it exactly like a full queue.
        let next_cbytes = q
            .cbytes
            .checked_add(u32::try_from(data.len()).map_err(|_| Errno::EAGAIN)?)
            .ok_or(Errno::EAGAIN)?;
        if next_cbytes > q.qbytes {
            if (flags & IPC_NOWAIT) != 0 {
                return Err(Errno::EAGAIN);
            }
            // Return EAGAIN for host retry.
            return Err(Errno::EAGAIN);
        }

        // WHY: both the owned payload and the VecDeque slot can allocate.
        // Prepare them fallibly before changing accounting or queue order so
        // ENOMEM leaves the logical message queue transaction untouched.
        let mut message_data = Vec::new();
        reserve_message(&mut message_data, data.len())?;
        if message_data.capacity() < data.len() {
            return Err(Errno::ENOMEM);
        }
        message_data.extend_from_slice(data);
        reserve_slot(&mut q.messages)?;
        if q.messages.capacity().saturating_sub(q.messages.len()) < 1 {
            return Err(Errno::ENOMEM);
        }

        q.messages.push_back(MsgEntry {
            mtype,
            data: message_data,
        });
        q.cbytes = next_cbytes;
        q.lspid = pid as i32;
        q.stime = crate::current_time_secs();

        Ok(())
    }

    /// Receive a message from a queue.
    pub fn msgrcv(
        &mut self,
        qid: i32,
        max_size: u32,
        msgtype: i64,
        flags: u32,
        pid: u32,
        uid: u32,
        gid: u32,
    ) -> Result<MsgRcvResult, Errno> {
        self.msgrcv_with_mtype_max(qid, max_size, msgtype, i64::MAX, flags, pid, uid, gid)
    }

    /// Receive while proving the selected mtype fits the caller's native long.
    ///
    /// A Kandelo queue can be shared by wasm32 and wasm64 processes. Reject
    /// before removal when an LP64 sender's type cannot be represented by an
    /// ILP32 receiver, so the host never has to truncate a consumed message.
    pub fn msgrcv_with_mtype_max(
        &mut self,
        qid: i32,
        max_size: u32,
        msgtype: i64,
        max_output_mtype: i64,
        flags: u32,
        pid: u32,
        uid: u32,
        gid: u32,
    ) -> Result<MsgRcvResult, Errno> {
        let q = self.msg_queues.get_mut(&qid).ok_or(Errno::EINVAL)?;
        Self::msgrcv_queue_with_mtype_max(
            q,
            max_size,
            msgtype,
            max_output_mtype,
            flags,
            pid,
            uid,
            gid,
        )
    }

    /// Retry `msgrcv` against the exact generation captured by
    /// `pin_msg_queue`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn msgrcv_pinned(
        &mut self,
        pin: &PinnedMsgQueue,
        max_size: u32,
        msgtype: i64,
        flags: u32,
        pid: u32,
        uid: u32,
        gid: u32,
    ) -> Result<MsgRcvResult, Errno> {
        self.msgrcv_pinned_with_mtype_max(pin, max_size, msgtype, i64::MAX, flags, pid, uid, gid)
    }

    /// Width-aware pinned `msgrcv`; see `msgrcv_with_mtype_max`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn msgrcv_pinned_with_mtype_max(
        &mut self,
        pin: &PinnedMsgQueue,
        max_size: u32,
        msgtype: i64,
        max_output_mtype: i64,
        flags: u32,
        pid: u32,
        uid: u32,
        gid: u32,
    ) -> Result<MsgRcvResult, Errno> {
        let queue = self.live_msg_queue_for_pin_mut(pin)?;
        Self::msgrcv_queue_with_mtype_max(
            queue,
            max_size,
            msgtype,
            max_output_mtype,
            flags,
            pid,
            uid,
            gid,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn msgrcv_queue_with_mtype_max(
        q: &mut MsgQueue,
        max_size: u32,
        msgtype: i64,
        max_output_mtype: i64,
        flags: u32,
        pid: u32,
        uid: u32,
        gid: u32,
    ) -> Result<MsgRcvResult, Errno> {
        ipc_check_perm(uid, gid, q.uid, q.gid, q.mode, IPC_R)?;

        let noerror = (flags & MSG_NOERROR) != 0;
        let except = (flags & MSG_EXCEPT) != 0;

        // Find matching message index
        let idx = if msgtype == 0 {
            // Take first message
            if q.messages.is_empty() { None } else { Some(0) }
        } else if msgtype > 0 {
            if except {
                // First message whose type != msgtype
                q.messages.iter().position(|m| m.mtype != msgtype)
            } else {
                // First message whose type == msgtype
                q.messages.iter().position(|m| m.mtype == msgtype)
            }
        } else {
            // msgtype < 0: first message with type <= |msgtype|
            let abs_type = msgtype.saturating_abs();
            q.messages.iter().position(|m| m.mtype <= abs_type)
        };

        let idx = match idx {
            Some(i) => i,
            None => {
                if (flags & IPC_NOWAIT) != 0 {
                    return Err(Errno::ENOMSG);
                }
                return Err(Errno::EAGAIN);
            }
        };

        let msg = &q.messages[idx];

        if msg.mtype > max_output_mtype {
            return Err(Errno::EOVERFLOW);
        }

        // Check size
        if msg.data.len() > max_size as usize {
            if !noerror {
                return Err(Errno::E2BIG);
            }
        }

        let mut msg = q.messages.remove(idx).unwrap();
        let removed_len = msg.data.len();
        let truncated_len = core::cmp::min(removed_len, max_size as usize);
        // The dequeued message already owns its allocation. Truncate that Vec
        // in place so MSG_NOERROR cannot lose a removed message to a second,
        // fallible output-copy allocation.
        msg.data.truncate(truncated_len);

        // WHY: MSG_NOERROR truncates only the caller's returned copy. The
        // complete queued message was removed, so capacity accounting must
        // release its original length or a full queue can remain spuriously
        // full after a successful truncated receive.
        q.cbytes = q.cbytes.saturating_sub(removed_len as u32);
        q.lrpid = pid as i32;
        q.rtime = crate::current_time_secs();

        Ok(MsgRcvResult {
            mtype: msg.mtype,
            data: msg.data,
        })
    }

    /// Message queue control operations.
    pub fn msgctl(
        &mut self,
        qid: i32,
        cmd: i32,
        _pid: u32,
        uid: u32,
        gid: u32,
    ) -> Result<Option<MsgQueueInfo>, Errno> {
        match cmd {
            IPC_STAT => {
                let q = self.msg_queues.get(&qid).ok_or(Errno::EINVAL)?;
                ipc_check_perm(uid, gid, q.uid, q.gid, q.mode, IPC_R)?;
                Ok(Some(MsgQueueInfo {
                    key: q.key,
                    uid: q.uid,
                    gid: q.gid,
                    cuid: q.cuid,
                    cgid: q.cgid,
                    mode: q.mode,
                    seq: q.seq,
                    stime: q.stime,
                    rtime: q.rtime,
                    ctime: q.ctime,
                    cbytes: q.cbytes,
                    qnum: q.messages.len() as u32,
                    qbytes: q.qbytes,
                    lspid: q.lspid,
                    lrpid: q.lrpid,
                }))
            }
            IPC_RMID => {
                let q = self.msg_queues.get(&qid).ok_or(Errno::EINVAL)?;
                ipc_check_owner(uid, q.uid, q.cuid)?;
                let mut queue = self.msg_queues.remove(&qid).ok_or(Errno::EINVAL)?;
                queue.removed = true;
                if queue.active_pins != 0 {
                    // Public visibility ends before any waiter is woken. The
                    // generation-keyed tombstone exists only to make those
                    // already-pinned retries fail with EIDRM and to keep ID
                    // reuse from redirecting them.
                    let previous = self.removed_msg_queues.insert(queue.generation, queue);
                    debug_assert!(previous.is_none());
                }
                Ok(None)
            }
            IPC_SET => {
                // IPC_SET carries a target-width msqid_ds and is applied by
                // msgctl_set after the wire layer has parsed permitted fields.
                Err(Errno::EINVAL)
            }
            _ => Err(Errno::EINVAL),
        }
    }

    /// Apply the fields Linux permits msgctl IPC_SET to replace.
    pub fn msgctl_set(
        &mut self,
        qid: i32,
        new_uid: u32,
        new_gid: u32,
        new_mode: u32,
        new_qbytes: u32,
        uid: u32,
    ) -> Result<(), Errno> {
        let q = self.msg_queues.get_mut(&qid).ok_or(Errno::EINVAL)?;
        ipc_check_owner(uid, q.uid, q.cuid)?;
        if new_qbytes > MSGMNB && uid != 0 {
            return Err(Errno::EPERM);
        }
        q.uid = new_uid;
        q.gid = new_gid;
        q.mode = new_mode & IPC_PERM_MASK;
        q.qbytes = new_qbytes;
        q.ctime = crate::current_time_secs();
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════
    // Semaphores
    // ═══════════════════════════════════════════════════════════════

    /// Get or create a semaphore set.
    pub fn semget(
        &mut self,
        key: i32,
        nsems: u32,
        flags: u32,
        _pid: u32,
        uid: u32,
        gid: u32,
    ) -> Result<i32, Errno> {
        let creating = (flags & IPC_CREAT) != 0;
        let exclusive = (flags & IPC_EXCL) != 0;

        if key != IPC_PRIVATE {
            for s in self.sem_sets.values() {
                if s.key == key {
                    if creating && exclusive {
                        return Err(Errno::EEXIST);
                    }
                    ipc_check_perm(uid, gid, s.uid, s.gid, s.mode, flags & IPC_PERM_MASK)?;
                    return Ok(s.id);
                }
            }
        }

        if !creating && key != IPC_PRIVATE {
            return Err(Errno::ENOENT);
        }

        if nsems == 0 || nsems as usize > SEMMSL {
            return Err(Errno::EINVAL);
        }

        let id = self.alloc_id()?;
        let generation = self.alloc_generation()?;
        let seq = id;
        let values = (0..nsems)
            .map(|_| SemValue {
                val: 0,
                pid: 0,
                ncnt: 0,
                zcnt: 0,
            })
            .collect();

        self.sem_sets.insert(
            id,
            SemSet {
                key,
                id,
                generation,
                active_pins: 0,
                removed: false,
                mode: flags & 0o777,
                uid,
                gid,
                cuid: uid,
                cgid: gid,
                nsems,
                values,
                otime: 0,
                ctime: crate::current_time_secs(),
                seq,
            },
        );

        Ok(id)
    }

    /// Pin the currently visible generation behind a public semaphore-set ID.
    pub(crate) fn pin_sem_set(&mut self, semid: i32) -> Result<PinnedSemSet, Errno> {
        let generation = self
            .sem_sets
            .get(&semid)
            .map(|set| set.generation)
            .ok_or(Errno::EINVAL)?;
        let pin_id = self.alloc_pin_id()?;
        let set = self.sem_sets.get_mut(&semid).ok_or(Errno::EINVAL)?;
        set.active_pins = set.active_pins.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        let previous = self.active_sem_pins.insert(pin_id, generation);
        debug_assert!(previous.is_none());
        Ok(PinnedSemSet {
            pin_id,
            public_id: semid,
            generation,
        })
    }

    /// Consume and release one exact semaphore-set pin.
    pub(crate) fn release_sem_set_pin(&mut self, pin: PinnedSemSet) -> Result<(), Errno> {
        if self.active_sem_pins.get(&pin.pin_id) != Some(&pin.generation) {
            return Err(Errno::EINVAL);
        }

        if let Some(set) = self.sem_sets.get_mut(&pin.public_id) {
            if set.generation == pin.generation {
                set.active_pins = set.active_pins.checked_sub(1).ok_or(Errno::EINVAL)?;
                self.active_sem_pins.remove(&pin.pin_id);
                return Ok(());
            }
        }

        let should_reclaim = {
            let set = self
                .removed_sem_sets
                .get_mut(&pin.generation)
                .ok_or(Errno::EINVAL)?;
            if set.id != pin.public_id || !set.removed {
                return Err(Errno::EINVAL);
            }
            set.active_pins = set.active_pins.checked_sub(1).ok_or(Errno::EINVAL)?;
            set.active_pins == 0
        };
        if should_reclaim {
            self.removed_sem_sets.remove(&pin.generation);
        }
        self.active_sem_pins.remove(&pin.pin_id);
        Ok(())
    }

    fn live_sem_set_for_pin_mut(&mut self, pin: &PinnedSemSet) -> Result<&mut SemSet, Errno> {
        if self.active_sem_pins.get(&pin.pin_id) != Some(&pin.generation) {
            return Err(Errno::EIDRM);
        }
        if self
            .sem_sets
            .get(&pin.public_id)
            .is_some_and(|set| set.generation == pin.generation)
        {
            return self.sem_sets.get_mut(&pin.public_id).ok_or(Errno::EIDRM);
        }
        Err(Errno::EIDRM)
    }

    /// Perform atomic semaphore operations (two-pass: validate then apply).
    pub fn semop(
        &mut self,
        semid: i32,
        sops: &[SemOp],
        pid: u32,
        uid: u32,
        gid: u32,
    ) -> Result<(), Errno> {
        let set = self.sem_sets.get_mut(&semid).ok_or(Errno::EINVAL)?;
        Self::semop_set(set, sops, pid, uid, gid)
    }

    /// Retry `semop` against the exact generation captured by `pin_sem_set`.
    pub(crate) fn semop_pinned(
        &mut self,
        pin: &PinnedSemSet,
        sops: &[SemOp],
        pid: u32,
        uid: u32,
        gid: u32,
    ) -> Result<(), Errno> {
        let set = self.live_sem_set_for_pin_mut(pin)?;
        Self::semop_set(set, sops, pid, uid, gid)
    }

    fn semop_set(
        s: &mut SemSet,
        sops: &[SemOp],
        pid: u32,
        uid: u32,
        gid: u32,
    ) -> Result<(), Errno> {
        let mut perm = 0;
        for op in sops {
            perm |= if op.op == 0 { IPC_R } else { IPC_W };
        }
        ipc_check_perm(uid, gid, s.uid, s.gid, s.mode, perm)?;

        // First pass: validate all operations can proceed
        for op in sops {
            if op.num as u32 >= s.nsems {
                return Err(Errno::EFBIG);
            }
            let cur = s.values[op.num as usize].val as i32;
            if op.op < 0 {
                if cur + (op.op as i32) < 0 {
                    if (op.flg as u32 & IPC_NOWAIT) != 0 {
                        return Err(Errno::EAGAIN);
                    }
                    return Err(Errno::EAGAIN);
                }
            } else if op.op == 0 {
                if cur != 0 {
                    if (op.flg as u32 & IPC_NOWAIT) != 0 {
                        return Err(Errno::EAGAIN);
                    }
                    return Err(Errno::EAGAIN);
                }
            }
            // op > 0: always OK
        }

        // Second pass: apply atomically
        for op in sops {
            let sem = &mut s.values[op.num as usize];
            if op.op != 0 {
                sem.val = ((sem.val as i32) + (op.op as i32)) as u16;
            }
            sem.pid = pid;
        }
        s.otime = crate::current_time_secs();

        Ok(())
    }

    /// Semaphore control operations.
    pub fn semctl(
        &mut self,
        semid: i32,
        semnum: i32,
        cmd: i32,
        _pid: u32,
        arg: i32,
        uid: u32,
        gid: u32,
    ) -> Result<SemCtlResult, Errno> {
        match cmd {
            IPC_STAT => {
                let s = self.sem_sets.get(&semid).ok_or(Errno::EINVAL)?;
                ipc_check_perm(uid, gid, s.uid, s.gid, s.mode, IPC_R)?;
                Ok(SemCtlResult::Stat(SemSetInfo {
                    key: s.key,
                    uid: s.uid,
                    gid: s.gid,
                    cuid: s.cuid,
                    cgid: s.cgid,
                    mode: s.mode,
                    seq: s.seq,
                    nsems: s.nsems,
                    otime: s.otime,
                    ctime: s.ctime,
                }))
            }
            IPC_RMID => {
                let s = self.sem_sets.get(&semid).ok_or(Errno::EINVAL)?;
                ipc_check_owner(uid, s.uid, s.cuid)?;
                let mut set = self.sem_sets.remove(&semid).ok_or(Errno::EINVAL)?;
                set.removed = true;
                if set.active_pins != 0 {
                    let previous = self.removed_sem_sets.insert(set.generation, set);
                    debug_assert!(previous.is_none());
                }
                Ok(SemCtlResult::Ok)
            }
            IPC_SET => {
                let s = self.sem_sets.get_mut(&semid).ok_or(Errno::EINVAL)?;
                ipc_check_owner(uid, s.uid, s.cuid)?;
                s.ctime = crate::current_time_secs();
                Ok(SemCtlResult::Ok)
            }
            GETVAL => {
                let s = self.sem_sets.get(&semid).ok_or(Errno::EINVAL)?;
                ipc_check_perm(uid, gid, s.uid, s.gid, s.mode, IPC_R)?;
                if semnum < 0 || semnum as u32 >= s.nsems {
                    return Err(Errno::EINVAL);
                }
                Ok(SemCtlResult::Value(s.values[semnum as usize].val as i32))
            }
            SETVAL => {
                let s = self.sem_sets.get_mut(&semid).ok_or(Errno::EINVAL)?;
                ipc_check_perm(uid, gid, s.uid, s.gid, s.mode, IPC_W)?;
                if semnum < 0 || semnum as u32 >= s.nsems {
                    return Err(Errno::EINVAL);
                }
                if arg < 0 || arg > 32767 {
                    return Err(Errno::ERANGE);
                }
                s.values[semnum as usize].val = arg as u16;
                s.ctime = crate::current_time_secs();
                Ok(SemCtlResult::Ok)
            }
            GETALL => {
                let s = self.sem_sets.get(&semid).ok_or(Errno::EINVAL)?;
                ipc_check_perm(uid, gid, s.uid, s.gid, s.mode, IPC_R)?;
                let vals: Vec<u16> = s.values.iter().map(|v| v.val).collect();
                Ok(SemCtlResult::All(vals))
            }
            SETALL => {
                // Values are passed via separate call (semctl_set_all)
                // This entry point is not used for SETALL directly
                Err(Errno::EINVAL)
            }
            GETPID => {
                let s = self.sem_sets.get(&semid).ok_or(Errno::EINVAL)?;
                ipc_check_perm(uid, gid, s.uid, s.gid, s.mode, IPC_R)?;
                if semnum < 0 || semnum as u32 >= s.nsems {
                    return Err(Errno::EINVAL);
                }
                Ok(SemCtlResult::Value(s.values[semnum as usize].pid as i32))
            }
            GETNCNT => {
                let s = self.sem_sets.get(&semid).ok_or(Errno::EINVAL)?;
                ipc_check_perm(uid, gid, s.uid, s.gid, s.mode, IPC_R)?;
                if semnum < 0 || semnum as u32 >= s.nsems {
                    return Err(Errno::EINVAL);
                }
                Ok(SemCtlResult::Value(s.values[semnum as usize].ncnt as i32))
            }
            GETZCNT => {
                let s = self.sem_sets.get(&semid).ok_or(Errno::EINVAL)?;
                ipc_check_perm(uid, gid, s.uid, s.gid, s.mode, IPC_R)?;
                if semnum < 0 || semnum as u32 >= s.nsems {
                    return Err(Errno::EINVAL);
                }
                Ok(SemCtlResult::Value(s.values[semnum as usize].zcnt as i32))
            }
            _ => Err(Errno::EINVAL),
        }
    }

    /// Return the exact byte length of a GETALL/SETALL value array after
    /// applying the same permission check as the requested command.
    pub fn semctl_array_bytes(
        &self,
        semid: i32,
        cmd: i32,
        uid: u32,
        gid: u32,
    ) -> Result<usize, Errno> {
        let set = self.sem_sets.get(&semid).ok_or(Errno::EINVAL)?;
        let permission = match cmd {
            GETALL => IPC_R,
            SETALL => IPC_W,
            _ => return Err(Errno::EINVAL),
        };
        ipc_check_perm(uid, gid, set.uid, set.gid, set.mode, permission)?;
        set.values
            .len()
            .checked_mul(core::mem::size_of::<u16>())
            .ok_or(Errno::EOVERFLOW)
    }

    /// Set all semaphore values in a set (SETALL command).
    pub fn semctl_set_all(
        &mut self,
        semid: i32,
        values: &[u16],
        uid: u32,
        gid: u32,
    ) -> Result<(), Errno> {
        let s = self.sem_sets.get_mut(&semid).ok_or(Errno::EINVAL)?;
        ipc_check_perm(uid, gid, s.uid, s.gid, s.mode, IPC_W)?;
        if values.len() != s.nsems as usize {
            return Err(Errno::EINVAL);
        }
        for (i, &v) in values.iter().enumerate() {
            s.values[i].val = v;
        }
        s.ctime = crate::current_time_secs();
        Ok(())
    }

    /// Decode and apply the little-endian `unsigned short[]` used by SETALL.
    ///
    /// WHY: SETALL requires write permission only. Discovering the array
    /// length through IPC_STAT would incorrectly add a read-permission
    /// requirement before the actual write.
    pub fn semctl_set_all_bytes(
        &mut self,
        semid: i32,
        bytes: &[u8],
        uid: u32,
        gid: u32,
    ) -> Result<(), Errno> {
        let expected = self.semctl_array_bytes(semid, SETALL, uid, gid)?;
        if bytes.len() != expected {
            return Err(Errno::EINVAL);
        }
        let mut values = Vec::new();
        values
            .try_reserve_exact(expected / core::mem::size_of::<u16>())
            .map_err(|_| Errno::ENOMEM)?;
        for value in bytes.chunks_exact(core::mem::size_of::<u16>()) {
            values.push(u16::from_le_bytes([value[0], value[1]]));
        }
        self.semctl_set_all(semid, &values, uid, gid)
    }

    // ═══════════════════════════════════════════════════════════════
    // Shared Memory
    // ═══════════════════════════════════════════════════════════════

    /// Get or create a shared memory segment.
    pub fn shmget(
        &mut self,
        key: i32,
        size: u32,
        flags: u32,
        pid: u32,
        uid: u32,
        gid: u32,
    ) -> Result<i32, Errno> {
        let creating = (flags & IPC_CREAT) != 0;
        let exclusive = (flags & IPC_EXCL) != 0;

        if key != IPC_PRIVATE {
            for seg in self.shm_segments.values() {
                if seg.key == key {
                    if creating && exclusive {
                        return Err(Errno::EEXIST);
                    }
                    ipc_check_perm(uid, gid, seg.uid, seg.gid, seg.mode, flags & IPC_PERM_MASK)?;
                    return Ok(seg.id);
                }
            }
        }

        if !creating && key != IPC_PRIVATE {
            return Err(Errno::ENOENT);
        }

        if size == 0 {
            return Err(Errno::EINVAL);
        }

        let id = self.alloc_id()?;
        let seq = id;
        self.shm_segments.insert(
            id,
            ShmSegment {
                key,
                id,
                mode: flags & 0o777,
                uid,
                gid,
                cuid: uid,
                cgid: gid,
                segsz: size,
                data: vec![0u8; size as usize],
                cpid: pid as i32,
                lpid: 0,
                nattch: 0,
                atime: 0,
                dtime: 0,
                ctime: crate::current_time_secs(),
                seq,
            },
        );

        Ok(id)
    }

    /// Attach to a shared memory segment.
    /// Returns the segment size. The caller reads data via shm_read_chunk.
    pub fn shmat(
        &mut self,
        shmid: i32,
        pid: u32,
        flags: u32,
        uid: u32,
        gid: u32,
    ) -> Result<u32, Errno> {
        let seg = self.shm_segments.get_mut(&shmid).ok_or(Errno::EINVAL)?;
        let perm = if flags & SHM_RDONLY != 0 {
            IPC_R
        } else {
            IPC_R | IPC_W
        };
        ipc_check_perm(uid, gid, seg.uid, seg.gid, seg.mode, perm)?;
        seg.nattch += 1;
        seg.lpid = pid as i32;
        seg.atime = crate::current_time_secs();
        Ok(seg.segsz)
    }

    /// Read a chunk of shared memory segment data into a buffer.
    /// Returns bytes written.
    pub fn shm_read_chunk(&self, shmid: i32, offset: u32, buf: &mut [u8]) -> Result<u32, Errno> {
        let seg = self.shm_segments.get(&shmid).ok_or(Errno::EINVAL)?;
        let start = offset as usize;
        if start >= seg.data.len() {
            return Ok(0);
        }
        let end = core::cmp::min(start + buf.len(), seg.data.len());
        let len = end - start;
        buf[..len].copy_from_slice(&seg.data[start..end]);
        Ok(len as u32)
    }

    /// Write a chunk of data into a shared memory segment.
    /// Returns bytes written.
    pub fn shm_write_chunk(&mut self, shmid: i32, offset: u32, data: &[u8]) -> Result<u32, Errno> {
        let seg = self.shm_segments.get_mut(&shmid).ok_or(Errno::EINVAL)?;
        let start = offset as usize;
        if start >= seg.data.len() {
            return Ok(0);
        }
        let end = core::cmp::min(start + data.len(), seg.data.len());
        let len = end - start;
        seg.data[start..end].copy_from_slice(&data[..len]);
        Ok(len as u32)
    }

    /// Detach from a shared memory segment.
    pub fn shmdt(&mut self, shmid: i32, pid: u32) -> Result<(), Errno> {
        let seg = self.shm_segments.get_mut(&shmid).ok_or(Errno::EINVAL)?;
        seg.nattch = seg.nattch.saturating_sub(1);
        seg.lpid = pid as i32;
        seg.dtime = crate::current_time_secs();
        Ok(())
    }

    /// Shared memory control operations.
    pub fn shmctl(
        &mut self,
        shmid: i32,
        cmd: i32,
        _pid: u32,
        uid: u32,
        gid: u32,
    ) -> Result<Option<ShmSegInfo>, Errno> {
        match cmd {
            IPC_STAT => {
                let seg = self.shm_segments.get(&shmid).ok_or(Errno::EINVAL)?;
                ipc_check_perm(uid, gid, seg.uid, seg.gid, seg.mode, IPC_R)?;
                Ok(Some(ShmSegInfo {
                    key: seg.key,
                    uid: seg.uid,
                    gid: seg.gid,
                    cuid: seg.cuid,
                    cgid: seg.cgid,
                    mode: seg.mode,
                    seq: seg.seq,
                    segsz: seg.segsz,
                    cpid: seg.cpid,
                    lpid: seg.lpid,
                    nattch: seg.nattch,
                    atime: seg.atime,
                    dtime: seg.dtime,
                    ctime: seg.ctime,
                }))
            }
            IPC_RMID => {
                let seg = self.shm_segments.get(&shmid).ok_or(Errno::EINVAL)?;
                ipc_check_owner(uid, seg.uid, seg.cuid)?;
                self.shm_segments.remove(&shmid);
                Ok(None)
            }
            IPC_SET => {
                // IPC_SET carries a target-width shmid_ds and is applied by
                // shmctl_set after the wire layer has parsed permitted fields.
                Err(Errno::EINVAL)
            }
            _ => Err(Errno::EINVAL),
        }
    }

    /// Apply the fields Linux permits shmctl IPC_SET to replace.
    pub fn shmctl_set(
        &mut self,
        shmid: i32,
        new_uid: u32,
        new_gid: u32,
        new_mode: u32,
        uid: u32,
    ) -> Result<(), Errno> {
        let seg = self.shm_segments.get_mut(&shmid).ok_or(Errno::EINVAL)?;
        ipc_check_owner(uid, seg.uid, seg.cuid)?;
        seg.uid = new_uid;
        seg.gid = new_gid;
        seg.mode = new_mode & IPC_PERM_MASK;
        seg.ctime = crate::current_time_secs();
        Ok(())
    }
}

// ── Global singleton ──

use core::cell::UnsafeCell;

struct IpcTableCell(UnsafeCell<IpcTable>);
unsafe impl Sync for IpcTableCell {}

static IPC_TABLE: IpcTableCell = IpcTableCell(UnsafeCell::new(IpcTable::new()));

/// Get a mutable reference to the global IPC table.
///
/// # Safety
/// Must only be called from a single-threaded context (Wasm is single-threaded).
pub unsafe fn global_ipc_table() -> &'static mut IpcTable {
    unsafe { &mut *IPC_TABLE.0.get() }
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;

    // ── Message Queue Tests ──

    #[test]
    fn test_msgget_create() {
        let mut t = IpcTable::new();
        let id = t.msgget(1234, IPC_CREAT | 0o666, 1, 1000, 1000).unwrap();
        assert!(id >= 0);

        // Get same queue by key
        let id2 = t.msgget(1234, 0, 1, 1000, 1000).unwrap();
        assert_eq!(id, id2);
    }

    #[test]
    fn test_msgget_exclusive() {
        let mut t = IpcTable::new();
        t.msgget(1234, IPC_CREAT | 0o666, 1, 1000, 1000).unwrap();

        // CREAT|EXCL on existing key should fail
        assert_eq!(
            t.msgget(1234, IPC_CREAT | IPC_EXCL | 0o666, 1, 1000, 1000)
                .unwrap_err(),
            Errno::EEXIST
        );
    }

    #[test]
    fn test_msgget_noent() {
        let mut t = IpcTable::new();
        assert_eq!(t.msgget(9999, 0, 1, 1000, 1000).unwrap_err(), Errno::ENOENT);
    }

    #[test]
    fn test_msgget_private() {
        let mut t = IpcTable::new();
        let id1 = t
            .msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 1000, 1000)
            .unwrap();
        let id2 = t
            .msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 1000, 1000)
            .unwrap();
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_msgsnd_msgrcv_fifo() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        t.msgsnd(qid, 1, b"hello", 0, 42, 0, 0).unwrap();
        t.msgsnd(qid, 2, b"world", 0, 42, 0, 0).unwrap();

        // msgtype=0: FIFO order
        let msg = t.msgrcv(qid, 100, 0, 0, 43, 0, 0).unwrap();
        assert_eq!(msg.mtype, 1);
        assert_eq!(msg.data, b"hello");

        let msg = t.msgrcv(qid, 100, 0, 0, 43, 0, 0).unwrap();
        assert_eq!(msg.mtype, 2);
        assert_eq!(msg.data, b"world");
    }

    #[test]
    fn test_msgsnd_shared_maximum_boundary() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();
        let exact = vec![0xa5; platform_limits::SYSV_MSG_MAX_BYTES];

        t.msgsnd(qid, 1, &exact, 0, 1, 0, 0).unwrap();
        assert_eq!(
            t.msgsnd(
                qid,
                2,
                &vec![0x5a; platform_limits::SYSV_MSG_MAX_BYTES + 1],
                0,
                1,
                0,
                0,
            ),
            Err(Errno::EINVAL),
        );

        let received = t
            .msgrcv(
                qid,
                platform_limits::SYSV_MSG_MAX_BYTES as u32,
                0,
                0,
                1,
                0,
                0,
            )
            .unwrap();
        assert_eq!(received.data, exact);
    }

    #[test]
    fn msgsnd_allocation_failures_preserve_queue_accounting() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        assert_eq!(
            t.msgsnd_with_reserve(
                qid,
                1,
                b"payload",
                0,
                42,
                0,
                0,
                |_, _| Err(Errno::ENOMEM),
                |_| panic!("slot reservation must follow message reservation"),
            ),
            Err(Errno::ENOMEM),
        );
        let queue = &t.msg_queues[&qid];
        assert!(queue.messages.is_empty());
        assert_eq!(queue.cbytes, 0);
        assert_eq!(queue.lspid, 0);
        assert_eq!(queue.stime, 0);

        assert_eq!(
            t.msgsnd_with_reserve(
                qid,
                1,
                b"payload",
                0,
                42,
                0,
                0,
                |message, additional| {
                    message
                        .try_reserve_exact(additional)
                        .map_err(|_| Errno::ENOMEM)
                },
                |_| Err(Errno::ENOMEM),
            ),
            Err(Errno::ENOMEM),
        );
        let queue = &t.msg_queues[&qid];
        assert!(queue.messages.is_empty());
        assert_eq!(queue.cbytes, 0);
        assert_eq!(queue.lspid, 0);
        assert_eq!(queue.stime, 0);

        t.msgsnd(qid, 1, b"payload", 0, 42, 0, 0).unwrap();
        let queue = &t.msg_queues[&qid];
        assert_eq!(queue.messages.len(), 1);
        assert_eq!(queue.cbytes, 7);
        assert_eq!(queue.lspid, 42);
    }

    #[test]
    fn test_msgrcv_type_filter() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        t.msgsnd(qid, 1, b"one", 0, 1, 0, 0).unwrap();
        t.msgsnd(qid, 2, b"two", 0, 1, 0, 0).unwrap();
        t.msgsnd(qid, 3, b"three", 0, 1, 0, 0).unwrap();

        // Receive type 2 specifically
        let msg = t.msgrcv(qid, 100, 2, 0, 1, 0, 0).unwrap();
        assert_eq!(msg.mtype, 2);
        assert_eq!(msg.data, b"two");
    }

    #[test]
    fn test_wasm64_message_type_round_trips_without_i32_truncation() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();
        let mtype = i32::MAX as i64 + 0x1020_3040;

        t.msgsnd(qid, mtype, b"wide", 0, 1, 0, 0).unwrap();
        let msg = t.msgrcv(qid, 100, mtype, 0, 1, 0, 0).unwrap();

        assert_eq!(msg.mtype, mtype);
        assert_eq!(msg.data, b"wide");
    }

    #[test]
    fn test_wasm32_receive_rejects_wide_type_before_queue_removal() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();
        let mtype = i32::MAX as i64 + 1;

        t.msgsnd(qid, mtype, b"wide", 0, 1, 0, 0).unwrap();
        assert_eq!(
            t.msgrcv_with_mtype_max(qid, 100, 0, i32::MAX as i64, 0, 1, 0, 0,)
                .unwrap_err(),
            Errno::EOVERFLOW,
        );

        let msg = t.msgrcv(qid, 100, 0, 0, 1, 0, 0).unwrap();
        assert_eq!(msg.mtype, mtype);
        assert_eq!(msg.data, b"wide");
    }

    #[test]
    fn test_msgrcv_negative_type() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        t.msgsnd(qid, 5, b"five", 0, 1, 0, 0).unwrap();
        t.msgsnd(qid, 2, b"two", 0, 1, 0, 0).unwrap();
        t.msgsnd(qid, 3, b"three", 0, 1, 0, 0).unwrap();

        // Negative type: first with type <= |msgtype|
        let msg = t.msgrcv(qid, 100, -3, 0, 1, 0, 0).unwrap();
        // Should get type 2 (first match <= 3, scanning in order: 5>3 skip, 2<=3 match)
        assert_eq!(msg.mtype, 2);
    }

    #[test]
    fn test_msgrcv_except() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        t.msgsnd(qid, 1, b"one", 0, 1, 0, 0).unwrap();
        t.msgsnd(qid, 2, b"two", 0, 1, 0, 0).unwrap();

        // MSG_EXCEPT: first message NOT of type 1
        let msg = t.msgrcv(qid, 100, 1, MSG_EXCEPT, 1, 0, 0).unwrap();
        assert_eq!(msg.mtype, 2);
    }

    #[test]
    fn test_msgrcv_truncate() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        t.msgsnd(qid, 1, b"hello world", 0, 1, 0, 0).unwrap();

        // Without MSG_NOERROR, too-small buffer returns E2BIG
        assert_eq!(t.msgrcv(qid, 5, 0, 0, 1, 0, 0).unwrap_err(), Errno::E2BIG);

        // With MSG_NOERROR, truncates
        let msg = t.msgrcv(qid, 5, 0, MSG_NOERROR, 1, 0, 0).unwrap();
        assert_eq!(msg.data, b"hello");
    }

    #[test]
    fn test_msgrcv_truncate_releases_complete_message_capacity() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();
        let full_message = vec![0x33; platform_limits::SYSV_MSG_MAX_BYTES];

        t.msgsnd(qid, 1, &full_message, 0, 1, 0, 0).unwrap();
        t.msgsnd(qid, 2, &full_message, 0, 1, 0, 0).unwrap();
        assert_eq!(
            t.msgctl(qid, IPC_STAT, 1, 0, 0).unwrap().unwrap().cbytes,
            MSGMNB,
        );

        let received = t.msgrcv(qid, 1, 0, MSG_NOERROR, 1, 0, 0).unwrap();
        assert_eq!(received.data, [0x33]);

        // The complete first message left the queue even though the caller
        // requested one byte, so another maximum-sized send must fit.
        t.msgsnd(qid, 3, &full_message, 0, 1, 0, 0).unwrap();
        let info = t.msgctl(qid, IPC_STAT, 1, 0, 0).unwrap().unwrap();
        assert_eq!(info.qnum, 2);
        assert_eq!(info.cbytes, MSGMNB);
    }

    #[test]
    fn test_msgrcv_empty_nowait() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        assert_eq!(
            t.msgrcv(qid, 100, 0, IPC_NOWAIT, 1, 0, 0).unwrap_err(),
            Errno::ENOMSG
        );
    }

    #[test]
    fn test_msgsnd_invalid_type() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();
        assert_eq!(
            t.msgsnd(qid, 0, b"x", 0, 1, 0, 0).unwrap_err(),
            Errno::EINVAL
        );
        assert_eq!(
            t.msgsnd(qid, -1, b"x", 0, 1, 0, 0).unwrap_err(),
            Errno::EINVAL
        );
    }

    #[test]
    fn test_msgctl_stat() {
        let mut t = IpcTable::new();
        let qid = t.msgget(1234, IPC_CREAT | 0o666, 1, 1000, 1000).unwrap();
        t.msgsnd(qid, 1, b"test", 0, 42, 0, 0).unwrap();

        let info = t.msgctl(qid, IPC_STAT, 1, 0, 0).unwrap().unwrap();
        assert_eq!(info.key, 1234);
        assert_eq!(info.mode, 0o666);
        assert_eq!(info.qnum, 1);
        assert_eq!(info.cbytes, 4);
        assert_eq!(info.lspid, 42);
    }

    #[test]
    fn test_msgctl_set_applies_permitted_fields_and_permissions() {
        let mut t = IpcTable::new();
        let qid = t
            .msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 1000, 1000)
            .unwrap();

        t.msgctl_set(qid, 2000, 2001, 0o1764, 8192, 1000).unwrap();
        let info = t.msgctl(qid, IPC_STAT, 1, 0, 0).unwrap().unwrap();
        assert_eq!(info.uid, 2000);
        assert_eq!(info.gid, 2001);
        assert_eq!(info.cuid, 1000);
        assert_eq!(info.cgid, 1000);
        assert_eq!(info.mode, 0o764);
        assert_eq!(info.qbytes, 8192);

        assert_eq!(
            t.msgctl_set(qid, 3000, 3001, 0o600, 4096, 3000),
            Err(Errno::EPERM)
        );
        assert_eq!(
            t.msgctl_set(qid, 2000, 2001, 0o600, MSGMNB + 1, 2000),
            Err(Errno::EPERM)
        );

        t.msgctl_set(qid, 0, 0, 0o600, MSGMNB + 1, 0).unwrap();
        let info = t.msgctl(qid, IPC_STAT, 1, 0, 0).unwrap().unwrap();
        assert_eq!(info.uid, 0);
        assert_eq!(info.gid, 0);
        assert_eq!(info.mode, 0o600);
        assert_eq!(info.qbytes, MSGMNB + 1);
    }

    #[test]
    fn test_msgctl_rmid() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();
        t.msgctl(qid, IPC_RMID, 1, 0, 0).unwrap();
        assert_eq!(t.msgctl(qid, IPC_STAT, 1, 0, 0).unwrap_err(), Errno::EINVAL);
    }

    #[test]
    fn pinned_msgsnd_returns_eidrm_after_rmid_and_immediate_id_reuse() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();
        t.msgctl_set(qid, 0, 0, 0o666, 1, 0).unwrap();
        t.msgsnd(qid, 1, b"x", 0, 1, 0, 0).unwrap();

        let pin = t.pin_msg_queue(qid).unwrap();
        let removed_generation = pin.generation;
        assert_eq!(
            t.msgsnd_pinned(&pin, 2, b"y", 0, 1, 0, 0),
            Err(Errno::EAGAIN)
        );

        t.msgctl(qid, IPC_RMID, 1, 0, 0).unwrap();
        assert!(!t.msg_queues.contains_key(&qid));
        assert_eq!(t.removed_msg_queues[&removed_generation].active_pins, 1);

        t.set_next_public_id_for_test(qid);
        let replacement = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 2, 0, 0).unwrap();
        assert_eq!(replacement, qid);
        assert_ne!(t.msg_queues[&replacement].generation, removed_generation);

        assert_eq!(
            t.msgsnd_pinned(&pin, 2, b"old", 0, 1, 0, 0),
            Err(Errno::EIDRM)
        );
        t.msgsnd(replacement, 3, b"new", 0, 2, 0, 0).unwrap();
        let received = t.msgrcv(replacement, 3, 0, 0, 2, 0, 0).unwrap();
        assert_eq!(received.mtype, 3);
        assert_eq!(received.data, b"new");

        t.release_msg_queue_pin(pin).unwrap();
        assert!(!t.removed_msg_queues.contains_key(&removed_generation));
    }

    #[test]
    fn pinned_msgrcv_returns_eidrm_without_consuming_reused_queue() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();
        let pin = t.pin_msg_queue(qid).unwrap();
        let removed_generation = pin.generation;

        assert_eq!(
            t.msgrcv_pinned(&pin, 16, 0, 0, 1, 0, 0).unwrap_err(),
            Errno::EAGAIN
        );
        t.msgctl(qid, IPC_RMID, 1, 0, 0).unwrap();

        t.set_next_public_id_for_test(qid);
        let replacement = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 2, 0, 0).unwrap();
        assert_eq!(replacement, qid);
        t.msgsnd(replacement, 7, b"replacement", 0, 2, 0, 0)
            .unwrap();

        assert_eq!(
            t.msgrcv_pinned(&pin, 16, 0, 0, 1, 0, 0).unwrap_err(),
            Errno::EIDRM
        );
        let received = t.msgrcv(replacement, 16, 0, 0, 2, 0, 0).unwrap();
        assert_eq!(received.mtype, 7);
        assert_eq!(received.data, b"replacement");

        t.release_msg_queue_pin(pin).unwrap();
        assert!(!t.removed_msg_queues.contains_key(&removed_generation));
    }

    #[test]
    fn message_queue_pin_release_is_exact_and_reclaims_after_last_pin() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();
        let first = t.pin_msg_queue(qid).unwrap();
        let duplicate = first.duplicate_for_exact_release_test();
        let second = t.pin_msg_queue(qid).unwrap();
        let generation = first.generation;

        assert_eq!(t.msg_queues[&qid].active_pins, 2);
        t.msgctl(qid, IPC_RMID, 1, 0, 0).unwrap();
        assert_eq!(t.removed_msg_queues[&generation].active_pins, 2);

        t.release_msg_queue_pin(first).unwrap();
        assert_eq!(t.removed_msg_queues[&generation].active_pins, 1);
        assert_eq!(t.release_msg_queue_pin(duplicate), Err(Errno::EINVAL));
        assert_eq!(t.removed_msg_queues[&generation].active_pins, 1);

        t.release_msg_queue_pin(second).unwrap();
        assert!(!t.removed_msg_queues.contains_key(&generation));
        assert!(t.active_msg_pins.is_empty());
    }

    // ── Semaphore Tests ──

    #[test]
    fn test_semget_create() {
        let mut t = IpcTable::new();
        let id = t.semget(5678, 3, IPC_CREAT | 0o666, 1, 1000, 1000).unwrap();
        assert!(id >= 0);

        // Get same set by key
        let id2 = t.semget(5678, 0, 0, 1, 1000, 1000).unwrap();
        assert_eq!(id, id2);
    }

    #[test]
    fn test_semget_exclusive() {
        let mut t = IpcTable::new();
        t.semget(5678, 3, IPC_CREAT | 0o666, 1, 1000, 1000).unwrap();
        assert_eq!(
            t.semget(5678, 3, IPC_CREAT | IPC_EXCL | 0o666, 1, 1000, 1000)
                .unwrap_err(),
            Errno::EEXIST
        );
    }

    #[test]
    fn test_semop_increment_decrement() {
        let mut t = IpcTable::new();
        let id = t
            .semget(IPC_PRIVATE, 2, IPC_CREAT | 0o666, 1, 0, 0)
            .unwrap();

        // Increment semaphore 0 by 5
        t.semop(
            id,
            &[SemOp {
                num: 0,
                op: 5,
                flg: 0,
            }],
            42,
            0,
            0,
        )
        .unwrap();

        let val = match t.semctl(id, 0, GETVAL, 1, 0, 0, 0).unwrap() {
            SemCtlResult::Value(v) => v,
            _ => panic!("expected Value"),
        };
        assert_eq!(val, 5);

        // Decrement by 3
        t.semop(
            id,
            &[SemOp {
                num: 0,
                op: -3,
                flg: 0,
            }],
            42,
            0,
            0,
        )
        .unwrap();
        let val = match t.semctl(id, 0, GETVAL, 1, 0, 0, 0).unwrap() {
            SemCtlResult::Value(v) => v,
            _ => panic!("expected Value"),
        };
        assert_eq!(val, 2);
    }

    #[test]
    fn test_semop_would_block() {
        let mut t = IpcTable::new();
        let id = t
            .semget(IPC_PRIVATE, 1, IPC_CREAT | 0o666, 1, 0, 0)
            .unwrap();

        // Try to decrement below 0 with IPC_NOWAIT
        assert_eq!(
            t.semop(
                id,
                &[SemOp {
                    num: 0,
                    op: -1,
                    flg: IPC_NOWAIT as u16
                }],
                1,
                0,
                0
            )
            .unwrap_err(),
            Errno::EAGAIN
        );
    }

    #[test]
    fn test_semop_wait_for_zero() {
        let mut t = IpcTable::new();
        let id = t
            .semget(IPC_PRIVATE, 1, IPC_CREAT | 0o666, 1, 0, 0)
            .unwrap();

        // Wait for zero on value 0 — should succeed immediately
        t.semop(
            id,
            &[SemOp {
                num: 0,
                op: 0,
                flg: 0,
            }],
            1,
            0,
            0,
        )
        .unwrap();

        // Set value to 1
        t.semop(
            id,
            &[SemOp {
                num: 0,
                op: 1,
                flg: 0,
            }],
            1,
            0,
            0,
        )
        .unwrap();

        // Wait for zero should fail with EAGAIN
        assert_eq!(
            t.semop(
                id,
                &[SemOp {
                    num: 0,
                    op: 0,
                    flg: IPC_NOWAIT as u16
                }],
                1,
                0,
                0
            )
            .unwrap_err(),
            Errno::EAGAIN
        );
    }

    #[test]
    fn test_semop_atomic_multi() {
        let mut t = IpcTable::new();
        let id = t
            .semget(IPC_PRIVATE, 2, IPC_CREAT | 0o666, 1, 0, 0)
            .unwrap();

        // Set initial values
        t.semop(
            id,
            &[SemOp {
                num: 0,
                op: 10,
                flg: 0,
            }],
            1,
            0,
            0,
        )
        .unwrap();
        t.semop(
            id,
            &[SemOp {
                num: 1,
                op: 5,
                flg: 0,
            }],
            1,
            0,
            0,
        )
        .unwrap();

        // Multi-op: decrement both. Should fail atomically if one can't proceed.
        assert_eq!(
            t.semop(
                id,
                &[
                    SemOp {
                        num: 0,
                        op: -3,
                        flg: 0
                    },
                    SemOp {
                        num: 1,
                        op: -6,
                        flg: IPC_NOWAIT as u16
                    }, // Can't: 5-6 < 0
                ],
                1,
                0,
                0
            )
            .unwrap_err(),
            Errno::EAGAIN
        );

        // Verify neither was changed (atomic failure)
        let v0 = match t.semctl(id, 0, GETVAL, 1, 0, 0, 0).unwrap() {
            SemCtlResult::Value(v) => v,
            _ => panic!(),
        };
        let v1 = match t.semctl(id, 1, GETVAL, 1, 0, 0, 0).unwrap() {
            SemCtlResult::Value(v) => v,
            _ => panic!(),
        };
        assert_eq!(v0, 10);
        assert_eq!(v1, 5);
    }

    #[test]
    fn test_semctl_setval_getval() {
        let mut t = IpcTable::new();
        let id = t
            .semget(IPC_PRIVATE, 3, IPC_CREAT | 0o666, 1, 0, 0)
            .unwrap();

        t.semctl(id, 1, SETVAL, 1, 42, 0, 0).unwrap();
        let val = match t.semctl(id, 1, GETVAL, 1, 0, 0, 0).unwrap() {
            SemCtlResult::Value(v) => v,
            _ => panic!("expected Value"),
        };
        assert_eq!(val, 42);
    }

    #[test]
    fn test_semctl_setall_getall() {
        let mut t = IpcTable::new();
        let id = t
            .semget(IPC_PRIVATE, 3, IPC_CREAT | 0o666, 1, 0, 0)
            .unwrap();

        t.semctl_set_all(id, &[10, 20, 30], 0, 0).unwrap();

        let vals = match t.semctl(id, 0, GETALL, 1, 0, 0, 0).unwrap() {
            SemCtlResult::All(v) => v,
            _ => panic!("expected All"),
        };
        assert_eq!(vals, vec![10, 20, 30]);
    }

    #[test]
    fn test_semctl_array_bytes_matches_size_and_command_permissions() {
        let mut t = IpcTable::new();
        let read_only = t
            .semget(IPC_PRIVATE, 3, IPC_CREAT | 0o400, 1, 1000, 1000)
            .unwrap();
        assert_eq!(
            t.semctl_array_bytes(read_only, GETALL, 1000, 1000),
            Ok(3 * core::mem::size_of::<u16>())
        );
        assert_eq!(
            t.semctl_array_bytes(read_only, SETALL, 1000, 1000),
            Err(Errno::EACCES)
        );

        let write_only = t
            .semget(IPC_PRIVATE, 2, IPC_CREAT | 0o200, 1, 1000, 1000)
            .unwrap();
        assert_eq!(
            t.semctl_array_bytes(write_only, SETALL, 1000, 1000),
            Ok(2 * core::mem::size_of::<u16>())
        );
        assert_eq!(
            t.semctl_array_bytes(write_only, GETALL, 1000, 1000),
            Err(Errno::EACCES)
        );
        assert_eq!(
            t.semctl_array_bytes(write_only, IPC_STAT, 1000, 1000),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn test_semctl_set_all_bytes_accepts_write_only_sets_without_ipc_stat() {
        let mut t = IpcTable::new();
        let write_only = t
            .semget(IPC_PRIVATE, 2, IPC_CREAT | 0o200, 1, 1000, 1000)
            .unwrap();

        t.semctl_set_all_bytes(write_only, &[10, 0, 20, 0], 1000, 1000)
            .unwrap();
        assert!(matches!(
            t.semctl(write_only, 0, GETALL, 1, 0, 1000, 1000),
            Err(Errno::EACCES)
        ));
        // Root reads the values only to verify the write; the operation above
        // succeeded using the owning process's write-only permission.
        let values = match t.semctl(write_only, 0, GETALL, 1, 0, 0, 0).unwrap() {
            SemCtlResult::All(values) => values,
            _ => panic!("expected all semaphore values"),
        };
        assert_eq!(values, vec![10, 20]);

        assert_eq!(
            t.semctl_set_all_bytes(write_only, &[30, 0], 1000, 1000),
            Err(Errno::EINVAL)
        );

        let read_only = t
            .semget(IPC_PRIVATE, 1, IPC_CREAT | 0o400, 1, 1000, 1000)
            .unwrap();
        assert_eq!(
            t.semctl_set_all_bytes(read_only, &[40, 0], 1000, 1000),
            Err(Errno::EACCES)
        );
    }

    #[test]
    fn test_semctl_stat() {
        let mut t = IpcTable::new();
        let id = t.semget(5678, 4, IPC_CREAT | 0o666, 1, 1000, 1000).unwrap();

        let info = match t.semctl(id, 0, IPC_STAT, 1, 0, 0, 0).unwrap() {
            SemCtlResult::Stat(s) => s,
            _ => panic!("expected Stat"),
        };
        assert_eq!(info.key, 5678);
        assert_eq!(info.nsems, 4);
        assert_eq!(info.mode, 0o666);
    }

    #[test]
    fn test_semctl_rmid() {
        let mut t = IpcTable::new();
        let id = t
            .semget(IPC_PRIVATE, 1, IPC_CREAT | 0o666, 1, 0, 0)
            .unwrap();
        t.semctl(id, 0, IPC_RMID, 1, 0, 0, 0).unwrap();
        assert_eq!(
            t.semctl(id, 0, IPC_STAT, 1, 0, 0, 0).unwrap_err(),
            Errno::EINVAL
        );
    }

    #[test]
    fn pinned_semop_returns_eidrm_after_rmid_and_immediate_id_reuse() {
        let mut t = IpcTable::new();
        let semid = t
            .semget(IPC_PRIVATE, 1, IPC_CREAT | 0o666, 1, 0, 0)
            .unwrap();
        let pin = t.pin_sem_set(semid).unwrap();
        let removed_generation = pin.generation;
        let decrement = [SemOp {
            num: 0,
            op: -1,
            flg: 0,
        }];

        assert_eq!(
            t.semop_pinned(&pin, &decrement, 1, 0, 0),
            Err(Errno::EAGAIN)
        );
        t.semctl(semid, 0, IPC_RMID, 1, 0, 0, 0).unwrap();
        assert!(!t.sem_sets.contains_key(&semid));
        assert_eq!(t.removed_sem_sets[&removed_generation].active_pins, 1);

        t.set_next_public_id_for_test(semid);
        let replacement = t
            .semget(IPC_PRIVATE, 1, IPC_CREAT | 0o666, 2, 0, 0)
            .unwrap();
        assert_eq!(replacement, semid);
        assert_ne!(t.sem_sets[&replacement].generation, removed_generation);
        t.semctl(replacement, 0, SETVAL, 2, 2, 0, 0).unwrap();

        assert_eq!(t.semop_pinned(&pin, &decrement, 1, 0, 0), Err(Errno::EIDRM));
        t.semop(replacement, &decrement, 2, 0, 0).unwrap();
        assert!(matches!(
            t.semctl(replacement, 0, GETVAL, 2, 0, 0, 0),
            Ok(SemCtlResult::Value(1))
        ));

        t.release_sem_set_pin(pin).unwrap();
        assert!(!t.removed_sem_sets.contains_key(&removed_generation));
    }

    #[test]
    fn semaphore_pin_release_is_exact_and_reclaims_after_last_pin() {
        let mut t = IpcTable::new();
        let semid = t
            .semget(IPC_PRIVATE, 1, IPC_CREAT | 0o666, 1, 0, 0)
            .unwrap();
        let first = t.pin_sem_set(semid).unwrap();
        let duplicate = first.duplicate_for_exact_release_test();
        let second = t.pin_sem_set(semid).unwrap();
        let generation = first.generation;

        assert_eq!(t.sem_sets[&semid].active_pins, 2);
        t.semctl(semid, 0, IPC_RMID, 1, 0, 0, 0).unwrap();
        assert_eq!(t.removed_sem_sets[&generation].active_pins, 2);

        t.release_sem_set_pin(first).unwrap();
        assert_eq!(t.removed_sem_sets[&generation].active_pins, 1);
        assert_eq!(t.release_sem_set_pin(duplicate), Err(Errno::EINVAL));
        assert_eq!(t.removed_sem_sets[&generation].active_pins, 1);

        t.release_sem_set_pin(second).unwrap();
        assert!(!t.removed_sem_sets.contains_key(&generation));
        assert!(t.active_sem_pins.is_empty());
    }

    #[test]
    fn forced_process_removal_releases_blocked_message_and_semaphore_pins() {
        use wasm_posix_shared::abi::extended_syscalls::{SYS_MSGSND, SYS_SEMOP};

        let mut processes = crate::process_table::ProcessTable::new();
        let pid = processes.create_process().unwrap();
        let worker_tid = pid + 1;
        processes
            .get_mut(pid)
            .unwrap()
            .add_thread(crate::process::ThreadInfo::new(worker_tid, 0, 0, 0));
        let (qid, queue_generation, semid, semaphore_generation) = {
            let ipc = unsafe { global_ipc_table() };
            let qid = ipc
                .msgget(IPC_PRIVATE, IPC_CREAT | 0o600, pid, 0, 0)
                .unwrap();
            let semid = ipc
                .semget(IPC_PRIVATE, 1, IPC_CREAT | 0o600, pid, 0, 0)
                .unwrap();
            (
                qid,
                ipc.msg_queues[&qid].generation,
                semid,
                ipc.sem_sets[&semid].generation,
            )
        };

        crate::syscalls::ensure_blocking_retry_sysv_message_binding(
            processes.get_mut(pid).unwrap(),
            pid,
            SYS_MSGSND,
            qid,
        )
        .unwrap();
        crate::syscalls::ensure_blocking_retry_sysv_semaphore_binding(
            processes.get_mut(pid).unwrap(),
            worker_tid,
            SYS_SEMOP,
            semid,
        )
        .unwrap();
        {
            let ipc = unsafe { global_ipc_table() };
            ipc.msgctl(qid, IPC_RMID, pid, 0, 0).unwrap();
            ipc.semctl(semid, 0, IPC_RMID, pid, 0, 0, 0).unwrap();
            assert_eq!(ipc.removed_msg_queues[&queue_generation].active_pins, 1,);
            assert_eq!(ipc.removed_sem_sets[&semaphore_generation].active_pins, 1,);
        }

        processes.remove_process(pid).unwrap();

        let ipc = unsafe { global_ipc_table() };
        assert!(!ipc.removed_msg_queues.contains_key(&queue_generation));
        assert!(!ipc.removed_sem_sets.contains_key(&semaphore_generation));
        assert!(
            ipc.active_msg_pins
                .values()
                .all(|generation| *generation != queue_generation),
        );
        assert!(
            ipc.active_sem_pins
                .values()
                .all(|generation| *generation != semaphore_generation),
        );
    }

    #[test]
    fn test_semctl_getpid() {
        let mut t = IpcTable::new();
        let id = t
            .semget(IPC_PRIVATE, 1, IPC_CREAT | 0o666, 1, 0, 0)
            .unwrap();

        t.semop(
            id,
            &[SemOp {
                num: 0,
                op: 1,
                flg: 0,
            }],
            99,
            0,
            0,
        )
        .unwrap();

        let pid = match t.semctl(id, 0, GETPID, 1, 0, 0, 0).unwrap() {
            SemCtlResult::Value(v) => v,
            _ => panic!("expected Value"),
        };
        assert_eq!(pid, 99);
    }

    // ── Shared Memory Tests ──

    #[test]
    fn test_shmget_create() {
        let mut t = IpcTable::new();
        let id = t
            .shmget(9999, 4096, IPC_CREAT | 0o666, 1, 1000, 1000)
            .unwrap();
        assert!(id >= 0);

        // Get same segment by key
        let id2 = t.shmget(9999, 0, 0, 1, 1000, 1000).unwrap();
        assert_eq!(id, id2);
    }

    #[test]
    fn test_shmget_exclusive() {
        let mut t = IpcTable::new();
        t.shmget(9999, 4096, IPC_CREAT | 0o666, 1, 1000, 1000)
            .unwrap();
        assert_eq!(
            t.shmget(9999, 4096, IPC_CREAT | IPC_EXCL | 0o666, 1, 1000, 1000)
                .unwrap_err(),
            Errno::EEXIST
        );
    }

    #[test]
    fn test_shmget_zero_size() {
        let mut t = IpcTable::new();
        assert_eq!(
            t.shmget(IPC_PRIVATE, 0, IPC_CREAT | 0o666, 1, 0, 0)
                .unwrap_err(),
            Errno::EINVAL
        );
    }

    #[test]
    fn test_shmat_shmdt() {
        let mut t = IpcTable::new();
        let id = t
            .shmget(IPC_PRIVATE, 1024, IPC_CREAT | 0o666, 42, 0, 0)
            .unwrap();

        let size = t.shmat(id, 42, 0, 0, 0).unwrap();
        assert_eq!(size, 1024);

        // Check nattch
        let info = t.shmctl(id, IPC_STAT, 1, 0, 0).unwrap().unwrap();
        assert_eq!(info.nattch, 1);
        assert_eq!(info.lpid, 42);

        // Detach
        t.shmdt(id, 42).unwrap();
        let info = t.shmctl(id, IPC_STAT, 1, 0, 0).unwrap().unwrap();
        assert_eq!(info.nattch, 0);
    }

    #[test]
    fn test_shm_read_write_chunk() {
        let mut t = IpcTable::new();
        let id = t
            .shmget(IPC_PRIVATE, 256, IPC_CREAT | 0o666, 1, 0, 0)
            .unwrap();

        // Write data
        let data = b"Hello, shared memory!";
        let written = t.shm_write_chunk(id, 0, data).unwrap();
        assert_eq!(written, data.len() as u32);

        // Read it back
        let mut buf = [0u8; 64];
        let read = t.shm_read_chunk(id, 0, &mut buf).unwrap();
        assert_eq!(read, 64);
        assert_eq!(&buf[..data.len()], data);
    }

    #[test]
    fn test_shm_chunk_offset() {
        let mut t = IpcTable::new();
        let id = t
            .shmget(IPC_PRIVATE, 256, IPC_CREAT | 0o666, 1, 0, 0)
            .unwrap();

        // Write at offset
        t.shm_write_chunk(id, 100, b"offset").unwrap();

        // Read from offset
        let mut buf = [0u8; 10];
        t.shm_read_chunk(id, 100, &mut buf).unwrap();
        assert_eq!(&buf[..6], b"offset");
    }

    #[test]
    fn test_shmctl_stat() {
        let mut t = IpcTable::new();
        let id = t
            .shmget(9999, 4096, IPC_CREAT | 0o666, 42, 1000, 1000)
            .unwrap();

        let info = t.shmctl(id, IPC_STAT, 1, 0, 0).unwrap().unwrap();
        assert_eq!(info.key, 9999);
        assert_eq!(info.segsz, 4096);
        assert_eq!(info.cpid, 42);
        assert_eq!(info.mode, 0o666);
    }

    #[test]
    fn test_shmctl_set_applies_permitted_fields_and_permissions() {
        let mut t = IpcTable::new();
        let id = t
            .shmget(IPC_PRIVATE, 4096, IPC_CREAT | 0o666, 1, 1000, 1000)
            .unwrap();

        t.shmctl_set(id, 2000, 2001, 0o1640, 1000).unwrap();
        let info = t.shmctl(id, IPC_STAT, 1, 0, 0).unwrap().unwrap();
        assert_eq!(info.uid, 2000);
        assert_eq!(info.gid, 2001);
        assert_eq!(info.cuid, 1000);
        assert_eq!(info.cgid, 1000);
        assert_eq!(info.mode, 0o640);
        assert_eq!(info.segsz, 4096);

        assert_eq!(t.shmctl_set(id, 3000, 3001, 0o600, 3000), Err(Errno::EPERM));
        let info = t.shmctl(id, IPC_STAT, 1, 0, 0).unwrap().unwrap();
        assert_eq!(info.uid, 2000);
        assert_eq!(info.gid, 2001);
        assert_eq!(info.mode, 0o640);
    }

    #[test]
    fn test_shmctl_rmid() {
        let mut t = IpcTable::new();
        let id = t
            .shmget(IPC_PRIVATE, 1024, IPC_CREAT | 0o666, 1, 0, 0)
            .unwrap();
        t.shmctl(id, IPC_RMID, 1, 0, 0).unwrap();
        assert_eq!(t.shmctl(id, IPC_STAT, 1, 0, 0).unwrap_err(), Errno::EINVAL);
    }

    #[test]
    fn test_shmget_private_unique() {
        let mut t = IpcTable::new();
        let id1 = t
            .shmget(IPC_PRIVATE, 512, IPC_CREAT | 0o666, 1, 0, 0)
            .unwrap();
        let id2 = t
            .shmget(IPC_PRIVATE, 512, IPC_CREAT | 0o666, 1, 0, 0)
            .unwrap();
        assert_ne!(id1, id2);
    }

    #[test]
    fn shared_public_id_allocator_skips_cross_class_collisions() {
        let mut t = IpcTable::new();
        let msgid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();
        assert_eq!(msgid, 0);

        t.set_next_public_id_for_test(msgid);
        let semid = t
            .semget(IPC_PRIVATE, 1, IPC_CREAT | 0o666, 1, 0, 0)
            .unwrap();
        assert_eq!(semid, 1);

        t.set_next_public_id_for_test(msgid);
        let shmid = t
            .shmget(IPC_PRIVATE, 1, IPC_CREAT | 0o666, 1, 0, 0)
            .unwrap();
        assert_eq!(shmid, 2);
    }

    #[test]
    fn shared_public_id_allocator_wraps_without_overwriting_live_ids() {
        let mut t = IpcTable::new();
        assert_eq!(
            t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap(),
            0
        );
        assert_eq!(
            t.semget(IPC_PRIVATE, 1, IPC_CREAT | 0o666, 1, 0, 0)
                .unwrap(),
            1
        );

        t.set_next_public_id_for_test(i32::MAX);
        assert_eq!(
            t.shmget(IPC_PRIVATE, 1, IPC_CREAT | 0o666, 1, 0, 0)
                .unwrap(),
            i32::MAX
        );
        assert_eq!(
            t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap(),
            2
        );
        assert!(t.msg_queues.contains_key(&0));
        assert!(t.sem_sets.contains_key(&1));
        assert!(t.shm_segments.contains_key(&i32::MAX));
    }

    #[test]
    fn shared_public_id_allocator_reports_bounded_exhaustion() {
        let mut t = IpcTable::new();
        assert_eq!(
            t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap(),
            0
        );
        assert_eq!(
            t.semget(IPC_PRIVATE, 1, IPC_CREAT | 0o666, 1, 0, 0)
                .unwrap(),
            1
        );
        assert_eq!(
            t.shmget(IPC_PRIVATE, 1, IPC_CREAT | 0o666, 1, 0, 0)
                .unwrap(),
            2
        );

        t.set_next_public_id_for_test(0);
        assert_eq!(t.alloc_id_bounded(2), Err(Errno::ENOSPC));
        assert!(t.msg_queues.contains_key(&0));
        assert!(t.sem_sets.contains_key(&1));
        assert!(t.shm_segments.contains_key(&2));
    }
}
