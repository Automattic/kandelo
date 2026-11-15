//! Conservative VM-04 proof: whole call-free straight-line functions only.
//! Physical locals are materialized on every entry; no replay/call edge can
//! enter a selected function's body after the guard. Guest pointers stay virtual.
use super::{O, access};
use anyhow::Result;
use std::collections::BTreeSet;
use wasmparser::{FuncType, FunctionBody, ValType};

pub const MAX_SPAN: u32 = 65536;

pub struct ObjectSpan {
    pub base: u32,
    pub length: u32,
    pub rights: u32,
    pub sites: u32,
}

pub enum Decision {
    Selected(ObjectSpan),
    Rejected(&'static str),
}

pub fn analyze(body: &FunctionBody<'_>, ty: &FuncType) -> Result<Decision> {
    macro_rules! reject {
        ($reason:expr) => {
            return Ok(Decision::Rejected($reason))
        };
    }
    if body.range().len() > 16384 {
        reject!("body-byte-budget");
    }
    if ty.params().iter().any(|t| *t != ValType::I32)
        || ty.results().len() > 1
        || ty.results().iter().any(|t| *t != ValType::I32)
    {
        reject!("signature");
    }
    if body
        .get_locals_reader()?
        .into_iter()
        .any(|entry| entry.map(|(_, ty)| ty != ValType::I32).unwrap_or(true))
    {
        reject!("local-types");
    }
    // A tag means the exact value of an original local read. Arithmetic and
    // memory-derived values lose provenance. Source Wasm is validated first.
    let mut stack: Vec<Option<u32>> = Vec::new();
    let mut writes = BTreeSet::new();
    let mut base = None;
    let (mut length, mut rights, mut sites, mut operators) = (0, 0, 0, 0);
    let mut reader = body.get_operators_reader()?;
    while !reader.eof() {
        let op = reader.read()?;
        operators += 1;
        if operators > 256 {
            reject!("operator-budget");
        }
        if let Some(a) = access(&op) {
            let a = a?;
            if !matches!(
                a.name,
                "I32Load"
                    | "I32Load8U"
                    | "I32Load8S"
                    | "I32Load16U"
                    | "I32Load16S"
                    | "I32Store"
                    | "I32Store8"
                    | "I32Store16"
            ) {
                reject!("memory-form");
            }
            if a.write && stack.pop().is_none() {
                reject!("value-stack");
            }
            let Some(Some(address)) = stack.pop() else {
                reject!("unproved-address");
            };
            if base.is_some_and(|old| old != address) {
                reject!("multiple-bases");
            }
            base = Some(address);
            let end = a.memarg.offset + (1u64 << a.memarg.max_align);
            if end > u64::from(MAX_SPAN) {
                reject!("span-budget");
            }
            length = length.max(end as u32);
            rights |= a.rights;
            sites += 1;
            if !a.write {
                stack.push(None);
            }
            continue;
        }
        match op {
            O::LocalGet { local_index } => stack.push(Some(local_index)),
            O::LocalSet { local_index } | O::LocalTee { local_index } => {
                let Some(value) = stack.pop() else {
                    reject!("local-stack")
                };
                writes.insert(local_index);
                if matches!(op, O::LocalTee { .. }) {
                    stack.push(value);
                }
            }
            O::I32Const { .. } | O::GlobalGet { .. } => stack.push(None),
            O::Drop => {
                if stack.pop().is_none() {
                    reject!("drop-stack")
                }
            }
            O::I32Eqz | O::I32Clz | O::I32Ctz | O::I32Popcnt | O::I32Extend8S | O::I32Extend16S => {
                if stack.pop().is_none() {
                    reject!("unary-stack")
                }
                stack.push(None);
            }
            O::I32Add
            | O::I32Sub
            | O::I32Mul
            | O::I32DivS
            | O::I32DivU
            | O::I32RemS
            | O::I32RemU
            | O::I32And
            | O::I32Or
            | O::I32Xor
            | O::I32Shl
            | O::I32ShrS
            | O::I32ShrU
            | O::I32Rotl
            | O::I32Rotr
            | O::I32Eq
            | O::I32Ne
            | O::I32LtS
            | O::I32LtU
            | O::I32GtS
            | O::I32GtU
            | O::I32LeS
            | O::I32LeU
            | O::I32GeS
            | O::I32GeU => {
                if stack.pop().is_none() || stack.pop().is_none() {
                    reject!("binary-stack")
                }
                stack.push(None);
            }
            O::Nop => {}
            O::End if reader.eof() => {}
            // Calls, branches, returns, exceptions, tables, growth and all
            // unknown effects reject the whole function, including dispatchers.
            _ => reject!("control-call-or-unknown-effect"),
        }
    }
    let Some(base) = base else {
        reject!("no-memory")
    };
    if sites < 2 {
        reject!("too-few-accesses");
    }
    if writes.contains(&base) {
        reject!("base-local-written");
    }
    if stack.len() != ty.results().len() {
        reject!("result-stack");
    }
    Ok(Decision::Selected(ObjectSpan {
        base,
        length,
        rights,
        sites,
    }))
}
