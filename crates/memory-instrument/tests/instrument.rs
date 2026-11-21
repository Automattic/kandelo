use memory_instrument::{Crossing, Options, Role, instrument};

fn program(body: &str) -> Vec<u8> {
    wat::parse_str(format!(
        r#"(module
            (import "env" "memory" (memory 1 100 shared))
            (global $heap_base i32 (i32.const 65552))
            (export "__heap_base" (global $heap_base))
            (data $foo "foo")
            {body})"#
    ))
    .expect("wat parse")
}

fn rewrite(bytes: &[u8], crossing: Crossing) -> String {
    let options = Options {
        crossing,
        role: Role::Program,
    };
    let output = instrument(bytes, &options).expect("instrument");
    wasmprinter::print_bytes(output).expect("print")
}

#[test]
fn places_the_table_after_the_linker_heap_base() {
    let text = rewrite(&program("(func)"), Crossing::Strict);

    assert!(
        text.contains("(global $heap_base (;0;) i32 i32.const 655360)"),
        "{text}"
    );
    assert!(text.contains("(memory (;0;) 10 65536 shared)"), "{text}");
}

#[test]
fn keeps_the_maximum_of_a_defined_memory() {
    let source = wat::parse_str(
        r#"(module
            (memory 1 100)
            (global i32 (i32.const 65552))
            (export "__heap_base" (global 0))
            (func))"#,
    )
    .expect("wat parse");

    let text = rewrite(&source, Crossing::Strict);

    assert!(text.contains("(memory (;0;) 10 100)"), "{text}");
}

#[test]
fn exports_the_table_group_and_stop_bases_as_mutable_globals() {
    let text = rewrite(&program("(func)"), Crossing::Strict);

    assert!(
        text.contains("(global (;1;) (mut i32) i32.const 131072)"),
        "{text}"
    );
    assert!(
        text.contains("(global (;2;) (mut i32) i32.const 0)"),
        "{text}"
    );
    assert!(
        text.contains("(export \"__memory_table_base\" (global 1))"),
        "{text}"
    );
    assert!(
        text.contains("(export \"__memory_group_base\" (global 2))"),
        "{text}"
    );
    assert!(
        text.contains("(global (;3;) (mut i32) i32.const 131072)"),
        "{text}"
    );
    assert!(
        text.contains("(export \"__memory_stop_base\" (global 3))"),
        "{text}"
    );
}

#[test]
fn stop_helper_acknowledges_the_request_and_waits_until_it_clears() {
    let text = rewrite(&program("(func)"), Crossing::Aligned);

    assert!(
        text.contains(
            "local.get 0\n      i32.atomic.store offset=4\n      global.get 3\n      i32.const 1\n      memory.atomic.notify offset=4\n      drop\n      global.get 3\n      local.get 0\n      i64.const -1\n      memory.atomic.wait32\n      drop\n      br 0"
        ),
        "{text}"
    );
}

#[test]
fn translates_a_load_through_the_table() {
    let text = rewrite(
        &program("(func (param i32) (result i32) local.get 0 i32.load offset=8)"),
        Crossing::Aligned,
    );

    assert!(
        text.contains("global.get 1\n    i32.add\n    i32.load\n"),
        "{text}"
    );
    assert!(!text.contains("i32.const -65536"), "{text}");
    assert!(text.contains("i32.load offset=8"), "{text}");
}

#[test]
fn checks_copy_on_write_before_a_store() {
    let text = rewrite(
        &program("(func (param i32 i64) local.get 0 local.get 1 i64.store)"),
        Crossing::Aligned,
    );

    assert!(
        text.contains("global.get 1\n    i32.add\n    i32.load offset=262144\n    local.tee 3\n    i32.const 1\n    i32.and\n    if ;; label = @1\n      local.get 2\n      call 3"),
        "{text}"
    );
}

#[test]
fn copy_on_write_fault_waits_for_a_locked_page_and_locks_it_before_it_copies() {
    let text = rewrite(&program("(func)"), Crossing::Strict);

    assert!(
        text.contains("local.get 6\n      i32.const 2\n      i32.and\n      if ;; label = @2\n        call 8\n        br 1 (;@1;)\n      end"),
        "{text}"
    );
    assert!(
        text.contains("i32.const 2\n      i32.or\n      i32.atomic.rmw.cmpxchg offset=262144\n      local.get 6\n      i32.ne\n      br_if 0 (;@1;)"),
        "{text}"
    );
}

#[test]
fn copy_on_write_fault_writes_in_place_for_a_sole_owner() {
    let text = rewrite(&program("(func)"), Crossing::Strict);

    assert!(
        text.contains("global.get 2\n    i32.add\n    local.tee 5\n    i32.atomic.load offset=65536\n    i32.eqz\n    if ;; label = @1\n      local.get 1\n      local.get 2\n      i32.atomic.store offset=262144\n      local.get 2\n      return"),
        "{text}"
    );
}

#[test]
fn copy_on_write_fault_copies_a_shared_page_to_a_new_physical_page() {
    let text = rewrite(&program("(func)"), Crossing::Strict);

    assert!(
        text.contains("global.get 2\n    i32.const 1\n    i32.atomic.rmw.add\n    local.set 4"),
        "{text}"
    );
    assert!(text.contains("memory.grow"), "{text}");
    assert!(text.contains("i32.const 65536\n    memory.copy"), "{text}");
    assert!(
        text.contains("local.get 1\n    local.get 2\n    i32.atomic.store\n    local.get 1\n    local.get 2\n    i32.atomic.store offset=262144\n    local.get 5\n    i32.const 1\n    i32.atomic.rmw.sub offset=65536"),
        "{text}"
    );
}

#[test]
fn strict_mode_checks_every_multi_byte_access_for_page_crossing() {
    let source = program("(func (param i32) (result i32) local.get 0 i32.load)");

    assert!(rewrite(&source, Crossing::Strict).contains("call 4"));
    assert!(!rewrite(&source, Crossing::Aligned).contains("call 4"));
}

#[test]
fn aligned_mode_checks_accesses_with_a_weaker_alignment_hint() {
    let text = rewrite(
        &program("(func (param i32) (result i32) local.get 0 i32.load align=1)"),
        Crossing::Aligned,
    );

    assert!(text.contains("call 4"), "{text}");
}

#[test]
fn strict_mode_sends_a_crossing_store_to_the_byte_wise_helper() {
    let text = rewrite(
        &program("(func (param i32 i64) local.get 0 local.get 1 i64.store)"),
        Crossing::Strict,
    );

    assert!(
        text.contains("i32.const 65528\n    i32.gt_u\n    if ;; label = @1\n      local.get 2\n      i32.const 8\n      local.get 6\n      call 5\n    else"),
        "{text}"
    );
}

#[test]
fn strict_mode_widens_a_float_store_for_the_byte_wise_helper() {
    let single = rewrite(
        &program("(func (param i32 f32) local.get 0 local.get 1 f32.store)"),
        Crossing::Strict,
    );
    let double = rewrite(
        &program("(func (param i32 f64) local.get 0 local.get 1 f64.store)"),
        Crossing::Strict,
    );

    assert!(
        single.contains("i32.const 4\n      local.get 8\n      i32.reinterpret_f32\n      i64.extend_i32_u\n      call 5"),
        "{single}"
    );
    assert!(
        double.contains("i32.const 8\n      local.get 9\n      i64.reinterpret_f64\n      call 5"),
        "{double}"
    );
}

#[test]
fn strict_mode_narrows_the_bytes_of_a_crossing_load_to_the_result_type() {
    let narrowed = [
        (
            "(result i32)",
            "i32.load16_s",
            "call 4\n      i32.wrap_i64\n      i32.extend16_s",
        ),
        (
            "(result i64)",
            "i64.load16_s",
            "call 4\n      i64.extend16_s",
        ),
        (
            "(result i64)",
            "i64.load32_s",
            "call 4\n      i64.extend32_s",
        ),
        (
            "(result f32)",
            "f32.load",
            "call 4\n      i32.wrap_i64\n      f32.reinterpret_i32",
        ),
        (
            "(result f64)",
            "f64.load",
            "call 4\n      f64.reinterpret_i64",
        ),
    ];

    for (result, load, expected) in narrowed {
        let text = rewrite(
            &program(&format!("(func (param i32) {result} local.get 0 {load})")),
            Crossing::Strict,
        );

        assert!(text.contains(expected), "{load}: {text}");
    }
}

#[test]
fn strict_mode_adds_no_crossing_check_to_a_single_byte_access() {
    let text = rewrite(
        &program(
            "(func (param i32 i32) (result i32)
                local.get 0 local.get 1 i32.store8
                local.get 0 i32.load8_u)",
        ),
        Crossing::Strict,
    );

    assert!(!text.contains("i32.gt_u\n    if"), "{text}");
    assert!(text.contains("i32.store8"), "{text}");
    assert!(text.contains("i32.load8_u"), "{text}");
}

#[test]
fn translates_an_atomic_load_through_the_read_table_without_a_crossing_check() {
    let text = rewrite(
        &program("(func (param i32) (result i32) local.get 0 i32.atomic.load)"),
        Crossing::Strict,
    );

    assert!(
        text.contains(
            "global.get 1\n    i32.add\n    i32.load\n    i32.add\n    i32.atomic.load\n"
        ),
        "{text}"
    );
    assert!(!text.contains("call 4"), "{text}");
}

#[test]
fn checks_copy_on_write_before_an_atomic_store_and_a_compare_exchange() {
    let store = rewrite(
        &program("(func (param i32 i32) local.get 0 local.get 1 i32.atomic.store)"),
        Crossing::Strict,
    );
    let exchange = rewrite(
        &program(
            "(func (param i32 i32 i32) (result i32)
                local.get 0 local.get 1 local.get 2 i32.atomic.rmw.cmpxchg)",
        ),
        Crossing::Strict,
    );

    assert!(
        store.contains("i32.load offset=262144\n    local.tee 3\n    i32.const 1\n    i32.and\n    if ;; label = @1\n      local.get 2\n      call 3\n      local.set 3\n    end\n    local.get 3\n    i32.add\n    local.get 4\n    i32.atomic.store\n"),
        "{store}"
    );
    assert!(
        exchange.contains("call 3\n      local.set 4\n    end\n    local.get 4\n    i32.add\n    local.get 5\n    local.get 6\n    i32.atomic.rmw.cmpxchg\n"),
        "{exchange}"
    );
}

#[test]
fn translates_wait_and_notify_through_the_read_table() {
    let wait = rewrite(
        &program(
            "(func (param i32 i32 i64) (result i32)
                local.get 0 local.get 1 local.get 2 memory.atomic.wait32)",
        ),
        Crossing::Strict,
    );
    let notify = rewrite(
        &program(
            "(func (param i32 i32) (result i32) local.get 0 local.get 1 memory.atomic.notify)",
        ),
        Crossing::Strict,
    );

    assert!(
        wait.contains("global.get 1\n    i32.add\n    i32.load\n    i32.add\n    local.get 5\n    local.get 7\n    memory.atomic.wait32\n"),
        "{wait}"
    );
    assert!(
        notify.contains("global.get 1\n    i32.add\n    i32.load\n    i32.add\n    local.get 4\n    memory.atomic.notify\n"),
        "{notify}"
    );
}

#[test]
fn routes_bulk_memory_through_page_sized_chunks() {
    let text = rewrite(
        &program(
            "(func (param i32 i32 i32)
                local.get 0 local.get 1 local.get 2 memory.copy
                local.get 0 local.get 1 local.get 2 memory.fill
                local.get 0 local.get 1 local.get 2 memory.init $foo)",
        ),
        Crossing::Strict,
    );

    assert!(text.contains("call 6\n    local.get 0"), "{text}");
    assert!(text.contains("call 7\n    local.get 0"), "{text}");
    assert!(text.contains("call 9\n  )"), "{text}");
}

#[test]
fn adds_no_scratch_locals_to_functions_without_memory_access() {
    let text = rewrite(
        &program("(func (param i32) (result i32) local.get 0)"),
        Crossing::Strict,
    );

    assert!(
        text.contains("(func (;0;) (type 0) (param i32) (result i32)\n    local.get 0\n  )"),
        "{text}"
    );
}

#[test]
fn rejects_simd() {
    let source = program("(func (param i32) (result v128) local.get 0 v128.load)");

    assert!(instrument(&source, &Options::default()).is_err());
}

#[test]
fn rejects_a_module_without_heap_base() {
    let source = wat::parse_str(r#"(module (memory 1) (func))"#).expect("wat parse");

    let error = instrument(&source, &Options::default()).unwrap_err();
    assert!(format!("{error:#}").contains("__heap_base"));
}

#[test]
fn rejects_memory64_and_multi_memory() {
    for memories in ["(memory i64 1 100)", "(memory 1 100) (memory 1 100)"] {
        let source = wat::parse_str(format!(
            r#"(module
                {memories}
                (global i32 (i32.const 65552))
                (export "__heap_base" (global 0))
                (func))"#
        ))
        .expect("wat parse");

        let error = instrument(&source, &Options::default()).unwrap_err();
        assert!(
            format!("{error:#}").contains("outside the supported set"),
            "{memories}: {error:#}"
        );
    }
}

#[test]
fn rejects_a_module_it_cannot_place_tables_in() {
    let rejected = [
        (
            r#"(module (global i32 (i32.const 65552)) (export "__heap_base" (global 0)) (func))"#,
            "expected exactly one memory, found 0",
        ),
        (
            r#"(module (memory 1 100) (global i32 (i32.const 65552)) (export "__heap_base" (global 0)))"#,
            "module defines no functions",
        ),
        (
            r#"(module (import "env" "foo" (global i32)) (memory 1 100) (export "__heap_base" (global 0)) (func))"#,
            "__heap_base must be a defined global",
        ),
        (
            r#"(module (memory 1 100) (global (mut i32) (i32.const 65552)) (export "__heap_base" (global 0)) (func))"#,
            "__heap_base must be an immutable i32",
        ),
        (
            r#"(module (memory 1 65536) (global i32 (i32.const -65536)) (export "__heap_base" (global 0)) (func))"#,
            "page tables do not fit below 4 GiB",
        ),
    ];

    for (module, expected) in rejected {
        let source = wat::parse_str(module).expect("wat parse");

        let error = instrument(&source, &Options::default()).unwrap_err();
        assert!(
            format!("{error:#}").contains(expected),
            "{module}: {error:#}"
        );
    }
}

#[test]
fn gives_a_side_module_no_tables_of_its_own() {
    let source = wat::parse_str(
        r#"(module
            (import "env" "memory" (memory 1 100 shared))
            (import "env" "__memory_base" (global i32))
            (func (param i32) (result i32) local.get 0 i32.load))"#,
    )
    .expect("wat parse");
    let options = Options {
        crossing: Crossing::Aligned,
        role: Role::SideModule,
    };

    let output = instrument(&source, &options).expect("instrument");
    let text = wasmprinter::print_bytes(output).expect("print");

    assert!(text.contains("(memory (;0;) 1 65536 shared)"), "{text}");
    assert!(
        text.contains("(global (;1;) (mut i32) i32.const 0)"),
        "{text}"
    );
    assert!(
        text.contains("(export \"__memory_table_base\" (global 1))"),
        "{text}"
    );
    assert!(
        text.contains("(export \"__memory_group_base\" (global 2))"),
        "{text}"
    );
    assert!(
        text.contains("(global (;3;) (mut i32) i32.const 0)"),
        "{text}"
    );
    assert!(
        text.contains("(export \"__memory_stop_base\" (global 3))"),
        "{text}"
    );
    assert!(
        text.contains("global.get 1\n    i32.add\n    i32.load\n"),
        "{text}"
    );
}

#[test]
fn rejects_a_memory_maximum_too_small_for_the_table() {
    let source = wat::parse_str(
        r#"(module
            (memory 1 2)
            (global i32 (i32.const 65552))
            (export "__heap_base" (global 0))
            (func))"#,
    )
    .expect("wat parse");

    let error = instrument(&source, &Options::default()).unwrap_err();
    assert!(format!("{error:#}").contains("cannot hold the page table"));
}

#[test]
fn parses_crossing_modes() {
    assert_eq!("strict".parse::<Crossing>().unwrap(), Crossing::Strict);
    assert_eq!("aligned".parse::<Crossing>().unwrap(), Crossing::Aligned);
    assert!("bar".parse::<Crossing>().is_err());
}
