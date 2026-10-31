use super::options::Cli;
use anyhow::{Context, Result, ensure};
use fork_instrument::artifact_io::MappedArtifact;
use std::{
    fs::{File, Permissions},
    path::{Path, PathBuf},
};

pub(super) struct Inputs {
    pub artifact: MappedArtifact,
    pub permissions: Permissions,
    pub name: String,
    pub output: Option<Output>,
}

pub(super) enum Output {
    Path(PathBuf),
    #[cfg(unix)]
    Descriptor(File),
}

impl Inputs {
    pub fn open(cli: &Cli) -> Result<Self> {
        #[cfg(not(unix))]
        ensure!(
            cli.input_fd.is_none() && cli.output_fd.is_none(),
            "descriptor I/O requires a POSIX host"
        );
        #[cfg(unix)]
        for descriptor in [cli.input_fd, cli.output_fd].into_iter().flatten() {
            unix::descriptor_flags(descriptor)?;
        }
        let output = match (&cli.output, cli.output_fd) {
            (Some(path), None) => Some(Output::Path(path.clone())),
            #[cfg(unix)]
            (None, Some(descriptor)) => {
                let file = unix::borrow_copy(descriptor)?;
                unix::check_output(&file)?;
                Some(Output::Descriptor(file))
            }
            _ => None,
        };
        let (file, name) = match (&cli.input, cli.input_fd) {
            (Some(path), None) => (
                File::open(path).with_context(|| format!("opening {}", path.display()))?,
                path.display().to_string(),
            ),
            #[cfg(unix)]
            (None, Some(descriptor)) => {
                let file = unix::borrow_copy(descriptor)?;
                unix::check_input(&file)?;
                (file, format!("input descriptor {descriptor}"))
            }
            _ => anyhow::bail!("exactly one input source is required"),
        };
        let metadata = file.metadata()?;
        ensure!(metadata.is_file(), "input must be a regular file: {name}");
        ensure!(
            metadata.len() <= cli.max_input_bytes,
            "input exceeds artifact byte budget"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if let Some(Output::Descriptor(destination)) = &output {
                let target = destination.metadata()?;
                ensure!(
                    (metadata.dev(), metadata.ino()) != (target.dev(), target.ino()),
                    "input and output descriptors must not alias"
                );
            }
            for descriptor in [cli.input_fd, cli.output_fd].into_iter().flatten() {
                unix::close_on_exec(descriptor)?;
            }
        }
        #[cfg(unix)]
        let artifact = MappedArtifact::snapshot(
            unix::PositionedReader {
                file: &file,
                position: 0,
            },
            cli.max_input_bytes,
        )?;
        #[cfg(not(unix))]
        let artifact = MappedArtifact::snapshot(&file, cli.max_input_bytes)?;
        let after = file.metadata()?;
        ensure!(
            metadata.len() == after.len() && metadata.permissions() == after.permissions(),
            "input changed while snapshotting"
        );
        #[cfg(unix)]
        ensure!(
            unix::unchanged(&metadata, &after),
            "input changed while snapshotting"
        );
        ensure!(
            artifact.bytes().len() as u64 == metadata.len(),
            "input changed while snapshotting"
        );
        Ok(Self {
            artifact,
            permissions: metadata.permissions(),
            name,
            output,
        })
    }
}

impl Output {
    pub fn path(&self) -> Option<&Path> {
        match self {
            Self::Path(path) => Some(path),
            #[cfg(unix)]
            Self::Descriptor(_) => None,
        }
    }

    pub fn publish(&self, artifact: &MappedArtifact, permissions: Permissions) -> Result<()> {
        match self {
            Self::Path(path) => artifact.publish(path, permissions),
            #[cfg(unix)]
            Self::Descriptor(file) => unix::write_output(file, artifact.bytes()),
        }
    }
}

#[cfg(unix)]
mod unix {
    use anyhow::{Context, Result, ensure};
    use std::{
        fs::{File, Metadata},
        io::{self, Read},
        os::{
            fd::{AsRawFd, BorrowedFd},
            unix::fs::{FileExt, MetadataExt},
        },
    };

    fn checked_fcntl(descriptor: i32, command: i32, argument: i32) -> Result<i32> {
        let result = unsafe { libc::fcntl(descriptor, command, argument) };
        if result < 0 {
            return Err(io::Error::last_os_error())
                .with_context(|| format!("accessing descriptor {descriptor}"));
        }
        Ok(result)
    }

    pub(super) fn descriptor_flags(descriptor: i32) -> Result<i32> {
        checked_fcntl(descriptor, libc::F_GETFD, 0)
    }

    pub(super) fn borrow_copy(descriptor: i32) -> Result<File> {
        let borrowed = unsafe { BorrowedFd::borrow_raw(descriptor) };
        Ok(File::from(borrowed.try_clone_to_owned()?))
    }

    pub(super) fn close_on_exec(descriptor: i32) -> Result<()> {
        let flags = descriptor_flags(descriptor)?;
        checked_fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC)?;
        Ok(())
    }

    pub(super) fn check_input(file: &File) -> Result<()> {
        let flags = checked_fcntl(file.as_raw_fd(), libc::F_GETFL, 0)?;
        ensure!(
            flags & libc::O_ACCMODE == libc::O_RDONLY,
            "input descriptor must be readonly"
        );
        ensure!(
            file.metadata()?.is_file(),
            "input descriptor must be a regular file"
        );
        Ok(())
    }

    pub(super) fn check_output(file: &File) -> Result<()> {
        let flags = checked_fcntl(file.as_raw_fd(), libc::F_GETFL, 0)?;
        ensure!(
            flags & libc::O_ACCMODE == libc::O_WRONLY || flags & libc::O_ACCMODE == libc::O_RDWR,
            "output descriptor must be writable"
        );
        ensure!(
            flags & libc::O_APPEND == 0,
            "output descriptor must not append"
        );
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file() && metadata.nlink() == 0 && metadata.len() == 0,
            "output descriptor must be an empty, unlinked regular file"
        );
        Ok(())
    }

    pub(super) fn unchanged(before: &Metadata, after: &Metadata) -> bool {
        before.dev() == after.dev()
            && before.ino() == after.ino()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec()
            && before.uid() == after.uid()
            && before.gid() == after.gid()
    }

    pub(super) struct PositionedReader<'a> {
        pub file: &'a File,
        pub position: u64,
    }

    impl Read for PositionedReader<'_> {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            let count = self.file.read_at(bytes, self.position)?;
            self.position += count as u64;
            Ok(count)
        }
    }

    pub(super) fn write_output(file: &File, bytes: &[u8]) -> Result<()> {
        check_output(file)?;
        let before = file.metadata()?;
        let mut position = 0u64;
        for chunk in bytes.chunks(64 * 1024) {
            let mut remaining = chunk;
            while !remaining.is_empty() {
                match file.write_at(remaining, position) {
                    Ok(0) => {
                        return Err(io::Error::from(io::ErrorKind::WriteZero))
                            .context("writing private output");
                    }
                    Ok(count) => {
                        position += count as u64;
                        remaining = &remaining[count..];
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error).context("writing private output"),
                }
            }
        }
        file.sync_all()?;
        let after = file.metadata()?;
        ensure!(
            after.nlink() == 0
                && after.len() == bytes.len() as u64
                && before.permissions() == after.permissions()
                && before.uid() == after.uid()
                && before.gid() == after.gid(),
            "private output changed during publication"
        );
        Ok(())
    }
}
