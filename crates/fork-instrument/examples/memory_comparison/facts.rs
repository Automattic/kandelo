//! Diagnose compiler-fact relation growth without running sink interpretation.
use anyhow::Result;
use fork_instrument::{
    artifact_io::MappedArtifact,
    facts::storage::{FactsStore, StorageLimits},
    streaming::scan,
};
use std::path::Path;

pub(super) fn inspect(path: &Path, disk_bytes: u64) -> Result<()> {
    let (input, _) = MappedArtifact::read(path, 8 * 1024 * 1024 * 1024)?;
    let scan = scan(input.bytes())?;
    let store = FactsStore::from_scan(
        &scan,
        StorageLimits {
            disk_bytes,
            ..Default::default()
        },
    )?;
    let loaded = store.report()?;
    eprintln!(
        "loaded {} definitions, {} relations, {} database bytes",
        loaded.definitions, loaded.relations, loaded.database_bytes,
    );
    let calls = store.resolve_calls(&scan, Default::default())?;
    let solved = store.report()?;
    println!(
        "{{\"bound\":{},\"database_bytes\":{},\"work_steps\":{}}}",
        calls.bound, solved.database_bytes, solved.estimated_work_steps,
    );
    Ok(())
}
