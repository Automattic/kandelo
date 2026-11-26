//! A read-only experiment. Each input emits one JSON record, including coverage.
use fork_instrument::indirect_call_report::{self, FixedTarget, SlotSource};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn path_record(m: &FixedTarget) -> Value {
    json!({
        "caller": m.caller, "table": m.table, "slot": m.slot, "target": m.target,
        "expected_type": m.expected_type, "target_type": m.target_type,
        "exported_table": m.exported_table,
        "slot_source": match m.source {
            SlotSource::Literal => json!("literal"),
            SlotSource::StoreAndReload => json!("store_and_reload"),
            SlotSource::LastArgument { caller } => json!({"last_argument_from": caller}),
        },
    })
}

pub fn run(args: &[String]) -> Result<(), String> {
    let (show_compatible, paths) = match args {
        [first, rest @ ..] if first == "--show-compatible" => (true, rest),
        paths => (false, paths),
    };
    if paths.is_empty() {
        return Err(
            "usage: xtask wasm-indirect-call-report [--show-compatible] FILE.wasm [FILE.wasm ...]"
                .into(),
        );
    }
    for path in paths {
        let input = std::fs::read(path).map_err(|err| format!("{path}: {err}"))?;
        let report =
            indirect_call_report::analyze(&input).map_err(|err| format!("{path}: {err:#}"))?;
        let resolved_groups: BTreeSet<_> = report
            .compatible
            .iter()
            .chain(&report.fixed_mismatches)
            .map(|target| (target.caller, target.table, target.expected_type))
            .collect();
        let mut record = json!({
            "path": path, "indirect_groups": report.indirect_groups,
            "resolved_groups": resolved_groups.len(),
            "resolved_paths": report.compatible.len() + report.fixed_mismatches.len(),
            "mismatches": report.fixed_mismatches.iter().map(path_record).collect::<Vec<_>>()
        });
        if show_compatible {
            record["compatible"] = report
                .compatible
                .iter()
                .map(path_record)
                .collect::<Vec<_>>()
                .into();
        }
        println!("{record}");
    }
    Ok(())
}
