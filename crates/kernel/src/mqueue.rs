//! POSIX message queue implementation.
//!
//! Named message queues with priority-sorted messages.  The host
//! marshals data between process memory and kernel scratch; all queue
//! logic lives here.

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
use wasm_posix_shared::Errno;

// Access mode flags
const O_RDONLY: u32 = 0;
const O_WRONLY: u32 = 1;
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

/// A single message in a queue.
struct MqMessage {
    data: Vec<u8>,
    priority: u32,
}

/// A named message queue.
#[allow(dead_code)]
struct MqQueue {
    name: String,
    maxmsg: u32,
    msgsize: u32,
    messages: Vec<MqMessage>,
    unlinked: bool,
    open_count: u32,
    notification: Option<MqNotification>,
    mode: u32,
}

/// Per-descriptor state.
struct MqDescriptor {
    queue_name: String,
    access_mode: u32,
    nonblock: bool,
}

/// Notification registration (pid + signal number).
#[derive(Clone, Copy, Debug)]
pub struct MqNotification {
    pub pid: u32,
    pub signo: u32,
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
    queues: BTreeMap<String, MqQueue>,
    descriptors: BTreeMap<u32, MqDescriptor>,
    next_mqd: u32,
    pending_notification: Option<MqNotification>,
}

impl MqueueTable {
    pub const fn new() -> Self {
        MqueueTable {
            queues: BTreeMap::new(),
            descriptors: BTreeMap::new(),
            next_mqd: MQD_BASE,
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

    /// Returns true if `fd` is a message queue descriptor.
    pub fn is_mqd(&self, fd: u32) -> bool {
        self.descriptors.contains_key(&fd)
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

        if name.is_empty() || name.len() > 255 {
            return Err(Errno::EINVAL);
        }

        let exists = self.queues.get(name).map(|q| !q.unlinked).unwrap_or(false);

        if creating && exclusive && exists {
            return Err(Errno::EEXIST);
        }

        if !creating && !exists {
            return Err(Errno::ENOENT);
        }

        if exists {
            // Open existing queue
            self.queues.get_mut(name).unwrap().open_count += 1;
        } else {
            // Create new queue
            let maxmsg = if has_attr { attr_maxmsg } else { DEFAULT_MAXMSG };
            let msgsize = if has_attr { attr_msgsize } else { DEFAULT_MSGSIZE };
            if maxmsg == 0 || msgsize == 0 {
                return Err(Errno::EINVAL);
            }

            let queue = MqQueue {
                name: String::from(name),
                maxmsg,
                msgsize,
                messages: Vec::new(),
                unlinked: false,
                open_count: 1,
                notification: None,
                mode,
            };
            self.queues.insert(String::from(name), queue);
        }

        let mqd = self.next_mqd;
        self.next_mqd += 1;
        self.descriptors.insert(mqd, MqDescriptor {
            queue_name: String::from(name),
            access_mode,
            nonblock,
        });

        Ok(mqd)
    }

    /// Close a message queue descriptor.
    pub fn mq_close(&mut self, mqd: u32) -> Result<(), Errno> {
        let desc = self.descriptors.remove(&mqd).ok_or(Errno::EBADF)?;

        if let Some(queue) = self.queues.get_mut(&desc.queue_name) {
            queue.open_count = queue.open_count.saturating_sub(1);
            if queue.open_count == 0 && queue.unlinked {
                self.queues.remove(&desc.queue_name);
            }
        }

        Ok(())
    }

    /// Unlink a named message queue.
    pub fn mq_unlink(&mut self, name: &str) -> Result<(), Errno> {
        let queue = self.queues.get_mut(name).ok_or(Errno::ENOENT)?;
        if queue.unlinked {
            return Err(Errno::ENOENT);
        }

        if queue.open_count == 0 {
            self.queues.remove(name);
        } else {
            queue.unlinked = true;
        }

        Ok(())
    }

    /// Send a message. Returns notification to fire if queue was empty.
    pub fn mq_send(
        &mut self,
        mqd: u32,
        data: &[u8],
        priority: u32,
    ) -> Result<MqSendResult, Errno> {
        let desc = self.descriptors.get(&mqd).ok_or(Errno::EBADF)?;
        if desc.access_mode == O_RDONLY {
            return Err(Errno::EBADF);
        }
        let nonblock = desc.nonblock;

        let queue = self.queues.get_mut(&desc.queue_name).ok_or(Errno::EBADF)?;

        if data.len() > queue.msgsize as usize {
            return Err(Errno::EMSGSIZE);
        }

        if queue.messages.len() >= queue.maxmsg as usize {
            if nonblock {
                return Err(Errno::EAGAIN);
            }
            // In centralized mode, return EAGAIN for host retry
            return Err(Errno::EAGAIN);
        }

        let was_empty = queue.messages.is_empty();

        // Insert maintaining priority order (highest first)
        let msg = MqMessage {
            data: Vec::from(data),
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
    pub fn mq_receive(
        &mut self,
        mqd: u32,
        buf_size: u32,
    ) -> Result<MqRecvResult, Errno> {
        let desc = self.descriptors.get(&mqd).ok_or(Errno::EBADF)?;
        if desc.access_mode == O_WRONLY {
            return Err(Errno::EBADF);
        }
        let nonblock = desc.nonblock;

        let queue = self.queues.get_mut(&desc.queue_name).ok_or(Errno::EBADF)?;

        if buf_size < queue.msgsize {
            return Err(Errno::EMSGSIZE);
        }

        if queue.messages.is_empty() {
            if nonblock {
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
    ) -> Result<(), Errno> {
        let desc = self.descriptors.get(&mqd).ok_or(Errno::EBADF)?;
        let queue = self.queues.get_mut(&desc.queue_name).ok_or(Errno::EBADF)?;

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
                queue.notification = Some(MqNotification { pid, signo: 0 });
                Ok(())
            }
            Some(SIGEV_SIGNAL) => {
                if queue.notification.is_some() {
                    return Err(Errno::EBUSY);
                }
                queue.notification = Some(MqNotification { pid, signo });
                Ok(())
            }
            Some(_) => Err(Errno::EINVAL),
        }
    }

    /// Get/set attributes on a descriptor.
    pub fn mq_getsetattr(
        &mut self,
        mqd: u32,
        new_flags: Option<u32>,
    ) -> Result<MqAttr, Errno> {
        let desc = self.descriptors.get_mut(&mqd).ok_or(Errno::EBADF)?;
        let queue = self.queues.get(&desc.queue_name).ok_or(Errno::EBADF)?;

        let old_flags = if desc.nonblock { O_NONBLOCK } else { 0 };
        let result = MqAttr {
            flags: old_flags,
            maxmsg: queue.maxmsg,
            msgsize: queue.msgsize,
            curmsgs: queue.messages.len() as u32,
        };

        if let Some(flags) = new_flags {
            desc.nonblock = (flags & O_NONBLOCK) != 0;
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
        let mqd = t.mq_open("/test", O_CREAT | O_RDWR, 0o644, 10, 1024, true).unwrap();
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
        assert_eq!(t.mq_open("/nonexist", O_RDONLY, 0, 0, 0, false), Err(Errno::ENOENT));
    }

    #[test]
    fn test_send_receive_priority() {
        let mut t = MqueueTable::new();
        let mqd = t.mq_open("/prio", O_CREAT | O_RDWR, 0o644, 10, 256, true).unwrap();

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
        let mqd = t.mq_open("/nb", O_CREAT | O_RDWR | O_NONBLOCK, 0o644, 2, 64, true).unwrap();

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
        let mqd = t.mq_open("/size", O_CREAT | O_RDWR, 0o644, 10, 4, true).unwrap();

        // Message too large
        assert_eq!(t.mq_send(mqd, b"12345", 1).unwrap_err(), Errno::EMSGSIZE);

        // Buffer too small for receive
        t.mq_send(mqd, b"ok", 1).unwrap();
        assert_eq!(t.mq_receive(mqd, 3).unwrap_err(), Errno::EMSGSIZE);
    }

    #[test]
    fn test_unlink_semantics() {
        let mut t = MqueueTable::new();
        let mqd = t.mq_open("/unl", O_CREAT | O_RDWR, 0o644, 10, 64, true).unwrap();
        t.mq_send(mqd, b"data", 1).unwrap();

        // Unlink while still open
        t.mq_unlink("/unl").unwrap();

        // Can't open it again
        assert_eq!(t.mq_open("/unl", O_RDONLY, 0, 0, 0, false), Err(Errno::ENOENT));

        // But existing descriptor still works
        let msg = t.mq_receive(mqd, 64).unwrap();
        assert_eq!(msg.data, b"data");

        // Close the descriptor — queue should be freed
        t.mq_close(mqd).unwrap();

        // Unlink again should fail
        assert_eq!(t.mq_unlink("/unl"), Err(Errno::ENOENT));
    }

    #[test]
    fn test_notification() {
        let mut t = MqueueTable::new();
        let mqd = t.mq_open("/notif", O_CREAT | O_RDWR, 0o644, 10, 64, true).unwrap();

        // Register notification
        t.mq_notify(mqd, 42, Some(SIGEV_SIGNAL), 10).unwrap();

        // Second registration should EBUSY
        assert_eq!(t.mq_notify(mqd, 43, Some(SIGEV_SIGNAL), 11), Err(Errno::EBUSY));
        assert_eq!(t.mq_notify(mqd, 43, Some(SIGEV_NONE), 0), Err(Errno::EBUSY));

        // Send to empty queue should fire notification
        let result = t.mq_send(mqd, b"hello", 1).unwrap();
        let notif = result.notification.unwrap();
        assert_eq!(notif.pid, 42);
        assert_eq!(notif.signo, 10);

        // Auto-unregistered: second send should NOT fire
        let result = t.mq_send(mqd, b"world", 1).unwrap();
        assert!(result.notification.is_none());

        // Unregister with NULL sev
        t.mq_notify(mqd, 42, Some(SIGEV_SIGNAL), 10).unwrap();
        t.mq_notify(mqd, 42, None, 0).unwrap();
        // Now registration should work again
        t.mq_notify(mqd, 42, Some(SIGEV_SIGNAL), 10).unwrap();
    }

    #[test]
    fn test_getsetattr() {
        let mut t = MqueueTable::new();
        let mqd = t.mq_open("/attr", O_CREAT | O_RDWR, 0o644, 5, 128, true).unwrap();

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
        let mqd = t.mq_open("/cleanup", O_CREAT | O_RDWR, 0o644, 10, 64, true).unwrap();

        t.mq_notify(mqd, 100, Some(SIGEV_SIGNAL), 10).unwrap();

        // Cleanup pid 100 should remove notification
        t.cleanup_process(100);

        // Now registration should succeed
        t.mq_notify(mqd, 200, Some(SIGEV_SIGNAL), 11).unwrap();
    }

    #[test]
    fn test_access_mode_enforcement() {
        let mut t = MqueueTable::new();
        t.mq_open("/ro", O_CREAT | O_RDWR, 0o644, 10, 64, true).unwrap();

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
        assert_eq!(t.mq_send(MQD_BASE + 999, b"x", 1).unwrap_err(), Errno::EBADF);
        assert_eq!(t.mq_receive(MQD_BASE + 999, 64).unwrap_err(), Errno::EBADF);
        assert_eq!(t.mq_notify(MQD_BASE + 999, 1, Some(0), 1).unwrap_err(), Errno::EBADF);
        assert_eq!(t.mq_getsetattr(MQD_BASE + 999, None).unwrap_err(), Errno::EBADF);
    }

    #[test]
    fn test_default_attrs() {
        let mut t = MqueueTable::new();
        // Create without explicit attrs
        let mqd = t.mq_open("/def", O_CREAT | O_RDWR, 0o644, 0, 0, false).unwrap();
        let attr = t.mq_getsetattr(mqd, None).unwrap();
        assert_eq!(attr.maxmsg, DEFAULT_MAXMSG);
        assert_eq!(attr.msgsize, DEFAULT_MSGSIZE);
    }
}
