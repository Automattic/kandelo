import { describe, expect, it } from "vitest";
import { LocalVirtualNetwork } from "../src/networking/virtual-network";
import type { TcpConnectionPeer } from "../src/types";

describe("transport readiness notification history", () => {
  it("records arrivals while readable and a drain/refill between observations", () => {
    const fabric = new LocalVirtualNetwork({ network: [10, 88, 0, 0], prefixLength: 24 });
    const server = fabric.attachMachine({ id: "server", address: [10, 88, 0, 2] });
    const client = fabric.attachMachine({ id: "client", address: [10, 88, 0, 3] });
    let peer: TcpConnectionPeer | undefined;
    expect(server.listenTcp!("listener", new Uint8Array([10, 88, 0, 2]), 8080, {
      accept(value) { peer = value; return 0; },
    })).toBe(0);
    client.connect(7, new Uint8Array([10, 88, 0, 2]), 8080);
    const writeClock = client.readinessGeneration!(7, 1);
    peer!.send(new Uint8Array([1]), 0);
    const ready = client.readiness(7), first = client.readinessGeneration!(7, 0);
    peer!.send(new Uint8Array([2]), 0);
    expect(client.readiness(7)).toBe(ready);
    expect(client.readinessGeneration!(7, 0)).toBeGreaterThan(first);
    const second = client.readinessGeneration!(7, 0);
    client.recv(7, 2, 0);
    peer!.send(new Uint8Array([3]), 0);
    expect(client.readiness(7)).toBe(ready);
    expect(client.readinessGeneration!(7, 0)).toBeGreaterThan(second);
    expect(client.readinessGeneration!(7, 1)).toBe(writeClock);
    const third = client.readinessGeneration!(7, 0);
    peer!.shutdown(1);
    expect(client.readinessGeneration!(7, 0)).toBeGreaterThan(third);
    client.close(7); server.closeTcpListener!("listener");
  });
});
