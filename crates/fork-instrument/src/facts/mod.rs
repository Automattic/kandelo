//! Precise fork sinks from compiler facts.
//!
//! The SDK's KandeloCallTypes clang plugin writes, for every object it
//! compiles, a text description of the object's functions, call sites,
//! function-pointer conversions and untyped-pointer flow into a Wasm custom
//! section named [`SECTION`]. wasm-ld concatenates those sections in input
//! order, so a linked module carries one section made of per-object chunks.
//!
//! [`call_facts`] binds the module's functions to their chunks by order
//! ([`bind`]), applies the type rules (see `targets.rs`) and returns the
//! indirect-call targets, cleanup pairs and `jmp_buf` identity that
//! [`crate::sink::plan_with_facts`] uses in place of signature matching.
//! Functions without facts keep signature matching. The research that
//! derived these rules is `docs/plans/2026-10-02-fork-sinks.md`.
use anyhow::{Context, Result};
use walrus::Module;

use crate::sink::CallFacts;

pub mod bind;
mod codec;
mod side;
mod targets;

/// Name of the custom section that carries the facts.
pub const SECTION: &str = "kandelo.calltypes";

/// Name of the custom section that binds the facts to the linked code: 32
/// bytes, the SHA-256 of the code section's payload (the bytes after the
/// section id and size, starting at the function count) as the linker wrote
/// it. A tool that rewrites code between link and instrumentation (for
/// example a `wasm-opt` pass that inlines) keeps both custom sections but
/// changes the code, so the facts would describe the wrong functions; the
/// hash makes that visible.
pub const CODE_HASH_SECTION: &str = "kandelo.calltypes.code-sha256";

/// The facts a module carried, removed from it.
#[derive(Debug, Clone)]
pub struct TakenFacts {
    /// Concatenated payloads of every [`SECTION`].
    pub section: Vec<u8>,
    /// Payload of the [`CODE_HASH_SECTION`], if present.
    pub code_hash: Option<Vec<u8>>,
}

/// SHA-256 of the code section payload of `bytes` (empty input when the
/// module has no code section).
pub fn code_sha256(bytes: &[u8]) -> Result<[u8; 32]> {
    use sha2::{Digest, Sha256};
    use wasmparser::{Parser, Payload};
    for payload in Parser::new(0).parse_all(bytes) {
        if let Payload::CodeSectionStart { range, .. } = payload.context("parsing wasm sections")? {
            let code = bytes.get(range).context("code section range")?;
            return Ok(Sha256::digest(code).into());
        }
    }
    Ok(Sha256::digest([]).into())
}

/// Check that `taken` describes the code in `input` (the bytes the facts
/// were removed from). The error says why the facts must be ignored.
pub fn verify_code_hash(taken: &TakenFacts, input: &[u8]) -> Result<()> {
    let Some(recorded) = &taken.code_hash else {
        anyhow::bail!("facts ignored: the module has no {CODE_HASH_SECTION} section binding them to its code");
    };
    anyhow::ensure!(
        recorded.as_slice() == code_sha256(input)?.as_slice(),
        "facts ignored: the code changed after linking ({CODE_HASH_SECTION} does not match the code section)"
    );
    Ok(())
}

/// Rule switches.
#[derive(Clone, Copy, Debug)]
pub struct FactsOptions {
    /// Apply C's effective-type rule in units compiled with strict aliasing
    /// (the plugin's `AL` fact marks the others). `false` applies it nowhere.
    pub effective_types: bool,
}

impl Default for FactsOptions {
    fn default() -> Self {
        Self { effective_types: true }
    }
}

/// How much of the module the facts describe.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FactsReport {
    /// Objects that carried facts.
    pub chunks: usize,
    /// Function definitions the facts list (including ones the link removed).
    pub definitions: usize,
    /// Defined functions in the module.
    pub defined: usize,
    /// Defined functions bound to facts.
    pub bound: usize,
    /// Of those, functions bound to the union of several same-named
    /// definitions (see [`bind`]).
    pub bound_to_union: usize,
    /// Bound functions whose indirect call sites disagree with the facts
    /// (analysed without facts).
    pub signature_mismatch: usize,
}

/// Remove every [`SECTION`] and [`CODE_HASH_SECTION`] from `module`. Returns
/// the facts, or `None` when the module carries none.
pub fn take_section(module: &mut Module) -> Option<TakenFacts> {
    let mut section: Option<Vec<u8>> = None;
    while let Some(raw) = module.customs.remove_raw(SECTION) {
        section.get_or_insert_with(Vec::new).extend_from_slice(&raw.data);
    }
    let mut code_hash = None;
    while let Some(raw) = module.customs.remove_raw(CODE_HASH_SECTION) {
        code_hash = Some(raw.data);
    }
    section.map(|section| TakenFacts { section, code_hash })
}

/// `bytes` without any [`SECTION`] or [`CODE_HASH_SECTION`] custom section,
/// every other byte kept. Returns `None` when there is none.
pub fn strip_section(bytes: &[u8]) -> Result<Option<Vec<u8>>> {
    use wasmparser::{Parser, Payload};
    let mut cut: Vec<std::ops::Range<usize>> = vec![];
    for payload in Parser::new(0).parse_all(bytes) {
        if let Payload::CustomSection(section) = payload.context("parsing wasm sections")? {
            if section.name() == SECTION || section.name() == CODE_HASH_SECTION {
                // `range()` is the section content (name and data); the
                // section id byte and the content size precede it.
                // The size may be a padded LEB.
                let r = section.range();
                let start = (2..=6)
                    .filter_map(|h: usize| r.start.checked_sub(h))
                    .find(|&s| bytes[s] == 0 && read_leb(&bytes[s + 1..r.start]) == Some(r.len()))
                    .context("facts section header")?;
                cut.push(start..r.end);
            }
        }
    }
    if cut.is_empty() {
        return Ok(None);
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    for r in cut {
        out.extend_from_slice(&bytes[at..r.start]);
        at = r.end;
    }
    out.extend_from_slice(&bytes[at..]);
    Ok(Some(out))
}

/// The value of a LEB128 that spans exactly `b`.
fn read_leb(b: &[u8]) -> Option<usize> {
    let mut v = 0usize;
    for (i, &x) in b.iter().enumerate() {
        v |= ((x & 0x7f) as usize) << (7 * i);
        if x & 0x80 == 0 {
            return (i + 1 == b.len()).then_some(v);
        }
    }
    None
}

/// Bind `module`'s defined functions to the chunks in `section`.
///
/// Returns, per defined function in index order, its function index and
/// `Some((chunk, definition index within the chunk))` when bound.
pub fn binding(module: &Module, section: &[u8]) -> Result<Vec<(u32, Vec<(usize, usize)>)>> {
    let mut sigs = side::Interner::default();
    let parsed = parse(section, &mut sigs, true)?;
    let defined = targets::defined_functions(module);
    let bound = bind_defined(&defined, &parsed);
    Ok(defined.iter().zip(bound).map(|((f, _, _), b)| (*f, b)).collect())
}

fn parse(section: &[u8], sigs: &mut side::Interner, effective_types: bool) -> Result<side::Side> {
    let mut parsed = side::Side { effective_types, ..Default::default() };
    codec::visit_chunks(section, |i, chunk| {
        parsed.parse_chunk(chunk, sigs).with_context(|| format!("facts chunk {i}"))?;
        Ok(())
    })?;
    Ok(parsed)
}

fn bind_defined(defined: &[(u32, String, &[walrus::ValType])], parsed: &side::Side) -> Vec<Vec<(usize, usize)>> {
    let module_items: Vec<bind::Item> = defined
        .iter()
        .map(|(_, name, params)| bind::Item {
            name,
            nparams: params.len(),
            i64_params: params.iter().filter(|t| **t == walrus::ValType::I64).count(),
            first_is_i32: params.first() == Some(&walrus::ValType::I32),
            last_is_i32: params.last() == Some(&walrus::ValType::I32),
        })
        .collect();
    let chunks: Vec<Vec<bind::Item>> = parsed
        .chunks
        .iter()
        .map(|defs| defs.iter().map(|(name, f)| bind::Item { name, nparams: f.nparams, ..Default::default() }).collect())
        .collect();
    bind::bind(&module_items, &chunks)
}

/// Compute the facts-derived inputs of the sink analysis for `module` from
/// the payload of its [`SECTION`]. Fails, so the caller can fall back to
/// the analysis without facts, on anything this version cannot read.
pub fn call_facts(module: &Module, section: &[u8], opts: FactsOptions) -> Result<(CallFacts, FactsReport)> {
    let mut sigs = side::Interner::default();
    let parsed = parse(section, &mut sigs, opts.effective_types)?;
    let w = targets::load_wasm(module, &mut sigs);
    let defined = targets::defined_functions(module);
    let bound = bind_defined(&defined, &parsed);
    let mut cands: Vec<Vec<&side::IrFn>> = vec![vec![]; w.names.len()];
    for ((f, _, _), b) in defined.iter().zip(&bound) {
        cands[*f as usize] = b.iter().map(|&(c, d)| &parsed.chunks[c][d].1).collect();
    }
    let rules = targets::Rules { cleanup_lexical: true, casts: true, slots: true, sigaction_old: true };
    let graph = targets::build_graph(&w, &parsed, &cands, &rules);
    let mut seen = std::collections::HashSet::new();
    let jmp: Vec<String> = parsed.jmp_facts.iter().filter(|l| seen.insert(l.as_str())).cloned().collect();
    let facts = CallFacts { itargets: graph.export_targets(&sigs), cleanup: graph.cleanup_pairs(), jmp, assume_dlopen_contract: false };
    let report = FactsReport {
        chunks: parsed.chunks.len(),
        definitions: parsed.chunks.iter().map(|c| c.len()).sum(),
        defined: defined.len(),
        bound: bound.iter().filter(|b| !b.is_empty()).count(),
        bound_to_union: bound.iter().filter(|b| b.len() > 1).count(),
        signature_mismatch: defined.iter().filter(|(f, _, _)| graph.view[*f as usize] == targets::View::Mismatch).count(),
    };
    Ok((facts, report))
}
