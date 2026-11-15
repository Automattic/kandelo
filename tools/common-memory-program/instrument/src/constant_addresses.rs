//! Fixed virtual addresses specialize geometry, never physical ownership.
//! Every emitted access still checks the current root, logical bound and live
//! PTE/rights. Plans bind validated source function/operator positions.
use anyhow::{Context, Result, ensure};
use std::collections::BTreeMap;
use wasm_encoder::{Function, Instruction as I, MemArg, ValType as V};

#[derive(Clone, Debug)]
pub struct Site {
    pub function: usize,
    pub ordinal: usize,
    pub operator: String,
    pub base: u32,
    pub offset: u64,
    pub width: u32,
    pub address: u32,
    pub write: bool,
    pub atomic: bool,
}
#[derive(Default)]
pub struct Plan {
    pub imported_functions: usize,
    pub sites: BTreeMap<(usize, usize), Site>,
    pub recognized: usize,
    pub rejected: BTreeMap<&'static str, usize>,
}
impl Plan {
    pub fn analyze(bytes: &[u8]) -> Result<Self> {
        let report = common_memory_feasibility::analyze_constants(bytes)?;
        ensure!(
            report["schema"] == 1 && report["constantAnalysis"]["version"] == 2,
            "unsupported constant producer analysis"
        );
        let mut plan = Self {
            imported_functions: report["importedFunctions"]
                .as_u64()
                .context("missing imported function count")?
                .try_into()?,
            ..Default::default()
        };
        for row in report["constantSites"]
            .as_array()
            .context("missing constant sites")?
        {
            plan.recognized += 1;
            let reason = if row["unreachable"] == true {
                Some("unreachable")
            } else if row["validMemory32Range"] != true {
                Some("memory32-overflow")
            } else if row["singlePage"] != true {
                Some("split-page")
            } else {
                None
            };
            if let Some(reason) = reason {
                *plan.rejected.entry(reason).or_default() += 1;
                continue;
            }
            let base: u32 = row["baseMod32"]
                .as_u64()
                .context("missing constant base")?
                .try_into()?;
            let offset = row["memargOffset"]
                .as_u64()
                .context("missing memory offset")?;
            let width: u32 = row["width"]
                .as_u64()
                .context("missing memory width")?
                .try_into()?;
            ensure!(
                width.is_power_of_two() && width <= 16,
                "unsupported constant width"
            );
            let start = u64::from(base)
                .checked_add(offset)
                .context("constant address overflow")?;
            let end = start
                .checked_add(u64::from(width))
                .context("constant endpoint overflow")?;
            ensure!(
                end <= 1u64 << 32
                    && start / 65536 == (end - 1) / 65536
                    && row["effectiveStart"].as_u64() == Some(start)
                    && row["effectiveEndExclusive"].as_u64() == Some(end),
                "constant geometry disagrees with producer"
            );
            let atomic = row["atomic"]
                .as_bool()
                .context("missing atomic classification")?;
            if atomic && start % u64::from(width) != 0 {
                *plan.rejected.entry("unaligned-atomic").or_default() += 1;
                continue;
            }
            let site = Site {
                function: row["function"]
                    .as_u64()
                    .context("missing function")?
                    .try_into()?,
                ordinal: row["ordinal"]
                    .as_u64()
                    .context("missing ordinal")?
                    .try_into()?,
                operator: row["operator"]
                    .as_str()
                    .context("missing operator")?
                    .to_owned(),
                base,
                offset,
                width,
                address: start.try_into()?,
                atomic,
                write: row["write"]
                    .as_bool()
                    .context("missing write classification")?,
            };
            ensure!(
                plan.sites
                    .insert((site.function, site.ordinal), site)
                    .is_none(),
                "duplicate constant site"
            );
        }
        Ok(plan)
    }
    pub fn bind(
        &self,
        function: usize,
        ordinal: usize,
        access: &super::Access,
    ) -> Result<Option<u32>> {
        let Some(site) = self.sites.get(&(function, ordinal)) else {
            return Ok(None);
        };
        ensure!(
            site.operator == access.name
                && site.offset == access.memarg.offset
                && site.width == 1u32 << access.memarg.max_align
                && site.write == access.write
                && site.atomic == access.atomic
                && u64::from(site.base) + site.offset == u64::from(site.address),
            "constant site does not bind to original memory operation"
        );
        Ok(Some(site.address))
    }
    pub fn detail(&self) -> Vec<serde_json::Value> {
        self.sites
            .values()
            .map(|s| {
                serde_json::json!({"function":s.function,"ordinal":s.ordinal,
            "operator":s.operator,"baseMod32":s.base,"memargOffset":s.offset,"width":s.width,
            "effectiveAddress":s.address,"write":s.write,"atomic":s.atomic})
            })
            .collect()
    }
}

pub fn key(address: u32, instruction: &[u8]) -> Vec<u8> {
    // 0xff cannot begin a source opcode (or the existing 0/1 policy prefix).
    let mut key = vec![0xff];
    key.extend(address.to_le_bytes());
    key.extend(instruction);
    key
}

pub fn wrapper(address: u32, access: &super::Access, instruction: &[u8], root: u32) -> Function {
    let entry = 1 + access.values.len() as u32; // Original pointer parameter stays consumed.
    let mut f = Function::new([(1, V::I32)]);
    let load = |offset| MemArg {
        offset,
        align: 2,
        memory_index: 0,
    };
    f.instruction(&I::GlobalGet(root));
    f.instruction(&I::I32Eqz);
    f.instruction(&I::If(wasm_encoder::BlockType::Empty));
    f.instruction(&I::Unreachable);
    f.instruction(&I::End);
    // The complete known range fits this page. Unsigned page comparison also
    // represents a full 4GiB logical size without narrowing its endpoint.
    f.instruction(&I::I32Const((address >> 16) as i32));
    f.instruction(&I::GlobalGet(root));
    f.instruction(&I::I32Load(load(0)));
    f.instruction(&I::I32GeU);
    f.instruction(&I::If(wasm_encoder::BlockType::Empty));
    f.instruction(&I::Unreachable);
    f.instruction(&I::End);
    f.instruction(&I::GlobalGet(root));
    f.instruction(&I::I32Load(load(64 + u64::from(address >> 16) * 4)));
    f.instruction(&I::LocalTee(entry));
    f.instruction(&I::I32Const(access.rights as i32));
    f.instruction(&I::I32And);
    f.instruction(&I::I32Const(access.rights as i32));
    f.instruction(&I::I32Ne);
    f.instruction(&I::If(wasm_encoder::BlockType::Empty));
    f.instruction(&I::Unreachable);
    f.instruction(&I::End);
    f.instruction(&I::LocalGet(entry));
    f.instruction(&I::I32Const(-65536));
    f.instruction(&I::I32And);
    f.instruction(&I::I32Eqz);
    f.instruction(&I::If(wasm_encoder::BlockType::Empty));
    f.instruction(&I::Unreachable);
    f.instruction(&I::End);
    f.instruction(&I::LocalGet(entry));
    f.instruction(&I::I32Const(-65536));
    f.instruction(&I::I32And);
    if address & 65535 != 0 {
        f.instruction(&I::I32Const((address & 65535) as i32));
        f.instruction(&I::I32Or);
    }
    for i in 0..access.values.len() {
        f.instruction(&I::LocalGet(1 + i as u32));
    }
    // Single-page stores never stage; atomics still execute the original
    // payload operation, including waits, cmpxchg and returned old values.
    f.raw(instruction.iter().copied());
    f.instruction(&I::End);
    f
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(extra: &str, body: &str) -> Vec<u8> {
        wat::parse_str(format!(
            r#"(module {extra} (import "env" "memory" (memory 2 65536 shared))
            (func (param $p i32) (local $x i32) {body}))"#
        ))
        .unwrap()
    }
    #[test]
    fn modular_producers_and_memarg_geometry_are_not_conflated() {
        let p = Plan::analyze(&input("", "i32.const -1 i32.const 2 i32.add i32.load offset=3 drop
            i32.const 65534 i32.load drop i32.const -1 i32.load offset=1 drop
            i32.const 3 i32.atomic.load drop i32.const 64 i32.const 1 i32.const 2 i32.atomic.rmw.cmpxchg drop")).unwrap();
        assert_eq!(p.recognized, 5);
        assert_eq!(p.sites.len(), 2);
        assert_eq!(p.sites.values().next().unwrap().address, 4);
        assert_eq!(p.rejected["split-page"], 1);
        assert_eq!(p.rejected["memory32-overflow"], 1);
        assert_eq!(p.rejected["unaligned-atomic"], 1);
    }
    #[test]
    fn imports_and_exact_operation_binding_are_checked() {
        let p = Plan::analyze(&input(
            r#"(import "env" "f" (func))"#,
            "i32.const 64 i32.load drop",
        ))
        .unwrap();
        assert_eq!(p.imported_functions, 1);
        let s = p.sites.values().next().unwrap();
        assert_eq!((s.function, s.ordinal), (1, 1));
        let m = wasmparser::MemArg {
            align: 2,
            max_align: 2,
            offset: 0,
            memory: 0,
        };
        let load = super::super::access(&wasmparser::Operator::I32Load { memarg: m })
            .unwrap()
            .unwrap();
        assert_eq!(p.bind(1, 1, &load).unwrap(), Some(64));
        let store = super::super::access(&wasmparser::Operator::I32Store { memarg: m })
            .unwrap()
            .unwrap();
        assert!(p.bind(1, 1, &store).is_err());
        assert_eq!(p.bind(0, 1, &load).unwrap(), None);
    }
    #[test]
    fn loop_parameters_and_conditional_local_changes_are_not_proofs() {
        let p = Plan::analyze(&input(
            "",
            "i32.const 64 loop (param i32) (result i32)
            local.tee $x i32.load drop i32.const 128 local.get $p br_if 0 end drop
            i32.const 64 local.set $x local.get $p if i32.const 128 local.set $x end
            local.get $x i32.load drop",
        ))
        .unwrap();
        assert!(p.sites.is_empty());
    }
    #[test]
    fn constant_keys_cannot_alias_normal_keys_or_other_addresses() {
        let op = [0x28, 2, 0];
        assert_ne!(key(64, &op), op);
        assert_ne!(key(64, &op), key(128, &op));
        assert_ne!(key(64, &op), key(64, &[0x2d, 0, 0]));
    }
    #[test]
    fn end_of_memory_and_simd_lanes_keep_exact_widths() {
        let p = Plan::analyze(&input(
            "",
            "i32.const -8 i64.load drop
            i32.const 64 v128.const i32x4 0 0 0 0 v128.load32_lane 1 drop",
        ))
        .unwrap();
        let sites: Vec<_> = p.sites.values().collect();
        assert_eq!((sites[0].address, sites[0].width), (u32::MAX - 7, 8));
        assert_eq!((sites[1].address, sites[1].width), (64, 4));
    }
}
