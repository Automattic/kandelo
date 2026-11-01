use std::io::Read;
use std::path::Path;

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SupportedProgramBaseline {
    format: u32,
    abi_version: u32,
    program_contract_digest: String,
}

fn validate(bytes: &[u8], version: u32, digest: &[u8; 32]) -> Result<(), String> {
    let baseline: SupportedProgramBaseline = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid supported program baseline: {error}"))?;
    if baseline.format != 1 {
        return Err("unsupported program baseline format".to_owned());
    }
    let actual: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    if baseline.abi_version != version || baseline.program_contract_digest != actual {
        return Err(format!(
            "supported program baseline changed: expected ABI {} digest {}, found ABI {version} digest {actual}; preserve existing program layouts and semantics instead of restamping saved executables. See docs/persistent-program-compatibility.md",
            baseline.abi_version, baseline.program_contract_digest,
        ));
    }
    Ok(())
}

/// The version and live surface of the fork instrumentation contract. Unlike
/// the program baseline this record is expected to change: a fork-only change
/// bumps `version` and refuses forking programs built against an earlier one,
/// while ordinary programs and their digest stay valid.
pub(crate) const FORK_CONTRACT: &str = include_str!("../../../abi/fork-contract.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ForkContract {
    format: u32,
    pub(crate) version: u32,
    surface_sha256: String,
}

pub(crate) fn fork_contract() -> Result<ForkContract, String> {
    let contract: ForkContract = serde_json::from_str(FORK_CONTRACT)
        .map_err(|error| format!("invalid fork contract record: {error}"))?;
    if contract.format != 1 || contract.version == 0 {
        return Err("unsupported fork contract record".to_owned());
    }
    Ok(contract)
}

fn require_recorded_fork_surface(contract: &ForkContract, digest: &[u8; 32]) -> Result<(), String> {
    let actual: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    if contract.surface_sha256 != actual {
        return Err(format!(
            "fork instrumentation surface changed: abi/fork-contract.json records {} for version {}, found {actual}; bump its version so forking programs built against the earlier contract are refused with rebuild guidance. See docs/persistent-program-compatibility.md",
            contract.surface_sha256, contract.version,
        ));
    }
    Ok(())
}

pub(crate) fn check(repo: &Path) -> Result<[u8; 32], String> {
    let version = wasm_posix_shared::ABI_VERSION;
    let digest = crate::local_abi_identity::local_abi_contract_digest(repo, version)?;
    require_current_snapshot(&digest, &crate::dump_abi::source_program_contract_digest()?)?;
    let fork = crate::local_abi_identity::local_fork_surface_digest(repo)?;
    require_current_snapshot(&fork, &crate::dump_abi::source_fork_surface_digest()?)?;
    require_recorded_fork_surface(&fork_contract()?, &fork)?;
    let path = repo.join("abi/supported-program-baseline.json");
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .and_then(|file| file.take(4097).read_to_end(&mut bytes))
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    if bytes.len() > 4096 {
        return Err("supported program baseline exceeds 4096 bytes".to_owned());
    }
    validate(&bytes, version, &digest)?;
    Ok(digest)
}

fn require_current_snapshot(snapshot: &[u8; 32], source: &[u8; 32]) -> Result<(), String> {
    if snapshot != source {
        return Err("supported program admission refused: ABI snapshot does not match the current source-derived program surface; regenerate and review the ABI contract before building or stamping programs".to_owned());
    }
    Ok(())
}

pub(crate) fn run(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("usage: xtask check-program-baseline".to_owned());
    }
    check(&crate::repo_root())?;
    println!("abi: supported program baseline is unchanged");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{check, fork_contract, require_current_snapshot, require_recorded_fork_surface, validate};
    use serde_json::json;

    fn baseline(version: u32, digest: &[u8; 32]) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "format": 1,
            "abi_version": version,
            "program_contract_digest": digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
        })).unwrap()
    }

    #[test]
    fn a_changed_fork_surface_requires_a_new_contract_record() {
        let contract = fork_contract().unwrap();
        let error = require_recorded_fork_surface(&contract, &[0; 32]).err().unwrap();
        assert!(error.contains("bump its version"), "{error}");
    }

    #[test]
    fn fork_contract_above_one_requires_the_instrumenter_to_stamp_programs() {
        assert_eq!(
            fork_contract().unwrap().version, 1,
            "Programs without a kandelo.wpk_fork.contract section are contract 1. \
             wasm-fork-instrument must stamp that section before this version rises: \
             without it every forking program is refused. Follow \
             'Before raising the fork contract to version 2' in \
             docs/persistent-program-compatibility.md, and do not just edit this value."
        );
    }

    #[test]
    fn accepts_only_the_declared_baseline() {
        let digest = [0x31; 32];
        let bytes = baseline(55, &digest);
        assert!(validate(&bytes, 55, &digest).is_ok());
        assert!(
            validate(&bytes, 56, &digest)
                .unwrap_err()
                .contains("baseline changed")
        );
        assert!(
            validate(&bytes, 55, &[0x32; 32])
                .unwrap_err()
                .contains("baseline changed")
        );
    }

    #[test]
    fn refuses_unknown_or_malformed_contracts() {
        let digest = [0x31; 32];
        let valid: serde_json::Value = serde_json::from_slice(&baseline(55, &digest)).unwrap();
        for (key, value) in [
            ("format", json!(2)),
            ("abi_version", json!(-1)),
            ("program_contract_digest", json!("31")),
            ("program_contract_digest", json!("G".repeat(64))),
            ("future_required_feature", json!(true)),
        ] {
            let mut invalid = valid.clone();
            invalid[key] = value;
            assert!(validate(&serde_json::to_vec(&invalid).unwrap(), 55, &digest).is_err());
        }
    }

    #[test]
    fn committed_baseline_matches_the_actual_program_surface() {
        check(&crate::repo_root()).unwrap();
    }

    #[test]
    fn stale_snapshot_cannot_authorize_a_changed_program_surface() {
        assert!(require_current_snapshot(&[0x31; 32], &[0x31; 32]).is_ok());
        assert!(
            require_current_snapshot(&[0x31; 32], &[0x32; 32])
                .unwrap_err()
                .contains("current source-derived")
        );
    }
}
