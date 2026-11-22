//! Recognize wasm-ld's pure PIC-address initializer without relying on names.
//! Only the first start call is eligible. Its complete body must assign local
//! scalar globals from immutable imported memory/table bases plus constants.
//! Never replay arbitrary start code, memory writes, calls or constructors.
use super::{Scan, charge, step};
use anyhow::Result;
use std::collections::BTreeSet;
use wasmparser::{BinaryReader, FunctionBody, Operator, Parser, Payload, TypeRef, ValType};

fn body<'a>(scan: &Scan<'a>, function: u32) -> Option<FunctionBody<'a>> {
    let summary = scan.functions.get(function as usize)?.body.as_ref()?;
    Some(FunctionBody::new(BinaryReader::new_features(
        &scan.input()[summary.range.clone()],
        summary.range.start,
        super::super::features(),
    )))
}

pub(super) fn discover(
    scan: &Scan<'_>,
    metadata: &mut usize,
    work: &mut usize,
) -> Result<Option<u32>> {
    let Some(start) = scan.start.and_then(|index| body(scan, index)) else {
        return Ok(None);
    };
    let mut start_ops = start.get_operators_reader()?;
    step(work)?;
    let Operator::Call { function_index } = start_ops.read()? else {
        return Ok(None);
    };
    let Some(initializer) = body(scan, function_index) else {
        return Ok(None);
    };
    let types = scan.types.as_ref();
    let ty = types
        .get(types.core_type_at_in_module(scan.functions[function_index as usize].ty))
        .unwrap()
        .composite_type
        .unwrap_func();
    if !ty.params().is_empty()
        || !ty.results().is_empty()
        || initializer.get_locals_reader()?.get_count() != 0
    {
        return Ok(None);
    }
    let mut imported_globals = 0;
    let mut bases = BTreeSet::new();
    for payload in Parser::new(0).parse_all(scan.input()) {
        if let Payload::ImportSection(section) = payload? {
            for import in section.into_imports() {
                step(work)?;
                let import = import?;
                if let TypeRef::Global(ty) = import.ty {
                    if import.module == "env"
                        && matches!(import.name, "__memory_base" | "__table_base")
                        && !ty.mutable
                        && !ty.shared
                        && matches!(ty.content_type, ValType::I32 | ValType::I64)
                    {
                        charge(metadata, 32)?;
                        bases.insert(imported_globals);
                    }
                    imported_globals += 1;
                }
            }
        }
    }
    let mut ops = initializer.get_operators_reader()?;
    let mut assignments = 0;
    while !ops.eof() {
        step(work)?;
        let base = match ops.read()? {
            Operator::End => return Ok((assignments > 0 && ops.eof()).then_some(function_index)),
            Operator::GlobalGet { global_index } if bases.contains(&global_index) => global_index,
            _ => return Ok(None),
        };
        step(work)?;
        let mut next = ops.read()?;
        match (types.global_at(base).content_type, &next) {
            (ValType::I32, Operator::I32Const { .. }) => {
                step(work)?;
                if !matches!(ops.read()?, Operator::I32Add) {
                    return Ok(None);
                }
                step(work)?;
                next = ops.read()?;
            }
            (ValType::I64, Operator::I64Const { .. }) => {
                step(work)?;
                if !matches!(ops.read()?, Operator::I64Add) {
                    return Ok(None);
                }
                step(work)?;
                next = ops.read()?;
            }
            _ => {}
        }
        let Operator::GlobalSet { global_index } = next else {
            return Ok(None);
        };
        let target = types.global_at(global_index);
        if global_index < imported_globals
            || !target.mutable
            || target.shared
            || target.content_type != types.global_at(base).content_type
        {
            return Ok(None);
        }
        assignments += 1;
    }
    Ok(None)
}
