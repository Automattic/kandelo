//! Diagnostic exports for tests of the library-owned full native assembly.
use fork_instrument::streaming::*;
use wasm_encoder::ExportKind;

pub fn emit(input: &[u8], shared_codecs: bool) -> Vec<u8> {
    let scan = scan(input).unwrap();
    let mut loader = false;
    let seeds = scan
        .functions
        .iter()
        .enumerate()
        .filter_map(|(index, source)| {
            let (module, name) = source.import.as_ref()?;
            if module == "env" && name == "__wasm_dlopen" {
                loader = true;
            }
            ((module == "h" && name == "fork") || (module == "env" && name == "__wasm_dlopen"))
                .then_some(u32::try_from(index).unwrap())
        })
        .collect::<Vec<_>>();
    let reaching = scan.reaching_from_seeds(seeds, loader).unwrap();
    let mut plan = NativePipeline::plan(
        scan,
        reaching,
        PipelineOptions {
            shared_codecs,
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
