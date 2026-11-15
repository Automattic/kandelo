//! Read-only breadth-first prescreen. Syntactic opportunities are not safety
//! proofs, dynamic access coverage, or permission to elide translation.
use anyhow::{Result, ensure};
use std::{collections::BTreeMap, fs};
use wasmparser::{self as p, Operator as O, Parser, Payload};
macro_rules! capture {
    ($name:expr,memarg=>$m:expr $(,$rest:ident=>$value:expr)*) => {
        Some(($name, $m.offset, 1u64 << $m.max_align))
    };
    ($name:expr $(,$rest:ident=>$value:expr)*) => {
        None
    };
}
macro_rules! memory_ops {
 ($(@$proposal:ident $op:ident $({$($arg:ident:$ty:ty),*})? => $visit:ident ($($ann:tt)*))*)=>{
  fn memory(op:&O<'_>)->Option<(&'static str,u64,u64)>{match op{$(O::$op $({$($arg),*})?=>{$($(let _=$arg;)*)?capture!(stringify!($op)$(,$($arg=>$arg),*)?)},)*_=>None}}
 }
}
p::for_each_operator!(memory_ops);
fn main() -> Result<()> {
    let a: Vec<_> = std::env::args().collect();
    ensure!(
        a.len() == 3,
        "usage: common-memory-feasibility INPUT REPORT"
    );
    ensure!(!std::path::Path::new(&a[2]).exists(), "choose fresh report");
    let b = fs::read(&a[1])?;
    p::Validator::new_with_features(p::WasmFeatures::all()).validate_all(&b)?;
    let (mut function_imports, mut global_imports) = (vec![], vec![]);
    let (mut stack, mut exports) = (None, BTreeMap::new());
    for payload in Parser::new(0).parse_all(&b) {
        match payload? {
            Payload::ImportSection(s) => {
                for i in s.into_imports() {
                    let i = i?;
                    match i.ty {
                        p::TypeRef::Func(_) => {
                            function_imports.push(format!("{}.{}", i.module, i.name))
                        }
                        p::TypeRef::Global(t) => {
                            global_imports.push((format!("{}.{}", i.module, i.name), t.mutable))
                        }
                        _ => {}
                    }
                }
            }
            Payload::ExportSection(s) => {
                for e in s {
                    let e = e?;
                    if e.name == "__stack_pointer" {
                        ensure!(e.kind == p::ExternalKind::Global, "stack export type");
                        stack = Some(e.index);
                    }
                    if e.kind == p::ExternalKind::Func {
                        exports.insert(e.index, e.name.to_owned());
                    }
                }
            }
            _ => {}
        }
    }
    let stack = stack.ok_or_else(|| anyhow::anyhow!("no canonical shadow-stack export"))?;
    let mut body = 0u32;
    let mut rows = vec![];
    let mut totals = BTreeMap::<String, u64>::new();
    for payload in Parser::new(0).parse_all(&b) {
        if let Payload::CodeSectionEntry(b) = payload? {
            let function = function_imports.len() as u32 + body;
            body += 1;
            let mut r = b.get_operators_reader()?;
            let mut ops = vec![];
            while !r.eof() {
                ops.push(r.read()?);
            }
            let mut frames = BTreeMap::<u32, i32>::new();
            for w in ops.windows(5) {
                if let [
                    O::GlobalGet { global_index: g },
                    O::I32Const { value: n },
                    O::I32Sub,
                    O::LocalTee { local_index: l },
                    O::GlobalSet { global_index: h },
                ] = w
                {
                    if *g == stack && *h == stack && *n > 0 {
                        frames
                            .entry(*l)
                            .and_modify(|v| *v = (*v).min(*n))
                            .or_insert(*n);
                    }
                }
            }
            let (
                mut accesses,
                mut frame_accesses,
                mut immutable_addresses,
                mut loops,
                mut indirect,
                mut direct,
                mut tables,
            ) = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
            let mut calls = BTreeMap::<u32, u64>::new();
            for (i, op) in ops.iter().enumerate() {
                if let Some((name, offset, width)) = memory(op) {
                    accesses += 1;
                    let write = name.contains("Store");
                    let previous = if write {
                        i.checked_sub(2)
                    } else {
                        i.checked_sub(1)
                    };
                    if let Some(O::LocalGet { local_index: l }) = previous.and_then(|j| ops.get(j))
                    {
                        if frames.get(l).is_some_and(|size| {
                            offset
                                .checked_add(width)
                                .is_some_and(|end| end <= *size as u64)
                        }) {
                            frame_accesses += 1;
                        }
                    }
                    let global = match i.checked_sub(1).and_then(|j| ops.get(j)) {
                        Some(O::GlobalGet { global_index: g }) => Some(*g),
                        Some(O::I32WrapI64) => i.checked_sub(2).and_then(|j| match ops.get(j) {
                            Some(O::GlobalGet { global_index: g }) => Some(*g),
                            _ => None,
                        }),
                        _ => None,
                    };
                    if global.is_some_and(|g| {
                        global_imports
                            .get(g as usize)
                            .is_some_and(|(_, mutable)| !mutable)
                    }) {
                        immutable_addresses += 1;
                    }
                }
                match op {
                    O::Loop { .. } => loops += 1,
                    O::Call { function_index: f } | O::ReturnCall { function_index: f } => {
                        direct += 1;
                        *calls.entry(*f).or_default() += 1;
                    }
                    O::CallIndirect { .. }
                    | O::ReturnCallIndirect { .. }
                    | O::CallRef { .. }
                    | O::ReturnCallRef { .. } => indirect += 1,
                    O::TableGet { .. }
                    | O::TableSet { .. }
                    | O::TableCopy { .. }
                    | O::TableFill { .. }
                    | O::TableGrow { .. }
                    | O::TableInit { .. } => tables += 1,
                    _ => {}
                }
            }
            for (key, value) in [
                ("memorySites", accesses),
                ("syntacticFrameSites", frame_accesses),
                ("immutableImportedAddressSites", immutable_addresses),
                ("loops", loops),
                ("directCalls", direct),
                ("indirectCalls", indirect),
                ("tableOperations", tables),
                (
                    "functionsWithFrameConstructor",
                    u64::from(!frames.is_empty()),
                ),
                (
                    "callFreeMemoryFunctions",
                    u64::from(accesses > 0 && direct == 0 && indirect == 0),
                ),
                (
                    "callFreeLoopMemoryFunctions",
                    u64::from(accesses > 0 && loops > 0 && direct == 0 && indirect == 0),
                ),
            ] {
                *totals.entry(key.into()).or_default() += value;
            }
            if accesses > 0 || !frames.is_empty() {
                rows.push(serde_json::json!({"function":function,"name":exports.get(&function),"memorySites":accesses,"syntacticFrameSites":frame_accesses,"frameLocals":frames,"immutableImportedAddressSites":immutable_addresses,"loops":loops,"directCalls":direct,"indirectCalls":indirect,"tableOperations":tables,"calls":calls}));
            }
        }
    }
    let report = serde_json::json!({"scope":"Read-only syntactic prescreen of fork-prepared PHP. Frame matches require the exact canonical stack decrement/tee/set pattern and immediate local address operands with in-frame constant offsets. They are NOT provenance/liveness proofs, dynamic coverage or optimization eligibility. Stores with nontrivial value expressions can be missed. Calls/control/replay can change locals and mappings; no translation is removed.","stackGlobal":stack,"functionImports":function_imports,"globalImports":global_imports,"definedFunctions":body,"totals":totals,"functions":rows});
    fs::write(&a[2], serde_json::to_vec_pretty(&report)?)?;
    println!("{}", serde_json::to_string_pretty(&report["totals"])?);
    Ok(())
}
