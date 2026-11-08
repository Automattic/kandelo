//! The actual VM frame PCs must resolve through linked DWARF from separate
//! compilation units. Run with scripts/dev-shell.sh for pinned LLVM and Node.
use fork_instrument::{
    Options,
    debug_info::{Limits, LineTable, SourceMap},
    native,
};
use std::{fs, process::Command};

fn output(command: &mut Command) -> Vec<u8> {
    let result = command.output().expect("start declared test tool");
    assert!(
        result.status.success(),
        "command {command:?}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    result.stdout
}

fn frames(module: &std::path::Path) -> serde_json::Value {
    let json = output(Command::new("node").args(["--input-type=module", "-e", r#"
        import { readFileSync } from 'node:fs';
        let stack;
        const module = new WebAssembly.Module(readFileSync(process.argv[1]));
        const imports = { env: { capture() { stack = new Error().stack; } } };
        // This is an instrumenter fixture, not a kernel/fork test. Every
        // imported callback outside capture must remain unused in normal
        // execution; throw rather than silently emulate missing behavior.
        for (const entry of WebAssembly.Module.imports(module)) {
            const namespace = imports[entry.module] ??= {};
            if (entry.name in namespace) continue;
            if (entry.kind === 'function') namespace[entry.name] = () => { throw new Error(`unexpected ${entry.name}`); };
            else if (entry.kind === 'global') namespace[entry.name] = entry.name.includes('generation') ? 0n : 7;
            else if (entry.kind === 'table') namespace[entry.name] = new WebAssembly.Table({ element: entry.name === '__wpk_fork_ref_gc_transit' ? 'anyref' : 'anyfunc', initial: 128 });
            else if (entry.kind === 'tag') namespace[entry.name] = new WebAssembly.Tag({ parameters: [] });
            else throw new Error(`unexpected ${entry.kind} ${entry.name}`);
        }
        const instance = new WebAssembly.Instance(module, imports);
        instance.exports.wpk_fork_module_bootstrap?.();
        instance.exports.outer();
        const frames = [...stack.matchAll(/at (?:[^\s]+\.)?(inner|outer) .*wasm-function\[\d+\]:0x([a-f0-9]+)/g)]
            .map(([,name,pc]) => ({ name, pc: parseInt(pc, 16) }));
        if (frames.length !== 2) throw new Error(stack);
        console.log(JSON.stringify(frames));
    "#]).arg(module));
    serde_json::from_slice(&json).unwrap()
}

fn check_locations(
    files: &[String],
    frames: &serde_json::Value,
    lookup: impl Fn(u64) -> Option<fork_instrument::debug_info::Location>,
) {
    for (frame, (file, line, column)) in frames
        .as_array()
        .unwrap()
        .iter()
        .zip([("inner.c", 4, 5), ("outer.c", 3, 3)])
    {
        let location =
            lookup(frame["pc"].as_u64().unwrap()).unwrap_or_else(|| panic!("unresolved {frame}"));
        assert_eq!(
            files[location.file as usize],
            format!("/kandelo-debug-fixture/{file}")
        );
        assert_eq!(
            (location.line + 1, location.column + 1),
            (line, column),
            "{frame}"
        );
    }
}

#[test]
fn linked_dwarf4_and_dwarf5_resolve_executed_frame_locations() {
    let llvm = std::path::PathBuf::from(
        std::env::var_os("LLVM_BIN").expect("run this test using scripts/dev-shell.sh"),
    );
    let directory = tempfile::tempdir().unwrap();
    let source_root = directory.path().canonicalize().unwrap();
    fs::write(
        directory.path().join("inner.c"),
        include_str!("fixtures/debug-lines/inner.c"),
    )
    .unwrap();
    fs::write(
        directory.path().join("outer.c"),
        include_str!("fixtures/debug-lines/outer.c"),
    )
    .unwrap();
    let module = directory.path().join("linked.wasm");
    for version in [4, 5] {
        output(
            Command::new(llvm.join("clang"))
                .current_dir(&source_root)
                .args([
                    "--target=wasm32-unknown-unknown",
                    "-g",
                    &format!("-gdwarf-{version}"),
                    "-O0",
                    "-nostdlib",
                ])
                .arg(format!("-fuse-ld={}", llvm.join("wasm-ld").display()))
                .arg(format!(
                    "-fdebug-prefix-map={}=/kandelo-debug-fixture",
                    source_root.display()
                ))
                .args([
                    "-Wl,--export=outer",
                    "-Wl,--no-entry",
                    "-Wl,--allow-undefined",
                    "inner.c",
                    "outer.c",
                    "-o",
                ])
                .arg(&module),
        );
        let input = fs::read(&module).unwrap();
        let lines = LineTable::read(&input, Limits::default()).unwrap();
        check_locations(&lines.files, &frames(&module), |pc| lines.lookup(pc));

        for participates in [false, true] {
            let options = Options {
                entry_import: if participates {
                    "env.capture"
                } else {
                    "kernel.kernel_fork"
                }
                .into(),
                sinks: false,
                ..Default::default()
            };
            let artifact = native::instrument_with_debug(
                &input,
                &options,
                Default::default(),
                Default::default(),
            )
            .unwrap();
            assert_eq!(artifact.decision.participates, participates);
            assert_eq!(
                artifact.bytes.bytes(),
                native::instrument(&input, &options, Default::default())
                    .unwrap()
                    .bytes
                    .bytes(),
                "debug metadata must not change executable emission"
            );
            let map = SourceMap::read(
                artifact.source_map.as_ref().unwrap().bytes(),
                Default::default(),
            )
            .unwrap();
            let prepared = directory.path().join("prepared.wasm");
            fs::write(&prepared, artifact.bytes.bytes()).unwrap();
            check_locations(&map.files, &frames(&prepared), |pc| map.lookup(pc));
            if participates {
                // Original C has three defined bodies (ctors/inner/outer).
                // None of the generated runtime helpers may acquire lines.
                let mut defined = 0;
                for payload in wasmparser::Parser::new(0).parse_all(artifact.bytes.bytes()) {
                    if let wasmparser::Payload::CodeSectionEntry(body) = payload.unwrap() {
                        defined += 1;
                        if defined > 3 {
                            for offset in body.range() {
                                assert_eq!(map.lookup(offset as u64), None);
                            }
                        }
                    }
                }
                assert!(defined > 3);
            }
            for optimize in ["none", "O1"] {
                let prepared = directory.path().join("cli-prepared.wasm");
                output(
                    Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
                        .arg(&module)
                        .arg("-o")
                        .arg(&prepared)
                        .args([
                            "--entry",
                            &options.entry_import,
                            "--no-sinks",
                            "--keep-names",
                            "--debug-map",
                            "--post-optimize",
                            optimize,
                        ]),
                );
                let bytes = fs::read(&prepared).unwrap();
                let map = fork_instrument::debug_info::embedded_map(&bytes, Default::default())
                    .unwrap()
                    .unwrap();
                let actual_frames = frames(&prepared);
                check_locations(&map.files, &actual_frames, |pc| map.lookup(pc));
                let pc = actual_frames[0]["pc"].as_u64().unwrap();
                let resolved = output(
                    Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
                        .arg(&prepared)
                        .args(["--debug-location", &format!("0x{pc:x}")]),
                );
                let resolved: serde_json::Value = serde_json::from_slice(&resolved).unwrap();
                use sha2::{Digest, Sha256};
                assert_eq!(resolved["sha256"], format!("{:x}", Sha256::digest(&bytes)));
                assert_eq!(
                    resolved["location"]["file"],
                    "/kandelo-debug-fixture/inner.c"
                );
                assert_eq!(resolved["location"]["line"], 4);
                assert_eq!(resolved["location"]["column"], 5);
                if !participates {
                    let copied = native::instrument(&bytes, &options, Default::default()).unwrap();
                    assert!(
                        fork_instrument::debug_info::embedded_map(
                            copied.bytes.bytes(),
                            Default::default()
                        )
                        .unwrap()
                        .is_none(),
                        "ordinary preparation must not preserve a stale map"
                    );
                }
            }
        }
        assert!(
            LineTable::read(
                &input,
                Limits {
                    rows: 1,
                    ..Limits::default()
                }
            )
            .unwrap_err()
            .to_string()
            .contains("row budget")
        );
        assert!(
            LineTable::read(
                &input,
                Limits {
                    files: 1,
                    ..Limits::default()
                }
            )
            .unwrap_err()
            .to_string()
            .contains("file budget")
        );
        assert!(
            LineTable::read(
                &input,
                Limits {
                    path_bytes: 1,
                    ..Limits::default()
                }
            )
            .unwrap_err()
            .to_string()
            .contains("path budget")
        );
        assert!(
            LineTable::read(
                &input,
                Limits {
                    section_bytes: 1,
                    ..Limits::default()
                }
            )
            .unwrap_err()
            .to_string()
            .contains("metadata budget")
        );
    }
}

#[test]
fn missing_dwarf_fails_before_replacing_the_destination() {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("input.wasm");
    let destination = directory.path().join("prepared.wasm");
    fs::write(&input, wat::parse_str("(module (func))").unwrap()).unwrap();
    fs::write(&destination, b"existing destination").unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg(input)
        .arg("-o")
        .arg(&destination)
        .arg("--debug-map")
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("no DWARF line information"));
    assert_eq!(fs::read(destination).unwrap(), b"existing destination");
}

#[test]
fn rust_source_locations_survive_the_full_optimized_cli() {
    let directory = tempfile::tempdir().unwrap();
    let source_root = directory.path().canonicalize().unwrap();
    let source = directory.path().join("frames.rs");
    fs::write(&source, include_str!("fixtures/debug-lines/frames.rs")).unwrap();
    let module = directory.path().join("rust.wasm");
    output(
        Command::new("rustc")
            .current_dir(&source_root)
            .args([
                "--edition=2024",
                "--crate-type=cdylib",
                "--target=wasm32-unknown-unknown",
                "-g",
                "-Cpanic=abort",
                "-Copt-level=0",
                "-Clink-arg=--allow-undefined",
            ])
            .arg(format!(
                "--remap-path-prefix={}=/kandelo-debug-fixture",
                source_root.display()
            ))
            .arg("frames.rs")
            .arg("-o")
            .arg(&module),
    );
    let prepared = directory.path().join("rust-prepared.wasm");
    let original = fs::read(&module).unwrap();
    let lines = LineTable::read(&original, Default::default()).unwrap();
    let original_frames = frames(&module);
    for (frame, (line, column)) in original_frames
        .as_array()
        .unwrap()
        .iter()
        .zip([(15, 9), (21, 5)])
    {
        let location = lines.lookup(frame["pc"].as_u64().unwrap()).unwrap();
        assert_eq!(
            lines.files[location.file as usize],
            "/kandelo-debug-fixture/frames.rs"
        );
        assert_eq!((location.line + 1, location.column + 1), (line, column));
    }
    output(
        Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
            .arg(&module)
            .arg("-o")
            .arg(&prepared)
            .args([
                "--entry",
                "env.capture",
                "--no-sinks",
                "--keep-names",
                "--debug-map",
                "--post-optimize",
                "O1",
            ]),
    );
    let bytes = fs::read(&prepared).unwrap();
    let map = fork_instrument::debug_info::embedded_map(&bytes, Default::default())
        .unwrap()
        .unwrap();
    let actual_frames = frames(&prepared);
    for (frame, (line, column)) in actual_frames
        .as_array()
        .unwrap()
        .iter()
        .zip([(15, 9), (21, 5)])
    {
        let location = map.lookup(frame["pc"].as_u64().unwrap()).unwrap();
        assert_eq!(
            map.files[location.file as usize],
            "/kandelo-debug-fixture/frames.rs"
        );
        assert_eq!(
            (location.line + 1, location.column + 1),
            (line, column),
            "{frame}"
        );
    }
}
