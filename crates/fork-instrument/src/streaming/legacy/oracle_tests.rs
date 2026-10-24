//! Compare ownership decisions with the unchanged production normalizer.
use super::*;

pub(super) fn compare(input: &[u8], plan: &LegacyHandlerPlan) {
    let mut oracle = walrus::Module::from_buffer(input).unwrap();
    let function = oracle.funcs.iter_local().next().unwrap().0;
    crate::legacy_eh::normalize_fork_path(
        &mut oracle,
        &std::collections::HashSet::from([function]),
    )
    .unwrap();
    let output = oracle.emit_wasm();
    let scan = crate::streaming::scan(&output).unwrap();
    let body = scan.body_provider(Default::default()).load(0).unwrap();
    let exception_locals = body
        .locals
        .iter()
        .filter(|&&ty| ty == wasmparser::ValType::EXNREF)
        .count();
    assert_eq!(exception_locals, plan.handlers.len());

    let mut expected: Vec<_> = plan
        .rethrows()
        .iter()
        .map(|rethrow| plan.cleanup_handlers(rethrow.cleanup).count())
        .collect();
    let mut actual = Vec::new();
    for (index, instruction) in body.instructions.iter().enumerate() {
        let Operator::LocalGet { local_index } = instruction.operation else {
            continue;
        };
        if !body
            .instructions
            .get(index + 1)
            .is_some_and(|next| matches!(next.operation, Operator::RefAsNonNull))
        {
            continue;
        }
        let mut cursor = index + 2;
        let mut cleared = Vec::new();
        while let [null, set, ..] = &body.instructions[cursor..] {
            let Operator::RefNull { hty } = null.operation else {
                break;
            };
            assert_eq!(hty, wasmparser::RefType::EXNREF.heap_type());
            let Operator::LocalSet { local_index } = set.operation else {
                panic!("oracle exception cleanup must clear an owned local");
            };
            assert!(!cleared.contains(&local_index));
            cleared.push(local_index);
            cursor += 2;
        }
        assert!(matches!(
            body.instructions[cursor].operation,
            Operator::ThrowRef
        ));
        // Rethrowing an ancestor must clear that ancestor after inner owners.
        assert_eq!(cleared.last(), Some(&local_index));
        actual.push(cleared.len());
    }
    expected.sort_unstable();
    actual.sort_unstable();
    assert_eq!(actual, expected);
}
