//! Kernel custody of grouped images and execution replicas.
//!
//! These records complement the task-admission ledger: sending a memory to a
//! Worker consumes unpublished rollback even before guest execution starts.
//! Native stop observations are separate from admission and page ownership.

use super::object::SharedPages;
use super::physical::{Extent, ImageAllocation, PagePool, PhysicalMemory};
use super::{GroupAdmission, GroupBackingLease, ImageKey};
use crate::io_owner::IoArc;
use crate::{
    io_buffer::IO_MEMORY,
    prepared_map::{MapMemory, PreparedMap, PreparedMapSlot},
    IoBuffer,
};
use wasm_posix_shared::{program_extensions::memory_group_v3 as layout, Errno};

const PAGE: u32 = layout::PAGE_BYTES;
mod fork;
mod lifecycle;
#[cfg(test)]
#[path = "storage/tests.rs"]
mod lifecycle_tests;
mod mapping;
mod retirement;
mod shared;
mod thread;
mod reclaim;
mod progress;
mod inspection;
mod operation;
#[cfg(test)]
mod contract_tests;
pub(crate) use progress::ProgressTarget;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ImageLayout {
    pub initial_pages: u32,
    pub maximum_pages: u32,
    pub scratch_bytes: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReplicaDescriptor {
    pub receipt: wasm_posix_shared::memory_group::ReceiptRecord,
    pub resource: u64,
    pub root: u32,
    pub replica: u32,
    pub scratch: u32,
    pub maximum_physical_pages: u32,
    pub maximum_virtual_pages: u32,
    pub scratch_bytes: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProgressWait {
    pub token: u64,
    pub address: u32,
    pub expected: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Exposure {
    Prepared,
    Exposed,
    Quarantined,
    Stopped,
}

struct Image {
    layout: ImageLayout,
    allocation: Option<ImageAllocation>,
    payload: IoBuffer<u32>,
    replicas: PreparedMap<u64, u8>,
    exposed: bool,
    source_live: bool,
    stopping: bool,
    pause: Option<u32>,
    mapping: Option<crate::IoBox<mapping::Mapping>>,
    objects: PreparedMap<u64, u8>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum References { Unbound, Bound, Detaching, Detached }
struct Replica {
    admission: GroupAdmission,
    image: ImageKey,
    scratch: Option<Extent>,
    exposure: Exposure,
    pause: Option<u32>,
    pending_wait_drain: bool,
    worker_absent: bool,
    references: References,
    native_join: bool,
    worker_fact: u32,
}
struct NativePin {
    image: ImageKey,
    address: u32,
    serial: u64,
}
struct SharedObject {
    pages: IoArc<SharedPages>,
    images: PreparedMap<ImageKey, u8>,
    committed: bool,
}
impl MapMemory for SharedObject {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}
impl MapMemory for NativePin {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}
impl MapMemory for Image {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}
impl MapMemory for Replica {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}

pub(crate) struct Storage {
    backing: GroupBackingLease,
    maximum_pages: u32,
    pool: Option<PagePool>,
    images: PreparedMap<ImageKey, Image>,
    replicas: PreparedMap<u64, Replica>,
    poisoned: bool,
    next_epoch: u64,
    next_pin: u64,
    pins: PreparedMap<u64, NativePin>,
    objects: PreparedMap<u64, SharedObject>,
    operations: PreparedMap<u64, operation::ImageOperation>,
    next_operation: u64,
}

impl Storage {
    pub(crate) fn resource(&self) -> u64 {
        self.backing.serial
    }
    pub(crate) fn backing(&self) -> GroupBackingLease {
        self.backing
    }
    pub(crate) fn resolve(
        &self,
        record: wasm_posix_shared::memory_group::ReceiptRecord,
    ) -> Result<GroupAdmission, Errno> {
        let admission = self
            .replicas
            .get(&record.serial)
            .ok_or(Errno::ESRCH)?
            .admission;
        if admission.record() != record {
            return Err(Errno::ESRCH);
        }
        Ok(admission)
    }
    pub(crate) fn root_for_image(
        &self,
        record: wasm_posix_shared::memory_group::ReceiptRecord,
    ) -> Result<GroupAdmission, Errno> {
        let key = ImageKey {
            pid: record.pid,
            generation: record.generation,
        };
        let admission = self
            .replicas
            .values()
            .find_map(|replica| {
                (replica.image == key
                    && replica.admission.record().pid == replica.admission.record().tid)
                    .then_some(replica.admission)
            })
            .ok_or(Errno::ESRCH)?;
        self.owned(admission)?;
        Ok(admission)
    }

    /// Construct/admit this owner before the platform creates its resource.
    pub(crate) fn prepare(backing: GroupBackingLease, maximum_pages: u32) -> Result<Self, Errno> {
        if !(2..=layout::MAXIMUM_PAGES).contains(&maximum_pages) {
            return Err(Errno::EINVAL);
        }
        Ok(Self {
            backing,
            maximum_pages,
            pool: None,
            images: PreparedMap::new(),
            replicas: PreparedMap::new(),
            poisoned: false,
            next_epoch: 1,
            next_pin: 1,
            pins: PreparedMap::new(),
            objects: PreparedMap::new(),
            operations: PreparedMap::new(),
            next_operation: 1,
        })
    }

    pub(crate) fn initialize(&mut self, memory: &mut impl PhysicalMemory) -> Result<(), Errno> {
        if self.pool.is_some() || self.poisoned {
            return Err(Errno::EALREADY);
        }
        match PagePool::initialize(memory, self.maximum_pages) {
            Ok(pool) => {
                self.pool = Some(pool);
                Ok(())
            }
            Err(error) => {
                self.poisoned = true;
                Err(error)
            }
        }
    }

    fn pool(&mut self) -> Result<&mut PagePool, Errno> {
        if self.poisoned || self.pool.as_ref().is_some_and(PagePool::is_poisoned) {
            return Err(Errno::EIO);
        }
        self.pool.as_mut().ok_or(Errno::EAGAIN)
    }
    fn check_new(&self, admission: GroupAdmission) -> Result<(), Errno> {
        let receipt = admission.record();
        if admission.group() != self.backing.group
            || receipt.pid <= 1
            || receipt.tid <= 1
            || self.replicas.contains_key(&receipt.serial)
        {
            return Err(Errno::ESRCH);
        }
        if self.poisoned || self.pool.as_ref().is_some_and(PagePool::is_poisoned) {
            return Err(Errno::EIO);
        }
        Ok(())
    }

    pub(crate) fn prepare_image(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
        requested: ImageLayout,
    ) -> Result<u64, Errno> {
        self.check_new(admission)?;
        let receipt = admission.record();
        let key = ImageKey {
            pid: receipt.pid,
            generation: receipt.generation,
        };
        if receipt.pid != receipt.tid
            || self.images.contains_key(&key)
            || requested.maximum_pages == 0
            || requested.maximum_pages > 65536
            || requested.initial_pages > requested.maximum_pages
            || requested.scratch_bytes < PAGE
            || requested.scratch_bytes % PAGE != 0
        {
            return Err(Errno::EINVAL);
        }
        let controls = (u64::from(layout::ROOT_HEADER_BYTES)
            + u64::from(requested.maximum_pages) * 4)
            .div_ceil(u64::from(PAGE)) as u32;
        let scratch = (u64::from(layout::REPLICA_BYTES) + u64::from(requested.scratch_bytes))
            .div_ceil(u64::from(PAGE)) as u32;
        if u64::from(controls) + u64::from(scratch) + u64::from(requested.initial_pages)
            >= u64::from(self.maximum_pages)
        {
            return Err(Errno::ENOMEM);
        }
        let mut image = Image {
            layout: requested,
            allocation: None,
            payload: IoBuffer::try_filled(requested.initial_pages as usize, 0)?,
            replicas: PreparedMap::new(),
            exposed: false,
            source_live: true,
            stopping: false,
            pause: None,
            mapping: None,
            objects: PreparedMap::new(),
        };
        image
            .replicas
            .publish_io(PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(receipt.serial, 0)?);
        let mut image_entry = PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(key, image)?;
        let mut replica_entry = PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(
            receipt.serial,
            Replica {
                admission,
                image: key,
                scratch: None,
                exposure: Exposure::Prepared,
                pause: None,
                pending_wait_drain: false,
                worker_absent: false,
                references: References::Unbound,
                native_join: false,
                worker_fact: 0,
            },
        )?;
        // All metadata custody precedes the one physical reservation. Busy and
        // exhausted outcomes have no frames and can drop these preparations.
        let allocation = self.pool()?.allocate_image(
            memory,
            controls,
            scratch,
            &mut image_entry.value_mut().payload,
        )?;
        image_entry.value_mut().allocation = Some(allocation);
        replica_entry.value_mut().scratch = Some(allocation.scratch);
        let initialized = initialize_image(memory, image_entry.value()).and_then(|()| {
            initialize_replica(memory, replica_entry.value(), allocation.controls.address())
        });
        if initialized.is_err() {
            // A failed platform write cannot erase the newly allocated frame
            // owner. Keep it charged/contained for explicit kernel cleanup.
            self.poisoned = true;
            replica_entry.value_mut().exposure = Exposure::Quarantined;
            image_entry.value_mut().source_live = false;
        }
        self.images.publish_io(image_entry);
        self.replicas.publish_io(replica_entry);
        initialized?;
        Ok(receipt.serial)
    }

    pub(crate) fn prepare_thread(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
    ) -> Result<u64, Errno> {
        self.check_new(admission)?;
        let receipt = admission.record();
        let key = ImageKey {
            pid: receipt.pid,
            generation: receipt.generation,
        };
        let image = self.images.get(&key).ok_or(Errno::ESRCH)?;
        if receipt.pid == receipt.tid
            || !image.source_live
            || image.stopping
            || image.pause.is_some()
        {
            return Err(Errno::ESRCH);
        }
        let root = image.allocation.ok_or(Errno::EIO)?.controls.address();
        let pages = (u64::from(layout::REPLICA_BYTES) + u64::from(image.layout.scratch_bytes))
            .div_ceil(u64::from(PAGE)) as u32;
        let member = PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(receipt.serial, 0)?;
        let mut entry = PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(
            receipt.serial,
            Replica {
                admission,
                image: key,
                scratch: None,
                exposure: Exposure::Prepared,
                pause: None,
                pending_wait_drain: false,
                worker_absent: false,
                references: References::Unbound,
                native_join: false,
                worker_fact: 0,
            },
        )?;
        entry.value_mut().scratch = Some(self.pool()?.allocate_contiguous(memory, pages)?);
        let initialized = initialize_replica(memory, entry.value(), root);
        if initialized.is_err() {
            self.poisoned = true;
            entry.value_mut().exposure = Exposure::Quarantined;
        }
        self.images
            .get_mut(&key)
            .expect("prepared image vanished")
            .replicas
            .publish_io(member);
        self.replicas.publish_io(entry);
        initialized?;
        Ok(receipt.serial)
    }

    fn owned(&self, admission: GroupAdmission) -> Result<&Replica, Errno> {
        if self.poisoned || self.pool.as_ref().is_some_and(PagePool::is_poisoned) {
            return Err(Errno::EIO);
        }
        let replica = self
            .replicas
            .get(&admission.record().serial)
            .ok_or(Errno::ESRCH)?;
        if replica.admission != admission {
            return Err(Errno::ESRCH);
        }
        Ok(replica)
    }

    pub(crate) fn descriptor(&self, admission: GroupAdmission) -> Result<ReplicaDescriptor, Errno> {
        let replica = self.owned(admission)?;
        let image = self.images.get(&replica.image).ok_or(Errno::ESRCH)?;
        if self.poisoned || !image.source_live || replica.exposure == Exposure::Quarantined {
            return Err(Errno::EIO);
        }
        let scratch = replica.scratch.ok_or(Errno::EAGAIN)?.address();
        Ok(ReplicaDescriptor {
            receipt: admission.record(),
            resource: self.backing.serial,
            root: image.allocation.ok_or(Errno::EAGAIN)?.controls.address(),
            replica: scratch,
            scratch: scratch + layout::REPLICA_BYTES,
            maximum_physical_pages: self.maximum_pages,
            maximum_virtual_pages: image.layout.maximum_pages,
            scratch_bytes: image.layout.scratch_bytes,
        })
    }

    /// Called only after the admission ledger accepts Start for this receipt.
    /// This transition ends unpublished rollback before a Memory leaves Rust.
    pub(crate) fn publish(
        &mut self,
        admission: GroupAdmission,
    ) -> Result<ReplicaDescriptor, Errno> {
        let descriptor = self.descriptor(admission)?;
        let replica = self.owned(admission)?;
        let key = replica.image;
        if replica.exposure != Exposure::Prepared
            || self.images.get(&key).is_none_or(|image| image.stopping)
        {
            return Err(Errno::ESRCH);
        }
        self.replicas
            .get_mut(&admission.record().serial)
            .unwrap()
            .exposure = Exposure::Exposed;
        self.images.get_mut(&key).unwrap().exposed = true;
        Ok(descriptor)
    }

    pub(crate) fn cancel_unpublished(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
    ) -> Result<(), Errno> {
        let replica = self.owned(admission)?;
        let key = replica.image;
        let image = self.images.get(&key).ok_or(Errno::ESRCH)?;
        if self.poisoned || replica.exposure != Exposure::Prepared {
            return Err(Errno::EBUSY);
        }
        let root = admission.record().pid == admission.record().tid;
        if root && self.image_has_operations(key) { return Err(Errno::EAGAIN); }
        if root && (image.exposed || image.replicas.len() != 1) {
            return Err(Errno::EBUSY);
        }
        let controls = image.allocation.ok_or(Errno::EIO)?.controls;
        let scratch = replica.scratch.ok_or(Errno::EIO)?;
        let length = if root {
            image.payload.len() + controls.pages as usize
        } else {
            0
        } + scratch.pages as usize;
        let mut pages = IoBuffer::try_with_capacity(length)?;
        if root {
            pages.extend_from_slice(&image.payload);
            for page in controls.first..controls.first + controls.pages {
                pages.push(page);
            }
        }
        for page in scratch.first..scratch.first + scratch.pages {
            pages.push(page);
        }
        pages.sort_unstable();
        if self
            .pins
            .values()
            .any(|pin| pages.binary_search(&(pin.address / PAGE)).is_ok())
        {
            return Err(Errno::EAGAIN);
        }
        self.pool()?.release_checked(memory, &pages, |_| Ok(true))?;
        self.replicas.remove(&admission.record().serial);
        if root {
            for id in self.images.get(&key).unwrap().objects.keys() {
                self.objects
                    .get_mut(id)
                    .ok_or(Errno::EIO)?
                    .images
                    .remove(&key);
            }
            self.images.remove(&key);
        } else {
            self.images
                .get_mut(&key)
                .unwrap()
                .replicas
                .remove(&admission.record().serial);
        }
        Ok(())
    }

    pub(crate) fn empty(&self) -> bool {
        self.images.is_empty()
            && self.replicas.is_empty()
            && self.pins.is_empty()
            && self.objects.is_empty()
    }
}

fn initialize_image(memory: &mut impl PhysicalMemory, image: &Image) -> Result<(), Errno> {
    let root = image.allocation.ok_or(Errno::EIO)?.controls.address();
    memory.write(root + 4, &image.layout.maximum_pages.to_le_bytes())?;
    memory.write(root + 8, &image.layout.scratch_bytes.to_le_bytes())?;
    memory.write(root + layout::ROOT_RUN, &1u32.to_le_bytes())?;
    let mut bytes = [0; 4096];
    for (chunk, entries) in image.payload.chunks(bytes.len() / 4).enumerate() {
        for (at, physical) in entries.iter().enumerate() {
            bytes[at * 4..at * 4 + 4].copy_from_slice(&(physical * PAGE | 3).to_le_bytes());
        }
        memory.write(
            root + layout::ROOT_HEADER_BYTES + (chunk * bytes.len()) as u32,
            &bytes[..entries.len() * 4],
        )?;
    }
    memory.atomic_store(root, image.layout.initial_pages)
}
fn initialize_replica(
    memory: &mut impl PhysicalMemory,
    replica: &Replica,
    root: u32,
) -> Result<(), Errno> {
    let address = replica.scratch.ok_or(Errno::EIO)?.address();
    let receipt = replica.admission.record();
    let mut bytes = [0; layout::REPLICA_BYTES as usize];
    let word = |bytes: &mut [u8], at: u32, value: u32| {
        bytes[at as usize..at as usize + 4].copy_from_slice(&value.to_le_bytes())
    };
    word(&mut bytes, layout::REPLICA_RUN, 1);
    word(&mut bytes, layout::REPLICA_ROOT, root);
    word(
        &mut bytes,
        layout::REPLICA_MAGIC_OFFSET,
        layout::REPLICA_MAGIC,
    );
    word(&mut bytes, layout::REPLICA_PID, receipt.pid);
    word(&mut bytes, layout::REPLICA_TID, receipt.tid);
    word(&mut bytes, layout::REPLICA_GROUP, receipt.group);
    bytes[layout::REPLICA_SERIAL as usize..layout::REPLICA_SERIAL as usize + 8]
        .copy_from_slice(&receipt.serial.to_le_bytes());
    bytes[layout::REPLICA_GENERATION as usize..layout::REPLICA_GENERATION as usize + 8]
        .copy_from_slice(&receipt.generation.to_le_bytes());
    memory.write(address, &bytes)
}

#[cfg(test)]
mod tests {
    use super::super::{physical::tests::Memory, MemoryGroupLimits, MemoryGroups};
    use super::*;

    #[test]
    fn a_kernel_receipt_owns_one_root_and_unpublished_rollback_is_exact() {
        let mut groups = MemoryGroups::new();
        groups.configure(32, 1).unwrap();
        let group = groups
            .create(MemoryGroupLimits {
                maximum_pages: 32,
                maximum_processes: 8,
                maximum_tasks: 16,
            })
            .unwrap();
        let backing = groups.retain_backing(group).unwrap();
        let mut memory = Memory::new(32);
        let mut storage = Storage::prepare(backing, 32).unwrap();
        storage.initialize(&mut memory).unwrap();
        let receipt = groups.prepare_image(group, 100, 1).unwrap();
        let image = ImageLayout {
            initial_pages: 2,
            maximum_pages: 32,
            scratch_bytes: PAGE,
        };
        storage.prepare_image(&mut memory, receipt, image).unwrap();
        assert_eq!(
            storage.prepare_image(&mut memory, receipt, image),
            Err(Errno::ESRCH)
        );
        let descriptor = storage.descriptor(receipt).unwrap();
        assert_eq!(descriptor.receipt, receipt.record());
        assert_eq!(memory.atomic_load(descriptor.root).unwrap(), 2);
        storage.cancel_unpublished(&mut memory, receipt).unwrap();
        assert!(storage.empty());
        assert_eq!(
            storage
                .pool()
                .unwrap()
                .snapshot(&mut memory)
                .unwrap()
                .allocated_pages,
            1
        );
        assert_eq!(
            storage.cancel_unpublished(&mut memory, receipt),
            Err(Errno::ESRCH)
        );
    }

    #[test]
    fn exposing_memory_revokes_unpublished_rollback_before_worker_construction() {
        let mut groups = MemoryGroups::new();
        groups.configure(32, 1).unwrap();
        let group = groups
            .create(MemoryGroupLimits {
                maximum_pages: 32,
                maximum_processes: 8,
                maximum_tasks: 16,
            })
            .unwrap();
        let mut memory = Memory::new(32);
        let mut storage = Storage::prepare(groups.retain_backing(group).unwrap(), 32).unwrap();
        storage.initialize(&mut memory).unwrap();
        let receipt = groups.prepare_image(group, 100, 1).unwrap();
        storage
            .prepare_image(
                &mut memory,
                receipt,
                ImageLayout {
                    initial_pages: 2,
                    maximum_pages: 32,
                    scratch_bytes: PAGE,
                },
            )
            .unwrap();
        groups.start(receipt).unwrap();
        storage.publish(receipt).unwrap();
        assert_eq!(
            storage.cancel_unpublished(&mut memory, receipt),
            Err(Errno::EBUSY)
        );
        assert_eq!(storage.publish(receipt), Err(Errno::ESRCH));
    }
}
