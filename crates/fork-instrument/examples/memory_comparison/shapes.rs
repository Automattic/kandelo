//! Inspect function shapes without compiler-facts solving or instruction IR.
use anyhow::Result;
use fork_instrument::{artifact_io::MappedArtifact, streaming::scan};
use std::path::Path;
use wasmparser::{BinaryReader, FunctionBody, Operator};

#[derive(Default)]
struct Maximum {
    function: usize,
    value: u64,
}
impl Maximum {
    fn record(&mut self, function: usize, value: u64) {
        if value > self.value {
            *self = Self { function, value };
        }
    }
    fn json(&self) -> String {
        format!(
            "{{\"function\":{},\"value\":{}}}",
            self.function, self.value
        )
    }
}

pub(super) fn inspect(path: &Path) -> Result<()> {
    let (input, _) = MappedArtifact::read(path, 8 * 1024 * 1024 * 1024)?;
    let scan = scan(input.bytes())?;
    let (mut operators, mut locals, mut nesting, mut calls) = (
        Maximum::default(),
        Maximum::default(),
        Maximum::default(),
        Maximum::default(),
    );
    let mut functions = 0;
    for (function, source) in scan.functions.iter().enumerate() {
        let Some(summary) = &source.body else {
            continue;
        };
        functions += 1;
        operators.record(function, summary.operators);
        locals.record(function, summary.local_count);
        let body = FunctionBody::new(BinaryReader::new(
            &input.bytes()[summary.range.clone()],
            summary.range.start,
        ));
        let mut reader = body.get_operators_reader()?;
        let (mut depth, mut maximum_depth, mut call_count) = (0_u64, 0, 0);
        while !reader.eof() {
            match reader.read()? {
                Operator::Block { .. }
                | Operator::Loop { .. }
                | Operator::If { .. }
                | Operator::Try { .. }
                | Operator::TryTable { .. } => {
                    depth += 1;
                    maximum_depth = maximum_depth.max(depth);
                }
                // The final function End has no corresponding nested region.
                Operator::End | Operator::Delegate { .. } => depth = depth.saturating_sub(1),
                Operator::Call { .. }
                | Operator::CallIndirect { .. }
                | Operator::CallRef { .. } => {
                    call_count += 1;
                }
                _ => {}
            }
        }
        nesting.record(function, maximum_depth);
        calls.record(function, call_count);
    }
    println!(
        "{{\"functions\":{functions},\"max_operators\":{},\"max_declared_locals\":{},\"max_control_depth\":{},\"max_normal_calls\":{}}}",
        operators.json(),
        locals.json(),
        nesting.json(),
        calls.json(),
    );
    Ok(())
}
