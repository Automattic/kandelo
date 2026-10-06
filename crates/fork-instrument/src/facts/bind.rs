//! Binding the linked module's functions to their objects' facts.
//!
//! wasm-ld lays out defined functions object by object, in input order, and
//! concatenates same-named custom sections in the same order. So the module's
//! defined functions (in index order) fall into consecutive runs, one per
//! object, and the runs of objects with facts come in chunk order. Inside one
//! object the code order need not follow the order the plugin lists
//! definitions in (measured: clang emits a file-local function next to its
//! first reference), so inside a chunk functions are matched by name.
//!
//! Differences between the two sides:
//!
//! - a chunk lists functions the module lacks: removed by `--gc-sections`,
//!   or a COMDAT/linkonce copy the linker discarded in favour of an earlier
//!   object's copy;
//! - the module has functions no chunk lists: linker-synthesized functions
//!   (`__wasm_call_ctors`, ...), code generation helpers (`.Lcall_dtors*`),
//!   and code from objects compiled without the plugin (Rust, assembly).
//!
//! The binding:
//!
//! 1. *Anchors*: a name defined exactly once in the module and exactly once
//!    across all chunks. Out-of-order anchors are dropped by keeping the
//!    longest run of anchors whose chunks never decrease, so one
//!    coincidental name cannot drag the alignment.
//! 2. *Between anchors*: each module function is matched, in module order,
//!    against the chunks from the current one up to the next anchor's chunk
//!    that still have an unused same-named definition. When exactly one
//!    chunk qualifies, the function is bound there, that chunk becomes the
//!    current one, and one of its definitions is used up.
//! 3. *Unions, never guesses*: the name section has demangled names only,
//!    so a name can stand for several definitions: a C++ constructor's or
//!    destructor's complete- and base-object variants in one object, or
//!    same-named file-local functions in several objects of the window. The
//!    function is then bound to all of them, and the analysis uses the union
//!    of their facts. An ambiguity across objects leaves the current chunk
//!    and the unused definitions as they were.
//! 4. *Guard*: a pair whose Wasm parameters cannot be the lowering of the
//!    fact's IR parameters is not bound (the function gets no facts). The
//!    counts agree, except that the wasm32 lowering appends one `i32` (the
//!    variadic argument pointer) to a variadic function, prepends one `i32`
//!    (the result pointer) to a function returning `__int128` or
//!    `long double`, and splits each such parameter into two `i64`.
//!
//! One name differs by convention: clang defines `int main(int, char **)`
//! as `__main_argc_argv` (and `int main(void)` as `__main_void`) while the
//! linked module's name section keeps `main`.
//!
//! A function without a binding has no facts and is analysed conservatively.
use std::collections::HashMap;

/// A function or definition to match: its name and parameter count. For a
/// module function, also how many of its Wasm parameters are `i64` and
/// whether the first and last are `i32` (the lowering checks in
/// [`params_agree`]).
#[derive(Clone, Debug, Default)]
pub struct Item<'a> {
    pub name: &'a str,
    pub nparams: usize,
    pub i64_params: usize,
    pub first_is_i32: bool,
    pub last_is_i32: bool,
}

/// The name a definition has in the linked module's name section.
pub fn module_name(def_name: &str) -> &str {
    match def_name {
        "__main_argc_argv" | "__main_void" => "main",
        n => n,
    }
}

/// Whether module function `m`'s Wasm parameters can be the wasm32 lowering
/// of definition `d`'s IR parameters: equal counts, or extra parameters made
/// of at most one trailing `i32` (variadic), at most one leading `i32` (a
/// 128-bit result's pointer) and pairs of `i64` (split 128-bit values). A
/// necessary condition, not a proof.
pub fn params_agree(m: &Item, d: &Item) -> bool {
    let Some(extra) = m.nparams.checked_sub(d.nparams) else { return false };
    if extra == 0 {
        return true;
    }
    let lead = [0usize, usize::from(m.first_is_i32)];
    let trail = [0usize, usize::from(m.last_is_i32)];
    lead.iter().any(|&a| trail.iter().any(|&b| extra >= a + b && 2 * (extra - a - b) <= m.i64_params))
}

/// For each module function, the (chunk, definition index) pairs it is
/// bound to (empty: no facts; several: use the union).
///
/// `module` lists the module's defined functions in index order; `chunks`
/// lists each chunk's definitions in definition order. The parameter count
/// of a module function is its Wasm parameter count; of a definition, the
/// IR parameter count from the facts ([`params_agree`]).
pub fn bind(module: &[Item], chunks: &[Vec<Item>]) -> Vec<Vec<(usize, usize)>> {
    let mut out = vec![vec![]; module.len()];
    // Unused definitions per (chunk, name), in definition order (reversed,
    // so the next one pops off the end); the chunks defining each name.
    let mut unused: HashMap<(usize, &str), Vec<usize>> = HashMap::new();
    let mut group: HashMap<(usize, &str), Vec<usize>> = HashMap::new();
    let mut chunks_of: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut dcount: HashMap<&str, usize> = HashMap::new();
    for (c, defs) in chunks.iter().enumerate() {
        for (d, item) in defs.iter().enumerate().rev() {
            unused.entry((c, module_name(item.name))).or_default().push(d);
        }
        for (d, item) in defs.iter().enumerate() {
            group.entry((c, module_name(item.name))).or_default().push(d);
        }
        for item in defs {
            let name = module_name(item.name);
            *dcount.entry(name).or_default() += 1;
            let v = chunks_of.entry(name).or_default();
            if v.last() != Some(&c) {
                v.push(c);
            }
        }
    }
    let mut mcount: HashMap<&str, usize> = HashMap::new();
    for m in module {
        *mcount.entry(m.name).or_default() += 1;
    }
    // 1. Anchors in module order; keep the longest run whose chunks never
    // decrease (patience sorting with back links).
    let anchors: Vec<(usize, usize)> = module
        .iter()
        .enumerate()
        .filter(|(_, m)| mcount[m.name] == 1 && dcount.get(m.name) == Some(&1))
        .map(|(i, m)| (i, chunks_of[m.name][0]))
        .collect();
    let mut tails: Vec<usize> = vec![];
    let mut prev: Vec<Option<usize>> = vec![None; anchors.len()];
    for (a, &(_, c)) in anchors.iter().enumerate() {
        let l = tails.partition_point(|&t| anchors[t].1 <= c);
        prev[a] = l.checked_sub(1).map(|l| tails[l]);
        if l == tails.len() {
            tails.push(a);
        } else {
            tails[l] = a;
        }
    }
    let mut chain: Vec<(usize, usize)> = vec![];
    let mut cur = tails.last().copied();
    while let Some(a) = cur {
        chain.push(anchors[a]);
        cur = prev[a];
    }
    chain.reverse();
    // 2. Walk the module; the chunk window is [lo, next anchor's chunk].
    let last_chunk = chunks.len().saturating_sub(1);
    let mut next_anchor = chain.iter().peekable();
    let mut lo = 0usize;
    for (i, m) in module.iter().enumerate() {
        while next_anchor.peek().is_some_and(|&&(ai, _)| ai < i) {
            next_anchor.next();
        }
        let hi = next_anchor.peek().map_or(last_chunk, |&&(_, c)| c);
        let Some(cs) = chunks_of.get(m.name) else { continue };
        let start = cs.partition_point(|&c| c < lo);
        // Chunks in the window with an unused definition of this name, and
        // their definitions this function's parameters agree with.
        let candidates: Vec<(usize, Vec<usize>)> = cs[start..]
            .iter()
            .take_while(|&&c| c <= hi)
            .filter(|&&c| unused.get(&(c, m.name)).is_some_and(|v| !v.is_empty()))
            .map(|&c| (c, group[&(c, m.name)].iter().copied().filter(|&d| params_agree(m, &chunks[c][d])).collect::<Vec<_>>()))
            .filter(|(_, ds)| !ds.is_empty())
            .collect();
        match candidates.as_slice() {
            [] => {}
            [(c, ds)] => {
                out[i] = ds.iter().map(|&d| (*c, d)).collect();
                unused.get_mut(&(*c, m.name)).unwrap().pop();
                lo = *c;
            }
            many => out[i] = many.iter().flat_map(|(c, ds)| ds.iter().map(move |&d| (*c, d))).collect(),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items(v: &[(&'static str, usize)]) -> Vec<Item<'static>> {
        v.iter().map(|&(name, nparams)| Item { name, nparams, ..Default::default() }).collect()
    }

    #[test]
    fn gc_removed_definitions_are_skipped() {
        let m = items(&[("a", 1), ("c", 0)]);
        let d = vec![items(&[("a", 1), ("b", 2), ("c", 0)])];
        assert_eq!(bind(&m, &d), vec![vec![(0, 0)], vec![(0, 2)]]);
    }

    #[test]
    fn functions_without_facts_stay_unbound() {
        // __wasm_call_ctors is synthesized; rust_fn comes from an object
        // without facts, between two objects with facts.
        let m = items(&[("__wasm_call_ctors", 0), ("a", 1), ("rust_fn", 2), ("b", 0)]);
        let d = vec![items(&[("a", 1)]), items(&[("b", 0)])];
        assert_eq!(bind(&m, &d), vec![vec![], vec![(0, 0)], vec![], vec![(1, 0)]]);
    }

    #[test]
    fn code_order_inside_an_object_does_not_matter() {
        let m = items(&[("a", 0), ("cb", 1), ("b", 0)]);
        let d = vec![items(&[("a", 0), ("b", 0), ("cb", 1)])];
        assert_eq!(bind(&m, &d), vec![vec![(0, 0)], vec![(0, 2)], vec![(0, 1)]]);
    }

    #[test]
    fn same_named_statics_resolve_by_object_order() {
        // Two objects each define a static `helper`; a third object's copy
        // was removed by --gc-sections.
        let m = items(&[("x", 0), ("helper", 1), ("y", 0), ("helper", 2), ("z", 0)]);
        let d = vec![items(&[("x", 0), ("helper", 1)]), items(&[("y", 0), ("helper", 2)]), items(&[("helper", 3), ("z", 0)])];
        assert_eq!(bind(&m, &d), vec![vec![(0, 0)], vec![(0, 1)], vec![(1, 0)], vec![(1, 1)], vec![(2, 1)]]);
        // The first object's copy was removed instead.
        let m = items(&[("x", 0), ("y", 0), ("helper", 2), ("z", 0)]);
        let d = vec![items(&[("x", 0), ("helper", 1)]), items(&[("y", 0), ("helper", 2), ("z", 0)])];
        assert_eq!(bind(&m, &d), vec![vec![(0, 0)], vec![(1, 0)], vec![(1, 1)], vec![(1, 2)]]);
    }

    #[test]
    fn parameter_count_mismatch_is_not_bound() {
        // Fewer Wasm parameters than IR parameters: never a lowering.
        let d = vec![items(&[("open", 2), ("a", 0)])];
        let m = items(&[("open", 1), ("a", 0)]);
        assert_eq!(bind(&m, &d), vec![vec![], vec![(0, 1)]]);
        // One more, but not a trailing i32 and no i64 pair: not a lowering.
        let m = items(&[("open", 3), ("a", 0)]);
        assert_eq!(bind(&m, &d), vec![vec![], vec![(0, 1)]]);
        // A variadic function's trailing i32 argument pointer is.
        let mut m = items(&[("open", 3), ("a", 0)]);
        m[0].last_is_i32 = true;
        assert_eq!(bind(&m, &d), vec![vec![(0, 0)], vec![(0, 1)]]);
        // A long double split into two i64.
        let mut m = items(&[("strtold_l", 4)]);
        m[0].i64_params = 2;
        assert_eq!(bind(&m, &[items(&[("strtold_l", 3)])]), vec![vec![(0, 0)]]);
        // A long double result through a leading pointer, two long double
        // arguments as four i64.
        let mut m = items(&[("__addtf3", 5)]);
        m[0].i64_params = 4;
        m[0].first_is_i32 = true;
        assert_eq!(bind(&m, &[items(&[("__addtf3", 2)])]), vec![vec![(0, 0)]]);
        // A mismatching function does not take the definition that belongs
        // to a later same-named function.
        let m = items(&[("a", 0), ("s", 3), ("b", 0), ("s", 1), ("c", 0)]);
        let d = vec![items(&[("a", 0)]), items(&[("b", 0), ("s", 1), ("c", 0)])];
        assert_eq!(bind(&m, &d), vec![vec![(0, 0)], vec![], vec![(1, 0)], vec![(1, 1)], vec![(1, 2)]]);
    }

    #[test]
    fn main_binds_under_its_module_name() {
        let m = items(&[("main", 2)]);
        assert_eq!(bind(&m, &[items(&[("__main_argc_argv", 2)])]), vec![vec![(0, 0)]]);
    }

    #[test]
    fn linkonce_copies_in_the_window_are_unioned() {
        // `inl` is defined in both objects (linkonce); which copy the linker
        // kept is not visible by name, so the function gets both.
        let m = items(&[("a", 0), ("inl", 1), ("b", 0)]);
        let d = vec![items(&[("a", 0), ("inl", 1)]), items(&[("b", 0), ("inl", 1), ("c", 0)])];
        assert_eq!(bind(&m, &d), vec![vec![(0, 0)], vec![(0, 1), (1, 1)], vec![(1, 0)]]);
    }

    #[test]
    fn constructor_variants_are_unioned() {
        // The complete- and base-object destructors share one demangled
        // name; the module lists both, in either order.
        let m = items(&[("a", 0), ("C::~C()", 1), ("C::~C()", 1), ("b", 0)]);
        let d = vec![items(&[("a", 0), ("C::~C()", 1), ("b", 0), ("C::~C()", 1)])];
        assert_eq!(bind(&m, &d), vec![vec![(0, 0)], vec![(0, 1), (0, 3)], vec![(0, 1), (0, 3)], vec![(0, 2)]]);
    }

    #[test]
    fn same_named_statics_ambiguous_by_order_are_unioned() {
        // Two objects between the same anchors each define a static
        // `helper` with the same parameters; one was removed by the link.
        let m = items(&[("x", 0), ("helper", 1), ("z", 0)]);
        let d = vec![items(&[("x", 0), ("helper", 1)]), items(&[("helper", 1), ("z", 0)])];
        assert_eq!(bind(&m, &d), vec![vec![(0, 0)], vec![(0, 1), (1, 0)], vec![(1, 1)]]);
    }

    #[test]
    fn an_out_of_order_coincidence_does_not_drag_the_alignment() {
        // `late` is unique on both sides, but the module's `late` comes from
        // an object without facts placed first, and the chunk's `late` was
        // removed. The anchors a..e still bind.
        let m = items(&[("late", 0), ("a", 0), ("b", 0), ("c", 0), ("d", 0), ("e", 0)]);
        let d = vec![items(&[("a", 0)]), items(&[("b", 0)]), items(&[("c", 0)]), items(&[("d", 0)]), items(&[("e", 0)]), items(&[("late", 0)])];
        assert_eq!(bind(&m, &d), vec![vec![], vec![(0, 0)], vec![(1, 0)], vec![(2, 0)], vec![(3, 0)], vec![(4, 0)]]);
    }
}
