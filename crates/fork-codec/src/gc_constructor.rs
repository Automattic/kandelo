//! Which constructor a fork child re-runs to rebuild a captured Wasm-GC array.
//!
//! A fork child is a fresh instance, so every GC object reachable from the
//! parent's live state is rebuilt there. Most shapes are rebuilt from their
//! type alone: a struct is `struct.new`'d from its field snapshot, and a
//! MUTABLE array of a defaultable element type is `array.new_default`'d and
//! then filled. Two shapes are not:
//!
//! * an IMMUTABLE array cannot be filled after allocation, and Wasm has no
//!   instruction that builds an immutable array of runtime length from
//!   arbitrary values;
//! * a MUTABLE array of a non-nullable reference type has no default to
//!   allocate with.
//!
//! For those the child must re-run one of the type's own allocation
//! instructions -- `array.new_fixed`, `array.new`, `array.new_default`,
//! `array.new_data` or `array.new_elem` -- with operands that produce the
//! parent's object. `fork-instrument` gives every such instruction in the
//! program its own constructor layout, and a generated allocator in the child
//! that runs exactly that instruction. This module decides WHICH layout, and
//! with which constructor-only operands, from facts the capture already has.
//!
//! # What is recorded and what is derived
//!
//! An immutable array's observable state is its type, its length and its
//! elements (its identity is carried separately, by the recipe graph). For
//! three constructors those facts ARE the operands:
//!
//! * `array.new_fixed N` takes its N elements as operands, so any array of
//!   length N is rebuilt by it from its own elements;
//! * `array.new v n` fills with one value, so a uniform array is rebuilt by it
//!   with `v` = its first element;
//! * `array.new_default n` is an all-default array.
//!
//! Deriving these costs the allocation path nothing. The two segment
//! constructors are different: `array.new_data`/`array.new_elem` take a
//! segment offset that the array's contents do not reveal, and the segment
//! may have been dropped since. Their operands are RECORDED where the
//! instruction runs (see `crates/fork-module`'s constructor witnesses) and
//! offered here as `recorded`; this module only chooses between a recording
//! and a derivation.
//!
//! When nothing fits, the answer is [`ConstructorChoice::Unrebuildable`], and
//! the caller refuses the capture with `EOPNOTSUPP` so `fork()` fails in the
//! parent instead of a child trapping in an allocator.

use alloc::vec::Vec;

use wasm_posix_shared::abi;

use crate::gc_codec::{
    CONSTRUCTOR_ARRAY_DATA, CONSTRUCTOR_ARRAY_DEFAULT, CONSTRUCTOR_ARRAY_ELEMENT,
    CONSTRUCTOR_ARRAY_FIXED, CONSTRUCTOR_ARRAY_NEW, FIELD_FLAG_MUTABLE, FIELD_FLAG_REFERENCE,
    GcCodec, GcLayoutDescriptor, KIND_ARRAY, LAYOUT_FLAG_DEFAULTABLE_SHELL,
};

/// Where a chosen layout's constructor-only reference edges come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProvenanceEdges {
    /// The layout records none.
    None,
    /// The layout's constructor witnesses (a type-correct seed that the fill
    /// overwrites), one per provenance ordinal.
    Witnesses,
    /// The array's own first element: the fill value of an immutable
    /// `array.new` over an internal reference type.
    FirstElement,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConstructorChoice {
    /// Rebuild with `layout_id`. `operands` are the constructor-only scalar
    /// bytes the recipe carries ahead of the snapshot (the layout's
    /// provenance scalar length of them).
    Layout {
        layout_id: u32,
        operands: Vec<u8>,
        edges: ProvenanceEdges,
    },
    /// No constructor the program contains can rebuild this object.
    Unrebuildable,
}

/// The captured contents of one array: its length, its scalar element bytes
/// (`len * stride` of them, after the length word) and its reference element
/// recipes.
#[derive(Debug, Clone, Copy)]
pub struct ArraySnapshot<'a> {
    pub len: u32,
    pub elements: &'a [u8],
    pub references: &'a [u32],
}

/// Choose the constructor that rebuilds a captured object whose TYPE test
/// answered `base_layout_id`.
///
/// * `recorded(layout)` -- for a segment-constructor layout, the operands of a
///   RECORDED invocation of that exact instruction whose result is
///   indistinguishable from this object, or `None`. Asked in layout order.
/// * `witnesses(layout)` -- how many constructor witnesses the layout has.
///
/// A struct, or an array of a defaultable mutable element type, keeps its base
/// layout: it is rebuilt from its type.
pub fn choose_constructor(
    codec: &GcCodec,
    base_layout_id: u32,
    snapshot: ArraySnapshot<'_>,
    mut recorded: impl FnMut(&GcLayoutDescriptor) -> Option<u64>,
    mut witnesses: impl FnMut(&GcLayoutDescriptor) -> usize,
) -> ConstructorChoice {
    let keep = ConstructorChoice::Layout {
        layout_id: base_layout_id,
        operands: Vec::new(),
        edges: ProvenanceEdges::Witnesses,
    };
    let Some(base) = base_layout_id
        .checked_sub(1)
        .and_then(|index| codec.layouts.get(index as usize))
    else {
        return ConstructorChoice::Unrebuildable;
    };
    if base.kind != KIND_ARRAY || base.flags & LAYOUT_FLAG_DEFAULTABLE_SHELL != 0 {
        return keep;
    }
    let Some(element) = base.fields.first() else {
        return ConstructorChoice::Unrebuildable;
    };
    let mutable = element.flags & FIELD_FLAG_MUTABLE != 0;
    let reference = element.flags & FIELD_FLAG_REFERENCE != 0;
    let stride = base.scalar_length_or_stride as usize;
    let constructors = || {
        codec
            .layouts
            .iter()
            .filter(move |layout| layout.base_layout_id == base.id && layout.id != base.id)
    };

    // 1. A recorded run of a segment constructor: the instruction that
    //    actually ran, with the operands it actually took.
    for layout in constructors() {
        if matches!(
            layout.constructor,
            CONSTRUCTOR_ARRAY_DATA | CONSTRUCTOR_ARRAY_ELEMENT
        ) && let Some(operands) = recorded(layout)
        {
            return ConstructorChoice::Layout {
                layout_id: layout.id,
                operands: operands.to_le_bytes().to_vec(),
                edges: ProvenanceEdges::None,
            };
        }
    }

    // 2. `array.new_fixed` of this length: its operands are the elements.
    for layout in constructors() {
        if layout.constructor == CONSTRUCTOR_ARRAY_FIXED && layout.auxiliary == snapshot.len {
            let needed = layout.provenance_reference_count as usize;
            if needed == 0 {
                return ConstructorChoice::Layout {
                    layout_id: layout.id,
                    operands: Vec::new(),
                    edges: ProvenanceEdges::None,
                };
            }
            if witnesses(layout) == needed {
                return ConstructorChoice::Layout {
                    layout_id: layout.id,
                    operands: Vec::new(),
                    edges: ProvenanceEdges::Witnesses,
                };
            }
        }
    }

    // 3. `array.new v n`. A mutable array is filled after allocation, so any
    //    type-correct seed will do; an immutable one must be uniform, and its
    //    fill value is its first element.
    let uniform = if reference {
        snapshot
            .references
            .windows(2)
            .all(|pair| pair[0] == pair[1])
    } else {
        stride != 0
            && snapshot
                .elements
                .chunks(stride)
                .all(|chunk| chunk == &snapshot.elements[..stride])
    };
    for layout in constructors() {
        if layout.constructor != CONSTRUCTOR_ARRAY_NEW || !(mutable || uniform) {
            continue;
        }
        let seeds = layout.provenance_reference_count as usize;
        if !reference {
            // Immutable (a mutable scalar array is a defaultable shell): the
            // operand is the fill value, zero for an empty array.
            let operand_len = layout.provenance_scalar_length as usize;
            let mut operands = alloc::vec![0u8; operand_len];
            if snapshot.len != 0 && snapshot.elements.len() >= operand_len {
                operands.copy_from_slice(&snapshot.elements[..operand_len]);
            }
            return ConstructorChoice::Layout {
                layout_id: layout.id,
                operands,
                edges: ProvenanceEdges::None,
            };
        }
        let edges = if seeds == 0 {
            ProvenanceEdges::None
        } else if !mutable && snapshot.len != 0 {
            ProvenanceEdges::FirstElement
        } else if witnesses(layout) == seeds {
            ProvenanceEdges::Witnesses
        } else {
            continue;
        };
        return ConstructorChoice::Layout {
            layout_id: layout.id,
            operands: Vec::new(),
            edges,
        };
    }

    // 4. `array.new_default n`: every element is its default.
    let defaults = snapshot.elements.iter().all(|byte| *byte == 0)
        && snapshot.references.iter().all(|recipe| *recipe == 0);
    if defaults {
        for layout in constructors() {
            if layout.constructor == CONSTRUCTOR_ARRAY_DEFAULT {
                return ConstructorChoice::Layout {
                    layout_id: layout.id,
                    operands: Vec::new(),
                    edges: ProvenanceEdges::None,
                };
            }
        }
    }

    ConstructorChoice::Unrebuildable
}

/// A segment constructor layout, read straight out of an ALREADY VALIDATED
/// `kandelo.wpk_fork.gc_codec` descriptor: `Some((element_stride,
/// is_data))` when `layout_id` is an `array.new_data` or `array.new_elem`
/// layout, else `None`.
///
/// This is the allocation-path question -- "does this constructor's run need
/// recording?" -- so it reads two fields in place rather than decoding the
/// catalog. The stride is a reference array's 0 (its elements are recipe
/// edges, not bytes).
pub fn segment_constructor(descriptor: &[u8], layout_id: u32) -> Option<(u32, bool)> {
    let header = abi::WPK_FORK_GC_CODEC_HEADER_SIZE as usize;
    let record = abi::WPK_FORK_GC_CODEC_LAYOUT_RECORD_SIZE as usize;
    let count = u32::from_le_bytes(descriptor.get(8..12)?.try_into().ok()?);
    if layout_id == 0 || layout_id > count {
        return None;
    }
    let at = header.checked_add((layout_id as usize - 1).checked_mul(record)?)?;
    let bytes = descriptor.get(at..at.checked_add(record)?)?;
    let constructor = bytes[9];
    let stride = u32::from_le_bytes(bytes[12..16].try_into().ok()?);
    match constructor {
        CONSTRUCTOR_ARRAY_DATA => Some((stride, true)),
        CONSTRUCTOR_ARRAY_ELEMENT => Some((stride, false)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gc_codec::{CONSTRUCTOR_ARRAY_GENERIC, GcFieldDescriptor, KIND_STRUCT};
    use alloc::vec;

    const REQ: u16 = 1; // LAYOUT_FLAG_REQUIRES_PROVENANCE

    fn scalar_field(storage: u8, mutable: bool) -> GcFieldDescriptor {
        GcFieldDescriptor {
            storage,
            flags: if mutable { FIELD_FLAG_MUTABLE } else { 0 },
            scalar_offset: Some(0),
            reference_ordinal: None,
        }
    }

    fn ref_field(mutable: bool, nullable: bool) -> GcFieldDescriptor {
        let mut flags = FIELD_FLAG_REFERENCE;
        if mutable {
            flags |= FIELD_FLAG_MUTABLE;
        }
        if nullable {
            flags |= 1 << 1;
        }
        GcFieldDescriptor {
            storage: 8,
            flags,
            scalar_offset: None,
            reference_ordinal: Some(0),
        }
    }

    fn layout(
        id: u32,
        base: u32,
        constructor: u8,
        auxiliary: u32,
        field: GcFieldDescriptor,
        stride: u32,
        prov_scalar: u32,
        prov_refs: u32,
    ) -> GcLayoutDescriptor {
        GcLayoutDescriptor {
            id,
            type_ordinal: 0,
            kind: KIND_ARRAY,
            constructor,
            flags: REQ,
            scalar_length_or_stride: stride,
            fields: vec![field],
            super_type_ordinal: None,
            base_layout_id: base,
            auxiliary,
            provenance_scalar_length: prov_scalar,
            provenance_reference_count: prov_refs,
        }
    }

    /// An immutable `array i8` with a generic base (1), `array.new_data` of
    /// segment 0 (2), `array.new_fixed 4` (3), `array.new` (4) and
    /// `array.new_default` (5).
    fn bytes_codec() -> GcCodec {
        let f = scalar_field(1, false);
        GcCodec {
            layouts: vec![
                layout(1, 1, CONSTRUCTOR_ARRAY_GENERIC, 0, f, 1, 0, 0),
                layout(2, 1, CONSTRUCTOR_ARRAY_DATA, 0, f, 1, 8, 0),
                layout(3, 1, CONSTRUCTOR_ARRAY_FIXED, 4, f, 1, 0, 0),
                layout(4, 1, CONSTRUCTOR_ARRAY_NEW, 0, f, 1, 1, 0),
                layout(5, 1, CONSTRUCTOR_ARRAY_DEFAULT, 0, f, 1, 0, 0),
            ],
        }
    }

    fn snap<'a>(elements: &'a [u8], references: &'a [u32], len: u32) -> ArraySnapshot<'a> {
        ArraySnapshot {
            len,
            elements,
            references,
        }
    }

    fn pick(codec: &GcCodec, s: ArraySnapshot<'_>, recorded: Option<u64>) -> ConstructorChoice {
        choose_constructor(codec, 1, s, |_| recorded, |_| 0)
    }

    #[test]
    fn a_recorded_segment_run_wins_and_carries_its_operands() {
        let got = pick(
            &bytes_codec(),
            snap(&[1, 2, 3, 4], &[], 4),
            Some(0x0000_0004_0000_0002),
        );
        assert_eq!(
            got,
            ConstructorChoice::Layout {
                layout_id: 2,
                operands: 0x0000_0004_0000_0002u64.to_le_bytes().to_vec(),
                edges: ProvenanceEdges::None,
            }
        );
    }

    #[test]
    fn array_new_fixed_rebuilds_any_array_of_its_length() {
        let got = pick(&bytes_codec(), snap(&[9, 1, 7, 3], &[], 4), None);
        assert!(matches!(
            got,
            ConstructorChoice::Layout { layout_id: 3, .. }
        ));
    }

    #[test]
    fn array_new_rebuilds_a_uniform_array_from_its_first_element() {
        let got = pick(&bytes_codec(), snap(&[5, 5, 5], &[], 3), None);
        assert_eq!(
            got,
            ConstructorChoice::Layout {
                layout_id: 4,
                operands: vec![5],
                edges: ProvenanceEdges::None,
            }
        );
    }

    #[test]
    fn a_non_uniform_array_of_another_length_is_unrebuildable() {
        // No FIXED of length 3, not uniform, not all default, no recording:
        // only `array.new_data` could have made it, and nothing recorded it.
        assert_eq!(
            pick(&bytes_codec(), snap(&[1, 2, 3], &[], 3), None),
            ConstructorChoice::Unrebuildable
        );
    }

    #[test]
    fn an_all_default_array_without_array_new_uses_array_new_default() {
        let mut codec = bytes_codec();
        codec
            .layouts
            .retain(|l| l.constructor != CONSTRUCTOR_ARRAY_NEW);
        let got = choose_constructor(&codec, 1, snap(&[0, 0], &[], 2), |_| None, |_| 0);
        assert!(matches!(
            got,
            ConstructorChoice::Layout { layout_id: 5, .. }
        ));
    }

    #[test]
    fn a_defaultable_mutable_array_and_a_struct_keep_their_base() {
        let mut codec = bytes_codec();
        codec.layouts[0].flags |= LAYOUT_FLAG_DEFAULTABLE_SHELL;
        let got = choose_constructor(&codec, 1, snap(&[1, 2, 3], &[], 3), |_| None, |_| 0);
        assert!(matches!(
            got,
            ConstructorChoice::Layout { layout_id: 1, .. }
        ));
        let mut codec = bytes_codec();
        codec.layouts[0].kind = KIND_STRUCT;
        let got = choose_constructor(&codec, 1, snap(&[], &[], 0), |_| None, |_| 0);
        assert!(matches!(
            got,
            ConstructorChoice::Layout { layout_id: 1, .. }
        ));
    }

    /// A mutable non-null internal reference array: base (1), `array.new` with
    /// one witness seed (2), `array.new_fixed 2` with two (3).
    fn mutable_refs_codec() -> GcCodec {
        let f = ref_field(true, false);
        GcCodec {
            layouts: vec![
                layout(1, 1, CONSTRUCTOR_ARRAY_GENERIC, 0, f, 0, 0, 0),
                layout(2, 1, CONSTRUCTOR_ARRAY_NEW, 0, f, 0, 0, 1),
                layout(3, 1, CONSTRUCTOR_ARRAY_FIXED, 2, f, 0, 0, 2),
            ],
        }
    }

    #[test]
    fn a_mutable_reference_array_is_seeded_from_witnesses_then_filled() {
        let codec = mutable_refs_codec();
        // FIXED 2 has both witnesses: it is taken, whatever the elements are.
        let got = choose_constructor(
            &codec,
            1,
            snap(&[], &[4, 9], 2),
            |_| None,
            |l| l.provenance_reference_count as usize,
        );
        assert_eq!(
            got,
            ConstructorChoice::Layout {
                layout_id: 3,
                operands: vec![],
                edges: ProvenanceEdges::Witnesses,
            }
        );
        // Without FIXED's witnesses, `array.new`'s one seed rebuilds it.
        let got = choose_constructor(
            &codec,
            1,
            snap(&[], &[4, 9], 2),
            |_| None,
            |l| usize::from(l.id == 2),
        );
        assert!(matches!(
            got,
            ConstructorChoice::Layout { layout_id: 2, .. }
        ));
        // With no witness at all there is no type-correct seed: refused.
        let got = choose_constructor(&codec, 1, snap(&[], &[4, 9], 2), |_| None, |_| 0);
        assert_eq!(got, ConstructorChoice::Unrebuildable);
    }

    #[test]
    fn an_immutable_reference_array_new_is_seeded_by_its_own_element() {
        let f = ref_field(false, false);
        let codec = GcCodec {
            layouts: vec![
                layout(1, 1, CONSTRUCTOR_ARRAY_GENERIC, 0, f, 0, 0, 0),
                layout(2, 1, CONSTRUCTOR_ARRAY_NEW, 0, f, 0, 0, 1),
            ],
        };
        // A witness would be the wrong VALUE for an immutable array: the fill
        // value is observable, so it must be the array's own element.
        let got = choose_constructor(&codec, 1, snap(&[], &[6, 6, 6], 3), |_| None, |_| 1);
        assert_eq!(
            got,
            ConstructorChoice::Layout {
                layout_id: 2,
                operands: vec![],
                edges: ProvenanceEdges::FirstElement,
            }
        );
        // Not uniform: `array.new` cannot have made it.
        let got = choose_constructor(&codec, 1, snap(&[], &[6, 7], 2), |_| None, |_| 1);
        assert_eq!(got, ConstructorChoice::Unrebuildable);
    }

    #[test]
    fn segment_constructor_reads_the_raw_descriptor() {
        // The committed real-encoder fixture: layout 6 is `array.new_data`
        // over an `i8` array; layouts 5 and 7 are not segment constructors.
        let bytes: &[u8] = include_bytes!("../testdata/gc-codec-wasm32.bin");
        assert_eq!(segment_constructor(bytes, 6), Some((1, true)));
        assert_eq!(segment_constructor(bytes, 5), None);
        assert_eq!(segment_constructor(bytes, 7), None);
        assert_eq!(segment_constructor(bytes, 0), None);
        assert_eq!(segment_constructor(bytes, 8), None);
        assert_eq!(segment_constructor(&bytes[..20], 6), None);
    }
}
