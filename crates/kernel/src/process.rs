extern crate alloc;

use alloc::vec::Vec;
use wasm_posix_shared::{Errno, WasmStat};

use crate::fd::FdTable;
use crate::ofd::OfdTable;
use crate::pipe::PipeBuffer;
use crate::signal::SignalState;

/// A handle to an open directory stream for readdir iteration.
pub struct DirStream {
    pub host_handle: i64,
}

/// Trait for host I/O operations that the kernel delegates to the runtime.
pub trait HostIO {
    fn host_open(&mut self, path: &[u8], flags: u32, mode: u32) -> Result<i64, Errno>;
    fn host_close(&mut self, handle: i64) -> Result<(), Errno>;
    fn host_read(&mut self, handle: i64, buf: &mut [u8]) -> Result<usize, Errno>;
    fn host_write(&mut self, handle: i64, buf: &[u8]) -> Result<usize, Errno>;
    fn host_seek(&mut self, handle: i64, offset: i64, whence: u32) -> Result<i64, Errno>;
    fn host_fstat(&mut self, handle: i64) -> Result<WasmStat, Errno>;
    fn host_stat(&mut self, path: &[u8]) -> Result<WasmStat, Errno>;
    fn host_lstat(&mut self, path: &[u8]) -> Result<WasmStat, Errno>;
    fn host_mkdir(&mut self, path: &[u8], mode: u32) -> Result<(), Errno>;
    fn host_rmdir(&mut self, path: &[u8]) -> Result<(), Errno>;
    fn host_unlink(&mut self, path: &[u8]) -> Result<(), Errno>;
    fn host_rename(&mut self, oldpath: &[u8], newpath: &[u8]) -> Result<(), Errno>;
    fn host_link(&mut self, oldpath: &[u8], newpath: &[u8]) -> Result<(), Errno>;
    fn host_symlink(&mut self, target: &[u8], linkpath: &[u8]) -> Result<(), Errno>;
    fn host_readlink(&mut self, path: &[u8], buf: &mut [u8]) -> Result<usize, Errno>;
    fn host_chmod(&mut self, path: &[u8], mode: u32) -> Result<(), Errno>;
    fn host_chown(&mut self, path: &[u8], uid: u32, gid: u32) -> Result<(), Errno>;
    fn host_access(&mut self, path: &[u8], amode: u32) -> Result<(), Errno>;
    fn host_opendir(&mut self, path: &[u8]) -> Result<i64, Errno>;
    fn host_readdir(&mut self, handle: i64, name_buf: &mut [u8]) -> Result<Option<(u64, u32, usize)>, Errno>;
    fn host_closedir(&mut self, handle: i64) -> Result<(), Errno>;
}

/// Process lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessState {
    Running,
    Exited,
}

/// Per-process kernel state: file descriptor table, OFD table, pipes, cwd, and directory streams.
pub struct Process {
    pub pid: u32,
    pub ppid: u32,
    pub uid: u32,
    pub gid: u32,
    pub euid: u32,
    pub egid: u32,
    pub state: ProcessState,
    pub exit_status: i32,
    pub fd_table: FdTable,
    pub ofd_table: OfdTable,
    pub pipes: Vec<Option<PipeBuffer>>,
    pub cwd: Vec<u8>,
    pub dir_streams: Vec<Option<DirStream>>,
    pub signals: SignalState,
}

impl Process {
    /// Create a new process with stdio pre-opened (fds 0, 1, 2).
    ///
    /// - OFD 0 = stdin  (CharDevice, O_RDONLY, host_handle=0)
    /// - OFD 1 = stdout (CharDevice, O_WRONLY, host_handle=1)
    /// - OFD 2 = stderr (CharDevice, O_WRONLY, host_handle=2)
    pub fn new(pid: u32) -> Self {
        use crate::ofd::FileType;
        use wasm_posix_shared::flags::{O_RDONLY, O_WRONLY};

        let mut ofd_table = OfdTable::new();
        ofd_table.create(FileType::CharDevice, O_RDONLY, 0); // OFD 0 = stdin
        ofd_table.create(FileType::CharDevice, O_WRONLY, 1); // OFD 1 = stdout
        ofd_table.create(FileType::CharDevice, O_WRONLY, 2); // OFD 2 = stderr

        let mut fd_table = FdTable::new();
        fd_table.preopen_stdio(); // fds 0,1,2 → OFD refs 0,1,2

        Process {
            pid,
            ppid: 0,
            uid: 1000,
            gid: 1000,
            euid: 1000,
            egid: 1000,
            state: ProcessState::Running,
            exit_status: 0,
            fd_table,
            ofd_table,
            pipes: Vec::new(),
            cwd: alloc::vec![b'/'],
            dir_streams: Vec::new(),
            signals: SignalState::new(),
        }
    }
}
