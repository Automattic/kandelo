//! POSIX message queue implementation.
//!
//! Named message queues with priority-sorted messages.  The host
//! marshals data between process memory and kernel scratch; all queue
//! logic lives here.

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
use wasm_posix_shared::{platform_limits, signal::NSIG, Errno};

// Access mode flags
const O_RDONLY: u32 = 0;
const O_WRONLY: u32 = 1;
#[cfg(test)]
const O_RDWR: u32 = 2;
const O_ACCMODE: u32 = 3;
const O_CREAT: u32 = 0o100;
const O_EXCL: u32 = 0o200;
const O_NONBLOCK: u32 = 0o4000;
const O_LARGEFILE: u32 = 0o100000;

// Notification types
const SIGEV_SIGNAL: u32 = 0;
const SIGEV_NONE: u32 = 1;

const DEFAULT_MAXMSG: u32 = 10;
const DEFAULT_MSGSIZE: u32 = 8192;

/// Descriptor base — high range to avoid kernel fd conflicts.
pub const MQD_BASE: u32 = 0x40000000;
/// mqd_t and the channel result are signed 32-bit values.
const MQD_MAX: u32 = i32::MAX as u32;

/// A single message in a queue.
struct MqMessage {
    data: Vec<u8>,
    priority: u32,
}

/// Stable identity for one queue object.
///
/// Names may be unlinked and reused while descriptors or blocked operations
/// still refer to the old object, so the name itself cannot be the identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct MqQueueId(u64);

/// Stable identity for one active-operation retention.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct MqPinId(u64);

/// A message queue object, independently of whether it still has a name.
#[allow(dead_code)]
struct MqQueue {
    maxmsg: u32,
    msgsize: u32,
    messages: Vec<MqMessage>,
    linked: bool,
    open_count: u32,
    active_pins: u32,
    notification: Option<MqNotification>,
    mode: u32,
}

/// Per-descriptor state.
#[derive(Clone, Copy)]
struct MqDescriptor {
    queue_id: MqQueueId,
    access_mode: u32,
    nonblock: bool,
}

/// Opaque authority retained by one potentially blocking operation.
///
/// The copied descriptor policy and stable queue ID remain valid after the
/// public mqd is closed or reused. Fields stay private so sibling modules can
/// only obtain a capability through [`MqueueTable::pin_descriptor`].
pub(crate) struct PinnedMqueueDescriptor {
    pin_id: MqPinId,
    queue_id: MqQueueId,
    access_mode: u32,
    nonblock: bool,
}

#[cfg(test)]
impl PinnedMqueueDescriptor {
    fn duplicate_for_exact_release_test(&self) -> Self {
        Self {
            pin_id: self.pin_id,
            queue_id: self.queue_id,
            access_mode: self.access_mode,
            nonblock: self.nonblock,
        }
    }
}

#[derive(Clone, Copy)]
struct ResolvedMqDescriptor {
    queue_id: MqQueueId,
    access_mode: u32,
    nonblock: bool,
}

#[derive(Clone, Copy)]
enum MqDescriptorAuthority<'a> {
    Public(u32),
    Pinned(&'a PinnedMqueueDescriptor),
}

/// One-shot signal notification registration.
#[derive(Clone, Copy, Debug)]
pub struct MqNotification {
    pub pid: u32,
    pub signo: u32,
    /// Raw registering process `union sigval` bits.
    pub value_bits: u64,
}

/// Queue attributes returned to userspace.
#[derive(Debug)]
pub struct MqAttr {
    pub flags: u32,
    pub maxmsg: u32,
    pub msgsize: u32,
    pub curmsgs: u32,
}

/// Result of a receive operation.
#[derive(Debug)]
pub struct MqRecvResult {
    pub data: Vec<u8>,
    pub priority: u32,
}

/// Result of a send operation.
#[derive(Debug)]
pub struct MqSendResult {
    pub notification: Option<MqNotification>,
}

/// Global message queue table.
pub struct MqueueTable {
    names: BTreeMap<String, MqQueueId>,
    queues: BTreeMap<MqQueueId, MqQueue>,
    descriptors: BTreeMap<u32, MqDescriptor>,
    active_pins: BTreeMap<MqPinId, MqQueueId>,
    next_queue_id: Option<MqQueueId>,
    next_mqd: Option<u32>,
    next_pin_id: Option<MqPinId>,
    pending_notification: Option<MqNotification>,
}

impl MqueueTable {
    pub const fn new() -> Self {
        MqueueTable {
            names: BTreeMap::new(),
            queues: BTreeMap::new(),
            descriptors: BTreeMap::new(),
            active_pins: BTreeMap::new(),
            next_queue_id: Some(MqQueueId(1)),
            next_mqd: Some(MQD_BASE),
            next_pin_id: Some(MqPinId(1)),
            pending_notification: None,
        }
    }

    /// Store a pending notification for the host to read after mq_send.
    pub fn set_pending_notification(&mut self, notif: MqNotification) {
        self.pending_notification = Some(notif);
    }

    /// Take and return the pending notification, if any.
    pub fn take_pending_notification(&mut self) -> Option<MqNotification> {
        self.pending_notification.take()
    }

    fn next_free_mqd(&self) -> Result<(u32, Option<u32>), Errno> {
        let mut candidate = self.next_mqd.ok_or(Errno::EMFILE)?;
        if !(MQD_BASE..=MQD_MAX).contains(&candidate) {
            return Err(Errno::EIO);
        }
        loop {
            if !self.descriptors.contains_key(&candidate) {
                let next = candidate.checked_add(1).filter(|value| *value <= MQD_MAX);
                return Ok((candidate, next));
            }
            candidate = candidate
                .checked_add(1)
                .filter(|value| *value <= MQD_MAX)
                .ok_or(Errno::EMFILE)?;
        }
    }

    fn next_free_queue_id(&self) -> Result<(MqQueueId, Option<MqQueueId>), Errno> {
        let mut candidate = self.next_queue_id.ok_or(Errno::ENFILE)?;
        if candidate.0 == 0 {
            return Err(Errno::EIO);
        }
        loop {
            if !self.queues.contains_key(&candidate) {
                return Ok((candidate, candidate.0.checked_add(1).map(MqQueueId)));
            }
            candidate = MqQueueId(candidate.0.checked_add(1).ok_or(Errno::ENFILE)?);
        }
    }

    fn next_free_pin_id(&self) -> Result<(MqPinId, Option<MqPinId>), Errno> {
        let mut candidate = self.next_pin_id.ok_or(Errno::EOVERFLOW)?;
        if candidate.0 == 0 {
            return Err(Errno::EIO);
        }
        loop {
            if !self.active_pins.contains_key(&candidate) {
                return Ok((candidate, candidate.0.checked_add(1).map(MqPinId)));
            }
            candidate = MqPinId(candidate.0.checked_add(1).ok_or(Errno::EOVERFLOW)?);
        }
    }

    fn resolve_descriptor(
        &self,
        authority: MqDescriptorAuthority<'_>,
    ) -> Result<ResolvedMqDescriptor, Errno> {
        match authority {
            MqDescriptorAuthority::Public(mqd) => {
                let descriptor = self.descriptors.get(&mqd).ok_or(Errno::EBADF)?;
                Ok(ResolvedMqDescriptor {
                    queue_id: descriptor.queue_id,
                    access_mode: descriptor.access_mode,
                    nonblock: descriptor.nonblock,
                })
            }
            MqDescriptorAuthority::Pinned(pinned) => {
                if self.active_pins.get(&pinned.pin_id) != Some(&pinned.queue_id) {
                    return Err(Errno::EBADF);
                }
                Ok(ResolvedMqDescriptor {
                    queue_id: pinned.queue_id,
                    access_mode: pinned.access_mode,
                    nonblock: pinned.nonblock,
                })
            }
        }
    }

    fn reclaim_queue_if_unused(&mut self, queue_id: MqQueueId) {
        let should_reclaim = self
            .queues
            .get(&queue_id)
            .map(|queue| !queue.linked && queue.open_count == 0 && queue.active_pins == 0)
            .unwrap_or(false);
        if should_reclaim {
            debug_assert!(!self.names.values().any(|id| *id == queue_id));
            self.queues.remove(&queue_id);
        }
    }

    /// Returns true if `fd` is a message queue descriptor.
    pub fn is_mqd(&self, fd: u32) -> bool {
        self.descriptors.contains_key(&fd)
    }

    /// Returns `Some(true)` if the descriptor has O_NONBLOCK set,
    /// `Some(false)` if blocking, or `None` if the descriptor is unknown.
    pub fn is_nonblock(&self, mqd: u32) -> Option<bool> {
        self.resolve_descriptor(MqDescriptorAuthority::Public(mqd))
            .ok()
            .map(|descriptor| descriptor.nonblock)
    }

    /// Return the captured O_NONBLOCK policy for one pinned operation.
    pub(crate) fn pinned_is_nonblock(
        &self,
        pinned: &PinnedMqueueDescriptor,
    ) -> Result<bool, Errno> {
        self.resolve_descriptor(MqDescriptorAuthority::Pinned(pinned))
            .map(|descriptor| descriptor.nonblock)
    }

    /// Return the authoritative maximum message size for one descriptor.
    ///
    /// Host marshalling uses this only to size a kernel-owned transfer before
    /// dispatch. Queue policy and the final access-mode/error decision remain
    /// in [`Self::mq_send`] and [`Self::mq_receive`].
    pub fn descriptor_msgsize(&self, mqd: u32) -> Result<u32, Errno> {
        self.descriptor_msgsize_for(MqDescriptorAuthority::Public(mqd))
    }

    /// Return the exact queue limit retained by a pinned operation.
    pub(crate) fn pinned_descriptor_msgsize(
        &self,
        pinned: &PinnedMqueueDescriptor,
    ) -> Result<u32, Errno> {
        self.descriptor_msgsize_for(MqDescriptorAuthority::Pinned(pinned))
    }

    fn descriptor_msgsize_for(&self, authority: MqDescriptorAuthority<'_>) -> Result<u32, Errno> {
        let descriptor = self.resolve_descriptor(authority)?;
        self.queues
            .get(&descriptor.queue_id)
            .map(|queue| queue.msgsize)
            .ok_or(Errno::EBADF)
    }

    /// Retain one descriptor's exact queue object and policy for a blocked
    /// operation.
    pub(crate) fn pin_descriptor(&mut self, mqd: u32) -> Result<PinnedMqueueDescriptor, Errno> {
        let descriptor = self.resolve_descriptor(MqDescriptorAuthority::Public(mqd))?;
        let (pin_id, next_pin_id) = self.next_free_pin_id()?;
        let queue = self
            .queues
            .get_mut(&descriptor.queue_id)
            .ok_or(Errno::EBADF)?;
        queue.active_pins = queue.active_pins.checked_add(1).ok_or(Errno::EOVERFLOW)?;

        self.active_pins.insert(pin_id, descriptor.queue_id);
        self.next_pin_id = next_pin_id;
        Ok(PinnedMqueueDescriptor {
            pin_id,
            queue_id: descriptor.queue_id,
            access_mode: descriptor.access_mode,
            nonblock: descriptor.nonblock,
        })
    }

    /// Release exactly one active-operation retention.
    ///
    /// Consuming the opaque value makes duplicate release unavailable to
    /// production callers. The registry check also fails closed if a stale or
    /// forged capability is presented by future unsafe code.
    pub(crate) fn release_pinned_descriptor(
        &mut self,
        pinned: PinnedMqueueDescriptor,
    ) -> Result<(), Errno> {
        if self.active_pins.get(&pinned.pin_id) != Some(&pinned.queue_id) {
            return Err(Errno::EBADF);
        }
        let queue = self.queues.get_mut(&pinned.queue_id).ok_or(Errno::EIO)?;
        queue.active_pins = queue.active_pins.checked_sub(1).ok_or(Errno::EIO)?;
        self.active_pins.remove(&pinned.pin_id);
        self.reclaim_queue_if_unused(pinned.queue_id);
        Ok(())
    }

    /// Open or create a named message queue.
    pub fn mq_open(
        &mut self,
        name: &str,
        flags: u32,
        mode: u32,
        attr_maxmsg: u32,
        attr_msgsize: u32,
        has_attr: bool,
    ) -> Result<u32, Errno> {
        let flags = flags & !O_LARGEFILE;
        let access_mode = flags & O_ACCMODE;
        let creating = (flags & O_CREAT) != 0;
        let exclusive = (flags & O_EXCL) != 0;
        let nonblock = (flags & O_NONBLOCK) != 0;

        if name.is_empty() {
            return Err(Errno::EINVAL);
        }
        if name.len() >= platform_limits::NAME_MAX_BYTES {
            return Err(Errno::ENAMETOOLONG);
        }

        let existing_queue_id = self.names.get(name).copied();
        let exists = existing_queue_id.is_some();

        if creating && exclusive && exists {
            return Err(Errno::EEXIST);
        }

        if !creating && !exists {
            return Err(Errno::ENOENT);
        }

        let new_queue_attributes = if exists {
            None
        } else {
            let maxmsg = if has_attr {
                attr_maxmsg
            } else {
                DEFAULT_MAXMSG
            };
            let msgsize = if has_attr {
                attr_msgsize
            } else {
                DEFAULT_MSGSIZE
            };
            if maxmsg == 0 || msgsize == 0 {
                return Err(Errno::EINVAL);
            }
            // WHY: mq_receive removes a message before returning its byte
            // count. A queue whose configured message size cannot be reported
            // through the signed-i32 channel result would make that side
            // effect impossible to publish without truncation.
            if msgsize as usize > platform_limits::MAX_REPORTABLE_TRANSFER_BYTES {
                return Err(Errno::EINVAL);
            }
            Some((maxmsg, msgsize))
        };

        // WHY: choose every identity before mutating the name, object, or open
        // count. Exhaustion can then fail without publishing a half-open queue
        // or overwriting an existing descriptor at a wrapped counter value.
        let (mqd, next_mqd) = self.next_free_mqd()?;
        let new_queue_identity = if new_queue_attributes.is_some() {
            Some(self.next_free_queue_id()?)
        } else {
            None
        };

        let queue_id = if let Some(queue_id) = existing_queue_id {
            let queue = self.queues.get_mut(&queue_id).ok_or(Errno::EIO)?;
            queue.open_count = queue.open_count.checked_add(1).ok_or(Errno::EMFILE)?;
            queue_id
        } else {
            let (queue_id, next_queue_id) = new_queue_identity.ok_or(Errno::EIO)?;
            let (maxmsg, msgsize) = new_queue_attributes.ok_or(Errno::EIO)?;
            let queue = MqQueue {
                maxmsg,
                msgsize,
                messages: Vec::new(),
                linked: true,
                open_count: 1,
                active_pins: 0,
                notification: None,
                mode,
            };
            self.queues.insert(queue_id, queue);
            self.names.insert(String::from(name), queue_id);
            self.next_queue_id = next_queue_id;
            queue_id
        };

        self.descriptors.insert(
            mqd,
            MqDescriptor {
                queue_id,
                access_mode,
                nonblock,
            },
        );
        self.next_mqd = next_mqd;

        Ok(mqd)
    }

    /// Close a message queue descriptor.
    pub fn mq_close(&mut self, mqd: u32) -> Result<(), Errno> {
        let descriptor = *self.descriptors.get(&mqd).ok_or(Errno::EBADF)?;
        let queue = self
            .queues
            .get_mut(&descriptor.queue_id)
            .ok_or(Errno::EIO)?;
        queue.open_count = queue.open_count.checked_sub(1).ok_or(Errno::EIO)?;
        self.descriptors.remove(&mqd);
        self.reclaim_queue_if_unused(descriptor.queue_id);

        Ok(())
    }

    /// Unlink a named message queue.
    pub fn mq_unlink(&mut self, name: &str) -> Result<(), Errno> {
        let queue_id = self.names.remove(name).ok_or(Errno::ENOENT)?;
        let queue = self.queues.get_mut(&queue_id).ok_or(Errno::EIO)?;
        queue.linked = false;
        self.reclaim_queue_if_unused(queue_id);

        Ok(())
    }

    /// Send a message. Returns notification to fire if queue was empty.
    pub fn mq_send(&mut self, mqd: u32, data: &[u8], priority: u32) -> Result<MqSendResult, Errno> {
        self.mq_send_for_with_reserve(
            MqDescriptorAuthority::Public(mqd),
            data,
            priority,
            |message, additional| {
                message
                    .try_reserve_exact(additional)
                    .map_err(|_| Errno::ENOMEM)
            },
            |messages| messages.try_reserve(1).map_err(|_| Errno::ENOMEM),
        )
    }

    /// Send through a pinned descriptor without looking up a numeric mqd.
    pub(crate) fn mq_send_pinned(
        &mut self,
        pinned: &PinnedMqueueDescriptor,
        data: &[u8],
        priority: u32,
    ) -> Result<MqSendResult, Errno> {
        self.mq_send_for_with_reserve(
            MqDescriptorAuthority::Pinned(pinned),
            data,
            priority,
            |message, additional| {
                message
                    .try_reserve_exact(additional)
                    .map_err(|_| Errno::ENOMEM)
            },
            |messages| messages.try_reserve(1).map_err(|_| Errno::ENOMEM),
        )
    }

    #[cfg(test)]
    fn mq_send_with_reserve(
        &mut self,
        mqd: u32,
        data: &[u8],
        priority: u32,
        reserve_message: impl FnOnce(&mut Vec<u8>, usize) -> Result<(), Errno>,
        reserve_slot: impl FnOnce(&mut Vec<MqMessage>) -> Result<(), Errno>,
    ) -> Result<MqSendResult, Errno> {
        self.mq_send_for_with_reserve(
            MqDescriptorAuthority::Public(mqd),
            data,
            priority,
            reserve_message,
            reserve_slot,
        )
    }

    fn mq_send_for_with_reserve(
        &mut self,
        authority: MqDescriptorAuthority<'_>,
        data: &[u8],
        priority: u32,
        reserve_message: impl FnOnce(&mut Vec<u8>, usize) -> Result<(), Errno>,
        reserve_slot: impl FnOnce(&mut Vec<MqMessage>) -> Result<(), Errno>,
    ) -> Result<MqSendResult, Errno> {
        let descriptor = self.resolve_descriptor(authority)?;
        if descriptor.access_mode == O_RDONLY {
            return Err(Errno::EBADF);
        }

        let queue = self
            .queues
            .get_mut(&descriptor.queue_id)
            .ok_or(Errno::EBADF)?;

        if data.len() > queue.msgsize as usize {
            return Err(Errno::EMSGSIZE);
        }

        if queue.messages.len() >= queue.maxmsg as usize {
            if descriptor.nonblock {
                return Err(Errno::EAGAIN);
            }
            // Return EAGAIN for host retry.
            return Err(Errno::EAGAIN);
        }

        // WHY: allocation failure is an ordinary ENOMEM result, not a Wasm
        // trap. Finish both potentially allocating preparations before
        // inserting the message or consuming the one-shot notification.
        let mut message_data = Vec::new();
        reserve_message(&mut message_data, data.len())?;
        if message_data.capacity() < data.len() {
            return Err(Errno::ENOMEM);
        }
        message_data.extend_from_slice(data);
        reserve_slot(&mut queue.messages)?;
        if queue
            .messages
            .capacity()
            .saturating_sub(queue.messages.len())
            < 1
        {
            return Err(Errno::ENOMEM);
        }

        let was_empty = queue.messages.is_empty();

        // Insert maintaining priority order (highest first)
        let msg = MqMessage {
            data: message_data,
            priority,
        };
        let pos = queue.messages.iter().position(|m| priority > m.priority);
        match pos {
            Some(i) => queue.messages.insert(i, msg),
            None => queue.messages.push(msg),
        }

        // Fire notification if queue was empty
        let notification = if was_empty {
            queue.notification.take()
        } else {
            None
        };

        Ok(MqSendResult { notification })
    }

    /// Receive the highest-priority message.
    pub fn mq_receive(&mut self, mqd: u32, buf_size: u32) -> Result<MqRecvResult, Errno> {
        self.mq_receive_for(MqDescriptorAuthority::Public(mqd), buf_size)
    }

    /// Receive through a pinned descriptor without looking up a numeric mqd.
    pub(crate) fn mq_receive_pinned(
        &mut self,
        pinned: &PinnedMqueueDescriptor,
        buf_size: u32,
    ) -> Result<MqRecvResult, Errno> {
        self.mq_receive_for(MqDescriptorAuthority::Pinned(pinned), buf_size)
    }

    fn mq_receive_for(
        &mut self,
        authority: MqDescriptorAuthority<'_>,
        buf_size: u32,
    ) -> Result<MqRecvResult, Errno> {
        let descriptor = self.resolve_descriptor(authority)?;
        if descriptor.access_mode == O_WRONLY {
            return Err(Errno::EBADF);
        }

        let queue = self
            .queues
            .get_mut(&descriptor.queue_id)
            .ok_or(Errno::EBADF)?;

        if buf_size < queue.msgsize {
            return Err(Errno::EMSGSIZE);
        }

        if queue.messages.is_empty() {
            if descriptor.nonblock {
                return Err(Errno::EAGAIN);
            }
            return Err(Errno::EAGAIN);
        }

        let msg = queue.messages.remove(0);
        Ok(MqRecvResult {
            data: msg.data,
            priority: msg.priority,
        })
    }

    /// Register or unregister notification on a queue.
    pub fn mq_notify(
        &mut self,
        mqd: u32,
        pid: u32,
        sigev_notify: Option<u32>, // None = unregister (sev ptr was NULL)
        signo: u32,
        value_bits: u64,
    ) -> Result<(), Errno> {
        let desc = self.descriptors.get(&mqd).ok_or(Errno::EBADF)?;
        let queue = self.queues.get_mut(&desc.queue_id).ok_or(Errno::EBADF)?;

        match sigev_notify {
            None => {
                // Unregister
                queue.notification = None;
                Ok(())
            }
            Some(SIGEV_NONE) => {
                if queue.notification.is_some() {
                    return Err(Errno::EBUSY);
                }
                // Register sentinel (blocks others, no actual signal)
                queue.notification = Some(MqNotification {
                    pid,
                    signo: 0,
                    value_bits,
                });
                Ok(())
            }
            Some(SIGEV_SIGNAL) => {
                if signo == 0 || signo >= NSIG {
                    return Err(Errno::EINVAL);
                }
                if queue.notification.is_some() {
                    return Err(Errno::EBUSY);
                }
                queue.notification = Some(MqNotification {
                    pid,
                    signo,
                    value_bits,
                });
                Ok(())
            }
            Some(_) => Err(Errno::EINVAL),
        }
    }

    /// Get/set attributes on a descriptor.
    pub fn mq_getsetattr(&mut self, mqd: u32, new_flags: Option<u32>) -> Result<MqAttr, Errno> {
        let descriptor = *self.descriptors.get(&mqd).ok_or(Errno::EBADF)?;
        let queue = self.queues.get(&descriptor.queue_id).ok_or(Errno::EBADF)?;

        let old_flags = if descriptor.nonblock { O_NONBLOCK } else { 0 };
        let result = MqAttr {
            flags: old_flags,
            maxmsg: queue.maxmsg,
            msgsize: queue.msgsize,
            curmsgs: queue.messages.len() as u32,
        };

        if let Some(flags) = new_flags {
            self.descriptors.get_mut(&mqd).ok_or(Errno::EBADF)?.nonblock =
                (flags & O_NONBLOCK) != 0;
        }

        Ok(result)
    }

    /// Clean up notifications for an exiting process.
    pub fn cleanup_process(&mut self, pid: u32) {
        for queue in self.queues.values_mut() {
            if let Some(ref notif) = queue.notification {
                if notif.pid == pid {
                    queue.notification = None;
                }
            }
        }
    }

    #[cfg(test)]
    fn linked_queue_for_test(&self, name: &str) -> &MqQueue {
        let queue_id = self.names.get(name).expect("linked queue name");
        self.queues.get(queue_id).expect("linked queue object")
    }

    #[cfg(test)]
    fn set_next_mqd_for_test(&mut self, next: Option<u32>) {
        assert!(next
            .map(|value| (MQD_BASE..=MQD_MAX).contains(&value))
            .unwrap_or(true));
        self.next_mqd = next;
    }

    #[cfg(test)]
    fn set_next_queue_id_for_test(&mut self, next: Option<u64>) {
        assert!(next.map(|value| value > 0).unwrap_or(true));
        self.next_queue_id = next.map(MqQueueId);
    }
}

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------

use core::cell::UnsafeCell;

struct MqueueTableCell(UnsafeCell<MqueueTable>);
unsafe impl Sync for MqueueTableCell {}

static MQUEUE_TABLE: MqueueTableCell = MqueueTableCell(UnsafeCell::new(MqueueTable::new()));

/// Get a mutable reference to the global mqueue table.
///
/// # Safety
/// Must only be called from a single-threaded context (Wasm is single-threaded).
pub unsafe fn global_mqueue_table() -> &'static mut MqueueTable {
    unsafe { &mut *MQUEUE_TABLE.0.get() }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_and_open() {
        let mut t = MqueueTable::new();
        let mqd = t
            .mq_open("/test", O_CREAT | O_RDWR, 0o644, 10, 1024, true)
            .unwrap();
        assert!(mqd >= MQD_BASE);

        // Open same queue again
        let mqd2 = t.mq_open("/test", O_RDWR, 0, 0, 0, false).unwrap();
        assert_ne!(mqd, mqd2);

        // O_CREAT | O_EXCL on existing queue should fail
        assert_eq!(
            t.mq_open("/test", O_CREAT | O_EXCL | O_RDWR, 0o644, 10, 1024, true),
            Err(Errno::EEXIST)
        );

        // Open nonexistent without O_CREAT
        assert_eq!(
            t.mq_open("/nonexist", O_RDONLY, 0, 0, 0, false),
            Err(Errno::ENOENT)
        );
    }

    #[test]
    fn test_send_receive_priority() {
        let mut t = MqueueTable::new();
        let mqd = t
            .mq_open("/prio", O_CREAT | O_RDWR, 0o644, 10, 256, true)
            .unwrap();

        // Send messages with different priorities
        t.mq_send(mqd, b"low", 1).unwrap();
        t.mq_send(mqd, b"high", 10).unwrap();
        t.mq_send(mqd, b"mid", 5).unwrap();

        // Receive should return highest priority first
        let msg = t.mq_receive(mqd, 256).unwrap();
        assert_eq!(msg.data, b"high");
        assert_eq!(msg.priority, 10);

        let msg = t.mq_receive(mqd, 256).unwrap();
        assert_eq!(msg.data, b"mid");
        assert_eq!(msg.priority, 5);

        let msg = t.mq_receive(mqd, 256).unwrap();
        assert_eq!(msg.data, b"low");
        assert_eq!(msg.priority, 1);
    }

    #[test]
    fn test_nonblock_eagain() {
        let mut t = MqueueTable::new();
        let mqd = t
            .mq_open("/nb", O_CREAT | O_RDWR | O_NONBLOCK, 0o644, 2, 64, true)
            .unwrap();

        // Fill the queue
        t.mq_send(mqd, b"a", 1).unwrap();
        t.mq_send(mqd, b"b", 1).unwrap();

        // Third send should EAGAIN
        assert_eq!(t.mq_send(mqd, b"c", 1).unwrap_err(), Errno::EAGAIN);

        // Receive both
        t.mq_receive(mqd, 64).unwrap();
        t.mq_receive(mqd, 64).unwrap();

        // Empty queue receive should EAGAIN
        assert_eq!(t.mq_receive(mqd, 64).unwrap_err(), Errno::EAGAIN);
    }

    #[test]
    fn test_msgsize_validation() {
        let mut t = MqueueTable::new();
        let mqd = t
            .mq_open("/size", O_CREAT | O_RDWR, 0o644, 10, 4, true)
            .unwrap();
        assert_eq!(t.descriptor_msgsize(mqd), Ok(4));
        let missing = t.descriptor_msgsize(MQD_BASE + 999);
        assert_eq!(missing, Err(Errno::EBADF));

        // Message too large
        assert_eq!(t.mq_send(mqd, b"12345", 1).unwrap_err(), Errno::EMSGSIZE);

        // Buffer too small for receive
        t.mq_send(mqd, b"ok", 1).unwrap();
        assert_eq!(t.mq_receive(mqd, 3).unwrap_err(), Errno::EMSGSIZE);
    }

    #[test]
    fn send_allocation_failures_preserve_queue_and_notification() {
        let mut t = MqueueTable::new();
        let mqd = t
            .mq_open("/oom", O_CREAT | O_RDWR, 0o644, 10, 64, true)
            .unwrap();
        t.mq_notify(mqd, 42, Some(SIGEV_SIGNAL), 10, 0x1234)
            .unwrap();

        assert_eq!(
            t.mq_send_with_reserve(
                mqd,
                b"payload",
                1,
                |_, _| Err(Errno::ENOMEM),
                |_| panic!("slot reservation must follow message reservation"),
            )
            .unwrap_err(),
            Errno::ENOMEM,
        );
        assert!(t.linked_queue_for_test("/oom").messages.is_empty());
        assert!(t.linked_queue_for_test("/oom").notification.is_some());

        assert_eq!(
            t.mq_send_with_reserve(
                mqd,
                b"payload",
                1,
                |message, additional| {
                    message
                        .try_reserve_exact(additional)
                        .map_err(|_| Errno::ENOMEM)
                },
                |_| Err(Errno::ENOMEM),
            )
            .unwrap_err(),
            Errno::ENOMEM,
        );
        assert!(t.linked_queue_for_test("/oom").messages.is_empty());
        assert!(t.linked_queue_for_test("/oom").notification.is_some());

        let result = t.mq_send(mqd, b"payload", 1).unwrap();
        assert!(result.notification.is_some());
        assert_eq!(t.linked_queue_for_test("/oom").messages.len(), 1);
    }

    #[test]
    fn queue_message_size_must_fit_the_channel_result_domain() {
        let mut t = MqueueTable::new();
        assert!(t
            .mq_open(
                "/max-reportable",
                O_CREAT | O_RDWR,
                0o644,
                1,
                platform_limits::MAX_REPORTABLE_TRANSFER_BYTES as u32,
                true,
            )
            .is_ok());
        assert_eq!(
            t.mq_open(
                "/unreportable",
                O_CREAT | O_RDWR,
                0o644,
                1,
                platform_limits::MAX_REPORTABLE_TRANSFER_BYTES as u32 + 1,
                true,
            ),
            Err(Errno::EINVAL),
        );
    }

    #[test]
    fn test_unlink_semantics() {
        let mut t = MqueueTable::new();
        let mqd = t
            .mq_open("/unl", O_CREAT | O_RDWR, 0o644, 10, 64, true)
            .unwrap();
        t.mq_send(mqd, b"data", 1).unwrap();

        // Unlink while still open
        t.mq_unlink("/unl").unwrap();

        // Can't open it again
        assert_eq!(
            t.mq_open("/unl", O_RDONLY, 0, 0, 0, false),
            Err(Errno::ENOENT)
        );

        // But existing descriptor still works
        let msg = t.mq_receive(mqd, 64).unwrap();
        assert_eq!(msg.data, b"data");

        // Close the descriptor — queue should be freed
        t.mq_close(mqd).unwrap();

        // Unlink again should fail
        assert_eq!(t.mq_unlink("/unl"), Err(Errno::ENOENT));
    }

    #[test]
    fn pinned_descriptor_survives_unlink_and_close_until_exact_release() {
        let mut t = MqueueTable::new();
        let mqd = t
            .mq_open("/pinned", O_CREAT | O_RDWR, 0o644, 10, 64, true)
            .unwrap();
        let pinned = t.pin_descriptor(mqd).unwrap();
        let duplicate = pinned.duplicate_for_exact_release_test();
        let queue_id = pinned.queue_id;

        // Descriptor policy is captured when the operation starts. A later
        // public mq_setattr must not change a blocked operation's semantics.
        t.mq_getsetattr(mqd, Some(O_NONBLOCK)).unwrap();
        assert_eq!(t.is_nonblock(mqd), Some(true));
        assert_eq!(t.pinned_is_nonblock(&pinned), Ok(false));

        t.mq_unlink("/pinned").unwrap();
        t.mq_close(mqd).unwrap();
        assert!(!t.is_mqd(mqd));
        assert!(!t.names.contains_key("/pinned"));
        assert!(t.queues.contains_key(&queue_id));

        assert_eq!(t.pinned_descriptor_msgsize(&pinned), Ok(64));
        t.mq_send_pinned(&pinned, b"old-object", 3).unwrap();
        let received = t.mq_receive_pinned(&pinned, 64).unwrap();
        assert_eq!(received.data, b"old-object");
        assert_eq!(received.priority, 3);

        t.release_pinned_descriptor(pinned).unwrap();
        assert!(!t.queues.contains_key(&queue_id));
        let duplicate_release = t.release_pinned_descriptor(duplicate);
        assert_eq!(duplicate_release, Err(Errno::EBADF));
    }

    #[test]
    fn forced_process_removal_releases_blocked_descriptor_pin() {
        use wasm_posix_shared::abi::extended_syscalls::SYS_MQ_TIMEDSEND;

        let mut processes = crate::process_table::ProcessTable::new();
        let pid = processes.create_process().unwrap();
        let (mqd, queue_id) = {
            let table = unsafe { global_mqueue_table() };
            let mqd = table
                .mq_open(
                    "/forced-removal-retry-pin",
                    O_CREAT | O_EXCL | O_RDWR,
                    0o600,
                    1,
                    64,
                    true,
                )
                .unwrap();
            (mqd, table.descriptors[&mqd].queue_id)
        };

        crate::syscalls::ensure_blocking_retry_mqueue_binding(
            processes.get_mut(pid).unwrap(),
            pid,
            SYS_MQ_TIMEDSEND,
            mqd as i32,
        )
        .unwrap();
        {
            let table = unsafe { global_mqueue_table() };
            table.mq_unlink("/forced-removal-retry-pin").unwrap();
            table.mq_close(mqd).unwrap();
            assert_eq!(table.queues[&queue_id].active_pins, 1);
            assert!(table.active_pins.values().any(|id| *id == queue_id));
        }

        processes.remove_process(pid).unwrap();

        let table = unsafe { global_mqueue_table() };
        assert!(!table.queues.contains_key(&queue_id));
        assert!(table.active_pins.values().all(|id| *id != queue_id));
    }

    #[test]
    fn unlink_then_recreate_keeps_old_and_new_queue_objects_isolated() {
        let mut t = MqueueTable::new();
        let old_mqd = t
            .mq_open("/same", O_CREAT | O_RDWR, 0o644, 10, 64, true)
            .unwrap();
        let old_queue_id = t.descriptors[&old_mqd].queue_id;
        t.mq_send(old_mqd, b"old", 1).unwrap();

        t.mq_unlink("/same").unwrap();
        let new_mqd = t
            .mq_open("/same", O_CREAT | O_RDWR, 0o600, 10, 64, true)
            .unwrap();
        let new_queue_id = t.descriptors[&new_mqd].queue_id;
        assert_ne!(old_queue_id, new_queue_id);
        assert_eq!(t.names.get("/same"), Some(&new_queue_id));
        assert!(t.queues.contains_key(&old_queue_id));
        assert!(t.queues.contains_key(&new_queue_id));

        t.mq_send(new_mqd, b"new", 9).unwrap();
        assert_eq!(t.mq_receive(old_mqd, 64).unwrap().data, b"old");
        assert_eq!(t.mq_receive(new_mqd, 64).unwrap().data, b"new");

        t.mq_close(old_mqd).unwrap();
        assert!(!t.queues.contains_key(&old_queue_id));
        assert!(t.queues.contains_key(&new_queue_id));
        assert_eq!(t.descriptor_msgsize(new_mqd), Ok(64));
    }

    #[test]
    fn mqd_allocation_skips_collisions_and_never_wraps() {
        let mut t = MqueueTable::new();
        let first = t
            .mq_open("/first", O_CREAT | O_RDWR, 0o644, 1, 16, true)
            .unwrap();

        t.set_next_mqd_for_test(Some(first));
        let second = t
            .mq_open("/second", O_CREAT | O_RDWR, 0o644, 1, 32, true)
            .unwrap();
        assert_eq!(second, first + 1);
        assert_eq!(t.descriptor_msgsize(first), Ok(16));
        assert_eq!(t.descriptor_msgsize(second), Ok(32));

        t.set_next_mqd_for_test(Some(MQD_MAX));
        let last = t
            .mq_open("/last", O_CREAT | O_RDWR, 0o644, 1, 48, true)
            .unwrap();
        assert_eq!(last, MQD_MAX);
        assert_eq!(t.next_mqd, None);
        assert_eq!(
            t.mq_open("/exhausted", O_CREAT | O_RDWR, 0o644, 1, 64, true),
            Err(Errno::EMFILE),
        );
        assert!(!t.names.contains_key("/exhausted"));
        assert_eq!(t.descriptor_msgsize(last), Ok(48));
    }

    #[test]
    fn queue_id_allocation_skips_collisions_and_never_wraps() {
        let mut t = MqueueTable::new();
        let first_mqd = t
            .mq_open("/queue-one", O_CREAT | O_RDWR, 0o644, 1, 16, true)
            .unwrap();
        let first_queue_id = t.descriptors[&first_mqd].queue_id;

        t.set_next_queue_id_for_test(Some(first_queue_id.0));
        let second_mqd = t
            .mq_open("/queue-two", O_CREAT | O_RDWR, 0o644, 1, 32, true)
            .unwrap();
        let second_queue_id = t.descriptors[&second_mqd].queue_id;
        assert_ne!(first_queue_id, second_queue_id);

        t.set_next_queue_id_for_test(Some(u64::MAX));
        let last_mqd = t
            .mq_open("/queue-last", O_CREAT | O_RDWR, 0o644, 1, 48, true)
            .unwrap();
        assert_eq!(t.descriptors[&last_mqd].queue_id, MqQueueId(u64::MAX));
        assert_eq!(t.next_queue_id, None);

        let next_mqd_before = t.next_mqd;
        let exhausted = t.mq_open("/queue-exhausted", O_CREAT | O_RDWR, 0o644, 1, 64, true);
        assert_eq!(exhausted, Err(Errno::ENFILE));
        assert_eq!(t.next_mqd, next_mqd_before);
        assert!(!t.names.contains_key("/queue-exhausted"));
        assert_eq!(t.descriptor_msgsize(first_mqd), Ok(16));
        assert_eq!(t.descriptor_msgsize(second_mqd), Ok(32));
        assert_eq!(t.descriptor_msgsize(last_mqd), Ok(48));
    }

    #[test]
    fn test_notification() {
        let mut t = MqueueTable::new();
        let mqd = t
            .mq_open("/notif", O_CREAT | O_RDWR, 0o644, 10, 64, true)
            .unwrap();

        // Register notification
        t.mq_notify(mqd, 42, Some(SIGEV_SIGNAL), 10, 0x0123_4567_89ab_cdef)
            .unwrap();

        // Second registration should EBUSY
        assert_eq!(
            t.mq_notify(mqd, 43, Some(SIGEV_SIGNAL), 11, 0),
            Err(Errno::EBUSY)
        );
        assert_eq!(
            t.mq_notify(mqd, 43, Some(SIGEV_NONE), 0, 0),
            Err(Errno::EBUSY)
        );

        // Send to empty queue should fire notification
        let result = t.mq_send(mqd, b"hello", 1).unwrap();
        let notif = result.notification.unwrap();
        assert_eq!(notif.pid, 42);
        assert_eq!(notif.signo, 10);
        assert_eq!(notif.value_bits, 0x0123_4567_89ab_cdef);

        // Auto-unregistered: second send should NOT fire
        let result = t.mq_send(mqd, b"world", 1).unwrap();
        assert!(result.notification.is_none());

        // Unregister with NULL sev
        t.mq_notify(mqd, 42, Some(SIGEV_SIGNAL), 10, 0).unwrap();
        t.mq_notify(mqd, 42, None, 0, 0).unwrap();
        // Now registration should work again
        t.mq_notify(mqd, 42, Some(SIGEV_SIGNAL), 10, 0).unwrap();
    }

    #[test]
    fn test_signal_notification_rejects_invalid_signums_without_registering() {
        let mut t = MqueueTable::new();
        let mqd = t
            .mq_open("/invalid-notify", O_CREAT | O_RDWR, 0o644, 10, 64, true)
            .unwrap();

        for signo in [0, NSIG, u32::MAX] {
            assert_eq!(
                t.mq_notify(mqd, 42, Some(SIGEV_SIGNAL), signo, 0),
                Err(Errno::EINVAL)
            );
        }

        // WHY: a rejected registration must not occupy the queue's one-shot
        // notification slot; a later valid registration must still succeed.
        t.mq_notify(mqd, 42, Some(SIGEV_SIGNAL), NSIG - 1, 0)
            .unwrap();
    }

    #[test]
    fn test_getsetattr() {
        let mut t = MqueueTable::new();
        let mqd = t
            .mq_open("/attr", O_CREAT | O_RDWR, 0o644, 5, 128, true)
            .unwrap();

        let attr = t.mq_getsetattr(mqd, None).unwrap();
        assert_eq!(attr.flags, 0);
        assert_eq!(attr.maxmsg, 5);
        assert_eq!(attr.msgsize, 128);
        assert_eq!(attr.curmsgs, 0);

        // Set O_NONBLOCK
        let old = t.mq_getsetattr(mqd, Some(O_NONBLOCK)).unwrap();
        assert_eq!(old.flags, 0); // was blocking before

        let attr = t.mq_getsetattr(mqd, None).unwrap();
        assert_eq!(attr.flags, O_NONBLOCK);

        // Clear O_NONBLOCK
        let old = t.mq_getsetattr(mqd, Some(0)).unwrap();
        assert_eq!(old.flags, O_NONBLOCK);
    }

    #[test]
    fn test_cleanup_process() {
        let mut t = MqueueTable::new();
        let mqd = t
            .mq_open("/cleanup", O_CREAT | O_RDWR, 0o644, 10, 64, true)
            .unwrap();

        t.mq_notify(mqd, 100, Some(SIGEV_SIGNAL), 10, 0).unwrap();

        // Cleanup pid 100 should remove notification
        t.cleanup_process(100);

        // Now registration should succeed
        t.mq_notify(mqd, 200, Some(SIGEV_SIGNAL), 11, 0).unwrap();
    }

    #[test]
    fn test_access_mode_enforcement() {
        let mut t = MqueueTable::new();
        t.mq_open("/ro", O_CREAT | O_RDWR, 0o644, 10, 64, true)
            .unwrap();

        let ro = t.mq_open("/ro", O_RDONLY, 0, 0, 0, false).unwrap();
        let wo = t.mq_open("/ro", O_WRONLY, 0, 0, 0, false).unwrap();

        // Read-only can't send
        assert_eq!(t.mq_send(ro, b"test", 1).unwrap_err(), Errno::EBADF);

        // Write-only can't receive
        assert_eq!(t.mq_receive(wo, 64).unwrap_err(), Errno::EBADF);

        // But write-only can send and read-only can receive
        t.mq_send(wo, b"test", 1).unwrap();
        let msg = t.mq_receive(ro, 64).unwrap();
        assert_eq!(msg.data, b"test");
    }

    #[test]
    fn test_bad_descriptor() {
        let mut t = MqueueTable::new();

        assert_eq!(t.mq_close(MQD_BASE + 999).unwrap_err(), Errno::EBADF);
        assert_eq!(
            t.mq_send(MQD_BASE + 999, b"x", 1).unwrap_err(),
            Errno::EBADF
        );
        assert_eq!(t.mq_receive(MQD_BASE + 999, 64).unwrap_err(), Errno::EBADF);
        assert_eq!(
            t.mq_notify(MQD_BASE + 999, 1, Some(0), 1, 0).unwrap_err(),
            Errno::EBADF
        );
        assert_eq!(
            t.mq_getsetattr(MQD_BASE + 999, None).unwrap_err(),
            Errno::EBADF
        );
    }

    #[test]
    fn test_default_attrs() {
        let mut t = MqueueTable::new();
        // Create without explicit attrs
        let mqd = t
            .mq_open("/def", O_CREAT | O_RDWR, 0o644, 0, 0, false)
            .unwrap();
        let attr = t.mq_getsetattr(mqd, None).unwrap();
        assert_eq!(attr.maxmsg, DEFAULT_MAXMSG);
        assert_eq!(attr.msgsize, DEFAULT_MSGSIZE);
    }
}
