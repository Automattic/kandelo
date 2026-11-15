//! Read-only, empty-operand-stack region proof screen; no Wasm is rewritten.
use crate::effects::{CallEffects, CallPolicy};
use anyhow::{Result, ensure};
use std::collections::BTreeSet;
use wasmparser::{self as p, Operator as O, Parser};
fn memory(op: &O<'_>) -> Option<(u64, u32, bool)> {
    match op {
        O::I32Load { memarg } => Some((memarg.offset, 4, false)),
        O::I32Load8S { memarg } | O::I32Load8U { memarg } => Some((memarg.offset, 1, false)),
        O::I32Load16S { memarg } | O::I32Load16U { memarg } => Some((memarg.offset, 2, false)),
        O::I32Store { memarg } => Some((memarg.offset, 4, true)),
        O::I32Store8 { memarg } => Some((memarg.offset, 1, true)),
        O::I32Store16 { memarg } => Some((memarg.offset, 2, true)),
        _ => None,
    }
}
fn unary(op: &O<'_>) -> bool {
    matches!(
        op,
        O::I32Eqz | O::I32Clz | O::I32Ctz | O::I32Popcnt | O::I32Extend8S | O::I32Extend16S
    )
}
fn binary(op: &O<'_>) -> bool {
    matches!(
        op,
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
            | O::I32GeU
    )
}
fn prove(ops: &[O<'_>], calls: Option<&CallEffects>) -> Option<(u32, u64, u32, u32)> {
    let (mut stack, mut writes, mut base, mut length, mut sites, mut rights) =
        (vec![], BTreeSet::new(), None, 0, 0, 0);
    for op in ops {
        if let Some((offset, width, write)) = memory(op) {
            if write {
                stack.pop()?;
            }
            let address = stack.pop()??;
            if base.is_some_and(|b| b != address) {
                return None;
            }
            base = Some(address);
            length = length.max(offset.checked_add(u64::from(width))?);
            if length > 65536 {
                return None;
            }
            sites += 1;
            rights |= if write { 2 } else { 1 };
            if !write {
                stack.push(None);
            }
            continue;
        }
        match op {
            O::LocalGet { local_index: l } => stack.push(Some(*l)),
            O::LocalSet { local_index: l } | O::LocalTee { local_index: l } => {
                let value = stack.pop()?;
                writes.insert(*l);
                if matches!(op, O::LocalTee { .. }) {
                    stack.push(value);
                }
            }
            O::I32Const { .. } | O::GlobalGet { .. } => stack.push(None),
            O::Drop => {
                stack.pop()?;
            }
            O::Call { function_index } => {
                let (params, results) = calls?.call_shape(*function_index)?;
                let remaining = stack.len().checked_sub(params)?;
                stack.truncate(remaining);
                stack.extend(std::iter::repeat_n(None, results));
            }
            O::Nop => {}
            op if unary(op) => {
                stack.pop()?;
                stack.push(None);
            }
            op if binary(op) => {
                stack.pop()?;
                stack.pop()?;
                stack.push(None);
            }
            _ => return None,
        }
    }
    let base = base?;
    if sites < 2 || !stack.is_empty() || writes.contains(&base) {
        None
    } else {
        Some((base, length, sites, rights))
    }
}
struct Item<'a> {
    op: O<'a>,
    offset: usize,
    ordinal: usize,
    after: u32,
}
fn flush(
    segment: &[Item<'_>],
    function: u32,
    selected: &mut Vec<serde_json::Value>,
    calls: Option<&CallEffects>,
) {
    let mut boundaries = vec![0usize];
    for (i, x) in segment.iter().enumerate() {
        if x.after == 0 {
            boundaries.push(i + 1);
        }
    }
    let mut start = 0;
    while start + 1 < boundaries.len() {
        let mut best = None;
        for end in start + 1..boundaries.len() {
            if boundaries[end] - boundaries[start] > 256 {
                break;
            }
            let ops: Vec<_> = segment[boundaries[start]..boundaries[end]]
                .iter()
                .map(|x| x.op.clone())
                .collect();
            if let Some(plan) = prove(&ops, calls) {
                best = Some((end, plan));
            }
        }
        if let Some((end, (base, length, sites, rights))) = best {
            selected.push(serde_json::json!({"function":function,"startOffset":segment[boundaries[start]].offset,"startOrdinal":segment[boundaries[start]].ordinal,"endOrdinal":segment[boundaries[end]-1].ordinal+1,"lastOffset":segment[boundaries[end]-1].offset,"operators":boundaries[end]-boundaries[start],"baseLocal":base,"spanBytes":length,"sites":sites,"rights":rights}));
            if calls.is_some() {
                let call_indices: Vec<_> = segment[boundaries[start]..boundaries[end]]
                    .iter()
                    .filter_map(|item| match item.op {
                        O::Call { function_index } => Some(function_index),
                        _ => None,
                    })
                    .collect();
                selected.last_mut().unwrap()["directCalls"] = serde_json::json!(call_indices);
            }
            start = end;
        } else {
            start += 1;
        }
    }
}
fn self_checks() -> u32 {
    let load = || O::I32Load {
        memarg: p::MemArg {
            align: 2,
            max_align: 2,
            offset: 0,
            memory: 0,
        },
    };
    let a = vec![
        O::LocalGet { local_index: 0 },
        load(),
        O::Drop,
        O::LocalGet { local_index: 0 },
        load(),
        O::Drop,
    ];
    assert!(prove(&a, None).is_some());
    let mut b = a.clone();
    b[3] = O::LocalGet { local_index: 1 };
    assert!(prove(&b, None).is_none());
    let mut b = a.clone();
    b.splice(
        0..0,
        [O::I32Const { value: 2 }, O::LocalSet { local_index: 0 }],
    );
    assert!(prove(&b, None).is_none());
    let mut b = a.clone();
    b.splice(3..3, [O::Call { function_index: 1 }]);
    assert!(prove(&b, None).is_none());
    let mut b = a.clone();
    b.splice(1..1, [O::I32Const { value: 4 }, O::I32Add]);
    assert!(prove(&b, None).is_none());
    let mut b = a.clone();
    b[4] = O::I32Load {
        memarg: p::MemArg {
            align: 2,
            max_align: 2,
            offset: 65535,
            memory: 0,
        },
    };
    assert!(prove(&b, None).is_none());
    6
}
pub fn analyze(bytes: &[u8]) -> Result<serde_json::Value> {
    analyze_policy(bytes, None)
}
pub fn analyze_with_calls(bytes: &[u8], policy: CallPolicy) -> Result<serde_json::Value> {
    let effects = CallEffects::parse(
        bytes,
        matches!(policy, CallPolicy::PublishPatternOpportunity),
    )?;
    let mut report = analyze_policy(bytes, Some(&effects))?;
    report["callEffects"] = effects.report();
    report["scope"] = serde_json::json!(
        "Read-only call-aware region feasibility under the existing trusted one-Worker/process mapping-boundary model. Exact unchanged caller-local bases and empty stacks; direct i32 calls admitted only by transitive effect policy. The write-allowing policy is an opportunity estimate, NOT channel-alias proof or rewrite eligibility. No Wasm rewrite, dynamic guard coverage or performance claim."
    );
    Ok(report)
}
fn analyze_policy(bytes: &[u8], calls: Option<&CallEffects>) -> Result<serde_json::Value> {
    let checks = self_checks();
    p::Validator::new_with_features(p::WasmFeatures::all()).validate_all(bytes)?;
    let mut memories = 0;
    for payload in Parser::new(0).parse_all(bytes) {
        match payload? {
            p::Payload::ImportSection(s) => {
                for i in s.into_imports() {
                    if let p::TypeRef::Memory(m) = i?.ty {
                        ensure!(!m.memory64, "region proofs require memory32");
                        memories += 1;
                    }
                }
            }
            p::Payload::MemorySection(_) => {
                anyhow::bail!("region proofs require imported process memory")
            }
            _ => {}
        }
    }
    ensure!(memories == 1, "region proofs require one process memory");
    let mut validator = p::Validator::new_with_features(p::WasmFeatures::all());
    let mut allocations = p::FuncValidatorAllocations::default();
    let mut regions = vec![];
    let mut total_sites = 0u64;
    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload?;
        if let p::ValidPayload::Func(f, b) = validator.payload(&payload)? {
            let index = f.index;
            let mut fv = f.into_validator(allocations);
            let mut reader = b.get_binary_reader();
            fv.read_locals(&mut reader)?;
            let mut ops = b.get_operators_reader()?;
            let mut segment = vec![];
            let mut ordinal = 0;
            while !ops.eof() {
                let offset = ops.original_position();
                let op = ops.read()?;
                let current_ordinal = ordinal;
                ordinal += 1;
                let before = fv.operand_stack_height();
                fv.op(offset, &op)?;
                let after = fv.operand_stack_height();
                if memory(&op).is_some() {
                    total_sites += 1;
                }
                let allowed = memory(&op).is_some()
                    || unary(&op)
                    || binary(&op)
                    || matches!(op, O::I32Const { .. } | O::Drop | O::Nop)
                    || match op {
                        O::LocalGet { local_index: l }
                        | O::LocalSet { local_index: l }
                        | O::LocalTee { local_index: l } => {
                            fv.get_local_type(l) == Some(p::ValType::I32)
                        }
                        O::Call { function_index } => {
                            calls.is_some_and(|c| c.call_shape(function_index).is_some())
                        }
                        O::GlobalGet { .. } => {
                            fv.get_operand_type(0) == Some(Some(p::ValType::I32))
                        }
                        _ => false,
                    };
                if !allowed {
                    flush(&segment, index, &mut regions, calls);
                    segment.clear();
                    continue;
                }
                if segment.is_empty() && before != 0 {
                    continue;
                }
                segment.push(Item {
                    op,
                    offset,
                    ordinal: current_ordinal,
                    after,
                });
                if segment.len() >= 1024 && after == 0 {
                    flush(&segment, index, &mut regions, calls);
                    segment.clear();
                }
            }
            flush(&segment, index, &mut regions, calls);
            allocations = fv.into_allocations();
        }
    }
    let selected_sites: u64 = regions.iter().map(|r| r["sites"].as_u64().unwrap()).sum();
    let functions: BTreeSet<_> = regions
        .iter()
        .map(|r| r["function"].as_u64().unwrap())
        .collect();
    let report = serde_json::json!({"scope":"Read-only regional address proof: empty operand-stack boundaries, allowed i32 straight-line operators, exact repeated local-derived address, unchanged base local, <=64KiB span, no calls/control/unknown effects. Six positive/negative core checks pass. A future nonfaulting guard must preserve original sequence on miss and physical temporaries must stay within the region. No rewrite, dynamic guard coverage or performance claimed.","selfChecks":checks,"i32MemorySites":total_sites,"regions":regions,"selectedRegions":regions.len(),"selectedFunctions":functions.len(),"selectedStaticSites":selected_sites});
    Ok(report)
}
