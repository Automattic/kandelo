use crate::IoBuffer;
use sha2::{Digest, Sha256};
use wasm_posix_shared::Errno;

pub const VERSION: u32 = 1;
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PACKAGES: usize = 4096;
pub const MAX_FILES: usize = 65536;
pub const STATE_ROOT: &[u8] = b"/var/lib/kandelo/packages";
const HEADER_BYTES: usize = 52;
const DIGEST_BYTES: usize = 32;
const DEPENDENCY_BYTES: usize = 36;

pub(crate) const fn metadata_buffer<Value>() -> IoBuffer<Value> {
    IoBuffer::new_in(&crate::metadata_budget::PACKAGE_METADATA)
}

pub(crate) fn metadata_with_capacity<Value>(capacity: usize) -> Result<IoBuffer<Value>, Errno> {
    let mut bytes = metadata_buffer();
    bytes.try_reserve_exact(capacity)?;
    Ok(bytes)
}

pub(crate) fn metadata_copy(bytes: &[u8]) -> Result<IoBuffer<u8>, Errno> {
    let mut output = metadata_with_capacity(bytes.len())?;
    output.extend_from_slice(bytes);
    Ok(output)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Dependency {
    pub package: u32,
    pub content_digest: [u8; 32],
}

pub struct PackageSpec<'a> {
    pub name: &'a [u8],
    pub version: &'a [u8],
    pub content_digest: Option<[u8; 32]>,
    pub dependencies: &'a [Dependency],
}

pub struct Package<'a> {
    pub name: &'a [u8],
    pub version: &'a [u8],
    pub content_digest: [u8; 32],
    dependencies: &'a [u8],
}

impl Package<'_> {
    pub fn dependencies(&self) -> impl ExactSizeIterator<Item = Dependency> + '_ {
        self.dependencies
            .chunks_exact(DEPENDENCY_BYTES)
            .map(|bytes| Dependency {
                package: u32::from_le_bytes(bytes[..4].try_into().unwrap()),
                content_digest: bytes[4..].try_into().unwrap(),
            })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Content<'a> {
    Regular {
        size: u64,
        digest: [u8; 32],
    },
    Deferred {
        size: u64,
        digest: [u8; 32],
        provider: &'a [u8],
    },
    Symlink(&'a [u8]),
    Directory,
}

impl Content<'_> {
    pub fn file_identity(&self) -> Option<(u64, [u8; 32])> {
        match self {
            Self::Regular { size, digest } | Self::Deferred { size, digest, .. } => {
                Some((*size, *digest))
            }
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct File<'a> {
    pub path: &'a [u8],
    pub package: u32,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub content: Content<'a>,
}

pub struct Inventory<'a> {
    program_abi: u32,
    program_digest: [u8; 32],
    packages: IoBuffer<Package<'a>>,
    files: IoBuffer<File<'a>>,
    digest: [u8; 32],
}

#[derive(Debug, PartialEq, Eq)]
pub enum Change<'before, 'after> {
    Added(File<'after>),
    Removed(File<'before>),
    Replaced {
        before: File<'before>,
        after: File<'after>,
    },
}

pub struct Changes<'sets, 'before, 'after> {
    before: &'sets [File<'before>],
    after: &'sets [File<'after>],
}

impl<'before, 'after> Iterator for Changes<'_, 'before, 'after> {
    type Item = Change<'before, 'after>;
    fn next(&mut self) -> Option<Self::Item> {
        loop {
            match (self.before.first().copied(), self.after.first().copied()) {
                (None, None) => return None,
                (Some(before), None) => {
                    self.before = &self.before[1..];
                    return Some(Change::Removed(before));
                }
                (None, Some(after)) => {
                    self.after = &self.after[1..];
                    return Some(Change::Added(after));
                }
                (Some(before), Some(after)) => match before.path.cmp(after.path) {
                    core::cmp::Ordering::Less => {
                        self.before = &self.before[1..];
                        return Some(Change::Removed(before));
                    }
                    core::cmp::Ordering::Greater => {
                        self.after = &self.after[1..];
                        return Some(Change::Added(after));
                    }
                    core::cmp::Ordering::Equal => {
                        self.before = &self.before[1..];
                        self.after = &self.after[1..];
                        if (before.mode, before.uid, before.gid, before.content)
                            != (after.mode, after.uid, after.gid, after.content)
                        {
                            return Some(Change::Replaced { before, after });
                        }
                    }
                },
            }
        }
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take(&mut self, length: usize) -> Result<&'a [u8], Errno> {
        let result = self.bytes.get(..length).ok_or(Errno::EIO)?;
        self.bytes = &self.bytes[length..];
        Ok(result)
    }
    fn u32(&mut self) -> Result<u32, Errno> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().map_err(|_| Errno::EIO)?,
        ))
    }
    fn u64(&mut self) -> Result<u64, Errno> {
        Ok(u64::from_le_bytes(
            self.take(8)?.try_into().map_err(|_| Errno::EIO)?,
        ))
    }
    fn digest(&mut self) -> Result<[u8; 32], Errno> {
        self.take(32)?.try_into().map_err(|_| Errno::EIO)
    }
    fn bytes(&mut self, limit: usize) -> Result<&'a [u8], Errno> {
        let length = self.u32()? as usize;
        if length > limit {
            return Err(Errno::E2BIG);
        }
        self.take(length)
    }
}

pub fn valid_path(path: &[u8]) -> bool {
    if [b"/proc".as_slice(), b"/sys", b"/dev", b"/run", b"/tmp"]
        .iter()
        .any(|prefix| {
            path == *prefix || (path.starts_with(prefix) && path.get(prefix.len()) == Some(&b'/'))
        })
    {
        return false;
    }
    if path.first() != Some(&b'/')
        || path.len() > 4096
        || path.contains(&0)
        || (path.len() > 1 && path.last() == Some(&b'/'))
        || path == STATE_ROOT
        || path.starts_with(b"/var/lib/kandelo/packages/")
    {
        return false;
    }
    path == b"/"
        || path[1..]
            .split(|byte| *byte == b'/')
            .all(|part| !part.is_empty() && part != b"." && part != b".." && part.len() <= 255)
}

fn valid_label(label: &[u8]) -> bool {
    !label.is_empty()
        && label.len() <= 128
        && label
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.+".contains(byte))
}

fn hash_field(hasher: &mut Sha256, bytes: &[u8]) -> Result<(), Errno> {
    hasher.update(
        u32::try_from(bytes.len())
            .map_err(|_| Errno::E2BIG)?
            .to_le_bytes(),
    );
    hasher.update(bytes);
    Ok(())
}

fn payload_digests(package_count: usize, files: &[File<'_>]) -> Result<IoBuffer<[u8; 32]>, Errno> {
    let mut counts = metadata_with_capacity(package_count)?;
    counts.resize(package_count, 0u32);
    for file in files {
        let count = counts.get_mut(file.package as usize).ok_or(Errno::EINVAL)?;
        *count = count.checked_add(1).ok_or(Errno::E2BIG)?;
    }
    let mut hashers = metadata_with_capacity(package_count)?;
    for count in counts.iter() {
        let mut hasher = Sha256::new();
        hasher.update(b"kandelo-package-owned-files-v1\0");
        hasher.update(count.to_le_bytes());
        hashers.push(hasher);
    }
    for file in files {
        let hasher = hashers
            .get_mut(file.package as usize)
            .ok_or(Errno::EINVAL)?;
        hash_field(hasher, file.path)?;
        hasher.update(file.mode.to_le_bytes());
        hasher.update(file.uid.to_le_bytes());
        hasher.update(file.gid.to_le_bytes());
        match file.content {
            Content::Regular { size, digest } | Content::Deferred { size, digest, .. } => {
                hasher.update(1u32.to_le_bytes());
                hasher.update(size.to_le_bytes());
                hasher.update(digest);
            }
            Content::Symlink(target) => {
                hasher.update(2u32.to_le_bytes());
                hash_field(hasher, target)?;
            }
            Content::Directory => hasher.update(3u32.to_le_bytes()),
        }
    }
    let mut digests = metadata_with_capacity(package_count)?;
    for hasher in hashers {
        digests.push(hasher.finalize().into());
    }
    Ok(digests)
}

fn package_digest<'a>(
    program_abi: u32,
    program_digest: [u8; 32],
    name: &[u8],
    version: &[u8],
    payload: [u8; 32],
    dependencies: impl ExactSizeIterator<Item = (&'a [u8], &'a [u8], [u8; 32])>,
) -> Result<[u8; 32], Errno> {
    let mut hasher = Sha256::new();
    hasher.update(b"kandelo-package-manifest-v1\0");
    hasher.update(program_abi.to_le_bytes());
    hasher.update(program_digest);
    hash_field(&mut hasher, name)?;
    hash_field(&mut hasher, version)?;
    hasher.update(payload);
    hasher.update(
        u32::try_from(dependencies.len())
            .map_err(|_| Errno::E2BIG)?
            .to_le_bytes(),
    );
    for (name, version, digest) in dependencies {
        hash_field(&mut hasher, name)?;
        hash_field(&mut hasher, version)?;
        hasher.update(digest);
    }
    Ok(hasher.finalize().into())
}

impl<'a> Inventory<'a> {
    pub fn program_abi(&self) -> u32 {
        self.program_abi
    }
    pub fn program_digest(&self) -> [u8; 32] {
        self.program_digest
    }
    pub fn packages(&self) -> &[Package<'a>] {
        &self.packages
    }
    pub fn files(&self) -> &[File<'a>] {
        &self.files
    }
    pub fn digest(&self) -> [u8; 32] {
        self.digest
    }

    pub fn changes<'sets, 'after>(
        &'sets self,
        after: &'sets Inventory<'after>,
    ) -> Changes<'sets, 'a, 'after> {
        Changes {
            before: &self.files,
            after: &after.files,
        }
    }

    pub fn decode(bytes: &'a [u8]) -> Result<Self, Errno> {
        if bytes.len() > MAX_BYTES {
            return Err(Errno::E2BIG);
        }
        if bytes.len() < HEADER_BYTES + DIGEST_BYTES {
            return Err(Errno::EIO);
        }
        let (body, digest) = bytes.split_at(bytes.len() - DIGEST_BYTES);
        if Sha256::digest(body).as_slice() != digest {
            return Err(Errno::EIO);
        }
        let digest = digest.try_into().map_err(|_| Errno::EIO)?;
        let mut reader = Reader { bytes: body };
        if reader.take(4)? != b"KPKG" {
            return Err(Errno::EIO);
        }
        if reader.u32()? != VERSION {
            return Err(Errno::EOPNOTSUPP);
        }
        let program_abi = reader.u32()?;
        let program_digest = reader.digest()?;
        if program_abi == 0 || program_abi > i32::MAX as u32 || program_digest == [0; 32] {
            return Err(Errno::EINVAL);
        }
        let package_count = reader.u32()? as usize;
        let file_count = reader.u32()? as usize;
        if package_count > MAX_PACKAGES || file_count > MAX_FILES {
            return Err(Errno::E2BIG);
        }
        let mut packages: IoBuffer<Package<'a>> = metadata_with_capacity(package_count)?;
        for _ in 0..package_count {
            let name = reader.bytes(128)?;
            let version = reader.bytes(128)?;
            let content_digest = reader.digest()?;
            let dependency_count = reader.u32()? as usize;
            if dependency_count > MAX_PACKAGES {
                return Err(Errno::E2BIG);
            }
            let dependencies = reader.take(
                dependency_count
                    .checked_mul(DEPENDENCY_BYTES)
                    .ok_or(Errno::E2BIG)?,
            )?;
            if !valid_label(name)
                || !valid_label(version)
                || content_digest == [0; 32]
                || packages
                    .last()
                    .is_some_and(|previous| previous.name >= name)
            {
                return Err(Errno::EINVAL);
            }
            packages.push(Package {
                name,
                version,
                content_digest,
                dependencies,
            });
        }
        for (index, package) in packages.iter().enumerate() {
            let mut previous = None;
            for dependency in package.dependencies() {
                let target = packages
                    .get(dependency.package as usize)
                    .ok_or(Errno::EINVAL)?;
                if dependency.package as usize == index
                    || previous.is_some_and(|previous| previous >= dependency.package)
                    || target.content_digest != dependency.content_digest
                {
                    return Err(Errno::EINVAL);
                }
                previous = Some(dependency.package);
            }
        }
        let mut files: IoBuffer<File<'a>> = metadata_with_capacity(file_count)?;
        for _ in 0..file_count {
            let path = reader.bytes(4096)?;
            let package = reader.u32()?;
            let mode = reader.u32()?;
            let uid = reader.u32()?;
            let gid = reader.u32()?;
            let kind = reader.u32()?;
            let content = match kind {
                1 | 4 => {
                    let size = reader.u64()?;
                    let digest = reader.digest()?;
                    if size > i64::MAX as u64 || digest == [0; 32] {
                        return Err(Errno::EINVAL);
                    }
                    if kind == 1 {
                        Content::Regular { size, digest }
                    } else {
                        let provider =
                            reader.bytes(crate::persistent_overlay::MAX_INODE_RECORD_BYTES)?;
                        if crate::rootfs::persistent_provider_identity(provider)? != (size, digest)
                        {
                            return Err(Errno::EINVAL);
                        }
                        Content::Deferred {
                            size,
                            digest,
                            provider,
                        }
                    }
                }
                2 => {
                    let target = reader.bytes(4096)?;
                    if target.is_empty() || target.contains(&0) {
                        return Err(Errno::EINVAL);
                    }
                    Content::Symlink(target)
                }
                3 => Content::Directory,
                _ => return Err(Errno::EOPNOTSUPP),
            };
            if !valid_path(path)
                || package as usize >= packages.len()
                || mode & !0o7777 != 0
                || (path == b"/" && content != Content::Directory)
                || files.last().is_some_and(|previous| previous.path >= path)
            {
                return Err(Errno::EINVAL);
            }
            files.push(File {
                path,
                package,
                mode,
                uid,
                gid,
                content,
            });
        }
        if !reader.bytes.is_empty() {
            return Err(Errno::EIO);
        }
        for file in &files {
            for (offset, _) in file
                .path
                .iter()
                .enumerate()
                .filter(|(offset, byte)| *offset > 0 && **byte == b'/')
            {
                if let Ok(parent) =
                    files.binary_search_by_key(&&file.path[..offset], |file| file.path)
                {
                    if files[parent].content != Content::Directory {
                        return Err(Errno::ENOTDIR);
                    }
                }
            }
        }
        let payloads = payload_digests(packages.len(), &files)?;
        for (index, package) in packages.iter().enumerate() {
            let actual = package_digest(
                program_abi,
                program_digest,
                package.name,
                package.version,
                payloads[index],
                package.dependencies().map(|dependency| {
                    let target = &packages[dependency.package as usize];
                    (target.name, target.version, dependency.content_digest)
                }),
            )?;
            if actual != package.content_digest {
                return Err(Errno::EIO);
            }
        }
        Ok(Self {
            program_abi,
            program_digest,
            packages,
            files,
            digest,
        })
    }

    pub fn check_runtime(&self, program_abi: u32, program_digest: [u8; 32]) -> Result<(), Errno> {
        if self.program_abi == program_abi && self.program_digest == program_digest {
            Ok(())
        } else {
            Err(Errno::ENOEXEC)
        }
    }
}

struct Writer {
    bytes: IoBuffer<u8>,
}

impl Writer {
    fn put(&mut self, bytes: &[u8]) -> Result<(), Errno> {
        if self
            .bytes
            .len()
            .checked_add(bytes.len())
            .ok_or(Errno::E2BIG)?
            > MAX_BYTES
        {
            return Err(Errno::E2BIG);
        }
        self.bytes.try_reserve(bytes.len())?;
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }
    fn u32(&mut self, value: u32) -> Result<(), Errno> {
        self.put(&value.to_le_bytes())
    }
    fn bytes(&mut self, bytes: &[u8]) -> Result<(), Errno> {
        self.u32(u32::try_from(bytes.len()).map_err(|_| Errno::E2BIG)?)?;
        self.put(bytes)
    }
}

pub fn encode(
    program_abi: u32,
    program_digest: [u8; 32],
    packages: &[PackageSpec<'_>],
    files: &[File<'_>],
) -> Result<IoBuffer<u8>, Errno> {
    if packages.len() > MAX_PACKAGES || files.len() > MAX_FILES {
        return Err(Errno::E2BIG);
    }
    let payloads = payload_digests(packages.len(), files)?;
    let mut commitments = metadata_with_capacity(packages.len())?;
    for (index, package) in packages.iter().enumerate() {
        if package.dependencies.len() > MAX_PACKAGES {
            return Err(Errno::E2BIG);
        }
        for dependency in package.dependencies {
            if dependency.package as usize >= packages.len() {
                return Err(Errno::EINVAL);
            }
        }
        let actual = package_digest(
            program_abi,
            program_digest,
            package.name,
            package.version,
            payloads[index],
            package.dependencies.iter().map(|dependency| {
                let target = &packages[dependency.package as usize];
                (target.name, target.version, dependency.content_digest)
            }),
        )?;
        if package
            .content_digest
            .is_some_and(|expected| expected != actual)
        {
            return Err(Errno::EIO);
        }
        commitments.push(actual);
    }
    let mut writer = Writer {
        bytes: metadata_buffer(),
    };
    writer.put(b"KPKG")?;
    writer.u32(VERSION)?;
    writer.u32(program_abi)?;
    writer.put(&program_digest)?;
    writer.u32(packages.len() as u32)?;
    writer.u32(files.len() as u32)?;
    for (index, package) in packages.iter().enumerate() {
        writer.bytes(package.name)?;
        writer.bytes(package.version)?;
        writer.put(&commitments[index])?;
        writer.u32(u32::try_from(package.dependencies.len()).map_err(|_| Errno::E2BIG)?)?;
        for dependency in package.dependencies {
            writer.u32(dependency.package)?;
            writer.put(&dependency.content_digest)?;
        }
    }
    for file in files {
        writer.bytes(file.path)?;
        writer.u32(file.package)?;
        writer.u32(file.mode)?;
        writer.u32(file.uid)?;
        writer.u32(file.gid)?;
        writer.u32(match file.content {
            Content::Regular { .. } => 1,
            Content::Symlink(_) => 2,
            Content::Directory => 3,
            Content::Deferred { .. } => 4,
        })?;
        match file.content {
            Content::Regular { size, digest } | Content::Deferred { size, digest, .. } => {
                writer.put(&size.to_le_bytes())?;
                writer.put(&digest)?;
                if let Content::Deferred { provider, .. } = file.content {
                    writer.bytes(provider)?;
                }
            }
            Content::Symlink(target) => writer.bytes(target)?,
            Content::Directory => {}
        }
    }
    let digest: [u8; 32] = Sha256::digest(&writer.bytes).into();
    writer.put(&digest)?;
    Inventory::decode(&writer.bytes)?;
    Ok(writer.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use alloc::vec::Vec;

    fn packages() -> [PackageSpec<'static>; 1] {
        [PackageSpec {
            name: b"core",
            version: b"1.0",
            content_digest: None,
            dependencies: &[],
        }]
    }

    fn file(path: &[u8]) -> File<'_> {
        File {
            path,
            package: 0,
            mode: 0o755,
            uid: 0,
            gid: 0,
            content: Content::Regular {
                size: 5,
                digest: Sha256::digest(b"hello").into(),
            },
        }
    }

    fn component_digest(name: &[u8], version: &[u8], files: &[File<'_>]) -> [u8; 32] {
        let bytes = encode(
            55,
            [7; 32],
            &[PackageSpec {
                name,
                version,
                content_digest: None,
                dependencies: &[],
            }],
            files,
        )
        .unwrap();
        Inventory::decode(&bytes).unwrap().packages()[0].content_digest
    }

    fn reseal(bytes: &mut [u8]) {
        let end = bytes.len() - 32;
        let digest = Sha256::digest(&bytes[..end]);
        bytes[end..].copy_from_slice(&digest);
    }

    #[test]
    fn inventory_roundtrip_preserves_owners_metadata_and_content() {
        let files = [file(b"/usr/bin/tool")];
        let bytes = encode(55, [7; 32], &packages(), &files).unwrap();
        let inventory = Inventory::decode(&bytes).unwrap();
        assert_eq!(inventory.files(), files);
        assert_eq!(inventory.packages()[0].name, b"core");
        assert_eq!(inventory.packages()[0].version, b"1.0");
        assert_eq!(inventory.program_abi(), 55);
        assert_eq!(inventory.check_runtime(55, [7; 32]), Ok(()));
        assert_eq!(inventory.check_runtime(56, [7; 32]), Err(Errno::ENOEXEC));
        assert_eq!(inventory.check_runtime(55, [8; 32]), Err(Errno::ENOEXEC));
    }

    #[test]
    fn owned_file_omissions_and_substitutions_cannot_reuse_a_package_commitment() {
        let bytes = encode(55, [7; 32], &packages(), &[file(b"/bin/tool")]).unwrap();
        let original = Inventory::decode(&bytes).unwrap().packages()[0].content_digest;
        let pinned = [PackageSpec {
            content_digest: Some(original),
            ..packages().into_iter().next().unwrap()
        }];
        assert!(encode(55, [7; 32], &pinned, &[]).is_err());
        assert!(encode(55, [7; 32], &pinned, &[file(b"/bin/evil")]).is_err());
        let mut substituted = bytes.to_vec();
        let offset = substituted
            .windows(9)
            .position(|bytes| bytes == b"/bin/tool")
            .unwrap();
        substituted[offset..offset + 9].copy_from_slice(b"/bin/evil");
        reseal(&mut substituted);
        assert!(matches!(Inventory::decode(&substituted), Err(Errno::EIO)));
        let package_end = HEADER_BYTES + 4 + 4 + 4 + 3 + 32 + 4;
        let mut omitted = bytes[..package_end].to_vec();
        omitted[48..52].copy_from_slice(&0u32.to_le_bytes());
        omitted.extend_from_slice(&[0; 32]);
        reseal(&mut omitted);
        assert!(matches!(Inventory::decode(&omitted), Err(Errno::EIO)));
    }

    #[test]
    fn inventory_checks_corruption_unknown_versions_truncation_and_counts() {
        let bytes = encode(55, [7; 32], &packages(), &[file(b"/bin/tool")]).unwrap();
        for offset in [0, 4, 12, 44, 48, bytes.len() - 1] {
            let mut damaged = bytes.to_vec();
            damaged[offset] ^= 1;
            assert!(matches!(Inventory::decode(&damaged), Err(Errno::EIO)));
        }
        for length in 0..bytes.len() {
            assert!(Inventory::decode(&bytes[..length]).is_err());
        }
        let mut future = bytes.to_vec();
        future[4..8].copy_from_slice(&2u32.to_le_bytes());
        reseal(&mut future);
        assert!(matches!(Inventory::decode(&future), Err(Errno::EOPNOTSUPP)));
        let mut oversized = bytes.to_vec();
        oversized[48..52].copy_from_slice(&(MAX_FILES as u32 + 1).to_le_bytes());
        reseal(&mut oversized);
        assert!(matches!(Inventory::decode(&oversized), Err(Errno::E2BIG)));
    }

    #[test]
    fn dependency_pins_require_one_complete_exact_package_set() {
        let good = [Dependency {
            package: 0,
            content_digest: component_digest(b"core", b"1", &[]),
        }];
        let wrong = [Dependency {
            package: 0,
            content_digest: [9; 32],
        }];
        let absent = [Dependency {
            package: 9,
            content_digest: [1; 32],
        }];
        let self_reference = [Dependency {
            package: 1,
            content_digest: [2; 32],
        }];
        let duplicate = [good[0], good[0]];
        for (dependencies, valid) in [
            (&good[..], true),
            (&wrong[..], false),
            (&absent[..], false),
            (&self_reference[..], false),
            (&duplicate[..], false),
        ] {
            let packages = [
                PackageSpec {
                    name: b"core",
                    version: b"1",
                    content_digest: None,
                    dependencies: &[],
                },
                PackageSpec {
                    name: b"server",
                    version: b"2",
                    content_digest: None,
                    dependencies,
                },
            ];
            let result = encode(55, [7; 32], &packages, &[]);
            assert_eq!(result.is_ok(), valid);
        }
    }

    #[test]
    fn package_and_file_names_must_be_canonical_unique_and_owned() {
        let duplicate = [file(b"/bin/tool"), file(b"/bin/tool")];
        let unsorted = [file(b"/z"), file(b"/a")];
        assert!(encode(55, [7; 32], &packages(), &duplicate).is_err());
        assert!(encode(55, [7; 32], &packages(), &unsorted).is_err());
        for path in [
            b"relative".as_slice(),
            b"/../bin/tool",
            b"/bin//tool",
            b"/bin/./tool",
            b"/bin/tool/",
            b"/bin/\0tool",
            STATE_ROOT,
            b"/var/lib/kandelo/packages/current",
        ] {
            assert!(
                encode(55, [7; 32], &packages(), &[file(path)]).is_err(),
                "{path:?}"
            );
        }
        let mut unowned = file(b"/bin/tool");
        unowned.package = 1;
        assert!(encode(55, [7; 32], &packages(), &[unowned]).is_err());
        let packages = [
            PackageSpec {
                name: b"core",
                version: b"1",
                content_digest: None,
                dependencies: &[],
            },
            PackageSpec {
                name: b"core",
                version: b"2",
                content_digest: None,
                dependencies: &[],
            },
        ];
        assert!(encode(55, [7; 32], &packages, &[]).is_err());
    }

    #[test]
    fn regular_files_cannot_be_parent_directories() {
        assert!(matches!(
            encode(
                55,
                [7; 32],
                &packages(),
                &[file(b"/usr"), file(b"/usr/bin/tool")]
            ),
            Err(Errno::ENOTDIR)
        ));
        let directory = File {
            content: Content::Directory,
            ..file(b"/usr")
        };
        assert!(
            encode(
                55,
                [7; 32],
                &packages(),
                &[directory, file(b"/usr/bin/tool")]
            )
            .is_ok()
        );
    }

    #[test]
    fn symlink_targets_keep_posix_relative_and_absolute_meaning() {
        for target in [b"../lib/tool".as_slice(), b"/usr/lib/tool"] {
            let files = [File {
                content: Content::Symlink(target),
                ..file(b"/bin/tool")
            }];
            let bytes = encode(55, [7; 32], &packages(), &files).unwrap();
            assert_eq!(Inventory::decode(&bytes).unwrap().files(), files);
        }
        for target in [b"".as_slice(), b"bad\0target"] {
            assert!(
                encode(
                    55,
                    [7; 32],
                    &packages(),
                    &[File {
                        content: Content::Symlink(target),
                        ..file(b"/bin/tool")
                    }]
                )
                .is_err()
            );
        }
    }

    #[test]
    fn deferred_files_must_match_their_provider_content_identity() {
        let digest = Sha256::digest(b"hello").into();
        let record = crate::sdef::DeferredRecord {
            ino: 1,
            size: 5,
            archive_id: 0,
            source_path: Vec::new(),
            uri: b"https://packages.invalid/tool".to_vec(),
            digest,
            payload: Vec::new(),
        };
        let provider = crate::sdef::encode(&[], &[record]).unwrap();
        let content = Content::Deferred {
            size: 5,
            digest,
            provider: &provider,
        };
        let bytes = encode(
            55,
            [7; 32],
            &packages(),
            &[File {
                content,
                ..file(b"/bin/tool")
            }],
        )
        .unwrap();
        assert_eq!(
            Inventory::decode(&bytes).unwrap().files()[0].content,
            content
        );
        for content in [
            Content::Deferred {
                size: 6,
                digest,
                provider: &provider,
            },
            Content::Deferred {
                size: 5,
                digest: [9; 32],
                provider: &provider,
            },
        ] {
            assert!(
                encode(
                    55,
                    [7; 32],
                    &packages(),
                    &[File {
                        content,
                        ..file(b"/bin/tool")
                    }]
                )
                .is_err()
            );
        }
    }

    #[test]
    fn diff_skips_unchanged_files_when_package_indexes_or_releases_change() {
        let old = encode(55, [7; 32], &packages(), &[file(b"/bin/tool")]).unwrap();
        let dependencies = [Dependency {
            package: 1,
            content_digest: component_digest(b"core", b"2", &[file(b"/bin/tool")]),
        }];
        let next_packages = [
            PackageSpec {
                name: b"addon",
                version: b"1",
                content_digest: None,
                dependencies: &dependencies,
            },
            PackageSpec {
                name: b"core",
                version: b"2",
                content_digest: None,
                dependencies: &[],
            },
        ];
        let next = encode(
            55,
            [7; 32],
            &next_packages,
            &[File {
                package: 1,
                ..file(b"/bin/tool")
            }],
        )
        .unwrap();
        let old = Inventory::decode(&old).unwrap();
        let next = Inventory::decode(&next).unwrap();
        assert_eq!(old.changes(&next).count(), 0);
    }

    #[test]
    fn diff_distinguishes_added_removed_and_changed_metadata_without_scanning_file_bodies() {
        let before = encode(
            55,
            [7; 32],
            &packages(),
            &[file(b"/a"), file(b"/c"), file(b"/d")],
        )
        .unwrap();
        let after = encode(
            55,
            [7; 32],
            &packages(),
            &[
                file(b"/b"),
                File {
                    mode: 0o700,
                    ..file(b"/c")
                },
                file(b"/d"),
            ],
        )
        .unwrap();
        let before = Inventory::decode(&before).unwrap();
        let after = Inventory::decode(&after).unwrap();
        let changes: Vec<_> = before.changes(&after).collect();
        assert_eq!(
            changes,
            vec![
                Change::Removed(file(b"/a")),
                Change::Added(file(b"/b")),
                Change::Replaced {
                    before: file(b"/c"),
                    after: File {
                        mode: 0o700,
                        ..file(b"/c")
                    }
                }
            ]
        );
    }

    #[test]
    fn inventory_allocation_refusal_does_not_mutate_the_input_and_allows_retry() {
        let bytes = encode(55, [7; 32], &packages(), &[file(b"/bin/tool")]).unwrap();
        let original = bytes.to_vec();
        struct Quota(usize);
        impl Drop for Quota {
            fn drop(&mut self) { crate::metadata_budget::PACKAGE_METADATA.set_limit(self.0).unwrap(); }
        }
        let budget = &crate::metadata_budget::PACKAGE_METADATA;
        let quota = Quota(budget.usage().1);
        budget.set_limit(budget.usage().0).unwrap();
        assert!(matches!(Inventory::decode(&bytes), Err(Errno::ENOMEM)));
        drop(quota);
        assert_eq!(bytes.as_ref(), original.as_slice());
        assert!(Inventory::decode(&bytes).is_ok());
    }
}
