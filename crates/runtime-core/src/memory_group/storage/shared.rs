use super::*;
use crate::{memory::GroupSharedMapping, prepared_map::PreparedEntry};

pub(super) struct PreparedObject {
    pub pages: IoArc<SharedPages>,
    entry: Option<PreparedEntry<u64, SharedObject>>,
    image_entry: Option<PreparedEntry<u64, u8>>,
    owner_entry: Option<PreparedEntry<ImageKey, u8>>,
}
#[derive(Clone, Copy)]
pub(super) struct ObjectHold {
    pub id: u64,
    pub introduced: bool,
    pub attached: bool,
}

impl Storage {
    pub(super) fn prepare_object(
        &self,
        key: ImageKey,
        model: &GroupSharedMapping,
    ) -> Result<PreparedObject, Errno> {
        let image = self.images.get(&key).ok_or(Errno::ESRCH)?;
        if model.group() != self.backing.group.as_raw() || model.length() % PAGE as usize != 0 {
            return Err(Errno::EINVAL);
        }
        let id = model.id();
        let (pages, entry, has_owner) = if let Some(object) = self.objects.get(&id) {
            if !object.committed {
                return Err(Errno::EBUSY);
            }
            if object.pages.byte_length() != model.length() {
                return Err(Errno::EIO);
            }
            (object.pages.clone(), None, object.images.contains_key(&key))
        } else {
            let count = u32::try_from(model.length() / PAGE as usize).map_err(|_| Errno::ENOMEM)?;
            if count >= self.maximum_pages {
                return Err(Errno::ENOMEM);
            }
            let pages = SharedPages::prepare(self.backing, id, count)?;
            let entry = PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(
                id,
                SharedObject {
                    pages: pages.clone(),
                    images: PreparedMap::new(),
                    committed: false,
                },
            )?;
            (pages, Some(entry), false)
        };
        let image_entry = if image.objects.contains_key(&id) {
            None
        } else {
            Some(PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(id, 0)?)
        };
        let owner_entry = if has_owner {
            None
        } else {
            Some(PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(key, 0)?)
        };
        Ok(PreparedObject {
            pages,
            entry,
            image_entry,
            owner_entry,
        })
    }

    pub(super) fn publish_object(
        &mut self,
        key: ImageKey,
        preparation: PreparedObject,
    ) -> ObjectHold {
        let id = preparation.pages.object();
        let hold = ObjectHold {
            id,
            introduced: preparation.entry.is_some(),
            attached: preparation.image_entry.is_some(),
        };
        if let Some(entry) = preparation.entry {
            self.objects.publish_io(entry);
        }
        if let Some(entry) = preparation.owner_entry {
            self.objects.get_mut(&id).unwrap().images.publish_io(entry);
        }
        if let Some(entry) = preparation.image_entry {
            self.images.get_mut(&key).unwrap().objects.publish_io(entry);
        }
        hold
    }

    pub(super) fn detach_object(&mut self, key: ImageKey, hold: ObjectHold) {
        if hold.attached {
            self.images.get_mut(&key).unwrap().objects.remove(&hold.id);
            self.objects.get_mut(&hold.id).unwrap().images.remove(&key);
        }
        if hold.introduced {
            self.objects.remove(&hold.id);
        }
    }

    pub(super) fn object_pages(&self, id: u64) -> Result<&IoArc<SharedPages>, Errno> {
        self.objects
            .get(&id)
            .map(|object| &object.pages)
            .ok_or(Errno::ESRCH)
    }

    pub(crate) fn sweep_objects(&mut self, memory: &mut impl PhysicalMemory) -> Result<u32, Errno> {
        let mut released = 0;
        loop {
            // No strong model-object reference is kept here. The last inode
            // or VMA may disappear independently; its page binding supplies
            // the physical lifetime until this sole manager hold remains.
            let candidate = self.objects.iter().find_map(|(id, object)| {
                (object.committed && object.images.is_empty() && object.pages.strong_count() == 1)
                    .then_some(*id)
            });
            let Some(id) = candidate else {
                break;
            };
            let object = self.objects.get(&id).unwrap();
            let mut targets = [false; layout::MAXIMUM_PAGES as usize];
            for at in 0..object.pages.byte_length() / PAGE as usize {
                targets[object.pages.page(at)? as usize] = true;
            }
            let mut pinned = false;
            crate::memory_group::wait_queue::visit_pins(memory, |_, _, address| {
                if object.pages.contains(address / PAGE) {
                    pinned = true;
                }
            })?;
            if pinned
                || self
                    .pins
                    .values()
                    .any(|pin| object.pages.contains(pin.address / PAGE))
            {
                return Err(Errno::EAGAIN);
            }
            let pages = object.pages.byte_length() / PAGE as usize;
            object.pages.retire_memory(
                self.pool.as_mut().ok_or(Errno::EAGAIN)?,
                memory,
                |memory| {
                    let mut pinned = false;
                    crate::memory_group::wait_queue::visit_pins(memory, |_, _, address| {
                        if targets.get((address / PAGE) as usize) == Some(&true) {
                            pinned = true;
                        }
                    })?;
                    Ok(!pinned)
                },
            )?;
            self.objects.remove(&id);
            released += pages as u32;
        }
        Ok(released)
    }
}
