/**
 * The link a machine's internet egress presents to the guest.
 *
 * The host reaches the internet for the guest (real host sockets on Node,
 * fetch on the browser), so to the guest it is a NAT gateway on a link of
 * its own, the shape QEMU's user-mode networking gives a guest: the guest is
 * 10.0.2.15/24 and every off-link destination is behind the host. The guest
 * never sees the host's real addresses.
 *
 * That gateway carries TCP only. A UDP datagram for anywhere beyond this
 * machine fails with EHOSTUNREACH, POSIX's "the destination host cannot be
 * reached (... a remote router cannot reach it)": there is a route, and the
 * router on it cannot deliver UDP. It is not dropped silently, and it is not
 * ENETUNREACH, which would deny the route TCP uses.
 */
import type { NetworkAddress, UdpReceiveTarget } from "../types";

export const EGRESS_ADDRESS = Object.freeze([10, 0, 2, 15]);
export const EGRESS_NETMASK = Object.freeze([255, 255, 255, 0]);
export const EHOSTUNREACH = 113;
const EADDRNOTAVAIL = 99;

const egressAddress = () => new Uint8Array(EGRESS_ADDRESS);
const isAny = (addr: Uint8Array) => addr.length === 4 && addr.every((part) => part === 0);
const isEgress = (addr: Uint8Array) => addr.length === 4 && addr.every((part, i) => part === EGRESS_ADDRESS[i]);

/**
 * The NetworkIO members every egress backend shares: its interface
 * configuration, UDP source selection, UDP binding, and UDP refusal.
 */
export class EgressLink {
  private readonly streamPorts = new Map<number, number>();
  private nextStreamPort = 49152;

  get localAddress(): Uint8Array { return egressAddress(); }
  get localNetmask(): Uint8Array { return new Uint8Array(EGRESS_NETMASK); }

  udpSourceAddress(_destination: Uint8Array): Uint8Array { return egressAddress(); }

  /** A socket may bind this machine's address; nothing ever arrives on it. */
  bindUdp(_id: string, addr: Uint8Array, _port: number, _target: UdpReceiveTarget): number {
    return isAny(addr) || isEgress(addr) ? 0 : EADDRNOTAVAIL;
  }
  unbindUdp(_id: string): void {}

  sendDatagram(): number { return EHOSTUNREACH; }

  /**
   * Start a stream's NAT bookkeeping: it begins from this machine's address
   * (or any), on the port the socket bound or a fresh ephemeral one.
   * Backends whose host side has no ports of its own (fetch) use this.
   */
  openStream(handle: number, source: NetworkAddress | undefined): void {
    if (source && !isAny(source.addr) && !isEgress(source.addr)) {
      throw Object.assign(new Error("EADDRNOTAVAIL"), { errno: EADDRNOTAVAIL });
    }
    let port = source?.port || 0;
    if (!port) {
      const used = new Set(this.streamPorts.values());
      for (let tries = 0; tries < 16384 && !port; tries++) {
        const candidate = this.nextStreamPort;
        this.nextStreamPort = candidate === 65535 ? 49152 : candidate + 1;
        if (!used.has(candidate)) port = candidate;
      }
      if (!port) throw Object.assign(new Error("EADDRNOTAVAIL"), { errno: EADDRNOTAVAIL });
    }
    this.streamPorts.set(handle, port);
  }

  /** getsockname for a stream: this machine's address and its port. */
  streamEndpoint(handle: number): NetworkAddress {
    const port = this.streamPorts.get(handle);
    if (port === undefined) throw Object.assign(new Error("ENOTCONN"), { errno: 107 });
    return { addr: egressAddress(), port };
  }

  closeStream(handle: number): void { this.streamPorts.delete(handle); }

  /** Whether a stream may start from `source`: this machine's address or any. */
  ownsSource(source: NetworkAddress | undefined): boolean {
    return !source || isAny(source.addr) || isEgress(source.addr);
  }
}

/**
 * Made-up addresses for names the browser reaches only through fetch. They
 * come from 198.18.0.0/15, the range reserved for benchmarking networks and
 * conventional for this kind of fake-address DNS: it is never routed on the
 * internet, and it cannot overlap a session's 10.89.0.0/24 or a virtual
 * link's subnet. Addresses are handed out in order, so two names never share
 * one and a connection always reaches the name the program asked for.
 */
export class SyntheticHostAddresses {
  private readonly byName = new Map<string, string>();
  private readonly byAddress = new Map<string, string>();
  private next = 1;

  resolve(hostname: string): Uint8Array {
    let key = this.byName.get(hostname);
    if (!key) {
      // 198.18.0.0/15 has 131,072 addresses; the first and last stay unused.
      if (this.next >= 0x1ffff) throw Object.assign(new Error("synthetic address space exhausted"), { errno: 11 });
      const offset = this.next++;
      key = `198.${18 + (offset >> 16)}.${(offset >> 8) & 0xff}.${offset & 0xff}`;
      this.byName.set(hostname, key);
      this.byAddress.set(key, hostname);
    }
    return new Uint8Array(key.split(".").map(Number));
  }

  hostname(addr: Uint8Array): string | undefined {
    return this.byAddress.get(Array.from(addr).join("."));
  }
}
