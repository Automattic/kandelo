use alloc::vec::Vec;
use wasm_posix_program_abi::abi;
use wasmparser::{BinaryReader, ExternalKind, Imports, Parser, Payload, TypeRef};

pub const POLICY_TYPE_SCRATCH_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PolicyReadLimits {
    pub metadata_bytes: usize,
    pub work_items: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyReadError {
    InvalidLimits,
    InvalidModule,
    MetadataLimit,
    WorkLimit,
    Allocation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PolicySurface {
    pub pointer_width: u8,
    pub abi_version: Option<i32>,
    pub mixed_memory_widths: bool,
    pub has_fork_surface: bool,
    pub imports_kernel_fork: bool,
    pub contains_legacy_asyncify: bool,
}

struct Budget {
    limits: PolicyReadLimits,
    retained: usize,
    work: usize,
}

impl Budget {
    fn step(&mut self, count: usize) -> Result<(), PolicyReadError> {
        self.work = self
            .work
            .checked_add(count)
            .filter(|work| *work <= self.limits.work_items)
            .ok_or(PolicyReadError::WorkLimit)?;
        Ok(())
    }

    fn push<Value>(
        &mut self,
        values: &mut Vec<Value>,
        value: Value,
    ) -> Result<(), PolicyReadError> {
        if values.len() == values.capacity() {
            let old = values
                .capacity()
                .checked_mul(core::mem::size_of::<Value>())
                .ok_or(PolicyReadError::MetadataLimit)?;
            let capacity = values
                .capacity()
                .checked_mul(2)
                .unwrap_or(usize::MAX)
                .max(8);
            let requested = capacity
                .checked_mul(core::mem::size_of::<Value>())
                .ok_or(PolicyReadError::MetadataLimit)?;
            self.retained
                .checked_add(requested)
                .filter(|peak| *peak <= self.limits.metadata_bytes)
                .ok_or(PolicyReadError::MetadataLimit)?;
            values
                .try_reserve_exact(capacity - values.len())
                .map_err(|_| PolicyReadError::Allocation)?;
            let actual = values
                .capacity()
                .checked_mul(core::mem::size_of::<Value>())
                .ok_or(PolicyReadError::MetadataLimit)?;
            self.retained = self
                .retained
                .checked_add(actual)
                .and_then(|retained| retained.checked_sub(old))
                .filter(|retained| *retained <= self.limits.metadata_bytes)
                .ok_or(PolicyReadError::MetadataLimit)?;
        }
        values.push(value);
        Ok(())
    }
}

fn decoded<Value>(
    value: Result<Value, wasmparser::BinaryReaderError>,
) -> Result<Value, PolicyReadError> {
    value.map_err(|_| PolicyReadError::InvalidModule)
}

fn qualified(module: &str, name: &str, required_module: &str, required_name: &str) -> bool {
    module
        .bytes()
        .chain(core::iter::once(b'.'))
        .chain(name.bytes())
        .eq(required_module
            .bytes()
            .chain(core::iter::once(b'.'))
            .chain(required_name.bytes()))
}

fn function_type(types: &[bool], index: u32) -> Result<(), PolicyReadError> {
    if types.get(index as usize) == Some(&true) {
        Ok(())
    } else {
        Err(PolicyReadError::InvalidModule)
    }
}

fn packed_index(reader: &mut BinaryReader<'_>) -> Result<(), PolicyReadError> {
    let index = decoded(reader.read_var_u32())?;
    if wasmparser::PackedIndex::from_module_index(index).is_none() {
        return Err(PolicyReadError::InvalidModule);
    }
    Ok(())
}

fn type_values(reader: &mut BinaryReader<'_>, budget: &mut Budget) -> Result<(), PolicyReadError> {
    let count = decoded(reader.read_size(1000, "function values"))?;
    budget.step(count)?;
    for _ in 0..count {
        decoded(reader.read::<wasmparser::ValType>())?;
    }
    Ok(())
}

fn subtype(reader: &mut BinaryReader<'_>, budget: &mut Budget) -> Result<bool, PolicyReadError> {
    let mut opcode = decoded(reader.read_u8())?;
    if opcode == 0x4f || opcode == 0x50 {
        let count = decoded(reader.read_size(1, "supertypes"))?;
        budget.step(count)?;
        for _ in 0..count {
            packed_index(reader)?;
        }
        opcode = decoded(reader.read_u8())?;
    }
    if opcode == 0x65 {
        opcode = decoded(reader.read_u8())?;
    }
    if opcode == 0x4c {
        packed_index(reader)?;
        opcode = decoded(reader.read_u8())?;
    }
    if opcode == 0x4d {
        packed_index(reader)?;
        opcode = decoded(reader.read_u8())?;
    }
    match opcode {
        0x60 => {
            type_values(reader, budget)?;
            type_values(reader, budget)?;
            Ok(true)
        }
        0x5f => {
            let count = decoded(reader.read_size(10_000, "struct fields"))?;
            budget.step(count)?;
            for _ in 0..count {
                decoded(reader.read::<wasmparser::FieldType>())?;
            }
            Ok(false)
        }
        0x5e => {
            budget.step(1)?;
            decoded(reader.read::<wasmparser::FieldType>())?;
            Ok(false)
        }
        0x5d => {
            budget.step(1)?;
            decoded(reader.read::<wasmparser::ContType>())?;
            Ok(false)
        }
        _ => Err(PolicyReadError::InvalidModule),
    }
}

struct ConstOperator;

impl wasmparser::FrameStack for ConstOperator {
    fn current_frame(&self) -> Option<wasmparser::FrameKind> {
        Some(wasmparser::FrameKind::Block)
    }
}

macro_rules! const_visitor {
    ($(@$proposal:ident $operator:ident $({$($argument:ident: $argument_type:ty),*})? => $visit:ident ($($annotation:tt)*))*) => {
        $(fn $visit(&mut self $($(, $argument: $argument_type)*)?) {
            $(let _ = ($($argument,)*);)?
        })*
    };
}

impl<'a> wasmparser::VisitOperator<'a> for ConstOperator {
    type Output = ();
    wasmparser::for_each_visit_operator!(const_visitor);
}

fn table(reader: &mut BinaryReader<'_>, budget: &mut Budget) -> Result<(), PolicyReadError> {
    let mut peek = reader.clone();
    let initialized = decoded(peek.read_u8())? == 0x40;
    if initialized {
        decoded(reader.read_u8())?;
        if decoded(reader.read_u8())? != 0 {
            return Err(PolicyReadError::InvalidModule);
        }
    }
    decoded(reader.read::<wasmparser::TableType>())?;
    if initialized {
        loop {
            budget.step(1)?;
            let mut peek = reader.clone();
            let opcode = decoded(peek.read_u8())?;
            if opcode == 0x0b {
                decoded(reader.read_u8())?;
                break;
            }
            if opcode == 0xfd {
                decoded(reader.read_u8())?;
                if decoded(reader.read_var_u32())? != 12 {
                    return Err(PolicyReadError::InvalidModule);
                }
                decoded(reader.read_bytes(16))?;
                continue;
            }
            if !matches!(opcode, 0x23 | 0x41..=0xc4 | 0xd0..=0xd4 | 0xfb..=0xfd) {
                return Err(PolicyReadError::InvalidModule);
            }
            decoded(reader.visit_operator(&mut ConstOperator))?;
        }
    }
    Ok(())
}

fn marker_function(
    bytes: &[u8],
    index: u32,
    imports: u32,
    depth: u32,
    budget: &mut Budget,
) -> Result<Option<i32>, PolicyReadError> {
    if depth > 4 {
        return Ok(None);
    }
    let Some(ordinal) = index.checked_sub(imports) else {
        return Ok(None);
    };
    let mut defined = 0u32;
    let mut selected = None;
    for payload in Parser::new(0).parse_all(bytes) {
        budget.step(1)?;
        if let Payload::CodeSectionEntry(body) = decoded(payload)? {
            if defined == ordinal {
                selected = Some(body);
                break;
            }
            defined += 1;
        }
    }
    let Some(body) = selected else {
        return Ok(None);
    };
    let mut reader = body.get_binary_reader();
    let locals = decoded(reader.read_var_u32())? as usize;
    budget.step(locals)?;
    for _ in 0..locals {
        decoded(reader.read_var_u32())?;
        decoded(reader.read::<wasmparser::ValType>())?;
    }
    let mut constant = None;
    let mut call = None;
    while !reader.eof() {
        budget.step(1)?;
        match decoded(reader.read_u8())? {
            0x41 => {
                constant = Some(decoded(reader.read_var_i32())?);
                call = None;
            }
            0x10 => {
                call = Some(decoded(reader.read_var_u32())?);
                constant = None;
            }
            0x01 => {
                constant = None;
                call = None;
            }
            0x0b | 0x0f => {
                if let Some(value) = constant {
                    return Ok(Some(value));
                }
                if let Some(callee) = call {
                    return marker_function(bytes, callee, imports, depth + 1, budget);
                }
                return Ok(None);
            }
            _ => return Ok(None),
        }
    }
    Ok(None)
}

fn memory(surface: &mut PolicySurface, first: &mut Option<u8>, memory64: bool) {
    let width = if memory64 { 8 } else { 4 };
    if let Some(previous) = *first {
        surface.mixed_memory_widths |= previous != width;
    } else {
        *first = Some(width);
        surface.pointer_width = width;
    }
}

fn fork_section(name: &str) -> bool {
    [
        abi::WPK_FORK_CAPABILITIES_SECTION,
        abi::WPK_FORK_LINKED_FRAME_FORMAT_SECTION,
        abi::WPK_FORK_MODULE_STATE_FORMAT_SECTION,
        abi::WPK_FORK_EXCEPTION_CODEC_SECTION,
        abi::WPK_FORK_IMPORTED_GLOBALS_SECTION,
        abi::WPK_FORK_IMPORTED_TABLES_SECTION,
        abi::WPK_FORK_UNWIND_TRANSPORT_SECTION,
    ]
    .contains(&name)
}

pub fn read_policy_surface(
    bytes: &[u8],
    limits: PolicyReadLimits,
) -> Result<PolicySurface, PolicyReadError> {
    if limits.metadata_bytes == 0 || limits.work_items == 0 {
        return Err(PolicyReadError::InvalidLimits);
    }
    if !crate::facts::is_wasm_module(bytes) {
        return Err(PolicyReadError::InvalidModule);
    }
    if limits.metadata_bytes < POLICY_TYPE_SCRATCH_BYTES {
        return Err(PolicyReadError::MetadataLimit);
    }
    let mut budget = Budget {
        limits,
        retained: POLICY_TYPE_SCRATCH_BYTES,
        work: 0,
    };
    let mut types = Vec::new();
    let mut functions = Vec::new();
    let mut exports = Vec::new();
    let mut first_memory = None;
    let mut marker = None;
    let mut imports = 0u32;
    let mut surface = PolicySurface {
        pointer_width: 4,
        abi_version: None,
        mixed_memory_widths: false,
        has_fork_surface: false,
        imports_kernel_fork: false,
        contains_legacy_asyncify: false,
    };
    for payload in Parser::new(0).parse_all(bytes) {
        budget.step(1)?;
        match decoded(payload)? {
            Payload::TypeSection(section) => {
                let start = section.original_position();
                let mut reader = BinaryReader::new(&bytes[start..section.range().end], start);
                for _ in 0..section.count() {
                    budget.step(1)?;
                    let mut peek = reader.clone();
                    let count = if decoded(peek.read_u8())? == 0x4e {
                        decoded(reader.read_u8())?;
                        let count = decoded(reader.read_var_u32())? as usize;
                        if count > 1_000_000 {
                            return Err(PolicyReadError::InvalidModule);
                        }
                        count
                    } else {
                        1
                    };
                    budget.step(count)?;
                    for _ in 0..count {
                        let is_function = subtype(&mut reader, &mut budget)?;
                        budget.push(&mut types, is_function)?;
                    }
                }
                if !reader.eof() {
                    return Err(PolicyReadError::InvalidModule);
                }
            }
            Payload::ImportSection(section) => {
                let start = section.original_position();
                let mut reader = BinaryReader::new(&bytes[start..section.range().end], start);
                for _ in 0..section.count() {
                    budget.step(1)?;
                    let mut peek = reader.clone();
                    decoded(peek.read_string())?;
                    let name = decoded(peek.read_string())?;
                    let kind = decoded(peek.read_u8())?;
                    let count = if name.is_empty() && (kind == 0x7f || kind == 0x7e) {
                        if kind == 0x7e {
                            decoded(peek.read::<TypeRef>())?;
                        }
                        decoded(peek.read_var_u32())? as usize
                    } else {
                        1
                    };
                    budget.step(count)?;
                    let group: Imports<'_> = decoded(reader.read())?;
                    for item in group {
                        let (_, import) = decoded(item)?;
                        match import.ty {
                            TypeRef::Func(index) | TypeRef::FuncExact(index) => {
                                function_type(&types, index)?;
                                budget.push(&mut functions, index)?;
                                imports = imports
                                    .checked_add(1)
                                    .ok_or(PolicyReadError::InvalidModule)?;
                                surface.imports_kernel_fork |= import.module == abi::WPK_FORK_PROCESS_IMPORT.module
                                    && import.name == abi::WPK_FORK_PROCESS_IMPORT.name;
                                surface.has_fork_surface |=
                                    abi::WPK_FORK_REQUIRED_IMPORTS.iter().any(|required| {
                                        qualified(
                                            import.module,
                                            import.name,
                                            required.module,
                                            required.name,
                                        )
                                    });
                            }
                            TypeRef::Tag(tag) => {
                                function_type(&types, tag.func_type_idx)?;
                                surface.has_fork_surface |= qualified(
                                    import.module,
                                    import.name,
                                    abi::WPK_FORK_UNWIND_TAG_IMPORT_MODULE,
                                    abi::WPK_FORK_UNWIND_TAG_IMPORT_NAME,
                                );
                            }
                            TypeRef::Memory(ty) => {
                                memory(&mut surface, &mut first_memory, ty.memory64)
                            }
                            _ => {}
                        }
                    }
                }
                if !reader.eof() {
                    return Err(PolicyReadError::InvalidModule);
                }
            }
            Payload::FunctionSection(section) => {
                budget.step(section.count() as usize)?;
                for index in section {
                    budget.push(&mut functions, decoded(index)?)?;
                }
            }
            Payload::TableSection(section) => {
                budget.step(section.count() as usize)?;
                let start = section.original_position();
                let mut reader = BinaryReader::new(&bytes[start..section.range().end], start);
                for _ in 0..section.count() {
                    table(&mut reader, &mut budget)?;
                }
                if !reader.eof() {
                    return Err(PolicyReadError::InvalidModule);
                }
            }
            Payload::MemorySection(section) => {
                budget.step(section.count() as usize)?;
                for ty in section {
                    memory(&mut surface, &mut first_memory, decoded(ty)?.memory64);
                }
            }
            Payload::ExportSection(section) => {
                budget.step(section.count() as usize)?;
                for export in section {
                    let export = decoded(export)?;
                    surface.contains_legacy_asyncify |= export.name.starts_with("asyncify_");
                    if export.kind == ExternalKind::Func {
                        budget.push(&mut exports, export.index)?;
                        if export.name == "__abi_version" {
                            marker = Some(export.index);
                        }
                        surface.has_fork_surface |= abi::WPK_FORK_REQUIRED_EXPORTS
                            .iter()
                            .any(|required| required.name == export.name);
                    }
                }
            }
            Payload::CustomSection(section) => {
                surface.has_fork_surface |= fork_section(section.name())
            }
            Payload::CodeSectionStart { count, .. } => budget.step(count as usize)?,
            _ => {}
        }
    }
    for index in exports {
        let index = functions
            .get(index as usize)
            .ok_or(PolicyReadError::InvalidModule)?;
        function_type(&types, *index)?;
    }
    if let Some(index) = marker {
        surface.abi_version = marker_function(bytes, index, imports, 0, &mut budget)?;
    }
    Ok(surface)
}
