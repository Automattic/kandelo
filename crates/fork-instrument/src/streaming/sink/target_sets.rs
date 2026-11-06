//! Share exact target sets while retaining each original call site's union.

use std::{collections::BTreeMap, sync::Arc};

use anyhow::{Result, ensure};

#[derive(Default)]
pub(super) struct TargetSets {
    references: BTreeMap<Arc<[u32]>, usize>,
    memberships: usize,
}

impl TargetSets {
    pub fn record(
        &mut self,
        sites: &mut BTreeMap<usize, Arc<[u32]>>,
        instruction: usize,
        mut incoming: Vec<u32>,
        limit: usize,
    ) -> Result<()> {
        let previous = sites.get(&instruction);
        if let Some(previous) = previous {
            incoming.extend_from_slice(previous);
        }
        incoming.sort_unstable();
        incoming.dedup();
        if previous.is_some_and(|old| old.as_ref() == incoming) {
            return Ok(());
        }

        let shared = self
            .references
            .get_key_value(incoming.as_slice())
            .map(|(set, _)| Arc::clone(set));
        let released = previous.map_or(0, |set| {
            if self.references[set] == 1 {
                set.len()
            } else {
                0
            }
        });
        let added = if shared.is_some() { 0 } else { incoming.len() };
        let next = self.memberships - released + added;
        ensure!(
            next <= limit,
            "sink interpretation exceeds call-target budget"
        );

        // WHY: remove superseded unions when their last site changes. Keeping
        // every intermediate loop union would make storage grow with revisits.
        if let Some(previous) = previous {
            let count = self.references.get_mut(previous).unwrap();
            *count -= 1;
            if *count == 0 {
                self.references.remove(previous);
            }
        }
        let set = shared.unwrap_or_else(|| Arc::from(incoming));
        *self.references.entry(Arc::clone(&set)).or_default() += 1;
        sites.insert(instruction, set);
        self.memberships = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_sites_share_storage_without_sharing_their_future_unions() {
        let mut pool = TargetSets::default();
        let mut sites = BTreeMap::new();
        for site in 0..100 {
            pool.record(&mut sites, site, vec![2, 1, 2], 5).unwrap();
        }
        assert_eq!(pool.memberships, 2);
        assert!(Arc::ptr_eq(&sites[&0], &sites[&99]));
        pool.record(&mut sites, 0, vec![3], 5).unwrap();
        assert_eq!(sites[&0].as_ref(), &[1, 2, 3]);
        assert_eq!(sites[&1].as_ref(), &[1, 2]);
        assert_eq!(pool.memberships, 5);
        for site in 1..100 {
            pool.record(&mut sites, site, vec![3], 5).unwrap();
        }
        assert_eq!(pool.memberships, 3);
        assert_eq!(pool.references.len(), 1);
    }

    #[test]
    fn failed_growth_preserves_the_old_sets_and_accounting() {
        let mut pool = TargetSets::default();
        let mut sites = BTreeMap::new();
        pool.record(&mut sites, 0, vec![1, 2], 2).unwrap();
        pool.record(&mut sites, 1, vec![1, 2], 2).unwrap();
        assert!(pool.record(&mut sites, 0, vec![3], 4).is_err());
        assert_eq!(sites[&0].as_ref(), &[1, 2]);
        assert_eq!(pool.memberships, 2);
        assert_eq!(pool.references.values().copied().sum::<usize>(), 2);
        // A sole site's old union can be reclaimed before charging its new one.
        let mut sole = BTreeMap::new();
        let mut pool = TargetSets::default();
        pool.record(&mut sole, 0, vec![1, 2], 2).unwrap();
        pool.record(&mut sole, 0, vec![3], 3).unwrap();
        assert_eq!(pool.memberships, 3);
    }
}
