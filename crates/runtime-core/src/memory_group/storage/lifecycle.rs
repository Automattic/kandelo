use super::*;
use crate::memory_group::wait_queue;

impl Storage {
    pub(super) fn control(
        &self,
        memory: &impl PhysicalMemory,
        admission: GroupAdmission,
    ) -> Result<(ImageKey, u32, u32), Errno> {
        let replica = self.owned(admission)?;
        let image = self.images.get(&replica.image).ok_or(Errno::ESRCH)?;
        let root = image.allocation.ok_or(Errno::EIO)?.controls.address();
        let control = replica.scratch.ok_or(Errno::EIO)?.address();
        let mut bytes = [0; layout::REPLICA_BYTES as usize];
        memory.read(control, &mut bytes)?;
        let word = |offset: u32| {
            u32::from_le_bytes(
                bytes[offset as usize..offset as usize + 4]
                    .try_into()
                    .unwrap(),
            )
        };
        let wide = |offset: u32| {
            u64::from_le_bytes(
                bytes[offset as usize..offset as usize + 8]
                    .try_into()
                    .unwrap(),
            )
        };
        let receipt = admission.record();
        if word(layout::REPLICA_MAGIC_OFFSET) != layout::REPLICA_MAGIC
            || word(layout::REPLICA_ROOT) != root
            || word(layout::REPLICA_PID) != receipt.pid
            || word(layout::REPLICA_TID) != receipt.tid
            || word(layout::REPLICA_GROUP) != receipt.group
            || wide(layout::REPLICA_SERIAL) != receipt.serial
            || wide(layout::REPLICA_GENERATION) != receipt.generation
        {
            return Err(Errno::EIO);
        }
        Ok((replica.image, root, control))
    }

    pub(crate) fn begin_image_pause(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
    ) -> Result<u32, Errno> {
        let key = self.owned(admission)?.image;
        let image = self.images.get(&key).ok_or(Errno::ESRCH)?;
        if self.poisoned
            || !image.source_live
            || !image.exposed
            || image.stopping
            || image.pause.is_some()
            || image.replicas.is_empty()
        {
            return Err(Errno::EBUSY);
        }
        let epoch = u32::try_from(self.next_epoch).map_err(|_| Errno::EOVERFLOW)?;
        // Validate every member before freezing membership or requesting any
        // checkpoint. A prepared thread cannot be silently omitted.
        for (serial, _) in image.replicas.iter() {
            let member = self.replicas.get(serial).ok_or(Errno::EIO)?;
            let (_, _, control) = self.control(memory, member.admission)?;
            if member.exposure != Exposure::Exposed
                || member.pause.is_some()
                || memory.atomic_load(control + layout::REPLICA_RUN)? != 1
            {
                return Err(Errno::EBUSY);
            }
        }
        self.next_epoch += 1;
        self.images.get_mut(&key).unwrap().pause = Some(epoch);
        let result = self.replicas.try_for_each_mut_entry(|_, member| {
            if member.image != key || member.exposure == Exposure::Stopped {
                return Ok(());
            }
            member.pause = Some(epoch);
            memory.atomic_store(
                member.scratch.ok_or(Errno::EIO)?.address() + layout::REPLICA_REQUEST,
                epoch,
            )?;
            Ok(())
        });
        if let Err(error) = result {
            self.contain_image(memory, key);
            return Err(error);
        }
        Ok(epoch)
    }

    pub(crate) fn image_pause_acknowledged(
        &self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
        epoch: u32,
    ) -> Result<bool, Errno> {
        let key = self.owned(admission)?.image;
        let image = self.images.get(&key).ok_or(Errno::ESRCH)?;
        if self.poisoned || !image.source_live || image.pause != Some(epoch) {
            return Ok(false);
        }
        let mut acknowledged = true;
        for (serial, _) in image.replicas.iter() {
            let member = self.replicas.get(serial).ok_or(Errno::EIO)?;
            let (_, root, control) = self.control(memory, member.admission)?;
            if member.exposure != Exposure::Exposed
                || member.pause != Some(epoch)
                || memory.atomic_load(control + layout::REPLICA_RUN)? != 1
            {
                return Ok(false);
            }
            if memory.atomic_load(control + layout::REPLICA_REQUEST)? != epoch {
                return Err(Errno::EIO);
            }
            match wait_queue::pause(memory, root, control, epoch) {
                Ok(()) | Err(Errno::EAGAIN) => {}
                Err(error) => return Err(error),
            }
            acknowledged &= memory.atomic_load(control + layout::REPLICA_ACK)? == epoch;
        }
        Ok(acknowledged)
    }

    pub(crate) fn resume_image(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
        epoch: u32,
    ) -> Result<(), Errno> {
        let key = self.owned(admission)?.image;
        if self.images.get(&key).ok_or(Errno::ESRCH)?.pause != Some(epoch) {
            return Err(Errno::ESRCH);
        }
        if self.images.get(&key).unwrap().mapping.is_some() {
            return Err(Errno::EBUSY);
        }
        let result = self.replicas.try_for_each_mut_entry(|_, member| {
            if member.image != key
                || member.exposure == Exposure::Stopped
                || member.pause != Some(epoch)
            {
                return Ok(());
            }
            let control = member.scratch.ok_or(Errno::EIO)?.address();
            if memory.atomic_load(control + layout::REPLICA_REQUEST)? != epoch {
                return Err(Errno::EIO);
            }
            memory.atomic_store(control + layout::REPLICA_REQUEST, 0)?;
            memory.atomic_notify(control + layout::REPLICA_REQUEST, u32::MAX)?;
            member.pause = None;
            Ok(())
        });
        if let Err(error) = result {
            self.contain_image(memory, key);
            return Err(error);
        }
        self.images.get_mut(&key).unwrap().pause = None;
        Ok(())
    }

    pub(crate) fn request_stop(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
    ) -> Result<(), Errno> {
        let (_, root, control) = self.control(memory, admission)?;
        let result = wait_queue::stop(memory, root, control);
        let member = self.replicas.get_mut(&admission.record().serial).unwrap();
        member.pause = None;
        member.pending_wait_drain = result.is_err();
        result
    }

    pub(crate) fn request_image_stop(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
        natural_exit_tid: Option<u32>,
    ) -> Result<(), Errno> {
        let key = self.owned(admission)?.image;
        if admission.record().pid != admission.record().tid {
            return Err(Errno::EINVAL);
        }
        self.images.get_mut(&key).unwrap().stopping = true;
        self.images.get_mut(&key).unwrap().pause = None;
        let mut pending = false;
        // No allocation is necessary while stopping a group under pressure.
        self.replicas.try_for_each_mut_entry(|_, member| {
            if member.image != key
                || Some(member.admission.record().tid) == natural_exit_tid
                || member.exposure == Exposure::Stopped && !member.pending_wait_drain
            {
                return Ok(());
            }
            let root = self
                .images
                .get(&key)
                .unwrap()
                .allocation
                .ok_or(Errno::EIO)?
                .controls
                .address();
            let control = member.scratch.ok_or(Errno::EIO)?.address();
            let result = wait_queue::stop(memory, root, control);
            member.pause = None;
            member.pending_wait_drain = result.is_err();
            match result {
                Ok(()) => {}
                Err(Errno::EAGAIN) => pending = true,
                Err(error) => return Err(error),
            }
            Ok(())
        })?;
        if pending {
            Err(Errno::EAGAIN)
        } else {
            Ok(())
        }
    }

    /// This call is made only from the exact platform Worker completion path.
    /// A stop request, timeout or browser terminate() is insufficient evidence.
    pub(crate) fn note_quiescent(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
    ) -> Result<(), Errno> {
        let (key, _, control) = self.control(memory, admission)?;
        let member = self.replicas.get_mut(&admission.record().serial).unwrap();
        if !matches!(member.exposure, Exposure::Exposed | Exposure::Quarantined) {
            return Err(Errno::ESRCH);
        }
        member.exposure = Exposure::Stopped;
        member.pause = None;
        self.images
            .get_mut(&key)
            .unwrap()
            .replicas
            .remove(&admission.record().serial);
        memory.atomic_notify(control + layout::REPLICA_ACK, u32::MAX)?;
        Ok(())
    }

    pub(crate) fn revoke_source(
        &mut self,
        memory: &mut impl PhysicalMemory,
        admission: GroupAdmission,
    ) -> Result<(), Errno> {
        let (key, root, _) = self.control(memory, admission)?;
        self.images.get_mut(&key).unwrap().source_live = false;
        memory.atomic_store(root + layout::ROOT_RUN, 0)?;
        memory.atomic_notify(root + layout::ROOT_RUN, u32::MAX)?;
        Ok(())
    }

    pub(super) fn contain_image(&mut self, memory: &mut impl PhysicalMemory, key: ImageKey) {
        if let Some(image) = self.images.get_mut(&key) {
            image.source_live = false;
            image.stopping = true;
            image.pause = None;
            if let Some(allocation) = image.allocation {
                let _ = memory.atomic_store(allocation.controls.address() + layout::ROOT_RUN, 0);
            }
        }
        let _ = self.replicas.try_for_each_mut_entry(|_, member| {
            if member.image != key || member.exposure == Exposure::Stopped {
                return Ok(());
            }
            member.exposure = Exposure::Quarantined;
            member.pause = None;
            if let Some(scratch) = member.scratch {
                let _ = memory.atomic_store(scratch.address() + layout::REPLICA_RUN, 0);
            }
            member.pending_wait_drain = true;
            Ok(())
        });
    }

    pub(crate) fn pin_native_observation(
        &mut self,
        memory: &impl PhysicalMemory,
        admission: GroupAdmission,
        address: u32,
    ) -> Result<u64, Errno> {
        let member = self.owned(admission)?;
        let image = self.images.get(&member.image).ok_or(Errno::ESRCH)?;
        if !image.source_live
            || self.poisoned
            || !image.exposed
            || !matches!(member.exposure, Exposure::Exposed | Exposure::Stopped)
            || address % 4 != 0
            || address / PAGE >= self.maximum_pages
            || u64::from(address) + 4 > u64::from(memory.current_pages()?) * u64::from(PAGE)
        {
            return Err(Errno::ESRCH);
        }
        self.insert_native_pin(admission, address)
    }

    pub(super) fn insert_native_pin(
        &mut self,
        admission: GroupAdmission,
        address: u32,
    ) -> Result<u64, Errno> {
        let image = self.owned(admission)?.image;
        let token = self.next_pin;
        let next = token.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        let entry = PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(
            token,
            NativePin {
                image,
                address,
                serial: admission.record().serial,
            },
        )?;
        self.pins.publish_io(entry);
        self.next_pin = next;
        Ok(token)
    }

    /// Only actual native Promise settlement (or synchronous wait completion)
    /// ends a host observation. Waking the target does not consume this token.
    pub(crate) fn settle_native_observation(
        &mut self,
        admission: GroupAdmission,
        token: u64,
    ) -> Result<(), Errno> {
        if self
            .pins
            .get(&token)
            .is_none_or(|pin| pin.serial != admission.record().serial)
        {
            return Err(Errno::ESRCH);
        }
        self.pins.remove(&token).map(|_| ()).ok_or(Errno::ESRCH)
    }
}
