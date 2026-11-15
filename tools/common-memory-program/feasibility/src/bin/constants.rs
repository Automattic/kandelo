use anyhow::{Result, ensure};
use std::fs;
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(args.len() == 3, "usage: constants INPUT FRESH_REPORT");
    ensure!(
        !std::path::Path::new(&args[2]).exists(),
        "fresh report required"
    );
    let report = common_memory_feasibility::analyze_constants(&fs::read(&args[1])?)?;
    fs::write(&args[2], serde_json::to_vec(&report)?)?;
    println!(
        "constantSites={}",
        report["constantSites"].as_array().unwrap().len()
    );
    Ok(())
}
