//! Typed WAT generator for fork-instrument fuzzing.
//!
//! Deterministically emits a WAT program from an `Arbitrary` input.
//! Every generator output is a syntactically well-formed module that
//! imports `kernel.kernel_fork` so the instrumenter has work to do.
//!
//! This file starts narrow: one try_table shape with a catch_ref
//! clause on the fork path. Subsequent tasks extend the input space
//! (nested try_tables, ref-typed locals, multi-function fork paths).

use arbitrary::{Arbitrary, Unstructured};

/// One generated program. Keep fields private so future generator
/// extensions don't require downstream changes.
#[derive(Debug)]
pub struct WatProgram {
    /// 0..=3 extra i32 locals in the fork-path function. Ensures we
    /// exercise frame-save/restore for varying scalar-local counts.
    extra_i32_locals: u8,
    /// When true, prepend a `(memory.grow)` noop in the fork-path body
    /// to exercise Phase 4g's gating of memory-mutation ops.
    has_memory_grow: bool,
}

impl<'a> Arbitrary<'a> for WatProgram {
    fn arbitrary(u: &mut Unstructured<'a>) -> arbitrary::Result<Self> {
        Ok(Self {
            extra_i32_locals: u8::arbitrary(u)? & 0b11, // 0..=3
            has_memory_grow: bool::arbitrary(u)?,
        })
    }
}

impl WatProgram {
    /// Render this program as WAT source text. Always syntactically
    /// valid; type-validity is confirmed by the preflight step in the
    /// oracle.
    pub fn to_wat(&self) -> String {
        let mut locals = String::new();
        for _ in 0..self.extra_i32_locals {
            locals.push_str("(local i32) ");
        }

        let mem_grow = if self.has_memory_grow {
            "i32.const 0 memory.grow drop"
        } else {
            ""
        };

        format!(
            r#"(module
  (import "kernel" "kernel_fork" (func $fork (result i32)))
  (tag $exn)
  (func $caller (export "caller") (result i32)
    {locals}
    (block $handler (result (ref null exn))
      (try_table (result (ref null exn)) (catch_ref $exn $handler)
        {mem_grow}
        call $fork
        drop
        ref.null exn))
    drop
    i32.const 0)
  (memory 1))
"#,
            locals = locals,
            mem_grow = mem_grow,
        )
    }

    /// Render to bytes. Returns `None` on unusual wat parse failures
    /// (should be rare; generator is meant to produce valid syntax).
    pub fn to_bytes(&self) -> Option<Vec<u8>> {
        wat::parse_str(&self.to_wat()).ok()
    }
}
