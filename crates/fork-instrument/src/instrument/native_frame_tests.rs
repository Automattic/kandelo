//! Differential checks; production Walrus transformations are unchanged.
use super::*;
use crate::streaming as native;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};
use wasm_encoder::reencode::RoundtripReencoder;

#[test]
fn native_nested_call_carryovers_and_region_ranges_match_the_oracle() {
    for source in [
        r#"(module (import "h" "fork" (func $fork (param i32)))
          (func $f (param i32) i64.const 99 local.get 0
            block (param i32) local.get 0 call $fork drop end drop))"#,
        r#"(module (import "h" "fork" (func $fork (param i32)))
          (func $f (param i32) local.get 0 if
            i32.const 1 call $fork block i32.const 2 call $fork end
            else i32.const 3 call $fork end i32.const 4 call $fork))"#,
        r#"(module (import "h" "fork" (func $fork (param i32)))
          (tag $t) (func $f block $caught
            i64.const 7 try_table (catch $t $caught)
              i32.const 1 i32.const 2 call $fork drop end drop end))"#,
        r#"(module (import "h" "fork" (func $fork (param i32)))
          (func $f i32.const 1 i64.const 2
            loop (param i32 i64) drop i32.const 3 call $fork drop end))"#,
    ] {
        let bytes = wat::parse_str(source).unwrap();
        let scan = native::scan(&bytes).unwrap();
        let body = scan.body_provider(Default::default()).load(1).unwrap();
        let types = native::SourceTypes::new(&scan);
        let mut map = RoundtripReencoder;
        let environment = native::FrameEnvironment::discover(&scan, &mut map, 1 << 20).unwrap();
        let plan = native::plan_continuations(
            &scan,
            &body,
            &types,
            &mut map,
            environment,
            &BTreeSet::from([0]),
            Default::default(),
        )
        .unwrap();
        let module = Module::from_buffer(&bytes).unwrap();
        let function = module
            .funcs
            .iter()
            .find(|f| f.name.as_deref() == Some("f"))
            .unwrap()
            .id();
        let fork = module
            .funcs
            .iter()
            .find(|f| f.name.as_deref() == Some("fork"))
            .unwrap()
            .id();
        let fork_path = HashSet::from([fork]);
        let (sites, regions) = discover_calls_and_regions(&module, function, &fork_path);
        assert_eq!(sites.len(), plan.calls.len());
        let carryovers = compute_nested_carryover_types(&module, function, &fork_path).unwrap();
        for (ordinal, call) in plan.calls.iter().enumerate() {
            let expected: Vec<_> = carryovers[&(ordinal as u32)]
                .iter()
                .map(|t| format!("{t:?}"))
                .collect();
            let actual: Vec<_> = call
                .carryovers
                .iter()
                .map(|&key| format!("{:?}", plan.frame.local(key).unwrap().ty))
                .collect();
            assert_eq!(actual, expected, "{source}");
        }
        let mut old_ranges: Vec<_> = regions
            .values()
            .map(|r| (r.range_lo, r.range_hi + 1))
            .collect();
        let mut new_ranges: Vec<_> = plan
            .sequences
            .iter()
            .filter_map(|s| s.calls.as_ref().map(|r| (r.start, r.end)))
            .collect();
        old_ranges.sort_unstable();
        new_ranges.sort_unstable();
        assert_eq!(new_ranges, old_ranges, "{source}");
    }
}

#[test]
fn native_argument_suffix_plans_match_the_unchanged_oracle() {
    let mut cases: Vec<(String, String)> = vec![
        ("".into(), "".into()),
        ("i32".into(), "global.get 0".into()),
        ("i32".into(), "i32.const 0 i32.load".into()),
        ("i32".into(), "i32.const 1 i32.const 1 i32.div_s".into()),
        ("i32".into(), "block (result i32) i32.const 1 end".into()),
        ("f32".into(), "f32.const 1 f32.const 2 f32.add".into()),
        ("v128".into(), "v128.const i32x4 0 0 0 0".into()),
        ("externref".into(), "local.get 2".into()),
        (
            "i32 i64 f32 f64 externref".into(),
            "local.get 0 local.get 1 f32.const 1 f64.const 2 local.get 2".into(),
        ),
        (
            "i32".into(),
            "i32.const 7 i32.const 1 i32.add i32.const 2 i32.mul".into(),
        ),
    ];
    for op in ["eqz", "clz", "ctz", "popcnt", "extend8_s", "extend16_s"] {
        cases.push(("i32".into(), format!("local.get 0 i32.{op}")));
    }
    for op in [
        "eq", "ne", "lt_s", "lt_u", "gt_s", "gt_u", "le_s", "le_u", "ge_s", "ge_u", "add", "sub",
        "mul", "and", "or", "xor", "shl", "shr_s", "shr_u", "rotl", "rotr",
    ] {
        cases.push(("i32".into(), format!("local.get 0 i32.const 2 i32.{op}")));
        let result = if [
            "eq", "ne", "lt_s", "lt_u", "gt_s", "gt_u", "le_s", "le_u", "ge_s", "ge_u",
        ]
        .contains(&op)
        {
            "i32"
        } else {
            "i64"
        };
        cases.push((result.into(), format!("local.get 1 i64.const 2 i64.{op}")));
    }
    for (op, result) in [
        ("eqz", "i32"),
        ("clz", "i64"),
        ("ctz", "i64"),
        ("popcnt", "i64"),
        ("extend8_s", "i64"),
        ("extend16_s", "i64"),
        ("extend32_s", "i64"),
    ] {
        cases.push((result.into(), format!("local.get 1 i64.{op}")));
    }
    for (result, expression) in [
        ("i32", "local.get 1 i32.wrap_i64"),
        ("i64", "local.get 0 i64.extend_i32_s"),
        ("i64", "local.get 0 i64.extend_i32_u"),
        ("f32", "f32.const 1"),
        ("f64", "f64.const 2"),
    ] {
        cases.push((result.into(), expression.into()));
    }
    for (arguments, expression) in cases {
        let source = format!(
            r#"(module (import "h" "fork" (func $fork (param {arguments})))
          (memory 1) (global i32 (i32.const 1))
          (func $f (param i32 i64 externref) i32.const 7 drop {expression} call $fork))"#
        );
        let bytes = wat::parse_str(&source).unwrap();
        let scan = native::scan(&bytes).unwrap();
        let body = scan.body_provider(Default::default()).load(1).unwrap();
        let types = native::SourceTypes::new(&scan);
        let mut map = RoundtripReencoder;
        let environment = native::FrameEnvironment::discover(&scan, &mut map, 1 << 20).unwrap();
        let plan = native::plan_continuations(
            &scan,
            &body,
            &types,
            &mut map,
            environment,
            &BTreeSet::from([0]),
            Default::default(),
        )
        .unwrap();
        let module = Module::from_buffer(&bytes).unwrap();
        let function = module
            .funcs
            .iter()
            .find(|f| f.name.as_deref() == Some("f"))
            .unwrap();
        let FunctionKind::Local(local) = &function.kind else {
            panic!()
        };
        let instructions = &local.block(local.entry_block()).instrs;
        let args = module
            .types
            .get(
                module
                    .funcs
                    .iter()
                    .find(|f| f.name.as_deref() == Some("fork"))
                    .unwrap()
                    .ty(),
            )
            .params()
            .to_vec();
        let old =
            plan_call_arg_materialization(&module, &instructions[..instructions.len() - 1], args);
        match (&plan.calls[0].arguments, old) {
            (
                native::OperandMaterialization::Replay(span),
                PendingCallArgMaterialization::PureTail { tail_len, .. },
            ) => assert_eq!(span.len(), tail_len, "{source}"),
            (
                native::OperandMaterialization::Spill(values),
                PendingCallArgMaterialization::Spill { arg_types },
            ) => assert_eq!(values.len(), arg_types.len(), "{source}"),
            (
                native::OperandMaterialization::Empty,
                PendingCallArgMaterialization::Spill { arg_types },
            ) => assert!(arg_types.is_empty()),
            (new, old) => panic!("argument plan mismatch {new:?} vs {old:?}: {source}"),
        }
    }
}

fn compare(source: &str, spills: usize) {
    let bytes = wat::parse_str(source).unwrap();
    let scan = native::scan(&bytes).unwrap();
    let function = scan
        .functions
        .iter()
        .position(|f| f.name.as_deref() == Some("f"))
        .unwrap() as u32;
    let body = scan
        .body_provider(Default::default())
        .load(function)
        .unwrap();
    let mut map = RoundtripReencoder;
    let types = native::SourceTypes::new(&scan);
    let environment = native::FrameEnvironment::discover(&scan, &mut map, 1 << 20).unwrap();
    let mut builder = native::FrameBuilder::new(
        &scan,
        &body,
        &types,
        &mut map,
        environment,
        Default::default(),
    )
    .unwrap();
    let capture = Arc::new(Mutex::new(BTreeMap::new()));
    let saved = capture.clone();
    let nlocals = body.locals.len();
    let mut config = walrus::ModuleConfig::new();
    config.on_parse(move |_, indices| {
        let function = indices.get_func(function)?;
        for i in 0..nlocals as u32 {
            saved
                .lock()
                .unwrap()
                .insert(indices.get_local(function, i)?, i);
        }
        Ok(())
    });
    let mut module = config.parse(&bytes).unwrap();
    let function = module
        .funcs
        .iter()
        .find(|f| f.name.as_deref() == Some("f"))
        .unwrap()
        .id();
    let users = collect_user_locals(&module, function);
    let mut scalars: Vec<_> = users
        .iter()
        .copied()
        .filter(|(_, ty)| is_scalar(*ty))
        .collect();
    let user_count = scalars.len();
    let mut keys = capture.lock().unwrap().clone();
    for i in 0..spills {
        let (old, new) = match i % 5 {
            0 => (ValType::I32, wasm_encoder::ValType::I32),
            1 => (ValType::I64, wasm_encoder::ValType::I64),
            2 => (ValType::F32, wasm_encoder::ValType::F32),
            3 => (ValType::F64, wasm_encoder::ValType::F64),
            _ => (ValType::V128, wasm_encoder::ValType::V128),
        };
        let id = module.locals.add(old);
        let key = builder.saved(new).unwrap();
        keys.insert(id, key.0);
        scalars.push((id, old));
    }
    let layout = builder.finish().unwrap();
    assert_eq!(
        layout
            .locals()
            .iter()
            .filter_map(|v| v.source)
            .collect::<Vec<_>>(),
        users
            .iter()
            .map(|(local, _)| keys[local])
            .collect::<Vec<_>>()
    );
    let pointer = if environment.pointer == wasm_encoder::ValType::I64 {
        ValType::I64
    } else {
        ValType::I32
    };
    let (fields, storage) = plan_frame_layout(&mut module, pointer, &scalars, user_count);
    let old: Vec<_> = fields
        .iter()
        .map(|(key, ty, off)| (keys[key], format!("{ty:?}"), *off))
        .collect();
    let new: Vec<_> = layout
        .fields
        .iter()
        .map(|f| (f.local.0, format!("{:?}", f.ty), f.offset))
        .collect();
    assert_eq!(new, old, "fields: {source}");
    assert_eq!(layout.size, HEADER_SIZE + user_locals_size(&scalars));
    assert_eq!(layout.scratch.is_some(), storage.scratch().is_some());
    if let (Some(new), Some(old)) = (&layout.scratch, storage.scratch()) {
        assert_eq!(new.stack_pointer, old.stack_pointer.index() as u32);
        assert_eq!(
            (new.size, new.node_spill_start, new.spill_bytes),
            (old.size, old.node_spill_start, old.spill_bytes)
        );
        let expected: BTreeMap<_, _> = old
            .offsets
            .iter()
            .map(|(key, (ty, off))| (keys[key], (format!("{ty:?}"), *off)))
            .collect();
        let actual: BTreeMap<_, _> = new
            .offsets
            .iter()
            .map(|(key, (ty, off))| (key.0, (format!("{ty:?}"), *off)))
            .collect();
        assert_eq!(actual, expected);
    }
    let runtime = runtime::inject_linked_runtime(&mut module);
    let references = ReferenceFramePlan {
        slots: vec![],
        slots_by_call: vec![vec![]],
        null_locals_by_call: vec![vec![]],
    };
    let native_references = layout.reference_plan(&[vec![]], &[vec![]]).unwrap();
    for selector in [false, true] {
        let old = frame_codec_call(
            &mut module,
            &runtime,
            &mut FrameCodecs::default(),
            &fields,
            &storage,
            selector,
            &references,
        );
        let new = layout.codec_shape(selector, &native_references);
        assert_eq!(old.is_some(), new.is_some());
        if let (Some(old), Some(new)) = (old, new) {
            assert_eq!(old.commits, new.commits);
            assert_eq!(old.restored_scalars, new.restored_scalars);
            assert_eq!(
                old.locals
                    .iter()
                    .map(|(_, ty)| format!("{ty:?}"))
                    .collect::<Vec<_>>(),
                new.scalars
                    .iter()
                    .map(|ty| format!("{ty:?}"))
                    .collect::<Vec<_>>()
            );
        }
    }
}

#[test]
fn native_scalar_frame_layout_and_codec_policy_match_the_oracle() {
    for (memory, stack) in [
        ("(memory 1)", ""),
        (
            "(memory 1)",
            "(global $__stack_pointer (mut i32) (i32.const 4096))",
        ),
        (
            "(memory i64 1)",
            "(global (export \"__stack_pointer\") (mut i64) (i64.const 4096))",
        ),
        (
            "(memory 1)",
            "(global $__stack_pointer (mut i32) (i32.const 4096)) (global (export \"__stack_pointer\") (mut i64) (i64.const 4096))",
        ),
        (
            "(memory 1)",
            "(global $__stack_pointer i32 (i32.const 4096))",
        ),
    ] {
        for count in [0, 16, 40, 901] {
            compare(
                &format!(
                    r#"(module {memory} {stack}
              (func $f (param i32 i64 externref) (local i32 i64 f32 f64 v128 i32)
                local.get 4 drop local.get 3 drop local.get 6 drop local.get 5 drop local.get 7 drop local.get 8 drop))"#
                ),
                count,
            );
        }
    }
}

#[test]
fn native_user_local_discovery_matches_lexical_tail_and_detached_suffix_rules() {
    for body in [
        "return local.get 0 drop",
        "return_call $other local.get 0 drop",
        "block br 0 local.get 0 drop end local.get 1 drop",
        "i32.const 0 if return else local.get 1 drop end",
    ] {
        compare(
            &format!(
                r#"(module (import "h" "other" (func $other)) (memory 1)
          (func $f (local i32 i64) {body}))"#
            ),
            0,
        );
    }
}

#[test]
fn native_reference_frame_slots_null_restores_and_universal_prefix_match_the_oracle() {
    let bytes = wat::parse_str(
        r#"(module
      (import "h" "fork" (func $fork))
      (func $f (param externref) (local externref externref)
        local.get 0 local.set 1 ref.null extern local.set 2
        call $fork local.get 1 drop local.get 2 drop
        ref.null extern local.set 1
        call $fork local.get 0 drop local.get 1 drop))"#,
    )
    .unwrap();
    let scan = native::scan(&bytes).unwrap();
    let body = scan.body_provider(Default::default()).load(1).unwrap();
    let source_types = native::SourceTypes::new(&scan);
    let mut map = RoundtripReencoder;
    let environment = native::FrameEnvironment::discover(&scan, &mut map, 1 << 20).unwrap();
    let mut builder = native::FrameBuilder::new(
        &scan,
        &body,
        &source_types,
        &mut map,
        environment,
        Default::default(),
    )
    .unwrap();
    let reference = wasm_encoder::RefType {
        nullable: false,
        heap_type: wasm_encoder::HeapType::FUNC,
    };
    let synthetic = builder
        .saved(wasm_encoder::ValType::Ref(reference))
        .unwrap();
    let layout = builder.finish().unwrap();
    let new_analysis =
        native::analyze_references(&scan, &body, &BTreeSet::from([0]), Default::default()).unwrap();
    let mut per_call = vec![vec![native::LocalKey(0), synthetic]; 2];
    let mut nulls = vec![vec![]; 2];
    for (i, site) in new_analysis.landings.iter().enumerate() {
        for &key in &site.live_on_any_successor {
            if site.definitely_null_before.contains(&key) && new_analysis.locals[&key].is_nullable()
            {
                nulls[i].push(native::LocalKey(key));
            } else {
                per_call[i].push(native::LocalKey(key));
            }
        }
    }
    let new = layout.reference_plan(&per_call, &nulls).unwrap();
    let mut module = Module::from_buffer(&bytes).unwrap();
    let function = module
        .funcs
        .iter()
        .find(|f| f.name.as_deref() == Some("f"))
        .unwrap()
        .id();
    let seed = crate::call_graph::find_import_func(&module, "h.fork").unwrap();
    let analysis = crate::reference_analysis::analyze_function_references(
        &module,
        function,
        &HashSet::from([seed]),
    )
    .unwrap();
    let original = collect_user_locals(&module, function);
    let mut keys: BTreeMap<_, _> = original
        .iter()
        .enumerate()
        .map(|(i, (local, _))| (*local, i as u32))
        .collect();
    let reference = RefType {
        nullable: false,
        heap_type: HeapType::Abstract(walrus::AbstractHeapType::Func),
    };
    let local = module
        .locals
        .add(spill_storage_type(ValType::Ref(reference)));
    keys.insert(local, synthetic.0);
    let mut old_synthetic = vec![vec![(local, reference)]; 2];
    append_resume_parameter_references(&module, function, &mut old_synthetic);
    let old = plan_reference_frame(&module, &analysis, old_synthetic);
    assert_eq!(
        new.slots
            .iter()
            .map(|s| (s.local.0, s.ty.nullable, s.universal_position))
            .collect::<Vec<_>>(),
        old.slots
            .iter()
            .map(|s| (keys[&s.local], s.ty.nullable, s.universal_position))
            .collect::<Vec<_>>()
    );
    assert_eq!(new.slots_by_call, old.slots_by_call);
    assert_eq!(
        new.null_locals_by_call
            .iter()
            .map(|r| r
                .iter()
                .map(|(key, ty)| (key.0, ty.nullable))
                .collect::<Vec<_>>())
            .collect::<Vec<_>>(),
        old.null_locals_by_call
            .iter()
            .map(|r| r
                .iter()
                .map(|(key, ty)| (keys[key], ty.nullable))
                .collect::<Vec<_>>())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        layout.size, 16,
        "reference vectors occupy only reserved header word 12"
    );
}

#[test]
fn native_shared_scalar_codec_bodies_match_the_oracle_byte_for_byte() {
    for wide in [false, true] {
        for selector in [false, true] {
            for commits in [false, true] {
                for shape in [
                    vec![],
                    vec![
                        wasm_encoder::ValType::I64,
                        wasm_encoder::ValType::F64,
                        wasm_encoder::ValType::I32,
                        wasm_encoder::ValType::F32,
                    ],
                    vec![wasm_encoder::ValType::V128, wasm_encoder::ValType::I64],
                ] {
                    let bytes = wat::parse_str(if wide {
                        "(module (memory i64 1))"
                    } else {
                        "(module (memory 1))"
                    })
                    .unwrap();
                    let scan = native::scan(&bytes).unwrap();
                    let runtime =
                        native::NativeRuntime::plan(&scan, Default::default(), 1 << 20).unwrap();
                    let mut map = RoundtripReencoder;
                    let environment =
                        native::FrameEnvironment::discover(&scan, &mut map, 1 << 20).unwrap();
                    let mut catalog = native::FrameCodecCatalog::new(
                        environment,
                        runtime.indices(),
                        scan.types.as_ref().core_type_count_in_module()
                            + runtime.function_declarations().type_count(),
                        runtime.imports_plan().helper_function_base() + 7,
                        1 << 20,
                    )
                    .unwrap();
                    let key = native::FrameCodecShape {
                        scalars: shape.clone(),
                        catch_selector: selector,
                        commits,
                        restored_scalars: usize::from(!selector).min(shape.len()),
                    };
                    let pair = catalog.request(&key).unwrap();
                    assert_eq!(catalog.request(&key).unwrap(), pair);
                    let frozen = catalog.freeze().unwrap();
                    assert_eq!(frozen.declarations().function_count(), 2);
                    let old_types: Vec<_> = shape
                        .iter()
                        .map(|ty| match ty {
                            wasm_encoder::ValType::I32 => ValType::I32,
                            wasm_encoder::ValType::I64 => ValType::I64,
                            wasm_encoder::ValType::F32 => ValType::F32,
                            wasm_encoder::ValType::F64 => ValType::F64,
                            wasm_encoder::ValType::V128 => ValType::V128,
                            _ => unreachable!(),
                        })
                        .collect();
                    let mut old = Module::from_buffer(&bytes).unwrap();
                    let runtime = runtime::inject_linked_runtime(&mut old);
                    let save = emit_frame_save_helper(
                        &mut old,
                        &runtime,
                        &FrameCodecKey {
                            scalars: old_types.clone(),
                            catch_selector: selector,
                            commits,
                        },
                        0,
                    );
                    let restore =
                        emit_frame_restore_helper(&mut old, &runtime, &old_types, selector, 0);
                    old.exports.add("codec_save", save);
                    old.exports.add("codec_restore", restore);
                    let old = old.emit_wasm();
                    let scan = native::scan(&old).unwrap();
                    for (ordinal, name) in [(0, "codec_save"), (1, "codec_restore")] {
                        let index = scan.exports.iter().find(|(n, _, _)| n == name).unwrap().2;
                        let body = scan.body_provider(Default::default()).load(index).unwrap();
                        assert_eq!(
                            frozen
                                .emit_helper(ordinal, 1 << 20)
                                .unwrap()
                                .into_raw_body(),
                            body.source.as_bytes(),
                            "{name}, wide={wide}, selector={selector}, commits={commits}, shape={shape:?}"
                        );
                    }
                }
            }
        }
    }
}
