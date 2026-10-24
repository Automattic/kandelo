//! Deterministic normal-mode fixed point without all-body IR or snapshots.

use std::collections::{BTreeSet, VecDeque};

use anyhow::{Context, Result, ensure};

use super::{ALL_TAGS, Evaluation, Program, Tags};
use crate::streaming::{FunctionIr, IrLimits};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Summary {
    pub may_return: bool,
    pub thrown: Tags,
}

#[derive(Clone, Copy, Debug)]
pub struct SummaryLimits {
    pub metadata_bytes: usize,
    pub evaluations_per_function: usize,
    pub work: usize,
}

impl Default for SummaryLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: 128 * 1024 * 1024,
            evaluations_per_function: 50,
            work: crate::limits::TOTAL_WORK,
        }
    }
}

pub struct SummaryContext<'a> {
    /// Borrowed until evaluation returns; no per-evaluation module-wide copy.
    pub summaries: &'a [Summary],
    pub exception_locals: &'a [Tags],
    pub disable_frame_tracking: bool,
    pub work_remaining: usize,
}

#[derive(Debug)]
pub struct Summaries {
    pub functions: Vec<Summary>,
    pub exception_locals: Vec<Tags>,
    pub frame_escaped: Vec<bool>,
    pub unsupported: BTreeSet<u32>,
    pub evaluations: usize,
    pub work_steps: usize,
}

/// Solve summaries using the caller's complete normal-mode policy environment.
/// The callback runs the local evaluator with the provided remaining work
/// limit and returns its charged work. Parameter/registry/cleanup/signal policy
/// belongs to that environment, not this deterministic fixed-point driver.
pub fn solve_summaries<'a>(
    program: &Program<'_, 'a>,
    ir_limits: IrLimits,
    limits: SummaryLimits,
    mut evaluate: impl FnMut(&FunctionIr<'a>, SummaryContext<'_>) -> Result<Evaluation>,
) -> Result<Summaries> {
    let progress = crate::progress::Progress::new("summaries");
    let n = program.functions.len();
    progress.note(format_args!("start, {n} functions"));
    // Includes the result vectors, queue/flags, a worst-case unsupported set,
    // and one caller group. Module headers/IR have their own separate limits.
    ensure!(
        n <= limits.metadata_bytes / 128,
        "sink summaries exceed resident budget"
    );
    let max_evaluations = n
        .max(1)
        .checked_mul(limits.evaluations_per_function)
        .context("sink summary evaluation limit overflow")?;
    let mut output = Summaries {
        functions: vec![Summary::default(); n],
        exception_locals: vec![0; n],
        frame_escaped: vec![false; n],
        unsupported: BTreeSet::new(),
        evaluations: 0,
        work_steps: 0,
    };
    let mut queued = vec![false; n];
    let mut queue = VecDeque::new();
    for (function, info) in program.functions.iter().enumerate() {
        if info.imported {
            output.functions[function].may_return = true;
        } else {
            queue.push_back(function as u32);
            queued[function] = true;
        }
    }
    let mut provider = program.original_scan().body_provider(ir_limits);
    while let Some(function) = queue.pop_front() {
        let index = function as usize;
        queued[index] = false;
        let body = provider.load(function)?;
        let result = loop {
            ensure!(
                output.evaluations < max_evaluations,
                "sink summaries exceed evaluation budget"
            );
            output.evaluations += 1;
            if output.evaluations % 10_000 == 0 {
                progress.note(format_args!(
                    "{} evaluations, function {}, {} queued, {} work units",
                    output.evaluations,
                    function,
                    queue.len(),
                    output.work_steps,
                ));
            }
            let remaining = limits
                .work
                .checked_sub(output.work_steps)
                .context("sink summaries exceed work budget")?;
            let result = evaluate(
                &body,
                SummaryContext {
                    summaries: &output.functions,
                    exception_locals: &output.exception_locals,
                    disable_frame_tracking: output.frame_escaped[index],
                    work_remaining: remaining,
                },
            )?;
            ensure!(
                result.work_steps <= remaining,
                "sink summaries exceed work budget"
            );
            output.work_steps += result.work_steps;
            output.exception_locals[index] |= result.exception_locals;
            if result.frame_escaped && !output.frame_escaped[index] {
                output.frame_escaped[index] = true;
                continue;
            }
            break result;
        };
        // The borrowed source IR and local evaluation scratch are discarded
        // before fetching dependency groups or decoding another function.
        let mut summary = Summary {
            may_return: result.returned.is_some(),
            thrown: result.thrown,
        };
        if result.unsupported {
            output.unsupported.insert(function);
            summary = Summary {
                may_return: true,
                thrown: ALL_TAGS,
            };
        }
        drop(result);
        drop(body);
        let info = &program.functions[index];
        if info.noreturn {
            summary.may_return = false;
        }
        if info.nothrow {
            summary.thrown = 0;
        }
        let previous = output.functions[index];
        let next = Summary {
            may_return: previous.may_return || summary.may_return,
            thrown: previous.thrown | summary.thrown,
        };
        if next == previous {
            continue;
        }
        output.functions[index] = next;
        let mut enqueue = |caller: u32| {
            let caller = caller as usize;
            if !queued[caller] {
                queued[caller] = true;
                queue.push_back(caller as u32);
            }
        };
        for caller in program.direct_callers(function)? {
            enqueue(caller);
        }
        if info.escaping {
            for caller in program.indirect_callers_of(function)? {
                enqueue(caller);
            }
        }
    }
    progress.note(format_args!(
        "complete, {} evaluations, {} work units",
        output.evaluations, output.work_steps,
    ));
    Ok(output)
}
