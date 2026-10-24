//! Generous computational sanity ceilings, independent of memory allowances.

// Work includes state copies, graph revisits and generated-code traversal,
// rather than only input operators. These counters allocate no memory. Normal
// memory savings come from compact summaries, disk facts and local IR lifetimes.
pub(crate) const TOTAL_WORK: usize = 16_000_000usize.saturating_mul(1_000_000);

// The interpreter reserves a body's allowance before specializing callees.
// Preserve headroom for nesting and escape retries, including on narrow hosts.
pub(crate) const LOCAL_WORK: usize = TOTAL_WORK / 16;

// SQLite counts VM instructions and also charges a batch for short queries.
// Those units differ from interpreter work and can be numerous on large inputs.
pub(crate) const SQL_WORK: u64 = 1_000_000_000_000_000;

// Module catalogs count activations and control-reachable functions separately.
// Keep their preflight allowance generous for large modules. Catalogs grow with
// their actual entries; this value is never an allocation request.
pub(crate) const MODULE_METADATA_BYTES: usize = 1024 * 1024 * 1024;
