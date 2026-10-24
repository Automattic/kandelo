#[path = "support/streaming_legacy_extra.rs"]
mod extra;
#[path = "support/streaming_gc.rs"]
mod native;
#[path = "support/module_state_oracle.rs"]
mod oracle;

const FORK: &str = "i32.const 3 call $fork local.set $fork_result";

#[test]
fn legacy_control_preserves_handlers_exits_and_delegates_during_replay() {
    let cases = [
        (
            "try body",
            format!("try (result i32) {FORK} i32.const 5 catch $e drop i32.const 99 end"),
        ),
        (
            "function delegate",
            format!("try {FORK} delegate 0 i32.const 5"),
        ),
        (
            "nested rethrow",
            format!(
                r#"
          block $caught (result i32)
            try_table (catch $e $caught)
              try $outer
                i32.const 5 throw $e
              catch $e
                drop
                try
                  i32.const 9 throw $f
                catch $f
                  drop {FORK} rethrow $outer
                end
              end
            end
            unreachable
          end"#
            ),
        ),
        (
            "sibling arms",
            format!(
                r#"
          try (result i32)
            local.get $case
            if i32.const 5 throw $e else i32.const 5 throw $f end
            unreachable
          catch $e drop {FORK} i32.const 5
          catch $f drop {FORK} i32.const 5
          catch_all {FORK} i32.const 99
          end"#
            ),
        ),
        (
            "catch all rethrow",
            format!(
                r#"
          block $caught (result i32)
            try_table (catch $e $caught)
              try $owner
                i32.const 5 throw $e
              catch_all
                {FORK} rethrow $owner
              end
            end
            unreachable
          end"#
            ),
        ),
        (
            "typed branch table",
            format!(
                r#"
          block $outside (result i32)
            try (result i32)
              i32.const 9 throw $e
            catch $e
              drop {FORK}
              block $inside (result i32)
                i32.const 5 local.get $case br_table $inside $outside $inside
              end
            end
          end"#
            ),
        ),
        (
            "reference branch",
            format!(
                r#"
          block $outside
            try
              i32.const 9 throw $e
            catch $e
              drop {FORK} ref.null any br_on_null $outside drop
            end
          end
          i32.const 5"#
            ),
        ),
        (
            "delegate to outer handler",
            format!(
                r#"
          try $outer (result i32)
            try {FORK} i32.const 5 throw $e delegate $outer
            unreachable
          catch $e
            nop
          end"#
            ),
        ),
        (
            "reused rethrow context",
            format!(
                r#"
          block $caught (result i32)
            try_table (catch $e $caught)
              try $owner
                i32.const 5 throw $e
              catch $e
                drop
                block $first (result i32)
                  try_table (catch $e $first) rethrow $owner end
                  unreachable
                end
                drop {FORK} rethrow $owner
              end
            end
            unreachable
          end"#
            ),
        ),
        (
            "brokered catch all",
            format!(
                r#"
          block $caught
            try_table (catch_all $caught)
              try $owner call $raise
              catch_all {FORK} rethrow $owner
              end
            end
            unreachable
          end
          i32.const 5"#
            ),
        ),
        (
            "modern catch exits a legacy arm",
            format!(
                r#"
          block $outside (result i32)
            try (result i32)
              i32.const 9 throw $f
            catch $f
              drop {FORK}
              try_table (catch $e $outside) i32.const 5 throw $e end
              unreachable
            end
          end"#
            ),
        ),
    ];
    for (name, body) in cases.into_iter().chain(extra::cases(FORK)) {
        for wide in [false, true] {
            let input = wat::parse_str(
                include_str!("fixtures/streaming_legacy_control.wat")
                    .replace("@WIDTH@", if wide { "i64" } else { "" })
                    .replace("@BODY@", &body),
            )
            .unwrap();
            for shared in [false, true] {
                let output = native::emit_activations(&input, shared);
                assert_eq!(output, native::emit_activations(&input, shared));
                assert_no_legacy(&output);
                run(&input, &output, wide).unwrap_or_else(|error| {
                    panic!("{name}, memory64={wide}, shared={shared}: {error}")
                });
            }
            // Representative delegate failures are asserted below. These
            // extra target scopes and the known typed-input oracle defect
            // use raw-source execution plus strict native replay assertions.
            if name.starts_with("delegate target ") || name.starts_with("typed legacy ") {
                continue;
            }
            let result = run(&input, &oracle::emit_activations(&input), wide);
            if name == "function delegate" {
                // The unchanged oracle lets delegate bypass activation capture.
                // Native uses the same strict one-frame assertion above.
                let error = result.expect_err("known oracle delegate defect");
                assert!(
                    error.contains("delegate must not skip activation capture"),
                    "{error}"
                );
            } else if name == "delegate to outer handler" {
                let error = result.expect_err("known oracle outer-delegate defect");
                assert!(
                    error.contains("Exception [WebAssembly.Exception]"),
                    "{error}"
                );
            } else if name == "reused rethrow context" {
                let error = result.expect_err("known oracle eager exception cleanup defect");
                assert!(error.contains("RuntimeError"), "{error}");
            } else {
                result.unwrap_or_else(|error| panic!("{name}, memory64={wide}, Walrus: {error}"));
            }
        }
    }
}

fn run(input: &[u8], output: &[u8], wide: bool) -> Result<(), String> {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("provider.wasm"), output).unwrap();
    std::fs::write(directory.path().join("original.wasm"), input).unwrap();
    std::fs::write(
        directory.path().join("transit.wasm"),
        wat::parse_str("(module (table (export \"transit\") 128 anyref))").unwrap(),
    )
    .unwrap();
    for (name, source) in [
        (
            "test.mjs",
            include_str!("fixtures/streaming_legacy_control.mjs"),
        ),
        (
            "gc_recipe_host.mjs",
            include_str!("fixtures/gc_recipe_host.mjs"),
        ),
        (
            "exception_recipe_host.cjs",
            include_str!("fixtures/exception_recipe_host.cjs"),
        ),
        (
            "table_record_host.cjs",
            include_str!("fixtures/table_record_host.cjs"),
        ),
        (
            "activation_frame_host.cjs",
            include_str!("fixtures/activation_frame_host.cjs"),
        ),
    ] {
        std::fs::write(directory.path().join(name), source).unwrap();
    }
    let result = std::process::Command::new("node")
        .arg(directory.path().join("test.mjs"))
        .arg(if wide { "1" } else { "0" })
        .output()
        .unwrap();
    if result.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&result.stderr).into_owned())
    }
}

fn assert_no_legacy(output: &[u8]) {
    for payload in wasmparser::Parser::new(0).parse_all(output) {
        if let wasmparser::Payload::CodeSectionEntry(body) = payload.unwrap() {
            let mut reader = body.get_operators_reader().unwrap();
            while !reader.eof() {
                use wasmparser::Operator::*;
                assert!(!matches!(
                    reader.read().unwrap(),
                    Try { .. } | Catch { .. } | CatchAll | Delegate { .. } | Rethrow { .. }
                ));
            }
        }
    }
}
