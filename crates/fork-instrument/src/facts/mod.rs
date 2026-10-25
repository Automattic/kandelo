//! Compiler facts bound to original Wasm coordinates and stored in private relations.
//!
//! The SDK Clang plugin writes per-object function, call, conversion and pointer
//! flow records. wasm-ld concatenates those chunks. The linked code hash binds
//! them to the exact source instructions; indexed file-backed relations resolve
//! targets without retaining the expanded module or fact graph.

use anyhow::{Context, Result};

use crate::sink::CallFacts;

pub mod bind;
mod calls;
mod codec;
pub mod definitions;
mod flow;
mod side;
pub mod storage;
pub mod stream;
mod target_cache;
mod targets;

pub(crate) use targets::visit_retained_operators;

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

/// Rule switches.
#[derive(Clone, Copy, Debug)]
pub struct FactsOptions {
    /// Apply C's effective-type rule in units compiled with strict aliasing
    /// (the plugin's `AL` fact marks the others). `false` applies it nowhere.
    pub effective_types: bool,
}

impl Default for FactsOptions {
    fn default() -> Self {
        Self {
            effective_types: true,
        }
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

/// Resolve compiler call-target relations using native serial summaries and
/// private file-backed relations. No expanded module instruction or facts graph is built.
/// This compatibility projection has a resident-size limit; the native sink
/// planner can use [`storage::FactsStore::targets_for`] without collecting
/// the module's complete target matrix.
pub fn call_facts_from_scan(
    scan: &crate::streaming::Scan<'_>,
    opts: FactsOptions,
) -> Result<(CallFacts, FactsReport)> {
    let store = storage::FactsStore::from_scan(scan, storage::StorageLimits::default())?;
    let report = store.resolve_calls(scan, opts)?;
    let facts = store.collect_call_facts()?;
    Ok((facts, report))
}
