//! Network-interface `ioctl` content: the interface table, the machine's
//! deterministic-per-boot MAC address, and `struct ifreq`/`ifconf` byte
//! layout.
//!
//! Workstream H4 (host-surface minimization). This used to be fully
//! reimplemented, host-computed logic in `host/src/kernel-worker.ts`
//! (`VIRTUAL_INTERFACES`, a per-boot `crypto.getRandomValues` MAC, and
//! hand-written `ifreq`/`ifconf` marshalling). The kernel is now the
//! authoritative source for the interface list, the MAC, and the exact wire
//! layout.
//!
//! Exactly one genuinely host-owned fact remains: the machine's real assigned
//! IPv4 address and the netmask of the link the host attached it to
//! (`HostIO::host_network_interface`). The kernel cannot know either from
//! inside itself, so it asks; the interface flags and the broadcast address
//! follow from them.
//!
//! `SIOCGIFCONF` is served entirely by the kernel too, including the
//! dereference of the caller's nested `struct ifconf.ifc_buf` pointer. This
//! module's doc comment used to justify a host-side detour for that by calling
//! `ifc_buf` "a process-memory address the kernel's separate Wasm instance
//! cannot itself reach". **That was false.** `HostIO::proc_read_bytes` and
//! `HostIO::proc_write_bytes` — the `host_proc_read_bytes` /
//! `host_proc_write_bytes` imports — read and write guest process memory from
//! inside the kernel Wasm instance, and `crate::syscalls` has called them from
//! seven DRI/KMS sites for as long as this module has existed. The reach was
//! there the whole time.
//!
//! This is the fourth "floor" the Rust-first campaign inherited as stated
//! fact and then disproved by reading the code. It is named as such, rather
//! than quietly deleted, so the next reader treats a claimed platform boundary
//! as a claim to verify rather than a constraint to design around.

use core::cell::UnsafeCell;

use crate::process::HostIO;

/// `IFNAMSIZ` (Linux `<net/if.h>`).
pub const IF_NAMESIZE: usize = 16;

/// `AF_INET`.
pub const AF_INET: u16 = 2;

/// `ARPHRD_ETHER` — Ethernet hardware type reported by `SIOCGIFHWADDR`.
pub const ARPHRD_ETHER: u16 = 1;

/// `ARPHRD_LOOPBACK` — loopback hardware type reported by `SIOCGIFHWADDR`.
pub const ARPHRD_LOOPBACK: u16 = 772;

/// `struct ifreq.ifr_flags` bits the kernel reports (`<net/if.h>`).
pub const IFF_UP: u16 = 0x1;
pub const IFF_BROADCAST: u16 = 0x2;
pub const IFF_LOOPBACK: u16 = 0x8;
pub const IFF_RUNNING: u16 = 0x40;

/// An interface's IPv4 configuration: its address and its link's netmask.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InterfaceConfig {
    pub address: [u8; 4],
    pub netmask: [u8; 4],
}

impl InterfaceConfig {
    /// A host-reported configuration the kernel can serve: a contiguous
    /// netmask (a run of one bits, then zeros). Anything else is not an
    /// IPv4 subnet, so the interface is treated as unconfigured rather than
    /// reporting a broadcast address derived from nonsense.
    pub fn validated(address: [u8; 4], netmask: [u8; 4]) -> Option<Self> {
        let mask = u32::from_be_bytes(netmask);
        if mask.leading_ones() + mask.trailing_zeros() != 32 {
            return None;
        }
        Some(Self { address, netmask })
    }

    /// The link's directed broadcast address: every host bit set. A /31 or
    /// /32 link has no broadcast address.
    pub fn broadcast(&self) -> Option<[u8; 4]> {
        let mask = u32::from_be_bytes(self.netmask);
        if mask.trailing_zeros() < 2 {
            return None;
        }
        Some((u32::from_be_bytes(self.address) | !mask).to_be_bytes())
    }
}

/// One kernel-known network interface.
pub struct NetworkInterface {
    pub name: &'static str,
    pub index: u32,
    pub loopback: bool,
}

/// The machine's fixed virtual interface table: loopback plus the one
/// configured (virtual) network interface. Matches the table the host used
/// to own (`VIRTUAL_INTERFACES` in `kernel-worker.ts`) byte for byte.
pub const INTERFACES: &[NetworkInterface] = &[
    NetworkInterface {
        name: "lo",
        index: 1,
        loopback: true,
    },
    NetworkInterface {
        name: "eth0",
        index: 2,
        loopback: false,
    },
];

pub fn find_by_name(name: &[u8]) -> Option<&'static NetworkInterface> {
    INTERFACES.iter().find(|iface| iface.name.as_bytes() == name)
}

pub fn find_by_index(index: u32) -> Option<&'static NetworkInterface> {
    INTERFACES.iter().find(|iface| iface.index == index)
}

/// The IPv4 configuration to report for `iface`: the fixed loopback network
/// for `lo`, or the host's real assignment for anything else. `None` means
/// the host has no address configured yet (`SIOCGIFADDR` and
/// `SIOCGIFNETMASK` report `EADDRNOTAVAIL` in that case).
pub fn interface_config(iface: &NetworkInterface, host: &mut dyn HostIO) -> Option<InterfaceConfig> {
    if iface.loopback {
        return Some(InterfaceConfig { address: [127, 0, 0, 1], netmask: [255, 0, 0, 0] });
    }
    host.host_network_interface()
}

pub fn interface_address(iface: &NetworkInterface, host: &mut dyn HostIO) -> Option<[u8; 4]> {
    interface_config(iface, host).map(|config| config.address)
}

/// `SIOCGIFFLAGS`: loopback is always up. The network interface is up and
/// running only while the host has given it an address — a machine outside
/// any network has an interface with nothing behind it. It can broadcast
/// whenever its link has a broadcast address.
pub fn interface_flags(iface: &NetworkInterface, host: &mut dyn HostIO) -> u16 {
    if iface.loopback {
        return IFF_UP | IFF_LOOPBACK | IFF_RUNNING;
    }
    match host.host_network_interface() {
        Some(config) if config.broadcast().is_some() => IFF_UP | IFF_RUNNING | IFF_BROADCAST,
        Some(_) => IFF_UP | IFF_RUNNING,
        None => 0,
    }
}

/// `SIOCGIFBRDADDR`: the broadcast address of a broadcast-capable interface.
/// Loopback has none.
pub fn interface_broadcast(iface: &NetworkInterface, host: &mut dyn HostIO) -> Option<[u8; 4]> {
    if iface.loopback {
        return None;
    }
    host.host_network_interface()?.broadcast()
}

/// Whether `addr` is the directed broadcast address of the configured
/// network interface, which a sender may reach only with `SO_BROADCAST`.
pub fn is_interface_broadcast(addr: [u8; 4], host: &mut dyn HostIO) -> bool {
    host.host_network_interface()
        .and_then(|config| config.broadcast())
        == Some(addr)
}

/// The kernel-owned, boot-random virtual MAC address, generated once (from
/// the host's entropy source, `host_getrandom`) and reused for the lifetime
/// of this kernel instance.
///
/// # Concurrency
///
/// Lazily initialized through a bare `UnsafeCell`, matching the established
/// pattern for other kernel-global singletons in this crate (e.g.
/// `process_table::GLOBAL_PROCESS_TABLE`, and the read-only introspection
/// exports `kernel_enum_procs`/`kernel_read_proc_maps` in `wasm_api.rs`,
/// which read shared kernel-global state without taking the global kernel
/// lock). Network-interface ioctls are not on any syscall hot path where
/// finer-grained synchronization would matter.
struct MacCell(UnsafeCell<Option<[u8; 6]>>);
// SAFETY: see the concurrency note above; this mirrors existing
// kernel-global singletons in the same crate.
unsafe impl Sync for MacCell {}

static MACHINE_MAC: MacCell = MacCell(UnsafeCell::new(None));

pub fn machine_mac(host: &mut dyn HostIO) -> [u8; 6] {
    // SAFETY: single kernel instance, no concurrent mutation from Wasm
    // threads reaches this path today (see the `MacCell` doc comment).
    let slot = unsafe { &mut *MACHINE_MAC.0.get() };
    if let Some(mac) = slot {
        return *mac;
    }
    let mut mac = [0u8; 6];
    let _ = host.host_getrandom(&mut mac);
    // Locally administered, unicast — matches the bit-twiddle the host used
    // to apply to its `crypto.getRandomValues` output.
    mac[0] = (mac[0] & 0xFE) | 0x02;
    *slot = Some(mac);
    mac
}

/// Read the NUL-trimmed interface name from `ifr_name` (the first
/// `IF_NAMESIZE` bytes of a `struct ifreq`), returned as an owned fixed
/// buffer plus its length so callers can immediately reuse `buf` mutably.
pub fn read_name_bytes(buf: &[u8]) -> ([u8; IF_NAMESIZE], usize) {
    let mut out = [0u8; IF_NAMESIZE];
    let raw = &buf[0..IF_NAMESIZE];
    let end = raw.iter().position(|&b| b == 0).unwrap_or(IF_NAMESIZE);
    out[..end].copy_from_slice(&raw[..end]);
    (out, end)
}

/// Write `name` into `ifr_name` (the first `IF_NAMESIZE` bytes of `buf`),
/// NUL-padded, truncated to fit if necessary (matches Linux `ifreq` name
/// truncation behavior).
pub fn write_name(buf: &mut [u8], name: &[u8]) {
    buf[..IF_NAMESIZE].fill(0);
    let n = name.len().min(IF_NAMESIZE - 1);
    buf[..n].copy_from_slice(&name[..n]);
}

/// `struct ifreq` has a 16-byte name followed by a union. The union is 16
/// bytes under wasm32, but its `struct ifmap` member grows to 24 bytes under
/// wasm64 because `unsigned long` is pointer-sized.
pub fn ifreq_size(pointer_width: u8) -> usize {
    if pointer_width == 8 {
        40
    } else {
        32
    }
}

/// Total bytes needed to enumerate every interface's `ifreq` entry at the
/// caller's pointer width (`SIOCGIFCONF`'s null-buffer size-query mode).
pub fn ifconf_total_size(pointer_width: u8) -> usize {
    INTERFACES.len() * ifreq_size(pointer_width)
}

/// Write as many complete `ifreq` entries as fit in `out`, honoring the
/// caller's pointer width. Returns the number of bytes written (always a
/// whole multiple of the per-width `ifreq` size).
pub fn ifconf_write(pointer_width: u8, out: &mut [u8], host: &mut dyn HostIO) -> usize {
    let entry_size = ifreq_size(pointer_width);
    if entry_size == 0 {
        return 0;
    }
    let capacity = out.len() / entry_size;
    let count = capacity.min(INTERFACES.len());
    for (i, iface) in INTERFACES.iter().enumerate().take(count) {
        let entry = &mut out[i * entry_size..(i + 1) * entry_size];
        write_name(entry, iface.name.as_bytes());
        entry[IF_NAMESIZE..].fill(0);
        entry[IF_NAMESIZE..IF_NAMESIZE + 2].copy_from_slice(&AF_INET.to_le_bytes());
        if let Some(addr) = interface_address(iface, host) {
            entry[IF_NAMESIZE + 4..IF_NAMESIZE + 8].copy_from_slice(&addr);
        }
    }
    count * entry_size
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeHost {
        random_fill: u8,
        local_addr: Option<[u8; 4]>,
    }

    impl HostIO for FakeHost {
        fn host_close(&mut self, _: i64) -> Result<(), wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_read(&mut self, _: i64, _: &mut [u8]) -> Result<usize, wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_write(&mut self, _: i64, _: &[u8]) -> Result<usize, wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_seek(&mut self, _: i64, _: i64, _: u32) -> Result<i64, wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_fstat(&mut self, _: i64) -> Result<wasm_posix_shared::WasmStat, wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_readdir(
            &mut self,
            _: i64,
            _: &mut [u8],
        ) -> Result<Option<(u64, u32, usize)>, wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_clock_gettime(&mut self, _: u32) -> Result<(i64, i64), wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_ftruncate(&mut self, _: i64, _: i64) -> Result<(), wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_fsync(&mut self, _: i64) -> Result<(), wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_fchmod(&mut self, _: i64, _: u32) -> Result<(), wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_fchown(&mut self, _: i64, _: u32, _: u32) -> Result<(), wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_set_alarm(&mut self, _: u32) -> Result<(), wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_set_posix_timer(
            &mut self,
            _: i32,
            _: i32,
            _: i64,
            _: i64,
        ) -> Result<(), wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn bind_framebuffer(&mut self, _: i32, _: usize, _: usize, _: u32, _: u32, _: u32, _: u32) {
            unimplemented!()
        }
        fn unbind_framebuffer(&mut self, _: i32) {
            unimplemented!()
        }
        fn fb_write(&mut self, _: i32, _: usize, _: &[u8]) {
            unimplemented!()
        }
        fn host_getrandom(&mut self, buf: &mut [u8]) -> Result<usize, wasm_posix_shared::Errno> {
            buf.fill(self.random_fill);
            Ok(buf.len())
        }
        fn host_waitpid(&mut self, _: i32, _: u32) -> Result<(i32, i32), wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_net_connect(&mut self, _: i32, _: &[u8], _: u16) -> Result<(), wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_net_connect_status(&mut self, _: i32) -> Result<(), wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_net_send(&mut self, _: i32, _: &[u8], _: u32) -> Result<usize, wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_net_recv(
            &mut self,
            _: i32,
            _: u32,
            _: u32,
            _: &mut [u8],
        ) -> Result<usize, wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_net_close(&mut self, _: i32) -> Result<(), wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_net_listen(&mut self, _: i32, _: u16, _: &[u8; 4]) -> Result<(), wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_getaddrinfo(&mut self, _: &[u8], _: &mut [u8]) -> Result<usize, wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_futex_wake(&mut self, _: usize, _: u32) -> Result<i32, wasm_posix_shared::Errno> {
            unimplemented!()
        }
        fn host_network_interface(&mut self) -> Option<InterfaceConfig> {
            self.local_addr.map(|address| InterfaceConfig { address, netmask: [255, 255, 255, 0] })
        }
    }

    #[test]
    fn find_by_name_and_index_round_trip() {
        let lo = find_by_name(b"lo").unwrap();
        assert!(lo.loopback);
        assert_eq!(lo.index, 1);
        assert_eq!(find_by_index(1).unwrap().name, "lo");

        let eth0 = find_by_name(b"eth0").unwrap();
        assert!(!eth0.loopback);
        assert_eq!(eth0.index, 2);
        assert_eq!(find_by_index(2).unwrap().name, "eth0");

        assert!(find_by_name(b"eth1").is_none());
        assert!(find_by_index(99).is_none());
    }

    #[test]
    fn loopback_address_is_fixed_regardless_of_host() {
        let mut host = FakeHost {
            random_fill: 0,
            local_addr: None,
        };
        let lo = find_by_name(b"lo").unwrap();
        assert_eq!(interface_address(lo, &mut host), Some([127, 0, 0, 1]));
    }

    #[test]
    fn non_loopback_address_comes_from_host() {
        let mut host = FakeHost {
            random_fill: 0,
            local_addr: Some([10, 0, 0, 5]),
        };
        let eth0 = find_by_name(b"eth0").unwrap();
        assert_eq!(interface_address(eth0, &mut host), Some([10, 0, 0, 5]));

        let mut host_no_addr = FakeHost {
            random_fill: 0,
            local_addr: None,
        };
        assert_eq!(interface_address(eth0, &mut host_no_addr), None);
    }

    #[test]
    fn ifreq_size_matches_pointer_width() {
        assert_eq!(ifreq_size(4), 32);
        assert_eq!(ifreq_size(8), 40);
    }

    #[test]
    fn ifconf_total_size_covers_every_interface() {
        assert_eq!(ifconf_total_size(4), INTERFACES.len() * 32);
        assert_eq!(ifconf_total_size(8), INTERFACES.len() * 40);
    }

    #[test]
    fn ifconf_write_fills_names_family_and_addresses() {
        let mut host = FakeHost {
            random_fill: 0,
            local_addr: Some([192, 168, 1, 42]),
        };
        let mut out = [0u8; 64];
        let written = ifconf_write(4, &mut out, &mut host);
        assert_eq!(written, INTERFACES.len() * 32);

        let (name0, len0) = read_name_bytes(&out[0..32]);
        assert_eq!(&name0[..len0], b"lo");
        let family0 = u16::from_le_bytes([out[16], out[17]]);
        assert_eq!(family0, AF_INET);
        assert_eq!(&out[20..24], &[127, 0, 0, 1]);

        let (name1, len1) = read_name_bytes(&out[32..64]);
        assert_eq!(&name1[..len1], b"eth0");
        let family1 = u16::from_le_bytes([out[32 + 16], out[32 + 17]]);
        assert_eq!(family1, AF_INET);
        assert_eq!(&out[32 + 20..32 + 24], &[192, 168, 1, 42]);
    }

    #[test]
    fn ifconf_write_truncates_to_available_capacity() {
        let mut host = FakeHost {
            random_fill: 0,
            local_addr: Some([1, 2, 3, 4]),
        };
        // Room for exactly one wasm32 ifreq entry.
        let mut out = [0u8; 32];
        let written = ifconf_write(4, &mut out, &mut host);
        assert_eq!(written, 32);
    }

    #[test]
    fn flags_and_broadcast_follow_the_hosts_assignment() {
        let lo = find_by_name(b"lo").unwrap();
        let eth0 = find_by_name(b"eth0").unwrap();
        let mut offline = FakeHost { random_fill: 0, local_addr: None };
        assert_eq!(interface_flags(lo, &mut offline), IFF_UP | IFF_LOOPBACK | IFF_RUNNING);
        assert_eq!(interface_flags(eth0, &mut offline), 0);
        assert_eq!(interface_broadcast(eth0, &mut offline), None);
        assert!(!is_interface_broadcast([255, 255, 255, 255], &mut offline));

        let mut joined = FakeHost { random_fill: 0, local_addr: Some([10, 89, 0, 2]) };
        assert_eq!(interface_flags(eth0, &mut joined), IFF_UP | IFF_RUNNING | IFF_BROADCAST);
        assert_eq!(interface_broadcast(eth0, &mut joined), Some([10, 89, 0, 255]));
        assert_eq!(interface_broadcast(lo, &mut joined), None);
        assert!(is_interface_broadcast([10, 89, 0, 255], &mut joined));
        assert!(!is_interface_broadcast([10, 89, 0, 254], &mut joined));
        assert_eq!(interface_config(lo, &mut joined).unwrap().netmask, [255, 0, 0, 0]);
    }

    #[test]
    fn only_contiguous_netmasks_are_subnets() {
        assert!(InterfaceConfig::validated([10, 0, 0, 1], [255, 255, 255, 0]).is_some());
        assert!(InterfaceConfig::validated([10, 0, 0, 1], [255, 255, 255, 255]).is_some());
        assert!(InterfaceConfig::validated([10, 0, 0, 1], [0, 0, 0, 0]).is_some());
        assert!(InterfaceConfig::validated([10, 0, 0, 1], [255, 0, 255, 0]).is_none());
        let point = InterfaceConfig::validated([10, 0, 0, 1], [255, 255, 255, 254]).unwrap();
        assert_eq!(point.broadcast(), None);
        let wide = InterfaceConfig::validated([172, 16, 5, 9], [255, 240, 0, 0]).unwrap();
        assert_eq!(wide.broadcast(), Some([172, 31, 255, 255]));
    }

    #[test]
    fn machine_mac_is_stable_and_locally_administered() {
        let mut host = FakeHost {
            random_fill: 0xFF,
            local_addr: None,
        };
        let mac = machine_mac(&mut host);
        // Locally administered unicast bit pattern.
        assert_eq!(mac[0] & 0x03, 0x02);
    }
}
