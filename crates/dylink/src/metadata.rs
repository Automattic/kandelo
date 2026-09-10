//! The `dylink.0` custom section.
//!
//! Ported from `parseDylinkSection` (`host/src/dylink.ts:255-364`), following
//! the WebAssembly tool-conventions dynamic-linking ABI.
//!
//! ## One correctness fix carried into the port
//!
//! `WASM_DYLINK_IMPORT_INFO` records a `(module, field, flags)` triple. The
//! TypeScript reads the module name into `_module` and discards it, keying the
//! weak set on `field` alone (`dylink.ts:334-340`). That conflates three
//! distinct imports — `env.foo`, `GOT.mem.foo` and `GOT.func.foo` — so a weak
//! `env.foo` would mark a strong `GOT.mem.foo` weak. The port keys on the full
//! `(module, field)` pair, which is what the section actually encodes.
//!
//! ## Why the weak set matters here (see `got.rs` and the D4 adjudication)
//!
//! `weakImports` is parsed by `dylink.ts` and then **read by nothing** —
//! verified over the whole repository: the only three occurrences are its
//! declaration, its initialization and its one `add`. Because the loader
//! discards the strong/weak distinction, it applies *weak* semantics (resolve
//! to 0) to *every* unresolved symbol. Recovering the flag is what lets the
//! planner give ELF's actual answer.

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::string::String;
use alloc::vec::Vec;

use crate::error::{DylinkError, DylinkResult};
use crate::wasm::{preamble, Reader, SECTION_CUSTOM};

const DYLINK_SECTION_NAME: &str = "dylink.0";

const WASM_DYLINK_MEM_INFO: u32 = 1;
const WASM_DYLINK_NEEDED: u32 = 2;
const WASM_DYLINK_EXPORT_INFO: u32 = 3;
const WASM_DYLINK_IMPORT_INFO: u32 = 4;

const WASM_DYLINK_FLAG_TLS: u32 = 0x01;
const WASM_DYLINK_FLAG_WEAK: u32 = 0x02;

/// Which GOT namespace an import belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum GotKind {
    /// `GOT.mem.<sym>` — the address in linear memory of a data symbol.
    Mem,
    /// `GOT.func.<sym>` — the indirect-function-table index of a function.
    Func,
}

impl GotKind {
    pub const fn namespace(self) -> &'static str {
        match self {
            GotKind::Mem => "GOT.mem",
            GotKind::Func => "GOT.func",
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            GotKind::Mem => "mem",
            GotKind::Func => "func",
        }
    }

    pub fn from_namespace(module: &str) -> Option<Self> {
        match module {
            "GOT.mem" => Some(GotKind::Mem),
            "GOT.func" => Some(GotKind::Func),
            _ => None,
        }
    }
}

/// The parsed `dylink.0` section.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DylinkMetadata {
    /// Bytes of linear memory this module needs.
    pub memory_size: u64,
    /// Memory alignment, as a power of two exponent.
    pub memory_align: u32,
    /// Indirect function table slots this module needs.
    pub table_size: u64,
    /// Table alignment, as a power of two exponent.
    pub table_align: u32,
    /// Dependent shared libraries, in declaration order (ELF `DT_NEEDED`).
    pub needed_dynlibs: Vec<String>,
    /// Exports that are thread-local.
    pub tls_exports: BTreeSet<String>,
    /// Imports flagged weak, keyed by `(import module, field)`.
    ///
    /// A weak undefined symbol resolves to zero with no error; that is ELF's
    /// rule and it is the ONLY case in which zero is a correct answer.
    weak_imports: BTreeSet<(String, String)>,
    /// Every recorded import flag set, keyed the same way. Retained so a future
    /// flag can be adjudicated instead of silently dropped.
    import_flags: BTreeMap<(String, String), u32>,
}

impl DylinkMetadata {
    /// Is `name` in `namespace` declared weak by `dylink.0`?
    pub fn is_weak_import(&self, namespace: &str, name: &str) -> bool {
        self.weak_imports
            .iter()
            .any(|(module, field)| module == namespace && field == name)
    }

    /// Is this GOT symbol weak?
    ///
    /// `wasm-ld` records the weak flag against the namespace it emitted the
    /// import in. A symbol referenced both as `env.<sym>` (a direct call) and
    /// `GOT.func.<sym>` (an address-take) carries the flag on whichever entries
    /// the linker marked, so a weak declaration in EITHER the GOT namespace or
    /// `env` makes the reference weak — matching ELF, where weakness is a
    /// property of the symbol table entry, not of an individual relocation.
    pub fn is_weak_symbol(&self, kind: GotKind, name: &str) -> bool {
        self.is_weak_import(kind.namespace(), name) || self.is_weak_import("env", name)
    }

    pub fn weak_imports(&self) -> impl Iterator<Item = (&str, &str)> {
        self.weak_imports
            .iter()
            .map(|(module, field)| (module.as_str(), field.as_str()))
    }

    pub fn import_flags(&self, namespace: &str, name: &str) -> Option<u32> {
        self.import_flags
            .iter()
            .find(|((module, field), _)| module == namespace && field == name)
            .map(|(_, flags)| *flags)
    }

    /// Memory alignment in bytes.
    pub fn memory_align_bytes(&self) -> DylinkResult<u64> {
        if self.memory_align >= 64 {
            return Err(DylinkError::MalformedDylinkSection("memory alignment out of range"));
        }
        Ok(1u64 << self.memory_align)
    }
}

/// Parse `dylink.0`, which the ABI requires to be the module's FIRST section.
///
/// Returns `Err(NotASharedLibrary)` for a well-formed module without one, which
/// is how a main module is distinguished from a side module.
pub fn parse_dylink_section(bytes: &[u8]) -> DylinkResult<DylinkMetadata> {
    let start = preamble(bytes)?;
    let mut reader = Reader::at(bytes, start);
    if reader.is_empty() {
        return Err(DylinkError::NotASharedLibrary);
    }
    if reader.byte()? != SECTION_CUSTOM {
        return Err(DylinkError::NotASharedLibrary);
    }
    let size = usize::try_from(reader.varuint64()?)
        .map_err(|_| DylinkError::MalformedModule("section size out of range"))?;
    let section_end = reader
        .position()
        .checked_add(size)
        .ok_or(DylinkError::MalformedModule("section size overflow"))?;
    if section_end > bytes.len() {
        return Err(DylinkError::MalformedModule("section escapes the module"));
    }
    if reader.name()? != DYLINK_SECTION_NAME {
        return Err(DylinkError::NotASharedLibrary);
    }

    let mut metadata = DylinkMetadata::default();
    while reader.position() < section_end {
        let sub_type = reader.varuint32()?;
        let sub_size = usize::try_from(reader.varuint64()?)
            .map_err(|_| DylinkError::MalformedDylinkSection("sub-section size out of range"))?;
        let sub_end = reader
            .position()
            .checked_add(sub_size)
            .ok_or(DylinkError::MalformedDylinkSection("sub-section size overflow"))?;
        if sub_end > section_end {
            return Err(DylinkError::MalformedDylinkSection(
                "sub-section escapes the dylink.0 section",
            ));
        }

        match sub_type {
            WASM_DYLINK_MEM_INFO => {
                metadata.memory_size = reader.varuint64()?;
                metadata.memory_align = reader.varuint32()?;
                metadata.table_size = reader.varuint64()?;
                metadata.table_align = reader.varuint32()?;
            }
            WASM_DYLINK_NEEDED => {
                let count = reader.varuint32()?;
                for _ in 0..count {
                    metadata.needed_dynlibs.push(reader.name()?);
                }
            }
            WASM_DYLINK_EXPORT_INFO => {
                let count = reader.varuint32()?;
                for _ in 0..count {
                    let name = reader.name()?;
                    let flags = reader.varuint32()?;
                    if flags & WASM_DYLINK_FLAG_TLS != 0 {
                        metadata.tls_exports.insert(name);
                    }
                }
            }
            WASM_DYLINK_IMPORT_INFO => {
                let count = reader.varuint32()?;
                for _ in 0..count {
                    let module = reader.name()?;
                    let field = reader.name()?;
                    let flags = reader.varuint32()?;
                    let key = (module, field);
                    if flags & WASM_DYLINK_FLAG_WEAK != 0 {
                        metadata.weak_imports.insert(key.clone());
                    }
                    metadata.import_flags.insert(key, flags);
                }
            }
            _ => {
                // Unknown sub-sections are skipped by design; the ABI reserves
                // the right to add them.
            }
        }

        // Trust the declared sub-section size over the reader's cursor, exactly
        // as the TypeScript does, so an unknown sub-section is skippable. But
        // reject a size that disagrees with a sub-section we DID decode: that
        // is a malformed artifact, not a forward-compatible one.
        if matches!(
            sub_type,
            WASM_DYLINK_MEM_INFO
                | WASM_DYLINK_NEEDED
                | WASM_DYLINK_EXPORT_INFO
                | WASM_DYLINK_IMPORT_INFO
        ) && reader.position() != sub_end
        {
            return Err(DylinkError::MalformedDylinkSection(
                "sub-section size disagrees with its contents",
            ));
        }
        reader.seek(sub_end)?;
    }

    Ok(metadata)
}

/// Does this module carry a `dylink.0` section?
pub fn is_shared_library(bytes: &[u8]) -> bool {
    !matches!(parse_dylink_section(bytes), Err(DylinkError::NotASharedLibrary))
        && parse_dylink_section(bytes).is_ok()
}
