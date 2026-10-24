//! A conservative preflight estimate must leave room for ordinary deep CFGs.
use fork_instrument::streaming::{scan, sink::*};

struct NoCalls;
impl Environment for NoCalls {
    fn call(
        &mut self,
        _: fork_instrument::streaming::ProgramPoint,
        _: Invocation,
        _: Value,
        _: &[Value],
        _: bool,
    ) -> anyhow::Result<CallEffect> {
        unreachable!("this fixture has no calls")
    }
    fn stack_pointer_global(&self) -> Option<u32> {
        Some(0)
    }
}

fn one_slot_function(depth: usize) -> Vec<u8> {
    wat::parse_str(format!(
        "(module (memory 1)
          (global $sp (mut i32) (i32.const 100))
          (func (result i32)
            {} global.get $sp i32.const 9 i32.store {}
            global.get $sp i32.load))",
        "block ".repeat(depth),
        "end ".repeat(depth),
    ))
    .unwrap()
}

#[test]
fn deep_control_with_one_frame_slot_fits_the_default_sanity_ceiling() {
    // The estimate reserves up to 4,096 frame slots per control state, but
    // this function only writes one. It should retain precise frame analysis
    // without requiring an application-specific override or dropping tracking.
    let input = one_slot_function(80);
    let scan = scan(&input).unwrap();
    let body = scan.body_provider(Default::default()).load(0).unwrap();
    let result = evaluate(
        &scan,
        &body,
        &mut NoCalls,
        Options::default(),
        Limits::default(),
    )
    .unwrap();
    assert_eq!(result.returned, Some(Value::Constant(9)));
    assert!(!result.frame_escaped);
    assert!(!result.unsupported);

    // Explicit resource limits remain effective, with an actionable identity.
    let error = evaluate(
        &scan,
        &body,
        &mut NoCalls,
        Options::default(),
        Limits {
            state_values: 8 * 1024 * 1024,
            ..Default::default()
        },
    )
    .unwrap_err();
    let message = error.to_string();
    assert!(
        message.contains("state-value budget for function 0"),
        "{message}"
    );
    assert!(message.contains("estimated"), "{message}");
}

#[test]
fn thousands_of_control_regions_work_on_a_small_calling_thread_stack() {
    let input = one_slot_function(2_000);
    std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(move || {
            let scan = scan(&input).unwrap();
            let body = scan.body_provider(Default::default()).load(0).unwrap();
            let output = evaluate(
                &scan,
                &body,
                &mut NoCalls,
                Options::default(),
                Limits::default(),
            )
            .unwrap();
            assert_eq!(output.returned, Some(Value::Constant(9)));
            assert!(!output.frame_escaped);
            assert!(!output.unsupported);

            let error = evaluate(
                &scan,
                &body,
                &mut NoCalls,
                Options::default(),
                Limits {
                    control_depth: 256,
                    ..Default::default()
                },
            )
            .unwrap_err();
            assert!(error.to_string().contains("depth 2000, limit 256"));
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn a_deep_fork_body_passes_the_complete_native_pipeline() {
    let input = wat::parse_str(format!(
        "(module
          (import \"kernel\" \"kernel_fork\" (func $fork (param i32) (result i32)))
          (memory 1)
          (global $sp (export \"__stack_pointer\") (mut i32) (i32.const 100))
          (func (export \"root\") (result i32)
            {} global.get $sp i32.const 9 i32.store
            i32.const 0 call $fork drop {}
            global.get $sp i32.load))",
        "block ".repeat(2_000),
        "end ".repeat(2_000),
    ))
    .unwrap();
    for sinks in [false, true] {
        let output = fork_instrument::native::instrument(
            &input,
            &fork_instrument::Options {
                sinks,
                ..Default::default()
            },
            Default::default(),
        )
        .unwrap();
        assert!(output.decision.participates);
        assert!(output.emission.is_some());
        fork_instrument::native::validate(output.bytes.bytes()).unwrap();
    }
}
