//! Declare the Wasm features an instrumented module uses.
//!
//! The `target_features` custom section lists the features a module was
//! built with (`+name`) or must not use (`-name`). LLVM writes it at link
//! time, and Binaryen's `wasm-opt` enables exactly the features it lists:
//! a module that uses an undeclared feature fails validation there.
//!
//! WHY scan the output instead of listing what the transform adds: the
//! generated code depends on the input. Shared memories get atomic table
//! generation guards, exception codecs return tuples, GC codecs appear only
//! for modules with GC references. A fixed list drifts from the generator;
//! a scan of the emitted bytes cannot. The scan also covers inputs that never
//! declared their own features (hand-written test modules), which a later
//! wasm-opt pass would otherwise reject.

use std::collections::BTreeSet;

use anyhow::{Context, Result, bail, ensure};
use wasmparser::{
    BlockType, CompositeInnerType, ExternalKind, HeapType, Operator, Parser, Payload, RefType,
    TypeRef, ValType,
};

const SECTION: &str = "target_features";

/// Rewrite `module` so its `target_features` section declares every feature
/// the module uses, keeping every entry it already had.
pub fn declare_used_features(module: Vec<u8>) -> Result<Vec<u8>> {
    let used = used_features(&module)?;
    let mut entries = declared_entries(&module)?;
    for feature in used {
        match entries.iter().find(|(_, name)| name == feature) {
            Some((b'-', _)) => {
                bail!("module disallows the `{feature}` feature, which its instrumented code uses")
            }
            Some(_) => {}
            None => entries.push((b'+', feature.to_owned())),
        }
    }
    let mut payload = Vec::new();
    write_u32(&mut payload, entries.len() as u32);
    for (prefix, name) in &entries {
        payload.push(*prefix);
        write_u32(&mut payload, name.len() as u32);
        payload.extend_from_slice(name.as_bytes());
    }
    replace_custom_section(&module, SECTION, &payload)
}

/// The `target_features` names of the features `module` uses.
pub fn used_features(module: &[u8]) -> Result<BTreeSet<&'static str>> {
    let mut used = BTreeSet::new();
    let mut memories = 0usize;
    let mut tables = 0usize;
    for payload in Parser::new(0).parse_all(module) {
        match payload? {
            Payload::TypeSection(reader) => {
                for group in reader {
                    for sub in group?.into_types() {
                        match &sub.composite_type.inner {
                            CompositeInnerType::Func(func) => {
                                if func.results().len() > 1 {
                                    used.insert("multivalue");
                                }
                                for ty in func.params().iter().chain(func.results()) {
                                    value_type(*ty, &mut used);
                                }
                            }
                            // Struct, array and continuation types exist only
                            // under GC (or later) proposals.
                            _ => {
                                used.insert("gc");
                                used.insert("reference-types");
                            }
                        }
                    }
                }
            }
            Payload::ImportSection(reader) => {
                for import in reader.into_imports() {
                    match import?.ty {
                        TypeRef::Memory(memory) => {
                            memories += 1;
                            memory_type(memory.shared, memory.memory64, &mut used);
                        }
                        TypeRef::Table(table) => {
                            tables += 1;
                            table_type(table.element_type, table.table64, &mut used);
                        }
                        TypeRef::Global(global) => {
                            if global.mutable {
                                used.insert("mutable-globals");
                            }
                            value_type(global.content_type, &mut used);
                        }
                        TypeRef::Tag(_) => {
                            used.insert("exception-handling");
                        }
                        TypeRef::Func(_) | TypeRef::FuncExact(_) => {}
                    }
                }
            }
            Payload::MemorySection(reader) => {
                for memory in reader {
                    let memory = memory?;
                    memories += 1;
                    memory_type(memory.shared, memory.memory64, &mut used);
                }
            }
            Payload::TableSection(reader) => {
                for table in reader {
                    let table = table?;
                    tables += 1;
                    table_type(table.ty.element_type, table.ty.table64, &mut used);
                }
            }
            Payload::TagSection(_) => {
                used.insert("exception-handling");
            }
            Payload::GlobalSection(reader) => {
                for global in reader {
                    value_type(global?.ty.content_type, &mut used);
                }
            }
            Payload::ExportSection(reader) => {
                for export in reader {
                    if export?.kind == ExternalKind::Global {
                        // An exported global is mutable-globals only if it
                        // is mutable; LLVM declares the feature for any
                        // global it exports, so declaring it is harmless.
                        used.insert("mutable-globals");
                    }
                }
            }
            Payload::CodeSectionEntry(body) => {
                for local in body.get_locals_reader()? {
                    value_type(local?.1, &mut used);
                }
                let mut operators = body.get_operators_reader()?;
                while !operators.eof() {
                    operator(&operators.read()?, &mut used)?;
                }
            }
            _ => {}
        }
    }
    if memories > 1 {
        used.insert("multimemory");
    }
    if tables > 1 {
        used.insert("reference-types");
    }
    Ok(used)
}

fn memory_type(shared: bool, memory64: bool, used: &mut BTreeSet<&'static str>) {
    if shared {
        used.insert("atomics");
    }
    if memory64 {
        used.insert("memory64");
    }
}

fn table_type(element: RefType, table64: bool, used: &mut BTreeSet<&'static str>) {
    if element != RefType::FUNCREF {
        used.insert("reference-types");
    }
    ref_type(element, used);
    if table64 {
        used.insert("memory64");
    }
}

fn value_type(ty: ValType, used: &mut BTreeSet<&'static str>) {
    match ty {
        ValType::V128 => {
            used.insert("simd128");
        }
        ValType::Ref(reference) => {
            used.insert("reference-types");
            ref_type(reference, used);
        }
        ValType::I32 | ValType::I64 | ValType::F32 | ValType::F64 => {}
    }
}

fn ref_type(reference: RefType, used: &mut BTreeSet<&'static str>) {
    match reference.heap_type() {
        HeapType::Abstract { ty, .. } => {
            use wasmparser::AbstractHeapType as A;
            match ty {
                A::Func | A::Extern => {
                    if !reference.is_nullable() {
                        used.insert("gc");
                    }
                }
                A::Exn | A::NoExn => {
                    used.insert("exception-handling");
                    if !reference.is_nullable() || ty == A::NoExn {
                        used.insert("gc");
                    }
                }
                _ => {
                    used.insert("gc");
                }
            }
        }
        // Concrete (indexed) heap types are typed references (GC).
        _ => {
            used.insert("gc");
        }
    }
}

fn operator(op: &Operator, used: &mut BTreeSet<&'static str>) -> Result<()> {
    match op {
        Operator::Block { blockty }
        | Operator::Loop { blockty }
        | Operator::If { blockty }
        | Operator::Try { blockty } => block_type(*blockty, used),
        Operator::TryTable { try_table } => block_type(try_table.ty, used),
        // wasmparser files table.fill under reference types; Binaryen also
        // requires bulk memory for it (the bulk-memory proposal defined it).
        Operator::TableFill { .. } => {
            used.insert("bulk-memory");
        }
        Operator::Select { .. } => {}
        Operator::TypedSelect { ty } => value_type(*ty, used),
        Operator::TypedSelectMulti { .. } => {
            used.insert("multivalue");
        }
        Operator::RefNull { hty } => {
            used.insert("reference-types");
            if !matches!(
                hty,
                HeapType::Abstract {
                    ty: wasmparser::AbstractHeapType::Func | wasmparser::AbstractHeapType::Extern,
                    ..
                }
            ) {
                ref_type(RefType::new(true, *hty).context("ref.null heap type")?, used);
            }
        }
        _ => {}
    }
    macro_rules! classify {
        ($( @$proposal:ident $op:ident $({ $($arg:ident: $argty:ty),* })? => $visit:ident ($($ann:tt)*))*) => {
            match op {
                $(
                    Operator::$op { .. } => classify!(feature @$proposal),
                )*
                _ => bail!("unknown Wasm operator in instrumented output: {op:?}"),
            }
        };
        (feature @mvp) => { None };
        (feature @sign_extension) => { Some("sign-ext") };
        (feature @saturating_float_to_int) => { Some("nontrapping-fptoint") };
        (feature @bulk_memory) => { Some("bulk-memory") };
        (feature @reference_types) => { Some("reference-types") };
        (feature @tail_call) => { Some("tail-call") };
        (feature @threads) => { Some("atomics") };
        (feature @simd) => { Some("simd128") };
        (feature @relaxed_simd) => { Some("relaxed-simd") };
        (feature @exceptions) => { Some("exception-handling") };
        (feature @legacy_exceptions) => { Some("exception-handling") };
        (feature @gc) => { Some("gc") };
        (feature @function_references) => { Some("gc") };
        (feature @wide_arithmetic) => { Some("wide-arithmetic") };
        (feature @$proposal:ident) => {
            bail!(concat!(
                "instrumented output uses the `",
                stringify!($proposal),
                "` proposal, which has no target_features name"
            ))
        };
    }
    #[allow(unreachable_code, unused_variables)]
    let feature: Option<&'static str> = wasmparser::for_each_operator!(classify);
    if let Some(feature) = feature {
        used.insert(feature);
        if feature == "gc" {
            used.insert("reference-types");
        }
    }
    Ok(())
}

fn block_type(ty: BlockType, used: &mut BTreeSet<&'static str>) {
    match ty {
        BlockType::Empty => {}
        BlockType::Type(ty) => value_type(ty, used),
        // A block with parameters or several results.
        BlockType::FuncType(_) => {
            used.insert("multivalue");
        }
    }
}

/// The `(prefix, name)` entries of the module's `target_features` section,
/// in order; empty when it has none.
fn declared_entries(module: &[u8]) -> Result<Vec<(u8, String)>> {
    let mut entries = Vec::new();
    for payload in Parser::new(0).parse_all(module) {
        let Payload::CustomSection(section) = payload? else {
            continue;
        };
        if section.name() != SECTION {
            continue;
        }
        ensure!(entries.is_empty(), "module has more than one target_features section");
        let mut reader = wasmparser::BinaryReader::new(section.data(), 0);
        let count = reader.read_var_u32().context("malformed target_features")?;
        for _ in 0..count {
            let prefix = reader.read_u8().context("truncated target_features")?;
            let name = reader.read_string().context("malformed target_features name")?;
            entries.push((prefix, name.to_owned()));
        }
        ensure!(reader.eof(), "target_features has trailing bytes");
    }
    Ok(entries)
}

/// Copy `module`, dropping every custom section called `name` and appending
/// one with `payload`. Other sections keep their order (a leading `dylink.0`
/// stays first).
fn replace_custom_section(module: &[u8], name: &str, payload: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(module.len() + payload.len() + 32);
    out.extend_from_slice(&module[..8]);
    for item in Parser::new(0).parse_all(module) {
        let item = item?;
        if let Payload::CustomSection(section) = &item {
            if section.name() == name {
                continue;
            }
        }
        if let Some((id, range)) = item.as_section() {
            out.push(id);
            write_u32(&mut out, u32::try_from(range.len()).context("section too large")?);
            out.extend_from_slice(&module[range]);
        }
    }
    let mut section = Vec::new();
    write_u32(&mut section, name.len() as u32);
    section.extend_from_slice(name.as_bytes());
    section.extend_from_slice(payload);
    out.push(0);
    write_u32(&mut out, u32::try_from(section.len()).context("section too large")?);
    out.extend_from_slice(&section);
    Ok(out)
}

fn write_u32(out: &mut Vec<u8>, mut value: u32) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn features(module: &[u8]) -> Vec<(u8, String)> {
        declared_entries(module).unwrap()
    }

    fn with_section(wat: &str, entries: &[(u8, &str)]) -> Vec<u8> {
        let module = wat::parse_str(wat).unwrap();
        let mut payload = Vec::new();
        write_u32(&mut payload, entries.len() as u32);
        for (prefix, name) in entries {
            payload.push(*prefix);
            write_u32(&mut payload, name.len() as u32);
            payload.extend_from_slice(name.as_bytes());
        }
        replace_custom_section(&module, SECTION, &payload).unwrap()
    }

    #[test]
    fn detects_features_from_operators_and_types() {
        let module = wat::parse_str(
            r#"(module
                (memory 1 1 shared)
                (tag $t (param i32))
                (func (result i32 i32) (i32.const 0) (i32.const 1))
                (func (param i32) (result i32)
                    (drop (i32.atomic.load (i32.const 0)))
                    (drop (ref.null exn))
                    (i32.extend8_s (local.get 0))))"#,
        )
        .unwrap();
        let used = used_features(&module).unwrap();
        for feature in ["atomics", "multivalue", "exception-handling", "reference-types", "sign-ext"] {
            assert!(used.contains(feature), "{feature} missing from {used:?}");
        }
        assert!(!used.contains("gc"), "{used:?}");
    }

    #[test]
    fn keeps_declared_entries_and_adds_used_ones_once() {
        let module = with_section(
            "(module (memory 1 1 shared) (func (drop (i32.atomic.load (i32.const 0)))))",
            &[(b'+', "atomics"), (b'+', "simd128")],
        );
        let once = declare_used_features(module).unwrap();
        let twice = declare_used_features(once.clone()).unwrap();
        assert_eq!(once, twice);
        assert_eq!(
            features(&once),
            [(b'+', "atomics".to_string()), (b'+', "simd128".to_string())]
        );
        wasmparser::Validator::new().validate_all(&once).unwrap();
    }

    #[test]
    fn creates_the_section_when_absent() {
        let module = wat::parse_str("(module (func (result i32 i32) (i32.const 0) (i32.const 1)))")
            .unwrap();
        let declared = declare_used_features(module).unwrap();
        assert_eq!(features(&declared), [(b'+', "multivalue".to_string())]);
    }

    #[test]
    fn rejects_a_used_feature_the_module_disallows() {
        let module = with_section(
            "(module (func (result i32 i32) (i32.const 0) (i32.const 1)))",
            &[(b'-', "multivalue")],
        );
        assert!(declare_used_features(module).is_err());
    }
}
