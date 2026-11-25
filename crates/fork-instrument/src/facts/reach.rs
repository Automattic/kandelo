//! Exact reachability with one origin set per strongly connected component.
//! Equal sets are shared across components, including along linear paths.

use super::storage::FactsStore;
use anyhow::Result;
use std::{collections::HashMap, rc::Rc};

#[derive(Default)]
struct Vertex {
    predecessors: std::ops::Range<u32>,
    seed: Option<u32>,
}

#[derive(Default)]
struct Graph {
    indices: HashMap<i64, u32>,
    vertices: Vec<Vertex>,
    edges: Vec<u32>,
}

struct Components {
    of_vertex: Vec<usize>,
    members: Vec<u32>,
    ends: Vec<usize>,
}

impl Components {
    fn len(&self) -> usize {
        self.ends.len() - 1
    }

    fn members(&self, component: usize) -> &[u32] {
        &self.members[self.ends[component]..self.ends[component + 1]]
    }
}

impl Graph {
    fn vertex(&mut self, atom: i64) -> u32 {
        *self.indices.entry(atom).or_insert_with(|| {
            let index = self.vertices.len() as u32;
            self.vertices.push(Vertex::default());
            index
        })
    }

    fn predecessors(&self, node: u32) -> &[u32] {
        let range = &self.vertices[node as usize].predecessors;
        &self.edges[range.start as usize..range.end as usize]
    }

    // Iterative Tarjan over reversed edges. Components are emitted with
    // predecessors first; the dense edge array stores only one direction.
    fn components(&self) -> Components {
        struct Visit {
            node: u32,
            next_edge: usize,
        }
        let mut stack: Vec<Visit> = Vec::new();
        let mut active = Vec::new();
        let mut discovery = vec![usize::MAX; self.vertices.len()];
        let mut low = discovery.clone();
        let mut components = Components {
            of_vertex: discovery.clone(),
            members: Vec::with_capacity(self.vertices.len()),
            ends: vec![0],
        };
        let mut sequence = 0;
        let enter = |node: u32,
                     stack: &mut Vec<Visit>,
                     active: &mut Vec<u32>,
                     discovery: &mut [usize],
                     low: &mut [usize],
                     sequence: &mut usize| {
            discovery[node as usize] = *sequence;
            low[node as usize] = *sequence;
            *sequence += 1;
            active.push(node);
            stack.push(Visit { node, next_edge: 0 });
        };
        for start in 0..self.vertices.len() as u32 {
            if discovery[start as usize] != usize::MAX {
                continue;
            }
            enter(
                start,
                &mut stack,
                &mut active,
                &mut discovery,
                &mut low,
                &mut sequence,
            );
            while let Some(visit) = stack.last_mut() {
                let node = visit.node as usize;
                if let Some(&next) = self.predecessors(visit.node).get(visit.next_edge) {
                    visit.next_edge += 1;
                    if discovery[next as usize] == usize::MAX {
                        enter(
                            next,
                            &mut stack,
                            &mut active,
                            &mut discovery,
                            &mut low,
                            &mut sequence,
                        );
                    } else if components.of_vertex[next as usize] == usize::MAX {
                        low[node] = low[node].min(discovery[next as usize]);
                    }
                    continue;
                }
                stack.pop();
                if let Some(parent) = stack.last() {
                    let parent = parent.node as usize;
                    low[parent] = low[parent].min(low[node]);
                }
                if low[node] == discovery[node] {
                    let component = components.len();
                    loop {
                        let member = active.pop().unwrap();
                        components.of_vertex[member as usize] = component;
                        components.members.push(member);
                        if member as usize == node {
                            break;
                        }
                    }
                    components.ends.push(components.members.len());
                }
            }
        }
        components
    }
}

type Word = (usize, u64);

pub(super) struct Reach {
    node_sets: HashMap<i64, u32>,
    sets: Vec<Rc<[Word]>>,
    seeds: Vec<i64>,
}

impl Reach {
    /// None selects the equivalent external-memory solve when the graph or
    /// its unique sets exceed the resident allowance. SQL errors propagate.
    pub(super) fn solve(
        store: &FactsStore,
        edges_sql: &str,
        seeds_sql: &str,
        sinks_sql: Option<&str>,
    ) -> Result<Option<Self>> {
        const VERTEX_BYTES: usize = 192;
        let mut remaining = store
            .metadata_budget()
            .min((u32::MAX as usize).saturating_mul(VERTEX_BYTES));
        let mut graph = Graph::default();
        let progress = crate::progress::Progress::new("facts reachability");

        // The query streams (vertex, predecessor) ordered by vertex so each
        // adjacency list occupies one range in the packed edge array.
        let mut edges = store.db.prepare(edges_sql)?;
        let mut rows = edges.query([])?;
        let mut vertex = None;
        while let Some(row) = rows.next()? {
            if graph.edges.len() == u32::MAX as usize {
                return Ok(None);
            }
            let node = graph.vertex(row.get(0)?);
            let predecessor = graph.vertex(row.get(1)?);
            if vertex != Some(node) {
                debug_assert!(graph.vertices[node as usize].predecessors.is_empty());
                vertex = Some(node);
                graph.vertices[node as usize].predecessors.start = graph.edges.len() as u32;
            }
            if graph.edges.len() == graph.edges.capacity() {
                // Bound spare capacity as well as live edges.
                let batch = (graph.edges.len() / 8).max(4096).min(
                    remaining.saturating_sub(graph.vertices.len() * VERTEX_BYTES)
                        / size_of::<u32>(),
                );
                if batch == 0 {
                    return Ok(None);
                }
                graph.edges.reserve_exact(batch);
                remaining -= batch * size_of::<u32>();
            }
            if graph.vertices.len() > remaining / VERTEX_BYTES {
                return Ok(None);
            }
            graph.edges.push(predecessor);
            graph.vertices[node as usize].predecessors.end = graph.edges.len() as u32;
        }

        let mut query = store.db.prepare(seeds_sql)?;
        let mut rows = query.query([])?;
        let mut seeds = Vec::new();
        while let Some(row) = rows.next()? {
            let atom = row.get(0)?;
            let node = graph.vertex(atom);
            graph.vertices[node as usize].seed = Some(seeds.len() as u32);
            seeds.push(atom);
            if graph.vertices.len() > remaining / VERTEX_BYTES {
                return Ok(None);
            }
        }
        // Covers the graph, SCC walks, and per-component union workspace.
        remaining -= graph.vertices.len() * VERTEX_BYTES;
        let components = graph.components();
        progress.note(format_args!(
            "{} vertices, {} edges, {} components, {} seeds",
            graph.vertices.len(),
            graph.edges.len(),
            components.len(),
            seeds.len()
        ));
        // Slot origins are observed only by reads. Walk backwards from their
        // components to avoid propagating labels down unused branches.
        let mut needed = vec![sinks_sql.is_none(); components.len()];
        if let Some(sinks_sql) = sinks_sql {
            let mut query = store.db.prepare(sinks_sql)?;
            let mut rows = query.query([])?;
            while let Some(row) = rows.next()? {
                if let Some(&node) = graph.indices.get(&row.get::<_, i64>(0)?) {
                    needed[components.of_vertex[node as usize]] = true;
                }
            }
            for component in (0..components.len()).rev() {
                if needed[component] {
                    for &node in components.members(component) {
                        for &incoming in graph.predecessors(node) {
                            needed[components.of_vertex[incoming as usize]] = true;
                        }
                    }
                }
            }
        }
        let mut component_sets = Vec::with_capacity(components.len());
        let mut sets: Vec<Rc<[Word]>> = vec![Rc::from([])];
        let mut interned = HashMap::from([(sets[0].clone(), 0)]);
        let mut inputs = Vec::new();
        let mut seen_inputs = vec![false; components.len() + 1];
        let mut labels = Vec::new();
        let mut union = vec![0u64; seeds.len().div_ceil(64)];
        let mut touched = Vec::new();
        for component in 0..components.len() {
            if !needed[component] {
                component_sets.push(0);
                continue;
            }
            inputs.clear();
            labels.clear();
            for &node in components.members(component) {
                labels.extend(graph.vertices[node as usize].seed);
                for &incoming in graph.predecessors(node) {
                    let predecessor = components.of_vertex[incoming as usize];
                    if predecessor != component {
                        debug_assert!(predecessor < component);
                        let set = component_sets[predecessor];
                        if set != 0 && !std::mem::replace(&mut seen_inputs[set], true) {
                            inputs.push(set);
                        }
                    }
                }
            }
            for &input in &inputs {
                seen_inputs[input] = false;
            }
            let id = match (labels.is_empty(), inputs.as_slice()) {
                (true, []) => 0,
                (true, &[only]) => only,
                _ => {
                    // Merge packed words with one reusable workspace. Preserve
                    // sparse storage for leaves and their small reachable sets.
                    let mut add = |word: usize, bits: u64| {
                        if union[word] == 0 {
                            touched.push(word);
                        }
                        union[word] |= bits;
                    };
                    for label in labels.drain(..) {
                        add(label as usize / 64, 1 << (label % 64));
                    }
                    for &input in &inputs {
                        store.charge_work(sets[input].len().div_ceil(1000) as u64)?;
                        for &(word, bits) in sets[input].iter() {
                            add(word, bits);
                        }
                    }
                    touched.sort_unstable();
                    let words: Vec<_> = touched
                        .drain(..)
                        .map(|word| (word, std::mem::take(&mut union[word])))
                        .collect();
                    if let Some(&id) = interned.get(words.as_slice()) {
                        id
                    } else {
                        let charge = words.len() * size_of::<Word>() + 96;
                        if charge > remaining {
                            return Ok(None);
                        }
                        remaining -= charge;
                        let id = sets.len();
                        let words = Rc::from(words);
                        interned.insert(Rc::clone(&words), id);
                        sets.push(words);
                        id
                    }
                }
            };
            component_sets.push(id);
        }

        let mut node_sets = graph.indices;
        for node in node_sets.values_mut() {
            *node = component_sets[components.of_vertex[*node as usize]] as u32;
        }
        progress.note(format_args!("{} unique reachability sets", sets.len()));
        Ok(Some(Self {
            node_sets,
            sets,
            seeds,
        }))
    }

    pub(super) fn id(&self, atom: i64) -> usize {
        self.node_sets.get(&atom).copied().unwrap_or(0) as usize
    }

    pub(super) fn members(&self, id: usize) -> impl Iterator<Item = i64> + '_ {
        self.sets[id].iter().flat_map(move |&(word, mut bits)| {
            std::iter::from_fn(move || {
                if bits == 0 {
                    return None;
                }
                let bit = bits.trailing_zeros() as usize;
                bits &= bits - 1;
                Some(self.seeds[word * 64 + bit])
            })
        })
    }
}
