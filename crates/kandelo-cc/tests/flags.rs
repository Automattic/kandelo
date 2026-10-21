//! The SDK's reading of a caller's arguments: filtering, parsing, the
//! link decision, the main-thread stack size, and thread-slot inference.
//! Ported from sdk/test/flags.test.ts.

use kandelo_cc::Result;
use kandelo_cc::arch::WasmArch;
use kandelo_cc::flags::{
    DEFAULT_MAIN_THREAD_STACK_SIZE, MAX_EXECUTABLE_MEMORY_SIZE, MAX_RESPONSE_FILE_EXPANSIONS,
    ResponseFileContents, THREAD_SLOT_NONE, THREAD_SLOT_USE_HOST_DEFAULT, compile_flags,
    filter_args, infer_thread_slot_declaration, link_flags, main_thread_stack_size, needs_linking,
    parse_args,
};
use std::collections::HashMap;

const MIB: u64 = 1024 * 1024;

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| v.to_string()).collect()
}

fn filtered(args: &[&str]) -> Vec<String> {
    filter_args(&strings(args), WasmArch::Wasm32).filtered
}

fn parsed(args: &[&str]) -> kandelo_cc::flags::ParsedArgs {
    parse_args(&strings(args)).unwrap()
}

fn response_file(contents: &str, identity: &str) -> ResponseFileContents {
    ResponseFileContents {
        contents: contents.to_string(),
        identity: identity.to_string(),
    }
}

/// The stack size of `args` without response-file expansion.
fn stack_size(args: &[&str]) -> Result<u64> {
    main_thread_stack_size(&strings(args), None)
}

/// The stack size of `args`, expanding response files through `read`.
fn stack_size_with(
    args: &[&str],
    mut read: impl FnMut(&str) -> Option<ResponseFileContents>,
) -> Result<u64> {
    let mut reader = |path: &str| Ok(read(path));
    main_thread_stack_size(&strings(args), Some(&mut reader))
}

/// A reader over an in-memory set of response files, keyed by path.
fn files(entries: &[(&str, &str)]) -> impl FnMut(&str) -> Option<ResponseFileContents> + use<> {
    let files: HashMap<String, String> = entries
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    move |path| {
        files
            .get(path)
            .map(|contents| response_file(contents, path))
    }
}

/// A reader that serves `contents` for every path, as `/tmp/objects.list`.
fn one_file(contents: &str) -> impl FnMut(&str) -> Option<ResponseFileContents> + '_ {
    move |_| Some(response_file(contents, "/tmp/objects.list"))
}

// filterArgs

#[test]
fn filter_passes_through_normal_flags() {
    let result = filter_args(
        &strings(&["-O2", "-DFOO", "-Iinclude", "main.c"]),
        WasmArch::Wasm32,
    );
    assert_eq!(
        result.filtered,
        strings(&["-O2", "-DFOO", "-Iinclude", "main.c"])
    );
    assert!(result.warnings.is_empty());
}

#[test]
fn filter_preserves_pthread_while_silently_removing_target_no_ops() {
    let result = filter_args(
        &strings(&["-O2", "-pthread", "-fPIE", "-pie", "main.c"]),
        WasmArch::Wasm32,
    );
    assert_eq!(result.filtered, strings(&["-O2", "-pthread", "main.c"]));
    assert!(result.warnings.is_empty());
}

#[test]
fn filter_warns_on_dynamiclib_but_removes_it() {
    let result = filter_args(&strings(&["-dynamiclib", "foo.o"]), WasmArch::Wasm32);
    assert_eq!(result.filtered, strings(&["foo.o"]));
    assert_eq!(result.warnings.len(), 1);
    assert!(result.warnings[0].contains("-dynamiclib"));
}

#[test]
fn filter_removes_rpath() {
    assert_eq!(
        filtered(&["-Wl,-rpath,/usr/lib", "main.c"]),
        strings(&["main.c"])
    );
}

#[test]
fn filter_removes_rpath_link() {
    assert_eq!(
        filtered(&["-Wl,-rpath-link,/usr/lib", "main.c"]),
        strings(&["main.c"])
    );
}

#[test]
fn filter_removes_soname() {
    assert_eq!(
        filtered(&["-Wl,-soname,libfoo.so", "main.c"]),
        strings(&["main.c"])
    );
}

#[test]
fn filter_removes_elf_only_z_flags_without_dropping_wasm_stack_sizing() {
    let result = filtered(&[
        "-Wl,-z,noexecstack",
        "-Wl,-z,relro",
        "-Wl,-z,stack-size=16777216",
        "main.c",
    ]);
    assert_eq!(result, strings(&["-Wl,-z,stack-size=16777216", "main.c"]));
}

#[test]
fn filter_preserves_valid_and_invalid_stack_size_spellings_for_wasm_ld() {
    for value in [
        "0100000000",
        "0o100000000",
        "0x1000000",
        "0X1000000",
        "0b1000000000000000000000000",
        "0B1000000000000000000000000",
        "16777216z",
        "08",
        "0o8",
        "0xg",
        "0b2",
    ] {
        let flag = format!("-Wl,-z,stack-size={value}");
        assert_eq!(filtered(&[&flag, "main.c"]), strings(&[&flag, "main.c"]));
    }
}

#[test]
fn filter_removes_equivalent_wasm_target_aliases_supplied_by_configure_scripts() {
    let result = filtered(&[
        "--target=wasm32-linux-musl",
        "-target",
        "wasm32-unknown-linux-musl",
        "--target=wasm32-unknown-unknown",
        "main.c",
    ]);
    assert_eq!(result, strings(&["main.c"]));
}

#[test]
fn filter_preserves_non_equivalent_target_flags() {
    assert_eq!(
        filtered(&["--target=x86_64-linux-gnu", "main.c"]),
        strings(&["--target=x86_64-linux-gnu", "main.c"])
    );
}

#[test]
fn filter_drops_archive_group_flags_which_wasm_ld_rejects() {
    let result = filtered(&[
        "main.o",
        "-Wl,--start-group",
        "liba.a",
        "libb.a",
        "-Wl,--end-group",
    ]);
    assert_eq!(result, strings(&["main.o", "liba.a", "libb.a"]));
}

// parseArgs

#[test]
fn parse_detects_compile_only_mode() {
    let parsed = parsed(&["-c", "foo.c", "-o", "foo.o"]);
    assert!(parsed.compile_only);
    assert_eq!(parsed.source_files, strings(&["foo.c"]));
    assert_eq!(parsed.output_file.as_deref(), Some("foo.o"));
}

#[test]
fn parse_detects_link_only_mode_with_object_files() {
    let parsed = parsed(&["foo.o", "bar.o", "-o", "out.wasm"]);
    assert!(!parsed.compile_only);
    assert_eq!(parsed.object_files, strings(&["foo.o", "bar.o"]));
    assert_eq!(parsed.output_file.as_deref(), Some("out.wasm"));
}

#[test]
fn parse_treats_llvm_obj_files_as_link_inputs() {
    let parsed = parsed(&["foo.obj", "bar.o", "-o", "out.wasm"]);
    assert!(!parsed.compile_only);
    assert_eq!(parsed.object_files, strings(&["foo.obj", "bar.o"]));
    assert_eq!(parsed.output_file.as_deref(), Some("out.wasm"));
}

#[test]
fn parse_detects_source_files_for_compile_and_link() {
    let parsed = parsed(&["foo.c", "-o", "foo.wasm"]);
    assert_eq!(parsed.source_files, strings(&["foo.c"]));
    assert!(!parsed.compile_only);
}

#[test]
fn parse_categorizes_archive_files() {
    let parsed = parsed(&["foo.o", "libbar.a", "-o", "out.wasm"]);
    assert_eq!(parsed.object_files, strings(&["foo.o"]));
    assert_eq!(parsed.archive_files, strings(&["libbar.a"]));
}

#[test]
fn parse_retains_the_original_order_of_forwarded_linker_inputs_and_controls() {
    let parsed = parsed(&[
        "main.o",
        "-Wl,--start-group",
        "-lfoo",
        "libbar.a",
        "-Wl,--end-group",
        "-o",
        "out.wasm",
    ]);
    assert_eq!(
        parsed.forwarded_args,
        strings(&[
            "main.o",
            "-Wl,--start-group",
            "-lfoo",
            "libbar.a",
            "-Wl,--end-group"
        ])
    );
}

#[test]
fn parse_handles_output_without_a_space() {
    let parsed = parsed(&["-c", "foo.c", "-ofoo.o"]);
    assert_eq!(parsed.output_file.as_deref(), Some("foo.o"));
    assert!(parsed.compile_only);
}

#[test]
fn parse_reads_explicit_thread_slot_declarations() {
    assert_eq!(
        parsed(&["--kandelo-thread-slots=3", "foo.c"]).thread_slots,
        Some(3)
    );
    assert_eq!(
        parsed(&["--wasm-posix-thread-slots", "0", "foo.c"]).thread_slots,
        Some(0)
    );
    assert_eq!(
        parsed(&["--kandelo-thread-slots=-1", "foo.c"]).thread_slots,
        Some(-1)
    );
}

// needsLinking

#[test]
fn needs_linking_is_false_with_compile_only() {
    assert!(!needs_linking(&parsed(&["-c", "foo.c"])));
}

#[test]
fn needs_linking_is_true_for_compile_and_link() {
    assert!(needs_linking(&parsed(&["foo.c", "-o", "foo.wasm"])));
}

#[test]
fn needs_linking_is_true_for_link_only() {
    assert!(needs_linking(&parsed(&["foo.o", "-o", "out.wasm"])));
}

#[test]
fn needs_linking_is_false_for_preprocess_only() {
    assert!(!needs_linking(&parsed(&["-E", "foo.c"])));
}

#[test]
fn needs_linking_is_true_for_linker_response_list_files() {
    assert!(needs_linking(&parsed(&[
        "-fuse-ld=lld",
        "-o",
        "out.wasm",
        "-Wl,@/tmp/objects.list"
    ])));
}

// COMPILE_FLAGS and LINK_FLAGS: the TypeScript constants were
// compileFlags('wasm32') and linkFlags('wasm32', <allowance>) with the
// default stack size, so these check those calls.

fn default_link_flags() -> Vec<String> {
    link_flags(
        WasmArch::Wasm32,
        "/glue/kandelo-host-imports.txt",
        Some(DEFAULT_MAIN_THREAD_STACK_SIZE),
    )
}

#[test]
fn compile_flags_include_target_and_wasm_features() {
    let flags = compile_flags(WasmArch::Wasm32);
    for flag in [
        "--target=wasm32-unknown-unknown",
        "-D__unix__=1",
        "-D__unix=1",
        "-matomics",
        "-mbulk-memory",
    ] {
        assert!(flags.iter().any(|f| f == flag), "{flag}");
    }
}

#[test]
fn link_flags_leave_constructors_to_musl_while_exporting_the_process_entry() {
    let flags = default_link_flags();
    let has = |flag: &str| flags.iter().any(|f| f == flag);
    assert!(has("-Wl,--no-entry"));
    assert!(has("-Wl,--export=_start"));
    assert!(!has("-Wl,--entry=_start"));
    assert!(has("-Wl,--import-memory"));
    assert!(has("-Wl,--shared-memory"));
}

#[test]
fn link_flags_reserve_an_8_mib_main_thread_shadow_stack() {
    // wasm-ld's default (~64 KiB) is too small.
    assert!(
        default_link_flags()
            .iter()
            .any(|f| f == "-Wl,-z,stack-size=8388608")
    );
}

#[test]
fn link_flags_omit_the_stack_size_flag_entirely_for_a_null_request() {
    // prepare_executable_linker relies on this to build an uncontaminated
    // measurement trace: it must not itself inject any `-z stack-size=`
    // occurrence that could shadow the caller's own, since
    // main_thread_stack_size resolves repeated occurrences last-wins.
    let flags = link_flags(WasmArch::Wasm32, "/glue/kandelo-host-imports.txt", None);
    assert!(!flags.iter().any(|f| f.starts_with("-Wl,-z,stack-size=")));
}

// mainThreadStackSize

#[test]
fn stack_size_defaults_to_8_mib_without_an_explicit_request() {
    assert_eq!(
        stack_size(&["main.o"]).unwrap(),
        DEFAULT_MAIN_THREAD_STACK_SIZE
    );
}

#[test]
fn stack_size_honours_a_request_below_the_floor_instead_of_raising_it() {
    assert_eq!(
        stack_size(&["-z", "stack-size=1048576", "main.o"]).unwrap(),
        1048576
    );
}

#[test]
fn stack_size_resolves_an_ascending_multi_occurrence_request_by_last_one_wins() {
    // Ascending order: the last occurrence and the largest coincide, so this
    // case alone passes under either a last-wins or an old max-wins reading.
    // The descending case below is the one only last-wins passes.
    let size = stack_size(&[
        "-z",
        "stack-size=1048576",
        "main.o",
        "-z",
        "stack-size=16777216",
    ])
    .unwrap();
    assert_eq!(size, 16 * MIB);
}

#[test]
fn stack_size_resolves_a_descending_multi_occurrence_request_by_last_one_wins_not_maximum() {
    // The larger value comes first, so a max-wins reading would keep 16 MiB.
    // wasm-ld resolves repeated -z stack-size= operands last-one-wins
    // (verified against LLVM 21's wasm-ld), so 1 MiB is correct.
    let size = stack_size(&[
        "-z",
        "stack-size=16777216",
        "main.o",
        "-z",
        "stack-size=1048576",
    ])
    .unwrap();
    assert_eq!(size, 1048576);
}

#[test]
fn stack_size_recognizes_both_accepted_lld_z_spellings() {
    for args in [
        &["-zstack-size=0x1000000", "main.o"][..],
        &["-z", "stack-size=0o100000000", "main.o"],
    ] {
        assert_eq!(stack_size(args).unwrap(), 16 * MIB);
    }
}

#[test]
fn stack_size_requires_the_operand_to_immediately_follow_z() {
    for args in [
        ["-z", "main.o", "stack-size=33554432"],
        ["-z", "-lfoo", "stack-size=33554432"],
        ["-z", "-e", "stack-size=33554432"],
        ["-z", "-r", "stack-size=33554432"],
    ] {
        assert_eq!(stack_size(&args).unwrap(), DEFAULT_MAIN_THREAD_STACK_SIZE);
    }
}

#[test]
fn stack_size_retains_larger_requests_in_every_integer_radix_accepted_by_llvm_21() {
    for value in [
        "16777216",
        "0100000000",
        "0o100000000",
        "0x1000000",
        "0X1000000",
        "0b1000000000000000000000000",
        "0B1000000000000000000000000",
    ] {
        let operand = format!("stack-size={value}");
        assert_eq!(
            stack_size(&["-z", &operand, "main.o"]).unwrap(),
            16 * MIB,
            "{value}"
        );
    }
}

#[test]
fn stack_size_treats_leading_zero_values_as_octal_rather_than_padded_decimal() {
    // 0o20000000 = 4194304, below the SDK floor. A decimal misparse
    // (20000000) would exceed the floor instead, so the exact octal value is
    // what distinguishes the two readings now that smaller requests are
    // honoured rather than clamped.
    assert_eq!(
        stack_size(&["-z", "stack-size=020000000", "main.o"]).unwrap(),
        4194304
    );
    let size = stack_size_with(
        &["@/tmp/objects.list"],
        one_file("-z\nstack-size=020000000\n"),
    )
    .unwrap();
    assert_eq!(size, 4194304);
}

#[test]
fn stack_size_retains_larger_radix_prefixed_requests_in_directly_referenced_response_files() {
    for value in [
        "16777216",
        "0100000000",
        "0o100000000",
        "0x1000000",
        "0X1000000",
        "0b1000000000000000000000000",
        "0B1000000000000000000000000",
    ] {
        let contents = format!("first.o\n-z\nstack-size={value}\n");
        assert_eq!(
            stack_size_with(&["@/tmp/objects.list"], one_file(&contents)).unwrap(),
            16 * MIB,
            "{value}"
        );
    }
}

#[test]
fn stack_size_expands_nested_lld_response_files_with_llvm_gnu_tokenization() {
    let read = files(&[
        (
            "/tmp/outer.rsp",
            "\"/tmp/not-stack-size=33554432.o\" @/tmp/inner\\ file.rsp",
        ),
        ("/tmp/inner file.rsp", "-z 'stack-size=0x1000000'"),
    ]);
    assert_eq!(
        stack_size_with(&["@/tmp/outer.rsp", "main.o"], read).unwrap(),
        16 * MIB
    );
}

#[test]
fn stack_size_only_treats_exact_lld_z_operands_as_stack_requests() {
    for args in [
        &["stack-size=33554432", "main.o"][..],
        &["-z=stack-size=33554432", "main.o"],
        &["/tmp/not-stack-size=33554432.o"],
        &["-z", "-zstack-size=33554432"],
        &["--", "-zstack-size=33554432"],
    ] {
        assert_eq!(
            stack_size(args).unwrap(),
            DEFAULT_MAIN_THREAD_STACK_SIZE,
            "{args:?}"
        );
    }

    let read = one_file("not-stack-size=33554432.o\nstack-size=33554432\n");
    assert_eq!(
        stack_size_with(&["@/tmp/objects.rsp"], read).unwrap(),
        DEFAULT_MAIN_THREAD_STACK_SIZE
    );
}

#[test]
fn stack_size_does_not_let_invalid_integer_digits_influence_the_floor() {
    for value in ["16777216z", "08", "0o8", "0xg", "0b2"] {
        let operand = format!("stack-size={value}");
        assert_eq!(
            stack_size(&["-z", &operand, "main.o"]).unwrap(),
            DEFAULT_MAIN_THREAD_STACK_SIZE
        );
        let contents = format!("-z\n{operand}\n");
        assert_eq!(
            stack_size_with(&["@/tmp/objects.list"], one_file(&contents)).unwrap(),
            DEFAULT_MAIN_THREAD_STACK_SIZE
        );
    }
}

#[test]
fn stack_size_rejects_requests_larger_than_the_executable_memory_maximum() {
    let limit = "exceeds the SDK's 1073741824-byte executable memory limit";
    let decimal = format!("{}", MAX_EXECUTABLE_MEMORY_SIZE + 1);
    for value in [
        decimal.as_str(),
        "010000000001",
        "0o10000000001",
        "0x40000001",
        "0b1000000000000000000000000000001",
    ] {
        let operand = format!("stack-size={value}");
        let error = stack_size(&["-z", &operand, "main.o"]).unwrap_err();
        assert!(error.contains(limit), "{error}");
        let contents = format!("-z\n{operand}\n");
        let error = stack_size_with(&["@/tmp/objects.list"], one_file(&contents)).unwrap_err();
        assert!(error.contains(limit), "{error}");
    }
}

#[test]
fn stack_size_inspects_response_chains_deeper_than_the_former_recursive_cutoff() {
    let chain: Vec<(String, String)> = (0..100)
        .map(|index| {
            let contents = if index == 99 {
                "-z stack-size=16777216".to_string()
            } else {
                format!("@/tmp/deep-{}.rsp", index + 1)
            };
            (format!("/tmp/deep-{index}.rsp"), contents)
        })
        .collect();
    let entries: Vec<(&str, &str)> = chain
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    assert_eq!(
        stack_size_with(&["@/tmp/deep-0.rsp"], files(&entries)).unwrap(),
        16 * MIB
    );
}

#[test]
fn stack_size_expands_repeated_files_each_time_so_cross_file_option_boundaries_stay_exact() {
    let read = files(&[("/tmp/z.rsp", "-z")]);
    let args = [
        "@/tmp/z.rsp",
        "stack-size=16777216",
        "@/tmp/z.rsp",
        "stack-size=33554432",
    ];
    assert_eq!(stack_size_with(&args, read).unwrap(), 32 * MIB);
}

#[test]
fn stack_size_rejects_missing_recursive_and_alias_recursive_response_files() {
    let error = stack_size_with(&["@/tmp/missing.rsp"], |_| None).unwrap_err();
    assert!(error.contains("cannot inspect response file"), "{error}");

    let recursive = files(&[("/tmp/a.rsp", "@/tmp/b.rsp"), ("/tmp/b.rsp", "@/tmp/a.rsp")]);
    let error = stack_size_with(&["@/tmp/a.rsp"], recursive).unwrap_err();
    assert!(error.contains("recursive response file"), "{error}");

    let alias = |_: &str| Some(response_file("@/tmp/alias.rsp", "same-file"));
    let error = stack_size_with(&["@/tmp/a.rsp"], alias).unwrap_err();
    assert!(error.contains("recursive response file"), "{error}");
}

#[test]
fn stack_size_fails_closed_when_response_expansion_exceeds_the_explicit_file_bound() {
    let endless = |path: &str| {
        let index: u64 = path.parse().unwrap();
        Some(response_file(&format!("@{}", index + 1), path))
    };
    let error = stack_size_with(&["@0"], endless).unwrap_err();
    let expected = format!(
        "response-file expansion exceeds the {MAX_RESPONSE_FILE_EXPANSIONS}-file safety limit"
    );
    assert!(error.contains(&expected), "{error}");
}

/// Set in the child process `stack_size_honours_an_explicit_stack_below_the_floor_and_warns` spawns.
const WARNING_CHILD_ENV: &str = "KANDELO_CC_TEST_STACK_WARNING_CHILD";

#[test]
fn stack_size_honours_an_explicit_stack_below_the_floor_and_warns() {
    // The warning goes to stderr, which the test harness captures in
    // process. Rerun just this test in a child with capture off, and read
    // the child's stderr.
    if std::env::var_os(WARNING_CHILD_ENV).is_some() {
        assert_eq!(
            stack_size(&["-z", "stack-size=65536"]).unwrap(),
            65536,
            "the caller's explicit request wins"
        );
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "stack_size_honours_an_explicit_stack_below_the_floor_and_warns",
            "--nocapture",
        ])
        .env(WARNING_CHILD_ENV, "1")
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "child failed:\n{stderr}");
    assert!(stderr.contains("stack-size=65536"), "{stderr}");
    let lower = stderr.to_lowercase();
    assert!(
        lower.contains(".bss") || lower.contains("guard page") || lower.contains("corrupt"),
        "{stderr}"
    );
}

#[test]
fn stack_size_still_applies_the_floor_when_no_stack_size_is_requested() {
    assert_eq!(stack_size(&[]).unwrap(), DEFAULT_MAIN_THREAD_STACK_SIZE);
}

// inferThreadSlotDeclaration

#[test]
fn thread_slots_are_zero_only_for_source_only_builds_with_no_thread_or_dynamic_use() {
    let parsed = parsed(&["main.c", "-o", "main.wasm"]);
    let slots =
        infer_thread_slot_declaration(&parsed, &strings(&["main.c", "-o", "main.wasm"]), &|_| {
            Some("int main(void) { return 0; }\n".into())
        });
    assert_eq!(slots, THREAD_SLOT_NONE);
}

#[test]
fn thread_slots_use_the_host_default_for_uncertain_thread_or_dynamic_use() {
    let threaded = parsed(&["main.c", "-o", "main.wasm"]);
    let trivial = |_: &str| Some("int main(void) { return 0; }\n".to_string());
    assert_eq!(
        infer_thread_slot_declaration(&threaded, &strings(&["-pthread", "main.c"]), &trivial),
        THREAD_SLOT_USE_HOST_DEFAULT
    );

    let creates_thread =
        |_: &str| Some("void f(void) { pthread_create(0, 0, 0, 0); }\n".to_string());
    assert_eq!(
        infer_thread_slot_declaration(&threaded, &strings(&["main.c"]), &creates_thread),
        THREAD_SLOT_USE_HOST_DEFAULT
    );

    let clones = |_: &str| Some("#include<thread>\nvoid f(void) { clone (0); }\n".to_string());
    assert_eq!(
        infer_thread_slot_declaration(&threaded, &strings(&["main.c"]), &clones),
        THREAD_SLOT_USE_HOST_DEFAULT
    );

    // The TypeScript call passed no reader; an object-only link decides
    // before reading any source.
    let object_only = parsed(&["main.o", "-o", "main.wasm"]);
    assert_eq!(
        infer_thread_slot_declaration(
            &object_only,
            &strings(&["main.o", "-o", "main.wasm"]),
            &|_| None
        ),
        THREAD_SLOT_USE_HOST_DEFAULT
    );
}
