extern crate alloc;

use alloc::vec::Vec;

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

/// Per-socket kernel state.
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
        }
    }
}

/// Table of socket state, indexed by socket slot.
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
