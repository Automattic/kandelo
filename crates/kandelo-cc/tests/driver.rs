//! The compiler driver's argument building and its reading of clang's
//! `-###` traces and LLVM response files. Ported from sdk/test/cc.test.ts.

use kandelo_cc::Result;
use kandelo_cc::arch::WasmArch;
use kandelo_cc::driver::{
    LinkerPreparation, build_clang_args, build_glue_compile_args, decode_llvm_response_file,
    glue_sources, linker_args_from_clang_trace, working_directory_from_clang_trace,
};
use kandelo_cc::flags::MAX_EXECUTABLE_MEMORY_SIZE;
use kandelo_cc::toolchain::Toolchain;

const MIB: u64 = 1024 * 1024;

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| v.to_string()).collect()
}

fn toolchain() -> Toolchain {
    Toolchain {
        llvm_dir: "/opt/llvm/bin".into(),
        lld_major: Some(21),
        cc: "/opt/llvm/bin/clang".into(),
        cxx: "/opt/llvm/bin/clang++".into(),
        sysroot: "/tmp/sysroot".into(),
        glue_dir: "/tmp/glue".into(),
        calltypes_plugin: None,
    }
}

/// An executable link prepared with `stack` bytes of main-thread stack.
fn executable_link(stack: u64) -> Option<LinkerPreparation> {
    Some(LinkerPreparation::ExecutableLink {
        main_thread_stack_size_bytes: stack,
    })
}

fn try_build_with(user_args: &[&str], toolchain: &Toolchain, stack: u64) -> Result<Vec<String>> {
    build_clang_args(
        &strings(user_args),
        toolchain,
        WasmArch::Wasm32,
        executable_link(stack),
        None,
    )
}

/// wasm32 arguments for `user_args`, prepared as an 8 MiB-stack executable link.
fn build(user_args: &[&str]) -> Vec<String> {
    try_build_with(user_args, &toolchain(), 8 * MIB).unwrap()
}

fn has(args: &[String], value: &str) -> bool {
    args.iter().any(|a| a == value)
}

/// TypeScript's `args.join(' ').includes(text)`.
fn joined_contains(args: &[String], text: &str) -> bool {
    args.join(" ").contains(text)
}

/// TypeScript's `args.indexOf(value)` (`None` for -1).
fn index_of(args: &[String], value: &str) -> Option<usize> {
    args.iter().position(|a| a == value)
}

fn last_stack_size_flag(args: &[String]) -> Option<&str> {
    args.iter()
        .filter(|a| a.contains("stack-size="))
        .next_back()
        .map(String::as_str)
}

// buildClangArgs

#[test]
fn compile_only_adds_compile_flags_and_no_link_flags() {
    let args = build(&["-c", "foo.c", "-o", "foo.o"]);
    assert!(has(&args, "--target=wasm32-unknown-unknown"));
    assert!(has(&args, "-D__unix__=1"));
    assert!(has(&args, "-D__unix=1"));
    assert!(has(&args, "--sysroot=/tmp/sysroot"));
    assert!(has(&args, "-c"));
    assert!(has(&args, "foo.c"));
    assert!(!has(&args, "-Wl,--entry=_start"));
    assert!(!joined_contains(&args, "syscall_glue.c"));
}

#[test]
fn compile_and_link_adds_compile_and_link_flags_plus_glue() {
    let args = build(&["foo.c", "-o", "foo.wasm"]);
    assert!(has(&args, "--target=wasm32-unknown-unknown"));
    assert!(has(&args, "-Wl,--no-entry"));
    assert!(has(&args, "-Wl,--import-memory"));
    assert!(joined_contains(&args, "channel_syscall.c"));
    assert!(joined_contains(&args, "compiler_rt.c"));
    assert!(joined_contains(&args, "crt1.o"));
    assert!(joined_contains(&args, "libc.a"));
    assert!(has(&args, "-Wl,-z,stack-size=8388608"));
}

#[test]
fn ldl_selects_the_functional_dynamic_loading_glue() {
    let args = build(&["foo.c", "-ldl", "-o", "foo.wasm"]);
    assert!(!has(&args, "-ldl"));
    assert!(has(&args, "/tmp/glue/dlopen.c"));
}

#[test]
fn uses_the_8_mib_stack_floor_for_default_and_smaller_requests() {
    // The prepared size is what links; the caller's smaller -z request is
    // forwarded but followed by the prepared value.
    let default_args = build(&["foo.c", "-o", "foo.wasm"]);
    let smaller_args = build(&["foo.c", "-Wl,-z,stack-size=1048576", "-o", "foo.wasm"]);

    assert_eq!(
        last_stack_size_flag(&default_args),
        Some("-Wl,-z,stack-size=8388608")
    );
    assert_eq!(
        last_stack_size_flag(&smaller_args),
        Some("-Wl,-z,stack-size=8388608")
    );
}

#[test]
fn emits_the_prepared_larger_stack_after_preserving_the_original_arguments() {
    let user_args = [
        "foo.c",
        "-Wl,-z",
        "-iquote",
        "/tmp/include",
        "-Wl,stack-size=16777216",
        "-o",
        "foo.wasm",
    ];
    let args = try_build_with(&user_args, &toolchain(), 16 * MIB).unwrap();
    let forwarded = strings(&user_args[..user_args.len() - 2]);

    let start = index_of(&args, &forwarded[0]).unwrap();
    let end = index_of(&args, forwarded.last().unwrap()).unwrap();
    assert_eq!(args[start..=end], forwarded[..]);
    assert_eq!(
        last_stack_size_flag(&args),
        Some("-Wl,-z,stack-size=16777216")
    );
}

#[test]
fn rejects_malformed_utf16_response_text_like_llvm() {
    // A lone surrogate, in each byte order.
    assert!(decode_llvm_response_file(&[0xff, 0xfe, 0x00, 0xd8]).is_err());
    assert!(decode_llvm_response_file(&[0xfe, 0xff, 0xd8, 0x00]).is_err());
    let error = decode_llvm_response_file(&[0xff, 0xfe, 0x41]).unwrap_err();
    assert!(error.contains("odd-length UTF-16LE"), "{error}");
}

#[test]
fn decodes_both_llvm_utf16_response_file_encodings() {
    let contents = "-z\nstack-size=16777216\n";
    let mut little_endian = vec![0xff, 0xfe];
    let mut big_endian = vec![0xfe, 0xff];
    for unit in contents.encode_utf16() {
        little_endian.extend(unit.to_le_bytes());
        big_endian.extend(unit.to_be_bytes());
    }

    for encoded in [little_endian, big_endian] {
        assert_eq!(decode_llvm_response_file(&encoded).unwrap(), contents);
    }
}

#[test]
fn link_only_gets_link_flags_plus_compile_flags_for_glue() {
    let args = build(&["foo.o", "bar.o", "-o", "out.wasm"]);
    assert!(has(&args, "-Wl,--no-entry"));
    assert!(joined_contains(&args, "libc.a"));
    assert!(has(&args, "--target=wasm32-unknown-unknown"));
    // Compile flags are present because glue .c files are compiled during linking.
    assert!(has(&args, "-fno-trapping-math"));
    assert!(joined_contains(&args, "channel_syscall.c"));
}

#[test]
fn preserves_user_linker_input_order_across_argument_categories() {
    // --whole-archive is order-sensitive and accepted by wasm-ld, so it is a
    // real test of ordering. (--start-group/--end-group are dropped: wasm-ld
    // rejects them and resolves archives order-independently.)
    let user_link_args = [
        "main.o",
        "-Wl,--whole-archive",
        "-lfoo",
        "libbar.a",
        "-Wl,--no-whole-archive",
    ];
    let mut user_args = user_link_args.to_vec();
    user_args.extend(["-o", "out.wasm"]);
    let args = build(&user_args);
    let start = index_of(&args, "main.o").unwrap();
    let end = index_of(&args, "-Wl,--no-whole-archive").unwrap();
    assert_eq!(args[start..=end], strings(&user_link_args)[..]);
}

#[test]
fn links_precompiled_glue_objects_in_place_of_the_glue_sources() {
    let objects = strings(&[
        "/tmp/g/channel_syscall.o",
        "/tmp/g/compiler_rt.o",
        "/tmp/g/cxxrt.o",
    ]);
    let args = build_clang_args(
        &strings(&["main.o", "-o", "out.wasm"]),
        &toolchain(),
        WasmArch::Wasm32,
        executable_link(8 * MIB),
        Some(&objects),
    )
    .unwrap();
    assert!(!joined_contains(&args, "channel_syscall.c"));
    let first = index_of(&args, &objects[0]).unwrap();
    assert_eq!(args[first..first + 3], objects[..]);
    assert!(first < index_of(&args, "/tmp/sysroot/lib/crt1.o").unwrap());
}

#[test]
fn compiles_glue_as_optimized_c_regardless_of_the_link_command() {
    let toolchain = toolchain();
    assert_eq!(
        glue_sources(&toolchain, false),
        strings(&[
            "/tmp/glue/channel_syscall.c",
            "/tmp/glue/compiler_rt.c",
            "/tmp/glue/cxxrt.c"
        ])
    );
    assert_eq!(
        glue_sources(&toolchain, true).last().map(String::as_str),
        Some("/tmp/glue/dlopen.c")
    );
    let args = build_glue_compile_args(
        &glue_sources(&toolchain, false),
        &toolchain,
        WasmArch::Wasm32,
        Some("-DSLOTS=4"),
    );
    assert!(has(&args, "-O2"));
    assert!(has(&args, "-DSLOTS=4"));
    assert!(has(&args, "--target=wasm32-unknown-unknown"));
    assert!(has(&args, "--sysroot=/tmp/sysroot"));
    let x = index_of(&args, "-x").unwrap();
    assert_eq!(args[x..x + 2], strings(&["-x", "c"])[..]);
    assert_eq!(
        args[args.len() - 4..],
        strings(&[
            "-c",
            "/tmp/glue/channel_syscall.c",
            "/tmp/glue/compiler_rt.c",
            "/tmp/glue/cxxrt.c"
        ])[..]
    );
    assert!(has(
        &args,
        "-ffile-prefix-map=/tmp/glue=/usr/src/kandelo-sdk/libc/glue"
    ));
}

#[test]
fn orders_explicit_libc_and_user_libraries_after_syscall_glue() {
    let args = build(&[
        "main.o",
        "-L",
        "/deps/lib",
        "-lxml2",
        "support.a",
        "-lc",
        "-o",
        "out.wasm",
    ]);
    let order = [
        "/tmp/glue/channel_syscall.c",
        "/tmp/sysroot/lib/crt1.o",
        "main.o",
        "-L",
        "-lxml2",
        "support.a",
        "-lc",
        "/tmp/sysroot/lib/libc.a",
    ];
    let positions: Vec<usize> = order
        .iter()
        .map(|value| index_of(&args, value).unwrap())
        .collect();
    for (pair, names) in positions.windows(2).zip(order.windows(2)) {
        assert!(
            pair[0] < pair[1],
            "{} must come before {}",
            names[0],
            names[1]
        );
    }
}

#[test]
fn maps_sdk_owned_glue_and_sysroot_paths_to_stable_debug_identities() {
    let args = build(&[
        "-ffile-prefix-map=/tmp=/caller-source",
        "foo.c",
        "-o",
        "foo.wasm",
    ]);

    for kind in ["file", "debug", "macro"] {
        assert!(has(
            &args,
            &format!("-f{kind}-prefix-map=/tmp/glue=/usr/src/kandelo-sdk/libc/glue")
        ));
        assert!(has(
            &args,
            &format!("-f{kind}-prefix-map=/tmp/sysroot=/usr/src/kandelo-sdk/sysroot")
        ));
    }
    // After the caller's broader mapping, so the SDK's more specific one wins.
    assert!(
        index_of(
            &args,
            "-ffile-prefix-map=/tmp/glue=/usr/src/kandelo-sdk/libc/glue"
        )
        .unwrap()
            > index_of(&args, "-ffile-prefix-map=/tmp=/caller-source").unwrap()
    );
}

#[test]
fn uses_an_architecture_specific_stable_identity_for_the_wasm64_sysroot() {
    let args = build_clang_args(
        &strings(&["-c", "foo.c", "-o", "foo.o"]),
        &toolchain(),
        WasmArch::Wasm64,
        None,
        None,
    )
    .unwrap();

    assert!(has(
        &args,
        "-ffile-prefix-map=/tmp/sysroot=/usr/src/kandelo-sdk/sysroot64"
    ));
}

#[test]
fn preprocess_only_has_no_link_flags() {
    let args = build(&["-E", "foo.c"]);
    assert!(!has(&args, "-Wl,--entry=_start"));
}

#[test]
fn preserves_pthread_compiler_semantics_while_filtering_lpthread() {
    let args = build_clang_args(
        &strings(&["-c", "-pthread", "-lpthread", "-fPIC", "foo.c"]),
        &toolchain(),
        WasmArch::Wasm32,
        None,
        None,
    )
    .unwrap();
    assert!(has(&args, "-pthread"));
    assert!(!has(&args, "-lpthread"));
    assert!(has(&args, "-fPIC"));
}

#[test]
fn honors_an_authoritative_no_link_trace_for_direct_and_response_file_inputs() {
    for user_args in [&["-fsyntax-only", "foo.c"][..], &["@/tmp/syntax-only.rsp"]] {
        let args = build_clang_args(
            &strings(user_args),
            &toolchain(),
            WasmArch::Wasm32,
            Some(LinkerPreparation::NoLink),
            None,
        )
        .unwrap();
        assert!(has(&args, "-fno-trapping-math"));
        assert!(!has(&args, "-fuse-ld=/opt/llvm/bin/wasm-ld"));
        assert!(!has(&args, "-Wl,--entry=_start"));
        assert!(!joined_contains(&args, "channel_syscall.c"));
    }
}

#[test]
fn normalizes_equivalent_configure_supplied_wasm_target_aliases() {
    let args = build(&["--target=wasm32-linux-musl", "-c", "foo.c"]);
    let targets: Vec<&String> = args.iter().filter(|a| a.starts_with("--target=")).collect();
    assert_eq!(targets, ["--target=wasm32-unknown-unknown"]);
}

#[test]
fn treats_linker_response_lists_as_link_commands() {
    let args = build(&["-fuse-ld=lld", "-o", "out.wasm", "-Wl,@/tmp/objects.list"]);
    assert!(has(&args, "-Wl,--no-entry"));
    assert!(joined_contains(&args, "channel_syscall.c"));
    assert!(joined_contains(&args, "libc.a"));
}

#[test]
fn preserves_the_relative_order_of_link_inputs_and_l_flags() {
    let args = build(&["foo.o", "-L/deps/lib", "-lz", "bar.o", "-o", "out.wasm"]);
    assert!(index_of(&args, "foo.o").unwrap() < index_of(&args, "-lz").unwrap());
    assert!(index_of(&args, "-lz").unwrap() < index_of(&args, "bar.o").unwrap());
}

#[test]
fn emits_explicit_process_thread_slot_declarations_into_the_glue_compile() {
    let args = build(&["--kandelo-thread-slots=2", "foo.c", "-o", "foo.wasm"]);
    assert!(has(&args, "-DWASM_POSIX_THREAD_SLOT_DECL=2"));
    assert!(!has(&args, "--kandelo-thread-slots=2"));
}

#[test]
fn pins_lld_to_the_same_resolved_llvm_tree_as_clang() {
    let args = build(&["foo.c", "-o", "foo.wasm"]);

    assert!(has(&args, "-fuse-ld=/opt/llvm/bin/wasm-ld"));
}

#[test]
fn rejects_executable_link_arguments_before_wasm_ld_is_versioned() {
    let unversioned = Toolchain {
        lld_major: None,
        ..toolchain()
    };
    let error = build_clang_args(
        &strings(&["foo.c", "-o", "foo.wasm"]),
        &unversioned,
        WasmArch::Wasm32,
        None,
        None,
    )
    .unwrap_err();
    assert!(error.contains("wasm-ld version is unresolved"), "{error}");
}

#[test]
fn rejects_executable_links_without_the_matching_clang_trace_preparation() {
    let error = build_clang_args(
        &strings(&["foo.c", "-o", "foo.wasm"]),
        &toolchain(),
        WasmArch::Wasm32,
        None,
        None,
    )
    .unwrap_err();
    assert!(
        error.contains("executable linker arguments are unprepared"),
        "{error}"
    );
    // Over-ceiling prepared sizes are still rejected: that is a structural
    // requirement of the linker invocation, not the 8 MiB floor. (The
    // TypeScript test also rejected 1.5 and -1; a u64 cannot hold either.)
    // A sub-floor size is a valid caller choice, asserted below.
    let error = try_build_with(
        &["foo.c", "-o", "foo.wasm"],
        &toolchain(),
        MAX_EXECUTABLE_MEMORY_SIZE + 1,
    )
    .unwrap_err();
    assert!(
        error.contains("prepared main-thread stack size must be a non-negative integer"),
        "{error}"
    );
}

#[test]
fn honours_a_prepared_stack_size_below_the_8_mib_default_floor() {
    // The floor is main_thread_stack_size's default for an absent request,
    // not an invariant of an already-prepared LinkerPreparation: a caller
    // that decided on a smaller value gets exactly that value linked in.
    let args = try_build_with(&["foo.c", "-o", "foo.wasm"], &toolchain(), 1024).unwrap();
    assert!(has(&args, "-Wl,-z,stack-size=1024"));
}

#[test]
fn extracts_the_exact_pinned_wasm_ld_argv_from_a_clang_trace() {
    const LD: &str = "/opt/llvm/bin/wasm-ld";
    let expect_error = |trace: &str, linker: &str, message: &str| {
        let error = linker_args_from_clang_trace(trace, linker).unwrap_err();
        assert!(
            error.contains(message),
            "expected {message:?}, got {error:?}"
        );
    };
    let trace = [
        "clang version 21.1.7",
        r#" "/opt/llvm/bin/clang-21" "-cc1" "-iquote" "/tmp/include""#,
        r#" "/opt/llvm/bin/wasm-ld" "-m" "wasm32" "main.o" "-z" "stack-size=16777216""#,
    ]
    .join("\n");

    assert_eq!(
        linker_args_from_clang_trace(&trace, LD).unwrap(),
        Some(strings(&[
            "-m",
            "wasm32",
            "main.o",
            "-z",
            "stack-size=16777216"
        ]))
    );
    expect_error(&trace, "/other/wasm-ld", "emitted 0 commands");

    let no_link_trace = r#" "/opt/llvm/bin/clang-21" "-cc1" "-triple" "wasm32-unknown-unknown""#;
    assert_eq!(
        linker_args_from_clang_trace(no_link_trace, LD).unwrap(),
        None
    );
    expect_error(
        " \"/opt/llvm/bin/clang-21\" \"-cc1\"\n \"/opt/llvm/bin/wasm-ld\" \"one.o\"\n \"/opt/llvm/bin/wasm-ld\" \"two.o\"",
        LD,
        "emitted 2 commands",
    );
    expect_error(
        " \"/opt/llvm/bin/clang-21\" \"-cc1\"\n \"/other/wasm-ld\" \"main.o\"",
        LD,
        "emitted 0 commands",
    );
    expect_error(
        " \"/opt/llvm/bin/clang-21\" \"-cc1\"\n \"/opt/llvm/bin/wasm-ld\" \"main.o\"\n \"/other/wasm-ld\" \"other.o\"",
        LD,
        "emitted 1 commands",
    );
    // A post-link wasm-opt job is expected, not a second linker.
    assert_eq!(
        linker_args_from_clang_trace(
            " \"/opt/llvm/bin/clang-21\" \"-cc1\"\n \"/opt/llvm/bin/wasm-ld\" \"main.o\"\n \"/opt/bin/wasm-opt\" \"a.wasm\"",
            LD,
        )
        .unwrap(),
        Some(strings(&["main.o"]))
    );
    expect_error(
        r#" "/opt/bin/wasm-opt" "a.wasm""#,
        LD,
        "no compiler or pinned linker jobs",
    );
    expect_error("clang version 21.1.7", LD, "no recognizable jobs");

    // A quoted newline belongs to its argument, not a new line of the trace.
    let newline_path_trace =
        " \"/opt/llvm/bin/wasm-ld\" \"main\nobject.o\" \"-z\" \"stack-size=16777216\"\n";
    assert_eq!(
        linker_args_from_clang_trace(newline_path_trace, LD).unwrap(),
        Some(strings(&["main\nobject.o", "-z", "stack-size=16777216"]))
    );
    // An unterminated quote on a non-job line does not swallow the jobs after it.
    assert_eq!(
        linker_args_from_clang_trace(&format!("\"unrelated unterminated diagnostic\n{trace}"), LD)
            .unwrap(),
        Some(strings(&[
            "-m",
            "wasm32",
            "main.o",
            "-z",
            "stack-size=16777216"
        ]))
    );
    expect_error(
        " \"/opt/llvm/bin/wasm-ld\" \"unterminated\n",
        LD,
        "unterminated quoted command",
    );

    // The driver working directory is the -working-directory in the slot
    // right after -resource-dir, not a later -Xclang one or -ffile-compilation-dir.
    let working_directory_trace = [
        concat!(
            r#" "/opt/llvm/bin/clang-21" "-cc1" "-ffile-compilation-dir=/spoofed" "#,
            r#""-resource-dir" "/opt/llvm/lib/clang/21" "-working-directory" "/tmp/build" "#,
            r#""-internal-isystem" "/opt/include" "-working-directory" "/xclang-only""#,
        ),
        r#" "/opt/llvm/bin/wasm-ld" "main.o""#,
    ]
    .join("\n");
    assert_eq!(
        working_directory_from_clang_trace(&working_directory_trace, "/tmp/project").unwrap(),
        "/tmp/build"
    );

    let initial_directory_trace = concat!(
        r#" "/opt/llvm/bin/clang-21" "-cc1" "-resource-dir" "/opt/llvm/lib/clang/21" "#,
        r#""-internal-isystem" "/opt/include" "-working-directory" "/xclang-only""#,
    );
    assert_eq!(
        working_directory_from_clang_trace(initial_directory_trace, "/tmp/project").unwrap(),
        "/tmp/project"
    );

    let inconsistent = "did not emit one consistent driver working directory";
    let error = working_directory_from_clang_trace(
        " \"/opt/llvm/bin/wasm-ld\" \"main.o\"\n",
        "/tmp/project",
    )
    .unwrap_err();
    assert!(error.contains(inconsistent), "{error}");
    let conflicting = [
        working_directory_trace.as_str(),
        r#" "/opt/llvm/bin/clang-21" "-cc1" "-resource-dir" "/opt/llvm/lib/clang/21" "-working-directory" "/other""#,
    ]
    .join("\n");
    let error = working_directory_from_clang_trace(&conflicting, "/tmp/project").unwrap_err();
    assert!(error.contains(inconsistent), "{error}");
}

#[test]
fn preserves_stack_after_data_layout_with_lld_22_and_newer() {
    let lld_22 = Toolchain {
        lld_major: Some(22),
        ..toolchain()
    };
    let args = try_build_with(&["foo.c", "-o", "foo.wasm"], &lld_22, 8 * MIB).unwrap();

    assert!(has(&args, "-Wl,--no-stack-first"));
}

#[test]
fn uses_lld_21_defaults_without_passing_its_unsupported_negative_option() {
    let lld_21 = Toolchain {
        lld_major: Some(21),
        ..toolchain()
    };
    let args = try_build_with(&["foo.c", "-o", "foo.wasm"], &lld_21, 8 * MIB).unwrap();

    assert!(!has(&args, "-Wl,--no-stack-first"));
}
