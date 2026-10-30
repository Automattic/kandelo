use super::*;
use crate::IoBuffer;

struct CreatedSlot {
    ordinal: usize,
    virtual_index: u32,
    physical_index: u32,
    links: u32,
}

pub(super) struct PreparedRecoverySlots {
    created: IoBuffer<CreatedSlot>,
    retired: IoBuffer<u32>,
}

impl PreparedRecoverySlots {
    pub(super) fn new(state: &RootfsState, count: usize, replay: Option<&PreparedNamespaceReplay>) -> Result<Self, Errno> {
        let needed = count.saturating_sub(state.free_inodes.len());
        let mut retired = IoBuffer::try_with_capacity(needed.min(state.inodes.len()))?;
        if let Some(replay) = replay {
            for (index, inode) in state.inodes.iter().enumerate() {
                if retired.len() == needed { break; }
                if inode.as_ref().is_some_and(|inode| inode.open_count == 0 && inode.map_pins == 0)
                    && replay.links.get(index) == Some(&0) && Some(index as u32) != state.root
                {
                    retired.push(u32::try_from(index).map_err(|_| Errno::EIO)?);
                }
            }
        }
        let available = state.free_inodes.len().checked_add(retired.len()).ok_or(Errno::ENOMEM)?;
        let mut created = IoBuffer::try_with_capacity(count)?;
        for ordinal in 0..count {
            let virtual_index = if ordinal < state.free_inodes.len() {
                state.free_inodes[state.free_inodes.len() - 1 - ordinal]
            } else {
                u32::try_from(state.inodes.len() + ordinal - state.free_inodes.len()).map_err(|_| Errno::ENOMEM)?
            };
            let physical_index = if ordinal < retired.len() {
                retired[retired.len() - 1 - ordinal]
            } else if ordinal < available {
                state.free_inodes[available - 1 - ordinal]
            } else {
                u32::try_from(state.inodes.len() + ordinal - available).map_err(|_| Errno::ENOMEM)?
            };
            let links = *replay.and_then(|replay| replay.links.get(virtual_index as usize)).ok_or(Errno::EIO)?;
            created.push(CreatedSlot { ordinal, virtual_index, physical_index, links });
        }
        created.sort_unstable_by_key(|slot| slot.virtual_index);
        Ok(Self { created, retired })
    }

    pub(super) fn reserve(&self, state: &mut RootfsState) -> Result<(), Errno> {
        state.reserve_inode_slots(self.created.len().saturating_sub(self.retired.len()))
    }

    pub(super) fn physical_index(&self, virtual_index: u32) -> u32 {
        self.created.binary_search_by_key(&virtual_index, |slot| slot.virtual_index)
            .map_or(virtual_index, |position| self.created[position].physical_index)
    }

    pub(super) fn publish(mut self, state: &mut RootfsState, created: Vec<(u64, Inode)>, mut replay: Option<PreparedNamespaceReplay>) {
        assert_eq!(created.len(), self.created.len());
        if let Some(replay) = &mut replay {
            replay.remove_prepared_names(state);
            replay.changes.retain(|change| {
                let keep = self.retired.binary_search(&change.parent).is_err();
                if !keep { assert!(change.target.is_none() && change.prepared.is_none()); }
                keep
            });
            for change in &mut replay.changes {
                change.parent = self.physical_index(change.parent);
                change.target = change.target.map(|target| self.physical_index(target));
            }
            for slot in &self.created { replay.links[slot.virtual_index as usize] = 0; }
            for slot in &self.created { replay.links[slot.physical_index as usize] = slot.links; }
        }
        for &index in &self.retired {
            state.get_mut(index).expect("retiring recovery inode missing").nlink = 0;
            state.maybe_free(index);
            assert!(state.get(index).is_none());
        }
        self.created.sort_unstable_by_key(|slot| slot.ordinal);
        for ((ino, inode), slot) in created.into_iter().zip(self.created) {
            state.bump_next_ino(ino);
            assert_eq!(state.insert_prepared_inode(inode), slot.physical_index);
        }
        if let Some(replay) = replay { replay.publish(state); }
    }
}
