use super::options::Cli;
use anyhow::{Context, Result, ensure};
use fork_instrument::artifact_io::MappedArtifact;
use std::fs::{File, Permissions};

/// Ordinary path-based CLI input. Snapshot once so inspection and rewriting
/// consume the same bounded bytes even if the source path changes later.
pub(super) struct Inputs {
    pub artifact: MappedArtifact,
    pub permissions: Permissions,
    pub name: String,
}

impl Inputs {
    pub fn open(cli: &Cli) -> Result<Self> {
        let file =
            File::open(&cli.input).with_context(|| format!("opening {}", cli.input.display()))?;
        let name = cli.input.display().to_string();
        let metadata = file.metadata()?;
        ensure!(metadata.is_file(), "input must be a regular file: {name}");
        ensure!(
            metadata.len() <= cli.max_input_bytes,
            "input exceeds artifact byte budget"
        );
        let artifact = MappedArtifact::snapshot(&file, cli.max_input_bytes)?;
        let after = file.metadata()?;
        ensure!(
            metadata.len() == after.len() && metadata.permissions() == after.permissions(),
            "input changed while snapshotting"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            ensure!(
                metadata.dev() == after.dev()
                    && metadata.ino() == after.ino()
                    && metadata.mtime() == after.mtime()
                    && metadata.mtime_nsec() == after.mtime_nsec()
                    && metadata.ctime() == after.ctime()
                    && metadata.ctime_nsec() == after.ctime_nsec()
                    && metadata.uid() == after.uid()
                    && metadata.gid() == after.gid(),
                "input changed while snapshotting"
            );
        }
        ensure!(
            artifact.bytes().len() as u64 == metadata.len(),
            "input changed while snapshotting"
        );
        Ok(Self {
            artifact,
            permissions: metadata.permissions(),
            name,
        })
    }
}
