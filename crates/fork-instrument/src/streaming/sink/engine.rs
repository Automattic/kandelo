//! Policy-backed interpretation with bounded, function-local specialization.

use std::collections::{BTreeMap, VecDeque};

use anyhow::{Result, ensure};

use super::cached_bodies::CachedBodies;
use super::resolved_targets::ResolvedTargetCache;
use super::{
    ALL_TAGS, CallEffect, Environment, Evaluation, Invocation, Limits, Options, PolicyPlan,
    Summaries, Summary, SummaryLimits, Tags, Value, evaluate, solve_summaries,
};
use crate::streaming::{FunctionIr, IrLimits, ProgramPoint};

#[derive(Clone, Copy, Debug)]
pub struct InterpreterLimits {
    pub ir: IrLimits,
    pub evaluation: Limits,
    pub specialization_depth: u32,
    /// Estimated cache payload, including both copies of FIFO keys.
    pub specialization_cache_bytes: usize,
    /// Call selection under the frozen policy, independent of summary changes.
    pub resolved_target_cache_bytes: usize,
    /// Estimated retained payload of decoded specialization callees.
    pub decoded_body_cache_bytes: usize,
}

impl Default for InterpreterLimits {
    fn default() -> Self {
        Self {
            ir: IrLimits::default(),
            evaluation: Limits::default(),
            specialization_depth: 3,
            specialization_cache_bytes: 4 * 1024 * 1024,
            resolved_target_cache_bytes: 2 * 1024 * 1024,
            decoded_body_cache_bytes: 8 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Key {
    function: u32,
    arguments: Vec<Value>,
}

#[derive(Clone, Copy)]
struct Specialized {
    returned: Option<Value>,
    thrown: Tags,
    charge: usize,
}

#[derive(Default)]
struct Cache {
    values: BTreeMap<Key, Specialized>,
    fifo: VecDeque<Key>,
    bytes: usize,
}

impl Cache {
    fn clear(&mut self) {
        self.values.clear();
        self.fifo.clear();
        self.bytes = 0;
    }
    fn insert(&mut self, key: Key, mut value: Specialized, limit: usize) {
        value.charge = key
            .arguments
            .len()
            .saturating_mul(2 * std::mem::size_of::<Value>())
            .saturating_add(192);
        if value.charge > limit {
            return;
        }
        while self.bytes > limit - value.charge {
            let oldest = self.fifo.pop_front().unwrap();
            self.bytes -= self.values.remove(&oldest).unwrap().charge;
        }
        // A recursive evaluation can have filled the same key while this
        // caller was running. Keep the first valid conservative result.
        if self.values.contains_key(&key) {
            return;
        }
        self.bytes += value.charge;
        self.fifo.push_back(key.clone());
        self.values.insert(key, value);
    }
}

/// Holds shared body resources, compact frame-escape flags and bounded caches.
/// Specialized effects are cleared per root evaluation; resolved targets live
/// as long as the frozen policy and never contain summary-dependent effects.
pub struct SinkInterpreter<'p, 's, 'a> {
    plan: &'p PolicyPlan<'p, 's, 'a>,
    bodies: CachedBodies<'p, 'a>,
    limits: InterpreterLimits,
    remaining: usize,
    escaped: Vec<bool>,
    cache: Cache,
    resolved_targets: ResolvedTargetCache,
}

impl<'p, 's, 'a> SinkInterpreter<'p, 's, 'a> {
    pub fn new(plan: &'p PolicyPlan<'p, 's, 'a>, limits: InterpreterLimits) -> Result<Self> {
        ensure!(
            limits.specialization_depth <= 3,
            "native specialization depth exceeds supported limit"
        );
        let program = plan.original_program();
        Ok(Self {
            plan,
            bodies: CachedBodies::new(
                program.original_scan(),
                limits.ir,
                limits.decoded_body_cache_bytes,
            ),
            limits,
            remaining: 0,
            escaped: vec![false; program.functions.len()],
            cache: Cache::default(),
            resolved_targets: ResolvedTargetCache::default(),
        })
    }

    pub fn frame_escaped(&self) -> &[bool] {
        &self.escaped
    }

    /// Normal-mode utility for recording a final per-function result after
    /// discovering an escaping frame. Child-mode callers must recompute their
    /// normal post-call states when changing the frame-tracking mode.
    pub fn evaluate_stable(
        &mut self,
        body: &FunctionIr<'a>,
        summaries: &[Summary],
        mut options: Options<'_>,
        specialize: bool,
        work: usize,
    ) -> Result<Evaluation> {
        ensure!(
            !options.child,
            "child evaluation requires refreshed normal states"
        );
        let mut used = 0usize;
        loop {
            let remaining = work
                .checked_sub(used)
                .ok_or_else(|| anyhow::anyhow!("native interpreter exceeds work budget"))?;
            let mut result = self.evaluate(body, summaries, options, specialize, remaining)?;
            used += result.work_steps;
            if result.frame_escaped && !options.disable_frame_tracking {
                options.disable_frame_tracking = true;
                continue;
            }
            result.work_steps = used;
            return Ok(result);
        }
    }

    pub fn evaluate(
        &mut self,
        body: &FunctionIr<'a>,
        summaries: &[Summary],
        options: Options<'_>,
        specialize: bool,
        work: usize,
    ) -> Result<Evaluation> {
        ensure!(
            summaries.len() == self.escaped.len(),
            "native interpreter summary catalog mismatch"
        );
        ensure!(
            (body.function as usize) < self.escaped.len(),
            "unknown native interpreter function"
        );
        self.remaining = work;
        self.cache.clear();
        self.run(body, summaries, options, specialize, 0)
    }

    pub fn normal_summaries(&mut self, limits: SummaryLimits) -> Result<Summaries> {
        let plan = self.plan;
        let mut output = solve_summaries(
            plan.original_program(),
            self.limits.ir,
            limits,
            |body, context| {
                self.evaluate(
                    body,
                    context.summaries,
                    Options {
                        disable_frame_tracking: context.disable_frame_tracking,
                        ..Default::default()
                    },
                    false,
                    context.work_remaining,
                )
            },
        )?;
        for (stored, escaped) in output.frame_escaped.iter_mut().zip(&self.escaped) {
            *stored |= *escaped;
        }
        Ok(output)
    }

    fn run(
        &mut self,
        body: &FunctionIr<'a>,
        summaries: &[Summary],
        mut options: Options<'_>,
        specialize: bool,
        depth: u32,
    ) -> Result<Evaluation> {
        let before = self.remaining;
        let budget = self.limits.evaluation.work.min(before);
        ensure!(budget > 0, "native interpreter exceeds work budget");
        // Reserve the caller's maximum work before recursively interpreting a
        // callee, then refund unused work. Nested calls cannot overspend the
        // outer budget; declining optional specialization stays conservative.
        self.remaining -= budget;
        options.disable_frame_tracking |= self.escaped[body.function as usize];
        let limits = Limits {
            work: budget,
            ..self.limits.evaluation
        };
        let plan = self.plan;
        let scan = plan.original_program().original_scan();
        let mut calls = Calls {
            interpreter: self,
            summaries,
            specialize,
            depth,
        };
        let mut output = evaluate(scan, body, &mut calls, options, limits)?;
        self.remaining += budget - output.work_steps;
        self.escaped[body.function as usize] |= output.frame_escaped;
        output.work_steps = before - self.remaining;
        Ok(output)
    }

    fn specialized(
        &mut self,
        function: u32,
        arguments: &[Value],
        summaries: &[Summary],
        depth: u32,
    ) -> Result<Option<Specialized>> {
        let key = Key {
            function,
            arguments: arguments
                .iter()
                .map(|v| {
                    if matches!(v, Value::Constant(_)) {
                        *v
                    } else {
                        Value::Unknown
                    }
                })
                .collect(),
        };
        if let Some(value) = self.cache.values.get(&key) {
            return Ok(Some(*value));
        }
        if self.remaining == 0 {
            return Ok(None);
        }
        let body = self.bodies.load(function)?;
        let entry: Vec<_> = key
            .arguments
            .iter()
            .enumerate()
            .map(|(i, v)| {
                if *v == Value::Unknown {
                    Value::Parameter(i as u32)
                } else {
                    *v
                }
            })
            .collect();
        let mut result;
        loop {
            let disabled = self.escaped[function as usize];
            result = self.run(
                &body,
                summaries,
                Options {
                    entry_arguments: Some(&entry),
                    disable_frame_tracking: disabled,
                    ..Default::default()
                },
                true,
                depth,
            )?;
            if result.frame_escaped && !disabled {
                continue;
            }
            break;
        }
        let mut value = if result.unsupported {
            Specialized {
                returned: Some(Value::Unknown),
                thrown: ALL_TAGS,
                charge: 0,
            }
        } else {
            Specialized {
                returned: result.returned.map(|v| {
                    if matches!(v, Value::Parameter(_) | Value::StackAddress(_)) {
                        Value::Unknown
                    } else {
                        v
                    }
                }),
                thrown: result.thrown,
                charge: 0,
            }
        };
        let info = &self.plan.original_program().functions[function as usize];
        if info.noreturn {
            value.returned = None;
        }
        if info.nothrow {
            value.thrown = 0;
        }
        self.cache
            .insert(key, value, self.limits.specialization_cache_bytes);
        Ok(Some(value))
    }
}

struct Calls<'c, 'p, 's, 'a, 'm> {
    interpreter: &'c mut SinkInterpreter<'p, 's, 'a>,
    summaries: &'m [Summary],
    specialize: bool,
    depth: u32,
}

impl Environment for Calls<'_, '_, '_, '_, '_> {
    fn call(
        &mut self,
        point: ProgramPoint,
        invocation: Invocation,
        selector: Value,
        arguments: &[Value],
        tail: bool,
    ) -> Result<CallEffect> {
        let plan = self.interpreter.plan;
        // WHY: call selection reads only the frozen policy and original source
        // coordinates. Reuse it across summary revisions, but recompute effects
        // and specialization below against the current return/throw summaries.
        let key = (point, invocation, selector, tail);
        let cacheable = !matches!(invocation, Invocation::Direct(_))
            && self.interpreter.limits.resolved_target_cache_bytes != 0;
        let selected =
            if cacheable && let Some(targets) = self.interpreter.resolved_targets.get(&key) {
                targets
            } else {
                let targets = plan.resolve(point, invocation, selector, tail)?;
                if cacheable {
                    self.interpreter.resolved_targets.insert(
                        key,
                        &targets,
                        self.interpreter.limits.resolved_target_cache_bytes,
                    );
                }
                targets
            };
        if selected.cut {
            return Ok(CallEffect {
                returned: None,
                thrown: 0,
                targets: Vec::new(),
                external: false,
            });
        }
        let mut returned = selected.external.then_some(Value::Unknown);
        let mut thrown = if selected.external { ALL_TAGS } else { 0 };
        for &function in &selected.functions {
            if function == u32::MAX {
                returned = Some(Value::Unknown);
                continue;
            }
            let summary = self.summaries[function as usize];
            if summary.may_return {
                returned = Some(Value::Unknown);
            }
            thrown |= summary.thrown;
        }
        if self.specialize
            && !tail
            && !selected.external
            && self.depth < self.interpreter.limits.specialization_depth
            && let [function] = selected.functions.as_slice()
            && let Some(info) = plan.original_program().functions.get(*function as usize)
            && !info.imported
            && info.small
            && arguments.iter().any(|v| matches!(v, Value::Constant(_)))
            && let Some(value) = self.interpreter.specialized(
                *function,
                arguments,
                self.summaries,
                self.depth + 1,
            )?
        {
            returned = value.returned;
            thrown = value.thrown;
        }
        thrown = plan.remap_longjmp(
            point.function,
            &selected.functions,
            selected.external,
            thrown,
        );
        Ok(CallEffect {
            returned,
            thrown,
            targets: selected.functions,
            external: selected.external,
        })
    }
    fn global_constant(&self, index: u32) -> Option<i64> {
        self.interpreter.plan.original_program().global_constants[index as usize]
    }
    fn stack_pointer_global(&self) -> Option<u32> {
        self.interpreter
            .plan
            .original_program()
            .stack_pointer_global
    }
    fn catch_bits(&self, function: u32, tag: u32) -> Tags {
        self.interpreter.plan.catch_bits(function, tag)
    }
}
