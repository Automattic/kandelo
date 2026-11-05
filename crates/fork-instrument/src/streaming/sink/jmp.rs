//! Sparse per-buffer SjLj masks. Buffer names remain interned in the store.

use std::collections::BTreeMap;

use anyhow::{Result, ensure};
use wasmparser::Operator;

use super::{Program, Tags};
use crate::streaming::IrLimits;

#[derive(Clone, Copy, Debug, Default)]
struct Buffers {
    bits: Tags,
    wildcard: bool,
    unknown: bool,
}

pub(super) struct JmpPlan {
    tag: u32,
    all: Tags,
    rethrow: Tags,
    js: BTreeMap<u32, Buffers>,
    jl: BTreeMap<u32, Buffers>,
}

pub(super) fn is_longjmp(name: &str) -> bool {
    matches!(
        name,
        "longjmp" | "_longjmp" | "siglongjmp" | "__wasm_longjmp"
    )
}

impl JmpPlan {
    pub(super) fn buffer_bits(&self) -> Tags {
        self.all
    }
    pub(super) fn build(program: &Program<'_, '_>, ir_limits: IrLimits) -> Result<Option<Self>> {
        if !program.store.calls_ready.get()
            || program.original_scan().types.as_ref().tag_count() > 40
        {
            return Ok(None);
        }
        program.store.charge_work(1)?;
        let facts: bool =
            program
                .store
                .db
                .query_row("SELECT EXISTS(SELECT 1 FROM jmp)", [], |r| r.get(0))?;
        if !facts {
            return Ok(None);
        }
        let mut provider = program.original_scan().body_provider(ir_limits);
        let mut tag = None;
        for (index, function) in program.original_scan().functions.iter().enumerate() {
            if function.name.as_deref() != Some("__wasm_longjmp") || function.body.is_none() {
                continue;
            }
            let body = provider.load(index as u32)?;
            for instruction in &body.instructions {
                if let Operator::Throw { tag_index } = instruction.operation {
                    if tag.is_some_and(|t| t != tag_index) {
                        return Ok(None);
                    }
                    tag = Some(tag_index);
                }
            }
        }
        let Some(tag) = tag else {
            return Ok(None);
        };
        let mut output = Self {
            tag,
            all: 0,
            rethrow: 0,
            js: BTreeMap::new(),
            jl: BTreeMap::new(),
        };
        let mut bits = BTreeMap::new();
        let mut next = 40u32;
        let mut query = program
            .store
            .db
            .prepare("SELECT line FROM jmp ORDER BY sequence")?;
        let mut rows = query.query([])?;
        while let Some(row) = rows.next()? {
            let text = row.get_ref(0)?.as_str()?;
            let mut fields = text.split('\t');
            let (Some(kind), Some(function), Some(buffer)) =
                (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            if !matches!(kind, "JS" | "JL") {
                continue;
            }
            let buffer_id = program.store.atom(buffer)?;
            if buffer != "*" && !bits.contains_key(&buffer_id) && next < 62 {
                bits.insert(buffer_id, 1u64 << next);
                next += 1;
            }
            let bit = bits.get(&buffer_id).copied();
            let Some(name) = program.store.find_atom(function)? else {
                continue;
            };
            program.store.charge_work(1)?;
            let mut functions = program
                .store
                .db
                .prepare_cached("SELECT id FROM wasm_function WHERE name=? ORDER BY id")?;
            let mut functions = functions.query([name])?;
            while let Some(row) = functions.next()? {
                let function: u32 = row.get(0)?;
                let exists = if kind == "JS" {
                    output.js.contains_key(&function)
                } else {
                    output.jl.contains_key(&function)
                };
                let size = output
                    .js
                    .len()
                    .saturating_add(output.jl.len())
                    .saturating_add(usize::from(!exists));
                ensure!(
                    size <= program.limits.metadata_bytes.saturating_sub(22 * 64) / 128,
                    "jmp masks exceed resident metadata budget"
                );
                let map = if kind == "JS" {
                    &mut output.js
                } else {
                    &mut output.jl
                };
                let entry = map.entry(function).or_default();
                entry.bits |= bit.unwrap_or(0);
                entry.wildcard |= buffer == "*";
                entry.unknown |= bit.is_none();
            }
        }
        output.all = bits.values().copied().fold(0, |a, b| a | b);
        let mut unknown = false;
        for (index, function) in program.original_scan().functions.iter().enumerate() {
            if !function.name.as_deref().is_some_and(is_longjmp) {
                continue;
            }
            unknown |= program.functions[index].escaping;
            for caller in program.direct_callers(index as u32)? {
                if program.original_scan().functions[caller as usize]
                    .name
                    .as_deref()
                    .is_some_and(is_longjmp)
                {
                    continue;
                }
                let source = output.jl.get(&caller);
                let known = source.is_some_and(|b| !b.unknown);
                unknown |= !known && (source.is_some() || !output.js.contains_key(&caller));
            }
        }
        output.rethrow = output.all | if unknown { 1u64 << tag } else { 0 };
        Ok(Some(output))
    }

    pub(super) fn catch_bits(&self, function: u32, tag: u32) -> Tags {
        let generic = 1u64 << tag.min(63);
        if tag != self.tag {
            return generic;
        }
        generic
            | match self.js.get(&function) {
                Some(buffers) if !buffers.wildcard => buffers.bits,
                _ => self.all,
            }
    }

    pub(super) fn remap(
        &self,
        program: &Program<'_, '_>,
        function: u32,
        targets: &[u32],
        external: bool,
        thrown: Tags,
    ) -> Tags {
        let generic = 1u64 << self.tag;
        if external
            || thrown & generic == 0
            || targets.is_empty()
            || !targets.iter().all(|t| {
                program
                    .original_scan()
                    .functions
                    .get(*t as usize)
                    .and_then(|f| f.name.as_deref())
                    .is_some_and(is_longjmp)
            })
        {
            return thrown;
        }
        let source = match self.jl.get(&function) {
            Some(buffers) if !buffers.unknown => buffers.bits,
            Some(_) => generic,
            None if self.js.contains_key(&function) => 0,
            None => return thrown,
        };
        (thrown & !generic)
            | source
            | if self.js.contains_key(&function) {
                self.rethrow
            } else {
                0
            }
    }
}
