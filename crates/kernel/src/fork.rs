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
//! - Program break (4 bytes): current brk value

extern crate alloc;

use alloc::collections::BTreeSet;
use alloc::vec::Vec;
use wasm_posix_shared::fd_flags::FD_CLOEXEC;
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
const EXEC_MAGIC: u32 = 0x45584543; // "EXEC"
const FORK_VERSION: u32 = 3;

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
        FileType::EventFd => 5,
        FileType::Epoll => 6,
        FileType::TimerFd => 7,
        FileType::SignalFd => 8,
    }
}

fn u32_to_file_type(v: u32) -> Result<FileType, Errno> {
    match v {
        0 => Ok(FileType::Regular),
        1 => Ok(FileType::Directory),
        2 => Ok(FileType::Pipe),
        3 => Ok(FileType::CharDevice),
        4 => Ok(FileType::Socket),
        5 => Ok(FileType::EventFd),
        6 => Ok(FileType::Epoll),
        7 => Ok(FileType::TimerFd),
        8 => Ok(FileType::SignalFd),
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
        w.write_u32(ofd.path.len() as u32)?;
        w.write_bytes(&ofd.path)?;
    }

    // ── Environment ──
    w.write_u32(proc.environ.len() as u32)?;
    for var in &proc.environ {
        w.write_u32(var.len() as u32)?;
        w.write_bytes(var)?;
    }

    // ── Argv ──
    w.write_u32(proc.argv.len() as u32)?;
    for arg in &proc.argv {
        w.write_u32(arg.len() as u32)?;
        w.write_bytes(arg)?;
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

    // ── Program break ──
    w.write_u32(proc.memory.get_brk())?;

    // ── Fork exec state (v3) ──
    // exec_path: u32 len then bytes (0 = none)
    match &proc.fork_exec_path {
        Some(path) => {
            w.write_u32(path.len() as u32)?;
            w.write_bytes(path)?;
        }
        None => w.write_u32(0)?,
    }
    // exec_argv: u32 count then each (u32 len, bytes)
    match &proc.fork_exec_argv {
        Some(argv) => {
            w.write_u32(argv.len() as u32)?;
            for arg in argv {
                w.write_u32(arg.len() as u32)?;
                w.write_bytes(arg)?;
            }
        }
        None => w.write_u32(0)?,
    }
    // fd_actions: u32 count then each (u32 type, u32 fd1, u32 fd2)
    w.write_u32(proc.fork_fd_actions.len() as u32)?;
    for action in &proc.fork_fd_actions {
        use crate::process::FdAction;
        match action {
            FdAction::Dup2 { old_fd, new_fd } => {
                w.write_u32(0)?;
                w.write_u32(*old_fd as u32)?;
                w.write_u32(*new_fd as u32)?;
            }
            FdAction::Close { fd } => {
                w.write_u32(1)?;
                w.write_u32(*fd as u32)?;
                w.write_u32(0)?;
            }
            FdAction::Open { fd, .. } => {
                w.write_u32(2)?;
                w.write_u32(*fd as u32)?;
                w.write_u32(0)?;
            }
        }
    }

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
        let path_len = r.read_u32()? as usize;
        let path = r.read_bytes(path_len)?.to_vec();
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
            path,
            dir_host_handle: -1,
            dir_synth_state: 0,
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

    // ── Argv ──
    let argv_count = r.read_u32()?;
    let mut argv = Vec::with_capacity(argv_count as usize);
    for _ in 0..argv_count {
        let len = r.read_u32()? as usize;
        let data = r.read_bytes(len)?;
        argv.push(data.to_vec());
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
        foreground_pgid: 1,
        line_buffer: Vec::new(),
        cooked_buffer: Vec::new(),
    };

    // ── Program break ──
    let program_break = r.read_u32()?;
    let mut memory = MemoryManager::new();
    memory.set_brk(program_break);

    // ── Fork exec state (v3) ──
    let fork_exec_path = if r.remaining() >= 4 {
        let path_len = r.read_u32()? as usize;
        if path_len > 0 {
            Some(r.read_bytes(path_len)?.to_vec())
        } else {
            None
        }
    } else {
        None
    };
    let fork_exec_argv = if r.remaining() >= 4 {
        let argc = r.read_u32()? as usize;
        if argc > 0 {
            let mut args = Vec::with_capacity(argc);
            for _ in 0..argc {
                let len = r.read_u32()? as usize;
                args.push(r.read_bytes(len)?.to_vec());
            }
            Some(args)
        } else {
            None
        }
    } else {
        None
    };
    let mut fork_fd_actions = Vec::new();
    if r.remaining() >= 4 {
        let action_count = r.read_u32()? as usize;
        for _ in 0..action_count {
            let action_type = r.read_u32()?;
            let fd1 = r.read_u32()? as i32;
            let fd2 = r.read_u32()? as i32;
            use crate::process::FdAction;
            match action_type {
                0 => fork_fd_actions.push(FdAction::Dup2 { old_fd: fd1, new_fd: fd2 }),
                1 => fork_fd_actions.push(FdAction::Close { fd: fd1 }),
                _ => {} // skip unknown actions
            }
        }
    }

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
        memory,
        terminal,
        environ,
        argv,
        umask,
        rlimits,
        alarm_deadline_ns: 0,
        alarm_interval_ns: 0,
        thread_name: [0u8; 16],
        fork_child: true,
        fork_exec_path,
        fork_exec_argv,
        fork_fd_actions,
        next_ephemeral_port: 49152,
        threads: Vec::new(),  // POSIX: child has single thread
        next_tid: 0,
        eventfds: Vec::new(),
        epolls: Vec::new(),
        timerfds: Vec::new(),
        signalfds: Vec::new(),
        alt_stack_sp: 0,
        alt_stack_flags: 2, // SS_DISABLE
        alt_stack_size: 0,
    })
}

// ── Exec Serialize ──────────────────────────────────────────────────────────

/// Serialize the process state into a binary buffer for exec.
///
/// Differs from fork serialization:
/// - Magic: EXEC_MAGIC (0x45584543)
/// - ppid: preserves proc.ppid (fork writes proc.pid as child's ppid)
/// - Signal handlers: only SIG_IGN preserved; caught Handler signals reset to Default
/// - Pending signals: preserved (fork clears to 0)
/// - FD table: FDs with FD_CLOEXEC are excluded
/// - OFD table: only OFDs still referenced by remaining FDs after CLOEXEC filtering
pub fn serialize_exec_state(proc: &Process, buf: &mut [u8]) -> Result<usize, Errno> {
    let mut w = Writer::new(buf);

    // ── Header (12 bytes) ──
    w.write_u32(EXEC_MAGIC)?;
    w.write_u32(FORK_VERSION)?;
    let total_size_offset = w.pos;
    w.write_u32(0)?; // placeholder for total_size

    // ── Scalars (32 bytes) ──
    // Preserve the process's own ppid (exec replaces the image, not the process)
    w.write_u32(proc.ppid)?;
    w.write_u32(proc.uid)?;
    w.write_u32(proc.gid)?;
    w.write_u32(proc.euid)?;
    w.write_u32(proc.egid)?;
    w.write_u32(proc.pgid)?;
    w.write_u32(proc.sid)?;
    w.write_u32(proc.umask)?;

    // ── Signal state ──
    w.write_u64(proc.signals.blocked)?;

    // Only preserve SIG_IGN handlers; caught (Handler) signals reset to Default (POSIX)
    let handlers = proc.signals.handlers();
    let ignore_count = handlers.iter().enumerate().filter(|(i, h)| {
        *i > 0 && **h == SignalHandler::Ignore
    }).count() as u32;
    w.write_u32(ignore_count)?;

    for (i, h) in handlers.iter().enumerate() {
        if i > 0 && *h == SignalHandler::Ignore {
            w.write_u32(i as u32)?;
            w.write_u32(handler_to_u32(*h))?;
        }
    }

    // Pending signals preserved for exec (unlike fork which clears them)
    w.write_u64(proc.signals.pending)?;

    // ── FD table (filter out CLOEXEC fds) ──
    let fd_entries: Vec<(i32, &FdEntry)> = proc.fd_table.iter()
        .filter(|(_, entry)| entry.fd_flags & FD_CLOEXEC == 0)
        .collect();

    // Collect referenced OFD indices from the filtered FDs
    let referenced_ofds: BTreeSet<usize> = fd_entries.iter()
        .map(|(_, entry)| entry.ofd_ref.0)
        .collect();

    w.write_u32(proc.fd_table.max_fds() as u32)?;
    w.write_u32(fd_entries.len() as u32)?;
    for (fd_num, entry) in &fd_entries {
        w.write_u32(*fd_num as u32)?;
        w.write_u32(entry.ofd_ref.0 as u32)?;
        w.write_u32(entry.fd_flags)?;
    }

    // ── OFD table (only OFDs referenced by remaining FDs) ──
    let ofd_entries: Vec<(usize, &OpenFileDesc)> = proc.ofd_table.iter()
        .filter(|(index, _)| referenced_ofds.contains(index))
        .collect();
    w.write_u32(ofd_entries.len() as u32)?;
    for (index, ofd) in &ofd_entries {
        w.write_u32(*index as u32)?;
        w.write_u32(file_type_to_u32(ofd.file_type))?;
        w.write_u32(ofd.status_flags)?;
        w.write_i64(ofd.host_handle)?;
        w.write_i64(ofd.offset)?;
        w.write_u32(ofd.ref_count)?;
        w.write_u32(ofd.path.len() as u32)?;
        w.write_bytes(&ofd.path)?;
    }

    // ── Environment ──
    w.write_u32(proc.environ.len() as u32)?;
    for var in &proc.environ {
        w.write_u32(var.len() as u32)?;
        w.write_bytes(var)?;
    }

    // ── Argv ──
    w.write_u32(proc.argv.len() as u32)?;
    for arg in &proc.argv {
        w.write_u32(arg.len() as u32)?;
        w.write_bytes(arg)?;
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

    // ── Program break ──
    w.write_u32(proc.memory.get_brk())?;

    // ── Patch total_size ──
    let total = w.pos as u32;
    w.patch_u32(total_size_offset, total);

    Ok(w.pos)
}

// ── Exec Deserialize ────────────────────────────────────────────────────────

/// Deserialize process state from an exec buffer.
///
/// Differs from fork deserialization:
/// - Checks EXEC_MAGIC instead of FORK_MAGIC
/// - Reads pending signals (u64) after handler entries
/// - Uses `SignalState::from_parts_with_pending` to preserve pending signals
pub fn deserialize_exec_state(buf: &[u8], pid: u32) -> Result<Process, Errno> {
    let mut r = Reader::new(buf);

    // ── Header ──
    let magic = r.read_u32()?;
    if magic != EXEC_MAGIC {
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
    // Read pending signals (exec preserves them, unlike fork)
    let pending = r.read_u64()?;
    let signals = SignalState::from_parts_with_pending(handlers, blocked, pending);

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
        let path_len = r.read_u32()? as usize;
        let path = r.read_bytes(path_len)?.to_vec();
        while ofd_entries.len() <= index {
            ofd_entries.push(None);
        }
        ofd_entries[index] = Some(OpenFileDesc {
            file_type,
            status_flags,
            host_handle,
            offset,
            ref_count,
            owner_pid: pid,
            path,
            dir_host_handle: -1,
            dir_synth_state: 0,
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

    // ── Argv ──
    let argv_count = r.read_u32()?;
    let mut argv = Vec::with_capacity(argv_count as usize);
    for _ in 0..argv_count {
        let len = r.read_u32()? as usize;
        let data = r.read_bytes(len)?;
        argv.push(data.to_vec());
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
        foreground_pgid: 1,
        line_buffer: Vec::new(),
        cooked_buffer: Vec::new(),
    };

    // ── Program break ──
    let program_break = r.read_u32()?;
    let mut memory = MemoryManager::new();
    memory.set_brk(program_break);

    Ok(Process {
        pid,
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
        memory,
        terminal,
        environ,
        argv,
        umask,
        rlimits,
        alarm_deadline_ns: 0,
        alarm_interval_ns: 0,
        thread_name: [0u8; 16],
        fork_child: false,
        fork_exec_path: None,
        fork_exec_argv: None,
        fork_fd_actions: Vec::new(),
        next_ephemeral_port: 49152,
        threads: Vec::new(),  // exec resets to single thread
        next_tid: 0,
        eventfds: Vec::new(),
        epolls: Vec::new(),
        timerfds: Vec::new(),
        signalfds: Vec::new(),
        alt_stack_sp: 0,
        alt_stack_flags: 2, // SS_DISABLE
        alt_stack_size: 0,
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
    fn test_fork_exec_params_roundtrip() {
        use crate::process::FdAction;
        let mut proc = Process::new(1);
        proc.fork_exec_path = Some(b"/usr/bin/echo".to_vec());
        proc.fork_exec_argv = Some(vec![
            b"echo".to_vec(),
            b"hello".to_vec(),
            b"world".to_vec(),
        ]);
        proc.fork_fd_actions = vec![
            FdAction::Close { fd: 3 },
            FdAction::Dup2 { old_fd: 4, new_fd: 1 },
            FdAction::Close { fd: 4 },
        ];

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 42).unwrap();

        assert!(child.fork_child);
        assert_eq!(child.fork_exec_path.as_deref(), Some(b"/usr/bin/echo".as_slice()));
        let argv = child.fork_exec_argv.unwrap();
        assert_eq!(argv.len(), 3);
        assert_eq!(argv[0], b"echo");
        assert_eq!(argv[1], b"hello");
        assert_eq!(argv[2], b"world");
        assert_eq!(child.fork_fd_actions.len(), 3);
        match &child.fork_fd_actions[0] {
            FdAction::Close { fd } => assert_eq!(*fd, 3),
            _ => panic!("expected Close"),
        }
        match &child.fork_fd_actions[1] {
            FdAction::Dup2 { old_fd, new_fd } => {
                assert_eq!(*old_fd, 4);
                assert_eq!(*new_fd, 1);
            }
            _ => panic!("expected Dup2"),
        }
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

    // ── Exec tests ──────────────────────────────────────────────────────────

    #[test]
    fn test_exec_roundtrip_default_process() {
        let proc = Process::new(1);
        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_exec_state(&proc, &mut buf).unwrap();
        assert!(written > 12);
        assert_eq!(&buf[0..4], &0x45584543u32.to_le_bytes()); // EXEC magic

        let restored = deserialize_exec_state(&buf[..written], 1).unwrap();
        assert_eq!(restored.pid, 1);
        assert_eq!(restored.ppid, 0); // default ppid
        assert_eq!(restored.signals.pending, 0);
    }

    #[test]
    fn test_exec_state_filters_cloexec_fds() {
        use wasm_posix_shared::fd_flags::FD_CLOEXEC;
        let mut proc = Process::new(1);
        // fd 3 with CLOEXEC
        let ofd_ref = proc.ofd_table.create(crate::ofd::FileType::Regular, 0, 100, b"/test/cloexec".to_vec());
        proc.fd_table.alloc(crate::fd::OpenFileDescRef(ofd_ref), FD_CLOEXEC).unwrap();

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_exec_state(&proc, &mut buf).unwrap();
        let restored = deserialize_exec_state(&buf[..written], 1).unwrap();
        // fd 3 should be gone (CLOEXEC)
        assert!(restored.fd_table.get(3).is_err());
        // fds 0,1,2 should still exist
        assert!(restored.fd_table.get(0).is_ok());
    }

    #[test]
    fn test_exec_state_resets_caught_handler_preserves_ignore() {
        let mut proc = Process::new(1);
        proc.signals.set_handler(2, SignalHandler::Ignore).unwrap(); // SIGINT -> IGN
        proc.signals.set_handler(15, SignalHandler::Handler(42)).unwrap(); // SIGTERM -> caught

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_exec_state(&proc, &mut buf).unwrap();
        let restored = deserialize_exec_state(&buf[..written], 1).unwrap();

        assert_eq!(restored.signals.get_handler(2), SignalHandler::Ignore); // preserved
        assert_eq!(restored.signals.get_handler(15), SignalHandler::Default); // reset
    }

    #[test]
    fn test_exec_state_preserves_pending_signals() {
        let mut proc = Process::new(1);
        proc.signals.raise(2); // SIGINT pending
        proc.signals.raise(15); // SIGTERM pending

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_exec_state(&proc, &mut buf).unwrap();
        let restored = deserialize_exec_state(&buf[..written], 1).unwrap();

        assert!(restored.signals.is_pending(2));
        assert!(restored.signals.is_pending(15));
    }

    #[test]
    fn test_exec_preserves_ppid() {
        let mut proc = Process::new(5);
        proc.ppid = 3;

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_exec_state(&proc, &mut buf).unwrap();
        let restored = deserialize_exec_state(&buf[..written], 5).unwrap();

        assert_eq!(restored.ppid, 3); // ppid preserved
    }

    #[test]
    fn test_fork_inherits_program_break() {
        let mut proc = Process::new(1);
        proc.memory.set_brk(0x02000000); // move brk past default

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 42).unwrap();

        assert_eq!(child.memory.get_brk(), 0x02000000);
    }

    #[test]
    fn test_exec_inherits_program_break() {
        let mut proc = Process::new(1);
        proc.memory.set_brk(0x02000000);

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_exec_state(&proc, &mut buf).unwrap();
        let child = deserialize_exec_state(&buf[..written], 1).unwrap();

        assert_eq!(child.memory.get_brk(), 0x02000000);
    }

    #[test]
    fn test_fork_does_not_inherit_threads() {
        use crate::process::ThreadInfo;
        let mut proc = Process::new(1);
        // Parent has 2 threads
        let t1 = proc.alloc_tid();
        let t2 = proc.alloc_tid();
        proc.add_thread(ThreadInfo::new(t1, 0, 0x1000, 0));
        proc.add_thread(ThreadInfo::new(t2, 0, 0x2000, 0));
        assert_eq!(proc.threads.len(), 2);

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_fork_state(&proc, &mut buf).unwrap();
        let child = deserialize_fork_state(&buf[..written], 42).unwrap();

        // POSIX: child has a single thread (the calling thread)
        assert_eq!(child.threads.len(), 0);
        assert_eq!(child.next_tid, 0);
    }

    #[test]
    fn test_exec_resets_threads() {
        use crate::process::ThreadInfo;
        let mut proc = Process::new(1);
        let t1 = proc.alloc_tid();
        proc.add_thread(ThreadInfo::new(t1, 0, 0x1000, 0));

        let mut buf = vec![0u8; 64 * 1024];
        let written = serialize_exec_state(&proc, &mut buf).unwrap();
        let child = deserialize_exec_state(&buf[..written], 1).unwrap();

        assert_eq!(child.threads.len(), 0);
        assert_eq!(child.next_tid, 0);
    }
}
