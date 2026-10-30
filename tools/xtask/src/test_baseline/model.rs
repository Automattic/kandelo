use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub outcome: String,
    pub reason: String,
    pub attempts: u64,
    pub adverse: u64,
}

impl Observation {
    pub fn new(outcome: &str, reason: &str) -> Self {
        Self {
            outcome: outcome.into(),
            reason: reason.split_whitespace().collect::<Vec<_>>().join(" "),
            attempts: 1,
            adverse: u64::from(!matches!(outcome, "pass" | "skip")),
        }
    }

    pub fn merge(&mut self, next: &Self) {
        self.attempts += next.attempts;
        self.adverse += next.adverse;
        if self.outcome == "intermittent" || self.outcome != next.outcome {
            self.outcome = "intermittent".into();
            self.reason = format!(
                "mixed observed outcomes; {} adverse / {} attempts; latest: {} ({})",
                self.adverse, self.attempts, next.outcome, next.reason
            );
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Parsed {
    pub totals: BTreeMap<String, u64>,
    pub tests: BTreeMap<String, Observation>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    // Exact repository paths, or directory prefixes ending in '/'. Never globs.
    pub exclude: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadSet {
    pub capture_id: String,
    pub suite: String,
    pub host: String,
    pub command: Vec<String>,
    pub method: String,
    pub complete: bool,
    pub trace_sha256: String,
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputSpec {
    pub kernel: String,
    pub sysroots: Vec<String>,
    pub projection: String,
    pub program_index: String,
    #[serde(default)]
    pub extra_artifacts: Vec<String>,
    #[serde(default)]
    pub policy: Policy,
    // Exact selection and relevant environment, in addition to versions.
    pub context: BTreeMap<String, String>,
    #[serde(default)]
    pub read_paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Inputs {
    pub digest: String,
    // A Git object locator for diagnostics; deliberately NOT part of the key.
    pub tree: String,
    pub components: BTreeMap<String, String>,
    pub spec: InputSpec,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    #[serde(default)]
    pub capture_id: Option<String>,
    pub suite: String,
    pub host: String,
    pub main_commit: String,
    pub recorded_at: String,
    pub command: Vec<String>,
    pub versions: BTreeMap<String, String>,
    pub load_samples: Vec<f64>,
    pub load_threshold: f64,
    pub log_sha256: String,
    pub exit_code: Option<i32>,
    pub inputs: Option<Inputs>,
    pub reads: Option<ReadSet>,
    // Never fill missing historical provenance from the present environment.
    pub historical: bool,
    pub full_suite: bool,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Baseline {
    pub schema: u32,
    pub suite: String,
    pub host: String,
    pub evidence: Vec<Evidence>,
    pub totals: BTreeMap<String, u64>,
    pub warnings: Vec<String>,
    // Passing tests are implied. A passing targeted rerun stays here only when
    // it changes a previously observed outcome into an intermittent result.
    pub tests: BTreeMap<String, Observation>,
}

impl Baseline {
    pub fn from_run(evidence: Evidence, parsed: Parsed) -> Self {
        Self {
            schema: 1,
            suite: evidence.suite.clone(),
            host: evidence.host.clone(),
            evidence: vec![evidence],
            totals: parsed.totals,
            warnings: parsed.warnings,
            tests: parsed
                .tests
                .into_iter()
                .filter(|(_, v)| v.outcome != "pass")
                .collect(),
        }
    }

    pub fn append(&mut self, evidence: Evidence, parsed: Parsed) -> Result<(), String> {
        let original = self.evidence.first().ok_or("baseline has no evidence")?;
        if self
            .evidence
            .iter()
            .any(|e| e.capture_id.is_some() && e.capture_id == evidence.capture_id)
        {
            return Err("this rerun evidence was already appended; do not count it twice".into());
        }
        if evidence.historical
            || original.historical
            || evidence.inputs.is_none()
            || evidence.inputs.as_ref().map(|v| &v.digest)
                != original.inputs.as_ref().map(|v| &v.digest)
            || evidence.versions != original.versions
            || evidence.suite != self.suite
            || evidence.host != self.host
        {
            return Err("targeted reruns require the same verified inputs and environment; historical records cannot be extended".into());
        }
        for (id, observation) in parsed.tests {
            if observation.outcome == "skip" {
                continue;
            }
            if let Some(previous) = self.tests.get_mut(&id) {
                previous.merge(&observation);
            } else if observation.outcome != "pass"
                && original.full_suite
                && self.warnings.is_empty()
            {
                // The initial full run implied a pass. Preserve that attempt.
                let mut previous = Observation::new("pass", "initial full run");
                previous.merge(&observation);
                self.tests.insert(id, previous);
            } else if observation.outcome != "pass" {
                // Missing names or partial coverage cannot establish an
                // earlier pass. Count only this actual targeted observation.
                self.tests.insert(id, observation);
            }
        }
        self.warnings.extend(parsed.warnings);
        self.evidence.push(evidence);
        // Initial totals remain the full run's totals, not a sum of reruns.
        Ok(())
    }
}
