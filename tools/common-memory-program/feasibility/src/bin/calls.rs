use anyhow::{Result, ensure};
use std::fs;
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(args.len() == 3, "usage: calls INPUT FRESH_REPORT");
    ensure!(
        !std::path::Path::new(&args[2]).exists(),
        "fresh report required"
    );
    let bytes = fs::read(&args[1])?;
    let baseline = common_memory_feasibility::analyze_regions(&bytes)?;
    let strict = common_memory_feasibility::analyze_regions_with_calls(
        &bytes,
        common_memory_feasibility::CallPolicy::GuestMemoryReadOnly,
    )?;
    let opportunity = common_memory_feasibility::analyze_regions_with_calls(
        &bytes,
        common_memory_feasibility::CallPolicy::PublishPatternOpportunity,
    )?;
    let report = serde_json::json!({"baseline":baseline,"readOnlyCalls":strict,"writeAllowingOpportunity":opportunity});
    fs::write(&args[2], serde_json::to_vec(&report)?)?;
    for key in ["baseline", "readOnlyCalls", "writeAllowingOpportunity"] {
        let r = &report[key];
        let regions = r["regions"].as_array().unwrap();
        let thresholds:Vec<_>=[2,4,8,16].into_iter().map(|minimum|{
            let selected:Vec<_>=regions.iter().filter(|r|r["sites"].as_u64().unwrap()>=minimum).collect();
            serde_json::json!({"minimum":minimum,"regions":selected.len(),"staticSites":selected.iter().map(|r|r["sites"].as_u64().unwrap()).sum::<u64>(),"regionsCrossingCalls":selected.iter().filter(|r|r["directCalls"].as_array().is_some_and(|a|!a.is_empty())).count()})
        }).collect();
        println!(
            "{}",
            serde_json::json!({"policy":key,"selectedRegions":r["selectedRegions"],"selectedStaticSites":r["selectedStaticSites"],"effects":r["callEffects"].as_object().map(|e|e.iter().filter(|(k,_)|*k!="functions").map(|(k,v)|(k.clone(),v.clone())).collect::<serde_json::Map<_,_>>()),"thresholds":thresholds})
        );
    }
    Ok(())
}
