use fork_instrument::streaming::{scan as scan_module, *};
use std::{
    collections::BTreeSet,
    io::{self, Write},
};

fn source() -> Vec<u8> {
    wat::parse_str(
        r#"(module
        (import "kernel" "kernel_fork" (func $fork (result i32)))
        (import "env" "memory" (memory 2))
        (global (export "visits") (mut i32) (i32.const 0))
        (func (export "root") (result i32)
            (global.set 0 (i32.add (global.get 0) (i32.const 1)))
            (call $fork))
        (data (i32.const 64) "original data"))"#,
    )
    .unwrap()
}
fn plan(input: &[u8], limits: PipelineLimits) -> NativePipeline<'_> {
    let scan = scan_module(input).unwrap();
    let reaching = scan.reaching_from_seeds([0], false).unwrap();
    NativePipeline::plan(scan, reaching, Default::default(), limits).unwrap()
}
fn emit(plan: &mut NativePipeline<'_>) -> Vec<u8> {
    let mut output = Vec::new();
    let report = plan.emit(&mut output).unwrap();
    assert!(report.helper_functions > 7);
    assert!(report.spooled_code_bytes > 0);
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    output
}

#[test]
fn frozen_plan_repeats_and_does_not_claim_production_certification() {
    let input = source();
    let mut planned = plan(&input, Default::default());
    let first = emit(&mut planned);
    assert_eq!(first, emit(&mut planned));
    assert_eq!(first, emit(&mut plan(&input, Default::default())));
    let output = scan_module(&first).unwrap();
    for required in [
        "kandelo.wpk_fork.gc_codec",
        "kandelo.wpk_fork.exception_codec",
        fork_instrument::instrument::RESUME_CATALOG_SECTION,
    ] {
        assert_eq!(output.custom_data(required).count(), 1, "{required}");
    }
    assert_eq!(
        output
            .custom_data(wasm_posix_shared::abi::WPK_FORK_CAPABILITIES_SECTION)
            .count(),
        0
    );
}

struct InterruptedWriter {
    remaining: usize,
}
impl Write for InterruptedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Err(io::Error::other("test destination failed"));
        }
        let written = bytes.len().min(self.remaining);
        self.remaining -= written;
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
#[test]
fn failed_destination_can_retry_the_same_frozen_plan() {
    let input = source();
    let mut planned = plan(&input, Default::default());
    let expected = emit(&mut planned);
    for remaining in [0, 16, expected.len() / 2, expected.len() - 1] {
        let error = planned
            .emit(&mut InterruptedWriter { remaining })
            .unwrap_err();
        assert!(
            error.to_string().contains("test destination failed"),
            "{error:#}"
        );
        assert_eq!(expected, emit(&mut planned));
    }
}

#[test]
fn emission_and_planning_limits_are_enforced() {
    let input = source();
    let mut limits = PipelineLimits::default();
    limits.emission.max_metadata_section_bytes = 1;
    let mut planned = plan(&input, limits);
    let mut output = Vec::new();
    assert!(
        planned
            .emit(&mut output)
            .unwrap_err()
            .to_string()
            .contains("descriptor")
    );
    assert!(
        output.is_empty(),
        "descriptor preflight precedes the module header"
    );
    let mut limits = PipelineLimits::default();
    limits.emission.max_function_bytes = 1;
    assert!(plan(&input, limits).emit(&mut Vec::new()).is_err());
    let scan = scan_module(&input).unwrap();
    let reaching = scan.reaching_from_seeds([0], false).unwrap();
    let error = NativePipeline::plan(
        scan,
        reaching,
        Default::default(),
        PipelineLimits {
            metadata_bytes: 128,
            ..Default::default()
        },
    )
    .err()
    .unwrap();
    assert!(error.to_string().contains("metadata budget"));
}

#[test]
fn closure_boundary_and_process_memory_inputs_are_checked() {
    let input = source();
    for case in [0, 1, 2] {
        let scan = scan_module(&input).unwrap();
        let mut reaching = scan.reaching_from_seeds([0], false).unwrap();
        let mut options = PipelineOptions::default();
        let expected = match case {
            0 => {
                reaching.activations.insert(99);
                "unknown function"
            }
            1 => {
                options.boundaries.insert(0);
                "selected source body"
            }
            _ => {
                options.staging_memory = Some(wasm_encoder::MemoryType {
                    minimum: 0,
                    maximum: Some(65536),
                    memory64: true,
                    shared: true,
                    page_size_log2: None,
                });
                "cannot replace source memory"
            }
        };
        let error = NativePipeline::plan(scan, reaching, options, Default::default())
            .err()
            .unwrap();
        assert!(error.to_string().contains(expected), "{error:#}");
    }
    let input = wat::parse_str(
        r#"(module
        (import "env" "__wasm_dlopen" (func (param i32 i32) (result i32))))"#,
    )
    .unwrap();
    let scan = scan_module(&input).unwrap();
    let reaching = scan.reaching_from_seeds([], false).unwrap();
    let error = NativePipeline::plan(scan, reaching, Default::default(), Default::default())
        .err()
        .unwrap();
    assert!(error.to_string().contains("omits a legacy loader boundary"));
}

#[test]
fn selected_sink_boundary_reserves_one_runtime_callback() {
    let input = source();
    let scan = scan_module(&input).unwrap();
    let reaching = scan.reaching_from_seeds([0], false).unwrap();
    let mut planned = NativePipeline::plan(
        scan,
        reaching,
        PipelineOptions {
            boundaries: BTreeSet::from([1]),
            ..Default::default()
        },
        Default::default(),
    )
    .unwrap();
    let output = emit(&mut planned);
    let scan = scan_module(&output).unwrap();
    assert_eq!(
        scan.functions
            .iter()
            .filter(|f| f.import.as_ref().is_some_and(|(module, name)| module
                == wasm_posix_shared::abi::WPK_FORK_FRAME_IMPORT_MODULE
                && name == wasm_posix_shared::abi::WPK_FORK_BOUNDARY_IMPORT))
            .count(),
        1
    );
}
