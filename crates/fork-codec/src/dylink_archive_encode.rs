//! Encoder for the KFLA dylink-fork archive memory image.
//!
//! The decoder in [`super`] was ported from `host/src/dylink-fork-archive.ts`'s
//! read path and had, until this module, no writer to pair with. That asymmetry
//! is what kept the 2,152-line TypeScript archive alive: a process that could
//! only *read* an archive still needed the TypeScript to *publish* one after
//! every `dlopen`, `dlclose`, and staged initialization step.
//!
//! # Why the encoder does not write memory
//!
//! Archive records live in GUEST linear memory, obtained from the process
//! allocator through `SYS_MMAP`. Neither this crate nor the standalone planner
//! module can address that memory: the planner imports nothing at all, and the
//! kernel reaches process memory only through channel scratch. So the encoder
//! is split in two, and the split is deliberate rather than a concession:
//!
//! 1. [`plan_dylink_archive`] says how many records there are and how large
//!    each one is. The caller allocates that many blocks.
//! 2. [`encode_dylink_archive`] takes the addresses the caller obtained and
//!    returns the exact bytes for each, with every `next` pointer and every
//!    header cursor already resolved.
//!
//! The caller therefore performs two mechanical operations — allocate, and
//! `Uint8Array.set` — and makes no layout, ordering, padding, digest, or
//! validity decision. All of those stay here, next to the decoder that enforces
//! them, which is the only way the two halves cannot drift.
//!
//! # Digests are computed, not carried
//!
//! [`super::DylinkModule::digest`] and [`super::DylinkTransaction::digest`] are
//! *as-stored* bytes on the decode side, because a decoder's job is to report
//! what the image says. On the encode side they are recomputed from
//! `module_bytes` with SHA-256, matching `computeForkModuleTemplateIdSync` in
//! `host/src/fork-module-state.ts`. Carrying a caller-supplied digest forward
//! would let a wrong one be published as if it were verified, which is exactly
//! the silent-success shape this project treats as a defect.

use alloc::vec::Vec;
use sha2::{Digest, Sha256};
use wasm_posix_shared::Errno;

use super::{
    align8, checked_end, DylinkArchive, DylinkInitializationStage, DylinkModule, DylinkTablePatch,
    DylinkTransaction, ARCHIVE_HEADER_SIZE, ARCHIVE_MAGIC, ARCHIVE_VERSION,
    EXHAUSTED_DYLINK_HANDLE, FIRST_DYLINK_HANDLE, MAX_SAFE_INTEGER, MAX_TABLE_PATCH_BYTES,
    MAX_TABLE_PATCH_RECORDS, MODULE_ALLOCATION_SIZE, MODULE_DIGEST_OFFSET, MODULE_DIGEST_SIZE,
    MODULE_FLAG_COMMITTED_GLOBAL_ROOT, MODULE_FLAG_GLOBAL, MODULE_FLAG_INITIALIZING,
    MODULE_HEADER_SIZE, MODULE_MAGIC, MODULE_VERSION, TABLE_PATCH_HEADER_SIZE, TABLE_PATCH_MAGIC,
    TABLE_PATCH_RUN_SIZE, TABLE_PATCH_VERSION, TRANSACTION_DIGEST_OFFSET, TRANSACTION_FLAG_GLOBAL,
    TRANSACTION_HEADER_SIZE, TRANSACTION_MAGIC, TRANSACTION_VERSION,
};

/// The storage one archive image needs, in the order
/// [`encode_dylink_archive`] expects addresses.
///
/// Index 0 is always the KFLA header. Then one entry per module, per
/// transaction, and per table patch, in the archive's own publication order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DylinkArchiveLayout {
    /// Byte size of every record, header first.
    pub sizes: Vec<u64>,
    pub module_count: usize,
    pub transaction_count: usize,
    pub table_patch_count: usize,
}

impl DylinkArchiveLayout {
    /// Total bytes across every record, for a caller that wants one block.
    pub fn total_bytes(&self) -> u64 {
        self.sizes.iter().copied().sum()
    }
}

/// One record's bytes and the address they belong at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DylinkArchiveRecord {
    pub address: u64,
    pub bytes: Vec<u8>,
}

/// SHA-256 of a side-module image, the value the KFLM/KFLT digest field holds.
///
/// Mirrors `computeForkModuleTemplateIdSync`, which is plain SHA-256 over the
/// module bytes — the TypeScript spells the padding out by hand because it has
/// no hash primitive, not because the algorithm differs.
pub fn dylink_module_template_digest(module_bytes: &[u8]) -> [u8; MODULE_DIGEST_SIZE] {
    let mut hasher = Sha256::new();
    hasher.update(module_bytes);
    let digest = hasher.finalize();
    let mut out = [0u8; MODULE_DIGEST_SIZE];
    out.copy_from_slice(&digest);
    out
}

fn module_record_size(module: &DylinkModule) -> Result<u64, Errno> {
    let name_len = u64::try_from(module.name.len()).map_err(|_| Errno::EINVAL)?;
    let bytes_len = u64::try_from(module.module_bytes.len()).map_err(|_| Errno::EINVAL)?;
    let provider_len = provider_blob_len(&module.provider_dependencies)?;
    let allocation_len = u64::try_from(module.allocations.len())
        .map_err(|_| Errno::EINVAL)?
        .checked_mul(MODULE_ALLOCATION_SIZE)
        .ok_or(Errno::EINVAL)?;
    let mut size = MODULE_HEADER_SIZE;
    size = checked_end(size, align8(name_len)?)?;
    size = checked_end(size, align8(bytes_len)?)?;
    size = checked_end(size, align8(provider_len)?)?;
    checked_end(size, allocation_len)
}

fn transaction_record_size(transaction: &DylinkTransaction) -> Result<u64, Errno> {
    let name_len = u64::try_from(transaction.name.len()).map_err(|_| Errno::EINVAL)?;
    let bytes_len = u64::try_from(transaction.module_bytes.len()).map_err(|_| Errno::EINVAL)?;
    // Deliberately NOT padded: `read_transaction` computes
    // `TRANSACTION_HEADER_SIZE + align8(name) + bytes_length`, with the module
    // bytes trailing the record unaligned.
    let size = checked_end(TRANSACTION_HEADER_SIZE, align8(name_len)?)?;
    checked_end(size, bytes_len)
}

fn table_patch_record_size(patch: &DylinkTablePatch) -> Result<u64, Errno> {
    let runs = u64::try_from(patch.runs.len()).map_err(|_| Errno::EINVAL)?;
    let payload = runs.checked_mul(TABLE_PATCH_RUN_SIZE).ok_or(Errno::EINVAL)?;
    checked_end(TABLE_PATCH_HEADER_SIZE, payload)
}

fn provider_blob_len(names: &[alloc::string::String]) -> Result<u64, Errno> {
    let mut total = 0u64;
    for name in names {
        let len = u64::try_from(name.len()).map_err(|_| Errno::EINVAL)?;
        if len == 0 {
            return Err(Errno::EINVAL);
        }
        total = checked_end(total, 4)?;
        total = checked_end(total, len)?;
    }
    Ok(total)
}

/// Say how much storage the archive needs, record by record.
///
/// This runs every structural precondition the decoder would later enforce, so
/// a caller cannot allocate for an archive that could never be read back.
pub fn plan_dylink_archive(archive: &DylinkArchive) -> Result<DylinkArchiveLayout, Errno> {
    validate_archive(archive)?;
    let mut sizes = Vec::with_capacity(
        1 + archive.modules.len() + archive.transactions.len() + archive.table_patches.len(),
    );
    sizes.push(ARCHIVE_HEADER_SIZE);
    for module in &archive.modules {
        sizes.push(module_record_size(module)?);
    }
    for transaction in &archive.transactions {
        sizes.push(transaction_record_size(transaction)?);
    }
    for patch in &archive.table_patches {
        sizes.push(table_patch_record_size(patch)?);
    }
    Ok(DylinkArchiveLayout {
        sizes,
        module_count: archive.modules.len(),
        transaction_count: archive.transactions.len(),
        table_patch_count: archive.table_patches.len(),
    })
}

/// Encode the archive into per-record byte images at `addresses`.
///
/// `addresses` must be exactly what [`plan_dylink_archive`] asked for, in the
/// same order: header, modules, transactions, table patches. Every `next`
/// pointer, the header's four cursors, and the declared byte and record counts
/// are resolved here from those addresses.
pub fn encode_dylink_archive(
    archive: &DylinkArchive,
    addresses: &[u64],
) -> Result<Vec<DylinkArchiveRecord>, Errno> {
    let layout = plan_dylink_archive(archive)?;
    if addresses.len() != layout.sizes.len() {
        return Err(Errno::EINVAL);
    }
    for (address, size) in addresses.iter().zip(&layout.sizes) {
        if *address == 0 || checked_end(*address, *size)? > MAX_SAFE_INTEGER {
            return Err(Errno::EINVAL);
        }
    }

    let module_base = 1;
    let transaction_base = module_base + layout.module_count;
    let table_patch_base = transaction_base + layout.transaction_count;

    let next_of = |index: usize, end: usize| -> u64 {
        if index + 1 < end {
            addresses[index + 1]
        } else {
            0
        }
    };

    let mut records = Vec::with_capacity(addresses.len());

    // --- Header ---------------------------------------------------------
    let mut header = Writer::new(ARCHIVE_HEADER_SIZE);
    header.u32(ARCHIVE_MAGIC);
    header.u16(ARCHIVE_VERSION);
    header.u16(ARCHIVE_HEADER_SIZE as u16);
    header.u8(archive.pointer_width);
    header.zeros(7);
    header.u64(archive.next_handle);
    header.u32(u32::try_from(layout.module_count).map_err(|_| Errno::EINVAL)?);
    header.u32(0); // header flags
    header.u64(if layout.module_count == 0 {
        0
    } else {
        addresses[module_base]
    });
    header.u64(archive.generation);
    header.u64(archive.table_state_root);
    let first_patch = if layout.table_patch_count == 0 {
        0
    } else {
        addresses[table_patch_base]
    };
    let last_patch = if layout.table_patch_count == 0 {
        0
    } else {
        addresses[table_patch_base + layout.table_patch_count - 1]
    };
    header.u64(first_patch);
    header.u64(last_patch);
    header.u32(u32::try_from(layout.table_patch_count).map_err(|_| Errno::EINVAL)?);
    let declared_patch_bytes: u64 = layout.sizes[table_patch_base..]
        .iter()
        .copied()
        .try_fold(0u64, |total, size| checked_end(total, size))?;
    if declared_patch_bytes > MAX_TABLE_PATCH_BYTES as u64 {
        return Err(Errno::EINVAL);
    }
    header.u32(declared_patch_bytes as u32);
    header.u64(archive.table_checkpoint_generation);
    header.u32(u32::try_from(layout.transaction_count).map_err(|_| Errno::EINVAL)?);
    header.u32(0); // transaction flags
    header.u64(if layout.transaction_count == 0 {
        0
    } else {
        addresses[transaction_base]
    });
    records.push(DylinkArchiveRecord {
        address: addresses[0],
        bytes: header.finish(ARCHIVE_HEADER_SIZE)?,
    });

    // --- Modules --------------------------------------------------------
    for (offset, module) in archive.modules.iter().enumerate() {
        let index = module_base + offset;
        let size = layout.sizes[index];
        let mut w = Writer::new(size);
        let name = module.name.as_bytes();
        let bytes = module.module_bytes.as_slice();
        let provider_len = provider_blob_len(&module.provider_dependencies)?;
        let allocation_bytes = u64::try_from(module.allocations.len())
            .map_err(|_| Errno::EINVAL)?
            .checked_mul(MODULE_ALLOCATION_SIZE)
            .ok_or(Errno::EINVAL)?;

        let mut flags = 0u32;
        if module.initialization.is_some() {
            flags |= MODULE_FLAG_INITIALIZING;
        }
        if module.global_visibility {
            flags |= MODULE_FLAG_GLOBAL;
        }
        if module.committed_global_root {
            flags |= MODULE_FLAG_COMMITTED_GLOBAL_ROOT;
        }

        w.u32(MODULE_MAGIC);
        w.u16(MODULE_VERSION);
        w.u16(MODULE_HEADER_SIZE as u16);
        w.u64(next_of(index, transaction_base));
        w.u64(size);
        w.u64(module.memory_base);
        w.u64(module.table_base);
        w.u64(module.tls_base.unwrap_or(0));
        w.u32(module.activation_id.unwrap_or(0));
        w.u32(module.handle.unwrap_or(0));
        w.u32(module.ref_count.unwrap_or(0));
        w.u32(u32::try_from(name.len()).map_err(|_| Errno::EINVAL)?);
        w.u32(u32::try_from(bytes.len()).map_err(|_| Errno::EINVAL)?);
        w.u32(flags);
        // +72: digest, recomputed rather than carried.
        debug_assert_eq!(w.cursor, MODULE_DIGEST_OFFSET);
        w.bytes(&dylink_module_template_digest(bytes));
        w.u32(
            module
                .initialization
                .map(|init| init.transaction_token)
                .unwrap_or(0),
        );
        w.u32(
            module
                .initialization
                .map(|init| stage_code(init.stage))
                .unwrap_or(0),
        );
        w.u64(module.initialization.map(|init| init.table_index).unwrap_or(0));
        w.u32(u32::try_from(provider_len).map_err(|_| Errno::EINVAL)?);
        w.u32(u32::try_from(module.provider_dependencies.len()).map_err(|_| Errno::EINVAL)?);
        w.u32(u32::try_from(allocation_bytes).map_err(|_| Errno::EINVAL)?);
        w.u32(u32::try_from(module.allocations.len()).map_err(|_| Errno::EINVAL)?);
        debug_assert_eq!(w.cursor, MODULE_HEADER_SIZE);

        w.bytes(name);
        w.pad8();
        w.bytes(bytes);
        w.pad8();
        for dependency in &module.provider_dependencies {
            w.u32(u32::try_from(dependency.len()).map_err(|_| Errno::EINVAL)?);
            w.bytes(dependency.as_bytes());
        }
        w.pad8();
        for allocation in &module.allocations {
            w.u64(allocation.address);
            w.u64(allocation.size);
            w.u64(allocation.mapping_address);
            w.u64(allocation.mapping_size);
        }
        records.push(DylinkArchiveRecord {
            address: addresses[index],
            bytes: w.finish(size)?,
        });
    }

    // --- Transactions ---------------------------------------------------
    for (offset, transaction) in archive.transactions.iter().enumerate() {
        let index = transaction_base + offset;
        let size = layout.sizes[index];
        let mut w = Writer::new(size);
        let name = transaction.name.as_bytes();
        let bytes = transaction.module_bytes.as_slice();
        w.u32(TRANSACTION_MAGIC);
        w.u16(TRANSACTION_VERSION);
        w.u16(TRANSACTION_HEADER_SIZE as u16);
        w.u64(next_of(index, table_patch_base));
        w.u64(size);
        w.u32(transaction.token);
        w.u32(u32::try_from(name.len()).map_err(|_| Errno::EINVAL)?);
        w.u32(u32::try_from(bytes.len()).map_err(|_| Errno::EINVAL)?);
        w.u32(if transaction.global_visibility {
            TRANSACTION_FLAG_GLOBAL
        } else {
            0
        });
        debug_assert_eq!(w.cursor, TRANSACTION_DIGEST_OFFSET);
        w.bytes(&dylink_module_template_digest(bytes));
        // The KFLT header is 80 bytes and the digest ends at 72; the tail is
        // reserved and stays zero.
        w.zeros(TRANSACTION_HEADER_SIZE - w.cursor);
        debug_assert_eq!(w.cursor, TRANSACTION_HEADER_SIZE);
        w.bytes(name);
        w.pad8();
        w.bytes(bytes);
        records.push(DylinkArchiveRecord {
            address: addresses[index],
            bytes: w.finish(size)?,
        });
    }

    // --- Table patches --------------------------------------------------
    let patch_end = addresses.len();
    for (offset, patch) in archive.table_patches.iter().enumerate() {
        let index = table_patch_base + offset;
        let size = layout.sizes[index];
        let mut w = Writer::new(size);
        w.u32(TABLE_PATCH_MAGIC);
        w.u16(TABLE_PATCH_VERSION);
        w.u16(TABLE_PATCH_HEADER_SIZE as u16);
        w.u64(next_of(index, patch_end));
        w.u64(size);
        w.u64(patch.generation);
        w.u32(patch.activation_id);
        w.u32(patch.owner_id);
        w.u64(patch.start);
        w.u64(patch.table_length);
        w.u32(u32::try_from(patch.runs.len()).map_err(|_| Errno::EINVAL)?);
        w.u32(0); // reserved
        debug_assert_eq!(w.cursor, TABLE_PATCH_HEADER_SIZE);
        for run in &patch.runs {
            w.u64(run.length);
            match run.function {
                Some(function) => {
                    w.u32(1);
                    w.u32(function.activation_id);
                    w.u32(function.ordinal);
                }
                None => {
                    w.u32(0);
                    w.u32(0);
                    w.u32(0);
                }
            }
            w.u32(0); // reserved
        }
        records.push(DylinkArchiveRecord {
            address: addresses[index],
            bytes: w.finish(size)?,
        });
    }

    Ok(records)
}

fn stage_code(stage: DylinkInitializationStage) -> u32 {
    match stage {
        DylinkInitializationStage::Bootstrap => 1,
        DylinkInitializationStage::Relocations => 2,
        DylinkInitializationStage::Constructors => 3,
    }
}

/// The structural preconditions the decoder enforces, checked before a caller
/// allocates anything.
///
/// This is not defensive duplication: publishing an archive that
/// [`super::decode_dylink_archive`] would reject means a fork child cannot read
/// its own parent's loader state, and the failure would surface far from its
/// cause. Refusing at the writer is the truthful boundary.
fn validate_archive(archive: &DylinkArchive) -> Result<(), Errno> {
    if archive.pointer_width != 4 && archive.pointer_width != 8 {
        return Err(Errno::EINVAL);
    }
    if archive.generation == 0 {
        return Err(Errno::EINVAL);
    }
    if !(FIRST_DYLINK_HANDLE..=EXHAUSTED_DYLINK_HANDLE).contains(&archive.next_handle) {
        return Err(Errno::EINVAL);
    }
    if (archive.table_state_root == 0) != (archive.table_checkpoint_generation == 0)
        || archive.table_checkpoint_generation > archive.generation
    {
        return Err(Errno::EINVAL);
    }
    if archive.table_patches.len() > MAX_TABLE_PATCH_RECORDS as usize {
        return Err(Errno::EINVAL);
    }

    let mut previous_generation = archive.table_checkpoint_generation;
    for patch in &archive.table_patches {
        if patch.generation <= previous_generation || patch.generation > archive.generation {
            return Err(Errno::EINVAL);
        }
        previous_generation = patch.generation;
    }

    let mut names: Vec<&str> = Vec::with_capacity(archive.modules.len());
    for module in &archive.modules {
        if module.name.is_empty() || names.contains(&module.name.as_str()) {
            return Err(Errno::EINVAL);
        }
        names.push(module.name.as_str());
        // `read_module` pairs handle and refcount, and refuses a handle outside
        // `[FIRST_DYLINK_HANDLE, next_handle)`.
        match (module.handle, module.ref_count) {
            (None, None) => {}
            (Some(handle), Some(ref_count)) => {
                if ref_count == 0
                    || (handle as u64) < FIRST_DYLINK_HANDLE
                    || handle as u64 >= archive.next_handle
                {
                    return Err(Errno::EINVAL);
                }
            }
            _ => return Err(Errno::EINVAL),
        }
        if module.initialization.is_some() && module.handle.is_some() {
            return Err(Errno::EINVAL);
        }
        if let Some(initialization) = module.initialization {
            if initialization.transaction_token == 0 || initialization.table_index == 0 {
                return Err(Errno::EINVAL);
            }
        }
        // `decode_provider_dependencies` rejects anything not strictly
        // ascending, so an unsorted list here would produce an unreadable
        // archive.
        for pair in module.provider_dependencies.windows(2) {
            if pair[0] >= pair[1] {
                return Err(Errno::EINVAL);
            }
        }
        let mut previous_mapping_end = 0u64;
        for allocation in &module.allocations {
            if allocation.address == 0
                || allocation.size == 0
                || allocation.mapping_address == 0
                || allocation.mapping_size == 0
                || allocation.address < allocation.mapping_address
            {
                return Err(Errno::EINVAL);
            }
            let logical_end = checked_end(allocation.address, allocation.size)?;
            let mapping_end = checked_end(allocation.mapping_address, allocation.mapping_size)?;
            if logical_end > mapping_end || allocation.mapping_address < previous_mapping_end {
                return Err(Errno::EINVAL);
            }
            previous_mapping_end = mapping_end;
        }
    }

    let mut activations: Vec<u32> = Vec::new();
    for module in &archive.modules {
        if let Some(activation) = module.activation_id {
            if activations.contains(&activation) {
                return Err(Errno::EINVAL);
            }
            activations.push(activation);
        }
    }
    let mut handles: Vec<u32> = Vec::new();
    for module in &archive.modules {
        if let Some(handle) = module.handle {
            if handles.contains(&handle) {
                return Err(Errno::EINVAL);
            }
            handles.push(handle);
        }
    }

    // Referential closure: provider edges name present modules, and every
    // transaction is claimed by exactly one initializing module.
    for module in &archive.modules {
        for dependency in &module.provider_dependencies {
            if !names.contains(&dependency.as_str()) {
                return Err(Errno::EINVAL);
            }
        }
    }
    let mut tokens: Vec<u32> = Vec::with_capacity(archive.transactions.len());
    for transaction in &archive.transactions {
        if transaction.token == 0
            || transaction.name.is_empty()
            || transaction.module_bytes.is_empty()
            || tokens.contains(&transaction.token)
        {
            return Err(Errno::EINVAL);
        }
        tokens.push(transaction.token);
    }
    let mut claimed: Vec<u32> = Vec::new();
    for module in &archive.modules {
        if let Some(initialization) = module.initialization {
            if !tokens.contains(&initialization.transaction_token)
                || claimed.contains(&initialization.transaction_token)
            {
                return Err(Errno::EINVAL);
            }
            claimed.push(initialization.transaction_token);
        }
    }
    Ok(())
}

/// A little-endian byte writer with a fixed capacity.
///
/// Sized from the layout so an over- or under-run is caught by
/// [`Writer::finish`] rather than by a decoder much later.
struct Writer {
    buffer: Vec<u8>,
    cursor: u64,
}

impl Writer {
    fn new(capacity: u64) -> Self {
        Writer {
            buffer: alloc::vec![0u8; capacity as usize],
            cursor: 0,
        }
    }

    fn bytes(&mut self, value: &[u8]) {
        let start = self.cursor as usize;
        let end = start + value.len();
        if end <= self.buffer.len() {
            self.buffer[start..end].copy_from_slice(value);
        }
        self.cursor += value.len() as u64;
    }

    fn zeros(&mut self, count: u64) {
        self.cursor += count;
    }

    fn u8(&mut self, value: u8) {
        self.bytes(&[value]);
    }

    fn u16(&mut self, value: u16) {
        self.bytes(&value.to_le_bytes());
    }

    fn u32(&mut self, value: u32) {
        self.bytes(&value.to_le_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.bytes(&value.to_le_bytes());
    }

    /// Advance to the next 8-byte boundary. The buffer is zero-filled, so the
    /// padding needs no write.
    fn pad8(&mut self) {
        self.cursor = (self.cursor + 7) & !7;
    }

    fn finish(self, expected: u64) -> Result<Vec<u8>, Errno> {
        if self.cursor != expected || self.buffer.len() as u64 != expected {
            return Err(Errno::EINVAL);
        }
        Ok(self.buffer)
    }
}
