use super::*;
use crate::IoBuffer;
use crate::package_inventory::{self, Content, File, PackageSpec};

type Source<'a> = dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno> + 'a;

#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    ino: u64,
    generation: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    size: u64,
}

fn observe(path: &[u8]) -> Result<Stamp, Errno> {
    ROOTFS.with(|state| {
        let root = state.mount_root()?;
        let index = state.walk(root, &split_components(path))?;
        let inode = state.get(index).ok_or(Errno::EIO)?;
        Ok(Stamp { ino: inode.ino, generation: inode.content_gen, mode: inode.mode,
            uid: inode.uid, gid: inode.gid, size: inode.stat().st_size })
    })
}

enum OwnedContent {
    Regular { size: u64, digest: [u8; 32] },
    Deferred { size: u64, digest: [u8; 32], provider: OwnedMetadata },
    Symlink(OwnedMetadata),
    Directory,
}

struct OwnedFile {
    path: IoBuffer<u8>,
    stamp: Stamp,
    content: OwnedContent,
}

impl OwnedFile {
    fn as_file(&self) -> File<'_> {
        File { path: &self.path, package: 0, mode: self.stamp.mode,
            uid: self.stamp.uid, gid: self.stamp.gid,
            content: match &self.content {
                OwnedContent::Regular { size, digest } => Content::Regular { size: *size, digest: *digest },
                OwnedContent::Deferred { size, digest, provider } => Content::Deferred { size: *size, digest: *digest, provider },
                OwnedContent::Symlink(target) => Content::Symlink(target),
                OwnedContent::Directory => Content::Directory,
            },
        }
    }
}

pub struct Builder {
    epoch: u64,
    program_abi: u32,
    program_digest: [u8; 32],
    name: IoBuffer<u8>,
    version: IoBuffer<u8>,
    files: IoBuffer<OwnedFile>,
    bytes: usize,
}

impl Builder {
    pub fn new(program_abi: u32, program_digest: [u8; 32], name: &[u8], version: &[u8]) -> Result<Self, Errno> {
        if fixed_persistence_enabled() { return Err(Errno::EPERM); }
        package_inventory::encode(program_abi, program_digest, &[PackageSpec {
            name, version, content_digest: None, dependencies: &[],
        }], &[])?;
        Ok(Self { epoch: package_plan::filesystem_epoch()?, program_abi, program_digest,
            name: package_inventory::metadata_copy(name)?, version: package_inventory::metadata_copy(version)?,
            files: package_inventory::metadata_buffer(), bytes: 512 })
    }

    fn require_source(&self) -> Result<(), Errno> {
        if fixed_persistence_enabled() || package_plan::filesystem_epoch()? != self.epoch { return Err(Errno::EBUSY); }
        Ok(())
    }

    pub fn add(&mut self, path: &[u8], declared_digest: Option<[u8; 32]>, source: &mut Source<'_>) -> Result<(), Errno> {
        self.require_source()?;
        if !package_inventory::valid_path(path) || !owns_path(path) { return Err(Errno::EINVAL); }
        if self.files.len() >= package_inventory::MAX_FILES { return Err(Errno::E2BIG); }
        let stamp = observe(path)?;
        let content = ROOTFS.with(|state| {
            let root = state.mount_root()?;
            let index = state.walk(root, &split_components(path))?;
            let inode = state.get(index).ok_or(Errno::EIO)?;
            Ok::<_, Errno>(match &inode.kind {
                InodeKind::Dir(_) => Some(OwnedContent::Directory),
                InodeKind::Symlink(target) => Some(OwnedContent::Symlink(own_metadata(target)?)),
                InodeKind::Special(_) => return Err(Errno::EOPNOTSUPP),
                InodeKind::LazyMember { .. } | InodeKind::BaseRegular { source: BaseSource::Host, .. }
                    if matches!(inode.kind, InodeKind::LazyMember { .. }) || inode.deferred_base || !inode.deferred_payload.is_empty() => {
                    let digest = if inode.deferred_digest == crate::sdef::DIGEST_NONE {
                        declared_digest.filter(|digest| *digest != crate::sdef::DIGEST_NONE).ok_or(Errno::EOPNOTSUPP)?
                    } else {
                        if declared_digest.is_some_and(|digest| digest != inode.deferred_digest) { return Err(Errno::EIO); }
                        inode.deferred_digest
                    };
                    Some(OwnedContent::Deferred { size: stamp.size, digest, provider: provider_record::describe(state, inode, digest)? })
                }
                _ => None,
            })
        })?;
        let content = match content {
            Some(content) => {
                if declared_digest.is_some() && !matches!(content, OwnedContent::Deferred { .. }) { return Err(Errno::EINVAL); }
                content
            }
            None => {
                if declared_digest.is_some() || stamp.size > i64::MAX as u64 { return Err(Errno::EINVAL); }
                let mut buffer = IoBuffer::try_filled(stamp.size.min(64 * 1024) as usize, 0)?;
                let mut digest = Sha256::new();
                let mut offset = 0u64;
                while offset < stamp.size {
                    let amount = (stamp.size - offset).min(buffer.len() as u64) as usize;
                    let count = read_file_at(path, offset as i64, &mut buffer[..amount], &mut *source)?;
                    if count == 0 || count > amount { return Err(Errno::EIO); }
                    digest.update(&buffer[..count]);
                    offset += count as u64;
                    self.require_source()?;
                }
                OwnedContent::Regular { size: stamp.size, digest: digest.finalize().into() }
            }
        };
        self.require_source()?;
        if observe(path)? != stamp { return Err(Errno::EBUSY); }
        let payload = match &content {
            OwnedContent::Deferred { provider, .. } => provider.len(),
            OwnedContent::Symlink(target) => target.len(),
            _ => 0,
        };
        let bytes = self.bytes.checked_add(path.len()).and_then(|bytes| bytes.checked_add(payload))
            .and_then(|bytes| bytes.checked_add(80)).ok_or(Errno::E2BIG)?;
        if bytes > package_inventory::MAX_BYTES { return Err(Errno::E2BIG); }
        self.files.try_push(OwnedFile { path: package_inventory::metadata_copy(path)?, stamp, content })?;
        self.bytes = bytes;
        Ok(())
    }

    pub fn finish(mut self) -> Result<IoBuffer<u8>, Errno> {
        self.require_source()?;
        self.files.sort_unstable_by(|left, right| left.path.cmp(&right.path));
        if self.files.windows(2).any(|pair| pair[0].path == pair[1].path) { return Err(Errno::EEXIST); }
        let mut files = package_inventory::metadata_with_capacity(self.files.len())?;
        for file in &self.files {
            if observe(&file.path)? != file.stamp { return Err(Errno::EBUSY); }
            if let OwnedContent::Deferred { digest, provider, .. } = &file.content {
                ROOTFS.with(|state| {
                    let root = state.mount_root()?;
                    let index = state.walk(root, &split_components(&file.path))?;
                    let inode = state.get(index).ok_or(Errno::EIO)?;
                    let current = provider_record::describe(state, inode, *digest)?;
                    if current != *provider { return Err(Errno::EBUSY); }
                    Ok(())
                })?;
            }
            files.push(file.as_file());
        }
        package_inventory::encode(self.program_abi, self.program_digest, &[PackageSpec {
            name: &self.name, version: &self.version, content_digest: None, dependencies: &[],
        }], &files)
    }
}
