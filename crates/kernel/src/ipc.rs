//! SysV IPC implementation: message queues, semaphore sets, shared memory.
//!
//! In centralized mode, all IPC operations are handled by the kernel.
//! The host marshals data between process memory and kernel scratch;
//! all IPC logic and storage lives here.

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec;
use alloc::vec::Vec;
use alloc::collections::VecDeque;
use wasm_posix_shared::Errno;

// ── IPC constants ──

const IPC_CREAT: u32 = 0o1000;
const IPC_EXCL: u32 = 0o2000;
const IPC_NOWAIT: u32 = 0o4000;
const IPC_PRIVATE: i32 = 0;
const IPC_RMID: i32 = 0;
const IPC_SET: i32 = 1;
const IPC_STAT: i32 = 2;

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
const MSGMAX: usize = 8192;     // max message size
const MSGMNB: u32 = 16384;      // default max bytes in queue
const SEMMSL: usize = 32;       // max semaphores per set

// ── Data structures ──

/// A single message in a SysV message queue.
struct MsgEntry {
    mtype: i32,
    data: Vec<u8>,
}

/// SysV message queue.
struct MsgQueue {
    key: i32,
    id: i32,
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
    pub mtype: i32,
    pub data: Vec<u8>,
}

/// A single semaphore within a set.
struct SemValue {
    val: u16,
    pid: u32,
    // ncnt/zcnt are not truly tracked (would require blocking, which
    // we don't do in centralized mode), but we store them for IPC_STAT.
    ncnt: u32,
    zcnt: u32,
}

/// SysV semaphore set.
struct SemSet {
    key: i32,
    id: i32,
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

// ── IPC Table ──

/// Global SysV IPC table holding message queues, semaphore sets,
/// and shared memory segments.
pub struct IpcTable {
    msg_queues: BTreeMap<i32, MsgQueue>,
    sem_sets: BTreeMap<i32, SemSet>,
    shm_segments: BTreeMap<i32, ShmSegment>,
    next_id: i32,
}

impl IpcTable {
    pub const fn new() -> Self {
        IpcTable {
            msg_queues: BTreeMap::new(),
            sem_sets: BTreeMap::new(),
            shm_segments: BTreeMap::new(),
            next_id: 0,
        }
    }

    fn alloc_id(&mut self) -> i32 {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1) & 0x7FFF_FFFF;
        id
    }

    // ═══════════════════════════════════════════════════════════════
    // Message Queues
    // ═══════════════════════════════════════════════════════════════

    /// Get or create a message queue.
    pub fn msgget(&mut self, key: i32, flags: u32, _pid: u32, uid: u32, gid: u32) -> Result<i32, Errno> {
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
                    return Ok(q.id);
                }
            }
        }

        if !creating && key != IPC_PRIVATE {
            return Err(Errno::ENOENT);
        }

        let id = self.alloc_id();
        let seq = id;
        self.msg_queues.insert(id, MsgQueue {
            key,
            id,
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
        });

        Ok(id)
    }

    /// Send a message to a queue.
    pub fn msgsnd(&mut self, qid: i32, mtype: i32, data: &[u8], flags: u32, pid: u32) -> Result<(), Errno> {
        if mtype <= 0 {
            return Err(Errno::EINVAL);
        }
        let q = self.msg_queues.get_mut(&qid).ok_or(Errno::EINVAL)?;

        if data.len() > MSGMAX {
            return Err(Errno::EINVAL);
        }

        // Check queue capacity
        if q.cbytes + data.len() as u32 > q.qbytes {
            if (flags & IPC_NOWAIT) != 0 {
                return Err(Errno::EAGAIN);
            }
            // In centralized mode, return EAGAIN for host retry
            return Err(Errno::EAGAIN);
        }

        q.cbytes += data.len() as u32;
        q.messages.push_back(MsgEntry {
            mtype,
            data: Vec::from(data),
        });
        q.lspid = pid as i32;
        q.stime = crate::current_time_secs();

        Ok(())
    }

    /// Receive a message from a queue.
    pub fn msgrcv(
        &mut self,
        qid: i32,
        max_size: u32,
        msgtype: i32,
        flags: u32,
        pid: u32,
    ) -> Result<MsgRcvResult, Errno> {
        let q = self.msg_queues.get_mut(&qid).ok_or(Errno::EINVAL)?;

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
            let abs_type = -msgtype;
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

        // Check size
        if msg.data.len() > max_size as usize {
            if !noerror {
                return Err(Errno::E2BIG);
            }
        }

        let msg = q.messages.remove(idx).unwrap();
        let truncated_len = core::cmp::min(msg.data.len(), max_size as usize);
        let data = if truncated_len < msg.data.len() {
            msg.data[..truncated_len].to_vec()
        } else {
            msg.data
        };

        q.cbytes = q.cbytes.saturating_sub(data.len() as u32);
        q.lrpid = pid as i32;
        q.rtime = crate::current_time_secs();

        Ok(MsgRcvResult { mtype: msg.mtype, data })
    }

    /// Message queue control operations.
    pub fn msgctl(&mut self, qid: i32, cmd: i32, _pid: u32) -> Result<Option<MsgQueueInfo>, Errno> {
        match cmd {
            IPC_STAT => {
                let q = self.msg_queues.get(&qid).ok_or(Errno::EINVAL)?;
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
                self.msg_queues.remove(&qid).ok_or(Errno::EINVAL)?;
                Ok(None)
            }
            IPC_SET => {
                let q = self.msg_queues.get_mut(&qid).ok_or(Errno::EINVAL)?;
                q.ctime = crate::current_time_secs();
                Ok(None)
            }
            _ => Err(Errno::EINVAL),
        }
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

        let id = self.alloc_id();
        let seq = id;
        let values = (0..nsems)
            .map(|_| SemValue { val: 0, pid: 0, ncnt: 0, zcnt: 0 })
            .collect();

        self.sem_sets.insert(id, SemSet {
            key,
            id,
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
        });

        Ok(id)
    }

    /// Perform atomic semaphore operations (two-pass: validate then apply).
    pub fn semop(&mut self, semid: i32, sops: &[SemOp], pid: u32) -> Result<(), Errno> {
        let s = self.sem_sets.get(&semid).ok_or(Errno::EINVAL)?;

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
        let s = self.sem_sets.get_mut(&semid).unwrap();
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
    ) -> Result<SemCtlResult, Errno> {
        match cmd {
            IPC_STAT => {
                let s = self.sem_sets.get(&semid).ok_or(Errno::EINVAL)?;
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
                self.sem_sets.remove(&semid).ok_or(Errno::EINVAL)?;
                Ok(SemCtlResult::Ok)
            }
            IPC_SET => {
                let s = self.sem_sets.get_mut(&semid).ok_or(Errno::EINVAL)?;
                s.ctime = crate::current_time_secs();
                Ok(SemCtlResult::Ok)
            }
            GETVAL => {
                let s = self.sem_sets.get(&semid).ok_or(Errno::EINVAL)?;
                if semnum < 0 || semnum as u32 >= s.nsems {
                    return Err(Errno::EINVAL);
                }
                Ok(SemCtlResult::Value(s.values[semnum as usize].val as i32))
            }
            SETVAL => {
                let s = self.sem_sets.get_mut(&semid).ok_or(Errno::EINVAL)?;
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
                if semnum < 0 || semnum as u32 >= s.nsems {
                    return Err(Errno::EINVAL);
                }
                Ok(SemCtlResult::Value(s.values[semnum as usize].pid as i32))
            }
            GETNCNT => {
                let s = self.sem_sets.get(&semid).ok_or(Errno::EINVAL)?;
                if semnum < 0 || semnum as u32 >= s.nsems {
                    return Err(Errno::EINVAL);
                }
                Ok(SemCtlResult::Value(s.values[semnum as usize].ncnt as i32))
            }
            GETZCNT => {
                let s = self.sem_sets.get(&semid).ok_or(Errno::EINVAL)?;
                if semnum < 0 || semnum as u32 >= s.nsems {
                    return Err(Errno::EINVAL);
                }
                Ok(SemCtlResult::Value(s.values[semnum as usize].zcnt as i32))
            }
            _ => Err(Errno::EINVAL),
        }
    }

    /// Set all semaphore values in a set (SETALL command).
    pub fn semctl_set_all(&mut self, semid: i32, values: &[u16]) -> Result<(), Errno> {
        let s = self.sem_sets.get_mut(&semid).ok_or(Errno::EINVAL)?;
        if values.len() != s.nsems as usize {
            return Err(Errno::EINVAL);
        }
        for (i, &v) in values.iter().enumerate() {
            s.values[i].val = v;
        }
        s.ctime = crate::current_time_secs();
        Ok(())
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

        let id = self.alloc_id();
        let seq = id;
        self.shm_segments.insert(id, ShmSegment {
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
        });

        Ok(id)
    }

    /// Attach to a shared memory segment.
    /// Returns the segment size. The caller reads data via shm_read_chunk.
    pub fn shmat(&mut self, shmid: i32, pid: u32) -> Result<u32, Errno> {
        let seg = self.shm_segments.get_mut(&shmid).ok_or(Errno::EINVAL)?;
        seg.nattch += 1;
        seg.lpid = pid as i32;
        seg.atime = crate::current_time_secs();
        Ok(seg.segsz)
    }

    /// Read a chunk of shared memory segment data into a buffer.
    /// Returns bytes written.
    pub fn shm_read_chunk(
        &self,
        shmid: i32,
        offset: u32,
        buf: &mut [u8],
    ) -> Result<u32, Errno> {
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
    pub fn shm_write_chunk(
        &mut self,
        shmid: i32,
        offset: u32,
        data: &[u8],
    ) -> Result<u32, Errno> {
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
    pub fn shmctl(&mut self, shmid: i32, cmd: i32, _pid: u32) -> Result<Option<ShmSegInfo>, Errno> {
        match cmd {
            IPC_STAT => {
                let seg = self.shm_segments.get(&shmid).ok_or(Errno::EINVAL)?;
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
                self.shm_segments.remove(&shmid).ok_or(Errno::EINVAL)?;
                Ok(None)
            }
            IPC_SET => {
                let seg = self.shm_segments.get_mut(&shmid).ok_or(Errno::EINVAL)?;
                seg.ctime = crate::current_time_secs();
                Ok(None)
            }
            _ => Err(Errno::EINVAL),
        }
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
            t.msgget(1234, IPC_CREAT | IPC_EXCL | 0o666, 1, 1000, 1000).unwrap_err(),
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
        let id1 = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 1000, 1000).unwrap();
        let id2 = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 1000, 1000).unwrap();
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_msgsnd_msgrcv_fifo() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        t.msgsnd(qid, 1, b"hello", 0, 42).unwrap();
        t.msgsnd(qid, 2, b"world", 0, 42).unwrap();

        // msgtype=0: FIFO order
        let msg = t.msgrcv(qid, 100, 0, 0, 43).unwrap();
        assert_eq!(msg.mtype, 1);
        assert_eq!(msg.data, b"hello");

        let msg = t.msgrcv(qid, 100, 0, 0, 43).unwrap();
        assert_eq!(msg.mtype, 2);
        assert_eq!(msg.data, b"world");
    }

    #[test]
    fn test_msgrcv_type_filter() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        t.msgsnd(qid, 1, b"one", 0, 1).unwrap();
        t.msgsnd(qid, 2, b"two", 0, 1).unwrap();
        t.msgsnd(qid, 3, b"three", 0, 1).unwrap();

        // Receive type 2 specifically
        let msg = t.msgrcv(qid, 100, 2, 0, 1).unwrap();
        assert_eq!(msg.mtype, 2);
        assert_eq!(msg.data, b"two");
    }

    #[test]
    fn test_msgrcv_negative_type() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        t.msgsnd(qid, 5, b"five", 0, 1).unwrap();
        t.msgsnd(qid, 2, b"two", 0, 1).unwrap();
        t.msgsnd(qid, 3, b"three", 0, 1).unwrap();

        // Negative type: first with type <= |msgtype|
        let msg = t.msgrcv(qid, 100, -3, 0, 1).unwrap();
        // Should get type 2 (first match <= 3, scanning in order: 5>3 skip, 2<=3 match)
        assert_eq!(msg.mtype, 2);
    }

    #[test]
    fn test_msgrcv_except() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        t.msgsnd(qid, 1, b"one", 0, 1).unwrap();
        t.msgsnd(qid, 2, b"two", 0, 1).unwrap();

        // MSG_EXCEPT: first message NOT of type 1
        let msg = t.msgrcv(qid, 100, 1, MSG_EXCEPT, 1).unwrap();
        assert_eq!(msg.mtype, 2);
    }

    #[test]
    fn test_msgrcv_truncate() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        t.msgsnd(qid, 1, b"hello world", 0, 1).unwrap();

        // Without MSG_NOERROR, too-small buffer returns E2BIG
        assert_eq!(t.msgrcv(qid, 5, 0, 0, 1).unwrap_err(), Errno::E2BIG);

        // With MSG_NOERROR, truncates
        let msg = t.msgrcv(qid, 5, 0, MSG_NOERROR, 1).unwrap();
        assert_eq!(msg.data, b"hello");
    }

    #[test]
    fn test_msgrcv_empty_nowait() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        assert_eq!(t.msgrcv(qid, 100, 0, IPC_NOWAIT, 1).unwrap_err(), Errno::ENOMSG);
    }

    #[test]
    fn test_msgsnd_invalid_type() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();
        assert_eq!(t.msgsnd(qid, 0, b"x", 0, 1).unwrap_err(), Errno::EINVAL);
        assert_eq!(t.msgsnd(qid, -1, b"x", 0, 1).unwrap_err(), Errno::EINVAL);
    }

    #[test]
    fn test_msgctl_stat() {
        let mut t = IpcTable::new();
        let qid = t.msgget(1234, IPC_CREAT | 0o666, 1, 1000, 1000).unwrap();
        t.msgsnd(qid, 1, b"test", 0, 42).unwrap();

        let info = t.msgctl(qid, IPC_STAT, 1).unwrap().unwrap();
        assert_eq!(info.key, 1234);
        assert_eq!(info.mode, 0o666);
        assert_eq!(info.qnum, 1);
        assert_eq!(info.cbytes, 4);
        assert_eq!(info.lspid, 42);
    }

    #[test]
    fn test_msgctl_rmid() {
        let mut t = IpcTable::new();
        let qid = t.msgget(IPC_PRIVATE, IPC_CREAT | 0o666, 1, 0, 0).unwrap();
        t.msgctl(qid, IPC_RMID, 1).unwrap();
        assert_eq!(t.msgctl(qid, IPC_STAT, 1).unwrap_err(), Errno::EINVAL);
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
            t.semget(5678, 3, IPC_CREAT | IPC_EXCL | 0o666, 1, 1000, 1000).unwrap_err(),
            Errno::EEXIST
        );
    }

    #[test]
    fn test_semop_increment_decrement() {
        let mut t = IpcTable::new();
        let id = t.semget(IPC_PRIVATE, 2, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        // Increment semaphore 0 by 5
        t.semop(id, &[SemOp { num: 0, op: 5, flg: 0 }], 42).unwrap();

        let val = match t.semctl(id, 0, GETVAL, 1, 0).unwrap() {
            SemCtlResult::Value(v) => v,
            _ => panic!("expected Value"),
        };
        assert_eq!(val, 5);

        // Decrement by 3
        t.semop(id, &[SemOp { num: 0, op: -3, flg: 0 }], 42).unwrap();
        let val = match t.semctl(id, 0, GETVAL, 1, 0).unwrap() {
            SemCtlResult::Value(v) => v,
            _ => panic!("expected Value"),
        };
        assert_eq!(val, 2);
    }

    #[test]
    fn test_semop_would_block() {
        let mut t = IpcTable::new();
        let id = t.semget(IPC_PRIVATE, 1, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        // Try to decrement below 0 with IPC_NOWAIT
        assert_eq!(
            t.semop(id, &[SemOp { num: 0, op: -1, flg: IPC_NOWAIT as u16 }], 1).unwrap_err(),
            Errno::EAGAIN
        );
    }

    #[test]
    fn test_semop_wait_for_zero() {
        let mut t = IpcTable::new();
        let id = t.semget(IPC_PRIVATE, 1, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        // Wait for zero on value 0 — should succeed immediately
        t.semop(id, &[SemOp { num: 0, op: 0, flg: 0 }], 1).unwrap();

        // Set value to 1
        t.semop(id, &[SemOp { num: 0, op: 1, flg: 0 }], 1).unwrap();

        // Wait for zero should fail with EAGAIN
        assert_eq!(
            t.semop(id, &[SemOp { num: 0, op: 0, flg: IPC_NOWAIT as u16 }], 1).unwrap_err(),
            Errno::EAGAIN
        );
    }

    #[test]
    fn test_semop_atomic_multi() {
        let mut t = IpcTable::new();
        let id = t.semget(IPC_PRIVATE, 2, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        // Set initial values
        t.semop(id, &[SemOp { num: 0, op: 10, flg: 0 }], 1).unwrap();
        t.semop(id, &[SemOp { num: 1, op: 5, flg: 0 }], 1).unwrap();

        // Multi-op: decrement both. Should fail atomically if one can't proceed.
        assert_eq!(
            t.semop(id, &[
                SemOp { num: 0, op: -3, flg: 0 },
                SemOp { num: 1, op: -6, flg: IPC_NOWAIT as u16 }, // Can't: 5-6 < 0
            ], 1).unwrap_err(),
            Errno::EAGAIN
        );

        // Verify neither was changed (atomic failure)
        let v0 = match t.semctl(id, 0, GETVAL, 1, 0).unwrap() {
            SemCtlResult::Value(v) => v, _ => panic!(),
        };
        let v1 = match t.semctl(id, 1, GETVAL, 1, 0).unwrap() {
            SemCtlResult::Value(v) => v, _ => panic!(),
        };
        assert_eq!(v0, 10);
        assert_eq!(v1, 5);
    }

    #[test]
    fn test_semctl_setval_getval() {
        let mut t = IpcTable::new();
        let id = t.semget(IPC_PRIVATE, 3, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        t.semctl(id, 1, SETVAL, 1, 42).unwrap();
        let val = match t.semctl(id, 1, GETVAL, 1, 0).unwrap() {
            SemCtlResult::Value(v) => v,
            _ => panic!("expected Value"),
        };
        assert_eq!(val, 42);
    }

    #[test]
    fn test_semctl_setall_getall() {
        let mut t = IpcTable::new();
        let id = t.semget(IPC_PRIVATE, 3, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        t.semctl_set_all(id, &[10, 20, 30]).unwrap();

        let vals = match t.semctl(id, 0, GETALL, 1, 0).unwrap() {
            SemCtlResult::All(v) => v,
            _ => panic!("expected All"),
        };
        assert_eq!(vals, vec![10, 20, 30]);
    }

    #[test]
    fn test_semctl_stat() {
        let mut t = IpcTable::new();
        let id = t.semget(5678, 4, IPC_CREAT | 0o666, 1, 1000, 1000).unwrap();

        let info = match t.semctl(id, 0, IPC_STAT, 1, 0).unwrap() {
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
        let id = t.semget(IPC_PRIVATE, 1, IPC_CREAT | 0o666, 1, 0, 0).unwrap();
        t.semctl(id, 0, IPC_RMID, 1, 0).unwrap();
        assert_eq!(t.semctl(id, 0, IPC_STAT, 1, 0).unwrap_err(), Errno::EINVAL);
    }

    #[test]
    fn test_semctl_getpid() {
        let mut t = IpcTable::new();
        let id = t.semget(IPC_PRIVATE, 1, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

        t.semop(id, &[SemOp { num: 0, op: 1, flg: 0 }], 99).unwrap();

        let pid = match t.semctl(id, 0, GETPID, 1, 0).unwrap() {
            SemCtlResult::Value(v) => v,
            _ => panic!("expected Value"),
        };
        assert_eq!(pid, 99);
    }

    // ── Shared Memory Tests ──

    #[test]
    fn test_shmget_create() {
        let mut t = IpcTable::new();
        let id = t.shmget(9999, 4096, IPC_CREAT | 0o666, 1, 1000, 1000).unwrap();
        assert!(id >= 0);

        // Get same segment by key
        let id2 = t.shmget(9999, 0, 0, 1, 1000, 1000).unwrap();
        assert_eq!(id, id2);
    }

    #[test]
    fn test_shmget_exclusive() {
        let mut t = IpcTable::new();
        t.shmget(9999, 4096, IPC_CREAT | 0o666, 1, 1000, 1000).unwrap();
        assert_eq!(
            t.shmget(9999, 4096, IPC_CREAT | IPC_EXCL | 0o666, 1, 1000, 1000).unwrap_err(),
            Errno::EEXIST
        );
    }

    #[test]
    fn test_shmget_zero_size() {
        let mut t = IpcTable::new();
        assert_eq!(
            t.shmget(IPC_PRIVATE, 0, IPC_CREAT | 0o666, 1, 0, 0).unwrap_err(),
            Errno::EINVAL
        );
    }

    #[test]
    fn test_shmat_shmdt() {
        let mut t = IpcTable::new();
        let id = t.shmget(IPC_PRIVATE, 1024, IPC_CREAT | 0o666, 42, 0, 0).unwrap();

        let size = t.shmat(id, 42).unwrap();
        assert_eq!(size, 1024);

        // Check nattch
        let info = t.shmctl(id, IPC_STAT, 1).unwrap().unwrap();
        assert_eq!(info.nattch, 1);
        assert_eq!(info.lpid, 42);

        // Detach
        t.shmdt(id, 42).unwrap();
        let info = t.shmctl(id, IPC_STAT, 1).unwrap().unwrap();
        assert_eq!(info.nattch, 0);
    }

    #[test]
    fn test_shm_read_write_chunk() {
        let mut t = IpcTable::new();
        let id = t.shmget(IPC_PRIVATE, 256, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

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
        let id = t.shmget(IPC_PRIVATE, 256, IPC_CREAT | 0o666, 1, 0, 0).unwrap();

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
        let id = t.shmget(9999, 4096, IPC_CREAT | 0o666, 42, 1000, 1000).unwrap();

        let info = t.shmctl(id, IPC_STAT, 1).unwrap().unwrap();
        assert_eq!(info.key, 9999);
        assert_eq!(info.segsz, 4096);
        assert_eq!(info.cpid, 42);
        assert_eq!(info.mode, 0o666);
    }

    #[test]
    fn test_shmctl_rmid() {
        let mut t = IpcTable::new();
        let id = t.shmget(IPC_PRIVATE, 1024, IPC_CREAT | 0o666, 1, 0, 0).unwrap();
        t.shmctl(id, IPC_RMID, 1).unwrap();
        assert_eq!(t.shmctl(id, IPC_STAT, 1).unwrap_err(), Errno::EINVAL);
    }

    #[test]
    fn test_shmget_private_unique() {
        let mut t = IpcTable::new();
        let id1 = t.shmget(IPC_PRIVATE, 512, IPC_CREAT | 0o666, 1, 0, 0).unwrap();
        let id2 = t.shmget(IPC_PRIVATE, 512, IPC_CREAT | 0o666, 1, 0, 0).unwrap();
        assert_ne!(id1, id2);
    }
}
