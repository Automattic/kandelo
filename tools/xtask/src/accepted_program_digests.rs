//! Prior program contracts this epoch still admits, and the two independent
//! conditions that let one in.
//!
//! WHY this exists: a program carries **one** 32-byte digest over
//! `ABI_VERSION` plus every `abi_surfaces.program` section
//! ([`crate::local_abi_identity`]), and admission compares it for equality.
//! The strictness is in the stamp, not in the comparison, so a program built
//! one additive field ago is indistinguishable from one built against a
//! contradictory contract: both simply differ. Meanwhile the snapshot
//! classifier in [`crate::dump_abi`] already knows, per section and per
//! entry, whether a change only added. That knowledge used to be discarded
//! before admission ever ran. This module stops discarding it.
//!
//! WHY it is still not enough on its own: a change can be additive in schema
//! and breaking in behavior — a new errno an existing syscall can return, a
//! reserved flag bit gaining meaning, a `repr(C)` struct gaining a field. No
//! classifier can see any of those. So a prior contract joins the accepted
//! set only when **both** hold, never one:
//!
//! 1. [`classifier_finds_only_additions`] — the classifier, run over exactly
//!    the data the digest hashes, reports no breaking change; and
//! 2. [`affirmation_is_recorded`] — a named author has recorded, in prose,
//!    why the addition is behaviorally safe for programs that predate it.
//!
//! WHY this is not a list of digests someone pasted in. Every entry's digest
//! is **recomputed** here from a stored copy of the snapshot that produced
//! it, with the same function that stamps programs: a digest typed in by hand
//! has no snapshot that hashes to it, and a snapshot edited to suit has a
//! digest that no longer matches. The classifier then runs against that same
//! stored snapshot on every build, so an entry that was additive last month
//! and is contradicted by today's surface fails today — the verdict is
//! re-derived, not remembered. `docs/persistent-program-compatibility.md`
//! forbids "accepting arbitrary old digests or giving new requirements the
//! old identity"; nothing here is arbitrary, and a new requirement cannot
//! wear an old identity because the old identity is checked against the old
//! surface.
//!
//! WHY an epoch bump still invalidates everything: a digest binds
//! `ABI_VERSION`, and an `ABI_VERSION` bump is a deliberate declaration that
//! every program must be rebuilt. An entry recorded under a replaced epoch is
//! therefore [`Verdict::Superseded`] — reported, and absent from the accepted
//! set — rather than accepted. This mechanism relaxes digest equality within
//! one epoch; it does not relax the epoch check, which `expectedAbi` in
//! `host/src/constants.ts` applies separately.

use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

use crate::local_abi_identity::{program_contract_digest, program_surface_view};

/// The record of affirmed prior contracts, relative to the repository root.
pub(crate) const RECORD_PATH: &str = "abi/accepted-program-digests.json";

/// Where each entry's stored prior `abi/snapshot.json` lives. The file name is
/// derived from the entry's digest, so the record carries no path to follow.
pub(crate) const SNAPSHOT_DIR: &str = "abi/accepted-program-snapshots";

/// The record is a handful of entries; the snapshots it points at are separate
/// files. A cap keeps a malformed or runaway record from being read at all.
const RECORD_MAX_BYTES: usize = 65536;

/// The fewest characters of prose an affirmation can carry and still be an
/// argument rather than an acknowledgement. The classifier's half of this gate
/// is mechanical; this half exists only because a human looked at behavior the
/// schema cannot show, and "ok" or "additive" is not that.
const AFFIRMATION_MIN_CHARS: usize = 80;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    format: u32,
    accepted: Vec<Entry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    /// The 32-byte program digest, lowercase hex. Checked against the digest
    /// recomputed from the stored snapshot, so it cannot be asserted.
    program_contract_digest: String,
    /// The epoch this contract belonged to. Checked against the stored
    /// snapshot's own `abi_version`; recorded so the record reads without
    /// opening a quarter-megabyte of JSON.
    abi_version: u32,
    /// The Git revision whose `abi/snapshot.json` the stored copy is. This
    /// tool cannot verify a revision offline; the stored *content* is what is
    /// verified, and this names where a reviewer can compare it against
    /// history.
    source_revision: String,
    affirmation: Affirmation,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Affirmation {
    /// The person making the judgement. Not a tool, and not a team.
    author: String,
    /// `YYYY-MM-DD`.
    date: String,
    /// Why the addition is safe for programs that predate it, in prose.
    behavioral_safety: String,
}

/// What the two conditions decided about one recorded prior contract.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// Admitted beside the current digest.
    Accepted { digest: String },
    /// Recorded under an epoch the declared `ABI_VERSION` has replaced. Inert:
    /// an epoch bump means every program is rebuilt, so this contract is not
    /// admitted, and the entry stays recorded for the epoch it belongs to.
    Superseded {
        digest: String,
        recorded_abi_version: u32,
        current_abi_version: u32,
    },
}

impl Verdict {
    fn digest(&self) -> &str {
        match self {
            Verdict::Accepted { digest }
            | Verdict::Superseded { digest, .. } => digest,
        }
    }

    /// Whether this verdict lets something run that digest equality alone
    /// would refuse. Only an accepted contract does; a superseded one is the
    /// strict state.
    pub(crate) fn widens_admission(&self) -> bool {
        matches!(self, Verdict::Accepted { .. })
    }

    /// One line for `xtask check-program-baseline`, so neither outcome is
    /// something a reader has to infer from silence.
    pub(crate) fn describe(&self) -> String {
        match self {
            Verdict::Accepted { digest } => format!(
                "abi: accepted prior program contract {digest} (additive surface, affirmed)"
            ),
            Verdict::Superseded {
                digest,
                recorded_abi_version,
                current_abi_version,
            } => format!(
                "abi: prior program contract {digest} is NOT accepted: recorded under \
                 ABI {recorded_abi_version}, which ABI {current_abi_version} replaced"
            ),
        }
    }
}

/// Condition 1: the classifier, run over exactly the data the digest hashes.
///
/// WHY the program-surface view rather than the whole snapshot: the digest is
/// an equality stamp over the program surface alone, so the only honest place
/// to ask "did this surface change compatibly?" is the same data. Kernel-host
/// sections are *absent* from both sides rather than filtered out of the
/// answer, so no kernel-host change can appear in it — and a section that
/// moved between surfaces appears as a removal, which stays breaking.
///
/// Returns the breaking changes since `prior_surface`; empty means the
/// condition is met. A malformed snapshot is an error rather than a breaking
/// change, so the two never read as the same thing.
fn classifier_finds_only_additions(
    prior_surface: &Value,
    current_surface: &Value,
) -> Result<Vec<String>, String> {
    Ok(crate::dump_abi::classify_compat_change(prior_surface, current_surface)?.breaking)
}

/// Condition 2: a named author's recorded judgement about behavior.
fn affirmation_is_recorded(affirmation: &Affirmation) -> Result<(), String> {
    if affirmation.author.trim().is_empty() {
        return Err("affirmation names no author".to_owned());
    }
    if !is_iso_date(&affirmation.date) {
        return Err(format!(
            "affirmation date {:?} is not YYYY-MM-DD",
            affirmation.date
        ));
    }
    let prose = affirmation.behavioral_safety.trim();
    if prose.chars().count() < AFFIRMATION_MIN_CHARS {
        return Err(format!(
            "affirmation states {} characters of behavioral_safety; at least \
             {AFFIRMATION_MIN_CHARS} are needed to say why programs built \
             before the addition are unaffected",
            prose.chars().count(),
        ));
    }
    Ok(())
}

fn is_iso_date(date: &str) -> bool {
    let bytes = date.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

fn parse_digest(hex: &str) -> Result<[u8; 32], String> {
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(format!(
            "program_contract_digest {hex:?} must be 64 lowercase hex characters"
        ));
    }
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)
            .map_err(|error| format!("program_contract_digest {hex:?}: {error}"))?;
    }
    Ok(out)
}

fn hex_digest(digest: &[u8; 32]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn authorize_entry(
    entry: &Entry,
    prior_snapshot: &Value,
    current_surface: &Value,
    current_abi_version: u32,
) -> Result<Verdict, String> {
    let declared = parse_digest(&entry.program_contract_digest)?;

    // The digest is RE-DERIVED from the stored snapshot, never trusted as
    // written: this is what separates an affirmed prior contract from a hex
    // string someone pasted into a list.
    let recorded_abi_version = prior_snapshot
        .get("abi_version")
        .and_then(Value::as_u64)
        .and_then(|version| u32::try_from(version).ok())
        .ok_or("stored prior snapshot has no unsigned u32 abi_version")?;
    if recorded_abi_version != entry.abi_version {
        return Err(format!(
            "records ABI {}, but its stored snapshot declares ABI {recorded_abi_version}",
            entry.abi_version
        ));
    }
    let derived = program_contract_digest(prior_snapshot, recorded_abi_version)?;
    if derived != declared {
        return Err(format!(
            "does not hash its stored snapshot, which has digest {}; the recorded \
             digest cannot be asserted, only derived",
            hex_digest(&derived),
        ));
    }
    if !is_git_object_name(&entry.source_revision) {
        return Err(format!(
            "source_revision {:?} is not a Git object name",
            entry.source_revision
        ));
    }

    // Condition 2 first, and regardless of epoch: an entry whose affirmation
    // is missing or empty is wrong whether or not it is currently inert.
    affirmation_is_recorded(&entry.affirmation)?;

    let digest = entry.program_contract_digest.clone();
    if recorded_abi_version != current_abi_version {
        return Ok(Verdict::Superseded {
            digest,
            recorded_abi_version,
            current_abi_version,
        });
    }

    // Condition 1.
    let prior_surface = program_surface_view(prior_snapshot)?;
    let breaking = classifier_finds_only_additions(&prior_surface, current_surface)?;
    if !breaking.is_empty() {
        return Err(format!(
            "is no longer an additive predecessor of the current program surface: {}. \
             Remove the entry, so admission accepts only the current contract, or \
             declare a new epoch",
            breaking.join("; "),
        ));
    }
    Ok(Verdict::Accepted { digest })
}

/// Authorize every entry in `record_bytes`, loading each entry's stored prior
/// snapshot through `load_prior` (keyed by the entry's digest).
pub(crate) fn authorize_record(
    record_bytes: &[u8],
    load_prior: &mut dyn FnMut(&str) -> Result<Value, String>,
    current_surface: &Value,
    current_abi_version: u32,
) -> Result<Vec<Verdict>, String> {
    if record_bytes.len() > RECORD_MAX_BYTES {
        return Err(format!(
            "{RECORD_PATH} exceeds {RECORD_MAX_BYTES} bytes"
        ));
    }
    let record: Record = serde_json::from_slice(record_bytes)
        .map_err(|error| format!("invalid {RECORD_PATH}: {error}"))?;
    if record.format != 1 {
        return Err(format!("unsupported {RECORD_PATH} format"));
    }

    let current_digest = program_contract_digest(current_surface, current_abi_version)?;
    let mut verdicts: Vec<Verdict> = Vec::new();
    for entry in &record.accepted {
        let prior = load_prior(&entry.program_contract_digest).map_err(|error| {
            format!(
                "accepted program contract {}: {error}",
                entry.program_contract_digest
            )
        })?;
        let verdict = authorize_entry(entry, &prior, current_surface, current_abi_version)
            .map_err(|error| {
                format!(
                    "accepted program contract {}: {error}",
                    entry.program_contract_digest
                )
            })?;
        if verdict.digest() == hex_digest(&current_digest) {
            return Err(format!(
                "accepted program contract {}: this is the CURRENT contract, which \
                 admission accepts by equality; the record holds prior contracts only",
                verdict.digest(),
            ));
        }
        if verdicts
            .iter()
            .any(|existing| existing.digest() == verdict.digest())
        {
            return Err(format!(
                "accepted program contract {}: recorded more than once",
                verdict.digest(),
            ));
        }
        verdicts.push(verdict);
    }
    Ok(verdicts)
}

fn is_git_object_name(revision: &str) -> bool {
    (7..=40).contains(&revision.len())
        && revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// Authorize the committed record against the source-derived program surface.
///
/// WHY source-derived rather than `abi/snapshot.json`: the generated host
/// constants are rendered from source, and
/// [`crate::supported_program_baseline`] separately refuses a snapshot that
/// does not match the source. Asking the same question of the same side keeps
/// a stale snapshot from authorizing anything.
pub(crate) fn authorize(repo: &Path) -> Result<Vec<Verdict>, String> {
    let current_surface = crate::dump_abi::source_program_surface_view()?;
    let record_path = repo.join(RECORD_PATH);
    let record_bytes = match std::fs::read(&record_path) {
        Ok(bytes) => bytes,
        // No record is the strict default: admission accepts the current
        // contract alone.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("read {}: {error}", record_path.display())),
    };
    let mut load_prior = |digest: &str| -> Result<Value, String> {
        let digest = parse_digest(digest).map(|bytes| hex_digest(&bytes))?;
        let path = repo.join(SNAPSHOT_DIR).join(format!("{digest}.json"));
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("read stored prior snapshot {}: {error}", path.display()))?;
        serde_json::from_slice(&bytes)
            .map_err(|error| format!("parse stored prior snapshot {}: {error}", path.display()))
    };
    authorize_record(
        &record_bytes,
        &mut load_prior,
        &current_surface,
        wasm_posix_shared::ABI_VERSION,
    )
}

/// The digests the host admits beside the current one, lowercase hex, sorted.
pub(crate) fn accepted_digests(repo: &Path) -> Result<Vec<String>, String> {
    let mut accepted: Vec<String> = authorize(repo)?
        .into_iter()
        .filter_map(|verdict| match verdict {
            Verdict::Accepted { digest } => Some(digest),
            Verdict::Superseded { .. } => None,
        })
        .collect();
    accepted.sort();
    Ok(accepted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn record_entry_count(record_bytes: &[u8]) -> Result<usize, String> {
        let record: Record = serde_json::from_slice(record_bytes)
            .map_err(|error| format!("invalid {RECORD_PATH}: {error}"))?;
        Ok(record.accepted.len())
    }

    const PROSE: &str = "Syscall 304 did not exist in the declared contract at ABI 55: the \
         kernel answered 0 and left the caller's buffer untouched, so no program \
         built then could observe anything but that fake success.";

    fn affirmation() -> Value {
        json!({
            "author": "Brandon Payton",
            "date": "2026-11-06",
            "behavioral_safety": PROSE,
        })
    }

    /// A snapshot whose only program section is a syscall table.
    fn snapshot(version: u32, syscalls: Value) -> Value {
        json!({
            "abi_version": version,
            "syscalls": syscalls,
            "kernel_exports": [],
            "abi_surfaces": {"program": ["syscalls"], "kernel_host": ["kernel_exports"]},
        })
    }

    fn digest_of(snapshot: &Value) -> String {
        let version = snapshot["abi_version"].as_u64().unwrap() as u32;
        hex_digest(&program_contract_digest(snapshot, version).unwrap())
    }

    fn record(entries: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({"format": 1, "accepted": entries})).unwrap()
    }

    fn entry(prior: &Value, affirmation: Value) -> Value {
        json!({
            "program_contract_digest": digest_of(prior),
            "abi_version": prior["abi_version"],
            "source_revision": "a1f8442718",
            "affirmation": affirmation,
        })
    }

    /// Authorize `entries` with `priors` available to load by digest.
    fn authorize_with(
        entries: Value,
        priors: &[&Value],
        current: &Value,
    ) -> Result<Vec<Verdict>, String> {
        let priors: BTreeMap<String, Value> = priors
            .iter()
            .map(|prior| (digest_of(prior), (*prior).clone()))
            .collect();
        let mut load = |digest: &str| -> Result<Value, String> {
            priors
                .get(digest)
                .cloned()
                .ok_or_else(|| format!("no stored prior snapshot for {digest}"))
        };
        let version = current["abi_version"].as_u64().unwrap() as u32;
        let surface = program_surface_view(current).unwrap();
        authorize_record(&record(entries), &mut load, &surface, version)
    }

    #[test]
    fn an_additive_only_change_proposes_keeping_the_prior_digest_accepted() {
        let prior = snapshot(55, json!([{"number": 1, "name": "read"}]));
        let current = snapshot(
            55,
            json!([{"number": 1, "name": "read"}, {"number": 304, "name": "syslog"}]),
        );
        let verdicts = authorize_with(json!([entry(&prior, affirmation())]), &[&prior], &current)
            .expect("additive surface growth with an affirmation is accepted");
        assert_eq!(
            verdicts,
            vec![Verdict::Accepted {
                digest: digest_of(&prior)
            }],
        );
    }

    #[test]
    fn a_breaking_change_refuses_the_recorded_prior_contract() {
        let prior = snapshot(55, json!([{"number": 1, "name": "read"}]));
        // The same syscall number now means something else.
        let current = snapshot(55, json!([{"number": 1, "name": "readv"}]));
        let error = authorize_with(json!([entry(&prior, affirmation())]), &[&prior], &current)
            .expect_err("a changed syscall entry must not stay accepted");
        assert!(error.contains("changed syscalls entry"), "{error}");
        assert!(
            error.contains("accepts only the current contract"),
            "the refusal must say what the strict state is: {error}"
        );
    }

    #[test]
    fn extending_the_accepted_set_without_an_affirmation_is_refused() {
        let prior = snapshot(55, json!([{"number": 1, "name": "read"}]));
        let current = snapshot(
            55,
            json!([{"number": 1, "name": "read"}, {"number": 304, "name": "syslog"}]),
        );

        // No affirmation at all.
        let mut bare = entry(&prior, affirmation());
        bare.as_object_mut().unwrap().remove("affirmation");
        let error = authorize_with(json!([bare]), &[&prior], &current)
            .expect_err("an entry with no affirmation must be refused");
        assert!(error.contains("affirmation"), "{error}");

        // An affirmation that acknowledges rather than argues.
        let token = affirmation();
        let mut token = token;
        token["behavioral_safety"] = json!("additive, fine");
        let error = authorize_with(json!([entry(&prior, token)]), &[&prior], &current)
            .expect_err("an affirmation must carry an argument");
        assert!(error.contains("behavioral_safety"), "{error}");

        // An affirmation with no named author.
        let mut anonymous = affirmation();
        anonymous["author"] = json!("  ");
        let error = authorize_with(json!([entry(&prior, anonymous)]), &[&prior], &current)
            .expect_err("an affirmation must name a person");
        assert!(error.contains("no author"), "{error}");
    }

    #[test]
    fn an_affirmation_cannot_authorize_a_breaking_change() {
        let prior = snapshot(55, json!([{"number": 1, "name": "read"}]));
        // A removal: the most emphatic affirmation cannot make it compatible.
        let current = snapshot(55, json!([]));
        let mut emphatic = affirmation();
        emphatic["behavioral_safety"] = json!(format!(
            "{PROSE} I have reviewed every caller and consider this entirely safe."
        ));
        let error = authorize_with(json!([entry(&prior, emphatic)]), &[&prior], &current)
            .expect_err("an affirmation is a second condition, not an override");
        assert!(error.contains("removed syscalls entry"), "{error}");
    }

    #[test]
    fn a_recorded_digest_must_hash_its_stored_snapshot() {
        let prior = snapshot(55, json!([{"number": 1, "name": "read"}]));
        let current = snapshot(
            55,
            json!([{"number": 1, "name": "read"}, {"number": 304, "name": "syslog"}]),
        );
        let pasted = "0".repeat(64);
        let mut forged = entry(&prior, affirmation());
        forged["program_contract_digest"] = json!(pasted.clone());

        // The stored snapshot is found by digest, so a pasted digest names no
        // snapshot at all.
        let error = authorize_with(json!([forged.clone()]), &[&prior], &current)
            .expect_err("a pasted digest has no stored snapshot");
        assert!(error.contains(&pasted), "{error}");

        // And if the pasted digest is made to resolve, the recomputation
        // catches it.
        let priors: BTreeMap<String, Value> =
            [(pasted.clone(), prior.clone())].into_iter().collect();
        let mut load = |digest: &str| -> Result<Value, String> {
            priors
                .get(digest)
                .cloned()
                .ok_or_else(|| format!("no stored prior snapshot for {digest}"))
        };
        let surface = program_surface_view(&current).unwrap();
        let error = authorize_record(&record(json!([forged])), &mut load, &surface, 55)
            .expect_err("a digest that does not hash its snapshot must be refused");
        assert!(error.contains("does not hash its stored snapshot"), "{error}");
        assert!(error.contains(&digest_of(&prior)), "{error}");
    }

    #[test]
    fn an_entry_recorded_under_a_replaced_epoch_is_inert() {
        let prior = snapshot(55, json!([{"number": 1, "name": "read"}]));
        let current = snapshot(
            56,
            json!([{"number": 1, "name": "read"}, {"number": 304, "name": "syslog"}]),
        );
        let verdicts = authorize_with(json!([entry(&prior, affirmation())]), &[&prior], &current)
            .expect("an entry from a replaced epoch is recorded, not an error");
        assert_eq!(
            verdicts,
            vec![Verdict::Superseded {
                digest: digest_of(&prior),
                recorded_abi_version: 55,
                current_abi_version: 56,
            }],
        );
        assert!(verdicts[0].describe().contains("is NOT accepted"));
        assert!(
            !verdicts[0].widens_admission(),
            "a superseded contract admits nothing, so the build gate stays quiet"
        );
    }

    /// An epoch bump is a declaration that every program is rebuilt, so the
    /// bump must win over an affirmation even when the surface only grew.
    #[test]
    fn an_affirmation_cannot_survive_its_epoch() {
        let prior = snapshot(55, json!([{"number": 1, "name": "read"}]));
        let current = snapshot(56, json!([{"number": 1, "name": "read"}]));
        let verdicts = authorize_with(json!([entry(&prior, affirmation())]), &[&prior], &current)
            .unwrap();
        assert!(matches!(verdicts[0], Verdict::Superseded { .. }));
    }

    #[test]
    fn a_stale_affirmation_is_refused_even_while_inert() {
        let prior = snapshot(55, json!([{"number": 1, "name": "read"}]));
        let current = snapshot(56, json!([{"number": 1, "name": "read"}]));
        let mut blank = affirmation();
        blank["behavioral_safety"] = json!("");
        let error = authorize_with(json!([entry(&prior, blank)]), &[&prior], &current)
            .expect_err("a malformed entry is wrong whether or not it is inert");
        assert!(error.contains("behavioral_safety"), "{error}");
    }

    #[test]
    fn the_current_contract_cannot_be_recorded_as_a_prior_one() {
        let current = snapshot(55, json!([{"number": 1, "name": "read"}]));
        let error = authorize_with(json!([entry(&current, affirmation())]), &[&current], &current)
            .expect_err("the current contract is admitted by equality");
        assert!(error.contains("CURRENT contract"), "{error}");
    }

    #[test]
    fn a_digest_recorded_twice_is_refused() {
        let prior = snapshot(55, json!([{"number": 1, "name": "read"}]));
        let current = snapshot(
            55,
            json!([{"number": 1, "name": "read"}, {"number": 304, "name": "syslog"}]),
        );
        let once = entry(&prior, affirmation());
        let error = authorize_with(json!([once.clone(), once]), &[&prior], &current)
            .expect_err("a duplicate entry must be refused");
        assert!(error.contains("more than once"), "{error}");
    }

    #[test]
    fn a_recorded_epoch_must_match_its_stored_snapshot() {
        let prior = snapshot(55, json!([{"number": 1, "name": "read"}]));
        let current = snapshot(
            55,
            json!([{"number": 1, "name": "read"}, {"number": 304, "name": "syslog"}]),
        );
        let mut lying = entry(&prior, affirmation());
        lying["abi_version"] = json!(54);
        let error = authorize_with(json!([lying]), &[&prior], &current)
            .expect_err("the recorded epoch must match the stored snapshot");
        assert!(error.contains("stored snapshot declares ABI 55"), "{error}");
    }

    #[test]
    fn an_unknown_record_field_or_format_is_refused() {
        let prior = snapshot(55, json!([{"number": 1, "name": "read"}]));
        let current = snapshot(55, json!([{"number": 1, "name": "read"}, {"number": 2}]));
        let surface = program_surface_view(&current).unwrap();
        let mut load = |_: &str| Ok(prior.clone());

        let future = serde_json::to_vec(&json!({
            "format": 1,
            "accepted": [],
            "future_required_feature": true,
        }))
        .unwrap();
        assert!(authorize_record(&future, &mut load, &surface, 55).is_err());

        let newer = serde_json::to_vec(&json!({"format": 2, "accepted": []})).unwrap();
        assert!(
            authorize_record(&newer, &mut load, &surface, 55)
                .unwrap_err()
                .contains("unsupported")
        );
    }

    /// The committed record, against the real current program surface. This is
    /// the check every build gate runs.
    #[test]
    fn the_committed_record_authorizes_against_the_current_program_surface() {
        let verdicts = authorize(&crate::repo_root()).unwrap();
        for verdict in &verdicts {
            println!("{}", verdict.describe());
        }
    }

    /// The one recorded contract, against the real stored snapshot and the
    /// real declared epoch: accepted, named, and announced.
    ///
    /// This is the live state rather than a constructed one, so it is also
    /// what pins the record to one entry. Routing syscall 304 moved three
    /// program-surface sections additively within ABI 55; the predecessor
    /// digest below is main's, and it stays admitted beside the current one.
    #[test]
    fn the_recorded_abi_55_contract_is_accepted_under_the_declared_epoch() {
        let repo = crate::repo_root();
        let record_bytes = std::fs::read(repo.join(RECORD_PATH)).unwrap();
        assert_eq!(record_entry_count(&record_bytes).unwrap(), 1);
        assert_eq!(
            wasm_posix_shared::ABI_VERSION,
            55,
            "the recorded entry is admitted within ABI 55; a bump supersedes it \
             and this case should then assert Superseded"
        );
        let verdicts = authorize(&repo).unwrap();
        assert_eq!(
            verdicts,
            vec![Verdict::Accepted {
                digest:
                    "1358eca04a8d33fa5bcc27d1c672af2f6e7aaf466a398ad598d991347b1a4415".to_owned(),
            }],
        );
        assert!(
            verdicts[0].widens_admission(),
            "a live accepted contract is what the build gate announces"
        );
        assert!(
            accepted_digests(&repo).unwrap()
                == vec!["1358eca04a8d33fa5bcc27d1c672af2f6e7aaf466a398ad598d991347b1a4415"],
            "the generated host constant is rendered from exactly this set"
        );
    }
}
