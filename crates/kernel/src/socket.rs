extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::cell::UnsafeCell;
use wasm_posix_shared::Errno;

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
    /// Host-delegated connect kicked off, TCP handshake not yet completed.
    Connecting,
    Connected,
    Closed,
}

/// A received UDP datagram.
#[derive(Clone)]
pub struct Datagram {
    pub data: Vec<u8>,
    pub src_addr: [u8; 4],
    pub src_addr6: [u8; 16],
    pub dst_addr: [u8; 4],
    pub dst_addr6: [u8; 16],
    pub src_port: u16,
    pub src_sock_idx: Option<usize>,
    /// IPv6 traffic class associated with this datagram.
    pub ipv6_tclass: u32,
    /// Sender credentials captured when the datagram was queued. AF_UNIX
    /// SO_PASSCRED reports these with SCM_CREDENTIALS.
    pub src_pid: u32,
    pub src_uid: u32,
    pub src_gid: u32,
    /// Ancillary file descriptors sent with this datagram via SCM_RIGHTS.
    pub ancillary_fds: Vec<crate::pipe::InFlightFd>,
}

/// One process-local delivery target for an AF_INET UDP binding.
///
/// A logical binding can have more than one target after fork/spawn. The
/// binding table keeps those owners together so closing one inherited copy
/// does not release the port while another process still owns the socket.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UdpEndpoint {
    pub pid: u32,
    pub sock_idx: usize,
    pub addr: [u8; 4],
    pub port: u16,
    pub reuse_addr: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct BindingOwner {
    pid: u32,
    sock_idx: usize,
}

trait HasBindingOwners {
    fn owners(&self) -> &[BindingOwner];
    fn owners_mut(&mut self) -> &mut Vec<BindingOwner>;
}

fn remove_binding_owner<T: HasBindingOwners>(bindings: &mut Vec<T>, pid: u32, sock_idx: usize) {
    for binding in bindings.iter_mut() {
        binding
            .owners_mut()
            .retain(|owner| owner.pid != pid || owner.sock_idx != sock_idx);
    }
    bindings.retain(|binding| !binding.owners().is_empty());
}

fn cleanup_binding_owner_pid<T: HasBindingOwners>(bindings: &mut Vec<T>, pid: u32) {
    for binding in bindings.iter_mut() {
        binding.owners_mut().retain(|owner| owner.pid != pid);
    }
    bindings.retain(|binding| !binding.owners().is_empty());
}

fn inherit_binding_owner<T: HasBindingOwners>(
    bindings: &mut [T],
    parent: BindingOwner,
    child: BindingOwner,
) {
    for binding in bindings.iter_mut() {
        if binding.owners().contains(&parent) && !binding.owners().contains(&child) {
            binding.owners_mut().push(child);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct UdpBinding {
    owners: Vec<BindingOwner>,
    addr: [u8; 4],
    port: u16,
    reuse_addr: bool,
}

impl HasBindingOwners for UdpBinding {
    fn owners(&self) -> &[BindingOwner] {
        &self.owners
    }

    fn owners_mut(&mut self) -> &mut Vec<BindingOwner> {
        &mut self.owners
    }
}

/// IPv4 multicast group state for an AF_INET datagram socket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ipv4MulticastMembership {
    pub group: [u8; 4],
    /// Interface address used for matching local delivery. 0.0.0.0 means the
    /// kernel default interface. 127.0.0.1 represents loopback.
    pub interface_addr: [u8; 4],
    pub any_source: bool,
    pub blocked_sources: Vec<[u8; 4]>,
    pub included_sources: Vec<[u8; 4]>,
}

struct UdpEndpointTable(UnsafeCell<Option<Vec<UdpBinding>>>);
unsafe impl Sync for UdpEndpointTable {}

static UDP_ENDPOINTS: UdpEndpointTable = UdpEndpointTable(UnsafeCell::new(None));

fn udp_bindings() -> &'static mut Vec<UdpBinding> {
    let opt = unsafe { &mut *UDP_ENDPOINTS.0.get() };
    opt.get_or_insert_with(Vec::new)
}

fn udp_addr_conflicts(a: [u8; 4], b: [u8; 4]) -> bool {
    a == [0, 0, 0, 0] || b == [0, 0, 0, 0] || a == b
}

fn udp_addr_matches(bound: [u8; 4], dst: [u8; 4]) -> bool {
    bound == [0, 0, 0, 0] || bound == dst
}

pub fn udp_can_bind(pid: u32, sock_idx: usize, addr: [u8; 4], port: u16, reuse_addr: bool) -> bool {
    for binding in udp_bindings().iter() {
        let caller_owns_binding = binding
            .owners
            .iter()
            .any(|owner| owner.pid == pid && owner.sock_idx == sock_idx);
        // Binding this same process-local socket replaces its prior table
        // entry. Ignore that entry only when detaching this owner would
        // remove it; inherited peers keep the logical reservation live.
        if caller_owns_binding && binding.owners.len() == 1 {
            continue;
        }
        if binding.port == port
            && udp_addr_conflicts(binding.addr, addr)
            && !(binding.reuse_addr && reuse_addr)
        {
            return false;
        }
    }
    true
}

pub fn udp_register(
    pid: u32,
    sock_idx: usize,
    addr: [u8; 4],
    port: u16,
    reuse_addr: bool,
) -> Result<(), Errno> {
    if port == 0 {
        return Err(Errno::EINVAL);
    }
    if udp_bindings().iter().any(|binding| {
        binding.addr == addr
            && binding.port == port
            && binding.reuse_addr == reuse_addr
            && binding
                .owners
                .iter()
                .any(|owner| owner.pid == pid && owner.sock_idx == sock_idx)
    }) {
        return Ok(());
    }
    if !udp_can_bind(pid, sock_idx, addr, port, reuse_addr) {
        return Err(Errno::EADDRINUSE);
    }
    remove_binding_owner(udp_bindings(), pid, sock_idx);
    udp_bindings().push(UdpBinding {
        owners: alloc::vec![BindingOwner { pid, sock_idx }],
        addr,
        port,
        reuse_addr,
    });
    Ok(())
}

pub fn udp_unregister(pid: u32, sock_idx: usize) {
    remove_binding_owner(udp_bindings(), pid, sock_idx);
}

pub fn udp_cleanup_process(pid: u32) {
    cleanup_binding_owner_pid(udp_bindings(), pid);
}

pub fn udp_lookup(dst_addr: [u8; 4], dst_port: u16) -> Vec<UdpEndpoint> {
    udp_bindings()
        .iter()
        .filter(|binding| binding.port == dst_port && udp_addr_matches(binding.addr, dst_addr))
        .flat_map(|binding| {
            binding.owners.iter().map(|owner| UdpEndpoint {
                pid: owner.pid,
                sock_idx: owner.sock_idx,
                addr: binding.addr,
                port: binding.port,
                reuse_addr: binding.reuse_addr,
            })
        })
        .collect()
}

/// One AF_INET6 UDP endpoint bound in the in-kernel loopback network.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Udp6Endpoint {
    pub pid: u32,
    pub sock_idx: usize,
    pub addr: [u8; 16],
    pub port: u16,
    pub reuse_addr: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Udp6Binding {
    owners: Vec<BindingOwner>,
    addr: [u8; 16],
    port: u16,
    reuse_addr: bool,
}

impl HasBindingOwners for Udp6Binding {
    fn owners(&self) -> &[BindingOwner] {
        &self.owners
    }

    fn owners_mut(&mut self) -> &mut Vec<BindingOwner> {
        &mut self.owners
    }
}

struct Udp6EndpointTable(UnsafeCell<Option<Vec<Udp6Binding>>>);
unsafe impl Sync for Udp6EndpointTable {}

static UDP6_ENDPOINTS: Udp6EndpointTable = Udp6EndpointTable(UnsafeCell::new(None));

fn udp6_bindings() -> &'static mut Vec<Udp6Binding> {
    let opt = unsafe { &mut *UDP6_ENDPOINTS.0.get() };
    opt.get_or_insert_with(Vec::new)
}

fn udp6_addr_conflicts(a: [u8; 16], b: [u8; 16]) -> bool {
    a == [0; 16] || b == [0; 16] || a == b
}

fn udp6_addr_matches(bound: [u8; 16], dst: [u8; 16]) -> bool {
    bound == [0; 16] || bound == dst
}

pub fn udp6_can_bind(
    pid: u32,
    sock_idx: usize,
    addr: [u8; 16],
    port: u16,
    reuse_addr: bool,
) -> bool {
    udp6_bindings().iter().all(|binding| {
        let caller_owns_binding = binding
            .owners
            .iter()
            .any(|owner| owner.pid == pid && owner.sock_idx == sock_idx);
        (caller_owns_binding && binding.owners.len() == 1)
            || binding.port != port
            || !udp6_addr_conflicts(binding.addr, addr)
            || (binding.reuse_addr && reuse_addr)
    })
}

pub fn udp6_register(
    pid: u32,
    sock_idx: usize,
    addr: [u8; 16],
    port: u16,
    reuse_addr: bool,
) -> Result<(), Errno> {
    if port == 0 {
        return Err(Errno::EINVAL);
    }
    if udp6_bindings().iter().any(|binding| {
        binding.addr == addr
            && binding.port == port
            && binding.reuse_addr == reuse_addr
            && binding
                .owners
                .iter()
                .any(|owner| owner.pid == pid && owner.sock_idx == sock_idx)
    }) {
        return Ok(());
    }
    if !udp6_can_bind(pid, sock_idx, addr, port, reuse_addr) {
        return Err(Errno::EADDRINUSE);
    }
    remove_binding_owner(udp6_bindings(), pid, sock_idx);
    udp6_bindings().push(Udp6Binding {
        owners: alloc::vec![BindingOwner { pid, sock_idx }],
        addr,
        port,
        reuse_addr,
    });
    Ok(())
}

pub fn udp6_unregister(pid: u32, sock_idx: usize) {
    remove_binding_owner(udp6_bindings(), pid, sock_idx);
}

pub fn udp6_cleanup_process(pid: u32) {
    cleanup_binding_owner_pid(udp6_bindings(), pid);
}

pub fn udp6_lookup(dst_addr: [u8; 16], dst_port: u16) -> Vec<Udp6Endpoint> {
    udp6_bindings()
        .iter()
        .filter(|binding| binding.port == dst_port && udp6_addr_matches(binding.addr, dst_addr))
        .flat_map(|binding| {
            binding.owners.iter().map(|owner| Udp6Endpoint {
                pid: owner.pid,
                sock_idx: owner.sock_idx,
                addr: binding.addr,
                port: binding.port,
                reuse_addr: binding.reuse_addr,
            })
        })
        .collect()
}

/// One AF_INET TCP socket bound in the kernel-visible address table.
#[derive(Clone, Debug, PartialEq, Eq)]
struct TcpBinding {
    owners: Vec<BindingOwner>,
    addr: [u8; 4],
    port: u16,
}

impl HasBindingOwners for TcpBinding {
    fn owners(&self) -> &[BindingOwner] {
        &self.owners
    }

    fn owners_mut(&mut self) -> &mut Vec<BindingOwner> {
        &mut self.owners
    }
}

struct TcpBindingTable(UnsafeCell<Option<Vec<TcpBinding>>>);
unsafe impl Sync for TcpBindingTable {}

static TCP_BINDINGS: TcpBindingTable = TcpBindingTable(UnsafeCell::new(None));

fn tcp_bindings() -> &'static mut Vec<TcpBinding> {
    let opt = unsafe { &mut *TCP_BINDINGS.0.get() };
    opt.get_or_insert_with(Vec::new)
}

fn tcp_addr_conflicts(a: [u8; 4], b: [u8; 4]) -> bool {
    a == [0, 0, 0, 0] || b == [0, 0, 0, 0] || a == b
}

pub fn tcp_can_bind(pid: u32, sock_idx: usize, addr: [u8; 4], port: u16) -> bool {
    for binding in tcp_bindings().iter() {
        let caller_owns_binding = binding
            .owners
            .iter()
            .any(|owner| owner.pid == pid && owner.sock_idx == sock_idx);
        if caller_owns_binding && binding.owners.len() == 1 {
            continue;
        }
        if binding.port == port && tcp_addr_conflicts(binding.addr, addr) {
            return false;
        }
    }
    true
}

pub fn tcp_register(pid: u32, sock_idx: usize, addr: [u8; 4], port: u16) -> Result<(), Errno> {
    if port == 0 {
        return Err(Errno::EINVAL);
    }
    if tcp_bindings().iter().any(|binding| {
        binding.addr == addr
            && binding.port == port
            && binding
                .owners
                .iter()
                .any(|owner| owner.pid == pid && owner.sock_idx == sock_idx)
    }) {
        return Ok(());
    }
    if !tcp_can_bind(pid, sock_idx, addr, port) {
        return Err(Errno::EADDRINUSE);
    }
    remove_binding_owner(tcp_bindings(), pid, sock_idx);
    tcp_bindings().push(TcpBinding {
        owners: alloc::vec![BindingOwner { pid, sock_idx }],
        addr,
        port,
    });
    Ok(())
}

pub fn tcp_unregister(pid: u32, sock_idx: usize) {
    remove_binding_owner(tcp_bindings(), pid, sock_idx);
}

pub fn tcp_cleanup_process(pid: u32) {
    cleanup_binding_owner_pid(tcp_bindings(), pid);
}

/// One AF_INET6 TCP socket bound in the kernel-visible address table. IPv6
/// bindings are tracked separately from IPv4; a dual-stack wildcard also
/// reserves the IPv4 wildcard through `tcp_register`.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Tcp6Binding {
    owners: Vec<BindingOwner>,
    addr: [u8; 16],
    port: u16,
}

impl HasBindingOwners for Tcp6Binding {
    fn owners(&self) -> &[BindingOwner] {
        &self.owners
    }

    fn owners_mut(&mut self) -> &mut Vec<BindingOwner> {
        &mut self.owners
    }
}

struct Tcp6BindingTable(UnsafeCell<Option<Vec<Tcp6Binding>>>);
unsafe impl Sync for Tcp6BindingTable {}

static TCP6_BINDINGS: Tcp6BindingTable = Tcp6BindingTable(UnsafeCell::new(None));

fn tcp6_bindings() -> &'static mut Vec<Tcp6Binding> {
    let opt = unsafe { &mut *TCP6_BINDINGS.0.get() };
    opt.get_or_insert_with(Vec::new)
}

fn tcp6_addr_conflicts(a: [u8; 16], b: [u8; 16]) -> bool {
    a == [0; 16] || b == [0; 16] || a == b
}

pub fn tcp6_can_bind(pid: u32, sock_idx: usize, addr: [u8; 16], port: u16) -> bool {
    tcp6_bindings().iter().all(|binding| {
        let caller_owns_binding = binding
            .owners
            .iter()
            .any(|owner| owner.pid == pid && owner.sock_idx == sock_idx);
        (caller_owns_binding && binding.owners.len() == 1)
            || binding.port != port
            || !tcp6_addr_conflicts(binding.addr, addr)
    })
}

pub fn tcp6_register(
    pid: u32,
    sock_idx: usize,
    addr: [u8; 16],
    port: u16,
) -> Result<(), Errno> {
    if port == 0 {
        return Err(Errno::EINVAL);
    }
    if tcp6_bindings().iter().any(|binding| {
        binding.addr == addr
            && binding.port == port
            && binding
                .owners
                .iter()
                .any(|owner| owner.pid == pid && owner.sock_idx == sock_idx)
    }) {
        return Ok(());
    }
    if !tcp6_can_bind(pid, sock_idx, addr, port) {
        return Err(Errno::EADDRINUSE);
    }
    remove_binding_owner(tcp6_bindings(), pid, sock_idx);
    tcp6_bindings().push(Tcp6Binding {
        owners: alloc::vec![BindingOwner { pid, sock_idx }],
        addr,
        port,
    });
    Ok(())
}

pub fn tcp6_unregister(pid: u32, sock_idx: usize) {
    remove_binding_owner(tcp6_bindings(), pid, sock_idx);
}

pub fn tcp6_cleanup_process(pid: u32) {
    cleanup_binding_owner_pid(tcp6_bindings(), pid);
}

/// Add a fork/spawn child's process-local socket identity to every INET
/// binding owned by the corresponding parent socket.
///
/// A dual-stack listener deliberately appears in both the IPv6 and IPv4 TCP
/// tables; walking all four tables preserves both halves as one inherited
/// socket. SO_REUSEADDR UDP bindings remain separate logical entries because
/// ownership is copied only from the exact parent `(pid, sock_idx)` identity.
pub fn inherit_inet_binding_owners(parent_pid: u32, child_pid: u32, sock_idx: usize) {
    let parent = BindingOwner {
        pid: parent_pid,
        sock_idx,
    };
    let child = BindingOwner {
        pid: child_pid,
        sock_idx,
    };
    inherit_binding_owner(udp_bindings(), parent, child);
    inherit_binding_owner(udp6_bindings(), parent, child);
    inherit_binding_owner(tcp_bindings(), parent, child);
    inherit_binding_owner(tcp6_bindings(), parent, child);
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
    /// Index into the global pipe table for the receive buffer.
    pub recv_buf_idx: Option<usize>,
    /// Index into the global pipe table for the send buffer.
    pub send_buf_idx: Option<usize>,
    /// Whether the read half has been shut down.
    pub shut_rd: bool,
    /// Whether the write half has been shut down.
    pub shut_wr: bool,
    /// Host-side network handle for AF_INET sockets (assigned on connect).
    pub host_net_handle: Option<i32>,
    /// Stored socket options as (level, optname, value) tuples.
    pub options: Vec<(u32, u32, u32)>,
    /// SO_LINGER state. This is a structured option (`struct linger`), so it
    /// is kept separately from integer-valued socket options.
    pub linger_onoff: i32,
    pub linger_seconds: i32,
    /// SO_BINDTODEVICE binds a socket to a named virtual network interface.
    pub bind_device: Option<Vec<u8>>,
    /// TCP_CONGESTION algorithm name for this socket. Kandelo's virtual TCP
    /// stack currently exposes the standard Linux default, "cubic".
    pub tcp_congestion: Vec<u8>,
    /// Bound IPv4 address (for AF_INET sockets).
    pub bind_addr: [u8; 4],
    /// Bound IPv6 address (for AF_INET6 sockets).
    pub bind_addr6: [u8; 16],
    /// Bound port (for AF_INET sockets).
    pub bind_port: u16,
    /// Peer IPv4 address (for connected AF_INET sockets).
    pub peer_addr: [u8; 4],
    /// Peer IPv6 address (for connected AF_INET6 sockets).
    pub peer_addr6: [u8; 16],
    /// Peer port (for connected AF_INET sockets).
    pub peer_port: u16,
    /// Pending connection socket indices (for listening sockets).
    /// Used by AF_UNIX same-process sys_connect, which pre-allocates the
    /// accepted SocketInfo and pushes its index here.
    pub listen_backlog: Vec<usize>,
    /// Index into the global SHARED_LISTENER_BACKLOG_TABLE for AF_INET/AF_INET6
    /// listening sockets. Set by sys_listen for INET sockets so all
    /// fork-inherited copies of the listener share a single accept queue.
    /// `None` for AF_UNIX or before listen() is called.
    pub shared_backlog_idx: Option<usize>,
    /// Host-visible wake token for listener readiness. Assigned by listen()
    /// and cloned across fork/spawn so every inherited listener fd waits on
    /// the same accept-readiness event.
    pub accept_wake_idx: Option<u32>,
    /// Received UDP datagrams (for DGRAM sockets).
    pub dgram_queue: Vec<Datagram>,
    /// Joined IPv4 multicast groups and source filters.
    pub ipv4_multicast_memberships: Vec<Ipv4MulticastMembership>,
    /// Received netlink datagrams. Netlink sockets are datagram-like and are
    /// used by musl for route/interface enumeration.
    pub netlink_queue: Vec<Vec<u8>>,
    /// Whether recv/send pipe indices refer to the global pipe table. Kept in
    /// serialized state for compatibility; runtime socket buffers are global.
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
    /// Errno cached from a failed host-delegated connect; read and cleared
    /// by SO_ERROR (Linux semantics). 0 means no error.
    pub connect_error: u32,
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
            linger_onoff: 0,
            linger_seconds: 0,
            bind_device: None,
            tcp_congestion: b"cubic".to_vec(),
            bind_addr: [0; 4],
            bind_addr6: [0; 16],
            bind_port: 0,
            peer_addr: [0; 4],
            peer_addr6: [0; 16],
            peer_port: 0,
            listen_backlog: Vec::new(),
            shared_backlog_idx: None,
            accept_wake_idx: None,
            dgram_queue: Vec::new(),
            ipv4_multicast_memberships: Vec::new(),
            netlink_queue: Vec::new(),
            global_pipes: true,
            oob_byte: None,
            recv_timeout_us: 0,
            send_timeout_us: 0,
            bind_path: None,
            connect_error: 0,
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
            linger_onoff: self.linger_onoff,
            linger_seconds: self.linger_seconds,
            bind_device: self.bind_device.clone(),
            tcp_congestion: self.tcp_congestion.clone(),
            bind_addr: self.bind_addr,
            bind_addr6: self.bind_addr6,
            bind_port: self.bind_port,
            peer_addr: self.peer_addr,
            peer_addr6: self.peer_addr6,
            peer_port: self.peer_port,
            listen_backlog: Vec::new(), // consume-once: don't double-accept
            shared_backlog_idx: self.shared_backlog_idx,
            accept_wake_idx: self.accept_wake_idx,
            dgram_queue: Vec::new(), // consume-once: don't double-deliver
            ipv4_multicast_memberships: self.ipv4_multicast_memberships.clone(),
            netlink_queue: Vec::new(), // consume-once: don't double-deliver
            global_pipes: self.global_pipes,
            oob_byte: None, // consume-once: don't double-deliver
            recv_timeout_us: self.recv_timeout_us,
            send_timeout_us: self.send_timeout_us,
            bind_path: self.bind_path.clone(),
            connect_error: 0, // fork transitions Connecting → Closed; no error to inherit
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
// match POSIX semantics for AF_INET/AF_INET6 listeners (the typical fork-server
// pattern: nginx master + workers), we keep the actual pending queue
// in this global table and reference it by index from each forked
// SocketInfo copy.
//
// AF_UNIX same-process listeners still use the inline `listen_backlog`
// field (sys_connect pre-allocates the accepted SocketInfo there).

/// A pending TCP connection waiting in a shared accept queue.
pub struct PendingConnection {
    pub peer_addr: [u8; 4],
    pub peer_addr6: [u8; 16],
    /// True when `peer_addr6` is a native IPv6 source. For an IPv4 peer
    /// accepted by a dual-stack IPv6 listener this is false and `peer_addr`
    /// is converted to an IPv4-mapped address at accept time.
    pub peer_is_ipv6: bool,
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
        SharedBacklogTable {
            entries: Vec::new(),
        }
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
        self.entries.push(SharedBacklog {
            queue: Vec::new(),
            ref_count: 1,
            in_use: true,
        });
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
            if !entry.in_use {
                return;
            }
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
        self.entries
            .get(idx)
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

    #[test]
    fn inherited_inet_bindings_keep_every_owner_until_final_close() {
        const PARENT: u32 = 910_001;
        const CHILD: u32 = 910_002;
        const CONTENDER: u32 = 910_003;
        const UDP4_IDX: usize = 41;
        const UDP6_IDX: usize = 42;
        const DUAL_STACK_TCP_IDX: usize = 43;
        const UDP4_PORT: u16 = 64_901;
        const UDP6_PORT: u16 = 64_902;
        const TCP_PORT: u16 = 64_903;
        const LOOPBACK6: [u8; 16] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];

        for pid in [PARENT, CHILD, CONTENDER] {
            udp_cleanup_process(pid);
            udp6_cleanup_process(pid);
            tcp_cleanup_process(pid);
            tcp6_cleanup_process(pid);
        }

        udp_register(PARENT, UDP4_IDX, [127, 0, 0, 1], UDP4_PORT, false).unwrap();
        udp6_register(PARENT, UDP6_IDX, LOOPBACK6, UDP6_PORT, false).unwrap();
        // A dual-stack wildcard listener reserves the same socket identity in
        // both protocol-family tables.
        tcp6_register(PARENT, DUAL_STACK_TCP_IDX, [0; 16], TCP_PORT).unwrap();
        tcp_register(
            PARENT,
            DUAL_STACK_TCP_IDX,
            [0, 0, 0, 0],
            TCP_PORT,
        )
        .unwrap();

        inherit_inet_binding_owners(PARENT, CHILD, UDP4_IDX);
        inherit_inet_binding_owners(PARENT, CHILD, UDP6_IDX);
        inherit_inet_binding_owners(PARENT, CHILD, DUAL_STACK_TCP_IDX);

        let udp4_targets = udp_lookup([127, 0, 0, 1], UDP4_PORT);
        assert!(udp4_targets
            .iter()
            .any(|target| target.pid == PARENT && target.sock_idx == UDP4_IDX));
        assert!(udp4_targets
            .iter()
            .any(|target| target.pid == CHILD && target.sock_idx == UDP4_IDX));
        let udp6_targets = udp6_lookup(LOOPBACK6, UDP6_PORT);
        assert!(udp6_targets
            .iter()
            .any(|target| target.pid == PARENT && target.sock_idx == UDP6_IDX));
        assert!(udp6_targets
            .iter()
            .any(|target| target.pid == CHILD && target.sock_idx == UDP6_IDX));

        // Parent close removes only the parent's process-local identity.
        udp_unregister(PARENT, UDP4_IDX);
        udp6_unregister(PARENT, UDP6_IDX);
        tcp_unregister(PARENT, DUAL_STACK_TCP_IDX);
        tcp6_unregister(PARENT, DUAL_STACK_TCP_IDX);

        let udp4_targets = udp_lookup([127, 0, 0, 1], UDP4_PORT);
        assert_eq!(udp4_targets.len(), 1);
        assert_eq!((udp4_targets[0].pid, udp4_targets[0].sock_idx), (CHILD, UDP4_IDX));
        let udp6_targets = udp6_lookup(LOOPBACK6, UDP6_PORT);
        assert_eq!(udp6_targets.len(), 1);
        assert_eq!((udp6_targets[0].pid, udp6_targets[0].sock_idx), (CHILD, UDP6_IDX));
        assert!(!udp_can_bind(
            CONTENDER,
            1,
            [127, 0, 0, 1],
            UDP4_PORT,
            false
        ));
        assert!(!udp6_can_bind(
            CONTENDER,
            2,
            LOOPBACK6,
            UDP6_PORT,
            false
        ));
        assert!(!tcp_can_bind(
            CONTENDER,
            3,
            [0, 0, 0, 0],
            TCP_PORT
        ));
        assert!(!tcp6_can_bind(CONTENDER, 3, [0; 16], TCP_PORT));

        // Final close drops each logical reservation.
        udp_unregister(CHILD, UDP4_IDX);
        udp6_unregister(CHILD, UDP6_IDX);
        tcp_unregister(CHILD, DUAL_STACK_TCP_IDX);
        tcp6_unregister(CHILD, DUAL_STACK_TCP_IDX);
        assert!(udp_lookup([127, 0, 0, 1], UDP4_PORT).is_empty());
        assert!(udp6_lookup(LOOPBACK6, UDP6_PORT).is_empty());
        assert!(udp_can_bind(
            CONTENDER,
            1,
            [127, 0, 0, 1],
            UDP4_PORT,
            false
        ));
        assert!(udp6_can_bind(
            CONTENDER,
            2,
            LOOPBACK6,
            UDP6_PORT,
            false
        ));
        assert!(tcp_can_bind(
            CONTENDER,
            3,
            [0, 0, 0, 0],
            TCP_PORT
        ));
        assert!(tcp6_can_bind(CONTENDER, 3, [0; 16], TCP_PORT));
    }

    #[test]
    fn inherited_udp_owner_does_not_merge_reuseaddr_bindings() {
        const PARENT: u32 = 920_001;
        const CHILD: u32 = 920_002;
        const FIRST_IDX: usize = 51;
        const SECOND_IDX: usize = 52;
        const PORT: u16 = 64_904;

        udp_cleanup_process(PARENT);
        udp_cleanup_process(CHILD);
        udp_register(PARENT, FIRST_IDX, [0, 0, 0, 0], PORT, true).unwrap();
        udp_register(PARENT, SECOND_IDX, [0, 0, 0, 0], PORT, true).unwrap();

        inherit_inet_binding_owners(PARENT, CHILD, FIRST_IDX);
        let targets = udp_lookup([127, 0, 0, 1], PORT);
        assert_eq!(targets.len(), 3);
        assert!(targets
            .iter()
            .any(|target| target.pid == CHILD && target.sock_idx == FIRST_IDX));
        assert!(!targets
            .iter()
            .any(|target| target.pid == CHILD && target.sock_idx == SECOND_IDX));

        udp_unregister(PARENT, FIRST_IDX);
        udp_unregister(CHILD, FIRST_IDX);
        let targets = udp_lookup([127, 0, 0, 1], PORT);
        assert_eq!(targets.len(), 1);
        assert_eq!(
            (targets[0].pid, targets[0].sock_idx),
            (PARENT, SECOND_IDX)
        );

        udp_unregister(PARENT, SECOND_IDX);
    }
}
