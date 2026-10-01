//! Observability for long local builds: scheduler events as JSON lines,
//! per-node duration history, and the duration estimate built from it.
//!
//! WHY this exists: `./run.sh setup` and `./run.sh local-build` run for tens
//! of minutes. Without a machine-readable progress stream, a waiting agent
//! or person probes processes and tails logs to guess how far along a build
//! is, and without recorded durations nobody can say how long a build will
//! take before starting it. Everything here is advisory: a failure to write
//! or read these files warns and never changes a build's outcome.

use crate::local_build::{NodeRunResultV1, PlanNodeV1, SuccessDispositionV1};
use crate::local_build_executor::SchedulerEventV1;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Environment variable naming the file that receives scheduler events.
pub(crate) const EVENTS_ENV: &str = "KANDELO_LOCAL_BUILD_EVENTS";
/// Cost assumed for a node that must run when no node has any history yet.
pub(crate) const UNKNOWN_NODE_SECONDS: f64 = 60.0;
/// Only the most recent samples count, so a package whose build got faster
/// or slower stops being estimated from its old behavior.
const RECENT_SAMPLES: usize = 10;

pub(crate) fn unix_now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or(0.0)
}

/// Directory under the source cache base that holds timing history. The
/// cache base is shared by every worktree on the machine, so history from one
/// worktree informs estimates in all of them. `cache-gc` only enumerates
/// `roots/`, the compiled kind directories, and its own trash, so it never
/// touches this directory.
pub(crate) fn timings_dir(cache_base: &Path) -> PathBuf {
    cache_base.join("timings")
}

pub(crate) fn node_durations_path(cache_base: &Path) -> PathBuf {
    timings_dir(cache_base).join("node-durations.jsonl")
}

pub(crate) fn runs_path(cache_base: &Path) -> PathBuf {
    timings_dir(cache_base).join("runs.jsonl")
}

/// The JSON-lines name of a scheduler event and the node it concerns.
pub(crate) fn scheduler_event_kind(event: &SchedulerEventV1) -> (&'static str, &PlanNodeV1) {
    match event {
        SchedulerEventV1::Ready { node } => ("ready", node),
        SchedulerEventV1::Running { node } => ("running", node),
        SchedulerEventV1::Terminal { result } => match result {
            NodeRunResultV1::Succeeded { node, disposition } => (
                match disposition {
                    SuccessDispositionV1::Published => "succeeded",
                    SuccessDispositionV1::Cached => "cached",
                    SuccessDispositionV1::RebuiltEquivalent => "reused",
                },
                node,
            ),
            NodeRunResultV1::Failed { node, .. } => ("failed", node),
            NodeRunResultV1::Blocked { node, .. } => ("blocked", node),
        },
    }
}

#[derive(Serialize)]
struct NodeEventLineV1<'a> {
    event: &'a str,
    node: &'a str,
    at: f64,
}

pub(crate) fn node_event_line(event: &str, node: &str, at: f64) -> String {
    serde_json::to_string(&NodeEventLineV1 { event, node, at })
        .expect("serialize a local-build event line")
}

/// Appends one JSON object per line to the file named by
/// `KANDELO_LOCAL_BUILD_EVENTS`, flushing each line so a reader polling the
/// file (for example `scripts/agent-job status`) sees progress as it happens.
/// Inert when the variable is unset; after the first write failure it warns
/// once and stops writing.
pub(crate) struct EventLog {
    sink: Option<(PathBuf, fs::File)>,
}

impl EventLog {
    pub(crate) fn from_env() -> Self {
        let Some(path) = std::env::var_os(EVENTS_ENV).filter(|value| !value.is_empty()) else {
            return Self { sink: None };
        };
        Self::open(PathBuf::from(path))
    }

    fn open(path: PathBuf) -> Self {
        match fs::OpenOptions::new().create(true).append(true).open(&path) {
            Ok(file) => Self {
                sink: Some((path, file)),
            },
            Err(error) => {
                eprintln!(
                    "local-build warning: not writing scheduler events to {} ({EVENTS_ENV}): {error}",
                    path.display()
                );
                Self { sink: None }
            }
        }
    }

    pub(crate) fn write_line(&mut self, line: &str) {
        let Some((path, file)) = &mut self.sink else {
            return;
        };
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        // One write per line: with O_APPEND, concurrent writers never
        // interleave inside a line.
        if let Err(error) = file.write_all(&bytes).and_then(|()| file.flush()) {
            eprintln!(
                "local-build warning: stopped writing scheduler events to {} ({EVENTS_ENV}): {error}",
                path.display()
            );
            self.sink = None;
        }
    }

    pub(crate) fn plan(&mut self, nodes: usize) {
        if self.sink.is_some() {
            self.write_line(&serde_json::json!({"event": "plan", "nodes": nodes, "at": unix_now()}).to_string());
        }
    }

    pub(crate) fn cached_check(&mut self, cached: usize) {
        if self.sink.is_some() {
            self.write_line(
                &serde_json::json!({"event": "cached-check", "cached": cached, "at": unix_now()})
                    .to_string(),
            );
        }
    }

    pub(crate) fn scheduler_event(&mut self, event: &SchedulerEventV1, label: &str) {
        if self.sink.is_some() {
            let (kind, _) = scheduler_event_kind(event);
            self.write_line(&node_event_line(kind, label, unix_now()));
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct NodeDurationRecordV1 {
    pub(crate) node: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cache_key: Option<String>,
    pub(crate) seconds: f64,
    pub(crate) outcome: String,
    pub(crate) at: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct RunRecordV1 {
    pub(crate) predicted_seconds: Option<f64>,
    pub(crate) actual_seconds: f64,
    /// Seconds spent in the scheduler alone; `actual_seconds` minus this is
    /// the run's fixed overhead (dependency install, index generation,
    /// planning, the cached check, and finalization).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) graph_seconds: Option<f64>,
    pub(crate) nodes: usize,
    pub(crate) built: usize,
    pub(crate) cached: usize,
    pub(crate) jobs: usize,
    pub(crate) at: f64,
}

/// Appends one record to a timing history file, creating its directory.
/// Returns the error for the caller to report; callers only warn.
pub(crate) fn append_jsonl<T: Serialize>(path: &Path, record: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let mut line = serde_json::to_vec(record).map_err(|error| format!("serialize: {error}"))?;
    line.push(b'\n');
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(&line))
        .map_err(|error| format!("append {}: {error}", path.display()))
}

/// Records node durations as they finish, warning once on the first failure.
pub(crate) struct DurationRecorder {
    path: Option<PathBuf>,
}

impl DurationRecorder {
    pub(crate) fn new(cache_base: &Path) -> Self {
        Self {
            path: Some(node_durations_path(cache_base)),
        }
    }

    pub(crate) fn record(&mut self, record: &NodeDurationRecordV1) {
        let Some(path) = &self.path else {
            return;
        };
        if let Err(error) = append_jsonl(path, record) {
            eprintln!("local-build warning: stopped recording node durations: {error}");
            self.path = None;
        }
    }
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> Vec<T> {
    // A missing or partly corrupt history only weakens the estimate.
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|left, right| left.total_cmp(right));
    let middle = values.len() / 2;
    Some(if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    })
}

/// Recorded durations, reduced to what the estimator needs.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct TimingHistory {
    /// Median of each node's most recent successful runs, by node label.
    pub(crate) node_medians: BTreeMap<String, f64>,
    /// Median fixed overhead of recent whole runs, when recorded.
    pub(crate) overhead_seconds: Option<f64>,
}

impl TimingHistory {
    pub(crate) fn load(cache_base: &Path) -> Self {
        Self::from_records(
            &read_jsonl::<NodeDurationRecordV1>(&node_durations_path(cache_base)),
            &read_jsonl::<RunRecordV1>(&runs_path(cache_base)),
        )
    }

    pub(crate) fn from_records(nodes: &[NodeDurationRecordV1], runs: &[RunRecordV1]) -> Self {
        let mut samples = BTreeMap::<&str, Vec<f64>>::new();
        for record in nodes {
            // A failure stops early, so its duration says nothing about how
            // long the node takes to build.
            if record.outcome != "failed" && record.seconds.is_finite() && record.seconds >= 0.0 {
                samples.entry(record.node.as_str()).or_default().push(record.seconds);
            }
        }
        let node_medians = samples
            .into_iter()
            .filter_map(|(node, values)| {
                let start = values.len().saturating_sub(RECENT_SAMPLES);
                let mut recent = values[start..].to_vec();
                median(&mut recent).map(|value| (node.to_string(), value))
            })
            .collect();
        let overheads = runs
            .iter()
            .filter_map(|run| {
                run.graph_seconds
                    .map(|graph| (run.actual_seconds - graph).max(0.0))
            })
            .collect::<Vec<_>>();
        let start = overheads.len().saturating_sub(RECENT_SAMPLES);
        let overhead_seconds = median(&mut overheads[start..].to_vec());
        Self {
            node_medians,
            overhead_seconds,
        }
    }

    /// Cost for a node that has no history of its own: the median of the
    /// nodes that do, or [`UNKNOWN_NODE_SECONDS`] when there is no history.
    pub(crate) fn fallback_seconds(&self) -> f64 {
        let mut known = self.node_medians.values().copied().collect::<Vec<_>>();
        median(&mut known).unwrap_or(UNKNOWN_NODE_SECONDS)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct BuildEstimateV1 {
    /// Longest dependency chain, weighting each will-run node by its median.
    pub(crate) critical_path_seconds: f64,
    /// Total will-run work divided by the job count.
    pub(crate) parallel_seconds: f64,
    /// Median recorded time a run spends outside the scheduler.
    pub(crate) overhead_seconds: f64,
    pub(crate) estimate_seconds: f64,
    /// Will-run nodes priced with the fallback because they have no history.
    pub(crate) unknown_nodes: usize,
}

/// Estimate a run's wall time: the graph cannot finish faster than its
/// longest dependency chain, nor faster than its total work spread over
/// `jobs`, so the graph term is the larger of the two. Cached nodes cost 0.
/// The recorded fixed overhead of earlier runs is added on top, because a
/// fully cached run still spends that time.
pub(crate) fn estimate(
    dependencies: &BTreeMap<PlanNodeV1, BTreeSet<PlanNodeV1>>,
    will_run: &BTreeSet<PlanNodeV1>,
    history: &TimingHistory,
    jobs: usize,
    label: impl Fn(&PlanNodeV1) -> String,
) -> BuildEstimateV1 {
    let fallback = history.fallback_seconds();
    let mut unknown_nodes = 0usize;
    let mut cost = BTreeMap::new();
    for node in dependencies.keys() {
        let seconds = if will_run.contains(node) {
            history
                .node_medians
                .get(&label(node))
                .copied()
                .unwrap_or_else(|| {
                    unknown_nodes += 1;
                    fallback
                })
        } else {
            0.0
        };
        cost.insert(node, seconds);
    }
    let mut finish = BTreeMap::<&PlanNodeV1, f64>::new();
    fn finish_time<'a>(
        node: &'a PlanNodeV1,
        dependencies: &'a BTreeMap<PlanNodeV1, BTreeSet<PlanNodeV1>>,
        cost: &BTreeMap<&'a PlanNodeV1, f64>,
        finish: &mut BTreeMap<&'a PlanNodeV1, f64>,
    ) -> f64 {
        if let Some(seconds) = finish.get(node) {
            return *seconds;
        }
        let start = dependencies
            .get(node)
            .into_iter()
            .flatten()
            .filter(|dependency| dependencies.contains_key(*dependency))
            .map(|dependency| finish_time(dependency, dependencies, cost, finish))
            .fold(0.0, f64::max);
        let seconds = start + cost.get(node).copied().unwrap_or(0.0);
        finish.insert(node, seconds);
        seconds
    }
    let critical_path_seconds = dependencies
        .keys()
        .map(|node| finish_time(node, dependencies, &cost, &mut finish))
        .fold(0.0, f64::max);
    let parallel_seconds = cost.values().sum::<f64>() / jobs.max(1) as f64;
    let overhead_seconds = history.overhead_seconds.unwrap_or(0.0);
    BuildEstimateV1 {
        critical_path_seconds,
        parallel_seconds,
        overhead_seconds,
        estimate_seconds: critical_path_seconds.max(parallel_seconds) + overhead_seconds,
        unknown_nodes,
    }
}

pub(crate) fn human_seconds(seconds: f64) -> String {
    let seconds = seconds.max(0.0).round() as u64;
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3600 {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    } else {
        format!("{}h {:02}m", seconds / 3600, (seconds % 3600) / 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(name: &str) -> PlanNodeV1 {
        PlanNodeV1::package(name, "wasm32")
    }

    fn label(node: &PlanNodeV1) -> String {
        match node {
            PlanNodeV1::Package { name, target_arch } => format!("{name}/{target_arch}"),
            PlanNodeV1::Product { id } => format!("product/{id}"),
        }
    }

    fn record(node: &str, seconds: f64, outcome: &str) -> NodeDurationRecordV1 {
        NodeDurationRecordV1 {
            node: node.to_string(),
            cache_key: None,
            seconds,
            outcome: outcome.to_string(),
            at: 0.0,
        }
    }

    #[test]
    fn local_build_event_lines_match_the_agent_job_reader() {
        let line = node_event_line("running", "bash/wasm32", 1_700_000_000.25);
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["event"], "running");
        assert_eq!(value["node"], "bash/wasm32");
        assert_eq!(value["at"], 1_700_000_000.25);
        assert!(!line.contains('\n'));

        let node = package("bash");
        for (disposition, expected) in [
            (SuccessDispositionV1::Published, "succeeded"),
            (SuccessDispositionV1::Cached, "cached"),
            (SuccessDispositionV1::RebuiltEquivalent, "reused"),
        ] {
            let event = SchedulerEventV1::Terminal {
                result: NodeRunResultV1::Succeeded {
                    node: node.clone(),
                    disposition,
                },
            };
            assert_eq!(scheduler_event_kind(&event).0, expected);
        }
        let failed = SchedulerEventV1::Terminal {
            result: NodeRunResultV1::Failed {
                node: node.clone(),
                exit_code: Some(1),
            },
        };
        assert_eq!(scheduler_event_kind(&failed).0, "failed");
        let blocked = SchedulerEventV1::Terminal {
            result: NodeRunResultV1::Blocked {
                node: node.clone(),
                failed_ancestors: vec![package("zlib")],
            },
        };
        assert_eq!(scheduler_event_kind(&blocked).0, "blocked");
        assert_eq!(
            scheduler_event_kind(&SchedulerEventV1::Ready { node: node.clone() }).0,
            "ready"
        );
    }

    #[test]
    fn local_build_event_log_appends_one_flushed_object_per_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        fs::write(&path, "{\"event\":\"earlier\"}\n").unwrap();
        let mut log = EventLog::open(path.clone());
        log.plan(2);
        log.cached_check(1);
        log.scheduler_event(
            &SchedulerEventV1::Running {
                node: package("bash"),
            },
            "bash/wasm32",
        );
        let lines = fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(lines.len(), 4, "appends, never truncates");
        assert_eq!(lines[1]["event"], "plan");
        assert_eq!(lines[1]["nodes"], 2);
        assert_eq!(lines[2]["event"], "cached-check");
        assert_eq!(lines[2]["cached"], 1);
        assert_eq!(lines[3]["event"], "running");
        assert_eq!(lines[3]["node"], "bash/wasm32");
        assert!(lines[3]["at"].as_f64().unwrap() > 0.0);

        // An unwritable path disables the log instead of failing the build.
        let mut unwritable = EventLog::open(dir.path().join("missing/events.jsonl"));
        unwritable.plan(1);
    }

    #[test]
    fn local_build_timing_history_uses_recent_successful_medians() {
        let mut nodes = vec![record("a/wasm32", 500.0, "failed")];
        // Twelve samples: only the last ten (3..=12) count.
        for seconds in 1..=12 {
            nodes.push(record("a/wasm32", f64::from(seconds), "published"));
        }
        nodes.push(record("b/wasm32", 4.0, "reused"));
        let runs = vec![
            RunRecordV1 {
                predicted_seconds: None,
                actual_seconds: 30.0,
                graph_seconds: Some(20.0),
                nodes: 2,
                built: 1,
                cached: 1,
                jobs: 4,
                at: 0.0,
            },
            RunRecordV1 {
                predicted_seconds: None,
                actual_seconds: 50.0,
                graph_seconds: None,
                nodes: 2,
                built: 1,
                cached: 1,
                jobs: 4,
                at: 0.0,
            },
        ];
        let history = TimingHistory::from_records(&nodes, &runs);
        assert_eq!(history.node_medians["a/wasm32"], 7.5);
        assert_eq!(history.node_medians["b/wasm32"], 4.0);
        assert_eq!(history.overhead_seconds, Some(10.0));
        assert_eq!(history.fallback_seconds(), 5.75);
        assert_eq!(TimingHistory::default().fallback_seconds(), UNKNOWN_NODE_SECONDS);
    }

    #[test]
    fn local_build_estimate_takes_the_larger_of_critical_path_and_spread_work() {
        // a -> b -> c chain plus independent d; c is cached.
        let a = package("a");
        let b = package("b");
        let c = package("c");
        let d = package("d");
        let dependencies = BTreeMap::from([
            (a.clone(), BTreeSet::new()),
            (b.clone(), BTreeSet::from([a.clone()])),
            (c.clone(), BTreeSet::from([b.clone()])),
            (d.clone(), BTreeSet::new()),
        ]);
        let history = TimingHistory {
            node_medians: BTreeMap::from([
                ("a/wasm32".to_string(), 10.0),
                ("b/wasm32".to_string(), 20.0),
                ("c/wasm32".to_string(), 1000.0),
            ]),
            overhead_seconds: Some(5.0),
        };
        let will_run = BTreeSet::from([a.clone(), b.clone(), d.clone()]);

        // d has no history: priced at the median of known nodes (20).
        let wide = estimate(&dependencies, &will_run, &history, 8, label);
        assert_eq!(wide.critical_path_seconds, 30.0);
        assert_eq!(wide.parallel_seconds, 50.0 / 8.0);
        assert_eq!(wide.unknown_nodes, 1);
        assert_eq!(wide.estimate_seconds, 35.0);

        let narrow = estimate(&dependencies, &will_run, &history, 1, label);
        assert_eq!(narrow.parallel_seconds, 50.0);
        assert_eq!(narrow.estimate_seconds, 55.0);
    }
}
