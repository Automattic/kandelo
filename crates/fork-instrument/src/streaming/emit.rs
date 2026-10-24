use std::io::{Read, Seek, SeekFrom, Write};

use anyhow::{Context, Result, bail, ensure};
use wasm_encoder::{Encode, Section, reencode::Reencode};
use wasmparser::{Parser, Payload};

use super::{
    FrozenDeclarations, FrozenImports, FrozenModuleDeclarations, FunctionIr, IrLimits,
    ProgramPoint, Scan,
};
mod spool;
use spool::Spool;

/// Encoded output is retained for one body or one non-code section, never
/// the entire code section/module. Large data payloads bypass the encoder.
#[derive(Clone, Copy, Debug)]
pub struct EmitLimits {
    pub max_function_bytes: usize,
    pub max_metadata_section_bytes: usize,
    pub max_spooled_section_bytes: u64,
}

impl Default for EmitLimits {
    fn default() -> Self {
        Self {
            max_function_bytes: 32 * 1024 * 1024,
            max_metadata_section_bytes: 64 * 1024 * 1024,
            max_spooled_section_bytes: u64::from(u32::MAX),
        }
    }
}

/// Function-local rewriting hook. The caller freezes all declarations and
/// index mappings before invoking emission. The default implementation remaps
/// every instruction, including instructions outside the fork closure.
///
/// Implementations must bound any additional scratch storage and use the
/// provided limit while building a body. No helper may be declared here:
/// later declarations could invalidate earlier emitted function indices.
pub trait FunctionTransform: Reencode {
    /// Module bootstrap owns active segments and the original start. Segment
    /// indices stay unchanged; data payloads still pass through the disk spool.
    /// The caller must install the corresponding frozen bootstrap helpers.
    fn defer_module_initializers(&self) -> bool {
        false
    }
    /// Runtime imports are frozen before emission. The transform's Reencode
    /// mapping must use this plan (or a complete mapping derived from it).
    fn imports(&self) -> Option<&FrozenImports> {
        None
    }
    fn module_declarations(&self) -> Option<&FrozenModuleDeclarations> {
        None
    }
    /// The emitter snapshots these declarations before writing any section.
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        None
    }

    /// Helpers use final indices and are generated/serialized serially after
    /// all original source bodies. Their count and type cannot change here.
    fn emit_helper(&mut self, _helper: u32, _limit: usize) -> Result<wasm_encoder::Function> {
        bail!("missing frozen helper body")
    }

    /// Opt into validated, Kandelo-owned function-local IR. The emitter owns
    /// its lifetime and drops it before decoding the next function.
    fn function_ir_limits(&self) -> Option<IrLimits> {
        None
    }

    fn transform_ir(
        &mut self,
        function: &FunctionIr<'_>,
        limit: usize,
    ) -> Result<wasm_encoder::Function>
    where
        Self::Error: std::error::Error + Send + Sync + 'static,
    {
        function.emit(self, limit)
    }

    fn transform_body(
        &mut self,
        original_function: u32,
        body: wasmparser::FunctionBody<'_>,
        limit: usize,
    ) -> Result<wasm_encoder::Function>
    where
        Self::Error: std::error::Error + Send + Sync + 'static,
    {
        let mut function = self.new_function_with_parsed_locals(&body)?;
        let mut reader = body.get_operators_reader()?;
        while !reader.eof() {
            let point = ProgramPoint {
                function: original_function,
                offset: reader.original_position(),
            };
            let op = reader.read()?;
            self.transform_operator(point, op, &mut function)?;
            ensure!(
                function.byte_len() <= limit,
                "encoded function exceeds streaming output budget"
            );
        }
        Ok(function)
    }

    fn transform_operator(
        &mut self,
        _point: ProgramPoint,
        op: wasmparser::Operator<'_>,
        function: &mut wasm_encoder::Function,
    ) -> Result<()>
    where
        Self::Error: std::error::Error + Send + Sync + 'static,
    {
        function.instruction(&self.instruction(op)?);
        Ok(())
    }
}

impl FunctionTransform for wasm_encoder::reencode::RoundtripReencoder {}

#[derive(Debug, Default)]
pub struct EmitReport {
    pub functions: u32,
    pub helper_functions: u32,
    pub largest_encoded_function: usize,
    pub spooled_code_bytes: u64,
}

/// Re-encode a validated scan to a writer. Frozen imports and helpers may be
/// appended, but this primitive does not implement fork runtime behavior or
/// certify the output with fork capability metadata.
///
/// Code is spooled to an unlinked, private temporary file before its length
/// prefix is written. Disk use is O(output code + data); heap use is O(largest body
/// + capped metadata section), plus the caller's summaries. The writer may
/// contain partial output on error; use an atomic destination for publication.
/// Compiler facts and DWARF are build inputs and are removed. Unknown custom
/// sections are preserved, except linker relocations which require their own
/// relocation-aware emitter and fail explicitly here.
pub fn emit_remapped<T: FunctionTransform, W: Write>(
    scan: &Scan<'_>,
    transform: &mut T,
    output: &mut W,
    limits: EmitLimits,
) -> Result<EmitReport>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    let imports = transform
        .imports()
        .map(|imports| {
            imports.validate_source(scan)?;
            imports.check_budget(limits.max_metadata_section_bytes)?;
            Ok::<_, anyhow::Error>(imports.clone())
        })
        .transpose()?;
    let declarations = transform
        .declarations()
        .map(|declarations| {
            declarations.check_budget(limits.max_metadata_section_bytes)?;
            Ok::<_, anyhow::Error>(declarations.clone())
        })
        .transpose()?;
    let helper_count = declarations
        .as_ref()
        .map_or(0, FrozenDeclarations::function_count);
    if let Some(imports) = &imports {
        imports.validate_adapters(scan, transform, declarations.as_ref())?;
    }
    let module_declarations = transform
        .module_declarations()
        .map(|declarations| {
            declarations.validate(scan, imports.as_ref(), limits.max_metadata_section_bytes)?;
            Ok::<_, anyhow::Error>(declarations.clone())
        })
        .transpose()?;
    output.write_all(b"\0asm\x01\0\0\0")?;
    let mut report = EmitReport::default();
    let mut parser = Parser::new(0);
    parser.set_features(super::features());
    let mut code = None;
    let mut remaining = 0;
    let mut types_written = false;
    let mut imports_written = false;
    let mut functions_written = false;
    let mut module_written = [false; 6];
    let mut code_written = false;
    let defer_initializers = transform.defer_module_initializers();
    let mut data_count_written = false;
    let mut bodies = transform.function_ir_limits().map(|mut ir_limits| {
        ir_limits.body_bytes = ir_limits.body_bytes.min(limits.max_function_bytes);
        scan.body_provider(ir_limits)
    });
    for payload in parser.parse_all(scan.input()) {
        let payload = payload?;
        if !matches!(payload, Payload::CodeSectionEntry(_)) && remaining != 0 {
            bail!("incomplete code section during streaming emission");
        }
        // Insert absent declaration sections at their canonical positions.
        // Custom sections do not trigger insertion, preserving leading dylink.
        let standard = match &payload {
            Payload::TypeSection(_) => Some(1),
            Payload::ImportSection(_) => Some(2),
            Payload::FunctionSection(_) => Some(3),
            Payload::TableSection(_) => Some(4),
            Payload::MemorySection(_) => Some(5),
            Payload::TagSection(_) => Some(6),
            Payload::GlobalSection(_) => Some(7),
            Payload::ExportSection(_) => Some(8),
            Payload::StartSection { .. } => Some(9),
            Payload::ElementSection(_) => Some(10),
            Payload::DataCountSection { .. } => Some(11),
            Payload::CodeSectionStart { .. } => Some(12),
            Payload::DataSection(_) => Some(13),
            Payload::End(_) => Some(14),
            _ => None,
        };
        if let (Some(order), Some(declarations)) = (standard, &declarations) {
            if order > 1 && !types_written && declarations.type_count() != 0 {
                let mut section = wasm_encoder::TypeSection::new();
                declarations.append_types(&mut section);
                write_encoded_section(output, &section, limits.max_metadata_section_bytes)?;
                types_written = true;
            }
        }
        if let (Some(order), Some(imports)) = (standard, &imports) {
            if order > 2 && !imports_written && !imports.is_empty() {
                let mut section = wasm_encoder::ImportSection::new();
                imports.append(&mut section);
                write_encoded_section(output, &section, limits.max_metadata_section_bytes)?;
                imports_written = true;
            }
        }
        if let (Some(order), Some(declarations)) = (standard, &declarations) {
            if order > 3 && !functions_written && helper_count != 0 {
                let mut section = wasm_encoder::FunctionSection::new();
                declarations.append_functions(&mut section);
                write_encoded_section(output, &section, limits.max_metadata_section_bytes)?;
                functions_written = true;
            }
        }
        if let (Some(order), Some(declarations)) = (standard, &module_declarations) {
            macro_rules! insert {
                ($slot:expr,$order:expr,$count:ident,$section:ty,$append:ident) => {
                    if order > $order && !module_written[$slot] && declarations.$count() != 0 {
                        let mut section = <$section>::new();
                        declarations.$append(&mut section);
                        write_encoded_section(output, &section, limits.max_metadata_section_bytes)?;
                        module_written[$slot] = true;
                    }
                };
            }
            insert!(0, 4, table_count, wasm_encoder::TableSection, append_tables);
            insert!(
                1,
                5,
                memory_count,
                wasm_encoder::MemorySection,
                append_memories
            );
            insert!(2, 6, tag_count, wasm_encoder::TagSection, append_tags);
            insert!(
                3,
                7,
                global_count,
                wasm_encoder::GlobalSection,
                append_globals
            );
            insert!(
                4,
                8,
                export_count,
                wasm_encoder::ExportSection,
                append_exports
            );
            insert!(
                5,
                10,
                element_count,
                wasm_encoder::ElementSection,
                append_elements
            );
        }
        if let Some(order) = standard {
            if order > 11 && !data_count_written && defer_initializers && scan.data_segments != 0 {
                let section = wasm_encoder::DataCountSection {
                    count: transform.data_count(scan.data_segments)?,
                };
                write_encoded_section(output, &section, limits.max_metadata_section_bytes)?;
                data_count_written = true;
            }
            if order > 12 && !code_written && helper_count != 0 {
                let mut spool = Spool::new(limits.max_spooled_section_bytes)
                    .context("spooling helper-only code section")?;
                write_u32(&mut spool, helper_count)?;
                write_helpers(transform, helper_count, &mut spool, &mut report, limits)?;
                report.spooled_code_bytes = spool.stream_position()?;
                write_spool(output, 10, &mut spool)?;
                code_written = true;
            }
        }
        macro_rules! section {
            ($reader:expr, $ty:ty, $method:ident, $slot:expr,$append:ident) => {{
                let reader = $reader;
                ensure!(
                    reader.range().len() <= limits.max_metadata_section_bytes,
                    "metadata section exceeds streaming input budget"
                );
                let mut encoded = <$ty>::new();
                transform.$method(&mut encoded, reader)?;
                if let Some(declarations) = &module_declarations {
                    declarations.$append(&mut encoded);
                }
                write_encoded_section(output, &encoded, limits.max_metadata_section_bytes)?;
                module_written[$slot] = true;
            }};
        }
        match payload {
            Payload::Version { .. } | Payload::End(_) => {}
            Payload::TypeSection(s) => {
                ensure!(
                    s.range().len() <= limits.max_metadata_section_bytes,
                    "metadata section exceeds streaming input budget"
                );
                let mut section = wasm_encoder::TypeSection::new();
                transform.parse_type_section(&mut section, s)?;
                if let Some(declarations) = &declarations {
                    declarations.append_types(&mut section);
                }
                write_encoded_section(output, &section, limits.max_metadata_section_bytes)?;
                types_written = true;
            }
            Payload::ImportSection(s) => {
                ensure!(
                    s.range().len() <= limits.max_metadata_section_bytes,
                    "import section exceeds streaming input budget"
                );
                let mut section = wasm_encoder::ImportSection::new();
                if let Some(imports) = &imports {
                    imports.parse_source_imports(transform, &mut section, s)?;
                } else {
                    transform.parse_import_section(&mut section, s)?;
                }
                if let Some(imports) = &imports {
                    imports.append(&mut section);
                }
                write_encoded_section(output, &section, limits.max_metadata_section_bytes)?;
                imports_written = true;
            }
            Payload::FunctionSection(s) => {
                ensure!(
                    s.range().len() <= limits.max_metadata_section_bytes,
                    "metadata section exceeds streaming input budget"
                );
                let mut section = wasm_encoder::FunctionSection::new();
                transform.parse_function_section(&mut section, s)?;
                if let Some(declarations) = &declarations {
                    declarations.append_functions(&mut section);
                }
                write_encoded_section(output, &section, limits.max_metadata_section_bytes)?;
                functions_written = true;
            }
            Payload::TableSection(s) => {
                section!(
                    s,
                    wasm_encoder::TableSection,
                    parse_table_section,
                    0,
                    append_tables
                )
            }
            Payload::MemorySection(s) => {
                section!(
                    s,
                    wasm_encoder::MemorySection,
                    parse_memory_section,
                    1,
                    append_memories
                )
            }
            Payload::TagSection(s) => section!(
                s,
                wasm_encoder::TagSection,
                parse_tag_section,
                2,
                append_tags
            ),
            Payload::GlobalSection(s) => {
                section!(
                    s,
                    wasm_encoder::GlobalSection,
                    parse_global_section,
                    3,
                    append_globals
                )
            }
            Payload::ExportSection(s) => {
                section!(
                    s,
                    wasm_encoder::ExportSection,
                    parse_export_section,
                    4,
                    append_exports
                )
            }
            Payload::ElementSection(s) => {
                if defer_initializers {
                    ensure!(
                        s.range().len() <= limits.max_metadata_section_bytes,
                        "element section exceeds streaming input budget"
                    );
                    let mut section = wasm_encoder::ElementSection::new();
                    for element in s {
                        let mut element = element?;
                        if matches!(element.kind, wasmparser::ElementKind::Active { .. }) {
                            element.kind = wasmparser::ElementKind::Passive;
                        }
                        transform.parse_element(&mut section, element)?;
                    }
                    if let Some(declarations) = &module_declarations {
                        declarations.append_elements(&mut section);
                    }
                    write_encoded_section(output, &section, limits.max_metadata_section_bytes)?;
                    module_written[5] = true;
                } else {
                    section!(
                        s,
                        wasm_encoder::ElementSection,
                        parse_element_section,
                        5,
                        append_elements
                    )
                }
            }
            Payload::StartSection { func, .. } => {
                if !defer_initializers {
                    let encoded = wasm_encoder::StartSection {
                        function_index: transform.start_section(func)?,
                    };
                    write_encoded_section(output, &encoded, limits.max_metadata_section_bytes)?;
                }
            }
            Payload::DataCountSection { count, .. } => {
                let encoded = wasm_encoder::DataCountSection {
                    count: transform.data_count(count)?,
                };
                write_encoded_section(output, &encoded, limits.max_metadata_section_bytes)?;
                data_count_written = true;
            }
            Payload::DataSection(s) => {
                // WHY: a data section can be most of the module. Reencoding
                // it through DataSection would copy the entire payload even
                // though only its memory/offset expressions need rewriting.
                let mut spool = Spool::new(limits.max_spooled_section_bytes)
                    .context("spooling data section")?;
                write_u32(&mut spool, s.count())?;
                for data in s {
                    let data = data?;
                    match data.kind {
                        wasmparser::DataKind::Passive => write_u32(&mut spool, 1)?,
                        wasmparser::DataKind::Active { .. } if defer_initializers => {
                            write_u32(&mut spool, 1)?
                        }
                        wasmparser::DataKind::Active {
                            memory_index,
                            offset_expr,
                        } => {
                            let memory = transform.memory_index(memory_index)?;
                            if memory == 0 {
                                write_u32(&mut spool, 0)?;
                            } else {
                                write_u32(&mut spool, 2)?;
                                write_u32(&mut spool, memory)?;
                            }
                            ensure!(
                                offset_expr.get_binary_reader().bytes_remaining()
                                    <= limits.max_metadata_section_bytes,
                                "data offset exceeds streaming budget"
                            );
                            let mut expr = Vec::new();
                            transform.const_expr(offset_expr)?.encode(&mut expr);
                            spool.write_all(&expr)?;
                        }
                    }
                    write_u32(&mut spool, u32::try_from(data.data.len())?)?;
                    spool.write_all(data.data)?;
                }
                write_spool(output, 11, &mut spool)?;
            }
            Payload::CodeSectionStart { count, .. } => {
                code_written = true;
                remaining = count;
                let mut spool = Spool::new(limits.max_spooled_section_bytes)
                    .context("spooling code section")?;
                write_u32(
                    &mut spool,
                    count
                        .checked_add(helper_count)
                        .context("function count overflow")?,
                )?;
                if count == 0 {
                    write_helpers(transform, helper_count, &mut spool, &mut report, limits)?;
                    report.spooled_code_bytes = spool.stream_position()?;
                    write_spool(output, 10, &mut spool)?;
                } else {
                    code = Some(spool);
                }
            }
            Payload::CodeSectionEntry(body) => {
                ensure!(
                    body.range().len() <= limits.max_function_bytes,
                    "original function exceeds streaming input budget"
                );
                let index = scan.imported_functions + report.functions;
                let function = if let Some(bodies) = &mut bodies {
                    let ir = bodies.load(index)?;
                    ensure!(
                        ir.function == index && ir.source.range() == body.range(),
                        "function IR does not match original source body"
                    );
                    transform.transform_ir(&ir, limits.max_function_bytes)?
                } else {
                    transform.transform_body(index, body, limits.max_function_bytes)?
                };
                ensure!(
                    function.byte_len() <= limits.max_function_bytes,
                    "encoded function exceeds streaming output budget"
                );
                report.largest_encoded_function =
                    report.largest_encoded_function.max(function.byte_len());
                let bytes = function.into_raw_body();
                let spool = code.as_mut().context("function without code section")?;
                write_u32(spool, u32::try_from(bytes.len())?)?;
                spool.write_all(&bytes)?;
                report.functions += 1;
                remaining = remaining.checked_sub(1).context("excess function body")?;
                if remaining == 0 {
                    let mut spool = code.take().unwrap();
                    write_helpers(transform, helper_count, &mut spool, &mut report, limits)?;
                    report.spooled_code_bytes = spool.stream_position()?;
                    write_spool(output, 10, &mut spool)?;
                }
            }
            Payload::CustomSection(s) => {
                if s.name() == crate::facts::SECTION
                    || s.name() == crate::facts::CODE_HASH_SECTION
                    || s.name().starts_with(".debug")
                {
                    continue;
                }
                ensure!(
                    s.name() != "linking" && !s.name().starts_with("reloc."),
                    "streaming emitter does not preserve linker relocations"
                );
                if s.name() == "name" {
                    ensure!(
                        s.range().len() <= limits.max_metadata_section_bytes,
                        "name section exceeds streaming metadata budget"
                    );
                    let mut module = wasm_encoder::Module::new();
                    transform.parse_custom_section(&mut module, s)?;
                    let bytes = module.finish();
                    ensure!(
                        bytes.len() - 8 <= limits.max_metadata_section_bytes,
                        "encoded names exceed streaming metadata budget"
                    );
                    output.write_all(&bytes[8..])?;
                } else {
                    // No extra copy, and preserve a leading dylink.0 in place.
                    output.write_all(&[0])?;
                    write_u32(output, u32::try_from(s.range().len())?)?;
                    output.write_all(&scan.input()[s.range()])?;
                }
            }
            _ => bail!("unsupported payload in streaming core-module emitter"),
        }
    }
    ensure!(remaining == 0 && code.is_none(), "missing function bodies");
    ensure!(
        report.functions as usize == scan.functions.len() - scan.imported_functions as usize,
        "emitted source function count does not match original scan"
    );
    Ok(report)
}

fn write_helpers<T: FunctionTransform>(
    transform: &mut T,
    count: u32,
    spool: &mut Spool,
    report: &mut EmitReport,
    limits: EmitLimits,
) -> Result<()> {
    for helper in 0..count {
        let function = transform.emit_helper(helper, limits.max_function_bytes)?;
        ensure!(
            function.byte_len() <= limits.max_function_bytes,
            "helper function exceeds streaming output budget"
        );
        report.largest_encoded_function = report.largest_encoded_function.max(function.byte_len());
        let bytes = function.into_raw_body();
        write_u32(spool, u32::try_from(bytes.len())?)?;
        spool.write_all(&bytes)?;
        report.helper_functions += 1;
    }
    Ok(())
}

fn write_encoded_section(
    output: &mut impl Write,
    section: &impl Section,
    limit: usize,
) -> Result<()> {
    let mut bytes = Vec::new();
    section.encode(&mut bytes);
    ensure!(
        bytes.len() <= limit,
        "encoded metadata section exceeds streaming output budget"
    );
    output.write_all(&[section.id()])?;
    output.write_all(&bytes)?;
    Ok(())
}

fn write_spool(output: &mut impl Write, id: u8, spool: &mut Spool) -> Result<()> {
    let len = spool.stream_position()?;
    let len = u32::try_from(len).context("Wasm section exceeds u32 length")?;
    output.write_all(&[id])?;
    write_u32(output, len)?;
    spool.seek(SeekFrom::Start(0))?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = spool.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count])?;
    }
    Ok(())
}

fn write_u32(output: &mut impl Write, value: u32) -> Result<()> {
    let mut bytes = Vec::with_capacity(5);
    value.encode(&mut bytes);
    output.write_all(&bytes)?;
    Ok(())
}
