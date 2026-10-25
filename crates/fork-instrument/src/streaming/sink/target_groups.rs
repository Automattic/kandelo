//! Persist exact target groups once, without expanding every call-site edge.

use anyhow::Result;
use rusqlite::params;
use sha2::{Digest, Sha256};

use crate::facts::storage::FactsStore;

pub(super) fn reaching(store: &FactsStore, seed: u32, external: Option<u32>) -> Result<()> {
    // WHY: visit a shared group once, rather than materializing the same
    // target-to-caller edges at every call site in the recursive relation.
    // Distinct vertex kinds keep group IDs separate from function ordinals.
    store.execute(
        "INSERT INTO sink_reaching WITH RECURSIVE r(kind,id) AS (
          VALUES(0,?1) UNION SELECT 0,?2 WHERE ?2 IS NOT NULL
          UNION SELECT 1,m.group_id FROM sink_target_member m JOIN r ON r.kind=0 AND r.id=m.target
          UNION SELECT 0,s.caller FROM sink_caller_group s JOIN r ON r.kind=1 AND r.id=s.group_id)
          SELECT id FROM r WHERE kind=0",
        params![seed, external],
    )?;
    Ok(())
}

pub(super) fn intern(store: &FactsStore, targets: &[u32]) -> Result<i64> {
    let mut digest = Sha256::new();
    for target in targets {
        digest.update(target.to_le_bytes());
    }
    intern_with_digest(store, targets, &digest.finalize())
}

fn intern_with_digest(store: &FactsStore, targets: &[u32], digest: &[u8]) -> Result<i64> {
    store.charge_work(1)?;
    let mut candidates = store
        .db
        .prepare_cached("SELECT id FROM sink_target_group WHERE digest=? AND size=? ORDER BY id")?;
    let mut rows = candidates.query(params![digest, targets.len()])?;
    while let Some(row) = rows.next()? {
        let id: i64 = row.get(0)?;
        let mut query = store.db.prepare_cached(
            "SELECT target FROM sink_target_member WHERE group_id=? ORDER BY target",
        )?;
        let mut members = query.query([id])?;
        let mut equal = true;
        for &target in targets {
            if members
                .next()?
                .map(|row| row.get::<_, u32>(0))
                .transpose()?
                != Some(target)
            {
                equal = false;
                break;
            }
        }
        // WHY: the digest narrows candidates; exact equality is the authority.
        // A collision must never change which function a call can reach.
        if equal && members.next()?.is_none() {
            return Ok(id);
        }
    }
    drop(rows);
    drop(candidates);
    store.execute(
        "INSERT INTO sink_target_group(digest,size) VALUES(?,?)",
        params![digest, targets.len()],
    )?;
    let id = store.db.last_insert_rowid();
    for target in targets {
        store.execute(
            "INSERT INTO sink_target_member VALUES(?,?)",
            params![id, target],
        )?;
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn repeated_dispatch_fits_where_the_expanded_site_projection_does_not() {
        let store = FactsStore::empty(crate::facts::storage::StorageLimits {
            disk_bytes: 4 * 1024 * 1024,
            ..Default::default()
        })
        .unwrap();
        store.db.execute_batch(include_str!("planner.sql")).unwrap();
        let transaction = store.db.unchecked_transaction().unwrap();
        let group = intern(&store, &(0..1200).collect::<Vec<_>>()).unwrap();
        for caller in 0..600 {
            store
                .execute(
                    "INSERT INTO sink_site VALUES(?,?,?,?,?)",
                    params![caller, 0, 0, false, group],
                )
                .unwrap();
            store
                .execute(
                    "INSERT INTO sink_caller_group VALUES(?,?)",
                    params![caller, group],
                )
                .unwrap();
        }
        transaction.commit().unwrap();
        assert!(store.report().unwrap().database_bytes < 4 * 1024 * 1024);
        let count: usize = store
            .db
            .query_row("SELECT count(*) FROM sink_target", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 720_000);
        // Negative control: retaining those same logical edges separately at
        // every call site exhausts the unchanged database allowance.
        store
            .db
            .execute_batch(
                "CREATE TABLE expanded(caller,point,target,
            PRIMARY KEY(caller,point,target)) WITHOUT ROWID",
            )
            .unwrap();
        let error = store
            .db
            .execute(
                "INSERT INTO expanded SELECT caller,point,target FROM sink_target",
                [],
            )
            .unwrap_err();
        assert!(error.to_string().contains("full"), "{error:#}");
    }

    #[test]
    fn repeated_groups_share_disk_memberships_and_hash_collisions_remain_exact() {
        let store = FactsStore::empty(Default::default()).unwrap();
        store.db.execute_batch(include_str!("planner.sql")).unwrap();
        let targets: Vec<u32> = (0..1200).collect();
        let first = intern_with_digest(&store, &targets, b"collision").unwrap();
        for _ in 0..100 {
            assert_eq!(
                intern_with_digest(&store, &targets, b"collision").unwrap(),
                first
            );
        }
        let mut other = targets.clone();
        other[1199] = 2000;
        let second = intern_with_digest(&store, &other, b"collision").unwrap();
        assert_ne!(first, second);
        assert_eq!(
            intern_with_digest(&store, &other, b"collision").unwrap(),
            second
        );
        let count: usize = store
            .db
            .query_row("SELECT count(*) FROM sink_target_member", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 2400);
    }

    #[test]
    fn group_closure_matches_expanded_edges_through_cycles_and_external_dispatch() {
        let store = FactsStore::empty(Default::default()).unwrap();
        store.db.execute_batch(include_str!("planner.sql")).unwrap();
        let external = u32::MAX - 1;
        // Repeated sites, shared callers, recursion, an unrelated component
        // and an external-only path exercise both kinds of graph vertex.
        for (caller, targets) in [
            (1, vec![0, 2]),
            (2, vec![1]),
            (3, vec![0, 2]),
            (4, vec![5]),
            (5, vec![4]),
            (6, vec![external]),
        ] {
            let group = intern(&store, &targets).unwrap();
            for point in 0..100 {
                store
                    .execute(
                        "INSERT INTO sink_site VALUES(?,?,?,?,?)",
                        params![caller, point, point, false, group],
                    )
                    .unwrap();
            }
            store
                .execute(
                    "INSERT INTO sink_caller_group VALUES(?,?)",
                    params![caller, group],
                )
                .unwrap();
        }
        for external in [None, Some(external)] {
            let expected: BTreeSet<u32> = store
                .db
                .prepare(
                    "WITH RECURSIVE r(function) AS (
                  VALUES(?1) UNION SELECT ?2 WHERE ?2 IS NOT NULL
                  UNION SELECT t.caller FROM sink_target t JOIN r ON r.function=t.target)
                  SELECT function FROM r ORDER BY function",
                )
                .unwrap()
                .query_map(params![0, external], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            reaching(&store, 0, external).unwrap();
            let actual: BTreeSet<u32> = store
                .db
                .prepare("SELECT function FROM sink_reaching ORDER BY function")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            assert_eq!(actual, expected);
            assert!(actual.contains(&3));
            assert!(!actual.contains(&4));
            assert_eq!(actual.contains(&6), external.is_some());
            store.execute("DELETE FROM sink_reaching", []).unwrap();
        }
        let memberships: usize = store
            .db
            .query_row("SELECT count(*) FROM sink_target_member", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(memberships, 6);
    }
}
