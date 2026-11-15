use anyhow::{Result, ensure};
use std::fs;
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(args.len() == 3, "usage: origins INPUT FRESH_REPORT");
    ensure!(
        !std::path::Path::new(&args[2]).exists(),
        "fresh report required"
    );
    let report = common_memory_feasibility::analyze_origins(&fs::read(&args[1])?)?;
    fs::write(&args[2], serde_json::to_vec(&report)?)?;
    println!("{}", report["totals"]);
    Ok(())
}
