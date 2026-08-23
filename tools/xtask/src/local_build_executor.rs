use crate::build_deps::PackageNodeReceiptV1;
use crate::local_build::{
    NodeExecutionResultV1, NodeRunResultV1, PlanNodeV1, SuccessDispositionV1,
};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::mpsc;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum NodeCompletionOutcomeV1 {
    Succeeded(SuccessDispositionV1),
    Failed { exit_code: Option<i32> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NodeCompletionV1 {
    node: PlanNodeV1,
    outcome: NodeCompletionOutcomeV1,
}

struct NodeCompletionMessageV1 {
    completion: NodeCompletionV1,
    // The coordinator holds this only while dispatching newly-ready work. While
    // it waits, channel liveness therefore matches the running workers.
    continuation: mpsc::Sender<NodeCompletionMessageV1>,
}

pub(crate) struct NodeCompletionSenderV1 {
    inner: mpsc::Sender<NodeCompletionMessageV1>,
}

impl NodeCompletionSenderV1 {
    pub(crate) fn send(
        self,
        completion: NodeCompletionV1,
    ) -> Result<(), mpsc::SendError<NodeCompletionV1>> {
        self.inner
            .send(NodeCompletionMessageV1 {
                completion,
                continuation: self.inner.clone(),
            })
            .map_err(|error| mpsc::SendError(error.0.completion))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ValidatedChildResultV1 {
    pub(crate) completion: NodeCompletionV1,
    pub(crate) package_receipt: Option<PackageNodeReceiptV1>,
}

impl NodeCompletionV1 {
    pub(crate) fn succeeded(node: PlanNodeV1, disposition: SuccessDispositionV1) -> Self {
        Self {
            node,
            outcome: NodeCompletionOutcomeV1::Succeeded(disposition),
        }
    }

    pub(crate) fn failed(node: PlanNodeV1, exit_code: Option<i32>) -> Self {
        Self {
            node,
            outcome: NodeCompletionOutcomeV1::Failed { exit_code },
        }
    }
}

pub(crate) fn validate_child_result(
    expected_node: &PlanNodeV1,
    package_receipt_required: bool,
    exit_code: Option<i32>,
    bytes: &[u8],
) -> Result<ValidatedChildResultV1, String> {
    let envelope: NodeExecutionResultV1 = serde_json::from_slice(bytes)
        .map_err(|error| format!("parse local-build child result: {error}"))?;
    if envelope.schema != 1 {
        return Err(format!(
            "local-build child result schema must be 1, got {}",
            envelope.schema
        ));
    }
    if envelope.policy != "source-only-v1" {
        return Err(format!(
            "local-build child result policy must be source-only-v1, got {:?}",
            envelope.policy
        ));
    }
    match envelope.result {
        NodeRunResultV1::Succeeded { node, disposition } => {
            if &node != expected_node {
                return Err(format!(
                    "local-build child result node mismatch: expected {expected_node:?}, got {node:?}"
                ));
            }
            if exit_code != Some(0) {
                return Err(format!(
                    "local-build child reported success with process exit {exit_code:?}"
                ));
            }
            if package_receipt_required != envelope.package_receipt.is_some() {
                return Err(if package_receipt_required {
                    "successful compiled package child omitted packageReceipt".to_string()
                } else {
                    "child result included forbidden packageReceipt".to_string()
                });
            }
            Ok(ValidatedChildResultV1 {
                completion: NodeCompletionV1::succeeded(node, disposition),
                package_receipt: envelope.package_receipt,
            })
        }
        NodeRunResultV1::Failed {
            node,
            exit_code: reported_exit,
        } => {
            if &node != expected_node {
                return Err(format!(
                    "local-build child result node mismatch: expected {expected_node:?}, got {node:?}"
                ));
            }
            if envelope.package_receipt.is_some() {
                return Err("failed child result included forbidden packageReceipt".to_string());
            }
            if exit_code.is_none() || exit_code == Some(0) || reported_exit != exit_code {
                return Err(format!(
                    "local-build child failure/exit mismatch: result {reported_exit:?}, process {exit_code:?}"
                ));
            }
            Ok(ValidatedChildResultV1 {
                completion: NodeCompletionV1::failed(node, reported_exit),
                package_receipt: None,
            })
        }
        NodeRunResultV1::Blocked { .. } => {
            Err("local-build child may not report aggregate-only blocked state".to_string())
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SchedulerEventV1 {
    Ready { node: PlanNodeV1 },
    Running { node: PlanNodeV1 },
    Terminal { result: NodeRunResultV1 },
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum NodeStateV1 {
    Pending,
    Ready,
    Running,
    Succeeded(SuccessDispositionV1),
    Failed(Option<i32>),
    Blocked(BTreeSet<PlanNodeV1>),
}

pub(crate) fn execute_graph<F>(
    dependencies: &BTreeMap<PlanNodeV1, BTreeSet<PlanNodeV1>>,
    jobs: usize,
    launch: F,
) -> Result<Vec<NodeRunResultV1>, String>
where
    F: FnMut(PlanNodeV1, NodeCompletionSenderV1) -> Result<(), String>,
{
    execute_graph_with_events(dependencies, jobs, launch, |_| {})
}

pub(crate) fn execute_graph_with_events<F, E>(
    dependencies: &BTreeMap<PlanNodeV1, BTreeSet<PlanNodeV1>>,
    jobs: usize,
    mut launch: F,
    mut event: E,
) -> Result<Vec<NodeRunResultV1>, String>
where
    F: FnMut(PlanNodeV1, NodeCompletionSenderV1) -> Result<(), String>,
    E: FnMut(SchedulerEventV1),
{
    if jobs == 0 {
        return Err("local-build scheduler jobs must be greater than zero".to_string());
    }

    let mut reverse_edges = dependencies
        .keys()
        .cloned()
        .map(|node| (node, BTreeSet::new()))
        .collect::<BTreeMap<_, _>>();
    for (dependent, required) in dependencies {
        for dependency in required {
            let dependents = reverse_edges.get_mut(dependency).ok_or_else(|| {
                format!(
                    "local-build graph node {dependent:?} references missing prerequisite {dependency:?}"
                )
            })?;
            dependents.insert(dependent.clone());
        }
    }

    let mut unresolved = dependencies
        .iter()
        .map(|(node, required)| (node.clone(), required.len()))
        .collect::<BTreeMap<_, _>>();
    let mut states = dependencies
        .keys()
        .cloned()
        .map(|node| (node, NodeStateV1::Pending))
        .collect::<BTreeMap<_, _>>();
    let mut ready = BTreeSet::new();
    for (node, count) in &unresolved {
        if *count == 0 {
            states.insert(node.clone(), NodeStateV1::Ready);
            ready.insert(node.clone());
            event(SchedulerEventV1::Ready { node: node.clone() });
        }
    }

    let (completion_tx, completion_rx) = mpsc::channel();
    let mut continuation_tx = Some(completion_tx);
    let mut running = 0usize;
    loop {
        while running < jobs {
            let Some(node) = ready.pop_first() else {
                break;
            };
            if states.get(&node) != Some(&NodeStateV1::Ready) {
                return Err(format!(
                    "local-build scheduler ready queue contains non-ready node {node:?}"
                ));
            }
            states.insert(node.clone(), NodeStateV1::Running);
            event(SchedulerEventV1::Running { node: node.clone() });
            let completions = NodeCompletionSenderV1 {
                inner: continuation_tx
                    .as_ref()
                    .ok_or_else(|| {
                        "local-build scheduler lost its completion sender before launch".to_string()
                    })?
                    .clone(),
            };
            match launch(node.clone(), completions) {
                Ok(()) => running += 1,
                Err(_error) => {
                    mark_failed(
                        &node,
                        None,
                        &reverse_edges,
                        &mut states,
                        &mut ready,
                        &mut event,
                    )?;
                }
            }
        }

        if running == 0 {
            if ready.is_empty() {
                break;
            }
            continue;
        }

        drop(continuation_tx.take());
        let message = completion_rx.recv().map_err(|error| {
            format!("local-build completion channel closed with running nodes: {error}")
        })?;
        continuation_tx = Some(message.continuation);
        let completion = message.completion;
        if states.get(&completion.node) != Some(&NodeStateV1::Running) {
            return Err(format!(
                "local-build launcher completed a node that is not running: {:?}",
                completion.node
            ));
        }
        running -= 1;
        match completion.outcome {
            NodeCompletionOutcomeV1::Succeeded(disposition) => {
                states.insert(completion.node.clone(), NodeStateV1::Succeeded(disposition));
                event(SchedulerEventV1::Terminal {
                    result: NodeRunResultV1::Succeeded {
                        node: completion.node.clone(),
                        disposition,
                    },
                });
                for dependent in &reverse_edges[&completion.node] {
                    if states.get(dependent) != Some(&NodeStateV1::Pending) {
                        continue;
                    }
                    let remaining = unresolved.get_mut(dependent).ok_or_else(|| {
                        format!("local-build scheduler omitted dependency count for {dependent:?}")
                    })?;
                    *remaining = remaining.checked_sub(1).ok_or_else(|| {
                        format!("local-build scheduler over-released dependent {dependent:?}")
                    })?;
                    if *remaining == 0 {
                        states.insert(dependent.clone(), NodeStateV1::Ready);
                        ready.insert(dependent.clone());
                        event(SchedulerEventV1::Ready {
                            node: dependent.clone(),
                        });
                    }
                }
            }
            NodeCompletionOutcomeV1::Failed { exit_code } => {
                mark_failed(
                    &completion.node,
                    exit_code,
                    &reverse_edges,
                    &mut states,
                    &mut ready,
                    &mut event,
                )?;
            }
        }
    }

    let pending = states
        .iter()
        .filter_map(|(node, state)| {
            matches!(
                state,
                NodeStateV1::Pending | NodeStateV1::Ready | NodeStateV1::Running
            )
            .then_some(node.clone())
        })
        .collect::<Vec<_>>();
    if !pending.is_empty() {
        return Err(format!(
            "local-build graph did not drain; cycle or missing completion among {pending:?}"
        ));
    }

    states
        .into_iter()
        .map(|(node, state)| match state {
            NodeStateV1::Succeeded(disposition) => {
                Ok(NodeRunResultV1::Succeeded { node, disposition })
            }
            NodeStateV1::Failed(exit_code) => Ok(NodeRunResultV1::Failed { node, exit_code }),
            NodeStateV1::Blocked(failed_ancestors) => Ok(NodeRunResultV1::Blocked {
                node,
                failed_ancestors: failed_ancestors.into_iter().collect(),
            }),
            NodeStateV1::Pending | NodeStateV1::Ready | NodeStateV1::Running => {
                Err("local-build scheduler returned a nonterminal node".to_string())
            }
        })
        .collect()
}

fn mark_failed<E>(
    failed: &PlanNodeV1,
    exit_code: Option<i32>,
    reverse_edges: &BTreeMap<PlanNodeV1, BTreeSet<PlanNodeV1>>,
    states: &mut BTreeMap<PlanNodeV1, NodeStateV1>,
    ready: &mut BTreeSet<PlanNodeV1>,
    event: &mut E,
) -> Result<(), String>
where
    E: FnMut(SchedulerEventV1),
{
    if states.get(failed) != Some(&NodeStateV1::Running) {
        return Err(format!(
            "local-build scheduler cannot fail non-running node {failed:?}"
        ));
    }
    states.insert(failed.clone(), NodeStateV1::Failed(exit_code));
    event(SchedulerEventV1::Terminal {
        result: NodeRunResultV1::Failed {
            node: failed.clone(),
            exit_code,
        },
    });

    let mut pending = reverse_edges[failed].iter().cloned().collect::<Vec<_>>();
    let mut visited = BTreeSet::new();
    while let Some(node) = pending.pop() {
        if !visited.insert(node.clone()) {
            continue;
        }
        match states.get_mut(&node) {
            Some(state @ (NodeStateV1::Pending | NodeStateV1::Ready)) => {
                ready.remove(&node);
                *state = NodeStateV1::Blocked(BTreeSet::from([failed.clone()]));
                event(SchedulerEventV1::Terminal {
                    result: NodeRunResultV1::Blocked {
                        node: node.clone(),
                        failed_ancestors: vec![failed.clone()],
                    },
                });
            }
            Some(NodeStateV1::Blocked(failed_ancestors)) => {
                failed_ancestors.insert(failed.clone());
            }
            Some(NodeStateV1::Running) => {
                return Err(format!(
                    "local-build scheduler found running descendant {node:?} of failed node {failed:?}"
                ));
            }
            Some(NodeStateV1::Succeeded(_) | NodeStateV1::Failed(_)) => {}
            None => {
                return Err(format!(
                    "local-build scheduler omitted descendant state for {node:?}"
                ));
            }
        }
        pending.extend(reverse_edges[&node].iter().cloned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    fn package(name: &str) -> PlanNodeV1 {
        PlanNodeV1::package(name, "wasm32")
    }

    #[test]
    fn local_rebuild_scheduler_releases_a_dependent_before_an_unrelated_peer_finishes() {
        let a = package("a");
        let b = package("b");
        let c = package("c");
        let graph = BTreeMap::from([
            (a.clone(), BTreeSet::new()),
            (b.clone(), BTreeSet::new()),
            (c.clone(), BTreeSet::from([a.clone()])),
        ]);
        let gate = Arc::new((Mutex::new(false), Condvar::new()));

        let results = execute_graph(&graph, 2, {
            let gate = Arc::clone(&gate);
            let b = b.clone();
            let c = c.clone();
            move |node, completions| {
                let gate = Arc::clone(&gate);
                let b = b.clone();
                let c = c.clone();
                std::thread::spawn(move || {
                    if node == b {
                        let (lock, ready) = &*gate;
                        let released = ready
                            .wait_timeout_while(
                                lock.lock().unwrap(),
                                Duration::from_secs(2),
                                |released| !*released,
                            )
                            .unwrap();
                        if !*released.0 {
                            completions
                                .send(NodeCompletionV1::failed(node, Some(91)))
                                .unwrap();
                            return;
                        }
                    } else if node == c {
                        let (lock, ready) = &*gate;
                        *lock.lock().unwrap() = true;
                        ready.notify_all();
                    }
                    completions
                        .send(NodeCompletionV1::succeeded(
                            node,
                            SuccessDispositionV1::Published,
                        ))
                        .unwrap();
                });
                Ok(())
            }
        })
        .unwrap();

        assert!(
            results
                .iter()
                .all(|result| matches!(result, NodeRunResultV1::Succeeded { .. }))
        );
    }

    #[test]
    fn local_rebuild_scheduler_blocks_only_descendants_and_unions_failed_ancestors() {
        let fail_one = package("fail-one");
        let fail_two = package("fail-two");
        let blocked = package("blocked-join");
        let ok_root = package("ok-root");
        let ok_child = package("ok-child");
        let graph = BTreeMap::from([
            (fail_one.clone(), BTreeSet::new()),
            (fail_two.clone(), BTreeSet::new()),
            (
                blocked.clone(),
                BTreeSet::from([fail_one.clone(), fail_two.clone()]),
            ),
            (ok_root.clone(), BTreeSet::new()),
            (ok_child.clone(), BTreeSet::from([ok_root.clone()])),
        ]);
        let dispatched = Arc::new(Mutex::new(Vec::new()));
        let results = execute_graph(&graph, 3, {
            let dispatched = Arc::clone(&dispatched);
            let fail_one_for_launch = fail_one.clone();
            let fail_two_for_launch = fail_two.clone();
            move |node, completions| {
                dispatched.lock().unwrap().push(node.clone());
                let completion = if node == fail_one_for_launch || node == fail_two_for_launch {
                    NodeCompletionV1::failed(node, Some(1))
                } else {
                    NodeCompletionV1::succeeded(node, SuccessDispositionV1::Published)
                };
                completions.send(completion).unwrap();
                Ok(())
            }
        })
        .unwrap();

        assert!(!dispatched.lock().unwrap().contains(&blocked));
        assert!(dispatched.lock().unwrap().contains(&ok_child));
        assert!(results.contains(&NodeRunResultV1::Blocked {
            node: blocked,
            failed_ancestors: vec![fail_one, fail_two],
        }));
        assert!(results.contains(&NodeRunResultV1::Succeeded {
            node: ok_child,
            disposition: SuccessDispositionV1::Published,
        }));
    }

    #[test]
    fn local_rebuild_scheduler_dispatches_a_join_once_and_never_revives_blocked_work() {
        let fail_root = package("fail-root");
        let late_ok = package("late-ok");
        let never_run = package("never-run");
        let left = package("left");
        let right = package("right");
        let join = package("join");
        let graph = BTreeMap::from([
            (fail_root.clone(), BTreeSet::new()),
            (late_ok.clone(), BTreeSet::new()),
            (
                never_run.clone(),
                BTreeSet::from([fail_root.clone(), late_ok.clone()]),
            ),
            (left.clone(), BTreeSet::new()),
            (right.clone(), BTreeSet::new()),
            (join.clone(), BTreeSet::from([left, right])),
        ]);
        let counts = Arc::new(Mutex::new(BTreeMap::<PlanNodeV1, usize>::new()));
        let results = execute_graph(&graph, 4, {
            let counts = Arc::clone(&counts);
            let fail_root = fail_root.clone();
            move |node, completions| {
                *counts.lock().unwrap().entry(node.clone()).or_default() += 1;
                let completion = if node == fail_root {
                    NodeCompletionV1::failed(node, Some(1))
                } else {
                    NodeCompletionV1::succeeded(node, SuccessDispositionV1::Published)
                };
                completions.send(completion).unwrap();
                Ok(())
            }
        })
        .unwrap();

        assert_eq!(counts.lock().unwrap().get(&join), Some(&1));
        assert!(!counts.lock().unwrap().contains_key(&never_run));
        assert!(results.contains(&NodeRunResultV1::Blocked {
            node: never_run,
            failed_ancestors: vec![fail_root],
        }));
    }

    #[test]
    fn local_rebuild_scheduler_reaches_but_never_exceeds_the_job_bound() {
        #[derive(Default)]
        struct InFlight {
            current: usize,
            high_water: usize,
            release: bool,
        }

        let graph = (0..5)
            .map(|index| (package(&format!("root-{index}")), BTreeSet::new()))
            .collect::<BTreeMap<_, _>>();
        let in_flight = Arc::new((Mutex::new(InFlight::default()), Condvar::new()));
        let results = execute_graph(&graph, 2, {
            let in_flight = Arc::clone(&in_flight);
            move |node, completions| {
                let (state, changed) = &*in_flight;
                {
                    let mut state = state.lock().unwrap();
                    state.current += 1;
                    state.high_water = state.high_water.max(state.current);
                    if state.current == 2 {
                        state.release = true;
                        changed.notify_all();
                    }
                }
                let in_flight = Arc::clone(&in_flight);
                std::thread::spawn(move || {
                    let (state, changed) = &*in_flight;
                    let mut state = changed
                        .wait_while(state.lock().unwrap(), |state| !state.release)
                        .unwrap();
                    state.current -= 1;
                    drop(state);
                    completions
                        .send(NodeCompletionV1::succeeded(
                            node,
                            SuccessDispositionV1::Published,
                        ))
                        .unwrap();
                });
                Ok(())
            }
        })
        .unwrap();

        assert_eq!(results.len(), 5);
        assert_eq!(in_flight.0.lock().unwrap().high_water, 2);
    }

    #[test]
    fn local_rebuild_scheduler_reports_a_worker_that_drops_its_completion_sender() {
        let graph = BTreeMap::from([(package("lost-worker"), BTreeSet::new())]);
        let (result_tx, result_rx) = mpsc::channel();

        std::thread::spawn(move || {
            let result = execute_graph(&graph, 1, |_node, _completions| Ok(()));
            result_tx.send(result).unwrap();
        });

        let result = result_rx
            .recv_timeout(Duration::from_millis(250))
            .expect("scheduler hung after its only worker exited without a completion");
        assert!(
            result
                .unwrap_err()
                .contains("completion channel closed with running nodes")
        );
    }

    #[test]
    fn local_rebuild_protocol_rejects_identity_state_and_exit_mismatches() {
        let node = package("app");
        let success = NodeExecutionResultV1 {
            schema: 1,
            policy: "source-only-v1".to_string(),
            result: NodeRunResultV1::Succeeded {
                node: node.clone(),
                disposition: SuccessDispositionV1::Cached,
            },
            package_receipt: None,
        };
        let bytes = crate::local_build::canonical_machine_json(&success).unwrap();
        assert!(validate_child_result(&node, false, Some(0), &bytes).is_ok());
        assert!(validate_child_result(&node, false, Some(1), &bytes).is_err());
        assert!(validate_child_result(&package("other"), false, Some(0), &bytes).is_err());

        let blocked = NodeExecutionResultV1 {
            result: NodeRunResultV1::Blocked {
                node: node.clone(),
                failed_ancestors: vec![package("failed")],
            },
            ..success.clone()
        };
        assert!(
            validate_child_result(
                &node,
                false,
                Some(1),
                &crate::local_build::canonical_machine_json(&blocked).unwrap(),
            )
            .is_err()
        );
        assert!(validate_child_result(&node, true, Some(0), &bytes).is_err());

        let mut unknown: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        unknown["result"]["extra"] = serde_json::json!(true);
        assert!(
            validate_child_result(
                &node,
                false,
                Some(0),
                &serde_json::to_vec(&unknown).unwrap(),
            )
            .is_err()
        );
    }
}
