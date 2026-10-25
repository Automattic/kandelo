//! Shared oracle-compatible lexical retention, distinct from reachability.
use anyhow::{Result, ensure};
use wasmparser::Operator;

pub(crate) struct LexicalRetention {
    frames: Vec<(bool, bool)>,
    limit: usize,
}
impl LexicalRetention {
    pub fn new(limit: usize) -> Result<Self> {
        ensure!(limit > 0, "native metadata exceeds control-frame budget");
        Ok(Self {
            frames: vec![(true, true)],
            limit,
        })
    }
    pub fn visit(&mut self, op: &Operator<'_>) -> Result<bool> {
        let active = self
            .frames
            .last()
            .is_some_and(|&(attached, live)| attached && live);
        match op {
            Operator::Block { .. }
            | Operator::Loop { .. }
            | Operator::If { .. }
            | Operator::Try { .. }
            | Operator::TryTable { .. } => {
                ensure!(
                    self.frames.len() < self.limit,
                    "native metadata exceeds control-frame budget"
                );
                self.frames.push((active, true));
            }
            Operator::Else | Operator::Catch { .. } | Operator::CatchAll => {
                self.frames
                    .last_mut()
                    .ok_or_else(|| anyhow::anyhow!("handler without control frame"))?
                    .1 = true
            }
            Operator::End | Operator::Delegate { .. } => {
                ensure!(self.frames.pop().is_some(), "end without control frame");
            }
            // Retain return_call* suffixes: compiler-fact signature
            // matching and user-local ordering must use the same policy.
            Operator::Return
            | Operator::Unreachable
            | Operator::Br { .. }
            | Operator::BrTable { .. }
            | Operator::Throw { .. }
            | Operator::ThrowRef
            | Operator::Rethrow { .. } => {
                self.frames
                    .last_mut()
                    .ok_or_else(|| anyhow::anyhow!("transfer without control frame"))?
                    .1 = false
            }
            _ => {}
        }
        Ok(active)
    }
}
