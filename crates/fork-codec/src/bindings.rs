//! What one activation's catalog exports and imports turned out to be.
//!
//! Wasm cannot compare object identity: there is no `global.eq` or `table.eq`,
//! and the fork module does not import the activations' globals or tables. So
//! the host, which instantiated them, says which catalog entries and which
//! imports name ONE `WebAssembly.Global` or `WebAssembly.Table`, by giving
//! each distinct object a group id. Everything decided from those groups is
//! the module's:
//!
//!   - which activation PROVIDES a shared global or table to a child (the
//!     `KFBG` / `KFBT` elections in [`crate::module_state_records`]), and
//!   - which `(activation, owner)` coordinate WRITES a shared table's sparse
//!     state -- [`table_state_election`] below.
//!
//! One entry carries all of it: `fm_publish_bindings(activation, rows_ptr,
//! count)`, a packed array of [`BindingRow`]s, each one observation "slot X of
//! activation A is object-group G". It replaced `fm_set_identity_group`,
//! `fm_set_import_provenance` and `fm_set_activation_table_state_owner` (lane
//! F stage 1H); the last one's election used to be made by the host.

extern crate alloc;

use alloc::vec::Vec;

use wasm_posix_shared::abi;
use wasm_posix_shared::Errno;

/// A row's `space` is [`IMPORT_SPACE_GLOBAL`] (`__wpk_fork_global_<owner>`
/// exports and global imports) or [`IMPORT_SPACE_TABLE`]
/// (`__wpk_fork_table_<owner>` exports and table imports).
pub use crate::child_import_plan::{IMPORT_SPACE_GLOBAL, IMPORT_SPACE_TABLE};

/// Catalog export `owner` of the activation is object `group`.
pub const BINDING_ROLE_EXPORT_CATALOG: u8 = 0;
/// Import number `ordinal` (its position in the whole import section) of the
/// activation resolved to `kind` -- group `group` for an object, raw `bits`
/// for a scalar.
pub const BINDING_ROLE_IMPORT: u8 = 1;

/// Bytes per encoded row. Layout, little-endian:
///
/// ```text
///   +0   space u8            IMPORT_SPACE_*
///   +1   role u8             BINDING_ROLE_*
///   +2   kind u8             IMPORT only: WPK_FORK_IMPORTED_{GLOBAL,TABLE}_BINDING_*
///   +3   reserved u8         zero
///   +4   ordinal_or_owner u32
///   +8   group u32           0 = in no catalog (IMPORT only)
///   +12  reserved u32        zero
///   +16  bits u64            IMPORT only: a raw scalar's bits
/// ```
pub const BINDING_ROW_BYTES: usize = 24;

/// The bit that makes a `__wpk_fork_module_state_table_dirty_mark` owner
/// argument a GROUP.
///
/// The guest marks a table it mutated under its own owner ordinal (`1..`, one
/// per table of the module, so far below this bit). The host marks a table it
/// mutated -- the dynamic loader writing a side module's functions into the
/// shared indirect function table -- under the table's identity group with
/// this bit set, because the coordinate that owns the table's sparse state is
/// the module's election, not something the host knows. The module resolves
/// the group to that coordinate's owner. A group id may therefore never have
/// this bit set, and [`decode_binding_rows`] refuses one that does.
pub const TABLE_DIRTY_GROUP_FLAG: u32 = 0x8000_0000;

/// One decoded observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BindingRow {
    pub space: u8,
    pub role: u8,
    pub kind: u8,
    pub ordinal_or_owner: u32,
    pub group: u32,
    pub bits: u64,
}

impl BindingRow {
    /// Catalog export `owner` is object `group`.
    pub fn export(space: u8, owner: u32, group: u32) -> Self {
        Self { space, role: BINDING_ROLE_EXPORT_CATALOG, kind: 0, ordinal_or_owner: owner, group, bits: 0 }
    }

    /// Import `ordinal` resolved to `kind`, `group`, `bits`.
    pub fn import(space: u8, ordinal: u32, kind: u8, group: u32, bits: u64) -> Self {
        Self { space, role: BINDING_ROLE_IMPORT, kind, ordinal_or_owner: ordinal, group, bits }
    }
}

fn read_u32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Decode and validate one row. `EINVAL` for anything the format does not
/// define; nothing here is best-effort, because a row the module stored wrong
/// is a child rebuilt wrong much later.
pub fn decode_binding_row(bytes: &[u8]) -> Result<BindingRow, Errno> {
    if bytes.len() != BINDING_ROW_BYTES || bytes[3] != 0 || read_u32(bytes, 12) != 0 {
        return Err(Errno::EINVAL);
    }
    let mut bits = [0u8; 8];
    bits.copy_from_slice(&bytes[16..24]);
    let row = BindingRow {
        space: bytes[0],
        role: bytes[1],
        kind: bytes[2],
        ordinal_or_owner: read_u32(bytes, 4),
        group: read_u32(bytes, 8),
        bits: u64::from_le_bytes(bits),
    };
    if row.space != IMPORT_SPACE_GLOBAL && row.space != IMPORT_SPACE_TABLE {
        return Err(Errno::EINVAL);
    }
    // A group with the dirty-mark bit set could not be told apart from a
    // guest's owner ordinal there.
    if row.group & TABLE_DIRTY_GROUP_FLAG != 0 {
        return Err(Errno::EINVAL);
    }
    match row.role {
        BINDING_ROLE_EXPORT_CATALOG => {
            // Catalog owners are 1-based (`fork_instrument` numbers them from
            // 1), and every catalog entry is SOME object, so group 0 -- "in no
            // catalog" -- cannot describe one. An export has no kind or bits.
            if row.ordinal_or_owner == 0 || row.group == 0 || row.kind != 0 || row.bits != 0 {
                return Err(Errno::EINVAL);
            }
        }
        BINDING_ROLE_IMPORT => {
            // `BASE_IMPORT` is a DEFINED kind the host may not say: it asserts
            // that no activation provides the object, which is the election's
            // conclusion. The two spaces' numberings overlap (1 is RAW_NUMBER
            // among globals and ACTIVATION_TABLE among tables), so the space
            // decides what a kind byte means.
            let known = if row.space == IMPORT_SPACE_GLOBAL {
                matches!(
                    row.kind,
                    abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER
                        | abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT
                        | abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE
                        | abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL
                )
            } else {
                row.kind == abi::WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE
            };
            if !known {
                return Err(Errno::EINVAL);
            }
        }
        _ => return Err(Errno::EINVAL),
    }
    Ok(row)
}

/// Decode every row of `bytes`, all before any is stored: a publication is
/// accepted whole or refused whole.
pub fn decode_binding_rows(bytes: &[u8]) -> Result<Vec<BindingRow>, Errno> {
    if bytes.len() % BINDING_ROW_BYTES != 0 {
        return Err(Errno::EINVAL);
    }
    bytes.chunks_exact(BINDING_ROW_BYTES).map(decode_binding_row).collect()
}

/// Encode rows as [`decode_binding_rows`] reads them. The Node/browser host
/// has its own writer (`encodeForkBindings`), pinned against this layout by
/// `host/test/fork-table-state-election.test.ts`; host-native uses this one.
pub fn encode_binding_rows(rows: &[BindingRow]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rows.len() * BINDING_ROW_BYTES);
    for row in rows {
        out.extend_from_slice(&[row.space, row.role, row.kind, 0]);
        out.extend_from_slice(&row.ordinal_or_owner.to_le_bytes());
        out.extend_from_slice(&row.group.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&row.bits.to_le_bytes());
    }
    out
}

/// One table coordinate in one identity group, with the election result the
/// module currently serves for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TableCoordinate {
    pub activation: u32,
    pub owner: u32,
    pub owns: bool,
}

/// The canonical coordinate of one table group: the LOWEST `(activation,
/// owner)`, or `None` for an empty group.
///
/// Imported aliases name one physical `WebAssembly.Table`, and only one
/// coordinate may write its sparse state; the others still journal mutation
/// marks. Neither the first published nor the first registered wins. Those
/// agree in the common case (activations usually publish in ascending order),
/// which is exactly what makes "first wins" easy to ship: a side activation can
/// load before a lower-numbered one, and a `dlclose` of the incumbent must
/// promote the next.
pub fn table_state_winner(members: impl IntoIterator<Item = (u32, u32)>) -> Option<(u32, u32)> {
    members.into_iter().min()
}

/// One pass of applying an election: the module walks a group's coordinates
/// once per pass, in [`TABLE_STATE_PASSES`] order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TableStatePass {
    /// Clear every coordinate that owns the table and did not win.
    Demote,
    /// Set the winner, if it did not already own the table.
    Promote,
}

/// DEMOTIONS FIRST, and the order is the contract.
///
/// Promoting before demoting leaves a moment in which two coordinates own one
/// table, and a guest asking `table_state_owned` then gets two writers --
/// which does not trap, it rebuilds the child wrong. Demoting first leaves the
/// opposite moment, where a write is skipped rather than duplicated. Inside one
/// module call no guest runs between the writes, so neither moment is
/// observable today; the order is kept so that the day one is, it is the safe
/// one. It is the order the host's own election published in before the
/// module took it over (lane F stage 1H).
pub const TABLE_STATE_PASSES: [TableStatePass; 2] = [TableStatePass::Demote, TableStatePass::Promote];

/// What `pass` writes for `coordinate` (which currently `owns` or not), given
/// the group's `winner`: `Some(new owns)` for a change, `None` for none. Only
/// changes are written, so an incumbent is not rewritten on every publication.
pub fn table_state_change(
    pass: TableStatePass,
    coordinate: (u32, u32),
    owns: bool,
    winner: Option<(u32, u32)>,
) -> Option<bool> {
    let wins = Some(coordinate) == winner;
    match pass {
        TableStatePass::Demote if owns && !wins => Some(false),
        TableStatePass::Promote if wins && !owns => Some(true),
        _ => None,
    }
}

/// A whole election over one group's `(coordinate, owns)` members, as the
/// module applies it: every change, in the order written. For tests and for a
/// host that wants the answer as data; the module applies the passes in place
/// without allocating.
pub fn table_state_election(members: &[TableCoordinate]) -> Vec<TableCoordinate> {
    let winner = table_state_winner(members.iter().map(|m| (m.activation, m.owner)));
    let mut changes = Vec::new();
    for pass in TABLE_STATE_PASSES {
        for m in members {
            if let Some(owns) = table_state_change(pass, (m.activation, m.owner), m.owns, winner) {
                changes.push(TableCoordinate { owns, ..*m });
            }
        }
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coordinate(activation: u32, owner: u32, owns: bool) -> TableCoordinate {
        TableCoordinate { activation, owner, owns }
    }

    #[test]
    fn rows_round_trip() {
        let rows = [
            BindingRow::export(IMPORT_SPACE_TABLE, 3, 9),
            BindingRow::import(
                IMPORT_SPACE_GLOBAL,
                4,
                abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT,
                0,
                0xdead_beef_0000_0001,
            ),
        ];
        let bytes = encode_binding_rows(&rows);
        assert_eq!(bytes.len(), 2 * BINDING_ROW_BYTES);
        assert_eq!(decode_binding_rows(&bytes).unwrap(), rows);
    }

    #[test]
    fn refuses_what_the_format_does_not_define() {
        let refused = |row: BindingRow| decode_binding_rows(&encode_binding_rows(&[row]));
        let einval = Err(Errno::EINVAL);
        assert_eq!(refused(BindingRow { space: 2, ..BindingRow::export(0, 1, 1) }), einval, "space");
        assert_eq!(refused(BindingRow { role: 2, ..BindingRow::export(0, 1, 1) }), einval, "role");
        assert_eq!(refused(BindingRow::export(IMPORT_SPACE_GLOBAL, 0, 1)), einval, "owner 0");
        assert_eq!(refused(BindingRow::export(IMPORT_SPACE_TABLE, 1, 0)), einval, "export in no group");
        assert_eq!(
            refused(BindingRow { kind: 1, ..BindingRow::export(IMPORT_SPACE_TABLE, 1, 1) }),
            einval,
            "an export has no kind"
        );
        assert_eq!(
            refused(BindingRow::export(IMPORT_SPACE_TABLE, 1, TABLE_DIRTY_GROUP_FLAG | 1)),
            einval,
            "a group the dirty mark could not tell from an owner"
        );
        assert_eq!(
            refused(BindingRow::import(
                IMPORT_SPACE_GLOBAL,
                0,
                abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT,
                0,
                0
            )),
            einval,
            "BASE_IMPORT is the election's conclusion"
        );
        assert_eq!(
            refused(BindingRow::import(
                IMPORT_SPACE_TABLE,
                0,
                abi::WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL,
                1,
                0
            )),
            einval,
            "a global kind in the table space"
        );
        assert_eq!(refused(BindingRow::import(IMPORT_SPACE_GLOBAL, 0, 99, 0, 0)), einval, "undefined kind");
        let mut bytes = encode_binding_rows(&[BindingRow::export(IMPORT_SPACE_GLOBAL, 1, 1)]);
        bytes[3] = 1;
        assert_eq!(decode_binding_rows(&bytes), einval, "reserved byte");
        assert_eq!(decode_binding_rows(&bytes[..23]), einval, "a partial row");
    }

    #[test]
    fn a_publication_is_refused_whole() {
        let bytes = encode_binding_rows(&[
            BindingRow::export(IMPORT_SPACE_GLOBAL, 1, 1),
            BindingRow::export(IMPORT_SPACE_GLOBAL, 0, 1),
        ]);
        assert_eq!(decode_binding_rows(&bytes), Err(Errno::EINVAL));
    }

    #[test]
    fn the_lowest_coordinate_owns_not_the_first() {
        // A side activation published before the main one: the main one's
        // coordinate is still the canonical writer.
        let changes = table_state_election(&[coordinate(3, 9, true), coordinate(1, 2, false)]);
        assert_eq!(changes, [coordinate(3, 9, false), coordinate(1, 2, true)]);
        // Owner breaks a tie in activation.
        let changes = table_state_election(&[coordinate(1, 5, false), coordinate(1, 2, false)]);
        assert_eq!(changes, [coordinate(1, 2, true)]);
    }

    #[test]
    fn demotions_come_before_the_promotion() {
        // The incumbent is listed first here; an answer in member order would
        // promote before it demotes.
        let changes = table_state_election(&[
            coordinate(0, 1, false),
            coordinate(4, 1, true),
            coordinate(7, 3, false),
        ]);
        assert_eq!(changes, [coordinate(4, 1, false), coordinate(0, 1, true)]);
        let first_promotion = changes.iter().position(|c| c.owns).unwrap();
        assert!(changes[first_promotion..].iter().all(|c| c.owns), "{changes:?}");
    }

    #[test]
    fn only_changes_are_returned() {
        assert_eq!(table_state_election(&[coordinate(0, 1, true), coordinate(2, 1, false)]), []);
        assert_eq!(table_state_election(&[]), []);
    }

    #[test]
    fn a_release_promotes_the_next_coordinate() {
        // What is left of a group after its canonical coordinate's activation
        // was `dlclose`d: nobody owns it until the election runs again.
        let changes = table_state_election(&[coordinate(5, 2, false), coordinate(3, 4, false)]);
        assert_eq!(changes, [coordinate(3, 4, true)]);
    }
}
