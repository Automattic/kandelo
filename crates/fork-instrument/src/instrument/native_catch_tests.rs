//! Compare native ownership and pooling with the unchanged Walrus transform.
use super::*;
use crate::streaming as native;
use std::collections::BTreeMap;
use wasm_encoder::{ValType as NativeType, reencode::RoundtripReencoder};

fn fixture(repetitions: usize) -> Vec<u8> {
    let mut regions = String::new();
    for _ in 0..repetitions {
        for (clause, results, drops) in [
            ("catch $a", "i32 i32 f64", 3),
            ("catch_ref $b", "i64 i32 (ref exn)", 3),
            ("catch $c", "externref externref", 2),
            ("catch_ref $d", "v128 (ref exn)", 2),
            ("catch $e", "(ref func)", 1),
            ("catch_all", "", 0),
            ("catch_all_ref", "(ref exn)", 1),
        ] {
            regions.push_str(&format!(
                "block $handler (result {results})\n\
                   try_table ({clause} $handler) unreachable end unreachable\n\
                 end {}\n",
                "drop ".repeat(drops),
            ));
        }
    }
    wat::parse_str(format!(
        "(module (tag $a (param i32 i32 f64)) (tag $b (param i64 i32))\n\
         (tag $c (param externref externref)) (tag $d (param v128))\n\
         (tag $e (param (ref func))) (func $f {regions}))"
    ))
    .unwrap()
}

fn native_type(ty: ValType) -> NativeType {
    match ty {
        ValType::I32 => NativeType::I32,
        ValType::I64 => NativeType::I64,
        ValType::F32 => NativeType::F32,
        ValType::F64 => NativeType::F64,
        ValType::V128 => NativeType::V128,
        ValType::Ref(reference) => {
            let heap_type = match reference.heap_type {
                HeapType::Abstract(AbstractHeapType::Func) => wasm_encoder::HeapType::FUNC,
                HeapType::Abstract(AbstractHeapType::Extern) => wasm_encoder::HeapType::EXTERN,
                HeapType::Abstract(AbstractHeapType::Exn) => {
                    wasm_encoder::RefType::EXNREF.heap_type
                }
                other => panic!("unexpected fixture reference {other:?}"),
            };
            NativeType::Ref(wasm_encoder::RefType {
                nullable: reference.nullable,
                heap_type,
            })
        }
    }
}

/// Compare sharing without depending on either backend's local numbering.
fn alias_pattern<T: Ord + Copy>(values: impl IntoIterator<Item = T>) -> Vec<usize> {
    let mut ordinals = BTreeMap::new();
    values
        .into_iter()
        .map(|value| {
            let next = ordinals.len();
            *ordinals.entry(value).or_insert(next)
        })
        .collect()
}

#[test]
fn native_catch_selectors_payload_union_and_reference_ownership_match_the_oracle() {
    let mut first_local_count = None;
    for repetitions in [1, 64] {
        let bytes = fixture(repetitions);
        let scan = native::scan(&bytes).unwrap();
        let body = scan.body_provider(Default::default()).load(0).unwrap();
        let types = native::SourceTypes::new(&scan);
        let mut map = RoundtripReencoder;
        let environment = native::FrameEnvironment::discover(&scan, &mut map, 1 << 20).unwrap();
        let mut catches =
            native::NativeCatchPlan::discover(&scan, &body, &types, &mut map, Default::default())
                .unwrap();
        let mut builder = native::FrameBuilder::new(
            &scan,
            &body,
            &types,
            &mut map,
            environment,
            Default::default(),
        )
        .unwrap();
        let mut references = vec![vec![]; 3];
        catches.allocate(&mut builder, &mut references).unwrap();
        let frame = builder.finish().unwrap();

        let mut module = Module::from_buffer(&bytes).unwrap();
        let function = module.funcs.iter_local().next().unwrap().0;
        let discovery = discover_plain_catch_arms(&module, function);
        let old = allocate_plain_catch_state(&mut module, &discovery);
        let old_frame = plan_plain_catch_scalar_frame(&old, HEADER_SIZE);
        assert_eq!(frame.size, old_frame.frame_end(HEADER_SIZE));
        assert_eq!(catches.regions.len(), old.len());
        assert_eq!(frame.catch.len(), old_frame.arms.len());
        for (region, previous) in catches.regions.values().zip(&old) {
            assert_eq!(region.selectors.start, previous.first_selector);
            assert_eq!(region.selectors.end, previous.last_selector + 1);
            for (arm, previous) in region.arms.iter().zip(&previous.arms) {
                assert_eq!(arm.selector, previous.selector);
                assert_eq!(arm.is_ref(), previous.arm.kind.is_ref());
                assert_eq!(
                    arm.uses_exception_recipe,
                    previous.arm.uses_exception_recipe
                );
                assert_eq!(
                    arm.payload,
                    previous
                        .arm
                        .operand_tys
                        .iter()
                        .copied()
                        .map(native_type)
                        .collect::<Vec<_>>()
                );
                assert_eq!(
                    arm.operands
                        .iter()
                        .map(|&key| frame.local(key).unwrap().ty)
                        .collect::<Vec<_>>(),
                    previous
                        .operand_locals
                        .iter()
                        .map(|&key| native_type(module.locals.get(key).ty()))
                        .collect::<Vec<_>>(),
                );
                assert_eq!(
                    previous.captured_exnref.is_some(),
                    arm.uses_exception_recipe || arm.is_ref()
                );
            }
        }
        for (arm, previous) in frame.catch.iter().zip(&old_frame.arms) {
            assert_eq!(arm.selector, previous.selector);
            assert_eq!(
                arm.fields
                    .iter()
                    .map(|field| (field.ty, field.offset))
                    .collect::<Vec<_>>(),
                previous
                    .fields
                    .iter()
                    .map(|&(_, ty, offset)| (native_type(ty), offset))
                    .collect::<Vec<_>>(),
            );
        }
        let new_operands = catches
            .regions
            .values()
            .flat_map(|region| &region.arms)
            .flat_map(|arm| arm.operands.iter().copied());
        let old_operands = old
            .iter()
            .flat_map(|region| &region.arms)
            .flat_map(|arm| arm.operand_locals.iter().copied());
        assert_eq!(alias_pattern(new_operands), alias_pattern(old_operands));
        let retained = catches.retained_exception.unwrap();
        let forwarding = catches.forwarding_exception.unwrap();
        assert_ne!(retained, forwarding);
        for landing in references {
            assert_eq!(
                landing,
                [retained],
                "only the complete recipe survives a call"
            );
        }
        assert_eq!(
            frame.locals().len(),
            *first_local_count.get_or_insert(frame.locals().len()),
            "static catch-region count must not increase physical local storage"
        );
    }
}
