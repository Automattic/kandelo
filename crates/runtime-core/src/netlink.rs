//! `AF_NETLINK` sockets of the `NETLINK_KOBJECT_UEVENT` protocol.
//!
//! libudev's device monitor listens on this protocol for hotplug uevents.
//! Kandelo's devices are fixed at boot, so the kernel emits no uevent: a
//! monitor binds and polls as on Linux, and never becomes readable.
//! Sending a uevent from userspace is not supported.

use wasm_posix_shared::socket::AF_NETLINK;
use wasm_posix_shared::Errno;

pub const NETLINK_KOBJECT_UEVENT: u32 = 15;

/// `struct sockaddr_nl`: family (2), pad (2), port id (4), groups (4).
const SOCKADDR_NL_LEN: usize = 12;

/// Parse a `sockaddr_nl` into (port id, groups), as `netlink_bind`
/// validates it.
pub fn parse_sockaddr(addr: &[u8]) -> Result<(u32, u32), Errno> {
    if addr.len() < SOCKADDR_NL_LEN {
        return Err(Errno::EINVAL);
    }
    if u16::from_le_bytes([addr[0], addr[1]]) as u32 != AF_NETLINK {
        return Err(Errno::EINVAL);
    }
    let port = u32::from_le_bytes(addr[4..8].try_into().unwrap());
    let groups = u32::from_le_bytes(addr[8..12].try_into().unwrap());
    Ok((port, groups))
}

/// Write a `sockaddr_nl` truncated to `buf`, returning its full length.
pub fn write_sockaddr(buf: &mut [u8], port: u32, groups: u32) -> usize {
    let mut addr = [0u8; SOCKADDR_NL_LEN];
    addr[0..2].copy_from_slice(&(AF_NETLINK as u16).to_le_bytes());
    addr[4..8].copy_from_slice(&port.to_le_bytes());
    addr[8..12].copy_from_slice(&groups.to_le_bytes());
    let n = buf.len().min(SOCKADDR_NL_LEN);
    buf[..n].copy_from_slice(&addr[..n]);
    SOCKADDR_NL_LEN
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sockaddr_round_trips() {
        let mut buf = [0u8; 16];
        assert_eq!(write_sockaddr(&mut buf, 100, 4), SOCKADDR_NL_LEN);
        assert_eq!(parse_sockaddr(&buf), Ok((100, 4)));
    }

    #[test]
    fn sockaddr_rejects_a_short_or_foreign_address() {
        assert_eq!(parse_sockaddr(&[16, 0, 0, 0]), Err(Errno::EINVAL));
        let mut inet = [0u8; SOCKADDR_NL_LEN];
        inet[0] = 2;
        assert_eq!(parse_sockaddr(&inet), Err(Errno::EINVAL));
    }
}
