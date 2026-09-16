//! Per-record-kind payload decoders for the fork module-state (KFMS) arena.
//!
//! The KFMS structural envelope (`module_state::decode_module_state`) parses the
//! sealed chunk chain into record TLVs and exposes each record's kind, ownership
//! coordinates, and payload byte range, but treats the payload itself as opaque.
//! This module is the next layer: it turns the raw payload bytes of the
//! PURE-BYTE record kinds into typed, owned, fully validated structs that match
//! the host TypeScript decoders in `host/src/fork-module-state.ts`
//! field-for-field.
//!
//! Pure-byte record kinds decoded here (each is a self-contained byte layout the
//! child rebuilds without any live instance handle):
//!
//! * `Module` (kind 1) — `decodeModulePayload`: the 32-byte module template id
//!   plus a `u32` flags word (known flags: none) and a reserved `u32`.
//! * `MutableGlobal` (kind 3) — `decodeForkGlobalSnapshot`: an 8-byte header
//!   (value-type code, value size, two reserved fields) plus the raw global
//!   value bytes; reference globals also expose the leading `u32` recipe id.
//! * `Table` descriptor (kind 4) — `decodeTableDescriptor`: index width, page
//!   shift, sparse-override flags, page count, final/baseline lengths, and the
//!   32-byte deterministic baseline fingerprint.
//! * `TablePage` (kind 5) — `validateTablePage`/`decodeTablePage`: a page index
//!   and a run-length list of `u32` recipe-id overrides. This one needs its
//!   owning `Table` descriptor's page shift and final length as decode context;
//!   the recipe ids themselves are plain `u32` indices (their resolution to live
//!   references is the deferred half — see below).
//! * `ElementSegments` (kind 6) and `DataSegments` (kind 7) —
//!   `decodeSegmentBitmap`: a segment count and a dropped-segment bitmap.
//!
//! Every decoder is a bounds-checked, panic-free `&[u8] -> struct`; any framing
//! or consistency violation yields `Err(Errno::EINVAL)`, exactly the failure
//! mode of the corresponding TS decoder's `throw`.
//!
//! DEFERRED to the co-resident module (Phase 6 D5+), exactly as the prior
//! decoders deferred their live halves:
//!
//! * `ReferenceRecipe` (kind 2) and `ReferenceRecipeSegment` (kind 12): the KFRV
//!   reference-recipe graph. The standalone recipe wire is already ported in
//!   `reference_recipes.rs`; wiring the in-arena recipe records into the live
//!   reference broker is runtime-instance state, not a pure byte decode.
//! * `ReplayEvents` (kind 8) and `ReplayEventSegment` (kind 13): the KFRE replay
//!   journal, already ported in `replay_events.rs`; its in-arena records carry
//!   that same wire.
//! * `ImportedGlobalBindings` (kind 9), `ActivationContinuations` (kind 10), and
//!   `ImportedTableBindings` (kind 11): live binding/continuation state that
//!   names `WebAssembly.Global`/`Table` identities, activation roots, and
//!   exception continuations resolved through the reference broker. These are
//!   genuinely instance-bound, not a pure `&[u8]` decode.

use wasm_posix_shared::abi;
use wasm_posix_shared::Errno;

use alloc::vec::Vec;

use crate::module_state::ModuleStateRecord;

const MODULE_TEMPLATE_ID_SIZE: usize =
    abi::WPK_FORK_MODULE_STATE_MODULE_TEMPLATE_ID_SIZE as usize;
const MODULE_RECORD_PAYLOAD_SIZE: usize =
    abi::WPK_FORK_MODULE_STATE_MODULE_RECORD_PAYLOAD_SIZE as usize;
const MODULE_RECORD_KNOWN_FLAGS: u32 = abi::WPK_FORK_MODULE_STATE_MODULE_RECORD_KNOWN_FLAGS;
const GLOBAL_HEADER_SIZE: usize = abi::WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE as usize;
const TABLE_DESCRIPTOR_PAYLOAD_SIZE: usize =
    abi::WPK_FORK_MODULE_STATE_TABLE_DESCRIPTOR_PAYLOAD_SIZE as usize;
const TABLE_BASELINE_FINGERPRINT_SIZE: usize =
    abi::WPK_FORK_MODULE_STATE_TABLE_BASELINE_FINGERPRINT_SIZE as usize;
const TABLE_FLAG_SPARSE_OVERRIDES: u16 =
    abi::WPK_FORK_MODULE_STATE_TABLE_FLAG_SPARSE_OVERRIDES as u16;
const TABLE_KNOWN_FLAGS: u16 = abi::WPK_FORK_MODULE_STATE_TABLE_KNOWN_FLAGS as u16;
const TABLE_PAGE_HEADER_SIZE: usize = abi::WPK_FORK_MODULE_STATE_TABLE_PAGE_HEADER_SIZE as usize;
const TABLE_RUN_HEADER_SIZE: usize = abi::WPK_FORK_MODULE_STATE_TABLE_RUN_HEADER_SIZE as usize;
const ELEMENT_SEGMENT_HEADER_SIZE: usize =
    abi::WPK_FORK_MODULE_STATE_ELEMENT_SEGMENT_HEADER_SIZE as usize;
const DATA_SEGMENT_HEADER_SIZE: usize = abi::WPK_FORK_MODULE_STATE_DATA_SEGMENT_HEADER_SIZE as usize;
const MIN_TABLE_PAGE_SHIFT: u8 = abi::WPK_FORK_MODULE_STATE_MIN_TABLE_PAGE_SHIFT;
const MAX_TABLE_PAGE_SHIFT: u8 = abi::WPK_FORK_MODULE_STATE_MAX_TABLE_PAGE_SHIFT;

// --- Bounds-checked little-endian readers --------------------------------

fn r_u16(bytes: &[u8], off: usize) -> Result<u16, Errno> {
    let end = off.checked_add(2).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(off..end).ok_or(Errno::EINVAL)?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn r_u32(bytes: &[u8], off: usize) -> Result<u32, Errno> {
    let end = off.checked_add(4).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(off..end).ok_or(Errno::EINVAL)?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn r_u64(bytes: &[u8], off: usize) -> Result<u64, Errno> {
    let end = off.checked_add(8).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(off..end).ok_or(Errno::EINVAL)?;
    Ok(u64::from_le_bytes([
        slice[0], slice[1], slice[2], slice[3], slice[4], slice[5], slice[6], slice[7],
    ]))
}

/// Whether `type_code` is a reference value type (`funcref`/`externref`/
/// `exnref`/`anyref`, codes 6..=9). Reference globals carry their referent as a
/// leading `u32` recipe id.
fn is_reference_type(type_code: u8) -> bool {
    type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF
        || type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF
        || type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF
        || type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF
}

/// The byte width of a mutable-global value for `type_code`, or `None` for an
/// unknown type. Mirrors the TS `valueSizes` map in `decodeForkGlobalSnapshot`.
fn global_value_size(type_code: u8) -> Option<u8> {
    if type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32 {
        Some(4)
    } else if type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64 {
        Some(8)
    } else if type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F32 {
        Some(4)
    } else if type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64 {
        Some(8)
    } else if type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_V128 {
        Some(16)
    } else if is_reference_type(type_code) {
        Some(4)
    } else {
        None
    }
}

// --- Module descriptor record (kind 1) -----------------------------------

/// Decoded `Module` record payload: the deterministic module identity a child
/// rebinds before instantiation. Mirrors the fields `decodeModulePayload`
/// validates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleDescriptor {
    /// The 32-byte SHA-256 module template id.
    pub template_id: [u8; 32],
    /// Module flags word (currently no flags are defined, so always zero).
    pub flags: u32,
}

/// Encode a `Module` (kind 1) record payload into `out`.
///
/// The counterpart to [`decode_module_record`], and the first ENCODER on this
/// side of the arena. Until now every record in a KFMS arena was written either
/// by the guest (through the module's reserve/commit imports) or by the host's
/// JavaScript arena writer; the module itself only ever read them. It needs this
/// one because the `Module` record is the arena's activation set -- the module's
/// own child-install path filters on kind 1 to decide which activations to
/// drive -- so an arena the module builds without them installs nothing.
///
/// Refuses an out-of-range `out`, and refuses unknown flag bits rather than
/// writing them: the decoder rejects them on the way back in, so accepting one
/// here would produce a record this crate cannot read.
pub fn encode_module_record(
    out: &mut [u8],
    descriptor: &ModuleDescriptor,
) -> Result<(), Errno> {
    if out.len() != MODULE_RECORD_PAYLOAD_SIZE {
        return Err(Errno::EINVAL);
    }
    if descriptor.flags & !MODULE_RECORD_KNOWN_FLAGS != 0 {
        return Err(Errno::EINVAL);
    }
    out[0..MODULE_TEMPLATE_ID_SIZE].copy_from_slice(&descriptor.template_id);
    out[MODULE_TEMPLATE_ID_SIZE..MODULE_TEMPLATE_ID_SIZE + 4]
        .copy_from_slice(&descriptor.flags.to_le_bytes());
    // The reserved word is written, not left alone: a fresh channel mapping is
    // not guaranteed zero, and the decoder rejects a nonzero reserved field.
    out[MODULE_TEMPLATE_ID_SIZE + 4..MODULE_TEMPLATE_ID_SIZE + 8]
        .copy_from_slice(&0u32.to_le_bytes());
    Ok(())
}

/// Decode a `Module` (kind 1) record payload. Mirrors `decodeModulePayload`.
pub fn decode_module_record(payload: &[u8]) -> Result<ModuleDescriptor, Errno> {
    if payload.len() != MODULE_RECORD_PAYLOAD_SIZE {
        return Err(Errno::EINVAL);
    }
    let flags = r_u32(payload, MODULE_TEMPLATE_ID_SIZE)?;
    if flags & !MODULE_RECORD_KNOWN_FLAGS != 0 {
        return Err(Errno::EINVAL); // unknown module flags
    }
    if r_u32(payload, MODULE_TEMPLATE_ID_SIZE + 4)? != 0 {
        return Err(Errno::EINVAL); // reserved field is nonzero
    }
    let mut template_id = [0u8; 32];
    template_id.copy_from_slice(&payload[0..MODULE_TEMPLATE_ID_SIZE]);
    Ok(ModuleDescriptor { template_id, flags })
}

// --- Journal image record (kind 14) --------------------------------------

/// Decode a `JournalImage` (kind 14) record payload into `(image_ptr,
/// image_len)`: the guest offset and byte length of the channel-mmap'd KFRE
/// journal image the forked child inherits. Mirrors the TS
/// `journalImageForChild` / `encodeForkJournalImage` — a fixed 32-byte payload:
/// KFJI magic (4), version (2) = 1, header_size (2) = 16, flags (2), reserved
/// (2 + 4), then `ptr` u64 @16 and `len` u64 @24. A zero ptr/len, wrong magic,
/// unsupported version, or nonzero reserved field is a framing failure
/// (`EINVAL`), matching the TS decoder's `throw`.
/// One imported-global binding: where a child must get the value for an import
/// the parent had.
///
/// The interesting field is `kind` with its source coordinate. An imported
/// global whose value is a `WebAssembly.Global` exported by another activation
/// binds to THAT activation's global, so the child wires both to one
/// reconstructed object — without which two activations that shared a mutable
/// global stop sharing it and drift apart silently. Wasm cannot determine that:
/// there is no `global.eq` and the module does not import the activations'
/// globals, so the coordinate is resolved once by the host and travels here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportedGlobalBinding {
    pub consumer_activation: u32,
    pub consumer_owner: u32,
    pub source_activation: u32,
    pub source_owner: u32,
    pub recipe_id: u32,
    pub raw_bits: u64,
    pub kind: u8,
    pub flags: u8,
    pub type_code: u8,
}

/// What only the HOST can determine about one imported global.
///
/// The module cannot see an activation's import object at all, so two facts
/// have to travel from the host: whether the imported value is a
/// `WebAssembly.Global` and WHICH ONE — object identity, which wasm cannot
/// compare, there being no `global.eq` — and, for a plain scalar import, the
/// value itself, which lives only in the import object.
///
/// Identity travels as a GROUP ID, not as a coordinate. Naming the activation
/// that provides a Global would mean deciding which member of an identity group
/// provides it, and that decision needs to know which catalog entries an
/// activation merely IMPORTS: `fork_instrument` exports `__wpk_fork_global_N`
/// for every global an activation has, imported ones included, so a group's
/// members are usually one owner and several importers. Only the KFIG section
/// distinguishes them, and the host does not read KFIG. So the host groups, and
/// [`build_imported_global_bindings`] elects.
///
/// Everything else about a binding is derivable here: the type code and
/// mutability from the activation's KFIG descriptors, the recipe id from the
/// snapshot the guest wrote into the arena, the ordering, and the encoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportedGlobalProvenance {
    pub consumer_activation: u32,
    pub consumer_owner: u32,
    /// One of the `WPK_FORK_IMPORTED_GLOBAL_BINDING_*` kinds, except
    /// `BASE_IMPORT`: that one is a conclusion of the election below, never an
    /// input. A host publishing it would be claiming no activation provides the
    /// object, which is exactly the KFIG-dependent judgement it cannot make.
    pub kind: u8,
    /// For `ACTIVATION_GLOBAL`: the identity group of the imported Global, or 0
    /// when the object appears in no activation's catalog at all.
    pub group_id: u32,
    /// Meaningful for `RAW_NUMBER` / `RAW_BIGINT`: the value's bits.
    pub raw_bits: u64,
}

/// One membership of a catalog global in an identity group.
///
/// `(activation, owner)` names a `__wpk_fork_global_N` export; entries sharing a
/// `group_id` are the same `WebAssembly.Global` object seen from several
/// activations. The host assigns the ids because comparing object identity is
/// the one thing here that wasm cannot do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GlobalIdentityGroup {
    pub activation: u32,
    pub owner: u32,
    pub group_id: u32,
}

/// Elect the activation that PROVIDES an identity group's `WebAssembly.Global`.
///
/// A group's members are every catalog entry naming the same object. All but
/// one of them import it, and an importer cannot provide it to anyone: at
/// replay the child instantiates activations in ascending order, so the value
/// has to come from the one that declares the global itself. Members declared
/// in KFIG are therefore excluded, and the lowest remaining coordinate wins so
/// the choice is stable across runs.
///
/// `None` means nobody provides it — an empty group, or one where every member
/// is an importer — and the binding is a `BASE_IMPORT`: the object came from
/// outside the activation set, so the child takes it from its own base imports.
fn elect_group_provider(
    group_id: u32,
    groups: &[GlobalIdentityGroup],
    declarations: &[ImportedGlobalDeclaration],
) -> Option<(u32, u32)> {
    if group_id == 0 {
        return None; // in no catalog: nothing to elect from
    }
    groups
        .iter()
        .filter(|g| g.group_id == group_id)
        .filter(|g| {
            !declarations
                .iter()
                .any(|d| d.activation == g.activation && d.owner == g.owner)
        })
        .map(|g| (g.activation, g.owner))
        .min()
}

/// One imported-table binding, as `KFBT` (record kind 11) stores it.
///
/// The table twin of [`ImportedGlobalBinding`], and deliberately smaller: a
/// table import is always a `WebAssembly.Table`, so there are no raw values to
/// carry and no type code to agree with a snapshot. What is left is the same
/// question -- which activation provides the object -- answered the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportedTableBinding {
    pub consumer_activation: u32,
    pub consumer_owner: u32,
    pub source_activation: u32,
    pub source_owner: u32,
    /// `ACTIVATION_TABLE` or `BASE_IMPORT`, the latter only ever from the
    /// election in [`build_imported_table_bindings`].
    pub kind: u8,
}

/// One activation's imported-table declaration, as KFIT records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportedTableDeclaration {
    pub activation: u32,
    pub owner: u32,
}

/// What only the HOST can determine about one imported table: which object it
/// is. Identity again, as a group id -- see [`ImportedGlobalProvenance`] for why
/// the coordinate is not what travels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportedTableProvenance {
    pub consumer_activation: u32,
    pub consumer_owner: u32,
    /// The identity group of the imported table, or 0 when the object appears
    /// in no activation's catalog.
    pub group_id: u32,
}

/// Payload size for `count` imported-table bindings.
pub fn imported_table_bindings_size(count: usize) -> Result<usize, Errno> {
    let entries = count
        .checked_mul(abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE as usize)
        .ok_or(Errno::EINVAL)?;
    entries
        .checked_add(abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE as usize)
        .ok_or(Errno::EINVAL)
}

/// Encode the `KFBT` record the child reads to rebuild its table imports.
pub fn encode_imported_table_bindings(
    out: &mut [u8],
    bindings: &[ImportedTableBinding],
) -> Result<(), Errno> {
    let header = abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE as usize;
    let entry = abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE as usize;
    if out.len() != imported_table_bindings_size(bindings.len())? {
        return Err(Errno::EINVAL);
    }
    let count = u32::try_from(bindings.len()).map_err(|_| Errno::EINVAL)?;
    // Zero first: reserved fields and each entry's trailing padding must read as
    // zero, and the chunk this lands in is freshly channel-mmap'd.
    out.fill(0);
    out[0..4].copy_from_slice(&abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_MAGIC);
    out[4..6]
        .copy_from_slice(&abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_VERSION.to_le_bytes());
    out[6..8].copy_from_slice(
        &abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE.to_le_bytes(),
    );
    out[8..10].copy_from_slice(
        &abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE.to_le_bytes(),
    );
    out[12..16].copy_from_slice(&count.to_le_bytes());

    let mut previous: Option<(u32, u32)> = None;
    for (index, binding) in bindings.iter().enumerate() {
        if !matches!(
            binding.kind,
            abi::WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE
                | abi::WPK_FORK_IMPORTED_TABLE_BINDING_BASE_IMPORT
        ) {
            return Err(Errno::EINVAL);
        }
        let key = (binding.consumer_activation, binding.consumer_owner);
        if let Some(prev) = previous {
            if key <= prev {
                return Err(Errno::EINVAL); // unsorted or duplicated consumer
            }
        }
        previous = Some(key);

        let at = header + index * entry;
        out[at..at + 4].copy_from_slice(&binding.consumer_activation.to_le_bytes());
        out[at + 4..at + 8].copy_from_slice(&binding.consumer_owner.to_le_bytes());
        out[at + 8..at + 12].copy_from_slice(&binding.source_activation.to_le_bytes());
        out[at + 12..at + 16].copy_from_slice(&binding.source_owner.to_le_bytes());
        out[at + 20] = binding.kind;
    }
    Ok(())
}

/// Build the imported-table binding set: the same election, over tables.
///
/// `WebAssembly.Table` identity is as invisible to wasm as Global identity --
/// there is no `table.eq` and this module does not import the activations'
/// tables -- so the host groups and this elects. A member KFIT declares as an
/// import cannot provide the table to anyone, and when no member remains the
/// child takes it from its own base imports.
pub fn build_imported_table_bindings(
    provenance: &[ImportedTableProvenance],
    declarations: &[ImportedTableDeclaration],
    groups: &[GlobalIdentityGroup],
) -> Result<Vec<ImportedTableBinding>, Errno> {
    // `elect_group_provider` excludes importers by coordinate and never reads a
    // type code, so the two declaration shapes project onto one another.
    let importers: Vec<ImportedGlobalDeclaration> = declarations
        .iter()
        .map(|d| ImportedGlobalDeclaration {
            activation: d.activation,
            owner: d.owner,
            type_code: 0,
        })
        .collect();
    let mut out: Vec<ImportedTableBinding> = Vec::with_capacity(provenance.len());
    for p in provenance {
        // The consumer must be a table this activation actually imports; the
        // alternative is binding a child's import from a coordinate that
        // describes nothing.
        if !declarations
            .iter()
            .any(|d| d.activation == p.consumer_activation && d.owner == p.consumer_owner)
        {
            return Err(Errno::EINVAL);
        }
        let mut binding = ImportedTableBinding {
            consumer_activation: p.consumer_activation,
            consumer_owner: p.consumer_owner,
            source_activation: 0,
            source_owner: 0,
            kind: abi::WPK_FORK_IMPORTED_TABLE_BINDING_BASE_IMPORT,
        };
        if let Some((activation, owner)) =
            elect_group_provider(p.group_id, groups, &importers)
        {
            binding.kind = abi::WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE;
            binding.source_activation = activation;
            binding.source_owner = owner;
        }
        out.push(binding);
    }
    out.sort_by_key(|b| (b.consumer_activation, b.consumer_owner));
    Ok(out)
}

/// One activation's imported-global declaration, as KFIG records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportedGlobalDeclaration {
    pub activation: u32,
    pub owner: u32,
    pub type_code: u8,
}

/// One `MutableGlobal` snapshot, reduced to what a binding needs from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportedGlobalSnapshotFact {
    pub activation: u32,
    pub owner: u32,
    pub type_code: u8,
    pub recipe_id: Option<u32>,
}

/// Decode the `KFBG` imported-global binding record a child inherits.
///
/// The read half of [`encode_imported_global_bindings`]. A child gets these
/// records and nothing else about its parent's imports: which activation
/// provides each one, or the raw bits or recipe that stands in for it.
///
/// Validated rather than trusted, because the bytes come out of an arena the
/// parent mapped and the child inherited -- shared memory another process
/// wrote. A record that decodes to nonsense would otherwise bind a fresh
/// child's imports from coordinates describing nothing, which is the silent
/// wrong child this whole path exists to avoid. Refuses a wrong magic or
/// version, a header or entry size the writer did not use, unknown flags, a
/// length that disagrees with the count, an undefined kind, a zero consumer
/// owner, and consumers that are not strictly ascending -- the same set the
/// encoder refuses to produce.
pub fn decode_imported_global_bindings(
    payload: &[u8],
) -> Result<Vec<ImportedGlobalBinding>, Errno> {
    let header = abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE as usize;
    let entry = abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE as usize;
    let count = decode_bindings_header(
        payload,
        &abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_MAGIC,
        abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_VERSION,
        header,
        entry,
        abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_KNOWN_FLAGS,
    )?;
    let mut out: Vec<ImportedGlobalBinding> = Vec::with_capacity(count);
    let mut previous: Option<(u32, u32)> = None;
    for index in 0..count {
        let at = header + index * entry;
        let binding = ImportedGlobalBinding {
            consumer_activation: r_u32(payload, at)?,
            consumer_owner: r_u32(payload, at + 4)?,
            source_activation: r_u32(payload, at + 8)?,
            source_owner: r_u32(payload, at + 12)?,
            recipe_id: r_u32(payload, at + 20)?,
            raw_bits: r_u64(payload, at + 24)?,
            kind: *payload.get(at + 32).ok_or(Errno::EINVAL)?,
            flags: *payload.get(at + 33).ok_or(Errno::EINVAL)?,
            type_code: *payload.get(at + 34).ok_or(Errno::EINVAL)?,
        };
        if !matches!(
            binding.kind,
            abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER
                | abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT
                | abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE
                | abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL
                | abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT
        ) {
            return Err(Errno::EINVAL);
        }
        previous = Some(check_binding_order(
            previous,
            binding.consumer_activation,
            binding.consumer_owner,
        )?);
        out.push(binding);
    }
    Ok(out)
}

/// Decode the `KFBT` imported-table binding record a child inherits.
pub fn decode_imported_table_bindings(
    payload: &[u8],
) -> Result<Vec<ImportedTableBinding>, Errno> {
    let header = abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE as usize;
    let entry = abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE as usize;
    let count = decode_bindings_header(
        payload,
        &abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_MAGIC,
        abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_VERSION,
        header,
        entry,
        abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_KNOWN_FLAGS,
    )?;
    let mut out: Vec<ImportedTableBinding> = Vec::with_capacity(count);
    let mut previous: Option<(u32, u32)> = None;
    for index in 0..count {
        let at = header + index * entry;
        let binding = ImportedTableBinding {
            consumer_activation: r_u32(payload, at)?,
            consumer_owner: r_u32(payload, at + 4)?,
            source_activation: r_u32(payload, at + 8)?,
            source_owner: r_u32(payload, at + 12)?,
            kind: *payload.get(at + 20).ok_or(Errno::EINVAL)?,
        };
        if !matches!(
            binding.kind,
            abi::WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE
                | abi::WPK_FORK_IMPORTED_TABLE_BINDING_BASE_IMPORT
        ) {
            return Err(Errno::EINVAL);
        }
        previous = Some(check_binding_order(
            previous,
            binding.consumer_activation,
            binding.consumer_owner,
        )?);
        out.push(binding);
    }
    Ok(out)
}

/// The header both binding records share, validated; returns the entry count.
fn decode_bindings_header(
    payload: &[u8],
    magic: &[u8; 4],
    version: u16,
    header: usize,
    entry: usize,
    known_flags: u16,
) -> Result<usize, Errno> {
    if payload.len() < header {
        return Err(Errno::EINVAL); // truncated header
    }
    if payload.get(0..4) != Some(&magic[..]) {
        return Err(Errno::EINVAL);
    }
    if r_u16(payload, 4)? != version
        || r_u16(payload, 6)? != header as u16
        || r_u16(payload, 8)? != entry as u16
    {
        return Err(Errno::EINVAL); // a writer this decoder does not know
    }
    if r_u16(payload, 10)? & !known_flags != 0 {
        return Err(Errno::EINVAL);
    }
    let count = usize::try_from(r_u32(payload, 12)?).map_err(|_| Errno::EINVAL)?;
    let expected = count.checked_mul(entry).and_then(|b| b.checked_add(header));
    if expected != Some(payload.len()) {
        return Err(Errno::EINVAL); // count and length disagree
    }
    Ok(count)
}

/// Consumers must be unique and strictly ascending, as the encoder demands.
///
/// A repeated consumer is the case worth naming: a child binding one import
/// twice takes whichever entry it reads last, silently.
fn check_binding_order(
    previous: Option<(u32, u32)>,
    activation: u32,
    owner: u32,
) -> Result<(u32, u32), Errno> {
    if owner == 0 {
        return Err(Errno::EINVAL); // owner ordinals are 1-based
    }
    let key = (activation, owner);
    if let Some(prev) = previous {
        if key <= prev {
            return Err(Errno::EINVAL);
        }
    }
    Ok(key)
}

/// Build the binding set from host provenance plus module-owned facts.
///
/// This is the matching loop that used to live in TypeScript's `appendTo`. It
/// stayed there only because it sat next to the identity comparison, not because
/// any of it needs JavaScript: the descriptors come from the guest's own KFIG
/// section and the snapshots from the arena the module owns.
///
/// Three things it refuses, each because the alternative is a child that is
/// quietly wrong rather than a fork that fails:
///
/// * a snapshot whose type disagrees with the KFIG declaration — two
///   module-owned artifacts describing one global differently means one of them
///   is being read against the wrong record;
/// * a reference import with no recipe id, since the recipe IS the binding for
///   a reference the host could not carry;
/// * a non-null exnref without a `WebAssembly.Global` carrier. JavaScript cannot
///   hold a non-null exnref, so a legitimate one is necessarily carried by a
///   Global; emitting a raw reference here would manufacture a child transport
///   the embedding API cannot represent.
pub fn build_imported_global_bindings(
    provenance: &[ImportedGlobalProvenance],
    declarations: &[ImportedGlobalDeclaration],
    snapshots: &[ImportedGlobalSnapshotFact],
    groups: &[GlobalIdentityGroup],
) -> Result<Vec<ImportedGlobalBinding>, Errno> {
    let mut out: Vec<ImportedGlobalBinding> = Vec::with_capacity(provenance.len());
    for p in provenance {
        let declaration = declarations
            .iter()
            .find(|d| d.activation == p.consumer_activation && d.owner == p.consumer_owner)
            .ok_or(Errno::EINVAL)?;
        let snapshot = snapshots
            .iter()
            .find(|s| s.activation == p.consumer_activation && s.owner == p.consumer_owner)
            .ok_or(Errno::EINVAL)?;
        if snapshot.type_code != declaration.type_code {
            return Err(Errno::EINVAL); // snapshot does not match the KFIG type
        }
        let mut binding = ImportedGlobalBinding {
            consumer_activation: p.consumer_activation,
            consumer_owner: p.consumer_owner,
            source_activation: 0,
            source_owner: 0,
            recipe_id: 0,
            raw_bits: 0,
            kind: p.kind,
            flags: 0,
            type_code: declaration.type_code,
        };
        match p.kind {
            abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL => {
                // The election, not the host, decides whether this Global has a
                // provider at all.
                match elect_group_provider(p.group_id, groups, declarations) {
                    Some((activation, owner)) => {
                        binding.source_activation = activation;
                        binding.source_owner = owner;
                    }
                    None => {
                        binding.kind = abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT;
                    }
                }
            }
            abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT => {
                // Only the election above may reach this kind; see the note on
                // `ImportedGlobalProvenance::kind`.
                return Err(Errno::EINVAL);
            }
            abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE => {
                if !is_reference_type(declaration.type_code) {
                    return Err(Errno::EINVAL);
                }
                let recipe = snapshot.recipe_id.ok_or(Errno::EINVAL)?;
                if declaration.type_code == abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF
                    && recipe != 0
                {
                    return Err(Errno::EINVAL); // non-null exnref with no carrier
                }
                binding.recipe_id = recipe;
            }
            abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER
            | abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT => {
                binding.raw_bits = p.raw_bits;
            }
            _ => return Err(Errno::EINVAL),
        }
        out.push(binding);
    }
    // The encoder demands sorted, unique consumers; sort here so the host is not
    // required to publish provenance in any particular order.
    out.sort_by_key(|b| (b.consumer_activation, b.consumer_owner));
    Ok(out)
}

/// Payload bytes an imported-global bindings record of `count` entries needs.
pub fn imported_global_bindings_size(count: usize) -> Result<usize, Errno> {
    let entries = count
        .checked_mul(abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE as usize)
        .ok_or(Errno::EINVAL)?;
    entries
        .checked_add(abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE as usize)
        .ok_or(Errno::EINVAL)
}

/// Encode an `ImportedGlobalBindings` (kind 9) record payload into `out`.
///
/// Mirrors the TypeScript `encodeForkImportedGlobalBindings`, which is what
/// currently writes these and what this replaces. The decoder on the child side
/// reads them back, so the byte layout is the contract: a 24-byte header
/// (magic, version, header size, entry size, flags, count, reserved) followed by
/// 40-byte entries.
///
/// Entries must arrive sorted and unique by `(consumer_activation,
/// consumer_owner)`, and that is enforced rather than assumed. A duplicate
/// consumer means two different sources for one import, and whichever the child
/// reads last wins — a coin flip that decides whether two activations share a
/// global.
pub fn encode_imported_global_bindings(
    out: &mut [u8],
    bindings: &[ImportedGlobalBinding],
) -> Result<(), Errno> {
    let header = abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE as usize;
    let entry = abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE as usize;
    if out.len() != imported_global_bindings_size(bindings.len())? {
        return Err(Errno::EINVAL);
    }
    let count = u32::try_from(bindings.len()).map_err(|_| Errno::EINVAL)?;
    // Zero first: the record lands in a freshly channel-mmap'd chunk, and both
    // the reserved fields and each entry's trailing padding must read as zero.
    out.fill(0);
    out[0..4].copy_from_slice(&abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_MAGIC);
    out[4..6].copy_from_slice(
        &abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_VERSION.to_le_bytes(),
    );
    out[6..8].copy_from_slice(
        &abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE.to_le_bytes(),
    );
    out[8..10].copy_from_slice(
        &abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE.to_le_bytes(),
    );
    out[12..16].copy_from_slice(&count.to_le_bytes());

    let mut previous: Option<(u32, u32)> = None;
    for (index, binding) in bindings.iter().enumerate() {
        if binding.flags != 0
            && u16::from(binding.flags)
                & !abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_KNOWN_FLAGS
                != 0
        {
            return Err(Errno::EINVAL);
        }
        if !matches!(
            binding.kind,
            abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER
                | abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT
                | abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE
                | abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL
                | abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT
        ) {
            return Err(Errno::EINVAL);
        }
        let key = (binding.consumer_activation, binding.consumer_owner);
        if let Some(prev) = previous {
            if key <= prev {
                return Err(Errno::EINVAL); // unsorted or duplicated consumer
            }
        }
        previous = Some(key);

        let at = header + index * entry;
        out[at..at + 4].copy_from_slice(&binding.consumer_activation.to_le_bytes());
        out[at + 4..at + 8].copy_from_slice(&binding.consumer_owner.to_le_bytes());
        out[at + 8..at + 12].copy_from_slice(&binding.source_activation.to_le_bytes());
        out[at + 12..at + 16].copy_from_slice(&binding.source_owner.to_le_bytes());
        out[at + 20..at + 24].copy_from_slice(&binding.recipe_id.to_le_bytes());
        out[at + 24..at + 32].copy_from_slice(&binding.raw_bits.to_le_bytes());
        out[at + 32] = binding.kind;
        out[at + 33] = binding.flags;
        out[at + 34] = binding.type_code;
    }
    Ok(())
}

/// Encode a `JournalImage` (kind 14) record payload into `out`.
///
/// The counterpart to [`decode_journal_image`]. The module serializes the
/// child-inheritable journal into a chunk it channel-mmaps itself, so it is the
/// only party that knows where the image landed — but the RECORD announcing
/// that location was still written by the host, which meant the module had to
/// hand the pair back out and trust someone else to record it faithfully.
///
/// Refuses a zero pointer or length for the reason the decoder refuses them: a
/// zero here is an image that was never serialized, and a child that inherits
/// such a record would seed its journal from address 0.
pub fn encode_journal_image(out: &mut [u8], ptr: u64, len: u64) -> Result<(), Errno> {
    if out.len() != abi::WPK_FORK_JOURNAL_IMAGE_PAYLOAD_SIZE as usize {
        return Err(Errno::EINVAL);
    }
    if ptr == 0 || len == 0 {
        return Err(Errno::EINVAL);
    }
    out.fill(0);
    out[0..4].copy_from_slice(&abi::WPK_FORK_JOURNAL_IMAGE_MAGIC);
    out[4..6].copy_from_slice(&abi::WPK_FORK_JOURNAL_IMAGE_VERSION.to_le_bytes());
    out[6..8].copy_from_slice(&abi::WPK_FORK_JOURNAL_IMAGE_HEADER_SIZE.to_le_bytes());
    // flags, the two reserved fields and any trailer stay zero from the fill
    // above -- the decoder rejects a nonzero reserved field, and a freshly
    // channel-mmap'd chunk is not guaranteed to be zero.
    out[16..24].copy_from_slice(&ptr.to_le_bytes());
    out[24..32].copy_from_slice(&len.to_le_bytes());
    Ok(())
}

pub fn decode_journal_image(payload: &[u8]) -> Result<(u64, u64), Errno> {
    if payload.len() != abi::WPK_FORK_JOURNAL_IMAGE_PAYLOAD_SIZE as usize {
        return Err(Errno::EINVAL); // truncated / oversized
    }
    if payload[0..4] != abi::WPK_FORK_JOURNAL_IMAGE_MAGIC {
        return Err(Errno::EINVAL); // wrong magic
    }
    if r_u16(payload, 4)? != abi::WPK_FORK_JOURNAL_IMAGE_VERSION {
        return Err(Errno::EINVAL); // unsupported version
    }
    if r_u16(payload, 6)? != abi::WPK_FORK_JOURNAL_IMAGE_HEADER_SIZE {
        return Err(Errno::EINVAL); // header size inconsistent
    }
    let flags = r_u16(payload, 8)?;
    if flags & !abi::WPK_FORK_JOURNAL_IMAGE_KNOWN_FLAGS != 0 {
        return Err(Errno::EINVAL); // unknown flags
    }
    if r_u16(payload, 10)? != 0 || r_u32(payload, 12)? != 0 {
        return Err(Errno::EINVAL); // reserved fields nonzero
    }
    let ptr = r_u64(payload, 16)?;
    let len = r_u64(payload, 24)?;
    if ptr == 0 || len == 0 {
        return Err(Errno::EINVAL); // zero ptr/len is malformed
    }
    Ok((ptr, len))
}

// --- Mutable global record (kind 3) --------------------------------------

/// Decoded `MutableGlobal` record payload: a value-type-tagged snapshot of one
/// mutable global. Mirrors the TS `ForkGlobalSnapshot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalSnapshot {
    /// The value-type code (`WPK_FORK_MODULE_STATE_GLOBAL_TYPE_*`).
    pub type_code: u8,
    /// The raw stored value bytes (4/8/16 bytes depending on the type).
    pub value: Vec<u8>,
    /// For reference-type globals, the leading `u32` recipe id of the referent;
    /// `None` for numeric/vector globals.
    pub recipe_id: Option<u32>,
}

/// Decode a `MutableGlobal` (kind 3) record payload. Mirrors
/// `decodeForkGlobalSnapshot`.
pub fn decode_mutable_global(payload: &[u8]) -> Result<GlobalSnapshot, Errno> {
    if payload.len() < GLOBAL_HEADER_SIZE {
        return Err(Errno::EINVAL); // truncated header
    }
    let type_code = payload[0];
    let expected_value_size = global_value_size(type_code).ok_or(Errno::EINVAL)?;
    let value_size = payload[1];
    if value_size != expected_value_size
        || payload.len() != GLOBAL_HEADER_SIZE + expected_value_size as usize
    {
        return Err(Errno::EINVAL); // value size inconsistent
    }
    if r_u16(payload, 2)? != 0 || r_u32(payload, 4)? != 0 {
        return Err(Errno::EINVAL); // reserved fields nonzero
    }
    let value = payload[GLOBAL_HEADER_SIZE..].to_vec();
    let recipe_id = if is_reference_type(type_code) {
        Some(r_u32(&value, 0)?)
    } else {
        None
    };
    Ok(GlobalSnapshot {
        type_code,
        value,
        recipe_id,
    })
}

// --- Table descriptor record (kind 4) ------------------------------------

/// Decoded `Table` descriptor record payload: the geometry of one sparse table
/// snapshot. Mirrors the TS `DecodedTableDescriptor` fields
/// `decodeTableDescriptor` returns (the ownership coordinates
/// `activationId`/`ownerId` live on the record envelope, not this payload).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableDescriptor {
    /// Table index width in bytes: 4 (table32) or 8 (table64).
    pub index_width: u8,
    /// Sparse page shift; the page holds `1 << page_shift` slots.
    pub page_shift: u8,
    /// Table flags (`SPARSE_OVERRIDES` is required and the only known flag).
    pub flags: u16,
    /// Number of `TablePage` records that follow for this table.
    pub page_count: u32,
    /// Final table length.
    pub length: u64,
    /// Deterministic baseline length (must not exceed `length`).
    pub baseline_length: u64,
    /// 32-byte fingerprint of the deterministic instantiation baseline.
    pub baseline_fingerprint: [u8; 32],
}

/// Decode a `Table` (kind 4) descriptor record payload. Mirrors
/// `decodeTableDescriptor`.
pub fn decode_table_descriptor(payload: &[u8]) -> Result<TableDescriptor, Errno> {
    if payload.len() != TABLE_DESCRIPTOR_PAYLOAD_SIZE {
        return Err(Errno::EINVAL);
    }
    let index_width = payload[0];
    if index_width != 4 && index_width != 8 {
        return Err(Errno::EINVAL); // unsupported index width
    }
    let page_shift = payload[1];
    if !(MIN_TABLE_PAGE_SHIFT..=MAX_TABLE_PAGE_SHIFT).contains(&page_shift) {
        return Err(Errno::EINVAL); // unsupported page shift
    }
    let flags = r_u16(payload, 2)?;
    if flags & !TABLE_KNOWN_FLAGS != 0 || flags & TABLE_FLAG_SPARSE_OVERRIDES == 0 {
        return Err(Errno::EINVAL); // invalid table flags
    }
    let page_count = r_u32(payload, 4)?;
    let length = r_u64(payload, 8)?;
    let baseline_length = r_u64(payload, 16)?;
    if index_width == 4 && length > u32::MAX as u64 {
        return Err(Errno::EINVAL); // table32 length exceeds u32
    }
    if baseline_length > length {
        return Err(Errno::EINVAL); // baseline exceeds final length
    }
    let mut baseline_fingerprint = [0u8; 32];
    baseline_fingerprint
        .copy_from_slice(&payload[24..24 + TABLE_BASELINE_FINGERPRINT_SIZE]);
    Ok(TableDescriptor {
        index_width,
        page_shift,
        flags,
        page_count,
        length,
        baseline_length,
        baseline_fingerprint,
    })
}

// --- Sparse table page record (kind 5) -----------------------------------

/// One decoded run of contiguous recipe-id overrides within a table page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SparseTableRun {
    /// The page-relative slot index the run starts at.
    pub start: u32,
    /// The recipe ids overriding the deterministic baseline for this run. These
    /// are plain `u32` indices into the reference-recipe graph; resolving them
    /// to live references is the deferred runtime half.
    pub recipe_ids: Vec<u32>,
}

/// Decoded `TablePage` record payload: the sparse overrides for one page of a
/// table. Mirrors the TS `DecodedTablePage` (envelope ownership fields aside).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SparseTablePage {
    /// The page index within the table.
    pub page_index: u64,
    /// The runs of overrides, ordered and non-overlapping within the page.
    pub runs: Vec<SparseTableRun>,
    /// Total override entries across all runs (validated against the header).
    pub entry_count: u32,
}

/// Decode a `TablePage` (kind 5) record payload. Mirrors
/// `validateTablePage` + `decodeTablePage`.
///
/// A table page is only meaningful relative to its owning `Table` descriptor, so
/// the descriptor's `page_shift` and final `length` are decode context (matching
/// the TS decoder, which is handed the `DecodedTableDescriptor`). The recipe ids
/// in each run are plain `u32` indices; this is a pure byte decode. Malformed
/// input yields `Err(Errno::EINVAL)`; the function never panics.
pub fn decode_table_page(
    payload: &[u8],
    page_shift: u8,
    table_length: u64,
) -> Result<SparseTablePage, Errno> {
    // Guard the shift so `1u64 << page_shift` can never overflow, even when a
    // caller passes an out-of-range descriptor.
    if !(MIN_TABLE_PAGE_SHIFT..=MAX_TABLE_PAGE_SHIFT).contains(&page_shift) {
        return Err(Errno::EINVAL);
    }
    if payload.len() < TABLE_PAGE_HEADER_SIZE {
        return Err(Errno::EINVAL); // truncated header
    }
    let page_index = r_u64(payload, 0)?;
    let run_count = r_u32(payload, 8)?;
    let declared_entry_count = r_u32(payload, 12)?;
    let page_size = 1u64 << page_shift;

    let mut previous_end: u64 = 0;
    let mut entry_count: u64 = 0;
    let mut offset = TABLE_PAGE_HEADER_SIZE;
    let mut runs: Vec<SparseTableRun> = Vec::new();
    for _ in 0..run_count {
        let run_header_end = offset.checked_add(TABLE_RUN_HEADER_SIZE).ok_or(Errno::EINVAL)?;
        if run_header_end > payload.len() {
            return Err(Errno::EINVAL); // run header truncated
        }
        let start = r_u32(payload, offset)?;
        let count = r_u32(payload, offset + 4)?;
        offset = run_header_end;
        let start64 = start as u64;
        let count64 = count as u64;
        let run_end = start64 + count64; // both u32, sum fits u64
        if count == 0 || start64 < previous_end || start64 >= page_size || run_end > page_size {
            return Err(Errno::EINVAL); // unordered or out-of-bounds run
        }
        let recipes_bytes = (count as usize).checked_mul(4).ok_or(Errno::EINVAL)?;
        let recipes_end = offset.checked_add(recipes_bytes).ok_or(Errno::EINVAL)?;
        if recipes_end > payload.len() {
            return Err(Errno::EINVAL); // run recipes truncated
        }
        let absolute_end = page_index
            .checked_mul(page_size)
            .and_then(|base| base.checked_add(run_end))
            .ok_or(Errno::EINVAL)?;
        if absolute_end > table_length {
            return Err(Errno::EINVAL); // run exceeds final table length
        }
        let mut recipe_ids: Vec<u32> = Vec::with_capacity(count as usize);
        for _ in 0..count {
            recipe_ids.push(r_u32(payload, offset)?);
            offset += 4;
        }
        previous_end = run_end;
        entry_count += count64;
        runs.push(SparseTableRun { start, recipe_ids });
    }
    if run_count == 0 || entry_count != declared_entry_count as u64 || offset != payload.len() {
        return Err(Errno::EINVAL); // counts or payload size inconsistent
    }
    Ok(SparseTablePage {
        page_index,
        runs,
        entry_count: declared_entry_count,
    })
}

// --- Element/data segment bitmap records (kinds 6, 7) --------------------

/// Decoded segment-drop bitmap, shared by `ElementSegments` (kind 6) and
/// `DataSegments` (kind 7). Mirrors the fields `decodeSegmentBitmap` validates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentBitmap {
    /// The number of segments the bitmap covers.
    pub segment_count: u32,
    /// The dropped-segment bitmap, `ceil(segment_count / 8)` bytes; bit `i`
    /// (LSB-first) is set iff segment `i` has been dropped.
    pub dropped: Vec<u8>,
}

/// Shared decoder for the element/data segment-drop bitmap. Mirrors
/// `decodeSegmentBitmap`.
fn decode_segment_bitmap(payload: &[u8], header_size: usize) -> Result<SegmentBitmap, Errno> {
    if payload.len() < header_size {
        return Err(Errno::EINVAL); // truncated header
    }
    let segment_count = r_u32(payload, 0)?;
    let bitmap_bytes = r_u32(payload, 4)?;
    let expected_bytes = segment_count.div_ceil(8);
    if bitmap_bytes != expected_bytes
        || payload.len() as u64 != header_size as u64 + expected_bytes as u64
    {
        return Err(Errno::EINVAL); // bitmap size inconsistent
    }
    if expected_bytes > 0 && segment_count % 8 != 0 {
        // The bits beyond the live segment count in the final byte must be zero.
        let invalid_mask = 0xffu32 << (segment_count % 8);
        let last = payload[payload.len() - 1] as u32;
        if last & invalid_mask != 0 {
            return Err(Errno::EINVAL); // nonzero trailing bits
        }
    }
    let dropped = payload[header_size..].to_vec();
    Ok(SegmentBitmap {
        segment_count,
        dropped,
    })
}

/// Decode an `ElementSegments` (kind 6) record payload. Mirrors
/// `decodeElementSegments`.
pub fn decode_element_segments(payload: &[u8]) -> Result<SegmentBitmap, Errno> {
    decode_segment_bitmap(payload, ELEMENT_SEGMENT_HEADER_SIZE)
}

/// Decode a `DataSegments` (kind 7) record payload. Mirrors
/// `decodeDataSegments`.
pub fn decode_data_segments(payload: &[u8]) -> Result<SegmentBitmap, Errno> {
    decode_segment_bitmap(payload, DATA_SEGMENT_HEADER_SIZE)
}

// --- Envelope resolution -------------------------------------------------

/// A record's payload resolved into its typed form for the pure-byte record
/// kinds this module decodes.
///
/// The raw-TLV path on `ModuleStateRecord` is unchanged; this is an ADDITIVE
/// typed view. Kinds that need cross-record context (a `TablePage` needs its
/// `Table` descriptor's page shift and length) or live instance state (the
/// reference-recipe, replay-event, binding, and continuation records) resolve to
/// [`ModuleStateRecordPayload::Deferred`]; the `TablePage` decoder is exposed
/// directly as [`decode_table_page`] for callers holding the descriptor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModuleStateRecordPayload {
    Module(ModuleDescriptor),
    MutableGlobal(GlobalSnapshot),
    Table(TableDescriptor),
    ElementSegments(SegmentBitmap),
    DataSegments(SegmentBitmap),
    /// A record whose payload is not a context-free pure-byte decode (see the
    /// enum doc comment). Carries the record kind for the caller to route.
    Deferred { kind: u16 },
}

/// The payload byte slice of a decoded record within the guest linear memory.
/// Bounds-checked against `memory`; malformed offsets yield `Err(Errno::EINVAL)`.
pub fn record_payload_bytes<'a>(
    memory: &'a [u8],
    record: &ModuleStateRecord,
) -> Result<&'a [u8], Errno> {
    let start = usize::try_from(record.payload_offset).map_err(|_| Errno::EINVAL)?;
    let size = usize::try_from(record.payload_size).map_err(|_| Errno::EINVAL)?;
    let end = start.checked_add(size).ok_or(Errno::EINVAL)?;
    memory.get(start..end).ok_or(Errno::EINVAL)
}

/// Resolve a decoded record envelope into its typed payload for the pure-byte
/// record kinds. `memory` is the guest linear memory the envelope was decoded
/// from. Malformed input yields `Err(Errno::EINVAL)`; the function never panics.
pub fn decode_record_payload(
    memory: &[u8],
    record: &ModuleStateRecord,
) -> Result<ModuleStateRecordPayload, Errno> {
    let payload = record_payload_bytes(memory, record)?;
    let kind = record.kind;
    if kind == abi::WPK_FORK_MODULE_STATE_RECORD_KIND_MODULE {
        Ok(ModuleStateRecordPayload::Module(decode_module_record(payload)?))
    } else if kind == abi::WPK_FORK_MODULE_STATE_RECORD_KIND_MUTABLE_GLOBAL {
        Ok(ModuleStateRecordPayload::MutableGlobal(decode_mutable_global(
            payload,
        )?))
    } else if kind == abi::WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE {
        Ok(ModuleStateRecordPayload::Table(decode_table_descriptor(
            payload,
        )?))
    } else if kind == abi::WPK_FORK_MODULE_STATE_RECORD_KIND_ELEMENT_SEGMENTS {
        Ok(ModuleStateRecordPayload::ElementSegments(
            decode_element_segments(payload)?,
        ))
    } else if kind == abi::WPK_FORK_MODULE_STATE_RECORD_KIND_DATA_SEGMENTS {
        Ok(ModuleStateRecordPayload::DataSegments(decode_data_segments(
            payload,
        )?))
    } else {
        Ok(ModuleStateRecordPayload::Deferred { kind })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::module_state::{decode_module_state, ModuleStateFormat};

    // -- Module record encoder (census section 139) --------------------------

    // -- Imported-global binding builder (census section 150) ----------------

    const REF: u8 = abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF;
    const EXN: u8 = abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF;
    const I32: u8 = abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32;

    fn prov(consumer: (u32, u32), kind: u8) -> ImportedGlobalProvenance {
        ImportedGlobalProvenance {
            consumer_activation: consumer.0,
            consumer_owner: consumer.1,
            kind,
            group_id: 0,
            raw_bits: 0,
        }
    }
    fn decl(consumer: (u32, u32), type_code: u8) -> ImportedGlobalDeclaration {
        ImportedGlobalDeclaration { activation: consumer.0, owner: consumer.1, type_code }
    }
    fn group(member: (u32, u32), group_id: u32) -> GlobalIdentityGroup {
        GlobalIdentityGroup { activation: member.0, owner: member.1, group_id }
    }
    fn snap(consumer: (u32, u32), type_code: u8, recipe: Option<u32>) -> ImportedGlobalSnapshotFact {
        ImportedGlobalSnapshotFact {
            activation: consumer.0,
            owner: consumer.1,
            type_code,
            recipe_id: recipe,
        }
    }

    #[test]
    fn the_owner_of_a_shared_global_is_elected_over_its_importers() {
        // Activation 9 declares the global; 3 imports it and 5 imports it too.
        // All three export it in their catalogs, so identity alone cannot say
        // who provides it -- only KFIG can, and only this side reads KFIG.
        //
        // The owner deliberately has the HIGHEST coordinate here: with the
        // importers left in, "lowest member" would pick activation 3, which
        // imports the value and has nothing to hand the child.
        let mut p = prov((3, 1), abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL);
        p.group_id = 7;
        let built = build_imported_global_bindings(
            &[p],
            &[decl((3, 1), I32), decl((5, 2), I32)],
            &[snap((3, 1), I32, None)],
            &[group((9, 5), 7), group((3, 1), 7), group((5, 2), 7)],
        )
        .unwrap();
        assert_eq!(built.len(), 1);
        assert_eq!(built[0].kind, abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL);
        assert_eq!((built[0].source_activation, built[0].source_owner), (9, 5));
        assert_eq!(built[0].type_code, I32, "type comes from the declaration");
    }

    #[test]
    fn the_lowest_coordinate_wins_among_several_owners() {
        // Two activations can legitimately declare the same object when neither
        // imports it from the other -- the host handed both the same Global. The
        // choice has to be stable across runs, so it is the lowest coordinate.
        let mut p = prov((9, 1), abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL);
        p.group_id = 2;
        let built = build_imported_global_bindings(
            &[p],
            &[decl((9, 1), I32)],
            &[snap((9, 1), I32, None)],
            &[group((4, 9), 2), group((4, 3), 2), group((2, 8), 2)],
        )
        .unwrap();
        assert_eq!((built[0].source_activation, built[0].source_owner), (2, 8));
    }

    #[test]
    fn a_global_no_activation_provides_becomes_a_base_import() {
        // Two ways to reach the same conclusion, and the host may state neither:
        // an object in no catalog at all (group 0), and a group whose every
        // member imports it. Both mean the child takes the value from its own
        // base imports.
        // Group 0 is "ungrouped", not a group: other ungrouped members are
        // listed alongside to show they are not silently collected into one.
        let ungrouped = prov((3, 1), abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL);
        let built = build_imported_global_bindings(
            &[ungrouped],
            &[decl((3, 1), I32)],
            &[snap((3, 1), I32, None)],
            &[group((1, 4), 0), group((2, 6), 0)],
        )
        .unwrap();
        assert_eq!(built[0].kind, abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT);
        assert_eq!((built[0].source_activation, built[0].source_owner), (0, 0));

        let mut all_importers = ungrouped;
        all_importers.group_id = 4;
        let built = build_imported_global_bindings(
            &[all_importers],
            &[decl((3, 1), I32), decl((6, 2), I32)],
            &[snap((3, 1), I32, None)],
            &[group((3, 1), 4), group((6, 2), 4)],
        )
        .unwrap();
        assert_eq!(built[0].kind, abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT);
    }

    #[test]
    fn a_host_published_base_import_is_refused() {
        // `BASE_IMPORT` is a conclusion of the election, never an input. A host
        // publishing it would be asserting that no activation provides the
        // object -- the one judgement it cannot make without reading KFIG.
        assert_eq!(
            build_imported_global_bindings(
                &[prov((3, 1), abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT)],
                &[decl((3, 1), I32)],
                &[snap((3, 1), I32, None)],
                &[],
            ),
            Err(Errno::EINVAL),
        );
    }

    // -- Imported-table binding builder (census section 154) ----------------

    fn tdecl(consumer: (u32, u32)) -> ImportedTableDeclaration {
        ImportedTableDeclaration { activation: consumer.0, owner: consumer.1 }
    }
    fn tprov(consumer: (u32, u32), group_id: u32) -> ImportedTableProvenance {
        ImportedTableProvenance {
            consumer_activation: consumer.0,
            consumer_owner: consumer.1,
            group_id,
        }
    }

    #[test]
    fn a_table_is_provided_by_the_member_that_does_not_import_it() {
        // Same election as the globals, and the owner again carries the highest
        // coordinate so that leaving the importers in would pick the wrong one.
        let built = build_imported_table_bindings(
            &[tprov((3, 1), 7)],
            &[tdecl((3, 1)), tdecl((5, 2))],
            &[group((9, 4), 7), group((3, 1), 7), group((5, 2), 7)],
        )
        .unwrap();
        assert_eq!(built.len(), 1);
        assert_eq!(built[0].kind, abi::WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE);
        assert_eq!((built[0].source_activation, built[0].source_owner), (9, 4));
    }

    #[test]
    fn a_table_no_activation_provides_becomes_a_base_import() {
        let built = build_imported_table_bindings(
            &[tprov((3, 1), 0)],
            &[tdecl((3, 1))],
            &[group((1, 4), 0)],
        )
        .unwrap();
        assert_eq!(built[0].kind, abi::WPK_FORK_IMPORTED_TABLE_BINDING_BASE_IMPORT);
        assert_eq!((built[0].source_activation, built[0].source_owner), (0, 0));
    }

    #[test]
    fn table_provenance_with_no_declaration_is_refused() {
        // The host named a table the activation's KFIT section does not declare:
        // the two halves of the contract disagreeing.
        assert_eq!(
            build_imported_table_bindings(&[tprov((3, 1), 0)], &[tdecl((3, 2))], &[]),
            Err(Errno::EINVAL),
        );
    }

    #[test]
    fn built_table_bindings_encode_at_the_size_they_report() {
        // The builder and the encoder are a pair: sorted, unique consumers is
        // what one produces and what the other demands.
        let built = build_imported_table_bindings(
            &[tprov((2, 1), 0), tprov((0, 9), 0), tprov((0, 1), 0)],
            &[tdecl((2, 1)), tdecl((0, 9)), tdecl((0, 1))],
            &[],
        )
        .unwrap();
        let keys: Vec<(u32, u32)> =
            built.iter().map(|b| (b.consumer_activation, b.consumer_owner)).collect();
        assert_eq!(keys, alloc::vec![(0, 1), (0, 9), (2, 1)]);
        let mut out = alloc::vec![0u8; imported_table_bindings_size(built.len()).unwrap()];
        assert!(encode_imported_table_bindings(&mut out, &built).is_ok());
        // The header the child's decoder checks, and the count it walks by.
        assert_eq!(&out[0..4], &abi::WPK_FORK_IMPORTED_TABLE_BINDINGS_MAGIC);
        assert_eq!(
            u32::from_le_bytes([out[12], out[13], out[14], out[15]]),
            3,
            "count",
        );
        // A buffer of the wrong length is refused rather than partly written.
        let mut short = alloc::vec![0u8; out.len() - 1];
        assert_eq!(
            encode_imported_table_bindings(&mut short, &built),
            Err(Errno::EINVAL),
        );
    }

    // -- Binding record decoders (census section 169) ------------------------

    fn encoded_globals() -> Vec<u8> {
        let built = build_imported_global_bindings(
            &[
                prov((0, 1), abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER),
                prov((3, 2), abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL),
            ],
            &[decl((0, 1), I32), decl((3, 2), I32)],
            &[snap((0, 1), I32, None), snap((3, 2), I32, None)],
            &[group((9, 4), 0)],
        )
        .unwrap();
        let mut out = alloc::vec![0u8; imported_global_bindings_size(built.len()).unwrap()];
        encode_imported_global_bindings(&mut out, &built).unwrap();
        out
    }

    #[test]
    fn a_global_binding_record_round_trips_field_for_field() {
        // The child reads what the parent wrote and nothing else, so the pair
        // has to agree on every field -- a decoder that silently dropped one
        // would bind an import from a default.
        let bytes = encoded_globals();
        let decoded = decode_imported_global_bindings(&bytes).unwrap();
        assert_eq!(decoded.len(), 2);
        assert_eq!(
            (decoded[0].consumer_activation, decoded[0].consumer_owner),
            (0, 1),
        );
        assert_eq!(decoded[0].kind, abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER);
        assert_eq!(decoded[0].type_code, I32);
        assert_eq!(
            (decoded[1].consumer_activation, decoded[1].consumer_owner),
            (3, 2),
        );
        // Group 0 elected nobody, so the builder wrote a base import.
        assert_eq!(decoded[1].kind, abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT);
    }

    #[test]
    fn a_table_binding_record_round_trips() {
        let built = build_imported_table_bindings(
            &[tprov((2, 1), 5)],
            &[tdecl((2, 1))],
            &[group((7, 3), 5)],
        )
        .unwrap();
        let mut bytes =
            alloc::vec![0u8; imported_table_bindings_size(built.len()).unwrap()];
        encode_imported_table_bindings(&mut bytes, &built).unwrap();
        let decoded = decode_imported_table_bindings(&bytes).unwrap();
        assert_eq!(decoded.len(), 1);
        assert_eq!((decoded[0].source_activation, decoded[0].source_owner), (7, 3));
        assert_eq!(decoded[0].kind, abi::WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE);
    }

    #[test]
    fn a_binding_record_from_another_writer_is_refused() {
        // These bytes come out of an arena the PARENT mapped and this process
        // inherited -- shared memory another process wrote. Every framing field
        // is therefore checked rather than trusted.
        let good = encoded_globals();

        let mut wrong_magic = good.clone();
        wrong_magic[0] = b'X';
        assert_eq!(decode_imported_global_bindings(&wrong_magic), Err(Errno::EINVAL));

        let mut wrong_version = good.clone();
        wrong_version[4] = 9;
        assert_eq!(decode_imported_global_bindings(&wrong_version), Err(Errno::EINVAL));

        let mut wrong_entry_size = good.clone();
        wrong_entry_size[8] = 41;
        assert_eq!(
            decode_imported_global_bindings(&wrong_entry_size),
            Err(Errno::EINVAL),
        );

        let mut unknown_flags = good.clone();
        unknown_flags[10] = 1;
        assert_eq!(decode_imported_global_bindings(&unknown_flags), Err(Errno::EINVAL));

        let mut count_disagrees = good.clone();
        count_disagrees[12] = 7;
        assert_eq!(
            decode_imported_global_bindings(&count_disagrees),
            Err(Errno::EINVAL),
        );

        assert_eq!(
            decode_imported_global_bindings(&good[..good.len() - 1]),
            Err(Errno::EINVAL),
            "a truncated record",
        );
    }

    #[test]
    fn a_binding_record_that_would_bind_one_import_twice_is_refused() {
        // A repeated consumer leaves the child taking whichever entry it reads
        // last, silently. An undefined kind leaves it with no way to
        // materialise the import at all, and a zero owner names nothing.
        let header = abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE as usize;
        let entry = abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE as usize;

        let mut repeated = encoded_globals();
        let first_consumer: Vec<u8> = repeated[header..header + 8].to_vec();
        repeated[header + entry..header + entry + 8].copy_from_slice(&first_consumer);
        assert_eq!(decode_imported_global_bindings(&repeated), Err(Errno::EINVAL));

        let mut undefined_kind = encoded_globals();
        undefined_kind[header + 32] = 99;
        assert_eq!(
            decode_imported_global_bindings(&undefined_kind),
            Err(Errno::EINVAL),
        );

        let mut zero_owner = encoded_globals();
        zero_owner[header + 4..header + 8].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(decode_imported_global_bindings(&zero_owner), Err(Errno::EINVAL));
    }

    #[test]
    fn arbitrary_corruption_of_a_binding_record_never_panics() {
        // The bytes are guest-visible, so every single-byte corruption has to
        // come back as an error rather than an index panic inside the module.
        let good = encoded_globals();
        for index in 0..good.len() {
            for bit in 0..8 {
                let mut bytes = good.clone();
                bytes[index] ^= 1 << bit;
                let _ = decode_imported_global_bindings(&bytes);
            }
        }
        for length in 0..good.len() {
            let _ = decode_imported_global_bindings(&good[..length]);
        }
    }

    #[test]
    fn the_table_encoder_refuses_what_no_child_could_read() {
        // Both refusals are about the CHILD's decoder, which walks entries in
        // order and switches on the kind byte. An undefined kind leaves it with
        // no way to materialise the import, and a repeated consumer leaves it
        // binding one import twice -- the second write silently winning.
        let binding = ImportedTableBinding {
            consumer_activation: 0,
            consumer_owner: 1,
            source_activation: 0,
            source_owner: 0,
            kind: abi::WPK_FORK_IMPORTED_TABLE_BINDING_BASE_IMPORT,
        };
        let mut out = alloc::vec![0u8; imported_table_bindings_size(1).unwrap()];
        assert!(encode_imported_table_bindings(&mut out, &[binding]).is_ok());

        let mut undefined = binding;
        undefined.kind = 0;
        assert_eq!(
            encode_imported_table_bindings(&mut out, &[undefined]),
            Err(Errno::EINVAL),
        );

        let mut two = alloc::vec![0u8; imported_table_bindings_size(2).unwrap()];
        assert_eq!(
            encode_imported_table_bindings(&mut two, &[binding, binding]),
            Err(Errno::EINVAL),
        );
    }

    #[test]
    fn a_reference_binding_takes_its_recipe_from_the_snapshot() {
        // For a reference the host could not carry, the recipe IS the binding —
        // the child has nothing else to reconstruct the referent from.
        let built = build_imported_global_bindings(
            &[prov((0, 2), abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE)],
            &[decl((0, 2), REF)],
            &[snap((0, 2), REF, Some(77))],
            &[],
        )
        .unwrap();
        assert_eq!(built[0].recipe_id, 77);
    }

    #[test]
    fn a_snapshot_that_disagrees_with_the_declaration_is_refused() {
        // Two module-owned artifacts describing one global differently means one
        // is being read against the wrong record. Refusing beats binding a
        // child's import to a value of another type.
        assert_eq!(
            build_imported_global_bindings(
                &[prov((0, 1), abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER)],
                &[decl((0, 1), I32)],
                &[snap((0, 1), REF, None)],
                &[],
            ),
            Err(Errno::EINVAL),
        );
    }

    #[test]
    fn a_reference_without_a_recipe_is_refused() {
        assert_eq!(
            build_imported_global_bindings(
                &[prov((0, 1), abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE)],
                &[decl((0, 1), REF)],
                &[snap((0, 1), REF, None)],
                &[],
            ),
            Err(Errno::EINVAL),
        );
    }

    #[test]
    fn a_non_null_exnref_without_a_carrier_is_refused() {
        // JavaScript cannot hold a non-null exnref, so a legitimate one is
        // necessarily carried by a WebAssembly.Global. Emitting a raw reference
        // would manufacture a child transport the embedding API cannot express.
        assert_eq!(
            build_imported_global_bindings(
                &[prov((0, 1), abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE)],
                &[decl((0, 1), EXN)],
                &[snap((0, 1), EXN, Some(4))],
                &[],
            ),
            Err(Errno::EINVAL),
        );
        // A NULL exnref is fine: recipe 0 is the null referent.
        assert!(build_imported_global_bindings(
            &[prov((0, 1), abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE)],
            &[decl((0, 1), EXN)],
            &[snap((0, 1), EXN, Some(0))],
            &[],
        )
        .is_ok());
    }

    #[test]
    fn built_bindings_come_back_sorted_for_the_encoder() {
        // The encoder demands sorted, unique consumers. Sorting here means the
        // host is not required to publish provenance in any order, which keeps
        // one more rule out of the half that has to stay in JavaScript.
        let k = abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER;
        let built = build_imported_global_bindings(
            &[prov((2, 0), k), prov((0, 9), k), prov((0, 1), k)],
            &[decl((2, 0), I32), decl((0, 9), I32), decl((0, 1), I32)],
            &[snap((2, 0), I32, None), snap((0, 9), I32, None), snap((0, 1), I32, None)],
            &[],
        )
        .unwrap();
        let keys: Vec<(u32, u32)> =
            built.iter().map(|b| (b.consumer_activation, b.consumer_owner)).collect();
        assert_eq!(keys, alloc::vec![(0, 1), (0, 9), (2, 0)]);
        // And the encoder accepts what the builder produced, which is the pairing
        // that matters.
        let mut out = alloc::vec![0u8; imported_global_bindings_size(built.len()).unwrap()];
        assert!(encode_imported_global_bindings(&mut out, &built).is_ok());
    }

    // -- Imported-global bindings encoder (census section 150) ---------------

    fn binding(consumer: (u32, u32), kind: u8) -> ImportedGlobalBinding {
        ImportedGlobalBinding {
            consumer_activation: consumer.0,
            consumer_owner: consumer.1,
            source_activation: 0,
            source_owner: 0,
            recipe_id: 0,
            raw_bits: 0,
            kind,
            flags: 0,
            type_code: 1,
        }
    }

    #[test]
    fn bindings_land_at_the_offsets_the_child_decoder_reads() {
        // The byte layout IS the contract: the child side decodes these to wire
        // its imports, so an offset that drifts is a child reading one field as
        // another. Asserted positionally rather than round-tripped, because
        // nothing on this side decodes them yet and writing a decoder purely to
        // test the encoder would be writing code no caller wants.
        let header = abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE as usize;
        let mut b = binding((3, 7), abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL);
        b.source_activation = 1;
        b.source_owner = 2;
        b.recipe_id = 9;
        b.raw_bits = 0xdead_beef_0000_0001;
        b.type_code = 4;
        // DIRTY, deliberately. The record lands in a freshly channel-mmap'd
        // chunk, which is not guaranteed zero, and the reserved fields and entry
        // padding must read as zero regardless. A zeroed buffer here would let
        // the encoder skip clearing them and nothing would notice.
        let mut out = alloc::vec![0xFFu8; imported_global_bindings_size(1).unwrap()];
        encode_imported_global_bindings(&mut out, &[b]).unwrap();

        assert_eq!(&out[0..4], &abi::WPK_FORK_IMPORTED_GLOBAL_BINDINGS_MAGIC);
        assert_eq!(u32::from_le_bytes(out[12..16].try_into().unwrap()), 1, "count");
        assert_eq!(u64::from_le_bytes(out[16..24].try_into().unwrap()), 0, "reserved");
        let at = header;
        assert_eq!(u32::from_le_bytes(out[at..at + 4].try_into().unwrap()), 3);
        assert_eq!(u32::from_le_bytes(out[at + 4..at + 8].try_into().unwrap()), 7);
        assert_eq!(u32::from_le_bytes(out[at + 8..at + 12].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(out[at + 12..at + 16].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(out[at + 16..at + 20].try_into().unwrap()), 0, "reserved");
        assert_eq!(u32::from_le_bytes(out[at + 20..at + 24].try_into().unwrap()), 9);
        assert_eq!(u64::from_le_bytes(out[at + 24..at + 32].try_into().unwrap()), b.raw_bits);
        assert_eq!(out[at + 32], abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL);
        assert_eq!(out[at + 34], 4, "type code");
        assert_eq!(&out[at + 35..at + 40], &[0u8; 5], "entry padding stays zero");
    }

    #[test]
    fn bindings_refuse_a_duplicate_or_unsorted_consumer() {
        // A duplicate consumer means two different sources for one import, and
        // whichever the child reads last wins -- a coin flip deciding whether
        // two activations share a global. Refused rather than resolved.
        let k = abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT;
        let mut out = alloc::vec![0u8; imported_global_bindings_size(2).unwrap()];
        assert_eq!(
            encode_imported_global_bindings(&mut out, &[binding((1, 1), k), binding((1, 1), k)]),
            Err(Errno::EINVAL),
        );
        assert_eq!(
            encode_imported_global_bindings(&mut out, &[binding((2, 0), k), binding((1, 0), k)]),
            Err(Errno::EINVAL),
        );
        // ...and accepts them the right way round.
        assert!(
            encode_imported_global_bindings(&mut out, &[binding((1, 0), k), binding((2, 0), k)])
                .is_ok()
        );
    }

    #[test]
    fn bindings_refuse_a_kind_the_format_does_not_define() {
        // The kind drives how a child materialises the import. An undefined one
        // is not a value the child can fall back from.
        let mut out = alloc::vec![0u8; imported_global_bindings_size(1).unwrap()];
        assert_eq!(
            encode_imported_global_bindings(&mut out, &[binding((0, 0), 0)]),
            Err(Errno::EINVAL),
        );
        assert_eq!(
            encode_imported_global_bindings(&mut out, &[binding((0, 0), 99)]),
            Err(Errno::EINVAL),
        );
    }

    #[test]
    fn bindings_refuse_a_buffer_that_is_not_the_payload_size() {
        // The caller reserves by `imported_global_bindings_size`, so a mismatch
        // means the reserve and the write disagree about how many entries there
        // are -- and the write runs past the record.
        let k = abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT;
        let mut short = alloc::vec![0u8; imported_global_bindings_size(1).unwrap() - 1];
        assert_eq!(
            encode_imported_global_bindings(&mut short, &[binding((0, 0), k)]),
            Err(Errno::EINVAL),
        );
        let mut two = alloc::vec![0u8; imported_global_bindings_size(2).unwrap()];
        assert_eq!(
            encode_imported_global_bindings(&mut two, &[binding((0, 0), k)]),
            Err(Errno::EINVAL),
        );
    }

    #[test]
    fn a_journal_image_record_round_trips_through_its_own_decoder() {
        let mut payload = [0u8; abi::WPK_FORK_JOURNAL_IMAGE_PAYLOAD_SIZE as usize];
        encode_journal_image(&mut payload, 0x1_0000, 4096).unwrap();
        assert_eq!(decode_journal_image(&payload).unwrap(), (0x1_0000, 4096));
    }

    #[test]
    fn a_journal_image_clears_the_reserved_fields_it_is_handed() {
        // The record lands in a freshly channel-mmap'd chunk, which is not
        // guaranteed zero, and the decoder rejects a nonzero reserved field.
        let mut payload = [0xFFu8; abi::WPK_FORK_JOURNAL_IMAGE_PAYLOAD_SIZE as usize];
        encode_journal_image(&mut payload, 0x2_0000, 64).unwrap();
        assert_eq!(decode_journal_image(&payload).unwrap(), (0x2_0000, 64));
    }

    #[test]
    fn a_journal_image_refuses_a_zero_pointer_or_length() {
        // A zero here means an image that was never serialized. A child
        // inheriting the record would seed its journal from address 0, which is
        // the failure the decoder already refuses on the way back in.
        let mut payload = [0u8; abi::WPK_FORK_JOURNAL_IMAGE_PAYLOAD_SIZE as usize];
        assert_eq!(encode_journal_image(&mut payload, 0, 4096), Err(Errno::EINVAL));
        assert_eq!(encode_journal_image(&mut payload, 0x1000, 0), Err(Errno::EINVAL));
    }

    #[test]
    fn a_module_record_round_trips_through_its_own_decoder() {
        // The encoder is only correct if the DECODER accepts what it writes --
        // and the decoder here is the one the module's own child-install path
        // reads the activation set with, so a mismatch means an arena that
        // installs nothing rather than one that fails.
        let descriptor = ModuleDescriptor {
            template_id: [0xA5; MODULE_TEMPLATE_ID_SIZE],
            flags: 0,
        };
        let mut payload = [0u8; MODULE_RECORD_PAYLOAD_SIZE];
        encode_module_record(&mut payload, &descriptor).unwrap();
        assert_eq!(decode_module_record(&payload).unwrap(), descriptor);
    }

    #[test]
    fn encoding_clears_the_reserved_word_it_is_handed() {
        // Records are written into freshly channel-mmap'd guest memory, which is
        // not guaranteed zero, and the decoder rejects a nonzero reserved field.
        // Leaving it alone would produce a record that fails to decode only when
        // the mapping happened to be dirty.
        let mut payload = [0xFFu8; MODULE_RECORD_PAYLOAD_SIZE];
        encode_module_record(
            &mut payload,
            &ModuleDescriptor { template_id: [7; MODULE_TEMPLATE_ID_SIZE], flags: 0 },
        )
        .unwrap();
        assert!(decode_module_record(&payload).is_ok());
    }

    #[test]
    fn encoding_refuses_a_flag_the_decoder_would_reject() {
        // Writing an unknown flag produces a record this crate cannot read
        // back. Refusing at the encoder keeps that from being discovered in a
        // child, mid-install.
        let mut payload = [0u8; MODULE_RECORD_PAYLOAD_SIZE];
        let bad = ModuleDescriptor {
            template_id: [0; MODULE_TEMPLATE_ID_SIZE],
            flags: !MODULE_RECORD_KNOWN_FLAGS,
        };
        assert_eq!(encode_module_record(&mut payload, &bad), Err(Errno::EINVAL));
    }

    #[test]
    fn encoding_refuses_a_buffer_that_is_not_the_payload_size() {
        // The caller reserves by MODULE_RECORD_PAYLOAD_SIZE, so a different
        // length means the reserve and the write disagree -- which would write
        // past a record boundary into the next one.
        let descriptor = ModuleDescriptor {
            template_id: [1; MODULE_TEMPLATE_ID_SIZE],
            flags: 0,
        };
        let mut short = [0u8; MODULE_RECORD_PAYLOAD_SIZE - 1];
        assert_eq!(encode_module_record(&mut short, &descriptor), Err(Errno::EINVAL));
        let mut long = [0u8; MODULE_RECORD_PAYLOAD_SIZE + 1];
        assert_eq!(encode_module_record(&mut long, &descriptor), Err(Errno::EINVAL));
    }

    const PW: u8 = 4;
    const CHUNK_HEADER: u32 = 40;

    fn wasm32_format() -> ModuleStateFormat {
        ModuleStateFormat {
            pointer_width: PW,
            chunk_header_size: CHUNK_HEADER,
        }
    }

    // --- Cross-language fixture (emitted by the real TS arena encoders) ----

    /// Bytes are the used prefix of a sealed root arena chunk emitted by the
    /// REAL host `ForkModuleStateArena` (the same encoder the guest fork path
    /// mirrors), via `crates/fork-codec/testdata/gen-module-state-records-fixture.mts`.
    /// That generator drives `appendModule` / `appendRecord(MutableGlobal)` /
    /// `appendSparseTable` (which itself round-trips through the real
    /// `decodeTableDescriptor` + `validateSparseTablePage`) /
    /// `appendElementSegmentState` / `appendDataSegmentState`, then re-decodes
    /// the committed bytes with the real host decoders as a cross-check. If the
    /// TS encoders/decoders and these Rust decoders ever disagree on a payload
    /// layout, this test catches the drift.
    const FIXTURE: &[u8] = include_bytes!("../testdata/module-state-records-wasm32.bin");
    const FIXTURE_ROOT: u64 = 65_536;
    const FIXTURE_CAPACITY: u64 = 65_536;

    fn fixture_memory() -> Vec<u8> {
        let mut mem = alloc::vec![0u8; FIXTURE_ROOT as usize];
        mem.extend_from_slice(FIXTURE);
        mem.resize((FIXTURE_ROOT + FIXTURE_CAPACITY) as usize, 0);
        mem
    }

    /// Decode the fixture envelope and return every record's typed payload plus
    /// the raw envelope record (for the `TablePage`, which needs descriptor
    /// context resolved by the caller).
    fn decoded_fixture() -> (Vec<u8>, Vec<ModuleStateRecord>) {
        let mem = fixture_memory();
        let state = decode_module_state(&mem, FIXTURE_ROOT, &wasm32_format()).unwrap();
        (mem, state.records)
    }

    #[test]
    fn decodes_every_pure_byte_record_field_for_field() {
        let (mem, records) = decoded_fixture();

        // The fixture carries one record of each pure-byte kind, in this order:
        // Module, MutableGlobal(i32), MutableGlobal(funcref), Table, TablePage,
        // ElementSegments, DataSegments.
        assert_eq!(records.len(), 7);

        // Module (kind 1): template id filled with 0xa0, no flags.
        let module = match decode_record_payload(&mem, &records[0]).unwrap() {
            ModuleStateRecordPayload::Module(m) => m,
            other => panic!("expected Module, got {other:?}"),
        };
        assert_eq!(module.template_id, [0xa0u8; 32]);
        assert_eq!(module.flags, 0);

        // MutableGlobal i32 (kind 3): value 0x0908_0706, no recipe id.
        let global_i32 = match decode_record_payload(&mem, &records[1]).unwrap() {
            ModuleStateRecordPayload::MutableGlobal(g) => g,
            other => panic!("expected MutableGlobal, got {other:?}"),
        };
        assert_eq!(
            global_i32.type_code,
            abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32
        );
        assert_eq!(global_i32.value, alloc::vec![0x06, 0x07, 0x08, 0x09]);
        assert_eq!(global_i32.recipe_id, None);

        // MutableGlobal funcref (kind 3): reference type exposes the recipe id.
        let global_ref = match decode_record_payload(&mem, &records[2]).unwrap() {
            ModuleStateRecordPayload::MutableGlobal(g) => g,
            other => panic!("expected MutableGlobal, got {other:?}"),
        };
        assert_eq!(
            global_ref.type_code,
            abi::WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF
        );
        assert_eq!(global_ref.value, alloc::vec![0x44, 0x33, 0x22, 0x11]);
        assert_eq!(global_ref.recipe_id, Some(0x1122_3344));

        // Table descriptor (kind 4).
        let table = match decode_record_payload(&mem, &records[3]).unwrap() {
            ModuleStateRecordPayload::Table(t) => t,
            other => panic!("expected Table, got {other:?}"),
        };
        assert_eq!(table.index_width, 4);
        assert_eq!(table.page_shift, 10);
        assert_eq!(table.flags, TABLE_FLAG_SPARSE_OVERRIDES);
        assert_eq!(table.page_count, 1);
        assert_eq!(table.length, 4096);
        assert_eq!(table.baseline_length, 16);
        assert_eq!(table.baseline_fingerprint, [0xbbu8; 32]);

        // TablePage (kind 5): needs the descriptor's page shift + length. The
        // envelope auto-resolver defers it; decode it directly.
        assert_eq!(
            decode_record_payload(&mem, &records[4]).unwrap(),
            ModuleStateRecordPayload::Deferred {
                kind: abi::WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE_PAGE,
            }
        );
        let page_bytes = record_payload_bytes(&mem, &records[4]).unwrap();
        let page = decode_table_page(page_bytes, table.page_shift, table.length).unwrap();
        assert_eq!(page.page_index, 0);
        assert_eq!(page.entry_count, 4);
        assert_eq!(
            page.runs,
            alloc::vec![
                SparseTableRun {
                    start: 2,
                    recipe_ids: alloc::vec![7, 8, 9],
                },
                SparseTableRun {
                    start: 10,
                    recipe_ids: alloc::vec![42],
                },
            ]
        );

        // ElementSegments (kind 6): 12 segments, 2-byte bitmap.
        let elements = match decode_record_payload(&mem, &records[5]).unwrap() {
            ModuleStateRecordPayload::ElementSegments(s) => s,
            other => panic!("expected ElementSegments, got {other:?}"),
        };
        assert_eq!(elements.segment_count, 12);
        assert_eq!(elements.dropped, alloc::vec![0xb5, 0x0a]);

        // DataSegments (kind 7): 8 segments, 1-byte bitmap.
        let data = match decode_record_payload(&mem, &records[6]).unwrap() {
            ModuleStateRecordPayload::DataSegments(s) => s,
            other => panic!("expected DataSegments, got {other:?}"),
        };
        assert_eq!(data.segment_count, 8);
        assert_eq!(data.dropped, alloc::vec![0xc3]);
    }

    #[test]
    fn fixture_is_non_vacuous() {
        // Guard against a fixture that collapses to a trivial shape which would
        // make the field-for-field test vacuously pass.
        let (mem, records) = decoded_fixture();
        let kinds: Vec<u16> = records.iter().map(|r| r.kind).collect();
        assert_eq!(kinds, alloc::vec![1, 3, 3, 4, 5, 6, 7]);
        // A reference global with a recipe id and a numeric global without one
        // both survived the round trip.
        let ref_global = decode_mutable_global(record_payload_bytes(&mem, &records[2]).unwrap())
            .unwrap();
        assert!(ref_global.recipe_id.is_some());
        // The sparse table carries more than one run and more than one entry.
        let table = decode_table_descriptor(record_payload_bytes(&mem, &records[3]).unwrap())
            .unwrap();
        let page = decode_table_page(
            record_payload_bytes(&mem, &records[4]).unwrap(),
            table.page_shift,
            table.length,
        )
        .unwrap();
        assert!(page.runs.len() >= 2);
        assert!(page.entry_count >= 2);
        // The element bitmap has at least one dropped segment.
        let elements =
            decode_element_segments(record_payload_bytes(&mem, &records[5]).unwrap()).unwrap();
        assert!(elements.dropped.iter().any(|&b| b != 0));
    }

    // --- Module record negatives ------------------------------------------

    fn module_payload() -> Vec<u8> {
        let mut p = alloc::vec![0u8; MODULE_RECORD_PAYLOAD_SIZE];
        for byte in p.iter_mut().take(MODULE_TEMPLATE_ID_SIZE) {
            *byte = 0x5a;
        }
        p
    }

    #[test]
    fn decodes_minimal_module_record() {
        let decoded = decode_module_record(&module_payload()).unwrap();
        assert_eq!(decoded.template_id, [0x5au8; 32]);
        assert_eq!(decoded.flags, 0);
    }

    #[test]
    fn rejects_module_wrong_size() {
        assert_eq!(
            decode_module_record(&module_payload()[..MODULE_RECORD_PAYLOAD_SIZE - 1]),
            Err(Errno::EINVAL)
        );
        let mut too_long = module_payload();
        too_long.push(0);
        assert_eq!(decode_module_record(&too_long), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_module_unknown_flags() {
        let mut p = module_payload();
        p[MODULE_TEMPLATE_ID_SIZE] = 1; // any flag bit is unknown (known == none)
        assert_eq!(decode_module_record(&p), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_module_nonzero_reserved() {
        let mut p = module_payload();
        p[MODULE_TEMPLATE_ID_SIZE + 4] = 1;
        assert_eq!(decode_module_record(&p), Err(Errno::EINVAL));
    }

    // --- Mutable global negatives -----------------------------------------

    fn global_payload(type_code: u8, value: &[u8]) -> Vec<u8> {
        let mut p = alloc::vec![0u8; GLOBAL_HEADER_SIZE + value.len()];
        p[0] = type_code;
        p[1] = value.len() as u8;
        p[GLOBAL_HEADER_SIZE..].copy_from_slice(value);
        p
    }

    #[test]
    fn decodes_i64_and_v128_and_ref_globals() {
        let i64_global =
            decode_mutable_global(&global_payload(2, &[1, 2, 3, 4, 5, 6, 7, 8])).unwrap();
        assert_eq!(i64_global.value.len(), 8);
        assert_eq!(i64_global.recipe_id, None);

        let v128 = decode_mutable_global(&global_payload(5, &[9u8; 16])).unwrap();
        assert_eq!(v128.value.len(), 16);
        assert_eq!(v128.recipe_id, None);

        let externref =
            decode_mutable_global(&global_payload(7, &[0x21, 0x43, 0x65, 0x87])).unwrap();
        assert_eq!(externref.recipe_id, Some(0x8765_4321));
    }

    #[test]
    fn rejects_global_unknown_type() {
        assert_eq!(
            decode_mutable_global(&global_payload(0, &[1, 2, 3, 4])),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            decode_mutable_global(&global_payload(10, &[1, 2, 3, 4])),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_global_wrong_value_size() {
        // i32 wants 4 value bytes; give it 8.
        let mut p = global_payload(1, &[1, 2, 3, 4]);
        p[1] = 8; // claim 8 while payload holds 4
        assert_eq!(decode_mutable_global(&p), Err(Errno::EINVAL));
        // Correct declared size but wrong payload length.
        let mut short = global_payload(1, &[1, 2, 3, 4]);
        short.pop();
        assert_eq!(decode_mutable_global(&short), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_global_nonzero_reserved() {
        let mut p = global_payload(1, &[1, 2, 3, 4]);
        p[2] = 1; // u16 reserved
        assert_eq!(decode_mutable_global(&p), Err(Errno::EINVAL));
        let mut q = global_payload(1, &[1, 2, 3, 4]);
        q[4] = 1; // u32 reserved
        assert_eq!(decode_mutable_global(&q), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_global_truncated_header() {
        assert_eq!(decode_mutable_global(&[1, 4, 0]), Err(Errno::EINVAL));
    }

    // --- Table descriptor negatives ---------------------------------------

    fn table_payload() -> Vec<u8> {
        let mut p = alloc::vec![0u8; TABLE_DESCRIPTOR_PAYLOAD_SIZE];
        p[0] = 4; // index width
        p[1] = 10; // page shift
        p[2..4].copy_from_slice(&TABLE_FLAG_SPARSE_OVERRIDES.to_le_bytes());
        p[4..8].copy_from_slice(&1u32.to_le_bytes()); // page count
        p[8..16].copy_from_slice(&4096u64.to_le_bytes()); // length
        p[16..24].copy_from_slice(&16u64.to_le_bytes()); // baseline length
        for byte in p.iter_mut().skip(24) {
            *byte = 0xbb;
        }
        p
    }

    #[test]
    fn decodes_minimal_table_descriptor() {
        let decoded = decode_table_descriptor(&table_payload()).unwrap();
        assert_eq!(decoded.index_width, 4);
        assert_eq!(decoded.page_shift, 10);
        assert_eq!(decoded.length, 4096);
        assert_eq!(decoded.baseline_length, 16);
        assert_eq!(decoded.baseline_fingerprint, [0xbbu8; 32]);
    }

    #[test]
    fn rejects_table_bad_index_width_and_shift() {
        let mut bad_width = table_payload();
        bad_width[0] = 2;
        assert_eq!(decode_table_descriptor(&bad_width), Err(Errno::EINVAL));
        let mut low_shift = table_payload();
        low_shift[1] = MIN_TABLE_PAGE_SHIFT - 1;
        assert_eq!(decode_table_descriptor(&low_shift), Err(Errno::EINVAL));
        let mut high_shift = table_payload();
        high_shift[1] = MAX_TABLE_PAGE_SHIFT + 1;
        assert_eq!(decode_table_descriptor(&high_shift), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_table_bad_flags() {
        let mut no_sparse = table_payload();
        no_sparse[2] = 0; // clear the required SPARSE_OVERRIDES bit
        assert_eq!(decode_table_descriptor(&no_sparse), Err(Errno::EINVAL));
        let mut unknown = table_payload();
        unknown[3] = 0x80; // set a high, unknown flag bit
        assert_eq!(decode_table_descriptor(&unknown), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_table_baseline_exceeds_length() {
        let mut p = table_payload();
        p[16..24].copy_from_slice(&5000u64.to_le_bytes()); // baseline > length(4096)
        assert_eq!(decode_table_descriptor(&p), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_table32_length_over_u32() {
        let mut p = table_payload();
        p[8..16].copy_from_slice(&(u32::MAX as u64 + 1).to_le_bytes());
        // baseline must not exceed length; set it to something small already ok.
        assert_eq!(decode_table_descriptor(&p), Err(Errno::EINVAL));
    }

    #[test]
    fn accepts_table64_large_length() {
        let mut p = table_payload();
        p[0] = 8; // table64
        p[8..16].copy_from_slice(&(u32::MAX as u64 + 100).to_le_bytes());
        let decoded = decode_table_descriptor(&p).unwrap();
        assert_eq!(decoded.index_width, 8);
        assert_eq!(decoded.length, u32::MAX as u64 + 100);
    }

    #[test]
    fn rejects_table_wrong_size() {
        assert_eq!(
            decode_table_descriptor(&table_payload()[..TABLE_DESCRIPTOR_PAYLOAD_SIZE - 1]),
            Err(Errno::EINVAL)
        );
    }

    // --- Table page negatives ---------------------------------------------

    /// Build a valid single-page payload with two runs `[start2:3][start10:1]`
    /// for a `page_shift=10` (page size 1024), table length 4096, page 0.
    fn table_page_payload() -> Vec<u8> {
        let mut p = alloc::vec![0u8; TABLE_PAGE_HEADER_SIZE];
        p[0..8].copy_from_slice(&0u64.to_le_bytes()); // page index
        p[8..12].copy_from_slice(&2u32.to_le_bytes()); // run count
        p[12..16].copy_from_slice(&4u32.to_le_bytes()); // entry count
        // Run 0: start 2, count 3, recipes [7,8,9].
        p.extend_from_slice(&2u32.to_le_bytes());
        p.extend_from_slice(&3u32.to_le_bytes());
        for recipe in [7u32, 8, 9] {
            p.extend_from_slice(&recipe.to_le_bytes());
        }
        // Run 1: start 10, count 1, recipes [42].
        p.extend_from_slice(&10u32.to_le_bytes());
        p.extend_from_slice(&1u32.to_le_bytes());
        p.extend_from_slice(&42u32.to_le_bytes());
        p
    }

    #[test]
    fn decodes_minimal_table_page() {
        let decoded = decode_table_page(&table_page_payload(), 10, 4096).unwrap();
        assert_eq!(decoded.page_index, 0);
        assert_eq!(decoded.entry_count, 4);
        assert_eq!(decoded.runs.len(), 2);
        assert_eq!(decoded.runs[0].recipe_ids, alloc::vec![7, 8, 9]);
    }

    #[test]
    fn rejects_table_page_bad_shift() {
        assert_eq!(
            decode_table_page(&table_page_payload(), MIN_TABLE_PAGE_SHIFT - 1, 4096),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            decode_table_page(&table_page_payload(), 63, 4096),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_table_page_overlapping_runs() {
        let mut p = table_page_payload();
        // Move run 1's start to 3, overlapping run 0 (which ends at 5).
        let run1 = TABLE_PAGE_HEADER_SIZE + TABLE_RUN_HEADER_SIZE + 3 * 4;
        p[run1..run1 + 4].copy_from_slice(&3u32.to_le_bytes());
        assert_eq!(decode_table_page(&p, 10, 4096), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_table_page_run_out_of_page() {
        // start 2, count 3 -> end 5; page size for shift 4 is 16, still fine, so
        // instead use a shift where the run exceeds the page.
        let mut p = table_page_payload();
        // Run 0 start 2 count 3 ends at 5; with page size 4 (shift 2) it would be
        // out of bounds, but shift 2 < MIN. Use run exceeding table length via
        // a large page index instead.
        p[0..8].copy_from_slice(&100u64.to_le_bytes()); // page index 100
        // absoluteEnd = 100 * 1024 + 5 = 102405 > 4096 -> reject.
        assert_eq!(decode_table_page(&p, 10, 4096), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_table_page_entry_count_mismatch() {
        let mut p = table_page_payload();
        p[12..16].copy_from_slice(&3u32.to_le_bytes()); // claim 3, actually 4
        assert_eq!(decode_table_page(&p, 10, 4096), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_table_page_zero_run_count() {
        let mut p = alloc::vec![0u8; TABLE_PAGE_HEADER_SIZE];
        p[8..12].copy_from_slice(&0u32.to_le_bytes()); // run count 0
        p[12..16].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(decode_table_page(&p, 10, 4096), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_table_page_trailing_bytes() {
        let mut p = table_page_payload();
        p.push(0);
        assert_eq!(decode_table_page(&p, 10, 4096), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_table_page_truncated_run() {
        let mut p = table_page_payload();
        p.truncate(p.len() - 1); // drop the last recipe byte
        assert_eq!(decode_table_page(&p, 10, 4096), Err(Errno::EINVAL));
    }

    // --- Segment bitmap negatives -----------------------------------------

    fn segment_payload(segment_count: u32, bitmap: &[u8]) -> Vec<u8> {
        let mut p = alloc::vec![0u8; ELEMENT_SEGMENT_HEADER_SIZE + bitmap.len()];
        p[0..4].copy_from_slice(&segment_count.to_le_bytes());
        p[4..8].copy_from_slice(&(bitmap.len() as u32).to_le_bytes());
        p[ELEMENT_SEGMENT_HEADER_SIZE..].copy_from_slice(bitmap);
        p
    }

    #[test]
    fn decodes_segment_bitmaps() {
        let elements = decode_element_segments(&segment_payload(12, &[0xff, 0x0f])).unwrap();
        assert_eq!(elements.segment_count, 12);
        assert_eq!(elements.dropped, alloc::vec![0xff, 0x0f]);
        // A zero-segment bitmap has no bytes.
        let empty = decode_data_segments(&segment_payload(0, &[])).unwrap();
        assert_eq!(empty.segment_count, 0);
        assert!(empty.dropped.is_empty());
    }

    #[test]
    fn rejects_segment_bitmap_wrong_byte_count() {
        // 12 segments need 2 bytes; declare/provide only 1.
        assert_eq!(
            decode_element_segments(&segment_payload(12, &[0xff])),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_segment_bitmap_nonzero_trailing_bits() {
        // 12 segments: last byte may only use its low 4 bits; set bit 4.
        assert_eq!(
            decode_element_segments(&segment_payload(12, &[0xff, 0x10])),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_segment_bitmap_inconsistent_declared_bytes() {
        let mut p = segment_payload(8, &[0xff]);
        p[4..8].copy_from_slice(&2u32.to_le_bytes()); // claim 2 bytes, hold 1
        assert_eq!(decode_data_segments(&p), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_segment_bitmap_truncated_header() {
        assert_eq!(decode_element_segments(&[0, 0, 0]), Err(Errno::EINVAL));
    }

    // --- Panic-freedom sweeps ---------------------------------------------

    #[test]
    fn arbitrary_bytes_never_panic() {
        // Every prefix of the genuine fixture and each per-kind payload builder,
        // plus a corruption sweep, must decode to Ok or Err, never panic.
        for len in 0..=FIXTURE.len() {
            let slice = &FIXTURE[..len];
            let _ = decode_module_record(slice);
            let _ = decode_mutable_global(slice);
            let _ = decode_table_descriptor(slice);
            let _ = decode_table_page(slice, 10, 4096);
            let _ = decode_element_segments(slice);
            let _ = decode_data_segments(slice);
        }
    }

    #[test]
    fn single_byte_corruptions_never_panic() {
        let builders: [Vec<u8>; 5] = [
            module_payload(),
            global_payload(6, &[1, 2, 3, 4]),
            table_payload(),
            table_page_payload(),
            segment_payload(12, &[0xff, 0x0f]),
        ];
        for base in &builders {
            for offset in 0..base.len() {
                let mut bytes = base.clone();
                bytes[offset] ^= 0xff;
                let _ = decode_module_record(&bytes);
                let _ = decode_mutable_global(&bytes);
                let _ = decode_table_descriptor(&bytes);
                let _ = decode_table_page(&bytes, 10, 4096);
                let _ = decode_element_segments(&bytes);
                let _ = decode_data_segments(&bytes);
            }
        }
    }

    #[test]
    fn table_page_shift_sweep_never_panics() {
        // Sweep every possible shift (including out-of-range) against the fixture
        // page bytes to prove `1 << shift` and the bounds math never panic.
        let (mem, records) = decoded_fixture();
        let page_bytes = record_payload_bytes(&mem, &records[4]).unwrap();
        for shift in 0u8..=64 {
            let _ = decode_table_page(page_bytes, shift, 4096);
        }
    }
}
