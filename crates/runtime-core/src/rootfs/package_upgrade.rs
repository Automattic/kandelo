use super::package_plan::{FileVerification, VerificationError, VerifiedFile};
use super::*;
use crate::io_buffer::IoBuffer;
use crate::package_inventory::{Change, Content, File, Inventory, MAX_BYTES, MAX_FILES, STATE_ROOT};
use crate::process_table::{MaintenanceToken, ProcessTable};

pub const INSTALLED: &[u8] = b"/var/lib/kandelo/packages/installed";
const TRANSACTION: &[u8] = b"/var/lib/kandelo/packages/transaction";
const BEFORE: &[u8] = b"/var/lib/kandelo/packages/transaction/before";
const AFTER: &[u8] = b"/var/lib/kandelo/packages/transaction/after";
const STATUS: &[u8] = b"/var/lib/kandelo/packages/transaction/status";
const PENDING: &[u8] = b"/var/lib/kandelo/packages/transaction/pending";
const ACTIVE: &[u8] = b"/var/lib/kandelo/packages/transaction/active";
const ROLLED_BACK: &[u8] = b"/var/lib/kandelo/packages/transaction/rolled-back";
const NEW: &[u8] = b"/var/lib/kandelo/packages/transaction/new";
const OLD: &[u8] = b"/var/lib/kandelo/packages/transaction/old";
const RECORD_BYTES: usize = 108;
const MAX_ACTIONS: usize = MAX_FILES * 2;
const _: () = assert!(MAX_ACTIONS == wasm_posix_shared::package_maintenance_wire::MAX_CHANGED_FILES as usize);
const CHUNK_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Pending = 1,
    Active = 2,
    RolledBack = 3,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recovery {
    None,
    Incomplete,
    Transaction(Phase),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerificationTarget {
    Installed,
    Staged,
}

pub struct Progress<'a> {
    pub phase: Phase,
    pub changed_files: usize,
    pub installed_files_verified: usize,
    pub staged_files_verified: usize,
    pub current: Option<(VerificationTarget, &'a [u8])>,
    pub verified_bytes: u64,
    pub total_bytes: u64,
}

pub struct StagingFile<'a> {
    pub path: &'a [u8],
    pub upload_size: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Storage(Errno),
    Verification(VerificationError),
    UnsupportedPath,
    InvalidState,
}

impl From<Errno> for Error {
    fn from(error: Errno) -> Self {
        Self::Storage(error)
    }
}
impl From<VerificationError> for Error {
    fn from(error: VerificationError) -> Self {
        Self::Verification(error)
    }
}

type Source<'a> = dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno> + 'a;

enum ActivationPath<'a> {
    Borrowed(&'a [u8]),
    Private(OwnedMetadata),
}

impl AsRef<[u8]> for ActivationPath<'_> {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Borrowed(path) => path,
            Self::Private(path) => path,
        }
    }
}

#[derive(Clone, Copy)]
struct InventoryRange {
    start: u32,
    end: u32,
}

impl InventoryRange {
    fn capture(inventory: &[u8], field: &[u8]) -> Result<Self, Errno> {
        let start = (field.as_ptr() as usize).checked_sub(inventory.as_ptr() as usize).ok_or(Errno::EIO)?;
        let end = start.checked_add(field.len()).ok_or(Errno::EIO)?;
        if end > inventory.len() { return Err(Errno::EIO); }
        Ok(Self { start: u32::try_from(start).map_err(|_| Errno::EIO)?, end: u32::try_from(end).map_err(|_| Errno::EIO)? })
    }

    fn view(self, inventory: &[u8]) -> &[u8] {
        inventory.get(self.start as usize..self.end as usize).expect("validated immutable inventory range changed")
    }
}

struct IndexedFile {
    path: InventoryRange,
    mode: u32,
    uid: u32,
    gid: u32,
    content: IndexedContent,
}

enum IndexedContent {
    Regular {
        size: u64,
        digest: [u8; 32],
    },
    Deferred {
        size: u64,
        digest: [u8; 32],
        provider: InventoryRange,
    },
    Symlink(InventoryRange),
    Directory,
}

impl IndexedFile {
    fn capture(inventory: &[u8], file: File<'_>) -> Result<Self, Error> {
        let content = match file.content {
            Content::Regular { size, digest } => IndexedContent::Regular { size, digest },
            Content::Deferred {
                size,
                digest,
                provider,
            } => IndexedContent::Deferred {
                size,
                digest,
                provider: InventoryRange::capture(inventory, provider)?,
            },
            Content::Symlink(target) => IndexedContent::Symlink(InventoryRange::capture(inventory, target)?),
            Content::Directory => IndexedContent::Directory,
        };
        Ok(Self {
            path: InventoryRange::capture(inventory, file.path)?,
            mode: file.mode,
            uid: file.uid,
            gid: file.gid,
            content,
        })
    }

    fn view<'a>(&self, inventory: &'a [u8]) -> File<'a> {
        File {
            path: self.path.view(inventory),
            package: 0,
            mode: self.mode,
            uid: self.uid,
            gid: self.gid,
            content: match &self.content {
                IndexedContent::Regular { size, digest } => Content::Regular {
                    size: *size,
                    digest: *digest,
                },
                IndexedContent::Deferred {
                    size,
                    digest,
                    provider,
                } => Content::Deferred {
                    size: *size,
                    digest: *digest,
                    provider: provider.view(inventory),
                },
                IndexedContent::Symlink(target) => Content::Symlink(target.view(inventory)),
                IndexedContent::Directory => Content::Directory,
            },
        }
    }
}

struct Action {
    before: Option<IndexedFile>,
    after: Option<IndexedFile>,
    live: Option<VerifiedFile>,
    staged: Option<VerifiedFile>,
}

impl Action {
    fn is_directory(&self) -> bool {
        matches!(
            self.before
                .as_ref()
                .or(self.after.as_ref())
                .map(|file| &file.content),
            Some(IndexedContent::Directory)
        )
    }
    fn adds_directory(&self) -> bool {
        self.before.is_none() && self.is_directory()
    }
    fn path<'a>(&self, before: &'a [u8], after: &'a [u8]) -> &'a [u8] {
        self.before.as_ref().map(|file| file.path.view(before))
            .or_else(|| self.after.as_ref().map(|file| file.path.view(after)))
            .expect("upgrade action has no file")
    }
    fn source<'a>(&self, phase: Phase, before: &'a [u8], after: &'a [u8]) -> Option<File<'a>> {
        if phase == Phase::Active {
            self.after.as_ref().map(|file| file.view(after)).or_else(|| {
                self.before
                    .as_ref()
                    .filter(|file| matches!(file.content, IndexedContent::Directory))
                    .map(|file| file.view(before))
            })
        } else {
            self.before.as_ref().map(|file| file.view(before))
        }
    }
    fn destination<'a>(&self, phase: Phase, before: &'a [u8], after: &'a [u8]) -> Option<File<'a>> {
        if phase == Phase::Active {
            self.before.as_ref().map(|file| file.view(before))
        } else {
            self.after.as_ref().map(|file| file.view(after))
        }
    }
}

fn copy_bytes(bytes: &[u8]) -> Result<IoBuffer<u8>, Errno> {
    crate::package_inventory::metadata_copy(bytes)
}

fn read_bounded(path: &[u8], limit: usize, source: &mut Source<'_>) -> Result<IoBuffer<u8>, Errno> {
    let stat = lstat(path)?;
    if stat.st_mode & S_IFMT != S_IFREG || stat.st_size > limit as u64 {
        return Err(Errno::EIO);
    }
    let mut bytes = crate::package_inventory::metadata_with_capacity(stat.st_size as usize)?;
    bytes.resize(stat.st_size as usize, 0);
    let handle = open(path, O_RDONLY, 0, 0, 0)?;
    let result = (|| {
        let mut offset = 0;
        while offset < bytes.len() {
            let end = bytes.len().min(offset + CHUNK_BYTES);
            let count = read(handle, offset as i64, &mut bytes[offset..end], &mut *source)?;
            if count == 0 {
                return Err(Errno::EIO);
            }
            offset += count;
        }
        Ok(())
    })();
    release_handle(handle);
    result?;
    Ok(bytes)
}

fn create_bytes(path: &[u8], bytes: &[u8], source: &mut Source<'_>) -> Result<(), Errno> {
    let handle = open(path, O_WRONLY | O_CREAT | O_EXCL, 0o600, 0, 0)?;
    let result = (|| {
        let mut offset = 0;
        while offset < bytes.len() {
            let end = bytes.len().min(offset + CHUNK_BYTES);
            let count = write(handle, offset as i64, &bytes[offset..end], &mut *source)?;
            if count == 0 {
                return Err(Errno::EIO);
            }
            offset += count;
        }
        Ok(())
    })();
    release_handle(handle);
    result
}

fn record(phase: Phase, before: [u8; 32], after: [u8; 32]) -> [u8; RECORD_BYTES] {
    let mut bytes = [0; RECORD_BYTES];
    bytes[..4].copy_from_slice(b"KUPG");
    bytes[4..8].copy_from_slice(&1u32.to_le_bytes());
    bytes[8..12].copy_from_slice(&(phase as u32).to_le_bytes());
    bytes[12..44].copy_from_slice(&before);
    bytes[44..76].copy_from_slice(&after);
    let digest = Sha256::digest(&bytes[..76]);
    bytes[76..].copy_from_slice(&digest);
    bytes
}

fn decode_record(bytes: &[u8]) -> Result<(Phase, [u8; 32], [u8; 32]), Error> {
    if bytes.len() != RECORD_BYTES
        || &bytes[..4] != b"KUPG"
        || Sha256::digest(&bytes[..76]).as_slice() != &bytes[76..]
    {
        return Err(Error::InvalidState);
    }
    if bytes[4..8] != 1u32.to_le_bytes() {
        return Err(Errno::EOPNOTSUPP.into());
    }
    let phase = match u32::from_le_bytes(bytes[8..12].try_into().unwrap()) {
        1 => Phase::Pending,
        2 => Phase::Active,
        3 => Phase::RolledBack,
        _ => return Err(Errno::EOPNOTSUPP.into()),
    };
    Ok((
        phase,
        bytes[12..44].try_into().unwrap(),
        bytes[44..76].try_into().unwrap(),
    ))
}

fn require(table: &ProcessTable, token: &MaintenanceToken) -> Result<(), Error> {
    table.maintenance_identity(token)?;
    if !resizable_persistence_enabled() {
        return Err(Errno::EOPNOTSUPP.into());
    }
    Ok(())
}

fn private_directory(path: &[u8]) -> Result<(), Errno> {
    let stat = lstat(path)?;
    if stat.st_mode & S_IFMT != S_IFDIR
        || stat.st_mode & 0o7777 != 0o700
        || stat.st_uid != 0
        || stat.st_gid != 0
    {
        return Err(Errno::EPERM);
    }
    Ok(())
}

fn staged_path(index: usize, phase: Phase) -> Result<OwnedMetadata, Errno> {
    let directory = if phase == Phase::Active { OLD } else { NEW };
    let mut path = [0u8; 80];
    path[..directory.len()].copy_from_slice(directory);
    path[directory.len()] = b'/';
    for offset in 0..8 {
        path[directory.len() + 1 + offset] =
            b"0123456789abcdef"[(index >> ((7 - offset) * 4)) & 15];
    }
    own_metadata(&path[..directory.len() + 9])
}

pub(super) fn boot_requires_maintenance(source: &mut Source<'_>) -> Result<bool, Error> {
    match lstat(TRANSACTION) {
        Err(Errno::ENOENT) => return Ok(false),
        Err(error) => return Err(error.into()),
        Ok(_) => private_directory(TRANSACTION)?,
    }
    private_directory(STATE_ROOT)?;
    let bytes = match read_bounded(STATUS, RECORD_BYTES, source) {
        Err(Errno::ENOENT) => return Ok(true),
        result => result?,
    };
    Ok(decode_record(&bytes)?.0 == Phase::Pending)
}

pub fn recovery(
    table: &ProcessTable,
    token: &MaintenanceToken,
    source: &mut Source<'_>,
) -> Result<Recovery, Error> {
    require(table, token)?;
    match lstat(TRANSACTION) {
        Err(Errno::ENOENT) => return Ok(Recovery::None),
        Err(error) => return Err(error.into()),
        Ok(_) => private_directory(TRANSACTION)?,
    }
    private_directory(STATE_ROOT)?;
    let bytes = match read_bounded(STATUS, RECORD_BYTES, source) {
        Err(Errno::ENOENT) => return Ok(Recovery::Incomplete),
        result => result?,
    };
    let (phase, before, after) = decode_record(&bytes)?;
    let installed = read_bounded(INSTALLED, MAX_BYTES, source)?;
    let installed = Inventory::decode(&installed)?;
    if installed.digest()
        != if phase == Phase::Active {
            after
        } else {
            before
        }
    {
        return Err(Error::InvalidState);
    }
    for (path, expected) in [(BEFORE, before), (AFTER, after)] {
        let manifest = read_bounded(path, MAX_BYTES, source)?;
        if Inventory::decode(&manifest)?.digest() != expected {
            return Err(Error::InvalidState);
        }
    }
    Ok(Recovery::Transaction(phase))
}

pub(super) fn check_installed_runtime(
    current_abi: u32,
    current_digest: [u8; 32],
    source: &mut Source<'_>,
) -> Result<(), Error> {
    private_directory(STATE_ROOT)?;
    let bytes = read_bounded(INSTALLED, MAX_BYTES, source)?;
    Inventory::decode(&bytes)?.check_runtime(current_abi, current_digest)?;
    Ok(())
}

pub fn discard_transaction(
    table: &ProcessTable,
    token: &MaintenanceToken,
    source: &mut Source<'_>,
) -> Result<(), Error> {
    if recovery(table, token, source)? == Recovery::None {
        return Ok(());
    }
    let mut leaves = IoBuffer::new();
    let mut directories = IoBuffer::try_with_capacity(2)?;
    let mut staged_directories = IoBuffer::new();
    let root = opendir(TRANSACTION)?;
    let result = (|| {
        let mut name = [0; 255];
        while let Some((_, kind, length)) = readdir(root, &mut name)? {
            let name = &name[..length];
            if name == b"new" || name == b"old" {
                let path = if name == b"new" { NEW } else { OLD };
                private_directory(path)?;
                let directory = opendir(path)?;
                let result = (|| {
                    let mut child = [0; 255];
                    while let Some((_, kind, length)) = readdir(directory, &mut child)? {
                        let child = &child[..length];
                        if child.len() != 8
                            || !child.iter().all(u8::is_ascii_hexdigit)
                        {
                            return Err(Error::InvalidState);
                        }
                        validate_discard_leaf_count(leaves.len())?;
                        let mut full = [0; 80];
                        full[..path.len()].copy_from_slice(path);
                        full[path.len()] = b'/';
                        full[path.len() + 1..path.len() + 9].copy_from_slice(child);
                        let full = &full[..path.len() + 9];
                        if kind == 4 {
                            if staged_directories.len() >= MAX_ACTIONS {
                                return Err(Error::InvalidState);
                            }
                            let directory = opendir(full)?;
                            let next = readdir(directory, &mut [0; 255]);
                            closedir(directory)?;
                            if next?.is_some() {
                                return Err(Error::InvalidState);
                            }
                            staged_directories.try_push(own_metadata(full)?)?;
                        } else {
                            push_discard_leaf(&mut leaves, full)?;
                        }
                    }
                    Ok(())
                })();
                closedir(directory)?;
                result?;
                directories.push(path);
            } else {
                let path = match name {
                    b"before" => BEFORE,
                    b"after" => AFTER,
                    b"pending" => PENDING,
                    b"active" => ACTIVE,
                    b"rolled-back" => ROLLED_BACK,
                    b"status" => STATUS,
                    _ => return Err(Error::InvalidState),
                };
                if kind != 8 {
                    return Err(Error::InvalidState);
                }
                push_discard_leaf(&mut leaves, path)?;
            }
        }
        Ok(())
    })();
    closedir(root)?;
    result?;
    match unlink(STATUS) {
        Ok(()) | Err(Errno::ENOENT) => {}
        Err(error) => return Err(error.into()),
    }
    sync_persistence()?;
    for path in leaves {
        if path.as_ref() != STATUS {
            unlink(&path)?;
        }
    }
    for path in staged_directories {
        rmdir(&path)?;
    }
    for path in directories {
        rmdir(path)?;
    }
    rmdir(TRANSACTION)?;
    sync_persistence()?;
    Ok(())
}

pub(super) fn push_discard_leaf(
    leaves: &mut IoBuffer<OwnedMetadata>,
    path: &[u8],
) -> Result<(), Error> {
    validate_discard_leaf_count(leaves.len())?;
    leaves.try_push(own_metadata(path)?)?;
    Ok(())
}

pub(super) fn validate_discard_leaf_count(count: usize) -> Result<(), Error> {
    if count >= MAX_ACTIONS * 2 + 6 { Err(Error::InvalidState) } else { Ok(()) }
}

#[cfg(test)]
mod inventory_range_tests {
    use super::*;

    #[test]
    fn inventory_ranges_refuse_foreign_and_out_of_bounds_slices() {
        let bytes = b"0123456789abcdef";
        for field in [&bytes[..2], &bytes[7..10], &bytes[12..]] {
            assert!(matches!(InventoryRange::capture(&bytes[2..8], field), Err(Errno::EIO)));
        }
        let range = InventoryRange::capture(bytes, &bytes[3..9]).unwrap();
        assert_eq!(range.view(bytes), b"345678");
        let empty = InventoryRange::capture(bytes, &bytes[bytes.len()..]).unwrap();
        assert!(empty.view(bytes).is_empty());
    }

    #[test]
    fn indexed_files_retain_metadata_without_allocating_or_borrowing_old_backing_addresses() {
        let original = b"prefix/bin/program:provider-bytes:symlink-target".to_vec();
        let path = &original[6..18];
        let provider = &original[19..33];
        let target = &original[34..];
        let inputs = [
            File { path, package: 0, mode: 0o6755, uid: 12, gid: 34,
                content: Content::Regular { size: 400, digest: [7; 32] } },
            File { path, package: 0, mode: 0o4750, uid: 12, gid: 34,
                content: Content::Deferred { size: 400, digest: [7; 32], provider } },
            File { path, package: 0, mode: 0o777, uid: 12, gid: 34, content: Content::Symlink(target) },
            File { path, package: 0, mode: 0o2750, uid: 12, gid: 34, content: Content::Directory },
        ];
        let baseline_io = crate::io_buffer::IO_MEMORY.usage().0;
        let baseline_packages = crate::metadata_budget::PACKAGE_METADATA.usage().0;
        let baseline_namespace = ROOTFS_METADATA.usage().0;
        let copied = original.clone();
        {
            let _quota = crate::io_buffer::test_budget(baseline_io);
            for expected in inputs {
                let indexed = IndexedFile::capture(&original, expected).unwrap();
                let actual = indexed.view(&copied);
                assert_eq!(actual, expected);
                assert_eq!(actual.path.as_ptr(), copied[6..].as_ptr());
                assert_ne!(actual.path.as_ptr(), original[6..].as_ptr());
                if let Content::Deferred { provider, .. } = actual.content {
                    assert_eq!(provider.as_ptr(), copied[19..].as_ptr());
                }
            }
        }
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline_io);
        assert_eq!(crate::metadata_budget::PACKAGE_METADATA.usage().0, baseline_packages);
        assert_eq!(ROOTFS_METADATA.usage().0, baseline_namespace);
        let indexed = IndexedFile::capture(&original, inputs[1]).unwrap();
        drop(original);
        assert_eq!(indexed.view(&copied).path, b"/bin/program");
        assert_eq!(indexed.view(&copied).content.file_identity(), Some((400, [7; 32])));
    }

    #[test]
    fn action_views_select_the_correct_immutable_inventory_for_each_phase() {
        let before = b"/same/old-target";
        let after = b"prefix/same/new-target";
        let old = File { path: &before[..5], package: 0, mode: 0o755, uid: 12, gid: 34,
            content: Content::Symlink(&before[5..]) };
        let new = File { path: &after[6..11], package: 0, mode: 0o750, uid: 56, gid: 78,
            content: Content::Symlink(&after[11..]) };
        let action = Action {
            before: Some(IndexedFile::capture(before, old).unwrap()),
            after: Some(IndexedFile::capture(after, new).unwrap()),
            live: None, staged: None,
        };
        assert_eq!(action.path(before, after), b"/same");
        for phase in [Phase::Pending, Phase::RolledBack] {
            assert_eq!(action.source(phase, before, after), Some(old));
            assert_eq!(action.destination(phase, before, after), Some(new));
        }
        assert_eq!(action.source(Phase::Active, before, after), Some(new));
        assert_eq!(action.destination(Phase::Active, before, after), Some(old));
        let added = Action { before: None, ..action };
        assert_eq!(added.path(before, after).as_ptr(), after[6..].as_ptr());
        assert!(added.source(Phase::Pending, before, after).is_none());
        let removed_directory = Action {
            before: Some(IndexedFile::capture(before, File { content: Content::Directory, ..old }).unwrap()),
            after: None, live: None, staged: None,
        };
        assert!(removed_directory.is_directory());
        assert_eq!(removed_directory.source(Phase::Active, before, after).unwrap().content, Content::Directory);
    }
}

pub struct Upgrade {
    before: IoBuffer<u8>,
    after: IoBuffer<u8>,
    before_digest: [u8; 32],
    after_digest: [u8; 32],
    actions: IoBuffer<Action>,
    maintenance: u64,
    phase: Phase,
    prepared: bool,
    live_cursor: usize,
    staged_cursor: usize,
    checking: Option<FileVerification>,
    installed: VerifiedFile,
    controls: IoBuffer<VerifiedFile>,
}

impl Upgrade {
    fn plan(
        before: IoBuffer<u8>,
        after: IoBuffer<u8>,
        phase: Phase,
        table: &ProcessTable,
        token: &MaintenanceToken,
        current_abi: u32,
        current_digest: [u8; 32],
        source: &mut Source<'_>,
    ) -> Result<Self, Error> {
        let old = Inventory::decode(&before)?;
        let next = Inventory::decode(&after)?;
        if phase == Phase::Active {
            old.check_runtime(current_abi, current_digest)?;
        } else {
            next.check_runtime(current_abi, current_digest)?;
        }
        if old.digest() == next.digest() {
            return Err(Errno::EALREADY.into());
        }
        let count = old.changes(&next).count();
        if count > MAX_ACTIONS {
            return Err(Errno::E2BIG.into());
        }
        let before_bytes = before.as_slice();
        let after_bytes = after.as_slice();
        let mut actions = crate::package_inventory::metadata_with_capacity(count)?;
        for change in old.changes(&next) {
            let (before, after) = match change {
                Change::Added(file) => (None, Some(file)),
                Change::Removed(file) => (Some(file), None),
                Change::Replaced { before, after } => {
                    if (before.content == Content::Directory)
                        != (after.content == Content::Directory)
                    {
                        return Err(Error::UnsupportedPath);
                    }
                    (Some(before), Some(after))
                }
            };
            actions.push(Action {
                before: before.map(|file| IndexedFile::capture(before_bytes, file)).transpose()?,
                after: after.map(|file| IndexedFile::capture(after_bytes, file)).transpose()?,
                live: None,
                staged: None,
            });
        }
        let before_digest = old.digest();
        let after_digest = next.digest();
        drop(old);
        drop(next);
        let installed_bytes = if phase == Phase::Active {
            &after
        } else {
            &before
        };
        let expected = File {
            path: INSTALLED,
            package: 0,
            mode: 0o600,
            uid: 0,
            gid: 0,
            content: Content::Regular {
                size: installed_bytes.len() as u64,
                digest: Sha256::digest(installed_bytes.as_ref()).into(),
            },
        };
        let mut verification = FileVerification::begin_at(&expected, INSTALLED, table, token)?;
        while !verification.is_complete() {
            verification.read_more(table, token, CHUNK_BYTES, &mut *source)?;
        }
        let installed = verification.finish(table, token)?;
        Ok(Self {
            before,
            after,
            before_digest,
            after_digest,
            actions,
            maintenance: table.maintenance_identity(token)?,
            phase,
            prepared: false,
            live_cursor: 0,
            staged_cursor: 0,
            checking: None,
            installed,
            controls: IoBuffer::new(),
        })
    }

    pub fn begin(
        incoming: &[u8],
        table: &ProcessTable,
        token: &MaintenanceToken,
        current_abi: u32,
        current_digest: [u8; 32],
        source: &mut Source<'_>,
    ) -> Result<Self, Error> {
        require(table, token)?;
        private_directory(STATE_ROOT)?;
        if recovery(table, token, source)? != Recovery::None {
            return Err(Errno::EBUSY.into());
        }
        if incoming.len() > MAX_BYTES {
            return Err(Errno::E2BIG.into());
        }
        let before = read_bounded(INSTALLED, MAX_BYTES, source)?;
        Self::plan(
            before,
            copy_bytes(incoming)?,
            Phase::Pending,
            table,
            token,
            current_abi,
            current_digest,
            source,
        )
    }

    pub fn resume(
        table: &ProcessTable,
        token: &MaintenanceToken,
        current_abi: u32,
        current_digest: [u8; 32],
        source: &mut Source<'_>,
    ) -> Result<Self, Error> {
        let Recovery::Transaction(phase) = recovery(table, token, source)? else {
            return Err(Error::InvalidState);
        };
        if phase == Phase::RolledBack {
            return Err(Errno::EALREADY.into());
        }
        private_directory(NEW)?;
        private_directory(OLD)?;
        let mut upgrade = Self::plan(
            read_bounded(BEFORE, MAX_BYTES, source)?,
            read_bounded(AFTER, MAX_BYTES, source)?,
            phase,
            table,
            token,
            current_abi,
            current_digest,
            source,
        )?;
        upgrade.prepared = true;
        upgrade.bind_controls(table, token, source)?;
        Ok(upgrade)
    }

    fn bind_controls(
        &mut self,
        table: &ProcessTable,
        token: &MaintenanceToken,
        source: &mut Source<'_>,
    ) -> Result<(), Error> {
        let pending = record(Phase::Pending, self.before_digest, self.after_digest);
        let active = record(Phase::Active, self.before_digest, self.after_digest);
        let rolled_back = record(Phase::RolledBack, self.before_digest, self.after_digest);
        let status = match self.phase {
            Phase::Pending => &pending,
            Phase::Active => &active,
            Phase::RolledBack => &rolled_back,
        };
        let mut controls = IoBuffer::try_with_capacity(6)?;
        for (path, bytes) in [
            (BEFORE, self.before.as_ref()),
            (AFTER, self.after.as_ref()),
            (PENDING, &pending),
            (ACTIVE, &active),
            (ROLLED_BACK, &rolled_back),
            (STATUS, status),
        ] {
            let expected = File {
                path,
                package: 0,
                mode: 0o600,
                uid: 0,
                gid: 0,
                content: Content::Regular {
                    size: bytes.len() as u64,
                    digest: Sha256::digest(bytes).into(),
                },
            };
            let mut verification = FileVerification::begin_at(&expected, path, table, token)?;
            while !verification.is_complete() {
                verification.read_more(table, token, CHUNK_BYTES, &mut *source)?;
            }
            controls.push(verification.finish(table, token)?);
        }
        self.controls = controls;
        Ok(())
    }

    fn authorized(&self, table: &ProcessTable, token: &MaintenanceToken) -> Result<(), Error> {
        require(table, token)?;
        if table.maintenance_identity(token)? != self.maintenance {
            return Err(Errno::EPERM.into());
        }
        self.installed.revalidate(table, token)?;
        if self.prepared {
            if self.controls.len() != 6 {
                return Err(Error::InvalidState);
            }
            for control in &self.controls {
                control.revalidate(table, token)?;
            }
        }
        Ok(())
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn action_count(&self) -> usize {
        self.actions.len()
    }
    pub fn progress(&self) -> Progress<'_> {
        let current = if self.live_cursor < self.actions.len() {
            Some((
                VerificationTarget::Installed,
                self.actions[self.live_cursor].path(&self.before, &self.after),
            ))
        } else if self.staged_cursor < self.actions.len() {
            Some((
                VerificationTarget::Staged,
                self.actions[self.staged_cursor].path(&self.before, &self.after),
            ))
        } else {
            None
        };
        Progress {
            phase: self.phase,
            changed_files: self.actions.len(),
            installed_files_verified: self.live_cursor,
            staged_files_verified: self.staged_cursor,
            current,
            verified_bytes: self
                .checking
                .as_ref()
                .map_or(0, FileVerification::verified_bytes),
            total_bytes: self
                .checking
                .as_ref()
                .map_or(0, FileVerification::total_bytes),
        }
    }
    pub fn staging_file(&self, index: usize) -> Result<Option<StagingFile<'_>>, Error> {
        if self.phase != Phase::Pending {
            return Err(Errno::EBUSY.into());
        }
        let action = self.actions.get(index).ok_or(Errno::EINVAL)?;
        Ok(action.after.as_ref().map(|file| StagingFile {
            path: file.path.view(&self.after),
            upload_size: match file.content {
                IndexedContent::Regular { size, .. } => Some(size),
                _ => None,
            },
        }))
    }
    pub fn action_path(&self, index: usize) -> Result<&[u8], Error> {
        Ok(self.actions.get(index).ok_or(Errno::EINVAL)?.path(&self.before, &self.after))
    }

    pub fn verify_next(
        &mut self,
        table: &ProcessTable,
        token: &MaintenanceToken,
        maximum_bytes: usize,
        source: &mut Source<'_>,
    ) -> Result<bool, Error> {
        self.authorized(table, token)?;
        if self.live_cursor == self.actions.len() {
            return Ok(true);
        }
        let action = &mut self.actions[self.live_cursor];
        if self.checking.is_none() {
            if let Some(file) = action.source(self.phase, &self.before, &self.after) {
                self.checking = Some(FileVerification::begin(&file, table, token)?);
            } else {
                action.live = Some(VerifiedFile::verify_absence(action.path(&self.before, &self.after), table, token)?);
                self.live_cursor += 1;
                return Ok(self.live_cursor == self.actions.len());
            }
        }
        let verification = self.checking.as_mut().ok_or(Error::InvalidState)?;
        if verification.read_more(table, token, maximum_bytes, source)? {
            action.live = Some(self.checking.take().unwrap().finish(table, token)?);
            self.live_cursor += 1;
        }
        Ok(self.live_cursor == self.actions.len())
    }

    pub fn prepare(
        &mut self,
        table: &ProcessTable,
        token: &MaintenanceToken,
        source: &mut Source<'_>,
    ) -> Result<(), Error> {
        self.authorized(table, token)?;
        if self.prepared || self.phase != Phase::Pending || self.live_cursor != self.actions.len() {
            return Err(Errno::EBUSY.into());
        }
        for action in &self.actions {
            action
                .live
                .as_ref()
                .ok_or(Error::InvalidState)?
                .revalidate(table, token)?;
        }
        mkdir(TRANSACTION, 0o700, 0, 0)?;
        mkdir(NEW, 0o700, 0, 0)?;
        mkdir(OLD, 0o700, 0, 0)?;
        create_bytes(BEFORE, &self.before, source)?;
        create_bytes(AFTER, &self.after, source)?;
        for (path, phase) in [
            (PENDING, Phase::Pending),
            (ACTIVE, Phase::Active),
            (ROLLED_BACK, Phase::RolledBack),
        ] {
            create_bytes(
                path,
                &record(phase, self.before_digest, self.after_digest),
                source,
            )?;
        }
        sync_persistence()?;
        link(PENDING, STATUS)?;
        sync_persistence()?;
        self.prepared = true;
        self.bind_controls(table, token, source)?;
        Ok(())
    }

    pub fn restart_staging_file(
        &mut self,
        index: usize,
        table: &ProcessTable,
        token: &MaintenanceToken,
    ) -> Result<(), Error> {
        self.authorized(table, token)?;
        if !self.prepared
            || self.phase != Phase::Pending
            || self.staged_cursor != 0
            || self.checking.is_some()
        {
            return Err(Errno::EBUSY.into());
        }
        if self
            .actions
            .get(index)
            .and_then(|action| action.after.as_ref())
            .is_none()
        {
            return Err(Errno::EINVAL.into());
        }
        let action = self.actions.get(index).ok_or(Errno::EINVAL)?;
        if action.is_directory() && !action.adds_directory() {
            return Ok(());
        }
        let result = if action.is_directory() {
            rmdir(&staged_path(index, self.phase)?)
        } else {
            unlink(&staged_path(index, self.phase)?)
        };
        match result {
            Ok(()) | Err(Errno::ENOENT) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub fn stage(
        &mut self,
        index: usize,
        offset: u64,
        bytes: &[u8],
        table: &ProcessTable,
        token: &MaintenanceToken,
        source: &mut Source<'_>,
    ) -> Result<usize, Error> {
        self.authorized(table, token)?;
        if !self.prepared
            || self.phase != Phase::Pending
            || self.checking.is_some()
            || self.staged_cursor != 0
            || self.live_cursor != self.actions.len()
        {
            return Err(Errno::EBUSY.into());
        }
        let action = self.actions.get(index).ok_or(Errno::EINVAL)?;
        let file = action.after.as_ref().ok_or(Errno::EINVAL)?.view(&self.after);
        let path = staged_path(index, self.phase)?;
        match &file.content {
            Content::Directory => {
                if offset != 0 || !bytes.is_empty() {
                    return Err(Errno::EINVAL.into());
                }
                if action.adds_directory() {
                    mkdir(&path, file.mode, file.uid, file.gid)?;
                }
                Ok(0)
            }
            Content::Regular { size, .. } => {
                if bytes.len() > CHUNK_BYTES
                    || offset
                        .checked_add(bytes.len() as u64)
                        .is_none_or(|end| end > *size)
                {
                    return Err(Errno::EINVAL.into());
                }
                if offset == 0 {
                    let handle = open(&path, O_WRONLY | O_CREAT | O_EXCL, 0o600, 0, 0)?;
                    release_handle(handle);
                } else if lstat(&path)?.st_size != offset {
                    return Err(Errno::EINVAL.into());
                }
                let handle = open(&path, O_WRONLY, 0, 0, 0)?;
                let result = write(handle, offset as i64, bytes, source);
                release_handle(handle);
                let count = result?;
                if offset + count as u64 == *size {
                    chown(&path, file.uid, file.gid, false)?;
                    chmod(&path, file.mode)?;
                    sync_persistence()?;
                }
                Ok(count)
            }
            Content::Deferred { provider, .. } => {
                if offset != 0 || !bytes.is_empty() {
                    return Err(Errno::EINVAL.into());
                }
                if let Some(before) = &action.before {
                    if before.view(&self.before).content.file_identity() == file.content.file_identity()
                    {
                        let local = ROOTFS.with(|state| {
                            let root = state.mount_root()?;
                            let index = state.walk(root, &split_components(action.path(&self.before, &self.after)))?;
                            Ok::<_, Errno>(matches!(
                                state.get(index).ok_or(Errno::EIO)?.kind,
                                InodeKind::PersistentRegular
                                    | InodeKind::Regular(_)
                                    | InodeKind::BaseRegular {
                                        source: BaseSource::Image,
                                        ..
                                    }
                            ))
                        })?;
                        if local {
                            if (before.mode, before.uid, before.gid)
                                != (file.mode, file.uid, file.gid)
                            {
                                return Err(Error::UnsupportedPath);
                            }
                            action
                                .live
                                .as_ref()
                                .ok_or(Error::InvalidState)?
                                .revalidate(table, token)?;
                            link(action.path(&self.before, &self.after), &path)?;
                            sync_persistence()?;
                            return Ok(0);
                        }
                    }
                }
                let provider = provider_record::remap_for_staging(provider)?;
                stage_persistent_deferred_file(&path, &provider, file.mode, file.uid, file.gid)?;
                Ok(0)
            }
            Content::Symlink(target) => {
                if offset != 0 || !bytes.is_empty() {
                    return Err(Errno::EINVAL.into());
                }
                symlink(target, &path, file.uid, file.gid)?;
                chmod(&path, file.mode)?;
                Ok(0)
            }
        }
    }

    pub fn verify_staged_next(
        &mut self,
        table: &ProcessTable,
        token: &MaintenanceToken,
        maximum_bytes: usize,
        source: &mut Source<'_>,
    ) -> Result<bool, Error> {
        self.authorized(table, token)?;
        if !self.prepared || self.live_cursor != self.actions.len() {
            return Err(Errno::EBUSY.into());
        }
        if self.staged_cursor == self.actions.len() {
            return Ok(true);
        }
        let action = &mut self.actions[self.staged_cursor];
        if action.is_directory() && !(action.adds_directory() && self.phase == Phase::Pending) {
            self.staged_cursor += 1;
            return Ok(self.staged_cursor == self.actions.len());
        }
        let Some(file) = action.destination(self.phase, &self.before, &self.after) else {
            self.staged_cursor += 1;
            return Ok(self.staged_cursor == self.actions.len());
        };
        if self.checking.is_none() {
            self.checking = Some(FileVerification::begin_at(
                &file,
                &staged_path(self.staged_cursor, self.phase)?,
                table,
                token,
            )?);
        }
        if self
            .checking
            .as_mut()
            .unwrap()
            .read_more(table, token, maximum_bytes, source)?
        {
            action.staged = Some(self.checking.take().unwrap().finish(table, token)?);
            self.staged_cursor += 1;
        }
        Ok(self.staged_cursor == self.actions.len())
    }

    pub fn commit(&mut self, table: &ProcessTable, token: &MaintenanceToken) -> Result<(), Error> {
        self.authorized(table, token)?;
        if !self.prepared
            || self.phase == Phase::RolledBack
            || self.live_cursor != self.actions.len()
            || self.staged_cursor != self.actions.len()
            || self.checking.is_some()
        {
            return Err(Errno::EBUSY.into());
        }
        sync_persistence()?;
        if self.controls.len() != 6 {
            return Err(Error::InvalidState);
        }
        for control in &self.controls {
            control.revalidate(table, token)?;
        }
        let mut names = crate::package_inventory::metadata_with_capacity(
            self.actions
                .len()
                .checked_mul(3)
                .and_then(|count| count.checked_add(2))
                .ok_or(Errno::ENOMEM)?,
        )?;
        let mut directory_metadata = crate::package_inventory::metadata_with_capacity(self.actions.len())?;
        for (index, action) in self.actions.iter().enumerate() {
            let live = action.live.as_ref().ok_or(Error::InvalidState)?;
            live.revalidate(table, token)?;
            if let Some(staged) = &action.staged {
                staged.revalidate(table, token)?;
            }
            if action.is_directory() {
                if action.adds_directory() && self.phase == Phase::Pending {
                    let ino = action
                        .staged
                        .as_ref()
                        .and_then(VerifiedFile::inode)
                        .ok_or(Error::InvalidState)?;
                    names.push((ActivationPath::Borrowed(action.path(&self.before, &self.after)), None, Some(ino)));
                    names.push((ActivationPath::Borrowed(action.staged.as_ref().unwrap().path()), Some(ino), None));
                } else if let (Some(source), Some(destination)) =
                    (action.source(self.phase, &self.before, &self.after), action.destination(self.phase, &self.before, &self.after))
                {
                    let expected = (source.mode, source.uid, source.gid);
                    let replacement = (destination.mode, destination.uid, destination.gid);
                    if expected != replacement {
                        directory_metadata.push(
                            namespace_activation::DirectoryMetadataReplacement {
                                ino: live.inode().ok_or(Error::InvalidState)?,
                                expected,
                                replacement,
                            },
                        );
                    }
                }
                continue;
            }
            let replacement = action.staged.as_ref().and_then(VerifiedFile::inode);
            if live.inode() != replacement {
                names.push((ActivationPath::Borrowed(action.path(&self.before, &self.after)), live.inode(), replacement));
            }
            if let Some(staged) = &action.staged {
                if let Some(ino) = staged.inode() {
                    names.push((ActivationPath::Borrowed(staged.path()), Some(ino), None));
                }
            }
            if self.phase == Phase::Pending && action.before.is_some() {
                let path = staged_path(index, Phase::Active)?;
                match lstat(&path) {
                    Err(Errno::ENOENT) => {}
                    Err(error) => return Err(error.into()),
                    Ok(_) => return Err(Errno::EEXIST.into()),
                }
                names.push((ActivationPath::Private(path), None, live.inode()));
            }
        }
        let replacement_inventory = if self.phase == Phase::Active {
            BEFORE
        } else {
            AFTER
        };
        names.push((
            ActivationPath::Borrowed(INSTALLED),
            self.installed.inode(),
            Some(lstat(replacement_inventory)?.st_ino),
        ));
        let next_phase = if self.phase == Phase::Active {
            Phase::RolledBack
        } else {
            Phase::Active
        };
        let marker = if next_phase == Phase::Active {
            ACTIVE
        } else {
            ROLLED_BACK
        };
        names.push((
            ActivationPath::Borrowed(STATUS),
            Some(lstat(STATUS)?.st_ino),
            Some(lstat(marker)?.st_ino),
        ));
        let mut parents = crate::package_inventory::metadata_with_capacity(names.len())?;
        for (path, expected, replacement) in &names {
            let path = path.as_ref();
            let offset = path
                .iter()
                .rposition(|byte| *byte == b'/')
                .ok_or(Errno::EINVAL)?;
            let parent = if offset == 0 {
                b"/".as_slice()
            } else {
                &path[..offset]
            };
            let parent_ino = match lstat(parent) {
                Ok(stat) if stat.st_mode & S_IFMT == S_IFDIR => stat.st_ino,
                Ok(_) => return Err(Errno::ENOTDIR.into()),
                Err(Errno::ENOENT) if self.phase == Phase::Pending => {
                    let position = self
                        .actions
                        .binary_search_by_key(&parent, |action| action.path(&self.before, &self.after))
                        .map_err(|_| Errno::ENOENT)?;
                    let action = &self.actions[position];
                    if !action.adds_directory() {
                        return Err(Errno::ENOENT.into());
                    }
                    action
                        .staged
                        .as_ref()
                        .and_then(VerifiedFile::inode)
                        .ok_or(Error::InvalidState)?
                }
                Err(error) => return Err(error.into()),
            };
            parents.push(namespace_activation::LeafReplacement {
                parent: parent_ino,
                name: &path[offset + 1..],
                expected: *expected,
                replacement: *replacement,
            });
        }
        parents.sort_unstable_by(|left, right| {
            (left.parent, left.name).cmp(&(right.parent, right.name))
        });
        directory_metadata.sort_unstable_by_key(|change| change.ino);
        persistent_statfs()?;
        let mut active = PERSISTENT_ROOTFS.lock();
        let mount = active.as_mut().ok_or(Errno::EIO)?;
        ROOTFS.with(|state| {
            namespace_activation::commit_upgrade(state, mount, &parents, &directory_metadata)
        })?;
        self.phase = next_phase;
        Ok(())
    }
}
