/**
 * The internet egress link with nothing behind its gateway.
 *
 * The guest gets the same link every egress backend presents (eth0 at
 * 10.0.2.15/24 behind a NAT gateway, egress-link.ts), but the gateway
 * forwards nothing: a TCP connection beyond the machine fails with
 * EHOSTUNREACH, the answer the link already gives a UDP datagram, and only
 * numeric host names resolve. Loopback traffic never reaches a backend; the
 * kernel carries it.
 *
 * Why it exists: the browser host always boots a machine with this link, and
 * the Node host boots one only when an embedder asks for real host sockets
 * (TcpNetworkBackend). A conformance run on Node that must observe the same
 * machine as the browser, without reaching the host's network, boots this.
 */
import type { NetworkAddress, NetworkIO, UdpReceiveTarget } from "../types";
import { EgressLink, EHOSTUNREACH } from "./egress-link";
import { parseNumericIpv4Hostname } from "./hostname";

const ENOENT = 2;
const ENOTCONN = 107;

export class OfflineEgressBackend implements NetworkIO {
  private readonly egress = new EgressLink();

  get localAddress(): Uint8Array { return this.egress.localAddress; }
  get localNetmask(): Uint8Array { return this.egress.localNetmask; }
  udpSourceAddress(destination: Uint8Array): Uint8Array { return this.egress.udpSourceAddress(destination); }
  bindUdp(id: string, addr: Uint8Array, port: number, target: UdpReceiveTarget): number {
    return this.egress.bindUdp(id, addr, port, target);
  }
  unbindUdp(id: string): void { this.egress.unbindUdp(id); }
  sendDatagram(): number { return this.egress.sendDatagram(); }

  connect(_handle: number, _addr: Uint8Array, _port: number, _source?: NetworkAddress): void {
    throw Object.assign(new Error("EHOSTUNREACH"), { errno: EHOSTUNREACH });
  }
  connectStatus(_handle: number): number { return EHOSTUNREACH; }
  send(): number { throw Object.assign(new Error("ENOTCONN"), { errno: ENOTCONN }); }
  recv(): Uint8Array { throw Object.assign(new Error("ENOTCONN"), { errno: ENOTCONN }); }
  close(_handle: number): void {}

  getaddrinfo(hostname: string): Uint8Array {
    const literal = parseNumericIpv4Hostname(hostname);
    if (literal) return literal;
    // No resolver is reachable: the same answer as a machine with no network.
    throw Object.assign(new Error("ENOENT"), { errno: ENOENT });
  }
}
