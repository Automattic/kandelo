//! Section lengths are known only after encoding. Enforce the disk limit at
//! each write rather than discovering an oversized section after filling it.
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
};

pub(super) struct Spool {
    file: File,
    position: u64,
    limit: u64,
}
impl Spool {
    pub fn new(limit: u64) -> io::Result<Self> {
        Ok(Self {
            file: tempfile::tempfile()?,
            position: 0,
            limit: limit.min(u64::from(u32::MAX)),
        })
    }
}
impl Write for Spool {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.position
            .checked_add(bytes.len() as u64)
            .filter(|end| *end <= self.limit)
            .ok_or_else(|| io::Error::other("streaming section spool exceeds disk budget"))?;
        let written = self.file.write(bytes)?;
        self.position += written as u64;
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}
impl Read for Spool {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let read = self.file.read(bytes)?;
        self.position += read as u64;
        Ok(read)
    }
}
impl Seek for Spool {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        self.position = self.file.seek(from)?;
        Ok(self.position)
    }
    fn stream_position(&mut self) -> io::Result<u64> {
        Ok(self.position)
    }
}
