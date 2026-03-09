//! Binary serialization/deserialization of Process state for fork.
//!
//! The binary format is little-endian and consists of:
//! - Header (12 bytes): magic, version, total_size
//! - Scalars (32 bytes): ppid, uid, gid, euid, egid, pgid, sid, umask
//! - Signal state (variable): blocked mask + non-default handlers
//! - FD table (variable): max_fds, then each open fd entry
//! - OFD table (variable): each open file description
//! - Environment (variable): env var strings
//! - CWD (variable): current working directory bytes
//! - Rlimits (256 bytes): 16 pairs of u64
//! - Terminal (56 bytes): flags, control chars, window size

extern crate alloc;

use alloc::vec::Vec;
use wasm_posix_shared::Errno;

use crate::fd::{FdEntry, FdTable, OpenFileDescRef};
use crate::lock::LockTable;
use crate::memory::MemoryManager;
use crate::ofd::{FileType, OfdTable, OpenFileDesc};
use crate::process::{Process, ProcessState};
use crate::signal::{SignalHandler, SignalState};
use crate::socket::SocketTable;
use crate::terminal::{TerminalState, WinSize, NCCS};

const FORK_MAGIC: u32 = 0x464F524B; // "FORK"
const FORK_VERSION: u32 = 1;

// ── Writer helper ───────────────────────────────────────────────────────────

struct Writer<'a> {
    buf: &'a mut [u8],
    pos: usize,
}

impl<'a> Writer<'a> {
    fn new(buf: &'a mut [u8]) -> Self {
        Writer { buf, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    fn write_u16(&mut self, v: u16) -> Result<(), Errno> {
        if self.remaining() < 2 {
            return Err(Errno::ENOMEM);
        }
        self.buf[self.pos..self.pos + 2].copy_from_slice(&v.to_le_bytes());
        self.pos += 2;
        Ok(())
    }

    fn write_u32(&mut self, v: u32) -> Result<(), Errno> {
        if self.remaining() < 4 {
            return Err(Errno::ENOMEM);
        }
        self.buf[self.pos..self.pos + 4].copy_from_slice(&v.to_le_bytes());
        self.pos += 4;
        Ok(())
    }

    fn write_u64(&mut self, v: u64) -> Result<(), Errno> {
        if self.remaining() < 8 {
            return Err(Errno::ENOMEM);
        }
        self.buf[self.pos..self.pos + 8].copy_from_slice(&v.to_le_bytes());
        self.pos += 8;
        Ok(())
    }

    fn write_i64(&mut self, v: i64) -> Result<(), Errno> {
        if self.remaining() < 8 {
            return Err(Errno::ENOMEM);
        }
        self.buf[self.pos..self.pos + 8].copy_from_slice(&v.to_le_bytes());
        self.pos += 8;
        Ok(())
    }

    fn write_bytes(&mut self, data: &[u8]) -> Result<(), Errno> {
        if self.remaining() < data.len() {
            return Err(Errno::ENOMEM);
        }
        self.buf[self.pos..self.pos + data.len()].copy_from_slice(data);
        self.pos += data.len();
        Ok(())
    }

    /// Patch a u32 value at a previously written offset.
    fn patch_u32(&mut self, offset: usize, v: u32) {
        self.buf[offset..offset + 4].copy_from_slice(&v.to_le_bytes());
    }
}

// ── Reader helper ───────────────────────────────────────────────────────────

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    fn read_u16(&mut self) -> Result<u16, Errno> {
        if self.remaining() < 2 {
            return Err(Errno::EINVAL);
        }
        let v = u16::from_le_bytes([self.buf[self.pos], self.buf[self.pos + 1]]);
        self.pos += 2;
        Ok(v)
    }

    fn read_u32(&mut self) -> Result<u32, Errno> {
        if self.remaining() < 4 {
            return Err(Errno::EINVAL);
        }
        let v = u32::from_le_bytes([
            self.buf[self.pos],
            self.buf[self.pos + 1],
            self.buf[self.pos + 2],
            self.buf[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(v)
    }

    fn read_u64(&mut self) -> Result<u64, Errno> {
        if self.remaining() < 8 {
            return Err(Errno::EINVAL);
        }
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&self.buf[self.pos..self.pos + 8]);
        self.pos += 8;
        Ok(u64::from_le_bytes(bytes))
    }

    fn read_i64(&mut self) -> Result<i64, Errno> {
        if self.remaining() < 8 {
            return Err(Errno::EINVAL);
        }
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&self.buf[self.pos..self.pos + 8]);
        self.pos += 8;
        Ok(i64::from_le_bytes(bytes))
    }

    fn read_bytes(&mut self, len: usize) -> Result<&'a [u8], Errno> {
        if self.remaining() < len {
            return Err(Errno::EINVAL);
        }
        let data = &self.buf[self.pos..self.pos + len];
        self.pos += len;
        Ok(data)
    }
}

// ── FileType encoding ───────────────────────────────────────────────────────

fn file_type_to_u32(ft: FileType) -> u32 {
    match ft {
        FileType::Regular => 0,
        FileType::Directory => 1,
        FileType::Pipe => 2,
        FileType::CharDevice => 3,
        FileType::Socket => 4,
    }
}

fn u32_to_file_type(v: u32) -> Result<FileType, Errno> {
    match v {
        0 => Ok(FileType::Regular),
        1 => Ok(FileType::Directory),
        2 => Ok(FileType::Pipe),
        3 => Ok(FileType::CharDevice),
        4 => Ok(FileType::Socket),
        _ => Err(Errno::EINVAL),
    }
}

// ── SignalHandler encoding ──────────────────────────────────────────────────

fn handler_to_u32(h: SignalHandler) -> u32 {
    match h {
        SignalHandler::Default => 0,
        SignalHandler::Ignore => 1,
        SignalHandler::Handler(ptr) => 2 + ptr,
    }
}

fn u32_to_handler(v: u32) -> SignalHandler {
    match v {
        0 => SignalHandler::Default,
        1 => SignalHandler::Ignore,
        n => SignalHandler::Handler(n - 2),
    }
}

// ── Serialize ───────────────────────────────────────────────────────────────

/// Serialize the process state into a binary buffer for fork.
///
/// Returns the number of bytes written on success, or `Errno::ENOMEM` if
/// the buffer is too small.
pub fn serialize_fork_state(proc: &Process, buf: &mut [u8]) -> Result<usize, Errno> {
    let mut w = Writer::new(buf);

    // ── Header (12 bytes) ──
    w.write_u32(FORK_MAGIC)?;
    w.write_u32(FORK_VERSION)?;
    let total_size_offset = w.pos;
    w.write_u32(0)?; // placeholder for total_size

    // ── Scalars (32 bytes) ──
    // Write the parent's pid as the child's ppid (child's parent is this process)
    w.write_u32(proc.pid)?;
    w.write_u32(proc.uid)?;
    w.write_u32(proc.gid)?;
    w.write_u32(proc.euid)?;
    w.write_u32(proc.egid)?;
    w.write_u32(proc.pgid)?;
    w.write_u32(proc.sid)?;
    w.write_u32(proc.umask)?;

    // ── Signal state ──
    w.write_u64(proc.signals.blocked)?;

    // Count non-default handlers
    let handlers = proc.signals.handlers();
    let non_default_count = handlers.iter().enumerate().filter(|(i, h)| {
        *i > 0 && **h != SignalHandler::Default
    }).count() as u32;
    w.write_u32(non_default_count)?;

    for (i, h) in handlers.iter().enumerate() {
        if i > 0 && *h != SignalHandler::Default {
            w.write_u32(i as u32)?;
            w.write_u32(handler_to_u32(*h))?;
        }
    }

    // ── FD table ──
    w.write_u32(proc.fd_table.max_fds() as u32)?;
    let fd_entries: Vec<(i32, &FdEntry)> = proc.fd_table.iter().collect();
    w.write_u32(fd_entries.len() as u32)?;
    for (fd_num, entry) in &fd_entries {
        w.write_u32(*fd_num as u32)?;
        w.write_u32(entry.ofd_ref.0 as u32)?;
        w.write_u32(entry.fd_flags)?;
    }

    // ── OFD table ──
    let ofd_entries: Vec<(usize, &OpenFileDesc)> = proc.ofd_table.iter().collect();
    w.write_u32(ofd_entries.len() as u32)?;
    for (index, ofd) in &ofd_entries {
        w.write_u32(*index as u32)?;
        w.write_u32(file_type_to_u32(ofd.file_type))?;
        w.write_u32(ofd.status_flags)?;
        w.write_i64(ofd.host_handle)?;
        w.write_i64(ofd.offset)?;
        w.write_u32(ofd.ref_count)?;
    }

    // ── Environment ──
    w.write_u32(proc.environ.len() as u32)?;
    for var in &proc.environ {
        w.write_u32(var.len() as u32)?;
        w.write_bytes(var)?;
    }

    // ── CWD ──
    w.write_u32(proc.cwd.len() as u32)?;
    w.write_bytes(&proc.cwd)?;

    // ── Rlimits (256 bytes) ──
    for pair in &proc.rlimits {
        w.write_u64(pair[0])?;
        w.write_u64(pair[1])?;
    }

    // ── Terminal (56 bytes) ──
    w.write_u32(proc.terminal.c_iflag)?;
    w.write_u32(proc.terminal.c_oflag)?;
    w.write_u32(proc.terminal.c_cflag)?;
    w.write_u32(proc.terminal.c_lflag)?;
    w.write_bytes(&proc.terminal.c_cc)?;
    w.write_u16(proc.terminal.winsize.ws_row)?;
    w.write_u16(proc.terminal.winsize.ws_col)?;
    w.write_u16(proc.terminal.winsize.ws_xpixel)?;
    w.write_u16(proc.terminal.winsize.ws_ypixel)?;

    // ── Patch total_size ──
    let total = w.pos as u32;
    w.patch_u32(total_size_offset, total);

    Ok(w.pos)
}

// ── Deserialize ─────────────────────────────────────────────────────────────

/// Deserialize process state from a fork buffer, creating a new child process.
///
/// The child process gets:
/// - `pid = child_pid`
/// - `state = ProcessState::Running`
/// - `exit_status = 0`
/// - Empty lock table, pipes, sockets, dir_streams, memory (per POSIX)
/// - `signals.pending = 0` (via `SignalState::from_parts`)
pub fn deserialize_fork_state(buf: &[u8], child_pid: u32) -> Result<Process, Errno> {
    let mut r = Reader::new(buf);

    // ── Header ──
    let magic = r.read_u32()?;
    if magic != FORK_MAGIC {
        return Err(Errno::EINVAL);
    }
    let version = r.read_u32()?;
    if version != FORK_VERSION {
        return Err(Errno::EINVAL);
    }
    let _total_size = r.read_u32()?;

    // ── Scalars ──
    let ppid = r.read_u32()?;
    let uid = r.read_u32()?;
    let gid = r.read_u32()?;
    let euid = r.read_u32()?;
    let egid = r.read_u32()?;
    let pgid = r.read_u32()?;
    let sid = r.read_u32()?;
    let umask = r.read_u32()?;

    // ── Signal state ──
    let blocked = r.read_u64()?;
    let handler_count = r.read_u32()?;
    let mut handlers = [SignalHandler::Default; 64];
    for _ in 0..handler_count {
        let signum = r.read_u32()?;
        let handler_val = r.read_u32()?;
        if (signum as usize) < 64 {
            handlers[signum as usize] = u32_to_handler(handler_val);
        }
    }
    let signals = SignalState::from_parts(handlers, blocked);

    // ── FD table ──
    let max_fds = r.read_u32()? as usize;
    let fd_count = r.read_u32()?;
    let mut fd_entries: Vec<Option<FdEntry>> = Vec::new();
    for _ in 0..fd_count {
        let fd_num = r.read_u32()? as usize;
        let ofd_index = r.read_u32()? as usize;
        let fd_flags = r.read_u32()?;
        while fd_entries.len() <= fd_num {
            fd_entries.push(None);
        }
        fd_entries[fd_num] = Some(FdEntry {
            ofd_ref: OpenFileDescRef(ofd_index),
            fd_flags,
        });
    }
    let fd_table = FdTable::from_raw(fd_entries, max_fds);

    // ── OFD table ──
    let ofd_count = r.read_u32()?;
    let mut ofd_entries: Vec<Option<OpenFileDesc>> = Vec::new();
    for _ in 0..ofd_count {
        let index = r.read_u32()? as usize;
        let file_type = u32_to_file_type(r.read_u32()?)?;
        let status_flags = r.read_u32()?;
        let host_handle = r.read_i64()?;
        let offset = r.read_i64()?;
        let ref_count = r.read_u32()?;
        while ofd_entries.len() <= index {
            ofd_entries.push(None);
        }
        ofd_entries[index] = Some(OpenFileDesc {
            file_type,
            status_flags,
            host_handle,
            offset,
            ref_count,
            owner_pid: child_pid,
        });
    }
    let ofd_table = OfdTable::from_raw(ofd_entries);

    // ── Environment ──
    let env_count = r.read_u32()?;
    let mut environ = Vec::with_capacity(env_count as usize);
    for _ in 0..env_count {
        let len = r.read_u32()? as usize;
        let data = r.read_bytes(len)?;
        environ.push(data.to_vec());
    }

    // ── CWD ──
    let cwd_len = r.read_u32()? as usize;
    let cwd_data = r.read_bytes(cwd_len)?;
    let cwd = cwd_data.to_vec();

    // ── Rlimits ──
    let mut rlimits = [[0u64; 2]; 16];
    for pair in rlimits.iter_mut() {
        pair[0] = r.read_u64()?;
        pair[1] = r.read_u64()?;
    }

    // ── Terminal ──
    let c_iflag = r.read_u32()?;
    let c_oflag = r.read_u32()?;
    let c_cflag = r.read_u32()?;
    let c_lflag = r.read_u32()?;
    let c_cc_data = r.read_bytes(NCCS)?;
    let mut c_cc = [0u8; NCCS];
    c_cc.copy_from_slice(c_cc_data);
    let ws_row = r.read_u16()?;
    let ws_col = r.read_u16()?;
    let ws_xpixel = r.read_u16()?;
    let ws_ypixel = r.read_u16()?;

    let terminal = TerminalState {
        c_iflag,
        c_oflag,
        c_cflag,
        c_lflag,
        c_cc,
        winsize: WinSize {
            ws_row,
            ws_col,
            ws_xpixel,
            ws_ypixel,
        },
    };

    Ok(Process {
        pid: child_pid,
        ppid,
        uid,
        gid,
        euid,
        egid,
        pgid,
        sid,
        state: ProcessState::Running,
        exit_status: 0,
        fd_table,
        ofd_table,
        lock_table: LockTable::new(),
        pipes: Vec::new(),
        sockets: SocketTable::new(),
        cwd,
        dir_streams: Vec::new(),
        signals,
        memory: MemoryManager::new(),
        terminal,
        environ,
        umask,
        rlimits,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::Process;
    use crate::signal::SignalHandler;

    #[test]
    fn test_roundtrip_default_process() {
        let proc = Process::new(1);
        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        assert!(written > 12);
        assert_eq!(&buf[0..4], &0x464F524Bu32.to_le_bytes());

        let child = deserialize_fork_state(&buf[..written], 42).unwrap();
        assert_eq!(child.pid, 42);
        assert_eq!(child.ppid, proc.pid); // child's ppid is parent's pid
        assert_eq!(child.uid, proc.uid);
        assert_eq!(child.gid, proc.gid);
        assert_eq!(child.umask, proc.umask);
        assert_eq!(child.cwd, proc.cwd);
        assert_eq!(child.signals.pending, 0);
    }

    #[test]
    fn test_roundtrip_with_environment() {
        let mut proc = Process::new(1);
        proc.environ.push(b"HOME=/home/test".to_vec());
        proc.environ.push(b"PATH=/usr/bin".to_vec());

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 2).unwrap();

        assert_eq!(child.environ.len(), 2);
        assert_eq!(child.environ[0], b"HOME=/home/test");
        assert_eq!(child.environ[1], b"PATH=/usr/bin");
    }

    #[test]
    fn test_roundtrip_with_fds() {
        let proc = Process::new(1);
        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 3).unwrap();

        assert!(child.fd_table.get(0).is_ok());
        assert!(child.fd_table.get(1).is_ok());
        assert!(child.fd_table.get(2).is_ok());
        assert!(child.fd_table.get(3).is_err());
    }

    #[test]
    fn test_roundtrip_with_custom_cwd() {
        let mut proc = Process::new(1);
        proc.cwd = b"/home/user/project".to_vec();

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 4).unwrap();
        assert_eq!(child.cwd, b"/home/user/project");
    }

    #[test]
    fn test_roundtrip_signal_handlers() {
        let mut proc = Process::new(1);
        proc.signals.set_handler(2, SignalHandler::Ignore).unwrap();
        proc.signals.set_handler(15, SignalHandler::Handler(42)).unwrap();
        proc.signals.blocked = 0x0000_0004;

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 5).unwrap();

        assert_eq!(child.signals.get_handler(2), SignalHandler::Ignore);
        assert_eq!(child.signals.get_handler(15), SignalHandler::Handler(42));
        assert_eq!(child.signals.blocked, 0x0000_0004);
        assert_eq!(child.signals.pending, 0);
    }

    #[test]
    fn test_roundtrip_rlimits() {
        let mut proc = Process::new(1);
        proc.rlimits[7] = [512, 1024];

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 6).unwrap();

        assert_eq!(child.rlimits[7], [512, 1024]);
    }

    #[test]
    fn test_buffer_too_small() {
        let proc = Process::new(1);
        let mut buf = vec![0u8; 8];
        let result = serialize_fork_state(&proc, &mut buf);
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_magic() {
        let buf = [0u8; 64];
        let result = deserialize_fork_state(&buf, 1);
        assert!(result.is_err());
    }
}
