//! Function-local sink interpretation over original wasmparser operators.
//!
//! The environment supplies whole-program call summaries/target refinements.
//! This evaluator owns no module instruction cache or whole-module target map.
//! Whole-program planning composes these local evaluations over file-backed facts.

mod cached_bodies;
mod engine;
mod evaluate;
mod jmp;
mod parameters;
mod planner;
mod policy;
mod program;
mod resolved_targets;
mod summaries;
mod target_groups;
mod target_sets;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use anyhow::Result;

use super::ProgramPoint;

pub use engine::*;
pub use evaluate::evaluate;
pub use parameters::*;
pub use planner::*;
pub use policy::*;
pub use program::*;
pub use summaries::*;

pub type Tags = u64;
pub const ALL_TAGS: Tags = u64::MAX;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Value {
    Unknown,
    Constant(i64),
    Parameter(u32),
    Exception(Tags),
    StackAddress(i64),
}

pub fn join_value(a: Value, b: Value) -> Value {
    match (a, b) {
        _ if a == b => a,
        (Value::Exception(a), Value::Exception(b)) => Value::Exception(a | b),
        _ => Value::Unknown,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct State {
    pub live: bool,
    /// Original local coordinates; an unused trailing declaration suffix is
    /// omitted. Parameters and every referenced local are present.
    pub locals: Vec<Value>,
    pub stack: Vec<Value>,
    /// Sorted entry-SP-relative (offset, byte width, value) slots.
    pub memory: Vec<(i64, u32, Value)>,
    pub stack_pointer: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Invocation {
    Direct(u32),
    Indirect { table: u32, ty: u32 },
    Reference { ty: u32 },
}

#[derive(Clone, Debug)]
pub struct CallEffect {
    /// None means no normal return; Some(Unknown) also represents void return.
    pub returned: Option<Value>,
    pub thrown: Tags,
    pub targets: Vec<u32>,
    pub external: bool,
}

/// Whole-program state stays outside the local evaluator. Implementations can
/// query disk-backed facts and load a bounded number of specialized callees.
pub trait Environment {
    fn call(
        &mut self,
        point: ProgramPoint,
        invocation: Invocation,
        selector: Value,
        arguments: &[Value],
        tail: bool,
    ) -> Result<CallEffect>;

    fn global_constant(&self, _global: u32) -> Option<i64> {
        None
    }

    fn stack_pointer_global(&self) -> Option<u32> {
        None
    }

    fn tag_bits(&self, _function: u32, tag: u32) -> Tags {
        1 << tag.min(63)
    }

    /// SjLj buffer identity may refine the generic longjmp catch bit.
    fn catch_bits(&self, function: u32, tag: u32) -> Tags {
        self.tag_bits(function, tag)
    }
}

#[derive(Clone, Debug)]
pub struct Injection {
    pub returned: Option<Value>,
    pub thrown: Tags,
    /// A catch-landing probe replaces this many final operand values.
    pub payload: Option<Vec<Value>>,
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Conservative upper bound on values across simultaneously live states,
    /// including structured-control scratch and recorded post-call states.
    pub state_values: usize,
    pub work: usize,
    pub control_depth: usize,
    pub frame_slots: usize,
    /// Memberships in distinct retained target sets of this one body.
    pub call_targets: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            // A sanity ceiling, not the intended working set. The preflight
            // estimate reserves maximum frame slots at every active control
            // level, even when a body writes only one slot. Keep it generous;
            // function-local interpretation provides the normal memory saving.
            state_values: u32::MAX as usize,
            work: crate::limits::LOCAL_WORK,
            control_depth: 16 * 1024,
            frame_slots: 4096,
            call_targets: 1024 * 1024,
        }
    }
}

#[derive(Clone, Copy, Default)]
pub struct Options<'a> {
    /// Child execution starts dead and resumes only at injected original sites.
    pub child: bool,
    pub entry_arguments: Option<&'a [Value]>,
    pub injections: Option<&'a BTreeMap<usize, Injection>>,
    pub normal_states: Option<&'a BTreeMap<usize, State>>,
    pub record_states: Option<&'a BTreeSet<usize>>,
    pub record_targets: bool,
    /// After an escaping frame-address pass, rerun with tracking disabled.
    pub disable_frame_tracking: bool,
}

#[derive(Debug, Default)]
pub struct Evaluation {
    pub returned: Option<Value>,
    pub thrown: Tags,
    pub unsupported: bool,
    pub frame_escaped: bool,
    pub exception_locals: Tags,
    /// Exact sorted unions per original instruction; identical sets share storage.
    pub targets: BTreeMap<usize, Arc<[u32]>>,
    pub states: BTreeMap<usize, State>,
    pub work_steps: usize,
}

fn join_state(into: &mut Option<State>, from: &State) -> bool {
    if !from.live {
        if into.is_none() {
            *into = Some(from.clone());
            return true;
        }
        return false;
    }
    let Some(state) = into.as_mut().filter(|s| s.live) else {
        *into = Some(from.clone());
        return true;
    };
    let mut changed = false;
    let before = state.memory.len();
    state.memory.retain_mut(|slot| {
        if let Some(other) = from.memory.iter().find(|s| s.0 == slot.0 && s.1 == slot.1) {
            let value = join_value(slot.2, other.2);
            changed |= value != slot.2;
            slot.2 = value;
            true
        } else {
            false
        }
    });
    changed |= state.memory.len() != before;
    if state.stack_pointer != from.stack_pointer && state.stack_pointer.is_some() {
        state.stack_pointer = None;
        changed = true;
    }
    for (a, b) in state.locals.iter_mut().zip(&from.locals) {
        let value = join_value(*a, *b);
        changed |= value != *a;
        *a = value;
    }
    let n = state.stack.len().min(from.stack.len());
    let (a, b) = (state.stack.len() - n, from.stack.len() - n);
    for i in 0..n {
        let value = join_value(state.stack[a + i], from.stack[b + i]);
        changed |= value != state.stack[a + i];
        state.stack[a + i] = value;
    }
    changed
}
