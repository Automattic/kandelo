//! Opt-in bridge for facts-preserving Binaryen inlining.
//!
//! Resolve source facts while they still bind, attach conservative target sets
//! to actual call instructions, then rebuild facts from the optimizer's mapped
//! annotations. The supported optimizer rejects unaudited passes. This does not
//! authorize arbitrary code rewrites or restamping stale compiler facts.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;

use anyhow::{Context, Result, bail, ensure};
use wasmparser::{CompositeInnerType, FuncType, Operator, Parser, Payload, TypeRef, ValType};

use crate::{Options, facts};

pub const SECTION: &str = "metadata.code.kandelo.fork-targets";
pub(crate) const RESOLVED_PREFIX: &str = "#kandelo-calltypes\t5\n#kandelo-preinline-targets-v1\n";

#[derive(Debug)]
struct Site {
    offset: u32,
    signature: String,
}

#[derive(Debug)]
struct Function {
    imported: bool,
    params: usize,
    sites: Vec<Site>,
}

fn signature(ty: &FuncType) -> String {
    let part = |types: &[ValType]| {
        types
            .iter()
            .map(|ty| match ty {
                ValType::I32 => "i32",
                ValType::I64 => "i64",
                ValType::F32 => "f32",
                ValType::F64 => "f64",
                ValType::V128 => "v128",
                ValType::Ref(_) => "ref",
            })
            .collect::<Vec<_>>()
            .join(",")
    };
    format!("{}->{}", part(ty.params()), part(ty.results()))
}

fn functions(input: &[u8]) -> Result<Vec<Function>> {
    let mut types = Vec::new();
    let mut type_indices = Vec::new();
    let mut imported = 0;
    let mut result = Vec::new();
    for payload in Parser::new(0).parse_all(input) {
        match payload? {
            Payload::TypeSection(groups) => {
                for group in groups {
                    for sub in group?.into_types() {
                        let CompositeInnerType::Func(ty) = sub.composite_type.inner else {
                            bail!("fork pre-inlining does not yet support GC types");
                        };
                        types.push(ty);
                    }
                }
            }
            Payload::ImportSection(imports) => {
                for import in imports.into_imports() {
                    if let TypeRef::Func(ty) | TypeRef::FuncExact(ty) = import?.ty {
                        type_indices.push(ty);
                        imported += 1;
                    }
                }
                for &ty in &type_indices {
                    result.push(Function {
                        imported: true,
                        params: types[ty as usize].params().len(),
                        sites: vec![],
                    });
                }
            }
            Payload::FunctionSection(reader) => {
                for ty in reader {
                    type_indices.push(ty?);
                }
            }
            Payload::CodeSectionEntry(body) => {
                let base = body.range().start;
                let ty = type_indices[result.len()];
                let mut function = Function {
                    imported: false,
                    params: types[ty as usize].params().len(),
                    sites: vec![],
                };
                let mut ops = body.get_operators_reader()?;
                while !ops.eof() {
                    let offset = u32::try_from(ops.original_position() - base)?;
                    match ops.read()? {
                        Operator::CallIndirect { type_index, .. }
                        | Operator::ReturnCallIndirect { type_index, .. } => {
                            function.sites.push(Site {
                                offset,
                                signature: signature(&types[type_index as usize]),
                            });
                        }
                        _ => {}
                    }
                }
                result.push(function);
            }
            _ => {}
        }
    }
    ensure!(
        result.len() == type_indices.len() && result.iter().take(imported).all(|f| f.imported),
        "incomplete function layout"
    );
    Ok(result)
}

fn put(out: &mut Vec<u8>, mut value: u32) {
    loop {
        let byte = (value & 127) as u8;
        value >>= 7;
        out.push(byte | if value != 0 { 128 } else { 0 });
        if value == 0 {
            return;
        }
    }
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn number(&mut self) -> Result<u32> {
        let mut result = 0;
        for shift in (0..35).step_by(7) {
            let byte = *self
                .data
                .get(self.pos)
                .context("truncated annotation integer")?;
            self.pos += 1;
            ensure!(shift != 28 || byte < 16, "overflowing annotation integer");
            result |= u32::from(byte & 127) << shift;
            if byte < 128 {
                return Ok(result);
            }
        }
        bail!("overflowing annotation integer")
    }
    fn bytes(&mut self, size: usize) -> Result<&'a [u8]> {
        let end = self
            .pos
            .checked_add(size)
            .context("annotation length overflow")?;
        let data = self
            .data
            .get(self.pos..end)
            .context("truncated annotation payload")?;
        self.pos = end;
        Ok(data)
    }
    fn done(&self) -> bool {
        self.pos == self.data.len()
    }
}

fn custom(name: &str, data: &[u8]) -> Result<Vec<u8>> {
    let mut payload = Vec::new();
    put(&mut payload, u32::try_from(name.len())?);
    payload.extend_from_slice(name.as_bytes());
    payload.extend_from_slice(data);
    let mut out = vec![0];
    put(&mut out, u32::try_from(payload.len())?);
    out.extend(payload);
    Ok(out)
}

fn strip_custom(input: &[u8], remove: impl Fn(&[u8]) -> bool) -> Result<Vec<u8>> {
    let mut out = input[..8].to_vec();
    let mut reader = Reader::new(&input[8..]);
    while !reader.done() {
        let start = reader.pos;
        let kind = reader.bytes(1)?[0];
        let size = reader.number()? as usize;
        let payload = reader.bytes(size)?;
        let discard = if kind == 0 {
            let mut section = Reader::new(payload);
            let size = section.number()? as usize;
            remove(section.bytes(size)?)
        } else {
            false
        };
        if !discard {
            out.extend_from_slice(&input[8 + start..8 + reader.pos]);
        }
    }
    Ok(out)
}

fn annotate(out: &mut Vec<u8>, offset: u32, values: &[u32]) -> Result<()> {
    put(out, offset);
    let mut payload = vec![];
    for &value in values {
        put(&mut payload, value);
    }
    put(out, u32::try_from(payload.len())?);
    out.extend(payload);
    Ok(())
}

/// Validate and resolve the original facts without changing any code bytes.
pub fn prepare(input: &[u8], opts: &Options) -> Result<Vec<u8>> {
    ensure!(
        opts.facts && opts.sinks && opts.entry_import == "kernel.kernel_fork",
        "pre-inlining requires the default entry, facts and sink analysis"
    );
    let mut module = walrus::ModuleConfig::new().parse(input)?;
    ensure!(
        crate::call_graph::find_import_funcs(&module, "kernel.kernel_fork").len() == 1,
        "pre-inlining requires one kernel.kernel_fork import"
    );
    ensure!(
        !module.memories.iter().any(|m| m.memory64),
        "pre-inlining requires wasm32"
    );
    ensure!(
        !module
            .customs
            .iter()
            .any(|(_, s)| s.name() == "dylink.0" || s.name() == SECTION),
        "pre-inlining requires an unprocessed main module"
    );
    let taken = facts::take_section(&mut module).context("pre-inlining requires compiler facts")?;
    facts::verify_code_hash(&taken, input)?;
    let (resolved, report) = facts::preopt_call_facts(
        &module,
        &taken.section,
        facts::FactsOptions {
            effective_types: opts.effective_types,
        },
    )?;
    ensure!(
        report.bound != 0,
        "pre-inlining facts did not bind any functions"
    );
    eprintln!(
        "wasm-fork-instrument: pre-inlining source facts bound {}/{} functions",
        report.bound, report.defined
    );
    let layout = functions(input)?;
    let targets: BTreeMap<_, _> = resolved
        .itargets
        .into_iter()
        .map(|(f, sig, targets)| ((f, sig), targets))
        .collect();
    let mut payload = vec![];
    put(&mut payload, u32::try_from(layout.len())?);
    for (index, function) in layout.iter().enumerate() {
        let index = u32::try_from(index)?;
        put(&mut payload, index);
        let known: Vec<_> = function
            .sites
            .iter()
            .filter_map(|site| {
                // The cleanup dispatcher is context-sensitive in ordinary facts.
                // preopt_call_facts explicitly resolves its full registered set.
                targets
                    .get(&(index, site.signature.clone()))
                    .map(|set| (site, set))
            })
            .collect();
        put(&mut payload, u32::try_from(known.len() + 1)?);
        annotate(&mut payload, 0, &[0, index])?;
        for (site, set) in known {
            let mut values = vec![1];
            values.extend(set);
            annotate(&mut payload, site.offset, &values)?;
        }
    }
    let stripped = facts::strip_section(input)?.context("compiler facts disappeared")?;
    // The instrumenter does not ship DWARF. Remove it before moving code,
    // preserving code bytes, Wasm names, and runtime custom sections.
    let stripped = strip_custom(&stripped, |name| {
        name.starts_with(b".debug_") || name.starts_with(b".zdebug_")
    })?;
    // Code metadata must precede code. Locate the complete code-section header.
    let mut reader = Reader::new(&stripped[8..]);
    let mut insertion = None;
    while !reader.done() {
        let start = 8 + reader.pos;
        let kind = reader.bytes(1)?[0];
        let size = reader.number()? as usize;
        reader.bytes(size)?;
        if kind == 10 {
            insertion = Some(start);
            break;
        }
    }
    let insertion = insertion.context("pre-inlining input has no code section")?;
    let mut out = stripped[..insertion].to_vec();
    out.extend(custom(SECTION, &payload)?);
    out.extend_from_slice(&stripped[insertion..]);
    Ok(out)
}

type Annotations = BTreeMap<(u32, u32), Vec<u32>>;

fn read_annotations(input: &[u8], layout: &[Function]) -> Result<Annotations> {
    let mut annotations = None;
    for payload in Parser::new(0).parse_all(input) {
        if let Payload::CustomSection(section) = payload? {
            if section.name() != SECTION {
                continue;
            }
            ensure!(
                annotations.is_none(),
                "duplicate fork-target annotation section"
            );
            let mut reader = Reader::new(section.data());
            let mut entries = BTreeMap::new();
            let mut seen_functions = BTreeSet::new();
            let count = reader.number()?;
            ensure!(
                count as usize <= layout.len(),
                "too many annotated functions"
            );
            for _ in 0..count {
                let function = reader.number()?;
                ensure!(
                    seen_functions.insert(function),
                    "duplicate annotated function"
                );
                let body = layout
                    .get(function as usize)
                    .context("invalid annotation function")?;
                let count = reader.number()?;
                ensure!(
                    count as usize <= body.sites.len() + 1,
                    "too many call annotations"
                );
                for _ in 0..count {
                    let offset = reader.number()?;
                    ensure!(
                        offset == 0 || body.sites.iter().any(|s| s.offset == offset),
                        "annotation does not identify an indirect call"
                    );
                    let size = reader.number()? as usize;
                    let mut payload = Reader::new(reader.bytes(size)?);
                    let mut values = vec![];
                    while !payload.done() {
                        values.push(payload.number()?);
                    }
                    ensure!(
                        values.first() == Some(&u32::from(offset != 0)),
                        "wrong annotation kind"
                    );
                    ensure!(
                        offset != 0 || values.len() == 2,
                        "invalid function identity annotation"
                    );
                    ensure!(
                        entries.insert((function, offset), values).is_none(),
                        "duplicate instruction annotation"
                    );
                }
            }
            ensure!(reader.done(), "trailing annotation bytes");
            annotations = Some(entries);
        }
    }
    annotations.context("optimizer did not preserve fork-target annotations")
}

/// Build fresh format-5 facts describing the optimized code. Lexical cleanup
/// and jmp_buf identities are not carried; those analyses fall back rather
/// than reusing facts about the old function scopes.
pub fn finish(input: &[u8]) -> Result<Vec<u8>> {
    let module = walrus::ModuleConfig::new().parse(input)?;
    let layout = functions(input)?;
    let annotations = read_annotations(input, &layout)?;
    let names: Vec<_> = module
        .funcs
        .iter()
        .map(|f| f.name.clone().unwrap_or_default())
        .collect();
    ensure!(names.len() == layout.len(), "function identity mismatch");
    ensure!(
        names.iter().all(|n| !n.contains(['\t', '\r', '\n'])),
        "unrepresentable function name"
    );
    let mut identities = BTreeMap::new();
    for (&(function, offset), values) in &annotations {
        if offset == 0 {
            ensure!(
                identities.insert(values[1], function).is_none(),
                "duplicated optimizer function identity"
            );
        }
    }
    let mut memberships: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); layout.len()];
    let mut sets = BTreeMap::<Vec<u32>, usize>::new();
    let mut sites = BTreeMap::new();
    for (function, body) in layout.iter().enumerate() {
        for site in &body.sites {
            let Some(values) = annotations.get(&(function as u32, site.offset)) else {
                continue;
            };
            let mapped: Option<Vec<u32>> = values[1..]
                .iter()
                .map(|id| identities.get(id).copied())
                .collect();
            // A missing target may have been transformed in an unsupported
            // way. Widen this call; never silently remove that possible edge.
            let Some(mut mapped) = mapped else {
                continue;
            };
            mapped.sort_unstable();
            mapped.dedup();
            let next = sets.len();
            let set = *sets.entry(mapped.clone()).or_insert(next);
            for target in mapped {
                memberships[target as usize].insert(set);
            }
            sites.insert((function, site.offset), set);
        }
    }
    let total_sites: usize = layout.iter().map(|f| f.sites.len()).sum();
    eprintln!(
        "wasm-fork-instrument: pre-inlining retained {}/{total_sites} call target sets; lexical cleanup and jmp_buf refinements use conservative fallback",
        sites.len()
    );
    let mut text = String::from(RESOLVED_PREFIX);
    text.push_str("M\tkandelo-preinline\n");
    for (index, body) in layout.iter().enumerate() {
        if body.imported {
            continue;
        }
        let name = &names[index];
        writeln!(text, "F\t{name}\t{}\tE\t1\t{name}", body.params)?;
        for set in &memberships[index] {
            writeln!(text, "T\t{name}\tkandelo-preinline-{set}")?;
        }
        for (ordinal, site) in body.sites.iter().enumerate() {
            if let Some(set) = sites.get(&(index, site.offset)) {
                writeln!(
                    text,
                    "S\t{name}\t{ordinal}\t{}\ticall\tkandelo-preinline-{set}",
                    site.signature
                )?;
            } else {
                writeln!(text, "S\t{name}\t{ordinal}\t{}\tuntyped", site.signature)?;
            }
        }
        writeln!(
            text,
            "D\t{name}\t{}\t{}",
            body.sites.len(),
            body.sites.len()
        )?;
    }
    let mut out = strip_custom(input, |name| {
        [SECTION, facts::SECTION, facts::CODE_HASH_SECTION]
            .iter()
            .any(|s| name == s.as_bytes())
    })?;
    out.extend(custom(facts::SECTION, text.as_bytes())?);
    out.extend(custom(
        facts::CODE_HASH_SECTION,
        &facts::code_sha256(&out)?,
    )?);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PlanSource, sink_report};

    const WAT: &str = r#"(module
      (type $t (func (param i32) (result i32)))
      (import "kernel" "kernel_fork" (func $kernel_fork (type $t)))
      (memory 1) (table 2 funcref)
      (elem (i32.const 0) $forker $other)
      (func $forker (type $t) (call $kernel_fork (i32.const 0)))
      (func $other (type $t) (local.get 0))
      (func $main (type $t)
        (call_indirect (type $t) (local.get 0) (local.get 0)))
      (func $_start (export "_start")
        (drop (call $main (i32.load (i32.const 0))))))"#;

    const FACTS: &str = "#kandelo-calltypes\t5\nM\tpreopt-test.c\n\
F\tforker\t1\nT\tforker\tother-type\nC\tforker\t0\tkernel_fork\nD\tforker\t0\t1\n\
F\tother\t1\nT\tother\tint-type\nD\tother\t0\t0\n\
F\tmain\t1\nS\tmain\t0\ti32->i32\ticall\tint-type\nD\tmain\t1\t1\n\
F\t_start\t0\nC\t_start\t0\tmain\nD\t_start\t0\t1\n";

    fn linked() -> Vec<u8> {
        let mut input = wat::parse_str(WAT).unwrap();
        input.extend(custom(facts::SECTION, FACTS.as_bytes()).unwrap());
        input.extend(
            custom(
                facts::CODE_HASH_SECTION,
                &facts::code_sha256(&input).unwrap(),
            )
            .unwrap(),
        );
        input
    }

    // Rebuild the private transport section after intentionally deleting or
    // damaging an entry. No optimizer is involved in these fallback tests.
    fn changed(prepared: &[u8], edit: impl FnOnce(&mut Annotations)) -> Vec<u8> {
        let layout = functions(prepared).unwrap();
        let mut entries = read_annotations(prepared, &layout).unwrap();
        edit(&mut entries);
        let mut groups: BTreeMap<u32, Vec<(u32, Vec<u32>)>> = BTreeMap::new();
        for ((function, offset), values) in entries {
            groups.entry(function).or_default().push((offset, values));
        }
        let mut payload = vec![];
        put(&mut payload, groups.len() as u32);
        for (function, entries) in groups {
            put(&mut payload, function);
            put(&mut payload, entries.len() as u32);
            for (offset, values) in entries {
                annotate(&mut payload, offset, &values).unwrap();
            }
        }
        let mut out = prepared[..8].to_vec();
        let mut reader = Reader::new(&prepared[8..]);
        while !reader.done() {
            let start = reader.pos;
            let kind = reader.bytes(1).unwrap()[0];
            let size = reader.number().unwrap() as usize;
            let data = reader.bytes(size).unwrap();
            let remove = if kind == 0 {
                let mut r = Reader::new(data);
                let n = r.number().unwrap() as usize;
                r.bytes(n).unwrap() == SECTION.as_bytes()
            } else {
                false
            };
            if !remove {
                out.extend_from_slice(&prepared[8 + start..8 + reader.pos]);
            }
        }
        out.extend(custom(SECTION, &payload).unwrap());
        out
    }

    #[test]
    fn resolves_and_rebuilds_facts_without_changing_code() {
        let mut input = linked();
        input.extend(custom(".debug_info", b"temporary debug input").unwrap());
        input.extend(custom("kandelo.test-runtime", b"keep me").unwrap());
        let prepared = prepare(&input, &Options::default()).unwrap();
        let prepared_module = walrus::ModuleConfig::new().parse(&prepared).unwrap();
        assert!(
            prepared_module
                .customs
                .iter()
                .all(|(_, s)| s.name() != ".debug_info")
        );
        assert!(
            prepared_module
                .customs
                .iter()
                .any(|(_, s)| s.name() == "kandelo.test-runtime")
        );
        let output = finish(&prepared).unwrap();
        assert_eq!(
            facts::code_sha256(&input).unwrap(),
            facts::code_sha256(&output).unwrap()
        );
        let before = sink_report(&input, &Options::default()).unwrap();
        let after = sink_report(&output, &Options::default()).unwrap();
        assert_eq!(after.source, PlanSource::Facts);
        assert_eq!(before.instrumented, after.instrumented);
        assert!(!after.instrumented.iter().any(|name| name == "main"));
        let mut module = walrus::ModuleConfig::new().parse(&output).unwrap();
        let taken = facts::take_section(&mut module).unwrap();
        facts::verify_code_hash(&taken, &output).unwrap();
        assert!(module.customs.iter().all(|(_, s)| s.name() != SECTION));
    }

    #[test]
    fn missing_call_annotation_widens_the_call() {
        let prepared = prepare(&linked(), &Options::default()).unwrap();
        let altered = changed(&prepared, |entries| {
            entries.retain(|(_, offset), _| *offset == 0)
        });
        let report = sink_report(&finish(&altered).unwrap(), &Options::default()).unwrap();
        assert!(report.instrumented.iter().any(|name| name == "main"));
    }

    #[test]
    fn known_empty_target_set_is_distinct_from_missing_metadata() {
        let prepared = prepare(&linked(), &Options::default()).unwrap();
        let altered = changed(&prepared, |entries| {
            for ((_, offset), values) in entries.iter_mut() {
                if *offset != 0 {
                    *values = vec![1];
                }
            }
        });
        let report = sink_report(&finish(&altered).unwrap(), &Options::default()).unwrap();
        assert!(!report.instrumented.iter().any(|name| name == "main"));
    }

    #[test]
    fn missing_target_identity_widens_instead_of_dropping_a_target() {
        let prepared = prepare(&linked(), &Options::default()).unwrap();
        let altered = changed(&prepared, |entries| {
            for ((_, offset), values) in entries.iter_mut() {
                if *offset != 0 {
                    *values = vec![1, u32::MAX];
                }
            }
        });
        let report = sink_report(&finish(&altered).unwrap(), &Options::default()).unwrap();
        assert!(report.instrumented.iter().any(|name| name == "main"));
    }

    #[test]
    fn malformed_annotation_and_stale_source_facts_fail() {
        let prepared = prepare(&linked(), &Options::default()).unwrap();
        let bad = changed(&prepared, |entries| {
            for ((_, offset), values) in entries.iter_mut() {
                if *offset != 0 {
                    *values = vec![0, 7];
                }
            }
        });
        assert!(finish(&bad).is_err());
        let mut stale = linked();
        stale.extend(custom(facts::CODE_HASH_SECTION, &[0; 32]).unwrap());
        assert!(prepare(&stale, &Options::default()).is_err());
        assert!(
            prepare(
                &linked(),
                &Options {
                    facts: false,
                    ..Options::default()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn cleanup_dispatch_keeps_handlers_when_lexical_scope_is_not_transported() {
        let wat = r#"(module
          (type $h (func (param i32)))
          (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
          (memory 1) (table 2 funcref)
          (elem (i32.const 0) $fork_handler $other)
          (func $fork_handler (type $h) (drop (call $fork (i32.const 0))))
          (func $other (type $h))
          (func $_pthread_cleanup_pop (param i32)
            (call_indirect (type $h) (local.get 0) (i32.load (i32.const 0))))
          (func $_start (export "_start") (call $_pthread_cleanup_pop (i32.const 1))))"#;
        let text = "#kandelo-calltypes\t5\nM\tthread/pthread_cleanup_push.c\n\
R\tcleanup\tfork_handler\nR\tcleanup\tother\n\
F\tfork_handler\t1\nT\tfork_handler\t_ZTSFvPvE\nC\tfork_handler\t0\tfork\nD\tfork_handler\t0\t1\n\
F\tother\t1\nT\tother\t_ZTSFvPvE\nD\tother\t0\t0\n\
F\t_pthread_cleanup_pop\t1\nS\t_pthread_cleanup_pop\t0\ti32->\ticall\t_ZTSFvPvE\nD\t_pthread_cleanup_pop\t1\t1\n\
F\t_start\t0\nC\t_start\t0\t_pthread_cleanup_pop\nD\t_start\t0\t1\n";
        let mut input = wat::parse_str(wat).unwrap();
        input.extend(custom(facts::SECTION, text.as_bytes()).unwrap());
        input.extend(
            custom(
                facts::CODE_HASH_SECTION,
                &facts::code_sha256(&input).unwrap(),
            )
            .unwrap(),
        );
        let output = finish(&prepare(&input, &Options::default()).unwrap()).unwrap();
        let mut module = walrus::ModuleConfig::new().parse(&output).unwrap();
        let taken = facts::take_section(&mut module).unwrap();
        let (resolved, _) =
            facts::call_facts(&module, &taken.section, facts::FactsOptions::default()).unwrap();
        let dispatcher = module
            .funcs
            .iter()
            .find(|f| f.name.as_deref() == Some("_pthread_cleanup_pop"))
            .unwrap()
            .id()
            .index() as u32;
        let handler = module
            .funcs
            .iter()
            .find(|f| f.name.as_deref() == Some("fork_handler"))
            .unwrap()
            .id()
            .index() as u32;
        assert!(
            resolved
                .itargets
                .iter()
                .any(|(f, _, targets)| *f == dispatcher && targets.contains(&handler))
        );
        assert!(
            resolved.cleanup.is_empty(),
            "old caller scopes must not become empty-handler overrides"
        );
    }
}
