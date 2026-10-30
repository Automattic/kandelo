extern crate alloc;

#[cfg(test)]
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

// Process-local socket indexes cannot identify connections in a shared host
// backend: unrelated processes routinely both own socket slot zero.
static NEXT_HOST_NET_HANDLE: core::sync::atomic::AtomicU32 = core::sync::atomic::AtomicU32::new(1);
pub fn allocate_host_net_handle() -> Result<i32, Errno> {
    NEXT_HOST_NET_HANDLE
        .fetch_update(
            core::sync::atomic::Ordering::Relaxed,
            core::sync::atomic::Ordering::Relaxed,
            |next| {
                if next < i32::MAX as u32 {
                    Some(next + 1)
                } else {
                    None
                }
            },
        )
        .map(|value| value as i32)
        .map_err(|_| Errno::ENOBUFS)
}
pub fn reserve_host_net_handle(handle: i32) {
    if handle >= 0 {
        NEXT_HOST_NET_HANDLE.fetch_max(handle as u32 + 1, core::sync::atomic::Ordering::Relaxed);
    }
}

struct HostNetRefs(UnsafeCell<crate::PreparedMap<i32, u32>>);
unsafe impl Sync for HostNetRefs {}

static HOST_NET_REFS: HostNetRefs = HostNetRefs(UnsafeCell::new(crate::PreparedMap::new()));

fn get_host_net_refs() -> &'static mut crate::PreparedMap<i32, u32> {
    unsafe { &mut *HOST_NET_REFS.0.get() }
}

/// Register that a host net handle is now shared by one more process
/// (fork or spawn child). If the handle is being inherited for the first
/// time, sets the count to 2 (parent + child). Otherwise increments by 1.
pub(crate) struct PreparedNetHandleRefs {
    entries: crate::IoBuffer<(i32, u32, Option<crate::prepared_map::PreparedEntry<i32, u32>>)>,
}

impl PreparedNetHandleRefs {
    pub(crate) fn prepare(sockets: &SocketTable, roots: &[usize]) -> Result<Self, Errno> {
        let mut entries = crate::IoBuffer::try_with_capacity(roots.len())?;
        for &index in roots {
            let socket = sockets.get(index).ok_or(Errno::EBADF)?;
            if let Some(handle) = socket.host_net_handle { entries.push((handle, 1u32, None)); }
        }
        entries.sort_unstable_by_key(|entry| entry.0);
        let mut unique = 0;
        for read in 0..entries.len() {
            let handle = entries[read].0;
            if unique > 0 && entries[unique - 1].0 == handle {
                entries[unique - 1].1 = entries[unique - 1].1.checked_add(1).ok_or(Errno::EOVERFLOW)?;
            } else {
                entries[unique] = (handle, 1, None);
                unique += 1;
            }
        }
        entries.truncate(unique);
        let refs = get_host_net_refs();
        for (handle, count, prepared) in &mut entries {
            let current = refs.get(handle).copied();
            *count = current.unwrap_or(1).checked_add(*count).ok_or(Errno::EOVERFLOW)?;
            if current.is_none() { *prepared = Some(refs.prepare_io(*handle, *count)?); }
        }
        Ok(Self { entries })
    }

    pub(crate) fn publish(self) {
        let refs = get_host_net_refs();
        for (handle, count, prepared) in self.entries {
            reserve_host_net_handle(handle);
            if let Some(prepared) = prepared {
                refs.publish_io(prepared);
            } else {
                *refs.get_mut(&handle).expect("prepared network handle disappeared") = count;
            }
        }
    }
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
pub struct Datagram {
    pub data: crate::IoBuffer<u8>,
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
    pub ancillary_fds: crate::pipe::AncillaryFds,
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
    fn owners_mut(&mut self) -> &mut crate::IoBuffer<BindingOwner>;
}

fn remove_binding_owner<T: HasBindingOwners>(bindings: &mut crate::IoBuffer<T>, pid: u32, sock_idx: usize) {
    for binding in bindings.iter_mut() {
        binding
            .owners_mut()
            .retain(|owner| owner.pid != pid || owner.sock_idx != sock_idx);
    }
    bindings.retain(|binding| !binding.owners().is_empty());
}

fn cleanup_binding_owner_pid<T: HasBindingOwners>(bindings: &mut crate::IoBuffer<T>, pid: u32) {
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

#[cfg_attr(test, derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
struct UdpBinding {
    owners: crate::IoBuffer<BindingOwner>,
    addr: [u8; 4],
    port: u16,
    reuse_addr: bool,
}

impl HasBindingOwners for UdpBinding {
    fn owners(&self) -> &[BindingOwner] {
        &self.owners
    }

    fn owners_mut(&mut self) -> &mut crate::IoBuffer<BindingOwner> {
        &mut self.owners
    }
}

/// IPv4 multicast group state for an AF_INET datagram socket.
#[derive(Debug, PartialEq, Eq)]
pub struct Ipv4MulticastMembership {
    pub group: [u8; 4],
    /// Interface address used for matching local delivery. 0.0.0.0 means the
    /// kernel default interface. 127.0.0.1 represents loopback.
    pub interface_addr: [u8; 4],
    pub any_source: bool,
    pub blocked_sources: crate::IoBuffer<[u8; 4]>,
    pub included_sources: crate::IoBuffer<[u8; 4]>,
}

impl Ipv4MulticastMembership {
    fn try_clone(&self) -> Result<Self, Errno> {
        Ok(Self { group: self.group, interface_addr: self.interface_addr, any_source: self.any_source,
            blocked_sources: crate::IoBuffer::copy_from(&self.blocked_sources)?,
            included_sources: crate::IoBuffer::copy_from(&self.included_sources)? })
    }
}

#[cfg(test)]
impl Clone for Ipv4MulticastMembership { fn clone(&self) -> Self { self.try_clone().unwrap() } }

struct UdpEndpointTable(UnsafeCell<Option<crate::IoBuffer<UdpBinding>>>);
unsafe impl Sync for UdpEndpointTable {}

static UDP_ENDPOINTS: UdpEndpointTable = UdpEndpointTable(UnsafeCell::new(None));

fn udp_bindings() -> &'static mut crate::IoBuffer<UdpBinding> {
    let opt = unsafe { &mut *UDP_ENDPOINTS.0.get() };
    opt.get_or_insert_with(crate::IoBuffer::new)
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
    let owners = crate::IoBuffer::copy_from(&[BindingOwner { pid, sock_idx }])?;
    udp_bindings().try_reserve(1)?;
    remove_binding_owner(udp_bindings(), pid, sock_idx);
    udp_bindings().push(UdpBinding {
        owners,
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

pub struct UdpEndpoints {
    addr: [u8; 4],
    port: u16,
    binding_index: usize,
    owner_index: usize,
}

impl UdpEndpoints {
    pub(crate) fn iter(&self) -> Self {
        Self { addr: self.addr, port: self.port, binding_index: self.binding_index, owner_index: self.owner_index }
    }
}

impl Iterator for UdpEndpoints {
    type Item = UdpEndpoint;
    fn next(&mut self) -> Option<Self::Item> {
        let bindings = udp_bindings();
        while let Some(binding) = bindings.get(self.binding_index) {
            if binding.port == self.port && udp_addr_matches(binding.addr, self.addr) {
                if let Some(owner) = binding.owners.get(self.owner_index) {
                    self.owner_index += 1;
                    return Some(UdpEndpoint { pid: owner.pid, sock_idx: owner.sock_idx,
                        addr: binding.addr, port: binding.port, reuse_addr: binding.reuse_addr });
                }
            }
            self.binding_index += 1;
            self.owner_index = 0;
        }
        None
    }
}

pub fn udp_endpoints(dst_addr: [u8; 4], dst_port: u16) -> UdpEndpoints {
    UdpEndpoints { addr: dst_addr, port: dst_port, binding_index: 0, owner_index: 0 }
}

#[cfg(test)]
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

#[cfg_attr(test, derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
struct Udp6Binding {
    owners: crate::IoBuffer<BindingOwner>,
    addr: [u8; 16],
    port: u16,
    reuse_addr: bool,
}

impl HasBindingOwners for Udp6Binding {
    fn owners(&self) -> &[BindingOwner] {
        &self.owners
    }

    fn owners_mut(&mut self) -> &mut crate::IoBuffer<BindingOwner> {
        &mut self.owners
    }
}

struct Udp6EndpointTable(UnsafeCell<Option<crate::IoBuffer<Udp6Binding>>>);
unsafe impl Sync for Udp6EndpointTable {}

static UDP6_ENDPOINTS: Udp6EndpointTable = Udp6EndpointTable(UnsafeCell::new(None));

fn udp6_bindings() -> &'static mut crate::IoBuffer<Udp6Binding> {
    let opt = unsafe { &mut *UDP6_ENDPOINTS.0.get() };
    opt.get_or_insert_with(crate::IoBuffer::new)
}

fn udp6_addr_conflicts(a: [u8; 16], b: [u8; 16]) -> bool {
    a == [0; 16] || b == [0; 16] || a == b
}

#[cfg(test)]
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
    let owners = crate::IoBuffer::copy_from(&[BindingOwner { pid, sock_idx }])?;
    udp6_bindings().try_reserve(1)?;
    remove_binding_owner(udp6_bindings(), pid, sock_idx);
    udp6_bindings().push(Udp6Binding {
        owners,
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

#[cfg(test)]
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
#[cfg_attr(test, derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
struct TcpBinding {
    owners: crate::IoBuffer<BindingOwner>,
    addr: [u8; 4],
    port: u16,
}

impl HasBindingOwners for TcpBinding {
    fn owners(&self) -> &[BindingOwner] {
        &self.owners
    }

    fn owners_mut(&mut self) -> &mut crate::IoBuffer<BindingOwner> {
        &mut self.owners
    }
}

struct TcpBindingTable(UnsafeCell<Option<crate::IoBuffer<TcpBinding>>>);
unsafe impl Sync for TcpBindingTable {}

static TCP_BINDINGS: TcpBindingTable = TcpBindingTable(UnsafeCell::new(None));

fn tcp_bindings() -> &'static mut crate::IoBuffer<TcpBinding> {
    let opt = unsafe { &mut *TCP_BINDINGS.0.get() };
    opt.get_or_insert_with(crate::IoBuffer::new)
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
    let owners = crate::IoBuffer::copy_from(&[BindingOwner { pid, sock_idx }])?;
    tcp_bindings().try_reserve(1)?;
    remove_binding_owner(tcp_bindings(), pid, sock_idx);
    tcp_bindings().push(TcpBinding {
        owners,
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
#[cfg_attr(test, derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
struct Tcp6Binding {
    owners: crate::IoBuffer<BindingOwner>,
    addr: [u8; 16],
    port: u16,
}

impl HasBindingOwners for Tcp6Binding {
    fn owners(&self) -> &[BindingOwner] {
        &self.owners
    }

    fn owners_mut(&mut self) -> &mut crate::IoBuffer<BindingOwner> {
        &mut self.owners
    }
}

struct Tcp6BindingTable(UnsafeCell<Option<crate::IoBuffer<Tcp6Binding>>>);
unsafe impl Sync for Tcp6BindingTable {}

static TCP6_BINDINGS: Tcp6BindingTable = Tcp6BindingTable(UnsafeCell::new(None));

fn tcp6_bindings() -> &'static mut crate::IoBuffer<Tcp6Binding> {
    let opt = unsafe { &mut *TCP6_BINDINGS.0.get() };
    opt.get_or_insert_with(crate::IoBuffer::new)
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

pub fn tcp6_register(pid: u32, sock_idx: usize, addr: [u8; 16], port: u16) -> Result<(), Errno> {
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
    let owners = crate::IoBuffer::copy_from(&[BindingOwner { pid, sock_idx }])?;
    tcp6_bindings().try_reserve(1)?;
    remove_binding_owner(tcp6_bindings(), pid, sock_idx);
    tcp6_bindings().push(Tcp6Binding {
        owners,
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
pub(crate) fn prepare_inet_binding_owners(parent_pid: u32, child_pid: u32, sock_idx: usize) -> Result<(), Errno> {
    let parent = BindingOwner { pid: parent_pid, sock_idx };
    let child = BindingOwner { pid: child_pid, sock_idx };
    prepare_binding_owner(udp_bindings(), parent, child)?;
    prepare_binding_owner(udp6_bindings(), parent, child)?;
    prepare_binding_owner(tcp_bindings(), parent, child)?;
    prepare_binding_owner(tcp6_bindings(), parent, child)
}

fn prepare_binding_owner<T: HasBindingOwners>(bindings: &mut [T], parent: BindingOwner, child: BindingOwner) -> Result<(), Errno> {
    for binding in bindings {
        if binding.owners().contains(&parent) && !binding.owners().contains(&child) {
            binding.owners_mut().try_reserve(1)?;
        }
    }
    Ok(())
}

#[cfg(test)]
pub fn inherit_inet_binding_owners(parent_pid: u32, child_pid: u32, sock_idx: usize) {
    prepare_inet_binding_owners(parent_pid, child_pid, sock_idx).unwrap();
    publish_inet_binding_owners(parent_pid, child_pid, sock_idx);
}

pub(crate) fn publish_inet_binding_owners(parent_pid: u32, child_pid: u32, sock_idx: usize) {
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

/// Credentials `SO_PEERCRED` reports for a socket's peer: the process ID
/// and effective user/group IDs, captured when the connection was made
/// (Linux semantics; they do not follow later `setuid` or exit).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PeerCred {
    pub pid: u32,
    pub uid: u32,
    pub gid: u32,
}

/// Per-socket kernel state.
///
/// `Clone` is hand-written (not derived) so that fork/spawn cloning
/// discards consume-once state that should not double-fire in the child.
/// See the `impl Clone for SocketInfo` block below for which fields are
/// reset.
pub struct SocketInfo {
    /// Installed when a readiness subscription names this socket or its peer.
    /// It identifies notifications, never retains a descriptor or backing.
    pub poll_identity: core::cell::Cell<Option<crate::lock::OfdId>>,
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
    pub options: crate::IoBuffer<(u32, u32, u32)>,
    /// SO_LINGER state. This is a structured option (`struct linger`), so it
    /// is kept separately from integer-valued socket options.
    pub linger_onoff: i32,
    pub linger_seconds: i32,
    /// SO_BINDTODEVICE binds a socket to a named virtual network interface.
    pub bind_device: Option<crate::IoBuffer<u8>>,
    /// TCP_CONGESTION algorithm name for this socket. Kandelo's virtual TCP
    /// stack currently exposes the standard Linux default, "cubic".
    pub tcp_congestion: crate::IoBuffer<u8>,
    /// Bound IPv4 address (for AF_INET sockets).
    pub bind_addr: [u8; 4],
    /// Bound IPv6 address (for AF_INET6 sockets).
    pub bind_addr6: [u8; 16],
    /// Bound port (for AF_INET sockets).
    pub bind_port: u16,
    /// Peer IPv4 address (for connected AF_INET sockets).
    pub peer_addr: [u8; 4],
    /// Selected source for an IPv4 UDP association with a wildcard binding.
    pub udp_source_addr: Option<[u8; 4]>,
    /// Peer IPv6 address (for connected AF_INET6 sockets).
    pub peer_addr6: [u8; 16],
    /// Peer port (for connected AF_INET sockets).
    pub peer_port: u16,
    /// AF_UNIX stream peer credentials for `SO_PEERCRED`, as Linux records
    /// them: a socketpair and a listener hold their creator's; an accepted
    /// socket holds the connecting process's, captured at `connect()`; a
    /// connecting socket copies its listener's, captured at `listen()`.
    /// `None` for every other socket.
    pub peer_cred: Option<PeerCred>,
    /// Legacy pending connection socket indices for manually constructed or
    /// pre-shared-queue listeners. Normal AF_UNIX, AF_INET, and AF_INET6
    /// stream listeners use `shared_backlog_idx` instead.
    pub listen_backlog: crate::IoBuffer<usize>,
    /// Index into the global SHARED_LISTENER_BACKLOG_TABLE for stream
    /// listeners. Set by sys_listen so fork/spawn-inherited AF_UNIX, AF_INET,
    /// and AF_INET6 listener copies share one accept queue. `None` before
    /// listen() is called.
    pub shared_backlog_idx: Option<usize>,
    /// Host-visible wake token for listener readiness. Assigned by listen()
    /// and cloned across fork/spawn so every inherited listener fd waits on
    /// the same accept-readiness event.
    pub accept_wake_idx: Option<u32>,
    /// Received UDP datagrams (for DGRAM sockets).
    pub dgram_queue: crate::IoBuffer<Datagram>,
    /// Joined IPv4 multicast groups and source filters.
    pub ipv4_multicast_memberships: crate::IoBuffer<Ipv4MulticastMembership>,
    /// Received netlink datagrams. Netlink sockets are datagram-like and are
    /// used by musl for route/interface enumeration.
    pub netlink_queue: crate::IoBuffer<crate::IoBuffer<u8>>,
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
    /// Original bounded sockaddr name supplied to AF_UNIX bind().
    ///
    /// WHY: the UnixSocketRegistry owns the canonical namespace key. Keeping
    /// that potentially much longer resolved path here would let getsockname()
    /// report more bytes than the concrete sockaddr supplied by the caller.
    pub bind_path: Option<crate::IoBuffer<u8>>,
    /// Errno cached from a failed host-delegated connect; read and cleared
    /// by SO_ERROR (Linux semantics). 0 means no error.
    pub connect_error: u32,
}

impl SocketInfo {
    pub fn try_new(domain: SocketDomain, sock_type: SocketType, protocol: u32) -> Result<Self, Errno> {
        Ok(SocketInfo {
            poll_identity: core::cell::Cell::new(None),
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
            options: crate::IoBuffer::new(),
            linger_onoff: 0,
            linger_seconds: 0,
            bind_device: None,
            tcp_congestion: crate::IoBuffer::copy_from(b"cubic")?,
            bind_addr: [0; 4],
            bind_addr6: [0; 16],
            bind_port: 0,
            peer_addr: [0; 4],
            udp_source_addr: None,
            peer_addr6: [0; 16],
            peer_port: 0,
            peer_cred: None,
            listen_backlog: crate::IoBuffer::new(),
            shared_backlog_idx: None,
            accept_wake_idx: None,
            dgram_queue: crate::IoBuffer::new(),
            ipv4_multicast_memberships: crate::IoBuffer::new(),
            netlink_queue: crate::IoBuffer::new(),
            global_pipes: true,
            oob_byte: None,
            recv_timeout_us: 0,
            send_timeout_us: 0,
            bind_path: None,
            connect_error: 0,
        })
    }

    #[cfg(test)]
    pub fn new(domain: SocketDomain, sock_type: SocketType, protocol: u32) -> Self {
        Self::try_new(domain, sock_type, protocol).unwrap()
    }

    pub(crate) fn prepare_option(&mut self, level: u32, optname: u32) -> Result<(), Errno> {
        if self.get_option(level, optname).is_none() { self.options.try_reserve(1)?; }
        Ok(())
    }

    /// Set or update a stored socket option.
    pub fn set_option(&mut self, level: u32, optname: u32, value: u32) -> Result<(), Errno> {
        for opt in self.options.iter_mut() {
            if opt.0 == level && opt.1 == optname {
                opt.2 = value;
                return Ok(());
            }
        }
        self.options.try_reserve(1)?;
        self.options.push((level, optname, value));
        Ok(())
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
///   * `netlink_queue` — buffered netlink datagrams.
///   * `oob_byte` — pending TCP out-of-band byte.
///   * `listen_backlog` — legacy pre-accepted connections.
///     Indices reference other entries in this process's SocketTable; if
///     both parent and child kept them, both could `accept()` the same
///     pending connection. Normal stream listeners use the shared backlog;
///     this inline fallback remains only with the parent.
///   * `connect_error` — cached host-delegated connect failure state.
///
/// Everything else is value-cloned. `host_net_handle` and
/// `shared_backlog_idx` are still inherited; the cross-process refcount
/// bumps for those live in `process_table::bump_inherited_resource_refcounts`.
impl SocketInfo {
    pub fn try_clone(&self) -> Result<Self, Errno> {
        let mut memberships = crate::IoBuffer::try_with_capacity(self.ipv4_multicast_memberships.len())?;
        for membership in &self.ipv4_multicast_memberships { memberships.push(membership.try_clone()?); }
        Ok(SocketInfo {
            poll_identity: core::cell::Cell::new(self.poll_identity.get()),
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
            options: crate::IoBuffer::copy_from(&self.options)?,
            linger_onoff: self.linger_onoff,
            linger_seconds: self.linger_seconds,
            bind_device: self.bind_device.as_deref().map(crate::IoBuffer::copy_from).transpose()?,
            tcp_congestion: crate::IoBuffer::copy_from(&self.tcp_congestion)?,
            bind_addr: self.bind_addr,
            bind_addr6: self.bind_addr6,
            bind_port: self.bind_port,
            peer_addr: self.peer_addr,
            udp_source_addr: self.udp_source_addr,
            peer_addr6: self.peer_addr6,
            peer_port: self.peer_port,
            peer_cred: self.peer_cred,
            listen_backlog: crate::IoBuffer::new(),
            shared_backlog_idx: self.shared_backlog_idx,
            accept_wake_idx: self.accept_wake_idx,
            dgram_queue: crate::IoBuffer::new(), // consume-once: don't double-deliver
            ipv4_multicast_memberships: memberships,
            netlink_queue: crate::IoBuffer::new(),
            global_pipes: self.global_pipes,
            oob_byte: None, // consume-once: don't double-deliver
            recv_timeout_us: self.recv_timeout_us,
            send_timeout_us: self.send_timeout_us,
            bind_path: self.bind_path.as_deref().map(crate::IoBuffer::copy_from).transpose()?,
            connect_error: 0, // don't inherit a cached host-delegated failure
        })
    }
}

/// Table of socket state, indexed by socket slot.
pub struct SocketTable {
    entries: crate::IoBuffer<Option<SocketInfo>>,
}

impl SocketTable {
    pub fn new() -> Self {
        SocketTable {
            entries: crate::IoBuffer::new(),
        }
    }

    /// Allocate a slot for a new socket. Reuses freed slots.
    pub(crate) fn prepare_additional(&mut self, count: usize) -> Result<(), Errno> {
        let free = self.entries.iter().filter(|entry| entry.is_none()).count();
        self.entries.try_reserve(count.saturating_sub(free))
    }

    pub(crate) fn publish_prepared(&mut self, info: SocketInfo) -> usize {
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

    pub fn try_alloc(&mut self, info: SocketInfo) -> Result<usize, Errno> {
        self.prepare_additional(1)?;
        Ok(self.publish_prepared(info))
    }

    #[cfg(test)]
    pub fn alloc(&mut self, info: SocketInfo) -> usize { self.try_alloc(info).unwrap() }

    pub fn try_clone(&self) -> Result<Self, Errno> {
        let mut entries = crate::IoBuffer::try_with_capacity(self.entries.len())?;
        for entry in &self.entries { entries.push(entry.as_ref().map(SocketInfo::try_clone).transpose()?); }
        Ok(Self { entries })
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
    pub fn try_insert_at(&mut self, idx: usize, info: SocketInfo) -> Result<(), Errno> {
        let length = idx.checked_add(1).ok_or(Errno::ENOMEM)?;
        self.entries.try_reserve(length.saturating_sub(self.entries.len()))?;
        while self.entries.len() <= idx {
            self.entries.push(None);
        }
        self.entries[idx] = Some(info);
        Ok(())
    }

    #[cfg(test)]
    pub fn insert_at(&mut self, idx: usize, info: SocketInfo) { self.try_insert_at(idx, info).unwrap(); }

    /// Decode the negative `-(slot + 1)` stored in a socket OFD.
    pub fn index_from_ofd_handle(host_handle: i64) -> Result<usize, Errno> {
        let index = host_handle
            .checked_add(1)
            .and_then(i64::checked_neg)
            .ok_or(Errno::EBADF)?;
        usize::try_from(index).map_err(|_| Errno::EBADF)
    }

    /// Retain only socket slots owned by inherited OFDs.
    ///
    /// WHY: `peer_idx` is an operational process-local endpoint, not an owning
    /// capability. Following it into a slot with no inherited OFD would create
    /// a fake child-local peer that can accept bytes after the real peer has
    /// closed. Edges between two independently inherited roots remain valid;
    /// all other edges are cleared.
    pub fn retain_inherited_roots(&mut self, roots: &[usize]) -> Result<(), Errno> {
        let mut retained = crate::IoBuffer::try_with_capacity(self.entries.len())?;
        retained.resize(self.entries.len(), false);

        // Validate every owning root before mutating the cloned table so an
        // invalid OFD cannot leave a partially filtered child.
        for &root in roots {
            if self.get(root).is_none() {
                return Err(Errno::EBADF);
            }
            retained[root] = true;
        }

        for (index, slot) in self.entries.iter_mut().enumerate() {
            if !retained[index] {
                *slot = None;
                continue;
            }
            if let Some(socket) = slot {
                if socket
                    .peer_idx
                    .is_some_and(|peer| peer >= retained.len() || !retained[peer])
                {
                    socket.peer_idx = None;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
impl Clone for SocketInfo { fn clone(&self) -> Self { self.try_clone().unwrap() } }

#[cfg(test)]
impl Clone for SocketTable { fn clone(&self) -> Self { self.try_clone().unwrap() } }

// ── Shared listener backlog (cross-process accept queue) ──
//
// In real Linux, a listening socket inherited via fork() shares a single
// accept queue across parent and children — any process can accept a
// pending connection. Our SocketInfo lives in per-process tables, so a
// naive fork+accept model would give each process its own backlog. To
// match POSIX semantics for AF_INET, AF_INET6, and AF_UNIX listeners (the
// typical pre-fork server pattern), we keep the actual pending queue
// in this global table and reference it by index from each forked
// SocketInfo copy.

/// A pending stream connection waiting in a shared accept queue.
pub struct PendingConnection {
    /// Actual destination IPv4 address selected by the routing backend.
    pub local_addr: [u8;4],
    pub peer_addr: [u8; 4],
    pub peer_addr6: [u8; 16],
    /// True when `peer_addr6` is a native IPv6 source. For an IPv4 peer
    /// accepted by a dual-stack IPv6 listener this is false and `peer_addr`
    /// is converted to an IPv4-mapped address at accept time.
    pub peer_is_ipv6: bool,
    pub peer_port: u16,
    /// Process-local peer identity, used only when the accepting process is
    /// also the AF_UNIX client owner. Pipe identity is revalidated before it
    /// is installed so a recycled socket slot cannot receive stale OOB data.
    pub peer_pid: u32,
    pub peer_sock_idx: Option<usize>,
    /// AF_UNIX: the connecting process's credentials at `connect()`, which
    /// the accepted socket reports through `SO_PEERCRED`. `None` for INET.
    pub peer_cred: Option<PeerCred>,
    /// Recv pipe index (in the global pipe table). Host writes incoming
    /// TCP data here; the accepting process reads from it.
    pub recv_pipe_idx: usize,
    /// Send pipe index (in the global pipe table). The accepting
    /// process writes outgoing TCP data here; host reads and forwards.
    pub send_pipe_idx: usize,
    pub host_connection_id: u32,
}

/// One slot in the shared backlog table.
pub struct SharedBacklog {
    pub queue: crate::IoBuffer<PendingConnection>,
    /// Number of SocketInfos referencing this slot. When a listener is
    /// fork-inherited, the child's copy adds a reference; close()/free
    /// drops one. The slot is freed when ref_count reaches 0.
    pub ref_count: u32,
    /// True when the slot is allocated; false when freed and reusable.
    pub in_use: bool,
}

pub struct SharedBacklogTable {
    pub entries: crate::IoBuffer<SharedBacklog>,
}

impl SharedBacklogTable {
    pub const fn new() -> Self {
        SharedBacklogTable {
            entries: crate::IoBuffer::new(),
        }
    }

    /// Allocate a new shared backlog slot, reusing freed slots.
    /// Returns the slot index. The slot starts with ref_count=1.
    pub fn try_alloc(&mut self) -> Result<usize, Errno> {
        for i in 0..self.entries.len() {
            if !self.entries[i].in_use {
                self.entries[i].queue.clear();
                self.entries[i].ref_count = 1;
                self.entries[i].in_use = true;
                return Ok(i);
            }
        }
        let idx = self.entries.len();
        self.entries.try_reserve(1)?;
        self.entries.push(SharedBacklog {
            queue: crate::IoBuffer::new(),
            ref_count: 1,
            in_use: true,
        });
        Ok(idx)
    }

    #[cfg(test)]
    pub fn alloc(&mut self) -> usize { self.try_alloc().unwrap() }

    pub fn prepare_push(&mut self, idx: usize) -> Result<(), Errno> {
        let entry = self.entries.get_mut(idx).filter(|entry| entry.in_use).ok_or(Errno::ECONNREFUSED)?;
        entry.queue.try_reserve(1)
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

    /// Decrement the reference count. If it reaches zero, free the slot and
    /// close the server endpoints owned by queued, not-yet-accepted
    /// connections.
    pub fn dec_ref(&mut self, idx: usize) {
        let mut abandoned = crate::IoBuffer::new();
        if let Some(entry) = self.entries.get_mut(idx) {
            if !entry.in_use {
                return;
            }
            entry.ref_count = entry.ref_count.saturating_sub(1);
            if entry.ref_count == 0 {
                abandoned = core::mem::take(&mut entry.queue);
                entry.in_use = false;
            }
        }
        if abandoned.is_empty() {
            return;
        }
        let pipes = unsafe { crate::pipe::global_pipe_table() };
        for pending in abandoned {
            if let Some(pipe) = pipes.get_mut(pending.recv_pipe_idx) {
                pipe.close_read_end();
            }
            pipes.free_if_closed(pending.recv_pipe_idx);
            if let Some(pipe) = pipes.get_mut(pending.send_pipe_idx) {
                pipe.close_write_end();
            }
            pipes.free_if_closed(pending.send_pipe_idx);
        }
    }

    /// Push a pending connection. Returns true on success.
    pub fn publish_prepared(&mut self, idx: usize, pc: PendingConnection) -> bool {
        if let Some(entry) = self.entries.get_mut(idx) {
            if entry.in_use {
                entry.queue.push(pc);
                return true;
            }
        }
        false
    }

    #[cfg(test)]
    pub fn push(&mut self, idx: usize, pc: PendingConnection) -> bool {
        self.prepare_push(idx).is_ok() && self.publish_prepared(idx, pc)
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

    pub fn cancel_injected_connection(
        &mut self,
        pipes: &mut crate::pipe::PipeTable,
        recv: usize,
        send: usize,
        token: u32,
    ) -> bool {
        if token == 0 || recv.checked_add(1) != Some(send) { return false; }
        for entry in &mut self.entries {
            if !entry.in_use { continue; }
            let Some(position) = entry.queue.iter().position(|pending| {
                pending.recv_pipe_idx == recv && pending.send_pipe_idx == send
                    && pending.host_connection_id == token
            }) else { continue; };
            entry.queue.remove(position);
            if let Some(pipe) = pipes.get_mut(recv) {
                if pipe.tcp_connection_id() == token { pipe.close_read_end(); }
            }
            pipes.free_if_closed(recv);
            if let Some(pipe) = pipes.get_mut(send) {
                if pipe.tcp_connection_id() == token { pipe.close_write_end(); }
            }
            pipes.free_if_closed(send);
            return true;
        }
        false
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

    fn queue_injected_connection(
        backlogs: &mut SharedBacklogTable,
        pipes: &mut crate::pipe::PipeTable,
        backlog: usize,
        capacity: usize,
    ) -> (usize, usize, u32) {
        backlogs.prepare_push(backlog).unwrap();
        let (recv, send) = pipes.alloc_tcp_pair(capacity).unwrap();
        let token = pipes.get(recv).unwrap().tcp_connection_id();
        assert!(backlogs.publish_prepared(backlog, PendingConnection {
            local_addr: [127, 0, 0, 1], peer_addr: [127, 0, 0, 1], peer_addr6: [0; 16],
            peer_is_ipv6: false, peer_port: 12000, peer_pid: 0, peer_sock_idx: None,
            peer_cred: None, recv_pipe_idx: recv, send_pipe_idx: send, host_connection_id: token,
        }));
        (recv, send, token)
    }

    fn close_injected_host_ends(pipes: &mut crate::pipe::PipeTable, recv: usize, send: usize) {
        pipes.get_mut(recv).unwrap().close_write_end();
        pipes.free_if_closed(recv);
        pipes.get_mut(send).unwrap().close_read_end();
        pipes.free_if_closed(send);
    }

    #[test]
    fn injected_timeout_waves_release_server_endpoints_without_allocation() {
        let mut backlogs = SharedBacklogTable::new();
        let mut pipes = crate::pipe::PipeTable::new();
        let backlog = backlogs.alloc();
        let (recv, send, token) = queue_injected_connection(&mut backlogs, &mut pipes, backlog, 65536);
        pipes.reset_tcp_connection(recv, send, token).unwrap();
        assert!(backlogs.cancel_injected_connection(&mut pipes, recv, send, token));
        close_injected_host_ends(&mut pipes, recv, send);
        let retained = crate::io_buffer::IO_MEMORY.usage().0;
        let _limit = crate::io_buffer::test_budget(retained + 4 * 65536);
        for _ in 0..100 {
            let (recv, send, token) = queue_injected_connection(&mut backlogs, &mut pipes, backlog, 65536);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, retained + 4 * 65536);
            pipes.reset_tcp_connection(recv, send, token).unwrap();
            assert!(backlogs.cancel_injected_connection(&mut pipes, recv, send, token));
            assert_eq!(backlogs.len(backlog), 0);
            assert!(!pipes.get(recv).unwrap().has_readers());
            assert!(!pipes.get(send).unwrap().is_write_end_open());
            close_injected_host_ends(&mut pipes, recv, send);
            assert_eq!(pipes.count_active(), 0);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, retained);
        }
    }

    #[test]
    fn injected_cancellation_preserves_an_already_accepted_socket() {
        let mut backlogs = SharedBacklogTable::new();
        let mut pipes = crate::pipe::PipeTable::new();
        let backlog = backlogs.alloc();
        let (recv, send, token) = queue_injected_connection(&mut backlogs, &mut pipes, backlog, 8);
        let accepted = backlogs.pop(backlog).unwrap();
        pipes.reset_tcp_connection(recv, send, token).unwrap();
        assert!(!backlogs.cancel_injected_connection(&mut pipes, recv, send, token));
        assert_eq!(pipes.get(recv).unwrap().stream_error(), Some(Errno::ECONNRESET));
        assert_eq!(pipes.get(send).unwrap().stream_error(), Some(Errno::ECONNRESET));
        close_injected_host_ends(&mut pipes, recv, send);
        assert_eq!(pipes.count_active(), 2);
        assert!(pipes.get(accepted.recv_pipe_idx).unwrap().has_readers());
        assert!(pipes.get(accepted.send_pipe_idx).unwrap().is_write_end_open());
        pipes.get_mut(recv).unwrap().close_read_end();
        pipes.free_if_closed(recv);
        pipes.get_mut(send).unwrap().close_write_end();
        pipes.free_if_closed(send);
        assert_eq!(pipes.count_active(), 0);
    }

    #[test]
    fn delayed_injected_cancellation_does_not_remove_a_reused_pair() {
        let mut backlogs = SharedBacklogTable::new();
        let mut pipes = crate::pipe::PipeTable::new();
        let backlog = backlogs.alloc();
        let (recv, send, old_token) = queue_injected_connection(&mut backlogs, &mut pipes, backlog, 8);
        assert!(!backlogs.cancel_injected_connection(&mut pipes, recv, send, old_token + 1));
        assert_eq!(backlogs.len(backlog), 1);
        pipes.reset_tcp_connection(recv, send, old_token).unwrap();
        assert!(backlogs.cancel_injected_connection(&mut pipes, recv, send, old_token));
        assert!(!backlogs.cancel_injected_connection(&mut pipes, recv, send, old_token));
        close_injected_host_ends(&mut pipes, recv, send);
        let (new_recv, new_send, new_token) = queue_injected_connection(&mut backlogs, &mut pipes, backlog, 8);
        assert_eq!((new_recv, new_send), (recv, send));
        assert_ne!(new_token, old_token);
        assert_eq!(pipes.reset_tcp_connection(recv, send, old_token), Err(Errno::ENOTCONN));
        assert!(!backlogs.cancel_injected_connection(&mut pipes, recv, send, old_token));
        assert_eq!(backlogs.len(backlog), 1);
        assert_eq!(pipes.get(new_recv).unwrap().stream_error(), None);
        assert!(backlogs.cancel_injected_connection(&mut pipes, new_recv, new_send, new_token));
        close_injected_host_ends(&mut pipes, new_recv, new_send);
    }

    #[test]
    fn injected_cancellation_does_not_close_a_recycled_half() {
        let mut backlogs = SharedBacklogTable::new();
        let mut pipes = crate::pipe::PipeTable::new();
        let backlog = backlogs.alloc();
        let (recv, send, token) = queue_injected_connection(&mut backlogs, &mut pipes, backlog, 8);
        pipes.discard_unclaimed(recv);
        let replacement = pipes.alloc(crate::pipe::PipeBuffer::new(8));
        assert_eq!(replacement, recv);
        pipes.get_mut(replacement).unwrap().write(b"safe");
        pipes.reset_tcp_connection(recv, send, token).unwrap();
        assert!(backlogs.cancel_injected_connection(&mut pipes, recv, send, token));
        assert_eq!(backlogs.len(backlog), 0);
        assert!(pipes.get(replacement).unwrap().has_readers());
        assert!(pipes.get(replacement).unwrap().is_write_end_open());
        assert_eq!(pipes.get(replacement).unwrap().stream_error(), None);
        let mut bytes = [0; 4];
        assert_eq!(pipes.get_mut(replacement).unwrap().read(&mut bytes), 4);
        assert_eq!(&bytes, b"safe");
        pipes.get_mut(send).unwrap().close_read_end();
        pipes.free_if_closed(send);
        pipes.discard_unclaimed(replacement);
    }

    #[test]
    fn socket_clone_admits_nested_metadata_and_rolls_back_on_refusal() {
        let mut socket = SocketInfo::new(SocketDomain::Inet, SocketType::Dgram, 17);
        socket.bind_path = Some(crate::IoBuffer::copy_from(b"socket-name").unwrap());
        socket.bind_device = Some(crate::IoBuffer::copy_from(b"lo").unwrap());
        socket.set_option(1, 2, 3).unwrap();
        socket.ipv4_multicast_memberships.try_reserve(1).unwrap();
        socket.ipv4_multicast_memberships.push(Ipv4MulticastMembership {
            group: [239, 1, 2, 3], interface_addr: [127, 0, 0, 1], any_source: true,
            blocked_sources: crate::IoBuffer::copy_from(&[[127, 0, 0, 2]]).unwrap(),
            included_sources: crate::IoBuffer::new(),
        });
        let mut table = SocketTable::new();
        let index = table.try_alloc(socket).unwrap();
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        let copy = table.try_clone().unwrap();
        let copy_bytes = crate::io_buffer::IO_MEMORY.usage().0 - held;
        assert!(copy_bytes > 0);
        drop(copy);
        for allowance in [0, copy_bytes / 2, copy_bytes - 1] {
            let _limit = crate::io_buffer::test_budget(held + allowance);
            assert!(matches!(table.try_clone(), Err(Errno::ENOMEM)));
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
        }
        {
            let _limit = crate::io_buffer::test_budget(held);
            assert!(matches!(SocketInfo::try_new(SocketDomain::Inet, SocketType::Stream, 0), Err(Errno::ENOMEM)));
        }
        let socket = table.get(index).unwrap();
        assert_eq!(socket.bind_path.as_deref(), Some(b"socket-name".as_slice()));
        assert_eq!(socket.ipv4_multicast_memberships[0].blocked_sources, [[127, 0, 0, 2]]);
        let next = SocketInfo::new(SocketDomain::Unix, SocketType::Dgram, 0);
        let next_again = SocketInfo::new(SocketDomain::Unix, SocketType::Dgram, 0);
        table.prepare_additional(2).unwrap();
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(held);
            table.publish_prepared(next);
            table.publish_prepared(next_again);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
        }
        assert_eq!(table.len(), 3);
    }

    #[test]
    fn network_reference_plan_groups_handles_and_releases_failed_nodes() {
        let mut table = SocketTable::new();
        let mut roots = Vec::new();
        for handle in [920_001, 920_001, 920_002] {
            let mut socket = SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 6);
            socket.host_net_handle = Some(handle);
            roots.push(table.alloc(socket));
        }
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(baseline);
            assert!(matches!(PreparedNetHandleRefs::prepare(&table, &roots), Err(Errno::ENOMEM)));
        }
        crate::prepared_map::fail_after_allocations(1);
        let result = PreparedNetHandleRefs::prepare(&table, &roots);
        crate::prepared_map::fail_after_allocations(usize::MAX);
        assert!(matches!(result, Err(Errno::ENOMEM)));
        assert_eq!(host_net_handle_ref_count(920_001), 0);
        assert_eq!(host_net_handle_ref_count(920_002), 0);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        let prepared = PreparedNetHandleRefs::prepare(&table, &roots).unwrap();
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            prepared.publish();
        }
        for (handle, count) in [(920_001, 3), (920_002, 2)] {
            assert_eq!(host_net_handle_ref_count(handle), count);
            for remaining in (0..count).rev() { assert_eq!(host_net_handle_close_ref(handle), remaining == 0); }
        }
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn binding_refusal_preserves_old_endpoint_and_unpublished_child() {
        const PARENT: u32 = 920_010;
        const CHILD: u32 = 920_011;
        udp_register(PARENT, 1, [127, 0, 0, 1], 59001, false).unwrap();
        {
            let held = crate::io_buffer::IO_MEMORY.usage().0;
            let _limit = crate::io_buffer::test_budget(held);
            assert_eq!(udp_register(PARENT, 1, [127, 0, 0, 1], 59002, false), Err(Errno::ENOMEM));
            assert_eq!(prepare_inet_binding_owners(PARENT, CHILD, 1), Err(Errno::ENOMEM));
            let mut endpoints = udp_endpoints([127, 0, 0, 1], 59001);
            assert_eq!(endpoints.next().map(|endpoint| (endpoint.pid, endpoint.sock_idx)), Some((PARENT, 1)));
            assert_eq!(endpoints.next(), None);
            assert_eq!(udp_endpoints([127, 0, 0, 1], 59002).next(), None);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
        }
        prepare_inet_binding_owners(PARENT, CHILD, 1).unwrap();
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            publish_inet_binding_owners(PARENT, CHILD, 1);
            assert_eq!(udp_endpoints([127, 0, 0, 1], 59001).count(), 2);
        }
        udp_cleanup_process(PARENT);
        udp_cleanup_process(CHILD);
    }

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
    fn inherited_socket_roots_drop_non_root_peers_and_clear_dangling_edges() {
        let mut table = SocketTable::new();
        let root = table.alloc(SocketInfo::new(SocketDomain::Unix, SocketType::Stream, 0));
        let peer = table.alloc(SocketInfo::new(SocketDomain::Unix, SocketType::Stream, 0));
        let retry_only = table.alloc(SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 0));
        table.get_mut(root).unwrap().peer_idx = Some(peer);
        table.get_mut(peer).unwrap().peer_idx = Some(root);

        table.retain_inherited_roots(&[root]).unwrap();
        assert!(table.get(root).is_some());
        assert_eq!(table.get(root).unwrap().peer_idx, None);
        assert!(table.get(peer).is_none());
        assert!(table.get(retry_only).is_none());
    }

    #[test]
    fn inherited_socket_roots_clear_a_dangling_peer() {
        let mut table = SocketTable::new();
        let root = table.alloc(SocketInfo::new(SocketDomain::Unix, SocketType::Stream, 0));
        table.get_mut(root).unwrap().peer_idx = Some(9);

        assert_eq!(table.retain_inherited_roots(&[root]), Ok(()));
        assert!(table.get(root).is_some());
        assert_eq!(table.get(root).unwrap().peer_idx, None);
    }

    #[test]
    fn inherited_socket_roots_reject_an_invalid_root_without_partial_filtering() {
        let mut table = SocketTable::new();
        let left = table.alloc(SocketInfo::new(SocketDomain::Unix, SocketType::Dgram, 0));
        let right = table.alloc(SocketInfo::new(SocketDomain::Unix, SocketType::Dgram, 0));
        table.get_mut(left).unwrap().peer_idx = Some(right);

        assert_eq!(
            table.retain_inherited_roots(&[left, 99]),
            Err(Errno::EBADF)
        );
        assert_eq!(table.get(left).unwrap().peer_idx, Some(right));
        assert!(table.get(right).is_some());
    }

    #[test]
    fn inherited_socket_roots_preserve_edges_between_two_owning_roots() {
        let mut table = SocketTable::new();
        let left = table.alloc(SocketInfo::new(SocketDomain::Unix, SocketType::Dgram, 0));
        let right = table.alloc(SocketInfo::new(SocketDomain::Unix, SocketType::Dgram, 0));
        let unrelated = table.alloc(SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 0));
        table.get_mut(left).unwrap().peer_idx = Some(right);
        table.get_mut(right).unwrap().peer_idx = Some(left);

        table.retain_inherited_roots(&[left, right]).unwrap();

        assert_eq!(table.get(left).unwrap().peer_idx, Some(right));
        assert_eq!(table.get(right).unwrap().peer_idx, Some(left));
        assert!(table.get(unrelated).is_none());
    }

    #[test]
    fn socket_ofd_handle_decoding_is_checked() {
        assert_eq!(SocketTable::index_from_ofd_handle(-1), Ok(0));
        assert_eq!(SocketTable::index_from_ofd_handle(-2), Ok(1));
        assert_eq!(
            SocketTable::index_from_ofd_handle(0),
            Err(Errno::EBADF)
        );
        assert_eq!(
            SocketTable::index_from_ofd_handle(i64::MAX),
            Err(Errno::EBADF)
        );
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
        tcp_register(PARENT, DUAL_STACK_TCP_IDX, [0, 0, 0, 0], TCP_PORT).unwrap();

        inherit_inet_binding_owners(PARENT, CHILD, UDP4_IDX);
        inherit_inet_binding_owners(PARENT, CHILD, UDP6_IDX);
        inherit_inet_binding_owners(PARENT, CHILD, DUAL_STACK_TCP_IDX);

        let udp4_targets = udp_lookup([127, 0, 0, 1], UDP4_PORT);
        assert!(
            udp4_targets
                .iter()
                .any(|target| target.pid == PARENT && target.sock_idx == UDP4_IDX)
        );
        assert!(
            udp4_targets
                .iter()
                .any(|target| target.pid == CHILD && target.sock_idx == UDP4_IDX)
        );
        let udp6_targets = udp6_lookup(LOOPBACK6, UDP6_PORT);
        assert!(
            udp6_targets
                .iter()
                .any(|target| target.pid == PARENT && target.sock_idx == UDP6_IDX)
        );
        assert!(
            udp6_targets
                .iter()
                .any(|target| target.pid == CHILD && target.sock_idx == UDP6_IDX)
        );

        // Parent close removes only the parent's process-local identity.
        udp_unregister(PARENT, UDP4_IDX);
        udp6_unregister(PARENT, UDP6_IDX);
        tcp_unregister(PARENT, DUAL_STACK_TCP_IDX);
        tcp6_unregister(PARENT, DUAL_STACK_TCP_IDX);

        let udp4_targets = udp_lookup([127, 0, 0, 1], UDP4_PORT);
        assert_eq!(udp4_targets.len(), 1);
        assert_eq!(
            (udp4_targets[0].pid, udp4_targets[0].sock_idx),
            (CHILD, UDP4_IDX)
        );
        let udp6_targets = udp6_lookup(LOOPBACK6, UDP6_PORT);
        assert_eq!(udp6_targets.len(), 1);
        assert_eq!(
            (udp6_targets[0].pid, udp6_targets[0].sock_idx),
            (CHILD, UDP6_IDX)
        );
        assert!(!udp_can_bind(
            CONTENDER,
            1,
            [127, 0, 0, 1],
            UDP4_PORT,
            false
        ));
        assert!(!udp6_can_bind(CONTENDER, 2, LOOPBACK6, UDP6_PORT, false));
        assert!(!tcp_can_bind(CONTENDER, 3, [0, 0, 0, 0], TCP_PORT));
        assert!(!tcp6_can_bind(CONTENDER, 3, [0; 16], TCP_PORT));

        // Final close drops each logical reservation.
        udp_unregister(CHILD, UDP4_IDX);
        udp6_unregister(CHILD, UDP6_IDX);
        tcp_unregister(CHILD, DUAL_STACK_TCP_IDX);
        tcp6_unregister(CHILD, DUAL_STACK_TCP_IDX);
        assert!(udp_lookup([127, 0, 0, 1], UDP4_PORT).is_empty());
        assert!(udp6_lookup(LOOPBACK6, UDP6_PORT).is_empty());
        assert!(udp_can_bind(CONTENDER, 1, [127, 0, 0, 1], UDP4_PORT, false));
        assert!(udp6_can_bind(CONTENDER, 2, LOOPBACK6, UDP6_PORT, false));
        assert!(tcp_can_bind(CONTENDER, 3, [0, 0, 0, 0], TCP_PORT));
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
        assert!(
            targets
                .iter()
                .any(|target| target.pid == CHILD && target.sock_idx == FIRST_IDX)
        );
        assert!(
            !targets
                .iter()
                .any(|target| target.pid == CHILD && target.sock_idx == SECOND_IDX)
        );

        udp_unregister(PARENT, FIRST_IDX);
        udp_unregister(CHILD, FIRST_IDX);
        let targets = udp_lookup([127, 0, 0, 1], PORT);
        assert_eq!(targets.len(), 1);
        assert_eq!((targets[0].pid, targets[0].sock_idx), (PARENT, SECOND_IDX));

        udp_unregister(PARENT, SECOND_IDX);
    }
}
