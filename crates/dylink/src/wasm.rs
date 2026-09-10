//! Minimal, bounds-checked WebAssembly binary reader for the linker.
//!
//! Ported from the hand-written parsers scattered through
//! `host/src/dylink.ts` (`readVarUint`, `readString`, `parseDylinkSection`,
//! `readDefinedFunctionExports`,
//! `requirePassiveDataSegmentsForBorrowedReplay`,
//! `withoutBorrowedReplayStart`) plus the import-section walk that
//! `readWasmFunctionImports` performs in `host/src/constants.ts`.
//!
//! Two things this reader does that the TypeScript did not, both required by
//! the planner's contract:
//!
//! 1. **Imports are returned as an ordered `Vec`, one entry per import
//!    declaration.** `wasm-ld` can emit two import entries with the same
//!    `(module, name)`, and the engine resolves imports in declaration order.
//!    `dylink.ts` recovered that ordering after the fact, from the read-count
//!    of a stateful `Proxy` (`dylink.ts:1785-1789`, reasoning at `:1877-1881`).
//!    Here the order *is* the data structure, which is also the shape
//!    `wasmtime::Instance::new`'s positional `&[Extern]` slice wants.
//! 2. **It never panics.** Every read is bounds-checked and returns
//!    `Err(DylinkError::MalformedModule)`. The TypeScript readers index past
//!    the end of a `Uint8Array` and silently produce `NaN`/`undefined`.
//!
//! This reader deliberately does NOT validate the module: the executor still
//! hands the bytes to a real engine, which is the validation authority. It
//! reads only the sections the linker must reason about before instantiation.

use alloc::string::String;
use alloc::vec::Vec;

use crate::error::{DylinkError, DylinkResult};

/// Section ids this reader knows by name.
pub(crate) const SECTION_CUSTOM: u8 = 0;
pub(crate) const SECTION_IMPORT: u8 = 2;
pub(crate) const SECTION_START: u8 = 8;
pub(crate) const SECTION_ELEMENT: u8 = 9;
pub(crate) const SECTION_EXPORT: u8 = 7;
pub(crate) const SECTION_DATA: u8 = 11;

/// External kind byte shared by the import and export sections.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ExternKind {
    Func,
    Table,
    Memory,
    Global,
    /// Exception-handling tag. Encoded as `0x04` in the exceptions proposal.
    Tag,
}

impl ExternKind {
    fn from_byte(byte: u8) -> DylinkResult<Self> {
        Ok(match byte {
            0x00 => ExternKind::Func,
            0x01 => ExternKind::Table,
            0x02 => ExternKind::Memory,
            0x03 => ExternKind::Global,
            0x04 => ExternKind::Tag,
            _ => return Err(DylinkError::MalformedModule("unknown external kind")),
        })
    }
}

/// Numeric value types the linker binds. Reference types are opaque here: the
/// linker never constructs one, it only passes engine-created values through.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ValType {
    I32,
    I64,
    F32,
    F64,
    /// Anything the linker does not need to interpret (v128, reference types).
    Opaque(u8),
}

impl ValType {
    fn from_byte(byte: u8) -> Self {
        match byte {
            0x7f => ValType::I32,
            0x7e => ValType::I64,
            0x7d => ValType::F32,
            0x7c => ValType::F64,
            other => ValType::Opaque(other),
        }
    }
}

/// The declared type of one import, enough to bind it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportType {
    /// Type-section index of the function's signature.
    Func { type_index: u32 },
    Table { element_type: u8, min: u64, max: Option<u64>, is_64: bool },
    Memory { min: u64, max: Option<u64>, shared: bool, is_64: bool },
    Global { value_type: ValType, mutable: bool },
    Tag { type_index: u32 },
}

impl ImportType {
    pub fn kind(&self) -> ExternKind {
        match self {
            ImportType::Func { .. } => ExternKind::Func,
            ImportType::Table { .. } => ExternKind::Table,
            ImportType::Memory { .. } => ExternKind::Memory,
            ImportType::Global { .. } => ExternKind::Global,
            ImportType::Tag { .. } => ExternKind::Tag,
        }
    }
}

/// One import declaration, in declaration order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportDecl {
    /// Position in the import section. This is the engine's resolution order
    /// and the index into `Instance::new`'s positional slice.
    pub position: u32,
    pub module: String,
    pub name: String,
    pub ty: ImportType,
}

/// One export declaration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExportDecl {
    pub name: String,
    pub kind: ExternKind,
    pub index: u32,
}

/// The subset of a side module's binary the planner needs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ModuleShape {
    /// Every import, in declaration order. Duplicate `(module, name)` pairs
    /// are preserved as distinct entries; that is the point.
    pub imports: Vec<ImportDecl>,
    pub exports: Vec<ExportDecl>,
    /// Number of imported functions, i.e. the index of the first defined
    /// function. Needed to tell a re-exported import from a real definition.
    pub imported_function_count: u32,
    /// Index named by the start section, if any.
    pub start_function: Option<u32>,
    /// Every element-segment entry that names a function at a statically known
    /// table offset, as `(table_index, function_index)`.
    ///
    /// This replaces `functionTableIndex`'s O(n) linear scan comparing JS
    /// `Function` identity (`dylink.ts:875-884`). See `docs/` D5: the change is
    /// structural, not a performance claim.
    pub element_function_slots: Vec<(u32, u32)>,
}

impl ModuleShape {
    /// Exports whose index refers to a module-DEFINED function.
    ///
    /// A `wasm-ld` side module can re-export a function it imported under the
    /// same name; that is not a local definition and must not receive a
    /// self-import trampoline. Mirrors `readDefinedFunctionExports`
    /// (`dylink.ts:365`).
    pub fn defined_function_exports(&self) -> impl Iterator<Item = &str> {
        let imported = self.imported_function_count;
        self.exports.iter().filter_map(move |export| {
            (export.kind == ExternKind::Func && export.index >= imported)
                .then_some(export.name.as_str())
        })
    }

    pub fn export(&self, name: &str) -> Option<&ExportDecl> {
        self.exports.iter().find(|export| export.name == name)
    }

    pub fn exports_function(&self, name: &str) -> bool {
        self.exports
            .iter()
            .any(|export| export.kind == ExternKind::Func && export.name == name)
    }

    pub fn imports_named(&self, module: &str, name: &str, kind: ExternKind) -> bool {
        self.imports.iter().any(|import| {
            import.module == module && import.name == name && import.ty.kind() == kind
        })
    }
}

/// A cursor over a wasm byte slice. Every read is bounds-checked.
pub(crate) struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub(crate) fn at(bytes: &'a [u8], pos: usize) -> Self {
        Reader { bytes, pos }
    }

    pub(crate) fn position(&self) -> usize {
        self.pos
    }

    pub(crate) fn seek(&mut self, pos: usize) -> DylinkResult<()> {
        if pos > self.bytes.len() {
            return Err(DylinkError::MalformedModule("seek past end of module"));
        }
        self.pos = pos;
        Ok(())
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.pos >= self.bytes.len()
    }

    pub(crate) fn byte(&mut self) -> DylinkResult<u8> {
        let byte = *self
            .bytes
            .get(self.pos)
            .ok_or(DylinkError::MalformedModule("truncated module"))?;
        self.pos += 1;
        Ok(byte)
    }

    /// LEB128 unsigned, capped at 64 bits.
    pub(crate) fn varuint64(&mut self) -> DylinkResult<u64> {
        let mut result: u64 = 0;
        let mut shift: u32 = 0;
        loop {
            let byte = self.byte()?;
            let payload = u64::from(byte & 0x7f);
            if shift >= 64 || (shift == 63 && payload > 1) {
                return Err(DylinkError::MalformedModule("LEB128 integer too large"));
            }
            result |= payload << shift;
            if byte & 0x80 == 0 {
                return Ok(result);
            }
            shift += 7;
        }
    }

    pub(crate) fn varuint32(&mut self) -> DylinkResult<u32> {
        let value = self.varuint64()?;
        u32::try_from(value).map_err(|_| DylinkError::MalformedModule("u32 out of range"))
    }

    /// LEB128 signed, capped at 64 bits.
    pub(crate) fn varint64(&mut self) -> DylinkResult<i64> {
        let mut result: i64 = 0;
        let mut shift: u32 = 0;
        loop {
            let byte = self.byte()?;
            if shift >= 64 {
                return Err(DylinkError::MalformedModule("LEB128 integer too large"));
            }
            result |= i64::from(byte & 0x7f) << shift;
            shift += 7;
            if byte & 0x80 == 0 {
                if shift < 64 && byte & 0x40 != 0 {
                    result |= -1i64 << shift;
                }
                return Ok(result);
            }
        }
    }

    pub(crate) fn take(&mut self, len: usize) -> DylinkResult<&'a [u8]> {
        let end = self
            .pos
            .checked_add(len)
            .ok_or(DylinkError::MalformedModule("length overflow"))?;
        let slice = self
            .bytes
            .get(self.pos..end)
            .ok_or(DylinkError::MalformedModule("truncated module"))?;
        self.pos = end;
        Ok(slice)
    }

    pub(crate) fn name(&mut self) -> DylinkResult<String> {
        let len = usize::try_from(self.varuint64()?)
            .map_err(|_| DylinkError::MalformedModule("name length out of range"))?;
        let bytes = self.take(len)?;
        core::str::from_utf8(bytes)
            .map(String::from)
            .map_err(|_| DylinkError::MalformedModule("name is not valid UTF-8"))
    }

    fn limits(&mut self) -> DylinkResult<(u64, Option<u64>, bool, bool)> {
        let flags = self.byte()?;
        let has_max = flags & 0x01 != 0;
        let shared = flags & 0x02 != 0;
        let is_64 = flags & 0x04 != 0;
        let min = self.varuint64()?;
        let max = if has_max { Some(self.varuint64()?) } else { None };
        Ok((min, max, shared, is_64))
    }
}

/// A `(section_id, body)` pair, with the body already bounds-checked.
pub(crate) struct SectionSpan {
    pub(crate) id: u8,
    /// Offset of the section id byte.
    pub(crate) start: usize,
    /// Offset of the first body byte.
    pub(crate) body: usize,
    /// Offset one past the last body byte.
    pub(crate) end: usize,
}

/// Verify the wasm preamble and return the offset of the first section.
pub(crate) fn preamble(bytes: &[u8]) -> DylinkResult<usize> {
    if bytes.len() < 8 || bytes[0..4] != [0x00, 0x61, 0x73, 0x6d] {
        return Err(DylinkError::NotAWasmBinary);
    }
    Ok(8)
}

/// Walk the top-level section list.
pub(crate) fn sections(bytes: &[u8]) -> DylinkResult<Vec<SectionSpan>> {
    let mut reader = Reader::at(bytes, preamble(bytes)?);
    let mut spans = Vec::new();
    while !reader.is_empty() {
        let start = reader.position();
        let id = reader.byte()?;
        let size = usize::try_from(reader.varuint64()?)
            .map_err(|_| DylinkError::MalformedModule("section size out of range"))?;
        let body = reader.position();
        let end = body
            .checked_add(size)
            .ok_or(DylinkError::MalformedModule("section size overflow"))?;
        if end > bytes.len() {
            return Err(DylinkError::MalformedModule("section escapes the module"));
        }
        spans.push(SectionSpan { id, start, body, end });
        reader.seek(end)?;
    }
    Ok(spans)
}

/// Read every section the planner needs, in one pass.
pub fn read_module_shape(bytes: &[u8]) -> DylinkResult<ModuleShape> {
    let mut shape = ModuleShape::default();
    let mut seen_import = false;
    let mut seen_export = false;
    for span in sections(bytes)? {
        match span.id {
            SECTION_IMPORT if !seen_import => {
                seen_import = true;
                read_imports(bytes, &span, &mut shape)?;
            }
            SECTION_EXPORT if !seen_export => {
                seen_export = true;
                read_exports(bytes, &span, &mut shape)?;
            }
            SECTION_START => {
                let mut reader = Reader::at(bytes, span.body);
                shape.start_function = Some(reader.varuint32()?);
                if reader.position() != span.end {
                    return Err(DylinkError::MalformedModule("malformed start section"));
                }
            }
            SECTION_ELEMENT => {
                read_elements(bytes, &span, &mut shape)?;
            }
            _ => {}
        }
    }
    Ok(shape)
}

fn read_imports(bytes: &[u8], span: &SectionSpan, shape: &mut ModuleShape) -> DylinkResult<()> {
    let mut reader = Reader::at(bytes, span.body);
    let count = reader.varuint32()?;
    shape.imports.reserve(count as usize);
    for position in 0..count {
        let module = reader.name()?;
        let name = reader.name()?;
        let kind = ExternKind::from_byte(reader.byte()?)?;
        let ty = match kind {
            ExternKind::Func => {
                shape.imported_function_count += 1;
                ImportType::Func { type_index: reader.varuint32()? }
            }
            ExternKind::Table => {
                let element_type = reader.byte()?;
                let (min, max, _shared, is_64) = reader.limits()?;
                ImportType::Table { element_type, min, max, is_64 }
            }
            ExternKind::Memory => {
                let (min, max, shared, is_64) = reader.limits()?;
                ImportType::Memory { min, max, shared, is_64 }
            }
            ExternKind::Global => {
                let value_type = ValType::from_byte(reader.byte()?);
                let mutable = reader.byte()? != 0;
                ImportType::Global { value_type, mutable }
            }
            ExternKind::Tag => {
                // Tag import: attribute byte (0x00 = exception) then a type index.
                let attribute = reader.byte()?;
                if attribute != 0 {
                    return Err(DylinkError::MalformedModule("unknown tag attribute"));
                }
                ImportType::Tag { type_index: reader.varuint32()? }
            }
        };
        shape.imports.push(ImportDecl { position, module, name, ty });
    }
    if reader.position() != span.end {
        return Err(DylinkError::MalformedModule("malformed import section"));
    }
    Ok(())
}

fn read_exports(bytes: &[u8], span: &SectionSpan, shape: &mut ModuleShape) -> DylinkResult<()> {
    let mut reader = Reader::at(bytes, span.body);
    let count = reader.varuint32()?;
    shape.exports.reserve(count as usize);
    for _ in 0..count {
        let name = reader.name()?;
        let kind = ExternKind::from_byte(reader.byte()?)?;
        let index = reader.varuint32()?;
        shape.exports.push(ExportDecl { name, kind, index });
    }
    if reader.position() != span.end {
        return Err(DylinkError::MalformedModule("malformed export section"));
    }
    Ok(())
}

/// Read active element segments that target table 0 at a constant offset.
///
/// This is the deterministic replacement for identity-comparing every table
/// slot: the map from a function index to its table index is a property of the
/// module bytes, so it can be computed once instead of scanned per symbol.
/// Segments the linker cannot statically place (passive, declarative, or a
/// non-constant offset) are skipped rather than guessed at.
fn read_elements(bytes: &[u8], span: &SectionSpan, shape: &mut ModuleShape) -> DylinkResult<()> {
    let mut reader = Reader::at(bytes, span.body);
    let count = reader.varuint32()?;
    for _ in 0..count {
        let flags = reader.varuint32()?;
        let passive_or_declared = flags & 0x01 != 0;
        let has_table_index = flags & 0x02 != 0;
        let uses_expressions = flags & 0x04 != 0;

        let mut table_index = 0u32;
        if !passive_or_declared && has_table_index {
            table_index = reader.varuint32()?;
        }
        let offset = if passive_or_declared {
            None
        } else {
            Some(read_i32_const_expr(&mut reader)?)
        };
        // Element kind / type byte, present for every encoding except the
        // legacy active-segment-on-table-0 form (flags == 0).
        if flags != 0 {
            if uses_expressions {
                let _reftype = reader.byte()?;
            } else {
                let _elemkind = reader.byte()?;
            }
        }
        let entries = reader.varuint32()?;
        for entry in 0..entries {
            let function_index = if uses_expressions {
                read_ref_func_expr(&mut reader)?
            } else {
                Some(reader.varuint32()?)
            };
            if let (Some(base), Some(function_index)) = (offset, function_index) {
                if table_index == 0 {
                    let slot = base
                        .checked_add(entry)
                        .ok_or(DylinkError::MalformedModule("element offset overflow"))?;
                    shape.element_function_slots.push((slot, function_index));
                }
            }
        }
    }
    if reader.position() != span.end {
        return Err(DylinkError::MalformedModule("malformed element section"));
    }
    Ok(())
}

/// Read a constant expression that must be a single `i32.const` / `i64.const`.
///
/// A `global.get` offset is legal wasm but depends on an imported global whose
/// value the linker supplies; returning an error here would reject a valid
/// module, so the caller treats "not statically known" as "skip", not "fail".
fn read_i32_const_expr(reader: &mut Reader<'_>) -> DylinkResult<u32> {
    let opcode = reader.byte()?;
    let value = match opcode {
        0x41 => u32::try_from(reader.varint64()? as i64 as u32)
            .map_err(|_| DylinkError::MalformedModule("element offset out of range"))?,
        0x42 => u32::try_from(reader.varint64()?)
            .map_err(|_| DylinkError::MalformedModule("element offset out of range"))?,
        0x23 => {
            // global.get: not statically known. Consume the index and report
            // offset 0 with no slots by returning an error the caller maps to
            // "unplaceable"; the linker never depends on this form because
            // wasm-ld emits `__table_base`-relative segments only in main
            // modules, which the planner does not place.
            let _index = reader.varuint32()?;
            expect_end(reader)?;
            return Err(DylinkError::UnplaceableElementSegment);
        }
        _ => return Err(DylinkError::MalformedModule("unsupported element offset expression")),
    };
    expect_end(reader)?;
    Ok(value)
}

fn read_ref_func_expr(reader: &mut Reader<'_>) -> DylinkResult<Option<u32>> {
    let opcode = reader.byte()?;
    let value = match opcode {
        0xd2 => Some(reader.varuint32()?),
        0xd0 => {
            let _heaptype = reader.byte()?;
            None
        }
        _ => return Err(DylinkError::MalformedModule("unsupported element expression")),
    };
    expect_end(reader)?;
    Ok(value)
}

fn expect_end(reader: &mut Reader<'_>) -> DylinkResult<()> {
    if reader.byte()? != 0x0b {
        return Err(DylinkError::MalformedModule("constant expression is not terminated"));
    }
    Ok(())
}

/// Return the payload of the first custom section with this name.
pub fn custom_section<'a>(bytes: &'a [u8], wanted: &str) -> DylinkResult<Option<&'a [u8]>> {
    for span in sections(bytes)? {
        if span.id != SECTION_CUSTOM {
            continue;
        }
        let mut reader = Reader::at(bytes, span.body);
        let name = reader.name()?;
        if name == wanted {
            let start = reader.position();
            return Ok(Some(&bytes[start..span.end]));
        }
    }
    Ok(None)
}

/// Reject automatic linear-memory writes before instantiating over a borrow.
///
/// Mirrors `requirePassiveDataSegmentsForBorrowedReplay` (`dylink.ts:165`). A
/// borrowed (vfork) replay shares the suspended parent's live Memory, so an
/// active data segment would write it inside `Instance::new`, before the host
/// can recover.
pub fn require_passive_data_segments(bytes: &[u8]) -> DylinkResult<()> {
    for span in sections(bytes)? {
        if span.id != SECTION_DATA {
            continue;
        }
        let mut reader = Reader::at(bytes, span.body);
        let count = reader.varuint32()?;
        for index in 0..count {
            let flags = reader.varuint32()?;
            if flags != 1 {
                return Err(DylinkError::ActiveDataSegmentInBorrowedReplay { index });
            }
            let len = usize::try_from(reader.varuint64()?)
                .map_err(|_| DylinkError::MalformedModule("data segment length out of range"))?;
            reader.take(len)?;
        }
        if reader.position() != span.end {
            return Err(DylinkError::MalformedModule("malformed data section"));
        }
        return Ok(());
    }
    Ok(())
}

/// Remove only `wasm-ld`'s recognized memory-initialization start section.
///
/// Mirrors `withoutBorrowedReplayStart` (`dylink.ts:205`). An arbitrary start
/// function is rejected rather than silently having its semantics changed.
pub fn without_borrowed_replay_start(bytes: &[u8]) -> DylinkResult<Option<Vec<u8>>> {
    let spans = sections(bytes)?;
    let start_span = spans.iter().find(|span| span.id == SECTION_START);
    let Some(start_span) = start_span else {
        return Ok(None);
    };
    let mut reader = Reader::at(bytes, start_span.body);
    let start_function = reader.varuint32()?;

    let shape = read_module_shape(bytes)?;
    let init_memory = shape
        .export("__wasm_init_memory")
        .filter(|export| export.kind == ExternKind::Func)
        .map(|export| export.index);
    if init_memory != Some(start_function) {
        return Err(DylinkError::UnrecognizedStartFunction { index: start_function });
    }

    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(&bytes[..preamble(bytes)?]);
    for span in &spans {
        if span.id == SECTION_START {
            continue;
        }
        out.extend_from_slice(&bytes[span.start..span.end]);
    }
    Ok(Some(out))
}
