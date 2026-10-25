//! Repeated constant calls whose memoized effects exceed the smallest budget.

use anyhow::{Context, Result};
use std::{fmt::Write, path::Path};

pub(super) fn generate(destination: &Path) -> Result<()> {
    let mut text = String::from(
        r#"(module
      (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
      (func $work (param i32) (result i32) local.get 0
    "#,
    );
    // Keep the callee inside the ordinary small-function specialization rule,
    // while making a cache miss materially more expensive than a lookup.
    for _ in 0..80 {
        text.push_str("i32.const 1 i32.add\n");
    }
    text.push_str(") (func (export \"root\") (result i32) (local $pid i32)\n");
    for pass in 0..2 {
        // 25,000 distinct keys use about 5.3 MiB. Repeating the same ordered
        // working set exposes FIFO thrashing at 4 MiB, without large modules.
        for argument in 0..25_000 {
            writeln!(text, "i32.const {argument} call $work drop")?;
        }
        if pass == 0 {
            text.push_str("i32.const 0 call $fork local.set $pid\n");
        }
    }
    text.push_str("local.get $pid))");
    let bytes = wat::parse_str(text)?;
    fork_instrument::streaming::scan(&bytes).context("validate cache-pressure input")?;
    std::fs::write(destination, bytes)?;
    Ok(())
}
