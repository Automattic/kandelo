//! The activation admission descriptor (`KFAA`): everything a host hands the
//! fork module about ONE activation, in one staged buffer.
//!
//! # Why this exists
//!
//! Before this descriptor, every host (Node, browser, host-native) decoded the
//! fork-instrumented guest's custom sections itself and fed the module one fact
//! per `fm_*` call: the resume-catalog ordinals, the template id, the GC codec,
//! the exception codec, the imported-global and imported-table sections, and a
//! host-exception owner it derived by hand. Each host carried its own decoders
//! and its own seeding order, and the copies drifted (host-native never seeded
//! the exception codec or the owner at all).
//!
//! The split this format encodes is the one the 2026-09-16 admit brief proved
//! is the real boundary:
//!
//! * **The host LOCATES** each custom section (`WebAssembly.Module
//!   .customSections`, or `wasmparser` natively) and copies its bytes verbatim.
//!   The guest image itself cannot enter linear memory -- `node.wasm` is 53 MB
//!   -- so locating stays host work.
//! * **The host supplies** only facts it alone owns: the activation id (dylink
//!   claims ids), whether this worker is a fork child, and the template id
//!   (SHA-256 over the whole image, which never enters memory).
//! * **The module DECODES AND VALIDATES** every section, through the one
//!   decoder `fork-codec` has for each format.
//!
//! # Layout (all little-endian)
//!
//! ```text
//! Header (ADMISSION_HEADER_SIZE = 64 bytes)
//!   +0   magic "KFAA"
//!   +4   version u16            (ADMISSION_VERSION)
//!   +6   header_size u16        (64)
//!   +8   activation_id u32      host: dylink claims ids, 0 = main module
//!   +12  flags u32              bit0 BORROWED_CHILD, bit1 FORK_CHILD
//!   +16  template_id [32]u8     host: SHA-256 of the module image
//!   +48  section_count u32
//!   +52  reserved [12]u8        must be zero
//! SectionRef[section_count] at +64, 12 bytes each
//!   +0 kind u32, +4 offset u32 (from descriptor start), +8 len u32
//! Section bytes, anywhere after the SectionRef table
//! ```
//!
//! # Structural policy (decided here, and why)
//!
//! * **Unknown section kind: REFUSED** (`UnknownSectionKind`). The host and
//!   the module are built from one tree, so a kind the module does not know is
//!   version skew between them. Ignoring it would silently drop a fact the
//!   host believed it delivered -- the "convenient illusion" the platform
//!   values forbid. A new kind arrives with a version bump.
//! * **Duplicate kind: REFUSED.** Two GC codecs for one activation is a host
//!   bug, and picking one would be a guess.
//! * **Unknown flag bits, non-zero reserved bytes: REFUSED**, for the same
//!   reason as unknown kinds.
//! * **Every section must lie after the SectionRef table and inside the
//!   buffer, and no two non-empty sections may overlap.** An overlap cannot
//!   come from verbatim copies of distinct sections, so it means the host's
//!   offset arithmetic is wrong. A zero-length section occupies nothing and
//!   cannot overlap; it still has to point inside the buffer.
//! * **Trailing bytes after the last section are allowed**, so a host may
//!   stage into a rounded buffer.
//!
//! # Required and optional sections
//!
//! [`admit_activation`] requires `LINKED_FRAMES`, `MODULE_STATE` and
//! `RESUME_CATALOG`: the artifact contract (`wasm-artifact`'s
//! `fork_contract.rs`) requires exactly one of each on every fork-instrumented
//! module, and the Node/browser host already refuses a module without a
//! resume catalog. `GC_CODEC`, `EXCEPTION_CODEC`, `IMPORTED_GLOBALS` and
//! `IMPORTED_TABLES` are optional: host-native has always treated a missing GC
//! codec as "no typed GC", an absent exception codec is what makes an
//! activation NOT a host-exception owner candidate, and a module with no
//! imported globals or tables emits no KFIG/KFIT.
//!
//! The encoding constants live here rather than in `crates/shared`'s ABI
//! table, like the KFRC constants in `catalogs.rs`: this is a host-to-module
//! staging format inside one worker, never a guest-visible wire, and keeping it
//! out of the shared table keeps `abi/snapshot.json` unchanged. A host writer
//! is pinned against [`encode_activation_admission`] by test.

use wasm_posix_shared::Errno;

use alloc::vec::Vec;

use crate::catalogs::decode_resume_catalog;
use crate::linked_frames::{DescriptorRejection, LinkedFrameFormat};
use crate::module_state::ModuleStateFormat;

/// `"KFAA"`.
pub const ADMISSION_MAGIC: [u8; 4] = *b"KFAA";
pub const ADMISSION_VERSION: u16 = 1;
pub const ADMISSION_HEADER_SIZE: usize = 64;
pub const ADMISSION_SECTION_REF_SIZE: usize = 12;

/// Byte offset of the template id inside the header. The module reads the id
/// out of the staged descriptor at this offset.
pub const ADMISSION_TEMPLATE_ID_OFFSET: usize = 16;
pub const ADMISSION_TEMPLATE_ID_SIZE: usize = 32;

/// The admitting worker is a vfork BORROWED child: it replays once and exits,
/// and publishes no identities.
pub const ADMISSION_FLAG_BORROWED_CHILD: u32 = 1 << 0;
/// The admitting worker is a fork child (COW or borrowed).
pub const ADMISSION_FLAG_FORK_CHILD: u32 = 1 << 1;
pub const ADMISSION_KNOWN_FLAGS: u32 = ADMISSION_FLAG_BORROWED_CHILD | ADMISSION_FLAG_FORK_CHILD;

/// Which custom section a `SectionRef` carries. Zero is deliberately not a
/// kind, so a zeroed ref table is refused rather than read as seven sections.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AdmissionSectionKind {
    /// `kandelo.wpk_fork.linked_frames` (KLCF).
    LinkedFrames = 1,
    /// `kandelo.wpk_fork.module_state` (KFMD).
    ModuleState = 2,
    /// `kandelo.wpk_fork.resume_catalog` (KFRC).
    ResumeCatalog = 3,
    /// `kandelo.wpk_fork.gc_codec`.
    GcCodec = 4,
    /// `kandelo.wpk_fork.exception_codec`.
    ExceptionCodec = 5,
    /// `kandelo.wpk_fork.imported_globals` (KFIG).
    ImportedGlobals = 6,
    /// `kandelo.wpk_fork.imported_tables` (KFIT).
    ImportedTables = 7,
}

impl AdmissionSectionKind {
    /// Every kind, in wire order.
    pub const ALL: [AdmissionSectionKind; 7] = [
        Self::LinkedFrames,
        Self::ModuleState,
        Self::ResumeCatalog,
        Self::GcCodec,
        Self::ExceptionCodec,
        Self::ImportedGlobals,
        Self::ImportedTables,
    ];

    pub fn from_wire(kind: u32) -> Option<Self> {
        Self::ALL.iter().copied().find(|k| *k as u32 == kind)
    }

    fn index(self) -> usize {
        self as usize - 1
    }
}

/// Why an admission descriptor was refused.
///
/// Every variant is `EINVAL` at the module boundary, for the reason
/// `DescriptorRejection` gives: the host cannot act on the distinction, but
/// whoever debugs a refused admission can, so the reason travels beside the
/// errno.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionRejection {
    /// Shorter than the header plus its declared SectionRef table.
    Truncated,
    BadMagic,
    UnsupportedVersion,
    HeaderSizeMismatch,
    ReservedNonZero,
    UnknownFlags,
    /// More refs than there are kinds; since duplicates are refused this can
    /// only be a corrupt count, and refusing it early bounds the walk.
    TooManySections,
    UnknownSectionKind(u32),
    DuplicateSection(AdmissionSectionKind),
    /// A section starts inside the header or the SectionRef table.
    SectionOverlapsHeader(AdmissionSectionKind),
    /// A section runs past the end of the descriptor.
    SectionOutOfBounds(AdmissionSectionKind),
    /// Two non-empty sections share bytes.
    SectionsOverlap(AdmissionSectionKind, AdmissionSectionKind),
    /// A section every fork-instrumented module carries is absent.
    MissingSection(AdmissionSectionKind),
    /// The linked-frame descriptor failed its own format check.
    LinkedFrames(DescriptorRejection),
    /// A section failed its own decoder.
    SectionMalformed(AdmissionSectionKind),
    /// The module-state descriptor and the linked-frame descriptor disagree
    /// about pointer width.
    ModuleStatePointerWidthMismatch,
    /// The activation's pointer width is not the worker's.
    WorkerPointerWidthMismatch,
    /// A resume-catalog record whose ordinal is not its local catalog slot.
    /// The guest's `__wpk_fork_place_resume_thunks` indexes the catalog BY
    /// ORDINAL, so such a guest cannot be placed.
    ResumeOrdinalNotSlot { index: u32 },
}

impl AdmissionRejection {
    pub fn errno(self) -> Errno {
        Errno::EINVAL
    }

    /// A short, stable phrase naming the check that failed.
    pub fn reason(self) -> &'static str {
        match self {
            Self::Truncated => "admission descriptor is truncated",
            Self::BadMagic => "admission descriptor magic does not match",
            Self::UnsupportedVersion => "admission descriptor version is unsupported",
            Self::HeaderSizeMismatch => "admission descriptor declares the wrong header size",
            Self::ReservedNonZero => "admission descriptor reserved bytes are not zero",
            Self::UnknownFlags => "admission descriptor carries unknown flag bits",
            Self::TooManySections => "admission descriptor declares more sections than kinds",
            Self::UnknownSectionKind(_) => "admission descriptor names an unknown section kind",
            Self::DuplicateSection(_) => "admission descriptor names one section kind twice",
            Self::SectionOverlapsHeader(_) => {
                "admission section starts inside the header or reference table"
            }
            Self::SectionOutOfBounds(_) => "admission section runs past the descriptor",
            Self::SectionsOverlap(_, _) => "admission sections overlap",
            Self::MissingSection(_) => "admission descriptor lacks a required section",
            Self::LinkedFrames(rejection) => rejection.reason(),
            Self::SectionMalformed(_) => "admission section failed its decoder",
            Self::ModuleStatePointerWidthMismatch => {
                "module-state pointer width disagrees with the linked-frame format"
            }
            Self::WorkerPointerWidthMismatch => {
                "activation pointer width disagrees with the worker's"
            }
            Self::ResumeOrdinalNotSlot { .. } => {
                "resume catalog ordinal differs from its local catalog slot"
            }
        }
    }
}

/// Where one section's bytes are, relative to the descriptor start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdmissionSpan {
    pub offset: u32,
    pub len: u32,
}

impl AdmissionSpan {
    fn end(self) -> u64 {
        self.offset as u64 + self.len as u64
    }
}

/// A structurally valid descriptor. Section CONTENTS are not checked yet; see
/// [`admit_activation`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmissionDescriptor {
    pub activation_id: u32,
    pub flags: u32,
    pub template_id: [u8; ADMISSION_TEMPLATE_ID_SIZE],
    spans: [Option<AdmissionSpan>; 7],
}

impl AdmissionDescriptor {
    pub fn span(&self, kind: AdmissionSectionKind) -> Option<AdmissionSpan> {
        self.spans[kind.index()]
    }

    /// The section's bytes inside `descriptor`, the buffer this was decoded
    /// from. Spans were bounds-checked at decode.
    pub fn section<'a>(&self, descriptor: &'a [u8], kind: AdmissionSectionKind) -> Option<&'a [u8]> {
        let span = self.span(kind)?;
        descriptor.get(span.offset as usize..span.end() as usize)
    }
}

fn read_u16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn read_u32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Decode and structurally validate a `KFAA` descriptor. Panic-free.
pub fn decode_activation_admission(bytes: &[u8]) -> Result<AdmissionDescriptor, AdmissionRejection> {
    if bytes.len() < ADMISSION_HEADER_SIZE {
        return Err(AdmissionRejection::Truncated);
    }
    if bytes[0..4] != ADMISSION_MAGIC {
        return Err(AdmissionRejection::BadMagic);
    }
    if read_u16(bytes, 4) != ADMISSION_VERSION {
        return Err(AdmissionRejection::UnsupportedVersion);
    }
    if read_u16(bytes, 6) as usize != ADMISSION_HEADER_SIZE {
        return Err(AdmissionRejection::HeaderSizeMismatch);
    }
    let activation_id = read_u32(bytes, 8);
    let flags = read_u32(bytes, 12);
    if flags & !ADMISSION_KNOWN_FLAGS != 0 {
        return Err(AdmissionRejection::UnknownFlags);
    }
    let mut template_id = [0u8; ADMISSION_TEMPLATE_ID_SIZE];
    template_id.copy_from_slice(
        &bytes[ADMISSION_TEMPLATE_ID_OFFSET..ADMISSION_TEMPLATE_ID_OFFSET + ADMISSION_TEMPLATE_ID_SIZE],
    );
    let section_count = read_u32(bytes, 48) as usize;
    if bytes[52..ADMISSION_HEADER_SIZE].iter().any(|b| *b != 0) {
        return Err(AdmissionRejection::ReservedNonZero);
    }
    if section_count > AdmissionSectionKind::ALL.len() {
        return Err(AdmissionRejection::TooManySections);
    }
    let refs_end = ADMISSION_HEADER_SIZE + section_count * ADMISSION_SECTION_REF_SIZE;
    if bytes.len() < refs_end {
        return Err(AdmissionRejection::Truncated);
    }

    let mut spans: [Option<AdmissionSpan>; 7] = [None; 7];
    for index in 0..section_count {
        let at = ADMISSION_HEADER_SIZE + index * ADMISSION_SECTION_REF_SIZE;
        let wire_kind = read_u32(bytes, at);
        let kind = AdmissionSectionKind::from_wire(wire_kind)
            .ok_or(AdmissionRejection::UnknownSectionKind(wire_kind))?;
        let span = AdmissionSpan { offset: read_u32(bytes, at + 4), len: read_u32(bytes, at + 8) };
        if spans[kind.index()].is_some() {
            return Err(AdmissionRejection::DuplicateSection(kind));
        }
        if (span.offset as usize) < refs_end {
            return Err(AdmissionRejection::SectionOverlapsHeader(kind));
        }
        if span.end() > bytes.len() as u64 {
            return Err(AdmissionRejection::SectionOutOfBounds(kind));
        }
        spans[kind.index()] = Some(span);
    }

    // Pairwise over at most seven spans: sort by offset, compare neighbours.
    let mut placed: Vec<(AdmissionSpan, AdmissionSectionKind)> = AdmissionSectionKind::ALL
        .iter()
        .filter_map(|kind| spans[kind.index()].map(|span| (span, *kind)))
        .filter(|(span, _)| span.len != 0)
        .collect();
    placed.sort_unstable_by_key(|(span, kind)| (span.offset, *kind));
    for pair in placed.windows(2) {
        if pair[0].0.end() > pair[1].0.offset as u64 {
            return Err(AdmissionRejection::SectionsOverlap(pair[0].1, pair[1].1));
        }
    }

    Ok(AdmissionDescriptor { activation_id, flags, template_id, spans })
}

/// An activation whose every section decoded and whose sections agree with
/// each other (and, if asked, with the worker).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmittedActivation {
    pub descriptor: AdmissionDescriptor,
    /// Pointer width and fixed prefix, from the linked-frame descriptor.
    pub linked_format: LinkedFrameFormat,
    /// Resume-target function ordinals, ascending. Each is also its own local
    /// catalog slot (checked).
    pub resume_ordinals: Vec<u32>,
    /// The tag ordinals the exception codec declares, or `None` when the
    /// activation has no exception codec. `Some(empty)` is an activation whose
    /// codec declares no tags, which still makes it a host-exception owner
    /// candidate.
    pub exception_tag_ordinals: Option<Vec<u32>>,
}

impl AdmittedActivation {
    pub fn span(&self, kind: AdmissionSectionKind) -> Option<AdmissionSpan> {
        self.descriptor.span(kind)
    }
}

fn require<'a>(
    descriptor: &AdmissionDescriptor,
    bytes: &'a [u8],
    kind: AdmissionSectionKind,
) -> Result<&'a [u8], AdmissionRejection> {
    descriptor.section(bytes, kind).ok_or(AdmissionRejection::MissingSection(kind))
}

/// The resume ordinals of a KFRC catalog, provided every record's ordinal is
/// its own local catalog slot.
///
/// The ONE copy of this check. Host-native ran it privately
/// (`read_fork_resume_catalog_records`) and the Node/browser host never did;
/// both now reach it here.
pub fn placeable_resume_ordinals(section: &[u8]) -> Result<Vec<u32>, AdmissionRejection> {
    let catalog = decode_resume_catalog(section)
        .map_err(|_| AdmissionRejection::SectionMalformed(AdmissionSectionKind::ResumeCatalog))?;
    let mut ordinals = Vec::with_capacity(catalog.records.len());
    for (index, record) in catalog.records.iter().enumerate() {
        if record.function_ordinal != record.local_catalog_slot {
            return Err(AdmissionRejection::ResumeOrdinalNotSlot { index: index as u32 });
        }
        ordinals.push(record.function_ordinal);
    }
    Ok(ordinals)
}

/// Decode a descriptor and every section it carries, and check the sections
/// against each other.
///
/// `worker_pointer_width` is the pointer width the admitting worker was set up
/// with, when it has one; an activation of another width is refused.
pub fn admit_activation(
    bytes: &[u8],
    worker_pointer_width: Option<u8>,
) -> Result<AdmittedActivation, AdmissionRejection> {
    use AdmissionSectionKind as K;
    let descriptor = decode_activation_admission(bytes)?;

    let linked_format = LinkedFrameFormat::parse_descriptor(require(&descriptor, bytes, K::LinkedFrames)?)
        .map_err(AdmissionRejection::LinkedFrames)?;
    let module_state = ModuleStateFormat::parse_descriptor(require(&descriptor, bytes, K::ModuleState)?)
        .map_err(|_| AdmissionRejection::SectionMalformed(K::ModuleState))?;
    if module_state.pointer_width != linked_format.pointer_width {
        return Err(AdmissionRejection::ModuleStatePointerWidthMismatch);
    }
    if worker_pointer_width.is_some_and(|width| width != linked_format.pointer_width) {
        return Err(AdmissionRejection::WorkerPointerWidthMismatch);
    }
    let resume_ordinals = placeable_resume_ordinals(require(&descriptor, bytes, K::ResumeCatalog)?)?;

    // An EMPTY GC codec section is "no typed GC", which is how the module's
    // own seed has always read it.
    if let Some(section) = descriptor.section(bytes, K::GcCodec) {
        if !section.is_empty() {
            crate::gc_codec::decode_gc_codec(section)
                .map_err(|_| AdmissionRejection::SectionMalformed(K::GcCodec))?;
        }
    }
    let exception_tag_ordinals = match descriptor.section(bytes, K::ExceptionCodec) {
        None => None,
        Some([]) => Some(Vec::new()),
        Some(section) => Some(
            crate::exception_codec::decode_exception_codec(section)
                .map_err(|_| AdmissionRejection::SectionMalformed(K::ExceptionCodec))?
                .tags
                .iter()
                .map(|tag| tag.tag_ordinal)
                .collect(),
        ),
    };
    if let Some(section) = descriptor.section(bytes, K::ImportedGlobals) {
        crate::imported_globals::decode_imported_globals(section)
            .map_err(|_| AdmissionRejection::SectionMalformed(K::ImportedGlobals))?;
    }
    if let Some(section) = descriptor.section(bytes, K::ImportedTables) {
        crate::imported_tables::decode_imported_tables(section)
            .map_err(|_| AdmissionRejection::SectionMalformed(K::ImportedTables))?;
    }

    Ok(AdmittedActivation { descriptor, linked_format, resume_ordinals, exception_tag_ordinals })
}

/// Encode a descriptor: the header, one SectionRef per section in the order
/// given, then each section's bytes back to back.
///
/// For tests and for host-native; the Node/browser writer is pinned against
/// this. Kinds are passed as wire numbers so a test can encode a descriptor
/// the decoder must refuse.
pub fn encode_activation_admission(
    activation_id: u32,
    flags: u32,
    template_id: &[u8; ADMISSION_TEMPLATE_ID_SIZE],
    sections: &[(u32, &[u8])],
) -> Vec<u8> {
    let refs_end = ADMISSION_HEADER_SIZE + sections.len() * ADMISSION_SECTION_REF_SIZE;
    let total = refs_end + sections.iter().map(|(_, bytes)| bytes.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&ADMISSION_MAGIC);
    out.extend_from_slice(&ADMISSION_VERSION.to_le_bytes());
    out.extend_from_slice(&(ADMISSION_HEADER_SIZE as u16).to_le_bytes());
    out.extend_from_slice(&activation_id.to_le_bytes());
    out.extend_from_slice(&flags.to_le_bytes());
    out.extend_from_slice(template_id);
    out.extend_from_slice(&(sections.len() as u32).to_le_bytes());
    out.resize(ADMISSION_HEADER_SIZE, 0);
    let mut offset = refs_end as u32;
    for (kind, bytes) in sections {
        out.extend_from_slice(&kind.to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        offset += bytes.len() as u32;
    }
    for (_, bytes) in sections {
        out.extend_from_slice(bytes);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use wasm_posix_shared::abi;
    use AdmissionSectionKind as K;

    // REAL instrumenter output for the codec sections, the same committed
    // fixtures each codec's own tests decode.
    const GC_CODEC: &[u8] = include_bytes!("../testdata/gc-codec-wasm32.bin");
    const EXCEPTION_CODEC: &[u8] = include_bytes!("../testdata/exception-codec-wasm32.bin");
    const IMPORTED_GLOBALS: &[u8] = include_bytes!("../testdata/imported-globals-wasm32.bin");
    const IMPORTED_TABLES: &[u8] = include_bytes!("../testdata/imported-tables-wasm32.bin");
    const RESUME_CATALOG: &[u8] = include_bytes!("../testdata/resume-catalog-wasm32.bin");

    const TEMPLATE: [u8; 32] = [0xa5; 32];

    /// A linked-frame descriptor as `fork_instrument` emits it.
    fn linked_frames(pointer_width: u8, fixed_prefix: u32) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(&abi::WPK_FORK_LINKED_FRAME_FORMAT_MAGIC);
        d.extend_from_slice(&abi::WPK_FORK_LINKED_FRAME_FORMAT_VERSION.to_le_bytes());
        d.extend_from_slice(&abi::WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE.to_le_bytes());
        d.push(pointer_width);
        d.push(abi::WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT);
        d.extend_from_slice(&abi::WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS.to_le_bytes());
        d.extend_from_slice(&abi::wpk_fork_linked_chunk_header_size(pointer_width).unwrap().to_le_bytes());
        d.extend_from_slice(&abi::wpk_fork_linked_node_header_size(pointer_width).unwrap().to_le_bytes());
        d.extend_from_slice(&fixed_prefix.to_le_bytes());
        d
    }

    /// A module-state descriptor as `fork_instrument` emits it.
    fn module_state(pointer_width: u8) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(&abi::WPK_FORK_MODULE_STATE_FORMAT_MAGIC);
        d.extend_from_slice(&abi::WPK_FORK_MODULE_STATE_FORMAT_VERSION.to_le_bytes());
        d.extend_from_slice(&abi::WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE.to_le_bytes());
        d.push(pointer_width);
        d.push(abi::WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT);
        d.extend_from_slice(&abi::WPK_FORK_MODULE_STATE_REQUIRED_FLAGS.to_le_bytes());
        d.extend_from_slice(&abi::WPK_FORK_MODULE_STATE_ARENA_VERSION.to_le_bytes());
        d.extend_from_slice(&abi::WPK_FORK_MODULE_STATE_RECORD_VERSION.to_le_bytes());
        d.extend_from_slice(&abi::WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET.to_le_bytes());
        d.extend_from_slice(&0u32.to_le_bytes());
        d
    }

    /// A KFRC catalog; each record is `(ordinal, slot)`.
    fn resume_catalog(records: &[(u32, u32)]) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(b"KFRC");
        d.extend_from_slice(&1u16.to_le_bytes());
        d.extend_from_slice(&12u16.to_le_bytes());
        d.extend_from_slice(&(records.len() as u32).to_le_bytes());
        for (ordinal, slot) in records {
            d.extend_from_slice(&ordinal.to_le_bytes());
            d.extend_from_slice(&slot.to_le_bytes());
        }
        d
    }

    fn full_sections() -> Vec<(u32, Vec<u8>)> {
        vec![
            (K::LinkedFrames as u32, linked_frames(4, 48)),
            (K::ModuleState as u32, module_state(4)),
            (K::ResumeCatalog as u32, RESUME_CATALOG.to_vec()),
            (K::GcCodec as u32, GC_CODEC.to_vec()),
            (K::ExceptionCodec as u32, EXCEPTION_CODEC.to_vec()),
            (K::ImportedGlobals as u32, IMPORTED_GLOBALS.to_vec()),
            (K::ImportedTables as u32, IMPORTED_TABLES.to_vec()),
        ]
    }

    fn encode(sections: &[(u32, Vec<u8>)]) -> Vec<u8> {
        let borrowed: Vec<(u32, &[u8])> = sections.iter().map(|(k, b)| (*k, b.as_slice())).collect();
        encode_activation_admission(3, ADMISSION_FLAG_FORK_CHILD, &TEMPLATE, &borrowed)
    }

    fn with(kind: AdmissionSectionKind, bytes: Vec<u8>) -> Vec<u8> {
        let mut sections = full_sections();
        sections.iter_mut().find(|(k, _)| *k == kind as u32).unwrap().1 = bytes;
        encode(&sections)
    }

    fn ref_at(index: usize) -> usize {
        ADMISSION_HEADER_SIZE + index * ADMISSION_SECTION_REF_SIZE
    }

    #[test]
    fn round_trips_every_section_and_header_fact() {
        let sections = full_sections();
        let bytes = encode(&sections);
        let admitted = admit_activation(&bytes, Some(4)).unwrap();
        let d = &admitted.descriptor;
        assert_eq!(d.activation_id, 3);
        assert_eq!(d.flags, ADMISSION_FLAG_FORK_CHILD);
        assert_eq!(d.template_id, TEMPLATE);
        for (kind, original) in &sections {
            let kind = K::from_wire(*kind).unwrap();
            assert_eq!(d.section(&bytes, kind).unwrap(), original.as_slice(), "{kind:?}");
        }
        assert_eq!(admitted.linked_format.pointer_width, 4);
        assert_eq!(admitted.linked_format.fixed_prefix_size, 48);
        let expected: Vec<u32> = decode_resume_catalog(RESUME_CATALOG)
            .unwrap()
            .records
            .iter()
            .map(|r| r.function_ordinal)
            .collect();
        assert!(!expected.is_empty(), "the real catalog fixture must carry records");
        assert_eq!(admitted.resume_ordinals, expected);
        let tags: Vec<u32> = crate::exception_codec::decode_exception_codec(EXCEPTION_CODEC)
            .unwrap()
            .tags
            .iter()
            .map(|t| t.tag_ordinal)
            .collect();
        assert_eq!(admitted.exception_tag_ordinals, Some(tags));
    }

    #[test]
    fn optional_sections_may_be_absent_and_required_ones_may_not() {
        let minimal: Vec<(u32, Vec<u8>)> = full_sections().into_iter().take(3).collect();
        let admitted = admit_activation(&encode(&minimal), None).unwrap();
        assert_eq!(admitted.exception_tag_ordinals, None);
        assert_eq!(admitted.span(K::GcCodec), None);
        for required in [K::LinkedFrames, K::ModuleState, K::ResumeCatalog] {
            let without: Vec<(u32, Vec<u8>)> =
                full_sections().into_iter().filter(|(k, _)| *k != required as u32).collect();
            assert_eq!(
                admit_activation(&encode(&without), None),
                Err(AdmissionRejection::MissingSection(required))
            );
        }
    }

    #[test]
    fn an_empty_exception_codec_is_a_candidate_with_no_tags() {
        let admitted = admit_activation(&with(K::ExceptionCodec, Vec::new()), None).unwrap();
        assert_eq!(admitted.exception_tag_ordinals, Some(Vec::new()));
    }

    #[test]
    fn refuses_bad_magic() {
        let mut bytes = encode(&full_sections());
        bytes[0] ^= 0xff;
        assert_eq!(admit_activation(&bytes, None), Err(AdmissionRejection::BadMagic));
    }

    #[test]
    fn refuses_bad_version_header_size_flags_and_reserved() {
        let base = encode(&full_sections());
        let mut bytes = base.clone();
        bytes[4] = 2;
        assert_eq!(admit_activation(&bytes, None), Err(AdmissionRejection::UnsupportedVersion));
        let mut bytes = base.clone();
        bytes[6] = 60;
        assert_eq!(admit_activation(&bytes, None), Err(AdmissionRejection::HeaderSizeMismatch));
        let mut bytes = base.clone();
        bytes[12] |= 0x4;
        assert_eq!(admit_activation(&bytes, None), Err(AdmissionRejection::UnknownFlags));
        let mut bytes = base;
        bytes[60] = 1;
        assert_eq!(admit_activation(&bytes, None), Err(AdmissionRejection::ReservedNonZero));
    }

    #[test]
    fn refuses_a_duplicate_kind() {
        let mut bytes = encode(&full_sections());
        // Rename the GC codec ref (index 3) to the module-state kind.
        bytes[ref_at(3)..ref_at(3) + 4].copy_from_slice(&(K::ModuleState as u32).to_le_bytes());
        assert_eq!(
            admit_activation(&bytes, None),
            Err(AdmissionRejection::DuplicateSection(K::ModuleState))
        );
    }

    #[test]
    fn refuses_an_unknown_kind_and_kind_zero() {
        for wire in [0u32, 8, 0xffff_ffff] {
            let mut bytes = encode(&full_sections());
            bytes[ref_at(6)..ref_at(6) + 4].copy_from_slice(&wire.to_le_bytes());
            assert_eq!(
                admit_activation(&bytes, None),
                Err(AdmissionRejection::UnknownSectionKind(wire))
            );
        }
    }

    #[test]
    fn refuses_too_many_sections() {
        let mut bytes = encode(&full_sections());
        bytes[48..52].copy_from_slice(&8u32.to_le_bytes());
        assert_eq!(admit_activation(&bytes, None), Err(AdmissionRejection::TooManySections));
    }

    #[test]
    fn refuses_a_truncated_header_ref_table_and_section() {
        let bytes = encode(&full_sections());
        assert_eq!(admit_activation(&bytes[..40], None), Err(AdmissionRejection::Truncated));
        assert_eq!(
            admit_activation(&bytes[..ref_at(3)], None),
            Err(AdmissionRejection::Truncated)
        );
        // Drop the last byte: the final section (imported tables) now runs past
        // the end.
        assert_eq!(
            admit_activation(&bytes[..bytes.len() - 1], None),
            Err(AdmissionRejection::SectionOutOfBounds(K::ImportedTables))
        );
    }

    #[test]
    fn refuses_overlapping_refs() {
        let mut bytes = encode(&full_sections());
        // Point the GC codec at the resume catalog's offset.
        let resume_offset = read_u32(&bytes, ref_at(2) + 4);
        bytes[ref_at(3) + 4..ref_at(3) + 8].copy_from_slice(&resume_offset.to_le_bytes());
        assert_eq!(
            admit_activation(&bytes, None),
            Err(AdmissionRejection::SectionsOverlap(K::ResumeCatalog, K::GcCodec))
        );
    }

    #[test]
    fn refuses_a_section_inside_the_header() {
        let mut bytes = encode(&full_sections());
        bytes[ref_at(0) + 4..ref_at(0) + 8].copy_from_slice(&(ADMISSION_HEADER_SIZE as u32).to_le_bytes());
        assert_eq!(
            admit_activation(&bytes, None),
            Err(AdmissionRejection::SectionOverlapsHeader(K::LinkedFrames))
        );
    }

    #[test]
    fn zero_length_sections_never_overlap() {
        let mut sections = full_sections();
        sections[4].1 = Vec::new(); // empty exception codec
        let mut bytes = encode(&sections);
        // Put the empty section at the start of the GC codec's bytes.
        let gc_offset = read_u32(&bytes, ref_at(3) + 4);
        bytes[ref_at(4) + 4..ref_at(4) + 8].copy_from_slice(&gc_offset.to_le_bytes());
        assert!(admit_activation(&bytes, None).is_ok());
    }

    #[test]
    fn refuses_a_wrong_pointer_width() {
        // A linked-frame width the ABI does not define.
        assert_eq!(
            admit_activation(&with(K::LinkedFrames, linked_frames(4, 48).into_iter().enumerate().map(|(i, b)| if i == 8 { 2 } else { b }).collect()), None),
            Err(AdmissionRejection::LinkedFrames(DescriptorRejection::UnsupportedPointerWidth))
        );
        // Module state and linked frames disagree.
        assert_eq!(
            admit_activation(&with(K::ModuleState, module_state(8)), None),
            Err(AdmissionRejection::ModuleStatePointerWidthMismatch)
        );
        // Self-consistent wasm64 activation in a wasm32 worker.
        let mut sections = full_sections();
        sections[0].1 = linked_frames(8, 96);
        sections[1].1 = module_state(8);
        let bytes = encode(&sections);
        assert!(admit_activation(&bytes, None).is_ok());
        assert_eq!(
            admit_activation(&bytes, Some(4)),
            Err(AdmissionRejection::WorkerPointerWidthMismatch)
        );
    }

    #[test]
    fn refuses_an_ordinal_that_is_not_its_slot() {
        let ok = with(K::ResumeCatalog, resume_catalog(&[(0, 0), (2, 2), (5, 5)]));
        assert_eq!(admit_activation(&ok, None).unwrap().resume_ordinals, vec![0, 2, 5]);
        let bad = with(K::ResumeCatalog, resume_catalog(&[(0, 0), (2, 3), (5, 5)]));
        assert_eq!(
            admit_activation(&bad, None),
            Err(AdmissionRejection::ResumeOrdinalNotSlot { index: 1 })
        );
    }

    #[test]
    fn refuses_each_malformed_section_by_name() {
        for kind in [K::ModuleState, K::ResumeCatalog, K::GcCodec, K::ExceptionCodec, K::ImportedGlobals, K::ImportedTables] {
            let mut sections = full_sections();
            let section = &mut sections.iter_mut().find(|(k, _)| *k == kind as u32).unwrap().1;
            section[0] ^= 0xff;
            assert_eq!(
                admit_activation(&encode(&sections), None),
                Err(AdmissionRejection::SectionMalformed(kind)),
                "{kind:?}"
            );
        }
        assert_eq!(
            admit_activation(&with(K::LinkedFrames, vec![0; 23]), None),
            Err(AdmissionRejection::LinkedFrames(DescriptorRejection::WrongLength))
        );
    }

    #[test]
    fn every_rejection_is_einval_with_a_reason() {
        let rejection = AdmissionRejection::ResumeOrdinalNotSlot { index: 0 };
        assert_eq!(rejection.errno(), Errno::EINVAL);
        assert!(!rejection.reason().is_empty());
    }
}
