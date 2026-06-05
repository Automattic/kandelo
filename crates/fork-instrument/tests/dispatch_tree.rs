//! Unit tests for the `DispatchTree` data structure and its builder
//! (`crates/fork-instrument/src/instrument.rs`).
//!
//! These tests pin the bucketing topology that will drive Task 6's
//! recursive dispatch emission. The IR-shape tests live next door in
//! `large_dispatcher.rs`; this file stays in pure-Rust territory so
//! topology bugs surface without involving the wasm builder.

use fork_instrument::instrument::{BUCKET_SIZE, DispatchTree, build_dispatch_tree};

/// `(end - start)` for a leaf, total span for an internal node.
fn n_calls(tree: &DispatchTree) -> usize {
    tree.end() - tree.start()
}

/// Iterate over the leaves of a tree in left-to-right order, returning
/// `(start, end)` pairs. Used by the partition-covers-everything checks.
fn leaves(tree: &DispatchTree) -> Vec<(usize, usize)> {
    fn walk(tree: &DispatchTree, out: &mut Vec<(usize, usize)>) {
        match tree {
            DispatchTree::Leaf { start, end } => out.push((*start, *end)),
            DispatchTree::Internal { children, .. } => {
                for child in children {
                    walk(child, out);
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(tree, &mut out);
    out
}

/// `ceil(log_M(N))` for `N >= 1` and `M >= 2`. Returns 0 for N = 0
/// or N = 1 (no division needed).
fn ceil_log(n: usize, m: usize) -> u32 {
    assert!(m >= 2);
    if n <= 1 {
        return 0;
    }
    let mut levels = 0u32;
    let mut bound = 1usize;
    while bound < n {
        bound = bound.saturating_mul(m);
        levels += 1;
    }
    levels
}

#[test]
fn build_dispatch_tree_zero_calls_returns_empty_leaf() {
    let tree = build_dispatch_tree(0, BUCKET_SIZE);
    assert_eq!(tree, DispatchTree::Leaf { start: 0, end: 0 });
}

#[test]
fn build_dispatch_tree_one_call_returns_singleton_leaf() {
    let tree = build_dispatch_tree(1, 32);
    assert_eq!(tree, DispatchTree::Leaf { start: 0, end: 1 });
}

#[test]
fn build_dispatch_tree_exactly_one_bucket_stays_flat() {
    // Boundary: N = bucket_size must NOT recurse — emitted IR should
    // be bit-identical to the pre-bucketing single-leaf path.
    let tree = build_dispatch_tree(32, 32);
    assert_eq!(tree, DispatchTree::Leaf { start: 0, end: 32 });
}

#[test]
fn build_dispatch_tree_one_over_bucket_size_promotes_to_two_leaves() {
    // The first non-trivial bucketing: N = bucket_size + 1 must produce
    // two children of sizes 32 and 1, with span_per_child = 32.
    let tree = build_dispatch_tree(33, 32);
    assert_eq!(
        tree,
        DispatchTree::Internal {
            children: vec![
                DispatchTree::Leaf { start: 0, end: 32 },
                DispatchTree::Leaf { start: 32, end: 33 },
            ],
            span_per_child: 32,
        }
    );
}

#[test]
fn build_dispatch_tree_two_full_buckets_have_uniform_span() {
    let tree = build_dispatch_tree(64, 32);
    assert_eq!(
        tree,
        DispatchTree::Internal {
            children: vec![
                DispatchTree::Leaf { start: 0, end: 32 },
                DispatchTree::Leaf { start: 32, end: 64 },
            ],
            span_per_child: 32,
        }
    );
}

#[test]
fn build_dispatch_tree_full_two_level_uses_one_root_internal() {
    // N = M^2 = 1024 fits a single two-level tree: B = 32 leaves
    // of 32 calls each, span_per_child = 32. Critically it should NOT
    // promote to three levels — that's the regression we want.
    let tree = build_dispatch_tree(1024, 32);
    match &tree {
        DispatchTree::Internal {
            children,
            span_per_child,
        } => {
            assert_eq!(*span_per_child, 32);
            assert_eq!(children.len(), 32);
            for (i, child) in children.iter().enumerate() {
                assert_eq!(
                    *child,
                    DispatchTree::Leaf {
                        start: i * 32,
                        end: (i + 1) * 32,
                    },
                    "child {i} mismatch",
                );
            }
        }
        DispatchTree::Leaf { .. } => panic!("N=1024 must recurse"),
    }
    assert_eq!(tree.max_depth(), 32 + 32 + 3);
}

#[test]
fn build_dispatch_tree_just_over_two_levels_promotes_to_three() {
    // N = M^2 + 1 forces a third level: the root splits into the
    // full M^2 block on the left and a small singleton on the right.
    let tree = build_dispatch_tree(1025, 32);
    let DispatchTree::Internal {
        children: root_children,
        span_per_child: root_span,
    } = &tree
    else {
        panic!("N=1025 must produce an Internal root");
    };
    assert_eq!(*root_span, 1024);
    assert_eq!(root_children.len(), 2);
    assert_eq!(root_children[0].start(), 0);
    assert_eq!(root_children[0].end(), 1024);
    assert_eq!(root_children[1], DispatchTree::Leaf { start: 1024, end: 1025 });

    // Left child must itself be the full two-level shape.
    let DispatchTree::Internal {
        children: left_children,
        span_per_child: left_span,
    } = &root_children[0]
    else {
        panic!("left child of N=1025 must be Internal");
    };
    assert_eq!(*left_span, 32);
    assert_eq!(left_children.len(), 32);
}

#[test]
fn build_dispatch_tree_partition_covers_every_index_disjointly() {
    // Every call_idx in [0, N) must land in exactly one leaf, and the
    // leaves must be contiguous. Run this for several N including the
    // boundary cases.
    for &n in &[1usize, 32, 33, 64, 100, 1024, 1025, 2_000, 5_000] {
        let tree = build_dispatch_tree(n, 32);
        assert_eq!(n_calls(&tree), n, "N={n}: tree total span wrong");

        let leaves = leaves(&tree);
        let mut cursor = 0usize;
        for (start, end) in &leaves {
            assert_eq!(*start, cursor, "N={n}: leaf gap at {cursor} → {start}");
            assert!(start < end, "N={n}: empty leaf [{start}, {end})");
            assert!(
                end - start <= 32,
                "N={n}: oversize leaf [{start}, {end})",
            );
            cursor = *end;
        }
        assert_eq!(cursor, n, "N={n}: leaves cover only {cursor}/{n}");
    }
}

#[test]
fn build_dispatch_tree_internal_spans_are_powers_of_bucket_size() {
    // Every Internal's span_per_child is a power of BUCKET_SIZE. This
    // matters because the emit step uses span as an i32 divisor on the
    // (call_idx - range_start) value and assumes integer division is
    // exact at the bucket boundaries.
    fn check(tree: &DispatchTree, bucket_size: usize) {
        if let DispatchTree::Internal {
            children,
            span_per_child,
        } = tree
        {
            let mut p = bucket_size;
            let mut ok = false;
            for _ in 0..16 {
                if *span_per_child == p {
                    ok = true;
                    break;
                }
                p = p.saturating_mul(bucket_size);
            }
            assert!(
                ok,
                "span_per_child = {span_per_child} is not a power of {bucket_size}",
            );
            for child in children {
                check(child, bucket_size);
            }
        }
    }
    for &n in &[33usize, 64, 100, 1024, 1025, 32_768, 32_769, 2_000_000] {
        let tree = build_dispatch_tree(n, 32);
        check(&tree, 32);
    }
}

#[test]
fn max_depth_bounded_by_log_of_n_times_bucket_size() {
    // The whole point of recursive bucketing: depth must scale as
    // O(M · log_M(N)) rather than O(N). Tree levels (leaves count as
    // one level) is `max(1, ceil(log_M N))`; each level contributes
    // at most `M` to the depth, and the leaf adds a fixed `+3` for
    // `$dispatch_normal` + IfElse consequent + outermost block.
    const LEAF_EXTRA: usize = 3;
    let bucket_size = 32usize;
    for &n in &[
        1usize, 8, 32, 33, 64, 100, 1024, 1025, 2_000, 5_000, 32_768, 32_769,
        100_000, 1_000_000, 10_000_000,
    ] {
        let tree = build_dispatch_tree(n, bucket_size);
        let levels = (ceil_log(n, bucket_size) as usize).max(1);
        let bound = levels * bucket_size + LEAF_EXTRA;
        let depth = tree.max_depth();
        assert!(
            depth <= bound,
            "N={n}: depth {depth} exceeded bound {bound} (levels={levels})",
        );
    }
}

#[test]
fn max_depth_single_leaf_matches_pre_bucketing_observed_depth() {
    // Pin the historical single-leaf depth formula `N + 3`. The
    // integration test `large_dispatcher::direct_dispatcher_...`
    // observed depth N+3 on the pre-bucketing build, and N ≤ BUCKET_SIZE
    // must still produce that exact shape after the fix lands.
    for &n in &[1usize, 7, 32] {
        let tree = build_dispatch_tree(n, 32);
        assert_eq!(tree, DispatchTree::Leaf { start: 0, end: n });
        assert_eq!(tree.max_depth(), n + 3);
    }
}

#[test]
fn max_depth_property_holds_for_power_of_bucket_size_progression() {
    // Walk through the natural progression N = M^k. The depth must
    // grow by exactly `M` per level beyond a single leaf (since the
    // root just adds one M-wide chain of $child_K blocks).
    let bucket_size = 32usize;
    let m = bucket_size;
    let expected: [(usize, usize); 4] = [
        (32, 35),      // 1 level (leaf only)
        (1024, 67),    // 2 levels
        (32_768, 99),  // 3 levels
        (1_048_576, 131), // 4 levels
    ];
    for (n, want) in expected {
        let tree = build_dispatch_tree(n, m);
        assert_eq!(
            tree.max_depth(),
            want,
            "N={n}: expected depth {want}",
        );
    }
}
