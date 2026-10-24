//! Bounded private file artifacts. Only immutable mapped bytes cross phases;
//! source and optimizer paths are copied before they are inspected or emitted.
use anyhow::{Context, Result, ensure};
use memmap2::{Mmap, MmapOptions};
use std::{
    fs::{File, Permissions},
    io::{Read, Write},
    path::Path,
};

mod sections;
pub(crate) use sections::copy_without_custom;

pub struct MappedArtifact {
    mapping: Option<Mmap>,
}
impl MappedArtifact {
    pub fn bytes(&self) -> &[u8] {
        self.mapping.as_deref().unwrap_or_default()
    }

    /// Capture at most `limit` bytes using a fixed copy buffer. The original
    /// file may change, but every later phase sees the same captured bytes.
    pub fn snapshot(mut source: impl Read, limit: u64) -> Result<Self> {
        let mut spool = ArtifactSpool::new(limit)?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = source.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            spool.write_all(&buffer[..count])?;
        }
        spool.freeze()
    }

    /// Capture permissions from the same opened input used for the snapshot.
    pub fn read(path: &Path, limit: u64) -> Result<(Self, Permissions)> {
        let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file(),
            "input must be a regular file: {}",
            path.display()
        );
        ensure!(
            metadata.len() <= limit,
            "input exceeds artifact byte budget"
        );
        let bytes = Self::snapshot(file, limit)
            .with_context(|| format!("snapshotting {}", path.display()))?;
        Ok((bytes, metadata.permissions()))
    }

    /// Atomically replace the destination entry on its own filesystem. No
    /// destination bytes or permissions change before the final rename.
    pub fn publish(&self, destination: &Path, permissions: Permissions) -> Result<()> {
        let parent = destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .with_context(|| format!("creating output beside {}", destination.display()))?;
        temporary.write_all(self.bytes())?;
        temporary.as_file().set_permissions(permissions)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(destination)
            .with_context(|| format!("publishing {}", destination.display()))?;
        Ok(())
    }
}

/// Append-only output, capped before each write. It exposes no file handle or
/// path, so consuming `freeze` revokes the only way to modify its backing file.
pub struct ArtifactSpool {
    file: File,
    length: u64,
    limit: u64,
}
impl ArtifactSpool {
    pub fn new(limit: u64) -> Result<Self> {
        Ok(Self {
            file: tempfile::tempfile().context("creating private artifact spool")?,
            length: 0,
            limit,
        })
    }
    pub fn freeze(self) -> Result<MappedArtifact> {
        let mapping = if self.length == 0 {
            None
        } else {
            Some(freeze(self.file, usize::try_from(self.length)?)?)
        };
        Ok(MappedArtifact { mapping })
    }
}
impl Write for ArtifactSpool {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let end = self
            .length
            .checked_add(bytes.len() as u64)
            .filter(|end| *end <= self.limit)
            .ok_or_else(|| std::io::Error::other("artifact exceeds byte budget"))?;
        let written = self.file.write(bytes)?;
        self.length += written as u64;
        debug_assert!(self.length <= end);
        Ok(written)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

#[cfg(unix)]
fn freeze(file: File, length: usize) -> Result<Mmap> {
    // SAFETY: tempfile() creates a private, unlinked file on Unix. No handle
    // or path escaped the append-only owner. All writes are complete and its
    // last file handle is closed before returning. Never map a caller's file.
    unsafe { MmapOptions::new().len(length).map(&file) }
        .context("mapping immutable private artifact")
}

#[cfg(not(unix))]
fn freeze(mut file: File, length: usize) -> Result<Mmap> {
    use std::io::{Seek, SeekFrom};
    // Other platforms do not promise an unlinked tempfile. An anonymous map
    // avoids aliasing a file another process could open and modify.
    let mut mapping = MmapOptions::new().len(length).map_anon()?;
    file.seek(SeekFrom::Start(0))?;
    file.read_exact(&mut mapping)?;
    Ok(mapping.make_read_only()?)
}
