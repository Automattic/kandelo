use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use fork_instrument::module_exception_codec;
use walrus::Module;

#[path = "support/streaming_exceptions.rs"]
mod native;

fn fixture_input(wide: bool) -> Vec<u8> {
    let source = r#"
        (module
          (import "env" "memory" (memory 2))
          (tag $test (export "test_tag") (param i32 i64))
          (tag $inner (export "inner_tag") (param i32))
          (tag $vector (export "vector_tag") (param v128))
          (tag $outer (export "outer_tag") (param (ref null exn))))
        "#;
    wat::parse_str(if wide {
        source.replace("(memory 2)", "(memory i64 2)")
    } else {
        source.into()
    })
    .expect("provider fixture WAT")
}

fn fixture_module() -> Vec<u8> {
    let input = fixture_input(false);
    let mut module = Module::from_buffer(&input).expect("provider fixture module");
    let memory = module.memories.iter().next().expect("provider memory").id();
    module_exception_codec::inject(&mut module, memory).expect("inject exception codec");
    module.emit_wasm()
}

fn helper_module() -> Vec<u8> {
    wat::parse_str(
        r#"
        (module
          (import "provider" "tag" (tag $test (param i32 i64)))
          (import "provider" "inner_tag" (tag $inner (param i32)))
          (import "provider" "vector_tag" (tag $vector (param v128)))
          (import "provider" "outer_tag"
            (tag $outer (param (ref null exn))))
          (import "provider" "encode"
            (func $encode (param (ref null exn)) (result i32)))
          (import "provider" "decode"
            (func $decode (param i32) (result (ref null exn))))

          (func (export "capture") (param i32 i64) (result i32)
            (local $exception (ref null exn))
            (block $caught (result i32 i64 (ref exn))
              (try_table (catch_ref $test $caught)
                (local.get 0)
                (local.get 1)
                (throw $test))
              unreachable)
            (local.set $exception)
            drop
            drop
            (local.get $exception)
            (call $encode))

          (func (export "payload_i32") (param i32) (result i32)
            (block $caught (result i32 i64)
              (try_table (catch $test $caught)
                (local.get 0)
                (call $decode)
                (ref.as_non_null)
                (throw_ref))
              unreachable)
            drop)

          (func (export "payload_i64") (param i32) (result i64)
            (local $value i64)
            (block $caught (result i32 i64)
              (try_table (catch $test $caught)
                (local.get 0)
                (call $decode)
                (ref.as_non_null)
                (throw_ref))
              unreachable)
            (local.set $value)
            drop
            (local.get $value))

          (func (export "throw_decoded") (param i32)
            (local.get 0)
            (call $decode)
            (ref.as_non_null)
            (throw_ref))

          (func (export "capture_nested") (param i32) (result i32)
            (local $inner_exception (ref null exn))
            (local $outer_exception (ref null exn))
            (block $caught_inner (result i32 (ref exn))
              (try_table (catch_ref $inner $caught_inner)
                (local.get 0)
                (throw $inner))
              unreachable)
            (local.set $inner_exception)
            drop
            (block $caught_outer (result (ref null exn) (ref exn))
              (try_table (catch_ref $outer $caught_outer)
                (local.get $inner_exception)
                (throw $outer))
              unreachable)
            (local.set $outer_exception)
            drop
            (local.get $outer_exception)
            (call $encode))

          (func (export "capture_vector") (result i32)
            (local $exception (ref null exn))
            block $caught (result v128 (ref exn))
              try_table (catch_ref $vector $caught)
                v128.const i64x2 0x102030405060708 0x1122334455667788
                throw $vector
              end
              unreachable
            end
            local.set $exception drop
            local.get $exception call $encode)

          (func (export "vector_high") (param i32) (result i64)
            block $caught (result v128)
              try_table (catch $vector $caught)
                local.get 0 call $decode ref.as_non_null throw_ref
              end
              unreachable
            end
            i64x2.extract_lane 1)

          (func (export "nested_payload") (param i32) (result i32)
            (block $caught_inner (result i32)
              (try_table (catch $inner $caught_inner)
                (block $caught_outer (result (ref null exn))
                  (try_table (catch $outer $caught_outer)
                    (local.get 0)
                    (call $decode)
                    (ref.as_non_null)
                    (throw_ref))
                  unreachable)
                (ref.as_non_null)
                (throw_ref))
              unreachable)))
        "#,
    )
    .expect("consumer helper WAT")
}

fn anyref_dependencies() -> Vec<u8> {
    wat::parse_str(
        r#"
        (module
          (func (export "encode") (param (ref null any)) (result i32)
            unreachable)
          (func (export "decode") (param i32) (result (ref null any))
            unreachable))
        "#,
    )
    .expect("anyref dependency WAT")
}

#[test]
fn fresh_node_instance_reconstructs_exact_tag_and_alias_identity() {
    run_node(fixture_module(), false);
}

#[test]
fn native_exact_tag_codec_reconstructs_aliases_and_nested_exceptions_on_both_widths() {
    for wide in [false, true] {
        let input = fixture_input(wide);
        let output = native::emit(&input);
        assert_eq!(native::emit(&input), output);
        run_node(output, wide);
    }
}

fn run_node(provider: Vec<u8>, wide: bool) {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "kandelo-module-exception-codec-{}-{nonce}",
        std::process::id(),
    ));
    fs::create_dir(&directory).expect("create fixture directory");
    fs::write(directory.join("provider.wasm"), provider).expect("write provider");
    let memory = wat::parse_str(format!(
        "(module (memory (export \"memory\") {} 2))",
        if wide { "i64" } else { "" }
    ))
    .unwrap();
    fs::write(directory.join("memory.wasm"), memory).expect("write memory factory");
    fs::write(directory.join("helper.wasm"), helper_module()).expect("write helper");
    fs::write(directory.join("anyref.wasm"), anyref_dependencies()).expect("write anyref");
    fs::write(
        directory.join("test.mjs"),
        include_str!("fixtures/streaming_exception_codec.mjs"),
    )
    .expect("write Node test");

    let output = Command::new("node")
        .arg(directory.join("test.mjs"))
        .output()
        .expect("run Node");
    let _ = fs::remove_dir_all(&directory);
    assert!(
        output.status.success(),
        "Node fresh-instance codec test failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}
