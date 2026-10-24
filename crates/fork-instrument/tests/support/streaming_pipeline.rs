//! Diagnostic exports for tests of the library-owned full native assembly.
use fork_instrument::streaming::*;
use wasm_encoder::ExportKind;

pub fn emit(input: &[u8], shared_codecs: bool) -> Vec<u8> {
    let analysis = fork_instrument::native::analyze(
        input,
        &fork_instrument::Options {
            entry_import: "h.fork".into(),
            ..Default::default()
        },
        Default::default(),
    )
    .unwrap();
    let mut plan = NativePipeline::plan(
        analysis.scan,
        analysis.reaching,
        PipelineOptions {
            shared_codecs,
            boundaries: analysis.boundaries,
            side_module: analysis.decision.side_module,
            ..Default::default()
        },
        Default::default(),
    )
    .unwrap();
    let resumes = plan
        .scan()
        .exports
        .iter()
        .filter_map(|(name, kind, function)| {
            (*kind == wasmparser::ExternalKind::Func)
                .then(|| {
                    plan.activations()
                        .entry(*function)
                        .map(|entry| (format!("resume_{name}"), entry.resume))
                })
                .flatten()
        })
        .collect::<Vec<_>>();
    for (name, function) in resumes {
        plan.export(&name, ExportKind::Func, function).unwrap();
    }
    let runtime = plan.runtime().indices();
    for (name, kind, index) in [
        ("unwind_tag", ExportKind::Tag, runtime.unwind_tag),
        (
            "__test_encode_externref",
            ExportKind::Func,
            runtime.codecs.externref.encode,
        ),
        (
            "__test_decode_externref",
            ExportKind::Func,
            runtime.codecs.externref.decode,
        ),
    ] {
        plan.export(name, kind, index).unwrap();
    }
    let mut output = Vec::new();
    plan.emit(&mut output).unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    output
}
