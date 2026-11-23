//! Kernel ordering for operations that pause and mutate an execution image.
//! Host completion promises are wake hints, never ordering authority.
use super::*;

pub(super) struct ImageOperation {
    admission: GroupAdmission,
    image: ImageKey,
    pause: Option<u32>,
}
impl MapMemory for ImageOperation {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) }
}

impl Storage {
    pub(crate) fn begin_operation_pause(&mut self, memory: &mut impl PhysicalMemory,
        admission: GroupAdmission, token: u64) -> Result<u32, Errno> {
        if token != 0 {
            if !self.image_operation_ready(admission, token)? { return Err(Errno::EAGAIN); }
        } else if self.image_has_operations(self.owned(admission)?.image) {
            return Err(Errno::EBUSY);
        }
        let epoch = self.begin_image_pause(memory, admission)?;
        if token != 0 { self.operations.get_mut(&token).ok_or(Errno::ESRCH)?.pause = Some(epoch); }
        Ok(epoch)
    }

    pub(crate) fn begin_image_operation(&mut self, admission: GroupAdmission) -> Result<u64, Errno> {
        let image = self.owned(admission)?.image;
        let owner = self.images.get(&image).ok_or(Errno::ESRCH)?;
        if self.poisoned || !owner.source_live || !owner.exposed || owner.stopping {
            return Err(Errno::EBUSY);
        }
        let token = self.next_operation;
        let next = token.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        let operation = ImageOperation { admission, image, pause: None };
        let entry = PreparedMapSlot::new_in(&IO_MEMORY, 0)?.finish(token, operation)?;
        self.operations.publish_io(entry);
        self.next_operation = next;
        Ok(token)
    }

    pub(crate) fn image_operation_ready(&self, admission: GroupAdmission, token: u64) -> Result<bool, Errno> {
        let image = self.owned(admission)?.image;
        let operation = self.operations.get(&token).ok_or(Errno::ESRCH)?;
        if operation.admission != admission || operation.image != image {
            return Err(Errno::ESRCH);
        }
        Ok(!self.operations.iter().any(|(other, operation)| *other < token && operation.image == image))
    }

    pub(crate) fn finish_image_operation(&mut self, admission: GroupAdmission, token: u64) -> Result<(), Errno> {
        // Cancellation may remove a queued middle operation. Its successor
        // still waits for every earlier live operation on this image.
        self.image_operation_ready(admission, token)?;
        let operation = self.operations.get(&token).ok_or(Errno::ESRCH)?;
        if operation.pause.is_some() && self.images.get(&operation.image).ok_or(Errno::ESRCH)?.pause == operation.pause {
            return Err(Errno::EBUSY);
        }
        self.operations.remove(&token).ok_or(Errno::ESRCH)?;
        Ok(())
    }

    pub(super) fn image_has_operations(&self, image: ImageKey) -> bool {
        self.operations.values().any(|operation| operation.image == image)
    }

    pub(super) fn task_has_operations(&self, admission: GroupAdmission) -> bool {
        self.operations.values().any(|operation| operation.admission == admission)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::contract_tests::image;

    #[test]
    fn cancelled_middle_operation_never_lets_its_successor_bypass_the_head() {
        let (_groups, mut store, _memory, root) = image(32);
        let first = store.begin_image_operation(root).unwrap();
        let middle = store.begin_image_operation(root).unwrap();
        let last = store.begin_image_operation(root).unwrap();
        assert_eq!(store.image_operation_ready(root, first), Ok(true));
        assert_eq!(store.image_operation_ready(root, last), Ok(false));
        store.finish_image_operation(root, middle).unwrap();
        assert_eq!(store.image_operation_ready(root, last), Ok(false));
        store.finish_image_operation(root, first).unwrap();
        assert_eq!(store.image_operation_ready(root, last), Ok(true));
        store.finish_image_operation(root, last).unwrap();
        assert!(store.operations.is_empty());
    }

    #[test]
    fn a_sibling_cannot_consume_another_tasks_operation() {
        let (mut groups, mut store, mut memory, root) = image(32);
        let thread = groups.prepare_thread(root, 101).unwrap();
        store.prepare_thread(&mut memory, thread).unwrap();
        let token = store.begin_image_operation(root).unwrap();
        assert_eq!(store.image_operation_ready(thread, token), Err(Errno::ESRCH));
        assert_eq!(store.finish_image_operation(thread, token), Err(Errno::ESRCH));
        assert_eq!(store.image_operation_ready(root, token), Ok(true));
        store.finish_image_operation(root, token).unwrap();
        assert_eq!(store.image_operation_ready(root, token), Err(Errno::ESRCH));
    }

    #[test]
    fn token_exhaustion_does_not_publish_an_operation_or_wrap() {
        let (_groups, mut store, _memory, root) = image(32);
        store.next_operation = u64::MAX;
        assert_eq!(store.begin_image_operation(root), Err(Errno::EOVERFLOW));
        assert!(store.operations.is_empty());
        assert_eq!(store.next_operation, u64::MAX);
    }

    #[test]
    fn a_queued_operation_cannot_start_a_pause_or_bypass_order_without_a_token() {
        let (_groups, mut store, mut memory, root) = image(32);
        let first = store.begin_image_operation(root).unwrap();
        let second = store.begin_image_operation(root).unwrap();
        assert_eq!(store.begin_operation_pause(&mut memory, root, second), Err(Errno::EAGAIN));
        assert_eq!(store.begin_operation_pause(&mut memory, root, 0), Err(Errno::EBUSY));
        let epoch = store.begin_operation_pause(&mut memory, root, first).unwrap();
        assert_eq!(store.finish_image_operation(root, first), Err(Errno::EBUSY));
        store.resume_image(&mut memory, root, epoch).unwrap();
        store.finish_image_operation(root, first).unwrap();
        assert!(store.begin_operation_pause(&mut memory, root, second).is_ok());
    }

    #[test]
    fn unrelated_images_do_not_serialize_on_the_same_group() {
        let (mut groups, mut store, mut memory, root) = image(32);
        let other = groups.prepare_image(root.group(), 102, 1).unwrap();
        store.prepare_image(&mut memory, other, ImageLayout {
            initial_pages: 2, maximum_pages: 32, scratch_bytes: PAGE,
        }).unwrap();
        store.publish(other).unwrap();
        let first = store.begin_image_operation(root).unwrap();
        let second = store.begin_image_operation(other).unwrap();
        assert_eq!(store.image_operation_ready(root, first), Ok(true));
        assert_eq!(store.image_operation_ready(other, second), Ok(true));
        assert_eq!(store.finish_image_operation(root, second), Err(Errno::ESRCH));
        store.finish_image_operation(other, second).unwrap();
        store.finish_image_operation(root, first).unwrap();
    }

    #[test]
    fn stopped_image_retains_storage_until_its_operations_are_cancelled() {
        let (_groups, mut store, mut memory, root) = image(32);
        let token = store.begin_image_operation(root).unwrap();
        store.note_quiescent(&mut memory, root).unwrap();
        store.revoke_source(&mut memory, root).unwrap();
        assert_eq!(store.release_stopped_image(&mut memory, root), Err(Errno::EAGAIN));
        store.finish_image_operation(root, token).unwrap();
        assert!(store.release_stopped_image(&mut memory, root).is_ok());
    }
}
