//! Read-only exact wrapper-key inventory. Normalized keys describe a possible
//! code-shape policy, never a transformed program or dynamic hotness proof.
use anyhow::{Result, ensure};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
};
use wasm_encoder::{
    Encode,
    reencode::{self, Reencode},
};
use wasmparser::{self as p, Operator as O, Parser, Payload};
macro_rules! capture {
    ($name:expr,memarg=>$m:expr $(,$rest:ident=>$value:expr)*) => {
        Some(($name, *$m))
    };
    ($name:expr $(,$rest:ident=>$value:expr)*) => {
        None
    };
}
macro_rules! memory_ops {
 ($(@$proposal:ident $op:ident $({$($arg:ident:$ty:ty),*})? => $visit:ident ($($ann:tt)*))*)=>{
  fn memory(op:&O<'_>)->Option<(&'static str,p::MemArg)>{match op{$(O::$op $({$($arg),*})?=>{$($(let _=$arg;)*)?capture!(stringify!($op)$(,$($arg=>$arg),*)?)},)*_=>None}}
 }
}
p::for_each_operator!(memory_ops);
const MODES: [&str; 6] = [
    "exact",
    "nonAtomicAlignment",
    "nonAtomicOffsets",
    "alignmentAndOffsets",
    "nonAtomicLargeOffsets",
    "alignmentAndLargeOffsets",
];
struct Key {
    alignment: bool,
    offset: bool,
}
impl Reencode for Key {
    type Error = anyhow::Error;
    fn mem_arg(
        &mut self,
        mut m: p::MemArg,
    ) -> std::result::Result<wasm_encoder::MemArg, reencode::Error<Self::Error>> {
        if self.alignment {
            m.align = m.max_align;
        }
        if self.offset {
            m.offset = 0;
        }
        reencode::utils::mem_arg(self, m)
    }
}
fn key(op: O<'_>, mode: usize) -> Result<Vec<u8>> {
    let (name, m) = memory(&op).ok_or_else(|| anyhow::anyhow!("memarg required"))?;
    let ordinary = !name.contains("Atomic");
    let mut encoder = Key {
        alignment: ordinary && [1, 3, 5].contains(&mode),
        offset: ordinary && ([2, 3].contains(&mode) || ([4, 5].contains(&mode) && m.offset > 16)),
    };
    let mut out = vec![u8::from(encoder.offset)];
    encoder
        .instruction(op)
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .encode(&mut out);
    Ok(out)
}
fn analyze(bytes: &[u8]) -> Result<serde_json::Value> {
    p::Validator::new_with_features(p::WasmFeatures::all()).validate_all(bytes)?;
    let mut sets: Vec<BTreeSet<Vec<u8>>> = (0..6).map(|_| BTreeSet::new()).collect();
    let mut kinds: BTreeMap<String, Vec<BTreeSet<Vec<u8>>>> = BTreeMap::new();
    let mut offsets = BTreeMap::<u64, u64>::new();
    let mut alignments = BTreeMap::<String, u64>::new();
    let (mut sites, mut atomics, mut nonnatural, mut large) = (0u64, 0u64, 0u64, 0u64);
    for payload in Parser::new(0).parse_all(bytes) {
        if let Payload::CodeSectionEntry(body) = payload? {
            for op in body.get_operators_reader()? {
                let op = op?;
                if let Some((name, m)) = memory(&op) {
                    sites += 1;
                    if name.contains("Atomic") {
                        atomics += 1;
                    } else {
                        if m.align != m.max_align {
                            nonnatural += 1;
                        }
                        if m.offset > 16 {
                            large += 1;
                        }
                    }
                    *offsets.entry(m.offset).or_default() += 1;
                    *alignments
                        .entry(format!("{}:{}", m.align, m.max_align))
                        .or_default() += 1;
                    let row = kinds
                        .entry(name.to_owned())
                        .or_insert_with(|| (0..6).map(|_| BTreeSet::new()).collect());
                    for mode in 0..6 {
                        let k = key(op.clone(), mode)?;
                        sets[mode].insert(k.clone());
                        row[mode].insert(k);
                    }
                }
            }
        }
    }
    let counts: Vec<_> = sets.iter().map(|s| s.len()).collect();
    let by_kind:Vec<_>=kinds.into_iter().map(|(name,values)|serde_json::json!({"operation":name,"uniqueKeys":values.iter().map(|s|s.len()).collect::<Vec<_>>()})).collect();
    Ok(
        serde_json::json!({"schema":2,"scope":"Read-only exact encoded instruction keys, matching collect_wrappers. Non-atomic alignment normalization changes hints only in hypothetical keys; all atomic keys remain exact. Generic offset keys are static code-shape opportunities, not rewritten code, dynamic hotness, guard elimination, compilation resource or latency results. Large means offset>16; A leading key tag distinguishes generic offset-parameter signatures from specialized signatures; lane/opcode/memory and other immediates remain distinct.","modes":MODES,"uniqueKeys":counts,"memorySites":sites,"atomicSites":atomics,"nonAtomicNonNaturalHintSites":nonnatural,"nonAtomicLargeOffsetSites":large,"offsetSiteCounts":offsets,"alignmentSiteCounts":alignments,"byOperation":by_kind}),
    )
}
fn main() -> Result<()> {
    let a: Vec<_> = std::env::args().collect();
    ensure!(a.len() == 3, "usage: wrapper_keys INPUT FRESH_REPORT");
    ensure!(
        !std::path::Path::new(&a[2]).exists(),
        "fresh report required"
    );
    let r = analyze(&fs::read(&a[1])?)?;
    fs::write(&a[2], serde_json::to_vec(&r)?)?;
    println!(
        "{}",
        serde_json::json!({"modes":r["modes"],"uniqueKeys":r["uniqueKeys"],"memorySites":r["memorySites"],"nonAtomicNonNaturalHintSites":r["nonAtomicNonNaturalHintSites"],"nonAtomicLargeOffsetSites":r["nonAtomicLargeOffsetSites"]})
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn mem(offset: u64, align: u8) -> p::MemArg {
        p::MemArg {
            offset,
            align,
            max_align: 2,
            memory: 0,
        }
    }
    #[test]
    fn only_hints_collapse() {
        let a = O::I32Load { memarg: mem(32, 0) };
        let b = O::I32Load { memarg: mem(32, 2) };
        assert_ne!(key(a.clone(), 0).unwrap(), key(b.clone(), 0).unwrap());
        assert_eq!(key(a.clone(), 1).unwrap(), key(b.clone(), 1).unwrap());
        assert_ne!(
            key(a, 1).unwrap(),
            key(O::I32Load { memarg: mem(36, 2) }, 1).unwrap()
        );
    }
    #[test]
    fn large_offset_policy_preserves_small_and_full_u64_keys() {
        let a = O::I32Load { memarg: mem(0, 2) };
        let b = O::I32Load { memarg: mem(16, 2) };
        let c = O::I32Load {
            memarg: mem(u64::MAX, 2),
        };
        assert_ne!(key(a.clone(), 4).unwrap(), key(b, 4).unwrap());
        assert_ne!(key(a, 4).unwrap(), key(c.clone(), 4).unwrap());
        assert_eq!(
            key(O::I32Load { memarg: mem(32, 2) }, 4).unwrap(),
            key(c, 4).unwrap()
        );
    }
    #[test]
    fn atomic_keys_never_change() {
        for mode in 0..6 {
            let a = O::I32AtomicRmwAdd { memarg: mem(32, 2) };
            assert_eq!(key(a.clone(), 0).unwrap(), key(a, mode).unwrap());
        }
    }
    #[test]
    fn lane_and_opcode_identity_remain() {
        let a = O::V128Load32Lane {
            memarg: mem(32, 1),
            lane: 0,
        };
        let b = O::V128Load32Lane {
            memarg: mem(64, 2),
            lane: 1,
        };
        assert_ne!(key(a, 3).unwrap(), key(b, 3).unwrap());
        assert_ne!(
            key(O::I32Load { memarg: mem(32, 2) }, 3).unwrap(),
            key(O::I32Store { memarg: mem(64, 2) }, 3).unwrap()
        );
    }
}
