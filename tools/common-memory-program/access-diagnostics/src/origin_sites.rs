//! Join original memarg sites to outlined calls in a diagnostic-only module.
//! This counts execution of shape candidates; it does not authorize a rewrite.
use anyhow::{Context, Result, ensure};
use std::collections::BTreeMap;
use wasmparser::{Operator, Parser, Payload};

pub const FIRST_SLOT: u32 = 208;
pub const NAMES: [&str; 7] = [
    "anchorNameOpportunity",
    "definitionOrigin",
    "noInterveningEffectWindow",
    "readonlyInvariantLoop",
    "readonlyStrideBoundOpportunity",
    "readonlyLoopUnion",
    "allCandidateUnion",
];

// Writer classes are opt-in. Legacy origin and plain diagnostic bytes remain
// reproducible, including their seven-class metadata and counter slots.
pub const WRITER_NAMES: [&str; 7] = [
    "writerLoop",
    "writerLoopEmptyEntry",
    "writerLoopEmptyEntryWithStrideHint",
    "writerLoopStore",
    "writerLoopEmptyEntryStore",
    "writerLoopEmptyEntryWithStrideHintStore",
    "readonlyOrWriterLoopUnion",
];

pub const CONSTANT_NAMES: [&str; 8] = [
    "constantAddress",
    "constantAddressLoad",
    "constantAddressStore",
    "constantAddressAtomic",
    "constantAddressOverflow",
    "constantAddressSinglePage",
    "constantAddressZeroBaseLargeOffset",
    "constantAddressInInitialData",
];

#[derive(Debug)]
struct Site {
    operation: String,
    mask: u32,
}
pub struct OriginSites {
    plans: BTreeMap<u32, Vec<Site>>,
    pub metadata: serde_json::Value,
    pub seen_sites: u64,
    class_count: usize,
}
impl OriginSites {
    pub fn new(bytes: &[u8], source_functions: u32, imports: u32) -> Result<Self> {
        Self::build(bytes, source_functions, imports, false, false)
    }
    pub fn with_writer_loops(bytes: &[u8], source_functions: u32, imports: u32) -> Result<Self> {
        Self::build(bytes, source_functions, imports, true, false)
    }
    pub fn with_constants(bytes: &[u8], source_functions: u32, imports: u32) -> Result<Self> {
        Self::build(bytes, source_functions, imports, false, true)
    }
    pub fn class_count(&self) -> usize {
        self.class_count
    }
    fn build(
        bytes: &[u8],
        source_functions: u32,
        imports: u32,
        writers: bool,
        constants: bool,
    ) -> Result<Self> {
        // Derive the site classes from these exact bytes rather than accepting
        // a detached report whose function ordinals might belong to another build.
        let report = if constants {
            common_memory_feasibility::analyze_constants(bytes)?
        } else {
            common_memory_feasibility::analyze_origins(bytes)?
        };
        ensure!(
            report["importedFunctions"] == imports,
            "native import count mismatch"
        );
        ensure!(
            report["definedFunctions"]
                .as_u64()
                .context("defined functions")?
                + u64::from(imports)
                == u64::from(source_functions),
            "native function count mismatch"
        );
        let mut masks = BTreeMap::new();
        for site in report[if constants {
            "constantSites"
        } else {
            "candidateSites"
        }]
        .as_array()
        .context("candidate sites")?
        {
            let mut mask = 0;
            if constants {
                let valid = site["validMemory32Range"]
                    .as_bool()
                    .context("constant range")?;
                let write = site["write"].as_bool().context("constant write")?;
                let atomic = site["atomic"].as_bool().context("constant atomic")?;
                for (bit, yes) in [
                    true,
                    valid && !write && !atomic,
                    valid && write && !atomic,
                    valid && atomic,
                    !valid,
                    site["singlePage"].as_bool().context("constant page")?,
                    valid
                        && site["baseMod32"] == 0
                        && site["memargOffset"].as_u64().context("offset")? > 16,
                    site["initialDataRange"].as_bool().context("initial data")?,
                ]
                .into_iter()
                .enumerate()
                {
                    if yes {
                        mask |= 1 << bit;
                    }
                }
            } else {
                for (bit, name) in NAMES[..5].iter().enumerate() {
                    if site[*name].as_bool().context("candidate flag")? {
                        mask |= 1 << bit;
                    }
                }
                if mask & ((1 << 3) | (1 << 4)) != 0 {
                    mask |= 1 << 5;
                }
                if mask != 0 {
                    mask |= 1 << 6;
                }
            }
            let key = (
                site["function"].as_u64().context("function")? as u32,
                site["ordinal"].as_u64().context("ordinal")? as usize,
            );
            ensure!(
                masks.insert(key, mask).is_none(),
                "duplicate candidate site"
            );
        }
        let mut writer_intervals: BTreeMap<u32, Vec<(usize, usize, u32)>> = BTreeMap::new();
        let mut writer_loop_counts = [0u64; 3];
        if writers {
            for row in report["loops"].as_array().context("loop report")? {
                let effects = row["effects"].as_object().context("loop effects")?;
                if effects.len() != 1 || !effects.contains_key("guest-memory-write") {
                    continue;
                }
                let mut mask = 1 << 7;
                writer_loop_counts[0] += 1;
                if row["entryEmpty"].as_bool().context("loop entry")? {
                    mask |= 1 << 8;
                    writer_loop_counts[1] += 1;
                    if !row["strideHints"]
                        .as_array()
                        .context("loop hints")?
                        .is_empty()
                    {
                        mask |= 1 << 9;
                        writer_loop_counts[2] += 1;
                    }
                }
                let function = u32::try_from(row["function"].as_u64().context("loop function")?)?;
                let start = usize::try_from(row["startOrdinal"].as_u64().context("loop start")?)?;
                let end = usize::try_from(row["endOrdinal"].as_u64().context("loop end")?)?;
                ensure!(start < end, "empty or reversed loop interval");
                writer_intervals
                    .entry(function)
                    .or_default()
                    .push((start, end, mask));
            }
        }
        let names: Vec<_> = if constants {
            CONSTANT_NAMES.to_vec()
        } else {
            NAMES
                .iter()
                .chain(if writers {
                    WRITER_NAMES.iter()
                } else {
                    [].iter()
                })
                .copied()
                .collect()
        };
        ensure!(
            names.len() <= 32 && FIRST_SLOT + names.len() as u32 <= super::FUNCTION_BASE,
            "site classes overlap function counters"
        );
        let mut plans = BTreeMap::new();
        let mut function = imports;
        let mut sites = 0;
        let mut totals = vec![0u64; names.len()];
        for payload in Parser::new(0).parse_all(bytes) {
            if let Payload::CodeSectionEntry(body) = payload? {
                let mut plan = vec![];
                for (ordinal, op) in body.get_operators_reader()?.into_iter().enumerate() {
                    let op = op?;
                    if let Some(operation) = super::operation(&op) {
                        let mut mask = masks.remove(&(function, ordinal)).unwrap_or(0);
                        if writers {
                            let mut writer_mask = 0;
                            for &(start, end, window_mask) in
                                writer_intervals.get(&function).into_iter().flatten()
                            {
                                if start < ordinal && ordinal < end {
                                    writer_mask |= window_mask;
                                }
                            }
                            mask |= writer_mask;
                            if operation.contains("Store") {
                                mask |= writer_mask << 3;
                            }
                            if mask & ((1 << 5) | (1 << 7)) != 0 {
                                mask |= 1 << 13;
                            }
                        }
                        for (bit, total) in totals.iter_mut().enumerate() {
                            if mask & (1 << bit) != 0 {
                                *total += 1;
                            }
                        }
                        plan.push(Site { operation, mask });
                        sites += 1;
                    }
                }
                plans.insert(function, plan);
                function += 1;
            }
        }
        ensure!(
            masks.is_empty(),
            "candidate not linked to a memarg operation"
        );
        ensure!(
            function == source_functions,
            "source function inventory mismatch"
        );
        ensure!(
            report["totals"]["memorySites"] == sites,
            "static site count mismatch"
        );
        let mut metadata = serde_json::json!({
            "version":1,"firstSlot":FIRST_SLOT,"classNames":names,
            "staticClassSites":totals,"sourceMemorySites":sites,
            "nativeBytes":bytes.len(),"analyzerTotals":report["totals"],
            "scope":"Overlapping origin/loop shape candidate attempts, not safe elisions, CPU or latency. Classes are freshly derived from the provided native bytes. Every original function must match the outlined module's complete memarg call count and operation-kind order. External frozen artifact hashes establish provenance; this join is not a translation-equivalence proof. Bulk helpers are excluded from candidate classes but remain in ordinary dispatch totals."
        });
        if writers {
            metadata["version"] = serde_json::json!(2);
            metadata["writerLoopCounts"] = serde_json::json!(writer_loop_counts);
            metadata["writerScope"] = serde_json::json!(
                "Original memarg sites strictly inside the union of loop intervals whose modeled effects are exactly guest-memory-write. Empty-entry and any-stride-hint subsets are loop shapes, not per-address induction, alias, bounds, no-wrap, mapping-lifetime or control/channel safety proofs. Store subsets count scalar/SIMD memarg stores only. Bulk copy/fill/init can qualify a loop but are excluded from these site counters. Nested loops count a site once per overlapping class; attempted accesses include traps and only count if control reaches the site. Readonly union combines the prior conservative readonly classes. No translation elision enabled."
            );
        }
        if constants {
            metadata["version"] = serde_json::json!(3);
            metadata["constantAnalysis"] = report["constantAnalysis"].clone();
            metadata["constantScope"] = serde_json::json!(
                "Reached constant-address memarg attempts. Classes overlap; overflow attempts remain counted before their original trap. Original constant virtual addresses are not physical bindings. No mapping/lifetime/permission/alias/fork-state ownership proof and no translation elision or latency measurement."
            );
        }
        Ok(Self {
            plans,
            metadata,
            seen_sites: 0,
            class_count: names.len(),
        })
    }

    pub fn calls(
        &mut self,
        function: u32,
        ops: &[Operator<'_>],
        first_wrapper: u32,
        last_wrapper: u32,
        wrappers: &BTreeMap<u32, u32>,
        names: &[String],
    ) -> Result<BTreeMap<usize, u32>> {
        let plan = self
            .plans
            .remove(&function)
            .context("unplanned source function")?;
        let mut site = 0;
        let mut result = BTreeMap::new();
        for (ordinal, op) in ops.iter().enumerate() {
            if let Operator::Call { function_index } = op {
                if (first_wrapper..=last_wrapper).contains(function_index) {
                    let expected = plan.get(site).context("extra outlined memory call")?;
                    let category =
                        *wrappers.get(function_index).context("wrapper category")? as usize;
                    ensure!(
                        names.get(category) == Some(&expected.operation),
                        "memory kind/order mismatch at function {function} site {site}"
                    );
                    if expected.mask != 0 {
                        result.insert(ordinal, expected.mask);
                    }
                    site += 1;
                }
            }
            ensure!(
                super::operation(op).is_none(),
                "raw source memory operation"
            );
        }
        ensure!(
            site == plan.len(),
            "missing outlined memory calls in function {function}"
        );
        self.seen_sites += site as u64;
        Ok(result)
    }

    pub fn finish(&self) -> Result<()> {
        ensure!(self.plans.is_empty(), "source function plans remain");
        ensure!(
            self.metadata["sourceMemorySites"] == self.seen_sites,
            "site join incomplete"
        );
        Ok(())
    }
}

#[cfg(test)]
mod constant_tests {
    use super::*;
    fn plan(body: &str) -> OriginSites {
        let bytes = wat::parse_str(format!(
            r#"(module
          (import "env" "memory" (memory 2 8 shared))
          (global (export "__stack_pointer") (mut i32) (i32.const 131072))
          (data (i32.const 64) "12345678abcdefgh")
          (func (param i32) {body}))"#
        ))
        .unwrap();
        OriginSites::with_constants(&bytes, 1, 0).unwrap()
    }
    #[test]
    fn constant_classes_overlap_without_entering_legacy_union_bits() {
        let p = plan(
            "i32.const 0 i32.load offset=64 drop i32.const 72 local.get 0 i32.store
          i32.const 64 i32.atomic.load drop local.get 0 i32.load drop",
        );
        assert_eq!(p.class_count(), 8);
        assert_eq!(p.metadata["version"], 3);
        assert_eq!(p.plans[&0][0].mask, 1 | 2 | 32 | 64 | 128);
        assert_eq!(p.plans[&0][1].mask, 1 | 4 | 32 | 128);
        assert_eq!(p.plans[&0][2].mask, 1 | 8 | 32 | 128);
        assert_eq!(p.plans[&0][3].mask, 0);
        assert_eq!(
            p.metadata["staticClassSites"],
            serde_json::json!([3, 1, 1, 1, 0, 3, 1, 3])
        );
    }
    #[test]
    fn intrinsic_overflow_is_only_an_attempt_not_a_valid_constant_load() {
        let p = plan("i32.const 1 i32.load offset=4294967295 drop");
        assert_eq!(p.plans[&0][0].mask, 1 | 16);
    }
    #[test]
    fn candidate_join_still_checks_full_operation_order() {
        let mut p = plan("i32.const 64 i32.load drop i32.const 64 i32.const 1 i32.store");
        let calls = p.calls(
            0,
            &[
                Operator::Call { function_index: 11 },
                Operator::Call { function_index: 10 },
            ],
            10,
            11,
            &[(10, 0), (11, 1)].into(),
            &["I32Load".into(), "I32Store".into()],
        );
        assert!(calls.is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const MODULE: &str = r#"(module (import "env" "memory" (memory 1 2 shared))
      (global (export "__stack_pointer") (mut i32) (i32.const 65536))
      (func (param i32) (local i32)
        global.get 0 i32.const 16 i32.sub local.tee 1 global.set 0
        local.get 1 i32.load drop
        local.get 0 i32.const 42 i32.store))"#;
    fn source() -> Vec<u8> {
        wat::parse_str(MODULE).unwrap()
    }
    fn wrappers() -> BTreeMap<u32, u32> {
        [(10, 0), (11, 1)].into()
    }
    fn names() -> Vec<String> {
        vec!["I32Load".into(), "I32Store".into()]
    }
    #[test]
    fn complete_join_preserves_original_order_and_overlap() {
        let mut p = OriginSites::new(&source(), 1, 0).unwrap();
        let calls = p
            .calls(
                0,
                &[
                    Operator::Nop,
                    Operator::Call { function_index: 10 },
                    Operator::Call { function_index: 11 },
                ],
                10,
                11,
                &wrappers(),
                &names(),
            )
            .unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[&1], 1 | 2 | 4 | 64);
        assert_eq!(p.seen_sites, 2);
        p.finish().unwrap();
    }
    #[test]
    fn wrong_native_inventory_is_rejected() {
        assert!(OriginSites::new(&source(), 2, 0).is_err());
        assert!(OriginSites::new(&source(), 1, 1).is_err());
    }
    #[test]
    fn missing_extra_reordered_and_raw_operations_are_rejected() {
        let cases = vec![
            vec![Operator::Call { function_index: 10 }],
            vec![
                Operator::Call { function_index: 10 },
                Operator::Call { function_index: 11 },
                Operator::Call { function_index: 10 },
            ],
            vec![
                Operator::Call { function_index: 11 },
                Operator::Call { function_index: 10 },
            ],
            vec![Operator::I32Load {
                memarg: wasmparser::MemArg {
                    align: 2,
                    max_align: 2,
                    offset: 0,
                    memory: 0,
                },
            }],
        ];
        for ops in cases {
            let mut p = OriginSites::new(&source(), 1, 0).unwrap();
            assert!(p.calls(0, &ops, 10, 11, &wrappers(), &names()).is_err());
        }
    }
    #[test]
    fn omitted_or_duplicate_function_plans_are_rejected() {
        let mut p = OriginSites::new(&source(), 1, 0).unwrap();
        assert!(p.finish().is_err());
        let ops = [
            Operator::Call { function_index: 10 },
            Operator::Call { function_index: 11 },
        ];
        p.calls(0, &ops, 10, 11, &wrappers(), &names()).unwrap();
        assert!(p.calls(0, &ops, 10, 11, &wrappers(), &names()).is_err());
    }
}

#[cfg(test)]
mod writer_tests {
    use super::*;
    fn analyze(extra: &str, body: &str, extra_functions: &str) -> OriginSites {
        let wat = format!(
            r#"(module (import "env" "memory" (memory 2 10 shared))
          (global (export "__stack_pointer") (mut i32) (i32.const 65536))
          {extra} (func (local i32 i32) {body}) {extra_functions})"#
        );
        let bytes = wat::parse_str(wat).unwrap();
        OriginSites::with_writer_loops(&bytes, if extra_functions.is_empty() { 1 } else { 2 }, 0)
            .unwrap()
    }
    const ACCESS: &str = "i32.const 0 i32.load drop i32.const 4 i32.const 9 i32.store";
    #[test]
    fn nested_membership_is_a_union_and_stores_are_a_subset() {
        let p = analyze("", &format!("loop loop {ACCESS} end end"), "");
        assert_eq!(p.class_count(), 14);
        let sites = &p.plans[&0];
        assert_eq!(sites.len(), 2);
        assert_eq!(sites[0].mask & (127 << 7), (1 << 7) | (1 << 8) | (1 << 13));
        assert_eq!(
            sites[1].mask & (127 << 7),
            (1 << 7) | (1 << 8) | (1 << 10) | (1 << 11) | (1 << 13)
        );
        assert_eq!(p.metadata["staticClassSites"][7], 2);
        assert_eq!(p.metadata["writerLoopCounts"], serde_json::json!([2, 2, 0]));
    }
    #[test]
    fn stride_is_a_loop_hint_without_claiming_each_address_is_strided() {
        let body = format!(
            "loop {ACCESS} local.get 0 i32.const 1 i32.add local.tee 0 i32.const 4 i32.lt_u br_if 0 end"
        );
        let p = analyze("", &body, "");
        assert_eq!(p.plans[&0][0].mask & (1 << 9), 1 << 9);
        assert_eq!(p.plans[&0][1].mask & (1 << 12), 1 << 12);
    }
    #[test]
    fn excluded_effects_do_not_qualify_the_containing_loop() {
        for (extra, effect, functions) in [
            ("", "call 1", "(func)"),
            (
                "(type (func)) (table 1 funcref)",
                "i32.const 0 call_indirect (type 0)",
                "",
            ),
            ("", "i32.const 0 i32.atomic.load drop", ""),
            ("", "i32.const 0 memory.grow drop", ""),
            ("(table 1 funcref)", "table.size 0 drop", ""),
            ("(tag (param i32))", "i32.const 0 throw 0", ""),
        ] {
            let p = analyze(extra, &format!("loop {ACCESS} {effect} end"), functions);
            assert!(
                p.plans[&0].iter().all(|s| s.mask & (63 << 7) == 0),
                "{effect}"
            );
        }
    }
    #[test]
    fn bulk_write_qualifies_a_loop_without_becoming_a_memarg_store() {
        let p = analyze(
            "",
            "loop i32.const 0 i32.load drop i32.const 4 i32.const 0 i32.const 4 memory.fill end",
            "",
        );
        assert_eq!(p.plans[&0].len(), 1);
        assert_ne!(p.plans[&0][0].mask & (1 << 7), 0);
        assert_eq!(p.plans[&0][0].mask & (7 << 10), 0);
    }
    #[test]
    fn nested_writer_can_qualify_inside_an_excluded_parent() {
        let p = analyze("", &format!("loop call 1 loop {ACCESS} end end"), "(func)");
        assert_eq!(p.metadata["writerLoopCounts"], serde_json::json!([1, 1, 0]));
        assert!(p.plans[&0].iter().all(|s| s.mask & (1 << 7) != 0));
    }
    #[test]
    fn accesses_outside_writer_intervals_do_not_count() {
        let p = analyze("", &format!("{ACCESS} loop {ACCESS} end {ACCESS}"), "");
        let masks: Vec<_> = p.plans[&0].iter().map(|s| s.mask & (1 << 7) != 0).collect();
        assert_eq!(masks, [false, false, true, true, false, false]);
    }
}

#[cfg(test)]
mod writer_union_tests {
    use super::*;
    #[test]
    fn readonly_nested_in_writer_is_counted_once_in_the_combined_union() {
        let bytes = wat::parse_str(
            r#"(module (import "env" "memory" (memory 2 10 shared))
          (global (export "__stack_pointer") (mut i32) (i32.const 65536))
          (func (param i32)
            loop
              loop local.get 0 i32.load drop end
              local.get 0 i32.const 1 i32.store
            end))"#,
        )
        .unwrap();
        let p = OriginSites::with_writer_loops(&bytes, 1, 0).unwrap();
        let load = &p.plans[&0][0];
        assert_ne!(load.mask & (1 << 5), 0);
        assert_ne!(load.mask & (1 << 7), 0);
        assert_eq!(p.metadata["staticClassSites"][13], 2);
    }
    #[test]
    fn loop_with_operand_stack_entry_is_not_in_empty_entry_subsets() {
        let bytes = wat::parse_str(
            r#"(module (import "env" "memory" (memory 2 10 shared))
          (global (export "__stack_pointer") (mut i32) (i32.const 65536))
          (func
            i32.const 0
            loop (param i32) (result i32)
              drop i32.const 0 i32.load drop
              i32.const 4 i32.const 7 i32.store
              i32.const 0
            end drop))"#,
        )
        .unwrap();
        let p = OriginSites::with_writer_loops(&bytes, 1, 0).unwrap();
        for site in &p.plans[&0] {
            assert_ne!(site.mask & (1 << 7), 0);
            assert_eq!(site.mask & ((1 << 8) | (1 << 9) | (1 << 11) | (1 << 12)), 0);
        }
    }
}
