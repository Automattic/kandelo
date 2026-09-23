//! The reference-recipe node shapes: how a child activation reconstructs one
//! Wasm reference value from integers and graph edges alone, so a fresh fork
//! worker never inherits a live JavaScript or Wasm object.
//!
//! **The KFRR wire image and its decoder are gone (2026-09-14).** They were
//! the standalone serialization of these shapes, and nothing produced or
//! consumed one: capture writes KFRV (`reference_transaction` /
//! `reference_segments`) and replay is driven through the co-resident
//! fork-module. `b653ac7e7` deleted the TypeScript half -- the encoder, the
//! catalog, the coordinator and the fixture generator -- on exactly that
//! ground, noting the Rust `decode_reference_recipes` was "called by nothing
//! in `fork-module`, `kernel` or `host-native`". This is the other half of
//! that cleanup: the decoder, its `ReferenceRecipes` result, the wire
//! constants, ~500 lines of tests and the frozen `.bin` fixture they read.
//!
//! What stays is what is actually used. `ReferenceRecipeNode` appears in 259
//! places and `ReferenceRecipeEntry` in 46, across `reference_feed`,
//! `reference_replay`, `reference_transaction`, `reference_segments_writer`,
//! `reference_graph_builder`, `drive_plan` and `drive_plan_hints` -- and in
//! `fork-module`, so they cross a crate boundary as well. The shapes outlived
//! the format that once serialized them, which is the ordinary way a wire
//! format dies.

use alloc::vec::Vec;

/// One decoded reference-recipe node. Mirrors the TS `ForkReferenceRecipeNode`
/// discriminated union: a pure integer/edge description of how the child
/// activation reconstructs one Wasm reference value. Aggregate variants
/// (`Exnref`/`Struct`/`Array`) carry their exact scalar payload bytes plus the
/// ordered graph edges (payloads/fields/elements) into other node ids.
///
/// There is no host-`externref` node. A fork does not carry a raw host
/// object: capture refuses one with `EOPNOTSUPP` (see
/// `docs/fork-reference-support.md`), so no graph names one, and the wire
/// discriminant it used (kind 2) is rejected by the decoder. An `externref`
/// that is an `extern.convert_any` view of the program's own GC object is
/// captured as that GC object and needs no node of its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReferenceRecipeNode {
    /// A definitely-null reference.
    Null,
    /// A function reference resolved from an activation's function catalog.
    Funcref {
        module_activation: u32,
        function_ordinal: u32,
    },
    /// A Wasm exception reference: a tag coordinate, an artifact layout id, the
    /// exact scalar payload bits, and the ordered reference payload edges.
    Exnref {
        module_activation: u32,
        tag_ordinal: u32,
        layout_id: u32,
        scalars: Vec<u8>,
        payloads: Vec<u32>,
    },
    /// An `i31ref` carrying a signed 31-bit value (`-0x4000_0000..=0x3fff_ffff`).
    I31 { value: i32 },
    /// A Wasm GC struct: a type coordinate, an artifact layout id, the exact
    /// packed/non-reference field bits, and the ordered reference field edges.
    Struct {
        module_activation: u32,
        type_ordinal: u32,
        layout_id: u32,
        scalars: Vec<u8>,
        fields: Vec<u32>,
    },
    /// A Wasm GC array: a type coordinate, an artifact layout id, the exact
    /// scalar element bits, and the ordered reference element edges.
    Array {
        module_activation: u32,
        type_ordinal: u32,
        layout_id: u32,
        scalars: Vec<u8>,
        elements: Vec<u32>,
    },
    /// A statically rooted reference resolved from an activation's static-root
    /// catalog.
    StaticRoot {
        module_activation: u32,
        static_root_ordinal: u32,
    },
}

/// One decoded graph entry. Mirrors the TS `ForkReferenceRecipeEntry`: the
/// canonical graph-local id (always the record index `0..node_count`) and its
/// node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceRecipeEntry {
    pub id: u32,
    pub node: ReferenceRecipeNode,
}

/// The ordered graph edges of a decoded node, mirroring the TS `nodeEdges`.
pub(crate) fn node_edges(node: &ReferenceRecipeNode) -> &[u32] {
    match node {
        ReferenceRecipeNode::Exnref { payloads, .. } => payloads,
        ReferenceRecipeNode::Struct { fields, .. } => fields,
        ReferenceRecipeNode::Array { elements, .. } => elements,
        ReferenceRecipeNode::Null
        | ReferenceRecipeNode::Funcref { .. }
        | ReferenceRecipeNode::I31 { .. }
        | ReferenceRecipeNode::StaticRoot { .. } => &[],
    }
}
