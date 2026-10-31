use crate::process::HostIO;
use alloc::vec::Vec;
use wasm_posix_shared::{Errno, WasmStat};

pub(super) const SOURCE_HANDLE: i64 = 81_001;
pub(super) const IMAGE_HANDLE: i64 = 81_002;

pub(super) struct PairHost {
    pub closed: Vec<i64>,
    pub synced: Vec<i64>,
    pub fail_close: Option<i64>,
}

impl PairHost {
    pub fn new() -> Self {
        Self {
            closed: Vec::with_capacity(8),
            synced: Vec::with_capacity(4),
            fail_close: None,
        }
    }

    fn data(&self, handle: i64) -> &'static [u8] {
        match handle {
            SOURCE_HANDLE => b"source",
            IMAGE_HANDLE => b"derived code",
            _ => panic!("unexpected host handle {handle}"),
        }
    }
}

impl HostIO for PairHost {
    fn host_close(&mut self, handle: i64) -> Result<(), Errno> {
        assert!(!self.closed.contains(&handle));
        self.closed.push(handle);
        if self.fail_close == Some(handle) {
            Err(Errno::EIO)
        } else {
            Ok(())
        }
    }
    fn host_read(&mut self, _handle: i64, _bytes: &mut [u8]) -> Result<usize, Errno> {
        panic!("unpositioned read")
    }
    fn host_write(&mut self, _handle: i64, _bytes: &[u8]) -> Result<usize, Errno> {
        panic!("host write")
    }
    fn host_seek(&mut self, _handle: i64, _offset: i64, _whence: u32) -> Result<i64, Errno> {
        panic!("host seek")
    }
    fn host_pread(&mut self, handle: i64, bytes: &mut [u8], offset: i64) -> Result<usize, Errno> {
        assert!(!self.closed.contains(&handle));
        let data = self.data(handle);
        let start = usize::try_from(offset)
            .map_err(|_| Errno::EINVAL)?
            .min(data.len());
        let count = bytes.len().min(data.len() - start);
        bytes[..count].copy_from_slice(&data[start..start + count]);
        Ok(count)
    }
    fn host_fstat(&mut self, handle: i64) -> Result<WasmStat, Errno> {
        assert!(!self.closed.contains(&handle));
        Ok(WasmStat {
            st_dev: 99,
            st_ino: handle as u64,
            st_size: self.data(handle).len() as u64,
            st_mode: wasm_posix_shared::mode::S_IFREG
                | if handle == SOURCE_HANDLE {
                    0o750
                } else {
                    0o600
                },
            st_uid: 41,
            st_gid: 42,
            st_nlink: 1,
            st_atime_sec: 0,
            st_atime_nsec: 0,
            st_mtime_sec: 0,
            st_mtime_nsec: 0,
            st_ctime_sec: 0,
            st_ctime_nsec: 0,
            st_rdev: 0,
            _pad: 0,
        })
    }
    fn host_fsync(&mut self, handle: i64) -> Result<(), Errno> {
        self.synced.push(handle);
        Ok(())
    }
    fn host_readdir(
        &mut self,
        _handle: i64,
        _bytes: &mut [u8],
    ) -> Result<Option<(u64, u32, usize)>, Errno> {
        panic!("readdir")
    }
    fn host_clock_gettime(&mut self, _clock: u32) -> Result<(i64, i64), Errno> {
        Ok((0, 0))
    }
    fn host_ftruncate(&mut self, _handle: i64, _length: i64) -> Result<(), Errno> {
        panic!("truncate")
    }
    fn host_fchmod(&mut self, _handle: i64, _mode: u32) -> Result<(), Errno> {
        panic!("chmod")
    }
    fn host_fchown(&mut self, _handle: i64, _uid: u32, _gid: u32) -> Result<(), Errno> {
        panic!("chown")
    }
    fn host_set_alarm(&mut self, _seconds: u32) -> Result<(), Errno> {
        panic!("alarm")
    }
    fn host_set_posix_timer(
        &mut self,
        _timer: i32,
        _signal: i32,
        _value: i64,
        _interval: i64,
    ) -> Result<(), Errno> {
        panic!("timer")
    }
    fn host_getrandom(&mut self, _bytes: &mut [u8]) -> Result<usize, Errno> {
        panic!("random")
    }
    fn host_net_connect(&mut self, _handle: i32, _address: &[u8], _port: u16) -> Result<(), Errno> {
        panic!("connect")
    }
    fn host_net_connect_status(&mut self, _handle: i32) -> Result<(), Errno> {
        panic!("connect status")
    }
    fn host_net_send(&mut self, _handle: i32, _bytes: &[u8], _flags: u32) -> Result<usize, Errno> {
        panic!("send")
    }
    fn host_net_recv(
        &mut self,
        _handle: i32,
        _length: u32,
        _flags: u32,
        _bytes: &mut [u8],
    ) -> Result<usize, Errno> {
        panic!("recv")
    }
    fn host_net_close(&mut self, _handle: i32) -> Result<(), Errno> {
        panic!("network close")
    }
    fn host_net_listen(&mut self, _fd: i32, _port: u16, _address: &[u8; 4]) -> Result<(), Errno> {
        panic!("listen")
    }
    fn host_getaddrinfo(&mut self, _name: &[u8], _result: &mut [u8]) -> Result<usize, Errno> {
        panic!("resolve")
    }
    fn bind_framebuffer(
        &mut self,
        _pid: i32,
        _address: usize,
        _length: usize,
        _width: u32,
        _height: u32,
        _stride: u32,
        _format: u32,
    ) {
        panic!("bind framebuffer")
    }
    fn unbind_framebuffer(&mut self, _pid: i32) {}
    fn fb_write(&mut self, _pid: i32, _offset: usize, _bytes: &[u8]) {
        panic!("framebuffer write")
    }
}
