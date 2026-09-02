//! GC drive PLAN (Phase 6 item 3b — call_indirect drive-shim mechanism).
//!
//! The co-resident module cannot IMPORT the guest's `__wpk_fork_ref_gc_allocate`
//! / `_gc_fill` exports (the module is instantiated BEFORE the guest, to supply
//! the frame-flip imports). So instead of the JS `materializeTypedGraph`
//! drive-order calling those guest exports, the module drives them through a
//! MUTABLE funcref table (`env.__wpk_fork_drive_table`) the host binds
//! post-instantiation (`table.set(guest _gc_allocate/_gc_fill)`).
//!
//! Since Rust has no `call_indirect` intrinsic, the split is: this pure-Rust
//! code computes an ordered PLAN of [`DriveStep`]s and serializes it into a byte
//! buffer in guest memory; an injected walrus SHIM `fm_drive_execute(plan_ptr,
//! count)` (see `crates/fork-module-inject`) loops the serialized plan and
//! `call_indirect`s the table slot for each step, then — after each ALLOC —
//! `call`s the module's Rust `fm_after_alloc(recipe)` for the R1 transit-read
//! assert.
//!
//! This slice builds ONLY the mechanism, proven on a TRIVIAL single struct
//! (ALLOC then FILL for one recipe). The full topological plan-from-graph walk
//! (R1/R2 order + cycle breaking) is item 3c.
//!
//! ## Serialized step layout (16 bytes, little-endian) — SHARED with the injected
//! `fm_drive_execute` shim (`crates/fork-module-inject/src/main.rs`) and the host:
//!
//! ```text
//!   +0  op      u32   DRIVE_OP_ALLOC (0) | DRIVE_OP_FILL (1)
//!   +4  slot    u32   absolute drive-table index = base(activation) + op
//!   +8  recipe  u32   reference recipe id (fm_after_alloc reads transit slot recipe+1)
//!   +12 arg     u32   the i32 argument passed to the guest export via call_indirect
//! ```

use wasm_posix_shared::Errno;

/// Bytes per serialized [`DriveStep`]. The injected shim strides the plan by
/// this and reads the four little-endian u32 fields at the offsets above.
pub const DRIVE_STEP_SIZE: usize = 16;

/// Byte offsets of the four u32 step fields (SHARED with the injected shim).
pub const DRIVE_STEP_OFF_OP: usize = 0;
pub const DRIVE_STEP_OFF_SLOT: usize = 4;
pub const DRIVE_STEP_OFF_RECIPE: usize = 8;
pub const DRIVE_STEP_OFF_ARG: usize = 12;

/// `op` value: allocate the aggregate (`_gc_allocate`). The shim calls
/// `fm_after_alloc(recipe)` after an ALLOC step for the R1 transit-read assert.
pub const DRIVE_OP_ALLOC: u32 = 0;
/// `op` value: fill the aggregate's scalars/edges (`_gc_fill`).
pub const DRIVE_OP_FILL: u32 = 1;

/// Drive-table slots reserved per activation: one ALLOC + one FILL. Each
/// activation `a` binds its `_gc_allocate` at `base(a)+DRIVE_OP_ALLOC` and its
/// `_gc_fill` at `base(a)+DRIVE_OP_FILL`.
pub const DRIVE_SLOTS_PER_ACTIVATION: u32 = 2;

/// One drive step: which guest export to `call_indirect` (via `slot`) with which
/// `arg`, tagged by `op` so the shim knows whether to run the R1 assert.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DriveStep {
    pub op: u32,
    pub slot: u32,
    pub recipe: u32,
    pub arg: u32,
}

/// The first drive-table slot belonging to `activation`. A single-activation
/// fork uses base 0, so its ALLOC slot is 0 and FILL slot is 1 — the trivial
/// mechanism this slice proves. Multi-activation base seeding is item 3c.
pub fn drive_table_base(activation: u32) -> u32 {
    activation.wrapping_mul(DRIVE_SLOTS_PER_ACTIVATION)
}

/// Serialize `steps` into `out` (a guest-memory scratch region). Returns the
/// number of bytes written. Fails `EINVAL` if `out` is too small rather than
/// truncating — a short plan buffer is a host bug, never a silent partial drive.
pub fn serialize_plan(steps: &[DriveStep], out: &mut [u8]) -> Result<usize, Errno> {
    let need = steps
        .len()
        .checked_mul(DRIVE_STEP_SIZE)
        .ok_or(Errno::EINVAL)?;
    if out.len() < need {
        return Err(Errno::EINVAL);
    }
    for (index, step) in steps.iter().enumerate() {
        let base = index * DRIVE_STEP_SIZE;
        out[base + DRIVE_STEP_OFF_OP..base + DRIVE_STEP_OFF_OP + 4]
            .copy_from_slice(&step.op.to_le_bytes());
        out[base + DRIVE_STEP_OFF_SLOT..base + DRIVE_STEP_OFF_SLOT + 4]
            .copy_from_slice(&step.slot.to_le_bytes());
        out[base + DRIVE_STEP_OFF_RECIPE..base + DRIVE_STEP_OFF_RECIPE + 4]
            .copy_from_slice(&step.recipe.to_le_bytes());
        out[base + DRIVE_STEP_OFF_ARG..base + DRIVE_STEP_OFF_ARG + 4]
            .copy_from_slice(&step.arg.to_le_bytes());
    }
    Ok(need)
}

/// Read step `index` from a serialized plan. Bounds-checked; `EINVAL` past the
/// end. This is the inverse of [`serialize_plan`] used by tests and the host to
/// verify the bytes the shim will read.
pub fn read_step(plan: &[u8], index: usize) -> Result<DriveStep, Errno> {
    let base = index
        .checked_mul(DRIVE_STEP_SIZE)
        .ok_or(Errno::EINVAL)?;
    let end = base.checked_add(DRIVE_STEP_SIZE).ok_or(Errno::EINVAL)?;
    if plan.len() < end {
        return Err(Errno::EINVAL);
    }
    let read_u32 = |offset: usize| -> u32 {
        let start = base + offset;
        let mut bytes = [0u8; 4];
        bytes.copy_from_slice(&plan[start..start + 4]);
        u32::from_le_bytes(bytes)
    };
    Ok(DriveStep {
        op: read_u32(DRIVE_STEP_OFF_OP),
        slot: read_u32(DRIVE_STEP_OFF_SLOT),
        recipe: read_u32(DRIVE_STEP_OFF_RECIPE),
        arg: read_u32(DRIVE_STEP_OFF_ARG),
    })
}

/// The TRIVIAL single-struct plan the mechanism proof drives: ALLOC then FILL
/// for ONE recipe in `activation`. Enough to prove the shim loops the plan,
/// `call_indirect`s the bound guest exports in order, and runs the R1 assert
/// after ALLOC. The full graph walk is item 3c.
pub fn trivial_struct_plan(activation: u32, recipe: u32) -> [DriveStep; 2] {
    let base = drive_table_base(activation);
    [
        DriveStep {
            op: DRIVE_OP_ALLOC,
            slot: base + DRIVE_OP_ALLOC,
            recipe,
            arg: recipe,
        },
        DriveStep {
            op: DRIVE_OP_FILL,
            slot: base + DRIVE_OP_FILL,
            recipe,
            arg: recipe,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    #[test]
    fn drive_table_base_reserves_two_slots_per_activation() {
        assert_eq!(drive_table_base(0), 0);
        assert_eq!(drive_table_base(1), 2);
        assert_eq!(drive_table_base(3), 6);
    }

    #[test]
    fn trivial_struct_plan_is_alloc_then_fill_for_activation_zero() {
        let plan = trivial_struct_plan(0, 5);
        assert_eq!(
            plan[0],
            DriveStep { op: DRIVE_OP_ALLOC, slot: 0, recipe: 5, arg: 5 }
        );
        assert_eq!(
            plan[1],
            DriveStep { op: DRIVE_OP_FILL, slot: 1, recipe: 5, arg: 5 }
        );
    }

    #[test]
    fn trivial_struct_plan_uses_the_activation_base_slots() {
        // Activation 2 -> base 4: ALLOC slot 4, FILL slot 5.
        let plan = trivial_struct_plan(2, 9);
        assert_eq!(plan[0].slot, 4);
        assert_eq!(plan[1].slot, 5);
    }

    #[test]
    fn serialize_then_read_round_trips_every_field() {
        let plan = trivial_struct_plan(0, 42);
        let mut bytes = vec![0u8; DRIVE_STEP_SIZE * plan.len()];
        let written = serialize_plan(&plan, &mut bytes).unwrap();
        assert_eq!(written, DRIVE_STEP_SIZE * 2);
        assert_eq!(read_step(&bytes, 0).unwrap(), plan[0]);
        assert_eq!(read_step(&bytes, 1).unwrap(), plan[1]);
    }

    #[test]
    fn serialize_rejects_a_short_buffer() {
        let plan = trivial_struct_plan(0, 1);
        let mut bytes = vec![0u8; DRIVE_STEP_SIZE]; // room for one step, need two
        assert_eq!(serialize_plan(&plan, &mut bytes), Err(Errno::EINVAL));
    }

    #[test]
    fn read_step_past_the_end_is_einval() {
        let plan = trivial_struct_plan(0, 1);
        let mut bytes = vec![0u8; DRIVE_STEP_SIZE * plan.len()];
        serialize_plan(&plan, &mut bytes).unwrap();
        assert_eq!(read_step(&bytes, 2), Err(Errno::EINVAL));
    }
}
