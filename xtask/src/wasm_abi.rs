//! Utilities for extracting ABI info from wasm modules.
//!
//! Factored out so `build-manifest` and `bundle-program` can share
//! the same parser and stay in sync.

use wasmparser::{ExternalKind, FunctionBody, Operator, Parser, Payload, TypeRef};

/// Return the value returned by the `__abi_version` export if the
/// module exports it and the function body is a single `i32.const N`
/// or `i64.const N` instruction (which is how `channel_syscall.c`
/// compiles it). Otherwise None.
pub fn extract_abi_version(bytes: &[u8]) -> Option<i64> {
    let mut imported_funcs: u32 = 0;
    let mut export_func_idx: Option<u32> = None;
    let mut code_bodies: Vec<FunctionBody> = Vec::new();

    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload.ok()?;
        match payload {
            Payload::ImportSection(r) => {
                for group in r {
                    let group = group.ok()?;
                    let tick = |ty: TypeRef, imp: &mut u32| match ty {
                        TypeRef::Func(_) | TypeRef::FuncExact(_) => *imp += 1,
                        _ => {}
                    };
                    match group {
                        wasmparser::Imports::Single(_, i) => tick(i.ty, &mut imported_funcs),
                        wasmparser::Imports::Compact1 { items, .. } => {
                            for item in items {
                                let item = item.ok()?;
                                tick(item.ty, &mut imported_funcs);
                            }
                        }
                        wasmparser::Imports::Compact2 { ty, names, .. } => {
                            for n in names {
                                let _ = n.ok()?;
                                tick(ty, &mut imported_funcs);
                            }
                        }
                    }
                }
            }
            Payload::ExportSection(r) => {
                for exp in r {
                    let exp = exp.ok()?;
                    if exp.name == "__abi_version"
                        && matches!(exp.kind, ExternalKind::Func | ExternalKind::FuncExact)
                    {
                        export_func_idx = Some(exp.index);
                    }
                }
            }
            Payload::CodeSectionEntry(body) => {
                code_bodies.push(body);
            }
            _ => {}
        }
    }

    let exp_idx = export_func_idx?;
    if exp_idx < imported_funcs {
        return None;
    }
    let local_idx = (exp_idx - imported_funcs) as usize;
    let body = code_bodies.get(local_idx)?;

    let mut reader = body.get_operators_reader().ok()?;
    let first = reader.read().ok()?;
    match first {
        Operator::I32Const { value } => Some(value as i64),
        Operator::I64Const { value } => Some(value),
        _ => None,
    }
}
