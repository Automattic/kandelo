//! Typed WAT generator for fork-instrument fuzzing.
//!
//! Deterministically emits a WAT program from an `Arbitrary` input.
//! Every generator output is a syntactically well-formed module that
//! imports `kernel.kernel_fork` so the instrumenter has work to do.
//!
//! Covers: single or nested try_tables, all four catch-clause shapes,
//! and 0..=4 scalar locals of varying numeric type. Nested shape wraps
//! an inner try_table in an outer try_table of the *same* clause
//! variant to keep block result types trivially lined up.

use arbitrary::{Arbitrary, Unstructured};

/// Which catch-clause shape the generated try_table uses. Covers all
/// four `try_table` catch variants so the instrumenter's rewrite of
/// `call $fork` inside an exception-handled region is exercised across
/// ref-returning and non-ref clauses.
#[derive(Debug, Clone, Copy, arbitrary::Arbitrary)]
enum ClauseVariant {
    /// (catch_ref $exn $handler) — handler receives exnref; try_table result is exnref.
    CatchRef,
    /// (catch_all_ref $handler) — handler receives exnref; try_table result is exnref.
    CatchAllRef,
    /// (catch $exn $handler) — handler receives nothing (tag has no params); try_table empty result.
    Catch,
    /// (catch_all $handler) — handler receives nothing; try_table empty result.
    CatchAll,
}

impl ClauseVariant {
    /// Returns (clause WAT, block result type, body-yield instr, after-block cleanup).
    fn render_parts(
        &self,
        tag: &str,
        label: &str,
    ) -> (String, &'static str, &'static str, &'static str) {
        match self {
            ClauseVariant::CatchRef => (
                format!("(catch_ref {tag} {label})"),
                "(result (ref null exn))",
                "ref.null exn",
                "drop",
            ),
            ClauseVariant::CatchAllRef => (
                format!("(catch_all_ref {label})"),
                "(result (ref null exn))",
                "ref.null exn",
                "drop",
            ),
            ClauseVariant::Catch => (format!("(catch {tag} {label})"), "", "", ""),
            ClauseVariant::CatchAll => (format!("(catch_all {label})"), "", "", ""),
        }
    }
}

/// Scalar numeric type used for a generated local declaration.
#[derive(Debug, Clone, Copy, arbitrary::Arbitrary)]
enum ScalarLocalTy {
    I32,
    I64,
    F32,
    F64,
}

impl ScalarLocalTy {
    fn as_wat(&self) -> &'static str {
        match self {
            ScalarLocalTy::I32 => "i32",
            ScalarLocalTy::I64 => "i64",
            ScalarLocalTy::F32 => "f32",
            ScalarLocalTy::F64 => "f64",
        }
    }
}

/// One generated program. Keep fields private so future generator
/// extensions don't require downstream changes.
#[derive(Debug)]
pub struct WatProgram {
    /// 0..=4 scalar locals on the fork-path function. Exercises
    /// Phase 4d frame save/restore across varying local counts and
    /// types.
    scalar_locals: Vec<ScalarLocalTy>,
    /// Prepend a memory.grow to the fork-path body. Exercises Phase
    /// 4g's gating of memory-mutation ops.
    has_memory_grow: bool,
    /// Catch clause used on the (inner) try_table.
    clause_variant: ClauseVariant,
    /// When true, wrap the inner try_table in an outer try_table of
    /// the *same* ClauseVariant family. Exercises Phase 6a-e region-id
    /// assignment and handler dispatch across multiple regions. Same
    /// variant ensures the block result types line up trivially —
    /// mixed families are not generated here.
    wrap_in_outer: bool,
}

impl<'a> Arbitrary<'a> for WatProgram {
    fn arbitrary(u: &mut Unstructured<'a>) -> arbitrary::Result<Self> {
        let count = (u8::arbitrary(u)? & 0b111).min(4); // 0..=4
        let mut scalar_locals = Vec::with_capacity(count as usize);
        for _ in 0..count {
            scalar_locals.push(ScalarLocalTy::arbitrary(u)?);
        }
        Ok(Self {
            scalar_locals,
            has_memory_grow: bool::arbitrary(u)?,
            clause_variant: ClauseVariant::arbitrary(u)?,
            wrap_in_outer: bool::arbitrary(u)?,
        })
    }
}

impl WatProgram {
    /// Render this program as WAT source text. Always syntactically
    /// valid; type-validity is confirmed by the preflight step in the
    /// oracle.
    pub fn to_wat(&self) -> String {
        let locals_wat: String = self
            .scalar_locals
            .iter()
            .map(|ty| format!("(local {}) ", ty.as_wat()))
            .collect();

        let mem_grow = if self.has_memory_grow {
            "i32.const 0 memory.grow drop"
        } else {
            ""
        };

        let (clause_wat_inner, block_ty, body_yield, after_block) =
            self.clause_variant.render_parts("$exn", "$handler");

        let inner = format!(
            r#"(block $handler {block_ty}
      (try_table {block_ty} {clause_wat_inner}
        {mem_grow}
        call $fork
        drop
        {body_yield}))"#,
        );

        let body = if self.wrap_in_outer {
            let (clause_wat_outer, _, _, _) =
                self.clause_variant.render_parts("$exn", "$outer_handler");
            format!(
                r#"(block $outer_handler {block_ty}
      (try_table {block_ty} {clause_wat_outer}
        {inner}
        {after_block}
        {body_yield}))
    {after_block}"#,
            )
        } else {
            format!("{inner}\n    {after_block}")
        };

        format!(
            r#"(module
  (import "kernel" "kernel_fork" (func $fork (result i32)))
  (tag $exn)
  (func $caller (export "caller") (result i32)
    {locals_wat}
    {body}
    i32.const 0)
  (memory 1))
"#,
        )
    }

    /// Render to bytes. Returns `None` on unusual wat parse failures
    /// (should be rare; generator is meant to produce valid syntax).
    pub fn to_bytes(&self) -> Option<Vec<u8>> {
        wat::parse_str(&self.to_wat()).ok()
    }
}
