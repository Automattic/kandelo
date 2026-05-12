extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::cell::UnsafeCell;

// ── host_net_handle cross-process refcount ───────────────────────────────
//
// `SocketInfo::host_net_handle` is a host-side network handle (returned by
// `host_net_connect` / `host_net_accept`). When fork or non-forking-spawn
// gives a child process a SocketInfo carrying this handle, both parent and
// child reference the same host-side connection. The first close-side
// `host_net_close` would then kill the connection for the other process —
// this table refcounts inherited references so only the *last* close
// actually tears down the connection.
//
// Mirrors the `host_handle_fork_ref` / `host_handle_close_ref` pattern in
// `crates/kernel/src/ofd.rs` for plain-file host handles.

struct HostNetRefs(UnsafeCell<Option<BTreeMap<i32, u32>>>);
unsafe impl Sync for HostNetRefs {}

static HOST_NET_REFS: HostNetRefs = HostNetRefs(UnsafeCell::new(None));

fn get_host_net_refs() -> &'static mut BTreeMap<i32, u32> {
    let opt = unsafe { &mut *HOST_NET_REFS.0.get() };
    opt.get_or_insert_with(BTreeMap::new)
}

/// Register that a host net handle is now shared by one more process
/// (fork or spawn child). If the handle is being inherited for the first
/// time, sets the count to 2 (parent + child). Otherwise increments by 1.
pub fn host_net_handle_fork_ref(h: i32) {
    let refs = get_host_net_refs();
    let count = refs.entry(h).or_insert(1); // 1 = the parent already has it
    *count += 1; // +1 for the child
}

/// Decrement the cross-process refcount for a host net handle. Returns
/// `true` if `host_net_close` should now run (the count reached 0, or the
/// handle was never shared in the first place).
pub fn host_net_handle_close_ref(h: i32) -> bool {
    let refs = get_host_net_refs();
    if let Some(count) = refs.get_mut(&h) {
        *count -= 1;
        if *count == 0 {
            refs.remove(&h);
            return true;
        }
        return false;
    }
    // Not in the table → single owner, safe to close.
    true
}

#[cfg(test)]
pub fn host_net_handle_ref_count(h: i32) -> u32 {
    get_host_net_refs().get(&h).copied().unwrap_or(0)
}

/// Socket address family.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketDomain {
    Unix,
    Inet,
    Inet6,
}

/// Socket type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketType {
    Stream,
    Dgram,
}

/// Socket connection state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketState {
    Unbound,
    Bound,
    Listening,
    Connected,
    Closed,
}

/// A received UDP datagram.
#[derive(Clone)]
pub struct Datagram {
    pub data: Vec<u8>,
    pub src_addr: [u8; 4],
    pub src_port: u16,
}

/// Per-socket kernel state.
///
/// `Clone` is hand-written (not derived) so that fork/spawn cloning
/// discards consume-once state that should not double-fire in the child.
/// See the `impl Clone for SocketInfo` block below for which fields are
/// reset.
pub struct SocketInfo {
    pub domain: SocketDomain,
    pub sock_type: SocketType,
    pub protocol: u32,
    pub state: SocketState,
    /// Index of peer socket (for connected Unix domain pairs).
    pub peer_idx: Option<usize>,
    /// Index into Process.pipes for the receive buffer.
    pub recv_buf_idx: Option<usize>,
    /// Index into Process.pipes for the send buffer.
    pub send_buf_idx: Option<usize>,
    /// Whether the read half has been shut down.
    pub shut_rd: bool,
    /// Whether the write half has been shut down.
    pub shut_wr: bool,
    /// Host-side network handle for AF_INET sockets (assigned on connect).
    pub host_net_handle: Option<i32>,
    /// Stored socket options as (level, optname, value) tuples.
    pub options: Vec<(u32, u32, u32)>,
    /// Bound IPv4 address (for AF_INET sockets).
    pub bind_addr: [u8; 4],
    /// Bound port (for AF_INET sockets).
    pub bind_port: u16,
    /// Peer IPv4 address (for connected AF_INET sockets).
    pub peer_addr: [u8; 4],
    /// Peer port (for connected AF_INET sockets).
    pub peer_port: u16,
    /// Pending connection socket indices (for listening sockets).
    /// Used by AF_UNIX same-process sys_connect, which pre-allocates the
    /// accepted SocketInfo and pushes its index here.
    pub listen_backlog: Vec<usize>,
    /// Index into the global SHARED_LISTENER_BACKLOG_TABLE for AF_INET
    /// listening sockets. Set by sys_listen for INET sockets so all
    /// fork-inherited copies of the listener share a single accept queue.
    /// `None` for AF_UNIX or before listen() is called.
    pub shared_backlog_idx: Option<usize>,
    /// Received UDP datagrams (for DGRAM sockets).
    pub dgram_queue: Vec<Datagram>,
    /// Whether recv/send pipe indices refer to the global pipe table
    /// (cross-process loopback) rather than process-local pipes.
    pub global_pipes: bool,
    /// Out-of-band byte (if pending). Set by peer's send(MSG_OOB),
    /// read by recv(MSG_OOB), queried by ioctl(SIOCATMARK).
    pub oob_byte: Option<u8>,
    /// Receive timeout in microseconds (0 = no timeout).
    pub recv_timeout_us: u64,
    /// Send timeout in microseconds (0 = no timeout).
    pub send_timeout_us: u64,
    /// Bound filesystem path for AF_UNIX sockets.
    pub bind_path: Option<Vec<u8>>,
}

impl SocketInfo {
    pub fn new(domain: SocketDomain, sock_type: SocketType, protocol: u32) -> Self {
        SocketInfo {
            domain,
            sock_type,
            protocol,
            state: SocketState::Unbound,
            peer_idx: None,
            recv_buf_idx: None,
            send_buf_idx: None,
            shut_rd: false,
            shut_wr: false,
            host_net_handle: None,
            options: Vec::new(),
            bind_addr: [0; 4],
            bind_port: 0,
            peer_addr: [0; 4],
            peer_port: 0,
            listen_backlog: Vec::new(),
            shared_backlog_idx: None,
            dgram_queue: Vec::new(),
            global_pipes: false,
            oob_byte: None,
            recv_timeout_us: 0,
            send_timeout_us: 0,
            bind_path: None,
        }
    }

    /// Set or update a stored socket option.
    pub fn set_option(&mut self, level: u32, optname: u32, value: u32) {
        for opt in self.options.iter_mut() {
            if opt.0 == level && opt.1 == optname {
                opt.2 = value;
                return;
            }
        }
        self.options.push((level, optname, value));
    }

    /// Get a stored socket option value.
    pub fn get_option(&self, level: u32, optname: u32) -> Option<u32> {
        for opt in &self.options {
            if opt.0 == level && opt.1 == optname {
                return Some(opt.2);
            }
        }
        None
    }
}

/// Hand-written so fork/spawn child inheritance discards consume-once
/// state. POSIX-wise these are properties of the underlying connection
/// (one OOB byte per socket; one queue of pending datagrams; one queue
/// of pending AF_UNIX same-process pre-accepted connections), but our
/// per-process SocketInfo can't truly share — duplicating them would let
/// both parent and child consume the "same" data.
///
/// Discarded in the child:
///   * `dgram_queue` — buffered UDP datagrams.
///   * `oob_byte` — pending TCP out-of-band byte.
///   * `listen_backlog` — pre-accepted AF_UNIX same-process connections.
///     Indices reference other entries in this process's SocketTable; if
///     both parent and child kept them, both could `accept()` the same
///     pending connection. After fork/spawn, the parent retains them;
///     child gets fresh state. New connections that arrive post-fork are
///     added to whichever process the connecting peer wires up to.
///
/// Everything else is value-cloned. `host_net_handle` and
/// `shared_backlog_idx` are still inherited; the cross-process refcount
/// bumps for those live in `process_table::bump_inherited_resource_refcounts`.
impl Clone for SocketInfo {
    fn clone(&self) -> Self {
        SocketInfo {
            domain: self.domain,
            sock_type: self.sock_type,
            protocol: self.protocol,
            state: self.state,
            peer_idx: self.peer_idx,
            recv_buf_idx: self.recv_buf_idx,
            send_buf_idx: self.send_buf_idx,
            shut_rd: self.shut_rd,
            shut_wr: self.shut_wr,
            host_net_handle: self.host_net_handle,
            options: self.options.clone(),
            bind_addr: self.bind_addr,
            bind_port: self.bind_port,
            peer_addr: self.peer_addr,
            peer_port: self.peer_port,
            listen_backlog: Vec::new(), // consume-once: don't double-accept
            shared_backlog_idx: self.shared_backlog_idx,
            dgram_queue: Vec::new(),    // consume-once: don't double-deliver
            global_pipes: self.global_pipes,
            oob_byte: None,             // consume-once: don't double-deliver
            recv_timeout_us: self.recv_timeout_us,
            send_timeout_us: self.send_timeout_us,
            bind_path: self.bind_path.clone(),
        }
    }
}

/// Table of socket state, indexed by socket slot.
#[derive(Clone)]
pub struct SocketTable {
    entries: Vec<Option<SocketInfo>>,
}

impl SocketTable {
    pub fn new() -> Self {
        SocketTable {
            entries: Vec::new(),
        }
    }

    /// Allocate a slot for a new socket. Reuses freed slots.
    pub fn alloc(&mut self, info: SocketInfo) -> usize {
        for i in 0..self.entries.len() {
            if self.entries[i].is_none() {
                self.entries[i] = Some(info);
                return i;
            }
        }
        let idx = self.entries.len();
        self.entries.push(Some(info));
        idx
    }

    /// Free a socket slot.
    pub fn free(&mut self, idx: usize) {
        if idx < self.entries.len() {
            self.entries[idx] = None;
        }
    }

    /// Get a reference to socket info at `idx`.
    pub fn get(&self, idx: usize) -> Option<&SocketInfo> {
        self.entries.get(idx).and_then(|s| s.as_ref())
    }

    /// Get a mutable reference to socket info at `idx`.
    pub fn get_mut(&mut self, idx: usize) -> Option<&mut SocketInfo> {
        self.entries.get_mut(idx).and_then(|s| s.as_mut())
    }

    /// Return the number of slots (for iteration).
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Insert a socket at a specific index, growing the table if needed.
    /// Used during fork deserialization to preserve socket indices.
    pub fn insert_at(&mut self, idx: usize, info: SocketInfo) {
        while self.entries.len() <= idx {
            self.entries.push(None);
        }
        self.entries[idx] = Some(info);
    }
}

// ── Shared listener backlog (cross-process accept queue) ──
//
// In real Linux, a listening socket inherited via fork() shares a single
// accept queue across parent and children — any process can accept a
// pending connection. Our SocketInfo lives in per-process tables, so a
// naive fork+accept model would give each process its own backlog. To
// match POSIX semantics for AF_INET listeners (the typical fork-server
// pattern: nginx master + workers), we keep the actual pending queue
// in this global table and reference it by index from each forked
// SocketInfo copy.
//
// AF_UNIX same-process listeners still use the inline `listen_backlog`
// field (sys_connect pre-allocates the accepted SocketInfo there).

/// A pending TCP connection waiting in a shared accept queue.
pub struct PendingConnection {
    pub peer_addr: [u8; 4],
    pub peer_port: u16,
    /// Recv pipe index (in the global pipe table). Host writes incoming
    /// TCP data here; the accepting process reads from it.
    pub recv_pipe_idx: usize,
    /// Send pipe index (in the global pipe table). The accepting
    /// process writes outgoing TCP data here; host reads and forwards.
    pub send_pipe_idx: usize,
}

/// One slot in the shared backlog table.
pub struct SharedBacklog {
    pub queue: Vec<PendingConnection>,
    /// Number of SocketInfos referencing this slot. When a listener is
    /// fork-inherited, the child's copy adds a reference; close()/free
    /// drops one. The slot is freed when ref_count reaches 0.
    pub ref_count: u32,
    /// True when the slot is allocated; false when freed and reusable.
    pub in_use: bool,
}

pub struct SharedBacklogTable {
    pub entries: Vec<SharedBacklog>,
}

impl SharedBacklogTable {
    pub const fn new() -> Self {
        SharedBacklogTable { entries: Vec::new() }
    }

    /// Allocate a new shared backlog slot, reusing freed slots.
    /// Returns the slot index. The slot starts with ref_count=1.
    pub fn alloc(&mut self) -> usize {
        for i in 0..self.entries.len() {
            if !self.entries[i].in_use {
                self.entries[i].queue.clear();
                self.entries[i].ref_count = 1;
                self.entries[i].in_use = true;
                return i;
            }
        }
        let idx = self.entries.len();
        self.entries.push(SharedBacklog { queue: Vec::new(), ref_count: 1, in_use: true });
        idx
    }

    /// Increment the reference count. Called when a fork-child inherits
    /// a listener that already has a shared backlog.
    pub fn add_ref(&mut self, idx: usize) {
        if let Some(entry) = self.entries.get_mut(idx) {
            if entry.in_use {
                entry.ref_count = entry.ref_count.saturating_add(1);
            }
        }
    }

    /// Decrement the reference count. If it reaches zero, free the slot
    /// (queue is dropped — pending connections are lost, matching what
    /// happens when the last process holding a listener fd closes it).
    pub fn dec_ref(&mut self, idx: usize) {
        if let Some(entry) = self.entries.get_mut(idx) {
            if !entry.in_use { return; }
            entry.ref_count = entry.ref_count.saturating_sub(1);
            if entry.ref_count == 0 {
                entry.queue.clear();
                entry.in_use = false;
            }
        }
    }

    /// Push a pending connection. Returns true on success.
    pub fn push(&mut self, idx: usize, pc: PendingConnection) -> bool {
        if let Some(entry) = self.entries.get_mut(idx) {
            if entry.in_use {
                entry.queue.push(pc);
                return true;
            }
        }
        false
    }

    /// Pop the oldest pending connection.
    pub fn pop(&mut self, idx: usize) -> Option<PendingConnection> {
        let entry = self.entries.get_mut(idx)?;
        if entry.in_use && !entry.queue.is_empty() {
            Some(entry.queue.remove(0))
        } else {
            None
        }
    }

    /// Returns the number of pending connections, or 0 if the slot is invalid.
    pub fn len(&self, idx: usize) -> usize {
        self.entries.get(idx)
            .map(|e| if e.in_use { e.queue.len() } else { 0 })
            .unwrap_or(0)
    }
}

pub struct GlobalSharedBacklogTable(pub UnsafeCell<SharedBacklogTable>);
unsafe impl Sync for GlobalSharedBacklogTable {}

pub static SHARED_LISTENER_BACKLOG_TABLE: GlobalSharedBacklogTable =
    GlobalSharedBacklogTable(UnsafeCell::new(SharedBacklogTable::new()));

/// SAFETY: kernel runs single-threaded; callers must not hold a previous
/// reference across calls.
pub unsafe fn shared_listener_backlog_table() -> &'static mut SharedBacklogTable {
    unsafe { &mut *SHARED_LISTENER_BACKLOG_TABLE.0.get() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_socket_info() {
        let sock = SocketInfo::new(SocketDomain::Unix, SocketType::Stream, 0);
        assert_eq!(sock.domain, SocketDomain::Unix);
        assert_eq!(sock.sock_type, SocketType::Stream);
        assert_eq!(sock.state, SocketState::Unbound);
        assert_eq!(sock.peer_idx, None);
    }

    #[test]
    fn test_socket_table_alloc() {
        let mut table = SocketTable::new();
        let idx = table.alloc(SocketInfo::new(SocketDomain::Unix, SocketType::Stream, 0));
        assert_eq!(idx, 0);
        assert!(table.get(idx).is_some());
    }

    #[test]
    fn test_socket_table_free() {
        let mut table = SocketTable::new();
        let idx = table.alloc(SocketInfo::new(SocketDomain::Unix, SocketType::Stream, 0));
        table.free(idx);
        assert!(table.get(idx).is_none());
    }

    #[test]
    fn test_socket_table_slot_reuse() {
        let mut table = SocketTable::new();
        let idx0 = table.alloc(SocketInfo::new(SocketDomain::Unix, SocketType::Stream, 0));
        table.free(idx0);
        let idx1 = table.alloc(SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 0));
        assert_eq!(idx0, idx1);
    }

    #[test]
    fn test_socket_state_transitions() {
        let mut sock = SocketInfo::new(SocketDomain::Unix, SocketType::Stream, 0);
        assert_eq!(sock.state, SocketState::Unbound);
        sock.state = SocketState::Connected;
        assert_eq!(sock.state, SocketState::Connected);
    }
}
