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

#[test]
fn deep_control_with_one_frame_slot_fits_the_default_sanity_ceiling() {
    // The estimate reserves up to 4,096 frame slots per control state, but
    // this function only writes one. It should retain precise frame analysis
    // without requiring an application-specific override or dropping tracking.
    let input = wat::parse_str(format!(
        "(module (memory 1)
          (global $sp (mut i32) (i32.const 100))
          (func (result i32)
            {} global.get $sp i32.const 9 i32.store {}
            global.get $sp i32.load))",
        "block ".repeat(80),
        "end ".repeat(80),
    ))
    .unwrap();
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
