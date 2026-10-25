//! Measure the complete post-optimize=none CLI path. Measurements
//! include input snapshot, transform, feature declaration, independent Wasm
//! validation, output snapshot and atomic publication. No input is executed.
use super::{PEAK, physical_peak};
use anyhow::{Result, ensure};
use fork_instrument::{Options, artifact_io::MappedArtifact, native};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::atomic::Ordering};
use wasm_posix_shared::abi;
use wasmparser::{Parser, Payload};

const BYTE_LIMIT: u64 = 8 * 1024 * 1024 * 1024;

pub(super) fn measure(
    input: &Path,
    destination: &Path,
    specialization_cache_bytes: Option<usize>,
) -> Result<()> {
    let (input, permissions) = MappedArtifact::read(input, BYTE_LIMIT)?;
    let options = Options::default();
    let mut limits = native::Limits::default();
    if let Some(bytes) = specialization_cache_bytes {
        limits.analysis.sinks.interpreter.specialization_cache_bytes = Some(bytes);
    }
    let result = native::instrument(input.bytes(), &options, limits)?;
    eprintln!("native analysis: {}", result.decision.source.as_str());
    if let Some(error) = &result.decision.facts_error {
        eprintln!("compiler facts unavailable: {error}");
    }
    let output = result.bytes;
    output.publish(destination, permissions)?;
    let digest = hex(&Sha256::digest(output.bytes()));
    let (participates, contract) = contract_fingerprint(output.bytes())?;
    let data = data_fingerprint(input.bytes())?;
    ensure!(
        data == data_fingerprint(output.bytes())?,
        "instrumentation changed data payloads"
    );
    let heap = PEAK.load(Ordering::Relaxed);
    let physical = physical_peak()?;
    println!(
        "{{\"backend\":\"native\",\"phase\":\"instrument\",\"participates\":{participates},\"input_bytes\":{},\"output_bytes\":{},\"output_sha256\":\"{digest}\",\"contract_sha256\":\"{contract}\",\"data_sha256\":\"{data}\",\"rust_requested_peak_bytes\":{heap},\"physical_lifetime_peak_bytes\":{physical}}}",
        input.bytes().len(),
        output.bytes().len(),
    );
    std::hint::black_box((&input, &output));
    Ok(())
}

fn data_fingerprint(bytes: &[u8]) -> Result<String> {
    let mut digest = Sha256::new();
    for payload in Parser::new(0).parse_all(bytes) {
        if let Payload::DataSection(section) = payload? {
            digest.update(section.count().to_le_bytes());
            for data in section {
                let data = data?;
                digest.update((data.data.len() as u64).to_le_bytes());
                digest.update(data.data);
            }
        }
    }
    Ok(hex(&digest.finalize()))
}

fn contract_fingerprint(bytes: &[u8]) -> Result<(bool, String)> {
    let mut digest = Sha256::new();
    let mut sections = Vec::new();
    for payload in Parser::new(0).parse_all(bytes) {
        if let Payload::CustomSection(section) = payload? {
            if matches!(
                section.name(),
                abi::WPK_FORK_CAPABILITIES_SECTION
                    | abi::WPK_FORK_MODULE_STATE_FORMAT_SECTION
                    | abi::WPK_FORK_UNWIND_TRANSPORT_SECTION
            ) {
                sections.push((section.name(), section.data()));
            }
        }
    }
    sections.sort_by_key(|(name, _)| *name);
    // Real package inventories include programs outside every fork transaction.
    // Keep their no-op path visible while still rejecting partial descriptors.
    ensure!(
        sections.is_empty() || sections.len() == 3,
        "partial fork contract"
    );
    let participates = !sections.is_empty();
    for (name, data) in sections {
        digest.update((name.len() as u64).to_le_bytes());
        digest.update(name.as_bytes());
        digest.update((data.len() as u64).to_le_bytes());
        digest.update(data);
    }
    Ok((participates, hex(&digest.finalize())))
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
