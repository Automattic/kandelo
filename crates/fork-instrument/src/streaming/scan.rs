use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use anyhow::{Context, Result, bail, ensure};
use wasmparser::{Encoding, ExternalKind, Operator, Parser, Payload, TypeRef, ValidPayload};

/// A source location survives section growth, helper insertion and re-encoding.
/// Offsets are absolute byte offsets in the exact original input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ProgramPoint {
    pub function: u32,
    pub offset: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ValueProof {
    Unknown,
    I32(i32),
    Function(u32),
    Null,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Dispatch {
    Table {
        table: u32,
        ty: u32,
        index: ValueProof,
    },
    Ref {
        ty: u32,
        target: ValueProof,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum CallTarget {
    Direct(u32),
    Dispatch(Dispatch),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TailSite {
    pub point: ProgramPoint,
    pub target: CallTarget,
}

/// Only module-wide analysis inputs survive the body scan. Repeated ordinary
/// call edges and table operations are deduplicated within each function.
#[derive(Debug, Default)]
pub struct BodySummary {
    pub range: Range<usize>,
    pub operators: u64,
    pub local_count: u64,
    pub calls: BTreeSet<CallTarget>,
    pub tails: Vec<TailSite>,
    pub table_inits: BTreeSet<(u32, u32)>,
    /// (source, destination), matching the direction of target propagation.
    pub table_copies: BTreeSet<(u32, u32)>,
    pub table_reads: BTreeSet<u32>,
    pub table_writes: BTreeSet<u32>,
    pub dynamic_table_writes: BTreeSet<u32>,
    pub global_writes: BTreeSet<u32>,
    pub data_drops: BTreeSet<u32>,
    pub element_drops: BTreeSet<u32>,
    pub has_legacy_eh: bool,
    pub has_modern_eh: bool,
}

#[derive(Debug)]
pub struct FunctionSummary {
    pub ty: u32,
    pub import: Option<(String, String)>,
    pub name: Option<String>,
    pub body: Option<BodySummary>,
}

#[derive(Debug)]
pub struct ElementSummary {
    /// None for passive/declared segments.
    pub active: Option<(u32, Option<i32>)>,
    pub declared: bool,
    pub items: Vec<ValueProof>,
}

/// The original binary is borrowed, never copied into a module IR. Facts stay
/// encoded; callers may visit one decoded object chunk at a time.
pub struct Scan<'a> {
    input: &'a [u8],
    pub(super) body_resources: Option<wasmparser::ValidatorResources>,
    pub functions: Vec<FunctionSummary>,
    pub imported_functions: u32,
    pub elements: Vec<ElementSummary>,
    pub table_initializers: Vec<ValueProof>,
    pub exports: Vec<(String, ExternalKind, u32)>,
    pub start: Option<u32>,
    pub custom_sections: Vec<(&'a str, Range<usize>)>,
    pub code_range: Option<Range<usize>>,
    pub operators: u64,
    pub types: wasmparser::types::Types,
}

/// Match the oracle's proposal policy, including legacy exception handling.
pub fn features() -> wasmparser::WasmFeatures {
    wasmparser::WasmFeatures::default()
        | wasmparser::WasmFeatures::LEGACY_EXCEPTIONS
        | wasmparser::WasmFeatures::WIDE_ARITHMETIC
}

/// Validate and summarize the exact linker bytes, one body at a time. Validator
/// allocations are recycled; no vector of pending function validators is kept.
pub fn scan(input: &[u8]) -> Result<Scan<'_>> {
    let mut parser = Parser::new(0);
    parser.set_features(features());
    let mut validator = wasmparser::Validator::new_with_features(features());
    let mut allocations = Default::default();
    let mut functions: Vec<FunctionSummary> = Vec::new();
    let mut imported_functions = 0;
    let mut elements = Vec::new();
    let mut table_initializers = Vec::new();
    let mut exports = Vec::new();
    let mut names = BTreeMap::new();
    let mut custom_sections = Vec::new();
    let mut start = None;
    let mut code_range = None;
    let mut operators = 0;
    let mut defined = 0;
    let mut final_types = None;
    let mut body_resources = None;
    for payload in parser.parse_all(input) {
        let payload = payload.context("streaming module scan")?;
        if let Payload::Version { encoding, .. } = &payload {
            ensure!(*encoding == Encoding::Module, "expected a core Wasm module");
        }
        match validator
            .payload(&payload)
            .context("validating original module")?
        {
            ValidPayload::Func(to_validate, body) => {
                if body_resources.is_none() {
                    body_resources = Some(to_validate.resources.clone());
                }
                let mut function_validator = to_validate.into_validator(allocations);
                let index = imported_functions + defined;
                let summary = scan_body(index, &body, &mut function_validator)
                    .with_context(|| format!("summarizing original function {index}"))?;
                allocations = function_validator.into_allocations();
                operators += summary.operators;
                functions[index as usize].body = Some(summary);
                defined += 1;
            }
            ValidPayload::End(types) => final_types = Some(types),
            ValidPayload::Parser(_) => bail!("nested modules are not supported"),
            ValidPayload::Ok => {}
        }
        match payload {
            Payload::ImportSection(section) => {
                for import in section.into_imports() {
                    let import = import?;
                    match import.ty {
                        TypeRef::Func(ty) | TypeRef::FuncExact(ty) => {
                            functions.push(FunctionSummary {
                                ty,
                                import: Some((import.module.into(), import.name.into())),
                                name: None,
                                body: None,
                            });
                            imported_functions += 1;
                        }
                        TypeRef::Table(_) => table_initializers.push(ValueProof::Unknown),
                        _ => {}
                    }
                }
            }
            Payload::FunctionSection(section) => {
                for ty in section {
                    functions.push(FunctionSummary {
                        ty: ty?,
                        import: None,
                        name: None,
                        body: None,
                    });
                }
            }
            Payload::TableSection(section) => {
                for table in section {
                    let table = table?;
                    table_initializers.push(match table.init {
                        wasmparser::TableInit::RefNull => ValueProof::Null,
                        wasmparser::TableInit::Expr(expr) => const_proof(expr)?,
                    });
                }
            }
            Payload::ElementSection(section) => {
                for element in section {
                    let element = element?;
                    let (active, declared) = match element.kind {
                        wasmparser::ElementKind::Active {
                            table_index,
                            offset_expr,
                        } => {
                            let offset = match const_proof(offset_expr)? {
                                ValueProof::I32(n) => Some(n),
                                _ => None,
                            };
                            (Some((table_index.unwrap_or(0), offset)), false)
                        }
                        wasmparser::ElementKind::Passive => (None, false),
                        wasmparser::ElementKind::Declared => (None, true),
                    };
                    let items = match element.items {
                        wasmparser::ElementItems::Functions(items) => items
                            .into_iter()
                            .map(|i| Ok(ValueProof::Function(i?)))
                            .collect::<Result<_>>()?,
                        wasmparser::ElementItems::Expressions(_, items) => items
                            .into_iter()
                            .map(|i| const_proof(i?))
                            .collect::<Result<_>>()?,
                    };
                    elements.push(ElementSummary {
                        active,
                        declared,
                        items,
                    });
                }
            }
            Payload::ExportSection(section) => {
                for export in section {
                    let e = export?;
                    exports.push((e.name.into(), e.kind, e.index));
                }
            }
            Payload::StartSection { func, .. } => start = Some(func),
            Payload::CodeSectionStart { range, .. } => code_range = Some(range),
            Payload::CustomSection(section) => {
                custom_sections.push((section.name(), section.data_offset()..section.range().end));
                if section.name() == "name" {
                    let reader = wasmparser::NameSectionReader::new(wasmparser::BinaryReader::new(
                        section.data(),
                        section.data_offset(),
                    ));
                    // Names are diagnostic. Like Walrus, ignore malformed name
                    // subsections rather than accepting invalid executable code.
                    for name in reader {
                        let Ok(wasmparser::Name::Function(map)) = name else {
                            continue;
                        };
                        for entry in map.into_iter().flatten() {
                            names.insert(entry.index, entry.name.to_owned());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    for (index, name) in names {
        if let Some(function) = functions.get_mut(index as usize) {
            function.name = Some(name);
        }
    }
    Ok(Scan {
        input,
        body_resources,
        functions,
        imported_functions,
        elements,
        table_initializers,
        exports,
        start,
        custom_sections,
        code_range,
        operators,
        types: final_types.context("missing module end")?,
    })
}

impl<'a> Scan<'a> {
    pub fn input(&self) -> &'a [u8] {
        self.input
    }

    pub fn custom_data<'s>(&'s self, name: &'s str) -> impl Iterator<Item = &'a [u8]> + 's {
        self.custom_sections
            .iter()
            .filter(move |(n, _)| *n == name)
            .map(|(_, range)| &self.input[range.clone()])
    }

    /// Hash the exact section bytes the linker facts describe, without
    /// concatenating or decoding the facts sections.
    pub fn verify_facts_hash(&self) -> Result<()> {
        use sha2::{Digest, Sha256};
        let recorded = self
            .custom_data(crate::facts::CODE_HASH_SECTION)
            .last()
            .context("facts have no original-code hash")?;
        let code = self
            .code_range
            .as_ref()
            .map_or(&[][..], |r| &self.input[r.clone()]);
        ensure!(
            recorded == Sha256::digest(code).as_slice(),
            "facts code hash mismatch"
        );
        Ok(())
    }

    /// Bind only names and parameter shapes from compiler facts. Verify the
    /// exact original code hash before decoding any optimization input. This
    /// does not certify site/type agreement or replace facts-derived targets.
    pub fn bind_fact_definitions(&self) -> Result<Vec<(u32, Vec<(usize, usize)>)>> {
        self.verify_facts_hash()?;
        let mut sections = self.custom_data(crate::facts::SECTION).peekable();
        ensure!(sections.peek().is_some(), "module has no compiler facts");
        let definitions = crate::facts::definitions::DefinitionIndex::read(sections)?;
        let types = self.types.as_ref();
        let items: Vec<_> = self
            .functions
            .iter()
            .filter(|f| f.import.is_none())
            .map(|f| {
                let ty = types
                    .get(types.core_type_at_in_module(f.ty))
                    .unwrap()
                    .composite_type
                    .unwrap_func();
                let params = ty.params();
                crate::facts::bind::Item {
                    name: f.name.as_deref().unwrap_or_default(),
                    nparams: params.len(),
                    i64_params: params
                        .iter()
                        .filter(|t| **t == wasmparser::ValType::I64)
                        .count(),
                    first_is_i32: params.first() == Some(&wasmparser::ValType::I32),
                    last_is_i32: params.last() == Some(&wasmparser::ValType::I32),
                }
            })
            .collect();
        Ok(definitions
            .bind(&items)
            .into_iter()
            .enumerate()
            .map(|(i, bound)| (self.imported_functions + i as u32, bound))
            .collect())
    }
}

fn scan_body(
    function: u32,
    body: &wasmparser::FunctionBody<'_>,
    validator: &mut wasmparser::FuncValidator<wasmparser::ValidatorResources>,
) -> Result<BodySummary> {
    let mut out = BodySummary {
        range: body.range(),
        ..Default::default()
    };
    for local in body.get_locals_reader()? {
        out.local_count += u64::from(local?.0);
    }
    validator.read_locals(&mut body.get_binary_reader())?;
    let mut prefix = Vec::new();
    // WHY: validation makes a nested block inside an unreachable suffix
    // locally reachable for stack typing. Its IR is nevertheless detached
    // from the source function. Keep that distinction without retaining IR.
    let mut attached = vec![true];
    let mut reader = body.get_operators_reader()?;
    while !reader.eof() {
        let offset = reader.original_position();
        let op = reader.read()?;
        let reachable = attached.last() == Some(&true)
            && validator
                .get_control_frame(0)
                .is_some_and(|frame| !frame.unreachable);
        validator.op(offset, &op)?;
        let proof = prefix.last().copied().unwrap_or(ValueProof::Unknown);
        let call = match op {
            Operator::Call { function_index } | Operator::ReturnCall { function_index } => {
                Some(CallTarget::Direct(function_index))
            }
            Operator::CallIndirect {
                type_index,
                table_index,
            }
            | Operator::ReturnCallIndirect {
                type_index,
                table_index,
            } => Some(CallTarget::Dispatch(Dispatch::Table {
                table: table_index,
                ty: type_index,
                index: if matches!(proof, ValueProof::I32(_)) {
                    proof
                } else {
                    ValueProof::Unknown
                },
            })),
            Operator::CallRef { type_index } | Operator::ReturnCallRef { type_index } => {
                Some(CallTarget::Dispatch(Dispatch::Ref {
                    ty: type_index,
                    target: proof,
                }))
            }
            _ => None,
        };
        if let Some(target) = call.filter(|_| reachable) {
            if matches!(
                op,
                Operator::ReturnCall { .. }
                    | Operator::ReturnCallIndirect { .. }
                    | Operator::ReturnCallRef { .. }
            ) {
                out.tails.push(TailSite {
                    point: ProgramPoint { function, offset },
                    target,
                });
            } else {
                out.calls.insert(target);
            }
        }
        if reachable {
            match op {
                Operator::TableInit { elem_index, table } => {
                    out.table_inits.insert((elem_index, table));
                    out.table_writes.insert(table);
                }
                Operator::TableCopy {
                    src_table,
                    dst_table,
                } => {
                    out.table_copies.insert((src_table, dst_table));
                    out.table_writes.insert(dst_table);
                }
                Operator::TableSet { table }
                | Operator::TableGrow { table }
                | Operator::TableFill { table } => {
                    out.table_writes.insert(table);
                    out.dynamic_table_writes.insert(table);
                }
                Operator::TableGet { table } | Operator::TableSize { table } => {
                    out.table_reads.insert(table);
                }
                Operator::GlobalSet { global_index } => {
                    out.global_writes.insert(global_index);
                }
                Operator::DataDrop { data_index } => {
                    out.data_drops.insert(data_index);
                }
                Operator::ElemDrop { elem_index } => {
                    out.element_drops.insert(elem_index);
                }
                Operator::Try { .. }
                | Operator::Catch { .. }
                | Operator::CatchAll
                | Operator::Delegate { .. }
                | Operator::Rethrow { .. } => out.has_legacy_eh = true,
                Operator::TryTable { .. } | Operator::Throw { .. } | Operator::ThrowRef => {
                    out.has_modern_eh = true
                }
                _ => {}
            }
        }
        match op {
            Operator::Block { .. }
            | Operator::Loop { .. }
            | Operator::If { .. }
            | Operator::Try { .. }
            | Operator::TryTable { .. } => attached.push(reachable),
            Operator::End | Operator::Delegate { .. } => {
                attached.pop();
            }
            _ => {}
        }
        update_prefix(&mut prefix, &op, false);
        out.operators += 1;
    }
    ensure!(
        validator.control_stack_height() == 0,
        "function is missing its final end"
    );
    Ok(out)
}

fn const_proof(expr: wasmparser::ConstExpr<'_>) -> Result<ValueProof> {
    let mut prefix = Vec::new();
    for op in expr.get_operators_reader() {
        let op = op?;
        if !matches!(op, Operator::End) {
            update_prefix(&mut prefix, &op, true);
        }
    }
    Ok(if prefix.len() == 1 {
        prefix[0]
    } else {
        ValueProof::Unknown
    })
}

fn update_prefix(prefix: &mut Vec<ValueProof>, op: &Operator<'_>, const_expr: bool) {
    use ValueProof::*;
    match op {
        // Walrus omits nop from its instruction sequences. Preserve lexical
        // provenance across it so the oracle and summary planner agree.
        Operator::Nop => {}
        Operator::I32Const { value } => prefix.push(I32(*value)),
        Operator::RefFunc { function_index } => prefix.push(Function(*function_index)),
        Operator::RefNull { .. } => prefix.push(Null),
        Operator::RefAsNonNull
        | Operator::RefCastNonNull { .. }
        | Operator::RefCastNullable { .. } => {}
        Operator::I32Add | Operator::I32Sub | Operator::I32Mul
            if const_expr || !matches!(op, Operator::I32Mul) =>
        {
            let rhs = prefix.pop();
            let lhs = prefix.pop();
            prefix.push(match (lhs, rhs) {
                (Some(I32(a)), Some(I32(b))) => I32(match op {
                    Operator::I32Add => a.wrapping_add(b),
                    Operator::I32Sub => a.wrapping_sub(b),
                    _ => a.wrapping_mul(b),
                }),
                _ => Unknown,
            });
        }
        _ => {
            prefix.clear();
            prefix.push(Unknown);
        }
    }
}
