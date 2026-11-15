use anyhow::{Result, ensure};
use std::fs;
fn main() -> Result<()> {
    let a: Vec<_> = std::env::args().collect();
    ensure!(a.len() == 3, "usage: regions INPUT REPORT");
    ensure!(
        !std::path::Path::new(&a[2]).exists(),
        "fresh report required"
    );
    let report = common_memory_feasibility::analyze_regions(&fs::read(&a[1])?)?;
    fs::write(&a[2], serde_json::to_vec_pretty(&report)?)?;
    println!(
        "{}",
        serde_json::json!({"selfChecks":report["selfChecks"],"selectedRegions":report["selectedRegions"],"selectedFunctions":report["selectedFunctions"],"selectedStaticSites":report["selectedStaticSites"],"i32MemorySites":report["i32MemorySites"]})
    );
    Ok(())
}
