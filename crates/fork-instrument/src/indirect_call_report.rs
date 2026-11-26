//! A report of mismatched Wasm indirect calls with a known target.

use anyhow::Result;
use std::collections::{BTreeMap, BTreeSet};
use wasmparser::types::CoreTypeId;
use wasmparser::{BinaryReader, ExternalKind, FunctionBody, Operator, ValType};

use crate::streaming::{self, CallTarget, Dispatch, Scan, ValueProof};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum SlotSource {
    Literal,
    LastArgument { caller: u32 },
    StoreAndReload,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct FixedTarget {
    pub caller: u32,
    pub expected_type: u32,
    pub table: u32,
    pub slot: u32,
    pub target: u32,
    pub source: SlotSource,
    pub exported_table: bool,
    pub target_type: u32,
}

// A group identifies a linked caller, table and instruction signature. Keep the
// upstream caller as evidence when the slot travelled through a direct call.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct Site {
    caller: u32,
    table: u32,
    ty: u32,
}

fn summarized_calls(body: &streaming::BodySummary) -> impl Iterator<Item = &CallTarget> {
    body.calls
        .iter()
        .chain(body.tails.iter().map(|site| &site.target))
}

fn body_operators<'a>(
    scan: &Scan<'a>,
    body: &streaming::BodySummary,
) -> Result<impl Iterator<Item = Result<Operator<'a>>>> {
    let function = FunctionBody::new(BinaryReader::new(
        &scan.input()[body.range.clone()],
        body.range.start,
    ));
    let mut retention = streaming::LexicalRetention::new(body.range.len() + 1)?;
    Ok(function
        .get_operators_reader()?
        .into_iter()
        .filter_map(move |next| {
            let result = next.map_err(anyhow::Error::from).and_then(|op| {
                let retained = retention.visit(&op)?;
                // The instrumentation pass keeps tail-call suffixes for compiler
                // fact alignment. A tail call ends a path for this report.
                if matches!(
                    op,
                    Operator::ReturnCall { .. }
                        | Operator::ReturnCallIndirect { .. }
                        | Operator::ReturnCallRef { .. }
                ) {
                    retention.visit(&Operator::Return)?;
                }
                Ok(retained.then_some(op))
            });
            result.transpose()
        }))
}

// Follow one direct-call edge carrying a literal final argument to a callee
// that uses that unmodified parameter directly as its indirect table index.
fn forwarded_slots(scan: &Scan<'_>) -> Result<BTreeSet<(Site, u32, SlotSource)>> {
    let mut dispatchers = BTreeMap::new();
    let types = scan.types.as_ref();
    for (index, f) in scan.functions.iter().enumerate() {
        let Some(body) = &f.body else { continue };
        if !summarized_calls(body).any(|call| {
            matches!(
                call,
                CallTarget::Dispatch(Dispatch::Table {
                    index: ValueProof::Unknown,
                    ..
                })
            )
        }) {
            continue;
        }
        let params = types
            .get(canonical_type(scan, f.ty))
            .unwrap()
            .composite_type
            .unwrap_func()
            .params();
        if params.last() != Some(&ValType::I32) {
            continue;
        }
        let param = (params.len() - 1) as u32;
        let mut loaded = false;
        let mut sites = BTreeSet::new();
        for op in body_operators(scan, body)? {
            let op = op?;
            match op {
                Operator::LocalSet { local_index } | Operator::LocalTee { local_index }
                    if local_index == param =>
                {
                    sites.clear();
                    break;
                }
                Operator::CallIndirect {
                    type_index,
                    table_index,
                }
                | Operator::ReturnCallIndirect {
                    type_index,
                    table_index,
                } if loaded => {
                    sites.insert(Site {
                        caller: index as u32,
                        table: table_index,
                        ty: type_index,
                    });
                }
                _ => {}
            }
            loaded = matches!(op, Operator::LocalGet { local_index } if local_index == param);
        }
        if !sites.is_empty() {
            dispatchers.insert(index as u32, sites);
        }
    }
    let mut forwarded = BTreeSet::new();
    for (index, f) in scan.functions.iter().enumerate() {
        let Some(body) = &f.body else { continue };
        if !summarized_calls(body)
            .any(|call| matches!(call, CallTarget::Direct(i) if dispatchers.contains_key(i)))
        {
            continue;
        }
        let mut literal = None;
        for op in body_operators(scan, body)? {
            let op = op?;
            if let Operator::Call { function_index } | Operator::ReturnCall { function_index } = op
            {
                if let (Some(slot), Some(sites)) = (literal, dispatchers.get(&function_index)) {
                    forwarded.extend(sites.iter().map(|site| {
                        (
                            *site,
                            slot,
                            SlotSource::LastArgument {
                                caller: index as u32,
                            },
                        )
                    }));
                }
            }
            literal = match op {
                Operator::I32Const { value } => Some(value as u32),
                _ => None,
            };
        }
    }
    Ok(forwarded)
}

// Recover a literal store followed by a load from the same address. Forget
// the store across calls, branches and other effects. In shared memory this
// describes the execution in which another thread has not replaced the word.
fn stored_slots(
    scan: &Scan<'_>,
    caller: u32,
    body: &streaming::BodySummary,
    candidates: &mut BTreeSet<(Site, u32, SlotSource)>,
) -> Result<()> {
    let mut previous = None;
    let mut penultimate = None;
    let mut stored = None;
    let mut loaded = None;
    for op in body_operators(scan, body)? {
        let op = op?;
        let next_loaded = match op {
            Operator::I32Store { memarg } => {
                stored = penultimate.zip(previous).and_then(|(base, slot)| {
                    memarg
                        .offset
                        .checked_add(u64::from(base))
                        .map(|address| ((memarg.memory, address), slot))
                });
                None
            }
            Operator::I32Load { memarg } => {
                let address = previous.and_then(|base| memarg.offset.checked_add(u64::from(base)));
                stored.take().and_then(|((memory, offset), slot)| {
                    (memory == memarg.memory && Some(offset) == address).then_some(slot)
                })
            }
            Operator::I32Const { .. } | Operator::LocalGet { .. } => None,
            Operator::CallIndirect {
                type_index,
                table_index,
            }
            | Operator::ReturnCallIndirect {
                type_index,
                table_index,
            } => {
                if let Some(slot) = loaded {
                    candidates.insert((
                        Site {
                            caller,
                            table: table_index,
                            ty: type_index,
                        },
                        slot,
                        SlotSource::StoreAndReload,
                    ));
                }
                stored = None;
                None
            }
            _ => {
                stored = None;
                None
            }
        };
        penultimate = previous;
        previous = match op {
            Operator::I32Const { value } => Some(value as u32),
            _ => None,
        };
        loaded = next_loaded;
    }
    Ok(())
}

fn visit_fixed_targets(scan: &Scan<'_>, mut visit: impl FnMut(FixedTarget)) -> Result<usize> {
    // Imported tables, dynamic segment offsets and tables written by the guest
    // leave the initial slot identity unknown. A fixed index alone is not
    // evidence of which function occupies such a slot.
    let mut unresolved: BTreeSet<_> = scan
        .functions
        .iter()
        .filter_map(|function| function.body.as_ref())
        .flat_map(|body| body.table_writes.iter().copied())
        .collect();
    unresolved.extend(
        scan.table_initializers
            .iter()
            .enumerate()
            .filter(|(_, value)| matches!(value, ValueProof::Unknown))
            .map(|(idx, _)| idx as u32),
    );

    // Kandelo executables export their table. Report its initial binding and
    // expose that assumption. The dynamic linker can install fresh entries.
    if let (Some(table), _) = crate::call_graph::runtime_table_exports(scan) {
        unresolved.insert(table);
    }
    let exported: BTreeSet<_> = scan
        .exports
        .iter()
        .filter_map(|(_, kind, index)| (*kind == ExternalKind::Table).then_some(*index))
        .collect();
    let mut slots = BTreeMap::new();
    for element in &scan.elements {
        let Some((table, offset)) = element.active else {
            continue;
        };
        let Some(offset) = offset else {
            unresolved.insert(table);
            continue;
        };
        for (index, value) in element.items.iter().enumerate() {
            let Some(slot) = (offset as u32).checked_add(index as u32) else {
                unresolved.insert(table);
                break;
            };
            // Active segments are applied in order, including null entries.
            slots.insert((table, slot), *value);
        }
    }

    let mut candidates = forwarded_slots(scan)?;
    let mut groups = BTreeSet::new();
    for (caller, function) in scan.functions.iter().enumerate() {
        let Some(body) = &function.body else { continue };
        let mut unknown_index = false;
        for call in summarized_calls(body) {
            if let CallTarget::Dispatch(Dispatch::Table { table, ty, index }) = *call {
                let site = Site {
                    caller: caller as u32,
                    table,
                    ty,
                };
                groups.insert(site);
                if let ValueProof::I32(slot) = index {
                    candidates.insert((site, slot as u32, SlotSource::Literal));
                } else {
                    unknown_index = true;
                }
            }
        }
        if unknown_index {
            stored_slots(scan, caller as u32, body, &mut candidates)?;
        }
    }
    for (site, slot, source) in candidates {
        if unresolved.contains(&site.table)
            || u64::from(slot) >= scan.types.as_ref().table_at(site.table).initial
        {
            continue;
        }
        let value = slots
            .get(&(site.table, slot))
            .unwrap_or(&scan.table_initializers[site.table as usize]);
        if let ValueProof::Function(target) = *value {
            visit(FixedTarget {
                caller: site.caller,
                expected_type: site.ty,
                table: site.table,
                slot,
                target,
                source,
                target_type: scan.functions[target as usize].ty,
                exported_table: exported.contains(&site.table),
            });
        }
    }
    Ok(groups.len())
}

fn canonical_type(scan: &Scan<'_>, index: u32) -> CoreTypeId {
    scan.types.as_ref().core_type_at_in_module(index)
}

fn has_expected_type(scan: &Scan<'_>, expected_type: u32, target: u32) -> bool {
    let types = scan.types.as_ref();
    let expected = canonical_type(scan, expected_type);
    let mut current = Some(canonical_type(scan, scan.functions[target as usize].ty));
    while let Some(ty) = current {
        if ty == expected {
            return true;
        }
        current = types.supertype_of(ty);
    }
    false
}

#[derive(Default, Debug)]
pub struct Report {
    pub indirect_groups: usize,
    pub compatible: Vec<FixedTarget>,
    pub fixed_mismatches: Vec<FixedTarget>,
}

pub fn analyze(input: &[u8]) -> Result<Report> {
    let scan = streaming::scan(input)?;
    let mut targets = BTreeSet::new();
    let indirect_groups = visit_fixed_targets(&scan, |target| {
        targets.insert(target);
    })?;
    let (compatible, fixed_mismatches) = targets
        .into_iter()
        .partition(|item| has_expected_type(&scan, item.expected_type, item.target));
    Ok(Report {
        indirect_groups,
        compatible,
        fixed_mismatches,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(text: &str) -> Report {
        let wasm = wat::parse_str(text).unwrap();
        analyze(&wasm).unwrap()
    }

    #[test]
    fn checks_the_selected_slot_and_counts_imported_functions() {
        let result = report(
            r#"(module
                (type $wanted (func (param i32)))
                (import "env" "unrelated" (func $imported (type $wanted)))
                (func $wrong)
                (func $ok (type $wanted))
                (table 2 funcref)
                (elem (i32.const 0) $wrong $ok)
                (func (export "run")
                    (call_indirect (type $wanted) (i32.const 42) (i32.const 0))
                    (call_indirect (type $wanted) (i32.const 42) (i32.const 1))
                )
            )"#,
        );
        assert_eq!(result.compatible.len(), 1);
        assert_eq!(result.fixed_mismatches.len(), 1);
        assert_eq!(result.fixed_mismatches[0].target, 1);
        assert_eq!(result.fixed_mismatches[0].slot, 0);
    }

    #[test]
    fn ignores_slots_overwritten_with_null() {
        let result = report(
            r#"(module
                (type $wanted (func (param i32)))
                (func $wrong)
                (table 1 funcref)
                (elem (i32.const 0) $wrong)
                (elem (i32.const 0) funcref (ref.null func))
                (func (export "run")
                    (call_indirect (type $wanted) (i32.const 42) (i32.const 0))
                )
            )"#,
        );
        assert!(result.compatible.is_empty());
        assert!(result.fixed_mismatches.is_empty());
    }

    #[test]
    fn resolves_an_unmodified_callback_argument_across_a_direct_call() {
        let module = r#"(module
            (type $wanted (func (param i32)))
            (func $wrong)
            (table 2 funcref)
            (elem (i32.const 1) $wrong)
            (func $dispatch (param i32)
                (call_indirect (type $wanted) (i32.const 42) (local.get 0)))
            (func (export "run") (call $dispatch (i32.const 1))))"#;
        let result = report(module);
        assert_eq!(
            result.fixed_mismatches[0].source,
            SlotSource::LastArgument { caller: 2 }
        );
        assert_eq!(result.fixed_mismatches[0].caller, 1);
        assert!(
            report(&module.replace("(local.get 0)", "(local.tee 0 (i32.const 0))"))
                .fixed_mismatches
                .is_empty()
        );
        assert!(
            report(&module.replace("(table 2", "(table (export \"t\") 2")).fixed_mismatches[0]
                .exported_table
        );
    }

    #[test]
    fn follows_a_store_and_reload_only_across_side_effect_free_instructions() {
        let module = r#"(module
            (type $wanted (func (param i32)))
            (func $wrong) (table 2 funcref) (memory 1)
            (elem (i32.const 1) $wrong)
            (func (export "run")
                (i32.store offset=32 (i32.const 0) (i32.const 1))
                (call_indirect (type $wanted) (i32.const 42) (i32.load (i32.const 32)))))"#;
        assert_eq!(
            report(module).fixed_mismatches[0].source,
            SlotSource::StoreAndReload
        );
        assert!(
            report(&module.replace("(call_indirect", "(call $wrong) (call_indirect"))
                .fixed_mismatches
                .is_empty()
        );
        assert!(
            report(&module.replace("(i32.load ", "(i32.load offset=1 "))
                .fixed_mismatches
                .is_empty()
        );
    }

    #[test]
    fn ignores_a_dead_call_when_the_same_dispatcher_also_has_a_live_caller() {
        let module = r#"(module
            (type $want (func (param i32))) (func $wrong) (func $right (type $want))
            (table 3 funcref) (elem (i32.const 1) $wrong $right)
            (func $dispatch (param i32)
                (call_indirect (type $want) (i32.const 0) (local.get 0)))
            (func (export "run")
                (call $dispatch (i32.const 2))
                return
                (call $dispatch (i32.const 1))))"#;
        let result = report(module);
        assert_eq!(result.compatible.len(), 1);
        assert!(result.fixed_mismatches.is_empty());
    }

    #[test]
    fn ignores_mutable_tables() {
        let result = report(
            r#"(module
                (type $wanted (func (param i32)))
                (func $wrong)
                (table 1 funcref)
                (elem (i32.const 0) $wrong)
                (func (export "run")
                    (table.set (i32.const 0) (ref.null func))
                    (call_indirect (type $wanted) (i32.const 42) (i32.const 0))
                )
            )"#,
        );
        assert!(result.compatible.is_empty());
        assert!(result.fixed_mismatches.is_empty());
    }
}
