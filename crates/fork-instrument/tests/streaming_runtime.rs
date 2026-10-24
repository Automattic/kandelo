use fork_instrument::{runtime as oracle, streaming::*};
use wasm_encoder::ValType;
use wasmparser::Operator;

fn fixture(wide: bool) -> Vec<u8> {
    let pointer = if wide { "i64" } else { "i32" };
    let memory = if wide { "i64" } else { "" };
    wat::parse_str(format!(
        r#"(module
      (import "env" "__channel_base" (global $channel (mut {pointer})))
      (import "old" "counter" (global $counter (mut i64)))
      (memory (export "memory") {memory} 1)
      (global $sp (export "sp") (mut {pointer}) ({pointer}.const 4096))
      (global $small (export "small") (mut i32) (i32.const 123))
      (global $big (export "big") (mut i64) (i64.const 12345678901))
      (global $f32 (mut f32) (f32.const -1.25))
      (global $f64 (mut f64) (f64.const 7.125))
      (global $v (mut v128) (v128.const i64x2 1234 5678))
      (global (export "reference") (mut externref) (ref.null extern))
      (global i32 (i32.const 55))
      (func (export "mutate")
        {pointer}.const 0 global.set $sp {pointer}.const 0 global.set $channel
        i64.const 0 global.set $counter i32.const 0 global.set $small i64.const 0 global.set $big
        f32.const 0 global.set $f32 f64.const 0 global.set $f64
        v128.const i64x2 0 0 global.set $v)
      (func (export "check") (result i32)
        global.get $sp {pointer}.const 4096 {pointer}.eq
        global.get $counter i64.const 97 i64.eq i32.and
        global.get $small i32.const 123 i32.eq i32.and
        global.get $big i64.const 12345678901 i64.eq i32.and
        global.get $f32 f32.const -1.25 f32.eq i32.and
        global.get $f64 f64.const 7.125 f64.eq i32.and
        global.get $v v128.const i64x2 1234 5678 i64x2.eq i8x16.all_true i32.and))"#
    ))
    .unwrap()
}

fn native(input: &[u8]) -> (Vec<u8>, NativeRuntime) {
    let scan = scan(input).unwrap();
    let mut runtime = NativeRuntime::plan(&scan, Default::default(), 1024 * 1024).unwrap();
    let mut bytes = Vec::new();
    emit_remapped(&scan, &mut runtime, &mut bytes, Default::default()).unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&bytes)
        .unwrap();
    (bytes, runtime)
}

#[test]
fn native_runtime_scalar_layout_and_import_abi_match_the_oracle_for_both_widths() {
    for wide in [false, true] {
        let input = fixture(wide);
        let (bytes, runtime) = native(&input);
        let mut module = walrus::Module::from_buffer(&input).unwrap();
        let old = oracle::inject_linked_runtime(&mut module);
        assert_eq!(runtime.frames_start_offset(), old.frames_start_offset);
        assert_eq!(runtime.fixed_prefix_size(), old.fixed_prefix_size);
        assert_eq!(runtime.saved_globals().len(), old.saved_globals.len());
        for (native, old) in runtime.saved_globals().iter().zip(old.saved_globals.iter()) {
            assert_eq!(native.global, old.id.index() as u32);
            assert_eq!(native.offset, old.offset);
            assert_eq!(format!("{:?}", native.ty), format!("{:?}", old.ty));
        }
        let native_module = walrus::Module::from_buffer(&bytes).unwrap();
        let inventory = |m: &walrus::Module| {
            m.imports
                .iter()
                .map(|i| {
                    (
                        i.module.clone(),
                        i.name.clone(),
                        match i.kind {
                            walrus::ImportKind::Function(f) => format!(
                                "{:?}->{:?}",
                                m.types.params(m.funcs.get(f).ty()),
                                m.types.results(m.funcs.get(f).ty())
                            ),
                            walrus::ImportKind::Global(g) => {
                                format!("global:{:?}", m.globals.get(g).ty)
                            }
                            walrus::ImportKind::Table(t) => {
                                format!("table:{:?}", m.tables.get(t).element_ty)
                            }
                            walrus::ImportKind::Tag(t) => {
                                format!("tag:{:?}", m.types.params(m.tags.get(t).ty))
                            }
                            walrus::ImportKind::Memory(_) => "memory".into(),
                        },
                    )
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(inventory(&native_module), inventory(&module));
        assert_eq!(native(&input).0, bytes);
        let scan = scan(&bytes).unwrap();
        for function in [
            runtime.indices().unwind_end,
            runtime.indices().rewind_end,
            runtime.indices().abort_end,
        ] {
            let body = scan
                .body_provider(Default::default())
                .load(function)
                .unwrap();
            assert!(
                matches!(body.instructions[1].operation,Operator::GlobalSet {global_index} if global_index==runtime.indices().buf_global)
            );
            assert!(
                matches!(body.instructions[3].operation,Operator::GlobalSet {global_index} if global_index==runtime.indices().state_global)
            );
        }
    }
}

fn execute(bytes: &[u8], wide: bool, prefix: u32) -> Vec<u8> {
    let file = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(file.path(), bytes).unwrap();
    let result=std::process::Command::new("node").arg("-e").arg(r#"
      const fs=require('fs'),assert=require('node:assert/strict');
      const wide=process.argv[2]==='1',P=Number(process.argv[3]);
      const m=new WebAssembly.Module(fs.readFileSync(process.argv[1]));
      const channel=new WebAssembly.Global({value:wide?'i64':'i32',mutable:true},wide?4096n:4096);
      const counter=new WebAssembly.Global({value:'i64',mutable:true},97n);
      const imports={env:{__channel_base:channel},old:{counter}};
      for(const x of WebAssembly.Module.imports(m)){
        const s=imports[x.module]??={};if(x.name in s)continue;
        s[x.name]=x.kind==='function'?()=>0:x.kind==='table'?new WebAssembly.Table({element:'anyfunc',initial:1}):x.kind==='tag'?new WebAssembly.Tag({parameters:[]}):x.kind==='memory'?new WebAssembly.Memory({initial:1}):x.kind==='global'?new WebAssembly.Global({value:'i32',mutable:false},123):null;
      }
      const e=new WebAssembly.Instance(m,imports).exports,buf=wide?512n:512;
      const states=[e.wpk_fork_state()];
      e.wpk_fork_unwind_begin(buf);states.push(e.wpk_fork_state());
      const saved=Buffer.from(new Uint8Array(e.memory.buffer,512,P)).toString('hex');
      e.wpk_fork_unwind_end();states.push(e.wpk_fork_state());e.mutate();
      const reference={sentinel:1};e.reference.value=reference;
      e.wpk_fork_rewind_begin(buf);states.push(e.wpk_fork_state());assert.equal(e.check(),1);
      assert.equal(channel.value,wide?0n:0);assert.equal(e.reference.value,reference);
      e.wpk_fork_rewind_end();states.push(e.wpk_fork_state());e.mutate();
      e.wpk_fork_abort_begin(buf);states.push(e.wpk_fork_state());assert.equal(e.check(),1);
      e.wpk_fork_abort_end();states.push(e.wpk_fork_state());
      assert.deepEqual(states,[0,1,0,2,0,3,0]);console.log(JSON.stringify({states,saved}));
    "#).arg(file.path()).arg(if wide{"1"}else{"0"}).arg(prefix.to_string()).output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    result.stdout
}

#[test]
fn native_runtime_uses_the_remapped_source_memory_and_globals_after_other_imports() {
    use wasm_encoder::{EntityType, FuncType, GlobalType, MemoryType};
    for wide in [false, true] {
        let input = fixture(wide);
        let scan = scan(&input).unwrap();
        let base = scan.types.as_ref().core_type_count_in_module();
        let inputs = RuntimeInputs {
            types: vec![FuncType::new([], [])],
            imports: vec![
                PlannedImport {
                    module: "extra".into(),
                    name: "function".into(),
                    ty: EntityType::Function(base),
                },
                PlannedImport {
                    module: "extra".into(),
                    name: "global".into(),
                    ty: EntityType::Global(GlobalType {
                        val_type: ValType::I32,
                        mutable: false,
                        shared: false,
                    }),
                },
                PlannedImport {
                    module: "extra".into(),
                    name: "memory".into(),
                    ty: EntityType::Memory(MemoryType {
                        minimum: 1,
                        maximum: None,
                        memory64: false,
                        shared: false,
                        page_size_log2: None,
                    }),
                },
            ],
            ..Default::default()
        };
        let mut runtime = NativeRuntime::plan(&scan, inputs, 1 << 20).unwrap();
        let mut bytes = Vec::new();
        emit_remapped(&scan, &mut runtime, &mut bytes, Default::default()).unwrap();
        wasmparser::Validator::new_with_features(features())
            .validate_all(&bytes)
            .unwrap();
        let ordinary = native(&input);
        assert_eq!(
            execute(&bytes, wide, runtime.frames_start_offset()),
            execute(&ordinary.0, wide, ordinary.1.frames_start_offset())
        );
    }
}

#[test]
fn native_runtime_snapshot_rewind_abort_and_child_binding_execute_like_the_oracle() {
    for wide in [false, true] {
        let input = fixture(wide);
        let (bytes, runtime) = native(&input);
        let mut old = walrus::Module::from_buffer(&input).unwrap();
        let old_runtime = oracle::inject_linked_runtime(&mut old);
        assert_eq!(
            execute(&bytes, wide, runtime.frames_start_offset()),
            execute(&old.emit_wasm(), wide, old_runtime.frames_start_offset)
        );
    }
}

#[test]
fn native_runtime_no_memory_and_metadata_output_failures_are_explicit() {
    let input = wat::parse_str("(module)").unwrap();
    let scan = scan(&input).unwrap();
    assert!(NativeRuntime::plan(&scan, Default::default(), 0).is_err());
    let runtime = NativeRuntime::plan(&scan, Default::default(), 8192).unwrap();
    assert_eq!(runtime.pointer_type(), ValType::I32);
    assert_eq!(runtime.frames_start_offset(), 8);
    assert!(runtime.emit_control(0, 1).is_err());
    assert!(runtime.emit_control(7, 1024).is_err());
    let output = native(&input).0;
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
}

#[test]
fn native_runtime_cleanup_and_codec_overrides_preserve_final_helpers() {
    let input = wat::parse_str(r#"(module (func $cleanup (export "cleanup")))"#).unwrap();
    let scan = scan(&input).unwrap();
    let pair = CodecPair {
        encode: 31,
        decode: 32,
    };
    let runtime = NativeRuntime::plan(
        &scan,
        RuntimeInputs {
            codecs: NativeCodecOverrides {
                anyref: Some(pair),
                cleanup: Some(15),
                ..Default::default()
            },
            ..Default::default()
        },
        8192,
    )
    .unwrap();
    assert_eq!(runtime.indices().codecs.anyref.encode, 31);
    assert_eq!(runtime.indices().codecs.anyref.decode, 32);
    assert_eq!(runtime.imports_plan().len(), 17);
    for helper in [1, 3, 5] {
        let body = runtime.emit_control(helper, 1024).unwrap();
        let raw = body.into_raw_body();
        let body = wasmparser::FunctionBody::new(wasmparser::BinaryReader::new(&raw, 0));
        assert!(matches!(
            body.get_operators_reader().unwrap().read().unwrap(),
            Operator::Call { function_index: 15 }
        ));
    }
}

#[test]
fn native_runtime_resolves_reserved_provider_ordinals_and_rejects_conflicts_or_overflow() {
    let input = wat::parse_str("(module)").unwrap();
    let scan = scan(&input).unwrap();
    let pair = CodecPair {
        encode: 7,
        decode: 8,
    };
    let runtime = NativeRuntime::plan(
        &scan,
        RuntimeInputs {
            helper_codecs: NativeCodecOverrides {
                exnref: Some(pair),
                cleanup: Some(13),
                ..Default::default()
            },
            ..Default::default()
        },
        8192,
    )
    .unwrap();
    let base = runtime.imports_plan().helper_function_base();
    assert_eq!(runtime.indices().codecs.exnref.encode, base + 7);
    assert_eq!(runtime.indices().codecs.exnref.decode, base + 8);
    assert_eq!(runtime.imports_plan().len(), 17, "no unused exnref imports");
    let body = runtime.emit_control(1, 1024).unwrap().into_raw_body();
    let body = wasmparser::FunctionBody::new(wasmparser::BinaryReader::new(&body, 0));
    assert!(
        matches!(body.get_operators_reader().unwrap().read().unwrap(), Operator::Call { function_index } if function_index == base + 13)
    );
    let conflict = NativeRuntime::plan(
        &scan,
        RuntimeInputs {
            codecs: NativeCodecOverrides {
                exnref: Some(pair),
                ..Default::default()
            },
            helper_codecs: NativeCodecOverrides {
                exnref: Some(pair),
                ..Default::default()
            },
            ..Default::default()
        },
        8192,
    );
    assert!(
        conflict
            .err()
            .unwrap()
            .to_string()
            .contains("both final and relative")
    );
    let overflow = NativeRuntime::plan(
        &scan,
        RuntimeInputs {
            helper_codecs: NativeCodecOverrides {
                exnref: Some(CodecPair {
                    encode: u32::MAX,
                    decode: u32::MAX,
                }),
                ..Default::default()
            },
            ..Default::default()
        },
        8192,
    );
    assert!(
        overflow
            .err()
            .unwrap()
            .to_string()
            .contains("provider index overflow")
    );
}
