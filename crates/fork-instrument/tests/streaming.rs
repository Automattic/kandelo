use std::collections::BTreeSet;
use std::convert::Infallible;

use fork_instrument::{call_graph, streaming::*};
use wasm_encoder::reencode::{Reencode, RoundtripReencoder};
use wasmparser::{Operator, Parser, Payload};

fn assert_closure_matches(input: &[u8], external: bool) {
    let scanned = scan(input).expect("bounded scan");
    // Walrus program points use arena-local sequence IDs. Resolve them back
    // to original offsets to compare exact tail sites, not just caller names.
    let mut config = walrus::ModuleConfig::new();
    config.on_instr_loc(|offset| walrus::ir::InstrLocId::new(*offset as u32));
    let located = config.parse(input).unwrap();
    let seeds = call_graph::find_import_funcs(&located, "kernel.kernel_fork");
    let actual = scanned
        .reaching_from_seeds(seeds.iter().map(|id| id.index() as u32), external)
        .unwrap();
    let expected = call_graph::analyze_reaching_closure_from_seeds(
        &located,
        call_graph::find_import_funcs(&located, "kernel.kernel_fork"),
        external,
    );
    assert_eq!(
        actual.activations,
        expected
            .activations
            .iter()
            .map(|id| id.index() as u32)
            .collect()
    );
    assert_eq!(
        actual.control_reachable,
        expected
            .control_reachable
            .iter()
            .map(|id| id.index() as u32)
            .collect()
    );
    let tail_points: BTreeSet<_> = expected
        .tail_call_landings
        .iter()
        .map(|site| {
            let local = located.funcs.get(site.caller).kind.unwrap_local();
            let loc = local.block(site.sequence).instrs[site.instruction_index].1;
            ProgramPoint {
                function: site.caller.index() as u32,
                offset: loc.data() as usize,
            }
        })
        .collect();
    assert_eq!(actual.tail_sites, tail_points);
}

#[test]
fn direct_indirect_ref_and_tail_closure_matches_oracle() {
    let input = wat::parse_str(
        r#"(module
      (type $t (func (result i32)))
      (import "kernel" "kernel_fork" (func $fork (type $t)))
      (table 3 funcref)
      (elem (i32.const 0) $fork $other $tail)
      (func $other (type $t) i32.const 9)
      (func $tail (type $t) return_call $fork)
      (func $caller (type $t) call $tail)
      (func $indirect (type $t) i32.const 2 call_indirect (type $t))
      (func $precise (type $t) ref.func $other nop call_ref $t)
      (func $ref (param (ref null $t)) (result i32) local.get 0 call_ref $t)
      (func $dead (result i32) i32.const 0 return call $fork)
      (func $nested_dead (result i32) i32.const 0 return block call $fork drop end)
    )"#,
    )
    .unwrap();
    assert_closure_matches(&input, false);
    assert_closure_matches(&input, true);
}

#[test]
fn passive_segments_copies_and_dynamic_writes_match_oracle() {
    let input = wat::parse_str(
        r#"(module
      (type $t (func (result i32)))
      (import "kernel" "kernel_fork" (func $fork (type $t)))
      (table $a 2 funcref) (table $b 2 funcref)
      (elem $e func $fork)
      (func $setup i32.const 0 i32.const 0 i32.const 1 table.init $a $e
        i32.const 0 i32.const 0 i32.const 1 table.copy $b $a)
      (func $dispatch (result i32) i32.const 0 call_indirect $b (type $t))
      (func $mutate i32.const 1 ref.null func table.set $a)
      (func $tail (result i32) i32.const 1 return_call_indirect $a (type $t))
    )"#,
    )
    .unwrap();
    assert_closure_matches(&input, false);
}

#[test]
fn legacy_and_modern_exception_regions_preserve_calls_and_original_code() {
    let input = wat::parse_str(
        r#"(module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (tag $tag (param i32))
      (func $legacy (result i32)
        try (result i32) i32.const 7 throw $tag
        catch $tag drop call $fork end)
      (func $modern (result i32)
        block $handler (result i32)
          try_table (catch $tag $handler) i32.const 8 throw $tag end
          unreachable
        end drop call $fork)
    )"#,
    )
    .unwrap();
    assert_closure_matches(&input, false);
    let scanned = scan(&input).unwrap();
    assert!(scanned.functions[1].body.as_ref().unwrap().has_legacy_eh);
    assert!(scanned.functions[2].body.as_ref().unwrap().has_modern_eh);
    let mut output = Vec::new();
    emit_remapped(
        &scanned,
        &mut RoundtripReencoder,
        &mut output,
        EmitLimits::default(),
    )
    .unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    assert_eq!(scan(&output).unwrap().operators, scanned.operators);
}

#[test]
fn summaries_track_nonclosure_state_and_exact_original_offsets() {
    let input = wat::parse_str(
        r#"(module
      (memory 1) (table 1 funcref) (global $g (mut i32) (i32.const 0))
      (data $d "x") (elem $e funcref (ref.null func))
      (func $state i32.const 1 global.set $g
        i32.const 0 ref.null func table.set 0 data.drop $d elem.drop $e)
      (func $tail return_call $state unreachable)
    )"#,
    )
    .unwrap();
    let scanned = scan(&input).unwrap();
    let state = scanned.functions[0].body.as_ref().unwrap();
    assert_eq!(state.global_writes, [0].into());
    assert_eq!(state.table_writes, [0].into());
    assert_eq!(state.data_drops, [0].into());
    assert_eq!(state.element_drops, [0].into());
    let point = scanned.functions[1].body.as_ref().unwrap().tails[0].point;
    let mut reader = wasmparser::OperatorsReader::new(wasmparser::BinaryReader::new(
        &input[point.offset..],
        point.offset,
    ));
    assert!(matches!(
        reader.read().unwrap(),
        Operator::ReturnCall { function_index: 0 }
    ));
    assert!(
        scanned
            .reaching_from_seeds([], false)
            .unwrap()
            .activations
            .is_empty()
    );
}

struct VisitAll {
    points: Vec<ProgramPoint>,
}
impl Reencode for VisitAll {
    type Error = Infallible;
}
impl FunctionTransform for VisitAll {
    fn transform_operator(
        &mut self,
        point: ProgramPoint,
        op: Operator<'_>,
        f: &mut wasm_encoder::Function,
    ) -> anyhow::Result<()> {
        self.points.push(point);
        f.instruction(&self.instruction(op)?);
        Ok(())
    }
}

#[test]
fn emits_every_body_and_unreachable_operator_and_spools_code() {
    let input = wat::parse_str(
        r#"(module
      (func (export "f") (result i32) i32.const 7 return i32.const 9)
      (func nop nop nop)
    )"#,
    )
    .unwrap();
    let scanned = scan(&input).unwrap();
    let mut visitor = VisitAll { points: vec![] };
    let mut output = Vec::new();
    let report = emit_remapped(&scanned, &mut visitor, &mut output, EmitLimits::default()).unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    assert_eq!(visitor.points.len() as u64, scanned.operators);
    assert_eq!(report.functions, 2);
    assert!(report.spooled_code_bytes > report.largest_encoded_function as u64);
    assert_eq!(
        visitor
            .points
            .iter()
            .map(|p| p.function)
            .collect::<BTreeSet<_>>(),
        [0, 1].into()
    );
    let mut second = Vec::new();
    emit_remapped(
        &scanned,
        &mut RoundtripReencoder,
        &mut second,
        EmitLimits::default(),
    )
    .unwrap();
    assert_eq!(output, second);
}

#[test]
fn remaps_function_indices_in_code_exports_elements_globals_and_names() {
    struct SwapImports;
    impl Reencode for SwapImports {
        type Error = Infallible;
        fn function_index(
            &mut self,
            i: u32,
        ) -> Result<u32, wasm_encoder::reencode::Error<Self::Error>> {
            Ok(match i {
                0 => 1,
                1 => 0,
                i => i,
            })
        }
    }
    impl FunctionTransform for SwapImports {}
    let input = wat::parse_str(
        r#"(module
      (import "m" "a" (func $a (result i32)))
      (import "m" "b" (func $b (result i32)))
      (table 1 funcref) (elem (i32.const 0) $a)
      (global funcref (ref.func $a))
      (export "a" (func $a))
      (func (export "run") (result i32) call $a)
    )"#,
    )
    .unwrap();
    let scanned = scan(&input).unwrap();
    let mut output = Vec::new();
    emit_remapped(
        &scanned,
        &mut SwapImports,
        &mut output,
        EmitLimits::default(),
    )
    .unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    let text = wasmprinter::print_bytes(&output).unwrap();
    assert!(text.contains("(export \"a\" (func $a))"), "{text}");
    let rescan = scan(&output).unwrap();
    assert_eq!(
        rescan.exports.iter().find(|(n, _, _)| n == "a").unwrap().2,
        1
    );
    assert_eq!(rescan.elements[0].items, vec![ValueProof::Function(1)]);
    assert!(
        rescan.functions[2]
            .body
            .as_ref()
            .unwrap()
            .calls
            .contains(&CallTarget::Direct(1))
    );
    assert_eq!(rescan.functions[1].name.as_deref(), Some("a"));
}

#[test]
fn rejects_invalid_code_and_enforces_emission_budgets() {
    let input = wat::parse_str("(module (func nop nop nop))").unwrap();
    let scanned = scan(&input).unwrap();
    let result = emit_remapped(
        &scanned,
        &mut RoundtripReencoder,
        &mut Vec::new(),
        EmitLimits {
            max_function_bytes: 2,
            ..Default::default()
        },
    );
    assert!(result.unwrap_err().to_string().contains("function exceeds"));
    let mut invalid = input.clone();
    for payload in Parser::new(0).parse_all(&input) {
        if let Payload::CodeSectionEntry(body) = payload.unwrap() {
            invalid[body.range().end - 1] = 0x1a; // missing operand and final end
        }
    }
    assert!(scan(&invalid).is_err());
}

#[test]
fn spools_large_data_and_preserves_leading_dylink_and_build_input_policy() {
    use std::borrow::Cow;
    let plain =
        wat::parse_str("(module (memory 1) (data (i32.const 0) \"payload\") (func nop))").unwrap();
    let mut input = wasm_encoder::Module::new();
    input.section(&wasm_encoder::CustomSection {
        name: Cow::Borrowed("dylink.0"),
        data: Cow::Borrowed(&[]),
    });
    let mut input = input.finish();
    input.extend_from_slice(&plain[8..]);
    for (name, payload) in [
        ("kandelo.calltypes", &b"build input"[..]),
        ("kandelo.calltypes.code-sha256", &b"hash"[..]),
        (".debug_info", &b"debug input"[..]),
        ("opaque", &b"keep me"[..]),
    ] {
        let mut custom = Vec::new();
        wasm_encoder::Encode::encode(
            &wasm_encoder::CustomSection {
                name: Cow::Borrowed(name),
                data: Cow::Borrowed(payload),
            },
            &mut custom,
        );
        input.push(0);
        input.extend(custom);
    }
    let scanned = scan(&input).unwrap();
    let mut output = Vec::new();
    emit_remapped(
        &scanned,
        &mut RoundtripReencoder,
        &mut output,
        EmitLimits::default(),
    )
    .unwrap();
    let rescanned = scan(&output).unwrap();
    assert_eq!(rescanned.custom_sections[0].0, "dylink.0");
    assert!(rescanned.custom_data("kandelo.calltypes").next().is_none());
    assert!(rescanned.custom_data(".debug_info").next().is_none());
    assert_eq!(rescanned.custom_data("opaque").next().unwrap(), b"keep me");

    // The data payload exceeds the metadata budget. It must pass through the
    // file spool without allocating a DataSection-sized encoder vector.
    let mut module = wasm_encoder::Module::new();
    let mut data = wasm_encoder::DataSection::new();
    data.passive(std::iter::repeat_n(42, 1024 * 1024));
    module.section(&data);
    let input = module.finish();
    let scanned = scan(&input).unwrap();
    let mut file = tempfile::tempfile().unwrap();
    emit_remapped(
        &scanned,
        &mut RoundtripReencoder,
        &mut file,
        EmitLimits {
            max_metadata_section_bytes: 64,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(file.metadata().unwrap().len() > 1024 * 1024);
}

#[test]
fn shifted_helper_imports_preserve_normal_execution_on_node() {
    struct AddHelper;
    impl Reencode for AddHelper {
        type Error = Infallible;
        fn type_index(
            &mut self,
            i: u32,
        ) -> Result<u32, wasm_encoder::reencode::Error<Self::Error>> {
            Ok(i + 1)
        }
        fn memory_index(
            &mut self,
            i: u32,
        ) -> Result<u32, wasm_encoder::reencode::Error<Self::Error>> {
            Ok(i + 1)
        }
        fn table_index(
            &mut self,
            i: u32,
        ) -> Result<u32, wasm_encoder::reencode::Error<Self::Error>> {
            Ok(i + 1)
        }
        fn global_index(
            &mut self,
            i: u32,
        ) -> Result<u32, wasm_encoder::reencode::Error<Self::Error>> {
            Ok(i + 1)
        }
        fn tag_index(&mut self, i: u32) -> Result<u32, wasm_encoder::reencode::Error<Self::Error>> {
            Ok(i + 1)
        }
        fn parse_type_section(
            &mut self,
            out: &mut wasm_encoder::TypeSection,
            s: wasmparser::TypeSectionReader<'_>,
        ) -> Result<(), wasm_encoder::reencode::Error<Self::Error>> {
            out.ty().function([], []);
            wasm_encoder::reencode::utils::parse_type_section(self, out, s)
        }
        fn function_index(
            &mut self,
            i: u32,
        ) -> Result<u32, wasm_encoder::reencode::Error<Self::Error>> {
            Ok(if i == 0 { i } else { i + 1 })
        }
        fn parse_import_section(
            &mut self,
            out: &mut wasm_encoder::ImportSection,
            s: wasmparser::ImportSectionReader<'_>,
        ) -> Result<(), wasm_encoder::reencode::Error<Self::Error>> {
            wasm_encoder::reencode::utils::parse_import_section(self, out, s)?;
            out.import("helpers", "unused", wasm_encoder::EntityType::Function(1));
            out.import(
                "helpers",
                "memory",
                wasm_encoder::EntityType::Memory(wasm_encoder::MemoryType {
                    minimum: 1,
                    maximum: None,
                    memory64: false,
                    shared: false,
                    page_size_log2: None,
                }),
            );
            out.import(
                "helpers",
                "table",
                wasm_encoder::EntityType::Table(wasm_encoder::TableType {
                    element_type: wasm_encoder::RefType::FUNCREF,
                    minimum: 1,
                    maximum: None,
                    table64: false,
                    shared: false,
                }),
            );
            out.import(
                "helpers",
                "global",
                wasm_encoder::EntityType::Global(wasm_encoder::GlobalType {
                    val_type: wasm_encoder::ValType::I32,
                    mutable: true,
                    shared: false,
                }),
            );
            out.import(
                "helpers",
                "tag",
                wasm_encoder::EntityType::Tag(wasm_encoder::TagType {
                    kind: wasm_encoder::TagKind::Exception,
                    func_type_idx: 0,
                }),
            );
            Ok(())
        }
    }
    impl FunctionTransform for AddHelper {}
    let input = wat::parse_str(
        r#"(module
      (type $value (func (result i32)))
      (import "host" "value" (func $value (type $value)))
      (memory (export "memory") 1)
      (table 1 funcref) (elem (i32.const 0) $leaf)
      (global $g (mut i32) (i32.const 0))
      (tag $tag (export "tag") (param i32))
      (data (i32.const 0) "\2a\00\00\00")
      (func $leaf (type $value) i32.const 3)
      (func $start i32.const 9 global.set $g) (start $start)
      (func $run (export "run") (result i32)
        i32.const 0 i32.load global.get $g i32.add
        i32.const 0 call_indirect (type $value) i32.add call $value i32.add)
      (func (export "thrower") i32.const 77 throw $tag)
    )"#,
    )
    .unwrap();
    let scanned = scan(&input).unwrap();
    let mut output = Vec::new();
    emit_remapped(&scanned, &mut AddHelper, &mut output, EmitLimits::default()).unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let original = directory.path().join("original.wasm");
    let rewritten = directory.path().join("rewritten.wasm");
    std::fs::write(&original, input).unwrap();
    std::fs::write(&rewritten, output).unwrap();
    let result = std::process::Command::new("node")
        .args([
            "--input-type=module",
            "-e",
            r#"
      import fs from 'node:fs';
      for (const path of process.argv.slice(1)) {
        const { instance } = await WebAssembly.instantiate(fs.readFileSync(path), {
          host: { value: () => 5 }, helpers: {
            unused: () => { throw Error('helper ran'); },
            memory: new WebAssembly.Memory({ initial: 1 }),
            table: new WebAssembly.Table({ initial: 1, element: 'anyfunc' }),
            global: new WebAssembly.Global({ value: 'i32', mutable: true }, -1),
            tag: new WebAssembly.Tag({ parameters: [] }),
          },
        });
        if (instance.exports.run() !== 59) throw Error('remapped execution diverged');
        try { instance.exports.thrower(); throw Error('thrower returned'); }
        catch (error) {
          if (!(error instanceof WebAssembly.Exception) || !error.is(instance.exports.tag)
              || error.getArg(instance.exports.tag, 0) !== 77) throw error;
        }
      }
    "#,
        ])
        .arg(original)
        .arg(rewritten)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn failed_writer_is_reported_without_retaining_module_output() {
    struct Fails;
    impl std::io::Write for Fails {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("destination failed"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let input = wat::parse_str("(module (func nop))").unwrap();
    let scanned = scan(&input).unwrap();
    let error = emit_remapped(
        &scanned,
        &mut RoundtripReencoder,
        &mut Fails,
        EmitLimits::default(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("destination failed"));
}

#[test]
fn diagnostic_cli_is_deterministic_and_cannot_publish_an_artifact() {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("fixture.wasm");
    let output = directory.path().join("not-created.wasm");
    std::fs::write(&input, wat::parse_str("(module (func nop nop))").unwrap()).unwrap();
    let mut expected = None;
    for _ in 0..3 {
        let result = std::process::Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
            .arg(&input)
            .arg("--streaming-scan")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        if let Some(expected) = &expected {
            assert_eq!(expected, &result.stdout);
        } else {
            expected = Some(result.stdout);
        }
    }
    assert!(
        String::from_utf8(expected.unwrap())
            .unwrap()
            .contains("operators\t3\n")
    );
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg(input)
        .args(["--streaming-scan", "--output"])
        .arg(&output)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(!output.exists());
}

#[test]
fn total_code_can_exceed_the_per_function_buffer_budget() {
    let mut module = wasm_encoder::Module::new();
    let mut types = wasm_encoder::TypeSection::new();
    types.ty().function([], []);
    module.section(&types);
    let mut declarations = wasm_encoder::FunctionSection::new();
    let mut code = wasm_encoder::CodeSection::new();
    for _ in 0..32 {
        declarations.function(0);
        let mut body = wasm_encoder::Function::new([]);
        for _ in 0..4096 {
            body.instruction(&wasm_encoder::Instruction::Nop);
        }
        body.instruction(&wasm_encoder::Instruction::End);
        code.function(&body);
    }
    module.section(&declarations).section(&code);
    let input = module.finish();
    let scanned = scan(&input).unwrap();
    assert_eq!(scanned.operators, 32 * 4097);
    assert!(
        scanned
            .functions
            .iter()
            .all(|f| f.body.as_ref().unwrap().calls.is_empty())
    );
    let report = emit_remapped(
        &scanned,
        &mut RoundtripReencoder,
        &mut std::io::sink(),
        EmitLimits {
            max_function_bytes: 8192,
            max_metadata_section_bytes: 1024,
        },
    )
    .unwrap();
    assert_eq!(report.functions, 32);
    assert!(report.largest_encoded_function < 8192);
    assert!(report.spooled_code_bytes > 8192 * 16);
}

#[test]
fn remaps_data_and_element_references_outside_any_fork_closure() {
    struct SwapSegments;
    impl Reencode for SwapSegments {
        type Error = Infallible;
        fn data_index(
            &mut self,
            i: u32,
        ) -> Result<u32, wasm_encoder::reencode::Error<Self::Error>> {
            Ok(i ^ 1)
        }
        fn element_index(
            &mut self,
            i: u32,
        ) -> Result<u32, wasm_encoder::reencode::Error<Self::Error>> {
            Ok(i ^ 1)
        }
    }
    impl FunctionTransform for SwapSegments {}
    let input = wat::parse_str(
        r#"(module
      (memory 1) (table 2 funcref)
      (data $a "A") (data $b "B")
      (elem $a func $first) (elem $b func $second)
      (func $first) (func $second)
      (func $initialize
        i32.const 0 i32.const 0 i32.const 1 memory.init $a
        i32.const 0 i32.const 0 i32.const 1 table.init $a
        data.drop $a elem.drop $a)
    )"#,
    )
    .unwrap();
    let scanned = scan(&input).unwrap();
    let mut output = Vec::new();
    emit_remapped(
        &scanned,
        &mut SwapSegments,
        &mut output,
        EmitLimits::default(),
    )
    .unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    let rescanned = scan(&output).unwrap();
    let body = rescanned.functions[2].body.as_ref().unwrap();
    assert_eq!(body.data_drops, [1].into());
    assert_eq!(body.element_drops, [1].into());
    assert_eq!(body.table_inits, [(1, 0)].into());
    for payload in Parser::new(0).parse_all(&output) {
        if let Payload::CodeSectionEntry(body) = payload.unwrap() {
            for op in body.get_operators_reader().unwrap() {
                if let Operator::MemoryInit { data_index, .. } = op.unwrap() {
                    assert_eq!(data_index, 1);
                }
            }
        }
    }
}
